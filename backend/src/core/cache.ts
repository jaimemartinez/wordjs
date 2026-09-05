/**
 * WordJS - Cache Engine
 *
 * Two tiers:
 *   L1 — in-process, always on. A default install (SQLite, no Redis) finally caches: without it
 *        every getOption()/hot read was a SELECT. Values are stored SERIALIZED so a caller can
 *        never mutate a cached object in place (the same deep-copy semantics Redis gives for free).
 *        Coherence: del() is called at every single write point (e.g. updateOption) and also
 *        broadcasts on 'wordjs:cache-del', so peer nodes drop their L1 too; when Redis is
 *        configured (multi-node possible) L1 entries additionally self-expire within 30s as the
 *        bound on any missed broadcast. Single-node keeps the caller's full TTL — in-process
 *        invalidation is complete.
 *   L2 — Redis, exactly as before: gated by config AND the admin's cache master switch
 *        (setEnabled). isAvailable() keeps meaning "Redis tier operational".
 */

const Redis = require('ioredis');
const config = require('../config/app');

/**
 * Cache state is derived from committed database state. During a pinned transaction every read must
 * bypass it (an L1 hit can be older than rows already changed by this transaction), and every write /
 * invalidation must wait for COMMIT. Dynamic require avoids a database→plugin-context→cache cycle at
 * module initialization.
 */
function deferUntilCommit(effect: () => any | Promise<any>): boolean {
    try { return require('../config/database').afterCommit(effect); }
    catch { return false; }
}

function transactionActive(): boolean {
    try { return require('../config/database').hasActiveTransaction(); }
    catch { return false; }
}

let redis: any = null;
let redisAvailable = false;
let enabledBySettings = false; // Master switch from DB settings (governs the REDIS tier)

// --- L1 (in-process) ------------------------------------------------------------------------------
const L1_MAX_ENTRIES = 2000;
const L1_REDIS_TTL_CAP_S = 30; // multi-node staleness bound when a broadcast is missed
const l1 = new Map<string, { s: string; exp: number }>();

function l1Get(key: string): string | null {
    const e = l1.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { l1.delete(key); return null; }
    l1.delete(key); l1.set(key, e); // LRU refresh
    return e.s;
}
function l1Set(key: string, serialized: string, ttlSeconds: number) {
    l1.delete(key);
    l1.set(key, { s: serialized, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
    if (l1.size > L1_MAX_ENTRIES) {
        const oldest = l1.keys().next().value;
        if (oldest !== undefined) l1.delete(oldest);
    }
}

/**
 * Update dynamic enablement state (called from options.js)
 */
function setEnabled(val: any) {
    if (deferUntilCommit(() => setEnabled(val))) return;
    enabledBySettings = (val === 1 || val === '1' || val === true);
    if (enabledBySettings && !redisAvailable && redis) {
        // If we are enabling but redis isn't "live" yet, it might be due to initial connection delay
        // but operations will check redisAvailable anyway.
    }
}

/**
 * Reconnection policy of the object-cache client — which is ALSO the cluster bus PUBLISHER.
 *
 * NEVER GIVES UP, and that is the whole point. This client stopped being "just the cache" the
 * moment it also became the publisher for coherence invalidation, notifications and the collab
 * realtime fan-out. It used to `return null` after 3 attempts, which makes ioredis stop reconnecting
 * FOR GOOD: a single Redis blip left `redisAvailable = false` forever. The cache survives that (it
 * falls back to the DB, as the old log line said) but the BUS HAS NO FALLBACK — cross-node realtime
 * stayed dead until someone restarted the process, and nothing said so.
 *
 * Reproduced on the multi-node lab (two backends + shared Postgres + shared Redis): stopping Redis
 * for 4s and starting it again left fan-out between replicas permanently broken — the editor on the
 * peer node never received another operation, and `⚡ Redis Object Cache Connected` appeared exactly
 * once, at boot. Same shape as `getClient()` below (the rate-limit store), and for the same reason.
 *
 * Exported as `_busRetryStrategy` so the "never returns null" contract has a test that fails if
 * anyone reintroduces a give-up branch.
 */
function busRetryStrategy(times: number): number {
    if (times === 4) {
        console.warn(
            '[Cache] Redis unreachable — the cache falls back to the DB, but the CLUSTER BUS ' +
            '(coherence, notifications, realtime fan-out) is DEGRADED until it reconnects. ' +
            'Retrying in the background.');
    }
    return Math.min(times * 200, 3000);
}

// Initialize Redis if enabled in config
if (config.redis && config.redis.enabled !== false) {
    try {
        redis = new Redis({
            host: config.redis.host || '127.0.0.1',
            port: config.redis.port || 6379,
            password: config.redis.password || undefined,
            db: config.redis.db || 0,
            retryStrategy: busRetryStrategy,
            // Fail FAST rather than queue: every caller (get/set/del/flush/publish) already catches
            // and falls back. With the offline queue those calls would instead hang waiting for a
            // reconnect, which is worse than an immediate, visible failure.
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1
        });

        // THIS LINE GOES TO STDERR, AND THE STREAM IS THE POINT — DO NOT "TIDY" IT BACK TO console.log.
        //
        // It is written from ioredis's 'connect' callback, i.e. from the event loop at whatever moment
        // the TCP handshake completes. Under node:test a test file runs in a CHILD PROCESS that reports
        // its results to the runner over STDOUT, V8-serialized: `FileTest.#processRawBuffer` reads
        // length-prefixed frames off that pipe. An asynchronous write into the same stream can land
        // INSIDE a frame, and the parent then throws
        //     Unable to deserialize cloned data due to invalid or unsupported version.
        // failing the whole FILE with no failed assertion in it. That is the F6 "Redis connected" flake
        // that has been red-lighting f6-plugin-compatibility.test.ts and F6-C05 on and off for weeks.
        //
        // Measured on linux/node 22, 20 runs of that suite per condition:
        //     Redis connected, this line on stdout ......... 6/20 FAILED
        //     …same, with --test-force-exit removed ........ 7/20 FAILED   (so force-exit is NOT the cause)
        //     Redis disabled ............................... 0/20
        //     Redis degraded (dead port: only the throttled
        //       console.warn below fires, already stderr) .. 0/20          (why CI's degraded leg is green)
        //     Redis connected, this line on stderr ......... 0/20 FAILED
        //
        // stderr is a separate pipe that carries no frames, so the message stays exactly as visible to
        // operators (docker, systemd and CI all capture both streams) while being unable to corrupt the
        // runner's channel. The same reasoning applies to any future ASYNCHRONOUS log in this module.
        redis.on('connect', () => {
            process.stderr.write('⚡ Redis Object Cache Connected\n');
            redisAvailable = true;
        });

        // Now that reconnection is unbounded, an outage emits one 'error' per attempt. Throttle the
        // line so a long outage degrades LOUDLY ONCE (and periodically) instead of drowning the log.
        let lastRedisErrorLog = 0;
        redis.on('error', (err: any) => {
            const now = Date.now();
            if (now - lastRedisErrorLog > 30_000) {
                lastRedisErrorLog = now;
                console.warn('[Cache] Redis Error:', err.message);
            }
            redisAvailable = false;
        });
    } catch (e) {
        console.error('[Cache] Failed to initialize Redis:', e.message);
    }
}

/**
 * Get a value from cache: L1 first (always on), then Redis (which repopulates L1).
 */
async function get(key: string) {
    if (transactionActive()) return null;
    const hit = l1Get(key);
    if (hit !== null) {
        try { return JSON.parse(hit); } catch { l1.delete(key); }
    }
    if (!redisAvailable || !enabledBySettings) return null;
    try {
        const val = await redis.get(key);
        if (!val) return null;
        // Redis is the shared truth in multi-node: front it briefly so a hot key skips the network
        // round-trip, bounded by the cap (a peer's del broadcast usually clears it much sooner).
        l1Set(key, val, L1_REDIS_TTL_CAP_S);
        return JSON.parse(val);
    } catch (e) {
        return null;
    }
}

/**
 * Set a value in cache (both tiers).
 */
async function set(key: string, value: any, ttl = 3600) {
    // getOption() serves `option:<name>` cache entries BEFORE the DB, so an in-process theme calling
    // require('core/cache').set('option:wordjs_user_roles', {v:{subscriber:{capabilities:['*']}}}) forges
    // the resolved value of any security-critical option = privilege escalation (#20). Core's own option
    // caching runs in a null context (getOption wraps its body in runWithContext(null)), so this only
    // blocks plugin/theme code writing the reserved `option:` namespace. Guard sits BEFORE both tiers.
    try {
        if (String(key).startsWith('option:') && require('./plugin-context').getEffectivePlugin()) {
            throw new Error('🛡️ Writing the option cache namespace is not permitted from plugin/theme context.');
        }
    } catch (e: any) {
        if (e && /not permitted/.test(String(e.message))) throw e; // re-throw our own denial; ignore require hiccups
    }
    if (deferUntilCommit(() => set(key, value, ttl))) return true;
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch (e) {
        return false;
    }
    // Multi-node (Redis configured): L1 is a short front, peers' del broadcasts + the cap keep it
    // honest. Single-node: the caller's TTL stands — every write path calls del(), so in-process
    // invalidation is complete.
    l1Set(key, serialized, redisConfigured() ? Math.min(ttl || L1_REDIS_TTL_CAP_S, L1_REDIS_TTL_CAP_S) : (ttl || 0));
    if (!redisAvailable || !enabledBySettings) return true;
    try {
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
 * Delete a value from cache — L1 (this node), the peers' L1 (broadcast), and Redis.
 */
async function del(key: string) {
    if (deferUntilCommit(() => del(key))) return true;
    l1.delete(key);
    if (redisConfigured()) publish('wordjs:cache-del', key).catch(() => { /* degraded — TTL cap bounds it */ });
    if (!redisAvailable || !enabledBySettings) return true;
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
    if (deferUntilCommit(() => flush())) return true;
    l1.clear();
    if (redisConfigured()) publish('wordjs:cache-del', '*').catch(() => { /* degraded */ });
    if (!redisAvailable || !enabledBySettings) return true;
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
const subHandlers = new Map<string, Set<(message: string) => void>>();

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
    if (deferUntilCommit(() => publish(channel, payload))) return true;
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

/**
 * Quit all Redis connections (object-cache, subscriber, rate-limit). For graceful shutdown / tests.
 *
 * `quit()` ALONE DOES NOT CLOSE THE SOCKET, and this function used to stop there. QUIT is a Redis
 * COMMAND, so ioredis has to send it: on a client that is still `connecting` — and these clients are
 * built with `enableOfflineQueue: false` precisely so nothing waits on a reconnect — the command is
 * rejected immediately instead of being queued. The rejection landed in the `catch` below, the loop
 * moved on, and the connection stayed open.
 *
 * That is not cosmetic. f6-plugin-compatibility.test.ts calls this in its `after()` hook so that its
 * process can END rather than be killed, and the hook did not achieve it: measured with
 * process.getActiveResourcesInfo(), TWO TCPSocketWrap handles were live before this call and the SAME
 * TWO after it, and the suite could not exit without `--test-force-exit` (it hung until killed). With
 * the disconnect below it exits on its own.
 *
 * THIS IS NOT THE FIX FOR THE F6 "Redis connected" FLAKE — the stream change on the 'connect' handler
 * above is. Measured, not assumed: the deserialize flake occurs at the same rate with and without this
 * disconnect (6/20 vs 3/12 runs), and it occurs with `--test-force-exit` REMOVED too (7/20), so "a child
 * killed mid-write by force-exit" was never the mechanism. Leaving a socket open is simply its own bug.
 *
 * `disconnect()` is not a command — it tears the socket down locally, whatever state it is in — so it
 * runs unconditionally after the graceful attempt. On a client that already quit it is a no-op.
 */
async function closeAll() {
    for (const c of [redis, subscriber, rateLimitClient]) {
        if (!c) continue;
        try { if (typeof c.quit === 'function') await c.quit(); } catch { /* already closing */ }
        try { if (typeof c.disconnect === 'function') c.disconnect(); } catch { /* already closed */ }
    }
}

// Peer L1 invalidation: any node's del()/flush() lands here on every other node (and echoes on the
// sender — an idempotent no-op). Only wired when Redis is configured; single-node in-process
// invalidation is already complete via the direct l1.delete in del().
if (redisConfigured()) {
    subscribe('wordjs:cache-del', (key: string) => {
        if (key === '*') l1.clear(); else l1.delete(key);
    });
}

module.exports = {
    get,
    set,
    del,
    flush,
    setEnabled,
    isAvailable: () => redisAvailable && enabledBySettings,
    // test/introspection hooks for the L1 tier (not a public API)
    _l1: { size: () => l1.size, clear: () => l1.clear() },
    // Test hook: the bus client's reconnection policy must never surrender (see busRetryStrategy).
    _busRetryStrategy: busRetryStrategy,
    // Multi-node primitives:
    publish,
    subscribe,
    pubsubAvailable,
    // "Is a cluster leg EXPECTED here?" — deliberately NOT the same question as pubsubAvailable()
    // ("is it up right now?"). Callers that must tell a single-node install (nothing to deliver
    // across) from a multi-node install whose bus is momentarily down (a delivery just FAILED) need
    // this one; conflating them turns an outage into silence. See core/collab-rooms.ts#broadcast.
    redisConfigured,
    getClient,
    closeAll
};
