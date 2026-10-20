/**
 * AN HTTPS SPLIT INSTALL: THE FIRST PURGES MUST REACH THE FRONTEND BEFORE ANY RESTART.
 *
 * A split install with the default HTTPS writes `frontendUrl: https://…`, while the frontend that booted
 * before the install keeps the plain-HTTP listener it opened then until it restarts (frontend/server.js
 * chooses once, from the certificates on disk at boot). The purge went to that https:// origin, met
 * cleartext, and a configured https:// origin never downgrades — so every purge failed and the home page
 * changed only when its 60 s ISR window ran out. The co-located frontend is now dialled on loopback at
 * its own port (purgeTransport `local`), and for that loopback target alone the purge may follow the
 * listener the frontend really opened, exactly as the http:// first-install case already did.
 *
 * The layout is an installation: <root>/backend (the backend root and cwd) with <root>/frontend next to
 * it, and the cluster certificates the installer writes under backend/certs.
 *
 * MUTATION PROOF: drop `configuredHttps && local` from deliverDirect's mayRetryCleartext and the first
 * test times out (the TLS attempt fails and nothing retries); return frontendUrl unchanged from the
 * single-host branch of purgeTransport and it times out too (the purge goes to www.example.test).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const x509 = require('../core/x509');

function stubFrontend() {
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            const hit = { url: req.url, secret: req.headers['x-revalidate-secret'], body };
            waiters.splice(0).forEach((w: any) => w(hit));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, next };
}

function certificate(cn: string, keys: any, issuer: any): string {
    return x509.createCertificate({
        subject: [['CN', cn]],
        ...(issuer ? { issuerCertPem: issuer.cert } : {}),
        publicKey: keys.publicKey,
        signingKey: issuer ? issuer.keys.privateKey : keys.privateKey,
        notBefore: new Date(Date.now() - 86400000),
        notAfter: new Date(Date.now() + 86400000),
        ...(issuer ? {} : { ca: true }),
    });
}

describe('an HTTPS split install, before the frontend restarts', () => {
    let root: string;
    let cwd: string;
    let frontend: any;
    let port: number;
    let purgeFrontend: any;

    before(async () => {
        cwd = process.cwd();
        frontend = stubFrontend();
        port = await new Promise<number>((r) => frontend.server.listen(0, '127.0.0.1', () => r(frontend.server.address().port)));

        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-https-install-'));
        const backend = path.join(root, 'backend');
        fs.mkdirSync(path.join(backend, 'certs'), { recursive: true });
        fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
        fs.writeFileSync(path.join(root, 'frontend', 'package.json'), '{"name":"frontend"}');

        const caKeys = x509.generateRsaKeyPair(2048);
        const ca = { keys: caKeys, cert: certificate('WordJS Cluster Root CA', caKeys, null) };
        const leaf = (cn: string) => {
            const keys = x509.generateRsaKeyPair(2048);
            return { key: keys.privateKeyPem, cert: certificate(cn, keys, ca) };
        };
        const certs = path.join(backend, 'certs');
        const fe = leaf('frontend');
        const be = leaf('backend');
        fs.writeFileSync(path.join(certs, 'cluster-ca.crt'), ca.cert);
        fs.writeFileSync(path.join(certs, 'frontend.key'), fe.key);
        fs.writeFileSync(path.join(certs, 'frontend.crt'), fe.cert);
        fs.writeFileSync(path.join(certs, 'backend.key'), be.key);
        fs.writeFileSync(path.join(certs, 'backend.crt'), be.cert);

        // What POST /setup/install writes for a site address of https://www.example.test: the frontend's
        // public origin is the site's own, and frontendPort is where it really listens (here, the stub).
        fs.writeFileSync(path.join(backend, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'https://www.example.test',
            frontendUrl: 'https://www.example.test',
            frontendPort: port,
            revalidateSecret: 'install-secret',
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
        }));
        process.chdir(backend);
        process.env.WORDJS_BACKEND_ROOT = backend;
        ({ purgeFrontend } = require('../core/frontend-purge'));
    });

    after(async () => {
        process.chdir(cwd);
        delete process.env.WORDJS_BACKEND_ROOT;
        await new Promise<void>((r) => frontend.server.close(() => r()));
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('the purge reaches the co-located frontend on loopback, over the listener it actually opened', async () => {
        purgeFrontend(['settings'], ['/']);
        const hit = await frontend.next();
        assert.strictEqual(hit.url, '/api/revalidate');
        assert.strictEqual(hit.secret, 'install-secret');
        assert.deepStrictEqual(JSON.parse(hit.body), { tags: ['settings'], paths: ['/'] });
    });

    test('and the next purge too: nothing was recorded as a permanent misconfiguration', async () => {
        const { purgeFailureState } = require('../core/frontend-purge');
        purgeFrontend(['posts'], ['/hello']);
        const hit = await frontend.next();
        assert.deepStrictEqual(JSON.parse(hit.body), { tags: ['posts'], paths: ['/hello'] });
        const state = purgeFailureState();
        assert.ok(!JSON.stringify(state).includes(`127.0.0.1:${port}`), `no permanent fault for the frontend: ${JSON.stringify(state)}`);
    });
});
