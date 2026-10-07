/**
 * WordJS — core/log-safe: a value interpolated into a log line stays one inert line.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { logSafe, logSafeError } = require('../core/log-safe');

test('line breaks, control characters, ANSI escapes and bidi controls are removed', () => {
    assert.strictEqual(logSafe('/a\nFAKE ENTRY\r\n'), '/aFAKE ENTRY');
    assert.strictEqual(logSafe('\x1b[31mred\x1b[0m'), '[31mred[0m');
    assert.strictEqual(logSafe('a b c\u0085d'), 'abcd');
    assert.strictEqual(logSafe('admin‮txt.exe⁦x⁩'), 'admintxt.exex');
    assert.strictEqual(logSafe('tab\there\x00\x7f'), 'tabhere');
});

test('ordinary text, including non-ASCII, is kept as is', () => {
    assert.strictEqual(logSafe('https://münchen.example/ruta?q=1 · ok'), 'https://münchen.example/ruta?q=1 · ok');
    assert.strictEqual(logSafe(undefined), '');
    assert.strictEqual(logSafe(null), '');
    assert.strictEqual(logSafe(42), '42');
});

test('a caught value is logged by its message and code, never its stack', () => {
    const e = Object.assign(new Error('CA said\nno'), { code: 'ECONNRESET' });
    assert.strictEqual(logSafeError(e), 'CA saidno (ECONNRESET)');
    assert.strictEqual(logSafeError(new Error('plain')), 'plain');
    assert.strictEqual(logSafeError('thrown string\n'), 'thrown string');
    assert.strictEqual(logSafeError(undefined), '');
});
