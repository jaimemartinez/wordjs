/**
 * PLUGIN SUPPLY CHAIN — three ways an installed plugin reached further than anything it was granted.
 *
 *  C1  Host code execution through `dependencies`. installPluginDependencies ran
 *      `npm install <name>@<spec> --ignore-scripts` in the host's root, and npm still runs the `prepare`
 *      script of a git/file dependency under --ignore-scripts (an npm: alias or a tarball URL installs
 *      unscanned code under a benign name). Only plain registry semver ranges are accepted now — at
 *      install (upload and marketplace share installPluginFromZip) and again inside
 *      installPluginDependencies, before npm runs.
 *
 *  C2  Plugin browser bundles run in the admin's origin with the admin's session, were never scanned, and
 *      were served to anyone for ANY installed plugin. Running code in the browser is now the explicit,
 *      default-deny `browser:script` capability: declared (install/activation refuse it otherwise), served
 *      only while the plugin is ACTIVE and the capability is GRANTED, granted once at upgrade to plugins
 *      that already ran with it, and the anonymous registry no longer hands out manifests.
 *
 *  M8  GET /plugins/:slug/download zipped the plugin's runtime data/ (mail-server's encryption key),
 *      node_modules and .git.
 *
 * The probe plugins live in the REAL backend/plugins (the bundle router resolves that directory from its
 * own location), under names nothing else uses, and are removed afterwards. The database is a throwaway.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-supply-chain-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const PID = process.pid;
const UI = `wjs-sc-ui-${PID}`;          // ships browser code, declares browser:script
const LEGACY = `wjs-sc-legacy-${PID}`;  // ships browser code, predates the permission
const BACKEND_ONLY = `wjs-sc-backend-${PID}`;
const INACTIVE_UI = `wjs-sc-inactive-${PID}`;
const DL = `wjs-sc-dl-${PID}`;
const ZIPPED = `wjs-sc-zip-${PID}`;
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";
const BROWSER_PERM = { scope: 'browser', access: 'script', reason: 'Runs the admin page and the hooks bundle.' };

describe('plugin supply chain', () => {
    let core: any, perms: any, getOption: any, updateOption: any;
    let installPluginFromZip: any, createInstallTmp: any;
    let request: any, app: any, adminToken: string, PLUGINS_DIR: string;
    const made: string[] = [];
    const tmps: Array<{ dispose: () => void }> = [];

    function writePlugin(slug: string, manifest: any, files: Record<string, string> = {}) {
        const dir = path.join(PLUGINS_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        made.push(dir);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, ...manifest }));
        fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
        for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), body);
        }
        return dir;
    }

    function zipOf(slug: string, manifest: any, files: Record<string, string> = {}): string {
        const zip = new AdmZip();
        zip.addFile(`${slug}/manifest.json`, Buffer.from(JSON.stringify({ name: slug, version: '1.0.0', isolated: true, ...manifest })));
        zip.addFile(`${slug}/index.js`, Buffer.from(BENIGN_INDEX));
        for (const [rel, body] of Object.entries(files)) zip.addFile(`${slug}/${rel}`, Buffer.from(body));
        const tmp = createInstallTmp();
        tmps.push(tmp);
        zip.writeZip(tmp.zipPath);
        made.push(path.join(PLUGINS_DIR, slug));
        return tmp.zipPath;
    }

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        core = require('../core/plugins');
        perms = require('../core/plugin-permissions');
        PLUGINS_DIR = core.PLUGINS_DIR;
        ({ getOption, updateOption } = require('../core/options'));
        ({ installPluginFromZip, createInstallTmp } = require('../routes/plugins'));
        await perms.loadGrants();

        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        request = require('supertest');
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
        for (const t of tmps) { try { t.dispose(); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    });

    // ── C1 ──────────────────────────────────────────────────────────────────────────────────────────
    describe('C1 — only plain registry version ranges are ever npm-installed', () => {
        const BAD: Array<[string, any]> = [
            ['x', 'file:../evil'],
            ['x', 'git+https://example.com/x.git'],
            ['x', 'git+file:///tmp/x'],
            ['x', 'github:evil/x'],
            ['x', 'evil/x'],
            ['lodash', 'npm:evil@1'],
            ['x', 'https://example.com/x.tgz'],
            ['x', 'link:../x'],
            ['x', 'workspace:*'],
            ['x', '../x'],
            ['x', './x'],
            ['x', '~/x'],
            ['x', 'C:\\x'],
            ['x', 'latest'],
            ['x', ''],
            ['x', 1],
            ['--registry=http://evil.example', '^1.0.0'],
            ['.hidden', '^1.0.0'],
            ['a b', '^1.0.0'],
        ];
        const GOOD: Array<[string, string]> = [
            ['left-pad', '^1.2.3'], ['x', '~1.0'], ['x', '1.x'], ['x', '*'], ['x', '>=1 <2'],
            ['@scope/pkg', '^2.0.0'], ['x', '1.2.3 || 2'], ['x', '1.0.0-beta.1'], ['JSONStream', '1.3.5'],
        ];

        it('validateManifestDependencies refuses every non-registry form and accepts plain ranges', () => {
            for (const [name, spec] of BAD) {
                assert.ok(core.validateManifestDependencies({ [name]: spec }).length > 0, `${name}@${spec} must be refused`);
            }
            for (const [name, spec] of GOOD) {
                assert.deepStrictEqual(core.validateManifestDependencies({ [name]: spec }), [], `${name}@${spec} must pass`);
            }
            assert.ok(core.validateManifestDependencies(['x']).length > 0, 'an array is not a dependency map');
            assert.deepStrictEqual(core.validateManifestDependencies(undefined), []);
        });

        it('installPluginDependencies refuses them BEFORE npm runs (and before the bundled shortcut)', async () => {
            for (const spec of ['file:../evil', 'git+https://example.com/x.git', 'npm:evil@1', 'https://example.com/x.tgz']) {
                await assert.rejects(
                    core.installPluginDependencies('probe', { dependencies: { 'wjs-never-installed': spec } }, null),
                    /refuses to install[\s\S]*not a registry version range/, spec);
                await assert.rejects(
                    core.installPluginDependencies('probe', { bundled: true, dependencies: { 'wjs-never-installed': spec } }, null),
                    /refuses to install/, `${spec} (bundled)`);
            }
            assert.ok(!fs.existsSync(path.resolve('node_modules', 'wjs-never-installed')), 'nothing was installed');
            // A plain range for a package already present resolves without installing anything.
            await core.installPluginDependencies('probe', { dependencies: { semver: '^7.0.0' } }, null);
        });

        it('the install pipeline (upload + marketplace) refuses the plugin with a clear message and leaves nothing behind', async () => {
            const r = await installPluginFromZip(zipOf(ZIPPED, { dependencies: { x: 'file:../evil' } }), `${ZIPPED}.zip`);
            assert.strictEqual(r.status, 400);
            assert.match(r.body.error, /Invalid dependencies[\s\S]*not a registry version range/);
            assert.ok(!fs.existsSync(path.join(PLUGINS_DIR, ZIPPED)), 'the extracted dir was removed');
        });
    });

    // ── C2 ──────────────────────────────────────────────────────────────────────────────────────────
    describe('C2 — browser:script is a declared, granted capability', () => {
        before(() => {
            const dist = {
                'dist/admin.bundle.js': 'export default function A(){}\n',
                'dist/hooks.bundle.js': 'export function registerX(){}\n',
                'dist/admin.bundle.css': '.a{}',
                'dist/manifest.build.json': '{"bundles":["admin.bundle.js"]}',
            };
            writePlugin(UI, { permissions: [BROWSER_PERM, { scope: 'settings', access: 'read', reason: 'Read its configuration.' }],
                frontend: { adminPage: { entry: 'client/admin/page.tsx', slug: `${UI}-page` }, hooks: 'client/Ext.tsx' } }, dist);
            writePlugin(LEGACY, { permissions: [{ scope: 'settings', access: 'read', reason: 'Read its configuration.' }],
                frontend: { hooks: 'client/Ext.tsx' } }, dist);
            writePlugin(INACTIVE_UI, { permissions: [BROWSER_PERM], frontend: { adminPage: { entry: 'client/admin/page.tsx' } } }, dist);
            writePlugin(BACKEND_ONLY, { permissions: [{ scope: 'settings', access: 'read', reason: 'Read its configuration.' }] });
        });

        it('install refuses browser code that does not declare browser:script, and accepts it declared', async () => {
            for (const [manifest, files] of [
                [{ frontend: { adminPage: { entry: 'client/admin/page.tsx' } } }, {}],
                [{ frontend: { versoComponents: { entry: 'client/verso/X.tsx' } } }, {}],
                [{ frontend: { puckComponents: { entry: 'client/puck/X.tsx' } } }, {}],
                [{ frontend: { hooks: 'client/Ext.tsx' } }, {}],
                [{}, { 'dist/hooks.bundle.js': 'export function registerX(){}' }], // prebuilt, no manifest key
            ] as Array<[any, any]>) {
                const r = await installPluginFromZip(zipOf(ZIPPED, manifest, files), `${ZIPPED}.zip`);
                assert.strictEqual(r.status, 400, JSON.stringify(manifest));
                assert.match(r.body.error, /browser:script/);
                assert.ok(!fs.existsSync(path.join(PLUGINS_DIR, ZIPPED)));
            }
            const ok = await installPluginFromZip(
                zipOf(ZIPPED, { permissions: [BROWSER_PERM], frontend: { hooks: 'client/Ext.tsx' } }), `${ZIPPED}.zip`);
            assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
            fs.rmSync(path.join(PLUGINS_DIR, ZIPPED), { recursive: true, force: true });
        });

        it('activation refuses an undeclared plugin that ships browser code', async () => {
            const r = await request(app).post(`/api/v1/plugins/${LEGACY}/activate`)
                .set('Authorization', `Bearer ${adminToken}`).send({});
            assert.strictEqual(r.status, 400, JSON.stringify(r.body));
            assert.strictEqual(r.body.code, 'plugin_browser_capability_undeclared');
            assert.ok(!((await getOption('active_plugins', [])) as string[]).includes(LEGACY));
        });

        it('serves a bundle only while the plugin is ACTIVE and browser:script is GRANTED', async () => {
            const get = (slug: string, sub = 'bundle?type=hooks') => request(app).get(`/api/v1/plugins/${slug}/${sub}`);
            const status = async (slug: string) => [
                (await get(slug)).status,
                (await get(slug, 'bundle?type=admin')).status,
                (await get(slug, 'bundle/css?type=admin')).status,
                (await get(slug, 'bundle/manifest')).status,
            ];

            // Installed, inactive, nothing granted: the pre-fix behaviour served all of it to anyone.
            await updateOption('active_plugins', []);
            perms._setGrantsInMemory(UI, []);
            assert.deepStrictEqual(await status(UI), [404, 404, 404, 404], 'inactive + ungranted');

            // Granted but inactive.
            perms._setGrantsInMemory(UI, ['browser:script']);
            assert.deepStrictEqual(await status(UI), [404, 404, 404, 404], 'inactive');

            // Active but not granted (e.g. granted only settings:read).
            await updateOption('active_plugins', [UI]);
            perms._setGrantsInMemory(UI, ['settings:read']);
            assert.deepStrictEqual(await status(UI), [404, 404, 404, 404], 'not granted');

            // Active AND granted — served, also through the admin-page slug alias.
            perms._setGrantsInMemory(UI, ['settings:read', 'browser:script']);
            assert.deepStrictEqual(await status(UI), [200, 200, 200, 200], 'active + granted');
            assert.strictEqual((await get(`${UI}-page`, 'bundle?type=admin')).status, 200);
            assert.match((await get(UI)).text, /registerX/);

            // Revoke: stops at the very next request.
            perms._setGrantsInMemory(UI, ['settings:read']);
            assert.strictEqual((await get(UI)).status, 404, 'revoked');
            await updateOption('active_plugins', []);
        });

        it('the anonymous registry carries no manifest data — just what the hooks loader needs', async () => {
            await updateOption('active_plugins', [UI, BACKEND_ONLY]);
            perms._setGrantsInMemory(UI, ['browser:script']);
            perms._setGrantsInMemory(BACKEND_ONLY, ['settings:read']);
            const r = await request(app).get('/api/v1/plugins/registry');
            assert.strictEqual(r.status, 200);
            const byId = Object.fromEntries(r.body.plugins.map((e: any) => [e.id, e]));
            assert.deepStrictEqual(byId[UI], { id: UI, path: `/plugins/${UI}`, browser: true, frontend: { hooks: true } });
            assert.deepStrictEqual(byId[BACKEND_ONLY], { id: BACKEND_ONLY, path: `/plugins/${BACKEND_ONLY}`, browser: false });
            const text = JSON.stringify(r.body);
            for (const leak of ['version', 'permissions', 'settings', 'name', 'reason', 'client/']) {
                assert.ok(!text.includes(leak), `registry leaks "${leak}": ${text}`);
            }
            await updateOption('active_plugins', []);
        });

        it('the upgrade step grants browser:script ONCE, only to already-active plugins that ship browser code', async () => {
            await updateOption(core.BROWSER_CAPABILITY_MIGRATION_OPTION, null);
            await perms.setGrants(UI, ['settings:read']);
            await perms.setGrants(LEGACY, ['settings:read']);
            await perms.setGrants(BACKEND_ONLY, ['settings:read']);
            await perms.setGrants(INACTIVE_UI, []);
            await updateOption('active_plugins', [UI, LEGACY, BACKEND_ONLY]);

            const granted = await core.migrateBrowserCapabilityGrants();
            assert.deepStrictEqual([...granted].sort(), [LEGACY, UI].sort());
            assert.deepStrictEqual(perms.getGrants(LEGACY).sort(), ['browser:script', 'settings:read'], 'only ADDS the token');
            assert.ok(!perms.getGrants(BACKEND_ONLY).includes('browser:script'), 'no browser code → nothing granted');
            assert.ok(!perms.getGrants(INACTIVE_UI).includes('browser:script'), 'inactive → default-deny');
            assert.ok(await getOption(core.BROWSER_CAPABILITY_MIGRATION_OPTION, null), 'completion recorded');

            // Idempotent: an admin's later revoke is not undone by the next boot.
            await perms.setGrants(LEGACY, ['settings:read']);
            assert.deepStrictEqual(await core.migrateBrowserCapabilityGrants(), []);
            assert.ok(!perms.getGrants(LEGACY).includes('browser:script'));
            await updateOption('active_plugins', []);
        });

        it('the admin listing projects browser:script for a plugin that predates it, so it can be seen and revoked', async () => {
            const r = await request(app).get('/api/v1/plugins').set('Authorization', `Bearer ${adminToken}`);
            assert.strictEqual(r.status, 200);
            const legacy = r.body.find((p: any) => p.slug === LEGACY);
            assert.ok(legacy.requestedPermissions.includes('browser:script'));
            assert.ok(legacy.permissions.some((p: any) => p.scope === 'browser' && p.undeclared === true));
            const ui = r.body.find((p: any) => p.slug === UI);
            assert.strictEqual(ui.permissions.filter((p: any) => p.scope === 'browser').length, 1, 'declared once, not projected again');
            const backendOnly = r.body.find((p: any) => p.slug === BACKEND_ONLY);
            assert.ok(!backendOnly.requestedPermissions.includes('browser:script'));
        });
    });

    // ── M8 ──────────────────────────────────────────────────────────────────────────────────────────
    describe('M8 — the download is the plugin\'s code, never its runtime state', () => {
        it('excludes data/, node_modules/, .git, OS junk and symlinks', async () => {
            const dir = writePlugin(DL, {}, {
                'lib/util.js': 'module.exports = 1;\n',
                'data/secret.key': 'ENCRYPTION-KEY',
                'data/attachments/a.eml': 'From: victim@example.com',
                'node_modules/dep/index.js': 'module.exports = 2;\n',
                '.git/config': '[remote "origin"]\n\turl = https://token@example.com/x.git\n',
                '.DS_Store': 'junk',
                'client/data/fixture.json': '{}', // a NESTED data/ dir is ordinary source
            });
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-sc-outside-'));
            made.push(outside);
            fs.writeFileSync(path.join(outside, 'host-secret.txt'), 'HOST');
            let linked = true;
            try { fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction'); } catch { linked = false; }

            const r = await request(app).get(`/api/v1/plugins/${DL}/download`)
                .set('Authorization', `Bearer ${adminToken}`)
                .buffer(true).parse((res: any, cb: any) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => cb(null, Buffer.concat(chunks)));
                });
            assert.strictEqual(r.status, 200);
            const names = new AdmZip(r.body).getEntries().filter((e: any) => !e.isDirectory).map((e: any) => e.entryName).sort();
            assert.deepStrictEqual(names, [`${DL}/client/data/fixture.json`, `${DL}/index.js`, `${DL}/lib/util.js`, `${DL}/manifest.json`]);
            assert.ok(!r.body.includes(Buffer.from('ENCRYPTION-KEY')));
            if (linked) assert.ok(!r.body.includes(Buffer.from('HOST')), 'symlink not followed');
        });
    });
});
