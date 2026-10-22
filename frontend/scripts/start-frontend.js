const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Load Config
let port = 3001; // Fallback
try {
    // This tree's frontend config, else the SAME install's backend config (split mode keeps one config,
    // in backend/): with only the 3001 fallback, a second install on the host served on the first one's
    // port (QA S3-18).
    let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
    if (!fs.existsSync(configPath)) configPath = path.resolve(process.cwd(), '..', 'backend', 'wordjs-config.json');
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

// What the operator set in the environment before we added anything: a value found here is theirs and is
// never recomputed. Everything else is worked out again before every (re)start of server.js below.
const OPERATOR_ENV = { ...process.env };

/**
 * 2b. The wiring server.js needs, decided from the files on disk NOW:
 *  (a) trust the cluster CA so server-side fetches (SSR) to the gateway's cluster-CA-signed public origin
 *      validate — global fetch/undici would otherwise reject the chain;
 *  (b) the loopback origin of a gateway on this machine, for src/lib/server-api.ts and src/lib/api.ts:
 *      once the install has issued certificates their SSR reads go to it instead of the public address.
 *      Decided here, in plain Node, because those files are bundled and api.ts also runs in the browser.
 * `internalApiUrl` is no longer copied into INTERNAL_API_URL: both readers take it from the config file at
 * every request, so when this node rewrites it (src/lib/edgeSync.ts follows the gateway's address and TLS
 * switch) the next read already uses it. The copy in the environment froze it for the process's life.
 */
function prepareEnv() {
    const env = { ...OPERATOR_ENV, NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT };
    try {
        // Trust the cluster CA for SSR (falling back to backend/certs for LOCAL split, where the install writes
        // the CA there rather than frontend/certs, mirroring server.js) — plus, on one machine, the certificate
        // the gateway next to us serves on its public port, which SSR goes through (scripts/ssr-trust.js).
        if (!OPERATOR_ENV.NODE_EXTRA_CA_CERTS) {
            const { buildSsrTrust, waitForGatewayAutoCert, writeTrustBundle } = require('./ssr-trust');
            waitForGatewayAutoCert({ cwd: process.cwd() });
            const files = buildSsrTrust({ cwd: process.cwd() });
            const bundle = writeTrustBundle(files, path.resolve(process.cwd(), '.next', 'ssr-trust.pem'));
            if (bundle) {
                env.NODE_EXTRA_CA_CERTS = bundle;
                console.log(`🔐 Trusting for SSR: ${files.join(', ')}`);
            }
        }
        if (!OPERATOR_ENV.WORDJS_LOCAL_GATEWAY_ORIGIN) {
            const { localGatewayOrigin } = require('../local-gateway');
            let dir = process.cwd();
            if (!fs.existsSync(path.join(dir, 'wordjs-config.json'))) dir = path.resolve(dir, '..', 'backend');
            let cfg = {};
            try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8')); } catch { /* none yet */ }
            const origin = localGatewayOrigin(dir, cfg);
            if (origin) env.WORDJS_LOCAL_GATEWAY_ORIGIN = origin;
            // Worked out here, so server.js watches the gateway next door and asks to be started again
            // when its protocol or certificate changes (local-gateway.js localGatewaySignature).
            env.WORDJS_LOCAL_GATEWAY_WATCH = '1';
        }
    } catch (e) { /* best-effort */ }
    return env;
}

// server.js exits with this code to be started again with freshly prepared wiring: the gateway next to it
// changed its protocol or certificate (Admin → Security), which the trust bundle and the loopback origin
// above are derived from. Same convention as the backend's restart from the panel (core/restart).
const RESTART_EXIT_CODE = 75;

console.log(`🚀 Starting Autonomous Frontend in ${process.env.NODE_ENV} mode on port ${port}...`);

// 3. Spawn Custom Server
function startServer() {
    const server = spawn('node', ['server.js'], {
        stdio: 'inherit',
        shell: true,
        env: prepareEnv(),
    });

    server.on('close', (code) => {
        if (code === RESTART_EXIT_CODE) {
            console.log('🔄 The gateway next to this frontend changed its protocol or certificate: restarting with the new wiring...');
            setTimeout(startServer, 500);
            return;
        }
        process.exit(code);
    });
}
startServer();
