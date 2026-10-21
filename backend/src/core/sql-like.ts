/**
 * A substring search with LIKE that means the same on every engine.
 *
 * Two differences made the same search box answer differently per database:
 *   • the wildcards: a search for `%` or `_` matched EVERY row on MySQL and sqlite-legacy, because the
 *     term went into the pattern unescaped;
 *   • case: SQLite and MySQL (its `_ci` collations) compare LIKE case-insensitively, Postgres does not,
 *     so "jos" found "José" everywhere except on Postgres.
 * The term's `%`, `_` and the escape character itself are escaped, and both sides are lower-cased.
 * `!` is the escape character because it needs no escaping inside a string literal on any engine
 * (a backslash does on MySQL).
 */
const ESCAPE_CHAR = '!';

/** `%term%` with the term's own LIKE wildcards made literal. */
function containsPattern(term: string): string {
    // Lower-cased here; on SQLite the SQL folds accents on both sides too (wjs_fold), elsewhere the
    // term keeps them, so `árbol` still finds `árbol` on Postgres.
    const escaped = String(term).toLowerCase().replace(/[!%_]/g, (c) => ESCAPE_CHAR + c);
    return `%${escaped}%`;
}

/** Does the site run on sqlite-native, whose connections carry `wjs_fold` (core/sqlite-functions)? */
function onNativeSqlite(): boolean {
    try { return String(require('../config/database').getDbType().driver || '') === 'sqlite-native'; } catch { return false; }
}

/**
 * The SQL for "column contains ?" — pair it with containsPattern(term). On sqlite-native both sides
 * go through `wjs_fold` (Unicode lower-case without accents, core/sqlite-functions), because SQLite's
 * LOWER()/LIKE fold ASCII only; MySQL's collation already ignores case and accents. sqlite-legacy
 * (sql.js) keeps LOWER(): its user functions are not reliable across the handles it re-creates, and it
 * is the fallback engine the panel offers to move off in one step.
 */
function containsSql(column: string, engine?: string): string {
    if (engine ? engine === 'sqlite-native' : onNativeSqlite()) return `wjs_fold(${column}) LIKE wjs_fold(?) ESCAPE '${ESCAPE_CHAR}'`;
    return `LOWER(${column}) LIKE ? ESCAPE '${ESCAPE_CHAR}'`;
}

module.exports = { containsPattern, containsSql };
