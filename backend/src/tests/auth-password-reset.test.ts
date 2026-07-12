/**
 * WordJS - Password recovery ("olvidé mi contraseña") HTTP tests
 *
 * Exercises the REAL auth router via supertest against a throwaway temp SQLite DB, mirroring
 * api.test.ts. Forces the "mail ready" state (active_plugins + DNS-all-ok flag + a captured
 * global.wordjs_send_mail stub) so the full mint → email → consume round-trip is deterministic
 * without a real SMTP server.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repoint the DB at a temp file BEFORE requiring the DB layer / routers (see api.test.ts).
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-pwreset-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

let request: any;
let app: any;
let sentMail: any[] = [];

const RESET_LINK_RE = /\/reset-password\?uid=(\d+)&token=([a-f0-9]+)/i;

describe('Password recovery', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        // Capture every outbound mail so we can read the reset link the server generated.
        (global as any).wordjs_send_mail = (msg: any) => { sentMail.push(msg); return { queued: true }; };

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1', require('../routes'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    // --- Gating: before the mail server is marked ready --------------------------------------------
    it('probe reports unavailable when the mail server is not ready', async () => {
        const res = await request(app).get('/api/v1/auth/password-reset-available');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.available, false, 'reset must be gated off until mail is ready');
    });

    it('forgot-password is a no-op (uniform 200, no token) when mail is not ready', async () => {
        const User = require('../models/User');
        await User.create({ username: 'gateduser', email: 'gated@gmail.com', password: 'origpass123', role: 'subscriber' });
        const before = sentMail.length;

        const res = await request(app).post('/api/v1/auth/forgot-password').send({ login: 'gateduser' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(sentMail.length, before, 'no mail may be sent while gated');

        const u = await User.findByLogin('gateduser');
        const hash = await User.getMeta(u.id, 'password_reset_hash');
        assert.ok(!hash, 'no reset token may be minted while gated');
    });

    // --- Full round-trip once mail is ready -------------------------------------------------------
    it('mints a reset token, delivers it to the recovery address, and resets the password', async () => {
        const User = require('../models/User');
        const { updateOption } = require('../core/options');
        // Force the ready state GENERICALLY: a provider is present (the global.wordjs_send_mail stub set
        // in before()) + the shared `mail_delivery_ready` flag. No mail plugin slug is involved — this
        // proves recovery works with ANY provider that follows the contract, not just mail-server.
        await updateOption('mail_delivery_ready', '1');

        // Probe now reports available.
        const probe = await request(app).get('/api/v1/auth/password-reset-available');
        assert.strictEqual(probe.body.available, true, 'probe must report available once ready');

        await User.create({ username: 'resetme', email: 'resetme@gmail.com', password: 'origpass123', role: 'subscriber' });
        const before = sentMail.length;

        const res = await request(app).post('/api/v1/auth/forgot-password').send({ login: 'resetme' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(sentMail.length, before + 1, 'exactly one reset mail must be sent');

        const msg = sentMail[sentMail.length - 1];
        assert.strictEqual(String(msg.to).toLowerCase(), 'resetme@gmail.com', 'must target the external primary (reachable) address');
        const m = String(msg.text || msg.html || '').match(RESET_LINK_RE);
        if (!m) { assert.fail('the mail body must contain a reset link with uid + token'); return; }
        const uid = Number(m[1]);
        const token = m[2];

        // Wrong token → rejected.
        const wrong = await request(app).post('/api/v1/auth/reset-password').send({ uid, token: 'deadbeef', password: 'newpass12345' });
        assert.strictEqual(wrong.status, 400, 'a wrong token must be rejected');

        // Weak password → rejected (even with a valid token).
        const weak = await request(app).post('/api/v1/auth/reset-password').send({ uid, token, password: 'short' });
        assert.strictEqual(weak.status, 400, 'a weak password must be rejected');

        // Correct token + strong password → success.
        const good = await request(app).post('/api/v1/auth/reset-password').send({ uid, token, password: 'brandnewpw12345' });
        assert.strictEqual(good.status, 200, 'a valid token + strong password must succeed');

        // The new password works; the old one no longer does.
        await assert.doesNotReject(() => User.authenticate('resetme', 'brandnewpw12345'), 'new password must authenticate');
        await assert.rejects(() => User.authenticate('resetme', 'origpass123'), 'old password must no longer authenticate');

        // Single-use: replaying the same token fails (it was consumed).
        const replay = await request(app).post('/api/v1/auth/reset-password').send({ uid, token, password: 'yetanother12345' });
        assert.strictEqual(replay.status, 400, 'a consumed token must not be replayable');
    });

    it('rejects an expired token', async () => {
        const User = require('../models/User');
        const crypto = require('crypto');
        await User.create({ username: 'expireme', email: 'expireme@gmail.com', password: 'origpass123', role: 'subscriber' });
        const u = await User.findByLogin('expireme');
        const raw = 'a'.repeat(64);
        await User.updateMeta(u.id, 'password_reset_hash', crypto.createHash('sha256').update(raw).digest('hex'));
        await User.updateMeta(u.id, 'password_reset_expires', String(Date.now() - 1000)); // already expired

        const res = await request(app).post('/api/v1/auth/reset-password').send({ uid: u.id, token: raw, password: 'newpass12345' });
        assert.strictEqual(res.status, 400, 'an expired token must be rejected');
    });

    it('forgot-password stays uniform (200) for an unknown user even when ready', async () => {
        const before = sentMail.length;
        const res = await request(app).post('/api/v1/auth/forgot-password').send({ login: 'no-such-user-at-all' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(sentMail.length, before, 'no mail for a non-existent account (anti-enumeration)');
    });
});
