/**
 * WordJS — core/dist-lock LEASE semantics, unit-tested without a Postgres.
 *
 * WHY THIS FILE EXISTS. The lease path was, until now, executed by NO test in `npm test`: every unit
 * suite runs on sqlite-native, and dist-lock short-circuits to a no-op-held whenever the driver is not
 * Postgres, so `tryAcquire`/`renew`/`release` returned canned values and their CAS logic was never
 * touched. The only real coverage lived in tests-integration/dist-lock.integration.test.ts, which
 * skips unless a Postgres is reachable. A regression that only manifests through the lease — a
 * process exiting while holding one, stranding it for its whole TTL — was therefore invisible to the
 * suite that gates every PR.
 *
 * So: swap in a fake `config/database` that implements exactly the four statements dist-lock issues,
 * against an in-memory table and an EXPLICIT clock (Postgres computes `now()` server-side, and the
 * whole point of the expiry rules is what happens as that clock advances). That makes the properties
 * the multi-node design rests on assertable in-process:
 *
 *   - a lease is holder-guarded: a process can only ever free its OWN (so a RESTARTED process, which
 *     gets a brand-new HOLDER, can never free what its predecessor left behind);
 *   - a live lease cannot be stolen — it only becomes claimable once locked_until lapses;
 *   - therefore exiting without releasing STRANDS the lease for up to its TTL. At the plugin-op
 *     lease's 120s that is what made a graceful restart mid-update block the next boot's crash
 *     recovery, and 409 every install/update/upload/delete of that plugin, with a message claiming an
 *     operation was "running elsewhere" when nothing was;
 *   - releaseAllHeld({ only }) — the fix — hands back the leases the caller has CONFIRMED are finished,
 *     so the successor can claim those at once.
 *
 * WHY `only` AND NOT AN EXCLUSION. heldLocks contains a lease exactly while its critical section runs,
 * so "release everything except the ones I know are busy" is still a sweep over sections that are
 * executing — it just trusts the caller to have enumerated all of them. It cannot: 'wordjs:active-plugins'
 * is taken by activate/deactivate, which the plugin-operation drain never sees, and 'wordjs:cron' is held
 * by runAsLeader for as long as a backup or an ACME renewal runs. Handing either to a peer mid-work is a
 * failure the pre-release code could not have — so the sweep is an ALLOW-LIST, and an `only` predicate
 * that throws fails CLOSED. The tests below pin both directions.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ---------------------------------------------------------------------------------------------
// A fake `config/database`, injected into the require cache BEFORE core/dist-lock is loaded so the
// real DB module is never even evaluated. dist-lock re-requires it on every call, so flipping
// `isPostgres` between tests switches the code path live.
// ---------------------------------------------------------------------------------------------

type Row = { holder: string; locked_until: number };

const rows = new Map<string, Row>();
/** The "server-side" clock every expiry comparison is made against. Advanced explicitly by tests. */
let clockMs = 1_700_000_000_000;
let isPostgres = true;

const NOW_SQL = '(EXTRACT(EPOCH FROM now())*1000)::bigint';

const fakeDb = {
    exec: async (_sql: string) => { /* CREATE TABLE IF NOT EXISTS wordjs_locks — nothing to do */ },
    run: async (sql: string, params: any[] = []) => {
        const s = String(sql);
        // 1. Ensure the row exists, without clobbering a live lease.
        if (/^INSERT INTO wordjs_locks/i.test(s)) {
            const [name, holder] = params;
            if (rows.has(name)) return { changes: 0 };          // ON CONFLICT DO NOTHING
            rows.set(name, { holder, locked_until: 0 });
            return { changes: 1 };
        }
        // 2. tryAcquire's atomic claim: only when the current lease has already lapsed.
        if (/SET holder = \?/.test(s)) {
            const [holder, ttlMs, name] = params;
            const row = rows.get(name);
            if (!row || row.locked_until >= clockMs) return { changes: 0 };
            row.holder = holder;
            row.locked_until = clockMs + Number(ttlMs);
            return { changes: 1 };
        }
        // 3. renew — holder-guarded heartbeat.
        if (/SET locked_until = \(EXTRACT/.test(s)) {
            const [ttlMs, name, holder] = params;
            const row = rows.get(name);
            if (!row || row.holder !== holder) return { changes: 0 };
            row.locked_until = clockMs + Number(ttlMs);
            return { changes: 1 };
        }
        // 4. release — holder-guarded free.
        if (/SET locked_until = 0/.test(s)) {
            const [name, holder] = params;
            const row = rows.get(name);
            if (!row || row.holder !== holder) return { changes: 0 };
            row.locked_until = 0;
            return { changes: 1 };
        }
        throw new Error(`fake db: unexpected SQL: ${s}`);
    },
};

const fakeDatabaseModule = {
    getDbType: () => ({ isPostgres }),
    dbAsync: fakeDb,
};

const DB_PATH = require.resolve('../config/database');
let realDbModule: any;

/** The identity a DIFFERENT process (e.g. the one that just replaced us) would use. */
const SUCCESSOR = 'other-host:4242:deadbeef';

/** Exactly the CAS tryAcquire issues, but as the successor — "can the next process claim this?". */
async function successorTryAcquire(name: string, ttlMs = 60000): Promise<boolean> {
    await fakeDb.run(
        'INSERT INTO wordjs_locks (lock_name, holder, locked_until) VALUES (?, ?, 0) ON CONFLICT (lock_name) DO NOTHING',
        [name, SUCCESSOR],
    );
    const res: any = await fakeDb.run(
        `UPDATE wordjs_locks SET holder = ?, locked_until = ${NOW_SQL} + ? WHERE lock_name = ? AND locked_until < ${NOW_SQL}`,
        [SUCCESSOR, ttlMs, name],
    );
    return (res.changes || 0) > 0;
}

/** Plant the lease a process that was KILLED mid-operation leaves behind: foreign holder, still live. */
function strandLease(name: string, ttlMs = 120000) {
    rows.set(name, { holder: SUCCESSOR, locked_until: clockMs + ttlMs });
}

describe('dist-lock lease semantics', () => {
    let lock: any;

    before(() => {
        realDbModule = require.cache[DB_PATH];
        const stub = new Module(DB_PATH, null);
        stub.filename = DB_PATH;
        stub.loaded = true;
        stub.exports = fakeDatabaseModule;
        require.cache[DB_PATH] = stub;
        lock = require('../core/dist-lock');
    });

    after(async () => {
        try { await lock.releaseAllHeld(); } catch { /* */ }
        if (realDbModule) require.cache[DB_PATH] = realDbModule; else delete require.cache[DB_PATH];
    });

    beforeEach(() => {
        rows.clear();
        clockMs = 1_700_000_000_000;
        isPostgres = true;
    });

    it('claims a free lease and records THIS process as the holder', async () => {
        assert.strictEqual(await lock.tryAcquire('wordjs:plugin-op:mail-server', 60000), true);
        const row = rows.get('wordjs:plugin-op:mail-server')!;
        assert.strictEqual(row.holder, lock.HOLDER, 'the lease is stamped with this process identity');
        assert.strictEqual(row.locked_until, clockMs + 60000);
    });

    it('cannot steal a live lease, and cannot free one it does not hold', async () => {
        // This is the whole reason an unreleased lease is a problem rather than an inconvenience: the
        // NEXT process has a different HOLDER, so neither path is open to it.
        const NAME = 'wordjs:plugin-op:mail-server';
        strandLease(NAME);

        assert.strictEqual(await lock.tryAcquire(NAME, 60000), false, 'a live lease is not claimable');
        await lock.release(NAME);
        assert.strictEqual(rows.get(NAME)!.locked_until, clockMs + 120000, 'release is holder-guarded — someone else\'s lease survives it');
        assert.strictEqual(await lock.renew(NAME, 60000), false, 'renew is holder-guarded too');
    });

    it('a lease stranded by a killed process blocks acquisition until its TTL lapses', async () => {
        // Precisely the boot-recovery symptom: recoverInterruptedPluginUpdates asks for the slug with a
        // 3s timeout and always loses to the dead predecessor's 120s lease.
        const NAME = 'wordjs:plugin-op:mail-server';
        strandLease(NAME, 120000);

        const denied = await lock.acquireBlocking(NAME, { ttlMs: 60000, timeoutMs: 60, pollMs: 10 });
        assert.strictEqual(denied.held, false, 'a boot that races a stranded lease is refused');
        assert.deepStrictEqual(lock.heldLockNames(), [], 'and nothing is registered as held');

        clockMs += 120001; // the TTL finally lapses
        const won = await lock.acquireBlocking(NAME, { ttlMs: 60000, timeoutMs: 60, pollMs: 10 });
        assert.strictEqual(won.held, true, 'once expired it is reclaimable');
        await won.release();
    });

    it('releaseAllHeld() with no argument hands back every lease (tests / whole-process teardown only)', async () => {
        // THE FIX, on the dist-lock side: break acquireBlocking's heldLocks bookkeeping or releaseAllHeld
        // itself and this goes red — the successor stays locked out for the full TTL.
        //
        // SCOPE, precisely. The no-argument form is NOT what the signal handler uses (see the `only`
        // tests below and the file header): it is the form a test or a teardown that owns the entire
        // process uses. This test calls it directly, so it says nothing about index.ts either; that
        // wiring (and the drain that has to precede it) is covered by plugin-op-shutdown.test.ts.
        // runAsLeader's half of the bookkeeping is covered by its own test below — acquireBlocking is the
        // only path this one exercises.
        const A = 'wordjs:plugin-op:mail-server';
        const B = 'wordjs:cron';
        const a = await lock.acquireBlocking(A, { ttlMs: 120000, timeoutMs: 100, pollMs: 10 });
        const b = await lock.acquireBlocking(B, { ttlMs: 90000, timeoutMs: 100, pollMs: 10 });
        assert.ok(a.held && b.held);
        assert.deepStrictEqual(lock.heldLockNames().sort(), [B, A].sort(), 'both leases are tracked as held');

        // Sanity: while we hold it, the successor is locked out — the state a hard kill would freeze.
        assert.strictEqual(await successorTryAcquire(A), false);

        const freed = await lock.releaseAllHeld();

        assert.deepStrictEqual([...freed].sort(), [B, A].sort(), 'both were released');
        assert.deepStrictEqual(lock.heldLockNames(), [], 'and the registry is empty again');
        assert.strictEqual(await successorTryAcquire(A), true, 'the restarted process takes the plugin-op lease at once');
        assert.strictEqual(await successorTryAcquire(B), true, 'and the cron lease too');
    });

    it('releaseAllHeld() forgets a lease already released by its handle (no double free)', async () => {
        const NAME = 'wordjs:boot';
        const h = await lock.acquireBlocking(NAME, { ttlMs: 60000, timeoutMs: 100, pollMs: 10 });
        await h.release();
        assert.deepStrictEqual(lock.heldLockNames(), [], 'release() deregisters it');

        // Someone else legitimately takes the lease afterwards; a later shutdown must NOT free THEIRS.
        assert.strictEqual(await successorTryAcquire(NAME, 60000), true);
        await lock.releaseAllHeld();
        assert.strictEqual(rows.get(NAME)!.holder, SUCCESSOR);
        assert.strictEqual(rows.get(NAME)!.locked_until, clockMs + 60000, 'the new holder\'s lease is untouched');
    });

    it('runAsLeader registers its lease while it runs, and deregisters it when it returns', async () => {
        // The OTHER writer into heldLocks. acquireBlocking's handle is the obvious one; runAsLeader takes
        // the lease itself and only frees it in a `finally`, so while the leader's work runs (the cron
        // runner is the live case: a backup or an ACME renewal holds 'wordjs:cron' for minutes) the lease
        // shows up here.
        //
        // WHAT THAT REGISTRATION MEANS, since an earlier revision of this test read it backwards: it is
        // the record that the section is STILL RUNNING, not a to-do list for the shutdown. A signal that
        // lands mid-backup must leave this lease exactly where it is — the next test pins that — and the
        // `finally` below is what frees it if the work finishes first.
        const NAME = 'wordjs:cron';
        let insideNames: string[] = [];

        const out = await lock.runAsLeader(NAME, { ttlMs: 90000 }, async () => {
            insideNames = lock.heldLockNames();
            assert.strictEqual(await successorTryAcquire(NAME), false, 'and the peer cannot run the same job meanwhile');
            return 'done';
        });

        assert.strictEqual(out, 'done');
        assert.deepStrictEqual(insideNames, [NAME], 'registered as held for the whole run — i.e. "this job is executing here"');
        assert.deepStrictEqual(lock.heldLockNames(), [], 'and deregistered on the way out');
        assert.strictEqual(rows.get(NAME)!.locked_until, 0, 'the lease itself was freed too');
    });

    it('releaseAllHeld({ only }) leaves the cron lease alone while the leader is still working', async () => {
        // THE REGRESSION THIS PINS. A shutdown sweep built as "everything except the plugin operations I
        // know are busy" frees 'wordjs:cron' while runAsLeader's callback is mid-flight, so a peer node
        // can start the same backup or the same ACME order concurrently — something that could not happen
        // before the shutdown released anything at all. The same argument covers 'wordjs:active-plugins',
        // held by activate/deactivate, which no plugin-operation drain can see.
        const CRON = 'wordjs:cron';
        const ACTIVE = 'wordjs:active-plugins';
        const FINISHED_OP = 'wordjs:plugin-op:mail-server';
        const opLock = await lock.acquireBlocking(FINISHED_OP, { ttlMs: 120000, timeoutMs: 100, pollMs: 10 });
        assert.ok(opLock.held);

        let freed: string[] = [];
        let peerCouldStealCron = false;
        let peerCouldStealActive = false;

        await lock.runAsLeader(CRON, { ttlMs: 90000 }, async () => {
            const active = await lock.acquireBlocking(ACTIVE, { ttlMs: 15000, timeoutMs: 100, pollMs: 10 });
            assert.ok(active.held);
            assert.deepStrictEqual(lock.heldLockNames().sort(), [ACTIVE, CRON, FINISHED_OP].sort());

            // The signal lands here: the shutdown names ONLY the plugin operation it drained.
            freed = await lock.releaseAllHeld({ only: (n: string) => n === FINISHED_OP });

            peerCouldStealCron = await successorTryAcquire(CRON);
            peerCouldStealActive = await successorTryAcquire(ACTIVE);
            await active.release();
        });

        assert.deepStrictEqual(freed, [FINISHED_OP], 'only the operation confirmed finished was handed back');
        assert.strictEqual(peerCouldStealCron, false, 'a peer cannot take over the backup/ACME run this node is executing');
        assert.strictEqual(peerCouldStealActive, false, 'nor interleave with an active_plugins read-modify-write');
        assert.strictEqual(await successorTryAcquire(FINISHED_OP), true, 'while the finished operation is immediately reclaimable');
    });

    it('runAsLeader deregisters even when the job THROWS (no lease stranded by a failing cron)', async () => {
        const NAME = 'wordjs:cron';
        await assert.rejects(
            () => lock.runAsLeader(NAME, { ttlMs: 90000 }, async () => { throw new Error('backup failed'); }),
            /backup failed/,
        );
        assert.deepStrictEqual(lock.heldLockNames(), [], 'the finally released it');
        assert.strictEqual(await successorTryAcquire(NAME), true, 'so the next round can run somewhere');
    });

    it('releaseAllHeld({ only }) keeps an unnamed lease, so a live critical section is not handed to a peer', async () => {
        // Every lease in heldLocks is one whose critical section has NOT finished, so the shutdown sweep
        // would by construction release leases that are still in use. index.ts drains the plugin
        // operations first and names only the ones that FINISHED — a slug still mid-swap keeps its lease
        // and expires on its TTL instead, because handing a peer the plugin this process is mid-swap on
        // is the corruption the lease exists to prevent.
        const BUSY = 'wordjs:plugin-op:mail-server';
        const DONE = 'wordjs:plugin-op:online-store';
        const busy = await lock.acquireBlocking(BUSY, { ttlMs: 120000, timeoutMs: 100, pollMs: 10 });
        const done = await lock.acquireBlocking(DONE, { ttlMs: 120000, timeoutMs: 100, pollMs: 10 });
        assert.ok(busy.held && done.held);

        const freed = await lock.releaseAllHeld({ only: (n: string) => n === DONE });

        assert.deepStrictEqual(freed, [DONE], 'only the finished one was handed back');
        assert.deepStrictEqual(lock.heldLockNames(), [BUSY], 'the busy lease is still registered as ours');
        assert.strictEqual(await successorTryAcquire(BUSY), false, 'and no peer can start on that plugin');
        assert.strictEqual(await successorTryAcquire(DONE), true, 'while the finished one is immediately reclaimable');

        clockMs += 120001; // …until the TTL lapses, exactly as after an abrupt kill
        assert.strictEqual(await successorTryAcquire(BUSY), true, 'the unnamed lease expires rather than deadlocking');
        await busy.release();
    });

    it('a throwing only-predicate fails CLOSED — unconfirmed means not released', async () => {
        // The direction of the risk is the opposite of an exclusion list's: what a broken predicate must
        // not do is hand a peer a lease whose critical section may still be running. Costing the
        // successor a TTL is the recoverable outcome; concurrent access is not.
        const NAME = 'wordjs:cron';
        const h = await lock.acquireBlocking(NAME, { ttlMs: 60000, timeoutMs: 100, pollMs: 10 });
        assert.ok(h.held);

        const freed = await lock.releaseAllHeld({ only: () => { throw new Error('predicate blew up'); } });

        assert.deepStrictEqual(freed, [], 'nothing was released');
        assert.deepStrictEqual(lock.heldLockNames(), [NAME], 'and it is still registered as ours');
        assert.strictEqual(await successorTryAcquire(NAME), false, 'so no peer takes over work that may still be running');
        await h.release();
    });

    it('is a no-op on SQLite — which is why no unit suite ever executed any of the above', async () => {
        isPostgres = false;
        const h = await lock.acquireBlocking('wordjs:plugin-op:mail-server', { ttlMs: 1000, timeoutMs: 50 });
        assert.strictEqual(h.held, true, 'single-host drivers always "hold" it');
        assert.strictEqual(rows.size, 0, 'no row is ever written');
        assert.deepStrictEqual(lock.heldLockNames(), [], 'and nothing is tracked, so shutdown has nothing to release');
        await h.release();
    });
});
