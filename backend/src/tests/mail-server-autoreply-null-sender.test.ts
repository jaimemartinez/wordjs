/**
 * mail-server auto-reply null return path suite (RFC 3834 §3.3).
 *
 * WHY THIS FILE EXISTS: the vacation responder used to send its reply with the vacationing user's
 * address as the SMTP envelope sender. When the original sender had no mailbox, the remote MTA
 * bounced the auto-reply back to that envelope sender — straight into the user's inbox as
 * "Undelivered Mail Returned to Sender". RFC 3834 §3.3 says automatic responses go out with a NULL
 * return path (MAIL FROM:<>), so an undeliverable one is dropped instead of bounced.
 *
 * Like mail-server-mx-tls-fallback.test.ts, the suite LOADS THE REAL PLUGIN MODULE and drives its
 * REAL outbound functions with the REAL nodemailer against a local smtp-server, so what is asserted
 * is the MAIL FROM nodemailer actually puts on the wire — on BOTH outbound paths:
 *   - direct-to-MX (deliverDirect), with the DNS bridge and the SSRF pin pointed at the local server;
 *   - relay/smarthost (deliverViaRelay), with a plain nodemailer transport to the local server.
 * Normal mail must keep the wire From as envelope sender on both paths. Finally the store must keep
 * the auto-reply marker on the Sent row, and the retry queue must hand it back to sendMail, so a
 * queued auto-reply is retried with the null sender too.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { makeDb } from './fixtures/mail-server-db';

const realNodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const PLUGIN_TEXT = fs.readFileSync(PLUGIN_SRC, 'utf8');
const createEmailStore = require(path.join(PLUGIN_DIR, 'lib/email-store.js'));

const MX_HOST = 'mx.example.test';
const USER = 'alice@site.example';
const RECIPIENT = 'nobody@dest.example';

// --- Local SMTP endpoint ------------------------------------------------------------------------

type Received = { mailFrom: string; rcptTo: string[]; body: string };

const closers: (() => Promise<void>)[] = [];
after(async () => { await Promise.all(closers.map((c) => c())); });

async function smtpSink() {
    const received: Received[] = [];
    const server = new SMTPServer({
        authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false, closeTimeout: 500,
        onData(stream: any, session: any, cb: (err?: Error) => void) {
            let body = '';
            stream.on('data', (d: Buffer) => { body += d.toString(); });
            stream.on('end', () => {
                received.push({
                    // smtp-server reports MAIL FROM:<> as an address of '' (and `false` on some lines).
                    mailFrom: session.envelope.mailFrom ? String(session.envelope.mailFrom.address || '') : '',
                    rcptTo: session.envelope.rcptTo.map((r: any) => r.address),
                    body,
                });
                cb();
            });
        },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { port: server.server.address().port as number, received };
}

// --- The real plugin module ---------------------------------------------------------------------

let targetPort = 0;
const nodemailerSeam = {
    ...realNodemailer,
    // deliverDirect dials port 25 on the pinned IP; send it to the local sink instead.
    createTransport(opts: any) { return realNodemailer.createTransport({ ...opts, port: targetPort }); },
};

// Appended to the shipped source so it closes over the module's own bindings; nothing is altered.
const SUITE_HOOK = `
;module.exports.__nullSenderSuite = {
    deliverDirect,
    deliverViaRelay,
    envelopeSenderOf,
    install(mxHost, pinnedIp) {
        wordjs = { dns: { resolveMx: async () => [{ exchange: mxHost, priority: 10 }] } };
        assertPublicHost = async () => [pinnedIp];
    },
};`;

const plugin: {
    deliverDirect: (...args: any[]) => Promise<any>;
    deliverViaRelay: (...args: any[]) => Promise<any>;
    envelopeSenderOf: (data: any, wireFrom: string) => string;
    install: (mxHost: string, pinnedIp: string) => void;
} = (() => {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'nodemailer') return nodemailerSeam;
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    const wrapper: any = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {${PLUGIN_TEXT}\n${SUITE_HOOK}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    const hooks = moduleObj.exports.__nullSenderSuite;
    hooks.install(MX_HOST, '127.0.0.1');
    return hooks;
})();

/** The mail object sendMail builds for its outbound paths (see `mailObj` in sendMail). */
function mailFor(data: { isAutoReply?: boolean; isForward?: boolean }) {
    return {
        fromEmail: USER,
        envelopeFrom: plugin.envelopeSenderOf(data, USER),
        fromName: 'Alice',
        subject: data.isAutoReply ? 'Away: Hello' : 'Hello',
        text: 'Body',
        headers: data.isAutoReply ? { 'Auto-Submitted': 'auto-replied' } : undefined,
    };
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const real = { log: console.log, warn: console.warn };
    console.log = () => {}; console.warn = () => {};
    return fn().finally(() => { console.log = real.log; console.warn = real.warn; });
}

// --- Envelope sender decision -------------------------------------------------------------------

test('envelopeSenderOf: auto-replies get the null return path; normal mail and forwards keep the wire From', () => {
    assert.strictEqual(plugin.envelopeSenderOf({ isAutoReply: true }, USER), '');
    assert.strictEqual(plugin.envelopeSenderOf({}, USER), USER);
    // A forward keeps the forwarding address as envelope sender (SPF alignment for the forwarder).
    assert.strictEqual(plugin.envelopeSenderOf({ isForward: true }, USER), USER);
});

// --- Direct-to-MX path --------------------------------------------------------------------------

test('direct-to-MX: an auto-reply is sent with MAIL FROM:<> and keeps its header From + Auto-Submitted', async () => {
    const sink = await smtpSink();
    targetPort = sink.port;
    await quiet(() => plugin.deliverDirect(RECIPIENT, mailFor({ isAutoReply: true }), undefined, 'mail.site.example'));
    assert.strictEqual(sink.received.length, 1);
    const [msg] = sink.received;
    assert.strictEqual(msg.mailFrom, '', 'envelope sender is the null return path');
    assert.deepStrictEqual(msg.rcptTo, [RECIPIENT]);
    assert.match(msg.body, /^From: "?Alice"? <alice@site\.example>\r?$/m, 'header From is still the user');
    assert.match(msg.body, /^Auto-Submitted: auto-replied\r?$/m);
});

test('direct-to-MX: a normal message keeps the user as envelope sender', async () => {
    const sink = await smtpSink();
    targetPort = sink.port;
    await quiet(() => plugin.deliverDirect(RECIPIENT, mailFor({}), undefined, 'mail.site.example'));
    assert.strictEqual(sink.received.length, 1);
    assert.strictEqual(sink.received[0].mailFrom, USER);
    assert.doesNotMatch(sink.received[0].body, /^Auto-Submitted:/m);
});

// --- Relay / smarthost path ---------------------------------------------------------------------

function relayTo(port: number) {
    return realNodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, connectionTimeout: 5000 });
}

test('relay: an auto-reply is sent with MAIL FROM:<> and keeps its header From + Auto-Submitted', async () => {
    const sink = await smtpSink();
    const relay = relayTo(sink.port);
    try {
        await plugin.deliverViaRelay(relay, RECIPIENT, mailFor({ isAutoReply: true }), undefined);
    } finally { relay.close(); }
    assert.strictEqual(sink.received.length, 1);
    const [msg] = sink.received;
    assert.strictEqual(msg.mailFrom, '', 'envelope sender is the null return path');
    assert.deepStrictEqual(msg.rcptTo, [RECIPIENT]);
    assert.match(msg.body, /^From: "?Alice"? <alice@site\.example>\r?$/m);
    assert.match(msg.body, /^Auto-Submitted: auto-replied\r?$/m);
});

test('relay: a normal message keeps the user as envelope sender', async () => {
    const sink = await smtpSink();
    const relay = relayTo(sink.port);
    try {
        await plugin.deliverViaRelay(relay, RECIPIENT, mailFor({}), undefined);
    } finally { relay.close(); }
    assert.strictEqual(sink.received.length, 1);
    assert.strictEqual(sink.received[0].mailFrom, USER);
});

// --- Retry queue --------------------------------------------------------------------------------

test('retry queue: the Sent row remembers an auto-reply and every retry caller hands it back to sendMail', async () => {
    const db = makeDb();
    const Email = createEmailStore(db);
    await Email.initSchema();
    const base = { fromAddress: USER, fromName: 'Alice', toAddress: RECIPIENT, subject: 's', bodyText: 'b', isSent: 1, userId: 1 };
    const auto = await Email.create({ ...base, messageId: '<a@t>', isAutoReply: 1 });
    const normal = await Email.create({ ...base, messageId: '<n@t>' });
    const past = new Date(Date.now() - 60000).toISOString();
    await Email.markRetry(auto.id, 1, past, 'temporary');
    await Email.markRetry(normal.id, 1, past, 'temporary');
    const pending = await Email.getPendingRetries();
    const byId = new Map(pending.map((r: any) => [r.id, r]));
    assert.strictEqual(Number((byId.get(auto.id) as any).is_auto_reply), 1);
    assert.strictEqual(Number((byId.get(normal.id) as any).is_auto_reply), 0);

    // sendMail must persist the flag, and every re-send of an existing Sent row (isRetry: true —
    // the scheduled queue AND the manual "retry now") must pass it back, or a retried auto-reply
    // would leave with the user's address as envelope sender again.
    assert.match(PLUGIN_TEXT, /isAutoReply: data\.isAutoReply \? 1 : 0,/, 'sendMail stores the auto-reply marker');
    const retryCalls = PLUGIN_TEXT.split('await sendMail({').slice(1)
        .map((rest) => rest.slice(0, rest.indexOf('});')))
        .filter((call) => /isRetry: true/.test(call));
    assert.ok(retryCalls.length >= 2, `expected the scheduled and manual retry callers, found ${retryCalls.length}`);
    for (const call of retryCalls) {
        assert.match(call, /isAutoReply: Number\(email\.is_auto_reply\) === 1/, `retry caller drops the auto-reply flag:\n${call}`);
    }
});
