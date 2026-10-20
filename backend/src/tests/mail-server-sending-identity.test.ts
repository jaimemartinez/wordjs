/**
 * mail-server: an account SENDS AS ITS MAILBOX ADDRESS, never as its personal account email.
 *
 * The webmail gate is the admin grant alone (hasCorporateMailbox), so an account granted a mailbox
 * while its email is personal (someone@gmail.com) — or one whose primary email moved off the domain —
 * reached the composer and sent with that PERSONAL address: in From on local delivery, on the stored Sent
 * copy and on the relay path, and in Reply-To on the direct-to-MX path after the alignment rewrite, so
 * replies leaked to a private inbox. The identity is now mailboxAddressOf() — the delivery predicate —
 * and an account without one is refused, clearly, on every path that sends on its behalf.
 *
 * Drives the REAL plugin module (index.js + lib/email-store.js) over in-memory SQLite, through its real
 * routes and its real queue tick. The only doubles: smtp-server (never binds) and the last network hop of
 * direct-to-MX delivery, replaced through a hook appended to the module so the WIRE message is visible.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');

// Appended to the shipped source so it closes over the module's own bindings; nothing else is altered.
const SUITE_HOOK = `
;module.exports.__identitySuite = {
    get Email() { return Email; },
    resetRateLimits() { _outboundUsage.clear(); },
    captureWire(fn) { deliverDirect = async (recipient, mail) => { fn(recipient, mail); return { mx: 'mx.test', response: '250 OK' }; }; },
};`;

// A public-looking domain, so the direct-to-MX alignment rewrite is live (not skipped as a LAN host).
const DOMAIN = 'acme-corp.com';
const MAILBOX = ['mail_server_mailbox'];

const smtpInstances: any[] = [];
class FakeSMTPServer {
    options: any;
    constructor(options: any) { this.options = options; smtpInstances.push(this); }
    on() { return this; }
    listen() { /* never binds */ }
    close() { /* no-op */ }
}

function loadPluginModule(): any {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    const wrapper: any = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}${SUITE_HOOK}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', accountCapabilities: MAILBOX };
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${DOMAIN}`, userLogin: 'alice', displayName: 'Alice', accountCapabilities: MAILBOX };
// THE CASE: granted a mailbox, but the account email is personal.
const OLGA = { id: 5, role: 'editor', userEmail: 'olga.private@gmail.com', userLogin: 'olga', displayName: 'Olga', accountCapabilities: MAILBOX };
const USERS = [BOSS, ALICE, OLGA];
const PERSONAL = OLGA.userEmail;

type Boot = { plugin: any; suite: any; routes: Map<string, any>; db: any; wire: any[]; notices: any[]; tick: () => Promise<void> };

async function boot(extraOptions: Record<string, string> = {}): Promise<Boot> {
    const db = makeDb();
    const routes = new Map<string, any>();
    const notices: any[] = [];
    const options: Record<string, string> = { smtp_listen_port: '2525', mail_undo_send_seconds: '0', ...extraOptions };
    const find = (pred: (u: any) => boolean) => USERS.find(pred) || null;
    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; }
        },
        site: {
            async url() { return `https://${DOMAIN}`; },
            async domain() { return DOMAIN; },
            async adminEmail() { return BOSS.userEmail; }
        },
        users: {
            async findByEmail(email: string) { return find(u => u.userEmail.toLowerCase() === String(email || '').toLowerCase()); },
            async findByLogin(login: string) { return find(u => u.userLogin.toLowerCase() === String(login || '').toLowerCase()); },
            async findById(id: number) { return find(u => u.id === Number(id)); },
            async search() { return USERS; }
        },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { } },
        provideMail() { },
        notify: Object.assign(async (n: any) => { notices.push(n); }, { registerTransport() { } }),
        dns: {
            resolveMx: async () => { throw new Error('queryMx ENOTFOUND'); },
            resolveTxt: async () => { throw new Error('queryTxt ENOTFOUND'); },
            resolve4: async () => { throw new Error('queryA ENOTFOUND'); },
            resolve6: async () => { throw new Error('queryAaaa ENOTFOUND'); },
            resolve: async () => { throw new Error('query ENOTFOUND'); }
        }
    };
    const plugin = loadPluginModule();
    smtpInstances.length = 0;
    let queueTick: any = null;
    const realSetInterval = global.setInterval;
    (global as any).setInterval = (fn: any) => { if (!queueTick) queueTick = fn; return realSetInterval(() => { }, 1 << 30); };
    try { await plugin.init(bridge); } finally { (global as any).setInterval = realSetInterval; }
    const suite = plugin.__identitySuite;
    suite.resetRateLimits();
    const wire: any[] = [];
    suite.captureWire((recipient: string, mail: any) => wire.push({ recipient, ...mail }));
    return { plugin, suite, routes, db, wire, notices, tick: () => queueTick() };
}

async function call(b: Boot, key: string, user: any, req: any = {}) {
    const handler = b.routes.get(key);
    assert.ok(handler, `route '${key}' is not registered`);
    const out: { status: number; body: any } = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(b2: any) { out.body = b2; return res; }, send(b2: any) { out.body = b2; return res; }, end() { return res; }
    };
    await handler({ query: {}, params: {}, body: {}, cookies: {}, ...req, user }, res);
    return out;
}

const rows = (b: Boot) => b.db.all(`SELECT * FROM ${PREFIX}received_emails ORDER BY id`, []);
/** No stored row and no wire message carries the personal address anywhere a sender is named. */
async function assertPersonalNowhere(b: Boot) {
    for (const r of await rows(b)) {
        assert.notEqual(String(r.from_address || '').toLowerCase(), PERSONAL, `row ${r.id} stored the personal address as its sender`);
    }
    for (const m of b.wire) {
        assert.notEqual(String(m.fromEmail || '').toLowerCase(), PERSONAL, 'the personal address reached the wire From');
        assert.notEqual(String(m.replyTo || '').toLowerCase(), PERSONAL, 'the personal address reached the wire Reply-To');
    }
}

test('an account with the grant but NO address on the mail domain is refused by POST /send — immediate and queued', async () => {
    for (const undo of ['0', '10']) {
        const b = await boot({ mail_undo_send_seconds: undo });
        try {
            const out = await call(b, 'post /send', OLGA, { body: { to: 'client@outside-corp.com', subject: 'Quote', body: '<p>Hi</p>' } });
            assert.equal(out.status, 403, `undo=${undo}: the send must be refused`);
            assert.equal(out.body.code, 'mail_no_mailbox_address');
            assert.match(out.body.error, new RegExp(`no address on the mail domain \\(${DOMAIN}\\)`));
            assert.equal(b.wire.length, 0, 'nothing went out');
            assert.equal((await rows(b)).length, 0, 'nothing was queued or stored');
        } finally { b.plugin.deactivate(); }
    }
});

test('an on-domain account sends as its mailbox address, with no Reply-To added', async () => {
    const b = await boot();
    try {
        const out = await call(b, 'post /send', ALICE, { body: { to: 'client@outside-corp.com', subject: 'Quote', body: '<p>Hi</p>' } });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(b.wire.length, 1);
        assert.equal(b.wire[0].fromEmail, `alice@${DOMAIN}`, 'the wire From is the mailbox address (no rewrite needed)');
        assert.equal(b.wire[0].replyTo, undefined, 'and no Reply-To was invented');
        const sent = (await rows(b)).find((r: any) => Number(r.is_sent) === 1);
        assert.equal(sent.from_address, `alice@${DOMAIN}`, 'the stored Sent copy names the mailbox address');
    } finally { b.plugin.deactivate(); }
});

test('the scheduled queue never sends an owner\'s mail under another address: back to Drafts, failed, owner told', async () => {
    const b = await boot();
    try {
        const row = await b.suite.Email.create({
            fromAddress: PERSONAL, fromName: 'Olga', toAddress: 'client@outside-corp.com', subject: 'Later', bodyText: 'x',
            bodyHtml: '<p>x</p>', rawContent: 'x', isDraft: 0, isSent: 0, userId: OLGA.id,
            scheduledAt: new Date(Date.now() - 1000).toISOString(),
        });
        await b.tick();
        assert.equal(b.wire.length, 0, 'the queue sent nothing');
        const after: any = await b.db.get(`SELECT * FROM ${PREFIX}received_emails WHERE id = ?`, [row.id]);
        assert.equal(Number(after.is_sent), 0);
        assert.equal(Number(after.is_draft), 1, 'the message is back in the owner\'s Drafts');
        assert.equal(after.delivery_status, 'failed');
        assert.match(String(after.last_error), /no address on the mail domain/);
        assert.ok(b.notices.some((n: any) => n.user_id === OLGA.id && /not sent/.test(n.title)), 'the owner is told');
        await b.tick();
        assert.equal(b.wire.length, 0, 'and it is not picked up again');
    } finally { b.plugin.deactivate(); }
});

test('the retry queue and a manual retry stop rather than send as the personal address', async () => {
    const b = await boot();
    try {
        const row = await b.suite.Email.create({
            fromAddress: PERSONAL, fromName: 'Olga', toAddress: 'client@outside-corp.com', subject: 'Retry me', bodyText: 'x',
            bodyHtml: '<p>x</p>', rawContent: 'x', isDraft: 0, isSent: 1, userId: OLGA.id,
        });
        await b.db.run(`UPDATE ${PREFIX}received_emails SET delivery_status = 'retry', delivery_attempts = 1, next_attempt_at = ? WHERE id = ?`,
            [new Date(Date.now() - 1000).toISOString(), row.id]);
        await b.tick();
        assert.equal(b.wire.length, 0, 'the retry queue sent nothing');
        let after: any = await b.db.get(`SELECT * FROM ${PREFIX}received_emails WHERE id = ?`, [row.id]);
        assert.equal(after.delivery_status, 'failed', 'and stopped retrying');

        const manual = await call(b, 'post /emails/:id/retry', OLGA, { params: { id: String(row.id) } });
        assert.equal(manual.status, 403);
        assert.equal(manual.body.code, 'mail_no_mailbox_address');
        assert.equal(b.wire.length, 0);
        after = await b.db.get(`SELECT * FROM ${PREFIX}received_emails WHERE id = ?`, [row.id]);
        assert.match(String(after.last_error), /no address on the mail domain/);
        // (The seeded row is a pre-fix one that already names the personal address; what matters is
        // that nothing ever went OUT with it.)
        assert.equal(b.wire.length, 0);
    } finally { b.plugin.deactivate(); }
});

test('a draft stores the address it would be sent from — the mailbox address, never the personal one', async () => {
    const b = await boot();
    try {
        const olga = await call(b, 'post /drafts', OLGA, { body: { to: 'client@outside-corp.com', subject: 'Draft', body: '<p>d</p>' } });
        assert.equal(olga.status, 200, JSON.stringify(olga.body));
        const alice = await call(b, 'post /drafts', ALICE, { body: { to: 'client@outside-corp.com', subject: 'Draft A', body: '<p>d</p>' } });
        assert.equal(alice.status, 200);
        const all = await rows(b);
        assert.equal(all.find((r: any) => r.subject === 'Draft').from_address, '', 'no address to name: nothing, not the personal one');
        assert.equal(all.find((r: any) => r.subject === 'Draft A').from_address, `alice@${DOMAIN}`);
        await assertPersonalNowhere(b);
    } finally { b.plugin.deactivate(); }
});

test('the admin mailbox list flags a granted account with no address on the domain', async () => {
    const b = await boot();
    try {
        const out = await call(b, 'get /admin/mailboxes', BOSS);
        assert.equal(out.status, 200, JSON.stringify(out.body));
        const list = out.body.mailboxes || out.body.items || out.body;
        const olga = list.find((m: any) => m.id === OLGA.id);
        const alice = list.find((m: any) => m.id === ALICE.id);
        assert.ok(olga, 'the granted account is listed');
        assert.equal(olga.missingAddress, true, 'and flagged: it can neither send nor receive here');
        assert.equal(olga.address, null);
        assert.equal(alice.missingAddress, false);
    } finally { b.plugin.deactivate(); }
});
