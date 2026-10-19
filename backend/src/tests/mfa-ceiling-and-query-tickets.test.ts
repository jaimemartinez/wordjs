/**
 * TWO CREDENTIAL RULES, on the real routers.
 *
 *   1. THE CODE CEILING HOLDS. Past MFA_MANAGE_PASSWORD_AFTER wrong codes on one account, the
 *      code-checking session doors (/auth/mfa/disable, /auth/mfa/backup-codes, the `mfaCode` step-up) want
 *      the account password as well — and that stays true after the failure WAIT's 15-minute window has
 *      gone quiet, for a day, until a correct code at those doors or a password sign-in. Concurrent
 *      requests cannot all slip under it: each attempt is counted before its code is checked.
 *   2. THE QUERY STRING CARRIES TICKETS ONLY. `?token=` on the routes that accept it (authenticateAllowQuery)
 *      takes a 60-second ticket issued for that very path (POST /auth/query-ticket), never a session JWT or
 *      an API token; a ticket opens nothing else, expires, and dies with the session's revocation.
 *
 * MUTATION PROOF (verified once each): read the ceiling from loginFailCount again in verifyManagedMfaCode
 * → the idle-window and race tests fail; drop clearMfaCeiling from /auth/login → the sign-in test fails;
 * let authenticateAllowQuery verify the query value like a header (no ticketPath) → the session-in-query
 * test fails; drop the path comparison in verifyAndAttachUser → the other-path test fails.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-ceiling-tickets-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const mfa = require('../core/mfa');
const totp = require('../core/totp');
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { csrfProtection, mfaComplianceGate, sanitizeCookies } = require('../middleware/auth');
const authRoutes = require('../routes/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const PREFIX = config.api.prefix;
const PASSWORD = 'Correct-Horse-Battery-9';
const CEILING = authRoutes.MFA_MANAGE_PASSWORD_AFTER;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies);
app.use(PREFIX, csrfProtection);
app.use(PREFIX, mfaComplianceGate);
app.use(PREFIX, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

// Time travel for the windows under test: every Date.now() in the process (JWT iat/exp included) moves.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

const session = (p: string) => jwt.sign({ userId: U[p] }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const bearer = (p: string) => `Bearer ${session(p)}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, await User.hashPassword(PASSWORD), `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function enroll(p: string) {
    const secret = totp.generateSecret();
    await User.updateMeta(U[p], mfa.META.lastStep, '-1');
    await User.updateMeta(U[p], mfa.META.secret, secret);
    await User.updateMeta(U[p], mfa.META.backup, JSON.stringify([]));
    await User.updateMeta(U[p], mfa.META.enabled, '1');
    return secret;
}

/** A code of a NEW time step (the anti-replay check refuses a step already used): move the clock one step on. */
async function freshCode(secret: string): Promise<string> {
    offsetMs += 31 * 1000;
    return totp.totp(secret);
}

async function wrongCodes(p: string, n: number) {
    for (let i = 0; i < n; i++) {
        const r = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer(p)).send({ code: '000000' });
        assert.strictEqual(r.status, 400, `wrong code ${i + 1}: ${r.status} ${JSON.stringify(r.body)}`);
    }
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    for (const login of ['idle', 'race', 'signin', 'tick']) await seedUser(login, 'administrator');
});

after(async () => {
    Date.now = realNow;
    try { await database.closeDatabase(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch { /* */ } }
});

// ── 1. The ceiling ──────────────────────────────────────────────────────────────────────────────────
test('the ceiling survives the 15-minute quiet that resets the failure wait, and ends after a day', { timeout: 180000 }, async () => {
    const secret = await enroll('idle');
    await wrongCodes('idle', CEILING);
    offsetMs += 16 * 60 * 1000; // the wait's window (LOGIN_LOCK_MS) has gone quiet
    const quiet = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer('idle')).send({ code: await freshCode(secret) });
    assert.strictEqual(quiet.status, 403, `the ceiling reopened after 16 idle minutes: ${JSON.stringify(quiet.body)}`);
    assert.strictEqual(quiet.body.code, 'rest_mfa_password_required');
    offsetMs += 25 * 60 * 60 * 1000;
    const nextDay = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer('idle')).send({ code: await freshCode(secret) });
    assert.strictEqual(nextDay.status, 200, `a day later a correct code alone works again: ${JSON.stringify(nextDay.body)}`);
});

test('concurrent requests at the edge of the ceiling do not all get under it', { timeout: 180000 }, async () => {
    await enroll('race');
    await wrongCodes('race', CEILING - 1);
    const n = authRoutes.MAX_LOGIN_INFLIGHT;
    const burst = await Promise.all(Array.from({ length: n }, () =>
        request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer('race')).send({ code: '000000' })));
    const checked = burst.filter((r: any) => r.status === 400 && r.body.code === 'rest_mfa_invalid').length;
    const held = burst.filter((r: any) => r.status === 403 && r.body.code === 'rest_mfa_password_required').length;
    assert.strictEqual(checked, 1, `exactly one more code may be checked without the password: ${JSON.stringify(burst.map((r: any) => [r.status, r.body.code]))}`);
    assert.strictEqual(held, n - 1);
});

test('a password sign-in ends the ceiling', { timeout: 180000 }, async () => {
    const secret = await enroll('signin');
    await wrongCodes('signin', CEILING);
    const held = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer('signin')).send({ code: await freshCode(secret) });
    assert.strictEqual(held.body.code, 'rest_mfa_password_required', JSON.stringify(held.body));
    // The owner signs in with the password (the second factor is asked for next; the password proved itself).
    const login = await request(app).post(`${PREFIX}/auth/login`).set('Host', '127.0.0.1').set('Origin', 'http://127.0.0.1')
        .send({ username: 'signin', password: PASSWORD });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const after = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`).set('Authorization', bearer('signin')).send({ code: await freshCode(secret) });
    assert.strictEqual(after.status, 200, `after a password sign-in a correct code alone works: ${JSON.stringify(after.body)}`);
});

// ── 2. Query tickets ────────────────────────────────────────────────────────────────────────────────
const DOWNLOAD = `${PREFIX}/plugins/no-such-plugin/download`;

test('a session JWT or an API token in ?token= authenticates nothing', async () => {
    const asQuery = await request(app).get(DOWNLOAD).query({ token: session('tick') });
    assert.strictEqual(asQuery.status, 401, `session JWT in the query string: ${asQuery.status} ${JSON.stringify(asQuery.body)}`);
    const { token } = await ApiToken.generate({ userId: U.tick, name: 'q', scopes: '*', expiresInDays: null });
    const apiQuery = await request(app).get(DOWNLOAD).query({ token });
    assert.strictEqual(apiQuery.status, 401, `API token in the query string: ${apiQuery.status} ${JSON.stringify(apiQuery.body)}`);
    // Control: the same session as a header is still accepted (the plugin does not exist: 404, not 401).
    const header = await request(app).get(DOWNLOAD).set('Authorization', bearer('tick'));
    assert.strictEqual(header.status, 404, JSON.stringify(header.body));
});

test('a ticket opens its own path from the query string, and nothing else', async () => {
    const issued = await request(app).post(`${PREFIX}/auth/query-ticket`).set('Authorization', bearer('tick')).send({ path: DOWNLOAD });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const ticket = issued.body.ticket;
    assert.strictEqual(issued.body.expiresIn, 60);

    const own = await request(app).get(DOWNLOAD).query({ token: ticket });
    assert.strictEqual(own.status, 404, `the ticket opens its path (the plugin does not exist): ${own.status} ${JSON.stringify(own.body)}`);
    const other = await request(app).get(`${PREFIX}/plugins/another-plugin/download`).query({ token: ticket });
    assert.strictEqual(other.status, 401, `another path: ${JSON.stringify(other.body)}`);
    const asHeader = await request(app).get(`${PREFIX}/users/me`).set('Authorization', `Bearer ${ticket}`);
    assert.strictEqual(asHeader.status, 401, `as a session elsewhere: ${JSON.stringify(asHeader.body)}`);

    offsetMs += 61 * 1000;
    const expired = await request(app).get(DOWNLOAD).query({ token: ticket });
    assert.strictEqual(expired.status, 401, `an expired ticket: ${JSON.stringify(expired.body)}`);
});

test('a ticket dies with its session, and only listed paths and interactive sessions get one', async () => {
    const issued = await request(app).post(`${PREFIX}/auth/query-ticket`).set('Authorization', bearer('tick')).send({ path: `${PREFIX}/notifications/stream` });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const stream = `${PREFIX}/notifications/stream`;
    offsetMs += 2000;
    await User.updateMeta(U.tick, 'token_valid_after', String(Math.floor(Date.now() / 1000)));
    await require('../core/cache').del(`user:${U.tick}`);
    const revoked = await request(app).get(stream).query({ token: issued.body.ticket });
    assert.strictEqual(revoked.status, 401, `a ticket after the account's sessions were revoked: ${JSON.stringify(revoked.body)}`);

    offsetMs += 2000;
    for (const p of [`${PREFIX}/users/me`, `${PREFIX}/plugins/x/download?y=1`, '/elsewhere', 42]) {
        const r = await request(app).post(`${PREFIX}/auth/query-ticket`).set('Authorization', bearer('tick')).send({ path: p });
        assert.strictEqual(r.status, 400, `${String(p)}: ${JSON.stringify(r.body)}`);
    }
    const { token } = await ApiToken.generate({ userId: U.tick, name: 'mint', scopes: '*', expiresInDays: null });
    const headless = await request(app).post(`${PREFIX}/auth/query-ticket`).set('Authorization', `Bearer ${token}`).send({ path: DOWNLOAD });
    assert.strictEqual(headless.status, 403, JSON.stringify(headless.body));
});
