/**
 * ReDoS backstop for the shared email validator (CodeQL js/polynomial-redos).
 *
 * /^[^\s@]+@[^\s@]+\.[^\s@]+$/ is polynomial, and addresses arrive unbounded on public paths: POST /register
 * and guest comments (both unauthenticated), plus self-service profile updates. isAddressShape answers the
 * same question in one pass, and isValidAddress caps the length (RFC 5321 max, 254) as well. This proves
 * both, and that the shape accepts and refuses exactly what the pattern does.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const { isValidAddress, domainOfAddress, isAddressShape } = require('../core/email-address');

const PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

test('the shape accepts and refuses exactly what the pattern does', () => {
    const cases = ['a@b.co', 'a@b.c', 'a.b@c.d.e', 'a@.b.c', 'a@b..c', 'a@..c', 'a@b.', 'a@.b', 'a@.', 'a@..', '@b.co', 'a@', '@', '', '.', 'a', 'a.b',
        'a@b', 'a@b@c.d', '@@.', 'a b@c.d', 'a@b c.d', 'a@b.c ', ' a@b.c', 'a\n@b.c', 'a@b.c\n', 'a\t@b.c', 'a@b\u00a0.c', 'a\u2003@b.c', '\ufeffa@b.c',
        'ñandú@bücher.example', '😀@😀.😀', '!@!.', '!@!.!', '!@!.!.', "o'neil+tag@sub.example.co"];
    for (const s of cases) assert.strictEqual(isAddressShape(s), PATTERN.test(s), JSON.stringify(s));
    const parts = ['a', '@', '.', ' ', '\n'];
    for (let n = 0; n < 5 ** 6; n++) {
        let s = '';
        for (let m = n, i = 0; i < 6; i++, m = Math.floor(m / 5)) s += parts[m % 5];
        assert.strictEqual(isAddressShape(s), PATTERN.test(s), JSON.stringify(s));
    }
});

test('the shape costs one pass on the input that makes the pattern slow', () => {
    for (const attack of ['!@!.' + '!.'.repeat(1_000_000), 'a'.repeat(2_000_000), 'a@' + '.'.repeat(2_000_000)]) {
        const t0 = Date.now();
        isAddressShape(attack);
        assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
    }
});

test('isValidAddress rejects a huge no-"@" value at once', () => {
    const attack = 'a'.repeat(200_000);
    const t0 = Date.now();
    const ok = isValidAddress(attack);
    const ms = Date.now() - t0;
    assert.strictEqual(ok, false, 'an oversized value is never a valid address');
    assert.ok(ms < 1000, `took ${ms}ms`);
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
