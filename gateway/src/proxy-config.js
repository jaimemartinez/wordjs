const httpProxy = require('http-proxy');
const https = require('https');

// changeOrigin:true => upstream receives the TARGET's Host; xfwd:true preserves the original
// client Host as X-Forwarded-Host (the backend's migration guard reads x-forwarded-host first).
function createProxyServer() {
    return httpProxy.createProxyServer({ xfwd: true, changeOrigin: true });
}

// Verify the upstream server cert (rejectUnauthorized:true) against the cluster CA. Targets are
// addressed by IP (https://127.0.0.1:PORT) while internal certs carry service CNs, so we override
// ONLY the hostname check with checkServerIdentity: accept any cert that (a) chains to our CA —
// enforced by rejectUnauthorized:true + ca — AND (b) has an allowed internal CN. This gives MITM
// protection without requiring IP SANs in the internal certs.
function createUpstreamAgent({ ca, key, cert }, allowedCNs = ['backend', 'frontend', 'gateway', 'gateway-internal']) {
    return new https.Agent({
        ca, key, cert,
        rejectUnauthorized: true,
        checkServerIdentity: (host, peerCert) => {
            const cn = peerCert && peerCert.subject && peerCert.subject.CN;
            if (allowedCNs.includes(cn)) return undefined; // accepted
            return new Error(`Gateway: upstream cert CN '${cn}' not in allowed identities`);
        }
    });
}

module.exports = { createProxyServer, createUpstreamAgent };
