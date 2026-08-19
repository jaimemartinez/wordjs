/**
 * WordJS — Distributed lock (multi-node coordination).
 *
 * A small, dependency-free lease lock used to coordinate N backend replicas that share ONE network
 * database. It is backed by a `wordjs_locks` table and an atomic compare-and-set UPDATE, so it is
 * POOL-SAFE (no reliance on a session-pinned connection, unlike pg_advisory_lock) and uses the DB's
 * own clock for expiry (immune to per-node clock skew).
 *
 * WHICH ENGINES, AND WHY THE QUESTION IS NOT "IS IT POSTGRES?". This module was written when the only
 * network engine was Postgres, so its gate was `isPg()` and every primitive answered "granted" on
 * anything else, reasoning that "SQLite drivers are single-host by construction". Since drivers/mysql.ts
 * exists that premise is false, and the gate was answering the WRONG QUESTION: "not Postgres" was read
 * as "no lock needed" when the truth was "the lock is not implemented here" — `NOW_MS` was
 * Postgres-only syntax and `ensureLockTable` did not even create the table. With `dbDriver: 'mysql'`
 * and two replicas that silent fail-open meant both nodes seeding the database at once, cron running
 * on every node (duplicate backups, N simultaneous ACME orders — which gets the domain rate-limited)
 * and a lost update on every `active_plugins` read-modify-write.
 *
 * So the gate is now THREE answers, not two (see `lockMode`):
 *   · 'postgres' / 'mysql' — SHARED network engine: a real lease, same CAS, only the clock dialect
 *     differs. MySQL/MariaDB need no other translation: drivers/mysql.ts already maps
 *     `ON CONFLICT … DO NOTHING` → `INSERT IGNORE` and `TEXT PRIMARY KEY` → `VARCHAR(255)`.
 *   · 'single-host' — a SQLite file: there is genuinely no cross-process contention, so every
 *     operation is a no-op that "succeeds" and single-node behavior is identical.
 *   · 'unsupported' — anything else (an engine we cannot lock on). FAIL CLOSED: `acquireBlocking`
 *     returns `{held:false}` and `runAsLeader` skips, which is what index.ts/plugins.ts already know
 *     how to handle. Lying with "granted" is the one answer that corrupts data.
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
// `/\n|\r/g` is not matched (an alternation has no constant value), so every call site would still be
// reported as an unsanitized log entry. Match the documented remediation shape, not an equivalent.
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

type LockMode = 'postgres' | 'mysql' | 'single-host' | 'unsupported';

/**
 * WHICH LOCK IMPLEMENTATION APPLIES TO THE ACTIVE DRIVER.
 *
 * Deliberately NOT `getDbType().isSQLite`: that flag is `!isPostgres`, so it is TRUE for MySQL —
 * asking it here is how "not Postgres" turned into "single host". The engine family is read from the
 * driver NAME, and an engine this module has no implementation for is `unsupported`, never
 * `single-host`. If the DB config cannot even be read we also answer `unsupported`: not knowing which
 * engine we are on is not evidence that we are alone on it.
 */
function lockMode(): LockMode {
    let t: any;
    try { t = require('../config/database').getDbType(); }
    catch { return 'unsupported'; }
    if (t && t.isPostgres === true) return 'postgres';
    if (t && t.isMySQL === true) return 'mysql';
    return /^sqlite/.test(String((t && t.driver) || '')) ? 'single-host' : 'unsupported';
}

function db(): any { return require('../config/database').dbAsync; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Now" in epoch-MILLISECONDS computed SERVER-SIDE, so every node compares against one clock instead
 * of its own (the whole point of a DB-backed lease). This is the only dialect-specific piece of the
 * lock: `EXTRACT(EPOCH …)` does not exist in MySQL, and `UNIX_TIMESTAMP(NOW(3))` returns a DECIMAL,
 * so it is CAST to an integer to match the BIGINT column exactly rather than relying on implicit
 * rounding at comparison time.
 */
const NOW_MS_BY_MODE: Record<'postgres' | 'mysql', string> = {
    postgres: `(EXTRACT(EPOCH FROM now())*1000)::bigint`,
    mysql: `CAST(UNIX_TIMESTAMP(NOW(3))*1000 AS SIGNED)`,
};

type LockHandle = { held: boolean; release: () => Promise<void> };

/**
 * WHICH ENGINE THE TABLE HAS ALREADY BEEN CREATED FOR, IN THIS PROCESS.
 *
 * `ensureLockTable()` has exactly one caller, at boot (index.ts), and at boot a fresh install is
 * still on `sqlite-native` — so it returns early and creates nothing. The setup wizard then switches
 * the engine IN-PROCESS (`routes/setup.ts` calls `init({driver:'mysql'})` + `initializeDatabase()`)
 * and there is no restart: from that instant `lockMode()` answers 'mysql', the primitives are REAL,
 * and they are talking to a table that does not exist. So the engine this DDL was run for is state
 * that has to be REMEMBERED, not assumed — the mode can change under our feet.
 *
 * The failure timestamp throttles the retry: if the DDL itself cannot run (no CREATE grant), retrying
 * it on every acquire would add a failed statement to every cron tick.
 */
let lockTableMode: LockMode | null = null;
let lockTableFailedAt = 0;
const LOCK_TABLE_RETRY_MS = 30_000;

/**
 * Create the lock table. Must run BEFORE the first acquire (the boot lock cannot live in a table
 * that is created during the very boot it guards). No-op when there is no lease to keep.
 *
 * The DDL is written ONCE, in the SQLite dialect the rest of core writes: drivers/mysql.ts
 * translates `lock_name TEXT PRIMARY KEY` into `VARCHAR(255) PRIMARY KEY` (MySQL cannot index a
 * TEXT key without a prefix length) and leaves the BIGINT alone. Spelling a second CREATE TABLE by
 * hand for MySQL is exactly the drift this project keeps paying for.
 */
async function ensureLockTable(): Promise<void> {
    const mode = lockMode();
    if (mode !== 'postgres' && mode !== 'mysql') return;
    try {
        await db().exec(
            'CREATE TABLE IF NOT EXISTS wordjs_locks (' +
            'lock_name TEXT PRIMARY KEY, holder TEXT, locked_until BIGINT NOT NULL DEFAULT 0)'
        );
        lockTableMode = mode;
        lockTableFailedAt = 0;
    } catch (e: any) {
        // Concurrent CREATE TABLE IF NOT EXISTS can rarely race — harmless to ignore.
        lockTableFailedAt = Date.now();
        console.warn('[dist-lock] ensureLockTable:', e && e.message);
    }
}

/** The DDL, run at most once per engine (and at most once per `LOCK_TABLE_RETRY_MS` while failing). */
async function ensureLockTableFor(mode: 'postgres' | 'mysql'): Promise<void> {
    if (lockTableMode === mode) return;
    if (lockTableFailedAt && Date.now() - lockTableFailedAt < LOCK_TABLE_RETRY_MS) return;
    await ensureLockTable();
}

/** "The table is not there" told apart from "the statement failed", in each engine's dialect. */
function looksLikeMissingTable(e: any): boolean {
    const code = String((e && e.code) || '');
    const msg = String((e && e.message) || '').toLowerCase();
    if (code === 'ER_NO_SUCH_TABLE' || Number(e && e.errno) === 1146) return true; // MySQL/MariaDB
    if (code === '42P01') return true;                                            // Postgres
    return /no such table|doesn't exist|does not exist|undefined table/.test(msg);
}

/**
 * FAILURES THAT NO AMOUNT OF WAITING CAN CURE.
 *
 * THE CLASS: this lock has exactly two ways to say "you don't have it" — CONTENTION (the CAS touched
 * 0 rows because someone else holds a live lease; waiting is precisely the cure) and a STRUCTURAL
 * failure of the lock itself (no table and no grant to create one, no privilege on it, a dialect the
 * statement is not valid in). Collapsing both into `false` — which is what making `tryAcquire`
 * swallow its exception did — is what turns a deployment error into a five-minute silent stall:
 * `acquireBlocking('wordjs:boot', {timeoutMs: 300000})` polls 600 times, each with an INSERT and an
 * UPDATE that fail the same way, and only then does index.ts throw and the supervisor restart — into
 * another five minutes. The real cause appears buried among 600 identical symptoms.
 *
 * So the poll loop asks WHY, not just WHETHER, and stops the moment the answer cannot change by
 * waiting. The check is by ENGINE ERROR CLASS (missing object / privilege / syntax), never by message
 * matching alone, and anything it does not recognise is treated as transient — a wrong guess there
 * only costs the poll it was going to do anyway (see `MAX_TRANSIENT_FAILURES` for its bound).
 */
function looksStructural(e: any): boolean {
    if (looksLikeMissingTable(e)) return true;
    const code = String((e && e.code) || '');
    const errno = Number(e && e.errno);
    // Postgres: insufficient_privilege / syntax_error / undefined_column|function.
    if (code === '42501' || code === '42601' || code === '42703' || code === '42883') return true;
    // MySQL/MariaDB: table access denied / db access denied / access denied / parse error.
    if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR'
        || code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_PARSE_ERROR') return true;
    if (errno === 1142 || errno === 1044 || errno === 1045 || errno === 1064) return true;
    const msg = String((e && e.message) || '').toLowerCase();
    return /permission denied|access denied|command denied|not allowed|syntax error/.test(msg);
}

/**
 * Consecutive UNRECOGNISED failures before the poll loop gives up anyway. A structural cause we did
 * not classify must not be able to buy the full timeout back by being unfamiliar; a genuine blip
 * (one dropped connection) still costs only a retry.
 */
const MAX_TRANSIENT_FAILURES = 3;

type AcquireOutcome = { granted: boolean; failure?: any; structural?: boolean };

/**
 * The acquire, WITH ITS REASON. `tryAcquire` is the boolean face of this (callers outside this module
 * only ever needed "did I get it"); the poll loop needs to tell contention from a lock it can never
 * have. Like `tryAcquire`, IT NEVER THROWS.
 */
async function attemptAcquire(name: string, ttlMs: number): Promise<AcquireOutcome> {
    const mode = lockMode();
    if (mode === 'single-host') return { granted: true };
    if (mode !== 'postgres' && mode !== 'mysql') {
        return { granted: false, structural: true, failure: new Error('no lock implementation for the active database driver') };
    }
    // The engine may have changed after boot (setup wizard), so the table may never have been made.
    await ensureLockTableFor(mode);
    const NOW_MS = NOW_MS_BY_MODE[mode];
    const d = db();
    try {
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
        // 0 rows changed = someone else holds a live lease. That is CONTENTION, and it is the only
        // "no" that polling can turn into a "yes".
        return { granted: !!(res && (res.changes || 0) > 0) };
    } catch (e: any) {
        // The table can also disappear AFTER we recorded it (a restore, a migration, a driver switch
        // back and forth): forget the record so the next attempt re-creates it instead of failing
        // for the rest of the process's life.
        if (looksLikeMissingTable(e)) lockTableMode = null;
        return { granted: false, failure: e, structural: looksStructural(e) };
    }
}

/**
 * One line per cause, not one per attempt. `tryAcquire` is called from cron on every tick and from
 * the poll loop twice a second, so an unusable lock table used to produce hundreds of identical
 * warnings — the shape that hides the ten lines that say WHY.
 */
const lastWarnAt = new Map<string, number>();
const WARN_EVERY_MS = 30_000;

function warnThrottled(key: string, line: string): void {
    const now = Date.now();
    const prev = lastWarnAt.get(key) || 0;
    if (now - prev < WARN_EVERY_MS) return;
    // Lock names can be request-derived ('wordjs:plugin-op:<slug>'), so this map must not be able to
    // grow with them. Forgetting everything only costs one extra warning line per key.
    if (lastWarnAt.size > 256) lastWarnAt.clear();
    lastWarnAt.set(key, now);
    console.warn(line);
}

/**
 * Try to acquire `name` for `ttlMs`. Returns true if THIS node now holds it. Non-blocking.
 * On single-host SQLite, always true; on an engine with no implementation, always FALSE.
 *
 * IT NEVER THROWS, and that is not defensive noise: it is the difference between a degraded lock and
 * a dead scheduler. This was the ONLY primitive without a catch (`renew` and `release` both had one),
 * so a missing `wordjs_locks` climbed out through `acquireBlocking`'s poll loop into its callers — a
 * 500 on plugin activate/deactivate, and, much worse, a rejected promise inside
 * `setInterval(runCron)`, which nobody awaits: the global handler LOGS it and cron (scheduled
 * publishing, backups, ACME renewal) stops running until the next restart, silently. A lock that
 * cannot be taken is a lock NOT GRANTED, and `false` is the fail-closed answer every caller already
 * knows how to handle.
 */
async function tryAcquire(name: string, ttlMs = 60000): Promise<boolean> {
    const r = await attemptAcquire(name, ttlMs);
    if (!r.granted && r.failure) {
        warnThrottled(`${name}:${r.structural ? 'structural' : 'transient'}`,
            `[dist-lock] '${logSafe(name)}' NOT acquired${r.structural ? ' (the lock table is unusable — this will not fix itself)' : ''}: ` +
            `${logSafe(r.failure && r.failure.message)}`);
    }
    return r.granted;
}

/**
 * Extend a lease we still hold (heartbeat). Returns false if we no longer hold it (e.g. it expired
 * and was reclaimed) — callers may use that to abort. No-op true on single-host SQLite.
 *
 * The CAS relies on the UPDATE reporting how many rows it touched, and MySQL's `affectedRows`
 * counts rows whose value actually CHANGED. That is safe here only because `locked_until` always
 * moves forward: renewMs is seconds, so two renewals can never land on the same millisecond and
 * report a spurious "we lost it".
 */
async function renew(name: string, ttlMs: number): Promise<boolean> {
    const mode = lockMode();
    if (mode === 'single-host') return true;
    if (mode !== 'postgres' && mode !== 'mysql') return false;
    const NOW_MS = NOW_MS_BY_MODE[mode];
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
 * Release a lock we hold (only clears it if we are still the recorded holder). No-op when there is
 * no lease: nothing was taken, so there is nothing to give back.
 */
async function release(name: string): Promise<void> {
    const mode = lockMode();
    if (mode !== 'postgres' && mode !== 'mysql') return;
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
    const mode = lockMode();
    // Single host: nothing to serialize, so the caller proceeds exactly as it always has.
    if (mode === 'single-host') return { held: true, release: async () => { } };
    // No implementation for this engine. FAIL CLOSED — `{held:false}` is the answer index.ts and
    // core/plugins.ts already handle (restart / refuse the non-atomic write). Answering "granted"
    // here is what let two MySQL replicas seed the same database at the same time.
    if (mode !== 'postgres' && mode !== 'mysql') {
        console.warn(
            `[dist-lock] '${logSafe(name)}' NOT granted: no lock implementation for the active database ` +
            'driver. Multi-node deployments require postgres or mysql/mariadb.');
        return { held: false, release: async () => { } };
    }

    const start = Date.now();
    let fallosSeguidos = 0;
    while (Date.now() - start < timeoutMs) {
        const r = await attemptAcquire(name, ttlMs);
        if (r.granted) {
            const timer = startHeartbeat(name, ttlMs, renewMs);
            return { held: true, release: async () => { clearInterval(timer); await release(name); } };
        }
        // WAITING ONLY CURES CONTENTION (see `looksStructural`). A lock we can never take is reported
        // ONCE, immediately, with the real cause — instead of 600 identical warnings and a five-minute
        // stall that the caller cannot tell apart from a busy cluster.
        if (r.failure) {
            fallosSeguidos++;
            if (r.structural || fallosSeguidos >= MAX_TRANSIENT_FAILURES) {
                console.warn(
                    `[dist-lock] '${logSafe(name)}' NOT granted after ${logSafe(Date.now() - start)}ms: ` +
                    `the lock table is unusable, and waiting cannot fix it — ${logSafe(r.failure && r.failure.message)}`);
                return { held: false, release: async () => { } };
            }
        } else {
            fallosSeguidos = 0;   // contention: someone holds it, and that DOES change with time
        }
        await sleep(pollMs);
    }
    console.warn(`[dist-lock] '${logSafe(name)}' acquire timed out after ${logSafe(timeoutMs)}ms.`);
    return { held: false, release: async () => { } };
}

/**
 * Run `fn` only if THIS node wins `name` this round; otherwise skip (another node is the leader).
 * Heartbeats the lease for the whole run, then always releases. On single-host SQLite, always runs
 * `fn`; on an engine we cannot lock on, SKIPS — the caller (cron) would otherwise run on every
 * replica, which is the duplicate-backup / N-simultaneous-ACME-orders failure this lock exists for.
 */
async function runAsLeader<T>(
    name: string,
    opts: { ttlMs?: number; renewMs?: number },
    fn: () => Promise<T>
): Promise<T | undefined> {
    const mode = lockMode();
    if (mode === 'single-host') return fn();
    if (mode !== 'postgres' && mode !== 'mysql') {
        console.warn(
            `[dist-lock] '${logSafe(name)}' SKIPPED: no lock implementation for the active database driver.`);
        return undefined;
    }
    const ttlMs = opts.ttlMs ?? 90000;
    const renewMs = opts.renewMs ?? Math.max(5000, Math.floor(ttlMs / 3));
    const r = await attemptAcquire(name, ttlMs);
    if (!r.granted) {
        // Same distinction as in `acquireBlocking`, and here it is the ONLY diagnosis the operator
        // gets: cron skipping because another node is the leader is normal; cron skipping because the
        // lock table cannot be used means scheduled publishing, backups and ACME renewal are NOT
        // running anywhere. Those two must not look the same in the log.
        if (r.structural) {
            warnThrottled(`leader:${name}`,
                `[dist-lock] '${logSafe(name)}' SKIPPED and it will keep being skipped: the lock table is unusable — ` +
                `${logSafe(r.failure && r.failure.message)}`);
        } else if (r.failure) {
            warnThrottled(`leader-transient:${name}`,
                `[dist-lock] '${logSafe(name)}' SKIPPED after a lock error: ${logSafe(r.failure && r.failure.message)}`);
        }
        return undefined;
    }
    const timer = startHeartbeat(name, ttlMs, renewMs);
    try { return await fn(); }
    finally { clearInterval(timer); await release(name); }
}

module.exports = { HOLDER, ensureLockTable, tryAcquire, renew, release, acquireBlocking, runAsLeader };
