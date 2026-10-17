/**
 * WordJS Gateway — the log level and the fronting-proxy trust the gateway used to ignore
 * (src/runtime-settings.js).
 *
 *   · LOG_LEVEL / logging.level reach the Winston logger (it was fixed at `info`).
 *   · trustProxy / WORDJS_TRUST_PROXY: behind a proxy on the same machine every visitor was 127.0.0.1 —
 *     one rate-limit bucket for the whole site, and the backend was told the proxy's address too.
 *   · Without it, the first proxied request from loopback names the fix in the log, once.
 *
 * MUTATION PROOF: drop `app.set('trust proxy', TRUST_PROXY)` in src/index.js and the end-to-end test's
 * upstream receives `198.51.100.7,127.0.0.1`, not `198.51.100.7`; drop the `trustsProxy` branch before
 * proxy.web and it receives the same; pass `level: 'info'` to the logger again and no "Proxying" line
 * appears under LOG_LEVEL=debug.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const settings = require('../src/runtime-settings');
const { createPublicLimiter } = require('../src/rate-limit');
const { bootGateway, request, startEchoUpstream, eventually } = require('./support/gateway-process');

test('the log level: LOG_LEVEL, then logging.level, then info — unknown values skipped', () => {
    assert.deepStrictEqual(settings.resolveLogLevel({}, {}), { level: 'info', silent: false });
    assert.deepStrictEqual(settings.resolveLogLevel({ LOG_LEVEL: 'debug' }, { logging: { level: 'warn' } }), { level: 'debug', silent: false });
    assert.deepStrictEqual(settings.resolveLogLevel({}, { logging: { level: 'WARN' } }), { level: 'warn', silent: false });
    assert.deepStrictEqual(settings.resolveLogLevel({ LOG_LEVEL: 'loud' }, { logging: { level: 'error' } }), { level: 'error', silent: false });
    // The backend's pino names mean the same here, so one LOG_LEVEL serves both processes.
    assert.deepStrictEqual(settings.resolveLogLevel({ LOG_LEVEL: 'trace' }, {}), { level: 'silly', silent: false });
    assert.deepStrictEqual(settings.resolveLogLevel({ LOG_LEVEL: 'fatal' }, {}), { level: 'error', silent: false });
    assert.strictEqual(settings.resolveLogLevel({ LOG_LEVEL: 'silent' }, {}).silent, true);
});

test('trustProxy: the config, then WORDJS_TRUST_PROXY, else nothing — with the backend\'s syntax', () => {
    assert.strictEqual(settings.resolveTrustProxy({}, {}), false);
    assert.strictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: 'loopback' }, {}), 'loopback');
    assert.strictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: 'loopback' }, { trustProxy: 1 }), 1);
    assert.strictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: '2' }, {}), 2);
    assert.strictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: 'true' }, {}), true);
    assert.strictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: 'false' }, {}), false);
    assert.deepStrictEqual(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }, {}), ['10.0.0.0/8', '127.0.0.1']);
    assert.strictEqual(settings.trustsAnyProxy(false), false);
    assert.strictEqual(settings.trustsAnyProxy(0), false);
    assert.strictEqual(settings.trustsAnyProxy('loopback'), true);
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function get(port, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

test('behind a trusted local proxy each visitor has its own rate-limit bucket; untrusted, they share one', async (t) => {
    const run = async (trust) => {
        const app = express();
        app.set('trust proxy', trust);
        app.use(createPublicLimiter({ rateLimit: { windowMs: 60_000, max: 2 } }, null));
        app.get('/', (req, res) => res.send('ok'));
        const server = http.createServer(app);
        const port = await listen(server);
        t.after(() => new Promise((r) => server.close(() => r())));
        const out = [];
        for (const client of ['198.51.100.1', '198.51.100.1', '198.51.100.2', '198.51.100.3']) {
            out.push(await get(port, { 'X-Forwarded-For': client }));
        }
        return out;
    };
    assert.deepStrictEqual(await run(settings.resolveTrustProxy({ WORDJS_TRUST_PROXY: 'loopback' }, {})), [200, 200, 200, 200],
        'three visitors behind the proxy are three buckets');
    assert.deepStrictEqual(await run(settings.resolveTrustProxy({}, {})), [200, 200, 429, 429],
        'with nothing trusted the proxy is one client, as before — X-Forwarded-For cannot be forged past the cap');
});

test("the AI routes outlive the backend's provider timeout; everything else keeps 60 s", () => {
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/posts', {}), 60000);
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/ai/suggest?x=1', {}), 330000);
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/ai/suggest', { WORDJS_AI_TIMEOUT_MS: '600000' }), 630000);
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/ai/suggest', { WORDJS_AI_TIMEOUT_MS: '5000' }), 60000, 'never below the default');
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/ai/suggest', { WORDJS_AI_TIMEOUT_MS: 'abc' }), 330000);
    assert.strictEqual(settings.proxyTimeoutFor('/api/v1/aim', {}), 60000);
});

test('the untrusted-proxy warning fires once, only for a loopback peer relaying a real client', () => {
    const lines = [];
    const warn = settings.createUntrustedProxyWarning(false, { warn: (m) => lines.push(m) });
    const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    warn(req('203.0.113.9', '198.51.100.1')); // a remote peer: the gateway IS the edge, nothing to say
    warn(req('127.0.0.1'));                   // the frontend's SSR, no proxy
    warn(req('127.0.0.1', '127.0.0.1'));      // a local tool through a local proxy
    assert.strictEqual(lines.length, 0);
    warn(req('::ffff:127.0.0.1', '198.51.100.1, 127.0.0.1'));
    warn(req('127.0.0.1', '198.51.100.2'));
    assert.strictEqual(lines.length, 1, 'once');
    assert.match(lines[0], /trustProxy/);
    const silent = [];
    settings.createUntrustedProxyWarning('loopback', { warn: (m) => silent.push(m) })(req('127.0.0.1', '198.51.100.1'));
    assert.strictEqual(silent.length, 0, 'nothing to say once a proxy is trusted');
});

test('stateForwardedHeaders writes what xfwd writes, with the resolved client as X-Forwarded-For', () => {
    const req = { headers: { host: 'example.test:8443', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, connection: { encrypted: true, remoteAddress: '127.0.0.1' } };
    settings.stateForwardedHeaders(req, '198.51.100.7');
    assert.strictEqual(req.headers['x-forwarded-for'], '198.51.100.7');
    assert.strictEqual(req.headers['x-forwarded-port'], '8443');
    assert.strictEqual(req.headers['x-forwarded-proto'], 'https');
    assert.strictEqual(req.headers['x-forwarded-host'], 'example.test:8443');
    const ws = { headers: { host: 'example.test', 'x-forwarded-proto': 'http' }, connection: { remoteAddress: '127.0.0.1' } };
    settings.stateForwardedHeaders(ws, '198.51.100.8', { upgrade: true });
    assert.strictEqual(ws.headers['x-forwarded-proto'], 'http,ws', 'appended after the scheme host-edge pinned, as xfwd does');
    assert.strictEqual(ws.headers['x-forwarded-port'], '80');
    assert.strictEqual(ws.headers['x-forwarded-host'], undefined, 'the WebSocket pass never writes X-Forwarded-Host');
});

test('end to end: the real gateway honours trustProxy and LOG_LEVEL', async (t) => {
    const frontend = await startEchoUpstream('frontend');
    const backend = await startEchoUpstream('backend');
    t.after(async () => { await frontend.close(); await backend.close(); });

    const gw = await bootGateway({
        upstreams: { frontend: frontend.port, backend: backend.port },
        extraConfig: { trustProxy: 'loopback' },
        env: { LOG_LEVEL: 'debug', WORDJS_TRUST_PROXY: '' },
    });
    t.after(() => gw.stop());

    const r = await request({ port: gw.port, path: '/api/v1/ping', headers: { Host: 'localhost', 'X-Forwarded-For': '198.51.100.7' } });
    assert.strictEqual(r.status, 200, r.body);
    const seen = JSON.parse(r.body).headers;
    assert.strictEqual(seen['x-forwarded-for'], '198.51.100.7', 'the backend is told the visitor, not the proxy on 127.0.0.1');
    await eventually('a debug "Proxying" line', () => /Proxying GET \/api\/v1\/ping/.test(gw.output()));

    const plain = await bootGateway({ upstreams: { frontend: frontend.port, backend: backend.port }, env: { LOG_LEVEL: '', WORDJS_TRUST_PROXY: '' } });
    t.after(() => plain.stop());
    const u = await request({ port: plain.port, path: '/api/v1/ping', headers: { Host: 'localhost', 'X-Forwarded-For': '198.51.100.7' } });
    assert.strictEqual(u.status, 200, u.body);
    assert.match(JSON.parse(u.body).headers['x-forwarded-for'], /^198\.51\.100\.7,(::ffff:)?127\.0\.0\.1$/, 'unchanged without trustProxy: the peer is appended');
    await eventually('the untrusted-proxy warning', () => /no proxy is trusted/.test(plain.output()));
    assert.doesNotMatch(plain.output(), /Proxying GET/, 'info by default: no debug lines');
});
