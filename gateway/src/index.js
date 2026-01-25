require('dotenv').config();
const express = require('express');
const httpProxy = require('http-proxy');
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
        if (config.gatewayPort) configPort = parseInt(config.gatewayPort);
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
            fs.writeFileSync(SSL_AUTO_KEY, pems.private);
            fs.writeFileSync(SSL_AUTO_CERT, pems.cert);
            logger.info('[Gateway] Self-signed SSL certificate generated.');
        } catch (err) {
            logger.error('[Gateway] Failed to generate SSL certs: ' + err.message);
        }
    }
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
    })();

    cluster.on('exit', (worker) => {
        logger.error(`[Gateway] Worker ${worker.process.pid} died. Respawning...`);
        cluster.fork();
    });

    let registry = new Map();

    const saveRegistry = () => {
        try {
            const data = {};
            registry.forEach((value, key) => { data[key] = { name: value.name, targets: Array.from(value.targets) }; });
            fs.writeFileSync(REGISTRY_TEMP, JSON.stringify(data, null, 2));
            fs.renameSync(REGISTRY_TEMP, REGISTRY_FILE);
        } catch (e) { logger.error(`[Gateway] Registry Save Error: ${e.message}`); }
    };

    const loadRegistry = () => {
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
                Object.entries(data).forEach(([key, value]) => {
                    registry.set(key, { name: value.name, targets: new Set(value.targets), index: 0, metrics: new Map() });
                });
            }
        } catch (e) { }
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
            const https = require('https');
            healthAgent = new https.Agent({
                ca: fs.readFileSync(MTLS_CA),
                key: fs.readFileSync(MTLS_KEY),
                cert: fs.readFileSync(MTLS_CERT),
                rejectUnauthorized: false // Allow self-signed IP certs, but we provide client cert
            });
            logger.info('[Gateway] Primary mTLS Agent loaded for health checks.');
        } catch (e) { logger.error(`[Gateway] Failed to load mTLS agent: ${e.message}`); }
    }

    // Health Checks
    setInterval(async () => {
        let changed = false;
        for (const [route, group] of registry.entries()) {
            for (const url of Array.from(group.targets)) {
                try {
                    const start = Date.now();
                    const isHttps = url.startsWith('https:');
                    await axios.get(`${url}/health`, {
                        timeout: 5000,
                        httpsAgent: isHttps ? healthAgent : null,
                        validateStatus: (status) => status < 500 // Accept 4xx as "alive" if path missing
                    });
                    if (!group.metrics) group.metrics = new Map();
                    group.metrics.set(url, { status: 'Healthy', latency: Date.now() - start, failCount: 0 });
                } catch (e) {
                    if (!group.metrics) group.metrics = new Map();
                    const m = group.metrics.get(url) || { failCount: 0 };
                    m.status = 'Failing';
                    m.failCount++;
                    m.lastError = e.message;

                    // Log the first failure to help debugging
                    if (m.failCount === 1) {
                        logger.warn(`[Gateway] Health Check Failed for ${group.name} (${url}): ${e.message}`);
                    }

                    group.metrics.set(url, m);
                    if (m.failCount >= 3) {
                        logger.error(`[Gateway] Service ${group.name} at ${url} EXPIRED. Removing.`);
                        group.targets.delete(url);
                        changed = true;
                    }
                }
            }
        }
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
                            if (info.certInfo.issuer.includes("Let's Encrypt")) info.certInfo.type = 'letsencrypt';
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
                        if (!fs.existsSync(importedDir)) fs.mkdirSync(importedDir, { recursive: true });

                        const keyPath = path.join(importedDir, 'privkey.pem');
                        const certPath = path.join(importedDir, 'fullchain.pem');

                        fs.writeFileSync(keyPath, key);
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
                        if (port) config.gatewayPort = parseInt(port);
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
                https.createServer(internalOptions, internalApp).listen(gatewayInternalPort, '0.0.0.0', () => {
                    logger.info(`[Gateway] [Internal] 🛡️ SECURE mTLS Internal Server on port ${gatewayInternalPort}`);
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
                workerRegistry = new Map(Object.entries(data).map(([k, v]) => [k, { ...v, targets: new Set(v.targets), index: 0 }]));
            }
        } catch (e) { }
    };

    process.on('message', (message) => {
        if (message.type === 'REGISTRY_UPDATE') {
            workerRegistry = new Map(Object.entries(message.registry).map(([k, v]) => [k, { ...v, targets: new Set(v.targets), index: 0 }]));
        }
    });

    loadWorkerRegistry();

    const proxy = httpProxy.createProxyServer({ xfwd: true });

    const MTLS_CA = path.resolve(__dirname, '../certs/cluster-ca.crt');
    const MTLS_KEY = path.resolve(__dirname, '../certs/gateway-internal.key');
    const MTLS_CERT = path.resolve(__dirname, '../certs/gateway-internal.crt');

    let proxyAgent = null;
    if (fs.existsSync(MTLS_CA) && fs.existsSync(MTLS_KEY) && fs.existsSync(MTLS_CERT)) {
        const https = require('https');
        proxyAgent = new https.Agent({
            ca: fs.readFileSync(MTLS_CA),
            key: fs.readFileSync(MTLS_KEY),
            cert: fs.readFileSync(MTLS_CERT),
            rejectUnauthorized: true
        });
        logger.info(`[Gateway] Worker ${process.pid} mTLS ENABLED for upstream.`);
    }

    const requireAuth = (req, res, next) => {
        if ((req.headers['x-gateway-secret'] || req.query.secret) !== GATEWAY_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };

    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
    app.use(compression());

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
                const target = final[group.index % final.length];
                group.index++; return target;
            }
        }
        return null;
    };

    app.use((req, res) => {
        const target = getTarget(req.url);
        if (target) {
            const isHttps = target.startsWith('https:');
            proxy.web(req, res, {
                target,
                agent: isHttps ? proxyAgent : null,
                secure: false,
                timeout: 5000,
                proxyTimeout: 5000
            }, (err) => {
                if (!res.headersSent) {
                    const code = err.code || 'UNKNOWN';
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
        if (res && res.writeHead) {
            if (!res.headersSent) {
                try {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy Error', message: err.message }));
                } catch (e) {
                    logger.error(`[Gateway] Could not send proxy error response: ${e.message}`);
                }
            }
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
            proxy.ws(req, socket, head, { target, agent: proxyAgent }, (err) => {
                logger.error(`[Gateway] WebSocket Error [${target}]: ${err.message}`);
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
