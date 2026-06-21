const acme = require('acme-client');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { v4: uuidv4 } = require('uuid');

const CONFIG_PATH = path.resolve(__dirname, '../../wordjs-config.json');
const DATA_DIR = path.resolve(__dirname, '../../data/ssl'); // Store ACME account keys here
const LIVE_DIR = path.resolve(__dirname, '../../ssl/live'); // Store real certs here
const WWW_ROOT = path.resolve(__dirname, '../../public'); // For HTTP-01

// 0o700: these directories hold private keys (account.key, privkey.pem) — they must not be
// world/group-traversable.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });

// Write a PRIVATE KEY (account key / privkey.pem) with restrictive permissions. writeFileSync's
// `mode` is ignored when the file already exists, so we ALSO chmod after the write to guarantee 0o600
// on every platform/path.
function writePrivateKey(filePath, content) {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* chmod is a no-op on some filesystems (e.g. Windows) */ }
}

class CertManager {
    client: any;
    accountKeyPath: string;
    directoryUrl: any;

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
            writePrivateKey(this.accountKeyPath, accountKey);
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
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true, mode: 0o700 });

            writePrivateKey(path.join(domainDir, 'privkey.pem'), key);
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
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true, mode: 0o700 });

            writePrivateKey(path.join(domainDir, 'privkey.pem'), key);
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
    /**
     * Install a renewed cert in MONOLITH/embedded mode (no gateway process to push to). Writes it to
     * the files the monolith's resolveSSL() reads (so a restart serves it) and hot-reloads the running
     * HTTPS server in-process via a reload hook the monolith installs (so no restart is needed).
     */
    async installCertEmbedded(keyContent, certContent) {
        const gwDir = path.resolve(__dirname, '../../../gateway');
        const importedDir = path.join(gwDir, 'ssl', 'live', 'imported');
        fs.mkdirSync(importedDir, { recursive: true, mode: 0o700 });
        writePrivateKey(path.join(importedDir, 'privkey.pem'), keyContent);
        fs.writeFileSync(path.join(importedDir, 'fullchain.pem'), certContent);

        // Point gateway-config.json at the new cert so the next monolith boot's resolveSSL() serves it.
        try {
            const gwCfgPath = path.join(gwDir, 'gateway-config.json');
            const gwCfg = fs.existsSync(gwCfgPath) ? JSON.parse(fs.readFileSync(gwCfgPath, 'utf8')) : {};
            gwCfg.ssl = { ...(gwCfg.ssl || {}), key: './ssl/live/imported/privkey.pem', cert: './ssl/live/imported/fullchain.pem', enabled: true };
            fs.writeFileSync(gwCfgPath, JSON.stringify(gwCfg, null, 2));
        } catch (e: any) {
            console.warn('[CertManager] embedded: could not update gateway-config.json:', e && e.message);
        }

        // Live hot-reload of the running monolith HTTPS server (no restart) if it exposed the hook.
        try {
            if (typeof (global as any).__WORDJS_RELOAD_TLS__ === 'function') {
                (global as any).__WORDJS_RELOAD_TLS__(keyContent, certContent);
                console.log('[CertManager] embedded: hot-reloaded monolith TLS in-process (setSecureContext).');
            } else {
                console.log('[CertManager] embedded: cert written — restart the monolith to serve it (no live-reload hook present).');
            }
        } catch (e: any) {
            console.warn('[CertManager] embedded TLS reload failed:', e && e.message);
        }
        return { success: true, embedded: true };
    }

    async pushCertToGateway(keyContent, certContent) {
        // Monolith/embedded: there is no gateway on :3100 — install the cert in-process instead.
        if (process.env.WORDJS_EMBEDDED === '1') {
            return this.installCertEmbedded(keyContent, certContent);
        }
        try {
            // Read backend config for mTLS
            let backendConfig: any = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            // SECURITY: validate the gateway's server cert. We hand the freshly-issued PRIVATE KEY to
            // this connection, so a co-resident process that port-steals 127.0.0.1:3100 must not be able
            // to receive it. The cluster CA is loaded as `ca`, and the gateway-internal cert carries
            // 'localhost' + '127.0.0.1' SANs (certManager.generateServiceCert), so verifying against
            // servername 'localhost' succeeds for the genuine gateway and fails for an impostor.
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: true,
                servername: 'localhost'
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
     * Install Custom Certificate
     * @param {string} keyContent Content of Private Key
     * @param {string} certContent Content of Certificate
     */
    async installCustomCert(keyContent, certContent) {
        try {
            // Validation: actually PARSE the key + cert and verify they MATCH. The old check only looked
            // for the substrings 'PRIVATE KEY' / 'CERTIFICATE', so a malformed or mismatched pair would
            // be written and the gateway restarted with broken TLS (self-inflicted DoS) — or an
            // attacker-supplied unrelated cert installed.
            const crypto = require('crypto');
            let keyObj, certObj;
            try { keyObj = crypto.createPrivateKey(keyContent); }
            catch { throw new Error('Invalid or unparseable private key'); }
            try { certObj = new crypto.X509Certificate(certContent); }
            catch { throw new Error('Invalid or unparseable certificate'); }
            if (!certObj.checkPrivateKey(keyObj)) {
                throw new Error('Certificate and private key do not match');
            }

            const domain = 'custom'; // We could parse the cert to get the CN, but 'custom' folder is fine for now
            const customDir = path.join(LIVE_DIR, 'custom_upload');
            if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true, mode: 0o700 });

            const keyPath = path.join(customDir, 'privkey.pem');
            const certPath = path.join(customDir, 'fullchain.pem');

            writePrivateKey(keyPath, keyContent);
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
    async getConfig(): Promise<any> {
        const defaultResult = {
            gatewayPort: 3000,
            sslEnabled: false,
            certInfo: null,
            siteUrl: null,
            source: 'fallback'
        };

        try {
            // Read backend config to find cert paths for mTLS
            let backendConfig: any = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            // SECURITY: validate the gateway's server cert against the cluster CA. The stale comment
            // (rejectUnauthorized:false "because localhost might not match the CN") is wrong: the
            // gateway-internal cert carries 'localhost' + '127.0.0.1' SANs, so verifying with
            // servername 'localhost' matches the genuine gateway and rejects any impostor on :3100.
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: true,
                servername: 'localhost'
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
     * Days until a cert's validTo (negative if expired/unparseable/absent).
     */
    daysUntil(validTo): number {
        if (!validTo) return -Infinity;
        const t = new Date(validTo).getTime();
        if (Number.isNaN(t)) return -Infinity;
        return (t - Date.now()) / 86400000;
    }

    /**
     * Read the notAfter of the cert we last obtained for a domain, straight from disk. This is the
     * authoritative, gateway-independent record of the live cert's expiry — it works in split mode,
     * survives a transient gateway outage, and does NOT depend on the gateway's (lossy, CN-only)
     * issuer-type classification. Returns null when no parseable local cert exists.
     */
    readLocalCertValidTo(domain): string | null {
        try {
            const p = path.join(LIVE_DIR, domain, 'fullchain.pem');
            if (fs.existsSync(p)) {
                const x509 = new (require('crypto').X509Certificate)(fs.readFileSync(p));
                return x509.validTo;
            }
        } catch { /* unparseable → treat as absent */ }
        return null;
    }

    /**
     * Auto-renewal entry point — invoked by the cron job (wordjs_cert_renewal) and the manual
     * "renew now" route. Reads config.acme, skips unless the live cert is within renewBeforeDays of
     * expiry (so we never hammer Let's Encrypt and hit its rate limits), then re-runs the existing
     * HTTP-01 provisioning, which already pushes the new cert to the gateway and hot-reloads it.
     * The outcome is recorded in the 'acme_last_renewal' option for the renewal-status endpoint.
     */
    async renewIfDue({ force = false } = {}): Promise<any> {
        const config = require('../config/app');
        const acme = config.acme || {};
        const { getOption, updateOption } = require('./options');

        const record = async (data) => {
            try { await updateOption('acme_last_renewal', { at: Date.now(), ...data }); }
            catch { /* options table may be unavailable pre-install */ }
            return data;
        };

        if (!acme.enabled && !force) return { skipped: true, reason: 'disabled' };

        if (acme.challengeType === 'dns-01') {
            // DNS-01 cannot complete unattended without a DNS-provider write API (none exists here).
            return record({ ok: false, skipped: true, reason: 'dns-01-manual', error: 'DNS-01 auto-renewal needs manual TXT publishing — use the DNS flow in the admin UI.' });
        }

        // Resolve the primary domain to maintain (first configured domain, else the siteUrl host).
        let domain = (Array.isArray(acme.domains) && acme.domains[0]) || '';
        if (!domain && config.siteUrl) {
            try { domain = new URL(config.siteUrl).hostname; } catch { /* ignore */ }
        }
        if (!domain) return record({ ok: false, error: 'No domain configured for ACME (set acme.domains or siteUrl).' });
        if (!acme.email) return record({ ok: false, error: 'No ACME account email configured.' });

        const threshold = Number(acme.renewBeforeDays) > 0 ? Number(acme.renewBeforeDays) : 30;

        // Decide whether renewal is due from the cert's REMAINING VALIDITY — independent of the
        // gateway's issuer-type classification (which only inspects the issuer CN and so never tags a
        // real Let's Encrypt cert, whose "Let's Encrypt" string lives in the issuer O=). Prefer the
        // locally-saved cert on disk; fall back to what the gateway reports. A non-finite result means
        // there is no parseable cert yet → first issuance, which legitimately proceeds.
        let validTo = this.readLocalCertValidTo(domain);
        if (!validTo) {
            try {
                const cfg = await this.getConfig();
                const t = cfg && cfg.certInfo && cfg.certInfo.type;
                // Trust the gateway's reported expiry only for a REAL cert (Let's Encrypt or a
                // custom-uploaded one). The gateway always carries a self-signed placeholder; counting
                // its ~365-day validity here would make the gate permanently "not_due" and the cron
                // would never obtain the FIRST real certificate.
                if (t && t !== 'self-signed' && t !== 'none') validTo = (cfg.certInfo.validTo) || null;
            } catch { /* gateway maybe unreachable */ }
        }
        const days = this.daysUntil(validTo);

        if (!force && Number.isFinite(days) && days > threshold) {
            return { skipped: true, reason: 'not_due', domain, daysRemaining: Math.round(days), validTo };
        }

        // Failure backoff: if a recent attempt for this domain failed, hold off until the cooldown
        // elapses. Without this, a persistently-failing validation (e.g. port 80 unreachable) would
        // re-order on every cron tick and could exhaust Let's Encrypt's failed-validation budget.
        if (!force) {
            const last = await getOption('acme_last_renewal', null);
            const COOLDOWN_MS = 6 * 60 * 60 * 1000;
            if (last && last.ok === false && last.domain === domain && (Date.now() - (last.at || 0)) < COOLDOWN_MS) {
                return { skipped: true, reason: 'recent_failure_backoff', domain, lastError: last.error, retryInMs: COOLDOWN_MS - (Date.now() - (last.at || 0)) };
            }
        }

        // Due (or forced, or no cert yet) → provision (provisionAutoHTTP saves locally + pushes to gateway).
        try {
            console.log(`[CertManager] Auto-renewal: provisioning '${domain}' (staging=${!!acme.staging}, force=${force}, daysRemaining=${Number.isFinite(days) ? Math.round(days) : 'n/a'})`);
            await this.provisionAutoHTTP(domain, acme.email, !!acme.staging);
            return record({ ok: true, domain, validTo: this.readLocalCertValidTo(domain) });
        } catch (e) {
            console.error('[CertManager] Auto-renewal failed:', e.message);
            return record({ ok: false, domain, error: e.message });
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
            let backendConfig: any = {};
            if (fs.existsSync(CONFIG_PATH)) {
                backendConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }

            const MTLS_KEY = (backendConfig.mtls && backendConfig.mtls.key) ? path.resolve(__dirname, '../../' + backendConfig.mtls.key) : null;
            const MTLS_CERT = (backendConfig.mtls && backendConfig.mtls.cert) ? path.resolve(__dirname, '../../' + backendConfig.mtls.cert) : null;
            const MTLS_CA = (backendConfig.mtls && backendConfig.mtls.ca) ? path.resolve(__dirname, '../../' + backendConfig.mtls.ca) : null;

            if (!MTLS_KEY || !fs.existsSync(MTLS_KEY)) throw new Error('Backend mTLS Key not found');

            const https = require('https');
            // SECURITY: validate the gateway's server cert against the cluster CA (servername 'localhost'
            // matches the gateway-internal cert SANs) so config-update can't be hijacked by a co-resident
            // process occupying 127.0.0.1:3100.
            const agent = new https.Agent({
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                ca: MTLS_CA && fs.existsSync(MTLS_CA) ? fs.readFileSync(MTLS_CA) : undefined,
                rejectUnauthorized: true,
                servername: 'localhost'
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
