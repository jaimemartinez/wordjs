/**
 * Tests for the sandbox network egress guard (core/egress-guard.ts). A network-granted plugin must be
 * confined to PUBLIC destinations — loopback, link-local (incl. 169.254.169.254 cloud metadata),
 * RFC1918, CGNAT, and IPv6 ULA/loopback must be blocked, in both v4 and IPv4-mapped-v6 forms.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const eg = require('../core/egress-guard');

test('isBlockedIp blocks the dangerous ranges (v4)', () => {
    for (const ip of [
        '127.0.0.1', '127.1.2.3',            // loopback
        '169.254.169.254', '169.254.0.1',    // link-local + cloud metadata
        '10.0.0.5', '10.255.255.255',        // 10/8
        '172.16.0.1', '172.31.255.255',      // 172.16/12
        '192.168.1.1',                       // 192.168/16
        '100.64.0.1', '100.127.0.1',         // CGNAT
        '0.0.0.0',                           // unspecified
        '224.0.0.1', '255.255.255.255',      // multicast / reserved
    ]) {
        assert.equal(eg.isBlockedIp(ip), true, `expected ${ip} to be BLOCKED`);
    }
});

test('isBlockedIp allows public v4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
        assert.equal(eg.isBlockedIp(ip), false, `expected ${ip} to be ALLOWED`);
    }
});

test('isBlockedIp handles IPv6 loopback/link-local/ULA + IPv4-mapped', () => {
    assert.equal(eg.isBlockedIp('::1'), true);
    assert.equal(eg.isBlockedIp('::'), true);
    assert.equal(eg.isBlockedIp('fe80::1'), true);
    assert.equal(eg.isBlockedIp('fc00::1'), true);
    assert.equal(eg.isBlockedIp('fd12:3456::1'), true);
    assert.equal(eg.isBlockedIp('::ffff:169.254.169.254'), true);   // IPv4-mapped metadata
    assert.equal(eg.isBlockedIp('::ffff:127.0.0.1'), true);
    assert.equal(eg.isBlockedIp('2606:4700:4700::1111'), false);    // public (Cloudflare)
});

test('isBlockedIp fails closed on garbage', () => {
    for (const v of ['', 'not-an-ip', 'localhost', undefined, null, '999.1.1.1']) {
        assert.equal(eg.isBlockedIp(v), true);
    }
});

test('guarded net rejects connecting to a blocked IP literal (synchronously)', () => {
    const guarded = eg.getGuardedModule('net');
    assert.ok(guarded, 'getGuardedModule(net) returns a module');
    assert.throws(() => guarded.connect(80, '169.254.169.254'), /egress/i, 'metadata IP literal blocked');
    assert.throws(() => guarded.connect({ host: '127.0.0.1', port: 6379 }), /egress/i, 'loopback blocked');
    assert.throws(() => guarded.createConnection({ host: '10.0.0.1', port: 80 }), /egress/i, 'private blocked');
    assert.throws(() => new guarded.Socket().connect(80, '192.168.0.1'), /egress/i, 'new Socket().connect blocked');
});

test('guarded http rejects request to a blocked IP literal (synchronously)', () => {
    const guarded = eg.getGuardedModule('http');
    assert.ok(guarded);
    assert.throws(() => guarded.request('http://169.254.169.254/latest/meta-data/'), /egress/i);
    assert.throws(() => guarded.get({ host: '127.0.0.1', port: 80, path: '/' }), /egress/i);
});

test('guarded net.connect with NO host is blocked (Node would default to localhost)', async () => {
    const guarded = eg.getGuardedModule('net');
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timed out — no-host connect was not blocked')), 5000);
        const sock = guarded.connect({ port: 1 });
        sock.on('error', (e: any) => { clearTimeout(to); try { assert.match(String(e && e.message), /egress/i); resolve(null); } catch (err) { reject(err); } });
        sock.on('connect', () => { clearTimeout(to); sock.destroy(); reject(new Error('should not have connected to localhost')); });
    });
});

test('guarded http.request with NO host is blocked (defaults to localhost)', async () => {
    const guarded = eg.getGuardedModule('http');
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timed out — no-host request was not blocked')), 5000);
        const req = guarded.request({ port: 1, path: '/' });
        req.on('error', (e: any) => { clearTimeout(to); try { assert.match(String(e && e.message), /egress/i); resolve(null); } catch (err) { reject(err); } });
        req.on('response', () => { clearTimeout(to); reject(new Error('should not have connected to localhost')); });
        req.end();
    });
});

test('assertUrlAllowedSync blocks ws:// to a private IP literal', () => {
    assert.throws(() => eg.assertUrlAllowedSync('ws://169.254.169.254/'), /egress/i);
    assert.throws(() => eg.assertUrlAllowedSync('wss://10.0.0.1:8080/x'), /egress/i);
    // a hostname is allowed synchronously (the connect-time lookup validates it later)
    assert.doesNotThrow(() => eg.assertUrlAllowedSync('wss://example.com/x'));
});

test('assertUrlAllowed (async) rejects a blocked IP-literal URL and accepts a public one', async () => {
    await assert.rejects(eg.assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /egress/i);
    await assert.rejects(eg.assertUrlAllowed('http://127.0.0.1:5432/'), /egress/i);
    await assert.doesNotReject(eg.assertUrlAllowed('https://93.184.216.34/')); // public IP literal
});
