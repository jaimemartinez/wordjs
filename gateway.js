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
    }
} catch (e) {
    // Silent fail for config load
}

const FINAL_PORT = process.env.PORT || configPort;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || configSecret || 'secure-your-gateway-secret';

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    logger.info(`[Gateway] Starting on port ${FINAL_PORT}...`);
    logger.info(`[Gateway] Primary ${process.pid} is running. Spawning ${numCPUs} workers...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

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
                    group.metrics.set(url, { status: 'Healthy', latency });
                } catch (e) {
                    console.warn(`[Gateway] Service ${group.name} at ${url} is UNHEALTHY.`);
                    group.targets.delete(url);
                    changed = true;
                }
            }
        }
        if (changed) {
            saveRegistry();
            broadcastRegistry();
        }
    }, 30000);

    // Listen for workers registration requests
    cluster.on('message', (worker, message) => {
        try {
            if (message.type === 'REGISTER_SERVICE') {
                const { service } = message;
                service.routes.forEach(route => {
                    if (!registry.has(route)) registry.set(route, { name: service.name, targets: new Set(), index: 0, metrics: new Map() });
                    registry.get(route).targets.add(service.url);
                });
                saveRegistry();
                broadcastRegistry();
                logger.info(`[Gateway] [Primary] Service ${service.name} registered: ${service.url}`);
            }
        } catch (e) {
            logger.error(`[Gateway] [Primary] Message Error: ${e.message}`);
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
        timeout: 3600000      // 1 hour
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

    const server = app.listen(FINAL_PORT, () => {
        logger.info(`[Gateway] Worker ${process.pid} listening on port ${FINAL_PORT}`);
    });

    server.on('upgrade', (req, socket, head) => {
        const target = getTarget(req.url);
        if (target) proxy.ws(req, socket, head, { target });
    });

    proxy.on('error', (err, req, res) => {
        logger.error(`[Gateway] [Worker ${process.pid}] Proxy Error: ${err.message}`);
    });

    process.on('SIGTERM', () => {
        logger.info(`[Gateway] Worker ${process.pid} shutting down...`);
        server.close(() => process.exit(0));
    });

} // End of Worker Block

