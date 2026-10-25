/**
 * mail-server 3.3.0 — the system Sent log («Enviados del sistema»).
 *
 * Every message the SITE sends (no mailbox identity, no owning account: the core's and other plugins' mail
 * through the provider, the email notification transport) is recorded with its bodies for the admin's
 * preview; a user's own mail is not (it has its Sent folder). The status follows the delivery, the log is
 * purged by its retention (7/30/90/180 days, 0 = keep nothing), and both routes are administrators only.
 *
 * Driven through the REAL plugin module, like mail-server-send-rate: a stub relay decides each recipient's
 * fate from its local part (bounce… = 550, later… = 421, anything else is accepted).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const T_LOG = `${PREFIX}system_sent`;

const DOMAIN = 'acme.example';
const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', accountCapabilities: ['mail_server_mailbox'] };
const READER = { id: 2, role: 'subscriber', userEmail: 'reader@example.org', userLogin: 'reader', displayName: 'Reader', accountCapabilities: [] };

class FakeSMTPServer {
    constructor(public options: any) { }
    on() { return this; }
    listen(_port: number, cb?: () => void) { if (cb) setImmediate(cb); return this; }
    close(cb?: () => void) { if (cb) setImmediate(cb); }
}

type Boot = {
    provider: (msg: any) => Promise<any>; sent: any[]; db: any; options: Record<string, string>;
    routes: Map<string, { opts: any; handler: any }>; tick: () => Promise<void>; plugin: any;
    transports: Map<string, any>; relay: { acceptLater: boolean };
};

async function boot(extra: Record<string, string> = {}): Promise<Boot> {
    const sent: any[] = [];
    const relay = { acceptLater: false };
    const nodemailer = {
        createTransport() {
            return {
                async verify() { return true; },
                async sendMail(m: any) {
                    const to = String(m.to || '');
                    if (to.startsWith('bounce')) throw Object.assign(new Error('550 5.1.1 No such user'), { responseCode: 550 });
                    if (to.startsWith('later') && !relay.acceptLater) throw Object.assign(new Error('421 4.7.0 Try again later'), { responseCode: 421 });
                    sent.push(m);
                    return { response: '250 2.0.0 Ok: queued' };
                },
            };
        },
    };
    const dnsDouble = { promises: { async lookup() { return { address: '192.168.182.56', family: 4 }; } } };
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec === 'nodemailer') return nodemailer;
        if (spec === 'dns') return dnsDouble;
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`, { filename: PLUGIN_SRC })(
        moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    const plugin = moduleObj.exports;

    const db = makeDb();
    const options: Record<string, string> = { smtp_listen_port: '2525', mail_undo_send_seconds: '0', mail_server: 'relay.lan', mail_port: '587', ...extra };
    const routes = new Map<string, { opts: any; handler: any }>();
    const transports = new Map<string, any>();
    let provider: any = null;
    const users = [BOSS, READER];
    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; },
        },
        site: { async url() { return `https://${DOMAIN}`; }, async domain() { return DOMAIN; }, async adminEmail() { return BOSS.userEmail; } },
        users: {
            async findByEmail(e: string) { return users.find(u => u.userEmail === e) || null; },
            async findByLogin() { return null; },
            async findById(id: number) { return users.find(u => u.id === id) || null; },
            async search() { return []; },
        },
        http: { route(method: string, sub: string, opts: any, handler: any) { routes.set(`${method} ${sub}`, { opts, handler }); } },
        adminMenu: { add() { } },
        provideMail(fn: any) { provider = fn; },
        notify: Object.assign(async () => { }, { registerTransport(name: string, fn: any) { transports.set(name, fn); } }),
        dns: { resolveMx: async () => [], resolveTxt: async () => [], resolve4: async () => [], resolve6: async () => [], resolve: async () => [] },
    };
    let queueTick: any = null;
    const realSetInterval = global.setInterval;
    (global as any).setInterval = (fn: any, ms: number) => { if (!queueTick && ms === 15 * 1000) queueTick = fn; return realSetInterval(() => { }, 1 << 30); };
    try { await plugin.init(bridge); } finally { (global as any).setInterval = realSetInterval; }
    assert.ok(provider, 'the plugin registers itself as the mail provider');
    return { provider, sent, db, options, routes, tick: () => queueTick(), plugin, transports, relay };
}

async function call(b: Boot, key: string, { body = {}, query = {}, params = {}, user = BOSS as any } = {}) {
    const r = b.routes.get(key);
    assert.ok(r, `route '${key}' is not registered`);
    const out: any = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(x: any) { out.body = x; return res; }, send(x: any) { out.body = x; return res; }, end() { return res; },
    };
    await r!.handler({ query, params, body, cookies: {}, headers: {}, user }, res);
    return out;
}

const logRows = (b: Boot) => b.db.all(`SELECT * FROM ${T_LOG} ORDER BY id`);
const sqlDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const daysAgo = (n: number) => sqlDate(new Date(Date.now() - n * 86400000));

describe('what is recorded', () => {
    test('a system send is recorded with its bodies and source; a user send is not', async () => {
        const b = await boot();
        try {
            const r = await b.provider({ to: 'member@example.org', subject: 'Reset your password', text: 'Use this link', html: '<p>Use <a href="https://acme.example/r">this link</a></p>', priority: 'account' });
            assert.strictEqual(r.success, true);
            const u = await call(b, 'post /send', { body: { to: 'friend@example.org', subject: 'from my mailbox', body: '<p>hello</p>' } });
            assert.ok(u.status < 300, `the user's own send went out: ${JSON.stringify(u.body)}`);
            assert.ok(b.sent.some(m => m.subject === 'from my mailbox'), 'the user mail left through the relay');

            const rows = await logRows(b);
            assert.deepStrictEqual(rows.map((x: any) => x.subject), ['Reset your password'], 'only the site message is logged');
            const [row] = rows;
            assert.strictEqual(row.to_address, 'member@example.org');
            assert.strictEqual(row.source, 'core');
            assert.strictEqual(row.status, 'delivered');
            assert.strictEqual(row.body_text, 'Use this link');
            assert.match(row.body_html, /this link/);
            assert.ok(Number(row.size) > 0);
            assert.ok(Number(row.email_id) > 0, 'linked to its queue row');
            assert.match(String(row.from_address), new RegExp(`@${DOMAIN.replace('.', '\\.')}$`), 'sent as the site');

            // The list carries headers only — never a body.
            const list = await call(b, 'get /admin/system-sent');
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.body.total, 1);
            assert.strictEqual(list.body.items[0].body_html, undefined);
            assert.strictEqual(list.body.items[0].body_text, undefined);
            assert.strictEqual(list.body.retentionDays, 30, 'the default retention');
            assert.deepStrictEqual(list.body.sources, ['core']);
        } finally { b.plugin.deactivate(); }
    });

    test('the email notification transport is recorded as «notifications»', async () => {
        const b = await boot();
        try {
            const transport = b.transports.get('email');
            assert.ok(transport, 'the email transport is registered');
            await transport({ user_id: READER.id, title: 'New comment', message: 'Someone replied' });
            const rows = await logRows(b);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].source, 'notifications');
            assert.strictEqual(rows[0].to_address, READER.userEmail);
        } finally { b.plugin.deactivate(); }
    });

    test('a caller cannot name the source through a field of the message', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'member@example.org', subject: 'spoof', text: 'x', source: 'mail-server', _systemSource: 'admin' });
            const [row] = await logRows(b);
            assert.strictEqual(row.source, 'core');
        } finally { b.plugin.deactivate(); }
    });
});

describe('the status follows the delivery', () => {
    test('a permanent failure is «failed» with its reason, and the detail links its queue row', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'bounce@example.org', subject: 'nobody home', text: 'x' });
            const [row] = await logRows(b);
            assert.strictEqual(row.status, 'failed');
            assert.match(String(row.last_error), /550/);

            const d = await call(b, 'get /admin/system-sent/:id', { params: { id: String(row.id) } });
            assert.strictEqual(d.status, 200);
            assert.deepStrictEqual(d.body.queue, { id: Number(row.email_id), status: 'failed' }, 'offered for «Reintentar»');
            const f = await call(b, 'get /admin/system-sent', { query: { status: 'failed' } });
            assert.strictEqual(f.body.total, 1);
            const ok = await call(b, 'get /admin/system-sent', { query: { status: 'delivered' } });
            assert.strictEqual(ok.body.total, 0);
        } finally { b.plugin.deactivate(); }
    });

    test('a temporary failure is «retry», then «delivered» once the queue gets it out', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'later@example.org', subject: 'try again', text: 'x' });
            let [row] = await logRows(b);
            assert.strictEqual(row.status, 'retry');
            assert.match(String(row.last_error), /421/);

            b.relay.acceptLater = true; // the remote side accepts now
            await b.db.run(`UPDATE ${PREFIX}received_emails SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), row.email_id]);
            await b.tick();
            [row] = await logRows(b);
            assert.strictEqual(row.status, 'delivered');
            assert.strictEqual(row.last_error, null);
            assert.strictEqual((await logRows(b)).length, 1, 'a retry is not a new message');
        } finally { b.plugin.deactivate(); }
    });
});

describe('retention', () => {
    test('the hourly sweep deletes what is older than the retention', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'a@example.org', subject: 'old', text: 'x' });
            await b.provider({ to: 'b@example.org', subject: 'recent', text: 'x' });
            await b.db.run(`UPDATE ${T_LOG} SET created_at = ? WHERE subject = 'old'`, [daysAgo(40)]);
            await b.db.run(`UPDATE ${T_LOG} SET created_at = ? WHERE subject = 'recent'`, [daysAgo(10)]);
            await b.tick();
            assert.deepStrictEqual((await logRows(b)).map((r: any) => r.subject), ['recent'], '30 days: the 40-day-old one goes');
        } finally { b.plugin.deactivate(); }
    });

    test('a shorter period purges at once; «No guardar» deletes everything and stores nothing', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'a@example.org', subject: 'ten days', text: 'x' });
            await b.provider({ to: 'b@example.org', subject: 'today', text: 'x' });
            await b.db.run(`UPDATE ${T_LOG} SET created_at = ? WHERE subject = 'ten days'`, [daysAgo(10)]);

            const bad = await call(b, 'post /settings', { body: { mail_system_sent_retention: '45' } });
            assert.strictEqual(bad.status, 400, 'only the offered choices');
            assert.strictEqual(bad.body.code, 'mail_retention_invalid');

            let s = await call(b, 'post /settings', { body: { mail_system_sent_retention: '7' } });
            assert.strictEqual(s.status, 200, JSON.stringify(s.body));
            assert.strictEqual(s.body.systemSentPurged, 1);
            assert.strictEqual(b.options.mail_system_sent_retention, '7');
            assert.deepStrictEqual((await logRows(b)).map((r: any) => r.subject), ['today']);
            assert.strictEqual((await call(b, 'get /settings')).body.mail_system_sent_retention, '7');

            s = await call(b, 'post /settings', { body: { mail_system_sent_retention: '0' } });
            assert.strictEqual(s.body.systemSentPurged, 1);
            assert.strictEqual((await logRows(b)).length, 0);

            const r = await b.provider({ to: 'c@example.org', subject: 'not kept', text: 'x' });
            assert.strictEqual(r.success, true, 'mail still goes out');
            assert.ok(b.sent.some(m => m.subject === 'not kept'));
            assert.strictEqual((await logRows(b)).length, 0, '«No guardar» stores nothing');
            const list = await call(b, 'get /admin/system-sent');
            assert.strictEqual(list.body.retentionDays, 0);
            assert.strictEqual(list.body.total, 0);
        } finally { b.plugin.deactivate(); }
    });
});

describe('access and content', () => {
    test('both routes are declared admin-only, and a non-administrator gets 403 from the handler too', async () => {
        const b = await boot();
        try {
            await b.provider({ to: 'a@example.org', subject: 'private', text: 'personal data' });
            const [row] = await logRows(b);
            for (const key of ['get /admin/system-sent', 'get /admin/system-sent/:id']) {
                const r = b.routes.get(key)!;
                assert.strictEqual(r.opts.admin, true, `${key} must be admin: true`);
                assert.strictEqual(r.opts.auth, true);
                const denied = await call(b, key, { params: { id: String(row.id) }, user: READER });
                assert.strictEqual(denied.status, 403, `${key} refuses a subscriber`);
                assert.ok(!JSON.stringify(denied.body).includes('personal data'));
            }
            assert.strictEqual((await call(b, 'get /admin/system-sent/:id', { params: { id: '999' } })).status, 404);
        } finally { b.plugin.deactivate(); }
    });

    test('the detail HTML is sanitized, the plain text is returned as stored', async () => {
        const b = await boot();
        try {
            await b.provider({
                to: 'a@example.org', subject: 'dirty',
                html: '<p>Hello</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">go</a>',
                text: 'Hello <b>plain</b>',
            });
            const [row] = await logRows(b);
            const d = await call(b, 'get /admin/system-sent/:id', { params: { id: String(row.id) } });
            assert.strictEqual(d.status, 200);
            assert.match(d.body.html, /Hello/);
            assert.doesNotMatch(d.body.html, /<script/i);
            assert.doesNotMatch(d.body.html, /onerror/i);
            assert.doesNotMatch(d.body.html, /javascript:/i);
            assert.strictEqual(d.body.text, 'Hello <b>plain</b>');
            assert.strictEqual(d.body.body_html, undefined, 'the raw stored body never leaves');
        } finally { b.plugin.deactivate(); }
    });

    test('search, source and date filters, and pages', async () => {
        const b = await boot();
        try {
            for (let i = 1; i <= 5; i++) await b.provider({ to: `user${i}@example.org`, subject: `Invoice ${i}`, text: 'x' });
            await b.provider({ to: 'other@example.org', subject: 'Welcome', text: 'x' });
            await b.db.run(`UPDATE ${T_LOG} SET created_at = ? WHERE subject = 'Welcome'`, [daysAgo(3)]);

            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { q: 'invoice' } })).body.total, 5, 'subject, any case');
            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { q: 'USER3@' } })).body.total, 1, 'recipient');
            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { q: '%' } })).body.total, 6, 'a wildcard is not a pattern');
            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { source: 'notifications' } })).body.total, 0);
            const today = new Date().toISOString().slice(0, 10);
            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { from: today } })).body.total, 5);
            assert.strictEqual((await call(b, 'get /admin/system-sent', { query: { to: daysAgo(1).slice(0, 10) } })).body.total, 1);
            const p2 = (await call(b, 'get /admin/system-sent', { query: { perPage: '4', page: '2' } })).body;
            assert.strictEqual(p2.total, 6);
            assert.strictEqual(p2.items.length, 2);
            assert.strictEqual(p2.items[1].subject, 'Invoice 1', 'newest first');
        } finally { b.plugin.deactivate(); }
    });
});
