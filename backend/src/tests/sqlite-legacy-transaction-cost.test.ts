/**
 * WordJS — a transaction on the sql.js fallback driver must not copy the whole database.
 *
 * WHY THIS TEST EXISTS. Closing audit #16 made models/Post.ts open a `dbAsync.transaction` for every
 * transition that crosses the publish/not-publish boundary — every publish, every trash, every
 * restore, every scheduled flip. On the pure-JS fallback driver (sql.js, selected automatically when
 * better-sqlite3 cannot load) `_runTransaction` used to call `this.sqlDb.export()` BEFORE each BEGIN
 * to have material for a deterministic rollback. `export()` serialises the ENTIRE in-memory database.
 * So the fix turned a single-row UPDATE into a full copy of a database that can be hundreds of MB —
 * a regression no correctness test could see, because the result was still correct.
 *
 * The property pinned here is a COST, stated in the only unit that matters: how many times the whole
 * database is serialised. A committing transaction serialises ONCE (the durable flush after COMMIT —
 * exactly what the bare write it replaced already paid). A failing one serialises ZERO times: the
 * on-disk file was never written during the transaction, so it already holds the last committed
 * image, and sql.js's own ROLLBACK — it IS SQLite — restores memory to match.
 *
 * Reverting the fix (re-adding the pre-BEGIN export) makes both counts one higher and fails here.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

require('../config/app'); // preload config (host context)

const legacy = require('../drivers/sqlite-legacy');

/** Boot the real driver on a private file and return its wrapper + a serialisation counter. */
async function bootLegacy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-sqljs-'));
    const dbPath = path.join(dir, 'wordjs.db');
    await legacy.init({ dbPath });
    const db = legacy.get();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t (v) VALUES (?)', ['committed']);

    const handle = db.sqlDb;
    const realExport = handle.export.bind(handle);
    const counter = { exports: 0 };
    handle.export = (...args: any[]) => { counter.exports++; return realExport(...args); };
    return { db, dbPath, dir, counter, handle, realExport };
}

test('sql.js transaction: a COMMIT serialises the database exactly once (no pre-BEGIN snapshot)', async () => {
    const { db, dir, counter } = await bootLegacy();
    try {
        await db.transaction(async (tx: any) => {
            await tx.run('INSERT INTO t (v) VALUES (?)', ['inside']);
        });
        assert.strictEqual(counter.exports, 1,
            'one full serialisation, the durable flush after COMMIT — the pre-BEGIN export() made every publish copy the whole database');
        const rows = db.all('SELECT v FROM t ORDER BY id');
        assert.deepStrictEqual(rows.map((r: any) => r.v), ['committed', 'inside']);
    } finally {
        legacy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sql.js transaction: a ROLLBACK still undoes the write, and serialises the database ZERO times', async () => {
    const { db, dir, dbPath, counter } = await bootLegacy();
    const before = fs.readFileSync(dbPath);
    try {
        await assert.rejects(
            () => db.transaction(async (tx: any) => {
                await tx.run('INSERT INTO t (v) VALUES (?)', ['doomed']);
                throw new Error('boom');
            }),
            /boom/
        );
        const rows = db.all('SELECT v FROM t ORDER BY id');
        assert.deepStrictEqual(rows.map((r: any) => r.v), ['committed'],
            'the failed unit of work must leave nothing behind in memory');
        assert.strictEqual(counter.exports, 0,
            'the on-disk file was never written during the transaction, so it already IS the last committed state');
        assert.deepStrictEqual(fs.readFileSync(dbPath), before,
            'and disk must be byte-identical to the pre-transaction committed image');
    } finally {
        legacy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sql.js transaction: overlapping callers queue; only an actual re-entrant call is rejected', async () => {
    const { db, dir } = await bootLegacy();
    try {
        await Promise.all(Array.from({ length: 5 }, (_, i) => db.transaction(async (tx: any) => {
            await tx.run('INSERT INTO t (v) VALUES (?)', [`parallel-${i}`]);
            await new Promise((resolve) => setImmediate(resolve));
        })));
        const rows = db.all("SELECT v FROM t WHERE v LIKE 'parallel-%'");
        assert.strictEqual(rows.length, 5, 'independent async contexts serialize instead of seeing a false nested-transaction error');

        await assert.rejects(
            db.transaction(async () => db.transaction(async () => {})),
            /nested transaction\(\) is not supported/,
            'a transaction called from its own callback still fails fast rather than deadlocking'
        );
    } finally {
        legacy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sql.js transaction: unrelated writes cannot cross an open transaction boundary', async () => {
    const { db, dir } = await bootLegacy();
    let entered!: () => void;
    let release!: () => void;
    const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const transactionRelease = new Promise<void>((resolve) => { release = resolve; });
    try {
        const failing = db.transaction(async (tx: any) => {
            await tx.run('INSERT INTO t (v) VALUES (?)', ['doomed']);
            entered();
            await transactionRelease;
            throw new Error('legacy rollback');
        });
        await transactionEntered;

        assert.throws(
            () => db.run('INSERT INTO t (v) VALUES (?)', ['sync-outsider']),
            /busy with another transaction/,
            'a synchronous caller fails closed instead of joining an unrelated transaction'
        );
        const independent = (async () => {
            await db.waitForTransaction();
            return db.run('INSERT INTO t (v) VALUES (?)', ['async-outsider']);
        })();
        release();
        await assert.rejects(failing, /legacy rollback/);
        await independent;

        const rows = db.all('SELECT v FROM t ORDER BY id');
        assert.deepStrictEqual(rows.map((r: any) => r.v), ['committed', 'async-outsider']);
    } finally {
        legacy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
