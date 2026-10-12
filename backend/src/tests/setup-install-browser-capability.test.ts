/**
 * THE SETUP WIZARD RECORDS THE ONE-TIME browser:script UPGRADE AS DONE — driven through POST /setup/install.
 *
 * The upgrade (core/plugins migrateBrowserCapabilityGrants) grants browser:script, once, to active plugins
 * that ship browser code and lack it. On a site installed through the wizard it had never run — the
 * process that served the wizard booted in setup mode and skipped the boot block — so it first ran at the
 * first restart after real use, and a plugin whose grant record no administrator had written got
 * browser:script: its hooks bundle on every admin page, with the viewer's session. routes/setup.ts now
 * records the step as done on the site it creates (recordFreshInstallBrowserCapability).
 *
 * plugin-browser-capability-install.test.ts covers that function and the other half of the rule (a
 * plugin whose grants an administrator decided is never touched). This file proves the CALL SITE: the
 * REAL install handler runs against a real SQLite database in a temp working directory, and the outcome
 * is what the next boot does — index.ts's sequence loadGrants → backfillActive → migrate — to an active
 * plugin with browser code whose grant record no administrator wrote. What the installer touches outside
 * that directory (certificates, the default theme, the core self-tests, the cluster distributor, the
 * install-token file, the site-address watcher, the frontend purge) is replaced on the real modules:
 * none of it bears on the marker.
 *
 * MUTATION PROOF: delete the recordFreshInstallBrowserCapability call from routes/setup.ts and the
 * restart grants browser:script to the plugin.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The working directory FIRST: core/configManager resolves wordjs-config.json against it at load, and the
// installer's './data/wordjs-native.db' is relative to it.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-setup-browser-cap-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);
fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });

const INSTALL_TOKEN = 'setup-browser-capability-token';
const LEGACY = `wjs-setup-bc-${process.pid}`;

// What the installer reaches beyond the temp directory, replaced ON the modules it requires at call time
// (the token check is destructured when routes/setup.ts loads, so it is replaced before that).
const installToken = require('../core/install-token');
installToken.verifyInstallToken = (t: unknown) => t === INSTALL_TOKEN;
installToken.clearInstallTokenFile = () => {};
const certManager = require('../core/certManager');
certManager.generateClusterCA = () => ({ key: 'stub-ca-key', cert: 'stub-ca-cert' });
certManager.generateServiceCert = () => {};
require('../core/themes').createDefaultTheme = () => {};
require('../core/plugin-test-runner').runCoreTests = async () => ({ success: true, tests: 0, passed: 0, failed: 0 });
require('../core/site-address').ensureStarted = async () => {};
require('../core/frontend-purge').purgeFrontend = () => {};

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

/** Hold console output while the installer narrates (async writes can corrupt the runner's frames). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = console.info = console.warn = console.error = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
}

describe('POST /setup/install and the browser:script upgrade', () => {
    let core: any, perms: any, updateOption: any;
    let pluginDir = '';
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
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/setup', require('../routes/setup'));
        // The monolith skips the cluster distributor (which writes the sibling gateway/frontend trees).
        process.env.WORDJS_EMBEDDED = '1';
        const res: any = await quietly(() => request(app).post('/setup/install')
            .set('x-install-token', INSTALL_TOKEN)
            .send({
                siteName: 'Wizard site',
                adminUser: 'wizard',
                adminEmail: 'wizard@example.test',
                adminPassword: 'Wizard-Admin-Pass-1',
                dbDriver: 'sqlite-native',
                demoContent: false,
                siteUrl: 'http://localhost:3000',
            }));
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.success, true);

        core = require('../core/plugins');
        perms = require('../core/plugin-permissions');
        ({ updateOption } = require('../core/options'));
        assert.ok(fs.existsSync(path.join(TMP_ROOT, 'data', 'wordjs-native.db')), 'precondition: the installer created the temp database');

        // A plugin with browser code, active, whose grant record no administrator wrote — the shape the
        // boot backfill leaves, and what the upgrade exists for on a site that predates the capability.
        pluginDir = path.join(core.PLUGINS_DIR, LEGACY);
        fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
            name: LEGACY, version: '1.0.0', isolated: true,
            permissions: [{ scope: 'browser', access: 'script', reason: 'admin hooks' }],
        }));
        fs.writeFileSync(path.join(pluginDir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
        fs.writeFileSync(path.join(pluginDir, 'dist', 'hooks.bundle.js'), 'window.hooked = 1;\n');
    });

    after(async () => {
        try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch { /* */ }
        try { await require('../config/database').closeDatabase(); } catch { /* */ }
        process.chdir(ORIGINAL_CWD);
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('the site the wizard created records the upgrade as done (in the grant store)', async () => {
        const marker = await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER);
        assert.ok(typeof marker === 'string' && marker.startsWith('install:'), `marker: ${JSON.stringify(marker)}`);
    });

    it('the first restart after real use grants browser:script to nothing', async () => {
        await updateOption('active_plugins', [LEGACY]);
        await perms.setGrants(LEGACY, []); // written by no administrator: no decision mark
        assert.strictEqual(await perms.hasAdminGrantDecision(LEGACY), false, 'precondition: only the marker protects it');
        assert.deepStrictEqual(await restart(), [], 'the upgrade granted something');
        assert.ok(!perms.getGrants(LEGACY).includes('browser:script'), 'browser:script was granted at the restart');
        assert.deepStrictEqual(await restart(), []);
    });
});
