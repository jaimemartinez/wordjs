/**
 * A USERNAME MAY NEVER SHADOW ANOTHER ACCOUNT'S EMAIL, AND /auth/register IS NOT AN ENUMERATION ORACLE.
 *
 * Found by a red-team pass. Every sign-in lookup (User.authenticate, the login throttle's
 * findAccountByIdentifier, POST /auth/forgot-password) tried the identifier as a USERNAME before trying it
 * as an EMAIL, and a username was "any non-empty string not already taken". So an anonymous visitor on a
 * site with self-registration open could register the username "boss@gmail.com" — the administrator's
 * email — and from then on:
 *   · the administrator could no longer sign in with their email (the attacker's row answered first);
 *   · the attacker signed in with "boss@gmail.com" + their own password;
 *   · POST /auth/forgot-password {login: "boss@gmail.com"} mailed the reset link to the ATTACKER.
 * "Boss" and " boss" registered beside "boss" as well (impersonation), and /auth/register answered
 * "Email already exists" / "Username already exists" verbatim — an account-enumeration oracle that login,
 * forgot-password and /users/me deliberately do not offer.
 *
 * Drives the REAL auth router and the REAL User model against a throwaway SQLite database.
 *
 * MUTATION PROOF: let User.create accept any username again (drop the usernameError() check) and the
 * "boss@gmail.com" registration succeeds, the victim's email login fails and the reset mail goes to the
 * attacker; put back `findByLogin(...) || findByEmail(...)` in User.authenticate and the legacy-row case
 * fails; answer the duplicate with error.message again and the enumeration cases fail.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-identity-hijack-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

let request: any;
let app: any;
let User: any;
let sent: any[] = [];

const VICTIM = { username: 'boss', email: 'boss@gmail.com', password: 'VictimPass123' };

async function setVerification(on: boolean) {
    const { updateOption } = require('../core/options');
    await updateOption('require_email_verification', on ? '1' : '0');
}

describe('account identity: usernames, sign-in lookups and registration answers', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        (global as any).wordjs_send_mail = (m: any) => { sent.push(m); return { queued: true }; };
        await updateOption('mail_delivery_ready', '1');

        User = require('../models/User');
        await User.create({ ...VICTIM, role: 'administrator' });

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1/auth', require('../routes/auth'));
    });

    beforeEach(async () => { sent = []; await setVerification(false); });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { delete (global as any).wordjs_send_mail; } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    it('registering another account\'s EMAIL as a username is refused, and the victim keeps both doors', async () => {
        const reg = await request(app).post('/api/v1/auth/register')
            .send({ username: VICTIM.email, email: 'attacker@evil.example', password: 'AttackerPass1' });
        assert.strictEqual(reg.status, 400, `a username shaped like an email was accepted: ${JSON.stringify(reg.body)}`);
        assert.strictEqual(reg.body.code, 'rest_invalid_param');
        assert.ok(!(await User.findByLogin(VICTIM.email)), 'the shadowing row must not exist');

        const login = await request(app).post('/api/v1/auth/login').send({ username: VICTIM.email, password: VICTIM.password });
        assert.strictEqual(login.status, 200, `the victim could not sign in with their email: ${JSON.stringify(login.body)}`);
        assert.strictEqual(login.body.user.username, VICTIM.username);

        const forgot = await request(app).post('/api/v1/auth/forgot-password').send({ login: VICTIM.email });
        assert.strictEqual(forgot.status, 200);
        assert.deepStrictEqual(sent.map((m) => String(m.to).toLowerCase()), [VICTIM.email], 'the reset link must go to the victim only');
    });

    for (const variant of ['Boss', 'BOSS', ' boss', 'boss ', 'bo ss', 'boss\t']) {
        it(`the impersonation variant ${JSON.stringify(variant)} of an existing login is refused`, async () => {
            const reg = await request(app).post('/api/v1/auth/register')
                .send({ username: variant, email: `v${Date.now()}${Math.random().toString(36).slice(2, 6)}@gmail.com`, password: 'whatever123', displayName: 'boss' });
            assert.strictEqual(reg.status, 400, `${JSON.stringify(variant)} registered beside "boss": ${JSON.stringify(reg.body)}`);
        });
    }

    it('the model enforces the rule for every caller, not only the route', async () => {
        await assert.rejects(User.create({ username: 'x@y.example', email: 'xy1@gmail.com', password: 'p4ssword!!' }), /Invalid username/);
        await assert.rejects(User.create({ username: 'a'.repeat(61), email: 'xy2@gmail.com', password: 'p4ssword!!' }), /Invalid username/);
        await assert.rejects(User.create({ username: 'BOSS', email: 'xy3@gmail.com', password: 'p4ssword!!' }), /Username already exists/);
        const ok = await User.create({ username: 'a.valid_name-1', email: 'xy4@gmail.com', password: 'p4ssword!!' });
        assert.strictEqual(ok.userLogin, 'a.valid_name-1');
        assert.strictEqual(User.importableUsername('john doe@example.com'), 'john_doe_example.com');
    });

    it('a new EMAIL may not equal an existing (legacy) login, on create or on update', async () => {
        const { dbAsync } = require('../config/database');
        // A row created before the username rule, with an address-shaped login.
        await dbAsync.run(
            "INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename, user_registered) VALUES (?, 'x', ?, 'Legacy', 'legacy', CURRENT_TIMESTAMP)",
            ['legacy@corp.example', 'legacy-real@corp.example']);
        await assert.rejects(User.create({ username: 'newcomer', email: 'Legacy@corp.example', password: 'p4ssword!!' }), /Email already exists/);
        const other = await User.create({ username: 'other1', email: 'other1@gmail.com', password: 'p4ssword!!' });
        await assert.rejects(User.update(other.id, { email: 'legacy@corp.example' }), /already in use/);
    });

    it('an "@" identifier resolves as an EMAIL first, so a legacy "@" login cannot shadow the owner of that address', async () => {
        const { dbAsync } = require('../config/database');
        const bcrypt = require('bcryptjs');
        const owner = await User.create({ username: 'owner', email: 'owner@gmail.com', password: 'OwnerPass123' });
        // A pre-rule row whose LOGIN is the owner's email (exactly what the attack used to create).
        await dbAsync.run(
            'INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename, user_registered) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            ['owner@gmail.com', await bcrypt.hash('ShadowPass123', 4), 'shadow@evil.example', 'Shadow', 'shadow']);

        assert.strictEqual((await User.findByIdentifier('owner@gmail.com')).id, owner.id);
        const login = await request(app).post('/api/v1/auth/login').send({ username: 'owner@gmail.com', password: 'OwnerPass123' });
        assert.strictEqual(login.status, 200, `the owner was shadowed at sign-in: ${JSON.stringify(login.body)}`);
        assert.strictEqual(login.body.user.id, owner.id);
        const shadow = await request(app).post('/api/v1/auth/login').send({ username: 'owner@gmail.com', password: 'ShadowPass123' });
        assert.notStrictEqual(shadow.status, 200, 'the shadow row signed in with the owner\'s email as identifier');

        await request(app).post('/api/v1/auth/forgot-password').send({ login: 'owner@gmail.com' });
        assert.deepStrictEqual(sent.map((m) => m.to), ['owner@gmail.com'], 'the reset link went somewhere other than the owner');

        // A legacy '@' login still signs in when no account owns that address.
        await dbAsync.run(
            'INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename, user_registered) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            ['old@style.example', await bcrypt.hash('OldStyle1234', 4), 'old-real@style.example', 'Old', 'old']);
        const legacy = await request(app).post('/api/v1/auth/login').send({ username: 'old@style.example', password: 'OldStyle1234' });
        assert.strictEqual(legacy.status, 200, `a legacy "@" login stopped working: ${JSON.stringify(legacy.body)}`);
    });

    describe('POST /auth/register does not say whether an address has an account', () => {
        it('verification OFF: a taken email and a taken username get one generic 400', async () => {
            const byEmail = await request(app).post('/api/v1/auth/register')
                .send({ username: 'probe1', email: VICTIM.email, password: 'whatever123' });
            const byName = await request(app).post('/api/v1/auth/register')
                .send({ username: VICTIM.username, email: 'x1@gmail.com', password: 'whatever123' });
            assert.strictEqual(byEmail.status, 400);
            assert.strictEqual(byName.status, 400);
            assert.deepStrictEqual(byEmail.body, byName.body, 'the two duplicates must be indistinguishable');
            assert.doesNotMatch(JSON.stringify(byEmail.body), /email already|username already/i);
        });

        it('verification ON: a taken email gets the same 201 as a new one, and only its owner is told', async () => {
            await setVerification(true);
            const fresh = await request(app).post('/api/v1/auth/register')
                .send({ username: 'brandnew', email: 'brandnew@gmail.com', password: 'whatever123' });
            const taken = await request(app).post('/api/v1/auth/register')
                .send({ username: 'probe2', email: VICTIM.email, password: 'whatever123' });

            assert.strictEqual(fresh.status, 201, JSON.stringify(fresh.body));
            assert.strictEqual(taken.status, 201, `a taken email was answered differently: ${JSON.stringify(taken.body)}`);
            assert.deepStrictEqual(taken.body, fresh.body, 'the bodies must be identical');
            assert.ok(!fresh.headers['set-cookie'] && !taken.headers['set-cookie'], 'no session either way');
            assert.ok(!(await User.findByLogin('probe2')), 'nothing may be created for the taken address');

            const toVictim = sent.filter((m) => m.to === VICTIM.email);
            assert.strictEqual(toVictim.length, 1, 'the owner of the address gets one notice');
            assert.doesNotMatch(String(toVictim[0].text), /verify-email\?/, 'the notice must carry no verification link');
        });

        it('verification ON: a taken USERNAME is still a 400 (its availability is inherently observable)', async () => {
            await setVerification(true);
            const res = await request(app).post('/api/v1/auth/register')
                .send({ username: VICTIM.username, email: 'x2@gmail.com', password: 'whatever123' });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.code, 'rest_user_exists');
            assert.strictEqual(sent.length, 0, 'no mail for a refused username');
        });
    });
});
