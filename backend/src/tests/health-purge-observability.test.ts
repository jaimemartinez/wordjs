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
 *
 * ---------------------------------------------------------------------------------------------------
 * The nested block at the bottom covers TWO MORE degradations of exactly the same class — permanent,
 * invisible, announced once as a console line on a boot nobody watches:
 *
 *   · the database manager falling back to the pure-JS `sqlite-legacy` driver, which has no FTS5, so
 *     ranked full-text search silently becomes LIKE matching;
 *   · isolated plugins running with NO CPU bound (cgroup mode with `sandbox.cpuQuotaPercent` at 0);
 *   · the audit-log retention prune falling BEHIND — stopping at its per-run cap with rows still
 *     outside the window, i.e. losing the race against a write side that every failed login feeds.
 *     `auditRetentionState()` was exported "for the cron log and for anyone asking whether retention
 *     is keeping up" and read by nobody, so the only trace was a console.warn on a cron tick.
 *
 * They live here because the surface is the same one: this file already boots a real database, mints a
 * real administrator token and reads `/health/details` back over the REAL routes tree, and the notice
 * they raise goes into the same `admin_notices` option the /admin/notices screen renders.
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

    /**
     * NESTED so it runs inside this file's live database (the outer `after` closes it), and so the
     * admin token and the real routes tree above are reused rather than rebuilt.
     */
    describe('the silent degradations an operator used to have to read the boot log to find', () => {
        const DB_NOTICE_ID = 'db.sqlite-legacy-fallback';
        const CPU_STATES = ['unbounded', 'preventive', 'reactive'];
        let options: any;
        let notices: any;
        let realDegradationGetter: any = null;

        const noticeIds = async (): Promise<string[]> => {
            const stored = await options.getOption('admin_notices', []);
            return (Array.isArray(stored) ? stored : []).map((n: any) => n && n.id);
        };

        before(() => {
            options = require('../core/options');
            notices = require('../core/admin-notices');
        });

        after(async () => {
            // Never leave a stub or a notice behind for whatever runs next in this process.
            if (realDegradationGetter) database.getDriverDegradation = realDegradationGetter;
            try { await options.updateOption('admin_notices', []); } catch { /* ignore */ }
        });

        // The state cannot be produced for real in-suite (better-sqlite3 cannot be made to vanish
        // mid-process), so the DEGRADATION is the fixture and everything downstream of it — the health
        // report, the notice, the retirement — is the real code.
        const FORCED = {
            driverRequested: 'sqlite-native',
            driverActive: 'sqlite-legacy',
            reason: "'sqlite-native' failed to load (Could not locate the bindings file) — the pure-JS "
                + "'sqlite-legacy' driver has no FTS5, so ranked full-text search is unavailable and site "
                + 'search falls back to LIKE matching',
            at: new Date('2026-09-01T10:00:00.000Z').toISOString(),
        };

        it('/health/details flags the sqlite-legacy fallback and names the driver that is REALLY running', async () => {
            realDegradationGetter = database.getDriverDegradation;
            database.getDriverDegradation = () => FORCED;

            const res = await request(app)
                .get('/api/v1/health/details')
                .set('Authorization', `Bearer ${adminToken}`);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.database, '/health/details must carry a database section');
            assert.strictEqual(res.body.database.degraded, true);
            // Actionable, not just "degraded": what was lost, and why.
            assert.match(String(res.body.database.reason), /full-text/i);
            assert.match(String(res.body.database.reason), /LIKE/);
            // The ACTIVE driver, asked of the manager — not `config.dbDriver`, which is the request.
            assert.strictEqual(res.body.database.driver, database.getDbType().driver);

            // And it is not a field stuck at true: with the real getter back, the flag goes.
            database.getDriverDegradation = realDegradationGetter;
            realDegradationGetter = null;
            const healthy = await request(app)
                .get('/api/v1/health/details')
                .set('Authorization', `Bearer ${adminToken}`);
            assert.strictEqual(healthy.body.database.degraded, false);
            assert.strictEqual(healthy.body.database.reason, undefined);
        });

        it('the fallback leaves ONE persistent admin notice, and a healthy boot retires it', async () => {
            // Two "boots" on the broken driver — the notice is a STATE, not an event, so it must not
            // accumulate the way CrashGuard's append-only rows do.
            await database.reportDriverDegradation(FORCED);
            await database.reportDriverDegradation(FORCED);

            const stored = await options.getOption('admin_notices', []);
            const rows = (Array.isArray(stored) ? stored : []).filter((n: any) => n && n.id === DB_NOTICE_ID);
            assert.strictEqual(rows.length, 1, 'a re-raised condition must upsert, never append');
            assert.strictEqual(rows[0].type, 'error');
            assert.strictEqual(rows[0].dismissible, true);
            // The date is the CONDITION's, not the write's: a months-old fault must not sort to the top
            // of /admin/notices as if it were new on every restart.
            assert.strictEqual(rows[0].timestamp, Date.parse(FORCED.at));
            // It says what was lost and how to fix it — the whole reason it is not just a log line.
            assert.match(rows[0].message, /search/i);
            assert.match(rows[0].message, /better-sqlite3|dbDriver/);

            // A boot on the requested driver retires it, WITHOUT anyone dismissing it by hand.
            await database.reportDriverDegradation(null);
            assert.ok(!(await noticeIds()).includes(DB_NOTICE_ID), 'a healthy boot must retire the notice');
        });

        it('pushAdminNotice is idempotent by id, and clearAdminNotice removes exactly that row', async () => {
            const id = 'test.admin-notice-idempotence';
            const input = {
                id,
                level: 'warning',
                title: 'Something to fix:',
                message: 'the same condition, observed twice',
                since: 1_700_000_000_000,
            };

            assert.strictEqual(await notices.pushAdminNotice(input), true);
            assert.strictEqual(await notices.pushAdminNotice(input), true);

            const stored = await options.getOption('admin_notices', []);
            const rows = (Array.isArray(stored) ? stored : []).filter((n: any) => n && n.id === id);
            assert.strictEqual(rows.length, 1, 'calling twice must leave one entry');
            assert.strictEqual(rows[0].timestamp, 1_700_000_000_000);
            // The stored shape is the one /admin/notices already normalises — a new writer must not
            // invent a dialect the screen would drop or render as "neutral".
            assert.deepStrictEqual(
                Object.keys(rows[0]).sort(),
                ['dismissible', 'id', 'message', 'timestamp', 'type']
            );
            assert.strictEqual(rows[0].type, 'warning');
            assert.match(rows[0].message, /Something to fix/);

            assert.strictEqual(await notices.clearAdminNotice(id), true);
            assert.ok(!(await noticeIds()).includes(id), 'clearAdminNotice must remove the row');
            // Idempotent in that direction too: clearing what is already gone is a no-op, not an error.
            assert.strictEqual(await notices.clearAdminNotice(id), true);
        });

        it('/health/details states the sandbox CPU bound, in one of the three words that mean something', async () => {
            const res = await request(app)
                .get('/api/v1/health/details')
                .set('Authorization', `Bearer ${adminToken}`);
            assert.strictEqual(res.status, 200);
            assert.ok(
                CPU_STATES.includes(res.body.sandbox.cpu),
                `sandbox.cpu must be one of ${CPU_STATES.join('/')}, got ${JSON.stringify(res.body.sandbox.cpu)}`
            );
            // It is the ISOLATE's answer, not a value the route invented.
            assert.strictEqual(res.body.sandbox.cpu, require('../core/plugin-isolate').getSandboxCpuBound());
            // The rest of the sandbox section survives the merge.
            assert.ok(res.body.sandbox.status, 'sandbox.status must still be reported');
        });

        it('/health/details says whether audit-log retention is keeping up', async () => {
            const audit = require('../core/audit');
            const details = async () => request(app)
                .get('/api/v1/health/details')
                .set('Authorization', `Bearer ${adminToken}`);

            // A REAL prune over the REAL table first — nothing here pokes the state the endpoint reads.
            await audit.pruneAuditLog();
            const healthy = await details();
            assert.strictEqual(healthy.status, 200);
            assert.ok(healthy.body.audit, '/health/details must carry an audit section');
            assert.strictEqual(healthy.body.audit.retentionDays, audit.DEFAULT_AUDIT_RETENTION_DAYS,
                'the window the prune actually used is reported, not re-derived by the reader');
            assert.strictEqual(healthy.body.audit.behind, false, 'a prune with nothing left to do is not behind');
            assert.ok(Number.isFinite(healthy.body.audit.lastRunAt), 'and it says WHEN it last ran');

            // The differential half: make retention really fall behind — rows outside the window and a
            // run that stops at its cap — and the flag has to move. A field stuck at false reports
            // nothing, which is indistinguishable from the console.warn nobody read.
            const { dbTimestamp } = require('../core/analytics-retention');
            const stale = dbTimestamp(Date.now() - 400 * 86400000);
            const dbAsync = database.getDbAsync();
            for (let i = 0; i < 3; i++) {
                await dbAsync.run(
                    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
                     VALUES (NULL, 'audit.prune', 'audit_log', 'retention-fixture', '{}', ?)`,
                    [stale]);
            }
            const removed = await audit.pruneAuditLog(null, { maxRows: 1 });
            assert.strictEqual(removed, 1, 'the capped run removes exactly its cap');

            const behind = await details();
            assert.strictEqual(behind.body.audit.behind, true,
                'a run that stopped at a cap with rows still outside the window is BEHIND, and must say so');
            assert.strictEqual(behind.body.audit.lastRemoved, 1);

            // …and it clears by itself once the prune catches up — an operator who fixes the problem and
            // is contradicted by the screen that told them to fix it learns to ignore that screen.
            await audit.pruneAuditLog();
            const caughtUp = await details();
            assert.strictEqual(caughtUp.body.audit.behind, false);
            assert.strictEqual(
                (await dbAsync.get("SELECT COUNT(*) AS c FROM audit_log WHERE target_id = 'retention-fixture'")).c,
                0, 'the fixture rows really were pruned, so the flag cleared for the right reason');
        });
    });
});
