'use strict';
/**
 * THE EDGE ANSWERS ONLY THE SITE'S ADDRESSES — pages, static files and WebSockets included.
 *
 * Phase 1 put the address check in the backend, which only ever sees API paths: Next pages, uploads,
 * themes and WebSocket upgrades were still answered on ANY name a stranger pointed at this server. The
 * edge (src/host-edge.js) closes that at the public listener — the gateway worker here, the monolith's
 * dispatcher in monolith-edge.test.js — with the same decision the backend makes (src/host-policy.js).
 *
 * These tests drive the REAL module on real sockets, then boot the REAL gateway (src/index.js, primary
 * and workers, from a disposable copy — see support/gateway-process.js) and push a policy to it the way
 * the backend does, over mTLS. What they pin down:
 *   - an unknown address gets a static, inert 421 page (one link, no script, no form) or the API's JSON;
 *   - probes and ACME challenges stay reachable on any address, at exactly their paths (lab E1: a
 *     prefix let /health/../api/v1/settings through to Next); static trees do not;
 *   - the edge judges the address the backend would (requestAuthority: a trusted hop's X-Forwarded-Host
 *     included) and forwards exactly that address upstream (lab E3);
 *   - a redirect alias 308s to the main address and the Location can never leave it;
 *   - REDTEAM R4 at the edge: an IP literal behind a forwarding proxy is refused — except that the
 *     gateway must not count a relayed X-Forwarded-Host, which its own SSR clients send;
 *   - a repeated or malformed Host is 400, an absent one passes (HTTP/1.0 health checks);
 *   - nothing is enforced before the first push, nor without a valid main address (no lockout);
 *   - the pushed policy is validated, stored atomically, re-read by every worker on a new modification
 *     time WITHOUT a restart, and an unreadable file keeps the last good policy (REDTEAM R10);
 *   - the same policy again (the backend's periodic re-send) rewrites and logs nothing, and a gateway
 *     that lost its file is armed by the next push (lab N1 / N4);
 *   - every worker's refusals reach the primary and come back in the answer to the backend's push, for
 *     Settings → Site address (lab X2 / S9.2), each tagged as the edge's (lab R2-X2-tag);
 *   - the answer also names the addresses `own` means at this edge, for the backend (lab R2-NEW-1);
 *   - a process that holds no policy says so, rather than claiming a last good one (lab R2V-NV1);
 *   - an empty X-Forwarded-Host the edge judged host-less reaches the upstream empty (review NEW-V1),
 *     whatever the request carries and however long it waits for an upstream socket (review R3S-1);
 *   - only CN=backend may push.
 *
 * MUTATION PROOF (each was applied to the real file and watched to fail, then restored): drop the
 * edge's app.use in src/index.js; drop the handleUpgrade call; exempt '/uploads' at the edge; stop
 * collapsing leading slashes in safeLocation; count X-Forwarded-Host in the gateway; drop the R4 markers;
 * enforce with no pushed file; drop keep-last-good; drop the young-file content check; widen the push to
 * CN=frontend; answer the ACME redirect with the raw Host; exempt the probes and the ACME directory by
 * prefix again; judge Host only (ignore a trusted hop's X-Forwarded-Host); write every push; build the
 * worker's edge without the reporting tracker; let the primary ignore the workers' reports; stop
 * validating hosts in mergeRefusedHosts; let a dot segment through on an accepted address (review
 * EDGE-R1); let a re-send replace another stored set (review PL-3); leave ownAddresses out of the answer;
 * log "keeping the last good policy" with none held, or keep `held` after the file is deleted; keep the
 * Host of a request the edge judged host-less (pinForwardedHeaders, so xfwd puts it back — through
 * Expect: 100-continue and a queued request too, review R3S-1); let an empty forwarded host fall back to
 * Host in requestAuthority; record the edge's or the gate's refusals untagged; stop combining sources in the merge.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const hp = require('../src/host-policy');
const hostEdge = require('../src/host-edge');
const identity = require('../src/identity');
const harness = require('./support/gateway-process');

const silent = { info() {}, warn() {}, error() {} };

function recordingLogger() {
    const lines = { info: [], warn: [], error: [] };
    return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) };
}

const PAST = '2020-01-01T00:00:00Z';
const SITE_CONFIG = {
    siteUrl: 'https://example.com',
    siteAliases: [
        { url: 'https://www.example.com', mode: 'redirect' },
        { url: 'https://blog.example.com' },
        { url: 'https://old.example.com', expiresAt: PAST },
    ],
};

function sitePolicy(overrides) {
    const o = overrides || {};
    return hp.buildPolicy({
        config: Object.assign({}, SITE_CONFIG, o.config || {}),
        env: o.env || {},
        nodeEnv: o.nodeEnv || 'production',
        ownAddresses: () => new Set(['192.168.1.23']),
    });
}

/**
 * A listener exactly as the gateway mounts the edge: the edge first, then "the site" (which records
 * that it was reached). `state` is mutable so a test can swap the policy or the install state.
 */
async function edgeServer(state, edgeOptions) {
    const reached = [];
    const upgraded = [];
    const edge = hostEdge.createHostEdge(Object.assign({
        getPolicy: () => (typeof state.policy === 'function' ? state.policy() : state.policy),
        isInstalled: () => state.installed !== false,
        refused: state.refused || hp.createRefusedHosts(),
        logger: state.logger || silent,
    }, edgeOptions || {}));
    const server = http.createServer((req, res) => {
        if (edge.handle(req, res)) return;
        // What the gateway does next, before proxying: pin X-Forwarded-Host to the address the edge judged.
        hostEdge.pinForwardedHeaders(req);
        reached.push({ url: req.url, host: req.headers.host, xfh: req.headers['x-forwarded-host'] });
        res.setHeader('Content-Type', 'text/plain');
        res.end('site');
    });
    server.on('upgrade', (req, socket) => {
        if (edge.handleUpgrade(req, socket)) return;
        upgraded.push(req.headers.host);
        socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        reached,
        upgraded,
        get: (host, p = '/', extra = {}) => harness.request({ port: server.address().port, path: p, method: extra.method || 'GET', headers: Object.assign({ host }, extra.headers || {}) }),
        raw: (payload) => harness.rawExchange({ port: server.address().port, payload }),
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    };
}

// ─── The refusal ────────────────────────────────────────────────────────────────────────────────────

describe('an address the site does not answer', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());

    it('gets the static 421 page: no script, no form, exactly one link — to the main address', async () => {
        const r = await s.get('evil.example', '/some/page?x=1');
        assert.strictEqual(r.status, 421);
        assert.match(r.headers['content-type'], /^text\/html/);
        assert.strictEqual(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        assert.strictEqual(r.headers['cache-control'], 'no-store');
        assert.strictEqual(r.headers['x-robots-tag'], 'noindex');
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
        assert.doesNotMatch(r.body, /<script/i);
        assert.doesNotMatch(r.body, /<form|<input/i);
        const links = r.body.match(/<a\s[^>]*>/gi) || [];
        assert.deepStrictEqual(links, ['<a href="https://example.com/">'], 'one link, to the main address');
        assert.ok(!r.body.includes('evil.example'), 'the requested host is not echoed back');
        assert.strictEqual(s.reached.length, 0, 'the site was never reached');
    });

    it('on an API path gets the backend gate\'s JSON 421 — no redirect, no details', async () => {
        const r = await s.get('evil.example', '/api/v1/posts');
        assert.strictEqual(r.status, 421);
        assert.match(r.headers['content-type'], /^application\/json/);
        const body = JSON.parse(r.body);
        assert.strictEqual(body.code, 'rest_host_not_allowed');
        assert.ok(!('redirect' in body) && !('details' in body));
        assert.strictEqual(r.headers['cache-control'], 'no-store');
    });

    it('HEAD gets the 421 status and headers with no body', async () => {
        const r = await s.get('evil.example', '/', { method: 'HEAD' });
        assert.strictEqual(r.status, 421);
        assert.strictEqual(r.body, '');
    });

    it('covers static trees and uploads at the edge, but never probes or ACME challenges', async () => {
        for (const p of ['/uploads/2026/10/a.png', '/themes/default/style.css', '/public/css/wordjs-ui.css', '/plugins/x/y.js', '/favicon.ico', '/sitemap.xml', '/_next/static/chunk.js']) {
            assert.strictEqual((await s.get('evil.example', p)).status, 421, p);
        }
        for (const p of ['/healthz', '/health', '/readyz', '/metrics', '/.well-known/acme-challenge/token-1']) {
            assert.strictEqual((await s.get('evil.example', p)).status, 200, p);
        }
    });

    it('exempts the probe paths EXACTLY, and an ACME challenge only as one token — no traversal, no sub-path', async () => {
        // The exemption was a prefix test on the raw target, and the listener behind the edge resolves dot
        // segments: /health/../api/v1/settings on a foreign name reached Next, which normalised it and
        // fetched the API through its /api rewrite as Host: localhost (lab E1); /health/<anything> got
        // Next's 404 page with the site's chrome on any name.
        const before = s.reached.length;
        const refused = [
            '/health/../api/v1/settings', '/healthz/../about', '/health/%2e%2e/about', '/health/.%2E/about', '/readyz/..;/about',
            '/metrics/../api/v1/posts', '/health/x', '/healthz/', '/healthz;x', '/HEALTHZ', '//healthz', '/healthz\\..\\about',
            '/.well-known/acme-challenge', '/.well-known/acme-challenge/', '/.well-known/acme-challenge/../../api/v1/settings',
            '/.well-known/acme-challenge/a/b', '/.well-known/acme-challenge/tok.en', '/.well-known/acme-challenge/a%2e%2e',
            '/.well-known/acme-challenge/a%2Fb', '/.well-known/acme-challengeX/a',
        ];
        for (const p of refused) {
            const { data } = await s.raw(`GET ${p} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
            assert.match(data, /^HTTP\/1\.1 421 /, p);
        }
        assert.strictEqual(s.reached.length, before, 'none of them reached the site');
        for (const p of ['/healthz?full=1', '/metrics?name[]=x', '/.well-known/acme-challenge/LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0', '/.well-known/acme-challenge/a_b-C?x']) {
            assert.strictEqual((await s.get('evil.example', p)).status, 200, p);
        }
    });
});

describe('addresses the site answers', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());

    it('the main address (any case, port or trailing dot), a served alias, loopback and IP literals', async () => {
        for (const host of ['example.com', 'EXAMPLE.com:443', 'example.com.', 'blog.example.com', 'localhost:3000', '127.0.0.2', '[::1]:3000', '192.168.1.23:3000', '[2001:db8::5]']) {
            const r = await s.get(host);
            assert.strictEqual(r.status, 200, host);
            assert.strictEqual(r.body, 'site', host);
        }
    });

    it('refuses an alias once it has expired', async () => {
        assert.strictEqual((await s.get('old.example.com')).status, 421);
    });

    it('declared addresses are answered through a forwarding proxy too', async () => {
        assert.strictEqual((await s.get('example.com', '/', { headers: { 'x-forwarded-for': '203.0.113.9', via: '1.1 nginx' } })).status, 200);
    });
});

// ─── Dot segments (review EDGE-R1) ──────────────────────────────────────────────────────────────────

// Request targets a URL parser resolves into another path. The listeners route on the raw path; Next.js
// resolves it, so each of these on an accepted address reached /api through Next's own rewrite.
const DOTTED_PATHS = ['/x/../api/v1/settings', '/about/%2e%2e/api/v1/settings', '/x/.%2E/api/v1/posts', '/x/..;/about',
    '/x/./about', '/about\\..\\api\\v1\\settings', '/api/v1/../v1/settings', '/health/..', 'http://example.com/x/../api/v1/settings'];

describe('a path with a dot segment or a backslash (review EDGE-R1)', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());
    const send = (p, hostLine) => s.raw(`GET ${p} HTTP/1.1\r\n${hostLine}Connection: close\r\n\r\n`);

    it('gets 400 on every address the site answers, and never reaches the site', async () => {
        const before = s.reached.length;
        for (const host of ['example.com', 'blog.example.com', 'localhost:3000', '[::1]:3000', '192.168.1.23:3000']) {
            for (const p of DOTTED_PATHS) {
                const { data } = await send(p, `Host: ${host}\r\n`);
                assert.match(data, /^HTTP\/1\.1 400 /, `${host} ${p}`);
                assert.match(data, /"code":"rest_invalid_path"/, `${host} ${p}`);
            }
        }
        // A redirect alias serves POST and the API instead of redirecting them: those get the 400 too.
        assert.match((await s.raw('POST /x/../api/v1/settings HTTP/1.1\r\nHost: www.example.com\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')).data, /^HTTP\/1\.1 400 /);
        assert.match((await send('/api/v1/../v1/settings', 'Host: www.example.com\r\n')).data, /^HTTP\/1\.1 400 /);
        assert.strictEqual(s.reached.length, before, 'none of them reached the site');
        // Its page redirect is built by the WHATWG parser, which resolves the path itself: the browser is
        // sent to that path on the main address, where it is an ordinary request.
        const moved = await send('/x/../about', 'Host: www.example.com\r\n');
        assert.match(moved.data, /^HTTP\/1\.1 308 /);
        assert.match(moved.data, /\r\nlocation: https:\/\/example\.com\/about\r\n/i);
    });

    it('gets 400 with no Host at all (HTTP/1.0), and while nothing is enforced', async () => {
        const before = s.reached.length;
        for (const p of DOTTED_PATHS) {
            const { data } = await s.raw(`GET ${p} HTTP/1.0\r\n\r\n`);
            assert.match(data, /^HTTP\/1\.1 400 /, `no Host ${p}`);
        }
        for (const policy of [null, sitePolicy({ config: { siteUrl: 'not a url' } })]) {
            state.policy = policy;
            try {
                assert.strictEqual((await s.get('evil.example', '/page')).status, 200, 'nothing enforced');
                const { data } = await send('/x/../api/v1/settings', 'Host: evil.example\r\n');
                assert.match(data, /^HTTP\/1\.1 400 /);
            } finally {
                state.policy = sitePolicy();
            }
        }
        state.installed = false;
        try {
            assert.match((await send('/install/../api/v1/settings', 'Host: example.com\r\n')).data, /^HTTP\/1\.1 400 /);
        } finally {
            state.installed = true;
        }
        assert.strictEqual(s.reached.length, before + 2, 'only the two plain pages reached the site');
    });

    it('on an address the site does not answer is still the recorded 421', async () => {
        const refused = hp.createRefusedHosts();
        const own = await edgeServer({ policy: sitePolicy(), refused });
        try {
            const { data } = await own.raw('GET /x/../api/v1/settings HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
            assert.match(data, /^HTTP\/1\.1 421 /);
            assert.ok(refused.list().some((e) => e.host === 'evil.example'));
        } finally {
            await own.close();
        }
    });

    it('an upgrade with one gets 400 on the socket and is not upgraded', async () => {
        for (const p of ['/x/../api/v1/collab/1', '/_next/x/%2e%2e/hmr', '/ws\\..\\api']) {
            const r = await s.raw(harness.upgradePayload('example.com').replace('GET /ws ', `GET ${p} `));
            assert.match(r.data, /^HTTP\/1\.1 400 Bad Request\r\n/, p);
            assert.match(r.data, /"code":"rest_invalid_path"/, p);
            assert.ok(r.closed, p);
        }
        assert.deepStrictEqual(s.upgraded, []);
    });

    it('leaves every other path alone: dots inside a name, an encoded % or slash, a dot segment in the query', async () => {
        for (const p of ['/uploads/2026/a..b.png', '/uploads/.hidden', '/uploads/100%25%20off.png', '/.well-known/security.txt', '/plugins/x/%2fy', '/about?next=/../x']) {
            assert.strictEqual((await s.get('example.com', p)).status, 200, p);
        }
    });
});

/**
 * The split-mode chain the review drove (EDGE-R1): client → gateway edge → Next → (Next's /api rewrite)
 * → gateway edge again, from loopback → backend gate. The gateway is the real edge, pins and http-proxy
 * (xfwd, changeOrigin) as src/index.js mounts them; the backend is the REAL gate with its notice
 * callback; Next is a stand-in that does what Next 16 does with such a request: resolve the path with
 * the WHATWG parser (next/dist/shared/lib/router/utils/parse-relative-url.js) and proxy a rewritten /api
 * path as next/dist/server/lib/router-utils/proxy-request.js does — the client's headers passed on, Host
 * changed to the target, X-Forwarded-Host set to the Host Next received.
 */
describe('a dot segment cannot send a request back through Next\'s /api rewrite (review EDGE-R1)', () => {
    const httpProxy = require('http-proxy');
    const servers = [];
    const notices = [];
    const gateSaw = [];
    let gatewayPort;
    let remotePort;
    let nextPort;

    async function listen(server) {
        servers.push(server);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        return server.address().port;
    }

    before(async () => {
        const provider = hp.createPolicyProvider({ getConfig: () => SITE_CONFIG, env: {}, nodeEnv: 'production', logger: silent, ownAddresses: () => new Set() });
        const gate = hp.hostGateFactory({ getPolicy: provider.get, isInstalled: () => true, logger: silent, refused: hp.createRefusedHosts(), lastSeen: hp.createLastSeen(), onNotice: (kind) => notices.push(kind) });
        const backendPort = await listen(http.createServer((req, res) => gate(req, res, () => {
            gateSaw.push(req.url);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ who: 'backend', cls: req.siteHost && req.siteHost.cls }));
        })));

        const edge = hostEdge.createHostEdge({ getPolicy: () => sitePolicy(), logger: silent, forwardedHostIsMarker: false, refused: hp.createRefusedHosts() });
        const proxy = httpProxy.createProxyServer({ xfwd: true, changeOrigin: true });
        proxy.on('error', (e, req, res) => { res.statusCode = 502; res.end(); });
        const gatewayHandler = (req, res) => {
            if (edge.handle(req, res)) return;
            hostEdge.pinForwardedHeaders(req);
            const p = req.url.split('?')[0];
            proxy.web(req, res, { target: `http://127.0.0.1:${p === '/api' || p.startsWith('/api/') ? backendPort : nextPort}` });
        };
        gatewayPort = await listen(http.createServer(gatewayHandler));
        // The same gateway as a remote client reaches it: the socket peer is a public address.
        remotePort = await listen(http.createServer((req, res) => {
            Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
            gatewayHandler(req, res);
        }));

        nextPort = await listen(http.createServer((req, res) => {
            const pathname = new URL(`http://n${req.url}`).pathname;
            if (!pathname.startsWith('/api/')) {
                res.end('next page');
                return;
            }
            const headers = Object.assign({}, req.headers, { host: `localhost:${gatewayPort}`, 'x-forwarded-host': req.headers.host || '' });
            const out = http.request({ host: '127.0.0.1', port: gatewayPort, method: req.method, path: pathname, headers }, (up) => {
                res.writeHead(up.statusCode, up.headers);
                up.pipe(res);
            });
            out.on('error', () => { res.statusCode = 502; res.end(); });
            req.pipe(out);
        }));
    });
    after(async () => {
        for (const server of servers) await new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
    });

    it('a remote client on the main address gets 400: no loopback re-entry, no proxy-collapse notice', async () => {
        for (const p of ['/x/../api/v1/settings', '/about/%2e%2e/api/v1/settings']) {
            const { data } = await harness.rawExchange({ port: remotePort, payload: `GET ${p} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n` });
            assert.match(data, /^HTTP\/1\.1 400 /, p);
        }
        const { data } = await harness.rawExchange({ port: remotePort, payload: 'GET /x/../api/v1/settings HTTP/1.0\r\n\r\n' });
        assert.match(data, /^HTTP\/1\.1 400 /, 'nor without a Host, which the re-entry used to give one');
        assert.deepStrictEqual(gateSaw, [], 'the backend never saw them');
        assert.deepStrictEqual(notices, []);
        // The direct requests still work, and a remote client's own `Host: localhost` is no collapse (lab X3).
        assert.strictEqual(JSON.parse((await harness.request({ port: remotePort, path: '/api/v1/settings', headers: { host: 'example.com' } })).body).cls, 'canonical');
        assert.strictEqual(JSON.parse((await harness.request({ port: remotePort, path: '/api/v1/settings', headers: { host: 'localhost:3000' } })).body).cls, 'loopback');
        assert.deepStrictEqual(notices, []);
    });

    it('and the chain is real: the same request, handed to Next past the edge, is the collapse shape', async () => {
        // What the gateway used to forward for /x/../api/v1/settings on the main address (its pins applied).
        const r = await harness.request({ port: nextPort, path: '/x/../api/v1/settings', headers: { host: `127.0.0.1:${nextPort}`, 'x-forwarded-host': 'example.com', 'x-forwarded-for': '203.0.113.9' } });
        assert.strictEqual(JSON.parse(r.body).cls, 'loopback', 'the backend served it as a loopback request');
        assert.deepStrictEqual(notices, ['proxy-collapse']);
    });
});

/**
 * A local hop — a loopback peer that addressed a loopback name — that relays an EMPTY X-Forwarded-Host
 * names no address (host-policy requestAuthority). The edge judged it host-less, but http-proxy's xfwd
 * writes `X-Forwarded-Host || Host` and the backend received `localhost:3000`: loopback, a session
 * allowed, the credential check reached (review NEW-V1). The gateway here is the real edge, the real pins
 * and the REAL proxy configuration (src/proxy-config.js createProxyServer); the backend judges with
 * host-policy's own requestAuthority, behind the hop the gateway is to it (a loopback peer with a loopback
 * Host, as changeOrigin dials 127.0.0.1).
 */
describe('an empty X-Forwarded-Host from a local hop: the backend judges what the edge judged (review NEW-V1)', () => {
    const { createProxyServer } = require('../src/proxy-config');
    const servers = [];
    const edgeSaw = [];
    const backendSaw = [];
    let gatewayPort;
    let proxy;
    let queueAgent;

    before(async () => {
        const listen = async (server) => {
            servers.push(server);
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            return server.address().port;
        };
        const backendPort = await listen(http.createServer((req, res) => {
            const a = hp.requestAuthority(req, null);
            backendSaw.push({ url: req.url, absent: a.absent, raw: a.raw, xfh: req.headers['x-forwarded-host'] });
            req.resume();
            if (req.url.startsWith('/slow')) setTimeout(() => res.end('ok'), 300);
            else res.end('ok');
        }));
        const edge = hostEdge.createHostEdge({ getPolicy: () => sitePolicy(), logger: silent, forwardedHostIsMarker: false, refused: hp.createRefusedHosts() });
        proxy = createProxyServer();
        proxy.on('error', (e, req, res) => { res.statusCode = 502; res.end(); });
        // One socket at most: a second request waits for the first one's socket, the way requests queue on
        // the gateway's keep-alive agent under load (maxSockets).
        queueAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        gatewayPort = await listen(http.createServer((req, res) => {
            if (edge.handle(req, res)) return;
            edgeSaw.push(hostEdge.judgedAddress(req).raw);
            hostEdge.pinForwardedHeaders(req);
            const queued = req.url.startsWith('/slow') || req.url.startsWith('/queued');
            proxy.web(req, res, { target: `http://127.0.0.1:${backendPort}`, ...(queued ? { agent: queueAgent } : {}) });
        }));
    });
    after(async () => {
        proxy.close();
        queueAgent.destroy();
        for (const server of servers) await new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
    });

    const exchange = (head) => harness.rawExchange({ port: gatewayPort, payload: `GET /api/v1/auth/me HTTP/1.1\r\n${head}Connection: close\r\n\r\n` });

    it('host-less at the edge is host-less at the backend; every other shape is the same value on both sides', async () => {
        const cases = [
            // [request head, what both sides must judge ('' = no address)]
            ['Host: localhost:3000\r\nX-Forwarded-Host: \r\n', ''],
            ['Host: 127.0.0.1:3000\r\nX-Forwarded-Host:\r\n', ''],
            ['Host: localhost:3000\r\n', 'localhost:3000'],
            ['Host: localhost:3000\r\nX-Forwarded-Host: example.com\r\n', 'example.com'],
            ['Host: example.com\r\nX-Forwarded-Host: \r\n', 'example.com'],
        ];
        for (const [head, judged] of cases) {
            edgeSaw.length = 0;
            backendSaw.length = 0;
            const { data } = await exchange(head);
            assert.match(data, /^HTTP\/1\.1 200 /, JSON.stringify(head));
            assert.deepStrictEqual(edgeSaw, [judged], `edge: ${JSON.stringify(head)}`);
            assert.strictEqual(backendSaw.length, 1, JSON.stringify(head));
            assert.strictEqual(backendSaw[0].raw, judged, `backend: ${JSON.stringify(head)} reached it as X-Forwarded-Host ${JSON.stringify(backendSaw[0].xfh)}`);
            assert.strictEqual(backendSaw[0].absent, judged === '', JSON.stringify(head));
        }
        // HTTP/1.0 with no Host at all was already judged alike; it stays so.
        edgeSaw.length = 0;
        backendSaw.length = 0;
        const { data } = await harness.rawExchange({ port: gatewayPort, payload: 'GET /api/v1/auth/me HTTP/1.0\r\n\r\n' });
        assert.match(data, /^HTTP\/1\.1 200 /);
        assert.deepStrictEqual([edgeSaw, backendSaw.map((b) => b.absent)], [[''], [true]]);
    });

    // http-proxy emits 'proxyReq' from the outgoing request's 'socket' event, and not at all when that
    // request carries Expect; and a request queued behind a busy socket gets its socket after its headers
    // were frozen. A pin that relied on that event was skipped on demand, and failed under load: 72 of 200
    // concurrent requests reached the backend as `X-Forwarded-Host: localhost:3000` (review R3S-1).
    it('also with Expect: 100-continue, and for a request that waits for a socket (review R3S-1)', async () => {
        const emptyXfh = 'Host: localhost:3000\r\nX-Forwarded-Host: \r\n';
        for (const [label, payload] of [
            ['POST with Expect', `POST /api/v1/auth/login HTTP/1.1\r\n${emptyXfh}Expect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`],
            ['GET with Expect', `GET /api/v1/auth/me HTTP/1.1\r\n${emptyXfh}Expect: 100-continue\r\nConnection: close\r\n\r\n`],
        ]) {
            edgeSaw.length = 0;
            backendSaw.length = 0;
            const { data } = await harness.rawExchange({ port: gatewayPort, payload });
            assert.match(data, /HTTP\/1\.1 200 /, label);
            assert.deepStrictEqual(edgeSaw, [''], label);
            assert.deepStrictEqual(backendSaw.map((b) => [b.absent, b.xfh]), [[true, '']], `${label}: the backend received X-Forwarded-Host ${JSON.stringify(backendSaw.map((b) => b.xfh))}`);
        }

        edgeSaw.length = 0;
        backendSaw.length = 0;
        const slow = harness.rawExchange({ port: gatewayPort, payload: 'GET /slow HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n' });
        await harness.eventually('the slow request holds the only socket', () => backendSaw.length === 1);
        const queued = await harness.rawExchange({ port: gatewayPort, payload: `GET /queued HTTP/1.1\r\n${emptyXfh}Connection: close\r\n\r\n` });
        await slow;
        assert.match(queued.data, /^HTTP\/1\.1 200 /);
        const seen = backendSaw.find((b) => b.url === '/queued');
        assert.ok(seen, 'the queued request reached the backend');
        assert.deepStrictEqual([seen.absent, seen.xfh], [true, ''], `the queued request reached the backend as X-Forwarded-Host ${JSON.stringify(seen.xfh)}`);
    });
});

// ─── Redirect aliases ───────────────────────────────────────────────────────────────────────────────

describe('a redirect alias', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());

    it('answers GET and HEAD outside the API with a 308 to the main address, path and query kept', async () => {
        for (const method of ['GET', 'HEAD']) {
            const r = await s.get('www.example.com', '/blog/hello?ref=a%20b', { method });
            assert.strictEqual(r.status, 308, method);
            assert.strictEqual(r.headers.location, 'https://example.com/blog/hello?ref=a%20b', method);
        }
        assert.strictEqual(s.reached.length, 0);
    });

    it('serves POST and every API request instead of redirecting them', async () => {
        assert.strictEqual((await s.get('www.example.com', '/contact', { method: 'POST' })).status, 200);
        assert.strictEqual((await s.get('www.example.com', '/api/v1/posts')).status, 200);
    });

    it('never builds a Location outside the main address (//host, backslashes, absolute-form)', async () => {
        const cases = [
            ['//evil.example/x', 'https://example.com/evil.example/x'],
            ['/\\evil.example/x', 'https://example.com/evil.example/x'],
            ['///\\//evil.example', 'https://example.com/evil.example'],
            ['http://evil.example/x', 'https://example.com/'],
        ];
        for (const [target, expected] of cases) {
            const { data } = await s.raw(`GET ${target} HTTP/1.1\r\nHost: www.example.com\r\nConnection: close\r\n\r\n`);
            assert.match(data, /^HTTP\/1\.1 308 /, target);
            const location = /\r\nlocation: ([^\r]*)/i.exec(data);
            assert.ok(location, `no Location for ${target}`);
            assert.strictEqual(location[1], expected, target);
            assert.strictEqual(new URL(location[1]).origin, 'https://example.com');
        }
    });
});

describe('safeLocation', () => {
    it('keeps the origin whatever the request target', () => {
        const vectors = [
            ['https://example.com', '/a?b=1', 'https://example.com/a?b=1'],
            ['https://example.com', '//evil.example', 'https://example.com/evil.example'],
            ['https://example.com', '\\\\evil.example', 'https://example.com/'],
            ['https://example.com:8443', '/x', 'https://example.com:8443/x'],
            ['https://[::1]:3000', '/a b/é', 'https://[::1]:3000/a%20b/%C3%A9'],
            ['https://example.com', '/%2F%2Fevil.example', 'https://example.com/%2F%2Fevil.example'],
            ['https://example.com', undefined, 'https://example.com/'],
        ];
        for (const [origin, target, expected] of vectors) assert.strictEqual(hostEdge.safeLocation(origin, target), expected, String(target));
    });
});

// ─── REDTEAM R4 at the edge ─────────────────────────────────────────────────────────────────────────

describe('an IP literal behind a forwarding proxy (REDTEAM R4)', () => {
    it('is refused with the forward-Host hint, and the refusal is recorded', async () => {
        const logger = recordingLogger();
        const refused = hp.createRefusedHosts();
        const s = await edgeServer({ policy: sitePolicy(), logger, refused });
        try {
            for (const marker of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { via: '1.1 proxy' }]) {
                assert.strictEqual((await s.get('192.168.5.20:3000', '/', { headers: marker })).status, 421, JSON.stringify(marker));
            }
            assert.strictEqual(refused.list()[0].hint, 'forward-host');
            assert.ok(logger.lines.warn.some((l) => l.includes('192.168.5.20:3000') && l.includes('proxy_set_header Host $host')), logger.lines.warn.join('\n'));
            // The same address with no proxy headers is a phone on the LAN: answered.
            assert.strictEqual((await s.get('192.168.5.20:3000')).status, 200);
        } finally {
            await s.close();
        }
    });

    it('monolith: a relayed X-Forwarded-Host marks a proxy; gateway: it does not, because its SSR clients send one', async () => {
        const monolith = await edgeServer({ policy: sitePolicy() });
        const gateway = await edgeServer({ policy: sitePolicy() }, { forwardedHostIsMarker: false });
        try {
            const ssrLike = { headers: { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' } };
            assert.strictEqual((await monolith.get('10.0.0.5:3000', '/api/v1/settings', ssrLike)).status, 421);
            assert.strictEqual((await gateway.get('10.0.0.5:3000', '/api/v1/settings', ssrLike)).status, 200);
            // The gateway still refuses the real R4 shape.
            assert.strictEqual((await gateway.get('10.0.0.5:3000', '/', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 421);
        } finally {
            await monolith.close();
            await gateway.close();
        }
    });

    it('a peer inside the operator\'s address-based trustProxy is not "a proxy nobody declared"; a hop count is (R11)', async () => {
        const trusted = await edgeServer({ policy: sitePolicy({ config: { trustProxy: 'loopback' } }) });
        const hopCount = await edgeServer({ policy: sitePolicy({ config: { trustProxy: 1 } }) });
        try {
            const viaProxy = { headers: { 'x-forwarded-for': '203.0.113.9' } };
            assert.strictEqual((await trusted.get('192.168.1.23:3000', '/', viaProxy)).status, 200);
            assert.strictEqual((await hopCount.get('192.168.1.23:3000', '/', viaProxy)).status, 421);
        } finally {
            await trusted.close();
            await hopCount.close();
        }
    });
});

// ─── Which header names the host: the backend's rule at the edge (lab E3) ───────────────────────────

describe('the edge judges the address the backend would (host-policy requestAuthority)', () => {
    // The edge used to judge Host alone. Behind a proxy in trustProxy the backend reads that proxy's
    // X-Forwarded-Host when its Host is an IP, loopback or single-label name, so the two judged different
    // addresses: an IP Host let any forwarded name through the edge, and a single-label upstream was
    // refused although the backend would answer it. The client here connects from 127.0.0.1.
    const trusting = () => sitePolicy({ config: { trustProxy: '127.0.0.1' } });

    for (const [label, edgeOptions] of [['monolith', {}], ['gateway', { forwardedHostIsMarker: false }]]) {
        it(`${label}: an operator peer's X-Forwarded-Host is judged when its Host is an IP or single-label name, and pinned upstream`, async () => {
            const s = await edgeServer({ policy: trusting() }, edgeOptions);
            try {
                assert.strictEqual((await s.get('192.168.5.20:3000', '/', { headers: { 'x-forwarded-host': 'evil.example' } })).status, 421);
                assert.strictEqual((await s.get('192.168.5.20:3000', '/', { headers: { 'x-forwarded-host': '127.1' } })).status, 400);
                for (const host of ['wordjs:3000', '192.168.5.20:3000', '[fd00::5]:3000']) {
                    const r = await s.get(host, '/api/v1/posts', { headers: { 'x-forwarded-host': 'blog.example.com' } });
                    assert.strictEqual(r.status, 200, host);
                    assert.strictEqual(s.reached[s.reached.length - 1].xfh, 'blog.example.com', `${host}: the upstream gets the address judged`);
                }
                // A dotted Host is judged by itself, whatever the forwarded value (DNS rebinding on a
                // trusted network) — and that Host is what goes upstream.
                assert.strictEqual((await s.get('evil.example', '/', { headers: { 'x-forwarded-host': 'example.com' } })).status, 421);
                assert.strictEqual((await s.get('example.com', '/', { headers: { 'x-forwarded-host': 'evil.example' } })).status, 200);
                assert.strictEqual(s.reached[s.reached.length - 1].xfh, 'example.com');
            } finally {
                await s.close();
            }
        });

        it(`${label}: a loopback hop that addressed a loopback name is judged by its X-Forwarded-Host`, async () => {
            const s = await edgeServer({ policy: sitePolicy() }, edgeOptions);
            try {
                assert.strictEqual((await s.get('localhost:3000', '/', { headers: { 'x-forwarded-host': 'evil.example' } })).status, 421);
                assert.strictEqual((await s.get('127.0.0.1:3000', '/', { headers: { 'x-forwarded-host': 'blog.example.com' } })).status, 200);
                assert.strictEqual(s.reached[s.reached.length - 1].xfh, 'blog.example.com');
                assert.strictEqual((await s.get('localhost:3000', '/')).status, 200);
                assert.strictEqual(s.reached[s.reached.length - 1].xfh, 'localhost:3000');
            } finally {
                await s.close();
            }
        });
    }

    it('a peer nobody declared is judged by Host, and its own X-Forwarded-Host never goes upstream', async () => {
        const s = await edgeServer({ policy: sitePolicy() }, { forwardedHostIsMarker: false });
        try {
            assert.strictEqual((await s.get('example.com', '/', { headers: { 'x-forwarded-host': 'evil.example' } })).status, 200);
            assert.strictEqual(s.reached[s.reached.length - 1].xfh, 'example.com');
            assert.strictEqual((await s.get('evil.example', '/', { headers: { 'x-forwarded-host': 'example.com' } })).status, 421);
        } finally {
            await s.close();
        }
    });

    it('the decision and the pin agree with requestAuthority, request by request (so the two cannot drift)', () => {
        const pol = trusting();
        const edge = hostEdge.createHostEdge({ getPolicy: () => pol, logger: silent, refused: hp.createRefusedHosts() });
        const cases = [
            ['192.168.5.20:3000', 'blog.example.com', '127.0.0.1'],
            ['wordjs:3000', 'example.com', '127.0.0.1'],
            ['evil.example', 'example.com', '127.0.0.1'],
            ['localhost:3000', 'blog.example.com', '::1'],
            ['example.com', 'evil.example', '203.0.113.9'],
        ];
        for (const [host, xfh, peer] of cases) {
            const req = { url: '/', method: 'GET', headers: { host, 'x-forwarded-host': xfh }, rawHeaders: ['Host', host, 'X-Forwarded-Host', xfh], socket: { remoteAddress: peer } };
            const authority = hp.requestAuthority(req, pol);
            edge.decide(req);
            assert.deepStrictEqual(hostEdge.judgedAddress(req), { raw: authority.raw, source: authority.source }, `${host} / ${xfh} from ${peer}`);
            hostEdge.pinForwardedHeaders(req);
            assert.strictEqual(req.headers['x-forwarded-host'], authority.raw, `${host} / ${xfh} from ${peer}: pinned`);
        }
    });
});

// ─── Malformed, repeated, absent ────────────────────────────────────────────────────────────────────

describe('the Host header itself', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());

    it('two Host headers get 400 — the page form and the API JSON', async () => {
        const page = await s.raw('GET / HTTP/1.1\r\nHost: example.com\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
        assert.match(page.data, /^HTTP\/1\.1 400 /);
        const api = await s.raw('GET /api/v1/posts HTTP/1.1\r\nHost: example.com\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
        assert.match(api.data, /^HTTP\/1\.1 400 /);
        assert.match(api.data, /"code":"rest_invalid_host"/);
    });

    it('a malformed Host gets 400', async () => {
        for (const bad of ['a,b', 'localhost:1@evil.example', '127.1', 'example.com:99999', '[fe80::1%25eth0]']) {
            const { data } = await s.raw(`GET / HTTP/1.1\r\nHost: ${bad}\r\nConnection: close\r\n\r\n`);
            assert.match(data, /^HTTP\/1\.1 400 /, bad);
        }
        assert.strictEqual(s.reached.length, 0);
    });

    it('HTTP/1.0 without any Host passes (HAProxy-style health checks)', async () => {
        const { data } = await s.raw('GET / HTTP/1.0\r\n\r\n');
        assert.match(data, /^HTTP\/1\.[01] 200 /);
        assert.match(data, /site$/);
    });
});

// ─── When nothing is enforced ───────────────────────────────────────────────────────────────────────

describe('nothing is enforced', () => {
    it('before a policy exists — not even the duplicate-Host 400', async () => {
        const s = await edgeServer({ policy: null });
        try {
            assert.strictEqual((await s.get('evil.example')).status, 200);
            const { data } = await s.raw('GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\nConnection: close\r\n\r\n');
            assert.match(data, /^HTTP\/1\.1 200 /);
        } finally {
            await s.close();
        }
    });

    it('before the site is installed — the wizard is reached on any address', async () => {
        const s = await edgeServer({ policy: sitePolicy(), installed: false });
        try {
            assert.strictEqual((await s.get('evil.example', '/install')).status, 200);
        } finally {
            await s.close();
        }
    });

    it('when the main address is missing or invalid (the backend gate\'s step 6: no lockout)', async () => {
        for (const siteUrl of [undefined, 'https,https://example.com']) {
            const s = await edgeServer({ policy: sitePolicy({ config: { siteUrl } }) });
            try {
                assert.strictEqual((await s.get('evil.example')).status, 200, String(siteUrl));
            } finally {
                await s.close();
            }
        }
    });

    it('when the policy cannot be read — and that is reported once', async () => {
        const logger = recordingLogger();
        const s = await edgeServer({ policy: () => { throw new Error('boom'); }, logger });
        try {
            assert.strictEqual((await s.get('evil.example')).status, 200);
            assert.strictEqual((await s.get('evil.example')).status, 200);
            assert.strictEqual(logger.lines.error.length, 1);
        } finally {
            await s.close();
        }
    });
});

describe('refusal bookkeeping (REDTEAM R7)', () => {
    it('is bounded, and the log is rate-capped', async () => {
        const logger = recordingLogger();
        const refused = hp.createRefusedHosts({ max: 4, logsPerMinute: 2 });
        const s = await edgeServer({ policy: sitePolicy(), logger, refused });
        try {
            for (let i = 0; i < 12; i += 1) assert.strictEqual((await s.get(`n${i}.attacker.example`)).status, 421);
            assert.strictEqual(refused.list().length, 4);
            assert.strictEqual(refused.list()[0].host, 'n11.attacker.example');
            assert.strictEqual(logger.lines.warn.length, 2);
        } finally {
            await s.close();
        }
    });

    it('says who refused each host: the edge, the backend gate, or both — also through the merge (lab R2-X2-tag)', async () => {
        // The monolith's edge records into the backend's own tracker, which its gate also records into.
        const refused = hp.createRefusedHosts();
        const s = await edgeServer({ policy: sitePolicy(), refused });
        const gate = hp.hostGateFactory({ getPolicy: () => sitePolicy(), isInstalled: () => true, logger: silent, refused, lastSeen: hp.createLastSeen() });
        const throughGate = (host) => new Promise((resolve) => {
            const res = { statusCode: 200, setHeader() {}, end() { resolve(res.statusCode); } };
            gate({ url: '/api/v1/posts', method: 'GET', headers: { host }, rawHeaders: ['Host', host], socket: { remoteAddress: '203.0.113.9' } }, res, () => resolve(200));
        });
        try {
            assert.strictEqual((await s.get('edge-only.example')).status, 421);
            assert.strictEqual((await s.get('shared.example')).status, 421);
            assert.strictEqual(await throughGate('shared.example'), 421);
            assert.strictEqual(await throughGate('gate-only.example'), 421);
            const by = Object.fromEntries(refused.list().map((e) => [e.host, e.source]));
            assert.deepStrictEqual(by, { 'edge-only.example': 'edge', 'shared.example': 'both', 'gate-only.example': 'gate' });

            // A gateway's list merged with a backend's: each keeps its tag, a host in both is 'both', and an
            // unknown tag is wire input that is dropped like any other malformed entry.
            const merged = hp.mergeRefusedHosts([
                [{ host: 'a.example', count: 1, firstSeen: 1, lastSeen: 3, hint: null, source: 'gate' }, { host: 'b.example', count: 1, firstSeen: 1, lastSeen: 2, hint: null, source: 'gate' }],
                [{ host: 'a.example', count: 2, firstSeen: 1, lastSeen: 1, hint: null, source: 'edge' }, { host: 'c.example', count: 1, firstSeen: 1, lastSeen: 1, hint: null, source: 'elsewhere' },
                    { host: 'd.example', count: 1, firstSeen: 1, lastSeen: 0, hint: null }],
            ]);
            assert.deepStrictEqual(merged.map((e) => [e.host, e.count, e.source]), [['a.example', 3, 'both'], ['b.example', 1, 'gate'], ['d.example', 1, null]]);
        } finally {
            await s.close();
        }
    });
});

// ─── WebSockets ─────────────────────────────────────────────────────────────────────────────────────

describe('WebSocket upgrades', () => {
    const state = { policy: sitePolicy() };
    let s;
    before(async () => { s = await edgeServer(state); });
    after(() => s.close());

    it('to an unknown address are refused with 421 and closed; nothing is upgraded', async () => {
        const r = await s.raw(harness.upgradePayload('evil.example'));
        assert.match(r.data, /^HTTP\/1\.1 421 Misdirected Request\r\n/);
        assert.match(r.data, /"code":"rest_host_not_allowed"/);
        assert.ok(r.closed);
        assert.deepStrictEqual(s.upgraded, []);
    });

    it('with two Host headers get 400', async () => {
        const r = await s.raw(harness.upgradePayload('example.com', 'Host: evil.example\r\n'));
        assert.match(r.data, /^HTTP\/1\.1 400 Bad Request\r\n/);
        assert.deepStrictEqual(s.upgraded, []);
    });

    it('to an accepted address go through — a redirect alias included (a socket cannot follow a 308)', async () => {
        for (const host of ['example.com', 'www.example.com', '192.168.1.23:3000']) {
            const r = await s.raw(harness.upgradePayload(host));
            assert.match(r.data, /^HTTP\/1\.1 101 /, host);
        }
        assert.deepStrictEqual(s.upgraded, ['example.com', 'www.example.com', '192.168.1.23:3000']);
    });
});

// ─── The ACME listener's HTTPS redirect ─────────────────────────────────────────────────────────────

describe('acmeRedirectLocation', () => {
    const req = (host, url = '/p?q=1', headers = {}) => {
        const h = Object.assign({}, headers);
        if (host !== undefined) h.host = host;
        return { url, headers: h, rawHeaders: Object.entries(h).flat(), socket: { remoteAddress: '198.51.100.7' } };
    };
    const enforcing = { getPolicy: () => sitePolicy(), port: 8443 };

    it('keeps an address the site answers, IPv6 brackets included', () => {
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('blog.example.com'), enforcing), 'https://blog.example.com:8443/p?q=1');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('[::1]'), enforcing), 'https://[::1]:8443/p?q=1');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('192.168.1.23'), Object.assign({}, enforcing, { port: 443 })), 'https://192.168.1.23/p?q=1');
    });

    it('sends everything else to the main address — an unknown name, a redirect alias, a proxied IP, garbage', () => {
        for (const r of [req('evil.example'), req('www.example.com'), req('10.0.0.5', '/p?q=1', { 'x-forwarded-for': '203.0.113.9' }), req('a,b'), req(undefined)]) {
            assert.strictEqual(hostEdge.acmeRedirectLocation(r, enforcing), 'https://example.com:8443/p?q=1', JSON.stringify(r.headers));
        }
    });

    it('while nothing is enforced keeps the parsed host, and gives up (null → 400) on garbage', () => {
        const off = { getPolicy: () => null, port: 8443 };
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('evil.example:80'), off), 'https://evil.example:8443/p?q=1');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('[::1]:80'), off), 'https://[::1]:8443/p?q=1');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('a b'), off), null);
        assert.strictEqual(hostEdge.acmeRedirectLocation(req(undefined), off), null);
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('example.com'), { getPolicy: () => sitePolicy(), isInstalled: () => false, port: 8443 }), 'https://example.com:8443/p?q=1');
    });

    it('judges the address the edge would: a loopback hop\'s X-Forwarded-Host, never an untrusted one', () => {
        const viaLocalHop = (xfh) => ({ url: '/p', headers: { host: 'localhost', 'x-forwarded-host': xfh }, rawHeaders: ['Host', 'localhost', 'X-Forwarded-Host', xfh], socket: { remoteAddress: '127.0.0.1' } });
        assert.strictEqual(hostEdge.acmeRedirectLocation(viaLocalHop('blog.example.com'), enforcing), 'https://blog.example.com:8443/p');
        assert.strictEqual(hostEdge.acmeRedirectLocation(viaLocalHop('evil.example'), enforcing), 'https://example.com:8443/p');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('192.168.1.23', '/p', { 'x-forwarded-host': 'blog.example.com' }), enforcing), 'https://example.com:8443/p', 'an IP Host relaying a name from a peer nobody declared is R4');
    });

    it('cannot be turned into an open redirect by the request target', () => {
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('example.com', '//evil.example/x'), enforcing), 'https://example.com:8443/evil.example/x');
        assert.strictEqual(hostEdge.acmeRedirectLocation(req('example.com', 'http://evil.example/x'), enforcing), 'https://example.com:8443/');
    });
});

// ─── The pushed policy (gateway) ────────────────────────────────────────────────────────────────────

describe('sanitizePolicyPush', () => {
    it('keeps exactly the inputs of buildPolicy and drops everything else', () => {
        const r = hostEdge.sanitizePolicyPush({
            enforce: true,
            config: {
                siteUrl: 'https://example.com',
                siteAliases: ['https://a.example.com', { url: 'https://b.example.com', mode: 'redirect', signIn: false, expiresAt: null, label: 'b', source: 'admin', extra: 1 }],
                hostPolicy: { ipLiterals: 'own', ipSignIn: true, other: 'x' },
                trustProxy: ['10.0.0.0/8'],
                jwtSecret: 'must-not-be-stored',
                dbPassword: 'nor-this',
            },
            env: { WORDJS_ALLOWED_HOSTS: 'x.example', PATH: '/usr/bin', WORDJS_IP_HOSTS: 'none' },
            nodeEnv: 'production',
            gatewaySecret: 'dropped',
        });
        assert.ok(r.ok, r.error);
        assert.deepStrictEqual(r.value, {
            enforce: true,
            config: {
                siteUrl: 'https://example.com',
                siteAliases: ['https://a.example.com', { url: 'https://b.example.com', mode: 'redirect', signIn: false, label: 'b', source: 'admin' }],
                hostPolicy: { ipLiterals: 'own', ipSignIn: true },
                trustProxy: ['10.0.0.0/8'],
            },
            env: { WORDJS_ALLOWED_HOSTS: 'x.example', WORDJS_IP_HOSTS: 'none' },
            nodeEnv: 'production',
        });
        assert.deepStrictEqual(hostEdge.sanitizePolicyPush({ enforce: false }), { ok: true, value: { enforce: false, config: {}, env: {}, nodeEnv: null } });
    });

    it('refuses a wrong shape instead of guessing', () => {
        const bad = [
            null, [], 'x',
            { enforce: 'yes', config: {} },
            {},
            { config: [] },
            { config: { siteUrl: 7 } },
            { config: { siteUrl: 'https://' + 'a'.repeat(3000) + '.example' } },
            { config: { siteAliases: {} } },
            { config: { siteAliases: Array.from({ length: 257 }, () => 'https://a.example') } },
            { config: { siteAliases: [{ url: 5 }] } },
            { config: { siteAliases: [{ url: 'https://a.example', signIn: 'true' }] } },
            { config: { siteAliases: [{ url: 'https://a.example', label: 'x'.repeat(101) }] } },
            { config: { siteAliases: [42] } },
            { config: { hostPolicy: 'any' } },
            { config: { hostPolicy: { ipSignIn: 1 } } },
            { config: { trustProxy: { a: 1 } } },
            { config: {}, env: { WORDJS_ALLOWED_HOSTS: 5 } },
            { config: {}, env: 'x' },
            { config: {}, nodeEnv: 3 },
        ];
        for (const body of bad) assert.strictEqual(hostEdge.sanitizePolicyPush(body).ok, false, JSON.stringify(body).slice(0, 80));
    });
});

describe('the pushed-policy file, as a worker reads it', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-edge-')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const push = (file, body) => hostEdge.writePolicyFile(file, hostEdge.sanitizePolicyPush(body).value);

    it('enforces nothing until the first push, then follows every new version without a restart', () => {
        const file = path.join(dir, 'p1.json');
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 0, logger: silent });
        assert.strictEqual(source.get(), null);
        push(file, { config: { siteUrl: 'https://example.com' } });
        assert.strictEqual(source.get().canonical.origin, 'https://example.com');
        push(file, { config: { siteUrl: 'https://example.org' } });
        assert.strictEqual(source.get().canonical.origin, 'https://example.org');
        push(file, { enforce: false });
        assert.strictEqual(source.get(), null);
        push(file, { config: { siteUrl: 'https://example.net' } });
        assert.strictEqual(source.get().canonical.origin, 'https://example.net');
        fs.unlinkSync(file);
        assert.strictEqual(source.get(), null, 'a removed file means nothing was pushed');
        assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
    });

    it('notices a rewrite that kept the same size, inode and modification time (a coarse file-system clock)', () => {
        const file = path.join(dir, 'p2.json');
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 0, logger: silent });
        // Both versions carry the SAME whole-second modification time (what a 1 s file-system clock
        // records for two writes inside one second), written in place so the inode stays too.
        const stamp = Math.floor(Date.now() / 1000);
        const write = (mode) => {
            fs.writeFileSync(file, JSON.stringify({ format: 1, enforce: true, config: { siteUrl: 'https://example.com', hostPolicy: { ipLiterals: mode } } }));
            fs.utimesSync(file, stamp, stamp);
        };
        write('any');
        assert.strictEqual(source.get().ipLiterals, 'any');
        const first = fs.statSync(file);
        write('own'); // same length as 'any'
        const second = fs.statSync(file);
        assert.deepStrictEqual([second.mtimeMs, second.size, second.ino], [first.mtimeMs, first.size, first.ino], 'the precondition: an identical signature');
        assert.strictEqual(source.get().ipLiterals, 'own');
    });

    it('keeps the last good policy while the file is unreadable or invalid, and says so once (REDTEAM R10)', () => {
        const file = path.join(dir, 'p3.json');
        const logger = recordingLogger();
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 0, logger });
        push(file, { config: { siteUrl: 'https://example.com' } });
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        fs.writeFileSync(file, '{"format":1,"enforce":tr');
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        fs.writeFileSync(file, JSON.stringify({ enforce: 'yes' }));
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        assert.strictEqual(logger.lines.error.length, 1);
        push(file, { config: { siteUrl: 'https://example.org' } });
        assert.strictEqual(source.get().canonical.hostname, 'example.org');
    });

    it('a process that has read no policy says it holds none, never "the last good policy" (lab R2V-NV1)', () => {
        // A gateway restarted on a corrupt file: its fresh workers hold nothing, serve every page
        // unenforced until the backend's next push, and used to log that they kept the last good policy.
        const file = path.join(dir, 'p5.json');
        fs.writeFileSync(file, '{"format":1,"enforce":tr');
        const logger = recordingLogger();
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 0, logger });
        assert.strictEqual(source.get(), null, 'nothing is enforced');
        assert.strictEqual(logger.lines.error.length, 1);
        assert.doesNotMatch(logger.lines.error[0], /keeping the last good/);
        assert.match(logger.lines.error[0], /holds no host policy \(none was read since it started, or the file was deleted\): the edge enforces nothing .*backend's own gate still guards the API.*until the backend sends the site's addresses again/);

        // Once it has read one, an unreadable file keeps it, and the line says that.
        push(file, { config: { siteUrl: 'https://example.com' } });
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        fs.writeFileSync(file, 'garbage');
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        assert.strictEqual(logger.lines.error.length, 2);
        assert.match(logger.lines.error[1], /unreadable \(not JSON\); keeping the last good host policy\.$/);

        // Deleted (nothing held any more, and said so), then unreadable again: a new incident, told as it is.
        fs.unlinkSync(file);
        assert.strictEqual(source.get(), null);
        assert.strictEqual(logger.lines.error.length, 3);
        assert.match(logger.lines.error[2], /was deleted/);
        fs.writeFileSync(file, 'garbage');
        assert.strictEqual(source.get(), null);
        assert.strictEqual(logger.lines.error.length, 4);
        assert.match(logger.lines.error[3], /holds no host policy/);
    });

    it('a worker whose policy file is deleted says once that it now enforces nothing; one that never had a file says nothing (review DOC-1)', () => {
        // The docs promised this line, and deletion was silent: enforcement stopped with nothing in the log.
        const file = path.join(dir, 'p6.json');
        const logger = recordingLogger();
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 0, logger });
        assert.strictEqual(source.get(), null);
        assert.deepStrictEqual(logger.lines.error, [], 'before the first push there is nothing to report: that is the normal state');

        push(file, { config: { siteUrl: 'https://example.com' } });
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
        fs.unlinkSync(file);
        assert.strictEqual(source.get(), null, 'nothing is enforced once the file is gone');
        assert.strictEqual(source.get(), null);
        assert.strictEqual(logger.lines.error.length, 1, 'said once, not on every check');
        assert.match(logger.lines.error[0], /^\[host-edge\] p6\.json was deleted: this process now holds no host policy, and the edge enforces nothing .*backend's own gate still guards the API.*until the backend sends the site's addresses again/);

        // Back, and deleted again: a new incident.
        push(file, { config: { siteUrl: 'https://example.com' } });
        assert.ok(source.get());
        fs.unlinkSync(file);
        assert.strictEqual(source.get(), null);
        assert.strictEqual(logger.lines.error.length, 2);
    });

    it('stats the file at most once per interval', () => {
        const file = path.join(dir, 'p4.json');
        let t = 0;
        const source = hostEdge.createPushedPolicySource({ file, checkEveryMs: 1000, now: () => t, logger: silent });
        assert.strictEqual(source.get(), null);
        push(file, { config: { siteUrl: 'https://example.com' } });
        t = 999;
        assert.strictEqual(source.get(), null, 'not re-checked inside the interval');
        t = 1000;
        assert.strictEqual(source.get().canonical.hostname, 'example.com');
    });
});

describe('POST /host-policy on the internal mTLS listener', () => {
    let ca;
    let server;
    let port;
    let file;
    let dir;
    before(async () => {
        ca = harness.makeCa();
        const serverCert = harness.makeLeaf(ca, 'gateway-internal');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-push-'));
        file = path.join(dir, 'gateway-host-policy.json');
        const app = express();
        app.use(express.json());
        hostEdge.mountHostPolicyPush(app, { requireIdentity: (cns) => identity.requireIdentity(cns, silent), file, logger: silent });
        server = https.createServer({ key: serverCert.key, cert: serverCert.cert, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });
    after(async () => {
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('accepts CN=backend and stores exactly the validated inputs', async () => {
        const r = await harness.pushPolicy({ internalPort: port, ca, identity: harness.makeLeaf(ca, 'backend'), body: { config: { siteUrl: 'https://example.com', jwtSecret: 'x' }, env: { WORDJS_IP_HOSTS: 'own' } } });
        assert.strictEqual(r.status, 200, r.body);
        // ownAddresses: what `own` answers at this edge — this machine's interfaces, as the workers read them.
        assert.deepStrictEqual(JSON.parse(r.body), { success: true, enforce: true, canonical: 'https://example.com', warnings: [], stored: 'written', refused: [], ownAddresses: [...hp.ownAddresses()].sort().slice(0, 64) });
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(stored.config.siteUrl, 'https://example.com');
        assert.ok(!('jwtSecret' in stored.config));
        assert.strictEqual(hostEdge.createPushedPolicySource({ file, checkEveryMs: 0 }).get().ipLiterals, 'own');
    });

    it('answers a missing or invalid main address with canonical:null and the warning', async () => {
        const r = await harness.pushPolicy({ internalPort: port, ca, identity: harness.makeLeaf(ca, 'backend'), body: { config: { siteUrl: 'https,https://example.com' } } });
        assert.strictEqual(r.status, 200);
        const body = JSON.parse(r.body);
        assert.strictEqual(body.canonical, null);
        assert.ok(body.warnings.some((w) => w.includes('siteUrl')));
    });

    it('reports the addresses its edge treats as its own, bounded, so the backend judges `own` the same way (lab R2-NEW-1)', async () => {
        // A gateway on another machine than the backend (separate mode): `own` at its edge is ITS
        // interfaces. The answer carries exactly the set policyFromPush is given, sorted, at most 64.
        const own = new Set(['192.0.2.10', '[2001:db8::5]', ...Array.from({ length: 80 }, (_, i) => `198.51.100.${i + 1}`)]);
        const app = express();
        app.use(express.json());
        const pushFile = path.join(dir, 'own.json');
        hostEdge.mountHostPolicyPush(app, { requireIdentity: (cns) => identity.requireIdentity(cns, silent), file: pushFile, logger: silent, ownAddresses: () => own });
        const serverCert = harness.makeLeaf(ca, 'gateway-internal');
        const other = https.createServer({ key: serverCert.key, cert: serverCert.cert, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, app);
        await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
        try {
            const r = await harness.pushPolicy({ internalPort: other.address().port, ca, identity: harness.makeLeaf(ca, 'backend'), body: { config: { siteUrl: 'https://example.com', hostPolicy: { ipLiterals: 'own' } } } });
            assert.strictEqual(r.status, 200, r.body);
            const reported = JSON.parse(r.body).ownAddresses;
            assert.deepStrictEqual(reported, [...own].sort().slice(0, 64));
            // The same set the edge judges `own` with, when it is handed the same reader.
            const edge = hostEdge.createPushedPolicySource({ file: pushFile, checkEveryMs: 0, ownAddresses: () => own }).get();
            for (const ip of reported) assert.strictEqual(hp.classify(hp.parseHost(ip), edge).cls, 'ip', ip);
            assert.strictEqual(hp.classify(hp.parseHost('203.0.113.9'), edge).cls, 'unknown');
        } finally {
            await new Promise((resolve) => { other.closeAllConnections?.(); other.close(() => resolve()); });
        }
    });

    it('reports an empty list, never none, when it cannot read its addresses: no list now means a gateway too old to send one (review R3S-5)', async () => {
        // The backend drops its last report on an answer without `ownAddresses`, since that is how a gateway
        // from before the report answers. A current gateway that could not read its interfaces answers
        // under `own` with no IP at its edge (createOwnAddresses reads a failed enumeration so), and says so.
        const app = express();
        app.use(express.json());
        hostEdge.mountHostPolicyPush(app, { requireIdentity: (cns) => identity.requireIdentity(cns, silent), file: path.join(dir, 'own-failed.json'), logger: silent, ownAddresses: () => { throw new Error('EPERM'); } });
        const serverCert = harness.makeLeaf(ca, 'gateway-internal');
        const other = https.createServer({ key: serverCert.key, cert: serverCert.cert, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, app);
        await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
        try {
            const r = await harness.pushPolicy({ internalPort: other.address().port, ca, identity: harness.makeLeaf(ca, 'backend'), body: { config: { siteUrl: 'https://example.com' } } });
            assert.strictEqual(r.status, 200, r.body);
            assert.deepStrictEqual(JSON.parse(r.body).ownAddresses, []);
        } finally {
            await new Promise((resolve) => { other.closeAllConnections?.(); other.close(() => resolve()); });
        }
    });

    it('refuses every other identity and every malformed body, storing nothing', async () => {
        const before = fs.readFileSync(file, 'utf8');
        for (const cn of ['frontend', 'gateway', 'gateway-internal']) {
            const r = await harness.pushPolicy({ internalPort: port, ca, identity: harness.makeLeaf(ca, cn), body: { config: { siteUrl: 'https://evil.example' } } });
            assert.strictEqual(r.status, 403, cn);
        }
        const bad = await harness.pushPolicy({ internalPort: port, ca, identity: harness.makeLeaf(ca, 'backend'), body: { enforce: 'no' } });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    });
});

describe('POST /host-policy is idempotent, and answers with what the edge refused', () => {
    let ca;
    let server;
    let port;
    let file;
    let dir;
    let logger;
    const aggregate = hostEdge.createRefusalAggregate();
    before(async () => {
        ca = harness.makeCa();
        const serverCert = harness.makeLeaf(ca, 'gateway-internal');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-push-idem-'));
        file = path.join(dir, 'gateway-host-policy.json');
        logger = recordingLogger();
        const app = express();
        app.use(express.json());
        hostEdge.mountHostPolicyPush(app, { requireIdentity: (cns) => identity.requireIdentity(cns, silent), file, logger, refusals: () => aggregate.list() });
        server = https.createServer({ key: serverCert.key, cert: serverCert.cert, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });
    after(async () => {
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const push = async (body) => {
        const r = await harness.pushPolicy({ internalPort: port, ca, identity: harness.makeLeaf(ca, 'backend'), body });
        assert.strictEqual(r.status, 200, r.body || String(r.error));
        return JSON.parse(r.body);
    };
    const SET_A = { config: { siteUrl: 'https://example.com', siteAliases: [{ url: 'https://www.example.com', mode: 'redirect' }], hostPolicy: { ipLiterals: 'own' } }, env: { WORDJS_ALLOWED_HOSTS: 'cms.example.com' }, nodeEnv: 'production' };

    it('the same set again (the backend\'s periodic re-send) rewrites nothing and logs nothing; another set is written', async () => {
        assert.strictEqual((await push(SET_A)).stored, 'written');
        const text = fs.readFileSync(file, 'utf8');
        const mtime = fs.statSync(file).mtimeMs;
        const logged = logger.lines.info.length;
        await harness.sleep(30);
        for (let i = 0; i < 3; i += 1) {
            const again = await push(JSON.parse(JSON.stringify(SET_A)));
            assert.strictEqual(again.stored, 'unchanged');
            assert.strictEqual(again.canonical, 'https://example.com', 'it still answers like a push');
        }
        assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'byte for byte (receivedAt included): the workers have nothing to re-read');
        assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
        assert.strictEqual(logger.lines.info.length, logged, 'a periodic re-send is not news');

        const other = await push({ ...SET_A, config: { ...SET_A.config, hostPolicy: { ipLiterals: 'any' } } });
        assert.strictEqual(other.stored, 'written');
        assert.strictEqual(hostEdge.createPushedPolicySource({ file, checkEveryMs: 0 }).get().ipLiterals, 'any');
        assert.strictEqual(logger.lines.info.length, logged + 1);
    });

    it('a stored file that is gone or broken is written again (a restarted gateway without its policy is re-armed)', async () => {
        await push(SET_A);
        fs.unlinkSync(file);
        assert.strictEqual((await push(SET_A)).stored, 'written');
        assert.strictEqual(hostEdge.createPushedPolicySource({ file, checkEveryMs: 0 }).get().canonical.origin, 'https://example.com');
        fs.writeFileSync(file, '{"format":1,"enforce":tr');
        assert.strictEqual((await push(SET_A)).stored, 'written');
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).config.siteUrl, 'https://example.com');
    });

    it('a re-send only arms: it never replaces another valid set, so two backends that disagree cannot flip the edge (review PL-3)', async () => {
        // Backend 1 declares www.example.com, backend 2 does not; each re-sends its own set every half minute.
        const one = SET_A;
        const two = { ...SET_A, config: { ...SET_A.config, siteAliases: [] } };
        await push(one); // what backend 1 sent at its boot: the stored set
        const text = fs.readFileSync(file, 'utf8');
        const logged = logger.lines.info.length;
        const stored = [];
        for (let i = 0; i < 6; i += 1) stored.push((await push({ ...(i % 2 ? one : two), onlyIfMissing: true })).stored);
        assert.deepStrictEqual(stored, ['kept', 'unchanged', 'kept', 'unchanged', 'kept', 'unchanged']);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the stored set stayed put');
        assert.strictEqual(logger.lines.info.length, logged, 'and nothing was announced');
        assert.ok(hostEdge.createPushedPolicySource({ file, checkEveryMs: 0 }).get().aliases.has('www.example.com'));
        // With nothing (valid) stored, a re-send arms the gateway; a push without the flag — a change, a
        // boot — replaces the set, as it always did.
        fs.unlinkSync(file);
        assert.strictEqual((await push({ ...two, onlyIfMissing: true })).stored, 'written');
        fs.writeFileSync(file, '{"format":1,"enforce":tr');
        assert.strictEqual((await push({ ...one, onlyIfMissing: true })).stored, 'written');
        assert.strictEqual((await push(two)).stored, 'written');
        assert.ok(!hostEdge.createPushedPolicySource({ file, checkEveryMs: 0 }).get().aliases.has('www.example.com'));
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).onlyIfMissing, undefined, 'the flag is never stored');
    });

    it('answers with every worker\'s refusals merged — validated, bounded, most recent first', async () => {
        aggregate.update(1, [
            { host: 'evil.example', count: 2, firstSeen: 100, lastSeen: 200, hint: null, source: 'edge' },
            { host: '<img src=x>', count: 1, firstSeen: 1, lastSeen: 1, hint: null, source: 'edge' },
            { host: 'Upper.Example', count: 1, firstSeen: 1, lastSeen: 1, hint: null, source: 'edge' },
            { host: 'zero.example', count: 0, firstSeen: 1, lastSeen: 1, hint: null, source: 'edge' },
            { host: 'hint.example', count: 1, firstSeen: 1, lastSeen: 1, hint: 'bogus', source: 'edge' },
            { host: 'source.example', count: 1, firstSeen: 1, lastSeen: 1, hint: null, source: 'somewhere' },
        ]);
        aggregate.update(2, [
            { host: 'evil.example', count: 3, firstSeen: 50, lastSeen: 300, hint: 'www-apex', source: 'edge' },
            { host: 'wordjs_upstream', count: 1, firstSeen: 150, lastSeen: 250, hint: 'forward-host', source: 'edge' },
        ]);
        const answer = await push(SET_A);
        assert.deepStrictEqual(answer.refused, [
            { host: 'evil.example', count: 5, firstSeen: 50, lastSeen: 300, hint: 'www-apex', source: 'edge' },
            { host: 'wordjs_upstream', count: 1, firstSeen: 150, lastSeen: 250, hint: 'forward-host', source: 'edge' },
        ]);
    });
});

describe('what the gateway\'s workers refused, on its way to the backend', () => {
    it('a worker reports its list to the primary only after a new refusal, at most once per interval', () => {
        const sent = [];
        const refused = hostEdge.createReportingRefusals({ send: (m) => sent.push(m), everyMs: 60000 });
        try {
            refused.flush();
            assert.deepStrictEqual(sent, [], 'nothing refused yet: nothing sent');
            assert.strictEqual(refused.record('a.example', null), true, 'the tracker\'s own log throttle still answers');
            refused.record('a.example', null);
            refused.record('b.example', 'tunnel');
            refused.flush();
            assert.strictEqual(sent.length, 1, 'three refusals, one message');
            assert.strictEqual(sent[0].type, hostEdge.REFUSALS_MESSAGE);
            assert.deepStrictEqual(sent[0].refused.map((e) => [e.host, e.count, e.hint]), [['b.example', 1, 'tunnel'], ['a.example', 2, null]]);
            refused.flush();
            assert.strictEqual(sent.length, 1, 'no new refusal: nothing sent');
        } finally {
            refused.stop();
        }
    });

    it('sends on its own timer, and a primary that is gone does not throw into the request', async () => {
        const sent = [];
        const refused = hostEdge.createReportingRefusals({ send: (m) => sent.push(m), everyMs: 20 });
        const broken = hostEdge.createReportingRefusals({ send: () => { throw new Error('channel closed'); }, everyMs: 20 });
        try {
            refused.record('c.example', null);
            broken.record('c.example', null);
            await harness.eventually('the timer flushed', async () => sent.length === 1, 2000);
            await harness.sleep(60);
            assert.strictEqual(sent.length, 1);
        } finally {
            refused.stop();
            broken.stop();
        }
    });

    it('the primary merges the workers, keeps an exited worker\'s counts, and stays bounded', () => {
        const agg = hostEdge.createRefusalAggregate({ max: 3 });
        agg.update(1, [{ host: 'x.example', count: 4, firstSeen: 10, lastSeen: 40, hint: null }]);
        agg.update(2, [{ host: 'x.example', count: 1, firstSeen: 20, lastSeen: 50, hint: null }]);
        assert.deepStrictEqual(agg.list().map((e) => [e.host, e.count]), [['x.example', 5]]);
        agg.update(1, [{ host: 'x.example', count: 6, firstSeen: 10, lastSeen: 60, hint: null }]);
        assert.deepStrictEqual(agg.list().map((e) => [e.host, e.count]), [['x.example', 7]], 'a report replaces that worker\'s previous one');
        agg.remove(1);
        agg.update(3, []);
        assert.deepStrictEqual(agg.list().map((e) => [e.host, e.count]), [['x.example', 7]], 'a respawn does not make counts go backwards');
        agg.update(4, ['a', 'b', 'c', 'd'].map((n, i) => ({ host: `${n}.example`, count: 1, firstSeen: 100 + i, lastSeen: 100 + i, hint: null })));
        assert.deepStrictEqual(agg.list().map((e) => e.host), ['d.example', 'c.example', 'b.example']);
        agg.update(5, 'not a list');
        assert.strictEqual(agg.list().length, 3);
    });
});

// ─── The real gateway ───────────────────────────────────────────────────────────────────────────────

describe('the real gateway (src/index.js, primary + workers)', () => {
    let frontend;
    let backend;
    let ca;
    let gw;
    const POLICY = { config: { siteUrl: 'https://example.com', siteAliases: [{ url: 'https://www.example.com', mode: 'redirect' }] }, nodeEnv: 'production' };

    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        ca = harness.makeCa();
        gw = await harness.bootGateway({ acme: true, upstreams: { frontend: frontend.port, backend: backend.port }, cluster: ca });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    const get = (host, p = '/', headers = {}) => harness.request({ port: gw.port, path: p, headers: Object.assign({ host }, headers) });

    it('enforces nothing before the first push (enforce:false)', async () => {
        const r = await get('evil.example', '/page');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(JSON.parse(r.body).upstream, 'frontend');
    });

    it('applies a push in the RUNNING workers, without restarting them', async () => {
        const r = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: POLICY });
        assert.strictEqual(r.status, 200, r.body || String(r.error));
        // The answer names the addresses `own` means at this edge — the gateway machine's interfaces, the
        // set the workers judge with — for the backend's gate and session check (lab R2-NEW-1).
        assert.deepStrictEqual(JSON.parse(r.body).ownAddresses, [...hp.addressesFromInterfaces(os.networkInterfaces())].sort().slice(0, 64));
        await harness.eventually('every worker refuses evil.example', async () => {
            for (let i = 0; i < 8; i += 1) if ((await get('evil.example', '/page')).status !== 421) return false;
            return true;
        });
        assert.doesNotMatch(gw.output(), /Reloading workers|Respawning/);
    });

    it('then answers pages, API, redirect aliases and WebSockets by address', async () => {
        const page = await get('evil.example', '/page');
        assert.strictEqual(page.status, 421);
        assert.match(page.body, /<a href="https:\/\/example\.com\/">/);
        const api = await get('evil.example', '/api/v1/posts');
        assert.strictEqual(api.status, 421);
        assert.strictEqual(JSON.parse(api.body).code, 'rest_host_not_allowed');
        assert.strictEqual(JSON.parse((await get('example.com', '/page')).body).upstream, 'frontend');
        assert.strictEqual(JSON.parse((await get('example.com', '/api/v1/posts')).body).upstream, 'backend');
        const moved = await get('www.example.com', '/a?b=1');
        assert.strictEqual(moved.status, 308);
        assert.strictEqual(moved.headers.location, 'https://example.com/a?b=1');
        assert.strictEqual((await get('127.0.0.1')).status, 200);
        assert.strictEqual((await get('healthz.attacker.example', '/healthz')).status, 200);
        // R4 at the edge, and the SSR shape it must not catch (a frontend node addressing the gateway by IP).
        assert.strictEqual((await get('10.0.0.5:3000', '/', { 'x-forwarded-for': '203.0.113.9' })).status, 421);
        assert.strictEqual((await get('10.0.0.5:3000', '/api/v1/settings', { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' })).status, 200);
        const dup = await harness.rawExchange({ port: gw.port, payload: 'GET / HTTP/1.1\r\nHost: example.com\r\nHost: evil.example\r\nConnection: close\r\n\r\n' });
        assert.match(dup.data, /^HTTP\/1\.1 400 /);

        const before = frontend.upgrades.length;
        const ws = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('evil.example') });
        assert.match(ws.data, /^HTTP\/1\.1 421 /);
        assert.strictEqual(frontend.upgrades.length, before, 'the refused upgrade never reached the upstream');
        const ok = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('example.com') });
        assert.match(ok.data, /^HTTP\/1\.1 101 /);
    });

    it('exempts the probe paths exactly: a sub-path or traversal under one is judged (lab E1)', async () => {
        const seen = () => frontend.requests.length + backend.requests.length;
        const before = seen();
        for (const p of ['/health/x', '/health/../api/v1/settings', '/healthz/../about', '/health/%2e%2e/about', '/.well-known/acme-challenge/../../api/v1/posts']) {
            const { data } = await harness.rawExchange({ port: gw.port, payload: `GET ${p} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n` });
            assert.match(data, /^HTTP\/1\.1 421 /, p);
        }
        assert.strictEqual(seen(), before, 'no upstream saw any of them');
        assert.strictEqual((await get('evil.example', '/healthz')).status, 200);
        for (const p of ['/health', '/readyz', '/metrics', '/.well-known/acme-challenge/tok-1']) assert.notStrictEqual((await get('evil.example', p)).status, 421, p);
    });

    it('answers a dot segment with 400 on the main address too — pages, API and upgrades (review EDGE-R1)', async () => {
        const seen = () => frontend.requests.length + backend.requests.length + frontend.upgrades.length + backend.upgrades.length;
        const before = seen();
        for (const p of ['/x/../api/v1/settings', '/about/%2e%2e/api/v1/posts', '/api/v1/../v1/settings', '/x\\..\\api\\v1\\settings']) {
            const { data } = await harness.rawExchange({ port: gw.port, payload: `GET ${p} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n` });
            assert.match(data, /^HTTP\/1\.1 400 /, p);
        }
        const ws = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('example.com').replace('GET /ws ', 'GET /x/../api/v1/collab/1 ') });
        assert.match(ws.data, /^HTTP\/1\.1 400 /);
        assert.strictEqual(seen(), before, 'no upstream saw any of them');
    });

    it('forwards a local hop\'s EMPTY X-Forwarded-Host as empty, never as that hop\'s own loopback Host (review NEW-V1)', async () => {
        const before = backend.requests.length;
        const { data } = await harness.rawExchange({ port: gw.port, payload: 'GET /api/v1/auth/me HTTP/1.1\r\nHost: localhost:3000\r\nX-Forwarded-Host: \r\nConnection: close\r\n\r\n' });
        assert.match(data, /^HTTP\/1\.1 200 /);
        assert.strictEqual(backend.requests.length, before + 1);
        assert.strictEqual(backend.requests[before].headers['x-forwarded-host'], '', 'host-less at the edge, host-less at the backend');
        // Without the empty header, the loopback Host is the address, on both sides.
        assert.strictEqual(JSON.parse((await get('localhost:3000', '/api/v1/auth/me')).body).headers['x-forwarded-host'], 'localhost:3000');
    });

    it('judges a trusted proxy\'s X-Forwarded-Host by the backend\'s rule, and forwards what it judged (lab E3)', async () => {
        const trusting = { config: Object.assign({}, POLICY.config, { trustProxy: '127.0.0.1' }), nodeEnv: 'production' };
        const pushed = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: trusting });
        assert.strictEqual(pushed.status, 200, pushed.body || String(pushed.error));
        try {
            await harness.eventually('every worker trusts the proxy', async () => {
                for (let i = 0; i < 8; i += 1) if ((await get('10.0.0.5:3000', '/page', { 'x-forwarded-host': 'evil.example' })).status !== 421) return false;
                return true;
            });
            const ok = await get('wordjs:3000', '/api/v1/posts', { 'x-forwarded-host': 'example.com' });
            assert.strictEqual(ok.status, 200);
            assert.strictEqual(JSON.parse(ok.body).headers['x-forwarded-host'], 'example.com', 'the backend is sent the address the edge judged');
            assert.strictEqual((await get('evil.example', '/page', { 'x-forwarded-host': 'example.com' })).status, 421);
        } finally {
            await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: POLICY });
            await harness.eventually('every worker is back on the plain policy', async () => {
                for (let i = 0; i < 8; i += 1) if ((await get('10.0.0.5:3000', '/page', { 'x-forwarded-host': 'evil.example' })).status !== 200) return false;
                return true;
            });
        }
    });

    it('answers the backend\'s next push with what every worker\'s edge refused (lab X2 / S9.2)', async () => {
        const host = `x2-${process.pid}-${Date.now()}.example`;
        for (let i = 0; i < 6; i += 1) assert.strictEqual((await get(host, i % 2 ? '/api/v1/posts' : '/page')).status, 421);
        let answer = null;
        await harness.eventually('the workers\' refusals reach the primary', async () => {
            const r = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: POLICY });
            answer = JSON.parse(r.body);
            const entry = answer.refused.find((e) => e.host === host);
            return Boolean(entry && entry.count === 6);
        });
        assert.strictEqual(answer.stored, 'unchanged', 'the same policy again: nothing was rewritten');
        assert.ok(answer.refused.length <= 32);
        assert.ok(answer.refused.some((e) => e.host === 'evil.example'), 'the earlier refusals are there too');
    });

    it('a gateway without its stored policy enforces nothing until the next push, which arms it again (lab N1 / N4)', async () => {
        const file = path.join(gw.dir, 'gateway-host-policy.json');
        const mtime = fs.statSync(file).mtimeMs;
        const same = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: POLICY });
        assert.strictEqual(JSON.parse(same.body).stored, 'unchanged');
        assert.strictEqual(fs.statSync(file).mtimeMs, mtime, 'an unchanged push is not written');

        fs.unlinkSync(file); // what a new container, or the documented reinstall step, leaves
        await harness.eventually('every worker answers evil.example again', async () => {
            for (let i = 0; i < 8; i += 1) if ((await get('evil.example', '/page')).status !== 200) return false;
            return true;
        });
        const rearm = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: POLICY });
        assert.strictEqual(JSON.parse(rearm.body).stored, 'written');
        await harness.eventually('every worker refuses evil.example again', async () => {
            for (let i = 0; i < 8; i += 1) if ((await get('evil.example', '/page')).status !== 421) return false;
            return true;
        });
    });

    it('its ACME listener redirects to an address the site answers, never to a raw Host', async () => {
        const unknown = await harness.request({ port: gw.acmePort, path: '/x?y=1', headers: { host: 'evil.example' } });
        assert.strictEqual(unknown.status, 301);
        assert.strictEqual(unknown.headers.location, `https://example.com:${gw.port}/x?y=1`);
        const loopback = await harness.request({ port: gw.acmePort, path: '/x', headers: { host: '[::1]' } });
        assert.strictEqual(loopback.headers.location, `https://[::1]:${gw.port}/x`);
    });

    it('refuses a push from CN=frontend, and an enforce:false push turns the edge off again', async () => {
        const denied = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'frontend'), body: { enforce: false } });
        assert.strictEqual(denied.status, 403);
        await harness.sleep(1200);
        assert.strictEqual((await get('evil.example', '/page')).status, 421, 'the refused push changed nothing');

        const off = await harness.pushPolicy({ internalPort: gw.internalPort, ca, identity: harness.makeLeaf(ca, 'backend'), body: { enforce: false } });
        assert.strictEqual(off.status, 200);
        await harness.eventually('every worker answers evil.example again', async () => {
            for (let i = 0; i < 8; i += 1) if ((await get('evil.example', '/page')).status !== 200) return false;
            return true;
        });
    });
});
