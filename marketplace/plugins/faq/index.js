/**
 * WordJS Plugin: FAQ
 *
 * Database-managed frequently-asked-questions with categories. Admin CRUD (create/update,
 * publish toggle, reorder, delete) plus a public read endpoint consumed by the Puck block
 * "Faq", which renders an accordion WITH Google FAQPage JSON-LD structured data — the
 * differentiator versus the core static Accordion block.
 *
 * Sandbox notes:
 *  - All tables live under the enforced plugin prefix (db.tablePrefix -> 'wjp_faq_').
 *  - Schema is final from day 1 (no ALTER available); created idempotently at init.
 *  - The db bridge has no transactions: reorder applies one UPDATE per id, and the publish
 *    toggle flips in a single statement so it stays race-free.
 */

exports.metadata = {
    name: 'FAQ',
    version: '1.0.0',
    description: 'FAQ with categories + Verso accordion block with FAQPage JSON-LD rich-results markup',
    author: 'WordJS',
};

const MAX_QUESTION_LEN = 500;
const MAX_ANSWER_LEN = 10000;
const MAX_CATEGORY_LEN = 120;
const MAX_REORDER_IDS = 500;
const PUBLIC_MAX_LIMIT = 100;

exports.init = async function (wordjs) {
    const { db, http, adminMenu } = wordjs;

    // Every table MUST start with the enforced prefix. slug 'faq' -> 'wjp_faq_'.
    const T = { faqs: db.tablePrefix + 'faqs' };

    // ---- schema (idempotent; full column set up-front — no ALTER in the sandbox) -----------------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.faqs} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            category TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            is_published INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        try {
            // Index name AND target must carry the plugin prefix (host default-deny check).
            await db.run(`CREATE INDEX IF NOT EXISTS ${db.tablePrefix}idx_faqs_cat_order ON ${T.faqs} (category, sort_order)`);
        } catch (e) {
            // Non-fatal: the table works without the index.
        }
    }
    await initSchema();

    // ---- helpers ----------------------------------------------------------------------------------
    const parseId = (raw) => {
        const id = parseInt(raw, 10);
        return Number.isInteger(id) && id > 0 ? id : null;
    };

    const FAQ_COLUMNS = 'id, question, answer, category, sort_order, is_published, created_at';

    // ---- admin routes -----------------------------------------------------------------------------

    // Full list for the admin page, grouped client-side (server keeps the canonical order).
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(
            `SELECT ${FAQ_COLUMNS} FROM ${T.faqs} ORDER BY category ASC, sort_order ASC, id ASC`
        );
        res.json({ faqs: rows });
    });

    // Create (no id) or update (with id). Question and answer are required.
    http.route('post', '/save', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const question = String(body.question == null ? '' : body.question).trim();
        const answer = String(body.answer == null ? '' : body.answer).trim();
        const category = String(body.category == null ? '' : body.category).trim();

        if (!question || !answer) {
            return res.status(400).json({ error: 'La pregunta y la respuesta son obligatorias.' });
        }
        if (question.length > MAX_QUESTION_LEN) {
            return res.status(400).json({ error: `La pregunta es demasiado larga (máximo ${MAX_QUESTION_LEN} caracteres).` });
        }
        if (answer.length > MAX_ANSWER_LEN) {
            return res.status(400).json({ error: `La respuesta es demasiado larga (máximo ${MAX_ANSWER_LEN} caracteres).` });
        }
        if (category.length > MAX_CATEGORY_LEN) {
            return res.status(400).json({ error: `La categoría es demasiado larga (máximo ${MAX_CATEGORY_LEN} caracteres).` });
        }

        const hasId = body.id !== undefined && body.id !== null && body.id !== '';
        if (hasId) {
            const id = parseId(body.id);
            if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
            const existing = await db.get(`SELECT id FROM ${T.faqs} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'La pregunta no existe.' });
            await db.run(
                `UPDATE ${T.faqs} SET question = ?, answer = ?, category = ? WHERE id = ?`,
                [question, answer, category, id]
            );
            const row = await db.get(`SELECT ${FAQ_COLUMNS} FROM ${T.faqs} WHERE id = ?`, [id]);
            return res.json({ faq: row });
        }

        // New entries land at the end of their category.
        const next = await db.get(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM ${T.faqs} WHERE category = ?`,
            [category]
        );
        const result = await db.run(
            `INSERT INTO ${T.faqs} (question, answer, category, sort_order) VALUES (?, ?, ?, ?)`,
            [question, answer, category, (next && next.next_order) || 0]
        );
        const row = await db.get(`SELECT ${FAQ_COLUMNS} FROM ${T.faqs} WHERE id = ?`, [result.lastID]);
        res.json({ faq: row });
    });

    // Reorder: sort_order = index of each id in the submitted array. No transactions in the
    // sandbox db bridge, so this applies one UPDATE per id (unknown ids are simply no-ops).
    http.route('post', '/reorder', { auth: true, admin: true }, async (req, res) => {
        const ids = req.body && req.body.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Se requiere una lista de identificadores.' });
        }
        if (ids.length > MAX_REORDER_IDS) {
            return res.status(400).json({ error: `Demasiados elementos para reordenar (máximo ${MAX_REORDER_IDS}).` });
        }
        const clean = [];
        for (const raw of ids) {
            const id = parseId(raw);
            if (!id) return res.status(400).json({ error: 'Identificador inválido en la lista.' });
            clean.push(id);
        }
        for (let i = 0; i < clean.length; i++) {
            await db.run(`UPDATE ${T.faqs} SET sort_order = ? WHERE id = ?`, [i, clean[i]]);
        }
        res.json({ success: true });
    });

    // Publish/unpublish flip — a single statement, so concurrent toggles cannot lose an update.
    http.route('post', '/:id/toggle', { auth: true, admin: true }, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
        await db.run(
            `UPDATE ${T.faqs} SET is_published = CASE WHEN is_published = 1 THEN 0 ELSE 1 END WHERE id = ?`,
            [id]
        );
        const row = await db.get(`SELECT id, is_published FROM ${T.faqs} WHERE id = ?`, [id]);
        if (!row) return res.status(404).json({ error: 'La pregunta no existe.' });
        res.json({ id: row.id, is_published: row.is_published });
    });

    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
        const existing = await db.get(`SELECT id FROM ${T.faqs} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'La pregunta no existe.' });
        await db.run(`DELETE FROM ${T.faqs} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    // Distinct non-empty categories (feeds the admin datalist).
    http.route('get', '/categories', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(
            `SELECT DISTINCT category FROM ${T.faqs} WHERE category IS NOT NULL AND category != '' ORDER BY category ASC`
        );
        res.json({ categories: rows.map((r) => r.category) });
    });

    // ---- public route (the Puck block calls this from the editor iframe AND the public site) ------
    http.route('get', '/public/list', async (req, res) => {
        const q = req.query || {};
        const category = String(q.category == null ? '' : q.category).trim();
        let limit = parseInt(q.limit == null ? PUBLIC_MAX_LIMIT : q.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = PUBLIC_MAX_LIMIT;
        limit = Math.min(limit, PUBLIC_MAX_LIMIT);

        let where = 'WHERE is_published = 1';
        const params = [];
        if (category) {
            where += ' AND category = ?';
            params.push(category.slice(0, MAX_CATEGORY_LEN));
        }
        params.push(limit);
        const rows = await db.all(
            `SELECT id, question, answer, category FROM ${T.faqs} ${where} ORDER BY category ASC, sort_order ASC, id ASC LIMIT ?`,
            params
        );
        res.json({ faqs: rows });
    });

    adminMenu.add({
        href: '/admin/plugin/faq',
        label: 'FAQ',
        icon: 'fa-circle-question',
        order: 63,
        cap: 'manage_options',
    });

    console.log('[faq] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers, no servers.
};
