/**
 * WordJS Plugin: Marketplace — multi-vendor directory (v1 = lead generation).
 *
 * Flow: vendors apply publicly -> the admin approves -> the vendor receives a 6-digit access code
 * for a self-service PORTAL (same pattern as conference-manager: throttled code login, opaque
 * server-side session id, host-namespaced cookie + x-portal-token header) where they manage their OWN product
 * listings and answer buyer inquiries. The public Puck block lists approved vendors' products with
 * vendor/category/search filtering; buyers contact a vendor through a per-product inquiry form.
 * There is NO centralized checkout in v1 — the marketplace generates leads and each vendor closes
 * the sale on their own channel (stated explicitly in the admin UI).
 *
 * Sandbox notes:
 *  - All tables live under the plugin prefix (db.tablePrefix) so they pass the host's default-deny
 *    SQL scoping. Schema is created idempotently with the FULL column set; columns added after 1.0.0
 *    are migrated with ALTER ... ADD COLUMN on the plugin's own tables.
 *  - Access codes come from the host CSPRNG (wordjs.crypto.randomInt), NOT Math.random; the login
 *    throttle below (wrong codes per client, per vendor and site-wide) bounds guessing the short code.
 *  - Money is stored as INTEGER CENTS (price_cents); clients render cents/100 with the configured
 *    currency symbol (a plain setting in the plugin's own table, not a secret).
 *  - Mail is best-effort: approval/inquiry emails are wrapped in try/catch and the operation
 *    succeeds anyway with a 'correo no enviado' note.
 */

exports.metadata = {
    name: 'Marketplace',
    version: '1.0.6',
    description: 'Multi-vendor directory: vendor applications, code-protected vendor portal, product listings and buyer inquiries (lead generation).',
    author: 'WordJS',
};

exports.init = async function (wordjs) {
    const { db, http, adminMenu } = wordjs;

    console.log('[marketplace] initializing plugin (sandboxed)...');

    // Per-plugin table namespace enforced by the host. slug 'marketplace' -> 'wjp_marketplace_'.
    const P = db.tablePrefix;
    const T = {
        vendors: `${P}vendors`,
        products: `${P}products`,
        inquiries: `${P}inquiries`,
        settings: `${P}settings`,
        sessions: `${P}portal_sessions`,
    };

    // Input length caps (defense against oversized payloads bloating the DB).
    const LIM = {
        name: 120, email: 200, phone: 40, description: 2000, url: 500,
        category: 60, productName: 150, message: 3000, symbol: 8,
        priceCents: 100000000, // 1,000,000.00 in whatever currency — sanity cap
    };
    const VENDOR_STATUSES = ['pending', 'approved', 'suspended'];
    const INQUIRY_STATUSES = ['new', 'replied', 'closed'];
    // A store's email as every route reads it (trimmed, capped, lower-cased): the email_claim value.
    const normEmail = (v) => String(v == null ? '' : v).trim().slice(0, LIM.email).toLowerCase();

    // ---- schema (idempotent; full column set on CREATE, later columns via ALTER ADD COLUMN) -------
    async function initSchema() {
        await db.createTable(T.vendors, [
            'id INT_PK',
            'name TEXT NOT NULL',
            'slug TEXT UNIQUE',
            'email TEXT NOT NULL',
            'phone TEXT',
            'description TEXT',
            'logo_url TEXT',
            'access_code TEXT',
            'status TEXT DEFAULT \'pending\'',
            'commission_pct INT DEFAULT 0',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'email_claim VARCHAR(255)',
        ]);
        // 1.0.1: one store per email address, enforced by a unique index on email_claim (the address
        // as every route normalises it; NULL = no claim, and a unique index admits any number of NULLs
        // on SQLite, MySQL and Postgres), filled by the INSERT that creates the store (insertVendor).
        // The duplicate-email check before that INSERT cannot see an INSERT racing it, so simultaneous
        // applications for one address were all stored. Stores from before 1.0.1 hold no claim — so
        // duplicates already stored do not stop the index from being created — and stay covered by
        // that check, which sees every committed row. Probe, then ALTER ... ADD COLUMN on our own
        // table for an existing install.
        let hasEmailClaim = true;
        try { await db.get(`SELECT email_claim FROM ${T.vendors} LIMIT 1`); } catch (e) { hasEmailClaim = false; }
        if (!hasEmailClaim) {
            try { await db.run(`ALTER TABLE ${T.vendors} ADD COLUMN email_claim VARCHAR(255)`); }
            catch (e) { console.error('[vendor-marketplace] could not add email_claim column:', e.message); }
        }
        try {
            await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_vendors_email_claim ON ${T.vendors} (email_claim)`);
        } catch (e) {
            console.error('[vendor-marketplace] could not create the unique email_claim index — simultaneous applications for one address are not refused on every engine:', e.message);
        }
        await db.createTable(T.products, [
            'id INT_PK',
            'vendor_id INT NOT NULL',
            'name TEXT NOT NULL',
            'description TEXT',
            'price_cents INT DEFAULT 0',
            'image_url TEXT',
            'category TEXT DEFAULT \'\'',
            'is_published INT DEFAULT 1',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'admin_hidden INT DEFAULT 0',
            `FOREIGN KEY (vendor_id) REFERENCES ${T.vendors}(id) ON DELETE CASCADE`,
        ]);
        // 1.0.0 -> 1.0.1: admin_hidden (moderation flag the vendor cannot override). Probe, then
        // ALTER ... ADD COLUMN on our own table (the host guard admits it; RENAME is what it denies).
        let hasAdminHidden = true;
        try { await db.get(`SELECT admin_hidden FROM ${T.products} LIMIT 1`); } catch (e) { hasAdminHidden = false; }
        if (!hasAdminHidden) {
            try { await db.run(`ALTER TABLE ${T.products} ADD COLUMN admin_hidden INTEGER DEFAULT 0`); }
            catch (e) { console.error('[vendor-marketplace] could not add admin_hidden column:', e.message); }
        }
        await db.createTable(T.inquiries, [
            'id INT_PK',
            'product_id INT',
            'vendor_id INT NOT NULL',
            'buyer_name TEXT NOT NULL',
            'buyer_email TEXT NOT NULL',
            'message TEXT',
            'status TEXT DEFAULT \'new\'',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (vendor_id) REFERENCES ${T.vendors}(id) ON DELETE CASCADE`,
        ]);
        // Plugin-private settings (currency symbol, etc. — nothing secret in here today).
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.settings} (name TEXT PRIMARY KEY, value TEXT)`);

        // Indexes for the common lookups (names AND targets must carry the plugin prefix).
        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) { /* already exists / unsupported — non-fatal */ }
        };
        await createIndex(`${P}idx_products_vendor`, T.products, 'vendor_id');
        await createIndex(`${P}idx_products_category`, T.products, 'category');
        await createIndex(`${P}idx_inquiries_vendor`, T.inquiries, 'vendor_id');
        await createIndex(`${P}idx_inquiries_product`, T.inquiries, 'product_id');

        // 1.0.2: server-side portal sessions (see createPortalSession). VARCHAR, not TEXT: MySQL cannot
        // index TEXT. No FK — the lookup joins the vendor, so a session of a deleted store resolves to none.
        await db.createTable(T.sessions, [
            'id INT_PK',
            'token VARCHAR(64) NOT NULL',
            'vendor_id INT NOT NULL',
            'access_code VARCHAR(32) NOT NULL',
            'expires_at VARCHAR(16) NOT NULL',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);
        try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_portal_sessions_token ON ${T.sessions} (token)`); }
        catch (e) { console.error('[vendor-marketplace] could not create the portal session index:', e.message); }
        await createIndex(`${P}idx_portal_sessions_expires`, T.sessions, 'expires_at');
    }
    await initSchema();

    // ---- plugin-private settings helpers ---------------------------------------------------------
    const getSetting = async (name, fallback) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row && row.value != null && row.value !== '' ? row.value : fallback;
    };
    // NOTE: no `ON CONFLICT ... DO UPDATE` here — the host's SQL table-attribution guard misreads
    // the `UPDATE` keyword inside the conflict clause as a table reference ('set') and denies the
    // statement. Two guard-safe single statements instead: UPDATE first, INSERT if nothing matched.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes !== 1) {
            await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };
    const getCurrencySymbol = () => getSetting('currency_symbol', '$');

    // ---- shared validation helpers ---------------------------------------------------------------
    const cleanStr = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ''));
    // Accept only absolute http(s) URLs or origin-relative PATHS for images/logos; '' means "none".
    // A protocol-relative '//evil.host/x.png' (or the '/\\evil.host' spelling browsers normalise to
    // it) starts with '/' but points off-site, so it is refused; so is any whitespace/control char.
    const badUrl = (v) => {
        if (v === '') return false;
        if (/[\s\\\u0000-\u001f\u007f]/.test(v)) return true;
        if (/^https?:\/\/[^/?#]+/i.test(v)) return false;
        return !(v.charAt(0) === '/' && v.charAt(1) !== '/');
    };
    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const slugify = (s) => String(s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

    /** Derive a unique vendor slug from the store name (random suffix on collision). */
    async function uniqueSlug(name, excludeId) {
        let base = slugify(name);
        if (!base) base = 'tienda';
        let slug = base;
        for (let i = 0; i < 5; i++) {
            const clash = excludeId
                ? await db.get(`SELECT id FROM ${T.vendors} WHERE slug = ? AND id != ?`, [slug, excludeId])
                : await db.get(`SELECT id FROM ${T.vendors} WHERE slug = ?`, [slug]);
            if (!clash) return slug;
            slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
        }
        return `${base}-${Date.now().toString(36)}`;
    }

    // Public and portal callers never see an error's text: a driver's message names tables, columns
    // and constraints (a slug collision answered 'UNIQUE constraint failed: <table>.slug'). The
    // details go to the server log.
    const failQuietly = (res, e, what) => {
        console.error(`[vendor-marketplace] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };

    /**
     * Insert a store, at most one per email address: the INSERT fills email_claim, and the unique
     * index refuses a second store for the address even when the requests run at the same time (the
     * duplicate check before it cannot see a simultaneous INSERT). A slug taken meanwhile — two stores
     * with the same name at once — gets a fresh one. Returns { id, slug }, or { duplicate: true }.
     */
    async function insertVendor(cols, values, name, email) {
        for (let attempt = 1; attempt <= 5; attempt++) {
            const slug = await uniqueSlug(name);
            try {
                const r = await db.run(
                    `INSERT INTO ${T.vendors} (${cols.join(', ')}, slug, email_claim) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
                    [...values, slug, email]
                );
                return { id: r ? r.lastID : null, slug };
            } catch (e) {
                // Which unique index refused it? Ask the table, not the driver's message.
                if (await db.get(`SELECT id FROM ${T.vendors} WHERE email_claim = ?`, [email])) return { duplicate: true };
                if (!(await db.get(`SELECT id FROM ${T.vendors} WHERE slug = ?`, [slug]))) throw e;
                // The slug was taken meanwhile: derive another one.
            }
        }
        throw new Error('no free store slug after 5 attempts');
    }

    /** Integer cents, 0..cap — the ONLY accepted money shape (never floats, never client totals). */
    const parsePriceCents = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= LIM.priceCents ? n : null;
    };
    const parseCommission = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
    };
    const parseId = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    };

    /**
     * 6-digit access code. The sandbox's static validator blocks crypto access paths, so Math.random
     * is the only RNG — brute force is bounded by the per-vendor login throttle below, which is the
     * real defense for a short numeric code regardless of the RNG.
     */
    async function genAccessCode() {
        // CSPRNG via the host bridge (audit MEDIUM: Math.random is predictable / state-reconstructable).
        return String(await wordjs.crypto.randomInt(100000, 1000000)); // uniform 6-digit
    }

    // ---- anti-abuse: per-route rate caps PER CLIENT -------------------------------------------------
    // Keyed by req.clientKey (an HMAC of the caller's IP forwarded by the host). They used to be
    // site-wide windows, so one client could close vendor applications or buyer inquiries for
    // everyone. Each call checks AND counts in one synchronous step. The map is bounded so key churn
    // cannot grow it without limit.
    const makeLimiter = (max, windowMs) => {
        const windows = new Map(); // clientKey -> { count, windowStart }
        return (req) => {
            const key = String((req && req.clientKey) || 'anon').slice(0, 64);
            const now = Date.now();
            let w = windows.get(key);
            if (!w || now - w.windowStart >= windowMs) {
                if (windows.size >= 10000) {
                    for (const [k, v] of windows) if (now - v.windowStart >= windowMs) windows.delete(k);
                    while (windows.size >= 10000) windows.delete(windows.keys().next().value);
                }
                w = { count: 0, windowStart: now };
                windows.set(key, w);
            }
            w.count++;
            return w.count <= max;
        };
    };
    const applyAllowed = makeLimiter(3, 60 * 1000);    // 3 vendor applications per client per minute
    const inquiryAllowed = makeLimiter(5, 60 * 1000);  // 5 buyer inquiries per client per minute

    /** Honeypot + minimum fill time. Bots get a FAKE SUCCESS (no insert, no signal). */
    const looksLikeSpam = (body) => {
        if (String((body && body.hp) || '').trim() !== '') return true;
        const elapsed = Number(body && body.elapsed);
        return !(Number.isFinite(elapsed) && elapsed >= 3000);
    };

    // ---- portal-login throttle (1.0.3) -----------------------------------------------------------
    // Only WRONG codes are counted, against three fixed-window budgets:
    //   - per client + vendor (req.clientKey = the host's HMAC of the caller's address): the ONLY
    //     budget that refuses. Another client's mistakes never lock this one out, and a right code
    //     clears only the caller's own count. It is charged synchronously BEFORE the code check is
    //     awaited (so a parallel burst cannot outrun it) and refunded when the code is right;
    //   - per vendor, all clients together, and site-wide: bound guessing spread over many addresses
    //     and many vendors by slowing every attempt down once spent (escalating delay), never by
    //     refusing — a right code is never turned away for other callers' wrong ones. Only wrong codes
    //     for a vendor that exists are charged to them.
    // Signed-in vendors never meet this: the portal session is an opaque server-side id (below), not
    // something that carries the code. Single child process → in-memory maps are the whole picture;
    // every map is bounded.
    const LOGIN_LIMITS = {
        perClient: 6, clientWindowMs: 10 * 60 * 1000,
        perVendor: 20, perSite: 100, sharedWindowMs: 60 * 60 * 1000,
        // Past a shared budget every attempt waits before its code is checked: delayBaseMs, doubling
        // every delayDoubleEvery further wrong codes, up to delayMaxMs.
        delayBaseMs: 250, delayDoubleEvery: 10, delayMaxMs: 8000,
    };
    const LOGIN_MAP_CAP = 5000;
    const loginBuckets = { client: new Map(), vendor: new Map(), site: new Map() };
    const loginBucket = (map, key, windowMs, now) => {
        let b = map.get(key);
        if (!b || now - b.first >= windowMs) {
            if (!b && map.size >= LOGIN_MAP_CAP) {
                for (const [k, v] of map) if (now - v.first >= windowMs) map.delete(k);
                while (map.size >= LOGIN_MAP_CAP) map.delete(map.keys().next().value);
            }
            b = { count: 0, first: now };
            map.set(key, b);
        }
        return b;
    };
    /** A bucket's live count, without creating one (an unknown id never becomes a map key). */
    const loginCount = (map, key, windowMs, now) => {
        const b = map.get(key);
        return b && now - b.first < windowMs ? b.count : 0;
    };
    /**
     * Charge one attempt for `vendorId` to the caller's own budget: null when it is spent (the only
     * refusal), else { delayMs, failed(), succeeded() }. `delayMs` is how long the attempt waits before
     * its code is checked, from the shared budgets; failed() charges them (call it only for a wrong
     * code on a vendor that exists); succeeded() refunds the caller's own attempt.
     */
    const beginLoginAttempt = (req, vendorId) => {
        const now = Date.now(), L = LOGIN_LIMITS;
        const clientKey = `${String((req && req.clientKey) || 'anon').slice(0, 64)}|${vendorId}`;
        const own = loginBucket(loginBuckets.client, clientKey, L.clientWindowMs, now);
        if (own.count >= L.perClient) return null;
        own.count++;
        const excess = Math.max(
            loginCount(loginBuckets.vendor, String(vendorId), L.sharedWindowMs, now) - L.perVendor,
            loginCount(loginBuckets.site, '*', L.sharedWindowMs, now) - L.perSite
        );
        const delayMs = excess < 0 ? 0
            : Math.min(L.delayMaxMs, L.delayBaseMs * 2 ** Math.floor(excess / L.delayDoubleEvery));
        let settled = false;
        return {
            delayMs,
            failed() {
                if (settled) return;
                settled = true;
                const at = Date.now();
                loginBucket(loginBuckets.vendor, String(vendorId), L.sharedWindowMs, at).count++;
                loginBucket(loginBuckets.site, '*', L.sharedWindowMs, at).count++;
            },
            succeeded() {
                if (settled) return;
                settled = true;
                loginBuckets.client.delete(clientKey); // the caller's own record only
            },
        };
    };
    const loginPause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

    // ---- portal sessions (1.0.2) -------------------------------------------------------------------
    // A login mints an opaque random id (host CSPRNG, 256 bits) stored server-side with the vendor and
    // the access code it was opened with. The host NAMESPACES any cookie the plugin sets — the value is
    // stored under the namespaced cookie name below — and forwards the `x-portal-token` header verbatim;
    // accept either. Every request re-reads the vendor: a new access code, a suspension or a deletion
    // ends every session at once. The id carries nothing guessable, so this path needs no throttle.
    const PORTAL_COOKIE = `${db.tablePrefix}wordjs_portal_token`;
    const PORTAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const PORTAL_TOKEN_RE = /^[0-9a-f]{64}$/;
    // Expiry as a fixed-width ms string: compares correctly as text on every engine.
    const expiryText = (ms) => String(Math.floor(ms)).padStart(15, '0');
    async function createPortalSession(vendor) {
        const token = String(await wordjs.crypto.randomToken(32));
        const now = Date.now();
        await db.run(`DELETE FROM ${T.sessions} WHERE expires_at < ?`, [expiryText(now)]);
        await db.run(
            `INSERT INTO ${T.sessions} (token, vendor_id, access_code, expires_at) VALUES (?, ?, ?, ?)`,
            [token, vendor.id, String(vendor.access_code), expiryText(now + PORTAL_TOKEN_TTL_MS)]
        );
        return token;
    }
    const portalTokenOf = (req) => {
        const cookies = req.cookies || {};
        const token = cookies[PORTAL_COOKIE] || cookies.wordjs_portal_token || (req.headers && req.headers['x-portal-token']);
        return typeof token === 'string' && PORTAL_TOKEN_RE.test(token) ? token : null;
    };
    async function resolvePortalVendor(req) {
        const token = portalTokenOf(req);
        if (!token) return null;
        try {
            const vendor = await db.get(
                `SELECT v.* FROM ${T.sessions} s JOIN ${T.vendors} v ON v.id = s.vendor_id
                 WHERE s.token = ? AND s.expires_at > ? AND v.status = 'approved' AND v.access_code = s.access_code`,
                [token, expiryText(Date.now())]
            );
            return vendor || null;
        } catch (e) {
            return null;
        }
    }

    /** Public projection of a vendor for the portal (never echoes the access code). */
    const vendorSafe = (v) => ({
        id: v.id, name: v.name, slug: v.slug, email: v.email, phone: v.phone,
        description: v.description, logo_url: v.logo_url, commission_pct: v.commission_pct,
    });

    // ================================ PUBLIC API ==================================================

    // Public config for the block (currency symbol is not a secret).
    http.route('get', '/public/config', async (req, res) => {
        try {
            res.json({ currencySymbol: await getCurrencySymbol() });
        } catch (e) { failQuietly(res, e, 'public config'); }
    });

    // Vendor application. Anti-spam: honeypot + minimum fill time (fake success) + per-client rate cap.
    // The access code is NOT generated here — it is created when the admin approves the store.
    // Every accepted-looking outcome (stored, duplicate address, spam) answers the SAME body, so the
    // reply cannot tell a probe whether an address already has a store.
    const APPLY_RECEIVED = { success: true, message: 'Solicitud recibida. Te avisaremos por email cuando tu tienda sea aprobada.' };
    http.route('post', '/public/apply', async (req, res) => {
        try {
            const body = req.body || {};
            if (looksLikeSpam(body)) return res.json(APPLY_RECEIVED);
            if (!applyAllowed(req)) {
                return res.status(429).json({ error: 'Demasiadas solicitudes en este momento. Inténtalo de nuevo en un minuto.' });
            }
            const name = cleanStr(body.name, LIM.name);
            const email = normEmail(body.email);
            const phone = cleanStr(body.phone, LIM.phone);
            const description = cleanStr(body.description, LIM.description);
            if (!name) return res.status(400).json({ error: 'El nombre de la tienda es obligatorio.' });
            if (!isEmail(email)) return res.status(400).json({ error: 'El email no es válido.' });

            // Anti-enumeration: a duplicate email stores nothing and gets the same reply. The check
            // answers the sequential case (and stores from before 1.0.1 that hold no claim);
            // insertVendor's unique email claim refuses a simultaneous duplicate. The authenticated
            // admin POST /vendors keeps its explicit 409.
            const dup = await db.get(`SELECT id FROM ${T.vendors} WHERE email = ? OR email_claim = ?`, [email, email]);
            if (dup) return res.json(APPLY_RECEIVED);
            await insertVendor(['name', 'email', 'phone', 'description', 'status'], [name, email, phone, description, 'pending'], name, email);
            res.json(APPLY_RECEIVED);
        } catch (e) { failQuietly(res, e, 'vendor application'); }
    });

    // Approved vendors with their published-product count (no emails/phones on public routes).
    http.route('get', '/public/vendors', async (req, res) => {
        try {
            const list = await db.all(`
                SELECT v.id, v.name, v.slug, v.description, v.logo_url,
                       (SELECT COUNT(*) FROM ${T.products} p WHERE p.vendor_id = v.id AND p.is_published = 1) AS product_count
                FROM ${T.vendors} v
                WHERE v.status = 'approved'
                ORDER BY v.name
            `);
            res.json(list);
        } catch (e) { failQuietly(res, e, 'vendor list'); }
    });

    // Published products of approved vendors. Filters: ?vendor= (id or slug), ?category=, ?search=, ?limit=.
    http.route('get', '/public/products', async (req, res) => {
        try {
            const q = req.query || {};
            const where = [`p.is_published = 1`, `v.status = 'approved'`];
            const params = [];
            const vendor = cleanStr(q.vendor, LIM.name);
            if (vendor) {
                if (/^\d+$/.test(vendor)) { where.push('v.id = ?'); params.push(Number(vendor)); }
                else { where.push('v.slug = ?'); params.push(vendor); }
            }
            const category = cleanStr(q.category, LIM.category);
            if (category) { where.push('p.category = ?'); params.push(category); }
            const search = cleanStr(q.search, 100).toLowerCase();
            if (search) {
                const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
                where.push(`(LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '\\')`);
                params.push(like, like);
            }
            let limit = parseInt(q.limit, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 60;
            limit = Math.min(limit, 200);
            params.push(limit);

            const list = await db.all(`
                SELECT p.id, p.name, p.description, p.price_cents, p.image_url, p.category,
                       v.id AS vendor_id, v.name AS vendor_name, v.slug AS vendor_slug
                FROM ${T.products} p
                JOIN ${T.vendors} v ON p.vendor_id = v.id
                WHERE ${where.join(' AND ')}
                ORDER BY p.created_at DESC, p.id DESC
                LIMIT ?
            `, params);
            res.json(list);
        } catch (e) { failQuietly(res, e, 'product list'); }
    });

    // Buyer inquiry on a product → recorded + best-effort email to the vendor (lead generation).
    http.route('post', '/public/inquiry', async (req, res) => {
        try {
            const body = req.body || {};
            if (looksLikeSpam(body)) {
                return res.json({ success: true, message: 'Consulta enviada. El vendedor te contactará pronto.' });
            }
            if (!inquiryAllowed(req)) {
                return res.status(429).json({ error: 'Demasiadas consultas en este momento. Inténtalo de nuevo en un minuto.' });
            }
            const productId = parseId(body.product_id);
            const buyerName = cleanStr(body.buyer_name, LIM.name);
            const buyerEmail = cleanStr(body.buyer_email, LIM.email).toLowerCase();
            const message = cleanStr(body.message, LIM.message);
            if (!productId) return res.status(400).json({ error: 'Producto inválido.' });
            if (!buyerName) return res.status(400).json({ error: 'Tu nombre es obligatorio.' });
            if (!isEmail(buyerEmail)) return res.status(400).json({ error: 'El email no es válido.' });
            if (!message) return res.status(400).json({ error: 'Escribe un mensaje para el vendedor.' });

            // The product must be visible on the public marketplace (published + approved vendor).
            const product = await db.get(`
                SELECT p.id, p.name, p.vendor_id, v.name AS vendor_name, v.email AS vendor_email
                FROM ${T.products} p
                JOIN ${T.vendors} v ON p.vendor_id = v.id
                WHERE p.id = ? AND p.is_published = 1 AND v.status = 'approved'
            `, [productId]);
            if (!product) return res.status(404).json({ error: 'El producto no está disponible.' });

            await db.run(
                `INSERT INTO ${T.inquiries} (product_id, vendor_id, buyer_name, buyer_email, message, status) VALUES (?, ?, ?, ?, ?, 'new')`,
                [product.id, product.vendor_id, buyerName, buyerEmail, message]
            );

            // Best-effort mail to the vendor — the inquiry is already recorded either way.
            try {
                await wordjs.mail({
                    to: product.vendor_email,
                    subject: `Nueva consulta sobre "${product.name}"`,
                    text: `${buyerName} (${buyerEmail}) pregunta por "${product.name}":\n\n${message}\n\nResponde directamente a ${buyerEmail} o gestiona la consulta desde tu portal de vendedor.`,
                    html: `<p><strong>${escapeHtml(buyerName)}</strong> (${escapeHtml(buyerEmail)}) pregunta por <strong>${escapeHtml(product.name)}</strong>:</p>`
                        + `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
                        + `<p>Responde directamente a <a href="mailto:${escapeHtml(buyerEmail)}">${escapeHtml(buyerEmail)}</a> o gestiona la consulta desde tu portal de vendedor.</p>`,
                });
            } catch (mailErr) {
                console.warn('[marketplace] inquiry mail failed:', mailErr.message);
            }
            res.json({ success: true, message: 'Consulta enviada. El vendedor te contactará pronto.' });
        } catch (e) { failQuietly(res, e, 'buyer inquiry'); }
    });

    // ================================ VENDOR PORTAL ===============================================

    // Login with vendor + 6-digit code. The attempt is charged to the caller's budget BEFORE touching the
    // DB and refunded only when the code is right (beginLoginAttempt).
    http.route('post', '/portal/login', async (req, res) => {
        const body = req.body || {};
        // Validate the id BEFORE it can become a throttle-map key (bounds attacker-chosen keys).
        const vendorId = parseId(body.vendor_id);
        const code = String(body.code == null ? '' : body.code).trim();
        try {
            if (!vendorId) return res.status(400).json({ error: 'Tienda inválida.' });
            const attempt = beginLoginAttempt(req, vendorId);
            if (!attempt) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
            }
            await loginPause(attempt.delayMs);
            // Status before code would tell a stranger which stores are pending/suspended without the
            // code; the code is checked first (a wrong one stays charged).
            const vendor = await db.get(`SELECT * FROM ${T.vendors} WHERE id = ?`, [vendorId]);
            if (!vendor || !vendor.access_code || String(vendor.access_code) !== code) {
                if (vendor) attempt.failed();
                return res.status(401).json({ error: 'Código incorrecto.' });
            }
            attempt.succeeded();
            if (vendor.status === 'pending') return res.status(403).json({ error: 'Tu tienda aún no fue aprobada.' });
            if (vendor.status !== 'approved') return res.status(403).json({ error: 'Tu tienda está suspendida. Contacta al administrador.' });

            // Opaque server-side session (createPortalSession): the token carries no code.
            const token = await createPortalSession(vendor);

            // The host namespaces the cookie to `${tablePrefix}wordjs_portal_token` and clamps its
            // flags; the client ALSO receives the token to send via the x-portal-token header.
            res.cookie('wordjs_portal_token', token, {
                httpOnly: true,
                sameSite: 'strict',
                maxAge: PORTAL_TOKEN_TTL_MS,
            });
            res.json({ success: true, token, vendor: vendorSafe(vendor) });
        } catch (e) { failQuietly(res, e, 'portal login'); }
    });

    http.route('get', '/portal/me', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        res.json(vendorSafe(vendor));
    });

    // Clear the namespaced session cookie so a refresh on a shared device does not re-authenticate.
    // The session row goes too, so the token is dead everywhere, not just in this browser.
    http.route('post', '/portal/logout', async (req, res) => {
        const token = portalTokenOf(req);
        if (token) {
            try { await db.run(`DELETE FROM ${T.sessions} WHERE token = ?`, [token]); }
            catch (e) { console.warn('[marketplace] portal logout: session not removed:', e.message); }
        }
        res.clearCookie('wordjs_portal_token', { path: '/' });
        res.json({ success: true });
    });

    // Own products only — every portal query is scoped by the vendor id resolved from the token.
    http.route('get', '/portal/products', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        try {
            const list = await db.all(
                `SELECT * FROM ${T.products} WHERE vendor_id = ? ORDER BY created_at DESC, id DESC`,
                [vendor.id]
            );
            res.json(list);
        } catch (e) { failQuietly(res, e, 'portal product list'); }
    });

    // Create (no id) or update (id present) one of the vendor's OWN products.
    http.route('post', '/portal/products', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        try {
            const body = req.body || {};
            const name = cleanStr(body.name, LIM.productName);
            const description = cleanStr(body.description, LIM.description);
            const category = cleanStr(body.category, LIM.category);
            const imageUrl = cleanStr(body.image_url, LIM.url);
            if (!name) return res.status(400).json({ error: 'El nombre del producto es obligatorio.' });
            if (badUrl(imageUrl)) return res.status(400).json({ error: 'La URL de la imagen no es válida (usa https:// o una ruta del sitio).' });
            const priceCents = parsePriceCents(body.price_cents);
            if (priceCents === null) return res.status(400).json({ error: 'Precio inválido (entero en centavos, 0 o más).' });
            const isPublished = body.is_published === 0 || body.is_published === false || body.is_published === '0' ? 0 : 1;

            if (body.id !== undefined && body.id !== null && body.id !== '') {
                const id = parseId(body.id);
                if (!id) return res.status(400).json({ error: 'Producto inválido.' });
                // Ownership is enforced IN the statement (id AND vendor_id) — no read-then-write gap.
                // A product the admin hid (admin_hidden = 1) stays unpublished whatever the vendor
                // sends: the vendor's flag can only ever narrow visibility, never undo moderation.
                const result = await db.run(
                    `UPDATE ${T.products} SET name = ?, description = ?, price_cents = ?, image_url = ?, category = ?,
                        is_published = CASE WHEN admin_hidden = 1 THEN 0 ELSE ? END
                     WHERE id = ? AND vendor_id = ?`,
                    [name, description, priceCents, imageUrl, category, isPublished, id, vendor.id]
                );
                if (!result || result.changes !== 1) return res.status(404).json({ error: 'Producto no encontrado.' });
                return res.json({ success: true, id });
            }

            const result = await db.run(
                `INSERT INTO ${T.products} (vendor_id, name, description, price_cents, image_url, category, is_published) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [vendor.id, name, description, priceCents, imageUrl, category, isPublished]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { failQuietly(res, e, 'portal product save'); }
    });

    http.route('delete', '/portal/products/:id', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Producto inválido.' });
            const result = await db.run(`DELETE FROM ${T.products} WHERE id = ? AND vendor_id = ?`, [id, vendor.id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Producto no encontrado.' });
            res.json({ success: true });
        } catch (e) { failQuietly(res, e, 'portal product delete'); }
    });

    http.route('get', '/portal/inquiries', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        try {
            const list = await db.all(`
                SELECT i.*, p.name AS product_name
                FROM ${T.inquiries} i
                LEFT JOIN ${T.products} p ON i.product_id = p.id
                WHERE i.vendor_id = ?
                ORDER BY i.created_at DESC, i.id DESC
            `, [vendor.id]);
            res.json(list);
        } catch (e) { failQuietly(res, e, 'portal inquiry list'); }
    });

    http.route('post', '/portal/inquiries/:id/status', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        try {
            const id = parseId(req.params.id);
            const status = String((req.body && req.body.status) || '');
            if (!id) return res.status(400).json({ error: 'Consulta inválida.' });
            if (!INQUIRY_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const result = await db.run(
                `UPDATE ${T.inquiries} SET status = ? WHERE id = ? AND vendor_id = ?`,
                [status, id, vendor.id]
            );
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Consulta no encontrada.' });
            res.json({ success: true });
        } catch (e) { failQuietly(res, e, 'portal inquiry status'); }
    });

    // ================================ ADMIN API ===================================================

    http.route('get', '/vendors', { auth: true, admin: true }, async (req, res) => {
        try {
            const status = String((req.query && req.query.status) || '');
            const where = VENDOR_STATUSES.includes(status) ? 'WHERE v.status = ?' : '';
            const params = where ? [status] : [];
            const list = await db.all(`
                SELECT v.*,
                       (SELECT COUNT(*) FROM ${T.products} p WHERE p.vendor_id = v.id) AS product_count,
                       (SELECT COUNT(*) FROM ${T.inquiries} i WHERE i.vendor_id = v.id) AS inquiry_count
                FROM ${T.vendors} v
                ${where}
                ORDER BY CASE v.status WHEN 'pending' THEN 0 ELSE 1 END, v.created_at DESC, v.id DESC
            `, params);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create a vendor directly approved, with an access code already generated.
    http.route('post', '/vendors', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const name = cleanStr(body.name, LIM.name);
            const email = normEmail(body.email);
            const phone = cleanStr(body.phone, LIM.phone);
            const description = cleanStr(body.description, LIM.description);
            const logoUrl = cleanStr(body.logo_url, LIM.url);
            if (!name) return res.status(400).json({ error: 'El nombre es obligatorio.' });
            if (!isEmail(email)) return res.status(400).json({ error: 'El email no es válido.' });
            if (badUrl(logoUrl)) return res.status(400).json({ error: 'La URL del logo no es válida.' });
            const commission = body.commission_pct === undefined ? 0 : parseCommission(body.commission_pct);
            if (commission === null) return res.status(400).json({ error: 'La comisión debe ser un entero entre 0 y 100.' });

            const DUP_MSG = 'Ya existe una tienda con ese email.';
            const dup = await db.get(`SELECT id FROM ${T.vendors} WHERE email = ? OR email_claim = ?`, [email, email]);
            if (dup) return res.status(409).json({ error: DUP_MSG });

            const code = await genAccessCode();
            const stored = await insertVendor(
                ['name', 'email', 'phone', 'description', 'logo_url', 'access_code', 'status', 'commission_pct'],
                [name, email, phone, description, logoUrl, code, 'approved', commission], name, email);
            if (stored.duplicate) return res.status(409).json({ error: DUP_MSG });
            res.json({ success: true, id: stored.id, access_code: code, slug: stored.slug });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Approve a vendor: (re)activate, generate a code if it has none, best-effort mail it.
    http.route('post', '/vendors/:id/approve', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            if (!await db.get(`SELECT id FROM ${T.vendors} WHERE id = ?`, [id])) return res.status(404).json({ error: 'Tienda no encontrada.' });

            // Keep an existing code on re-approval (suspend -> approve) so the vendor isn't locked out;
            // the admin can rotate it explicitly if needed. "Keep" is decided IN the statement: the code
            // used to be read first and written back, so a rotation landing in between was undone and the
            // code it retired (perhaps leaked — the reason to rotate) opened the portal again. The new
            // code is written only when the row has none; the mail and the reply carry the stored one.
            const fresh = await genAccessCode();
            const result = await db.run(
                `UPDATE ${T.vendors} SET status = 'approved',
                    access_code = CASE WHEN access_code IS NULL OR access_code = '' THEN ? ELSE access_code END
                 WHERE id = ?`,
                [fresh, id]
            );
            const vendor = result && result.changes === 1 ? await db.get(`SELECT * FROM ${T.vendors} WHERE id = ?`, [id]) : null;
            if (!vendor) return res.status(404).json({ error: 'Tienda no encontrada.' });
            const code = vendor.access_code;

            let mailed = false;
            try {
                await wordjs.mail({
                    to: vendor.email,
                    subject: 'Tu tienda fue aprobada en el marketplace',
                    text: `Hola ${vendor.name}:\n\nTu tienda fue aprobada. Tu código de acceso es: ${code}\n\nIngresa al portal de vendedores desde el enlace "Acceso vendedores" en la página del marketplace del sitio, selecciona tu tienda e introduce el código para gestionar tus productos y consultas.`,
                    html: `<p>Hola <strong>${escapeHtml(vendor.name)}</strong>:</p>`
                        + `<p>Tu tienda fue aprobada. Tu código de acceso es: <strong style="font-size:1.2em">${escapeHtml(code)}</strong></p>`
                        + `<p>Ingresa al portal de vendedores desde el enlace <em>"Acceso vendedores"</em> en la página del marketplace del sitio, selecciona tu tienda e introduce el código para gestionar tus productos y consultas.</p>`,
                });
                mailed = true;
            } catch (mailErr) {
                console.warn('[marketplace] approval mail failed:', mailErr.message);
            }
            res.json({ success: true, access_code: code, mailed, note: mailed ? undefined : 'correo no enviado' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/vendors/:id/suspend', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            const result = await db.run(`UPDATE ${T.vendors} SET status = 'suspended' WHERE id = ?`, [id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Tienda no encontrada.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // New access code — outstanding portal tokens die instantly (code is DB-checked per request).
    http.route('post', '/vendors/:id/rotate-code', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            const code = await genAccessCode();
            const result = await db.run(`UPDATE ${T.vendors} SET access_code = ? WHERE id = ?`, [code, id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Tienda no encontrada.' });
            res.json({ success: true, access_code: code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Partial update of vendor metadata. Only fields present in the body are changed.
    http.route('put', '/vendors/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            const vendor = await db.get(`SELECT * FROM ${T.vendors} WHERE id = ?`, [id]);
            if (!vendor) return res.status(404).json({ error: 'Tienda no encontrada.' });

            const body = req.body || {};
            const sets = [], params = [];
            if (body.name !== undefined) {
                const v = cleanStr(body.name, LIM.name);
                if (!v) return res.status(400).json({ error: 'El nombre es obligatorio.' });
                sets.push('name = ?'); params.push(v);
            }
            const EMAIL_IN_USE = 'Ese email ya está en uso por otra tienda.';
            let newEmail = null;
            if (body.email !== undefined) {
                const v = normEmail(body.email);
                if (!isEmail(v)) return res.status(400).json({ error: 'El email no es válido.' });
                const clash = await db.get(`SELECT id FROM ${T.vendors} WHERE (email = ? OR email_claim = ?) AND id != ?`, [v, v, id]);
                if (clash) return res.status(409).json({ error: EMAIL_IN_USE });
                // The claim moves with the address, so two simultaneous edits cannot both take it.
                sets.push('email = ?', 'email_claim = ?'); params.push(v, v);
                newEmail = v;
            }
            if (body.phone !== undefined) { sets.push('phone = ?'); params.push(cleanStr(body.phone, LIM.phone)); }
            if (body.description !== undefined) { sets.push('description = ?'); params.push(cleanStr(body.description, LIM.description)); }
            if (body.logo_url !== undefined) {
                const v = cleanStr(body.logo_url, LIM.url);
                if (badUrl(v)) return res.status(400).json({ error: 'La URL del logo no es válida.' });
                sets.push('logo_url = ?'); params.push(v);
            }
            if (body.commission_pct !== undefined) {
                const v = parseCommission(body.commission_pct);
                if (v === null) return res.status(400).json({ error: 'La comisión debe ser un entero entre 0 y 100.' });
                sets.push('commission_pct = ?'); params.push(v);
            }
            if (!sets.length) return res.json({ success: true });
            params.push(id);
            try {
                await db.run(`UPDATE ${T.vendors} SET ${sets.join(', ')} WHERE id = ?`, params);
            } catch (e) {
                if (newEmail && await db.get(`SELECT id FROM ${T.vendors} WHERE email_claim = ? AND id != ?`, [newEmail, id])) {
                    return res.status(409).json({ error: EMAIL_IN_USE });
                }
                throw e;
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Delete a vendor and CASCADE its products + inquiries (explicit deletes — FK cascade is not
    // guaranteed to be enabled on every driver).
    http.route('delete', '/vendors/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            await db.run(`DELETE FROM ${T.inquiries} WHERE vendor_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.products} WHERE vendor_id = ?`, [id]);
            const result = await db.run(`DELETE FROM ${T.vendors} WHERE id = ?`, [id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Tienda no encontrada.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('get', '/products', { auth: true, admin: true }, async (req, res) => {
        try {
            const list = await db.all(`
                SELECT p.*, v.name AS vendor_name, v.slug AS vendor_slug, v.status AS vendor_status
                FROM ${T.products} p
                JOIN ${T.vendors} v ON p.vendor_id = v.id
                ORDER BY p.created_at DESC, p.id DESC
            `);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Admin publish/unpublish toggle (moderation).
    http.route('post', '/products/:id/publish', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Producto inválido.' });
            const flag = req.body && (req.body.is_published === 1 || req.body.is_published === true || req.body.is_published === '1') ? 1 : 0;
            // Hiding sets the moderation flag the vendor portal cannot clear; publishing clears it.
            const result = await db.run(`UPDATE ${T.products} SET is_published = ?, admin_hidden = ? WHERE id = ?`, [flag, flag ? 0 : 1, id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Producto no encontrado.' });
            res.json({ success: true, is_published: flag });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/products/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Producto inválido.' });
            const result = await db.run(`DELETE FROM ${T.products} WHERE id = ?`, [id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Producto no encontrado.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('get', '/inquiries', { auth: true, admin: true }, async (req, res) => {
        try {
            const list = await db.all(`
                SELECT i.*, p.name AS product_name, v.name AS vendor_name
                FROM ${T.inquiries} i
                LEFT JOIN ${T.products} p ON i.product_id = p.id
                JOIN ${T.vendors} v ON i.vendor_id = v.id
                ORDER BY i.created_at DESC, i.id DESC
            `);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Admin can also update inquiry status (mirrors the portal action).
    http.route('post', '/inquiries/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            const status = String((req.body && req.body.status) || '');
            if (!id) return res.status(400).json({ error: 'Consulta inválida.' });
            if (!INQUIRY_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const result = await db.run(`UPDATE ${T.inquiries} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || result.changes !== 1) return res.status(404).json({ error: 'Consulta no encontrada.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Per-vendor report: catalog/inquiry counts + informational commission (v1 has no checkout, so
    // there is no real transaction volume — commission_pct is an agreement the admin tracks here).
    http.route('get', '/report', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(`
                SELECT v.id, v.name, v.slug, v.status, v.commission_pct,
                       (SELECT COUNT(*) FROM ${T.products} p WHERE p.vendor_id = v.id) AS products,
                       (SELECT COUNT(*) FROM ${T.products} p WHERE p.vendor_id = v.id AND p.is_published = 1) AS published_products,
                       (SELECT COUNT(*) FROM ${T.inquiries} i WHERE i.vendor_id = v.id) AS inquiries,
                       (SELECT COUNT(*) FROM ${T.inquiries} i WHERE i.vendor_id = v.id AND i.status = 'new') AS new_inquiries,
                       (SELECT COALESCE(SUM(p.price_cents), 0) FROM ${T.products} p WHERE p.vendor_id = v.id AND p.is_published = 1) AS catalog_cents
                FROM ${T.vendors} v
                ORDER BY v.name
            `);
            res.json({
                vendors: rows,
                currencySymbol: await getCurrencySymbol(),
                note: 'Marketplace v1 genera leads (consultas por producto), sin checkout centralizado: la comisión es un acuerdo informativo, no se liquida automáticamente.',
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Plugin settings (currency symbol — display only, not a secret).
    http.route('get', '/settings', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({ currencySymbol: await getCurrencySymbol() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        try {
            const symbol = cleanStr(req.body && req.body.currencySymbol, LIM.symbol);
            if (!symbol) return res.status(400).json({ error: 'El símbolo de moneda es obligatorio (ej. $, €, COP$).' });
            await setSetting('currency_symbol', symbol);
            res.json({ success: true, currencySymbol: symbol });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    adminMenu.add({
        href: '/admin/plugin/vendor-marketplace',
        label: 'Marketplace',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'Marketplace', es: 'Marketplace', pt: 'Marketplace' },
        icon: 'fa-store',
        order: 70,
        cap: 'manage_options',
    });

    console.log('[marketplace] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — all state is per-request or in the DB.
};
