'use strict';
/**
 * src/tcp-forward.js — the gateway forwards a TCP port to the backend node (QA X4-01: in separate mode the
 * mail server's SMTP listener lives on the backend machine, and mail sent to the site's public address
 * never reached it).
 *
 * MUTATION PROOF: drop the proxyV1Line write — the receiver never sees the client address; drop the
 * `reserved` check — a forward could take the gateway's own public port; drop the target-port check — a
 * forward could publish the backend machine's database or API port.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { sanitizeForwards, sanitizeMailPorts, bindAddress, proxyV1Line, createForwarder, MAIL_TARGET_PORTS } = require('../src/tcp-forward');

const quiet = { info() {}, warn() {}, error() {} };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('sanitizeForwards: ports only, at most ten, never the gateway\'s own ports, PROXY on by default', () => {
    assert.deepStrictEqual(sanitizeForwards([{ port: 25, targetPort: '2525' }]).value, [{ port: 25, targetPort: 2525, proxyProtocol: true }]);
    assert.deepStrictEqual(sanitizeForwards([{ port: 25, targetPort: 2525, proxyProtocol: false }]).value[0].proxyProtocol, false);
    // A switch is a boolean: "false" (truthy) is refused rather than read as on.
    for (const v of ['false', 0, 'no', null]) assert.match(sanitizeForwards([{ port: 25, targetPort: 2525, proxyProtocol: v }]).error, /proxyProtocol/, String(v));
    assert.match(sanitizeForwards([{ port: 3000, targetPort: 25 }], [3000, 3100]).error, /gateway's own ports/);
    assert.match(sanitizeForwards([{ port: 25, targetPort: 25 }, { port: 25, targetPort: 587 }]).error, /twice/);
    for (const bad of [[{ port: 0, targetPort: 25 }], [{ port: 25, targetPort: 70000 }], [{ port: '25; rm', targetPort: 25 }], 'x', [null]]) {
        assert.ok(sanitizeForwards(bad).error, JSON.stringify(bad));
    }
    assert.ok(sanitizeForwards(new Array(11).fill(0).map((_, i) => ({ port: 2000 + i, targetPort: 25 }))).error);
});

test('a forward reaches mail ports only: the standard ones, or the one the backend declares', () => {
    for (const p of MAIL_TARGET_PORTS) assert.ok(sanitizeForwards([{ port: 2000, targetPort: p }]).value, String(p));
    // The backend machine's other listeners — API, frontend, database, cache, enrollment, SSH — are refused.
    for (const p of [4000, 3001, 3000, 3100, 3101, 5432, 3306, 6379, 27017, 22, 9229, 1]) {
        assert.match(sanitizeForwards([{ port: 2000, targetPort: p }]).error, /not a mail port/, String(p));
    }
    // A port the backend reports its inbound SMTP listener on (an operator behind a port map: 2526).
    assert.deepStrictEqual(sanitizeForwards([{ port: 25, targetPort: 2526 }], [], [2526]).value, [{ port: 25, targetPort: 2526, proxyProtocol: true }]);
    assert.deepStrictEqual(sanitizeMailPorts([2526, '2527', 2526, 0, 'x', 70000, null]), [2526, 2527]);
    assert.deepStrictEqual(sanitizeMailPorts('2526'), []);
    assert.strictEqual(sanitizeMailPorts([1, 2, 3, 4, 5, 6]).length, 4);
});

test('bindAddress: an IP literal, or every interface', () => {
    assert.strictEqual(bindAddress('192.0.2.7'), '192.0.2.7');
    assert.strictEqual(bindAddress('[2001:db8::1]'), '2001:db8::1');
    assert.strictEqual(bindAddress(' 127.0.0.1 '), '127.0.0.1');
    for (const bad of [undefined, '', 'example.com', '0.0.0.0; x', 7]) assert.strictEqual(bindAddress(bad), undefined, String(bad));
});

test('a forward listens only on the configured address when one is set', async () => {
    const port = await freePort();
    const fwd = createForwarder({ backendHosts: () => ['127.0.0.1'], logger: quiet, bindHost: '127.0.0.1' });
    fwd.apply([{ port, targetPort: 25, proxyProtocol: false }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(fwd.status()[0].listening, true);
    fwd.closeAll();
});

test('proxyV1Line names the client and the address it reached', () => {
    assert.strictEqual(proxyV1Line({ remoteAddress: '::ffff:203.0.113.9', localAddress: '::ffff:192.0.2.1', remotePort: 51000, localPort: 25 }),
        'PROXY TCP4 203.0.113.9 192.0.2.1 51000 25\r\n');
    assert.strictEqual(proxyV1Line({ remoteAddress: '2001:db8::9', localAddress: '2001:db8::1', remotePort: 51000, localPort: 25 }),
        'PROXY TCP6 2001:db8::9 2001:db8::1 51000 25\r\n');
    assert.strictEqual(proxyV1Line({ remoteAddress: '203.0.113.9', localAddress: '2001:db8::1', remotePort: 1, localPort: 2 }), 'PROXY UNKNOWN\r\n');
});

test('a forwarded connection reaches the backend port, PROXY line first, and the bytes flow both ways', async () => {
    const received = [];
    const backend = net.createServer((sock) => {
        sock.on('data', (d) => { received.push(String(d)); sock.write('250 ok\r\n'); });
    });
    await new Promise((r) => backend.listen(0, '127.0.0.1', r));
    const targetPort = backend.address().port;
    const port = await freePort();
    const fwd = createForwarder({ backendHosts: () => ['127.0.0.1'], logger: quiet });
    fwd.apply([{ port, targetPort, proxyProtocol: true }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(fwd.status().map((s) => [s.port, s.listening]), [[port, true]]);

    const answer = await new Promise((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port }, () => c.write('EHLO test\r\n'));
        c.on('data', (d) => { resolve(String(d)); c.end(); });
        c.on('error', reject);
    });
    assert.strictEqual(answer, '250 ok\r\n');
    const all = received.join('');
    assert.match(all, /^PROXY TCP4 127\.0\.0\.1 127\.0\.0\.1 \d+ \d+\r\nEHLO test\r\n/);

    // Removing it closes the listener.
    fwd.apply([]);
    assert.deepStrictEqual(fwd.status(), []);
    await new Promise((r) => setTimeout(r, 100));
    const refused = await new Promise((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port });
        c.on('connect', () => { c.destroy(); resolve(false); });
        c.on('error', () => resolve(true));
    });
    assert.ok(refused, 'the port is closed again');
    await new Promise((r) => backend.close(r));
});

test('a port it cannot bind is reported, not thrown', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, r));
    const port = blocker.address().port;
    const fwd = createForwarder({ backendHosts: () => ['127.0.0.1'], logger: quiet });
    fwd.apply([{ port, targetPort: 1, proxyProtocol: false }]);
    await new Promise((r) => setTimeout(r, 150));
    const [s] = fwd.status();
    assert.strictEqual(s.listening, false);
    assert.match(s.error, /already in use/);
    fwd.closeAll();
    await new Promise((r) => blocker.close(r));
});

test('with no backend node registered a connection is closed at once', async () => {
    const port = await freePort();
    const fwd = createForwarder({ backendHosts: () => [], logger: quiet });
    fwd.apply([{ port, targetPort: 1, proxyProtocol: true }]);
    await new Promise((r) => setTimeout(r, 100));
    const closed = await new Promise((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port });
        c.on('close', () => resolve(true));
        c.on('error', () => {});
    });
    assert.ok(closed);
    fwd.closeAll();
});
