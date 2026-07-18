
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
        const fs = await import('fs');
        const path = await import('path');

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
                    } else {
                        setTimeout(attempt, 5000);
                    }
                });

                gatewayReq.on('error', () => {
                    setTimeout(attempt, 5000);
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
