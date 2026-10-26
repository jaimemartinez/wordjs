/**
 * mail-server 3.2.3 — the general queue's sending rate ("Messages per minute", the queue screen).
 *
 * A cap on every message handed to the outside world: user mail, scheduled sends, retries, the site's and
 * other plugins' mail. Over the cap a message is held in the queue and goes out in a later minute, in
 * order; nothing is refused or lost, and new mail waits behind what is already waiting. Account mail the
 * core marks (`priority: 'account'`) goes out at once and still counts. 0 = no cap.
 *
 * Driven through the REAL plugin module: a stub relay records what leaves; the queue timer is captured
 * and run by hand; a new minute is simulated by clearing the plugin's own rate table.
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
const { createSendRate, parsePerMinute } = require(path.join(PLUGIN_DIR, 'lib/send-rate.js'));

const DOMAIN = 'acme.example';
const BOSS = { id: 1, role: 'administrator', userEmail: `boss@${DOMAIN}`, userLogin: 'boss', displayName: 'Boss', accountCapabilities: ['mail_server_mailbox'] };

class FakeSMTPServer {
    constructor(public options: any) { }
    on() { return this; }
    listen(_port: number, cb?: () => void) { if (cb) setImmediate(cb); return this; }
    close(cb?: () => void) { if (cb) setImmediate(cb); }
}

type Boot = { provider: (msg: any) => Promise<any>; sent: any[]; db: any; options: Record<string, string>; routes: Map<string, any>; tick: () => Promise<void>; plugin: any };

async function boot(extra: Record<string, string> = {}): Promise<Boot> {
    const sent: any[] = [];
    const nodemailer = {
        createTransport() {
            return {
                async verify() { return true; },
                async sendMail(m: any) { sent.push(m); return { response: '250 2.0.0 Ok: queued' }; },
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
    // A relay answers, so every external message is "handed out" through the stub above.
    const options: Record<string, string> = { smtp_listen_port: '2525', mail_undo_send_seconds: '0', mail_server: 'relay.lan', mail_port: '587', ...extra };
    const routes = new Map<string, any>();
    let provider: any = null;
    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; },
        },
        site: { async url() { return `https://${DOMAIN}`; }, async domain() { return DOMAIN; }, async adminEmail() { return BOSS.userEmail; } },
        users: {
            async findByEmail(e: string) { return e === BOSS.userEmail ? BOSS : null; },
            async findByLogin() { return null; },
            async findById(id: number) { return id === BOSS.id ? BOSS : null; },
            async search() { return []; },
        },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { } },
        provideMail(fn: any) { provider = fn; },
        notify: Object.assign(async () => { }, { registerTransport() { } }),
        dns: { resolveMx: async () => [], resolveTxt: async () => [], resolve4: async () => [], resolve6: async () => [], resolve: async () => [] },
    };
    let queueTick: any = null;
    const realSetInterval = global.setInterval;
    (global as any).setInterval = (fn: any, ms: number) => { if (!queueTick && ms === 15 * 1000) queueTick = fn; return realSetInterval(() => { }, 1 << 30); };
    try { await plugin.init(bridge); } finally { (global as any).setInterval = realSetInterval; }
    assert.ok(provider, 'the plugin registers itself as the mail provider');
    assert.ok(queueTick, 'the plugin registers its queue timer at init');
    return { provider, sent, db, options, routes, tick: () => queueTick(), plugin };
}

async function call(b: Boot, key: string, body: any = {}) {
    const handler = b.routes.get(key);
    assert.ok(handler, `route '${key}' is not registered`);
    const out: any = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(x: any) { out.body = x; return res; }, send(x: any) { out.body = x; return res; }, end() { return res; },
    };
    await handler({ query: {}, params: {}, body, cookies: {}, headers: {}, user: BOSS }, res);
    return out;
}

const siteMail = (n: number, extra: any = {}) => ({ to: `reader${n}@example.org`, subject: `m${n}`, text: `message ${n}`, ...extra });
const subjects = (b: Boot) => b.sent.map((m) => m.subject);
/** A new minute: the plugin's own count of this minute is gone, and held mail is due. */
async function nextMinute(b: Boot) {
    await b.db.run(`DELETE FROM ${PREFIX}send_rate`);
    await b.db.run(`UPDATE ${PREFIX}received_emails SET next_attempt_at = ? WHERE paced = 1`, [new Date(Date.now() - 1000).toISOString()]);
}
const pacedRows = (b: Boot) => b.db.all(`SELECT id, subject, to_address, delivery_status, delivery_attempts FROM ${PREFIX}received_emails WHERE paced = 1 ORDER BY id`);

describe('the per-minute counter (lib/send-rate)', () => {
    test('N per minute, then refused until the next minute; force always passes and counts', async () => {
        const db = makeDb();
        await db.createTable(`${PREFIX}send_rate`, ['id INT_PK', 'window_start INT DEFAULT 0', 'used INT DEFAULT 0']);
        let limit = 2;
        const rate = createSendRate(db, `${PREFIX}send_rate`, async () => limit);
        const t0 = Date.UTC(2026, 9, 23, 10, 0, 5);
        assert.strictEqual((await rate.claim({ now: t0 })).ok, true);
        assert.strictEqual((await rate.claim({ now: t0 + 1000 })).ok, true);
        const third = await rate.claim({ now: t0 + 2000 });
        assert.strictEqual(third.ok, false);
        assert.strictEqual(third.retryAt, Date.UTC(2026, 9, 23, 10, 1, 0), 'held until the next minute starts');
        assert.strictEqual((await rate.claim({ now: t0 + 3000, force: true })).ok, true, 'account mail passes');
        assert.deepStrictEqual(await rate.status({ now: t0 }), { perMinute: 2, sentThisMinute: 3, sentLastMinute: 0 });
        assert.strictEqual((await rate.claim({ now: t0 + 60_000 })).ok, true, 'a new minute has room again');
        limit = 0;
        for (let i = 0; i < 5; i++) assert.strictEqual((await rate.claim({ now: t0 + 61_000 })).ok, true, '0 = no cap');
        assert.strictEqual((await rate.status({ now: t0 + 61_000 })).sentThisMinute, 1, 'with no cap nothing is counted');
    });

    test('the stored setting reads as a whole, non-negative number (0 = no cap)', () => {
        assert.strictEqual(parsePerMinute('30'), 30);
        assert.strictEqual(parsePerMinute(''), 0);
        assert.strictEqual(parsePerMinute('-5'), 0);
        assert.strictEqual(parsePerMinute('abc'), 0);
        assert.strictEqual(parsePerMinute('9999999'), 100000);
    });
});

describe('the general queue respects the per-minute cap', () => {
    test('0 (the default) is no cap: everything goes out at once', async () => {
        const b = await boot();
        try {
            for (let i = 1; i <= 5; i++) {
                const r = await b.provider(siteMail(i));
                assert.strictEqual(r.success, true);
                assert.ok(!r.queued);
            }
            assert.deepStrictEqual(subjects(b), ['m1', 'm2', 'm3', 'm4', 'm5']);
            assert.strictEqual((await pacedRows(b)).length, 0);
        } finally { b.plugin.deactivate(); }
    });

    test('over the cap, mail waits and goes out in later minutes, in order — none lost, no error to the sender', async () => {
        const b = await boot({ mail_queue_per_minute: '2' });
        try {
            const results = [];
            for (let i = 1; i <= 5; i++) results.push(await b.provider(siteMail(i)));
            assert.deepStrictEqual(subjects(b), ['m1', 'm2'], 'two this minute');
            assert.ok(results.every((r) => r.success === true), 'the sender is never told it failed');
            assert.deepStrictEqual(results.map((r) => !!r.queued), [false, false, true, true, true]);
            const waiting = await pacedRows(b);
            assert.deepStrictEqual(waiting.map((r: any) => r.subject), ['m3', 'm4', 'm5']);
            assert.ok(waiting.every((r: any) => r.delivery_status === 'retry' && Number(r.delivery_attempts) === 0),
                'waiting is not a failed delivery attempt');

            // The queue in this same minute: still full, nothing more leaves.
            await b.tick();
            assert.deepStrictEqual(subjects(b), ['m1', 'm2']);

            await nextMinute(b);
            await b.tick();
            assert.deepStrictEqual(subjects(b), ['m1', 'm2', 'm3', 'm4'], 'the next two, oldest first');

            await nextMinute(b);
            await b.tick();
            assert.deepStrictEqual(subjects(b), ['m1', 'm2', 'm3', 'm4', 'm5'], 'nothing is lost');
            assert.strictEqual((await pacedRows(b)).length, 0);
            const states = await b.db.all(`SELECT delivery_status FROM ${PREFIX}received_emails WHERE subject LIKE 'm%'`);
            assert.ok(states.every((r: any) => r.delivery_status === 'sent'));
        } finally { b.plugin.deactivate(); }
    });

    test('new mail queues behind what is waiting, even when a new minute has room', async () => {
        const b = await boot({ mail_queue_per_minute: '1' });
        try {
            await b.provider(siteMail(1));
            await b.provider(siteMail(2));
            assert.deepStrictEqual(subjects(b), ['m1']);
            await b.db.run(`DELETE FROM ${PREFIX}send_rate`); // a new minute, before the queue has run
            const r = await b.provider(siteMail(3));
            assert.strictEqual(r.queued, true, 'm3 does not overtake m2');
            assert.deepStrictEqual(subjects(b), ['m1']);
            await nextMinute(b);
            await b.tick();
            assert.deepStrictEqual(subjects(b), ['m1', 'm2']);
            await nextMinute(b);
            await b.tick();
            assert.deepStrictEqual(subjects(b), ['m1', 'm2', 'm3']);
        } finally { b.plugin.deactivate(); }
    });

    test('account mail (password reset, verification) goes out at once at the cap, and still counts', async () => {
        const b = await boot({ mail_queue_per_minute: '1' });
        try {
            await b.provider(siteMail(1));
            await b.provider(siteMail(2)); // waits
            const reset = await b.provider(siteMail(9, { subject: 'reset', priority: 'account' }));
            assert.strictEqual(reset.success, true);
            assert.ok(!reset.queued, 'not held');
            assert.deepStrictEqual(subjects(b), ['m1', 'reset']);
            const used = await b.db.get(`SELECT MAX(used) AS n FROM ${PREFIX}send_rate`);
            assert.strictEqual(Number(used.n), 2, 'it counted against this minute');
        } finally { b.plugin.deactivate(); }
    });

    test('the setting is saved from the panel and shown on the queue screen with the waiting count and time to empty', async () => {
        const b = await boot();
        try {
            let s = await call(b, 'post /settings', { mail_queue_per_minute: '2' });
            assert.strictEqual(s.status, 200, JSON.stringify(s.body));
            assert.strictEqual(b.options.mail_server_mail_queue_per_minute, '2');
            assert.strictEqual((await call(b, 'get /settings')).body.mail_queue_per_minute, '2');
            s = await call(b, 'post /settings', { mail_queue_per_minute: '-4' });
            assert.strictEqual(b.options.mail_server_mail_queue_per_minute, '0', 'an invalid value is stored as no cap');
            await call(b, 'post /settings', { mail_queue_per_minute: '2' });

            for (let i = 1; i <= 7; i++) await b.provider(siteMail(i));
            const q = (await call(b, 'get /admin/queue')).body;
            assert.strictEqual(q.pacing.perMinute, 2);
            assert.strictEqual(q.pacing.sentThisMinute, 2);
            assert.strictEqual(q.pacing.waiting, 5);
            assert.strictEqual(q.pacing.etaMinutes, 3, '5 waiting at 2 per minute');
            const waitingItem = q.items.find((it: any) => it.subject === 'm3');
            assert.strictEqual(Number(waitingItem.paced), 1, 'the screen can tell waiting from retrying');

            // A failed attempt whose retry is already due is waiting for a slot too.
            await b.db.run(`UPDATE ${PREFIX}received_emails SET delivery_status = 'retry', paced = 0, next_attempt_at = ?
                WHERE subject = 'm1'`, [new Date(Date.now() - 1000).toISOString()]);
            const q2 = (await call(b, 'get /admin/queue')).body;
            assert.strictEqual(q2.pacing.waiting, 6);
            assert.strictEqual(q2.pacing.etaMinutes, 3, '6 waiting at 2 per minute');
        } finally { b.plugin.deactivate(); }
    });

    test("an administrator's Retry now goes out at once, even at the cap", async () => {
        const b = await boot({ mail_queue_per_minute: '1' });
        try {
            await b.provider(siteMail(1));
            await b.provider(siteMail(2));
            const [held] = await pacedRows(b);
            const handler = b.routes.get('post /admin/queue/:id/retry');
            const out: any = {};
            const res: any = { status(s: number) { out.status = s; return res; }, json(x: any) { out.body = x; return res; } };
            await handler({ query: {}, params: { id: String(held.id) }, body: {}, headers: {}, user: BOSS }, res);
            assert.strictEqual(out.status, 200, JSON.stringify(out.body));
            assert.deepStrictEqual(subjects(b), ['m1', 'm2']);
        } finally { b.plugin.deactivate(); }
    });
});

describe('the core marks only its own account mail', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '../core/plugin-api.ts'), 'utf8');
    const ACCOUNT = fs.readFileSync(path.join(__dirname, '../core/account-mail.ts'), 'utf8');
    test('account mail is handed to the provider with priority: account', () => {
        assert.match(ACCOUNT, /send\(withAccountPriority\(msg\)\)/);
        assert.match(ACCOUNT, /return \{ \.\.\.msg, priority: 'account' \};/);
    });
    test("a plugin's wordjs.mail() cannot set it", () => {
        assert.match(SRC, /const \{ priority: _dropped, \.\.\.rest \} = msg;\s*return send\(rest\);/);
    });
});
