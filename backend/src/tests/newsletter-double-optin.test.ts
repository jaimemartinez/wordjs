/**
 * newsletter 1.0.3 — the double opt-in mail must actually go out, and the visitor must be told the truth.
 *
 * Three findings of the three-mode lab pass, reproduced through the REAL plugin over in-memory SQLite:
 *  · the plugin built the confirmation link with wordjs.site.url(), which needs `settings:read`, and the
 *    manifest did not declare it — the host refused, no mail was ever sent, every subscriber stayed
 *    pending. The bridge below enforces the manifest exactly as the host does.
 *  · the subscribe block then showed "¡Suscripción confirmada!" (it fell through to that branch for any
 *    reply without `needsConfirm`), and the reply said "check your inbox" even when nothing was sent.
 *  · confirming used SQLite's datetime('now'), which PostgreSQL and MySQL do not have.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const Database = require('better-sqlite3');
const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/newsletter');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
const DECLARED = new Set((MANIFEST.permissions || []).map((p: any) => `${p.scope}:${p.access}`));
const SITE = 'https://news.example';

function makeDb() {
    const raw = new Database(':memory:');
    return {
        tablePrefix: 'wjp_newsletter_',
        async run(sql: string, params: any[] = []) {
            // Engines other than SQLite have no datetime(): a plugin statement that uses it breaks there.
            assert.ok(!/datetime\s*\(/i.test(sql), `SQLite-only datetime() in plugin SQL: ${sql}`);
            const info = raw.prepare(sql).run(...params);
            return { lastID: Number(info.lastInsertRowid), changes: info.changes };
        },
        async get(sql: string, params: any[] = []) { return raw.prepare(sql).get(...params); },
        async all(sql: string, params: any[] = []) { return raw.prepare(sql).all(...params); },
    };
}

async function boot(opts: { mailFails?: boolean } = {}) {
    const routes = new Map<string, any>();
    const sent: any[] = [];
    const needs = (perm: string) => {
        if (!DECLARED.has(perm)) throw new Error(`🛡️ Security Block: Plugin 'newsletter' tried to access '${perm}' without permission. Declare it in manifest.json first.`);
    };
    const wordjs: any = {
        db: makeDb(),
        http: { route(method: string, sub: string, a: any, b?: any) { routes.set(`${method} ${sub}`, typeof a === 'function' ? a : b); } },
        adminMenu: { add() { } },
        crypto: { randomToken: async () => Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32) },
        site: { async url() { needs('settings:read'); return SITE; } },
        async mail(msg: any) {
            needs('email:admin');
            if (opts.mailFails) throw new Error('Mail server not available');
            sent.push(msg);
        },
    };
    const plugin = require(path.join(PLUGIN_DIR, 'index.js'));
    await plugin.init(wordjs);
    const call = async (key: string, req: any = {}) => {
        const out: { status: number; body: any } = { status: 200, body: undefined };
        const res: any = { status(s: number) { out.status = s; return res; }, json(x: any) { out.body = x; return res; } };
        await routes.get(key)({ query: {}, params: {}, body: {}, clientKey: 'c-' + Math.random(), ...req }, res);
        return out;
    };
    return { call, sent, db: wordjs.db };
}

test('the manifest declares settings:read, which the confirmation link needs', () => {
    assert.ok(DECLARED.has('settings:read'));
    assert.ok(DECLARED.has('email:admin'));
});

test('subscribe sends the confirmation, says "check your inbox", and confirming works on every engine', async () => {
    const b = await boot();
    const r = await b.call('post /public/subscribe', { body: { email: 'reader@example.org', page_url: `${SITE}/blog/news?x=1#top` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    assert.equal(r.body.needsConfirm, true, 'the block shows "check your email", never "confirmed"');
    assert.equal(b.sent.length, 1, 'the double opt-in mail went out');
    const link = /href="([^"]+)"/.exec(b.sent[0].html)![1];
    assert.ok(link.startsWith(`${SITE}/blog/news?nl=confirm&nl_token=`), `lands on the page the visitor used: ${link}`);

    const token = new URL(link).searchParams.get('nl_token');
    const c = await b.call('get /public/confirm', { query: { token } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const row: any = await b.db.get("SELECT status, confirmed_at FROM wjp_newsletter_subscribers WHERE email = 'reader@example.org'");
    assert.equal(row.status, 'confirmed');
    assert.match(String(row.confirmed_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('a page on another origin never becomes the link: the confirm route on the site is used', async () => {
    const b = await boot();
    await b.call('post /public/subscribe', { body: { email: 'x@example.org', page_url: 'https://evil.example/phish' } });
    assert.match(b.sent[0].text, new RegExp(`${SITE.replace(/[.]/g, '\\.')}/api/v1/plugin/newsletter/public/confirm\\?token=`));
});

test('when the confirmation cannot be sent the visitor is told so — the same way for every address', async () => {
    const b = await boot({ mailFails: true });
    const first = await b.call('post /public/subscribe', { body: { email: 'new@example.org' } });
    assert.equal(first.status, 503);
    assert.equal(first.body.success, false);
    assert.equal(first.body.code, 'newsletter_mail_unavailable');
    // An already-confirmed address gets the identical answer while mail is down (no enumeration).
    await b.db.run("INSERT INTO wjp_newsletter_subscribers (email, status, token) VALUES ('old@example.org', 'confirmed', 't')");
    const confirmed = await b.call('post /public/subscribe', { body: { email: 'old@example.org' } });
    assert.deepEqual({ s: confirmed.status, b: confirmed.body }, { s: first.status, b: first.body });
    const admin = await b.call('get /subscribers');
    assert.match(String(admin.body.confirmMailError && admin.body.confirmMailError.message), /not available/, 'the admin dashboard shows why');
});
