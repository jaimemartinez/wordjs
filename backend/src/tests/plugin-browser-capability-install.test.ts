/**
 * THE ONE-TIME browser:script UPGRADE NEVER UNDOES AN ADMINISTRATOR'S DECISION — on a wizard install too.
 *
 * The step grants browser:script, once, to plugins that were active and shipped browser code before the
 * capability existed. It ran when its completion marker was absent, and on a site installed through the
 * setup wizard the marker was absent for real use: the process that served the wizard booted in setup
 * mode (index.ts skips the boot block) and installed in-process, so the step first ran at the first
 * restart AFTER the administrator had activated plugins and revoked browser:script from one of them.
 * It read that plugin as pre-upgrade and granted browser:script back; the hooks bundle ran again on every
 * admin page with the administrator's session.
 *
 * Two rules, each tested on its own:
 *   · the installer records the step as done on the site it creates (recordFreshInstallBrowserCapability)
 *     — and only on a database with no active plugin. This file tests that function; the CALL in
 *     routes/setup.ts is driven through the real POST /setup/install by
 *     setup-install-browser-capability.test.ts;
 *   · the step never touches a plugin whose grants an administrator decided, marker or no marker. Each of
 *     the two writers of that decision is driven through its REAL route, on its own, in the suite "each
 *     route records the decision by itself": POST /api/v1/plugins/:slug/permissions (a revoke on a record
 *     no administrator wrote) and POST /api/v1/plugins/:slug/activate (the grant-on-activate, followed by
 *     an update that adds browser code). In the other cases the activation's grant is written directly.
 * The upgrade itself still works for what it is for: a plugin whose grant record no administrator wrote.
 *
 * The "restart" is index.ts's boot sequence: loadGrants → backfillActive → migrateBrowserCapabilityGrants.
 *
 * MUTATION PROOF: drop the administrator-decision skip of plugin-permissions addUpgradeGrant (the grant
 * migrateBrowserCapabilityGrants makes) and the "no marker" tests re-grant; drop `{ adminDecision: true }` from the permissions route and the
 * permissions-route test re-grants; drop it from the activation route and the activation-route test
 * re-grants; make recordFreshInstallBrowserCapability a no-op and the fresh-install test re-grants.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-browser-cap-install-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const REVOKED = 'wjs-bc-revoked';   // activated by the admin, browser:script then revoked on the permissions screen
const LEGACY = 'wjs-bc-legacy';     // active before the capability existed: its record was written by no administrator

describe('the browser:script upgrade and the setup wizard', () => {
    let core: any, perms: any, getOption: any, updateOption: any, request: any, app: any;
    let adminToken = '';
    const made: string[] = [];

    function writePlugin(slug: string) {
        const dir = path.join(core.PLUGINS_DIR, slug);
        fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
        made.push(dir);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            name: slug, version: '1.0.0', isolated: true,
            permissions: [{ scope: 'browser', access: 'script', reason: 'admin hooks' }],
        }));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
        fs.writeFileSync(path.join(dir, 'dist', 'hooks.bundle.js'), 'window.hooked = 1;\n');
    }

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
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        core = require('../core/plugins');
        perms = require('../core/plugin-permissions');
        ({ getOption, updateOption } = require('../core/options'));
        writePlugin(REVOKED);
        writePlugin(LEGACY);

        const dbAsync = database.getDbAsync();
        const r = await dbAsync.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')");
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
        await require('../core/roles').loadRoles();
        adminToken = jwt.sign({ userId: r.lastID, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        request = require('supertest');
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    beforeEach(async () => {
        // Each case starts from a database the installer has just initialized: no plugin state at all.
        await updateOption('plugin_grants', {});
        await updateOption('active_plugins', []);
        await perms.loadGrants();
    });

    after(async () => {
        for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    });

    /** The administrator activates REVOKED (the dialog grants what it declares), then revokes browser:script. */
    async function activateThenRevoke() {
        await updateOption('active_plugins', [REVOKED]);
        await perms.setGrants(REVOKED, ['browser:script'], { adminDecision: true }); // grant-on-activate, routes/plugins.ts
        const res = await request(app).post(`/api/v1/plugins/${REVOKED}/permissions`)
            .set('Authorization', `Bearer ${adminToken}`).send({ granted: [] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(perms.getGrants(REVOKED), [], 'the revoke took effect');
    }

    it('a site the installer creates records the upgrade as done: nothing is granted at the first restart', async () => {
        assert.strictEqual(await core.recordFreshInstallBrowserCapability(), true, 'the wizard step records it');
        // Even a record no administrator wrote (backfill-shaped) is not upgraded on a site that never had one.
        await updateOption('active_plugins', [LEGACY]);
        await perms.setGrants(LEGACY, []);
        assert.deepStrictEqual(await restart(), []);
        assert.ok(!perms.getGrants(LEGACY).includes('browser:script'));
    });

    it('marker absent (the wizard path before this fix): the administrator\'s revoke still stands after a restart', async () => {
        await activateThenRevoke();
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null, 'precondition: no marker');
        const granted = await restart();
        assert.ok(!granted.includes(REVOKED), `the upgrade re-granted ${REVOKED}`);
        assert.ok(!perms.getGrants(REVOKED).includes('browser:script'), 'browser:script stays revoked');
        // And again at the next restart, now that the marker is recorded.
        assert.deepStrictEqual(await restart(), []);
        assert.ok(!perms.getGrants(REVOKED).includes('browser:script'));
    });

    it('the full wizard sequence: install, activate, revoke, restart — browser:script stays revoked', async () => {
        await core.recordFreshInstallBrowserCapability();
        await activateThenRevoke();
        await restart();
        await restart();
        assert.ok(!perms.getGrants(REVOKED).includes('browser:script'));
    });

    it('the upgrade still grants a plugin whose record no administrator wrote (what it exists for)', async () => {
        await updateOption('active_plugins', [LEGACY, REVOKED]);
        await perms.setGrants(LEGACY, []);                 // written by an earlier version: no decision mark
        await activateThenRevoke();
        await updateOption('active_plugins', [LEGACY, REVOKED]);
        const granted = await restart();
        assert.deepStrictEqual(granted, [LEGACY]);
        assert.ok(perms.getGrants(LEGACY).includes('browser:script'), 'the pre-upgrade plugin keeps its browser code');
        assert.ok(!perms.getGrants(REVOKED).includes('browser:script'), 'the decided one is left alone');
    });

    it('the installer does not record it on a database that already has active plugins (an existing site)', async () => {
        await updateOption('active_plugins', [LEGACY]);
        assert.strictEqual(await core.recordFreshInstallBrowserCapability(), false);
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null);
    });

    it('the decision mark is not a plugin grant record and survives other plugins\' writes', async () => {
        await activateThenRevoke();
        await perms.setGrants(LEGACY, ['settings:read']);   // an unrelated write keeps the host record
        assert.strictEqual(await perms.hasAdminGrantDecision(REVOKED), true);
        assert.strictEqual(await perms.hasAdminGrantDecision(LEGACY), false);
        await perms.loadGrants();
        assert.deepStrictEqual(perms.getGrants(perms.HOST_RECORD_KEY), []);
        const stored = await getOption('plugin_grants', {});
        assert.ok(!Object.hasOwn(stored, perms.ADMIN_DECISIONS_MARKER), 'kept inside the host record, not beside the plugins');
    });

    describe('each route records the decision by itself (marker absent)', () => {
        const ROUTED = 'wjs-bc-routed';   // v1 ships no browser code; an update adds it

        it('the permissions route: a revoke on a record no administrator wrote stands after a restart', async () => {
            await updateOption('active_plugins', [LEGACY]);
            await perms.setGrants(LEGACY, ['browser:script']); // backfill-shaped: no decision mark before the route
            assert.strictEqual(await perms.hasAdminGrantDecision(LEGACY), false, 'precondition: only the route can mark it');
            const res = await request(app).post(`/api/v1/plugins/${LEGACY}/permissions`)
                .set('Authorization', `Bearer ${adminToken}`).send({ granted: [] });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null, 'precondition: no marker');
            assert.deepStrictEqual(await restart(), [], 'the upgrade re-granted the revoked plugin');
            assert.ok(!perms.getGrants(LEGACY).includes('browser:script'), 'browser:script stays revoked');
        });

        it('the activation route: an update that adds browser code does not get browser:script at the restart', async () => {
            const dir = path.join(core.PLUGINS_DIR, ROUTED);
            fs.mkdirSync(dir, { recursive: true });
            made.push(dir);
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
                name: ROUTED, version: '1.0.0', isolated: true,
                permissions: [{ scope: 'settings', access: 'read', reason: 'reads the site name' }],
            }));
            fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
            try {
                // The administrator activates v1 through the real route: the dialog's grant-on-activate.
                const res = await request(app).post(`/api/v1/plugins/${ROUTED}/activate`)
                    .set('Authorization', `Bearer ${adminToken}`).send({});
                assert.strictEqual(res.status, 200, JSON.stringify(res.body));
                assert.deepStrictEqual(perms.getGrants(ROUTED), ['settings:read']);

                // v2 lands in place (an update keeps the grants): it now ships a hooks bundle and declares
                // browser:script, which the administrator has not approved.
                fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
                fs.writeFileSync(path.join(dir, 'dist', 'hooks.bundle.js'), 'window.hooked = 1;\n');
                fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
                    name: ROUTED, version: '2.0.0', isolated: true,
                    permissions: [{ scope: 'settings', access: 'read' }, { scope: 'browser', access: 'script', reason: 'admin hooks' }],
                }));
                assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null, 'precondition: no marker');
                const granted = await restart();
                assert.ok(!granted.includes(ROUTED), `the upgrade granted ${ROUTED} browser:script`);
                assert.deepStrictEqual(perms.getGrants(ROUTED), ['settings:read'], 'only what the administrator approved');
            } finally {
                try { await core.deactivatePlugin(ROUTED, { prune: false }); } catch { /* */ }
            }
        });
    });
});
