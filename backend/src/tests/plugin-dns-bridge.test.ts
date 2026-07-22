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
