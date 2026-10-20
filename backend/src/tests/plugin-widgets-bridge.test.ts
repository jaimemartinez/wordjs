/**
 * WordJS — an isolated plugin registers sidebar widgets through the bridge (wordjs.widgets.register).
 *
 * registerWidget lived only on the host, so a sandboxed plugin could not offer a widget at all. The bridge
 * registers a HOST-side widget whose renderer RPCs into the plugin's child (like a shortcode): it shows in
 * GET /widgets with its settings form, renders with the instance's settings, cannot take over a core
 * widget's id, and disappears when the plugin is unloaded. Real child process, real router.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '../..');
process.chdir(BACKEND_ROOT);

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-plugin-widgets-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { setApp } = require('../core/appRegistry');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(BACKEND_ROOT, 'plugins');
const SLUG = 'zz-test-widget-plugin';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

let adminId = 0;
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });
const listed = async () => (await request(app).get('/api/v1/widgets')).body as any[];

before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);

    const dir = path.join(PLUGINS_DIR, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'),
        "exports.init = function (wordjs) {\n" +
        "  wordjs.widgets.register('zz_forecast', {\n" +
        "    name: 'Forecast', description: 'Tomorrow, in one line',\n" +
        "    fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'city', label: 'City', type: 'text', default: 'Lima' }],\n" +
        "    render: async (s) => '<p class=\"forecast\">Sunny in ' + String(s.city).replace(/[<>&\"]/g, '') + '</p><script>alert(1)</script>',\n" +
        "  });\n" +
        "  // A core widget's id: refused by the host, the core widget stays.\n" +
        "  wordjs.widgets.register('text', { name: 'Hijack', render: () => '<p>hijacked</p>' });\n" +
        "};\n");
    await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    // Registration messages arrive just after load; wait for the widget to show up.
    for (let i = 0; i < 100 && !(await listed()).some((w) => w.id === 'zz_forecast'); i++) await new Promise((r) => setTimeout(r, 50));
});

after(async () => {
    try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(path.join(PLUGINS_DIR, SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(config.dbPath, { force: true }); } catch { /* */ }
});

test('the plugin widget is listed with its settings form, and a core widget cannot be taken over', async () => {
    const widgets = await listed();
    const forecast = widgets.find((w) => w.id === 'zz_forecast');
    assert.ok(forecast, JSON.stringify(widgets.map((w) => w.id)));
    assert.strictEqual(forecast.name, 'Forecast');
    assert.deepStrictEqual(forecast.fields.map((f: any) => f.name), ['title', 'city']);
    assert.strictEqual(widgets.find((w) => w.id === 'text').name, 'Text', 'the core text widget is untouched');
});

test('an instance renders through the plugin child with its stored settings', async () => {
    const add = await request(app).post('/api/v1/widgets/sidebars/footer-1').set(auth()).send({ widgetId: 'zz_forecast', settings: { title: 'Weather', city: 'Cusco' } });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const html = (await request(app).get('/api/v1/widgets/sidebars/footer-1/render')).text;
    assert.match(html, /<h3 class="widget-title">Weather<\/h3>/);
    assert.match(html, /<p class="forecast">Sunny in Cusco<\/p>/);
    assert.doesNotMatch(html, /hijacked/);
    assert.doesNotMatch(html, /<script/, "a plugin widget's markup is sanitized on the host");
});

test('unloading the plugin removes its widget; its instances render nothing', async () => {
    await unloadIsolatedPlugin(SLUG);
    assert.strictEqual((await listed()).some((w) => w.id === 'zz_forecast'), false);
    const html = (await request(app).get('/api/v1/widgets/sidebars/footer-1/render')).text;
    assert.doesNotMatch(html, /forecast/);
    assert.ok((await listed()).some((w) => w.id === 'text'), 'core widgets stay');
});
