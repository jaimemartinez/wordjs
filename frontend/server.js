const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// Configuration for mTLS. SEPARATE mode: node-join writes the frontend's cert to frontend/certs. LOCAL
// split (one machine): the install generates all service certs into backend/certs — so fall back there
// when frontend/certs hasn't been provisioned. Without this the frontend serves plain HTTP while it still
// registers itself as https:// with the gateway → the gateway's HTTPS proxy fails (EPROTO) → 502.
const localCertDir = path.resolve(process.cwd(), 'certs');
const beCertDir = path.resolve(process.cwd(), '..', 'backend', 'certs');
const certDir = fs.existsSync(path.join(localCertDir, 'frontend.crt')) ? localCertDir : beCertDir;
const caPath = path.join(certDir, 'cluster-ca.crt');
const keyPath = path.join(certDir, 'frontend.key');
const certPath = path.join(certDir, 'frontend.crt');

const port = process.env.PORT || 3001;

app.prepare().then(() => {
    let httpsOptions = null;

    if (fs.existsSync(caPath) && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ca: fs.readFileSync(caPath),
            requestCert: true,
            rejectUnauthorized: true // ENFORCE mTLS (Only Gateway/Setup should have certs)
        };
        console.log('🛡️  Frontend starting with mTLS enabled.');
    } else {
        console.warn('⚠️  Frontend mTLS certs missing. Starting in HTTP fallback mode.');
    }

    if (httpsOptions) {
        createServer(httpsOptions, (req, res) => {
            const parsedUrl = parse(req.url, true);

            // Log verified identity (mTLS check)
            const cert = req.socket.getPeerCertificate();
            if (cert && cert.subject) {
                // CN should be 'gateway-internal' for requests coming from the gateway
                // console.log(`[Frontend] [mTLS] Verified Identity: ${cert.subject.CN}`);
            }

            handle(req, res, parsedUrl);
        }).listen(port, (err) => {
            if (err) throw err;
            console.log(`> Ready on https://localhost:${port} (mTLS)`);
        });
    } else {
        // Fallback to HTTP for safety if certs are gone
        const { createServer: createHttpServer } = require('http');
        createHttpServer((req, res) => {
            const parsedUrl = parse(req.url, true);
            handle(req, res, parsedUrl);
        }).listen(port, (err) => {
            if (err) throw err;
            console.log(`> Ready on http://localhost:${port} (HTTP Fallback)`);
        });
    }
});
