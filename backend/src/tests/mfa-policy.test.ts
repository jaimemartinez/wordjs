/**
 * ADMIN-ENFORCED MFA-BY-ROLE POLICY SUITE
 *
 * Proves the policy + evaluate() compliance model and the mfaComplianceGate enforcement:
 *   • setPolicy validates role slugs and manages enforcedAt (stamp on enable, clear on disable);
 *   • evaluate() classifies a user as required / within-grace / enforced correctly;
 *   • the gate 403s `mfa_enrollment_required` for a past-grace, un-enrolled COOKIE session of a required
 *     role on non-exempt routes, but lets the enrollment/session escape hatch through, never blocks a
 *     non-subject role or a compliant/within-grace user, and EXEMPTS Bearer/API-token clients;
 *   • the policy routes (/auth/mfa/policy) are admin-only and NOT reachable by an enforced admin (so a
 *     2FA-less admin can't disable the requirement instead of enrolling).
 *
 * Same temp-DB pattern as api-tokens.test.ts. The gate is mounted the way index.ts mounts it (at the API
 * prefix, before the routers) so the real enforcement path is exercised.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mfapol-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const mfa = require('../core/mfa');
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { csrfProtection, mfaComplianceGate } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', mfaComplianceGate); // mirror index.ts: gate BEFORE the routers
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

// A session COOKIE (no `purpose` — a real login token) for a persona.
const cookie = (persona: string) => `wordjs_token=${jwt.sign({ userId: U[persona] }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('boss', 'administrator');
    await seedUser('ed', 'editor');
    await seedUser('sub', 'subscriber');
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch { /* */ } }
});

// Turn the policy off between phases so tests don't leak enforcement into each other.
async function policyOff() { await mfa.setPolicy({ requiredRoles: [], graceDays: 0 }); }

// ── Policy storage + enforcedAt lifecycle ─────────────────────────────────────────────────────────
test('setPolicy validates role slugs and manages enforcedAt (stamp on enable, clear on disable)', async () => {
    const on = await mfa.setPolicy({ requiredRoles: ['administrator', 'bogus-role'], graceDays: 7 });
    assert.deepStrictEqual(on.requiredRoles, ['administrator'], 'invalid slug dropped');
    assert.strictEqual(on.graceDays, 7);
    assert.strictEqual(typeof on.enforcedAt, 'number', 'enforcedAt stamped when enabled');

    // Changing roles while still enabled keeps the original enforcedAt (clock does not reset).
    const stamp = on.enforcedAt;
    const on2 = await mfa.setPolicy({ requiredRoles: ['administrator', 'editor'], graceDays: 3 });
    assert.strictEqual(on2.enforcedAt, stamp, 'enforcedAt preserved while feature stays on');

    const off = await mfa.setPolicy({ requiredRoles: [], graceDays: 3 });
    assert.strictEqual(off.enforcedAt, null, 'enforcedAt cleared when disabled');
    assert.deepStrictEqual((await mfa.getPolicy()).requiredRoles, []);
});

test('setPolicy coerces graceDays to a non-negative integer', async () => {
    assert.strictEqual((await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: -5 })).graceDays, 0);
    assert.strictEqual((await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 2.9 })).graceDays, 2);
    await policyOff();
});

// ── evaluate() compliance classification ──────────────────────────────────────────────────────────
test('evaluate() classifies required / within-grace / enforced correctly', async () => {
    const boss = await User.findById(U.boss);
    const ed = await User.findById(U.ed);

    await policyOff();
    assert.strictEqual((await mfa.evaluate(boss)).required, false, 'policy off → nobody required');

    // Immediate enforcement (graceDays 0): a required, un-enrolled admin is enforced now.
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    const nowS = await mfa.evaluate(boss);
    assert.strictEqual(nowS.required, true);
    assert.strictEqual(nowS.enabled, false);
    assert.strictEqual(nowS.enforced, true, 'past grace → enforced');
    assert.strictEqual(nowS.withinGrace, false);

    // A non-required role is never enforced.
    const edS = await mfa.evaluate(ed);
    assert.strictEqual(edS.required, false);
    assert.strictEqual(edS.enforced, false);

    // Long grace: required but NOT yet enforced.
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 3650 });
    const grace = await mfa.evaluate(boss);
    assert.strictEqual(grace.required, true);
    assert.strictEqual(grace.withinGrace, true, 'within grace window');
    assert.strictEqual(grace.enforced, false);
    assert.ok(grace.graceDeadline > Math.floor(Date.now() / 1000), 'deadline in the future');

    // Enrolled admin is compliant even under immediate enforcement.
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    await User.updateMeta(U.boss, mfa.META.enabled, '1');
    const compliant = await mfa.evaluate(boss);
    assert.strictEqual(compliant.enabled, true);
    assert.strictEqual(compliant.enforced, false, 'enrolled → not enforced');
    await User.deleteMeta(U.boss, mfa.META.enabled);
    await policyOff();
});

// ── Enforcement gate (HTTP) ───────────────────────────────────────────────────────────────────────
test('gate is a no-op when the policy requires no roles', async () => {
    await policyOff();
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie('boss'));
    assert.notStrictEqual(res.body.code, 'mfa_enrollment_required');
});

test('gate 403s an enforced admin on a non-exempt route, but lets the enrollment/session allowlist through', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 }); // enforce immediately
    // Non-exempt protected route → hard block.
    const blocked = await request(app).get('/api/v1/users').set('Cookie', cookie('boss'));
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.code, 'mfa_enrollment_required');
    assert.ok(blocked.body.data && typeof blocked.body.data.graceDeadline !== 'undefined');

    // /auth/me is exempt and reports the enforced status so the UI can force enrollment.
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie('boss'));
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.mfa.enforced, true);

    // The enrollment escape hatch (GET /auth/mfa/status) is reachable.
    const status = await request(app).get('/api/v1/auth/mfa/status').set('Cookie', cookie('boss'));
    assert.strictEqual(status.status, 200);
    await policyOff();
});

test('an enforced admin CANNOT reach the policy route (must enroll, not disable the requirement)', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    // GET /auth/mfa/policy is NOT on the exempt list → the gate blocks it before the admin handler.
    const res = await request(app).get('/api/v1/auth/mfa/policy').set('Cookie', cookie('boss'));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'mfa_enrollment_required');
    await policyOff();
});

test('within grace, a required admin is NOT blocked (only nudged)', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 3650 });
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie('boss'));
    assert.notStrictEqual(res.body.code, 'mfa_enrollment_required');
    await policyOff();
});

test('a compliant (enrolled) admin is not blocked even under immediate enforcement', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    await User.updateMeta(U.boss, mfa.META.enabled, '1');
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie('boss'));
    assert.notStrictEqual(res.body.code, 'mfa_enrollment_required');
    await User.deleteMeta(U.boss, mfa.META.enabled);
    await policyOff();
});

test('a non-required role is never blocked by the gate', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    const res = await request(app).get('/api/v1/posts').set('Cookie', cookie('ed')); // editor: not subject
    assert.notStrictEqual(res.body.code, 'mfa_enrollment_required');
    await policyOff();
});

test('Bearer/API-token clients are EXEMPT from the enrollment gate (headless — cannot enroll)', async () => {
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    const tok = await ApiToken.generate({ userId: U.boss, name: 'ci', scopes: 'read' });
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${tok.token}`);
    assert.notStrictEqual(res.body.code, 'mfa_enrollment_required', 'token must not be enrollment-gated');
    await policyOff();
});

test('a SESSION JWT presented as a Bearer header is STILL enforced (no header bypass)', async () => {
    // Regression for the critical bypass: only a wjt_ API token is exempt. A raw session JWT authenticates
    // a full session over the Bearer transport too, so it must be gated exactly like the cookie.
    await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 0 });
    const sessionJwt = jwt.sign({ userId: U.boss }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${sessionJwt}`);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'mfa_enrollment_required');
    // And it cannot mint a wjt_ token to establish a persistent bypass. Header-less (CSRF-exempt on the
    // Bearer path) so the GATE — not CSRF — is what blocks it; POST /auth/tokens is not on the exempt list.
    const mint = await request(app).post('/api/v1/auth/tokens')
        .set('Authorization', `Bearer ${sessionJwt}`)
        .send({ name: 'sneaky', scopes: 'read' });
    assert.strictEqual(mint.status, 403);
    assert.strictEqual(mint.body.code, 'mfa_enrollment_required');
    await policyOff();
});

test('setPolicy caps graceDays at a sane maximum (no accidental permanent no-op)', async () => {
    assert.strictEqual((await mfa.setPolicy({ requiredRoles: ['administrator'], graceDays: 1e9 })).graceDays, 3650);
    await policyOff();
});

// ── Policy route admin-gating ─────────────────────────────────────────────────────────────────────
test('GET /auth/mfa/policy is admin-only', async () => {
    await policyOff(); // gate off so we isolate the isAdmin check
    const admin = await request(app).get('/api/v1/auth/mfa/policy').set('Cookie', cookie('boss'));
    assert.strictEqual(admin.status, 200);
    assert.ok(admin.body.policy && Array.isArray(admin.body.policy.requiredRoles));

    const editor = await request(app).get('/api/v1/auth/mfa/policy').set('Cookie', cookie('ed'));
    assert.strictEqual(editor.status, 403);
    assert.notStrictEqual(editor.body.code, 'mfa_enrollment_required'); // an isAdmin denial, not the gate
});
