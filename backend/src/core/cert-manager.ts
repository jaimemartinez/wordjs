const acme = require('acme-client');
// Bound every outbound ACME HTTP attempt (directory/order/finalize AND the http-01 local pre-verify
// fetch). Without this, an unreachable port 80 left each verify attempt hanging on the OS TCP
// timeout and the admin request froze for minutes.
acme.axios.defaults.timeout = 10000;
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
// The one place a name becomes a path. A certificate's storage directory is CHOSEN by a hostname
// that arrives in an admin HTTP body (POST /certs/auto-provision, and — round-tripped through the
// browser — POST /certs/dns-finish), so it gets the full treatment: allowlist the FORM, resolve
// canonically, prove containment on the value that is RETURNED.
const { resolveCertDir, resolveWithin } = require('./safe-path');

const DATA_DIR = path.resolve(__dirname, '../../data/ssl'); // Store ACME account keys here
const LIVE_DIR = path.resolve(__dirname, '../../ssl/live'); // Store real certs here
const WWW_ROOT = path.resolve(__dirname, '../../public'); // For HTTP-01

// 0o700: these directories hold private keys (account.key, privkey.pem) — they must not be
// world/group-traversable.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });

/**
 * A value as it may enter one log line: line breaks removed, so a request- or peer-derived string (a
 * path, a Host, a gateway or driver error message) cannot forge or split entries in the operator's log.
 * Two single-constant replacements on purpose — the log-injection analysis recognises the sanitizer
 * syntactically and does not match the equivalent alternation (see core/plugins.ts logSafe). Interpolate
 * the result into ONE string and pass no further console argument.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * `<domainDir>/<name>` for the two files a provisioned certificate is stored as. The name is a
 * literal from this module, so a null here means the containment proof itself failed — which is a
 * bug, not a user error, and must stop the write rather than fall back to a join.
 */
function certFile(domainDir: string, name: string): string {
    const p = resolveWithin(domainDir, name);
    if (p === null) throw new Error(`Refusing to write ${name}: it does not resolve inside the certificate directory.`);
    return p;
}

// Write a PRIVATE KEY (account key / privkey.pem) with restrictive permissions. writeFileSync's
// `mode` is ignored when the file already exists, so we ALSO chmod after the write to guarantee 0o600
// on every platform/path.
function writePrivateKey(filePath: string, content: any) {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* chmod is a no-op on some filesystems (e.g. Windows) */ }
}

/**
 * THE GATEWAY'S CONTROL PLANE — every call this module makes to the gateway (certificate upload, the
 * TLS/port switch, the main address, the host policy, the info probe) goes through ONE dialler.
 *
 * WHERE: on a cluster-ENROLLED node (scripts/node-join.js: `advertiseHost` is set, the same discriminator
 * frontend-purge's purgeTransport and the installer's isEnrolledConfig use), the configured `gatewayHost`
 * on `gatewayInternalPort` — the gateway is another machine, and its identity is verified by its own name,
 * which is what the cluster CA issued it for (scripts/cluster.js). Everywhere else the loopback address on
 * `gatewayInternalPort`, verified as `localhost`, exactly as before. These calls used to be pinned to
 * `https://127.0.0.1:3100`, so a separate-mode backend could never push a certificate or an address to
 * its gateway, and a gateway moved to another internal port silently stopped hearing about TLS changes.
 *
 * WHY NOT gatewayHost ALONE: single-host installs made before the enrolment model also carry a
 * gatewayHost — the installer wrote `gateway.<domain>` (or the raw IP of an IP install) there, a name that
 * usually does not resolve, and an address the gateway's internal listener (bound to 127.0.0.1 by
 * default) does not answer on. Dialling it broke the SSL switch, the certificate push after every ACME
 * renewal and the R1 upgrade on every such install. Their service certificates carry localhost and
 * 127.0.0.1, so the loopback dial still verifies.
 *
 * WITH WHAT: the cluster CA and this node's CN=backend identity, resolved by the ONE resolver for those
 * paths (frontend-purge clusterCertPaths: anchored to the installation, absolute paths untouched).
 * Verification is never relaxed: these requests carry private keys and the site's identity.
 *
 * WHO ANSWERS: the gateway, by its certificate's CN (gateway-internal, or gateway), on top of the name
 * check. The cluster CA issues every service a certificate naming localhost and 127.0.0.1, so the name
 * alone let any of them stand in for the gateway on its port — a process holding frontend.key would have
 * been handed certificate keys, and its answer to a policy push would decide which IPs `own` answers
 * (review R3S-4). The gateway pins its own upstreams the same way (gateway/src/proxy-config.js).
 */
/** The error code of a node that has no cluster identity yet (never enrolled / installed standalone). */
const NO_CLUSTER_IDENTITY = 'WJS_NO_CLUSTER_IDENTITY';

/** The CNs the gateway's control plane presents (host-policy GATEWAY_CNS: the same identities). */
const GATEWAY_CONTROL_CNS = ['gateway-internal', 'gateway'];

/** The default name check, then the gateway's identity. */
function checkGatewayIdentity(host: string, peer: any): Error | undefined {
    const err = require('tls').checkServerIdentity(host, peer);
    if (err) return err;
    const cn = peer && peer.subject && peer.subject.CN;
    if (GATEWAY_CONTROL_CNS.includes(cn)) return undefined;
    return new Error(`The gateway's control plane answered with the certificate of '${cn}', not the gateway's.`);
}

function gatewayControlTarget(cfg: any): { hostname: string; port: number; servername?: string } {
    const configured = typeof cfg.gatewayHost === 'string' ? cfg.gatewayHost.trim().replace(/^\[(.*)\]$/, '$1') : '';
    const port = Number(cfg.gatewayInternalPort) || 3100;
    if (!configured || configured.toLowerCase() === 'localhost' || !cfg.advertiseHost) {
        return { hostname: '127.0.0.1', port, servername: 'localhost' };
    }
    return { hostname: configured, port };
}

function gatewayControlRequest(method: 'GET' | 'POST', urlPath: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
    const cfg = require('./configManager').getConfig() || {};
    const { clusterCertPaths } = require('./frontend-purge');
    const paths = clusterCertPaths(cfg);
    if (!cfg.mtls || !fs.existsSync(paths.key)) {
        return Promise.reject(Object.assign(new Error('Backend mTLS Key not found'), { code: NO_CLUSTER_IDENTITY }));
    }
    const https = require('https');
    const target = gatewayControlTarget(cfg);
    const payload = body === null ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            method,
            hostname: target.hostname,
            port: target.port,
            path: urlPath,
            ...(target.servername ? { servername: target.servername } : {}),
            // One context built from this node's identity: the credentials authenticate the TLS handshake and
            // are never part of what the request sends.
            secureContext: require('tls').createSecureContext({
                key: fs.readFileSync(paths.key),
                cert: fs.readFileSync(paths.cert),
                ca: fs.existsSync(paths.ca) ? fs.readFileSync(paths.ca) : undefined,
            }),
            rejectUnauthorized: true,
            checkServerIdentity: checkGatewayIdentity,
            // A pooled agent keyed on these options would outlive a certificate rotation: one-shot sockets.
            agent: false,
            timeout: timeoutMs,
            headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res: any) => {
            let text = '';
            res.on('data', (chunk: any) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('timeout', () => req.destroy(new Error('Gateway control plane timed out')));
        req.on('error', (e: any) => reject(e));
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** The gateway's own error text for a non-200 answer, else a generic one. */
function gatewayError(status: number, text: string): Error {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.error === 'string') return new Error(parsed.error);
    } catch { /* not JSON */ }
    return new Error(`Gateway returned ${status}`);
}

/**
 * The names ONE certificate order covers (multi-identifier ACME: the main address and its www/apex twin
 * can share one certificate). Each name must be storable as a certificate directory name — the same gate
 * the single-name flow always had, applied BEFORE any CA work — and the first one names the directory.
 * Duplicates collapse, order is kept, and Let's Encrypt's cap of 100 names per order is enforced here.
 */
function certificateNames(input: unknown): string[] {
    const list = (Array.isArray(input) ? input : [input]).map((d) => String(d === undefined || d === null ? '' : d).trim().toLowerCase());
    const names = [...new Set(list.filter((d) => d !== ''))];
    if (names.length === 0) throw new Error('Invalid domain "" — expected a DNS name such as "example.com".');
    if (names.length > 100) throw new Error('A certificate can cover at most 100 names.');
    for (const name of names) {
        if (resolveCertDir(LIVE_DIR, name) === null) throw new Error(`Invalid domain ${JSON.stringify(name)} — expected a DNS name such as "example.com".`);
    }
    return names;
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
    /**
     * Finalize an order we hold only the URL of, and return the finalized order.
     *
     * WHY THIS EXISTS: acme-client's finalizeOrder(order, csr) requires `order.finalize` — the URL the
     * CA hands back when the order is created. Both call sites used to pass a hand-made `{ url }` stub,
     * which has no `finalize`, so the library threw "Unable to finalize order, URL not found" and NO
     * certificate could ever be issued — by HTTP-01 or DNS-01. Re-READING the order from its URL is
     * also the correct move independently of that bug: it returns the order's CURRENT state, which
     * matters for the two-step DNS flow where minutes or hours pass between start and finish.
     */
    async finalizeOrderByUrl(orderUrl: string, csr: any) {
        if (!orderUrl) throw new Error('Cannot finalize the certificate order: its URL is missing. Start the request again.');
        const order = await this.client.getOrder({ url: orderUrl });
        return this.client.finalizeOrder(order, csr);
    }

    /**
     * Open ONE order for every name and return, per authorization, what proving it takes. An
     * authorization the CA already validated (Let's Encrypt reuses them for ~30 days) comes back WITHOUT
     * a challenge menu and needs nothing but finalization — demanding a challenge there used to leave an
     * already-proven name permanently unable to obtain a certificate, by EITHER method; that is exactly
     * the state a successful validation followed by a failed finalize leaves behind.
     */
    async createOrderFor(domains: string[], type = 'http-01') {
        if (!this.client) throw new Error('Client not initialized. Call initClient first.');

        const order = await this.client.createOrder({ identifiers: domains.map((value) => ({ type: 'dns', value })) });
        const authorizations = await this.client.getAuthorizations(order);
        const out = [];
        for (let i = 0; i < authorizations.length; i++) {
            const authz = authorizations[i];
            const domain = (authz.identifier && authz.identifier.value) || domains[i] || domains[0];
            if (authz.status === 'valid') {
                out.push({ domain, authzUrl: authz.url, alreadyValid: true, challenge: null, keyAuthorization: null, dnsRecord: `_acme-challenge.${domain}` });
                continue;
            }
            const challenge = authz.challenges.find((c: any) => c.type === type);
            if (!challenge) throw new Error(`Challenge type ${type} not found for this domain (${domain}).`);
            // getChallengeKeyAuthorization() is challenge-type-aware — for http-01 it returns the file
            // content (`token.thumbprint`), for dns-01 the FINAL TXT value, ALREADY digested per RFC 8555
            // §8.4 (base64url(sha256(`token.thumbprint`))). Never hash it again.
            const keyAuthorization = await this.client.getChallengeKeyAuthorization(challenge);
            out.push({ domain, authzUrl: authz.url, alreadyValid: false, challenge, keyAuthorization, dnsRecord: `_acme-challenge.${domain}` });
        }
        return { orderUrl: order.url, authorizations: out };
    }

    /** One name, in the shape the two-step DNS-01 flow hands to the browser and back. */
    async createOrder(domain: string, type = 'http-01') {
        const { orderUrl, authorizations } = await this.createOrderFor([domain], type);
        const authz = authorizations[0];
        return {
            orderUrl,
            authzUrl: authz.authzUrl,
            ...(authz.alreadyValid ? { alreadyValid: true } : {}),
            challenge: authz.challenge,
            keyAuthorization: authz.keyAuthorization,
            dnsRecord: authz.dnsRecord,
        };
    }

    /**
     * Auto-provision over HTTP-01: one order, one certificate, for one name or several (the first names
     * the storage directory and the certificate's CN; every name is a subjectAltName). Each name's
     * challenge is served and completed, then all of them are awaited, then the order is finalized.
     */
    async provisionAutoHTTP(domainOrDomains: string | string[], email: string, useStaging = false) {
        try {
            // The names are resolved to a storage directory BEFORE any network work: a name that cannot
            // be stored must not cost the CA an order, and refusing here means the value used at step 5
            // is the one that was proved contained (not a re-join of the raw argument).
            const domains = certificateNames(domainOrDomains);
            const domain = domains[0];
            const domainDir = resolveCertDir(LIVE_DIR, domain) as string;
            console.log(`[CertManager] Starting HTTP-01 provisioning for ${domains.join(', ')}...`);
            await this.initClient(email, useStaging);

            // 1. Create the order
            const orderData = await this.createOrderFor(domains, 'http-01');

            // The CA may already hold a VALID authorization for a name (it reuses them for about a
            // month). Then there is no challenge to serve and port 80 is not needed for it — only the
            // pending ones are proved, and an order whose names are all valid goes straight to step 4.
            const pending = orderData.authorizations.filter((a: any) => !a.alreadyValid);
            if (pending.length === 0) console.log('[CertManager] Every authorization is already valid at the CA — finalizing.');
            for (const authz of pending) {
                console.log(`[CertManager] Challenge for ${authz.domain}: token ${authz.challenge.token}`);

                // 2. Write the challenge file
                await this.writeChallengeFile(authz.challenge.token, authz.keyAuthorization);

                // 3. Best-effort LOCAL pre-flight: it fetches http://<name>/.well-known/... from THIS
                // machine. Behind NAT without hairpin the server often cannot reach its own public
                // hostname even though the CA can, so a miss here must not abort the order —
                // completeChallenge + waitForValidStatus below get the CA's authoritative verdict.
                try {
                    await this.client.verifyChallenge(
                        { url: authz.authzUrl, identifier: { type: 'dns', value: authz.domain } },
                        authz.challenge
                    );
                } catch (preErr: any) {
                    console.warn(`[CertManager] Local http-01 pre-verify for ${authz.domain} inconclusive (continuing — the CA decides):`, preErr && preErr.message);
                }
                await this.client.completeChallenge(authz.challenge);
            }
            for (const authz of pending) {
                await this.client.waitForValidStatus(authz.challenge);
                console.log(`[CertManager] Challenge for ${authz.domain} validated.`);
            }

            // 4. Finalize — every name in the CSR, or the CA refuses an order whose identifiers differ.
            const [key, csr] = await acme.forge.createCsr({
                commonName: domain,
                ...(domains.length > 1 ? { altNames: domains } : {}),
            });

            const finalized = await this.finalizeOrderByUrl(orderData.orderUrl, csr);

            const cert = await this.client.getCertificate(finalized);
            console.log('[CertManager] Certificate downloaded.');

            // 5. Save locally (backup/reference) — into the directory resolved and proved contained
            // at the top of this method.
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true, mode: 0o700 });

            writePrivateKey(certFile(domainDir, 'privkey.pem'), key);
            fs.writeFileSync(certFile(domainDir, 'fullchain.pem'), cert);

            // 6. Push to Gateway
            // Ensure key is string
            await this.pushCertToGateway(key.toString(), cert.toString());
            console.log('[CertManager] Certificate pushed to Gateway.');

            return { success: true, message: 'Certificate provisioned and installed.', domains };

        } catch (e) {
            console.error('[CertManager] Auto HTTP Provision Error:', e);
            throw new Error(`Provisioning failed: ${e.message}`, { cause: e });
        }
    }

    async startDNSChallenge(domain: string, email: string, useStaging = false) {
        try {
            // Gate the NAME here, at step 1, even though step 2 is what writes to disk: the domain
            // this returns is what the browser posts back to /dns-finish, and a flow that can only
            // start with a storable name is one fewer way for an unstorable one to reach the writer.
            if (resolveCertDir(LIVE_DIR, domain) === null) {
                throw new Error(`Invalid domain ${JSON.stringify(String(domain))} — expected a DNS name such as "example.com" or "*.example.com".`);
            }
            // Initialize client if needed
            await this.initClient(email, useStaging);

            // Create order with DNS-01 challenge type
            const orderData = await this.createOrder(domain, 'dns-01');

            // Nothing left to prove — the CA still holds a valid authorization for this domain. There
            // is no TXT record to publish; the caller can finish immediately.
            if (orderData.alreadyValid) {
                return {
                    domain,
                    alreadyValid: true,
                    txtRecord: `_acme-challenge.${domain}`,
                    txtValue: null,
                    orderUrl: orderData.orderUrl,
                    challenge: null,
                    authzUrl: orderData.authzUrl,
                    keyAuthorization: null,
                    directoryUrl: this.directoryUrl
                };
            }

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
            throw new Error(`DNS challenge start failed: ${e.message}`, { cause: e });
        }
    }

    /**
     * Finish DNS-01 Challenge Flow
     * Call after user has added the TXT record
     */
    async finishDNSChallenge(step1Data: any, email: string, useStaging = false) {
        try {
            // step1Data IS THE REQUEST BODY. POST /api/v1/certs/dns-finish takes it verbatim from the
            // browser — it is not server state that happens to round-trip, it is input, and
            // `step1Data.domain` used to choose a DIRECTORY under ssl/live/ that is then mkdir'd
            // recursively and written with the account's PRIVATE KEY. Resolve it first, fail closed.
            const domainDir = resolveCertDir(LIVE_DIR, step1Data && step1Data.domain);
            if (domainDir === null) {
                throw new Error(`Invalid domain ${JSON.stringify(String(step1Data && step1Data.domain))} — expected a DNS name such as "example.com" or "*.example.com".`);
            }
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
            // Skipped entirely when the authorization is already valid — there is no challenge to check.
            try {
                if (!step1Data.challenge) throw new Error('authorization already valid — nothing to pre-verify');
                await this.client.verifyChallenge(
                    { url: step1Data.authzUrl, identifier: { type: 'dns', value: step1Data.domain } },
                    step1Data.challenge
                );
            } catch (preErr: any) {
                console.warn('[CertManager] Local dns-01 pre-verify inconclusive (continuing — the CA decides):', preErr && preErr.message);
            }

            // Complete and wait — unless the CA already holds a valid authorization, in which case
            // there is no challenge object and nothing to complete; go straight to finalization.
            if (step1Data.challenge) {
                await this.client.completeChallenge(step1Data.challenge);
                await this.client.waitForValidStatus(step1Data.challenge);
            }

            // Create CSR and finalize
            const [key, csr] = await acme.forge.createCsr({
                commonName: step1Data.domain,
            });

            // Finalize the order
            const finalized = await this.finalizeOrderByUrl(step1Data.orderUrl, csr);

            // Get certificate
            const cert = await this.client.getCertificate(finalized);

            // Save to files — `domainDir` is the value resolved and proved contained at the top of
            // this method, never a fresh join of step1Data.domain.
            if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true, mode: 0o700 });

            const keyPath = certFile(domainDir, 'privkey.pem');
            const chainPath = certFile(domainDir, 'fullchain.pem');
            writePrivateKey(keyPath, key);
            fs.writeFileSync(chainPath, cert);

            // Update config to use new cert. AWAIT it: un-awaited, a failed gateway push still
            // reported success to the admin and the rejection went unhandled.
            await this.updateSSLConfig(keyPath, chainPath);

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
                    'it shows you — each order mints a new one.',
                    { cause: e },
                );
            }
            throw new Error(`DNS verification failed: ${e.message}`, { cause: e });
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
            // SECURITY: the gateway's server certificate is verified against the cluster CA before the
            // freshly-issued PRIVATE KEY is sent, so a co-resident process that port-steals the control
            // port cannot receive it (see gatewayControlRequest).
            const { status, text } = await gatewayControlRequest('POST', '/cert-upload', { key: keyContent, cert: certContent }, 15000);
            if (status !== 200) throw gatewayError(status, text);
            return JSON.parse(text);
        } catch (e) {
            console.error(`[CertManager] Push Error: ${logSafe(e && e.message ? e.message : e)}`);
            throw e;
        }
    }

    /**
     * Tell the gateway the site's main address (core/site-address commit): it rebuilds its own links and
     * pages from it. Same control plane, same identity and verification as the certificate push.
     */
    async pushSiteUrlToGateway(siteUrl: string) {
        const { status, text } = await gatewayControlRequest('POST', '/config-update', { siteUrl }, 5000);
        if (status !== 200) throw gatewayError(status, text);
        return JSON.parse(text);
    }

    /**
     * Tell the gateway which addresses the site answers (core/site-address builds the body): the inputs of
     * host-policy buildPolicy — `{ enforce, config: { siteUrl, siteAliases, hostPolicy, trustProxy }, env,
     * nodeEnv }`, the shape the gateway's sanitizePolicyPush accepts. The gateway stores it and its workers
     * enforce it at the edge (pages, static trees, uploads, WebSockets, redirect aliases, R4) without a
     * restart. Same control plane, identity and verification as every other call here.
     */
    async pushHostPolicyToGateway(body: { enforce: boolean; config: Record<string, unknown>; env: Record<string, string>; nodeEnv: string | null }) {
        const { status, text } = await gatewayControlRequest('POST', '/host-policy', body, 5000);
        if (status !== 200) throw gatewayError(status, text);
        return JSON.parse(text);
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
        // The token NAMES A FILE under the public web root, and it is REMOTE DATA: it comes from the
        // ACME directory, and which directory that is can be steered (the `staging` flag, and
        // `step1Data.directoryUrl` straight out of a request body). A server answering with a token
        // of `../../evil` would have this write the key authorization wherever it liked. RFC 8555
        // tokens are base64url, so requiring a single plain segment refuses nothing a real CA sends.
        const challengeDir = resolveWithin(WWW_ROOT, '.well-known', 'acme-challenge');
        const target = challengeDir && resolveWithin(challengeDir, token);
        if (!target) {
            throw new Error(`The certificate authority returned an unusable challenge token ${JSON.stringify(String(token))} — refusing to write it.`);
        }
        if (!fs.existsSync(challengeDir)) fs.mkdirSync(challengeDir, { recursive: true });
        fs.writeFileSync(target, keyAuthorization);
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
            throw new Error(`Failed to install custom cert: ${e.message}`, { cause: e });
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
            const { status, text } = await gatewayControlRequest('GET', '/info', null, 2000);
            if (status !== 200) return { ...defaultResult, error: `Gateway returned ${status}` };
            try {
                return JSON.parse(text);
            } catch {
                return { ...defaultResult, error: 'Invalid JSON from Gateway' };
            }
        } catch (e) {
            if (e && e.code === NO_CLUSTER_IDENTITY) {
                console.error(`[CertManager] getConfig Error: ${logSafe(e.message)}`);
                return { ...defaultResult, error: e.message };
            }
            console.error(`[CertManager] Gateway connection failed: ${logSafe(e && e.message ? e.message : e)}`);
            return { ...defaultResult, error: 'Gateway Unreachable' };
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
        const local = this.readLocalCert(domain);
        return local ? local.validTo : null;
    }

    /**
     * The certificate we last obtained for `domain` (its directory names it), read from disk: its expiry
     * and every DNS name it covers (subjectAltName; the CN when a certificate carries no SAN at all).
     * Null when no parseable certificate exists.
     */
    readLocalCert(domain: string): { validTo: string; names: string[] } | null {
        try {
            // Same facade as the writer. The domain here comes from config (acme.domains / the siteUrl
            // host), but "the value happens to be trusted today" is not a property the READ should
            // depend on — and a reader that accepts names the writer rejects would answer about a file
            // the writer could never have produced.
            const dir = resolveCertDir(LIVE_DIR, domain);
            if (dir === null) return null;
            const p = resolveWithin(dir, 'fullchain.pem');
            if (p && fs.existsSync(p)) {
                const x509 = new (require('crypto').X509Certificate)(fs.readFileSync(p));
                const names = String(x509.subjectAltName || '').split(',').map((part: string) => part.trim())
                    .filter((part: string) => part.startsWith('DNS:')).map((part: string) => part.slice(4).toLowerCase());
                if (names.length === 0) {
                    const cn = /CN=([^\n,]+)/.exec(String(x509.subject || ''));
                    if (cn) names.push(cn[1].trim().toLowerCase());
                }
                return { validTo: x509.validTo, names };
            }
        } catch { /* unparseable → treat as absent */ }
        return null;
    }

    private isRenewing = false;

    /**
     * Auto-renewal entry point — invoked by the cron job (wordjs_cert_renewal) and the manual
     * "renew now" route. Reads config.acme, skips unless the live cert is within renewBeforeDays of
     * expiry (so we never hammer Let's Encrypt and hit its rate limits), then re-runs the existing
     * HTTP-01 provisioning, which already pushes the new cert to the gateway and hot-reloads it.
     * The outcome is recorded in the 'acme_last_renewal' option for the renewal-status endpoint.
     */
    async renewIfDue({ force = false } = {}): Promise<any> {
        if (this.isRenewing) {
            return { skipped: true, reason: 'already_in_progress' };
        }
        this.isRenewing = true;
        try {
            return await this._doRenewIfDue({ force });
        } finally {
            this.isRenewing = false;
        }
    }

    private async _doRenewIfDue({ force = false } = {}): Promise<any> {
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

        // The names to maintain: EVERY configured domain, in one certificate (the first names it), else
        // the siteUrl host. Renewing only acme.domains[0] left every other configured name uncovered.
        let candidates: string[] = Array.isArray(acme.domains) ? acme.domains.filter((d: any) => typeof d === 'string' && d.trim() !== '') : [];
        if (candidates.length === 0 && config.siteUrl) {
            try { candidates = [new URL(config.siteUrl).hostname]; } catch { /* ignore */ }
        }
        if (candidates.length === 0) return record({ ok: false, error: 'No domain configured for ACME (set acme.domains or siteUrl).' });
        let domains: string[];
        try { domains = certificateNames(candidates); } catch (e: any) { return record({ ok: false, error: e.message }); }
        const domain = domains[0];
        if (!acme.email) return record({ ok: false, error: 'No ACME account email configured.' });

        const threshold = Number(acme.renewBeforeDays) > 0 ? Number(acme.renewBeforeDays) : 30;

        // Decide whether renewal is due from the cert's REMAINING VALIDITY — independent of the
        // gateway's issuer-type classification (which only inspects the issuer CN and so never tags a
        // real Let's Encrypt cert, whose "Let's Encrypt" string lives in the issuer O=). Prefer the
        // locally-saved cert on disk; fall back to what the gateway reports. A non-finite result means
        // there is no parseable cert yet → first issuance, which legitimately proceeds.
        const local = this.readLocalCert(domain);
        let validTo = local ? local.validTo : null;
        // A certificate that does not cover every configured name is due NOW, whatever its expiry: a
        // name the administrator just added (the www twin) would otherwise wait months for the renewal.
        const uncovered = local ? domains.filter((d) => !local.names.includes(d)) : [];
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

        if (!force && Number.isFinite(days) && days > threshold && uncovered.length === 0) {
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
            console.log(`[CertManager] Auto-renewal: provisioning ${domains.join(', ')} (staging=${!!acme.staging}, force=${force}, daysRemaining=${Number.isFinite(days) ? Math.round(days) : 'n/a'}${uncovered.length ? `, not yet covered: ${uncovered.join(', ')}` : ''})`);
            await this.provisionAutoHTTP(domains, acme.email, !!acme.staging);
            return record({ ok: true, domain, domains, validTo: this.readLocalCertValidTo(domain) });
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
            const { status, text } = await gatewayControlRequest('POST', '/config-update', {
                port: port ? parseInt(port) : undefined,
                sslEnabled: typeof sslEnabled !== 'undefined' ? !!sslEnabled : undefined
                // The gateway recomputes its own siteUrl from these; the backend compares the answer
                // with the main address (core/site-address noteGatewaySiteUrl, REDTEAM R1).
            }, 5000);
            if (status !== 200) throw new Error(`Gateway returned ${status}`);
            console.log('[CertManager] Gateway configuration pushed successfully.');
            return JSON.parse(text);
        } catch (e) {
            console.error(`[CertManager] Config Push Error: ${logSafe(e && e.message ? e.message : e)}`);
            throw e;
        }
    }
}

module.exports = new CertManager();
