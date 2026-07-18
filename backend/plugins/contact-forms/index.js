/**
 * WordJS Plugin: Contact Forms
 *
 * WordPress parity: Contact Form 7 / WPForms. Admins build forms with custom fields, embed them
 * anywhere via the Puck block "ContactForms", visitors submit, and submissions land in an admin
 * inbox with unread tracking, CSV export and an optional email notification to the form owner.
 *
 * Sandbox notes:
 *  - Isolated plugin: only the injected `wordjs` bridge is used. All tables live under the enforced
 *    prefix (db.tablePrefix -> 'wjp_contact_forms_').
 *  - The db bridge has NO transactions: the only multi-statement write (cascade form delete)
 *    deletes the child submissions first, so a crash between statements can never orphan rows.
 *  - There is NO crypto API in the sandbox: field-name slugs are Math.random based — they only need
 *    uniqueness, not secrecy.
 *  - The serialized request carries no req.ip, so anti-spam is honeypot + minimum-fill-time +
 *    a per-form in-memory rate limit (keyed by form id).
 *  - EVERYTHING responds via res.json: the isolate JSON-encodes string bodies, so the CSV export
 *    returns { csv, filename, count } and the admin client builds the Blob download.
 */

exports.metadata = {
    name: 'Contact Forms',
    version: '1.0.0',
    description: 'Form builder with custom fields, Puck embed block, submissions inbox, CSV export and email notifications.',
    author: 'WordJS',
};

const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELDS = 40;          // per form — also the cap on stored submission keys
const MAX_LABEL_LEN = 200;
const MAX_VALUE_LEN = 5000;     // per submitted value
const MAX_URL_LEN = 500;        // page_url cap
const MIN_FILL_MS = 3000;       // submissions faster than this are treated as bots
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;            // max submissions per form per window

exports.init = async function (wordjs) {
    const { db, http, adminMenu } = wordjs;

    console.log('[contact-forms] initializing…');

    // Enforced per-plugin table namespace: slug 'contact-forms' -> 'wjp_contact_forms_'.
    const P = db.tablePrefix;
    const T = {
        forms: P + 'forms',
        submissions: P + 'submissions',
    };

    // ---- schema (idempotent; full column set up-front — ALTER is denied for plugins) -------------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.forms} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            fields TEXT NOT NULL DEFAULT '[]',
            success_message TEXT,
            notify_email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.submissions} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            form_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            page_url TEXT,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        try {
            // Index name AND target must carry the plugin prefix (assertSqlAllowed enforces this).
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_submissions_form ON ${T.submissions} (form_id)`);
        } catch (e) {
            // Non-fatal: the index is an optimization only.
        }
    }
    await initSchema();

    // ---- helpers ---------------------------------------------------------------------------------
    const parseJson = (s, fallback) => {
        try {
            const v = JSON.parse(s);
            return v == null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    };

    const asString = (v) => (v == null ? '' : String(v));

    const escapeHtml = (v) => asString(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Math.random slug for field names — no crypto in the sandbox; uniqueness is all we need.
    const fieldSlug = () => {
        let s = '';
        while (s.length < 8) s += Math.random().toString(36).slice(2);
        return 'f_' + s.slice(0, 8);
    };

    /**
     * Validate + normalize the fields array coming from the admin editor.
     * Returns { fields } on success or { error } (Spanish, user-facing) on failure.
     * field.name is kept stable when provided; missing/duplicate names get a fresh slug.
     */
    function normalizeFields(input) {
        if (!Array.isArray(input)) return { error: 'Los campos deben ser una lista.' };
        if (input.length > MAX_FIELDS) return { error: 'Máximo ' + MAX_FIELDS + ' campos por formulario.' };
        const used = new Set();
        const fields = [];
        for (const raw of input) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return { error: 'Hay un campo con formato inválido.' };
            }
            const label = asString(raw.label).trim().slice(0, MAX_LABEL_LEN);
            if (!label) return { error: 'Todos los campos necesitan una etiqueta.' };
            const type = asString(raw.type);
            if (!FIELD_TYPES.includes(type)) return { error: 'Tipo de campo inválido: ' + type };
            let name = asString(raw.name).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
            while (!name || used.has(name)) name = fieldSlug();
            used.add(name);
            const options = type === 'select' ? asString(raw.options).slice(0, 2000) : '';
            const required = (raw.required === true || raw.required === 1 || raw.required === '1') ? 1 : 0;
            const width = Number(raw.width) === 50 ? 50 : 100;
            fields.push({ name, label, type, options, required, width });
        }
        return { fields };
    }

    const formToJson = (row) => ({
        id: row.id,
        name: row.name,
        fields: parseJson(row.fields, []),
        success_message: row.success_message || '',
        notify_email: row.notify_email || '',
        created_at: row.created_at,
        submission_count: row.submission_count == null ? undefined : row.submission_count,
        unread_count: row.unread_count == null ? undefined : row.unread_count,
    });

    // ---- per-form in-memory rate limiter (no req.ip in the sandbox) ------------------------------
    const submitCounters = new Map(); // form_id -> { count, windowStart }
    function allowSubmit(formId) {
        const now = Date.now();
        // Opportunistic pruning so the map cannot grow unbounded.
        if (submitCounters.size > 500) {
            for (const [k, v] of submitCounters) {
                if (now - v.windowStart > RATE_WINDOW_MS) submitCounters.delete(k);
            }
        }
        const entry = submitCounters.get(formId);
        if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
            submitCounters.set(formId, { count: 1, windowStart: now });
            return true;
        }
        entry.count += 1;
        return entry.count <= RATE_MAX;
    }

    // ================================ ADMIN ROUTES =================================================

    // List all forms with per-form submission + unread counts (correlated subqueries).
    http.route('get', '/forms', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`
            SELECT f.*,
                   (SELECT COUNT(*) FROM ${T.submissions} s WHERE s.form_id = f.id) AS submission_count,
                   (SELECT COUNT(*) FROM ${T.submissions} s WHERE s.form_id = f.id AND s.is_read = 0) AS unread_count
            FROM ${T.forms} f
            ORDER BY f.id DESC
        `);
        res.json({ forms: rows.map(formToJson) });
    });

    // Create (no body.id) or update (body.id present) a form.
    http.route('post', '/forms', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const name = asString(body.name).trim().slice(0, 200);
        if (!name) return res.status(400).json({ error: 'El nombre del formulario es obligatorio.' });

        const norm = normalizeFields(body.fields == null ? [] : body.fields);
        if (norm.error) return res.status(400).json({ error: norm.error });

        const notifyEmail = asString(body.notify_email).trim().slice(0, 320);
        if (notifyEmail && !EMAIL_RE.test(notifyEmail)) {
            return res.status(400).json({ error: 'El correo de notificación no es válido.' });
        }
        const successMessage = asString(body.success_message).trim().slice(0, 1000);
        const fieldsJson = JSON.stringify(norm.fields);

        if (body.id != null && body.id !== '') {
            const id = parseInt(body.id, 10);
            if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID de formulario inválido.' });
            const existing = await db.get(`SELECT id FROM ${T.forms} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Formulario no encontrado.' });
            await db.run(
                `UPDATE ${T.forms} SET name = ?, fields = ?, success_message = ?, notify_email = ? WHERE id = ?`,
                [name, fieldsJson, successMessage, notifyEmail, id]
            );
            const row = await db.get(`SELECT * FROM ${T.forms} WHERE id = ?`, [id]);
            return res.json({ form: formToJson(row) });
        }

        const result = await db.run(
            `INSERT INTO ${T.forms} (name, fields, success_message, notify_email) VALUES (?, ?, ?, ?)`,
            [name, fieldsJson, successMessage, notifyEmail]
        );
        const row = await db.get(`SELECT * FROM ${T.forms} WHERE id = ?`, [result.lastID]);
        res.json({ form: formToJson(row) });
    });

    // Delete a form and cascade-delete its submissions (children first — no transactions exist).
    http.route('delete', '/forms/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID de formulario inválido.' });
        const existing = await db.get(`SELECT id FROM ${T.forms} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Formulario no encontrado.' });
        await db.run(`DELETE FROM ${T.submissions} WHERE form_id = ?`, [id]);
        await db.run(`DELETE FROM ${T.forms} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // Inbox list: newest first, optional per-form filter, paginated.
    http.route('get', '/submissions', { auth: true, admin: true }, async (req, res) => {
        const q = req.query || {};
        let where = '';
        const params = [];
        if (q.form_id != null && q.form_id !== '') {
            const formId = parseInt(q.form_id, 10);
            if (!Number.isFinite(formId) || formId < 1) return res.status(400).json({ error: 'Filtro de formulario inválido.' });
            where = 'WHERE form_id = ?';
            params.push(formId);
        }
        let limit = parseInt(q.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = 50;
        limit = Math.min(limit, 200);
        let offset = parseInt(q.offset, 10);
        if (!Number.isFinite(offset) || offset < 0) offset = 0;

        const totalRow = await db.get(`SELECT COUNT(*) AS count FROM ${T.submissions} ${where}`, params);
        const rows = await db.all(
            `SELECT * FROM ${T.submissions} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            params.concat([limit, offset])
        );
        res.json({
            submissions: rows.map((r) => ({ ...r, data: parseJson(r.data, {}) })),
            total: totalRow ? totalRow.count : 0,
            limit,
            offset,
        });
    });

    // CSV export — returned as JSON ({csv, filename, count}); the client builds the Blob download.
    // Registered before any /submissions/:id sibling patterns out of caution.
    http.route('get', '/submissions/export', { auth: true, admin: true }, async (req, res) => {
        const formId = parseInt(req.query && req.query.form_id, 10);
        if (!Number.isFinite(formId) || formId < 1) return res.status(400).json({ error: 'Indica el formulario a exportar.' });
        const form = await db.get(`SELECT * FROM ${T.forms} WHERE id = ?`, [formId]);
        if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
        const fields = parseJson(form.fields, []);
        const rows = await db.all(`SELECT * FROM ${T.submissions} WHERE form_id = ? ORDER BY id ASC`, [formId]);

        // Quote-escape AND neutralize spreadsheet formula injection: visitor-controlled values
        // starting with = + - @ would execute as formulas when the admin opens the CSV in Excel.
        const cell = (v) => {
            let s = asString(v);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replace(/"/g, '""') + '"';
        };
        const header = fields.map((f) => cell(f.label)).concat([cell('Fecha'), cell('Página')]).join(',');
        const lines = [header];
        for (const r of rows) {
            const data = parseJson(r.data, {});
            const cols = fields.map((f) => cell(data[f.name]));
            cols.push(cell(r.created_at));
            cols.push(cell(r.page_url));
            lines.push(cols.join(','));
        }
        // UTF-8 BOM so Excel detects the encoding; CRLF row endings per RFC 4180.
        const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
        const base = asString(form.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'formulario';
        res.json({ csv, filename: base + '-envios.csv', count: rows.length });
    });

    // Mark a submission as read.
    http.route('post', '/submissions/:id/read', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID de mensaje inválido.' });
        const existing = await db.get(`SELECT id FROM ${T.submissions} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Mensaje no encontrado.' });
        await db.run(`UPDATE ${T.submissions} SET is_read = 1 WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // Delete a submission.
    http.route('delete', '/submissions/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID de mensaje inválido.' });
        const existing = await db.get(`SELECT id FROM ${T.submissions} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Mensaje no encontrado.' });
        await db.run(`DELETE FROM ${T.submissions} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ================================ PUBLIC ROUTES ================================================

    // Form definition for the Puck block. Never exposes notify_email.
    http.route('get', '/public/form', async (req, res) => {
        const id = parseInt(req.query && req.query.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID de formulario inválido.' });
        const form = await db.get(`SELECT id, name, fields, success_message FROM ${T.forms} WHERE id = ?`, [id]);
        if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
        res.json({
            id: form.id,
            name: form.name,
            fields: parseJson(form.fields, []),
            success_message: form.success_message || '',
        });
    });

    // Visitor submission.
    http.route('post', '/public/submit', async (req, res) => {
        const body = req.body || {};
        const formId = parseInt(body.form_id, 10);
        if (!Number.isFinite(formId) || formId < 1) return res.status(400).json({ error: 'ID de formulario inválido.' });
        const form = await db.get(`SELECT * FROM ${T.forms} WHERE id = ?`, [formId]);
        if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
        const fields = parseJson(form.fields, []);
        const successMessage = asString(form.success_message).trim() || '¡Mensaje enviado!';

        // Anti-spam: filled honeypot or too-fast fill gets a GENERIC success-looking response so the
        // bot cannot tell it was filtered. Nothing is stored, no email goes out.
        const hp = asString(body.hp).trim();
        const elapsed = Number(body.elapsed);
        if (hp !== '' || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
            return res.json({ success: true, message: successMessage });
        }

        // Coerce + cap the submitted values. Only the form's own field names are stored (a form is
        // already capped at MAX_FIELDS keys, which enforces the key cap too).
        const raw = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
        const clean = {};
        let stored = 0;
        for (const f of fields) {
            if (stored >= MAX_FIELDS) break;
            const v = raw[f.name];
            if (v == null) continue;
            clean[f.name] = asString(v).slice(0, MAX_VALUE_LEN);
            stored += 1;
        }

        // Server-side validation with Spanish user-facing messages.
        for (const f of fields) {
            const value = asString(clean[f.name]).trim();
            if (f.required && !value) {
                return res.status(400).json({ error: 'El campo "' + f.label + '" es obligatorio.' });
            }
            if (value && f.type === 'email' && !EMAIL_RE.test(value)) {
                return res.status(400).json({ error: 'El campo "' + f.label + '" debe ser un correo válido.' });
            }
            if (value && f.type === 'number' && !Number.isFinite(Number(value))) {
                return res.status(400).json({ error: 'El campo "' + f.label + '" debe ser un número.' });
            }
        }

        // Per-form rate limit (last gate before the write).
        if (!allowSubmit(formId)) {
            return res.status(429).json({ error: 'Demasiados envíos. Intenta de nuevo en un minuto.' });
        }

        const pageUrl = asString(body.page_url).slice(0, MAX_URL_LEN);
        await db.run(
            `INSERT INTO ${T.submissions} (form_id, data, page_url) VALUES (?, ?, ?)`,
            [formId, JSON.stringify(clean), pageUrl]
        );

        // Optional owner notification — NEVER fail the request because mail failed.
        if (asString(form.notify_email).trim()) {
            try {
                const rowsHtml = fields.map((f) =>
                    '<tr>'
                    + '<td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb;">' + escapeHtml(f.label) + '</td>'
                    + '<td style="padding:6px 12px;border:1px solid #e5e7eb;white-space:pre-wrap;">' + escapeHtml(clean[f.name]) + '</td>'
                    + '</tr>'
                ).join('');
                const html = '<div style="font-family:sans-serif;">'
                    + '<h2 style="margin:0 0 12px;">Nuevo mensaje: ' + escapeHtml(form.name) + '</h2>'
                    + '<table style="border-collapse:collapse;">' + rowsHtml + '</table>'
                    + (pageUrl ? '<p style="color:#6b7280;font-size:13px;">Enviado desde: ' + escapeHtml(pageUrl) + '</p>' : '')
                    + '</div>';
                const text = fields.map((f) => f.label + ': ' + asString(clean[f.name])).join('\n')
                    + (pageUrl ? '\n\nEnviado desde: ' + pageUrl : '');
                await wordjs.mail({
                    to: asString(form.notify_email).trim(),
                    subject: 'Nuevo mensaje: ' + form.name,
                    html,
                    text,
                });
            } catch (e) {
                console.warn('[contact-forms] notification email failed (submission stored anyway):', e && e.message ? e.message : e);
            }
        }

        res.json({ success: true, message: successMessage });
    });

    // ---- admin menu -------------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/contact-forms',
        label: 'Formularios',
        icon: 'fa-envelope-open-text',
        order: 57,
        cap: 'manage_options',
    });

    console.log('[contact-forms] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — the rate-limit map dies with the isolate.
};
