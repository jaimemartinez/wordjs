/**
 * WordJS - Auth Routes
 * /api/v1/auth/*
 */

import type { Response, CookieOptions } from 'express';
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate, generateToken, verifyToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { getOption } = require('../core/options');
const config = require('../config/app');
const crypto = require('crypto');
const mfa = require('../core/mfa');

// Per-account login lockout: the per-IP rate limiter is defeated by a botnet/proxy pool targeting a
// single account, and there was no account-level throttle. Lock an account for a cooldown after N
// consecutive failures.
//
// Multi-node (AUTH-A3): an in-process-only counter weakens to N× on a multi-replica deployment (an
// attacker spreading attempts across R replicas gets R×10 attempts) and is wiped by a node restart.
// So when Redis is configured we back the counter with the SHARED rate-limit client (the same
// cache.getClient() the IP limiters use), keyed by the normalized username, with the lock TTL in
// Redis. The in-memory Map remains the single-node path and the always-on fallback: any Redis error
// (or no client configured) degrades to in-process exactly as before — a Redis outage NEVER blocks
// login. Mirrors limiterStore()'s passOnStoreError philosophy.
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const _loginFails = new Map(); // key -> { count, firstFailAt, lockedUntil }
const _loginKey = (u: any) => String(u || '').trim().toLowerCase();

// Resolve a submitted identifier (username OR email) to the account's canonical user_login, so the
// per-account lockout counter can't be DOUBLED by alternating the two forms — both authenticate the same
// account yet keyed two distinct buckets before (audit LOW). Falls back to the raw identifier when no
// account matches (a nonexistent-user probe is still rate-limited under its own key).
async function resolveLockIdentifier(identifier: any) {
    try {
        const User = require('../models/User');
        const u = (await User.findByLogin(identifier)) || (await User.findByEmail(identifier));
        return u ? u.userLogin : identifier;
    } catch { return identifier; }
}

// Lazily-resolved shared store client (null on single-node or if Redis isn't configured).
function _lockStore() {
    try {
        const cache = require('../core/cache');
        return cache.getClient() || null;
    } catch {
        return null;
    }
}
const _failsRedisKey = (key: string) => `wjlock:fails:${key}`;
const _lockedRedisKey = (key: string) => `wjlock:locked:${key}`;

function _isLoginLockedMem(key: string) {
    const e = _loginFails.get(key);
    return !!(e && e.lockedUntil && e.lockedUntil > Date.now());
}

async function isLoginLocked(u: any) {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try {
            const locked = await client.get(_lockedRedisKey(key));
            return !!locked;
        } catch {
            // Redis hiccup → fall through to the in-memory view (fail-safe: still throttles single node).
        }
    }
    return _isLoginLockedMem(key);
}

async function recordLoginFail(u: any) {
    const key = _loginKey(u);
    const now = Date.now();
    const client = _lockStore();
    if (client) {
        try {
            const failKey = _failsRedisKey(key);
            const lockTtlSec = Math.ceil(LOGIN_LOCK_MS / 1000);
            const count = await client.incr(failKey);
            // (Re)set the sliding-window expiry on the counter each failure.
            await client.expire(failKey, lockTtlSec);
            if (count >= LOGIN_MAX_FAILS) {
                await client.set(_lockedRedisKey(key), '1', 'PX', LOGIN_LOCK_MS);
            }
            return;
        } catch {
            // Redis hiccup → record in-memory instead so this node still throttles.
        }
    }
    let e = _loginFails.get(key);
    if (!e || (now - e.firstFailAt) > LOGIN_LOCK_MS) e = { count: 0, firstFailAt: now, lockedUntil: 0 };
    e.count++;
    if (e.count >= LOGIN_MAX_FAILS) e.lockedUntil = now + LOGIN_LOCK_MS;
    _loginFails.set(key, e);
}

async function clearLoginFails(u: any) {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try {
            await client.del(_failsRedisKey(key), _lockedRedisKey(key));
        } catch {
            // ignore — clearing is best-effort; the TTL will expire the keys anyway.
        }
    }
    _loginFails.delete(key);
}

// Cookie configuration for secure HttpOnly tokens
// Detect if site uses HTTPS from config
const siteUsesHttps = config.siteUrl?.startsWith('https://') || config.ssl?.enabled;
const COOKIE_OPTIONS: CookieOptions = {
    httpOnly: true,
    secure: siteUsesHttps, // Send over HTTPS if site uses it
    sameSite: 'lax', // Protect against CSRF while allowing normal navigation
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
};

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               displayName:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 *       400:
 *         description: Validation error or user exists
 */
router.post('/register', asyncHandler(async (req: any, res: Response) => {
    // ... (rest of the function)
    const registrationAllowed = await getOption('users_can_register', 0);
    if (!registrationAllowed || registrationAllowed == '0') {
        return res.status(403).json({
            code: 'rest_cannot_register',
            message: 'User registration is currently disabled.',
            data: { status: 403 }
        });
    }

    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username, email, and password are required.',
            data: { status: 400 }
        });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Invalid email format.',
            data: { status: 400 }
        });
    }

    // Validate password strength
    if (password.length < 8) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must be at least 8 characters.',
            data: { status: 400 }
        });
    }

    if (password.length > 72) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must not exceed 72 characters.',
            data: { status: 400 }
        });
    }

    try {
        const defaultRole = await getOption('default_role', 'subscriber');
        const user = await User.create({
            username,
            email,
            password,
            displayName: displayName || username,
            role: defaultRole
        });

        const token = generateToken(user);
        res.cookie('wordjs_token', token, COOKIE_OPTIONS);

        res.status(201).json({ user: user.toJSON() });
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                code: 'rest_user_exists',
                message: error.message,
                data: { status: 400 }
            });
        }
        throw error;
    }
}));

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', asyncHandler(async (req: any, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username and password are required.',
            data: { status: 400 }
        });
    }

    const lockId = await resolveLockIdentifier(username);
    if (await isLoginLocked(lockId)) {
        return res.status(429).json({
            code: 'rest_account_locked',
            message: 'Account temporarily locked due to too many failed attempts. Try again later.',
            data: { status: 429 }
        });
    }

    try {
        const user = await User.authenticate(username, password);
        await clearLoginFails(lockId);

        // Second factor: if the account has MFA enabled, do NOT issue the session yet. Return a short-lived
        // challenge token; the client must call POST /auth/mfa with a valid TOTP or backup code to finish.
        if (await mfa.isEnabled(user.id)) {
            return res.json({ mfaRequired: true, mfaToken: mfa.signChallenge(user.id) });
        }

        const token = generateToken(user);
        res.cookie('wordjs_token', token, COOKIE_OPTIONS);
        res.json({ user: user.toJSON() });
    } catch (error) {
        await recordLoginFail(lockId);
        return res.status(401).json({
            code: 'rest_invalid_credentials',
            message: 'Invalid username or password.',
            data: { status: 401 }
        });
    }
}));

/**
 * GET /auth/me
 * Get current user
 */
router.get('/me', authenticate, (req: any, res: Response) => {
    res.json(req.user.toJSON());
});

/**
 * POST /auth/validate
 * Validate token
 */
router.post('/validate', authenticate, (req: any, res: Response) => {
    res.json({
        valid: true,
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/refresh
 * Refresh token
 */
router.post('/refresh', authenticate, (req: any, res: Response) => {
    const token = generateToken(req.user);

    // Update HttpOnly cookie
    res.cookie('wordjs_token', token, COOKIE_OPTIONS);

    res.json({
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/logout
 * Clear auth cookie
 */
router.post('/logout', asyncHandler(async (req: any, res: Response) => {
    // Best-effort revocation: stamp the user's security epoch so the just-cleared token (and any
    // stolen copy of it) can no longer authenticate. Logout still succeeds without a valid token.
    try {
        const ah = req.headers.authorization;
        let token = (ah && ah.startsWith('Bearer ')) ? ah.substring(7) : null;
        if (!token && req.cookies && req.cookies.wordjs_token) token = req.cookies.wordjs_token;
        if (token) {
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
                await User.updateMeta(decoded.userId, 'token_valid_after', String(Math.floor(Date.now() / 1000)));
            }
        }
    } catch { /* invalid/expired token — nothing to revoke */ }
    res.clearCookie('wordjs_token', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
}));

// ---------------------------------------------------------------------------------------------------
// Password recovery ("olvidé mi contraseña")
//
// Self-service reset is offered ONLY when a mail provider is active AND declares itself able to deliver
// — an operator without working outbound mail can't deliver the link, so the flow would strand users.
// The reset link is delivered to the user's RECOVERY address: their personal_email, or their primary
// email when that is external (and therefore reachable). A professional @site-domain mailbox is NEVER
// used — a locked-out user can't read their own WordJS inbox. All responses are uniform (anti-enum).
// ---------------------------------------------------------------------------------------------------
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Readiness is checked GENERICALLY — no mail plugin slug is hardcoded, so swapping mail-server for any
// other provider keeps recovery working without touching core. A plugin becomes the provider by calling
// wordjs.provideMail() (which sets global.wordjs_send_mail, and which the host DELETES when that plugin
// unloads — so this fails closed on deactivation), and declares itself configured to deliver externally
// by setting the shared `mail_delivery_ready` option to '1' (a self-hosted MTA sets it once its DNS
// verifies; an external SMTP/relay would set it once its credentials validate).
async function mailReady(): Promise<boolean> {
    try {
        if (typeof (global as any).wordjs_send_mail !== 'function') return false;
        return String(await getOption('mail_delivery_ready', '0')) === '1';
    } catch {
        return false;
    }
}

async function siteDomainName(): Promise<string> {
    try { return new URL(await getOption('siteurl', await getOption('home', 'http://localhost'))).hostname.toLowerCase(); }
    catch { return ''; }
}

// The address we can actually reach for recovery, or '' if none (professional mailbox is unreachable
// while locked out, so it is never a target).
async function recoveryTarget(user: any): Promise<string> {
    const personal = String((await User.getMeta(user.id, 'personal_email')) || '').trim().toLowerCase();
    if (personal) return personal;
    const primary = String(user.userEmail || '').trim().toLowerCase();
    const dom = primary.split('@')[1] || '';
    const site = await siteDomainName();
    if (dom && dom !== site) return primary; // external primary address → reachable
    return '';
}

/**
 * GET /auth/password-reset-available
 * Public probe so the login page shows "Forgot password?" only when self-service reset can actually work.
 */
router.get('/password-reset-available', asyncHandler(async (_req: any, res: Response) => {
    res.json({ available: await mailReady() });
}));

/**
 * POST /auth/forgot-password
 * Body: { login } (username or account email). ALWAYS 200 — never reveals whether the account exists
 * or has a reachable recovery address (anti-enumeration). Rate-limited by authLimiter in index.ts.
 */
router.post('/forgot-password', asyncHandler(async (req: any, res: Response) => {
    const login = String((req.body && req.body.login) || '').trim();
    const ok = () => res.json({ ok: true, message: 'If an account with a recovery email exists, a reset link has been sent.' });
    if (!login) return ok();
    if (!(await mailReady())) return ok();

    let user: any = null;
    try { user = await User.findByLogin(login); } catch { user = null; }
    if (!user && login.includes('@')) { try { user = await User.findByEmail(login); } catch { user = null; } }
    if (!user) return ok();

    const to = await recoveryTarget(user);
    if (!to) return ok();

    // Mint a single-use token; persist only its SHA-256 hash + expiry (never the raw token).
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await User.updateMeta(user.id, 'password_reset_hash', hash);
    await User.updateMeta(user.id, 'password_reset_expires', String(Date.now() + RESET_TTL_MS));

    const base = String((await getOption('siteurl', await getOption('home', config.siteUrl || 'http://localhost'))) || 'http://localhost').replace(/\/+$/, '');
    const link = `${base}/reset-password?uid=${user.id}&token=${raw}`;
    const siteName = await getOption('blogname', 'WordJS');

    try {
        (global as any).wordjs_send_mail({
            to,
            subject: `Password reset for ${siteName}`,
            text: `Someone requested a password reset for your ${siteName} account (${user.userLogin}).\n\nReset your password (this link is valid for 30 minutes):\n${link}\n\nIf you did not request this, you can safely ignore this email — your password will not change.`,
            html: `<p>Someone requested a password reset for your <strong>${siteName}</strong> account (<code>${user.userLogin}</code>).</p>`
                + `<p><a href="${link}">Reset your password</a> — this link is valid for 30 minutes.</p>`
                + `<p>If you did not request this, you can safely ignore this email; your password will not change.</p>`
        });
    } catch { /* swallow send errors — keep the response uniform, don't leak mail-infra state */ }

    return ok();
}));

/**
 * POST /auth/reset-password
 * Body: { uid, token, password }. Consumes the single-use token and revokes all existing sessions.
 * Rate-limited by authLimiter in index.ts.
 */
router.post('/reset-password', asyncHandler(async (req: any, res: Response) => {
    const uid = parseInt((req.body && req.body.uid), 10);
    const token = String((req.body && req.body.token) || '');
    const password = String((req.body && req.body.password) || '');

    const bad = () => res.status(400).json({ code: 'rest_invalid_reset', message: 'This reset link is invalid or has expired. Please request a new one.', data: { status: 400 } });
    if (!uid || !token || !password) return bad();
    if (password.length < 8) return res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
    if (password.length > 72) return res.status(400).json({ code: 'rest_invalid_param', message: 'Password must not exceed 72 characters.', data: { status: 400 } });

    let user: any = null;
    try { user = await User.findById(uid); } catch { user = null; }
    if (!user) return bad();

    const storedHash = String((await User.getMeta(uid, 'password_reset_hash')) || '');
    const expires = parseInt(String((await User.getMeta(uid, 'password_reset_expires')) || '0'), 10) || 0;
    if (!storedHash || Date.now() > expires) return bad();

    // Constant-time compare of the SHA-256 hashes to avoid a timing oracle on the token.
    const givenHash = crypto.createHash('sha256').update(token).digest('hex');
    const a = Buffer.from(givenHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad();

    // User.update() bcrypt-hashes the password AND stamps token_valid_after (revokes every session);
    // then consume the single-use token so the link cannot be replayed.
    await User.update(uid, { password });
    await User.updateMeta(uid, 'password_reset_hash', '');
    await User.updateMeta(uid, 'password_reset_expires', '0');

    res.json({ ok: true, message: 'Your password has been reset. You can now log in with your new password.' });
}));

// ─── Scoped API tokens (personal access tokens for headless/machine clients) ───────────────────────
// Self-service: a user manages their OWN tokens. Token management MUST be driven by an interactive
// session (JWT/cookie), never by an API token itself — otherwise a single leaked write-scoped token
// could mint fresh tokens (persistence) or revoke others. `sessionOnly` enforces that.
const ApiToken = require('../models/ApiToken');
const MAX_ACTIVE_TOKENS_PER_USER = 100;

function sessionOnly(req: any, res: Response, next: any) {
    if (req.apiToken) {
        return res.status(403).json({
            code: 'rest_token_management_forbidden',
            message: 'API tokens cannot manage API tokens. Sign in interactively to create or revoke tokens.',
            data: { status: 403 }
        });
    }
    next();
}

/**
 * GET /auth/tokens
 * List the current user's API tokens (metadata only — the secret is never returned after creation).
 */
router.get('/tokens', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    const tokens = await ApiToken.listForUser(req.user.id);
    res.json({ tokens });
}));

/**
 * POST /auth/tokens
 * Mint a new API token for the current user. The plaintext token is returned ONCE and is unrecoverable.
 * Body: { name?, scopes?: 'read'|'write'|['read','write']|'*', expiresInDays?: number }
 */
router.post('/tokens', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    const { name, scopes, expiresInDays } = req.body || {};

    // Soft cap on active (non-revoked, unexpired) tokens to bound abuse / accidental runaway creation.
    const existing = await ApiToken.listForUser(req.user.id);
    const activeCount = existing.filter((t: any) => !t.revoked && (t.expiresAt == null || t.expiresAt * 1000 > Date.now())).length;
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
        return res.status(400).json({
            code: 'rest_token_limit',
            message: `You have reached the maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens. Revoke one first.`,
            data: { status: 400 }
        });
    }

    if (expiresInDays != null && (!Number.isFinite(Number(expiresInDays)) || Number(expiresInDays) <= 0)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'expiresInDays must be a positive number of days.',
            data: { status: 400 }
        });
    }

    const created = await ApiToken.generate({
        userId: req.user.id,
        name,
        scopes,
        expiresInDays: expiresInDays != null ? Number(expiresInDays) : null
    });

    // `token` is the plaintext — surface it now; it can never be shown again.
    res.status(201).json({
        id: created.id,
        token: created.token,
        tokenPrefix: created.tokenPrefix,
        name: created.name,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
        message: 'Save this token now — it will not be shown again.'
    });
}));

/**
 * DELETE /auth/tokens/:id
 * Revoke one of the current user's tokens. Idempotent-ish: 404 if it isn't the caller's or is already gone.
 */
router.delete('/tokens/:id', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid token id.', data: { status: 400 } });
    }
    const ok = await ApiToken.revoke(id, req.user.id);
    if (!ok) {
        return res.status(404).json({
            code: 'rest_token_not_found',
            message: 'Token not found or already revoked.',
            data: { status: 404 }
        });
    }
    res.json({ revoked: true, id });
}));

// ─── Multi-factor auth (TOTP) ──────────────────────────────────────────────────────────────────────
// The login step (POST /mfa) is public — it's the 2nd half of authentication, gated by the short-lived
// challenge token that /auth/login issues only after the password check. Management routes are session-
// only (an API token, even one leaked, must never be able to enroll/disable MFA or mint backup codes).

/**
 * POST /auth/mfa — complete a login that requires a second factor. Body: { mfaToken, code }.
 * The challenge token proves the password step passed; verify a TOTP/backup code, then issue the session.
 */
router.post('/mfa', asyncHandler(async (req: any, res: Response) => {
    const { mfaToken, code } = req.body || {};
    const challenge = mfa.verifyChallenge(mfaToken);
    if (!challenge) {
        return res.status(401).json({ code: 'rest_mfa_challenge_invalid', message: 'Your login session expired. Please sign in again.', data: { status: 401 } });
    }
    const user = await User.findById(challenge.userId);
    if (!user) return res.status(401).json({ code: 'rest_user_invalid', message: 'User not found.', data: { status: 401 } });

    // Reuse the per-account lockout so the 6-digit code can't be brute-forced.
    const lockKey = user.userLogin;
    if (await isLoginLocked(lockKey)) {
        return res.status(429).json({ code: 'rest_account_locked', message: 'Account temporarily locked due to too many failed attempts. Try again later.', data: { status: 429 } });
    }
    if (!(await mfa.verifyLoginCode(user.id, code))) {
        await recordLoginFail(lockKey);
        return res.status(401).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 401 } });
    }
    await clearLoginFails(lockKey);
    const token = generateToken(user);
    res.cookie('wordjs_token', token, COOKIE_OPTIONS);
    res.json({ user: user.toJSON() });
}));

/** GET /auth/mfa/status — is MFA on for the current user + how many backup codes remain. */
router.get('/mfa/status', authenticate, asyncHandler(async (req: any, res: Response) => {
    res.json({ enabled: await mfa.isEnabled(req.user.id), backupCodesRemaining: await mfa.backupCount(req.user.id) });
}));

/** POST /auth/mfa/setup — begin enrollment: returns a new secret + otpauth URI (for the QR). */
router.post('/mfa/setup', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    if (await mfa.isEnabled(req.user.id)) {
        return res.status(400).json({ code: 'rest_mfa_already_enabled', message: 'MFA is already enabled. Disable it first to re-enroll.', data: { status: 400 } });
    }
    const { secret, otpauthUri } = await mfa.beginEnroll(req.user.id, req.user.userEmail || req.user.userLogin);
    res.json({ secret, otpauthUri });
}));

/** POST /auth/mfa/enable — verify a code against the pending secret, activate, return backup codes once. */
router.post('/mfa/enable', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    const result = await mfa.completeEnroll(req.user.id, (req.body || {}).code);
    if (!result.ok) {
        return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid code. Check your device clock and try again.', data: { status: 400 } });
    }
    res.json({ enabled: true, backupCodes: result.backupCodes, message: 'Save these backup codes now — they will not be shown again.' });
}));

/** POST /auth/mfa/disable — turn MFA off (requires a current TOTP or backup code). */
router.post('/mfa/disable', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    if (!(await mfa.isEnabled(req.user.id))) return res.json({ disabled: true });
    if (!(await mfa.verifyLoginCode(req.user.id, (req.body || {}).code))) {
        return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 400 } });
    }
    await mfa.disable(req.user.id);
    res.json({ disabled: true });
}));

/** POST /auth/mfa/backup-codes — regenerate backup codes (requires a current code); returns them once. */
router.post('/mfa/backup-codes', authenticate, sessionOnly, asyncHandler(async (req: any, res: Response) => {
    if (!(await mfa.isEnabled(req.user.id))) {
        return res.status(400).json({ code: 'rest_mfa_not_enabled', message: 'MFA is not enabled.', data: { status: 400 } });
    }
    if (!(await mfa.verifyLoginCode(req.user.id, (req.body || {}).code))) {
        return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 400 } });
    }
    res.json({ backupCodes: await mfa.regenerateBackupCodes(req.user.id), message: 'Save these backup codes now — they replace your previous set.' });
}));

module.exports = router;
// Exposed so other credential-checking endpoints (e.g. /setup/migrate) share the SAME per-account
// lockout — otherwise they become an unthrottled password oracle that bypasses this one (audit MEDIUM).
module.exports.isLoginLocked = isLoginLocked;
module.exports.recordLoginFail = recordLoginFail;
module.exports.clearLoginFails = clearLoginFails;
module.exports.resolveLockIdentifier = resolveLockIdentifier;
