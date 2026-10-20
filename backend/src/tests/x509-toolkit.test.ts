/**
 * The X.509 toolkit that replaced node-forge (backend/src/core/x509.js, gateway/src/x509.js,
 * setup/x509.js) — and the promise that an UPGRADE does not break a site's existing PKI.
 *
 * node-forge built every cluster CA, service identity and installer certificate WordJS has ever
 * written. Installed sites keep those files: a gateway keeps cluster-ca.key and signs enrolment CSRs with
 * it for years, and every service presents the identity it was issued at install time. So the fixtures
 * in fixtures/legacy-forge-pki.json are PEMs produced by the node-forge code exactly as v2.7.0 shipped it
 * (the gateway's cluster CA, `npm run setup`, the backend installer's certManager), and the tests drive the
 * REAL producers of this release against them: the gateway's issueIdentity / signCsr / ensureClusterCA,
 * the backend installer's generateServiceCert, setup's generateCerts, and /health's mTLS expiry probe.
 * Everything is judged by OpenSSL (crypto.X509Certificate, a real TLS handshake), never by the toolkit.
 *
 * MUTATION PROOF (each run against this file):
 *   · issuer rebuilt from attributes instead of copied   → the legacy certManager CA (CN + O) chain fails;
 *   · createCertificate skips the CA key/cert match      → "a CA key that is not the CA's" goes green-wrong;
 *   · uint() keeps a redundant leading zero               → the serial test fails (OpenSSL refuses the cert);
 *   · keyUsage bit order reversed                        → the keyUsage test fails;
 *   · parseCsr accepts trailing bytes                    → the strict-parser test fails.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');

const REPO = path.resolve(__dirname, '../../..');
const x509 = require('../core/x509');
const clusterCa = require(path.join(REPO, 'gateway/src/cluster-ca'));
const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-forge-pki.json'), 'utf8'));

const LEGACY_CAS = [
    { label: 'gateway cluster CA (cluster:init)', crt: 'gateway-cluster-ca.crt', key: 'gateway-cluster-ca.key', leaf: 'gateway-internal' },
    { label: 'setup CA (npm run setup)', crt: 'setup-cluster-ca.crt', key: 'setup-cluster-ca.key', leaf: 'setup-backend' },
    { label: 'backend installer CA (certManager, CN + O)', crt: 'certmanager-cluster-ca.crt', key: 'certmanager-cluster-ca.key', leaf: 'certmanager-backend' },
];

const verifiedBy = (certPem: string, caPem: string) => new crypto.X509Certificate(certPem).verify(new crypto.X509Certificate(caPem).publicKey);

/** A real mutual-TLS handshake: `server` and `client` identities, both trusted through `ca` only. */
function handshake(ca: string, server: { key: string; cert: string }, client: { key: string; cert: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        const srv = tls.createServer({ key: server.key, cert: server.cert, ca, requestCert: true, rejectUnauthorized: true }, (sock: any) => {
            const peer = sock.getPeerCertificate();
            sock.end();
            srv.close();
            resolve(peer.subject.CN);
        });
        srv.on('tlsClientError', (e: Error) => { srv.close(); reject(e); });
        srv.listen(0, '127.0.0.1', () => {
            const c = tls.connect({ port: srv.address().port, host: '127.0.0.1', servername: 'localhost', ca, key: client.key, cert: client.cert, rejectUnauthorized: true });
            c.on('error', (e: Error) => { srv.close(); reject(e); });
            c.on('data', () => { /* drain */ });
        });
    });
}

describe('the three copies of the toolkit are one file', () => {
    it('backend, gateway and setup ship byte-identical x509.js', () => {
        const a = fs.readFileSync(path.join(REPO, 'backend/src/core/x509.js'));
        for (const other of ['gateway/src/x509.js', 'setup/x509.js']) {
            assert.ok(a.equals(fs.readFileSync(path.join(REPO, other))), `${other} drifted from backend/src/core/x509.js — copy it over`);
        }
    });
});

describe('a PKI made by node-forge on an older release keeps working after the upgrade', () => {
    for (const ca of LEGACY_CAS) {
        describe(ca.label, () => {
            const caPem = LEGACY[ca.crt];
            const caKey = LEGACY[ca.key];
            const oldLeaf = { key: LEGACY[`${ca.leaf}.key`], cert: LEGACY[`${ca.leaf}.crt`] };

            it('the old CA, key and identity load in OpenSSL, and the old identity chains to the old CA', () => {
                assert.ok(new crypto.X509Certificate(caPem).ca);
                assert.ok(new crypto.X509Certificate(caPem).checkPrivateKey(crypto.createPrivateKey(caKey)));
                assert.ok(new crypto.X509Certificate(oldLeaf.cert).checkPrivateKey(crypto.createPrivateKey(oldLeaf.key)));
                assert.ok(verifiedBy(oldLeaf.cert, caPem));
            });

            it('the gateway issues a NEW identity from the old CA (issueIdentity) that chains to it, issuer byte-identical', () => {
                const id = clusterCa.issueIdentity({ caKeyPem: caKey, caCertPem: caPem, cn: 'backend', sans: ['10.0.0.6'] });
                const cert = new crypto.X509Certificate(id.certPem);
                assert.ok(verifiedBy(id.certPem, caPem), 'the new identity is not signed by the existing CA');
                assert.strictEqual(cert.issuer, new crypto.X509Certificate(caPem).subject);
                assert.ok(cert.checkIssued(new crypto.X509Certificate(caPem)), 'OpenSSL does not consider the old CA the issuer');
                assert.strictEqual(cert.subject, 'CN=backend');
            });

            it('an enrolment CSR (openssl shape) is signed by the old CA', () => {
                const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
                const csr = x509.createCsr({ privateKey, subject: [['CN', 'frontend']] });
                const certPem = clusterCa.signCsr({ caKeyPem: caKey, caCertPem: caPem, csrPem: csr, cn: 'frontend', sans: ['node2.example.internal'] });
                assert.ok(verifiedBy(certPem, caPem));
                assert.match(new crypto.X509Certificate(certPem).subjectAltName, /DNS:node2\.example\.internal/);
            });

            it('an OLD identity and a NEW one complete a mutual-TLS handshake through the old CA, both directions', async () => {
                const id = clusterCa.issueIdentity({ caKeyPem: caKey, caCertPem: caPem, cn: 'frontend', sans: [] });
                const fresh = { key: id.keyPem, cert: id.certPem };
                assert.strictEqual(await handshake(caPem, oldLeaf, fresh), 'frontend');
                assert.strictEqual(await handshake(caPem, fresh, oldLeaf), new crypto.X509Certificate(oldLeaf.cert).subject.split('\n')[0].replace('CN=', ''));
            });
        });
    }

    it('ensureClusterCA keeps a cluster CA an older release left on disk — it never mints a new one over it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-legacy-ca-'));
        try {
            fs.writeFileSync(path.join(dir, 'cluster-ca.crt'), LEGACY['gateway-cluster-ca.crt']);
            fs.writeFileSync(path.join(dir, 'cluster-ca.key'), LEGACY['gateway-cluster-ca.key']);
            const got = clusterCa.ensureClusterCA(dir);
            assert.strictEqual(got.created, false);
            assert.strictEqual(got.caCertPem, LEGACY['gateway-cluster-ca.crt']);
            assert.strictEqual(clusterCa.caFingerprint(got.caCertPem), new crypto.X509Certificate(LEGACY['gateway-cluster-ca.crt']).fingerprint256.replace(/:/g, '').toLowerCase());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the backend installer (certManager.generateServiceCert) issues from an old CA that carries CN + O', () => {
        const certManager = require('../core/certManager');
        const name = `x509-legacy-test-${process.pid}`;
        try {
            const out = certManager.generateServiceCert(name, LEGACY['certmanager-cluster-ca.key'], LEGACY['certmanager-cluster-ca.crt'], ['backend.example.test']);
            const cert = new crypto.X509Certificate(out.cert);
            assert.ok(verifiedBy(out.cert, LEGACY['certmanager-cluster-ca.crt']));
            assert.strictEqual(cert.issuer, 'CN=WordJS Cluster Root CA\nO=WordJS Internal Cluster');
            assert.strictEqual(cert.subject, `CN=${name}\nO=WordJS Service`);
            assert.match(cert.subjectAltName, /DNS:localhost, IP Address:127\.0\.0\.1, DNS:backend\.example\.test/);
            assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(out.key)));
            assert.match(out.key, /^-----BEGIN RSA PRIVATE KEY-----/, 'keys keep the PKCS#1 format older releases wrote');
        } finally {
            for (const ext of ['key', 'crt']) fs.rmSync(path.join(certManager.CERTS_DIR, `${name}.${ext}`), { force: true });
        }
    });

    it('/health reads the expiry of a node-forge identity (SystemHealth.checkMtls)', async () => {
        const config = require('../config/app');
        const Health = require('../core/system-health');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-legacy-health-'));
        const saved = { ...config.mtls };
        try {
            fs.writeFileSync(path.join(dir, 'backend.crt'), LEGACY['setup-backend.crt']);
            fs.writeFileSync(path.join(dir, 'cluster-ca.crt'), LEGACY['setup-cluster-ca.crt']);
            config.mtls.cert = path.join(dir, 'backend.crt');
            config.mtls.ca = path.join(dir, 'cluster-ca.crt');
            const status = await Health.checkMtls();
            assert.strictEqual(status.status, 'OK');
            assert.ok(status.expiry instanceof Date);
            assert.strictEqual(status.expiry.getTime(), new Date(new crypto.X509Certificate(LEGACY['setup-backend.crt']).validTo).getTime());

            fs.writeFileSync(path.join(dir, 'backend.crt'), 'not a certificate');
            assert.strictEqual((await Health.checkMtls()).status, 'INVALID_FORMAT');
        } finally {
            Object.assign(config.mtls, saved);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('setup (npm run setup) makes a PKI OpenSSL accepts end to end', () => {
    let dir: string;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-setup-pki-')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('a CA plus three identities, each chaining to the CA, with the recipe the gateway uses', async () => {
        const Setup = require(path.join(REPO, 'setup/index.js'));
        const s = new Setup(dir);
        const write = process.stdout.write;
        (process.stdout as any).write = () => true;
        try {
            await s.init();
            await s.generateCerts('www.example.test');
        } finally {
            (process.stdout as any).write = write;
        }
        const read = (f: string) => fs.readFileSync(path.join(s.genCertsDir, f), 'utf8');
        const ca = new crypto.X509Certificate(read('cluster-ca.crt'));
        assert.ok(ca.ca);
        assert.strictEqual(ca.subject, 'CN=WordJS Cluster Root CA');
        for (const [id, host] of [['gateway-internal', 'gateway.example.test'], ['backend', 'backend.example.test'], ['frontend', 'frontend.example.test']]) {
            const cert = new crypto.X509Certificate(read(`${id}.crt`));
            assert.ok(cert.verify(ca.publicKey), `${id} is not signed by the CA`);
            assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(read(`${id}.key`))));
            assert.strictEqual(cert.subject, `CN=${id}`);
            assert.strictEqual(cert.ca, false);
            assert.strictEqual(cert.subjectAltName, `DNS:localhost, IP Address:127.0.0.1, DNS:${host}`);
            assert.deepStrictEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
        }
        assert.strictEqual(await handshake(read('cluster-ca.crt'), { key: read('gateway-internal.key'), cert: read('gateway-internal.crt') },
            { key: read('backend.key'), cert: read('backend.crt') }), 'backend');
    });
});

describe('the encoder', () => {
    const ca = x509.generateRsaKeyPair(2048);
    const caPem: string = x509.createCertificate({
        subject: [['CN', 'Encoder Test CA'], ['O', 'WordJS'], ['C', 'ES']],
        publicKey: ca.publicKey, signingKey: ca.privateKey,
        notAfter: new Date(Date.now() + 864e5), ca: true, keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const leafKeys = x509.generateRsaKeyPair(2048);
    const leaf = (extra: any) => x509.createCertificate({
        subject: [['CN', 'leaf']], issuerCertPem: caPem, publicKey: leafKeys.publicKey, signingKey: ca.privateKeyPem,
        notAfter: new Date(Date.now() + 864e5), ...extra,
    });

    it('names, keyUsage, extKeyUsage and basicConstraints read back exactly through OpenSSL', () => {
        const c = new crypto.X509Certificate(caPem);
        assert.strictEqual(c.subject, 'CN=Encoder Test CA\nO=WordJS\nC=ES');
        assert.strictEqual(c.issuer, c.subject);
        assert.ok(c.ca);
        const l = new crypto.X509Certificate(leaf({ ca: false, keyUsage: ['digitalSignature', 'keyEncipherment'], extKeyUsage: ['serverAuth', 'clientAuth'] }));
        assert.strictEqual(l.ca, false);
        assert.deepStrictEqual(l.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
        // keyUsage bits as OpenSSL reports them (the text form names each set bit).
        const text = require('child_process').spawnSync('openssl', ['x509', '-noout', '-ext', 'keyUsage'], { input: leaf({ keyUsage: ['digitalSignature', 'keyEncipherment'] }), encoding: 'utf8' });
        if (text.status === 0) assert.match(text.stdout, /Digital Signature, Key Encipherment/);
    });

    it('subjectAltName: DNS names, IPv4 and IPv6 (compressed, full, v4-mapped)', () => {
        const l = new crypto.X509Certificate(leaf({ altNames: ['localhost', '127.0.0.1', '::1', '2001:db8::7', '[fe80::1]', '::ffff:10.0.0.5', '2001:0db8:0000:0000:0000:0000:0000:0042', 'node1.example.internal'] }));
        assert.strictEqual(l.subjectAltName, [
            'DNS:localhost', 'IP Address:127.0.0.1', 'IP Address:0:0:0:0:0:0:0:1', 'IP Address:2001:DB8:0:0:0:0:0:7',
            'IP Address:FE80:0:0:0:0:0:0:1', 'IP Address:0:0:0:0:0:FFFF:A00:5', 'IP Address:2001:DB8:0:0:0:0:0:42', 'DNS:node1.example.internal',
        ].join(', '));
        assert.ok(l.checkHost('node1.example.internal'));
        assert.ok(l.checkIP('2001:db8::7'));
        assert.throws(() => leaf({ altNames: ['bad name with spaces'] }), /Invalid subjectAltName/);
        assert.throws(() => leaf({ altNames: ['fe80::1%eth0'] }), /Invalid subjectAltName/);
    });

    it('dates: UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5)', () => {
        const l = new crypto.X509Certificate(leaf({ notBefore: new Date('2049-12-31T23:59:59Z'), notAfter: new Date('2051-06-01T12:00:00Z') }));
        assert.strictEqual(new Date(l.validFrom).toISOString(), '2049-12-31T23:59:59.000Z');
        assert.strictEqual(new Date(l.validTo).toISOString(), '2051-06-01T12:00:00.000Z');
    });

    it('serials are minimal DER INTEGERs whatever their leading bytes', () => {
        for (const serialHex of ['00', '0000ff', '80', '7f', '00a1b2', 'ff'.repeat(16), '01']) {
            const l = new crypto.X509Certificate(leaf({ serialHex }));
            const expected = BigInt(`0x${serialHex}`).toString(16).toUpperCase();
            assert.strictEqual(BigInt(`0x${l.serialNumber}`).toString(16).toUpperCase(), expected, serialHex);
            assert.doesNotThrow(() => tls.createSecureContext({ cert: leaf({ serialHex }), key: leafKeys.privateKeyPem }));
        }
    });

    it('a CA key that is not the CA certificate\'s key is refused before anything is signed', () => {
        const other = x509.generateRsaKeyPair(2048);
        assert.throws(() => x509.createCertificate({ subject: [['CN', 'x']], issuerCertPem: caPem, publicKey: leafKeys.publicKey, signingKey: other.privateKey, notAfter: new Date(Date.now() + 864e5) }),
            /does not match the CA certificate/);
    });

    it('ECDSA P-256 keys sign certificates and CSRs (ecdsa-with-SHA256)', () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const pem = x509.createCertificate({ subject: [['CN', 'ec']], publicKey, signingKey: privateKey, notAfter: new Date(Date.now() + 864e5) });
        assert.ok(new crypto.X509Certificate(pem).verify(publicKey));
        const csr = x509.parseCsr(x509.createCsr({ privateKey, subject: [['CN', 'ec']], altNames: ['ec.example'] }));
        assert.strictEqual(csr.signatureAlgorithm, 'ecdsaWithSHA256');
        assert.ok(crypto.verify('sha256', csr.info, csr.publicKey, csr.signature));
    });
});

describe('the CSR parser is strict', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const good: string = x509.createCsr({ privateKey, subject: [['CN', 'backend']], altNames: ['a.example', 'b.example'] });
    const der = x509.pemBody(good, ['CERTIFICATE REQUEST']);
    const pem = (d: Buffer) => x509.toPem('CERTIFICATE REQUEST', d);

    it('round-trips its own output and slices the signed bytes exactly', () => {
        const p = x509.parseCsr(good);
        assert.strictEqual(p.signatureAlgorithm, 'sha256WithRSAEncryption');
        assert.ok(crypto.verify('sha256', p.info, p.publicKey, p.signature));
        assert.ok(der.includes(p.info));
    });

    it('refuses trailing bytes, truncation, a non-minimal length and a non-PEM input', () => {
        assert.throws(() => x509.parseCsr(pem(Buffer.concat([der, Buffer.from([0])]))), /Trailing data|Malformed/);
        assert.throws(() => x509.parseCsr(pem(der.subarray(0, der.length - 10))), /Truncated|Malformed/);
        const padded = Buffer.from(der);
        // The outer SEQUENCE uses a 2-byte long-form length; prefix it with a redundant zero byte.
        assert.strictEqual(padded[1], 0x82);
        const nonMinimal = Buffer.concat([Buffer.from([0x30, 0x83, 0x00]), padded.subarray(2)]);
        assert.throws(() => x509.parseCsr(pem(nonMinimal)), /Non-minimal/);
        assert.throws(() => x509.parseCsr('hello'), /Expected a PEM/);
        assert.throws(() => x509.parseCsr(x509.toPem('CERTIFICATE REQUEST', Buffer.from([0x30, 0x00]))), /Truncated|Malformed/);
    });
});
