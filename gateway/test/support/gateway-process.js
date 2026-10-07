'use strict';
/**
 * Boot the REAL gateway (src/index.js, primary + workers) for an end-to-end test, without touching the
 * repository's own gateway-config.json, registry, policy file or the developer's ports.
 *
 * index.js resolves its config, registry, certificates and pushed host policy relative to its own
 * directory, so the harness copies gateway/src into a fresh temporary `gateway/` tree, writes a config
 * there (random ports for EVERY listener, including the defaults 3000/3100/4000/3001 a developer's own
 * stack uses), and runs it with NODE_PATH pointing at gateway/node_modules. The code under test is
 * therefore byte for byte the code in src/; only its surroundings are disposable.
 *
 * Not a test file (it does not match test/*.test.js); required by the end-to-end tests.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');
const forge = require('node-forge');

const GATEWAY_ROOT = path.resolve(__dirname, '..', '..');

// ─── Certificates (native RSA keys, node-forge for the X.509 structure) ─────────────────────────────

function rsaKeys() {
    const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { pem: pair.privateKey, privateKey: forge.pki.privateKeyFromPem(pair.privateKey), publicKey: forge.pki.publicKeyFromPem(pair.publicKey) };
}

let serial = 1;
function certificate(subjectCn, keys, issuer, extensions) {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    serial += 1;
    cert.serialNumber = serial.toString(16).padStart(2, '0');
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: subjectCn }]);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: 'commonName', value: subjectCn }]);
    if (extensions) cert.setExtensions(extensions);
    cert.sign(issuer ? issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
    return cert;
}

function makeCa() {
    const keys = rsaKeys();
    const cert = certificate('WordJS Test Cluster CA', keys, null, [{ name: 'basicConstraints', cA: true }]);
    return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}

/** A leaf signed by `ca` (or self-signed without one), valid for localhost and 127.0.0.1. */
function makeLeaf(ca, cn) {
    const keys = rsaKeys();
    const cert = certificate(cn, keys, ca, [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]);
    return { key: keys.pem, cert: forge.pki.certificateToPem(cert) };
}

// ─── Small network helpers ──────────────────────────────────────────────────────────────────────────

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP(S) request. `headers.host` overrides the Host header. Never throws: { status, headers, body } or { error }. */
function request({ port, path: reqPath = '/', method = 'GET', headers = {}, secure = false, body, ca, key, cert }) {
    return new Promise((resolve) => {
        const transport = secure ? https : http;
        const req = transport.request({
            hostname: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers,
            agent: false,
            timeout: 8000,
            rejectUnauthorized: false,
            ca,
            key,
            cert,
            servername: 'localhost',
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (error) => resolve({ error }));
        if (body !== undefined) req.write(body);
        req.end();
    });
}

/**
 * Write raw bytes and collect the whole answer until the server closes (or `waitMs` passes): the only
 * way to send what a well-behaved client never would (two Host headers, no Host at all, an upgrade).
 */
function rawExchange({ port, payload, secure = false, waitMs = 4000 }) {
    return new Promise((resolve) => {
        const socket = secure
            ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' })
            : net.connect({ host: '127.0.0.1', port });
        let data = '';
        let closed = false;
        const done = () => resolve({ data, closed });
        const timer = setTimeout(() => { socket.destroy(); done(); }, waitMs);
        socket.setEncoding('utf8');
        socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(payload));
        socket.on('data', (c) => (data += c));
        socket.on('error', () => {});
        socket.on('close', () => { closed = true; clearTimeout(timer); done(); });
    });
}

/**
 * An upstream that answers every request with the headers it received, and completes every WebSocket
 * upgrade (101) after recording that request's headers in `upgrades`.
 */
function startEchoUpstream(name) {
    const upgrades = [];
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ upstream: name, url: req.url, headers: req.headers }));
    });
    server.on('upgrade', (req, socket) => {
        upgrades.push({ url: req.url, headers: req.headers });
        const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        upgrades,
        requests,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    })));
}

function upgradePayload(host, extraHeaders = '') {
    return `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' + extraHeaders + '\r\n';
}

// ─── The gateway process ────────────────────────────────────────────────────────────────────────────

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else fs.copyFileSync(src, dst);
    }
}

/**
 * Start the gateway. Options:
 *   secure         serve the public listener over TLS (a self-signed leaf) instead of plain http
 *   acme           also start the port-80-style ACME listener (on a random port)
 *   upstreams      { frontend, backend } echo upstream ports for the registry ('/' and '/api')
 *   cluster        a CA from makeCa(): installs gateway-internal certs so the internal mTLS listener starts
 * Returns { dir, port, internalPort, acmePort, output(), stop() }.
 */
async function bootGateway({ secure = false, acme = false, upstreams, cluster }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-gw-'));
    const dir = path.join(root, 'gateway');
    copyDir(path.join(GATEWAY_ROOT, 'src'), path.join(dir, 'src'));

    const [port, internalPort, acmePort] = [await freePort(), await freePort(), await freePort()];
    const config = {
        gatewayPort: port,
        gatewayInternalPort: internalPort,
        gatewayEnrollPort: await freePort(),
        backendPort: upstreams.backend,
        frontendPort: upstreams.frontend,
        gatewaySecret: crypto.randomBytes(16).toString('hex'),
        // Development keeps the worker count at min(cpus, 4).
        nodeEnv: 'development',
    };
    if (acme) config.acme = { http01Port: acmePort };
    if (secure) {
        const leaf = makeLeaf(null, 'localhost');
        fs.mkdirSync(path.join(dir, 'ssl'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ssl', 'key.pem'), leaf.key);
        fs.writeFileSync(path.join(dir, 'ssl', 'cert.pem'), leaf.cert);
        config.ssl = { enabled: true, key: './ssl/key.pem', cert: './ssl/cert.pem' };
    }
    fs.writeFileSync(path.join(dir, 'gateway-config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dir, 'gateway-registry.json'), JSON.stringify({
        '/': { targets: [`http://127.0.0.1:${upstreams.frontend}`], metrics: {} },
        '/api': { targets: [`http://127.0.0.1:${upstreams.backend}`], metrics: {} },
    }));
    if (cluster) {
        const certs = path.join(dir, 'certs');
        fs.mkdirSync(certs, { recursive: true });
        const server = makeLeaf(cluster, 'gateway-internal');
        fs.writeFileSync(path.join(certs, 'cluster-ca.crt'), cluster.pem);
        fs.writeFileSync(path.join(certs, 'gateway-internal.key'), server.key);
        fs.writeFileSync(path.join(certs, 'gateway-internal.crt'), server.cert);
    }

    let out = '';
    const child = spawn(process.execPath, [path.join(dir, 'src', 'index.js')], {
        cwd: dir,
        env: Object.assign({}, process.env, { NODE_PATH: path.join(GATEWAY_ROOT, 'node_modules'), NODE_ENV: 'test' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));

    const stop = async () => {
        if (child.exitCode === null) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
            }
        }
        for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i += 1) await sleep(100);
        // Workers exit when their IPC channel to the primary closes; wait for the port to go quiet.
        for (let i = 0; i < 50; i += 1) {
            const r = await request({ port, path: '/healthz', secure });
            if (r.error) break;
            await sleep(100);
        }
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a log file briefly */ }
    };

    const deadline = Date.now() + 30000;
    for (;;) {
        const r = await request({ port, path: '/healthz', secure });
        if (r.status === 200) break;
        if (child.exitCode !== null || Date.now() > deadline) {
            await stop();
            assert.fail(`the gateway did not come up:\n${out}`);
        }
        await sleep(150);
    }
    if (cluster) {
        for (;;) {
            const up = await new Promise((resolve) => {
                const s = net.connect({ host: '127.0.0.1', port: internalPort }, () => { s.destroy(); resolve(true); });
                s.on('error', () => resolve(false));
            });
            if (up) break;
            if (Date.now() > deadline) {
                await stop();
                assert.fail(`the internal listener did not come up:\n${out}`);
            }
            await sleep(150);
        }
    }
    if (acme) {
        for (;;) {
            const r = await request({ port: acmePort, path: '/.well-known/acme-challenge/none' });
            if (r.status) break;
            if (Date.now() > deadline) {
                await stop();
                assert.fail(`the ACME listener did not come up:\n${out}`);
            }
            await sleep(150);
        }
    }
    return { dir, port, internalPort, acmePort, output: () => out, stop };
}

/** POST /host-policy on the internal listener as `identity` ({ key, cert } signed by `ca`). */
function pushPolicy({ internalPort, ca, identity, body }) {
    return request({
        port: internalPort,
        path: '/host-policy',
        method: 'POST',
        secure: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ca: ca.pem,
        key: identity.key,
        cert: identity.cert,
    });
}

/** Poll `probe` until it returns true, or fail with `what` after `ms`. */
async function eventually(what, probe, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
        await sleep(100);
    }
}

module.exports = {
    makeCa,
    makeLeaf,
    freePort,
    request,
    rawExchange,
    startEchoUpstream,
    upgradePayload,
    bootGateway,
    pushPolicy,
    eventually,
    sleep,
};
