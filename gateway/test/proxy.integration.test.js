const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const forge = require('node-forge');

const { createProxyServer, createUpstreamAgent } = require('../src/proxy-config');
const routing = require('../src/routing');

// --- Cert helpers (node-forge) -------------------------------------------------

function makeCA() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'test-ca' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(ca, cn) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1000);
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.sign(ca.keys.privateKey, forge.md.sha256.create());
    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

// =============================================================================
// 1. Host / changeOrigin (plain HTTP)
// =============================================================================
test('changeOrigin rewrites upstream Host and xfwd preserves original', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ host: req.headers.host, xfh: req.headers['x-forwarded-host'] }));
    });
    const upstreamPort = await listen(upstream);

    const proxy = createProxyServer();
    const gateway = http.createServer((req, res) => {
        proxy.web(req, res, { target: `http://127.0.0.1:${upstreamPort}` });
    });
    const gatewayPort = await listen(gateway);

    t.after(async () => { await close(gateway); await close(upstream); proxy.close(); });

    const body = await new Promise((resolve, reject) => {
        const r = http.request(
            { host: '127.0.0.1', port: gatewayPort, path: '/', headers: { Host: 'example.com' } },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(JSON.parse(data)));
            }
        );
        r.on('error', reject);
        r.end();
    });

    assert.strictEqual(body.host, `127.0.0.1:${upstreamPort}`, 'changeOrigin should rewrite Host to target');
    assert.strictEqual(body.xfh, 'example.com', 'xfwd should preserve original Host as X-Forwarded-Host');
});

// Shared CA + client for the mTLS cases
const realCA = makeCA();
const clientLeaf = makeLeaf(realCA, 'gateway-internal');
const agent = createUpstreamAgent({ ca: realCA.pem, key: clientLeaf.key, cert: clientLeaf.cert });

function httpsGet(port, agent) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            { host: '127.0.0.1', port, path: '/', method: 'GET', agent },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// =============================================================================
// 2. mTLS positive: real CA, CN=backend -> 200 ok
// =============================================================================
test('mTLS positive: trusted CA + allowed CN succeeds', async (t) => {
    const serverLeaf = makeLeaf(realCA, 'backend');
    const upstream = https.createServer(
        { key: serverLeaf.key, cert: serverLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    const result = await httpsGet(port, agent);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, 'ok');
});

// =============================================================================
// 3. mTLS MITM negative: rogue CA -> fails
// =============================================================================
test('mTLS MITM negative: rogue CA is rejected', async (t) => {
    const rogueCA = makeCA();
    const rogueLeaf = makeLeaf(rogueCA, 'backend'); // same CN, wrong CA
    const upstream = https.createServer(
        { key: rogueLeaf.key, cert: rogueLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    await assert.rejects(
        () => httpsGet(port, agent),
        (err) => {
            assert.ok(err.code || /verify|signature|self.signed|chain/i.test(err.message),
                `expected TLS verify error, got: ${err.code} ${err.message}`);
            return true;
        }
    );
});

// =============================================================================
// 4. mTLS wrong-CN negative: real CA but CN=evil-service -> CN policy error
// =============================================================================
test('mTLS wrong-CN negative: disallowed CN is rejected by checkServerIdentity', async (t) => {
    const evilLeaf = makeLeaf(realCA, 'evil-service');
    const upstream = https.createServer(
        { key: evilLeaf.key, cert: evilLeaf.cert, ca: realCA.pem, requestCert: true, rejectUnauthorized: true },
        (req, res) => { res.writeHead(200); res.end('ok'); }
    );
    const port = await listen(upstream);
    t.after(async () => { await close(upstream); });

    await assert.rejects(
        () => httpsGet(port, agent),
        (err) => {
            assert.match(err.message, /not in allowed identities|evil-service/);
            return true;
        }
    );
});

// =============================================================================
// 5. BACKEND EVICTED: /api must NEVER fall through to the frontend's '/' catch-all
//
// Audit 2026-08-18 #22. The health sweep evicts a target after three failed 30 s probes — a schema
// migration, an OOM, or one of the restarts the product itself triggers (POST
// /api/internal/gateway-update calls process.exit(0)). Routing used to be longest-prefix over
// whatever remained, and the frontend owns '/', a prefix of everything: for that whole window every
// /api/* request — POST /auth/login with the password in the body, session cookies, Authorization
// headers, uploads — was proxied to the frontend node.
//
// This drives the REAL routing function the worker calls (src/routing.js#resolveTarget) with the
// registry shape the primary broadcasts, and delivers through the REAL proxy, then asserts the
// frontend upstream saw nothing.
// =============================================================================

/** The worker's registry shape: targets as a Set, metrics as the plain object the primary broadcasts. */
function makeRegistry(entries) {
    return new Map(entries.map(([prefix, group]) => [prefix, {
        name: group.name,
        targets: new Set(group.targets),
        index: 0,
        metrics: group.metrics || {},
    }]));
}

test('an evicted backend does NOT hand /api to the frontend — the request 502s and the frontend never sees it', async (t) => {
    const frontendHits = [];
    const frontend = http.createServer((req, res) => {
        frontendHits.push({ url: req.url, auth: req.headers.authorization });
        res.writeHead(200); res.end('frontend');
    });
    const frontendPort = await listen(frontend);

    // The registry as it looks the instant the third probe fails: the backend GROUP is still there
    // (it owns /api) but has no live target. Before the fix the group was deleted outright, which is
    // the case the next test exercises.
    const registry = makeRegistry([
        ['/', { name: 'frontend', targets: [`http://127.0.0.1:${frontendPort}`] }],
        ['/api', { name: 'backend', targets: [] }],
    ]);

    const proxy = createProxyServer();
    const gateway = http.createServer((req, res) => {
        const target = routing.resolveTarget(registry, req.url);
        if (!target) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Service Unavailable' }));
        }
        proxy.web(req, res, { target }, () => { res.writeHead(502); res.end(); });
    });
    const gatewayPort = await listen(gateway);
    t.after(async () => { await close(gateway); await close(frontend); proxy.close(); });

    const send = (path, method, body) => new Promise((resolve, reject) => {
        const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
        const r = http.request({ host: '127.0.0.1', port: gatewayPort, path, method, headers },
            (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });

    const login = await send('/api/v1/auth/login', 'POST', JSON.stringify({ username: 'admin', password: 'hunter2' }));
    assert.strictEqual(login.status, 502, 'a down backend must answer 502, not 200 from somebody else');
    assert.deepStrictEqual(frontendHits, [], 'the credentials must never reach the frontend node');

    // The frontend's own namespace keeps working throughout — this is an availability fix, not a
    // blanket shutdown.
    const page = await send('/about', 'GET', null);
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.body, 'frontend');
    assert.strictEqual(frontendHits.length, 1, 'exactly the page request — nothing from /api');
});

test('even with the /api route GONE from the registry, /api/* resolves to nothing rather than to the frontend', () => {
    // A registry.json written by a pre-fix gateway (or any future path that drops the entry) leaves
    // ONLY the catch-all. Ownership is derived from the PATH, not from the prefix that happened to
    // match, so the guarantee survives the entry's absence.
    const registry = makeRegistry([['/', { name: 'frontend', targets: ['http://127.0.0.1:1'] }]]);
    for (const url of ['/api/v1/auth/login', '/api', '/uploads/2026/x.png', '/themes/default/style.css', '/metrics']) {
        assert.strictEqual(routing.resolveTarget(registry, url), null, `${url} must not resolve to the frontend`);
    }
    // …and the frontend still serves its own.
    assert.strictEqual(routing.resolveTarget(registry, '/admin/posts'), 'http://127.0.0.1:1');
    // A slug that merely starts with a backend prefix is the frontend's (segment boundary).
    assert.strictEqual(routing.resolveTarget(registry, '/apiary'), 'http://127.0.0.1:1');
});

test('an absolute-form request line cannot smuggle /api past the owner check', () => {
    // `POST http://host/api/v1/auth/login HTTP/1.1` is legal HTTP and Node reports req.url verbatim.
    // Unnormalised it matches no backend prefix and lands on the '/' catch-all — the same confusion,
    // arriving through the request line instead of the registry.
    const registry = makeRegistry([
        ['/', { name: 'frontend', targets: ['http://127.0.0.1:1'] }],
        ['/api', { name: 'backend', targets: ['http://127.0.0.1:2'] }],
    ]);
    assert.strictEqual(routing.resolveTarget(registry, 'http://example.com/api/v1/auth/login'), 'http://127.0.0.1:2');
    assert.strictEqual(routing.resolveTarget(registry, 'http://example.com/about'), 'http://127.0.0.1:1');
});

test('a frontend group may not serve a backend prefix even if it registered one', () => {
    // Defence in depth for the /register guards: if a rogue or buggy registration ever put a
    // frontend-named group on /api, routing refuses it too.
    const registry = makeRegistry([
        ['/', { name: 'frontend', targets: ['http://127.0.0.1:1'] }],
        ['/api', { name: 'frontend', targets: ['http://127.0.0.1:2'] }],
    ]);
    assert.strictEqual(routing.resolveTarget(registry, '/api/v1/auth/login'), null);
});

test('a legacy group with no name is judged by the prefix it is registered under', () => {
    // A registry.json written before groups carried a `name`. Rejecting it outright would 502 /api
    // until the backend happened to restart (registration is boot-time), so the prefix's own owner —
    // which /register enforced when the entry was created — decides.
    const legacy = new Map([
        ['/', { targets: new Set(['http://127.0.0.1:1']), index: 0 }],
        ['/api', { targets: new Set(['http://127.0.0.1:2']), index: 0 }],
    ]);
    assert.strictEqual(routing.resolveTarget(legacy, '/api/v1/posts'), 'http://127.0.0.1:2');
    assert.strictEqual(routing.resolveTarget(legacy, '/about'), 'http://127.0.0.1:1');
    // …and the catch-all still cannot inherit /api when the backend entry is gone.
    const legacyNoApi = new Map([['/', { targets: new Set(['http://127.0.0.1:1']), index: 0 }]]);
    assert.strictEqual(routing.resolveTarget(legacyNoApi, '/api/v1/auth/login'), null);
});

test('/api/revalidate belongs to NEXT: it goes to the frontend, never to the backend', () => {
    const registry = makeRegistry([
        ['/', { name: 'frontend', targets: ['http://127.0.0.1:1'] }],
        ['/api', { name: 'backend', targets: ['http://127.0.0.1:2'] }],
    ]);
    assert.strictEqual(routing.resolveTarget(registry, '/api/revalidate'), 'http://127.0.0.1:1');
    assert.strictEqual(routing.resolveTarget(registry, '/api/v1/posts'), 'http://127.0.0.1:2');
    // Not a prefix game: only the exact route (and anything under it) is Next's.
    assert.strictEqual(routing.resolveTarget(registry, '/api/revalidateXYZ'), 'http://127.0.0.1:2');
});

test('a failing-but-not-yet-evicted target is skipped, and round-robin still spreads healthy ones', () => {
    const registry = makeRegistry([
        ['/api', { name: 'backend', targets: ['http://a:4000', 'http://b:4000'], metrics: { 'http://a:4000': { status: 'Failing' } } }],
    ]);
    assert.strictEqual(routing.resolveTarget(registry, '/api/x'), 'http://b:4000');
    assert.strictEqual(routing.resolveTarget(registry, '/api/x'), 'http://b:4000');

    const both = makeRegistry([['/api', { name: 'backend', targets: ['http://a:4000', 'http://b:4000'] }]]);
    assert.strictEqual(routing.resolveTarget(both, '/api/x'), 'http://a:4000');
    assert.strictEqual(routing.resolveTarget(both, '/api/x'), 'http://b:4000');
});
