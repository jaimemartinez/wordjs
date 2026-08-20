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

// clearTimeout is load-bearing, not tidiness: if the race is decided by `p` (e.g. connect() rejects
// fast with ECONNREFUSED in the no-DB `Test` step) the timer is left ARMED and, being ref'd, keeps this
// test-file subprocess's event loop alive for the full `ms` after the suite is done. `--test-force-exit`
// then HARD-KILLS the still-live subprocess, racing its final IPC result flush to the runner → the
// intermittent "Unable to deserialize cloned data" file-level failure. Draining the timer lets the
// subprocess exit cleanly on its own, so force-exit never has to kill it mid-message.
const withTimeout = (p: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

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

        // --- F3 pinned transaction contract -------------------------------------------------------
        const committed = await driver.transaction(async (tx: any) => {
            const inserted = await tx.run(
                `INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`,
                ['tx-commit', 7]
            );
            const visible = await tx.get(`SELECT name FROM conf_test WHERE name = ${d.ph(1)}`, ['tx-commit']);
            assert.strictEqual(visible.name, 'tx-commit', 'the pinned connection sees its own uncommitted write');
            return inserted.lastID;
        });
        assert.ok(committed, 'transaction returns the callback value');
        assert.ok(await driver.get(`SELECT name FROM conf_test WHERE name = ${d.ph(1)}`, ['tx-commit']), 'COMMIT persists every write');

        await assert.rejects(
            driver.transaction(async (tx: any) => {
                await tx.run(`INSERT INTO conf_test (name, n) VALUES (${d.ph(1)}, ${d.ph(2)})${d.ret}`, ['tx-rollback', 8]);
                throw new Error('EXPECTED_F3_ROLLBACK');
            }),
            /EXPECTED_F3_ROLLBACK/
        );
        assert.strictEqual(
            await driver.get(`SELECT name FROM conf_test WHERE name = ${d.ph(1)}`, ['tx-rollback']),
            undefined,
            'ROLLBACK leaves no partial row'
        );

        // --- F4 declarative revision restore -----------------------------------------------------
        // Execute the exact portable shape used by core/revisions: allowlisted dynamic column UPDATE,
        // explicit meta-id DELETE, raw INSERT, all on the driver's pinned transaction. This runs on
        // real PostgreSQL/MySQL in CI, so "transactional on three engines" is executable, not inferred
        // from the SQLite unit suite.
        await driver.exec('DROP TABLE IF EXISTS conf_revision_meta');
        await driver.exec('DROP TABLE IF EXISTS conf_revision_posts');
        await driver.exec(`CREATE TABLE conf_revision_posts (
            id ${d.autoPk}, post_title TEXT, post_content TEXT, post_excerpt TEXT, post_status TEXT
        )`);
        await driver.exec(`CREATE TABLE conf_revision_meta (
            meta_id ${d.autoPk}, post_id INTEGER NOT NULL, meta_key TEXT, meta_value TEXT
        )`);
        const parent = await driver.run(
            `INSERT INTO conf_revision_posts (post_title, post_content, post_excerpt, post_status)
             VALUES (${d.ph(1)}, ${d.ph(2)}, ${d.ph(3)}, ${d.ph(4)})${d.ret}`,
            ['live title', 'live body', 'live excerpt', 'draft']
        );
        await driver.run(
            `INSERT INTO conf_revision_meta (post_id, meta_key, meta_value)
             VALUES (${d.ph(1)}, ${d.ph(2)}, ${d.ph(3)})`,
            [parent.lastID, 'plugin_rating', '9']
        );
        await driver.run(
            `INSERT INTO conf_revision_meta (post_id, meta_key, meta_value)
             VALUES (${d.ph(1)}, ${d.ph(2)}, ${d.ph(3)})`,
            [parent.lastID, 'plugin_unrelated', 'keep']
        );

        await driver.transaction(async (tx: any) => {
            await tx.run(
                `UPDATE conf_revision_posts SET post_title = ${d.ph(1)}, post_content = ${d.ph(2)} WHERE id = ${d.ph(3)}`,
                ['snapshot title', 'snapshot body', parent.lastID]
            );
            const owned = await tx.all(
                `SELECT meta_id FROM conf_revision_meta WHERE post_id = ${d.ph(1)} AND meta_key = ${d.ph(2)}`,
                [parent.lastID, 'plugin_rating']
            );
            const ownedIds = owned.map((row: any) => row.meta_id);
            if (ownedIds.length > 0) {
                const ids = ownedIds.map((_: any, index: number) => d.ph(index + 1)).join(',');
                await tx.run(`DELETE FROM conf_revision_meta WHERE meta_id IN (${ids})`, ownedIds);
            }
            await tx.run(
                `INSERT INTO conf_revision_meta (post_id, meta_key, meta_value)
                 VALUES (${d.ph(1)}, ${d.ph(2)}, ${d.ph(3)})`,
                [parent.lastID, 'plugin_rating', '3']
            );
        });
        const restoredRevision = await driver.get(
            `SELECT post_title, post_content FROM conf_revision_posts WHERE id = ${d.ph(1)}`,
            [parent.lastID]
        );
        assert.deepStrictEqual(
            { title: restoredRevision.post_title, content: restoredRevision.post_content },
            { title: 'snapshot title', content: 'snapshot body' },
            'F4 restore columns commit together'
        );
        assert.strictEqual(
            (await driver.get(
                `SELECT meta_value FROM conf_revision_meta WHERE post_id = ${d.ph(1)} AND meta_key = ${d.ph(2)}`,
                [parent.lastID, 'plugin_rating']
            )).meta_value,
            '3',
            'F4 declared plugin meta is restored'
        );
        assert.strictEqual(
            (await driver.get(
                `SELECT meta_value FROM conf_revision_meta WHERE post_id = ${d.ph(1)} AND meta_key = ${d.ph(2)}`,
                [parent.lastID, 'plugin_unrelated']
            )).meta_value,
            'keep',
            'F4 undeclared plugin meta survives'
        );
        await assert.rejects(
            driver.transaction(async (tx: any) => {
                await tx.run(
                    `UPDATE conf_revision_posts SET post_title = ${d.ph(1)} WHERE id = ${d.ph(2)}`,
                    ['partial title', parent.lastID]
                );
                await tx.run(
                    `DELETE FROM conf_revision_meta WHERE post_id = ${d.ph(1)} AND meta_key = ${d.ph(2)}`,
                    [parent.lastID, 'plugin_rating']
                );
                throw new Error('EXPECTED_F4_ROLLBACK');
            }),
            /EXPECTED_F4_ROLLBACK/
        );
        assert.strictEqual(
            (await driver.get(`SELECT post_title FROM conf_revision_posts WHERE id = ${d.ph(1)}`, [parent.lastID])).post_title,
            'snapshot title',
            'F4 injected failure rolls columns back'
        );
        assert.ok(
            await driver.get(
                `SELECT meta_id FROM conf_revision_meta WHERE post_id = ${d.ph(1)} AND meta_key = ${d.ph(2)}`,
                [parent.lastID, 'plugin_rating']
            ),
            'F4 injected failure rolls metadata back'
        );
        await driver.exec('DROP TABLE conf_revision_meta');
        await driver.exec('DROP TABLE conf_revision_posts');

        // The portable SQL forms used by migration 0014 and the lease worker must execute on every
        // real engine, not merely parse in a SQLite-only unit test.
        await driver.exec('DROP TABLE IF EXISTS conf_outbox');
        await driver.exec(`CREATE TABLE conf_outbox (
            id ${d.autoPk}, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            available_at INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claimed_until INTEGER,
            source_event_id TEXT
        )`);
        await driver.exec('CREATE UNIQUE INDEX idx_conf_source_event ON conf_outbox (source_event_id, event_type)');
        const eventInsert = await driver.run(
            `INSERT INTO conf_outbox (event_id, event_type, available_at) VALUES (${d.ph(1)}, ${d.ph(2)}, ${d.ph(3)})${d.ret}`,
            ['evt-1', 'post.updated', 0]
        );
        const claimed = await driver.run(
            `UPDATE conf_outbox SET status = 'processing', attempts = attempts + 1,
             claim_token = ${d.ph(1)}, claimed_until = ${d.ph(2)}
             WHERE id = ${d.ph(3)} AND status = 'pending' AND available_at <= ${d.ph(4)}`,
            ['lease-1', 60, eventInsert.lastID, 0]
        );
        assert.strictEqual(claimed.changes, 1, 'the guarded F3 lease claim is atomic and portable');
        const lostRace = await driver.run(
            `UPDATE conf_outbox SET claim_token = ${d.ph(1)}
             WHERE id = ${d.ph(2)} AND status = 'pending' AND available_at <= ${d.ph(3)}`,
            ['lease-2', eventInsert.lastID, 0]
        );
        assert.strictEqual(lostRace.changes, 0, 'a second worker cannot claim the leased event');

        await driver.exec('DROP TABLE conf_outbox');
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
