/**
 * WordJS Plugin: Popup Builder — ISOLATED, sandboxed.
 *
 * Site-wide promotional/announcement popup. The admin manages any number of popups but at most
 * ONE is enabled at a time (enabling one disables the rest). The public script (public/popup.js,
 * enqueued via the assets bridge) fetches the active popup, applies the trigger (delay / scroll
 * depth / exit intent) and the frequency cap (always / session / visitor / daily), and reports
 * view/click events back so the admin list can show views, clicks and CTR.
 *
 * Sandbox notes:
 *  - All data lives in the plugin's own prefixed table (db.tablePrefix, host-enforced).
 *  - Routes are namespaced under /api/v1/plugin/popup-builder/*.
 *  - The public event endpoint is capped PER CLIENT (req.clientKey, an HMAC of the caller's IP
 *    forwarded by the host) with an in-memory window that resets every minute. It used to be one
 *    site-wide window, so one client could fill it and keep every real view and click out of the
 *    stats.
 *  - The frequency "re-show to everybody" mechanism is the `version` column: the public script
 *    keys its storage on id + version, so bumping the version invalidates every visitor's cap.
 */

exports.metadata = {
    name: 'Popup Builder',
    version: '1.0.1',
    description: 'Site-wide popups with triggers, frequency capping, scheduling and stats',
    author: 'WordJS',
};

const TRIGGER_TYPES = ['delay', 'scroll', 'exit'];
const FREQUENCIES = ['always', 'session', 'visitor', 'daily'];
const EVENT_RATE_LIMIT = 30;               // public events allowed per client per window
const EVENT_RATE_MAX_KEYS = 10000;         // bound on the in-memory limiter map
const EVENT_RATE_WINDOW_MS = 60 * 1000;    // 1 minute window

exports.init = async function (wordjs) {
    const { db, http, adminMenu, assets } = wordjs;

    // Per-plugin table namespace enforced by the host: 'popup-builder' -> 'wjp_popup_builder_'.
    const T = { popups: db.tablePrefix + 'popups' };

    /** Idempotent schema — full column set from day 1 (no ALTER available in the sandbox). */
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.popups} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT,
            image_url TEXT,
            button_label TEXT,
            button_url TEXT,
            enabled INTEGER DEFAULT 0,
            trigger_type TEXT DEFAULT 'delay',
            trigger_value INTEGER DEFAULT 3,
            frequency TEXT DEFAULT 'session',
            starts_at TEXT,
            ends_at TEXT,
            version INTEGER DEFAULT 1,
            views INTEGER DEFAULT 0,
            clicks INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
    await initSchema();

    // ---- validation helpers -----------------------------------------------------------------------

    /** Empty is allowed; otherwise the URL must be http(s) or site-relative (starts with '/'). */
    const isValidUrl = (u) => {
        const s = String(u == null ? '' : u).trim();
        if (s === '') return true;
        if (s.startsWith('/')) return true;
        return /^https?:\/\//i.test(s);
    };

    /** Empty is allowed; otherwise the date string must be parseable. */
    const isValidDate = (d) => {
        const s = String(d == null ? '' : d).trim();
        if (s === '') return true;
        return !Number.isNaN(Date.parse(s));
    };

    // ---- per-client in-memory rate limit for the public event endpoint -----------------------------
    const eventWindows = new Map(); // clientKey -> { start, count }
    const eventAllowed = (req) => {
        const key = String((req && req.clientKey) || 'anon').slice(0, 64);
        const now = Date.now();
        let w = eventWindows.get(key);
        if (!w || now - w.start >= EVENT_RATE_WINDOW_MS) {
            if (eventWindows.size >= EVENT_RATE_MAX_KEYS) {
                for (const [k, v] of eventWindows) if (now - v.start >= EVENT_RATE_WINDOW_MS) eventWindows.delete(k);
                while (eventWindows.size >= EVENT_RATE_MAX_KEYS) eventWindows.delete(eventWindows.keys().next().value);
            }
            w = { start: now, count: 0 };
            eventWindows.set(key, w);
        }
        w.count += 1;
        return w.count <= EVENT_RATE_LIMIT;
    };

    // ---- PUBLIC routes (registered first so they never collide with /:id patterns) ------------------

    // Public callers never see an error's text: a driver's message names tables, columns and
    // constraints. The details go to the server log.
    const failQuietly = (res, e, what) => {
        console.error(`[popup-builder] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };
    // Public routes answer every failure themselves, through failQuietly: a public caller only ever
    // gets a reply this plugin wrote.
    const quietly = (what, handler) => async (req, res) => {
        try { await handler(req, res); } catch (e) { failQuietly(res, e, what); }
    };

    // The active popup within its date window, or {} when there is nothing to show.
    http.route('get', '/public/active', quietly('active popup', async (req, res) => {
        const row = await db.get(`SELECT * FROM ${T.popups} WHERE enabled = 1 ORDER BY id DESC LIMIT 1`);
        if (!row) return res.json({});
        const now = Date.now();
        if (row.starts_at) {
            const t = Date.parse(row.starts_at);
            if (!Number.isNaN(t) && now < t) return res.json({});
        }
        if (row.ends_at) {
            const t = Date.parse(row.ends_at);
            if (!Number.isNaN(t) && now > t) return res.json({});
        }
        res.json({
            id: row.id,
            title: row.title,
            body: row.body || '',
            image_url: row.image_url || '',
            button_label: row.button_label || '',
            button_url: row.button_url || '',
            trigger_type: row.trigger_type || 'delay',
            trigger_value: row.trigger_value == null ? 3 : row.trigger_value,
            frequency: row.frequency || 'session',
            version: row.version || 1,
        });
    }));

    // View/click counter. Single-statement UPDATE (no transactions in the sandbox bridge).
    http.route('post', '/public/event', quietly('popup event', async (req, res) => {
        if (!eventAllowed(req)) {
            return res.status(429).json({ error: 'Demasiadas peticiones. Inténtalo de nuevo más tarde.' });
        }
        const body = req.body || {};
        const id = parseInt(body.popup_id, 10);
        const event = String(body.event || '');
        if (!Number.isFinite(id) || id < 1 || (event !== 'view' && event !== 'click')) {
            return res.status(400).json({ error: 'Evento inválido.' });
        }
        // Column name comes from a hard whitelist above — never from user input.
        const col = event === 'view' ? 'views' : 'clicks';
        await db.run(`UPDATE ${T.popups} SET ${col} = ${col} + 1 WHERE id = ?`, [id]);
        res.json({ ok: true });
    }));

    // ---- ADMIN routes -------------------------------------------------------------------------------

    // Full list with computed CTR (percentage, 1 decimal).
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.popups} ORDER BY enabled DESC, id DESC`);
        const popups = rows.map((r) => ({
            ...r,
            ctr: r.views > 0 ? Math.round((r.clicks / r.views) * 1000) / 10 : 0,
        }));
        res.json({ popups });
    });

    // Create or update. Enabling here disables every other popup (single-active rule).
    // On a content-changing update (or when the admin explicitly asks to re-show to everybody)
    // the version is bumped so every visitor's frequency cap resets.
    http.route('post', '/save', { auth: true, admin: true }, async (req, res) => {
        const b = req.body || {};

        const title = String(b.title || '').trim();
        if (!title) return res.status(400).json({ error: 'El título es obligatorio.' });

        const bodyText = String(b.body || '');
        const imageUrl = String(b.image_url || '').trim();
        const buttonLabel = String(b.button_label || '').trim();
        const buttonUrl = String(b.button_url || '').trim();

        const triggerType = String(b.trigger_type || 'delay');
        if (!TRIGGER_TYPES.includes(triggerType)) {
            return res.status(400).json({ error: 'Tipo de disparador inválido.' });
        }

        let triggerValue = 3;
        if (b.trigger_value !== undefined && b.trigger_value !== null && String(b.trigger_value).trim() !== '') {
            triggerValue = parseInt(b.trigger_value, 10);
            if (!Number.isFinite(triggerValue) || triggerValue < 0) {
                return res.status(400).json({ error: 'El valor del disparador debe ser un entero mayor o igual a 0.' });
            }
        }
        if (triggerType === 'scroll' && triggerValue > 100) {
            return res.status(400).json({ error: 'El porcentaje de scroll debe estar entre 0 y 100.' });
        }

        const frequency = String(b.frequency || 'session');
        if (!FREQUENCIES.includes(frequency)) {
            return res.status(400).json({ error: 'Frecuencia inválida.' });
        }

        const startsAt = String(b.starts_at || '').trim();
        const endsAt = String(b.ends_at || '').trim();
        if (!isValidDate(startsAt)) return res.status(400).json({ error: 'Fecha de inicio inválida.' });
        if (!isValidDate(endsAt)) return res.status(400).json({ error: 'Fecha de fin inválida.' });
        if (startsAt && endsAt && Date.parse(startsAt) > Date.parse(endsAt)) {
            return res.status(400).json({ error: 'La fecha de inicio no puede ser posterior a la fecha de fin.' });
        }

        if (!isValidUrl(imageUrl)) return res.status(400).json({ error: 'La URL de la imagen debe ser http(s) o relativa.' });
        if (!isValidUrl(buttonUrl)) return res.status(400).json({ error: 'La URL del botón debe ser http(s) o relativa.' });

        const id = b.id ? parseInt(b.id, 10) : 0;
        const enabledProvided = b.enabled !== undefined && b.enabled !== null;
        const wantEnabled = b.enabled === true || b.enabled === 1 || b.enabled === '1';

        if (id) {
            const existing = await db.get(`SELECT * FROM ${T.popups} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Popup no encontrado.' });

            const contentChanged =
                String(existing.title || '') !== title ||
                String(existing.body || '') !== bodyText ||
                String(existing.image_url || '') !== imageUrl ||
                String(existing.button_label || '') !== buttonLabel ||
                String(existing.button_url || '') !== buttonUrl;
            const bump = b.bump_version === true || contentChanged;
            const newVersion = bump ? (existing.version || 1) + 1 : (existing.version || 1);

            const enabled = enabledProvided ? (wantEnabled ? 1 : 0) : (existing.enabled ? 1 : 0);
            if (enabled) {
                // Single-active rule: two plain statements (the bridge has no transactions).
                await db.run(`UPDATE ${T.popups} SET enabled = 0 WHERE id != ?`, [id]);
            }
            await db.run(
                `UPDATE ${T.popups} SET title = ?, body = ?, image_url = ?, button_label = ?, button_url = ?,
                 enabled = ?, trigger_type = ?, trigger_value = ?, frequency = ?, starts_at = ?, ends_at = ?, version = ?
                 WHERE id = ?`,
                [title, bodyText, imageUrl, buttonLabel, buttonUrl, enabled, triggerType, triggerValue,
                 frequency, startsAt, endsAt, newVersion, id]
            );
            const row = await db.get(`SELECT * FROM ${T.popups} WHERE id = ?`, [id]);
            return res.json({ popup: row });
        }

        // Create
        if (wantEnabled) {
            await db.run(`UPDATE ${T.popups} SET enabled = 0`);
        }
        const result = await db.run(
            `INSERT INTO ${T.popups} (title, body, image_url, button_label, button_url, enabled,
             trigger_type, trigger_value, frequency, starts_at, ends_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [title, bodyText, imageUrl, buttonLabel, buttonUrl, wantEnabled ? 1 : 0,
             triggerType, triggerValue, frequency, startsAt, endsAt]
        );
        const row = await db.get(`SELECT * FROM ${T.popups} WHERE id = ?`, [result.lastID]);
        res.json({ popup: row });
    });

    // Enable ONE popup (disables all others first).
    http.route('post', '/:id/enable', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
        const row = await db.get(`SELECT id FROM ${T.popups} WHERE id = ?`, [id]);
        if (!row) return res.status(404).json({ error: 'Popup no encontrado.' });
        await db.run(`UPDATE ${T.popups} SET enabled = 0 WHERE id != ?`, [id]);
        await db.run(`UPDATE ${T.popups} SET enabled = 1 WHERE id = ?`, [id]);
        res.json({ ok: true });
    });

    http.route('post', '/:id/disable', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
        const row = await db.get(`SELECT id FROM ${T.popups} WHERE id = ?`, [id]);
        if (!row) return res.status(404).json({ error: 'Popup no encontrado.' });
        await db.run(`UPDATE ${T.popups} SET enabled = 0 WHERE id = ?`, [id]);
        res.json({ ok: true });
    });

    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Identificador inválido.' });
        const row = await db.get(`SELECT id FROM ${T.popups} WHERE id = ?`, [id]);
        if (!row) return res.status(404).json({ error: 'Popup no encontrado.' });
        await db.run(`DELETE FROM ${T.popups} WHERE id = ?`, [id]);
        res.json({ ok: true });
    });

    // ---- public assets + admin menu ------------------------------------------------------------------
    // Idempotent (upsert by handle). The plugin must still boot if the assets grant is missing.
    try {
        await assets.enqueueScript({ handle: 'popup-builder', src: 'public/popup.js', strategy: 'defer' });
        await assets.enqueueStyle({ handle: 'popup-builder', src: 'public/popup.css' });
    } catch (e) {
        console.warn('[popup-builder] could not enqueue public assets (missing grant?):', e && e.message ? e.message : e);
    }

    try {
        await adminMenu.add({
            href: '/admin/plugin/popups',
            label: 'Popups',
            icon: 'fa-window-restore',
            order: 64,
            cap: 'manage_options',
        });
    } catch (e) {
        console.warn('[popup-builder] could not register the admin menu:', e && e.message ? e.message : e);
    }

    console.log('[popup-builder] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; the rate-limit counters die with the process.
};
