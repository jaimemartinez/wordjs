const httpProxy = require('http-proxy');
const https = require('https');
const http = require('http');

// changeOrigin:true => upstream receives the TARGET's Host; xfwd:true preserves the original
// client Host as X-Forwarded-Host (the backend's address gate reads x-forwarded-host first).
//
// xfwd treats an EMPTY X-Forwarded-Host as missing and writes the Host header in its place, so the
// gateway removes the Host of a request its edge judged host-less before proxying it (host-edge
// pinForwardedHeaders): the upstream then judges what the edge judged. WebSocket upgrades need nothing:
// http-proxy's WebSocket pass never writes X-Forwarded-Host.
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
// ONLY the hostname check with checkServerIdentity: accept a cert that (a) chains to our CA —
// enforced by rejectUnauthorized:true + ca — AND (b) carries the CN of the ROLE the gateway meant to
// reach. Every node's cert chains to the same CA, so "any cluster CN" would let one role answer for
// another; the expected identity is therefore bound per agent, one agent per role (upstreamAgents).
// Separate agents also keep the keep-alive pools apart: a socket verified as one role is never reused
// for a request meant for another.
function createUpstreamAgent({ ca, key, cert }, allowedCNs) {
    const allowed = Array.isArray(allowedCNs) ? allowedCNs.map(String) : [];
    if (!allowed.length) throw new Error('createUpstreamAgent: the expected upstream identity (CN) is required');
    return new https.Agent({
        ...KEEPALIVE,
        ca, key, cert,
        rejectUnauthorized: true,
        checkServerIdentity: (host, peerCert) => {
            const cn = peerCert && peerCert.subject && peerCert.subject.CN;
            if (typeof cn === 'string' && allowed.includes(cn)) return undefined; // accepted
            return new Error(`Gateway: upstream cert CN '${cn}' is not the expected identity (${allowed.join(', ')})`);
        }
    });
}

// The roles a registered target can belong to (routing.ROLE_ROUTES). One verifying agent per role.
const UPSTREAM_ROLES = ['backend', 'frontend'];

/**
 * One agent per upstream role, and `forRole(role)` to pick the one whose certificate check expects that
 * role. An unknown role gets NO agent (null): the caller then refuses the request instead of sending it
 * with a check that would accept any identity.
 */
function upstreamAgents(creds) {
    const agents = Object.create(null);
    for (const role of UPSTREAM_ROLES) agents[role] = createUpstreamAgent(creds, [role]);
    return {
        forRole: (role) => (typeof role === 'string' && agents[role]) || null,
        agents,
    };
}

module.exports = { createProxyServer, createUpstreamAgent, upstreamAgents, UPSTREAM_ROLES, httpKeepAliveAgent };
