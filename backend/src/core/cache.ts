/**
 * WordJS - Cache Engine
 * A Redis-backed object cache with automatic fallback to database.
 */

const Redis = require('ioredis');
const config = require('../config/app');

let redis: any = null;
let redisAvailable = false;
let enabledBySettings = false; // Master switch from DB settings

/**
 * Update dynamic enablement state (called from options.js)
 */
function setEnabled(val: any) {
    enabledBySettings = (val === 1 || val === '1' || val === true);
    if (enabledBySettings && !redisAvailable && redis) {
        // If we are enabling but redis isn't "live" yet, it might be due to initial connection delay
        // but operations will check redisAvailable anyway.
    }
}

// Initialize Redis if enabled in config
if (config.redis && config.redis.enabled !== false) {
    try {
        redis = new Redis({
            host: config.redis.host || '127.0.0.1',
            port: config.redis.port || 6379,
            password: config.redis.password || undefined,
            db: config.redis.db || 0,
            retryStrategy: (times: number) => {
                if (times > 3) {
                    console.warn('[Cache] Redis unavailable after 3 retries. Falling back to DB.');
                    redisAvailable = false;
                    return null; // Stop retrying
                }
                return Math.min(times * 100, 2000);
            }
        });

        redis.on('connect', () => {
            console.log('⚡ Redis Object Cache Connected');
            redisAvailable = true;
        });

        redis.on('error', (err: any) => {
            console.warn('[Cache] Redis Error:', err.message);
            redisAvailable = false;
        });
    } catch (e) {
        console.error('[Cache] Failed to initialize Redis:', e.message);
    }
}

/**
 * Get a value from cache
 */
async function get(key: string) {
    if (!redisAvailable || !enabledBySettings) return null;
    try {
        const val = await redis.get(key);
        if (!val) return null;
        return JSON.parse(val);
    } catch (e) {
        return null;
    }
}

/**
 * Set a value in cache
 */
async function set(key: string, value: any, ttl = 3600) {
    if (!redisAvailable || !enabledBySettings) return false;
    // getOption() serves `option:<name>` cache entries BEFORE the DB, so an in-process theme calling
    // require('core/cache').set('option:wordjs_user_roles', {v:{subscriber:{capabilities:['*']}}}) forges
    // the resolved value of any security-critical option = privilege escalation (#20). Core's own option
    // caching runs in a null context (getOption wraps its body in runWithContext(null)), so this only
    // blocks plugin/theme code writing the reserved `option:` namespace.
    try {
        if (String(key).startsWith('option:') && require('./plugin-context').getEffectivePlugin()) {
            throw new Error('🛡️ Writing the option cache namespace is not permitted from plugin/theme context.');
        }
    } catch (e: any) {
        if (e && /not permitted/.test(String(e.message))) throw e; // re-throw our own denial; ignore require hiccups
    }
    try {
        const serialized = JSON.stringify(value);
        if (ttl) {
            await redis.set(key, serialized, 'EX', ttl);
        } else {
            await redis.set(key, serialized);
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Delete a value from cache
 */
async function del(key: string) {
    if (!redisAvailable || !enabledBySettings) return false;
    try {
        await redis.del(key);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Flush all cache (careful!)
 */
async function flush() {
    if (!redisAvailable || !enabledBySettings) return false;
    try {
        await redis.flushdb();
        return true;
    } catch (e) {
        return false;
    }
}

// --- Cross-node pub/sub (cluster coherence + SSE fan-out) -----------------------------------------
// Uses a DEDICATED subscriber connection — ioredis puts a subscribed connection into a mode where it
// can't run normal commands, so the publisher (the main `redis` client) and subscriber must differ.
// Gated on Redis being CONFIGURED, INDEPENDENT of the object-cache master switch (enabledBySettings):
// coherence/realtime must work across nodes even when the object cache is turned off.
let subscriber: any = null;
const subHandlers = new Map<string, Set<Function>>();

function redisConfigured(): boolean { return !!(config.redis && config.redis.enabled !== false); }

/** True when cross-node pub/sub is usable (Redis configured AND the connection is up). */
function pubsubAvailable(): boolean { return redisConfigured() && redisAvailable; }

// A DEDICATED client for the shared rate-limit store. NOT the object-cache client, whose
// retryStrategy gives up after 3 attempts (fine for a cache that falls back to the DB, but it would
// permanently brick the limiter store). This one self-heals (unbounded backoff) and fails fast per
// request (no offline queue) so a Redis outage degrades quickly via the limiter's passOnStoreError.
let rateLimitClient: any = null;
function getClient(): any {
    if (!redisConfigured()) return null;
    if (!rateLimitClient) {
        rateLimitClient = new Redis({
            host: config.redis.host || '127.0.0.1',
            port: config.redis.port || 6379,
            password: config.redis.password || undefined,
            db: config.redis.db || 0,
            retryStrategy: (times: number) => Math.min(times * 200, 3000), // never gives up → self-heals
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false
        });
        rateLimitClient.on('error', () => { /* degrade silently; the limiter's passOnStoreError handles it */ });
    }
    return rateLimitClient;
}

/** Publish a message to a channel. Returns false if Redis isn't available (caller stays in-process). */
async function publish(channel: string, payload: any): Promise<boolean> {
    if (!redis || !redisAvailable) {
        // Only warn when Redis is CONFIGURED (multi-node expected) but currently down: a missed
        // publish means cross-node coherence is degraded (e.g. a role revocation won't reach other
        // nodes until their TTL fallback re-reads). Single-node installs (Redis not configured) skip
        // pub/sub by design — no warning there to avoid log spam.
        if (redisConfigured()) {
            console.warn(`[Cache] publish('${channel}') skipped: Redis unavailable — cross-node coherence DEGRADED until reconnect (state self-heals within the roles-cache TTL).`);
        }
        return false;
    }
    try {
        await redis.publish(channel, typeof payload === 'string' ? payload : JSON.stringify(payload));
        return true;
    } catch (e: any) {
        console.warn(`[Cache] publish('${channel}') failed: ${e && e.message} — cross-node coherence DEGRADED for this event.`);
        return false;
    }
}

/** Subscribe a handler to a channel. No-op when Redis isn't configured (single-node keeps in-process behavior). */
function subscribe(channel: string, handler: (message: string) => void): void {
    if (!redisConfigured()) return;
    if (!subHandlers.has(channel)) subHandlers.set(channel, new Set());
    subHandlers.get(channel)!.add(handler);
    if (!subscriber) {
        subscriber = new Redis({
            host: config.redis.host || '127.0.0.1',
            port: config.redis.port || 6379,
            password: config.redis.password || undefined,
            db: config.redis.db || 0,
            retryStrategy: (times: number) => Math.min(times * 200, 3000)
        });
        subscriber.on('message', (ch: string, msg: string) => {
            const hs = subHandlers.get(ch);
            if (hs) for (const h of hs) { try { h(msg); } catch (e: any) { console.warn('[Cache] sub handler error:', e && e.message); } }
        });
        subscriber.on('error', (e: any) => console.warn('[Cache] Subscriber error:', e.message));
    }
    subscriber.subscribe(channel).catch((e: any) => console.warn('[Cache] subscribe failed:', e.message));
}

/** Quit all Redis connections (object-cache, subscriber, rate-limit). For graceful shutdown / tests. */
async function closeAll() {
    for (const c of [redis, subscriber, rateLimitClient]) {
        try { if (c && typeof c.quit === 'function') await c.quit(); } catch { /* already closing */ }
    }
}

module.exports = {
    get,
    set,
    del,
    flush,
    setEnabled,
    isAvailable: () => redisAvailable && enabledBySettings,
    // Multi-node primitives:
    publish,
    subscribe,
    pubsubAvailable,
    getClient,
    closeAll
};
