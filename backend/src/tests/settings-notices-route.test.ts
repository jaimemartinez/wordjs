/**
 * GET /api/v1/settings/notices — reachable at all (audit 2026-08-18 #30).
 *
 * `router.get('/:key')` was registered 145 lines ABOVE `router.get('/notices')`, and Express matches
 * in registration order: every request for the notices list was answered by the wildcard with
 * key='notices', which is not in PUBLIC_SETTINGS and — because the wildcard never consults the
 * session — returned 403 rest_forbidden even to an administrator. CrashGuard is the only writer of
 * `admin_notices` (a plugin auto-disabled after three boot crashes) and nothing else reads it, so the
 * explanation was unreachable, the ids needed by DELETE /notices/:id were unknowable, and the
 * autoloaded option grew unpruned.
 *
 * FIXTURE-VS-PRODUCER: the shadowing is a property of Express's real matcher, so nothing here
 * hand-builds a request or calls a handler directly — supertest drives the REAL router as index.ts
 * mounts it. Against the pre-fix file the first test returns 403 and fails.
 *
 * Same CWD-sandbox ordering as chrome-api.test.ts: chdir into a temp root BEFORE requiring anything
 * that resolves paths from the CWD at module load. node --test runs each file in its own process.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-settings-notices-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('GET /api/v1/settings/notices is not shadowed by GET /:key', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;
    let updateOption: any;

    const NOTICES = [
        { id: 'crash-guard-1', type: 'error', message: 'Plugin "acme" was disabled after 3 boot crashes.' },
        { id: 'crash-guard-2', type: 'warning', message: 'Plugin "beta" is unstable.' },
    ];

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['subscriber', 'x', 'sub@example.com', 'Subscriber']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );

        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // Seed the option the way CrashGuard does — through the real options layer.
        ({ updateOption } = require('../core/options'));
        await updateOption('admin_notices', NOTICES);

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('an admin gets the notices list, not a 403 from the wildcard', async () => {
        const res = await request(app)
            .get('/api/v1/settings/notices')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200, `expected the notices handler, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.deepStrictEqual(res.body, NOTICES);
    });

    it('the ids it returns are the ones DELETE accepts — the loop CrashGuard needs to be prunable', async () => {
        const list = await request(app).get('/api/v1/settings/notices').set('Authorization', `Bearer ${adminToken}`);
        const id = list.body[0].id;
        const del = await request(app)
            .delete(`/api/v1/settings/notices/${id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.remaining, 1);

        const after = await request(app).get('/api/v1/settings/notices').set('Authorization', `Bearer ${adminToken}`);
        assert.deepStrictEqual(after.body.map((n: any) => n.id), ['crash-guard-2']);
    });

    it('moving the route above the wildcard did NOT open it: anonymous 401, non-admin 403', async () => {
        const anon = await request(app).get('/api/v1/settings/notices');
        assert.strictEqual(anon.status, 401);
        const sub = await request(app)
            .get('/api/v1/settings/notices')
            .set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual(sub.status, 403);
    });

    it('the wildcard still answers everything else exactly as before', async () => {
        // A public setting reads without a session…
        await updateOption('blogname', 'Notices Lab');
        const pub = await request(app).get('/api/v1/settings/blogname');
        assert.strictEqual(pub.status, 200);
        assert.deepStrictEqual(pub.body, { key: 'blogname', value: 'Notices Lab' });

        // …and a non-public one is still refused by the wildcard, admin or not.
        const priv = await request(app).get('/api/v1/settings/admin_email');
        assert.strictEqual(priv.status, 403);
        assert.strictEqual(priv.body.code, 'rest_forbidden');
    });
});
