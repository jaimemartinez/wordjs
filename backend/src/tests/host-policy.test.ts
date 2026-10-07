/**
 * WordJS — core/host-policy: the one parser, classifier and gate that decide which addresses this site
 * answers (SPEC §2, REDTEAM R4/R7/R10/R11).
 *
 * Three layers, each driving the REAL module:
 *   1. contracts/host-policy-vectors.v1.json — the shared conformance table. The gateway's twin runs the
 *      very same file (gateway/test/host-policy-parity.test.js), so a grammar change that is not made in
 *      both places, or not written down here first, fails somewhere.
 *   2. Unit behaviour that a table cannot express: caching, memoisation, bounded state, warnings.
 *   3. The gate mounted in a real Express app, reached over real sockets — including the raw-socket
 *      shapes (duplicate Host, HTTP/1.0 with no Host) that supertest cannot produce.
 *
 * It also carries the cases of the retired development stop-gap (core/dev-hosts.ts): a phone on the LAN
 * opening the dev server by this machine's IP, and WORDJS_DEV_ORIGINS honoured in development only.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('node:net');
const http = require('http');
const express = require('express');
const request = require('supertest');

const hp = require('../core/host-policy');

const VECTORS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../contracts/host-policy-vectors.v1.json'), 'utf8'));
// The instant every classify vector is judged at, unless the vector names its own.
const VECTOR_NOW = Date.parse('2026-10-06T00:00:00Z');

type Captured = { warn: string[]; error: string[] };
function captureLogger(): { logger: { warn: (m: string) => void; error: (m: string) => void }; lines: Captured } {
    const lines: Captured = { warn: [], error: [] };
    return { logger: { warn: (m: string) => lines.warn.push(m), error: (m: string) => lines.error.push(m) }, lines };
}

/** A request-shaped object for the pure derivation functions, built from a vector's `req`. */
function fakeReq(v: any): any {
    const headers: Record<string, string> = { ...(v.headers || {}) };
    const rawHeaders: string[] = [];
    for (const [name, value] of Object.entries(headers)) rawHeaders.push(name, String(value));
    return {
        headers,
        rawHeaders,
        socket: {
            remoteAddress: v.remoteAddress,
            authorized: v.authorized === true,
            encrypted: v.encrypted === true,
            getPeerCertificate: () => (v.peerCN ? { subject: { CN: v.peerCN } } : {}),
        },
    };
}

function vectorPolicy(name: string): any {
    const spec = VECTORS.policies[name];
    assert.ok(spec, `unknown vector policy ${name}`);
    return hp.buildPolicy({ config: spec.config, env: spec.env, nodeEnv: spec.nodeEnv, ownAddresses: () => new Set(spec.ownAddresses) });
}

// ─── 1. The shared vectors ──────────────────────────────────────────────────────────────────────────

describe('vectors: parseHost', () => {
    test('accepts and normalises', () => {
        for (const v of VECTORS.parseHost.accept) {
            assert.deepStrictEqual(hp.parseHost(v.in), { hostname: v.hostname, port: v.port, kind: v.kind }, `parseHost(${JSON.stringify(v.in)})`);
        }
    });
    test('rejects', () => {
        for (const v of VECTORS.parseHost.reject) {
            assert.strictEqual(hp.parseHost(v.in), null, `parseHost(${JSON.stringify(v.in)}) must be null: ${v.why}`);
        }
    });
    test('serialize is the inverse of parseHost', () => {
        for (const v of VECTORS.parseHost.accept) {
            const p = hp.parseHost(v.in);
            assert.deepStrictEqual(hp.parseHost(hp.serialize(p)), p, `round trip of ${JSON.stringify(v.in)}`);
        }
    });
    test('non-string input is refused, never coerced', () => {
        for (const v of [undefined, null, 42, ['example.com'], { toString: () => 'example.com' }]) assert.strictEqual(hp.parseHost(v), null);
    });
    test('an over-long value is refused before any parsing', () => {
        assert.strictEqual(hp.parseHost('a'.repeat(262)), null);
    });
});

describe('vectors: parseSiteUrl', () => {
    test('accepts and normalises', () => {
        for (const v of VECTORS.parseSiteUrl.accept) {
            assert.deepStrictEqual(
                hp.parseSiteUrl(v.in),
                { origin: v.origin, scheme: v.scheme, hostname: v.hostname, port: v.port, kind: v.kind },
                `parseSiteUrl(${JSON.stringify(v.in)})`,
            );
        }
    });
    test('rejects', () => {
        for (const v of VECTORS.parseSiteUrl.reject) {
            assert.strictEqual(hp.parseSiteUrl(v.in), null, `parseSiteUrl(${JSON.stringify(v.in)}) must be null: ${v.why}`);
        }
    });
});

describe('vectors: ownAddresses', () => {
    test('non-internal, non-link-local IPv4 and IPv6 (string or numeric family), bracketed IPv6', () => {
        const got = [...hp.addressesFromInterfaces(VECTORS.ownAddresses.interfaces)].sort();
        assert.deepStrictEqual(got, [...VECTORS.ownAddresses.expect].sort());
    });
});

describe('vectors: compileTrustProxy (R11)', () => {
    test('only address-based settings compile, and they test the peer correctly', () => {
        for (const v of VECTORS.compileTrustProxy) {
            const isTrusted = hp.compileTrustProxy(v.setting);
            assert.strictEqual(isTrusted !== null, v.compiles, `compileTrustProxy(${JSON.stringify(v.setting)}) ${v.why || ''}`);
            for (const [peer, expected] of Object.entries(v.peers || {})) {
                assert.strictEqual(isTrusted(peer), expected, `${JSON.stringify(v.setting)} trusts ${peer}?`);
            }
        }
    });
});

describe('vectors: policy entries', () => {
    test('sign-in defaults, risk, scheme and expiry of declared addresses (R2, R12)', () => {
        for (const v of VECTORS.policyEntries) {
            const entry = vectorPolicy(v.policy)[v.table].get(v.hostname);
            assert.ok(entry, `${v.policy}.${v.table} has ${v.hostname}`);
            for (const [field, expected] of Object.entries(v.expect)) {
                assert.deepStrictEqual(entry[field], expected, `${v.policy}.${v.table}[${v.hostname}].${field} ${v.why || ''}`);
            }
        }
    });
});

describe('vectors: classify', () => {
    test('every class and every precedence rule', () => {
        for (const v of VECTORS.classify) {
            const p = hp.parseHost(v.host);
            assert.ok(p, `vector host ${v.host} parses`);
            const now = v.now ? Date.parse(v.now) : VECTOR_NOW;
            const verdict = hp.classify(p, vectorPolicy(v.policy), { proxied: v.proxied === true, now });
            assert.strictEqual(verdict.cls, v.cls, `${v.policy}: ${v.host}${v.proxied ? ' (proxied)' : ''} ${v.why || ''}`);
            if (v.reason) assert.strictEqual(verdict.reason, v.reason, `${v.policy}: ${v.host} reason`);
        }
    });
});

describe('vectors: requestAuthority', () => {
    test('which header names the host, and whether the request was proxied', () => {
        for (const v of VECTORS.requestAuthority) {
            const got = hp.requestAuthority(fakeReq(v.req), { trustProxy: v.trustProxy });
            const e = v.expect;
            if ('host' in e) assert.strictEqual(got.parsed ? hp.serialize(got.parsed) : null, e.host, `${v.name}: host`);
            if ('absent' in e) assert.strictEqual(got.absent, e.absent, `${v.name}: absent`);
            if ('raw' in e) assert.strictEqual(got.raw, e.raw, `${v.name}: raw`);
            if ('hop' in e) assert.strictEqual(got.hop, e.hop, `${v.name}: hop`);
            if ('hop' in e) assert.strictEqual(got.viaTrustedHop, e.hop !== null, `${v.name}: viaTrustedHop`);
            if ('source' in e) assert.strictEqual(got.source, e.source, `${v.name}: source`);
            if ('proxied' in e) assert.strictEqual(got.proxied, e.proxied, `${v.name}: proxied`);
            assert.strictEqual(hp.requestHost(fakeReq(v.req), { trustProxy: v.trustProxy }), got.parsed ? hp.serialize(got.parsed) : undefined, `${v.name}: requestHost`);
        }
    });
});

describe('vectors: trustedScheme', () => {
    test('X-Forwarded-Proto only from a trusted hop, and only http or https', () => {
        for (const v of VECTORS.trustedScheme) {
            assert.strictEqual(hp.trustedScheme(fakeReq(v.req), { trustProxy: v.trustProxy }), v.expect, v.name);
        }
    });
});

describe('vectors: ambiguousPath', () => {
    test('paths a later parser could read as another path are never exempt (lab E1)', () => {
        for (const v of VECTORS.ambiguousPath.ambiguous) assert.strictEqual(hp.isAmbiguousPath(v.in), true, `${v.in}: ${v.why}`);
        for (const v of VECTORS.ambiguousPath.plain) assert.strictEqual(hp.isAmbiguousPath(v.in), false, `${v.in}: ${v.why}`);
    });
});

describe('vectors: dotSegments', () => {
    test('what a URL parser resolves into another path (the edge answers 400: review EDGE-R1)', () => {
        for (const v of VECTORS.dotSegments.dotted) assert.strictEqual(hp.hasDotSegments(v.in), true, `${v.in}: ${v.why}`);
        for (const v of VECTORS.dotSegments.plain) assert.strictEqual(hp.hasDotSegments(v.in), false, `${v.in}: ${v.why}`);
        for (const v of VECTORS.dotSegments.dotted) assert.strictEqual(hp.isAmbiguousPath(v.in), true, v.in);
    });
});

// ─── 2. Unit behaviour ──────────────────────────────────────────────────────────────────────────────

describe('ownAddresses', () => {
    test('the live list never contains loopback or link-local addresses', () => {
        const own = hp.ownAddresses();
        assert.ok(own instanceof Set);
        for (const address of own) {
            const p = hp.parseHost(address);
            assert.ok(p && p.kind !== 'dns', `${address} is an IP literal in Host form`);
            assert.ok(!hp.isLoopbackAuthority(p), `${address} is not loopback`);
            assert.ok(!address.startsWith('169.254.') && !/^\[fe[89ab]/.test(address), `${address} is not link-local`);
        }
    });
    test('cached for 5 s, then re-read (a DHCP renewal is picked up without a restart)', () => {
        let clock = 1_000;
        let reads = 0;
        let ip = '192.168.1.11';
        const own = hp.createOwnAddresses({
            now: () => clock,
            networkInterfaces: () => { reads += 1; return { eth0: [{ address: ip, family: 'IPv4', internal: false }] }; },
        });
        assert.deepStrictEqual([...own()], ['192.168.1.11']);
        ip = '192.168.1.99';
        clock += 4_999;
        assert.deepStrictEqual([...own()], ['192.168.1.11']);
        assert.strictEqual(reads, 1);
        clock += 1;
        assert.deepStrictEqual([...own()], ['192.168.1.99']);
        assert.strictEqual(reads, 2);
    });
    test('a caller cannot corrupt the cache, and a failing enumeration means no addresses', () => {
        const own = hp.createOwnAddresses({ networkInterfaces: () => ({ eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] }) });
        own().add('203.0.113.1');
        assert.deepStrictEqual([...own()], ['10.0.0.5']);
        const broken = hp.createOwnAddresses({ networkInterfaces: () => { throw new Error('EPERM'); } });
        assert.strictEqual(broken().size, 0);
    });
});

describe('isLoopbackIp / isLoopbackAuthority', () => {
    test('socket peers, including the IPv4-mapped spellings (R15)', () => {
        for (const a of ['127.0.0.1', '127.255.0.9', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::ffff:7f00:1']) assert.strictEqual(hp.isLoopbackIp(a), true, a);
        for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '::2', 'localhost', '', undefined, null, 'fe80::1%lo0']) assert.strictEqual(hp.isLoopbackIp(a), false, String(a));
    });
    test('authorities', () => {
        for (const h of ['localhost', 'localhost:3000', '127.0.0.1', '127.9.9.9:80', '[::1]', '[::ffff:127.0.0.1]']) assert.strictEqual(hp.isLoopbackAuthority(hp.parseHost(h)), true, h);
        for (const h of ['localhost.example', 'app.localhost', '128.0.0.1', '[::2]', '[::ffff:10.0.0.1]']) assert.strictEqual(hp.isLoopbackAuthority(hp.parseHost(h)), false, h);
        assert.strictEqual(hp.isLoopbackAuthority(null), false);
    });
});

describe('buildPolicy', () => {
    test('canonical: missing and invalid are distinguished and never guessed', () => {
        assert.strictEqual(hp.buildPolicy({ config: {} }).canonicalError, 'missing');
        assert.strictEqual(hp.buildPolicy({ config: null }).canonical, null);
        const salvaged = hp.buildPolicy({ config: { siteUrl: 'https,https://example.com' } });
        assert.strictEqual(salvaged.canonical, null);
        assert.strictEqual(salvaged.canonicalError, 'invalid');
        assert.match(salvaged.warnings.join('\n'), /siteUrl .* is not a valid site address/);
        assert.strictEqual(hp.buildPolicy({ config: { siteUrl: 42 } }).canonicalError, 'invalid');
        assert.deepStrictEqual(
            { ...hp.buildPolicy({ config: { siteUrl: 'HTTPS://Example.com:443/' } }).canonical },
            { origin: 'https://example.com', scheme: 'https', hostname: 'example.com', port: null, kind: 'dns' },
        );
    });
    test('defaults: any IP literal, no ip sign-in, production, no dev origins', () => {
        const pol = hp.buildPolicy({ config: { siteUrl: 'https://example.com' } });
        assert.strictEqual(pol.ipLiterals, 'any');
        assert.strictEqual(pol.ipLiteralsSource, 'default');
        assert.strictEqual(pol.ipSignIn, false);
        assert.strictEqual(pol.dev, false);
        assert.strictEqual(pol.trustProxy, null);
        assert.deepStrictEqual(pol.warnings, []);
        assert.strictEqual(pol.ownAddresses, hp.ownAddresses, 'the shared cached reader by default');
        assert.ok(Object.isFrozen(pol));
    });
    test('hostPolicy and WORDJS_IP_HOSTS', () => {
        const fromConfig = hp.buildPolicy({ config: { siteUrl: 'https://e.com', hostPolicy: { ipLiterals: 'own', ipSignIn: true } } });
        assert.strictEqual(fromConfig.ipLiterals, 'own');
        assert.strictEqual(fromConfig.ipLiteralsSource, 'config');
        assert.strictEqual(fromConfig.ipSignIn, true);
        const fromEnv = hp.buildPolicy({ config: { siteUrl: 'https://e.com', hostPolicy: { ipLiterals: 'own' } }, env: { WORDJS_IP_HOSTS: ' None ' } });
        assert.strictEqual(fromEnv.ipLiterals, 'none');
        assert.strictEqual(fromEnv.ipLiteralsSource, 'env');
        const bad = hp.buildPolicy({ config: { siteUrl: 'https://e.com', hostPolicy: { ipLiterals: 'some' } }, env: { WORDJS_IP_HOSTS: 'all' } });
        assert.strictEqual(bad.ipLiterals, 'any');
        assert.strictEqual(bad.warnings.length, 2);
        assert.strictEqual(hp.buildPolicy({ config: { siteUrl: 'https://e.com', hostPolicy: { ipSignIn: 'yes' } } }).ipSignIn, false, 'only a real true opts in');
    });
    test('aliases: a bad entry is left out with a warning, never guessed at', () => {
        const pol = hp.buildPolicy({
            config: {
                siteUrl: 'https://example.com',
                siteAliases: [
                    'https://string-form.example',
                    { url: 'https://x/path' },
                    { url: 'https://www.example.com' },
                    { url: 'https://WWW.example.com' },
                    { url: 'https://example.com' },
                    { url: 'https://when.example', expiresAt: 'next tuesday' },
                    { url: 'https://numeric-expiry.example', expiresAt: 1791763200000 },
                    { url: 'https://odd-mode.example', mode: 'proxy' },
                    42,
                    null,
                ],
            },
        });
        assert.deepStrictEqual([...pol.aliases.keys()].sort(), ['odd-mode.example', 'string-form.example', 'www.example.com']);
        assert.strictEqual(pol.aliases.get('odd-mode.example').mode, 'serve');
        const text = pol.warnings.join('\n');
        assert.match(text, /siteAliases\[1\]: "https:\/\/x\/path" is not a valid site address/);
        assert.match(text, /siteAliases\[3\]: www\.example\.com is listed twice/);
        assert.match(text, /siteAliases\[4\]: example\.com is the main address already/);
        assert.match(text, /siteAliases\[5\]: when\.example has an unreadable expiresAt; ignored/, 'fail closed on an unreadable lifetime');
        assert.match(text, /siteAliases\[6\]: numeric-expiry\.example has an unreadable expiresAt/);
        assert.match(text, /unknown mode "proxy"/);
        assert.match(text, /siteAliases\[8\] is not an address entry/);
        assert.match(text, /siteAliases\[9\] is not an address entry/);
        assert.match(hp.buildPolicy({ config: { siteUrl: 'https://e.com', siteAliases: 'https://www.e.com' } }).warnings[0], /siteAliases is not a list/);
    });
    test('a hostile config value is quoted and truncated in warnings', () => {
        const pol = hp.buildPolicy({ config: { siteUrl: 'https://e.com', siteAliases: [{ url: 'x'.repeat(5000) }] } });
        assert.ok(pol.warnings[0].length < 300);
    });
    test('WORDJS_ALLOWED_HOSTS: hosts and URLs; invalid entries warned and skipped', () => {
        const pol = hp.buildPolicy({ config: { siteUrl: 'https://e.com' }, env: { WORDJS_ALLOWED_HOSTS: 'a.example:8080, https://b.example, *.c.example, , A.example' } });
        assert.deepStrictEqual([...pol.envHosts.keys()].sort(), ['a.example', 'b.example']);
        assert.strictEqual(pol.envHosts.get('a.example').port, 8080);
        assert.strictEqual(pol.envHosts.get('b.example').scheme, 'https');
        assert.match(pol.warnings.join('\n'), /WORDJS_ALLOWED_HOSTS: "\*\.c\.example" is not a host/);
    });
    test('WORDJS_DEV_ORIGINS: parsed always, .local and wildcards warned', () => {
        const pol = hp.buildPolicy({ config: { siteUrl: 'http://localhost:3000' }, env: { WORDJS_DEV_ORIGINS: 'Mi-PC.local,*.lan' }, nodeEnv: 'development' });
        assert.deepStrictEqual([...pol.devOrigins], ['mi-pc.local']);
        const text = pol.warnings.join('\n');
        assert.match(text, /mi-pc\.local is a \.local name; anyone on your LAN can claim it/);
        assert.match(text, /"\*\.lan" is not a host name \(wildcards are not supported\)/);
    });
    test('trustProxy: the config wins over WORDJS_TRUST_PROXY; a non-address setting is reported (R11)', () => {
        assert.strictEqual(hp.buildPolicy({ config: { trustProxy: 'loopback' }, env: { WORDJS_TRUST_PROXY: '10.0.0.0/8' } }).trustProxy, 'loopback');
        assert.strictEqual(hp.buildPolicy({ config: {}, env: { WORDJS_TRUST_PROXY: '10.0.0.0/8' } }).trustProxy, '10.0.0.0/8');
        const hops = hp.buildPolicy({ config: { trustProxy: 1 } });
        assert.match(hops.warnings.join('\n'), /trustProxy 1 is not address-based/);
        for (const nothing of [false, 0, 'false', '0']) {
            assert.deepStrictEqual(hp.buildPolicy({ config: { trustProxy: nothing } }).warnings, [], `${JSON.stringify(nothing)} is the explicit "trust nothing"`);
        }
    });
});

describe('createPolicyProvider (memo on the config object, R10)', () => {
    function provider(state: { config: any }, env: Record<string, string | undefined> = {}) {
        const { logger, lines } = captureLogger();
        return { p: hp.createPolicyProvider({ getConfig: () => state.config, env, nodeEnv: 'production', logger }), lines };
    }
    test('the same config object returns the same policy; a new object rebuilds it', () => {
        const state = { config: { siteUrl: 'https://a.example' } };
        const { p } = provider(state);
        const first = p.get();
        assert.strictEqual(p.get(), first);
        state.config = { siteUrl: 'https://b.example' };
        assert.strictEqual(p.get().canonical.hostname, 'b.example');
    });
    test('a change in the environment rebuilds it', () => {
        const state = { config: { siteUrl: 'https://a.example' } };
        const env: Record<string, string | undefined> = {};
        const { p } = provider(state, env);
        const first = p.get();
        env.WORDJS_ALLOWED_HOSTS = 'b.example';
        const second = p.get();
        assert.notStrictEqual(second, first);
        assert.ok(second.envHosts.has('b.example'));
    });
    test('R10: an unreadable config keeps the last good policy instead of dropping the canonical', () => {
        const state: { config: any } = { config: { siteUrl: 'https://a.example', siteAliases: ['https://www.a.example'] } };
        const { p } = provider(state);
        const good = p.get();
        state.config = null; // configManager.getConfig() during a half-written file
        assert.strictEqual(p.get(), good);
        assert.strictEqual(p.get().canonical.hostname, 'a.example');
        p.invalidate();
        assert.strictEqual(p.get(), good, 'invalidate() does not override R10 either');
    });
    test('before any good config, a missing file builds the empty policy', () => {
        const { p } = provider({ config: null });
        assert.strictEqual(p.get().canonical, null);
    });
    test('invalidate() forces a rebuild for the same config object', () => {
        const state = { config: { siteUrl: 'https://a.example' } };
        const { p } = provider(state);
        const first = p.get();
        p.invalidate();
        assert.notStrictEqual(p.get(), first);
    });
    test('a throwing getConfig is treated as unreadable', () => {
        let fail = false;
        const p = hp.createPolicyProvider({ getConfig: () => { if (fail) throw new Error('EBUSY'); return { siteUrl: 'https://a.example' }; }, env: {} });
        const good = p.get();
        fail = true;
        assert.strictEqual(p.get(), good);
    });
    test('each warning is logged once, not on every rebuild', () => {
        const state = { config: { siteUrl: 'not a url' } };
        const { p, lines } = provider(state);
        p.get();
        state.config = { siteUrl: 'not a url' };
        p.get();
        assert.strictEqual(lines.warn.length, 1);
        assert.match(lines.warn[0], /^\[host-policy\] siteUrl/);
    });
    test('getConfig is required', () => {
        assert.throws(() => hp.createPolicyProvider({}), /getConfig/);
    });
});

describe('refusal hints', () => {
    const pol = hp.buildPolicy({ config: { siteUrl: 'https://example.com' } });
    const hint = (h: string, reason?: string) => hp.refusalHint(hp.parseHost(h), pol, reason);
    test('each hint', () => {
        assert.strictEqual(hint('wordjs_upstream'), 'forward-host');
        assert.strictEqual(hint('backend'), 'forward-host');
        assert.strictEqual(hint('a_b.example'), 'forward-host');
        assert.strictEqual(hint('ab12.ngrok-free.app'), 'tunnel');
        assert.strictEqual(hint('x.trycloudflare.com'), 'tunnel');
        assert.strictEqual(hint('www.example.com'), 'www-apex');
        assert.strictEqual(hint('printer.local'), 'local');
        assert.strictEqual(hint('192.168.1.5', 'proxied-ip'), 'forward-host');
        assert.strictEqual(hint('192.168.1.5', 'ip-not-own'), null);
        assert.strictEqual(hint('evil.example'), null);
        const apexPol = hp.buildPolicy({ config: { siteUrl: 'https://www.example.com' } });
        assert.strictEqual(hp.refusalHint(hp.parseHost('example.com'), apexPol), 'www-apex');
        for (const code of ['forward-host', 'tunnel', 'www-apex', 'local']) assert.ok(hp.REFUSAL_HINTS[code], code);
    });
    test('tunnel and .local detection are suffix matches on label boundaries', () => {
        assert.strictEqual(hp.isTunnelHost('ngrok.io'), true);
        assert.strictEqual(hp.isTunnelHost('a.loca.lt'), true);
        assert.strictEqual(hp.isTunnelHost('notloca.lt'), false);
        assert.strictEqual(hp.isLanName('a.local'), true);
        assert.strictEqual(hp.isLanName('a.localhost'), false);
        assert.strictEqual(hp.isLanName('notlocal'), false);
    });
});

describe('createRefusedHosts (R7)', () => {
    test('bounded to the newest `max` hosts, most recent first, counted', () => {
        let clock = 0;
        const r = hp.createRefusedHosts({ max: 32, now: () => ++clock });
        for (let i = 0; i < 10_000; i++) r.record(`h${i}.example`, null);
        r.record('h9990.example', 'tunnel');
        const list = r.list();
        assert.strictEqual(list.length, 32);
        assert.strictEqual(list[0].host, 'h9990.example');
        assert.strictEqual(list[0].count, 2);
        assert.strictEqual(list[0].hint, 'tunnel');
        assert.ok(!list.some((e: any) => e.host === 'h0.example'));
        assert.ok(!('lastLoggedAt' in list[0]), 'the throttle state is not exposed');
    });
    test('one log line per host per minute', () => {
        let clock = 0;
        const r = hp.createRefusedHosts({ now: () => clock });
        assert.strictEqual(r.record('a.example', null), true);
        clock = 59_999;
        assert.strictEqual(r.record('a.example', null), false);
        clock = 60_000;
        assert.strictEqual(r.record('a.example', null), true);
    });
    test('at most 10 log lines per minute overall, however many hosts', () => {
        let clock = 0;
        const r = hp.createRefusedHosts({ now: () => clock });
        let logged = 0;
        for (let i = 0; i < 500; i++) if (r.record(`h${i}.example`, null)) logged += 1;
        assert.strictEqual(logged, 10);
        clock = 60_000;
        assert.strictEqual(r.record('fresh.example', null), true, 'the window reopens after a minute');
    });
    test('clear()', () => {
        const r = hp.createRefusedHosts();
        r.record('a.example', null);
        r.clear();
        assert.deepStrictEqual(r.list(), []);
    });
    test('clear() forgets the log throttle too', () => {
        const r = hp.createRefusedHosts({ now: () => 1000 });
        for (let i = 0; i < 20; i++) r.record(`h${i}.example`, null);
        assert.strictEqual(r.record('late.example', null), false, 'the window is spent');
        r.clear();
        assert.strictEqual(r.record('late.example', null), true, 'after clear() the next refusal is logged');
    });
    test('each entry says who refused it — the edge, the gate, or both — and the merge keeps and combines that (lab R2-X2-tag)', () => {
        let clock = 0;
        const r = hp.createRefusedHosts({ now: () => ++clock });
        r.record('edge.example', null, 'edge');
        r.record('gate.example', null, 'gate');
        r.record('both.example', null, 'edge');
        r.record('both.example', null, 'gate');
        r.record('unsaid.example', null);
        r.record('odd.example', null, 'elsewhere' as any);
        assert.deepStrictEqual(Object.fromEntries(r.list().map((e: any) => [e.host, e.source])),
            { 'odd.example': null, 'unsaid.example': null, 'both.example': 'both', 'gate.example': 'gate', 'edge.example': 'edge' });
        const merged = hp.mergeRefusedHosts([r.list(), [
            { host: 'gate.example', count: 1, firstSeen: 1, lastSeen: 100, hint: null, source: 'edge' },
            { host: 'unsaid.example', count: 1, firstSeen: 1, lastSeen: 99, hint: null, source: 'edge' },
            { host: 'forged.example', count: 1, firstSeen: 1, lastSeen: 98, hint: null, source: '<script>' },
        ]]);
        assert.deepStrictEqual(merged.map((e: any) => [e.host, e.source]),
            [['gate.example', 'both'], ['unsaid.example', 'edge'], ['odd.example', null], ['both.example', 'both'], ['edge.example', 'edge']]);
        assert.deepStrictEqual([...hp.REFUSAL_SOURCES], ['edge', 'gate', 'both']);
    });
});

describe('createLastSeen (R7)', () => {
    test('bounded, with the authenticated timestamp kept apart from any-request', () => {
        let clock = 0;
        const s = hp.createLastSeen({ max: 4, now: () => ++clock });
        for (let i = 0; i < 100; i++) s.touch(`h${i}.example`);
        assert.strictEqual(s.list().length, 4);
        s.touch('h99.example', { authenticated: true });
        const e = s.get('h99.example');
        assert.strictEqual(e.authenticatedAt, e.seenAt);
        s.touch('h99.example');
        assert.ok(s.get('h99.example').seenAt > s.get('h99.example').authenticatedAt);
        assert.strictEqual(s.get('nope.example'), null);
        s.clear();
        assert.deepStrictEqual(s.list(), []);
    });
    test('noteAuthenticatedUse records declared addresses only', () => {
        const s = hp.createLastSeen();
        hp.noteAuthenticatedUse({ siteHost: { hostname: 'example.com', cls: 'canonical' } }, s);
        hp.noteAuthenticatedUse({ siteHost: { hostname: '10.0.0.9', cls: 'ip' } }, s);
        hp.noteAuthenticatedUse({ siteHost: { hostname: 'localhost', cls: 'loopback' } }, s);
        hp.noteAuthenticatedUse({}, s);
        hp.noteAuthenticatedUse(null, s);
        assert.deepStrictEqual(s.list().map((e: any) => e.hostname), ['example.com']);
        assert.ok(s.get('example.com').authenticatedAt !== null);
    });
});

// ─── 3. The gate, mounted for real ──────────────────────────────────────────────────────────────────

type GateSetup = {
    config?: any;
    env?: Record<string, string | undefined>;
    nodeEnv?: string;
    installed?: boolean;
    ownAddresses?: string[];
    afterGate?: (req: any, seen: any) => void;
    onNotice?: (kind: string, detail: any) => void;
};

/** An Express app with the real gate at the root and a handler that reports what the gate attached. */
function gateApp(setup: GateSetup = {}) {
    const { logger, lines } = captureLogger();
    const refused = hp.createRefusedHosts();
    const seen = hp.createLastSeen();
    const state = { config: setup.config === undefined ? { siteUrl: 'https://example.com', siteAliases: [{ url: 'https://www.example.com' }] } : setup.config, installed: setup.installed !== false };
    const provider = hp.createPolicyProvider({
        getConfig: () => state.config,
        env: setup.env || {},
        nodeEnv: setup.nodeEnv || 'production',
        ownAddresses: () => new Set(setup.ownAddresses || []),
        logger,
    });
    const notices: Array<{ kind: string; detail: any }> = [];
    const app = express();
    app.use(hp.hostGateFactory({
        getPolicy: provider.get,
        isInstalled: () => state.installed,
        logger,
        refused,
        lastSeen: seen,
        onNotice: setup.onNotice || ((kind: string, detail: any) => notices.push({ kind, detail })),
    }));
    app.use((req: any, res: any) => {
        if (setup.afterGate) setup.afterGate(req, seen);
        res.json({ passed: true, siteHost: req.siteHost || null });
    });
    return { app, lines, refused, seen, notices, state, provider };
}

function rawRequest(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.end(payload));
        let buf = '';
        socket.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
        socket.on('error', reject);
        socket.on('close', () => resolve(buf));
    });
}

async function withServer(app: any, fn: (port: number) => Promise<void>) {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
        await fn(server.address().port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

const HOST_NOT_ALLOWED = { code: 'rest_host_not_allowed', error: 'host_not_allowed', message: 'This address is not configured for this site.', data: { status: 421 } };

function assert421(res: any, label: string) {
    assert.strictEqual(res.status, 421, `${label}: status`);
    assert.deepStrictEqual(res.body, HOST_NOT_ALLOWED, `${label}: body (no redirect, no details)`);
    assert.strictEqual(res.headers['cache-control'], 'no-store', `${label}: no-store`);
    assert.strictEqual(res.headers['x-robots-tag'], 'noindex', `${label}: noindex`);
}

describe('hostGate: accepted addresses', () => {
    test('canonical, alias, trailing dot, IP literals, loopback — each with its class on req.siteHost', async () => {
        const { app } = gateApp();
        const cases: Array<[string, string]> = [
            ['example.com', 'canonical'],
            ['example.com.', 'canonical'],
            ['EXAMPLE.COM:443', 'canonical'],
            ['www.example.com', 'alias'],
            ['192.168.1.23:3000', 'ip'],
            ['[2001:db8::5]:3000', 'ip'],
            ['[::1]:3000', 'loopback'],
            ['127.0.0.2', 'loopback'],
            ['localhost:4000', 'loopback'],
        ];
        for (const [host, cls] of cases) {
            const res = await request(app).get('/api/v1/posts').set('Host', host);
            assert.strictEqual(res.status, 200, host);
            assert.strictEqual(res.body.siteHost.cls, cls, host);
        }
    });
    test('req.siteHost carries the parsed address, the hop and the scheme', async () => {
        const { app } = gateApp();
        const res = await request(app).get('/x').set('Host', 'www.example.com:8443');
        assert.deepStrictEqual(res.body.siteHost, {
            hostname: 'www.example.com', port: 8443, kind: 'dns', host: 'www.example.com:8443', cls: 'alias', reason: 'alias',
            entry: res.body.siteHost.entry, hop: null, viaTrustedHop: false, scheme: 'http',
        });
        assert.strictEqual(res.body.siteHost.entry.origin, 'https://www.example.com');
    });
    test('a loopback hop relays the browser\'s address and scheme', async () => {
        const { app } = gateApp();
        const res = await request(app).get('/x').set('Host', '127.0.0.1:4000').set('X-Forwarded-Host', 'www.example.com').set('X-Forwarded-Proto', 'https');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost.cls, 'alias');
        assert.strictEqual(res.body.siteHost.hop, 'local');
        assert.strictEqual(res.body.siteHost.scheme, 'https');
    });
    test('development (the retired dev-hosts cases): a phone on the LAN, *.localhost and WORDJS_DEV_ORIGINS', async () => {
        const { app } = gateApp({ nodeEnv: 'development', config: { siteUrl: 'http://localhost:3000' }, env: { WORDJS_DEV_ORIGINS: 'Mi-PC.local' }, ownAddresses: ['192.168.1.11'] });
        for (const [host, cls] of [['192.168.1.11:3000', 'ip'], ['app.localhost:3000', 'loopback'], ['mi-pc.local:3000', 'dev']]) {
            const res = await request(app).get('/api/v1/users/me').set('Host', host);
            assert.strictEqual(res.status, 200, host);
            assert.strictEqual(res.body.siteHost.cls, cls, host);
        }
        assert421(await request(app).get('/api/v1/users/me').set('Host', 'evil.example'), 'dev still refuses undeclared names');
    });
    test('production never answers the development-only names', async () => {
        const { app } = gateApp({ config: { siteUrl: 'http://localhost:3000' }, env: { WORDJS_DEV_ORIGINS: 'mi-pc.local' } });
        assert421(await request(app).get('/x').set('Host', 'mi-pc.local'), 'WORDJS_DEV_ORIGINS in production');
        assert421(await request(app).get('/x').set('Host', 'app.localhost'), '*.localhost in production');
        assert.strictEqual((await request(app).get('/x').set('Host', '192.168.1.11:3000')).status, 200, 'IP literals hold in every mode');
    });
});

describe('hostGate: refusals', () => {
    test('an unknown name gets 421 on every API surface, /setup included, preflight included', async () => {
        const { app } = gateApp();
        assert421(await request(app).get('/api/v1/posts').set('Host', 'attacker.example'), 'GET /posts');
        assert421(await request(app).post('/api/v1/auth/login').set('Host', 'attacker.example').send({ username: 'a', password: 'b' }), 'POST /auth/login');
        assert421(await request(app).get('/api/v1/setup/status').set('Host', 'attacker.example'), 'GET /setup/status');
        assert421(await request(app).post('/api/v1/setup/migrate').set('Host', 'attacker.example'), 'POST /setup/migrate');
        assert421(
            await request(app).options('/api/v1/posts').set('Host', 'attacker.example').set('Origin', 'https://attacker.example').set('Access-Control-Request-Method', 'POST'),
            'CORS preflight',
        );
        const head = await request(app).head('/api/v1/posts').set('Host', 'attacker.example');
        assert.strictEqual(head.status, 421, 'HEAD');
        assert.strictEqual(head.headers['cache-control'], 'no-store', 'HEAD: no-store');
    });
    test('exempt trees and probes are answered on any host, by segment only', async () => {
        const { app } = gateApp();
        for (const p of ['/health', '/healthz', '/readyz', '/metrics', '/favicon.ico', '/uploads/2026/x.png', '/themes/default/style.css', '/plugins/a/b.js', '/public/css/x.css', '/.well-known/acme-challenge/tok', '/uploads']) {
            const res = await request(app).get(p).set('Host', 'attacker.example');
            assert.strictEqual(res.status, 200, p);
            assert.strictEqual(res.body.siteHost, null, `${p} is not classified`);
        }
        for (const p of ['/uploadsX', '/healthzz', '/api/v1/uploads/x', '/Uploads/x', '/metrics.json']) {
            assert421(await request(app).get(p).set('Host', 'attacker.example'), `${p} is not exempt`);
        }
    });
    test('an ambiguous path is never exempt, whatever its prefix (lab E1): it is classified like any request', async () => {
        // A prefix test on the raw path exempted /healthz/../api/v1/settings; the hop after it (Next.js)
        // resolved the dot segments and served the API. Sent raw: an HTTP client library may resolve them.
        const { app } = gateApp();
        await withServer(app, async (port) => {
            const send = (p: string, host: string) => rawRequest(port, `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
            for (const p of ['/healthz/../api/v1/settings', '/public/../api/v1/settings', '/uploads/%2e%2e/api/v1/settings', '/uploads/.%2E/api',
                '/themes/..;/api', '/plugins/x/%2fapi', '/plugins/x/%5Capi', '/.well-known/acme-challenge/..\\api', '/uploads/%252e%252e/api', '/health/./x']) {
                assert.match(await send(p, 'attacker.example'), /^HTTP\/1\.1 421 /, p);
            }
            // On an accepted address the same paths are classified and passed on, like any request.
            assert.match(await send('/public/../api/v1/settings', 'example.com'), /"cls":"canonical"/);
            // Dots inside a segment are not dot segments.
            for (const p of ['/uploads/2026/a..b.png', '/uploads/.hidden', '/uploads/.../x', '/.well-known/acme-challenge/tok']) {
                assert.match(await send(p, 'attacker.example'), /"siteHost":null/, p);
            }
        });
    });
    test('a malformed host is 400, never classified', async () => {
        const { app } = gateApp();
        for (const host of ['evil.example@localhost', 'localhost:1@evil.example', '127.1', 'example.com:99999']) {
            const res = await request(app).get('/x').set('Host', host);
            assert.strictEqual(res.status, 400, host);
            assert.strictEqual(res.body.code, 'rest_invalid_host', host);
            assert.strictEqual(res.headers['cache-control'], 'no-store');
        }
        const viaHop = await request(app).get('/x').set('Host', '127.0.0.1:4000').set('X-Forwarded-Host', 'a b');
        assert.strictEqual(viaHop.status, 400, 'a malformed relayed host is 400 too');
    });
    test('duplicate Host headers are 400 (Node silently keeps the first one)', async () => {
        const { app } = gateApp();
        await withServer(app, async (port: number) => {
            const control = await rawRequest(port, 'GET /api/v1/posts HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
            assert.match(control, /^HTTP\/1\.1 200/, 'control: one Host passes');
            const dup = await rawRequest(port, 'GET /api/v1/posts HTTP/1.1\r\nHost: example.com\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
            assert.match(dup, /^HTTP\/1\.1 400/);
            assert.match(dup, /rest_invalid_host/);
        });
    });
    test('HTTP/1.0 with no Host passes the gate (CSRF/CORS fail closed on it later)', async () => {
        const { app } = gateApp();
        await withServer(app, async (port: number) => {
            const res = await rawRequest(port, 'GET /api/v1/posts HTTP/1.0\r\n\r\n');
            assert.match(res, /^HTTP\/1\.1 200/);
            assert.match(res, /"siteHost":null/);
        });
    });
    test('the refusal log names the host and the hint, and is throttled (R7)', async () => {
        const { app, lines, refused } = gateApp();
        await request(app).get('/x').set('Host', 'wordjs_upstream:3000');
        assert.strictEqual(lines.warn.length, 1);
        assert.match(lines.warn[0], /421 for wordjs_upstream:3000 \(undeclared\): .*proxy_set_header Host \$host/);
        await request(app).get('/x').set('Host', 'wordjs_upstream:3000');
        assert.strictEqual(lines.warn.length, 1, 'the same host is logged once per minute');
        for (let i = 0; i < 40; i++) await request(app).get('/x').set('Host', `n${i}.example`);
        assert.strictEqual(lines.warn.length, 10, 'at most 10 refusal lines per minute');
        assert.strictEqual(refused.list().length, 32, 'and at most 32 remembered hosts');
        assert.strictEqual(refused.list()[0].host, 'n39.example');
    });
});

describe('hostGate: R4 — an IP literal behind an undeclared proxy', () => {
    test('a direct client by IP is answered; the same IP with proxy headers is 421 with the forward-Host hint', async () => {
        const { app, lines } = gateApp();
        assert.strictEqual((await request(app).get('/x').set('Host', '192.168.5.20:3000')).status, 200, 'control: direct');
        for (const [header, value] of [['X-Forwarded-For', '203.0.113.9'], ['X-Real-IP', '203.0.113.9'], ['Forwarded', 'for=203.0.113.9'], ['Via', '1.1 nginx'], ['X-Forwarded-Host', 'blog.example']]) {
            assert421(await request(app).get('/x').set('Host', '192.168.5.20:3000').set(header, value), `IP literal with ${header}`);
        }
        assert.match(lines.warn[0], /\(proxied-ip\): .*proxy_set_header Host \$host/);
    });
    test('the monolith\'s own pin (X-Forwarded-Host equal to Host) is not a proxy marker', async () => {
        const { app } = gateApp();
        const res = await request(app).get('/x').set('Host', '192.168.1.11:3000').set('X-Forwarded-Host', '192.168.1.11:3000');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost.cls, 'ip');
    });
    test('an operator who declared the proxy (address-based trustProxy) gets IP access back', async () => {
        const { app } = gateApp({ config: { siteUrl: 'https://example.com', trustProxy: 'loopback' } });
        const res = await request(app).get('/x').set('Host', '192.168.5.20:3000').set('X-Forwarded-For', '203.0.113.9');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost.hop, 'operator');
    });
    test('a named host with proxy headers is unaffected (the proxy forwards Host correctly)', async () => {
        const { app } = gateApp();
        const res = await request(app).get('/x').set('Host', 'example.com').set('X-Forwarded-For', '203.0.113.9');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost.cls, 'canonical');
    });
});

describe('hostGate: forwarded Host trust', () => {
    test('DNS rebinding on the loopback port: the forged X-Forwarded-Host is ignored', async () => {
        const { app } = gateApp();
        assert421(await request(app).get('/api/v1/settings').set('Host', 'rebind.test:4000').set('X-Forwarded-Host', 'example.com'), 'rebinding with forged XFH');
    });
    test('R11: a hop-count trustProxy never makes X-Forwarded-Host trustworthy', async () => {
        // The peer is 127.0.0.1 but Host is not a loopback authority, so only the operator rule could
        // honour XFH.
        const hops = gateApp({ config: { siteUrl: 'https://example.com', trustProxy: 1 } });
        const res = await request(hops.app).get('/x').set('Host', 'example.com').set('X-Forwarded-Host', 'attacker.example');
        assert.strictEqual(res.status, 200, 'XFH ignored: judged by Host');
        assert.strictEqual(res.body.siteHost.cls, 'canonical');
        // An operator hop's XFH is read when it dials WordJS by IP (review #3 keeps dotted names out).
        const address = gateApp({ config: { siteUrl: 'https://example.com', trustProxy: 'loopback' } });
        assert421(await request(address.app).get('/x').set('Host', '10.0.0.5:4000').set('X-Forwarded-Host', 'attacker.example'), 'address-based trust honours XFH');
        const honoured = await request(address.app).get('/x').set('Host', '10.0.0.5:4000').set('X-Forwarded-Host', 'example.com');
        assert.strictEqual(honoured.status, 200);
        assert.strictEqual(honoured.body.siteHost.host, 'example.com');
        assert421(await request(hops.app).get('/x').set('Host', '10.0.0.5:4000').set('X-Forwarded-Host', 'example.com'), 'the same request under a hop count is an undeclared proxy (R4)');
    });
    test('review #3: address-based trust does not reopen DNS rebinding — a dotted Host keeps a forged XFH unread', async () => {
        // A rebinding page on rebind.attacker → 127.0.0.1 is a loopback peer, so trustProxy 'loopback' makes
        // it an 'operator' hop; its Host is still its own dotted name, which is what keeps its XFH unread.
        for (const setup of [{ config: { siteUrl: 'https://example.com', trustProxy: 'loopback' } }, { env: { WORDJS_TRUST_PROXY: 'loopback' } }]) {
            const { app } = gateApp(setup);
            assert421(await request(app).get('/api/v1/settings').set('Host', 'rebind.attacker:4000').set('X-Forwarded-Host', 'example.com'), `rebinding with forged XFH under ${JSON.stringify(setup)}`);
            const preserved = await request(app).get('/x').set('Host', 'example.com').set('X-Forwarded-Host', 'attacker.example').set('X-Forwarded-Proto', 'https');
            assert.strictEqual(preserved.status, 200, 'a Host-preserving proxy is judged by the Host it kept');
            assert.strictEqual(preserved.body.siteHost.cls, 'canonical');
            assert.strictEqual(preserved.body.siteHost.hop, 'operator');
            assert.strictEqual(preserved.body.siteHost.scheme, 'https', 'the operator hop\'s X-Forwarded-Proto is still read');
            for (const host of ['10.0.0.5:4000', '[fd00::5]:4000', 'wordjs_backend:4000']) {
                const upstream = await request(app).get('/x').set('Host', host).set('X-Forwarded-Host', 'example.com').set('X-Forwarded-Proto', 'https');
                assert.strictEqual(upstream.status, 200, `${host}: ${JSON.stringify(upstream.body)}`);
                assert.strictEqual(upstream.body.siteHost.cls, 'canonical', `${host}: a proxy dialling by IP or upstream name relays the browser's address`);
                assert.strictEqual(upstream.body.siteHost.host, 'example.com');
            }
        }
    });
    test('WORDJS_TRUST_PROXY as a hop count is refused the same way', async () => {
        const { app } = gateApp({ env: { WORDJS_TRUST_PROXY: '1' } });
        const res = await request(app).get('/x').set('Host', 'example.com').set('X-Forwarded-Host', 'attacker.example');
        assert.strictEqual(res.status, 200);
    });
});

describe('hostGate: refusal advice for a peer that forwards X-Forwarded-Host (review #6, #3)', () => {
    /**
     * The gate driven directly with a request from ANY peer: supertest always connects from 127.0.0.1,
     * and the replica and remote-proxy shapes are about peers on other machines.
     */
    function gateFromPeer(setup: { config?: any; env?: Record<string, string> } = {}) {
        const { logger, lines } = captureLogger();
        const refused = hp.createRefusedHosts();
        const provider = hp.createPolicyProvider({ getConfig: () => setup.config || { siteUrl: 'https://example.com' }, env: setup.env || {}, nodeEnv: 'production', logger });
        const gate = hp.hostGateFactory({ getPolicy: provider.get, isInstalled: () => true, logger, refused, lastSeen: hp.createLastSeen() });
        function send(remoteAddress: string, headers: Record<string, string>) {
            const req: any = fakeReq({ remoteAddress, headers });
            req.url = '/api/v1/posts';
            const res: any = { statusCode: 200, body: null, setHeader() { /* not inspected */ }, end(b: string) { this.body = b; } };
            let passed = false;
            gate(req, res, () => { passed = true; });
            return { passed, status: passed ? 200 : res.statusCode, siteHost: req.siteHost || null };
        }
        return { send, lines, refused };
    }
    // documentation/multi-node.md "Pinning a frontend replica": the replica on 10.0.1.30 proxies /api to
    // WORDJS_BACKEND_URL=http://10.0.1.23:4000 — Host is the backend's IP, X-Forwarded-Host the browser's.
    const REPLICA = { host: '10.0.1.23:4000', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' };
    const TRUST_ADVICE = /10\.0\.1\.30 forwards X-Forwarded-Host but is not in trustProxy; if it is your frontend replica or proxy, set WORDJS_TRUST_PROXY=10\.0\.1\.30/;

    test('a replica pinned by IP and not in trustProxy: 421, and the log names the peer and the setting', () => {
        for (const extra of [{}, { 'x-forwarded-for': '198.51.100.7' }] as Array<Record<string, string>>) {
            const { send, lines, refused } = gateFromPeer();
            assert.strictEqual(send('10.0.1.30', { ...REPLICA, ...extra }).status, 421);
            assert.strictEqual(lines.warn.length, 1);
            assert.match(lines.warn[0], /421 for 10\.0\.1\.23:4000 \(proxied-ip\): /);
            assert.match(lines.warn[0], TRUST_ADVICE);
            assert.doesNotMatch(lines.warn[0], /proxy_set_header/, 'not the nginx hint: this proxy is not rewriting a browser Host');
            assert.strictEqual(refused.list()[0].hint, 'forward-host', 'the admin page is told to fix the proxy, not to add the IP');
        }
    });
    test('the same replica inside trustProxy is answered as the browser\'s address', () => {
        for (const setup of [{ env: { WORDJS_TRUST_PROXY: '10.0.1.30' } }, { config: { siteUrl: 'https://example.com', trustProxy: '10.0.1.0/24' } }]) {
            const { send, lines } = gateFromPeer(setup);
            const r = send('10.0.1.30', { ...REPLICA, 'x-forwarded-for': '198.51.100.7' });
            assert.strictEqual(r.status, 200, JSON.stringify(setup));
            assert.deepStrictEqual([r.siteHost.cls, r.siteHost.hop, r.siteHost.scheme], ['canonical', 'operator', 'https']);
            assert.deepStrictEqual(lines.warn, []);
        }
    });
    test('an IPv4-mapped peer is named as the IPv4 address an operator writes, and that setting works', () => {
        const refusedRun = gateFromPeer();
        assert.strictEqual(refusedRun.send('::ffff:10.0.1.30', REPLICA).status, 421);
        assert.match(refusedRun.lines.warn[0], TRUST_ADVICE);
        assert.strictEqual(gateFromPeer({ env: { WORDJS_TRUST_PROXY: '10.0.1.30' } }).send('::ffff:10.0.1.30', REPLICA).status, 200);
    });
    test('the trustProxy advice is given only when trusting the peer would have served the request', () => {
        const cases: Array<[string, string, Record<string, string>]> = [
            ['a loopback peer: forward Host instead', '127.0.0.1', REPLICA],
            ['XFH naming an address this site does not answer', '10.0.1.30', { ...REPLICA, 'x-forwarded-host': 'evil.example' }],
            ['no XFH at all (a proxy that only adds X-Forwarded-For)', '10.0.1.30', { host: '10.0.1.23:4000', 'x-forwarded-for': '198.51.100.7' }],
        ];
        for (const [what, peer, headers] of cases) {
            const { send, lines } = gateFromPeer();
            assert.strictEqual(send(peer, headers).status, 421, what);
            assert.doesNotMatch(lines.warn[0], /trustProxy/, what);
            assert.match(lines.warn[0], /\(proxied-ip\): .*proxy_set_header Host \$host/, `${what}: the generic forward-Host hint`);
        }
    });
    test('review #3: a trusted proxy that dials WordJS by a dotted DNS name is told to forward Host', () => {
        const { send, lines, refused } = gateFromPeer({ env: { WORDJS_TRUST_PROXY: '10.0.0.0/8' } });
        const r = send('10.1.2.3', { host: 'backend.internal:4000', 'x-forwarded-host': 'example.com' });
        assert.strictEqual(r.status, 421, 'its X-Forwarded-Host is not read');
        assert.match(lines.warn[0], /421 for backend\.internal:4000 \(undeclared\): 10\.1\.2\.3 is in trustProxy but addresses WordJS as backend\.internal:4000, a DNS name, .*proxy_set_header Host \$host/);
        assert.strictEqual(refused.list()[0].hint, 'forward-host', 'not "add this address": that would classify every visitor as backend.internal');
    });
});

describe('hostGate: install state and a missing canonical', () => {
    test('before install every address passes (the install funnel answers later)', async () => {
        const { app } = gateApp({ installed: false, config: null });
        const res = await request(app).get('/api/v1/setup/status').set('Host', 'whatever.example');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost, null);
    });
    test('installed without a usable siteUrl: answered, one ERROR line, one notice', async () => {
        for (const config of [{ installedAt: 'x' }, { installedAt: 'x', siteUrl: 'https,https://example.com' }]) {
            const { app, lines, notices } = gateApp({ config });
            assert.strictEqual((await request(app).get('/x').set('Host', 'any.example')).status, 200);
            assert.strictEqual((await request(app).get('/x').set('Host', 'other.example')).status, 200);
            assert.strictEqual(lines.error.length, 1, JSON.stringify(config));
            assert.match(lines.error[0], /siteUrl in wordjs-config\.json is (missing|invalid)/);
            assert.deepStrictEqual(notices.map((n) => n.kind), ['missing-canonical']);
        }
    });
    test('R10 through the gate: a config that turns unreadable keeps refusing unknown hosts', async () => {
        const { app, state } = gateApp();
        assert421(await request(app).get('/x').set('Host', 'attacker.example'), 'before');
        state.config = null;
        assert421(await request(app).get('/x').set('Host', 'attacker.example'), 'while the file is unreadable');
    });
    test('a config change is picked up on the next request (no restart)', async () => {
        const { app, state } = gateApp();
        assert421(await request(app).get('/x').set('Host', 'new.example'), 'before');
        state.config = { siteUrl: 'https://example.com', siteAliases: ['https://new.example'] };
        assert.strictEqual((await request(app).get('/x').set('Host', 'new.example')).status, 200);
    });
});

describe('hostGate: proxy collapse warning', () => {
    test('a remote client on a loopback Host through a loopback peer: answered, warned once', async () => {
        const { app, lines, notices } = gateApp();
        for (let i = 0; i < 3; i++) {
            const res = await request(app).get('/x').set('Host', '127.0.0.1:3000').set('X-Forwarded-For', '203.0.113.9');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.siteHost.cls, 'loopback');
        }
        assert.strictEqual(lines.warn.filter((l) => /loopback Host/.test(l)).length, 1);
        assert.deepStrictEqual(notices.map((n) => n.kind), ['proxy-collapse']);
    });
    test('not raised for a local client, in development, or for a loopback canonical', async () => {
        const local = gateApp();
        await request(local.app).get('/x').set('Host', '127.0.0.1:3000').set('X-Forwarded-For', '127.0.0.1');
        await request(local.app).get('/x').set('Host', 'localhost:3000').set('Forwarded', 'for="[::1]:5000"');
        assert.deepStrictEqual(local.notices, []);
        const dev = gateApp({ nodeEnv: 'development' });
        await request(dev.app).get('/x').set('Host', '127.0.0.1:3000').set('X-Forwarded-For', '203.0.113.9');
        assert.deepStrictEqual(dev.notices, []);
        const loopbackSite = gateApp({ config: { siteUrl: 'http://localhost:3000' } });
        await request(loopbackSite.app).get('/x').set('Host', '127.0.0.1:3000').set('X-Real-IP', '203.0.113.9');
        assert.deepStrictEqual(loopbackSite.notices, []);
    });

    // Who SENT the loopback name decides it (lab X3). Most shapes below need an mTLS gateway peer or a
    // peer on another machine, which a socket from this test cannot be, so the real gate is run on
    // request-shaped objects (gateOnce); the pre-certificate shape is also sent over a real socket.
    function collapseGate(config?: any) {
        const { logger, lines } = captureLogger();
        const notices: string[] = [];
        const provider = hp.createPolicyProvider({ getConfig: () => config || { siteUrl: 'https://example.com' }, env: {}, nodeEnv: 'production', ownAddresses: () => new Set(), logger });
        const gate = hp.hostGateFactory({ getPolicy: provider.get, isInstalled: () => true, logger, refused: hp.createRefusedHosts(), lastSeen: hp.createLastSeen(), onNotice: (kind: string) => notices.push(kind) });
        return { gate, notices, lines };
    }
    function gateOnce(gate: any, v: any): boolean {
        const req = fakeReq(v);
        req.url = '/api/v1/posts';
        const res: any = { statusCode: 200, setHeader() { /* not inspected */ }, end() { /* not inspected */ } };
        let passed = false;
        gate(req, res, () => { passed = true; });
        return passed;
    }

    test('lab X3: the gateway relaying a direct remote client that typed a loopback Host is NOT a collapse', async () => {
        const shapes = [
            // Split mode over mTLS: the gateway's certificate, its own upstream as Host, the client's Host
            // relayed, and the client's address appended last by http-proxy's xfwd.
            { remoteAddress: '127.0.0.1', authorized: true, peerCN: 'gateway', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '203.0.113.9' } },
            // Before the cluster certificates the same gateway dials 127.0.0.1:4000 in clear: a loopback hop.
            { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '::ffff:203.0.113.9' } },
            // The client typed the gateway's own upstream address and forged a chain ending in loopback:
            // the gateway still appended the client's real address last.
            { remoteAddress: '127.0.0.1', authorized: true, peerCN: 'gateway', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': '127.0.0.1:4000', 'x-forwarded-for': '198.51.100.1, 127.0.0.1, 203.0.113.9' } },
            { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': '127.0.0.1:4000', 'x-forwarded-for': '127.0.0.1, 203.0.113.9', 'x-real-ip': '198.51.100.1' } },
            // Separate mode: the gateway on its own machine.
            { remoteAddress: '10.0.0.7', authorized: true, peerCN: 'gateway', headers: { host: '10.0.0.5:4000', 'x-forwarded-host': '[::1]:3000', 'x-forwarded-for': '203.0.113.9' } },
        ];
        for (const v of shapes) {
            const { gate, notices, lines } = collapseGate();
            assert.strictEqual(gateOnce(gate, v), true, JSON.stringify(v.headers));
            assert.deepStrictEqual(notices, [], JSON.stringify(v.headers));
            assert.ok(!lines.warn.some((l) => /loopback Host/.test(l)), JSON.stringify(v.headers));
        }
        const { app, notices } = gateApp();
        const res = await request(app).get('/x').set('Host', '127.0.0.1:4000').set('X-Forwarded-Host', 'localhost:3000').set('X-Forwarded-For', '203.0.113.9');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.siteHost.cls, 'loopback');
        assert.deepStrictEqual(notices, []);
    });

    test('a proxy on this machine that rewrites Host IS a collapse — in front of the monolith and in front of the gateway', () => {
        const shapes = [
            // nginx → monolith: the backend shares nginx's socket, and the monolith forwards no
            // X-Forwarded-Host for a Host it judged itself.
            { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9' } },
            // nginx → gateway → backend over mTLS: the gateway appended nginx's loopback address after the client.
            { remoteAddress: '127.0.0.1', authorized: true, peerCN: 'gateway', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.9, ::ffff:127.0.0.1' } },
            // … before the cluster certificates, with nginx reporting the client in X-Real-IP only.
            { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '203.0.113.9' } },
            // Separate mode: nginx on the gateway's machine (the old heuristic never saw this one: its
            // socket peer, the gateway, is not on loopback).
            { remoteAddress: '10.0.0.7', authorized: true, peerCN: 'gateway', headers: { host: '10.0.0.5:4000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '203.0.113.9, 127.0.0.1' } },
        ];
        for (const v of shapes) {
            const { gate, notices, lines } = collapseGate();
            assert.strictEqual(gateOnce(gate, v), true, JSON.stringify(v.headers));
            assert.deepStrictEqual(notices, ['proxy-collapse'], JSON.stringify(v.headers));
            assert.ok(lines.warn.some((l) => /loopback Host/.test(l)), JSON.stringify(v.headers));
        }
    });

    test('a hop not known to append its peer proves nothing: a trusted replica on another machine copies X-Forwarded-For', () => {
        const { gate, notices } = collapseGate({ siteUrl: 'https://example.com', trustProxy: '10.0.0.0/8' });
        assert.strictEqual(gateOnce(gate, { remoteAddress: '10.0.1.30', headers: { host: '10.0.1.23:4000', 'x-forwarded-host': 'localhost:3001', 'x-forwarded-for': '8.8.8.8, 127.0.0.1' } }), true);
        assert.deepStrictEqual(notices, []);
    });

    test('a throwing notice callback does not break the request', async () => {
        const { app, lines } = gateApp({ onNotice: () => { throw new Error('boom'); } });
        const res = await request(app).get('/x').set('Host', '127.0.0.1:3000').set('X-Forwarded-For', '203.0.113.9');
        assert.strictEqual(res.status, 200);
        assert.ok(lines.warn.some((l) => /notice callback failed: boom/.test(l)));
    });
});

describe('hostGate: last seen (R7)', () => {
    test('only declared addresses are recorded; anonymous IP literals cannot grow the map', async () => {
        const { app, seen } = gateApp();
        for (let i = 0; i < 60; i++) await request(app).get('/x').set('Host', `10.0.${i}.1`);
        await request(app).get('/x').set('Host', 'localhost');
        assert.deepStrictEqual(seen.list(), []);
        await request(app).get('/x').set('Host', 'www.example.com');
        const entry = seen.get('www.example.com');
        assert.ok(entry && entry.seenAt > 0);
        assert.strictEqual(entry.authenticatedAt, null, 'the gate runs before authentication: it never counts as use');
    });
    test('noteAuthenticatedUse after authentication marks the address in use', async () => {
        const { app, seen } = gateApp({ afterGate: (req: any, tracker: any) => hp.noteAuthenticatedUse(req, tracker) });
        await request(app).get('/x').set('Host', 'example.com');
        assert.ok(seen.get('example.com').authenticatedAt !== null);
    });
});

describe('hostGateFactory contract', () => {
    test('getPolicy and isInstalled are required', () => {
        assert.throws(() => hp.hostGateFactory(), /getPolicy\(\) and isInstalled\(\)/);
        assert.throws(() => hp.hostGateFactory({ getPolicy: () => ({}) }), /isInstalled/);
    });
    test('works on a bare Node server (no Express): the monolith and gateway can mount it', async () => {
        const provider = hp.createPolicyProvider({ getConfig: () => ({ siteUrl: 'https://example.com' }), env: {} });
        const gate = hp.hostGateFactory({ getPolicy: provider.get, isInstalled: () => true, logger: captureLogger().logger, refused: hp.createRefusedHosts(), lastSeen: hp.createLastSeen() });
        const server = http.createServer((req: any, res: any) => gate(req, res, () => { res.end('next'); }));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            const port = server.address().port;
            assert.match(await rawRequest(port, 'GET /x?y=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'), /next$/);
            assert.match(await rawRequest(port, 'GET /x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 421/);
            assert.match(await rawRequest(port, 'GET /uploads/a.png?v=1 HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'), /next$/);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
