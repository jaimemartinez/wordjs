
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
        const fs = await import('fs');
        const path = await import('path');

        const registerWithGateway = () => {
            // Hostname and port assumption
            const hostname = 'localhost';
            const port = process.env.PORT || '3001';

            // Try to read config
            let gatewaySecret = null;
            try {
                // Warning: We are in .next/server/instrumentation.js potentially
                // or somewhere bundled. __dirname usage is risky in instrumentation.
                // Best to rely on process.cwd()
                const configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');

                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    gatewaySecret = config.gatewaySecret;
                }
            } catch (e) {
                // ignore
            }

            const data = JSON.stringify({
                name: 'frontend',
                url: `http://${hostname}:${port}`,
                routes: ['/']
            });

            const gatewayReq = http.request({
                hostname: 'localhost',
                port: 3000,
                path: '/register',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'x-gateway-secret': process.env.GATEWAY_SECRET || gatewaySecret || 'secure-your-gateway-secret'
                }
            }, (res) => {
                if (res.statusCode === 200) {
                    // console.log('✅ Frontend registered with Gateway');
                }
            });

            gatewayReq.on('error', (e) => {
                // Be silent on errors to avoid log spam if gateway is down during build
            });

            gatewayReq.write(data);
            gatewayReq.end();
        };

        // Fire once on startup
        registerWithGateway();
    }
}
