/**
 * WordJS — Email verification on self-registration (FRENTE C-3) HTTP tests
 *
 * Drives the REAL auth router via supertest against a throwaway temp SQLite DB (mirrors
 * auth-password-reset.test.ts). Mounts ONLY the auth router (not the full barrel) so the suite does not
 * depend on unrelated routers/models.
 *
 * Proves:
 *   - with NO mail provider, `require_email_verification=1` resolves OFF (fail-closed): a new user is
 *     created ACTIVE and can log in immediately;
 *   - with a provider ready, registering creates NO account: the username cannot log in (the same 401 as
 *     any unknown login) until the tokenized link is followed, which creates the account; the link is
 *     single-use;
 *   - an account created UNVERIFIED by an earlier version (its link carries `uid`) is still refused with
 *     rest_email_unverified and still verifies through that link.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-emailverify-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

let request: any;
let app: any;
let sentMail: any[] = [];

const VERIFY_LINK_RE = /\/verify-email\?token=([a-f0-9]{64})(?![&a-f0-9])/i;

describe('Email verification on registration', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1'); // self-registration must be open for /register

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        // Mount ONLY the auth router — self-contained, and avoids loading unrelated routers.
        app.use('/api/v1/auth', require('../routes/auth'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { delete (global as any).wordjs_send_mail; } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    // --- FAIL-CLOSED: option ON but no provider → resolves OFF -------------------------------------
    it('with NO mail provider, require_email_verification resolves OFF and the user logs in immediately', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('require_email_verification', '1'); // requested ON…
        // …but no provider: global.wordjs_send_mail is unset AND mail_delivery_ready is not '1'.
        try { delete (global as any).wordjs_send_mail; } catch { /* */ }
        await updateOption('mail_delivery_ready', '0');

        const reg = await request(app).post('/api/v1/auth/register')
            .send({ username: 'noprovider', email: 'noprovider@gmail.com', password: 'origpass123' });
        assert.strictEqual(reg.status, 201, 'registration must succeed');
        assert.ok(!reg.body.verificationRequired, 'verification must NOT be required when no provider can deliver');

        // The account is active — it logs in right away (no verification gate).
        const login = await request(app).post('/api/v1/auth/login')
            .send({ username: 'noprovider', password: 'origpass123' });
        assert.strictEqual(login.status, 200, 'an unverified-feature-off account must log in immediately');
        assert.ok(login.body.user, 'login returns the user');
    });

    // --- Provider ready → full verify round-trip --------------------------------------------------
    it('with a provider ready, registering creates nothing until the link is followed, which creates the account', async () => {
        const { updateOption } = require('../core/options');
        const User = require('../models/User');
        sentMail = [];
        (global as any).wordjs_send_mail = (msg: any) => { sentMail.push(msg); return { queued: true }; };
        await updateOption('mail_delivery_ready', '1');
        await updateOption('require_email_verification', '1');

        const before = sentMail.length;
        const reg = await request(app).post('/api/v1/auth/register')
            .send({ username: 'verifyme', email: 'verifyme@gmail.com', password: 'origpass123' });
        assert.strictEqual(reg.status, 201, 'registration must succeed');
        assert.strictEqual(reg.body.verificationRequired, true, 'verification must be required');
        assert.ok(!reg.headers['set-cookie'], 'NO session cookie may be issued before the address is confirmed');
        assert.strictEqual(sentMail.length, before + 1, 'exactly one verification mail must be sent');
        assert.strictEqual(await User.findByLogin('verifyme'), null, 'no account exists until the link is followed');

        const msg = sentMail[sentMail.length - 1];
        assert.strictEqual(String(msg.to).toLowerCase(), 'verifyme@gmail.com', 'verification mail targets the registered address');
        const m = String(msg.text || msg.html || '').match(VERIFY_LINK_RE);
        if (!m) { assert.fail('the mail body must contain a verify-email link with a token'); return; }
        const token = m[1];

        // There is no account yet, so the correct password is refused exactly like an unknown login.
        const refused = await request(app).post('/api/v1/auth/login')
            .send({ username: 'verifyme', password: 'origpass123' });
        assert.strictEqual(refused.status, 401, 'nothing to log in to before the link is followed');
        assert.strictEqual(refused.body.code, 'rest_invalid_credentials');

        // A wrong token does not verify (and does not create anything).
        const wrong = await request(app).post('/api/v1/auth/verify-email').send({ token: 'deadbeef'.repeat(8) });
        assert.strictEqual(wrong.status, 400, 'a wrong verification token must be rejected');
        assert.strictEqual(await User.findByLogin('verifyme'), null);

        // Correct token → the account is created, and is active.
        const good = await request(app).post('/api/v1/auth/verify-email').send({ token });
        assert.strictEqual(good.status, 200, 'a valid token must verify the registration');
        const created = await User.findByLogin('verifyme');
        assert.ok(created, 'the account exists once the link is followed');
        assert.strictEqual(created.userEmail, 'verifyme@gmail.com');

        // Now login succeeds — with the password given at registration.
        const login = await request(app).post('/api/v1/auth/login')
            .send({ username: 'verifyme', password: 'origpass123' });
        assert.strictEqual(login.status, 200, 'a verified account must log in');
        assert.ok(login.body.user, 'login returns the user');

        // Single-use: replaying the consumed token fails.
        const replay = await request(app).post('/api/v1/auth/verify-email').send({ token });
        assert.strictEqual(replay.status, 400, 'a consumed verification token must not be replayable');
    });

    // --- An account created unverified by an earlier version keeps working --------------------------
    it('a legacy unverified account (link with uid) is still gated and still verifies through its link', async () => {
        const User = require('../models/User');
        const crypto = require('crypto');
        const legacy = await User.create({ username: 'legacyuser', email: 'legacyuser@gmail.com', password: 'origpass123' });
        const raw = crypto.randomBytes(32).toString('hex');
        await User.updateMeta(legacy.id, 'email_verification_hash', crypto.createHash('sha256').update(raw).digest('hex'));
        await User.updateMeta(legacy.id, 'email_verification_expires', String(Date.now() + 60_000));
        await User.updateMeta(legacy.id, 'email_verification_pending', '1');

        const refused = await request(app).post('/api/v1/auth/login').send({ username: 'legacyuser', password: 'origpass123' });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.body.code, 'rest_email_unverified');

        const good = await request(app).post('/api/v1/auth/verify-email').send({ uid: legacy.id, token: raw });
        assert.strictEqual(good.status, 200);
        const login = await request(app).post('/api/v1/auth/login').send({ username: 'legacyuser', password: 'origpass123' });
        assert.strictEqual(login.status, 200);
    });
});
