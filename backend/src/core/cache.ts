/**
 * WordJS - Cache Engine
 * A Redis-backed object cache with automatic fallback to database.
 */

const Redis = require('ioredis');
const config = require('../config/app');

let redis = null;
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

module.exports = {
    get,
    set,
    del,
    flush,
    setEnabled,
    isAvailable: () => redisAvailable && enabledBySettings
};
