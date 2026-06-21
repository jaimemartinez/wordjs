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

test('TOCTOU: a host/path getter is read ONCE (snapshot) and frozen — no benign-then-malicious bypass', () => {
    const guarded = eg.getGuardedModule('net');
    // host getter returning a PRIVATE IP on the first (only) read → blocked; getter must not be re-read.
    let reads = 0;
    const opts: any = { port: 80, get host() { reads++; return reads === 1 ? '10.0.0.1' : '8.8.8.8'; } };
    assert.throws(() => { const s = guarded.connect(opts); if (s) s.destroy(); }, /egress/i, 'private value from the snapshot is blocked');
    assert.strictEqual(reads, 1, 'host getter must be read exactly once (snapshot), never re-read by Node');
    // path getter (IPC/unix-socket) → blocked regardless of a later benign read.
    assert.throws(() => { const s = guarded.connect({ port: 80, get path() { return '/var/run/docker.sock'; } } as any); if (s) s.destroy(); }, /blocked|egress/i, 'IPC path via getter blocked');
});

test('assertUrlAllowedSync blocks ws:// to a private IP literal', () => {
    assert.throws(() => eg.assertUrlAllowedSync('ws://169.254.169.254/'), /egress/i);
    assert.throws(() => eg.assertUrlAllowedSync('wss://10.0.0.1:8080/x'), /egress/i);
    // a hostname is allowed synchronously (the connect-time lookup validates it later)
    assert.doesNotThrow(() => eg.assertUrlAllowedSync('wss://example.com/x'));
});

// NOTE: this is the LAST net-using test in the file. installChildNetGuard LOCKS net.Socket.prototype.
// connect (EG-1), so it cannot be restored — fine here because node --test runs this file in its own
// process and no later test uses net.Socket.connect.
test('installChildNetGuard LOCKS the REAL net.Socket.prototype.connect — closes Stream/prototype bypass, un-patch, and unix sockets', () => {
    const net = require('net');
    const orig = net.Socket.prototype.connect;
    eg.installChildNetGuard();
    assert.notStrictEqual(net.Socket.prototype.connect, orig, 'real Socket.prototype.connect must be patched');
    assert.throws(() => { const s = new net.Socket(); try { s.connect(80, '169.254.169.254'); } finally { s.destroy(); } }, /egress/i, 'direct real Socket blocked');
    assert.throws(() => { const s = new net.Stream(); try { s.connect(80, '127.0.0.1'); } finally { s.destroy(); } }, /egress/i, 'net.Stream alias blocked');
    assert.throws(() => { const s = new net.Socket(); try { Object.getPrototypeOf(net.Socket.prototype).connect; s.connect(80, '10.0.0.1'); } finally { s.destroy(); } }, /egress/i);
    // REGRESSION GUARD: net.connect/createConnection + http.request pre-normalize args into a [options,cb]
    // ARRAY before Socket.prototype.connect; the patch must unwrap it (else ERR_MISSING_ARGS). /egress/i
    // here proves the unwrap reached the egress check.
    assert.throws(() => net.connect({ host: '10.0.0.1', port: 80 }), /egress/i, 'net.connect({host,port}) reaches egress check, not ERR_MISSING_ARGS');
    assert.throws(() => net.createConnection({ host: '127.0.0.1', port: 6379 }), /egress/i);
    assert.throws(() => require('http').request({ host: '169.254.169.254', port: 80, path: '/' }), /egress/i);
    // EG-1: the patched connect is LOCKED — a plugin can't reassign it to un-patch the chokepoint.
    const d: any = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect');
    assert.strictEqual(d.writable, false, 'patched connect must be non-writable');
    assert.strictEqual(d.configurable, false, 'patched connect must be non-configurable');
    try { (net.Socket.prototype as any).connect = function () { return 'unpatched'; }; } catch { /* strict-mode TypeError expected */ }
    assert.strictEqual(net.Socket.prototype.connect, d.value, 'a reassignment attempt must NOT replace the locked connect');
    assert.throws(() => { const s = new net.Socket(); try { s.connect(80, '127.0.0.1'); } finally { s.destroy(); } }, /egress/i, 'still blocks after a reassignment attempt');
    // EG-2: IPC / unix-socket / named-pipe targets are denied for plugins (e.g. /var/run/docker.sock).
    assert.throws(() => net.connect('/var/run/docker.sock'), /blocked|egress/i, 'unix-socket path blocked');
    assert.throws(() => net.connect({ path: '/var/run/x.sock' }), /blocked|egress/i, 'path option blocked');
});

test('assertUrlAllowed (async) rejects a blocked IP-literal URL and accepts a public one', async () => {
    await assert.rejects(eg.assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /egress/i);
    await assert.rejects(eg.assertUrlAllowed('http://127.0.0.1:5432/'), /egress/i);
    await assert.doesNotReject(eg.assertUrlAllowed('https://93.184.216.34/')); // public IP literal
});
