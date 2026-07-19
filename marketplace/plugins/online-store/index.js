/**
 * WordJS Plugin: Online Store v2 ("tienda completa")
 *
 * v1 scope (kept intact): product catalog + client cart + checkout with SERVER-SIDE price
 * validation + coupons + orders admin + optional Stripe Checkout + manual payment.
 *
 * v2 adds: product variants with per-variant SKU/price/stock (atomic decrement), multi-image
 * galleries, shipping zones + store pickup, simple taxes (basis points, applied to goods after
 * discount — never to shipping), customer order history for logged-in accounts (strong user_id
 * link captured at checkout — never email matching), transactional emails (received / receipt /
 * shipped / cancelled / refunded), refunds (partial or full, with a real Stripe refund call),
 * catalog search/sort/categories, sales reports + CSV, and Stripe webhooks.
 *
 * Money rules: ALL amounts are INTEGER CENTS end to end. Tax rates are INTEGER BASIS POINTS
 * (1600 = 16.00%). Clients only ever send ids + quantities + a shipping method choice; the server
 * re-reads prices/rates from the DB and recomputes every total itself.
 *
 * Race safety: the sandbox db bridge exposes NO transactions, so every race-sensitive mutation is
 * a SINGLE conditional statement — stock decrement `SET stock = stock - ? WHERE stock >= ?` (on
 * the variant row when the product has variants, else on the product row), coupon consumption
 * `SET used_count = used_count + 1 WHERE used_count < max_uses`, the pending->paid flip
 * `SET payment_status = 'paid' WHERE payment_status = 'pending'` (its result.changes gates the
 * receipt email so it is sent exactly once), and the refund accumulator
 * `SET refund_cents = refund_cents + ? WHERE refund_cents + ? <= total_cents`.
 *
 * Schema migrations: the sandbox allows CREATE TABLE IF NOT EXISTS and ALTER TABLE ADD COLUMN on
 * the plugin's own tables. v1 -> v2 adds columns to `orders` via probe-then-ALTER (each ALTER in
 * its own try/catch — idempotent across SQLite/MySQL/Postgres, which all error on a duplicate
 * column with otherwise-fine semantics).
 *
 * Stripe webhooks (the sandbox exposes neither the raw request body nor an HMAC primitive, so
 * `Stripe-Signature` CANNOT be verified): the webhook body is treated as an UNTRUSTED HINT only.
 * No state ever changes from event fields — the handler extracts a session/payment_intent id,
 * re-fetches the Checkout Session from api.stripe.com WITH the secret key, and only marks the
 * order paid when Stripe itself says payment_status === 'paid' AND the metadata token matches
 * AND the stored session id matches. A forged webhook is a no-op. A 5-minute reconciler sweeps
 * recent pending Stripe orders through the same verify path, so payments confirm even when the
 * customer never returns AND no webhook is configured.
 *
 * Secrets: the Stripe secret key lives in the plugin's OWN wjp_ settings table (write-only from
 * the admin: absent = keep, '' = clear, value = replace; only a hasKey boolean is ever echoed).
 */

exports.metadata = {
    name: 'Online Store',
    version: '2.0.0',
    description: 'Tienda completa: variantes, galerías, zonas de envío, impuestos, reembolsos, informes, webhooks de Stripe y pedidos por cuenta.',
    author: 'WordJS',
};

const OPT_CONFIG = 'online_store_config';
const ORDER_STATUSES = ['new', 'processing', 'shipped', 'completed', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-z0-9]{32}$/;
const STRIPE_SESSION_RE = /^cs_[A-Za-z0-9_]{8,250}$/;
const STRIPE_PI_RE = /^pi_[A-Za-z0-9_]{8,250}$/;
// Stripe zero-decimal currencies take amounts in the WHOLE unit, not the minor unit. Everything in
// this plugin is stored in integer "cents" (minor units × 100); for these currencies the Stripe
// amount must be divided by 100 so a ¥1000 order isn't charged ¥100000.
const STRIPE_ZERO_DECIMAL = new Set([
    'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx',
    'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
const toStripeAmount = (cents, currencyCode) =>
    STRIPE_ZERO_DECIMAL.has(String(currencyCode || '').toLowerCase()) ? Math.round((Number(cents) || 0) / 100) : (Number(cents) || 0);

// Timers created in init(), cleared in deactivate() (module scope so both exports see them).
const activeTimers = [];

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail, site, crypto } = wordjs;

    // Per-plugin table namespace enforced by the host: 'online-store' -> 'wjp_online_store_'.
    const P = db.tablePrefix;
    const T = {
        products: P + 'products',
        orders: P + 'orders',
        coupons: P + 'coupons',
        settings: P + 'settings',
        variants: P + 'variants',
        images: P + 'product_images',
        zones: P + 'shipping_zones',
    };

    // ---- schema (idempotent; v1 tables untouched, v2 adds tables + ALTERs orders) ---------------
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            tax_cents INTEGER DEFAULT 0,
            tax_rate_bp INTEGER DEFAULT 0,
            shipping_method TEXT DEFAULT '',
            shipping_zone_id INTEGER DEFAULT 0,
            shipping_zone_name TEXT DEFAULT '',
            user_id INTEGER DEFAULT 0,
            refund_cents INTEGER DEFAULT 0,
            refund_id TEXT DEFAULT '',
            refunded_at TEXT DEFAULT '',
            stripe_payment_intent TEXT DEFAULT ''
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
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.variants} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sku TEXT DEFAULT '',
            price_cents INTEGER DEFAULT -1,
            stock INTEGER DEFAULT -1,
            sort_order INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.images} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            alt TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.zones} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            rate_cents INTEGER DEFAULT 0,
            free_over_cents INTEGER DEFAULT -1,
            tax_rate_bp INTEGER DEFAULT -1,
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0
        )`);

        // v1 -> v2 orders migration. Installs created before v2 lack the columns above (the
        // CREATE ... IF NOT EXISTS is a no-op there). Probe the LAST column added; when missing,
        // run every ALTER individually — each in its own try/catch so partially-migrated tables
        // (or engines racing) converge without failing the boot.
        let migrated = true;
        try { await db.get(`SELECT stripe_payment_intent FROM ${T.orders} LIMIT 1`); }
        catch (e) { migrated = false; }
        if (!migrated) {
            // Text columns use VARCHAR(255), NOT TEXT: the drivers translate CREATE TABLE column
            // types but pass ALTER through verbatim, and MySQL/MariaDB reject a literal DEFAULT on
            // a TEXT column (< 8.0.13). VARCHAR(255) DEFAULT '' is valid on SQLite, MySQL and
            // Postgres alike, so the v1->v2 upgrade migrates cleanly on every engine.
            const alters = [
                `ALTER TABLE ${T.orders} ADD COLUMN tax_cents INTEGER DEFAULT 0`,
                `ALTER TABLE ${T.orders} ADD COLUMN tax_rate_bp INTEGER DEFAULT 0`,
                `ALTER TABLE ${T.orders} ADD COLUMN shipping_method VARCHAR(255) DEFAULT ''`,
                `ALTER TABLE ${T.orders} ADD COLUMN shipping_zone_id INTEGER DEFAULT 0`,
                `ALTER TABLE ${T.orders} ADD COLUMN shipping_zone_name VARCHAR(255) DEFAULT ''`,
                `ALTER TABLE ${T.orders} ADD COLUMN user_id INTEGER DEFAULT 0`,
                `ALTER TABLE ${T.orders} ADD COLUMN refund_cents INTEGER DEFAULT 0`,
                `ALTER TABLE ${T.orders} ADD COLUMN refund_id VARCHAR(255) DEFAULT ''`,
                `ALTER TABLE ${T.orders} ADD COLUMN refunded_at VARCHAR(255) DEFAULT ''`,
                `ALTER TABLE ${T.orders} ADD COLUMN stripe_payment_intent VARCHAR(255) DEFAULT ''`,
            ];
            for (const sql of alters) {
                try { await db.run(sql); } catch (e) { /* column already exists */ }
            }
            try {
                await db.get(`SELECT stripe_payment_intent FROM ${T.orders} LIMIT 1`);
            } catch (e) {
                console.error('[online-store] MIGRACION v2 INCOMPLETA: la tabla de pedidos no aceptó las columnas nuevas —', e.message);
            }
        }

        // Helpful indexes — index names must also carry the plugin prefix.
        const createIndex = async (name, table, cols) => {
            try { await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`); } catch (e) { /* already exists / unsupported */ }
        };
        await createIndex(`${P}idx_orders_token`, T.orders, 'token');
        await createIndex(`${P}idx_orders_status`, T.orders, 'status');
        await createIndex(`${P}idx_products_published`, T.products, 'is_published');
        await createIndex(`${P}idx_variants_product`, T.variants, 'product_id');
        await createIndex(`${P}idx_images_product`, T.images, 'product_id');
        await createIndex(`${P}idx_orders_user`, T.orders, 'user_id');
    }
    await initSchema();

    // ---- plugin-private settings (Stripe secret key — write-only) -------------------------------
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // Guard-safe upsert per the sandbox cookbook: UPDATE-then-INSERT (never ON CONFLICT — the
    // MySQL driver would need a translation and the cookbook freezes this shape). Admin-only
    // path, not race-sensitive.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // ---- store configuration (non-secret — lives in options) ------------------------------------
    const DEFAULT_INSTRUCTIONS = 'Transferencia bancaria: escríbenos para recibir los datos de la cuenta. Tu pedido se procesa al confirmar el pago.';
    const DEFAULT_PICKUP = 'Te avisaremos por correo cuando tu pedido esté listo para recoger.';
    const getConfig = async () => {
        const raw = (await options.get(OPT_CONFIG, null)) || {};
        const shipping = Number(raw.shippingCents);
        const taxBp = Number(raw.taxRateBp);
        return {
            currencySymbol: (typeof raw.currencySymbol === 'string' && raw.currencySymbol) ? raw.currencySymbol.slice(0, 8) : '$',
            currencyCode: (typeof raw.currencyCode === 'string' && /^[a-zA-Z]{3}$/.test(raw.currencyCode)) ? raw.currencyCode.toLowerCase() : 'usd',
            shippingCents: (Number.isInteger(shipping) && shipping >= 0 && shipping <= 100000000) ? shipping : 0,
            manualPaymentInstructions: (typeof raw.manualPaymentInstructions === 'string' && raw.manualPaymentInstructions.trim())
                ? raw.manualPaymentInstructions.slice(0, 2000) : DEFAULT_INSTRUCTIONS,
            storeEmail: (typeof raw.storeEmail === 'string') ? raw.storeEmail.trim().slice(0, 200) : '',
            pickupEnabled: !!raw.pickupEnabled,
            pickupInstructions: (typeof raw.pickupInstructions === 'string' && raw.pickupInstructions.trim())
                ? raw.pickupInstructions.slice(0, 1000) : DEFAULT_PICKUP,
            taxRateBp: (Number.isInteger(taxBp) && taxBp >= 0 && taxBp <= 5000) ? taxBp : 0,
            taxLabel: (typeof raw.taxLabel === 'string' && raw.taxLabel.trim()) ? raw.taxLabel.trim().slice(0, 50) : 'Impuestos',
        };
    };

    // ---- helpers ---------------------------------------------------------------------------------
    /** Unguessable 32-char token (public order-lookup and Stripe-return keys must not be
     *  predictable — a guessable token is an IDOR into another customer's order/PII). Uses the
     *  host CSPRNG bridge (crypto.randomToken(16) -> 32 lowercase hex chars, matching TOKEN_RE).
     *  NOTE: in the isolated sandbox this bridge is an ASYNC RPC — it MUST be awaited (a bare
     *  synchronous call returns a Promise, not the token). Falls back to Math.random only if the
     *  bridge is absent or throws. */
    const genToken = async () => {
        try {
            if (crypto && typeof crypto.randomToken === 'function') {
                const hex = String(await crypto.randomToken(16)).toLowerCase().replace(/[^a-z0-9]/g, '');
                if (hex.length >= 32) return hex.slice(0, 32);
            }
        } catch (e) { /* fall through to Math.random */ }
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let t = '';
        for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
        return t;
    };

    const slugify = (s) => {
        // NFD-decompose then drop combining diacritics (code points 768..879 = U+0300..U+036F),
        // written with code-point checks to keep this file ASCII-only in code.
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
        return `${base}-${(await genToken()).slice(0, 6)}`;
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

    /** DB timestamps arrive as 'YYYY-MM-DD HH:MM:SS' (SQLite), ISO strings (bridge-serialized
     *  Dates from PG/MySQL) or with offsets — normalize to epoch ms, null when unparseable. */
    const parseDbDate = (v) => {
        if (!v) return null;
        let s = String(v).trim();
        if (!s.includes('T')) s = s.replace(' ', 'T');
        if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : null;
    };

    /** Discount in cents for a coupon row against a subtotal (never exceeds the subtotal). */
    const computeDiscount = (coupon, subtotalCents) => {
        const value = Number(coupon.value) || 0;
        let d = coupon.type === 'percent' ? Math.floor(subtotalCents * value / 100) : value;
        return Math.max(0, Math.min(d, subtotalCents));
    };

    // In-memory rolling-window rate limiter (single child process; the host forwards clientKey —
    // an HMAC of the client IP — so buckets are per-client where it matters, with global caps on
    // the expensive endpoints). The map is pruned so hostile key churn can't grow it unbounded.
    const rateBuckets = new Map(); // bucket name -> timestamps[]
    const RATE_MAX_BUCKETS = 5000;
    const rateLimited = (name, max, windowMs) => {
        const now = Date.now();
        if (rateBuckets.size > RATE_MAX_BUCKETS) {
            // First drop fully-expired buckets...
            for (const [k, ts] of rateBuckets) {
                if (!ts.length || now - ts[ts.length - 1] > 10 * 60 * 1000) rateBuckets.delete(k);
            }
            // ...then, if a burst of distinct clientKeys (IP churn) kept us over the cap with all
            // buckets still fresh, evict the oldest ones so the map can never grow unbounded.
            // Map preserves insertion order, so the first keys are the least-recently-created.
            if (rateBuckets.size > RATE_MAX_BUCKETS) {
                const excess = rateBuckets.size - RATE_MAX_BUCKETS;
                let dropped = 0;
                for (const k of rateBuckets.keys()) {
                    rateBuckets.delete(k);
                    if (++dropped >= excess) break;
                }
            }
        }
        const arr = (rateBuckets.get(name) || []).filter((t) => now - t < windowMs);
        if (arr.length >= max) { rateBuckets.set(name, arr); return true; }
        arr.push(now);
        rateBuckets.set(name, arr);
        return false;
    };
    const clientBucket = (req, name) => `${name}:${String((req && req.clientKey) || 'anon').slice(0, 64)}`;

    const fmtMoney = (cents, symbol) => `${symbol}${((Number(cents) || 0) / 100).toFixed(2)}`;
    const fmtBp = (bp) => `${((Number(bp) || 0) / 100).toFixed(2).replace(/\.00$/, '')}%`;

    const itemLabel = (i) => (i && i.variant_name) ? `${i.name} (${i.variant_name})` : String((i && i.name) || '');

    const shippingLabel = (order) => {
        if (order.shipping_method === 'pickup') return 'Recogida en tienda';
        if (order.shipping_method === 'zone' && order.shipping_zone_name) return `Envío — ${order.shipping_zone_name}`;
        return 'Envío estándar';
    };

    // ---- transactional emails (ALL best-effort — order state never depends on mail) --------------
    const orderTotalsText = (order, cfg) => {
        let t = `Subtotal: ${fmtMoney(order.subtotal_cents, cfg.currencySymbol)}\n`;
        if (order.discount_cents > 0) t += `Descuento: -${fmtMoney(order.discount_cents, cfg.currencySymbol)}\n`;
        t += `${shippingLabel(order)}: ${order.shipping_cents > 0 ? fmtMoney(order.shipping_cents, cfg.currencySymbol) : 'gratis'}\n`;
        if (order.tax_cents > 0) t += `${cfg.taxLabel} (${fmtBp(order.tax_rate_bp)}): ${fmtMoney(order.tax_cents, cfg.currencySymbol)}\n`;
        t += `Total: ${fmtMoney(order.total_cents, cfg.currencySymbol)}`;
        return t;
    };

    const sendOrderEmails = async (order, cfg) => {
        const items = parseItems(order.items);
        const lines = items.map((i) => `- ${itemLabel(i)} x${i.qty} — ${fmtMoney(i.price_cents * i.qty, cfg.currencySymbol)}`).join('\n');
        const totals = orderTotalsText(order, cfg);
        try {
            await mail({
                to: order.customer_email,
                subject: `Pedido recibido — #${order.id}`,
                text: `Hola ${order.customer_name},\n\nRecibimos tu pedido #${order.id}.\n\n${lines}\n\n${totals}\n\n`
                    + (order.payment_method === 'manual' ? `Pago: ${cfg.manualPaymentInstructions}\n\n` : '')
                    + (order.shipping_method === 'pickup' ? `Recogida: ${cfg.pickupInstructions}\n\n` : '')
                    + `Código de seguimiento: ${order.token}\n\nGracias por tu compra.`,
            });
        } catch (e) { console.warn('[online-store] correo al cliente no enviado:', e.message); }
        try {
            if (cfg.storeEmail && EMAIL_RE.test(cfg.storeEmail)) {
                await mail({
                    to: cfg.storeEmail,
                    subject: `Nuevo pedido #${order.id} — ${fmtMoney(order.total_cents, cfg.currencySymbol)}`,
                    text: `Nuevo pedido de ${order.customer_name} (${order.customer_email}).\n\n${lines}\n\n${totals}\n\nMétodo: ${order.payment_method}. Entrega: ${shippingLabel(order)}.`,
                });
            }
        } catch (e) { console.warn('[online-store] correo a la tienda no enviado:', e.message); }
    };

    const sendPaymentReceipt = async (order, cfg) => {
        try {
            await mail({
                to: order.customer_email,
                subject: `Pago recibido — Pedido #${order.id}`,
                text: `Hola ${order.customer_name},\n\nConfirmamos el pago de tu pedido #${order.id} por ${fmtMoney(order.total_cents, cfg.currencySymbol)}.\n\nCódigo de seguimiento: ${order.token}\n\nGracias por tu compra.`,
            });
        } catch (e) { console.warn('[online-store] recibo de pago no enviado:', e.message); }
    };

    const sendStatusEmail = async (order, cfg, status) => {
        const texts = {
            shipped: `Hola ${order.customer_name},\n\n¡Tu pedido #${order.id} va en camino!\n\n${order.shipping_method === 'pickup' ? `Ya puedes pasar a recogerlo. ${cfg.pickupInstructions}` : 'Pronto lo recibirás en la dirección indicada.'}\n\nCódigo de seguimiento: ${order.token}\n\nGracias por tu compra.`,
            cancelled: `Hola ${order.customer_name},\n\nTu pedido #${order.id} ha sido cancelado.\n\nSi ya realizaste el pago, nos pondremos en contacto contigo para gestionarlo. Ante cualquier duda responde a este correo.\n\nCódigo de seguimiento: ${order.token}`,
        };
        const subjects = {
            shipped: `Tu pedido #${order.id} va en camino`,
            cancelled: `Pedido #${order.id} cancelado`,
        };
        if (!texts[status]) return;
        try {
            await mail({ to: order.customer_email, subject: subjects[status], text: texts[status] });
        } catch (e) { console.warn(`[online-store] correo de estado (${status}) no enviado:`, e.message); }
    };

    const sendRefundEmail = async (order, cfg, amountCents) => {
        try {
            await mail({
                to: order.customer_email,
                subject: `Reembolso emitido — Pedido #${order.id}`,
                text: `Hola ${order.customer_name},\n\nEmitimos un reembolso de ${fmtMoney(amountCents, cfg.currencySymbol)} para tu pedido #${order.id}.\n\n`
                    + (order.payment_method === 'stripe'
                        ? 'El importe volverá al medio de pago original en los próximos días (según tu banco).\n\n'
                        : 'Nos pondremos en contacto contigo para completar la devolución.\n\n')
                    + `Código de seguimiento: ${order.token}`,
            });
        } catch (e) { console.warn('[online-store] correo de reembolso no enviado:', e.message); }
    };

    // ---- inventory + coupon restore (shared by cancel transition and refund-with-restock) --------
    /** Return each limited-stock line to inventory: the variant row when the line has one, else
     *  the product row. Safe on deleted rows (0 changes) and unlimited stock (guarded stock >= 0). */
    const restockOrderItems = async (order) => {
        for (const it of parseItems(order.items)) {
            const pid = Number(it && it.product_id);
            const qty = Number(it && it.qty);
            const vid = Number(it && it.variant_id) || 0;
            if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(qty) || qty < 1) continue;
            try {
                if (vid > 0) {
                    await db.run(`UPDATE ${T.variants} SET stock = stock + ? WHERE id = ? AND product_id = ? AND stock >= 0`, [qty, vid, pid]);
                } else {
                    await db.run(`UPDATE ${T.products} SET stock = stock + ? WHERE id = ? AND stock >= 0`, [qty, pid]);
                }
            } catch (e) { console.warn('[online-store] no se pudo restaurar stock:', e.message); }
        }
    };
    const releaseCouponUse = async (order) => {
        if (!order.coupon_code) return;
        try { await db.run(`UPDATE ${T.coupons} SET used_count = used_count - 1 WHERE code = ? AND used_count > 0`, [order.coupon_code]); }
        catch (e) { console.warn('[online-store] no se pudo restaurar el cupón:', e.message); }
    };

    // ---- Stripe API helpers (secret key never leaves the server) ---------------------------------
    const stripeApi = async (key, method, path, form) => {
        const resp = await fetch('https://api.stripe.com' + path, {
            method,
            headers: {
                Authorization: 'Bearer ' + key,
                ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            },
            body: form ? form.toString() : undefined,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const msg = (data && data.error && data.error.message) ? data.error.message : `HTTP ${resp.status}`;
            throw new Error(msg);
        }
        return data;
    };
    const fetchStripeSession = (key, sessionId) =>
        stripeApi(key, 'GET', '/v1/checkout/sessions/' + encodeURIComponent(sessionId));
    const fetchStripeSessionByPI = async (key, pi) => {
        const data = await stripeApi(key, 'GET', `/v1/checkout/sessions?payment_intent=${encodeURIComponent(pi)}&limit=1`);
        return (data && Array.isArray(data.data) && data.data[0]) ? data.data[0] : null;
    };
    /** Best-effort: expire a still-open Checkout Session so a cancelled order can't be paid after
     *  the fact. Returns the session's payment_status when Stripe reports it already paid (so the
     *  caller can refuse to cancel a just-paid order), else null. */
    const expireStripeSession = async (order) => {
        if (order.payment_method !== 'stripe' || !order.stripe_session_id) return null;
        try {
            const key = await getSetting('stripe_sk');
            if (!key) return null;
            const session = await fetchStripeSession(key, order.stripe_session_id).catch(() => null);
            if (session && session.payment_status === 'paid') return 'paid';
            if (STRIPE_SESSION_RE.test(order.stripe_session_id)) {
                await stripeApi(key, 'POST', `/v1/checkout/sessions/${encodeURIComponent(order.stripe_session_id)}/expire`, new URLSearchParams());
            }
            return null;
        } catch (e) {
            // Already-expired/consumed sessions error here — harmless.
            return null;
        }
    };

    /** Cancel transition, made idempotent via a conditional UPDATE: the status flip only "wins"
     *  once (changes === 1), and restock + coupon release run exactly under that win, so a
     *  re-cancel or two concurrent cancels can never double-restock or double-release. Returns
     *  true when THIS call performed the cancellation. */
    const cancelOrderOnce = async (order) => {
        const r = await db.run(`UPDATE ${T.orders} SET status = 'cancelled' WHERE id = ? AND status != 'cancelled'`, [order.id]);
        if (!r || r.changes !== 1) return false;
        await restockOrderItems(order);
        await releaseCouponUse(order);
        return true;
    };

    /** The ONLY code path that flips an order to paid from Stripe data. `session` must come from
     *  api.stripe.com (fetched with the secret key) — NEVER from a webhook body. The conditional
     *  pending->paid UPDATE makes the flip idempotent and gates the receipt email to exactly one
     *  send across return leg, webhook and reconciler. */
    const markPaidFromStripeSession = async (order, session) => {
        if (!session || session.payment_status !== 'paid') return { paid: order.payment_status === 'paid' };
        const metaToken = session.metadata && session.metadata.order_token;
        if (metaToken !== order.token) return { paid: order.payment_status === 'paid' };
        if (!order.stripe_session_id || order.stripe_session_id !== session.id) return { paid: order.payment_status === 'paid' };
        // Stripe captured money for an order that was cancelled (stock already returned, coupon
        // released) — DO NOT mark it paid (the `status != 'cancelled'` guard on the UPDATE makes
        // this race-proof even if `order` is a stale read), and alert loudly for a manual refund.
        if (order.status === 'cancelled') {
            console.error(`[online-store] CRITICO: Stripe cobró el pedido CANCELADO #${order.id} (token ${order.token}). Requiere reembolso manual en Stripe.`);
            return { paid: false, cancelledButPaid: true };
        }
        const r = await db.run(
            `UPDATE ${T.orders} SET payment_status = 'paid', stripe_payment_intent = ? WHERE token = ? AND payment_status = 'pending' AND status != 'cancelled'`,
            [String(session.payment_intent || '').slice(0, 255), order.token]
        );
        if (r && r.changes === 1) {
            const fresh = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [order.token]);
            if (fresh) await sendPaymentReceipt(fresh, await getConfig());
            return { paid: true, flipped: true };
        }
        const now = await db.get(`SELECT payment_status FROM ${T.orders} WHERE token = ?`, [order.token]);
        return { paid: !!(now && now.payment_status === 'paid') };
    };

    // ---- product payload helpers ------------------------------------------------------------------
    const groupBy = (rows, key) => {
        const m = new Map();
        for (const r of rows) {
            const k = r[key];
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(r);
        }
        return m;
    };

    /** Resolved public variant: price falls back to the product price when the row inherits. */
    const publicVariant = (v, product) => ({
        id: v.id,
        name: v.name,
        sku: v.sku || '',
        price_cents: (Number(v.price_cents) >= 0) ? Number(v.price_cents) : Number(product.price_cents),
        stock: v.stock,
    });

    const publicProduct = (p, variants, images) => {
        const act = (variants || []).filter((v) => v.is_active);
        const prices = act.map((v) => (Number(v.price_cents) >= 0 ? Number(v.price_cents) : Number(p.price_cents)));
        return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            description: p.description || '',
            price_cents: p.price_cents,
            image_url: p.image_url || ((images && images[0] && images[0].url) || ''),
            category: p.category || '',
            stock: p.stock,
            has_variants: act.length > 0,
            price_from_cents: act.length ? Math.min(...prices) : p.price_cents,
        };
    };

    const publicProductFull = (p, variants, images) => ({
        ...publicProduct(p, variants, images),
        variants: (variants || []).filter((v) => v.is_active).map((v) => publicVariant(v, p)),
        images: (images || []).map((im) => ({ url: im.url, alt: im.alt || '' })),
    });

    const publicOrder = (o) => ({
        orderNumber: o.id,
        token: o.token,
        created_at: o.created_at,
        customer_name: o.customer_name,
        maskedEmail: maskEmail(o.customer_email),
        items: parseItems(o.items),
        subtotal_cents: o.subtotal_cents,
        shipping_cents: o.shipping_cents,
        discount_cents: o.discount_cents,
        tax_cents: o.tax_cents || 0,
        tax_rate_bp: o.tax_rate_bp || 0,
        total_cents: o.total_cents,
        coupon_code: o.coupon_code || '',
        payment_method: o.payment_method,
        payment_status: o.payment_status,
        status: o.status,
        shipping_method: o.shipping_method || '',
        shipping_zone_name: o.shipping_zone_name || '',
        refund_cents: o.refund_cents || 0,
    });

    const adminOrder = (o) => ({ ...o, items: parseItems(o.items) });

    // ================================ PUBLIC ROUTES ================================

    // Catalog — the Puck block calls this from the editor iframe AND the public page.
    // v2: sort options + variant-aware price_from + cover fallback to the gallery.
    http.route('get', '/public/products', async (req, res) => {
        const q = req.query || {};
        const category = String(q.category || '').trim().slice(0, 100);
        const search = String(q.search || '').trim().toLowerCase().slice(0, 100);
        const sort = String(q.sort || 'default');
        const limit = clampInt(q.limit, 60, 1, 200);
        const params = [];
        let where = 'WHERE is_published = 1';
        if (category) { where += ' AND category = ?'; params.push(category); }
        let rows = await db.all(`SELECT * FROM ${T.products} ${where} ORDER BY sort_order ASC, name ASC`, params);
        if (search) {
            rows = rows.filter((p) => `${p.name} ${p.description || ''} ${p.category || ''}`.toLowerCase().includes(search));
        }
        const allVariants = rows.length ? await db.all(`SELECT * FROM ${T.variants} WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`) : [];
        const allImages = rows.length ? await db.all(`SELECT * FROM ${T.images} ORDER BY sort_order ASC, id ASC`) : [];
        const vByP = groupBy(allVariants, 'product_id');
        const iByP = groupBy(allImages, 'product_id');
        let out = rows.map((p) => publicProduct(p, vByP.get(p.id) || [], iByP.get(p.id) || []));
        if (sort === 'price_asc') out.sort((a, b) => a.price_from_cents - b.price_from_cents);
        else if (sort === 'price_desc') out.sort((a, b) => b.price_from_cents - a.price_from_cents);
        else if (sort === 'name') out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        else if (sort === 'newest') out.sort((a, b) => b.id - a.id);
        res.json({ products: out.slice(0, limit), total: out.length });
    });

    // Full product for the detail view: gallery + active variants with resolved prices.
    http.route('get', '/public/product', async (req, res) => {
        const slug = String((req.query && req.query.slug) || '').trim().slice(0, 120);
        if (!slug) return res.status(400).json({ error: 'Falta el parámetro slug.' });
        const row = await db.get(`SELECT * FROM ${T.products} WHERE slug = ? AND is_published = 1`, [slug]);
        if (!row) return res.status(404).json({ error: 'Producto no encontrado.' });
        const variants = await db.all(`SELECT * FROM ${T.variants} WHERE product_id = ? ORDER BY sort_order ASC, id ASC`, [row.id]);
        const images = await db.all(`SELECT * FROM ${T.images} WHERE product_id = ? ORDER BY sort_order ASC, id ASC`, [row.id]);
        res.json({ product: publicProductFull(row, variants, images) });
    });

    // Category list for the catalog filter chips.
    http.route('get', '/public/categories', async (req, res) => {
        const rows = await db.all(
            `SELECT category, COUNT(*) AS n FROM ${T.products} WHERE is_published = 1 AND category != '' GROUP BY category ORDER BY category ASC`
        );
        res.json({ categories: rows.map((r) => ({ name: r.category, count: r.n })) });
    });

    // Non-secret store config the block needs to render (currency, taxes, pickup, whether the
    // Stripe option should be offered — only a boolean, never the key).
    http.route('get', '/public/store-config', async (req, res) => {
        const cfg = await getConfig();
        const hasKey = !!(await getSetting('stripe_sk'));
        res.json({
            currencySymbol: cfg.currencySymbol,
            currencyCode: cfg.currencyCode,
            shippingCents: cfg.shippingCents,
            manualPaymentInstructions: cfg.manualPaymentInstructions,
            stripeEnabled: hasKey,
            pickupEnabled: cfg.pickupEnabled,
            taxRateBp: cfg.taxRateBp,
            taxLabel: cfg.taxLabel,
        });
    });

    // Shipping methods for the checkout step. Rates here are a PREVIEW — checkout recomputes.
    http.route('get', '/public/shipping-options', async (req, res) => {
        const cfg = await getConfig();
        const zones = await db.all(`SELECT * FROM ${T.zones} WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`);
        res.json({
            pickupEnabled: cfg.pickupEnabled,
            pickupInstructions: cfg.pickupInstructions,
            taxRateBp: cfg.taxRateBp,
            taxLabel: cfg.taxLabel,
            zones: zones.map((z) => ({
                id: z.id,
                name: z.name,
                rate_cents: z.rate_cents,
                free_over_cents: z.free_over_cents,
                tax_rate_bp: (Number(z.tax_rate_bp) >= 0) ? z.tax_rate_bp : cfg.taxRateBp,
            })),
            flatCents: zones.length ? null : cfg.shippingCents,
        });
    });

    // Coupon preview for the cart drawer. Does NOT consume a use — checkout does that atomically.
    http.route('post', '/public/validate-coupon', async (req, res) => {
        if (rateLimited(clientBucket(req, 'validate-coupon'), 15, 60 * 1000) || rateLimited('validate-coupon', 60, 60 * 1000)) {
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

    // ---- checkout (shared by the anonymous route and the logged-in route) ------------------------
    // The only prices/rates trusted are the ones re-read from the DB right here. `userCtx` is the
    // host-authenticated session user (or null): its id is stored so the account can list its own
    // orders later — a STRONG link captured at purchase time, never email matching.
    const handleCheckout = async (req, res, userCtx) => {
        if (rateLimited(clientBucket(req, 'checkout'), 6, 60 * 1000) || rateLimited('checkout', 20, 60 * 1000)) {
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

        // Validate + merge duplicate lines (qty stays within 1..99 per product+variant).
        const qtyByKey = new Map(); // 'pid:variantId' -> qty
        for (const it of rawItems) {
            const pid = Number(it && it.product_id);
            const vid = Number((it && it.variant_id) || 0);
            const qty = Number(it && it.qty);
            if (!Number.isInteger(pid) || pid < 1) return res.status(400).json({ error: 'Artículo no válido en el carrito.' });
            if (!Number.isInteger(vid) || vid < 0) return res.status(400).json({ error: 'Variante no válida en el carrito.' });
            if (!Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Cantidad no válida (debe ser un entero entre 1 y 99).' });
            const key = `${pid}:${vid}`;
            qtyByKey.set(key, Math.min(99, (qtyByKey.get(key) || 0) + qty));
        }

        // Re-read products + variants from the DB — price + availability come from HERE, never
        // the client. Products with active variants REQUIRE a variant per line.
        const lines = [];
        const variantCache = new Map(); // pid -> active variant rows
        for (const [key, qty] of qtyByKey) {
            const [pidStr, vidStr] = key.split(':');
            const pid = Number(pidStr);
            const vid = Number(vidStr);
            const p = await db.get(`SELECT * FROM ${T.products} WHERE id = ? AND is_published = 1`, [pid]);
            if (!p) return res.status(400).json({ error: 'Uno de los productos del carrito ya no está disponible.' });
            if (!variantCache.has(pid)) {
                variantCache.set(pid, await db.all(`SELECT * FROM ${T.variants} WHERE product_id = ? AND is_active = 1`, [pid]));
            }
            const activeVariants = variantCache.get(pid);
            if (activeVariants.length > 0) {
                const v = activeVariants.find((row) => Number(row.id) === vid);
                if (!vid || !v) return res.status(400).json({ error: `Selecciona una opción válida para "${p.name}".` });
                const price = (Number(v.price_cents) >= 0) ? Number(v.price_cents) : Number(p.price_cents);
                lines.push({ product: p, variant: v, qty, price_cents: price });
            } else {
                if (vid) return res.status(400).json({ error: `El producto "${p.name}" ya no tiene esa variante.` });
                lines.push({ product: p, variant: null, qty, price_cents: Number(p.price_cents) });
            }
        }

        // Single-statement conditional stock decrement per line (variant row when present, else
        // product row); on any failure, restore what was already decremented.
        const decremented = [];
        const restoreStock = async () => {
            for (const d of decremented) {
                try {
                    if (d.kind === 'variant') {
                        await db.run(`UPDATE ${T.variants} SET stock = stock + ? WHERE id = ? AND stock >= 0`, [d.qty, d.id]);
                    } else {
                        await db.run(`UPDATE ${T.products} SET stock = stock + ? WHERE id = ? AND stock >= 0`, [d.qty, d.id]);
                    }
                } catch (e) { console.warn('[online-store] no se pudo restaurar stock:', e.message); }
            }
        };
        // Wrapped so a THROWN db error mid-loop (not just a changes!==1 sell-out) also restores the
        // lines already decremented — otherwise a DB hiccup on line 3 would leak lines 1-2's stock.
        try {
            for (const line of lines) {
                if (line.variant) {
                    if (line.variant.stock < 0) continue; // -1 = unlimited
                    const r = await db.run(
                        `UPDATE ${T.variants} SET stock = stock - ? WHERE id = ? AND product_id = ? AND is_active = 1 AND stock >= ?`,
                        [line.qty, line.variant.id, line.product.id, line.qty]
                    );
                    if (!r || r.changes !== 1) {
                        await restoreStock();
                        return res.status(409).json({ error: `Sin stock: ${line.product.name} (${line.variant.name})` });
                    }
                    decremented.push({ kind: 'variant', id: line.variant.id, qty: line.qty });
                } else {
                    if (line.product.stock < 0) continue; // -1 = unlimited
                    const r = await db.run(
                        `UPDATE ${T.products} SET stock = stock - ? WHERE id = ? AND stock >= ?`,
                        [line.qty, line.product.id, line.qty]
                    );
                    if (!r || r.changes !== 1) {
                        await restoreStock();
                        return res.status(409).json({ error: `Sin stock: ${line.product.name}` });
                    }
                    decremented.push({ kind: 'product', id: line.product.id, qty: line.qty });
                }
            }
        } catch (e) {
            await restoreStock();
            console.warn('[online-store] fallo al descontar stock:', e.message);
            return res.status(500).json({ error: 'No se pudo registrar el pedido. Intenta de nuevo en un momento.' });
        }

        const subtotal = lines.reduce((s, l) => s + (l.price_cents * l.qty), 0);

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
        let cfg, shipping, tax, taxBp, total, stripeKey, method, token, itemsJson, orderId;
        let shipMethod = '', shipZoneId = 0, shipZoneName = '';
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
            const goods = Math.max(0, subtotal - discount);

            // Shipping: pickup | zone | flat (flat = legacy path, also the fallback for old
            // client bundles that send no shipping field — an admin-visible 'flat' order beats a
            // broken checkout during the brief bundle-skew window after upgrading).
            const zones = await db.all(`SELECT * FROM ${T.zones} WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`);
            const shipReq = (body.shipping && typeof body.shipping === 'object') ? body.shipping : {};
            const reqMethod = String(shipReq.method || '');
            let zone = null;
            if (reqMethod === 'pickup') {
                if (!cfg.pickupEnabled) { await restoreStock(); await restoreCoupon(); return res.status(400).json({ error: 'La recogida en tienda no está disponible.' }); }
                shipMethod = 'pickup';
                shipping = 0;
            } else if (reqMethod === 'zone') {
                const zid = Number(shipReq.zone_id);
                zone = zones.find((z) => Number(z.id) === zid) || null;
                if (!zone) { await restoreStock(); await restoreCoupon(); return res.status(400).json({ error: 'Selecciona una zona de envío válida.' }); }
                shipMethod = 'zone';
                shipZoneId = zone.id;
                shipZoneName = String(zone.name || '').slice(0, 100);
                shipping = (Number(zone.free_over_cents) >= 0 && goods >= Number(zone.free_over_cents)) ? 0 : Number(zone.rate_cents) || 0;
            } else if (zones.length > 0) {
                // Active zones exist: the ONLY valid methods are 'pickup' (handled above) and a
                // valid 'zone' (handled above). Anything else — an explicit 'flat', an empty
                // method, or a missing shipping object — is rejected so a client can never opt out
                // of the zone rate + zone tax by choosing/omitting the method. (A pre-v2 client
                // bundle fails closed with a clear 400 rather than silently mispricing the order.)
                await restoreStock(); await restoreCoupon();
                return res.status(400).json({ error: 'Selecciona un método de envío.' });
            } else {
                // No zones configured: the legacy flat rate from Configuración applies.
                shipMethod = 'flat';
                shipping = cfg.shippingCents;
            }

            // Simple taxes: basis points over the goods after discount (never over shipping).
            taxBp = (zone && Number(zone.tax_rate_bp) >= 0) ? Number(zone.tax_rate_bp) : cfg.taxRateBp;
            if (!Number.isInteger(taxBp) || taxBp < 0 || taxBp > 5000) taxBp = 0;
            tax = Math.round(goods * taxBp / 10000);
            total = goods + shipping + tax;

            stripeKey = await getSetting('stripe_sk');
            const wantsStripe = String(body.payment_method || 'manual') === 'stripe';
            method = (wantsStripe && stripeKey) ? 'stripe' : 'manual';

            token = await genToken();
            itemsJson = JSON.stringify(lines.map((l) => ({
                product_id: l.product.id,
                variant_id: l.variant ? l.variant.id : 0,
                name: l.product.name,
                variant_name: l.variant ? l.variant.name : '',
                sku: l.variant ? (l.variant.sku || '') : '',
                price_cents: l.price_cents,
                qty: l.qty,
            })));
            const ins = await db.run(
                `INSERT INTO ${T.orders}
                    (token, customer_name, customer_email, customer_phone, customer_address, items,
                     subtotal_cents, shipping_cents, discount_cents, tax_cents, tax_rate_bp, total_cents,
                     coupon_code, payment_method, payment_status, status,
                     shipping_method, shipping_zone_id, shipping_zone_name, user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'new', ?, ?, ?, ?)`,
                [token, name, email, phone, address, itemsJson, subtotal, shipping, discount, tax, taxBp, total,
                    couponCode, method, shipMethod, shipZoneId, shipZoneName, (userCtx && Number(userCtx.id) > 0) ? Number(userCtx.id) : 0]
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
            tax_cents: tax, tax_rate_bp: taxBp, total_cents: total, payment_method: method,
            shipping_method: shipMethod, shipping_zone_name: shipZoneName,
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
                form.set('line_items[0][price_data][unit_amount]', String(toStripeAmount(total, cfg.currencyCode)));
                form.set('line_items[0][quantity]', '1');
                form.set('success_url', `${pageUrl}${sep}session_id={CHECKOUT_SESSION_ID}&order=${token}`);
                form.set('cancel_url', pageUrl);
                form.set('metadata[order_token]', token);
                form.set('customer_email', email);
                const session = await stripeApi(stripeKey, 'POST', '/v1/checkout/sessions', form);
                if (!session.url) throw new Error('Stripe no devolvió una URL de pago.');
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
        return res.json({
            success: true, token,
            manualInstructions: cfg.manualPaymentInstructions,
            pickupInstructions: shipMethod === 'pickup' ? cfg.pickupInstructions : '',
        });
    };

    http.route('post', '/public/checkout', (req, res) => handleCheckout(req, res, null));
    // Same body/flow, but the host authenticates the session first: the order gets a strong
    // user_id link so /my-orders can list it. Any logged-in role qualifies (no admin gate).
    http.route('post', '/checkout-user', { auth: true }, (req, res) => handleCheckout(req, res, req.user || null));

    // Order history for the logged-in account. STRICTLY user_id-matched (captured at checkout):
    // email matching would let anyone who registers a victim's address read their orders.
    http.route('get', '/my-orders', { auth: true }, async (req, res) => {
        const uid = Number(req.user && req.user.id) || 0;
        if (uid < 1) return res.json({ orders: [] });
        const rows = await db.all(`SELECT * FROM ${T.orders} WHERE user_id = ? ORDER BY id DESC LIMIT 50`, [uid]);
        res.json({ orders: rows.map(publicOrder) });
    });

    // Public order status by random token (never sequential ids).
    http.route('get', '/public/order', async (req, res) => {
        if (rateLimited(clientBucket(req, 'order-lookup'), 30, 60 * 1000) || rateLimited('order-lookup', 120, 60 * 1000)) {
            return res.status(429).json({ error: 'Demasiadas consultas, intenta en un minuto.' });
        }
        const token = String((req.query && req.query.token) || '').trim();
        if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código de pedido no válido.' });
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
        if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
        res.json({ order: publicOrder(o) });
    });

    // Stripe return leg: verify the session AGAINST STRIPE with the secret key. Idempotent —
    // shares the single pending->paid flip with the webhook and the reconciler.
    http.route('get', '/public/confirm-stripe', async (req, res) => {
        if (rateLimited(clientBucket(req, 'confirm-stripe'), 15, 60 * 1000) || rateLimited('confirm-stripe', 60, 60 * 1000)) {
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
            const session = await fetchStripeSession(key, sessionId);
            const result = await markPaidFromStripeSession(o, session);
            return res.json({ paid: !!result.paid });
        } catch (e) {
            return res.status(502).json({ paid: false, error: `No se pudo verificar el pago con Stripe: ${e.message || e}` });
        }
    });

    // Stripe webhook — see the file header: the body is an UNTRUSTED HINT (no signature check is
    // possible in the sandbox). State only changes after re-fetching the session from Stripe with
    // the secret key, so a forged event is a no-op. Always answers fast so Stripe stops retrying.
    http.route('post', '/public/stripe-webhook', async (req, res) => {
        if (rateLimited('stripe-webhook', 120, 60 * 1000)) {
            return res.status(429).json({ received: false });
        }
        const key = await getSetting('stripe_sk');
        if (!key) return res.json({ received: true, ignored: 'stripe-off' });
        const event = req.body || {};
        const type = String(event.type || '');
        const obj = (event.data && event.data.object && typeof event.data.object === 'object') ? event.data.object : {};
        let sessionId = '';
        let paymentIntent = '';
        if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
            sessionId = String(obj.id || '');
        } else if (type === 'payment_intent.succeeded') {
            paymentIntent = String(obj.id || '');
        } else {
            return res.json({ received: true, ignored: 'event-type' });
        }
        if (sessionId && !STRIPE_SESSION_RE.test(sessionId)) return res.json({ received: true, ignored: 'bad-id' });
        if (paymentIntent && !STRIPE_PI_RE.test(paymentIntent)) return res.json({ received: true, ignored: 'bad-id' });
        try {
            const session = sessionId
                ? await fetchStripeSession(key, sessionId)
                : await fetchStripeSessionByPI(key, paymentIntent);
            if (!session) return res.json({ received: true, ignored: 'no-session' });
            const metaToken = String((session.metadata && session.metadata.order_token) || '');
            if (!TOKEN_RE.test(metaToken)) return res.json({ received: true, ignored: 'no-token' });
            const o = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [metaToken]);
            if (!o) return res.json({ received: true, ignored: 'no-order' });
            const result = await markPaidFromStripeSession(o, session);
            return res.json({ received: true, paid: !!result.paid });
        } catch (e) {
            // 5xx makes Stripe retry later — correct for transient Stripe/API failures.
            console.warn('[online-store] webhook: verificación fallida:', e.message);
            return res.status(502).json({ received: false });
        }
    });

    // Reconciler: recent pending Stripe orders re-verified server-side every 5 minutes. Covers
    // customers who never return AND sites without a webhook configured.
    const reconcilePendingStripe = async () => {
        try {
            const key = await getSetting('stripe_sk');
            if (!key) return;
            const rows = await db.all(
                `SELECT * FROM ${T.orders} WHERE payment_method = 'stripe' AND payment_status = 'pending' AND status != 'cancelled' AND stripe_session_id != '' ORDER BY id DESC LIMIT 20`
            );
            const cutoff = Date.now() - 48 * 3600 * 1000;
            for (const o of rows) {
                const created = parseDbDate(o.created_at);
                if (created !== null && created < cutoff) continue; // stale — admin decides
                try {
                    const session = await fetchStripeSession(key, o.stripe_session_id);
                    await markPaidFromStripeSession(o, session);
                } catch (e) { /* transient — next sweep retries */ }
            }
        } catch (e) { console.warn('[online-store] reconciliador:', e.message); }
    };
    activeTimers.push(setInterval(reconcilePendingStripe, 5 * 60 * 1000));
    activeTimers.push(setTimeout(reconcilePendingStripe, 45 * 1000));

    // ================================ ADMIN ROUTES ================================

    // ---- products CRUD (v2: nested variants[] + images[]) ----
    http.route('get', '/products', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.products} ORDER BY sort_order ASC, id DESC`);
        const variants = await db.all(`SELECT * FROM ${T.variants} ORDER BY sort_order ASC, id ASC`);
        const images = await db.all(`SELECT * FROM ${T.images} ORDER BY sort_order ASC, id ASC`);
        const vByP = groupBy(variants, 'product_id');
        const iByP = groupBy(images, 'product_id');
        res.json({ products: rows.map((p) => ({ ...p, variants: vByP.get(p.id) || [], images: iByP.get(p.id) || [] })) });
    });

    /** Replace-all variant sync: UPDATE rows whose id matches, INSERT new rows, DELETE the rest.
     *  Stock is set absolutely here (same semantics as the v1 product stock field). */
    const applyVariants = async (productId, list) => {
        const existing = await db.all(`SELECT id FROM ${T.variants} WHERE product_id = ?`, [productId]);
        const existingIds = new Set(existing.map((e) => Number(e.id)));
        const keep = new Set();
        let sort = 0;
        for (const raw of (Array.isArray(list) ? list.slice(0, 40) : [])) {
            const vname = String((raw && raw.name) || '').trim().slice(0, 120);
            if (!vname) continue;
            const sku = String((raw && raw.sku) || '').trim().slice(0, 60);
            let price = Number(raw && raw.price_cents);
            if (!Number.isInteger(price) || price < -1 || price > 1000000000) price = -1;
            let stock = Number(raw && raw.stock);
            if (!Number.isInteger(stock) || stock < -1 || stock > 1000000000) stock = -1;
            const isActive = (raw && raw.is_active === false) ? 0 : 1;
            const id = Number(raw && raw.id);
            if (Number.isInteger(id) && id > 0 && existingIds.has(id)) {
                await db.run(
                    `UPDATE ${T.variants} SET name = ?, sku = ?, price_cents = ?, stock = ?, sort_order = ?, is_active = ? WHERE id = ? AND product_id = ?`,
                    [vname, sku, price, stock, sort, isActive, id, productId]
                );
                keep.add(id);
            } else {
                const ins = await db.run(
                    `INSERT INTO ${T.variants} (product_id, name, sku, price_cents, stock, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [productId, vname, sku, price, stock, sort, isActive]
                );
                if (ins && ins.lastID) keep.add(Number(ins.lastID));
            }
            sort++;
        }
        for (const id of existingIds) {
            if (!keep.has(id)) await db.run(`DELETE FROM ${T.variants} WHERE id = ? AND product_id = ?`, [id, productId]);
        }
    };

    /** Replace-all gallery sync (order = array order). Admin-only, not race-sensitive. */
    const applyImages = async (productId, list) => {
        await db.run(`DELETE FROM ${T.images} WHERE product_id = ?`, [productId]);
        let sort = 0;
        for (const raw of (Array.isArray(list) ? list.slice(0, 12) : [])) {
            const url = String((raw && raw.url) || '').trim().slice(0, 1000);
            if (!url) continue;
            const alt = String((raw && raw.alt) || '').trim().slice(0, 300);
            await db.run(`INSERT INTO ${T.images} (product_id, url, alt, sort_order) VALUES (?, ?, ?, ?)`, [productId, url, alt, sort]);
            sort++;
        }
    };

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

        let productId = 0;
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
            productId = id;
        } else {
            const slug = await uniqueSlug(slugify(name));
            const ins = await db.run(
                `INSERT INTO ${T.products} (name, slug, description, price_cents, image_url, category, stock, is_published, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [name, slug, description, price, imageUrl, category, stock, isPublished, sortValid ? rawSort : 0]
            );
            productId = ins.lastID;
        }

        // Nested collections only when the caller sends them (API back-compat: absent = untouched).
        if (Array.isArray(body.variants)) await applyVariants(productId, body.variants);
        if (Array.isArray(body.images)) await applyImages(productId, body.images);

        const row = await db.get(`SELECT * FROM ${T.products} WHERE id = ?`, [productId]);
        const variants = await db.all(`SELECT * FROM ${T.variants} WHERE product_id = ? ORDER BY sort_order ASC, id ASC`, [productId]);
        const images = await db.all(`SELECT * FROM ${T.images} WHERE product_id = ? ORDER BY sort_order ASC, id ASC`, [productId]);
        res.json({ product: { ...row, variants, images } });
    });

    http.route('delete', '/products/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.products} WHERE id = ?`, [id]);
        await db.run(`DELETE FROM ${T.variants} WHERE product_id = ?`, [id]);
        await db.run(`DELETE FROM ${T.images} WHERE product_id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- coupons CRUD (v1, unchanged) ----
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

    // ---- shipping zones CRUD ----
    http.route('get', '/shipping-zones', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.zones} ORDER BY sort_order ASC, name ASC`);
        res.json({ zones: rows });
    });

    http.route('post', '/shipping-zones', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const name = String(body.name || '').trim().slice(0, 100);
        if (!name) return res.status(400).json({ error: 'El nombre de la zona es obligatorio.' });
        let rate = Number(body.rate_cents);
        if (!Number.isInteger(rate) || rate < 0 || rate > 100000000) return res.status(400).json({ error: 'Tarifa de envío no válida.' });
        let freeOver = Number(body.free_over_cents);
        if (!Number.isInteger(freeOver) || freeOver < -1 || freeOver > 1000000000) freeOver = -1;
        let taxBp = Number(body.tax_rate_bp);
        if (!Number.isInteger(taxBp) || taxBp < -1 || taxBp > 5000) taxBp = -1;
        const isActive = body.is_active === false ? 0 : 1;
        let sortOrder = Number(body.sort_order);
        if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 1000000) sortOrder = 0;

        const id = Number(body.id);
        if (Number.isInteger(id) && id > 0) {
            const existing = await db.get(`SELECT id FROM ${T.zones} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Zona no encontrada.' });
            await db.run(
                `UPDATE ${T.zones} SET name = ?, rate_cents = ?, free_over_cents = ?, tax_rate_bp = ?, is_active = ?, sort_order = ? WHERE id = ?`,
                [name, rate, freeOver, taxBp, isActive, sortOrder, id]
            );
            const row = await db.get(`SELECT * FROM ${T.zones} WHERE id = ?`, [id]);
            return res.json({ zone: row });
        }
        const ins = await db.run(
            `INSERT INTO ${T.zones} (name, rate_cents, free_over_cents, tax_rate_bp, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, rate, freeOver, taxBp, isActive, sortOrder]
        );
        const row = await db.get(`SELECT * FROM ${T.zones} WHERE id = ?`, [ins.lastID]);
        res.json({ zone: row });
    });

    http.route('delete', '/shipping-zones/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.zones} WHERE id = ?`, [id]);
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
        const header = 'id,token,fecha,cliente,email,telefono,direccion,articulos,subtotal,envio,descuento,impuestos,total,reembolso,cupon,metodo_envio,zona_envio,metodo_pago,estado_pago,estado,notas';
        const csvRows = rows.map((o) => {
            const items = parseItems(o.items).map((i) => `${itemLabel(i)} x${i.qty}`).join(' | ');
            return [
                o.id, o.token, o.created_at, o.customer_name, o.customer_email, o.customer_phone || '',
                o.customer_address || '', items, money(o.subtotal_cents), money(o.shipping_cents),
                money(o.discount_cents), money(o.tax_cents), money(o.total_cents), money(o.refund_cents),
                o.coupon_code || '', o.shipping_method || '', o.shipping_zone_name || '', o.payment_method,
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
        let didCancel = false;
        if (status === 'cancelled') {
            // Guard a pending Stripe order: expire the live Checkout Session first so it can't be
            // paid after cancellation. If Stripe reports it was JUST paid, refuse to cancel (which
            // would restock a paid order) and send the admin to the refund flow instead.
            if (o.status !== 'cancelled' && o.payment_method === 'stripe' && o.payment_status === 'pending' && o.stripe_session_id) {
                const paid = await expireStripeSession(o);
                if (paid === 'paid') {
                    await db.run(`UPDATE ${T.orders} SET payment_status = 'paid' WHERE id = ? AND payment_status = 'pending' AND status != 'cancelled'`, [id]);
                    const fresh = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
                    return res.status(409).json({ error: 'Este pedido acaba de pagarse en Stripe. Usa "Reembolsar" en lugar de cancelar.', order: adminOrder(fresh) });
                }
            }
            // Atomic: restock + coupon release happen exactly once, gated by the conditional flip.
            didCancel = await cancelOrderOnce(o);
        } else {
            await db.run(`UPDATE ${T.orders} SET status = ? WHERE id = ?`, [status, id]);
        }
        const row = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        // Transactional emails on the transitions customers care about (best effort).
        if (row && status === 'shipped' && o.status !== 'shipped') {
            await sendStatusEmail(row, await getConfig(), 'shipped');
        } else if (row && status === 'cancelled' && didCancel) {
            await sendStatusEmail(row, await getConfig(), 'cancelled');
        }
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
            await sendPaymentReceipt(row, await getConfig());
        }
        res.json({ success: true, order: adminOrder(row) });
    });

    // ---- refunds: order state + real Stripe refund for card payments ----
    http.route('post', '/orders/:id/refund', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        const body = req.body || {};
        const o = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
        if (o.payment_status !== 'paid' && o.payment_status !== 'refunded') {
            return res.status(400).json({ error: 'Solo se pueden reembolsar pedidos pagados.' });
        }
        const already = Number(o.refund_cents) || 0;
        const remaining = Math.max(0, Number(o.total_cents) - already);
        if (remaining < 1) return res.status(400).json({ error: 'Este pedido ya está reembolsado por completo.' });
        let amount = remaining;
        if (body.amount_cents !== undefined && body.amount_cents !== null && String(body.amount_cents) !== '') {
            amount = Number(body.amount_cents);
            if (!Number.isInteger(amount) || amount < 1 || amount > remaining) {
                return res.status(400).json({ error: `Importe de reembolso no válido (máximo ${remaining} centavos).` });
            }
        }

        // RESERVE the refund budget FIRST with a single conditional statement, BEFORE calling
        // Stripe. This is the ordering that prevents both over-refunding on Stripe and the false
        // CRITICO the previous order-of-operations produced: two admins refunding partial amounts
        // that each fit `remaining` but together exceed the total would both call Stripe (real
        // double-refund) and only then collide on the accumulator. Reserving first means the race
        // loser is rejected with 0 money moved.
        const reserve = await db.run(
            `UPDATE ${T.orders} SET refund_cents = refund_cents + ?, refunded_at = ? WHERE id = ? AND payment_status IN ('paid', 'refunded') AND refund_cents + ? <= total_cents`,
            [amount, new Date().toISOString(), id, amount]
        );
        if (!reserve || reserve.changes !== 1) {
            return res.status(409).json({ error: 'El reembolso excede el saldo disponible del pedido (otro reembolso pudo procesarse antes).' });
        }
        const rollbackReserve = async () => {
            try { await db.run(`UPDATE ${T.orders} SET refund_cents = refund_cents - ? WHERE id = ? AND refund_cents >= ?`, [amount, id, amount]); }
            catch (e) { console.error(`[online-store] CRITICO: no se pudo revertir la reserva de reembolso en el pedido #${id}:`, e.message); }
        };

        // Card payments: issue the REAL Stripe refund now that the budget is safely reserved. On
        // any Stripe failure, roll the reservation back so the order's numbers stay truthful.
        let refundId = '';
        if (o.payment_method === 'stripe' && o.stripe_session_id) {
            const key = await getSetting('stripe_sk');
            if (!key) { await rollbackReserve(); return res.status(400).json({ error: 'Stripe no está configurado (no se puede reembolsar la tarjeta).' }); }
            try {
                let pi = String(o.stripe_payment_intent || '');
                if (!pi) {
                    const session = await fetchStripeSession(key, o.stripe_session_id);
                    pi = String((session && session.payment_intent) || '');
                    if (pi) await db.run(`UPDATE ${T.orders} SET stripe_payment_intent = ? WHERE id = ?`, [pi.slice(0, 255), id]);
                }
                if (!pi) { await rollbackReserve(); return res.status(400).json({ error: 'Stripe no reporta un pago capturado para este pedido.' }); }
                const form = new URLSearchParams();
                form.set('payment_intent', pi);
                form.set('amount', String(toStripeAmount(amount, o.currency_code || (await getConfig()).currencyCode)));
                const refund = await stripeApi(key, 'POST', '/v1/refunds', form);
                refundId = String((refund && refund.id) || '');
            } catch (e) {
                await rollbackReserve();
                return res.status(502).json({ error: `Stripe rechazó el reembolso: ${e.message || e}` });
            }
        }
        if (refundId) await db.run(`UPDATE ${T.orders} SET refund_id = ? WHERE id = ?`, [refundId.slice(0, 255), id]);

        // Flip to 'refunded' from the AUTHORITATIVE post-reservation value (re-read), never a stale
        // accumulator sum — so concurrent partials that together reach the total still settle to
        // 'refunded' exactly once.
        const afterReserve = await db.get(`SELECT refund_cents, total_cents FROM ${T.orders} WHERE id = ?`, [id]);
        if (afterReserve && Number(afterReserve.refund_cents) >= Number(afterReserve.total_cents)) {
            await db.run(`UPDATE ${T.orders} SET payment_status = 'refunded' WHERE id = ? AND payment_status != 'refunded'`, [id]);
        }

        // Optional restock: the SAME idempotent cancel transition (restock + coupon release gated
        // by the conditional status flip, so it can't double-restock).
        if (body.restock) await cancelOrderOnce(o);

        const row = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [id]);
        await sendRefundEmail(row, await getConfig(), amount);
        res.json({ success: true, order: adminOrder(row), refund_id: refundId });
    });

    http.route('delete', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        const id = Number(req.params && req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Id no válido.' });
        await db.run(`DELETE FROM ${T.orders} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- reports (JS aggregation over the recent window — driver-safe date handling) ----
    const computeReport = async (days) => {
        const rows = await db.all(`SELECT * FROM ${T.orders} ORDER BY id DESC LIMIT 5000`);
        const cutoff = Date.now() - days * 86400000;
        const inWindow = rows.filter((o) => {
            const t = parseDbDate(o.created_at);
            return t !== null && t >= cutoff;
        });
        const sales = inWindow.filter((o) => o.status !== 'cancelled');
        const paid = sales.filter((o) => o.payment_status === 'paid' || o.payment_status === 'refunded');

        const sum = (arr, f) => arr.reduce((s, o) => s + (Number(f(o)) || 0), 0);
        const revenue = sum(paid, (o) => o.total_cents);
        const refunds = sum(paid, (o) => o.refund_cents);
        let itemsSold = 0;
        const topMap = new Map(); // product_id:name -> {name, qty, revenue}
        for (const o of paid) {
            for (const i of parseItems(o.items)) {
                const qty = Number(i.qty) || 0;
                itemsSold += qty;
                const key = `${i.product_id}:${i.name}`;
                const cur = topMap.get(key) || { name: i.name, qty: 0, revenue_cents: 0 };
                cur.qty += qty;
                cur.revenue_cents += (Number(i.price_cents) || 0) * qty;
                topMap.set(key, cur);
            }
        }
        const topProducts = [...topMap.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 10);

        const couponMap = new Map();
        for (const o of sales) {
            if (!o.coupon_code) continue;
            const cur = couponMap.get(o.coupon_code) || { code: o.coupon_code, uses: 0, discount_cents: 0 };
            cur.uses += 1;
            cur.discount_cents += Number(o.discount_cents) || 0;
            couponMap.set(o.coupon_code, cur);
        }

        // Daily buckets for short windows, monthly for long ones. Zero-filled so charts are even.
        const byMonth = days > 92;
        const buckets = new Map();
        const bucketKey = (t) => byMonth ? new Date(t).toISOString().slice(0, 7) : new Date(t).toISOString().slice(0, 10);
        const stepStart = byMonth
            ? (() => { const d = new Date(cutoff); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); })()
            : cutoff;
        for (let t = stepStart; t <= Date.now(); t += byMonth ? 27 * 86400000 : 86400000) {
            buckets.set(bucketKey(t), { date: bucketKey(t), orders: 0, revenue_cents: 0 });
        }
        buckets.set(bucketKey(Date.now()), buckets.get(bucketKey(Date.now())) || { date: bucketKey(Date.now()), orders: 0, revenue_cents: 0 });
        for (const o of sales) {
            const t = parseDbDate(o.created_at);
            if (t === null) continue;
            const k = bucketKey(t);
            const b = buckets.get(k) || { date: k, orders: 0, revenue_cents: 0 };
            b.orders += 1;
            if (o.payment_status === 'paid' || o.payment_status === 'refunded') b.revenue_cents += Number(o.total_cents) || 0;
            buckets.set(k, b);
        }
        const series = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));

        const statusCounts = {};
        const paymentMix = {};
        for (const o of inWindow) {
            statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
            paymentMix[o.payment_method] = (paymentMix[o.payment_method] || 0) + 1;
        }

        return {
            days,
            granularity: byMonth ? 'month' : 'day',
            totals: {
                orders: sales.length,
                paid_orders: paid.length,
                revenue_cents: revenue,
                refunds_cents: refunds,
                net_cents: revenue - refunds,
                avg_order_cents: paid.length ? Math.round(revenue / paid.length) : 0,
                tax_cents: sum(paid, (o) => o.tax_cents),
                shipping_cents: sum(paid, (o) => o.shipping_cents),
                discount_cents: sum(sales, (o) => o.discount_cents),
                items_sold: itemsSold,
            },
            series,
            topProducts,
            couponUsage: [...couponMap.values()].sort((a, b) => b.uses - a.uses).slice(0, 10),
            statusCounts,
            paymentMix,
            truncated: rows.length >= 5000,
        };
    };

    http.route('get', '/reports', { auth: true, admin: true }, async (req, res) => {
        const days = clampInt(req.query && req.query.days, 30, 1, 365);
        res.json(await computeReport(days));
    });

    http.route('get', '/reports/export', { auth: true, admin: true }, async (req, res) => {
        const days = clampInt(req.query && req.query.days, 30, 1, 365);
        const r = await computeReport(days);
        const esc = (v) => {
            let s = String(v == null ? '' : v);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const money = (c) => ((Number(c) || 0) / 100).toFixed(2);
        const out = [];
        out.push(`Informe de ventas,últimos ${r.days} días`);
        out.push('');
        out.push('Totales');
        out.push(`Pedidos,${r.totals.orders}`);
        out.push(`Pedidos pagados,${r.totals.paid_orders}`);
        out.push(`Ingresos,${money(r.totals.revenue_cents)}`);
        out.push(`Reembolsos,${money(r.totals.refunds_cents)}`);
        out.push(`Neto,${money(r.totals.net_cents)}`);
        out.push(`Ticket medio,${money(r.totals.avg_order_cents)}`);
        out.push(`Impuestos,${money(r.totals.tax_cents)}`);
        out.push(`Envíos,${money(r.totals.shipping_cents)}`);
        out.push(`Descuentos,${money(r.totals.discount_cents)}`);
        out.push(`Artículos vendidos,${r.totals.items_sold}`);
        out.push('');
        out.push(`${r.granularity === 'month' ? 'Mes' : 'Día'},Pedidos,Ingresos`);
        for (const b of r.series) out.push([b.date, b.orders, money(b.revenue_cents)].map(esc).join(','));
        out.push('');
        out.push('Producto,Unidades,Ingresos');
        for (const p of r.topProducts) out.push([p.name, p.qty, money(p.revenue_cents)].map(esc).join(','));
        if (r.couponUsage.length) {
            out.push('');
            out.push('Cupón,Usos,Descuento');
            for (const c of r.couponUsage) out.push([c.code, c.uses, money(c.discount_cents)].map(esc).join(','));
        }
        res.json({ csv: out.join('\n'), filename: `informe-ventas-${days}d-${new Date().toISOString().slice(0, 10)}.csv` });
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
        if (body.pickupEnabled !== undefined) next.pickupEnabled = !!body.pickupEnabled;
        if (typeof body.pickupInstructions === 'string') next.pickupInstructions = body.pickupInstructions.slice(0, 1000);
        const taxBp = Number(body.taxRateBp);
        if (Number.isInteger(taxBp) && taxBp >= 0 && taxBp <= 5000) next.taxRateBp = taxBp;
        if (typeof body.taxLabel === 'string' && body.taxLabel.trim()) next.taxLabel = body.taxLabel.trim().slice(0, 50);
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

    console.log('[online-store] plugin v2 initialized');
};

exports.deactivate = function () {
    // Stop the Stripe reconciler timers; the in-memory rate buckets die with the child process.
    for (const t of activeTimers.splice(0)) {
        try { clearInterval(t); clearTimeout(t); } catch (e) { /* already gone */ }
    }
};
