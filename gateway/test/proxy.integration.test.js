const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const forge = require('node-forge');

const { createProxyServer, createUpstreamAgent } = require('../src/proxy-config');

// --- Cert helpers (node-forge) -------------------------------------------------

function makeCA() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'test-ca' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(ca, cn) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1000);
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.sign(ca.keys.privateKey, forge.md.sha256.create());
    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

// =============================================================================
// 1. Host / changeOrigin (plain HTTP)
// =============================================================================
test('changeOrigin rewrites upstream Host and xfwd preserves original', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ host: req.headers.host, xfh: req.headers['x-forwarded-host'] }));
    });
    const upstreamPort = await listen(upstream);

    const proxy = createProxyServer();
    const gateway = http.createServer((req, res) => {
        proxy.web(req, res, { target: `http://127.0.0.1:${upstreamPort}` });
    });
    const gatewayPort = await listen(gateway);

    t.after(async () => { await close(gateway); await close(upstream); proxy.close(); });

    const body = await new Promise((resolve, reject) => {
        const r = http.request(
            { host: '127.0.0.1', port: gatewayPort, path: '/', headers: { Host: 'example.com' } },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(JSON.parse(data)));
            }
        );
        r.on('error', reject);
        r.end();
    });

    assert.strictEqual(body.host, `127.0.0.1:${upstreamPort}`, 'changeOrigin should rewrite Host to target');
    assert.strictEqual(body.xfh, 'example.com', 'xfwd should preserve original Host as X-Forwarded-Host');
});

// Shared CA + client for the mTLS cases
const realCA = makeCA();
const clientLeaf = makeLeaf(realCA, 'gateway-internal');
const agent = createUpstreamAgent({ ca: realCA.pem, key: clientLeaf.key, cert: clientLeaf.cert });

function httpsGet(port, agent) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            { host: '127.0.0.1', port, path: '/', method: 'GET', agent },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// =============================================================================
// 2. mTLS positive: real CA, CN=backend -> 200 ok
// =============================================================================
test('mTLS positive: trusted CA + allowed CN succeeds', async (t) => {
    const serverLeaf = makeLeaf(realCA, 'backend');
    const upstream = https.createServer(
        { key: serverLeaf.key, cert: serverLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    const result = await httpsGet(port, agent);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, 'ok');
});

// =============================================================================
// 3. mTLS MITM negative: rogue CA -> fails
// =============================================================================
test('mTLS MITM negative: rogue CA is rejected', async (t) => {
    const rogueCA = makeCA();
    const rogueLeaf = makeLeaf(rogueCA, 'backend'); // same CN, wrong CA
    const upstream = https.createServer(
        { key: rogueLeaf.key, cert: rogueLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    await assert.rejects(
        () => httpsGet(port, agent),
        (err) => {
            assert.ok(err.code || /verify|signature|self.signed|chain/i.test(err.message),
                `expected TLS verify error, got: ${err.code} ${err.message}`);
            return true;
        }
    );
});

// =============================================================================
// 4. mTLS wrong-CN negative: real CA but CN=evil-service -> CN policy error
// =============================================================================
test('mTLS wrong-CN negative: disallowed CN is rejected by checkServerIdentity', async (t) => {
    const evilLeaf = makeLeaf(realCA, 'evil-service');
    const upstream = https.createServer(
        { key: evilLeaf.key, cert: evilLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    await assert.rejects(
        () => httpsGet(port, agent),
        (err) => {
            assert.match(err.message, /not in allowed identities|evil-service/);
            return true;
        }
    );
});
