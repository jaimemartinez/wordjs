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
// MySQL speaks the SQLite dialect AT THE APP BOUNDARY — the driver's translateCreateTable/translateSql
// rewrite it before it hits mysqld (AUTOINCREMENT→AUTO_INCREMENT, TEXT→VARCHAR, '?' stays '?',
// insertId→lastID). So we deliberately feed the SAME SQLite-dialect SQL the app emits and assert the
// TRANSLATED result actually runs on a real MySQL 8 — this block is the only CI coverage of that layer.
const MYSQL = { autoPk: 'INTEGER PRIMARY KEY AUTOINCREMENT', ph: (_i: number) => '?', ret: '' };

const withTimeout = (p: Promise<any>, ms: number) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

// A missing backend is a graceful skip locally, but in CI (WORDJS_CI_DB=1) the service container is
// wired precisely so the driver IS exercised — there, an unreachable/unloadable driver is a hard
// FAILURE, never a silent green. Keeps the postgres+mysql conformance from quietly no-op'ing in CI.
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

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

        // --- Revision-prune portability (regression for core/revisions.ts limitRevisions) ---
        // Pick the N oldest ids with a top-level `ORDER BY ... LIMIT ?`, THEN delete by an explicit id list.
        // The tempting one-shot `DELETE FROM t WHERE id IN (SELECT id FROM t ORDER BY ... LIMIT ?)` works on
        // SQLite + Postgres but MySQL rejects it twice over: ER 1093 (can't modify + select the same table in
        // a subquery) and ER 1235 (LIMIT is unsupported inside an IN-subquery). This select-then-delete form
        // must therefore hold on EVERY driver. conf_test currently holds one row (alpha, n=99); add two low-n
        // rows so the "oldest two" pick is deterministic and alpha must survive.
        await driver.run(`INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`, ['gamma', 5]);
        await driver.run(`INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`, ['delta', 6]);
        const oldest = await driver.all(`SELECT id FROM conf_test ORDER BY n ASC LIMIT ${d.ph(1)}`, [2]);
        assert.strictEqual(oldest.length, 2, 'ORDER BY ... LIMIT ? must return exactly the 2 oldest ids');
        const pruneIds = oldest.map((r: any) => r.id);
        const inList = pruneIds.map((_: any, i: number) => d.ph(i + 1)).join(',');
        const pruned = await driver.run(`DELETE FROM conf_test WHERE id IN (${inList})`, pruneIds);
        assert.strictEqual(pruned.changes, 2, 'DELETE ... WHERE id IN (<list>) must remove exactly the 2 picked rows');
        const afterPrune = await driver.all('SELECT name FROM conf_test');
        assert.strictEqual(afterPrune.length, 1, 'exactly the un-pruned row must remain');
        assert.strictEqual(afterPrune[0].name, 'alpha', 'the high-n row (alpha) must survive the prune');

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
        return skipOrFail(t, `pg driver not loadable: ${e && e.message}`);
    }
    try {
        // No explicit config: connect() falls back to config.db, whose defaults (localhost:5432,
        // user postgres, password 'password', db 'wordjs') match the CI postgres:16 service.
        await withTimeout(driver.connect(), 3000);
    } catch (e: any) {
        return skipOrFail(t, `no reachable Postgres: ${e && e.message}`);
    }
    await runContract(driver, PG);
});

// --- MySQL (mysql2 client): SQLite-dialect in, driver TRANSLATES. Runs against a real MySQL if reachable. ---
test('driver conformance: mysql satisfies the interface contract (skipped if no MySQL reachable)', async (t: any) => {
    let driver: any;
    try {
        driver = require('../drivers/mysql');
    } catch (e: any) {
        return skipOrFail(t, `mysql2 driver not loadable: ${e && e.message}`);
    }
    // config.db's port default is 5432 (Postgres), so MySQL must be pointed EXPLICITLY. Coordinates come
    // from env with defaults matching the CI mysql:8 service (127.0.0.1:3306, root/password, db 'wordjs').
    // 127.0.0.1 (not 'localhost') forces TCP so mysql2 doesn't try a non-existent unix socket.
    driver.config = {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
    try {
        await withTimeout(driver.connect(), 5000);
    } catch (e: any) {
        return skipOrFail(t, `no reachable MySQL: ${e && e.message}`);
    }
    await runContract(driver, MYSQL);
});
