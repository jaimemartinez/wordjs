/**
 * WordJS Gateway — GET /revalidate-secret: a frontend node repairs its own purge secret.
 *
 * The cache-purge secret rides ENROLLMENT: `/enroll` hands it to every joining node. That leaves one
 * deployment permanently broken and silent about it — a cluster whose frontend enrolled BEFORE the
 * secret existed. It has certificates, gateway wiring, everything except the secret, so every purge
 * the gateway fans out is refused with 403 and the site falls back to TTL freshness for good. The only
 * documented cure was for an operator to remember to re-enroll the node.
 *
 * A node holding a cluster-CA `CN=frontend` certificate can just ask for it, over the same mTLS
 * channel it uses to register. That is not a new trust decision: the same listener already treats
 * `CN=backend` as sufficient authorization to REQUEST a purge, and enrollment would have handed this
 * very node the secret anyway.
 *
 * These tests do a REAL mTLS handshake with real cluster-CA-signed certificates against the REAL
 * handler (`purge.mountRevalidateSecret`) behind the REAL identity gate (`identity.requireIdentity`) —
 * the same two functions src/index.js mounts on the internal listener, not a reconstruction of them.
 *
 * MUTATION PROOF: against the pre-fix gateway `mountRevalidateSecret` does not exist and every test
 * fails at require. Widen the gate to ['frontend','backend'] and the backend-identity test fails;
 * drop the gate entirely and the no-client-certificate test still fails at the handshake, which is the
 * point — the TLS layer is the outer wall and the CN allowlist is the inner one.
 */

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const express = require('express');
const forge = require('node-forge');

const purge = require('../src/purge');

// --- Cert helpers (node-forge), same shape as proxy.integration.test.js -------------------------

function makeCA() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'WordJS Cluster Root CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(ca, cn, withLoopbackSan = false) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1000);
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(ca.cert.subject.attributes);
    if (withLoopbackSan) {
        cert.setExtensions([{
            name: 'subjectAltName',
            altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]
        }]);
    }
    cert.sign(ca.keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** GET /revalidate-secret as `identity` (or as nobody). Resolves with { status, body } or { error }. */
function ask(port, ca, identity) {
    return new Promise((resolve) => {
        const req = https.request({
            method: 'GET',
            hostname: '127.0.0.1',
            port,
            path: '/revalidate-secret',
            ca,
            key: identity && identity.key,
            cert: identity && identity.cert,
            rejectUnauthorized: true,
            timeout: 5000,
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ error: e.message }));
        req.end();
    });
}

test('GET /revalidate-secret — a CN=frontend node, and only a CN=frontend node, may fetch it', async (t) => {
    const ca = makeCA();
    const server_id = makeLeaf(ca, 'gateway-internal', true);
    const frontend = makeLeaf(ca, 'frontend');
    const backend = makeLeaf(ca, 'backend');

    // The gateway's cluster-wide secret, minted lazily exactly as src/index.js does.
    let minted = null;
    let mintCalls = 0;
    const ensureSecret = () => { mintCalls++; return (minted = minted || 'f'.repeat(64)); };

    const app = express();
    purge.mountRevalidateSecret(app, { ensureSecret, logger: silentLogger });

    // The internal listener's real posture: a client certificate is REQUIRED and must chain to the
    // cluster CA. Express never sees an unsigned peer.
    const server = https.createServer({
        key: server_id.key, cert: server_id.cert, ca: ca.pem,
        requestCert: true, rejectUnauthorized: true,
    }, app);
    const port = await listen(server);
    t.after(() => close(server));

    await t.test('the frontend identity gets the secret', async () => {
        const res = await ask(port, ca.pem, frontend);
        assert.strictEqual(res.status, 200, res.error || res.body);
        assert.strictEqual(JSON.parse(res.body).revalidateSecret, 'f'.repeat(64));
    });

    await t.test('it is the SAME value the purge fan-out presents — one cluster secret, not two', async () => {
        const first = JSON.parse((await ask(port, ca.pem, frontend)).body).revalidateSecret;
        const second = JSON.parse((await ask(port, ca.pem, frontend)).body).revalidateSecret;
        assert.strictEqual(first, second);
        assert.strictEqual(first, ensureSecret(), 'the endpoint must not mint a secret of its own');
        assert.ok(mintCalls >= 3, 'the value comes from ensureSecret(), not a cached copy of its own');
    });

    await t.test('a CN=backend identity is refused — the CN is the authorization, not the CA alone', async () => {
        const res = await ask(port, ca.pem, backend);
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status || res.error}`);
        assert.ok(!/f{16}/.test(res.body), 'the refusal must not leak the secret');
    });

    await t.test('no client certificate never reaches the handler at all', async () => {
        const res = await ask(port, ca.pem, null);
        assert.ok(res.error, 'the TLS handshake must fail, not return a status');
        assert.ok(!res.body, 'nothing is served without a cluster identity');
    });
});

test('GET /revalidate-secret fails CLOSED when the gateway has no secret to give', async (t) => {
    const ca = makeCA();
    const server_id = makeLeaf(ca, 'gateway-internal', true);
    const frontend = makeLeaf(ca, 'frontend');

    const app = express();
    // A gateway that cannot mint or persist a secret must not answer 200 with an empty one — the node
    // would write junk into its config and every purge would 403 with a *different* cause.
    purge.mountRevalidateSecret(app, { ensureSecret: () => null, logger: silentLogger });

    const server = https.createServer({
        key: server_id.key, cert: server_id.cert, ca: ca.pem,
        requestCert: true, rejectUnauthorized: true,
    }, app);
    const port = await listen(server);
    t.after(() => close(server));

    const res = await ask(port, ca.pem, frontend);
    assert.strictEqual(res.status, 503, res.error || res.body);
});

test('a throwing ensureSecret answers 500 instead of taking the gateway down', async (t) => {
    const ca = makeCA();
    const server_id = makeLeaf(ca, 'gateway-internal', true);
    const frontend = makeLeaf(ca, 'frontend');

    const app = express();
    // This handler runs in the PRIMARY, which installs no unhandledRejection/uncaughtException net —
    // the same reason /purge is wrapped. A config write blowing up must not kill the cluster's proxy.
    purge.mountRevalidateSecret(app, {
        ensureSecret: () => { throw new Error('config volume is read-only'); },
        logger: silentLogger,
    });

    const server = https.createServer({
        key: server_id.key, cert: server_id.cert, ca: ca.pem,
        requestCert: true, rejectUnauthorized: true,
    }, app);
    const port = await listen(server);
    t.after(() => close(server));

    const res = await ask(port, ca.pem, frontend);
    assert.strictEqual(res.status, 500, res.error || res.body);
});
