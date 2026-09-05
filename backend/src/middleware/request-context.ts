/**
 * WordJS — request correlation and the access log.
 *
 * THE FIRST MIDDLEWARE ON THE APP, before helmet. Not a style choice: the id it mints is what every
 * later line — a helmet rejection, a CORS denial, a rate-limit 429, a handler's own log, a 500 from
 * the error handler — is correlated by. Mounted anywhere later, the lines produced BEFORE it carry no
 * id, and "show me everything that request did" stops being answerable exactly for the requests an
 * operator most wants to trace.
 *
 * WHY AN INCOMING X-Request-Id IS NOT TRUSTED BLINDLY — TWO SEPARATE QUESTIONS, BOTH ANSWERED HERE.
 *
 * 1. THE BYTES. It is a client-controlled header. Echoing it unvalidated puts arbitrary bytes —
 *    newlines, ANSI escapes, megabytes — into a JSON field and into a response header, which is log
 *    injection with extra steps. So: honoured only when it matches `^[A-Za-z0-9._-]{8,128}$` (what
 *    nginx's $request_id, a UUID, a ULID and a W3C trace id all satisfy), otherwise a fresh UUID.
 *
 * 2. THE PROVENANCE, which validating the bytes does NOT answer. A well-formed id from a direct
 *    client is still an id the CLIENT chose. On an instance with no trusted proxy in front (the
 *    default — `trust proxy` unset in the monolith), honouring it lets an attacker stamp every request
 *    of a campaign with one id so it collapses into a single "trace", splice lines into an incident an
 *    operator is actively following, or adopt an id a legitimate session is emitting so the attack is
 *    attributed to that user. The response header echoes the value back, so a forger can confirm the
 *    graft landed. So the header is honoured ONLY when a proxy is genuinely trusted — the same
 *    `trustProxyConfigured()` decision `core/client-ip` uses to decide whether X-Forwarded-For may be
 *    believed, because it is the same question about the same class of header.
 *
 * A reverse proxy that sets `trust proxy` therefore keeps end-to-end correlation; a directly exposed
 * instance mints its own id and correlation simply starts at the app.
 *
 * This module is imported by index.ts only. It must NEVER be reachable from plugin-worker.js: the
 * isolate's IPC frames are not Express requests, and an AsyncLocalStorage on that path would attach
 * request identity to work that has none.
 */

import type { Request, Response, NextFunction } from 'express';

const { randomUUID } = require('crypto');
const { logger, runWithRequestContext } = require('../core/logger');
const { clientIp, trustProxyConfigured } = require('../core/client-ip');
const config = require('../config/app');

/** An id we are willing to echo. Deliberately narrow — see the header note above. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Ceiling on the `path` field. `req.originalUrl` minus its query is still attacker-controlled and can
 * be ~16KB (Node's default max header size covers the request line), and the root 404 surface sits
 * ABOVE the API limiter — so an unauthenticated client could otherwise bill an operator ~100x a normal
 * line, per request, in the paid aggregator this whole module exists to feed. `core/metrics.ts` caps
 * its route label at the same 200; two halves of one change disagreeing about whether request-derived
 * strings need a bound is how one of them ends up unbounded.
 */
const MAX_PATH_LENGTH = 200;

const HEADER = 'X-Request-Id';

/** The access line is on by default; `logging.accessLog: false` turns it off without silencing the app. */
function accessLogEnabled(): boolean {
    return !(config.logging && config.logging.accessLog === false);
}

/** The user's numeric id when the request is authenticated, else undefined. Never the whole user object. */
function userIdOf(req: Request): number | undefined {
    const user = req.user;
    if (!user) return undefined;
    const id = Number(user.id !== undefined ? user.id : user.ID);
    return Number.isFinite(id) && id > 0 ? id : undefined;
}

/**
 * The path without its query string — the query is unbounded and routinely carries tokens — and
 * capped at MAX_PATH_LENGTH, because the path is unbounded too. Returns the flag separately so the
 * line can say it truncated instead of quietly presenting a prefix as the whole path.
 */
function pathOf(req: Request): { path: string; truncated: boolean } {
    const raw = String(req.originalUrl || req.url || '');
    const cut = raw.indexOf('?');
    const withoutQuery = cut === -1 ? raw : raw.slice(0, cut);
    return withoutQuery.length > MAX_PATH_LENGTH
        ? { path: withoutQuery.slice(0, MAX_PATH_LENGTH), truncated: true }
        : { path: withoutQuery, truncated: false };
}

/** 5xx is an error, 4xx a warning, everything else information. */
function levelForStatus(status: number): string {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'info';
}

function requestContext(req: Request, res: Response, next: NextFunction): void {
    const incoming = String(req.get('x-request-id') || '').trim();
    // Grammar AND provenance — see note 2 in the header. `trustProxyConfigured()` is evaluated per
    // request rather than cached at module load so a test (and a config reload) can flip the posture.
    const requestId = trustProxyConfigured() && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const startedAt = Date.now();

    res.setHeader(HEADER, requestId);

    const requestLogger = logger.child({ requestId });

    // Bound in the CLOSURE, not read back out of the ALS. `finish` fires after the handler has
    // returned, and an async context that has already unwound would give this listener the ROOT
    // logger — the access line, of all lines, must never be the one missing its id.
    //
    // ON BOTH `finish` AND `close`, once. `finish` does NOT fire when the socket dies before the
    // handler responds, so hooking it alone means a hung endpoint, a client timeout, an upstream
    // read-timeout and every aborted upload produce no access line at all — the signal disappears
    // exactly when an operator needs it, and "grep the request id you were handed" returns nothing.
    // `finish` always precedes `close` on a completed response, so the guard makes the second a no-op
    // and the `aborted` flag comes from WHICH event won rather than from a writable-state getter that
    // is not settled at `finish` time.
    let logged = false;
    const emit = (aborted: boolean): void => {
        if (logged) return;
        logged = true;
        if (!accessLogEnabled()) return;
        const status = res.statusCode;
        const userId = userIdOf(req);
        const { path, truncated } = pathOf(req);
        let ip = '';
        try {
            ip = clientIp(req);
        } catch {
            /* trust-proxy resolution can throw on a malformed forwarded chain; the line is still worth having */
        }
        // `requestId` is NOT repeated here: the child logger already binds it, and pino writes bound
        // fields and per-call fields into the same object — naming it twice emitted a JSON object with
        // a duplicate key, which every parser resolves differently (last-wins, first-wins, or reject).
        // An abort is logged at `warn` whatever `res.statusCode` happens to say: nothing was sent, so
        // the default 200 on an aborted response is not an outcome anyone should read as success.
        requestLogger[aborted ? 'warn' : levelForStatus(status)]({
            method: req.method,
            path,
            status,
            durationMs: Date.now() - startedAt,
            ...(truncated ? { pathTruncated: true } : {}),
            ...(aborted ? { aborted: true } : {}),
            ...(ip ? { ip } : {}),
            ...(userId !== undefined ? { userId } : {}),
        }, 'request');
    };
    res.on('finish', () => emit(false));
    res.on('close', () => emit(true));

    runWithRequestContext({ requestId, startedAt, logger: requestLogger }, () => next());
}

module.exports = {
    requestContext,
    // Exported for its test: the accept/reject decision for an incoming id is the security-relevant
    // half of this file, and a test that drives it through a live server can only observe the header.
    isAcceptableRequestId: (value: string): boolean => REQUEST_ID_PATTERN.test(String(value)),
    REQUEST_ID_HEADER: HEADER,
};
