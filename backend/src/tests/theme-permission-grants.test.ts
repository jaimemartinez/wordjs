/**
 * WordJS — a theme's functions.js holds what an administrator GRANTED it, and nothing else.
 *
 * The plugin model, for themes: theme.json DECLARES the permissions its server code needs, the
 * administrator GRANTS them (the activation dialog sends them with POST /themes/:slug/activate, the
 * Permissions dialog with PUT /themes/:slug/permissions), and the host gates check declared AND granted
 * against the `theme:<slug>` principal. Nothing is granted implicitly: not by declaring, not by activating.
 *
 * Driven through the REAL /api/v1 router and a REAL theme child process (core/theme-engine →
 * plugin-isolate): the probe filter below runs inside the theme's isolate and calls the options bridge,
 * so what it answers is what the host gate decided for that child.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// core/themes resolves THEMES_DIR CWD-relative while the isolate layer resolves from backend/: pin the
// CWD so both agree, as in production (see theme-isolate-teardown.test.ts).
const BACKEND_ROOT = path.resolve(__dirname, '../..');
process.chdir(BACKEND_ROOT);

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-theme-perms-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const hooks = require('../core/hooks');
const { setApp } = require('../core/appRegistry');
const { unloadIsolatedPlugin } = require('../core/plugin-isolate');
const perms = require('../core/plugin-permissions');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const THEMES_DIR = path.join(BACKEND_ROOT, 'themes');
const PROBE = 'zz-test-theme-perms';
const FS_PROBE = 'zz-test-theme-perms-fs';
const PLAIN = 'zz-test-theme-perms-plain';
const FIXTURES = [PROBE, FS_PROBE, PLAIN];

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

let adminId = 0;
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });

function writeTheme(slug: string, themeJson: Record<string, unknown>, functionsJs: string | null) {
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: slug, version: '1.0.0', ...themeJson }));
    fs.writeFileSync(path.join(dir, 'style.css'), ':root { --wjs-color-primary: #123456; }\n');
    if (functionsJs !== null) fs.writeFileSync(path.join(dir, 'functions.js'), functionsJs);
}

const probe = () => hooks.applyFilters('zz_theme_perm_probe', 'x');
const fsProbe = () => hooks.applyFilters('zz_theme_fs_probe', 'x');

before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    const { updateOption } = require('../core/options');
    await updateOption('blogname', 'Perm Probe Site');
    await perms.loadGrants();

    // Reads an option through the bridge: settings:read decides it, host-side, for `theme:<slug>`.
    writeTheme(PROBE, {
        permissions: [
            { scope: 'settings', access: 'read', reason: 'Prints the site name in a shortcode' },
            { scope: 'database', access: 'write', reason: 'Not something a theme can hold' },
        ],
    }, "module.exports = (wordjs) => {\n" +
        "  wordjs.hooks.addFilter('zz_theme_perm_probe', async () => {\n" +
        "    try { return 'ok:' + (await wordjs.options.get('blogname')); } catch (e) { return 'denied'; }\n" +
        "  });\n" +
        "};\n");
    // Writes a data file into its own directory: filesystem:write decides it (io-guard, in the child).
    writeTheme(FS_PROBE, { permissions: [{ scope: 'filesystem', access: 'write' }] },
        "const fs = require('fs');\nconst path = require('path');\n" +
        "module.exports = (wordjs) => {\n" +
        "  wordjs.hooks.addFilter('zz_theme_fs_probe', () => {\n" +
        "    try { fs.writeFileSync(path.join(__dirname, 'data', 'probe.txt'), 'x'); return 'wrote'; } catch (e) { return 'denied'; }\n" +
        "  });\n" +
        "};\n");
    writeTheme(PLAIN, {}, null);
});

after(async () => {
    for (const slug of FIXTURES) { try { await unloadIsolatedPlugin(`theme:${slug}`); } catch { /* */ } }
    for (const slug of FIXTURES) { try { fs.rmSync(path.join(THEMES_DIR, slug), { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(config.dbPath, { force: true }); } catch { /* */ }
});

test('the dialog data: declared permissions, which of them a theme may hold, and nothing granted yet', async () => {
    const res = await request(app).get(`/api/v1/themes/${PROBE}/permissions`).set(auth());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.hasLogic, true);
    assert.deepStrictEqual(res.body.granted, []);
    const byToken = Object.fromEntries(res.body.declared.map((r: any) => [r.token, r]));
    assert.strictEqual(byToken['settings:read'].grantable, true);
    assert.strictEqual(byToken['settings:read'].reason, 'Prints the site name in a shortcode');
    assert.strictEqual(byToken['database:write'].grantable, false);
    assert.strictEqual(byToken['database:write'].problem, 'not_available_to_themes');
    // Admin only.
    assert.strictEqual((await request(app).get(`/api/v1/themes/${PROBE}/permissions`)).status, 401);
});

test('activating WITHOUT a grant list grants nothing: the theme declares settings:read and is still refused', async () => {
    const res = await request(app).post(`/api/v1/themes/${PROBE}/activate`).set(auth()).send({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.permissions.granted, []);
    assert.strictEqual(res.body.permissions.logic.state, 'running');
    assert.strictEqual(await probe(), 'denied');
});

test('only what the theme declares, and what themes may hold, can be granted', async () => {
    const undeclared = await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: ['settings:write'] });
    assert.strictEqual(undeclared.status, 400);
    assert.deepStrictEqual(undeclared.body.refused, ['settings:write']);
    const notForThemes = await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: ['database:write'] });
    assert.strictEqual(notForThemes.status, 400);
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), [], 'a refused request stores nothing');
    assert.strictEqual(await probe(), 'denied');
});

test('the activation dialog grants what the administrator left on, and the theme child can use it', async () => {
    const res = await request(app).post(`/api/v1/themes/${PROBE}/activate`).set(auth()).send({ grant: ['settings:read'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.permissions.granted, ['settings:read']);
    assert.strictEqual(await probe(), 'ok:Perm Probe Site');
});

test('a revoke in the Permissions dialog takes effect at once on the running theme', async () => {
    const res = await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: [] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.granted, []);
    assert.strictEqual(await probe(), 'denied');
    const again = await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: ['settings:read'] });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(await probe(), 'ok:Perm Probe Site');
});

test('the grants are stored in plugin_grants under @themes, survive a reload and leave plugin records alone', async () => {
    await perms.setGrants('zz-bystander-plugin', ['settings:read']);
    await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: ['settings:read'] }).expect(200);
    const { readStoredOption } = require('../core/options');
    const { value } = await readStoredOption('plugin_grants');
    assert.deepStrictEqual(value['@themes'][PROBE], ['settings:read']);
    assert.deepStrictEqual(value['zz-bystander-plugin'], ['settings:read']);
    await perms.loadGrants();
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), ['settings:read']);
    assert.deepStrictEqual(perms.getGrants('zz-bystander-plugin'), ['settings:read']);
    assert.strictEqual(perms.isGranted(`theme:${PROBE}`, 'settings', 'read'), true);
    // A plugin slug can never answer for a theme, nor a theme for a plugin.
    assert.strictEqual(perms.isGranted(PROBE, 'settings', 'read'), false);
    // A token-shaped write (narrowOnly) may revoke but never add.
    const narrowed = await perms.applyThemeGrants(PROBE, ['settings:read'], ['settings:read'], { narrowOnly: true });
    assert.deepStrictEqual(narrowed.refused, []);
    await perms.applyThemeGrants(PROBE, [], ['settings:read'], { narrowOnly: true });
    const widen = await perms.applyThemeGrants(PROBE, ['settings:read'], ['settings:read'], { narrowOnly: true });
    assert.deepStrictEqual(widen.refused, ['settings:read']);
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), []);
});

test('filesystem: declared and not granted is denied in the theme child; granted, it works', async () => {
    const res = await request(app).post(`/api/v1/themes/${FS_PROBE}/activate`).set(auth()).send({ grant: [] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const state = res.body.permissions.logic.state;
    // Either the grant-mode scan already blocks code that needs the capability, or the child's fs gate
    // refuses the write: in both cases the theme does not get to write.
    if (state === 'running') assert.strictEqual(await fsProbe(), 'denied');
    else assert.strictEqual(state, 'blocked');
    assert.strictEqual(fs.existsSync(path.join(THEMES_DIR, FS_PROBE, 'data', 'probe.txt')), false);

    const granted = await request(app).put(`/api/v1/themes/${FS_PROBE}/permissions`).set(auth()).send({ granted: ['filesystem:write'] });
    assert.strictEqual(granted.status, 200, JSON.stringify(granted.body));
    assert.strictEqual(granted.body.logic.state, 'running');
    assert.strictEqual(await fsProbe(), 'wrote');
});

test('a theme update that stops declaring a permission loses its grant; deleting a theme drops its record', async () => {
    await request(app).post(`/api/v1/themes/${PROBE}/activate`).set(auth()).send({ grant: ['settings:read'] }).expect(200);
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), ['settings:read']);
    // The theme on disk no longer asks for settings:read (an update rewrote theme.json).
    fs.writeFileSync(path.join(THEMES_DIR, PROBE, 'theme.json'), JSON.stringify({ name: PROBE, version: '1.0.1', permissions: [] }));
    await require('../core/theme-engine').init();
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), []);
    assert.strictEqual(await probe(), 'denied');

    await request(app).post(`/api/v1/themes/${PROBE}/activate`).set(auth()).send({}).expect(200);
    fs.writeFileSync(path.join(THEMES_DIR, PROBE, 'theme.json'), JSON.stringify({ name: PROBE, version: '1.0.2', permissions: [{ scope: 'settings', access: 'read' }] }));
    await request(app).put(`/api/v1/themes/${PROBE}/permissions`).set(auth()).send({ granted: ['settings:read'] }).expect(200);
    await request(app).post(`/api/v1/themes/${PLAIN}/activate`).set(auth()).send({}).expect(200);
    const del = await request(app).delete(`/api/v1/themes/${PROBE}`).set(auth());
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.deepStrictEqual(perms.getThemeGrants(PROBE), []);
    const { value } = await require('../core/options').readStoredOption('plugin_grants');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(value['@themes'] || {}, PROBE), false);
});
