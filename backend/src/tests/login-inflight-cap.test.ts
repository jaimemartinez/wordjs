/**
 * Concurrency backstop for the login lockout race (audit MEDIUM — AUTH-A3).
 *
 * The account-wide lock is ARMED only after N consecutive failures, and isLoginLocked reads that armed
 * flag — but the bcrypt compare between the check and the arm yields the event loop, so a BURST of
 * parallel guesses for one account could all clear isLoginLocked before any of them arms the lock,
 * evaluating far more than the intended cap of guesses per window. routes/auth.ts closes this by capping
 * the number of CONCURRENT in-flight authentications per account (MAX_LOGIN_INFLIGHT), refusing the
 * excess with 429 BEFORE bcrypt and releasing the slot in a finally.
 *
 * These drive the REAL POST /auth/login router (not a re-description): each HOLDS User.authenticate at a
 * barrier so N requests are simultaneously in flight, then asserts the cap is never exceeded, the excess
 * is refused with the in-flight 429 (distinct message from the escalating throttle), and no slot leaks.
 * Both storage paths are proven: the SINGLE-NODE in-memory fallback AND the MULTI-NODE shared-Redis path
 * (a single in-memory ioredis stand-in == the one counter every backend replica sees).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-inflight-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
require('../config/database');

const express = require('express');
const request = require('supertest');
const User = require('../models/User');
const cache = require('../core/cache');
const mfa = require('../core/mfa');

// Must match MAX_LOGIN_INFLIGHT in routes/auth.ts.
const MAX_INFLIGHT = 3;

const app = express();
app.use(express.json());
app.use('/auth', require('../routes/auth'));

// resolveLockIdentifier() resolves the canonical login via these — return null so it falls back to the
// raw identifier (keeps the tests DB-free; every request keys the one account under test).
User.findByLogin = async () => null;
User.findByEmail = async () => null;

// Minimal in-memory stand-in for the shared ioredis client, implementing only what the login path calls
// (incr/decr/expire/get/set/del). A SINGLE instance shared by every request == the shared Redis every
// backend replica sees, so a cap held against it is the cluster-wide cap.
function makeFakeRedis() {
    const m = new Map<string, string>();
    const num = (k: string) => parseInt(m.get(k) || '0', 10);
    return {
        async get(k: string) { return m.has(k) ? String(m.get(k)) : null; },
        async set(k: string, v: any) { m.set(k, String(v)); return 'OK'; },
        async del(...ks: string[]) { let n = 0; for (const k of ks) if (m.delete(k)) n++; return n; },
        async incr(k: string) { const n = num(k) + 1; m.set(k, String(n)); return n; },
        async decr(k: string) { const n = num(k) - 1; m.set(k, String(n)); return n; },
        async expire(k: string) { return m.has(k) ? 1 : 0; },
    };
}

// Fire `n` simultaneous wrong-password logins for one account, holding every authentication at a barrier
// so all N are in flight at once. Returns the observed cap metrics.
async function runBurst(account: string, n: number) {
    let inFlight = 0, peak = 0, entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    User.authenticate = async () => {
        inFlight++; entered++; peak = Math.max(peak, inFlight);
        // Once the cap is saturated, let the (already-dispatched) rejections settle, then drain the barrier.
        if (inFlight >= MAX_INFLIGHT) setTimeout(() => release(), 40);
        try { await gate; throw new Error('bad credentials'); } finally { inFlight--; }
    };
    const burst = Array.from({ length: n }, () =>
        request(app).post('/auth/login').send({ username: account, password: 'wrong' }));
    const res = await Promise.all(burst);
    return {
        peak, entered,
        rejected: res.filter((r: any) => r.status === 429),
        reached: res.filter((r: any) => r.status === 401),
    };
}

function assertCapHeld(m: any, n: number) {
    assert.ok(m.peak <= MAX_INFLIGHT, `never more than ${MAX_INFLIGHT} authentications in flight (saw ${m.peak})`);
    assert.strictEqual(m.entered, MAX_INFLIGHT, `exactly ${MAX_INFLIGHT} requests should reach the bcrypt path`);
    assert.strictEqual(m.rejected.length, n - MAX_INFLIGHT, 'every request over the cap must be refused with 429');
    assert.ok(
        m.rejected.every((r: any) => /simultaneous/i.test((r.body && r.body.message) || '')),
        'the refusal must be the in-flight cap (its own message), not the escalating IP+account throttle',
    );
    assert.strictEqual(m.reached.length, MAX_INFLIGHT, 'the capped-through attempts answer 401 invalid credentials');
}

test('in-flight cap holds on the SINGLE-NODE (in-memory) path', async () => {
    const orig = cache.getClient;
    cache.getClient = () => null; // force the in-memory fallback (monolith / no Redis configured)
    try {
        const n = MAX_INFLIGHT + 5;
        assertCapHeld(await runBurst('victim-mem', n), n);
        const after = await request(app).post('/auth/login').send({ username: 'victim-mem', password: 'wrong' });
        assert.strictEqual(after.status, 401, 'after the burst drains, a fresh attempt is admitted — no leaked slot');
    } finally { cache.getClient = orig; }
});

test('in-flight cap holds on the MULTI-NODE (shared-Redis) path', async () => {
    const orig = cache.getClient;
    const fake = makeFakeRedis();
    cache.getClient = () => fake; // one shared store == every replica sees the same in-flight counter
    try {
        const n = MAX_INFLIGHT + 5;
        assertCapHeld(await runBurst('victim-redis', n), n);
        const after = await request(app).post('/auth/login').send({ username: 'victim-redis', password: 'wrong' });
        assert.strictEqual(after.status, 401, 'slot released via decr — a fresh attempt is admitted, not wedged at 429');
    } finally { cache.getClient = orig; }
});

// The class-completeness sweep found that POST /auth/mfa (the 2FA second-factor step) had the identical
// check-then-arm race with NO inflight cap — a password-holder could brute-force the 6-digit TOTP with a
// concurrent burst and defeat 2FA. It now shares beginLoginAttempt/endLoginAttempt on the 'mfa:' bucket.
// This proves the cap bounds concurrent code guesses there too.
test('/auth/mfa: in-flight cap bounds concurrent 2FA code guesses (2FA brute-force backstop)', async () => {
    const origGetClient = cache.getClient;
    const origVerifyChallenge = mfa.verifyChallenge, origVerifyCode = mfa.verifyLoginCode, origFindById = User.findById;
    cache.getClient = () => null; // in-memory path
    mfa.verifyChallenge = () => ({ userId: 4242 });                       // a valid, reusable challenge
    User.findById = async () => ({ id: 4242, userLogin: 'mfa-victim', toJSON: () => ({ id: 4242 }) });

    let inFlight = 0, peak = 0, entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mfa.verifyLoginCode = async () => {                                   // stand in for the async code check
        inFlight++; entered++; peak = Math.max(peak, inFlight);
        if (inFlight >= MAX_INFLIGHT) setTimeout(() => release(), 40);
        try { await gate; return false; } finally { inFlight--; }        // always a wrong guess
    };
    try {
        const n = MAX_INFLIGHT + 5;
        const burst = Array.from({ length: n }, () =>
            request(app).post('/auth/mfa').send({ mfaToken: 'challenge', code: '000000' }));
        const res = await Promise.all(burst);

        assert.ok(peak <= MAX_INFLIGHT, `never more than ${MAX_INFLIGHT} code verifications in flight (saw ${peak})`);
        assert.strictEqual(entered, MAX_INFLIGHT, `exactly ${MAX_INFLIGHT} guesses should reach the code check`);
        const rejected = res.filter((r: any) => r.status === 429);
        assert.strictEqual(rejected.length, n - MAX_INFLIGHT, 'the excess concurrent code guesses must be refused with 429');
        assert.ok(rejected.every((r: any) => /simultaneous/i.test((r.body && r.body.message) || '')), 'refusal is the in-flight cap');
        assert.strictEqual(res.filter((r: any) => r.status === 401).length, MAX_INFLIGHT, 'the capped-through guesses answer 401 invalid code');
    } finally {
        cache.getClient = origGetClient;
        mfa.verifyChallenge = origVerifyChallenge; mfa.verifyLoginCode = origVerifyCode; User.findById = origFindById;
    }
});
