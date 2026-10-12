/**
 * A FAILED INSTALL, ITS RETRY AND THE ONE-TIME browser:script UPGRADE — driven through POST /setup/install.
 *
 * Two rules meet in the installer:
 *   · a failure before the administrator account exists puts wordjs-config.json back as it was, so the
 *     wizard can simply be run again — in the SAME process, possibly against another database (the
 *     operator fixes the cause, or picks another driver);
 *   · the site the wizard creates records the one-time browser:script upgrade as done
 *     (core/plugins recordFreshInstallBrowserCapability), unless the database it installs into already
 *     has active plugins: those are left to the upgrade, which grants browser:script to an already-active
 *     plugin that ships browser code, so an upgrade does not take a working plugin's admin pages away.
 *
 * What this file proves, with the REAL install handler (routes/setup.ts), the REAL config writer and REAL
 * SQLite databases in a temp working directory:
 *   1. a failed attempt leaves no plugin policy behind: the grant store of the database it created holds
 *      the host's own record and nothing else;
 *   2. a retry against that database keeps the marker as the first attempt wrote it;
 *   3. a retry against ANOTHER database, one that already has an active plugin with browser code, decides
 *      on THAT database: no marker is recorded there, and the next boot grants browser:script to that
 *      plugin. The decision reads the active set from the database, not through the option cache, which
 *      still holds what the failed attempt read in the other database.
 *
 * What the installer touches outside the temp directory (certificates, the default theme, the core
 * self-tests, the cluster distributor, the install-token file, the site-address watcher, the frontend
 * purge) is replaced on the real modules; the default theme is where an attempt is made to fail, after
 * the marker step and before the administrator account.
 *
 * MUTATION PROOF: make recordFreshInstallBrowserCapability read the active set with getActivePlugins()
 * (through the option cache) and test 3 fails — the marker is recorded on the database with an active
 * plugin, and the restart grants it nothing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The working directory FIRST: core/configManager resolves wordjs-config.json against it at load, the
// installer's database paths are relative to it, and core/plugins resolves its plugins folder against it.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-install-retry-bc-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);
fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });

// config/app.ts anchors the same file to backend/wordjs-config.json. Point that one path at the sandbox,
// so a developer's real config is never read or rewritten by this test.
const SANDBOX_CONFIG = path.join(TMP_ROOT, 'wordjs-config.json');
const ANCHORED_CONFIG = path.resolve(__dirname, '..', '..', 'wordjs-config.json');
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const redirect = (p: any) =>
    (typeof p === 'string' && norm(path.resolve(p)) === norm(ANCHORED_CONFIG) ? SANDBOX_CONFIG : p);
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p: any, ...rest: any[]) => realFs.existsSync(redirect(p), ...rest);
fs.readFileSync = (p: any, ...rest: any[]) => realFs.readFileSync(redirect(p), ...rest);
fs.writeFileSync = (p: any, ...rest: any[]) => realFs.writeFileSync(redirect(p), ...rest);

const INSTALL_TOKEN = 'install-retry-browser-capability-token';
const LEGACY = `wjs-retry-bc-${process.pid}`;
// The installer's database files: sqlite-legacy → './data/wordjs.db', sqlite-native → './data/wordjs-native.db'.
const FRESH_DRIVER = 'sqlite-legacy';
const EXISTING_DRIVER = 'sqlite-native';

// What the installer reaches beyond the temp directory, replaced ON the modules it requires at call time
// (the token check is destructured when routes/setup.ts loads, so it is replaced before that).
const installToken = require('../core/install-token');
installToken.verifyInstallToken = (t: unknown) => t === INSTALL_TOKEN;
installToken.clearInstallTokenFile = () => {};
const certManager = require('../core/certManager');
certManager.generateClusterCA = () => ({ key: 'stub-ca-key', cert: 'stub-ca-cert' });
certManager.generateServiceCert = () => {};
let failAtTheme = false;
require('../core/themes').createDefaultTheme = () => {
    if (failAtTheme) throw new Error('stubbed failure while provisioning the default theme');
};
require('../core/plugin-test-runner').runCoreTests = async () => ({ success: true, tests: 0, passed: 0, failed: 0 });
require('../core/site-address').ensureStarted = async () => {};
require('../core/frontend-purge').purgeFrontend = () => {};

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const config = require('../config/app');
const database = require('../config/database');
const configManager = require('../core/configManager');

/** Hold console output while the installer narrates (async writes can corrupt the runner's frames). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = console.info = console.warn = console.error = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
}

/** POST /setup/install, as the wizard sends it, against `dbDriver`. */
async function install(dbDriver: string) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/setup', require('../routes/setup'));
    return quietly(() => request(app).post('/setup/install')
        .set('x-install-token', INSTALL_TOKEN)
        .send({
            siteName: 'Retry site',
            adminUser: 'retry-admin',
            adminEmail: 'retry@example.test',
            adminPassword: 'Retry-Admin-Pass-1',
            dbDriver,
            demoContent: false,
            siteUrl: 'http://localhost:3000',
        }));
}

/** Point the live config and the driver layer at one of the installer's databases. */
async function useDatabase(dbDriver: string) {
    Object.assign(config, { dbDriver, dbPath: dbDriver === 'sqlite-native' ? './data/wordjs-native.db' : './data/wordjs.db' });
    await database.init({ driver: dbDriver });
}

const installed = () => { configManager.invalidateConfigCache(); return configManager.isInstalled(); };

describe('a failed install, its retry and the browser:script upgrade', () => {
    let core: any, perms: any, options: any;
    let firstMarker: any = null;
    const savedEmbedded = process.env.WORDJS_EMBEDDED;

    /** index.ts's boot sequence for grants, verbatim in order. */
    async function restart(): Promise<string[]> {
        await perms.loadGrants();
        const active: string[] = await core.getActivePlugins();
        const all: any[] = await core.getAllPlugins();
        const entries = all.filter((p: any) => active.includes(p.slug)).map((p: any) => ({
            slug: p.slug,
            requested: Array.from(new Set((p.permissions || []).map((perm: any) => `${perm.scope}:${perm.access || 'read'}`))) as string[],
        }));
        await perms.backfillActive(entries);
        return core.migrateBrowserCapabilityGrants();
    }

    before(async () => {
        // The monolith skips the cluster distributor (which writes the sibling gateway/frontend trees).
        process.env.WORDJS_EMBEDDED = '1';
        core = require('../core/plugins');
        perms = require('../core/plugin-permissions');
        options = require('../core/options');

        // An active plugin with browser code, as a release from before browser:script left it.
        const pluginDir = path.join(core.PLUGINS_DIR, LEGACY);
        assert.ok(pluginDir.startsWith(TMP_ROOT), `precondition: the plugins folder is the sandbox's (${pluginDir})`);
        fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
            name: LEGACY, version: '1.0.0', isolated: true,
            permissions: [
                { scope: 'settings', access: 'read', reason: 'reads the site name' },
                { scope: 'browser', access: 'script', reason: 'admin hooks' },
            ],
        }));
        fs.writeFileSync(path.join(pluginDir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
        fs.writeFileSync(path.join(pluginDir, 'dist', 'hooks.bundle.js'), 'window.hooked = 1;\n');

        // The EXISTING database: that release's site, with the plugin active, the grant record that release
        // stored for it (no browser:script, no administrator decision) and no upgrade marker.
        await quietly(async () => {
            await useDatabase(EXISTING_DRIVER);
            await database.initializeDatabase();
            await options.updateOption('active_plugins', [LEGACY]);
            await perms.setGrants(LEGACY, ['settings:read']);
        });
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null, 'precondition: no marker');
        assert.ok(!fs.existsSync(path.join(TMP_ROOT, 'data', 'wordjs.db')), 'precondition: the other database does not exist yet');
    });

    after(async () => {
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
        try { await database.closeDatabase(); } catch { /* */ }
        fs.existsSync = realFs.existsSync;
        fs.readFileSync = realFs.readFileSync;
        fs.writeFileSync = realFs.writeFileSync;
        process.chdir(ORIGINAL_CWD);
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('a failed attempt on a new database leaves the marker and no plugin policy behind', async () => {
        failAtTheme = true;
        const res: any = await install(FRESH_DRIVER);
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.match(res.body.error, /Nothing was kept/);
        assert.strictEqual(installed(), false, 'the config of the failed attempt was put back');
        assert.ok(!realFs.existsSync(SANDBOX_CONFIG), 'no config is left on the fresh box');

        // The attempt's database, as it was left.
        await quietly(() => useDatabase(FRESH_DRIVER));
        firstMarker = await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER);
        assert.ok(typeof firstMarker === 'string' && firstMarker.startsWith('install:'), `marker: ${JSON.stringify(firstMarker)}`);
        const { value: grants } = await options.readStoredOption('plugin_grants');
        assert.deepStrictEqual(Object.keys(grants || {}), ['@host'], `grant store: ${JSON.stringify(grants)}`);
        assert.deepStrictEqual(Object.keys(grants['@host']), [core.BROWSER_CAPABILITY_MIGRATION_MARKER]);
        const { raw: egress } = await options.readStoredOption('plugin_egress_hosts');
        assert.strictEqual(egress, null, 'no egress policy was written');
    });

    it('a retry against the same database keeps the marker as the first attempt wrote it', async () => {
        failAtTheme = true;
        const res: any = await install(FRESH_DRIVER);
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.match(res.body.error, /Nothing was kept/);
        assert.strictEqual(installed(), false);
        await quietly(() => useDatabase(FRESH_DRIVER));
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), firstMarker);
    });

    it('a retry against an existing database with an active plugin decides on that database', async () => {
        failAtTheme = false;
        const res: any = await install(EXISTING_DRIVER);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(installed(), true);

        // The installer left the live driver on the database it installed into.
        assert.deepStrictEqual(await options.getOptionFresh('active_plugins', []), [LEGACY], 'precondition: the installed database');
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null,
            'the upgrade was recorded as done on a database whose active plugin predates browser:script');
        assert.deepStrictEqual(await restart(), [LEGACY], 'the next boot grants browser:script to the already-active plugin');
        assert.deepStrictEqual([...perms.getGrants(LEGACY)].sort(), ['browser:script', 'settings:read']);
        assert.deepStrictEqual(await restart(), [], 'once');
    });
});
