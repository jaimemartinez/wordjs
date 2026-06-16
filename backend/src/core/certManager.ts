const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const { pki, md } = forge;

const CERTS_DIR = path.resolve(__dirname, '../../certs');

// Ensure certs directory exists
if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
}

/**
 * Generate a Cluster Root CA
 */
function generateClusterCA() {
    console.log('🔐 Generating Cluster Root CA...');

    // 1. Generate Keypair
    const keys = pki.rsa.generateKeyPair(2048);

    // 2. Create Certificate
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';

    // Validity
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10); // 10 years

    // Identifiers
    const attrs = [{
        name: 'commonName',
        value: 'WordJS Cluster Root CA'
    }, {
        name: 'organizationName',
        value: 'WordJS Internal Cluster'
    }];

    cert.setSubject(attrs);
    cert.setIssuer(attrs); // Self-signed

    // Extensions
    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true
    }, {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true
    }]);

    // Sign
    cert.sign(keys.privateKey, md.sha256.create());

    // Save
    const caKeyPem = pki.privateKeyToPem(keys.privateKey);
    const caCertPem = pki.certificateToPem(cert);

    fs.writeFileSync(path.join(CERTS_DIR, 'cluster-ca.key'), caKeyPem);
    fs.writeFileSync(path.join(CERTS_DIR, 'cluster-ca.crt'), caCertPem);

    return { key: caKeyPem, cert: caCertPem };
}

/**
 * Generate a Service Certificate signed by the CA
 * @param {string} serviceName
 * @param {string} caKeyPem
 * @param {string} caCertPem
 * @param {Array<{type: number, value?: string, ip?: string}>} additionalAltNames
 */
function generateServiceCert(serviceName, caKeyPem, caCertPem, additionalAltNames = []) {
    console.log(`🔐 Generating Certificate for service: ${serviceName}...`);

    const caKey = pki.privateKeyFromPem(caKeyPem);
    const caCert = pki.certificateFromPem(caCertPem);

    // 1. Generate Keypair
    const keys = pki.rsa.generateKeyPair(2048);

    // 2. Create Certificate
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = new Date().getTime().toString(); // Random serial

    // Validity
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2); // 2 years

    // Subject
    const attrs = [{
        name: 'commonName',
        value: serviceName
    }, {
        name: 'organizationName',
        value: 'WordJS Service'
    }];
    cert.setSubject(attrs);

    // Issuer (The CA)
    cert.setIssuer(caCert.subject.attributes);

    // Prepare Alt Names
    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...additionalAltNames
    ];

    // Extensions
    cert.setExtensions([{
        name: 'basicConstraints',
        cA: false
    }, {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true
    }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
    }, {
        name: 'subjectAltName',
        altNames: altNames
    }]);

    // Sign with CA Private Key
    cert.sign(caKey, md.sha256.create());

    // Save
    const keyPem = pki.privateKeyToPem(keys.privateKey);
    const certPem = pki.certificateToPem(cert);

    fs.writeFileSync(path.join(CERTS_DIR, `${serviceName}.key`), keyPem);
    fs.writeFileSync(path.join(CERTS_DIR, `${serviceName}.crt`), certPem);

    return { key: keyPem, cert: certPem };
}

module.exports = {
    generateClusterCA,
    generateServiceCert,
    CERTS_DIR
};
