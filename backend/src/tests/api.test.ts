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

    // 9. Account lockout: repeated failed logins for one account must lock it (429), independent of
    //    the per-IP rate limiter. Seeded 'admin' has an invalid stored hash so every attempt fails fast.
    it('locks an account after repeated failed logins (429)', async () => {
        for (let i = 0; i < 10; i++) {
            const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'wrong-pass' });
            assert.strictEqual(r.status, 401, `attempt ${i + 1} should be 401, got ${r.status}`);
        }
        const locked = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'wrong-pass' });
        assert.strictEqual(locked.status, 429, 'account must be locked after 10 failures');
        assert.strictEqual(locked.body.code, 'rest_account_locked');
    });
});
