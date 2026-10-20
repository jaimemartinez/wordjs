'use strict';
/**
 * Multisite: one TLS certificate per site, selected by SNI (src/site-certs.js) — on a REAL TLS listener.
 *
 * A listener with a default certificate (the main site's) and the SNI selector must hand each site's own
 * certificate to a client that names that site, the default one to any other name, pick up a certificate
 * written while it runs (no restart), and drop one that was removed. The store refuses what would break a
 * handshake or name a directory it should not: a pair that does not match, a certificate for another
 * host, a name that is not a plain DNS name.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const https = require('https');
const x509 = require('../src/x509');
const siteCerts = require('../src/site-certs');

/** A self-signed certificate for `host` (CN and SAN), as PEM (src/x509, Node's crypto). */
function selfSigned(host) {
    const keys = x509.generateRsaKeyPair(2048);
    const cert = x509.createCertificate({
        subject: [['CN', host]],
        publicKey: keys.publicKey,
        signingKey: keys.privateKey,
        notBefore: new Date(Date.now() - 60000),
        notAfter: new Date(Date.now() + 86400000),
        altNames: [host],
    });
    return { key: keys.privateKeyPem, cert };
}

let dir;
let server;
let port;
const main = selfSigned('main.example.com');
const two = selfSigned('two.example.com');
const three = selfSigned('three.example.com');

/** The CN of the certificate the listener presents for `servername`. */
function presented(servername) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
            const cn = socket.getPeerCertificate().subject.CN;
            socket.end();
            resolve(cn);
        });
        socket.on('error', reject);
    });
}

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-site-certs-'));
    const selector = siteCerts.createSniSelector({ dir, refreshMs: 50 });
    server = https.createServer({ key: main.key, cert: main.cert, SNICallback: selector.SNICallback }, (req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => {
    try { server.close(); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('without a site certificate every name gets the default certificate', async () => {
    assert.strictEqual(await presented('two.example.com'), 'main.example.com');
    assert.strictEqual(await presented('main.example.com'), 'main.example.com');
});

test("a site's certificate is served for its name, picked up without a restart", async () => {
    assert.strictEqual(siteCerts.writeSiteCert(dir, 'two.example.com', two.key, two.cert), 'written');
    assert.strictEqual(siteCerts.writeSiteCert(dir, 'two.example.com', two.key, two.cert), 'unchanged', 'the same pair is not rewritten');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(await presented('two.example.com'), 'two.example.com');
    assert.strictEqual(await presented('TWO.example.com'), 'two.example.com', 'names are matched case-insensitively');
    assert.strictEqual(await presented('three.example.com'), 'main.example.com', 'another name keeps the default');
    if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(path.join(dir, 'two.example.com', 'privkey.pem')).mode & 0o777, 0o600, 'the key is owner-only');
    }
});

test('a removed certificate is no longer served', async () => {
    siteCerts.writeSiteCert(dir, 'three.example.com', three.key, three.cert);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(await presented('three.example.com'), 'three.example.com');
    assert.strictEqual(siteCerts.removeSiteCert(dir, 'three.example.com'), true);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(await presented('three.example.com'), 'main.example.com');
});

test('the store refuses a pair that would break a handshake, and a name that is not a site address', () => {
    assert.throws(() => siteCerts.writeSiteCert(dir, 'two.example.com', three.key, two.cert), /does not belong/);
    assert.throws(() => siteCerts.writeSiteCert(dir, 'four.example.com', two.key, two.cert), /does not name four\.example\.com/);
    for (const bad of ['../evil', 'two.example.com/../x', '127.0.0.1', '*.example.com', 'localhost', '', 'a..b.com']) {
        assert.throws(() => siteCerts.writeSiteCert(dir, bad, two.key, two.cert), /not a site address/, bad);
    }
    assert.strictEqual(siteCerts.removeSiteCert(dir, '../..'), false);
});
