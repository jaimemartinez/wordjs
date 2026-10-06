'use strict';
/**
 * THE EDGE STATES HOW THE CLIENT CONNECTED — NEVER WHAT THE CLIENT CLAIMED.
 *
 * The backend believes X-Forwarded-Host and X-Forwarded-Proto from the gateway (an mTLS peer with CN
 * gateway, or a loopback hop before the certificates exist) and from a frontend replica on the same
 * machine. Those two headers decide which address a request used (the host gate, CORS, CSRF) and
 * whether it arrived over TLS (the session cookie's Secure flag, and whether a non-canonical address
 * may sign in at all). So whatever a client sends in them must die at the first hop:
 *
 *   - http-proxy's xfwd APPENDS its scheme to a client-supplied X-Forwarded-Proto. A client sending
 *     `X-Forwarded-Proto: https` over plain http reached the backend as `https,http`, and the first
 *     element is the one a trusted hop is read by: a cleartext request posed as TLS.
 *   - http-proxy's WebSocket pass never sets X-Forwarded-Host at all, so on an upgrade the client's own
 *     value reached the upstream verbatim.
 *   - frontend/backend-proxy-target.js (a replica pinned to a backend by WORDJS_BACKEND_URL) copied the
 *     client's X-Forwarded-Proto through.
 *
 * Tested on the REAL functions over real sockets with the REAL proxy configuration, then on the REAL
 * gateway process serving TLS (support/gateway-process.js).
 *
 * MUTATION PROOF (each applied to the real file, watched to fail, restored): keep the client's XFP in
 * pinForwardedHeaders; drop the XFH pin from pinUpgradeHeaders; drop the pinUpgradeHeaders call in
 * src/index.js; drop the x-forwarded-proto pin in frontend/backend-proxy-target.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');

const { createProxyServer } = require('../src/proxy-config');
const hostEdge = require('../src/host-edge');
const { proxyToBackend } = require('../../frontend/backend-proxy-target.js');
const harness = require('./support/gateway-process');

const FORGED = {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-port': '443',
    'x-forwarded-server': 'evil.example',
};

/** A miniature gateway: the real pins, the real proxy configuration, one upstream. */
async function miniGateway({ secure, upstreamPort }) {
    const proxy = createProxyServer();
    const target = `http://127.0.0.1:${upstreamPort}`;
    const onRequest = (req, res) => {
        hostEdge.pinForwardedHeaders(req);
        proxy.web(req, res, { target });
    };
    let server;
    if (secure) {
        const leaf = harness.makeLeaf(null, 'localhost');
        server = https.createServer({ key: leaf.key, cert: leaf.cert }, onRequest);
    } else {
        server = http.createServer(onRequest);
    }
    server.on('upgrade', (req, socket, head) => {
        hostEdge.pinUpgradeHeaders(req);
        proxy.ws(req, socket, head, { target }, () => socket.destroy());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => { proxy.close(); done(); }); }),
    };
}

describe('pinForwardedHeaders before proxy.web', () => {
    let upstream;
    before(async () => { upstream = await harness.startEchoUpstream('backend'); });
    after(() => upstream.close());

    for (const secure of [false, true]) {
        const scheme = secure ? 'https' : 'http';
        it(`a client's forwarded headers reach the upstream as exactly the ${scheme} listener's own`, async () => {
            const gw = await miniGateway({ secure, upstreamPort: upstream.port });
            try {
                // The forged scheme is always the OTHER one: a cleartext client claiming TLS, and a TLS
                // client whose stale proxy header would downgrade it.
                const forged = Object.assign({}, FORGED, { 'x-forwarded-proto': secure ? 'http' : 'https' });
                const r = await harness.request({ port: gw.port, secure, path: '/api/v1/auth/me', headers: Object.assign({ host: 'example.com' }, forged) });
                assert.strictEqual(r.status, 200, String(r.error));
                const seen = JSON.parse(r.body).headers;
                assert.strictEqual(seen['x-forwarded-proto'], scheme);
                assert.strictEqual(seen['x-forwarded-host'], 'example.com');
                assert.strictEqual(seen['x-forwarded-port'], secure ? '443' : '80', 'the port comes from the listener, not the client');
                assert.ok(!('x-forwarded-server' in seen));
            } finally {
                await gw.close();
            }
        });
    }

    it('a request with no Host forwards an empty X-Forwarded-Host, never the client\'s', async () => {
        const gw = await miniGateway({ secure: false, upstreamPort: upstream.port });
        try {
            const { data } = await harness.rawExchange({ port: gw.port, payload: 'GET /x HTTP/1.0\r\nX-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: https\r\n\r\n' });
            const seen = JSON.parse(data.slice(data.indexOf('\r\n\r\n') + 4)).headers;
            assert.strictEqual(seen['x-forwarded-host'], '');
            assert.strictEqual(seen['x-forwarded-proto'], 'http');
        } finally {
            await gw.close();
        }
    });
});

describe('pinUpgradeHeaders before proxy.ws', () => {
    let upstream;
    before(async () => { upstream = await harness.startEchoUpstream('frontend'); });
    after(() => upstream.close());

    for (const secure of [false, true]) {
        const scheme = secure ? 'https' : 'http';
        it(`an upgrade over ${scheme} reaches the upstream with the real Host and the listener's scheme first`, async () => {
            const gw = await miniGateway({ secure, upstreamPort: upstream.port });
            try {
                const forged = `X-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: ${secure ? 'http' : 'https'}\r\nX-Forwarded-Port: 1\r\nX-Forwarded-Server: evil.example\r\n`;
                const r = await harness.rawExchange({ port: gw.port, secure, payload: harness.upgradePayload('example.com', forged) });
                assert.match(r.data, /^HTTP\/1\.1 101 /);
                const seen = upstream.upgrades[upstream.upgrades.length - 1].headers;
                assert.strictEqual(seen['x-forwarded-host'], 'example.com');
                // http-proxy appends ws/wss AFTER the pinned value; the first element is what a trusted
                // hop is read by, and it is the listener's real scheme.
                assert.strictEqual(seen['x-forwarded-proto'], secure ? 'https,wss' : 'http,ws');
                assert.strictEqual(seen['x-forwarded-proto'].split(',')[0], scheme);
                assert.ok(!seen['x-forwarded-port'].split(',').includes('1'), seen['x-forwarded-port']);
                assert.ok(!('x-forwarded-server' in seen));
            } finally {
                await gw.close();
            }
        });
    }
});

describe('a frontend replica proxying to its backend (WORDJS_BACKEND_URL)', () => {
    it('pins X-Forwarded-Proto to the scheme it was reached on, whatever the client sent', async () => {
        const backend = await harness.startEchoUpstream('backend');
        const replica = http.createServer((req, res) => proxyToBackend(req, res, `http://127.0.0.1:${backend.port}`));
        await new Promise((resolve) => replica.listen(0, '127.0.0.1', resolve));
        try {
            const r = await harness.request({ port: replica.address().port, path: '/api/v1/auth/me', headers: { host: 'example.com', 'x-forwarded-proto': 'https' } });
            const seen = JSON.parse(r.body).headers;
            assert.strictEqual(seen['x-forwarded-proto'], 'http');
            assert.strictEqual(seen['x-forwarded-host'], 'example.com');
        } finally {
            await new Promise((done) => { replica.closeAllConnections?.(); replica.close(() => done()); });
            await backend.close();
        }
    });
});

describe('the real gateway serving TLS (src/index.js)', () => {
    let frontend;
    let backend;
    let gw;
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        gw = await harness.bootGateway({ secure: true, upstreams: { frontend: frontend.port, backend: backend.port } });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    it('relays X-Forwarded-Proto as exactly "https" when the client claims "http"', async () => {
        const r = await harness.request({ port: gw.port, secure: true, path: '/api/v1/auth/me', headers: Object.assign({ host: 'example.com' }, FORGED, { 'x-forwarded-proto': 'http' }) });
        assert.strictEqual(r.status, 200, String(r.error));
        const seen = JSON.parse(r.body).headers;
        assert.strictEqual(seen['x-forwarded-proto'], 'https');
        assert.strictEqual(seen['x-forwarded-host'], 'example.com');
        assert.ok(!('x-forwarded-server' in seen));
    });

    it('pins X-Forwarded-Host and -Proto on a WebSocket upgrade', async () => {
        const r = await harness.rawExchange({ port: gw.port, secure: true, payload: harness.upgradePayload('example.com', 'X-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: http\r\n') });
        assert.match(r.data, /^HTTP\/1\.1 101 /);
        const seen = frontend.upgrades[frontend.upgrades.length - 1].headers;
        assert.strictEqual(seen['x-forwarded-host'], 'example.com');
        assert.strictEqual(seen['x-forwarded-proto'], 'https,wss');
    });
});
