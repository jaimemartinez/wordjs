/**
 * WordJS — Distributed lock (multi-node coordination).
 *
 * A small, dependency-free lease lock used to coordinate N backend replicas that share ONE Postgres
 * database. It is backed by a `wordjs_locks` table and an atomic compare-and-set UPDATE, so it is
 * POOL-SAFE (no reliance on a session-pinned connection, unlike pg_advisory_lock) and uses the DB's
 * own clock for expiry (immune to per-node clock skew).
 *
 * SQLite drivers are single-host by construction, so there is never cross-process contention there —
 * every operation is a no-op that "succeeds", which keeps single-node behavior identical.
 *
 * Correctness properties:
 *  - HOLDER is unique PER PROCESS (host:pid:random) so two replicas can never collide on identity —
 *    release()/CAS are holder-guarded, so a node can only ever free its OWN lease.
 *  - Held locks HEARTBEAT (renew the lease on an interval) so a long critical section (a slow
 *    migration, a big backup, a slow ACME challenge) is never preempted by lease expiry. A crashed
 *    holder's process dies with its renew timer, so the lease expires within ~ttl and another node
 *    reclaims it — no permanent deadlock.
 *
 * Used for:
 *  - 'wordjs:boot'  — serialize schema-migration + default seeding so concurrent boots don't
 *                     double-apply migrations or create duplicate admin/category/options.
 *  - 'wordjs:cron'  — single-runner cron, so a due event (backup, ACME renewal, …) fires on exactly
 *                     one node instead of every node (duplicate backups / Let's Encrypt orders).
 */

const os = require('os');
const crypto = require('crypto');

// Unique identity for THIS process across the cluster (host:pid alone collides under containers).
const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

function isPg(): boolean {
    try { return require('../config/database').getDbType().isPostgres === true; }
    catch { return false; }
}
function db(): any { return require('../config/database').dbAsync; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every lease THIS process currently holds, with its heartbeat timer.
 *
 * A lease is freed ONLY by an explicit release(): HOLDER is unique per process, release()/CAS are
 * holder-guarded, and tryAcquire only claims a row whose locked_until is already in the past. So a
 * process that exits WITHOUT releasing strands each of its leases for up to that lease's ttlMs — and
 * its successor, which has a brand-new HOLDER, cannot free them either. At the plugin-op lease's 120s
 * TTL that means a plain `systemctl restart` / `docker restart` / `pm2 reload` during a plugin update
 * leaves the next boot unable to touch the very plugin it was mid-swap on, with a "running elsewhere"
 * message that is not true. releaseAllHeld({ only }) is what the shutdown handler calls to give back the
 * ones whose critical section it has confirmed is over — see that function for why `only` is required.
 */
const heldLocks = new Map<string, NodeJS.Timeout>();

// Postgres "now" in epoch-milliseconds, computed server-side so all nodes compare against one clock.
const NOW_MS = `(EXTRACT(EPOCH FROM now())*1000)::bigint`;

type LockHandle = { held: boolean; release: () => Promise<void> };

/**
 * Create the lock table. Must run BEFORE the first acquire (the boot lock cannot live in a table
 * that is created during the very boot it guards). No-op on SQLite.
 */
async function ensureLockTable(): Promise<void> {
    if (!isPg()) return;
    try {
        await db().exec(
            'CREATE TABLE IF NOT EXISTS wordjs_locks (' +
            'lock_name TEXT PRIMARY KEY, holder TEXT, locked_until BIGINT NOT NULL DEFAULT 0)'
        );
    } catch (e: any) {
        // Concurrent CREATE TABLE IF NOT EXISTS can rarely race on Postgres — harmless to ignore.
        console.warn('[dist-lock] ensureLockTable:', e && e.message);
    }
}

/**
 * Try to acquire `name` for `ttlMs`. Returns true if THIS node now holds it. Non-blocking.
 * On SQLite, always true (single host).
 */
async function tryAcquire(name: string, ttlMs = 60000): Promise<boolean> {
    if (!isPg()) return true;
    const d = db();
    // Ensure a row exists (free) without clobbering a live lease.
    await d.run(
        'INSERT INTO wordjs_locks (lock_name, holder, locked_until) VALUES (?, ?, 0) ON CONFLICT (lock_name) DO NOTHING',
        [name, HOLDER]
    );
    // Atomic claim: only succeeds if the current lease has expired (or is free). DB-clock based.
    const res = await d.run(
        `UPDATE wordjs_locks SET holder = ?, locked_until = ${NOW_MS} + ? WHERE lock_name = ? AND locked_until < ${NOW_MS}`,
        [HOLDER, ttlMs, name]
    );
    return !!(res && (res.changes || 0) > 0);
}

/**
 * Extend a lease we still hold (heartbeat). Returns false if we no longer hold it (e.g. it expired
 * and was reclaimed) — callers may use that to abort. No-op true on SQLite.
 */
async function renew(name: string, ttlMs: number): Promise<boolean> {
    if (!isPg()) return true;
    try {
        const res = await db().run(
            `UPDATE wordjs_locks SET locked_until = ${NOW_MS} + ? WHERE lock_name = ? AND holder = ?`,
            [ttlMs, name, HOLDER]
        );
        return !!(res && (res.changes || 0) > 0);
    } catch (e: any) {
        console.warn('[dist-lock] renew:', e && e.message);
        return false;
    }
}

/**
 * Release a lock we hold (only clears it if we are still the recorded holder). No-op on SQLite.
 */
async function release(name: string): Promise<void> {
    if (!isPg()) return;
    try {
        await db().run('UPDATE wordjs_locks SET locked_until = 0 WHERE lock_name = ? AND holder = ?', [name, HOLDER]);
    } catch (e: any) {
        console.warn('[dist-lock] release:', e && e.message);
    }
}

function startHeartbeat(name: string, ttlMs: number, renewMs: number): NodeJS.Timeout {
    const timer = setInterval(() => { renew(name, ttlMs).catch(() => { }); }, renewMs);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    return timer;
}

/**
 * Blocking acquire with a heartbeat. Polls until won or `timeoutMs` elapses. Returns a handle whose
 * release() stops the heartbeat AND frees the lease. If not acquired within the timeout, returns
 * { held:false } so the caller can FAIL CLOSED (boot) rather than proceed unguarded. No-op-held on SQLite.
 */
async function acquireBlocking(
    name: string,
    opts: { ttlMs?: number; renewMs?: number; timeoutMs?: number; pollMs?: number } = {}
): Promise<LockHandle> {
    const ttlMs = opts.ttlMs ?? 60000;
    const renewMs = opts.renewMs ?? Math.max(5000, Math.floor(ttlMs / 3));
    const timeoutMs = opts.timeoutMs ?? 120000;
    const pollMs = opts.pollMs ?? 500;
    const noop: LockHandle = { held: true, release: async () => { } };
    if (!isPg()) return noop;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await tryAcquire(name, ttlMs)) {
            const timer = startHeartbeat(name, ttlMs, renewMs);
            heldLocks.set(name, timer);
            return {
                held: true,
                release: async () => { clearInterval(timer); heldLocks.delete(name); await release(name); },
            };
        }
        await sleep(pollMs);
    }
    console.warn(`[dist-lock] '${name}' acquire timed out after ${timeoutMs}ms.`);
    return { held: false, release: async () => { } };
}

/**
 * Run `fn` only if THIS node wins `name` this round; otherwise skip (another node is the leader).
 * Heartbeats the lease for the whole run, then always releases. On SQLite, always runs `fn`.
 */
async function runAsLeader<T>(
    name: string,
    opts: { ttlMs?: number; renewMs?: number },
    fn: () => Promise<T>
): Promise<T | undefined> {
    if (!isPg()) return fn();
    const ttlMs = opts.ttlMs ?? 90000;
    const renewMs = opts.renewMs ?? Math.max(5000, Math.floor(ttlMs / 3));
    if (!(await tryAcquire(name, ttlMs))) return undefined;
    const timer = startHeartbeat(name, ttlMs, renewMs);
    heldLocks.set(name, timer);
    try { return await fn(); }
    finally { clearInterval(timer); heldLocks.delete(name); await release(name); }
}

/**
 * Hand leases this process still holds back to the cluster. Called from the graceful-shutdown handler
 * (SIGTERM / SIGINT) so a planned restart does not strand a lease for its whole TTL — see heldLocks.
 *
 * Best-effort and bounded by design: it is running while the process is on its way out, so a failure
 * to reach the DB just falls back to the TTL, exactly as an abrupt kill would. Returns the names it
 * tried to free (used by the tests and to log what was given back).
 *
 * `only` IS THE SAFE WAY TO CALL THIS AT SHUTDOWN, and the reason is the invariant above: a lease is in
 * this map EXACTLY WHILE ITS CRITICAL SECTION IS RUNNING — the handle deletes it on release, runAsLeader
 * in its `finally`. So an unreviewed sweep hands back precisely the leases still IN USE: it can free
 * 'wordjs:active-plugins' in the middle of activatePlugin's read-modify-write of the option, or
 * 'wordjs:cron' while this node's backup or ACME renewal is running, letting a peer start the same work
 * concurrently. A caller must therefore name the leases whose critical sections it has CONFIRMED are
 * finished (the shutdown handler drains the plugin operations and then names those); everything it does
 * not name keeps its registration and heartbeat and expires on its TTL, exactly as after an abrupt kill.
 * A predicate that throws fails CLOSED — unconfirmed means not released.
 *
 * With no argument every held lease is released. That is for tests and for teardown paths that own the
 * whole process; do NOT use it from a signal handler.
 */
async function releaseAllHeld(opts: { only?: (name: string) => boolean } = {}): Promise<string[]> {
    const only = opts.only;
    const names = Array.from(heldLocks.keys()).filter((n) => {
        if (!only) return true;
        try { return only(n) === true; } catch { return false; } // unconfirmed ⇒ leave it to the TTL
    });
    for (const n of names) {
        const timer = heldLocks.get(n);
        if (timer) clearInterval(timer);
        heldLocks.delete(n);
    }
    if (names.length === 0) return names;
    await Promise.all(names.map((n) => release(n)));
    return names;
}

/** Names of the leases this process currently holds (diagnostics + tests). */
function heldLockNames(): string[] { return Array.from(heldLocks.keys()); }

module.exports = { HOLDER, ensureLockTable, tryAcquire, renew, release, acquireBlocking, runAsLeader, releaseAllHeld, heldLockNames };
