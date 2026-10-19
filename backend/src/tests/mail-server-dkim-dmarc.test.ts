/**
 * mail-server inbound DKIM verification and DMARC evaluation (lib/mail-auth.js, wired into onData).
 *
 * The fixtures are REALLY signed: rsa-sha256 relaxed/relaxed messages come from nodemailer's own DKIM
 * signer (an implementation independent of the verifier under test), and ed25519-sha256 simple/simple
 * ones from a minimal signer written here, whose canonicalization is the trivial "simple" form. Keys
 * are generated per run and published through a fake TXT resolver — the same seam the plugin uses
 * (the host DNS bridge).
 *
 * Then the plugin itself: the real module, booted over the real store as in
 * mail-server-relay-hardening.test.ts, receives signed mail through its real onData and must reject,
 * quarantine or deliver it according to the sender domain's DMARC policy, store the verdict, and let a
 * DKIM signature of our own domain authenticate a message that claims it.
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
const WEBMAIL_SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'client/admin/Webmail.tsx'), 'utf8');
const MailAuth = require(path.join(PLUGIN_DIR, 'lib/mail-auth.js'));
const MailComposer = require('nodemailer/lib/mail-composer');
const DKIMSigner = require('nodemailer/lib/dkim');

// --- keys and DNS ----------------------------------------------------------------------------------

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaOther = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = crypto.generateKeyPairSync('ed25519');
const RSA_PUB = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const RSA_OTHER_PUB = rsaOther.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const ED_PUB = (ed.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64');

type Txt = Record<string, string | Error>;
const enotfound = () => Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
const resolverFor = (records: Txt) => async (name: string) => {
    const r = records[name.toLowerCase()];
    if (r === undefined) throw enotfound();
    if (r instanceof Error) throw r;
    // Split long records into 255-byte strings, as DNS does.
    return [r.match(/.{1,255}/g) as string[]];
};

const BASE_DNS: Txt = {
    's1._domainkey.sender.example': `v=DKIM1; k=rsa; p=${RSA_PUB}`,
    's1._domainkey.mail.sender.example': `v=DKIM1; k=rsa; p=${RSA_PUB}`,
    'ed._domainkey.sender.example': `v=DKIM1; k=ed25519; p=${ED_PUB}`,
    's1._domainkey.other.example': `v=DKIM1; k=rsa; p=${RSA_OTHER_PUB}`,
    'revoked._domainkey.sender.example': 'v=DKIM1; k=rsa; p=',
    '_dmarc.sender.example': 'v=DMARC1; p=reject; rua=mailto:d@sender.example',
};

// --- fixtures ----------------------------------------------------------------------------------------

async function composed(opts: any): Promise<Buffer> {
    const mail = new MailComposer({ text: 'Hello there.\nSecond  line   \n\n\n', ...opts }).compile();
    return await new Promise((resolve, reject) => mail.build((e: any, m: Buffer) => (e ? reject(e) : resolve(m))));
}

/** rsa-sha256, relaxed/relaxed, by nodemailer's signer. */
async function rsaSigned(opts: any, domainName = 'sender.example', keySelector = 's1', key = rsa.privateKey): Promise<Buffer> {
    const raw = await composed(opts);
    const signer = new DKIMSigner({ domainName, keySelector, privateKey: key.export({ type: 'pkcs8', format: 'pem' }) });
    const chunks: Buffer[] = [];
    for await (const c of signer.sign(raw)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
}

/** ed25519-sha256, simple/simple (RFC 8463), with a signer independent of the verifier. */
function edSigned(headers: string[], body: string, extraTags = ''): Buffer {
    const bodyCanon = body.replace(/(\r\n)*$/, '') + '\r\n';
    const bh = crypto.createHash('sha256').update(bodyCanon).digest('base64');
    const names = headers.map(h => h.slice(0, h.indexOf(':')).toLowerCase());
    const sigNoB = `DKIM-Signature: v=1; a=ed25519-sha256; c=simple/simple; d=sender.example; s=ed; h=${names.join(':')}; bh=${bh};${extraTags} b=`;
    const data = headers.map(h => h + '\r\n').join('') + sigNoB;
    const sig = crypto.sign(null, crypto.createHash('sha256').update(data).digest(), ed.privateKey).toString('base64');
    return Buffer.from([sigNoB + sig, ...headers].join('\r\n') + '\r\n\r\n' + body);
}

const tamper = (raw: Buffer, from: string, to: string) => {
    const s = raw.toString('latin1');
    assert.ok(s.includes(from), `fixture contains ${from}`);
    return Buffer.from(s.replace(from, to), 'latin1');
};

const MSG = { from: 'Ann <ann@sender.example>', to: 'bob@acme.example', subject: 'Quarterly report' };

// ================================================================================================
// DKIM

test('DKIM: a valid rsa-sha256 relaxed signature verifies; a changed body or signed header does not', async () => {
    const resolveTxt = resolverFor(BASE_DNS);
    const signed = await rsaSigned(MSG);
    assert.deepEqual((await MailAuth.verifyDkim(signed, { resolveTxt })).map((r: any) => [r.result, r.domain, r.selector]),
        [['pass', 'sender.example', 's1']]);

    const body = await MailAuth.verifyDkim(tamper(signed, 'Hello there.', 'Hello there!'), { resolveTxt });
    assert.equal(body[0].result, 'fail');
    assert.match(body[0].reason, /body hash/);

    const header = await MailAuth.verifyDkim(tamper(signed, 'Quarterly report', 'Quarterly rep0rt'), { resolveTxt });
    assert.equal(header[0].result, 'fail');
    assert.match(header[0].reason, /signature did not verify/);

    // Whitespace that relaxed canonicalization ignores is not tampering.
    const ws = await MailAuth.verifyDkim(tamper(signed, 'Subject: Quarterly report', 'Subject:   Quarterly    report  '), { resolveTxt });
    assert.equal(ws[0].result, 'pass');
});

test('DKIM: ed25519-sha256 simple/simple verifies, and simple canonicalization is byte-exact', async () => {
    const resolveTxt = resolverFor(BASE_DNS);
    const headers = ['From: Ann <ann@sender.example>', 'To: bob@acme.example', 'Subject: Ed signed'];
    const signed = edSigned(headers, 'Body line\r\n\r\n');
    assert.equal((await MailAuth.verifyDkim(signed, { resolveTxt }))[0].result, 'pass');
    assert.equal((await MailAuth.verifyDkim(tamper(signed, 'Subject: Ed signed', 'Subject:  Ed signed'), { resolveTxt }))[0].result, 'fail',
        'simple header canonicalization does not forgive whitespace');
    assert.equal((await MailAuth.verifyDkim(tamper(signed, 'Body line', 'Body Line'), { resolveTxt }))[0].result, 'fail');
});

test('DKIM: wrong key, revoked or missing key, weak algorithm, expiry and unsigned From are not a pass', async () => {
    const resolveTxt = resolverFor(BASE_DNS);
    // Signed with other.example's key but claiming d=sender.example: the published key does not match.
    const wrongKey = await rsaSigned(MSG, 'sender.example', 's1', rsaOther.privateKey);
    assert.equal((await MailAuth.verifyDkim(wrongKey, { resolveTxt }))[0].result, 'fail');

    const revoked = await rsaSigned(MSG, 'sender.example', 'revoked');
    assert.deepEqual([(await MailAuth.verifyDkim(revoked, { resolveTxt }))[0].result], ['fail']);
    const missing = await rsaSigned(MSG, 'sender.example', 'nokey');
    assert.equal((await MailAuth.verifyDkim(missing, { resolveTxt }))[0].result, 'permerror');
    const temp = await MailAuth.verifyDkim(await rsaSigned(MSG), { resolveTxt: resolverFor({ ...BASE_DNS, 's1._domainkey.sender.example': new Error('queryTxt ETIMEOUT') }) });
    assert.equal(temp[0].result, 'temperror');

    const headers = ['From: Ann <ann@sender.example>', 'Subject: x'];
    const sha1 = Buffer.from(edSigned(headers, 'b\r\n').toString().replace('a=ed25519-sha256', 'a=rsa-sha1'));
    assert.equal((await MailAuth.verifyDkim(sha1, { resolveTxt }))[0].result, 'policy');
    const expired = edSigned(headers, 'b\r\n', ' x=1000000000;');
    assert.equal((await MailAuth.verifyDkim(expired, { resolveTxt }))[0].result, 'fail');
    const noFrom = edSigned(['Subject: x', 'From: Ann <ann@sender.example>'].slice(0, 1), 'b\r\n');
    assert.equal((await MailAuth.verifyDkim(noFrom, { resolveTxt }))[0].result, 'permerror', 'a signature that does not cover From');
    assert.deepEqual(await MailAuth.verifyDkim(Buffer.from('From: a@b.example\r\n\r\nx'), { resolveTxt }), [], 'unsigned');
});

// ================================================================================================
// DMARC

const dmarcOf = async (raw: Buffer, dnsOverrides: Txt = {}, spf: { spfResult?: string; envelopeFrom?: string } = {}, random = () => 0) =>
    (await MailAuth.authenticateMessage(raw, {
        resolveTxt: resolverFor({ ...BASE_DNS, ...dnsOverrides }),
        spfResult: spf.spfResult || 'fail', envelopeFrom: spf.envelopeFrom || 'bounce@elsewhere.example',
        receiver: 'acme.example', random,
    }));

test('DMARC: an aligned DKIM signature passes; a valid signature of ANOTHER domain (wrong d=) fails p=reject', async () => {
    const ok = await dmarcOf(await rsaSigned(MSG));
    assert.deepEqual([ok.dmarc.result, ok.dmarc.disposition], ['pass', 'none']);
    assert.match(ok.header, /dkim=pass header\.d=sender\.example header\.s=s1/);
    assert.match(ok.header, /dmarc=pass \(p=reject dis=none\) header\.from=sender\.example/);

    const other = await dmarcOf(await rsaSigned(MSG, 'other.example', 's1', rsaOther.privateKey));
    assert.equal(other.dkim[0].result, 'pass', 'the signature itself is fine');
    assert.deepEqual([other.dmarc.result, other.dmarc.policy, other.dmarc.disposition], ['fail', 'reject', 'reject'],
        'but other.example is not aligned with the From domain');

    const tampered = await dmarcOf(tamper(await rsaSigned(MSG), 'Hello there.', 'Pay this invoice.'));
    assert.deepEqual([tampered.dkim[0].result, tampered.dmarc.disposition], ['fail', 'reject']);
});

test('DMARC: relaxed vs strict alignment, SPF alignment, quarantine, pct and the subdomain policy', async () => {
    // Relaxed alignment needs a suffix the Public Suffix List knows (.com); under the reserved
    // .example TLD only an exact match aligns.
    const comDns = { 's1._domainkey.mail.example.com': `v=DKIM1; k=rsa; p=${RSA_PUB}`, '_dmarc.example.com': 'v=DMARC1; p=reject' };
    const sub = await rsaSigned({ ...MSG, from: 'Ann <ann@example.com>' }, 'mail.example.com');
    assert.equal((await dmarcOf(sub, comDns)).dmarc.result, 'pass', 'relaxed: a subdomain signature aligns');
    assert.equal((await dmarcOf(sub, { ...comDns, '_dmarc.example.com': 'v=DMARC1; p=reject; adkim=s' })).dmarc.result, 'fail', 'strict: it does not');
    assert.equal((await dmarcOf(await rsaSigned(MSG, 'mail.sender.example'))).dmarc.result, 'fail', 'unknown suffix: no relaxed match');

    const unsigned = await composed(MSG);
    assert.equal((await dmarcOf(unsigned, {}, { spfResult: 'pass', envelopeFrom: 'bounce@sender.example' })).dmarc.result, 'pass', 'aligned SPF');
    assert.equal((await dmarcOf(unsigned, {}, { spfResult: 'softfail', envelopeFrom: 'bounce@sender.example' })).dmarc.result, 'fail', 'SPF must PASS');

    const q = await dmarcOf(unsigned, { '_dmarc.sender.example': 'v=DMARC1; p=quarantine' });
    assert.deepEqual([q.dmarc.result, q.dmarc.disposition], ['fail', 'quarantine']);
    const none = await dmarcOf(unsigned, { '_dmarc.sender.example': 'v=DMARC1; p=none' });
    assert.deepEqual([none.dmarc.result, none.dmarc.disposition], ['fail', 'none'], 'p=none only reports');

    const sampled = await dmarcOf(unsigned, { '_dmarc.sender.example': 'v=DMARC1; p=reject; pct=10' }, {}, () => 0.5);
    assert.equal(sampled.dmarc.disposition, 'quarantine', 'outside pct, reject becomes quarantine');

    const fromSub = await composed({ ...MSG, from: 'news@lists.sender.example' });
    const sp = await dmarcOf(fromSub, { '_dmarc.sender.example': 'v=DMARC1; p=reject; sp=quarantine' });
    assert.deepEqual([sp.dmarc.policy, sp.dmarc.disposition], ['quarantine', 'quarantine'], 'sp= governs subdomains found at the org record');

    const noRecord = await dmarcOf(await composed({ ...MSG, from: 'x@norecord.example' }));
    assert.equal(noRecord.dmarc.result, 'none');
    const temp = await dmarcOf(unsigned, { '_dmarc.sender.example': new Error('queryTxt ESERVFAIL') });
    assert.deepEqual([temp.dmarc.result, temp.dmarc.disposition], ['temperror', 'none'], 'a lookup failure never rejects');

    assert.equal(MailAuth.organizationalDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.equal(MailAuth.organizationalDomain('mail.sender.example'), 'sender.example');
});

// ================================================================================================
// The plugin

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
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`, { filename: PLUGIN_SRC });
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

const BOB = { id: 3, role: 'author', userEmail: `bob@${DOMAIN}`, userLogin: 'bob', displayName: 'Bob', hasProfessionalMailbox: true };
const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', hasProfessionalMailbox: true };
const USERS = [BOSS, BOB];

async function boot(extraOptions: Record<string, string> = {}, dnsRecords: Txt = BASE_DNS) {
    const db = makeDb();
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
        http: { route() { } },
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
    await plugin.init(bridge);
    return { plugin, db, smtp: smtpInstances[0] };
}

const EXTERNAL = (mailFrom: string, spfHeader?: string) =>
    ({ remoteAddress: '203.0.113.9', ...(spfHeader ? { spfHeader } : {}), envelope: { mailFrom: { address: mailFrom }, rcptTo: [{ address: BOB.userEmail }] } });

function deliver(b: any, raw: Buffer, session: any): Promise<any> {
    // Both shapes the plugin receives: a Buffer from the host listener, a stream from its own.
    const input = session.asStream ? Readable.from([raw]) : raw;
    return new Promise((resolve) => b.smtp.options.onData(input, session, (err: any) => resolve(err || null)));
}
const bobRows = (b: any) => b.db.all(`SELECT * FROM ${PREFIX}received_emails WHERE user_id = ? ORDER BY id`, [BOB.id]);

test('onData: p=reject refuses, p=quarantine files in Spam, a valid signature is delivered — and the verdict is stored', async () => {
    const b = await boot();
    try {
        const forged = await deliver(b, await composed({ ...MSG, to: BOB.userEmail, subject: 'Forged' }), EXTERNAL('x@elsewhere.example'));
        assert.equal(forged && forged.responseCode, 550, 'an unauthenticated message from a p=reject domain is refused');
        assert.match(String(forged.message), /DMARC/);
        const wrongD = await deliver(b, await rsaSigned({ ...MSG, to: BOB.userEmail, subject: 'Wrong d' }, 'other.example', 's1', rsaOther.privateKey), EXTERNAL('x@other.example'));
        assert.equal(wrongD && wrongD.responseCode, 550, 'a signature of another domain does not satisfy it');
        assert.equal((await bobRows(b)).length, 0, 'nothing was stored');

        assert.equal(await deliver(b, await rsaSigned({ ...MSG, to: BOB.userEmail, subject: 'Genuine' }), { ...EXTERNAL('bounce@elsewhere.example'), asStream: true }), null);
        const [genuine] = await bobRows(b);
        assert.equal(genuine.subject, 'Genuine');
        assert.equal(genuine.is_spam, 0);
        assert.match(genuine.auth_results, /dkim=pass header\.d=sender\.example/);
        assert.match(genuine.auth_results, /dmarc=pass/);
    } finally { b.plugin.deactivate(); }

    const q = await boot({}, { ...BASE_DNS, '_dmarc.sender.example': 'v=DMARC1; p=quarantine' });
    try {
        assert.equal(await deliver(q, await composed({ ...MSG, to: BOB.userEmail, subject: 'Suspicious' }), EXTERNAL('x@elsewhere.example')), null);
        const [row] = await bobRows(q);
        assert.equal(row.is_spam, 1, 'quarantined into Spam');
        assert.match(row.auth_results, /dmarc=fail \(p=quarantine dis=quarantine\)/);
    } finally { q.plugin.deactivate(); }
});

test('onData: the operator switch turns DMARC enforcement off; our own relay path is never evaluated', async () => {
    const off = await boot({ mail_security_dmarc_enabled: '0' });
    try {
        assert.equal(await deliver(off, await composed({ ...MSG, to: BOB.userEmail, subject: 'Unchecked' }), EXTERNAL('x@elsewhere.example')), null);
        const [row] = await bobRows(off);
        assert.equal(row.auth_results, '', 'no verdict when the check is off');
    } finally { off.plugin.deactivate(); }

    const b = await boot();
    try {
        const loop = { remoteAddress: '127.0.0.1', envelope: { mailFrom: { address: 'x@elsewhere.example' }, rcptTo: [{ address: BOB.userEmail }] } };
        assert.equal(await deliver(b, await composed({ ...MSG, to: BOB.userEmail, subject: 'Local relay' }), loop), null);
        assert.equal((await bobRows(b))[0].auth_results, '');
    } finally { b.plugin.deactivate(); }
});

test('onData: a DKIM signature of OUR domain authenticates a From on it; without one it is still refused', async () => {
    const dnsRecords: Txt = { ...BASE_DNS, [`s1._domainkey.${DOMAIN}`]: `v=DKIM1; k=rsa; p=${RSA_PUB}` };
    const b = await boot({}, dnsRecords);
    try {
        const ours = { from: `Boss <${BOSS.userEmail}>`, to: BOB.userEmail, subject: 'From the boss' };
        const signed = await rsaSigned(ours, DOMAIN);
        assert.equal(await deliver(b, signed, EXTERNAL('bounce@relay.example')), null, 'signed by acme.example → accepted');
        const unsigned = await deliver(b, await composed({ ...ours, subject: 'Not signed' }), EXTERNAL('bounce@relay.example'));
        assert.equal(unsigned && unsigned.responseCode, 550, 'the same claim without a signature is refused');
        const tampered = await deliver(b, tamper(signed, 'Hello there.', 'Wire the money.'), EXTERNAL('bounce@relay.example'));
        assert.equal(tampered && tampered.responseCode, 550, 'a broken signature authenticates nothing');
        assert.deepEqual((await bobRows(b)).map((r: any) => r.subject), ['From the boss']);
    } finally { b.plugin.deactivate(); }
});

// ================================================================================================
// The webmail reads the stored verdict

function loadAuthVerdict(): (h: string) => any {
    const start = WEBMAIL_SRC.indexOf('const authVerdict');
    const end = WEBMAIL_SRC.indexOf('\n};\n', start) + 4;
    assert.ok(start > 0 && end > start, 'authVerdict was not found in Webmail.tsx');
    const js = WEBMAIL_SRC.slice(start, end).replace('(header?: string)', '(header)');
    return vm.runInNewContext(`${js}\nauthVerdict`);
}

test('webmail: the reading pane parses the stored Authentication-Results into its badges', async () => {
    const authVerdict = loadAuthVerdict();
    const pass = authVerdict((await dmarcOf(await rsaSigned(MSG))).header);
    assert.equal(pass.dmarc.result, 'pass');
    assert.equal(pass.dkimPass.domain, 'sender.example');

    const bad = authVerdict((await dmarcOf(tamper(await rsaSigned(MSG), 'Hello there.', 'Hi.'), { '_dmarc.sender.example': 'v=DMARC1; p=quarantine' })).header);
    assert.deepEqual([bad.dmarc.result, bad.dmarc.disposition, bad.dmarc.policy], ['fail', 'quarantine', 'quarantine']);
    assert.equal(bad.dkimBad.domain, 'sender.example');
    assert.equal(authVerdict(''), null, 'no verdict, no badges');
    assert.match(WEBMAIL_SRC, /authVerdict\(email\.auth_results\)/, 'the reading pane reads the stored column');
});
