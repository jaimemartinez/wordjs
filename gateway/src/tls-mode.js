'use strict';
/**
 * WordJS gateway — ONE reading of the `ssl` block of gateway-config.json.
 *
 * The decision "does the public listener speak TLS, and with which key pair?" used to be taken in three
 * places that disagreed: the primary honoured `enabled: false`, every worker re-read the file and served
 * HTTPS as soon as `key` and `cert` were present, and the control plane wrote `ssl: false` back as
 * `ssl: {}` (which reads as "on, auto-generate a certificate"). The result was a gateway whose logs and
 * admin panel said HTTP while the workers served HTTPS, and a panel switch that could not turn TLS off.
 *
 * Every caller now goes through these functions:
 *   · sslSwitchedOn(ssl)        — the on/off switch, nothing else (`true`, or an object without
 *                                 `enabled: false`; absent, `false` and `{enabled:false}` are off)
 *   · normalizeSsl(ssl)         — the object form every writer mutates, keeping the switch as it was
 *   · servingKeyPair(ssl, dir)  — the key pair a worker serves, or null for plain HTTP
 */

const fs = require('fs');
const path = require('path');

const AUTO_KEY = 'ssl-auto.key';
const AUTO_CERT = 'ssl-auto.crt';

/** Is TLS switched on? Absent, `false` and `{ enabled: false }` are off; `true` and any other object are on. */
function sslSwitchedOn(ssl) {
    if (ssl === true) return true;
    if (!ssl || typeof ssl !== 'object') return false;
    return ssl.enabled !== false;
}

/**
 * The object form of `ssl`, with the switch made explicit, for a writer that is about to add or change a
 * field. `false` / absent stays OFF (`{ enabled: false }`) — never `{}`, which reads as on.
 */
function normalizeSsl(ssl) {
    const out = ssl && typeof ssl === 'object' ? { ...ssl } : {};
    out.enabled = sslSwitchedOn(ssl);
    return out;
}

/**
 * The key pair the public listener serves, as paths relative to the gateway directory, or null for plain
 * HTTP. The switch is read FIRST: a stored certificate never turns TLS on by itself.
 *
 * @param {unknown} ssl          the `ssl` value of gateway-config.json
 * @param {string}  gatewayDir   the directory gateway-config.json lives in
 * @param {(p: string) => boolean} [exists]
 * @returns {{ key: string, cert: string, source: 'configured' | 'auto' } | null}
 */
function servingKeyPair(ssl, gatewayDir, exists = fs.existsSync) {
    if (!sslSwitchedOn(ssl)) return null;
    if (ssl && typeof ssl === 'object' && ssl.key && ssl.cert) {
        return { key: String(ssl.key), cert: String(ssl.cert), source: 'configured' };
    }
    // On, without a configured pair: the auto-generated one, when the primary has written it.
    if (exists(path.resolve(gatewayDir, AUTO_KEY)) && exists(path.resolve(gatewayDir, AUTO_CERT))) {
        return { key: AUTO_KEY, cert: AUTO_CERT, source: 'auto' };
    }
    return null;
}

/** Should the primary generate the auto pair? Only when TLS is on and no pair is configured. */
function needsAutoPair(ssl) {
    return sslSwitchedOn(ssl) && !(ssl && typeof ssl === 'object' && ssl.key && ssl.cert);
}

/**
 * The gateway's own idea of the site address after its port or TLS switch changed, when the backend did
 * not send one. It follows the change ONLY when the address points at the gateway's own listener (its
 * port is the port the gateway listened on): behind a proxy or a tunnel the public scheme and port are
 * the proxy's, and rewriting `http://example.test:3303` into `http://example.test:3000` - the port the
 * gateway listens on behind it - moved the site to an address nobody can reach.
 *
 * @param {string} siteUrl
 * @param {{ oldPort: number, newPort: number, https: boolean }} change
 * @returns {string} the address to keep (unchanged when it is not the gateway's own)
 */
function followGatewaySiteUrl(siteUrl, { oldPort, newPort, https }) {
    let u;
    try { u = new URL(siteUrl); } catch { return siteUrl; }
    const effective = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (effective !== Number(oldPort)) return siteUrl;
    const protocol = https ? 'https:' : 'http:';
    u.protocol = protocol;
    const standard = (protocol === 'http:' && Number(newPort) === 80) || (protocol === 'https:' && Number(newPort) === 443);
    u.port = standard ? '' : String(newPort);
    return u.origin;
}

/** The IPC message a worker sends the primary once its public listener is up. */
const TRANSPORT_MESSAGE = 'WORKER_TRANSPORT';

/**
 * What the workers serve, as they reported it (primary side). The primary's own reading of the config is
 * an intent; the workers' listeners are the fact the panel must show.
 */
function createTransportAggregate() {
    const byWorker = new Map();
    return {
        update(workerId, https) { byWorker.set(workerId, !!https); },
        remove(workerId) { byWorker.delete(workerId); },
        /** 'https' | 'http' | 'mixed' (workers disagree, e.g. mid-reload) | null (none reported yet) */
        summary() {
            if (byWorker.size === 0) return null;
            const values = [...byWorker.values()];
            if (values.every(Boolean)) return 'https';
            if (values.every((v) => !v)) return 'http';
            return 'mixed';
        },
    };
}

module.exports = {
    sslSwitchedOn, normalizeSsl, servingKeyPair, needsAutoPair, followGatewaySiteUrl,
    createTransportAggregate, TRANSPORT_MESSAGE, AUTO_KEY, AUTO_CERT,
};
