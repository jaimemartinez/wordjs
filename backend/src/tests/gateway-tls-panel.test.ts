/**
 * WordJS — the gateway's TLS from the admin panel never changes by itself.
 *
 * FALLOS 114 (QA X1-01): merely OPENING Admin → Security sent POST /system/certs/check whenever the
 * gateway reported no certificate — which includes a gateway serving HTTP on purpose behind a proxy or a
 * tunnel — and ensureGatewayCert generated a self-signed certificate and pushed it, switching that gateway
 * to HTTPS and cutting the proxy off. The screen no longer calls it on load, and ensureGatewayCert itself
 * does nothing while HTTPS is switched off.
 *
 * FALLOS 109: before install, a split backend POSTed /register to the gateway's PUBLIC port (where there
 * is no such route) every few seconds. It now waits for its cluster identity, like the frontend.
 *
 * MUTATION PROOF: drop the `!config.sslEnabled` guard in cert-manager ensureGatewayCert — the first test
 * pushes a certificate; put the `apiPost('/system/certs/check'` back in the screen's load — the source
 * check fails.
 */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SAVED_MODE = process.env.WORDJS_MODE;
const SAVED_EMBEDDED = process.env.WORDJS_EMBEDDED;

describe('cert-manager ensureGatewayCert', () => {
    const certManager = require('../core/cert-manager');
    const realGet = certManager.getConfig;
    const realPush = certManager.pushCertToGateway;
    let pushed: number;
    let gatewayConfig: any;
    beforeEach(() => {
        delete process.env.WORDJS_MODE;
        delete process.env.WORDJS_EMBEDDED;
        pushed = 0;
        certManager.getConfig = async () => gatewayConfig;
        certManager.pushCertToGateway = async () => { pushed += 1; return { success: true }; };
    });
    afterEach(() => {
        certManager.getConfig = realGet;
        certManager.pushCertToGateway = realPush;
        if (SAVED_MODE === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = SAVED_MODE;
        if (SAVED_EMBEDDED === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = SAVED_EMBEDDED;
    });

    test('HTTPS switched off: nothing is generated or pushed', async () => {
        gatewayConfig = { sslEnabled: false, certInfo: null, gatewayPort: 3000, serving: 'http' };
        const r = await certManager.ensureGatewayCert();
        assert.strictEqual(pushed, 0);
        assert.strictEqual(r.skipped, true);
    });

    test('the gateway could not be read: nothing is pushed', async () => {
        gatewayConfig = { sslEnabled: false, certInfo: null, error: 'Gateway Unreachable' };
        await certManager.ensureGatewayCert();
        assert.strictEqual(pushed, 0);
    });

    test('HTTPS on without a certificate: a self-signed one is generated (the explicit button)', async () => {
        gatewayConfig = { sslEnabled: true, certInfo: { type: 'none' } };
        const r = await certManager.ensureGatewayCert();
        assert.strictEqual(pushed, 1);
        assert.strictEqual(r.success, true);
    });

    test('HTTPS on with a certificate: nothing to do', async () => {
        gatewayConfig = { sslEnabled: true, certInfo: { type: 'custom', commonName: 'example.test' } };
        await certManager.ensureGatewayCert();
        assert.strictEqual(pushed, 0);
    });
});

describe('the screens and the boot do not change the edge on their own', () => {
    const root = path.resolve(__dirname, '..', '..', '..');

    test('Admin → Security reads the gateway configuration on load and generates nothing', () => {
        const src = fs.readFileSync(path.join(root, 'frontend', 'src', 'app', 'admin', 'security', 'page.tsx'), 'utf8');
        const load = src.slice(src.indexOf('const load = async () => {'), src.indexOf('const generateSelfSigned'));
        assert.ok(load.length > 0, 'the load function is where it was');
        assert.ok(!load.includes('/system/certs/check'), 'loading the screen must not POST /system/certs/check');
        // The certificate is generated only from the explicit button.
        assert.match(src, /const generateSelfSigned = async \(\) => \{[\s\S]*?apiPost\('\/system\/certs\/check'/);
    });

    test('the backend registers with the gateway only once it holds a cluster identity (109)', () => {
        const src = fs.readFileSync(path.join(root, 'backend', 'src', 'index.ts'), 'utf8');
        const body = src.slice(src.indexOf('const registerAll = async () => {'));
        const guard = body.indexOf('if (Object.keys(clientOpts).length === 0)');
        const firstTry = body.indexOf('await tryRegister(');
        assert.ok(guard > 0 && firstTry > 0 && guard < firstTry, 'no /register attempt without the cluster certificate');
    });
});
