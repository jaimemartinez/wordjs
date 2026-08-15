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
const { runSchemaMigrations, MIGRATIONS } = require('../core/schema-migrations');

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

test('0011 multilingual: adds post_language + translation_group + index to an EXISTING posts table, idempotently', async (t: any) => {
    const tmp = path.join(os.tmpdir(), `wordjs-mig11-${process.pid}-${Date.now()}.db`);
    let driver: any;
    try { driver = require('../drivers/sqlite-native-async'); }
    catch (e: any) { return (t as any).skip(`better-sqlite3 not loadable (fallback env): ${e && e.message}`); }
    driver.dbPath = tmp;
    await driver.connect();
    try {
        const mig = MIGRATIONS.find((m: any) => m.id === '0011_posts_multilingual');
        assert.ok(mig, '0011_posts_multilingual must be registered in MIGRATIONS');

        // A PRE-release posts table: the two multilingual columns are deliberately ABSENT, exactly as an
        // existing install's table looks before this migration runs.
        await driver.exec(
            "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, post_title TEXT, " +
            "post_name TEXT, post_type TEXT DEFAULT 'post', post_status TEXT DEFAULT 'publish')"
        );
        const colNames = async (): Promise<string[]> =>
            (await driver.all('PRAGMA table_info(posts)')).map((r: any) => r.name);
        const before = await colNames();
        assert.ok(!before.includes('post_language'), 'precondition: post_language absent');
        assert.ok(!before.includes('translation_group'), 'precondition: translation_group absent');

        // First run: the columns AND the group index must appear.
        await runSchemaMigrations(driver, true, 'sqlite-native', [mig]);
        const after = await colNames();
        assert.ok(after.includes('post_language'), '0011 must add post_language');
        assert.ok(after.includes('translation_group'), '0011 must add translation_group');
        const idx = await driver.get(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_translation_group'"
        );
        assert.ok(idx, '0011 must create idx_posts_translation_group');

        // Recorded as applied, so a second boot skips it entirely.
        const rec = await driver.get('SELECT id FROM schema_migrations WHERE id = ?', ['0011_posts_multilingual']);
        assert.ok(rec, '0011 must be recorded as applied');

        // Re-run with the SAME migration list against the now-migrated DB: it is already recorded, so up()
        // does not run again — and even if it did, the column-existence probe makes it a clean no-op. Prove
        // it does not throw and the schema is unchanged.
        await runSchemaMigrations(driver, true, 'sqlite-native', [mig]);
        const afterRe = await colNames();
        assert.strictEqual(
            afterRe.filter((c) => c === 'post_language' || c === 'translation_group').length, 2,
            're-run must not duplicate or drop the columns'
        );
    } finally {
        try { await driver.close(); } catch { /* */ }
        cleanup(tmp);
    }
});

// MUTATION PROOF for idempotency: force the migration to run against a DB that ALREADY has the columns
// (a fresh install where initializeSchema created them, then 0011 runs). With a fresh migration id so the
// runner actually invokes up(), up() must NOT throw "duplicate column name" — it is guarded twice (the
// column-existence probe skips the ADD, and the catch swallows a duplicate-column error as a fallback).
// Removing BOTH guards makes this test fail, which is what pins the idempotency contract.
test('0011 multilingual: up() is a no-op when the columns already exist (probe works)', async (t: any) => {
    const tmp = path.join(os.tmpdir(), `wordjs-mig11b-${process.pid}-${Date.now()}.db`);
    let driver: any;
    try { driver = require('../drivers/sqlite-native-async'); }
    catch (e: any) { return (t as any).skip(`better-sqlite3 not loadable (fallback env): ${e && e.message}`); }
    driver.dbPath = tmp;
    await driver.connect();
    try {
        const mig = MIGRATIONS.find((m: any) => m.id === '0011_posts_multilingual');
        // The columns are ALREADY present (as on a fresh install after initializeSchema).
        await driver.exec(
            'CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, post_name TEXT, ' +
            'post_language TEXT, translation_group TEXT)'
        );
        // Run under a DISTINCT id so runSchemaMigrations actually calls up() (0011 would be "already
        // applied" only if recorded — here it is not, so up() runs against the columns-present table).
        await runSchemaMigrations(driver, true, 'sqlite-native', [{ id: mig.id, up: mig.up }]);
        // Reaching here without a throw is the assertion: the probe skipped the ADD COLUMN. Index present.
        const idx = await driver.get(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_translation_group'"
        );
        assert.ok(idx, 'index must still be ensured when columns pre-exist');
    } finally {
        try { await driver.close(); } catch { /* */ }
        cleanup(tmp);
    }
});
