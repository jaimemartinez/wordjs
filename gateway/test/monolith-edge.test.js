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
 * createAcmeHandler and createMonolithEdge, exported for exactly this — on real sockets, with stand-ins
 * only for the two things a unit test cannot boot (the backend Express app and Next). The policy comes
 * from a real host-policy provider published as `backendApp.hostPolicy`, which is how the backend hands
 * the monolith the policy its own gate applies.
 *
 * The order inside the dispatcher is part of the contract and is tested as such: the edge runs BEFORE
 * the forwarded-header pins (they overwrite a proxy's X-Forwarded-Host, one of the REDTEAM R4 signals)
 * and BEFORE the SEO rewrites (so /sitemap.xml on a foreign name is judged as the page it is).
 *
 * MUTATION PROOF (each applied to monolith.js, watched to fail, restored): move the edge call after the
 * pins; move it after the SEO rewrites; drop it from the dispatcher; drop it from the upgrade handler;
 * answer the ACME redirect with the raw Host; stop passing the backend's install state.
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
    const app = (req, res) => {
        // `scheme` is what the backend itself derives from the request it receives (host-policy
        // trustedScheme with its own policy): the value its Secure-cookie and sign-in rules read.
        seen.push({ url: req.url, xfh: req.headers['x-forwarded-host'], xfp: req.headers['x-forwarded-proto'], scheme: hp.trustedScheme(req, app.hostPolicy.get()) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ who: 'backend', url: req.url }));
    };
    app.hostPolicy = hp.createPolicyProvider({ getConfig: () => state.config, env: {}, nodeEnv: 'production', logger: silent, ownAddresses: () => new Set() });
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

async function monolithServer(state, { proto = 'https' } = {}) {
    const backendApp = fakeBackend(state);
    const handle = fakeNext();
    const upgraded = [];
    const refused = hp.createRefusedHosts();
    const edge = monolith.createMonolithEdge({ backendApp, isInstalled: () => state.installed !== false, refused, logger: silent });
    const server = http.createServer(monolith.createDispatch({ backendApp, handle, proto, edge }));
    server.on('upgrade', monolith.createUpgradeHandler({
        edge,
        upgrade: (req, socket) => {
            upgraded.push(req.headers.host);
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        },
    }));
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
        assert.strictEqual(last.xfh, 'example.com');
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
            assert.strictEqual(last.xfh, 'www.example.com');
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

    it('hands an accepted upgrade to Next, and destroys one for a backend path', async () => {
        assert.match((await m.raw(harness.upgradePayload('example.com'))).data, /^HTTP\/1\.1 101 /);
        assert.deepStrictEqual(m.upgraded, ['example.com']);
        const backendPath = await m.raw(harness.upgradePayload('example.com').replace('GET /ws ', 'GET /api/v1/ws '));
        assert.strictEqual(backendPath.data, '');
        assert.deepStrictEqual(m.upgraded, ['example.com']);
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
