const forge = require('node-forge');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { pki, md } = forge;

/**
 * WordJS Autonomous Setup & Migration Orchestrator
 */
class WordJSSetup {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.rootDir = path.resolve(baseDir);
        this.backendDir = path.join(this.rootDir, 'backend');
        this.gatewayDir = path.join(this.rootDir, 'gateway');
        this.frontDir = path.join(this.rootDir, 'frontend');
        this.certsDir = path.join(this.rootDir, 'certs');
    }

    async init() {
        await fs.ensureDir(this.certsDir);
        await fs.ensureDir(this.gatewayDir);
        await fs.ensureDir(path.join(this.gatewayDir, 'certs'));
        if (await fs.pathExists(this.frontDir)) {
            await fs.ensureDir(path.join(this.frontDir, 'certs'));
        }
    }

    /**
     * Generate mTLS Infrastructure
     */
    async generateCerts(host = 'localhost') {
        process.stdout.write('🔐 Generating Cluster Infrastructure...\n');

        // 1. Generate CA
        const caKeys = pki.rsa.generateKeyPair(2048);
        const caCert = pki.createCertificate();
        caCert.publicKey = caKeys.publicKey;
        caCert.serialNumber = '01';
        caCert.validity.notBefore = new Date();
        caCert.validity.notAfter = new Date();
        caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);

        const caAttrs = [{ name: 'commonName', value: 'WordJS Cluster Root CA' }];
        caCert.setSubject(caAttrs);
        caCert.setIssuer(caAttrs);
        caCert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
        caCert.sign(caKeys.privateKey, md.sha256.create());

        const caKeyPem = pki.privateKeyToPem(caKeys.privateKey);
        const caCertPem = pki.certificateToPem(caCert);

        await fs.writeFile(path.join(this.certsDir, 'cluster-ca.key'), caKeyPem);
        await fs.writeFile(path.join(this.certsDir, 'cluster-ca.crt'), caCertPem);

        // 2. Generate Service Identities
        const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);

        const getSubdomain = (prefix) => {
            if (isIp || host === 'localhost') return host;
            const parts = host.split('.');
            if (parts.length > 2) return `${prefix}.${parts.slice(1).join('.')}`;
            return `${prefix}.${host}`;
        };

        const identities = ['gateway-internal', 'backend', 'frontend'];
        for (const id of identities) {
            const serviceHost = getSubdomain(id.split('-')[0]);
            await this._generateServiceCert(id, caKeyPem, caCertPem, serviceHost);
        }

        process.stdout.write('✅ mTLS Infrastructure Ready.\n');
        return { caKeyPem, caCertPem };
    }

    async _generateServiceCert(name, caKeyPem, caCertPem, serviceHost) {
        const caKey = pki.privateKeyFromPem(caKeyPem);
        const caCert = pki.certificateFromPem(caCertPem);
        const keys = pki.rsa.generateKeyPair(2048);
        const cert = pki.createCertificate();

        cert.publicKey = keys.publicKey;
        cert.serialNumber = Date.now().toString();
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

        cert.setSubject([{ name: 'commonName', value: name }]);
        cert.setIssuer(caCert.subject.attributes);

        const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(serviceHost);
        const altNames = [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            isIp ? { type: 7, ip: serviceHost } : { type: 2, value: serviceHost }
        ];

        cert.setExtensions([
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
            { name: 'subjectAltName', altNames }
        ]);

        cert.sign(caKey, md.sha256.create());

        const keyPem = pki.privateKeyToPem(keys.privateKey);
        const certPem = pki.certificateToPem(cert);

        await fs.writeFile(path.join(this.certsDir, `${name}.key`), keyPem);
        await fs.writeFile(path.join(this.certsDir, `${name}.crt`), certPem);
    }

    /**
     * Distribute Configuration and Certs to all services
     */
    async distribute(config) {
        process.stdout.write('📂 Distributing artifacts to services...\n');

        const backendConfigPath = path.join(this.backendDir, 'wordjs-config.json');
        const gatewayConfigPath = path.join(this.gatewayDir, 'gateway-config.json');

        // 1. SAVE BACKEND CONFIG (Master)
        const fullConfig = {
            ...config,
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
            updatedAt: new Date().toISOString()
        };
        await fs.writeJson(backendConfigPath, fullConfig, { spaces: 2 });

        // 2. SAVE GATEWAY CONFIG (Decoupled)
        const gatewayConfig = {
            gatewaySecret: fullConfig.gatewaySecret,
            gatewayPort: fullConfig.gatewayPort,
            gatewayInternalPort: fullConfig.gatewayInternalPort,
            siteUrl: fullConfig.siteUrl,
            host: fullConfig.host,
            ssl: fullConfig.ssl,
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/gateway-internal.key', cert: './certs/gateway-internal.crt' },
            updatedAt: new Date().toISOString()
        };
        await fs.writeJson(gatewayConfigPath, gatewayConfig, { spaces: 2 });

        // 3. SELECTIVE CERT DISTRIBUTION
        // Ensure destination directories exist
        const gatewayCertsDir = path.join(this.gatewayDir, 'certs');
        const frontCertsDir = path.join(this.frontDir, 'certs');
        const backendCertsDir = path.join(this.backendDir, 'certs');

        await fs.ensureDir(gatewayCertsDir);
        await fs.ensureDir(backendCertsDir);
        if (await fs.pathExists(this.frontDir)) {
            await fs.ensureDir(frontCertsDir);
        }

        // Clean existing certs to avoid stale files
        await Promise.all([
            fs.emptyDir(gatewayCertsDir),
            fs.emptyDir(backendCertsDir),
            fs.pathExists(this.frontDir).then(exists => exists ? fs.emptyDir(frontCertsDir) : null)
        ]);

        const distributeCert = async (serviceName, targetDir) => {
            const files = ['cluster-ca.crt', `${serviceName}.crt`, `${serviceName}.key`];
            for (const file of files) {
                const src = path.join(this.certsDir, file);
                if (await fs.pathExists(src)) {
                    await fs.copy(src, path.join(targetDir, file));
                }
            }
        };

        await distributeCert('gateway-internal', gatewayCertsDir);
        await distributeCert('backend', backendCertsDir);
        if (await fs.pathExists(this.frontDir)) {
            await distributeCert('frontend', frontCertsDir);
        }

        process.stdout.write('🚀 Distribution Complete.\n');
    }

    async runSetup(options) {
        const { siteName, adminUser, adminPassword, host } = options;

        await this.init();
        const { caKeyPem, caCertPem } = await this.generateCerts(host || 'localhost');

        const gatewaySecret = crypto.randomBytes(32).toString('hex');
        const jwtSecret = crypto.randomBytes(64).toString('hex');

        const config = {
            siteName,
            siteUrl: `https://${host || 'localhost'}:3000`,
            frontendUrl: `https://${host || 'localhost'}:3001`,
            gatewayPort: 3000,
            gatewayInternalPort: 3100,
            gatewaySecret,
            jwtSecret,
            ssl: { enabled: true }
        };

        await this.distribute(config);

        process.stdout.write('\n✨ WordJS Cluster is now configured!\n');
        process.stdout.write('👉 Run "npm run install:all" to ensure dependencies are ready.\n');
        process.stdout.write('👉 Run "npm run dev" to start your secure cluster.\n');
    }
}

// CLI Entry Point
if (require.main === module) {
    const orchestrator = new WordJSSetup(process.cwd());
    const args = process.argv.slice(2);

    if (args.includes('--install')) {
        orchestrator.runSetup({
            siteName: 'My wordJS Site',
            adminUser: 'admin',
            adminPassword: 'password123',
            host: 'localhost'
        }).catch(err => console.error('❌ Setup failed:', err));
    } else {
        console.log('WordJS Orchestrator CLI');
        console.log('Usage: node setup/index.js --install');
    }
}

module.exports = WordJSSetup;
