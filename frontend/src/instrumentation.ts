
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
        const fs = await import('fs');
        const path = await import('path');

        const registerWithGateway = () => {
            // Hostname and port assumption
            const hostname = '127.0.0.1';
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
                        } catch (e) { }
                    }
                }
            } catch (e) { }

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

                gatewayReq.on('error', (e: any) => {
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
