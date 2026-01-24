
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
        const fs = await import('fs');
        const path = await import('path');

        const registerWithGateway = () => {
            // Hostname and port assumption
            const hostname = 'localhost';
            let port = '3001';

            // Try to read config
            let gatewaySecret = null;
            try {
                const configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    gatewaySecret = config.gatewaySecret;

                    if (config.frontendUrl) {
                        try {
                            const url = new URL(config.frontendUrl);
                            // Only use the port if explicitly set in the URL
                            if (url.port) {
                                port = url.port;
                            }
                        } catch (e) { }
                    }
                }
            } catch (e) {
                // ignore
            }

            const data = JSON.stringify({
                name: 'frontend',
                url: `http://${hostname}:${port}`,
                routes: ['/']
            });

            const attempt = () => {
                const gatewayReq = http.request({
                    hostname: 'localhost',
                    port: 3000,
                    path: '/register',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'x-gateway-secret': gatewaySecret || 'secure-your-gateway-secret'
                    }
                }, (res) => {
                    if (res.statusCode === 200) {
                        // console.log('✅ Frontend registered with Gateway');
                    } else {
                        // Retry on non-200 status
                        setTimeout(attempt, 5000);
                    }
                });

                gatewayReq.on('error', (e) => {
                    // Retry on connection error
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
