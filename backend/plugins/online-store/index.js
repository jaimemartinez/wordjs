/**
 * WordJS Plugin: Online Store (WooCommerce-parity v1)
 *
 * Product catalog + client-side cart + checkout with SERVER-SIDE price validation + coupons +
 * orders admin + optional Stripe Checkout. v1 boundaries: no shipping calculators, no tax
 * engines, no variations — one price per product, flat optional shipping fee, manual payment
 * (instructions) always available, Stripe optional.
 *
 * Money rules: ALL amounts are INTEGER CENTS end to end (price_cents, total_cents). Clients only
 * ever send product ids + quantities; the server re-reads prices from the DB and recomputes every
 * total itself.
 *
 * Race safety: the sandbox db bridge exposes NO transactions, so every race-sensitive mutation is
 * a SINGLE conditional statement — stock decrement `SET stock = stock - ? WHERE stock >= ?` and
 * coupon consumption `SET used_count = used_count + 1 WHERE used_count < max_uses` — with
 * result.changes checked afterwards.
 *
 * Secrets: the Stripe secret key lives in the plugin's OWN wjp_ settings table (write-only from
 * the admin: absent = keep, '' = clear, value = replace; only a hasKey boolean is ever echoed).
 * Options share one global namespace and block secret-named keys host-side, so the key never
 * touches options.
 *
 * Stripe (no webhooks — the sandbox has no HMAC, signatures cannot be verified): a Checkout
 * Session is created server-side with the order token in metadata; on return the block calls
 * /public/confirm-stripe, which re-fetches the session WITH the secret key and only marks the
 * order paid when Stripe itself says payment_status === 'paid' AND the metadata token matches.
 */

exports.metadata = {
    name: 'Online Store',
    version: '1.0.0',
    description: 'Catálogo de productos + carrito + checkout con cupones, pedidos y Stripe opcional.',
    author: 'WordJS',
};

const OPT_CONFIG = 'online_store_config';
const ORDER_STATUSES = ['new', 'processing', 'shipped', 'completed', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid', 'cancelled'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-z0-9]{32}$/;

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail, site } = wordjs;

    // Per-plugin table namespace enforced by the host: 'online-store' -> 'wjp_online_store_'.
    const P = db.tablePrefix;
    const T = {
        products: P + 'products',
        orders: P + 'orders',
        coupons: P + 'coupons',
        settings: P + 'settings',
    };

    // ---- schema (idempotent, final from day 1 — no ALTER available in the sandbox) --------------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.products} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT UNIQUE,
            description TEXT DEFAULT '',
            price_cents INTEGER NOT NULL DEFAULT 0,
            image_url TEXT DEFAULT '',
            category TEXT DEFAULT '',
            stock INTEGER DEFAULT -1,
            is_published INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.orders} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL,
            customer_name TEXT NOT NULL,
            customer_email TEXT NOT NULL,
            customer_phone TEXT DEFAULT '',
            customer_address TEXT DEFAULT '',
            items TEXT NOT NULL,
            subtotal_cents INTEGER DEFAULT 0,
            shipping_cents INTEGER DEFAULT 0,
            discount_cents INTEGER DEFAULT 0,
            total_cents INTEGER DEFAULT 0,
            coupon_code TEXT DEFAULT '',
            payment_method TEXT DEFAULT 'manual',
            payment_status TEXT DEFAULT 'pending',
            stripe_session_id TEXT DEFAULT '',
            status TEXT DEFAULT 'new',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.coupons} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            type TEXT DEFAULT 'percent',
            value INTEGER DEFAULT 0,
            min_total_cents INTEGER DEFAULT 0,
            max_uses INTEGER DEFAULT -1,
            used_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.settings} (name TEXT PRIMARY KEY, value TEXT)`);
        // Helpful indexes — index names must also carry the plugin prefix.
        const createIndex = async (name, table, cols) => {
            try { await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`); } catch (e) { /* already exists / unsupported */ }
        };
        await createIndex(`${P}idx_orders_token`, T.orders, 'token');
        await createIndex(`${P}idx_orders_status`, T.orders, 'status');
        await createIndex(`${P}idx_products_published`, T.products, 'is_published');
    }
    await initSchema();

    // ---- plugin-private settings (Stripe secret key — write-only) -------------------------------
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // NOTE: `ON CONFLICT ... DO UPDATE SET` trips the host SQL guard (it reads the token after
    // `UPDATE` as a table name -> "table 'set' is not owned by this plugin"), so the upsert is a
    // guard-safe UPDATE-then-INSERT. Admin-only path, not race-sensitive.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // ---- store configuration (non-secret — lives in options) ------------------------------------
    const DEFAULT_INSTRUCTIONS = 'Transferencia bancaria: escríbenos para recibir los datos de la cuenta. Tu pedido se procesa al confirmar el pago.';
    const getConfig = async () => {
        const raw = (await options.get(OPT_CONFIG, null)) || {};
        const shipping = Number(raw.shippingCents);
        return {
            currencySymbol: (typeof raw.currencySymbol === 'string' && raw.currencySymbol) ? raw.currencySymbol.slice(0, 8) : '$',
            currencyCode: (typeof raw.currencyCode === 'string' && /^[a-zA-Z]{3}$/.test(raw.currencyCode)) ? raw.currencyCode.toLowerCase() : 'usd',
            shippingCents: (Number.isInteger(shipping) && shipping >= 0 && shipping <= 100000000) ? shipping : 0,
            manualPaymentInstructions: (typeof raw.manualPaymentInstructions === 'string' && raw.manualPaymentInstructions.trim())
                ? raw.manualPaymentInstructions.slice(0, 2000) : DEFAULT_INSTRUCTIONS,
            storeEmail: (typeof raw.storeEmail === 'string') ? raw.storeEmail.trim().slice(0, 200) : '',
        };
    };

    // ---- helpers ---------------------------------------------------------------------------------
    /** Random 32-char token. No crypto API exists in the sandbox; the token is 165+ bits of
     *  Math.random keyspace and every public lookup that uses it is rate-limited. */
    const genToken = () => {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let t = '';
        for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
        return t;
    };

    const slugify = (s) => {
        // NFD-decompose then drop combining diacritics (code points 768..879 = U+0300..U+036F),
        // written with code-point checks to keep this file ASCII-only.
        const decomposed = String(s || '').toLowerCase().normalize('NFD');
        let clean = '';
        for (const ch of decomposed) {
            const cp = ch.codePointAt(0);
            if (cp < 768 || cp > 879) clean += ch;
        }
        const base = clean.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        return base || 'producto';
    };
    const uniqueSlug = async (base, excludeId) => {
        let candidate = base;
        for (let i = 2; i < 200; i++) {
            const row = excludeId
                ? await db.get(`SELECT id FROM ${T.products} WHERE slug = ? AND id != ?`, [candidate, excludeId])
                : await db.get(`SELECT id FROM ${T.products} WHERE slug = ?`, [candidate]);
            if (!row) return candidate;
            candidate = `${base}-${i}`;
        }
        return `${base}-${genToken().slice(0, 6)}`;
    };

    const clampInt = (v, dflt, min, max) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n)) return dflt;
        return Math.max(min, Math.min(max, n));
    };

    const maskEmail = (e) => {
        const s = String(e || '');
        const at = s.indexOf('@');
        if (at < 1) return '***';
        return s.charAt(0) + '***' + s.slice(at);
    };

    const parseItems = (json) => {
        try {
            const arr = JSON.parse(json || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    };

    /** Discount in cents for a coupon row against a subtotal (never exceeds the subtotal). */
    const computeDiscount = (coupon, subtotalCents) => {
        const value = Number(coupon.value) || 0;
        let d = coupon.type === 'percent' ? Math.floor(subtotalCents * value / 100) : value;
        return Math.max(0, Math.min(d, subtotalCents));
    };

    // In-memory rolling-window rate limiter (single child process; there is no req.ip in the
    // sandbox, so public write endpoints are capped globally per resource).
    const rateBuckets = new Map(); // bucket name -> timestamps[]
    const rateLimited = (name, max, windowMs) => {
        const now = Date.now();
        const arr = (rateBuckets.get(name) || []).filter((t) => now - t < windowMs);
        if (arr.length >= max) { rateBuckets.set(name, arr); return true; }
        arr.push(now);
        rateBuckets.set(name, arr);
        return false;
    };

    const fmtMoney = (cents, symbol) => `${symbol}${((Number(cents) || 0) / 100).toFixed(2)}`;

    /** Best-effort order emails — the order exists no matter what happens here. */
    const sendOrderEmails = async (order, cfg) => {
        const items = parseItems(order.items);
        const lines = items.map((i) => `- ${i.name} x${i.qty} — ${fmtMoney(i.price_cents * i.qty, cfg.currencySymbol)}`).join('\n');
        const totals = `Subtotal: ${fmtMoney(order.subtotal_cents, cfg.currencySymbol)}\n`
            + (order.discount_cents > 0 ? `Descuento: -${fmtMoney(order.discount_cents, cfg.currencySymbol)}\n` : '')
            + (order.shipping_cents > 0 ? `Envío: ${fmtMoney(order.shipping_cents, cfg.currencySymbol)}\n` : '')
            + `Total: ${fmtMoney(order.total_cents, cfg.currencySymbol)}`;
        try {
            await mail({
                to: order.customer_email,
                subject: `Pedido recibido — #${order.id}`,
                text: `Hola ${order.customer_name},\n\nRecibimos tu pedido #${order.id}.\n\n${lines}\n\n${totals}\n\n`
                    + (order.payment_method === 'manual' ? `Pago: ${cfg.manualPaymentInstructions}\n\n` : '')
                    + `Código de seguimiento: ${order.token}\n\nGracias por tu compra.`,
            });
        } catch (e) { console.warn('[online-store] correo al cliente no enviado:', e.message); }
        try {
            if (cfg.storeEmail && EMAIL_RE.test(cfg.storeEmail)) {
                await mail({
                    to: cfg.storeEmail,
                    subject: `Nuevo pedido #${order.id} — ${fmtMoney(order.total_cents, cfg.currencySymbol)}`,
                    text: `Nuevo pedido de ${order.customer_name} (${order.customer_email}).\n\n${lines}\n\n${totals}\n\nMétodo: ${order.payment_method}.`,
                });
            }
        } catch (e) { console.warn('[online-store] correo a la tienda no enviado:', e.message); }
    };

    const publicProduct = (p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description || '',
        price_cents: p.price_cents,
        image_url: p.image_url || '',
        category: p.category || '',
        stock: p.stock,
    });

    const adminOrder = (o) => ({ ...o, items: parseItems(o.items) });

    // ================================ PUBLIC ROUTES ================================

    // Catalog — the Puck block calls this from the editor iframe AND the public page.
    http.route('get', '/public/products', async (req, res) => {
        const q = req.query || {};
        const category = String(q.category || '').trim().slice(0, 100);
        const search = String(q.search || '').trim().toLowerCase().slice(0, 100);
        const limit = clampInt(q.limit, 60, 1, 200);
        const params = [];
        let where = 'WHERE is_published = 1';
        if (category) { where += ' AND category = ?'; params.push(category); }
        let rows = await db.all(`SELECT * FROM ${T.products} ${where} ORDER BY sort_order ASC, name ASC`, params);
        if (search) {
            rows = rows.filter((p) => `${p.name} ${p.description || ''} ${p.category || ''}`.toLowerCase().includes(search));
        }
        res.json({ products: rows.slice(0, limit).map(publicProduct), total: rows.length });
    });

    http.route('get', '/public/product', async (req, res) => {
        const slug = String((req.query && req.query.slug) || '').trim().slice(0, 120);
        if (!slug) return res.status(400).json({ error: 'Falta el parámetro slug.' });
        const row = await db.get(`SELECT * FROM ${T.products} WHERE slug = ? AND is_published = 1`, [slug]);
        if (!row) return res.status(404).json({ error: 'Producto no encontrado.' });
        res.json({ product: publicProduct(row) });
    });

    // Non-secret store config the block needs to render (currency, shipping, manual instructions,
    // whether the Stripe option should be offered — only a boolean, never the key).
    http.route('get', '/public/store-config', async (req, res) => {
        const cfg = await getConfig();
        const hasKey = !!(await getSetting('stripe_sk'));
        res.json({
            currencySymbol: cfg.currencySymbol,
            currencyCode: cfg.currencyCode,
            shippingCents: cfg.shippingCents,
            manualPaymentInstructions: cfg.manualPaymentInstructions,
            stripeEnabled: hasKey,
        });
    });

    // Coupon preview for the cart drawer. Does NOT consume a use — checkout does that atomically.
    http.route('post', '/public/validate-coupon', async (req, res) => {
        if (rateLimited('validate-coupon', 30, 60 * 1000)) {
            return res.status(429).json({ valid: false, discount_cents: 0, message: 'Demasiadas solicitudes, intenta en un minuto.' });
        }
        const body = req.body || {};
        const code = String(body.code || '').trim().toUpperCase().slice(0, 50);
        const subtotal = clampInt(body.subtotal_cents, 0, 0, 1000000000);
        if (!code) return res.json({ valid: false, discount_cents: 0, message: 'Ingresa un código de cupón.' });
        const c = await db.get(`SELECT * FROM ${T.coupons} WHERE code = ? AND is_active = 1`, [code]);
        if (!c) return res.json({ valid: false, discount_cents: 0, message: 'Cupón no válido.' });
        if (c.max_uses >= 0 && c.used_count >= c.max_uses) {
            return res.json({ valid: false, discount_cents: 0, message: 'Este cupón ya se agotó.' });
        }
        const cfg = await getConfig();
        if (subtotal < (c.min_total_cents || 0)) {
            return res.json({
                valid: false, discount_cents: 0,
                message: `Este cupón requiere una compra mínima de ${fmtMoney(c.min_total_cents, cfg.currencySymbol)}.`,
            });
        }
        const discount = computeDiscount(c, subtotal);
        return res.json({
            valid: true, discount_cents: discount,
            message: c.type === 'percent' ? `Cupón aplicado: ${c.value}% de descuento.` : `Cupón aplicado: ${fmtMoney(discount, cfg.currencySymbol)} de descuento.`,
        });
    });

    // Checkout — the only prices trusted are the ones re-read from the DB right here.
    http.route('post', '/public/checkout', async (req, res) => {
        if (rateLimited('checkout', 10, 60 * 1000)) {
            return res.status(429).json({ error: 'Demasiados pedidos en este momento. Intenta de nuevo en un minuto.' });
        }
        const body = req.body || {};
        const customer = body.customer || {};
        const name = String(customer.name || '').trim().slice(0, 200);
        const email = String(customer.email || '').trim().slice(0, 200);
        const phone = String(customer.phone || '').trim().slice(0, 50);
        const address = String(customer.address || '').trim().slice(0, 500);
        if (!name) return res.status(400).json({ error: 'El nombre es obligatorio.' });
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Correo electrónico no válido.' });

        const rawItems = Array.isArray(body.items) ? body.items : [];
        if (rawItems.length < 1) return res.status(400).json({ error: 'El carrito está vacío.' });
        if (rawItems.length > 50) return res.status(400).json({ error: 'Demasiados artículos distintos en el carrito (máximo 50).' });

        // Validate + merge duplicate lines (qty stays within 1..99 per product).
        const qtyById = new Map();
        for (const it of rawItems) {
            const pid = Number(it && it.product_id);
            const qty = Number(it && it.qty);
            if (!Number.isInteger(pid) || pid < 1) return res.status(400).json({ error: 'Artículo no válido en el carrito.' });
            if (!Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Cantidad no válida (debe ser un entero entre 1 y 99).' });
            qtyById.set(pid, Math.min(99, (qtyById.get(pid) || 0) + qty));
        }

        // Re-read every product from the DB — price + availability come from HERE, never the client.
        const lines = [];
        for (const [pid, qty] of qtyById) {
            const p = await db.get(`SELECT * FROM ${T.products} WHERE id = ? AND is_published = 1`, [pid]);
            if (!p) return res.status(400).json({ error: 'Uno de los productos del carrito ya no está disponible.' });
            lines.push({ product: p, qty });
        }

        // Single-statement conditional stock decrement per line; on any failure, restore what was
        // already decremented (only limited-stock rows were touched).
        const decremented = [];
        const restoreStock = async () => {
            for (const d of decremented) {
                try { await db.run(`UPDATE ${T.products} SET stock = stock + ? WHERE id = ? AND stock >= 0`, [d.qty, d.id]); }
                catch (e) { console.warn('[online-store] no se pudo restaurar stock:', e.message); }
            }
        };
        for (const line of lines) {
            if (line.product.stock < 0) continue; // -1 = unlimited
            const r = await db.run(
                `UPDATE ${T.products} SET stock = stock - ? WHERE id = ? AND stock >= ?`,
                [line.qty, line.product.id, line.qty]
            );
            if (!r || r.changes !== 1) {
                await restoreStock();
                return res.status(409).json({ error: `Sin stock: ${line.product.name}` });
            }
            decremented.push({ id: line.product.id, qty: line.qty });
        }

        const subtotal = lines.reduce((s, l) => s + (l.product.price_cents * l.qty), 0);

        // Everything from coupon consumption through the order INSERT is guarded: if any of it
        // throws (DB hiccup, options failure), undo the stock decrement AND the coupon use so
        // neither leaks on a 500 with no order row behind it.
        let discount = 0;
        let couponCode = String(body.coupon_code || '').trim().toUpperCase().slice(0, 50);
        let couponConsumed = false;
        const restoreCoupon = async () => {
            if (!couponConsumed) return;
            try { await db.run(`UPDATE ${T.coupons} SET used_count = used_count - 1 WHERE code = ? AND used_count > 0`, [couponCode]); }
            catch (e) { console.warn('[online-store] no se pudo restaurar el cupón:', e.message); }
        };
        let cfg, shipping, total, stripeKey, method, token, itemsJson, orderId;
        try {
            // Coupon: validate then CONSUME in one conditional statement (used_count guard beats races).
            if (couponCode) {
                const c = await db.get(`SELECT * FROM ${T.coupons} WHERE code = ? AND is_active = 1`, [couponCode]);
                if (!c) { await restoreStock(); return res.status(400).json({ error: 'Cupón no válido.' }); }
                if (subtotal < (c.min_total_cents || 0)) {
                    await restoreStock();
                    return res.status(400).json({ error: 'El pedido no alcanza el mínimo requerido por el cupón.' });
                }
                const consumed = await db.run(
                    `UPDATE ${T.coupons} SET used_count = used_count + 1
                     WHERE code = ? AND is_active = 1 AND (max_uses < 0 OR used_count < max_uses)`,
                    [couponCode]
                );
                if (!consumed || consumed.changes !== 1) {
                    await restoreStock();
                    return res.status(400).json({ error: 'Este cupón ya se agotó.' });
                }
                couponConsumed = true;
                discount = computeDiscount(c, subtotal);
            }

            cfg = await getConfig();
            shipping = cfg.shippingCents;
            total = Math.max(0, subtotal - discount) + shipping;

            stripeKey = await getSetting('stripe_sk');
            const wantsStripe = String(body.payment_method || 'manual') === 'stripe';
            method = (wantsStripe && stripeKey) ? 'stripe' : 'manual';

            token = genToken();
            itemsJson = JSON.stringify(lines.map((l) => ({
                product_id: l.product.id, name: l.product.name, price_cents: l.product.price_cents, qty: l.qty,
            })));
            const ins = await db.run(
                `INSERT INTO ${T.orders}
                    (token, customer_name, customer_email, customer_phone, customer_address, items,
                     subtotal_cents, shipping_cents, discount_cents, total_cents, coupon_code,
                     payment_method, payment_status, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'new')`,
                [token, name, email, phone, address, itemsJson, subtotal, shipping, discount, total, couponCode, method]
            );
            orderId = ins && ins.lastID;
        } catch (e) {
            await restoreStock();
            await restoreCoupon();
            console.warn('[online-store] fallo al registrar el pedido:', e.message);
            return res.status(500).json({ error: 'No se pudo registrar el pedido. Intenta de nuevo en un momento.' });
        }
        const orderForMail = {
            id: orderId, token, customer_name: name, customer_email: email, items: itemsJson,
            subtotal_cents: subtotal, shipping_cents: shipping, discount_cents: discount,
            total_cents: total, payment_method: method,
        };

        if (method === 'stripe') {
            try {
                let pageUrl = String(body.page_url || '').trim().slice(0, 1000);
                if (!/^https?:\/\//i.test(pageUrl)) pageUrl = await site.url();
                const sep = pageUrl.includes('?') ? '&' : '?';
                const form = new URLSearchParams();
                form.set('mode', 'payment');
                form.set('line_items[0][price_data][currency]', cfg.currencyCode);
                form.set('line_items[0][price_data][product_data][name]', `Pedido #${orderId}`);
                form.set('line_items[0][price_data][unit_amount]', String(total));
                form.set('line_items[0][quantity]', '1');
                form.set('success_url', `${pageUrl}${sep}session_id={CHECKOUT_SESSION_ID}&order=${token}`);
                form.set('cancel_url', pageUrl);
                form.set('metadata[order_token]', token);
                form.set('customer_email', email);
                const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer ' + stripeKey,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: form.toString(),
                });
                const session = await resp.json().catch(() => ({}));
                if (!resp.ok || !session.url) {
                    const msg = (session && session.error && session.error.message) ? session.error.message : `HTTP ${resp.status}`;
                    throw new Error(msg);
                }
                await db.run(`UPDATE ${T.orders} SET stripe_session_id = ? WHERE id = ?`, [String(session.id || ''), orderId]);
                await sendOrderEmails(orderForMail, cfg);
                return res.json({ success: true, token, checkoutUrl: session.url });
            } catch (e) {
                // Stripe failed — keep the order alive as a manual-payment order.
                try { await db.run(`UPDATE ${T.orders} SET payment_method = 'manual' WHERE id = ?`, [orderId]); } catch (e2) { /* keep going */ }
                orderForMail.payment_method = 'manual';
                await sendOrderEmails(orderForMail, cfg);
                return res.json({
                    success: true, token,
                    manualInstructions: cfg.manualPaymentInstructions,
                    warning: `No se pudo iniciar el pago con tarjeta (${e.message || e}). Tu pedido quedó registrado con pago manual.`,
                });
            }
        }

        await sendOrderEmails(orderForMail, cfg);
        return res.json({ success: true, token, manualInstructions: cfg.manualPaymentInstructions });
    });

    // Public order status by random token (never sequential ids).
    http.route('get', '/public/order', async (req, res) => {
        if (rateLimited('order-lookup', 60, 60 * 1000)) {
            return res.status(429).json({ error: 'Demasiadas consultas, intenta en un minuto.' });
        }
        const token = String((req.query && req.query.token) || '').trim();
        if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código de pedido no válido.' });
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
        if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
        res.json({
            order: {
                orderNumber: o.id,
                created_at: o.created_at,
                customer_name: o.customer_name,
                maskedEmail: maskEmail(o.customer_email),
                items: parseItems(o.items),
                subtotal_cents: o.subtotal_cents,
                shipping_cents: o.shipping_cents,
                discount_cents: o.discount_cents,
                total_cents: o.total_cents,
                coupon_code: o.coupon_code || '',
                payment_method: o.payment_method,
                payment_status: o.payment_status,
                status: o.status,
            },
        });
    });

    // Stripe return leg: verify the session AGAINST STRIPE with the secret key (no webhooks —
    // signatures can't be verified in the sandbox). Idempotent.
    http.route('get', '/public/confirm-stripe', async (req, res) => {
        if (rateLimited('confirm-stripe', 30, 60 * 1000)) {
            return res.status(429).json({ paid: false, error: 'Demasiadas solicitudes, intenta en un minuto.' });
        }
        const q = req.query || {};
        const token = String(q.token || '').trim();
        const sessionId = String(q.session_id || '').trim().slice(0, 255);
        if (!TOKEN_RE.test(token) || !sessionId) return res.status(400).json({ paid: false, error: 'Parámetros no válidos.' });
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
        if (!o) return res.status(404).json({ paid: false, error: 'Pedido no encontrado.' });
        if (o.payment_status === 'paid') return res.json({ paid: true }); // idempotent
        if (o.payment_method !== 'stripe' || !o.stripe_session_id || o.stripe_session_id !== sessionId) {
            return res.json({ paid: false });
        }
        const key = await getSetting('stripe_sk');
        if (!key) return res.json({ paid: false, error: 'Stripe no está configurado.' });
        try {
            const resp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
                headers: { Authorization: 'Bearer ' + key },
            });
            const session = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                const msg = (session && session.error && session.error.message) ? session.error.message : `HTTP ${resp.status}`;
                throw new Error(msg);
            }
            const metaToken = session && session.metadata && session.metadata.order_token;
            if (metaToken === token && session.payment_status === 'paid') {
                await db.run(`UPDATE ${T.orders} SET payment_status = 'paid' WHERE token = ? AND payment_status != 'cancelled'`, [token]);
                return res.json({ paid: true });
            }
            return res.json({ paid: false });
        } catch (e) {
            return res.status(502).json({ paid: false, error: `No se pudo verificar el pago con Stripe: ${e.message || e}` });
        }
    });

    // ================================ ADMIN ROUTES ================================

    // ---- products CRUD ----
    http.route('get', '/products', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.products} ORDER BY sort_order ASC, id DESC`);
        res.json({ products: rows });
    });

    http.route('post', '/products', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const name = String(body.name || '').trim().slice(0, 200);
        if (!name) return res.status(400).json({ error: 'El nombre es obligatorio.' });
        const price = Number(body.price_cents);
        if (!Number.isInteger(price) || price < 0 || price > 1000000000) {
            return res.status(400).json({ error: 'Precio no válido.' });
        }
        const description = String(body.description || '').slice(0, 5000);
        const imageUrl = String(body.image_url || '').trim().slice(0, 1000);
        const category = String(body.category || '').trim().slice(0, 100);
        let stock = Number(body.stock);
        if (!Number.isInteger(stock) || stock < -1 || stock > 1000000000) stock = -1;
        const isPublished = body.is_published ? 1 : 0;
        const rawSort = Number(body.sort_order);
        const sortValid = Number.isInteger(rawSort) && Math.abs(rawSort) <= 1000000;

        const id = Number(body.id);
        if (Number.isInteger(id) && id > 0) {
            const existing = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Producto no encontrado.' });
            // Preserve sort_order when the field is absent/invalid (the admin form doesn't send
            // it), instead of silently resetting API-set values to 0 on every edit.
            const sortOrder = sortValid ? rawSort : (Number(existing.sort_order) || 0);
            await db.run(
                `UPDATE ${T.products} SET name = ?, description = ?, price_cents = ?, image_url = ?, category = ?, stock = ?, is_published = ?, sort_order = ? WHERE id = ?`,
                [name, description, price, imageUrl, category, stock, isPublished, sortOrder, id]
            );
            const row = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [id]);
            return res.json({ product: row });
        }
        const slug = await uniqueSlug(slugify(name));
        const ins = await db.run(
            `INSERT INTO ${T.products} (name, slug, description, price_cents, image_url, category, stock, is_published, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, slug, description, price, imageUrl, category, stock, isPublished, sortValid ? rawSort : 0]
        );
        const row = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [ins.lastID]);
        res.json({ product: row });
    });

    http.route('delete', '/products/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.products} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- coupons CRUD ----
    http.route('get', '/coupons', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.coupons} ORDER BY id DESC`);
        res.json({ coupons: rows });
    });

    http.route('post', '/coupons', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const code = String(body.code || '').trim().toUpperCase().slice(0, 50);
        if (!/^[A-Z0-9_-]{2,50}$/.test(code)) {
            return res.status(400).json({ error: 'Código no válido: usa 2–50 letras, números o guiones.' });
        }
        const type = body.type === 'fixed' ? 'fixed' : (body.type === 'percent' ? 'percent' : '');
        if (!type) return res.status(400).json({ error: 'Tipo de cupón no válido (percent | fixed).' });
        const value = Number(body.value);
        if (type === 'percent' && (!Number.isInteger(value) || value < 1 || value > 100)) {
            return res.status(400).json({ error: 'Un cupón de porcentaje requiere un valor entero entre 1 y 100.' });
        }
        if (type === 'fixed' && (!Number.isInteger(value) || value < 1 || value > 1000000000)) {
            return res.status(400).json({ error: 'Un cupón de monto fijo requiere un valor en centavos mayor a 0.' });
        }
        let minTotal = Number(body.min_total_cents);
        if (!Number.isInteger(minTotal) || minTotal < 0 || minTotal > 1000000000) minTotal = 0;
        let maxUses = Number(body.max_uses);
        if (!Number.isInteger(maxUses) || maxUses < -1 || maxUses > 1000000000) maxUses = -1;
        const isActive = body.is_active ? 1 : 0;

        const id = Number(body.id);
        const dup = (Number.isInteger(id) && id > 0)
            ? await db.get(`SELECT id FROM ${T.coupons} WHERE code = ? AND id != ?`, [code, id])
            : await db.get(`SELECT id FROM ${T.coupons} WHERE code = ?`, [code]);
        if (dup) return res.status(400).json({ error: 'Ya existe un cupón con ese código.' });

        if (Number.isInteger(id) && id > 0) {
            const existing = await db.get(`SELECT id FROM ${T.coupons} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Cupón no encontrado.' });
            await db.run(
                `UPDATE ${T.coupons} SET code = ?, type = ?, value = ?, min_total_cents = ?, max_uses = ?, is_active = ? WHERE id = ?`,
                [code, type, value, minTotal, maxUses, isActive, id]
            );
            const row = await db.get(`SELECT * FROM ${T.coupons} WHERE id = ?`, [id]);
            return res.json({ coupon: row });
        }
        const ins = await db.run(
            `INSERT INTO ${T.coupons} (code, type, value, min_total_cents, max_uses, used_count, is_active)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
            [code, type, value, minTotal, maxUses, isActive]
        );
        const row = await db.get(`SELECT * FROM ${T.coupons} WHERE id = ?`, [ins.lastID]);
        res.json({ coupon: row });
    });

    http.route('delete', '/coupons/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.coupons} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- orders ----
    http.route('get', '/orders', { auth: true, admin: true }, async (req, res) => {
        const q = req.query || {};
        const status = String(q.status || '').trim();
        const search = String(q.search || '').trim().slice(0, 100);
        const limit = clampInt(q.limit, 50, 1, 200);
        const offset = clampInt(q.offset, 0, 0, 1000000000);
        const where = [];
        const params = [];
        if (status && ORDER_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
        if (search) {
            where.push('(customer_name LIKE ? OR customer_email LIKE ? OR token LIKE ?)');
            const like = `%${search}%`;
            params.push(like, like, like);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = await db.all(
            `SELECT * FROM ${T.orders} ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const totalRow = await db.get(`SELECT COUNT(*) AS n FROM ${T.orders} ${whereSql}`, params);
        const countRows = await db.all(`SELECT status, COUNT(*) AS n FROM ${T.orders} GROUP BY status`);
        const counts = {};
        for (const r of countRows) counts[r.status] = r.n;
        res.json({ orders: rows.map(adminOrder), total: (totalRow && totalRow.n) || 0, counts });
    });

    // CSV export must come BEFORE /orders/:id so 'export' isn't captured as an :id param.
    http.route('get', '/orders/export', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.orders} ORDER BY id DESC`);
        const esc = (v) => {
            let s = String(v == null ? '' : v);
            // Neutralize CSV formula injection: Excel/LibreOffice execute cells starting with
            // = + - @ (or tab/CR) as formulas — prefix a quote so they render as text.
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const money = (c) => ((Number(c) || 0) / 100).toFixed(2);
        const header = 'id,token,fecha,cliente,email,telefono,direccion,articulos,subtotal,envio,descuento,total,cupon,metodo_pago,estado_pago,estado,notas';
        const csvRows = rows.map((o) => {
            const items = parseItems(o.items).map((i) => `${i.name} x${i.qty}`).join(' | ');
            return [
                o.id, o.token, o.created_at, o.customer_name, o.customer_email, o.customer_phone || '',
                o.customer_address || '', items, money(o.subtotal_cents), money(o.shipping_cents),
                money(o.discount_cents), money(o.total_cents), o.coupon_code || '', o.payment_method,
                o.payment_status, o.status, o.notes || '',
            ].map(esc).join(',');
        });
        // res.send(string) gets JSON-encoded by the isolate — ship the CSV inside JSON and let the
        // admin page build the Blob download client-side.
        res.json({ csv: [header, ...csvRows].join('\n'), filename: `pedidos-${new Date().toISOString().slice(0, 10)}.csv` });
    });

    http.route('get', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
        res.json({ order: adminOrder(o) });
    });

    http.route('post', '/orders/:id/status', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        const status = String((req.body && req.body.status) || '');
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido.' });
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
        // WooCommerce parity: on the transition INTO 'cancelled' (and only from a non-cancelled
        // state, so it runs once), return each limited-stock line to inventory and release the
        // coupon use consumed at checkout.
        if (status === 'cancelled' && o.status !== 'cancelled') {
            for (const it of parseItems(o.items)) {
                const pid = Number(it && it.product_id);
                const qty = Number(it && it.qty);
                if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(qty) || qty < 1) continue;
                try { await db.run(`UPDATE ${T.products} SET stock = stock + ? WHERE id = ? AND stock >= 0`, [qty, pid]); }
                catch (e) { console.warn('[online-store] no se pudo restaurar stock al cancelar:', e.message); }
            }
            if (o.coupon_code) {
                try { await db.run(`UPDATE ${T.coupons} SET used_count = used_count - 1 WHERE code = ? AND used_count > 0`, [o.coupon_code]); }
                catch (e) { console.warn('[online-store] no se pudo restaurar el cupón al cancelar:', e.message); }
            }
        }
        await db.run(`UPDATE ${T.orders} SET status = ? WHERE id = ?`, [status, id]);
        const row = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        res.json({ success: true, order: adminOrder(row) });
    });

    http.route('post', '/orders/:id/payment', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        const paymentStatus = String((req.body && req.body.payment_status) || '');
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        if (!PAYMENT_STATUSES.includes(paymentStatus)) return res.status(400).json({ error: 'Estado de pago no válido.' });
        const before = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        if (!before) return res.status(404).json({ error: 'Pedido no encontrado.' });
        await db.run(`UPDATE ${T.orders} SET payment_status = ? WHERE id = ?`, [paymentStatus, id]);
        const row = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        // Best-effort payment receipt when transitioning into 'paid'.
        if (paymentStatus === 'paid' && before.payment_status !== 'paid') {
            try {
                const cfg = await getConfig();
                await mail({
                    to: row.customer_email,
                    subject: `Pago recibido — Pedido #${row.id}`,
                    text: `Hola ${row.customer_name},\n\nConfirmamos el pago de tu pedido #${row.id} por ${fmtMoney(row.total_cents, cfg.currencySymbol)}.\n\nCódigo de seguimiento: ${row.token}\n\nGracias por tu compra.`,
                });
            } catch (e) { console.warn('[online-store] recibo de pago no enviado:', e.message); }
        }
        res.json({ success: true, order: adminOrder(row) });
    });

    http.route('delete', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.orders} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- configuration ----
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        res.json(await getConfig());
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const current = await getConfig();
        const next = { ...current };
        if (typeof body.currencySymbol === 'string' && body.currencySymbol.trim()) {
            next.currencySymbol = body.currencySymbol.trim().slice(0, 8);
        }
        if (typeof body.currencyCode === 'string' && /^[a-zA-Z]{3}$/.test(body.currencyCode.trim())) {
            next.currencyCode = body.currencyCode.trim().toLowerCase();
        }
        const shipping = Number(body.shippingCents);
        if (Number.isInteger(shipping) && shipping >= 0 && shipping <= 100000000) next.shippingCents = shipping;
        if (typeof body.manualPaymentInstructions === 'string') {
            next.manualPaymentInstructions = body.manualPaymentInstructions.slice(0, 2000);
        }
        if (typeof body.storeEmail === 'string') {
            const se = body.storeEmail.trim().slice(0, 200);
            if (se === '' || EMAIL_RE.test(se)) next.storeEmail = se;
            else return res.status(400).json({ error: 'El correo de la tienda no es válido.' });
        }
        await options.set(OPT_CONFIG, next);
        res.json(await getConfig());
    });

    // Stripe key: write-only. '' clears, a value replaces, absent keeps. Never echoed back.
    http.route('get', '/stripe-status', { auth: true, admin: true }, async (req, res) => {
        res.json({ hasKey: !!(await getSetting('stripe_sk')) });
    });

    http.route('post', '/stripe-key', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        if (typeof body.key === 'string') await setSetting('stripe_sk', body.key.trim());
        res.json({ hasKey: !!(await getSetting('stripe_sk')) });
    });

    adminMenu.add({
        href: '/admin/plugin/store',
        label: 'Tienda Online',
        icon: 'fa-cart-shopping',
        order: 69,
        cap: 'manage_options',
    });

    console.log('[online-store] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down; the in-memory rate buckets die with the child process.
};
