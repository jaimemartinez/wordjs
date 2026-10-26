'use strict';
/**
 * WHO THE GATEWAY HANDS A REQUEST TO, AND WHO MAY SAY WHERE THAT IS.
 *
 *  1. The pre-install loopback bootstrap is a LATCH: once a role has registered, an outage that empties
 *     its group (the health sweep) is answered 503 — never by whatever listens on the local port.
 *  2. A registered target is reduced to one canonical origin before anything is checked, a loopback
 *     target is accepted only from a peer on the gateway machine, and plain http only for loopback.
 *     Ownership compares the listener (host and port, every loopback spelling folded together), so a
 *     re-spelled URL of another identity's node cannot be claimed.
 *
 * (1) and the ownership half of (2) run against the REAL gateway process (support/gateway-process.js);
 * the peer-address rules are unit-driven, since a test peer is always on this machine.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./support/gateway-process');
const registration = require('../src/registration');
const routing = require('../src/routing');

describe('the bootstrap does not come back after an outage', () => {
    let frontend;
    let backend;
    let gw;
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        // Both roles registered once; the health sweep then evicted every target (the registry keeps
        // the empty groups). The echo servers sit on the very ports the bootstrap would dial.
        gw = await harness.bootGateway({ upstreams: { frontend: frontend.port, backend: backend.port }, registered: 'evicted' });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    it('answers 503 for the API instead of proxying it to the local port', async () => {
        const r = await harness.request({
            port: gw.port, path: '/api/v1/auth/login', method: 'POST',
            headers: { host: 'localhost', 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ username: 'u', password: 'p' }),
        });
        assert.strictEqual(r.status, 503, String(r.error || r.body));
        assert.strictEqual(backend.requests.length, 0, 'nothing reached the process on the backend port');
    });

    it('answers 503 for pages too, and refuses upgrades', async () => {
        const r = await harness.request({ port: gw.port, path: '/about', headers: { host: 'localhost' } });
        assert.strictEqual(r.status, 503);
        const ws = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', '', '/_next/hmr') });
        assert.doesNotMatch(ws.data, /^HTTP\/1\.1 101 /);
        assert.strictEqual(frontend.requests.length + frontend.upgrades.length, 0);
    });

    it('roleEverRegistered: empty groups count, an empty registry does not', () => {
        const evicted = routing.hydrateRegistry({ '/': { targets: [] }, '/api': { targets: [] } });
        assert.strictEqual(routing.roleEverRegistered(evicted, 'backend'), true);
        assert.strictEqual(routing.roleEverRegistered(evicted, 'frontend'), true);
        assert.strictEqual(routing.roleEverRegistered(new Map(), 'backend'), false);
        const onlyFrontend = routing.hydrateRegistry({ '/': { targets: ['https://10.0.0.5:3001'] } });
        assert.strictEqual(routing.roleEverRegistered(onlyFrontend, 'backend'), false);
    });
});

describe('registered targets: one canonical form, checked against who sent it', () => {
    const own = () => new Set(['192.0.2.10']);

    it('normalizeTarget reduces every spelling of a listener to its origin', () => {
        assert.strictEqual(registration.normalizeTarget('https://127.0.0.1:4000/').url, 'https://127.0.0.1:4000');
        assert.strictEqual(registration.normalizeTarget('HTTPS://Node.Example:443/x?y#z').url, 'https://node.example');
        const a = registration.normalizeTarget('https://localhost:4000');
        const b = registration.normalizeTarget('http://127.0.0.1:4000');
        const c = registration.normalizeTarget('https://[::1]:4000');
        const d = registration.normalizeTarget('https://127.1:4000');
        assert.ok(a.loopback && b.loopback && c.loopback && d.loopback);
        assert.strictEqual(new Set([a.socket, b.socket, c.socket, d.socket]).size, 1);
        for (const bad of ['', 'ftp://h:1', 'https://user:pw@h:1', 'not a url', 'file:///etc/passwd']) {
            assert.strictEqual(registration.normalizeTarget(bad), null, bad);
        }
        assert.strictEqual(registration.normalizeTarget({ toString: () => 'https://h:1' }), null);
    });

    it('a loopback target only from a peer on this machine', () => {
        const loop = registration.normalizeTarget('https://127.0.0.1:4000');
        assert.strictEqual(registration.targetProblem(loop, '::ffff:127.0.0.1', own), null);
        assert.strictEqual(registration.targetProblem(loop, '::1', own), null);
        assert.strictEqual(registration.targetProblem(loop, '192.0.2.10', own), null, 'one of this machine\'s own addresses');
        assert.strictEqual(registration.targetProblem(loop, '::ffff:192.0.2.10', own), null);
        assert.strictEqual(registration.targetProblem(loop, '10.0.0.7', own), 'loopback-from-remote');
        assert.strictEqual(registration.targetProblem(registration.normalizeTarget('http://localhost:3001'), '10.0.0.7', own), 'loopback-from-remote');
        assert.strictEqual(registration.targetProblem(loop, undefined, own), 'loopback-from-remote');
    });

    it('plain http only for a loopback target', () => {
        assert.strictEqual(registration.targetProblem(registration.normalizeTarget('http://10.0.0.7:4000'), '10.0.0.7', own), 'plain-http-remote');
        assert.strictEqual(registration.targetProblem(registration.normalizeTarget('https://10.0.0.7:4000'), '10.0.0.7', own), null);
        assert.strictEqual(registration.targetProblem(registration.normalizeTarget('http://127.0.0.1:3001'), '127.0.0.1', own), null);
        assert.strictEqual(registration.targetProblem(null, '127.0.0.1', own), 'invalid');
    });

    it('ownership compares the listener, not the string', () => {
        const owners = new Map([['https://127.0.0.1:4000', 'backend']]);
        assert.strictEqual(registration.conflictingOwner(owners, 'https://localhost:4000', 'frontend'), 'backend');
        assert.strictEqual(registration.conflictingOwner(owners, 'http://127.0.0.1:4000', 'frontend'), 'backend');
        assert.strictEqual(registration.conflictingOwner(owners, 'https://[::1]:4000', 'frontend'), 'backend');
        assert.strictEqual(registration.conflictingOwner(owners, 'https://localhost:4000', 'backend'), null, 'its own node');
        assert.strictEqual(registration.conflictingOwner(owners, 'https://127.0.0.1:3001', 'frontend'), null);
    });
});

describe('the real /register refuses a re-spelled target of another identity', () => {
    let frontend;
    let backend;
    let gw;
    let ca;
    let asBackend;
    let asFrontend;
    const register = (identity, body) => harness.request({
        port: gw.internalPort, path: '/register', method: 'POST', secure: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        ca: ca.pem, key: identity.key, cert: identity.cert,
    });
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        ca = harness.makeCa();
        asBackend = harness.makeLeaf(ca, 'backend');
        asFrontend = harness.makeLeaf(ca, 'frontend');
        gw = await harness.bootGateway({ upstreams: { frontend: frontend.port, backend: backend.port }, registered: false, cluster: ca });
        await harness.eventually('the internal listener', async () => {
            const r = await register(asBackend, { url: `https://127.0.0.1:${backend.port}`, routes: ['/api'] });
            return r.status === 200;
        }, 20000);
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    it('another identity cannot claim the backend listener by spelling it differently', async () => {
        for (const url of [`https://localhost:${backend.port}`, `http://127.0.0.1:${backend.port}`, `https://127.0.0.1:${backend.port}/`, `https://[::1]:${backend.port}`]) {
            const r = await register(asFrontend, { url, routes: ['/'] });
            assert.strictEqual(r.status, 403, `${url}: ${r.body}`);
            assert.match(r.body, /registered by another identity/);
        }
    });

    it('the owner may re-register its own node in any spelling, stored in canonical form', async () => {
        const r = await register(asBackend, { url: `https://LOCALHOST:${backend.port}/api/v1`, routes: ['/api'] });
        assert.strictEqual(r.status, 200, r.body);
        const fe = await register(asFrontend, { url: `https://127.0.0.1:${frontend.port}/`, routes: ['/'] });
        assert.strictEqual(fe.status, 200, fe.body);
    });
});

describe('hop-by-hop and internal headers never reach an upstream', () => {
    const hostEdge = require('../src/host-edge');

    it('a request drops the fixed hop-by-hop set, every header Connection names, and Connection/Upgrade', () => {
        const req = { headers: {
            host: 'example.com', connection: 'keep-alive, x-secret-hop, Authorization, content-length, host', 'keep-alive': 'timeout=5',
            'proxy-connection': 'keep-alive', 'proxy-authorization': 'Basic eA==', te: 'trailers', trailer: 'x', upgrade: 'h2c',
            'x-secret-hop': '1', authorization: 'Bearer t', 'content-length': '2', 'x-wordjs-site-route': 'two.example.org',
        }, socket: {} };
        hostEdge.pinForwardedHeaders(req);
        for (const gone of ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'x-secret-hop', 'authorization', 'x-wordjs-site-route']) {
            assert.strictEqual(req.headers[gone], undefined, gone);
        }
        assert.strictEqual(req.headers['content-length'], '2', 'body framing is never removed');
        assert.strictEqual(req.headers.host, 'example.com');
    });

    it('a Connection value naming inherited properties or non-tokens touches nothing but real own headers', () => {
        const req = { headers: { host: 'example.com', connection: '__proto__, constructor, toString, hasOwnProperty, bad name, x-real', 'x-real': '1', accept: 'a' }, socket: {} };
        hostEdge.stripHopByHop(req, false);
        assert.deepStrictEqual(Object.keys(req.headers).sort(), ['accept', 'host']);
        assert.strictEqual(typeof Object.prototype.toString, 'function');
        assert.strictEqual(typeof req.headers.hasOwnProperty, 'function', 'inherited members are untouched');
    });

    it('an upgrade keeps exactly Connection: upgrade and Upgrade', () => {
        const req = { headers: { host: 'example.com', connection: 'Upgrade, x-secret-hop', upgrade: 'websocket', 'x-secret-hop': '1', 'proxy-authorization': 'x', 'x-wordjs-site-route': 'a' }, socket: {} };
        hostEdge.pinUpgradeHeaders(req);
        assert.strictEqual(req.headers.connection, 'upgrade');
        assert.strictEqual(req.headers.upgrade, 'websocket');
        for (const gone of ['x-secret-hop', 'proxy-authorization', 'x-wordjs-site-route']) assert.strictEqual(req.headers[gone], undefined, gone);
    });
});

describe('the real gateway: what reaches the upstream, and over which TLS', () => {
    let frontend;
    let backend;
    let gw;
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        gw = await harness.bootGateway({ upstreams: { frontend: frontend.port, backend: backend.port } });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    it('a proxied request carries no hop-by-hop header and no client multisite routing header', async () => {
        const r = await harness.request({ port: gw.port, path: '/_next/static/chunks/app.js', headers: {
            host: 'localhost', connection: 'x-secret-hop', 'x-secret-hop': '1', 'proxy-authorization': 'Basic eA==', te: 'trailers',
            'x-wordjs-site-route': 'two.example.org',
        } });
        assert.strictEqual(r.status, 200, String(r.error || r.body));
        const seen = JSON.parse(r.body).headers;
        for (const gone of ['x-secret-hop', 'proxy-authorization', 'te', 'x-wordjs-site-route']) assert.strictEqual(seen[gone], undefined, gone);
    });

    it('a WebSocket upgrade still completes, with Upgrade intact', async () => {
        const r = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', 'X-Secret-Hop: 1\r\n', '/_next/hmr') });
        assert.match(r.data, /^HTTP\/1\.1 101 /);
        const last = frontend.upgrades[frontend.upgrades.length - 1];
        assert.strictEqual(last.headers.upgrade, 'websocket');
    });
});

describe('the real gateway verifies an https upstream as the role that owns the route', () => {
    const https = require('node:https');
    let ca;
    let impostor;
    let genuine;
    let gwBad;
    let gwGood;
    const tlsUpstream = (leaf, hits) => new Promise((resolve) => {
        const srv = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => { hits.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"upstream":"tls"}'); });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const impostorHits = [];
    const genuineHits = [];
    before(async () => {
        ca = harness.makeCa();
        // Every leaf chains to the same cluster CA; the impostor's is a perfectly valid FRONTEND certificate.
        impostor = await tlsUpstream(harness.makeLeaf(ca, 'frontend'), impostorHits);
        genuine = await tlsUpstream(harness.makeLeaf(ca, 'backend'), genuineHits);
        const fe = await harness.freePort();
        gwBad = await harness.bootGateway({ cluster: ca, upstreams: { frontend: fe, backend: impostor.address().port },
            registry: { '/api': { targets: [`https://127.0.0.1:${impostor.address().port}`], owners: {}, metrics: {} } } });
        gwGood = await harness.bootGateway({ cluster: ca, upstreams: { frontend: fe, backend: genuine.address().port },
            registry: { '/api': { targets: [`https://127.0.0.1:${genuine.address().port}`], owners: {}, metrics: {} } } });
    });
    after(async () => {
        for (const g of [gwBad, gwGood]) if (g) await g.stop();
        for (const s of [impostor, genuine]) if (s) await new Promise((r) => s.close(r));
    });

    it('a cluster certificate of another role answering for /api gets no request', async () => {
        const r = await harness.request({ port: gwBad.port, path: '/api/v1/auth/login', method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', accept: 'application/json' }, body: '{"password":"p"}' });
        assert.ok(r.status === 502 || r.status === 503, `${r.status} ${r.body}`);
        assert.deepStrictEqual(impostorHits, [], 'the request never reached the impostor');
    });

    it('the backend\'s own certificate is accepted', async () => {
        const r = await harness.request({ port: gwGood.port, path: '/api/v1/settings', headers: { host: 'localhost' } });
        assert.strictEqual(r.status, 200, `${r.status} ${r.body}`);
        assert.deepStrictEqual(genuineHits, ['/api/v1/settings']);
    });
});

describe('no proxied call asks http-proxy to skip TLS verification', () => {
    // http-proxy turns `secure: false` into a per-request rejectUnauthorized:false. Today Node lets the
    // keep-alive agent's own options win, so the verifying agent still verified — but the outcome hung on
    // that merge order. Only the identity-less pre-install bootstrap (no cluster CA, loopback only) may
    // say it, and it does so through ONE function.
    it('proxy.web and proxy.ws take their TLS options from tlsFor, which relaxes nothing for a verifying agent', () => {
        const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
        const calls = src.match(/proxy\.(web|ws)\([\s\S]*?\}, \(err\)/g) || [];
        assert.strictEqual(calls.length, 2, 'the two proxy calls');
        for (const c of calls) {
            assert.doesNotMatch(c, /secure\s*:/, 'no literal secure option in a proxy call');
            assert.match(c, /\.\.\.tlsFor\(agent\)/);
        }
        assert.strictEqual((src.match(/secure:\s*false/g) || []).length, 1, 'only tlsFor names secure:false');
        assert.match(src, /const tlsFor = \(agent\) => \(agent === false \? \{ secure: false \} : \{\}\);/);
    });
});
