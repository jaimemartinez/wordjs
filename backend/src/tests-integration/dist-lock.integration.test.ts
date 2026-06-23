/**
 * Integration test for the distributed lease lock against a REAL Postgres.
 *
 * Runs in the separate `npm run test:integration` invocation (its own process, so switching the
 * global driver to Postgres doesn't affect the SQLite main suite). Skips gracefully when no Postgres
 * is reachable, so it's a no-op locally and a real check in CI (which provisions a postgres service).
 *
 * Verifies the lease semantics the multi-node correctness depends on: fresh acquire, a live lease
 * cannot be stolen, an expired lease can be reclaimed, renew extends the holder's lease, and release
 * frees it.
 */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app');

const withTimeout = (p: Promise<any>, ms: number) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

test('dist-lock: lease CAS semantics against Postgres (skipped if no PG reachable)', async (t: any) => {
    const db = require('../config/database');
    try {
        await withTimeout(db.init({ driver: 'postgres' }), 4000);
    } catch (e: any) {
        return (t as any).skip(`no reachable Postgres: ${e && e.message}`);
    }
    if (!db.getDbType().isPostgres) return (t as any).skip('not running on the postgres driver');

    const lock = require('../core/dist-lock');
    const dbAsync = db.dbAsync;
    const NAME = `test:lock:${process.pid}`;

    await lock.ensureLockTable();
    await dbAsync.run('DELETE FROM wordjs_locks WHERE lock_name = ?', [NAME]);

    // 1. Fresh acquire succeeds.
    assert.strictEqual(await lock.tryAcquire(NAME, 60000), true, 'fresh acquire should succeed');

    // 2. A live lease held by ANOTHER node cannot be stolen.
    await dbAsync.run(
        "UPDATE wordjs_locks SET holder = 'other-node', locked_until = (EXTRACT(EPOCH FROM now())*1000)::bigint + 60000 WHERE lock_name = ?",
        [NAME]
    );
    assert.strictEqual(await lock.tryAcquire(NAME, 60000), false, 'must not steal a live lease');

    // 3. Once the other lease expires, it can be reclaimed.
    await dbAsync.run('UPDATE wordjs_locks SET locked_until = 0 WHERE lock_name = ?', [NAME]);
    assert.strictEqual(await lock.tryAcquire(NAME, 60000), true, 'must reclaim an expired lease');

    // 4. The holder can renew its own lease.
    assert.strictEqual(await lock.renew(NAME, 60000), true, 'holder should renew its lease');

    // 5. Release frees the lease (locked_until back to 0).
    await lock.release(NAME);
    const row = await dbAsync.get('SELECT locked_until FROM wordjs_locks WHERE lock_name = ?', [NAME]);
    assert.strictEqual(Number(row.locked_until), 0, 'release should set locked_until = 0');

    // 6. A different holder cannot renew our (now-foreign) lease.
    await lock.tryAcquire(NAME, 60000); // we hold it again
    await dbAsync.run("UPDATE wordjs_locks SET holder = 'other-node' WHERE lock_name = ?", [NAME]);
    assert.strictEqual(await lock.renew(NAME, 60000), false, 'cannot renew a lease held by another node');

    await dbAsync.run('DELETE FROM wordjs_locks WHERE lock_name = ?', [NAME]);
    try { await db.closeDatabase(); } catch { /* */ }
});
