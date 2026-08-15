/**
 * core/client-ip — the single honest client-IP resolution behind every rate limiter and the login
 * lockout (audit 2026-08-08, P1). login-throttle-xff.test.ts proves the END-TO-END behaviour on the
 * auth route; this pins the HELPER the index.ts limiters also key on, because those six limiters
 * (apiLimiter, authLimiter, loginIpLimiter, uploadLimiter, formsSubmitLimiter, setupLimiter) now use
 * `keyGenerator: (req) => clientIp(req)` and nothing else tests that path.
 *
 * The load-bearing property: in the direct monolith (no fronting proxy) X-Forwarded-For is
 * attacker-controlled noise and MUST be ignored — the key is the TCP peer, which a remote client
 * cannot forge. Behind the gateway exactly one hop is trusted. An operator override always wins.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const config = require('../config/app');

// Fresh module each case — resolveTrustProxy reads process.env and config at call time, but caching
// the require is fine; we mutate env/config between cases and restore after.
const { clientIp, resolveTrustProxy, trustProxyConfigured, normalizeTrustProxy } = require('../core/client-ip');

const req = (ip: string, xffPeer: string) => ({ ip, socket: { remoteAddress: xffPeer } });

describe('core/client-ip', () => {
    let savedEmbedded: any, savedEnvTrust: any, savedCfgTrust: any;
    beforeEach(() => {
        savedEmbedded = process.env.WORDJS_EMBEDDED;
        savedEnvTrust = process.env.WORDJS_TRUST_PROXY;
        savedCfgTrust = config.trustProxy;
        delete process.env.WORDJS_EMBEDDED;
        delete process.env.WORDJS_TRUST_PROXY;
        delete config.trustProxy;
    });
    afterEach(() => {
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
        if (savedEnvTrust === undefined) delete process.env.WORDJS_TRUST_PROXY; else process.env.WORDJS_TRUST_PROXY = savedEnvTrust;
        if (savedCfgTrust === undefined) delete config.trustProxy; else config.trustProxy = savedCfgTrust;
    });

    it('EMBEDDED monolith: trusts nothing, keys on the socket peer, ignores X-Forwarded-For', () => {
        process.env.WORDJS_EMBEDDED = '1';
        assert.strictEqual(resolveTrustProxy(), false);
        assert.strictEqual(trustProxyConfigured(), false);
        // req.ip is the spoofed XFF hop Express would compute if it trusted the header; it MUST be ignored.
        assert.strictEqual(clientIp(req('203.0.113.9', '10.9.9.9')), '10.9.9.9');
    });

    it('GATEWAY mode (not embedded, no override): trusts one hop, uses req.ip', () => {
        assert.strictEqual(resolveTrustProxy(), 1);
        assert.strictEqual(trustProxyConfigured(), true);
        assert.strictEqual(clientIp(req('198.51.100.7', '10.0.0.1')), '198.51.100.7');
    });

    it('operator override wins over the mode default, from config or env', () => {
        process.env.WORDJS_EMBEDDED = '1';         // would default to false…
        config.trustProxy = true;                   // …but the operator fronts it with their own proxy
        assert.strictEqual(resolveTrustProxy(), true);
        assert.strictEqual(clientIp(req('198.51.100.7', '10.0.0.1')), '198.51.100.7');

        delete config.trustProxy;
        process.env.WORDJS_TRUST_PROXY = 'false';    // explicit "trust nothing" even outside embedded
        assert.strictEqual(resolveTrustProxy(), false);
        assert.strictEqual(clientIp(req('198.51.100.7', '10.0.0.1')), '10.0.0.1');
    });

    it('normalizes string trust-proxy values (env is always a string)', () => {
        assert.strictEqual(normalizeTrustProxy('true'), true);
        assert.strictEqual(normalizeTrustProxy('false'), false);
        assert.strictEqual(normalizeTrustProxy('2'), 2);
        assert.deepStrictEqual(normalizeTrustProxy('10.0.0.0/8, 172.16.0.0/12'), ['10.0.0.0/8', '172.16.0.0/12']);
        assert.strictEqual(normalizeTrustProxy('loopback'), 'loopback');
    });

    it('falls back to the socket peer when req.ip is missing', () => {
        assert.strictEqual(clientIp({ socket: { remoteAddress: '10.1.2.3' } }), '10.1.2.3');
        assert.strictEqual(clientIp({ connection: { remoteAddress: '10.1.2.4' } }), '10.1.2.4');
        assert.strictEqual(clientIp({}), '');
    });
});
