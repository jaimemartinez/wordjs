/**
 * Newsletters of the bundled `memberships` plugin (marketplace/plugins/memberships/lib/newsletter.js),
 * and the core editor-field seam it uses (backend/src/core/editor-fields.ts).
 *
 * The REAL plugin runs in the marketplace harness: its SQL through the host SQL guard, its HMAC through the
 * host crypto bridge, `wordjs.mail` recorded (or made to fail). Posts and accounts are stubs of the
 * posts / users bridges. What is asserted:
 *  · tier filtering — `all` / `free` / `paid` reach exactly the members they name, never an account that
 *    unsubscribed or has no address;
 *  · the leak rule — a post that requires a level goes out in FULL only to members who hold it; everyone
 *    else gets the teaser and a link, the withheld text appears in no html or text part (test sends too);
 *  · unsubscribe — every mail carries a per-account one-click link; the token works for that account only,
 *    a forged or foreign token is refused, and an unsubscribed member is skipped by the next send;
 *  · the queue — nothing is sent from the publish hook itself, the per-minute rate is honoured, failures
 *    retry with backoff and then count as failed, and an admin retry delivers them;
 *  · who may send — an author's request waits for approval; one newsletter per post.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
import { bootPlugin, type BootedPlugin } from './fixtures/marketplace-plugin-harness';

const ADMIN = { id: 1, role: 'administrator' };
const SECRET = 'SECRET-PAID-PARAGRAPH-9f2c';

type Acct = { id: number; userLogin: string; userEmail: string; displayName: string; role: string };
const ACCOUNTS: Acct[] = [
    { id: 1, userLogin: 'admin', userEmail: 'admin@site.test', displayName: 'Admin', role: 'administrator' },
    { id: 2, userLogin: 'ana', userEmail: 'ana@example.com', displayName: 'Ana', role: 'subscriber' },
    { id: 3, userLogin: 'bea', userEmail: 'bea@example.com', displayName: 'Bea', role: 'subscriber' },
    { id: 4, userLogin: 'carla', userEmail: 'carla@example.com', displayName: 'Carla', role: 'subscriber' },   // paid (comped Gold)
    { id: 5, userLogin: 'dani', userEmail: 'dani@example.com', displayName: 'Dani', role: 'subscriber' },     // paid (comped Silver)
    { id: 6, userLogin: 'eva', userEmail: '', displayName: 'Eva', role: 'subscriber' },                     // no address
    { id: 7, userLogin: 'writer', userEmail: 'writer@example.com', displayName: 'Writer', role: 'author' },
];

const POSTS: Record<number, any> = {
    10: { id: 10, type: 'post', status: 'publish', title: 'Paid analysis', slug: 'paid-analysis', path: '/paid-analysis', url: 'http://site.test/paid-analysis',
        authorId: 1, excerpt: '', accessLevel: 'paid', meta: { newsletter_audience: 'all' },
        content: '<p>Free teaser with <img src="/uploads/a.png"> [gallery id="3"]</p><hr class="wjs-access-break" /><p>' + SECRET + ' only for paid</p>' },
    11: { id: 11, type: 'post', status: 'publish', title: 'Public news', slug: 'public-news', path: '/public-news', url: 'http://site.test/public-news',
        authorId: 1, excerpt: '', accessLevel: '', meta: { newsletter_audience: 'free' }, content: '<p>Everyone reads this</p>' },
    12: { id: 12, type: 'post', status: 'publish', title: 'Gold only, no break', slug: 'gold', path: '/gold', url: 'http://site.test/gold',
        authorId: 1, excerpt: 'The author wrote this summary', accessLevel: 'tier:gold', meta: { newsletter_audience: 'paid' },
        content: '<p>' + SECRET + ' whole body is gated</p>' },
    13: { id: 13, type: 'post', status: 'publish', title: 'By an author', slug: 'by-author', path: '/by-author', url: 'http://site.test/by-author',
        authorId: 7, excerpt: '', accessLevel: '', meta: { newsletter_audience: 'all' }, content: '<p>Author post</p>' },
};

let plugin: BootedPlugin;
let filters: Map<string, any>;
let actions: Map<string, any>;
let tiers: Record<string, any>;

const mailsTo = () => plugin.mails.map((m) => m.to).sort();
const mailFor = (to: string) => plugin.mails.find((m) => m.to === to)!;
const process = (body: any = {}) => plugin.call('post', '/newsletter/process', { user: ADMIN, body: { ignoreDelay: true, ...body } });
async function drain(max = 10) {
    for (let i = 0; i < max; i++) {
        const r = await process();
        if (!r.body.sent && !r.body.built && !r.body.triggered && !r.body.retried) break;
    }
}
const send = (postId: number, audience: string) => plugin.call('post', '/newsletter/send', { user: ADMIN, body: { post_id: postId, audience } });

beforeEach(async () => {
    filters = new Map();
    actions = new Map();
    plugin = await bootPlugin('memberships', {
        hooks: {
            addFilter: (h: string, cb: any) => { filters.set(h, cb); },
            addAction: (h: string, cb: any) => { actions.set(h, cb); },
        },
        posts: { get: async (id: any) => (POSTS[Number(id)] ? JSON.parse(JSON.stringify(POSTS[Number(id)])) : null) },
        users: {
            findById: async (id: any) => ACCOUNTS.find((a) => a.id === Number(id)) || null,
            findByEmail: async (e: any) => ACCOUNTS.find((a) => a.userEmail === e) || null,
            findByLogin: async (l: any) => ACCOUNTS.find((a) => a.userLogin === l) || null,
            search: async (_t: any, limit: any, offset: any) => ACCOUNTS.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 50)),
        },
    });
    tiers = {};
    for (const [name, cents] of [['Silver', 500], ['Gold', 1500]] as const) {
        tiers[name.toLowerCase()] = (await plugin.call('post', '/tiers', { user: ADMIN, body: { name, price_cents: cents } })).body.tier;
    }
    await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'carla', tier_id: tiers.gold.id } });
    await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'dani', tier_id: tiers.silver.id } });
    // Every account with an address has confirmed it (the confirmation flow has its own tests below).
    for (const a of ACCOUNTS) if (a.userEmail) confirm(a.id, a.userEmail);
    plugin.mails.length = 0;
});

/** Mark `email` confirmed for account `id`, as clicking the confirmation link does. */
function confirm(id: number, email: string | null) {
    plugin.sdb.prepare(`DELETE FROM ${plugin.prefix}nl_prefs WHERE user_id = ?`).run(id);
    if (email === null) return;
    try {
        plugin.sdb.prepare(`INSERT INTO ${plugin.prefix}nl_prefs (user_id, subscribed, confirmed_email) VALUES (?, 1, ?)`).run(id, email);
    } catch {
        // (A plugin version without address confirmation: nothing to mark.)
    }
}

afterEach(() => plugin.close());

describe('tier filtering', () => {
    test('all = every subscribed member with an address (free and paid)', async () => {
        assert.strictEqual((await send(11, 'all')).status, 200);
        await drain();
        assert.deepStrictEqual(mailsTo(), ['admin@site.test', 'ana@example.com', 'bea@example.com', 'carla@example.com', 'dani@example.com', 'writer@example.com']);
    });

    test('free = members without a paid level; paid = members with one', async () => {
        await send(11, 'free');
        await drain();
        assert.deepStrictEqual(mailsTo(), ['admin@site.test', 'ana@example.com', 'bea@example.com', 'writer@example.com']);
        plugin.mails.length = 0;
        await send(10, 'paid');
        await drain();
        assert.deepStrictEqual(mailsTo(), ['carla@example.com', 'dani@example.com']);
    });

    test('an unsubscribed member is skipped; with free sign-up off, plain accounts are not members', async () => {
        await plugin.call('post', '/me/newsletter', { user: { id: 2, role: 'subscriber' }, body: { subscribed: false } });
        await plugin.call('post', '/config', { user: ADMIN, body: { freeSignup: false } });
        await send(11, 'all');
        await drain();
        assert.deepStrictEqual(mailsTo(), ['carla@example.com', 'dani@example.com']);
    });
});

describe('the paid body never reaches a member without access', () => {
    test('teaser + link for free members, full body for paid ones — html and text parts', async () => {
        await send(10, 'all');
        await drain();
        for (const to of ['ana@example.com', 'bea@example.com', 'admin@site.test', 'writer@example.com']) {
            const m = mailFor(to);
            assert.ok(!m.html!.includes(SECRET) && !m.text!.includes(SECRET), `${to} received the paid paragraph`);
            assert.ok(m.html!.includes('Free teaser'), `${to}: the teaser is there`);
            assert.ok(m.html!.includes('http://site.test/paid-analysis'), `${to}: with a link to read it`);
            assert.ok(m.html!.includes('src="http://site.test/uploads/a.png"'), 'relative URLs are made absolute');
            assert.ok(!m.html!.includes('[gallery'), 'shortcodes are dropped');
        }
        for (const to of ['carla@example.com', 'dani@example.com']) {
            assert.ok(mailFor(to).html!.includes(SECRET), `${to} (paid) gets the full post`);
        }
    });

    test('a tier level: only that tier (or dearer) gets it in full; no break → the author\'s excerpt, never the body', async () => {
        await send(12, 'all');
        await drain();
        assert.ok(mailFor('carla@example.com').html!.includes(SECRET), 'Gold holds tier:gold');
        for (const to of ['dani@example.com', 'ana@example.com']) {
            const m = mailFor(to);
            assert.ok(!m.html!.includes(SECRET) && !m.text!.includes(SECRET), `${to} must not get the gold body`);
            assert.ok(m.html!.includes('The author wrote this summary'));
        }
    });

    test('a test send as a member without access is the teaser too', async () => {
        const r = await plugin.call('post', '/newsletter/test', { user: ADMIN, body: { post_id: 10, email: 'qa@example.com', variant: 'teaser' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(plugin.mails.length, 0, 'queued, not sent inline');
        await drain();
        const m = mailFor('qa@example.com');
        assert.ok(!m.html!.includes(SECRET) && !m.text!.includes(SECRET));
        assert.strictEqual(m.subject, 'Paid analysis');
    });
});

describe('unsubscribe', () => {
    test('one link per account: it works for that account only, forged and foreign tokens are refused', async () => {
        await send(11, 'all');
        await drain();
        const link = mailFor('ana@example.com').html!.match(/http:\/\/site\.test\/portal\/memberships\?u=(\d+)&amp;t=([0-9a-f]{32})/);
        assert.ok(link, 'the mail carries the one-click link');
        const [, u, t] = link!;
        assert.strictEqual(u, '2');
        assert.ok(mailFor('ana@example.com').text!.includes(`/portal/memberships?u=2&t=${t}`));
        const other = mailFor('bea@example.com').html!.match(/u=3&amp;t=([0-9a-f]{32})/)![1];
        assert.notStrictEqual(other, t, 'tokens differ per account');

        assert.strictEqual((await plugin.call('post', '/public/newsletter', { body: { u: 3, t, subscribed: false } })).status, 400, 'Ana\'s token cannot unsubscribe Bea');
        assert.strictEqual((await plugin.call('post', '/public/newsletter', { body: { u: 2, t: 'f'.repeat(32), subscribed: false } })).status, 400);
        assert.strictEqual((await plugin.call('get', '/public/newsletter', { query: { u: '2', t: 'nope' } })).status, 400);

        const off = await plugin.call('post', '/public/newsletter', { body: { u: 2, t, subscribed: false } });
        assert.deepStrictEqual([off.status, off.body], [200, { subscribed: false }]);
        assert.deepStrictEqual((await plugin.call('get', '/public/newsletter', { query: { u: '2', t } })).body, { subscribed: false });
        const me = (await plugin.call('get', '/me/newsletter', { user: { id: 2, role: 'subscriber' } })).body;
        assert.deepStrictEqual([me.subscribed, me.enabled], [false, true]);

        plugin.mails.length = 0;
        await send(10, 'all');
        await drain();
        assert.ok(!mailsTo().includes('ana@example.com'), 'unsubscribed: skipped');
        await plugin.call('post', '/public/newsletter', { body: { u: 2, t, subscribed: true } });
        assert.deepStrictEqual((await plugin.call('get', '/me/newsletter', { user: { id: 2, role: 'subscriber' } })).body.subscribed, true);
    });
});

describe('the queue', () => {
    test('the publish hook only writes a trigger; the worker sends, once per post', async () => {
        await actions.get('post_updated')(11, { status: 'publish' }, 'draft');
        assert.strictEqual(plugin.mails.length, 0, 'nothing is sent from the publish path');
        await actions.get('post_updated')(11, { title: 'edited' }, 'publish');
        await actions.get('post_updated')(11, { status: 'publish' }, 'publish');
        assert.strictEqual(plugin.sdb.prepare(`SELECT COUNT(*) AS n FROM ${plugin.prefix}nl_triggers`).get().n, 1, 'only the transition into publish triggers');
        await drain();
        assert.strictEqual(plugin.mails.length, 4, 'the `free` audience of post 11');
        await actions.get('wp_insert_post')(11, { status: 'publish' });
        await drain();
        assert.strictEqual(plugin.mails.length, 4, 'one newsletter per post');
        assert.strictEqual((await send(11, 'all')).status, 409);
        const log = (await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends;
        assert.deepStrictEqual(log.map((s: any) => [s.status, s.delivered, s.failed, s.total]), [['done', 4, 0, 4]]);
    });

    test('a post without the editor choice is not sent', async () => {
        POSTS[14] = { ...POSTS[11], id: 14, meta: {} };
        await actions.get('wp_insert_post')(14, { status: 'publish' });
        await drain();
        assert.strictEqual(plugin.mails.length, 0);
        delete POSTS[14];
    });

    test('an author\'s request waits for approval; approve sends it, discard drops it', async () => {
        await actions.get('wp_insert_post')(13, { status: 'publish' });
        await drain();
        assert.strictEqual(plugin.mails.length, 0);
        const [pending] = (await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends;
        assert.strictEqual(pending.status, 'pending_approval');
        await plugin.call('post', '/newsletter/sends/:id/approve', { user: ADMIN, params: { id: String(pending.id) } });
        await drain();
        assert.strictEqual(plugin.mails.length, 6);
        assert.strictEqual((await plugin.call('post', '/newsletter/sends/:id/discard', { user: ADMIN, params: { id: String(pending.id) } })).status, 409);
    });

    test('the per-minute rate is honoured', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 2 } });
        await send(11, 'all');
        const r = await process();
        assert.strictEqual(r.body.sent, 2);
        assert.strictEqual((await process()).body.sent, 0, 'budget used up for this minute');
        assert.strictEqual((await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.pendingDeliveries, 4);
    });

    test('failures retry with backoff, then count as failed; an admin retry delivers them', async () => {
        plugin.setMailFailure(new Error('Mail server not available'));
        await send(11, 'paid');
        const first = await process();
        assert.strictEqual(first.body.retried, 2);
        const row = plugin.sdb.prepare(`SELECT attempts, next_attempt_at, status, last_error FROM ${plugin.prefix}nl_deliveries LIMIT 1`).get();
        assert.deepStrictEqual([row.attempts, row.status, row.last_error], [1, 'pending', 'Mail server not available']);
        assert.ok(row.next_attempt_at > Date.now() + 50 * 1000, 'backs off about a minute');
        assert.strictEqual((await process()).body.retried, 0, 'not retried before its time');
        // Fast-forward the backoff twice: the third failure is final.
        for (let i = 0; i < 2; i++) {
            plugin.sdb.prepare(`UPDATE ${plugin.prefix}nl_deliveries SET next_attempt_at = 0`).run();
            await process();
        }
        let [s] = (await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends;
        assert.deepStrictEqual([s.status, s.delivered, s.failed], ['failed', 0, 2]);
        const failed = (await plugin.call('get', '/newsletter/sends/:id/deliveries', { user: ADMIN, params: { id: String(s.id) }, query: { status: 'failed' } })).body.deliveries;
        assert.deepStrictEqual(failed.map((d: any) => d.attempts), [3, 3]);

        plugin.setMailFailure(null);
        assert.deepStrictEqual((await plugin.call('post', '/newsletter/sends/:id/retry', { user: ADMIN, params: { id: String(s.id) } })).body, { requeued: 2 });
        await drain();
        [s] = (await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends;
        assert.deepStrictEqual([s.status, s.delivered, s.failed], ['done', 2, 0]);
    });
});
describe("the mail provider's verdict", () => {
    test("a permanent rejection fails the delivery at once; a transient one is the provider's to retry", async () => {
        plugin.setMailResult((m) => ({
            success: false,
            delivered: [],
            failed: m.to === 'carla@example.com'
                ? [{ recipient: 'carla@example.com', error: '550 no such user', permanent: true }]
                : [{ recipient: m.to, error: '421 try later', permanent: false }],
        }));
        await send(11, 'paid');
        await drain();
        const [s] = (await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends;
        assert.deepStrictEqual([s.status, s.delivered, s.failed], ['done', 1, 1]);
        const rows = (await plugin.call('get', '/newsletter/sends/:id/deliveries', { user: ADMIN, params: { id: String(s.id) } })).body.deliveries;
        const carla = rows.find((r: any) => r.email === 'carla@example.com');
        const dani = rows.find((r: any) => r.email === 'dani@example.com');
        assert.deepStrictEqual([carla.status, carla.attempts, carla.last_error], ['failed', 1, '550 no such user']);
        assert.strictEqual(dani.status, 'sent');
        assert.match(dani.last_error, /421 try later/);
    });
});

describe('the editor field', () => {
    test('the plugin declares it, and core validates declarations', async () => {
        const fields = await filters.get('post_editor_fields')([]);
        assert.deepStrictEqual(fields.map((f: any) => f.metaKey), ['newsletter_audience']);
        assert.deepStrictEqual(fields[0].options.map((o: any) => o.value), ['', 'all', 'free', 'paid']);
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterEnabled: false } });
        assert.deepStrictEqual(await filters.get('post_editor_fields')([]), [], 'newsletters off: no field');

        const { cleanField } = require('../core/editor-fields');
        assert.strictEqual(cleanField({ metaKey: '_wjs_access', type: 'text' }), null, 'no internal keys');
        assert.strictEqual(cleanField({ metaKey: 'seo_title', type: 'text' }), null, 'no core keys');
        assert.strictEqual(cleanField({ metaKey: 'x', type: 'text' }), null, 'too short');
        assert.strictEqual(cleanField({ metaKey: 'audience', type: 'select', options: [] }), null, 'a select needs options');
        assert.deepStrictEqual(cleanField({ metaKey: 'audience', type: 'evil', label: 'A', options: [{ value: 'a', label: 'A' }, { bad: 1 }] }),
            { metaKey: 'audience', label: 'A', type: 'select', postTypes: ['post'], options: [{ value: 'a', label: 'A' }] });
    });
});

describe('only confirmed addresses (second audit)', () => {
    test('an unconfirmed address gets one fixed-text confirmation mail, not the newsletter — once every 30 days', async () => {
        confirm(2, null); // Ana typed an address nobody confirmed
        await send(11, 'all');
        await drain();
        const toAna = plugin.mails.filter((m) => m.to === 'ana@example.com');
        assert.strictEqual(toAna.length, 1);
        assert.match(toAna[0].subject, /^Confirma tu correo/);
        assert.ok(!toAna[0].html!.includes('Everyone reads this'), 'no newsletter before the address is confirmed');
        assert.ok(!/Ana/.test(toAna[0].html!) && !/Ana/.test(toAna[0].text!), 'nothing a visitor wrote (not even the account name)');
        assert.ok(mailsTo().includes('bea@example.com') && mailFor('bea@example.com').html!.includes('Everyone reads this'), 'confirmed members get it');

        plugin.mails.length = 0;
        await send(13, 'all');
        await plugin.call('post', '/newsletter/sends/:id/approve', { user: ADMIN, params: { id: String((await plugin.call('get', '/newsletter/sends', { user: ADMIN })).body.sends[0].id) } });
        await drain();
        assert.ok(!mailsTo().includes('ana@example.com'), 'no second confirmation within 30 days, and still no newsletter');
    });

    test('the confirmation link confirms that account at that address only; changing the address un-confirms it', async () => {
        confirm(2, null);
        await send(11, 'all');
        await drain();
        const html = mailFor('ana@example.com').html!;
        const [, u, t, c] = html.match(/portal\/memberships\?u=(\d+)&amp;t=([0-9a-f]{32})&amp;c=([0-9a-f]{32})/)!;
        assert.strictEqual(u, '2');
        assert.strictEqual((await plugin.call('post', '/public/newsletter', { body: { u: 2, t, confirm: true, c: 'f'.repeat(32) } })).status, 400, 'a forged code');
        const ok = await plugin.call('post', '/public/newsletter', { body: { u: 2, t, confirm: true, c } });
        assert.deepStrictEqual([ok.status, ok.body], [200, { subscribed: true, confirmed: true }]);
        assert.strictEqual((await plugin.call('get', '/me/newsletter', { user: { id: 2, role: 'subscriber' } })).body.confirmed, true);

        // Ana changes her address: the old confirmation does not cover the new one.
        const ana = ACCOUNTS.find((a) => a.id === 2)!;
        ana.userEmail = 'ana.new@example.com';
        try {
            assert.strictEqual((await plugin.call('get', '/me/newsletter', { user: { id: 2, role: 'subscriber' } })).body.confirmed, false);
            assert.strictEqual((await plugin.call('post', '/public/newsletter', { body: { u: 2, t, confirm: true, c } })).status, 400, 'the old link is for the old address');
        } finally {
            ana.userEmail = 'ana@example.com';
        }
    });

    test('the member asks for the link from the account block: sent to the account address, once a day', async () => {
        confirm(3, null);
        const r = await plugin.call('post', '/me/newsletter/confirm', { user: { id: 3, role: 'subscriber' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        await drain();
        assert.deepStrictEqual(mailsTo(), ['bea@example.com']);
        assert.match(mailFor('bea@example.com').subject, /^Confirma tu correo/);
        assert.strictEqual((await plugin.call('post', '/me/newsletter/confirm', { user: { id: 3, role: 'subscriber' } })).status, 429);
    });
});

describe('unsubscribe in one click from the mail client (RFC 8058)', () => {
    test('every newsletter carries List-Unsubscribe + List-Unsubscribe-Post; that POST unsubscribes with the token only', async () => {
        await send(11, 'all');
        await drain();
        const h = (mailFor('ana@example.com') as any).extraHeaders;
        assert.ok(h, 'headers handed to the mail provider');
        assert.strictEqual(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        const [, url] = String(h['List-Unsubscribe']).match(/^<(.+)>$/)!;
        const parsed = new URL(url);
        assert.strictEqual(parsed.pathname, '/api/v1/plugin/memberships/public/newsletter/one-click');
        assert.strictEqual(parsed.searchParams.get('u'), '2');
        const t = parsed.searchParams.get('t')!;
        assert.strictEqual((await plugin.call('post', '/public/newsletter/one-click', { query: { u: '3', t }, rawBody: 'List-Unsubscribe=One-Click' })).status, 400, 'Ana\'s token is not Bea\'s');
        const r = await plugin.call('post', '/public/newsletter/one-click', { query: { u: '2', t }, rawBody: 'List-Unsubscribe=One-Click' });
        assert.deepStrictEqual([r.status, r.body], [200, { subscribed: false }]);
        assert.strictEqual((await plugin.call('get', '/me/newsletter', { user: { id: 2, role: 'subscriber' } })).body.subscribed, false);
    });
});

describe('decided when each mail is sent; claimed so it is sent once (second audit)', () => {
    test('a post gated after its send started goes out as a teaser to the rest', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 1 } });
        const saved = JSON.parse(JSON.stringify(POSTS[11]));
        try {
            await send(11, 'all');
            await process(); // the list is built ("full" for everyone: the post is public) and one mail goes out
            POSTS[11] = { ...saved, accessLevel: 'paid', content: `<p>Open part</p><hr class="wjs-access-break" /><p>${SECRET} added later</p>` };
            await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 600 } });
            await drain();
            for (const to of ['ana@example.com', 'bea@example.com', 'writer@example.com', 'admin@site.test']) {
                const m = plugin.mails.find((x) => x.to === to);
                if (m) assert.ok(!m.html!.includes(SECRET) && !m.text!.includes(SECRET), `${to} received the body gated after the list was built`);
            }
            assert.ok(mailFor('carla@example.com').html!.includes(SECRET), 'a paid member still gets it in full');
        } finally {
            POSTS[11] = saved;
        }
    });

    test('an address that unsubscribed after the list was built is skipped', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 1 } });
        await send(11, 'all');
        await process();
        const first = plugin.mails[0].to;
        const later = ['ana@example.com', 'bea@example.com'].find((e) => e !== first)!;
        const id = ACCOUNTS.find((a) => a.userEmail === later)!.id;
        await plugin.call('post', '/me/newsletter', { user: { id, role: 'subscriber' }, body: { subscribed: false } });
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 600 } });
        await drain();
        assert.ok(!mailsTo().includes(later), `${later} unsubscribed before their mail went out`);
    });

    test('one send per post even for two simultaneous requests; a delivery another run claimed is not sent again', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 1 } });
        const both = await Promise.all([send(11, 'all'), send(11, 'all')]);
        assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409]);
        await process();
        // Another worker claimed one delivery a moment ago: this run leaves it alone.
        await plugin.call('post', '/config', { user: ADMIN, body: { newsletterRate: 600 } });
        const d = plugin.sdb.prepare(`SELECT id, email FROM ${plugin.prefix}nl_deliveries WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}nl_deliveries SET status = 'sending', claimed_at = ? WHERE id = ?`).run(Date.now(), d.id);
        plugin.mails.length = 0;
        await drain();
        assert.ok(!mailsTo().includes(d.email), 'claimed elsewhere: not mailed twice');
        // ... unless that claim is long dead (the worker stopped): then it is retried.
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}nl_deliveries SET claimed_at = ? WHERE id = ?`).run(Date.now() - 60 * 60 * 1000, d.id);
        await drain();
        assert.ok(mailsTo().includes(d.email));
    });

    test('a title with a line break is one subject line', async () => {
        POSTS[15] = { ...POSTS[11], id: 15, title: 'Line one\r\nBcc: victim@example.com' };
        try {
            await send(15, 'all');
            await drain();
            assert.strictEqual(mailFor('ana@example.com').subject, 'Line one Bcc: victim@example.com');
        } finally {
            delete POSTS[15];
        }
    });
});

describe('the plain-text part', () => {
    const { textOf } = require('../../../marketplace/plugins/memberships/lib/newsletter.js');

    test('tags nested to survive one pass are gone, and entities are decoded once', () => {
        assert.strictEqual(textOf('<p>a<<b>script>alert(1)<</b>/script>b</p>'), 'aalert(1)b', 'the tag a first pass reassembles is stripped too');
        assert.ok(!/<|>/.test(textOf('<<script>script>x<</script>/script><img src=x onerror=1>')), 'no tag survives');
        assert.strictEqual(textOf('&amp;lt;b&amp;gt; &amp;amp; &lt;i&gt;'), '&lt;b&gt; &amp; <i>', 'one decoding pass, not two');
        assert.strictEqual(textOf('<p>One</p><p>Two&nbsp;&quot;3&quot; &#39;4&#39;</p>'), 'One\nTwo "3" \'4\'');
    });
});
