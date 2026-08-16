/**
 * WordJS Plugin: Events Calendar — ISOLATED, sandboxed.
 *
 * WordPress parity: The Events Calendar. Admin manages events (title, dates, location, url,
 * color); the "EventsCalendar" Puck block renders them on any page as an upcoming list or a
 * monthly calendar grid.
 *
 * Sandbox notes:
 *  - Single table under the enforced prefix (db.tablePrefix -> 'wjp_events_calendar_').
 *  - Full schema created up-front (no ALTER TABLE available to plugins).
 *  - Dates are stored as local-naive ISO strings 'YYYY-MM-DDTHH:mm' so that string comparison
 *    (>=, <=, ORDER BY) is chronologically correct — no timezone math in SQL.
 *  - Public endpoint is unauthenticated (the Puck block calls it from the editor iframe AND the
 *    public page); it only exposes non-sensitive columns and caps the limit.
 */

exports.metadata = {
    name: 'Events Calendar',
    version: '1.0.0',
    description: 'Admin-managed events + Verso block (upcoming list / monthly calendar grid)',
    author: 'WordJS',
};

const DEFAULT_COLOR = '#3b82f6';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Accepts 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' (the shapes the admin form and the block send).
const DATEISH_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const PUBLIC_DEFAULT_LIMIT = 50;
const PUBLIC_MAX_LIMIT = 200;

/** Local (server-tz) "now" in the same 'YYYY-MM-DDTHH:mm' shape the rows store. */
function localNowMinute() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** Local (server-tz) today as 'YYYY-MM-DD' (date-only compares before any time on that day). */
function localToday() {
    return localNowMinute().slice(0, 10);
}

exports.init = async function (wordjs) {
    const { db, http, adminMenu } = wordjs;

    // Enforced per-plugin table namespace: 'events-calendar' -> 'wjp_events_calendar_'.
    const T = { events: db.tablePrefix + 'events' };

    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.events} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            location TEXT,
            starts_at TEXT NOT NULL,
            ends_at TEXT,
            all_day INTEGER DEFAULT 0,
            url TEXT,
            color TEXT DEFAULT '${DEFAULT_COLOR}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        try {
            // Index name AND target must carry the plugin prefix (assertSqlAllowed enforces it).
            await db.run(`CREATE INDEX IF NOT EXISTS ${db.tablePrefix}idx_events_starts_at ON ${T.events} (starts_at)`);
        } catch (e) {
            // Non-fatal: some drivers may not support IF NOT EXISTS on indexes.
        }
    }
    await initSchema();

    /**
     * Validates and normalizes an event payload. Returns { error } (Spanish, user-facing) or the
     * clean column values ready to bind.
     */
    function validateEventBody(body) {
        const title = String(body.title == null ? '' : body.title).trim();
        if (!title) return { error: 'El título es obligatorio.' };

        const startsAt = String(body.starts_at == null ? '' : body.starts_at).trim();
        if (!startsAt || !DATEISH_RE.test(startsAt) || isNaN(new Date(startsAt).getTime())) {
            return { error: 'La fecha de inicio no es válida.' };
        }

        let endsAt = String(body.ends_at == null ? '' : body.ends_at).trim();
        if (endsAt) {
            if (!DATEISH_RE.test(endsAt) || isNaN(new Date(endsAt).getTime())) {
                return { error: 'La fecha de fin no es válida.' };
            }
            if (new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
                return { error: 'La fecha de fin debe ser igual o posterior a la de inicio.' };
            }
        } else {
            endsAt = null;
        }

        let color = String(body.color == null ? '' : body.color).trim();
        if (!COLOR_RE.test(color)) color = DEFAULT_COLOR;

        const clean = (v, max) => {
            const s = String(v == null ? '' : v).trim().slice(0, max);
            return s || null;
        };

        return {
            title: title.slice(0, 300),
            description: clean(body.description, 5000),
            location: clean(body.location, 500),
            starts_at: startsAt,
            ends_at: endsAt,
            all_day: body.all_day ? 1 : 0,
            url: clean(body.url, 2000),
            color,
        };
    }

    // ---- admin routes -----------------------------------------------------------------------------

    // List events. ?scope=upcoming|past|all (default all). Upcoming = starts_at >= now (ASC),
    // past = starts_at < now (DESC), all = everything (ASC).
    http.route('get', '/events', { auth: true, admin: true }, async (req, res) => {
        const scope = String((req.query && req.query.scope) || 'all');
        const now = localNowMinute();
        let rows;
        if (scope === 'upcoming') {
            rows = await db.all(`SELECT * FROM ${T.events} WHERE starts_at >= ? ORDER BY starts_at ASC`, [now]);
        } else if (scope === 'past') {
            rows = await db.all(`SELECT * FROM ${T.events} WHERE starts_at < ? ORDER BY starts_at DESC`, [now]);
        } else {
            rows = await db.all(`SELECT * FROM ${T.events} ORDER BY starts_at ASC`, []);
        }
        res.json({ events: rows });
    });

    // Create (no id) or update (id present) an event.
    http.route('post', '/events', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const v = validateEventBody(body);
        if (v.error) return res.status(400).json({ error: v.error });

        const id = parseInt(body.id, 10);
        if (Number.isFinite(id) && id > 0) {
            const existing = await db.get(`SELECT id FROM ${T.events} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'El evento no existe.' });
            await db.run(
                `UPDATE ${T.events}
                 SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, url = ?, color = ?
                 WHERE id = ?`,
                [v.title, v.description, v.location, v.starts_at, v.ends_at, v.all_day, v.url, v.color, id]
            );
            const row = await db.get(`SELECT * FROM ${T.events} WHERE id = ?`, [id]);
            return res.json({ event: row });
        }

        const result = await db.run(
            `INSERT INTO ${T.events} (title, description, location, starts_at, ends_at, all_day, url, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [v.title, v.description, v.location, v.starts_at, v.ends_at, v.all_day, v.url, v.color]
        );
        const row = await db.get(`SELECT * FROM ${T.events} WHERE id = ?`, [result.lastID]);
        res.json({ event: row });
    });

    http.route('delete', '/events/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params && req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Identificador de evento no válido.' });
        const existing = await db.get(`SELECT id FROM ${T.events} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'El evento no existe.' });
        await db.run(`DELETE FROM ${T.events} WHERE id = ?`, [id]);
        res.json({ ok: true });
    });

    // ---- public route (Puck block: editor iframe + public page) ------------------------------------

    // GET /public/events?from=&to=&limit=
    //   from: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' (default: today, date-only — includes all of today)
    //   to:   same shapes; a date-only value includes that whole day
    //   limit: default 50, cap 200
    http.route('get', '/public/events', async (req, res) => {
        const q = req.query || {};

        let from = String(q.from == null ? '' : q.from).trim();
        if (!DATEISH_RE.test(from)) from = localToday();

        let to = String(q.to == null ? '' : q.to).trim();
        if (!DATEISH_RE.test(to)) to = '';
        // A date-only upper bound must include the whole day (rows carry a time component).
        if (to && to.length === 10) to = to + 'T23:59';

        let limit = parseInt(q.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = PUBLIC_DEFAULT_LIMIT;
        if (limit > PUBLIC_MAX_LIMIT) limit = PUBLIC_MAX_LIMIT;

        let where = 'starts_at >= ?';
        const params = [from];
        if (to) {
            where += ' AND starts_at <= ?';
            params.push(to);
        }
        params.push(limit);

        const rows = await db.all(
            `SELECT id, title, description, location, starts_at, ends_at, all_day, url, color
             FROM ${T.events} WHERE ${where} ORDER BY starts_at ASC LIMIT ?`,
            params
        );
        res.json({ events: rows });
    });

    // ---- admin menu ---------------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/events-calendar',
        label: 'Eventos',
        icon: 'fa-calendar-days',
        order: 57,
        cap: 'manage_options',
    });

    console.log('[events-calendar] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down: no timers, no servers — all work happens per-request.
};
