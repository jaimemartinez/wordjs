#!/usr/bin/env node
/**
 * WordJS — Single-process "monolith" entrypoint.
 *
 * Runs the backend Express app (with its in-process isolated plugins) AND the Next.js frontend AND the
 * gateway's still-needed cross-cutting concerns in ONE Node process, on ONE public port — instead of
 * the 3-service split (gateway :3000 + backend :4000 + frontend :3001). Both modes share the SAME
 * backend/wordjs-config.json, ./data DB, uploads/themes/plugins, secrets and public origin
 * (https://localhost:3000), so you can switch between them at any time:
 *
 *   monolith:  npm run dev:mono   |  npm run build:mono && npm run start:mono
 *   split:     npm run dev        |  npm start
 *
 * The two modes are mutually exclusive (both bind the public port). No data migration to switch.
 *
 * Usage: node monolith.js [dev|prod]   (default: prod)
 */

// Preflight: Next 16 + the native modules need Node >= 20.9. Failing here with a clear message
// beats the cryptic EBADENGINE/native-binding crash a newcomer would otherwise hit mid-boot.
(() => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 20 || (maj === 20 && min < 9)) {
        console.error(`\n✖ WordJS requires Node.js >= 20.9 — you are running ${process.versions.node}.`);
        console.error('  Install Node 20 LTS or 22 LTS (https://nodejs.org) and try again.\n');
        process.exit(1);
    }
})();

const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const GATEWAY = path.join(ROOT, 'gateway');

const dev = (process.argv[2] || '').toLowerCase() === 'dev';
process.env.NODE_ENV = dev ? 'development' : 'production';

// Tell the backend NOT to self-listen/self-register, and the frontend to use monolith wiring.
process.env.WORDJS_EMBEDDED = '1';
process.env.WORDJS_MODE = 'mono';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const appConfig = readJson(path.join(BACKEND, 'wordjs-config.json'));
const gwConfig = readJson(path.join(GATEWAY, 'gateway-config.json'));

const PUBLIC_PORT = Number(process.env.PORT) || appConfig.gatewayPort || gwConfig.gatewayPort || 3000;
// Internal loopback HTTP port the frontend's SSR fetches hit (avoids self-signed TLS verification
// server-side). Reuses the backend's configured port, which is NOT bound in embedded mode.
const LOOPBACK_PORT = appConfig.port || 4000;

process.env.WORDJS_MONO_ORIGIN = `http://127.0.0.1:${LOOPBACK_PORT}`;
process.env.PORT = String(PUBLIC_PORT);

// Backend resolves config/uploads/themes/plugins/data/certs relative to cwd, exactly like
// `cd backend && npm start` does in split mode.
process.chdir(BACKEND);

const helmet = require('helmet');
const compression = require('compression');

// Requests with these path prefixes go to the backend Express app; everything else goes to Next.
// (/healthz is answered directly in dispatch() for liveness; /readyz goes to the backend's deep check.)
// '/public' = backend static assets (wordjs-ui.css framework, shared css/js) — without it the UI
// framework stylesheet 404s in monolith mode (in split mode the gateway routes /public).
const BACKEND_PREFIXES = ['/api', '/public', '/uploads', '/themes', '/plugins', '/.well-known', '/health', '/readyz', '/metrics'];
const isBackendPath = (url) => {
    const u = (url || '/').split('?')[0];
    return BACKEND_PREFIXES.some((p) => u === p || u.startsWith(p + '/'));
};

// Skip compression for SSE streams (parity with the gateway's shouldCompress).
const shouldCompress = (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
};

// Present the SAME public certificate the gateway uses, so switching modes is seamless for the browser.
// async because selfsigned.generate() returns a Promise in v5+ (see the awaited call below).
async function resolveSSL() {
    if (process.env.WORDJS_HTTP === '1') return null;
    try {
        const ssl = gwConfig.ssl;
        if (ssl && ssl.key && ssl.cert) {
            const keyPath = path.resolve(GATEWAY, ssl.key);
            const certPath = path.resolve(GATEWAY, ssl.cert);
            if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
            }
        }
        // Auto self-signed, shared with the gateway at gateway/ssl-auto.*
        const autoKey = path.join(GATEWAY, 'ssl-auto.key');
        const autoCert = path.join(GATEWAY, 'ssl-auto.crt');
        if (fs.existsSync(autoKey) && fs.existsSync(autoCert)) {
            return { key: fs.readFileSync(autoKey), cert: fs.readFileSync(autoCert) };
        }
        if (ssl === true || (ssl && ssl.enabled) || gwConfig.sslAuto) {
            const selfsigned = require('selfsigned');
            // Put localhost + every non-internal LAN IP in the cert SANs, so the dev server (and its
            // subresources — fonts/images loaded by the page or the Puck preview iframe) validate when
            // browsed via https://<lan-ip>:3000, not only https://localhost. A CN=localhost-only cert
            // fails for the LAN IP (ERR_CERT_*). Still self-signed → trust ssl-auto.crt once to silence
            // the warning, but now it MATCHES the host you browse to.
            const os = require('os');
            const altNames = [
                { type: 2, value: 'localhost' },
                { type: 7, ip: '127.0.0.1' },
                { type: 7, ip: '::1' },
            ];
            try {
                for (const ifaces of Object.values(os.networkInterfaces())) {
                    for (const i of (ifaces || [])) {
                        if (!i.internal && i.address && (i.family === 'IPv4' || i.family === 4)) altNames.push({ type: 7, ip: i.address });
                    }
                }
            } catch { /* network enumeration best-effort */ }
            // CRITICAL: selfsigned.generate() is ASYNC (returns a Promise) in v5+. Without await,
            // pems.private/pems.cert are undefined → https.createServer serves no certificate and
            // every TLS handshake fails (sslv3 alert handshake_failure). Matches cert-manager/gateway.
            const pems = await selfsigned.generate(
                [{ name: 'commonName', value: 'localhost' }],
                { days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] }
            );
            // SECURITY (H8): the private key must not be world-readable. writeFileSync's mode is
            // ignored if the file already exists, so also chmod 0600 right after (best-effort —
            // chmod is a no-op/throws on some Windows setups and must not crash).
            try {
                fs.writeFileSync(autoKey, pems.private, { mode: 0o600 });
                try { fs.chmodSync(autoKey, 0o600); } catch { /* chmod unsupported (e.g. Windows) */ }
                fs.writeFileSync(autoCert, pems.cert);
            } catch { /* read-only fs ok */ }
            return { key: pems.private, cert: pems.cert };
        }
    } catch (e) {
        console.warn('[monolith] SSL resolve failed, falling back to HTTP:', e.message);
    }
    return null;
}

async function main() {
    // 1) Next.js FIRST. Next installs a require-hook that overrides Module._resolveFilename/_load and
    //    does NOT know ts-node's `.ts` extension. If ts-node is registered before Next, Next's hook
    //    clobbers it and the backend's runtime `require('../core/x')` of a .ts file fails with
    //    MODULE_NOT_FOUND. Loading Next first means ts-node (registered in step 2) sits ON TOP of
    //    Next's hook and wins for `.ts`, delegating everything else back to Next. (In split mode this
    //    never bites because Next runs in its own process.)
    const nextLib = require(require.resolve('next', { paths: [FRONTEND] }));
    const createNext = nextLib.default || nextLib;
    const nextApp = createNext({ dev, dir: FRONTEND });
    // prepare() MUST run before getRequestHandler/getUpgradeHandler (Next 16 throws otherwise).
    await nextApp.prepare();
    const handle = nextApp.getRequestHandler();
    const upgrade = typeof nextApp.getUpgradeHandler === 'function' ? nextApp.getUpgradeHandler() : null;

    // 2) Backend Express app (compiled dist in prod; ts-node in dev) — registered AFTER Next so the
    //    ts-node resolver overlays Next's hook. Module load installs io-guard, secure-require,
    //    crash-guard and anchors plugin routes (setApp). It does NOT listen (EMBEDDED).
    let backendApp;
    const distEntry = path.join(BACKEND, 'dist', 'index.js');
    if (!dev && fs.existsSync(distEntry)) {
        backendApp = require(distEntry);
    } else {
        require(require.resolve('ts-node/register', { paths: [BACKEND] }));
        backendApp = require(path.join(BACKEND, 'src', 'index.ts'));
    }
    // 3) Boot DB + plugins + theme engine (returns the same app). EMBEDDED skips listen + gateway register.
    if (typeof backendApp.initialize === 'function') {
        await backendApp.initialize();
    }

    // 4) Public server: cross-cutting middleware (ported from the gateway worker) + path dispatch.
    const ssl = await resolveSSL();
    const proto = ssl ? 'https' : 'http';

    // Raw connect-style chain — deliberately NOT an Express app. The root's Express is v5 while the
    // backend is v4; running the request through a v5 app first leaves req.query unset for the v4
    // backend (different query handling) → 500s. helmet and compression are connect-compatible and
    // run fine on the bare Node request without touching req.query, so the backend's own Express
    // parses a clean request.
    const helmetMw = helmet({ contentSecurityPolicy: false });
    const compressionMw = compression({ filter: shouldCompress });
    const dispatch = (req, res) => {
        // Hardening (audit F-09): answer TRACE/TRACK with 405 instead of letting Next handle it as a page
        // (a Cross-Site-Tracing primitive; no WordJS route needs it). Gateway parity — see gateway/src/index.js.
        if (req.method === 'TRACE' || req.method === 'TRACK') {
            res.writeHead(405, { 'Allow': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' });
            return res.end('Method Not Allowed');
        }
        // Liveness probe — answer directly so it works even if the backend app is wedged (gateway parity).
        if ((req.url || '/').split('?')[0] === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', role: 'monolith', pid: process.pid, timestamp: new Date().toISOString() }));
        }
        // Pin forwarded headers so backend CSRF/origin sees the real public host (gateway parity).
        req.headers['x-forwarded-host'] = req.headers['host'] || '';
        req.headers['x-forwarded-proto'] = proto;
        // SEO rewrites (gateway parity).
        if (req.url === '/sitemap.xml') req.url = '/api/v1/seo/sitemap.xml';
        else if (req.url === '/robots.txt') req.url = '/api/v1/seo/robots.txt';
        else if (req.url === '/feed' || req.url === '/feed.xml' || req.url === '/rss.xml') req.url = '/api/v1/seo/feed.xml';
        if (isBackendPath(req.url)) return backendApp(req, res);
        return handle(req, res);
    };
    const requestListener = (req, res) =>
        helmetMw(req, res, () => compressionMw(req, res, () => dispatch(req, res)));

    const http = require('http');
    const server = ssl ? require('https').createServer(ssl, requestListener) : http.createServer(requestListener);
    // Let ACME auto-renewal hot-swap the live TLS cert in-process (no restart). cert-manager calls
    // this after writing a renewed cert in embedded mode. Only meaningful when serving HTTPS.
    if (ssl) {
        global.__WORDJS_RELOAD_TLS__ = (key, cert) => {
            try { server.setSecureContext({ key, cert }); console.log('[monolith] TLS certificate hot-reloaded.'); }
            catch (e) { console.warn('[monolith] TLS hot-reload failed:', e.message); }
        };
    }
    // Next dev HMR uses a WebSocket on the same server; backend serves no WS, so route upgrades to Next.
    server.on('upgrade', (req, socket, head) => {
        if (upgrade && !isBackendPath(req.url)) return upgrade(req, socket, head);
        socket.destroy();
    });
    // Outlive any fronting proxy's idle timeout (nginx default 60s): with Node's 5s default the
    // server races the proxy's socket reuse and drops requests mid-flight.
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.listen(PUBLIC_PORT, () => {
        console.log('');
        console.log(`✅ WordJS MONOLITH (${dev ? 'dev' : 'prod'}) — one process on ${proto}://localhost:${PUBLIC_PORT}`);
        console.log('   backend + frontend + isolated plugins in-process · no gateway, no extra ports');
        console.log('   switch to split anytime: npm run dev   (or npm start)');
    });

    // 5) Loopback-only HTTP listener for the frontend's server-side (SSR) API calls — keeps SSR on
    //    plain HTTP so self-signed TLS never blocks it. Not exposed (127.0.0.1).
    http.createServer(backendApp).listen(LOOPBACK_PORT, '127.0.0.1', () => {
        console.log(`   ↳ internal SSR API: http://127.0.0.1:${LOOPBACK_PORT} (loopback only)`);
    });

    // 6) Optional ACME HTTP-01 + HTTPS-redirect listener (opt-in via acme.http01Port in
    //    wordjs-config.json). Let's Encrypt validates HTTP-01 on port 80, which the HTTPS public
    //    listener does not bind. Serves challenge tokens from backend/public, redirects the rest.
    const acmePort = Number((appConfig.acme && appConfig.acme.http01Port) || 0);
    if (acmePort && ssl) {
        const challengeBase = path.resolve(BACKEND, 'public', '.well-known', 'acme-challenge');
        http.createServer((req, res) => {
            try {
                const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
                if (reqPath.startsWith('/.well-known/acme-challenge/')) {
                    const file = path.join(challengeBase, path.basename(reqPath));
                    if (file.startsWith(challengeBase + path.sep) && fs.existsSync(file)) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        return res.end(fs.readFileSync(file));
                    }
                    res.writeHead(404); return res.end('Not found');
                }
                const host = (req.headers.host || '').split(':')[0];
                const suffix = PUBLIC_PORT === 443 ? '' : `:${PUBLIC_PORT}`;
                res.writeHead(301, { Location: `https://${host}${suffix}${req.url}` });
                res.end();
            } catch (e) { try { res.writeHead(500); res.end(); } catch (_) { /* ignore */ } }
        }).listen(acmePort, () => console.log(`   ↳ ACME HTTP-01 + HTTPS-redirect on :${acmePort}`));
    }
}

main().catch((e) => { console.error('❌ Monolith failed to start:', e); process.exit(1); });
