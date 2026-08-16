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
 *  - Global in-memory rate cap (the serialized req has no req.ip, so the cap is global): at most
 *    SUBMIT_MAX_PER_WINDOW inserts per rolling minute.
 * Public submissions always land as status 'pending' / source 'public' and only appear after an
 * admin approves them.
 */

exports.metadata = {
    name: 'Testimonials',
    version: '1.0.0',
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
const SUBMIT_MAX_PER_WINDOW = 10;
const SUBMIT_WINDOW_MS = 60 * 1000;

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

    // Global rolling-window rate limiter for public submissions (in-memory; single child process).
    let submitWindowStart = 0;
    let submitCount = 0;
    const submitRateLimited = () => {
        const now = Date.now();
        if (now - submitWindowStart >= SUBMIT_WINDOW_MS) {
            submitWindowStart = now;
            submitCount = 0;
        }
        submitCount++;
        return submitCount > SUBMIT_MAX_PER_WINDOW;
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

    // Approved testimonials, newest first. ?limit= 1..50. Also tells the block whether the public
    // submission form may be rendered (allowPublicSubmit).
    http.route('get', '/public/list', async (req, res) => {
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
    });

    // Public submission → always inserted as status 'pending' / source 'public'.
    http.route('post', '/public/submit', async (req, res) => {
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

        if (submitRateLimited()) {
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
    });

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
