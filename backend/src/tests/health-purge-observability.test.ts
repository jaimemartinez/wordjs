/**
 * GET /api/v1/health/details reports a DEAD on-demand purge channel (audit 2026-08-18 #27).
 *
 * The defect wave 1 fixed was that the direct transport built its TLS options half-way (CA, but no
 * key and no cert), so in split mode every purge died in the handshake against a frontend that starts
 * with `requestCert: true` as soon as the installer's certificates exist. What wave 1 did NOT close is
 * the reason it stayed hidden for months: the only trace was a once-an-hour warning line, shared with
 * "the frontend happens to be down", so an operator experienced a permanent misconfiguration as "the
 * site is slow to update". `purgeFailureState()` was exported for a health surface and nothing
 * consumed it. This is that surface.
 *
 * The distinction under test is the one the audit insists on: a handshake failure is PERMANENT
 * misconfiguration. It will repeat identically forever, so it belongs in a status field an operator
 * reads, not in a rate-limited log line.
 *
 * FIXTURE-VS-PRODUCER: nothing here pokes `purgeFailureState` or hand-builds a broken state. A real
 * TLS listener is started, the real `purgeFrontend()` entry point (the one the content hooks call) is
 * invoked, a real handshake really fails, and the failure is then read back through supertest over
 * the REAL routes tree. The cluster certificates are generated with node-forge exactly as the
 * installer does, and are INPUT to the module under test.
 *
 * MUTATION PROOF: delete the `purge` field from SystemHealth.getFullStatus and the second test fails;
 * make checkPurge report every failure (transient included) and the first test's `OK` disappears.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const forge = require('node-forge');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-health-purge-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

// --- Certificates, generated the way the installer does: a cluster CA plus leaves whose CN is the ROLE.
function makeCA(cn: string) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: cn }];
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('/health/details makes a permanently broken purge channel visible', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;
    let rogueServer: any;
    let goodServer: any;      // the SAME peer, once its certificates are fixed
    let clusterCa: any;       // this cluster's CA, kept so the repaired peer can be signed by it
    let peerPort: number;
    let purgeFrontend: any;
    let purgeFailureState: any;

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['subscriber', 'x', 'sub@example.com', 'Subscriber']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // This node's own cluster material — present and readable, so the purge leg is built COMPLETE
        // (post-wave-1 shape). The failure below is therefore about the PEER, not about us.
        clusterCa = makeCA('WordJS Cluster Root CA');
        const backend = makeLeaf(clusterCa, 'backend');
        fs.mkdirSync(path.join(TMP_ROOT, 'certs'), { recursive: true });
        fs.writeFileSync(path.join(TMP_ROOT, 'certs', 'cluster-ca.crt'), clusterCa.pem);
        fs.writeFileSync(path.join(TMP_ROOT, 'certs', 'backend.key'), backend.key);
        fs.writeFileSync(path.join(TMP_ROOT, 'certs', 'backend.crt'), backend.cert);

        // A "frontend" that is NOT part of this cluster: its certificate is signed by a different CA,
        // and it demands a client certificate. This is the shape of a real misconfiguration (a node
        // pointed at a peer enrolled elsewhere, or certificates rotated on one side only): the socket
        // connects, the handshake is refused, and it will be refused identically forever.
        const rogueCa = makeCA('Someone Else CA');
        const rogueLeaf = makeLeaf(rogueCa, 'frontend');
        rogueServer = https.createServer(
            { key: rogueLeaf.key, cert: rogueLeaf.cert, requestCert: true, rejectUnauthorized: false },
            (_req: any, res: any) => { res.writeHead(200); res.end('{}'); }
        );
        // A refused handshake surfaces on the server as an error event; swallow it so the test process
        // does not die on the very thing it is provoking.
        rogueServer.on('tlsClientError', () => { /* expected */ });
        const port: number = await new Promise((r) => rogueServer.listen(0, '127.0.0.1', () => r(rogueServer.address().port)));
        peerPort = port;

        // A site config exactly like a single-host split whose frontend serves TLS.
        fs.writeFileSync(path.join(TMP_ROOT, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `https://127.0.0.1:${port}`,
            revalidateSecret: 'lab-secret',
            mtls: {
                ca: path.join(TMP_ROOT, 'certs', 'cluster-ca.crt'),
                key: path.join(TMP_ROOT, 'certs', 'backend.key'),
                cert: path.join(TMP_ROOT, 'certs', 'backend.crt'),
            },
        }));

        ({ purgeFrontend, purgeFailureState } = require('../core/frontend-purge'));

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use(config.api.prefix, require('../routes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await new Promise<void>((r) => (rogueServer ? rogueServer.close(() => r()) : r())); } catch { /* ignore */ }
        try { await new Promise<void>((r) => (goodServer ? goodServer.close(() => r()) : r())); } catch { /* ignore */ }
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(ORIGINAL_CWD); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('reports purge OK while nothing has permanently failed — the field is a signal, not decoration', async () => {
        const res = await request(app)
            .get('/api/v1/health/details')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.purge, '/health/details must carry a purge section');
        assert.strictEqual(res.body.purge.status, 'OK');
        assert.deepStrictEqual(res.body.purge.broken, []);
        // The channel is named, so "which transport is dead" is answerable from the same payload.
        assert.strictEqual(res.body.purge.transport, 'direct');
        assert.match(String(res.body.purge.target), /^https:\/\/127\.0\.0\.1:\d+$/);
    });

    it('a REAL refused handshake turns the field BROKEN, with the misconfiguration named', async () => {
        // The entry point the content hooks call on every publish/edit/settings change.
        purgeFrontend(['posts'], ['/']);

        // Debounce is 1.5s; give the handshake room to fail without racing it.
        const deadline = Date.now() + 15000;
        while (!purgeFailureState().length && Date.now() < deadline) await sleep(200);
        assert.ok(purgeFailureState().length, 'the purge should have failed permanently in the handshake');

        const res = await request(app)
            .get('/api/v1/health/details')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.purge.status, 'BROKEN');
        assert.strictEqual(res.body.purge.broken.length, 1, 'each distinct misconfiguration is reported once');
        // Actionable, not just "something failed": the peer, and what to check.
        assert.match(res.body.purge.broken[0], /handshake/i);
        assert.match(res.body.purge.broken[0], /127\.0\.0\.1/);
        // And the note tells the operator this will NOT recover on its own — the whole point of
        // separating it from the transient once-an-hour channel.
        assert.match(String(res.body.purge.note), /configuration fault, not an outage/i);
    });

    it('and it goes back to OK once the peer is fixed — WITHOUT restarting the backend', async () => {
        // The state used to be a Set that was only ever added to. But the TLS options are rebuilt on
        // every purge, so the moment the operator repairs the material (or re-enrolls the node) the
        // channel works again — while the panel went on saying BROKEN, with a note insisting it would
        // not recover on its own, until someone restarted the process. An operator who fixes the
        // problem, refreshes the screen that told them to fix it, and is contradicted by it, learns to
        // ignore that screen.
        assert.ok(purgeFailureState().length, 'precondition: the previous test left a permanent fault');

        // Same host, same port, same URL in the config: the ONLY thing that changes is that the peer
        // now presents a certificate from THIS cluster and trusts ours back — i.e. the repair.
        await new Promise<void>((r) => rogueServer.close(() => r()));
        rogueServer = null;
        const frontendLeaf = makeLeaf(clusterCa, 'frontend');
        goodServer = https.createServer(
            { key: frontendLeaf.key, cert: frontendLeaf.cert, ca: clusterCa.pem, requestCert: true, rejectUnauthorized: true },
            (_req: any, res: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"revalidated":true}'); }
        );
        await new Promise<void>((r) => goodServer.listen(peerPort, '127.0.0.1', () => r()));

        purgeFrontend(['posts'], ['/']);

        const deadline = Date.now() + 15000;
        while (purgeFailureState().length && Date.now() < deadline) await sleep(200);
        assert.deepStrictEqual(purgeFailureState(), [], 'a delivered purge retires the fault it reported');

        const res = await request(app)
            .get('/api/v1/health/details')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.purge.status, 'OK', 'the health field must recover on its own');
        assert.deepStrictEqual(res.body.purge.broken, []);
    });

    it('the purge state is admin-only, like the rest of /health/details', async () => {
        const anon = await request(app).get('/api/v1/health/details');
        assert.strictEqual(anon.status, 401);
        const sub = await request(app)
            .get('/api/v1/health/details')
            .set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual(sub.status, 403);

        // The PUBLIC /health stays a liveness probe: it must not leak the cluster's internals.
        const pub = await request(app).get('/api/v1/health');
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.purge, undefined);
    });
});
