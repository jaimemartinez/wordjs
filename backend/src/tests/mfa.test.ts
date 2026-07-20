/**
 * MULTI-FACTOR AUTH (TOTP) SUITE
 *
 * Drives the REAL /auth routers via supertest against a throwaway temp DB and proves the MFA contract:
 * enrollment (setup→enable→backup codes), the two-step login (password → challenge → TOTP/backup code →
 * session), single-use backup codes, disable-requires-a-code, the sessionOnly hardening (an API token
 * can't manage MFA), and that the TOTP secret + backup hashes never leak through toJSON.
 *
 * No CSRF middleware is mounted (like authz-idor.test.ts) so these tests isolate the MFA logic; the
 * login/mfa endpoints are exercised over plain POSTs.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mfa-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const totp = require('../core/totp');
const ApiToken = require('../models/ApiToken');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const PASSWORD = 'correct-horse-battery';
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let dbAsync: any;
let uid = 0;
const B = '/api/v1';
const jwtFor = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const bearer = (t: string) => `Bearer ${t}`;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('mfauser', ?, 'mfa@example.com', 'MFA User')`,
        [bcrypt.hashSync(PASSWORD, 10)]);
    uid = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [uid]);
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// Enroll the seeded user and return { secret, backupCodes }.
async function enroll() {
    const setup = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', bearer(jwtFor(uid, 'mfauser')));
    assert.strictEqual(setup.status, 200);
    const secret = setup.body.secret;
    const enable = await request(app).post(`${B}/auth/mfa/enable`).set('Authorization', bearer(jwtFor(uid, 'mfauser')))
        .send({ code: totp.totp(secret) });
    assert.strictEqual(enable.status, 200, JSON.stringify(enable.body));
    return { secret, backupCodes: enable.body.backupCodes as string[] };
}
// Disable using a code the test hasn't consumed yet (a fresh backup code) — a just-used TOTP step is
// now correctly rejected as a replay, so cleanup must not reuse it.
async function disableMfa(code: string) {
    const res = await request(app).post(`${B}/auth/mfa/disable`).set('Authorization', bearer(jwtFor(uid, 'mfauser')))
        .send({ code });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
}

test('TOTP core matches an RFC 6238 vector', () => {
    const s = totp.base32Encode(Buffer.from('12345678901234567890'));
    assert.strictEqual(totp.totp(s, { time: 59, digits: 8 }), '94287082');
});

test('enroll returns a secret + otpauth URI; enable activates + returns backup codes', async () => {
    const setup = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', bearer(jwtFor(uid, 'mfauser')));
    assert.strictEqual(setup.status, 200);
    assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
    assert.ok(setup.body.secret && setup.body.secret.length >= 16);
    // a bad code does not activate
    const bad = await request(app).post(`${B}/auth/mfa/enable`).set('Authorization', bearer(jwtFor(uid, 'mfauser'))).send({ code: '000000' });
    assert.strictEqual(bad.status, 400);
    // the right code activates + yields backup codes
    const good = await request(app).post(`${B}/auth/mfa/enable`).set('Authorization', bearer(jwtFor(uid, 'mfauser'))).send({ code: totp.totp(setup.body.secret) });
    assert.strictEqual(good.status, 200);
    assert.ok(Array.isArray(good.body.backupCodes) && good.body.backupCodes.length === 10);
    const status = await request(app).get(`${B}/auth/mfa/status`).set('Authorization', bearer(jwtFor(uid, 'mfauser')));
    assert.strictEqual(status.body.enabled, true);
    assert.strictEqual(status.body.backupCodesRemaining, 10);
    await disableMfa(good.body.backupCodes[9]);
});

test('login requires a second factor and completes with a valid TOTP code', async () => {
    const { secret, backupCodes } = await enroll();
    // password step → mfaRequired, NO session cookie
    const login = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.mfaRequired, true);
    assert.ok(login.body.mfaToken);
    assert.strictEqual(login.body.user, undefined, 'no user/session before the 2nd factor');
    assert.ok(!(login.headers['set-cookie'] || []).some((c: string) => c.startsWith('wordjs_token=') && !c.includes('wordjs_token=;')));
    // wrong code → 401
    const wrong = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: login.body.mfaToken, code: '000000' });
    assert.strictEqual(wrong.status, 401);
    // correct code → session issued
    const usedCode = totp.totp(secret);
    const ok = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: login.body.mfaToken, code: usedCode });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.user.id, uid);
    assert.ok((ok.headers['set-cookie'] || []).some((c: string) => c.startsWith('wordjs_token=')));
    // REPLAY: the SAME code (same time-step) must not be reusable (RFC 6238 §5.2 one-time-use)
    const l2 = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    const replay = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l2.body.mfaToken, code: usedCode });
    assert.strictEqual(replay.status, 401, 'a consumed TOTP step cannot be replayed');
    await disableMfa(backupCodes[9]);
});

test('a backup code logs in once and is then consumed (single-use)', async () => {
    const { secret, backupCodes } = await enroll();
    const code = backupCodes[0];
    // login with the backup code
    const l1 = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    const use1 = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l1.body.mfaToken, code });
    assert.strictEqual(use1.status, 200, 'backup code works once');
    // reuse the same backup code → rejected
    const l2 = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    const use2 = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l2.body.mfaToken, code });
    assert.strictEqual(use2.status, 401, 'a consumed backup code cannot be reused');
    // a TOTP still works
    const l3 = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    const use3 = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l3.body.mfaToken, code: totp.totp(secret) });
    assert.strictEqual(use3.status, 200);
    await disableMfa(backupCodes[9]);
});

test('an invalid/absent challenge token is rejected at the 2nd step', async () => {
    const res = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: 'not-a-token', code: '123456' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'rest_mfa_challenge_invalid');
});

test('the MFA challenge token cannot authenticate a request (it is not a session credential)', async () => {
    const { backupCodes } = await enroll();
    const login = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    assert.ok(login.body.mfaToken);
    // presenting the challenge token as a Bearer session MUST be rejected — otherwise the 2nd factor is
    // bypassable with the password alone.
    const me = await request(app).get(`${B}/auth/me`).set('Authorization', bearer(login.body.mfaToken));
    assert.strictEqual(me.status, 401);
    await disableMfa(backupCodes[9]);
});

test('disable requires a valid code; afterwards login no longer needs a 2nd factor', async () => {
    const { secret } = await enroll();
    const bad = await request(app).post(`${B}/auth/mfa/disable`).set('Authorization', bearer(jwtFor(uid, 'mfauser'))).send({ code: '000000' });
    assert.strictEqual(bad.status, 400);
    const good = await request(app).post(`${B}/auth/mfa/disable`).set('Authorization', bearer(jwtFor(uid, 'mfauser'))).send({ code: totp.totp(secret) });
    assert.strictEqual(good.status, 200);
    const login = await request(app).post(`${B}/auth/login`).send({ username: 'mfauser', password: PASSWORD });
    assert.notStrictEqual(login.body.mfaRequired, true);
    assert.ok(login.body.user, 'session issued directly once MFA is off');
});

test('an API token cannot manage MFA (sessionOnly hardening)', async () => {
    const { token } = await ApiToken.generate({ userId: uid, name: 'mfa', scopes: 'write' });
    for (const ep of ['/auth/mfa/setup', '/auth/mfa/enable', '/auth/mfa/disable', '/auth/mfa/backup-codes']) {
        const res = await request(app).post(`${B}${ep}`).set('Authorization', bearer(token)).send({ code: '123456' });
        assert.strictEqual(res.status, 403, `${ep} should be sessionOnly`);
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
    }
});

test('the TOTP secret + backup hashes never leak through the user JSON', async () => {
    const { secret, backupCodes } = await enroll();
    const me = await request(app).get(`${B}/auth/me`).set('Authorization', bearer(jwtFor(uid, 'mfauser')));
    assert.strictEqual(me.status, 200);
    const metaKeys = Object.keys(me.body.meta || {});
    assert.ok(!metaKeys.includes('mfa_totp_secret'), 'secret must be stripped from meta');
    assert.ok(!metaKeys.includes('mfa_recovery_codes'), 'backup hashes must be stripped from meta');
    const blob = JSON.stringify(me.body);
    assert.ok(!blob.includes(secret), 'the raw secret must not appear anywhere in the user JSON');
    // the non-sensitive enabled flag MAY be present (UI needs it) — that is fine.
    await disableMfa(backupCodes[9]);
});
