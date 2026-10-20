'use strict';
/**
 * WordJS gateway — one TLS certificate per site of a network, selected by SNI (multisite).
 *
 * The backend (core/site-certs) hands the edge each site's certificate for its main address; it is kept
 * under `<gateway>/ssl/live/sites/<host>/{privkey,fullchain}.pem` (owner-only), written by the primary
 * (POST /site-cert on the control plane) or, in the monolith, by the backend in the same process. Every
 * HTTPS listener — the gateway's workers and the monolith — selects a certificate by the name the client
 * asked for (`SNICallback`): a site's own when the directory has one, the default certificate (the main
 * site's) otherwise. Workers notice a new, renewed or removed certificate within REFRESH_MS without a
 * restart; nothing about the main site's certificate changes.
 *
 * A host is a lower-case DNS name (no wildcard, no IP literal, no port): exactly the names a site of the
 * network can have. Anything else is refused before it can name a directory.
 */
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');

const REFRESH_MS = 5000;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** `<gateway>/ssl/live/sites` (this file is gateway/src/site-certs.js). */
function defaultSitesDir() {
    return path.resolve(__dirname, '../ssl/live/sites');
}

/** The host as a directory name, or null when it is not a plain DNS name. */
function cleanHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
    return HOST_RE.test(h) ? h : null;
}

/**
 * Prove a key + certificate pair is one, and that it names `host`, before anything is written: a bad
 * pair would otherwise surface as a handshake failure for that site's visitors.
 */
function validatePair(host, key, cert) {
    if (typeof key !== 'string' || typeof cert !== 'string') throw new Error('key and cert (PEM) are required');
    const x509 = new crypto.X509Certificate(cert);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error('the key does not belong to the certificate');
    if (!x509.checkHost(host)) throw new Error(`the certificate does not name ${host}`);
    tls.createSecureContext({ key, cert }); // what the listener will build: it must accept it
}

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * What is written is never the request's text: the key re-exported from the parsed key object (PKCS#8),
 * and the chain re-encoded certificate by certificate from parsed X.509 objects. Anything around or
 * between the PEM blocks (comments, other data) does not reach the disk.
 */
function canonicalPair(key, cert) {
    const keyPem = crypto.createPrivateKey(key).export({ type: 'pkcs8', format: 'pem' }).toString();
    const blocks = String(cert).match(PEM_CERT_RE) || [];
    if (!blocks.length) throw new Error('no certificate in the PEM');
    const chainPem = blocks.map((b) => new crypto.X509Certificate(b).toString().trim()).join('\n') + '\n';
    return { keyPem, chainPem };
}

/** Write (or replace) the certificate of `host`. Returns 'written' or 'unchanged'. */
function writeSiteCert(dir, host, key, cert) {
    const h = cleanHost(host);
    if (!h) throw new Error(`not a site address: ${JSON.stringify(String(host))}`);
    validatePair(h, key, cert);
    const { keyPem, chainPem } = canonicalPair(key, cert);
    const hostDir = path.join(dir, h);
    const keyPath = path.join(hostDir, 'privkey.pem');
    const certPath = path.join(hostDir, 'fullchain.pem');
    try {
        if (fs.readFileSync(keyPath, 'utf8') === keyPem && fs.readFileSync(certPath, 'utf8') === chainPem) return 'unchanged';
    } catch { /* not there yet */ }
    fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    // The key first (owner-only, through a temporary name), then the chain: a reader that sees the new
    // chain also sees its key.
    const tmpKey = keyPath + '.tmp';
    fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
    try { fs.chmodSync(tmpKey, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmpKey, keyPath);
    const tmpCert = certPath + '.tmp';
    fs.writeFileSync(tmpCert, chainPem);
    fs.renameSync(tmpCert, certPath);
    return 'written';
}

/** Remove the certificate of `host` (a deleted site). Returns whether there was one. */
function removeSiteCert(dir, host) {
    const h = cleanHost(host);
    if (!h) return false;
    const hostDir = path.join(dir, h);
    if (!fs.existsSync(hostDir)) return false;
    fs.rmSync(hostDir, { recursive: true, force: true });
    return true;
}

/**
 * The SNI selector of one HTTPS listener. Reads the directory lazily (at most every `refreshMs`), keeps
 * one SecureContext per host and rebuilds it only when the files change. A host with no certificate, or
 * an unreadable one, gets the listener's default certificate.
 */
function createSniSelector(opts = {}) {
    const dir = opts.dir || defaultSitesDir();
    const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : REFRESH_MS;
    const logger = opts.logger || null;
    let contexts = new Map(); // host -> { stamp, ctx }
    let scannedAt = 0;

    function scan() {
        scannedAt = Date.now();
        const next = new Map();
        let names = [];
        try { names = fs.readdirSync(dir); } catch { contexts = next; return; }
        for (const name of names) {
            const h = cleanHost(name);
            if (!h || h !== name) continue;
            // Read each file ONCE, and decide from what was read (its bytes' digest), never from a stat taken
            // before the read: a renewal landing in between can then only be seen whole, at the next scan.
            let keyBytes;
            let certBytes;
            try {
                keyBytes = fs.readFileSync(path.join(dir, h, 'privkey.pem'));
                certBytes = fs.readFileSync(path.join(dir, h, 'fullchain.pem'));
            } catch { continue; }
            const stamp = crypto.createHash('sha256').update(keyBytes).update('\0').update(certBytes).digest('hex');
            const prev = contexts.get(h);
            if (prev && prev.stamp === stamp) { next.set(h, prev); continue; }
            try {
                const ctx = tls.createSecureContext({ key: keyBytes, cert: certBytes });
                next.set(h, { stamp, ctx });
            } catch (e) {
                if (logger) logger.warn(`[Gateway] site certificate for ${h} is unusable: ${e.message}`);
            }
        }
        contexts = next;
    }

    function contextFor(servername) {
        if (Date.now() - scannedAt >= refreshMs) scan();
        const h = cleanHost(servername);
        const entry = h ? contexts.get(h) : null;
        return entry ? entry.ctx : null;
    }

    return {
        contextFor,
        /** For https.createServer({ SNICallback }). A falsy context means: the default certificate. */
        SNICallback(servername, cb) {
            try { cb(null, contextFor(servername) || undefined); }
            catch (e) { cb(null, undefined); }
        },
        hosts() { if (Date.now() - scannedAt >= refreshMs) scan(); return Array.from(contexts.keys()); },
        rescan: scan,
    };
}

module.exports = { defaultSitesDir, cleanHost, validatePair, writeSiteCert, removeSiteCert, createSniSelector, REFRESH_MS };
