/**
 * WordJS Plugin: Marketplace — multi-vendor directory (v1 = lead generation).
 *
 * Flow: vendors apply publicly -> the admin approves -> the vendor receives a 6-digit access code
 * for a self-service PORTAL (same pattern as conference-manager: rate-limited code login, expiring
 * base64 token, host-namespaced cookie + x-portal-token header) where they manage their OWN product
 * listings and answer buyer inquiries. The public Puck block lists approved vendors' products with
 * vendor/category/search filtering; buyers contact a vendor through a per-product inquiry form.
 * There is NO centralized checkout in v1 — the marketplace generates leads and each vendor closes
 * the sale on their own channel (stated explicitly in the admin UI).
 *
 * Sandbox notes:
 *  - All tables live under the plugin prefix (db.tablePrefix) so they pass the host's default-deny
 *    SQL scoping. Schema is created idempotently with the FULL column set (ALTER is blocked).
 *  - Access codes come from the host CSPRNG (wordjs.crypto.randomInt), NOT Math.random; the per-vendor
 *    login throttle below (bounded attempts per rolling window) is defense-in-depth for the short code.
 *  - Money is stored as INTEGER CENTS (price_cents); clients render cents/100 with the configured
 *    currency symbol (a plain setting in the plugin's own table, not a secret).
 *  - Mail is best-effort: approval/inquiry emails are wrapped in try/catch and the operation
 *    succeeds anyway with a 'correo no enviado' note.
 */

exports.metadata = {
    name: 'Marketplace',
    version: '1.0.0',
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
    };

    // Input length caps (defense against oversized payloads bloating the DB).
    const LIM = {
        name: 120, email: 200, phone: 40, description: 2000, url: 500,
        category: 60, productName: 150, message: 3000, symbol: 8,
        priceCents: 100000000, // 1,000,000.00 in whatever currency — sanity cap
    };
    const VENDOR_STATUSES = ['pending', 'approved', 'suspended'];
    const INQUIRY_STATUSES = ['new', 'replied', 'closed'];

    // ---- schema (idempotent; full column set from day 1 — ALTER is blocked in the sandbox) -------
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
        ]);
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
            `FOREIGN KEY (vendor_id) REFERENCES ${T.vendors}(id) ON DELETE CASCADE`,
        ]);
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
    // Accept only http(s) or origin-relative URLs for images/logos; '' means "none".
    const badUrl = (v) => v !== '' && !/^https?:\/\//i.test(v) && v.charAt(0) !== '/';
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

    // ---- anti-abuse: global per-route rate caps (no req.ip in the sandbox → global windows) ------
    const makeLimiter = (max, windowMs) => {
        let count = 0, windowStart = 0;
        return () => {
            const now = Date.now();
            if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
            count++;
            return count <= max;
        };
    };
    const applyAllowed = makeLimiter(5, 60 * 1000);    // 5 vendor applications / minute
    const inquiryAllowed = makeLimiter(10, 60 * 1000); // 10 buyer inquiries / minute

    /** Honeypot + minimum fill time. Bots get a FAKE SUCCESS (no insert, no signal). */
    const looksLikeSpam = (body) => {
        if (String((body && body.hp) || '').trim() !== '') return true;
        const elapsed = Number(body && body.elapsed);
        return !(Number.isFinite(elapsed) && elapsed >= 3000);
    };

    // Portal-login throttle per vendor (single child process → in-memory is sufficient).
    const LOGIN_MAX = 6, LOGIN_WINDOW_MS = 10 * 60 * 1000;
    const loginAttempts = new Map(); // vendor_id -> { count, first }
    const loginThrottled = (vendorId) => {
        const rec = loginAttempts.get(String(vendorId));
        return !!(rec && Date.now() - rec.first < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX);
    };
    const LOGIN_MAP_CAP = 1000;
    const noteLoginFailure = (vendorId) => {
        const now = Date.now(), key = String(vendorId);
        // Opportunistic eviction: once the map grows past the cap, drop entries whose window has
        // expired so spraying unique vendor ids cannot grow the child's memory without bound.
        if (loginAttempts.size > LOGIN_MAP_CAP) {
            for (const [k, r] of loginAttempts) {
                if (now - r.first >= LOGIN_WINDOW_MS) loginAttempts.delete(k);
            }
        }
        const rec = loginAttempts.get(key);
        if (!rec || now - rec.first >= LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, first: now });
        else rec.count++;
    };
    const clearLoginFailures = (vendorId) => loginAttempts.delete(String(vendorId));

    // Concurrency backstop (audit AUTH-A3 class): loginThrottled is check-then-arm and the code check
    // straddles awaited db.get calls, so a BURST of parallel guesses for one vendor would all clear the
    // throttle before noteLoginFailure arms it. Cap concurrent in-flight code verifications per vendor.
    const LOGIN_MAX_INFLIGHT = 3;
    const loginInflight = new Map(); // vendor_id -> count
    const beginLoginAttempt = (vendorId) => {
        const k = String(vendorId), n = loginInflight.get(k) || 0;
        if (n >= LOGIN_MAX_INFLIGHT) return false;
        loginInflight.set(k, n + 1);
        return true;
    };
    const endLoginAttempt = (vendorId) => {
        const k = String(vendorId), n = (loginInflight.get(k) || 0) - 1;
        if (n <= 0) loginInflight.delete(k); else loginInflight.set(k, n);
    };

    // ---- portal auth (copy of the conference-manager pattern) ------------------------------------
    // Session = base64 `id:code:expiry`. The host NAMESPACES any cookie the plugin sets — the value
    // is stored under the namespaced cookie name below — and forwards the `x-portal-token` header
    // verbatim; accept either. The code is re-checked against the DB on EVERY request, so rotating
    // or suspending a vendor invalidates any outstanding token immediately.
    const PORTAL_COOKIE = `${db.tablePrefix}wordjs_portal_token`;
    const PORTAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const makePortalToken = (id, code) => btoa(`${id}:${code}:${Date.now() + PORTAL_TOKEN_TTL_MS}`);
    async function resolvePortalVendor(req) {
        const cookies = req.cookies || {};
        const token = cookies[PORTAL_COOKIE] || cookies.wordjs_portal_token || (req.headers && req.headers['x-portal-token']);
        if (!token) return null;
        try {
            const decoded = atob(token);
            const parts = decoded.split(':');
            const id = Number(parts[0]), code = parts[1], exp = parts[2];
            // Canonicalize the id so "5"/"05"/"005" can't each get a fresh throttle budget (audit MEDIUM).
            if (!Number.isInteger(id) || id <= 0) return null;
            if (!exp || Date.now() > Number(exp)) return null;
            if (!code) return null;
            // Throttle the token path too — it was an unthrottled brute-force oracle for the 6-digit code
            // (attacker forges base64(id:guess:far-future) and reads 200-vs-401) (audit MEDIUM).
            if (loginThrottled(id)) return null;
            // Concurrency backstop (AUTH-A3 class): cap concurrent in-flight guesses per vendor so a burst
            // of forged tokens can't clear the throttle before noteLoginFailure arms it.
            if (!beginLoginAttempt(id)) return null;
            try {
                const vendor = await db.get(
                    `SELECT * FROM ${T.vendors} WHERE id = ? AND access_code = ? AND status = 'approved'`,
                    [id, code]
                );
                if (!vendor) { noteLoginFailure(id); return null; }
                clearLoginFailures(id);
                return vendor;
            } finally { endLoginAttempt(id); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Vendor application. Anti-spam: honeypot + minimum fill time (fake success) + global rate cap.
    // The access code is NOT generated here — it is created when the admin approves the store.
    http.route('post', '/public/apply', async (req, res) => {
        try {
            const body = req.body || {};
            if (looksLikeSpam(body)) {
                return res.json({ success: true, message: 'Solicitud recibida. Te contactaremos pronto.' });
            }
            if (!applyAllowed()) {
                return res.status(429).json({ error: 'Demasiadas solicitudes en este momento. Inténtalo de nuevo en un minuto.' });
            }
            const name = cleanStr(body.name, LIM.name);
            const email = cleanStr(body.email, LIM.email).toLowerCase();
            const phone = cleanStr(body.phone, LIM.phone);
            const description = cleanStr(body.description, LIM.description);
            if (!name) return res.status(400).json({ error: 'El nombre de la tienda es obligatorio.' });
            if (!isEmail(email)) return res.status(400).json({ error: 'El email no es válido.' });

            // Anti-enumeration: a duplicate email gets the SAME generic fake-success as the
            // honeypot path (nothing inserted) — a public probe cannot learn whether an email is
            // already registered. The authenticated admin POST /vendors keeps its explicit 409.
            const dup = await db.get(`SELECT id FROM ${T.vendors} WHERE email = ?`, [email]);
            if (dup) return res.json({ success: true, message: 'Solicitud recibida. Te contactaremos pronto.' });

            const slug = await uniqueSlug(name);
            await db.run(
                `INSERT INTO ${T.vendors} (name, slug, email, phone, description, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [name, slug, email, phone, description]
            );
            res.json({ success: true, message: 'Solicitud recibida. Te avisaremos por email cuando tu tienda sea aprobada.' });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Buyer inquiry on a product → recorded + best-effort email to the vendor (lead generation).
    http.route('post', '/public/inquiry', async (req, res) => {
        try {
            const body = req.body || {};
            if (looksLikeSpam(body)) {
                return res.json({ success: true, message: 'Consulta enviada. El vendedor te contactará pronto.' });
            }
            if (!inquiryAllowed()) {
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ================================ VENDOR PORTAL ===============================================

    // Login with vendor + 6-digit code. Rate-limited per vendor BEFORE touching the DB.
    http.route('post', '/portal/login', async (req, res) => {
        const body = req.body || {};
        // Validate the id BEFORE it can become a throttle-map key (bounds attacker-chosen keys).
        const vendorId = parseId(body.vendor_id);
        const code = String(body.code == null ? '' : body.code).trim();
        let acquired = false;
        try {
            if (!vendorId) return res.status(400).json({ error: 'Tienda inválida.' });
            if (loginThrottled(vendorId)) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
            }
            // Concurrency backstop (audit AUTH-A3 class): cap concurrent in-flight guesses per vendor so a
            // parallel burst can't clear the throttle before noteLoginFailure arms it. Released in finally.
            if (!(acquired = beginLoginAttempt(vendorId))) {
                return res.status(429).json({ error: 'Demasiados intentos simultáneos. Inténtalo de nuevo en un momento.' });
            }
            const vendor = await db.get(`SELECT * FROM ${T.vendors} WHERE id = ?`, [vendorId]);
            if (!vendor) { noteLoginFailure(vendorId); return res.status(404).json({ error: 'Tienda no encontrada.' }); }
            if (vendor.status === 'pending') return res.status(403).json({ error: 'Tu tienda aún no fue aprobada.' });
            if (vendor.status !== 'approved') return res.status(403).json({ error: 'Tu tienda está suspendida. Contacta al administrador.' });
            if (!vendor.access_code || String(vendor.access_code) !== code) {
                noteLoginFailure(vendorId);
                return res.status(401).json({ error: 'Código incorrecto.' });
            }
            clearLoginFailures(vendorId);

            // Stateless session token: base64(id:code:expiry). The code is the shared secret and is
            // re-checked against the DB on every portal request (resolvePortalVendor).
            const token = makePortalToken(vendor.id, vendor.access_code);

            // The host namespaces the cookie to `${tablePrefix}wordjs_portal_token` and clamps its
            // flags; the client ALSO receives the token to send via the x-portal-token header.
            res.cookie('wordjs_portal_token', token, {
                httpOnly: true,
                sameSite: 'strict',
                maxAge: PORTAL_TOKEN_TTL_MS,
            });
            res.json({ success: true, token, vendor: vendorSafe(vendor) });
        } catch (e) { res.status(500).json({ error: e.message }); }
        finally { if (acquired) endLoginAttempt(vendorId); }
    });

    http.route('get', '/portal/me', async (req, res) => {
        const vendor = await resolvePortalVendor(req);
        if (!vendor) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        res.json(vendorSafe(vendor));
    });

    // Clear the namespaced session cookie so a refresh on a shared device does not re-authenticate.
    http.route('post', '/portal/logout', async (req, res) => {
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
                const result = await db.run(
                    `UPDATE ${T.products} SET name = ?, description = ?, price_cents = ?, image_url = ?, category = ?, is_published = ? WHERE id = ? AND vendor_id = ?`,
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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
            const email = cleanStr(body.email, LIM.email).toLowerCase();
            const phone = cleanStr(body.phone, LIM.phone);
            const description = cleanStr(body.description, LIM.description);
            const logoUrl = cleanStr(body.logo_url, LIM.url);
            if (!name) return res.status(400).json({ error: 'El nombre es obligatorio.' });
            if (!isEmail(email)) return res.status(400).json({ error: 'El email no es válido.' });
            if (badUrl(logoUrl)) return res.status(400).json({ error: 'La URL del logo no es válida.' });
            const commission = body.commission_pct === undefined ? 0 : parseCommission(body.commission_pct);
            if (commission === null) return res.status(400).json({ error: 'La comisión debe ser un entero entre 0 y 100.' });

            const dup = await db.get(`SELECT id FROM ${T.vendors} WHERE email = ?`, [email]);
            if (dup) return res.status(409).json({ error: 'Ya existe una tienda con ese email.' });

            const slug = await uniqueSlug(name);
            const code = await genAccessCode();
            const result = await db.run(
                `INSERT INTO ${T.vendors} (name, slug, email, phone, description, logo_url, access_code, status, commission_pct) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`,
                [name, slug, email, phone, description, logoUrl, code, commission]
            );
            res.json({ success: true, id: result.lastID, access_code: code, slug });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Approve a vendor: (re)activate, generate a code if it has none, best-effort mail it.
    http.route('post', '/vendors/:id/approve', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) return res.status(400).json({ error: 'Tienda inválida.' });
            const vendor = await db.get(`SELECT * FROM ${T.vendors} WHERE id = ?`, [id]);
            if (!vendor) return res.status(404).json({ error: 'Tienda no encontrada.' });

            // Keep an existing code on re-approval (suspend -> approve) so the vendor isn't locked out;
            // the admin can rotate it explicitly if needed.
            const code = vendor.access_code || await genAccessCode();
            await db.run(`UPDATE ${T.vendors} SET status = 'approved', access_code = ? WHERE id = ?`, [code, id]);

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
            if (body.email !== undefined) {
                const v = cleanStr(body.email, LIM.email).toLowerCase();
                if (!isEmail(v)) return res.status(400).json({ error: 'El email no es válido.' });
                const clash = await db.get(`SELECT id FROM ${T.vendors} WHERE email = ? AND id != ?`, [v, id]);
                if (clash) return res.status(409).json({ error: 'Ese email ya está en uso por otra tienda.' });
                sets.push('email = ?'); params.push(v);
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
            await db.run(`UPDATE ${T.vendors} SET ${sets.join(', ')} WHERE id = ?`, params);
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
            const result = await db.run(`UPDATE ${T.products} SET is_published = ? WHERE id = ?`, [flag, id]);
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
        icon: 'fa-store',
        order: 70,
        cap: 'manage_options',
    });

    console.log('[marketplace] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — all state is per-request or in the DB.
};
