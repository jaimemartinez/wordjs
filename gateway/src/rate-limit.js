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
 * The caller passes the client address the gateway believes: with a trusted proxy that is the address
 * resolved through the trusted hops (the same one req.ip uses), so each visitor behind it has its own
 * budget. With NO trusted proxy the address is the socket peer, and a CDN or reverse proxy in front of
 * the gateway makes every visitor the same peer. The caller then also passes the left-most
 * X-Forwarded-For entry (`forwarded`). It is not believed as an identity — anyone can write it — but it
 * is used two ways that a forger cannot turn into more than a bounded allowance:
 *   • each (peer, forwarded) pair gets the per-client cap, so one busy visitor behind a shared proxy
 *     cannot use up everyone's budget;
 *   • the peer's total cap grows with the number of distinct forwarded clients seen from it in the
 *     window, up to `upgradeSharedMultiplier` × the per-client cap. A real proxy carrying many visitors
 *     gets room for their collaboration, presence and HMR sockets instead of locking the site out; a
 *     client forging the header gains at most that multiplier.
 * `onShared(peer, distinct)` is called (once per peer per window) when a peer crosses
 * `sharedThreshold` distinct forwarded clients, so the gateway can tell the operator to trust the proxy.
 *
 * Config (optional): config.rateLimit.upgradeWindowMs (default 60000), config.rateLimit.upgradeMax
 * (default 120 per window — far above what a page's live-reload, collaboration and presence sockets
 * reconnect at, while bounding a flood), config.rateLimit.upgradeSharedMultiplier (default 20).
 */
function createUpgradeLimiter(config, { onShared, sharedThreshold = 5 } = {}) {
    const rl = (config && config.rateLimit) || {};
    const windowMs = Number(rl.upgradeWindowMs) > 0 ? Number(rl.upgradeWindowMs) : 60 * 1000;
    const max = Number(rl.upgradeMax) > 0 ? Number(rl.upgradeMax) : 120;
    const multiplier = Number(rl.upgradeSharedMultiplier) >= 1 ? Math.floor(Number(rl.upgradeSharedMultiplier)) : 20;
    let windowStart = Date.now();
    let totals = new Map();   // peer -> upgrades this window
    let pairs = new Map();    // peer + forwarded client -> upgrades this window
    let distinct = new Map(); // peer -> Set of forwarded clients (at most `multiplier` kept)
    let reported = new Set();
    return {
        /**
         * True when this client may open another upgrade in the current window. `forwarded` is only
         * passed when no proxy is trusted (see above); with a trusted proxy `client` is already the visitor.
         */
        allow(client, forwarded) {
            const now = Date.now();
            if (now - windowStart >= windowMs) {
                windowStart = now;
                totals = new Map(); pairs = new Map(); distinct = new Map(); reported = new Set();
            }
            const peer = String(client || 'unknown');
            const fwd = forwarded ? String(forwarded) : '';
            let seen = distinct.get(peer);
            if (fwd && fwd !== peer) {
                if (!seen) { seen = new Set(); distinct.set(peer, seen); }
                if (seen.size < multiplier) seen.add(fwd);
                if (seen.size >= sharedThreshold && !reported.has(peer)) {
                    reported.add(peer);
                    if (onShared) { try { onShared(peer, seen.size); } catch (e) { /* a log hook never blocks the cap */ } }
                }
            }
            const cap = max * Math.max(1, seen ? seen.size : 1);
            const total = (totals.get(peer) || 0) + 1;
            if (total > cap) return false;
            const pairKey = `${peer} ${fwd}`;
            const n = (pairs.get(pairKey) || 0) + 1;
            if (n > max) return false;
            totals.set(peer, total);
            pairs.set(pairKey, n);
            return true;
        },
    };
}

module.exports = { createPublicLimiter, createUpgradeLimiter, limiterStore };
