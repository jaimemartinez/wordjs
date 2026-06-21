/**
 * WordJS - Auth Routes
 * /api/v1/auth/*
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate, generateToken, verifyToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { getOption } = require('../core/options');
const config = require('../config/app');

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
const _loginKey = (u) => String(u || '').trim().toLowerCase();

// Lazily-resolved shared store client (null on single-node or if Redis isn't configured).
function _lockStore() {
    try {
        const cache = require('../core/cache');
        return cache.getClient() || null;
    } catch {
        return null;
    }
}
const _failsRedisKey = (key) => `wjlock:fails:${key}`;
const _lockedRedisKey = (key) => `wjlock:locked:${key}`;

function _isLoginLockedMem(key) {
    const e = _loginFails.get(key);
    return !!(e && e.lockedUntil && e.lockedUntil > Date.now());
}

async function isLoginLocked(u) {
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

async function recordLoginFail(u) {
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

async function clearLoginFails(u) {
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
const COOKIE_OPTIONS = {
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
router.post('/register', asyncHandler(async (req, res) => {
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
router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username and password are required.',
            data: { status: 400 }
        });
    }

    if (await isLoginLocked(username)) {
        return res.status(429).json({
            code: 'rest_account_locked',
            message: 'Account temporarily locked due to too many failed attempts. Try again later.',
            data: { status: 429 }
        });
    }

    try {
        const user = await User.authenticate(username, password);
        await clearLoginFails(username);
        const token = generateToken(user);
        res.cookie('wordjs_token', token, COOKIE_OPTIONS);

        res.json({ user: user.toJSON() });
    } catch (error) {
        await recordLoginFail(username);
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
router.get('/me', authenticate, (req, res) => {
    res.json(req.user.toJSON());
});

/**
 * POST /auth/validate
 * Validate token
 */
router.post('/validate', authenticate, (req, res) => {
    res.json({
        valid: true,
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/refresh
 * Refresh token
 */
router.post('/refresh', authenticate, (req, res) => {
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
router.post('/logout', asyncHandler(async (req, res) => {
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

module.exports = router;
