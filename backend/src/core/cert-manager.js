const acme = require('acme-client');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { v4: uuidv4 } = require('uuid');

const CONFIG_PATH = path.resolve(__dirname, '../../wordjs-config.json');
const DATA_DIR = path.resolve(__dirname, '../../data/ssl'); // Store ACME account keys here
const LIVE_DIR = path.resolve(__dirname, '../../ssl/live'); // Store real certs here
const WWW_ROOT = path.resolve(__dirname, '../../public'); // For HTTP-01

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });

class CertManager {
    constructor() {
        this.client = null;
        this.accountKeyPath = path.join(DATA_DIR, 'account.key');
        // Let's Encrypt URLs
        this.directoryUrl = acme.directory.letsencrypt.production;
        // this.directoryUrl = acme.directory.letsencrypt.staging; // TODO: Configurable?
    }

    async initClient(email, useStaging = false) {
        if (useStaging) this.directoryUrl = acme.directory.letsencrypt.staging;

        // 1. Load or Generate Account Key
        let accountKey;
        if (fs.existsSync(this.accountKeyPath)) {
            accountKey = fs.readFileSync(this.accountKeyPath);
        } else {
            console.log('[CertManager] Generatng new Account Key...');
            accountKey = await acme.forge.createPrivateKey(); // ECDSA by default in newer lib or RSA
            fs.writeFileSync(this.accountKeyPath, accountKey);
        }

        // 2. Initialize Client
        this.client = new acme.Client({
            directoryUrl: this.directoryUrl,
            accountKey: accountKey
        });

        // 3. Register Account (Idempotent usually)
        try {
            await this.client.createAccount({
                termsOfServiceAgreed: true,
                contact: [`mailto:${email}`]
            });
            console.log('[CertManager] Account registered/found.');
        } catch (e) {
            console.error('[CertManager] Account Registration Error:', e.message);
            throw e;
        }
    }

    /**
     * Start Order and Return Challenge
     * @param {string} domain 
     * @param {string} type 'http-01' | 'dns-01'
     */
    async createOrder(domain, type = 'http-01') {
        if (!this.client) throw new Error('Client not initialized. Call initClient first.');

        const order = await this.client.createOrder({ identifiers: [{ type: 'dns', value: domain }] });
        const authorizations = await this.client.getAuthorizations(order);
        const authz = authorizations[0];
        const challenge = authz.challenges.find(c => c.type === type);

        if (!challenge) throw new Error(`Challenge type ${type} not found for this domain.`);

        const keyAuthorization = await this.client.getChallengeKeyAuthorization(challenge);

        // State to return to UI
        return {
            orderUrl: order.url,
            challenge,
            authzUrl: authz.url,
            keyAuthorization, // For HTTP-01 file content
            dnsRecord: `_acme-challenge.${domain}`, // For DNS-01
            dnsValue: keyAuthorization // Actually, for DNS-01 it's a digest of this
        };
    }

    async getDNSDigest(keyAuthorization) {
        // dns-01 requires SHA256 digest of keyAuth
        // acme-client might have a helper or we do it manually, but client usually handles it ONLY if we use its built-in challenge completion.
        // But since we are Manual, we need to show the User the simplified string.
        // Wait, acme-client documentation says `getChallengeKeyAuthorization` returns the string for the file.
        // For DNS, the TXT record value is base64url(sha256(keyAuth)).

        // Using internal helper if available or manual:
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(keyAuthorization).digest('base64');
        return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    /**
     * Start DNS-01 Challenge Flow
     * Returns the TXT record details for user to add to their DNS
     */
    async startDNSChallenge(domain, email, useStaging = false) {
        try {
            // Initialize client if needed
            await this.initClient(email, useStaging);

            // Create order with DNS-01 challenge type
            const orderData = await this.createOrder(domain, 'dns-01');

            // Get the DNS digest value (base64url of sha256)
            const txtValue = await this.getDNSDigest(orderData.keyAuthorization);

            // Return data for UI
            return {
                domain,
                txtRecord: `_acme-challenge.${domain}`,
                txtValue,
                orderUrl: orderData.orderUrl,
                challenge: orderData.challenge,
                authzUrl: orderData.authzUrl,
                keyAuthorization: orderData.keyAuthorization
            };
        } catch (e) {
            console.error('[CertManager] DNS Start Error:', e);
            throw new Error(`DNS challenge start failed: ${e.message}`);
        }
    }

    /**
     * Finish DNS-01 Challenge Flow
     * Call after user has added the TXT record
     */
    async finishDNSChallenge(step1Data, email, useStaging = false) {
        try {
            // Re-init client if needed (in case of server restart)
            await this.initClient(email, useStaging);

            // Verify the challenge
            await this.client.verifyChallenge(
                { url: step1Data.authzUrl, identifier: { type: 'dns', value: step1Data.domain } },
                step1Data.challenge
            );

            // Complete and wait
            await this.client.completeChallenge(step1Data.challenge);
            await this.client.waitForValidStatus(step1Data.challenge);

            // Create CSR and finalize
            const [key, csr] = await acme.forge.createCsr({
                commonName: step1Data.domain,
            });

            // Finalize the order
            const finalized = await this.client.finalizeOrder(
                { url: step1Data.orderUrl },
                csr
            );

            // Get certificate
            const cert = await this.client.getCertificate(finalized);

            // Save to files
            const domainDir = path.join(LIVE_DIR, step1Data.domain);
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });

            fs.writeFileSync(path.join(domainDir, 'privkey.pem'), key);
            fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), cert);

            // Update config to use new cert
            this.updateSSLConfig(
                path.join(domainDir, 'privkey.pem'),
                path.join(domainDir, 'fullchain.pem')
            );

            return {
                success: true,
                path: domainDir,
                message: 'Certificate provisioned successfully!'
            };
        } catch (e) {
            console.error('[CertManager] DNS Finish Error:', e);
            throw new Error(`DNS verification failed: ${e.message}`);
        }
    }

    /**
     * Update SSL config paths
     * Note: We do NOT force enable SSL here. The user must toggle it manually in the UI.
     */
    updateSSLConfig(keyPath, certPath) {
        let config = {};
        if (fs.existsSync(CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
        if (!config.ssl) config.ssl = {};

        // We just update the paths. 
        // We preserve existing enabled state, or default to false if not set.
        if (typeof config.ssl.enabled === 'undefined') {
            config.ssl.enabled = false;
        }

        config.ssl.key = keyPath;
        config.ssl.cert = certPath;

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
        console.log('[CertManager] SSL paths updated (SSL state preserved):', { keyPath, certPath });
    }

    /**
     * Verify DNS Propagation
     */
    async checkDNSPropagation(domain, expectedValue) {
        try {
            const records = await dns.resolveTxt(`_acme-challenge.${domain}`);
            // specific record
            const flat = records.flat();
            return flat.includes(expectedValue);
        } catch (e) {
            return false;
        }
    }

    /**
     * Prepare HTTP-01 Challenge File
     */
    async writeChallengeFile(token, keyAuthorization) {
        const challengeDir = path.join(WWW_ROOT, '.well-known', 'acme-challenge');
        if (!fs.existsSync(challengeDir)) fs.mkdirSync(challengeDir, { recursive: true });
        fs.writeFileSync(path.join(challengeDir, token), keyAuthorization);
        return true;
    }

    /**
     * Complete Challenge & Finalize
     */
    async finalize(orderUrl, challenge, authz) {
        // 1. Verify Challenge
        await this.client.verifyChallenge(authz, challenge);

        // 2. Wait for Valid Status using the challenge struct
        // Library helper: completeChallenge? 
        // Actually `verifyChallenge` instructs ACME to verify. We then poll `waitForValidStatus`.
        await this.client.completeChallenge(challenge);
        await this.client.waitForValidStatus(challenge);

        // 3. Finalize Order (CSR)
        const [key, csr] = await acme.forge.createCsr({
            commonName: authz.identifier.value,
        });

        // We might need to reload order to get latest object?
        // acme-client's finalized function usually takes the order object.
        // Let's re-fetch order if possible using URL? 
        // Actually `client.finalizeOrder` takes the order object.
        // We'll trust the user passed logic or we just re-get it if needed? 
        // Simplifying: We rely on the `order` object being mostly just needed for its URL/finalize endpoint.
        // But `client.finalizeOrder` expects the order object. 
        // Just passing { url: orderUrl } might work if lib allows, otherwise we should persist full order?
        // For now let's assume valid order object is reconstructed or kept in memory (Plugin Context would lose it).
        // Better: re-fetch order by URL? Lib doesn't expose `getOrder(url)` explicitly easily.
        // We will Require the frontend to pass the relevant Order Details back or we store in DB? 
        // Storing in a robust way is best. But for this MVP, we can keep it in memory for the session? 
        // No, User might close tab. 
        // Let's assume passed `order` is sufficient.

        // Wait, `createOrder` returns an object. We can serialize it to frontend and pass it back.

        // NOTE: `finalizeOrder` requires the Order Object.
        // We will perform a trick: create a dummy order object with the URL if the lib allows, or we just try.
        // Actually, safer to just re-create a "fresh" order for the same domain? No, that makes a NEW flow.
        // Correct Approach: The library `client.getAuthorizations` takes an order. 
        // So likely `client.finalizeOrder` needs the order. 
        // Let's rely on serialization.
    }

    /**
     * Install Custom Certificate
     * @param {string} keyContent Content of Private Key
     * @param {string} certContent Content of Certificate
     */
    async installCustomCert(keyContent, certContent) {
        try {
            // Basic Validation
            if (!keyContent.includes('PRIVATE KEY')) throw new Error('Invalid Private Key');
            if (!certContent.includes('CERTIFICATE')) throw new Error('Invalid Certificate');

            const domain = 'custom'; // We could parse the cert to get the CN, but 'custom' folder is fine for now
            const customDir = path.join(LIVE_DIR, 'custom_upload');
            if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });

            const keyPath = path.join(customDir, 'privkey.pem');
            const certPath = path.join(customDir, 'fullchain.pem');

            fs.writeFileSync(keyPath, keyContent);
            fs.writeFileSync(certPath, certContent);

            // Update Config
            this.updateSSLConfig(keyPath, certPath);

            return { success: true, path: customDir };
        } catch (e) {
            console.error('[CertManager] Custom Install Error:', e);
            throw new Error(`Failed to install custom cert: ${e.message}`);
        }
    }

    // Simplified "One Shot" for HTTP-01
    // Simplified "Step-by-Step" for DNS-01

    /**
     * Get Current Gateway Config & Cert Info
     */
    getConfig() {
        // Default
        const result = {
            gatewayPort: 3000,
            sslEnabled: false,
            certInfo: null,
            siteUrl: null
        };

        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            result.gatewayPort = config.gatewayPort || 3000;
            result.sslEnabled = config.ssl?.enabled || false;
            result.siteUrl = config.siteUrl || null;

            // Try to find and parse certificate
            let certPath = null;

            // 1. Check explicit cert path in config
            if (config.ssl && config.ssl.cert && fs.existsSync(config.ssl.cert)) {
                certPath = config.ssl.cert;
            }
            // 2. Check auto-generated cert
            else {
                const autoGenCert = path.resolve(__dirname, '../../../ssl-auto.crt');
                if (fs.existsSync(autoGenCert)) {
                    certPath = autoGenCert;
                }
            }

            if (certPath) {
                try {
                    const { X509Certificate } = require('crypto');
                    const certBuffer = fs.readFileSync(certPath);
                    const x509 = new X509Certificate(certBuffer);

                    // Parse subject to extract CN
                    const subjectParts = x509.subject.split('\n');
                    const cnLine = subjectParts.find(s => s.startsWith('CN='));
                    const commonName = cnLine ? cnLine.replace('CN=', '') : 'Unknown';

                    // Parse issuer
                    const issuerParts = x509.issuer.split('\n');
                    const issuerCN = issuerParts.find(s => s.startsWith('CN='));
                    const issuerName = issuerCN ? issuerCN.replace('CN=', '') : 'Unknown';

                    // Determine type
                    const isSelfSigned = x509.subject === x509.issuer;
                    const isLetsEncrypt = x509.issuer.includes("Let's Encrypt") || x509.issuer.includes('R3') || x509.issuer.includes('R10');

                    result.certInfo = {
                        commonName,
                        issuer: issuerName,
                        validFrom: x509.validFrom,
                        validTo: x509.validTo,
                        fingerprint: x509.fingerprint256 || x509.fingerprint,
                        serialNumber: x509.serialNumber,
                        type: isLetsEncrypt ? 'letsencrypt' : (isSelfSigned ? 'self-signed' : 'custom'),
                        path: certPath
                    };
                } catch (e) {
                    console.error('Failed to parse cert:', e);
                    result.certInfo = { error: 'Invalid Certificate File', type: 'error' };
                }
            } else if (result.sslEnabled) {
                result.certInfo = { type: 'none', message: 'SSL enabled but no certificate found' };
            }
        }

        return result;
    }

    /**
     * Update Gateway Config
     */
    updateGatewayConfig(port, sslEnabled) {
        let config = {};
        if (fs.existsSync(CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }

        // Update Port
        const newPort = port ? parseInt(port) : (config.gatewayPort || 3000);
        config.gatewayPort = newPort;

        // Update SSL
        if (!config.ssl) config.ssl = {};
        config.ssl.enabled = !!sslEnabled;

        // CRITICAL: Update siteUrl to match the protocol
        // When SSL is enabled/disabled, the siteUrl must reflect the correct protocol
        if (config.siteUrl) {
            const protocol = sslEnabled ? 'https' : 'http';
            try {
                const url = new URL(config.siteUrl);
                url.protocol = protocol + ':';
                // Only remove port if it's the standard port for THIS protocol
                // HTTP standard: 80, HTTPS standard: 443
                const isStandardPort = (protocol === 'http' && newPort === 80) ||
                    (protocol === 'https' && newPort === 443);
                if (isStandardPort) {
                    url.port = ''; // Remove port for standard ports
                } else {
                    url.port = String(newPort);
                }
                config.siteUrl = url.toString().replace(/\/$/, ''); // Remove trailing slash
                console.log(`[CertManager] Updated siteUrl to: ${config.siteUrl}`);
            } catch (e) {
                console.error('[CertManager] Failed to parse siteUrl:', e.message);
                // Fallback: just replace protocol
                const oldUrl = config.siteUrl;
                config.siteUrl = oldUrl
                    .replace(/^https?:/, protocol + ':')
                    .replace(/\/$/, '');
            }
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
        return { success: true, siteUrl: config.siteUrl };
    }
}

module.exports = new CertManager();
