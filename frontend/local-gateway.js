/**
 * WordJS — IS THE GATEWAY ON THIS MACHINE, AND HOW DO WE REACH IT WITHOUT LEAVING IT?
 *
 * In a local split install (gateway + backend + frontend on one box) the frontend's server-side reads go
 * through the gateway once the install has issued the cluster certificates (src/lib/server-api.ts). They
 * used the gateway's PUBLIC address (`gatewayUrl`, i.e. the site address), so behind nginx — or any
 * fronting proxy — every SSR read left the server, came back in through the public name, crossed the proxy
 * and only then reached the gateway listening next door. That costs a DNS lookup and two extra hops per
 * read, depends on the server resolving its own public name (hairpin NAT often does not), and fails the
 * moment the proxy's certificate or address changes. `internalApiUrl` was the only way out.
 *
 * localGatewayOrigin() answers the loopback origin of the gateway that runs next to this frontend, or
 * null when there is none (separate mode, a gateway on another host) or when it cannot be reached by a
 * loopback name its certificate covers — then the caller keeps the public address, as before:
 *   · ssl off                        → http://127.0.0.1:<gatewayPort>
 *   · ssl on, auto-generated pair    → https://127.0.0.1:<gatewayPort> (ssl-auto.crt carries IP:127.0.0.1;
 *                                      the frontend trusts that certificate, scripts/ssr-trust.js)
 *   · ssl on, operator certificate   → loopback only if that certificate names 127.0.0.1 or localhost
 *
 * frontendListenHost() is the other half: the frontend listened on every interface (and registered the
 * site's public name with the gateway) although only the gateway on the same machine ever talks to it.
 * It answers loopback when the gateway is local and no routable `advertiseHost` is configured; null
 * (every interface, as before) otherwise. WORDJS_FRONTEND_BIND overrides it either way.
 *
 * CommonJS at the frontend root for the same reason as hermetic-build.js: server.js and the scripts
 * cannot import TypeScript, and src/ reads the same function rather than a copy of it. fs/path are
 * required inside the functions so importing this from src/ pulls nothing into a client bundle.
 */
'use strict';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackName(host) {
    return LOOPBACK_NAMES.has(String(host || '').trim().toLowerCase());
}

/**
 * The gateway directory next to the directory holding the frontend's wordjs-config.json (frontend/ or, on
 * one machine, backend/), plus its parsed gateway-config.json — or null when there is no local gateway.
 */
function readLocalGateway(configDir) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.resolve(configDir, '..', 'gateway');
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'gateway-config.json'), 'utf8'));
        return cfg && typeof cfg === 'object' ? { dir, cfg } : null;
    } catch {
        return null;
    }
}

/** Does the frontend's own config point at a gateway on ANOTHER host? Then the one on disk is not ours. */
function gatewayIsElsewhere(frontendCfg) {
    const host = frontendCfg && frontendCfg.gatewayHost;
    return !!host && !isLoopbackName(host);
}

/**
 * @param {string} configDir   directory of the wordjs-config.json the caller read
 * @param {object} frontendCfg that config, parsed
 * @returns {string|null} `scheme://loopback:port` of the local gateway, or null
 */
function localGatewayOrigin(configDir, frontendCfg) {
    if (gatewayIsElsewhere(frontendCfg)) return null;
    const gw = readLocalGateway(configDir);
    if (!gw) return null;
    const port = parseInt(gw.cfg.gatewayPort, 10) || 3000;
    if (port < 1 || port > 65535) return null;
    const ssl = gw.cfg.ssl;
    // Same reading of `ssl` as the gateway (gateway/src/index.js) and scripts/ssr-trust.js.
    if (!ssl || (typeof ssl === 'object' && ssl.enabled === false)) return `http://127.0.0.1:${port}`;
    if (typeof ssl === 'object' && typeof ssl.cert === 'string' && ssl.cert) {
        try {
            const fs = require('fs');
            const path = require('path');
            const { X509Certificate } = require('crypto');
            const cert = new X509Certificate(fs.readFileSync(path.resolve(gw.dir, ssl.cert)));
            if (cert.checkIP('127.0.0.1')) return `https://127.0.0.1:${port}`;
            if (cert.checkHost('localhost')) return `https://localhost:${port}`;
        } catch { /* unreadable certificate: keep the public address */ }
        return null;
    }
    // Auto-generated pair: CN=localhost with DNS:localhost and IP:127.0.0.1 (gateway ensureSSLCerts).
    return `https://127.0.0.1:${port}`;
}

/** Is there a gateway on this machine that this frontend belongs to? */
function gatewayIsLocal(configDir, frontendCfg) {
    return !gatewayIsElsewhere(frontendCfg) && !!readLocalGateway(configDir);
}

/**
 * @param {string} configDir   directory of the wordjs-config.json the frontend reads
 * @param {object} frontendCfg that config, parsed ({} when there is none)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} the address to listen on, or null for every interface
 *
 * The frontend's `frontendUrl` is the site's public origin (the `home` option), not where the gateway
 * dials, so it does not keep the listener public; `advertiseHost` does — it is the routable address a
 * gateway on another machine uses. When this answers loopback, server.js publishes it and
 * src/instrumentation.ts registers 127.0.0.1 with the gateway (every issuer puts 127.0.0.1 in the
 * frontend certificate's SANs), so the gateway's hop to the frontend never leaves the machine either.
 */
function frontendListenHost(configDir, frontendCfg, env = process.env) {
    const explicit = String((env && env.WORDJS_FRONTEND_BIND) || '').trim();
    if (explicit) return explicit;
    const cfg = frontendCfg || {};
    if (cfg.advertiseHost && !isLoopbackName(cfg.advertiseHost)) return null;
    return gatewayIsLocal(configDir, cfg) ? '127.0.0.1' : null;
}

module.exports = { localGatewayOrigin, frontendListenHost, gatewayIsLocal, isLoopbackName };
