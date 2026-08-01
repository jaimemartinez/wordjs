/**
 * WordJS - API Integration Tests (HTTP layer)
 *
 * Exercises the REAL routers + auth middleware via supertest against a
 * minimal Express app, backed by a throwaway temp SQLite database.
 *
 * IMPORTANT: We mutate `config.dbPath` to point at a temp file BEFORE
 * requiring `../config/database` (or anything that transitively loads it,
 * such as the route modules / models). The sqlite-native-async driver
 * resolves `config.dbPath` once in its constructor at module-load time, so
 * this ordering guarantees the real data DB is never touched.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

// 1. Load the config singleton and repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(
    os.tmpdir(),
    `wordjs-api-test-${process.pid}-${Date.now()}.db`
);
config.dbPath = TMP_DB;
// Force the native sqlite driver (matches the default async driver path).
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer and the routers.
const database = require('../config/database');

let request: any;
let app: any;

const SECRET = config.jwt.secret; // configured (or ephemeral) secret
const WRONG_SECRET = 'definitely-not-the-configured-secret-xxxxx';

describe('API HTTP layer', () => {
    before(async () => {
        // Lazy-require supertest so a missing dep fails loudly here.
        request = require('supertest');

        // Boot the temp DB using the SAME pattern the app uses.
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        // Seed a single user so data-backed public routes have something to read.
        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name)
             VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        // Minimal options so GET /settings returns real values.
        await dbAsync.run(
            `INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, 'yes')`,
            ['blogname', 'Test Blog']
        );

        // Build a minimal Express app mounting the REAL routers + middleware.
        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        // Honor X-Forwarded-For so tests can simulate distinct client IPs (mirrors the real app's
        // `trust proxy` setting); req.ip then reflects the XFF value the login throttle keys on.
        app.set('trust proxy', true);
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1', require('../routes'));
    });

    after(async () => {
        try {
            await database.closeDatabase();
        } catch {
            /* ignore */
        }
        // Remove the temp db + WAL/SHM sidecar files.
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try {
                if (fs.existsSync(f)) fs.rmSync(f, { force: true });
            } catch {
                /* ignore */
            }
        }
    });

    // 1. Auth required: protected list endpoint must reject anonymous access.
    it('GET /users without a token is rejected (not 200)', async () => {
        const res = await request(app).get('/api/v1/users');
        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected a 4xx, got ${res.status}`
        );
        assert.notStrictEqual(res.status, 200, 'anonymous access must not be 200');
    });

    // 2a. Malformed bearer token must be rejected.
    it('GET /users with a malformed Bearer token is rejected', async () => {
        const res = await request(app)
            .get('/api/v1/users')
            .set('Authorization', 'Bearer xxx');
        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected a 4xx, got ${res.status}`
        );
        assert.notStrictEqual(res.status, 200);
    });

    // 2b. A token signed with the WRONG secret must fail HS256 verification.
    it('GET /users with a token signed by the wrong secret is rejected', async () => {
        const forged = jwt.sign({ userId: 1, username: 'admin' }, WRONG_SECRET, {
            algorithm: 'HS256',
            expiresIn: '1h',
        });
        const res = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${forged}`);
        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected a 4xx, got ${res.status}`
        );
        assert.notStrictEqual(res.status, 200);
    });

    // 2c. Sanity check: a token signed with the CORRECT secret authenticates.
    //     (Proves the rejection above is due to the secret, not blanket denial.)
    it('GET /users with a correctly-signed admin token is accepted', async () => {
        const good = jwt.sign({ userId: 1, username: 'admin' }, SECRET, {
            algorithm: 'HS256',
            expiresIn: '1h',
        });
        const res = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${good}`);
        // The seeded user may lack the list_users capability; what matters is
        // that JWT verification + user lookup succeeded (i.e. NOT a token error).
        assert.notStrictEqual(
            res.status,
            401,
            'a validly-signed token for an existing user must pass authentication'
        );
    });

    // 3. State-changing request without admin must be rejected.
    it('POST /users without a token is rejected (not 2xx)', async () => {
        const res = await request(app)
            .post('/api/v1/users')
            .send({ username: 'evil', email: 'e@e.com', password: 'password123' });
        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected a 4xx, got ${res.status}`
        );
        assert.ok(res.status < 200 || res.status >= 300, 'must not succeed');
    });

    // 4. Public endpoint returns 200 with expected shape.
    it('GET /settings is public and returns 200 with a settings map', async () => {
        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(typeof res.body, 'object');
        assert.ok(res.body !== null);
        // PUBLIC_SETTINGS keys are always present (value may be null/empty).
        assert.ok('blogname' in res.body, 'expected blogname key in settings');
    });

    // 5. Unknown route under the API prefix returns 404 JSON.
    it('GET an unknown API route returns 404', async () => {
        const res = await request(app).get('/api/v1/this-route-does-not-exist');
        assert.strictEqual(res.status, 404);
    });

    // 6. H1 — username-enumeration timing: authenticating a NON-existent user must burn real
    //    cost-12 bcrypt time (the old malformed dummy hash returned in ~0.015ms → 16000x oracle).
    it('login for a non-existent user burns real bcrypt time (no enumeration oracle)', async () => {
        const User = require('../models/User');
        const s = process.hrtime.bigint();
        try { await User.authenticate('no-such-user-' + Date.now(), 'whatever'); } catch { /* expected */ }
        const ms = Number(process.hrtime.bigint() - s) / 1e6;
        assert.ok(ms > 20, `non-existent-user path must do a real cost-12 compare, got ${ms.toFixed(2)}ms`);
    });

    // 7. H3 — email update must validate format and reject duplicates (create did, update did not).
    it('user email update validates format and rejects duplicates', async () => {
        const User = require('../models/User');
        const dbAsync = database.getDbAsync();
        await dbAsync.run(`INSERT INTO users (user_login,user_pass,user_email,display_name) VALUES (?,?,?,?)`, ['h3a', 'x', 'h3a@example.com', 'A']);
        await dbAsync.run(`INSERT INTO users (user_login,user_pass,user_email,display_name) VALUES (?,?,?,?)`, ['h3b', 'x', 'h3b@example.com', 'B']);
        const b = await User.findByLogin('h3b');
        await assert.rejects(() => User.update(b.id, { email: 'h3a@example.com' }), /already in use/i, 'duplicate email must be rejected');
        await assert.rejects(() => User.update(b.id, { email: 'not-an-email' }), /Invalid email/i, 'malformed email must be rejected');
        await User.update(b.id, { email: 'h3b-new@example.com' }); // unique + valid → ok
        const updated = await User.findById(b.id);
        assert.strictEqual(updated.userEmail, 'h3b-new@example.com');
    });

    // 8. user_meta leak — toJSON must NOT serialize sensitive meta keys (api keys, tokens, etc.).
    it('User.toJSON strips sensitive meta keys', async () => {
        const User = require('../models/User');
        const u = await User.findById(1);
        u.meta = { bio: 'hello', api_key: 'sk-secret', token_valid_after: '123', twofa_secret: 'ABC' };
        const json = u.toJSON();
        assert.strictEqual(json.meta.bio, 'hello', 'non-sensitive meta is kept');
        assert.ok(!('api_key' in json.meta), 'api_key must be stripped');
        assert.ok(!('token_valid_after' in json.meta), 'token_valid_after must be stripped');
        assert.ok(!('twofa_secret' in json.meta), '2fa secret must be stripped');
    });

    // 9a. Primary gate: per-(IP + account) escalating lockout. After loginMaxFails (default 5)
    //     consecutive failures from ONE IP for ONE account, further attempts are 429'd with a
    //     Retry-After. Nonexistent usernames fail fast through the same code path as a wrong password.
    it('throttles one (IP+account) after 5 failed logins (429 rest_login_throttled)', async () => {
        const ip = '203.0.113.10';
        for (let i = 0; i < 5; i++) {
            const r = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ username: 'brute-a', password: 'wrong-pass' });
            assert.strictEqual(r.status, 401, `attempt ${i + 1} should be 401, got ${r.status}`);
        }
        const blocked = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ username: 'brute-a', password: 'wrong-pass' });
        assert.strictEqual(blocked.status, 429, 'the 6th attempt must be throttled');
        assert.strictEqual(blocked.body.code, 'rest_login_throttled');
        assert.ok(Number(blocked.headers['retry-after']) > 0, 'a Retry-After (seconds) header must be sent');
    });

    // 9b. THE reported bug: a DIFFERENT account from the SAME public IP must NOT be affected by another
    //     account's lockout — one user can never lock out everyone behind their shared NAT/VPN.
    it('does not lock a second account sharing the same IP', async () => {
        const ip = '203.0.113.20';
        for (let i = 0; i < 6; i++) {
            await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ username: 'iso-a', password: 'wrong-pass' });
        }
        // iso-a is now throttled on this IP; iso-b on the SAME IP still gets its own fresh budget.
        const other = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ username: 'iso-b', password: 'wrong-pass' });
        assert.strictEqual(other.status, 401, `a co-located account must still get 401, got ${other.status}`);
    });

    // 9c. Account-wide backstop (AUTH-A3): a distributed attack spread across many IPs — invisible to
    //     the per-(IP+account) gate — must still lock the account after LOGIN_MAX_FAILS failures.
    it('locks an account after failures from many different IPs (429 rest_account_locked)', async () => {
        for (let i = 1; i <= 10; i++) {
            const r = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', `198.51.100.${i}`).send({ username: 'dist-victim', password: 'wrong-pass' });
            assert.strictEqual(r.status, 401, `attempt ${i} (ip .${i}) should be 401, got ${r.status}`);
        }
        const locked = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.200').send({ username: 'dist-victim', password: 'wrong-pass' });
        assert.strictEqual(locked.status, 429, 'account must be locked after 10 distributed failures');
        assert.strictEqual(locked.body.code, 'rest_account_locked');
    });

    // F3 (v1.13.3 security): PUT /users/me must NOT be an authenticated account-existence oracle.
    // Claiming an email already registered to ANOTHER account previously threw 'Email already in use'
    // surfaced as a 500 (distinct from the 200 a free address returned) — a working enumeration oracle.
    // The fix returns a uniform 400 whose code/message is identical to a malformed address, so a
    // registered address is indistinguishable from an invalid one.
    it('PUT /users/me with a taken email returns a uniform 400 (not a 500 existence oracle)', async () => {
        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['enum-victim', 'x', 'enum-victim@example.com', 'Victim']
        );
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['enum-claimer', 'x', 'enum-claimer@example.com', 'Claimer']
        );
        const row = await dbAsync.get(`SELECT * FROM users WHERE user_login = ?`, ['enum-claimer']);
        const claimerId = row.ID || row.id;
        const token = jwt.sign({ userId: claimerId, username: 'enum-claimer' }, SECRET, { algorithm: 'HS256', expiresIn: '2h' });

        const taken = await request(app)
            .put('/api/v1/users/me')
            .set('Authorization', `Bearer ${token}`)
            .send({ email: 'enum-victim@example.com' });
        assert.strictEqual(taken.status, 400, `a taken email must be 400, got ${taken.status}`);
        assert.strictEqual(taken.body.code, 'rest_invalid_email');

        const malformed = await request(app)
            .put('/api/v1/users/me')
            .set('Authorization', `Bearer ${token}`)
            .send({ email: 'not-an-email' });
        assert.strictEqual(malformed.status, 400);
        assert.strictEqual(malformed.body.code, taken.body.code, 'taken vs malformed must share a code');
        assert.strictEqual(malformed.body.message, taken.body.message, 'taken vs malformed must share a message (no reason leak)');
    });

    // v1.13.4 security: GET /comments must NOT leak commenter PII (authorEmail + authorIp) to an
    // unauthenticated / non-moderator caller. toJSON(canModerate) gates those fields.
    it('GET /comments does not expose authorEmail/authorIp to anonymous callers', async () => {
        const Comment = require('../models/Comment');
        await Comment.create({
            postId: 7777, author: 'Admin', authorEmail: 'private-admin@secret.test',
            authorUrl: '', authorIp: '10.9.8.7', content: 'hello', status: '1'
        });
        const anon = await request(app).get('/api/v1/comments?post=7777');
        assert.strictEqual(anon.status, 200);
        assert.ok(Array.isArray(anon.body) && anon.body.length >= 1, 'expected the approved comment');
        const c = anon.body[0];
        assert.strictEqual(c.authorEmail, undefined, 'authorEmail must NOT be exposed to anon');
        assert.strictEqual(c.authorIp, undefined, 'authorIp must NOT be exposed to anon');
        assert.strictEqual(c.author, 'Admin', 'public fields (author) still present');
    });

    // v1.13.4 security: a self-service profile URL must be http(s)-only — a javascript:/data: scheme
    // is rejected (stored empty) so it can never reach the comment-author href sink (second-order XSS).
    it('PUT /users/me rejects a javascript: profile URL and keeps a valid http URL', async () => {
        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['url-tester', 'x', 'url-tester@example.com', 'UrlTester']
        );
        const row = await dbAsync.get(`SELECT * FROM users WHERE user_login = ?`, ['url-tester']);
        const uid = row.ID || row.id;
        const token = jwt.sign({ userId: uid, username: 'url-tester' }, SECRET, { algorithm: 'HS256', expiresIn: '2h' });

        await request(app).put('/api/v1/users/me').set('Authorization', `Bearer ${token}`)
            .send({ url: 'javascript:alert(document.domain)' });
        const bad = await dbAsync.get(`SELECT user_url FROM users WHERE user_login = ?`, ['url-tester']);
        assert.strictEqual(bad.user_url, '', 'javascript: URL must be rejected (stored empty)');

        await request(app).put('/api/v1/users/me').set('Authorization', `Bearer ${token}`)
            .send({ url: 'https://example.com/me' });
        const good = await dbAsync.get(`SELECT user_url FROM users WHERE user_login = ?`, ['url-tester']);
        assert.strictEqual(good.user_url, 'https://example.com/me', 'a valid http(s) URL is preserved');
    });

    // v1.13.5 security: the sudo re-auth on PUT /users/me (own password change requires the CURRENT
    // password) must ALSO apply to the self-edit branch of PUT /users/:id — otherwise a hijacked session
    // silently resets the password via /users/:ownId (the guarded route and its sibling must not diverge).
    it('PUT /users/:ownId with a password but no currentPassword is rejected (sudo re-auth on the sibling)', async () => {
        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['reauth-tester', 'x', 'reauth-tester@example.com', 'ReauthTester']
        );
        const row = await dbAsync.get(`SELECT * FROM users WHERE user_login = ?`, ['reauth-tester']);
        const uid = row.ID || row.id;
        const token = jwt.sign({ userId: uid, username: 'reauth-tester' }, SECRET, { algorithm: 'HS256', expiresIn: '2h' });

        // /me already enforces it (regression anchor):
        const meRes = await request(app).put('/api/v1/users/me').set('Authorization', `Bearer ${token}`)
            .send({ password: 'brand-new-pass-123' });
        assert.strictEqual(meRes.status, 403, 'PUT /me self password change without currentPassword must 403');

        // the previously-unguarded sibling must now behave identically:
        const idRes = await request(app).put(`/api/v1/users/${uid}`).set('Authorization', `Bearer ${token}`)
            .send({ password: 'brand-new-pass-123' });
        assert.strictEqual(idRes.status, 403, 'PUT /users/:ownId self password change without currentPassword must 403 (was 200 — the bypass)');
        assert.strictEqual(idRes.body.code, 'rest_bad_current_password');
    });
});
