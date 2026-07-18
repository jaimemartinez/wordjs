/**
 * WordJS Plugin: Job Board — WordPress parity: WP Job Manager.
 *
 * Job listings + public applications with anti-spam (honeypot + fill-time + global rate cap)
 * and an applications inbox (statuses, CSV export). Runs fully sandboxed:
 *  - Tables live under the plugin prefix (wjp_job_board_) built from wordjs.db.tablePrefix.
 *  - Schema is created idempotently up-front (no ALTER available to plugins).
 *  - Money is stored as INTEGER CENTS (salary_min_cents / salary_max_cents); the client renders
 *    (cents / 100) with the configured currency symbol.
 *  - No req.ip in the sandbox: the application rate cap is a global in-memory rolling window,
 *    plus a single-statement duplicate guard per (job_id, email).
 *  - CSV export returns { csv, filename } as JSON (the isolate JSON-encodes string bodies, which
 *    would corrupt a raw CSV response) — the admin client builds the Blob.
 */

exports.metadata = {
    name: 'Job Board',
    version: '1.0.0',
    description: 'Job listings + public applications with anti-spam + applications inbox',
    author: 'WordJS',
};

const OPT_CONFIG = 'job_board_config';
const DEFAULT_CONFIG = { currencySymbol: '$', notifyEmail: '', showSalary: true };

const JOB_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'temporary'];
const SALARY_PERIODS = ['hour', 'month', 'year'];
const APP_STATUSES = ['new', 'reviewed', 'shortlisted', 'rejected'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// Anti-spam knobs for POST /public/apply.
const APPLY_MAX_PER_WINDOW = 10;          // global cap: 10 applications per rolling minute
const APPLY_WINDOW_MS = 60 * 1000;
const MIN_FILL_MS = 3000;                 // a human takes longer than 3s to fill the form

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail } = wordjs;

    const P = db.tablePrefix; // 'wjp_job_board_'
    const T = {
        jobs: `${P}jobs`,
        applications: `${P}applications`,
    };

    // ---- schema (idempotent, full column set from day 1 — no ALTER in the sandbox) --------------
    async function initSchema() {
        await db.createTable(T.jobs, [
            'id INT_PK',
            'title TEXT NOT NULL',
            'slug TEXT UNIQUE',
            'company TEXT',
            'location TEXT',
            "type TEXT DEFAULT 'full-time'",
            'is_remote INT DEFAULT 0',
            'salary_min_cents INT DEFAULT 0',
            'salary_max_cents INT DEFAULT 0',
            "salary_period TEXT DEFAULT 'month'",
            'description TEXT NOT NULL',
            'requirements TEXT',
            'apply_email TEXT',
            'is_published INT DEFAULT 1',
            "expires_at TEXT DEFAULT ''",
            'views INT DEFAULT 0',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);

        await db.createTable(T.applications, [
            'id INT_PK',
            'job_id INT NOT NULL',
            'name TEXT NOT NULL',
            'email TEXT NOT NULL',
            'phone TEXT',
            'cover_letter TEXT',
            'cv_url TEXT',
            "status TEXT DEFAULT 'new'",
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (job_id) REFERENCES ${T.jobs}(id) ON DELETE CASCADE`,
        ]);

        // Index names AND targets must carry the plugin prefix (host default-deny check).
        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Already exists / unsupported — indexes are an optimization only.
            }
        };
        await createIndex(`${P}idx_applications_job`, T.applications, 'job_id');
        await createIndex(`${P}idx_applications_status`, T.applications, 'status');
        await createIndex(`${P}idx_jobs_published`, T.jobs, 'is_published');
    }

    await initSchema();

    // ---- helpers ---------------------------------------------------------------------------------
    const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const intFlag = (v) => (v === 1 || v === '1' || v === true || v === 'true') ? 1 : 0;
    const todayStr = () => new Date().toISOString().slice(0, 10);

    const escHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    async function getConfig() {
        const raw = (await options.get(OPT_CONFIG, null)) || {};
        return {
            currencySymbol: typeof raw.currencySymbol === 'string' && raw.currencySymbol.trim()
                ? raw.currencySymbol.trim().slice(0, 5) : DEFAULT_CONFIG.currencySymbol,
            notifyEmail: typeof raw.notifyEmail === 'string' ? raw.notifyEmail.trim() : '',
            showSalary: raw.showSalary !== false,
        };
    }

    const slugify = (s) => String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'vacante';

    /** Slug uniqueness with a numeric suffix; excludeId lets an update keep its own slug. */
    async function uniqueSlug(base, excludeId) {
        let candidate = base;
        for (let n = 2; n <= 60; n++) {
            const row = excludeId != null
                ? await db.get(`SELECT id FROM ${T.jobs} WHERE slug = ? AND id != ?`, [candidate, excludeId])
                : await db.get(`SELECT id FROM ${T.jobs} WHERE slug = ?`, [candidate]);
            if (!row) return candidate;
            candidate = `${base}-${n}`;
        }
        // Pathological collision run — fall back to a random suffix (not security-sensitive).
        return `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    }

    /**
     * Validate + normalize a job payload from the admin. Salary arrives ALREADY in integer cents
     * (the admin client converts the decimal inputs); this re-validates server-side regardless.
     * Returns { ok:true, data } or { ok:false, error } with a Spanish message.
     */
    function parseJobBody(body) {
        const b = body || {};
        const title = str(b.title, 200);
        if (!title) return { ok: false, error: 'El título es obligatorio.' };
        const description = String(b.description == null ? '' : b.description).trim().slice(0, 20000);
        if (!description) return { ok: false, error: 'La descripción es obligatoria.' };

        const type = JOB_TYPES.includes(b.type) ? b.type : 'full-time';
        const salary_period = SALARY_PERIODS.includes(b.salary_period) ? b.salary_period : 'month';

        const toCents = (v) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n > 0 ? Math.min(n, 1e13) : 0;
        };
        const salary_min_cents = toCents(b.salary_min_cents);
        const salary_max_cents = toCents(b.salary_max_cents);
        if (salary_min_cents > 0 && salary_max_cents > 0 && salary_min_cents > salary_max_cents) {
            return { ok: false, error: 'El salario mínimo no puede ser mayor que el máximo.' };
        }

        const apply_email = str(b.apply_email, 254);
        if (apply_email && !EMAIL_RE.test(apply_email)) {
            return { ok: false, error: 'El email de postulación no es válido.' };
        }

        const expires_at = str(b.expires_at, 10);
        if (expires_at && !DATE_RE.test(expires_at)) {
            return { ok: false, error: 'La fecha de expiración debe tener formato AAAA-MM-DD (o vacía para nunca).' };
        }

        return {
            ok: true,
            data: {
                title,
                company: str(b.company, 200),
                location: str(b.location, 200),
                type,
                is_remote: intFlag(b.is_remote),
                salary_min_cents,
                salary_max_cents,
                salary_period,
                description,
                requirements: String(b.requirements == null ? '' : b.requirements).trim().slice(0, 20000),
                apply_email,
                is_published: b.is_published === undefined ? 1 : intFlag(b.is_published),
                expires_at,
            },
        };
    }

    // Global rolling-window rate cap for public applications (single child process → in-memory).
    let applyTimes = [];
    const applyThrottled = () => {
        const now = Date.now();
        applyTimes = applyTimes.filter((t) => now - t < APPLY_WINDOW_MS);
        return applyTimes.length >= APPLY_MAX_PER_WINDOW;
    };

    // Public projection: apply_email stays server-side (avoid harvesting) and so do admin-ish flags.
    const PUBLIC_JOB_COLS = 'id, title, slug, company, location, type, is_remote, ' +
        'salary_min_cents, salary_max_cents, salary_period, expires_at, created_at';

    // ---- PUBLIC routes ----------------------------------------------------------------------------

    // List published, non-expired jobs — the Puck block calls this from the editor iframe AND the
    // public page. ?search= (title/company/location), ?type=, ?remote=1, ?limit= 1..200.
    http.route('get', '/public/jobs', async (req, res) => {
        try {
            const q = req.query || {};
            let sql = `SELECT ${PUBLIC_JOB_COLS} FROM ${T.jobs}
                       WHERE is_published = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?)`;
            const params = [todayStr()];

            const search = str(q.search, 100);
            if (search) {
                sql += ' AND (title LIKE ? OR company LIKE ? OR location LIKE ?)';
                const t = `%${search}%`;
                params.push(t, t, t);
            }
            if (JOB_TYPES.includes(q.type)) {
                sql += ' AND type = ?';
                params.push(q.type);
            }
            if (intFlag(q.remote)) sql += ' AND is_remote = 1';

            let limit = parseInt(q.limit || DEFAULT_LIST_LIMIT, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIST_LIMIT;
            limit = Math.min(limit, MAX_LIST_LIMIT);
            sql += ` ORDER BY created_at DESC, id DESC LIMIT ${limit}`;

            const jobs = await db.all(sql, params);
            const config = await getConfig();
            res.json({ jobs, currencySymbol: config.currencySymbol, showSalary: config.showSalary });
        } catch (e) {
            res.status(500).json({ error: 'No se pudieron cargar las vacantes.' });
        }
    });

    // Job detail by slug. Counts the view with a single-statement UPDATE (race-free counter).
    http.route('get', '/public/job', async (req, res) => {
        try {
            const slug = str((req.query || {}).slug, 100);
            if (!slug) return res.status(400).json({ error: 'Falta el parámetro slug.' });

            await db.run(
                `UPDATE ${T.jobs} SET views = views + 1
                 WHERE slug = ? AND is_published = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?)`,
                [slug, todayStr()]
            );
            const job = await db.get(
                `SELECT ${PUBLIC_JOB_COLS}, description, requirements, views FROM ${T.jobs}
                 WHERE slug = ? AND is_published = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?)`,
                [slug, todayStr()]
            );
            if (!job) return res.status(404).json({ error: 'Vacante no encontrada o ya no está disponible.' });
            const config = await getConfig();
            res.json({ job, currencySymbol: config.currencySymbol, showSalary: config.showSalary });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar la vacante.' });
        }
    });

    // Public application. Anti-spam: honeypot (fake success so bots learn nothing), minimum
    // fill-time, global rolling rate cap, and a single-statement duplicate guard per job+email.
    http.route('post', '/public/apply', async (req, res) => {
        try {
            const b = req.body || {};

            // Honeypot: a real form keeps this field empty; bots fill everything. Pretend success.
            if (str(b.hp, 200)) return res.json({ success: true });

            const elapsed = Number(b.elapsed);
            if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
                return res.status(400).json({ error: 'Por favor tómate un momento para completar el formulario antes de enviarlo.' });
            }

            if (applyThrottled()) {
                return res.status(429).json({ error: 'Estamos recibiendo muchas postulaciones. Intenta de nuevo en un minuto.' });
            }

            const job_id = parseInt(b.job_id, 10);
            if (!Number.isFinite(job_id) || job_id < 1) return res.status(400).json({ error: 'Vacante no válida.' });

            const name = str(b.name, 200);
            if (!name) return res.status(400).json({ error: 'Tu nombre es obligatorio.' });

            const email = str(b.email, 254).toLowerCase();
            if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ingresa un email válido.' });

            const phone = str(b.phone, 50);
            const cover_letter = String(b.cover_letter == null ? '' : b.cover_letter).trim().slice(0, 5000);
            const cv_url = str(b.cv_url, 500);
            if (cv_url && !/^https?:\/\/\S+$/i.test(cv_url)) {
                return res.status(400).json({ error: 'El enlace de tu CV debe comenzar con http:// o https:// (o déjalo vacío).' });
            }

            const job = await db.get(
                `SELECT id, title, apply_email FROM ${T.jobs}
                 WHERE id = ? AND is_published = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?)`,
                [job_id, todayStr()]
            );
            if (!job) return res.status(404).json({ error: 'Esta vacante ya no está disponible.' });

            // Single-statement duplicate guard: no transaction bridge, so the NOT EXISTS predicate
            // rides inside the INSERT itself (changes === 0 → this email already applied).
            const result = await db.run(
                `INSERT INTO ${T.applications} (job_id, name, email, phone, cover_letter, cv_url, status)
                 SELECT ?, ?, ?, ?, ?, ?, 'new'
                 WHERE NOT EXISTS (SELECT 1 FROM ${T.applications} WHERE job_id = ? AND email = ?)`,
                [job_id, name, email, phone, cover_letter, cv_url, job_id, email]
            );
            if (!result || result.changes === 0) {
                return res.status(409).json({ error: 'Ya enviaste una postulación para esta vacante con ese email.' });
            }
            applyTimes.push(Date.now());

            // Notification mail — best effort: the application is already saved, mail may degrade.
            let mailed = false;
            try {
                const config = await getConfig();
                const to = str(job.apply_email, 254) || config.notifyEmail;
                if (to && EMAIL_RE.test(to)) {
                    const rows = [
                        ['Vacante', job.title],
                        ['Nombre', name],
                        ['Email', email],
                        ['Teléfono', phone || '—'],
                        ['CV', cv_url || '—'],
                    ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${escHtml(k)}</td><td style="padding:4px 0"><strong>${escHtml(v)}</strong></td></tr>`).join('');
                    await mail({
                        to,
                        subject: `Nueva postulación: ${job.title}`,
                        html: `<h2 style="font-family:sans-serif">Nueva postulación</h2>
                               <table style="font-family:sans-serif;font-size:14px">${rows}</table>
                               ${cover_letter ? `<h3 style="font-family:sans-serif">Carta de presentación</h3><p style="font-family:sans-serif;white-space:pre-line">${escHtml(cover_letter)}</p>` : ''}`,
                        text: `Nueva postulación a "${job.title}"\nNombre: ${name}\nEmail: ${email}\nTeléfono: ${phone || '-'}\nCV: ${cv_url || '-'}\n\n${cover_letter}`,
                    });
                    mailed = true;
                }
            } catch (e) {
                console.warn('[job-board] notification mail failed:', e.message);
            }

            res.json({ success: true, mailed });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo enviar la postulación. Intenta de nuevo.' });
        }
    });

    // ---- ADMIN routes -----------------------------------------------------------------------------

    // Jobs list with application counts (total + unread 'new' badge per job).
    http.route('get', '/jobs', { auth: true, admin: true }, async (req, res) => {
        try {
            const jobs = await db.all(
                `SELECT j.*,
                        (SELECT COUNT(*) FROM ${T.applications} a WHERE a.job_id = j.id) AS app_count,
                        (SELECT COUNT(*) FROM ${T.applications} a WHERE a.job_id = j.id AND a.status = 'new') AS new_count
                 FROM ${T.jobs} j
                 ORDER BY j.created_at DESC, j.id DESC`
            );
            res.json({ jobs });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/jobs', { auth: true, admin: true }, async (req, res) => {
        try {
            const parsed = parseJobBody(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const d = parsed.data;
            const requested = str((req.body || {}).slug, 80);
            const slug = await uniqueSlug(requested ? slugify(requested) : slugify(d.title));
            const result = await db.run(
                `INSERT INTO ${T.jobs}
                 (title, slug, company, location, type, is_remote, salary_min_cents, salary_max_cents,
                  salary_period, description, requirements, apply_email, is_published, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.title, slug, d.company, d.location, d.type, d.is_remote, d.salary_min_cents,
                 d.salary_max_cents, d.salary_period, d.description, d.requirements, d.apply_email,
                 d.is_published, d.expires_at]
            );
            const job = await db.get(`SELECT * FROM ${T.jobs} WHERE id = ?`, [result.lastID]);
            res.status(201).json({ job });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/jobs/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt((req.params || {}).id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID no válido.' });
            const existing = await db.get(`SELECT * FROM ${T.jobs} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Vacante no encontrada.' });

            const parsed = parseJobBody(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const d = parsed.data;

            // Keep the existing slug unless the admin explicitly sends a new one (URLs stay stable).
            const requested = str((req.body || {}).slug, 80);
            const slug = requested && slugify(requested) !== existing.slug
                ? await uniqueSlug(slugify(requested), id)
                : existing.slug;

            await db.run(
                `UPDATE ${T.jobs} SET title = ?, slug = ?, company = ?, location = ?, type = ?,
                    is_remote = ?, salary_min_cents = ?, salary_max_cents = ?, salary_period = ?,
                    description = ?, requirements = ?, apply_email = ?, is_published = ?, expires_at = ?
                 WHERE id = ?`,
                [d.title, slug, d.company, d.location, d.type, d.is_remote, d.salary_min_cents,
                 d.salary_max_cents, d.salary_period, d.description, d.requirements, d.apply_email,
                 d.is_published, d.expires_at, id]
            );
            const job = await db.get(`SELECT * FROM ${T.jobs} WHERE id = ?`, [id]);
            res.json({ job });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Publish/unpublish toggle (the list's switch — cheaper than a full PUT).
    http.route('post', '/jobs/:id/publish', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt((req.params || {}).id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID no válido.' });
            const val = intFlag((req.body || {}).is_published);
            const result = await db.run(`UPDATE ${T.jobs} SET is_published = ? WHERE id = ?`, [val, id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Vacante no encontrada.' });
            res.json({ success: true, is_published: val });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/jobs/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt((req.params || {}).id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID no válido.' });
            // Delete children explicitly — FK cascade is not guaranteed on every SQLite config.
            await db.run(`DELETE FROM ${T.applications} WHERE job_id = ?`, [id]);
            const result = await db.run(`DELETE FROM ${T.jobs} WHERE id = ?`, [id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Vacante no encontrada.' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Applications inbox — filterable by job/status; counts feed the tab + per-status badges.
    http.route('get', '/applications', { auth: true, admin: true }, async (req, res) => {
        try {
            const q = req.query || {};
            let sql = `SELECT a.*, j.title AS job_title FROM ${T.applications} a
                       LEFT JOIN ${T.jobs} j ON a.job_id = j.id WHERE 1 = 1`;
            const params = [];
            const jobId = parseInt(q.job_id, 10);
            if (Number.isFinite(jobId) && jobId > 0) { sql += ' AND a.job_id = ?'; params.push(jobId); }
            if (APP_STATUSES.includes(q.status)) { sql += ' AND a.status = ?'; params.push(q.status); }
            sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT 1000';
            const applications = await db.all(sql, params);

            const countRows = await db.all(
                `SELECT status, COUNT(*) AS c FROM ${T.applications} GROUP BY status`
            );
            const counts = { new: 0, reviewed: 0, shortlisted: 0, rejected: 0, total: 0 };
            for (const row of countRows) {
                if (counts[row.status] !== undefined) counts[row.status] = row.c;
                counts.total += row.c;
            }
            res.json({ applications, counts });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/applications/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt((req.params || {}).id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID no válido.' });
            const status = (req.body || {}).status;
            if (!APP_STATUSES.includes(status)) {
                return res.status(400).json({ error: 'Estado no válido.' });
            }
            const result = await db.run(`UPDATE ${T.applications} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Postulación no encontrada.' });
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/applications/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt((req.params || {}).id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID no válido.' });
            const result = await db.run(`DELETE FROM ${T.applications} WHERE id = ?`, [id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Postulación no encontrada.' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // CSV export — honors the same filters as GET /applications. Returned as { csv, filename }
    // because the isolate JSON-encodes string bodies (raw CSV would arrive quoted/escaped).
    http.route('get', '/applications/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const q = req.query || {};
            let sql = `SELECT a.*, j.title AS job_title FROM ${T.applications} a
                       LEFT JOIN ${T.jobs} j ON a.job_id = j.id WHERE 1 = 1`;
            const params = [];
            const jobId = parseInt(q.job_id, 10);
            if (Number.isFinite(jobId) && jobId > 0) { sql += ' AND a.job_id = ?'; params.push(jobId); }
            if (APP_STATUSES.includes(q.status)) { sql += ' AND a.status = ?'; params.push(q.status); }
            sql += ' ORDER BY a.created_at DESC, a.id DESC';
            const rows = await db.all(sql, params);

            const cols = [
                ['job_title', 'Vacante'], ['name', 'Nombre'], ['email', 'Email'],
                ['phone', 'Teléfono'], ['cv_url', 'CV'], ['status', 'Estado'],
                ['cover_letter', 'Carta de presentación'], ['created_at', 'Fecha'],
            ];
            const esc = (v) => {
                let s = v === null || v === undefined ? '' : String(v);
                // Neutralize spreadsheet formula injection — applicant fields come from the public form.
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = cols.map((c) => esc(c[1])).join(',');
            const body = rows.map((r) => cols.map((c) => esc(r[c[0]])).join(',')).join('\r\n');
            const csv = '﻿' + header + '\r\n' + body; // BOM so Excel reads UTF-8

            res.json({ csv, filename: `postulaciones-${todayStr()}.csv`, count: rows.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Board configuration (currency symbol, notification email, salary visibility).
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({ config: await getConfig() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            const b = req.body || {};
            const current = await getConfig();
            const next = { ...current };
            if (typeof b.currencySymbol === 'string') {
                next.currencySymbol = b.currencySymbol.trim().slice(0, 5) || '$';
            }
            if (typeof b.notifyEmail === 'string') {
                const v = b.notifyEmail.trim().slice(0, 254);
                if (v && !EMAIL_RE.test(v)) return res.status(400).json({ error: 'El email de notificación no es válido.' });
                next.notifyEmail = v;
            }
            if (b.showSalary !== undefined) next.showSalary = intFlag(b.showSalary) === 1;
            await options.set(OPT_CONFIG, next);
            res.json({ config: next });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    adminMenu.add({
        href: '/admin/plugin/jobs',
        label: 'Empleos',
        icon: 'fa-briefcase',
        order: 75,
        cap: 'manage_options',
    });

    console.log('[job-board] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; rate-limit state dies with the child.
};
