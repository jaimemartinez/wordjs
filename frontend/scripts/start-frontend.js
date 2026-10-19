const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Load Config
let port = 3001; // Fallback
try {
    const configPath = path.resolve(process.cwd(), 'wordjs-config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.frontendPort) {
            port = config.frontendPort;
        } else if (config.frontendUrl) {
            try {
                const url = new URL(config.frontendUrl);
                if (url.port) port = parseInt(url.port);
            } catch (e) { }
        }
    }
} catch (e) {
    console.error('⚠️ Could not read wordjs-config.json for port detection, using default 3001');
}

// 2. Determine mode
const isProd = process.argv[2] === 'prod';
process.env.NODE_ENV = isProd ? 'production' : 'development';
process.env.PORT = port.toString();

// 2b. Separate-machine wiring: (a) trust the cluster CA so server-side fetches (SSR) to the gateway's
// cluster-CA-signed public origin validate — global fetch/undici would otherwise reject the chain; and
// (b) surface internalApiUrl as INTERNAL_API_URL for any code that reads the env rather than the config.
try {
    // Trust the cluster CA for SSR (falling back to backend/certs for LOCAL split, where the install writes
    // the CA there rather than frontend/certs, mirroring server.js) — plus, on one machine, the certificate
    // the gateway next to us serves on its public port, which SSR goes through (scripts/ssr-trust.js).
    if (!process.env.NODE_EXTRA_CA_CERTS) {
        const { buildSsrTrust, waitForGatewayAutoCert, writeTrustBundle } = require('./ssr-trust');
        waitForGatewayAutoCert({ cwd: process.cwd() });
        const files = buildSsrTrust({ cwd: process.cwd() });
        const bundle = writeTrustBundle(files, path.resolve(process.cwd(), '.next', 'ssr-trust.pem'));
        if (bundle) {
            process.env.NODE_EXTRA_CA_CERTS = bundle;
            console.log(`🔐 Trusting for SSR: ${files.join(', ')}`);
        }
    }
    const configPath = path.resolve(process.cwd(), 'wordjs-config.json');
    if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.internalApiUrl && !process.env.INTERNAL_API_URL) process.env.INTERNAL_API_URL = cfg.internalApiUrl;
    }
    // (c) the loopback origin of a gateway on this machine, for src/lib/server-api.ts and src/lib/api.ts:
    // once the install has issued certificates their SSR reads go to it instead of the public address.
    // Decided here, in plain Node, because those files are bundled and api.ts also runs in the browser.
    if (!process.env.WORDJS_LOCAL_GATEWAY_ORIGIN) {
        const { localGatewayOrigin } = require('../local-gateway');
        let dir = process.cwd();
        if (!fs.existsSync(path.join(dir, 'wordjs-config.json'))) dir = path.resolve(dir, '..', 'backend');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8')); } catch { /* none yet */ }
        const origin = localGatewayOrigin(dir, cfg);
        if (origin) process.env.WORDJS_LOCAL_GATEWAY_ORIGIN = origin;
    }
} catch (e) { /* best-effort */ }

console.log(`🚀 Starting Autonomous Frontend in ${process.env.NODE_ENV} mode on port ${port}...`);

// 3. Spawn Custom Server
const server = spawn('node', ['server.js'], {
    stdio: 'inherit',
    shell: true
});

server.on('close', (code) => {
    process.exit(code);
});
