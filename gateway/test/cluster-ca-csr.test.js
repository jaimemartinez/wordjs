/**
 * WordJS Gateway — the enrolment CSR's self-signature is verified by OpenSSL, not by node-forge.
 *
 * `/enroll` turns a join token plus a CSR into a cluster-CA identity cert, and the CSR's self-signature
 * is the proof that the enrolling node holds the private key of the public key being certified.
 * node-forge's RSASSA-PKCS1-v1_5 verifier — every release up to 1.4.0, no fixed version (npm advisory
 * 1240912) — accepts a DigestInfo whose DigestAlgorithm carries extra nested elements. signCsr() now
 * checks the signature with Node's crypto (OpenSSL) and accepts sha256WithRSAEncryption only.
 *
 * The CSRs here are built WITHOUT node-forge: two fixtures straight out of `openssl req`, and requests
 * assembled from raw DER with Node's crypto doing the signing, so the tests never share an encoder with
 * the code under test.
 *
 * MUTATION PROOF (each one run against this file):
 *   · drop the `verifyCsrSignature` check in signCsr     → 7 fail: flipped signature, altered request
 *                                                            info, other key, advisory shape, and the
 *                                                            sha1/sha384/sha512 refusals;
 *   · put back the old `csr.verify()` (node-forge)       → 6 fail: forge ACCEPTS the advisory shape and
 *                                                            the sha1/sha384/sha512 requests; on the
 *                                                            flipped / other-key signatures it throws its
 *                                                            own "Encryption block is invalid." instead;
 *   · let every algorithm through as sha256              → 3 fail: the refusals (they assert the "not
 *                                                            supported" reason, not just any throw);
 *   · rebuild the request info from the parsed fields    → 1 fails: the extensionRequest CSR, because
 *     only (pki.getCertificationRequestInfo)                  forge's rebuild of its attributes is not
 *                                                            byte-identical to what openssl signed.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const clusterCa = require('../src/cluster-ca');

// `openssl req -newkey rsa:2048 -nodes -sha256 -keyout k -out r.csr -subj /CN=backend` — the exact
// invocation scripts/node-join.js runs (OpenSSL 3.5).
const OPENSSL_NODE_JOIN_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICVzCCAT8CAQAwEjEQMA4GA1UEAwwHYmFja2VuZDCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAJ8JzsLUOzHwXOoaYzhx2ZX9sVPCVD9RsVty3Kkmgwzc
2hLOvuomt/CTwX+1wEC64fgH0Jtd349Xiq/YmfjYB9Xis8Vnua8UHGN654m/Gx2R
PSPsIcLIRVtq2gZUDClU4JBAAtL5clvLghPBLo9PSBpuWVZ83QqwFqnaQXtBHVj2
NhMBGYzWoN96lPDPWjoIxo0wEp1JXf6qAMzEnhurwxCWw3UkdNcPv0g2Mz5IVGdX
QHYIu459j5Xk1xV+IfJ+AYac7M4YYcJUq5XK5yZx4qad0J7zg1HhgHLrzZa/U9cY
t5cE+CsZFiPJ6CtjJctR48GyUCtEeSsrrYVjDWBAOzMCAwEAAaAAMA0GCSqGSIb3
DQEBCwUAA4IBAQBUjgap1K/1go4zklqYWPAGAIyc8DwBNawcPLIWdlOtXx3HpV4Q
ZtnFC9RQPutNP0X836MbKnyfu0egq0yPVJrIPE+E3q28Z/b2Imm4FYbyAird1x2y
Au8lUEpTbwDzmT1POVxYMXyE/AkPAbJlffDM8HOfYQPD6oMhMjwQFVyvlb0dIXiJ
iboUVAxmJCGFVtlBShdiqWieEwTToIxbwKqFQkpgYQKtrMtnYsRztOR1FqKTBIWw
i6/LwrClozrlCtO0vVaEU5ehRRI6X+u0h6nTLL8fzhBVQgusMiMTJCiCND5tvEni
jznMwFGB+pLOA0D2MmcT/XvqtcxNMnQHR6iz
-----END CERTIFICATE REQUEST-----
`;

// `openssl req -newkey rsa:2048 -nodes -subj "/C=ES/O=WordJS Cluster/OU=Nodes/CN=frontend"
//   -addext "subjectAltName=DNS:node1.example.internal,IP:10.0.0.6"
//   -addext "keyUsage=digitalSignature,keyEncipherment"` — a request that carries an extensionRequest
// attribute and a multi-RDN subject, i.e. a signed CertificationRequestInfo that is not the bare minimum.
const OPENSSL_ATTRIBUTES_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIIC1TCCAb0CAQAwSTELMAkGA1UEBhMCRVMxFzAVBgNVBAoMDldvcmRKUyBDbHVz
dGVyMQ4wDAYDVQQLDAVOb2RlczERMA8GA1UEAwwIZnJvbnRlbmQwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDNuIPzTjqx++49EKJeAO+SZdylWhAcmzG8
V/qx31VXnBoCYPG6FSTRCYwieT/xD6sTxU761LwLa2iX0k2ir7YSLGnpWthfo9A5
V8D7vNnKmVN+iLAdx6SlZjIXo7eyTMNxUs6IciZA3FXu5FE2Pbf/C1tbBFy41MvS
NglHsK4weL4ztAh+CGdu12I7QWKxvdRclD+2oXsqvrf56rVk3Ue/GAZJAb81BOig
V+VtMeZM2jY71d6nj3Wc49n/qb+iptl0bCqts0THf8TscELMiLAmJnY39feSbSCs
EPY+3Yh961zBMZfTKLiDrztz2My5r5aMH1oC+WGctr/uL9GObKl/AgMBAAGgRzBF
BgkqhkiG9w0BCQ4xODA2MCcGA1UdEQQgMB6CFm5vZGUxLmV4YW1wbGUuaW50ZXJu
YWyHBAoAAAYwCwYDVR0PBAQDAgWgMA0GCSqGSIb3DQEBCwUAA4IBAQBsD2aXrSNp
AxiipCgRe+v6kJNqnttIM+eZR4NbsOTGt639UaP1HoV+7DBEbI637BsfpRBl1CMK
AYN6Lj1fQdRceMeyhgK18MivaBg5BsExgvZmG3g53tBTV38DEgFe43auvDgw8rWP
ATYk5I/27DdDYdbNF24Bem8SxMdZih+bS/Pplyv5Guz0dSaYK2+EzwTRv76Z2CFR
+CxCCCcIH6NV1TruIfmItmf3q1/0A4vAO28F8MiQILR8TLbfVnjS4k79NJ9mvPBg
wa41I7H9WJjPn8YJxn00CUhy0E//kg4/nNkET/AZCFIZtPS4It3JKMk5v0IuI8jG
sOhsxEerO9TX
-----END CERTIFICATE REQUEST-----
`;

// --- Minimal DER toolkit (independent of node-forge) ---------------------------------------------

function readTlv(buf, off) {
    let len = buf[off + 1];
    let hdr = 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
        hdr = 2 + n;
    }
    return { tag: buf[off], start: off, body: off + hdr, end: off + hdr + len };
}

function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const pemToDer = (pem) => Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const derToPem = (der) => `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;

// CertificationRequest ::= SEQUENCE { certificationRequestInfo, signatureAlgorithm, signature BIT STRING }
function splitCsr(pem) {
    const der = pemToDer(pem);
    const outer = readTlv(der, 0);
    const info = readTlv(der, outer.body);
    const alg = readTlv(der, info.end);
    const sig = readTlv(der, alg.end);
    const version = readTlv(der, info.body);
    const subject = readTlv(der, version.end);
    const spki = readTlv(der, subject.end);
    return {
        der,
        info: der.subarray(info.start, info.end),
        alg: der.subarray(alg.start, alg.end),
        signature: der.subarray(sig.body + 1, sig.end), // skip the BIT STRING's unused-bits byte
        spki: der.subarray(spki.start, spki.end),
    };
}

const assembleCsr = (info, alg, signature) => derToPem(tlv(0x30, info, alg, tlv(0x03, Buffer.from([0]), signature)));

const SIG_ALG_OIDS = {
    sha256: '2a864886f70d01010b', // 1.2.840.113549.1.1.11 sha256WithRSAEncryption
    sha1: '2a864886f70d010105',   // 1.2.840.113549.1.1.5  sha1WithRSAEncryption
    sha384: '2a864886f70d01010c', // 1.2.840.113549.1.1.12 sha384WithRSAEncryption
    sha512: '2a864886f70d01010d', // 1.2.840.113549.1.1.13 sha512WithRSAEncryption
};
const algorithmIdentifier = (hash) => tlv(0x30, tlv(0x06, Buffer.from(SIG_ALG_OIDS[hash], 'hex')), Buffer.from('0500', 'hex'));

// CertificationRequestInfo for `publicKey` with subject CN=<cn> and no attributes — openssl's shape.
function requestInfo(publicKey, cn) {
    const subject = tlv(0x30, tlv(0x31, tlv(0x30, tlv(0x06, Buffer.from('550403', 'hex')), tlv(0x0c, Buffer.from(cn)))));
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    return tlv(0x30, Buffer.from('020100', 'hex'), subject, spki, Buffer.from('a000', 'hex'));
}

// A CSR signed by its own key (Node's crypto, RSASSA-PKCS1-v1_5) with the given hash.
function nodeBuiltCsr(hash, cn = 'backend') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const info = requestInfo(publicKey, cn);
    const signature = crypto.sign(hash, info, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    return { pem: assembleCsr(info, algorithmIdentifier(hash), signature), publicKey, privateKey, info };
}

// --- A real cluster CA, made by the real code -------------------------------------------------------

const certsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-cluster-ca-csr-'));
const { caCertPem, caKeyPem } = clusterCa.ensureClusterCA(certsDir);
const caPublicKey = new crypto.X509Certificate(caCertPem).publicKey;
test.after(() => fs.rmSync(certsDir, { recursive: true, force: true }));

const sign = (csrPem, cn = 'backend', sans = ['10.0.0.6']) => clusterCa.signCsr({ caKeyPem, caCertPem, csrPem, cn, sans });
const INVALID = /CSR self-signature is invalid/;
const UNSUPPORTED = /CSR signature algorithm \S+ \([\d.]+\) is not supported/;

// The issued cert is a CA-signed leaf for exactly the CSR's key, with the CN forced to the role.
function assertIssuedFor(certPem, csrPem, cn) {
    const cert = new crypto.X509Certificate(certPem);
    assert.ok(cert.verify(caPublicKey), 'issued cert is not signed by the cluster CA');
    assert.strictEqual(cert.subject, `CN=${cn}`);
    assert.ok(cert.publicKey.export({ type: 'spki', format: 'der' }).equals(splitCsr(csrPem).spki),
        'issued cert certifies a different key than the CSR carries');
    assert.match(cert.subjectAltName, /IP Address:10\.0\.0\.6/);
}

// --- Accepted ----------------------------------------------------------------------------------------

test('an openssl CSR exactly like node-join produces is accepted and certified under CN=<role>', () => {
    const certPem = sign(OPENSSL_NODE_JOIN_CSR, 'backend');
    assertIssuedFor(certPem, OPENSSL_NODE_JOIN_CSR, 'backend');
});

test('an openssl CSR carrying an extensionRequest and a multi-RDN subject is accepted; its subject is ignored', () => {
    // The signed bytes include the attributes, so this proves the CertificationRequestInfo handed to
    // OpenSSL is byte-for-byte what openssl signed — not a lossy rebuild of it.
    const certPem = sign(OPENSSL_ATTRIBUTES_CSR, 'backend');
    assertIssuedFor(certPem, OPENSSL_ATTRIBUTES_CSR, 'backend');
});

test('a CSR assembled from raw DER and signed sha256WithRSAEncryption by its own key is accepted', () => {
    // Positive control for the builder the refusal tests below use.
    const { pem } = nodeBuiltCsr('sha256');
    assertIssuedFor(sign(pem, 'frontend'), pem, 'frontend');
});

test('a CSR made by the openssl binary right now with node-join\'s arguments is accepted', (t) => {
    const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    if (probe.status !== 0) return t.skip('openssl is not on PATH');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-node-join-csr-'));
    try {
        const keyPath = path.join(dir, 'backend.key');
        const csrPath = path.join(dir, 'backend.csr');
        const r = spawnSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', keyPath, '-out', csrPath, '-subj', '/CN=backend'], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        const csrPem = fs.readFileSync(csrPath, 'utf8');
        assertIssuedFor(sign(csrPem, 'backend'), csrPem, 'backend');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- Refused: the signature does not prove possession of the key -----------------------------------

test('a CSR whose signature has one flipped byte is refused', () => {
    for (const at of [-1, -128]) {
        const der = Buffer.from(pemToDer(OPENSSL_NODE_JOIN_CSR));
        der[der.length + at] ^= 0x01;
        assert.throws(() => sign(derToPem(der)), INVALID, `flipped byte at ${at} was accepted`);
    }
});

test('a CSR whose signed request info was altered after signing is refused', () => {
    const { info, alg, signature } = splitCsr(OPENSSL_NODE_JOIN_CSR);
    const at = info.indexOf(Buffer.from('backend'));
    assert.ok(at > 0);
    const altered = Buffer.from(info);
    altered[at] = 'B'.charCodeAt(0); // CN=backend → CN=Backend, same length
    assert.throws(() => sign(assembleCsr(altered, alg, signature)), INVALID);
});

test('a CSR whose signature was made by ANOTHER key is refused', () => {
    // The request carries key A (from openssl); the signature is a perfectly valid sha256WithRSA
    // signature over those exact bytes — by key B. Whoever sent it does not hold key A.
    const { info, alg } = splitCsr(OPENSSL_NODE_JOIN_CSR);
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signature = crypto.sign('sha256', info, { key: otherKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    assert.throws(() => sign(assembleCsr(info, alg, signature)), INVALID);
});

test('the signature shape of advisory 1240912 (an extra element inside DigestAlgorithm) is refused', () => {
    // EMSA-PKCS1-v1_5 with a DigestInfo whose DigestAlgorithm is { sha256, NULL, <24 extra bytes> }:
    // the right digest, the right key, but room for attacker-chosen bytes inside the signed block.
    // node-forge 1.4.0's verifier accepts it; OpenSSL compares the whole DigestInfo and does not.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const info = requestInfo(publicKey, 'backend');
    const digest = crypto.createHash('sha256').update(info).digest();
    const sha256Oid = tlv(0x06, Buffer.from('608648016503040201', 'hex'));
    const digestAlgorithm = tlv(0x30, sha256Oid, Buffer.from('0500', 'hex'), tlv(0x04, crypto.randomBytes(24)));
    const digestInfo = tlv(0x30, digestAlgorithm, tlv(0x04, digest));
    const signature = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, digestInfo);
    assert.throws(() => sign(assembleCsr(info, algorithmIdentifier('sha256'), signature)), INVALID);

    // Control: the same key with the canonical DigestInfo is accepted, so it is the extra element that
    // was refused and not something else about this request.
    const canonical = tlv(0x30, tlv(0x30, sha256Oid, Buffer.from('0500', 'hex')), tlv(0x04, digest));
    const good = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, canonical);
    const pem = assembleCsr(info, algorithmIdentifier('sha256'), good);
    assertIssuedFor(sign(pem), pem, 'backend');
});

// --- Refused: an algorithm we do not accept ----------------------------------------------------------

for (const hash of ['sha1', 'sha384', 'sha512']) {
    test(`a CSR signed ${hash}WithRSAEncryption is refused by name, even though its signature is valid`, () => {
        const { pem, publicKey, info } = nodeBuiltCsr(hash);
        // The signature really is valid for that algorithm — the refusal is about the algorithm alone.
        assert.ok(crypto.verify(hash, info, publicKey, splitCsr(pem).signature));
        assert.throws(() => sign(pem), (e) => UNSUPPORTED.test(e.message) && e.message.includes(`${hash}WithRSAEncryption`));
    });
}

test('certificate serials are minimal DER integers, even when the random draw starts with zero bytes', () => {
    // node-forge strips ONE leading zero byte from an INTEGER; the old serial ('0' + 15 random bytes) left a
    // second one whenever the first random byte was 0x00 and the next below 0x80 — a non-minimal INTEGER
    // OpenSSL 3 refuses with "illegal padding". Force exactly that draw and load what comes out.
    const tls = require('node:tls');
    const realRandomBytes = crypto.randomBytes;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-serial-'));
    crypto.randomBytes = (size, ...rest) => {
        if (rest.length === 0 && (size === 15 || size === 16)) {
            const b = Buffer.alloc(size, 0x5a);
            b[0] = 0x00; b[1] = 0x12;
            return b;
        }
        return realRandomBytes(size, ...rest);
    };
    try {
        const ca = clusterCa.ensureClusterCA(dir);
        const id = clusterCa.issueIdentity({ caKeyPem: ca.caKeyPem, caCertPem: ca.caCertPem, cn: 'gateway-internal', sans: ['localhost'] });
        assert.doesNotThrow(() => new crypto.X509Certificate(ca.caCertPem), 'the cluster CA certificate does not parse');
        assert.doesNotThrow(() => tls.createSecureContext({ key: id.keyPem, cert: `${id.certPem.trim()}\n${ca.caCertPem.trim()}\n`, ca: ca.caCertPem }),
            'OpenSSL refused the issued identity or the CA (non-minimal serial INTEGER)');
        for (const serialHex of [new crypto.X509Certificate(ca.caCertPem).serialNumber, new crypto.X509Certificate(id.certPem).serialNumber]) {
            assert.ok(!/^00/.test(serialHex) || /^00[89a-f]/i.test(serialHex), `serial ${serialHex} has a redundant leading zero byte`);
        }
    } finally {
        crypto.randomBytes = realRandomBytes;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
