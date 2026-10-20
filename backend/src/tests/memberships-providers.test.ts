/**
 * The bundled `memberships` plugin's Mercado Pago and Wompi providers, against recorded APIs.
 * (Stripe has its own file, memberships-plugin.test.ts; the provider-independent access decision is
 * covered against the real REST surface in content-access-leaks.test.ts.)
 *
 * The REAL plugin entry runs in the marketplace harness (its SQL through the host SQL guard, its HMAC /
 * SHA-256 through the host's crypto bridge). Each provider API is a stub of `fetch` that records every
 * request and answers like the sandbox does, so the tests assert what the plugin SENDS (COP amounts from
 * the tier row, never from the client) and how it applies what comes BACK.
 *
 *  · Mercado Pago (preapproval subscriptions): x-signature valid / tampered / stale / wrong secret /
 *    missing; idempotency by x-request-id; live notifications refused; lifecycle checkout → authorized →
 *    paused (cancel) → resumed → cancelled, and paused → period over → expired; failed charge → past due;
 *    test-only credentials (an APP_USR- token must belong to a test user).
 *  · Wompi (prepaid periods + Nequi renewal): Web Checkout URL with the integrity signature; return leg
 *    bound to the account, amount and currency; event checksum valid / tampered / stale / header mismatch
 *    / production; idempotency per transaction and status; prepaying the next period; Nequi payment
 *    source; renewal charges, declines, retries and cancellation; tier change at the next period; COP only.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
import { bootPlugin, type BootedPlugin } from './fixtures/marketplace-plugin-harness';

const ADMIN = { id: 1, role: 'administrator' };
const MEMBER = { id: 42, role: 'subscriber', userEmail: 'reader@example.com', userLogin: 'reader' };
const OTHER = { id: 43, role: 'subscriber', userEmail: 'other@example.com', userLogin: 'other' };
const DAY = 86400000;

const MP_TOKEN = 'TEST-1234567890-abcdef';
const MP_SECRET = 'mpwebhooksecret0123456789';
const WOMPI = {
    publicKey: 'pub_test_Q5yDA9xoKdePzhSGeVe9HAez7HgGORGf',
    privateKey: 'prv_test_ZZZ',
    eventsSecret: 'test_events_secretABC',
    integritySecret: 'test_integrity_secretXYZ',
};

// COP prices: COP 20.000 / COP 50.000 a month, in cents.
const BASIC_CENTS = 2000000;
const PLUS_CENTS = 5000000;

type Call = { method: string; host: string; path: string; body: any; auth: string };
let plugin: BootedPlugin;
let filters: Map<string, (...a: any[]) => any>;
let calls: Call[];
let replies: Array<(call: Call) => any>;
// What Wompi holds right now: the webhook RE-READS the transaction / Nequi token an event names, so a
// delivered event's object, and every transaction the plugin creates, is what the next GET of that id
// answers.
let wompiState: Map<string, any>;
let tiers: Record<string, any> = {};
const realFetch = global.fetch;

/** Answer the next provider calls in order; each reply is a function of the recorded call. */
const apiWill = (...r: Array<(call: Call) => any>) => { replies.push(...r); };
const grantsOf = async (userId: number) => filters.get('content_access_grants')!([], { userId, role: 'subscriber' });
const memberRow = (userId = MEMBER.id) => plugin.sdb.prepare(`SELECT * FROM ${plugin.prefix}members WHERE user_id = ?`).get(userId);
const setRow = (sql: string, ...a: any[]) => plugin.sdb.prepare(`UPDATE ${plugin.prefix}members SET ${sql} WHERE user_id = ?`).run(...a, MEMBER.id);

beforeEach(async () => {
    filters = new Map();
    calls = [];
    replies = [];
    wompiState = new Map();
    (global as any).fetch = async (url: string, init: any) => {
        const u = new URL(url);
        assert.ok(['api.mercadopago.com', 'sandbox.wompi.co'].includes(u.host), `unexpected host ${u.host} — only the sandbox APIs`);
        const call: Call = { method: init.method, host: u.host, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization };
        calls.push(call);
        const known = /^\/v1\/(transactions|tokens\/nequi)\/([^/?]+)$/.exec(u.pathname);
        if (u.host === 'sandbox.wompi.co' && init.method === 'GET' && known && wompiState.has(decodeURIComponent(known[2]))) {
            const data = JSON.parse(JSON.stringify(wompiState.get(decodeURIComponent(known[2]))));
            return { ok: true, status: 200, json: async () => ({ data }) };
        }
        const reply = replies.shift();
        if (!reply) throw new Error(`unexpected call ${call.method} ${u.host}${call.path}`);
        const body = reply(call);
        // A transaction the plugin creates is then what Wompi answers for its id.
        if (u.host === 'sandbox.wompi.co' && init.method === 'POST' && u.pathname === '/v1/transactions' && body && body.data && body.data.id) {
            wompiState.set(String(body.data.id), { ...call.body, ...body.data });
        }
        const failed = body && (body.error || body.status === 400) && !body.id && !body.data;
        return { ok: !failed, status: failed ? 400 : 200, json: async () => body };
    };
    plugin = await bootPlugin('memberships', {
        hooks: { addFilter: (h: string, cb: any) => { filters.set(h, cb); } },
        users: {
            findById: async (id: any) => {
                const u = [MEMBER, OTHER].find((x) => x.id === Number(id));
                return u ? { id: u.id, userLogin: u.userLogin, userEmail: u.userEmail, displayName: u.userLogin } : null;
            },
            findByEmail: async (e: any) => ([MEMBER, OTHER].find((u) => u.userEmail === e) || null),
            findByLogin: async (l: any) => ([MEMBER, OTHER].find((u) => u.userLogin === l) || null),
        },
    });
    tiers = {};
    for (const [name, cents] of [['Basic', BASIC_CENTS], ['Plus', PLUS_CENTS]] as const) {
        const r = await plugin.call('post', '/tiers', { user: ADMIN, body: { name, price_cents: cents } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        tiers[name.toLowerCase()] = r.body.tier;
    }
});

afterEach(() => {
    (global as any).fetch = realFetch;
    plugin.close();
});

// ================================================================================================
// Mercado Pago
// ================================================================================================

function mpSign(dataId: string, requestId: string, opts: { secret?: string; ts?: number } = {}) {
    const ts = String(opts.ts ?? Date.now());
    const id = /^[A-Za-z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
    const manifest = `id:${id};request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', opts.secret || MP_SECRET).update(manifest).digest('hex');
    return `ts=${ts},v1=${v1}`;
}

let mpSeq = 0;
/** A Mercado Pago notification as it arrives: data.id in the query and the body, signed headers. */
async function mpNotify(type: string, dataId: string, opts: { sign?: string | null; signedId?: string; secret?: string; ts?: number; requestId?: string; live?: boolean } = {}) {
    const requestId = opts.requestId || `req-${++mpSeq}`;
    const body = { action: 'updated', type, data: { id: dataId }, live_mode: !!opts.live, date_created: new Date().toISOString() };
    const sig = opts.sign === null ? undefined : (opts.sign || mpSign(opts.signedId || dataId, requestId, opts));
    return plugin.call('post', '/mercadopago/webhook', {
        body, rawBody: JSON.stringify(body), query: { 'data.id': dataId, type },
        headers: { 'x-request-id': requestId, ...(sig ? { 'x-signature': sig } : {}) },
    });
}

const preapproval = (status: string, extra: any = {}) => ({
    id: 'pre_1', status, payer_id: 555, external_reference: 'x',
    next_payment_date: new Date(Date.now() + 30 * DAY).toISOString(),
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: BASIC_CENTS / 100, currency_id: 'COP' },
    ...extra,
});

async function mpConfigure() {
    const r = await plugin.call('post', '/config', { user: ADMIN, body: {
        paymentProvider: 'mercadopago', currencyCode: 'cop', currencySymbol: '$',
        credentials: { mercadopago: { accessToken: MP_TOKEN, webhookSecret: MP_SECRET } },
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
}

/** Checkout + return leg: MEMBER on Basic, authorized. */
async function mpSubscribe() {
    apiWill(() => ({ id: 'pre_1', status: 'pending', init_point: 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=pre_1' }));
    const c = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.basic.id, page_url: 'http://site.test/post?x=1' } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    apiWill(() => preapproval('authorized'));
    const ok = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'mercadopago', preapproval_id: 'pre_1' } });
    assert.deepStrictEqual([ok.status, ok.body], [200, { active: true }]);
    return c;
}

describe('Mercado Pago: credentials and checkout', () => {
    test('test credentials only; an APP_USR- token must be a test user\'s; masked in the admin', async () => {
        const live = await plugin.call('post', '/config', { user: ADMIN, body: { credentials: { mercadopago: { accessToken: 'sk_live_nope' } } } });
        assert.strictEqual(live.status, 400);
        // APP_USR- is ALSO the production format: Mercado Pago must say it is a test user.
        apiWill((call) => { assert.strictEqual(call.path, '/users/me'); return { id: 1, tags: ['normal', 'mshops'] }; });
        const prod = await plugin.call('post', '/config', { user: ADMIN, body: { credentials: { mercadopago: { accessToken: 'APP_USR-1-prod' } } } });
        assert.strictEqual(prod.status, 400);
        assert.match(prod.body.error, /usuario de prueba/);
        apiWill(() => ({ id: 2, tags: ['test_user'] }));
        const testUser = await plugin.call('post', '/config', { user: ADMIN, body: { credentials: { mercadopago: { accessToken: 'APP_USR-2-testuser' } } } });
        assert.strictEqual(testUser.status, 200, JSON.stringify(testUser.body));
        const cfg = await mpConfigure();
        const mp = cfg.providers.find((p: any) => p.id === 'mercadopago');
        assert.deepStrictEqual(mp.credentials.map((c: any) => c.set), [true, true]);
        assert.ok(!JSON.stringify(cfg).includes(MP_TOKEN) && !JSON.stringify(cfg).includes(MP_SECRET), 'never echoed back');
        assert.strictEqual(mp.webhookUrl, 'http://site.test/api/v1/plugin/memberships/mercadopago/webhook');
        const pub = await plugin.call('get', '/public/tiers', {});
        assert.deepStrictEqual([pub.body.paymentsEnabled, pub.body.provider], [true, 'mercadopago']);
    });

    test('checkout: a preapproval in COP for the tier row\'s price, back to this site, bound to the account', async () => {
        await mpConfigure();
        const c = await mpSubscribe();
        assert.strictEqual(c.body.checkoutUrl, 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=pre_1');
        const create = calls[0];
        assert.deepStrictEqual([create.method, create.path, create.auth], ['POST', '/preapproval', `Bearer ${MP_TOKEN}`]);
        assert.deepStrictEqual(create.body.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 20000, currency_id: 'COP' });
        assert.strictEqual(create.body.payer_email, MEMBER.userEmail);
        assert.strictEqual(create.body.status, 'pending');
        assert.strictEqual(create.body.back_url, 'http://site.test/post?x=1&ms_provider=mercadopago', 'back to the page of this site the member was on');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'));
        const row = memberRow();
        assert.deepStrictEqual([row.source, row.status, row.provider_subscription_id, row.provider_customer_id], ['mercadopago', 'active', 'pre_1', '555']);
        // One subscription at a time.
        const again = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        assert.strictEqual(again.status, 409);
    });

    test('the return leg refuses a preapproval started by another account (no API call)', async () => {
        await mpConfigure();
        apiWill(() => ({ id: 'pre_1', status: 'pending', init_point: 'https://mp.test/x' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.basic.id } });
        const before = calls.length;
        const stolen = await plugin.call('get', '/me/confirm', { user: OTHER, query: { provider: 'mercadopago', preapproval_id: 'pre_1' } });
        assert.strictEqual(stolen.status, 404);
        assert.strictEqual(calls.length, before);
        assert.deepStrictEqual(await grantsOf(OTHER.id), ['members']);
    });
});

describe('Mercado Pago: x-signature', () => {
    beforeEach(async () => {
        await mpConfigure();
        apiWill(() => ({ id: 'pre_1', status: 'pending', init_point: 'https://mp.test/x' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.basic.id } });
    });

    test('a correctly signed notification is applied (state re-read from the API)', async () => {
        apiWill((call) => { assert.strictEqual(call.path, '/preapproval/pre_1'); return preapproval('authorized'); });
        const r = await mpNotify('subscription_preapproval', 'pre_1');
        assert.deepStrictEqual([r.status, r.body], [200, { received: true }]);
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'));
    });

    test('wrong secret, another data.id, stale or future ts, malformed or missing header: refused, nothing read or applied', async () => {
        const cases: Array<[string, any]> = [
            ['wrong secret', { secret: 'someothersecret0000000' }],
            ['signed for another id (tampered)', { signedId: 'pre_2' }],
            ['stale ts', { ts: Date.now() - 2 * 60 * 60 * 1000 }],
            ['future ts', { ts: Date.now() + 2 * 60 * 60 * 1000 }],
            ['malformed', { sign: 'ts=abc,v1=zz' }],
            ['missing', { sign: null }],
        ];
        for (const [label, opts] of cases) {
            const r = await mpNotify('subscription_preapproval', 'pre_1', opts);
            assert.strictEqual(r.status, 401, label);
        }
        assert.strictEqual(calls.length, 1, 'only the checkout call: no state was read for a refused notification');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
        assert.strictEqual(plugin.sdb.prepare(`SELECT COUNT(*) AS n FROM ${plugin.prefix}events`).get().n, 0);
    });

    test('ts in seconds is accepted too', async () => {
        apiWill(() => preapproval('authorized'));
        const r = await mpNotify('subscription_preapproval', 'pre_1', { ts: Math.floor(Date.now() / 1000) });
        assert.strictEqual(r.status, 200);
    });

    test('each notification (x-request-id) is processed once; live notifications are refused', async () => {
        apiWill(() => preapproval('authorized'));
        const first = await mpNotify('subscription_preapproval', 'pre_1', { requestId: 'req-fixed' });
        assert.deepStrictEqual(first.body, { received: true });
        const again = await mpNotify('subscription_preapproval', 'pre_1', { requestId: 'req-fixed' });
        assert.deepStrictEqual(again.body, { received: true, duplicate: true });
        assert.strictEqual(calls.length, 2, 'the duplicate read nothing');
        const live = await mpNotify('subscription_preapproval', 'pre_1', { live: true });
        assert.strictEqual(live.status, 400);
    });

    test('a preapproval that is not ours is acknowledged and ignored', async () => {
        apiWill(() => preapproval('authorized', { id: 'pre_foreign' }));
        const r = await mpNotify('subscription_preapproval', 'pre_foreign');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(memberRow(), undefined);
    });
});

describe('Mercado Pago: lifecycle', () => {
    test('authorized → tier change (granted with the next approved charge) → paused at period end keeps access → resumed → cancelled ends access', async () => {
        await mpConfigure();
        await mpSubscribe();
        const plusPre = (status: string) => preapproval(status, { auto_recurring: { transaction_amount: 50000, currency_id: 'COP' } });
        apiWill((call) => {
            assert.deepStrictEqual([call.method, call.path], ['PUT', '/preapproval/pre_1']);
            assert.deepStrictEqual(call.body.auto_recurring, { transaction_amount: 50000, currency_id: 'COP' });
            return plusPre('authorized');
        });
        const change = await plugin.call('post', '/me/change-tier', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        assert.deepStrictEqual([change.status, change.body.effective], [200, 'next-charge']);
        assert.ok(!(await grantsOf(MEMBER.id)).includes('tier:plus'), 'not before the new amount is charged');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'), 'the paid tier stays');
        assert.strictEqual((await plugin.call('get', '/me', { user: MEMBER })).body.member.pendingTier.slug, 'plus');
        apiWill(
            () => ({ id: 7100, preapproval_id: 'pre_1', status: 'processed', payment: { status: 'approved' } }),
            () => plusPre('authorized'),
        );
        await mpNotify('subscription_authorized_payment', '7100');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:plus'), 'granted with the first charge at its price');

        apiWill((call) => { assert.deepStrictEqual(call.body, { status: 'paused' }); return plusPre('paused'); });
        const cancel = await plugin.call('post', '/me/cancel', { user: MEMBER });
        assert.strictEqual(cancel.status, 200);
        let me = await plugin.call('get', '/me', { user: MEMBER });
        assert.deepStrictEqual([me.body.member.active, me.body.member.cancelAtPeriodEnd, me.body.member.provider], [true, true, 'mercadopago']);
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:plus'), 'access continues until the period ends');

        apiWill((call) => { assert.deepStrictEqual(call.body, { status: 'authorized' }); return plusPre('authorized'); });
        await plugin.call('post', '/me/resume', { user: MEMBER });
        me = await plugin.call('get', '/me', { user: MEMBER });
        assert.strictEqual(me.body.member.cancelAtPeriodEnd, false);

        apiWill(() => plusPre('cancelled'));
        await mpNotify('subscription_preapproval', 'pre_1');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
        assert.strictEqual(memberRow().status, 'canceled');
    });

    test('paused, then the period runs out with no charge → expired by the payments job', async () => {
        await mpConfigure();
        await mpSubscribe();
        apiWill(() => preapproval('paused'));
        await plugin.call('post', '/me/cancel', { user: MEMBER });
        setRow('current_period_end = ?', new Date(Date.now() - 4 * DAY).toISOString());
        const job = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(job.body.expired, 1);
        assert.strictEqual(memberRow().status, 'expired');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });

    test('a rejected recurring charge → past due (access kept while MP retries); an approved one → active', async () => {
        await mpConfigure();
        await mpSubscribe();
        apiWill(
            (call) => { assert.strictEqual(call.path, '/authorized_payments/7001'); return { id: 7001, preapproval_id: 'pre_1', status: 'recycling', payment: { status: 'rejected' } }; },
            () => preapproval('authorized'),
        );
        await mpNotify('subscription_authorized_payment', '7001');
        assert.strictEqual(memberRow().status, 'past_due');
        assert.ok((await grantsOf(MEMBER.id)).includes('paid'));
        apiWill(
            () => ({ id: 7002, preapproval_id: 'pre_1', status: 'processed', payment: { status: 'approved' } }),
            () => preapproval('authorized'),
        );
        await mpNotify('subscription_authorized_payment', '7002');
        assert.strictEqual(memberRow().status, 'active');
    });

    test('admin revoke cancels the preapproval at Mercado Pago', async () => {
        await mpConfigure();
        await mpSubscribe();
        apiWill((call) => { assert.deepStrictEqual([call.method, call.path, call.body], ['PUT', '/preapproval/pre_1', { status: 'cancelled' }]); return preapproval('cancelled'); });
        const r = await plugin.call('post', '/members/:id/revoke', { user: ADMIN, params: { id: String(memberRow().id) } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });
});

// ================================================================================================
// Wompi
// ================================================================================================

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function wompiConfigure() {
    const r = await plugin.call('post', '/config', { user: ADMIN, body: { paymentProvider: 'wompi', currencyCode: 'cop', currencySymbol: '$', credentials: { wompi: WOMPI } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
}

/** A Wompi event, signed the way Wompi signs it (values of signature.properties + timestamp + secret). */
function wompiEvent(event: string, data: any, opts: { secret?: string; timestamp?: number; environment?: string; props?: string[] } = {}) {
    const props = opts.props || (event === 'transaction.updated'
        ? ['transaction.id', 'transaction.status', 'transaction.amount_in_cents']
        : ['nequi_token.id', 'nequi_token.status']);
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const values = props.map((p) => p.split('.').reduce((o: any, k) => (o == null ? o : o[k]), data)).join('');
    const checksum = sha256(`${values}${timestamp}${opts.secret || WOMPI.eventsSecret}`);
    return { event, data, environment: opts.environment || 'test', signature: { properties: props, checksum }, timestamp, sent_at: new Date().toISOString() };
}
const wompiDeliver = (ev: any, opts: { header?: string | null; mutate?: (e: any) => void } = {}) => {
    // Wompi holds the event's object as it was signed (a tampered copy in transit changes nothing there).
    const obj = ev.data && (ev.data.transaction || ev.data.nequi_token);
    if (obj && obj.id) wompiState.set(String(obj.id), JSON.parse(JSON.stringify(obj)));
    const e = JSON.parse(JSON.stringify(ev));
    if (opts.mutate) opts.mutate(e);
    const header = opts.header === null ? undefined : (opts.header || ev.signature.checksum);
    return plugin.call('post', '/wompi/webhook', { body: e, rawBody: JSON.stringify(e), headers: header ? { 'x-event-checksum': header } : {} });
};

/** Start a Web Checkout for `tier` and return its reference (from the URL the member is sent to). */
async function wompiCheckout(tier: any, user = MEMBER) {
    const c = await plugin.call('post', '/checkout', { user, body: { tier_id: tier.id, page_url: 'http://site.test/club?a=1' } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const url = new URL(c.body.checkoutUrl);
    return { url, reference: url.searchParams.get('reference')! };
}
const txn = (id: string, reference: string, status: string, cents = BASIC_CENTS, extra: any = {}) =>
    ({ id, reference, status, amount_in_cents: cents, currency: 'COP', customer_email: MEMBER.userEmail, payment_method_type: 'PSE', ...extra });

async function wompiPayPeriod(tier = tiers.basic, id = 'txn_1') {
    const { reference } = await wompiCheckout(tier);
    apiWill((call) => { assert.deepStrictEqual([call.method, call.path], ['GET', `/v1/transactions/${id}`]); return { data: txn(id, reference, 'APPROVED', tier.price_cents) }; });
    const r = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'wompi', id } });
    assert.deepStrictEqual([r.status, r.body], [200, { active: true }]);
    return reference;
}

describe('Wompi: configuration and Web Checkout', () => {
    test('sandbox keys only; COP only; masked in the admin', async () => {
        for (const bad of [{ publicKey: 'pub_prod_x' }, { privateKey: 'prv_prod_x' }, { eventsSecret: 'prod_events_x' }, { integritySecret: 'prod_integrity_x' }]) {
            const r = await plugin.call('post', '/config', { user: ADMIN, body: { credentials: { wompi: bad } } });
            assert.strictEqual(r.status, 400, JSON.stringify(bad));
        }
        const usd = await plugin.call('post', '/config', { user: ADMIN, body: { paymentProvider: 'wompi', currencyCode: 'usd' } });
        assert.strictEqual(usd.status, 400, 'Wompi charges COP only');
        const cfg = await wompiConfigure();
        const w = cfg.providers.find((p: any) => p.id === 'wompi');
        assert.deepStrictEqual([w.ready, w.mode, w.currencies], [true, 'test', ['cop']]);
        for (const v of Object.values(WOMPI)) assert.ok(!JSON.stringify(cfg).includes(v), 'never echoed back');
    });

    test('the checkout URL: COP, the tier row\'s amount, the integrity signature, the return on this site', async () => {
        await wompiConfigure();
        const { url, reference } = await wompiCheckout(tiers.basic);
        assert.strictEqual(url.origin + url.pathname, 'https://checkout.wompi.co/p/');
        assert.strictEqual(url.searchParams.get('public-key'), WOMPI.publicKey);
        assert.strictEqual(url.searchParams.get('currency'), 'COP');
        assert.strictEqual(url.searchParams.get('amount-in-cents'), String(BASIC_CENTS));
        assert.match(reference, new RegExp(`^wjm_period_${MEMBER.id}_${tiers.basic.id}_[0-9a-f]+$`));
        assert.strictEqual(url.searchParams.get('signature:integrity'), sha256(`${reference}${BASIC_CENTS}COP${WOMPI.integritySecret}`));
        assert.strictEqual(url.searchParams.get('redirect-url'), 'http://site.test/club?a=1&ms_provider=wompi');
        assert.strictEqual(url.searchParams.get('customer-data:email'), MEMBER.userEmail);
        assert.strictEqual(calls.length, 0, 'the checkout itself needs no API call');
        assert.ok(!url.toString().includes(WOMPI.privateKey) && !url.toString().includes(WOMPI.integritySecret));
    });
});

describe('Wompi: return leg and events', () => {
    beforeEach(wompiConfigure);

    test('an approved payment opens one period of the tier', async () => {
        await wompiPayPeriod();
        const row = memberRow();
        assert.deepStrictEqual([row.source, row.status, row.tier_id], ['wompi', 'active', tiers.basic.id]);
        const end = Date.parse(row.current_period_end);
        assert.ok(end > Date.now() + 27 * DAY && end < Date.now() + 32 * DAY, 'one month');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'));
    });

    test('the return leg refuses another account\'s transaction, a wrong amount and a non-COP currency', async () => {
        const { reference } = await wompiCheckout(tiers.basic);
        apiWill(() => ({ data: txn('txn_x', reference, 'APPROVED') }));
        const stolen = await plugin.call('get', '/me/confirm', { user: OTHER, query: { provider: 'wompi', id: 'txn_x' } });
        assert.strictEqual(stolen.status, 404);
        apiWill(() => ({ data: txn('txn_x', reference, 'APPROVED', 100) }));
        const cheap = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'wompi', id: 'txn_x' } });
        assert.deepStrictEqual(cheap.body, { active: false });
        apiWill(() => ({ data: txn('txn_x', reference, 'APPROVED', BASIC_CENTS, { currency: 'USD' }) }));
        const usd = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'wompi', id: 'txn_x' } });
        assert.deepStrictEqual(usd.body, { active: false });
        assert.strictEqual(memberRow(), undefined);
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });

    test('a correctly signed event is applied; the return leg and the event for the same payment count once', async () => {
        const { reference } = await wompiCheckout(tiers.basic);
        const ev = wompiEvent('transaction.updated', { transaction: txn('txn_e', reference, 'APPROVED') });
        const r = await wompiDeliver(ev);
        assert.deepStrictEqual([r.status, r.body], [200, { received: true }]);
        const end1 = memberRow().current_period_end;
        const dup = await wompiDeliver(ev);
        assert.deepStrictEqual(dup.body, { received: true, duplicate: true });
        apiWill(() => ({ data: txn('txn_e', reference, 'APPROVED') }));
        await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'wompi', id: 'txn_e' } });
        assert.strictEqual(memberRow().current_period_end, end1, 'the period was not extended twice');
    });

    test('wrong secret, tampered data, stale timestamp, header mismatch, missing properties, production: refused', async () => {
        const { reference } = await wompiCheckout(tiers.basic);
        const data = { transaction: txn('txn_t', reference, 'APPROVED') };
        const cases: Array<[string, any, any]> = [
            ['wrong secret', wompiEvent('transaction.updated', data, { secret: 'test_events_other' }), {}],
            ['tampered status', wompiEvent('transaction.updated', { transaction: txn('txn_t', reference, 'DECLINED') }), { mutate: (e: any) => { e.data.transaction.status = 'APPROVED'; } }],
            ['tampered amount', wompiEvent('transaction.updated', data), { mutate: (e: any) => { e.data.transaction.amount_in_cents = 1; } }],
            ['stale timestamp', wompiEvent('transaction.updated', data, { timestamp: Math.floor(Date.now() / 1000) - 27 * 3600 }), {}],
            ['header mismatch', wompiEvent('transaction.updated', data), { header: 'f'.repeat(64) }],
            ['no properties', wompiEvent('transaction.updated', data, { props: [] }), {}],
            ['production event', wompiEvent('transaction.updated', data, { environment: 'prod' }), {}],
        ];
        for (const [label, ev, opts] of cases) {
            const r = await wompiDeliver(ev, opts);
            assert.strictEqual(r.status, 400, label);
        }
        assert.strictEqual(memberRow(), undefined, 'nothing applied');
        assert.strictEqual(plugin.sdb.prepare(`SELECT COUNT(*) AS n FROM ${plugin.prefix}events`).get().n, 0);
        // The header is optional (the body checksum is what Wompi documents); a valid body alone is accepted.
        const ok = await wompiDeliver(wompiEvent('transaction.updated', data), { header: null });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(memberRow().status, 'active');
    });

    test('paying again while a period runs prepays the next one (from the current end, not from today)', async () => {
        await wompiPayPeriod(tiers.basic, 'txn_1');
        const end1 = Date.parse(memberRow().current_period_end);
        const me = await plugin.call('get', '/me', { user: MEMBER });
        assert.deepStrictEqual([me.body.member.canRenewNow, me.body.member.canManageBilling], [true, true]);
        await wompiPayPeriod(tiers.basic, 'txn_2');
        const end2 = Date.parse(memberRow().current_period_end);
        assert.ok(end2 - end1 > 27 * DAY && end2 - end1 < 32 * DAY, 'stacked on the running period');
    });

    test('lifecycle: paid → cancel (no renewal) → period over → expired; a declined one-off payment changes nothing', async () => {
        const { reference } = await wompiCheckout(tiers.basic);
        await wompiDeliver(wompiEvent('transaction.updated', { transaction: txn('txn_d', reference, 'DECLINED') }));
        assert.strictEqual(memberRow(), undefined, 'a declined first payment opens nothing');
        await wompiPayPeriod();
        const cancel = await plugin.call('post', '/me/cancel', { user: MEMBER });
        assert.strictEqual(cancel.status, 200);
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'), 'access until the paid period ends');
        setRow('current_period_end = ?', new Date(Date.now() - 4 * DAY).toISOString());
        const job = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.deepStrictEqual([job.body.renewed, job.body.expired], [0, 1]);
        assert.strictEqual(memberRow().status, 'expired');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });
});

describe('Wompi: automatic renewal with Nequi', () => {
    beforeEach(wompiConfigure);

    /** Link a Nequi account: token requested, approved in the app, payment source created. */
    async function linkNequi() {
        const bad = await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '12345' } });
        assert.strictEqual(bad.status, 400);
        apiWill((call) => {
            assert.deepStrictEqual([call.method, call.path, call.body, call.auth], ['POST', '/v1/tokens/nequi', { phone_number: '3001234567' }, `Bearer ${WOMPI.publicKey}`]);
            return { data: { id: 'nequi_tok_1', status: 'PENDING' } };
        });
        const start = await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '300 123 4567' } });
        assert.deepStrictEqual(start.body, { state: 'pending' });
        apiWill(() => ({ data: { id: 'nequi_tok_1', status: 'PENDING' } }));
        let me = await plugin.call('get', '/me', { user: MEMBER });
        assert.deepStrictEqual(me.body.member.autoRenew, { method: 'nequi', state: 'pending' });
        apiWill(
            () => ({ data: { id: 'nequi_tok_1', status: 'APPROVED' } }),
            (call) => { assert.strictEqual(call.path, `/v1/merchants/${WOMPI.publicKey}`); return { data: { presigned_acceptance: { acceptance_token: 'acc_tok' }, presigned_personal_data_auth: { acceptance_token: 'pers_tok' } } }; },
            (call) => {
                assert.deepStrictEqual([call.method, call.path, call.auth], ['POST', '/v1/payment_sources', `Bearer ${WOMPI.privateKey}`]);
                assert.deepStrictEqual(call.body, { type: 'NEQUI', token: 'nequi_tok_1', customer_email: MEMBER.userEmail, acceptance_token: 'acc_tok', accept_personal_auth: 'pers_tok' });
                return { data: { id: 3891, status: 'AVAILABLE' } };
            },
        );
        me = await plugin.call('get', '/me', { user: MEMBER });
        assert.deepStrictEqual(me.body.member.autoRenew, { method: 'nequi', state: 'active' });
        assert.strictEqual(memberRow().provider_payment_source, 'source:3891');
    }

    /** Make the period end in an hour, run the job, return the renewal charge it sent. */
    async function renewNow(reply: (call: Call) => any) {
        setRow('current_period_end = ?', new Date(Date.now() + 60 * 60 * 1000).toISOString());
        let sent: Call | null = null;
        apiWill((call) => { sent = call; return reply(call); });
        const job = await plugin.call('post', '/payments/process', { user: ADMIN });
        return { job: job.body, sent: sent as unknown as Call };
    }

    test('the job charges the payment source a day before the period ends; the approval extends it once', async () => {
        await wompiPayPeriod();
        await linkNequi();
        // Not due yet: nothing is charged.
        const early = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(early.body.renewed, 0);
        const { job, sent } = await renewNow((call) => ({ data: { id: 'txn_r1', status: 'PENDING', reference: call.body.reference, amount_in_cents: call.body.amount_in_cents, currency: 'COP' } }));
        assert.strictEqual(job.renewed, 1);
        assert.deepStrictEqual([sent.method, sent.path, sent.auth], ['POST', '/v1/transactions', `Bearer ${WOMPI.privateKey}`]);
        assert.strictEqual(sent.body.amount_in_cents, BASIC_CENTS);
        assert.strictEqual(sent.body.currency, 'COP');
        assert.strictEqual(sent.body.payment_source_id, 3891);
        assert.strictEqual(sent.body.signature, sha256(`${sent.body.reference}${BASIC_CENTS}COP${WOMPI.integritySecret}`));
        // While the charge waits for its event, the job does not charge again.
        const waiting = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(waiting.body.renewed, 0);
        const before = Date.parse(memberRow().current_period_end);
        const ev = wompiEvent('transaction.updated', { transaction: txn('txn_r1', sent.body.reference, 'APPROVED') });
        await wompiDeliver(ev);
        await wompiDeliver(ev);
        const after = Date.parse(memberRow().current_period_end);
        assert.ok(after - before > 27 * DAY && after - before < 32 * DAY, 'extended by exactly one period');
    });

    test('declined renewals: past due with access, a daily retry, cancelled after the third', async () => {
        await wompiPayPeriod();
        await linkNequi();
        for (let attempt = 1; attempt <= 3; attempt++) {
            const { sent } = await renewNow((call) => ({ data: { id: `txn_dec${attempt}`, status: 'PENDING', reference: call.body.reference } }));
            await wompiDeliver(wompiEvent('transaction.updated', { transaction: txn(`txn_dec${attempt}`, sent.body.reference, 'DECLINED') }));
            const row = memberRow();
            assert.strictEqual(row.renew_attempts, attempt);
            if (attempt < 3) {
                assert.strictEqual(row.status, 'past_due');
                assert.ok((await grantsOf(MEMBER.id)).includes('paid'), 'past due keeps access');
                const sameDay = await plugin.call('post', '/payments/process', { user: ADMIN });
                assert.strictEqual(sameDay.body.renewed, 0, 'no second charge the same day');
                plugin.sdb.prepare(`UPDATE ${plugin.prefix}checkouts SET created_at = datetime('now', '-2 days') WHERE kind = 'renewal'`).run();
            } else {
                assert.strictEqual(row.status, 'canceled');
                assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
            }
        }
    });

    test('a tier change applies at the next period: the renewal charges the new tier\'s price', async () => {
        await wompiPayPeriod();
        await linkNequi();
        const change = await plugin.call('post', '/me/change-tier', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        assert.deepStrictEqual([change.status, change.body.effective], [200, 'next-period']);
        assert.ok(!(await grantsOf(MEMBER.id)).includes('tier:plus'), 'not before it is paid');
        const me = await plugin.call('get', '/me', { user: MEMBER });
        assert.strictEqual(me.body.member.pendingTier.slug, 'plus');
        const { sent } = await renewNow((call) => ({ data: { id: 'txn_up', status: 'PENDING', reference: call.body.reference } }));
        assert.strictEqual(sent.body.amount_in_cents, PLUS_CENTS);
        await wompiDeliver(wompiEvent('transaction.updated', { transaction: txn('txn_up', sent.body.reference, 'APPROVED', PLUS_CENTS) }));
        assert.strictEqual(memberRow().tier_id, tiers.plus.id);
        assert.strictEqual(memberRow().pending_tier_id, null);
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:plus'));
    });

    test('cancel at period end stops renewals; stopping auto-renew drops the source; revoke ends access', async () => {
        await wompiPayPeriod();
        await linkNequi();
        await plugin.call('post', '/me/cancel', { user: MEMBER });
        setRow('current_period_end = ?', new Date(Date.now() + 60 * 60 * 1000).toISOString());
        const job = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(job.body.renewed, 0, 'no charge after the member cancelled');
        await plugin.call('post', '/me/resume', { user: MEMBER });
        await plugin.call('post', '/me/auto-renew/stop', { user: MEMBER });
        assert.strictEqual(memberRow().provider_payment_source, null);
        const r = await plugin.call('post', '/members/:id/revoke', { user: ADMIN, params: { id: String(memberRow().id) } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(memberRow().status, 'canceled');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });

    test('a Nequi token event: approved attaches the source, declined drops the request', async () => {
        await wompiPayPeriod();
        apiWill(() => ({ data: { id: 'nequi_tok_2', status: 'PENDING' } }));
        await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '3109876543' } });
        apiWill(
            () => ({ data: { presigned_acceptance: { acceptance_token: 'acc' } } }),
            () => ({ data: { id: 4000 } }),
        );
        const ok = await wompiDeliver(wompiEvent('nequi_token.updated', { nequi_token: { id: 'nequi_tok_2', status: 'APPROVED' } }));
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(memberRow().provider_payment_source, 'source:4000');
        await plugin.call('post', '/me/auto-renew/stop', { user: MEMBER });
        apiWill(() => ({ data: { id: 'nequi_tok_3', status: 'PENDING' } }));
        await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '3109876543' } });
        await wompiDeliver(wompiEvent('nequi_token.updated', { nequi_token: { id: 'nequi_tok_3', status: 'DECLINED' } }));
        assert.strictEqual(memberRow().provider_payment_source, null);
    });
});

describe('switching providers', () => {
    test('an account that pays with Wompi cannot be sold a Mercado Pago subscription on top', async () => {
        await wompiConfigure();
        await wompiPayPeriod();
        await mpConfigure();
        // The Wompi period still runs; MP would double-charge.
        const r = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        assert.strictEqual(r.status, 409);
    });
});

describe('Mercado Pago: amounts and duplicates (second audit)', () => {
    beforeEach(mpConfigure);

    test('a preapproval that charges another amount or currency than the one created opens nothing', async () => {
        apiWill(() => ({ id: 'pre_1', status: 'pending', init_point: 'https://mp.test/x' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        apiWill(() => preapproval('authorized', { auto_recurring: { transaction_amount: BASIC_CENTS / 100, currency_id: 'COP' } }));
        const cheap = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'mercadopago', preapproval_id: 'pre_1' } });
        assert.deepStrictEqual(cheap.body, { active: false }, 'Plus checkout, Basic amount');
        assert.ok(!(await grantsOf(MEMBER.id)).includes('paid'));
        apiWill(() => preapproval('authorized', { auto_recurring: { transaction_amount: PLUS_CENTS / 100, currency_id: 'USD' } }));
        const usd = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'mercadopago', preapproval_id: 'pre_1' } });
        assert.deepStrictEqual(usd.body, { active: false }, 'another currency');
        apiWill(() => preapproval('authorized', { auto_recurring: { transaction_amount: PLUS_CENTS / 100, currency_id: 'COP' } }));
        const ok = await plugin.call('get', '/me/confirm', { user: MEMBER, query: { provider: 'mercadopago', preapproval_id: 'pre_1' } });
        assert.deepStrictEqual(ok.body, { active: true }, 'positive control');
    });

    test('currencies without cents are charged in whole units', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { currencyCode: 'clp' } });
        const t = await plugin.call('post', '/tiers', { user: ADMIN, body: { name: 'Chile', price_cents: 990050 } });
        apiWill(() => ({ id: 'pre_cl', status: 'pending', init_point: 'https://mp.test/x' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: t.body.tier.id } });
        assert.deepStrictEqual(calls[0].body.auto_recurring.transaction_amount, 9901);
        assert.strictEqual(calls[0].body.auto_recurring.currency_id, 'CLP');
    });

    test('a new checkout cancels the account\'s earlier preapproval that was never authorised', async () => {
        apiWill(() => ({ id: 'pre_old', status: 'pending', init_point: 'https://mp.test/1' }));
        await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.basic.id } });
        calls = [];
        apiWill(
            (call) => { assert.deepStrictEqual([call.method, call.path, call.body], ['PUT', '/preapproval/pre_old', { status: 'cancelled' }]); return preapproval('cancelled', { id: 'pre_old' }); },
            () => ({ id: 'pre_new', status: 'pending', init_point: 'https://mp.test/2' }),
        );
        const r = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.plus.id } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /preapproval/pre_old', 'POST /preapproval']);
    });

    test('a declined first charge does not give a free month: past due opens 3 days at most', async () => {
        await mpSubscribe();
        apiWill(
            () => ({ id: 7200, preapproval_id: 'pre_1', status: 'recycling', payment: { status: 'rejected' } }),
            () => preapproval('authorized'),
        );
        await mpNotify('subscription_authorized_payment', '7200');
        assert.ok((await grantsOf(MEMBER.id)).includes('paid'), 'within 3 days');
        setRow('past_due_since = ?', new Date(Date.now() - 4 * DAY).toISOString());
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });
});

describe('Wompi: charges, events and periods (second audit)', () => {
    beforeEach(wompiConfigure);

    test('without the events secret Wompi is not offered (no result of a charge could be verified)', async () => {
        await plugin.call('post', '/config', { user: ADMIN, body: { credentials: { wompi: { eventsSecret: '' } } } });
        const pub = await plugin.call('get', '/public/tiers', {});
        assert.strictEqual(pub.body.paymentsEnabled, false);
        const r = await plugin.call('post', '/checkout', { user: MEMBER, body: { tier_id: tiers.basic.id } });
        assert.strictEqual(r.status, 400);
    });

    test('the transaction applied is re-read from Wompi, and the event must sign its id, status and amount', async () => {
        const { reference } = await wompiCheckout(tiers.basic);
        // Signed, but only over the id: the rest of the body is anyone's to write.
        const weak = wompiEvent('transaction.updated', { transaction: txn('txn_w', reference, 'APPROVED') }, { props: ['transaction.id'] });
        assert.strictEqual((await wompiDeliver(weak)).status, 400);
        // Properly signed APPROVED, while Wompi itself says DECLINED: Wompi wins.
        const ev = wompiEvent('transaction.updated', { transaction: txn('txn_v', reference, 'APPROVED') });
        wompiState.set('txn_v', txn('txn_v', reference, 'DECLINED'));
        const r = await plugin.call('post', '/wompi/webhook', { body: ev, rawBody: JSON.stringify(ev), headers: {} });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(memberRow(), undefined, 'nothing opened');
        assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/v1/transactions/txn_v'));
    });

    test('a voided payment takes its period back', async () => {
        const reference = await wompiPayPeriod(tiers.basic, 'txn_void');
        assert.ok((await grantsOf(MEMBER.id)).includes('tier:basic'));
        await wompiDeliver(wompiEvent('transaction.updated', { transaction: txn('txn_void', reference, 'VOIDED') }));
        assert.strictEqual(memberRow().status, 'expired');
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
    });

    test('a period paid without automatic renewal ends at its end (no grace: nothing is being collected)', async () => {
        await wompiPayPeriod();
        setRow('current_period_end = ?', new Date(Date.now() - 60 * 60 * 1000).toISOString());
        assert.deepStrictEqual(await grantsOf(MEMBER.id), ['members']);
        setRow("current_period_end = ?, provider_payment_source = 'source:1'", new Date(Date.now() - 60 * 60 * 1000).toISOString());
        assert.ok((await grantsOf(MEMBER.id)).includes('paid'), 'with automatic renewal the charge may still be on its way');
    });

    test('renewals: two runs at once charge once; a charge in flight is asked about, never made again', async () => {
        await wompiPayPeriod();
        setRow("provider_payment_source = 'source:3891', current_period_end = ?", new Date(Date.now() + 60 * 60 * 1000).toISOString());
        let charges = 0;
        apiWill((call) => { charges++; return { data: { id: 'txn_once', status: 'PENDING', reference: call.body.reference, amount_in_cents: call.body.amount_in_cents, currency: 'COP' } }; });
        const both = await Promise.all([1, 2].map(() => plugin.call('post', '/payments/process', { user: ADMIN })));
        assert.strictEqual(charges, 1, 'one charge for two simultaneous runs');
        assert.deepStrictEqual(both.map((r) => r.body.renewed), [1, 1], 'the second run shares the first');
        // A day later its result has still not arrived: the job ASKS (GET), it does not charge again.
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}checkouts SET created_at = datetime('now', '-2 days') WHERE kind = 'renewal'`).run();
        calls = [];
        const later = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(later.body.renewed, 0);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/transactions/txn_once']);
        // Another server already claimed this period's charge (its row exists): this one does not charge.
        wompiState.set('txn_once', { ...wompiState.get('txn_once'), status: 'DECLINED' });
        await plugin.call('post', '/payments/process', { user: ADMIN });
        const m = memberRow();
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}checkouts SET created_at = datetime('now', '-2 days') WHERE kind = 'renewal'`).run();
        const end = Math.floor(Date.parse(m.current_period_end) / 1000);
        plugin.sdb.prepare(`INSERT INTO ${plugin.prefix}checkouts (user_id, tier_id, provider, kind, reference, amount_cents, currency, status) VALUES (?, ?, 'wompi', 'renewal', ?, ?, 'cop', 'complete')`)
            .run(MEMBER.id, tiers.basic.id, `wjm_renewal_${MEMBER.id}_${end}_${m.renew_attempts}`, BASIC_CENTS);
        plugin.sdb.prepare(`UPDATE ${plugin.prefix}checkouts SET created_at = datetime('now', '-2 days') WHERE kind = 'renewal'`).run();
        calls = [];
        const claimed = await plugin.call('post', '/payments/process', { user: ADMIN });
        assert.strictEqual(claimed.body.renewed, 0);
        assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/v1/transactions'), 'no second charge for a claimed period');
    });

    test('Nequi approval requests: a few per account per hour', async () => {
        await wompiPayPeriod();
        for (let i = 0; i < 3; i++) {
            apiWill(() => ({ data: { id: `nequi_tok_r${i}`, status: 'PENDING' } }));
            const r = await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '3001234567' } });
            assert.strictEqual(r.status, 200, `request ${i + 1}`);
        }
        const fourth = await plugin.call('post', '/me/auto-renew/nequi', { user: MEMBER, body: { phone: '3001234567' } });
        assert.strictEqual(fourth.status, 429);
    });
});
