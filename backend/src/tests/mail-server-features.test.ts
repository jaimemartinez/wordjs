/**
 * mail-server 3.0 server features: filing rules, blocked senders, aliases / distribution lists,
 * mailbox quotas, the site sender blocklist, auto-forward guards and the administration routes.
 *
 * Same approach as mail-server-mailbox-gate.test.ts: the REAL plugin module is loaded and its REAL
 * init() registers the REAL routes over the real email store on an in-memory SQLite database (with
 * the host SQL-guard tripwire of the shared fixture). Only smtp-server — which would bind a port — is
 * doubled, and the double keeps the handler options so inbound mail can be driven through the real
 * onRcptTo/onData. Undo-send is set to 0 so POST /send delivers locally and synchronously.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Readable } from 'stream';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const MailRules = require(path.join(PLUGIN_DIR, 'lib/mail-rules.js'));

const DOMAIN = 'acme.example';

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
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

const BOSS = { id: 1, role: 'administrator', userEmail: 'boss@gmail.com', userLogin: 'boss', displayName: 'Boss', hasProfessionalMailbox: false };
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${DOMAIN}`, userLogin: 'alice', displayName: 'Alice', hasProfessionalMailbox: true };
const BOB = { id: 3, role: 'author', userEmail: `bob@${DOMAIN}`, userLogin: 'bob', displayName: 'Bob', hasProfessionalMailbox: true };
const USERS = [BOSS, ALICE, BOB];

type Boot = { plugin: any; routes: Map<string, any>; db: any; smtp: any; options: Record<string, string> };

async function boot(extraOptions: Record<string, string> = {}): Promise<Boot> {
    const db = makeDb();
    const routes = new Map<string, any>();
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
            async search(q: string, limit: number) {
                const n = String(q || '').toLowerCase();
                return USERS.filter(u => u.userLogin.includes(n) || u.userEmail.includes(n)).slice(0, limit || 50);
            }
        },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { } },
        provideMail() { },
        notify: Object.assign(async () => { }, { registerTransport() { } }),
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
    await plugin.init(bridge);
    return { plugin, routes, db, smtp: smtpInstances[0], options };
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

function inbound(b: Boot, raw: string, mailFrom = 'ext@outside.example'): Promise<any> {
    return new Promise((resolve) => {
        const session: any = { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: mailFrom }, rcptTo: [] } };
        b.smtp.options.onData(Readable.from([raw]), session, (err: any) => resolve(err || null));
    });
}

const rowsOf = (b: Boot, userId: number) =>
    b.db.all(`SELECT * FROM ${PREFIX}received_emails WHERE user_id = ? ORDER BY id`, [userId]);

// ================================================================================================

test('rules engine: conditions, actions, stop, blocked senders and the site lists', () => {
    const prefs = {
        rules: [
            { name: 'Invoices', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: { labelId: 7, markRead: true, stop: true } },
            { name: 'Never reached', conditions: [{ field: 'any', op: 'contains', value: 'invoice' }], actions: { trash: true } },
            { name: 'Boss', conditions: [{ field: 'from', op: 'ends', value: '@boss.example' }], actions: { star: true, neverSpam: true } },
        ],
        blockedSenders: ['spammer@bad.example', '@junk.example'],
    };
    const a = MailRules.evaluateDelivery(prefs, { from: 'x@y.example', subject: 'Your INVOICE #4', text: '' });
    assert.deepEqual([a.isRead, a.isTrash, a.labelIds], [1, 0, [7]], 'first match labels + reads, then stop');

    const b = MailRules.evaluateDelivery(prefs, { from: 'ceo@boss.example', subject: 'hi', isSpam: true });
    assert.equal(b.isStarred, 1);
    assert.equal(b.isSpam, 0, 'never-spam overrides the classifier');

    for (const from of ['spammer@bad.example', 'promo@mail.junk.example']) {
        const c = MailRules.evaluateDelivery(prefs, { from, subject: 'invoice' });
        assert.equal(c.isSpam, 1, `${from} is blocked → spam folder`);
        assert.equal(c.blocked, true);
        assert.deepEqual(c.labelIds, [], 'a blocked sender is not also run through the rules');
    }

    const site = { blocked: MailRules.normalizeSenderList('@evil.example'), allowed: MailRules.normalizeSenderList('trusted@partner.example') };
    assert.equal(MailRules.evaluateDelivery({}, { from: 'a@evil.example' }, site).isSpam, 1);
    assert.equal(MailRules.evaluateDelivery({}, { from: 'trusted@partner.example', isSpam: true }, site).isSpam, 0);

    // Normalization bounds what a client can store.
    assert.deepEqual(MailRules.normalizeRules([{ conditions: [] }, { conditions: [{ value: '' }] }, null]), []);
    assert.deepEqual(MailRules.normalizeSenderList('not an address, @x, foo@bar.example, @Ok.Example'), ['foo@bar.example', '@ok.example']);
    assert.equal(MailRules.normalizeForwarding({ enabled: true, address: 'nope' }).enabled, false);
});

test('a recipient\'s rules and blocked senders file internal mail', async () => {
    const b = await boot();
    try {
        const label = await call(b, 'post /labels', BOB, { body: { name: 'From Alice' } });
        const labelId = label.body.id || label.body.label?.id;
        assert.ok(labelId, 'label created');
        let r = await call(b, 'put /prefs', BOB, {
            body: { rules: [{ name: 'Alice', conditions: [{ field: 'from', op: 'contains', value: 'alice@' }], actions: { labelId, markRead: true } }] }
        });
        assert.equal(r.status, 200);

        r = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Hello Bob', body: '<p>hi</p>' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        let rows = await rowsOf(b, BOB.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].is_read, 1, 'the rule marked it read');
        const labels = await b.db.all(`SELECT label_id FROM ${PREFIX}email_labels WHERE email_id = ?`, [rows[0].id]);
        assert.deepEqual(labels.map((l: any) => l.label_id), [labelId], 'and applied Bob\'s label');

        await call(b, 'put /prefs', BOB, { body: { blockedSenders: [ALICE.userEmail] } });
        await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Again', body: 'x' } });
        rows = await rowsOf(b, BOB.id);
        assert.equal(rows[1].is_spam, 1, 'a blocked sender lands in spam, never dropped');

        const prefs = await call(b, 'get /prefs', BOB);
        assert.deepEqual(prefs.body.blockedSenders, [ALICE.userEmail]);
        assert.equal(prefs.body.rules.length, 1);
    } finally { b.plugin.deactivate(); }
});

test('an alias delivers to its member mailboxes, inbound and internal', async () => {
    const b = await boot();
    try {
        let r = await call(b, 'post /admin/aliases', BOSS, { body: { localPart: 'team', destinations: `${ALICE.userEmail}, ${BOB.userEmail}`, description: 'Everyone' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));

        r = await call(b, 'post /admin/aliases', BOSS, { body: { localPart: 'alice', destinations: BOB.userEmail } });
        assert.equal(r.status, 409, 'an alias may not shadow an existing mailbox');
        r = await call(b, 'post /admin/aliases', BOSS, { body: { localPart: 'Bad Name!', destinations: BOB.userEmail } });
        assert.equal(r.status, 400);

        const err = await inbound(b, ['From: Customer <c@outside.example>', `To: team@${DOMAIN}`, 'Subject: Quote please', '', 'Hi team.', ''].join('\r\n'));
        assert.equal(err, null);
        assert.equal((await rowsOf(b, ALICE.id)).filter((x: any) => x.subject === 'Quote please').length, 1);
        assert.equal((await rowsOf(b, BOB.id)).filter((x: any) => x.subject === 'Quote please').length, 1);

        r = await call(b, 'post /send', ALICE, { body: { to: `team@${DOMAIN}`, subject: 'Standup', body: 'at 10' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((await rowsOf(b, BOB.id)).filter((x: any) => x.subject === 'Standup' && !x.is_sent).length, 1, 'Bob receives via the alias');
        assert.equal((await rowsOf(b, ALICE.id)).filter((x: any) => x.subject === 'Standup' && !x.is_sent).length, 0, 'the sender gets no inbox copy of her own mail');

        const list = await call(b, 'get /admin/aliases', BOSS);
        assert.equal(list.body.aliases.length, 1);
        assert.equal(list.body.mailDomain, DOMAIN);
    } finally { b.plugin.deactivate(); }
});

test('a full mailbox is refused with 452 inbound and reported as a failure internally', async () => {
    const b = await boot();
    try {
        const r = await call(b, 'put /admin/mailboxes/:userId', BOSS, { params: { userId: String(BOB.id) }, body: { quotaMb: 1 } });
        assert.equal(r.status, 200);
        // 1.2 MB already stored in Bob's mailbox.
        await b.db.run(`INSERT INTO ${PREFIX}received_emails (user_id, subject, body_text, is_sent) VALUES (?, ?, ?, 0)`, [BOB.id, 'big', 'x'.repeat(1_250_000)]);

        const quota = await call(b, 'get /quota', BOB);
        assert.equal(quota.body.full, true);
        assert.equal(quota.body.quotaMb, 1);

        const err = await inbound(b, ['From: c@outside.example', `To: ${BOB.userEmail}`, 'Subject: Too much', '', 'x', ''].join('\r\n'));
        assert.ok(err, 'inbound to a full mailbox is not accepted');
        assert.equal(err.responseCode, 452, 'temporary: the sender retries later');

        const sent = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Full?', body: 'x' } });
        assert.ok(sent.status === 207 || sent.body?.success === false, `the sender is told it failed (got ${sent.status})`);
        assert.equal((await rowsOf(b, BOB.id)).filter((x: any) => x.subject === 'Full?').length, 0);
    } finally { b.plugin.deactivate(); }
});

test('attachments count against the quota between usage refreshes (no stream of big mail past a full mailbox)', async () => {
    const b = await boot();
    try {
        await call(b, 'put /admin/mailboxes/:userId', BOSS, { params: { userId: String(BOB.id) }, body: { quotaMb: 1 } });
        const attachment = Buffer.alloc(700 * 1024, 65).toString('base64');
        const raw = (n: number) => [
            'From: c@outside.example', `To: ${BOB.userEmail}`, `Subject: Big ${n}`, 'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="XX"', '', '--XX', 'Content-Type: text/plain', '', 'see attached',
            '--XX', 'Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64',
            'Content-Disposition: attachment; filename="blob.bin"', '', attachment, '--XX--', ''
        ].join('\r\n');
        assert.equal(await inbound(b, raw(1)), null, 'the first one fits');
        assert.equal(await inbound(b, raw(2)), null, 'the second one is still accepted (usage was under the quota)');
        const third = await inbound(b, raw(3));
        assert.ok(third, 'the mailbox is now over its quota: the third is refused');
        assert.equal(third.responseCode, 452);
    } finally { b.plugin.deactivate(); }
});

test('the site blocklist refuses the envelope; forwarding guards hold', async () => {
    const b = await boot({ mail_blocked_senders: '@evil.example' });
    try {
        const verdict = (from: string) => new Promise<any>((resolve) => {
            b.smtp.options.onRcptTo({ address: ALICE.userEmail }, { remoteAddress: '203.0.113.9', envelope: { mailFrom: { address: from } } }, (e: any) => resolve(e || null));
        });
        const e = await verdict('boss@evil.example');
        assert.equal(e && e.responseCode, 550);
        assert.equal(await verdict('friend@good.example'), null);

        let r = await call(b, 'put /prefs', ALICE, { body: { forwarding: { enabled: true, address: `bob@${DOMAIN}` } } });
        assert.equal(r.status, 400, 'forwarding to this server itself is a loop');
        r = await call(b, 'put /prefs', ALICE, { body: { forwarding: { enabled: true, address: 'alice.home@gmail.com', keepCopy: true } } });
        assert.equal(r.status, 200);
        b.options.mail_forwarding_allowed = '0';
        await call(b, 'post /settings', BOSS, { body: { mail_forwarding_allowed: '0' } });
        r = await call(b, 'put /prefs', ALICE, { body: { forwarding: { enabled: true, address: 'alice.home@gmail.com' } } });
        assert.equal(r.status, 403, 'the administrator can switch external forwarding off');
    } finally { b.plugin.deactivate(); }
});

test('RCPT TO refuses addresses that deliver nowhere instead of accepting and dropping them', async () => {
    const rcpt = (b: Boot, to: string) => new Promise<any>((resolve) => {
        b.smtp.options.onRcptTo({ address: to }, { remoteAddress: '203.0.113.9', envelope: { mailFrom: { address: 'someone@outside.example' } } }, (e: any) => resolve(e || null));
    });
    const b = await boot();
    try {
        await call(b, 'post /admin/aliases', BOSS, { body: { localPart: 'sales', destinations: BOB.userEmail } });
        assert.equal(await rcpt(b, ALICE.userEmail), null, 'a mailbox');
        assert.equal(await rcpt(b, `SALES@${DOMAIN}`), null, 'an alias (case-insensitive)');
        const unknown = await rcpt(b, `nobody@${DOMAIN}`);
        assert.equal(unknown && unknown.responseCode, 550);
        assert.match(unknown.message, /5\.1\.1/);
        const relay = await rcpt(b, 'victim@elsewhere.example');
        assert.equal(relay && relay.responseCode, 550);
        assert.match(relay.message, /5\.7\.1/);
    } finally { b.plugin.deactivate(); }

    const withCatchAll = await boot({ smtp_catch_all: '1' });
    try {
        assert.equal(await rcpt(withCatchAll, `anything@${DOMAIN}`), null, 'catch-all accepts any address on the domain');
    } finally { withCatchAll.plugin.deactivate(); }
});

test('administration routes answer for an administrator', async () => {
    const b = await boot({ mail_quota_default_mb: '500' });
    try {
        await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Stats', body: 'x' } });
        const ov = await call(b, 'get /admin/overview', BOSS);
        assert.equal(ov.status, 200, JSON.stringify(ov.body));
        assert.equal(ov.body.series.length, 14);
        assert.ok(ov.body.totals.messages >= 2);
        assert.equal(ov.body.mailDomain, DOMAIN);

        const mb = await call(b, 'get /admin/mailboxes', BOSS);
        assert.equal(mb.status, 200);
        const bob = mb.body.mailboxes.find((m: any) => m.id === BOB.id);
        assert.ok(bob, 'Bob has a mailbox');
        assert.equal(bob.quotaMb, 500, 'inherits the site default');
        assert.equal(mb.body.mailboxes.some((m: any) => m.id === BOSS.id), false, 'no mailbox, no mail → not listed');

        const q = await call(b, 'get /admin/queue', BOSS);
        assert.equal(q.status, 200);
        assert.ok(Array.isArray(q.body.items));

        const settings = await call(b, 'get /settings', BOSS);
        assert.equal(settings.body.mail_quota_default_mb, '500');
    } finally { b.plugin.deactivate(); }
});

test('forwarding carries the original attachments by id, and only ones the sender may read', async () => {
    const b = await boot();
    try {
        const raw = [
            'From: c@outside.example', `To: ${BOB.userEmail}`, 'Subject: Budget', 'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="XX"', '', '--XX', 'Content-Type: text/plain', '', 'see attached',
            '--XX', 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64',
            'Content-Disposition: attachment; filename="budget.pdf"', '', Buffer.from('%PDF-1.4 demo').toString('base64'), '--XX--', ''
        ].join('\r\n');
        assert.equal(await inbound(b, raw), null);
        const [received] = await rowsOf(b, BOB.id);
        const [att] = await b.db.all(`SELECT * FROM ${PREFIX}email_attachments WHERE email_id = ?`, [received.id]);
        assert.ok(att, 'the inbound attachment is stored');

        const fwd = await call(b, 'post /send', BOB, { body: { to: ALICE.userEmail, subject: 'Fwd: Budget', body: 'fyi', attachments: [{ attachmentId: att.id, filename: 'ignored.exe', path: '../../index.js' }] } });
        assert.equal(fwd.status, 200, JSON.stringify(fwd.body));
        const aliceCopy = (await rowsOf(b, ALICE.id)).find((r: any) => r.subject === 'Fwd: Budget');
        assert.ok(aliceCopy, 'Alice received the forward');
        const copied = await b.db.all(`SELECT * FROM ${PREFIX}email_attachments WHERE email_id = ?`, [aliceCopy.id]);
        assert.equal(copied.length, 1, 'the original file travelled with the forward');
        assert.equal(copied[0].filename, 'budget.pdf', 'name and bytes come from the stored row, not the client');
        assert.notEqual(copied[0].storage_path, att.storage_path, 'a copy, not a shared blob');

        // Alice cannot read Bob's message, so naming its attachment id gets her nothing.
        const steal = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Steal', body: 'x', attachments: [{ attachmentId: att.id }] } });
        assert.equal(steal.status, 200, JSON.stringify(steal.body));
        const stolen = (await rowsOf(b, BOB.id)).find((r: any) => r.subject === 'Steal');
        assert.ok(stolen);
        assert.equal((await b.db.all(`SELECT * FROM ${PREFIX}email_attachments WHERE email_id = ?`, [stolen.id])).length, 0);
        const draft = await call(b, 'post /drafts', ALICE, { body: { to: BOB.userEmail, subject: 'Steal draft', body: 'x', attachments: [{ attachmentId: att.id }] } });
        assert.equal((await b.db.all(`SELECT * FROM ${PREFIX}email_attachments WHERE email_id = ?`, [draft.body.id])).length, 0);
    } finally { b.plugin.deactivate(); }
});
