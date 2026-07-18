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
    const caPath = path.resolve(process.cwd(), 'certs', 'cluster-ca.crt');
    if (fs.existsSync(caPath) && !process.env.NODE_EXTRA_CA_CERTS) {
        process.env.NODE_EXTRA_CA_CERTS = caPath;
        console.log(`🔐 Trusting cluster CA for SSR: ${caPath}`);
    }
    const configPath = path.resolve(process.cwd(), 'wordjs-config.json');
    if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.internalApiUrl && !process.env.INTERNAL_API_URL) process.env.INTERNAL_API_URL = cfg.internalApiUrl;
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
