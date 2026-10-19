/**
 * ACCOUNT EMAIL — password-reset and verification links never reach a mail provider plugin unless an
 * administrator allowed that plugin BY NAME; by default the host sends them itself (core/account-mail).
 *
 * Through the REAL producers: the auth router (POST /auth/forgot-password, /auth/reset-password), the
 * /account-mail admin router, a provider registered the way the plugin bridge registers one
 * (core/mail-provider setMailProvider with the plugin's folder), a real SMTP sink (smtp-server on
 * loopback) behind the built-in transport, and migration 0018 against the real database. Pins:
 *   1. a live provider that was NOT allowed receives no reset link (and the answer is the same 200);
 *   2. allowing it needs the administrator's password, is per plugin, and another plugin that becomes the
 *      provider later inherits nothing;
 *   3. the built-in transport delivers the reset link over SMTP and takes precedence over any provider;
 *      its password is never returned; an unencrypted relay is refused unless it is on this machine;
 *   4. using a reset link notifies every OTHER administrator in-app;
 *   5. migration 0018 keeps an upgraded site's existing provider allowed (and records nothing on a new one);
 *   6. none of the routing options is reachable from the plugin options bridge.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-account-mail-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PASSWORD = 'Admin-passphrase-123!';
const RESET_LINK_RE = /\/reset-password\?uid=(\d+)&token=([a-f0-9]+)/i;

let request: any;
let app: any;
let dbAsync: any;
let User: any;
let mailProvider: any;
let options: any;
const ids: Record<string, number> = {};
const as = (who: string) => ({ Authorization: `Bearer ${jwt.sign({ userId: ids[who], username: who }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });

// Two plugins' providers, as the bridge registers them (the slug is the plugin folder).
const providerA: any[] = [];
const providerB: any[] = [];
const sendA = (m: any) => { providerA.push(m); return { queued: true }; };
const sendB = (m: any) => { providerB.push(m); return { queued: true }; };

// A real SMTP server on loopback for the built-in transport.
let smtp: any;
let smtpPort = 0;
const smtpMessages: string[] = [];

async function waitFor(pred: () => boolean, ms = 5000) {
    const until = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > until) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
    return true;
}

const forgot = (login: string) => request(app).post('/api/v1/auth/forgot-password').send({ login });

before(async () => {
    request = require('supertest');
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/roles').loadRoles();
    User = require('../models/User');
    mailProvider = require('../core/mail-provider');
    options = require('../core/options');

    const express = require('express');
    const cookieParser = require('cookie-parser');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1', require('../routes'));

    ids.admin = (await User.create({ username: 'mailadmin', email: 'mailadmin@gmail.com', password: PASSWORD, role: 'administrator' })).id;
    ids.admin2 = (await User.create({ username: 'otheradmin', email: 'otheradmin@gmail.com', password: PASSWORD, role: 'administrator' })).id;
    ids.member = (await User.create({ username: 'member', email: 'member@gmail.com', password: 'member-pass-12345', role: 'subscriber' })).id;
    await options.updateOption('mail_delivery_ready', '1');

    const { SMTPServer } = require('smtp-server');
    smtp = new SMTPServer({
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        logger: false,
        onData(stream: any, _session: any, cb: any) {
            let raw = '';
            stream.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
            stream.on('end', () => { smtpMessages.push(raw); cb(); });
        },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => resolve()));
    smtpPort = smtp.server.address().port;
});

after(async () => {
    try { mailProvider.clearMailProvider(); } catch { /* */ }
    try { if (smtp) smtp.close(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + s, { force: true }); } catch { /* */ } }
});

describe('a mail provider plugin carries account email only when allowed by name', () => {
    it('a live provider that was not allowed receives no reset link, and the answer does not change', async () => {
        mailProvider.setMailProvider(sendA, 'third-mailer');
        const status = await request(app).get('/api/v1/account-mail').set(as('admin'));
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.route, 'none');
        assert.strictEqual(status.body.provider, 'third-mailer');
        assert.strictEqual(status.body.providerAllowed, false);
        const probe = await request(app).get('/api/v1/auth/password-reset-available');
        assert.strictEqual(probe.body.available, false, 'recovery is not offered without an allowed transport');
        const res = await forgot('member');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(providerA.length, 0, 'the provider must not see a reset link');
    });

    it('allowing it needs the administrator password; then it carries the link — and only that plugin', async () => {
        const wrong = await request(app).put('/api/v1/account-mail/provider').set(as('admin')).send({ slug: 'third-mailer', allowed: true, currentPassword: 'nope' });
        assert.strictEqual(wrong.status, 403);
        const nonAdmin = await request(app).put('/api/v1/account-mail/provider').set(as('member')).send({ slug: 'third-mailer', allowed: true, currentPassword: 'member-pass-12345' });
        assert.strictEqual(nonAdmin.status, 403);

        const ok = await request(app).put('/api/v1/account-mail/provider').set(as('admin')).send({ slug: 'third-mailer', allowed: true, currentPassword: PASSWORD });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.route, 'provider');
        await forgot('member');
        assert.strictEqual(providerA.length, 1);
        assert.match(String(providerA[0].text), RESET_LINK_RE);

        // Another plugin becomes the provider: it inherits nothing.
        mailProvider.setMailProvider(sendB, 'other-mailer');
        await forgot('member');
        assert.strictEqual(providerB.length, 0, 'an allowance is per plugin');
        assert.strictEqual((await request(app).get('/api/v1/account-mail').set(as('admin'))).body.route, 'none');
        // A provider set without a plugin behind it (legacy global) is never "allowed".
        (global as any).wordjs_send_mail = (m: any) => { providerB.push(m); };
        assert.strictEqual(mailProvider.currentProviderSlug(), null);
        mailProvider.setMailProvider(sendA, 'third-mailer');
        const audited = await dbAsync.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account_mail.provider'");
        assert.strictEqual(Number(audited.n), 1);
    });
});

describe('the built-in transport', () => {
    it('refuses an unencrypted relay that is not on this machine, and needs the password', async () => {
        const plain = await request(app).put('/api/v1/account-mail/smtp').set(as('admin')).send({
            host: 'smtp.example.com', port: 25, security: 'none', fromAddress: 'site@example.com', currentPassword: PASSWORD,
        });
        assert.strictEqual(plain.status, 400);
        const noPw = await request(app).put('/api/v1/account-mail/smtp').set(as('admin')).send({
            host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'site@example.com',
        });
        assert.strictEqual(noPw.status, 403);
    });

    it('delivers the reset link over SMTP, ahead of any provider, and never returns its password', async () => {
        const saved = await request(app).put('/api/v1/account-mail/smtp').set(as('admin')).send({
            host: '127.0.0.1', port: smtpPort, security: 'none', username: '', password: 'relay-secret-xyz',
            fromAddress: 'site@example.com', fromName: 'Lab Site', currentPassword: PASSWORD,
        });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(saved.body.route, 'core');
        assert.ok(!JSON.stringify(saved.body).includes('relay-secret-xyz'), 'the relay password is write-only');
        const providerBefore = providerA.length;
        const res = await forgot('member');
        assert.strictEqual(res.status, 200);
        assert.ok(await waitFor(() => smtpMessages.length > 0), 'the SMTP sink received the message');
        assert.match(smtpMessages[0], /reset-password\?uid=\d+&(amp;)?token=|reset-password\?uid=3D\d+/i);
        assert.match(smtpMessages[0], /From: "?Lab Site"? <site@example\.com>/);
        assert.strictEqual(providerA.length, providerBefore, 'the provider sees nothing while the built-in transport is set');
        assert.ok(!JSON.stringify((await request(app).get('/api/v1/account-mail').set(as('admin'))).body).includes('relay-secret-xyz'));
    });
});

describe('using a reset link', () => {
    it('notifies every other administrator in-app', async () => {
        // Back to the allowed provider so the link can be read synchronously.
        await request(app).put('/api/v1/account-mail/smtp').set(as('admin')).send({ clear: true, currentPassword: PASSWORD });
        providerA.length = 0;
        await forgot('mailadmin');
        const m = String(providerA[0] && providerA[0].text).match(RESET_LINK_RE);
        if (!m) { assert.fail('reset link expected'); return; }
        const done = await request(app).post('/api/v1/auth/reset-password').send({ uid: Number(m[1]), token: m[2], password: 'New-passphrase-456!' });
        assert.strictEqual(done.status, 200, JSON.stringify(done.body));
        await new Promise((r) => setTimeout(r, 200));
        const rows = await dbAsync.all("SELECT user_id, title, message FROM notifications WHERE title = 'A password was reset'");
        assert.deepStrictEqual(rows.map((r: any) => r.user_id), [ids.admin2], 'the other administrator, not the account itself');
        assert.match(rows[0].message, /mailadmin/);
        assert.ok(!/token=/.test(rows[0].message), 'never the token');
    });
});

describe('migration 0018 and the options bridge', () => {
    it('keeps an upgraded site\'s provider allowed; records nothing when no plugin held the grant', async () => {
        const { MIGRATIONS } = require('../core/schema-migrations');
        const m = MIGRATIONS.find((x: any) => x.id === '0018_account_mail_provider_allowance');
        assert.ok(m);
        const ctx = {
            exec: (sql: string) => dbAsync.exec(sql), run: (s: string, p: any[] = []) => dbAsync.run(s, p),
            get: (s: string, p: any[] = []) => dbAsync.get(s, p), all: (s: string, p: any[] = []) => dbAsync.all(s, p),
            isPostgres: false, driverName: 'sqlite-native',
        };
        await dbAsync.run("DELETE FROM options WHERE option_name IN ('account_mail_provider_allowed', 'plugin_grants')");
        await m.up(ctx);
        assert.ok(!(await dbAsync.get("SELECT 1 AS x FROM options WHERE option_name = 'account_mail_provider_allowed'")), 'a site with no grant records nothing');
        await dbAsync.run("INSERT INTO options (option_name, option_value, autoload) VALUES ('plugin_grants', ?, 'yes')",
            [JSON.stringify({ 'mail-server': ['network', 'email:provider'], other: ['database:read'] })]);
        await m.up(ctx);
        const row = await dbAsync.get("SELECT option_value FROM options WHERE option_name = 'account_mail_provider_allowed'");
        assert.deepStrictEqual(JSON.parse(row.option_value), ['mail-server']);
        await m.up(ctx);
        assert.strictEqual(Number((await dbAsync.get("SELECT COUNT(*) AS n FROM options WHERE option_name = 'account_mail_provider_allowed'")).n), 1, 're-runnable');
    });

    it('the routing options are protected from plugins', () => {
        const { isProtectedOption } = require('../core/plugin-api');
        for (const k of ['account_mail_smtp', 'account_mail_smtp_password', 'account_mail_provider_allowed']) {
            assert.strictEqual(isProtectedOption(k), true, k);
        }
    });
});
