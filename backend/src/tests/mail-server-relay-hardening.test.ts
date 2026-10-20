/**
 * mail-server 3.0.3 outbound / inbound hardening.
 *
 * Same approach as mail-server-features.test.ts: the REAL plugin module is loaded, its REAL init()
 * registers the REAL routes over the real email store on an in-memory SQLite database, and the
 * smtp-server double keeps the handler options so inbound mail runs through the real onData. The
 * background queue timer is captured at init so a test can run one tick on demand.
 *
 * What is pinned:
 *   - the background queues only deliver what is still a message waiting to go out (never a draft or
 *     a trashed row), a rewrite of recipients/content clears a row's delivery state, a draft holds no
 *     more recipients than a send, and both queues stay inside the per-user outbound limit — without
 *     counting a message POST /send already charged a second time;
 *   - inbound copies go to the SMTP envelope recipients, not to whoever the headers name;
 *   - mail from outside that claims our own domain is refused unless SPF authenticated that domain;
 *   - a reply only joins a conversation the replying mailbox owns (composer and inbound threading);
 *   - the webmail's URL filter is an allowlist that sees through control characters.
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
const UI_SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'client/admin/ui.tsx'), 'utf8');

// Appended to the shipped source so it closes over the module's own bindings; nothing is altered.
const SUITE_HOOK = `
;module.exports.__relaySuite = {
    get Email() { return Email; },
    outboundRateLimitOk,
    resetRateLimits() { _outboundUsage.clear(); },
};`;

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
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}${SUITE_HOOK}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', accountCapabilities: ['mail_server_mailbox'] };
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${DOMAIN}`, userLogin: 'alice', displayName: 'Alice', accountCapabilities: ['mail_server_mailbox'] };
const BOB = { id: 3, role: 'author', userEmail: `bob@${DOMAIN}`, userLogin: 'bob', displayName: 'Bob', accountCapabilities: ['mail_server_mailbox'] };
const USERS = [BOSS, ALICE, BOB];

type Boot = { plugin: any; suite: any; routes: Map<string, any>; db: any; smtp: any; tick: () => Promise<void> };

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
            async search() { return USERS; }
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
    // Capture the queue timer instead of letting it run on its own clock.
    let queueTick: any = null;
    const realSetInterval = global.setInterval;
    (global as any).setInterval = (fn: any) => { if (!queueTick) queueTick = fn; return realSetInterval(() => { }, 1 << 30); };
    try { await plugin.init(bridge); } finally { (global as any).setInterval = realSetInterval; }
    assert.ok(queueTick, 'the plugin registers its queue timer at init');
    const suite = plugin.__relaySuite;
    suite.resetRateLimits();
    return { plugin, suite, routes, db, smtp: smtpInstances[0], tick: () => queueTick() };
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

function inbound(b: Boot, raw: string, session: any): Promise<any> {
    return new Promise((resolve) => {
        b.smtp.options.onData(Readable.from([raw]), session, (err: any) => resolve(err || null));
    });
}

const row = (b: Boot, id: number) => b.db.get(`SELECT * FROM ${PREFIX}received_emails WHERE id = ?`, [id]);
const rowsOf = (b: Boot, userId: number) =>
    b.db.all(`SELECT * FROM ${PREFIX}received_emails WHERE user_id = ? ORDER BY id`, [userId]);

/** A Sent row of Alice's waiting in the retry queue, due now. */
async function retryRow(b: Boot, to = 'someone@remote.example') {
    const Email = b.suite.Email;
    const rec = await Email.create({
        messageId: `<r-${Math.random()}@t>`, fromAddress: ALICE.userEmail, fromName: 'Alice', toAddress: to,
        subject: 'Original', bodyText: 'original body', isSent: 1, userId: ALICE.id
    });
    await Email.markRetry(rec.id, 1, new Date(Date.now() - 1000).toISOString(), 'temporary');
    return rec.id;
}

// ================================================================================================
// Outbound queues

test('a retry row rewritten through POST /drafts leaves the retry queue', async () => {
    const b = await boot();
    try {
        const id = await retryRow(b);
        assert.equal((await b.suite.Email.getPendingRetries()).length, 1, 'the genuine retry is due');

        const many = Array.from({ length: 40 }, (_, i) => `r${i}@remote.example`).join(', ');
        const saved = await call(b, 'post /drafts', ALICE, { body: { id, to: many, subject: 'Rewritten', body: '<p>new</p>' } });
        assert.equal(saved.status, 200);

        const after: any = await row(b, id);
        assert.equal(after.is_draft, 1);
        assert.equal(after.delivery_status, null, 'rewriting recipients/content clears the delivery state');
        assert.equal(after.next_attempt_at, null);
        assert.deepEqual(await b.suite.Email.getPendingRetries(), [], 'the retry queue never delivers a rewritten draft');
    } finally { b.plugin.deactivate(); }
});

test('the retry queue skips drafts and trashed rows even with a retry state', async () => {
    const b = await boot();
    try {
        const Email = b.suite.Email;
        const draft = await retryRow(b);
        await b.db.run(`UPDATE ${PREFIX}received_emails SET is_draft = 1 WHERE id = ?`, [draft]);
        const trashed = await retryRow(b);
        await b.db.run(`UPDATE ${PREFIX}received_emails SET is_trash = 1 WHERE id = ?`, [trashed]);
        const real = await retryRow(b);
        assert.deepEqual((await Email.getPendingRetries()).map((r: any) => r.id), [real]);
    } finally { b.plugin.deactivate(); }
});

test('a temporary failure still re-arms the retry after the recipient rewrite', async () => {
    // updateRetryState rewrites to_address to the still-failed recipients; that rewrite clears the
    // delivery state, so the retry mark has to be written after it, or every genuine retry is lost.
    const b = await boot();
    try {
        const id = await retryRow(b);
        await b.tick(); // DNS fails in this harness → a temporary failure
        const after: any = await row(b, id);
        assert.equal(after.delivery_status, 'retry', 'still queued for another attempt');
        assert.ok(after.next_attempt_at && Date.parse(after.next_attempt_at) > Date.now(), 'with a future attempt time');
        assert.equal(after.delivery_attempts, 2, 'and the attempt was counted');
    } finally { b.plugin.deactivate(); }
});

test('POST /drafts holds no more recipients than a send allows', async () => {
    const b = await boot();
    try {
        const many = Array.from({ length: 51 }, (_, i) => `r${i}@remote.example`).join(', ');
        const r = await call(b, 'post /drafts', ALICE, { body: { to: many, subject: 's', body: 'b' } });
        assert.equal(r.status, 400);
        const ok = await call(b, 'post /drafts', ALICE, { body: { to: 'one@remote.example', subject: 's', body: 'b' } });
        assert.equal(ok.status, 200, 'a normal draft still saves');
    } finally { b.plugin.deactivate(); }
});

test('the retry queue stays inside the sender\'s outbound limit — postponed, not spent', async () => {
    const b = await boot();
    try {
        const id = await retryRow(b);
        assert.ok(b.suite.outboundRateLimitOk(ALICE.id, 500), 'use up Alice\'s hourly recipients');
        await b.tick();
        const after: any = await row(b, id);
        assert.equal(after.delivery_status, 'retry');
        assert.equal(after.delivery_attempts, 1, 'no delivery attempt was spent');
        assert.match(String(after.last_error), /rate limit/i);
        assert.ok(Date.parse(after.next_attempt_at) > Date.now(), 'the attempt is pushed back');
    } finally { b.plugin.deactivate(); }
});

test('the scheduled queue charges what POST /send did not, and never charges twice', async () => {
    const b = await boot({ mail_undo_send_seconds: '10' });
    try {
        const Email = b.suite.Email;
        // Queued by POST /send (undo window): charged there, so it goes out even with the limit used up.
        const sent = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Queued', body: 'hi' } });
        assert.equal(sent.status, 200);
        assert.ok(sent.body.queued);
        await b.db.run(`UPDATE ${PREFIX}received_emails SET scheduled_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), sent.body.id]);

        // A scheduled row that reached the queue without that charge.
        const other = await Email.create({
            fromAddress: ALICE.userEmail, fromName: 'Alice', toAddress: BOB.userEmail, subject: 'Uncharged',
            bodyText: 'x', isSent: 0, isDraft: 0, userId: ALICE.id, scheduledAt: new Date(Date.now() - 1000).toISOString()
        });

        assert.ok(b.suite.outboundRateLimitOk(ALICE.id, 499), 'use up the rest of Alice\'s hourly recipients');
        await b.tick();

        assert.equal((await row(b, sent.body.id) as any).is_sent, 1, 'the message POST /send charged is delivered');
        const held: any = await row(b, other.id);
        assert.equal(held.is_sent, 0, 'the uncharged one is held back');
        assert.ok(Date.parse(held.scheduled_at) > Date.now(), 'and postponed, not dropped');
        assert.equal((await rowsOf(b, BOB.id)).filter((r: any) => r.subject === 'Uncharged').length, 0);
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// Inbound delivery

const msg = (lines: string[]) => [...lines, '', 'Body.', ''].join('\r\n');

test('inbound copies follow the SMTP envelope, not the To:/Cc: headers', async () => {
    const b = await boot();
    try {
        // The headers name Alice and Bob; the transaction was accepted for Alice only.
        const raw = msg(['From: Ext <ext@outside.example>', `To: ${ALICE.userEmail}, ${BOB.userEmail}`, 'Subject: Envelope only']);
        assert.equal(await inbound(b, raw, { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: 'ext@outside.example' }, rcptTo: [{ address: ALICE.userEmail }] } }), null);
        assert.equal((await rowsOf(b, ALICE.id)).length, 1, 'the envelope recipient gets a copy');
        assert.equal((await rowsOf(b, BOB.id)).length, 0, 'a mailbox only named in the headers gets none');

        // Bcc / list mail: the recipient is in the envelope only.
        const bcc = msg(['From: Ext <ext@outside.example>', 'To: list@outside.example', 'Subject: Blind copy']);
        assert.equal(await inbound(b, bcc, { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: 'ext@outside.example' }, rcptTo: [{ address: BOB.userEmail }, { address: BOB.userEmail.toUpperCase() }] } }), null);
        const bobs = await rowsOf(b, BOB.id);
        assert.equal(bobs.length, 1, 'a Bcc recipient gets exactly one copy');
        assert.equal(bobs[0].subject, 'Blind copy');
    } finally { b.plugin.deactivate(); }
});

test('mail from outside that claims our domain is refused unless SPF authenticated it', async () => {
    const b = await boot();
    try {
        const raw = msg([`From: Boss <${BOSS.userEmail}>`, `To: ${ALICE.userEmail}`, 'Subject: Wire the money']);
        const rcpt = [{ address: ALICE.userEmail }];

        const forged = await inbound(b, raw, { remoteAddress: '203.0.113.9', envelope: { mailFrom: { address: 'x@outside.example' }, rcptTo: rcpt } });
        assert.ok(forged, 'refused');
        assert.equal(forged.responseCode, 550);

        const envForged = await inbound(b, msg(['From: Ext <ext@outside.example>', `To: ${ALICE.userEmail}`, 'Subject: Env']),
            { remoteAddress: '203.0.113.9', envelope: { mailFrom: { address: BOSS.userEmail }, rcptTo: rcpt } });
        assert.equal(envForged && envForged.responseCode, 550, 'the envelope sender is checked too');

        const softfail = `Received-SPF: softfail (${DOMAIN}: x) client-ip=203.0.113.9; envelope-from=<${BOSS.userEmail}>; receiver=${DOMAIN}; identity=mailfrom;`;
        const soft = await inbound(b, raw, { remoteAddress: '203.0.113.9', spfHeader: softfail, envelope: { mailFrom: { address: BOSS.userEmail }, rcptTo: rcpt } });
        assert.equal(soft && soft.responseCode, 550, 'a softfail does not authenticate our domain');
        assert.equal((await rowsOf(b, ALICE.id)).length, 0, 'nothing was stored');

        const pass = softfail.replace('softfail', 'pass');
        assert.equal(await inbound(b, raw, { remoteAddress: '203.0.113.9', spfHeader: pass, envelope: { mailFrom: { address: BOSS.userEmail }, rcptTo: rcpt } }), null,
            'an SPF pass for our own domain (an authorized relay) is accepted');
        assert.equal(await inbound(b, raw, { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: BOSS.userEmail }, rcptTo: rcpt } }), null,
            'our own relay path is never gated');
        assert.equal(await inbound(b, msg(['From: Ext <ext@outside.example>', `To: ${ALICE.userEmail}`, 'Subject: Normal']),
            { remoteAddress: '203.0.113.9', envelope: { mailFrom: { address: 'ext@outside.example' }, rcptTo: rcpt } }), null,
            'ordinary outside mail is unaffected');
        assert.equal((await rowsOf(b, ALICE.id)).length, 3);
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// Threading

test('a reply only joins a conversation the replying mailbox owns', async () => {
    // Undo window on, so POST /send stores the row (with its thread) and answers with its id.
    const b = await boot({ mail_undo_send_seconds: '10' });
    try {
        const Email = b.suite.Email;
        const bobs = await Email.create({ messageId: '<bob-thread@t>', fromAddress: 'ext@outside.example', toAddress: BOB.userEmail, subject: 'Bob\'s', bodyText: 'x', userId: BOB.id });
        const alices = await Email.create({ messageId: '<alice-thread@t>', fromAddress: 'ext@outside.example', toAddress: ALICE.userEmail, subject: 'Alice\'s', bodyText: 'x', userId: ALICE.id });

        for (const route of ['post /drafts', 'post /send']) {
            const foreign = await call(b, route, ALICE, { body: { to: 'x@outside.example', subject: 'Re', body: 'b', replyToId: bobs.id } });
            assert.equal(foreign.status, 200, route);
            const f: any = await row(b, foreign.body.id);
            assert.deepEqual([f.parent_id, f.thread_id], [0, 0], `${route}: another mailbox's row lends no thread`);

            const own = await call(b, route, ALICE, { body: { to: 'x@outside.example', subject: 'Re', body: 'b', replyToId: alices.id } });
            const o: any = await row(b, own.body.id);
            assert.equal(o.thread_id, alices.id, `${route}: her own row still threads the reply`);
        }

        // Inbound: In-Reply-To names Bob's message; delivered to Alice, it must not join Bob's thread.
        const raw = msg(['From: Ext <ext@outside.example>', `To: ${ALICE.userEmail}`, 'Subject: Re: hi', 'In-Reply-To: <bob-thread@t>']);
        await inbound(b, raw, { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: 'ext@outside.example' }, rcptTo: [{ address: ALICE.userEmail }, { address: BOB.userEmail }] } });
        const aliceCopy = (await rowsOf(b, ALICE.id)).find((r: any) => r.subject === 'Re: hi');
        const bobCopy = (await rowsOf(b, BOB.id)).find((r: any) => r.subject === 'Re: hi');
        assert.equal(aliceCopy.thread_id, 0, 'not threaded into a conversation Alice does not own');
        assert.equal(bobCopy.thread_id, bobs.id, 'Bob\'s copy joins his own conversation');
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// Webmail URL filter

function loadIsSafeUrl(): (attr: string, v: string) => boolean {
    const start = UI_SRC.indexOf('const SAFE_SCHEMES');
    const end = UI_SRC.indexOf('\n}\n', UI_SRC.indexOf('export function isSafeUrl')) + 3;
    assert.ok(start > 0 && end > start, 'isSafeUrl was not found in ui.tsx');
    const js = UI_SRC.slice(start, end)
        .replace('export function', 'function')
        .replace(/\(attr: string, compactLower: string\)/, '(attr, compactLower)');
    return vm.runInNewContext(`${js}\nisSafeUrl`);
}

test('the webmail URL filter is an allowlist and sees through control characters', () => {
    const isSafeUrl = loadIsSafeUrl();
    // The same normalisation prepareEmailHtml applies before asking.
    // eslint-disable-next-line no-control-regex -- the point of the test is control characters
    const CONTROL = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f]+', 'g');
    const compact = (v: string) => v.replace(CONTROL, '').toLowerCase();
    assert.ok(UI_SRC.includes('attr.value.replace(/[\\u0000-\\u0020\\u007f-\\u009f]+/g'), 'prepareEmailHtml strips control characters');
    for (const ok of ['https://example.com/', 'http://x', 'mailto:a@b.c', 'cid:part1', '#top', '/relative', 'page.html']) {
        assert.ok(isSafeUrl('href', compact(ok)), ok);
    }
    for (const bad of ['javascript:alert(1)', '\u0001javascript:alert(1)', 'java\u0001script:x', 'JaVa\tScript:x',
        'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y', 'ms-settings:x', 'data:text/html,<b>']) {
        assert.equal(isSafeUrl('href', compact(bad)), false, JSON.stringify(bad));
    }
    assert.ok(isSafeUrl('src', 'data:image/png;base64,AAAA'), 'inline images still render');
    assert.equal(isSafeUrl('href', 'data:image/png;base64,AAAA'), false, 'but not as a link');
    // SVG animation elements can set an attribute after the filter ran; they are removed by name.
    for (const tag of ['set', 'animate', 'animatetransform', 'animatemotion']) {
        assert.match(UI_SRC, new RegExp(`ANIMATION_TAGS = new Set\\([^)]*'${tag}'`), tag);
    }
});
