/**
 * Tamper evidence for the audit log (core/audit-chain, core/audit-export, routes/audit.ts).
 *
 *   - Every recorded row is sealed into a hash chain; GET /audit/verify recomputes it. A row EDITED in the
 *     database, or one REMOVED, is reported with its place, and Site Health turns red.
 *   - The retention prune keeps the chain verifiable: the gaps it leaves are recorded before it deletes.
 *   - The hashes are the same on SQLite, Postgres and MySQL/MariaDB (each driver hands dates back in its
 *     own form), so a chain moved between engines still verifies.
 *   - An external copy (HTTPS webhook signed with HMAC, or syslog over TCP/UDP) receives every sealed row
 *     with its place and hash, in order; a receiver that is down gets the backlog later.
 *   - Retention can only be shortened, and the copy only changed, with the password; a stored value below
 *     90 days is never used.
 *
 * The defect: the log lived only in the site's database with no way to tell an edited or deleted row, no
 * copy elsewhere, and a retention any administrator could cut.
 *
 * Postgres and MySQL/MariaDB run against real servers with WORDJS_CI_DB=1, and skip without one.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-auditchain-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const d of ['uploads', 'plugins', 'themes']) fs.mkdirSync(path.join(TMP_INSTALL, d), { recursive: true });
const MAIN = 'localhost:3000';
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: `http://${MAIN}` }, null, 2));
process.chdir(TMP_INSTALL);

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = `http://${MAIN}`;
config.site.url = `http://${MAIN}`;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
require('../core/updater')._setForTests({ fetchJson: async () => [] });
const app = require('../index');
const chain = require('../core/audit-chain');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const REAL = process.env.WORDJS_CI_DB === '1';
const SUFFIX = `${process.pid}_${Date.now() % 1e6}`;
let server: any;
let token = '';
const db = () => database.getDbAsync();
const inSite = (fn: () => any) => siteContext.runWithSite(1, fn);

const get = (url: string) => (request(server) as any).get(`${API}${url}`).set('Host', MAIN).set('Authorization', `Bearer ${token}`);
const put = (url: string, body: any) => (request(server) as any).put(`${API}${url}`).set('Host', MAIN).set('Authorization', `Bearer ${token}`).send(body);
const post = (url: string, body: any = {}) => (request(server) as any).post(`${API}${url}`).set('Host', MAIN).set('Authorization', `Bearer ${token}`).send(body);
const record = (action: string, target = 'x') => inSite(() => require('../core/audit').recordAudit(1, action, 'test', target, { n: target }));

/**
 * Wait until what a receiver holds satisfies `ok`. Receivers call `wake()` on every frame, request or
 * datagram, so this resolves on the event itself, never after a fixed tick that a slow runner outlasts.
 * The background delivery (scheduleFlush, a retry) may send a row before or after the test's own
 * "Send now", so tests assert WHAT arrived, never WHICH pass sent it.
 */
const waiters: Array<() => void> = [];
const wake = () => { for (const w of waiters.splice(0)) w(); };
const until = (what: string, ok: () => boolean) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out after 15 s waiting for ${what}`)), 15_000);
    const check = () => { if (ok()) { clearTimeout(timeout); resolve(); } else waiters.push(check); };
    check();
});

// ── The same chain on every engine ──────────────────────────────────────────────────────────────────

async function engineChain(t: any, kind: 'postgres' | 'mysql') {
    if (!REAL) return t.skip(`WORDJS_CI_DB!=1 — no real ${kind}`);
    let driver: any;
    let cleanup: () => Promise<void>;
    if (kind === 'postgres') {
        const { Client } = require('pg');
        const s = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD ?? 'password', name: process.env.PGDATABASE || 'wordjs' };
        const admin = new Client({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.name, connectionTimeoutMillis: 5000 });
        admin.on('error', () => {});
        try { await admin.connect(); } catch (e: any) { return t.skip(`no reachable Postgres: ${e.message}`); }
        const schema = `wjs_c_${SUFFIX}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        driver = new (require('../drivers/postgres').PostgresDriver)();
        driver.config = { ...s, schema, poolMax: 3 };
        await driver.connect();
        cleanup = async () => { try { await driver.close(); } catch { /* */ } try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* */ } try { await admin.end(); } catch { /* */ } };
    } else {
        const mysql = require('mysql2/promise');
        const s = { host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT) || 3306, user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD ?? 'password', name: process.env.MYSQL_DB || 'wordjs' };
        let admin: any;
        try { admin = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, connectTimeout: 5000 }); }
        catch (e: any) { return t.skip(`no reachable MySQL: ${e.message}`); }
        const name = `wjs_c_${SUFFIX}`;
        await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        driver = new (require('../drivers/mysql').MysqlDriver)();
        driver.config = { ...s, name, connectionLimit: 3 };
        await driver.connect();
        cleanup = async () => { try { await driver.close(); } catch { /* */ } try { await admin.query(`DROP DATABASE IF EXISTS ${name}`); } catch { /* */ } try { await admin.end(); } catch { /* */ } };
    }
    const q = { run: (x: string, p: any[] = []) => driver.run(x, p), get: (x: string, p: any[] = []) => driver.get(x, p), all: (x: string, p: any[] = []) => driver.all(x, p) };
    try {
        const { runSchemaMigrations, MIGRATIONS } = require('../core/schema-migrations');
        await runSchemaMigrations(driver, true, kind, MIGRATIONS.filter((m: any) => ['0009_create_audit_log', '0025_audit_log_hash_chain'].includes(m.id)));
        const rows = [
            [7, 'user.role_change', 'user', '12', '{"from":"author","to":"editor"}', '2026-10-26 09:15:42'],
            [null, 'audit.prune', 'audit_log', '', '{"removed":3}', '2026-10-26 23:59:59'],
            [7, 'settings.update', 'settings', '', '{"keys":["blogname","ñandú"]}', '2026-01-01 00:00:00'],
        ];
        for (const r of rows) await q.run('INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', r);
        assert.strictEqual(await chain.sealPending(q), 3, `${kind}: every row is sealed`);
        const report = await chain.verifyAuditChain({}, q);
        assert.strictEqual(report.ok, true, `${kind}: the chain verifies (${JSON.stringify(report.firstBreak)})`);
        assert.strictEqual(report.checked, 3);
        // The same rows give the same hashes as on SQLite: what a driver returns for a date is canonicalized.
        const stored = await q.all('SELECT chain_seq, row_hash FROM audit_log ORDER BY chain_seq');
        let prev = '';
        for (let i = 0; i < rows.length; i++) {
            const [actor, action, tt, tid, detail, at] = rows[i];
            const expected = chain.rowHash(i + 1, prev, { id: i + 1, actor_id: actor, action, target_type: tt, target_id: tid, detail, created_at: at });
            assert.strictEqual(stored[i].row_hash, expected, `${kind}: row ${i + 1} hashes as on every other engine`);
            prev = expected;
        }
        // An edit of any stored field — the date included — is caught.
        await q.run("UPDATE audit_log SET created_at = '2026-10-26 09:15:43' WHERE id = 1");
        const edited = await chain.verifyAuditChain({}, q);
        assert.strictEqual(edited.ok, false);
        assert.deepStrictEqual(edited.firstBreak, { seq: 1, id: 1, reason: 'altered' });
        await q.run("UPDATE audit_log SET created_at = '2026-10-26 09:15:42' WHERE id = 1");
        await q.run('DELETE FROM audit_log WHERE id = 2');
        const removed = await chain.verifyAuditChain({}, q);
        assert.strictEqual(removed.ok, false, `${kind}: a removed row is caught`);
        assert.strictEqual(removed.firstBreak.reason, 'gap');
    } finally {
        await cleanup();
    }
}

test('the hash chain on Postgres (real): same hashes as SQLite, edits and removals caught', (t: any) => engineChain(t, 'postgres'));
test('the hash chain on MySQL/MariaDB (real): same hashes as SQLite, edits and removals caught', (t: any) => engineChain(t, 'mysql'));

// ── The real app on SQLite ───────────────────────────────────────────────────────────────────────────

before(async () => {
    await inSite(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        const r = await db().run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)', ['owner', bcrypt.hashSync(PASSWORD, 4), 'owner@example.com', 'Owner']);
        await db().run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    const res = await (request(server) as any).post(`${API}/auth/login`).set('Host', MAIN).set('Origin', `http://${MAIN}`).send({ username: 'owner', password: PASSWORD });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    token = decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
});

after(async () => {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

describe('Audit log hash chain', () => {
    test('every recorded row is sealed; GET /audit/verify recomputes the chain', async () => {
        for (const n of ['a', 'b', 'c']) await record('user.role_change', n);
        const unsealed = await db().get('SELECT COUNT(*) AS c FROM audit_log WHERE chain_seq IS NULL');
        assert.strictEqual(Number(unsealed.c), 0, 'sealed as they are written');
        const v = await get('/audit/verify');
        assert.strictEqual(v.status, 200);
        assert.strictEqual(v.body.ok, true, JSON.stringify(v.body));
        assert.ok(v.body.checked >= 3);
        const health = await get('/health/site');
        assert.strictEqual(health.body.checks.find((c: any) => c.id === 'security.auditChain').status, 'ok');
        // The existing screen's query is unchanged.
        const list = await get('/audit?per_page=5');
        assert.strictEqual(list.status, 200);
        assert.ok(list.body.entries.length >= 3 && list.body.entries[0].action);
    });

    test('a row edited in the database is reported, and Site Health turns red', async () => {
        const row = await db().get("SELECT id, detail, chain_seq FROM audit_log WHERE target_id = 'b'");
        await db().run('UPDATE audit_log SET detail = ? WHERE id = ?', ['{"n":"z"}', row.id]);
        const v = await get('/audit/verify');
        assert.strictEqual(v.body.ok, false);
        assert.deepStrictEqual(v.body.firstBreak, { seq: Number(row.chain_seq), id: row.id, reason: 'altered' });
        const c = (await get('/health/site')).body.checks.find((x: any) => x.id === 'security.auditChain');
        assert.strictEqual(c.status, 'fail');
        assert.strictEqual(c.messageKey, 'siteHealth.check.security.auditChain.broken.altered');
        assert.strictEqual(c.fix.href, '/admin/audit');
        await db().run('UPDATE audit_log SET detail = ? WHERE id = ?', [row.detail, row.id]);
        assert.strictEqual((await get('/audit/verify')).body.ok, true, 'put back, it verifies again');
    });

    test('the retention prune removes old rows and the chain still verifies; a stored value under 90 days is never used', async () => {
        const { pruneAuditLog, auditRetentionDays } = require('../core/audit');
        const { dbTimestamp } = require('../core/analytics-retention');
        const now = Date.now();
        for (const days of [400, 380]) {
            await db().run("INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at) VALUES (NULL, 'user.role_change', 'user', 'old', '{}', ?)", [dbTimestamp(now - days * 86400000)]);
        }
        await record('user.role_change', 'after-old');
        const removed = await inSite(() => pruneAuditLog(now));
        assert.strictEqual(removed, 2);
        const v = await get('/audit/verify');
        assert.strictEqual(v.body.ok, true, `the gaps the prune left are accounted for: ${JSON.stringify(v.body)}`);
        assert.ok(v.body.anchor && v.body.anchor.seq > 0);

        await inSite(() => require('../core/options').updateOption('audit_retention_days', '1'));
        assert.strictEqual(await inSite(() => auditRetentionDays()), 90, 'a stored 1 day counts as the 90-day floor');
        await inSite(() => require('../core/options').updateOption('audit_retention_days', '365'));
        const { isProtectedOption } = require('../core/plugin-api');
        for (const k of ['audit_retention_days', 'audit_chain_anchor', 'audit_export', 'audit_export_cursor', 'audit_export_secret']) assert.ok(isProtectedOption(k), `${k} is out of plugins' reach`);
    });

    test('shortening the retention takes the password; keeping longer does not', async () => {
        assert.strictEqual((await put('/audit/settings', { retentionDays: 90 })).status, 403);
        assert.strictEqual((await put('/audit/settings', { retentionDays: 90, currentPassword: 'wrong' })).status, 403);
        const ok = await put('/audit/settings', { retentionDays: 90, currentPassword: PASSWORD });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.retentionDays, 90);
        assert.strictEqual((await put('/audit/settings', { retentionDays: 730 })).status, 200);
        assert.strictEqual((await put('/audit/settings', { retentionDays: 1, currentPassword: PASSWORD })).status, 400);
        const row = await db().get("SELECT detail FROM audit_log WHERE action = 'audit.settings.update' ORDER BY id DESC LIMIT 1");
        assert.deepStrictEqual(JSON.parse(row.detail), { retentionFrom: 90, retentionTo: 730 });
    });

    test('a signed webhook receives every sealed row in order; a receiver that was down gets the backlog', async () => {
        const got: any[] = [];
        let up = true;
        const secret = 'test-secret-123';
        const recv = http.createServer((req: any, res: any) => {
            let body = '';
            req.on('data', (c: any) => { body += c; });
            req.on('end', () => {
                if (!up) { res.statusCode = 503; return res.end(); }
                const ts = req.headers['x-wordjs-timestamp'];
                const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
                assert.strictEqual(req.headers['x-wordjs-signature-256'], sig, 'signed with the secret');
                got.push(...JSON.parse(body).events);
                res.end('ok');
                wake();
            });
        });
        await new Promise<void>((r) => recv.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${recv.address().port}/audit`;
        const has = (id: string) => got.some((e) => e.targetId === id);
        try {
            const exportCfg = { mode: 'webhook', url, allowPrivate: true, secret };
            assert.strictEqual((await put('/audit/settings', { export: exportCfg })).status, 403, 'the copy is changed only with the password');
            assert.strictEqual((await put('/audit/settings', { export: { ...exportCfg, allowPrivate: false }, currentPassword: PASSWORD })).status, 400, 'plain http only to a private receiver');
            const saved = await put('/audit/settings', { export: exportCfg, currentPassword: PASSWORD });
            assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
            assert.strictEqual(saved.body.export.hasSecret, true);
            assert.ok(!JSON.stringify(saved.body).includes(secret), 'the secret is never sent back');

            await record('user.role_change', 'w1');
            await record('user.role_change', 'w2');
            await post('/audit/export/flush');
            await until('w1 and w2', () => has('w1') && has('w2'));
            const w2 = got.find((e) => e.targetId === 'w2');
            const stored = await db().get('SELECT row_hash, chain_seq FROM audit_log WHERE target_id = ?', ['w2']);
            assert.strictEqual(w2.rowHash, stored.row_hash, 'the receiver holds the hash');
            assert.strictEqual(w2.seq, Number(stored.chain_seq));

            // A row written straight into the table, not through recordAudit: the copy still carries no secret.
            await db().run("INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at) VALUES (NULL, 'user.role_change', 'user', 'raw', ?, ?)",
                [JSON.stringify({ role: 'editor', password: 'hunter2-raw', apiToken: 'tok-raw' }), require('../core/analytics-retention').dbTimestamp(Date.now())]);
            await record('user.role_change', 'after-raw');
            await post('/audit/export/flush');
            await until('the raw row', () => has('raw'));
            const raw = got.find((e) => e.targetId === 'raw');
            assert.ok(raw, 'the raw row is exported');
            assert.strictEqual(raw.detail.role, 'editor');
            assert.ok(!JSON.stringify(got).includes('hunter2-raw') && !JSON.stringify(got).includes('tok-raw'), 'secrets never leave the site');

            up = false;
            await record('user.role_change', 'while-down');
            await post('/audit/export/flush');
            const down = await get('/health/site');
            assert.strictEqual(down.body.checks.find((c: any) => c.id === 'security.auditExport').status, 'warn', 'a failing copy is a warning');
            up = true;
            await post('/audit/export/flush');
            await until('the backlog (while-down)', () => has('while-down'));
            // "Send now" resolves only after any pass already running AND one more: nothing is left behind.
            const flushed = await post('/audit/export/flush');
            assert.strictEqual(flushed.body.export.behind, 0, JSON.stringify(flushed.body.export));
            assert.strictEqual(flushed.body.export.lastError, null);
            const seqs = got.map((e) => e.seq);
            assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b), `in chain order: ${JSON.stringify(seqs)}`);
            assert.strictEqual(new Set(seqs).size, seqs.length, 'no row is sent twice');
        } finally {
            recv.close();
            await put('/audit/settings', { export: { mode: 'off' }, currentPassword: PASSWORD });
        }
    });

    test('syslog over TCP (octet-counted RFC 5424) and UDP', async () => {
        const tcpConns: string[] = [];
        const tcp = net.createServer((s: any) => {
            const i = tcpConns.push('') - 1;
            s.on('data', (c: any) => { tcpConns[i] += c; wake(); });
        });
        await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
        const udpMsgs: string[] = [];
        const udp = dgram.createSocket('udp4');
        udp.on('message', (m: any) => { udpMsgs.push(String(m)); wake(); });
        await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
        try {
            const tcpCfg = { mode: 'syslog', host: '127.0.0.1', port: tcp.address().port, transport: 'tcp', allowPrivate: true };
            assert.strictEqual((await put('/audit/settings', { export: tcpCfg, currentPassword: PASSWORD })).status, 200);
            await record('user.role_change', 'tcp-1');
            await post('/audit/export/flush');
            await until('the tcp-1 frame', () => tcpConns.some((x) => x.includes('"targetId":"tcp-1"')));
            const conn = tcpConns.find((x) => x.includes('"targetId":"tcp-1"')) as string;
            const m = /^(\d+) (<109>1 .*)$/s.exec(conn);
            assert.ok(m, `octet counted: ${conn.slice(0, 120)}`);
            assert.ok(/ wordjs - audit - \{/.test((m as RegExpExecArray)[2]));

            const udpCfg = { mode: 'syslog', host: '127.0.0.1', port: udp.address().port, transport: 'udp', allowPrivate: true };
            assert.strictEqual((await put('/audit/settings', { export: udpCfg, currentPassword: PASSWORD })).status, 200);
            await record('user.role_change', 'udp-1');
            await post('/audit/export/flush');
            await until('the udp-1 datagram', () => udpMsgs.some((x) => x.includes('"targetId":"udp-1"')));
            assert.ok(udpMsgs.some((x) => x.startsWith('<109>1 ') && x.includes('"targetId":"udp-1"')), JSON.stringify(udpMsgs));

            // The test goes where the SAVED copy goes, never to an address in the request.
            const ok = await post('/audit/export/test', { export: { mode: 'webhook', url: 'https://elsewhere.example/x' } });
            assert.strictEqual(ok.body.ok, true, JSON.stringify(ok.body));
            await until('the test datagram', () => udpMsgs.some((x) => x.includes('"action":"audit.export.test"')));
            assert.ok(udpMsgs.some((x) => x.includes('"action":"audit.export.test"')), 'the test event reached the saved receiver');
            // Without the private-network tick, a private receiver is refused.
            assert.strictEqual((await put('/audit/settings', { export: { ...tcpCfg, allowPrivate: false }, currentPassword: PASSWORD })).status, 200);
            const t = await post('/audit/export/test');
            assert.strictEqual(t.body.ok, false, 'a private address without the tick is not contacted');
        } finally {
            tcp.close();
            udp.close();
            await put('/audit/settings', { export: { mode: 'off' }, currentPassword: PASSWORD });
        }
    });

    test('a flush asked for while one is running also delivers the rows sealed after that one began', async () => {
        const got: string[] = [];
        let hold: (() => void) | null = null;
        let held: () => void = () => {};
        const firstHeld = new Promise<void>((r) => { held = r; });
        const recv = http.createServer((req: any, res: any) => {
            let body = '';
            req.on('data', (c: any) => { body += c; });
            req.on('end', () => {
                const finish = () => { got.push(...JSON.parse(body).events.map((e: any) => e.targetId)); res.end('ok'); };
                if (hold === null) { hold = finish; held(); } else finish();
                wake();
            });
        });
        await new Promise<void>((r) => recv.listen(0, '127.0.0.1', r));
        try {
            const url = `http://127.0.0.1:${recv.address().port}/audit`;
            assert.strictEqual((await put('/audit/settings', { export: { mode: 'webhook', url, allowPrivate: true }, currentPassword: PASSWORD })).status, 200);
            const ex = require('../core/audit-export');
            await record('user.role_change', 'early');
            const first = inSite(() => ex.flushExport());
            await firstHeld; // the first pass is now waiting on the receiver, its batch already read
            await record('user.role_change', 'late');
            const second = inSite(() => ex.flushExport());
            (hold as unknown as () => void)();
            await first;
            await second;
            assert.ok(got.includes('early'), JSON.stringify(got));
            assert.ok(got.includes('late'), `the second flush resolved before "late" was sent: ${JSON.stringify(got)}`);
        } finally {
            recv.close();
            await put('/audit/settings', { export: { mode: 'off' }, currentPassword: PASSWORD });
        }
    });

    test('the delivery position only moves forward: another node that delivered further is not undone', async () => {
        const got: string[] = [];
        let hold: (() => void) | null = null;
        let held: () => void = () => {};
        const firstHeld = new Promise<void>((r) => { held = r; });
        const recv = http.createServer((req: any, res: any) => {
            let body = '';
            req.on('data', (c: any) => { body += c; });
            req.on('end', () => {
                const finish = () => { got.push(...JSON.parse(body).events.map((e: any) => e.targetId)); res.end('ok'); };
                if (hold === null) { hold = finish; held(); } else finish();
            });
        });
        await new Promise<void>((r) => recv.listen(0, '127.0.0.1', r));
        try {
            const url = `http://127.0.0.1:${recv.address().port}/audit`;
            assert.strictEqual((await put('/audit/settings', { export: { mode: 'webhook', url, allowPrivate: true }, currentPassword: PASSWORD })).status, 200);
            const ex = require('../core/audit-export');
            const options = require('../core/options');
            await record('user.role_change', 'n1');
            const first = inSite(() => ex.flushExport());
            await firstHeld; // this node is sending n1
            await record('user.role_change', 'n2');
            await record('user.role_change', 'n3');
            // ...while another node of the cluster delivers n2 and n3 and moves the shared position past them.
            const head = Number((await db().get('SELECT MAX(chain_seq) AS s FROM audit_log')).s);
            await inSite(() => options.updateOption(ex.CURSOR_OPTION, String(head), 'no'));
            (hold as unknown as () => void)();
            await first;
            await inSite(() => ex.flushExport());
            assert.strictEqual(Number(await inSite(() => options.getOptionFresh(ex.CURSOR_OPTION, 0))), head, 'the position is not moved back');
            assert.deepStrictEqual(got.filter((x) => x === 'n2' || x === 'n3'), [], `rows the other node delivered are not sent again: ${JSON.stringify(got)}`);
        } finally {
            recv.close();
            await put('/audit/settings', { export: { mode: 'off' }, currentPassword: PASSWORD });
        }
    });

    test('a removed row is reported as a gap', async () => {
        const row = await db().get("SELECT id, chain_seq FROM audit_log WHERE target_id = 'a'");
        await db().run('DELETE FROM audit_log WHERE id = ?', [row.id]);
        const v = await get('/audit/verify');
        assert.strictEqual(v.body.ok, false);
        assert.strictEqual(v.body.firstBreak.seq, Number(row.chain_seq) + 1);
        assert.ok(['gap', 'start'].includes(v.body.firstBreak.reason));
    });
});
