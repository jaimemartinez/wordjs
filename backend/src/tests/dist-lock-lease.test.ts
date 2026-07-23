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
 *   - releaseAllHeld() — the fix — hands every held lease back, so the successor can claim at once.
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

    it('releaseAllHeld() hands back every lease, so a restarted process can claim immediately', async () => {
        // THE FIX. Delete the releaseAllHeld() call from the shutdown handler (or the bookkeeping that
        // feeds it) and this goes red: the successor stays locked out for the full TTL.
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

    it('is a no-op on SQLite — which is why no unit suite ever executed any of the above', async () => {
        isPostgres = false;
        const h = await lock.acquireBlocking('wordjs:plugin-op:mail-server', { ttlMs: 1000, timeoutMs: 50 });
        assert.strictEqual(h.held, true, 'single-host drivers always "hold" it');
        assert.strictEqual(rows.size, 0, 'no row is ever written');
        assert.deepStrictEqual(lock.heldLockNames(), [], 'and nothing is tracked, so shutdown has nothing to release');
        await h.release();
    });
});
