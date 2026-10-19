/**
 * WordJS — WHICH CERTIFICATES THE FRONTEND'S SERVER-SIDE FETCHES TRUST.
 *
 * Once a split install has issued the cluster certificates, the frontend's SSR reads go through the
 * gateway's PUBLIC origin (src/lib/server-api.ts backendBaseCandidates: the backend's own listener then
 * accepts only the gateway's client certificate). Trusting the cluster CA alone covers a gateway whose
 * public certificate the cluster CA issued (separate mode). On ONE machine the gateway serves its own
 * auto-generated self-signed pair (gateway/ssl-auto.crt) — or a certificate the operator configured in
 * gateway-config.json — which does not chain to that CA, so every SSR read failed with
 * DEPTH_ZERO_SELF_SIGNED_CERT and content pages rendered 404 while the home page fell back to defaults.
 *
 * buildSsrTrust() returns the PEM files to trust: the cluster CA, plus the certificate the gateway on
 * this machine serves, when there is one next to this frontend. start-frontend.js concatenates them into
 * one bundle for NODE_EXTRA_CA_CERTS (which takes a single file). Adding the gateway's own certificate
 * trusts exactly that certificate (a self-signed leaf is its own issuer), nothing wider.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** The certificate the gateway in `gatewayDir` serves on its public port, or null. */
function gatewayPublicCert(gatewayDir) {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'gateway-config.json'), 'utf8')); } catch { return null; }
    const ssl = cfg && cfg.ssl;
    if (!ssl || (typeof ssl === 'object' && ssl.enabled === false)) return null;
    // An operator-supplied pair wins, exactly as in the gateway (gateway/src/index.js).
    if (typeof ssl === 'object' && typeof ssl.cert === 'string' && ssl.cert) {
        const p = path.resolve(gatewayDir, ssl.cert);
        return fs.existsSync(p) ? p : null;
    }
    const auto = path.join(gatewayDir, 'ssl-auto.crt');
    return fs.existsSync(auto) ? auto : null;
}

/**
 * @param {{ cwd: string }} opts  the frontend directory (start-frontend.js runs from it)
 * @returns {string[]} PEM file paths to trust: the cluster CA when the install has issued it, and the
 *   certificate the local gateway serves whenever there is one.
 *
 * The gateway's certificate is trusted from the FIRST boot, before any install: a split site boots,
 * is installed from the wizard, and from that moment its SSR goes through the HTTPS gateway — while
 * this process still runs with the trust it was started with (NODE_EXTRA_CA_CERTS is read once). With
 * the gateway's certificate only added once the cluster CA existed, every page rendered defaults until
 * the first restart. Trusting exactly that certificate before the install widens nothing.
 */
function buildSsrTrust({ cwd }) {
    const localCa = path.resolve(cwd, 'certs', 'cluster-ca.crt');
    const ca = fs.existsSync(localCa) ? localCa : path.resolve(cwd, '..', 'backend', 'certs', 'cluster-ca.crt');
    const files = fs.existsSync(ca) ? [ca] : [];
    const gw = gatewayPublicCert(path.resolve(cwd, '..', 'gateway'));
    if (gw) files.push(gw);
    return files;
}

/**
 * On the very first start the gateway generates ssl-auto.crt while this frontend is starting next to
 * it (`npm start` launches the three together). Wait for it — briefly, and only when the local gateway
 * has HTTPS on with no operator certificate — so the trust bundle can include it. Returns whether the
 * file is there.
 */
function waitForGatewayAutoCert({ cwd, timeoutMs = 20000 }) {
    const dir = path.resolve(cwd, '..', 'gateway');
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'gateway-config.json'), 'utf8')); } catch { return false; }
    const ssl = cfg && cfg.ssl;
    if (!ssl || (typeof ssl === 'object' && (ssl.enabled === false || (typeof ssl.cert === 'string' && ssl.cert)))) return false;
    const auto = path.join(dir, 'ssl-auto.crt');
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (const deadline = Date.now() + timeoutMs; !fs.existsSync(auto) && Date.now() < deadline;) Atomics.wait(pause, 0, 0, 250);
    return fs.existsSync(auto);
}

/** Write the files into one PEM bundle at `out` and return its path (or the single file, unchanged). */
function writeTrustBundle(files, out) {
    if (files.length === 0) return null;
    if (files.length === 1) return files[0];
    const pem = files.map((f) => fs.readFileSync(f, 'utf8').trim()).join('\n') + '\n';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pem, { mode: 0o644 });
    return out;
}

module.exports = { buildSsrTrust, gatewayPublicCert, waitForGatewayAutoCert, writeTrustBundle };
