/**
 * WordJS Plugin: Invoices — ISOLATED, sandboxed.
 *
 * WordPress parity: Sliced Invoices / WP-Invoice. The admin builds invoices (client, line
 * items, tax %, discount); each invoice gets a public token URL rendered by the "Invoices"
 * Puck block as a print-friendly view. Statuses: draft/sent/paid/overdue/void ('overdue' is
 * also DERIVED virtually: a 'sent' invoice past its due date reports as overdue everywhere).
 *
 * Money rules: every amount is stored as INTEGER CENTS. Totals are ALWAYS recomputed
 * server-side from the line items on save — client-sent totals are never trusted.
 *
 * The public lookup uses a random 32-char token from the host CSPRNG (wordjs.crypto.randomToken),
 * NOT a Math.random loop; the in-memory failed-lookup throttle below is defense-in-depth, and a
 * CSPRNG (not a reconstructable PRNG) is what keeps one client's token non-derivable from others'.
 */

exports.metadata = {
    name: 'Invoices',
    version: '1.0.0',
    description: 'Invoice builder with public print-friendly token URLs, statuses and dashboard totals.',
    author: 'WordJS',
};

const OPT_CONFIG = 'invoices_config';

const CONFIG_DEFAULTS = {
    businessName: '',
    businessAddress: '',
    businessTaxId: '',
    businessEmail: '',
    currencySymbol: '$',
    footerNote: 'Gracias por su confianza.',
    invoicePageUrl: '', // the public page that contains the Invoices Puck block
};

const STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'];
const STATUS_LABELS_ES = { draft: 'Borrador', sent: 'Enviada', paid: 'Pagada', overdue: 'Vencida', void: 'Anulada' };

// Caps sized so integer-cent math NEVER loses precision: per line max = MAX_QTY * MAX_UNIT_CENTS
// = 1e14 cents, and a full 50-line invoice tops out at 5e15 < Number.MAX_SAFE_INTEGER (~9.007e15).
const MAX_ITEMS = 50;
const MAX_QTY = 100000;           // sanity cap on a single line quantity
const MAX_UNIT_CENTS = 1000000000; // sanity cap on a unit price (10M in major units)
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail, site } = wordjs;

    // Per-plugin table namespace enforced by the host. slug 'invoices' -> 'wjp_invoices_'.
    const P = db.tablePrefix;
    const T = { invoices: P + 'invoices' };

    // ---- schema (idempotent; full column set from day 1 — ALTER is unavailable) -----------------
    async function initSchema() {
        // `currency_symbol` carries NO `DEFAULT '$'`. The host SQL guard
        // (core/plugin-api.assertSqlAllowed) refuses '$' ANYWHERE in a plugin statement — dollar-quoting
        // and dollar-numbered parameters — so that clause made this db.run throw, initSchema() reject
        // and init() fail: the isolate reported init-error and the plugin registered nothing at all.
        // Every INSERT supplies currency_symbol, and every read already falls back to '$'.
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.invoices} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT NOT NULL,
            token TEXT NOT NULL,
            client_name TEXT NOT NULL,
            client_email TEXT,
            client_address TEXT,
            client_tax_id TEXT,
            items TEXT NOT NULL,
            tax_pct INTEGER DEFAULT 0,
            discount_cents INTEGER DEFAULT 0,
            subtotal_cents INTEGER,
            tax_cents INTEGER,
            total_cents INTEGER,
            currency_symbol TEXT,
            status TEXT DEFAULT 'draft',
            issued_at TEXT,
            due_at TEXT,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        try {
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_token ON ${T.invoices} (token)`);
        } catch (e) {
            // Index creation is best-effort (already exists / dialect quirk) — lookups still work.
        }
    }
    await initSchema();

    // ---- helpers ---------------------------------------------------------------------------------

    /**
     * SECURITY (audit HIGH): the public token is the ONLY gate on /public/view, which returns a
     * client's full financial PII (name, email, address, tax id, billed amounts). Math.random is V8
     * xorshift128+ whose internal state is reconstructable from a single observed 32-char token, so an
     * attacker with one legitimate invoice link can predict every other invoice's token and harvest
     * their PII — and the throttle only counts 404s, so correctly-predicted tokens are never limited.
     * The host CSPRNG is bridged as `wordjs.crypto.randomToken` (the "no crypto API" header note is
     * false); randomToken(16) = 32 hex chars, a subset of TOKEN_CHARS. Async (RPC to the host).
     */
    async function genToken() {
        return wordjs.crypto.randomToken(16);
    }

    const invoiceNumber = (id) => 'INV-' + String(id).padStart(4, '0');

    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const fmtMoney = (cents, symbol) => (symbol || '$') + ((Number(cents) || 0) / 100).toFixed(2);

    // Accept '' / null (→ null) or a parseable date string; throw on unparseable non-empty input.
    const normDate = (v, label) => {
        if (v === undefined || v === null || v === '') return null;
        const s = String(v).trim();
        if (!s) return null;
        if (isNaN(new Date(s).getTime())) throw new Error(`Fecha inválida (${label}).`);
        return s.slice(0, 40);
    };

    /** Validate and normalize the line items array: 1..50 rows, description + qty>0 + unit_cents>=0. */
    function cleanItems(raw) {
        if (!Array.isArray(raw) || raw.length < 1) throw new Error('La factura necesita al menos un concepto.');
        if (raw.length > MAX_ITEMS) throw new Error(`Máximo ${MAX_ITEMS} conceptos por factura.`);
        return raw.map((it, idx) => {
            const description = String((it && it.description) || '').trim();
            if (!description) throw new Error(`El concepto #${idx + 1} necesita una descripción.`);
            if (description.length > 300) throw new Error(`La descripción del concepto #${idx + 1} es demasiado larga (máx. 300).`);
            const qty = Number(it.qty);
            if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) throw new Error(`Cantidad inválida en el concepto #${idx + 1}.`);
            const unit = Number(it.unit_cents);
            if (!Number.isInteger(unit) || unit < 0 || unit > MAX_UNIT_CENTS) throw new Error(`Precio unitario inválido en el concepto #${idx + 1}.`);
            // Keep fractional quantities (e.g. 1.5 hours) but bound their precision, and validate
            // AFTER rounding so e.g. qty=0.0004 (>0 but rounds to 0) can't store a 0-quantity line.
            const roundedQty = Math.round(qty * 1000) / 1000;
            if (roundedQty <= 0) throw new Error(`Cantidad inválida en el concepto #${idx + 1}.`);
            return { description, qty: roundedQty, unit_cents: unit };
        });
    }

    /** Server-side totals — the ONLY source of truth. Discount is clamped to the subtotal. */
    function computeTotals(items, taxPct, discountCents) {
        let subtotal = 0;
        for (const it of items) subtotal += Math.round(it.qty * it.unit_cents);
        const discount = Math.min(Math.max(0, discountCents), subtotal);
        const taxable = subtotal - discount;
        const tax = Math.round(taxable * taxPct / 100);
        return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: taxable + tax };
    }

    /** A 'sent' invoice past the END of its due date reports as 'overdue' (virtual, not stored). */
    function effectiveStatus(row) {
        if (row.status === 'sent' && row.due_at) {
            const due = new Date(row.due_at).getTime();
            if (!isNaN(due) && due + 24 * 60 * 60 * 1000 - 1 < Date.now()) return 'overdue';
        }
        return row.status;
    }

    /** Parse the items JSON and attach the derived status. */
    function decorate(row) {
        let items = [];
        try { items = JSON.parse(row.items || '[]'); } catch (e) { items = []; }
        if (!Array.isArray(items)) items = [];
        return { ...row, items, effective_status: effectiveStatus(row) };
    }

    async function getConfig() {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        return { ...CONFIG_DEFAULTS, ...stored };
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // =================================== ADMIN ROUTES ===============================================

    // List + dashboard summary. ?status= filters on the DERIVED status; ?search= matches
    // number / client name / client email. Summary is computed over ALL invoices so the cards
    // stay stable while filtering.
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        try {
            const statusFilter = String((req.query && req.query.status) || '').trim();
            const search = String((req.query && req.query.search) || '').trim().toLowerCase();

            const rows = await db.all(`SELECT * FROM ${T.invoices} ORDER BY id DESC`);
            const all = rows.map(decorate);

            const summary = { paid_cents: 0, pending_cents: 0, overdue_cents: 0, count: all.length, count_draft: 0, count_sent: 0, count_paid: 0, count_overdue: 0, count_void: 0 };
            for (const inv of all) {
                const total = Number(inv.total_cents) || 0;
                if (inv.effective_status === 'paid') { summary.paid_cents += total; summary.count_paid++; }
                else if (inv.effective_status === 'sent') { summary.pending_cents += total; summary.count_sent++; }
                else if (inv.effective_status === 'overdue') { summary.pending_cents += total; summary.overdue_cents += total; summary.count_overdue++; }
                else if (inv.effective_status === 'void') summary.count_void++;
                else summary.count_draft++;
            }

            let list = all;
            if (search) {
                list = list.filter((i) =>
                    String(i.number || '').toLowerCase().includes(search)
                    || String(i.client_name || '').toLowerCase().includes(search)
                    || String(i.client_email || '').toLowerCase().includes(search));
            }
            if (statusFilter) list = list.filter((i) => i.effective_status === statusFilter);

            res.json({ invoices: list, summary });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create/update. Validates everything; totals are recomputed here; a NEW invoice gets its
    // number + token. The currency symbol is snapshotted from the config at save time.
    http.route('post', '/save', { auth: true, admin: true }, async (req, res) => {
        try {
            const b = req.body || {};
            const client_name = String(b.client_name || '').trim();
            if (!client_name) return res.status(400).json({ error: 'El nombre del cliente es obligatorio.' });
            if (client_name.length > 200) return res.status(400).json({ error: 'El nombre del cliente es demasiado largo (máx. 200).' });

            const client_email = String(b.client_email || '').trim().slice(0, 200);
            if (client_email && !EMAIL_RE.test(client_email)) return res.status(400).json({ error: 'El correo del cliente no es válido.' });
            const client_address = String(b.client_address || '').trim().slice(0, 500);
            const client_tax_id = String(b.client_tax_id || '').trim().slice(0, 100);
            const notes = String(b.notes || '').trim().slice(0, 2000);

            const items = cleanItems(b.items);

            let tax_pct = Math.round(Number(b.tax_pct));
            if (!Number.isFinite(tax_pct)) tax_pct = 0;
            tax_pct = Math.min(100, Math.max(0, tax_pct));

            let discount_cents = Math.round(Number(b.discount_cents));
            if (!Number.isFinite(discount_cents) || discount_cents < 0) discount_cents = 0;

            const issued_at = normDate(b.issued_at, 'emisión');
            const due_at = normDate(b.due_at, 'vencimiento');

            const totals = computeTotals(items, tax_pct, discount_cents);
            const cfg = await getConfig();
            const symbol = String(cfg.currencySymbol || '$').slice(0, 8);
            const itemsJson = JSON.stringify(items);

            const id = parseInt(b.id, 10);
            if (Number.isInteger(id) && id > 0) {
                // UPDATE — status/number/token are untouched here (status has its own route).
                const existing = await db.get(`SELECT id FROM ${T.invoices} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Factura no encontrada.' });
                await db.run(
                    `UPDATE ${T.invoices}
                     SET client_name = ?, client_email = ?, client_address = ?, client_tax_id = ?,
                         items = ?, tax_pct = ?, discount_cents = ?, subtotal_cents = ?, tax_cents = ?,
                         total_cents = ?, currency_symbol = ?, issued_at = ?, due_at = ?, notes = ?
                     WHERE id = ?`,
                    [client_name, client_email, client_address, client_tax_id,
                        itemsJson, tax_pct, totals.discount_cents, totals.subtotal_cents, totals.tax_cents,
                        totals.total_cents, symbol, issued_at, due_at, notes, id]
                );
                const saved = await db.get(`SELECT * FROM ${T.invoices} WHERE id = ?`, [id]);
                return res.json({ invoice: decorate(saved) });
            }

            // CREATE — insert first, then derive the number from the row's OWN id (== MAX(id)+1 at
            // insert time), which stays unique even if two admins create invoices concurrently.
            const token = await genToken();
            const result = await db.run(
                `INSERT INTO ${T.invoices}
                    (number, token, client_name, client_email, client_address, client_tax_id, items,
                     tax_pct, discount_cents, subtotal_cents, tax_cents, total_cents, currency_symbol,
                     status, issued_at, due_at, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
                ['', token, client_name, client_email, client_address, client_tax_id, itemsJson,
                    tax_pct, totals.discount_cents, totals.subtotal_cents, totals.tax_cents,
                    totals.total_cents, symbol, issued_at, due_at, notes]
            );
            const newId = result.lastID;
            await db.run(`UPDATE ${T.invoices} SET number = ? WHERE id = ?`, [invoiceNumber(newId), newId]);
            const saved = await db.get(`SELECT * FROM ${T.invoices} WHERE id = ?`, [newId]);
            res.json({ invoice: decorate(saved) });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Manual status change (draft/sent/paid/overdue/void).
    http.route('post', '/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Identificador inválido.' });
            const status = String(((req.body || {}).status) || '').trim();
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const result = await db.run(`UPDATE ${T.invoices} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || !result.changes) return res.status(404).json({ error: 'Factura no encontrada.' });
            res.json({ ok: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Email the client a link to the public invoice page. Needs client_email on the invoice AND
    // the invoicePageUrl config. Mail failure degrades gracefully: {sent:false, error} — the
    // invoice itself is untouched. Status moves draft→sent only when the mail actually went out.
    http.route('post', '/:id/send', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Identificador inválido.' });
            const inv = await db.get(`SELECT * FROM ${T.invoices} WHERE id = ?`, [id]);
            if (!inv) return res.status(404).json({ error: 'Factura no encontrada.' });
            if (!inv.client_email) return res.status(400).json({ sent: false, error: 'La factura no tiene correo del cliente.' });

            const cfg = await getConfig();
            let pageUrl = String(cfg.invoicePageUrl || '').trim();
            if (!pageUrl) return res.status(400).json({ sent: false, error: 'Configura primero la URL de la página pública de facturas (pestaña Configuración).' });

            // The config commonly holds a RELATIVE path (the settings UI suggests '/factura').
            // A mailed link must be absolute, so resolve it against the site origin here —
            // otherwise the email carries a dead href="/factura?inv=..." while still reporting
            // {sent:true}. site.url is a read-only bridge gated on settings:read.
            if (pageUrl.startsWith('/')) {
                let origin = '';
                try { origin = String((await site.url()) || '').trim(); } catch (e) { origin = ''; }
                if (!origin) {
                    return res.status(500).json({ sent: false, error: 'No se pudo determinar la URL pública del sitio; usa una URL absoluta (https://...) en la Configuración.' });
                }
                pageUrl = origin.replace(/\/+$/, '') + pageUrl;
            }

            const link = pageUrl + (pageUrl.includes('?') ? '&' : '?') + 'inv=' + inv.token;
            const bizName = String(cfg.businessName || '').trim();
            const totalTxt = fmtMoney(inv.total_cents, inv.currency_symbol);
            const subject = `Factura ${inv.number}` + (bizName ? ` — ${bizName}` : '');
            const safeLink = escapeHtml(link);
            const html = [
                '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">',
                bizName ? `<h2 style="margin:0 0 16px">${escapeHtml(bizName)}</h2>` : '',
                `<p>Hola ${escapeHtml(inv.client_name)},</p>`,
                '<p>Tienes una factura disponible para consultar e imprimir.</p>',
                '<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">',
                `<tr><td style="padding:6px 0;color:#6b7280">Número</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(inv.number)}</td></tr>`,
                inv.due_at ? `<tr><td style="padding:6px 0;color:#6b7280">Vence</td><td style="padding:6px 0;text-align:right">${escapeHtml(inv.due_at)}</td></tr>` : '',
                `<tr><td style="padding:6px 0;color:#6b7280">Total</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(totalTxt)}</td></tr>`,
                '</table>',
                `<p style="text-align:center;margin:28px 0"><a href="${safeLink}" style="background:#111827;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Ver factura</a></p>`,
                `<p style="font-size:12px;color:#6b7280">Si el botón no funciona, copia este enlace en tu navegador:<br>${safeLink}</p>`,
                '</div>',
            ].join('');
            const text = `Hola ${inv.client_name},\n\nTienes una factura disponible.\n\nNúmero: ${inv.number}\nTotal: ${totalTxt}\n${inv.due_at ? 'Vence: ' + inv.due_at + '\n' : ''}\nVer factura: ${link}\n`;

            try {
                await mail({ to: inv.client_email, subject, html, text });
            } catch (e) {
                return res.json({ sent: false, error: 'No se pudo enviar el correo: ' + (e.message || e) });
            }
            // Guard the draft→sent transition IN the statement: the SMTP call above can take
            // seconds, so a JS-side check on the pre-send snapshot could overwrite a concurrent
            // status change (e.g. paid/void). No transactions in the bridge — single statement.
            await db.run(`UPDATE ${T.invoices} SET status = 'sent' WHERE id = ? AND status = 'draft'`, [id]);
            res.json({ sent: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Identificador inválido.' });
            const result = await db.run(`DELETE FROM ${T.invoices} WHERE id = ?`, [id]);
            if (!result || !result.changes) return res.status(404).json({ error: 'Factura no encontrada.' });
            res.json({ deleted: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // CSV export. The sandbox's res.send() JSON-encodes string bodies (corrupts raw CSV), so the
    // CSV travels as a JSON field and the admin client builds the Blob download.
    http.route('get', '/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(`SELECT * FROM ${T.invoices} ORDER BY id DESC`);
            const cents = (v) => ((Number(v) || 0) / 100).toFixed(2);
            const esc = (v) => {
                let s = v === null || v === undefined ? '' : String(v);
                // Neutralize spreadsheet formula injection (defense in depth for pasted client data).
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = ['Número', 'Cliente', 'Email', 'Estado', 'Emitida', 'Vence', 'Subtotal', 'Descuento', 'Impuesto %', 'Impuesto', 'Total', 'Moneda', 'Notas'];
            const lines = rows.map((r) => {
                const st = effectiveStatus(r);
                return [
                    r.number, r.client_name, r.client_email || '', STATUS_LABELS_ES[st] || st,
                    r.issued_at || '', r.due_at || '',
                    cents(r.subtotal_cents), cents(r.discount_cents), r.tax_pct || 0, cents(r.tax_cents), cents(r.total_cents),
                    r.currency_symbol || '$', r.notes || '',
                ].map(esc).join(',');
            });
            const csv = '﻿' + header.map(esc).join(',') + '\r\n' + lines.join('\r\n'); // BOM so Excel reads UTF-8
            const today = new Date().toISOString().slice(0, 10);
            res.json({ csv, filename: `facturas-${today}.csv`, count: rows.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            const b = req.body || {};
            const current = await getConfig();
            const pick = (key, max) => (typeof b[key] === 'string' ? String(b[key]).trim().slice(0, max) : current[key]);
            const cfg = {
                businessName: pick('businessName', 200),
                businessAddress: pick('businessAddress', 500),
                businessTaxId: pick('businessTaxId', 100),
                businessEmail: pick('businessEmail', 200),
                currencySymbol: pick('currencySymbol', 8) || '$',
                footerNote: pick('footerNote', 500),
                invoicePageUrl: pick('invoicePageUrl', 500),
            };
            if (cfg.businessEmail && !EMAIL_RE.test(cfg.businessEmail)) {
                return res.status(400).json({ error: 'El correo del negocio no es válido.' });
            }
            await options.set(OPT_CONFIG, cfg);
            res.json(cfg);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // =================================== PUBLIC ROUTE ===============================================

    // Failed-lookup throttle: no req.ip exists in the sandbox, so this is a GLOBAL rolling window
    // over WRONG tokens only (valid links are never throttled). It makes token brute-force
    // pointless on top of the 62^32 space.
    const FAIL_MAX = 60;
    const FAIL_WINDOW_MS = 10 * 60 * 1000;
    let viewFails = { count: 0, first: 0 };

    // Full invoice data + business identity for the Puck block. Safe: whoever holds the token is
    // the invoice's recipient (the link is only ever mailed to them / copied by the admin).
    http.route('get', '/public/view', async (req, res) => {
        try {
            const token = String((req.query && req.query.token) || '').trim();
            if (!/^[A-Za-z0-9]{32}$/.test(token)) return res.status(400).json({ error: 'Enlace inválido.' });

            const now = Date.now();
            const inWindow = now - viewFails.first < FAIL_WINDOW_MS;
            if (inWindow && viewFails.count >= FAIL_MAX) {
                return res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo más tarde.' });
            }

            const row = await db.get(`SELECT * FROM ${T.invoices} WHERE token = ?`, [token]);
            if (!row) {
                if (inWindow) viewFails.count++;
                else viewFails = { count: 1, first: now };
                return res.status(404).json({ error: 'Factura no encontrada.' });
            }

            const cfg = await getConfig();
            const d = decorate(row);
            res.json({
                invoice: {
                    number: d.number,
                    status: d.effective_status, // 'overdue' auto-derived for sent invoices past due
                    client_name: d.client_name,
                    client_email: d.client_email,
                    client_address: d.client_address,
                    client_tax_id: d.client_tax_id,
                    items: d.items,
                    tax_pct: d.tax_pct,
                    discount_cents: d.discount_cents,
                    subtotal_cents: d.subtotal_cents,
                    tax_cents: d.tax_cents,
                    total_cents: d.total_cents,
                    currency_symbol: d.currency_symbol,
                    issued_at: d.issued_at,
                    due_at: d.due_at,
                    notes: d.notes,
                },
                business: {
                    name: cfg.businessName,
                    address: cfg.businessAddress,
                    taxId: cfg.businessTaxId,
                    email: cfg.businessEmail,
                    footerNote: cfg.footerNote,
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    adminMenu.add({
        href: '/admin/plugin/invoices',
        label: 'Facturas',
        icon: 'fa-file-invoice-dollar',
        order: 74,
        cap: 'manage_options',
    });

    console.log('[invoices] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down.
};
