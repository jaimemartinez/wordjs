/**
 * Per-plugin egress ALLOWLIST (opt-in DiD for network-granted plugins).
 *
 * Unit-tests the enforcement core in egress-guard: setAllowedHosts() normalization + isHostAllowed()
 * matching. The critical properties: (1) no allowlist ⇒ unchanged allow-all-public (no regression for
 * shipped network plugins); (2) matching is exact OR subdomain at a LABEL boundary — never a substring,
 * so 'evil-stripe.com' can't ride an allowlist for 'stripe.com'; (3) the allowlist is ADDITIVE — it never
 * loosens isBlockedIp (a listed host that is a private/loopback IP is still blocked).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const eg = require('../core/egress-guard');

function withAllowlist(list: any, fn: () => void) {
    try { eg.setAllowedHosts(list); fn(); } finally { eg.setAllowedHosts(null); }
}

test('no allowlist ⇒ every host allowed (unchanged behavior)', () => {
    eg.setAllowedHosts(null);
    assert.strictEqual(eg.isHostAllowed('anything.example.com'), true);
    assert.strictEqual(eg.isHostAllowed('1.2.3.4'), true);
    // An empty array also means "no allowlist" (so clearing the list restores allow-all).
    withAllowlist([], () => assert.strictEqual(eg.isHostAllowed('anything.example.com'), true));
});

test('exact host match, others denied', () => {
    withAllowlist(['api.stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true);
        assert.strictEqual(eg.isHostAllowed('other.com'), false);
        assert.strictEqual(eg.isHostAllowed('stripe.com'), false, 'a parent of the listed host is NOT implied');
    });
});

test('bare-domain entry matches the apex and subdomains at a label boundary — never a substring', () => {
    withAllowlist(['stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed('stripe.com'), true, 'apex');
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true, 'subdomain');
        assert.strictEqual(eg.isHostAllowed('a.b.stripe.com'), true, 'deep subdomain');
        assert.strictEqual(eg.isHostAllowed('evil-stripe.com'), false, 'label-boundary: NOT a substring match');
        assert.strictEqual(eg.isHostAllowed('stripe.com.evil.com'), false, 'suffix attack: listed host as a left label');
        assert.strictEqual(eg.isHostAllowed('notstripe.com'), false);
    });
});

test("'*.' / leading-dot entries normalize to the bare domain", () => {
    for (const entry of ['*.stripe.com', '.stripe.com', 'STRIPE.COM']) {
        withAllowlist([entry], () => {
            assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true, `${entry} → subdomain`);
            assert.strictEqual(eg.isHostAllowed('stripe.com'), true, `${entry} → apex`);
            assert.strictEqual(eg.isHostAllowed('evil.com'), false, `${entry} → unrelated denied`);
        });
    }
});

test('case-insensitive + trailing-dot (FQDN) tolerant', () => {
    withAllowlist(['Api.Stripe.COM'], () => {
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true);
        assert.strictEqual(eg.isHostAllowed('API.STRIPE.COM'), true);
        assert.strictEqual(eg.isHostAllowed('api.stripe.com.'), true, 'trailing dot stripped');
    });
});

test('IP-literal entries match EXACTLY, never as a suffix', () => {
    withAllowlist(['203.0.113.4'], () => {
        assert.strictEqual(eg.isHostAllowed('203.0.113.4'), true);
        assert.strictEqual(eg.isHostAllowed('203.0.113.40'), false, 'not a numeric suffix match');
        assert.strictEqual(eg.isHostAllowed('4.203.0.113'), false);
        assert.strictEqual(eg.isHostAllowed('sub.203.0.113.4'), false, 'IP is not a domain suffix');
    });
});

test('IPv6 literals: bracketed (URL-derived) and spelling variants match a bare entry', () => {
    withAllowlist(['2606:4700:4700::1111'], () => {
        // URL.hostname keeps the [] brackets for IPv6 — fetch/WS/http paths pass a bracketed host.
        assert.strictEqual(eg.isHostAllowed('[2606:4700:4700::1111]'), true, 'bracketed form (URL path)');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700::1111'), true, 'bare form (socket path)');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700:0:0:0:0:1111'), true, 'expanded spelling canonicalizes');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700::2222'), false, 'a different v6 address is denied');
        assert.strictEqual(eg.isHostAllowed('example.com'), false, 'a hostname never matches an IP entry');
    });
});

test('no-host / undefined target is denied under an allowlist (default-localhost connect)', () => {
    withAllowlist(['api.stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed(undefined), false);
        assert.strictEqual(eg.isHostAllowed(''), false);
    });
});

test('allowlist is ADDITIVE: it never loosens isBlockedIp (a listed private IP is still blocked)', () => {
    // Even if an admin lists a private/loopback/metadata IP, isBlockedIp (the separate, first-applied gate)
    // still denies it — isHostAllowed only narrows which PUBLIC hosts are reachable.
    withAllowlist(['127.0.0.1', '169.254.169.254', '10.0.0.5'], () => {
        assert.strictEqual(eg.isHostAllowed('127.0.0.1'), true, 'isHostAllowed alone would permit it...');
        assert.strictEqual(eg.isBlockedIp('127.0.0.1'), true, '...but isBlockedIp still blocks loopback');
        assert.strictEqual(eg.isBlockedIp('169.254.169.254'), true, 'metadata still blocked');
        assert.strictEqual(eg.isBlockedIp('10.0.0.5'), true, 'RFC1918 still blocked');
    });
});

// ---- The name the allowlist judges must be the name that is resolved -------------------------------
// getaddrinfo (dns.lookup) and c-ares both take a C string and stop at the first NUL, so a host that ends
// in an allowlisted suffix AFTER a NUL is resolved — and queried at the attacker's nameserver — as the
// part before it. These cases stub dns.lookup (the egress guard reads it at call time) so they are offline
// and deterministic, and record every name a resolver was actually asked for.
const PUBLIC_TEST_IP = '203.0.113.10'; // TEST-NET-3: public to isBlockedIp, routed nowhere
function stubLookup() {
    const dnsMod = require('dns');
    const orig = dnsMod.lookup;
    const queried: string[] = [];
    dnsMod.lookup = function (host: any, opts: any, cb: any) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        queried.push(String(host));
        const list = [{ address: PUBLIC_TEST_IP, family: 4 }];
        process.nextTick(() => (opts && opts.all ? cb(null, list) : cb(null, PUBLIC_TEST_IP, 4)));
    };
    // Keep the builtin's promisify marker (customPromisifyArgs), as the real dns.lookup carries it.
    for (const sym of Object.getOwnPropertySymbols(orig)) dnsMod.lookup[sym] = orig[sym];
    return { queried, restore: () => { dnsMod.lookup = orig; } };
}
const NUL_HOST = 'leak.attacker.example\u0000.vendor.example';

test('a NUL-suffixed host never matches the allowlist (the resolver would query the part before the NUL)', () => {
    withAllowlist(['vendor.example'], () => {
        assert.strictEqual(eg.isHostAllowed(NUL_HOST), false, 'NUL then an allowlisted suffix');
        assert.strictEqual(eg.isHostAllowed('one.one.one.one\u0000.vendor.example'), false);
        assert.strictEqual(eg.isHostAllowed('vendor.example\u0000'), false, 'trailing NUL');
        for (const ch of ['\n', '\t', '\r', ' ', '\u007f', '\u0085', '\\', '%', '/', '@']) {
            assert.strictEqual(eg.isHostAllowed(`evil.example${ch}.vendor.example`), false, `separator ${JSON.stringify(ch)}`);
        }
        // Non-ASCII is mapped by IDNA before it is resolved, so it is not judged by its spelling either.
        assert.strictEqual(eg.isHostAllowed('bücher.vendor.example'), false, 'non-ASCII label');
        assert.strictEqual(eg.isHostAllowed('evil.example．vendor.example'), false, 'fullwidth full stop');
        // Legitimate spellings keep matching.
        assert.strictEqual(eg.isHostAllowed('_dmarc.vendor.example'), true);
        assert.strictEqual(eg.isHostAllowed('api-1.VENDOR.example.'), true);
        assert.strictEqual(eg.isHostAllowed('xn--bcher-kva.vendor.example'), true, 'punycode form');
    });
    assert.strictEqual(eg.hostMatchesAllowlist(NUL_HOST, ['vendor.example']), false, 'the exported matcher the host bridge reuses');
    withAllowlist(['2606:4700:4700::1111'], () => {
        assert.strictEqual(eg.isHostAllowed('[2606:4700:4700::1111]'), true, 'IP literals keep their own alphabet');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700::1111\u0000'), false);
    });
});

test('net / http / validatingLookup / dgram refuse a NUL-suffixed host before anything is resolved', async () => {
    const r = stubLookup();
    eg.setAllowedHosts(['vendor.example']);
    const sockets: any[] = [];
    try {
        const net = eg.getGuardedModule('net');
        assert.throws(() => { sockets.push(net.connect({ host: NUL_HOST, port: 9 })); }, /blocked/, 'net.connect');
        assert.throws(() => { sockets.push(net.createConnection(9, NUL_HOST)); }, /blocked/, 'net.createConnection(port, host)');
        const http = eg.getGuardedModule('http');
        assert.throws(() => { const q = http.get({ host: NUL_HOST, port: 80 }); q.on('error', () => {}); sockets.push(q); }, /blocked/, 'http.get');
        const https = eg.getGuardedModule('https');
        assert.throws(() => { const q = https.request({ hostname: NUL_HOST, port: 443 }); q.on('error', () => {}); sockets.push(q); }, /blocked/, 'https.request');

        const lookupErr = await new Promise<any>((resolve) => eg.validatingLookup(NUL_HOST, { all: true }, (err: any) => resolve(err)));
        assert.match(String(lookupErr && lookupErr.message), /blocked/, 'validatingLookup');

        const dgram = eg.getGuardedModule('dgram');
        const sock = dgram.createSocket('udp4');
        sockets.push(sock);
        const sendErr = await new Promise<any>((resolve) => sock.send(Buffer.from('x'), 9, NUL_HOST, (err: any) => resolve(err)));
        assert.match(String(sendErr && sendErr.message), /blocked/, 'dgram.send');

        assert.deepStrictEqual(r.queried, [], 'no resolver was ever asked for the NUL-suffixed name');
    } finally {
        for (const s of sockets) { try { if (s.destroy) s.destroy(); else s.close(); } catch { /* */ } }
        eg.setAllowedHosts(null);
        r.restore();
    }
});

test("the plugin's own dns.lookup obeys the allowlist: an off-allowlist name is never queried", async () => {
    // A lookup is egress by itself: the query for `<secret>.attacker.example` reaches the attacker's
    // authoritative nameserver even if nothing connects afterwards.
    const r = stubLookup();
    eg.setAllowedHosts(['vendor.example']);
    try {
        const dns = eg.getGuardedModule('dns');
        const cbErr = await new Promise<any>((resolve) => dns.lookup('secret.attacker.example', (err: any) => resolve(err)));
        assert.match(String(cbErr && cbErr.message), /blocked/, 'dns.lookup (callback)');
        const nulErr = await new Promise<any>((resolve) => dns.lookup(NUL_HOST, { all: true }, (err: any) => resolve(err)));
        assert.match(String(nulErr && nulErr.message), /blocked/, 'dns.lookup with a NUL-suffixed name');
        await assert.rejects(() => dns.promises.lookup('secret.attacker.example'), /blocked/, 'dns.promises.lookup');
        await assert.rejects(() => require('util').promisify(dns.lookup)('secret.attacker.example'), /blocked/, 'util.promisify(dns.lookup)');
        const svcErr = await new Promise<any>((resolve) => dns.lookupService('198.51.100.7', 80, (err: any) => resolve(err)));
        assert.match(String(svcErr && svcErr.message), /blocked/, 'dns.lookupService (its PTR query is egress too)');
        assert.deepStrictEqual(r.queried, [], 'no off-allowlist name reached the resolver');

        // An allowlisted name resolves, in every shape (util.promisify keeps {address, family}).
        const addr = await new Promise<any>((resolve, reject) => dns.lookup('api.vendor.example', (err: any, a: any) => (err ? reject(err) : resolve(a))));
        assert.strictEqual(addr, PUBLIC_TEST_IP);
        assert.deepStrictEqual(await require('util').promisify(dns.lookup)('api.vendor.example'), { address: PUBLIC_TEST_IP, family: 4 });
        assert.deepStrictEqual(r.queried, ['api.vendor.example', 'api.vendor.example']);

        // No allowlist: unchanged pass-through.
        eg.setAllowedHosts(null);
        const free = await new Promise<any>((resolve, reject) => dns.lookup('anything.example', (err: any, a: any) => (err ? reject(err) : resolve(a))));
        assert.strictEqual(free, PUBLIC_TEST_IP);
    } finally {
        eg.setAllowedHosts(null);
        r.restore();
    }
});
