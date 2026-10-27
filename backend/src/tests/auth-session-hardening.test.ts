/**
 * AUTHENTICATION, SESSIONS AND SECOND FACTOR — hardening suite.
 *
 * One file per surface, each case driven through the real router (or the model it changes):
 *   • ONE reader of the Bearer header: a value with extra spaces is the same credential to the MFA gate,
 *     to every authenticator and to the MCP endpoint, so the `enforceForApiTokens` rule holds for it; the
 *     gate refuses a Bearer value it cannot recognise.
 *   • a signed-out session stays signed out for a full session lifetime (a refreshed copy cannot outlive
 *     the revocation entry).
 *   • the live notification stream is re-authorized: signing out (also the session behind a query ticket)
 *     closes it, and the ticket carries the session's id.
 *   • the stored Redis password / S3 secret is reused only for the server it belongs to.
 *   • turning agent publish confirmation off asks for the second factor (a role under the 2FA policy).
 *   • the sudo password is checked against the session's own account, by id.
 *   • a password change kills an outstanding reset link.
 *   • the anonymous recovery flow answers at a fixed pace.
 *   • authority over privileged accounts (create, promote, change another's password/address, reset a
 *     second factor) requires the caller's password, plus a code when the caller has 2FA.
 *   • the TOTP code used to enroll is spent.
 *   • every expired pending registration is pruned, not only those on the first page.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-authhard-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const mfa = require('../core/mfa');
const totp = require('../core/totp');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const AgentConnection = require('../models/AgentConnection');
const { mfaComplianceGate, generateToken, bearerToken } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', mfaComplianceGate); // mounted where index.ts mounts it: before every router
app.use('/api/v1', require('../routes'));

const PW = 'Correct-Horse-1';
const U: Record<string, any> = {};
let dbAsync: any;

const cookieFor = (token: string) => `wordjs_token=${token}`;
/** A fresh signed-in session (its own `ses` id) for a persona. */
const sessionOf = (persona: string) => generateToken(U[persona]);

async function seed(login: string, role: string) {
    const user = await User.create({ username: login, email: `${login}@example.com`, password: PW, role });
    U[login] = await User.findById(user.id);
}

async function enroll(persona: string): Promise<string> {
    const secret = totp.generateSecret();
    const id = U[persona].id;
    await User.updateMeta(id, mfa.META.lastStep, '-1');
    await User.updateMeta(id, mfa.META.secret, secret);
    await User.updateMeta(id, mfa.META.backup, JSON.stringify([]));
    await User.updateMeta(id, mfa.META.enabled, '1');
    U[persona] = await User.findById(id);
    return secret;
}

async function policyOff() { await mfa.setPolicy({ requiredRoles: [], graceDays: 0, enforceForApiTokens: false }); }

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seed('root', 'administrator');
    await seed('mfaboss', 'administrator');
    await seed('otheradmin', 'administrator');
    await seed('sub', 'subscriber');
    await seed('sub2', 'subscriber');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch { /* */ } }
});

// ── The Bearer header has ONE reading ────────────────────────────────────────────────────────────

test('bearerToken: one reading of the header for every layer', () => {
    const r = (authorization?: string) => bearerToken({ headers: authorization === undefined ? {} : { authorization } });
    assert.strictEqual(r('Bearer wjt_abc'), 'wjt_abc');
    assert.strictEqual(r('Bearer   wja_abc  '), 'wja_abc', 'surrounding whitespace is not part of the credential');
    assert.strictEqual(r('Bearer null'), null);
    assert.strictEqual(r('Bearer  undefined '), null);
    assert.strictEqual(r('Bearer    '), null);
    assert.strictEqual(r('Basic abc'), null);
    assert.strictEqual(r(undefined), null);
});

test('enforceForApiTokens holds for a token sent with extra spaces: optional-auth routes and the MCP endpoint refuse it', async () => {
    const { token } = await ApiToken.generate({ userId: U.root.id, name: 'spaced', scopes: ['read'] });
    const { token: agentToken, connection } = await AgentConnection.create({ userId: U.root.id, name: 'spaced-agent', requested: ['content:read'], createdBy: U.root.id });
    await AgentConnection.setGrant(connection.id, ['content:read'], U.root.id);
    try {
        await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0, enforceForApiTokens: true });
        await new Promise((r) => setTimeout(r, 20)); // past the (zero-day) grace window
        for (const spacing of [' ', '  ', ' \t ']) {
            const posts = await request(app).get('/api/v1/posts').set('Authorization', `Bearer${spacing}${token}`);
            assert.strictEqual(posts.status, 403, `posts with "Bearer${JSON.stringify(spacing)}": ${JSON.stringify(posts.body)}`);
            assert.strictEqual(posts.body.code, 'mfa_enrollment_required');
            const mcp = await request(app).post('/api/v1/mcp')
                .set('Authorization', `Bearer${spacing}${agentToken}`)
                .set('Accept', 'application/json, text/event-stream')
                .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
            assert.strictEqual(mcp.status, 403, `mcp with "Bearer${JSON.stringify(spacing)}": ${JSON.stringify(mcp.body)}`);
            assert.strictEqual(mcp.body.code, 'mfa_enrollment_required');
        }
        // The gate refuses a Bearer value it cannot recognise instead of passing it on.
        const junk = await request(app).get('/api/v1/posts').set('Authorization', 'Bearer not-a-credential');
        assert.strictEqual(junk.status, 401);
        assert.strictEqual(junk.body.code, 'rest_token_invalid');
    } finally {
        await policyOff();
        await AgentConnection.revoke(connection.id);
    }
    // Policy off: the same spaced token simply authenticates (one reading, no refusal).
    const ok = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer  ${token}`);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.id, U.root.id);
});

// ── A signed-out session stays signed out ────────────────────────────────────────────────────────

test('signing out keeps the session id revoked for a whole session lifetime, not until the presented copy expires', async () => {
    const revocation = require('../core/session-revocation');
    const now = Math.floor(Date.now() / 1000);
    // The presented copy was about to expire; a copy refreshed a moment earlier lives a full lifetime.
    await revocation.revokeSession(U.sub.id, { ses: 'short-lived-copy', exp: now + 30 });
    const fresh = await User.findById(U.sub.id);
    const entry = revocation.readRevokedSessions(fresh)['short-lived-copy'];
    const probe = jwt.decode(jwt.sign({}, 'x', { expiresIn: config.jwt.expiresIn }));
    const lifetime = probe.exp - probe.iat;
    assert.ok(entry >= now + lifetime - 5, `entry ${entry} must last until about ${now + lifetime}`);
    // A refreshed copy carrying the same id is refused for as long as it can live.
    const refreshedCopy = { userId: U.sub.id, ses: 'short-lived-copy', iat: now + 1, exp: now + lifetime };
    assert.strictEqual(revocation.isSessionRevoked(fresh, refreshedCopy), true);
});

// ── The notification stream is re-authorized ─────────────────────────────────────────────────────

function openStream(server: any, pathAndQuery: string, cookie?: string): Promise<{ data: () => string; ended: Promise<void>; close: () => void }> {
    return new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery, headers: cookie ? { Cookie: cookie } : {} }, (res: any) => {
            if (res.statusCode !== 200) { reject(new Error(`stream answered ${res.statusCode}`)); return; }
            let buf = '';
            const ended = new Promise<void>((done) => { res.on('end', done); res.on('close', done); });
            res.on('data', (c: Buffer) => { buf += c.toString(); });
            const wait = setInterval(() => {
                if (buf.includes('retry:')) { clearInterval(wait); resolve({ data: () => buf, ended, close: () => req.destroy() }); }
            }, 10);
        });
        req.on('error', reject);
    });
}

const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

test('signing out closes a live notification stream opened with that session', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const token = sessionOf('sub');
        const stream = await openStream(server, '/api/v1/notifications/stream', cookieFor(token));
        await require('../core/session-revocation').revokeSession(U.sub.id, jwt.decode(token));
        const closed = await within(stream.ended, 3000);
        stream.close();
        assert.ok(closed, 'the stream must end once its session is signed out');
        assert.match(stream.data(), /event: error\ndata: \{"error":"unauthorized"\}/);
    } finally {
        server.close();
    }
});

test('a query ticket carries its session id, and signing that session out closes the stream the ticket opened', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const token = sessionOf('sub2');
        const issued = await request(app).post('/api/v1/auth/query-ticket').set('Cookie', cookieFor(token)).send({ path: '/api/v1/notifications/stream' });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
        const ticket = jwt.decode(issued.body.ticket);
        assert.strictEqual(ticket.ses, jwt.decode(token).ses, 'the ticket names the session it was issued from');
        assert.strictEqual(ticket.sxp, jwt.decode(token).exp, 'and ends with it');

        const stream = await openStream(server, `/api/v1/notifications/stream?token=${encodeURIComponent(issued.body.ticket)}`);
        await require('../core/session-revocation').revokeSession(U.sub2.id, jwt.decode(token));
        const closed = await within(stream.ended, 3000);
        stream.close();
        assert.ok(closed, 'the stream a ticket opened ends with the session behind the ticket');
        // ...and the ticket itself no longer opens anything.
        const again = await request(app).get(`/api/v1/notifications/stream?token=${encodeURIComponent(issued.body.ticket)}`);
        assert.strictEqual(again.status, 401);
    } finally {
        server.close();
    }
});

// ── Stored secrets stay with their server ────────────────────────────────────────────────────────

test('Redis test: the stored password is reused for the stored server only; another server needs the administrator\'s password', async () => {
    const configManager = require('../core/configManager');
    const original = configManager.getConfig;
    configManager.getConfig = () => ({ ...(original() || {}), redis: { enabled: true, host: '127.0.0.1', port: 1, db: 0, password: 'stored-secret' } });
    try {
        const cookie = cookieFor(sessionOf('root'));
        const same = await request(app).post('/api/v1/system/redis/test').set('Cookie', cookie).send({ host: '127.0.0.1', port: 1, db: 0 });
        assert.strictEqual(same.status, 200, JSON.stringify(same.body));
        for (const target of [{ host: '127.0.0.1', port: 2, db: 0 }, { host: '127.0.0.2', port: 1, db: 0 }, { host: '127.0.0.1', port: 1, db: 3 }]) {
            const other = await request(app).post('/api/v1/system/redis/test').set('Cookie', cookie).send(target);
            assert.strictEqual(other.status, 403, `${JSON.stringify(target)}: ${JSON.stringify(other.body)}`);
            assert.strictEqual(other.body.code, 'rest_sudo_required');
        }
        const wrong = await request(app).post('/api/v1/system/redis/test').set('Cookie', cookie).send({ host: '127.0.0.1', port: 2, currentPassword: 'nope' });
        assert.strictEqual(wrong.status, 403);
        assert.strictEqual(wrong.body.code, 'rest_bad_current_password');
        const confirmed = await request(app).post('/api/v1/system/redis/test').set('Cookie', cookie).send({ host: '127.0.0.1', port: 2, currentPassword: PW });
        assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
        // A password typed into the form is the caller's own to send anywhere.
        const typed = await request(app).post('/api/v1/system/redis/test').set('Cookie', cookie).send({ host: '127.0.0.1', port: 2, password: 'typed' });
        assert.strictEqual(typed.status, 200, JSON.stringify(typed.body));
    } finally {
        configManager.getConfig = original;
    }
});

test('S3 test (the twin): the stored secret is reused for the stored bucket only', async () => {
    const configManager = require('../core/configManager');
    const original = configManager.getConfig;
    const stored = { driver: 's3', bucket: 'media', region: 'us-east-1', endpoint: 'https://10.0.0.10', accessKeyId: 'AKIDSTORED', secretAccessKey: 'stored-secret' };
    configManager.getConfig = () => ({ ...(original() || {}), mediaStorage: stored });
    try {
        const cookie = cookieFor(sessionOf('root'));
        // Same bucket: no confirmation (the test then stops at the private-address refusal, 400).
        const same = await request(app).post('/api/v1/media-storage/test').set('Cookie', cookie).send({ driver: 's3', bucket: 'media', region: 'us-east-1', endpoint: 'https://10.0.0.10' });
        assert.notStrictEqual(same.body && same.body.code, 'rest_sudo_required', JSON.stringify(same.body));
        for (const change of [{ endpoint: 'https://10.0.0.11' }, { bucket: 'elsewhere' }, { region: 'eu-west-1' }]) {
            const other = await request(app).post('/api/v1/media-storage/test').set('Cookie', cookie).send({ driver: 's3', bucket: 'media', region: 'us-east-1', endpoint: 'https://10.0.0.10', ...change });
            assert.strictEqual(other.status, 403, `${JSON.stringify(change)}: ${JSON.stringify(other.body)}`);
            assert.strictEqual(other.body.code, 'rest_sudo_required');
        }
        const confirmed = await request(app).post('/api/v1/media-storage/test').set('Cookie', cookie).send({ driver: 's3', bucket: 'media', endpoint: 'https://10.0.0.11', currentPassword: PW });
        assert.notStrictEqual(confirmed.body && confirmed.body.code, 'rest_sudo_required', JSON.stringify(confirmed.body));
        assert.notStrictEqual(confirmed.status, 403, JSON.stringify(confirmed.body));
        const typed = await request(app).post('/api/v1/media-storage/test').set('Cookie', cookie).send({ driver: 's3', bucket: 'media', endpoint: 'https://10.0.0.11', secretAccessKey: 'typed' });
        assert.notStrictEqual(typed.status, 403, JSON.stringify(typed.body));
    } finally {
        configManager.getConfig = original;
    }
});

// ── Agent publish confirmation ───────────────────────────────────────────────────────────────────

test('turning agent publish confirmation OFF asks a 2FA-policy role for a current code; turning it on never does', async () => {
    const secret = await enroll('mfaboss');
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 30, enforceForApiTokens: false });
    try {
        const cookie = cookieFor(sessionOf('mfaboss')); // signed in without the second factor (no `amr`)
        const on = await request(app).put('/api/v1/agents/settings').set('Cookie', cookie).send({ publishConfirmation: true });
        assert.strictEqual(on.status, 200, JSON.stringify(on.body));
        const off = await request(app).put('/api/v1/agents/settings').set('Cookie', cookie).send({ publishConfirmation: false });
        assert.strictEqual(off.status, 403, JSON.stringify(off.body));
        assert.strictEqual(off.body.code, 'rest_mfa_step_up_required');
        assert.strictEqual(await require('../core/agent-publishing').publishConfirmationRequired(), true, 'still on');
        const withCode = await request(app).put('/api/v1/agents/settings').set('Cookie', cookie).send({ publishConfirmation: false, mfaCode: totp.totp(secret) });
        assert.strictEqual(withCode.status, 200, JSON.stringify(withCode.body));
        assert.strictEqual(await require('../core/agent-publishing').publishConfirmationRequired(), false);
    } finally {
        await policyOff();
    }
});

test('PUT /agents/:id/grant refuses a network administrator\'s handoff session, like POST /agents', () => {
    const router = require('../routes/agents');
    const { refuseHandoffSession } = require('../core/network-handoff');
    const layer = router.stack.find((l: any) => l.route && l.route.path === '/:id/grant' && l.route.methods.put);
    assert.ok(layer, 'the grant route exists');
    assert.ok(layer.route.stack.some((s: any) => s.handle === refuseHandoffSession), 'refuseHandoffSession guards the grant');
});

// ── The sudo password belongs to the session's own account ──────────────────────────────────────

test('the sudo check compares against the session\'s own account, never one re-resolved by name', async () => {
    // A legacy login that spells another account's email (logins may no longer contain '@').
    const hash = await User.hashPassword('Legacy-Own-Pass1');
    const r = await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['shadow@example.com', hash, 'legacy-holder@example.com', 'legacy']);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'subscriber')`, [r.lastID]);
    // The account whose EMAIL that login spells (the model refuses to create the pair today, a database
    // from before the rule may hold it).
    await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['shadowed', await User.hashPassword('Other-Account-Pass1'), 'shadow@example.com', 'shadowed']);
    const legacy = await User.findById(r.lastID);
    const cookie = cookieFor(generateToken(legacy));

    const withOthersPassword = await request(app).post('/api/v1/users/me/sessions/revoke').set('Cookie', cookie).send({ currentPassword: 'Other-Account-Pass1' });
    assert.strictEqual(withOthersPassword.status, 403, JSON.stringify(withOthersPassword.body));
    assert.strictEqual(withOthersPassword.body.code, 'rest_bad_current_password');
    const withOwnPassword = await request(app).post('/api/v1/users/me/sessions/revoke').set('Cookie', cookie).send({ currentPassword: 'Legacy-Own-Pass1' });
    assert.strictEqual(withOwnPassword.status, 200, JSON.stringify(withOwnPassword.body));
});

// ── A password change kills an outstanding reset link ────────────────────────────────────────────

test('changing the password clears a pending reset link', async () => {
    await User.updateMeta(U.sub.id, 'password_reset_hash', 'a'.repeat(64));
    await User.updateMeta(U.sub.id, 'password_reset_expires', String(Date.now() + 60_000));
    await User.update(U.sub.id, { password: 'A-New-Password-1' });
    assert.ok(!(await User.getMeta(U.sub.id, 'password_reset_hash')), 'the reset hash is gone');
    assert.strictEqual(String(await User.getMeta(U.sub.id, 'password_reset_expires')), '0');
});

// ── The recovery flow answers at a fixed pace ────────────────────────────────────────────────────

test('forgot-password answers at the same pace whether or not the account exists', async () => {
    (global as any).wordjs_send_mail = () => ({ queued: true });
    require('../core/mail-provider').setMailProvider((global as any).wordjs_send_mail, 'pace-mailer');
    const { updateOption } = require('../core/options');
    await updateOption('account_mail_provider_allowed', JSON.stringify(['pace-mailer']));
    await updateOption('mail_delivery_ready', '1');
    for (const login of ['no-such-account-anywhere', 'sub2']) {
        const started = Date.now();
        const res = await request(app).post('/api/v1/auth/forgot-password').send({ login });
        const took = Date.now() - started;
        assert.strictEqual(res.status, 200);
        assert.ok(took >= 750, `${login}: answered after ${took} ms, before the fixed pace`);
    }
    // The real account still got its link.
    assert.ok(await User.getMeta(U.sub2.id, 'password_reset_hash'), 'the reset was minted');
});

// ── Authority over privileged accounts needs the caller's own confirmation ───────────────────────

test('creating an administrator asks for the caller\'s password; a subscriber does not', async () => {
    const cookie = cookieFor(sessionOf('root'));
    const sub = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'plainsub', email: 'plainsub@example.com', password: PW, role: 'subscriber' });
    assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));

    const bare = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'newadmin', email: 'newadmin@example.com', password: PW, role: 'administrator' });
    assert.strictEqual(bare.status, 403, JSON.stringify(bare.body));
    assert.strictEqual(bare.body.code, 'rest_sudo_required');
    assert.strictEqual(await User.findByLogin('newadmin'), null, 'nothing was created');
    const wrong = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'newadmin', email: 'newadmin@example.com', password: PW, role: 'administrator', currentPassword: 'wrong' });
    assert.strictEqual(wrong.body.code, 'rest_bad_current_password');
    const ok = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'newadmin', email: 'newadmin@example.com', password: PW, role: 'administrator', currentPassword: PW });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
});

test('a caller with 2FA confirms with password AND a current code', async () => {
    const secret = await enroll('mfaboss');
    const cookie = cookieFor(sessionOf('mfaboss'));
    const pwOnly = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'admin2fa', email: 'admin2fa@example.com', password: PW, role: 'administrator', currentPassword: PW });
    assert.strictEqual(pwOnly.status, 403, JSON.stringify(pwOnly.body));
    assert.strictEqual(pwOnly.body.code, 'rest_mfa_step_up_required');
    const both = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'admin2fa', email: 'admin2fa@example.com', password: PW, role: 'administrator', currentPassword: PW, mfaCode: totp.totp(secret) });
    assert.strictEqual(both.status, 201, JSON.stringify(both.body));
});

test('changing another administrator\'s password or address, or promoting an account, asks for confirmation; ordinary edits do not', async () => {
    const cookie = cookieFor(sessionOf('root'));
    const target = U.otheradmin.id;
    for (const change of [{ password: 'Taken-Over-Pass1' }, { email: 'attacker@example.net' }, { personalEmail: 'attacker@example.net' }]) {
        const res = await request(app).put(`/api/v1/users/${target}`).set('Cookie', cookie).send(change);
        assert.strictEqual(res.status, 403, `${JSON.stringify(change)}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_sudo_required');
    }
    const promote = await request(app).put(`/api/v1/users/${U.sub2.id}`).set('Cookie', cookie).send({ role: 'administrator' });
    assert.strictEqual(promote.status, 403, JSON.stringify(promote.body));
    assert.strictEqual(promote.body.code, 'rest_sudo_required');

    const name = await request(app).put(`/api/v1/users/${target}`).set('Cookie', cookie).send({ displayName: 'Renamed' });
    assert.strictEqual(name.status, 200, JSON.stringify(name.body));
    const subPw = await request(app).put(`/api/v1/users/${U.sub2.id}`).set('Cookie', cookie).send({ password: 'Sub-New-Pass-1' });
    assert.strictEqual(subPw.status, 200, JSON.stringify(subPw.body));

    const confirmed = await request(app).put(`/api/v1/users/${target}`).set('Cookie', cookie).send({ password: 'Rotated-By-Admin1', currentPassword: PW });
    assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
});

test('one confirmation holds briefly for the same session (a bulk role change), never for another session', async () => {
    const cookie = cookieFor(sessionOf('root'));
    const first = await request(app).put(`/api/v1/users/${U.sub.id}`).set('Cookie', cookie).send({ role: 'administrator', currentPassword: PW });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await request(app).put(`/api/v1/users/${U.sub2.id}`).set('Cookie', cookie).send({ role: 'administrator' });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const elsewhere = await request(app).put(`/api/v1/users/${U.sub.id}`).set('Cookie', cookieFor(sessionOf('root'))).send({ password: 'Elsewhere-Pass-1' });
    assert.strictEqual(elsewhere.body.code, 'rest_sudo_required', 'a different session confirms on its own');
});

test('resetting another account\'s second factor asks for confirmation', async () => {
    await enroll('otheradmin');
    const cookie = cookieFor(sessionOf('root'));
    const bare = await request(app).post(`/api/v1/users/${U.otheradmin.id}/mfa/reset`).set('Cookie', cookie).send({});
    assert.strictEqual(bare.status, 403, JSON.stringify(bare.body));
    assert.strictEqual(bare.body.code, 'rest_sudo_required');
    assert.strictEqual(await mfa.isEnabled(U.otheradmin.id), true, 'still enrolled');
    const ok = await request(app).post(`/api/v1/users/${U.otheradmin.id}/mfa/reset`).set('Cookie', cookie).send({ currentPassword: PW });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await mfa.isEnabled(U.otheradmin.id), false);
});

// ── The enrollment code is spent ─────────────────────────────────────────────────────────────────

test('the code that completes 2FA enrollment cannot be used again', async () => {
    const id = U.sub2.id;
    await mfa.disable(id);
    const { secret } = await mfa.beginEnroll(id, 'sub2');
    const code = totp.totp(secret);
    const done = await mfa.completeEnroll(id, code);
    assert.strictEqual(done.ok, true);
    assert.strictEqual(await mfa.verifyLoginCode(id, code), false, 'the enrollment code is spent');
});

// ── Pending registrations ────────────────────────────────────────────────────────────────────────

test('pruning removes every expired pending registration, not only those on the first page', async () => {
    const pending = require('../core/pending-registrations');
    const { addOption, getOption } = require('../core/options');
    const live = { username: 'l', email: 'l@example.com', passwordHash: 'x', displayName: 'l', expires: Date.now() + 3_600_000 };
    const dead = { ...live, expires: Date.now() - 1000 };
    // 250 live rows sort FIRST by name (prefix …_0…), the expired ones after them.
    for (let i = 0; i < 250; i++) await addOption(`${pending.PENDING_REGISTRATION_OPTION_PREFIX}0${String(i).padStart(4, '0')}`, live, 'no');
    for (let i = 0; i < 5; i++) await addOption(`${pending.PENDING_REGISTRATION_OPTION_PREFIX}z${i}`, dead, 'no');
    assert.strictEqual(await pending.prunePendingRegistrations(), 5);
    assert.strictEqual(await getOption(`${pending.PENDING_REGISTRATION_OPTION_PREFIX}z0`, null), null);
    assert.ok(await getOption(`${pending.PENDING_REGISTRATION_OPTION_PREFIX}00000`, null), 'live rows stay');
});

// ── Passwords are limited in BYTES (what bcrypt reads) ───────────────────────────────────────────

test('a password over 72 bytes is refused on every door that sets one, even under 72 characters', async () => {
    const long = 'á'.repeat(37); // 37 characters, 74 bytes: bcrypt would ignore the end
    assert.ok(long.length < 72 && Buffer.byteLength(long, 'utf8') > 72);
    const cookie = cookieFor(sessionOf('root'));
    const self = await request(app).put('/api/v1/users/me').set('Cookie', cookie).send({ password: long, currentPassword: PW });
    assert.strictEqual(self.status, 400, JSON.stringify(self.body));
    assert.strictEqual(self.body.code, 'rest_password_too_long');
    const create = await request(app).post('/api/v1/users').set('Cookie', cookie).send({ username: 'longpw', email: 'longpw@example.com', password: long, role: 'subscriber' });
    assert.strictEqual(create.status, 400, JSON.stringify(create.body));
    assert.strictEqual(create.body.code, 'rest_password_too_long');
    const other = await request(app).put(`/api/v1/users/${U.sub2.id}`).set('Cookie', cookie).send({ password: long });
    assert.strictEqual(other.status, 400, JSON.stringify(other.body));
    await assert.rejects(User.update(U.sub2.id, { password: long }), /72 bytes/, 'the model refuses it for every other caller');
    // 72 plain characters are still fine.
    const fine = await request(app).put(`/api/v1/users/${U.sub2.id}`).set('Cookie', cookie).send({ password: 'a'.repeat(72), currentPassword: PW });
    assert.strictEqual(fine.status, 200, JSON.stringify(fine.body));
});

// ── Registration switches have one reading ───────────────────────────────────────────────────────

test('registration and verification switches are stored as 1/0 and read the same way by sign-up', async () => {
    const { getOption, updateOption } = require('../core/options');
    const cookie = cookieFor(sessionOf('root'));
    const off = await request(app).put('/api/v1/settings').set('Cookie', cookie)
        .send({ users_can_register: 'off', require_email_verification: true, comments_notify: 'no', moderation_notify: 'yes' });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.strictEqual(String(await getOption('users_can_register', null)), '0');
    assert.strictEqual(String(await getOption('require_email_verification', null)), '1');
    assert.strictEqual(String(await getOption('comments_notify', null)), '0');
    assert.strictEqual(String(await getOption('moderation_notify', null)), '1');
    const bad = await request(app).put('/api/v1/settings').set('Cookie', cookie).send({ users_can_register: 'maybe' });
    assert.strictEqual(bad.status, 400);
    // A value stored some other way is still read as off by sign-up.
    await updateOption('users_can_register', 'off');
    const reg = await request(app).post('/api/v1/auth/register').send({ username: 'offreg', email: 'offreg@example.com', password: 'Some-Pass-123' });
    assert.strictEqual(reg.status, 403, JSON.stringify(reg.body));
    assert.strictEqual(reg.body.code, 'rest_cannot_register');
    await updateOption('users_can_register', '0');
});

// ── Machine credential lifetimes ─────────────────────────────────────────────────────────────────

test('expiresInDays is a whole number of days from 1 to 3650 for API tokens and agents', async () => {
    const cookie = cookieFor(sessionOf('root'));
    for (const bad of [0.5, 0, -3, 99999, '1e3', 'abc']) {
        const tok = await request(app).post('/api/v1/auth/tokens').set('Cookie', cookie).send({ name: 't', scopes: ['read'], expiresInDays: bad });
        assert.strictEqual(tok.status, 400, `token ${JSON.stringify(bad)}: ${JSON.stringify(tok.body)}`);
        const ag = await request(app).post('/api/v1/agents').set('Cookie', cookie).send({ name: 'a', requested: ['content:read'], expiresInDays: bad });
        assert.strictEqual(ag.status, 400, `agent ${JSON.stringify(bad)}: ${JSON.stringify(ag.body)}`);
    }
    const ok = await request(app).post('/api/v1/auth/tokens').set('Cookie', cookie).send({ name: 't', scopes: ['read'], expiresInDays: 30 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
});

// ── Display names ────────────────────────────────────────────────────────────────────────────────

test('displayName must be text, is stored without markup, trimmed and capped', async () => {
    await seed('named', 'subscriber');
    const cookie = cookieFor(sessionOf('named'));
    const obj = await request(app).put('/api/v1/users/me').set('Cookie', cookie).send({ displayName: { a: 1 } });
    assert.strictEqual(obj.status, 400, JSON.stringify(obj.body));
    const long = await request(app).put('/api/v1/users/me').set('Cookie', cookie).send({ displayName: 'x'.repeat(251) });
    assert.strictEqual(long.status, 400, JSON.stringify(long.body));
    const tagged = await request(app).put('/api/v1/users/me').set('Cookie', cookie).send({ displayName: '  <b>Ana</b> <img src=x onerror=alert(1)> & Co  ' });
    assert.strictEqual(tagged.status, 200, JSON.stringify(tagged.body));
    assert.strictEqual((await User.findById(U.named.id)).displayName, 'Ana & Co');
    const admin = await request(app).put(`/api/v1/users/${U.named.id}`).set('Cookie', cookieFor(sessionOf('root'))).send({ displayName: ['x'] });
    assert.strictEqual(admin.status, 400, JSON.stringify(admin.body));
});

// ── Single-use credentials are consumed atomically ───────────────────────────────────────────────

test('a password-reset link sets ONE password, however many requests race with it', async () => {
    const crypto = require('crypto');
    const raw = crypto.randomBytes(32).toString('hex');
    await User.updateMeta(U.sub.id, 'password_reset_hash', crypto.createHash('sha256').update(raw).digest('hex'));
    await User.updateMeta(U.sub.id, 'password_reset_expires', String(Date.now() + 60_000));
    const results = await Promise.all(['Race-Pass-One1', 'Race-Pass-Two2', 'Race-Pass-Three3'].map((password) =>
        request(app).post('/api/v1/auth/reset-password').send({ uid: U.sub.id, token: raw, password })));
    assert.deepStrictEqual(results.map((r: any) => r.status).sort(), [200, 400, 400], JSON.stringify(results.map((r: any) => r.body)));
});

test('an MFA challenge issues ONE session even when two valid codes race for it', async () => {
    const id = U.mfaboss.id;
    await mfa.disable(id);
    const secret = await enroll('mfaboss');
    await User.updateMeta(id, mfa.META.backup, JSON.stringify([mfa.hashBackup('RACE1-AAAAA')]));
    // A current authenticator code and a backup code are spent on different rows, so nothing but the
    // challenge itself ties the two requests together.
    const codes = [totp.totp(secret), 'RACE1-AAAAA'];
    const challenge = mfa.signChallenge(id);
    const results = await Promise.all(codes.map((code) => request(app).post('/api/v1/auth/mfa').send({ mfaToken: challenge, code })));
    assert.deepStrictEqual(results.map((r: any) => r.status).sort(), [200, 401], JSON.stringify(results.map((r: any) => r.body)));
    // The decision itself, raced directly: of many concurrent claims of one challenge exactly one wins —
    // also the very first claim of an account (no used-challenge row yet).
    for (const fresh of [true, false]) {
        if (fresh) await User.deleteMeta(id, mfa.META.usedChallenges);
        const c = mfa.verifyChallenge(mfa.signChallenge(id));
        const wins = (await Promise.all(Array.from({ length: 6 }, () => mfa.claimChallenge(id, c)))).filter(Boolean).length;
        assert.strictEqual(wins, 1, `${fresh ? 'first claim' : 'later claim'}: ${wins} claims won`);
    }
});

// ── Limiters, digests and backup codes at rest ───────────────────────────────────────────────────

test('the sign-in limiters keep counting in memory while their shared store fails', async () => {
    const { withMemoryFallback } = require('../core/limiter-fallback-store');
    const down = async () => { throw new Error('redis down'); };
    const store = withMemoryFallback({ prefix: 'rl:auth:', increment: down, decrement: down, resetKey: down });
    store.init({ windowMs: 60_000 });
    const a = (await store.increment('1.2.3.4')).totalHits;
    const b = (await store.increment('1.2.3.4')).totalHits;
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 2, 'the outage does not reset the count');
    assert.strictEqual(withMemoryFallback(undefined), undefined, 'no Redis: the limiter keeps its own memory store');
    store.shutdown();
    // ...and those are the limiters that use it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    for (const prefix of ['rl:auth:', 'rl:loginip:', 'rl:setup:']) {
        assert.ok(src.includes(`withMemoryFallback(limiterStore('${prefix}'))`), `${prefix} falls back to memory`);
    }
});

test('the audit digest of an unknown identifier uses its own key, not the session-signing secret', () => {
    const crypto = require('crypto');
    const { attemptDigest } = require('../routes/auth');
    const direct = crypto.createHmac('sha256', String(config.jwt.secret || '')).update('guess').digest('hex').slice(0, 16);
    assert.notStrictEqual(attemptDigest('guess'), direct);
    assert.strictEqual(attemptDigest('guess'), attemptDigest('guess'), 'still stable, so repeats correlate');
});

test('backup codes are stored salted and slow; codes stored the old way still work', async () => {
    const crypto = require('crypto');
    const id = U.otheradmin.id;
    await mfa.disable(id);
    await enroll('otheradmin');
    const fresh = mfa.hashBackup('NEWCD-11111');
    assert.match(fresh, /^s1:[0-9a-f]{32}:[0-9a-f]{64}$/);
    assert.notStrictEqual(mfa.hashBackup('NEWCD-11111'), fresh, 'salted: the same code hashes differently');
    const legacy = crypto.createHash('sha256').update('OLDCD22222').digest('hex');
    await User.updateMeta(id, mfa.META.backup, JSON.stringify([fresh, legacy]));
    assert.strictEqual(await mfa.verifyLoginCode(id, 'oldcd-22222'), true, 'a code stored before still works');
    assert.strictEqual(await mfa.verifyLoginCode(id, 'NEWCD-11111'), true);
    assert.strictEqual(await mfa.verifyLoginCode(id, 'NEWCD-11111'), false, 'single use');
    assert.deepStrictEqual(JSON.parse(String(await User.getMeta(id, mfa.META.backup))), [], 'both consumed');
});
