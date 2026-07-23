/**
 * WordJS — the graceful shutdown must ACTUALLY hand back the plugin-op leases whose work is finished.
 *
 * THE CLAIM THIS FILE EXISTS TO KEEP HONEST. The shutdown used to end with
 * `releaseAllHeld({ only: finishedOps })` and the CHANGELOG said that a graceful restart mid-update
 * hands the 120s lease back. It could not: dist-lock's `heldLocks` map drops a lease's name in the SAME
 * synchronous step that STARTS its DB release, and an operation only ever counts as "finished" after
 * that step has run — so every name the sweep was permitted to free was already gone from the map, and
 * the call released nothing, ever. The first test below pins that fact directly against the real
 * dist-lock, so the dead-code shape cannot come back unnoticed.
 *
 * WHAT IS ACTUALLY STRANDED, and what the replacement frees. After the drain, two states remain in
 * which this process still owns a lease on a plugin whose critical section is provably over:
 *
 *   1. the release's DB write FAILED — it is swallowed as best-effort, so the row is still leased to us;
 *   2. the process exited between the operation finishing and that write completing — the in-flight set
 *      is cleared before the write, so the drain converges and the handler runs on to process.exit(0).
 *
 * Both leave the successor locked out for the full TTL, 409'ing every install/update/upload/delete of
 * that plugin and blocking the next boot's crash recovery, with a "running elsewhere" message that is
 * false. releaseFinishedOpLeases keeps its own record — deleted only once a release is CONFIRMED — and
 * re-issues a holder-guarded release for what is left. Both states are exercised below.
 *
 * AND WHAT IT MUST NEVER TOUCH: 'wordjs:active-plugins' (held while activate/deactivate rewrite the
 * option) and 'wordjs:cron' (held by runAsLeader for as long as a backup or an ACME renewal runs).
 * That is now structural rather than a matter of building an allow-list correctly — only plugin-op
 * leases are ever recorded — and the last tests pin it.
 *
 * The lock itself is the REAL core/dist-lock running its Postgres path; only `config/database` is faked,
 * with the same in-memory table + explicit clock as dist-lock-lease.test.ts, because the whole point is
 * the holder-guarded CAS. routes/plugins is loaded FIRST, against the real database module, and the fake
 * is swapped in afterwards — dist-lock re-requires it on every call, so the swap takes effect live.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'production';

// PLUGINS_DIR resolves from the CWD at module load (same reason as the other plugin route tests).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-op-lease-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

// Loaded BEFORE the database fake is installed, so the router binds the real modules it expects.
const pluginRoutes = require('../routes/plugins');
const { acquirePluginOpLock, releaseFinishedOpLeases, unreleasedOpLeaseNames, pluginOpLeaseName } = pluginRoutes;
const lock = require('../core/dist-lock');

// --- the fake `config/database`: exactly the four statements dist-lock issues ---------------------

type Row = { holder: string; locked_until: number };
const rows = new Map<string, Row>();
let clockMs = 1_700_000_000_000;
/** When set, the next release UPDATE throws — the swallowed best-effort failure (state 1). */
let releaseFails = false;
/** When set, the next release UPDATE never settles — the signal landing mid-write (state 2). */
let releaseHangs = false;

const fakeDb = {
    exec: async (_sql: string) => { /* CREATE TABLE IF NOT EXISTS */ },
    run: async (sql: string, params: any[] = []) => {
        const s = String(sql);
        if (/^INSERT INTO wordjs_locks/i.test(s)) {
            const [name, holder] = params;
            if (rows.has(name)) return { changes: 0 };
            rows.set(name, { holder, locked_until: 0 });
            return { changes: 1 };
        }
        if (/SET holder = \?/.test(s)) {                 // tryAcquire's atomic claim
            const [holder, ttlMs, name] = params;
            const row = rows.get(name);
            if (!row || row.locked_until >= clockMs) return { changes: 0 };
            row.holder = holder;
            row.locked_until = clockMs + Number(ttlMs);
            return { changes: 1 };
        }
        if (/SET locked_until = \(EXTRACT/.test(s)) {     // renew (holder-guarded heartbeat)
            const [ttlMs, name, holder] = params;
            const row = rows.get(name);
            if (!row || row.holder !== holder) return { changes: 0 };
            row.locked_until = clockMs + Number(ttlMs);
            return { changes: 1 };
        }
        if (/SET locked_until = 0/.test(s)) {             // release (holder-guarded free)
            if (releaseHangs) return new Promise(() => { /* never settles — the process is exiting */ });
            if (releaseFails) throw new Error('db unreachable');
            const [name, holder] = params;
            const row = rows.get(name);
            if (!row || row.holder !== holder) return { changes: 0 };
            row.locked_until = 0;
            return { changes: 1 };
        }
        throw new Error(`fake db: unexpected SQL: ${s}`);
    },
};

const DB_PATH = require.resolve('../config/database');
let realDbModule: any;

const SUCCESSOR = 'other-host:4242:deadbeef';
/** Exactly the CAS tryAcquire issues, but as the process that replaced us. */
async function successorTryAcquire(name: string, ttlMs = 60000): Promise<boolean> {
    await fakeDb.run('INSERT INTO wordjs_locks (lock_name, holder, locked_until) VALUES (?, ?, 0) ON CONFLICT (lock_name) DO NOTHING', [name, SUCCESSOR]);
    const res: any = await fakeDb.run('UPDATE wordjs_locks SET holder = ?, locked_until = X + ? WHERE lock_name = ? AND locked_until < X', [SUCCESSOR, ttlMs, name]);
    return (res.changes || 0) > 0;
}

describe('graceful shutdown — the plugin-op leases of FINISHED operations are really handed back', () => {
    before(() => {
        realDbModule = require.cache[DB_PATH];
        const stub = new Module(DB_PATH, null);
        stub.filename = DB_PATH;
        stub.loaded = true;
        stub.exports = { getDbType: () => ({ isPostgres: true }), dbAsync: fakeDb };
        require.cache[DB_PATH] = stub;
    });

    after(() => {
        if (realDbModule) require.cache[DB_PATH] = realDbModule; else delete require.cache[DB_PATH];
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(() => {
        rows.clear();
        clockMs = 1_700_000_000_000;
        releaseFails = false;
        releaseHangs = false;
    });

    it('the OLD mechanism was dead: by the time an operation is finished, dist-lock has already forgotten its lease', async () => {
        // This is the disproved claim, asserted rather than argued. releaseAllHeld({ only }) can only free
        // names that are in heldLocks; the handle removes the name in the same synchronous step it starts
        // the release, so the drain — which polls the in-flight set — can never observe an operation as
        // finished while its name is still there. Hence the sweep's input set is always empty.
        const KEY = 'mail-server';
        const NAME = pluginOpLeaseName(KEY);
        const held = await acquirePluginOpLock(KEY);
        assert.strictEqual(held.ok, true);
        assert.ok(lock.heldLockNames().includes(NAME), 'while the operation runs, dist-lock tracks it');

        await held.release();

        assert.strictEqual(lock.heldLockNames().includes(NAME), false,
            'the instant the operation is finished the name is gone from heldLocks — so a shutdown sweep '
            + 'keyed on that map has nothing it is allowed to release, which is why the old call was a no-op');
        assert.deepStrictEqual(await lock.releaseAllHeld({ only: (n: string) => n === NAME }), [],
            'proved directly: the exact call index.ts used to make frees nothing');
    });

    it('the ordinary restart needs nothing: a finished operation released its own lease', async () => {
        const KEY = 'mail-server';
        const NAME = pluginOpLeaseName(KEY);
        const held = await acquirePluginOpLock(KEY);
        await held.release();

        assert.deepStrictEqual(unreleasedOpLeaseNames(), [], 'the release was CONFIRMED, so nothing is outstanding');
        assert.deepStrictEqual(await releaseFinishedOpLeases([KEY]), [], 'and the shutdown has nothing to do');
        assert.strictEqual(await successorTryAcquire(NAME), true, 'the successor can take the plugin straight away');
    });

    it('STATE 1 — a release whose DB write FAILED is retried at shutdown instead of stranding the lease', async () => {
        // The failure is swallowed as best-effort (the admin's request already succeeded), so nothing
        // else would ever notice: the row stays leased to a process that is on its way out, and every
        // operation on that plugin 409s for the full 120s TTL.
        const KEY = 'mail-server';
        const NAME = pluginOpLeaseName(KEY);
        const held = await acquirePluginOpLock(KEY);
        assert.strictEqual(held.ok, true);

        releaseFails = true;
        await held.release();                       // the operation is over; the hand-back is not
        releaseFails = false;

        assert.deepStrictEqual(unreleasedOpLeaseNames(), [NAME], 'THE FIX: the lease is still recorded as ours');
        assert.strictEqual(await successorTryAcquire(NAME), false, 'and the successor is indeed locked out right now');

        const freed = await releaseFinishedOpLeases([KEY]);

        assert.deepStrictEqual(freed, [NAME], '…so the shutdown hands it back');
        assert.deepStrictEqual(unreleasedOpLeaseNames(), [], 'and stops tracking it');
        assert.strictEqual(await successorTryAcquire(NAME), true, 'the next boot can touch the plugin immediately');
    });

    it('STATE 2 — the signal lands while the release UPDATE is still in flight', async () => {
        // drainPluginOps polls the in-flight SET, and the handle clears that set BEFORE it awaits the DB
        // write. So the drain reports "nothing running" while the UPDATE has not landed, and the handler
        // walks on to process.exit(0). Modelled by a release that never settles.
        const KEY = 'online-store';
        const NAME = pluginOpLeaseName(KEY);
        const held = await acquirePluginOpLock(KEY);
        assert.strictEqual(held.ok, true);

        releaseHangs = true;
        void held.release();                        // deliberately NOT awaited — it never resolves
        await new Promise((r) => setTimeout(r, 20)); // let it get as far as the pending UPDATE
        releaseHangs = false;

        assert.deepStrictEqual(unreleasedOpLeaseNames(), [NAME], 'the hand-back is unconfirmed…');
        assert.strictEqual(await successorTryAcquire(NAME), false, '…and the lease is still live');

        const freed = await releaseFinishedOpLeases([KEY]);

        assert.deepStrictEqual(freed, [NAME], 'THE FIX: the shutdown re-issues the release');
        assert.strictEqual(await successorTryAcquire(NAME), true, 'so the restart does not cost the successor a TTL');
    });

    it('fails CLOSED for an operation that is STILL RUNNING, even if its key is passed in', async () => {
        // Handing a peer the lease of a plugin this process may be mid-swap on is the corruption the
        // lease exists to prevent — worse than costing the successor a TTL.
        const KEY = 'restaurant-menu';
        const NAME = pluginOpLeaseName(KEY);
        const held = await acquirePluginOpLock(KEY);
        assert.strictEqual(held.ok, true);

        const freed = await releaseFinishedOpLeases([KEY]);

        assert.deepStrictEqual(freed, [], 'nothing was released while the critical section is executing');
        assert.strictEqual(await successorTryAcquire(NAME), false, 'so no peer starts on the plugin we are mid-swap on');
        await held.release();
    });

    it('cannot reach wordjs:cron or wordjs:active-plugins AT ALL — the round-3 regression is structural now', async () => {
        // The previous design had to be careful to name only plugin-op leases; this one has no way to
        // name anything else, because only plugin-op leases are ever recorded. Both of these are held by
        // work the plugin drain cannot even see (a running backup / ACME order; an activate rewriting the
        // option), so freeing either lets a peer interleave with work still executing here.
        const CRON = 'wordjs:cron';
        const ACTIVE = 'wordjs:active-plugins';
        const cron = await lock.acquireBlocking(CRON, { ttlMs: 90000, timeoutMs: 100, pollMs: 10 });
        const active = await lock.acquireBlocking(ACTIVE, { ttlMs: 15000, timeoutMs: 100, pollMs: 10 });
        assert.ok(cron.held && active.held);

        const KEY = 'mail-server';
        const held = await acquirePluginOpLock(KEY);
        releaseFails = true;
        await held.release();                       // leave one genuinely outstanding plugin-op lease
        releaseFails = false;

        assert.deepStrictEqual(unreleasedOpLeaseNames(), [pluginOpLeaseName(KEY)],
            'the shutdown record contains plugin-op leases and nothing else');

        // Every key the drain could possibly report, plus the lease names themselves as a hostile input.
        const freed = await releaseFinishedOpLeases([KEY, CRON, ACTIVE, 'cron', 'active-plugins']);

        assert.deepStrictEqual(freed, [pluginOpLeaseName(KEY)], 'only the plugin operation was handed back');
        assert.strictEqual(await successorTryAcquire(CRON), false, 'a peer cannot take over the backup/ACME run executing here');
        assert.strictEqual(await successorTryAcquire(ACTIVE), false, 'nor interleave with an active_plugins read-modify-write');

        await cron.release();
        await active.release();
    });

    it('index.ts calls the mechanism that can actually release, and no longer the one that cannot', () => {
        // HONEST SCOPE: a source-level assertion, like its sibling in plugin-op-shutdown.test.ts —
        // gracefulShutdown ends in process.exit(0) and cannot be executed from the runner. What it
        // catches is exactly the failure this file documents: a helper implemented and unit-tested while
        // the call site keeps invoking the one that does nothing.
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
        const start = src.indexOf('async function gracefulShutdown');
        const end = src.indexOf('\nprocess.on(\'SIGTERM\'', start);
        assert.ok(start > 0 && end > start, 'gracefulShutdown is still the SIGTERM handler');
        const body = src.slice(start, end);

        assert.match(body, /releaseFinishedOpLeases\(finishedOps\)/, 'it releases through the plugin-op bookkeeping…');
        assert.doesNotMatch(body, /releaseAllHeld\(/, '…and never sweeps dist-lock\'s heldLocks map from a signal handler');
    });
});
