/**
 * Business-logic / abuse regression suite for first-party marketplace plugins.
 *
 * Each block boots the REAL plugin entry (marketplace/plugins/<slug>/index.js) through the shared
 * harness in ./fixtures/marketplace-plugin-harness — in-memory SQLite plus the host's real SQL guard —
 * and replays the abuse that was confirmed against it, asserting the fixed behaviour:
 *
 *  - auctions:            invalid bids flood one site-wide window -> nobody else can outbid; a
 *                         concurrent burst passes the per-client cap before any bid is counted.
 *  - online-store:        unpaid orders reserve stock/coupons forever; global checkout cap; the admin
 *                         re-opened a cancelled order with no stock held for it, and could mark one
 *                         paid (mailing a receipt) — two admins marking an order paid mailed two
 *                         receipts, and so did two marking a donation paid (donations).
 *  - bookings:            instant 'confirmed' bookings, global limiters -> one client fills the calendar;
 *                         a failed send confirmed the booking; concurrent bursts pass the caps; a
 *                         shared client key (NAT, proxy) became a durable site-wide cap; a staff
 *                         re-open added an unclaimed counting row and a burst then passed the email
 *                         cap; a MySQL collation twin of a held claim exhausted the retries (500); a
 *                         staff confirm wrote over an expiry or a cancellation it had not read; a
 *                         re-open (also one a lost race led to) double-booked a slot taken meanwhile.
 *  - invoices:            global failed-token throttle -> every customer's link 429s; burst bypass.
 *  - vendor-marketplace:  vendor republishes an admin-hidden product; protocol-relative image URLs;
 *                         simultaneous applications stored duplicate stores (and a slug collision
 *                         answered 500 with the constraint text); the reply told a duplicate address;
 *                         an approval undid a code rotation.
 *  - conference-manager:  a cancelled attendee kept a bed (edit and placement decided outside the
 *                         assignment lock); a bus capacity cut below the tickets sold; a reprice
 *                         wrote the tickets' price after the lock and a payment overpaid the ticket;
 *                         a payment recorded while the bus, passenger or attendee was deleted was
 *                         erased with its ticket.
 *  - newsletter:          mail failure auto-confirmed the subscriber (no opt-in); simultaneous
 *                         subscribes answered 500; a racing subscribe un-confirmed the subscriber.
 *  - public error replies: auctions, digital-downloads, invoices, polls, vendor-marketplace and
 *                         conference-manager echoed the driver's message; online-store and
 *                         restaurant-menu echoed Stripe's (which can name the account's key); public
 *                         routes with no catch did not answer their own failures.
 *  - event-tickets:       free tickets limited only per email -> rotating emails take all capacity;
 *                         a concurrent burst from one client passed every cap; a shared client key
 *                         became a permanent per-event cap; an unpaid order's seats went back twice
 *                         (overlapping sweeps, the admin cancelling an expired order); a capacity
 *                         cut below the seats sold.
 *  - job-board, polls:    checked before an await and counted after it -> one client's concurrent
 *                         burst passed the cap (and the one-vote-per-client mark) and then filled
 *                         the shared window for everyone.
 *  - digital-downloads, restaurant-menu, donations, contact-forms, testimonials, vendor-marketplace,
 *    popup-builder, cookie-consent: one site-wide (or per-form) window -> one client 429s everyone.
 *  - bookings, job-board: an INSERT ... WHERE NOT EXISTS / COUNT guard is not atomic on Postgres.
 *
 * Concurrency: route handlers run concurrently in the plugin isolate, and every db call is an await.
 * The burst tests fire requests with Promise.all, so all of them interleave at each await exactly as
 * they do behind the IPC bridge. SQLite runs each statement atomically; the tests that need the
 * Postgres behaviour (a statement's guard reads a snapshot without concurrent inserts) boot the plugin
 * with the harness's `snapshotInsertSelect` engine model. A race between a read and the write it
 * decides is replayed deterministically with `interleaveAfter`: another request runs in that gap.
 * `interleaveBefore` lands it while a statement is still in flight — the gap right after a request
 * released an in-process lock, which no statement of that request precedes.
 *
 * The mail-server vacation responder is covered in mail-server-vacation.test.ts (it slices functions
 * out of a 3.7k-line SMTP plugin rather than booting it).
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, BootedPlugin, StatementHook } from './fixtures/marketplace-plugin-harness';

after(async () => {
    // plugin-api pulls in core/cache, which may hold a Redis handle (see f6-plugin-compatibility).
    try {
        const cache = require('../core/cache');
        if (cache && typeof cache.closeAll === 'function') await cache.closeAll();
    } catch { /* never loaded */ }
});

const sqlUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Run `fn` with Date.now() shifted forward, so window-based throttles in the plugin see time pass. */
async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const real = Date.now;
    Date.now = () => real() + ms;
    try { return await fn(); } finally { Date.now = real; }
}

async function withPlugin(slug: string, fn: (p: BootedPlugin) => Promise<void>, beforeInit?: (sdb: any, prefix: string) => void) {
    const p = await bootPlugin(slug, { beforeInit });
    try { await fn(p); } finally { p.close(); }
}

/** Same, on the Postgres engine model: INSERT ... SELECT reads a snapshot (see the harness header). */
async function withPluginOnSnapshotEngine(slug: string, fn: (p: BootedPlugin) => Promise<void>, beforeInit?: (sdb: any, prefix: string) => void) {
    const p = await bootPlugin(slug, { beforeInit, snapshotInsertSelect: true });
    try { await fn(p); } finally { p.close(); }
}

type Reply = { status: number; body: any };

/**
 * One client sends `n` requests in a row, then a different client sends one. A limiter shared by the
 * whole site lets the first client's flood refuse the second client; a per-client one does not.
 */
async function floodThenBystander(n: number, send: (clientKey: string, i: number) => Promise<Reply>) {
    const flooder: number[] = [];
    for (let i = 0; i < n; i++) flooder.push((await send('flooder', i)).status);
    const bystander = await send('bystander', n);
    return { flooder, bystander };
}
const countOf = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

/**
 * Land another request in the gap after the plugin's FIRST statement matching `match`: `interleave`
 * starts right after that statement ran and before the plugin sees its result, and the plugin's next
 * statement waits until it finished — or, when it is itself waiting on the interrupted request (a lock
 * that request holds), until the event loop has turned IDLE_TURNS times. That gap is where a
 * concurrent request's statements commit on the host, between a read and the write it decides.
 * `result()` is the interleaved request's own reply.
 */
const IDLE_TURNS = 50;
function interleaveAfter<T>(p: BootedPlugin, match: RegExp, interleave: () => Promise<T>) {
    return interleaveAt((hook) => p.setStatementHook(hook), match, interleave);
}
/**
 * Same, landing the other request right BEFORE the plugin's first statement matching `match` runs:
 * the gap between a request releasing an in-process lock and its next statement (see the harness).
 */
function interleaveBefore<T>(p: BootedPlugin, match: RegExp, interleave: () => Promise<T>) {
    return interleaveAt((hook) => p.setPreStatementHook(hook), match, interleave);
}
function interleaveAt<T>(install: (hook: StatementHook) => void, match: RegExp, interleave: () => Promise<T>) {
    let fired = false;
    let started: Promise<T> | undefined;
    install(async (sql) => {
        if (fired || !match.test(sql)) return;
        fired = true;
        const run = interleave();
        started = run;
        let done = false;
        run.then(() => { done = true; }, () => { done = true; });
        for (let turn = 0; !done && turn < IDLE_TURNS; turn++) await new Promise((resolve) => setImmediate(resolve));
    });
    return {
        result(): Promise<T> {
            if (!started) throw new Error(`no statement matched ${match}`);
            return started;
        },
    };
}

// ================================== auctions ==================================================

async function seedAuction(p: BootedPlugin) {
    p.sdb.prepare(
        `INSERT INTO ${p.prefix}auctions (title, slug, start_price_cents, min_increment_cents, ends_at, anti_snipe_min, status, is_published, created_at)
         VALUES ('Car', 'car', 1000, 100, ?, 2, 'active', 1, ?)`
    ).run(sqlUtc(Date.now() + 3600e3), sqlUtc(Date.now()));
}
const bid = (p: BootedPlugin, clientKey: string, amount: number, email = `${clientKey}@x.io`, extra: any = {}) =>
    p.call('post', '/public/bid', {
        clientKey,
        body: { auction_id: 1, elapsed: 5000, bidder_name: 'Bidder ' + clientKey, bidder_email: email, amount_cents: amount, ...extra },
    });

test('auctions: a flood of malformed bids from one client never blocks another client from outbidding', async () => {
    await withPlugin('auctions', async (p) => {
        await seedAuction(p);
        assert.strictEqual((await bid(p, 'attacker', 1100)).status, 200);
        const statuses = new Set<number>();
        for (let i = 0; i < 150; i++) {
            const r = await p.call('post', '/public/bid', {
                clientKey: 'attacker', body: { auction_id: 1, elapsed: 5000, bidder_name: '', bidder_email: 'x', amount_cents: 0 },
            });
            statuses.add(r.status);
        }
        assert.ok(statuses.has(429), 'the flooding client throttles ITSELF');
        const victim = await bid(p, 'victim', 500000);
        assert.strictEqual(victim.status, 200, JSON.stringify(victim.body));
        assert.strictEqual(victim.body.isTop, true);
    });
});

test('auctions: a concurrent burst of bids from one client is held to its per-auction cap', async () => {
    await withPlugin('auctions', async (p) => {
        await seedAuction(p);
        // Route handlers run concurrently in the isolate. With check-first / count-after-INSERT, 30
        // simultaneous valid bids all passed the per-client check (10/min) before any was counted;
        // two such clients filled the auction's 60/min window and every other bidder got 429.
        const burst = (client: string, base: number) => Promise.all(Array.from({ length: 30 }, (_, i) =>
            bid(p, client, base + i * 100, `${client}${i}@x.io`)));
        const first = await burst('burst-a', 1100);
        const second = await burst('burst-b', 10000);
        assert.strictEqual(first.filter((r) => r.status === 200).length, 10, 'client A landed more than its 10 bids a minute');
        assert.strictEqual(second.filter((r) => r.status === 200).length, 10, 'client B landed more than its 10 bids a minute');
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bids`).get().n, 20);
        const victim = await bid(p, 'victim', 500000);
        assert.strictEqual(victim.status, 200, `two clients locked the auction for everyone: ${JSON.stringify(victim.body)}`);
        assert.strictEqual(victim.body.isTop, true);
    });
});

test('auctions: per-client per-auction cap counts inserted bids and leaves other clients bidding', async () => {
    await withPlugin('auctions', async (p) => {
        await seedAuction(p);
        let amount = 1100;
        for (let i = 0; i < 10; i++) {
            const r = await bid(p, 'heavy', amount, `heavy${i}@x.io`);
            assert.strictEqual(r.status, 200, `bid ${i}: ${JSON.stringify(r.body)}`);
            amount += 100;
        }
        assert.strictEqual((await bid(p, 'heavy', amount, 'heavy-extra@x.io')).status, 429, 'same client, same auction: capped');
        assert.strictEqual((await bid(p, 'other', amount)).status, 200, 'another client is unaffected');
    });
});

// ================================== online-store ==============================================

async function seedStore(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, stock, is_published) VALUES ('Mug', 'mug', 1000, 10, 1)`).run();
    p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, stock, is_published) VALUES ('Tee', 'tee', 2000, -1, 1)`).run();
    p.sdb.prepare(`INSERT INTO ${p.prefix}coupons (code, type, value, max_uses, used_count, is_active) VALUES ('ONCE', 'percent', 10, 1, 0, 1)`).run();
}
const checkout = (p: BootedPlugin, clientKey: string, items: any[], extra: any = {}) =>
    p.call('post', '/public/checkout', {
        clientKey,
        body: { customer: { name: 'Buyer', email: `${clientKey}@x.io` }, items, payment_method: 'manual', ...extra },
    });
const stockOf = (p: BootedPlugin, id: number) => p.sdb.prepare(`SELECT stock FROM ${p.prefix}products WHERE id = ?`).get(id).stock;
const couponUses = (p: BootedPlugin) => p.sdb.prepare(`SELECT used_count FROM ${p.prefix}coupons WHERE code = 'ONCE'`).get().used_count;

test('online-store: an unpaid manual order releases its stock and coupon after the reservation TTL', async () => {
    await withPlugin('online-store', async (p) => {
        await seedStore(p);
        const first = await checkout(p, 'squatter', [{ product_id: 1, qty: 10 }], { coupon_code: 'ONCE' });
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.strictEqual(stockOf(p, 1), 0);
        assert.strictEqual(couponUses(p), 1);

        // Within the TTL the reservation holds.
        const blocked = await withClockAdvanced(61e3, () => checkout(p, 'shopper', [{ product_id: 1, qty: 1 }]));
        assert.strictEqual(blocked.status, 409);

        // Past the manual TTL (default 72 h) the next checkout's sweep cancels it and gives both back.
        p.sdb.prepare(`UPDATE ${p.prefix}orders SET created_at = ? WHERE id = 1`).run(sqlUtc(Date.now() - 73 * 3600e3));
        const after = await withClockAdvanced(122e3, () => checkout(p, 'shopper2', [{ product_id: 1, qty: 1 }], { coupon_code: 'ONCE' }));
        assert.strictEqual(after.status, 200, JSON.stringify(after.body));
        const o1 = p.sdb.prepare(`SELECT status, payment_status FROM ${p.prefix}orders WHERE id = 1`).get();
        assert.deepStrictEqual(o1, { status: 'cancelled', payment_status: 'cancelled' });
        assert.strictEqual(stockOf(p, 1), 9, 'stock restored once, then 1 sold');
        assert.strictEqual(couponUses(p), 1, 'coupon released and re-used by the new order');
    });
});

test('online-store: an order the admin moved past "new" never expires', async () => {
    await withPlugin('online-store', async (p) => {
        await seedStore(p);
        assert.strictEqual((await checkout(p, 'cod', [{ product_id: 1, qty: 2 }])).status, 200);
        p.sdb.prepare(`UPDATE ${p.prefix}orders SET status = 'processing', created_at = ? WHERE id = 1`).run(sqlUtc(Date.now() - 500 * 3600e3));
        assert.strictEqual((await withClockAdvanced(61e3, () => checkout(p, 'x', [{ product_id: 2, qty: 1 }]))).status, 200);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}orders WHERE id = 1`).get().status, 'processing');
        assert.strictEqual(stockOf(p, 1), 8);
    });
});

// A cancelled order gave its stock back. The admin status route moved any order to any status with a
// plain UPDATE: re-opening a cancelled order (the order screen offers every status), or one the unpaid
// sweep cancelled between the admin's read and the write, made it an order to fulfil with no stock
// held for it — the last unit was then sold twice.
const OS_ADMIN = { id: 1, role: 'administrator' };
const setOrderStatus = (p: BootedPlugin, id: number, status: string) =>
    p.call('post', '/orders/:id/status', { user: OS_ADMIN, params: { id: String(id) }, body: { status } });
const activeOrders = (p: BootedPlugin) => p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}orders WHERE status != 'cancelled'`).get().n;
function seedLastUnit(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, stock, is_published) VALUES ('Lamp', 'lamp', 5000, 1, 1)`).run();
    return Number(p.sdb.prepare(`SELECT id FROM ${p.prefix}products WHERE slug = 'lamp'`).get().id);
}

test('online-store: a cancelled order is not re-opened without its stock', async () => {
    await withPlugin('online-store', async (p) => {
        const lamp = seedLastUnit(p);
        assert.strictEqual((await checkout(p, 'first', [{ product_id: lamp, qty: 1 }])).status, 200);
        assert.strictEqual((await setOrderStatus(p, 1, 'cancelled')).status, 200);
        assert.strictEqual(stockOf(p, lamp), 1, 'the cancellation gives the unit back');
        const reopen = await setOrderStatus(p, 1, 'processing');
        assert.strictEqual(reopen.status, 409, `a cancelled order was re-opened with no stock held: ${JSON.stringify(reopen.body)}`);
        assert.match(reopen.body.error, /cancelado/);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}orders WHERE id = 1`).get().status, 'cancelled');
        // The unit is sold once.
        assert.strictEqual((await checkout(p, 'second', [{ product_id: lamp, qty: 1 }])).status, 200);
        assert.strictEqual(stockOf(p, lamp), 0);
        assert.strictEqual(activeOrders(p), 1, 'the last unit backs two orders');
        // Active orders still move freely.
        assert.strictEqual((await setOrderStatus(p, 2, 'processing')).status, 200);
        assert.strictEqual((await setOrderStatus(p, 2, 'shipped')).status, 200);
    });
});

test('online-store: an order the sweep cancels between the admin\'s read and the write stays cancelled', async () => {
    await withPlugin('online-store', async (p) => {
        const lamp = seedLastUnit(p);
        assert.strictEqual((await checkout(p, 'first', [{ product_id: lamp, qty: 1 }])).status, 200);
        // Unpaid past the manual TTL; nothing has swept it yet, so the admin's read sees it 'new'.
        p.sdb.prepare(`UPDATE ${p.prefix}orders SET created_at = ? WHERE id = 1`).run(sqlUtc(Date.now() - 73 * 3600e3));
        await withClockAdvanced(61e3, async () => {
            // Another shopper's checkout sweeps it (the unit goes back) and buys the unit.
            const other = interleaveAfter(p, /^SELECT \* FROM \w+orders WHERE id = \?/, () => checkout(p, 'second', [{ product_id: lamp, qty: 1 }]));
            const r = await setOrderStatus(p, 1, 'processing');
            assert.strictEqual((await other.result()).status, 200);
            assert.strictEqual(activeOrders(p), 1, `the last unit backs two orders (admin answered ${r.status})`);
            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        });
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}orders WHERE id = 1`).get().status, 'cancelled');
        assert.strictEqual(stockOf(p, lamp), 0);
    });
});

// The admin's payment route wrote any payment status with a plain UPDATE: a cancelled order (its stock
// and coupon already given back) could be marked paid, and the customer was mailed a receipt for an
// order nobody fulfils — also when the sweep cancelled it between the admin's read and the write.
const setPaymentStatus = (p: BootedPlugin, id: number, paymentStatus: string) =>
    p.call('post', '/orders/:id/payment', { user: OS_ADMIN, params: { id: String(id) }, body: { payment_status: paymentStatus } });
const receiptsFor = (p: BootedPlugin, id: number) => p.mails.filter((m) => m.subject === `Pago recibido — Pedido #${id}`).length;
const orderState = (p: BootedPlugin, id: number) => p.sdb.prepare(`SELECT status, payment_status FROM ${p.prefix}orders WHERE id = ?`).get(id);

test('online-store: a cancelled order is never marked paid, and a payment receipt goes out once', async () => {
    await withPlugin('online-store', async (p) => {
        const lamp = seedLastUnit(p);
        assert.strictEqual((await checkout(p, 'first', [{ product_id: lamp, qty: 1 }])).status, 200);
        assert.strictEqual((await setOrderStatus(p, 1, 'cancelled')).status, 200);
        const paid = await setPaymentStatus(p, 1, 'paid');
        assert.strictEqual(paid.status, 409, `a cancelled order was marked paid: ${JSON.stringify(paid.body)}`);
        assert.match(paid.body.error, /cancelado/);
        assert.deepStrictEqual(orderState(p, 1), { status: 'cancelled', payment_status: 'pending' });
        assert.strictEqual(receiptsFor(p, 1), 0, 'a receipt was mailed for a cancelled order');
        // Bookkeeping statuses stay free on a cancelled order.
        assert.strictEqual((await setPaymentStatus(p, 1, 'refunded')).status, 200);
        assert.deepStrictEqual(orderState(p, 1), { status: 'cancelled', payment_status: 'refunded' });
        // An active order is marked paid; two admins marking it at the same time mail one receipt.
        assert.strictEqual((await checkout(p, 'second', [{ product_id: lamp, qty: 1 }])).status, 200);
        const both = await Promise.all([setPaymentStatus(p, 2, 'paid'), setPaymentStatus(p, 2, 'paid')]);
        assert.deepStrictEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body)));
        assert.deepStrictEqual(orderState(p, 2), { status: 'new', payment_status: 'paid' });
        assert.strictEqual(receiptsFor(p, 2), 1, 'one payment, one receipt');
    });
});

test('online-store: an order the sweep cancels between the admin\'s read and the mark-paid is not marked paid', async () => {
    await withPlugin('online-store', async (p) => {
        const lamp = seedLastUnit(p);
        assert.strictEqual((await checkout(p, 'first', [{ product_id: lamp, qty: 1 }])).status, 200);
        p.sdb.prepare(`UPDATE ${p.prefix}orders SET created_at = ? WHERE id = 1`).run(sqlUtc(Date.now() - 73 * 3600e3));
        await withClockAdvanced(61e3, async () => {
            // Another shopper's checkout sweeps the unpaid order (the unit goes back) and buys the unit.
            const other = interleaveAfter(p, /^SELECT \* FROM \w+orders WHERE id = \?/, () => checkout(p, 'second', [{ product_id: lamp, qty: 1 }]));
            const r = await setPaymentStatus(p, 1, 'paid');
            assert.strictEqual((await other.result()).status, 200);
            assert.deepStrictEqual(orderState(p, 1), { status: 'cancelled', payment_status: 'cancelled' }, `the admin answered ${r.status}`);
            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        });
        assert.strictEqual(receiptsFor(p, 1), 0, 'a receipt was mailed for an order the sweep cancelled');
        assert.strictEqual(stockOf(p, lamp), 0);
    });
});

test('online-store: per-order quantity caps (per line and in total)', async () => {
    await withPlugin('online-store', async (p) => {
        await seedStore(p);
        const tooMany = await checkout(p, 'bulk', [{ product_id: 2, qty: 60 }, { product_id: 1, qty: 1 }, { product_id: 2, variant_id: 0, qty: 30 }, { product_id: 1, qty: 9 }, { product_id: 2, qty: 5 }]);
        assert.strictEqual(tooMany.status, 400, 'merged line above the per-line cap');
        p.options.set('online_store_config', { maxOrderQty: 20 });
        const overTotal = await checkout(p, 'bulk2', [{ product_id: 2, qty: 15 }, { product_id: 1, qty: 6 }]);
        assert.strictEqual(overTotal.status, 400);
        assert.match(overTotal.body.error, /20/);
        assert.strictEqual(stockOf(p, 1), 10, 'nothing reserved by a rejected order');
    });
});

test('online-store: checkout rate limit is per client — many clients are never blocked by a site-wide cap', async () => {
    await withPlugin('online-store', async (p) => {
        await seedStore(p);
        for (let i = 0; i < 6; i++) assert.strictEqual((await checkout(p, 'loud', [{ product_id: 2, qty: 1 }])).status, 200);
        assert.strictEqual((await checkout(p, 'loud', [{ product_id: 2, qty: 1 }])).status, 429, 'one client is throttled');
        for (let i = 0; i < 25; i++) {
            const r = await checkout(p, `c${i}`, [{ product_id: 2, qty: 1 }]);
            assert.strictEqual(r.status, 200, `client ${i}: ${JSON.stringify(r.body)}`);
        }
    });
});

// ================================== bookings ==================================================

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = () => localDate(new Date(Date.now() + 86400e3));
const ALL_DAYS = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]));

async function seedService(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}services (name, duration_min, availability, is_active) VALUES ('Cut', 60, ?, 1)`).run(JSON.stringify(ALL_DAYS));
    p.options.set('bookings_config', { notifyEmail: 'owner@site.test', minNoticeHours: 0 });
}
const book = (p: BootedPlugin, clientKey: string, time: string, email = `${clientKey}@x.io`, date = tomorrow()) =>
    p.call('post', '/public/book', {
        clientKey,
        body: { service_id: 1, date, time, customer_name: 'Ana', customer_email: email, elapsed: 5000, page_url: 'http://site.test/reservas' },
    });
const slots = async (p: BootedPlugin) => (await p.call('get', '/public/slots', { clientKey: 'viewer', query: { service_id: 1, date: tomorrow() } })).body.slots;
const tokenFromMail = (m: { text?: string }) => String(m.text || '').match(/booking=([a-z0-9]{32})/)![1];

test('bookings: public bookings start pending, hold the slot, and are confirmed only by the mailed link', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        const r = await book(p, 'c1', '10:00');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.pending, true);
        assert.strictEqual(r.body.token, undefined, 'the confirmation secret is not handed to the requester');
        assert.ok(!(await slots(p)).includes('10:00'), 'a pending booking holds its slot');
        assert.strictEqual(p.mails.length, 1, 'only the customer is mailed — no owner notification before confirmation');
        assert.match(String(p.mails[0].text), /http:\/\/site\.test\/reservas\?booking=[a-z0-9]{32}&confirm=1/);

        const token = tokenFromMail(p.mails[0]);
        const c = await p.call('post', '/public/confirm', { clientKey: 'c1', body: { token } });
        assert.strictEqual(c.status, 200, JSON.stringify(c.body));
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}bookings WHERE token = ?`).get(token).status, 'confirmed');
        assert.ok(p.mails.some((m) => m.to === 'owner@site.test'), 'owner notified once confirmed');
    });
});

test('bookings: an unconfirmed booking expires after the TTL and frees its slot', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        assert.strictEqual((await book(p, 'c1', '11:00')).status, 200);
        const token = tokenFromMail(p.mails[0]);
        p.sdb.prepare(`UPDATE ${p.prefix}bookings SET created_at = ?`).run(sqlUtc(Date.now() - 2 * 3600e3));
        assert.ok((await slots(p)).includes('11:00'), 'stale pending booking released the slot');
        const c = await p.call('post', '/public/confirm', { clientKey: 'c1', body: { token } });
        assert.strictEqual(c.status, 410);
    });
});

test('bookings: active future bookings are capped per email and per client', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        for (const [i, t] of ['09:00', '10:00', '11:00'].entries()) {
            assert.strictEqual((await book(p, `e${i}`, t, 'same@x.io')).status, 200);
        }
        const fourth = await book(p, 'e9', '12:00', 'same@x.io');
        assert.strictEqual(fourth.status, 429);
        assert.match(fourth.body.error, /reservas activas/);

        // One client rotating emails: 5 active, the 6th is refused (clock advanced past the attempt window).
        for (const [i, t] of ['12:00', '13:00', '14:00', '15:00', '16:00'].entries()) {
            assert.strictEqual((await book(p, 'rotator', t, `r${i}@x.io`)).status, 200, `booking ${i}`);
        }
        const day2 = localDate(new Date(Date.now() + 2 * 86400e3));
        const sixth = await withClockAdvanced(61e3, () => book(p, 'rotator', '09:00', 'r9@x.io', day2));
        assert.strictEqual(sixth.status, 429);
        assert.match(sixth.body.error, /máximo de reservas activas/);
        assert.strictEqual((await book(p, 'someone-else', '09:00', 'x9@x.io', day2)).status, 200);
    });
});

test('bookings: with no mail transport at all the booking degrades to confirmed and returns its token', async () => {
    // The host's two refusals that mean "this site cannot send mail": no provider registered
    // (core/plugin-api.ts mail()), and the plugin lacking its email:admin grant (verifyPermission).
    const noTransport = [
        'Mail server not available',
        "🛡️ Security Block: Plugin 'bookings' tried to access 'email' (admin) without permission. Declare it in manifest.json first.",
    ];
    for (const message of noTransport) {
        await withPlugin('bookings', async (p) => {
            await seedService(p);
            p.setMailFailure(new Error(message));
            const r = await book(p, 'c1', '10:00');
            assert.strictEqual(r.status, 200, `${message}: ${JSON.stringify(r.body)}`);
            assert.match(String(r.body.token), /^[a-z0-9]{32}$/);
            assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}bookings`).get().status, 'confirmed');
        });
    }
});

// mail-server's sendMail() throws for recipients it refuses; the bridge can also refuse under
// back-pressure. Either used to be read as "no transport": an instantly confirmed, non-expiring
// booking plus its management token, for an address nobody verified.
for (const [label, message] of [
    ['the provider refuses the address', 'Invalid recipient email address format: someone@example.test'],
    ['the bridge refuses under back-pressure', "Isolated plugin 'bookings' exceeded concurrent bridge-call limit"],
]) {
    test(`bookings: a send that fails on a site WITH mail never confirms the booking (${label})`, async () => {
        await withPlugin('bookings', async (p) => {
            await seedService(p);
            p.setMailFailure(new Error(message));
            const r = await book(p, 'c1', '10:00');
            assert.notStrictEqual(r.status, 200, `${message}: the booking was accepted`);
            // A 4xx, not a 502: a CDN or proxy in front of the site may replace a 5xx body with its own
            // page, and the visitor needs this message to fix the address.
            assert.strictEqual(r.status, 422, `${message}: answered ${r.status}`);
            assert.match(String(r.body.error), /correo de confirmación/);
            assert.strictEqual(r.body.token, undefined, `${message}: the management token was handed out`);
            const row = p.sdb.prepare(`SELECT status FROM ${p.prefix}bookings`).get();
            assert.notStrictEqual(row.status, 'confirmed', `${message}: an unverified booking was confirmed`);
            assert.ok((await slots(p)).includes('10:00'), `${message}: the dead booking still holds the slot`);
            // The visitor can retry the same slot at once (e.g. after fixing a typo) once mail works.
            p.setMailFailure(null);
            assert.strictEqual((await book(p, 'c1', '10:00')).status, 200);
            assert.ok(!p.mails.some((m) => m.to === 'owner@site.test'), `${message}: the owner was notified of an unverified booking`);
        });
    });
}

test('bookings: addresses the mail provider always refuses are rejected up front', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        for (const email of ['a@1.2.3.4', 'c@a:b.cd', 'd@[1.2.3.4].x']) {
            const r = await book(p, 'c1', '10:00', email);
            assert.strictEqual(r.status, 400, `${email}: ${JSON.stringify(r.body)}`);
        }
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bookings`).get().n, 0);
    });
});

test('bookings: a concurrent burst cannot exceed the per-email cap', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        // Same address from six clients at once: all six read 0 active bookings before any insert.
        const sameEmail = await Promise.all(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
            .map((t, i) => book(p, `mail-burst-${i}`, t, 'one@x.io')));
        assert.strictEqual(sameEmail.filter((r) => r.status === 200).length, 3, 'more than 3 active bookings for one address');
    });
});

test('bookings: a concurrent burst from one client cannot exceed its unverified cap', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        // One client already holding 4 unverified bookings fires 5 at once (its whole attempt window).
        const day2 = localDate(new Date(Date.now() + 2 * 86400e3));
        const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key)
            VALUES (1, ?, ?, 'X', ?, 'pending', ?, ?, 'burst')`);
        for (const [i, t] of ['09:00', '10:00', '11:00', '12:00'].entries()) ins.run(day2, t, `held${i}@x.io`, `tok${i}`.padEnd(32, '0'), sqlUtc(Date.now()));
        const sameClient = await Promise.all(['13:00', '14:00', '15:00', '16:00'].map((t, i) => book(p, 'burst', t, `b${i}@x.io`, day2))
            .concat([book(p, 'burst', '16:00', 'b9@x.io')]));
        assert.strictEqual(sameClient.filter((r) => r.status === 200).length, 1, 'one client went past 5 unverified bookings');
    });
});

test('bookings: visitors sharing one client key are not locked out by bookings their mailbox verified', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        // Behind a shared NAT (or a proxy missing from trustProxy) every visitor has the same key. A
        // durable per-client cap on all future bookings made the 6th visitor wait until the first
        // five appointments passed (up to 90 days).
        for (const [i, t] of ['09:00', '10:00', '11:00', '12:00', '13:00'].entries()) {
            assert.strictEqual((await book(p, 'nat', t, `person${i}@x.io`)).status, 200);
            const c = await p.call('post', '/public/confirm', { clientKey: 'nat', body: { token: tokenFromMail(p.mails[p.mails.length - 1]) } });
            assert.strictEqual(c.status, 200);
        }
        const sixth = await withClockAdvanced(61e3, () => book(p, 'nat', '14:00', 'person5@x.io'));
        assert.strictEqual(sixth.status, 200, `verified bookings still count against the shared key: ${JSON.stringify(sixth.body)}`);
    });
});

test('bookings: without mail, a shared client key recovers after the unverified window', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        p.setMailFailure(new Error('Mail server not available'));
        for (const [i, t] of ['09:00', '10:00', '11:00', '12:00', '13:00'].entries()) {
            assert.strictEqual((await book(p, 'nat', t, `person${i}@x.io`)).status, 200);
        }
        const sixth = await withClockAdvanced(61e3, () => book(p, 'nat', '14:00', 'person5@x.io'));
        assert.strictEqual(sixth.status, 429, 'unverified bookings are still capped per client');
        p.sdb.prepare(`UPDATE ${p.prefix}bookings SET created_at = ?`).run(sqlUtc(Date.now() - 25 * 3600e3));
        const later = await withClockAdvanced(122e3, () => book(p, 'nat', '15:00', 'person6@x.io'));
        assert.strictEqual(later.status, 200, `the shared key stayed capped until the appointments passed: ${JSON.stringify(later.body)}`);
    });
});

test('bookings: the lookup limiter is per client', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        let last = 0;
        for (let i = 0; i < 61; i++) last = (await p.call('get', '/public/booking', { clientKey: 'scanner', query: { token: 'a'.repeat(32) } })).status;
        assert.strictEqual(last, 429);
        const other = await p.call('get', '/public/booking', { clientKey: 'customer', query: { token: 'a'.repeat(32) } });
        assert.strictEqual(other.status, 404, 'another client still reaches the lookup');
    });
});

// On Postgres each plugin statement autocommits on its own connection under READ COMMITTED: the
// INSERT's NOT EXISTS / COUNT guard reads a snapshot that the INSERTs racing it are not in, so every
// request of a burst passed it and landed. These run on the harness's model of that engine.
const activeAt = (p: BootedPlugin, time: string, date = tomorrow()) => p.sdb.prepare(
    `SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE date = ? AND time = ? AND status NOT IN ('cancelled', 'expired')`).get(date, time).n;

test('bookings (Postgres model): a concurrent burst for one slot books it once', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3)); // far enough ahead to self-cancel
        const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => book(p, `slot-burst-${i}`, '10:00', `s${i}@x.io`, day3)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, `the slot was booked more than once: ${JSON.stringify(burst.map((r) => r.status))}`);
        assert.ok(burst.every((r) => r.status === 200 || r.status === 409), JSON.stringify(burst.map((r) => r.status)));
        assert.strictEqual(activeAt(p, '10:00', day3), 1);
        // The slot is free again once the booking holding it is cancelled: its claim goes with it.
        const token = tokenFromMail(p.mails[0]);
        assert.strictEqual((await p.call('post', '/public/confirm', { clientKey: 'x', body: { token } })).status, 200);
        assert.strictEqual((await p.call('post', '/public/cancel', { clientKey: 'x', body: { token } })).status, 200);
        const again = await book(p, 'later', '10:00', 'later@x.io', day3);
        assert.strictEqual(again.status, 200, JSON.stringify(again.body));
        assert.strictEqual(activeAt(p, '10:00', day3), 1);
    });
});

test('bookings (Postgres model): a concurrent burst cannot pass the per-email cap', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        const sameEmail = await Promise.all(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
            .map((t, i) => book(p, `mail-burst-${i}`, t, 'one@x.io')));
        assert.strictEqual(sameEmail.filter((r) => r.status === 200).length, 3, `more than 3 active bookings for one address: ${JSON.stringify(sameEmail.map((r) => r.status))}`);
        assert.ok(sameEmail.every((r) => r.status === 200 || r.status === 429), JSON.stringify(sameEmail.map((r) => r.status)));
        const active = p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE customer_email = 'one@x.io' AND status IN ('pending', 'confirmed')`).get().n;
        assert.strictEqual(active, 3);
    });
});

test('bookings (Postgres model): a concurrent burst from one client cannot pass its unverified cap', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        for (const [i, t] of ['09:00', '10:00', '11:00'].entries()) {
            assert.strictEqual((await book(p, 'burst', t, `held${i}@x.io`)).status, 200);
        }
        // A new attempt window, three unverified bookings held: five more at once may add only two.
        const day2 = localDate(new Date(Date.now() + 2 * 86400e3));
        const burst = await withClockAdvanced(61e3, () => Promise.all(['09:00', '10:00', '11:00', '12:00', '13:00']
            .map((t, i) => book(p, 'burst', t, `b${i}@x.io`, day2))));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 2, `one client went past 5 unverified bookings: ${JSON.stringify(burst.map((r) => r.status))}`);
        const held = p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE client_key = 'burst' AND status = 'pending'`).get().n;
        assert.strictEqual(held, 5);
    });
});

test('bookings (Postgres model): bookings made before the claim columns existed still count under a burst', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        // Two active future bookings for the address that hold no claim (the 1.0.0 rows after the upgrade).
        const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key)
            VALUES (1, ?, ?, 'Old', 'old@x.io', 'confirmed', ?, ?, '')`);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        ins.run(day3, '09:00', 'o'.repeat(32), sqlUtc(Date.now() - 86400e3));
        ins.run(day3, '10:00', 'p'.repeat(32), sqlUtc(Date.now() - 86400e3));
        const burst = await Promise.all(['09:00', '10:00', '11:00', '12:00'].map((t, i) => book(p, `legacy-${i}`, t, 'old@x.io')));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, `the address went past 3 active bookings: ${JSON.stringify(burst.map((r) => r.status))}`);
    });
});

const ADMIN = { id: 1, role: 'administrator' };
const setBookingStatus = (p: BootedPlugin, id: number, status: string) =>
    p.call('post', '/bookings/:id/status', { user: ADMIN, params: { id: String(id) }, body: { status } });
const activeFor = (p: BootedPlugin, email: string) => p.sdb.prepare(
    `SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE customer_email = ? AND status IN ('pending', 'confirmed')`).get(email).n;
const bookingWithEmailClaim = (p: BootedPlugin, claim: string) =>
    p.sdb.prepare(`SELECT id FROM ${p.prefix}bookings WHERE email_claim = ?`).get(claim).id as number;

/**
 * Run `fn` with Math.random answering from `seq` in turn. The claim picker chooses at random among
 * the claims it offers; cycling the answers makes the requests of a burst spread over every offered
 * claim, so a picker that offers more claims than the cap has room for is caught on every run.
 */
async function withRandomSequence<T>(seq: number[], fn: () => Promise<T>): Promise<T> {
    const real = Math.random;
    let i = 0;
    Math.random = () => seq[i++ % seq.length];
    try { return await fn(); } finally { Math.random = real; }
}
const SPREADS = [[0, 0.99], [0.99, 0], [0.5, 0, 0.99]];

test('bookings (Postgres model): a staff re-open and a cancellation do not let a burst pass the per-email cap', async () => {
    // Reported: re-opening a completed booking added a row that counts toward the cap but holds no
    // claim. Once another booking was cancelled, the picker offered claims 1 and 2 with room for one,
    // and a burst took both: 4 active bookings for a cap of 3.
    for (const spread of SPREADS) {
        await withPluginOnSnapshotEngine('bookings', async (p) => {
            await seedService(p);
            const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
            for (const [i, t] of ['09:00', '10:00', '11:00'].entries()) {
                const r = await book(p, `c${i}`, t, 'e@x.io', day3);
                assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            }
            const first = bookingWithEmailClaim(p, '1|e@x.io');
            const second = bookingWithEmailClaim(p, '2|e@x.io');
            assert.strictEqual((await setBookingStatus(p, first, 'completed')).status, 200);
            assert.strictEqual((await setBookingStatus(p, first, 'confirmed')).status, 200, 're-opening within the cap is allowed');
            assert.strictEqual((await setBookingStatus(p, second, 'cancelled')).status, 200);
            assert.strictEqual(activeFor(p, 'e@x.io'), 2);
            const burst = await withRandomSequence(spread, () => Promise.all(['12:00', '13:00', '14:00', '15:00']
                .map((t, i) => book(p, `burst${i}`, t, 'e@x.io', day3))));
            const statuses = JSON.stringify(burst.map((r) => r.status));
            assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, `spread ${JSON.stringify(spread)}: ${statuses}`);
            assert.ok(burst.every((r) => r.status === 200 || r.status === 429), statuses);
            assert.strictEqual(activeFor(p, 'e@x.io'), 3);
        });
    }
});

test('bookings (Postgres model): rows that count without a claim leave only the lowest free claims on offer', async () => {
    // A row that starts counting without a claim leaves the held claims where they are, not below
    // max − unclaimed (a staff re-open did that before re-opens took a claim; a row edited outside the
    // plugin, e.g. restored from a backup, still can). Here claim 3 is held and one unclaimed row
    // counts, so there is room for ONE more booking. Offering claims 1 and 2 let a burst take both.
    for (const spread of SPREADS) {
        await withPluginOnSnapshotEngine('bookings', async (p) => {
            await seedService(p);
            const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
            const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key, email_claim)
                VALUES (1, ?, ?, 'Held', 'u@x.io', 'confirmed', ?, ?, '', ?)`);
            ins.run(day3, '09:00', 'q'.repeat(32), sqlUtc(Date.now() - 86400e3), null);
            ins.run(day3, '10:00', 'r'.repeat(32), sqlUtc(Date.now() - 86400e3), '3|u@x.io');
            const burst = await withRandomSequence(spread, () => Promise.all(['11:00', '12:00', '13:00', '14:00']
                .map((t, i) => book(p, `u-burst-${i}`, t, 'u@x.io', day3))));
            assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, `spread ${JSON.stringify(spread)}: ${JSON.stringify(burst.map((r) => r.status))}`);
            assert.strictEqual(activeFor(p, 'u@x.io'), 3);
        });
    }
    // An address that already holds MORE active bookings than the cap (possible only for rows from
    // before 1.0.1) is offered nothing: a picker slicing to a negative room would offer claims again.
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key)
            VALUES (1, ?, ?, 'Old', 'over@x.io', 'confirmed', ?, ?, '')`);
        for (const [i, t] of ['09:00', '10:00', '11:00', '12:00'].entries()) ins.run(day3, t, String(i).repeat(32), sqlUtc(Date.now() - 86400e3));
        const r = await book(p, 'over', '13:00', 'over@x.io', day3);
        assert.strictEqual(r.status, 429, JSON.stringify(r.body));
        assert.match(r.body.error, /reservas activas/);
        assert.strictEqual(activeFor(p, 'over@x.io'), 4);
    });
});

test('bookings: a staff re-open is held to the per-email cap', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        for (const [i, t] of ['09:00', '10:00', '11:00'].entries()) assert.strictEqual((await book(p, `r${i}`, t, 'r@x.io', day3)).status, 200);
        const first = bookingWithEmailClaim(p, '1|r@x.io');
        const second = bookingWithEmailClaim(p, '2|r@x.io');
        assert.strictEqual((await setBookingStatus(p, first, 'completed')).status, 200);
        // The customer books again (room for one), then staff tries to re-open the completed booking.
        assert.strictEqual((await book(p, 'r9', '12:00', 'r@x.io', day3)).status, 200);
        assert.strictEqual(activeFor(p, 'r@x.io'), 3);
        const reopen = await setBookingStatus(p, first, 'confirmed');
        assert.strictEqual(reopen.status, 409, `a re-open took the address past its cap: ${JSON.stringify(reopen.body)}`);
        assert.match(reopen.body.error, /reservas activas/);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}bookings WHERE id = ?`).get(first).status, 'completed');
        assert.strictEqual(activeFor(p, 'r@x.io'), 3);
        // With room again, the re-open goes through and counts: the next public booking is refused.
        assert.strictEqual((await setBookingStatus(p, second, 'cancelled')).status, 200);
        assert.strictEqual((await setBookingStatus(p, first, 'confirmed')).status, 200);
        assert.strictEqual(activeFor(p, 'r@x.io'), 3);
        assert.strictEqual((await book(p, 'r10', '13:00', 'r@x.io', day3)).status, 429);
        // A past booking does not count toward the cap: re-opening it is not limited.
        const past = localDate(new Date(Date.now() - 2 * 86400e3));
        p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key)
            VALUES (1, ?, '09:00', 'Past', 'r@x.io', 'completed', ?, ?, '')`).run(past, 'z'.repeat(32), sqlUtc(Date.now() - 3 * 86400e3));
        const pastId = p.sdb.prepare(`SELECT id FROM ${p.prefix}bookings WHERE token = ?`).get('z'.repeat(32)).id;
        assert.strictEqual((await setBookingStatus(p, pastId, 'confirmed')).status, 200);
    });
});

// The staff route read the booking, chose its path from that read, then wrote with a plain
// `UPDATE ... WHERE id = ?`. A booking read as pending (or confirmed) that stopped counting before the
// write — expired by the sweep, or cancelled by its customer — was confirmed again with no claim, and
// once the freed claim had been taken by a new booking the address held one more than its cap.
const bookingIdByToken = (p: BootedPlugin, token: string) =>
    p.sdb.prepare(`SELECT id FROM ${p.prefix}bookings WHERE token = ?`).get(token).id as number;
const bookingRow = (p: BootedPlugin, id: number) =>
    p.sdb.prepare(`SELECT status, email_claim FROM ${p.prefix}bookings WHERE id = ?`).get(id);
const STAFF_READ_RE = /^SELECT customer_email, date, status\b/;

for (const [label, stopsCounting] of [
    ['expires', 'expire'],
    ['is cancelled by its customer', 'cancel'],
] as const) {
    test(`bookings (Postgres model): a staff confirm whose booking ${label} between its read and its write is held to the per-email cap`, async () => {
        await withPluginOnSnapshotEngine('bookings', async (p) => {
            await seedService(p);
            const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
            for (const [i, t] of ['09:00', '10:00', '11:00'].entries()) {
                assert.strictEqual((await book(p, `w${i}`, t, 'w@x.io', day3)).status, 200);
            }
            const [first, second, third] = p.mails.map(tokenFromMail);
            for (const token of [second, third]) {
                assert.strictEqual((await p.call('post', '/public/confirm', { clientKey: 'w', body: { token } })).status, 200);
            }
            const target = bookingIdByToken(p, first);
            if (stopsCounting === 'expire') {
                // Unconfirmed past its TTL; no request has swept it yet, so the staff read sees 'pending'.
                p.sdb.prepare(`UPDATE ${p.prefix}bookings SET created_at = ? WHERE id = ?`).run(sqlUtc(Date.now() - 2 * 3600e3), target);
            } else {
                assert.strictEqual((await p.call('post', '/public/confirm', { clientKey: 'w', body: { token: first } })).status, 200);
            }
            assert.strictEqual(activeFor(p, 'w@x.io'), 3);
            const late = interleaveAfter(p, STAFF_READ_RE, async () => {
                // Between the staff read and its write: the booking stops counting (the sweep a new
                // booking runs, or the customer's own cancellation), and the address books again
                // with the claim that freed.
                if (stopsCounting === 'cancel') {
                    const c = await p.call('post', '/public/cancel', { clientKey: 'w', body: { token: first } });
                    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
                }
                return book(p, 'late', '12:00', 'w@x.io', day3);
            });
            const r = await setBookingStatus(p, target, 'confirmed');
            const lateReply = await late.result();
            assert.strictEqual(lateReply.status, 200, `the interleaved booking was refused: ${JSON.stringify(lateReply.body)}`);
            assert.strictEqual(activeFor(p, 'w@x.io'), 3, `the address went past its cap: staff answered ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
            assert.match(r.body.error, /reservas activas/);
            assert.strictEqual(bookingRow(p, target).status, stopsCounting === 'expire' ? 'expired' : 'cancelled');
        });
    });
}

test('bookings (Postgres model): a staff confirm that loses the race to an expiry re-opens the booking under a claim', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        assert.strictEqual((await book(p, 'v0', '09:00', 'v@x.io', day3)).status, 200);
        const target = bookingIdByToken(p, tokenFromMail(p.mails[0]));
        p.sdb.prepare(`UPDATE ${p.prefix}bookings SET created_at = ? WHERE id = ?`).run(sqlUtc(Date.now() - 2 * 3600e3), target);
        // Another visitor's booking runs the sweep between the staff read and its write.
        const other = interleaveAfter(p, STAFF_READ_RE, () => book(p, 'other', '10:00', 'other@x.io', day3));
        const r = await setBookingStatus(p, target, 'confirmed');
        assert.strictEqual((await other.result()).status, 200);
        // There is room under the cap: the re-read finds the booking expired and re-opens it, which
        // takes an email claim like any re-open.
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const row = bookingRow(p, target);
        assert.strictEqual(row.status, 'confirmed');
        assert.ok(row.email_claim, 'the re-opened booking counts toward the cap without holding a claim');
    });
});

// A re-open did not look at the slot. A staff confirm of a booking that stopped counting — between the
// route's read and its write (the path above), or after the agenda showed it — re-opened it next to the
// booking another visitor had made in the freed slot: two active bookings at one time, staff answered 200.
const activeInSlot = (p: BootedPlugin, date: string, time: string) => p.sdb.prepare(
    `SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE service_id = 1 AND date = ? AND time = ? AND status IN ('pending', 'confirmed')`).get(date, time).n;
const slotClaimOfBooking = (p: BootedPlugin, id: number) =>
    p.sdb.prepare(`SELECT slot_claim FROM ${p.prefix}bookings WHERE id = ?`).get(id).slot_claim;

test('bookings (Postgres model): a staff confirm that loses the race to an expiry never double-books the slot a visitor took meanwhile', async () => {
    await withPluginOnSnapshotEngine('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        assert.strictEqual((await book(p, 'v0', '09:00', 'v@x.io', day3)).status, 200);
        const target = bookingIdByToken(p, tokenFromMail(p.mails[0]));
        p.sdb.prepare(`UPDATE ${p.prefix}bookings SET created_at = ? WHERE id = ?`).run(sqlUtc(Date.now() - 2 * 3600e3), target);
        // Between the staff read (pending) and its write, another visitor's booking sweeps the expired
        // hold and books the very slot it freed.
        const other = interleaveAfter(p, STAFF_READ_RE, () => book(p, 'other', '09:00', 'other@x.io', day3));
        const r = await setBookingStatus(p, target, 'confirmed');
        assert.strictEqual((await other.result()).status, 200);
        assert.strictEqual(activeInSlot(p, day3, '09:00'), 1, `two active bookings in one slot: staff answered ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /horario/);
        assert.strictEqual(bookingRow(p, target).status, 'expired');
    });
});

test('bookings: a staff re-open into a slot another booking holds answers 409; once the slot is free it re-claims it', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        assert.strictEqual((await book(p, 'v0', '09:00', 'v@x.io', day3)).status, 200);
        const first = tokenFromMail(p.mails[0]);
        const target = bookingIdByToken(p, first);
        // The customer cancels; the agenda still shows the booking when another visitor takes the slot.
        assert.strictEqual((await p.call('post', '/public/cancel', { clientKey: 'v0', body: { token: first } })).status, 200);
        assert.strictEqual((await book(p, 'other', '09:00', 'other@x.io', day3)).status, 200);
        const otherToken = tokenFromMail(p.mails[1]);
        const r = await setBookingStatus(p, target, 'confirmed');
        assert.strictEqual(activeInSlot(p, day3, '09:00'), 1, `two active bookings in one slot: staff answered ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /horario/);
        assert.strictEqual(bookingRow(p, target).status, 'cancelled');
        // The other booking is cancelled: the re-open goes through and holds the slot like any booking.
        assert.strictEqual((await p.call('post', '/public/cancel', { clientKey: 'other', body: { token: otherToken } })).status, 200);
        const again = await setBookingStatus(p, target, 'confirmed');
        assert.strictEqual(again.status, 200, JSON.stringify(again.body));
        assert.strictEqual(slotClaimOfBooking(p, target), `1|${day3}|09:00`);
        const late = await book(p, 'late', '09:00', 'late@x.io', day3);
        assert.strictEqual(late.status, 409, JSON.stringify(late.body));
        assert.strictEqual(activeInSlot(p, day3, '09:00'), 1);
    });
});

test('bookings: a visitor booking the slot while staff re-opens it leaves one active booking there', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        assert.strictEqual((await book(p, 'v0', '09:00', 'v@x.io', day3)).status, 200);
        const first = tokenFromMail(p.mails[0]);
        const target = bookingIdByToken(p, first);
        assert.strictEqual((await p.call('post', '/public/cancel', { clientKey: 'v0', body: { token: first } })).status, 200);
        // The visitor's booking lands while the re-open's UPDATE is in flight, after the re-open found
        // the slot free: the slot claim the UPDATE takes is what settles it.
        const visitor = interleaveBefore(p, /^UPDATE \w+bookings SET status = 'confirmed', client_key = '', client_claim = NULL, email_claim = \?/,
            () => book(p, 'other', '09:00', 'other@x.io', day3));
        const r = await setBookingStatus(p, target, 'confirmed');
        const visitorReply = await visitor.result();
        assert.strictEqual(activeInSlot(p, day3, '09:00'), 1, `two active bookings in one slot: staff ${r.status}, visitor ${visitorReply.status}`);
        assert.strictEqual(countOf([r.status, visitorReply.status], 200), 1, JSON.stringify([r.body, visitorReply.body]));
    });
});

test('bookings (MySQL collation model): a claim the index folds into another address is never offered as free', async () => {
    // utf8mb4_unicode_ci makes '1|josé@x.io' and '1|jose@x.io' one key of the unique index, while the
    // picker compared the strings in JavaScript: it kept offering claim 1 to the second spelling, the
    // index kept refusing it, and after six attempts the visitor got a 500. The upper-case spelling
    // plays the accented twin here (SQLite's NOCASE folds ASCII case only).
    const p = await bootPlugin('bookings', { caseInsensitiveText: true });
    try {
        await seedService(p);
        const day3 = localDate(new Date(Date.now() + 3 * 86400e3));
        const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}bookings (service_id, date, time, customer_name, customer_email, status, token, created_at, client_key, slot_claim, email_claim)
            VALUES (1, ?, ?, 'Twin', 'JOSE@X.IO', 'confirmed', ?, ?, '', ?, ?)`);
        ins.run(day3, '09:00', 'j'.repeat(32), sqlUtc(Date.now()), `1|${day3}|09:00`, '1|JOSE@X.IO');
        ins.run(day3, '10:00', 'k'.repeat(32), sqlUtc(Date.now()), `1|${day3}|10:00`, '2|JOSE@X.IO');
        // Math.random → 0: the picker takes the first claim it offers, every time.
        const r = await withRandomSequence([0], () => book(p, 'twin', '12:00', 'jose@x.io', day3));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        // The collation counts both spellings as one address, as the index does: the cap is now full.
        const again = await withRandomSequence([0], () => book(p, 'twin2', '13:00', 'jose@x.io', day3));
        assert.strictEqual(again.status, 429, JSON.stringify(again.body));
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}bookings WHERE customer_email = 'jose@x.io' AND status IN ('pending', 'confirmed')`).get().n, 3);
    } finally { p.close(); }
});

test('bookings: claims that keep colliding answer 409, never a 500', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        // An index that refuses every claim the picker sees as free (the class of the collation twin).
        p.sdb.exec(`CREATE TRIGGER ${p.prefix}refuse_claims BEFORE INSERT ON ${p.prefix}bookings
            BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: ${p.prefix}bookings.email_claim'); END`);
        const r = await book(p, 'c1', '10:00', 'one@x.io');
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.doesNotMatch(JSON.stringify(r.body), /constraint|wjp_/i);
        // Any other failure is still an error, answered without the driver's text.
        p.sdb.exec(`DROP TRIGGER ${p.prefix}refuse_claims`);
        p.sdb.exec(`CREATE TRIGGER ${p.prefix}broken BEFORE INSERT ON ${p.prefix}bookings
            BEGIN SELECT RAISE(ABORT, 'disk I/O error in ${p.prefix}bookings'); END`);
        const broken = await book(p, 'c2', '11:00', 'two@x.io');
        assert.strictEqual(broken.status, 500);
        assert.doesNotMatch(JSON.stringify(broken.body), /disk|wjp_/i);
    });
});

// ================================== job-board =================================================

async function seedJob(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}jobs (title, slug, description, apply_email, is_published) VALUES ('Dev', 'dev', 'Code', 'hr@site.test', 1)`).run();
}
const apply = (p: BootedPlugin, clientKey: string, email: string) =>
    p.call('post', '/public/apply', { clientKey, body: { job_id: 1, name: 'Ana', email, elapsed: 5000 } });
const applications = (p: BootedPlugin) => p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}applications`).get().n;

test('job-board: a concurrent burst from one client is held to its cap and never locks out other applicants', async () => {
    await withPlugin('job-board', async (p) => {
        await seedJob(p);
        // The cap was checked before the job lookup and counted after the INSERT: 40 simultaneous
        // applications from one client all passed the 10/min check, all were stored and each mailed
        // apply_email — and the full window then answered 429 to every other applicant.
        const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => apply(p, 'flooder', `f${i}@x.io`)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 10, 'one client stored more than 10 applications a minute');
        assert.strictEqual(applications(p), 10);
        assert.strictEqual(p.mails.filter((m) => m.to === 'hr@site.test').length, 10, 'apply_email got more than 10 mails from one client');
        const other = await apply(p, 'applicant', 'real@x.io');
        assert.strictEqual(other.status, 200, `another applicant was locked out: ${JSON.stringify(other.body)}`);
    });
});

test('job-board: the cap is per client and refused applications do not use it up', async () => {
    await withPlugin('job-board', async (p) => {
        await seedJob(p);
        const { flooder, bystander } = await floodThenBystander(12, (c, i) => apply(p, c, `${c}${i}@x.io`));
        assert.strictEqual(bystander.status, 200, `one client's applications closed the form for everyone: ${JSON.stringify(bystander.body)}`);
        assert.deepStrictEqual([countOf(flooder, 200), countOf(flooder, 429)], [10, 2]);
        // A duplicate (409) is refunded: the client still has its whole window afterwards.
        assert.strictEqual((await apply(p, 'dup', 'same@x.io')).status, 200);
        for (let i = 0; i < 12; i++) assert.strictEqual((await apply(p, 'dup', 'same@x.io')).status, 409);
        for (let i = 0; i < 9; i++) assert.strictEqual((await apply(p, 'dup', `d${i}@x.io`)).status, 200, `application ${i}`);
        assert.strictEqual((await apply(p, 'dup', 'd-last@x.io')).status, 429);
    });
});

test('job-board (Postgres model): one application per job and email under a concurrent burst', async () => {
    await withPluginOnSnapshotEngine('job-board', async (p) => {
        await seedJob(p);
        // The NOT EXISTS guard alone reads a snapshot without the racing INSERTs: all 8 landed.
        const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => apply(p, `c${i}`, 'same@x.io')));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, `duplicates stored: ${JSON.stringify(burst.map((r) => r.status))}`);
        assert.ok(burst.every((r) => r.status === 200 || r.status === 409), JSON.stringify(burst.map((r) => r.status)));
        assert.strictEqual(applications(p), 1);
    });
});

// ================================== polls =====================================================

const vote = (p: BootedPlugin, clientKey: string, optionId: number) =>
    p.call('post', '/public/vote', { clientKey, body: { poll_id: 1, option_id: optionId } });

test('polls: a concurrent burst from one client casts one vote and cannot fill the poll\'s window', async () => {
    await withPlugin('polls', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}polls (question, options, is_open) VALUES ('Q?', ?, 1)`)
            .run(JSON.stringify([{ id: 1, label: 'A' }, { id: 2, label: 'B' }]));
        // The one-vote-per-client mark and the 30/min window were both recorded only after the
        // INSERT: 40 simultaneous votes from one client all landed, then the window refused everyone.
        const burst = await Promise.all(Array.from({ length: 40 }, () => vote(p, 'stuffer', 1)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, 'one client cast more than one vote');
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}votes`).get().n, 1);
        const other = await vote(p, 'voter', 2);
        assert.strictEqual(other.status, 200, `another voter was locked out: ${JSON.stringify(other.body)}`);
        // A vote that is refused (unknown option) is refunded: the client can still vote.
        assert.strictEqual((await vote(p, 'typo', 9)).status, 400);
        assert.strictEqual((await vote(p, 'typo', 1)).status, 200);
    });
});

// ================================== site-wide windows -> per client ===========================

test('digital-downloads: orders, downloads and status lookups are limited per client', async () => {
    await withPlugin('digital-downloads', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, file_url, is_published) VALUES ('Ebook', 'ebook', 0, '/uploads/e.pdf', 1)`).run();
        const order = (c: string, i: number) => p.call('post', '/public/order', {
            clientKey: c, body: { product_id: 1, customer_email: `${c}${i}@x.io`, customer_name: 'Ana', elapsed: 5000 },
        });
        const orders = await floodThenBystander(15, order);
        assert.strictEqual(orders.bystander.status, 200, `one client closed the shop: ${JSON.stringify(orders.bystander.body)}`);
        assert.deepStrictEqual([countOf(orders.flooder, 200), countOf(orders.flooder, 429)], [10, 5]);
        const token = orders.bystander.body.token;

        const download = await floodThenBystander(61, (c) => p.call('get', '/public/download', { clientKey: c, query: { token: c === 'flooder' ? 'Z'.repeat(32) : token } }));
        assert.strictEqual(download.flooder[60], 429);
        assert.strictEqual(download.bystander.status, 200, `one client's guesses blocked a buyer's download: ${JSON.stringify(download.bystander.body)}`);
        assert.strictEqual(download.bystander.body.url, '/uploads/e.pdf');

        const status = await floodThenBystander(121, (c) => p.call('get', '/public/status', { clientKey: c, query: { token: c === 'flooder' ? 'Z'.repeat(32) : token } }));
        assert.strictEqual(status.flooder[120], 429);
        assert.strictEqual(status.bystander.status, 200);
    });
});

test('digital-downloads: the mails one address receives are bounded, whatever clients order', async () => {
    await withPlugin('digital-downloads', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}products (name, slug, price_cents, file_url, is_published) VALUES ('Ebook', 'ebook', 0, '/uploads/e.pdf', 1)`).run();
        // Per-client limits alone let rotating clients aim any number of download mails at one inbox.
        const replies = [];
        for (let i = 0; i < 8; i++) {
            replies.push(await p.call('post', '/public/order', {
                clientKey: `client-${i}`, body: { product_id: 1, customer_email: 'victim@x.io', elapsed: 5000 },
            }));
        }
        assert.ok(replies.every((r) => r.status === 200 && /^[a-f0-9]{32}$/.test(r.body.token)), 'every order still gets its token on screen');
        assert.strictEqual(p.mails.filter((m) => m.to === 'victim@x.io').length, 5, 'one address got more than 5 mails an hour');
        assert.deepStrictEqual(replies.map((r) => r.body.emailSent), [true, true, true, true, true, false, false, false]);
    });
});

test('restaurant-menu: reservations, orders and lookups are limited per client', async () => {
    await withPlugin('restaurant-menu', async (p) => {
        p.options.set('restaurant_menu_config', { reservationsEnabled: true, orderingEnabled: true });
        p.sdb.prepare(`INSERT INTO ${p.prefix}sections (name, is_active) VALUES ('Mains', 1)`).run();
        p.sdb.prepare(`INSERT INTO ${p.prefix}items (section_id, name, price_cents, is_available) VALUES (1, 'Soup', 500, 1)`).run();
        const reserve = (c: string, i: number) => p.call('post', '/public/reservation', {
            clientKey: c, body: { customer_name: 'Ana', customer_phone: '+34 600 000 000', party_size: 2, date: tomorrow(), time: `${String(10 + (i % 10)).padStart(2, '0')}:00` },
        });
        const reservations = await floodThenBystander(15, reserve);
        assert.strictEqual(reservations.bystander.status, 200, `one client closed reservations for everyone: ${JSON.stringify(reservations.bystander.body)}`);
        assert.deepStrictEqual([countOf(reservations.flooder, 200), countOf(reservations.flooder, 429)], [5, 10]);

        const orderFood = (c: string) => p.call('post', '/public/order', {
            clientKey: c, body: { customer_name: 'Ana', customer_phone: '+34 600 000 000', delivery_type: 'pickup', items: [{ item_id: 1, qty: 1 }] },
        });
        const orders = await floodThenBystander(31, orderFood);
        assert.strictEqual(orders.bystander.status, 200, `one client closed ordering for everyone: ${JSON.stringify(orders.bystander.body)}`);
        assert.deepStrictEqual([countOf(orders.flooder, 200), countOf(orders.flooder, 429)], [30, 1]);

        const lookups = await floodThenBystander(61, (c) => p.call('get', '/public/order-status', { clientKey: c, query: { token: orders.bystander.body.token } }));
        assert.strictEqual(lookups.flooder[60], 429);
        assert.strictEqual(lookups.bystander.status, 200);
    });
});

test('donations: the donation and Stripe-return limits are per client', async () => {
    await withPlugin('donations', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}campaigns (title, slug, goal_cents, is_active) VALUES ('Roof', 'roof', 100000, 1)`).run();
        const donate = (c: string, i: number) => p.call('post', '/public/donate', {
            clientKey: c, body: { campaign_id: 1, amount_cents: 1000, donor_name: 'Ana', donor_email: `${c}${i}@x.io`, elapsed: 5000 },
        });
        const donations = await floodThenBystander(15, donate);
        assert.strictEqual(donations.bystander.status, 200, `one client closed donations for everyone: ${JSON.stringify(donations.bystander.body)}`);
        assert.deepStrictEqual([countOf(donations.flooder, 200), countOf(donations.flooder, 429)], [10, 5]);

        const confirms = await floodThenBystander(60, (c) => p.call('get', '/public/confirm-stripe', { clientKey: c, query: { session_id: 'cs_x', token: 'nope' } }));
        assert.strictEqual(confirms.bystander.status, 404, 'one client closed the Stripe return leg for every donor');
        assert.deepStrictEqual([countOf(confirms.flooder, 404), countOf(confirms.flooder, 429)], [20, 40]);
    });
});

test('donations: two admins marking a donation paid at the same time mail one receipt', async () => {
    // The admin route decided "receipt or not" from its read and wrote with a plain UPDATE: both
    // requests read 'pending' and both mailed the donor (the Stripe return leg's flip was already
    // conditional and gated its receipt on result.changes).
    await withPlugin('donations', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}campaigns (title, slug, goal_cents, is_active) VALUES ('Roof', 'roof', 100000, 1)`).run();
        const d = await p.call('post', '/public/donate', {
            clientKey: 'donor', body: { campaign_id: 1, amount_cents: 1000, donor_name: 'Ana', donor_email: 'ana@x.io', elapsed: 5000 },
        });
        assert.strictEqual(d.status, 200, JSON.stringify(d.body));
        const id = p.sdb.prepare(`SELECT id FROM ${p.prefix}donations`).get().id;
        const mark = (status: string) => p.call('post', '/donations/:id/payment', { user: { id: 1, role: 'administrator' }, params: { id: String(id) }, body: { payment_status: status } });
        const receipts = () => p.mails.filter((m) => m.subject === 'Recibo de tu donación — Roof').length;
        const raised = () => p.sdb.prepare(`SELECT raised_cents FROM ${p.prefix}campaigns WHERE id = 1`).get().raised_cents;
        const both = await Promise.all([mark('paid'), mark('paid')]);
        assert.deepStrictEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body)));
        assert.strictEqual(receipts(), 1, 'one payment, one receipt');
        assert.strictEqual(raised(), 1000);
        // The other statuses still move freely, and paying again after a correction mails again.
        assert.strictEqual((await mark('pending')).status, 200);
        assert.strictEqual(raised(), 0);
        assert.strictEqual((await mark('paid')).status, 200);
        assert.strictEqual(receipts(), 2);
        assert.strictEqual(raised(), 1000);
    });
});

test('contact-forms: one client cannot close a form for every visitor', async () => {
    await withPlugin('contact-forms', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}forms (name, fields) VALUES ('Contact', ?)`)
            .run(JSON.stringify([{ name: 'msg', label: 'Mensaje', type: 'text', required: true }]));
        const submit = (c: string, i: number) => p.call('post', '/public/submit', { clientKey: c, body: { form_id: 1, data: { msg: `hello ${i}` }, elapsed: 5000 } });
        const { flooder, bystander } = await floodThenBystander(10, submit);
        assert.strictEqual(bystander.status, 200, `one client closed the form: ${JSON.stringify(bystander.body)}`);
        assert.deepStrictEqual([countOf(flooder, 200), countOf(flooder, 429)], [5, 5]);
    });
});

test('testimonials: one client cannot close public submissions for every visitor', async () => {
    await withPlugin('testimonials', async (p) => {
        p.options.set('testimonials_settings', { allowPublicSubmit: true });
        const submit = (c: string, i: number) => p.call('post', '/public/submit', { clientKey: c, body: { author_name: 'Ana', content: `great ${i}`, elapsed: 5000 } });
        const { flooder, bystander } = await floodThenBystander(10, submit);
        assert.strictEqual(bystander.status, 200, `one client closed the form: ${JSON.stringify(bystander.body)}`);
        assert.deepStrictEqual([countOf(flooder, 200), countOf(flooder, 429)], [5, 5]);
    });
});

test('vendor-marketplace: vendor applications and buyer inquiries are limited per client', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        const applyAsVendor = (c: string, i: number) => p.call('post', '/public/apply', { clientKey: c, body: { name: `Shop ${c} ${i}`, email: `${c}${i}@x.io`, elapsed: 5000 } });
        const applies = await floodThenBystander(5, applyAsVendor);
        assert.strictEqual(applies.bystander.status, 200, `one client closed vendor applications: ${JSON.stringify(applies.bystander.body)}`);
        assert.deepStrictEqual([countOf(applies.flooder, 200), countOf(applies.flooder, 429)], [3, 2]);

        p.sdb.prepare(`UPDATE ${p.prefix}vendors SET status = 'approved'`).run();
        p.sdb.prepare(`INSERT INTO ${p.prefix}products (vendor_id, name, price_cents, is_published) VALUES (1, 'Lamp', 500, 1)`).run();
        const inquire = (c: string, i: number) => p.call('post', '/public/inquiry', {
            clientKey: c, body: { product_id: 1, buyer_name: 'Ana', buyer_email: `${c}${i}@x.io`, message: 'Is it available?', elapsed: 5000 },
        });
        const inquiries = await floodThenBystander(10, inquire);
        assert.strictEqual(inquiries.bystander.status, 200, `one client closed buyer inquiries: ${JSON.stringify(inquiries.bystander.body)}`);
        assert.deepStrictEqual([countOf(inquiries.flooder, 200), countOf(inquiries.flooder, 429)], [5, 5]);
    });
});

test('popup-builder and cookie-consent: one client cannot keep everyone else out of the stats', async () => {
    await withPlugin('popup-builder', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}popups (title, enabled) VALUES ('Promo', 1)`).run();
        const { flooder, bystander } = await floodThenBystander(120, (c) => p.call('post', '/public/event', { clientKey: c, body: { popup_id: 1, event: 'view' } }));
        assert.strictEqual(bystander.status, 200, 'a real view was refused after one client filled the window');
        assert.deepStrictEqual([countOf(flooder, 200), countOf(flooder, 429)], [30, 90]);
        assert.strictEqual(p.sdb.prepare(`SELECT views FROM ${p.prefix}popups WHERE id = 1`).get().views, 31);
    });
    await withPlugin('cookie-consent', async (p) => {
        const { flooder, bystander } = await floodThenBystander(60, (c) => p.call('post', '/public/log', { clientKey: c, body: { choice: 'rejected' } }));
        assert.strictEqual(bystander.status, 200, 'a real choice was refused after one client filled the window');
        assert.deepStrictEqual([countOf(flooder, 200), countOf(flooder, 429)], [10, 50]);
    });
});

// ================================== invoices ==================================================

test('invoices: wrong-token failures throttle only the client making them', async () => {
    await withPlugin('invoices', async (p) => {
        const token = 'A'.repeat(16) + 'b'.repeat(16);
        p.sdb.prepare(`INSERT INTO ${p.prefix}invoices (number, token, client_name, items, status, total_cents) VALUES ('F-1', ?, 'Cliente', '[]', 'sent', 1000)`).run(token);
        for (let i = 0; i < 60; i++) {
            assert.strictEqual((await p.call('get', '/public/view', { clientKey: 'guesser', query: { token: 'Z'.repeat(32) } })).status, 404);
        }
        assert.strictEqual((await p.call('get', '/public/view', { clientKey: 'guesser', query: { token: 'Z'.repeat(32) } })).status, 429);
        const customer = await p.call('get', '/public/view', { clientKey: 'customer', query: { token } });
        assert.strictEqual(customer.status, 200, JSON.stringify(customer.body));
        assert.strictEqual(customer.body.invoice.number, 'F-1');
    });
});

test('invoices: a concurrent burst of wrong tokens is held to the failure budget', async () => {
    await withPlugin('invoices', async (p) => {
        const token = 'A'.repeat(16) + 'b'.repeat(16);
        p.sdb.prepare(`INSERT INTO ${p.prefix}invoices (number, token, client_name, items, status, total_cents) VALUES ('F-1', ?, 'Cliente', '[]', 'sent', 1000)`).run(token);
        // Counted only after the lookup's await, 200 simultaneous guesses all passed the 60-failure check.
        const guesses = await Promise.all(Array.from({ length: 200 }, (_, i) =>
            p.call('get', '/public/view', { clientKey: 'guesser', query: { token: String(i).padStart(32, 'Z') } })));
        assert.strictEqual(guesses.filter((r) => r.status === 404).length, 60, 'more wrong tokens were tried than the window allows');
        // Valid links are not charged against the budget.
        for (let i = 0; i < 70; i++) {
            assert.strictEqual((await p.call('get', '/public/view', { clientKey: 'customer', query: { token } })).status, 200);
        }
    });
});

// ================================== vendor-marketplace ========================================

test('vendor-marketplace: a vendor cannot republish a product the admin hid; protocol-relative URLs are refused', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}vendors (name, slug, email, access_code, status) VALUES ('Shop', 'shop', 'v@x.io', '123456', 'approved')`).run();
        const portal = { 'x-portal-token': Buffer.from(`1:123456:${Date.now() + 3600e3}`).toString('base64') };
        const created = await p.call('post', '/portal/products', { headers: portal, body: { name: 'Lamp', price_cents: 500 } });
        assert.strictEqual(created.status, 200, JSON.stringify(created.body));
        const id = created.body.id;
        const publicNames = async () => ((await p.call('get', '/public/products')).body as any[]).map((x) => x.name);
        assert.deepStrictEqual(await publicNames(), ['Lamp']);

        const admin = { id: 1, role: 'administrator' };
        assert.strictEqual((await p.call('post', '/products/:id/publish', { params: { id }, user: admin, body: { is_published: 0 } })).status, 200);
        const sneaky = await p.call('post', '/portal/products', { headers: portal, body: { id, name: 'Lamp', price_cents: 500, is_published: 1 } });
        assert.strictEqual(sneaky.status, 200);
        assert.deepStrictEqual(await publicNames(), [], 'admin moderation survives the vendor update');

        assert.strictEqual((await p.call('post', '/products/:id/publish', { params: { id }, user: admin, body: { is_published: 1 } })).status, 200);
        assert.deepStrictEqual(await publicNames(), ['Lamp'], 'the admin can publish it again');

        for (const bad of ['//evil.host/x.png', '/\\evil.host/x.png', 'javascript:alert(1)', 'https://evil host/x.png']) {
            const r = await p.call('post', '/portal/products', { headers: portal, body: { name: 'X', price_cents: 1, image_url: bad } });
            assert.strictEqual(r.status, 400, `refused: ${bad}`);
        }
        for (const good of ['/uploads/x.png', 'https://cdn.site.test/x.png']) {
            const r = await p.call('post', '/portal/products', { headers: portal, body: { name: 'Y', price_cents: 1, image_url: good } });
            assert.strictEqual(r.status, 200, `accepted: ${good}`);
        }
    });
});

const applyStore = (p: BootedPlugin, clientKey: string, name: string, email: string, extra: any = {}) =>
    p.call('post', '/public/apply', { clientKey, body: { name, email, elapsed: 5000, ...extra } });
const storesWith = (p: BootedPlugin, email: string) => p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}vendors WHERE email = ?`).get(email).n;
/** A response that leaks a driver's or the host's error text (table names, SQL, constraint names). */
const LEAK_RE = /no such|wjp_|sqlite|constraint|syntax|duplicate/i;

test('vendor-marketplace: simultaneous applications for one address store one store', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        // The duplicate check ran before an await (the slug lookup) and the INSERT after it, so every
        // request of a burst passed the check: three pending stores for one address.
        const burst = await Promise.all(['a', 'b', 'c'].map((c, i) => applyStore(p, `apply-${c}`, `Tienda ${i}`, 'owner@x.io')));
        assert.deepStrictEqual(burst.map((r) => r.status), [200, 200, 200], JSON.stringify(burst.map((r) => r.body)));
        assert.strictEqual(storesWith(p, 'owner@x.io'), 1);
        // Same spelling rules as the routes: trimmed and lower-cased.
        assert.strictEqual((await applyStore(p, 'apply-d', 'Otra', '  OWNER@x.io ')).status, 200);
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}vendors`).get().n, 1);
    });
});

test('vendor-marketplace: simultaneous applications with one store name are all stored, and errors never echo the driver', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        // uniqueSlug read "free" for each request, the second INSERT hit the UNIQUE slug and the visitor
        // got 500 { error: 'UNIQUE constraint failed: wjp_vendor_marketplace_vendors.slug' }.
        const burst = await Promise.all(['x', 'y', 'z'].map((c) => applyStore(p, `same-name-${c}`, 'Tienda Sol', `${c}@x.io`)));
        for (const r of burst) {
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.doesNotMatch(JSON.stringify(r.body), LEAK_RE);
        }
        const slugs = p.sdb.prepare(`SELECT slug FROM ${p.prefix}vendors ORDER BY id`).all().map((r: any) => r.slug);
        assert.strictEqual(slugs.length, 3);
        assert.strictEqual(new Set(slugs).size, 3, JSON.stringify(slugs));
    });
});

test('vendor-marketplace: the application reply does not tell whether an address already has a store', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        const fresh = await applyStore(p, 'probe-1', 'Tienda Uno', 'known@x.io');
        const again = await applyStore(p, 'probe-2', 'Tienda Dos', 'known@x.io');
        const spam = await applyStore(p, 'probe-3', 'Tienda Tres', 'other@x.io', { hp: 'bot' });
        assert.deepStrictEqual([fresh.status, again.status, spam.status], [200, 200, 200]);
        assert.deepStrictEqual(again.body, fresh.body, 'a duplicate address answered differently from a new one');
        assert.deepStrictEqual(spam.body, fresh.body);
        assert.strictEqual(storesWith(p, 'known@x.io'), 1);
        assert.strictEqual(storesWith(p, 'other@x.io'), 0);
    });
});

test('vendor-marketplace: the admin cannot put two stores on one address at the same time', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        const create = (name: string, email: string) => p.call('post', '/vendors', { user: ADMIN, body: { name, email } });
        const both = await Promise.all([create('Uno', 'same@x.io'), create('Dos', 'same@x.io')]);
        assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
        assert.strictEqual(storesWith(p, 'same@x.io'), 1);
        // Twin: two simultaneous edits moving two stores onto one free address.
        const a = (await create('Tres', 'a@x.io')).body.id;
        const b = (await create('Cuatro', 'b@x.io')).body.id;
        const edits = await Promise.all([a, b].map((id) => p.call('put', '/vendors/:id', { user: ADMIN, params: { id: String(id) }, body: { email: 'target@x.io' } })));
        assert.deepStrictEqual(edits.map((r) => r.status).sort(), [200, 409], JSON.stringify(edits.map((r) => r.body)));
        assert.strictEqual(storesWith(p, 'target@x.io'), 1);
        // The address a store moved away from is free again.
        assert.strictEqual((await create('Cinco', edits[0].status === 200 ? 'a@x.io' : 'b@x.io')).status, 200);
    });
});

test('vendor-marketplace: re-approving a store never brings back the access code a rotation retired', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        // Approve read the store's code and wrote it back; a rotation landing in between was undone.
        const created = await p.call('post', '/vendors', { user: ADMIN, body: { name: 'Tienda', email: 'shop@x.io' } });
        assert.strictEqual(created.status, 200, JSON.stringify(created.body));
        const id = String(created.body.id);
        const retired = String(created.body.access_code);
        assert.strictEqual((await p.call('post', '/vendors/:id/suspend', { user: ADMIN, params: { id } })).status, 200);
        const rotation = interleaveAfter(p, /^SELECT (\*|id) FROM \w+vendors WHERE id = \?$/,
            () => p.call('post', '/vendors/:id/rotate-code', { user: ADMIN, params: { id } }));
        const approve = await p.call('post', '/vendors/:id/approve', { user: ADMIN, params: { id } });
        const rotated = await rotation.result();
        assert.strictEqual(rotated.status, 200, JSON.stringify(rotated.body));
        assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
        const current = String(rotated.body.access_code);
        assert.notStrictEqual(current, retired);
        const login = (code: string) => p.call('post', '/portal/login', { clientKey: 'vendor', body: { vendor_id: Number(id), code } });
        assert.strictEqual((await login(retired)).status, 401, 'the code the rotation retired opens the portal again');
        assert.strictEqual((await login(current)).status, 200, 'the rotated code was undone');
        // The approval hands out (and mails) the code that works.
        assert.strictEqual(String(approve.body.access_code), current);
        const mail = p.mails.find((m) => /aprobada/.test(m.subject));
        assert.ok(mail && String(mail.text).includes(current), 'the approval mail carries a code that does not open the portal');
        // A store approved for the first time (an application holds no code) gets a fresh one.
        assert.strictEqual((await applyStore(p, 'applicant', 'Nueva', 'new@x.io')).status, 200);
        const newId = p.sdb.prepare(`SELECT id FROM ${p.prefix}vendors WHERE email = 'new@x.io'`).get().id;
        const first = await p.call('post', '/vendors/:id/approve', { user: ADMIN, params: { id: String(newId) } });
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.match(String(first.body.access_code), /^\d{6}$/);
        const firstLogin = await p.call('post', '/portal/login', { clientKey: 'new-vendor', body: { vendor_id: newId, code: String(first.body.access_code) } });
        assert.strictEqual(firstLogin.status, 200, JSON.stringify(firstLogin.body));
    });
});

test('vendor-marketplace: public and portal errors never echo the driver\'s message', async () => {
    await withPlugin('vendor-marketplace', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}vendors (name, slug, email, access_code, status) VALUES ('Shop', 'shop', 'v@x.io', '123456', 'approved')`).run();
        const portal = { 'x-portal-token': Buffer.from(`1:123456:${Date.now() + 3600e3}`).toString('base64') };
        const quiet = (label: string, r: Reply) => {
            assert.strictEqual(r.status, 500, `${label}: ${JSON.stringify(r.body)}`);
            assert.doesNotMatch(JSON.stringify(r.body), LEAK_RE, label);
        };
        p.sdb.exec(`DROP TABLE ${p.prefix}inquiries; DROP TABLE ${p.prefix}products; DROP TABLE ${p.prefix}settings`);
        quiet('GET /public/config', await p.call('get', '/public/config'));
        quiet('GET /public/vendors', await p.call('get', '/public/vendors'));
        quiet('GET /public/products', await p.call('get', '/public/products'));
        quiet('POST /public/inquiry', await p.call('post', '/public/inquiry', { clientKey: 'buyer', body: { product_id: 1, buyer_name: 'Ana', buyer_email: 'ana@x.io', message: 'Hola', elapsed: 5000 } }));
        quiet('GET /portal/products', await p.call('get', '/portal/products', { headers: portal }));
        quiet('POST /portal/products', await p.call('post', '/portal/products', { headers: portal, body: { name: 'Lamp', price_cents: 500 } }));
        quiet('DELETE /portal/products/:id', await p.call('delete', '/portal/products/:id', { headers: portal, params: { id: '1' } }));
        quiet('GET /portal/inquiries', await p.call('get', '/portal/inquiries', { headers: portal }));
        quiet('POST /portal/inquiries/:id/status', await p.call('post', '/portal/inquiries/:id/status', { headers: portal, params: { id: '1' }, body: { status: 'closed' } }));
        p.sdb.exec(`DROP TABLE ${p.prefix}vendors`);
        quiet('POST /portal/login', await p.call('post', '/portal/login', { body: { vendor_id: 1, code: '123456' } }));
        quiet('POST /public/apply', await applyStore(p, 'late', 'Tienda', 'late@x.io'));
    });
});

// ================================== newsletter ================================================

test('newsletter: a failed confirmation mail leaves the subscriber pending and is surfaced to the admin', async () => {
    await withPlugin('newsletter', async (p) => {
        p.setMailFailure(new Error('SMTP down'));
        const r = await p.call('post', '/public/subscribe', { body: { email: 'victim@x.io', name: 'V' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}subscribers WHERE email = 'victim@x.io'`).get().status, 'pending');
        const list = await p.call('get', '/subscribers', { user: { id: 1, role: 'administrator' } });
        assert.strictEqual(list.body.stats.confirmed, 0);
        assert.match(String(list.body.confirmMailError && list.body.confirmMailError.message), /SMTP down/);
    });
});

const subscribe = (p: BootedPlugin, clientKey: string, email: string) =>
    p.call('post', '/public/subscribe', { clientKey, body: { email, name: 'N', page_url: 'http://site.test/' } });

test('newsletter: one client flooding the subscribe form does not close it for other visitors', async () => {
    await withPlugin('newsletter', async (p) => {
        // The old limiter was ONE site-wide window of 20 a minute: the flood below closed the form for
        // everybody. Now the flooder alone is throttled.
        const statuses: number[] = [];
        for (let i = 0; i < 25; i++) statuses.push((await subscribe(p, 'flooder', `bulk${i}@x.io`)).status);
        assert.ok(statuses.includes(429), 'a client sending 25 subscribes a minute was never throttled');
        assert.strictEqual(statuses.filter((s) => s === 200).length, 10, 'the per-client allowance is 10 a minute');
        const visitor = await subscribe(p, 'visitor', 'real.person@x.io');
        assert.strictEqual(visitor.status, 200, 'a different visitor was locked out by someone else\'s flood');
        assert.ok(p.mails.some((m) => m.to === 'real.person@x.io'), 'the visitor got no confirmation mail');
    });
});

test('newsletter: the confirmation mails one address receives are bounded, whatever clients ask', async () => {
    await withPlugin('newsletter', async (p) => {
        // Rotating clients defeat a per-client limit, so the inbox needs its own bound. Every reply stays
        // identical (no oracle), and once the bound is hit the token is NOT rotated — the link already in
        // the inbox keeps working.
        const replies = [];
        for (let i = 0; i < 8; i++) replies.push(await subscribe(p, `client-${i}`, 'victim@x.io'));
        for (const r of replies) {
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body, replies[0].body, 'the reply differs once the address is limited — that is an oracle');
        }
        const toVictim = p.mails.filter((m) => m.to === 'victim@x.io');
        assert.strictEqual(toVictim.length, 3, `the victim received ${toVictim.length} confirmation mails; at most 3 an hour`);
        const lastMailed = String(toVictim[toVictim.length - 1].text).match(/token=([a-z0-9]+)/i);
        const stored = p.sdb.prepare(`SELECT token FROM ${p.prefix}subscribers WHERE email = 'victim@x.io'`).get().token;
        assert.ok(lastMailed && lastMailed[1] === stored, 'a limited request rotated the token and broke the link already mailed');
    });
});

// ================================== event-tickets =============================================

async function seedEvent(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}events (title, starts_at, is_published, created_at) VALUES ('Meetup', ?, 1, ?)`)
        .run(new Date(Date.now() + 7 * 86400e3).toISOString(), new Date().toISOString());
    p.sdb.prepare(`INSERT INTO ${p.prefix}ticket_types (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (1, 'Free', 0, 100, 0, '', 1)`).run();
}
const order = (p: BootedPlugin, clientKey: string, email: string, qty: number) =>
    p.call('post', '/public/order', {
        clientKey,
        body: { event_id: 1, buyer_name: 'Ana', buyer_email: email, items: [{ ticket_type_id: 1, qty }], elapsed: 5000 },
    });

test('event-tickets: free seats are capped per order, per client and per email', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        assert.strictEqual((await order(p, 'grabber', 'a1@x.io', 5)).status, 400, 'per-order free cap');
        assert.strictEqual((await order(p, 'grabber', 'a1@x.io', 4)).status, 200);
        const rotated = await order(p, 'grabber', 'a2@x.io', 1);
        assert.strictEqual(rotated.status, 429, 'rotating the email from the same client does not reset the cap');
        const sameEmail = await order(p, 'elsewhere', 'a1@x.io', 1);
        assert.strictEqual(sameEmail.status, 429, 'the same email from another client is capped too');
        assert.strictEqual((await order(p, 'friend', 'f@x.io', 2)).status, 200, 'other attendees still get seats');
        assert.strictEqual(p.sdb.prepare(`SELECT sold FROM ${p.prefix}ticket_types WHERE id = 1`).get().sold, 6);
    });
});

const soldOf = (p: BootedPlugin, typeId = 1) => p.sdb.prepare(`SELECT sold FROM ${p.prefix}ticket_types WHERE id = ?`).get(typeId).sold;

test('event-tickets: a concurrent burst of free orders from one client cannot take the event', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        // 25 simultaneous orders, 4 free seats each, 25 addresses, ONE client: every request used to
        // read the caps before any order was counted, so all 25 landed and sold = 100.
        const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => order(p, 'grabber', `g${i}@x.io`, 4)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, 'one client got more than one free order through');
        assert.strictEqual(soldOf(p), 4, 'one client took more than its free seats');
        assert.strictEqual((await order(p, 'someone', 's@x.io', 2)).status, 200);
    });
});

test('event-tickets: the per-email free-seat quota holds against a concurrent burst from many clients', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => order(p, `client-${i}`, 'same@x.io', 4)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, 'one address got more than 4 free seats');
        assert.strictEqual(soldOf(p), 4);

        // An admin cancellation gives the address its seats back.
        const admin = { id: 1, role: 'administrator' };
        const orderId = p.sdb.prepare(`SELECT id FROM ${p.prefix}orders WHERE buyer_email = 'same@x.io'`).get().id;
        assert.strictEqual((await p.call('post', '/orders/:id/cancel', { params: { id: orderId }, user: admin })).status, 200);
        const again = await withClockAdvanced(11 * 60e3, () => order(p, 'client-0', 'same@x.io', 4));
        assert.strictEqual(again.status, 200, JSON.stringify(again.body));
        assert.strictEqual(soldOf(p), 4);
    });
});

test('event-tickets: one client\'s burst cannot fill the site-wide order window for everybody', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        p.sdb.prepare(`INSERT INTO ${p.prefix}ticket_types (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (1, 'Paid', 1000, 1000, 0, '', 1)`).run();
        const paid = (clientKey: string, email: string) => p.call('post', '/public/order', {
            clientKey, body: { event_id: 1, buyer_name: 'Ana', buyer_email: email, items: [{ ticket_type_id: 2, qty: 1 }], elapsed: 5000 },
        });
        // 70 simultaneous orders from one client passed the 5-per-client check together, created 70
        // orders and filled the 60-order site-wide window: every other buyer got 429 for 10 minutes.
        const burst = await Promise.all(Array.from({ length: 70 }, (_, i) => paid('flooder', `f${i}@x.io`)));
        assert.strictEqual(burst.filter((r) => r.status === 200).length, 5, 'one client created more than 5 orders in the window');
        const victim = await paid('victim', 'v@x.io');
        assert.strictEqual(victim.status, 200, `the site-wide window was exhausted by one client: ${JSON.stringify(victim.body)}`);
    });
});

test('event-tickets: visitors sharing one client key wait out a window, not the whole event', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        // Behind a shared NAT (or a proxy missing from trustProxy) every visitor has the same key. A
        // durable per-client cap meant that after 4 free seats nobody behind it could get one again.
        assert.strictEqual((await order(p, 'nat', 'first@x.io', 4)).status, 200);
        assert.strictEqual((await order(p, 'nat', 'second@x.io', 1)).status, 429, 'the per-client window still applies');
        const later = await withClockAdvanced(11 * 60e3, () => order(p, 'nat', 'second@x.io', 2));
        assert.strictEqual(later.status, 200, `the shared key stayed capped for the whole event: ${JSON.stringify(later.body)}`);
        // The per-email quota is the durable one.
        const firstAgain = await withClockAdvanced(22 * 60e3, () => order(p, 'elsewhere', 'first@x.io', 1));
        assert.strictEqual(firstAgain.status, 429);
    });
});

// A pending order holds its seats until it is paid, cancelled or expired. The sweep released an
// order's seats BEFORE its conditional pending -> expired flip, and the admin's cancel flipped any
// status but 'cancelled' and then released: an order whose seats had already gone back (expired)
// gave them back again, and the type sold more tickets than its capacity.
async function seedPaidType(p: BootedPlugin, capacity: number) {
    await seedEvent(p);
    p.sdb.prepare(`INSERT INTO ${p.prefix}ticket_types (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (1, 'Paid', 1000, ?, 0, '', 1)`).run(capacity);
    return 2; // the new type's id
}
const paidOrder = (p: BootedPlugin, clientKey: string, qty: number) => p.call('post', '/public/order', {
    clientKey, body: { event_id: 1, buyer_name: 'Ana', buyer_email: `${clientKey}@x.io`, items: [{ ticket_type_id: 2, qty }], elapsed: 5000 },
});
const ageOrders = (p: BootedPlugin) => p.sdb.prepare(`UPDATE ${p.prefix}orders SET created_at = ? WHERE payment_status = 'pending'`)
    .run(new Date(Date.now() - 3600e3).toISOString());
const orderIdOf = (p: BootedPlugin, email: string) => p.sdb.prepare(`SELECT id FROM ${p.prefix}orders WHERE buyer_email = ?`).get(email).id as number;
const orderStatusOf = (p: BootedPlugin, id: number) => p.sdb.prepare(`SELECT payment_status FROM ${p.prefix}orders WHERE id = ?`).get(id).payment_status;
/** Seats held by orders that hold seats (pending or paid) — what `sold` must equal. */
const seatsHeld = (p: BootedPlugin, typeId: number) => p.sdb.prepare(`SELECT items FROM ${p.prefix}orders WHERE payment_status IN ('pending', 'paid')`).all()
    .reduce((n: number, o: any) => n + JSON.parse(o.items).filter((it: any) => it.ticket_type_id === typeId).reduce((s: number, it: any) => s + it.qty, 0), 0);
const ET_ADMIN = { id: 1, role: 'administrator' };
const ORDER_READ_RE = /^SELECT \* FROM \w+orders WHERE id = \?/;
const SWEEP_READ_RE = /^SELECT id, items FROM \w+orders WHERE event_id = \? AND payment_status = 'pending'/;

test('event-tickets: cancelling an expired order does not give its seats back a second time', async () => {
    await withPlugin('event-tickets', async (p) => {
        const type = await seedPaidType(p, 2);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        ageOrders(p);
        // The next order's sweep expires the unpaid one (its 2 seats go back) and takes them.
        assert.strictEqual((await paidOrder(p, 'second', 2)).status, 200);
        const expired = orderIdOf(p, 'first@x.io');
        assert.strictEqual(orderStatusOf(p, expired), 'expired');
        // The admin list shows the expired order with a "Cancelar" button.
        const c = await p.call('post', '/orders/:id/cancel', { params: { id: expired }, user: ET_ADMIN });
        assert.strictEqual(c.status, 200, JSON.stringify(c.body));
        assert.strictEqual(orderStatusOf(p, expired), 'cancelled');
        const third = await paidOrder(p, 'third', 2);
        assert.strictEqual(third.status, 409, `a capacity-2 type sold 4 seats: ${JSON.stringify(third.body)}`);
        assert.strictEqual(soldOf(p, type), seatsHeld(p, type));
        assert.strictEqual(soldOf(p, type), 2);
    });
});

test('event-tickets: an order the sweep expires between the admin\'s read and the cancel releases its seats once', async () => {
    await withPlugin('event-tickets', async (p) => {
        const type = await seedPaidType(p, 2);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        ageOrders(p);
        const pending = orderIdOf(p, 'first@x.io');
        const second = interleaveAfter(p, ORDER_READ_RE, () => paidOrder(p, 'second', 2));
        const c = await p.call('post', '/orders/:id/cancel', { params: { id: pending }, user: ET_ADMIN });
        assert.strictEqual(c.status, 200, JSON.stringify(c.body));
        assert.strictEqual((await second.result()).status, 200);
        const third = await paidOrder(p, 'third', 2);
        assert.strictEqual(third.status, 409, `a capacity-2 type sold 4 seats: ${JSON.stringify(third.body)}`);
        assert.strictEqual(soldOf(p, type), seatsHeld(p, type));
    });
});

test('event-tickets: overlapping sweeps release an expired order\'s seats once', async () => {
    await withPlugin('event-tickets', async (p) => {
        const type = await seedPaidType(p, 2);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        ageOrders(p);
        // Two orders whose sweeps both read the stale order: the second runs entirely between the
        // first's read and its release.
        const inner = interleaveAfter(p, SWEEP_READ_RE, () => paidOrder(p, 'inner', 2));
        const outer = await paidOrder(p, 'outer', 2);
        const replies = [outer.status, (await inner.result()).status];
        assert.strictEqual(countOf(replies, 200), 1, `a capacity-2 type sold 4 seats: ${JSON.stringify(replies)}`);
        assert.strictEqual(soldOf(p, type), seatsHeld(p, type));
        assert.strictEqual(soldOf(p, type), 2);
    });
});

test('event-tickets: the sweep never releases the seats of an order the admin confirmed under it', async () => {
    await withPlugin('event-tickets', async (p) => {
        const type = await seedPaidType(p, 2);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        ageOrders(p);
        const unpaid = orderIdOf(p, 'first@x.io');
        // The admin confirms the payment between the sweep's read and its release.
        const paid = interleaveAfter(p, SWEEP_READ_RE, () => p.call('post', '/orders/:id/paid', { params: { id: unpaid }, user: ET_ADMIN }));
        const late = await paidOrder(p, 'late', 2);
        const confirm = await paid.result();
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        assert.strictEqual(confirm.body.tickets.length, 2);
        assert.strictEqual(orderStatusOf(p, unpaid), 'paid');
        assert.strictEqual(late.status, 409, `the paid order's seats were sold again: ${JSON.stringify(late.body)}`);
        assert.strictEqual(soldOf(p, type), seatsHeld(p, type));
    });
});

test('event-tickets: confirming the payment of an order that expired meanwhile is refused, not answered "already paid"', async () => {
    await withPlugin('event-tickets', async (p) => {
        await seedPaidType(p, 2);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        ageOrders(p);
        const unpaid = orderIdOf(p, 'first@x.io');
        const other = interleaveAfter(p, ORDER_READ_RE, () => paidOrder(p, 'second', 2));
        const r = await p.call('post', '/orders/:id/paid', { params: { id: unpaid }, user: ET_ADMIN });
        assert.strictEqual((await other.result()).status, 200);
        assert.strictEqual(r.status, 409, `the admin was told the order is paid: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /caducó/);
        assert.strictEqual(orderStatusOf(p, unpaid), 'expired');
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}tickets WHERE order_id = ?`).get(unpaid).n, 0);
    });
});

test('event-tickets: a capacity cut lands only while it still covers the seats sold', async () => {
    await withPlugin('event-tickets', async (p) => {
        const type = await seedPaidType(p, 10);
        assert.strictEqual((await paidOrder(p, 'first', 2)).status, 200);
        // The admin cuts the capacity to the 2 seats sold; an order for one more lands between the
        // route's check and its write.
        const more = interleaveAfter(p, /^SELECT \* FROM \w+ticket_types WHERE id = \?/, () => paidOrder(p, 'second', 1));
        const r = await p.call('put', '/types/:id', { params: { id: String(type) }, user: ET_ADMIN, body: { capacity: 2 } });
        assert.strictEqual((await more.result()).status, 200);
        const row = p.sdb.prepare(`SELECT capacity, sold FROM ${p.prefix}ticket_types WHERE id = ?`).get(type);
        assert.ok(row.sold <= row.capacity, `capacity ${row.capacity} with ${row.sold} sold (reply ${r.status})`);
        assert.strictEqual(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.error, /\(3\)/);
        // Without the race the cut goes through.
        const ok = await p.call('put', '/types/:id', { params: { id: String(type) }, user: ET_ADMIN, body: { capacity: 3 } });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(p.sdb.prepare(`SELECT capacity FROM ${p.prefix}ticket_types WHERE id = ?`).get(type).capacity, 3);
    });
});

// ================================== conference-manager ========================================
// Every write that moves a bed runs under the plugin's assignment lock — except the inscription edit,
// which read the attendee, decided (free the bed? take a seat?) and wrote outside it, and the manual
// placement, which read the attendee before taking the lock. A cancellation and a placement landing in
// each other's gap left a cancelled attendee holding a bed. The bus edit checked the tickets sold
// outside the lock its sales run under.
const CM_ADMIN = { id: 1, role: 'administrator' };
function seedLodging(p: BootedPlugin) {
    p.sdb.prepare(`INSERT INTO ${p.prefix}conferences (name, slug, is_form_published) VALUES ('Conf', 'conf', 1)`).run();
    p.sdb.prepare(`INSERT INTO ${p.prefix}locations (conference_id, name, code) VALUES (1, 'North', '123456')`).run();
    p.sdb.prepare(`INSERT INTO ${p.prefix}hotels (conference_id, name) VALUES (1, 'Hotel')`).run();
    p.sdb.prepare(`INSERT INTO ${p.prefix}rooms (hotel_id, room_number, capacity) VALUES (1, '101', 1)`).run(); // one bed
    const ins = p.sdb.prepare(`INSERT INTO ${p.prefix}inscriptions (conference_id, first_name, last_name, status, location_id, location) VALUES (1, ?, 'X', 'active', 1, 'North')`);
    ins.run('Ana');
    ins.run('Bea');
}
const assignRoom = (p: BootedPlugin, inscription: number, room: number | null) =>
    p.call('post', '/inscriptions/:id/assign', { user: CM_ADMIN, params: { id: String(inscription) }, body: { room_id: room } });
const cancelInscription = (p: BootedPlugin, inscription: number) =>
    p.call('put', '/inscriptions/:id', { user: CM_ADMIN, params: { id: String(inscription) }, body: { status: 'cancelled' } });
const inscriptionRow = (p: BootedPlugin, id: number) => p.sdb.prepare(`SELECT status, room_id FROM ${p.prefix}inscriptions WHERE id = ?`).get(id);
const INSCRIPTION_READ_RE = /^SELECT \* FROM \w+inscriptions WHERE id = \?/;

for (const [label, first, second] of [
    ['a cancellation lands between a placement\'s read and its write', 'assign', 'cancel'],
    ['a placement lands between a cancellation\'s read and its write', 'cancel', 'assign'],
] as const) {
    test(`conference-manager: a cancelled attendee never keeps a bed when ${label}`, async () => {
        await withPlugin('conference-manager', async (p) => {
            seedLodging(p);
            const run = (what: 'assign' | 'cancel') => (what === 'assign' ? assignRoom(p, 1, 1) : cancelInscription(p, 1));
            const inner = interleaveAfter(p, INSCRIPTION_READ_RE, () => run(second));
            const outer = await run(first);
            const innerReply = await inner.result();
            const row = inscriptionRow(p, 1);
            assert.strictEqual(row.status, 'cancelled', `the cancellation did not land: ${JSON.stringify([outer, innerReply])}`);
            assert.strictEqual(row.room_id, null, `a cancelled attendee holds the room's only bed: ${JSON.stringify([outer, innerReply])}`);
            // The bed is free for someone else.
            const other = await assignRoom(p, 2, 1);
            assert.strictEqual(other.status, 200, JSON.stringify(other.body));
            assert.strictEqual(inscriptionRow(p, 2).room_id, 1);
        });
    });
}

test('conference-manager: a coordinator\'s placement and an admin\'s cancellation never leave a cancelled attendee in a bed', async () => {
    await withPlugin('conference-manager', async (p) => {
        seedLodging(p);
        p.sdb.prepare(`UPDATE ${p.prefix}rooms SET location_id = 1`).run(); // allotted to the location
        const portal = { 'x-portal-token': Buffer.from(`1:123456:${Date.now() + 3600e3}`).toString('base64') };
        const place = (inscription: number) => p.call('post', '/portal/lodging/assign', { headers: portal, body: { inscription_id: inscription, room_id: 1 } });
        // The portal reads the attendee under the lock; the admin's cancellation lands before its write.
        const cancel = interleaveAfter(p, /^SELECT id, status, room_id, location_id FROM \w+inscriptions/, () => cancelInscription(p, 1));
        const placed = await place(1);
        const cancelled = await cancel.result();
        const row = inscriptionRow(p, 1);
        assert.strictEqual(row.status, 'cancelled', JSON.stringify([placed, cancelled]));
        assert.strictEqual(row.room_id, null, `a cancelled attendee holds the room's only bed: ${JSON.stringify([placed, cancelled])}`);
        const other = await place(2);
        assert.strictEqual(other.status, 200, JSON.stringify(other.body));
    });
});

test('conference-manager: a bus capacity cut lands only while it still covers the tickets sold', async () => {
    await withPlugin('conference-manager', async (p) => {
        seedLodging(p);
        p.sdb.prepare(`INSERT INTO ${p.prefix}buses (conference_id, name, capacity, price) VALUES (1, 'Bus', 10, 0)`).run();
        const sell = (inscription: number) => p.call('post', '/buses/:id/passengers', { user: CM_ADMIN, params: { id: '1' }, body: { inscription_ids: [inscription] } });
        assert.strictEqual((await sell(1)).status, 200);
        // The capacity is cut to the one ticket sold while a second sale lands between the check and the write.
        const sale = interleaveAfter(p, /^SELECT b\.\*, \(SELECT COUNT\(\*\) FROM \w+tickets/, () => sell(2));
        const cut = await p.call('put', '/buses/:id', { user: CM_ADMIN, params: { id: '1' }, body: { capacity: 1 } });
        const saleReply = await sale.result();
        const bus = p.sdb.prepare(`SELECT capacity, (SELECT COUNT(*) FROM ${p.prefix}transport_tickets WHERE bus_id = 1) AS sold FROM ${p.prefix}buses WHERE id = 1`).get();
        assert.ok(bus.sold <= bus.capacity, `capacity ${bus.capacity} with ${bus.sold} tickets sold (cut ${cut.status}, sale ${saleReply.status})`);
        assert.strictEqual(countOf([cut.status, saleReply.status], 200), 1, JSON.stringify([cut.body, saleReply.body]));
    });
});

// Transport payments check what a ticket still owes under the assignment lock. The bus edit with
// reprice_tickets checked "nothing is paid beyond the new price" under it but wrote the tickets' new
// price after releasing it, and the bus delete, the passenger removal and the attendee delete checked
// for payments (or erased them) outside it: a payment landing in the gap was accepted against the old
// price — a ticket paid beyond its price — or answered as recorded and then erased with a ticket
// deleted right after.
function seedBusWithTicket(p: BootedPlugin, price: number) {
    seedLodging(p);
    p.sdb.prepare(`INSERT INTO ${p.prefix}buses (conference_id, name, capacity, price) VALUES (1, 'Bus', 10, ?)`).run(price);
}
const sellSeat = (p: BootedPlugin, inscription: number) =>
    p.call('post', '/buses/:id/passengers', { user: CM_ADMIN, params: { id: '1' }, body: { inscription_ids: [inscription] } });
const payTicket = (p: BootedPlugin, ticket: number, amount: number) =>
    p.call('post', '/tickets/:id/payments', { user: CM_ADMIN, params: { id: String(ticket) }, body: { amount, method: 'Efectivo' } });
const ticketOf = (p: BootedPlugin, inscription: number) =>
    p.sdb.prepare(`SELECT id, price, amount_paid, payment_status FROM ${p.prefix}transport_tickets WHERE inscription_id = ?`).get(inscription);
const orphanTransportPayments = (p: BootedPlugin) => p.sdb.prepare(
    `SELECT COUNT(*) AS n FROM ${p.prefix}transport_payments WHERE ticket_id NOT IN (SELECT id FROM ${p.prefix}transport_tickets)`).get().n;
const transportPaymentsOnLiveTickets = (p: BootedPlugin) => p.sdb.prepare(
    `SELECT COUNT(*) AS n FROM ${p.prefix}transport_payments tp JOIN ${p.prefix}transport_tickets t ON t.id = tp.ticket_id`).get().n;

test('conference-manager: a reprice and a transport payment never leave a ticket paid beyond its price', async () => {
    await withPlugin('conference-manager', async (p) => {
        seedBusWithTicket(p, 100);
        assert.strictEqual((await sellSeat(p, 1)).status, 200);
        const ticket = ticketOf(p, 1).id;
        // The bus drops to 40 for the tickets already sold (nothing is paid yet, so the check passes);
        // a payment of the full old price lands right before the tickets' new price is written.
        const pay = interleaveBefore(p, /^UPDATE \w+transport_tickets SET price = \?/, () => payTicket(p, ticket, 100));
        const reprice = await p.call('put', '/buses/:id', { user: CM_ADMIN, params: { id: '1' }, body: { price: 40, reprice_tickets: true } });
        const payReply = await pay.result();
        const row = ticketOf(p, 1);
        assert.ok(Number(row.amount_paid) <= Number(row.price) + 0.005,
            `ticket priced ${row.price} with ${row.amount_paid} paid (reprice ${reprice.status}, payment ${payReply.status} ${JSON.stringify(payReply.body)})`);
        assert.strictEqual(reprice.status, 200, JSON.stringify(reprice.body));
        assert.strictEqual(row.price, 40);
        assert.strictEqual(payReply.status, 400, JSON.stringify(payReply.body));
        // The ticket is paid at its new price.
        assert.strictEqual((await payTicket(p, ticket, 40)).status, 200);
        assert.deepStrictEqual({ ...ticketOf(p, 1), id: 0 }, { id: 0, price: 40, amount_paid: 40, payment_status: 'paid' });
    });
});

for (const [label, remove, gap] of [
    ['the bus is deleted', (p: BootedPlugin) => p.call('delete', '/buses/:id', { user: CM_ADMIN, params: { id: '1' } }),
        /^SELECT COUNT\(\*\) AS n FROM \w+transport_payments WHERE ticket_id IN \(SELECT id FROM \w+transport_tickets WHERE bus_id/],
    ['the passenger is removed', (p: BootedPlugin) => p.call('delete', '/buses/:id/passengers/:inscriptionId', { user: CM_ADMIN, params: { id: '1', inscriptionId: '1' } }),
        /^SELECT COUNT\(\*\) AS n FROM \w+transport_payments WHERE ticket_id = \?/],
    ['the attendee is deleted', (p: BootedPlugin) => p.call('delete', '/inscriptions/:id', { user: CM_ADMIN, params: { id: '1' } }),
        /^DELETE FROM \w+transport_payments WHERE ticket_id IN/],
] as const) {
    test(`conference-manager: a transport payment recorded while ${label} is never erased with its ticket`, async () => {
        await withPlugin('conference-manager', async (p) => {
            seedBusWithTicket(p, 100);
            assert.strictEqual((await sellSeat(p, 1)).status, 200);
            const ticket = ticketOf(p, 1).id;
            const pay = interleaveAfter(p, gap, () => payTicket(p, ticket, 30));
            const removed = await remove(p);
            const payReply = await pay.result();
            // The ticket's foreign key cascades its deletion to its payments where foreign keys are
            // enforced (elsewhere the payment is left pointing at nothing): a payment the admin was
            // told is recorded must still be in the ledger, on a ticket that exists.
            assert.strictEqual(orphanTransportPayments(p), 0, `a payment points at a deleted ticket (removal ${removed.status}, payment ${payReply.status})`);
            assert.strictEqual(transportPaymentsOnLiveTickets(p), payReply.status === 200 ? 1 : 0,
                `the payment answered ${payReply.status} is not in the ledger (removal answered ${removed.status})`);
            assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
            assert.strictEqual(payReply.status, 404, JSON.stringify(payReply.body));
        });
    });
}

// ================================== public error replies ======================================
// A public route answered 500 { error: e.message }: the driver's text names the plugin's tables and
// constraints, and Stripe's names the account's key. Each block breaks the plugin's storage (or
// Stripe) under a public route and checks the reply carries none of it.

/** Assert a public reply is the failure status with no driver/host error text in it. */
function assertQuiet(label: string, r: Reply, status = 500) {
    assert.strictEqual(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.doesNotMatch(JSON.stringify(r.body), LEAK_RE, `${label} echoed an error's text`);
}

test('auctions: public errors never echo the driver\'s message', async () => {
    await withPlugin('auctions', async (p) => {
        await seedAuction(p);
        p.sdb.exec(`DROP TABLE ${p.prefix}bids`);
        assertQuiet('GET /public/auctions', await p.call('get', '/public/auctions'));
        assertQuiet('GET /public/auction', await p.call('get', '/public/auction', { query: { slug: 'car' } }));
        assertQuiet('POST /public/bid', await bid(p, 'bidder', 2000));
    });
});

test('digital-downloads: public errors never echo the driver\'s message', async () => {
    await withPlugin('digital-downloads', async (p) => {
        p.sdb.exec(`DROP TABLE ${p.prefix}orders; DROP TABLE ${p.prefix}products`);
        const token = 'A'.repeat(32);
        assertQuiet('GET /public/products', await p.call('get', '/public/products'));
        assertQuiet('POST /public/order', await p.call('post', '/public/order', { clientKey: 'c', body: { product_id: 1, customer_email: 'a@x.io', customer_name: 'A', elapsed: 5000 } }));
        assertQuiet('GET /public/download', await p.call('get', '/public/download', { clientKey: 'c', query: { token } }));
        assertQuiet('GET /public/status', await p.call('get', '/public/status', { clientKey: 'c', query: { token } }));
    });
});

test('invoices and polls: public errors never echo the driver\'s message', async () => {
    await withPlugin('invoices', async (p) => {
        p.sdb.exec(`DROP TABLE ${p.prefix}invoices`);
        assertQuiet('GET /public/view', await p.call('get', '/public/view', { clientKey: 'c', query: { token: 'A'.repeat(32) } }));
    });
    await withPlugin('polls', async (p) => {
        p.sdb.exec(`DROP TABLE ${p.prefix}votes; DROP TABLE ${p.prefix}polls`);
        assertQuiet('GET /public/poll', await p.call('get', '/public/poll', { clientKey: 'c', query: { id: '1' } }));
        assertQuiet('POST /public/vote', await p.call('post', '/public/vote', { clientKey: 'c', body: { poll_id: 1, option_id: 1 } }));
    });
});

test('conference-manager: the public form and the portal login never echo the driver\'s message', async () => {
    await withPlugin('conference-manager', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}conferences (name, slug, is_form_published) VALUES ('Draft', 'draft', 0)`).run();
        // A deliberate refusal (an HttpError) still answers its own message.
        const refused = await p.call('post', '/public/quote', { body: { conference_id: 1, fields: {} } });
        assert.strictEqual(refused.status, 403);
        assert.match(refused.body.error, /no disponible/);
        p.sdb.exec(`DROP TABLE ${p.prefix}conferences; DROP TABLE ${p.prefix}locations`);
        assertQuiet('POST /public/quote', await p.call('post', '/public/quote', { body: { conference_id: 1, fields: {} } }));
        assertQuiet('GET /public/list', await p.call('get', '/public/list'));
        assertQuiet('GET /public/locations', await p.call('get', '/public/locations', { query: { conference_id: '1' } }));
        assertQuiet('GET /public/fields', await p.call('get', '/public/fields', { query: { conference_id: '1' } }));
        assertQuiet('POST /portal/login', await p.call('post', '/portal/login', { body: { location_id: 1, code: '123456' } }));
    });
});

/** Run `fn` with the global fetch answering every Stripe call with `reply`. */
async function withStripe<T>(reply: { ok: boolean; status: number; body: any }, fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: reply.ok, status: reply.status, json: async () => reply.body });
    try { return await fn(); } finally { (globalThis as any).fetch = real; }
}
const STRIPE_KEY_ERROR = { ok: false, status: 401, body: { error: { message: 'Invalid API Key provided: sk_test_****wxyz' } } };
const STRIPE_LEAK_RE = /sk_test|api key/i;

test('online-store and restaurant-menu: a Stripe failure is never echoed to the visitor', async () => {
    await withPlugin('online-store', async (p) => {
        await seedStore(p);
        p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES ('stripe_sk', 'sk_test_secret')`).run();
        // Checkout: Stripe refuses the session, the order falls back to manual payment.
        const failed = await withStripe(STRIPE_KEY_ERROR, () => checkout(p, 'card-1', [{ product_id: 2, qty: 1 }], { payment_method: 'stripe' }));
        assert.strictEqual(failed.status, 200, JSON.stringify(failed.body));
        assert.ok(failed.body.warning, 'the visitor is told the card payment did not start');
        assert.doesNotMatch(JSON.stringify(failed.body), STRIPE_LEAK_RE);
        // Return leg: Stripe refuses the verification.
        const started = await withStripe({ ok: true, status: 200, body: { id: 'cs_test_12345678', url: 'https://checkout.stripe.test/x' } },
            () => checkout(p, 'card-2', [{ product_id: 2, qty: 1 }], { payment_method: 'stripe' }));
        assert.strictEqual(started.body.checkoutUrl, 'https://checkout.stripe.test/x', JSON.stringify(started.body));
        const verify = await withStripe(STRIPE_KEY_ERROR, () => p.call('get', '/public/confirm-stripe', { clientKey: 'card-2', query: { token: started.body.token, session_id: 'cs_test_12345678' } }));
        assert.strictEqual(verify.status, 502);
        assert.doesNotMatch(JSON.stringify(verify.body), STRIPE_LEAK_RE);
    });
    await withPlugin('restaurant-menu', async (p) => {
        p.options.set('restaurant_menu_config', { orderingEnabled: true, payOnlineEnabled: true });
        p.sdb.prepare(`INSERT INTO ${p.prefix}sections (name, is_active) VALUES ('Mains', 1)`).run();
        p.sdb.prepare(`INSERT INTO ${p.prefix}items (section_id, name, price_cents, is_available) VALUES (1, 'Soup', 500, 1)`).run();
        p.sdb.prepare(`INSERT INTO ${p.prefix}settings (name, value) VALUES ('stripe_sk', 'sk_test_secret')`).run();
        const orderFood = (c: string) => p.call('post', '/public/order', {
            clientKey: c, body: { customer_name: 'Ana', customer_phone: '+34 600 000 000', delivery_type: 'pickup', payment_method: 'stripe', items: [{ item_id: 1, qty: 1 }] },
        });
        const failed = await withStripe(STRIPE_KEY_ERROR, () => orderFood('guest-1'));
        assert.strictEqual(failed.status, 200, JSON.stringify(failed.body));
        assert.ok(failed.body.warning, 'the guest is told the card payment did not start');
        assert.doesNotMatch(JSON.stringify(failed.body), STRIPE_LEAK_RE);
        const started = await withStripe({ ok: true, status: 200, body: { id: 'cs_test_87654321', url: 'https://checkout.stripe.test/y' } }, () => orderFood('guest-2'));
        assert.strictEqual(started.body.checkoutUrl, 'https://checkout.stripe.test/y', JSON.stringify(started.body));
        const verify = await withStripe(STRIPE_KEY_ERROR, () => p.call('get', '/public/confirm-stripe', { clientKey: 'guest-2', query: { token: started.body.token, session_id: 'cs_test_87654321' } }));
        assert.strictEqual(verify.status, 502);
        assert.doesNotMatch(JSON.stringify(verify.body), STRIPE_LEAK_RE);
        // A network failure (the fetch itself throws) takes the catch path: same reply.
        const real = globalThis.fetch;
        (globalThis as any).fetch = async () => { throw new Error('connect ECONNREFUSED api.stripe.com with sk_test_secret'); };
        try {
            const thrown = await p.call('get', '/public/confirm-stripe', { clientKey: 'guest-2', query: { token: started.body.token, session_id: 'cs_test_87654321' } });
            assert.strictEqual(thrown.status, 502);
            assert.doesNotMatch(JSON.stringify(thrown.body), STRIPE_LEAK_RE);
        } finally { (globalThis as any).fetch = real; }
    });
});

/**
 * Call a route the way the host serves it: a handler that THROWS does not answer itself, and the
 * host answers for it (core/plugin-isolate.ts). The harness rejects instead, so this maps the rejection
 * onto a 502 — never the plugin's own generic 500 that the test below expects.
 */
const callLikeHost = (p: BootedPlugin, method: string, route: string, opts: any = {}): Promise<Reply> =>
    p.call(method, route, opts).catch(() => ({ status: 502, body: { error: 'Isolated plugin error' } }));
/** A stack frame or a source location in a reply. */
const STACK_RE = /\.(js|ts):\d+|\bat \S+ \(/;
const dropPluginTables = (p: BootedPlugin) => {
    p.sdb.pragma('foreign_keys = OFF');
    for (const { name } of p.sdb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`).all(`${p.prefix}%`)) {
        p.sdb.exec(`DROP TABLE ${name}`);
    }
};
/** Make every wordjs.options read fail, as a refused bridge call does. */
const breakOptions = (p: BootedPlugin) => {
    (p.options as any).has = () => { throw new Error(`options bridge refused (${p.prefix}): at /srv/wordjs/plugins/index.js:1`); };
};

test('public routes answer a failing read themselves, with a generic 500 that carries no error text', async () => {
    const quiet = (label: string, r: Reply) => {
        assert.strictEqual(r.status, 500, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`);
        assert.doesNotMatch(JSON.stringify(r.body), LEAK_RE, `${label} echoed an error's text`);
        assert.doesNotMatch(JSON.stringify(r.body), STACK_RE, `${label} echoed a stack trace`);
    };
    const cases: Array<[string, (p: BootedPlugin) => void, Array<[string, string, any]>]> = [
        ['analytics-tag', breakOptions, [['get', '/public/config', {}]]],
        ['image-lightbox', breakOptions, [['get', '/public/config', {}]]],
        ['notification-bar', breakOptions, [['get', '/public/config', {}]]],
        ['card-gallery', breakOptions, [['get', '/', {}], ['get', '/:id', { params: { id: 'g1' } }]]],
        ['photo-carousel', breakOptions, [['get', '/', {}], ['get', '/location/:location', { params: { location: 'home' } }], ['get', '/:id', { params: { id: 'c1' } }]]],
        ['video-gallery', breakOptions, [['get', '/galleries', {}], ['get', '/galleries/:id', { params: { id: 'g1' } }], ['get', '/', {}]]],
        ['youtube-videos', breakOptions, [['get', '/', {}]]],
        ['contact-forms', dropPluginTables, [
            ['get', '/public/form', { query: { id: '1' } }],
            ['post', '/public/submit', { body: { form_id: 1, data: {}, elapsed: 5000 } }],
        ]],
        ['donations', dropPluginTables, [
            ['get', '/public/campaigns', {}],
            ['get', '/public/campaign', { query: { slug: 'roof' } }],
            ['get', '/public/donations-config', {}],
            ['post', '/public/donate', { body: { campaign_id: 1, amount_cents: 1000, donor_name: 'Ana', donor_email: 'ana@x.io', elapsed: 5000 } }],
            ['get', '/public/confirm-stripe', { query: { session_id: 'cs_test_12345678', token: 'a'.repeat(32) } }],
            ['get', '/public/recent', { query: { campaign_id: '1' } }],
        ]],
        ['events-calendar', dropPluginTables, [['get', '/public/events', {}]]],
        ['faq', dropPluginTables, [['get', '/public/list', {}]]],
        ['online-store', dropPluginTables, [
            ['get', '/public/products', {}],
            ['get', '/public/product', { query: { slug: 'mug' } }],
            ['get', '/public/categories', {}],
            ['get', '/public/store-config', {}],
            ['get', '/public/shipping-options', {}],
            ['post', '/public/validate-coupon', { body: { code: 'ONCE', items: [{ product_id: 1, qty: 1 }] } }],
            ['post', '/public/checkout', { body: { customer: { name: 'Buyer', email: 'b@x.io' }, items: [{ product_id: 1, qty: 1 }], payment_method: 'manual' } }],
            ['get', '/public/order', { query: { token: 'a'.repeat(32) } }],
            ['get', '/public/confirm-stripe', { query: { token: 'a'.repeat(32), session_id: 'cs_test_12345678' } }],
            ['post', '/public/stripe-webhook', { body: { type: 'checkout.session.completed', data: { object: { id: 'cs_test_12345678' } } } }],
        ]],
        ['popup-builder', dropPluginTables, [['get', '/public/active', {}], ['post', '/public/event', { body: { popup_id: 1, event: 'view' } }]]],
        ['testimonials', (p) => { p.options.set('testimonials_settings', { allowPublicSubmit: true }); dropPluginTables(p); }, [
            ['get', '/public/list', {}],
            ['post', '/public/submit', { body: { author_name: 'Ana', content: 'Muy bien, lo recomiendo a todos.', rating: 5, elapsed: 5000 } }],
        ]],
    ];
    for (const [slug, breakIt, routes] of cases) {
        await withPlugin(slug, async (p) => {
            breakIt(p);
            for (const [method, route, opts] of routes) {
                quiet(`${slug} ${method.toUpperCase()} ${route}`, await callLikeHost(p, method, route, { clientKey: `c-${route}`, ...opts }));
            }
        });
    }
});

test('conference-manager: the location portal\'s own summary never answers with a stack trace', async () => {
    await withPlugin('conference-manager', async (p) => {
        p.sdb.prepare(`INSERT INTO ${p.prefix}conferences (name, slug, is_form_published) VALUES ('C', 'c', 1)`).run();
        p.sdb.prepare(`INSERT INTO ${p.prefix}locations (conference_id, name, code) VALUES (1, 'Norte', '123456')`).run();
        const portal = { 'x-portal-token': Buffer.from(`1:123456:${Date.now() + 3600e3}`).toString('base64') };
        assert.strictEqual((await callLikeHost(p, 'get', '/portal/me', { headers: portal })).status, 200);
        p.sdb.pragma('foreign_keys = OFF');
        p.sdb.exec(`DROP TABLE ${p.prefix}inscriptions`);
        const r = await callLikeHost(p, 'get', '/portal/me', { headers: portal });
        assert.strictEqual(r.status, 500, JSON.stringify(r.body).slice(0, 300));
        assert.doesNotMatch(JSON.stringify(r.body), LEAK_RE);
        assert.doesNotMatch(JSON.stringify(r.body), STACK_RE);
    });
});

test('newsletter: simultaneous subscribes for one address both get the uniform reply', async () => {
    await withPlugin('newsletter', async (p) => {
        // Both read "no subscriber" before either INSERT; the UNIQUE email refused the second, which
        // answered 500 — a reply no other branch gives.
        const both = await Promise.all([subscribe(p, 'tab-1', 'twice@x.io'), subscribe(p, 'tab-2', 'twice@x.io')]);
        assert.deepStrictEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body)));
        assert.deepStrictEqual(both[1].body, both[0].body);
        assert.strictEqual(p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}subscribers WHERE email = 'twice@x.io'`).get().n, 1);
        // The mailed token is the stored one: the link works.
        const mailed = String(p.mails.filter((m) => m.to === 'twice@x.io').pop()!.text).match(/token=([a-z0-9]+)/i)![1];
        assert.strictEqual(p.sdb.prepare(`SELECT token FROM ${p.prefix}subscribers WHERE email = 'twice@x.io'`).get().token, mailed);
    });
});

test('newsletter: a subscribe racing the confirmation link never un-confirms the subscriber', async () => {
    await withPlugin('newsletter', async (p) => {
        assert.strictEqual((await subscribe(p, 'owner', 'race@x.io')).status, 200);
        const token = String(p.mails.pop()!.text).match(/token=([a-z0-9]+)/i)![1];
        // The subscribe reads the row while it is pending; the confirmation lands before its UPDATE.
        const [again, confirmed] = await Promise.all([
            subscribe(p, 'other', 'race@x.io'),
            p.call('get', '/public/confirm', { query: { token } }),
        ]);
        assert.deepStrictEqual([again.status, confirmed.status], [200, 200]);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}subscribers WHERE email = 'race@x.io'`).get().status, 'confirmed',
            'a subscribe that read the row before the confirmation reset it to pending');
    });
});

// ================================== upgrade path ==============================================

test('upgrade: 1.0.0 tables keep working (bookings and vendor-marketplace gain columns; event-tickets counts earlier free seats)', async () => {
    // The previous releases' CREATE TABLE statements, minus the columns this release adds.
    await withPlugin('bookings', async (p) => {
        const cols = p.sdb.prepare(`PRAGMA table_info(${p.prefix}bookings)`).all().map((c: any) => c.name);
        for (const c of ['client_key', 'slot_claim', 'email_claim', 'client_claim']) assert.ok(cols.includes(c), `missing ${c}`);
        const uniques = p.sdb.prepare(`PRAGMA index_list(${p.prefix}bookings)`).all().filter((i: any) => i.unique).map((i: any) => i.name);
        for (const c of ['slot_claim', 'email_claim', 'client_claim']) assert.ok(uniques.includes(`${p.prefix}uidx_bookings_${c}`), `no unique ${c} index`);
        await seedService(p);
        assert.strictEqual((await book(p, 'c1', '10:00')).status, 200);
        assert.strictEqual(p.sdb.prepare(`SELECT client_key FROM ${p.prefix}bookings`).get().client_key, 'c1');
    }, (sdb, P) => sdb.exec(`CREATE TABLE ${P}bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER NOT NULL, date TEXT NOT NULL,
        time TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, notes TEXT,
        status TEXT DEFAULT 'confirmed', token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`));

    await withPlugin('vendor-marketplace', async (p) => {
        const cols = p.sdb.prepare(`PRAGMA table_info(${p.prefix}products)`).all().map((c: any) => c.name);
        assert.ok(cols.includes('admin_hidden'));
    }, (sdb, P) => sdb.exec(`CREATE TABLE ${P}products (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, name TEXT NOT NULL,
        description TEXT, price_cents INTEGER DEFAULT 0, image_url TEXT, category TEXT DEFAULT '', is_published INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`));

    // vendor-marketplace 1.0.0 stores, two of them on one address (the race let that happen): the
    // upgrade keeps both, and the address takes no further store, even from simultaneous requests.
    await withPlugin('vendor-marketplace', async (p) => {
        const before = p.sdb.prepare(`SELECT COUNT(*) AS n FROM ${p.prefix}vendors`).get().n;
        assert.strictEqual(before, 3);
        const burst = await Promise.all(['u1', 'u2'].map((c, i) => applyStore(p, c, `Nueva ${i}`, 'dup@x.io')));
        assert.deepStrictEqual(burst.map((r) => r.status), [200, 200]);
        assert.strictEqual(storesWith(p, 'dup@x.io'), 2, 'a third store was stored for an address that already had two');
        const fresh = await Promise.all(['u3', 'u4'].map((c, i) => applyStore(p, c, `Fresca ${i}`, 'solo-new@x.io')));
        assert.deepStrictEqual(fresh.map((r) => r.status), [200, 200]);
        assert.strictEqual(storesWith(p, 'solo-new@x.io'), 1);
        const admin = await p.call('post', '/vendors', { user: ADMIN, body: { name: 'Otra', email: 'solo@x.io' } });
        assert.strictEqual(admin.status, 409, 'the existing single store kept its address');
    }, (sdb, P) => {
        sdb.exec(`CREATE TABLE ${P}vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE, email TEXT NOT NULL,
            phone TEXT, description TEXT, logo_url TEXT, access_code TEXT, status TEXT DEFAULT 'pending', commission_pct INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        const ins = sdb.prepare(`INSERT INTO ${P}vendors (name, slug, email) VALUES (?, ?, ?)`);
        ins.run('Dup A', 'dup-a', 'dup@x.io');
        ins.run('Dup B', 'dup-b', 'dup@x.io');
        ins.run('Solo', 'solo', 'solo@x.io');
    });

    await withPlugin('event-tickets', async (p) => {
        await seedEvent(p);
        // A free order placed before the per-email quota existed still counts against it.
        p.sdb.prepare(`INSERT INTO ${p.prefix}orders (token, event_id, buyer_name, buyer_email, items, total_cents, payment_status, created_at)
            VALUES ('t', 1, 'Old', 'old@x.io', '[{"ticket_type_id":1,"qty":3}]', 0, 'paid', ?)`).run(new Date().toISOString());
        assert.strictEqual((await order(p, 'c1', 'old@x.io', 2)).status, 429, 'the pre-upgrade free seats were not counted');
        assert.strictEqual((await order(p, 'c2', 'old@x.io', 1)).status, 200);
        assert.strictEqual((await order(p, 'c3', 'a@x.io', 2)).status, 200);
    }, (sdb, P) => sdb.exec(`CREATE TABLE ${P}orders (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, event_id INTEGER, buyer_name TEXT NOT NULL,
        buyer_email TEXT NOT NULL, items TEXT, total_cents INTEGER, payment_status TEXT DEFAULT 'pending', created_at TEXT)`));
});
