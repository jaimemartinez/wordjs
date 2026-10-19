'use strict';
/**
 * The WebSocket upgrade cap behind a proxy the gateway does not trust, and query values in the debug
 * "Proxying" line.
 *
 *  1. With no trusted proxy, the upgrade cap keys on the socket peer, so a CDN or reverse proxy in front
 *     made the whole site one 120/min bucket. The cap now gives each (peer, forwarded client) pair the
 *     per-client budget and widens the peer's total with the number of distinct forwarded clients behind
 *     it, up to upgradeSharedMultiplier × the cap — a forger gains at most that multiplier.
 *  2. The gateway says so, once, naming trustProxy / WORDJS_TRUST_PROXY, for a remote proxy as well as a
 *     proxy on this machine; and it logs its trust posture at boot.
 *  3. The debug "Proxying" line redacts query values, as the access log does.
 *
 * Tests 1 and 3 also run against the REAL gateway process (support/gateway-process.js).
 *
 * MUTATION PROOF: make allow() ignore its `forwarded` argument — the shared-peer unit test and the live
 * 16-visitor test fail (some upgrades 429); log req.url instead of redactUrl(req.url) in src/index.js —
 * the live debug-line test fails on the token.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createUpgradeLimiter } = require('../src/rate-limit');
const settings = require('../src/runtime-settings');
const harness = require('./support/gateway-process');

test('upgrade cap: visitors behind one untrusted peer each get the per-client budget, bounded in total', () => {
    const shared = [];
    const lim = createUpgradeLimiter({ rateLimit: { upgradeMax: 2, upgradeSharedMultiplier: 5 } }, {
        onShared: (peer, n) => shared.push([peer, n]),
        sharedThreshold: 3,
    });
    const peer = '203.0.113.10';
    // Four visitors behind the same proxy: each may reconnect twice.
    for (const v of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
        assert.strictEqual(lim.allow(peer, v), true, `${v} first`);
        assert.strictEqual(lim.allow(peer, v), true, `${v} second`);
        assert.strictEqual(lim.allow(peer, v), false, `${v} past its own cap`);
    }
    assert.deepStrictEqual(shared, [[peer, 3]], 'reported once, when the peer crossed the threshold');

    // A forger rotating the header gains at most the multiplier: 5 distinct × 2 = 10 in total.
    const forger = createUpgradeLimiter({ rateLimit: { upgradeMax: 2, upgradeSharedMultiplier: 5 } });
    let ok = 0;
    for (let i = 0; i < 200; i++) if (forger.allow('192.0.2.66', `10.9.${i >> 8}.${i & 255}`)) ok++;
    assert.strictEqual(ok, 10);

    // No forwarded client: exactly the old per-address cap.
    const direct = createUpgradeLimiter({ rateLimit: { upgradeMax: 2 } });
    assert.deepStrictEqual([1, 2, 3].map(() => direct.allow('192.0.2.1')), [true, true, false]);
    // A trusted proxy's resolved client is the key: two visitors, two budgets.
    assert.deepStrictEqual([direct.allow('198.51.100.9'), direct.allow('198.51.100.9'), direct.allow('198.51.100.8')], [true, true, true]);
});

test('untrusted-proxy warning: a remote peer carrying many distinct clients is reported once', () => {
    const lines = [];
    const warn = settings.createUntrustedProxyWarning(false, { warn: (m) => lines.push(m) }, { distinctThreshold: 3 });
    const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    warn(req('203.0.113.9', '198.51.100.1'));
    warn(req('203.0.113.9', '198.51.100.1'));
    warn(req('203.0.113.9', '198.51.100.2'));
    warn(req('203.0.113.7', '198.51.100.3')); // another peer: counted separately
    assert.strictEqual(lines.length, 0, 'two distinct clients is not a proxy yet');
    warn(req('203.0.113.9', '198.51.100.3'));
    warn(req('203.0.113.9', '198.51.100.4'));
    assert.strictEqual(lines.length, 1, 'once');
    assert.match(lines[0], /203\.0\.113\.9/);
    assert.match(lines[0], /trustProxy/);
    assert.match(lines[0], /WORDJS_TRUST_PROXY/);

    const viaLimiter = [];
    const w2 = settings.createUntrustedProxyWarning(false, { warn: (m) => viaLimiter.push(m) });
    w2.sharedAddress('203.0.113.5', 7);
    w2.sharedAddress('203.0.113.5', 9);
    assert.strictEqual(viaLimiter.length, 1);

    const trusted = settings.createUntrustedProxyWarning('loopback', { warn: () => assert.fail('trusted: nothing to say') });
    trusted.sharedAddress('203.0.113.5', 7);
});

test('the boot line states the trust posture and how to change it', () => {
    assert.match(settings.trustProxyBootLine(false), /WORDJS_TRUST_PROXY/);
    assert.match(settings.trustProxyBootLine('loopback'), /Trusted proxy: "loopback"/);
});

test('the real gateway: 16 visitors behind one untrusted proxy all get their WebSocket', async (t) => {
    const frontend = await harness.startEchoUpstream('frontend');
    const backend = await harness.startEchoUpstream('backend');
    t.after(async () => { await frontend.close(); await backend.close(); });
    const gw = await harness.bootGateway({
        upstreams: { frontend: frontend.port, backend: backend.port },
        extraConfig: { rateLimit: { upgradeMax: 1, upgradeWindowMs: 60000 } },
        env: { WORDJS_TRUST_PROXY: '' },
    });
    t.after(() => gw.stop());

    const answers = [];
    for (let i = 0; i < 16; i++) {
        const r = await harness.rawExchange({
            port: gw.port,
            payload: harness.upgradePayload('localhost', `X-Forwarded-For: 198.51.100.${i + 1}\r\n`, '/_next/hmr'),
        });
        answers.push(String(r.data).split('\r\n')[0]);
    }
    assert.ok(answers.every((l) => /^HTTP\/1\.1 101 /.test(l)), `every visitor's upgrade completes: ${JSON.stringify(answers)}`);

    // One visitor reconnecting in a loop is still capped (per worker, so send more than workers × cap).
    const same = [];
    for (let i = 0; i < 12; i++) {
        const r = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', 'X-Forwarded-For: 198.51.100.200\r\n', '/_next/hmr') });
        same.push(String(r.data).split('\r\n')[0]);
    }
    assert.ok(same.some((l) => /^HTTP\/1\.1 429 /.test(l)), `one visitor past the cap is refused: ${JSON.stringify(same)}`);
    await harness.eventually('the untrusted-proxy warning', () => /no proxy is trusted/.test(gw.output()));
    assert.match(gw.output(), /No proxy is trusted: each connection's socket address is the client/, 'boot line');
});

test('the real gateway: the debug "Proxying" line carries no query value', async (t) => {
    const frontend = await harness.startEchoUpstream('frontend');
    const backend = await harness.startEchoUpstream('backend');
    t.after(async () => { await frontend.close(); await backend.close(); });
    const gw = await harness.bootGateway({
        upstreams: { frontend: frontend.port, backend: backend.port },
        env: { LOG_LEVEL: 'debug', WORDJS_TRUST_PROXY: '' },
    });
    t.after(() => gw.stop());

    const secret = 'tok3n-' + Date.now();
    const r = await harness.request({ port: gw.port, path: `/reset-password?token=${secret}&email=a%40b.c`, headers: { Host: 'localhost' } });
    assert.strictEqual(r.status, 200, r.body);
    await harness.eventually('a debug "Proxying" line', () => /Proxying GET \/reset-password\?token=\[redacted\]&email=\[redacted\]/.test(gw.output()));
    assert.ok(!gw.output().includes(secret), 'the token never reaches the log');
});
