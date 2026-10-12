/**
 * WordJS — THE REPLICA'S OWN server.js, RUN FOR REAL: which peer's forwarding headers survive, per listener.
 *
 * replicaFrontDoor.test.ts drives the handlers backend-proxy-target.js exports. This drives server.js
 * itself — the file that decides which handler each listener gets — as its own process, with a real
 * cluster CA, real mutual TLS and a real backend recording what reached it. Only Next is stood in for
 * (a preload resolves `next` to a stub that echoes the headers its request handler and its upgrade
 * listener receive), because a production `.next` build is not part of a unit test.
 *
 * The property: X-Forwarded-* are kept only when the GATEWAY stated them. On the mTLS listener that means
 * a client certificate with the gateway's identity (CN gateway-internal); every other cluster-CA holder
 * — a backend node's certificate, another frontend's — is pinned exactly like a client, because mutual
 * TLS proves cluster membership, not that the peer is the gateway. The HTTP fallback listener pins always.
 * Requests AND WebSocket upgrades, for paths the replica proxies itself and paths Next serves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import mod from '../../../backend-proxy-target.js';

const { isGatewayPeer } = mod as any;
const FRONTEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_JS = path.join(FRONTEND_DIR, 'server.js');
// node-forge ships with the backend's production dependencies (CI installs them for this job too); the
// certificates below follow gateway/src/cluster-ca.js's recipe: CN = identity, SAN localhost/127.0.0.1,
// serverAuth + clientAuth.
const forge = createRequire(path.join(FRONTEND_DIR, '..', 'backend', 'package.json'))('node-forge');

type Pem = { key: string; cert: string };
function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { pub: forge.pki.publicKeyFromPem(publicKey), privPem: privateKey as string, priv: forge.pki.privateKeyFromPem(privateKey) };
}
function serial() { return '0' + crypto.randomBytes(15).toString('hex'); }
function makeCa(): { pem: Pem; cert: any; priv: any } {
    const k = keypair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = k.pub;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    const attrs = [{ name: 'commonName', value: 'WordJS Test Cluster Root CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
    cert.sign(k.priv, forge.md.sha256.create());
    return { pem: { key: k.privPem, cert: forge.pki.certificateToPem(cert) }, cert, priv: k.priv };
}
function issue(ca: { cert: any; priv: any }, cn: string): Pem {
    const k = keypair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = k.pub;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ]);
    cert.sign(ca.priv, forge.md.sha256.create());
    return { key: k.privPem, cert: forge.pki.certificateToPem(cert) };
}

// What the GATEWAY sends a replica: Host is the replica's internal host (changeOrigin), and the
// forwarding headers are the ones it judged at its edge.
const GATEWAY_FORWARDED = {
    Host: 'frontend-replica-7.internal',
    'X-Forwarded-Host': 'site.example',
    'X-Forwarded-For': '198.51.100.7',
    'X-Forwarded-Proto': 'https',
};
// A peer claiming to speak for a client.
const FORGED = {
    Host: 'site.example',
    'X-Forwarded-For': '203.0.113.9',
    'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-Proto': 'https',
    'X-Real-IP': '203.0.113.9',
    Forwarded: 'for=203.0.113.9;host=evil.example;proto=https',
};
const UPGRADE = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };

let tmp = '';
let backend: http.Server;
let backendUrl = '';
const seenByBackend: http.IncomingHttpHeaders[] = [];
let ca: ReturnType<typeof makeCa>;
let gatewayId: Pem;
let backendNodeId: Pem;

async function freePort(): Promise<number> {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

type Replica = { port: number; child: ChildProcess; out: () => string; stop: () => Promise<void> };
async function startReplica(cwd: string): Promise<Replica> {
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', path.join(tmp, 'next-preload.js'), SERVER_JS], {
        cwd,
        env: { ...process.env, NODE_ENV: 'production', PORT: String(port), WORDJS_BACKEND_URL: backendUrl, WORDJS_MODE: '', WJS_FAKE_NEXT: path.join(tmp, 'fake-next.js') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server.js did not start:\n${out}`)), 20000);
        const onData = (d: Buffer) => { out += d.toString(); if (/> Ready on/.test(out)) { clearTimeout(timer); resolve(); } };
        child.stdout!.on('data', onData);
        child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server.js exited ${code}:\n${out}`)); });
    });
    return {
        port, child, out: () => out,
        stop: () => new Promise<void>((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill(); }),
    };
}

/** One request (or upgrade) to the replica; resolves with the JSON body of whatever answered. */
function call(r: Replica, opts: { tls?: Pem; path: string; headers: Record<string, string>; upgrade?: boolean }): Promise<any> {
    return new Promise((resolve, reject) => {
        const base = { host: '127.0.0.1', port: r.port, path: opts.path, method: 'GET', headers: { ...opts.headers, ...(opts.upgrade ? UPGRADE : {}) } };
        const req = opts.tls
            ? https.request({ ...base, ca: ca.pem.cert, key: opts.tls.key, cert: opts.tls.cert, agent: false, servername: 'localhost' }) // verify the replica as localhost, whatever Host says
            : http.request({ ...base, agent: false });
        req.on('response', (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(`not JSON (${res.statusCode}): ${body}`)); } });
        });
        req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('unexpected 101')); });
        req.on('error', reject);
        req.end();
    });
}

/** Ask the backend side: proxy a /api request and return the headers the backend received. */
async function viaBackend(r: Replica, tls: Pem | undefined, headers: Record<string, string>) {
    const before = seenByBackend.length;
    const body = await call(r, { tls, path: '/api/v1/users/me', headers });
    expect(body.via).toBe('backend');
    return seenByBackend[before];
}

function expectGatewayKept(h: Record<string, any>) {
    expect(h['x-forwarded-host']).toBe('site.example');
    expect(h['x-forwarded-for']).toBe('198.51.100.7');
    expect(h['x-forwarded-proto']).toBe('https');
}
function expectPinned(h: Record<string, any>, proto: 'http' | 'https') {
    expect(h['x-forwarded-for']).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(h['x-forwarded-host']).toBe('site.example'); // the Host the replica received, never the claim
    expect(h['x-forwarded-proto']).toBe(proto);
    expect(h['x-real-ip']).toBeUndefined();
    expect(h.forwarded).toBeUndefined();
}

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-replica-wiring-'));
    fs.writeFileSync(path.join(tmp, 'next-preload.js'), [
        "const Module = require('module');",
        'const orig = Module._resolveFilename;',
        "Module._resolveFilename = function (request, ...rest) { if (request === 'next') return process.env.WJS_FAKE_NEXT; return orig.call(this, request, ...rest); };",
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'fake-next.js'), [
        'module.exports = function next(opts) {',
        "  const handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ via: 'next', headers: req.headers })); };",
        '  if (opts && opts.httpServer) opts.httpServer.on("upgrade", (req, socket) => {',
        "    const body = JSON.stringify({ via: 'next-upgrade', headers: req.headers });",
        "    socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nConnection: close\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
        '  });',
        '  return { prepare: () => Promise.resolve(), getRequestHandler: () => handle };',
        '};',
    ].join('\n'));

    backend = http.createServer((req, res) => {
        seenByBackend.push({ ...req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ via: 'backend' }));
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
    backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

    ca = makeCa();
    gatewayId = issue(ca, 'gateway-internal');
    backendNodeId = issue(ca, 'backend');
    const frontendId = issue(ca, 'frontend');
    const certs = path.join(tmp, 'mtls', 'certs');
    fs.mkdirSync(certs, { recursive: true });
    fs.writeFileSync(path.join(certs, 'cluster-ca.crt'), ca.pem.cert);
    fs.writeFileSync(path.join(certs, 'frontend.key'), frontendId.key);
    fs.writeFileSync(path.join(certs, 'frontend.crt'), frontendId.cert);
    fs.mkdirSync(path.join(tmp, 'plain'), { recursive: true }); // no certs: the HTTP fallback listener
}, 60000);

afterAll(async () => {
    await new Promise<void>((r) => backend.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

describe('server.js, mTLS listener (certificates present)', () => {
    let r: Replica;
    beforeAll(async () => { r = await startReplica(path.join(tmp, 'mtls')); }, 30000);
    afterAll(async () => { await r.stop(); });

    test('the GATEWAY\'s certificate: its forwarding headers reach the backend, Next, and an upgrade unchanged', async () => {
        expect(r.out()).toMatch(/mTLS/);
        expectGatewayKept(await viaBackend(r, gatewayId, GATEWAY_FORWARDED));
        const page = await call(r, { tls: gatewayId, path: '/preview/42', headers: GATEWAY_FORWARDED });
        expect(page.via).toBe('next');
        expectGatewayKept(page.headers);
        const up = await call(r, { tls: gatewayId, path: '/api/v1/collab/1/socket', headers: GATEWAY_FORWARDED, upgrade: true });
        expect(up.via).toBe('next-upgrade');
        expectGatewayKept(up.headers);
    }, 30000);

    test('ANOTHER cluster certificate (a backend node\'s): its claims are replaced, on every path', async () => {
        expectPinned(await viaBackend(r, backendNodeId, FORGED), 'https');
        const page = await call(r, { tls: backendNodeId, path: '/preview/42', headers: FORGED });
        expect(page.via).toBe('next');
        expectPinned(page.headers, 'https');
        const up = await call(r, { tls: backendNodeId, path: '/api/v1/collab/1/socket', headers: FORGED, upgrade: true });
        expect(up.via).toBe('next-upgrade');
        expectPinned(up.headers, 'https');
    }, 30000);
});

describe('server.js, HTTP fallback listener (no certificates)', () => {
    let r: Replica;
    beforeAll(async () => { r = await startReplica(path.join(tmp, 'plain')); }, 30000);
    afterAll(async () => { await r.stop(); });

    test('a client\'s forwarding headers are replaced for the proxy, for Next and for an upgrade', async () => {
        expect(r.out()).toMatch(/HTTP Fallback/);
        expectPinned(await viaBackend(r, undefined, FORGED), 'http');
        const page = await call(r, { path: '/preview/42', headers: FORGED });
        expectPinned(page.headers, 'http');
        const up = await call(r, { path: '/api/v1/collab/1/socket', headers: FORGED, upgrade: true });
        expect(up.via).toBe('next-upgrade');
        expectPinned(up.headers, 'http');
    }, 30000);
});

describe('isGatewayPeer', () => {
    const sock = (authorized: boolean, CN: unknown) => ({ socket: { authorized, getPeerCertificate: () => ({ subject: { CN } }) } });
    test('only a VERIFIED certificate naming a gateway identity', () => {
        expect(isGatewayPeer(sock(true, 'gateway-internal'))).toBe(true);
        expect(isGatewayPeer(sock(true, 'gateway'))).toBe(true);
        expect(isGatewayPeer(sock(false, 'gateway-internal'))).toBe(false); // presented, not verified
        expect(isGatewayPeer(sock(true, 'backend'))).toBe(false);
        expect(isGatewayPeer(sock(true, 'frontend'))).toBe(false);
        expect(isGatewayPeer(sock(true, ['frontend', 'gateway-internal']))).toBe(false); // multi-valued CN
        expect(isGatewayPeer({ socket: { remoteAddress: '127.0.0.1' } })).toBe(false); // plain HTTP
    });
});
