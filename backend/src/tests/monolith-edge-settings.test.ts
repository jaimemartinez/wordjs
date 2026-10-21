/**
 * WordJS — the monolith's public port and HTTPS switch from Admin → Security (QA M2-15).
 *
 * The monolith used to show both read-only ("set at startup: the PORT and WORDJS_HTTP env vars, or
 * gateway-config.json") — changing either meant editing the service or a file and restarting by hand. The
 * panel now saves them (the port to wordjs-config.json `gatewayPort`, which monolith.js reads first; the
 * switch to gateway-config.json `ssl`, read like the gateway reads it) and the process restarts itself. A
 * value the service's environment pins is shown and refused, because the next start would take it again.
 *
 * MUTATION PROOF: drop the pinned-port check in cert-manager updateMonolithConfig — the PORT case saves; write
 * `enabled: true` back into installCertEmbedded — the "stored certificate keeps the switch off" case fails.
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-mono-edge-${process.pid}-`));
const GW = path.join(TMP, 'gateway');
fs.mkdirSync(GW, { recursive: true });
const CONFIG_FILE = path.join(TMP, 'wordjs-config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ siteUrl: 'http://example.test:3000', gatewayPort: 3000 }));
process.chdir(TMP);
const ENV = ['WORDJS_MODE', 'WORDJS_EMBEDDED', 'PORT', 'WORDJS_HTTP', 'WORDJS_MONO_PORT_PINNED'];
const SAVED: Record<string, string | undefined> = {};
for (const k of ENV) SAVED[k] = process.env[k];

const configManager = require('../core/configManager');
const certManager = require('../core/cert-manager');
certManager.setMonolithGatewayDirForTests(GW);

const gwFile = () => JSON.parse(fs.readFileSync(path.join(GW, 'gateway-config.json'), 'utf8'));
const writeGw = (obj: any) => fs.writeFileSync(path.join(GW, 'gateway-config.json'), JSON.stringify(obj));

function monolith(env: Record<string, string | undefined> = {}) {
    process.env.WORDJS_MODE = 'mono';
    process.env.WORDJS_EMBEDDED = '1';
    process.env.PORT = '3000';
    delete process.env.WORDJS_HTTP;
    delete process.env.WORDJS_MONO_PORT_PINNED;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

before(() => { (global as any).__WORDJS_MONO_SERVING__ = 'https'; });
after(() => {
    delete (global as any).__WORDJS_MONO_SERVING__;
    for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

describe('getConfig in a monolith reports the switch, what is served and what the environment pins', () => {
    beforeEach(() => monolith());

    test('a switched-off gateway-config.json reads as off, even while the old process still serves https', async () => {
        writeGw({ gatewaySecret: 's', ssl: { enabled: false, key: './k', cert: './c' } });
        const cfg = await certManager.getConfig();
        assert.strictEqual(cfg.source, 'monolith');
        assert.strictEqual(cfg.sslEnabled, false);
        assert.strictEqual(cfg.serving, 'https');
        assert.deepStrictEqual(cfg.pinned, { port: false, tls: false });
    });

    test('a config that never set the switch reads as what is served (the old behaviour)', async () => {
        writeGw({ gatewaySecret: 's' });
        assert.strictEqual((await certManager.getConfig()).sslEnabled, true);
    });

    test('serving plain HTTP says so in the certificate box, not "HTTPS is on"', async () => {
        writeGw({ gatewaySecret: 's' });
        (global as any).__WORDJS_MONO_SERVING__ = 'http';
        try {
            const cfg = await certManager.getConfig();
            assert.strictEqual(cfg.sslEnabled, false);
            assert.strictEqual(cfg.certInfo.code, 'plain-http');
        } finally { (global as any).__WORDJS_MONO_SERVING__ = 'https'; }
    });

    test('PORT and WORDJS_HTTP=1 from the service are reported as pinned', async () => {
        monolith({ WORDJS_MONO_PORT_PINNED: '1', WORDJS_HTTP: '1' });
        const cfg = await certManager.getConfig();
        assert.deepStrictEqual(cfg.pinned, { port: true, tls: true });
        assert.strictEqual(cfg.sslEnabled, false);
    });
});

describe('updateGatewayConfig in a monolith saves to the files the next start reads', () => {
    beforeEach(() => { monolith(); writeGw({ gatewaySecret: 'keep-me', ssl: true }); });

    test('switching HTTPS off writes the switch and keeps the rest of gateway-config.json', async () => {
        const r = await certManager.updateGatewayConfig(3000, false);
        assert.strictEqual(r.monolith, true);
        const gw = gwFile();
        assert.strictEqual(gw.ssl.enabled, false);
        assert.strictEqual(gw.gatewaySecret, 'keep-me');
        // The address the listener will have: the gateway's own port, so it follows (http).
        assert.strictEqual(r.siteUrl, 'http://example.test:3000');
    });

    test('a new port goes to wordjs-config.json gatewayPort, and the address follows it', async () => {
        const r = await certManager.updateGatewayConfig(3443, true);
        configManager.invalidateConfigCache();
        assert.strictEqual(configManager.getConfig().gatewayPort, 3443);
        assert.strictEqual(r.siteUrl, 'https://example.test:3443');
    });

    test('a value pinned by the environment is refused, nothing is written', async () => {
        monolith({ WORDJS_MONO_PORT_PINNED: '1' });
        const before = fs.readFileSync(path.join(GW, 'gateway-config.json'), 'utf8');
        await assert.rejects(() => certManager.updateGatewayConfig(4000, true), (e: any) => e.code === 'monolith_env_pinned');
        monolith({ WORDJS_HTTP: '1' });
        await assert.rejects(() => certManager.updateGatewayConfig(3000, true), (e: any) => e.code === 'monolith_env_pinned');
        assert.strictEqual(fs.readFileSync(path.join(GW, 'gateway-config.json'), 'utf8'), before);
    });

    test('an invalid port is refused', async () => {
        await assert.rejects(() => certManager.updateGatewayConfig('80a', true), (e: any) => e.code === 'monolith_invalid_port');
        await assert.rejects(() => certManager.updateGatewayConfig(70000, true), (e: any) => e.code === 'monolith_invalid_port');
    });
});

describe('installing a certificate in a monolith keeps the HTTPS switch as it was', () => {
    beforeEach(() => monolith());

    test('switched off: the certificate is stored, the switch stays off', async () => {
        writeGw({ gatewaySecret: 's', ssl: { enabled: false } });
        await certManager.installCertEmbedded('KEY', 'CERT');
        const gw = gwFile();
        assert.strictEqual(gw.ssl.enabled, false);
        assert.match(gw.ssl.cert, /imported/);
    });

    test('never set: a stored pair was always served, so it is on', async () => {
        writeGw({ gatewaySecret: 's' });
        await certManager.installCertEmbedded('KEY', 'CERT');
        assert.strictEqual(gwFile().ssl.enabled, true);
    });
});
