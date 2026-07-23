const acme = require('acme-client');
// Bound every outbound ACME HTTP attempt (directory/order/finalize AND the http-01 local pre-verify
// fetch). Without this, an unreachable port 80 left each verify attempt hanging on the OS TCP
// timeout and the admin request froze for minutes.
acme.axios.defaults.timeout = 10000;
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
function writePrivateKey(filePath: string, content: any) {
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

    async initClient(email: string, useStaging = false, directoryUrlOverride: string | null = null) {
        // ASSIGN BOTH BRANCHES. This was `if (useStaging) …` with NO else, on a module-level SINGLETON
        // (`module.exports = new CertManager()`), so `directoryUrl` was process-global sticky state:
        // one auto-renewal running with `acme.staging` set (renewIfDue → provisionAutoHTTP) pinned the
        // whole process to staging, and every later order the UI asked for as PRODUCTION silently went
        // to staging too. A restart then reset it back to production via the constructor. That is how a
        // two-step DNS-01 flow ended up starting at one CA and finishing at the other, where the
        // challenge URL does not exist — boulder answers "No such challenge".
        this.directoryUrl = directoryUrlOverride
            || (useStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production);

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
            accountKey: accountKey,
            // acme-client's default backoff (10 attempts, 5s→30s) lets verifyChallenge /
            // waitForValidStatus spin ~4 minutes INSIDE an admin HTTP request — the UI just hangs on
            // "Processing...". 5 attempts at 3s→10s caps each phase under ~40s of backoff while still
            // riding out normal CA validation latency.
            backoffAttempts: 5,
            backoffMin: 3000,
            backoffMax: 10000
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
    async createOrder(domain: string, type = 'http-01') {
        if (!this.client) throw new Error('Client not initialized. Call initClient first.');

        const order = await this.client.createOrder({ identifiers: [{ type: 'dns', value: domain }] });
        const authorizations = await this.client.getAuthorizations(order);
        const authz = authorizations[0];
        const challenge = authz.challenges.find((c: any) => c.type === type);

        if (!challenge) throw new Error(`Challenge type ${type} not found for this domain.`);

        const keyAuthorization = await this.client.getChallengeKeyAuthorization(challenge);

        // State to return to UI.
        // NOTE: getChallengeKeyAuthorization() is challenge-type-aware — for http-01 it returns the
        // file content (`token.thumbprint`), for dns-01 it returns the FINAL TXT value, ALREADY
        // digested per RFC 8555 §8.4 (base64url(sha256(`token.thumbprint`))). Never hash it again.
        return {
            orderUrl: order.url,
            challenge,
            authzUrl: authz.url,
            keyAuthorization,
            dnsRecord: `_acme-challenge.${domain}` // For DNS-01
        };
    }

    /**
     * Start DNS-01 Challenge Flow
     * Returns the TXT record details for user to add to their DNS
     */
    /**
     * Auto Provision HTTP-01
     */
    async provisionAutoHTTP(domain: string, email: string, useStaging = false) {
        try {
            console.log(`[CertManager] Starting HTTP-01 provisioning for ${domain}...`);
            await this.initClient(email, useStaging);

            // 1. Create Order
            const orderData = await this.createOrder(domain, 'http-01');
            console.log('[CertManager] Order created. Challenge token:', orderData.challenge.token);

            // 2. Write Challenge File
            await this.writeChallengeFile(orderData.challenge.token, orderData.keyAuthorization);
            console.log('[CertManager] Challenge file written.');

            // 3. Best-effort LOCAL pre-flight: it fetches http://<domain>/.well-known/... from THIS
            // machine. Behind NAT without hairpin the server often cannot reach its own public
            // hostname even though the CA can, so a miss here must not abort the order —
            // completeChallenge + waitForValidStatus below get the CA's authoritative verdict.
            try {
                await this.client.verifyChallenge(
                    { url: orderData.authzUrl, identifier: { type: 'dns', value: domain } },
                    orderData.challenge
                );
            } catch (preErr: any) {
                console.warn('[CertManager] Local http-01 pre-verify inconclusive (continuing — the CA decides):', preErr && preErr.message);
            }
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

    async startDNSChallenge(domain: string, email: string, useStaging = false) {
        try {
            // Initialize client if needed
            await this.initClient(email, useStaging);

            // Create order with DNS-01 challenge type
            const orderData = await this.createOrder(domain, 'dns-01');

            // getChallengeKeyAuthorization() ALREADY returned the RFC 8555 §8.4 TXT value for dns-01
            // (base64url(sha256(`token.thumbprint`))) — acme-client digests it internally. The old
            // getDNSDigest() hashed it a SECOND time, so the UI displayed a value no CA could ever
            // match and DNS-01 issuance was permanently broken.
            const txtValue = orderData.keyAuthorization;

            // Return data for UI
            return {
                domain,
                txtRecord: `_acme-challenge.${domain}`,
                txtValue,
                orderUrl: orderData.orderUrl,
                challenge: orderData.challenge,
                authzUrl: orderData.authzUrl,
                keyAuthorization: orderData.keyAuthorization,
                // BIND THE CHALLENGE TO THE CA THAT MINTED IT. An order, its authorization and its
                // challenge URLs only exist at ONE ACME endpoint. finishDNSChallenge re-inits against
                // this value rather than a `staging` flag sent separately by the caller, so the second
                // half of the flow cannot land on the other CA — not through a staging auto-renewal
                // mutating the shared singleton, and not through a restart in the middle of the flow.
                directoryUrl: this.directoryUrl
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
    async finishDNSChallenge(step1Data: any, email: string, useStaging = false) {
        try {
            // Re-init against THE CA THAT MINTED THIS CHALLENGE (step1Data.directoryUrl), not against
            // the caller's `staging` flag. The order/authz/challenge URLs in step1Data exist at exactly
            // one endpoint; talking to the other one gets "No such challenge" from boulder after the
            // operator has already published the TXT record — the failure this pairing removes.
            // `useStaging` remains the fallback for a step1Data minted before this field existed.
            await this.initClient(email, useStaging, step1Data && step1Data.directoryUrl);

            // Best-effort LOCAL pre-flight only — the CA performs the authoritative validation from
            // the outside after completeChallenge. Failing hard here strands setups whose local
            // resolver can't see what the CA can (split-horizon homelab DNS, negative-cached
            // lookups), so a pre-verify miss logs and continues instead of aborting the order.
            try {
                await this.client.verifyChallenge(
                    { url: step1Data.authzUrl, identifier: { type: 'dns', value: step1Data.domain } },
                    step1Data.challenge
                );
            } catch (preErr: any) {
                console.warn('[CertManager] Local dns-01 pre-verify inconclusive (continuing — the CA decides):', preErr && preErr.message);
            }

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

            // Update config to use new cert. AWAIT it: un-awaited, a failed gateway push still
            // reported success to the admin and the rejection went unhandled.
            await this.updateSSLConfig(
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
            // "No such challenge" means the CA does not recognise the challenge URL we posted to — the
            // order is gone (expired / already finalized) or it belongs to the OTHER ACME endpoint.
            // Raw, that message sends the operator to re-check a TXT record that is perfectly correct.
            // Tell them the only thing that actually resolves it: start the flow again and publish the
            // NEW value, because a fresh order always mints a fresh token.
            if (/no such challenge|urn:ietf:params:acme:error:malformed/i.test(String(e && e.message))) {
                throw new Error(
                    'DNS verification failed: this challenge is no longer valid at the certificate authority ' +
                    '(the order expired, or it was issued by a different Let\'s Encrypt endpoint). Your TXT ' +
                    'record is not the problem. Start the certificate request again and publish the NEW value ' +
                    'it shows you — each order mints a new one.'
                );
            }
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
    async installCertEmbedded(keyContent: any, certContent: any) {
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

    async pushCertToGateway(keyContent: any, certContent: any) {
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
                }, (res: any) => {
                    let data = '';
                    res.on('data', (chunk: any) => data += chunk);
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

                req.on('error', (e: any) => reject(e));
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
    async updateSSLConfig(keyPath: string, certPath: string) {
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
     * Resolve the TXT values at a name, following CNAME chains like ACME validators do (delegating
     * _acme-challenge to another zone via CNAME is a common DNS-provider pattern). TXT values longer
     * than 255 bytes arrive split into chunks — join them per record; flat() would compare chunks.
     */
    async resolveTxtValues(resolver: any, name: string, depth = 0): Promise<string[]> {
        if (depth < 5) {
            try {
                const cnames = await resolver.resolveCname(name);
                if (cnames && cnames.length) return this.resolveTxtValues(resolver, cnames[0], depth + 1);
            } catch { /* no CNAME at this name → resolve TXT directly */ }
        }
        const records = await resolver.resolveTxt(name);
        return records.map((chunks: string[]) => chunks.join(''));
    }

    /**
     * Verify DNS Propagation.
     * Queries PUBLIC resolvers, not the OS one: the machine's stub resolver negative-caches an
     * NXDOMAIN from a check clicked before the record existed (for the zone's negative TTL), and a
     * split-horizon homelab resolver may never see public records at all — both made this report
     * "record not found" forever while `dig @1.1.1.1` showed the record fine. The CA resolves from
     * the outside, so public resolvers are the closest local approximation. Falls back to the OS
     * resolver only if the public ones are unreachable (e.g. outbound :53 filtered).
     */
    async checkDNSPropagation(domain: string, expectedValue: string) {
        const name = `_acme-challenge.${domain}`;
        const expected = String(expectedValue || '').trim();
        if (!expected) return false;
        try {
            const { Resolver } = require('dns').promises;
            const pub = new Resolver({ timeout: 5000, tries: 2 });
            pub.setServers(['1.1.1.1', '8.8.8.8']);
            const values = await this.resolveTxtValues(pub, name);
            if (values.includes(expected)) return true;
        } catch { /* public resolvers unreachable → try the OS resolver below */ }
        try {
            const values = await this.resolveTxtValues(dns, name);
            return values.includes(expected);
        } catch {
            return false;
        }
    }

    /**
     * Prepare HTTP-01 Challenge File
     */
    async writeChallengeFile(token: string, keyAuthorization: any) {
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
    async installCustomCert(keyContent: any, certContent: any) {
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

            // Update Config. AWAIT it: un-awaited, a failed gateway push still returned success and
            // the rejection went unhandled.
            await this.updateSSLConfig(keyPath, certPath);

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
     * Monolith-mode config: read the port + TLS state served by monolith.js directly from the process
     * env and the on-disk cert it presents (mirrors monolith.js resolveSSL's lookup order), instead of
     * probing a gateway that doesn't exist in this deployment. Never throws — always returns a shape the
     * UI can render, tagged source:'monolith'.
     */
    getMonolithConfig(defaultResult: any): any {
        const httpOnly = process.env.WORDJS_HTTP === '1';
        const result: any = {
            ...defaultResult,
            gatewayPort: Number(process.env.PORT) || defaultResult.gatewayPort,
            sslEnabled: !httpOnly,
            source: 'monolith',
        };

        if (httpOnly) {
            result.certInfo = { message: 'Serving plain HTTP this session (WORDJS_HTTP=1) — no TLS certificate in use.' };
            return result;
        }

        try {
            const GATEWAY = path.resolve(__dirname, '../../../gateway');
            let certPath: string | null = null;

            // 1) An operator-configured cert referenced by gateway-config.json, then 2) the shared
            // auto self-signed cert monolith.js and the gateway both use.
            try {
                const gw = JSON.parse(fs.readFileSync(path.join(GATEWAY, 'gateway-config.json'), 'utf8'));
                if (gw && gw.ssl && gw.ssl.cert) {
                    const p = path.resolve(GATEWAY, gw.ssl.cert);
                    if (fs.existsSync(p)) certPath = p;
                }
            } catch { /* no gateway-config.json → fall through to the auto cert */ }
            if (!certPath) {
                const auto = path.join(GATEWAY, 'ssl-auto.crt');
                if (fs.existsSync(auto)) certPath = auto;
            }

            if (certPath) {
                const x509 = new (require('crypto').X509Certificate)(fs.readFileSync(certPath));
                const issuer = String(x509.issuer || '');
                const subject = String(x509.subject || '');
                const cn = (subject.match(/CN=([^\n,]+)/) || [])[1] || 'localhost';
                const issuerCn = (issuer.match(/CN=([^\n,]+)/) || [])[1] || issuer || cn;
                let type = 'custom';
                if (/let'?s encrypt/i.test(issuer)) type = 'letsencrypt';
                else if (issuer === subject) type = 'self-signed';
                result.certInfo = { commonName: cn, issuer: issuerCn, validTo: x509.validTo, type };
            } else {
                result.certInfo = { message: 'HTTPS is on but the served certificate could not be located on disk.' };
            }
        } catch {
            result.certInfo = { message: 'HTTPS is on (certificate details unavailable in monolith mode).' };
        }
        return result;
    }

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

        // Monolith mode: there is NO separate gateway process on :3100, so the mTLS probe below would
        // always fail with "Gateway Unreachable". In this deployment SSL + port are owned by monolith.js
        // (PORT / WORDJS_HTTP env + the shared cert), read once at boot — there is no live gateway config
        // API to talk to. Report the real local state and tag source:'monolith' so the UI renders it as
        // read-only info instead of a connection error.
        if (process.env.WORDJS_MODE === 'mono' || process.env.WORDJS_EMBEDDED === '1') {
            return this.getMonolithConfig(defaultResult);
        }

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
                }, (res: any) => {
                    let data = '';
                    res.on('data', (chunk: any) => data += chunk);
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

                req.on('error', (e: any) => {
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
    daysUntil(validTo: any): number {
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
    readLocalCertValidTo(domain: string): string | null {
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

        const record = async (data: any) => {
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
    async updateGatewayConfig(port: any, sslEnabled: any) {
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
                }, (res: any) => {
                    let data = '';
                    res.on('data', (chunk: any) => data += chunk);
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

                req.on('error', (e: any) => reject(e));
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
