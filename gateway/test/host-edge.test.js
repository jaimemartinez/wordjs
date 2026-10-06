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
 *   - probes and ACME challenges stay reachable on any address; static trees do not;
 *   - a redirect alias 308s to the main address and the Location can never leave it;
 *   - REDTEAM R4 at the edge: an IP literal behind a forwarding proxy is refused — except that the
 *     gateway must not count a relayed X-Forwarded-Host, which its own SSR clients send;
 *   - a repeated or malformed Host is 400, an absent one passes (HTTP/1.0 health checks);
 *   - nothing is enforced before the first push, nor without a valid main address (no lockout);
 *   - the pushed policy is validated, stored atomically, re-read by every worker on a new modification
 *     time WITHOUT a restart, and an unreadable file keeps the last good policy (REDTEAM R10);
 *   - only CN=backend may push.
 *
 * MUTATION PROOF (each was applied to the real file and watched to fail, then restored): drop the
 * edge's app.use in src/index.js; drop the handleUpgrade call; exempt '/uploads' at the edge; stop
 * collapsing leading slashes in safeLocation; count X-Forwarded-Host in the gateway; drop the R4 markers;
 * enforce with no pushed file; drop keep-last-good; drop the young-file content check; widen the push to
 * CN=frontend; answer the ACME redirect with the raw Host.
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
        reached.push({ url: req.url, host: req.headers.host });
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
        assert.deepStrictEqual(JSON.parse(r.body), { success: true, enforce: true, canonical: 'https://example.com', warnings: [] });
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
