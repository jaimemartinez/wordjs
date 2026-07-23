/**
 * cert-manager ACME regression suite.
 *
 * WHY THIS FILE EXISTS: DNS-01 issuance was permanently broken because startDNSChallenge re-hashed
 * the value acme-client's getChallengeKeyAuthorization() had ALREADY digested per RFC 8555 §8.4 —
 * the admin UI displayed base64url(sha256(base64url(sha256(token.thumbprint)))) and no CA could
 * ever match the published TXT record. On top of that, the local pre-verify was a hard gate with
 * ~4 minutes of default backoff, so the admin request "froze" and then failed even in setups the CA
 * could have validated (hairpin NAT, split-horizon DNS).
 *
 * HOW IT AVOIDS THE green-suite-over-broken-code TRAP: the tests drive the REAL producers
 * (startDNSChallenge / resolveTxtValues / finishDNSChallenge) and stub ONLY the I/O boundary (the
 * acme-client Client instance, DNS resolvers, the gateway push). The expected TXT value is derived
 * independently with node:crypto, so a re-introduced double hash goes red here.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const certManager = require('../core/cert-manager');

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

test('startDNSChallenge returns the acme-client keyAuthorization VERBATIM as the TXT value (no re-hash)', async () => {
    const token = 'tok_' + crypto.randomBytes(8).toString('hex');
    const thumbprint = b64url(crypto.createHash('sha256').update('jwk-fixture').digest());
    // What acme-client v5 getChallengeKeyAuthorization() returns for a dns-01 challenge — the FINAL
    // RFC 8555 §8.4 TXT value: base64url(sha256(`${token}.${thumbprint}`)).
    const rfc8555TxtValue = b64url(crypto.createHash('sha256').update(`${token}.${thumbprint}`).digest());

    const challenge = { type: 'dns-01', url: 'https://ca.example/chal/1', token };
    const origInit = certManager.initClient;
    const origClient = certManager.client;
    try {
        certManager.initClient = async () => { /* no network in unit tests */ };
        certManager.client = {
            createOrder: async () => ({ url: 'https://ca.example/order/1' }),
            getAuthorizations: async () => ([{ url: 'https://ca.example/authz/1', challenges: [challenge] }]),
            getChallengeKeyAuthorization: async () => rfc8555TxtValue,
        };
        const out = await certManager.startDNSChallenge('unit-test.example', 'a@b.c');
        assert.strictEqual(out.txtRecord, '_acme-challenge.unit-test.example');
        assert.strictEqual(out.txtValue, rfc8555TxtValue,
            'txtValue must be the keyAuthorization acme-client already digested — hashing it again breaks DNS-01 issuance');
    } finally {
        certManager.initClient = origInit;
        certManager.client = origClient;
    }
});

test('resolveTxtValues joins multi-chunk TXT records per record and follows CNAME chains', async () => {
    const fake = {
        resolveCname: async (name: string) => {
            if (name === '_acme-challenge.unit-test.example') return ['delegated.dns-provider.example'];
            const err: any = new Error('queryCname ENODATA'); err.code = 'ENODATA'; throw err;
        },
        resolveTxt: async (name: string) => {
            assert.strictEqual(name, 'delegated.dns-provider.example', 'must resolve TXT at the CNAME target');
            return [['first-chunk-', 'second-chunk'], ['other-record']];
        },
    };
    const values = await certManager.resolveTxtValues(fake, '_acme-challenge.unit-test.example');
    assert.deepStrictEqual(values, ['first-chunk-second-chunk', 'other-record']);
});

test('resolveTxtValues does not follow CNAMEs beyond the depth cap (no infinite loop)', async () => {
    const fake = {
        resolveCname: async (name: string) => [name], // pathological self-CNAME
        resolveTxt: async () => [['v']],
    };
    const values = await certManager.resolveTxtValues(fake, 'loop.example');
    assert.deepStrictEqual(values, ['v']);
});

test('finishDNSChallenge treats local pre-verify as advisory and AWAITS the gateway push', async () => {
    const calls: string[] = [];
    const domain = 'unit-test-finish.invalid';
    const origInit = certManager.initClient;
    const origClient = certManager.client;
    const origUpdate = certManager.updateSSLConfig;
    try {
        certManager.initClient = async () => { /* no network */ };
        certManager.updateSSLConfig = async () => {
            // Force a real async boundary so a missing `await` at the call site returns before this
            // line runs and the ordering assertion below goes red.
            await new Promise((r) => setImmediate(r));
            calls.push('updateSSLConfig');
        };
        certManager.client = {
            // Local pre-verify FAILS (split-horizon resolver can't see the record) — the flow must
            // still hand the order to the CA instead of aborting.
            verifyChallenge: async () => { calls.push('verifyChallenge'); throw new Error('local resolver cannot see the record'); },
            completeChallenge: async () => { calls.push('completeChallenge'); },
            waitForValidStatus: async () => { calls.push('waitForValidStatus'); },
            finalizeOrder: async () => { calls.push('finalizeOrder'); return { url: 'https://ca.example/order/1' }; },
            getCertificate: async () => { calls.push('getCertificate'); return '-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n'; },
        };
        const res = await certManager.finishDNSChallenge({
            domain,
            authzUrl: 'https://ca.example/authz/1',
            orderUrl: 'https://ca.example/order/1',
            challenge: { type: 'dns-01', url: 'https://ca.example/chal/1', token: 't' },
        }, 'a@b.c');
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(calls, [
            'verifyChallenge', 'completeChallenge', 'waitForValidStatus', 'finalizeOrder', 'getCertificate', 'updateSSLConfig',
        ]);
    } finally {
        certManager.initClient = origInit;
        certManager.client = origClient;
        certManager.updateSSLConfig = origUpdate;
        fs.rmSync(path.resolve(__dirname, '../../ssl/live', domain), { recursive: true, force: true });
    }
});

test('checkDNSPropagation trims the expected value and rejects an empty one', async () => {
    assert.strictEqual(await certManager.checkDNSPropagation('unit-test.example', ''), false);
    assert.strictEqual(await certManager.checkDNSPropagation('unit-test.example', '   '), false);
});

/**
 * The three tests below cover the SECOND live failure this file exists for: an operator published a
 * perfectly correct TXT record, the propagation check found it, and the CA then answered
 * "No such challenge".
 *
 * CAUSE: `directoryUrl` was process-global sticky state on a module-level singleton — `if (useStaging)`
 * with no else — so a staging auto-renewal (renewIfDue → provisionAutoHTTP → initClient(…, true))
 * pinned the whole process to staging, and the constructor reset it to production on the next restart.
 * The two halves of the two-step DNS-01 flow could therefore address DIFFERENT CAs, and an order's
 * challenge URL only exists at the one that minted it.
 */
test('initClient does not stay pinned to staging once a staging order has run', async () => {
    const acmeLib = require('acme-client');
    const OrigClient = acmeLib.Client;
    const origKeyPath = certManager.accountKeyPath;
    const tmpKey = path.join(require('os').tmpdir(), `wjs-acct-${Date.now()}.key`);
    try {
        // Stub ONLY the network boundary: the client constructor and its account registration.
        acmeLib.Client = function () { return { createAccount: async () => ({}) }; };
        certManager.accountKeyPath = tmpKey;

        await certManager.initClient('a@b.c', true);
        assert.strictEqual(certManager.directoryUrl, acmeLib.directory.letsencrypt.staging,
            'a staging order must address the staging directory');

        await certManager.initClient('a@b.c', false);
        assert.strictEqual(certManager.directoryUrl, acmeLib.directory.letsencrypt.production,
            'a production order after a staging one must go BACK to production — leaving it pinned is ' +
            'what silently sent "production" certificates to staging and broke the two-step flow');
    } finally {
        acmeLib.Client = OrigClient;
        certManager.accountKeyPath = origKeyPath;
        try { fs.unlinkSync(tmpKey); } catch { /* may not have been created */ }
    }
});

test('startDNSChallenge reports the directory the order was minted at', async () => {
    const origInit = certManager.initClient;
    const origClient = certManager.client;
    const origDir = certManager.directoryUrl;
    try {
        certManager.initClient = async () => { certManager.directoryUrl = 'https://minted-here.example/dir'; };
        certManager.client = {
            createOrder: async () => ({ url: 'https://ca.example/order/9' }),
            getAuthorizations: async () => ([{ url: 'https://ca.example/authz/9', challenges: [{ type: 'dns-01', url: 'https://ca.example/chal/9', token: 't' }] }]),
            getChallengeKeyAuthorization: async () => 'value',
        };
        const out = await certManager.startDNSChallenge('unit-test.example', 'a@b.c');
        assert.strictEqual(out.directoryUrl, 'https://minted-here.example/dir',
            'step1Data must carry the CA that minted the order, or the finish step cannot pair with it');
    } finally {
        certManager.initClient = origInit;
        certManager.client = origClient;
        certManager.directoryUrl = origDir;
    }
});

test('finishDNSChallenge re-inits against the minting CA, not the callers staging flag', async () => {
    const origInit = certManager.initClient;
    const origClient = certManager.client;
    let seen: any = null;
    try {
        certManager.initClient = async (email: string, useStaging: boolean, override: string) => {
            seen = { email, useStaging, override };
        };
        certManager.client = {
            verifyChallenge: async () => true,
            completeChallenge: async () => ({}),
            waitForValidStatus: async () => ({}),
            // Stop the flow right after the pairing decision — CSR/finalize are covered elsewhere.
            getCertificate: async () => { throw new Error('STOP_AFTER_PAIRING'); },
        };
        const step1Data = {
            domain: 'unit-test.example',
            authzUrl: 'https://staging.ca.example/authz/1',
            challenge: { type: 'dns-01', url: 'https://staging.ca.example/chal/1', token: 't' },
            directoryUrl: 'https://staging.ca.example/dir',
        };
        // The caller says "production" (staging=false) — exactly what the UI always sends — while the
        // challenge was minted at staging. The minting CA must win.
        await certManager.finishDNSChallenge(step1Data, 'a@b.c', false).catch(() => { /* expected: stops later */ });

        assert.ok(seen, 'initClient must have been called');
        assert.strictEqual(seen.override, 'https://staging.ca.example/dir',
            'finish must address the CA that issued the challenge; using the flag instead is what produced ' +
            '"No such challenge" after the operator had already published the correct TXT record');
    } finally {
        certManager.initClient = origInit;
        certManager.client = origClient;
    }
});
