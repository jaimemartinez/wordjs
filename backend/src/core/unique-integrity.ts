/**
 * WordJS — the database's uniqueness rules, as one live picture: is each rule ENFORCED by a unique index,
 * and if not, which stored rows stand in its way.
 *
 *   users.login   a login names one account            idx_users_login
 *   users.email   an email (case-folded) names one     idx_users_email (SQLite/Postgres) · uq_users_email (MySQL)
 *   posts.slug    a slug is unique within its type     idx_posts_name_type             · uq_posts_slug
 *   terms.slug    a term slug is unique site-wide      uq_terms_slug
 *
 * The indexes are built by initializeSchema and migrations 0001 / 0020 / 0023. When stored rows already
 * break a rule the index cannot be built, and those migrations now wait (they are not recorded until the
 * index exists, so every boot tries again). This module is what the panel reads and acts on:
 *
 *   uniqueIntegrityStatus()   one entry per rule: enforced, how many duplicate groups (Site Health, the screen)
 *   listDuplicates(rule)      the groups and their rows, for an administrator to choose which row keeps the value
 *   resolveDuplicate(...)     the chosen row keeps it; every other row gets a NEW unique value. Nothing is
 *                             deleted: each change is returned, written to the audit log and, for accounts,
 *                             the previous value is kept in the account's meta.
 *   ensureUniqueIndexes()     builds every index that can be built now (no restart needed after a clean-up)
 *
 * The application never relies on a rule this reports as not enforced: User.findByLogin/findByEmail
 * answer "nobody" when two accounts match, so a sign-in or a password reset can never pick one at random.
 */

const log = require('./module-logger').moduleLogger('core/unique-integrity');

export type Engine = 'sqlite' | 'postgres' | 'mysql';
export type RuleId = 'users.login' | 'users.email' | 'posts.slug' | 'terms.slug';

type Q = {
    exec: (sql: string) => Promise<any>;
    run: (sql: string, params?: any[]) => Promise<any>;
    get: (sql: string, params?: any[]) => Promise<any>;
    all: (sql: string, params?: any[]) => Promise<any>;
};

type Rule = {
    id: RuleId;
    table: 'users' | 'posts' | 'terms';
    idColumn: string;
    /** The index that enforces the rule on this engine. */
    index: (e: Engine) => string;
    /** The rule's key, as SQL: rows with the same key collide. Never user input. */
    key: (e: Engine) => string;
    /** Rows the rule does not cover (posts and terms without a slug). */
    where: string;
    /** The columns shown for each row on the screen. */
    columns: string;
    /** Build the index (SQLite/Postgres); MySQL goes through core/mysql-unique-keys. */
    createSql?: string;
};

// MySQL compares with the column's collation (utf8mb4_unicode_ci folds case AND accents), while the key
// columns of core/mysql-unique-keys are utf8mb4_bin. The duplicate scan must use the index's own rule, or
// 'josé' and 'jose' would be reported as a collision the index does not have.
const MYSQL_BIN = (expr: string) => `CONVERT(${expr} USING utf8mb4) COLLATE utf8mb4_bin`;

const RULES: Rule[] = [
    {
        id: 'users.login', table: 'users', idColumn: 'id',
        index: () => 'idx_users_login',
        // MySQL's unique index on user_login uses the column collation, so the scan does too.
        key: () => 'user_login',
        where: '1 = 1',
        columns: 'id, user_login, user_email, display_name, user_registered',
        createSql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users (user_login)',
    },
    {
        id: 'users.email', table: 'users', idColumn: 'id',
        index: (e) => (e === 'mysql' ? 'uq_users_email' : 'idx_users_email'),
        key: (e) => (e === 'mysql' ? MYSQL_BIN('LOWER(user_email)') : 'LOWER(user_email)'),
        where: '1 = 1',
        columns: 'id, user_login, user_email, display_name, user_registered',
        createSql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(user_email))',
    },
    {
        id: 'posts.slug', table: 'posts', idColumn: 'id',
        index: (e) => (e === 'mysql' ? 'uq_posts_slug' : 'idx_posts_name_type'),
        key: (e) => (e === 'mysql' ? MYSQL_BIN("CONCAT(post_type, '/', post_name)") : "post_type || '/' || post_name"),
        where: "post_name <> ''",
        columns: 'id, post_title, post_name, post_type, post_status, post_date',
        createSql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_name_type ON posts (post_name, post_type) WHERE post_name <> ''",
    },
    {
        id: 'terms.slug', table: 'terms', idColumn: 'term_id',
        index: () => 'uq_terms_slug',
        key: (e) => (e === 'mysql' ? MYSQL_BIN('slug') : 'slug'),
        where: "slug <> ''",
        columns: 'term_id, name, slug',
        createSql: "CREATE UNIQUE INDEX IF NOT EXISTS uq_terms_slug ON terms (slug) WHERE slug <> ''",
    },
];

const RULE_IDS = RULES.map((r) => r.id);

function ruleById(id: unknown): Rule | null {
    return RULES.find((r) => r.id === id) || null;
}

function engineOf(driverName: string): Engine {
    if (driverName === 'postgres') return 'postgres';
    if (driverName === 'mysql' || driverName === 'mariadb') return 'mysql';
    return 'sqlite';
}

function defaultQ(): Q {
    const { dbAsync } = require('../config/database');
    return {
        exec: (sql) => dbAsync.exec(sql),
        run: (sql, params = []) => dbAsync.run(sql, params),
        get: (sql, params = []) => dbAsync.get(sql, params),
        all: (sql, params = []) => dbAsync.all(sql, params),
    };
}

function defaultEngine(): Engine {
    const { getDbType } = require('../config/database');
    const t = getDbType();
    return t.isPostgres ? 'postgres' : t.isMySQL ? 'mysql' : 'sqlite';
}

async function indexExists(q: Q, e: Engine, table: string, index: string): Promise<boolean> {
    if (e === 'postgres') {
        return !!(await q.get('SELECT 1 AS ok FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?', [table, index]));
    }
    if (e === 'mysql') {
        return !!(await q.get('SELECT 1 AS ok FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [table, index]));
    }
    return !!(await q.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?", [table, index]));
}

async function duplicateGroups(q: Q, e: Engine, r: Rule, limit = 200): Promise<Array<{ key: string; count: number }>> {
    const key = r.key(e);
    const rows = (await q.all(
        `SELECT ${key} AS k, COUNT(*) AS c FROM ${r.table} WHERE ${r.where} GROUP BY ${key} HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT ?`,
        [Math.max(1, Math.floor(Number(limit) || 1))]
    )) || [];
    return rows.map((d: any) => ({ key: d.k === null || d.k === undefined ? '' : String(d.k), count: Number(d.c) || 0 }));
}

export type RuleStatus = { id: RuleId; table: string; index: string; enforced: boolean; duplicateGroups: number; error?: string };

/** Every rule, live from the database's own catalogue. Never throws: a probe that fails is reported. */
async function uniqueIntegrityStatus(q: Q = defaultQ(), e: Engine = defaultEngine()): Promise<RuleStatus[]> {
    const out: RuleStatus[] = [];
    for (const r of RULES) {
        const index = r.index(e);
        try {
            const enforced = await indexExists(q, e, r.table, index);
            const groups = enforced ? [] : await duplicateGroups(q, e, r, 1000);
            out.push({ id: r.id, table: r.table, index, enforced, duplicateGroups: groups.length });
        } catch (err: any) {
            out.push({ id: r.id, table: r.table, index, enforced: false, duplicateGroups: 0, error: String((err && err.message) || err) });
        }
    }
    return out;
}

/**
 * Build every index that can be built now. A rule whose rows still collide is left out (and listed);
 * nothing here throws. Returns the rules that are enforced afterwards and those that are not.
 */
async function ensureUniqueIndexes(q: Q = defaultQ(), e: Engine = defaultEngine()): Promise<{ enforced: RuleId[]; missing: RuleId[] }> {
    if (e === 'mysql') {
        try {
            await require('./mysql-unique-keys').ensureMysqlUniqueKeys(q);
        } catch (err: any) {
            log.warn({ err }, '⚠️  MySQL unique keys could not be ensured');
        }
    }
    const enforced: RuleId[] = [];
    const missing: RuleId[] = [];
    for (const r of RULES) {
        const index = r.index(e);
        try {
            if (await indexExists(q, e, r.table, index)) { enforced.push(r.id); continue; }
            // MySQL's email/slug/term keys are generated columns (core/mysql-unique-keys, above); only the
            // plain login index is a CREATE INDEX there.
            if (e !== 'mysql' || r.id === 'users.login') {
                const groups = await duplicateGroups(q, e, r, 21);
                if (groups.length) {
                    log.warn({ rule: r.id, groups: groups.length }, `⚠️  ${r.id}: ${groups.length >= 21 ? 'more than 20' : groups.length} value(s) are stored more than once, so ${index} is not built yet. Resolve them in Admin → Site Health → Duplicate records.`);
                } else if (r.createSql) {
                    await q.exec(r.createSql);
                }
            }
            if (await indexExists(q, e, r.table, index)) enforced.push(r.id); else missing.push(r.id);
        } catch (err: any) {
            log.warn({ err, rule: r.id }, `⚠️  could not build the unique index ${index}`);
            missing.push(r.id);
        }
    }
    return { enforced, missing };
}

export type DuplicateRow = Record<string, any> & { id: number };
export type DuplicateGroup = { key: string; count: number; rows: DuplicateRow[] };

/** The groups that break one rule, each with its rows (oldest first), for the screen. */
async function listDuplicates(ruleId: RuleId, opts: { limit?: number } = {}, q: Q = defaultQ(), e: Engine = defaultEngine()): Promise<DuplicateGroup[]> {
    const r = ruleById(ruleId);
    if (!r) throw Object.assign(new Error('Unknown rule'), { status: 400 });
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
    const groups = await duplicateGroups(q, e, r, limit);
    const out: DuplicateGroup[] = [];
    for (const g of groups) {
        const rows = (await q.all(
            `SELECT ${r.columns} FROM ${r.table} WHERE ${r.where} AND ${r.key(e)} = ? ORDER BY ${r.idColumn} ASC LIMIT 50`,
            [g.key]
        )) || [];
        out.push({ key: g.key, count: g.count, rows: rows.map((row: any) => ({ ...row, id: Number(row[r.idColumn]) })) });
    }
    return out;
}

export type Change = { id: number; field: string; from: string; to: string };

/** A login no other account holds, in any letter case and in neither namespace (THE USERNAME RULE). */
async function freeLogin(base: string, id: number): Promise<string> {
    const User = require('../models/User');
    const stem = String(base || 'user').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 50) || 'user';
    for (let n = 0; n < 1000; n++) {
        const candidate = n === 0 ? `${stem}-${id}` : `${stem}-${id}-${n + 1}`;
        if (!(await User.identifierInUse(candidate, id))) return candidate;
    }
    throw new Error('No free login found');
}

/**
 * An address the account keeps receiving at: the same mailbox with a `+dup<id>` tag (subaddressing), so
 * the value becomes unique without inventing a new destination.
 */
async function freeEmail(email: string, id: number): Promise<string> {
    const User = require('../models/User');
    const at = email.lastIndexOf('@');
    const local = at > 0 ? email.slice(0, at) : 'user';
    const domain = at > 0 ? email.slice(at + 1) : 'invalid.example';
    for (let n = 0; n < 1000; n++) {
        const candidate = `${local}+dup${id}${n ? `-${n + 1}` : ''}@${domain}`.toLowerCase();
        if (!(await User.identifierInUse(candidate, id))) return candidate;
    }
    throw new Error('No free email found');
}

/**
 * Resolve ONE duplicate group: `keepId` keeps the value; every other row of the group gets a new unique
 * one. Never deletes. Returns the changes made (they are also audited by the caller's route).
 * Throws { status: 400/404 } when the group or the row to keep is not what the screen showed.
 */
async function resolveDuplicate(ruleId: RuleId, key: string, keepId: number, q: Q = defaultQ(), e: Engine = defaultEngine()): Promise<Change[]> {
    const r = ruleById(ruleId);
    if (!r) throw Object.assign(new Error('Unknown rule'), { status: 400 });
    const rows = ((await q.all(
        `SELECT ${r.columns} FROM ${r.table} WHERE ${r.where} AND ${r.key(e)} = ? ORDER BY ${r.idColumn} ASC`,
        [String(key)]
    )) || []).map((row: any) => ({ ...row, id: Number(row[r.idColumn]) }));
    if (rows.length < 2) throw Object.assign(new Error('This value is no longer duplicated.'), { status: 404, code: 'rest_duplicate_gone' });
    if (!rows.some((row: any) => row.id === Number(keepId))) throw Object.assign(new Error('The row to keep is not part of this group.'), { status: 400, code: 'rest_invalid_param' });

    const changes: Change[] = [];
    const cache = require('./cache');
    for (const row of rows) {
        if (row.id === Number(keepId)) continue;
        if (r.id === 'users.login') {
            const to = await freeLogin(row.user_login, row.id);
            await q.run('UPDATE users SET user_login = ? WHERE id = ?', [to, row.id]);
            await require('../models/User').updateMeta(row.id, '_wordjs_previous_login', String(row.user_login));
            await cache.del(`user:${row.id}`);
            changes.push({ id: row.id, field: 'user_login', from: String(row.user_login), to });
        } else if (r.id === 'users.email') {
            const to = await freeEmail(String(row.user_email || ''), row.id);
            await q.run('UPDATE users SET user_email = ? WHERE id = ?', [to, row.id]);
            await require('../models/User').updateMeta(row.id, '_wordjs_previous_email', String(row.user_email));
            await cache.del(`user:${row.id}`);
            changes.push({ id: row.id, field: 'user_email', from: String(row.user_email), to });
        } else if (r.id === 'posts.slug') {
            const Post = require('../models/Post');
            const to = await Post.generateUniqueSlug(String(row.post_name), String(row.post_type), row.id, 'type');
            // Post.update keeps revisions, caches and the outbox in step with the new address.
            await Post.update(row.id, { slug: to });
            const after = await q.get('SELECT post_name FROM posts WHERE id = ?', [row.id]);
            changes.push({ id: row.id, field: 'post_name', from: String(row.post_name), to: String((after && after.post_name) || to) });
        } else {
            // Term.update is the one writer of terms.slug (it bounds it); asked for the slug the term already
            // has, it gives the next free one, because the other rows of the group hold this one.
            const Term = require('../models/Term');
            const tt = await q.get('SELECT taxonomy FROM term_taxonomy WHERE term_id = ? ORDER BY term_taxonomy_id ASC LIMIT 1', [row.id]);
            if (!tt) throw Object.assign(new Error(`Term ${row.id} has no taxonomy; edit it in the database.`), { status: 409, code: 'rest_term_orphan' });
            await Term.update(row.id, String(tt.taxonomy), { slug: String(row.slug) });
            const after = await q.get('SELECT slug FROM terms WHERE term_id = ?', [row.id]);
            changes.push({ id: row.id, field: 'slug', from: String(row.slug), to: String((after && after.slug) || '') });
        }
    }
    return changes;
}

module.exports = {
    uniqueIntegrityStatus, ensureUniqueIndexes, listDuplicates, resolveDuplicate,
    engineOf, RULE_IDS, ruleById,
};
