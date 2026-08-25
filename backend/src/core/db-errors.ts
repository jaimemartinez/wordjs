/**
 * Driver-error predicates, in one place.
 *
 * WHY THIS FILE EXISTS: there were two `isUniqueViolation()` helpers — one in `core/revisions.ts`,
 * one in `models/User.ts` — and they did not agree. The revisions copy recognised MySQL
 * (`ER_DUP_ENTRY` / errno 1062 / "Duplicate entry"); the User copy recognised only SQLite and
 * Postgres, and its own doc comment enumerated exactly those two. On MySQL that meant registering a
 * username that already existed, or moving an account to an email already in use, fell past the
 * catch that turns a unique-index collision into "Username or email already exists" and surfaced as
 * a raw driver 500 instead.
 *
 * Two copies of a predicate is not a duplication problem, it is a divergence problem: the copy that
 * gets a new driver added is whichever one someone happened to be reading. One predicate, three
 * drivers, one place to add the fourth.
 */

/**
 * True for a unique-constraint violation on any supported driver (SQLite / PostgreSQL / MySQL).
 *
 * Deliberately NOT the generic `SQLITE_CONSTRAINT`: a NOT NULL or CHECK failure is not a collision,
 * and callers use this to decide whether retrying with a fresh name (or reporting "already exists")
 * is the right answer. For those, a swallowed NOT NULL failure would be a silent data bug.
 */
export function isUniqueViolation(err: any): boolean {
    if (!err) return false;

    const code = String(err.code ?? '');

    // SQLite (better-sqlite3 / sql.js) — the two extended codes that mean "a uniqueness guarantee
    // was violated", never the umbrella SQLITE_CONSTRAINT.
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;

    // PostgreSQL (pg) — SQLSTATE 23505 unique_violation.
    if (code === '23505') return true;

    // MySQL / MariaDB (mysql2) — ER_DUP_ENTRY, whose numeric errno is 1062. Both are checked
    // because mysql2 surfaces the string code but some wrappers pass only errno through.
    if (code === 'ER_DUP_ENTRY' || err.errno === 1062) return true;

    // Last resort: the driver's own words, for wrappers that lose the code entirely.
    const msg = String(err.message ?? '');
    return /UNIQUE constraint|duplicate key|Duplicate entry/i.test(msg);
}
