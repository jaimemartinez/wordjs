/**
 * WordJS - Plugin uninstall cleanup tests.
 * uninstallPluginData() must ALWAYS remove grants (security: a re-uploaded slug must not inherit old
 * grants) + crash strikes, and DROP the plugin's wjp_<slug>_* tables only when dropTables is set.
 *
 * Temp-DB isolation: repoint config.dbPath BEFORE requiring ../config/database (see api.test.ts).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-uninstall-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

describe('plugin uninstall cleanup', () => {
    let dbAsync: any;
    let uninstallPluginData: any;
    let getOption: any, updateOption: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        ({ getOption, updateOption } = require('../core/options'));
        ({ uninstallPluginData } = require('../core/plugins'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    });

    const tableExists = async (name: string) => {
        const r = await dbAsync.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
        return !!r;
    };

    it('dropTables=true: removes grants + drops only the plugin\'s wjp_ tables', async () => {
        // A plugin's own table + a neighbour plugin's table that must survive.
        await dbAsync.run('CREATE TABLE wjp_unins_test_data (id INTEGER PRIMARY KEY, v TEXT)');
        await dbAsync.run("INSERT INTO wjp_unins_test_data (v) VALUES ('x')");
        await dbAsync.run('CREATE TABLE wjp_other_plugin_data (id INTEGER PRIMARY KEY)');
        await updateOption('plugin_grants', { 'unins-test': ['database:write'], 'other-plugin': ['settings:read'] });

        const r = await uninstallPluginData('unins-test', { dropTables: true });

        assert.strictEqual(r.grantsRemoved, true);
        assert.strictEqual(r.strikesCleared, true);
        assert.ok(r.tablesDropped.includes('wjp_unins_test_data'), 'reported dropping its table');
        assert.strictEqual(await tableExists('wjp_unins_test_data'), false, 'own table dropped');
        assert.strictEqual(await tableExists('wjp_other_plugin_data'), true, 'neighbour table untouched');

        const grants = await getOption('plugin_grants', {});
        assert.ok(!('unins-test' in grants), 'own grant removed');
        assert.ok('other-plugin' in grants, 'neighbour grant preserved');
    });

    it('dropTables=false (default): removes grants but KEEPS data tables (WordPress parity)', async () => {
        await dbAsync.run('CREATE TABLE wjp_keepme_data (id INTEGER PRIMARY KEY)');
        await updateOption('plugin_grants', { 'keepme': ['database:write'] });

        const r = await uninstallPluginData('keepme'); // dropTables defaults false

        assert.strictEqual(r.grantsRemoved, true);
        assert.strictEqual(r.tablesDropped.length, 0, 'no tables dropped');
        assert.strictEqual(await tableExists('wjp_keepme_data'), true, 'data table preserved');
        const grants = await getOption('plugin_grants', {});
        assert.ok(!('keepme' in grants), 'grant still removed');
    });
});
