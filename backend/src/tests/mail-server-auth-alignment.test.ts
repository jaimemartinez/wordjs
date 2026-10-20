/**
 * mail-server 3.0.4: who a message is authenticated FOR, and what the outbound retry queue charges.
 *
 * The real plugin module is booted over the real store (as in mail-server-dkim-dmarc.test.ts); inbound
 * mail goes through its real onData with a fake TXT resolver behind the host DNS bridge, and the
 * outbound queue timer is captured at init so a test can run one pass on demand. The webmail's own
 * authVerdict() is lifted out of Webmail.tsx and fed the Authentication-Results the server stored.
 *
 * Pinned:
 *   - a From naming several domains gets the strictest DMARC outcome among them (RFC 7489 §6.6.1),
 *     several From header fields are refused, and such mail is never shown as a verified sender;
 *   - relaxed alignment uses the Public Suffix List: registrants under a multi-label public suffix do
 *     not align with each other, and an unknown suffix aligns only on an exact match;
 *   - a DKIM signature whose l= leaves part of the body unsigned authenticates nobody: no DMARC
 *     alignment, no local-domain authentication, no "Verified" badge, and the webmail says so;
 *   - the automatic retry queue charges a message once, and site/provider mail (user_id 0) retries
 *     on a budget of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Readable } from 'stream';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const WEBMAIL_SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'client/admin/Webmail.tsx'), 'utf8').replace(/\r\n/g, '\n');
const MailAuth = require(path.join(PLUGIN_DIR, 'lib/mail-auth.js'));

// Appended to the shipped source so it closes over the module's own bindings; nothing is altered.
const SUITE_HOOK = `
;module.exports.__authSuite = {
    get Email() { return Email; },
    usage(key) { const e = _outboundUsage.get(key); return e ? e.messages : 0; },
    outboundRateLimitOk,
    resetRateLimits() { _outboundUsage.clear(); },
};`;

// --- keys, DNS, signer -------------------------------------------------------------------------------

const ed = crypto.generateKeyPairSync('ed25519');
const ED_PUB = (ed.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64');
const KEY = `v=DKIM1; k=ed25519; p=${ED_PUB}`;

type Txt = Record<string, string | Error>;
const enotfound = () => Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
const resolverFor = (records: Txt) => async (name: string) => {
    const r = records[name.toLowerCase()];
    if (r === undefined) throw enotfound();
    if (r instanceof Error) throw r;
    return [[r]];
};

/**
 * An ed25519-sha256 simple/simple signature (RFC 8463) by d=`domain`, written independently of the
 * verifier. `signedBody` is what the signature covers; with `l` it signs only that many bytes of it and
 * `appended` is added AFTER signing — the shape an l= signature allows.
 */
function signed(headers: string[], signedBody: string, { domain, l, appended = '' }: { domain: string; l?: boolean; appended?: string }): Buffer {
    const canon = signedBody.replace(/(\r\n)*$/, '') + '\r\n';
    const bh = crypto.createHash('sha256').update(canon).digest('base64');
    const names = headers.map(h => h.slice(0, h.indexOf(':')).toLowerCase());
    const lTag = l ? ` l=${Buffer.byteLength(canon)};` : '';
    const sigNoB = `DKIM-Signature: v=1; a=ed25519-sha256; c=simple/simple; d=${domain}; s=ed; h=${names.join(':')}; bh=${bh};${lTag} b=`;
    const data = headers.map(h => h + '\r\n').join('') + sigNoB;
    const sig = crypto.sign(null, crypto.createHash('sha256').update(data).digest(), ed.privateKey).toString('base64');
    return Buffer.from([sigNoB + sig, ...headers].join('\r\n') + '\r\n\r\n' + canon + appended);
}

// --- the plugin --------------------------------------------------------------------------------------

const DOMAIN = 'acme.example';
const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', accountCapabilities: ['mail_server_mailbox'] };
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${DOMAIN}`, userLogin: 'alice', displayName: 'Alice', accountCapabilities: ['mail_server_mailbox'] };
const BOB = { id: 3, role: 'author', userEmail: `bob@${DOMAIN}`, userLogin: 'bob', displayName: 'Bob', accountCapabilities: ['mail_server_mailbox'] };
const USERS = [BOSS, ALICE, BOB];

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
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}${SUITE_HOOK}\n})`, { filename: PLUGIN_SRC });
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

async function boot(dnsRecords: Txt = {}, extraOptions: Record<string, string> = {}) {
    const db = makeDb();
    const routes = new Map<string, any>();
    const options: Record<string, string> = { smtp_listen_port: '2525', mail_undo_send_seconds: '0', ...extraOptions };
    const find = (pred: (u: any) => boolean) => USERS.find(pred) || null;
    const resolveTxt = resolverFor(dnsRecords);
    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; }
        },
        site: { async url() { return `https://${DOMAIN}`; }, async domain() { return DOMAIN; }, async adminEmail() { return BOSS.userEmail; } },
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
            resolveTxt: async (name: string) => (await resolveTxt(name)),
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
    assert.ok(queueTick, 'the plugin registers its queue timer at init');
    const suite = plugin.__authSuite;
    suite.resetRateLimits();
    return { plugin, suite, routes, db, smtp: smtpInstances[0], tick: () => queueTick() };
}
type Boot = Awaited<ReturnType<typeof boot>>;

const EXTERNAL = (mailFrom = 'bounce@elsewhere.example', spfHeader = 'Received-SPF: fail (test) envelope-from=<bounce@elsewhere.example>') =>
    ({ remoteAddress: '203.0.113.9', spfHeader, envelope: { mailFrom: { address: mailFrom }, rcptTo: [{ address: BOB.userEmail }] } });

function deliver(b: Boot, raw: Buffer, session: any = EXTERNAL()): Promise<any> {
    return new Promise((resolve) => b.smtp.options.onData(Readable.from([raw]), session, (err: any) => resolve(err || null)));
}
const bobRows = (b: Boot) => b.db.all(`SELECT * FROM ${PREFIX}received_emails WHERE user_id = ? ORDER BY id`, [BOB.id]);

function loadAuthVerdict(): (h: string) => any {
    const start = WEBMAIL_SRC.indexOf('const authVerdict');
    const end = WEBMAIL_SRC.indexOf('\n};\n', start) + 4;
    assert.ok(start > 0 && end > start, 'authVerdict was not found in Webmail.tsx');
    const js = WEBMAIL_SRC.slice(start, end).replace('(header?: string)', '(header)');
    return vm.runInNewContext(`${js}\nauthVerdict`);
}
const authVerdict = loadAuthVerdict();

const TO = `To: ${BOB.userEmail}`;

// ================================================================================================
// Several From domains

const MULTI_DNS: Txt = {
    'ed._domainkey.benign.example': KEY,
    'ed._domainkey.victim.com': KEY,
    '_dmarc.victim.com': 'v=DMARC1; p=reject',
};

test('a From naming several domains gets the strictest policy among them — refused at DATA', async () => {
    const b = await boot(MULTI_DNS);
    try {
        // A valid, aligned signature for the FIRST domain; the second one (p=reject) is unauthenticated.
        const headers = ['From: "Ann" <ann@benign.example>, "CEO" <ceo@victim.com>', TO, 'Subject: Two senders'];
        const res = await deliver(b, signed(headers, 'Wire the money.\r\n', { domain: 'benign.example' }));
        assert.equal(res && res.responseCode, 550, 'victim.com rejects mail it did not authenticate');
        assert.match(String(res.message), /DMARC policy of victim\.com/);

        // Group syntax lists the same addresses under a group name.
        const group = ['From: Board: ann@benign.example, ceo@victim.com;', TO, 'Subject: Group'];
        const g = await deliver(b, signed(group, 'Wire the money.\r\n', { domain: 'benign.example' }));
        assert.equal(g && g.responseCode, 550, 'a From group is evaluated member by member');

        // Several From FIELDS cannot be evaluated at all.
        const fields = ['From: ann@benign.example', 'From: ceo@victim.com', TO, 'Subject: Two fields'];
        const f = await deliver(b, signed(fields, 'x\r\n', { domain: 'benign.example' }));
        assert.equal(f && f.responseCode, 550, 'several From header fields are refused');
        assert.equal((await bobRows(b)).length, 0);
    } finally { b.plugin.deactivate(); }
});

test('several From domains: quarantine files in Spam; even when every domain passes, it is never "Verified"', async () => {
    const q = await boot({ ...MULTI_DNS, '_dmarc.victim.com': 'v=DMARC1; p=quarantine' });
    try {
        const headers = ['From: ann@benign.example, ceo@victim.com', TO, 'Subject: Quarantined'];
        assert.equal(await deliver(q, signed(headers, 'x\r\n', { domain: 'benign.example' })), null);
        const [row] = await bobRows(q);
        assert.equal(row.is_spam, 1, 'the strictest disposition (quarantine) applies');
        assert.equal(row.from_address, 'ann@benign.example');
        const v = authVerdict(row.auth_results);
        assert.deepEqual(v.severalFrom, ['benign.example', 'victim.com'], 'the stored verdict names every From domain');
        assert.equal(v.verified, false);
        assert.equal(v.dmarc.domain, 'victim.com', 'and the domain whose policy applied');
    } finally { q.plugin.deactivate(); }

    // Both domains sign, both align: still no single domain speaks for the whole From.
    const b = await boot({ ...MULTI_DNS, '_dmarc.benign.example': 'v=DMARC1; p=reject' });
    try {
        const headers = ['From: ann@benign.example, ceo@victim.com', TO, 'Subject: Both signed'];
        const one = signed(headers, 'x\r\n', { domain: 'benign.example' });
        const second = signed(headers, 'x\r\n', { domain: 'victim.com' }).toString('latin1').split('\r\n')[0];
        assert.equal(await deliver(b, Buffer.from(second + '\r\n' + one.toString('latin1'), 'latin1')), null, 'accepted');
        const [row] = await bobRows(b);
        assert.equal(row.is_spam, 0);
        assert.match(row.auth_results, /dmarc=permerror \(from=benign\.example,victim\.com\)/);
        const v = authVerdict(row.auth_results);
        assert.equal(v.verified, false, 'never shown as a verified sender');
        assert.equal(v.severalFrom.length, 2, 'the webmail shows the several-senders notice');
    } finally { b.plugin.deactivate(); }

    // One From domain stays exactly as before.
    const single = await boot(MULTI_DNS);
    try {
        const headers = ['From: ceo@victim.com', TO, 'Subject: Genuine'];
        assert.equal(await deliver(single, signed(headers, 'x\r\n', { domain: 'victim.com' })), null);
        const v = authVerdict((await bobRows(single))[0].auth_results);
        assert.deepEqual([v.verified, v.severalFrom.length], [true, 0]);
    } finally { single.plugin.deactivate(); }
});

// ================================================================================================
// Public Suffix List

test('organizational domains come from the Public Suffix List; an unknown suffix aligns only exactly', () => {
    assert.equal(MailAuth.organizationalDomain('mail.victim.co.at'), 'victim.co.at');
    assert.equal(MailAuth.organizationalDomain('a.b.shop.net.pl'), 'shop.net.pl');
    assert.equal(MailAuth.organizationalDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.equal(MailAuth.organizationalDomain('www.city.kawasaki.jp'), 'city.kawasaki.jp', 'an exception rule');
    assert.equal(MailAuth.organizationalDomain('a.b.c.kawasaki.jp'), 'b.c.kawasaki.jp', 'a wildcard rule');
    assert.equal(MailAuth.organizationalDomain('alice.github.io'), 'alice.github.io', 'the private section counts too');
    assert.equal(MailAuth.organizationalDomain('co.at'), '', 'a public suffix has no organizational domain');

    assert.equal(MailAuth.aligned('attacker.co.at', 'victim.co.at', 'r'), false);
    assert.equal(MailAuth.aligned('alice.github.io', 'bob.github.io', 'r'), false);
    assert.equal(MailAuth.aligned('mail.example.com', 'example.com', 'r'), true, 'a subdomain of a known suffix still aligns');
    assert.equal(MailAuth.aligned('mail.victim.corp.zz', 'victim.corp.zz', 'r'), false, 'unknown suffix: no relaxed match');
    assert.equal(MailAuth.aligned('victim.corp.zz', 'victim.corp.zz', 'r'), true, 'but an exact match is fine');
    assert.match(require(path.join(PLUGIN_DIR, 'lib/public-suffix-list.js')).version, /^\d{4}-\d{2}-\d{2}/);
});

test('onData: a signature of another registrant under a public suffix does not satisfy p=reject', async () => {
    const b = await boot({
        'ed._domainkey.attacker.co.at': KEY, '_dmarc.victim.co.at': 'v=DMARC1; p=reject',
        'ed._domainkey.attacker.corp.zz': KEY, '_dmarc.victim.corp.zz': 'v=DMARC1; p=reject',
        'ed._domainkey.mail.example.com': KEY, '_dmarc.example.com': 'v=DMARC1; p=reject',
    });
    try {
        const at = await deliver(b, signed(['From: ceo@victim.co.at', TO, 'Subject: Listed suffix'], 'x\r\n', { domain: 'attacker.co.at' }));
        assert.equal(at && at.responseCode, 550, 'co.at is a public suffix: attacker.co.at is not victim.co.at');
        const zz = await deliver(b, signed(['From: ceo@victim.corp.zz', TO, 'Subject: Unknown suffix'], 'x\r\n', { domain: 'attacker.corp.zz' }));
        assert.equal(zz && zz.responseCode, 550, 'an unknown suffix gives no relaxed match');
        assert.equal((await bobRows(b)).length, 0);

        assert.equal(await deliver(b, signed(['From: news@example.com', TO, 'Subject: Relaxed'], 'x\r\n', { domain: 'mail.example.com' })), null);
        const [row] = await bobRows(b);
        assert.equal(authVerdict(row.auth_results).verified, true, 'relaxed alignment under a known suffix still verifies');
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// DKIM l=

const L_DNS: Txt = { 'ed._domainkey.sender.example': KEY, [`ed._domainkey.${DOMAIN}`]: KEY };
const PARTIAL = { domain: 'sender.example', l: true, appended: 'Correction: pay account 666 instead.\r\n' };

test('DKIM l= shorter than the body: a pass with unsigned content, which authenticates nobody', async () => {
    const headers = ['From: Ann <ann@sender.example>', TO, 'Subject: Invoice'];
    const raw = signed(headers, 'Pay account 123.\r\n', PARTIAL);
    const [sig] = await MailAuth.verifyDkim(raw, { resolveTxt: resolverFor(L_DNS) });
    assert.deepEqual([sig.result, sig.partial], ['pass', true], 'the signed part itself verifies');
    assert.equal(MailAuth.fullPass(sig), false);
    const whole = (await MailAuth.verifyDkim(signed(headers, 'Pay account 123.\r\n', { domain: 'sender.example', l: true }), { resolveTxt: resolverFor(L_DNS) }))[0];
    assert.deepEqual([whole.result, !!whole.partial], ['pass', false], 'an l= covering the whole body is a full pass');

    const reject = await boot({ ...L_DNS, '_dmarc.sender.example': 'v=DMARC1; p=reject' });
    try {
        const res = await deliver(reject, raw);
        assert.equal(res && res.responseCode, 550, 'it does not satisfy DMARC alignment');
        const full = await deliver(reject, signed(headers, 'Pay account 123.\r\n', { domain: 'sender.example', l: true }));
        assert.equal(full, null, 'a fully covered body still does');

        // Nor does it authenticate a From on our own domain.
        const boss = signed([`From: Boss <${BOSS.userEmail}>`, TO, 'Subject: From the boss'], 'Approved.\r\n', { ...PARTIAL, domain: DOMAIN });
        const forged = await deliver(reject, boss, EXTERNAL('bounce@relay.example'));
        assert.equal(forged && forged.responseCode, 550, 'a partial signature of our domain is not authentication');
    } finally { reject.plugin.deactivate(); }

    const none = await boot({ ...L_DNS, '_dmarc.sender.example': 'v=DMARC1; p=none' });
    try {
        assert.equal(await deliver(none, raw), null);
        // Aligned SPF passes DMARC on its own, yet the unsigned tail still keeps the badge away.
        const spf = EXTERNAL('bounce@sender.example', 'Received-SPF: pass (test) envelope-from=<bounce@sender.example>');
        assert.equal(await deliver(none, signed([...headers.slice(0, 2), 'Subject: Invoice 2'], 'Pay account 123.\r\n', PARTIAL), spf), null);
        const [first, second] = await bobRows(none);
        assert.match(first.auth_results, /dkim=pass \(unsigned-content-after-l=\) header\.d=sender\.example/);
        const v1 = authVerdict(first.auth_results);
        assert.equal(v1.dkimPartial.domain, 'sender.example', 'the webmail shows the unsigned-content notice');
        assert.equal(v1.dkimPass, undefined, 'and no "Signed by" badge');
        assert.equal(v1.verified, false);
        const v2 = authVerdict(second.auth_results);
        assert.equal(v2.dmarc.result, 'pass');
        assert.equal(v2.verified, false, 'no "Verified" badge while part of the body is unsigned');
    } finally { none.plugin.deactivate(); }

    assert.match(WEBMAIL_SRC, /auth\?\.dkimPartial \|\| severalFrom\) && \(/, 'the reading pane renders the notice');
    assert.match(WEBMAIL_SRC, /const dmarcPass = !!auth\?\.verified;/, 'the Verified badge follows authVerdict().verified');
});

// ================================================================================================
// Retry queue charges

test('the retry queue charges a user\'s message once — the send — not on every pass', async () => {
    const b = await boot();
    try {
        const sent = await call(b, 'post /send', ALICE, { body: { to: 'someone@remote.example', subject: 'Out', body: 'hi' } });
        assert.equal(sent.status, 207, 'saved; the external delivery failed for now');
        const { id } = await b.db.get(`SELECT id FROM ${PREFIX}received_emails WHERE subject = 'Out' AND is_sent = 1`);
        assert.equal((await row(b, id)).delivery_status, 'retry', 'DNS fails in this harness → a temporary failure');
        assert.equal(b.suite.usage(ALICE.id), 1, 'POST /send charged the message');

        for (let pass = 0; pass < 3; pass++) {
            await b.db.run(`UPDATE ${PREFIX}received_emails SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), id]);
            await b.tick();
        }
        const after: any = await row(b, id);
        assert.equal(after.delivery_attempts, 4, 'three more attempts were made');
        assert.equal(b.suite.usage(ALICE.id), 1, 'and none of them charged Alice again');

        // A row the queue meets without a recorded charge (e.g. after a restart) is charged once.
        const rec = await b.suite.Email.create({ messageId: '<r2@t>', fromAddress: ALICE.userEmail, fromName: 'Alice', toAddress: 'x@remote.example', subject: 'Old', bodyText: 'b', isSent: 1, userId: ALICE.id });
        for (let pass = 0; pass < 2; pass++) {
            await b.suite.Email.markRetry(rec.id, 1, new Date(Date.now() - 1000).toISOString(), 'temporary');
            await b.tick();
        }
        assert.equal(b.suite.usage(ALICE.id), 2, 'charged at its first pass only');
    } finally { b.plugin.deactivate(); }
});

test('site and provider mail (user_id 0) retries on its own budget, not a shared 100/hour bucket', async () => {
    const b = await boot();
    try {
        const Email = b.suite.Email;
        const ids: number[] = [];
        for (let i = 0; i < 120; i++) {
            const rec = await Email.create({ messageId: `<s${i}@t>`, fromAddress: `wordpress@${DOMAIN}`, fromName: 'Site', toAddress: `u${i}@remote.example`, subject: 'Reset your password', bodyText: 'b', isSent: 1, userId: 0 });
            await Email.markRetry(rec.id, 1, new Date(Date.now() - 1000).toISOString(), 'temporary');
            ids.push(rec.id);
        }
        await b.tick();
        const rows = await b.db.all(`SELECT * FROM ${PREFIX}received_emails WHERE user_id = 0 ORDER BY id`);
        assert.equal(rows.filter((r: any) => /rate limit/i.test(String(r.last_error))).length, 0, 'no site retry was postponed');
        assert.ok(rows.every((r: any) => r.delivery_attempts === 2), 'every one was attempted');
        assert.equal(b.suite.usage('queue:site'), 0, 'the scheduled-queue bucket is untouched');

        // A second pass over the same messages charges nothing more.
        const before = b.suite.usage('retry:site');
        assert.equal(before, 120);
        await b.db.run(`UPDATE ${PREFIX}received_emails SET next_attempt_at = ? WHERE user_id = 0`, [new Date(Date.now() - 1000).toISOString()]);
        await b.tick();
        assert.equal(b.suite.usage('retry:site'), before);
    } finally { b.plugin.deactivate(); }
});

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
const row = (b: Boot, id: number) => b.db.get(`SELECT * FROM ${PREFIX}received_emails WHERE id = ?`, [id]);
