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
 * node-forge only — no openssl on the gateway. Reuses the same cert recipe as setup/index.js so the
 * issued certs are interchangeable with a single-host `npm run setup`.
 */
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pki, md } = forge;

const IP_RE = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

// A SAN entry: type 7 (IP) for a dotted-quad, type 2 (DNS) otherwise.
function sanEntry(host) {
    return IP_RE.test(host) ? { type: 7, ip: host } : { type: 2, value: host };
}

// Unique, positive certificate serial number (hex string; leading 0 nibble keeps it positive in DER).
function serial() {
    return '0' + crypto.randomBytes(15).toString('hex');
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
    const caKeys = pki.rsa.generateKeyPair(2048);
    const caCert = pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = serial();
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
    const caAttrs = [{ name: 'commonName', value: 'WordJS Cluster Root CA' }];
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true }
    ]);
    caCert.sign(caKeys.privateKey, md.sha256.create());
    const caCertPem = pki.certificateToPem(caCert);
    const caKeyPem = pki.privateKeyToPem(caKeys.privateKey);
    fs.writeFileSync(caCrtPath, caCertPem);
    fs.writeFileSync(caKeyPath, caKeyPem, { mode: 0o600 });
    try { fs.chmodSync(caKeyPath, 0o600); } catch { /* chmod unsupported (Windows) */ }
    return { caCertPem, caKeyPem, created: true, caCrtPath, caKeyPath };
}

// SHA-256 fingerprint (hex) of the CA certificate's DER, for out-of-band pinning at join time
// (kubeadm-style --ca-hash), so a bootstrapping node can detect a MITM before trusting the returned CA.
// Hash the DER decoded straight from the PEM body (NOT a forge re-encoding) so it matches byte-for-byte
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
    const keys = pki.rsa.generateKeyPair(2048);
    const certPem = signPublicKey({ caKeyPem, caCertPem, publicKey: keys.publicKey, cn, sans, days });
    return { keyPem: pki.privateKeyToPem(keys.privateKey), certPem };
}

/**
 * Sign a CSR (PEM, e.g. produced by `openssl req`) into a leaf identity cert. SECURITY: the subject CN
 * is FORCED to `cn` (derived from the join token's role) — the CSR's own subject is ignored so a node
 * holding a backend token can never obtain a frontend identity. Only the CSR's public key is trusted
 * (after verifying its self-signature). Returns the cert PEM.
 */
function signCsr({ caKeyPem, caCertPem, csrPem, cn, sans = [], days = 825 }) {
    const csr = pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('CSR self-signature is invalid');
    if (!csr.publicKey) throw new Error('CSR has no public key');
    return signPublicKey({ caKeyPem, caCertPem, publicKey: csr.publicKey, cn, sans, days });
}

// Shared leaf-signing core: build a serverAuth+clientAuth leaf for `publicKey` with CN=cn and the given
// SANs (always plus localhost/127.0.0.1 so the same cert still works for loopback/health checks).
function signPublicKey({ caKeyPem, caCertPem, publicKey, cn, sans = [], days = 825 }) {
    const caKey = pki.privateKeyFromPem(caKeyPem);
    const caCert = pki.certificateFromPem(caCertPem);
    const cert = pki.createCertificate();
    cert.publicKey = publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + days);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(caCert.subject.attributes);
    const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
    const seen = new Set(['localhost', '127.0.0.1']);
    for (const h of sans) {
        if (h && !seen.has(h)) { altNames.push(sanEntry(h)); seen.add(h); }
    }
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        { name: 'subjectAltName', altNames }
    ]);
    cert.sign(caKey, md.sha256.create());
    return pki.certificateToPem(cert);
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
