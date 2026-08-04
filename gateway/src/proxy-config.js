const httpProxy = require('http-proxy');
const https = require('https');
const http = require('http');

// changeOrigin:true => upstream receives the TARGET's Host; xfwd:true preserves the original
// client Host as X-Forwarded-Host (the backend's migration guard reads x-forwarded-host first).
function createProxyServer() {
    return httpProxy.createProxyServer({ xfwd: true, changeOrigin: true });
}

// Connection reuse to upstreams. Without an agent, http-proxy opens (and closes) a fresh TCP
// connection per proxied request — and on the mTLS path that is a FULL handshake per request
// (30 assets = 30 handshakes). keepAlive pools the sockets; the TLS identity/verification
// options are untouched.
const KEEPALIVE = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 32 };

// Shared agent for plain-HTTP upstreams (pre-mTLS bootstrap, HTTP-mode peers).
const httpKeepAliveAgent = new http.Agent(KEEPALIVE);

// Verify the upstream server cert (rejectUnauthorized:true) against the cluster CA. Targets are
// addressed by IP (https://127.0.0.1:PORT) while internal certs carry service CNs, so we override
// ONLY the hostname check with checkServerIdentity: accept any cert that (a) chains to our CA —
// enforced by rejectUnauthorized:true + ca — AND (b) has an allowed internal CN. This gives MITM
// protection without requiring IP SANs in the internal certs.
function createUpstreamAgent({ ca, key, cert }, allowedCNs = ['backend', 'frontend', 'gateway', 'gateway-internal']) {
    return new https.Agent({
        ...KEEPALIVE,
        ca, key, cert,
        rejectUnauthorized: true,
        checkServerIdentity: (host, peerCert) => {
            const cn = peerCert && peerCert.subject && peerCert.subject.CN;
            if (allowedCNs.includes(cn)) return undefined; // accepted
            return new Error(`Gateway: upstream cert CN '${cn}' not in allowed identities`);
        }
    });
}

module.exports = { createProxyServer, createUpstreamAgent, httpKeepAliveAgent };
