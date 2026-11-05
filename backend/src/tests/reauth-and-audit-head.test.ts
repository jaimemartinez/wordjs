/**
 * Re-authentication on the routes that hand out authority or move a stored secret, and the audit log's
 * protection against losing its newest rows.
 *
 *   - POST /users takes a role as a name only; POST /import with accounts, POST /roles adding a privileged
 *     capability, a backup restore and accepting changed plugin files all take the caller's password.
 *   - PUT /ai/settings pointing the stored key at another server takes the password.
 *   - Removing the newest audit rows leaves no gap in the chain, so the head mark next to the database is what
 *     reports them; a restore or an accepted loss accounts for them.
 *   - The external copy: a private receiver never reaches link-local addresses, is the main site's to
 *     allow, reports no socket detail, and turning it back on towards the same receiver loses nothing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-reauth-${process.pid}-`));
config.dbPath = path.join(TMP_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
const { updateOption } = require('../core/options');
const { recordAudit } = require('../core/audit');
const chain = require('../core/audit-chain');
const auditExport = require('../core/audit-export');
const integrity = require('../core/plugin-integrity');
const multisiteGuards = require('../core/multisite-guards');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(`${B}/backups`, require('../routes/backups'));
app.use(B, require('../routes'));

let dbAsync: any;
let ownerId = 0;
const session = () => `Bearer ${jwt.sign({ userId: ownerId, username: 'owner' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;
const post = (url: string, body: any = {}) => request(app).post(`${B}${url}`).set('Authorization', session()).send(body);
const put = (url: string, body: any = {}) => request(app).put(`${B}${url}`).set('Authorization', session()).send(body);
const verify = async () => (await request(app).get(`${B}/audit/verify`).set('Authorization', session())).body;
const sudoAsked = (res: any, label: string) => {
    assert.strictEqual(res.status, 403, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'rest_sudo_required', label);
};

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync(PASSWORD, 10), 'owner@example.com', 'owner']);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
    ownerId = r.lastID;
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
});

describe('POST /users', () => {
    it('refuses a role that is not a name: a one-item list never reaches the step-up check as "not privileged"', async () => {
        const res = await post('/users', { username: 'listed', email: 'listed@example.com', password: PASSWORD, role: ['administrator'] });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_invalid_role');
        assert.ok(!(await User.findByLogin('listed')));
    });

    it('the model refuses it too, for every other caller', async () => {
        await assert.rejects(() => User.create({ username: 'direct', email: 'direct@example.com', password: PASSWORD, role: ['administrator'] }), /Invalid role/);
    });

    it('a privileged role by name still takes the password (control)', async () => {
        sudoAsked(await post('/users', { username: 'named', email: 'named@example.com', password: PASSWORD, role: 'administrator' }), 'POST /users');
    });
});

describe('POST /import with accounts', () => {
    const body = (extra: any = {}) => ({ importUsers: true, ...extra, data: { version: '1.0', content: { users: [{ id: 900, username: 'imported', email: 'imported@example.com', role: 'administrator' }] } } });

    it('takes the password, and creates nothing without it', async () => {
        sudoAsked(await post('/import', body()), 'POST /import');
        assert.ok(!(await User.findByLogin('imported')));
        const ok = await post('/import', body({ currentPassword: PASSWORD }));
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.ok(await User.findByLogin('imported'));
    });

    it('a rewritten address ends the reset link sent to the old one', async () => {
        const user = await User.findByLogin('imported');
        await User.updateMeta(user.id, 'password_reset_hash', 'pending');
        const res = await post('/import', { importUsers: true, updateExisting: true, currentPassword: PASSWORD, data: { version: '1.0', content: { users: [{ id: 900, username: 'imported', email: 'moved@example.com' }] } } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await User.getMeta(user.id, 'password_reset_hash'), '');
    });

    it('content without accounts needs no password (control)', async () => {
        const res = await post('/import', { data: { version: '1.0', settings: { blogdescription: 'Imported' } } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
});

describe('POST /roles', () => {
    it('adding a privileged capability takes the password, in both forms a role is written', async () => {
        sudoAsked(await post('/roles', { slug: 'subscriber', name: 'Subscriber', capabilities: ['*'] }), 'list');
        sudoAsked(await post('/roles', { slug: 'subscriber', name: 'Subscriber', capabilities: { manage_options: true } }), 'map');
        assert.ok(!roles.getRole('subscriber').capabilities.includes('*'));
    });

    it('with the password it is applied, and the audit log says what changed', async () => {
        const res = await post('/roles', { slug: 'helper', name: 'Helper', capabilities: ['read', 'edit_users'], currentPassword: PASSWORD });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        await chain.sealPending();
        const row = await dbAsync.get("SELECT detail FROM audit_log WHERE action = 'role.update' AND target_id = 'helper'");
        assert.ok(row, 'an audit row was written');
        assert.deepStrictEqual(JSON.parse(row.detail).added, ['read', 'edit_users']);
    });

    it('a capability that gives no authority over accounts needs no password (control)', async () => {
        const res = await post('/roles', { slug: 'reader', name: 'Reader', capabilities: ['read'] });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
});

describe('PUT /ai/settings', () => {
    const openai = { provider: 'openai-compatible', model: 'm' };

    before(async () => {
        const res = await put('/ai/settings', { ...openai, baseUrl: 'https://one.example/v1', apiKey: 'sk-lab-0000' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });

    it('moving the stored key to another server takes the password', async () => {
        sudoAsked(await put('/ai/settings', { ...openai, baseUrl: 'https://two.example/v1' }), 'new base URL');
        sudoAsked(await put('/ai/settings', { provider: 'anthropic' }), 'new provider');
        const ok = await put('/ai/settings', { ...openai, baseUrl: 'https://two.example/v1', currentPassword: PASSWORD });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.baseUrl, 'https://two.example/v1');
    });

    it('needs nothing when the key stays, is replaced, or is cleared (control)', async () => {
        assert.strictEqual((await put('/ai/settings', { ...openai, baseUrl: 'https://two.example/v1', model: 'other' })).status, 200);
        assert.strictEqual((await put('/ai/settings', { ...openai, baseUrl: 'https://three.example/v1', apiKey: 'sk-lab-1111' })).status, 200);
        assert.strictEqual((await put('/ai/settings', { ...openai, baseUrl: 'https://four.example/v1', clearKey: true })).status, 200);
    });
});

describe('accepting changed plugin files', () => {
    it('takes the password and leaves an audit row', async () => {
        const list = integrity.listIntegrityMismatches;
        const accept = integrity.acceptPluginIntegrity;
        const accepted: string[] = [];
        integrity.listIntegrityMismatches = () => ['changed-plugin'];
        integrity.acceptPluginIntegrity = (_root: string, slug: string) => { accepted.push(slug); };
        try {
            sudoAsked(await post('/health/sandbox/plugin-files/accept', { slug: 'changed-plugin' }), 'accept');
            assert.deepStrictEqual(accepted, []);
            const ok = await post('/health/sandbox/plugin-files/accept', { slug: 'changed-plugin', currentPassword: PASSWORD });
            assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
            assert.deepStrictEqual(accepted, ['changed-plugin']);
            assert.ok(await dbAsync.get("SELECT id FROM audit_log WHERE action = 'plugin.files.accept' AND target_id = 'changed-plugin'"));
        } finally {
            integrity.listIntegrityMismatches = list;
            integrity.acceptPluginIntegrity = accept;
        }
    });
});

describe('POST /backups/:filename/restore', () => {
    it('takes the password before it looks at the file', async () => {
        sudoAsked(await post('/backups/none.zip/restore'), 'restore');
    });
});

describe('the head mark', () => {
    const record = async (n: number) => {
        for (let i = 0; i < n; i++) await recordAudit(ownerId, 'test.event', 'test', String(i), {});
        await chain.sealPending();
    };
    const dropNewest = async (n: number) => {
        const head = await chain.chainHeadSeq();
        await dbAsync.run('DELETE FROM audit_log WHERE chain_seq > ?', [head - n]);
        return head;
    };

    it('reports the newest rows gone, which the chain alone cannot see', async () => {
        await record(4);
        assert.strictEqual((await verify()).ok, true);
        const lost = await dropNewest(3);
        const report = await verify();
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.firstBreak.reason, 'truncated');
        assert.strictEqual(report.firstBreak.seq, lost);
    });

    it('writing new rows past the loss does not hide it', async () => {
        await record(6);
        const report = await verify();
        assert.strictEqual(report.ok, false, 'the head is past the old mark, but that place holds another row now');
        assert.strictEqual(report.firstBreak.reason, 'truncated');
    });

    it('an accepted loss takes the password, is recorded, and checks go on from the head', async () => {
        sudoAsked(await post('/audit/head/accept'), 'accept');
        const ok = await post('/audit/head/accept', { currentPassword: PASSWORD });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        const report = await verify();
        assert.strictEqual(report.ok, true, JSON.stringify(report));
        assert.ok(report.rewinds.some((r: any) => r.action === 'audit.head.accept'));
        assert.strictEqual((await post('/audit/head/accept', { currentPassword: PASSWORD })).status, 409, 'nothing left to accept');
        await record(1);
        await dropNewest(1);
        assert.strictEqual((await verify()).ok, false, 'a later loss is reported again');
        assert.strictEqual((await post('/audit/head/accept', { currentPassword: PASSWORD })).status, 200);
    });

    it('a restore accounts for what it took back, and says how far', async () => {
        await record(3);
        const fromSeq = await dropNewest(3);
        const toSeq = await chain.chainHeadSeq();
        await recordAudit(ownerId, 'backup.restore', 'backup', 'x.zip', { fromSeq, toSeq });
        const report = await verify();
        assert.strictEqual(report.ok, true, JSON.stringify(report));
        assert.deepStrictEqual({ fromSeq: report.rewinds[0].fromSeq, toSeq: report.rewinds[0].toSeq }, { fromSeq, toSeq });
    });

    it('a row the retention prune removed is no loss', async () => {
        await record(2);
        const head = await chain.chainHeadSeq();
        const row = await dbAsync.get('SELECT row_hash FROM audit_log WHERE chain_seq = ?', [head]);
        const mark = path.join(TMP_DIR, 'sandbox', 'audit-head');
        assert.ok(fs.readdirSync(mark).length === 1, 'the mark lives next to the database');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(mark, fs.readdirSync(mark)[0]), 'utf8')).hash, row.row_hash);
        await updateOption(chain.ANCHOR_OPTION, JSON.stringify({ seq: head, hash: row.row_hash, holes: { [String(head)]: row.row_hash } }), 'no');
        await dbAsync.run('DELETE FROM audit_log WHERE chain_seq = ?', [head]);
        assert.strictEqual(await chain.headLoss(), null);
        await updateOption(chain.ANCHOR_OPTION, '', 'no');
        await recordAudit(ownerId, 'backup.restore', 'backup', 'y.zip', { fromSeq: head, toSeq: head - 1 });
        await chain.sealPending();
    });

    it('a new installation forgets the mark', async () => {
        chain.forgetHeadMark();
        assert.strictEqual(await chain.headLoss(), null);
        await chain.sealPending();
    });
});

describe('the external copy', () => {
    const webhook = (url: string, extra: any = {}) => put('/audit/settings', { export: { mode: 'webhook', url, allowPrivate: true, ...extra }, currentPassword: PASSWORD });
    const off = () => put('/audit/settings', { export: { mode: 'off' }, currentPassword: PASSWORD });

    it('says the same about a closed port and an open one that refuses', async () => {
        const server = http.createServer((_q: any, s: any) => { s.statusCode = 404; s.end(); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const open = server.address().port;
        try {
            assert.strictEqual((await webhook(`http://127.0.0.1:${open}/`)).status, 200);
            const answered = (await post('/audit/export/test')).body;
            await new Promise<void>((r) => server.close(() => r()));
            assert.strictEqual((await webhook(`http://127.0.0.1:${open}/x`)).status, 200);
            const refused = (await post('/audit/export/test')).body;
            assert.strictEqual(answered.ok, false);
            assert.deepStrictEqual(answered, refused);
        } finally { await off(); }
    });

    it('never reaches a link-local address, even on a private network', async () => {
        try {
            assert.strictEqual((await webhook('http://169.254.169.254/latest/')).status, 200);
            const res = (await post('/audit/export/test')).body;
            assert.strictEqual(res.ok, false);
            assert.match(res.error, /can never receive/);
        } finally { await off(); }
    });

    it('a site of a network cannot allow a private receiver, and one it saved earlier is not honoured', async () => {
        const server = http.createServer((_q: any, s: any) => { s.statusCode = 200; s.end(); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const url = `http://127.0.0.1:${server.address().port}/`;
        const real = multisiteGuards.onSecondarySite;
        try {
            assert.strictEqual((await webhook(url)).status, 200);
            multisiteGuards.onSecondarySite = () => true;
            assert.strictEqual((await webhook(`${url}other`)).status, 400);
            const res = (await post('/audit/export/test')).body;
            assert.strictEqual(res.ok, false);
            assert.match(res.error, /private address/);
        } finally {
            multisiteGuards.onSecondarySite = real;
            await off();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('a receiver that closes in the middle of its answer ends the delivery', async () => {
        const server = http.createServer((_q: any, s: any) => { s.writeHead(200, { 'Content-Length': '100' }); s.write('x'); setTimeout(() => s.destroy(), 20); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        try {
            assert.strictEqual((await webhook(`http://127.0.0.1:${server.address().port}/`)).status, 200);
            const started = Date.now();
            assert.strictEqual((await post('/audit/export/test')).body.ok, false);
            assert.ok(Date.now() - started < 5000);
        } finally {
            await off();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('turned back on towards the same receiver, it gets what happened meanwhile; a new receiver starts at the head', async () => {
        const got: number[] = [];
        const server = http.createServer((q: any, s: any) => {
            let b = '';
            q.on('data', (d: any) => { b += d; });
            q.on('end', () => { for (const e of JSON.parse(b).events) got.push(e.seq); s.statusCode = 200; s.end(); });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const url = `http://127.0.0.1:${server.address().port}/`;
        try {
            assert.strictEqual((await webhook(url)).status, 200);
            await auditExport.flushExport();
            await off();
            await recordAudit(ownerId, 'test.while.off', 'test', '', {});
            await chain.sealPending();
            const missed = await chain.chainHeadSeq();
            assert.strictEqual((await webhook(url)).status, 200);
            await chain.sealPending();
            await auditExport.flushExport();
            assert.ok(got.includes(missed), `the row sealed while off was delivered: ${got.join(',')}`);

            await off();
            await recordAudit(ownerId, 'test.while.off', 'test', '', {});
            await chain.sealPending();
            const skipped = await chain.chainHeadSeq();
            assert.strictEqual((await webhook(`${url}new`)).status, 200);
            await chain.sealPending();
            await auditExport.flushExport();
            assert.ok(!got.includes(skipped), 'a new receiver does not get the backlog');
        } finally {
            await off();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });
});
