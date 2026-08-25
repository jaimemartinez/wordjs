/**
 * WordJS - Authentication Middleware
 * JWT-based authentication
 */

import type { Request, Response, NextFunction, CookieOptions } from 'express';

/**
 * The marks this file stamps on the request — `user`, `apiToken`, `isHeadless` — are declared ONCE, in
 * src/types/globals.d.ts, so the handlers below take a plain `Request`. They used to be named again
 * here, and again in routes/webhooks.ts, and again (as `unknown`) in routes/collab.ts: one runtime
 * field, three parallel declarations that TypeScript never compares, because each is a fresh
 * intersection over Request rather than a redeclaration of one property.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/app');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const mfa = require('../core/mfa');

// Normalize the API prefix once (e.g. '/api/v1', no trailing slash) for resource extraction below.
const API_PREFIX = String(config.api?.prefix || '/api/v1').replace(/\/+$/, '');

/**
 * The "resource" a request targets, for per-resource API-token scope checks: the first path segment after
 * the API prefix. `/api/v1/posts/5` → 'posts', `/api/v1/media` → 'media'. Derived from req.originalUrl (the
 * full, un-rewritten URL, reliable regardless of how deeply the router is mounted). Returns '' when the
 * first segment isn't a clean lowercase slug — scopeAllows then treats it as unclassifiable and only global
 * scopes satisfy it (fail-closed for resource-scoped tokens). Only a clean `slug` immediately followed by
 * '/' or end matches, so `..`/encoded-path oddities never masquerade as a real resource.
 */
/**
 * The request path as EXPRESS SEES IT, lowercased, query stripped, repeated separators collapsed.
 *
 * The collapse is the load-bearing part. Express mounts this middleware with the regexp
 * `/^\/api\/v1\/?(?=\/|$)/i`, whose optional slash swallows a redundant separator: `POST /api/v1//setup/install`
 * is ROUTED to `/setup/install` (verified against the real router), while a naive `slice(prefix.length)`
 * derives `'//setup/install'` — so every guard built on it (the CSRF setup exemption, the MFA enrollment
 * allowlist, the API-token resource scope) compares a string the router never used. That is the exact
 * "the guard inspects a DIFFERENT value than the one that reaches the sink" shape this file already paid
 * for once. ONE normalizer, so the three call sites below cannot drift apart again.
 */
function normalizedRequestPath(req: Request): string {
    return String(req.originalUrl || req.url || '')
        .split('?')[0]
        .toLowerCase()
        .replace(/\/{2,}/g, '/');
}

function apiResourceOf(req: Request): string {
    // Lowercased so it matches Express's case-insensitive routing key (a `posts:write` token must work on
    // `/api/v1/Posts` exactly as on `/posts`). This never widens access: the extracted slug must still equal
    // the resource Express actually routes to, so it can't masquerade as a different resource's handler.
    const path = normalizedRequestPath(req);
    const prefix = API_PREFIX.toLowerCase();
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const m = /^\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(rest);
    return m ? m[1] : '';
}

// The request sub-path after the API prefix (lowercased, trailing slash trimmed) — e.g. '/auth/mfa/enable'.
function pathAfterApiPrefix(req: Request): string {
    const path = normalizedRequestPath(req);
    const prefix = API_PREFIX.toLowerCase();
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    return rest.replace(/\/+$/, '') || '/';
}

// Routes an MFA-enforced (past-grace, un-enrolled) user may STILL reach — the enrollment escape hatch plus
// session maintenance. Deliberately EXCLUDES /auth/mfa/policy (admin config: an enforced admin must enroll
// before reconfiguring, else compromising a 2FA-less admin password lets the attacker just disable the
// policy) and /auth/tokens (minting a headless token would sidestep the whole gate).
const MFA_ENFORCE_EXEMPT = new Set([
    '/auth/me', '/auth/logout', '/auth/refresh',
    '/auth/mfa/setup', '/auth/mfa/enable', '/auth/mfa/status', '/auth/mfa/backup-codes', '/auth/mfa/disable',
]);
function isMfaEnforceExempt(req: Request): boolean {
    return MFA_ENFORCE_EXEMPT.has(pathAfterApiPrefix(req));
}

// The ONLY state-changing endpoints that legitimately predate any origin, session or user: the wizard's
// pre-install doors. `isInstalled()` closes both of them once the site exists, so this set is empty of
// authority on a live site. Deliberately NOT the whole '/setup/' subtree — see csrfProtection below.
const CSRF_EXEMPT_PATHS = new Set(['/setup/install', '/setup/test-db']);

/**
 * Global gate for the admin-enforced MFA-by-role policy. Mounted at the API prefix, it runs BEFORE the
 * per-route auth and returns 403 `mfa_enrollment_required` for a COOKIE session whose user is past their
 * grace window without 2FA — except on the enrollment/session allowlist. It never authenticates a request
 * (the route's own `authenticate` still does the real auth below); it only adds a pre-filter.
 *
 * Cheap when the feature is off (empty requiredRoles → one cached getOption). Bearer/API-token clients are
 * exempt (headless, can't enroll; a NEW token can't be minted because POST /auth/tokens is not exempt).
 * Fails OPEN on an internal error — enforcement is a policy layer on top of auth, and breaking it must not
 * take the whole site down; the underlying session auth is unaffected.
 */
async function mfaComplianceGate(req: Request, res: Response, next: NextFunction) {
    // Reading the policy is site-wide; if it can't be read we can't enforce anything, so fail OPEN here
    // (blocking everyone on a transient option-store blip would be worse than skipping enforcement once).
    let policy: any;
    try { policy = await mfa.getPolicy(); }
    catch (e: any) { console.warn('[mfa] gate: policy read failed, skipping:', e && e.message); return next(); }
    if (!policy.requiredRoles.length) return next();

    // Resolve the interactive session token from EITHER transport, mirroring authenticate()'s priority
    // (Authorization header first, then cookie). A genuine `wjt_` API token is headless and exempt; but a
    // raw SESSION JWT presented as `Authorization: Bearer <jwt>` authenticates a full session and MUST be
    // enforced — exempting all Bearer requests let an un-enrolled admin replay their own session JWT as a
    // header to skip the gate entirely (and then mint a wjt_ token). Only the wjt_ prefix is exempt.
    const authHeader = req.headers.authorization;
    let token: string | null = null;
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader !== 'Bearer null' && authHeader !== 'Bearer undefined') {
        const bearer = authHeader.slice(7);
        if (bearer.startsWith(ApiToken.PREFIX)) return next(); // headless API token — exempt (see note below)
        token = bearer; // a session JWT over the Bearer transport — subject to enforcement
    }
    if (!token) token = sessionCookie(req);
    // Also cover the `?token=` transport that authenticateAllowQuery honors (e.g. the plugin-bundle download),
    // so an enforced user can't slip a session JWT past the gate via the query string. A wjt_ token there is
    // exempt exactly like on the Bearer path.
    const qToken = token ? null : queryToken(req);
    if (qToken) {
        if (qToken.startsWith(ApiToken.PREFIX)) return next();
        token = qToken;
    }
    if (!token) return next(); // no session — nothing to enforce (the route's own auth still applies)

    if (isMfaEnforceExempt(req)) return next();

    let decoded: any;
    try { decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }); }
    catch { return next(); } // invalid/expired — the route's authenticate will 401 it
    if (!decoded || decoded.purpose) return next(); // challenge/special-purpose tokens are not sessions

    // A valid, non-exempt session is present — the only question left is compliance. If we can't determine
    // it, fail CLOSED for this one request (the enrollment/logout allowlist above stays reachable, so the
    // user is never bricked): silently skipping here would let an enforced user through on any hiccup.
    try {
        const user = await User.findById(decoded.userId);
        if (!user) return next();
        const status = await mfa.evaluate(user);
        if (status.enforced) {
            return res.status(403).json({
                code: 'mfa_enrollment_required',
                message: 'Two-factor authentication is required for your role. Enroll now to continue.',
                data: { status: 403, graceDeadline: status.graceDeadline }
            });
        }
        return next();
    } catch (e: any) {
        console.warn('[mfa] gate: compliance check failed, failing closed:', e && e.message);
        return res.status(503).json({
            code: 'mfa_check_failed',
            message: 'Could not verify two-factor compliance. Please try again.',
            data: { status: 503 }
        });
    }
    // NOTE (documented residual, adversarial review #2): a `wjt_` API token minted BEFORE the policy took
    // effect keeps working for a required-role user — token clients are categorically exempt (they cannot
    // perform interactive 2FA). Revoke such tokens if a role's headless access must also be gated.
}

/**
 * Authenticate request with JWT token (Strict: Headers Only)
 */
// Helper to avoid duplication
async function verifyAndAttachUser(token: string, req: Request, res: Response, next: NextFunction) {
    try {
        const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });

        // A session token (generateToken) carries NO `purpose`. Special-purpose tokens signed with the
        // same secret — notably the MFA `mfa_challenge` token — must NEVER authenticate a request, or the
        // second factor could be skipped by presenting the challenge token as a session credential.
        if (decoded.purpose) {
            return res.status(401).json({ code: 'rest_token_invalid', message: 'Invalid token.', data: { status: 401 } });
        }

        const user = await User.findById(decoded.userId);

        if (!user) {
            return res.status(401).json({
                code: 'rest_user_invalid',
                message: 'User not found.',
                data: { status: 401 }
            });
        }

        // Stateless-JWT revocation: reject any token issued before the user's security epoch, which is
        // stamped on logout and password change (User meta `token_valid_after`). Without this, a stolen
        // token stays valid until expiry even after logout/password reset.
        // Use <= (not <): JWT iat is whole seconds and validAfter is stamped as Math.floor(now/1000),
        // so a token minted in the SAME wall-clock second as the logout/password-change must also be
        // revoked — otherwise iat === validAfter slips through.
        const validAfter = parseInt(user.meta && user.meta.token_valid_after, 10);
        if (validAfter && decoded.iat && decoded.iat <= validAfter) {
            return res.status(401).json({
                code: 'rest_token_revoked',
                message: 'Session has been revoked. Please log in again.',
                data: { status: 401 }
            });
        }

        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                code: 'rest_token_expired',
                message: 'Token has expired.',
                data: { status: 401 }
            });
        }

        return res.status(401).json({
            code: 'rest_token_invalid',
            message: 'Invalid token.',
            data: { status: 401 }
        });
    }
}

/**
 * Authenticate a request bearing a scoped API token (`Authorization: Bearer wjt_...`). Mirrors
 * verifyAndAttachUser's contract: calls next() on success, sends a 401/403 on failure.
 *
 * The token acts AS its issuing user, so req.user is the real user object and EVERY downstream capability
 * check (req.user.can / isAdmin) still applies — a token can never exceed the user's own permissions. On
 * top of that we enforce the token's read/write scope here (a read token cannot drive a mutating method).
 */
async function verifyApiTokenAndAttachUser(token: string, req: Request, res: Response, next: NextFunction) {
    try {
        const record = await ApiToken.findByRawToken(token);
        if (!record) {
            return res.status(401).json({
                code: 'rest_token_invalid',
                message: 'Invalid or expired API token.',
                data: { status: 401 }
            });
        }
        const user = await User.findById(record.userId);
        if (!user) {
            return res.status(401).json({
                code: 'rest_user_invalid',
                message: 'User not found.',
                data: { status: 401 }
            });
        }
        const resource = apiResourceOf(req);
        if (!ApiToken.scopeAllows(record.scopes, req.method, resource)) {
            const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase());
            return res.status(403).json({
                code: 'rest_token_scope_insufficient',
                message: isWrite
                    ? `This API token cannot ${req.method}${resource ? ` the "${resource}" resource` : ''}. Its scope does not grant write access here.`
                    : `This API token's scope does not grant read access${resource ? ` to the "${resource}" resource` : ''}.`,
                data: { status: 403 }
            });
        }
        req.user = user;
        markHeadless(req, record);
        ApiToken.touch(record.id);
        next();
    } catch (error) {
        return res.status(401).json({
            code: 'rest_token_invalid',
            message: 'Invalid API token.',
            data: { status: 401 }
        });
    }
}

// ─── Headless (API-token) requests: the one mark, and the two gates that read it ───────────────────

/**
 * Stamp a request as HEADLESS — authenticated by a `wjt_` machine token rather than by an interactive
 * login. Called from EVERY place that resolves such a token (the strict path above and optionalAuth
 * below) so the mark can never be set on one surface and forgotten on the other. `req.apiToken` carries
 * the token's identity/scopes; `req.isHeadless` is the boolean the gates below assert on, so those read
 * as the invariant they enforce instead of as an incidental field check.
 */
function markHeadless(req: Request, record: { id: number; scopes: string[]; name: string }): void {
    req.apiToken = { id: record.id, scopes: record.scopes, name: record.name };
    req.isHeadless = true;
}

function isHeadless(req: Request): boolean {
    return !!(req && (req.isHeadless || req.apiToken));
}

const SESSION_COOKIE = 'wordjs_token';

// ─── COOKIES ARE AN UNTRUSTED CHANNEL THAT ALSO HAS A TYPE ────────────────────────────────────────
/**
 * `cookieParser()` applies JSONCookies UNCONDITIONALLY (cookie-parser/index.js: every value that starts
 * with `j:` is JSON.parse'd), so a cookie is NOT necessarily a string once it reaches a route:
 * `Cookie: wordjs_token=j:[1]` lands in `req.cookies.wordjs_token` as an ARRAY. Every reader below then
 * ran `token.startsWith(...)` on it. Because `authenticate`/`optionalAuth`/`authenticateAllowQuery` are
 * async and Express 4 does not await a middleware's promise, the TypeError never reaches the error
 * handler: no next(), no response, the socket simply hangs until the client gives up. Anonymous, free,
 * remote, and it applies to EVERY route carrying one of these middlewares.
 *
 * Two changes, because they close different halves and neither subsumes the other:
 *
 *  1. `sanitizeCookies` (mounted in index.ts immediately after cookieParser) — the CHOKEPOINT. RFC 6265
 *     defines a cookie as a name→string pair, so anything cookie-parser turned into a non-string is not
 *     a cookie value and is dropped before any router, guard or plugin can read it. This is what makes
 *     the class closed rather than the five call sites: a reader that does not exist yet, in a file
 *     nobody has written, cannot receive a non-string cookie.
 *  2. `sessionCookie` — ONE reader for the session cookie, used by all four readers in this file and by
 *     routes/auth.ts, so the guarantee does not silently depend on mount order. Test harnesses and
 *     core/plugin-isolate mount routers WITHOUT index.ts's middleware chain; a value-level check that
 *     travels with the reader still holds there.
 */
function sanitizeCookies(req: Request, _res: Response, next: NextFunction): void {
    for (const bag of [req.cookies, req.signedCookies]) {
        if (!bag || typeof bag !== 'object') continue;
        for (const name of Object.keys(bag)) {
            if (typeof bag[name] !== 'string') delete bag[name];
        }
    }
    next();
}

/** The session cookie as a STRING, or null. The only place this file reads `req.cookies`. */
function sessionCookie(req: Request): string | null {
    const v = req && req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
    return typeof v === 'string' && v ? v : null;
}

/**
 * The `?token=` transport, same treatment: `?token[]=x` makes `req.query.token` an Array and the same
 * `.startsWith` blows up in authenticateAllowQuery. Express's query parser is the other producer of
 * non-string request values, so it needs the same boundary check as the cookie bag.
 */
function queryToken(req: Request): string | null {
    const v = req && req.query ? req.query.token : undefined;
    return typeof v === 'string' && v ? v : null;
}

/**
 * THE ONE DOOR that mints the interactive session cookie.
 *
 * Before this, POST /auth/refresh carried only `authenticate`, which accepts a `wjt_` API token exactly
 * as happily as a session JWT, and then set a 7-day `wordjs_token` cookie. That traded a leaked headless
 * token for a full interactive session: the resulting cookie carries no `req.apiToken`, so `sessionOnly`
 * — the guard that keeps tokens away from /auth/tokens and /auth/mfa/* — no longer saw a token at all,
 * and revoking the leaked token did not cut the derived session off. Listing route-by-route what a token
 * may not touch is the wrong shape: the list is open-ended and a single omission is a full bypass. So the
 * rule is INVERTED here — a headless request may never cause a session cookie to be emitted, whatever
 * route asked for it, and a new cookie-issuing route inherits the refusal by construction.
 *
 * Returns true when it REFUSED and already sent the response (the caller must return immediately), false
 * when the cookie was set and the caller should continue — the same "true means handled" convention as
 * requireSelfPasswordReauth in routes/users.ts.
 */
function issueSessionCookie(req: Request, res: Response, token: string, options: CookieOptions): boolean {
    if (isHeadless(req)) {
        res.status(403).json({
            code: 'rest_session_from_token_forbidden',
            message: 'An API token cannot be exchanged for an interactive session. Sign in with your credentials.',
            data: { status: 403 }
        });
        return true;
    }
    res.cookie(SESSION_COOKIE, token, options);
    return false;
}

/**
 * Route guard: this endpoint must be driven by an interactive session (JWT/cookie), never by an API
 * token. Token management must not self-perpetuate (a single leaked write token could otherwise mint
 * fresh tokens or revoke others), and the second factor must not be enrollable/disable-able by a
 * credential the account owner cannot see. Lives here — next to the headless mark it reads — so
 * routes/auth.ts, routes/users.ts and routes/webhooks.ts all consume ONE implementation.
 */
function sessionOnly(req: Request, res: Response, next: NextFunction) {
    if (isHeadless(req)) {
        return res.status(403).json({
            code: 'rest_token_management_forbidden',
            message: 'API tokens cannot manage tokens, two-factor enrollment, or account security. Sign in interactively.',
            data: { status: 403 }
        });
    }
    next();
}

/**
 * Authenticate request with JWT token (Strict: Headers Only, with Cookie fallback)
 */
async function authenticate(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    // Priority 1: Authorization header (for API clients)
    // Check for 'null' or 'undefined' string which can happen if frontend sends localStorage.getItem('token') without check
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader !== 'Bearer null' && authHeader !== 'Bearer undefined') {
        token = authHeader.substring(7);
    }

    // Priority 2: HttpOnly cookie (for browser clients) — always a string or null, see sessionCookie.
    if (!token) {
        token = sessionCookie(req);
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    // Scoped API tokens (wjt_ prefix) take the machine-client path; everything else is a JWT session.
    if (token.startsWith(ApiToken.PREFIX)) {
        return await verifyApiTokenAndAttachUser(token, req, res, next);
    }
    await verifyAndAttachUser(token, req, res, next);
}

/**
 * Authenticate request (Loose: Headers OR Cookie OR Query Param)
 * Use ONLY for read-only endpoints that require direct browser navigation where the client cannot set
 * an Authorization header (EventSource/SSE, <a href> downloads).
 *
 * SECURITY: a JWT placed in ?token= leaks via access logs, the Referer header, and browser history.
 * Prefer the HttpOnly cookie (EventSource/navigations send it same-origin) and the Authorization
 * header; only fall back to the query token when neither is present. This route MUST stay read-only —
 * never authorize a state-changing request off a query-string token.
 */
async function authenticateAllowQuery(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (sessionCookie(req)) {
        token = sessionCookie(req);
    } else if (queryToken(req)) {
        // Last-resort fallback (documented leak above). Kept for legacy EventSource/download clients
        // that can supply neither header nor cookie.
        token = queryToken(req);
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    if (token.startsWith(ApiToken.PREFIX)) {
        return await verifyApiTokenAndAttachUser(token, req, res, next);
    }
    await verifyAndAttachUser(token, req, res, next);
}

/**
 * Optional authentication (doesn't fail if no token)
 */
async function optionalAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else {
        token = sessionCookie(req);
    }

    if (!token) {
        req.user = null;
        return next();
    }

    // Scoped API token — resolve it, but degrade to anonymous (never 401) on any failure, matching this
    // middleware's optional contract. The read/write scope is still honored (a read token can't drive a
    // mutating request even on an optional-auth route).
    if (token.startsWith(ApiToken.PREFIX)) {
        try {
            const record = await ApiToken.findByRawToken(token);
            const user = record ? await User.findById(record.userId) : null;
            if (user && ApiToken.scopeAllows(record.scopes, req.method, apiResourceOf(req))) {
                req.user = user;
                markHeadless(req, record);
                ApiToken.touch(record.id);
            } else {
                req.user = null;
            }
        } catch {
            req.user = null;
        }
        return next();
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
        // Special-purpose tokens (e.g. the MFA challenge) are never a session — treat as anonymous.
        if (decoded.purpose) { req.user = null; return next(); }
        const user = await User.findById(decoded.userId);
        // Honor token revocation here too (see verifyAndAttachUser): treat a revoked token as anonymous.
        // Use <= so a token issued in the same second as logout/password-change is also revoked.
        const validAfter = user ? parseInt(user.meta && user.meta.token_valid_after, 10) : 0;
        if (user && validAfter && decoded.iat && decoded.iat <= validAfter) {
            req.user = null;
        } else {
            req.user = user;
        }
    } catch (e) {
        req.user = null;
    }

    next();
}

/**
 * Generate JWT token for user
 */
function generateToken(user: any) {
    return jwt.sign(
        {
            userId: user.id,
            username: user.userLogin
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/**
 * Verify token and return decoded payload
 */
function verifyToken(token: string) {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
}

/**
 * THE HOST THIS REQUEST WAS ACTUALLY SENT TO — one derivation, for every gate that asks.
 *
 * Behind the gateway (changeOrigin:true) `req.get('Host')` is the INTERNAL upstream address
 * (127.0.0.1:PORT), so a same-origin check against it could never match a real browser request. The
 * gateway forwards the browser's own Host as X-Forwarded-Host (xfwd:true) and STRIPS any client-supplied
 * value, so honor that first and fall back to Host for the direct/monolith case. First hop if a list.
 *
 * `undefined` when there is no host to derive — deliberately NOT ''. Callers compare it to
 * `new URL(origin).host`, and '' equals `new URL('file://').host`, which would be a different hole.
 */
function trustedHost(req: Request): string | undefined {
    const fwdHost = (req.get('X-Forwarded-Host') || '').split(',')[0].trim();
    return fwdHost || req.get('Host') || undefined;
}

/**
 * THE SAME-ORIGIN ALLOW-LIST — one implementation, because two copies of it is what the defect was.
 *
 * `csrfProtection` below (state-changing methods, mounted globally at the api prefix) and `sameOrigin()`
 * in routes/collab.ts (the SSE stream — a GET, which the global gate never runs on) answer the same
 * question: "is this Origin our own?". They were written twice, line for line. So when the previous round
 * closed the absent-Host hole here, the copy in collab.ts kept it, and the live-collaboration channel went
 * on treating a hostile page as same-origin. Sharing the builder is the fix that cannot drift: there is no
 * longer a second answer to give.
 *
 * FAIL CLOSED ON AN ABSENT HOST. `req.get('Host')` is `string | undefined`. Interpolated into the two
 * template literals below, an absent Host does not yield "no entry" — it yields the LITERAL origins
 * 'http://undefined' and 'https://undefined', putting them on the allow-list, so a page served from the
 * (perfectly legal) host label `undefined` was same-origin to this site. It is reachable: Node rejects an
 * HTTP/1.1 request with no Host at the parser (400), but HTTP/1.0 imposes no Host requirement and Node
 * delivers such a request with `req.headers.host === undefined` — proven end to end, against both gates,
 * by the raw-socket tests in tests/absent-host-origin-allowlist.test.ts. No Host means no derivable
 * same-origin, so it must contribute NO entry at all.
 */
function sameOriginAllowList(host: string | undefined): string[] {
    return [
        config.site?.url,
        config.site?.frontendUrl,
        ...(host ? [`http://${host}`, `https://${host}`] : [])
    ].filter(Boolean);
}

/**
 * CSRF Protection for state-changing requests
 * Validates Origin/Referer headers against allowed origins
 */
function csrfProtection(req: Request, res: Response, next: NextFunction) {
    // Only check state-changing methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }

    // Skip the CSRF check for the setup endpoints (they run before any origin — or any user — exists).
    //
    // This used to compare `req.path` against the FULL '/api/v1/setup' prefix, which can NEVER match:
    // csrfProtection is mounted WITH the prefix (`app.use(config.api.prefix, csrfProtection)` in
    // index.ts), and Express strips the mount path from req.url before the middleware runs — inside here
    // req.path is '/setup/install', never '/api/v1/setup/install'. The declared, documented exemption was
    // dead code, and an installer following the docs got a misleading 403 on a site with no users. (The
    // install guard in index.ts uses the same idiom correctly only because it is mounted at the ROOT;
    // the two were copied without noticing that the mount differs.) Derive the sub-path from
    // req.originalUrl — the full, un-rewritten URL — exactly as apiResourceOf/pathAfterApiPrefix above
    // already do, so the exemption is correct at any mount point.
    //
    // ENUMERATED, not a subtree. Reviving the exemption as `startsWith('/setup/')` handed it to
    // POST /setup/migrate too — the ONE route of that subtree that stays alive AFTER installation
    // (routes/setup.ts early-returns 400 'Not installed' on the others). While the exemption was dead
    // code /migrate was de-facto same-origin protected; a subtree exemption silently removed that, so any
    // visitor's browser could be made to drive its (throttled, but real) admin-password oracle from the
    // VICTIM's IP, sidestepping the attacker-IP authLimiter. /migrate authenticates raw credentials in the
    // body and needs no ambient cookie, so it has no reason to skip the check. The endpoints that DO need
    // it are the pre-install ones, which run before any origin — or any user — exists.
    const subPath = pathAfterApiPrefix(req);
    if (CSRF_EXEMPT_PATHS.has(subPath)) {
        return next();
    }

    const origin = req.get('Origin');
    const referer = req.get('Referer');
    const host = trustedHost(req);

    // If no Origin header, check Referer (some browsers)
    // Annotated because the catch below assigns `null` (an unparseable Referer) while `req.get()` yields
    // `string | undefined`; the three states stay distinct exactly as the untyped code left them.
    let requestOrigin: string | null | undefined = origin;
    if (!requestOrigin && referer) {
        try {
            requestOrigin = new URL(referer).origin;
        } catch {
            requestOrigin = null;
        }
    }

    // Allow requests from same host
    if (requestOrigin) {
        try {
            const originHost = new URL(requestOrigin).host;
            if (originHost === host) {
                return next();
            }
        } catch {
            // Invalid origin URL
        }
    }

    // No Origin AND no Referer.
    // Previously this failed OPEN ('server-to-server, API clients must have valid JWT anyway'), but the
    // JWT also rides in the HttpOnly wordjs_token cookie the browser attaches automatically — so a
    // header-less request could drive a cookie-authenticated state change with no anti-CSRF signal
    // (AUTH-A2). Only the Authorization-header (Bearer) path is a genuine non-browser API caller that
    // cannot be CSRF'd via an ambient cookie. So: allow header-less requests ONLY when they carry a
    // Bearer token (not the cookie); otherwise require a positive same-origin signal and reject.
    if (!origin && !referer) {
        const authHeader = req.get('Authorization') || '';
        const isBearer = authHeader.startsWith('Bearer ')
            && authHeader !== 'Bearer null' && authHeader !== 'Bearer undefined';
        if (isBearer) {
            return next();
        }
        console.warn(`[CSRF] Blocked header-less cookie request to ${req.path}`);
        return res.status(403).json({
            code: 'rest_csrf_invalid',
            message: 'Cross-site request blocked.',
            data: { status: 403 }
        });
    }

    // The configured public origins plus this request's own — see sameOriginAllowList() above for why an
    // absent Host contributes NOTHING here rather than the word "undefined".
    const allowedOrigins = sameOriginAllowList(host);

    // EXACT origin match — never startsWith (a prefix match lets `https://victim.com.evil.com`
    // satisfy an allowed `https://victim.com`). Compare normalized origins via URL parsing.
    const originMatches = (allowed: string) => {
        try { return new URL(allowed).origin === requestOrigin; } catch { return false; }
    };
    if (requestOrigin && allowedOrigins.some(originMatches)) {
        return next();
    }

    console.warn(`[CSRF] Blocked request from ${requestOrigin || 'unknown'} to ${req.path}`);
    return res.status(403).json({
        code: 'rest_csrf_invalid',
        message: 'Cross-site request blocked.',
        data: { status: 403 }
    });
}

module.exports = {
    authenticate,
    authenticateAllowQuery,
    optionalAuth,
    generateToken,
    verifyToken,
    csrfProtection,
    // Same-origin boundary — ONE trusted-host derivation and ONE allow-list, consumed by every gate that
    // asks the question (csrfProtection here, sameOrigin() in routes/collab.ts). Exported so there is
    // nothing left to copy.
    trustedHost,
    sameOriginAllowList,
    mfaComplianceGate,
    // Headless (API-token) boundary — one mark, one cookie door, one session-only guard.
    isHeadless,
    issueSessionCookie,
    sessionOnly,
    SESSION_COOKIE,
    // Request-value boundary — cookies and query params are not necessarily strings.
    sanitizeCookies,
    sessionCookie,
    queryToken
};
