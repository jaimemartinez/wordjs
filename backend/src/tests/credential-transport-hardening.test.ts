/**
 * CREDENTIAL TRANSPORT + SECOND-FACTOR DOORS — one suite, four rules.
 *
 *   1. A machine credential (`wjt_` API token, `wja_` agent connection) is Bearer-only. Carried in the
 *      session cookie it authenticates nothing — on `authenticate`, `optionalAuth` and
 *      `authenticateAllowQuery` alike — so it can never become an ambient credential that skips the
 *      controls built for machine credentials.
 *   2. Creating an AI agent connection and granting it authority follow the SAME MFA-by-role rule as
 *      minting an API token (enrollment, then step-up), and the policy's token-exposure numbers count
 *      live agent connections.
 *   3. The code-checking account doors (/auth/mfa/disable, /auth/mfa/backup-codes, the `mfaCode` step-up)
 *      share an ACCOUNT-wide ceiling: past it, a code alone is not enough — the account password is
 *      required as well. Below it nothing changes.
 *   4. The same-origin check compares the scheme too: a plain-http page does not vouch for a request that
 *      arrived over https, on the CSRF gate and on the collaboration stream.
 *
 * MUTATION PROOF (each verified once): drop the prefix check in middleware/auth.ts sessionCookie → rule 1
 * fails; remove the requireMfaForMachineCredential calls from routes/agents.ts → rule 2 fails (and the
 * agent loop in core/mfa.ts tokenExposure → the exposure test fails); remove the ceiling block from
 * routes/auth.ts verifyManagedMfaCode → rule 3 fails; drop the protocol comparison in originMatchesHost
 * and the scheme filter in sameOriginAllowList → rule 4 fails.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-cred-transport-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const mfa = require('../core/mfa');
const totp = require('../core/totp');
const ApiToken = require('../models/ApiToken');
const AgentConnection = require('../models/AgentConnection');
const User = require('../models/User');
const { csrfProtection, mfaComplianceGate, sanitizeCookies, authenticate, optionalAuth, authenticateAllowQuery } = require('../middleware/auth');
const authRoutes = require('../routes/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const PREFIX = config.api.prefix;
const PASSWORD = 'Correct-Horse-Battery-9';

// The production order (index.ts): cookies, the cookie-value boundary, CSRF and the MFA gate at the
// prefix, then the routers.
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies);
app.use(PREFIX, csrfProtection);
app.use(PREFIX, mfaComplianceGate);
app.use(PREFIX, require('../routes'));

// The three authentication middlewares, each echoing who it resolved.
const probe = express();
probe.use(cookieParser());
probe.use(sanitizeCookies);
const who = (req: any, res: any) => res.json({ user: req.user ? req.user.id : null });
probe.get('/strict', authenticate, who);
probe.get('/optional', optionalAuth, who);
probe.get('/query', authenticateAllowQuery, who);

const U: Record<string, number> = {};
let dbAsync: any;

const mfaSession = (p: string) => jwt.sign({ userId: U[p], amr: ['mfa'] }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const plainSession = (p: string) => jwt.sign({ userId: U[p] }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, await User.hashPassword(PASSWORD), `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function enrollDirect(p: string) {
    const secret = totp.generateSecret();
    const codes = ['AAAAA-BBBBB', 'CCCCC-DDDDD', 'EEEEE-FFFFF', 'GGGGG-HHHHH'];
    await User.updateMeta(U[p], mfa.META.lastStep, '-1');
    await User.updateMeta(U[p], mfa.META.secret, secret);
    await User.updateMeta(U[p], mfa.META.backup, JSON.stringify(codes.map((c) => mfa.hashBackup(c))));
    await User.updateMeta(U[p], mfa.META.enabled, '1');
    return { secret, codes };
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('boss', 'administrator');
    await seedUser('ed', 'editor');
    await seedUser('ceil', 'administrator');
    await seedUser('ceil2', 'administrator');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch { /* */ } }
});

const policyOff = () => mfa.setPolicy({ requiredRoles: [], graceDays: 0 });

// ── 1. Machine credentials are Bearer-only ──────────────────────────────────────────────────────────
test('a wjt_ API token authenticates as a Bearer header but NOT through the session cookie', async () => {
    const { token } = await ApiToken.generate({ userId: U.ed, name: 'cookie-probe', scopes: 'read', expiresInDays: null });
    for (const route of ['/strict', '/optional', '/query']) {
        const bearer = await request(probe).get(route).set('Authorization', `Bearer ${token}`);
        assert.strictEqual(bearer.status, 200, `${route} (Bearer): ${JSON.stringify(bearer.body)}`);
        assert.strictEqual(bearer.body.user, U.ed, `${route}: the Bearer token must still authenticate (control)`);

        const viaCookie = await request(probe).get(route).set('Cookie', `wordjs_token=${token}`);
        if (route === '/optional') {
            assert.strictEqual(viaCookie.status, 200);
            assert.strictEqual(viaCookie.body.user, null, `${route}: an API token in the cookie must resolve to anonymous`);
        } else {
            assert.strictEqual(viaCookie.status, 401, `${route}: an API token in the cookie must not authenticate (${JSON.stringify(viaCookie.body)})`);
        }
    }
});

test('a wja_ agent token in the session cookie authenticates nothing either', async () => {
    const { token } = await AgentConnection.create({ userId: U.ed, name: 'cookie-agent', requested: ['content:read'], createdBy: U.ed });
    for (const route of ['/strict', '/query']) {
        const r = await request(probe).get(route).set('Cookie', `wordjs_token=${token}`);
        assert.strictEqual(r.status, 401, `${route}: ${JSON.stringify(r.body)}`);
    }
    const opt = await request(probe).get('/optional').set('Cookie', `wordjs_token=${token}`);
    assert.strictEqual(opt.body.user, null);
});

test('a session JWT in the cookie still authenticates (control)', async () => {
    const r = await request(probe).get('/strict').set('Cookie', `wordjs_token=${plainSession('ed')}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user, U.ed);
});

test('a cookie-borne API token cannot drive a write through the real stack', async () => {
    const { token } = await ApiToken.generate({ userId: U.ed, name: 'cookie-write', scopes: 'write', expiresInDays: null });
    const r = await request(app).post(`${PREFIX}/posts`)
        .set('Cookie', `wordjs_token=${token}`)
        .set('Origin', 'http://127.0.0.1')
        .set('Host', '127.0.0.1')
        .send({ title: 'should not exist', status: 'draft' });
    assert.ok(r.status === 401, `expected 401, got ${r.status} ${JSON.stringify(r.body)}`);
});

// ── 2. Agent connections follow the token-minting MFA rule ──────────────────────────────────────────
test('POST /agents is refused for a required-role user who has not enrolled, even within grace', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 30 });
    try {
        const r = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${plainSession('boss')}`)
            .send({ name: 'bot', requested: ['content:read'] });
        assert.strictEqual(r.status, 403, JSON.stringify(r.body));
        assert.strictEqual(r.body.code, 'rest_mfa_required_for_tokens');
    } finally { await policyOff(); }
});

test('POST /agents and PUT /agents/:id/grant need a 2FA session or a fresh code, like POST /auth/tokens', async () => {
    const { secret } = await enrollDirect('boss');
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 30 });
    try {
        const bare = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${plainSession('boss')}`).send({ name: 'bot', requested: ['content:read'] });
        assert.strictEqual(bare.status, 403, JSON.stringify(bare.body));
        assert.strictEqual(bare.body.code, 'rest_mfa_step_up_required');

        const wrong = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${plainSession('boss')}`).send({ name: 'bot', requested: ['content:read'], mfaCode: '000000' });
        assert.strictEqual(wrong.status, 400, JSON.stringify(wrong.body));
        assert.strictEqual(wrong.body.code, 'rest_mfa_invalid');

        const stepped = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${plainSession('boss')}`)
            .send({ name: 'bot', requested: ['content:read'], mfaCode: totp.totp(secret) });
        assert.strictEqual(stepped.status, 201, JSON.stringify(stepped.body));
        const id = stepped.body.connection.id;

        const grantBare = await request(app).put(`${PREFIX}/agents/${id}/grant`)
            .set('Authorization', `Bearer ${plainSession('boss')}`).send({ granted: ['content:read'] });
        assert.strictEqual(grantBare.status, 403, JSON.stringify(grantBare.body));
        assert.strictEqual(grantBare.body.code, 'rest_mfa_step_up_required');

        const grantMfa = await request(app).put(`${PREFIX}/agents/${id}/grant`)
            .set('Authorization', `Bearer ${mfaSession('boss')}`).send({ granted: ['content:read'] });
        assert.strictEqual(grantMfa.status, 200, JSON.stringify(grantMfa.body));
        assert.deepStrictEqual(grantMfa.body.connection.granted, ['content:read']);

        const viaMfaSession = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${mfaSession('boss')}`).send({ name: 'bot2', requested: ['content:read'] });
        assert.strictEqual(viaMfaSession.status, 201, JSON.stringify(viaMfaSession.body));
    } finally { await policyOff(); }
});

test('roles outside the policy create agent connections exactly as before (control)', async () => {
    // The policy covers editors; an administrator (outside it) with a plain session needs no code.
    await mfa.setPolicy({ requiredRoles: ['editor'], graceDays: 0 });
    try {
        const r = await request(app).post(`${PREFIX}/agents`)
            .set('Authorization', `Bearer ${plainSession('boss')}`).send({ name: 'boss-bot', requested: ['content:read'] });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    } finally { await policyOff(); }
});

test('tokenExposure counts live agent connections of required-role owners', async () => {
    await mfa.setPolicy({ requiredRoles: ['editor'], graceDays: 0 });
    try {
        const before = await mfa.tokenExposure();
        const { connection } = await AgentConnection.create({ userId: U.ed, name: 'exposed', requested: ['content:read'], createdBy: U.ed });
        const withAgent = await mfa.tokenExposure();
        assert.strictEqual(withAgent.requiredRoleTokens, before.requiredRoleTokens + 1, JSON.stringify({ before, withAgent }));
        assert.strictEqual(withAgent.unenrolledOwnerTokens, before.unenrolledOwnerTokens + 1);
        assert.strictEqual(withAgent.unenrolledOwners, 1, 'one owner, however many credentials');
        await AgentConnection.revoke(connection.id);
        assert.deepStrictEqual(await mfa.tokenExposure(), before, 'a revoked connection is no longer counted');
    } finally { await policyOff(); }
});

// ── 3. The account-wide ceiling on code-checking doors ──────────────────────────────────────────────
const CEILING = authRoutes.MFA_MANAGE_PASSWORD_AFTER;

/** Spend the ceiling with wrong codes at /mfa/backup-codes (count-only bucket, bounded waits). */
async function spendCeiling(p: string) {
    for (let i = 0; i < CEILING; i++) {
        const r = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`)
            .set('Authorization', `Bearer ${plainSession(p)}`).send({ code: '000000' });
        assert.strictEqual(r.status, 400, `wrong code ${i + 1}: ${r.status} ${JSON.stringify(r.body)}`);
    }
}

test('below the ceiling a correct code alone still works (control)', async () => {
    const { secret } = await enrollDirect('ceil2');
    const r = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`)
        .set('Authorization', `Bearer ${plainSession('ceil2')}`).send({ code: totp.totp(secret) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});

test('past the ceiling, a correct code alone is refused on every code-checking door; with the password it works', { timeout: 120000 }, async () => {
    const { secret, codes } = await enrollDirect('ceil');
    await spendCeiling('ceil');

    // The CORRECT code, without the password: refused — on all three doors, since the count is per account.
    const disable = await request(app).post(`${PREFIX}/auth/mfa/disable`)
        .set('Authorization', `Bearer ${plainSession('ceil')}`).send({ code: totp.totp(secret) });
    assert.strictEqual(disable.status, 403, JSON.stringify(disable.body));
    assert.strictEqual(disable.body.code, 'rest_mfa_password_required');

    const backup = await request(app).post(`${PREFIX}/auth/mfa/backup-codes`)
        .set('Authorization', `Bearer ${plainSession('ceil')}`).send({ code: codes[0] });
    assert.strictEqual(backup.body.code, 'rest_mfa_password_required');

    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 30 });
    try {
        const token = await request(app).post(`${PREFIX}/auth/tokens`)
            .set('Authorization', `Bearer ${plainSession('ceil')}`).send({ name: 't', scopes: 'read', mfaCode: codes[1] });
        assert.strictEqual(token.status, 403, JSON.stringify(token.body));
        assert.strictEqual(token.body.code, 'rest_mfa_password_required');
    } finally { await policyOff(); }

    // A wrong password does not open it.
    const badPw = await request(app).post(`${PREFIX}/auth/mfa/disable`)
        .set('Authorization', `Bearer ${plainSession('ceil')}`).send({ code: codes[2], currentPassword: 'nope' });
    assert.strictEqual(badPw.status, 403, JSON.stringify(badPw.body));
    assert.strictEqual(badPw.body.code, 'rest_bad_current_password');
    assert.strictEqual(await mfa.isEnabled(U.ceil), true, 'MFA must still be on');

    // The owner — code AND password — is never locked out.
    const owner = await request(app).post(`${PREFIX}/auth/mfa/disable`)
        .set('Authorization', `Bearer ${plainSession('ceil')}`).send({ code: codes[3], currentPassword: PASSWORD });
    assert.strictEqual(owner.status, 200, JSON.stringify(owner.body));
    assert.strictEqual(await mfa.isEnabled(U.ceil), false);
});

// ── 4. The scheme is part of the origin ─────────────────────────────────────────────────────────────
// supertest connects from loopback to a loopback Host, which core/host-policy treats as a trusted local hop,
// so X-Forwarded-Host / X-Forwarded-Proto here stand for what the gateway forwards in front of the backend.
const OVER_HTTPS = { 'X-Forwarded-Host': 'example.test', 'X-Forwarded-Proto': 'https' };

test('CSRF: a plain-http Origin does not vouch for a request that arrived over https', async () => {
    // A Bearer caller skips the double-submit half, so the status isolates the ORIGIN check.
    const send = (origin: string, extra: Record<string, string>) => {
        let r = request(app).post(`${PREFIX}/csrf-scheme-probe`).set('Origin', origin)
            .set('Authorization', `Bearer ${plainSession('ed')}`);
        for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
        return r.send({});
    };
    const same = await send('https://example.test', OVER_HTTPS);
    assert.notStrictEqual(same.body && same.body.code, 'rest_csrf_invalid', `control: the https page must pass (${same.status})`);
    const downgraded = await send('http://example.test', OVER_HTTPS);
    assert.strictEqual(downgraded.status, 403, JSON.stringify(downgraded.body));
    assert.strictEqual(downgraded.body.code, 'rest_csrf_invalid');
    // Behind a TLS-terminating hop that is not trusted the request looks like plain http while the page is
    // https: still the site's own page, still accepted (no regression for such installs).
    const untrustedTls = await send('https://example.test', { 'X-Forwarded-Host': 'example.test' });
    assert.notStrictEqual(untrustedTls.body && untrustedTls.body.code, 'rest_csrf_invalid', `https page over an http hop: ${untrustedTls.status}`);
});

test('collab stream: the same scheme rule applies to its same-origin check', async () => {
    const stream = (origin: string) => request(app).get(`${PREFIX}/collab/999999/stream?siteId=s_aaaa`)
        .set('X-Forwarded-Host', 'example.test').set('X-Forwarded-Proto', 'https').set('Origin', origin)
        .set('Cookie', `wordjs_token=${plainSession('boss')}`);
    const same = await stream('https://example.test');
    assert.notStrictEqual(same.body && same.body.code, 'rest_csrf_invalid', `control: same scheme must pass (${same.status} ${JSON.stringify(same.body)})`);
    const downgraded = await stream('http://example.test');
    assert.strictEqual(downgraded.status, 403, JSON.stringify(downgraded.body));
    assert.strictEqual(downgraded.body.code, 'rest_csrf_invalid');
});
