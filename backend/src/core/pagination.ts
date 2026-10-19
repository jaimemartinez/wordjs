/**
 * WordJS — PAGINATION BOUNDS
 *
 * One rule for every `per_page` / `limit` / `page` / `offset` a list route or a model accepts: a page
 * size is an integer in [1, max], a page number is an integer >= 1 and an offset is an integer >= 0.
 *
 * Why it has to be stated once: each list route parsed `per_page` with
 * `Math.min(parseInt(...) || dflt, 100)` — an UPPER bound only. A negative value survived the parse
 * and reached `LIMIT ?`, and SQLite reads a negative LIMIT as "no limit at all", so the cap the route
 * meant to enforce disappeared for whoever typed a minus sign. Every site had written the same half
 * of the check, which is exactly the shape a shared helper exists to stop.
 *
 * The models clamp too (`clampLimit` / `clampOffset`), so a caller that reaches `findAll` without a
 * route in front of it — a plugin, the GraphQL layer, a CLI — gets the same floor.
 */

/** Parse an integer the way the routes always have (base 10; `0`, NaN or junk → the fallback). */
function parseIntOr(raw: unknown, fallback: number): number {
    const n = typeof raw === 'number' ? Math.trunc(raw) : parseInt(String(raw), 10);
    return Number.isFinite(n) && n !== 0 ? n : fallback;
}

/** A page size from a query value: the fallback when absent/zero/junk, then clamped to [1, max]. */
export function perPageParam(raw: unknown, fallback: number, max = 100): number {
    return Math.min(Math.max(parseIntOr(raw, fallback), 1), max);
}

/** A 1-based page number from a query value (>= 1). */
export function pageParam(raw: unknown): number {
    return Math.max(parseIntOr(raw, 1), 1);
}

/** The row offset for `page` at `perPage` rows a page. */
export function pageOffset(rawPage: unknown, perPage: number): number {
    return (pageParam(rawPage) - 1) * perPage;
}

/** A row offset from a query value (>= 0). */
export function offsetParam(raw: unknown): number {
    return Math.max(parseIntOr(raw, 0), 0);
}

/**
 * Model-side floor for a LIMIT: a finite integer >= 1 (`fallback` when the value is not a number).
 * `max` is optional — models do not impose the routes' page-size policy, only the "never unbounded"
 * invariant.
 */
export function clampLimit(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const n = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), max);
}

/** Model-side floor for an OFFSET: a finite integer >= 0. */
export function clampOffset(value: unknown): number {
    const n = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
}
