/**
 * Payment and public-form hardening for the first-party marketplace plugins.
 *
 * Each case boots the REAL plugin entry (marketplace/plugins/<slug>/index.js) through the shared
 * harness in ./fixtures/marketplace-plugin-harness — in-memory SQLite plus the host's real SQL guard.
 *
 *  - Stripe amounts (online-store, donations, restaurant-menu): a zero-decimal currency (JPY, KRW,
 *    CLP…) takes the amount in whole units; donations and restaurant-menu sent the stored cents as is,
 *    so a ¥1,500 charge became ¥150,000. MUTATION PROOF: send `amountCents` / `totalCents` raw again.
 *    online-store already converted, so its case passes on the code before this fix too: it guards
 *    that conversion — send `total` raw in its checkout and the case fails ("charged 150000").
 *  - Stripe return URLs (same three): success_url / cancel_url follow the visitor's page only when it
 *    is on this site; any other http(s) page_url turned the checkout into a redirect off-site.
 *    MUTATION PROOF: accept any /^https?:/ page_url again.
 *  - event-tickets: a paid order holds its seats only once the buyer types the code mailed to the
 *    address; verified unpaid orders may hold at most `pendingHoldPercent` of a type; unpaid orders do
 *    not count in the site-wide order window. MUTATION PROOF: claim the seats when the order is placed.
 *  - auctions: a bid may raise the price by at most `max_bid_jump_percent`; bidders prove their address
 *    with a mailed code (or sign in, per `bid_verification`); a client's first bid in its window is not
 *    held to the shared per-auction and site-wide windows. MUTATION PROOF: drop the jump cap, the
 *    bidderProven() gate, or the firstInWindow exemption.
 *  - visitor text in mail: the mails the anonymous forms send to an unverified address (online-store,
 *    donations, event-tickets, bookings, newsletter, auctions' outbid notice) carry only the site's own
 *    text — never the name the visitor typed — and are bounded per recipient address.
 *    MUTATION PROOF: put the name back into a mail, or drop its mailBudget() check.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, BootedPlugin } from './fixtures/marketplace-plugin-harness';

after(async () => {
    // plugin-api pulls in core/cache, which may hold a Redis handle (see f6-plugin-compatibility).
    try {
        const cache = require('../core/cache');
        if (cache && typeof cache.closeAll === 'function') await cache.closeAll();
    } catch { /* never loaded */ }
});

async function withPlugin(slug: string, fn: (p: BootedPlugin) => Promise<void>) {
    const p = await bootPlugin(slug);
    try { await fn(p); } finally { p.close(); }
}

/** Run `fn` with Date.now() shifted forward, so window-based limits in the plugin see time pass. */
async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const real = Date.now;
    Date.now = () => real() + ms;
    try { return await fn(); } finally { Date.now = real; }
}

/** Answer every Stripe call with a fresh Checkout Session and record the forms sent. */
async function captureStripe<T>(fn: () => Promise<T>): Promise<{ result: T; forms: URLSearchParams[] }> {
    const real = globalThis.fetch;
    const forms: URLSearchParams[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
        if (init && init.body) forms.push(new URLSearchParams(String(init.body)));
        return { ok: true, status: 200, json: async () => ({ id: 'cs_test_12345678', url: 'https://checkout.stripe.test/s' }) };
    };
    try { return { result: await fn(), forms }; } finally { (globalThis as any).fetch = real; }
}

const NAME_PAYLOAD = 'Mallory <a href="https://evil.example/login">Sign in</a>';
/** The mail carries none of what the visitor typed as their name (raw or escaped). */
function assertNoVisitorName(m: { text?: string; html?: string; subject: string }, label: string) {
    const all = `${m.subject}\n${m.text || ''}\n${m.html || ''}`;
    assert.ok(!all.includes('Mallory') && !all.includes('evil.example'), `${label} carried the visitor's name:\n${all}`);
}

// ================================== Stripe Checkout plugins ===================================

interface StripePlugin {
    slug: string;
    seed: (p: BootedPlugin, currencyCode: string) => void;
    /** Start a card payment from `pageUrl`; resolves to the plugin's reply. */
    pay: (p: BootedPlugin, client: string, pageUrl: string) => Promise<{ status: number; body: any }>;
    /** What the visitor is charged, in the plugin's integer cents. */
    cents: number;
}

const STRIPE_PLUGINS: StripePlugin[] = [
    {
        slug: 'online-store',
        seed: (p, currencyCode) => {
            p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, stock, is_published) VALUES ('Tee', 'tee', 150000, -1, 1)`).run();
            p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES ('stripe_sk', 'sk_test_secret')`).run();
            p.options.set('online_store_config', { currencyCode });
        },
        pay: (p, client, pageUrl) => p.call('post', '/public/checkout', {
            clientKey: client,
            body: { customer: { name: 'Ana', email: `${client}@x.io` }, items: [{ product_id: 1, qty: 1 }], payment_method: 'stripe', page_url: pageUrl },
        }),
        cents: 150000,
    },
    {
        slug: 'donations',
        seed: (p, currencyCode) => {
            p.sdb.prepare(`INSERT INTO ${p.prefix}campaigns (title, slug, goal_cents, is_active) VALUES ('Roof', 'roof', 10000000, 1)`).run();
            p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES ('stripe_sk', 'sk_test_secret')`).run();
            p.options.set('donations_config', { currencyCode });
        },
        pay: (p, client, pageUrl) => p.call('post', '/public/donate', {
            clientKey: client,
            body: { campaign_id: 1, amount_cents: 150000, donor_name: 'Ana', donor_email: `${client}@x.io`, payment_method: 'stripe', elapsed: 5000, page_url: pageUrl },
        }),
        cents: 150000,
    },
    {
        slug: 'restaurant-menu',
        seed: (p, currencyCode) => {
            p.options.set('restaurant_menu_config', { orderingEnabled: true, payOnlineEnabled: true, currencyCode });
            p.sdb.prepare(`INSERT INTO ${p.prefix}sections (name, is_active) VALUES ('Mains', 1)`).run();
            p.sdb.prepare(`INSERT INTO ${p.prefix}items (section_id, name, price_cents, is_available) VALUES (1, 'Ramen', 150000, 1)`).run();
            p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES ('stripe_sk', 'sk_test_secret')`).run();
        },
        pay: (p, client, pageUrl) => p.call('post', '/public/order', {
            clientKey: client,
            body: { customer_name: 'Ana', customer_phone: '+81 90 0000 0000', delivery_type: 'pickup', payment_method: 'stripe', items: [{ item_id: 1, qty: 1 }], page_url: pageUrl },
        }),
        cents: 150000,
    },
];

for (const sp of STRIPE_PLUGINS) {
    test(`${sp.slug}: a zero-decimal currency is charged in whole units, a two-decimal one in cents`, async () => {
        for (const [currency, expected] of [['jpy', sp.cents / 100], ['krw', sp.cents / 100], ['usd', sp.cents], ['eur', sp.cents]] as Array<[string, number]>) {
            await withPlugin(sp.slug, async (p) => {
                sp.seed(p, currency);
                const { result, forms } = await captureStripe(() => sp.pay(p, 'buyer', 'http://site.test/pay'));
                assert.strictEqual(result.status, 200, JSON.stringify(result.body));
                assert.strictEqual(result.body.checkoutUrl, 'https://checkout.stripe.test/s', JSON.stringify(result.body));
                const session = forms.find((f) => f.get('mode') === 'payment')!;
                assert.strictEqual(session.get('line_items[0][price_data][currency]'), currency);
                assert.strictEqual(session.get('line_items[0][price_data][unit_amount]'), String(expected),
                    `${currency}: charged ${session.get('line_items[0][price_data][unit_amount]')} for ${sp.cents} cents`);
            });
        }
    });

    test(`${sp.slug}: the Stripe Checkout returns only to a page on this site`, async () => {
        await withPlugin(sp.slug, async (p) => {
            sp.seed(p, 'usd');
            const cases: Array<[string, string | null]> = [
                ['https://evil.example/landing', null],
                ['http://site.test.evil.example/pay', null],
                ['http://site.test@evil.example/pay', null],
                ['//evil.example/pay', null],
                ['javascript:alert(1)', null],
                ['http://site.test/pay?ref=a', 'http://site.test/pay?ref=a'],
            ];
            let n = 0;
            for (const [pageUrl, kept] of cases) {
                const { result, forms } = await captureStripe(() => sp.pay(p, `buyer${n++}`, pageUrl));
                assert.strictEqual(result.status, 200, `${pageUrl}: ${JSON.stringify(result.body)}`);
                const session = forms.find((f) => f.get('mode') === 'payment')!;
                for (const field of ['success_url', 'cancel_url']) {
                    const url = new URL(String(session.get(field)));
                    assert.strictEqual(url.origin, 'http://site.test', `${pageUrl}: ${field} left the site: ${session.get(field)}`);
                }
                if (kept) assert.strictEqual(session.get('cancel_url'), kept, `${pageUrl}: an on-site page is kept`);
                else assert.strictEqual(new URL(String(session.get('cancel_url'))).pathname, '/', `${pageUrl}: falls back to the site`);
            }
        });
    });
}

test('donations: a zero-decimal donation records the whole amount it charges', async () => {
    await withPlugin('donations', async (p) => {
        STRIPE_PLUGINS[1].seed(p, 'jpy');
        const { result, forms } = await captureStripe(() => p.call('post', '/public/donate', {
            clientKey: 'odd', body: { campaign_id: 1, amount_cents: 150050, donor_name: 'Ana', donor_email: 'odd@x.io', payment_method: 'stripe', elapsed: 5000 },
        }));
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(forms[0].get('line_items[0][price_data][unit_amount]'), '1501');
        assert.strictEqual(p.sdb.prepare(`SELECT amount_cents FROM ${p.prefix}donations`).get().amount_cents, 150100);
    });
});

// ================================== event-tickets =============================================

function seedTicketEvent(p: BootedPlugin, capacity: number) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}events (title, starts_at, is_published, created_at) VALUES ('Gala', ?, 1, ?)`)
        .run(new Date(Date.now() + 7 * 86400e3).toISOString(), new Date().toISOString());
    p.sdb.prepare(`INSERT INTO ${p.prefix}ticket_types (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (1, 'Paid', 1000, ?, 0, '', 1)`).run(capacity);
    p.sdb.prepare(`INSERT INTO ${p.prefix}ticket_types (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (1, 'Free', 0, 100, 0, '', 1)`).run();
}
const placeTickets = (p: BootedPlugin, client: string, qty: number, email = `${client}@x.io`, typeId = 1, name = 'Ana') =>
    p.call('post', '/public/order', {
        clientKey: client,
        body: { event_id: 1, buyer_name: name, buyer_email: email, items: [{ ticket_type_id: typeId, qty }], elapsed: 5000 },
    });
const codeMailedTo = (p: BootedPlugin, email: string) => {
    const m = p.mails.filter((x) => x.to === email && /código/i.test(x.subject)).pop();
    return m ? String(m.text).match(/\b(\d{8})\b/)![1] : null;
};
const verifyTickets = (p: BootedPlugin, client: string, token: string, code: string) =>
    p.call('post', '/public/order/verify', { clientKey: client, body: { token, code } });
const typeRow = (p: BootedPlugin, id = 1) => p.sdb.prepare(`SELECT sold, held FROM ${p.prefix}ticket_types WHERE id = ?`).get(id);
const ticketOrder = (p: BootedPlugin, token: string) => p.sdb.prepare(`SELECT * FROM ${p.prefix}orders WHERE token = ?`).get(token);
const ET_ADMIN = { id: 1, role: 'administrator' };

test('event-tickets: a paid order holds its seats only once the buyer confirms the mailed code', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 20);
        const placed = await placeTickets(p, 'buyer', 3, 'buyer@x.io', 1, NAME_PAYLOAD);
        assert.strictEqual(placed.status, 200, JSON.stringify(placed.body));
        assert.strictEqual(placed.body.status, 'unverified');
        assert.strictEqual(typeRow(p).sold, 0, 'an unconfirmed order holds no seats');
        const code = codeMailedTo(p, 'buyer@x.io')!;
        assert.ok(code, 'a code is mailed to the buyer');
        assertNoVisitorName(p.mails.find((m) => m.to === 'buyer@x.io')!, 'code mail');

        const wrong = code === '00000000' ? '11111111' : '00000000';
        assert.strictEqual((await verifyTickets(p, 'buyer', placed.body.token, wrong)).status, 400);
        assert.strictEqual(typeRow(p).sold, 0);
        const ok = await verifyTickets(p, 'buyer', placed.body.token, code);
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.status, 'pending');
        assert.deepStrictEqual(typeRow(p), { sold: 3, held: 3 });
        assert.strictEqual(ticketOrder(p, placed.body.token).payment_status, 'pending');
        const received = p.mails.filter((m) => m.to === 'buyer@x.io' && /Pedido recibido/.test(m.subject));
        assert.strictEqual(received.length, 1, 'the order-received mail goes out once the address is proven');
        assertNoVisitorName(received[0], 'order-received mail');
        // The code is spent.
        assert.strictEqual((await verifyTickets(p, 'buyer', placed.body.token, code)).status, 404);

        // The admin's payment confirmation moves the seats from held to sold.
        const id = ticketOrder(p, placed.body.token).id;
        const paid = await p.call('post', '/orders/:id/paid', { params: { id }, user: ET_ADMIN });
        assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
        assert.deepStrictEqual(typeRow(p), { sold: 3, held: 0 });
    });
});

test('event-tickets: wrong codes are capped per order, and an unconfirmed order cannot be marked paid', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 20);
        const placed = await placeTickets(p, 'guesser', 2);
        const code = codeMailedTo(p, 'guesser@x.io')!;
        const wrong = code === '00000000' ? '11111111' : '00000000';
        for (let i = 0; i < 5; i++) assert.strictEqual((await verifyTickets(p, `g${i}`, placed.body.token, wrong)).status, 400);
        const late = await verifyTickets(p, 'g9', placed.body.token, code);
        assert.strictEqual(late.status, 400, `the right code after 5 wrong ones: ${JSON.stringify(late.body)}`);
        assert.strictEqual(typeRow(p).sold, 0);
        const id = ticketOrder(p, placed.body.token).id;
        const paid = await p.call('post', '/orders/:id/paid', { params: { id }, user: ET_ADMIN });
        assert.strictEqual(paid.status, 409, JSON.stringify(paid.body));
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}tickets`).get().n, 0);
    });
});

test('event-tickets: anonymous unpaid orders from many clients neither sell out the event nor 429 real buyers', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 20);
        // 80 clients, each with a fresh address, ask for every seat. None of them proves an address.
        for (let i = 0; i < 80; i++) {
            const r = await placeTickets(p, `bot${i}`, 10, `bot${i}@x.io`);
            assert.strictEqual(r.status, 200, `bot ${i}: ${JSON.stringify(r.body)}`);
        }
        assert.strictEqual(typeRow(p).sold, 0, 'no seat is held by an unconfirmed order');
        const real = await placeTickets(p, 'fan', 2, 'fan@x.io');
        assert.strictEqual(real.status, 200, `the site-wide window turned a real buyer away: ${JSON.stringify(real.body)}`);
        const held = await verifyTickets(p, 'fan', real.body.token, codeMailedTo(p, 'fan@x.io')!);
        assert.strictEqual(held.status, 200, JSON.stringify(held.body));
        assert.strictEqual(typeRow(p).sold, 2);
        // Unconfirmed orders expire with their code.
        await withClockAdvanced(16 * 60e3, () => placeTickets(p, 'later', 1, 'later@x.io'));
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}orders WHERE payment_status = 'unverified'`).get().n, 1, 'only the newest order is still unconfirmed');
    });
});

test('event-tickets: confirmed unpaid orders hold at most the configured share of a type', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 20);
        const place = async (client: string, qty: number) => {
            const r = await placeTickets(p, client, qty);
            if (r.status !== 200) return r;
            return verifyTickets(p, client, r.body.token, codeMailedTo(p, `${client}@x.io`)!);
        };
        assert.strictEqual((await place('a', 6)).status, 200);
        assert.strictEqual((await place('b', 4)).status, 200, '10 of 20 seats held: exactly the default 50 %');
        const over = await place('c', 1);
        assert.strictEqual(over.status, 409, `unpaid orders held more than half the type: ${JSON.stringify(over.body)}`);
        assert.match(over.body.error, /sin pagar/);
        assert.deepStrictEqual(typeRow(p), { sold: 10, held: 10 });
        // A confirmed payment frees its share of the hold for the next buyer.
        const a = p.sdb.prepare(`SELECT id FROM ${p.prefix}orders WHERE buyer_email = 'a@x.io'`).get().id;
        assert.strictEqual((await p.call('post', '/orders/:id/paid', { params: { id: a }, user: ET_ADMIN })).status, 200);
        assert.strictEqual((await place('d', 1)).status, 200);
        assert.deepStrictEqual(typeRow(p), { sold: 11, held: 5 });
        // Cancelling a pending order releases its hold too.
        const b = p.sdb.prepare(`SELECT id FROM ${p.prefix}orders WHERE buyer_email = 'b@x.io'`).get().id;
        assert.strictEqual((await p.call('post', '/orders/:id/cancel', { params: { id: b }, user: ET_ADMIN })).status, 200);
        assert.deepStrictEqual(typeRow(p), { sold: 7, held: 1 });
        // The share and the payment TTL are settings; saving the old fields keeps them.
        const saved = await p.call('post', '/config', { user: ET_ADMIN, body: { pendingHoldPercent: 100, pendingTtlMinutes: 5 } });
        assert.strictEqual(saved.body.pendingHoldPercent, 100);
        const legacy = await p.call('post', '/config', { user: ET_ADMIN, body: { currencySymbol: '€' } });
        assert.deepStrictEqual([legacy.body.pendingHoldPercent, legacy.body.pendingTtlMinutes], [100, 5]);
        // A pending order past the TTL lets its seats go on the next order's sweep.
        await withClockAdvanced(6 * 60e3, () => placeTickets(p, 'sweeper', 1));
        assert.deepStrictEqual(typeRow(p), { sold: 6, held: 0 }, 'the pending orders expired after the configured 5 minutes');
    });
});

test('event-tickets: with no mail transport at all a paid order holds its seats right away', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 20);
        p.setMailFailure(new Error('Mail server not available'));
        const r = await placeTickets(p, 'nomail', 2);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.status, 'pending');
        assert.deepStrictEqual(typeRow(p), { sold: 2, held: 2 });
        // A failure on a site WITH mail never holds seats: the order is withdrawn.
        p.setMailFailure(new Error('550 mailbox unavailable'));
        const refused = await placeTickets(p, 'typo', 2);
        assert.strictEqual(refused.status, 503, JSON.stringify(refused.body));
        assert.deepStrictEqual(typeRow(p), { sold: 2, held: 2 });
    });
});

test('event-tickets: the free-ticket and order-received mails carry no visitor name and are bounded per address', async () => {
    await withPlugin('event-tickets', async (p) => {
        seedTicketEvent(p, 100);
        const free = await placeTickets(p, 'freebie', 1, 'victim@x.io', 2, NAME_PAYLOAD);
        assert.strictEqual(free.status, 200, JSON.stringify(free.body));
        assertNoVisitorName(p.mails.find((m) => m.to === 'victim@x.io')!, 'free tickets mail');
        // Paid orders to one address from rotating clients: the per-email order window (5 per 10 min)
        // and then the per-address mail budget (5 an hour) stop the mails.
        for (let i = 0; i < 4; i++) assert.strictEqual((await placeTickets(p, `rot${i}`, 1, 'victim@x.io')).status, 200);
        const sixth = await withClockAdvanced(11 * 60e3, () => placeTickets(p, 'rot9', 1, 'victim@x.io'));
        assert.strictEqual(sixth.status, 429, JSON.stringify(sixth.body));
        assert.strictEqual(p.mails.filter((m) => m.to === 'victim@x.io').length, 5);
    });
});

// ================================== auctions ==================================================

function seedLot(p: BootedPlugin, settings: Record<string, string> = {}) {
    const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    p.sdb.prepare(
        `INSERT INTO ${p.prefix}auctions (title, slug, start_price_cents, min_increment_cents, ends_at, anti_snipe_min, status, is_published, created_at)
         VALUES ('Watch', 'watch', 1000, 100, ?, 0, 'active', 1, ?)`
    ).run(sql(Date.now() + 3600e3), sql(Date.now()));
    for (const [k, v] of Object.entries(settings)) p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES (?, ?)`).run(k, v);
}
const placeBid = (p: BootedPlugin, client: string, amount: number, extra: any = {}) => p.call('post', '/public/bid', {
    clientKey: client,
    body: { auction_id: 1, elapsed: 5000, bidder_name: 'Bidder', bidder_email: `${client}@x.io`, amount_cents: amount, ...extra },
});
const bidCount = (p: BootedPlugin) => p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bids`).get().n;
const AU_ADMIN = { id: 1, role: 'administrator' };

test('auctions: one bid can no longer jump the price past the cap', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p, { bid_verification: 'none' });
        // Current price 1000, increment 100, default cap 100 %: max(1000 + 11 × 100, 1000 + 1000) = 2100.
        const detail = await p.call('get', '/public/auction', { query: { slug: 'watch' } });
        assert.strictEqual(detail.body.auction.maxNextBidCents, 2100);
        const huge = await placeBid(p, 'whale', 1000000000000);
        assert.strictEqual(huge.status, 400, `a 10^12 bid froze the auction: ${JSON.stringify(huge.body)}`);
        assert.strictEqual(huge.body.maxBidCents, 2100);
        assert.strictEqual((await placeBid(p, 'whale', 2101)).status, 400);
        assert.strictEqual((await placeBid(p, 'whale', 2100)).status, 200);
        assert.strictEqual((await placeBid(p, 'rival', 4200)).status, 200, 'the cap follows the new price');
        // The cap is a setting: 0 removes it.
        const saved = await p.call('post', '/settings', { user: AU_ADMIN, body: { maxBidJumpPercent: 0 } });
        assert.strictEqual(saved.body.maxBidJumpPercent, 0);
        assert.strictEqual((await placeBid(p, 'whale', 99999999)).status, 200);
        assert.strictEqual((await p.call('post', '/settings', { user: AU_ADMIN, body: { maxBidJumpPercent: -1 } })).status, 400);
    });
});

test('auctions: a bidder proves the address with a mailed code before a bid counts', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p);
        const first = await placeBid(p, 'ana', 1100, { bidder_name: NAME_PAYLOAD });
        assert.strictEqual(first.status, 202, JSON.stringify(first.body));
        assert.strictEqual(first.body.needsVerification, true);
        assert.strictEqual(bidCount(p), 0, 'an unproven bid does not land');
        const mail = p.mails.find((m) => m.to === 'ana@x.io')!;
        assertNoVisitorName(mail, 'verification mail');
        const code = String(mail.text).match(/\b(\d{8})\b/)![1];
        const wrong = code === '00000000' ? '11111111' : '00000000';
        assert.strictEqual((await p.call('post', '/public/verify-bidder', { clientKey: 'ana', body: { bidder_email: 'ana@x.io', code: wrong } })).status, 400);
        const ok = await p.call('post', '/public/verify-bidder', { clientKey: 'ana', body: { bidder_email: 'ana@x.io', code } });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        const key = ok.body.bidder_key;
        assert.match(key, /^[a-f0-9]{48}$/);
        assert.strictEqual((await placeBid(p, 'ana', 1100, { bidder_key: key })).status, 200);
        assert.strictEqual(bidCount(p), 1);
        // The key belongs to the address: another address (or no key) is asked to verify.
        assert.strictEqual((await placeBid(p, 'eve', 1200, { bidder_key: key })).status, 202);
        assert.strictEqual((await placeBid(p, 'ana', 1200, { bidder_key: 'f'.repeat(48) })).status, 202);
        // Five wrong codes spend this code; the right one no longer works.
        const evCode = String(p.mails.filter((m) => m.to === 'eve@x.io').pop()!.text).match(/\b(\d{8})\b/)![1];
        const evWrong = evCode === '00000000' ? '11111111' : '00000000';
        for (let i = 0; i < 5; i++) await p.call('post', '/public/verify-bidder', { clientKey: `x${i}`, body: { bidder_email: 'eve@x.io', code: evWrong } });
        assert.strictEqual((await p.call('post', '/public/verify-bidder', { clientKey: 'x9', body: { bidder_email: 'eve@x.io', code: evCode } })).status, 400);
        // Codes mailed to one address are bounded (3 an hour), whatever clients ask.
        for (let i = 0; i < 5; i++) assert.strictEqual((await placeBid(p, `spam${i}`, 1200, { bidder_email: 'target@x.io' })).status, 202);
        assert.strictEqual(p.mails.filter((m) => m.to === 'target@x.io').length, 3);
    });
});

test('auctions: on a site that cannot send mail the email mode falls back to open bidding', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p);
        p.setMailFailure(new Error('Mail server not available'));
        assert.strictEqual((await placeBid(p, 'ana', 1100)).status, 200);
        p.setMailFailure(new Error('421 try again later'));
        assert.strictEqual((await placeBid(p, 'bob', 1200)).status, 503, 'a failed send on a site with mail does not open bidding');
        assert.strictEqual(bidCount(p), 1);
    });
});

test('auctions: in login mode only signed-in accounts bid, as their account address', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p, { bid_verification: 'login' });
        const anon = await placeBid(p, 'anon', 1100);
        assert.strictEqual(anon.status, 401, JSON.stringify(anon.body));
        assert.strictEqual(anon.body.loginRequired, true);
        const member = await p.call('post', '/bid-user', {
            clientKey: 'm', user: { id: 7, role: 'subscriber', userEmail: 'Member@Site.test' },
            body: { auction_id: 1, elapsed: 5000, bidder_name: 'Member', bidder_email: 'someone-else@x.io', amount_cents: 1100 },
        });
        assert.strictEqual(member.status, 200, JSON.stringify(member.body));
        assert.strictEqual(p.sdb.prepare(`SELECT bidder_email FROM ${p.prefix}bids`).get().bidder_email, 'member@site.test');
    });
});

test('auctions: clients filling the shared windows cannot keep a new bidder out', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p, { bid_verification: 'none', max_bid_jump_percent: '0' });
        let amount = 1100;
        // Seven clients, ten bids each, fill the auction's shared 60-a-minute window. Each one's first
        // bid is not held to it, so 67 land and the rest wait.
        const statuses: number[] = [];
        for (let c = 0; c < 7; c++) {
            for (let i = 0; i < 10; i++) {
                statuses.push((await placeBid(p, `ring${c}`, amount, { bidder_email: `ring${c}-${i}@x.io` })).status);
                amount += 100;
            }
        }
        assert.deepStrictEqual([statuses.filter((s) => s === 200).length, statuses.filter((s) => s === 429).length], [67, 3]);
        const newcomer = await placeBid(p, 'newcomer', amount + 100000);
        assert.strictEqual(newcomer.status, 200, `the shared window locked a new bidder out: ${JSON.stringify(newcomer.body)}`);
        assert.strictEqual(newcomer.body.isTop, true);
        // The newcomer's own next bid is held to the shared window like everyone else's.
        assert.strictEqual((await placeBid(p, 'newcomer', amount + 200000, { bidder_email: 'newcomer-b@x.io' })).status, 429);
    });
});

test('auctions: the outbid notice carries no stored name and is bounded per address', async () => {
    await withPlugin('auctions', async (p) => {
        seedLot(p, { bid_verification: 'none', max_bid_jump_percent: '0' });
        let amount = 1100;
        // The victim's address is put on top again and again (from many clients) and outbid each time.
        // (Two minutes apart in pairs of seven: one address places at most 10 bids a minute.)
        for (let i = 0; i < 14; i++) {
            await withClockAdvanced(Math.floor(i / 7) * 120e3, async () => {
                assert.strictEqual((await placeBid(p, `v${i}`, amount, { bidder_email: 'victim@x.io', bidder_name: NAME_PAYLOAD })).status, 200);
                assert.strictEqual((await placeBid(p, `o${i}`, amount + 100, { bidder_email: `o${i}@x.io` })).status, 200);
            });
            amount += 200;
        }
        const notices = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(notices.length, 10, 'outbid notices to one address are capped at 10 an hour');
        for (const m of notices) assertNoVisitorName(m, 'outbid notice');
    });
});

// ================================== mail to unverified addresses ===============================

test('online-store: the order-received mail carries no visitor name and is bounded per address', async () => {
    await withPlugin('online-store', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, stock, is_published) VALUES ('Tee', 'tee', 2000, -1, 1)`).run();
        p.options.set('online_store_config', { storeEmail: 'shop@site.test' });
        for (let i = 0; i < 7; i++) {
            const r = await p.call('post', '/public/checkout', {
                clientKey: `c${i}`, body: { customer: { name: NAME_PAYLOAD, email: 'victim@x.io' }, items: [{ product_id: 1, qty: 1 }], payment_method: 'manual' },
            });
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        }
        const toVictim = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(toVictim.length, 5, 'mails to one customer address are capped at 5 an hour');
        for (const m of toVictim) assertNoVisitorName(m, 'order-received mail');
        assert.strictEqual(p.mails.filter((m) => m.to === 'shop@site.test').length, 7, 'the shop is still told about every order');
    });
});

test('donations: the thank-you mail carries no visitor name and is bounded per address', async () => {
    await withPlugin('donations', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}campaigns (title, slug, goal_cents, is_active) VALUES ('Roof', 'roof', 100000, 1)`).run();
        const donate = (c: string) => p.call('post', '/public/donate', {
            clientKey: c, body: { campaign_id: 1, amount_cents: 1000, donor_name: NAME_PAYLOAD, donor_email: 'victim@x.io', message: NAME_PAYLOAD, elapsed: 5000 },
        });
        for (let i = 0; i < 5; i++) assert.strictEqual((await donate(`c${i}`)).status, 200);
        // The per-email donation window (5 per 10 min) has passed; the mail budget (5 an hour) has not.
        const later = await withClockAdvanced(11 * 60e3, () => donate('c9'));
        assert.strictEqual(later.status, 200, JSON.stringify(later.body));
        const toVictim = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(toVictim.length, 5);
        for (const m of toVictim) assertNoVisitorName(m, 'donation thank-you mail');
    });
});

test('bookings: the confirmation mail carries no visitor name and is bounded per address', async () => {
    await withPlugin('bookings', async (p) => {
        const days = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]));
        p.sdb.prepare(`INSERT INTO ${p.prefix}services (name, duration_min, availability, is_active) VALUES ('Cut', 60, ?, 1)`).run(JSON.stringify(days));
        p.options.set('bookings_config', { minNoticeHours: 0 });
        const d = new Date(Date.now() + 86400e3);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const book = (c: string, time: string) => p.call('post', '/public/book', {
            clientKey: c, body: { service_id: 1, date, time, customer_name: NAME_PAYLOAD, customer_email: 'victim@x.io', elapsed: 5000, page_url: 'http://site.test/r' },
        });
        const statuses: number[] = [];
        for (const [i, time] of ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'].entries()) {
            // Each unconfirmed booking stops counting toward the address's cap of 3 active ones.
            p.sdb.prepare(`UPDATE ${p.prefix}bookings SET status = 'expired', slot_claim = NULL, email_claim = NULL, client_claim = NULL`).run();
            statuses.push((await book(`c${i}`, time)).status);
        }
        assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 429]);
        const toVictim = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(toVictim.length, 5);
        for (const m of toVictim) assertNoVisitorName(m, 'booking confirmation mail');
    });
});

test('newsletter: the double opt-in mail carries no visitor name and is bounded per address per day', async () => {
    await withPlugin('newsletter', async (p) => {
        const subscribe = (c: string) => p.call('post', '/public/subscribe', { clientKey: c, body: { email: 'victim@x.io', name: NAME_PAYLOAD } });
        let n = 0;
        for (const hour of [0, 1, 2, 3]) {
            await withClockAdvanced(hour * 61 * 60e3, async () => {
                for (let i = 0; i < 4; i++) assert.strictEqual((await subscribe(`c${n++}`)).status, 200);
            });
        }
        const toVictim = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(toVictim.length, 6, 'confirmation mails to one address: 3 an hour, 6 a day');
        for (const m of toVictim) assertNoVisitorName(m, 'opt-in mail');
    });
});
