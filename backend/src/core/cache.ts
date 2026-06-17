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
function setEnabled(val) {
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
            retryStrategy: (times) => {
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

        redis.on('error', (err) => {
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
async function get(key) {
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
async function set(key, value, ttl = 3600) {
    if (!redisAvailable || !enabledBySettings) return false;
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
async function del(key) {
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

/** The raw ioredis client (or null) — used to build a shared rate-limit store. */
function getClient(): any { return redisConfigured() ? redis : null; }

/** Publish a message to a channel. Returns false if Redis isn't available (caller stays in-process). */
async function publish(channel: string, payload: any): Promise<boolean> {
    if (!redis || !redisAvailable) return false;
    try {
        await redis.publish(channel, typeof payload === 'string' ? payload : JSON.stringify(payload));
        return true;
    } catch (e) {
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
            retryStrategy: (times) => Math.min(times * 200, 3000)
        });
        subscriber.on('message', (ch, msg) => {
            const hs = subHandlers.get(ch);
            if (hs) for (const h of hs) { try { h(msg); } catch (e: any) { console.warn('[Cache] sub handler error:', e && e.message); } }
        });
        subscriber.on('error', (e) => console.warn('[Cache] Subscriber error:', e.message));
    }
    subscriber.subscribe(channel).catch((e) => console.warn('[Cache] subscribe failed:', e.message));
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
    getClient
};
