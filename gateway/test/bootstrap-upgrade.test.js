'use strict';
/**
 * BEFORE THE WIZARD HAS RUN, A WEBSOCKET GOES WHERE THE PAGE WENT.
 *
 * On a fresh split install nothing can register with the gateway: registration rides the mTLS control
 * plane, and the certificates for it are issued by the install wizard. Until then the gateway reaches the
 * local backend and frontend through its pre-install bootstrap (src/index.js bootstrapTarget). The HTTP
 * path used it, the 'upgrade' handler did not, so in development the wizard page loaded but its Next.js
 * HMR socket (/_next/hmr) was destroyed on arrival and the page never became interactive: the wizard's
 * "Next Step" button stayed disabled.
 *
 * Tested on the REAL gateway process with an empty registry (support/gateway-process.js).
 *
 * MUTATION PROOF (applied to the real file, watched to fail, restored): drop `|| bootstrapTarget(req.url)`
 * from the 'upgrade' handler in src/index.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./support/gateway-process');

describe('the real gateway before anything has registered', () => {
    let frontend;
    let backend;
    let gw;
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        backend = await harness.startEchoUpstream('backend');
        gw = await harness.bootGateway({ upstreams: { frontend: frontend.port, backend: backend.port }, registered: false });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
        if (backend) await backend.close();
    });

    it('serves the wizard page from the local frontend', async () => {
        const r = await harness.request({ port: gw.port, path: '/install', headers: { host: 'localhost' } });
        assert.strictEqual(r.status, 200, String(r.error));
        assert.strictEqual(JSON.parse(r.body).upstream, 'frontend');
    });

    it('hands the Next.js HMR WebSocket to the same local frontend', async () => {
        const seen = frontend.upgrades.length;
        const r = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', '', '/_next/hmr') });
        assert.match(r.data, /^HTTP\/1\.1 101 /, `expected a completed upgrade, got: ${JSON.stringify(r.data)}`);
        assert.strictEqual(frontend.upgrades.length, seen + 1);
        assert.strictEqual(frontend.upgrades[frontend.upgrades.length - 1].url, '/_next/hmr');
        assert.strictEqual(backend.upgrades.length, 0, 'a frontend path never reaches the backend');
    });

    it('sends a backend-owned upgrade to the local backend', async () => {
        const r = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', '', '/api/v1/ws') });
        assert.match(r.data, /^HTTP\/1\.1 101 /, `expected a completed upgrade, got: ${JSON.stringify(r.data)}`);
        assert.strictEqual(backend.upgrades[backend.upgrades.length - 1].url, '/api/v1/ws');
    });
});
