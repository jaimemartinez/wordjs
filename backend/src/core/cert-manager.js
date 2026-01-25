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
    /**
     * Auto Provision HTTP-01
     */
    async provisionAutoHTTP(domain, email, useStaging = false) {
        try {
            console.log(`[CertManager] Starting HTTP-01 provisioning for ${domain}...`);
            await this.initClient(email, useStaging);

            // 1. Create Order
            const orderData = await this.createOrder(domain, 'http-01');
            console.log('[CertManager] Order created. Challenge token:', orderData.challenge.token);

            // 2. Write Challenge File
            await this.writeChallengeFile(orderData.challenge.token, orderData.keyAuthorization);
            console.log('[CertManager] Challenge file written.');

            // 3. Verify & Complete
            // Note: Verify locally trigger the check? No, verifyChallenge tells ACME to check.
            await this.client.verifyChallenge(
                { url: orderData.authzUrl, identifier: { type: 'dns', value: domain } },
                orderData.challenge
            );
            await this.client.completeChallenge(orderData.challenge);
            console.log('[CertManager] Challenge completed. Waiting for validation...');

            await this.client.waitForValidStatus(orderData.challenge);
            console.log('[CertManager] Challenge validated.');

            // 4. Finalize
            const [key, csr] = await acme.forge.createCsr({
                commonName: domain,
            });

            const finalized = await this.client.finalizeOrder(
                { url: orderData.orderUrl },
                csr
            );

            const cert = await this.client.getCertificate(finalized);
            console.log('[CertManager] Certificate downloaded.');

            // 5. Save locally (backup/reference)
            const domainDir = path.join(LIVE_DIR, domain);
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });

            fs.writeFileSync(path.join(domainDir, 'privkey.pem'), key);
            fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), cert);

            // 6. Push to Gateway
            // Ensure key is string
            await this.pushCertToGateway(key.toString(), cert.toString());
            console.log('[CertManager] Certificate pushed to Gateway.');

            return { success: true, message: 'Certificate provisioned and installed.' };

        } catch (e) {
            console.error('[CertManager] Auto HTTP Provision Error:', e);
            throw new Error(`Provisioning failed: ${e.message}`);
        }
    }

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
    /**
     * Push Certificate to Gateway
     */
    async pushCertToGateway(keyContent, certContent) {
        try {
            // Read backend config for mTLS
            let backendConfig = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: false
            });

            const gatewayUrl = `https://127.0.0.1:3100/cert-upload`;

            const postData = JSON.stringify({ key: keyContent, cert: certContent });

            return new Promise((resolve, reject) => {
                const req = https.request(gatewayUrl, {
                    method: 'POST',
                    agent: agent,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(JSON.parse(data));
                        } else {
                            try {
                                const err = JSON.parse(data);
                                reject(new Error(err.error || `Gateway returned ${res.statusCode}`));
                            } catch (e) {
                                reject(new Error(`Gateway returned ${res.statusCode}`));
                            }
                        }
                    });
                });

                req.on('error', (e) => reject(e));
                req.write(postData);
                req.end();
            });
        } catch (e) {
            console.error('[CertManager] Push Error:', e);
            throw e;
        }
    }

    /**
     * Update SSL config (Refactored to Push)
     * Keeps the signature but now keyPath/certPath might be used to read content if they are paths
     * OR we should refactor upstream callers to pass content.
     * For now, we read the files at paths and push them.
     */
    async updateSSLConfig(keyPath, certPath) {
        try {
            const keyContent = fs.readFileSync(keyPath, 'utf8');
            const certContent = fs.readFileSync(certPath, 'utf8');
            await this.pushCertToGateway(keyContent, certContent);
            console.log('[CertManager] Certificate pushed to Gateway.');
        } catch (e) {
            console.error('[CertManager] Failed to push cert to gateway:', e);
            throw e;
        }
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
    /**
     * Get Current Gateway Config & Cert Info via Internal API
     */
    async getConfig() {
        const defaultResult = {
            gatewayPort: 3000,
            sslEnabled: false,
            certInfo: null,
            siteUrl: null,
            source: 'fallback'
        };

        try {
            // Read backend config to find cert paths for mTLS
            let backendConfig = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: false
                // We use rejectUnauthorized: false primarily because 'localhost' might not match the CN if cert is IP based, 
                // but checking CA should be strict ideally. For internal loopback, we trust the port + mTLS auth.
            });

            const gatewayUrl = `https://127.0.0.1:3100/info`; // Default internal port
            // Note: If GatewayInternalPort is dynamic, we should read it from wordjs-config if available or assume standard.

            // Should read gatewayInternalPort from backend config if we want to be safe?
            // backendConfig doesn't usually track gateway's internal port unless we added it.
            // Let's assume 3100 as per common setup.

            const axios = require('axios'); // Ensure axios is available or use native https
            // We'll use native https request to avoid implicit dependency if axios is separate, 
            // but axios is in package.json (checked previously).

            // Using a simple promise wrapper for https.get to minimize deps if needed, but axios is cleaner.
            // Let's use axios if we are sure it's there. package.json showed it.
            // But wait, CertManager shouldn't carry heavy deps if not needed.
            // Let's use native https to be safe and robust.

            return new Promise((resolve, reject) => {
                const req = https.request(gatewayUrl, {
                    method: 'GET',
                    agent: agent,
                    timeout: 2000
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                resolve({ ...defaultResult, error: 'Invalid JSON from Gateway' });
                            }
                        } else {
                            resolve({ ...defaultResult, error: `Gateway returned ${res.statusCode}` });
                        }
                    });
                });

                req.on('error', (e) => {
                    console.error('[CertManager] Gateway connection failed:', e.message);
                    resolve({ ...defaultResult, error: 'Gateway Unreachable' });
                });

                req.end();
            });

        } catch (e) {
            console.error('[CertManager] getConfig Error:', e);
            return { ...defaultResult, error: e.message };
        }
    }

    /**
     * Ensure Gateway has a certificate (Self-Signed fallback)
     */
    async ensureGatewayCert() {
        try {
            const config = await this.getConfig();
            const hasCert = config.certInfo && config.certInfo.type !== 'none' && config.certInfo.type !== 'error';

            if (!hasCert) {
                console.log('[CertManager] No certificate found on Gateway. Generating self-signed...');

                const selfsigned = require('selfsigned');
                const attrs = [{ name: 'commonName', value: 'localhost' }];

                // CRITICAL: selfsigned.generate returns a Promise (async)
                const pems = await selfsigned.generate(attrs, { days: 365 });

                console.log('[CertManager] Self-signed certificate generated.');

                await this.pushCertToGateway(pems.private, pems.cert);
                console.log('[CertManager] Self-signed certificate pushed to Gateway.');
                return { success: true, message: 'Self-signed certificate generated' };
            }
            return { success: true, message: 'Certificate already exists' };
        } catch (e) {
            console.error('[CertManager] Ensure Cert Error:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Update Gateway Config (Push Only - No Local Storage)
     */
    async updateGatewayConfig(port, sslEnabled) {
        try {
            // Read mTLS config from local file (only for authentication, not for storing gateway config)
            let backendConfig = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: false
            });

            const gatewayUrl = `https://127.0.0.1:3100/config-update`;
            const postData = JSON.stringify({
                port: port ? parseInt(port) : undefined,
                sslEnabled: typeof sslEnabled !== 'undefined' ? !!sslEnabled : undefined
                // Gateway will calculate siteUrl itself based on these values
            });

            return new Promise((resolve, reject) => {
                const req = https.request(gatewayUrl, {
                    method: 'POST',
                    agent: agent,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            const result = JSON.parse(data);
                            console.log('[CertManager] Gateway configuration pushed successfully.');
                            resolve(result);
                        } else {
                            reject(new Error(`Gateway returned ${res.statusCode}`));
                        }
                    });
                });

                req.on('error', (e) => reject(e));
                req.write(postData);
                req.end();
            });

        } catch (e) {
            console.error('[CertManager] Config Push Error:', e);
            throw e;
        }
    }
}

module.exports = new CertManager();
