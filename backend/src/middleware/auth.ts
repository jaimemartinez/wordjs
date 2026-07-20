/**
 * WordJS - Authentication Middleware
 * JWT-based authentication
 */

import type { Response, NextFunction } from 'express';

const jwt = require('jsonwebtoken');
const config = require('../config/app');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');

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
function apiResourceOf(req: any): string {
    // Lowercased so it matches Express's case-insensitive routing key (a `posts:write` token must work on
    // `/api/v1/Posts` exactly as on `/posts`). This never widens access: the extracted slug must still equal
    // the resource Express actually routes to, so it can't masquerade as a different resource's handler.
    const path = String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
    const prefix = API_PREFIX.toLowerCase();
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const m = /^\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(rest);
    return m ? m[1] : '';
}

/**
 * Authenticate request with JWT token (Strict: Headers Only)
 */
// Helper to avoid duplication
async function verifyAndAttachUser(token: string, req: any, res: Response, next: NextFunction) {
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
        req.userId = user.id;
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
async function verifyApiTokenAndAttachUser(token: string, req: any, res: Response, next: NextFunction) {
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
        req.userId = user.id;
        req.apiToken = { id: record.id, scopes: record.scopes, name: record.name };
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

/**
 * Authenticate request with JWT token (Strict: Headers Only, with Cookie fallback)
 */
async function authenticate(req: any, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    // Priority 1: Authorization header (for API clients)
    // Check for 'null' or 'undefined' string which can happen if frontend sends localStorage.getItem('token') without check
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader !== 'Bearer null' && authHeader !== 'Bearer undefined') {
        token = authHeader.substring(7);
    }

    // Priority 2: HttpOnly cookie (for browser clients)
    if (!token && req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
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
async function authenticateAllowQuery(req: any, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
    } else if (req.query && req.query.token) {
        // Last-resort fallback (documented leak above). Kept for legacy EventSource/download clients
        // that can supply neither header nor cookie.
        token = req.query.token;
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
async function optionalAuth(req: any, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
    }

    if (!token) {
        req.user = null;
        req.userId = null;
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
                req.userId = user.id;
                req.apiToken = { id: record.id, scopes: record.scopes, name: record.name };
                ApiToken.touch(record.id);
            } else {
                req.user = null;
                req.userId = null;
            }
        } catch {
            req.user = null;
            req.userId = null;
        }
        return next();
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
        // Special-purpose tokens (e.g. the MFA challenge) are never a session — treat as anonymous.
        if (decoded.purpose) { req.user = null; req.userId = null; return next(); }
        const user = await User.findById(decoded.userId);
        // Honor token revocation here too (see verifyAndAttachUser): treat a revoked token as anonymous.
        // Use <= so a token issued in the same second as logout/password-change is also revoked.
        const validAfter = user ? parseInt(user.meta && user.meta.token_valid_after, 10) : 0;
        if (user && validAfter && decoded.iat && decoded.iat <= validAfter) {
            req.user = null;
            req.userId = null;
        } else {
            req.user = user;
            req.userId = user ? user.id : null;
        }
    } catch (e) {
        req.user = null;
        req.userId = null;
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
 * CSRF Protection for state-changing requests
 * Validates Origin/Referer headers against allowed origins
 */
function csrfProtection(req: any, res: Response, next: NextFunction) {
    // Only check state-changing methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }

    // Skip CSRF check for setup endpoints (before origin is configured)
    if (req.path.startsWith('/api/v1/setup')) {
        return next();
    }

    const origin = req.get('Origin');
    const referer = req.get('Referer');
    // Behind the gateway (changeOrigin:true) req.get('Host') is the internal upstream address
    // (127.0.0.1:PORT), so the same-origin check below would never match a real browser request.
    // The gateway forwards the original client Host as X-Forwarded-Host (xfwd:true) — honor it first,
    // exactly like the migration guard does. Take the first hop if a list is present.
    const fwdHost = (req.get('X-Forwarded-Host') || '').split(',')[0].trim();
    const host = fwdHost || req.get('Host');

    // If no Origin header, check Referer (some browsers)
    let requestOrigin = origin;
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

    // Allow configured CORS origins. `host` comes from X-Forwarded-Host, which the gateway now pins
    // to the real client Host (it strips any client-supplied value), so trusting it here is safe.
    const allowedOrigins = [
        config.site?.url,
        config.site?.frontendUrl,
        `http://${host}`,
        `https://${host}`
    ].filter(Boolean);

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
    csrfProtection
};
