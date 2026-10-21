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
    const escaped = String(term).toLowerCase().replace(/[!%_]/g, (c) => ESCAPE_CHAR + c);
    return `%${escaped}%`;
}

/** The SQL for "column contains ?" — pair it with containsPattern(term). */
function containsSql(column: string): string {
    return `LOWER(${column}) LIKE ? ESCAPE '${ESCAPE_CHAR}'`;
}

module.exports = { containsPattern, containsSql };
