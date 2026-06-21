require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const compression = require('compression');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cluster = require('cluster');
const os = require('os');
const winston = require('winston');
require('winston-daily-rotate-file');

const fs = require('fs');
const path = require('path');

const { createProxyServer, createUpstreamAgent } = require('./proxy-config');

// --- LOGGER SETUP ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.DailyRotateFile({
            filename: 'logs/gateway-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        })
    ]
});


// --- GATEWAY CONFIG ---
const REGISTRY_FILE = path.resolve(__dirname, '../gateway-registry.json');
const REGISTRY_TEMP = path.resolve(__dirname, '../gateway-registry.json.tmp');

let configSecret = null;
let configPort = 3000;
let config = {};

try {
    const configPath = path.resolve(__dirname, '../gateway-config.json');
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configSecret = config.gatewaySecret;
        if (config.gatewayPort) configPort = parseInt(config.gatewayPort, 10);
        const internalPort = config.gatewayInternalPort || (configPort + 100);
        global.INTERNAL_PORT = internalPort;

        if (config.ssl) {
            if (config.ssl === true || (config.ssl.enabled !== false)) {
                if (config.ssl.key && config.ssl.cert) {
                    global.sslOptions = {
                        key: config.ssl.key,
                        cert: config.ssl.cert
                    };
                } else {
                    config.sslAuto = true;
                }
            }
        }
    }
} catch (e) {
    logger.error(`[Gateway] Config Load Error: ${e.message}`);
}

const FINAL_PORT = configPort;
const GATEWAY_SECRET = configSecret || 'secure-your-gateway-secret';
if (!configSecret) {
    // SECURITY: the public default secret lets anyone call authenticated gateway endpoints /
    // register rogue services. Must be set in gateway-config.json before production.
    logger.warn('[Gateway] ⚠️ SECURITY: no gatewaySecret configured — using the PUBLIC default. Set gatewaySecret in gateway-config.json before deploying.');
}

// --- SSL AUTO-GENERATION ---
const SSL_AUTO_KEY = path.resolve(__dirname, '../ssl-auto.key');
const SSL_AUTO_CERT = path.resolve(__dirname, '../ssl-auto.crt');

async function ensureSSLCerts(config) {
    if (config && (config.ssl === true || (config.ssl && !config.ssl.key))) {
        if (fs.existsSync(SSL_AUTO_KEY) && fs.existsSync(SSL_AUTO_CERT)) return;
        try {
            const selfsigned = require('selfsigned');
            logger.info('[Gateway] Generating self-signed SSL certificate...');
            const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 365 });
            // SECURITY (H8): the private key must not be world-readable. writeFileSync's mode is
            // ignored if the file already exists, so also chmod 0600 right after (best-effort —
            // chmod is a no-op/throws on some Windows setups and must not crash boot).
            fs.writeFileSync(SSL_AUTO_KEY, pems.private, { mode: 0o600 });
            try { fs.chmodSync(SSL_AUTO_KEY, 0o600); } catch (e) { /* chmod unsupported (e.g. Windows) */ }
            fs.writeFileSync(SSL_AUTO_CERT, pems.cert);
            logger.info('[Gateway] Self-signed SSL certificate generated.');
        } catch (err) {
            logger.error('[Gateway] Failed to generate SSL certs: ' + err.message);
        }
    }
}

// Optional: bind a plain-HTTP listener (default OFF) that answers ACME HTTP-01 challenges and
// 301-redirects everything else to HTTPS. Enable by setting acme.http01Port (e.g. 80) in
// gateway-config.json. Needed because Let's Encrypt validates HTTP-01 on port 80, which the HTTPS
// gateway does not otherwise bind. Reads challenge tokens straight from the backend webroot (where
// cert-manager writes them). Started in the primary only, so there is exactly one :80 listener.
function maybeStartAcmeHttpListener() {
    // The admin UI persists the acme block to the BACKEND config (backend/wordjs-config.json), not
    // gateway-config.json — so consult it as the source of truth (matching monolith.js). Read once at
    // boot; setting http01Port via the UI therefore needs a gateway restart to take effect.
    let acme = config.acme || {};
    if (!acme.http01Port) {
        try {
            const beCfgPath = path.resolve(__dirname, '../../backend/wordjs-config.json');
            if (fs.existsSync(beCfgPath)) {
                const beCfg = JSON.parse(fs.readFileSync(beCfgPath, 'utf8'));
                if (beCfg.acme && beCfg.acme.http01Port) acme = beCfg.acme;
            }
        } catch (e) { /* ignore — listener stays off */ }
    }
    const port = Number(acme.http01Port || 0);
    if (!port) return;
    const http = require('http');
    // Default webroot = the backend's public dir (../../backend/public relative to gateway/src).
    const webroot = path.resolve(__dirname, '../../', acme.webroot || 'backend/public');
    const challengeBase = path.join(webroot, '.well-known', 'acme-challenge');
    const srv = http.createServer((req, res) => {
        try {
            const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
            if (reqPath.startsWith('/.well-known/acme-challenge/')) {
                const token = path.basename(reqPath); // strips any path-traversal segments
                const file = path.join(challengeBase, token);
                if (token && file.startsWith(challengeBase + path.sep) && fs.existsSync(file)) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    return res.end(fs.readFileSync(file));
                }
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Not found');
            }
            const host = (req.headers.host || '').split(':')[0];
            const suffix = FINAL_PORT === 443 ? '' : `:${FINAL_PORT}`;
            res.writeHead(301, { Location: `https://${host}${suffix}${req.url}` });
            res.end();
        } catch (e) {
            try { res.writeHead(500); res.end(); } catch (_) { /* ignore */ }
        }
    });
    srv.on('error', (e) => logger.error(`[Gateway] ACME HTTP-01 listener on :${port} failed: ${e.message}`));
    srv.listen(port, () => logger.info(`[Gateway] ACME HTTP-01 + HTTPS-redirect listener on :${port}`));
}

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    logger.info(`[Gateway] Starting on port ${FINAL_PORT}...`);

    (async () => {
        await ensureSSLCerts(config);

        // Limit workers in dev to avoid resource exhaustion and port confusion
        const maxWorkers = config.nodeEnv === 'development' ? Math.min(numCPUs, 4) : Math.min(numCPUs, 16);
        logger.info(`[Gateway] Primary ${process.pid} is running. Spawning ${maxWorkers} workers...`);
        for (let i = 0; i < maxWorkers; i++) cluster.fork();

        startInternalServer();
        maybeStartAcmeHttpListener();
    })();

    cluster.on('exit', (worker) => {
        logger.error(`[Gateway] Worker ${worker.process.pid} died. Respawning...`);
        cluster.fork();
    });

    let registry = new Map();

    const saveRegistry = () => {
        try {
            const data = {};
            registry.forEach((value, key) => {
                const metricsObj = {};
                if (value.metrics) value.metrics.forEach((m, url) => { metricsObj[url] = m; });
                data[key] = { name: value.name, targets: Array.from(value.targets), metrics: metricsObj };
            });
            fs.writeFileSync(REGISTRY_TEMP, JSON.stringify(data, null, 2));
            fs.renameSync(REGISTRY_TEMP, REGISTRY_FILE);
        } catch (e) { logger.error(`[Gateway] Registry Save Error: ${e.message}`); }
    };

    const loadRegistry = () => {
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
                Object.entries(data).forEach(([key, value]) => {
                    const metrics = new Map();
                    if (value.metrics) Object.entries(value.metrics).forEach(([url, m]) => metrics.set(url, m));
                    registry.set(key, { name: value.name, targets: new Set(value.targets), index: 0, metrics });
                });
            }
        } catch (e) {
            console.error('[Gateway] Failed to load registry:', e.message);
        }
    };

    loadRegistry();

    const broadcastRegistry = () => {
        const data = {};
        registry.forEach((v, k) => {
            const metricsObj = {};
            if (v.metrics) v.metrics.forEach((m, url) => { metricsObj[url] = m; });
            data[k] = { name: v.name, targets: Array.from(v.targets), metrics: metricsObj };
        });
        for (const id in cluster.workers) cluster.workers[id].send({ type: 'REGISTRY_UPDATE', registry: data });
    };

    // Prepare mTLS Agent for Health Checks
    const MTLS_CA = path.resolve(__dirname, '../certs/cluster-ca.crt');
    const MTLS_KEY = path.resolve(__dirname, '../certs/gateway-internal.key');
    const MTLS_CERT = path.resolve(__dirname, '../certs/gateway-internal.crt');
    let healthAgent = null;

    if (fs.existsSync(MTLS_CA) && fs.existsSync(MTLS_KEY) && fs.existsSync(MTLS_CERT)) {
        try {
            healthAgent = createUpstreamAgent({
                ca: fs.readFileSync(MTLS_CA),
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT)
            });
            logger.info('[Gateway] Primary mTLS Agent loaded for health checks.');
        } catch (e) { logger.error(`[Gateway] Failed to load mTLS agent: ${e.message}`); }
    }

    // Health Checks
    setInterval(async () => {
        let changed = false;

        // Dedupe identical target URLs across routes: probe each distinct URL over the network only
        // once per sweep, sharing the in-flight axios promise.
        const inflight = new Map();
        const probeUrl = (url) => {
            if (!inflight.has(url)) {
                const start = Date.now();
                const isHttps = url.startsWith('https:');
                inflight.set(url, axios.get(`${url}/health`, {
                    timeout: 5000,
                    httpsAgent: isHttps ? healthAgent : null,
                    validateStatus: (status) => status < 500 // Accept 4xx as "alive" if path missing
                }).then(() => ({ ok: true, latency: Date.now() - start }),
                        (e) => ({ ok: false, error: e })));
            }
            return inflight.get(url);
        };

        // Probe a single (route, url) target. Updates group.metrics in place and flips the shared
        // `changed` flag on ANY status transition (Healthy<->Failing) or on eviction, so workers are
        // re-broadcast promptly and stop selecting a target that just started failing.
        const checkOne = async (route, group, url) => {
            if (!group.metrics) group.metrics = new Map();
            const prevStatus = group.metrics.get(url)?.status;
            const result = await probeUrl(url);
            if (result.ok) {
                group.metrics.set(url, { status: 'Healthy', latency: result.latency, failCount: 0 });
                if (prevStatus && prevStatus !== 'Healthy') changed = true;
            } else {
                const e = result.error;
                const m = group.metrics.get(url) || { failCount: 0 };
                m.status = 'Failing';
                m.failCount++;
                m.lastError = e.message;

                // Log the first failure to help debugging
                if (m.failCount === 1) {
                    logger.warn(`[Gateway] Health Check Failed for ${group.name} (${url}): ${e.message}`);
                }

                group.metrics.set(url, m);
                if (prevStatus !== 'Failing') changed = true;
                if (m.failCount >= 3) {
                    logger.error(`[Gateway] Service ${group.name} at ${url} EXPIRED. Removing.`);
                    group.targets.delete(url);
                    if (group.metrics) group.metrics.delete(url);
                    // Mirror handleRegistration cleanup: drop the route if it has no targets left,
                    // otherwise getTarget would compute final[index % 0] === final[NaN] === undefined.
                    if (group.targets.size === 0) registry.delete(route);
                    changed = true;
                }
            }
        };

        // Run all probes CONCURRENTLY so the sweep takes ~one timeout instead of the sum of them.
        // metrics are per-group, so every (route, url) pair must be checked — but a given URL is only
        // probed over the network once per sweep: checkOne reuses the in-flight axios promise per URL.
        const probes = [...registry.entries()].flatMap(([route, group]) =>
            Array.from(group.targets).map(url => checkOne(route, group, url))
        );
        await Promise.all(probes);

        if (changed) { saveRegistry(); broadcastRegistry(); }
    }, 30000);

    const handleRegistration = (service) => {
        registry.forEach((group, route) => {
            if (group.targets.has(service.url)) {
                group.targets.delete(service.url);
                if (group.targets.size === 0) registry.delete(route);
            }
        });
        service.routes.forEach(route => {
            if (!registry.has(route)) registry.set(route, { name: service.name, targets: new Set(), index: 0, metrics: new Map() });
            registry.get(route).targets.add(service.url);
        });
        saveRegistry();
        broadcastRegistry();
        logger.info(`[Gateway] Service registered: ${service.name} -> ${service.url}`);
    };

    // Helper to restart workers (used by both message handler and internal API)
    const restartGateway = () => {
        logger.info('[Gateway] 🔄 Reloading workers...');
        for (const id in cluster.workers) cluster.workers[id].kill();
    };

    cluster.on('message', (worker, message) => {
        if (message.type === 'REGISTER_SERVICE') {
            handleRegistration(message.service);
        }
        if (message.type === 'RESTART_GATEWAY') {
            restartGateway();
        }
    });

    function startInternalServer() {
        const MTLS_CA = path.resolve(__dirname, '../certs/cluster-ca.crt');
        const MTLS_KEY = path.resolve(__dirname, '../certs/gateway-internal.key');
        const MTLS_CERT = path.resolve(__dirname, '../certs/gateway-internal.crt');

        if (fs.existsSync(MTLS_CA) && fs.existsSync(MTLS_KEY) && fs.existsSync(MTLS_CERT)) {
            try {
                const https = require('https');
                const internalApp = express();
                internalApp.use(express.json());

                const requireIdentity = (allowedCns) => (req, res, next) => {
                    const cert = req.socket.getPeerCertificate();
                    if (!cert || !cert.subject || !allowedCns.includes(cert.subject.CN)) {
                        logger.warn(`[Gateway] [Internal] ACCESS DENIED: Identity '${cert?.subject?.CN || 'Unknown'}'`);
                        return res.status(403).json({ error: 'Access Forbidden' });
                    }
                    logger.info(`[Gateway] [Internal] mTLS Verified: Identity '${cert.subject.CN}'`);
                    next();
                };

                internalApp.post('/register', requireIdentity(['backend', 'frontend']), (req, res) => {
                    handleRegistration(req.body);
                    res.json({ success: true });
                });

                // New Info Endpoint
                internalApp.get('/info', requireIdentity(['backend']), (req, res) => {
                    const info = {
                        gatewayPort: config.gatewayPort || 3000,
                        sslEnabled: config.ssl === true || (config.ssl && config.ssl.enabled !== false),
                        siteUrl: config.siteUrl,
                        certInfo: null
                    };

                    // Determine active cert path - ONLY from config, not from old auto-generated files
                    let certPath = null;
                    if (config.ssl && config.ssl.cert) {
                        certPath = path.resolve(__dirname, '../' + config.ssl.cert);
                    }

                    if (certPath && fs.existsSync(certPath)) {
                        try {
                            const { X509Certificate } = require('crypto');
                            const certBuffer = fs.readFileSync(certPath);
                            const x509 = new X509Certificate(certBuffer);

                            info.certInfo = {
                                commonName: x509.subject.split('\n').find(s => s.startsWith('CN='))?.replace('CN=', '') || 'Unknown',
                                issuer: x509.issuer.split('\n').find(s => s.startsWith('CN='))?.replace('CN=', '') || 'Unknown',
                                validFrom: x509.validFrom,
                                validTo: x509.validTo,
                                fingerprint: x509.fingerprint256 || x509.fingerprint,
                                serialNumber: x509.serialNumber,
                                type: (x509.issuer === x509.subject) ? 'self-signed' : 'custom' // Simplified type check
                            };
                            // Detect Let's Encrypt from the FULL issuer DN: real LE leaves carry
                            // "Let's Encrypt" in the issuer O= (the CN is the intermediate, e.g. R10/E5),
                            // and staging uses "(STAGING) Let's Encrypt". info.certInfo.issuer above is
                            // the CN only, so test the raw x509.issuer here.
                            if (/let'?s encrypt/i.test(x509.issuer) || /\(STAGING\)/i.test(x509.issuer)) info.certInfo.type = 'letsencrypt';
                        } catch (e) {
                            info.certInfo = { error: 'Failed to parse certificate', details: e.message };
                        }
                    } else if (info.sslEnabled) {
                        info.certInfo = { type: 'none', message: 'SSL enabled but no certificate found' };
                    }

                    res.json(info);
                });

                // New Cert Upload Endpoint
                internalApp.post('/cert-upload', requireIdentity(['backend']), (req, res) => {
                    const { key, cert } = req.body;
                    if (!key || !cert) return res.status(400).json({ error: 'Key and Cert required' });

                    try {
                        const importedDir = path.resolve(__dirname, '../ssl/live/imported');
                        // SECURITY (H8): the dir holds a private key — keep it owner-only (0700).
                        if (!fs.existsSync(importedDir)) fs.mkdirSync(importedDir, { recursive: true, mode: 0o700 });

                        const keyPath = path.join(importedDir, 'privkey.pem');
                        const certPath = path.join(importedDir, 'fullchain.pem');

                        // SECURITY (H8): write the private key owner-only. writeFileSync's mode is
                        // ignored if the file already exists, so also chmod 0600 right after
                        // (best-effort — chmod is a no-op/throws on some Windows setups).
                        fs.writeFileSync(keyPath, key, { mode: 0o600 });
                        try { fs.chmodSync(keyPath, 0o600); } catch (e) { /* chmod unsupported (e.g. Windows) */ }
                        fs.writeFileSync(certPath, cert);

                        // Update Config
                        if (!config.ssl) config.ssl = {};
                        config.ssl.key = './ssl/live/imported/privkey.pem';
                        config.ssl.cert = './ssl/live/imported/fullchain.pem';

                        // CRITICAL: Update global.sslOptions so workers use HTTPS after restart
                        global.sslOptions = {
                            key: config.ssl.key,
                            cert: config.ssl.cert
                        };

                        // Save Config
                        const configPath = path.resolve(__dirname, '../gateway-config.json');
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

                        // Restart Workers directly (we are in Primary process)
                        restartGateway();

                        logger.info('[Gateway] [Internal] Certificate uploaded and config updated.');
                        res.json({ success: true });
                    } catch (e) {
                        logger.error(`[Gateway] [Internal] Cert Upload Error: ${e.message}`);
                        res.status(500).json({ error: e.message });
                    }
                });

                // New Config Update Endpoint
                internalApp.post('/config-update', requireIdentity(['backend']), (req, res) => {
                    const { port, sslEnabled, siteUrl } = req.body;

                    try {
                        // Update Config Object
                        if (port) config.gatewayPort = parseInt(port, 10);
                        if (!config.ssl) config.ssl = {};
                        if (typeof sslEnabled !== 'undefined') config.ssl.enabled = !!sslEnabled;

                        // Update siteUrl logic (Gateway side)
                        if (siteUrl) {
                            config.siteUrl = siteUrl;
                        } else if (config.siteUrl) {
                            // If backend didn't send new siteUrl, try to autocorrect protocol
                            // Use updated values
                            const isSsl = config.ssl.enabled;
                            const currentPort = config.gatewayPort;
                            const protocol = isSsl ? 'https' : 'http';

                            try {
                                const url = new URL(config.siteUrl);
                                url.protocol = protocol + ':';
                                const isStandardPort = (protocol === 'http' && currentPort === 80) ||
                                    (protocol === 'https' && currentPort === 443);
                                if (isStandardPort) {
                                    url.port = '';
                                } else {
                                    url.port = String(currentPort);
                                }
                                config.siteUrl = url.toString().replace(/\/$/, '');
                            } catch (e) {
                                // Fallback regex replacement
                                config.siteUrl = config.siteUrl.replace(/^https?:/, protocol + ':');
                            }
                        }

                        // Save Config
                        const configPath = path.resolve(__dirname, '../gateway-config.json');
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

                        // Restart Workers directly (we are in Primary process)
                        restartGateway();

                        logger.info('[Gateway] [Internal] Configuration updated via API.');
                        res.json({ success: true, siteUrl: config.siteUrl });
                    } catch (e) {
                        logger.error(`[Gateway] [Internal] Config Update Error: ${e.message}`);
                        res.status(500).json({ error: e.message });
                    }
                });

                const internalOptions = {
                    key: fs.readFileSync(MTLS_KEY),
                    cert: fs.readFileSync(MTLS_CERT),
                    ca: fs.readFileSync(MTLS_CA),
                    requestCert: true,
                    rejectUnauthorized: true
                };

                const gatewayInternalPort = config.gatewayInternalPort || 3100;
                // SECURITY: the internal control plane (cert-upload / config-update / worker-restart) is
                // only reached by the local backend, so bind loopback by default rather than every
                // interface. Multi-node deployments may set gatewayInternalBind to a specific
                // cluster/advertise interface; do NOT default to 0.0.0.0.
                const gatewayInternalBind = config.gatewayInternalBind || '127.0.0.1';
                https.createServer(internalOptions, internalApp).listen(gatewayInternalPort, gatewayInternalBind, () => {
                    logger.info(`[Gateway] [Internal] 🛡️ SECURE mTLS Internal Server on ${gatewayInternalBind}:${gatewayInternalPort}`);
                });
            } catch (e) { logger.error(`[Gateway] [Internal] Error: ${e.message}`); }
        } else {
            logger.warn(`[Gateway] [Internal] ⚠️ mTLS certificates not found. Server NOT STARTED.`);
        }
    }

} else {
    // WORKER PROCESS

    // SAFETY NET: Prevent unhandled errors from crashing the worker
    process.on('uncaughtException', (err) => {
        logger.error(`[Gateway] Worker ${process.pid} Uncaught Exception: ${err.message}`);
        if (err.code === 'ECONNABORTED' || err.code === 'EPIPE') {
            // These are common network errors, log them but don't exit
            return;
        }
        // For other fatal errors, we should probably exit and let cluster respawn
        console.error(err);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`[Gateway] Worker ${process.pid} Unhandled Rejection at: ${promise} reason: ${reason}`);
    });

    const app = express();
    let workerRegistry = new Map();

    const loadWorkerRegistry = () => {
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
                workerRegistry = new Map(Object.entries(data).map(([k, v]) => [k, { ...v, targets: new Set(v.targets), index: workerRegistry.get(k)?.index ?? 0 }]));
            }
        } catch (e) {
            console.error('[Gateway Worker] Failed to load worker registry:', e.message);
        }
    };

    process.on('message', (message) => {
        if (message.type === 'REGISTRY_UPDATE') {
            workerRegistry = new Map(Object.entries(message.registry).map(([k, v]) => [k, { ...v, targets: new Set(v.targets), index: workerRegistry.get(k)?.index ?? 0 }]));
        }
    });

    loadWorkerRegistry();

    const proxy = createProxyServer();

    const MTLS_CA = path.resolve(__dirname, '../certs/cluster-ca.crt');
    const MTLS_KEY = path.resolve(__dirname, '../certs/gateway-internal.key');
    const MTLS_CERT = path.resolve(__dirname, '../certs/gateway-internal.crt');

    let proxyAgent = null;
    if (fs.existsSync(MTLS_CA) && fs.existsSync(MTLS_KEY) && fs.existsSync(MTLS_CERT)) {
        proxyAgent = createUpstreamAgent({
            ca: fs.readFileSync(MTLS_CA),
            key: fs.readFileSync(MTLS_KEY),
            cert: fs.readFileSync(MTLS_CERT)
        });
        logger.info(`[Gateway] Worker ${process.pid} mTLS ENABLED for upstream.`);
    }

    const requireAuth = (req, res, next) => {
        // Never accept the shipped public default as valid auth: an unconfigured gateway must not
        // expose management endpoints to anyone who knows the default string.
        if (GATEWAY_SECRET === 'secure-your-gateway-secret') {
            return res.status(503).json({ error: 'Gateway management disabled: configure gatewaySecret.' });
        }
        // Header ONLY — the secret must not travel in the query string (it leaks via access logs,
        // Referer headers and browser history). Compare in constant time to avoid a timing oracle.
        const provided = req.headers['x-gateway-secret'] || '';
        const a = Buffer.from(String(provided));
        const b = Buffer.from(GATEWAY_SECRET);
        if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };

    app.use(helmet({ contentSecurityPolicy: false }));
    // The gateway secret is no longer accepted in the query string (header-only now), so there is no
    // credential to redact and we log every request — the old skip let an attacker suppress logging
    // for any request just by appending ?secret=.
    app.use(morgan('combined', {
        stream: { write: (msg) => logger.info(msg.trim()) }
    }));
    const shouldCompress = (req, res) => {
        if ((req.headers['accept'] || '').includes('text/event-stream') || res.getHeader('Content-Type') === 'text/event-stream') {
            return false;
        }
        return compression.filter(req, res);
    };
    app.use(compression({ filter: shouldCompress }));

    app.get('/gateway-status', requireAuth, (req, res) => {
        res.send('<h1>Gateway Active</h1>');
    });

    const getTarget = (url) => {
        const entries = Array.from(workerRegistry.entries()).sort((a, b) => b[0].length - a[0].length);
        for (const [prefix, group] of entries) {
            if (url.startsWith(prefix)) {
                const targets = Array.from(group.targets);
                const healthy = targets.filter(t => !group.metrics || group.metrics[t]?.status !== 'Failing');
                const final = healthy.length > 0 ? healthy : targets;
                // Guard: an empty group (e.g. after health eviction) would yield final[NaN] === undefined.
                if (final.length === 0) return null;
                const target = final[group.index % final.length];
                group.index++; return target;
            }
        }
        return null;
    };

    // Liveness probe — answered by the gateway itself (edge is up), independent of any backend.
    // /readyz is intentionally NOT handled here so it proxies through to the backend's deep check.
    app.get('/healthz', (req, res) => {
        res.json({ status: 'ok', role: 'gateway', pid: process.pid, timestamp: new Date().toISOString() });
    });

    // SEO Rewrites: Map root sitemap/robots to backend SEO endpoints
    app.get('/sitemap.xml', (req, res, next) => {
        req.url = '/api/v1/seo/sitemap.xml';
        next();
    });

    app.get('/robots.txt', (req, res, next) => {
        req.url = '/api/v1/seo/robots.txt';
        next();
    });

    app.use((req, res) => {
        // SECURITY (CSRF / host-trust): the client must NOT control X-Forwarded-Host. http-proxy's
        // xfwd keeps a client-supplied value (`clientXFH || host`), and the backend trusts XFH for
        // its CSRF same-origin check and the migration guard. Pin XFH to the REAL client-facing Host
        // this public listener saw, so a remote attacker can't forge it to bypass CSRF. (The internal
        // mTLS listener is a separate app and is reached only by trusted, cert-authenticated peers.)
        req.headers['x-forwarded-host'] = req.headers['host'] || '';
        delete req.headers['x-forwarded-server'];
        const target = getTarget(req.url);
        if (target) {
            const isHttps = target.startsWith('https:');
            const isSSE = (req.headers['accept'] || '').includes('text/event-stream');

            logger.debug(`[Gateway] Proxying ${req.method} ${req.url} to ${target}`);
            proxy.web(req, res, {
                target,
                agent: isHttps ? proxyAgent : null,
                secure: false,
                // Increase timeout for SSE (1 hour)
                timeout: isSSE ? 3600000 : 60000,
                proxyTimeout: isSSE ? 3600000 : 60000
            }, (err) => {
                if (!res.headersSent) {
                    const code = err.code || 'UNKNOWN';
                    // Don't log ECONNRESET for SSE as it's common on client close
                    if (isSSE && (code === 'ECONNRESET' || code === 'EPIPE')) return;

                    logger.error(`[Gateway] Proxy Error [${target}] [${code}]: ${err.message}`);
                    if (code === 'ECONNREFUSED') {
                        res.status(502).json({ error: 'Service Unavailable', message: 'The upstream service is starting or down.', target });
                    } else {
                        res.status(502).json({ error: 'Upstream Error', message: err.message, target });
                    }
                }
            });
        } else { res.status(404).json({ error: 'Not Found' }); }
    });

    proxy.on('error', (err, req, res) => {
        // Note: per-request error callbacks are passed to proxy.web()/proxy.ws(), so this
        // global handler is a safety net. The second arg may be an HTTP response (web) or a
        // raw socket (ws). Only writeHead(502) on a real response; destroy a socket.
        if (res && typeof res.writeHead === 'function') {
            if (!res.headersSent) {
                try {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy Error', message: err.message }));
                } catch (e) {
                    logger.error(`[Gateway] Could not send proxy error response: ${e.message}`);
                }
            }
        } else if (res && typeof res.destroy === 'function') {
            try { res.destroy(); } catch (e) { /* socket already gone */ }
        }
    });

    let server;

    // Workers read config directly from file (global.sslOptions is not shared between processes)
    let workerSslOptions = null;
    try {
        const configPath = path.resolve(__dirname, '../gateway-config.json');
        if (fs.existsSync(configPath)) {
            const workerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (workerConfig.ssl && workerConfig.ssl.key && workerConfig.ssl.cert) {
                workerSslOptions = {
                    key: workerConfig.ssl.key,
                    cert: workerConfig.ssl.cert
                };
            }
        }
    } catch (e) {
        logger.error(`[Gateway] Worker ${process.pid} failed to load SSL config: ${e.message}`);
    }

    if (workerSslOptions) {
        try {
            const https = require('https');
            const options = {
                key: fs.readFileSync(path.resolve(__dirname, '../' + workerSslOptions.key)),
                cert: fs.readFileSync(path.resolve(__dirname, '../' + workerSslOptions.cert))
            };
            server = https.createServer(options, app).listen(FINAL_PORT, () => {
                logger.info(`[Gateway] Worker ${process.pid} on ${FINAL_PORT} (HTTPS)`);
            });
        } catch (e) {
            logger.error(`[Gateway] Worker ${process.pid} SSL Error: ${e.message}`);
            server = app.listen(FINAL_PORT, () => logger.info(`[Gateway] Worker ${process.pid} on ${FINAL_PORT} (HTTP - SSL ERROR)`));
        }
    } else {
        server = app.listen(FINAL_PORT, () => logger.info(`[Gateway] Worker ${process.pid} on ${FINAL_PORT} (HTTP)`));
    }

    server.on('upgrade', (req, socket, head) => {
        const target = getTarget(req.url);
        if (target) {
            const isHttps = target.startsWith('https:');
            proxy.ws(req, socket, head, { target, agent: isHttps ? proxyAgent : null, secure: false }, (err) => {
                // Skip benign client-close noise (ECONNRESET/EPIPE), like the HTTP/SSE path; guard err deref.
                if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
                    logger.error(`[Gateway] WebSocket Error [${target}]: ${err && err.message}`);
                }
                socket.destroy();
            });
        } else {
            socket.destroy();
        }
    });

    server.on('error', (err) => {
        logger.error(`[Gateway] Server Error: ${err.message}`);
    });
}
