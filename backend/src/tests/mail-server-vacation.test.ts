/**
 * mail-server vacation auto-responder: anti-reflection regression suite.
 *
 * An auto-reply is mail the site's MTA originates to an address the inbound message merely CLAIMS.
 * Before the fix, any forged From that reached a vacationing mailbox got a reply — a reflector carrying
 * the site's SPF/DKIM reputation, bounded only by a per-sender 24 h dedupe (rotate the forged From and
 * the dedupe never triggers). The fix has two halves, both covered here against the SHIPPED code:
 *
 *  1. The inbound path (onData) only calls maybeVacationAutoReply when vacationSenderVerified() holds:
 *     SPF 'pass' for the envelope domain AND that domain is the header From domain. The verdict ->
 *     gate behaviour is exercised end to end in mail-server-spf.test.ts (real onMailFrom header fed
 *     into the real gate); this file pins that onData actually WIRES the gate in front of the call.
 *  2. maybeVacationAutoReply caps DISTINCT recipients per mailbox per window, so even authenticated
 *     senders cannot turn one mailbox into a bulk mailer.
 *
 * Like the SPF suite, the functions are sliced verbatim out of marketplace/plugins/mail-server/index.js
 * (./fixtures/plugin-source-slicer); only the I/O seams (prefs store, sendMail) are stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createSlicer } from './fixtures/plugin-source-slicer';

const PLUGIN_SRC = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js');
const TEXT = fs.readFileSync(PLUGIN_SRC, 'utf8');
const { sliceFn, sliceMethodBody } = createSlicer(PLUGIN_SRC, 'mail-server vacation suite');

function sliceConst(name: string): string {
    const m = new RegExp('^const ' + name + ' = [^;]+;', 'm').exec(TEXT);
    assert.ok(m, `mail-server vacation suite: const ${name} not found in ${PLUGIN_SRC}`);
    return m[0];
}

interface VacationModule {
    maybeVacationAutoReply(user: any, sender: string, subject: string): Promise<void>;
    sent: Array<{ to: string }>;
    VACATION_MAX_RECIPIENTS: number;
    VACATION_WINDOW_MS: number;
}

function loadVacation(): VacationModule {
    const src = [
        "'use strict';",
        sliceConst('VACATION_WINDOW_MS'),
        sliceConst('VACATION_MAX_RECIPIENTS'),
        sliceConst('_vacationSent'),
        sliceConst('_vacationQuota'),
        sliceFn(TEXT, '_vacationQuotaTake'),
        sliceFn(TEXT, 'maybeVacationAutoReply'),
        // I/O seams only.
        'const sent = [];',
        'const Email = { getPrefs: async () => ({ vacation: { enabled: true, subject: "Away", message: "<p>Out of office</p>" } }) };',
        'const stripHtml = (h) => String(h).replace(/<[^>]+>/g, "");',
        'const sendingIdentityOf = (u) => ({ address: u.userEmail });',
        'async function sendMail(msg) { sent.push(msg); }',
        'const console = { warn() {}, log() {}, error() {} };',
        'module.exports = { maybeVacationAutoReply, sent, VACATION_MAX_RECIPIENTS, VACATION_WINDOW_MS };',
    ].join('\n\n');
    const wrapper = vm.runInThisContext(`(function (module, exports, require) {\n${src}\n})`, { filename: 'mail-server-index.vacation-slice.js' });
    const mod = { exports: {} as any };
    wrapper(mod, mod.exports, require);
    return mod.exports as VacationModule;
}

test('vacation replies are capped per mailbox per window (distinct recipients)', async () => {
    const V = loadVacation();
    assert.ok(V.VACATION_MAX_RECIPIENTS > 0 && V.VACATION_MAX_RECIPIENTS <= 200, 'a sane, bounded cap');
    const user = { id: 7, userEmail: 'boss@site.test' };
    for (let i = 0; i < V.VACATION_MAX_RECIPIENTS + 25; i++) {
        await V.maybeVacationAutoReply(user, `sender${i}@ex.test`, 'hi');
    }
    assert.strictEqual(V.sent.length, V.VACATION_MAX_RECIPIENTS, 'replies stop at the per-mailbox cap');

    // The cap is per mailbox: another vacationing user is unaffected.
    await V.maybeVacationAutoReply({ id: 8, userEmail: 'other@site.test' }, 'sender0@ex.test', 'hi');
    assert.strictEqual(V.sent.length, V.VACATION_MAX_RECIPIENTS + 1);
});

test('the per-sender dedupe still holds and does not consume the quota', async () => {
    const V = loadVacation();
    const user = { id: 9, userEmail: 'boss@site.test' };
    for (let i = 0; i < 5; i++) await V.maybeVacationAutoReply(user, 'same@ex.test', 'hi');
    assert.strictEqual(V.sent.length, 1);
    for (let i = 0; i < V.VACATION_MAX_RECIPIENTS - 1; i++) await V.maybeVacationAutoReply(user, `n${i}@ex.test`, 'hi');
    assert.strictEqual(V.sent.length, V.VACATION_MAX_RECIPIENTS, 'repeat mail from one sender did not eat the budget');
});

test('onData only fires the inbound vacation reply behind the SPF sender gate', () => {
    const body = sliceMethodBody(TEXT, 'onData(stream, session, callback)');
    const callIdx = body.indexOf('maybeVacationAutoReply(');
    assert.ok(callIdx > 0, 'onData still sends vacation replies');
    assert.strictEqual(body.indexOf('maybeVacationAutoReply(', callIdx + 1), -1, 'exactly one inbound call site');
    // The guarding `if (...)` is the nearest one before the call; it must include the SPF gate fed with
    // this transaction's verdict, envelope sender and the header From the reply would go to.
    const guard = body.slice(body.lastIndexOf('if (', callIdx), callIdx);
    assert.match(
        guard,
        /vacationSenderVerified\(session\?\.spfHeader, session\?\.envelope\?\.mailFrom\?\.address, fromAddr\)/,
        'the inbound vacation reply must be gated on vacationSenderVerified'
    );
});
