/**
 * WordJS Plugin: Polls
 *
 * WordPress parity target: WP-Polls / Poll Maker. Admin creates polls (question + 2..12 options),
 * visitors vote through the public Puck block "Polls" and see animated result bars.
 *
 * Vote dedupe model (IMPORTANT): one vote per BROWSER, enforced client-side via
 * localStorage ('wjpoll_voted_<pollId>') — the same tradeoff as WP-Polls "cookie" mode.
 * The sandbox serializes requests WITHOUT req.ip, so server-side per-visitor dedupe is
 * impossible here; the real abuse bound is the in-memory rate cap (30 votes/min per poll).
 *
 * Option ids are stable numeric ids stored inside the poll's options JSON. Editing preserves
 * existing ids so old votes stay valid; a removed option leaves its votes orphaned-but-harmless
 * (they are excluded from display because results are keyed by the current option ids). New
 * options never reuse an id that has recorded votes.
 */

exports.metadata = {
    name: 'Polls',
    version: '1.0.0',
    description: 'Encuestas con bloque de votación Verso y barras de resultados',
    author: 'WordJS',
};

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const MAX_QUESTION_LEN = 500;
const MAX_LABEL_LEN = 200;
const SHOW_RESULTS_VALUES = ['after', 'always', 'never'];

// In-memory rolling-window rate cap per poll (no req.ip in the sandbox — see header comment).
const VOTE_WINDOW_MS = 60 * 1000;
const VOTE_CAP_PER_WINDOW = 30;

exports.init = async function (wordjs) {
    const { http, db, adminMenu } = wordjs;

    // Server-side one-vote-per-client (this process): poll_id -> Set<clientKey>. clientKey is the host's
    // privacy-preserving hashed-IP identity. The client-side localStorage dedup was trivially bypassed by
    // scripting POSTs (audit LOW); this bounds stuffing to one vote per client per poll per process.
    const votedClients = new Map();

    // Every table this plugin touches MUST start with the enforced prefix ('wjp_polls_').
    const T = {
        polls: db.tablePrefix + 'polls',
        votes: db.tablePrefix + 'votes',
    };

    // ---- schema (idempotent; final from day 1 — ALTER TABLE is unavailable in the sandbox) -------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.polls} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            options TEXT NOT NULL,
            is_open INTEGER DEFAULT 1,
            show_results TEXT DEFAULT 'after',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.votes} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            poll_id INTEGER NOT NULL,
            option_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
    await initSchema();

    // ---- helpers ----------------------------------------------------------------------------------

    /** Parse the options JSON column into a clean [{id, label}] array (never throws). */
    function parseOptions(text) {
        try {
            const arr = JSON.parse(String(text || '[]'));
            if (!Array.isArray(arr)) return [];
            const out = [];
            for (const o of arr) {
                if (o && Number.isInteger(o.id) && o.id > 0 && typeof o.label === 'string') {
                    out.push({ id: o.id, label: o.label });
                }
            }
            return out;
        } catch (e) {
            return [];
        }
    }

    /** Per-option vote counts + total for one poll (single GROUP BY — the db bridge has no transactions). */
    async function getResults(pollId) {
        const rows = await db.all(
            `SELECT option_id, COUNT(*) AS c FROM ${T.votes} WHERE poll_id = ? GROUP BY option_id`,
            [pollId]
        );
        const results = {};
        let total = 0;
        for (const row of rows) {
            const n = Number(row.c) || 0;
            results[Number(row.option_id)] = n;
            total += n;
        }
        return { results, total };
    }

    /** Serialize a poll row for the admin list (parsed options + counts). */
    async function adminPollPayload(row) {
        const { results, total } = await getResults(row.id);
        return {
            id: row.id,
            question: row.question,
            options: parseOptions(row.options),
            is_open: Number(row.is_open) ? 1 : 0,
            show_results: row.show_results || 'after',
            created_at: row.created_at,
            results,
            total,
        };
    }

    /**
     * Validate + normalize the incoming options payload for /save.
     * Returns { error } or { cleaned: [{id|null, label}] }.
     */
    function validateOptionsPayload(raw) {
        if (!Array.isArray(raw)) return { error: 'Las opciones deben ser una lista.' };
        const cleaned = [];
        for (const o of raw) {
            const label = String((o && o.label) == null ? '' : o.label).trim();
            if (!label) return { error: 'Todas las opciones deben tener texto.' };
            if (label.length > MAX_LABEL_LEN) {
                return { error: `Cada opción puede tener como máximo ${MAX_LABEL_LEN} caracteres.` };
            }
            const idNum = o && o.id != null ? parseInt(o.id, 10) : NaN;
            cleaned.push({ id: Number.isInteger(idNum) && idNum > 0 ? idNum : null, label });
        }
        if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) {
            return { error: `Una encuesta necesita entre ${MIN_OPTIONS} y ${MAX_OPTIONS} opciones.` };
        }
        return { cleaned };
    }

    // Rolling-window throttle state: pollId -> array of vote timestamps within the window.
    // Check and record are SEPARATE: only fully validated, inserted votes consume the budget, so
    // garbage requests (bad option_id, unknown poll) can't starve legitimate voters. The map is
    // bounded so fabricated poll_ids can't grow child-process memory without limit.
    const voteWindows = new Map();
    const MAX_WINDOW_ENTRIES = 500;
    function pruneVoteWindows(now) {
        if (voteWindows.size <= MAX_WINDOW_ENTRIES) return;
        for (const [key, times] of voteWindows) {
            if (!times.length || now - times[times.length - 1] >= VOTE_WINDOW_MS) voteWindows.delete(key);
        }
        // Still over the cap (all windows active)? Drop oldest-inserted entries.
        while (voteWindows.size > MAX_WINDOW_ENTRIES) {
            voteWindows.delete(voteWindows.keys().next().value);
        }
    }
    function voteThrottled(pollId) {
        const now = Date.now();
        const recent = (voteWindows.get(pollId) || []).filter((t) => now - t < VOTE_WINDOW_MS);
        if (recent.length) voteWindows.set(pollId, recent);
        else voteWindows.delete(pollId);
        return recent.length >= VOTE_CAP_PER_WINDOW;
    }
    function noteVote(pollId) {
        const now = Date.now();
        pruneVoteWindows(now);
        const recent = (voteWindows.get(pollId) || []).filter((t) => now - t < VOTE_WINDOW_MS);
        recent.push(now);
        voteWindows.set(pollId, recent);
    }

    // ---- admin routes -------------------------------------------------------------------------------

    // List every poll with total votes + per-option counts (one GROUP BY across all polls).
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        try {
            const polls = await db.all(`SELECT * FROM ${T.polls} ORDER BY id DESC`);
            const counts = await db.all(
                `SELECT poll_id, option_id, COUNT(*) AS c FROM ${T.votes} GROUP BY poll_id, option_id`
            );
            const byPoll = new Map();
            for (const row of counts) {
                const pid = Number(row.poll_id);
                if (!byPoll.has(pid)) byPoll.set(pid, { results: {}, total: 0 });
                const bucket = byPoll.get(pid);
                const n = Number(row.c) || 0;
                bucket.results[Number(row.option_id)] = n;
                bucket.total += n;
            }
            res.json(polls.map((p) => {
                const bucket = byPoll.get(Number(p.id)) || { results: {}, total: 0 };
                return {
                    id: p.id,
                    question: p.question,
                    options: parseOptions(p.options),
                    is_open: Number(p.is_open) ? 1 : 0,
                    show_results: p.show_results || 'after',
                    created_at: p.created_at,
                    results: bucket.results,
                    total: bucket.total,
                };
            }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create or update (by body.id). Option ids stay stable across edits so old votes remain valid.
    http.route('post', '/save', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const question = String(body.question == null ? '' : body.question).trim();
            if (!question) return res.status(400).json({ error: 'La pregunta es obligatoria.' });
            if (question.length > MAX_QUESTION_LEN) {
                return res.status(400).json({ error: `La pregunta puede tener como máximo ${MAX_QUESTION_LEN} caracteres.` });
            }
            const optCheck = validateOptionsPayload(body.options);
            if (optCheck.error) return res.status(400).json({ error: optCheck.error });
            const cleaned = optCheck.cleaned;
            const showResults = SHOW_RESULTS_VALUES.includes(body.show_results) ? body.show_results : 'after';

            const pollId = body.id != null ? parseInt(body.id, 10) : 0;

            if (pollId > 0) {
                // ---- update: preserve existing option ids; never reuse an id that has votes ----
                const existing = await db.get(`SELECT * FROM ${T.polls} WHERE id = ?`, [pollId]);
                if (!existing) return res.status(404).json({ error: 'Encuesta no encontrada.' });
                const existingOptions = parseOptions(existing.options);
                const existingIds = new Set(existingOptions.map((o) => o.id));
                const maxVotedRow = await db.get(
                    `SELECT MAX(option_id) AS m FROM ${T.votes} WHERE poll_id = ?`,
                    [pollId]
                );
                // Next fresh id must clear every id ever seen: current options, incoming ids and
                // voted-on ids (so an orphaned-but-voted id is never recycled onto a new label).
                let nextId = 1 + Math.max(
                    0,
                    Number(maxVotedRow && maxVotedRow.m) || 0,
                    ...existingOptions.map((o) => o.id),
                    ...cleaned.map((o) => o.id || 0)
                );
                const seen = new Set();
                const finalOptions = cleaned.map((o) => {
                    // Keep the id only if it references a real existing option and isn't duplicated
                    // in the payload; anything else is treated as a brand-new option.
                    let id = o.id && existingIds.has(o.id) && !seen.has(o.id) ? o.id : 0;
                    if (!id) { id = nextId; nextId += 1; }
                    seen.add(id);
                    return { id, label: o.label };
                });
                await db.run(
                    `UPDATE ${T.polls} SET question = ?, options = ?, show_results = ? WHERE id = ?`,
                    [question, JSON.stringify(finalOptions), showResults, pollId]
                );
                const row = await db.get(`SELECT * FROM ${T.polls} WHERE id = ?`, [pollId]);
                return res.json(await adminPollPayload(row));
            }

            // ---- create: fresh sequential ids 1..n ----
            const finalOptions = cleaned.map((o, i) => ({ id: i + 1, label: o.label }));
            const result = await db.run(
                `INSERT INTO ${T.polls} (question, options, is_open, show_results) VALUES (?, ?, 1, ?)`,
                [question, JSON.stringify(finalOptions), showResults]
            );
            const row = await db.get(`SELECT * FROM ${T.polls} WHERE id = ?`, [result.lastID]);
            res.json(await adminPollPayload(row));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Open/close a poll.
    http.route('post', '/:id/toggle', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params && req.params.id, 10);
            if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
            const poll = await db.get(`SELECT id, is_open FROM ${T.polls} WHERE id = ?`, [id]);
            if (!poll) return res.status(404).json({ error: 'Encuesta no encontrada.' });
            const next = Number(poll.is_open) ? 0 : 1;
            await db.run(`UPDATE ${T.polls} SET is_open = ? WHERE id = ?`, [next, id]);
            res.json({ success: true, id, is_open: next });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete a poll AND its votes (no cascade — two statements, votes first).
    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params && req.params.id, 10);
            if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });
            const poll = await db.get(`SELECT id FROM ${T.polls} WHERE id = ?`, [id]);
            if (!poll) return res.status(404).json({ error: 'Encuesta no encontrada.' });
            await db.run(`DELETE FROM ${T.votes} WHERE poll_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.polls} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- public routes (consumed by the Puck block from the editor iframe AND the public site) ------

    // GET /public/poll?id=X[&voted=1]
    // Results disclosure: 'always' → everyone; 'after' → the client attests it already voted
    // (voted=1 — per-browser dedupe is client-side anyway, so this is not a new leak) and everyone
    // once the poll is closed; 'never' → nobody (the block shows a thank-you instead).
    http.route('get', '/public/poll', async (req, res) => {
        try {
            const id = parseInt((req.query && req.query.id) || '', 10);
            if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Falta el parámetro id.' });
            const poll = await db.get(`SELECT * FROM ${T.polls} WHERE id = ?`, [id]);
            if (!poll) return res.status(404).json({ error: 'Encuesta no encontrada.' });
            const isOpen = Number(poll.is_open) ? 1 : 0;
            const show = SHOW_RESULTS_VALUES.includes(poll.show_results) ? poll.show_results : 'after';
            const voted = String((req.query && req.query.voted) || '') === '1';
            const payload = {
                id: poll.id,
                question: poll.question,
                options: parseOptions(poll.options),
                is_open: isOpen,
                show_results: show,
            };
            if (show === 'always' || (show === 'after' && (voted || !isOpen))) {
                const agg = await getResults(id);
                payload.results = agg.results;
                payload.total = agg.total;
            }
            res.json(payload);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /public/vote {poll_id, option_id}
    // Returns fresh results ONLY when the poll's show_results allows them — otherwise a single
    // vote (or a direct POST) would leak counts the admin chose to keep hidden ('never').
    http.route('post', '/public/vote', async (req, res) => {
        try {
            const body = req.body || {};
            const pollId = parseInt(body.poll_id, 10);
            const optionId = parseInt(body.option_id, 10);
            if (!Number.isInteger(pollId) || pollId < 1 || !Number.isInteger(optionId) || optionId < 1) {
                return res.status(400).json({ error: 'Datos de voto inválidos.' });
            }
            // Throttle check before the DB; the budget is only CONSUMED after a valid insert.
            if (voteThrottled(pollId)) {
                return res.status(429).json({ error: 'Demasiados votos en poco tiempo. Inténtalo de nuevo en un minuto.' });
            }
            // Server-side one-vote-per-client via the host's privacy-preserving clientKey (hashed IP).
            const clientKey = String((req && req.clientKey) || '');
            if (clientKey && votedClients.get(pollId) && votedClients.get(pollId).has(clientKey)) {
                return res.status(409).json({ error: 'Ya registramos tu voto en esta encuesta.' });
            }
            const poll = await db.get(`SELECT * FROM ${T.polls} WHERE id = ?`, [pollId]);
            if (!poll) return res.status(404).json({ error: 'Encuesta no encontrada.' });
            if (!Number(poll.is_open)) return res.status(403).json({ error: 'La encuesta está cerrada.' });
            const options = parseOptions(poll.options);
            if (!options.some((o) => o.id === optionId)) {
                return res.status(400).json({ error: 'Opción inválida.' });
            }
            await db.run(`INSERT INTO ${T.votes} (poll_id, option_id) VALUES (?, ?)`, [pollId, optionId]);
            if (clientKey) {
                if (votedClients.size > 5000) votedClients.clear(); // crude bound on process memory
                let seen = votedClients.get(pollId);
                if (!seen) { seen = new Set(); votedClients.set(pollId, seen); }
                if (seen.size < 100000) seen.add(clientKey);
            }
            noteVote(pollId);
            const show = SHOW_RESULTS_VALUES.includes(poll.show_results) ? poll.show_results : 'after';
            const payload = { success: true };
            if (show !== 'never') {
                const agg = await getResults(pollId);
                payload.results = agg.results;
                payload.total = agg.total;
            }
            res.json(payload);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- admin sidebar -------------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/polls',
        label: 'Encuestas',
        icon: 'fa-square-poll-vertical',
        order: 67,
        cap: 'manage_options',
    });

    console.log('[polls] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers, servers or transports.
};
