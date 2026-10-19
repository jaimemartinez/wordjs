/**
 * WordJS Gateway — rate limiter for the PUBLIC listener.
 *
 * WHY THIS EXISTS (audit 2026-08-08, P1): the gateway is the internet-facing edge, but only the
 * token-enrollment listener was rate limited. The real per-IP limits live in the backend, so anything
 * the gateway answers or proxies at the edge — and any burst that never reaches a registered upstream —
 * was unbounded. This mirrors the backend's limiter (express-rate-limit, same config shape) so the edge
 * has its own coarse cap.
 *
 * FAIL-OPEN ON STORE LOSS is the established, deliberate choice (see the backend's passOnStoreError):
 * a limiter-store outage must never take the edge down. Unlike the backend we LOG the degradation — a
 * silent fail-open is how "the limiter quietly stopped limiting" hides. The limiter keys on req.ip. With
 * no `trustProxy` (gateway-config.json) / WORDJS_TRUST_PROXY, `trust proxy` stays false and req.ip is the
 * socket peer: a client cannot forge X-Forwarded-For to rotate past this cap. An operator who fronts the
 * gateway with their own proxy sets one of them (src/runtime-settings.js) and is responsible for that hop;
 * without it every visitor behind that proxy shares its bucket.
 */

const rateLimit = require('express-rate-limit');

/**
 * Build a shared store when a Redis endpoint is configured, else undefined (per-process MemoryStore).
 * Any failure to construct it LOGS and falls back — the limiter still runs, just per-process.
 */
function limiterStore(config, logger, prefix) {
    const rc = config && config.redis;
    if (!rc || rc.enabled === false || !rc.host) return undefined; // no shared store configured
    try {
        const Redis = require('ioredis');
        const { RedisStore } = require('rate-limit-redis');
        const client = new Redis({
            host: rc.host,
            port: rc.port || 6379,
            password: rc.password || undefined,
            db: rc.db || 0,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
        });
        let loggedDown = false;
        client.on('error', (e) => {
            // Per-request failures fail open via passOnStoreError; log the FIRST error of an outage so
            // the deliberate fail-open is visible instead of silent, without flooding on every retry.
            if (!loggedDown) {
                loggedDown = true;
                (logger && logger.warn ? logger.warn.bind(logger) : console.warn)(
                    `[Gateway] public rate-limit Redis store error — failing OPEN (limit not enforced until it recovers): ${e && e.message}`
                );
            }
        });
        client.on('ready', () => { loggedDown = false; });
        return new RedisStore({ sendCommand: (...args) => client.call(...args), prefix: prefix || 'gwrl:pub:' });
    } catch (e) {
        (logger && logger.warn ? logger.warn.bind(logger) : console.warn)(
            `[Gateway] public rate-limit Redis store unavailable, using in-memory: ${e && e.message}`
        );
        return undefined;
    }
}

/**
 * Create the public-listener limiter. Config shape (all optional) mirrors the backend:
 *   config.rateLimit.windowMs (default 60000), config.rateLimit.max (default 1000).
 * The cap must be generous — the edge proxies whole page loads (HTML + every asset) per client — while
 * still bounding an abusive flood. Health probes are exempt so infra liveness checks are never throttled.
 */
function createPublicLimiter(config, logger) {
    const rl = (config && config.rateLimit) || {};
    const windowMs = Number(rl.windowMs) > 0 ? Number(rl.windowMs) : 60 * 1000;
    const max = Number(rl.max) > 0 ? Number(rl.max) : 1000;
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        store: limiterStore(config, logger, 'gwrl:pub:'),
        passOnStoreError: true, // fail-open: a store outage must not take the edge down (logged above)
        skip: (req) => {
            const p = (req.url || '/').split('?')[0];
            return p === '/healthz' || p === '/readyz';
        },
        message: { error: 'Too many requests, please try again later.' },
    });
}

/**
 * Per-client cap for WebSocket upgrades. `server.on('upgrade')` never runs the Express chain, so the
 * public limiter above does not see an upgrade at all, and each accepted upgrade holds an upstream
 * socket open. This is a fixed-window counter per client address, kept in process memory (an upgrade
 * is a long-lived connection to THIS process, so a per-process budget is the meaningful one).
 *
 * Config (optional): config.rateLimit.upgradeWindowMs (default 60000), config.rateLimit.upgradeMax
 * (default 120 per window — far above what a page's live-reload, collaboration and presence sockets
 * reconnect at, while bounding a flood).
 */
function createUpgradeLimiter(config) {
    const rl = (config && config.rateLimit) || {};
    const windowMs = Number(rl.upgradeWindowMs) > 0 ? Number(rl.upgradeWindowMs) : 60 * 1000;
    const max = Number(rl.upgradeMax) > 0 ? Number(rl.upgradeMax) : 120;
    let windowStart = Date.now();
    let counts = new Map();
    return {
        /** True when this client may open another upgrade in the current window. */
        allow(client) {
            const now = Date.now();
            if (now - windowStart >= windowMs) { windowStart = now; counts = new Map(); }
            const key = String(client || 'unknown');
            const n = (counts.get(key) || 0) + 1;
            counts.set(key, n);
            return n <= max;
        },
    };
}

module.exports = { createPublicLimiter, createUpgradeLimiter, limiterStore };
