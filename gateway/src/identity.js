'use strict';
/**
 * mTLS identity gate for the gateway's INTERNAL listener.
 *
 * Every handler on that listener (`/register`, `/purge`, `/info`, `/cert-upload`, `/config-update`,
 * `/revalidate-secret`) is authorized the same way: the peer must present a certificate issued by the
 * cluster CA, and its CN — the node's ROLE — must be in the handler's allowlist. The TLS server itself
 * has already done the hard part (`requestCert: true, rejectUnauthorized: true` against the cluster CA),
 * so an unsigned or forged certificate never reaches Express at all; this middleware only decides which
 * proven role may call which endpoint.
 *
 * It lives here rather than inline in index.js because it is the single authorization primitive of the
 * cluster's control plane, and a security control that cannot be required from a test is a security
 * control nobody checks. gateway/test/cluster-secret.test.js drives THIS function over a real mTLS
 * handshake with real node-forge certificates.
 */

/**
 * @param {string[]} allowedCns roles permitted to call the handler (e.g. ['backend'], ['frontend'])
 * @param {{warn: Function, info: Function}} logger
 */
function requireIdentity(allowedCns, logger) {
    return (req, res, next) => {
        const cert = req.socket.getPeerCertificate();
        if (!cert || !cert.subject || !allowedCns.includes(cert.subject.CN)) {
            logger.warn(`[Gateway] [Internal] ACCESS DENIED: Identity '${(cert && cert.subject && cert.subject.CN) || 'Unknown'}'`);
            return res.status(403).json({ error: 'Access Forbidden' });
        }
        logger.info(`[Gateway] [Internal] mTLS Verified: Identity '${cert.subject.CN}'`);
        next();
    };
}

module.exports = { requireIdentity };
