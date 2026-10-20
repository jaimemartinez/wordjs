/**
 * The bundled `memberships` plugin (marketplace/plugins/memberships) against a recorded Stripe.
 *
 * The REAL plugin entry runs in the marketplace harness (its SQL through the host SQL guard, its HMAC
 * through the host's crypto bridge). Stripe is a stub of `fetch` that records every request and answers
 * like the API does, so the tests can assert what the plugin SENDS (prices come from the tier row, never
 * from the client) and how it applies what comes BACK.
 *
 *  · the webhook: Stripe-Signature verification (valid, wrong secret, tampered body, stale timestamp,
 *    missing header, no secret configured), idempotency by event id, live events refused;
 *  · lifecycle through webhooks: checkout completed → access; subscription updated (tier change,
 *    cancel at period end) → levels follow; payment failed → past due (access kept); deleted → no access;
 *  · the member's own actions: checkout (server-side price, one subscription at a time, test keys only),
 *    the return leg (a session of another account is refused), change tier (prorated, new price), cancel
 *    and resume;
 *  · complimentary memberships: grant with an end date, expiry, revoke.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
import { bootPlugin, type BootedPlugin } from './fixtures/marketplace-plugin-harness';

const ADMIN = { id: 1, role: 'administrator' };
const MEMBER = { id: 42, role: 'subscriber', userEmail: 'reader@example.com', userLogin: 'reader' };
const OTHER = { id: 43, role: 'subscriber', userEmail: 'other@example.com', userLogin: 'other' };
const WHSEC = 'whsec_testsecret123';

let plugin: BootedPlugin;
let filters: Map<string, (...a: any[]) => any>;
let stripeCalls: Array<{ method: string; path: string; params: URLSearchParams; auth: string }>;
let stripeReplies: Array<(call: any) => any>;
const realFetch = global.fetch;

/** Answer the next Stripe calls in order; each reply is a function of the recorded call. */
const stripeWill = (...replies: Array<(call: any) => any>) => { stripeReplies.push(...replies); };

function sign(body: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
    return `t=${t},v1=${v1}`;
}

async function deliver(event: any, opts: { secret?: string; t?: number; header?: string | null; tamper?: boolean } = {}) {
    const body = JSON.stringify(event);
    const header = opts.header === null ? undefined : (opts.header || sign(body, opts.secret, opts.t));
    return plugin.call('post', '/stripe/webhook', {
        rawBody: opts.tamper ? body.replace('"active"', '"canceled"') : body,
        body: event,
        headers: header ? { 'stripe-signature': header } : {},
    });
}

const grantsOf = async (userId: number) => filters.get('content_access_grants')!([], { userId, role: 'subscriber' });

let tiers: Record<string, any> = {};
let eventSeq = 0;
const evt = (type: string, object: any, extra: any = {}) => ({ id: `evt_${++eventSeq}`, type, livemode: false, data: { object }, ...extra });

beforeEach(async () => {
    filters = new Map();
    stripeCalls = [];
    stripeReplies = [];
    (global as any).fetch = async (url: string, init: any) => {
        const u = new URL(url);
        assert.strictEqual(u.host, 'api.stripe.com', 'the plugin only talks to Stripe');
        const call = { method: init.method, path: u.pathname + u.search, params: new URLSearchParams(init.body || ''), auth: init.headers.Authorization };
        stripeCalls.push(call);
        const reply = stripeReplies.shift();
        if (!reply) throw new Error(`unexpected Stripe call ${call.method} ${call.path}`);
        const body = reply(call);
        return { ok: !(body && body.error), status: body && body.error ? 400 : 200, json: async () => body };
    };
    plugin = await bootPlugin('memberships', {
        hooks: { addFilter: (h: string, cb: any) => { filters.set(h, cb); } },
        users: {
            findById: async (id: any) => ([MEMBER, OTHER].find((u) => u.id === Number(id)) ? { id: Number(id), userLogin: 'u', userEmail: 'u@example.com', displayName: 'U' } : null),
            findByEmail: async (e: any) => ([MEMBER, OTHER].find((u) => u.userEmail === e) || null),
            findByLogin: async (l: any) => ([MEMBER, OTHER].find((u) => u.userLogin === l) || null),
        },
    });
    tiers = {};
    for (const [name, cents] of [['Silver', 500], ['Gold', 1500]] as const) {
        const r = await plugin.call('post', '/tiers', { user: ADMIN, body: { name, price_cents: cents } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        tiers[name.toLowerCase()] = r.body.tier;
    }
    const cfg = await plugin.call('post', '/config', { user: ADMIN, body: { stripeKey: 'sk_test_abc', webhookSecret: WHSEC } });
    assert.strictEqual(cfg.status, 200, JSON.stringify(cfg.body));
});

afterEach(() => {
    (global as any).fetch = realFetch;
    plugin.close();
});

describe('webhook signature verification', () => {
    const sub = () => ({ id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
        metadata: { wordjs_user_id: String(MEMBER.id), wordjs_tier_id: String(tiers.silver.id) },
        items: { data: [{ id: 'si_1', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } });

    test('a correctly signed event is applied', async () => {
        const r = await deliver(evt('customer.subscription.updated', sub()));
        assert.deepStrictEqual([r.status, r.body], [200, { received: true }]);
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:silver'));
    });

    test('wrong secret, tampered body, stale or future timestamp, malformed or missing header: refused, nothing applied', async () => {
        const now = Math.floor(Date.now() / 1000);
        const cases: Array<[string, any]> = [
            ['wrong secret', { secret: 'whsec_other' }],
            ['tampered body', { tamper: true }],
            ['stale timestamp', { t: now - 301 }],
            ['future timestamp', { t: now + 301 }],
            ['no v1 signature', { header: `t=${now},v0=abc` }],
            ['garbage header', { header: 'nonsense' }],
            ['missing header', { header: null }],
        ];
        for (const [label, opts] of cases) {
            const r = await deliver(evt('customer.subscription.updated', sub()), opts);
            assert.strictEqual(r.status, 400, label);
        }
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members'], 'nothing was applied');
        assert.strictEqual(plugin.sdb.prepare(`SELECT COUNT(*) AS n FROM ${plugin.prefix}events`).get().n, 0);
    });

    test('one valid v1 among several is enough (secret rotation)', async () => {
        const body = JSON.stringify(evt('customer.subscription.updated', sub()));
        const good = sign(body).split(',')[1];
        const t = sign(body).split(',')[0];
        const r = await plugin.call('post', '/stripe/webhook', { rawBody: body, headers: { 'stripe-signature': `${t},v1=${'0'.repeat(64)},${good}` } });
        assert.strictEqual(r.status, 200);
    });

    test('no signing secret configured → every delivery is refused', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { webhookSecret: '' } });
        const r = await deliver(evt('customer.subscription.updated', sub()));
        assert.strictEqual(r.status, 400);
    });

    test('each event id is processed once; live-mode events are refused', async () => {
        const e = evt('customer.subscription.updated', sub());
        assert.deepStrictEqual((await deliver(e)).body, { received: true });
        // A replay of the same id (Stripe redelivers) is acknowledged without being re-applied.
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}members SET status = 'canceled'`).run();
        assert.deepStrictEqual((await deliver(e)).body, { received: true, duplicate: true });
        assert.strictEqual(plugin.sdb.prepare(`SELECT status FROM ${plugin.prefix}members`).get().status, 'canceled');
        const live = await deliver(evt('customer.subscription.updated', sub(), { livemode: true }));
        assert.strictEqual(live.status, 400);
    });

    test('events for objects that are not ours are acknowledged and ignored', async () => {
        const foreign = { ...sub(), id: 'sub_foreign', metadata: {} };
        assert.strictEqual((await deliver(evt('customer.subscription.updated', foreign))).status, 200);
        assert.strictEqual(plugin.sdb.prepare(`SELECT COUNT(*) AS n FROM ${plugin.prefix}members`).get().n, 0);
        assert.strictEqual((await deliver(evt('charge.refunded', { id: 'ch_1' }))).status, 200);
    });
});

describe('subscription lifecycle through webhooks', () => {
    const periodEnd = () => Math.floor(Date.now() / 1000) + 30 * 86400;

    test('checkout completed → paid levels; tier change → levels follow; cancel at period end keeps access; deleted → free only', async () => {
        const session = { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
            customer: 'cus_9', subscription: 'sub_9', metadata: { wordjs_user_id: String(MEMBER.id), wordjs_tier_id: String(tiers.silver.id) } };
        await deliver(evt('checkout.session.completed', session));
        assert.deepStrictEqual((await grantsOf(MEMBER.id)).sort(), ['members', 'paid', 'tier:silver']);

        const up = { id: 'sub_9', status: 'active', customer: 'cus_9', cancel_at_period_end: false, current_period_end: periodEnd(),
            metadata: { wordjs_user_id: String(MEMBER.id), wordjs_tier_id: String(tiers.gold.id) } };
        await deliver(evt('customer.subscription.updated', up));
        assert.deepStrictEqual((await grantsOf(MEMBER.id)).sort(), ['members', 'paid', 'tier:gold', 'tier:silver'], 'upgraded: gold opens silver too');

        await deliver(evt('customer.subscription.updated', { ...up, cancel_at_period_end: true }));
        const me = await plugin.call('get', '/me', { user: MEMBER });
        assert.strictEqual(me.body.member.cancelAtPeriodEnd, true);
        assert.ok(me.body.levels.includes('tier:gold'), 'a cancellation at period end keeps access until then');

        await deliver(evt('invoice.payment_failed', { id: 'in_1', subscription: 'sub_9' }));
        assert.strictEqual((await plugin.call('get', '/me', { user: MEMBER })).body.member.status, 'past_due');
        assert.ok((await grantsOf(MEMBER.id)).includes('paid'), 'Stripe is still retrying: access kept');
        await deliver(evt('invoice.paid', { id: 'in_2', parent: { subscription_details: { subscription: 'sub_9' } } }));
        assert.strictEqual((await plugin.call('get', '/me', { user: MEMBER })).body.member.status, 'active', 'newer API shape (parent.subscription_details)');

        await deliver(evt('customer.subscription.deleted', { ...up, status: 'canceled' }));
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members'], 'back to a free member');
    });

    test('a membership whose paid period lapsed without a renewal stops granting after the grace window', async () => {
        await deliver(evt('customer.subscription.updated', { id: 'sub_old', status: 'active', customer: 'cus_o', cancel_at_period_end: false,
            current_period_end: Math.floor(Date.now() / 1000) - 4 * 86400,
            metadata: { wordjs_user_id: String(MEMBER.id), wordjs_tier_id: String(tiers.gold.id) } }));
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });

    test('with free sign-up off, a signed-in account without a membership holds nothing', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { freeSignup: false } });
        assert.deepStrictEqual(await grantsOf(OTHER.id), []);
    });
});

describe('the member\'s own actions', () => {
    const completedSession = (userId: number, tierId: number, id = 'cs_test_ok') => ({
        id, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_m',
        subscription: { id: 'sub_m', status: 'active', customer: 'cus_m', cancel_at_period_end: false,
            items: { data: [{ id: 'si_m', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } },
        metadata: { wordjs_user_id: String(userId), wordjs_tier_id: String(tierId) },
    });

    test('checkout: the price is the tier row\'s, the success URL stays on this site, the session is bound to the account', async () => {
        stripeWill(() => ({ id: 'prod_silver' }), () => ({ id: 'cs_test_ok', url: 'https://checkout.stripe.com/c/pay/cs_test_ok' }));
        const r = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.silver.id, amount: 1, unit_amount: 1, page_url: 'https://evil.example/steal?x=1' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_ok');
        const [product, session] = stripeCalls;
        assert.strictEqual(product.path, '/v1/products');
        assert.strictEqual(session.path, '/v1/checkout/sessions');
        assert.strictEqual(session.auth, 'Bearer sk_test_abc');
        assert.strictEqual(session.params.get('mode'), 'subscription');
        assert.strictEqual(session.params.get('line_items[0][price_data][unit_amount]'), '500', 'the tier price, not the client\'s');
        assert.strictEqual(session.params.get('line_items[0][price_data][product]'), 'prod_silver');
        assert.strictEqual(session.params.get('line_items[0][price_data][recurring][interval]'), 'month');
        assert.strictEqual(session.params.get('metadata[wordjs_user_id]'), String(MEMBER.id));
        assert.strictEqual(session.params.get('subscription_data[metadata][wordjs_tier_id]'), String(tiers.silver.id));
        assert.strictEqual(session.params.get('success_url'), 'http://site.test/steal?x=1&ms_session={CHECKOUT_SESSION_ID}', 'only the path survives; the host is this site');
        assert.strictEqual(session.params.get('customer_email'), MEMBER.userEmail);
    });

    test('the return leg activates the membership — and refuses a session started by another account', async () => {
        stripeWill(() => ({ id: 'prod_silver' }), () => ({ id: 'cs_test_ok', url: 'https://checkout.stripe.com/x' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.silver.id } });
        const stolen = await plugin.call('get', '/me/confirm', { user: OTHER, query: { session_id: 'cs_test_ok' } });
        assert.strictEqual(stolen.status, 404);
        stripeWill(() => completedSession(MEMBER.id, tiers.silver.id));
        const ok = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { session_id: 'cs_test_ok' } });
        assert.deepStrictEqual([ok.status, ok.body], [200, { active: true }]);
        assert.ok(stripeCalls[stripeCalls.length - 1].path.startsWith('/v1/checkout/sessions/cs_test_ok?expand'), 'retrieved server-side');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:silver'));
        // A second checkout while subscribed is refused (change tier instead).
        const again = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.gold.id } });
        assert.strictEqual(again.status, 409);
    });

    test('change tier: the subscription item moves to the new tier\'s price, prorated; then cancel and resume', async () => {
        stripeWill(() => ({ id: 'prod_silver' }), () => ({ id: 'cs_test_ok', url: 'https://checkout.stripe.com/x' }), () => completedSession(MEMBER.id, tiers.silver.id));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.silver.id } });
        await plugin.call('get', '/me/confirm', { user: MEMBER, query: { session_id: 'cs_test_ok' } });
        stripeCalls = [];

        const end = Math.floor(Date.now() / 1000) + 30 * 86400;
        stripeWill(
            () => ({ id: 'sub_m', items: { data: [{ id: 'si_m' }] } }),
            () => ({ id: 'prod_gold' }),
            (call: any) => ({ id: 'sub_m', status: 'active', customer: 'cus_m', cancel_at_period_end: false, current_period_end: end,
                metadata: { wordjs_user_id: call.params.get('metadata[wordjs_user_id]'), wordjs_tier_id: call.params.get('metadata[wordjs_tier_id]') } }),
        );
        const ch = await plugin.call('post', '/me/change-tier', { user: MEMBER, body: { tier_id: tiers.gold.id } });
        assert.strictEqual(ch.status, 200, JSON.stringify(ch.body));
        const update = stripeCalls[2];
        assert.strictEqual(update.path, '/v1/subscriptions/sub_m');
        assert.strictEqual(update.params.get('items[0][id]'), 'si_m');
        assert.strictEqual(update.params.get('items[0][price_data][unit_amount]'), '1500');
        assert.strictEqual(update.params.get('items[0][price_data][product]'), 'prod_gold');
        assert.strictEqual(update.params.get('proration_behavior'), 'create_prorations');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:gold'));
        assert.strictEqual((await plugin.call('post', '/me/change-tier', { user: MEMBER, body: { tier_id: tiers.gold.id } })).status, 400, 'already on it');

        stripeWill((call: any) => ({ id: 'sub_m', status: 'active', customer: 'cus_m', cancel_at_period_end: call.params.get('cancel_at_period_end') === 'true', current_period_end: end, metadata: {} }));
        const cancel = await plugin.call('post', '/me/cancel', { user: MEMBER });
        assert.deepStrictEqual(cancel.body, { ok: true, cancelAtPeriodEnd: true });
        assert.strictEqual(stripeCalls[stripeCalls.length - 1].params.get('cancel_at_period_end'), 'true');
        const me = await plugin.call('get', '/me', { user: MEMBER });
        assert.strictEqual(me.body.member.cancelAtPeriodEnd, true);
        assert.ok(me.body.levels.includes('tier:gold'), 'access continues to the end of the period');

        stripeWill((call: any) => ({ id: 'sub_m', status: 'active', customer: 'cus_m', cancel_at_period_end: call.params.get('cancel_at_period_end') === 'true', current_period_end: end, metadata: {} }));
        const resume = await plugin.call('post', '/me/resume', { user: MEMBER });
        assert.deepStrictEqual(resume.body, { ok: true, cancelAtPeriodEnd: false });
        assert.strictEqual((await plugin.call('get', '/me', { user: MEMBER })).body.member.cancelAtPeriodEnd, false);
    });

    test('billing actions need a live paid membership', async () => {
        for (const p of ['/me/cancel', '/me/resume', '/me/change-tier']) {
            assert.strictEqual((await plugin.call('post', p, { user: OTHER, body: { tier_id: tiers.gold.id } })).status, 404, p);
        }
        assert.strictEqual(stripeCalls.length, 0);
    });

    test('only Stripe TEST keys are accepted; without a key there is no checkout', async () => {
        const live = await plugin.call('post', '/config', { user: ADMIN, body: { stripeKey: 'sk_live_123' } });
        assert.strictEqual(live.status, 400);
        await plugin.call('post', '/config', { user: ADMIN, body: { stripeKey: '' } });
        const r = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.silver.id } });
        assert.strictEqual(r.status, 400);
        const cfg = await plugin.call('get', '/config', { user: ADMIN });
        assert.ok(!JSON.stringify(cfg.body).includes('whsec_testsecret123'), 'secrets are never echoed');
        assert.strictEqual(cfg.body.hasWebhookSecret, true);
    });
});

describe('complimentary memberships', () => {
    test('grant with an end date, expiry, revoke', async () => {
        const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const g = await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'reader@example.com', tier_id: tiers.gold.id, until } });
        assert.strictEqual(g.status, 200, JSON.stringify(g.body));
        assert.strictEqual(g.body.member.source, 'comped');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:gold'));

        plugin.sdb.prepare(`UPDATE ${plugin.prefix}members SET comped_until = ?`).run(new Date(Date.now() - 1000).toISOString());
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members'], 'expired');

        await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'reader', tier_id: tiers.silver.id } });
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:silver'), 're-granted (by login), no end date');
        const id = plugin.sdb.prepare(`SELECT id FROM ${plugin.prefix}members`).get().id;
        const rv = await plugin.call('post', '/members/:id/revoke', { user: ADMIN, params: { id: String(id) } });
        assert.strictEqual(rv.status, 200);
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
        assert.strictEqual(stripeCalls.length, 0, 'a comped membership never touches Stripe');
    });

    test('unknown accounts, past dates and a missing tier are refused', async () => {
        assert.strictEqual((await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'nobody@example.com', tier_id: tiers.gold.id } })).status, 404);
        assert.strictEqual((await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'reader', tier_id: tiers.gold.id, until: '2000-01-01' } })).status, 400);
        assert.strictEqual((await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'reader' } })).status, 400);
    });

    test('a tier slug is immutable (posts store it); a tier with members cannot be deleted', async () => {
        const r = await plugin.call('put', '/tiers/:id', { user: ADMIN, params: { id: String(tiers.gold.id) }, body: { slug: 'platinum' } });
        assert.strictEqual(r.status, 400);
        await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: 'reader', tier_id: tiers.gold.id } });
        assert.strictEqual((await plugin.call('delete', '/tiers/:id', { user: ADMIN, params: { id: String(tiers.gold.id) } })).status, 409);
        assert.strictEqual((await plugin.call('delete', '/tiers/:id', { user: ADMIN, params: { id: String(tiers.silver.id) } })).status, 200);
    });

    test('the levels offered to the editor follow the tiers', async () => {
        const levels = await filters.get('content_access_levels')!([]);
        assert.deepStrictEqual(levels.map((l: any) => l.value), ['members', 'paid', 'tier:silver', 'tier:gold']);
    });
});
