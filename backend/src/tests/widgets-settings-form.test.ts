/**
 * WordJS — a widget instance's settings are edited through the form its widget declares.
 *
 * The Widgets screen said "settings editing coming soon": instances could be added, ordered and removed,
 * never configured. A widget now declares its settings as `fields` (core/widgets), GET /widgets carries
 * them, GET /widgets/:widgetId/instances/:instanceId reads an instance, and PUT stores ONLY the declared
 * fields, coerced to their type and bounded — the renderer reads what is stored, so it is never whatever
 * the request carried. Adding a widget to a sidebar applies the same rule. Driven through the real router.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-widgets-form-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '10mb' })); // the app's own limit is above the widget bound tested below
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

let adminId = 0;
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

test('GET /widgets carries each built-in widget\'s settings form', async () => {
    const res = await request(app).get('/api/v1/widgets');
    assert.strictEqual(res.status, 200);
    const byId = Object.fromEntries(res.body.map((w: any) => [w.id, w]));
    assert.deepStrictEqual(byId.recent_posts.fields.map((f: any) => [f.name, f.type]), [['title', 'text'], ['number', 'number']]);
    assert.deepStrictEqual(byId.text.fields.map((f: any) => f.name), ['title', 'content']);
    assert.deepStrictEqual(byId.categories.fields.map((f: any) => [f.name, f.type]), [['title', 'text'], ['hideEmpty', 'checkbox']]);
    assert.deepStrictEqual(byId.custom_html.fields.map((f: any) => f.name), ['title', 'html']);
});

test('an instance is read and saved through its form; only declared fields are stored, coerced and bounded', async () => {
    const add = await request(app).post('/api/v1/widgets/sidebars/sidebar-1').set(auth()).send({ widgetId: 'recent_posts', settings: { number: '7', evil: '<script>' } });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const instanceId = String(add.body.instanceKey).slice('recent_posts-'.length);

    const read = await request(app).get(`/api/v1/widgets/recent_posts/instances/${instanceId}`).set(auth());
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(read.body.settings, { number: 7 }, 'the add kept only the declared field, as a number');

    const put = await request(app).put(`/api/v1/widgets/recent_posts/instances/${instanceId}`).set(auth())
        .send({ settings: { title: 'Latest', number: 500, extra: 'dropped' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.deepStrictEqual(put.body.settings, { title: 'Latest', number: 20 });
    const again = await request(app).get(`/api/v1/widgets/recent_posts/instances/${instanceId}`).set(auth());
    assert.deepStrictEqual(again.body.settings, { title: 'Latest', number: 20 });

    // The renderer reads what was stored: the title shows, escaped, above the list.
    const html = await request(app).get('/api/v1/widgets/sidebars/sidebar-1/render');
    assert.ok(html.text.includes('Latest'), html.text);
});

test('a checkbox is a boolean and a title is clipped', async () => {
    const add = await request(app).post('/api/v1/widgets/sidebars/sidebar-1').set(auth()).send({ widgetId: 'categories' });
    const instanceId = String(add.body.instanceKey).slice('categories-'.length);
    const put = await request(app).put(`/api/v1/widgets/categories/instances/${instanceId}`).set(auth())
        .send({ settings: { hideEmpty: 'on', title: 'x'.repeat(1000) } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.settings.hideEmpty, true);
    assert.strictEqual(put.body.settings.title.length, 200);
});

test('unknown widgets and malformed settings are refused; reading and writing are admin-only', async () => {
    assert.strictEqual((await request(app).get('/api/v1/widgets/no_such/instances/x').set(auth())).status, 404);
    assert.strictEqual((await request(app).put('/api/v1/widgets/no_such/instances/x').set(auth()).send({ settings: {} })).status, 404);
    assert.strictEqual((await request(app).post('/api/v1/widgets/sidebars/sidebar-1').set(auth()).send({ widgetId: 'no_such' })).status, 404);
    assert.strictEqual((await request(app).put('/api/v1/widgets/text/instances/x').set(auth()).send({ settings: ['a'] })).status, 400);
    assert.strictEqual((await request(app).get('/api/v1/widgets/text/instances/x')).status, 401);
    assert.ok([401, 403].includes((await request(app).put('/api/v1/widgets/text/instances/x').send({ settings: {} })).status));
});

test('a plugin widget without a form keeps storing a bounded JSON object', async () => {
    const W = require('../core/widgets');
    W.registerWidget('zz_free', 'Free form', { render: async (s: any) => `<p>${s.n}</p>` });
    try {
        const ok = await request(app).put('/api/v1/widgets/zz_free/instances/a1').set(auth()).send({ settings: { n: 1, nested: { a: [1, 2] } } });
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(ok.body.settings, { n: 1, nested: { a: [1, 2] } });
        const big = await request(app).put('/api/v1/widgets/zz_free/instances/a1').set(auth()).send({ settings: { blob: 'x'.repeat(200 * 1024) } });
        assert.strictEqual(big.status, 400);
    } finally {
        W.unregisterWidget('zz_free');
    }
});
