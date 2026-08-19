/**
 * /api/v1/notices — the admin-notices feature, end to end on the backend side (audit 2026-08-18 #30).
 *
 * The original defect was that `GET /settings/:key` shadowed `GET /settings/notices` into a permanent
 * 403, so the CrashGuard explanation for an auto-disabled plugin was unreadable and the ids DELETE
 * needs were unknowable. Wave 1 unshadowed the path; this closes the rest: notices live at their own
 * namespace, which has NO wildcard that could ever shadow them again, and the /admin/notices screen
 * calls exactly these two routes.
 *
 * FIXTURE-VS-PRODUCER: supertest drives the REAL router tree — `routes/index.ts` mounted under the
 * real API prefix — so the paths asserted here are the paths a browser gets, and route ORDER (the
 * whole bug) is exercised by Express's own matcher rather than assumed. The notice itself is seeded
 * through the real options layer with the SHAPE CrashGuard writes (HTML in `message` included).
 *
 * Same CWD-sandbox ordering as settings-notices-route.test.ts: chdir into a temp root BEFORE
 * requiring anything that resolves paths from the CWD at load time. node --test isolates each file.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-notices-router-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('/api/v1/notices (admin notices have their own namespace)', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;
    let updateOption: any;
    let getOption: any;

    // The exact shape core/plugins.ts CrashGuard appends when a plugin is auto-disabled after three
    // consecutive boot crashes — HTML in the message and all.
    const CRASH_NOTICE = {
        id: 'crash-acme-1750000000000',
        type: 'error',
        message: '🚨 <b>Critical Error:</b> The plugin <strong>acme</strong> caused 3 consecutive crashes during startup and has been automatically disabled for your safety. Please check the logs or contact the plugin author.',
        dismissible: true,
        timestamp: 1750000000000,
    };
    const SECOND_NOTICE = {
        id: 'crash-beta-1750000009999',
        type: 'warning',
        message: 'The plugin <strong>beta</strong> is unstable.',
        dismissible: true,
        timestamp: 1750000009999,
    };

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

        ({ updateOption, getOption } = require('../core/options'));
        await updateOption('admin_notices', [CRASH_NOTICE, SECOND_NOTICE]);

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        // The REAL router tree at the REAL prefix — the mount is part of what is under test.
        app.use(config.api.prefix, require('../routes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('is mounted: an admin reads the CrashGuard notice the plugin supervisor wrote', async () => {
        const res = await request(app)
            .get('/api/v1/notices')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200, `expected the notices router, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.ok(Array.isArray(res.body), 'the list must be an array the screen can map over');
        assert.deepStrictEqual(res.body.map((n: any) => n.id), [CRASH_NOTICE.id, SECOND_NOTICE.id]);
        // The EXPLANATION is what the administrator was missing — the plugin slug and the reason.
        assert.match(res.body[0].message, /acme/);
        assert.match(res.body[0].message, /automatically disabled/);
    });

    it('is admin-only: anonymous 401, non-admin 403 — its own namespace did not open it up', async () => {
        const anon = await request(app).get('/api/v1/notices');
        assert.strictEqual(anon.status, 401);
        const sub = await request(app)
            .get('/api/v1/notices')
            .set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual(sub.status, 403);

        const delAnon = await request(app).delete(`/api/v1/notices/${CRASH_NOTICE.id}`);
        assert.strictEqual(delAnon.status, 401);
        const delSub = await request(app)
            .delete(`/api/v1/notices/${CRASH_NOTICE.id}`)
            .set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual(delSub.status, 403);
    });

    it('the ids it returns are the ids DELETE accepts, and the option really shrinks', async () => {
        const list = await request(app).get('/api/v1/notices').set('Authorization', `Bearer ${adminToken}`);
        const id = list.body[0].id;

        const del = await request(app)
            .delete(`/api/v1/notices/${encodeURIComponent(id)}`)
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.remaining, 1);

        // The autoloaded option is what grew unpruned in the original defect: assert the STORE, not
        // just the response body.
        const stored = await getOption('admin_notices', []);
        assert.deepStrictEqual(stored.map((n: any) => n.id), [SECOND_NOTICE.id]);

        const after = await request(app).get('/api/v1/notices').set('Authorization', `Bearer ${adminToken}`);
        assert.deepStrictEqual(after.body.map((n: any) => n.id), [SECOND_NOTICE.id]);
    });

    it('dismissing an id that is already gone is a no-op, not an error', async () => {
        const del = await request(app)
            .delete('/api/v1/notices/does-not-exist')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.remaining, 1);
    });

    it('the LEGACY /settings/notices paths still answer — one implementation, two mounts', async () => {
        const legacy = await request(app)
            .get('/api/v1/settings/notices')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(legacy.status, 200, 'moving notices to their own router must not break the old path');
        assert.deepStrictEqual(legacy.body.map((n: any) => n.id), [SECOND_NOTICE.id]);

        // And the wildcard it used to be shadowed by still answers everything else.
        const publicSetting = await request(app).get('/api/v1/settings/blogname');
        assert.strictEqual(publicSetting.status, 200);

        const legacyDel = await request(app)
            .delete(`/api/v1/settings/notices/${encodeURIComponent(SECOND_NOTICE.id)}`)
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(legacyDel.status, 200);
        assert.strictEqual(legacyDel.body.remaining, 0);
    });

    it('a malformed option cannot break the screen: a non-array reads as an empty list', async () => {
        await updateOption('admin_notices', { not: 'an array' });
        const res = await request(app).get('/api/v1/notices').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, []);
        await updateOption('admin_notices', []);
    });
});
