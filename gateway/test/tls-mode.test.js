'use strict';
/**
 * src/tls-mode.js — the one reading of gateway-config.json's `ssl` block.
 *
 * MUTATION PROOF: in servingKeyPair, test key/cert before the switch (the old worker order) — the
 * "stored certificate with the switch off" case serves a pair; in normalizeSsl, map `false` to `{}` —
 * the "stays off" case reads as on; in followGatewaySiteUrl, drop the port comparison — the tunnel
 * address is rewritten to the gateway's own port.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tls = require('../src/tls-mode');

const DIR = path.resolve('/gw');
const none = () => false;
const autoPresent = (p) => p.endsWith('ssl-auto.key') || p.endsWith('ssl-auto.crt');

test('the switch: absent, false and enabled:false are off; true and other objects are on', () => {
    assert.strictEqual(tls.sslSwitchedOn(undefined), false);
    assert.strictEqual(tls.sslSwitchedOn(null), false);
    assert.strictEqual(tls.sslSwitchedOn(false), false);
    assert.strictEqual(tls.sslSwitchedOn({ enabled: false }), false);
    assert.strictEqual(tls.sslSwitchedOn({ enabled: false, key: 'k', cert: 'c' }), false);
    assert.strictEqual(tls.sslSwitchedOn(true), true);
    assert.strictEqual(tls.sslSwitchedOn({}), true);
    assert.strictEqual(tls.sslSwitchedOn({ enabled: true }), true);
    assert.strictEqual(tls.sslSwitchedOn({ key: 'k', cert: 'c' }), true);
});

test('a stored certificate never turns TLS on by itself (FALLOS 108)', () => {
    assert.strictEqual(tls.servingKeyPair({ enabled: false, key: './k.pem', cert: './c.pem' }, DIR, () => true), null);
    assert.deepStrictEqual(tls.servingKeyPair({ enabled: true, key: './k.pem', cert: './c.pem' }, DIR, none),
        { key: './k.pem', cert: './c.pem', source: 'configured' });
});

test('switched on without a pair: the auto-generated pair when it exists, else plain HTTP', () => {
    assert.deepStrictEqual(tls.servingKeyPair({ enabled: true }, DIR, autoPresent), { key: 'ssl-auto.key', cert: 'ssl-auto.crt', source: 'auto' });
    assert.deepStrictEqual(tls.servingKeyPair(true, DIR, autoPresent), { key: 'ssl-auto.key', cert: 'ssl-auto.crt', source: 'auto' });
    assert.strictEqual(tls.servingKeyPair({ enabled: true }, DIR, none), null);
    // Off: the auto pair on disk is not served either.
    assert.strictEqual(tls.servingKeyPair({ enabled: false }, DIR, autoPresent), null);
    assert.strictEqual(tls.servingKeyPair(false, DIR, autoPresent), null);
});

test('normalizeSsl keeps the switch as it was: false stays off, never {} (FALLOS 111)', () => {
    assert.deepStrictEqual(tls.normalizeSsl(false), { enabled: false });
    assert.deepStrictEqual(tls.normalizeSsl(undefined), { enabled: false });
    assert.deepStrictEqual(tls.normalizeSsl(true), { enabled: true });
    assert.deepStrictEqual(tls.normalizeSsl({}), { enabled: true });
    assert.deepStrictEqual(tls.normalizeSsl({ enabled: false, key: 'k' }), { enabled: false, key: 'k' });
    const original = { enabled: true, cert: 'c' };
    const copy = tls.normalizeSsl(original);
    copy.key = 'k';
    assert.strictEqual(original.key, undefined, 'the input is not mutated');
});

test('the primary generates the auto pair only when TLS is on and no pair is configured', () => {
    assert.strictEqual(tls.needsAutoPair({ enabled: false }), false);
    assert.strictEqual(tls.needsAutoPair(false), false);
    assert.strictEqual(tls.needsAutoPair({ enabled: true, key: 'k', cert: 'c' }), false);
    assert.strictEqual(tls.needsAutoPair({}), true);
    assert.strictEqual(tls.needsAutoPair(true), true);
});

test('the gateway follows a port / TLS change only for an address on its own listener (FALLOS 114)', () => {
    // Behind a tunnel or proxy on another port: untouched.
    assert.strictEqual(tls.followGatewaySiteUrl('http://sep.example.test:3303', { oldPort: 3000, newPort: 3000, https: true }), 'http://sep.example.test:3303');
    assert.strictEqual(tls.followGatewaySiteUrl('https://www.example.test', { oldPort: 3000, newPort: 3000, https: false }), 'https://www.example.test');
    // Reached on the gateway's own port: scheme and port follow.
    assert.strictEqual(tls.followGatewaySiteUrl('http://192.0.2.7:3000', { oldPort: 3000, newPort: 3000, https: true }), 'https://192.0.2.7:3000');
    assert.strictEqual(tls.followGatewaySiteUrl('https://192.0.2.7:3000', { oldPort: 3000, newPort: 8443, https: true }), 'https://192.0.2.7:8443');
    assert.strictEqual(tls.followGatewaySiteUrl('http://example.test', { oldPort: 80, newPort: 443, https: true }), 'https://example.test');
    assert.strictEqual(tls.followGatewaySiteUrl('not a url', { oldPort: 3000, newPort: 3000, https: true }), 'not a url');
});

test('the transport aggregate reports what the workers serve', () => {
    const agg = tls.createTransportAggregate();
    assert.strictEqual(agg.summary(), null);
    agg.update(1, false);
    agg.update(2, false);
    assert.strictEqual(agg.summary(), 'http');
    agg.update(3, true);
    assert.strictEqual(agg.summary(), 'mixed');
    agg.remove(1);
    agg.remove(2);
    assert.strictEqual(agg.summary(), 'https');
});
