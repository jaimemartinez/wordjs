/**
 * Schema-migration runner contract: pending migrations apply once, are recorded in
 * `schema_migrations`, re-runs are idempotent, and a failing migration aborts (fail-closed) without
 * being recorded. Runs against a throwaway sqlite-native temp DB (skips if the native binary isn't
 * loadable — the sql.js fallback case).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

require('../config/app'); // preload config (host context)
const { runSchemaMigrations } = require('../core/schema-migrations');

const cleanup = (tmp: string) => {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
};

test('schema-migrations: applies pending, records it, and is idempotent on re-run', async (t: any) => {
    const tmp = path.join(os.tmpdir(), `wordjs-mig-${process.pid}-${Date.now()}.db`);
    let driver: any;
    try { driver = require('../drivers/sqlite-native-async'); }
    catch (e: any) { return (t as any).skip(`better-sqlite3 not loadable (fallback env): ${e && e.message}`); }
    driver.dbPath = tmp; // override the singleton's path so we never touch the real DB
    await driver.connect();
    try {
        let ran = 0;
        const mig = {
            id: '9999_test_migration',
            up: async (ctx: any) => {
                ran++;
                await ctx.exec('CREATE TABLE IF NOT EXISTS mig_test (id INTEGER PRIMARY KEY, v TEXT)');
                await ctx.run('INSERT INTO mig_test (v) VALUES (?)', ['x']);
            }
        };

        await runSchemaMigrations(driver, true, 'sqlite-native', [mig]);
        assert.strictEqual(ran, 1, 'migration up() should run exactly once');
        const recorded = await driver.get('SELECT id FROM schema_migrations WHERE id = ?', ['9999_test_migration']);
        assert.ok(recorded, 'applied migration must be recorded in schema_migrations');
        assert.strictEqual((await driver.all('SELECT * FROM mig_test')).length, 1, 'migration effect applied once');

        // Re-run with the same list — already applied, so it must be skipped (idempotent).
        await runSchemaMigrations(driver, true, 'sqlite-native', [mig]);
        assert.strictEqual(ran, 1, 'migration up() must NOT run again on re-run');
        assert.strictEqual((await driver.all('SELECT * FROM mig_test')).length, 1, 'no duplicate effect on re-run');
    } finally {
        try { await driver.close(); } catch { /* */ }
        cleanup(tmp);
    }
});

test('schema-migrations: a failing migration aborts (fail-closed) and is not recorded', async (t: any) => {
    const tmp = path.join(os.tmpdir(), `wordjs-migf-${process.pid}-${Date.now()}.db`);
    let driver: any;
    try { driver = require('../drivers/sqlite-native-async'); }
    catch (e: any) { return (t as any).skip(`better-sqlite3 not loadable (fallback env): ${e && e.message}`); }
    driver.dbPath = tmp;
    await driver.connect();
    try {
        const bad = { id: 'bad_001', up: async (ctx: any) => { await ctx.exec('THIS IS NOT VALID SQL'); } };
        await assert.rejects(
            () => runSchemaMigrations(driver, true, 'sqlite-native', [bad]),
            'a failing migration must throw (fail-closed)'
        );
        const recorded = await driver.get('SELECT id FROM schema_migrations WHERE id = ?', ['bad_001']);
        assert.ok(!recorded, 'a failed migration must NOT be recorded as applied');
    } finally {
        try { await driver.close(); } catch { /* */ }
        cleanup(tmp);
    }
});
