/**
 * WordJS Plugin: Cookie Consent — ISOLATED, sandboxed.
 *
 * A site-wide GDPR cookie banner. The banner itself is a plain browser script + stylesheet
 * (public/banner.js + public/banner.css) enqueued on every public page through the assets bridge.
 * This backend serves the banner configuration on a public endpoint, receives ANONYMOUS choice
 * logs (accepted/rejected only — no IP, no user agent, no PII), and exposes admin endpoints to
 * edit the config and read compliance stats.
 *
 * Re-prompting: the config carries a `version` number. The browser stores the visitor's choice in
 * localStorage together with the version it consented to; when the admin bumps the version
 * ("volver a preguntar a todos"), every stored choice becomes stale and the banner shows again.
 */

exports.metadata = {
    name: 'Cookie Consent',
    version: '1.0.0',
    description: 'GDPR cookie banner on every public page + anonymous consent stats',
    author: 'WordJS',
};

const OPT_CONFIG = 'cookie_consent_config';

const MAX_MESSAGE = 500;
const MAX_LABEL = 40;
const MAX_URL = 300;

const DEFAULT_CONFIG = {
    enabled: false,
    message: 'Usamos cookies para mejorar tu experiencia. Puedes aceptarlas o rechazarlas.',
    acceptLabel: 'Aceptar',
    rejectLabel: 'Rechazar',
    policyUrl: '',
    position: 'bottom', // 'bottom' | 'corner'
    theme: 'dark',      // 'dark' | 'light'
    version: 1,
};

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, assets } = wordjs;

    // Per-plugin table namespace enforced by the host. slug 'cookie-consent' -> 'wjp_cookie_consent_'.
    const T = { log: db.tablePrefix + 'log' };

    /** Idempotent schema — one anonymous log table (choice + timestamp, nothing else: GDPR-safe). */
    async function initSchema() {
        await db.run(
            `CREATE TABLE IF NOT EXISTS ${T.log} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                choice TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
    }

    /** Coerce whatever is stored into a complete, well-typed config (partial/corrupt-safe). */
    function normalizeConfig(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const cfg = Object.assign({}, DEFAULT_CONFIG, src);
        cfg.enabled = cfg.enabled === true;
        cfg.message = String(cfg.message || DEFAULT_CONFIG.message).slice(0, MAX_MESSAGE);
        cfg.acceptLabel = String(cfg.acceptLabel || DEFAULT_CONFIG.acceptLabel).slice(0, MAX_LABEL);
        cfg.rejectLabel = String(cfg.rejectLabel || DEFAULT_CONFIG.rejectLabel).slice(0, MAX_LABEL);
        cfg.policyUrl = typeof cfg.policyUrl === 'string' ? cfg.policyUrl.trim().slice(0, MAX_URL) : '';
        cfg.position = cfg.position === 'corner' ? 'corner' : 'bottom';
        cfg.theme = cfg.theme === 'light' ? 'light' : 'dark';
        const v = Math.floor(Number(cfg.version));
        cfg.version = Number.isFinite(v) && v >= 1 ? v : 1;
        return cfg;
    }

    async function getConfig() {
        return normalizeConfig(await options.get(OPT_CONFIG, null));
    }

    // ---- boot -------------------------------------------------------------------------------------
    await initSchema();

    // Enqueue the public banner (script + style). Idempotent upsert by handle — safe on every init.
    // Wrapped so the plugin still boots (admin page, routes) if the assets grant isn't given yet.
    try {
        await assets.enqueueScript({ handle: 'cookie-banner', src: 'public/banner.js', strategy: 'defer' });
        await assets.enqueueStyle({ handle: 'cookie-banner', src: 'public/banner.css' });
    } catch (e) {
        console.warn('[cookie-consent] could not enqueue the banner assets (missing assets grant?): ' + (e && e.message ? e.message : e));
    }

    // In-process site-wide rate cap for the anonymous log endpoint (no req.ip in the sandbox → a
    // fixed shared window is the honest cap; the endpoint stores 1 short row, so 60/min is plenty).
    const LOG_MAX_PER_WINDOW = 60;
    const LOG_WINDOW_MS = 60 * 1000;
    let logWindow = { start: 0, count: 0 };
    function logAllowed() {
        const now = Date.now();
        if (now - logWindow.start >= LOG_WINDOW_MS) logWindow = { start: now, count: 0 };
        if (logWindow.count >= LOG_MAX_PER_WINDOW) return false;
        logWindow.count++;
        return true;
    }

    // ---- public routes (consumed by public/banner.js on every public page) -------------------------

    // The banner script fetches this first; it renders nothing unless enabled === true.
    http.route('get', '/public/config', async (req, res) => {
        try {
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar la configuración.' });
        }
    });

    // Anonymous choice log. Body: { choice: 'accepted' | 'rejected' }. Nothing else is stored.
    http.route('post', '/public/log', async (req, res) => {
        try {
            const choice = req.body && req.body.choice;
            if (choice !== 'accepted' && choice !== 'rejected') {
                return res.status(400).json({ error: 'Elección inválida.' });
            }
            if (!logAllowed()) {
                return res.status(429).json({ error: 'Demasiadas solicitudes, inténtalo más tarde.' });
            }
            await db.run(`INSERT INTO ${T.log} (choice) VALUES (?)`, [choice]);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo registrar la elección.' });
        }
    });

    // ---- admin routes -------------------------------------------------------------------------------

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar la configuración.' });
        }
    });

    /**
     * Save the config. Only known fields are merged, each validated; unknown fields are dropped.
     * body.reprompt === true bumps `version`, which invalidates every stored consent client-side
     * (the banner shows again for everyone).
     */
    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const current = await getConfig();
            const next = Object.assign({}, current);

            if ('enabled' in body) next.enabled = body.enabled === true;

            if (body.message !== undefined) {
                const m = String(body.message || '').trim();
                if (!m) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
                if (m.length > MAX_MESSAGE) return res.status(400).json({ error: `El mensaje no puede superar los ${MAX_MESSAGE} caracteres.` });
                next.message = m;
            }

            if (body.acceptLabel !== undefined) {
                const l = String(body.acceptLabel || '').trim();
                if (l.length > MAX_LABEL) return res.status(400).json({ error: `Las etiquetas no pueden superar los ${MAX_LABEL} caracteres.` });
                next.acceptLabel = l || DEFAULT_CONFIG.acceptLabel;
            }

            if (body.rejectLabel !== undefined) {
                const l = String(body.rejectLabel || '').trim();
                if (l.length > MAX_LABEL) return res.status(400).json({ error: `Las etiquetas no pueden superar los ${MAX_LABEL} caracteres.` });
                next.rejectLabel = l || DEFAULT_CONFIG.rejectLabel;
            }

            if (body.policyUrl !== undefined) {
                const u = String(body.policyUrl || '').trim();
                if (u.length > MAX_URL) return res.status(400).json({ error: `La URL de la política no puede superar los ${MAX_URL} caracteres.` });
                if (u && !/^https?:\/\//i.test(u)) {
                    return res.status(400).json({ error: 'La URL de la política debe empezar por http:// o https:// (o dejarse vacía).' });
                }
                next.policyUrl = u;
            }

            if (body.position !== undefined) {
                if (body.position !== 'bottom' && body.position !== 'corner') {
                    return res.status(400).json({ error: 'Posición inválida (usa "bottom" o "corner").' });
                }
                next.position = body.position;
            }

            if (body.theme !== undefined) {
                if (body.theme !== 'dark' && body.theme !== 'light') {
                    return res.status(400).json({ error: 'Tema inválido (usa "dark" o "light").' });
                }
                next.theme = body.theme;
            }

            if (body.reprompt === true) next.version = current.version + 1;

            const saved = normalizeConfig(next);
            await options.set(OPT_CONFIG, saved);
            res.json(saved);
        } catch (e) {
            res.status(500).json({ error: 'No se pudo guardar la configuración.' });
        }
    });

    // Compliance stats: totals + the last 30 days that had activity (grouped per day).
    http.route('get', '/stats', { auth: true, admin: true }, async (req, res) => {
        try {
            const totals = await db.get(
                `SELECT COUNT(*) AS total,
                        COALESCE(SUM(CASE WHEN choice = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
                        COALESCE(SUM(CASE WHEN choice = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
                 FROM ${T.log}`
            );
            const last30 = await db.all(
                `SELECT date(created_at) AS day,
                        SUM(CASE WHEN choice = 'accepted' THEN 1 ELSE 0 END) AS accepted,
                        SUM(CASE WHEN choice = 'rejected' THEN 1 ELSE 0 END) AS rejected
                 FROM ${T.log}
                 GROUP BY date(created_at)
                 ORDER BY day DESC
                 LIMIT 30`
            );
            res.json({
                total: Number((totals && totals.total) || 0),
                accepted: Number((totals && totals.accepted) || 0),
                rejected: Number((totals && totals.rejected) || 0),
                last30: (last30 || []).map((r) => ({
                    day: r.day,
                    accepted: Number(r.accepted || 0),
                    rejected: Number(r.rejected || 0),
                })),
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudieron cargar las estadísticas.' });
        }
    });

    adminMenu.add({
        href: '/admin/plugin/cookie-consent',
        label: 'Cookie Consent',
        icon: 'fa-cookie-bite',
        order: 58,
        cap: 'manage_options',
    });

    console.log('[cookie-consent] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers. The host stops serving the enqueued assets
    // automatically while the plugin is inactive.
};
