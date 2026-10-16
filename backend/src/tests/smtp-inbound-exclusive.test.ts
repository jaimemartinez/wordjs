/**
 * smtp:inbound — the EXCLUSIVE capability that makes the HOST listen on the SMTP port for one plugin.
 *
 * Two halves, both against the real modules:
 *   · the grant store (core/plugin-permissions) on a real SQLite database: an administrator's grant of
 *     smtp:inbound to a second plugin is refused (409 through the real permissions route) naming the
 *     holder; the automatic writers (grant-on-activate) leave it out instead of taking it; revoking it
 *     frees it for another plugin;
 *   · the host listener (core/inbound-smtp) with a real smtp-server on a free local port and a real
 *     nodemailer client: every SMTP step reaches the plugin's verdict, a refusal carries the plugin's
 *     code, a plugin failure is a TEMPORARY 451 (never a silent accept), the port must be declared, one
 *     owner at a time, and a busy port falls back with the reason recorded.
 */
process.env.NODE_ENV = 'production';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-smtp-inbound-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');
const perms = require('../core/plugin-permissions');
const pluginsRouter = require('../routes/plugins');
const inbound = require('../core/inbound-smtp');

const A = `wjs-smtp-a-${process.pid}`;
const B = `wjs-smtp-b-${process.pid}`;
const C = `wjs-smtp-c-${process.pid}`;
const app = express();
app.use(express.json());
app.use('/api/v1/plugins', pluginsRouter);
let adminToken = '';

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const User = require('../models/User');
    const admin = await User.create({ username: 'smtpadmin', email: 'smtpadmin@example.com', password: 'correct-horse-battery-9', role: 'administrator' });
    adminToken = jwt.sign({ userId: admin.id, username: 'smtpadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    await perms.loadGrants();
}, { timeout: 60000 });

after(async () => {
    for (const s of [A, B, C, 'other-plugin']) { try { await inbound.stop(s); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

// ── the grant store ────────────────────────────────────────────────────────────────────────────────

test('only ONE plugin may hold smtp:inbound: a second administrator grant is refused, naming the holder', async () => {
    await perms.setGrants(A, ['smtp:inbound', 'database:read'], { adminDecision: true });
    assert.equal(perms.getExclusiveHolder('smtp:inbound'), A);

    await perms.setGrants(B, ['database:read'], { adminDecision: true });
    await assert.rejects(
        perms.applyGrants(B, ['smtp:inbound', 'database:write'], { adminDecision: true }),
        (e: any) => e.code === 'plugin_grant_exclusive' && e.status === 409 && e.conflicts[0].holder === A
    );
    assert.deepEqual(perms.getGrants(B), ['database:read'], 'nothing of the refused set was written');
    assert.equal(perms.isGranted(B, 'smtp', 'inbound'), false);

    // Through the real permissions route: 409 with the holder, nothing written.
    const res = await request(app).post(`/api/v1/plugins/${B}/permissions`)
        .set('Authorization', `Bearer ${adminToken}`).send({ granted: ['smtp:inbound'] });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'plugin_grant_exclusive');
    assert.equal(res.body.conflicts[0].holder, A);
    assert.deepEqual(perms.getGrants(B), ['database:read']);
});

test('grant-on-activate never takes an exclusive grant from its holder — it stores the rest', async () => {
    const seeded = await perms.seedGrants(C, ['smtp:inbound', 'database:read', 'network'], { adminDecision: true });
    assert.equal(seeded, true);
    assert.deepEqual(perms.getGrants(C).sort(), ['database:read', 'network']);
    assert.equal(perms.getExclusiveHolder('smtp:inbound'), A);
});

test('re-saving the holder keeps it; revoking it frees the capability for another plugin', async () => {
    await perms.setGrants(A, ['smtp:inbound'], { adminDecision: true }); // the holder itself is never "in conflict"
    await perms.setGrants(A, ['database:read'], { adminDecision: true });
    assert.equal(perms.getExclusiveHolder('smtp:inbound'), null);
    await perms.setGrants(B, ['smtp:inbound'], { adminDecision: true });
    assert.equal(perms.getExclusiveHolder('smtp:inbound'), B);
    assert.equal(perms.isGranted(B, 'smtp', 'inbound'), true);
    assert.equal(perms.isGranted(B, 'smtp', 'admin'), false);
    // `admin` on a scope never implies the special verb.
    await perms.setGrants(C, ['smtp:admin'], { adminDecision: true });
    assert.equal(perms.isGranted(C, 'smtp', 'inbound'), false);
});

// ── the host listener ──────────────────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

function send(port: number, msg: any): Promise<any> {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, connectionTimeout: 5000 });
    return t.sendMail(msg).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, e }));
}

test('the host runs the SMTP transaction and the plugin decides every step', async () => {
    const port = await freePort();
    const seen: any[] = [];
    const invoke = async (phase: string, args: any[]) => {
        seen.push({ phase, args });
        if (phase === 'rcptTo' && args[0].address === 'nobody@acme.test') return { code: 550, message: '5.1.1 No such user' };
        return null;
    };
    const st = await inbound.start(A, { port }, [port], invoke);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.boundPort, port);
    assert.equal(inbound.getStatus().owner, A);

    const okRes = await send(port, { from: 'ext@outside.test', to: 'alice@acme.test', subject: 'Hello', text: 'Body text' });
    assert.equal(okRes.ok, true, okRes.e && okRes.e.message);
    const data = seen.find(s => s.phase === 'data');
    assert.ok(data, 'the DATA step reached the plugin');
    const raw = Buffer.from(data.args[0], 'base64').toString('utf8');
    assert.match(raw, /Subject: Hello/);
    assert.equal(data.args[1].envelope.mailFrom.address, 'ext@outside.test');
    assert.deepEqual(data.args[1].envelope.rcptTo.map((r: any) => r.address), ['alice@acme.test']);
    assert.ok(seen.some(s => s.phase === 'connect') && seen.some(s => s.phase === 'mailFrom'));
    assert.ok(data.args[1].id && seen.filter(s => s.args[s.args.length - 1]?.id === data.args[1].id).length >= 3, 'one session id across the steps');

    const refused = await send(port, { from: 'ext@outside.test', to: 'nobody@acme.test', subject: 'x', text: 'x' });
    assert.equal(refused.ok, false);
    assert.equal(refused.e.responseCode, 550, 'the plugin\'s own code reaches the sender');
    await inbound.stop(A);
});

test('a plugin that throws gets the sender a TEMPORARY 451, never a silent accept', async () => {
    const port = await freePort();
    await inbound.start(A, { port }, [port], async (phase: string) => { if (phase === 'data') throw new Error('boom'); return null; });
    const res = await send(port, { from: 'a@outside.test', to: 'b@acme.test', subject: 'x', text: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.e.responseCode, 451);
    await inbound.stop(A);
});

test('one owner at a time, the port must be declared, and a busy port falls back with the reason', async () => {
    const port = await freePort();
    const fallback = await freePort();
    const nothing = async () => null;

    const undeclared = await inbound.start(A, { port }, [25], nothing);
    assert.equal(undeclared.ok, false);
    assert.match(undeclared.error, /claimPorts/);

    const st = await inbound.start(A, { port }, [port], nothing);
    assert.equal(st.ok, true);
    const other = await inbound.start('other-plugin', { port }, [port], nothing);
    assert.equal(other.ok, false);
    assert.match(other.error, new RegExp(`owned by plugin '${A}'`));
    await inbound.stop('other-plugin'); // not the owner: a no-op
    assert.equal(inbound.getStatus().owner, A);
    await inbound.stop(A);
    assert.equal(inbound.getStatus().owner, null);

    // Something else holds the port: fall back, and say why.
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, '0.0.0.0', () => r()));
    try {
        const fb = await inbound.start(A, { port, fallbackPort: fallback }, [port], nothing);
        assert.equal(fb.ok, true, JSON.stringify(fb));
        assert.equal(fb.boundPort, fallback);
        assert.equal(fb.degraded, true);
        assert.match(String(fb.reason), /already in use/);
    } finally {
        await inbound.stop(A);
        await new Promise<void>((r) => squatter.close(() => r()));
    }
});
