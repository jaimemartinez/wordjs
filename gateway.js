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
const REGISTRY_FILE = path.resolve('gateway-registry.json');
const REGISTRY_TEMP = path.resolve('gateway-registry.json.tmp');

// Load config for both Primary and Workers
let configSecret = null;
let configPort = 3000;

try {
    const configPath = path.resolve('backend/wordjs-config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configSecret = config.gatewaySecret;
        if (config.gatewayPort) configPort = parseInt(config.gatewayPort);

        // SSL Configuration
        // SSL Configuration
        if (config.ssl) {
            if (config.ssl === true || (config.ssl.enabled !== false)) {
                if (config.ssl.key && config.ssl.cert) {
                    global.sslOptions = {
                        key: config.ssl.key,
                        cert: config.ssl.cert
                    };
                } else {
                    // Auto-Generate Self-Signed if explicitly enabled but no files provided
                    config.sslAuto = true;
                }
            }
        }
    }
} catch (e) {
    // Silent fail for config load
}

const FINAL_PORT = configPort;

// SECURITY: Require proper secret in production
const rawSecret = configSecret;
if (!rawSecret && process.env.NODE_ENV === 'production') {
    logger.error('⛔ CRITICAL: gatewaySecret must be set in wordjs-config.json for production!');
    process.exit(1);
}
const GATEWAY_SECRET = rawSecret || 'secure-your-gateway-secret'; // Dev fallback only

// --- SSL AUTO-GENERATION (Primary Process Only) ---
const SSL_AUTO_KEY = path.resolve('ssl-auto.key');
const SSL_AUTO_CERT = path.resolve('ssl-auto.crt');

async function ensureSSLCerts(config) {
    if (config && (config.ssl === true || (config.ssl && !config.ssl.key))) {
        if (fs.existsSync(SSL_AUTO_KEY) && fs.existsSync(SSL_AUTO_CERT)) {
            return; // Exists
        }
        try {
            // Use 5.5.0 which returns Promise
            const selfsigned = require('selfsigned');
            logger.info('[Gateway] Generating self-signed SSL certificate...');
            // Note: in 5.5.0 generate is async
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

    // Ensure SSL before forking
    let loadedConfig = {};
    try {
        if (fs.existsSync(path.resolve('backend/wordjs-config.json'))) {
            loadedConfig = JSON.parse(fs.readFileSync(path.resolve('backend/wordjs-config.json'), 'utf8'));
        }
    } catch (e) { }

    // We need to wait for SSL gen, so we wrap in async immediately
    (async () => {
        await ensureSSLCerts(loadedConfig);

        logger.info(`[Gateway] Primary ${process.pid} is running. Spawning ${numCPUs} workers...`);

        for (let i = 0; i < numCPUs; i++) {
            cluster.fork();
        }
    })();

    cluster.on('exit', (worker, code, signal) => {
        logger.error(`[Gateway] Worker ${worker.process.pid} died. Respawning...`);
        cluster.fork();
    });

    // Primary only logic (Registry persistence & Health Checks)
    // Map<pathPrefix, { name, targets: Set<url>, index: number, metrics: Map<url, { latency: number[], lastError: string }> }>
    let registry = new Map();

    const saveRegistry = () => {
        try {
            const data = {};
            registry.forEach((value, key) => {
                data[key] = { name: value.name, targets: Array.from(value.targets) };
            });
            // Atomic Write
            fs.writeFileSync(REGISTRY_TEMP, JSON.stringify(data, null, 2));
            fs.renameSync(REGISTRY_TEMP, REGISTRY_FILE);
        } catch (e) {
            logger.error(`[Gateway] Failed to save registry atomicly: ${e.message}`);
        }
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

    // Broadcast registry updates to workers
    const broadcastRegistry = () => {
        try {
            const data = {};
            registry.forEach((v, k) => {
                const metricsObj = {};
                if (v.metrics) {
                    v.metrics.forEach((m, url) => { metricsObj[url] = m; });
                }
                data[k] = { name: v.name, targets: Array.from(v.targets), metrics: metricsObj };
            });
            for (const id in cluster.workers) {
                cluster.workers[id].send({ type: 'REGISTRY_UPDATE', registry: data });
            }
        } catch (e) {
            logger.error(`[Gateway] [Primary] Broadcast Error: ${e.message}`);
        }
    };

    // Health Check Loop
    setInterval(async () => {
        let changed = false;
        for (const [route, group] of registry.entries()) {
            for (const url of Array.from(group.targets)) {
                try {
                    const start = Date.now();
                    await axios.get(`${url}/health`, { timeout: 5000 });
                    const latency = Date.now() - start;

                    // Track latency (simplistic P99/Avg could go here)
                    if (!group.metrics) group.metrics = new Map();
                    group.metrics.set(url, { status: 'Healthy', latency, failCount: 0 });
                } catch (e) {
                    if (!group.metrics) group.metrics = new Map();
                    const m = group.metrics.get(url) || { failCount: 0 };
                    m.status = 'Failing';
                    m.failCount = (m.failCount || 0) + 1;
                    m.lastError = e.message;
                    group.metrics.set(url, m);

                    console.warn(`[Gateway] Service ${group.name} at ${url} is UNHEALTHY (${m.failCount}/3).`);

                    if (m.failCount >= 3) {
                        logger.error(`[Gateway] Service ${group.name} at ${url} EXPIRED after 3 failures. Removing.`);
                        group.targets.delete(url);
                        changed = true;
                    }
                }
            }
        }
        if (changed || true) { // Always broadcast metrics updates to workers
            saveRegistry();
            broadcastRegistry();
        }
    }, 30000);

    // Listen for workers registration requests
    cluster.on('message', (worker, message) => {
        try {
            if (message.type === 'REGISTER_SERVICE') {
                const { service } = message;

                // FIRST: Remove this service URL from ALL routes (clean old registrations)
                registry.forEach((group, route) => {
                    if (group.targets.has(service.url)) {
                        group.targets.delete(service.url);
                        // If no targets left, remove the route entirely
                        if (group.targets.size === 0) {
                            registry.delete(route);
                        }
                    }
                });

                // THEN: Add to the new routes
                service.routes.forEach(route => {
                    if (!registry.has(route)) registry.set(route, { name: service.name, targets: new Set(), index: 0, metrics: new Map() });
                    registry.get(route).targets.add(service.url);
                });

                saveRegistry();
                broadcastRegistry();
                logger.info(`[Gateway] [Primary] Service ${service.name} registered: ${service.url} for routes: ${service.routes.join(', ')}`);
            }
        } catch (e) {
            logger.error(`[Gateway] [Primary] Message Error: ${e.message}`);
        }
    });

    // Handle Restart Request
    cluster.on('message', (worker, message) => {
        if (message.type === 'RESTART_GATEWAY') {
            logger.info('[Gateway] 🔄 Restarting all workers to reload configuration/SSL...');
            for (const id in cluster.workers) {
                cluster.workers[id].kill();
            }
        }
    });

    // Initial Broadcast
    broadcastRegistry();

} else {
    // WORKER PROCESS
    const app = express();
    let workerRegistry = new Map();

    process.on('message', (message) => {
        if (message.type === 'REGISTRY_UPDATE') {
            workerRegistry = new Map(Object.entries(message.registry).map(([k, v]) => [k, { ...v, targets: new Set(v.targets), index: 0 }]));
        }
    });


    // Registry persistence removed from here as it's now at top level

    const jsonParser = express.json({ limit: '10mb' }); // Payload Protection
    const proxy = httpProxy.createProxyServer({
        proxyTimeout: 3600000, // 1 hour (for SSE/Long Polling)
        timeout: 3600000,      // 1 hour
        xfwd: true             // Add X-Forwarded-x headers
    });

    // Auth Middleware (Supports Header or Query Param for Browser)
    const requireAuth = (req, res, next) => {
        const token = req.headers['x-gateway-secret'] || req.query.secret;
        if (token !== GATEWAY_SECRET) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing Gateway Secret' });
        }
        next();
    };

    // Middlewares
    app.use(helmet({
        contentSecurityPolicy: false, // Strict CSP breaks Next.js/Turbopack inline scripts in dev mode
    }));
    app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } })); // Log to Winston
    app.use(compression({
        filter: (req, res) => {
            if (req.headers['accept'] === 'text/event-stream' || res.getHeader('Content-Type') === 'text/event-stream') {
                return false; // Don't compress SSE
            }
            return compression.filter(req, res);
        }
    }));

    app.use((req, res, next) => {
        req.correlationId = req.headers['x-correlation-id'] || uuidv4();
        res.setHeader('x-correlation-id', req.correlationId);
        next();
    });

    // 1. ADVANCED STATUS DASHBOARD (Protected)
    app.get('/gateway-status', requireAuth, (req, res) => {
        let html = `<html><head><title>Gateway Monitor</title><style>
            body { font-family: 'Segoe UI', sans-serif; padding: 30px; background: #0f172a; color: #f8fafc; }
            .service { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
            .grid { display: grid; gap: 15px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); margin-top: 15px; }
            .target { background: #334155; padding: 12px; border-radius: 8px; font-size: 13px; border-left: 4px solid #475569; }
            .badge { font-size: 10px; padding: 2px 8px; border-radius: 99px; text-transform: uppercase; font-weight: bold; }
            .Healthy { border-left-color: #10b981; } .Healthy .badge { background: #065f46; }
            .Degraded { border-left-color: #f59e0b; } .Degraded .badge { background: #92400e; }
            .Failing { border-left-color: #ef4444; } .Failing .badge { background: #991b1b; }
            h1 { font-weight: 300; margin-bottom: 30px; border-bottom: 1px solid #334155; padding-bottom: 10px; }
        </style></head><body>
        <h1>🌐 WordJS Gateway <small style="font-size: 14px; opacity: 0.5;">Worker ${process.pid} - Ultra-Hardened</small></h1><div id="services">`;

        workerRegistry.forEach((group, prefix) => {
            html += `<div class="service"><h3>${group.name} <small style="opacity: 0.5;">(${prefix})</small></h3><div class="grid">`;
            const targets = Array.from(group.targets);
            const metrics = group.metrics || {};

            targets.forEach(url => {
                const m = metrics[url] || { status: 'Healthy', latency: 0 };
                html += `<div class="target ${m.status}">
                    <span class="badge">${m.status}</span><br/>
                    <strong>${url}</strong><br/>
                    <small>Latency: ${m.latency}ms</small>
                </div>`;
            });
            html += `</div></div>`;
        });
        res.send(html + '</div></body></html>');
    });

    // 2. Registration (Relay to Primary)
    app.post('/register', jsonParser, requireAuth, (req, res) => {
        if (req.body.routes && req.body.url) {
            process.send({ type: 'REGISTER_SERVICE', service: req.body });
            res.json({ success: true, message: 'Relayed to primary' });
        } else {
            res.status(400).send('Invalid data');
        }
    });

    // 3. Restart (Relay to Primary) - Used for SSL Reloads
    app.post('/restart', requireAuth, (req, res) => {
        process.send({ type: 'RESTART_GATEWAY' });
        res.json({ success: true, message: 'Gateway restart initiated...' });
    });

    const getTarget = (url) => {
        const entries = Array.from(workerRegistry.entries()).sort((a, b) => b[0].length - a[0].length);
        for (const [prefix, group] of entries) {
            if (url.startsWith(prefix)) {
                const targets = Array.from(group.targets);
                // CIRCUIT BREAKER: Filter out failing targets
                const healthy = targets.filter(t => !group.metrics || group.metrics[t]?.status !== 'Failing');
                const finalTargets = healthy.length > 0 ? healthy : targets;
                const target = finalTargets[group.index % finalTargets.length];
                group.index++;
                return target;
            }
        }
        return null;
    };

    // 3. Proxy
    app.use((req, res) => {
        const target = getTarget(req.url);
        if (target) {
            proxy.web(req, res, { target, headers: { 'x-correlation-id': req.correlationId } }, (err) => {
                if (!res.headersSent) res.status(502).json({ error: 'Upstream Timeout or Error', correlationId: req.correlationId });
            });
        } else {
            res.status(404).json({ error: 'Service Not Found' });
        }
    });




    // Auto-Generate SSL logic removed from Worker. Handled by Primary.
    if (fs.existsSync(SSL_AUTO_KEY) && fs.existsSync(SSL_AUTO_CERT)) {
        // If config enables it but no paths, use auto
        if (fs.existsSync('backend/wordjs-config.json')) {
            try {
                const c = JSON.parse(fs.readFileSync('backend/wordjs-config.json', 'utf8'));
                // Check if SSL is explicitly disabled
                if (c.ssl && c.ssl.enabled === false) {
                    // Do not enable SSL
                } else if (c.ssl === true || (c.ssl && !c.ssl.key)) {
                    global.sslOptions = { key: SSL_AUTO_KEY, cert: SSL_AUTO_CERT };
                }
            } catch (e) { }
        }
    }

    let server;
    const startServer = () => {
        if (global.sslOptions) {
            try {
                const https = require('https');

                // Check if we have explicit paths or content
                let keyContent, certContent;

                if (global.sslOptions.keyContent && global.sslOptions.certContent) {
                    keyContent = global.sslOptions.keyContent;
                    certContent = global.sslOptions.certContent;
                } else {
                    const keyPath = path.resolve(global.sslOptions.key);
                    const certPath = path.resolve(global.sslOptions.cert);
                    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                        keyContent = fs.readFileSync(keyPath);
                        certContent = fs.readFileSync(certPath);
                    }
                }

                if (keyContent && certContent) {
                    const httpsOptions = { key: keyContent, cert: certContent };
                    server = https.createServer(httpsOptions, app).listen(FINAL_PORT, () => {
                        logger.info(`[Gateway] Worker ${process.pid} listening on port ${FINAL_PORT} (HTTPS)`);
                    });
                } else {
                    logger.error(`[Gateway] SSL files missing. Falling back to HTTP.`);
                    server = app.listen(FINAL_PORT, () => {
                        logger.info(`[Gateway] Worker ${process.pid} listening on port ${FINAL_PORT} (HTTP - SSL FALLBACK)`);
                    });
                }
            } catch (e) {
                logger.error(`[Gateway] SSL Init Error: ${e.message}. Falling back to HTTP.`);
                server = app.listen(FINAL_PORT, () => {
                    logger.info(`[Gateway] Worker ${process.pid} listening on port ${FINAL_PORT} (HTTP - SSL ERROR)`);
                });
            }
        } else {
            server = app.listen(FINAL_PORT, () => {
                logger.info(`[Gateway] Worker ${process.pid} listening on port ${FINAL_PORT} (HTTP)`);
            });
        }

        if (server) {
            server.on('upgrade', (req, socket, head) => {
                const target = getTarget(req.url);
                if (target) proxy.ws(req, socket, head, { target });
            });

            server.on('error', (err) => logger.error(`[Gateway] Server Error: ${err.message}`));
        }
    };

    startServer();

    proxy.on('error', (err, req, res) => {
        logger.error(`[Gateway] [Worker ${process.pid}] Proxy Error: ${err.message}`);
    });

    process.on('SIGTERM', () => {
        logger.info(`[Gateway] Worker ${process.pid} shutting down...`);
        server.close(() => process.exit(0));
    });

} // End of Worker Block

