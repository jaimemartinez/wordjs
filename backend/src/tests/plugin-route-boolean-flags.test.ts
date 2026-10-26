/**
 * WordJS — the plugin routes' yes/no flags are JSON booleans, never "truthy".
 *
 * DELETE /plugins/:slug `dropData` removes the plugin's data directory and tables for good, and POST
 * /plugins/:slug/permissions `network` grants outbound network access. Read by truthiness, a form-encoded
 * or hand-written "false", "0", [false] or {} meant YES. Only `true` / `false` are accepted; an absent
 * flag takes the default (keep the data / no network); anything else is a 400 and changes nothing.
 */
process.env.NODE_ENV = 'production'; // a successful delete would otherwise regenerate frontend registries

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-plugin-flags-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');

const pluginsRouter = require('../routes/plugins');
const { resolveSafePluginDir } = pluginsRouter;

const app = express();
app.use(express.json());
app.use('/api/v1/plugins', pluginsRouter);

const ADMIN_PASS = 'correct-horse-battery-staple-7';
let adminToken = '';
const SLUG = 'test-flags-probe';

function writePlugin(): string {
    const dir = resolveSafePluginDir(SLUG);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: SLUG, version: '1.0.0', isolated: true, permissions: [{ scope: 'network', access: 'outbound', reason: 'probe' }],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), "exports.init = function () {};\n");
    fs.writeFileSync(path.join(dir, 'data', 'keep.txt'), 'precious');
    return dir;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const User = require('../models/User');
    const admin = await User.create({ username: 'flagadmin', email: 'flagadmin@example.com', password: ADMIN_PASS, role: 'administrator' });
    adminToken = jwt.sign({ userId: admin.id, username: 'flagadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    await require('../core/plugin-permissions').loadGrants();
});

after(async () => {
    try { fs.rmSync(resolveSafePluginDir(SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

const NOT_BOOLEAN = ['false', '0', 'true', 0, 1, [false], {}, null];

test('DELETE refuses a dropData that is not a JSON boolean, and deletes nothing', async () => {
    const dir = writePlugin();
    for (const dropData of NOT_BOOLEAN) {
        const r = await request(app).delete(`/api/v1/plugins/${SLUG}`).set('Authorization', `Bearer ${adminToken}`)
            .send({ password: ADMIN_PASS, dropData });
        assert.strictEqual(r.status, 400, `dropData=${JSON.stringify(dropData)} → ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(fs.existsSync(path.join(dir, 'data', 'keep.txt')), `dropData=${JSON.stringify(dropData)} touched the plugin's data`);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'and the plugin is still installed');
    }
});

test('DELETE with dropData false (or absent) keeps the data', async () => {
    writePlugin();
    const r = await request(app).delete(`/api/v1/plugins/${SLUG}`).set('Authorization', `Bearer ${adminToken}`)
        .send({ password: ADMIN_PASS, dropData: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true);
});

test('POST /permissions refuses a network flag that is not a JSON boolean', async () => {
    writePlugin();
    const perms = require('../core/plugin-permissions');
    for (const network of NOT_BOOLEAN) {
        const r = await request(app).post(`/api/v1/plugins/${SLUG}/permissions`).set('Authorization', `Bearer ${adminToken}`)
            .send({ granted: [], network });
        assert.strictEqual(r.status, 400, `network=${JSON.stringify(network)} → ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(perms.isNetworkGranted(SLUG), false, `network=${JSON.stringify(network)} granted the network`);
    }
    const ok = await request(app).post(`/api/v1/plugins/${SLUG}/permissions`).set('Authorization', `Bearer ${adminToken}`)
        .send({ granted: [], network: false });
    assert.ok(ok.status < 400, JSON.stringify(ok.body));
    assert.strictEqual(perms.isNetworkGranted(SLUG), false);
});
