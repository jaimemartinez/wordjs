/**
 * The fail-CLOSED egress state (audit F-06), end to end, in the shape the isolated child is really in.
 *
 * When the host cannot load the per-plugin egress policy it spawns a network-granted plugin with
 * `egressDenyAll`, and plugin-worker.js calls ONLY `setDenyAllEgress()` — it never calls
 * `setAllowedHosts`, so the allowlist stays null. Every chokepoint used to guard its check with
 * `allowedHosts && !isHostAllowed(...)`, which skipped the check in exactly that state: the plugin got
 * unrestricted public egress instead of none. The existing F-06 test set an allowlist first and only
 * asserted `isHostAllowed()`, so it could not see it.
 *
 * This file is its own process (node --test isolates per file), which is what lets it stand in for the
 * child: the deny-all latch is one-way, and the child's prototype guards are installed and locked here
 * exactly as plugin-worker.js installs them. Destinations are public to isBlockedIp (TEST-NET-3), so the
 * only thing that can refuse them is the policy under test; the resolver is stubbed and records every
 * name it is asked for, so nothing here depends on the network.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const eg = require('../core/egress-guard');

const PUBLIC_TEST_IP = '203.0.113.10'; // TEST-NET-3: public to isBlockedIp, routed nowhere

const dnsMod = require('dns');
const realLookup = dnsMod.lookup;
const queried: string[] = [];
dnsMod.lookup = function (host: any, opts: any, cb: any) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    queried.push(String(host));
    const list = [{ address: PUBLIC_TEST_IP, family: 4 }];
    process.nextTick(() => (opts && opts.all ? cb(null, list) : cb(null, PUBLIC_TEST_IP, 4)));
};
for (const sym of Object.getOwnPropertySymbols(realLookup)) dnsMod.lookup[sym] = realLookup[sym];

// The child bootstrap under deny-all, in plugin-worker.js order: the policy, then the locked guards.
eg.setDenyAllEgress();
eg.installChildNetGuard();
eg.installChildDgramGuard();

const blocked = /blocked/;

test('precondition: no allowlist was installed — deny-all is the only policy in force', () => {
    assert.strictEqual(eg.isHostAllowed(PUBLIC_TEST_IP), false);
    assert.strictEqual(eg.isHostAllowed('example.com'), false);
});

test('TCP: raw net, guarded net, http and https refuse a public destination', () => {
    const opened: any[] = [];
    try {
        // The RAW module (what `import('net')` hands a network-granted plugin): the locked prototype.
        const rawNet = require('net');
        assert.throws(() => { opened.push(rawNet.connect({ host: PUBLIC_TEST_IP, port: 9 })); }, blocked, 'raw net.connect, IP literal');
        assert.throws(() => { opened.push(rawNet.connect({ host: 'example.com', port: 9 })); }, blocked, 'raw net.connect, hostname');
        assert.throws(() => { opened.push(new rawNet.Socket().connect(9, PUBLIC_TEST_IP)); }, blocked, 'new net.Socket().connect');
        // The guarded modules secure-require hands out.
        const net = eg.getGuardedModule('net');
        assert.throws(() => { opened.push(net.createConnection(9, PUBLIC_TEST_IP)); }, blocked, 'guarded net.createConnection');
        const http = eg.getGuardedModule('http');
        assert.throws(() => { const q = http.get(`http://${PUBLIC_TEST_IP}:9/`); q.on('error', () => {}); opened.push(q); }, blocked, 'http.get');
        const https = eg.getGuardedModule('https');
        assert.throws(() => { const q = https.request({ hostname: 'example.com', port: 443 }); q.on('error', () => {}); opened.push(q); }, blocked, 'https.request');
        const tls = eg.getGuardedModule('tls');
        assert.throws(() => { const s = tls.connect({ host: PUBLIC_TEST_IP, port: 443 }); s.on('error', () => {}); opened.push(s); }, blocked, 'tls.connect');
    } finally {
        for (const s of opened) { try { s.destroy(); } catch { /* */ } }
    }
});

test('fetch / WebSocket pre-checks and the global fetch itself refuse a public destination', async () => {
    await assert.rejects(() => eg.assertUrlAllowed(`http://${PUBLIC_TEST_IP}:9/`), blocked, 'assertUrlAllowed, IP literal');
    await assert.rejects(() => eg.assertUrlAllowed('https://example.com/'), blocked, 'assertUrlAllowed, hostname');
    assert.throws(() => eg.assertUrlAllowedSync(`wss://${PUBLIC_TEST_IP}/`), blocked, 'assertUrlAllowedSync (WebSocket/EventSource)');
    // The global fetch's own connect goes through the locked net prototype as well. Without the policy it
    // would sit on an unroutable address until the timeout instead of failing at once.
    const err: any = await fetch(`http://${PUBLIC_TEST_IP}:8080/`, { signal: AbortSignal.timeout(3000) }).then(() => null, (e) => e);
    assert.ok(err, 'fetch must fail');
    assert.match(String(err.cause && err.cause.message), blocked, `fetch refused by the egress policy, not by a timeout (${err && err.name}: ${err && err.message})`);
});

test('UDP: raw and guarded dgram send/connect refuse a public destination', async () => {
    const rawDgram = require('dgram');
    const guarded = eg.getGuardedModule('dgram');
    const sockets = [rawDgram.createSocket('udp4'), guarded.createSocket('udp4'), rawDgram.createSocket('udp4')];
    try {
        for (const [i, sock] of sockets.slice(0, 2).entries()) {
            const err = await new Promise<any>((resolve) => sock.send(Buffer.from('x'), 9, PUBLIC_TEST_IP, (e: any) => resolve(e)));
            assert.match(String(err && err.message), blocked, `dgram.send #${i}`);
        }
        const connErr = await new Promise<any>((resolve) => sockets[2].connect(9, PUBLIC_TEST_IP, (e: any) => resolve(e)));
        assert.match(String(connErr && connErr.message), blocked, 'dgram.connect');
    } finally {
        for (const s of sockets) { try { s.close(); } catch { /* */ } }
    }
});

test('name resolution: validatingLookup and the plugin dns.lookup resolve nothing', async () => {
    const before = queried.length;
    const vErr = await new Promise<any>((resolve) => eg.validatingLookup('example.com', { all: true }, (e: any) => resolve(e)));
    assert.match(String(vErr && vErr.message), blocked, 'validatingLookup');
    const dns = eg.getGuardedModule('dns');
    const lErr = await new Promise<any>((resolve) => dns.lookup('secret.attacker.example', (e: any) => resolve(e)));
    assert.match(String(lErr && lErr.message), blocked, 'dns.lookup');
    await assert.rejects(() => dns.promises.lookup('secret.attacker.example'), blocked, 'dns.promises.lookup');
    assert.deepStrictEqual(queried.slice(before), [], 'no name reached the resolver');
});

// The NATIVE udp_wrap handle guard (installChildDgramGuard → guardHandleFn), under deny-all. A plugin can
// reflect a datagram PAST the patched JS prototype straight to `sock[Symbol(state symbol)].handle.send(…)`,
// whose send/send6/connect do the real OS egress BELOW the prototype chokepoint. The guard installed on
// bind() must refuse an off-policy destination there too. The line under test —
//   `if (typeof addr === 'string' && !isHostAllowed(addr) && !jsValidatedDgramTargets.has(addr)) throw …`
// — was previously guarded as `allowedHosts && !isHostAllowed(addr)`, which SKIPS under deny-all (the
// latch leaves allowedHosts null): a reflected datagram to any public host would ride straight out. This
// asserts the deny, so restoring the `allowedHosts &&` prefix turns it red.
function dgramHandleOf(sock: any): any {
    const sym = Object.getOwnPropertySymbols(sock).find((s) => String(s) === 'Symbol(state symbol)');
    return sym ? (sock[sym] && sock[sym].handle) : null;
}

test('native dgram handle: a reflected send to a public host is refused under deny-all (guardHandleFn)', async () => {
    const dgram = require('dgram');
    // This file stubs dns.lookup to answer every name with PUBLIC_TEST_IP, and dgram bind() runs the
    // socket's lookup on its (default) bind address. Give THIS raw socket a literal-passthrough lookup so
    // bind succeeds on the wildcard; the guard under test needs no resolution — it judges the IP literal
    // handed to handle.send directly. (Raw dgram in the test process keeps the lookup option; only the
    // guarded module strips it.)
    const passthroughLookup = (host: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        const fam = require('net').isIP(String(host)) || 4;
        process.nextTick(() => (opts && opts.all ? cb(null, [{ address: String(host), family: fam }]) : cb(null, String(host), fam)));
    };
    const sock = dgram.createSocket({ type: 'udp4', lookup: passthroughLookup });
    try {
        await new Promise<void>((resolve, reject) => {
            sock.once('error', reject);
            sock.bind(0, () => resolve());
        });
        const handle = dgramHandleOf(sock);
        assert.ok(handle && typeof handle.send === 'function', 'precondition: the native udp handle is reachable and bind() wrapped it');
        assert.strictEqual((handle as any).__wjGuarded, true, 'precondition: the handle methods were guarded on bind()');

        // handle.send(req, list, length, port, address, hasCallback) — address is positional index 4. The
        // guard reads ha[4] and throws BEFORE delegating, so the dummy req/list are never used.
        assert.throws(
            () => handle.send(null, [Buffer.from('x')], 1, 1234, PUBLIC_TEST_IP, false),
            blocked,
            'handle.send to a public host must be refused under deny-all',
        );
        // send6 shares the same index-4 guard.
        if (typeof handle.send6 === 'function') {
            assert.throws(
                () => handle.send6(null, [Buffer.from('x')], 1, 1234, PUBLIC_TEST_IP, false),
                blocked,
                'handle.send6 to a public host must be refused under deny-all',
            );
        }
    } finally {
        try { sock.close(); } catch { /* */ }
    }
});
