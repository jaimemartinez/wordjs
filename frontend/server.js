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
const { installClientAbortGuard } = require('./client-abort.js');
// The configured media/CDN origin joins img-src/media-src at response time (the build cannot know it).
const { installMediaCsp } = require('./media-csp.js');
const { frontendListenHost } = require('./local-gateway.js');

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

// Which address to listen on. With the gateway on this machine only the gateway talks to this server, so
// it listens on loopback (local-gateway.js frontendListenHost); null keeps every interface, as before.
// Published for src/instrumentation.ts, which then registers 127.0.0.1 with the gateway instead of the
// site's public name.
const listenHost = (() => {
    try {
        let dir = process.cwd();
        if (!fs.existsSync(path.join(dir, 'wordjs-config.json'))) dir = path.resolve(dir, '..', 'backend');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8')); } catch { /* none yet */ }
        return frontendListenHost(dir, cfg);
    } catch {
        return null;
    }
})();
if (listenHost) process.env.WORDJS_FRONTEND_LISTEN_HOST = listenHost;
const listenArgs = listenHost ? [port, listenHost] : [port];
const shownHost = listenHost ? (listenHost.includes(':') ? `[${listenHost}]` : listenHost) : 'localhost';

// Decided ONCE, before Next starts, and published for src/instrumentation.ts: the gateway registration
// advertises this node's URL in the scheme chosen here (advertisedUrl). Certificates the installer writes
// later do not change the socket this process already listens on — only a restart does.
const hasIdentity = fs.existsSync(caPath) && fs.existsSync(keyPath) && fs.existsSync(certPath);
process.env.WORDJS_FRONTEND_LISTENER = hasIdentity ? 'https' : 'http';

// The gateway on THIS machine: its protocol and certificate are what start-frontend.js derived the SSR
// trust bundle and the loopback origin from, and both are fixed for this process's life (an environment
// variable, NODE_EXTRA_CA_CERTS). When Admin → Security changes them, ask start-frontend.js to start this
// server again with the new wiring (exit 75), instead of rendering every public page against the old
// protocol until somebody restarts it by hand. Only when start-frontend.js worked that wiring out itself.
if (process.env.WORDJS_LOCAL_GATEWAY_WATCH === '1') {
    const { localGatewaySignature } = require('./local-gateway.js');
    const readSignature = () => {
        try {
            let dir = process.cwd();
            if (!fs.existsSync(path.join(dir, 'wordjs-config.json'))) dir = path.resolve(dir, '..', 'backend');
            let cfg = {};
            try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8')); } catch { /* none yet */ }
            return localGatewaySignature(dir, cfg);
        } catch {
            return null;
        }
    };
    const atStart = readSignature();
    if (atStart !== null) {
        let pending = null;
        const timer = setInterval(() => {
            const now = readSignature();
            if (now === null || now === atStart) { pending = null; return; }
            // Two readings in a row: the gateway rewrites its config and reloads its workers in one go,
            // and a half-written moment must not restart anything.
            if (pending !== now) { pending = now; return; }
            clearInterval(timer);
            console.log('🔄 The gateway on this machine changed its protocol or certificate - restarting the frontend to follow it.');
            process.exit(75);
        }, 3000);
        timer.unref();
    }
}

app.prepare().then(() => {
    let httpsOptions = null;

    if (hasIdentity) {
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
            installMediaCsp(res);
            dispatchGateway(req, res, parsedUrl);
        });
        // A browser that cancels a request must not end the process (client-abort.js).
        installClientAbortGuard(server);
        if (onUpgradeGateway) server.on('upgrade', onUpgradeGateway);
        server.listen(...listenArgs, (err) => {
            if (err) throw err;
            console.log(`> Ready on https://${shownHost}:${port} (mTLS)`);
        });
    } else {
        // Fallback to HTTP for safety if certs are gone
        const { createServer: createHttpServer } = require('http');
        const server = createHttpServer((req, res) => {
            const parsedUrl = parse(req.url, true);
            // HTTP fallback: no mTLS hop in front, so a client can reach this directly — pin the headers.
            installMediaCsp(res);
            dispatchFrontDoor(req, res, parsedUrl);
        });
        installClientAbortGuard(server);
        if (onUpgradeFrontDoor) server.on('upgrade', onUpgradeFrontDoor);
        server.listen(...listenArgs, (err) => {
            if (err) throw err;
            console.log(`> Ready on http://${shownHost}:${port} (HTTP Fallback)`);
        });
    }
});
