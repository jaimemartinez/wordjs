/**
 * WordJS Plugin: Testimonials — ISOLATED, sandboxed.
 *
 * Managed testimonials with moderation and an optional public submission form. The Puck block
 * "Testimonials" (carousel or grid) consumes the PUBLIC list endpoint (approved only); admins
 * moderate via the admin routes below.
 *
 * Anti-spam on the public submit endpoint:
 *  - Honeypot field `hp` must be empty and `elapsed` (ms the form was open) must be >= 3s,
 *    otherwise we answer a FAKE {success:true} without inserting (do not tip off bots).
 *  - In-memory rate cap PER CLIENT (req.clientKey, an HMAC of the caller's IP forwarded by the
 *    host): at most SUBMIT_MAX_PER_CLIENT submissions per client per rolling minute. It used to be
 *    one site-wide window, so one client closed the form for every visitor. Every submission waits
 *    for moderation.
 * Public submissions always land as status 'pending' / source 'public' and only appear after an
 * admin approves them.
 */

exports.metadata = {
    name: 'Testimonials',
    version: '1.0.1',
    description: 'Managed testimonials with moderation, optional public submissions and a Verso display block (carousel/grid).',
    author: 'WordJS',
};

const OPT_SETTINGS = 'testimonials_settings';

const MAX_NAME = 120;
const MAX_ROLE = 120;
const MAX_CONTENT = 2000;
const MAX_PHOTO_URL = 500;

const PUBLIC_LIST_DEFAULT = 9;
const PUBLIC_LIST_CAP = 50;

const MIN_ELAPSED_MS = 3000;
const SUBMIT_MAX_PER_CLIENT = 5;
const SUBMIT_WINDOW_MS = 60 * 1000;
const SUBMIT_MAX_KEYS = 10000;   // bound on the in-memory limiter map

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu } = wordjs;

    // Per-plugin table namespace enforced by the host: slug 'testimonials' -> 'wjp_testimonials_'.
    const T = { testimonials: db.tablePrefix + 'testimonials' };

    // ---- schema (idempotent; full column set from day 1 — no ALTER in the sandbox) ---------------
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.testimonials} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author_name TEXT NOT NULL,
        author_role TEXT,
        author_photo TEXT,
        content TEXT NOT NULL,
        rating INTEGER DEFAULT 5,
        status TEXT DEFAULT 'approved',
        source TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ---- helpers ----------------------------------------------------------------------------------
    const getSettings = async () => {
        const raw = await options.get(OPT_SETTINGS, null);
        const s = raw && typeof raw === 'object' ? raw : {};
        return { allowPublicSubmit: !!s.allowPublicSubmit };
    };

    /** Trim, coerce to string and cap length. null/undefined -> ''. */
    const cap = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

    /** Photo URL must be http(s) or empty. */
    const isValidPhoto = (url) => url === '' || /^https?:\/\//i.test(url);

    // Per-client window for public submissions (in-memory; single child process). Checks AND counts
    // in one synchronous step, so concurrent requests cannot all pass the check.
    const submitWindows = new Map(); // clientKey -> { start, count }
    const submitRateLimited = (req) => {
        const key = String((req && req.clientKey) || 'anon').slice(0, 64);
        const now = Date.now();
        let w = submitWindows.get(key);
        if (!w || now - w.start >= SUBMIT_WINDOW_MS) {
            if (submitWindows.size >= SUBMIT_MAX_KEYS) {
                for (const [k, v] of submitWindows) if (now - v.start >= SUBMIT_WINDOW_MS) submitWindows.delete(k);
                while (submitWindows.size >= SUBMIT_MAX_KEYS) submitWindows.delete(submitWindows.keys().next().value);
            }
            w = { start: now, count: 0 };
            submitWindows.set(key, w);
        }
        w.count++;
        return w.count > SUBMIT_MAX_PER_CLIENT;
    };

    // ---- admin routes -----------------------------------------------------------------------------
    // NOTE: specific paths are registered before parameterized ones ('/:id/...') so they never shadow.

    // List testimonials, newest first. ?status= all|pending|approved. Counts included for the tab badge.
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        const status = String((req.query && req.query.status) || 'all');
        let items;
        if (status === 'pending' || status === 'approved') {
            items = await db.all(`SELECT * FROM ${T.testimonials} WHERE status = ? ORDER BY id DESC`, [status]);
        } else {
            items = await db.all(`SELECT * FROM ${T.testimonials} ORDER BY id DESC`);
        }
        const counts = { pending: 0, approved: 0 };
        const rows = await db.all(`SELECT status, COUNT(*) AS n FROM ${T.testimonials} GROUP BY status`);
        for (const r of rows) {
            if (r.status === 'pending') counts.pending = r.n;
            else if (r.status === 'approved') counts.approved = r.n;
        }
        res.json({ items, counts });
    });

    // Create or update (by optional id) a testimonial from the admin.
    http.route('post', '/save', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const authorName = cap(body.author_name, MAX_NAME);
        const authorRole = cap(body.author_role, MAX_ROLE);
        const authorPhoto = cap(body.author_photo, MAX_PHOTO_URL);
        const content = cap(body.content, MAX_CONTENT);

        if (!authorName) {
            return res.status(400).json({ success: false, error: 'El nombre del autor es obligatorio.' });
        }
        if (!content) {
            return res.status(400).json({ success: false, error: 'El contenido del testimonio es obligatorio.' });
        }
        const rating = Number(body.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, error: 'La calificación debe ser un entero entre 1 y 5.' });
        }
        if (!isValidPhoto(authorPhoto)) {
            return res.status(400).json({ success: false, error: 'La URL de la foto debe empezar con http:// o https:// (o dejarse vacía).' });
        }
        const status = body.status === 'pending' ? 'pending' : 'approved';

        const id = parseInt(body.id, 10);
        if (Number.isInteger(id) && id > 0) {
            const existing = await db.get(`SELECT id FROM ${T.testimonials} WHERE id = ?`, [id]);
            if (!existing) {
                return res.status(404).json({ success: false, error: 'Testimonio no encontrado.' });
            }
            await db.run(
                `UPDATE ${T.testimonials}
                 SET author_name = ?, author_role = ?, author_photo = ?, content = ?, rating = ?, status = ?
                 WHERE id = ?`,
                [authorName, authorRole, authorPhoto, content, rating, status, id]
            );
            return res.json({ success: true, id });
        }

        const result = await db.run(
            `INSERT INTO ${T.testimonials} (author_name, author_role, author_photo, content, rating, status, source)
             VALUES (?, ?, ?, ?, ?, ?, 'admin')`,
            [authorName, authorRole, authorPhoto, content, rating, status]
        );
        res.json({ success: true, id: result && result.lastID });
    });

    // Settings: whether the Puck block may show the public submission form.
    http.route('get', '/settings', { auth: true, admin: true }, async (req, res) => {
        res.json(await getSettings());
    });

    http.route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const next = { allowPublicSubmit: !!body.allowPublicSubmit };
        await options.set(OPT_SETTINGS, next);
        res.json({ success: true, allowPublicSubmit: next.allowPublicSubmit });
    });

    // Approve a pending testimonial.
    http.route('post', '/:id/approve', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, error: 'Id inválido.' });
        }
        const existing = await db.get(`SELECT id FROM ${T.testimonials} WHERE id = ?`, [id]);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Testimonio no encontrado.' });
        }
        await db.run(`UPDATE ${T.testimonials} SET status = 'approved' WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // Delete a testimonial.
    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, error: 'Id inválido.' });
        }
        const existing = await db.get(`SELECT id FROM ${T.testimonials} WHERE id = ?`, [id]);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Testimonio no encontrado.' });
        }
        await db.run(`DELETE FROM ${T.testimonials} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // ---- public routes (no opts object → no auth) — consumed by the Puck block -------------------

    // Public callers never see an error's text: a driver's message names tables, columns and
    // constraints. The details go to the server log.
    const failQuietly = (res, e, what) => {
        console.error(`[testimonials] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };
    // Public routes answer every failure themselves, through failQuietly: a public caller only ever
    // gets a reply this plugin wrote.
    const quietly = (what, handler) => async (req, res) => {
        try { await handler(req, res); } catch (e) { failQuietly(res, e, what); }
    };

    // Approved testimonials, newest first. ?limit= 1..50. Also tells the block whether the public
    // submission form may be rendered (allowPublicSubmit).
    http.route('get', '/public/list', quietly('testimonial list', async (req, res) => {
        let limit = parseInt((req.query && req.query.limit) || PUBLIC_LIST_DEFAULT, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = PUBLIC_LIST_DEFAULT;
        limit = Math.min(limit, PUBLIC_LIST_CAP);
        const items = await db.all(
            `SELECT id, author_name, author_role, author_photo, content, rating, created_at
             FROM ${T.testimonials}
             WHERE status = 'approved'
             ORDER BY id DESC
             LIMIT ?`,
            [limit]
        );
        const settings = await getSettings();
        res.json({ items, allowPublicSubmit: settings.allowPublicSubmit });
    }));

    // Public submission → always inserted as status 'pending' / source 'public'.
    http.route('post', '/public/submit', quietly('testimonial submission', async (req, res) => {
        const settings = await getSettings();
        if (!settings.allowPublicSubmit) {
            return res.status(403).json({ success: false, error: 'Los envíos públicos están desactivados.' });
        }
        const body = req.body || {};

        // Anti-spam: honeypot must be empty and the form must have been open at least 3 seconds.
        // Bots that fail either check get a FAKE success and nothing is stored.
        const hp = String(body.hp == null ? '' : body.hp).trim();
        const elapsed = Number(body.elapsed);
        if (hp !== '' || !Number.isFinite(elapsed) || elapsed < MIN_ELAPSED_MS) {
            return res.json({ success: true, message: 'Gracias — tu testimonio será revisado.' });
        }

        if (submitRateLimited(req)) {
            return res.status(429).json({ success: false, error: 'Demasiados envíos en este momento. Inténtalo de nuevo en un minuto.' });
        }

        const authorName = cap(body.author_name, MAX_NAME);
        const authorRole = cap(body.author_role, MAX_ROLE);
        const content = cap(body.content, MAX_CONTENT);
        if (!authorName || !content) {
            return res.status(400).json({ success: false, error: 'El nombre y el testimonio son obligatorios.' });
        }
        let rating = parseInt(body.rating, 10);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) rating = 5;

        await db.run(
            `INSERT INTO ${T.testimonials} (author_name, author_role, author_photo, content, rating, status, source)
             VALUES (?, ?, '', ?, ?, 'pending', 'public')`,
            [authorName, authorRole, content, rating]
        );
        res.json({ success: true, message: 'Gracias — tu testimonio será revisado.' });
    }));

    adminMenu.add({
        href: '/admin/plugin/testimonials',
        label: 'Testimonios',
        icon: 'fa-star',
        order: 62,
        cap: 'manage_options',
    });

    console.log('[testimonials] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down.
};
