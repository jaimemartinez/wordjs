/**
 * HEADLESS/SESSION BOUNDARY + MFA ENROLLMENT SUITE
 *
 * Two audit findings, both about an operation that produced a state its owner could not undo:
 *
 *   #10 — POST /auth/refresh carried only `authenticate`, which accepts a `wjt_` API token exactly as
 *         happily as a session JWT, and then set a 7-day session cookie. A leaked machine token could
 *         therefore be traded for a full interactive session that no longer carried req.apiToken, walking
 *         past `sessionOnly` on /auth/tokens and /auth/mfa/*. The fix inverts the rule: the request is
 *         marked headless at authentication time and the ONE cookie door refuses it.
 *   #11 — /auth/mfa/setup and /auth/mfa/enable demanded nothing but the ambient cookie, so a hijacked
 *         session could enroll the attacker's authenticator and lock the owner out permanently. Both now
 *         require the current password (same throttled sudo helper as the password-change doors), and an
 *         administrator can clear a victim's second factor via POST /users/:id/mfa/reset.
 *
 * Everything below drives the REAL routers through supertest against a throwaway temp DB, with
 * csrfProtection mounted AT THE API PREFIX exactly as index.ts mounts it — no hand-built req objects, no
 * middleware called directly. Same config-repoint-first pattern as api-tokens.test.ts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-headless-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const totp = require('../core/totp');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection); // mounted WITH the prefix, exactly like index.ts
app.use(B, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

// A JWT session for a persona (the interactive credential). Sent over the Bearer transport so the CSRF
// same-origin branch is satisfied without an Origin header — it is still a full session, not an API token.
const jwtFor = (persona: string) => jwt.sign({ userId: U[persona], username: persona }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asUser = (persona: string) => `Bearer ${jwtFor(persona)}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

/** Mint a real API token through the real route, using the persona's interactive session. */
async function mintToken(persona: string, scopes: string) {
    const res = await request(app).post(`${B}/auth/tokens`)
        .set('Authorization', asUser(persona)).send({ name: `t-${persona}-${scopes}`, scopes });
    assert.strictEqual(res.status, 201, `mint failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token as string;
}

const metaOf = (userId: number, key: string) => dbAsync.get(
    'SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('admin2', 'administrator');   // the second admin — the escape hatch out of a 2FA lockout
    await seedUser('victim', 'author');          // gets locked out of their own 2FA
    await seedUser('enroller', 'author');        // exercises the happy enrollment path
    await seedUser('sub', 'subscriber');         // holds nothing
    await seedUser('delegate', 'editor');        // gets edit_users below, but is NOT an administrator

    // An `edit_users` delegate that is not an administrator — the privilege-hierarchy case.
    await roles.updateRoleCapabilities('editor', ['read', 'edit_posts', 'access_admin_panel', 'edit_users']);
    await roles.loadRoles();
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ── #10 · an API token can never become an interactive session ────────────────────────────────────

test('POST /auth/refresh REFUSES a wjt_ API token and emits no session cookie', async () => {
    const token = await mintToken('admin', 'write'); // global write: the strongest token that exists
    const res = await request(app).post(`${B}/auth/refresh`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_session_from_token_forbidden');
    const setCookie = String(res.headers['set-cookie'] || '');
    assert.ok(!/wordjs_token/.test(setCookie), `no session cookie may be issued, got: ${setCookie}`);
});

test('POST /auth/refresh still works for a genuine interactive session (the control)', async () => {
    const res = await request(app).post(`${B}/auth/refresh`).set('Authorization', asUser('admin'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const setCookie = [].concat((res.headers['set-cookie'] || []) as any).join(';');
    assert.ok(/wordjs_token=/.test(setCookie), 'a real session must still be refreshable');
});

test('the refused exchange leaves the token unable to reach token/MFA management', async () => {
    // The whole point of #10: laundering the token into a cookie was the way AROUND sessionOnly. With the
    // exchange refused, the token stays what it is — a machine credential — on every guarded surface.
    const token = await mintToken('admin', 'write');
    for (const url of [`${B}/auth/tokens`, `${B}/auth/mfa/setup`]) {
        const res = await request(app).post(url).set('Authorization', `Bearer ${token}`).send({});
        assert.strictEqual(res.status, 403, `${url} → ${res.status}`);
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
    }
});

test('revokeAllForUser stamps the JWT epoch — total revocation reaches derived sessions', async () => {
    await seedUser('revoker', 'administrator');
    const staleSession = asUser('revoker'); // a session that exists BEFORE the revocation
    let res = await request(app).get(`${B}/auth/me`).set('Authorization', staleSession);
    assert.strictEqual(res.status, 200, 'session works before the revocation');

    const n = await ApiToken.revokeAllForUser(U.revoker);
    assert.strictEqual(typeof n, 'number');
    const stamp = await metaOf(U.revoker, 'token_valid_after');
    assert.ok(stamp && Number(stamp.meta_value) > 0, 'token_valid_after must be stamped');

    res = await request(app).get(`${B}/auth/me`).set('Authorization', staleSession);
    assert.strictEqual(res.status, 401, 'a session that predates the revocation must be dead');
    assert.strictEqual(res.body.code, 'rest_token_revoked');
});

// ── #11 · enrollment needs the current password ───────────────────────────────────────────────────

test('POST /auth/mfa/setup without the current password is refused — and mints no secret', async () => {
    const res = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', asUser('victim')).send({});
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_bad_current_password');
    assert.ok(!res.body.secret, 'the TOTP secret must not be disclosed');
    assert.strictEqual(await metaOf(U.victim, 'mfa_pending_secret'), undefined, 'no pending secret may be stored');
});

test('POST /auth/mfa/setup with the WRONG current password is refused', async () => {
    const res = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', asUser('victim'))
        .send({ currentPassword: 'not-my-password' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'rest_bad_current_password');
});

test('POST /auth/mfa/enable is gated too — a valid TOTP alone does not activate 2FA', async () => {
    // Enroll far enough to hold a pending secret (with the password, as the owner would), then prove that
    // the SECOND half still refuses a cookie-only caller: a hijacked session that finds a pending secret
    // must not be able to finish the enrollment.
    const setup = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', asUser('victim'))
        .send({ currentPassword: PASSWORD });
    assert.strictEqual(setup.status, 200, JSON.stringify(setup.body));
    assert.ok(setup.body.secret);

    const res = await request(app).post(`${B}/auth/mfa/enable`).set('Authorization', asUser('victim'))
        .send({ code: totp.totp(setup.body.secret) });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_bad_current_password');
    assert.strictEqual(await metaOf(U.victim, 'mfa_enabled'), undefined, '2FA must not be enabled');
});

test('the legitimate owner (password + code) still enrolls end to end', async () => {
    const setup = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', asUser('enroller'))
        .send({ currentPassword: PASSWORD });
    assert.strictEqual(setup.status, 200, JSON.stringify(setup.body));
    const enable = await request(app).post(`${B}/auth/mfa/enable`).set('Authorization', asUser('enroller'))
        .send({ currentPassword: PASSWORD, code: totp.totp(setup.body.secret) });
    assert.strictEqual(enable.status, 200, JSON.stringify(enable.body));
    assert.strictEqual(enable.body.enabled, true);
    assert.strictEqual(enable.body.backupCodes.length, 10);
    const status = await request(app).get(`${B}/auth/mfa/status`).set('Authorization', asUser('enroller'));
    assert.strictEqual(status.body.enabled, true);
});

// ── #11 · the way OUT: administrative 2FA reset ───────────────────────────────────────────────────

test('an administrator can reset another account\'s 2FA, clearing every mfa_* key', async () => {
    // 'enroller' is enrolled by the test above; without this route the only exits were a code the victim
    // no longer has, or deleting the account.
    const res = await request(app).post(`${B}/users/${U.enroller}/mfa/reset`).set('Authorization', asUser('admin2'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.reset, true);
    for (const key of ['mfa_enabled', 'mfa_totp_secret', 'mfa_recovery_codes', 'mfa_totp_last_step', 'mfa_pending_secret']) {
        assert.strictEqual(await metaOf(U.enroller, key), undefined, `${key} must be gone`);
    }
    const status = await request(app).get(`${B}/auth/mfa/status`).set('Authorization', asUser('enroller'));
    assert.strictEqual(status.body.enabled, false);
});

test('the MFA reset requires edit_users (a subscriber cannot disarm anyone)', async () => {
    const res = await request(app).post(`${B}/users/${U.victim}/mfa/reset`).set('Authorization', asUser('sub'));
    assert.strictEqual(res.status, 403);
});

test('an edit_users delegate cannot reset an ADMINISTRATOR\'s 2FA (privilege hierarchy)', async () => {
    const res = await request(app).post(`${B}/users/${U.admin}/mfa/reset`).set('Authorization', asUser('delegate'));
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_forbidden');
    // …but the same delegate may reset a non-privileged account — the hatch still works for its purpose.
    const ok = await request(app).post(`${B}/users/${U.sub}/mfa/reset`).set('Authorization', asUser('delegate'));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
});

test('the MFA reset cannot target YOURSELF (self-disable still needs a code)', async () => {
    const res = await request(app).post(`${B}/users/${U.admin}/mfa/reset`).set('Authorization', asUser('admin'));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'rest_cannot_reset_own_mfa');
});

test('an API token cannot drive the MFA reset, even an administrator\'s write token', async () => {
    const token = await mintToken('admin', 'write');
    const res = await request(app).post(`${B}/users/${U.victim}/mfa/reset`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
});

// ── #11 · the generic meta bag is not the next door in ────────────────────────────────────────────

test('User.update() refuses to write mfa_* / credential meta through the generic bag', async () => {
    await User.update(U.sub, {
        meta: {
            mfa_enabled: '1',
            mfa_totp_secret: 'ATTACKERSECRET',
            mfa_totp_last_step: '-1',
            password_reset_hash: 'deadbeef',
            email_verification_pending: '1',
            personal_email: 'legit@example.com' // an unprotected key must still be written
        }
    });
    for (const key of ['mfa_enabled', 'mfa_totp_secret', 'mfa_totp_last_step', 'password_reset_hash', 'email_verification_pending']) {
        assert.strictEqual(await metaOf(U.sub, key), undefined, `${key} must never be settable via data.meta`);
    }
    const ok = await metaOf(U.sub, 'personal_email');
    assert.strictEqual(ok && ok.meta_value, 'legit@example.com', 'ordinary meta still works');
});

// =================================================================================================
// VERIFICATION WAVE — the counterexamples the first remediation left standing.
//
// Everything below attacks the SAME invariant the #11 fix wrote down ("no operation that depends on a
// cookie alone may produce a state its owner cannot undo") through the doors that fix did not walk, plus
// the two "the guard inspects a different value than the sink" cases in the CSRF path.
// =================================================================================================

// ── the recovery address is a cookie-only path to permanent lockout ────────────────────────────────

test('PUT /users/me will not change the RECOVERY address on an ambient cookie alone', async () => {
    await seedUser('recovery', 'author');
    const hijacked = asUser('recovery');

    // The attack the #11 invariant forbids and this door allowed: rewrite personal_email, then run
    // forgot-password → the reset link lands in the attacker's inbox → reset-password takes the account
    // AND stamps token_valid_after, so the owner cannot undo it.
    const stolen = await request(app).put(`${B}/users/me`).set('Authorization', hijacked)
        .send({ personalEmail: 'attacker@evil.test' });
    assert.strictEqual(stolen.status, 403, JSON.stringify(stolen.body));
    assert.strictEqual(stolen.body.code, 'rest_bad_current_password');
    assert.strictEqual(await metaOf(U.recovery, 'personal_email'), undefined, 'the recovery address must be untouched');

    // The PRIMARY address is the same state by another name: recoveryTarget() falls back to it.
    const primary = await request(app).put(`${B}/users/me`).set('Authorization', hijacked)
        .send({ email: 'attacker2@evil.test' });
    assert.strictEqual(primary.status, 403, JSON.stringify(primary.body));
    assert.strictEqual(primary.body.code, 'rest_bad_current_password');
    const row = await dbAsync.get('SELECT user_email FROM users WHERE id = ?', [U.recovery]);
    assert.strictEqual(row.user_email, 'recovery@example.com', 'the primary address must be untouched');

    // POSITIVE CONTROL: the owner, who has the password, still changes it.
    const owner = await request(app).put(`${B}/users/me`).set('Authorization', asUser('recovery'))
        .send({ personalEmail: 'me@personal.test', currentPassword: PASSWORD });
    assert.strictEqual(owner.status, 200, JSON.stringify(owner.body));
    assert.strictEqual((await metaOf(U.recovery, 'personal_email')).meta_value, 'me@personal.test');
});

test('an UNCHANGED resend of the same addresses is not a change and needs no password', async () => {
    // Every profile form re-sends the whole object on every save. A presence check here would 403 "rename
    // me" — the no-op-resend trap professionalMailbox, `role` and the mail-domain rule each had to learn
    // separately. Different case, same value: still not a change.
    const save = await request(app).put(`${B}/users/me`).set('Authorization', asUser('recovery'))
        .send({ personalEmail: 'ME@Personal.test', email: 'recovery@example.com', displayName: 'Rec' });
    assert.strictEqual(save.status, 200, JSON.stringify(save.body));
    assert.strictEqual(save.body.displayName, 'Rec');
});

test('the /users/:ownId TWIN enforces the identical rule (a hardened door and its sibling)', async () => {
    await seedUser('recovery2', 'author');
    const hijacked = asUser('recovery2');

    const stolen = await request(app).put(`${B}/users/${U.recovery2}`).set('Authorization', hijacked)
        .send({ personalEmail: 'attacker@evil.test' });
    assert.strictEqual(stolen.status, 403, JSON.stringify(stolen.body));
    assert.strictEqual(stolen.body.code, 'rest_bad_current_password');
    assert.strictEqual(await metaOf(U.recovery2, 'personal_email'), undefined);

    const ok = await request(app).put(`${B}/users/${U.recovery2}`).set('Authorization', hijacked)
        .send({ personalEmail: 'me2@personal.test', currentPassword: PASSWORD });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await metaOf(U.recovery2, 'personal_email')).meta_value, 'me2@personal.test');

    // …and an ADMIN editing SOMEONE ELSE is untouched: that path is gated on capabilities, not on
    // proving personal ownership, so requiring the admin's own password there would be nonsense.
    const byAdmin = await request(app).put(`${B}/users/${U.recovery2}`).set('Authorization', asUser('admin'))
        .send({ personalEmail: 'set-by-admin@example.test' });
    assert.strictEqual(byAdmin.status, 200, JSON.stringify(byAdmin.body));
});

test('changing the recovery address invalidates a password-reset link already in flight', async () => {
    await seedUser('inflight', 'author');
    await User.updateMeta(U.inflight, 'password_reset_hash', 'deadbeef');
    await User.updateMeta(U.inflight, 'password_reset_expires', String(Date.now() + 900000));

    const res = await request(app).put(`${B}/users/me`).set('Authorization', asUser('inflight'))
        .send({ personalEmail: 'new@personal.test', currentPassword: PASSWORD });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((await metaOf(U.inflight, 'password_reset_hash')).meta_value, '',
        'a reset link addressed to the OLD address must not survive the move');
    assert.strictEqual((await metaOf(U.inflight, 'password_reset_expires')).meta_value, '0');
});

// ── the sudo throttle must throttle SUDO, not the owner's login ───────────────────────────────────

test('a wrong sudo password fills the SUDO bucket, never the interactive-login lock', async () => {
    await seedUser('throttled', 'author');
    const authModule = require('../routes/auth');

    // A hijacked session, already unable to change anything, must not be able to lock the OWNER out of
    // logging in — that trades "permanent lockout" for "perpetual lockout in 15-minute slices".
    for (let i = 0; i < 12; i++) {
        const r = await request(app).put(`${B}/users/me`).set('Authorization', asUser('throttled'))
            .send({ personalEmail: `probe${i}@evil.test`, currentPassword: 'not-the-password' });
        assert.ok(r.status === 403 || r.status === 429, `attempt ${i} → ${r.status}`);
    }

    const loginKey = await authModule.resolveLockIdentifier('throttled');
    assert.strictEqual(await authModule.isLoginLocked(loginKey), false,
        'the interactive-login bucket must be untouched by a re-authentication failure');

    // This test used to also assert that a bucket named 'sudo:' + loginKey had ARMED. That assertion
    // is gone because the mechanism it described was itself two defects, both since removed:
    //   1. Deriving the sudo key by concatenating a purpose onto the login identifier put it in the
    //      login store's namespace, so `POST /auth/login {username: 'sudo:victim'}` — anonymous — wrote
    //      straight into the victim's sudo counter. The counter now lives in its own store (`wjsudo:*`,
    //      disjoint from `wjlock:*`) keyed by the numeric userId, which no caller can spell.
    //   2. A LOCK on this door let a hijacked session hold the account hostage: the owner, who still
    //      knows the password, was refused every sensitive action. The door now has no lock at all —
    //      failures buy an escalating BOUNDED delay, so the owner always gets in with the right password.
    // Both properties are pinned as classes in sudo-gate-classes.test.ts. What belongs HERE is only the
    // half this file is about: a re-auth failure must never touch the interactive-login bucket, asserted
    // above, and the owner can still log in, asserted below.
    assert.strictEqual(await authModule.isLoginLocked('sudo:' + loginKey), false,
        'no bucket in the LOGIN store may be reachable by spelling a purpose onto an identifier');

    // End to end: the owner can still log in. (Bearer satisfies the header-less CSRF branch, exactly as
    // asUser does above; /auth/login itself ignores the header.)
    const login = await request(app).post(`${B}/auth/login`).set('Authorization', asUser('admin'))
        .send({ username: 'throttled', password: PASSWORD });
    assert.strictEqual(login.status, 200, `the owner must still be able to log in: ${JSON.stringify(login.body)}`);
});

// ── the CSRF guard must inspect the path EXPRESS routes ───────────────────────────────────────────

// The real csrfProtection, mounted exactly as index.ts mounts it, in front of a catch-all that reports
// the path Express actually dispatched to. That report is the point: it proves the exemption and the
// router agree on ONE string, instead of asserting a status code and hoping.
const csrfProbe = express();
csrfProbe.use(express.json());
csrfProbe.use(B, csrfProtection);
csrfProbe.use(B, (req: any, res: any) => res.json({ routedTo: req.url }));

test('the setup exemption survives a doubled separator, a trailing slash and a query', async () => {
    const cases: [string, string][] = [
        [`${B}/setup/install`, '/setup/install'],
        [`${B}/setup/install/`, '/setup/install/'],
        [`${B}/setup/install?step=2`, '/setup/install?step=2'],
        [`${B}//setup/install`, '/setup/install'], // Express's mount regexp swallows the extra slash
        [`${B}/setup/test-db`, '/setup/test-db'],
    ];
    for (const [url, routedTo] of cases) {
        const res = await request(csrfProbe).post(url).send({});
        assert.strictEqual(res.status, 200, `${url} must reach the installer, got ${res.status}`);
        assert.strictEqual(res.body.routedTo, routedTo,
            `precondition: Express routes ${url} to ${routedTo} — the exemption must compare THAT`);
    }
});

test('POST /setup/migrate is NOT exempt — only the pre-install doors are', async () => {
    // /migrate is the one route of the subtree that stays alive AFTER installation. A subtree exemption
    // handed its (throttled, but real) admin-password oracle to any visitor's browser, from the VICTIM's
    // IP. It authenticates credentials in the body and needs no ambient cookie, so it has no claim on the
    // exemption at all.
    const res = await request(csrfProbe).post(`${B}/setup/migrate`).send({ username: 'admin', password: 'x' });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_invalid');

    // …and neither is a lookalike sibling that merely starts with the same letters.
    const lookalike = await request(csrfProbe).post(`${B}/setupsomething`).send({});
    assert.strictEqual(lookalike.status, 403);
});

// ── one cookie door, structurally ─────────────────────────────────────────────────────────────────

test('the session cookie is minted in exactly ONE place in the tree', () => {
    // "A new cookie-issuing route inherits the refusal by construction" is only true while there is one
    // sink. routes/setup.ts held a second, hand-written res.cookie('wordjs_token', …) — harmless there,
    // but nothing was watching, which is how the first copy appeared too. This is the watch.
    // backend/src/tests is skipped on purpose: repo-hygiene-secrets.test.ts carries that exact line as a
    // FIXTURE string, and a scanner that flagged its own corpus would be noise, not a guard.
    const ROOT = path.join(__dirname, '..');
    const SINK = /res\.cookie\(\s*(?:'wordjs_token'|"wordjs_token"|SESSION_COOKIE)/;
    const hits: string[] = [];
    (function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'tests' && entry.name !== 'node_modules') walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            if (SINK.test(fs.readFileSync(full, 'utf8'))) {
                hits.push(path.relative(ROOT, full).split(path.sep).join('/'));
            }
        }
    })(ROOT);
    assert.deepStrictEqual(hits, ['middleware/auth.ts'],
        `the session cookie must only be set by issueSessionCookie; found: ${hits.join(', ')}`);
});

// ── revoking a token vs. ending the sessions it may have minted ───────────────────────────────────

test('routine rotation keeps the browser signed in; a declared LEAK does not', async () => {
    await seedUser('rotator', 'administrator');
    const staleSession = asUser('rotator');
    assert.strictEqual((await request(app).get(`${B}/auth/me`).set('Authorization', staleSession)).status, 200);

    await mintToken('rotator', 'write');
    const first = (await ApiToken.listForUser(U.rotator)).find((t: any) => !t.revoked);
    assert.strictEqual(await ApiToken.revoke(first.id, U.rotator), true);
    assert.strictEqual(await metaOf(U.rotator, 'token_valid_after'), undefined,
        'rotating a CI token must not sign the owner out of every browser');
    assert.strictEqual((await request(app).get(`${B}/auth/me`).set('Authorization', staleSession)).status, 200,
        'the browser session survives a routine rotation');

    // "This one leaked" is a DIFFERENT operation, and it must reach the sessions that token could have
    // minted before issueSessionCookie existed — the installed base the old comment reasoned past.
    await mintToken('rotator', 'write');
    const leaked = (await ApiToken.listForUser(U.rotator)).find((t: any) => !t.revoked);
    assert.strictEqual(await ApiToken.revoke(leaked.id, U.rotator, { compromised: true }), true);
    const stamp = await metaOf(U.rotator, 'token_valid_after');
    assert.ok(stamp && Number(stamp.meta_value) > 0, 'a leak revocation MUST stamp the JWT epoch');
    const after = await request(app).get(`${B}/auth/me`).set('Authorization', staleSession);
    assert.strictEqual(after.status, 401, 'a session that predates the leak revocation must be dead');
    assert.strictEqual(after.body.code, 'rest_token_revoked');
});

test('POST /users/me/sessions/revoke is the standalone cut-off: sudo-gated and token-proof', async () => {
    await seedUser('cutoff', 'administrator');
    const staleSession = asUser('cutoff');

    const token = await mintToken('cutoff', 'write');
    const byToken = await request(app).post(`${B}/users/me/sessions/revoke`)
        .set('Authorization', `Bearer ${token}`).send({ currentPassword: PASSWORD });
    assert.strictEqual(byToken.status, 403, JSON.stringify(byToken.body));
    assert.strictEqual(byToken.body.code, 'rest_token_management_forbidden');

    const noPassword = await request(app).post(`${B}/users/me/sessions/revoke`)
        .set('Authorization', staleSession).send({});
    assert.strictEqual(noPassword.status, 403);
    assert.strictEqual(noPassword.body.code, 'rest_bad_current_password');
    assert.strictEqual((await request(app).get(`${B}/auth/me`).set('Authorization', staleSession)).status, 200,
        'a refused cut-off changes nothing');

    const ok = await request(app).post(`${B}/users/me/sessions/revoke`)
        .set('Authorization', staleSession).send({ currentPassword: PASSWORD });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.signedOut, true);

    const after = await request(app).get(`${B}/auth/me`).set('Authorization', staleSession);
    assert.strictEqual(after.status, 401, 'every session of the account must be gone');
    assert.strictEqual(after.body.code, 'rest_token_revoked');
    // The API tokens are deliberately NOT revoked: this is "sign me out", not "change my password".
    const stillThere = (await ApiToken.listForUser(U.cutoff)).find((t: any) => !t.revoked);
    assert.ok(stillThere, 'a session cut-off must leave the headless credentials alone');
});
