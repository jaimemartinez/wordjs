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
