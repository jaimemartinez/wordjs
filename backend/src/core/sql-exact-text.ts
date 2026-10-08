/**
 * WordJS - Exact text comparison in SQL, on every engine
 *
 * THE PROBLEM. A decision made in JavaScript compares strings exactly (`type === 'attachment'`,
 * `capsForType(name)`, `isInternalPostType(name)`); the query that runs next compares them under the
 * column's COLLATION. SQLite (BINARY) and PostgreSQL (deterministic collations) compare byte for byte, so
 * the two agree there. MySQL/MariaDB compare `posts.post_type` under utf8mb4_unicode_ci — case- and
 * accent-insensitive, and under PAD SPACE blind to trailing spaces — so `post_type = 'ATTACHMENT'` or
 * `post_type = 'attachment '` selects the `attachment` rows. A route that chose its authorization by the
 * exact name and then selected rows by the folded one authorized one type and listed another: an editor
 * listed every hidden attachment with `GET /posts?type=ATTACHMENT&status=inherit` (the attachment rule is
 * applied only when the type IS `attachment`), an anonymous caller listed the published entries of a
 * `public: false` type with `?type=ADV_LEDGER` (no registered type → the public `post` policy), and the
 * menu items with `?type=NAV_MENU_ITEM` (not an internal name → not refused).
 *
 * THE FORMS, one per engine family, all with the semantics "the stored bytes ARE these bytes":
 *   - MySQL/MariaDB: `col = ? AND CAST(col AS BINARY) = ?`. The first term keeps the index on the column
 *     usable (it can only narrow to a superset of the exact match); the second is the exact test — a
 *     binary string compares byte for byte, with no case folding and no padding.
 *   - SQLite: `col COLLATE BINARY = ?`. Already the column's own collation, so it changes nothing on a
 *     stock schema and the index stays usable; it makes the comparison exact even where a column was
 *     declared with a folding collation (NOCASE/RTRIM) — which is also how the tests model MySQL.
 *   - PostgreSQL: `col = ?`. The default collations are deterministic (equal only when byte-wise equal),
 *     and a `COLLATE` clause there would stop the planner from using the column's index.
 *
 * Callers pass the column EXPRESSION, never caller-supplied text: it is interpolated into the SQL.
 */

type ExactDialect = 'mysql' | 'postgres' | 'sqlite';

interface SqlFragment { sql: string; params: any[] }

/**
 * config/database, resolved ONCE per process. This module sits on the post query path (Post.buildWhere,
 * Post.findBySlug, the attachment rule), and a `require()` per call is not free: each one resolves the
 * path again (tens of microseconds under ts-node), which took Post.buildWhere from about 1 µs to about
 * 50 µs per call and pushed the F6 `contentQuery` ratio over its budget.
 *   - The MODULE is cached, not its `getDbType` nor the answer: the engine can change in-process (setup
 *     switches driver, the engine test blocks run SQLite then MySQL), and a test that replaces
 *     `database.getDbType` must still be obeyed.
 *   - It is cached only once it is COMPLETE. Required while config/database is itself still loading (a
 *     circular require), the object is the partial `exports` that its `module.exports = {…}` later
 *     replaces — caching that object would answer 'sqlite' on every engine for the life of the process.
 */
let databaseModule: any = null;
function loadDatabaseModule(): any {
    if (databaseModule) return databaseModule;
    const mod = require('../config/database');
    if (mod && typeof mod.getDbType === 'function') databaseModule = mod;
    return mod;
}

/** The engine family of the configured driver. */
function currentDialect(): ExactDialect {
    try {
        const database = loadDatabaseModule();
        const type = database && typeof database.getDbType === 'function' ? database.getDbType() : null;
        if (type && type.isMySQL) return 'mysql';
        if (type && type.isPostgres) return 'postgres';
    } catch { /* database module unavailable: the SQLite form is exact on its default collation */ }
    return 'sqlite';
}

/**
 * `expr` written so that comparing it with a parameter is EXACT on `dialect` (default: the configured
 * engine). For conditions that cannot take the two-term form (NOT IN, a derived condition).
 */
function exactTextExpr(expr: string, dialect: ExactDialect = currentDialect()): string {
    if (dialect === 'mysql') return `CAST(${expr} AS BINARY)`;
    if (dialect === 'sqlite') return `${expr} COLLATE BINARY`;
    return expr;
}

/**
 * `expr` equals `value` exactly — or, with an array, equals one of `values` exactly. An empty array
 * matches nothing. On MySQL the folded comparison is kept in front so an index on `expr` is still used.
 */
function exactTextEquals(expr: string, value: string | string[], dialect: ExactDialect = currentDialect()): SqlFragment {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return { sql: '1 = 0', params: [] };
    const exact = exactTextExpr(expr, dialect);
    const one = values.length === 1;
    const rhs = one ? '= ?' : `IN (${values.map(() => '?').join(', ')})`;
    if (dialect === 'mysql') {
        return { sql: `(${expr} ${rhs} AND ${exact} ${rhs})`, params: [...values, ...values] };
    }
    return { sql: `${exact} ${rhs}`, params: [...values] };
}

module.exports = { exactTextExpr, exactTextEquals, currentDialect };
