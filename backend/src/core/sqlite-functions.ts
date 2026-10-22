/**
 * SQL functions WordJS adds to every SQLite connection it opens (better-sqlite3 and sql.js).
 *
 * `wjs_fold(text)` — lower-case with the full Unicode rules and without diacritics (NFD, combining
 * marks removed): "MURCIÉLAGO" → "murcielago". SQLite's own LOWER() and LIKE fold ASCII only, so on
 * the LIKE search path (sqlite-legacy has no FTS5) "murciélago" did not find "MURCIÉLAGO" and "arbol"
 * did not find "árbol", while MySQL's collation and SQLite's FTS5 (unicode61) find both. Used only by
 * core/sql-like on SQLite — never in an index expression, so a connection that lacks it can never
 * disagree with a stored index.
 */
function fold(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Register the functions on a better-sqlite3 handle (`db.function`) or a sql.js one (`create_function`). */
function registerSqliteFunctions(handle: any): void {
    if (!handle) return;
    try {
        if (typeof handle.function === 'function') handle.function('wjs_fold', { deterministic: true }, fold);
        else if (typeof handle.create_function === 'function') handle.create_function('wjs_fold', fold);
    } catch { /* a handle without user functions keeps the plain LIKE */ }
}

module.exports = { registerSqliteFunctions, fold };
