/**
 * WordJS Plugin: Digital Downloads — ISOLATED, sandboxed (Easy Digital Downloads parity, v1).
 *
 * Sell or give away downloadable products. The FILE is a PRIVATE media-library item (stored by the
 * host outside the public /uploads tree and hidden from every public media listing). Delivery is a
 * TOKEN-GATED STREAM:
 *   - a buyer receives a random 32-char token (by email and/or on screen);
 *   - GET /public/download?token= checks paid + expiry + max-uses in a SINGLE UPDATE statement
 *     (the db bridge has no transactions) on EVERY download and only then asks the host to stream
 *     the file (res.sendPrivateMedia, media:private_read grant). No URL is ever revealed, so an
 *     expired or exhausted link really is dead.
 *
 * SECURITY HISTORY (1.0.x): products used to hold a PUBLIC media URL whose only protection was not
 * being listed — but the core media API listed it to anonymous callers, so every paid file could be
 * downloaded without buying it, and a revealed URL outlived its token. Products created before 1.1.0
 * still carry that public `file_url`; they keep working (the URL is still revealed, as before) but the
 * admin is warned on every such product until its file is re-selected as a private media item.
 *
 * v1 flows:
 *   - price 0 (gratis): instant — order inserted as 'paid', link emailed + shown on screen.
 *   - price > 0: manual payment — order inserted as 'pending' with the configured instructions;
 *     the admin marks it paid in the dashboard, which resets the expiry and auto-emails the link.
 *   - Stripe checkout is deliberately OUT of v1 scope (future work) to keep this plugin tight.
 *
 * Sandbox constraints honored here: tokens via the host CSPRNG (wordjs.crypto.randomToken), NOT
 * Math.random — rate limiting is defense-in-depth; no transactions (single-statement counters), CSV export
 * returned as res.json({csv}) because the isolate JSON-encodes string bodies.
 */

exports.metadata = {
    name: 'Digital Downloads',
    version: '1.1.0',
    description: 'Downloadable products (private media files) with token-gated, expiring, limited-use download links.',
    author: 'WordJS',
};

const OPT_CONFIG = 'digital_downloads_config';

const CONFIG_DEFAULTS = {
    currencySymbol: '$',
    manualInstructions: '',
    notifyEmail: '',
    linkDays: 7,
    maxUses: 5,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PRICE_CENTS = 100000000; // $1,000,000 — sanity cap

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail, site, media } = wordjs;

    // Per-plugin table namespace enforced by the host. slug 'digital-downloads' -> 'wjp_digital_downloads_'.
    const P = db.tablePrefix;
    const T = {
        products: `${P}products`,
        orders: `${P}orders`,
        // product -> PRIVATE media item. A side table because the db bridge cannot ALTER TABLE; a
        // product with a row here is delivered by the host stream, one without is a legacy public URL.
        files: `${P}product_files`,
    };

    // ---- schema (idempotent, full column set from day 1 — ALTER TABLE is not available) ----------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.products} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT UNIQUE,
            description TEXT,
            price_cents INTEGER DEFAULT 0,
            file_url TEXT NOT NULL,
            file_label TEXT,
            image_url TEXT,
            is_published INTEGER DEFAULT 1,
            sales_count INTEGER DEFAULT 0,
            download_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.orders} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            token TEXT NOT NULL,
            customer_name TEXT,
            customer_email TEXT NOT NULL,
            amount_cents INTEGER,
            payment_status TEXT DEFAULT 'pending',
            expires_at TEXT,
            max_uses INTEGER DEFAULT 5,
            use_count INTEGER DEFAULT 0,
            page_path TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.files} (
            product_id INTEGER PRIMARY KEY,
            media_id INTEGER NOT NULL
        )`);
        // Index names and targets must carry the plugin prefix (host-enforced).
        try {
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_orders_token ON ${T.orders} (token)`);
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_orders_product ON ${T.orders} (product_id)`);
        } catch (e) {
            // Non-fatal — lookups still work without the indexes.
        }
    }
    await initSchema();

    // ---- config -----------------------------------------------------------------------------------
    const clampInt = (v, min, max, dflt) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return dflt;
        return Math.min(max, Math.max(min, n));
    };

    async function getConfig() {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        const cfg = { ...CONFIG_DEFAULTS, ...stored };
        cfg.currencySymbol = String(cfg.currencySymbol || '$').slice(0, 8);
        cfg.manualInstructions = String(cfg.manualInstructions || '').slice(0, 5000);
        cfg.notifyEmail = String(cfg.notifyEmail || '').trim().slice(0, 254);
        cfg.linkDays = clampInt(cfg.linkDays, 1, 365, 7);
        cfg.maxUses = clampInt(cfg.maxUses, 1, 100, 5);
        return cfg;
    }

    // ---- helpers ----------------------------------------------------------------------------------

    /**
     * SECURITY (audit HIGH): the download token is the SOLE gate on /public/download, which returns a
     * paid product's file_url and consumes a download use. The old note claimed "no path to a CSPRNG in
     * the sandbox" — that is FALSE: the host CSPRNG is bridged as `wordjs.crypto.randomToken` (used by
     * event-tickets/online-store). It matters because Math.random is V8 xorshift128+ whose state is
     * reconstructable from a few observed tokens — and POST /public/order returns the caller's own token
     * for ANY order (paid or not), so an attacker harvests tokens, predicts paying customers' tokens and
     * claims their downloads. The keyspace/throttle stop blind guessing, NOT prediction. randomToken(16)
     * = 32 hex chars, which satisfies TOKEN_RE (/^[A-Za-z0-9]{32}$/). Async (RPC to the host).
     */
    async function genToken() {
        return wordjs.crypto.randomToken(16);
    }

    // In-memory rolling-window rate limiter (single child process; req has no IP in the sandbox,
    // so limits are global per resource — coarse but effective against bots and token guessing).
    const rateBuckets = new Map(); // bucket name -> number[] timestamps
    function rateLimited(name, max, windowMs) {
        const now = Date.now();
        const arr = (rateBuckets.get(name) || []).filter((t) => now - t < windowMs);
        if (arr.length >= max) { rateBuckets.set(name, arr); return true; }
        arr.push(now);
        rateBuckets.set(name, arr);
        return false;
    }

    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const fmtMoney = (cents, symbol) => `${symbol}${((Number(cents) || 0) / 100).toFixed(2)}`;

    /**
     * Keep only a safe, same-site PATH from a client-provided page URL (the page hosting the
     * block). Prevents emailing links that point at attacker-chosen domains via a forged page_url.
     */
    function pagePathOf(pageUrl) {
        let s = String(pageUrl || '').trim();
        const m = s.match(/^https?:\/\/[^/]+(\/[^#]*)?$/);
        if (m) s = m[1] || '/';
        s = s.split('#')[0];
        if (!s.startsWith('/') || s.length > 500) return '/';
        if (!/^[-a-zA-Z0-9/._~%?=&+]*$/.test(s)) return '/';
        return s;
    }

    async function buildDownloadLink(pagePath, token) {
        let base = '';
        try { base = String(await site.url()) || ''; } catch (e) { base = ''; }
        base = base.replace(/\/+$/, '');
        const path = pagePath && pagePath.startsWith('/') ? pagePath : '/';
        const sep = path.includes('?') ? '&' : '?';
        return `${base}${path}${sep}dl=${token}`;
    }

    /** Send mail without ever failing the request — orders must survive a broken mail provider. */
    async function trySendMail(msg) {
        try {
            await mail(msg);
            return true;
        } catch (e) {
            console.warn('[digital-downloads] correo no enviado:', e && e.message ? e.message : e);
            return false;
        }
    }

    async function sendDownloadLinkEmail(order, product, cfg) {
        const link = await buildDownloadLink(order.page_path, order.token);
        const expires = order.expires_at ? new Date(order.expires_at).toLocaleDateString('es') : '';
        const html = `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
                <h2>Tu descarga está lista</h2>
                <p>Hola ${escapeHtml(order.customer_name || '')},</p>
                <p>Aquí tienes tu enlace de descarga para <strong>${escapeHtml(product.name)}</strong>${product.file_label ? ` (${escapeHtml(product.file_label)})` : ''}:</p>
                <p style="margin:24px 0">
                    <a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Descargar ahora</a>
                </p>
                <p style="font-size:13px;color:#555">El enlace admite hasta ${order.max_uses} descargas${expires ? ` y caduca el ${expires}` : ''}. Si el botón no funciona, copia y pega esta dirección en tu navegador:<br>${escapeHtml(link)}</p>
            </div>`;
        return trySendMail({
            to: order.customer_email,
            subject: `Tu descarga: ${product.name}`,
            html,
            text: `Tu enlace de descarga para ${product.name}: ${link} (hasta ${order.max_uses} descargas${expires ? `, caduca el ${expires}` : ''})`,
        });
    }

    async function sendOrderReceivedEmail(order, product, cfg) {
        const statusLink = await buildDownloadLink(order.page_path, order.token);
        const html = `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
                <h2>Pedido recibido</h2>
                <p>Hola ${escapeHtml(order.customer_name || '')},</p>
                <p>Recibimos tu pedido de <strong>${escapeHtml(product.name)}</strong> por <strong>${fmtMoney(order.amount_cents, cfg.currencySymbol)}</strong>.</p>
                ${cfg.manualInstructions ? `<p style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px">${escapeHtml(cfg.manualInstructions)}</p>` : ''}
                <p>Cuando confirmemos tu pago te enviaremos el enlace de descarga a este correo. También puedes consultar el estado de tu pedido aquí:</p>
                <p style="font-size:13px;color:#555">${escapeHtml(statusLink)}</p>
                <p style="font-size:13px;color:#555">Código de tu pedido: <strong>${order.token}</strong></p>
            </div>`;
        return trySendMail({
            to: order.customer_email,
            subject: `Pedido recibido — ${product.name}`,
            html,
            text: `Recibimos tu pedido de ${product.name} por ${fmtMoney(order.amount_cents, cfg.currencySymbol)}. ${cfg.manualInstructions || ''} Estado del pedido: ${statusLink} (código ${order.token})`,
        });
    }

    async function notifyAdminNewOrder(order, product, cfg) {
        let to = cfg.notifyEmail;
        if (!to || !EMAIL_RE.test(to)) {
            try { to = String(await site.adminEmail()) || ''; } catch (e) { to = ''; }
        }
        if (!to || !EMAIL_RE.test(to)) return false;
        const html = `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
                <h2>Nuevo pedido pendiente</h2>
                <p><strong>${escapeHtml(product.name)}</strong> — ${fmtMoney(order.amount_cents, cfg.currencySymbol)}</p>
                <p>Cliente: ${escapeHtml(order.customer_name || '(sin nombre)')} &lt;${escapeHtml(order.customer_email)}&gt;</p>
                <p>Marca el pedido como pagado en Admin → Descargas Digitales → Pedidos para enviar el enlace de descarga automáticamente.</p>
            </div>`;
        return trySendMail({
            to,
            subject: `Nuevo pedido pendiente — ${product.name}`,
            html,
            text: `Nuevo pedido pendiente: ${product.name} (${fmtMoney(order.amount_cents, cfg.currencySymbol)}) de ${order.customer_email}. Márcalo como pagado en el panel para enviar el enlace.`,
        });
    }

    // ---- product input validation (shared by create/update) ---------------------------------------
    const slugify = (s) => String(s || '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    function validateProductBody(body, { partial } = {}) {
        const out = {};
        const errors = [];
        const has = (k) => body[k] !== undefined;

        if (has('name') || !partial) {
            const name = String(body.name || '').trim().slice(0, 200);
            if (!name) errors.push('El nombre es obligatorio.');
            else out.name = name;
        }
        if (has('slug') || has('name')) {
            // Slug: use the caller's or derive from the name; uniqueness is checked at the route.
            const raw = has('slug') && String(body.slug || '').trim() ? body.slug : (out.name || '');
            const slug = slugify(raw);
            if (slug) out.slug = slug.slice(0, 120);
        }
        if (has('description')) out.description = String(body.description || '').slice(0, 5000);
        if (has('price_cents') || !partial) {
            const cents = Math.round(Number(body.price_cents));
            if (!Number.isFinite(cents) || cents < 0 || cents > MAX_PRICE_CENTS) {
                errors.push('Precio inválido (usa centavos enteros, 0 = gratis).');
            } else out.price_cents = cents;
        }
        // The file is a PRIVATE media item id. A public URL (`file_url`) is no longer accepted: it was the
        // vulnerability (anyone could list and fetch it). Legacy rows keep theirs until re-selected.
        if (has('media_id') || !partial) {
            const mediaId = parseInt(body.media_id, 10);
            if (!Number.isFinite(mediaId) || mediaId < 1) {
                errors.push('Selecciona o sube el archivo como medio PRIVADO.');
            } else out.media_id = mediaId;
        }
        if (has('file_label')) out.file_label = String(body.file_label || '').trim().slice(0, 200);
        if (has('image_url')) {
            const img = String(body.image_url || '').trim().slice(0, 2000);
            if (img && !/^(https?:\/\/|\/)/.test(img)) errors.push('URL de imagen inválida.');
            else out.image_url = img;
        }
        if (has('is_published')) out.is_published = body.is_published ? 1 : 0;
        return { out, errors };
    }

    /** The private media description for an id, or null (not private / gone / grant missing). */
    async function privateFileInfo(mediaId) {
        if (!mediaId) return null;
        try { return await media.getPrivate(mediaId); } catch (e) { return null; }
    }

    /** media_id of a product's private file, or 0 for a legacy (public file_url) product. */
    async function productMediaId(productId) {
        const row = await db.get(`SELECT media_id FROM ${T.files} WHERE product_id = ?`, [productId]);
        return row ? Number(row.media_id) || 0 : 0;
    }

    /** Validate that `mediaId` is a private media item the host will deliver. Error message or ''. */
    async function checkPrivateMedia(mediaId) {
        try {
            const info = await media.getPrivate(mediaId);
            return info ? '' : 'El archivo seleccionado no existe o no es PRIVADO. Márcalo como privado en la biblioteca de medios.';
        } catch (e) {
            return 'El plugin no tiene el permiso "media:private_read". Concédelo en Admin → Plugins para entregar archivos privados.';
        }
    }

    async function setProductMedia(productId, mediaId) {
        await db.run(`DELETE FROM ${T.files} WHERE product_id = ?`, [productId]);
        await db.run(`INSERT INTO ${T.files} (product_id, media_id) VALUES (?, ?)`, [productId, mediaId]);
        // The private file supersedes any legacy public URL — never reveal it again.
        await db.run(`UPDATE ${T.products} SET file_url = '' WHERE id = ?`, [productId]);
    }

    // ============================ PUBLIC ROUTES ============================

    // Product grid for the Puck block (editor iframe AND public page).
    // NEVER exposes file_url — the file is only revealed by /public/download after the token checks.
    http.route('get', '/public/products', async (req, res) => {
        try {
            const cfg = await getConfig();
            let limit = parseInt((req.query && req.query.limit) || 24, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 24;
            limit = Math.min(limit, 100);
            const slug = slugify((req.query && req.query.slug) || '');
            let rows;
            if (slug) {
                rows = await db.all(
                    `SELECT id, name, slug, description, price_cents, file_label, image_url
                     FROM ${T.products} WHERE is_published = 1 AND slug = ? LIMIT ?`,
                    [slug, limit]
                );
            } else {
                rows = await db.all(
                    `SELECT id, name, slug, description, price_cents, file_label, image_url
                     FROM ${T.products} WHERE is_published = 1 ORDER BY id DESC LIMIT ?`,
                    [limit]
                );
            }
            res.json({ products: rows, currencySymbol: cfg.currencySymbol });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create an order. Server-side price ONLY: the client sends the product id — never a price.
    http.route('post', '/public/order', async (req, res) => {
        try {
            if (rateLimited('order', 10, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' });
            }
            const body = req.body || {};

            // Honeypot: hidden field a human never fills. Pretend success so bots stop retrying.
            if (String(body.hp || '').trim()) return res.json({ success: true });

            // Time-to-fill: a human takes at least ~1.5s from opening the form to submitting.
            const elapsed = Number(body.elapsed);
            if (!Number.isFinite(elapsed) || elapsed < 1500) {
                return res.status(429).json({ error: 'Formulario enviado demasiado rápido. Intenta de nuevo.' });
            }

            const email = String(body.customer_email || '').trim().toLowerCase().slice(0, 254);
            if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Correo electrónico inválido.' });
            const name = String(body.customer_name || '').trim().slice(0, 200);

            const productId = parseInt(body.product_id, 10);
            if (!Number.isFinite(productId) || productId < 1) {
                return res.status(400).json({ error: 'Producto inválido.' });
            }
            const product = await db.get(
                `SELECT * FROM ${T.products} WHERE id = ? AND is_published = 1`, [productId]
            );
            if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

            const cfg = await getConfig();
            const token = await genToken();
            const pagePath = pagePathOf(body.page_url);
            const expiresAt = new Date(Date.now() + cfg.linkDays * DAY_MS).toISOString();
            const free = (Number(product.price_cents) || 0) === 0;
            // Price recomputed from the DB row — client-sent amounts are ignored by design.
            const amountCents = Number(product.price_cents) || 0;

            await db.run(
                `INSERT INTO ${T.orders}
                    (product_id, token, customer_name, customer_email, amount_cents, payment_status, expires_at, max_uses, use_count, page_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                [product.id, token, name, email, amountCents, free ? 'paid' : 'pending', expiresAt, cfg.maxUses, pagePath]
            );
            const order = {
                product_id: product.id, token, customer_name: name, customer_email: email,
                amount_cents: amountCents, expires_at: expiresAt, max_uses: cfg.maxUses, page_path: pagePath,
            };

            if (free) {
                await db.run(`UPDATE ${T.products} SET sales_count = sales_count + 1 WHERE id = ?`, [product.id]);
                const emailSent = await sendDownloadLinkEmail(order, product, cfg);
                return res.json({ success: true, free: true, token, emailSent });
            }

            const emailSent = await sendOrderReceivedEmail(order, product, cfg);
            await notifyAdminNewOrder(order, product, cfg);
            res.json({ success: true, free: false, token, emailSent, manualInstructions: cfg.manualInstructions });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Token-gated download. Every request re-checks paid + expiry + max-uses and consumes one use in a
    // single UPDATE; a private-file product is then STREAMED by the host (res.sendPrivateMedia), so no
    // URL ever reaches the buyer and an expired/exhausted token cannot be bypassed by reusing one.
    // Legacy products (public file_url, created before 1.1.0) still get their URL revealed as before.
    http.route('get', '/public/download', async (req, res) => {
        try {
            if (rateLimited('download', 60, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' });
            }
            const token = String((req.query && req.query.token) || '').trim();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Token de descarga inválido.' });

            const pre = await db.get(`SELECT product_id FROM ${T.orders} WHERE token = ?`, [token]);
            if (!pre) return res.status(404).json({ error: 'Enlace de descarga no encontrado.' });
            const mediaId = await productMediaId(pre.product_id);
            // A private file the host would refuse to deliver must not cost the buyer a download.
            const info = mediaId ? await privateFileInfo(mediaId) : null;
            if (mediaId && !info) {
                return res.status(503).json({ error: 'El archivo no está disponible en este momento. Contacta con la tienda.' });
            }

            const nowIso = new Date().toISOString();
            // Single-statement consume: no transactions in the sandbox, so the paid/expiry/uses
            // checks and the counter increment happen atomically in ONE UPDATE. changes === 0
            // means some check failed — diagnose below for a precise error message.
            const upd = await db.run(
                `UPDATE ${T.orders}
                 SET use_count = use_count + 1
                 WHERE token = ? AND payment_status = 'paid' AND use_count < max_uses AND expires_at > ?`,
                [token, nowIso]
            );
            if (!upd || upd.changes !== 1) {
                const order = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
                if (!order) return res.status(404).json({ error: 'Enlace de descarga no encontrado.' });
                if (order.payment_status !== 'paid') return res.status(402).json({ error: 'El pago de este pedido aún no ha sido confirmado.' });
                if (order.expires_at && order.expires_at <= nowIso) return res.status(410).json({ error: 'Enlace expirado. Contacta con la tienda para renovarlo.' });
                return res.status(410).json({ error: 'Enlace agotado — se alcanzó el máximo de descargas.' });
            }

            const order = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
            const product = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [order.product_id]);
            if (!product) return res.status(404).json({ error: 'El producto ya no existe.' });
            await db.run(`UPDATE ${T.products} SET download_count = download_count + 1 WHERE id = ?`, [order.product_id]);

            if (mediaId) {
                const base = slugify(product.slug || product.name) || 'descarga';
                return res.sendPrivateMedia(mediaId, { filename: base });
            }

            // LEGACY (pre-1.1.0 product): the file is a PUBLIC media URL. Kept working so existing sales
            // are not broken; the admin sees a warning on this product until it is re-selected as private.
            if (!product.file_url) return res.status(503).json({ error: 'El archivo no está disponible en este momento. Contacta con la tienda.' });
            res.json({
                url: product.file_url,
                name: product.name,
                remaining: Math.max(0, (Number(order.max_uses) || 0) - (Number(order.use_count) || 0)),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Order status for the block's ?dl= banner.
    http.route('get', '/public/status', async (req, res) => {
        try {
            if (rateLimited('status', 120, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' });
            }
            const token = String((req.query && req.query.token) || '').trim();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Token inválido.' });
            const order = await db.get(
                `SELECT o.product_id, o.payment_status, o.expires_at, o.max_uses, o.use_count, o.amount_cents, p.name AS product_name
                 FROM ${T.orders} o LEFT JOIN ${T.products} p ON p.id = o.product_id
                 WHERE o.token = ?`,
                [token]
            );
            if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
            const mediaId = await productMediaId(order.product_id);
            res.json({
                payment_status: order.payment_status,
                expires_at: order.expires_at,
                expired: !!(order.expires_at && order.expires_at <= new Date().toISOString()),
                // 'stream': the browser navigates to /public/download and the host streams the file;
                // 'url': legacy product whose download answers JSON {url}.
                delivery: mediaId ? 'stream' : 'url',
                remaining: Math.max(0, (Number(order.max_uses) || 0) - (Number(order.use_count) || 0)),
                product_name: order.product_name || '',
                free: (Number(order.amount_cents) || 0) === 0,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ============================ ADMIN ROUTES ============================

    // --- products CRUD ---
    // Each product carries `file_status`: 'private' (delivered by the host stream), 'public_legacy'
    // (pre-1.1.0 public URL — anyone can fetch it; the admin UI shows a warning until re-selected) or
    // 'unavailable' (the private file is gone, is no longer private, or the grant is missing).
    http.route('get', '/products', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(
                `SELECT p.*, f.media_id AS media_id
                 FROM ${T.products} p LEFT JOIN ${T.files} f ON f.product_id = p.id
                 ORDER BY p.id DESC`
            );
            for (const row of rows) {
                if (row.media_id) {
                    const info = await privateFileInfo(row.media_id);
                    row.file_status = info ? 'private' : 'unavailable';
                    row.file_name = info ? info.filename : '';
                    row.file_size = info ? info.filesize : 0;
                } else {
                    row.media_id = null;
                    row.file_status = row.file_url ? 'public_legacy' : 'unavailable';
                }
            }
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/products', { auth: true, admin: true }, async (req, res) => {
        try {
            const { out, errors } = validateProductBody(req.body || {}, { partial: false });
            if (errors.length) return res.status(400).json({ error: errors[0] });
            const mediaError = await checkPrivateMedia(out.media_id);
            if (mediaError) return res.status(400).json({ error: mediaError });
            if (!out.slug) out.slug = 'producto-' + Date.now().toString(36);
            const clash = await db.get(`SELECT id FROM ${T.products} WHERE slug = ?`, [out.slug]);
            if (clash) return res.status(409).json({ error: 'Ya existe un producto con ese slug.' });
            const result = await db.run(
                `INSERT INTO ${T.products} (name, slug, description, price_cents, file_url, file_label, image_url, is_published)
                 VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
                [out.name, out.slug, out.description || '', out.price_cents,
                 out.file_label || '', out.image_url || '', out.is_published === undefined ? 1 : out.is_published]
            );
            await setProductMedia(result.lastID, out.media_id);
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('put', '/products/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const existing = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });
            const { out, errors } = validateProductBody(req.body || {}, { partial: true });
            if (errors.length) return res.status(400).json({ error: errors[0] });
            if (out.slug) {
                const clash = await db.get(`SELECT id FROM ${T.products} WHERE slug = ? AND id != ?`, [out.slug, id]);
                if (clash) return res.status(409).json({ error: 'Ya existe un producto con ese slug.' });
            }
            if (out.media_id !== undefined) {
                const mediaError = await checkPrivateMedia(out.media_id);
                if (mediaError) return res.status(400).json({ error: mediaError });
            }
            const sets = [];
            const params = [];
            for (const key of ['name', 'slug', 'description', 'price_cents', 'file_label', 'image_url', 'is_published']) {
                if (out[key] !== undefined) { sets.push(`${key} = ?`); params.push(out[key]); }
            }
            if (sets.length) {
                params.push(id);
                await db.run(`UPDATE ${T.products} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            if (out.media_id !== undefined) await setProductMedia(id, out.media_id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Deleting a product also deletes its orders (their tokens would dangle otherwise) —
    // the admin UI warns about this before confirming.
    http.route('delete', '/products/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            await db.run(`DELETE FROM ${T.orders} WHERE product_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.files} WHERE product_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.products} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- orders ---
    http.route('get', '/orders', { auth: true, admin: true }, async (req, res) => {
        try {
            const status = String((req.query && req.query.status) || '').trim();
            let sql = `SELECT o.*, p.name AS product_name
                       FROM ${T.orders} o LEFT JOIN ${T.products} p ON p.id = o.product_id`;
            const params = [];
            if (status === 'pending' || status === 'paid') { sql += ' WHERE o.payment_status = ?'; params.push(status); }
            sql += ' ORDER BY o.id DESC LIMIT 500';
            const rows = await db.all(sql, params);
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Mark paid: single guarded UPDATE (only transitions pending -> paid, so a double click can't
    // double-count sales), reset the expiry window from NOW, then auto-email the download link.
    http.route('post', '/orders/:id/paid', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const cfg = await getConfig();
            const newExpires = new Date(Date.now() + cfg.linkDays * DAY_MS).toISOString();
            const upd = await db.run(
                `UPDATE ${T.orders} SET payment_status = 'paid', expires_at = ?
                 WHERE id = ? AND payment_status = 'pending'`,
                [newExpires, id]
            );
            if (!upd || upd.changes !== 1) {
                const existing = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Pedido no encontrado.' });
                return res.json({ success: true, already: true, emailSent: false });
            }
            const order = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
            await db.run(`UPDATE ${T.products} SET sales_count = sales_count + 1 WHERE id = ?`, [order.product_id]);
            const product = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [order.product_id]);
            let emailSent = false;
            if (product) emailSent = await sendDownloadLinkEmail(order, product, cfg);
            res.json({ success: true, emailSent });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            await db.run(`DELETE FROM ${T.orders} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // CSV export. NOTE: the isolate's res.send() JSON-encodes string bodies (corrupting raw CSV),
    // so the CSV travels as a JSON field and the admin client builds the Blob/download.
    http.route('get', '/orders/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const cfg = await getConfig();
            const rows = await db.all(
                `SELECT o.*, p.name AS product_name
                 FROM ${T.orders} o LEFT JOIN ${T.products} p ON p.id = o.product_id
                 ORDER BY o.id DESC`
            );
            const esc = (v) => {
                let s = v === null || v === undefined ? '' : String(v);
                // Neutralize spreadsheet formula injection — customer_name comes from the public form.
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = ['ID', 'Producto', 'Cliente', 'Email', 'Importe', 'Estado', 'Descargas usadas', 'Máx. descargas', 'Expira', 'Creado', 'Token'];
            const lines = rows.map((r) => [
                r.id, r.product_name || '', r.customer_name || '', r.customer_email,
                ((Number(r.amount_cents) || 0) / 100).toFixed(2),
                r.payment_status, r.use_count, r.max_uses, r.expires_at || '', r.created_at || '', r.token,
            ].map(esc).join(','));
            const csv = '﻿' + header.map(esc).join(',') + '\r\n' + lines.join('\r\n'); // BOM so Excel reads UTF-8
            res.json({ csv, filename: 'pedidos-descargas.csv', count: rows.length, currencySymbol: cfg.currencySymbol });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- config ---
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json(await getConfig());
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const cfg = await getConfig();
            if (body.currencySymbol !== undefined) cfg.currencySymbol = String(body.currencySymbol || '$').trim().slice(0, 8) || '$';
            if (body.manualInstructions !== undefined) cfg.manualInstructions = String(body.manualInstructions || '').slice(0, 5000);
            if (body.notifyEmail !== undefined) {
                const em = String(body.notifyEmail || '').trim().toLowerCase().slice(0, 254);
                if (em && !EMAIL_RE.test(em)) return res.status(400).json({ error: 'Correo de notificación inválido.' });
                cfg.notifyEmail = em;
            }
            if (body.linkDays !== undefined) cfg.linkDays = clampInt(body.linkDays, 1, 365, 7);
            if (body.maxUses !== undefined) cfg.maxUses = clampInt(body.maxUses, 1, 100, 5);
            await options.set(OPT_CONFIG, cfg);
            res.json(cfg);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    adminMenu.add({
        href: '/admin/plugin/downloads',
        label: 'Descargas Digitales',
        icon: 'fa-download',
        order: 73,
        cap: 'manage_options',
    });

    console.log('[digital-downloads] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — rate-limit maps die with the child process.
};
