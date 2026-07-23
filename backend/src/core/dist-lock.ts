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

// A lock NAME can carry request-derived data ('wordjs:plugin-op:<slug>'), so strip line breaks before
// it reaches a log line — otherwise a crafted slug forges or splits entries in the operator's log.
//
// TWO single-constant replacements, each replacing with the empty string, is deliberate and must stay
// that way: the log-injection analysis recognises a sanitizer SYNTACTICALLY, and the equivalent
// `/\n|\r/g` this first carried was not matched (an alternation has no constant value), so every call
// site still reported an unsanitized log entry. Match the documented remediation shape, not an
// equivalent of it.
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

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
 * message that is not true.
 *
 * WHAT THIS MAP IS NOT: the list of leases a shutdown should hand back. A name is removed here in the
 * same synchronous step that STARTS the DB release, so an operation only ever counts as finished after
 * its name is already gone — which is why a shutdown sweep keyed on this map (releaseAllHeld({ only }),
 * as index.ts once called it) could never release anything. The graceful shutdown therefore keeps its
 * own record of the plugin-op leases it has not confirmed releasing (routes/plugins) and never consults
 * this map, which also means it cannot reach 'wordjs:active-plugins' or 'wordjs:cron'. This map is a
 * "critical section is executing here" registry, used for the heartbeat and for whole-process teardown.
 */
const heldLocks = new Map<string, NodeJS.Timeout>();

// Postgres "now" in epoch-milliseconds, computed server-side so all nodes compare against one clock.
const NOW_MS = `(EXTRACT(EPOCH FROM now())*1000)::bigint`;

// release() reports whether the hand-back reached the DB, so a caller that must not lose the lease can
// keep its own record open and retry (see release() and routes/plugins' unreleasedOpLeases).
type LockHandle = { held: boolean; release: () => Promise<boolean> };

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
 *
 * Returns whether the hand-back actually REACHED THE DATABASE. It used to swallow the failure and
 * return void, which made an unreachable DB indistinguishable from a successful release for every
 * caller — so a lease that was still ours after a failed UPDATE looked handed back, and nothing
 * retried it: the successor stayed locked out for the full TTL. The caller that cares
 * (routes/plugins' plugin-operation lease) keeps its record open on false and retries at shutdown.
 * Still non-throwing: a release is best-effort by design and must never break a `finally`.
 */
async function release(name: string): Promise<boolean> {
    if (!isPg()) return true; // single host — there is no lease to hand back
    try {
        await db().run('UPDATE wordjs_locks SET locked_until = 0 WHERE lock_name = ? AND holder = ?', [name, HOLDER]);
        return true;
    } catch (e: any) {
        console.warn('[dist-lock] release:', e && e.message);
        return false;
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
    const noop: LockHandle = { held: true, release: async () => true };
    if (!isPg()) return noop;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await tryAcquire(name, ttlMs)) {
            const timer = startHeartbeat(name, ttlMs, renewMs);
            heldLocks.set(name, timer);
            return {
                held: true,
                release: async () => { clearInterval(timer); heldLocks.delete(name); return release(name); },
            };
        }
        await sleep(pollMs);
    }
    console.warn(`[dist-lock] '${logSafe(name)}' acquire timed out after ${timeoutMs}ms.`);
    return { held: false, release: async () => true };
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
 * Hand leases this process still holds back to the cluster. Returns the names it tried to free.
 *
 * NOT A SIGNAL-HANDLER API. Every lease in this map is one whose critical section is still RUNNING
 * (see heldLocks), so a sweep over it — with or without a filter — hands back leases that are in use:
 * 'wordjs:active-plugins' in the middle of activatePlugin's read-modify-write of the option, or
 * 'wordjs:cron' while this node's backup or ACME renewal is running, letting a peer start the same work
 * concurrently. Use it only from a test or a teardown path that owns the whole process. The graceful
 * shutdown releases plugin-op leases through routes/plugins.releaseFinishedOpLeases instead, which
 * cannot name any other lease.
 *
 * `only` narrows the sweep to the names a caller has CONFIRMED are finished; everything it does not
 * name keeps its registration and heartbeat and expires on its TTL. A predicate that throws fails
 * CLOSED — unconfirmed means not released. Best-effort: a DB failure just falls back to the TTL.
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
