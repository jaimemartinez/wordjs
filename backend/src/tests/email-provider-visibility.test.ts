/**
 * Email-provider visibility (FRENTE C-4, part A).
 *
 * The core cannot send email itself; a mail-PROVIDER plugin registers a host-wide sender
 * (global.wordjs_send_mail, gated behind the email:provider capability). When none is registered,
 * password recovery fails closed and SILENTLY. This pins that the fact is now VISIBLE:
 *
 *   1. core/mail-provider.isEmailProviderAvailable() is TRUE only while a provider is registered
 *      right now, FALSE otherwise (mutation-proved by toggling the global).
 *   2. The admin GET /settings/all payload carries a derived boolean `email_provider_available`
 *      that tracks (1). It is DELIBERATELY not on the public payload.
 *
 * node --test isolates this file in its own process, so mutating global.wordjs_send_mail leaks nowhere.
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-email-vis-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const { isEmailProviderAvailable } = require('../core/mail-provider');

describe('email provider: helper + admin visibility', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    afterEach(() => {
        // Never let a registered sender leak between cases.
        try { delete (global as any).wordjs_send_mail; } catch { /* ignore */ }
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------- 1. the helper

    it('isEmailProviderAvailable() is FALSE when no provider is registered', () => {
        delete (global as any).wordjs_send_mail;
        assert.strictEqual(isEmailProviderAvailable(), false);
    });

    it('isEmailProviderAvailable() is TRUE only when a provider function is registered', () => {
        (global as any).wordjs_send_mail = () => {};
        assert.strictEqual(isEmailProviderAvailable(), true);
        // A non-function must NOT count as a provider (fail-closed against a stray truthy value).
        (global as any).wordjs_send_mail = 'yes' as any;
        assert.strictEqual(isEmailProviderAvailable(), false);
    });

    // ------------------------------------------------------------- 2. admin visibility

    it('email_provider_available is FALSE on GET /settings/all with no provider', async () => {
        delete (global as any).wordjs_send_mail;
        const res = await request(app).get('/api/v1/settings/all').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(typeof res.body.email_provider_available, 'boolean', 'must be a REAL boolean');
        assert.strictEqual(res.body.email_provider_available, false);
    });

    it('email_provider_available flips TRUE once a provider registers', async () => {
        (global as any).wordjs_send_mail = () => {};
        const res = await request(app).get('/api/v1/settings/all').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.email_provider_available, true);
    });

    it('does NOT expose the flag on the public payload', async () => {
        (global as any).wordjs_send_mail = () => {};
        const pub = await request(app).get('/api/v1/settings'); // no auth
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.email_provider_available, undefined,
            'the email-provider flag must ride the admin payload only');
    });
});
