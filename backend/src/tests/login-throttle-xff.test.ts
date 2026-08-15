/**
 * WordJS — regression for the X-Forwarded-For rate-limit / lockout bypass (audit 2026-08-08, P1).
 *
 * THREAT: in the single-process monolith there is no fronting proxy, yet the per-(IP+account) login
 * throttle keyed on `req.ip`, which Express derives from client-supplied X-Forwarded-For. An attacker
 * rotated that header to mint a fresh bucket per request and never tripped the lockout.
 *
 * This file boots the login route in DIRECT (no-proxy) mode: config.trustProxy = false. To make the
 * bypass reproducible under the OLD code it ALSO sets Express `trust proxy = true` — i.e. Express is
 * willing to honour X-Forwarded-For. The fix keys the throttle on core/client-ip's honest client IP
 * (the socket peer) instead of req.ip, so a rotating header can no longer split the bucket.
 *
 * MUTATION PROOF: revert routes/auth.ts to `const ip = req.ip` (or make client-ip trust the proxy when
 * config says not to) and every rotated-header attempt lands in its own bucket — the 6th stays 401 and
 * the `assert.strictEqual(sixth.status, 429)` below fails. The per-(IP+account) throttle (maxFails 5)
 * trips at attempt 6, strictly BEFORE the account-wide lockout (10), so this test isolates the throttle
 * that the header rotation used to defeat and does not merely observe the account backstop.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load config and repoint the DB at a throwaway file BEFORE anything pulls in the DB layer/models.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-xff-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
// DIRECT deployment: no proxy is trusted. core/client-ip must therefore key on the socket peer and
// ignore X-Forwarded-For entirely — the whole point of the fix.
config.trustProxy = false;

const database = require('../config/database');

let request: any;
let app: any;

describe('login throttle resists X-Forwarded-For rotation (monolith / no trusted proxy)', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        // Seed the victim so resolveLockIdentifier canonicalises to a real login (the throttle keys on
        // it). user_pass is a non-hash so User.authenticate always fails → each attempt is a failure.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['xff-victim', 'not-a-real-hash', 'xff-victim@example.com', 'Victim']
        );

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        // Adversarial: Express is CONFIGURED to honour X-Forwarded-For. If the throttle still keyed on
        // req.ip, the rotation below would defeat it. The fix keys on the socket peer regardless.
        app.set('trust proxy', true);
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1', require('../routes'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    it('trips the per-(IP+account) lockout despite a fresh X-Forwarded-For every attempt', async () => {
        const attempt = (i: number) =>
            request(app)
                .post('/api/v1/auth/login')
                // A brand-new spoofed client IP on every request — the exact evasion the audit reproduced.
                .set('X-Forwarded-For', `203.0.113.${i}`)
                .send({ username: 'xff-victim', password: 'wrong-pass' });

        // Five failures from the (constant) socket peer arm the ladder; each returns 401.
        for (let i = 1; i <= 5; i++) {
            const r = await attempt(i);
            assert.strictEqual(
                r.status, 401,
                `attempt ${i} should be 401 (spoofed XFF must not open a fresh bucket), got ${r.status}`
            );
        }

        // The 6th is refused by the per-(IP+account) throttle — proving it keyed on the socket peer, not
        // the rotating header. Under the vulnerable code this stays 401 and the account backstop (10)
        // has not yet fired, so this assertion is a true mutation catch.
        const sixth = await attempt(6);
        assert.strictEqual(sixth.status, 429, `the 6th attempt must be throttled on the socket IP, got ${sixth.status}`);
        assert.strictEqual(sixth.body.code, 'rest_login_throttled', `expected throttle code, got ${sixth.body.code}`);
    });
});
