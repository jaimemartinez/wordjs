/**
 * WordJS — REQUEST PARAMETER RULES
 *
 * Two rules, one per half of the request line. The scalar QUERY rule (originally the whole of this
 * module) is stated first; the ROUTE-ID contract is at the bottom. They live together because they are
 * the same kind of statement — "this parameter has a shape, and a request that does not carry that
 * shape is refused before anything reads its value" — and because keeping them in one module is what
 * stops a third parameter rule from being invented a fourth time.
 *
 * ─── THE SCALAR QUERY PARAMETER RULE ─────────────────────────────────────────────────────────────
 *
 * A URL query is not a `Record<string, string>`. Express parses it with `qs`, so `?force=true` is the
 * string `'true'` but `?force=true&force=true` is `['true','true']`, and `?force[x]=true` is
 * `{ x: 'true' }`. Every guard in this codebase that decides something on a query value compares it
 * to a STRING — `=== 'true'`, `=== 'any'`, `.toLowerCase()` — and none of those answers anything
 * useful for an Array:
 *
 *   ['true','true'] === 'true'          → false  (the guard silently takes the other branch)
 *   ['asc','desc'].toLowerCase()        → TypeError (a 500 any caller can trigger)
 *   parseInt(String(['1','2']), 10)     → 1      (the comma stops the parse; page 2 vanishes)
 *
 * On `DELETE /posts/:id?force=true&force=true` that first line was the difference between a PERMANENT
 * DELETE and a trash — answered with a 200 that said the request had succeeded.
 *
 * ─── THE DECISION ────────────────────────────────────────────────────────────────────────────────
 * A query parameter this API declares as a scalar must arrive EXACTLY ONCE, as a string, or the
 * request is refused with 400 `rest_invalid_param`. The value is NOT resolved to the first or the
 * last of the repeats.
 *
 * Why refuse rather than pick one:
 *
 *  1. THE REPO ALREADY REFUSES. `routes/posts.ts` checks LIST_QUERY_STRING_FIELDS with
 *     firstNonStringField() and answers `invalidParamType()`, so `GET /posts?page=1&page=2` has been
 *     a 400 since that guard shipped. Resolving the value at the other sites would mean one polluted
 *     URL answers 400 on `GET /posts` and 200 on `GET /forms/submissions` — a rule that differs per
 *     call site is the one outcome that is definitely wrong.
 *  2. THERE IS NO VALUE THE CALLER MEANS. Two values are two intents; picking one is a guess, and the
 *     guess is an HTTP-parameter-pollution primitive. "Last wins" hands the decision to whoever can
 *     APPEND to a URL (a link in an email, an open redirect, a proxy or CDN that re-adds a parameter);
 *     "first wins" hands it to whoever can prepend. On `force` either guess can be steered into a
 *     permanent delete. Refusing is the only rule under which a polluted request never decides a
 *     destructive branch — and it costs an honest caller nothing, because an honest caller never
 *     sends the same scalar twice.
 *  3. IT IS WHAT WORDPRESS ANSWERS for the shape Express hands us: a scalar-typed parameter that
 *     arrives as an array is `rest_invalid_param`, 400.
 *
 * The refusal is thrown, not returned, so a call site stays a single expression; middleware/
 * errorHandler renders `status`/`code`/`invalidParams` into the SAME body routes/posts.ts builds by
 * hand, byte for byte. Every route here is wrapped in asyncHandler, which is what routes the throw
 * to that handler.
 *
 * WHAT THIS IS NOT: it is not a rule about VALUES. `?force=banana` is still simply "not true", and
 * `?page=abc` still falls through to the default. Only the SHAPE is refused.
 */

import type { ParsedQs } from 'qs';

/** Exactly what Express can hand a route for one query key. Nothing here is guaranteed to be a string. */
export type QueryValue = string | string[] | ParsedQs | ParsedQs[] | undefined;

/**
 * A scalar query parameter that did not arrive as one string.
 *
 * `status` and `code` are read by middleware/errorHandler's default branch; `invalidParams` is
 * rendered into `data.params` so this failure is indistinguishable from the one routes/posts.ts
 * writes inline for the same mistake.
 */
export class InvalidQueryParamError extends Error {
    readonly status = 400;
    readonly code = 'rest_invalid_param';
    readonly invalidParams: Record<string, string>;

    constructor(field: string) {
        super(`Invalid parameter '${field}': expected a string.`);
        this.name = 'InvalidQueryParamError';
        this.invalidParams = { [field]: 'Expected a string.' };
    }
}

/**
 * The single string the caller means for `field`, or `undefined` when they sent none.
 *
 * `null` and `undefined` both count as ABSENT rather than as a violation: the routes distinguish
 * "not supplied" from "supplied empty", and every caller here already has a default for absent.
 * Anything else — an Array from a repeated key, an object from a bracketed one — throws.
 */
export function scalarQueryParam(value: QueryValue, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    throw new InvalidQueryParamError(field);
}

/**
 * The same rule applied to a whole handler's declared scalar parameters, up front, before any of them
 * has been read — the plural form of scalarQueryParam and not a second rule.
 *
 * Use this where a handler reads several parameters (a list route); use scalarQueryParam directly
 * where it reads one. Declaring the field list as a frozen table next to the handler is deliberate:
 * a parameter added to the handler and not to the table is visible in the diff, which is how
 * routes/posts.ts's LIST_QUERY_STRING_FIELDS is kept honest.
 */
export function requireScalarQuery(query: unknown, fields: readonly string[]): void {
    if (!query || typeof query !== 'object') return;
    const record = query as Record<string, unknown>;
    for (const field of fields) scalarQueryParam(record[field] as QueryValue, field);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ROUTE-ID CONTRACT
 *
 * A route segment this API documents as `schema: { type: integer }` is parsed with `parseInt()` and
 * handed to a model, which binds it into `WHERE <int column> = ?`. Every one of those routes then
 * checks `if (!term)` / `if (!comment)` / `if (!menu)` — but that check runs AFTER the lookup, so
 * whatever `parseInt` produced has already reached the driver. `parseInt('abc', 10)` is NaN, and what
 * the caller gets for `GET /categories/abc` therefore depends on the ENGINE, not on the code:
 *
 *   SQLite    binds NaN as NULL   → no row → a correct 404, which is why the SQLite suite was green;
 *   Postgres  refuses the bind    → 22P02 `invalid input syntax for type integer: "NaN"` → 500;
 *   MySQL     splices it in bare  → `Unknown column 'NaN' in 'where clause'` → 500.
 *
 * Anonymous callers reach several of these (`GET /comments/abc`, `/categories/abc`, `/tags/abc`,
 * `/menus/abc`), so a typo in a URL was a 500 with a driver error in it. The same sentence is true one
 * notch along for a value that IS a number but cannot be an id: `GET /categories/9999999999` is
 * `value "9999999999" is out of range for type integer` on Postgres — same sink, same 500, so the
 * contract below states the whole shape rather than only the NaN half of it.
 *
 * ─── THE DECISION ────────────────────────────────────────────────────────────────────────────────
 * A route parameter that denotes a row id must be a base-10 positive integer the id columns can hold,
 * or the request is answered 404 with the SAME body that router already returns for an id that does
 * not exist. Not 400: an id that cannot denote a row and an id that denotes no row mean exactly one
 * thing to the caller — "no such resource" — and `GET /posts/999999` has always answered 404. Two
 * different answers for one meaning is the outcome that is definitely wrong, and it is also a
 * disclosure primitive: a 400/404 split tells an unauthenticated prober which ids are well-formed.
 *
 * Enforced with `router.param()`, ONCE per router, rather than at each of the twenty-one call sites:
 *   • express runs it for every route in that router that names the parameter, INCLUDING routes added
 *     later — which is exactly how this class survived the previous round, where the guard was written
 *     at the one site somebody was looking at and its twins kept the defect;
 *   • it runs before the route's own handlers, so no handler can forget it or reach the model first.
 *
 * It therefore also answers before the route's auth middleware, which is the order WordPress uses:
 * `(?P<id>[\d]+)` fails to match the route and the request is `rest_no_route` 404 before any
 * `permission_callback` runs. That discloses nothing — an id that is not an id denotes no resource,
 * so the answer cannot depend on whether one exists.
 *
 * WHAT THIS CHANGES BEYOND THE 500s: `parseInt` is lenient, so `/comments/12abc` used to be an alias
 * for `/comments/12`. Every id had a family of spellings — a cache key, a rate-limit bucket and an
 * audit-log entry per spelling. A route id is now the id or it is nothing.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * The largest value the id columns hold. Every id in this schema is a 32-bit signed integer
 * (`INTEGER PRIMARY KEY AUTOINCREMENT` / `SERIAL` / `INT AUTO_INCREMENT`), so a larger value cannot
 * name a row on any engine — Postgres says so with an error, SQLite and MySQL by matching nothing.
 * Ten digits is the widest a value in that range can be, which is also what keeps `Number()` exact.
 */
const MAX_ROUTE_ID = 2147483647;
const ROUTE_ID_SHAPE = /^[0-9]{1,10}$/;

/**
 * The "no such resource" answer a router already gives, in one of the two shapes the repo actually
 * uses. Passed in rather than invented here so a malformed id is answered byte for byte like an id
 * that simply does not exist, and no caller can tell the two apart.
 *
 *   • `{ code, message }` — the REST triple most routers send; `data.status` is filled in from the 404.
 *   • `{ body }`          — the exact JSON some routers send instead. `routes/seo.ts` answers
 *                           `{ error: 'Post not found' }` and `routes/revisions.ts` answers
 *                           `{ error: 'Revision not found' }`, neither of which carries a `code` at
 *                           all. Rendering the REST triple at those two would make a malformed id
 *                           DISTINGUISHABLE from an absent one — the precise thing this contract
 *                           exists to prevent — so the escape hatch is part of the contract rather
 *                           than a reason to write a second one.
 */
export type RouteIdNotFound =
    | { code: string; message: string }
    | { body: Record<string, unknown> };

/**
 * True when `value` is a spelling of a positive integer id this schema could hold.
 *
 * Exported so a route that must resolve the id itself (a literal-prefix route, say) can ask the same
 * question the router-level contract asks, instead of writing a second, subtly different predicate.
 */
export function isRouteId(value: unknown): value is string {
    if (typeof value !== 'string' || !ROUTE_ID_SHAPE.test(value)) return false;
    const n = Number(value);
    return n >= 1 && n <= MAX_ROUTE_ID;
}

/**
 * The id `value` denotes, or `null` when it denotes none — the SAME predicate as `isRouteId`, handed
 * back as the number the caller was going to parse anyway.
 *
 * THIS IS THE FORM THE LOCAL GUARDS TAKE. Several routers answer 400 rather than 404 for an id they
 * cannot use, and that status is an established part of their API, so they keep it; what they must not
 * keep is their own idea of what a route id IS. Every one of them had written the predicate by hand
 * and every one had written a DIFFERENT, weaker one:
 *
 *   routes/webhooks.ts  parseId          Number.isInteger(n) && n > 0    — no upper bound, no shape
 *   routes/collab.ts    parsePostId      Number.isFinite(n)  && n > 0    — also accepts 1.5
 *   routes/revisions.ts revisionIdOrNull !Number.isNaN(n)                — accepts 0, -1, 1e300
 *   routes/auth.ts      inline           Number.isInteger(n) && n > 0    — no upper bound, no shape
 *   routes/forms.ts     inline           Number.isInteger(n) && n > 0    — no upper bound, no shape
 *   routes/presence.ts  inline           Number.isFinite(n)  && n > 0    — no upper bound, no shape
 *
 * All six shared two holes, because all six were `parseInt` with a test bolted on afterwards.
 * `parseInt` STOPS at the first unusable character and returns what it has, so `parseInt('12abc', 10)`
 * is 12 and every guard above declared `12abc` a valid id for row 12 — an unbounded family of
 * spellings for one row, each its own cache key, rate-limit bucket and audit-log line. And none of
 * them bounded the value above, so `9999999999` — a perfectly ordinary integer that no 32-bit id
 * column can hold — passed every one of them and reached the driver, where Postgres answers
 * `22003 value out of range for type integer` and the caller gets a 500.
 *
 * Returning `number | null` (rather than exposing the boolean and letting each site re-parse) is what
 * makes the second hole unrepeatable: the value a caller uses is the value this function validated,
 * so there is no second parse to disagree with the check.
 */
export function routeIdOrNull(value: unknown): number | null {
    return isRouteId(value) ? Number(value) : null;
}

/**
 * An express `router.param()` handler enforcing the contract above for one parameter name.
 *
 * Register it once per router, next to the router's other declarations:
 *
 *     router.param('id', requireRouteId({ code: 'rest_term_invalid', message: 'Invalid category ID.' }));
 *
 * `notFound` is the router's OWN not-found body, passed in rather than invented here, so a malformed
 * id is answered byte for byte like an absent one and no caller can tell the two apart. A router whose
 * not-found body is not the REST triple passes it whole as `{ body }` — see RouteIdNotFound.
 */
export function requireRouteId(notFound: RouteIdNotFound) {
    const body = 'body' in notFound
        ? notFound.body
        : { code: notFound.code, message: notFound.message, data: { status: 404 } };
    return function routeIdContract(req: Request, res: Response, next: NextFunction, value: unknown): void {
        if (isRouteId(value)) return next();
        res.status(404).json(body);
    };
}
