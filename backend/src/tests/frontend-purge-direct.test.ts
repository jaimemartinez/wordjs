/**
 * NO REGRESSION on the DIRECT purge path (monolith + single-host split).
 *
 * The cross-machine work rerouted CLUSTER purges through the gateway. The two deployments that already
 * worked must keep working EXACTLY as before — a publish on a monolith or a co-located split has to
 * reach the frontend's /api/revalidate immediately, with the shared secret, without a gateway hop.
 *
 * This drives the real module end to end: the content hook's entry point (purgeFrontend), the 1.5 s
 * debounce, the transport choice, and a genuine HTTP request into a stub frontend — no mocked sockets.
 *
 * WHAT THIS FILE USED TO CERTIFY, AND DIDN'T (audit 2026-08-18 #27). Every stub here listened on
 * PLAIN HTTP, under a title claiming "no regression on the direct path". The real single-host split
 * does not: frontend/server.js starts with `requestCert: true, rejectUnauthorized: true` the moment
 * the certificates the installer itself generates exist — i.e. on every boot after installation — and
 * the direct transport attached neither `key` nor `cert`, so the handshake was aborted and on-demand
 * purging was DEAD in that mode, with at most one warning per hour to show for it. A green suite over
 * a transport shape the deployment never uses is the fixture-vs-producer trap. The mTLS section at the
 * bottom closes it: a real TLS listener that DEMANDS a client certificate, and a stored `frontendUrl`
 * that deliberately says `http://` so the derived-from-the-listener rule is proven too.
 *
 * MUTATION PROOF: make purgeTransport return the gateway branch unconditionally and every test here
 * times out (nothing arrives at either stub). Drop the `x-revalidate-secret` header and the first test
 * fails. Delete the monolith branch and the last test's purge lands on the dead split URL instead.
 * Remove `key`/`cert` from clusterTlsOptions — the exact pre-fix shape — and the mTLS test times out.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const forge = require('node-forge');

// A stub frontend that resolves as soon as it is purged.
function stubFrontend() {
    const received: any[] = [];
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            const hit = { url: req.url, method: req.method, secret: req.headers['x-revalidate-secret'], body };
            received.push(hit);
            waiters.splice(0).forEach((w: any) => w(hit));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    // Always waits for the NEXT arrival (never resolves with one already seen), so a test can assert
    // "exactly one more request" after a burst.
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, received, next };
}
const listen = (server: any) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server: any) => new Promise<void>((r) => (server ? server.close(() => r()) : r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Cluster certificates, generated the way the installer does (node-forge, cluster CA + service
//     leaves whose CN is the ROLE). They are INPUT to the module under test, not a stand-in for it.
function makeCA() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'WordJS Cluster Root CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(ca: any, cn: string) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1000);
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.sign(ca.keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

describe('direct purge — monolith and single-host split reach the frontend as before', () => {
    let dir: string;
    let cwd: string;
    let split: any;      // the co-located frontend named by config.frontendUrl
    let mono: any;       // the in-process Next server a monolith answers on (process.env.PORT)
    let monoPort: number;
    let purgeFrontend: any;
    let clusterTlsOptions: any;
    let frontendServesTls: any;
    let tlsServer: any;      // a frontend that ENFORCES mTLS, like frontend/server.js after install

    before(async () => {
        cwd = process.cwd();
        split = stubFrontend();
        mono = stubFrontend();
        const splitPort = await listen(split.server);
        monoPort = await listen(mono.server);

        // A site config exactly like a single-host split: co-located frontend, no cluster enrollment.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-direct-'));
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${splitPort}`,
            revalidateSecret: 'lab-secret',
        }));
        // configManager resolves its config path from the cwd at load time, so move first and require
        // the module under test only afterwards.
        process.chdir(dir);
        // The certificates below are read relative to the INSTALLATION root, not to the cwd (that is
        // the point of BACKEND_ROOT: the answer must not depend on how the process was launched).
        // This temp tree is the installation for this test, so say so before requiring the module.
        process.env.WORDJS_BACKEND_ROOT = dir;
        ({ purgeFrontend, clusterTlsOptions, frontendServesTls } = require('../core/frontend-purge'));
    });

    after(async () => {
        process.chdir(cwd);
        await close(split.server);
        await close(mono.server);
        await close(tlsServer);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('a content change reaches the co-located frontend, authenticated, within the debounce window', async () => {
        purgeFrontend(['posts', 'post:hello'], ['/', '/hello']);
        const hit = await split.next();
        assert.strictEqual(hit.url, '/api/revalidate');
        assert.strictEqual(hit.method, 'POST');
        assert.strictEqual(hit.secret, 'lab-secret', 'the shared secret still authenticates the purge');
        assert.deepStrictEqual(JSON.parse(hit.body), { tags: ['posts', 'post:hello'], paths: ['/', '/hello'] });
    });

    test('bursts are coalesced: 50 queued changes still produce ONE request', async () => {
        const seen = split.received.length;
        for (let i = 0; i < 50; i++) purgeFrontend([`post:${i}`], [`/p${i}`]);
        await split.next();
        await new Promise((r) => setTimeout(r, 400));
        assert.strictEqual(split.received.length, seen + 1, 'the 1.5s debounce still coalesces');
    });

    test('monolith purges its OWN port, ignoring the split-mode frontendUrl', async () => {
        const seenSplit = split.received.length;
        const prevMode = process.env.WORDJS_MODE;
        const prevPort = process.env.PORT;
        process.env.WORDJS_MODE = 'mono';
        process.env.PORT = String(monoPort);
        try {
            purgeFrontend(['settings'], ['/']);
            const hit = await mono.next();
            assert.strictEqual(hit.url, '/api/revalidate');
            assert.ok(hit.secret, 'the monolith still authenticates its own purge');
            assert.strictEqual(split.received.length, seenSplit, 'nothing went to the split-mode address');
        } finally {
            if (prevMode === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = prevMode;
            if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
        }
    });

    // ====================================================================================
    // THE SPLIT AS IT ACTUALLY BOOTS: the frontend ENFORCES mTLS (audit #27)
    //
    // Runs last on purpose: it writes the cluster certificates into this temp root, which is what
    // flips frontendServesTls() to true for every purge afterwards — exactly the transition a real
    // site makes the first time it is installed.
    // ====================================================================================

    test('the frontend that demands a client certificate RECEIVES the purge — key and cert included', async () => {
        const ca = makeCA();
        const frontendLeaf = makeLeaf(ca, 'frontend');
        const backendLeaf = makeLeaf(ca, 'backend');

        // The layout routes/setup.ts writes for a non-enrolled install: everything under backend/certs.
        const certsDir = path.join(dir, 'certs');
        fs.mkdirSync(certsDir, { recursive: true });
        fs.writeFileSync(path.join(certsDir, 'cluster-ca.crt'), ca.pem);
        fs.writeFileSync(path.join(certsDir, 'frontend.key'), frontendLeaf.key);
        fs.writeFileSync(path.join(certsDir, 'frontend.crt'), frontendLeaf.cert);
        fs.writeFileSync(path.join(certsDir, 'backend.key'), backendLeaf.key);
        fs.writeFileSync(path.join(certsDir, 'backend.crt'), backendLeaf.cert);

        // FIRST INSTALL, BEFORE ANY RESTART: server.js selected HTTP while these files did not exist;
        // creating them does not hot-swap its live listener. The purge first infers TLS from disk, sees
        // OpenSSL's exact wrong-protocol error, and must retry the explicitly configured http:// origin.
        // This is the state exercised by scripts/smoke-deploy.sh immediately after setup returns 200.
        assert.strictEqual(frontendServesTls(), true, 'the newly written certs make the next boot TLS');
        purgeFrontend(['settings'], ['/']);
        const firstInstallHit = await split.next();
        assert.strictEqual(firstInstallHit.url, '/api/revalidate');
        assert.strictEqual(firstInstallHit.secret, 'lab-secret');
        assert.deepStrictEqual(JSON.parse(firstInstallHit.body), { tags: ['settings'], paths: ['/'] });

        // frontend/server.js, reduced to what matters here: TLS + REQUEST A CLIENT CERT + refuse the
        // connection without one. The old direct transport died right here, before any HTTP was spoken.
        const received: any[] = [];
        let arrived: any;
        const waitForPurge = new Promise<any>((resolve, reject) => {
            arrived = resolve;
            setTimeout(() => reject(new Error('no purge arrived over TLS within 12s')), 12000);
        });
        tlsServer = https.createServer({
            key: frontendLeaf.key,
            cert: frontendLeaf.cert,
            ca: ca.pem,
            requestCert: true,
            rejectUnauthorized: true,
        }, (req: any, res: any) => {
            let body = '';
            req.on('data', (c: any) => (body += c));
            req.on('end', () => {
                const peer = req.socket.getPeerCertificate();
                const hit = {
                    url: req.url,
                    method: req.method,
                    secret: req.headers['x-revalidate-secret'],
                    peerCn: peer && peer.subject && peer.subject.CN,
                    body,
                };
                received.push(hit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"revalidated":true}');
                arrived(hit);
            });
        });
        const tlsPort = await listen(tlsServer);

        // The stored frontendUrl deliberately says http:// — the variant an operator gets with the
        // gateway configured `ssl: false`. The transport must follow the LISTENER, not this string.
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${tlsPort}`,
            revalidateSecret: 'lab-secret',
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
        }));
        // configManager caches the parsed config for up to 2s and revalidates by mtime.
        await sleep(2200);

        assert.strictEqual(frontendServesTls(), true, 'certs on disk mean a restarted frontend serves TLS');

        purgeFrontend(['posts', 'post:tls'], ['/tls']);
        const hit = await waitForPurge;

        assert.strictEqual(hit.url, '/api/revalidate');
        assert.strictEqual(hit.method, 'POST');
        assert.strictEqual(hit.secret, 'lab-secret');
        assert.strictEqual(hit.peerCn, 'backend', 'the purge presented THIS node\'s cluster identity');
        assert.deepStrictEqual(JSON.parse(hit.body), { tags: ['posts', 'post:tls'], paths: ['/tls'] });
    });

    test('the cluster TLS options are never half-built: ca AND key AND cert, or nothing', () => {
        const cfg = {
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
        };
        const opts = clusterTlsOptions(cfg, ['frontend', 'gateway']);
        assert.ok(opts, 'material is on disk, so options must be produced');
        // The pre-fix direct leg had `ca` and `checkServerIdentity` and NOTHING ELSE. Each of these
        // three is the assertion that the handshake can complete.
        assert.ok(String(opts.ca).includes('BEGIN CERTIFICATE'), 'ca');
        assert.ok(String(opts.key).includes('PRIVATE KEY'), 'client key — the one that was missing');
        assert.ok(String(opts.cert).includes('BEGIN CERTIFICATE'), 'client cert — the one that was missing');
        assert.strictEqual(opts.rejectUnauthorized, true, 'never disable verification on the cluster channel');
        assert.strictEqual(typeof opts.checkServerIdentity, 'function');
        assert.strictEqual(
            opts.checkServerIdentity('127.0.0.1', { subject: { CN: 'frontend' } }), undefined,
            'the frontend CN is accepted (its SAN never covers 127.0.0.1)',
        );
        assert.ok(
            opts.checkServerIdentity('127.0.0.1', { subject: { CN: 'evil' } }) instanceof Error,
            'any other CN is refused',
        );

        // Unreadable material must be null — a caller that degraded to plain HTTP here would be
        // shouting into a TLS socket.
        assert.strictEqual(
            clusterTlsOptions({ mtls: { ca: './certs/cluster-ca.crt', key: './certs/nope.key', cert: './certs/backend.crt' } }, ['frontend']),
            null,
        );
    });
});
