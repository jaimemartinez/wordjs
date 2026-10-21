'use strict';
/**
 * The edge-disclosure fixes (see edge-disclosure.test.js) on the REAL gateway process
 * (support/gateway-process.js):
 *
 *  · a WebSocket upgrade past the per-client cap is answered 429 instead of being proxied;
 *  · a 503 for an upstream that refuses the connection names neither the upstream nor the error.
 *
 * The upgrade cap is per worker process, and the harness runs several workers, so the test sends more
 * upgrades than workers × cap and expects both completed and refused ones.
 *
 * MUTATION PROOF: drop the upgradeLimiter.allow() check in src/index.js — no 429 ever appears; put
 * `target` back into the ECONNREFUSED body — the upstream port shows up in the 503.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./support/gateway-process');

describe('the real gateway: upgrade cap and generic upstream-failure bodies', () => {
    let frontend;
    let deadBackendPort;
    let gw;
    before(async () => {
        frontend = await harness.startEchoUpstream('frontend');
        deadBackendPort = await harness.freePort(); // nothing listens here: ECONNREFUSED
        gw = await harness.bootGateway({
            upstreams: { frontend: frontend.port, backend: deadBackendPort },
            extraConfig: { rateLimit: { upgradeMax: 1, upgradeWindowMs: 60000 } },
        });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (frontend) await frontend.close();
    });

    it('refuses upgrades past the cap with 429', async () => {
        const answers = [];
        for (let i = 0; i < 12; i++) {
            const r = await harness.rawExchange({ port: gw.port, payload: harness.upgradePayload('localhost', '', '/_next/hmr') });
            answers.push(String(r.data).split('\r\n')[0]);
        }
        assert.ok(answers.some((l) => /^HTTP\/1\.1 101 /.test(l)), `some upgrades complete: ${JSON.stringify(answers)}`);
        assert.ok(answers.some((l) => /^HTTP\/1\.1 429 /.test(l)), `upgrades past the cap are refused: ${JSON.stringify(answers)}`);
    });

    it('a refused upstream answers 503 (starting or down) without naming it', async () => {
        const r = await harness.request({ port: gw.port, path: '/api/v1/posts', headers: { host: 'localhost' } });
        assert.strictEqual(r.status, 503, String(r.error));
        assert.strictEqual(r.headers['retry-after'], '10');
        const body = JSON.parse(r.body);
        assert.strictEqual(body.target, undefined);
        assert.ok(!r.body.includes(String(deadBackendPort)), `the upstream port must not appear: ${r.body}`);
        assert.ok(!/ECONNREFUSED|127\.0\.0\.1/.test(r.body), r.body);
    });
});
