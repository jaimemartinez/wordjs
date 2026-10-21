/**
 * mail-server 3.2.0 — the defects a three-mode lab pass (monolith/PostgreSQL, split/MariaDB,
 * separate/SQLite) found in the mail plugin, each driven through the REAL plugin module.
 *
 *  · MariaDB rejected every send made with the default undo-send window: `scheduled_at` (DATETIME) was
 *    bound as an ISO string with 'T'/'Z'. A strict DATETIME double below refuses exactly that.
 *  · The legacy-ownership pre-filter bound Number.MAX_SAFE_INTEGER against PostgreSQL's int4 id.
 *  · Site mail (core notices, other plugins, the delivery test) went out as the administrator's
 *    PERSONAL account email whenever "From email" was left empty.
 *  · Attachments were dropped silently: the host deletes its multer temp file when the upload request
 *    ends, so the path the composer held was dead by send time. The upload now stages a copy and hands
 *    back an opaque token; a send naming an unreadable attachment is refused, not sent without it.
 *  · A relay behind STARTTLS on a private address stayed blocked after "Allow host:port": nodemailer's
 *    upgrade carried no port (see mail-server-relay-status for the transport options).
 *  · Smaller ones: the sanitizer double-escaped '&amp;' (links lost their query), Reply-To was never
 *    stored, one mailbox got two copies through an alias, GTUBE was not spam, quoted search phrases,
 *    `-word` and `is:unread` on your own sent mail, a soft quota, a delivery test retried five times.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const createEmailStore = require(path.join(PLUGIN_DIR, 'lib/email-store.js'));
const { sqlDateTime } = createEmailStore;
const { sanitizeEmailHtml } = require(path.join(PLUGIN_DIR, 'lib/sanitize-email-html.js'));

const SUITE_HOOK = `
;module.exports.__qaSuite = {
    get Email() { return Email; },
    resetRateLimits() { _outboundUsage.clear(); },
    captureWire(fn) { deliverDirect = async (recipient, mail) => { fn(recipient, mail); return { mx: 'mx.test', response: '250 OK' }; }; },
    parseSearchQuery,
    siteSenderAddress,
    isGtube,
    buildDnsRecords,
    sendMail: (d) => sendMail(d),
};`;

const DOMAIN = 'acme-corp.com';
const MAILBOX = ['mail_server_mailbox'];
const PERSONAL_ADMIN = 'boss.private@gmail.com';

class FakeSMTPServer {
    constructor(public options: any) { }
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

// An administrator whose ACCOUNT email is personal, and no mailbox of their own (the common setup).
const BOSS = { id: 1, role: 'administrator', userEmail: PERSONAL_ADMIN, userLogin: 'boss', displayName: 'The Boss', accountCapabilities: [] as string[] };
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${DOMAIN}`, userLogin: 'alice', displayName: 'Alice Doe', accountCapabilities: MAILBOX };
const BOB = { id: 3, role: 'editor', userEmail: `bob@${DOMAIN}`, userLogin: 'bob', displayName: 'Bob Roe', accountCapabilities: MAILBOX };
const USERS = [BOSS, ALICE, BOB];

/** MariaDB's strict DATETIME: an ISO literal with 'T'/'Z' bound to scheduled_at is "Incorrect datetime value". */
function strictDatetime(db: any) {
    const check = (sql: string, params: any[]) => {
        if (!/scheduled_at/i.test(sql)) return;
        for (const p of params || []) {
            if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p)) {
                throw new Error(`Incorrect datetime value: '${p}' for column scheduled_at`);
            }
        }
    };
    for (const k of ['run', 'get', 'all']) {
        const orig = db[k].bind(db);
        db[k] = async (sql: string, params: any[] = []) => { check(sql, params); return orig(sql, params); };
    }
    return db;
}

type Boot = { plugin: any; suite: any; routes: Map<string, any>; db: any; wire: any[]; options: Record<string, string>; provider: any; tick: () => Promise<void> };

async function boot(opts: { options?: Record<string, string>; strict?: boolean; db?: any } = {}): Promise<Boot> {
    const db = opts.db || (opts.strict ? strictDatetime(makeDb()) : makeDb());
    const routes = new Map<string, any>();
    const options: Record<string, string> = { smtp_listen_port: '2525', mail_undo_send_seconds: '0', admin_email: PERSONAL_ADMIN, blogname: 'Acme', ...(opts.options || {}) };
    const find = (pred: (u: any) => boolean) => USERS.find(pred) || null;
    let provider: any = null;
    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; }
        },
        site: {
            async url() { return `https://${DOMAIN}`; },
            async domain() { return DOMAIN; },
            async adminEmail() { return PERSONAL_ADMIN; }
        },
        users: {
            async findByEmail(email: string) { return find(u => u.userEmail.toLowerCase() === String(email || '').toLowerCase()); },
            async findByLogin(login: string) { return find(u => u.userLogin.toLowerCase() === String(login || '').toLowerCase()); },
            async findById(id: number) { return find(u => u.id === Number(id)); },
            async search() { return USERS; }
        },
        http: { route(method: string, sub: string, _o: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { } },
        provideMail(fn: any) { provider = fn; },
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
    let queueTick: any = null;
    const realSetInterval = global.setInterval;
    (global as any).setInterval = (fn: any) => { if (!queueTick) queueTick = fn; return realSetInterval(() => { }, 1 << 30); };
    try { await plugin.init(bridge); } finally { (global as any).setInterval = realSetInterval; }
    const suite = plugin.__qaSuite;
    suite.resetRateLimits();
    const wire: any[] = [];
    suite.captureWire((recipient: string, mail: any) => wire.push({ recipient, ...mail }));
    return { plugin, suite, routes, db, wire, options, provider, tick: () => queueTick() };
}

async function call(b: Boot, key: string, user: any, req: any = {}) {
    const handler = b.routes.get(key);
    assert.ok(handler, `route '${key}' is not registered`);
    const out: { status: number; body: any } = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(x: any) { out.body = x; return res; }, send(x: any) { out.body = x; return res; }, end() { return res; }
    };
    await handler({ query: {}, params: {}, body: {}, cookies: {}, ...req, user }, res);
    return out;
}

const rows = (b: Boot) => b.db.all(`SELECT * FROM ${PREFIX}received_emails ORDER BY id`, []);
const DT_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ================================================================================================
// MariaDB: scheduled_at

test('sqlDateTime: every accepted shape becomes the one UTC literal all three engines take', () => {
    const at = Date.UTC(2026, 9, 21, 11, 55, 51, 368);
    assert.equal(sqlDateTime(new Date(at)), '2026-10-21 11:55:51');
    assert.equal(sqlDateTime('2026-10-21T11:55:51.368Z'), '2026-10-21 11:55:51');
    assert.equal(sqlDateTime(at), '2026-10-21 11:55:51');
    assert.equal(sqlDateTime('2026-10-21 11:55:51'), '2026-10-21 11:55:51', 'an already normalized literal is kept');
    assert.equal(sqlDateTime('2026-10-21 11:55'), '2026-10-21 11:55:00');
    assert.equal(sqlDateTime(null), null);
    assert.equal(sqlDateTime(''), null);
    assert.equal(sqlDateTime('not a date'), null);
});

test('MariaDB: a send with the default undo window is queued and delivered (no ISO literal reaches scheduled_at)', async () => {
    const b = await boot({ strict: true, options: { mail_undo_send_seconds: '10' } });
    try {
        const out = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Undoable', body: '<p>hi</p>' } });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.ok(out.body.queued, 'the undo window queues it');
        const queued: any = (await rows(b)).find((r: any) => r.id === out.body.id);
        assert.match(String(queued.scheduled_at), DT_LITERAL, 'stored as the DATETIME literal');

        // Let the window elapse (rewrite in the stored form) and run the queue: delivered to Bob.
        await b.db.run(`UPDATE ${PREFIX}received_emails SET scheduled_at = ? WHERE id = ?`, [sqlDateTime(Date.now() - 1000), out.body.id]);
        await b.tick();
        const after: any = (await rows(b)).find((r: any) => r.id === out.body.id);
        assert.equal(Number(after.is_sent), 1, 'the queue sent it');
        assert.ok((await rows(b)).some((r: any) => Number(r.user_id) === BOB.id && r.subject === 'Undoable'), 'Bob has his copy');
    } finally { b.plugin.deactivate(); }
});

test('MariaDB: scheduling a send for later stores the DATETIME literal, and the queue leaves it until then', async () => {
    const b = await boot({ strict: true });
    try {
        const later = new Date(Date.now() + 3600 * 1000).toISOString();
        const out = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Later', body: 'x', scheduledAt: later } });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        const row: any = (await rows(b)).find((r: any) => r.subject === 'Later' && Number(r.user_id) === ALICE.id);
        assert.equal(row.scheduled_at, sqlDateTime(later));
        await b.tick();
        assert.equal(Number(((await rows(b)).find((r: any) => r.id === row.id) as any).is_sent), 0, 'not before its time');
    } finally { b.plugin.deactivate(); }
});

test('a pending schedule stored in the pre-3.2.0 ISO spelling is normalized at start-up and still goes out on time', async () => {
    const db = makeDb();
    const first = await boot({ db });
    let id: number;
    try {
        const r = await first.suite.Email.create({ fromAddress: ALICE.userEmail, toAddress: BOB.userEmail, subject: 'Legacy', bodyText: 'x', userId: ALICE.id, isSent: 0, isDraft: 0 });
        id = r.id;
    } finally { first.plugin.deactivate(); }
    // What 3.1.x wrote: ISO with 'T' and 'Z', due a second ago (same calendar day as "now").
    await db.run(`UPDATE ${PREFIX}received_emails SET scheduled_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), id]);
    const b = await boot({ db });
    try {
        const row: any = await db.get(`SELECT scheduled_at FROM ${PREFIX}received_emails WHERE id = ?`, [id]);
        assert.match(String(row.scheduled_at), DT_LITERAL, 'rewritten once at start-up');
        await b.tick();
        assert.equal(Number((await db.get(`SELECT is_sent FROM ${PREFIX}received_emails WHERE id = ?`, [id]) as any).is_sent), 1);
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// PostgreSQL: the legacy pre-filter

test('PostgreSQL: the legacy ownership pre-filter never binds an id beyond int4', async () => {
    const db = makeDb();
    const bound: any[] = [];
    const orig = db.all.bind(db);
    (db as any).all = async (sql: string, params: any[] = []) => {
        if (/m\.user_id = 0/.test(sql)) bound.push(...params.filter((p: any) => typeof p === 'number'));
        return orig(sql, params);
    };
    const Email = createEmailStore(db, { resolveUserIdByAddress: async () => 0 });
    await Email.initSchema();
    for (let i = 0; i < 3; i++) {
        await db.run(`INSERT INTO ${PREFIX}received_emails (from_address, to_address, subject, body_text, user_id) VALUES (?, ?, ?, 'x', 0)`, ['ext@o.com', ALICE.userEmail, `old ${i}`]);
    }
    const res = await Email._legacyScan(ALICE.userEmail);
    assert.equal(res.complete, true, 'the pre-filter completed');
    assert.equal(res.ids.length, 3);
    assert.ok(bound.every((n) => n <= 2147483647), `bound ${bound.join(', ')}`);
});

// ================================================================================================
// Site sender

test('site mail is sent as noreply@<mail domain> — never the administrator\'s personal email', async () => {
    const b = await boot();
    try {
        assert.equal(typeof b.provider, 'function', 'the plugin provides the site\'s mail');
        await b.provider({ to: 'client@outside-corp.com', subject: 'Site address changed', text: 'x' });
        const stored = (await rows(b)).filter((r: any) => r.subject === 'Site address changed');
        assert.ok(stored.length >= 1);
        for (const r of stored) assert.equal(r.from_address, `noreply@${DOMAIN}`);
        assert.equal(b.wire.length, 1);
        assert.notEqual(String(b.wire[0].fromEmail).toLowerCase(), PERSONAL_ADMIN);
        assert.notEqual(String(b.wire[0].replyTo || '').toLowerCase(), PERSONAL_ADMIN);

        const test2 = await call(b, 'post /test', BOSS, { body: { to: 'probe@outside-corp.com' } });
        assert.ok(test2.status === 200 || test2.status === 207);
        assert.ok(b.wire.every((m: any) => String(m.fromEmail).toLowerCase() !== PERSONAL_ADMIN), 'the delivery test too');
    } finally { b.plugin.deactivate(); }
});

test('an on-domain "From email" is used; an off-domain one is refused when saved and never used', async () => {
    const { siteSenderAddress } = (await boot()).suite;
    assert.equal(siteSenderAddress(`hello@${DOMAIN}`, DOMAIN), `hello@${DOMAIN}`);
    assert.equal(siteSenderAddress(PERSONAL_ADMIN, DOMAIN), `noreply@${DOMAIN}`, 'a stored off-domain value is not used');
    assert.equal(siteSenderAddress('', '192.168.1.5'), 'noreply@[192.168.1.5]');

    const b = await boot();
    try {
        const bad = await call(b, 'post /settings', BOSS, { body: { mail_from_email: PERSONAL_ADMIN } });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.code, 'mail_from_off_domain');
        assert.match(bad.body.error, new RegExp(`noreply@${DOMAIN.replace('.', '\\.')}`));
        assert.notEqual(b.options.mail_from_email, PERSONAL_ADMIN, 'nothing stored');

        const good = await call(b, 'post /settings', BOSS, { body: { mail_from_email: `News@${DOMAIN}` } });
        assert.equal(good.status, 200, JSON.stringify(good.body));
        const s = await call(b, 'get /settings', BOSS);
        assert.equal(s.body.mail_from_effective, `news@${DOMAIN}`);
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// Attachments

test('an upload is staged in the plugin\'s own dir and answered with an opaque token, never a server path', async () => {
    const b = await boot();
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-multer-')), 'a1b2c3');
    fs.writeFileSync(tmp, 'the file the user picked');
    try {
        const up = await call(b, 'post /upload/attachment', ALICE, { file: { path: tmp, originalname: 'report.txt', mimetype: 'text/plain', size: 24 } });
        assert.equal(up.status, 200, JSON.stringify(up.body));
        assert.match(up.body.file.path, /^[a-f0-9]{32}$/, 'a token, not a path');
        assert.ok(!String(up.body.file.path).includes(os.tmpdir()));
        // The host deletes its temp file as soon as the upload request ends.
        fs.unlinkSync(tmp);

        const sent = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'With file', body: 'x', attachments: [up.body.file] } });
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        const bobCopy: any = (await rows(b)).find((r: any) => Number(r.user_id) === BOB.id && r.subject === 'With file');
        const att = await b.db.all(`SELECT * FROM ${PREFIX}email_attachments WHERE email_id = ?`, [bobCopy.id]);
        assert.equal(att.length, 1, 'the attachment arrived with the message');
        assert.equal(att[0].filename, 'report.txt');
    } finally { b.plugin.deactivate(); }
});

test('an upload the plugin cannot read fails the UPLOAD, and a send naming an unreadable attachment is refused', async () => {
    const b = await boot();
    try {
        const up = await call(b, 'post /upload/attachment', ALICE, { file: { path: path.join(os.tmpdir(), 'wjs-does-not-exist-' + Date.now()), originalname: 'gone.pdf', mimetype: 'application/pdf', size: 3 } });
        assert.equal(up.status, 500);
        assert.equal(up.body.code, 'mail_attachment_unreadable');

        const sent = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Missing file', body: 'x', attachments: [{ filename: 'gone.pdf', path: 'f'.repeat(32) }] } });
        assert.equal(sent.status, 400);
        assert.equal(sent.body.code, 'mail_attachment_unreadable');
        assert.deepEqual(sent.body.unreadable, ['gone.pdf']);
        assert.equal((await rows(b)).filter((r: any) => r.subject === 'Missing file').length, 0, 'nothing was sent without it');

        const draft = await call(b, 'post /drafts', ALICE, { body: { to: BOB.userEmail, subject: 'Draft missing', body: 'x', attachments: [{ filename: 'gone.pdf', path: '/tmp/wordjs-uploads/abc' }] } });
        assert.equal(draft.status, 400, 'a path into the host temp dir (pre-3.2.0 composer state) is not readable either');
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// Sanitizer, Reply-To, aliases, spam, search, quota, the test send

test('the write-side sanitizer keeps character references as written (links keep their query string)', () => {
    assert.equal(
        sanitizeEmailHtml('<p>R&amp;D &lt;tag&gt; <a href="https://x.test/reset?uid=2&amp;token=abc">Reset</a></p>'),
        '<p>R&amp;D &lt;tag&gt; <a href="https://x.test/reset?uid=2&amp;token=abc">Reset</a></p>'
    );
    assert.equal(sanitizeEmailHtml('<p>a & b</p>'), '<p>a &amp; b</p>', 'a bare & is still escaped');
    assert.equal(sanitizeEmailHtml('<p title="&quot;&gt;&lt;img src=x onerror=1&gt;">t</p>').includes('<img'), false);
    assert.equal(sanitizeEmailHtml('<a href="&#106;avascript:alert(1)">x</a>'), '<a>x</a>', 'a hidden scheme is still refused');
});

test('Reply-To travels: stored on the local copy of site mail, never a user\'s personal address', async () => {
    const b = await boot();
    try {
        await b.provider({ to: ALICE.userEmail, subject: 'New message: Contact', text: 'hi', replyTo: 'visitor@example.net' });
        const copy: any = (await rows(b)).find((r: any) => Number(r.user_id) === ALICE.id && r.subject === 'New message: Contact');
        assert.equal(copy.reply_to, 'visitor@example.net');
        await b.provider({ to: ALICE.userEmail, subject: 'Injected', text: 'x', replyTo: 'a@b.test\r\nBcc: evil@x.test' });
        const injected: any = (await rows(b)).find((r: any) => r.subject === 'Injected' && Number(r.user_id) === ALICE.id);
        assert.equal(injected.reply_to || '', '', 'a header-smuggling Reply-To is dropped');
    } finally { b.plugin.deactivate(); }
});

test('a mailbox named directly AND through an alias receives one copy', async () => {
    const b = await boot();
    try {
        const created = await call(b, 'post /admin/aliases', BOSS, { body: { localPart: 'team', destinations: [ALICE.userEmail, BOB.userEmail] } });
        assert.ok(created.status < 300, JSON.stringify(created.body));
        const out = await call(b, 'post /send', ALICE, { body: { to: `${BOB.userEmail}, team@${DOMAIN}`, subject: 'Overlap', body: 'x' } });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        const bobs = (await rows(b)).filter((r: any) => Number(r.user_id) === BOB.id && r.subject === 'Overlap');
        assert.equal(bobs.length, 1);
    } finally { b.plugin.deactivate(); }
});

test('GTUBE is spam, whatever the training', async () => {
    const { isGtube } = (await boot()).suite;
    assert.equal(isGtube('Subject x XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X body'), true);
    assert.equal(isGtube('an ordinary message'), false);
});

test('search: quoted phrases, -exclusions, and is:unread only over received mail', async () => {
    const b = await boot();
    try {
        const q = b.suite.parseSearchQuery('subject:"prueba 1" "exact words" -spam -"not this" is:unread from:ana http://x.test');
        assert.equal(q.subject, 'prueba 1');
        assert.deepEqual(q.terms, ['exact words', 'http://x.test']);
        assert.deepEqual(q.exclude, ['spam', 'not this']);
        assert.equal(q.isUnread, true);
        assert.equal(q.from, 'ana');

        const E = b.suite.Email;
        await E.create({ fromAddress: 'ext@o.com', toAddress: ALICE.userEmail, subject: 'prueba 1', bodyText: 'hola', userId: ALICE.id });
        await E.create({ fromAddress: 'ext@o.com', toAddress: ALICE.userEmail, subject: 'prueba 2', bodyText: 'spam inside', userId: ALICE.id });
        await E.create({ fromAddress: ALICE.userEmail, toAddress: 'x@o.com', subject: 'prueba sent', bodyText: 'x', userId: ALICE.id, isSent: 1 });
        const s = async (raw: string) => (await call(b, 'get /emails/search', ALICE, { query: { q: raw } })).body.emails.map((e: any) => e.subject).sort();
        assert.deepEqual(await s('subject:"prueba 1"'), ['prueba 1']);
        assert.deepEqual(await s('prueba -spam'), ['prueba 1', 'prueba sent']);
        assert.deepEqual(await s('prueba is:unread'), ['prueba 1', 'prueba 2'], 'your own sent copy is not unread');
    } finally { b.plugin.deactivate(); }
});

test('the quota is hard: a message that would not fit is refused, not accepted past the limit', async () => {
    const b = await boot({ options: { mail_quota_default_mb: '1' } });
    try {
        // Usage counts what is stored: text, html and the raw copy — about 3 × 200 KB per message here.
        const big = 'x'.repeat(200 * 1024);
        const first = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Big 1', body: big } });
        assert.equal(first.status, 200, JSON.stringify(first.body));
        const second = await call(b, 'post /send', ALICE, { body: { to: BOB.userEmail, subject: 'Big 2', body: big } });
        assert.equal(second.status, 207, 'the sender is told');
        assert.match(second.body.failed[0].error, /Mailbox full/);
        const bobs = (await rows(b)).filter((r: any) => Number(r.user_id) === BOB.id);
        assert.deepEqual(bobs.map((r: any) => r.subject), ['Big 1'], 'the second copy did not fit in 1 MB');
    } finally { b.plugin.deactivate(); }
});

test('a failed delivery TEST is recorded as failed at once — not retried five times', async () => {
    const b = await boot();
    try {
        b.suite.captureWire(() => { const e: any = new Error('connect ETIMEDOUT'); throw e; });
        const r = await call(b, 'post /test', BOSS, { body: { to: 'probe@outside-corp.com' } });
        assert.equal(r.body.success, false);
        const row: any = (await rows(b)).find((x: any) => x.subject === 'WordJS Mail Server — delivery test');
        assert.equal(row.delivery_status, 'failed');
        assert.equal(row.next_attempt_at, null);
    } finally { b.plugin.deactivate(); }
});

test('webmail sends carry the account\'s display name, not its login', async () => {
    const b = await boot();
    try {
        // The request's user, as the host hands it over: its displayName is the LOGIN (seen in the lab).
        const reqUser = { id: ALICE.id, role: ALICE.role, userEmail: ALICE.userEmail, userLogin: ALICE.userLogin, username: ALICE.userLogin, displayName: ALICE.userLogin, accountCapabilities: MAILBOX };
        for (const undo of ['0', '10']) {
            b.options.mail_undo_send_seconds = undo;
            const subject = `Named ${undo}`;
            const out = await call(b, 'post /send', reqUser, { body: { to: BOB.userEmail, subject, body: '<p>R&amp;D <b>plan</b></p><p>line 2</p>' } });
            assert.equal(out.status, 200, JSON.stringify(out.body));
            const sent: any = (await rows(b)).find((r: any) => Number(r.user_id) === ALICE.id && r.subject === subject);
            assert.equal(sent.from_name, 'Alice Doe', `undo=${undo}: the Sent copy names the account, not its login`);
            assert.equal(sent.body_text, 'R&D plan\nline 2', 'the text body is plain text: tags gone, references decoded, paragraphs kept');
        }
        const draft = await call(b, 'post /drafts', reqUser, { body: { to: BOB.userEmail, subject: 'Draft named', body: 'x' } });
        assert.equal(draft.status, 200);
        assert.equal(((await rows(b)).find((r: any) => r.subject === 'Draft named') as any).from_name, 'Alice Doe');
    } finally { b.plugin.deactivate(); }
});

test('DNS records: the A record proposes this node\'s public IPv4 when it has one; PTR names the HELO host', async () => {
    const { buildDnsRecords } = (await boot()).suite;
    const pub = buildDnsRecords(DOMAIN, 'default', '', { addresses: { public: ['203.0.113.7'], private: ['10.0.0.2'] }, heloHost: `mail.${DOMAIN}` });
    assert.equal(pub.a.value, '203.0.113.7');
    assert.equal(pub.a.detected, true);
    assert.equal(pub.ptr.value, `mail.${DOMAIN}`);
    assert.match(pub.ptr.note, new RegExp(`mail\\.${DOMAIN.replace('.', '\\.')}`));
    const nat = buildDnsRecords(DOMAIN, 'default', '', { addresses: { public: [], private: ['192.168.182.183'] } });
    assert.equal(nat.a.detected, false);
    assert.match(nat.a.note, /forward TCP port 25 to 192\.168\.182\.183/);
});
