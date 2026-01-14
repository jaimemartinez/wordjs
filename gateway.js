require('dotenv').config();
const express = require('express');
const httpProxy = require('http-proxy');
const rateLimit = require('express-rate-limit');

const fs = require('fs');
const path = require('path');
const app = express();

// Try to load secret and port from config file first
let configSecret = null;
let configPort = 3000;

try {
    const configPath = path.resolve('backend/wordjs-config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configSecret = config.gatewaySecret;
        if (config.gatewayPort) configPort = config.gatewayPort;
    }
} catch (e) {
    console.warn('[Gateway] Could not read wordjs-config.json');
}

const FINAL_PORT = process.env.PORT || configPort;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || configSecret || 'secure-your-gateway-secret';

// Parse JSON bodies for registration
app.use(express.json());

// Proxy server
const proxy = httpProxy.createProxyServer({});

// Service Registry
// Map<pathPrefix, targetUrl>
const registry = new Map();

// Authentication Middleware
const requireAuth = (req, res, next) => {
    const token = req.headers['x-gateway-secret'];
    if (token !== GATEWAY_SECRET) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing Gateway Secret' });
    }
    next();
};

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' }
});

// Apply rate limiting to all requests
app.use(limiter);

// 1. Service Registration Endpoint
app.post('/register', requireAuth, (req, res) => {
    const service = req.body;
    // { name: 'backend', url: 'http://localhost:4000', routes: ['/api', '/uploads'] }

    if (service.routes && service.url) {
        service.routes.forEach(route => {
            registry.set(route, service.url);
            console.log(`[Gateway] Registered route: ${route} -> ${service.url} (${service.name})`);
        });
        res.json({ success: true, message: 'Service registered' });
    } else {
        res.status(400).send('Invalid service registration data');
    }
});

// Helper to find target
function getTarget(url) {
    const entries = Array.from(registry.entries()).sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, target] of entries) {
        if (url.startsWith(prefix)) {
            return target;
        }
    }
    return null;
}

// 2. Proxy Logic for all other routes
app.use((req, res) => {
    const target = getTarget(req.url);
    if (target) {
        // Debug Log
        console.log(`[Gateway] Proxying: ${req.method} ${req.url} -> ${target}`);

        proxy.web(req, res, { target }, (err) => {
            console.error(`[Gateway] Proxy error: ${err.message}`);
            if (!res.headersSent) {
                res.status(502).send('Bad Gateway');
            }
        });
    } else {
        res.status(404).send('No service registered for this route. Waiting for services...');
    }
});

app.listen(FINAL_PORT, () => {
    console.log(`[Gateway] Express Server starting on port ${FINAL_PORT}...`);
    console.log(`[Gateway] Secret protection enabled.`);
});

// Proxy error handling
proxy.on('error', (err, req, res) => {
    console.error('[Gateway] Proxy Error:', err);
});
