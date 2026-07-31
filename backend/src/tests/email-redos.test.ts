/**
 * ReDoS backstop for the shared email validator (CodeQL js/polynomial-redos).
 *
 * EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ is polynomial (quadratic backtracking on a long run with
 * no '@'). It is reached with an unbounded, attacker-controlled value on public paths — POST /register and
 * guest comments (both unauthenticated), plus self-service profile updates — and express.json accepts 10MB
 * bodies, so a multi-MB email pins the single-threaded event loop for minutes = remote DoS. isValidAddress
 * now length-caps the input (RFC 5321 max, 254) BEFORE the regex runs. This proves the cap holds and that
 * ordinary validation is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const { isValidAddress, domainOfAddress } = require('../core/mailbox');

test('isValidAddress rejects a huge no-"@" value in O(n) time — the regex never runs (ReDoS backstop)', () => {
    // 200K chars with no '@': without the length cap this is ~18s of quadratic backtracking (measured
    // 12s at 160K). With the cap the pattern is skipped, so this returns almost instantly.
    const attack = 'a'.repeat(200_000);
    const t0 = Date.now();
    const ok = isValidAddress(attack);
    const ms = Date.now() - t0;
    assert.strictEqual(ok, false, 'an oversized value is never a valid address');
    assert.ok(ms < 1000, `must short-circuit on length before the quadratic regex (took ${ms}ms; unfixed is >10000ms)`);
});

test('domainOfAddress is likewise capped and returns "" for oversized input', () => {
    const t0 = Date.now();
    assert.strictEqual(domainOfAddress('x@' + 'y'.repeat(200_000)), '');
    assert.ok(Date.now() - t0 < 1000);
});

test('isValidAddress accepts valid addresses and rejects malformed ones (no behavior regression)', () => {
    assert.strictEqual(isValidAddress('a@b.co'), true);
    assert.strictEqual(isValidAddress('  User.Name@Example.COM '), true, 'trims + normalizes');
    assert.strictEqual(isValidAddress('nope'), false, 'no @');
    assert.strictEqual(isValidAddress('a@b@c.com'), false, 'two @');
    assert.strictEqual(isValidAddress('a@bcom'), false, 'no dot in domain');
    assert.strictEqual(isValidAddress(''), false);
    assert.strictEqual(isValidAddress(null), false);
    assert.strictEqual(isValidAddress(undefined), false);
    // A normal-length address just under the cap is still accepted.
    assert.strictEqual(isValidAddress('a'.repeat(60) + '@' + 'b'.repeat(180) + '.co'), true);
});
