/**
 * "DELETE THIS PLUGIN'S DATA" LEAVES NOTHING OF THE PLUGIN IN THE SITE (S4-21), AND THE HOST'S OWN SCAN OF
 * THE INSTALL TREE IS NOT JUDGED AS THE PLUGIN (X4-15).
 *
 * QA deleted mail-server with "also delete its data": the tables went, but its options (mail_port,
 * mail_domain…), the accounts' `mail_server_mailbox` capability and its private storage directory stayed, so
 * a reinstall inherited the configuration the administrator had asked to erase. And every queue pass logged
 * "tried to READ outside safe zones: …/backend/plugins": the host scanning the install tree to resolve account
 * capabilities while serving the plugin's bridged call, refused under the plugin's context.
 *
 * Real SQLite database, real options/user_meta rows, a real probe plugin folder under backend/plugins.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-uninstall-data-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const { installSecureRequire } = require('../core/secure-require');
installSecureRequire();
const database = require('../config/database');
const { runWithContext } = require('../core/plugin-context');

const BACKEND = path.resolve(__dirname, '..', '..');
const SLUG = `zz-uninstall-probe-${process.pid}`;
const OTHER = `zz-uninstall-other-${process.pid}`;
const CAP = 'zz_probe_mailbox';
const PROBE_DIR = path.join(BACKEND, 'plugins', SLUG);
// A plugin's own options are named after its slug (the options bridge's write allowlist).
const NS = `zz_uninstall_probe_${process.pid}_`;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROBE_DIR, 'manifest.json'), JSON.stringify({
        name: 'Uninstall probe', version: '1.0.0', isolated: true,
        permissions: [{ scope: 'settings', access: 'read' }, { scope: 'settings', access: 'write' }],
        accountCapabilities: [{ slug: CAP, name: 'Probe mailbox' }],
    }));
    fs.writeFileSync(path.join(PROBE_DIR, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['settings:read', 'settings:write']);
});

after(async () => {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

test('the options bridge records only the options a plugin CREATES — never a setting the site already had', async () => {
    const { getOption, updateOption } = require('../core/options');
    const { optionsOwnedBy } = require('../core/plugin-owned-options');
    await updateOption('blogname', 'My site'); // a core setting that exists before the plugin touches it
    const api = require('../core/plugin-api').createPluginApi(SLUG);
    await runWithContext(SLUG, () => api.options.set(`${NS}port`, '2525'));
    await runWithContext(SLUG, () => api.options.set(`${NS}domain`, 'mail.example.test'));
    // A site setting is not the plugin's to write at all, so it can never become the plugin's either.
    await assert.rejects(() => runWithContext(SLUG, () => api.options.set('blogname', 'Renamed by the plugin')), /not writable by plugins/);
    assert.deepStrictEqual((await optionsOwnedBy(SLUG)).sort(), [`${NS}domain`, `${NS}port`]);
    assert.strictEqual(await getOption(`${NS}port`), 2525);
    assert.strictEqual(await getOption('blogname'), 'My site');
});

test('the ledger itself is off-limits to plugins', () => {
    const { isProtectedOption } = require('../core/plugin-api');
    assert.strictEqual(isProtectedOption('plugin_owned_options', SLUG), true);
});

test('delete-with-data removes its options, revokes its account capability, drops its storage and its egress approval', async () => {
    const { getOption, updateOption } = require('../core/options');
    const { dbAsync } = database;
    const core = require('../core/plugins');
    const perms = require('../core/plugin-permissions');
    // Another plugin cannot record this plugin's option — nor a site setting — as its own.
    await runWithContext(OTHER, () => require('../core/plugin-owned-options').noteOptionWrite(OTHER, `${NS}port`));
    await runWithContext(OTHER, () => require('../core/plugin-owned-options').noteOptionWrite(OTHER, 'zz_shared_key'));
    await updateOption('zz_shared_key', 'x');
    assert.deepStrictEqual(await require('../core/plugin-owned-options').optionsOwnedBy(OTHER), []);

    // Two accounts hold the capability the plugin declared.
    await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [101, `account_capability:${CAP}`, '1']);
    await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [102, `account_capability:${CAP}`, '1']);
    // Its private storage on disk.
    const { privateStorageDirs } = require('../core/sandbox-paths');
    for (const d of privateStorageDirs(BACKEND, SLUG, 1)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'k'), 'x'); }
    // An approved private relay.
    await perms.loadGrants(); await perms.loadEgressHosts();
    await perms.setGrants(SLUG, ['settings:read', 'settings:write', 'network']);
    await perms.applyPrivateDestinations(SLUG, ['192.168.182.191:25']);

    const result = await core.uninstallPluginData(SLUG, { dropTables: true, accountCapabilities: [CAP] });

    assert.deepStrictEqual(result.optionsRemoved.sort(), [`${NS}domain`, `${NS}port`]);
    assert.strictEqual(await getOption(`${NS}port`, null), null, 'the plugin option survived');
    assert.strictEqual(await getOption('zz_shared_key', null), 'x', 'an option the plugin never owned was deleted');
    assert.strictEqual(await getOption('blogname', null), 'My site', 'a core setting was deleted');

    assert.strictEqual(result.accountCapabilitiesRevoked, 2);
    assert.deepStrictEqual(await dbAsync.all('SELECT user_id FROM user_meta WHERE meta_key = ?', [`account_capability:${CAP}`]), []);

    for (const d of privateStorageDirs(BACKEND, SLUG, 1)) assert.strictEqual(fs.existsSync(d), false, `storage left behind: ${d}`);

    const egress = await getOption('plugin_egress_hosts', {});
    assert.ok(!Object.prototype.hasOwnProperty.call(egress || {}, SLUG), `the egress approval survived: ${JSON.stringify(egress)}`);
});

test('delete WITHOUT data keeps the options, the capability grants and the storage (WordPress parity)', async () => {
    const core = require('../core/plugins');
    const { getOption } = require('../core/options');
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['settings:read', 'settings:write']); // the previous delete removed them
    const api = require('../core/plugin-api').createPluginApi(SLUG);
    await runWithContext(SLUG, () => api.options.set(`${NS}keep`, 'kept'));
    await database.dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [103, `account_capability:${CAP}`, '1']);
    const result = await core.uninstallPluginData(SLUG, { dropTables: false, accountCapabilities: [CAP] });
    assert.strictEqual(result.optionsRemoved, undefined);
    assert.strictEqual(await getOption(`${NS}keep`, null), 'kept');
    assert.strictEqual((await database.dbAsync.all('SELECT user_id FROM user_meta WHERE meta_key = ?', [`account_capability:${CAP}`])).length, 1);
});

test("X4-15: the host's scan of the install tree inside a plugin's bridged call is the host's, not the plugin's", () => {
    const { scanPlugins } = require('../core/plugins');
    const seen = runWithContext('mail-server', () => scanPlugins().map((p: any) => p.slug));
    assert.ok(seen.includes(SLUG), 'the scan was refused (or came back empty) under the plugin context');
});
