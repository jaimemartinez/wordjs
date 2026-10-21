/**
 * WordJS — one TLS certificate per site of a network (multisite).
 *
 * The main site keeps its certificate exactly as before (Security → Automatic Certificate Renewal, `acme.domains`, the
 * gateway's or the monolith's default certificate). Every other site gets a certificate of its own for
 * its main address, which the edge selects by SNI (gateway/src/site-certs.js, in the gateway and in the
 * monolith): a site never has to share a certificate — or a SAN list — with the sites around it.
 *
 *   installSiteCertificate(id, cert, key)   a certificate the operator brings (validated: it must name the
 *                                           site's address, match its key and still be valid)
 *   issueSiteCertificate(id)                Let's Encrypt over HTTP-01, with the install's ACME account
 *   renewSiteCertificatesIfDue()            the renewal pass (core/cron, the main site's leader): every
 *                                           active site whose certificate is missing or inside the
 *                                           renewal window, when ACME is enabled with http-01
 *   syncSiteCertificatesToEdge()            hand every stored certificate to the edge (boot, registry change)
 *
 * MULTI-NODE. Certificates are kept in the network store (`network_site_certs`), which on Postgres and
 * MySQL is on the server every node shares: any node can renew one and push it, and a node that never
 * issued it can still hand it to a new gateway. The HTTP-01 answers are shared the same way
 * (`network_acme_challenges`): Let's Encrypt asks whichever node the edge sends it to, and every node
 * answers from the store (index.ts, `/.well-known/acme-challenge/`).
 */
const crypto = require('crypto');
const config = require('../config/app');
const siteContext = require('./site-context');
const log = require('./module-logger').moduleLogger('core/site-certs');

/** How long an HTTP-01 answer stays in the shared store (a CA validates within minutes). */
const CHALLENGE_TTL_MS = 60 * 60 * 1000;
/** After a failed issuance, how long the renewal pass leaves that address alone (the CA's rate limits). */
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,191}$/;

function network() { return require('./network'); }
function certManager() { return require('./cert-manager'); }

function codedError(code: string, message: string, status = 400): Error & { code: string; status: number } {
    const e = new Error(message) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    return e;
}

/** The secondary site `id` and its main host, or a coded error. */
function siteFor(id: number) {
    if (id === siteContext.PRIMARY_SITE_ID) throw codedError('network_primary_site', 'The main site keeps its certificate in Admin → Security.');
    const site = network().getSite(id);
    if (!site) throw codedError('network_site_not_found', 'No such site.', 404);
    if (!site.mainHost) throw codedError('network_invalid_url', 'The site has no address.');
    return site;
}

/**
 * Prove a certificate is usable for `host`: it parses, it names the host (SAN / CN, wildcards as TLS
 * matches them), it matches the private key, and it is valid now. Returns its expiry (ISO) and issuer.
 */
function validatePair(host: string, certPem: unknown, keyPem: unknown): { notAfter: string; issuer: string } {
    if (typeof certPem !== 'string' || typeof keyPem !== 'string' || !certPem.includes('BEGIN CERTIFICATE') || !keyPem.includes('PRIVATE KEY')) {
        throw codedError('network_invalid_certificate', 'A PEM certificate (with its chain) and its PEM private key are required.');
    }
    let x509: any;
    let key: any;
    try {
        x509 = new crypto.X509Certificate(certPem);
        key = crypto.createPrivateKey(keyPem);
    } catch (e: any) {
        throw codedError('network_invalid_certificate', `The certificate or the key cannot be read (${e && e.message}).`);
    }
    if (!x509.checkPrivateKey(key)) throw codedError('network_invalid_certificate', 'The private key does not belong to this certificate.');
    if (!x509.checkHost(host)) throw codedError('network_invalid_certificate', `The certificate does not name ${host}.`);
    const notAfter = new Date(x509.validTo);
    if (!(notAfter.getTime() > Date.now())) throw codedError('network_invalid_certificate', 'The certificate has expired.');
    if (new Date(x509.validFrom).getTime() > Date.now() + 5 * 60 * 1000) throw codedError('network_invalid_certificate', 'The certificate is not valid yet.');
    return { notAfter: notAfter.toISOString(), issuer: String(x509.issuer || '').split('\n').join(', ') };
}

/** The stored certificate of site `id` (its status — never its key), or null. */
async function siteCertificateStatus(id: number) {
    const site = siteFor(id);
    const row = await network().storeGet('SELECT host, cert_pem, not_after, updated_at FROM network_site_certs WHERE host = ?', [site.mainHost]);
    if (!row) return { host: site.mainHost, installed: false };
    let issuer = '';
    try { issuer = String(new crypto.X509Certificate(String(row.cert_pem)).issuer || '').split('\n').join(', '); } catch { /* unreadable: shown as unknown */ }
    const notAfter = String(row.not_after);
    return {
        host: site.mainHost,
        installed: true,
        notAfter,
        issuer,
        daysLeft: Math.floor((Date.parse(notAfter) - Date.now()) / 86400000),
        updatedAt: String(row.updated_at),
    };
}

/** Hand one site certificate to the edge (the gateway over its control plane, or the monolith in-process). */
async function pushToEdge(host: string, certPem: string, keyPem: string): Promise<void> {
    await certManager().pushSiteCertToEdge(host, keyPem, certPem);
}

/** Install (and store, and serve) a certificate for site `id`'s main address. */
async function installSiteCertificate(id: number, certPem: unknown, keyPem: unknown, opts: { actorUserId?: number | null; via?: string } = {}) {
    const site = siteFor(id);
    const { notAfter } = validatePair(site.mainHost, certPem, keyPem);
    await network().storeUpsert('network_site_certs', { host: site.mainHost }, {
        site_id: site.id, cert_pem: String(certPem), key_pem: String(keyPem), not_after: notAfter, updated_at: new Date().toISOString(),
    });
    let served = true;
    try { await pushToEdge(site.mainHost, String(certPem), String(keyPem)); }
    catch (e: any) {
        served = false;
        log.warn(`[site-certs] ${site.mainHost}: stored, but the edge could not be given it now (${e && e.message}); the next sync retries.`);
    }
    await network().audit('site.certificate', { actor: opts.actorUserId ?? null, siteId: site.id, detail: { host: site.mainHost, notAfter, via: opts.via || 'upload', served } });
    return { ...(await siteCertificateStatus(id)), served };
}

const issuing = new Set<string>();

/** Let's Encrypt (HTTP-01) for site `id`'s main address, with the install's ACME account and email. */
async function issueSiteCertificate(id: number, opts: { actorUserId?: number | null } = {}) {
    const site = siteFor(id);
    const acme = (config as any).acme || {};
    const email = String(acme.email || '').trim();
    if (!email) throw codedError('network_acme_unconfigured', 'Set the ACME email in Security → Automatic Certificate Renewal first (the account every site certificate is issued with).', 409);
    if (issuing.has(site.mainHost)) throw codedError('network_acme_busy', 'A certificate for this address is already being issued.', 409);
    issuing.add(site.mainHost);
    try {
        const { key, cert } = await certManager().obtainHttp01Certificate([site.mainHost], email, acme.staging === true);
        await network().storeRun('DELETE FROM network_meta WHERE meta_key = ?', [failureKey(site.mainHost)]);
        return await installSiteCertificate(id, cert, key, { actorUserId: opts.actorUserId, via: 'acme' });
    } catch (e: any) {
        await network().storeUpsert('network_meta', { meta_key: failureKey(site.mainHost) }, { meta_value: JSON.stringify({ at: Date.now(), error: String(e && e.message).slice(0, 500) }) });
        if (e && typeof e.code === 'string' && e.code.startsWith('network_')) throw e;
        throw codedError('network_acme_failed', `The certificate could not be issued: ${e && e.message}`, 502);
    } finally {
        issuing.delete(site.mainHost);
    }
}

function failureKey(host: string): string {
    return `acme_failure:${host}`.slice(0, 191);
}

/** Should the renewal pass issue for every site? ACME on, http-01, with an email. */
function autoIssueEnabled(): boolean {
    const acme = (config as any).acme || {};
    return acme.enabled === true && (acme.challengeType || 'http-01') === 'http-01' && !!String(acme.email || '').trim();
}

/**
 * The renewal pass for the sites of the network: issue for every active site with no certificate, or one
 * inside `acme.renewBeforeDays` (30) of its expiry. An address whose last attempt failed is left alone for
 * FAILURE_COOLDOWN_MS. Runs on the main site's cron leader (one node). Returns what it did.
 */
async function renewSiteCertificatesIfDue(): Promise<{ issued: string[]; failed: string[]; skipped: string[] }> {
    const out = { issued: [] as string[], failed: [] as string[], skipped: [] as string[] };
    if (!siteContext.multisiteEnabled() || !autoIssueEnabled()) return out;
    const before = Number(((config as any).acme || {}).renewBeforeDays) || 30;
    for (const site of network().listSites()) {
        if (site.id === siteContext.PRIMARY_SITE_ID || site.status !== 'active' || !site.mainHost) continue;
        // A local network's <name>.localhost sites have no public DNS: no CA can validate them.
        if (site.mainHost.endsWith('.localhost')) { out.skipped.push(site.mainHost); continue; }
        try {
            const status: any = await siteCertificateStatus(site.id);
            if (status.installed && status.daysLeft > before) { out.skipped.push(site.mainHost); continue; }
            const failure = await network().storeGet('SELECT meta_value FROM network_meta WHERE meta_key = ?', [failureKey(site.mainHost)]);
            let at = 0;
            try { at = Number(JSON.parse(String(failure && failure.meta_value)).at) || 0; } catch { at = 0; }
            if (at && Date.now() - at < FAILURE_COOLDOWN_MS) { out.skipped.push(site.mainHost); continue; }
            await issueSiteCertificate(site.id);
            out.issued.push(site.mainHost);
        } catch (e: any) {
            out.failed.push(site.mainHost);
            log.warn(`[site-certs] ${site.mainHost}: ${e && e.message}`);
        }
    }
    return out;
}

/** Give the edge every stored site certificate (a gateway that restarted elsewhere, a new node's boot). */
async function syncSiteCertificatesToEdge(): Promise<number> {
    if (!siteContext.multisiteEnabled()) return 0;
    let n = 0;
    const rows = await network().storeAll('SELECT host, site_id, cert_pem, key_pem FROM network_site_certs');
    for (const row of rows) {
        const site = network().getSite(Number(row.site_id));
        if (!site || site.mainHost !== String(row.host)) continue; // a stale row: the site's address changed
        try { await pushToEdge(String(row.host), String(row.cert_pem), String(row.key_pem)); n++; }
        catch (e: any) { log.warn(`[site-certs] ${String(row.host)}: the edge could not be given its certificate (${e && e.message})`); }
    }
    return n;
}

/** A site is being deleted: take its certificate off the edge (its rows go with the site's record). */
async function forgetSiteCertificates(id: number, host: string): Promise<void> {
    await network().storeRun('DELETE FROM network_site_certs WHERE site_id = ?', [id]);
    if (!host) return;
    try { await certManager().removeSiteCertFromEdge(host); }
    catch (e: any) { log.warn(`[site-certs] ${host}: the edge still holds the deleted site's certificate (${e && e.message})`); }
}

/**
 * Record an HTTP-01 answer where every node can serve it (core/cert-manager writeChallengeFile calls it
 * next to its local file). A no-op on a single site, where the local file is the only answer needed.
 */
async function rememberChallenge(token: string, keyAuthorization: unknown): Promise<void> {
    if (!siteContext.multisiteEnabled() || !TOKEN_RE.test(String(token))) return;
    const now = Date.now();
    await network().storeRun('DELETE FROM network_acme_challenges WHERE expires_at < ?', [now]);
    await network().storeUpsert('network_acme_challenges', { token: String(token) }, { key_authorization: String(keyAuthorization), expires_at: now + CHALLENGE_TTL_MS });
}

/** The shared HTTP-01 answer for `token`, or null. */
async function challengeAnswer(token: string): Promise<string | null> {
    if (!siteContext.multisiteEnabled() || !TOKEN_RE.test(String(token))) return null;
    const row = await network().storeGet('SELECT key_authorization FROM network_acme_challenges WHERE token = ? AND expires_at >= ?', [String(token), Date.now()]);
    return row ? String(row.key_authorization) : null;
}

module.exports = {
    validatePair,
    siteCertificateStatus,
    installSiteCertificate,
    issueSiteCertificate,
    renewSiteCertificatesIfDue,
    syncSiteCertificatesToEdge,
    forgetSiteCertificates,
    rememberChallenge,
    challengeAnswer,
    autoIssueEnabled,
};
