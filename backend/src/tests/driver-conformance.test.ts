/**
 * Driver conformance suite.
 *
 * Runs the SAME DatabaseDriverInterface contract (connect/exec/run/get/all/close) against every
 * available ASYNC driver, so multi-DB support is verifiable and adding a new backend (MySQL, etc.)
 * is a contained, validated unit: implement the interface, add one block here, and the contract is
 * checked. Drivers whose backend isn't available in this environment skip gracefully rather than
 * fail (better-sqlite3 native binary missing → that's the sql.js fallback case; no Postgres
 * reachable → skipped). The legacy 'sqlite-legacy' (sql.js) driver uses the older SYNC shape and is
 * intentionally out of scope here — this suite validates the async interface implementers.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

require('../config/app'); // preload config (host context)

// Dialect descriptors: placeholder style, auto-increment PK, and INSERT-returns-id mechanism all
// differ per database. The CONTRACT (run returns {lastID, changes}; get/all shapes) is identical.
const SQLITE = { autoPk: 'INTEGER PRIMARY KEY AUTOINCREMENT', ph: (_i: number) => '?', ret: '' };
const PG = { autoPk: 'SERIAL PRIMARY KEY', ph: (i: number) => `$${i}`, ret: ' RETURNING id' };

const withTimeout = (p: Promise<any>, ms: number) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

// Assumes the driver is already connected. Exercises the full contract, then closes (finally).
async function runContract(driver: any, d: any) {
    try {
        await driver.exec('DROP TABLE IF EXISTS conf_test');
        await driver.exec(`CREATE TABLE conf_test (id ${d.autoPk}, name TEXT, n INTEGER)`);

        const ins = await driver.run(`INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`, ['alpha', 1]);
        assert.ok(ins && ins.lastID, `run(INSERT) must return a truthy lastID, got ${JSON.stringify(ins)}`);
        assert.strictEqual(ins.changes, 1, 'run(INSERT) changes must be 1');
        await driver.run(`INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`, ['beta', 2]);

        const row = await driver.get(`SELECT name, n FROM conf_test WHERE name = ${d.ph(1)}`, ['alpha']);
        assert.ok(row, 'get() must return the row');
        assert.strictEqual(row.name, 'alpha');
        assert.strictEqual(Number(row.n), 1, 'get() must bind params correctly');

        const rows = await driver.all('SELECT id, name FROM conf_test ORDER BY id');
        assert.strictEqual(rows.length, 2, 'all() must return both rows');

        const upd = await driver.run(`UPDATE conf_test SET n = ${d.ph(1)} WHERE name = ${d.ph(2)}`, [99, 'alpha']);
        assert.strictEqual(upd.changes, 1, 'run(UPDATE) changes must be 1');
        const row2 = await driver.get(`SELECT n FROM conf_test WHERE name = ${d.ph(1)}`, ['alpha']);
        assert.strictEqual(Number(row2.n), 99, 'UPDATE must persist');

        const del = await driver.run(`DELETE FROM conf_test WHERE name = ${d.ph(1)}`, ['beta']);
        assert.strictEqual(del.changes, 1, 'run(DELETE) changes must be 1');
        const remaining = await driver.all('SELECT id FROM conf_test');
        assert.strictEqual(remaining.length, 1, 'DELETE must remove exactly one row');

        await driver.exec('DROP TABLE conf_test');
    } finally {
        try { await driver.close(); } catch { /* */ }
    }
}

// --- SQLite native (better-sqlite3): the canonical driver. Runs against a throwaway temp DB. ---
test('driver conformance: sqlite-native (better-sqlite3) satisfies the interface contract', async (t: any) => {
    const tmp = path.join(os.tmpdir(), `wordjs-conf-${process.pid}-${Date.now()}.db`);
    let driver: any;
    try {
        driver = require('../drivers/sqlite-native-async');
    } catch (e: any) {
        // Native binary unavailable here — that's exactly the sql.js fallback case, not a contract bug.
        return (t as any).skip(`better-sqlite3 not loadable (fallback env): ${e && e.message}`);
    }
    driver.dbPath = tmp; // override the singleton's path so we never touch the real DB
    await driver.connect();
    await runContract(driver, SQLITE);
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

// --- Postgres (pg client): only if an external Postgres is reachable, otherwise skip. ---
test('driver conformance: postgres satisfies the interface contract (skipped if no PG reachable)', async (t: any) => {
    let driver: any;
    try {
        driver = require('../drivers/postgres');
    } catch (e: any) {
        return (t as any).skip(`pg driver not loadable: ${e && e.message}`);
    }
    try {
        await withTimeout(driver.connect(), 3000);
    } catch (e: any) {
        return (t as any).skip(`no reachable Postgres: ${e && e.message}`);
    }
    await runContract(driver, PG);
});
