/**
 * WordJS - Error Handler Middleware
 */
import type { Request, Response, NextFunction } from 'express';

const crypto = require('crypto');

/**
 * Not found handler
 */
function notFound(req: Request, res: Response, next: NextFunction) {
    res.status(404).json({
        code: 'rest_no_route',
        message: `No route was found matching the URL and request method: ${req.method} ${req.path}`,
        data: { status: 404 }
    });
}

/**
 * ── WHAT AN ERROR IS ALLOWED TO TELL THE CALLER ─────────────────────────────────────────────────
 *
 * This handler used to render `err.code` and `err.message` for EVERY error it was handed. For the
 * errors this codebase raises on purpose that is correct — those bodies are the API contract, and
 * clients read them. For an error that merely ESCAPED, it is disclosure: the `code` and `message` of
 * an unhandled failure belong to whatever threw it, which in a CMS is almost always the database
 * driver. Probed against a real PostgreSQL, an ANONYMOUS request whose `:id` parsed to NaN answered:
 *
 *     500 {"code":"22P02","message":"invalid input syntax for type integer: \"NaN\"","data":{"status":500}}
 *
 * — a raw SQLSTATE published as this API's own error code, and the engine's wording handed to
 * whoever asked. The same request against MySQL answers `Unknown column 'NaN' in 'where clause'`,
 * which additionally confirms the shape of the query being run.
 *
 * ─── THE LINE, AND WHY THE CODE CAN DRAW IT ─────────────────────────────────────────────────────
 * An error raised deliberately for a client carries the HTTP `status` its thrower chose. That is not
 * a convention invented here to make this fix work — it is the marker the repo ALREADY uses at every
 * site that raises one:
 *
 *   • core/query-params' InvalidQueryParamError   → `status = 400` (the `rest_invalid_param` body)
 *   • core/plugin-origins' origin refusals        → `status = 409 / 400`, alongside a designed `body`
 *   • routes/plugins' slug guard                  → `status = 400`
 *   • core/port-conflicts' port refusals          → `status = 409 / 502` (see the note there)
 *
 * A driver error carries `code`, `errno`, `sqlState`, `severity`, `routine` — and never `status`,
 * because nobody chose one for it. So `typeof err.status === 'number'` answers exactly the question
 * "did our own code mean for a client to read this?", with no list of error classes to keep in sync
 * and no guesswork. When the answer is no, the 500 is one THIS handler invented, and so is the body.
 *
 * ─── DELIBERATELY NOT AN ENVIRONMENT GUARD ──────────────────────────────────────────────────────
 * Keying the decision on NODE_ENV would leave the disclosure live in every deployment that forgets
 * to set it, and — worse — would make the guard INERT under the test runner and under `npm run dev`,
 * which is precisely where it has to be provable. The rule is identical in every environment.
 *
 * Nothing is lost server-side: the full error is still logged, verbatim, together with an `errorId`
 * that is echoed in the response, so a caller's bug report still leads an operator to the exact
 * failure without the caller having been told anything about it.
 */
function isIntentionalApiError(err: any): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as any).status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * The message a FALLBACK catch-all may put in front of a caller.
 *
 * Exported because the global handler is not the only surface: routes/certs, routes/health,
 * routes/notifications, routes/marketplace, routes/plugins and routes/setup each answer a 5xx from
 * their own `catch` with `e.message`, which is the same disclosure through a different door. They
 * call this so the decision is made ONCE — a per-surface copy of the rule is how this class survived
 * the last round. A deliberate error keeps its own words; anything else gets `fallback`, and its real
 * text stays in the log the call site writes.
 */
function publicErrorText(err: any, fallback: string): string {
    if (!isIntentionalApiError(err)) return fallback;
    const message = err && typeof err.message === 'string' ? err.message.trim() : '';
    return message || fallback;
}

/**
 * Global error handler
 */
function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    // One id, logged next to the FULL error and echoed in the body of an unexpected failure.
    const errorId = crypto.randomUUID();
    console.error('Error [%s]:', errorId, err);

    // Handle specific error types. Both are recognised BY NAME and given a status here, which is the
    // same act of recognition `status` records — so their messages are contract, not disclosure.
    if (err && err.name === 'ValidationError') {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: err.message,
            data: { status: 400 }
        });
    }

    if (err && err.name === 'UnauthorizedError') {
        return res.status(401).json({
            code: 'rest_unauthorized',
            message: err.message || 'Unauthorized',
            data: { status: 401 }
        });
    }

    // Nobody chose a status for this error, so nobody designed a body for it either. The 500 is ours
    // and so are the words; `errorId` ties this response to the log line written above.
    if (!isIntentionalApiError(err)) {
        return res.status(500).json({
            code: 'rest_internal_error',
            message: 'The server encountered an internal error.',
            data: { status: 500, errorId }
        });
    }

    // Deliberate error: render the contract its thrower wrote.
    const status = (err as any).status;
    const body: any = {
        code: err.code || 'rest_error',
        message: err.message || 'An error occurred',
        data: { status }
    };
    // Pass through a structured `details` payload (e.g. a plugin validation reject's
    // missingPermissions/dangerousCalls split) so callers get more than a flattened string.
    if (err.details !== undefined) body.details = err.details;
    // Same idea for a per-parameter breakdown (core/query-params' InvalidQueryParamError). Without it
    // the SAME refusal would render with two different bodies depending on whether the route threw it
    // or wrote it inline — routes/posts.ts's invalidParamType() puts the breakdown in `data.params`,
    // so a thrown one has to land there too, or "one rule" stops being observable to a client.
    if (err.invalidParams !== undefined) body.data.params = err.invalidParams;
    res.status(status).json(body);
}

/**
 * Async handler wrapper
 */
function asyncHandler(fn: any) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * ── WORK THAT ESCAPES ITS HANDLER ───────────────────────────────────────────────────────────────
 *
 * `asyncHandler` above is the whole safety net, and all it can see is a rejection of the promise the
 * handler RETURNED. The moment a handler hands work to something that calls back on a LATER TICK —
 * a node-style callback (`fs.readdir`, `res.download`), a `.then` reaction, a listener on
 * `req`/`res`/an emitter — that work runs on an EMPTY stack. `Promise.resolve(fn(...))` has long
 * since settled, so a throw in there is not a 500: it is an `uncaughtException`, and a rejection of
 * a promise nobody kept is an `unhandledRejection`. `src/index.ts` answers both with
 * `process.exit(1)`, and the request that started it is never answered at all.
 *
 * That is not a theoretical gap — it is why `routes/fonts.ts` could be taken down by an anonymous
 * GET, and it repeats at every site that starts off-stack work: `routes/themes.ts`'s download
 * cleanup, `routes/hooks.ts`'s SSE listener, `routes/collab.ts`'s disconnect handlers,
 * `middleware/image-negotiation.ts`'s transcode reaction.
 *
 * `offStack` is the seam for all of them. Wrap the BODY of such a callback and a throw — or the
 * rejection of a promise the body returns, which is the same failure wearing the other hat — lands
 * where the request's own error path already is:
 *
 *   · headers not sent yet          → `next(err)`: the same 500 the handler itself would have made;
 *   · headers already sent, or no
 *     `next` to hand it to (SSE, a
 *     finished download)            → there is no status left to send, so the failure is LOGGED and
 *                                     goes no further. Containment is deliberate: dropping one SSE
 *                                     frame is the correct cost of an unserializable payload, and
 *                                     closing the subscriber's stream — or the process — is not.
 *
 * Pass `next` whenever the call site has one. Passing `null` says "this response is already
 * committed", not "swallow it": the log line is written either way.
 */
function offStack(res: Response, next: NextFunction | null, fn: () => unknown): void {
    const fail = (err: any) => {
        if (next && !res.headersSent) return next(err);
        console.error('Error after the response was committed:', err);
    };
    try {
        const settled = fn();
        // A body that returns a promise is the SAME defect with a different name: `void doThing()`
        // discards the rejection instead of the throw. Keep it here rather than at the call sites.
        if (settled && typeof (settled as any).then === 'function') {
            (settled as Promise<unknown>).then(undefined, fail);
        }
    } catch (err) {
        fail(err);
    }
}

module.exports = {
    notFound,
    errorHandler,
    asyncHandler,
    offStack,
    isIntentionalApiError,
    publicErrorText
};
