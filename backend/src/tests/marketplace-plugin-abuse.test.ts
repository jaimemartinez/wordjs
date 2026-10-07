/**
 * Business-logic / abuse regression suite for first-party marketplace plugins.
 *
 * Each block boots the REAL plugin entry (marketplace/plugins/<slug>/index.js) through the shared
 * harness in ./fixtures/marketplace-plugin-harness — in-memory SQLite plus the host's real SQL guard —
 * and replays the abuse that was confirmed against it, asserting the fixed behaviour:
 *
 *  - auctions:            invalid bids flood one site-wide window -> nobody else can outbid.
 *  - online-store:        unpaid orders reserve stock/coupons forever; global checkout cap.
 *  - bookings:            instant 'confirmed' bookings, global limiters -> one client fills the calendar.
 *  - invoices:            global failed-token throttle -> every customer's link 429s.
 *  - vendor-marketplace:  vendor republishes an admin-hidden product; protocol-relative image URLs.
 *  - newsletter:          mail failure auto-confirmed the subscriber (no opt-in).
 *  - event-tickets:       free tickets limited only per email -> rotating emails take all capacity.
 *
 * The mail-server vacation responder is covered in mail-server-vacation.test.ts (it slices functions
 * out of a 3.7k-line SMTP plugin rather than booting it).
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

test('bookings: without mail the booking degrades to confirmed and returns its token', async () => {
    await withPlugin('bookings', async (p) => {
        await seedService(p);
        p.setMailFailure(new Error('no mail provider'));
        const r = await book(p, 'c1', '10:00');
        assert.strictEqual(r.status, 200);
        assert.match(String(r.body.token), /^[a-z0-9]{32}$/);
        assert.strictEqual(p.sdb.prepare(`SELECT status FROM ${p.prefix}bookings`).get().status, 'confirmed');
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

// ================================== upgrade path ==============================================

test('upgrade: 1.0.0 tables gain the new columns (bookings, vendor-marketplace, event-tickets)', async () => {
    // The previous releases' CREATE TABLE statements, minus the columns this release adds.
    await withPlugin('bookings', async (p) => {
        const cols = p.sdb.prepare(`PRAGMA table_info(${p.prefix}bookings)`).all().map((c: any) => c.name);
        assert.ok(cols.includes('client_key'));
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

    await withPlugin('event-tickets', async (p) => {
        const cols = p.sdb.prepare(`PRAGMA table_info(${p.prefix}orders)`).all().map((c: any) => c.name);
        assert.ok(cols.includes('client_key'));
        await seedEvent(p);
        assert.strictEqual((await order(p, 'c1', 'a@x.io', 2)).status, 200);
    }, (sdb, P) => sdb.exec(`CREATE TABLE ${P}orders (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, event_id INTEGER, buyer_name TEXT NOT NULL,
        buyer_email TEXT NOT NULL, items TEXT, total_cents INTEGER, payment_status TEXT DEFAULT 'pending', created_at TEXT)`));
});
