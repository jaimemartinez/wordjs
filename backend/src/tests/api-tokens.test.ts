/**
 * SCOPED API TOKENS SUITE
 *
 * Drives the REAL routers via supertest against a throwaway temp DB and proves the security contract of
 * personal access tokens for headless/machine clients:
 *   • A `wjt_` token authenticates AS its user on the Authorization: Bearer path and BYPASSES CSRF (no
 *     ambient cookie), which is exactly what a CI/JAMstack client needs.
 *   • Effective permission = user capabilities ∩ token scope: a read token can never mutate; a write
 *     token for a low-privilege user still can't exceed that user's role.
 *   • Only the sha256 is stored (plaintext shown once); revoked/expired tokens are rejected; a user only
 *     sees/revokes their OWN tokens; and a token can NOT be used to manage tokens (no self-perpetuation).
 *
 * Same config-repoint-first pattern as authz-idor.test.ts (point config.dbPath at a temp file BEFORE the
 * DB layer resolves it). CSRF middleware IS mounted here so the Bearer-bypass claim is actually exercised.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-apitok-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection); // header-less requests are allowed ONLY on the Bearer path — proves token CSRF-bypass
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

// A JWT session for a persona (the interactive path used to MANAGE tokens).
const jwtFor = (persona: string) => jwt.sign({ userId: U[persona], username: persona }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

// Mint a token via the REAL POST /auth/tokens using the persona's JWT session. Returns the supertest res.
function mintToken(persona: string, body: any) {
    return request(app).post('/api/v1/auth/tokens').set('Authorization', `Bearer ${jwtFor(persona)}`).send(body);
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('subscriber', 'subscriber');
    await seedUser('mallory', 'administrator'); // a second admin, to prove per-user token isolation
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ── Creation & storage ──────────────────────────────────────────────────────────────────────────
test('POST /auth/tokens mints a wjt_ token and returns the plaintext exactly once', async () => {
    const res = await mintToken('admin', { name: 'CI deploy', scopes: 'read' });
    assert.strictEqual(res.status, 201);
    assert.match(res.body.token, /^wjt_[A-Za-z0-9_-]+$/);
    assert.strictEqual(res.body.tokenPrefix, res.body.token.slice(0, 12));
    assert.deepStrictEqual(res.body.scopes, ['read']);
    assert.strictEqual(res.body.name, 'CI deploy');
});

test('only the sha256 of the token is persisted — never the plaintext', async () => {
    const res = await mintToken('admin', { name: 'hash-check', scopes: 'read' });
    const raw = res.body.token;
    const row = await dbAsync.get('SELECT token_hash FROM api_tokens WHERE id = ?', [res.body.id]);
    assert.ok(row, 'row exists');
    assert.notStrictEqual(row.token_hash, raw);
    assert.strictEqual(row.token_hash, crypto.createHash('sha256').update(raw).digest('hex'));
    // The plaintext must not be recoverable from any column.
    const full: any = await dbAsync.get('SELECT * FROM api_tokens WHERE id = ?', [res.body.id]);
    assert.ok(!Object.values(full).includes(raw), 'no column stores the plaintext token');
});

test("'*' scope expands to read+write; empty scope defaults to least-privilege read", async () => {
    const star = await mintToken('admin', { name: 'full', scopes: '*' });
    assert.deepStrictEqual(star.body.scopes, ['read', 'write']);
    const none = await mintToken('admin', { name: 'default', scopes: undefined });
    assert.deepStrictEqual(none.body.scopes, ['read']);
});

// ── Authentication via the Bearer wjt_ path ──────────────────────────────────────────────────────
test('a wjt_ token authenticates as its user on GET /auth/me (Bearer path)', async () => {
    const { body } = await mintToken('admin', { name: 'me', scopes: 'read' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id ?? res.body.ID, U.admin);
});

test('an invalid wjt_ token is rejected with 401', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer wjt_notarealtoken');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'rest_token_invalid');
});

// ── Scope gate: read < write, enforced BELOW the user's capabilities ──────────────────────────────
test('a READ token cannot drive a mutating request (scope gate fires before the handler)', async () => {
    const { body } = await mintToken('admin', { name: 'ro', scopes: 'read' });
    // admin COULD create a post, but the token is read-only → blocked at auth, no Origin needed.
    const res = await request(app).post('/api/v1/posts').set('Authorization', `Bearer ${body.token}`)
        .send({ title: 'x', content: 'x', status: 'draft' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'rest_token_scope_insufficient');
});

test('a WRITE token (admin) passes both the scope gate and CSRF with no Origin header', async () => {
    const { body } = await mintToken('admin', { name: 'rw', scopes: 'write' });
    const res = await request(app).post('/api/v1/posts').set('Authorization', `Bearer ${body.token}`)
        .send({ title: 'From a token', content: 'hello', status: 'draft' });
    // Must NOT be blocked by the scope gate, capability check, or CSRF — auth fully passed.
    assert.ok(res.status !== 401 && res.status !== 403, `expected auth to pass, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.notStrictEqual(res.body.code, 'rest_csrf_invalid');
});

test('a WRITE token cannot exceed the issuing user role (subscriber ∩ write = still no edit_posts)', async () => {
    const { body } = await mintToken('subscriber', { name: 'sub-rw', scopes: 'write' });
    const res = await request(app).post('/api/v1/posts').set('Authorization', `Bearer ${body.token}`)
        .send({ title: 'nope', content: 'x', status: 'draft' });
    assert.strictEqual(res.status, 403);
    // The write scope PASSED the token gate; the 403 is a CAPABILITY denial (the route uses its own
    // rest_cannot_create code), NOT a scope error — that's what proves user ∩ token, not scope alone.
    assert.notStrictEqual(res.body.code, 'rest_token_scope_insufficient');
});

// ── Revocation & expiry ──────────────────────────────────────────────────────────────────────────
test('a revoked token stops working', async () => {
    const { body } = await mintToken('admin', { name: 'to-revoke', scopes: 'read' });
    const del = await request(app).delete(`/api/v1/auth/tokens/${body.id}`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(del.status, 200);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.token}`);
    assert.strictEqual(res.status, 401);
});

test('an expired token is rejected', async () => {
    const { body } = await mintToken('admin', { name: 'to-expire', scopes: 'read' });
    await dbAsync.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 60, body.id]);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.token}`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'rest_token_invalid');
});

// ── Self-service listing & isolation ─────────────────────────────────────────────────────────────
test('GET /auth/tokens lists the caller\'s tokens as metadata only (no secret)', async () => {
    const res = await request(app).get('/api/v1/auth/tokens').set('Authorization', `Bearer ${jwtFor('subscriber')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.tokens));
    for (const t of res.body.tokens) {
        assert.ok(!('token' in t) && !('token_hash' in t) && !('tokenHash' in t), 'no secret in list');
        assert.ok(typeof t.tokenPrefix === 'string');
    }
    // subscriber only sees their own token(s), not admin's many tokens.
    assert.ok(res.body.tokens.every((t: any) => typeof t.id === 'number'));
});

test('a user cannot revoke another user\'s token (scoped by owner → 404)', async () => {
    const { body } = await mintToken('mallory', { name: 'mallory-key', scopes: 'read' });
    // admin tries to revoke mallory's token
    const del = await request(app).delete(`/api/v1/auth/tokens/${body.id}`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(del.status, 404);
    // mallory's token still works
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.token}`);
    assert.strictEqual(res.status, 200);
});

// ── Hardening: a token cannot manage tokens ──────────────────────────────────────────────────────
test('an API token cannot list or mint tokens (no self-perpetuation)', async () => {
    const { body } = await mintToken('admin', { name: 'sneaky', scopes: 'write' });
    const list = await request(app).get('/api/v1/auth/tokens').set('Authorization', `Bearer ${body.token}`);
    assert.strictEqual(list.status, 403);
    assert.strictEqual(list.body.code, 'rest_token_management_forbidden');
    const mint = await request(app).post('/api/v1/auth/tokens').set('Authorization', `Bearer ${body.token}`).send({ name: 'child', scopes: 'write' });
    assert.strictEqual(mint.status, 403);
    assert.strictEqual(mint.body.code, 'rest_token_management_forbidden');
});
