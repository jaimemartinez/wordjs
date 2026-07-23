/**
 * Escalating per-(IP + account) login lockout — core/login-throttle.ts.
 *
 * These drive the REAL LoginThrottle (the producer), not a re-description of the ladder: a fake clock
 * (`now`) and a null Redis client force the in-memory path so the escalation, reset-on-success, and —
 * the whole point of the change — the IP+account KEY ISOLATION are asserted directly. A drift in the
 * ladder or the keying turns these red.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const { LoginThrottle, applyFailure } = require('../core/login-throttle');

const MIN = 60 * 1000;
const LADDER = [5, 10, 30, 60].map((m) => m * MIN);
const POLICY = { maxFails: 5, ladderMs: LADDER, ttlMs: 120 * MIN };

function makeThrottle() {
    const box = { t: 1_000_000 };
    const throttle = new LoginThrottle(POLICY, { now: () => box.t, getClient: () => null });
    return { throttle, box };
}

// Fail `maxFails` times at the current clock instant → returns the decision from the tripping attempt.
async function tripBlock(throttle: any, ip: string, acct: string) {
    let d: any;
    for (let i = 0; i < POLICY.maxFails; i++) d = await throttle.fail(ip, acct);
    return d;
}

test('escalates 5 → 10 → 30 → 60 → 60 minutes across consecutive blocks', async () => {
    const { throttle, box } = makeThrottle();
    const ip = '203.0.113.7', acct = 'alice';

    for (const expectMin of [5, 10, 30, 60, 60]) {
        const d = await tripBlock(throttle, ip, acct);
        assert.strictEqual(d.blocked, true, `block @${expectMin}m should be active`);
        assert.strictEqual(d.retryAfterMs, expectMin * MIN, `block duration should be ${expectMin} min`);
        // Let the block lapse so the next round of failures can escalate to the next rung.
        box.t += expectMin * MIN + 1;
        assert.strictEqual((await throttle.check(ip, acct)).blocked, false, 'block should have lapsed');
    }
});

test('fewer than maxFails failures never blocks', async () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < POLICY.maxFails - 1; i++) {
        const d = await throttle.fail('203.0.113.7', 'bob');
        assert.strictEqual(d.blocked, false);
    }
});

test('a successful login resets the ladder — the next block starts again at 5 minutes', async () => {
    const { throttle } = makeThrottle();
    const ip = '198.51.100.4', acct = 'carol';

    const first = await tripBlock(throttle, ip, acct);
    assert.strictEqual(first.retryAfterMs, 5 * MIN);

    await throttle.succeed(ip, acct);
    assert.strictEqual((await throttle.check(ip, acct)).blocked, false, 'success must clear the active block');

    const again = await tripBlock(throttle, ip, acct);
    assert.strictEqual(again.level, 1, 'level must be back to 1 after a success');
    assert.strictEqual(again.retryAfterMs, 5 * MIN, 'post-reset block must be the FIRST rung, not the escalated one');
});

test('KEY ISOLATION: a block on one (IP,account) never blocks another account on the same IP, nor the same account from another IP', async () => {
    const { throttle } = makeThrottle();
    const ip = '203.0.113.9';

    await tripBlock(throttle, ip, 'victim');
    assert.strictEqual((await throttle.check(ip, 'victim')).blocked, true);

    // Same public IP, DIFFERENT account → must be free (this is the reported bug).
    assert.strictEqual((await throttle.check(ip, 'coworker')).blocked, false, 'a coworker on the same IP must NOT be locked out');
    // Same account, DIFFERENT IP → separate bucket (legit owner elsewhere can still sign in).
    assert.strictEqual((await throttle.check('192.0.2.50', 'victim')).blocked, false, 'the account owner from another IP must NOT be locked out');
});

test('username/email case + whitespace map to the same bucket (no double-budget via aliasing)', async () => {
    const { throttle } = makeThrottle();
    await tripBlock(throttle, '203.0.113.1', 'Alice@Example.com');
    assert.strictEqual((await throttle.check('203.0.113.1', '  alice@example.com ')).blocked, true);
});

test('attempts made DURING a block do not extend it', async () => {
    const { throttle, box } = makeThrottle();
    const ip = '203.0.113.2', acct = 'dave';

    await tripBlock(throttle, ip, acct); // blocked for 5 min at t0
    const remainingBefore = (await throttle.check(ip, acct)).retryAfterMs;

    box.t += 1000; // 1s later, attacker keeps trying
    const d = await throttle.fail(ip, acct);
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.retryAfterMs, remainingBefore - 1000, 'blockedUntil must be unchanged — only the clock advanced');
});

test('state is forgotten after the idle TTL — accumulated failures do not persist forever', async () => {
    const { throttle, box } = makeThrottle();
    const ip = '203.0.113.3', acct = 'erin';

    for (let i = 0; i < POLICY.maxFails - 1; i++) await throttle.fail(ip, acct); // 4 fails, not blocked
    box.t += POLICY.ttlMs + 1; // idle past the forget window
    const d = await throttle.fail(ip, acct); // should count as the FIRST failure again
    assert.strictEqual(d.blocked, false, 'stale failures must not carry over to trip a block');
});

test('applyFailure is pure and clamps past the ladder end (unit)', () => {
    // At level 4 already, one more block must stay at the last rung (60 min), never index past the array.
    const atLastRung = applyFailure({ fails: 4, level: 4, blockedUntil: 0 }, 0, POLICY);
    assert.strictEqual(atLastRung.level, 5);
    assert.strictEqual(atLastRung.blockedUntil, 60 * MIN);
    assert.strictEqual(atLastRung.fails, 0, 'fails reset to 0 when a block is applied');
});
