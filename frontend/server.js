const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    backendUrlFromEnv,
    BACKEND_URL_ENV,
    createReplicaDispatch,
    createReplicaUpgradeHandler,
    isGatewayPeer,
} = require('./backend-proxy-target.js');

const dev = process.env.NODE_ENV !== 'production';

// PER-REPLICA BACKEND. Next resolves next.config.ts' rewrites at BUILD time into
// .next/routes-manifest.json and never calls that function again at `next start`, so on a
// pre-compiled release the rewrite's destination is frozen at whatever the packager saw. That makes
// the rewrite alone useless for the case it exists for — N frontend replicas, each pinned to a
// different backend, deployed from ONE artifact — so when WORDJS_BACKEND_URL is set this server
// handles /api and /uploads itself, ahead of Next, and the baked rewrite is never reached.
// Unset (the default): nothing below runs and behaviour is exactly what it was.
// Monolith mode dispatches /api in-process before Next, so the override does not apply there.
const backendTarget = process.env.WORDJS_MODE === 'mono' ? null : backendUrlFromEnv();
if (backendTarget) {
    console.log(`🔀 Proxying /api and /uploads → ${backendTarget} (from ${BACKEND_URL_ENV})`);
}

// With a backend pinned this replica is the front door, and EVERY request and upgrade gets its
// forwarding headers restated before either dispatcher (proxyToBackend or Next's own rewrite proxy)
// sees it — see createReplicaDispatch / createReplicaUpgradeHandler. Next attaches its own 'upgrade'
// listener to `httpServer` (else to the real server, where it would run before nothing pinned the
// headers), so it is given an emitter that only the replica's upgrade handler feeds.
//
// TWO dispatchers, by listener. On the mTLS listener a request whose client certificate is the GATEWAY's
// (isGatewayPeer: CN gateway-internal) keeps the forwarding headers the gateway already stated at its edge
// — re-pinning would overwrite its judged X-Forwarded-Host with this replica's internal Host and the
// client's address with the gateway's. Any OTHER cluster-CA certificate on that listener (a backend
// node's, another frontend's) is pinned like a client: mutual TLS proves cluster membership, not that the
// peer is the gateway. The HTTP-fallback listener has no mTLS hop in front, so it always pins.
// Covered end to end (this file, real certificates) by src/lib/__tests__/replicaServerWiring.test.ts.
const upgrades = backendTarget ? new EventEmitter() : null;
const app = next(upgrades ? { dev, httpServer: upgrades } : { dev });
const handle = app.getRequestHandler();
// mTLS listener: trust the forwarding headers of the gateway's identity only.
const dispatchGateway = createReplicaDispatch({ backendTarget, handle, trustForwardedHeaders: isGatewayPeer });
const onUpgradeGateway = upgrades ? createReplicaUpgradeHandler({ backendTarget, upgrades, trustForwardedHeaders: isGatewayPeer }) : null;
// Client-facing (HTTP fallback) listener: pin the forwarding headers (no trusted hop in front).
const dispatchFrontDoor = createReplicaDispatch({ backendTarget, handle });
const onUpgradeFrontDoor = upgrades ? createReplicaUpgradeHandler({ backendTarget, upgrades }) : null;

// Configuration for mTLS. SEPARATE mode: node-join writes the frontend's cert to frontend/certs. LOCAL
// split (one machine): the install generates all service certs into backend/certs — so fall back there
// when frontend/certs hasn't been provisioned. Without this the frontend serves plain HTTP while it still
// registers itself as https:// with the gateway → the gateway's HTTPS proxy fails (EPROTO) → 502.
const localCertDir = path.resolve(process.cwd(), 'certs');
const beCertDir = path.resolve(process.cwd(), '..', 'backend', 'certs');
const certDir = fs.existsSync(path.join(localCertDir, 'frontend.crt')) ? localCertDir : beCertDir;
const caPath = path.join(certDir, 'cluster-ca.crt');
const keyPath = path.join(certDir, 'frontend.key');
const certPath = path.join(certDir, 'frontend.crt');

const port = process.env.PORT || 3001;

app.prepare().then(() => {
    let httpsOptions = null;

    if (fs.existsSync(caPath) && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ca: fs.readFileSync(caPath),
            requestCert: true,
            rejectUnauthorized: true // ENFORCE mTLS (Only Gateway/Setup should have certs)
        };
        console.log('🛡️  Frontend starting with mTLS enabled.');
    } else {
        console.warn('⚠️  Frontend mTLS certs missing. Starting in HTTP fallback mode.');
    }

    if (httpsOptions) {
        const server = createServer(httpsOptions, (req, res) => {
            const parsedUrl = parse(req.url, true);

            // mTLS: every cluster-CA certificate gets in; only the gateway's identity (CN gateway-internal)
            // keeps the forwarding headers it stated — see isGatewayPeer.
            dispatchGateway(req, res, parsedUrl);
        });
        if (onUpgradeGateway) server.on('upgrade', onUpgradeGateway);
        server.listen(port, (err) => {
            if (err) throw err;
            console.log(`> Ready on https://localhost:${port} (mTLS)`);
        });
    } else {
        // Fallback to HTTP for safety if certs are gone
        const { createServer: createHttpServer } = require('http');
        const server = createHttpServer((req, res) => {
            const parsedUrl = parse(req.url, true);
            // HTTP fallback: no mTLS hop in front, so a client can reach this directly — pin the headers.
            dispatchFrontDoor(req, res, parsedUrl);
        });
        if (onUpgradeFrontDoor) server.on('upgrade', onUpgradeFrontDoor);
        server.listen(port, (err) => {
            if (err) throw err;
            console.log(`> Ready on http://localhost:${port} (HTTP Fallback)`);
        });
    }
});
