/**
 * WordJS Gateway — scripts/node-join.js authenticates the gateway BEFORE the join token leaves the node.
 *
 * Enrollment hands the node the cluster's gateway secret and a CA-signed identity cert, so whoever
 * answers the tokened POST /enroll gets the keys to the cluster. The node has no trust anchor yet; the
 * operator gives it one as `--ca-hash` (the CA fingerprint the gateway prints). These tests drive the
 * REAL helpers out of node-join.js against throwaway TLS servers on ephemeral loopback ports:
 *
 *   · the real gateway (identity cert CN=gateway-internal + the cluster CA in its chain) is accepted
 *     and receives the request;
 *   · a wrong pin, a gateway that sends no CA in its chain, an impostor with its OWN CA (same subject
 *     name), an impostor that replays the REAL CA certificate next to a leaf it signed itself, and a
 *     node's own CA-signed cert (CN=backend) are all refused — and in every one of those cases the
 *     server never receives a request, i.e. the token was never sent;
 *   · the CLI refuses to start without --ca-hash unless the loudly-named opt-out is passed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const clusterCa = require('../src/cluster-ca');
const NODE_JOIN = path.resolve(__dirname, '../../scripts/node-join.js');
const { fetchPinnedCa, post, normalizeCaHash, pemFingerprint } = require(NODE_JOIN);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-node-join-pin-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// The real cluster, and an attacker who minted a CA with the very same subject name.
const real = clusterCa.ensureClusterCA(path.join(scratch, 'real'));
const evil = clusterCa.ensureClusterCA(path.join(scratch, 'evil'));
const realHash = clusterCa.caFingerprint(real.caCertPem);
const gwIdentity = clusterCa.issueIdentity({ caKeyPem: real.caKeyPem, caCertPem: real.caCertPem, cn: 'gateway-internal', sans: ['localhost'] });
const evilIdentity = clusterCa.issueIdentity({ caKeyPem: evil.caKeyPem, caCertPem: evil.caCertPem, cn: 'gateway-internal', sans: ['localhost'] });
const nodeIdentity = clusterCa.issueIdentity({ caKeyPem: real.caKeyPem, caCertPem: real.caCertPem, cn: 'backend', sans: ['127.0.0.1'] });

/** An HTTPS server on an ephemeral loopback port that records every request it receives. */
async function serve(key, cert) {
    const seen = [];
    const srv = https.createServer({ key, cert }, (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => { seen.push({ path: req.url, body }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}

const chain = (...pems) => pems.map((p) => p.trim()).join('\n') + '\n';
const BODY = { role: 'backend', token: 'wjc.backend.SECRET' };

async function enrollPinned(port, hash = realHash) {
    const ca = await fetchPinnedCa('127.0.0.1', port, hash);
    return post('127.0.0.1', port, '/enroll', BODY, { ca });
}

test('the real gateway (identity + CA chain) is authenticated and receives the request', async () => {
    const gw = await serve(gwIdentity.keyPem, chain(gwIdentity.certPem, real.caCertPem));
    try {
        const ca = await fetchPinnedCa('127.0.0.1', gw.port, realHash);
        assert.strictEqual(pemFingerprint(ca), realHash);
        assert.deepStrictEqual(await post('127.0.0.1', gw.port, '/enroll', BODY, { ca }), { ok: true });
        assert.strictEqual(gw.seen.length, 1);
        assert.match(gw.seen[0].body, /wjc\.backend\.SECRET/);
    } finally { await gw.close(); }
});

test('a wrong --ca-hash is refused and the token is never sent', async () => {
    const gw = await serve(gwIdentity.keyPem, chain(gwIdentity.certPem, real.caCertPem));
    try {
        await assert.rejects(enrollPinned(gw.port, 'f'.repeat(64)), /did not present a cluster CA matching --ca-hash/);
        assert.strictEqual(gw.seen.length, 0);
    } finally { await gw.close(); }
});

test('a gateway that sends only its leaf (no CA in the chain) is refused, not trusted', async () => {
    const gw = await serve(gwIdentity.keyPem, gwIdentity.certPem);
    try {
        await assert.rejects(enrollPinned(gw.port), /token was NOT sent/);
        assert.strictEqual(gw.seen.length, 0);
    } finally { await gw.close(); }
});

test('an impostor with its own CA (same subject name) is refused', async () => {
    const mitm = await serve(evilIdentity.keyPem, chain(evilIdentity.certPem, evil.caCertPem));
    try {
        await assert.rejects(enrollPinned(mitm.port), /did not present a cluster CA matching --ca-hash/);
        assert.strictEqual(mitm.seen.length, 0);
    } finally { await mitm.close(); }
});

test('an impostor replaying the REAL (public) CA cert next to its own leaf is refused by the verified call', async () => {
    // Phase 1 finds bytes that hash to the pin — the CA certificate is public — but the tokened call is
    // verified against that CA, and the impostor's leaf was not signed by it.
    const mitm = await serve(evilIdentity.keyPem, chain(evilIdentity.certPem, real.caCertPem));
    try {
        await assert.rejects(enrollPinned(mitm.port), { code: 'CERT_SIGNATURE_FAILURE' });
        assert.strictEqual(mitm.seen.length, 0, 'the token reached an impostor');
    } finally { await mitm.close(); }
});

test("a node's own CA-signed identity (CN=backend) cannot pose as the gateway", async () => {
    const mitm = await serve(nodeIdentity.keyPem, chain(nodeIdentity.certPem, real.caCertPem));
    try {
        await assert.rejects(enrollPinned(mitm.port), /not the gateway's \(CN=backend/);
        assert.strictEqual(mitm.seen.length, 0);
    } finally { await mitm.close(); }
});

test('post() refuses to send anything without a pinned CA (there is no unverified mode)', async () => {
    const gw = await serve(gwIdentity.keyPem, chain(gwIdentity.certPem, real.caCertPem));
    try {
        await assert.rejects(post('127.0.0.1', gw.port, '/enroll', BODY), /without a pinned cluster CA/);
        await assert.rejects(post('127.0.0.1', gw.port, '/enroll', BODY, { insecure: true }), /without a pinned cluster CA/);
        assert.strictEqual(gw.seen.length, 0);
    } finally { await gw.close(); }
});

test('normalizeCaHash accepts the printed fingerprint (and the colon form) only', () => {
    assert.strictEqual(normalizeCaHash(realHash.toUpperCase()), realHash);
    assert.strictEqual(normalizeCaHash(realHash.match(/../g).join(':')), realHash);
    assert.strictEqual(normalizeCaHash('<fingerprint>'), null);
    assert.strictEqual(normalizeCaHash(true), null);
    assert.strictEqual(normalizeCaHash(realHash.slice(2)), null);
});

const cli = (...extra) => spawnSync(process.execPath, [NODE_JOIN, '--role', 'backend', '--gateway', '127.0.0.1', '--token', 't', ...extra],
    { encoding: 'utf8', timeout: 30000 });

test('the CLI refuses to enroll without --ca-hash, even with the removed opt-out flag', () => {
    let r = cli();
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--ca-hash <sha256> is required/);
    r = cli('--insecure-skip-ca-verify');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--ca-hash <sha256> is required/);
});

test('the CLI rejects a malformed --ca-hash', () => {
    const r = cli('--ca-hash', 'abc');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--ca-hash must be the 64-character hex CA fingerprint/);
});
