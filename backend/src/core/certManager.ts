const fs = require('fs');
const path = require('path');
const log = require('./module-logger').moduleLogger('core/certManager');
// Certificates are built and signed with Node's crypto (./x509.js — the toolkit the gateway's cluster CA
// and setup/ use too), so every cluster PKI WordJS makes has the same shape whoever made it.
const x509 = require('./x509');

const CERTS_DIR = path.resolve(__dirname, '../../certs');

// Ensure certs directory exists. 0o700: private keys live here, so the directory must not be
// world/group-traversable.
if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });
}

// Write a PRIVATE KEY with restrictive permissions. writeFileSync's `mode` is ignored when the file
// already exists, so we ALSO chmod after the write to guarantee 0o600 on every platform/path.
function writePrivateKey(filePath: string, content: string) {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* chmod is a no-op on some filesystems (e.g. Windows) */ }
}

/**
 * Generate a Cluster Root CA
 */
function generateClusterCA() {
    log.info('🔐 Generating Cluster Root CA...');

    const keys = x509.generateRsaKeyPair(2048);
    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setFullYear(notBefore.getFullYear() + 10); // 10 years

    const caCertPem: string = x509.createCertificate({
        subject: [['CN', 'WordJS Cluster Root CA'], ['O', 'WordJS Internal Cluster']], // self-signed
        publicKey: keys.publicKey,
        signingKey: keys.privateKey,
        notBefore,
        notAfter,
        ca: true,
        keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const caKeyPem: string = keys.privateKeyPem;

    writePrivateKey(path.join(CERTS_DIR, 'cluster-ca.key'), caKeyPem);
    fs.writeFileSync(path.join(CERTS_DIR, 'cluster-ca.crt'), caCertPem);

    return { key: caKeyPem, cert: caCertPem };
}

/**
 * Generate a Service Certificate signed by the CA. The issuer is the CA certificate's subject, copied
 * byte for byte, so a CA made by an older release keeps issuing certificates that chain to it.
 * @param {string} serviceName
 * @param {string} caKeyPem
 * @param {string} caCertPem
 * @param {string[]} additionalAltNames extra DNS names / IP literals for the subjectAltName
 */
function generateServiceCert(serviceName: string, caKeyPem: string, caCertPem: string, additionalAltNames: string[] = []) {
    log.info({ serviceName }, `🔐 Generating Certificate for service: ${serviceName}...`);

    const keys = x509.generateRsaKeyPair(2048);
    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setFullYear(notBefore.getFullYear() + 2); // 2 years

    const certPem: string = x509.createCertificate({
        subject: [['CN', serviceName], ['O', 'WordJS Service']],
        issuerCertPem: caCertPem,
        publicKey: keys.publicKey,
        signingKey: caKeyPem,
        notBefore,
        notAfter,
        ca: false,
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extKeyUsage: ['serverAuth', 'clientAuth'],
        altNames: [...new Set(['localhost', '127.0.0.1', ...additionalAltNames])],
    });
    const keyPem: string = keys.privateKeyPem;

    writePrivateKey(path.join(CERTS_DIR, `${serviceName}.key`), keyPem);
    fs.writeFileSync(path.join(CERTS_DIR, `${serviceName}.crt`), certPem);

    return { key: keyPem, cert: certPem };
}

module.exports = {
    generateClusterCA,
    generateServiceCert,
    CERTS_DIR
};
