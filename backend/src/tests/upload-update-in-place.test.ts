/**
 * Updating an installed plugin or theme by uploading a newer zip — POST /plugins/:slug/update and
 * POST /themes/:slug/update — and the re-upload answer that points there.
 *
 * THE DEFECT THIS PINS. There was no way to update a plugin from a zip: with the plugin active the upload
 * said "Deactivate it before re-uploading"; deactivated, it said "already exists. Uninstall it", and the
 * uninstall dropped the plugin's grants. Themes had the same dead end (activate another theme, delete,
 * upload again). Now:
 *   · a re-upload answers 409 with a stable `code` and both versions, naming the update as the way forward;
 *   · the update stages and validates the new code BEFORE touching the installed one — a bad zip leaves
 *     it exactly as it was;
 *   · data/, tables and the stored grants survive; a permission the new version adds is reported and
 *     stays ungranted; a recorded catalog origin is dropped (the code now comes from the upload).
 *
 * Drives the real routers through supertest and asserts on the filesystem and the grant store. Every
 * plugin here is INACTIVE (no isolate is spawned). CWD-sandbox ordering as in theme-upload-identity.test.ts:
 * PLUGINS_DIR and THEMES_DIR are resolved from the CWD at module load.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-upload-update-'));
for (const d of ['themes', 'plugins', 'os-tmp', 'public']) fs.mkdirSync(path.join(TMP_ROOT, d), { recursive: true });
// The theme update compiles a new theme.json against the token manifest (CWD-relative, like THEMES_DIR).
fs.copyFileSync(path.resolve(__dirname, '../../public/theme-tokens.json'), path.join(TMP_ROOT, 'public', 'theme-tokens.json'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const ZIP_DIR = path.join(TMP_ROOT, 'zips');
const SLUG = 'upd-upload';
const THEME = 'upd-theme';
const BENIGN_INDEX = "'use strict';\nmodule.exports = { register() {} };\n";

describe('in-place update from an uploaded zip', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let perms: any;
    let origins: any;
    let updateOption: any;
    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);

    const makeZip = (fileName: string, entries: Record<string, string>): string => {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        for (const [name, body] of Object.entries(entries)) zip.addFile(name, Buffer.from(body));
        fs.mkdirSync(ZIP_DIR, { recursive: true });
        const p = path.join(ZIP_DIR, fileName);
        zip.writeZip(p);
        return p;
    };
    const permObjs = (toks: string[] = []) => toks.map((t) => ({ scope: t.split(':')[0], access: t.split(':')[1] }));
    const pluginManifest = (version: string, permissions: string[] = []) =>
        JSON.stringify({ name: 'Upload Update', isolated: true, version, permissions: permObjs(permissions) });
    const pluginZip = (version: string, opts: { permissions?: string[]; root?: string; noManifest?: boolean } = {}) => {
        const root = opts.root || SLUG;
        const entries: Record<string, string> = { [`${root}/index.js`]: `${BENIGN_INDEX}// ${version}\n` };
        if (!opts.noManifest) entries[`${root}/manifest.json`] = pluginManifest(version, opts.permissions);
        return makeZip(`${root}-${version}.zip`, entries);
    };
    const pluginDir = () => path.join(PLUGINS_DIR, SLUG);
    const installedPluginVersion = () => JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8')).version;
    const leftovers = () => fs.readdirSync(path.join(TMP_ROOT, 'os-tmp')).filter((n: string) => n.startsWith('plugin-') || n.startsWith('theme-'));

    const themeDir = () => path.join(THEMES_DIR, THEME);
    const themeZip = (version: string, marker: string, opts: { root?: string; themeJson?: string } = {}) => {
        const root = opts.root || THEME;
        return makeZip(`${root}-${version}.zip`, {
            [`${root}/theme.json`]: opts.themeJson ?? JSON.stringify({ name: 'Upd Theme', version }),
            [`${root}/style.css`]: `/* ${marker} */\n`,
        });
    };
    const themeCss = () => fs.readFileSync(path.join(themeDir(), 'style.css'), 'utf8');

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get("SELECT id FROM users WHERE user_login = 'admin'");
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        perms = require('../core/plugin-permissions');
        origins = require('../core/plugin-origins');
        ({ updateOption } = require('../core/options'));

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    beforeEach(async () => {
        fs.rmSync(pluginDir(), { recursive: true, force: true });
        fs.mkdirSync(path.join(pluginDir(), 'data'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir(), 'manifest.json'), pluginManifest('1.0.0', ['database:write']));
        fs.writeFileSync(path.join(pluginDir(), 'index.js'), `${BENIGN_INDEX}// 1.0.0\n`);
        fs.writeFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'PRESERVE-ME');
        await updateOption('plugin_grants', {});
        await updateOption('plugin_origins', {});
        await updateOption('active_plugins', []);
        await perms.loadGrants();
        await perms.setGrants(SLUG, ['database:write']);

        fs.rmSync(themeDir(), { recursive: true, force: true });
        fs.mkdirSync(themeDir(), { recursive: true });
        fs.writeFileSync(path.join(themeDir(), 'theme.json'), JSON.stringify({ name: 'Upd Theme', version: '1.0.0' }));
        fs.writeFileSync(path.join(themeDir(), 'style.css'), '/* original */\n');
        require('../core/themes').invalidateThemeScanCache();
    });

    it('re-uploading an installed plugin answers 409 plugin_exists with both versions, and changes nothing', async () => {
        const res = await asAdmin(request(app).post('/api/v1/plugins/upload')).attach('plugin', pluginZip('2.0.0'));
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'plugin_exists');
        assert.strictEqual(res.body.data.slug, SLUG);
        assert.strictEqual(res.body.data.installedVersion, '1.0.0');
        assert.strictEqual(res.body.data.incomingVersion, '2.0.0');
        assert.match(res.body.error, /update it/);
        assert.doesNotMatch(res.body.error, /Uninstall|Deactivate/, 'the old dead-end advice is gone');
        assert.strictEqual(installedPluginVersion(), '1.0.0');
    });

    it('POST /plugins/:slug/update replaces the code and keeps data/, grants — and drops a catalog origin', async () => {
        await origins.setPluginOrigin(SLUG, { source: 'https://catalog.example/dl', catalogId: SLUG, version: '1.0.0' });
        const res = await asAdmin(request(app).post(`/api/v1/plugins/${SLUG}/update`)).attach('plugin', pluginZip('2.0.0', { permissions: ['database:write'] }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.updated, true);
        assert.strictEqual(res.body.fromVersion, '1.0.0');
        assert.strictEqual(res.body.toVersion, '2.0.0');
        assert.deepStrictEqual(res.body.newPermissions, []);
        assert.deepStrictEqual(res.body.ungrantedPermissions, []);
        assert.strictEqual(installedPluginVersion(), '2.0.0');
        assert.ok(fs.readFileSync(path.join(pluginDir(), 'index.js'), 'utf8').includes('// 2.0.0'));
        assert.strictEqual(fs.readFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'utf8'), 'PRESERVE-ME');
        assert.deepStrictEqual(perms.getGrants(SLUG), ['database:write']);
        assert.strictEqual(await origins.getPluginOrigin(SLUG), null, 'the code no longer comes from that catalog');
        assert.deepStrictEqual(leftovers(), [], 'no staging or stash dir left behind');
    });

    it('a permission the new version adds is reported, and stays ungranted', async () => {
        const res = await asAdmin(request(app).post(`/api/v1/plugins/${SLUG}/update`))
            .attach('plugin', pluginZip('2.1.0', { permissions: ['database:write', 'settings:read'] }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.newPermissions, ['settings:read']);
        assert.deepStrictEqual(res.body.ungrantedPermissions, ['settings:read']);
        assert.deepStrictEqual(perms.getGrants(SLUG), ['database:write'], 'nothing granted on the admin\'s behalf');
    });

    it('a zip that fails validation leaves the installed plugin untouched (staged, never swapped)', async () => {
        const res = await asAdmin(request(app).post(`/api/v1/plugins/${SLUG}/update`)).attach('plugin', pluginZip('2.0.0', { noManifest: true }));
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.unchanged, true);
        assert.match(res.body.error, /manifest\.json/);
        assert.strictEqual(installedPluginVersion(), '1.0.0');
        assert.ok(fs.readFileSync(path.join(pluginDir(), 'index.js'), 'utf8').includes('// 1.0.0'));
        assert.strictEqual(fs.readFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'utf8'), 'PRESERVE-ME');
        assert.deepStrictEqual(leftovers(), []);
    });

    it('a zip for ANOTHER plugin cannot update this one', async () => {
        const res = await asAdmin(request(app).post(`/api/v1/plugins/${SLUG}/update`)).attach('plugin', pluginZip('9.0.0', { root: 'someone-else' }));
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(installedPluginVersion(), '1.0.0');
        assert.strictEqual(fs.existsSync(path.join(PLUGINS_DIR, 'someone-else')), false);
    });

    it('updating a plugin that is not installed is a 404', async () => {
        const res = await asAdmin(request(app).post('/api/v1/plugins/not-here/update')).attach('plugin', pluginZip('1.0.0', { root: 'not-here' }));
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    });

    it('re-uploading an installed theme answers 409 theme_exists', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', themeZip('2.0.0', 'new'));
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'theme_exists');
        assert.strictEqual(themeCss(), '/* original */\n');
    });

    it('POST /themes/:slug/update swaps the theme in place', async () => {
        const res = await asAdmin(request(app).post(`/api/v1/themes/${THEME}/update`)).attach('theme', themeZip('2.0.0', 'new'));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.fromVersion, '1.0.0');
        assert.strictEqual(res.body.toVersion, '2.0.0');
        assert.strictEqual(themeCss(), '/* new */\n');
        assert.deepStrictEqual(leftovers(), []);
    });

    it('a theme zip rooted at another folder, or whose theme.json does not compile, changes nothing', async () => {
        const other = await asAdmin(request(app).post(`/api/v1/themes/${THEME}/update`)).attach('theme', themeZip('2.0.0', 'new', { root: 'other-theme' }));
        assert.strictEqual(other.status, 400, JSON.stringify(other.body));
        assert.match(other.body.error, /pack theme/);
        const broken = await asAdmin(request(app).post(`/api/v1/themes/${THEME}/update`)).attach('theme', themeZip('2.0.0', 'new', { themeJson: '{ not json' }));
        assert.strictEqual(broken.status, 400, JSON.stringify(broken.body));
        assert.strictEqual(themeCss(), '/* original */\n');
        assert.strictEqual(fs.existsSync(path.join(THEMES_DIR, 'other-theme')), false);
        assert.deepStrictEqual(leftovers(), []);
    });
});
