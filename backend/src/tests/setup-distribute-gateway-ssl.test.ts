/**
 * setup/index.js distribute() — the installer's merge into gateway/gateway-config.json must keep the
 * gateway's own `ssl` setting when the backend config carries none.
 *
 * A release install (create-wordjs) seeds `{ "ssl": true }` in gateway-config.json only; the backend's
 * wordjs-config.json has no `ssl` block. distribute() used to write `ssl: fullConfig.ssl` — undefined —
 * which JSON drops, so after the split install the gateway's next restart served plain HTTP on a site
 * whose address is https:// (found running a fresh split install under systemd on a clean server).
 */

import { describe, it, after } from 'node:test';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WordJSSetup = require('../../../setup/index.js');

function layout(gatewayConfig: any): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-distribute-'));
    for (const dir of ['backend', 'gateway', 'frontend', path.join('backend', 'certs')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'gateway', 'gateway-config.json'), JSON.stringify(gatewayConfig));
    fs.writeFileSync(path.join(root, 'backend', 'wordjs-config.json'), JSON.stringify({ siteUrl: 'https://localhost:3000' }));
    return root;
}
const readGateway = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'gateway', 'gateway-config.json'), 'utf8'));
// distribute() prints a progress line or two; they are not silenced here, because muting stdout would also
// swallow the test reporter's own output, which node writes to the same stream asynchronously.
const distribute = (root: string, config: any) => new WordJSSetup(root).distribute(config);

describe('setup distribute(): gateway-config.json keeps what the backend config does not set', () => {
    const roots: string[] = [];
    after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

    it('keeps the seeded `ssl: true` when the install config has no ssl block', async () => {
        const root = layout({ ssl: true });
        roots.push(root);
        await distribute(root, { siteUrl: 'https://www.example.com', gatewaySecret: 'x'.repeat(64), gatewayPort: 3000 });
        const gw = readGateway(root);
        assert.strictEqual(gw.ssl, true, 'the gateway must still serve HTTPS after its next restart');
        assert.strictEqual(gw.siteUrl, 'https://www.example.com');
        assert.strictEqual(gw.gatewayPort, 3000);
        assert.ok(gw.mtls && gw.mtls.cert === './certs/gateway-internal.crt');
    });

    it('an ssl value the install config does carry still wins', async () => {
        const root = layout({ ssl: true });
        roots.push(root);
        await distribute(root, { siteUrl: 'http://localhost:3000', ssl: false });
        assert.strictEqual(readGateway(root).ssl, false);
    });

    it('keeps gateway-only keys (no undefined writes over them)', async () => {
        const root = layout({ ssl: { enabled: true }, rateLimit: { max: 500 }, gatewayInternalPort: 3100 });
        roots.push(root);
        await distribute(root, { siteUrl: 'https://localhost:3000' });
        const gw = readGateway(root);
        assert.deepStrictEqual(gw.ssl, { enabled: true });
        assert.deepStrictEqual(gw.rateLimit, { max: 500 });
        assert.strictEqual(gw.gatewayInternalPort, 3100);
    });
});
