
export async function register() {
    // Monolith mode: frontend and backend share one process/port and there is no gateway to
    // register with. Without this guard the no-cert fallback targets gatewayPort's default
    // (3000 = the monolith itself), and the retry loop POSTs /register at ourselves every 5s.
    if (process.env.WORDJS_MODE === 'mono') return;
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
        const fs = await import('fs');
        const path = await import('path');

        /**
         * Ask the gateway for the cache-purge secret if this node has cluster identity but no secret.
         * Runs at most once per process, never throws, and says what happened either way — a node it
         * cannot repair simply keeps serving TTL-fresh content, exactly as it does today.
         */
        let purgeSecretChecked = false;
        const recoverPurgeSecret = async () => {
            if (purgeSecretChecked) return;
            purgeSecretChecked = true;
            try {
                const { recoverRevalidateSecret } = await import('@/lib/revalidateSecret');
                const outcome = await recoverRevalidateSecret();
                if (outcome.status === 'recovered') console.log('[Frontend Instrumentation] cache-purge secret recovered from the gateway');
            } catch (e: any) {
                console.warn('[Frontend Instrumentation] purge-secret self-repair failed:', e?.message);
            }
        };

        const registerWithGateway = () => {
            // Advertised host/port the gateway proxies to. Defaults to loopback (co-located), but a
            // frontend on a SEPARATE machine must advertise its routable address via config.advertiseHost
            // (or the host of config.frontendUrl) — otherwise the gateway records 127.0.0.1 and proxies
            // '/' back to its own loopback instead of the real frontend node.
            let hostname = '127.0.0.1';
            let port = '3001';

            // Try to read config
            let gatewaySecret = null;
            let gatewayHost = 'localhost';
            let gatewayInternalPort = 3100;
            let gatewayPort = 3000;

            try {
                // Priority: Local (Distributed) -> Backend (Monolith)
                let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
                if (!fs.existsSync(configPath)) {
                    configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
                }

                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    gatewaySecret = config.gatewaySecret;
                    if (config.gatewayHost) gatewayHost = config.gatewayHost;
                    if (config.gatewayInternalPort) gatewayInternalPort = config.gatewayInternalPort;
                    if (config.gatewayPort) gatewayPort = config.gatewayPort;

                    if (config.frontendUrl) {
                        try {
                            const url = new URL(config.frontendUrl);
                            if (url.port) port = url.port;
                            if (url.hostname) hostname = url.hostname;
                        } catch (e: any) {
                            console.warn('[Frontend Instrumentation] Failed to parse frontendUrl:', e.message);
                        }
                    }
                    // advertiseHost (explicit) wins over the frontendUrl host — this is the routable
                    // address the gateway on another machine uses to reach this frontend.
                    if (config.advertiseHost) hostname = config.advertiseHost;
                }
            } catch (e: any) {
                console.warn('[Frontend Instrumentation] Failed to load/parse wordjs-config.json:', e.message);
            }

            // mTLS Certs Load
            let clientOpts: any = {};
            const certDir = fs.existsSync(path.resolve(process.cwd(), 'certs')) ? path.resolve(process.cwd(), 'certs') : path.resolve(process.cwd(), '../backend/certs');

            const caPath = path.join(certDir, 'cluster-ca.crt');
            const keyPath = path.join(certDir, 'frontend.key');
            const crtPath = path.join(certDir, 'frontend.crt');

            if (fs.existsSync(caPath) && fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
                clientOpts = {
                    ca: fs.readFileSync(caPath),
                    key: fs.readFileSync(keyPath),
                    cert: fs.readFileSync(crtPath),
                    rejectUnauthorized: false // Dev override, though mTLS certs are self-signed by cluster CA
                };
            }

            const data = JSON.stringify({
                name: 'frontend',
                url: `https://${hostname}:${port}`, // Now using HTTPS custom server
                routes: ['/', '/admin', '/login', '/install', '/migration', '/portal', '/_next']
            });

            // exponential backoff: quick retries while the gateway is coming up, 5s steady-state
            let attemptN = 0;
            const retry = () => {
                attemptN++;
                setTimeout(attempt, Math.min(5000, [250, 1000, 2000][attemptN - 1] ?? 5000));
            };
            const attempt = () => {
                const useMtls = Object.keys(clientOpts).length > 0;
                const targetPort = useMtls ? gatewayInternalPort : gatewayPort;
                const targetProtocol = useMtls ? require('https') : http;

                const gatewayReq = targetProtocol.request({
                    hostname: gatewayHost,
                    port: targetPort,
                    path: '/register',
                    method: 'POST',
                    ...clientOpts,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'x-gateway-secret': gatewaySecret || 'secure-your-gateway-secret'
                    }
                }, (res: any) => {
                    if (res.statusCode === 200) {
                        // console.log('✅ Frontend registered with Gateway via ' + (useMtls ? 'mTLS' : 'HTTP'));
                        // Registration proving out means the gateway is up AND this node's cluster
                        // certificate is accepted — the exact moment the missing purge secret can be
                        // asked for. A cluster enrolled before that secret existed has everything but
                        // it, so every purge is refused with 403 forever unless someone remembers to
                        // re-enroll the node. Repair it here instead. See lib/revalidateSecret.ts.
                        void recoverPurgeSecret();
                    } else {
                        retry();
                    }
                });

                gatewayReq.on('error', () => {
                    retry();
                });

                gatewayReq.write(data);
                gatewayReq.end();
            };

            attempt();
        };

        // Start registration loop
        registerWithGateway();
    }
}
