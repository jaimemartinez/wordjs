'use strict';
/**
 * THE MONOLITH'S PUBLIC LISTENER ANSWERS ONLY THE SITE'S ADDRESSES.
 *
 * In the single-process shape there is no gateway: monolith.js's dispatcher IS the edge, and before
 * phase 2 it handed every request for every name to Next or the backend. The backend gate refused
 * unknown names on API paths only; pages, static files and Next's WebSocket were answered for any
 * domain a stranger pointed at the server.
 *
 * These tests drive the REAL handlers main() mounts — createDispatch, createUpgradeHandler,
 * createPublicServer, createNextServer, createAcmeHandler and createMonolithEdge, exported for exactly
 * this — on real sockets, with stand-ins only for the two things a unit test cannot boot (the backend
 * Express app, which runs the REAL host gate, and Next). The policy comes from a real host-policy
 * provider published as `backendApp.hostPolicy`, which is how the backend hands the monolith the policy
 * its own gate applies.
 *
 * The order inside the dispatcher is part of the contract and is tested as such: the edge runs BEFORE
 * the forwarded-header pins (they overwrite a proxy's X-Forwarded-Host, one of the REDTEAM R4 signals)
 * and BEFORE the SEO rewrites (so /sitemap.xml on a foreign name is judged as the page it is).
 *
 * The lab found three more ways the monolith differed from that contract, each pinned below: probe paths
 * were exempt by prefix (E1); Next.js attached its own 'upgrade' listener to the public server, so one
 * WebSocket to /api re-entered the listener through Next's /api rewrite forever (E2); and the edge
 * judged Host where the backend judged a trusted proxy's X-Forwarded-Host (E3).
 *
 * MUTATION PROOF (each applied to monolith.js, watched to fail, restored): move the edge call after the
 * pins; move it after the SEO rewrites; drop it from the dispatcher; drop it from the upgrade handler;
 * answer the ACME redirect with the raw Host; stop passing the backend's install state; drop the public
 * server's upgrade-listener confinement (one upgrade became 503 connections in 0.4 s); create Next
 * without the httpServer sink; hand every non-backend upgrade to Next; pin X-Forwarded-Host to the raw
 * Host again; exempt the probes by prefix (host-edge.js); let a dot segment through (host-edge.js, review
 * EDGE-R1); dispatch upgrades through the server's own emit again (review EDGE-R2).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const hp = require('../src/host-policy');
const monolith = require('../../monolith.js');
const harness = require('./support/gateway-process');

const silent = { info() {}, warn() {}, error() {} };

/**
 * A stand-in backend app that records what reached it, published with a REAL policy provider over a
 * config object the test can swap (configManager hands out a new object when the file changes, which
 * is the provider's memo key).
 */
function fakeBackend(state) {
    const seen = [];
    let gate = null;
    const app = (req, res) => gate(req, res, () => {
        // `scheme` and `host` are what the backend itself derives from the request it receives (host-policy
        // trustedScheme / requestHost with its own policy): the values its CSRF, Secure-cookie and sign-in
        // rules read. `siteHost` is what its REAL gate (mounted first, as backend/src/index.ts does)
        // attached — so a test can check the edge and the gate judged the same address.
        const pol = app.hostPolicy.get();
        seen.push({
            url: req.url,
            xfh: req.headers['x-forwarded-host'],
            xfp: req.headers['x-forwarded-proto'],
            scheme: hp.trustedScheme(req, pol),
            host: hp.requestHost(req, pol),
            siteHost: req.siteHost || null,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ who: 'backend', url: req.url }));
    });
    app.hostPolicy = hp.createPolicyProvider({ getConfig: () => state.config, env: {}, nodeEnv: 'production', logger: silent, ownAddresses: () => new Set() });
    gate = hp.hostGateFactory({
        getPolicy: app.hostPolicy.get,
        isInstalled: () => state.installed !== false,
        logger: silent,
        refused: hp.createRefusedHosts(),
        lastSeen: hp.createLastSeen(),
    });
    app.seen = seen;
    return app;
}

function fakeNext() {
    const seen = [];
    const handle = (req, res) => {
        seen.push({ url: req.url, host: req.headers.host });
        res.setHeader('Content-Type', 'text/html');
        res.end('<p>next</p>');
    };
    handle.seen = seen;
    return handle;
}

const SITE = { siteUrl: 'https://example.com', siteAliases: [{ url: 'https://www.example.com', mode: 'redirect' }], installedAt: '2026-10-01T00:00:00Z' };

async function monolithServer(state, { proto = 'https', dev = true } = {}) {
    const backendApp = fakeBackend(state);
    const handle = fakeNext();
    const upgraded = [];
    const refused = hp.createRefusedHosts();
    const edge = monolith.createMonolithEdge({ backendApp, isInstalled: () => state.installed !== false, refused, logger: silent });
    // Wired as main() wires it: the public server with the monolith's upgrade handler as its only
    // listener, and Next's HMR handler (here, one that completes the handshake) behind the sink.
    const sink = monolith.createNextUpgradeSink();
    sink.on('upgrade', (req, socket) => {
        upgraded.push(req.headers.host);
        socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    const server = monolith.createPublicServer({
        ssl: null,
        requestListener: monolith.createDispatch({ backendApp, handle, proto, edge }),
        upgradeHandler: monolith.createUpgradeHandler({ edge, hmr: dev ? monolith.forwardUpgrade(sink) : null }),
        sink,
        logger: silent,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        backendApp,
        handle,
        upgraded,
        refused,
        get: (host, p = '/', headers = {}, method = 'GET') => harness.request({ port, path: p, method, headers: Object.assign({ host }, headers) }),
        raw: (payload) => harness.rawExchange({ port, payload }),
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    };
}

describe('the monolith dispatcher', () => {
    const state = { config: SITE };
    let m;
    before(async () => { m = await monolithServer(state); });
    after(() => m.close());

    it('refuses a page on an unknown address with the static 421 page; Next never renders it', async () => {
        const r = await m.get('evil.example', '/about');
        assert.strictEqual(r.status, 421);
        assert.match(r.headers['content-type'], /^text\/html/);
        assert.match(r.headers['content-security-policy'], /^default-src 'none'/);
        assert.deepStrictEqual(r.body.match(/<a\s[^>]*>/gi), ['<a href="https://example.com/">']);
        assert.strictEqual(m.handle.seen.length, 0);
    });

    it('refuses the API, uploads and static trees on an unknown address before the backend sees them', async () => {
        const api = await m.get('evil.example', '/api/v1/posts');
        assert.strictEqual(api.status, 421);
        assert.strictEqual(JSON.parse(api.body).code, 'rest_host_not_allowed');
        for (const p of ['/uploads/a.png', '/themes/default/style.css', '/public/css/wordjs-ui.css']) {
            assert.strictEqual((await m.get('evil.example', p)).status, 421, p);
        }
        assert.strictEqual(m.backendApp.seen.length, 0);
    });

    it('records the refusal in the tracker it was given (the backend\'s, for Settings → Site address)', () => {
        assert.ok(m.refused.list().some((e) => e.host === 'evil.example'));
    });

    it('serves the main address, IP literals and loopback, with the forwarded headers pinned after the check', async () => {
        assert.strictEqual((await m.get('example.com', '/about')).body, '<p>next</p>');
        const r = await m.get('example.com', '/api/v1/posts', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' });
        assert.strictEqual(JSON.parse(r.body).who, 'backend');
        const last = m.backendApp.seen[m.backendApp.seen.length - 1];
        // A direct client's X-Forwarded-Host never reaches the backend: the edge judged Host, so the header
        // is removed and the backend judges that same Host.
        assert.strictEqual(last.xfh, undefined);
        assert.strictEqual(last.host, 'example.com');
        assert.strictEqual(last.xfp, 'https');
        for (const host of ['192.168.1.11:3000', 'localhost:3000', '[::1]:3000']) {
            assert.strictEqual((await m.get(host, '/about')).status, 200, host);
        }
    });

    it('judges the request BEFORE the pins: a proxy-relayed X-Forwarded-Host in front of an IP Host is refused (R4)', async () => {
        // Once pinned, X-Forwarded-Host would equal Host and the proxy would be invisible.
        assert.strictEqual((await m.get('192.168.5.20:3000', '/about', { 'x-forwarded-host': 'blog.example.com' })).status, 421);
        assert.strictEqual((await m.get('192.168.5.20:3000', '/about', { 'x-forwarded-for': '203.0.113.9' })).status, 421);
    });

    it('judges the URL the client asked for, BEFORE the SEO rewrites', async () => {
        const r = await m.get('evil.example', '/sitemap.xml');
        assert.strictEqual(r.status, 421);
        assert.match(r.headers['content-type'], /^text\/html/, 'the page refusal, not the API JSON of /api/v1/seo/sitemap.xml');
    });

    it('answers /healthz and probes on any address', async () => {
        assert.strictEqual((await m.get('evil.example', '/healthz')).status, 200);
        assert.strictEqual(JSON.parse((await m.get('evil.example', '/readyz')).body).who, 'backend');
    });

    it('exempts the probe paths EXACTLY: a traversal or a sub-path under one is judged like any request', async () => {
        // Next.js resolves dot segments and fetched /api through its own rewrite as Host: localhost, so the
        // old prefix exemption let /healthz/../api/v1/settings on a foreign name reach the API (lab E1).
        const pages = m.handle.seen.length;
        const api = m.backendApp.seen.length;
        for (const p of ['/healthz/../api/v1/settings', '/health/../api/v1/settings', '/metrics/../about', '/readyz/%2e%2e/about',
            '/healthz/x', '/health/x', '/healthz/', '/healthz;x', '/.well-known/acme-challenge/../../api/v1/settings',
            '/.well-known/acme-challenge/a/b', '/.well-known/acme-challenge/a%2e%2e']) {
            const { data } = await m.raw(`GET ${p} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
            assert.match(data, /^HTTP\/1\.1 421 /, p);
        }
        assert.strictEqual(m.handle.seen.length, pages, 'Next rendered none of them');
        assert.strictEqual(m.backendApp.seen.length, api, 'the backend served none of them');
        // The real probes and an ACME token still answer on any address, a query string included.
        for (const p of ['/healthz?verbose=1', '/health', '/readyz?x=1', '/metrics', '/.well-known/acme-challenge/Tok_en-1']) {
            assert.notStrictEqual((await m.get('evil.example', p)).status, 421, p);
        }
    });

    it('400s a dot segment or a backslash on every address it answers; Next and the backend never see it (review EDGE-R1)', async () => {
        // The dispatcher routes on the raw path and Next resolves it: /x/../api/v1/settings went to Next,
        // whose baked /api rewrite fetched the API back through this listener from loopback.
        const pages = m.handle.seen.length;
        const api = m.backendApp.seen.length;
        for (const host of ['example.com', 'localhost:3000', '192.168.1.11:3000']) {
            for (const p of ['/x/../api/v1/settings', '/about/%2e%2e/api/v1/settings', '/api/v1/../v1/settings', '/uploads/..;/x', '/x\\..\\api\\v1\\settings']) {
                const { data } = await m.raw(`GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
                assert.match(data, /^HTTP\/1\.1 400 /, `${host} ${p}`);
            }
        }
        assert.match((await m.raw('GET /x/../api/v1/settings HTTP/1.0\r\n\r\n')).data, /^HTTP\/1\.1 400 /, 'without a Host too');
        assert.strictEqual(m.handle.seen.length, pages, 'Next rendered none of them');
        assert.strictEqual(m.backendApp.seen.length, api, 'the backend served none of them');
        assert.strictEqual((await m.get('example.com', '/uploads/100%25%20off.png')).status, 200, 'an encoded % is a name, not a dot segment');
    });

    it('redirects a redirect alias to the main address for pages, and serves its API', async () => {
        const r = await m.get('www.example.com', '/blog?p=2');
        assert.strictEqual(r.status, 308);
        assert.strictEqual(r.headers.location, 'https://example.com/blog?p=2');
        assert.strictEqual(JSON.parse((await m.get('www.example.com', '/api/v1/posts')).body).who, 'backend');
    });

    it('400s a repeated Host', async () => {
        const { data } = await m.raw('GET /about HTTP/1.1\r\nHost: example.com\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
        assert.match(data, /^HTTP\/1\.1 400 /);
    });

    it('follows the backend\'s policy as it changes (the provider is read per request)', async () => {
        state.config = Object.assign({}, SITE, { siteAliases: SITE.siteAliases.concat([{ url: 'https://evil.example' }]) });
        try {
            assert.strictEqual((await m.get('evil.example', '/about')).status, 200);
        } finally {
            state.config = SITE;
        }
        assert.strictEqual((await m.get('evil.example', '/about')).status, 421);
    });
});

describe('the monolith before install, and with a backend that publishes no policy', () => {
    it('lets every address reach the install wizard until the site is installed', async () => {
        const state = { config: SITE, installed: false };
        const m = await monolithServer(state);
        try {
            assert.strictEqual((await m.get('evil.example', '/install')).status, 200);
            state.installed = true;
            assert.strictEqual((await m.get('evil.example', '/install')).status, 421);
        } finally {
            await m.close();
        }
    });

    it('createMonolithEdge returns null without app.hostPolicy, and the dispatcher then answers as before', async () => {
        const backendApp = (req, res) => res.end('backend');
        assert.strictEqual(monolith.createMonolithEdge({ backendApp, isInstalled: () => true }), null);
        const server = http.createServer(monolith.createDispatch({ backendApp, handle: (req, res) => res.end('next'), proto: 'http', edge: null }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const r = await harness.request({ port: server.address().port, path: '/about', headers: { host: 'evil.example' } });
            assert.strictEqual(r.body, 'next');
        } finally {
            await new Promise((done) => server.close(() => done()));
        }
    });
});

describe('the monolith behind a TLS-terminating proxy (REDTEAM R12)', () => {
    // The production shape: nginx or an ingress terminates TLS and forwards to the container's plain-http
    // listener (WORDJS_HTTP=1), Host preserved. The dispatcher used to pin X-Forwarded-Proto to its own
    // listener's scheme, so the backend saw 'http' even from a proxy the operator declared in trustProxy,
    // and every https alias or WORDJS_ALLOWED_HOSTS entry was refused sign-in (rest_insecure_transport).
    const TRUSTED = Object.assign({}, SITE, { trustProxy: 'loopback' });
    const viaProxy = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.4' };

    it('a proxy the operator trusts reports https: the backend believes https', async () => {
        const m = await monolithServer({ config: TRUSTED }, { proto: 'http' });
        try {
            const r = await m.get('www.example.com', '/api/v1/auth/login', viaProxy);
            assert.strictEqual(JSON.parse(r.body).who, 'backend');
            const last = m.backendApp.seen[m.backendApp.seen.length - 1];
            assert.strictEqual(last.xfp, 'https');
            assert.strictEqual(last.scheme, 'https', 'the backend\'s own derivation reads https from the trusted hop');
            // The proxy forwarded Host (a dotted name), so the edge judged Host and the backend reads it.
            assert.strictEqual(last.xfh, undefined);
            assert.strictEqual(last.host, 'www.example.com');
        } finally {
            await m.close();
        }
    });

    it('the same request from a peer nobody declared gets the listener\'s scheme, whatever it claims', async () => {
        const m = await monolithServer({ config: SITE }, { proto: 'http' });
        try {
            await m.get('www.example.com', '/api/v1/auth/login', viaProxy);
            const last = m.backendApp.seen[m.backendApp.seen.length - 1];
            assert.strictEqual(last.xfp, 'http');
            assert.strictEqual(last.scheme, 'http');
        } finally {
            await m.close();
        }
    });

    it('a trusted hop without a usable X-Forwarded-Proto gets the listener\'s scheme too', async () => {
        const m = await monolithServer({ config: TRUSTED }, { proto: 'http' });
        try {
            await m.get('www.example.com', '/api/v1/auth/login', { 'x-forwarded-proto': 'gopher', 'x-forwarded-for': '198.51.100.4' });
            assert.strictEqual(m.backendApp.seen[m.backendApp.seen.length - 1].xfp, 'http');
        } finally {
            await m.close();
        }
    });
});

describe('the monolith WebSocket upgrade handler', () => {
    const state = { config: SITE };
    let m;
    before(async () => { m = await monolithServer(state); });
    after(() => m.close());

    it('refuses an upgrade to an unknown address on the socket; Next never sees it', async () => {
        const r = await m.raw(harness.upgradePayload('evil.example'));
        assert.match(r.data, /^HTTP\/1\.1 421 /);
        assert.deepStrictEqual(m.upgraded, []);
    });

    it('hands an accepted upgrade to Next\'s HMR channel only on its exact path; closes every other one', async () => {
        const hmr = (p) => harness.upgradePayload('example.com').replace('GET /ws ', `GET ${p} `);
        assert.match((await m.raw(hmr('/_next/hmr?id=abc'))).data, /^HTTP\/1\.1 101 /);
        assert.deepStrictEqual(m.upgraded, ['example.com']);
        // A backend path, a page path, and spellings Next would resolve to something else (its rewrites
        // proxy those back into this listener): closed, never handed on.
        for (const p of ['/ws', '/api/v1/collab/1', '/uploads/a', '/_next/hmrx', '/_next/static/x', '/_next/webpack-hmr']) {
            const r = await m.raw(hmr(p));
            assert.strictEqual(r.data, '', p);
            assert.ok(r.closed, p);
        }
        // A dot segment is answered by the edge itself (400, review EDGE-R1) before that: closed, never handed on.
        for (const p of ['/_next/hmr/../../api/v1/collab/1', '/_next/x/../hmr']) {
            const r = await m.raw(hmr(p));
            assert.match(r.data, /^HTTP\/1\.1 400 /, p);
            assert.ok(r.closed, p);
        }
        assert.deepStrictEqual(m.upgraded, ['example.com']);
    });

    it('a probe path is not exempt on an upgrade: an unknown address gets the 421', async () => {
        const r = await m.raw(harness.upgradePayload('evil.example').replace('GET /ws ', 'GET /healthz '));
        assert.match(r.data, /^HTTP\/1\.1 421 /);
    });

    it('in production nothing is handed to Next, not even its HMR path', async () => {
        const prod = await monolithServer({ config: SITE }, { dev: false });
        try {
            const r = await prod.raw(harness.upgradePayload('example.com').replace('GET /ws ', 'GET /_next/hmr '));
            assert.strictEqual(r.data, '');
            assert.deepStrictEqual(prod.upgraded, []);
        } finally {
            await prod.close();
        }
    });
});

describe('the monolith edge judges the address the backend judges (trustProxy, loopback hops)', () => {
    // site-address.md "Which header names the host": X-Forwarded-Host from an address-based trustProxy peer
    // is believed only when the Host that peer sent is an IP, a loopback or a single-label name; from a
    // loopback hop that addressed a loopback name it is believed too. The edge used to judge Host alone,
    // so in the monolith that rule never applied (lab, critic): a trusted peer's IP Host let any forwarded
    // name in, and a single-label upstream got 421. The test client connects from 127.0.0.1; with
    // trustProxy 127.0.0.1 it is an operator proxy whenever its Host is not a loopback name.
    const TRUSTING = Object.assign({}, SITE, { trustProxy: '127.0.0.1' });

    it('an operator proxy that dials by IP or single-label name: its X-Forwarded-Host is the address judged', async () => {
        const m = await monolithServer({ config: TRUSTING }, { proto: 'http' });
        try {
            assert.strictEqual((await m.get('192.168.182.23:3000', '/about', { 'x-forwarded-host': 'evil.example' })).status, 421);
            assert.strictEqual((await m.get('192.168.182.23:3000', '/about', { 'x-forwarded-host': '127.1' })).status, 400);
            for (const host of ['wordjs:3000', '192.168.182.23:3000']) {
                const r = await m.get(host, '/api/v1/posts', { 'x-forwarded-host': 'example.com' });
                assert.strictEqual(r.status, 200, host);
                const last = m.backendApp.seen[m.backendApp.seen.length - 1];
                assert.strictEqual(last.xfh, 'example.com', `${host}: X-Forwarded-Host is pinned to the address the edge judged`);
                assert.strictEqual(last.host, 'example.com', `${host}: the backend derives the same address`);
                assert.strictEqual(last.siteHost && last.siteHost.cls, 'canonical', `${host}: and its gate classifies it the same`);
            }
        } finally {
            await m.close();
        }
    });

    it('a trusted peer that sends a dotted Host is judged by that Host — both ways', async () => {
        const m = await monolithServer({ config: TRUSTING }, { proto: 'http' });
        try {
            // A DNS-rebinding page on a trusted network cannot pass X-Forwarded-Host off as its address…
            assert.strictEqual((await m.get('evil.example', '/about', { 'x-forwarded-host': 'example.com' })).status, 421);
            // …and a proxy that forwards the browser's Host is served by it, whatever X-Forwarded-Host says.
            const r = await m.get('example.com', '/api/v1/posts', { 'x-forwarded-host': 'evil.example' });
            assert.strictEqual(r.status, 200);
            const last = m.backendApp.seen[m.backendApp.seen.length - 1];
            assert.strictEqual(last.xfh, undefined, 'the unread X-Forwarded-Host does not reach the backend');
            assert.strictEqual(last.host, 'example.com');
        } finally {
            await m.close();
        }
    });

    it('a loopback hop that addressed a loopback name: its X-Forwarded-Host is judged (no trustProxy needed)', async () => {
        const m = await monolithServer({ config: SITE }, { proto: 'http' });
        try {
            assert.strictEqual((await m.get('localhost:3000', '/about', { 'x-forwarded-host': 'evil.example' })).status, 421);
            assert.strictEqual((await m.get('127.0.0.1:3000', '/api/v1/posts', { 'x-forwarded-host': 'evil.example' })).status, 421);
            const r = await m.get('127.0.0.1:3000', '/api/v1/posts', { 'x-forwarded-host': 'example.com' });
            assert.strictEqual(r.status, 200);
            const last = m.backendApp.seen[m.backendApp.seen.length - 1];
            assert.strictEqual(last.xfh, 'example.com');
            assert.strictEqual(last.siteHost && last.siteHost.cls, 'canonical');
            // Without X-Forwarded-Host the loopback name itself is judged, as before.
            assert.strictEqual((await m.get('localhost:3000', '/about')).status, 200);
        } finally {
            await m.close();
        }
    });

    it('R4 is unchanged: from a peer nobody declared, an IP Host with proxy headers is refused', async () => {
        const m = await monolithServer({ config: SITE }, { proto: 'http' });
        try {
            assert.strictEqual((await m.get('192.168.182.23:3000', '/about', { 'x-forwarded-host': 'example.com' })).status, 421);
            assert.strictEqual((await m.get('192.168.182.23:3000', '/about', { 'x-forwarded-for': '203.0.113.9' })).status, 421);
            assert.strictEqual((await m.get('192.168.182.23:3000', '/about')).status, 200, 'the same IP with no proxy headers is a phone on the LAN');
        } finally {
            await m.close();
        }
    });
});

// ─── One upgrade listener (lab E2) ──────────────────────────────────────────────────────────────────

/**
 * Next's custom-server wrapper, reduced to the one behaviour that matters here — setupWebSocketHandler in
 * next/dist/server/next.js (16.3.4): on its FIRST request it attaches its own 'upgrade' listener to
 * `options.httpServer || req.socket.server`. `ignoresHttpServer` stands for a later version that attaches
 * to the request's server regardless (the worst case). The listener does what Next's router does with an
 * upgrade: it answers its HMR path, and sends anything a rewrite matches through proxyRequest — the build
 * bakes `/api/:path*` → `http://localhost:<gatewayPort>`, which in the monolith is THIS listener, entered
 * again with `Host: localhost:<port>` and X-Forwarded-Host set to the Host it received.
 */
function nextLikeServer({ httpServer, ignoresHttpServer, port }) {
    const state = { upgrades: 0, stopped: false };
    let attached = false;
    const listener = (req, socket) => {
        state.upgrades += 1;
        socket.on('error', () => {});
        if (req.url.split('?')[0] === '/_next/hmr') {
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
            return;
        }
        if (state.stopped) return socket.destroy();
        // The rewrite proxy dials its target whatever became of the client's socket meanwhile.
        const upstream = require('node:net').connect(port(), '127.0.0.1', () => upstream.write(
            `GET ${req.url} HTTP/1.1\r\nHost: localhost:${port()}\r\nX-Forwarded-Host: ${req.headers.host || ''}\r\n`
            + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
        upstream.on('error', () => {});
        upstream.on('close', () => socket.destroy());
    };
    const handle = (req, res) => {
        if (!attached) {
            attached = true;
            ((!ignoresHttpServer && httpServer) || req.socket.server).on('upgrade', listener);
        }
        res.setHeader('Content-Type', 'text/html');
        res.end('<p>next</p>');
    };
    return { handle, state };
}

/** The public server exactly as main() builds it, with nextLikeServer standing in for Next. */
async function publicServer({ ignoresHttpServer = false, dev = false } = {}) {
    const state = { config: SITE };
    const backendApp = fakeBackend(state);
    const edge = monolith.createMonolithEdge({ backendApp, isInstalled: () => true, refused: hp.createRefusedHosts(), logger: silent });
    const sink = monolith.createNextUpgradeSink();
    let port = 0;
    const next = nextLikeServer({ httpServer: sink, ignoresHttpServer, port: () => port });
    const warnings = [];
    const upgradeHandler = monolith.createUpgradeHandler({ edge, hmr: dev ? monolith.forwardUpgrade(sink) : null });
    const server = monolith.createPublicServer({
        ssl: null,
        requestListener: monolith.createDispatch({ backendApp, handle: next.handle, proto: 'http', edge }),
        upgradeHandler,
        sink,
        logger: { info() {}, error() {}, warn: (line) => warnings.push(line) },
    });
    let connections = 0;
    server.on('connection', () => { connections += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    return {
        server,
        sink,
        next,
        warnings,
        upgradeHandler,
        connections: () => connections,
        page: (host) => harness.request({ port, path: '/about', headers: { host } }),
        upgrade: (host, p) => harness.rawExchange({ port, payload: harness.upgradePayload(host).replace('GET /ws ', `GET ${p} `), waitMs: 2000 }),
        close: () => {
            next.state.stopped = true;
            return new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
        },
    };
}

const settle = () => harness.sleep(400);

describe('the monolith public server: one upgrade listener, so one upgrade is one connection', () => {
    for (const ignoresHttpServer of [false, true]) {
        const which = ignoresHttpServer ? 'a Next that attaches to the request\'s server' : 'Next as installed (attaches to httpServer)';

        it(`${which}: an upgrade to an unknown address gets exactly one 421 and nothing else`, async () => {
            const s = await publicServer({ ignoresHttpServer });
            try {
                assert.strictEqual((await s.page('example.com')).status, 200, 'the first page request is when Next attaches its listener');
                const before = s.connections();
                const r = await s.upgrade('evil.example', '/api/v1/collab/1');
                assert.match(r.data, /^HTTP\/1\.1 421 Misdirected Request\r\n/);
                assert.strictEqual((r.data.match(/HTTP\/1\.1 \d{3}/g) || []).length, 1, 'one response, no second answer on the socket');
                assert.ok(r.closed);
                await settle();
                assert.strictEqual(s.connections(), before + 1, 'no connection beyond the client\'s own');
                assert.strictEqual(s.next.state.upgrades, 0, 'Next\'s upgrade listener never ran');
            } finally {
                await s.close();
            }
        });

        it(`${which}: an accepted upgrade on a rewritten path is closed, not proxied back into the listener`, async () => {
            const s = await publicServer({ ignoresHttpServer });
            try {
                await s.page('example.com');
                const before = s.connections();
                for (const p of ['/api/v1/collab/1', '/uploads/x', '/about']) {
                    const r = await s.upgrade('example.com', p);
                    assert.strictEqual(r.data, '', p);
                    assert.ok(r.closed, p);
                }
                await settle();
                assert.strictEqual(s.connections(), before + 3, 'three upgrades, three connections');
                assert.strictEqual(s.next.state.upgrades, 0);
            } finally {
                await s.close();
            }
        });

        it(`${which}: the public server keeps one 'upgrade' listener, and in dev the HMR channel still reaches Next`, async () => {
            const s = await publicServer({ ignoresHttpServer, dev: true });
            try {
                await s.page('example.com');
                await settle();
                assert.deepStrictEqual(s.server.listeners('upgrade'), [s.upgradeHandler]);
                assert.strictEqual(s.sink.listenerCount('upgrade'), 1, 'Next\'s listener sits behind the monolith\'s handler');
                assert.strictEqual(s.warnings.length, ignoresHttpServer ? 1 : 0, 'a listener moved off the public server is reported once');
                const before = s.connections();
                const r = await s.upgrade('example.com', '/_next/hmr?id=1');
                assert.match(r.data, /^HTTP\/1\.1 101 /);
                assert.strictEqual(s.next.state.upgrades, 1);
                assert.strictEqual((await s.upgrade('evil.example', '/_next/hmr?id=1')).data.slice(0, 12), 'HTTP/1.1 421');
                assert.strictEqual(s.next.state.upgrades, 1, 'the edge refused the foreign one before Next');
                await settle();
                assert.strictEqual(s.connections(), before + 2);
            } finally {
                await s.close();
            }
        });
    }

    it('a listener attached during the first request never sees an upgrade pipelined behind it (review EDGE-R2)', async () => {
        // One socket read carrying the first page request (where a Next that ignores httpServer attaches
        // its listener, synchronously) and an upgrade: Node emits that upgrade right after the request, in
        // the same tick — before a listener moved "on the next tick" has gone anywhere.
        const s = await publicServer({ ignoresHttpServer: true });
        try {
            const before = s.connections();
            const page = 'GET /about HTTP/1.1\r\nHost: example.com\r\n\r\n';
            const r = await harness.rawExchange({ port: s.server.address().port, payload: page + harness.upgradePayload('example.com').replace('GET /ws ', 'GET /api/v1/collab/1 '), waitMs: 2000 });
            assert.match(r.data, /^HTTP\/1\.1 200 /, 'the page is answered');
            assert.strictEqual((r.data.match(/HTTP\/1\.1 \d{3}/g) || []).length, 1, 'and nothing else is');
            assert.ok(r.closed, 'the upgrade is closed');
            await settle();
            assert.strictEqual(s.next.state.upgrades, 0, 'the listener Next attached never ran');
            assert.strictEqual(s.connections(), before + 1, 'nothing re-entered the listener');
            assert.deepStrictEqual(s.server.listeners('upgrade'), [s.upgradeHandler]);
        } finally {
            await s.close();
        }
    });

    // The stand-in above restates Next's attachment rule; this pins it against the Next.js actually
    // installed (when it is: the gateway's own CI job installs only gateway/node_modules). prepare() needs a
    // production build, so the record it would leave is stood in for — the wrapper reads nothing else on
    // the request path.
    const FRONTEND = path.resolve(__dirname, '../../frontend');
    let nextEntry = null;
    try { nextEntry = require.resolve('next', { paths: [FRONTEND] }); } catch { /* not installed */ }
    it('the INSTALLED Next.js attaches to the httpServer it is given; without one, the public server moves it', { skip: nextEntry ? false : 'next is not installed in frontend/node_modules' }, async () => {
        const nextLib = require(nextEntry);
        const createNext = nextLib.default || nextLib;
        for (const giveSink of [true, false]) {
            const sink = monolith.createNextUpgradeSink();
            // giveSink: exactly as main() creates it; otherwise as it used to (no httpServer).
            const nextApp = giveSink ? monolith.createNextServer(createNext, { dev: false, dir: FRONTEND, upgrades: sink }) : createNext({ dev: false, dir: FRONTEND });
            const routed = [];
            nextApp.init = { requestHandler: (req, res) => res.end('next'), upgradeHandler: (req, socket) => { routed.push(req.url); socket.destroy(); }, server: {} };
            const warnings = [];
            const upgradeHandler = monolith.createUpgradeHandler({ edge: null, hmr: null });
            const handle = nextApp.getRequestHandler();
            const server = monolith.createPublicServer({ ssl: null, requestListener: (req, res) => handle(req, res), upgradeHandler, sink, logger: { warn: (l) => warnings.push(l) } });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const port = server.address().port;
                assert.strictEqual((await harness.request({ port, path: '/', headers: { host: 'example.com' } })).body, 'next');
                await settle();
                assert.deepStrictEqual(server.listeners('upgrade'), [upgradeHandler], `giveSink=${giveSink}`);
                assert.strictEqual(sink.listenerCount('upgrade'), 1, `giveSink=${giveSink}: Next's listener is on the sink`);
                assert.strictEqual(warnings.length, giveSink ? 0 : 1, `giveSink=${giveSink}`);
                const r = await harness.rawExchange({ port, payload: harness.upgradePayload('example.com').replace('GET /ws ', 'GET /api/v1/collab/1 '), waitMs: 2000 });
                assert.ok(r.closed);
                assert.deepStrictEqual(routed, [], 'Next\'s router never saw the upgrade');
            } finally {
                await new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
            }
        }
    });
});

describe('the monolith ACME HTTP-01 listener', () => {
    let dir;
    let server;
    let port;
    const state = { config: SITE, installed: true };
    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-acme-'));
        fs.writeFileSync(path.join(dir, 'tok-1'), 'tok-1.thumbprint');
        const provider = fakeBackend(state).hostPolicy;
        server = http.createServer(monolith.createAcmeHandler({ challengeBase: dir, port: 8443, getPolicy: () => provider.get(), isInstalled: () => state.installed }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });
    after(async () => {
        await new Promise((done) => server.close(() => done()));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const get = (host, p) => harness.request({ port, path: p, headers: host === undefined ? {} : { host } });

    it('serves challenge tokens on any address', async () => {
        const r = await get('not-yet-declared.example', '/.well-known/acme-challenge/tok-1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body, 'tok-1.thumbprint');
    });

    it('redirects to the address asked for when the site answers it, else to the main address', async () => {
        assert.strictEqual((await get('example.com', '/a?b')).headers.location, 'https://example.com:8443/a?b');
        assert.strictEqual((await get('192.168.1.11', '/a')).headers.location, 'https://192.168.1.11:8443/a');
        assert.strictEqual((await get('[::1]', '/a')).headers.location, 'https://[::1]:8443/a');
        assert.strictEqual((await get('evil.example', '/a')).headers.location, 'https://example.com:8443/a');
        assert.strictEqual((await get('www.example.com', '/a')).headers.location, 'https://example.com:8443/a');
        const r = await get('evil.example', '/a');
        assert.strictEqual(r.status, 301);
    });

    it('before install keeps the parsed host, and answers 400 when there is none', async () => {
        state.installed = false;
        try {
            assert.strictEqual((await get('evil.example', '/a')).headers.location, 'https://evil.example:8443/a');
            const { data } = await harness.rawExchange({ port, payload: 'GET /a HTTP/1.0\r\n\r\n' });
            assert.match(data, /^HTTP\/1\.1 400 /);
        } finally {
            state.installed = true;
        }
    });
});
