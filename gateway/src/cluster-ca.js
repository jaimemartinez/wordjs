'use strict';
/**
 * WordJS Cluster PKI + join-token engine (gateway side).
 *
 * The gateway is the cluster's certificate authority: it holds the cluster CA private key and, on
 * demand, signs short-lived join tokens into mTLS identity certs for backend/frontend nodes. This is
 * what lets a brand-new machine bootstrap trust with a single token instead of hand-copied certs:
 *
 *   gateway:  cluster:init          -> mint CA (keep the KEY, 0600) + the gateway's own identity cert
 *   gateway:  cluster:token backend -> mint a single-use, TTL-bound token bound to a role
 *   node:     node:join --token …   -> generate a keypair+CSR (openssl), POST /enroll with the token,
 *                                      receive a signed CN=<role> cert + the cluster CA back
 *   node:     service starts        -> registers with the gateway over mTLS using that identity
 *
 * The token authorizes exactly the FIRST communication (enrollment); everything after is mTLS.
 *
 * ./x509.js builds and signs the certs with Node's crypto — no openssl binary on the gateway and no
 * third-party X.509 code. Reuses the same cert recipe as setup/index.js so the issued certs are
 * interchangeable with a single-host `npm run setup`, and a cluster CA made by an older release (with
 * node-forge) keeps signing: its key is read as-is and its subject is copied verbatim as the issuer.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const x509 = require('./x509');

// Unique certificate serial number: a positive, MINIMALLY encoded DER INTEGER — 16 random bytes whose
// first byte is 0x01-0x7f. The old '0' + 15 random bytes relied on node-forge stripping ONE leading zero
// byte; when the first random byte was itself 0x00 (and the next below 0x80) the certificate carried a
// non-minimal INTEGER that OpenSSL 3 refuses ("illegal padding"): about 1 identity in 512 failed to load,
// and a cluster CA drawn that way could never be loaded at all.
function serial() {
    const bytes = crypto.randomBytes(16);
    bytes[0] = (bytes[0] & 0x7f) || 0x01;
    return bytes.toString('hex');
}

/**
 * Load the cluster CA from certsDir, or generate one if absent. Unlike setup/index.js (which DELETES
 * the CA key after single-host distribution), the gateway KEEPS cluster-ca.key (mode 0600) because it
 * must sign enrolment CSRs at runtime. Returns { caCertPem, caKeyPem, created }.
 */
function ensureClusterCA(certsDir) {
    fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(certsDir, 0o700); } catch { /* Windows */ }
    const caCrtPath = path.join(certsDir, 'cluster-ca.crt');
    const caKeyPath = path.join(certsDir, 'cluster-ca.key');
    if (fs.existsSync(caCrtPath) && fs.existsSync(caKeyPath)) {
        return {
            caCertPem: fs.readFileSync(caCrtPath, 'utf8'),
            caKeyPem: fs.readFileSync(caKeyPath, 'utf8'),
            created: false, caCrtPath, caKeyPath
        };
    }
    const caKeys = x509.generateRsaKeyPair(2048);
    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setFullYear(notBefore.getFullYear() + 10);
    const caCertPem = x509.createCertificate({
        subject: [['CN', 'WordJS Cluster Root CA']],
        publicKey: caKeys.publicKey,
        signingKey: caKeys.privateKey,
        serialHex: serial(),
        notBefore,
        notAfter,
        ca: true,
        keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const caKeyPem = caKeys.privateKeyPem;
    fs.writeFileSync(caCrtPath, caCertPem);
    fs.writeFileSync(caKeyPath, caKeyPem, { mode: 0o600 });
    try { fs.chmodSync(caKeyPath, 0o600); } catch { /* chmod unsupported (Windows) */ }
    return { caCertPem, caKeyPem, created: true, caCrtPath, caKeyPath };
}

// SHA-256 fingerprint (hex) of the CA certificate's DER, for out-of-band pinning at join time
// (kubeadm-style --ca-hash), so a bootstrapping node can detect a MITM before trusting the returned CA.
// Hash the DER decoded straight from the PEM body (NOT a re-encoding) so it matches byte-for-byte
// what scripts/node-join.js computes from the same PEM it receives — otherwise --ca-hash never matches.
function caFingerprint(caCertPem) {
    const b64 = String(caCertPem).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

/**
 * Sign a service's identity cert directly from a keypair we generate here (used by cluster:init for the
 * gateway's own gateway-internal cert). CN and SANs are caller-controlled. serverAuth+clientAuth.
 * Returns { keyPem, certPem }.
 */
function issueIdentity({ caKeyPem, caCertPem, cn, sans = [], days = 825 }) {
    const keys = x509.generateRsaKeyPair(2048);
    const certPem = signPublicKey({ caKeyPem, caCertPem, publicKey: keys.publicKey, cn, sans, days });
    return { keyPem: keys.privateKeyPem, certPem };
}

// The ONE CSR signature algorithm enrolment accepts: sha256WithRSAEncryption (RSASSA-PKCS1-v1_5 over
// SHA-256). It is what `openssl req` signs with by default and what scripts/node-join.js asks for
// explicitly. Anything else — sha1/sha384/sha512WithRSAEncryption, RSASSA-PSS, … — is refused by name,
// never verified. A Map, so an OID string can never resolve to an inherited Object property.
const CSR_SIGNATURE_HASHES = new Map([[x509.OID.sha256WithRSAEncryption, 'sha256']]);

/**
 * Verify a parsed CSR's self-signature — the proof that the enrolling node holds the private key of the
 * public key we are about to certify — with Node's crypto (OpenSSL).
 *
 * WHY OPENSSL. node-forge's RSASSA-PKCS1-v1_5 verifier (every release up to and including 1.4.0, npm
 * advisory 1240912) accepted a DigestInfo whose DigestAlgorithm carries extra nested elements —
 * attacker-chosen bytes inside the signed block, the raw material of a Bleichenbacher-style forgery.
 * OpenSSL builds the one DigestInfo that is valid for the hash and compares it byte for byte.
 *
 * The bytes verified are the DER of the CertificationRequestInfo exactly as it arrived (x509.parseCsr
 * slices it out of the request; nothing is re-encoded), attributes and extensionRequest included.
 *
 * Throws for an unsupported signature algorithm; returns false for a signature that does not verify.
 */
function verifyCsrSignature(csr) {
    const hash = CSR_SIGNATURE_HASHES.get(csr.signatureOid);
    if (!hash) {
        const name = csr.signatureAlgorithm || 'unknown algorithm';
        throw new Error(`CSR signature algorithm ${name} (${csr.signatureOid}) is not supported — only sha256WithRSAEncryption is accepted`);
    }
    if (csr.publicKey.asymmetricKeyType !== 'rsa') return false; // sha256WithRSAEncryption needs an RSA key
    try {
        return crypto.verify(hash, csr.info, {
            key: csr.publicKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, csr.signature);
    } catch {
        return false; // a key or signature OpenSSL cannot even process is not a proof of possession
    }
}

/**
 * Sign a CSR (PEM, e.g. produced by `openssl req`) into a leaf identity cert. SECURITY: the subject CN
 * is FORCED to `cn` (derived from the join token's role) — the CSR's own subject is ignored so a node
 * holding a backend token can never obtain a frontend identity. Only the CSR's public key is trusted
 * (after verifying its sha256WithRSAEncryption self-signature with OpenSSL). Returns the cert PEM.
 */
function signCsr({ caKeyPem, caCertPem, csrPem, cn, sans = [], days = 825 }) {
    let csr;
    try {
        csr = x509.parseCsr(csrPem);
    } catch (e) {
        throw new Error(`CSR could not be parsed: ${e.message}`);
    }
    if (!verifyCsrSignature(csr)) throw new Error('CSR self-signature is invalid');
    return signPublicKey({ caKeyPem, caCertPem, publicKey: csr.publicKey, cn, sans, days });
}

// Shared leaf-signing core: build a serverAuth+clientAuth leaf for `publicKey` with CN=cn and the given
// SANs (always plus localhost/127.0.0.1 so the same cert still works for loopback/health checks). The
// issuer is the CA certificate's subject, copied byte for byte (x509.certificateSubject).
function signPublicKey({ caKeyPem, caCertPem, publicKey, cn, sans = [], days = 825 }) {
    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setDate(notBefore.getDate() + days);
    const altNames = ['localhost', '127.0.0.1'];
    const seen = new Set(altNames);
    for (const h of sans) {
        if (h && !seen.has(h)) { altNames.push(h); seen.add(h); }
    }
    return x509.createCertificate({
        subject: [['CN', cn]],
        issuerCertPem: caCertPem,
        publicKey,
        signingKey: caKeyPem,
        serialHex: serial(),
        notBefore,
        notAfter,
        ca: false,
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extKeyUsage: ['serverAuth', 'clientAuth'],
        altNames,
    });
}

/**
 * File-backed join-token store. Tokens are single-use, role-bound and TTL-bound. Only a SHA-256 hash of
 * each token is persisted, so the store file never contains a usable credential. Minted by the
 * `cluster:token` CLI (separate process), consumed by the gateway's /enroll handler — each call reloads
 * the file so the two processes stay in sync.
 */
function tokenStore(file) {
    const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { tokens: [] }; } };
    const save = (d) => {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    };
    const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
    const alive = (t) => !t.used && t.expiresAt > Date.now();
    return {
        // Mint a role-bound, single-use token. `host` (optional) pins the advertise host the enrolling
        // node is expected to claim, and is added to the issued cert's SANs. Returns the RAW token
        // (shown once); only its hash is stored.
        mint(role, { ttlMs = 3600000, host = null } = {}) {
            const raw = `wjc.${role}.${crypto.randomBytes(24).toString('base64url')}`;
            const d = load();
            d.tokens = (d.tokens || []).filter(alive); // opportunistic GC of spent/expired tokens
            d.tokens.push({ hash: hash(raw), role, host, expiresAt: Date.now() + ttlMs, used: false, createdAt: Date.now() });
            save(d);
            return raw;
        },
        // Validate + burn a token for `role`. Returns { ok, reason?, host? }.
        consume(raw, role) {
            const d = load();
            const h = hash(raw);
            const tok = (d.tokens || []).find((x) => x.hash === h);
            if (!tok) return { ok: false, reason: 'unknown or already-consumed token' };
            if (tok.used) return { ok: false, reason: 'token already used' };
            if (tok.expiresAt <= Date.now()) return { ok: false, reason: 'token expired' };
            if (tok.role !== role) return { ok: false, reason: `token is bound to role '${tok.role}', not '${role}'` };
            tok.used = true; tok.usedAt = Date.now();
            save(d);
            return { ok: true, role: tok.role, host: tok.host };
        },
        list() {
            return (load().tokens || []).map((t) => ({
                role: t.role, host: t.host, used: t.used,
                expiresAt: new Date(t.expiresAt).toISOString(),
                expired: t.expiresAt <= Date.now()
            }));
        },
        revokeAll() { save({ tokens: [] }); }
    };
}

module.exports = { ensureClusterCA, issueIdentity, signCsr, caFingerprint, tokenStore, serial };
