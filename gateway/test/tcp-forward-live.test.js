'use strict';
/**
 * TCP forwards on the REAL gateway process (support/gateway-process.js): the backend pushes them over the
 * mTLS control plane (POST /tcp-forwards, CN=backend), the gateway listens, pipes connections to the
 * registered backend node's host with a PROXY v1 line first, keeps them in gateway-config.json, and lists
 * them in GET /cluster. QA X4-01.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const harness = require('./support/gateway-process');

function internal(gw, ca, identity, method, reqPath, body) {
    return harness.request({
        port: gw.internalPort, path: reqPath, method, secure: true,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        ca: ca.pem, key: identity.key, cert: identity.cert,
    });
}

describe('the real gateway: a TCP port forwarded to the backend node', () => {
    let up;
    let gw;
    let ca;
    let backendId;
    let frontendId;
    let tcp;
    const received = [];
    let upstreamConnections = 0;
    before(async () => {
        up = await harness.startEchoUpstream('backend');
        // One greeting per connection, like an SMTP server: the PROXY line and the client's bytes arrive as
        // one chunk or two (the gateway writes them separately), and answering each chunk would make two
        // replies that the client may read as one.
        tcp = net.createServer((s) => {
            upstreamConnections++;
            s.on('data', (d) => received.push(String(d)));
            s.once('data', () => s.write('220 hello\r\n'));
        });
        await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
        ca = harness.makeCa();
        backendId = harness.makeLeaf(ca, 'backend');
        frontendId = harness.makeLeaf(ca, 'frontend');
        gw = await harness.bootGateway({ cluster: ca, upstreams: { frontend: await harness.freePort(), backend: up.port } });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (up) await up.close();
        if (tcp) await new Promise((r) => tcp.close(r));
    });

    it('only a backend identity may set them, and the gateway refuses its own ports', async () => {
        const port = await harness.freePort();
        const asFrontend = await internal(gw, ca, frontendId, 'POST', '/tcp-forwards', { forwards: [{ port, targetPort: tcp.address().port }] });
        assert.strictEqual(asFrontend.status, 403, asFrontend.body);
        const own = await internal(gw, ca, backendId, 'POST', '/tcp-forwards', { forwards: [{ port: gw.port, targetPort: 25 }] });
        assert.strictEqual(own.status, 400, own.body);
        assert.strictEqual(JSON.parse(own.body).code, 'cluster_invalid_forward');
    });

    it('listens, pipes to the backend node with the client address first, and is kept and listed', async () => {
        const port = await harness.freePort();
        const targetPort = tcp.address().port;
        const r = await internal(gw, ca, backendId, 'POST', '/tcp-forwards', { forwards: [{ port, targetPort }] });
        assert.strictEqual(r.status, 200, r.body);
        assert.deepStrictEqual(JSON.parse(r.body).forwards.map((f) => [f.port, f.targetPort, f.listening, f.proxyProtocol]), [[port, targetPort, true, true]]);

        const answer = await new Promise((resolve, reject) => {
            const c = net.connect({ host: '127.0.0.1', port }, () => c.write('EHLO x\r\n'));
            c.on('data', (d) => { resolve(String(d)); c.end(); });
            c.on('error', reject);
        });
        assert.strictEqual(answer, '220 hello\r\n');
        assert.strictEqual(upstreamConnections, 1, 'one client connection opens exactly one connection to the backend node');
        assert.match(received.join(''), /^PROXY TCP4 127\.0\.0\.1 127\.0\.0\.1 \d+ \d+\r\nEHLO x\r\n/);

        const saved = JSON.parse(fs.readFileSync(path.join(gw.dir, 'gateway-config.json'), 'utf8'));
        assert.deepStrictEqual(saved.tcpForwards, [{ port, targetPort, proxyProtocol: true }]);
        assert.ok(saved.gatewaySecret, 'the rest of the file is kept');
        const cluster = JSON.parse((await internal(gw, ca, backendId, 'GET', '/cluster')).body);
        assert.deepStrictEqual(cluster.forwards.map((f) => f.port), [port]);
    });

    it('an empty list closes them again', async () => {
        const r = await internal(gw, ca, backendId, 'POST', '/tcp-forwards', { forwards: [] });
        assert.strictEqual(r.status, 200, r.body);
        assert.deepStrictEqual(JSON.parse(r.body).forwards, []);
    });
});
