/**
 * conference-manager 2.18.0 — «Pagos de cuotas»: split fee payments (admin + coordinator portal).
 *
 * Pinned against the REAL plugin (fixtures/conference-manager-harness.ts — its SQL goes through the host's
 * real guard). The model: a payment is one receipt (`payment_transfers`, the header) split into parts (rows
 * of `payments` with transfer_id / alloc_gen); the status lives on the header; THE effective status of a
 * part is EFFECTIVE (server/fee-payments.js). The owner's decisions pinned here:
 *   - the split adds up to the receipt to the cent; «Iguales» gives the leftover cents to the first parts;
 *   - NEVER more than what a person owes, counting money still awaiting validation (admin AND portal);
 *   - the receipt is required for a transfer and optional for cash; it is stored ONCE (parts carry none),
 *     never travels in a list, and only its own location's portal (or payments:view) can fetch it;
 *   - an admin payment is born validated unless «Dejar por validar»; the portal's are pending;
 *   - validate is all-or-nothing and compare-and-set on { status, alloc_gen }; return / reject need a reason;
 *     a validated payment is never edited or deleted (reject → «Duplicar» re-uses the receipt);
 *   - the portal sees only its location, its own payments in full and the administration's lines for its
 *     people without receipt or reference (D-P22);
 *   - pre-2.18 data is wrapped as 1-part payments at boot (idempotent) and the pre-2.18 routes keep working
 *     as wrappers; /portal/payments/bulk becomes ONE payment of N parts;
 *   - /accounting has one line per validated payment; transport money stays apart.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { bootPlugin, PLUGIN_DIR, type HarnessUser } from './fixtures/conference-manager-harness';

const INS = 'wjp_conference_manager_inscriptions';
const PAY = 'wjp_conference_manager_payments';
const TR = 'wjp_conference_manager_payment_transfers';
const EV = 'wjp_conference_manager_payment_transfer_events';
const TICKETS = 'wjp_conference_manager_transport_tickets';
const TPAY = 'wjp_conference_manager_transport_payments';
const PSALES = 'wjp_conference_manager_transport_package_sales';
const PPAY = 'wjp_conference_manager_transport_package_payments';

const split = require(path.join(PLUGIN_DIR, 'server', 'fee-split.js'));

type P = Awaited<ReturnType<typeof bootPlugin>>;
const PROOF = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// A real 1 × 1 JPEG (its SOF0 frame header declares the size the server reads; a truncated one is refused).
const PROOF2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };
const fail = (r: any, status: number, code?: string, what = '') => {
    assert.strictEqual(r.status, status, `${what} expected ${status}: ${JSON.stringify(r.body)}`);
    if (code) assert.strictEqual(r.body.code, code, `${what} code: ${JSON.stringify(r.body)}`);
    return r.body;
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * A conference (fee 100) with a published form, location A (cash + transfer), location B (cash only) and
 * people: a1, a2, a3 (A), b1 (B), cx (A, cancelled), plus a person of ANOTHER conference.
 */
async function world(p: P) {
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `fees-${++seq}`, fee_default: 100 } }), 'create').id as number;
    for (const template of ['first_name', 'last_name']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }), 'publish');
    const locA = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Bogotá', capacity: 100 } }), 'A');
    const locB = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Cali', capacity: 100, payment_methods: ['Efectivo'] } }), 'B');
    const person = async (first: string, last: string, location_id: number | null) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: first, last_name: last, location_id } }), first).id as number;
    const a1 = await person('Ana', 'Pérez', locA.id), a2 = await person('Luis', 'Pérez', locA.id), a3 = await person('Sol', 'Pérez', locA.id);
    const b1 = await person('Beto', 'Gómez', locB.id);
    const cx = await person('Carla', 'Ruiz', locA.id);
    ok(await p.call('put', `/inscriptions/${cx}`, { body: { status: 'cancelled' } }), 'cancel');
    const other = ok(await p.call('post', '/create', { body: { name: 'Otro', slug: `fees-other-${++seq}`, fee_default: 100 } })).id as number;
    const foreign = ok(await p.call('post', '/inscriptions', { body: { conference_id: other, first_name: 'Gil', last_name: 'Vega' } })).id as number;
    return { cid, A: locA.id as number, codeA: locA.code as string, B: locB.id as number, codeB: locB.code as string, a1, a2, a3, b1, cx, other, foreign };
}
type W = Awaited<ReturnType<typeof world>>;

async function portalOf(p: P, locationId: number, code: string) {
    const token = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: locationId, code } }), 'login').token as string;
    return (method: string, url: string, body?: any) => p.call(method, url, { anonymous: true, body, headers: { 'x-portal-token': token } });
}
const pay = (p: P, body: any, user?: HarnessUser) => p.call('post', '/fee-payments', { body, ...(user ? { user } : {}) });
const row = (p: P, id: number) => p.one(`SELECT amount_paid, payment_status FROM ${INS} WHERE id = ?`, id) as any;
const parts = (p: P, transferId: number) => p.q(`SELECT inscription_id, amount, alloc_gen, proof, status FROM ${PAY} WHERE transfer_id = ? ORDER BY id`, transferId) as any[];
const roster = async (p: P, cid: number) => new Map((ok(await p.call('get', `/inscriptions?conference_id=${cid}`)) as any[]).map(r => [r.id, r]));
const expectOf = (t: any) => ({ status: t.status, alloc_gen: t.alloc_gen });

// ── pure split rules (server/fee-split.js — the vectors the client and portal copies share) ─────────────

test('split rules: equal split gives leftover cents to the first parts; money input; allocation codes', () => {
    assert.deepStrictEqual(split.splitEqual(10000, 3), [3334, 3333, 3333]);
    assert.deepStrictEqual(split.splitEqual(10001, 3), [3334, 3334, 3333]);
    assert.deepStrictEqual(split.splitEqual(2, 3), [1, 1, 0]);
    assert.deepStrictEqual(split.splitEqual(75000, 2), [37500, 37500]);
    assert.deepStrictEqual(split.splitEqual(100, 0), []);
    for (const n of [1, 2, 3, 7, 13, 200]) for (const total of [1, 99, 10000, 123457]) {
        if (total < n) continue;
        const s = split.splitEqual(total, n);
        assert.strictEqual(s.reduce((a: number, b: number) => a + b, 0), total, `sum ${total}/${n}`);
        assert.ok(Math.max(...s) - Math.min(...s) <= 1);
        assert.deepStrictEqual(s, [...s].sort((a: number, b: number) => b - a), 'bigger parts first');
    }
    const money: [any, number | null][] = [
        ['1.250,50', 125050], ['1250.50', 125050], ['1250,5', 125050], ['1.250', 125000], ['1,250', 125000],
        ['$ 750', 75000], ['1.234.567,89', 123456789], ['1,234,567.89', 123456789], ['0,5', 50], ['33.33', 3333],
        [100, 10000], ['', null], ['abc', null], ['1.2.3', null], ['-5', null], ['1,234.5,6', null], ['10.999', 1099900],
        ['12.345', 1234500], ['1.25', 125],
    ];
    for (const [input, cents] of money) assert.strictEqual(split.parseMoneyInput(input), cents, JSON.stringify(input));
    const v = (parts: any[], total: number) => split.validateAllocations(parts, total);
    assert.deepStrictEqual(v([], 100), { ok: false, code: 'empty' });
    assert.strictEqual(v(Array.from({ length: 201 }, (_, i) => ({ inscription_id: i + 1, cents: 1 })), 201).code, 'too_many');
    assert.strictEqual(v([{ inscription_id: null, cents: 1 }], 1).code, 'invalid_id');
    assert.deepStrictEqual(v([{ inscription_id: 1, cents: 1 }, { inscription_id: 1, cents: 1 }], 2), { ok: false, code: 'duplicate', ids: [1] });
    assert.deepStrictEqual(v([{ inscription_id: 1, cents: 0 }, { inscription_id: 2, cents: 2 }], 2), { ok: false, code: 'non_positive', ids: [1] });
    assert.deepStrictEqual(v([{ inscription_id: 1, cents: 3333 }, { inscription_id: 2, cents: 3333 }, { inscription_id: 3, cents: 3333 }], 10000),
        { ok: false, code: 'sum_mismatch', assigned: 9999, diff: 1 });
    assert.deepStrictEqual(v([{ inscription_id: 1, cents: 3334 }, { inscription_id: 2, cents: 3333 }, { inscription_id: 3, cents: 3333 }], 10000), { ok: true });
    assert.deepStrictEqual(split.splitState(10000, [5000, 4000]), { assigned: 9000, diff: 1000, ok: false });
});

// ── create ──────────────────────────────────────────────────────────────────────────────────────────

test('admin create: born validated (or «Dejar por validar»), exact sum to the cent, equal split server-side, multi-location', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // 100.00 between three people: 33.33 × 3 is a cent short → refused, nothing written.
    const before = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    const short = fail(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [w.a1, w.a2, w.a3].map(id => ({ inscription_id: id, amount: 33.33 })) }), 400, 'sum_mismatch');
    assert.strictEqual(short.diff, 0.01);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, before);
    // «Iguales» on the server: the leftover cent goes to the first person.
    const eq = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', inscription_ids: [w.a1, w.a2, w.a3], split: 'equal', paid_on: '2026-10-01' }));
    assert.deepStrictEqual(eq.transfer.allocations.map((a: any) => [a.inscription_id, a.amount]), [[w.a1, 33.34], [w.a2, 33.33], [w.a3, 33.33]]);
    assert.strictEqual(eq.transfer.status, 'validated', 'admin payments are born validated');
    assert.strictEqual(eq.transfer.amount, 100);
    assert.strictEqual(eq.transfer.allocated, 100);
    assert.strictEqual(eq.transfer.paid_on, '2026-10-01');
    assert.strictEqual(eq.transfer.recorded_via, 'admin');
    assert.strictEqual(eq.transfer.reviewed_by, 'boss');
    assert.strictEqual(eq.transfer.location_id, w.A, 'all its people are in A');
    assert.deepStrictEqual(parts(p, eq.id).map(r => r.amount), [33.34, 33.33, 33.33]);
    assert.deepStrictEqual([row(p, w.a1), row(p, w.a2)], [{ amount_paid: 33.34, payment_status: 'partial' }, { amount_paid: 33.33, payment_status: 'partial' }]);
    // «Dejar por validar»: pending, nothing counted yet.
    const lp = ok(await pay(p, { conference_id: w.cid, amount: 50, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.b1, amount: 50 }] }));
    assert.strictEqual(lp.transfer.status, 'pending');
    assert.deepStrictEqual(row(p, w.b1), { amount_paid: 0, payment_status: 'unpaid' });
    // Several locations in one admin payment (D-P3): allowed, the header names no single location.
    const mixed = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.b1, amount: 20 }] }));
    assert.strictEqual(mixed.transfer.location_id, null);
    assert.strictEqual(mixed.transfer.mixed, true);
    assert.deepStrictEqual(mixed.transfer.locations, [w.A, w.B].sort((a, b) => a - b));
    // Today is the default payment date; a future date is refused.
    const dflt = ok(await pay(p, { conference_id: w.cid, amount: 1, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 1 }] }));
    assert.strictEqual(dflt.transfer.paid_on, today());
    fail(await pay(p, { conference_id: w.cid, amount: 1, method: 'Efectivo', paid_on: '2099-01-01', allocations: [{ inscription_id: w.a3, amount: 1 }] }), 400, 'future_date');
    fail(await pay(p, { conference_id: w.cid, amount: 1, method: 'Efectivo', paid_on: '2026-02-30', allocations: [{ inscription_id: w.a3, amount: 1 }] }), 400, 'invalid_date');
});

test('create refuses the whole request: unknown, foreign-conference or cancelled people, bad parts, more than 200 people', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const n0 = p.one(`SELECT COUNT(*) AS n FROM ${PAY}`).n;
    const body = (allocations: any[], amount: number) => ({ conference_id: w.cid, amount, method: 'Efectivo', allocations });
    assert.deepStrictEqual(fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.foreign, amount: 10 }], 20)), 400, 'unknown_people').ids, [w.foreign]);
    assert.deepStrictEqual(fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }, { inscription_id: 999999, amount: 10 }], 20)), 400, 'unknown_people').ids, [999999]);
    assert.deepStrictEqual(fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.cx, amount: 10 }], 20)), 400, 'cancelled_people').ids, [w.cx]);
    fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a1, amount: 10 }], 20)), 400, 'duplicate');
    fail(await pay(p, body([{ inscription_id: w.a1, amount: 0 }, { inscription_id: w.a2, amount: 20 }], 20)), 400, 'non_positive');
    fail(await pay(p, body([{ inscription_id: 'x', amount: 10 }], 10)), 400, 'invalid_id');
    fail(await pay(p, body([], 10)), 400, 'empty');
    fail(await pay(p, body(Array.from({ length: 201 }, (_, i) => ({ inscription_id: i + 1, amount: 1 })), 201)), 400, 'too_many');
    fail(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo' }), 400, 'empty');
    fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }], 0)), 400, 'invalid_amount');
    fail(await pay(p, body([{ inscription_id: w.a1, amount: 10 }], -10)), 400, 'invalid_amount');
    fail(await pay(p, { ...body([{ inscription_id: w.a1, amount: 10 }], 10), method: 'Bitcoin' }), 400);
    fail(await pay(p, { ...body([{ inscription_id: w.a1, amount: 10 }], 10), conference_id: 999999 }), 404);
    fail(await pay(p, { ...body([{ inscription_id: w.a1, amount: 10 }], 10), conference_id: undefined }), 400);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY}`).n, n0, 'no part written by any refused request');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, 0, 'no header written either');
});

test('receipt: required for a transfer, optional for cash (D-P12); must be an image; invalid client keys refused', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const base = { conference_id: w.cid, amount: 10, allocations: [{ inscription_id: w.a1, amount: 10 }] };
    fail(await pay(p, { ...base, method: 'Transferencia', reference: 'R1' }), 400, 'proof_required');
    ok(await pay(p, { ...base, method: 'Efectivo' }), 'cash without a receipt');
    ok(await pay(p, { ...base, method: 'Transferencia', reference: 'R1', proof: PROOF }), 'transfer with a receipt');
    fail(await pay(p, { ...base, method: 'Efectivo', proof: 'data:text/html;base64,PHNjcmlwdD4=' }), 400);
    fail(await pay(p, { ...base, method: 'Efectivo', proof: 'x'.repeat(1400001) }), 400);
    fail(await pay(p, { ...base, method: 'Efectivo', client_key: 'short' }), 400, 'invalid_client_key');
    fail(await pay(p, { ...base, method: 'Efectivo', client_key: 'a b c d e f g h' }), 400, 'invalid_client_key');
});

// ── never overpay (D-P9) ──────────────────────────────────────────────────────────────────────────────

test('never more than what is owed — counting money awaiting validation — for the admin and the portal', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portal = await portalOf(p, w.A, w.codeA);
    // a1 owes 100. 60 pending (portal) leaves 40 for anyone.
    ok(await portal('post', '/portal/fee-payments', { amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] }), 'portal 60');
    const over = fail(await pay(p, { conference_id: w.cid, amount: 41, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 41 }] }), 409, 'over_cap');
    assert.deepStrictEqual(over.people, [{ inscription_id: w.a1, amount: 41, max: 40 }]);
    fail(await portal('post', '/portal/fee-payments', { amount: 40.01, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 40.01 }] }), 409, 'over_cap');
    // Exactly what is left is fine (to the cent), then nothing is left.
    ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 40 }] }), 'admin 40');
    assert.deepStrictEqual(fail(await pay(p, { conference_id: w.cid, amount: 0.01, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 0.01 }] }), 409, 'over_cap').people[0].max, 0);
    // In a split only the offending person is reported; nothing is written.
    const n = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    const mix = fail(await pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 50 }, { inscription_id: w.a1, amount: 10 }] }), 409, 'over_cap', 'a1 owes nothing more');
    assert.deepStrictEqual(mix.people, [{ inscription_id: w.a1, amount: 10, max: 0 }]);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, n);
    // A rejected payment frees its room again; a validated one keeps it taken.
    const r = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 100 }] }));
    fail(await pay(p, { conference_id: w.cid, amount: 1, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 1 }] }), 409, 'over_cap');
    ok(await p.call('post', `/fee-payments/${r.id}/reject`, { body: { note: 'No llegó', expected: expectOf(r.transfer) } }));
    ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 100 }] }), 'after the rejection the whole fee is payable again');
    // Validation re-checks against validated money: the rejected 100 cannot be validated on top of the new 100.
    const back = ok(await p.call('get', `/fee-payments/${r.id}`));
    const v = fail(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(back) } }), 409, 'over_cap');
    assert.deepStrictEqual(v.people, [{ inscription_id: w.a2, amount: 100, max: 0 }]);
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 100, payment_status: 'paid' });
});

test('concurrent payments for the same person are serialised: two that each fit alone cannot jointly overpay', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portal = await portalOf(p, w.A, w.codeA);
    const results = await Promise.all([
        pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] }),
        portal('post', '/portal/fee-payments', { amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] }),
        pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 60 }] }),
    ]);
    assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 409, 409], JSON.stringify(results.map(r => r.body)));
    const live = p.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM ${PAY} WHERE inscription_id = ?`, w.a1).s;
    assert.strictEqual(live, 60);
});

// ── idempotency ────────────────────────────────────────────────────────────────────────────────────────

test('client_key: a retry returns the same payment; another recorder with the same key gets 409; a crashed draft is restarted', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const key = 'k-0123456789abcdef';
    const body = { conference_id: w.cid, amount: 20, method: 'Efectivo', client_key: key, allocations: [{ inscription_id: w.a1, amount: 20 }] };
    const first = ok(await pay(p, body));
    assert.strictEqual(first.replayed, false);
    const again = ok(await pay(p, body));
    assert.strictEqual(again.replayed, true);
    assert.strictEqual(again.id, first.id);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE client_key = ?`, key).n, 1);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 20, payment_status: 'partial' }, 'counted once');
    const portal = await portalOf(p, w.A, w.codeA);
    fail(await portal('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', client_key: key, allocations: [{ inscription_id: w.a1, amount: 20 }] }), 409, 'client_key_conflict');
    // The portal's own key works for the portal (and replays for it).
    const pk = 'portal-key-0001';
    const p1 = ok(await portal('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', client_key: pk, allocations: [{ inscription_id: w.a2, amount: 10 }] }));
    const p2 = ok(await portal('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', client_key: pk, allocations: [{ inscription_id: w.a2, amount: 10 }] }));
    assert.strictEqual(p2.id, p1.id);
    assert.strictEqual(p2.replayed, true);
    // A crashed attempt left a draft under a key: the retry purges it and records the payment once.
    const draftKey = 'draft-key-0001';
    p.exec(`INSERT INTO ${TR} (conference_id, amount, method, status, alloc_gen, recorded_via, recorded_by, client_key) VALUES (?, 5, 'Efectivo', 'draft', 1, 'admin', 'boss', ?)`, w.cid, draftKey);
    const draftId = p.one(`SELECT id FROM ${TR} WHERE client_key = ?`, draftKey).id;
    p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 1, 5, 'Efectivo', 'validated')`, w.a3, draftId);
    const retried = ok(await pay(p, { conference_id: w.cid, amount: 5, method: 'Efectivo', client_key: draftKey, allocations: [{ inscription_id: w.a3, amount: 5 }] }));
    assert.strictEqual(retried.replayed, false);
    assert.notStrictEqual(retried.id, draftId);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE transfer_id = ?`, draftId).n, 0, 'the draft\'s parts are gone');
    assert.deepStrictEqual(row(p, w.a3), { amount_paid: 5, payment_status: 'partial' });
});

// ── the receipt: stored once, never in a list, only for who may see it ─────────────────────────────────

test('the receipt is stored once on the header, never travels in lists, and is served only to who may see it', async () => {
    const viewer: HarnessUser = { id: 41, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'caja', userEmail: 'caja@example.test' };
    const p = await bootPlugin({ users: [viewer] });
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const portalB = await portalOf(p, w.B, w.codeB);
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 200, method: 'Transferencia', reference: 'TRX-77', proof: PROOF, inscription_ids: [w.a1, w.a2] }));
    const tid = r.id;
    assert.deepStrictEqual(parts(p, tid).map(x => x.proof), [null, null], 'parts carry no receipt copy');
    assert.strictEqual(p.one(`SELECT proof FROM ${TR} WHERE id = ?`, tid).proof, PROOF, 'stored once, on the header');
    // Lists and details never carry it.
    const leaks = (x: any) => JSON.stringify(x).includes('iVBORw0KGgo');
    assert.ok(!leaks(r.view), 'portal view');
    assert.ok(!leaks(ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`))), 'admin list');
    assert.ok(!leaks(ok(await p.call('get', `/fee-payments/${tid}`))), 'admin detail');
    assert.ok(!leaks(ok(await p.call('get', `/inscriptions/${w.a1}/payments`))), 'person parts');
    assert.ok(!leaks(ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`))), 'roster');
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${tid}`)).has_proof, true);
    // On demand: the admin, the recording location; never another location.
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${tid}/proof`)).proof, PROOF);
    assert.strictEqual(ok(await portalA('get', `/portal/fee-payments/${tid}/proof`)).proof, PROOF);
    fail(await portalB('get', `/portal/fee-payments/${tid}/proof`), 404, 'not_found');
    fail(await p.call('get', `/portal/fee-payments/${tid}/proof`, { anonymous: true }), 401);
    // payments:view is enough to look at it; no section → 403.
    const roleId = ok(await p.call('post', '/staff/roles', { body: { name: 'Caja ver', permissions: { payments: 'view' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: viewer.id, role_id: roleId } }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${tid}/proof`, { user: viewer })).proof, PROOF);
    // with_proof=1 on the person route is the pre-2.18 client's door to it (payments:view only).
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}/payments?with_proof=1`))[0].proof, PROOF);
    // A cash payment without a receipt: 404 on the proof route.
    const cash = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 10 }] }));
    assert.strictEqual(cash.transfer.has_proof, false);
    fail(await p.call('get', `/fee-payments/${cash.id}/proof`), 404, 'no_proof');
});

// ── the state machine ─────────────────────────────────────────────────────────────────────────────────

test('state machine: every transition, compare-and-set on status and generation, required reasons', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const make = async () => ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
    const act = (t: any, action: string, body: any = {}) => p.call('post', `/fee-payments/${t.id}/${action}`, { body: { expected: expectOf(t), ...body } });
    const get = async (id: number) => ok(await p.call('get', `/fee-payments/${id}`));

    // pending → return (reason required) → returned
    let t = await make();
    fail(await act(t, 'return'), 400, 'note_required');
    fail(await act(t, 'return', { note: '   ' }), 400, 'note_required');
    fail(await act(t, 'return', { note: 'x'.repeat(2001) }), 400, 'note_too_long');
    assert.strictEqual(ok(await act(t, 'return', { note: 'Comprobante ilegible' })).status, 'returned');
    t = await get(t.id);
    assert.strictEqual(t.review_note, 'Comprobante ilegible');
    fail(await act(t, 'return', { note: 'otra vez' }), 409, 'invalid_transition', 'returned → returned');
    // returned → validate
    assert.strictEqual(ok(await act(t, 'validate')).status, 'validated');
    t = await get(t.id);
    assert.strictEqual(t.review_note, null);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 10, payment_status: 'partial' });
    fail(await act(t, 'validate'), 409, 'invalid_transition', 'validated → validated');
    fail(await act(t, 'return', { note: 'x' }), 409, 'invalid_transition', 'validated → returned');
    // validated → reject (void, reason required) → rejected → validate again
    fail(await act(t, 'reject'), 400, 'note_required');
    assert.strictEqual(ok(await act(t, 'reject', { note: 'Anulado: monto equivocado' })).status, 'rejected');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
    t = await get(t.id);
    fail(await act(t, 'reject', { note: 'x' }), 409, 'invalid_transition', 'rejected → rejected');
    assert.strictEqual(ok(await act(t, 'validate')).status, 'validated');
    // pending → reject; returned → reject
    let u = await make();
    assert.strictEqual(ok(await act(u, 'reject', { note: 'No llegó' })).status, 'rejected');
    u = await make();
    ok(await act(u, 'return', { note: 'Falta una persona' }));
    u = await get(u.id);
    assert.strictEqual(ok(await act(u, 'reject', { note: 'No llegó' })).status, 'rejected');

    // Compare-and-set: the status or the generation the caller saw must still be the current one.
    const s = await make();
    const sawPending = expectOf(s);
    fail(await p.call('post', `/fee-payments/${s.id}/validate`, { body: { expected: { status: 'pending', alloc_gen: 2 } } }), 409, 'stale');
    fail(await p.call('post', `/fee-payments/${s.id}/validate`, { body: { expected: { status: 'returned', alloc_gen: 1 } } }), 409, 'stale');
    fail(await p.call('post', `/fee-payments/${s.id}/validate`, { body: {} }), 400, 'expected_required');
    // Someone re-splits it meanwhile → the old view's validate is refused (the admin validates exactly what
    // they saw).
    ok(await p.call('put', `/fee-payments/${s.id}`, { body: { expected: sawPending, amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] } }));
    const stale = fail(await p.call('post', `/fee-payments/${s.id}/validate`, { body: { expected: sawPending } }), 409, 'stale');
    assert.deepStrictEqual(stale.current, { status: 'pending', alloc_gen: 2 });
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 0, payment_status: 'unpaid' }, 'nothing validated');
    // Unknown ids / non-integers → 404.
    fail(await p.call('post', '/fee-payments/999999/validate', { body: { expected: sawPending } }), 404, 'not_found');
    fail(await p.call('get', '/fee-payments/abc'), 404);
    fail(await p.call('get', '/fee-payments/999999'), 404);

    // Delete: never a validated payment; pending / returned / rejected yes (admin).
    const v = await get(t.id);
    assert.strictEqual(v.status, 'validated');
    fail(await p.call('delete', `/fee-payments/${v.id}`), 409, 'validated_delete');
    const d1 = await make();
    ok(await p.call('delete', `/fee-payments/${d1.id}`));
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE transfer_id = ?`, d1.id).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, d1.id).n, 0);
    const d2 = await get(u.id);
    assert.strictEqual(d2.status, 'rejected');
    fail(await p.call('delete', `/fee-payments/${d2.id}`, { body: { expected: { status: 'pending', alloc_gen: 1 } } }), 409, 'stale');
    ok(await p.call('delete', `/fee-payments/${d2.id}`, { body: { expected: expectOf(d2) } }));
    // History: each transition left a line.
    const ev = (await get(t.id)).events.map((e: any) => e.action);
    assert.deepStrictEqual(ev, ['created', 'returned', 'validated', 'rejected', 'validated']);
});

test('edit: only pending / returned, a generation swap — no stale part ever counts; a validated payment is never edited', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 30 }, { inscription_id: w.a2, amount: 30 }] })).transfer;
    assert.strictEqual(t.alloc_gen, 1);
    const pendingOf = async () => { const m = await roster(p, w.cid); return [w.a1, w.a2, w.a3].map(id => m.get(id).pending_amount); };
    assert.deepStrictEqual(await pendingOf(), [30, 30, 0]);
    // Re-split: a2 out, a3 in, amounts changed.
    const e = ok(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 45 }, { inscription_id: w.a3, amount: 15 }] } })).transfer;
    assert.strictEqual(e.alloc_gen, 2);
    assert.deepStrictEqual(parts(p, t.id).map(x => [x.inscription_id, x.amount, x.alloc_gen]), [[w.a1, 45, 2], [w.a3, 15, 2]], 'the old generation is gone');
    assert.deepStrictEqual(await pendingOf(), [45, 0, 15]);
    // A stale generation row (an interrupted edit) never counts.
    p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 1, 999, 'Efectivo', 'pending')`, w.a2, t.id);
    assert.deepStrictEqual(await pendingOf(), [45, 0, 15]);
    ok(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(e) } }));
    assert.deepStrictEqual([row(p, w.a1).amount_paid, row(p, w.a2).amount_paid, row(p, w.a3).amount_paid], [45, 0, 15]);
    // A validated payment cannot be edited (void it, then «Duplicar»).
    const v = ok(await p.call('get', `/fee-payments/${t.id}`));
    fail(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(v), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] } }), 409, 'invalid_transition');
    // The edit's own refusals: sum, cap (excluding its own parts), expected required.
    const q = ok(await pay(p, { conference_id: w.cid, amount: 50, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.b1, amount: 50 }] })).transfer;
    fail(await p.call('put', `/fee-payments/${q.id}`, { body: { amount: 50, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 50 }] } }), 400, 'expected_required');
    fail(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q), amount: 50, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 40 }] } }), 400, 'sum_mismatch');
    ok(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q), amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 100 }] } }), 'its own 50 does not block raising it to the full fee');
    const q2 = ok(await p.call('get', `/fee-payments/${q.id}`));
    fail(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q2), amount: 100.01, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 100.01 }] } }), 409, 'over_cap');
    fail(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q2), amount: 100, method: 'Transferencia', allocations: [{ inscription_id: w.b1, amount: 100 }] } }), 400, 'proof_required', 'a transfer needs a receipt');
    ok(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q2), amount: 100, method: 'Transferencia', reference: 'R-9', proof: PROOF, allocations: [{ inscription_id: w.b1, amount: 100 }] } }));
    const q3 = ok(await p.call('get', `/fee-payments/${q.id}`));
    assert.strictEqual(q3.has_proof, true);
    // Kept when not sent; the method may go back to cash and drop the receipt (proof: null).
    ok(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q3), amount: 100, method: 'Transferencia', reference: 'R-9', allocations: [{ inscription_id: w.b1, amount: 100 }] } }));
    const q4 = ok(await p.call('get', `/fee-payments/${q.id}`));
    assert.strictEqual(q4.has_proof, true, 'kept');
    fail(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q4), amount: 100, method: 'Transferencia', proof: null, allocations: [{ inscription_id: w.b1, amount: 100 }] } }), 400, 'proof_required');
    ok(await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q4), amount: 100, method: 'Efectivo', proof: null, allocations: [{ inscription_id: w.b1, amount: 100 }] } }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${q.id}`)).has_proof, false);
});

test('«Duplicar»: void a validated payment, then record it again re-using its receipt (copy_proof_from)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Transferencia', reference: 'BANK-1', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'Era para dos personas', expected: expectOf(t) } }));
    const dup = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Transferencia', reference: 'BANK-1', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 50 }, { inscription_id: w.a2, amount: 50 }] }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${dup.id}/proof`)).proof, PROOF2);
    assert.deepStrictEqual([row(p, w.a1).amount_paid, row(p, w.a2).amount_paid], [50, 50]);
    fail(await pay(p, { conference_id: w.cid, amount: 1, method: 'Transferencia', reference: 'X', copy_proof_from: 999999, allocations: [{ inscription_id: w.a3, amount: 1 }] }), 400, 'proof_source');
    // A duplicate transfer reference among live payments: 409 unless confirmed.
    const again = fail(await pay(p, { conference_id: w.cid, amount: 10, method: 'Transferencia', reference: ' bank-1 ', proof: PROOF, allocations: [{ inscription_id: w.a3, amount: 10 }] }), 409, 'duplicate_reference');
    assert.deepStrictEqual(again.other, { id: dup.id });
    ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Transferencia', reference: ' bank-1 ', proof: PROOF, allow_duplicate_reference: true, allocations: [{ inscription_id: w.a3, amount: 10 }] }));
    const list = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.deepStrictEqual(list.transfers.filter((x: any) => x.flags.duplicate_reference).map((x: any) => x.id).length, 2, '«Referencia repetida» on both live ones');
});

test('admin list filters: status, location (header or any person), person, recorder, method, payment date range', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const t1 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', paid_on: '2026-09-01', allocations: [{ inscription_id: w.a1, amount: 10 }] })).id;
    const t2 = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Transferencia', reference: 'T2', proof: PROOF, paid_on: '2026-09-10', allocations: [{ inscription_id: w.a2, amount: 10 }, { inscription_id: w.b1, amount: 10 }] })).id;
    const t3 = ok(await portalA('post', '/portal/fee-payments', { amount: 5, method: 'Efectivo', paid_on: '2026-09-20', allocations: [{ inscription_id: w.a3, amount: 5 }] })).id;
    const ids = async (qs: string) => ok(await p.call('get', `/fee-payments?conference_id=${w.cid}&${qs}`)).transfers.map((t: any) => t.id).sort((a: number, b: number) => a - b);
    assert.deepStrictEqual(await ids('status=pending'), [t3]);
    assert.deepStrictEqual(await ids('status=validated,pending'), [t1, t2, t3]);
    assert.deepStrictEqual(await ids(`location_id=${w.B}`), [t2], 'a mixed payment counts for each location of its people');
    assert.deepStrictEqual(await ids(`location_id=${w.A}`), [t1, t2, t3]);
    assert.deepStrictEqual(await ids('location_id=abc'), []);
    assert.deepStrictEqual(await ids(`inscription_id=${w.b1}`), [t2]);
    assert.deepStrictEqual(await ids('recorded_via=portal'), [t3]);
    assert.deepStrictEqual(await ids('method=Transferencia'), [t2]);
    assert.deepStrictEqual(await ids('from=2026-09-05&to=2026-09-15'), [t2]);
    // The summary and the counts are always over the whole conference.
    const v = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}&status=pending`));
    assert.deepStrictEqual(v.counts, { pending: 1, validated: 2, returned: 0, rejected: 0, total: 3 });
    assert.strictEqual(v.summary.validated, 30);
    assert.strictEqual(v.summary.pending, 5);
    // «Sin localidad» (`none`) is one of the locations a payment's people can have: a payment of people
    // without a location, and a mixed one where one of its people has none (the admin's «Pagos» and
    // «Contabilidad» filters match the same way).
    const nobody = async (first: string) => ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: first, last_name: 'Sin', location_id: null } }), first).id as number;
    const n1 = await nobody('Nora'), n2 = await nobody('Noel');
    const t4 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', allocations: [{ inscription_id: n1, amount: 10 }] })).id;
    const t5 = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: n2, amount: 10 }] })).id;
    assert.deepStrictEqual(await ids('location_id=none'), [t4, t5], 'none: no location on the payment and one of its people has none');
    assert.deepStrictEqual(await ids(`location_id=${w.A}`), [t1, t2, t3, t5]);
    fail(await p.call('get', '/fee-payments'), 400);
    fail(await p.call('get', '/fee-payments?conference_id=999999'), 404);
});

// ── recompute and the readers ───────────────────────────────────────────────────────────────────────

test('recompute: amount_paid / payment_status from validated live parts; pending_amount and returned_amount on the roster', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 150, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 50 }] })).transfer;
    let m = await roster(p, w.cid);
    assert.deepStrictEqual([m.get(w.a1).pending_amount, m.get(w.a2).pending_amount, m.get(w.a1).returned_amount], [100, 50, 0]);
    assert.strictEqual(m.get(w.a1).payment_status, 'unpaid');
    ok(await p.call('post', `/fee-payments/${t.id}/return`, { body: { note: 'Falta el comprobante', expected: expectOf(t) } }));
    m = await roster(p, w.cid);
    assert.deepStrictEqual([m.get(w.a1).pending_amount, m.get(w.a1).returned_amount, m.get(w.a2).returned_amount], [0, 100, 50]);
    const one = ok(await p.call('get', `/inscriptions/${w.a1}`));
    assert.strictEqual(one.returned_amount, 100);
    const r = ok(await p.call('get', `/fee-payments/${t.id}`));
    ok(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(r) } }));
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 100, payment_status: 'paid' });
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 50, payment_status: 'partial' });
    m = await roster(p, w.cid);
    assert.deepStrictEqual([m.get(w.a1).pending_amount, m.get(w.a1).returned_amount], [0, 0]);
    // The mirror on the parts follows the header (for a downgrade).
    assert.deepStrictEqual(parts(p, t.id).map(x => x.status), ['validated', 'validated']);
    // /reprice keeps payment_status coherent through the same recompute.
    ok(await p.call('put', `/${w.cid}`, { body: { fee_default: 50 } }));
    ok(await p.call('post', '/reprice', { body: { conference_id: w.cid } }));
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 50, payment_status: 'paid' });
    // Admin view: per-person money and the «Resumen» totals in cents.
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    const a1 = view.people.find((x: any) => x.id === w.a1);
    assert.deepStrictEqual({ due: a1.due, validated: a1.validated, credit: a1.credit, to_cover: a1.to_cover, payable: a1.payable }, { due: 50, validated: 100, credit: 50, to_cover: 0, payable: false });
    const cx = view.people.find((x: any) => x.id === w.cx);
    assert.deepStrictEqual({ due: cx.due, cancelled: cx.cancelled, payable: cx.payable }, { due: 0, cancelled: true, payable: false }, 'D-P19: a cancelled inscription owes nothing');
    // «Validado» counts each person's money up to their fee (a1's extra 50 is «A favor» only), so
    // Validado + Por validar + Por cobrar = Cuotas — the same figures the coordinator's «Resumen» shows.
    assert.strictEqual(view.summary.validated, 100);
    assert.strictEqual(view.summary.cancelled, 1);
    assert.strictEqual(view.summary.people, 4);
    assert.strictEqual(view.summary.due, 200, 'four active people at 50');
    assert.strictEqual(view.summary.to_cover, 100, 'a3 and b1 still owe 50 each');
    assert.strictEqual(view.summary.credit, 50);
    assert.strictEqual(view.summary.validated + view.summary.pending + view.summary.to_cover, view.summary.due);
    const byA = view.by_location.find((x: any) => x.location_id === w.A);
    assert.strictEqual(byA.location, 'Bogotá');
    assert.strictEqual(byA.validated, 100);
    assert.strictEqual(byA.validated + byA.pending + byA.to_cover, byA.due);
    assert.deepStrictEqual(view.counts, { pending: 0, validated: 1, returned: 0, rejected: 0, total: 1 });
});

test('reports: «Por validar» and «Devuelto» per location and in total; the CSV export gains «Por validar»', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 30 }] }));
    const r = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.b1, amount: 20 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${r.id}/return`, { body: { note: 'Revisar', expected: expectOf(r) } }));
    const s = ok(await p.call('get', `/reports/summary?conference_id=${w.cid}`));
    assert.strictEqual(s.totals.pending, 30);
    assert.strictEqual(s.totals.returned, 20);
    assert.deepStrictEqual(s.byLocation.map((x: any) => [x.location, x.pending, x.returned]).sort(), [['Bogotá', 30, 0], ['Cali', 0, 20]]);
    const csv = ok(await p.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    const head = lines[0].split(',');
    const col = head.indexOf('Por validar');
    assert.ok(col > head.indexOf('Pagado'), lines[0]);
    const ana = lines.find(l => l.startsWith('Ana,'))!.split(',');
    assert.strictEqual(ana[col], '30.00');
});

test('accounting: ONE line per validated payment (D-P15), dated by the payment date (D-P14), with its parts', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Transferencia', reference: 'BANCO-55', proof: PROOF, paid_on: '2026-09-15', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }, { inscription_id: w.a3, amount: 50 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', paid_on: '2026-09-20', allocations: [{ inscription_id: w.b1, amount: 40 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.b1, amount: 10 }] }));
    const led = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    const fee = led.entries.filter((e: any) => e.source === 'inscription');
    assert.strictEqual(fee.length, 2, 'pending money is not in the ledger');
    const shared = fee.find((e: any) => e.people === 3);
    assert.strictEqual(shared.description, 'Pago de cuotas · 3 personas');
    assert.strictEqual(shared.amount, 250);
    assert.strictEqual(shared.date, '2026-09-15');
    assert.strictEqual(shared.reference, 'BANCO-55');
    assert.strictEqual(shared.location_id, w.A);
    assert.strictEqual(shared.inscription_id, null);
    assert.ok(/^transfer-\d+$/.test(shared.id));
    assert.deepStrictEqual(shared.allocations, [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }, { inscription_id: w.a3, amount: 50 }]);
    const single = fee.find((e: any) => e.people === 1);
    assert.strictEqual(single.description, 'Pago de inscripción');
    assert.strictEqual(single.inscription_id, w.b1);
    assert.strictEqual(single.location_id, w.B);
    assert.strictEqual(led.totals.income, 290);
    // The detail sheet's total equals the «Inscripciones» lines.
    const detail = fee.flatMap((e: any) => e.allocations).reduce((s: number, a: any) => s + Math.round(a.amount * 100), 0);
    assert.strictEqual(detail, 29000);
});

test('transport stays apart: fee payments never touch tickets or transport payments, and the reverse', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // 2.26.0: transport is sold as packages of buses, paid per package.
    const bus = ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name: 'Bus 1', capacity: 10 } })).id;
    const pkg = ok(await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'Ida', price: 30, bus_ids: [bus] } })).id;
    ok(await p.call('post', `/transport/packages/${pkg}/sales`, { body: { inscription_ids: [w.a1] } }));
    const sale = p.one(`SELECT id FROM ${PSALES} WHERE inscription_id = ?`, w.a1).id;
    ok(await p.call('post', `/transport/package-sales/${sale}/payments`, { body: { amount: 30, method: 'Efectivo' } }));
    const tickets0 = p.q(`SELECT * FROM ${TICKETS} ORDER BY id`), tpay0 = p.q(`SELECT * FROM ${TPAY} ORDER BY id`);
    const sales0 = p.q(`SELECT * FROM ${PSALES} ORDER BY id`), ppay0 = p.q(`SELECT * FROM ${PPAY} ORDER BY id`);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' }, 'the ticket payment is not fee money');
    const t = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } }));
    const v = ok(await p.call('get', `/fee-payments/${t.id}`));
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'x', expected: expectOf(v) } }));
    assert.deepStrictEqual(p.q(`SELECT * FROM ${TICKETS} ORDER BY id`), tickets0);
    assert.deepStrictEqual(p.q(`SELECT * FROM ${TPAY} ORDER BY id`), tpay0);
    assert.deepStrictEqual(p.q(`SELECT * FROM ${PSALES} ORDER BY id`), sales0);
    assert.deepStrictEqual(p.q(`SELECT * FROM ${PPAY} ORDER BY id`), ppay0);
    const led = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    assert.deepStrictEqual(led.entries.filter((e: any) => e.source === 'transport').map((e: any) => [e.amount, e.location_id]), [[30, w.A]]);
    // The fee validate / recompute paths never read the transport tables.
    const from = p.sqlLog.length;
    const t2 = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 20 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t2.id}/validate`, { body: { expected: expectOf(t2) } }));
    assert.ok(!p.sqlLog.slice(from).some(s => s.includes(TICKETS) || s.includes(TPAY) || s.includes(PSALES) || s.includes(PPAY)), 'no transport table in the fee write path');
});

// ── the coordinator portal ─────────────────────────────────────────────────────────────────────────────

test('portal: own location only, enabled methods only, pending until the admin validates; the view; cancelled people', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const portalB = await portalOf(p, w.B, w.codeB);
    // Another location's person, a foreign conference's or a cancelled one: the whole payment is refused.
    assert.deepStrictEqual(fail(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.b1, amount: 10 }] }), 400, 'unknown_people').ids, [w.b1]);
    fail(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.foreign, amount: 10 }] }), 400, 'unknown_people');
    fail(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.cx, amount: 10 }] }), 400, 'cancelled_people');
    // B accepts cash only.
    fail(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Transferencia', reference: 'R', proof: PROOF, allocations: [{ inscription_id: w.b1, amount: 10 }] }), 400);
    // A location with no method enabled cannot record.
    ok(await p.call('put', `/locations/${w.B}`, { body: { payment_methods: [] } }));
    fail(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] }), 400, 'no_methods');
    assert.strictEqual(ok(await portalB('get', '/portal/fee-payments')).can_record, false);
    // A family of three, one transfer, equal split; always pending (even with leave_pending: false).
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: 'FAM-1', proof: PROOF, inscription_ids: [w.a1, w.a2, w.a3], leave_pending: false, validate: true }));
    const mine = r.view.transfers.find((t: any) => t.id === r.id);
    assert.strictEqual(mine.status, 'pending');
    assert.deepStrictEqual(mine.allocations.map((a: any) => a.amount), [83.34, 83.33, 83.33]);
    assert.strictEqual(mine.foreign, false);
    assert.strictEqual(mine.can_edit, true);
    assert.strictEqual(p.one(`SELECT recorded_by FROM ${TR} WHERE id = ?`, r.id).recorded_by, `portal:${w.A}`);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' }, 'not counted before validation');
    const view = r.view;
    assert.deepStrictEqual(view.methods, ['Efectivo', 'Transferencia']);
    assert.deepStrictEqual(view.features, { fee_payments: 1 });
    assert.deepStrictEqual(view.people.map((x: any) => x.id).sort((a: number, b: number) => a - b), [w.a1, w.a2, w.a3, w.cx].sort((a, b) => a - b), 'own location only');
    const a1 = view.people.find((x: any) => x.id === w.a1);
    assert.deepStrictEqual({ pending: a1.pending, to_cover: a1.to_cover, payable: a1.payable }, { pending: 83.34, to_cover: 16.66, payable: true });
    assert.deepStrictEqual(view.counts, { pending: 1, validated: 0, returned: 0, rejected: 0, total: 1 });
    // /portal/inscriptions: pending money and the cancelled flag (never the raw status), stable order.
    const list = ok(await portalA('get', '/portal/inscriptions'));
    const ana = list.find((x: any) => x.id === w.a1);
    assert.strictEqual(ana.pending_amount, 83.34);
    assert.strictEqual(ana.returned_amount, 0);
    assert.strictEqual(ana.cancelled, false);
    assert.strictEqual(list.find((x: any) => x.id === w.cx).cancelled, true);
    assert.ok(list.every((x: any) => !('status' in x) && !('notes' in x) && !('reg_code' in x)), 'privacy projection kept');
    // /portal/me and /portal/login carry the feature flag and the badge counters.
    const me = ok(await portalA('get', '/portal/me'));
    assert.deepStrictEqual([me.features, me.fees], [{ fee_payments: 1 }, { pending: 1, returned: 0 }]);
    const login = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.A, code: w.codeA } }));
    assert.deepStrictEqual(login.location.fees, { pending: 1, returned: 0 });
    // B sees none of it.
    const vb = ok(await portalB('get', '/portal/fee-payments'));
    assert.deepStrictEqual(vb.transfers, []);
    fail(await portalB('put', `/portal/fee-payments/${r.id}`, { expected: expectOf(mine), amount: 250, method: 'Efectivo', inscription_ids: [w.b1] }), 404, 'not_found');
    fail(await portalB('delete', `/portal/fee-payments/${r.id}`), 404, 'not_found');
    fail(await p.call('get', '/portal/fee-payments', { anonymous: true }), 401);
});

test('portal: returned → fixed and resent; delete own pending / returned; the administration\'s lines are read-only, without receipt (D-P22)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 200, method: 'Transferencia', reference: 'R-1', proof: PROOF, allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }] }));
    const t = ok(await p.call('get', `/fee-payments/${r.id}`));
    ok(await p.call('post', `/fee-payments/${r.id}/return`, { body: { note: 'Luis ya había pagado; corrige el reparto', expected: expectOf(t) } }));
    let view = ok(await portalA('get', '/portal/fee-payments'));
    let mine = view.transfers.find((x: any) => x.id === r.id);
    assert.strictEqual(mine.status, 'returned');
    assert.strictEqual(mine.review_note, 'Luis ya había pagado; corrige el reparto');
    assert.deepStrictEqual(ok(await portalA('get', '/portal/me')).fees, { pending: 0, returned: 1 });
    // Fix (people, amounts, new receipt) and resend → pending again, new generation.
    const fixed = ok(await portalA('put', `/portal/fee-payments/${r.id}`, { expected: expectOf(mine), amount: 200, method: 'Transferencia', reference: 'R-1', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a3, amount: 100 }] }));
    mine = fixed.view.transfers.find((x: any) => x.id === r.id);
    assert.strictEqual(mine.status, 'pending');
    assert.strictEqual(mine.alloc_gen, 2);
    assert.deepStrictEqual(mine.allocations.map((a: any) => a.inscription_id), [w.a1, w.a3]);
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${r.id}/proof`)).proof, PROOF2);
    assert.deepStrictEqual(ok(await p.call('get', `/fee-payments/${r.id}`)).events.map((e: any) => e.action), ['created', 'returned', 'resent']);
    // A stale expected is refused; the portal cannot edit a validated payment.
    fail(await portalA('put', `/portal/fee-payments/${r.id}`, { expected: { status: 'returned', alloc_gen: 1 }, amount: 200, method: 'Transferencia', allocations: [{ inscription_id: w.a1, amount: 200 }] }), 409, 'stale');
    const t2 = ok(await p.call('get', `/fee-payments/${r.id}`));
    ok(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(t2) } }));
    fail(await portalA('put', `/portal/fee-payments/${r.id}`, { expected: { status: 'validated', alloc_gen: 2 }, amount: 200, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a3, amount: 100 }] }), 409, 'invalid_transition');
    fail(await portalA('delete', `/portal/fee-payments/${r.id}`), 409, 'validated_delete');
    // Delete own pending, own returned; not a rejected one.
    const d = ok(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] }));
    ok(await portalA('delete', `/portal/fee-payments/${d.id}`));
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, d.id).n, 0);
    const rj = ok(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] }));
    const rjt = ok(await p.call('get', `/fee-payments/${rj.id}`));
    ok(await p.call('post', `/fee-payments/${rj.id}/reject`, { body: { note: 'No llegó', expected: expectOf(rjt) } }));
    fail(await portalA('delete', `/portal/fee-payments/${rj.id}`), 409, 'invalid_transition');
    // «Duplicar» of its own rejected payment re-uses the receipt — the portal may copy only its own.
    const adminT = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Transferencia', reference: 'SEDE-1', proof: PROOF2, allocations: [{ inscription_id: w.a2, amount: 20 }, { inscription_id: w.b1, amount: 10 }] }));
    fail(await portalA('post', '/portal/fee-payments', { amount: 5, method: 'Transferencia', reference: 'Z', copy_proof_from: adminT.id, allocations: [{ inscription_id: w.a2, amount: 5 }] }), 400, 'proof_source');
    // The administration's payment for A's people: only A's part, no receipt, no reference, read-only.
    view = ok(await portalA('get', '/portal/fee-payments'));
    const foreign = view.transfers.find((x: any) => x.id === adminT.id);
    assert.deepStrictEqual({ foreign: foreign.foreign, recorded_via: foreign.recorded_via, amount: foreign.amount, people: foreign.people, reference: foreign.reference, has_proof: foreign.has_proof, can_edit: foreign.can_edit },
        { foreign: true, recorded_via: 'admin', amount: 20, people: 1, reference: null, has_proof: false, can_edit: false });
    assert.deepStrictEqual(foreign.allocations.map((a: any) => a.inscription_id), [w.a2], 'never the other location\'s part');
    assert.ok(!JSON.stringify(view).includes('SEDE-1'));
    fail(await portalA('get', `/portal/fee-payments/${adminT.id}/proof`), 404);
    fail(await portalA('put', `/portal/fee-payments/${adminT.id}`, { expected: { status: 'validated', alloc_gen: 1 }, amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 20 }] }), 404);
    // Returned first under «Requiere tu atención».
    const ret = ok(await portalA('post', '/portal/fee-payments', { amount: 5, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 5 }] }));
    const rett = ok(await p.call('get', `/fee-payments/${ret.id}`));
    ok(await p.call('post', `/fee-payments/${ret.id}/return`, { body: { note: 'x', expected: expectOf(rett) } }));
    const first = ok(await portalA('get', '/portal/fee-payments')).transfers[0];
    assert.strictEqual(first.id, ret.id);
});

test('/portal/payments/bulk (older core portals): ONE payment of N equal parts, the receipt once, all or nothing', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const res = ok(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a1, w.a2, w.a2], amount_per_person: 50, method: 'Transferencia', reference: 'OLD-1', proof: PROOF }));
    assert.deepStrictEqual({ applied: res.applied, skipped: res.skipped }, { applied: 2, skipped: 0 });
    const t = p.one(`SELECT * FROM ${TR} WHERE id = ?`, res.id);
    assert.deepStrictEqual([t.amount, t.status, t.recorded_via, t.proof], [100, 'pending', 'portal', PROOF]);
    assert.deepStrictEqual(parts(p, res.id).map(x => [x.inscription_id, x.amount, x.proof]), [[w.a1, 50, null], [w.a2, 50, null]]);
    // A foreign id refuses the whole request (no silent «skipped» any more).
    const n = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a3, w.b1], amount_per_person: 10, method: 'Efectivo', proof: PROOF }), 400, 'unknown_people');
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a3], amount_per_person: 10, method: 'Bitcoin', proof: PROOF }), 400);
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a1], amount_per_person: 60, method: 'Efectivo', proof: PROOF }), 409, 'over_cap');
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: Array.from({ length: 201 }, (_, i) => i + 1), amount_per_person: 1, method: 'Efectivo' }), 400);
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [], amount_per_person: 1, method: 'Efectivo' }), 400);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, n);
});

// ── pre-2.18 data and routes ─────────────────────────────────────────────────────────────────────────

/** Rows exactly as 2.17 wrote them: one payments row per person, receipt on the row, no header. */
function legacyRows(p: P, w: W) {
    const ins = (iid: number, amount: number, status: string, date: string, proof: string | null, method = 'Transferencia') => {
        const r = p.exec(`INSERT INTO ${PAY} (inscription_id, amount, date, method, reference, proof, status, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            iid, amount, date, method, `REF-${iid}-${amount}`, proof, status, status === 'pending' ? null : '2026-08-01 10:00:00', status === 'pending' ? null : 'old-admin');
        return Number(r.lastInsertRowid);
    };
    return {
        validated: ins(w.a1, 60, 'validated', '2026-08-01 09:00:00', PROOF),
        pending: ins(w.a2, 40, 'pending', '2026-08-02 09:00:00', PROOF2),
        rejected: ins(w.a3, 25, 'rejected', '2026-08-03 09:00:00', PROOF),
        // An old group payment: two rows of the same bulk (same reference / proof).
        bulk1: ins(w.b1, 10, 'validated', '2026-08-04 09:00:00', PROOF, 'Efectivo'),
        bulk2: ins(w.a3, 10, 'validated', '2026-08-04 09:00:00', PROOF, 'Efectivo'),
    };
}

test('wrap migration (D-P13): every old payment becomes a 1-part payment, amounts and ledger kept, receipt through the pointer, idempotent', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const ids = legacyRows(p, w);
    // The state 2.17 left: recomputed on the old rule (validated rows only).
    await p.reboot();
    const paidBefore = [w.a1, w.a2, w.a3, w.b1].map(id => row(p, id));
    assert.deepStrictEqual(paidBefore.map(r => r.amount_paid), [60, 0, 10, 10]);
    const headers = p.q(`SELECT * FROM ${TR} WHERE recorded_via = 'legacy' ORDER BY legacy_payment_id`);
    assert.strictEqual(headers.length, 5, 'one header per old row (the old group payment is NOT regrouped)');
    for (const h of headers as any[]) {
        const part = p.one(`SELECT * FROM ${PAY} WHERE id = ?`, h.legacy_payment_id);
        assert.strictEqual(part.transfer_id, h.id);
        assert.strictEqual(part.alloc_gen, 1);
        assert.strictEqual(h.amount, part.amount);
        assert.strictEqual(h.status, part.status);
        assert.strictEqual(h.proof, null, 'the receipt is NOT copied');
        assert.strictEqual(h.paid_on, part.date);
        assert.strictEqual(h.reference, part.reference);
    }
    const vh = (headers as any[]).find(h => h.legacy_payment_id === ids.validated);
    assert.deepStrictEqual([vh.reviewed_at, vh.reviewed_by], ['2026-08-01 10:00:00', 'old-admin']);
    // Served through the pointer.
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${vh.id}/proof`)).proof, PROOF);
    const ph = (headers as any[]).find(h => h.legacy_payment_id === ids.pending);
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${ph.id}`)).has_proof, true);
    // The ledger is unchanged: same amounts, same dates, same totals.
    const led = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    const fee = led.entries.filter((e: any) => e.source === 'inscription');
    assert.deepStrictEqual(fee.map((e: any) => [e.amount, String(e.date).slice(0, 10), e.description, e.inscription_id]).sort(),
        [[10, '2026-08-04', 'Pago de inscripción', w.a3], [10, '2026-08-04', 'Pago de inscripción', w.b1], [60, '2026-08-01', 'Pago de inscripción', w.a1]].sort());
    assert.strictEqual(led.totals.income, 80);
    // The pending one is in the review queue; the admin list shows all five as legacy.
    const list = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.deepStrictEqual(list.counts, { pending: 1, validated: 3, returned: 0, rejected: 1, total: 5 });
    assert.ok(list.transfers.every((t: any) => t.legacy === true && t.recorded_via === 'legacy'));
    // Twice more: nothing changes.
    const snapshot = JSON.stringify([p.q(`SELECT * FROM ${TR} ORDER BY id`), p.q(`SELECT * FROM ${PAY} ORDER BY id`)]);
    await p.reboot();
    await p.reboot();
    assert.strictEqual(JSON.stringify([p.q(`SELECT * FROM ${TR} ORDER BY id`), p.q(`SELECT * FROM ${PAY} ORDER BY id`)]), snapshot);
    assert.deepStrictEqual([w.a1, w.a2, w.a3, w.b1].map(id => row(p, id)), paidBefore);
    assert.deepStrictEqual(p.logs.filter((l: any) => l[0] !== 'log' && /fee payments|payment/i.test(l[1])), [], 'no boot logged a failure');
    // Validating the old pending one works like any payment; editing it keeps its receipt.
    const pend = ok(await p.call('get', `/fee-payments/${ph.id}`));
    ok(await p.call('put', `/fee-payments/${ph.id}`, { body: { expected: expectOf(pend), amount: 40, method: 'Transferencia', reference: pend.reference, allocations: [{ inscription_id: w.a2, amount: 40 }] } }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${ph.id}/proof`)).proof, PROOF2, 'the receipt moved onto the header before its old row went');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE id = ?`, ids.pending).n, 0);
});

test('wrap: an unknown legacy status is wrapped as rejected (it counted nowhere), rows of a deleted person are left alone', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`INSERT INTO ${PAY} (inscription_id, amount, method, status) VALUES (?, 15, 'Efectivo', 'weird')`, w.a1);
    p.exec(`INSERT INTO ${PAY} (inscription_id, amount, method, status) VALUES (?, 15, 'Efectivo', NULL)`, w.a1);
    await p.reboot();
    assert.deepStrictEqual(p.q(`SELECT status FROM ${TR} WHERE recorded_via = 'legacy' ORDER BY id`).map((r: any) => r.status), ['rejected', 'rejected']);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}`)).pending_amount, 0);
    // A row whose person is gone (left by a driver with foreign keys off) is not wrapped and counts nowhere.
    p.raw.pragma('foreign_keys = OFF');
    const orphan = Number(p.exec(`INSERT INTO ${PAY} (inscription_id, amount, method, status) VALUES (987654, 9, 'Efectivo', 'validated')`).lastInsertRowid);
    p.raw.pragma('foreign_keys = ON');
    await p.reboot();
    assert.strictEqual(p.one(`SELECT transfer_id FROM ${PAY} WHERE id = ?`, orphan).transfer_id, null);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE legacy_payment_id = ?`, orphan).n, 0);
    assert.strictEqual(ok(await p.call('get', `/accounting?conference_id=${w.cid}`)).totals.income, 0);
});

test('pre-2.18 routes: POST /inscriptions/:id/payments, /payments/:id/validate|reject, DELETE /payments/:id, GET /inscriptions/:id/payments', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // A 1-person payment, left pending as before; the receipt optional for cash.
    const created = ok(await p.call('post', `/inscriptions/${w.a1}/payments`, { body: { amount: 30, method: 'Efectivo', reference: 'caja' } }));
    assert.ok(created.transfer_id);
    let list = ok(await p.call('get', `/inscriptions/${w.a1}/payments`));
    assert.strictEqual(list.length, 1);
    const part = list[0];
    assert.deepStrictEqual({ amount: part.amount, status: part.status, method: part.method, people: part.transfer.people, has_proof: part.has_proof }, { amount: 30, status: 'pending', method: 'Efectivo', people: 1, has_proof: false });
    assert.ok(!('proof' in part));
    fail(await p.call('post', `/inscriptions/${w.a1}/payments`, { body: { amount: 30, method: 'Transferencia' } }), 400, 'proof_required');
    fail(await p.call('post', `/inscriptions/${w.a1}/payments`, { body: { amount: 71, method: 'Efectivo' } }), 409, 'over_cap', '30 pending + 71 > 100');
    fail(await p.call('post', '/inscriptions/999999/payments', { body: { amount: 1, method: 'Efectivo' } }), 404);
    // By its part id.
    assert.strictEqual(ok(await p.call('post', `/payments/${part.id}/validate`)).status, 'validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 30, payment_status: 'partial' });
    fail(await p.call('post', `/payments/${part.id}/validate`), 409);
    fail(await p.call('delete', `/payments/${part.id}`), 409, 'validated_delete');
    assert.strictEqual(ok(await p.call('post', `/payments/${part.id}/reject`)).status, 'rejected', 'the old route needs no reason');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
    fail(await p.call('post', `/payments/${part.id}/reject`), 409);
    ok(await p.call('delete', `/payments/${part.id}`));
    assert.deepStrictEqual(ok(await p.call('get', `/inscriptions/${w.a1}/payments`)), []);
    fail(await p.call('post', '/payments/999999/validate'), 404);
    // A shared payment: the old per-row routes refuse it (one receipt = one decision).
    const shared = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 10 }, { inscription_id: w.a3, amount: 10 }] }));
    const sp = ok(await p.call('get', `/inscriptions/${w.a2}/payments`))[0];
    assert.deepStrictEqual([sp.transfer_id, sp.transfer.people, sp.transfer.amount, sp.amount], [shared.id, 2, 20, 10]);
    for (const [m, url] of [['post', `/payments/${sp.id}/validate`], ['post', `/payments/${sp.id}/reject`], ['delete', `/payments/${sp.id}`]] as const) {
        const b = fail(await p.call(m, url), 409, 'shared', url);
        assert.strictEqual(b.people, 2);
    }
    // A legacy row nobody wrapped yet (a boot wrap that failed) is wrapped on demand.
    const raw = Number(p.exec(`INSERT INTO ${PAY} (inscription_id, amount, method, status) VALUES (?, 5, 'Efectivo', 'pending')`, w.b1).lastInsertRowid);
    assert.strictEqual(ok(await p.call('post', `/payments/${raw}/validate`)).status, 'validated');
    assert.ok(p.one(`SELECT transfer_id FROM ${PAY} WHERE id = ?`, raw).transfer_id);
    assert.deepStrictEqual(row(p, w.b1), { amount_paid: 5, payment_status: 'partial' });
});

// ── deletes that touch payments ──────────────────────────────────────────────────────────────────────

test('DELETE /inscriptions: 409 for a person in a shared payment; 1-person payments go with them; DELETE /locations keeps the payments', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const shared = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a2, amount: 10 }] }));
    const b = fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    assert.strictEqual(b.people, 2);
    assert.ok(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), 'not deleted');
    // A rejected shared payment still blocks (its split would no longer add up).
    const sv = ok(await p.call('get', `/fee-payments/${shared.id}`));
    ok(await p.call('post', `/fee-payments/${shared.id}/reject`, { body: { note: 'x', expected: expectOf(sv) } }));
    fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    ok(await p.call('delete', `/fee-payments/${shared.id}`));
    // A 1-person payment is deleted with the person, header first.
    const single = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] }));
    ok(await p.call('delete', `/inscriptions/${w.a1}`));
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, single.id).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE inscription_id = ?`, w.a1).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id = ?`, single.id).n, 0);
    // Deleting a location: its portal's payments keep their people and money.
    const portalB = await portalOf(p, w.B, w.codeB);
    const pb = ok(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] }));
    ok(await p.call('delete', `/locations/${w.B}`));
    assert.strictEqual(p.one(`SELECT location_id FROM ${TR} WHERE id = ?`, pb.id).location_id, null);
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${pb.id}`)).allocations[0].amount, 10);
    // Deleting the conference removes its payments and their history.
    const tids = p.q(`SELECT id FROM ${TR} WHERE conference_id = ?`, w.cid).map((r: any) => r.id);
    assert.ok(tids.length && p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id IN (${tids.join(', ')})`).n > 0);
    ok(await p.call('delete', `/${w.cid}`));
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE conference_id = ?`, w.cid).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id IN (${tids.join(', ')})`).n, 0, 'no orphan history');
});

// ── boot hygiene ─────────────────────────────────────────────────────────────────────────────────────

test('boot hygiene: old drafts, orphan parts, stale generations and headers without parts are removed; mirrors re-written', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const live = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 30 }] }));
    const ins = (sql: string, ...a: any[]) => Number(p.exec(sql, ...a).lastInsertRowid);
    // An old crashed draft with its parts, and a fresh one (in flight elsewhere): only the old one goes.
    const oldDraft = ins(`INSERT INTO ${TR} (conference_id, amount, method, status, alloc_gen, created_at) VALUES (?, 50, 'Efectivo', 'draft', 1, '2020-01-01 00:00:00')`, w.cid);
    ins(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 1, 50, 'Efectivo', 'validated')`, w.a2, oldDraft);
    const newDraft = ins(`INSERT INTO ${TR} (conference_id, amount, method, status, alloc_gen) VALUES (?, 50, 'Efectivo', 'draft', 1)`, w.cid);
    ins(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 1, 50, 'Efectivo', 'pending')`, w.a2, newDraft);
    // An orphan part (its header is gone) and a stale generation of the live payment.
    const orphan = ins(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, 987654, 1, 70, 'Efectivo', 'validated')`, w.a3);
    const stale = ins(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 7, 70, 'Efectivo', 'validated')`, w.a3, live.id);
    // A live header whose parts all vanished, and a wrong mirror.
    const empty = ins(`INSERT INTO ${TR} (conference_id, amount, method, status, alloc_gen) VALUES (?, 5, 'Efectivo', 'pending', 1)`, w.cid);
    p.exec(`UPDATE ${PAY} SET status = 'pending' WHERE transfer_id = ?`, live.id);
    // None of it counts even before the boot cleans it.
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a3}`)).pending_amount, 0);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 30, payment_status: 'partial' });
    await p.reboot();
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, oldDraft).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE transfer_id = ?`, oldDraft).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, newDraft).n, 1, 'a fresh draft may be in flight');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE id IN (?, ?)`, orphan, stale).n, 0);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, empty).n, 0);
    assert.deepStrictEqual(parts(p, live.id).map(x => x.status), ['validated'], 'mirror re-written from the header');
    assert.deepStrictEqual([row(p, w.a1), row(p, w.a2), row(p, w.a3)], [{ amount_paid: 30, payment_status: 'partial' }, { amount_paid: 0, payment_status: 'unpaid' }, { amount_paid: 0, payment_status: 'unpaid' }]);
    assert.deepStrictEqual(p.logs.filter((l: any) => l[0] !== 'log' && /fee payments|payment/i.test(l[1])), [], 'no migration or hygiene failure logged');
});

// ── permissions (D-P20) ──────────────────────────────────────────────────────────────────────────────

test('permissions: payments:view looks, payments:manage registers and reviews; inscriptions alone has no door to them', async () => {
    const mk = (id: number, login: string): HarnessUser => ({ id, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: login, userEmail: `${login}@example.test` });
    const viewer = mk(51, 'ver'), manager = mk(52, 'caja'), insc = mk(53, 'recepcion');
    const p = await bootPlugin({ users: [viewer, manager, insc] });
    const w = await world(p);
    const role = async (name: string, permissions: any) => ok(await p.call('post', '/staff/roles', { body: { name, permissions } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: viewer.id, role_id: await role('Pagos ver', { payments: 'view' }) } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: manager.id, role_id: await role('Pagos gestionar', { payments: 'manage' }) } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: insc.id, role_id: await role('Inscripciones', { inscriptions: 'manage' }) } }));
    const body = { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] };
    // Look
    ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { user: viewer }));
    fail(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { user: insc }), 403);
    fail(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { anonymous: true }), 401);
    // Register
    fail(await pay(p, body, viewer), 403);
    fail(await pay(p, body, insc), 403);
    const t = ok(await pay(p, body, manager)).transfer;
    assert.deepStrictEqual([t.recorded_by, t.status], ['caja', 'pending']);
    // Review
    fail(await p.call('post', `/fee-payments/${t.id}/validate`, { user: viewer, body: { expected: expectOf(t) } }), 403);
    ok(await p.call('post', `/fee-payments/${t.id}/validate`, { user: manager, body: { expected: expectOf(t) } }));
    const v = ok(await p.call('get', `/fee-payments/${t.id}`, { user: viewer }));
    assert.strictEqual(v.reviewed_by, 'caja');
    fail(await p.call('get', `/fee-payments/${t.id}`, { user: insc }), 403);
    fail(await p.call('get', `/fee-payments/${t.id}/proof`, { user: insc }), 403);
    fail(await p.call('delete', `/fee-payments/${t.id}`, { user: viewer }), 403);
    // inscriptions:manage alone cannot delete a person who has payments (needs payments:manage), as before.
    fail(await p.call('delete', `/inscriptions/${w.a1}`, { user: insc }), 409);
    // The person's parts: payments:view | inscriptions:view (no receipt either way); with_proof only for payments.
    ok(await p.call('get', `/inscriptions/${w.a1}/payments`, { user: insc }));
    assert.ok(!('proof' in ok(await p.call('get', `/inscriptions/${w.a1}/payments?with_proof=1`, { user: insc }))[0]));
});

// ── source guard: ONE definition of the effective status ──────────────────────────────────────────────

test('source guard: no SQL reads a payment part\'s status except through EFFECTIVE (index.js and server/*.js)', () => {
    const files = ['index.js', 'server/fee-payments.js'].map(f => [f, fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8')] as const);
    const offenders: string[] = [];
    for (const [file, src] of files) {
        // Every template literal that names the payments table (T.payments / ${T.payments} / PARTS()).
        const literals = src.match(/`[^`]*`/g) || [];
        // (index.js reaches the payments table only through T.payments / fees.* helpers.)
        for (const lit of literals) {
            if (!/\$\{T\.payments\}|\$\{PARTS\(/.test(lit)) continue;
            // Allowed: EFFECTIVE(...) (its body is the one definition), the mirror write `SET status = ?`, the
            // header's own status (t./x./xt. aliases of payment_transfers), an inscription's (i./qi.).
            const cleaned = lit
                .replace(/\$\{EFFECTIVE\([^)]*\)\}/g, 'EFF')
                .replace(/\$\{fees\.EFFECTIVE\([^)]*\)\}/g, 'EFF')
                .replace(/SET status = \?/g, '')
                .replace(/SET status = \(SELECT x\.status/g, '')
                .replace(/\b(?:t|x|xt|i|qi)\.status\b/g, '')
                .replace(/\$\{T\.payments\}\.status/g, '')
                .replace(/\$\{T\.transfers\}\.status/g, '');
            if (/\bstatus\s*(?:=|<>|!=|\bIN\b)/i.test(cleaned) || /\b(?:p|xp|q|lp)\.status\b/.test(cleaned)) offenders.push(`${file}: ${lit.slice(0, 160)}`);
        }
    }
    assert.deepStrictEqual(offenders, []);
    // And the definition itself is the expected one.
    const fp = files[1][1];
    assert.ok(fp.includes("`(CASE WHEN ${p}.transfer_id IS NULL THEN ${p}.status WHEN ${p}.alloc_gen = ${t}.alloc_gen THEN ${t}.status ELSE NULL END)`"));
});

// ── dates ─────────────────────────────────────────────────────────────────────────────────────────────

test('payment dates read back as the same day on every engine: Postgres TIMESTAMP Dates are read in local time, not UTC', () => {
    const { createFeePayments } = require(path.join(PLUGIN_DIR, 'server', 'fee-payments.js'));
    const f = createFeePayments({ db: {}, T: {}, P: '', toCents: split.toCents, fromCents: split.fromCents, httpError: (s: number, m: string) => Object.assign(new Error(m), { status: s }) });
    const tz = process.env.TZ;
    try {
        for (const zone of ['America/Bogota', 'Asia/Tokyo', 'UTC']) {
            process.env.TZ = zone;
            // What pg builds for a TIMESTAMP '2026-10-07 HH:MM:00' (server-local), and its JSON form.
            for (const [h, m] of [[0, 30], [23, 30]]) {
                const local = new Date(2026, 9, 7, h, m);
                assert.strictEqual(f.dayOut(local), '2026-10-07', `${zone} Date ${h}:${m}`);
                assert.strictEqual(f.dayOut(local.toISOString()), '2026-10-07', `${zone} ISO ${h}:${m}`);
            }
            // SQLite / MySQL text, as stored.
            assert.strictEqual(f.dayOut('2026-10-07 23:59:59'), '2026-10-07');
            assert.strictEqual(f.dayOut('2026-10-07'), '2026-10-07');
            assert.strictEqual(f.dayOut(null), null);
        }
    } finally {
        if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
});

// ── several nodes (documentation/multi-node.md: each node forks its own plugin process) ───────────────
//
// `bootPlugin({ raw: p.raw })` is a second node on the same database: its own module, its own in-memory
// lock. `p.onSql` pauses a request at an exact statement, so the interleavings below are deterministic.

/** Pause THIS node at the first statement matching `re`, run `meanwhile` to the end, then go on. */
function pauseAt(p: P, re: RegExp, meanwhile: () => Promise<any>) {
    let armed = true;
    const done: { value?: any } = {};
    p.onSql(async (sql) => {
        if (!armed || !re.test(sql)) return;
        armed = false;
        done.value = await meanwhile();
    });
    return done;
}
const live = (p: P, transferId: number) => p.q(`SELECT p.inscription_id, p.amount FROM ${PAY} p JOIN ${TR} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen WHERE t.id = ? ORDER BY p.id`, transferId) as any[];

test('several nodes: two validations racing for the same person never both stand (never more than what is owed)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // Ana owes 100. P1 (100) was returned — returned money does not count when recording — so P2 (100)
    // could be recorded too. Two admins validate P1 and P2 at the same moment, on two nodes.
    const p1 = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${p1.id}/return`, { body: { note: 'Revisa la fecha', expected: expectOf(p1) } }));
    const p2 = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
    const p1r = ok(await p.call('get', `/fee-payments/${p1.id}`));
    const nodeB = await bootPlugin({ raw: p.raw });
    // Node A checks P1 (nothing validated yet), and stops right before its write; node B validates P2 whole.
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET status = /, () => nodeB.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2) } }));
    const a = await p.call('post', `/fee-payments/${p1.id}/validate`, { body: { expected: expectOf(p1r) } });
    p.onSql(null);
    assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
    const refused = fail(a, 409, 'over_cap', 'the second validation backs off');
    assert.deepStrictEqual(refused.people.map((x: any) => x.inscription_id), [w.a1]);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 100, payment_status: 'paid' });
    assert.deepStrictEqual(p.q(`SELECT id, status FROM ${TR} WHERE id IN (?, ?) ORDER BY id`, p1.id, p2.id).map((r: any) => r.status), ['returned', 'validated']);
    const again = ok(await p.call('get', `/fee-payments/${p1.id}`));
    assert.strictEqual(again.review_note, 'Revisa la fecha', 'the undone validation left the return note as it was');
});

test('several nodes: two payments recorded at once for the same person — the one that would overpay backs off', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    const portalA = await portalOf(p, w.A, w.codeA);
    const portalAonB = await portalOf(nodeB, w.A, w.codeA);
    // Two phones of location A each record Ana's whole fee (100) through two nodes.
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET status = 'pending'/, () => portalAonB('post', '/portal/fee-payments', { amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }] }));
    const a = await portalA('post', '/portal/fee-payments', { amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }] });
    p.onSql(null);
    assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
    fail(a, 409, 'over_cap');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE status <> 'draft'`).n, 1, 'one payment stands; the other was removed');
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}`)).pending_amount, 100);
    // An edit racing a new payment: the edit is undone (the old split and amount come back).
    const q = ok(await portalA('post', '/portal/fee-payments', { amount: 40, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 40 }] }));
    const qt = ok(await p.call('get', `/fee-payments/${q.id}`));
    const nb = pauseAt(p, /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/, () => portalAonB('post', '/portal/fee-payments', { amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 60 }] }));
    const e = await portalA('put', `/portal/fee-payments/${q.id}`, { expected: expectOf(qt), amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 100 }] });
    p.onSql(null);
    assert.strictEqual(nb.value.status, 200, JSON.stringify(nb.value.body));
    fail(e, 409, 'over_cap');
    // The old split and amount come back — as a FRESH generation (restoreSplit: the old one may be gone, R4-L3).
    const back = ok(await p.call('get', `/fee-payments/${q.id}`));
    assert.deepStrictEqual([back.status, back.amount, back.allocations.map((x: any) => x.amount)], ['pending', 40, [40]]);
    assert.ok(back.alloc_gen > 2, `restored above the edit's generation: ${back.alloc_gen}`);
    assert.deepStrictEqual(live(p, q.id).map(x => x.amount), [40]);
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a2}`)).pending_amount, 100, '40 + 60, never 160');
});

test('several nodes: two edits of the same payment never delete each other\'s parts (generations are unique per attempt)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    const t = ok(await pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 60 }] })).transfer;
    // A coordinator-side correction on node A and the admin's on node B start from the same generation.
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/, () => nodeB.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 30 }, { inscription_id: w.a3, amount: 30 }] } }));
    const a = await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 50 }, { inscription_id: w.a2, amount: 10 }] } });
    p.onSql(null);
    assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
    fail(a, 409, 'stale', 'the slower edit is refused');
    // The payment keeps B's split — it neither vanished nor mixed both.
    assert.deepStrictEqual(live(p, t.id).map(x => [x.inscription_id, x.amount]), [[w.a2, 30], [w.a3, 30]]);
    const now = ok(await p.call('get', `/fee-payments/${t.id}`));
    assert.strictEqual(now.allocated, 60);
    assert.deepStrictEqual(p.q(`SELECT DISTINCT alloc_gen FROM ${PAY} WHERE transfer_id = ?`, t.id).map((r: any) => r.alloc_gen), [now.alloc_gen], 'no leftover generation');
    assert.deepStrictEqual([ok(await p.call('get', `/inscriptions/${w.a1}`)).pending_amount, ok(await p.call('get', `/inscriptions/${w.a2}`)).pending_amount], [0, 30]);
    // A later edit gets a generation above every earlier attempt's.
    const e2 = ok(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(now), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 60 }] } })).transfer;
    assert.ok(e2.alloc_gen > now.alloc_gen);
});

test('several nodes: a node that restarts while another edits a payment leaves that edit\'s new parts alone', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 60 }] })).transfer;
    // Node A inserted its new generation and stops before swapping; node B boots (its hygiene runs) meanwhile.
    pauseAt(p, /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/, () => bootPlugin({ raw: p.raw }));
    ok(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 60 }] } }));
    p.onSql(null);
    assert.deepStrictEqual(live(p, t.id).map(x => [x.inscription_id, x.amount]), [[w.a2, 60]], 'the edit landed whole');
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a2}`)).pending_amount, 60);
    // The hygiene still clears what can never become live: an OLDER generation, and a newer one past the TTL.
    const now = ok(await p.call('get', `/fee-payments/${t.id}`));
    const ins = (gen: number, at: string | null) => Number(p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status, created_at) VALUES (?, ?, ?, 5, 'Efectivo', 'pending', ?)`, w.a3, t.id, gen, at).lastInsertRowid);
    const older = ins(now.alloc_gen - 1, null);
    const crashed = ins(now.alloc_gen + 5, '2020-01-01 00:00:00');
    const inFlight = Number(p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status, created_at) VALUES (?, ?, ?, 5, 'Efectivo', 'pending', CURRENT_TIMESTAMP)`, w.a3, t.id, now.alloc_gen + 9).lastInsertRowid);
    await p.reboot();
    const left = p.q(`SELECT id FROM ${PAY} WHERE id IN (?, ?, ?)`, older, crashed, inFlight).map((r: any) => r.id);
    assert.deepStrictEqual(left, [inFlight]);
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a3}`)).pending_amount, 0, 'an in-flight generation never counts');
});

// ── retries repair a write whose recompute failed ─────────────────────────────────────────────────────

test('a retry repairs amount_paid when the first attempt wrote the payment but its recompute failed', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const failOnce = () => {
        let armed = true;
        p.onSql((sql) => {
            if (armed && /^UPDATE \S+inscriptions\s+SET amount_paid/.test(sql)) { armed = false; throw new Error('Deadlock found when trying to get lock'); }
        });
    };
    // Born-validated cash, retried with the same client_key after a 500.
    failOnce();
    const body = { conference_id: w.cid, amount: 100, method: 'Efectivo', client_key: 'retry-key-0001', allocations: [{ inscription_id: w.a1, amount: 100 }] };
    const first = await pay(p, body);
    assert.strictEqual(first.status, 500);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' }, 'the write landed, its recompute did not');
    const again = ok(await pay(p, body));
    assert.strictEqual(again.replayed, true);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 100, payment_status: 'paid' });
    // A validation retried after a 500: the retry is refused (it already happened) and repairs the row.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 40 }] })).transfer;
    failOnce();
    assert.strictEqual((await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } })).status, 500);
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 0, payment_status: 'unpaid' });
    fail(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } }), 409, 'invalid_transition');
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 40, payment_status: 'partial' });
    p.onSql(null);
});

// ── the pre-2.18 part routes act only on what they inspected ──────────────────────────────────────────

test('pre-2.18 part routes: a payment re-split between their check and their action answers 409 stale', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const COUNT_OF_PART = /^SELECT COUNT\(\*\) AS n FROM \S+payments WHERE transfer_id = \? AND alloc_gen = \?/;
    for (const [method, action] of [['post', 'validate'], ['post', 'reject'], ['delete', '']] as const) {
        const r = ok(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 20 }] }));
        const partId = p.one(`SELECT id FROM ${PAY} WHERE transfer_id = ?`, r.id).id;
        const mine = r.view.transfers.find((x: any) => x.id === r.id);
        // The old route has counted ONE person; the coordinator re-splits it across two people meanwhile.
        const resplit = pauseAt(p, COUNT_OF_PART, () => portalA('put', `/portal/fee-payments/${r.id}`, { expected: expectOf(mine), amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a3, amount: 10 }] }));
        const res = await p.call(method, action ? `/payments/${partId}/${action}` : `/payments/${partId}`);
        p.onSql(null);
        assert.strictEqual(resplit.value.status, 200, JSON.stringify(resplit.value.body));
        fail(res, 409, 'stale', `${method} ${action}`);
        const now = ok(await p.call('get', `/fee-payments/${r.id}`));
        assert.deepStrictEqual([now.status, now.people], ['pending', 2], `${action || 'delete'}: the shared split is untouched`);
        ok(await portalA('delete', `/portal/fee-payments/${r.id}`, { expected: expectOf(now) }));
    }
});

// ── /portal/payments/bulk: a repeated reference is accepted (that portal cannot confirm it) ───────────

test('/portal/payments/bulk accepts a repeated transfer reference: an old portal records one transfer in two posts', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    // One bank transfer for a family whose fees differ: the old form takes ONE amount per person.
    const adults = ok(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a1, w.a2], amount_per_person: 100, method: 'Transferencia', reference: 'BANK-77', proof: PROOF }));
    const child = ok(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a3], amount_per_person: 50, method: 'Transferencia', reference: 'BANK-77', proof: PROOF }));
    assert.notStrictEqual(adults.id, child.id);
    // The new API still asks first (it can confirm); the admin queue flags both.
    fail(await pay(p, { conference_id: w.cid, amount: 1, method: 'Transferencia', reference: 'bank-77', proof: PROOF, allocations: [{ inscription_id: w.b1, amount: 1 }] }), 409, 'duplicate_reference');
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.deepStrictEqual(view.transfers.filter((t: any) => t.reference === 'BANK-77').map((t: any) => t.flags.duplicate_reference), [true, true]);
});

// ── receipts: the size in pixels the image declares ─────────────────────────────────────────────────

test('receipt: an image that declares a huge size (a pixel flood) is refused for every writer; real ones pass', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
    const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
    const url = (mime: string, bytes: number[]) => `data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    const png = (wd: number, ht: number) => url('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(wd), ...u32(ht), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...new Array(64).fill(0)]);
    const jpeg = (wd: number, ht: number) => url('jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        0xff, 0xc0, 0, 11, 8, ...u16be(ht), ...u16be(wd), 1, 1, 0x11, 0, 0xff, 0xd9]);
    const gif = (sw: number, sh: number, fw: number, fh: number) => url('gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16le(sw), ...u16le(sh), 0, 0, 0,
        0x2c, 0, 0, 0, 0, ...u16le(fw), ...u16le(fh), 0, 2, 2, 0x4c, 0x01, 0, 0x3b]);
    const webpX = (wd: number, ht: number) => url('webp', [0x52, 0x49, 0x46, 0x46, 30, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0,
        (wd - 1) & 255, ((wd - 1) >> 8) & 255, ((wd - 1) >> 16) & 255, (ht - 1) & 255, ((ht - 1) >> 8) & 255, ((ht - 1) >> 16) & 255, ...new Array(8).fill(0)]);
    const send = (proof: string, n: number) => pay(p, { conference_id: w.cid, amount: 1, method: 'Transferencia', reference: `PX-${n}`, proof, leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 1 }] });
    let n = 0;
    for (const bad of [png(30000, 30000), png(9000, 10), png(5000, 5000), jpeg(30000, 20000), gif(10, 10, 20000, 20000), webpX(16000, 16000)]) {
        const b = fail(await send(bad, ++n), 400, undefined, `refused #${n}`);
        assert.match(b.error, /demasiado grande/);
    }
    for (const broken of ['data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgK']) {
        assert.match(fail(await send(broken, ++n), 400).error, /no es una imagen válida/);
    }
    for (const fine of [PROOF, PROOF2, png(1600, 1200), jpeg(4032, 3024), gif(800, 600, 800, 600), webpX(1600, 1200)]) {
        const r = ok(await send(fine, ++n), `accepted #${n}`);
        ok(await p.call('delete', `/fee-payments/${r.id}`));
    }
    // The same rule for the portal and the pre-2.18 routes (one place: assertProof).
    const portalA = await portalOf(p, w.A, w.codeA);
    fail(await portalA('post', '/portal/fee-payments', { amount: 1, method: 'Transferencia', reference: 'PX-P', proof: png(30000, 30000), allocations: [{ inscription_id: w.a1, amount: 1 }] }), 400);
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a1], amount_per_person: 1, method: 'Transferencia', reference: 'PX-B', proof: png(30000, 30000) }), 400);
    fail(await p.call('post', `/inscriptions/${w.a1}/payments`, { body: { amount: 1, method: 'Transferencia', proof: png(30000, 30000) } }), 400);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE status <> 'draft'`).n, 0);
});

// ── a portal payment stays its location's (D-P3) ──────────────────────────────────────────────────────

test('the admin correcting a coordinator\'s payment cannot add another location\'s people (a moved person may stay)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 40, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 20 }, { inscription_id: w.a2, amount: 20 }] }));
    const t = ok(await p.call('get', `/fee-payments/${r.id}`));
    const refused = fail(await p.call('put', `/fee-payments/${r.id}`, { body: { expected: expectOf(t), amount: 40, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 20 }, { inscription_id: w.b1, amount: 20 }] } }), 400, 'unknown_people');
    assert.deepStrictEqual(refused.ids, [w.b1]);
    assert.match(refused.error, /solo puede incluir a sus personas/);
    // Luis moved to Cali after the payment was recorded: correcting the split may keep him.
    ok(await p.call('put', `/inscriptions/${w.a2}`, { body: { location_id: w.B } }));
    const kept = ok(await p.call('put', `/fee-payments/${r.id}`, { body: { expected: expectOf(t), amount: 40, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 25 }, { inscription_id: w.a2, amount: 15 }] } })).transfer;
    assert.deepStrictEqual(kept.allocations.map((a: any) => a.inscription_id), [w.a1, w.a2]);
    assert.strictEqual(kept.location_id, w.A, 'still the coordinator\'s payment');
    // The admin's own payments may still mix locations (D-P3).
    ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a3, amount: 10 }, { inscription_id: w.b1, amount: 10 }] }));
});

// ── the «Resumen» is the same figure everywhere (Validado + Por validar + Por cobrar = Cuotas) ───────

test('«Resumen»: a cancelled person\'s money counts as «A favor», never in Validado / Por validar; admin = portal', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // Mateo (a3) paid 100 and was cancelled; Ana (a1) has 60 awaiting validation and then is cancelled too.
    ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 100 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 60, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 60 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 30 }] }));
    for (const id of [w.a3, w.a1]) ok(await p.call('put', `/inscriptions/${id}`, { body: { status: 'cancelled' } }));
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    const byA = view.by_location.find((x: any) => x.location_id === w.A);
    // A: a2 is the only active person (fee 100, 30 validated). Cancelled: a1 (60 pending), a3 (100 validated), cx.
    assert.deepStrictEqual({ due: byA.due, validated: byA.validated, pending: byA.pending, to_cover: byA.to_cover, credit: byA.credit, cancelled: byA.cancelled },
        { due: 100, validated: 30, pending: 0, to_cover: 70, credit: 100, cancelled: 3 });
    for (const s of [view.summary, ...view.by_location]) assert.strictEqual(Math.round((s.validated + s.pending + s.to_cover) * 100), Math.round(s.due * 100), JSON.stringify(s));
    const portal = ok(await (await portalOf(p, w.A, w.codeA))('get', '/portal/fee-payments'));
    assert.deepStrictEqual(portal.summary, { people: byA.people, cancelled: byA.cancelled, due: byA.due, validated: byA.validated, pending: byA.pending, returned: byA.returned, to_cover: byA.to_cover, credit: byA.credit });
});

// ── a failed fee migration never locks anyone out ────────────────────────────────────────────────────

test('a failed fee migration: login and the portal keep working, no «Pagos de cuotas» flag, fee routes 503, a later attempt recovers', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // A database as 2.17 left it (a validated payment row, no payment headers), and the first 2.18 boot's
    // fee migration fails (the headers' table cannot be created: a lock wait timeout).
    p.exec(`INSERT INTO ${PAY} (inscription_id, amount, date, method, status) VALUES (?, 30, '2026-08-01 09:00:00', 'Efectivo', 'validated')`, w.a1);
    p.exec(`DROP TABLE ${EV}`);
    p.exec(`DROP TABLE ${TR}`);
    p.onSql((sql) => { if (sql === `CREATE TABLE ${TR}`) throw new Error('lock wait timeout exceeded'); });
    await p.reboot();
    assert.ok(p.logs.some((l: any) => /fee payments migration failed/.test(l[1])));
    const login = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.A, code: w.codeA } }), 'login still works');
    assert.ok(!('features' in login.location), 'no «Pagos de cuotas» flag: the portal keeps its older flow');
    const portalA = await portalOf(p, w.A, w.codeA);
    assert.ok(!('features' in ok(await portalA('get', '/portal/me'))));
    assert.strictEqual(ok(await portalA('get', '/portal/inscriptions')).find((x: any) => x.id === w.a1).pending_amount, 0);
    // The roster, the person's payments and the ledger read the rows' own (mirrored) status.
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}`)).amount_paid, 30);
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}/payments`))[0].status, 'validated');
    assert.strictEqual(ok(await p.call('get', `/accounting?conference_id=${w.cid}`)).totals.income, 30);
    ok(await p.call('get', `/reports/summary?conference_id=${w.cid}`));
    // Fee routes: 503 with a reason, never a 500.
    fail(await p.call('get', `/fee-payments?conference_id=${w.cid}`), 503, 'unavailable');
    fail(await portalA('get', '/portal/fee-payments'), 503, 'unavailable');
    fail(await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a2], amount_per_person: 10, method: 'Efectivo' }), 503, 'unavailable');
    // The cause goes away: the next fee request migrates and everything is back.
    p.onSql(null);
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.strictEqual(view.summary.validated, 30);
    assert.deepStrictEqual(ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.A, code: w.codeA } })).location.features, { fee_payments: 1 });
});

// ── round 3: findings of the live lab and the review ────────────────────────────────────────────────────

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** A PNG data URL whose IHDR declares `wd` × `ht` pixels (a few bytes: a «pixel flood» when huge). */
const pngOf = (wd: number, ht: number) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...u32be(wd), ...u32be(ht), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...new Array(64).fill(0)]).toString('base64')}`;

test('«Devolver» only goes to someone who can correct it: never a pre-2.18 payment nor one of a deleted location', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // A 2.17 install: a cash payment of 30 for Ana still awaiting validation, wrapped as `legacy` at boot.
    p.exec(`INSERT INTO ${PAY} (inscription_id, amount, date, method, status) VALUES (?, 30, '2026-08-02 09:00:00', 'Efectivo', 'pending')`, w.a1);
    await p.reboot();
    const legacy = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`)).transfers.find((t: any) => t.legacy);
    assert.strictEqual(legacy.status, 'pending');
    const refused = fail(await p.call('post', `/fee-payments/${legacy.id}/return`, { body: { note: 'Comprobante ilegible', expected: expectOf(legacy) } }), 409, 'no_recorder');
    assert.match(refused.error, /edítalo tú o recházalo/);
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${legacy.id}`)).status, 'pending', 'still in the queue');
    // Edit, validate and reject stay available for it.
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${legacy.id}/reject`, { body: { note: 'No llegó', expected: expectOf(legacy) } })).status, 'rejected');
    // A portal payment whose location was deleted: nobody sees it as their own any more.
    const portalB = await portalOf(p, w.B, w.codeB);
    const pb = ok(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] }));
    ok(await p.call('delete', `/locations/${w.B}`));
    const orphan = ok(await p.call('get', `/fee-payments/${pb.id}`));
    fail(await p.call('post', `/fee-payments/${pb.id}/return`, { body: { note: 'x', expected: expectOf(orphan) } }), 409, 'no_recorder');
    // A coordinator's payment and the administration's own «Dejar por validar» one can be returned.
    const portalA = await portalOf(p, w.A, w.codeA);
    const pa = ok(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] }));
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${pa.id}/return`, { body: { note: 'x', expected: expectOf(ok(await p.call('get', `/fee-payments/${pa.id}`))) } })).status, 'returned');
    const ad = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a3, amount: 10 }] })).transfer;
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${ad.id}/return`, { body: { note: 'x', expected: expectOf(ad) } })).status, 'returned');
});

test('a recovered fee migration: the roster reads the EFFECTIVE status, and a retry re-writes a mirror its first attempt missed', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`DROP TABLE ${EV}`);
    p.exec(`DROP TABLE ${TR}`);
    p.onSql((sql) => { if (sql === `CREATE TABLE ${TR}`) throw new Error('lock wait timeout exceeded'); });
    await p.reboot();
    p.onSql(null);
    ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`), 'the next fee request migrates');
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 40 }] })).transfer;
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}`)).pending_amount, 40);
    // Validated while the part's mirror write fails: the header is validated, the mirror still says pending.
    p.onSql((sql) => { if (/^UPDATE \S+payments SET status = \(SELECT x\.status FROM \S+payment_transfers x WHERE x\.id = \? AND x\.alloc_gen = \?/.test(sql)) throw new Error('Deadlock found when trying to get lock'); });
    assert.strictEqual((await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } })).status, 500);
    p.onSql(null);
    assert.strictEqual(parts(p, t.id)[0].status, 'pending', 'the mirror was not written');
    // Every reader follows the header — the roster too, although it was first built while the schema was missing.
    const one = ok(await p.call('get', `/inscriptions/${w.a1}`));
    assert.deepStrictEqual([one.amount_paid, one.pending_amount], [40, 0]);
    assert.strictEqual((await roster(p, w.cid)).get(w.a1).pending_amount, 0);
    // The retry is refused (it already happened) and repairs the mirror.
    fail(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } }), 409, 'invalid_transition');
    assert.strictEqual(parts(p, t.id)[0].status, 'validated');
});

test('DELETE /inscriptions in a shared payment: the 409 says what to do for that payment status', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const body = (leave: boolean) => ({ conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: leave, allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a2, amount: 10 }] });
    // Pending: edit the split.
    const pend = ok(await pay(p, body(true))).transfer;
    let b = fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    assert.ok(b.error.includes(`quítala del reparto del pago #${pend.id} («Editar reparto»)`), b.error);
    assert.doesNotMatch(b.error, /anula|elimina el pago/);
    assert.deepStrictEqual(b.transfers, [{ id: pend.id, status: 'pending' }]);
    ok(await p.call('delete', `/fee-payments/${pend.id}`));
    // Validated: it cannot be edited (D-P10) — void it and record it again.
    const val = ok(await pay(p, body(false))).transfer;
    b = fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    assert.ok(b.error.includes(`anula el pago validado #${val.id} y regístralo de nuevo sin ella`), b.error);
    assert.doesNotMatch(b.error, /Editar reparto/);
    // Rejected: it counts nowhere — delete it.
    ok(await p.call('post', `/fee-payments/${val.id}/reject`, { body: { note: 'Anulado', expected: expectOf(val) } }));
    b = fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    assert.ok(b.error.includes(`elimina el pago rechazado #${val.id}`), b.error);
    assert.doesNotMatch(b.error, /Editar reparto|anula/);
    ok(await p.call('delete', `/fee-payments/${val.id}`));
    ok(await p.call('delete', `/inscriptions/${w.a1}`), 'nothing blocks any more');
});

test('«Reportes» uses the Resumen per-person model: cancelled people owe nothing; pending-covered people are not «con saldo»', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // Ana: her whole fee awaiting validation. Luis: 30 validated. Sol: paid 100, then cancelled (credit). Beto
    // (Cali): nothing. Carla: cancelled before paying.
    ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 30 }] }));
    ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 100 }] }));
    ok(await p.call('put', `/inscriptions/${w.a3}`, { body: { status: 'cancelled' } }));
    const s = ok(await p.call('get', `/reports/summary?conference_id=${w.cid}`));
    const pick = (x: any) => ({ due: x.due, paid: x.paid, pending: x.pending, to_cover: x.to_cover, credit: x.credit, paid_count: x.paid_count, partial_count: x.partial_count,
        unpaid_count: x.unpaid_count, owing_count: x.owing_count, cancelled_count: x.cancelled_count, people: x.people });
    assert.deepStrictEqual(pick(s.totals), { due: 300, paid: 30, pending: 100, to_cover: 170, credit: 100, paid_count: 0, partial_count: 1, unpaid_count: 2, owing_count: 2, cancelled_count: 2, people: 3 });
    assert.strictEqual(s.totals.total, 5, '«Inscritos» still counts every inscription');
    assert.strictEqual(Math.round((s.totals.due - s.totals.paid) * 100), Math.round((s.totals.pending + s.totals.to_cover) * 100), '«Saldo pendiente» = Por validar + Por cobrar');
    const bog = s.byLocation.find((x: any) => x.location === 'Bogotá');
    assert.deepStrictEqual(pick(bog), { due: 200, paid: 30, pending: 100, to_cover: 70, credit: 100, paid_count: 0, partial_count: 1, unpaid_count: 1, owing_count: 1, cancelled_count: 2, people: 2 });
    assert.strictEqual(bog.count, 4);
    // The same figures as «Pagos de cuotas» › Resumen (admin) — one model.
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.deepStrictEqual([s.totals.due, s.totals.paid, s.totals.pending, s.totals.to_cover, s.totals.credit],
        [view.summary.due, view.summary.validated, view.summary.pending, view.summary.to_cover, view.summary.credit]);
    assert.strictEqual(s.totals.owing_count, view.people.filter((x: any) => x.payable).length, '«Con saldo» = the payable people of «Saldos»');
});

test('validating money for a cancelled inscription is refused (it owes nothing, D-P9 / D-P19) — new and pre-2.18 routes', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    // The coordinator records 100 cash for Sol (active); the admin cancels Sol before validating it.
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 100 }] }));
    ok(await p.call('put', `/inscriptions/${w.a3}`, { body: { status: 'cancelled' } }));
    const t = ok(await p.call('get', `/fee-payments/${r.id}`));
    const v = fail(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(t) } }), 409, 'cancelled_people');
    assert.deepStrictEqual(v.ids, [w.a3]);
    assert.match(v.error, /corrige el reparto, reactívala o rechaza el pago/);
    assert.deepStrictEqual(row(p, w.a3), { amount_paid: 0, payment_status: 'unpaid' });
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${r.id}`)).status, 'pending');
    // The pre-2.18 route by part id: the same rule.
    const partId = p.one(`SELECT id FROM ${PAY} WHERE transfer_id = ?`, r.id).id;
    fail(await p.call('post', `/payments/${partId}/validate`), 409, 'cancelled_people');
    // A rejected payment of a person cancelled since: cannot be validated back either.
    ok(await p.call('post', `/fee-payments/${r.id}/reject`, { body: { note: 'Cancelada', expected: expectOf(t) } }));
    const rj = ok(await p.call('get', `/fee-payments/${r.id}`));
    fail(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(rj) } }), 409, 'cancelled_people');
    // Reactivated: it validates.
    ok(await p.call('put', `/inscriptions/${w.a3}`, { body: { status: 'active' } }));
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${r.id}/validate`, { body: { expected: expectOf(rj) } })).status, 'validated');
    assert.deepStrictEqual(row(p, w.a3), { amount_paid: 100, payment_status: 'paid' });
    // A shared payment with one cancelled person: refused whole (all or nothing), nothing validated.
    const sh = ok(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a2, amount: 10 }] }));
    ok(await p.call('put', `/inscriptions/${w.a2}`, { body: { status: 'cancelled' } }));
    const st = ok(await p.call('get', `/fee-payments/${sh.id}`));
    assert.deepStrictEqual(fail(await p.call('post', `/fee-payments/${sh.id}/validate`, { body: { expected: expectOf(st) } }), 409, 'cancelled_people').ids, [w.a2]);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
});

test('a pre-2.18 receipt that fails the pixel rule is never served, copied («Duplicar») or moved onto a payment', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const bomb = pngOf(30000, 30000);
    const ins = (iid: number, method: string, proof: string, status = 'pending') => Number(p.exec(`INSERT INTO ${PAY} (inscription_id, amount, date, method, reference, proof, status)`
        + ` VALUES (?, 10, '2026-08-02 09:00:00', ?, ?, ?, ?)`, iid, method, `OLD-${iid}`, proof, status).lastInsertRowid);
    const bad = ins(w.a1, 'Transferencia', bomb);
    const good = ins(w.a2, 'Transferencia', PROOF);
    const badCash = ins(w.a3, 'Efectivo', bomb, 'rejected');
    await p.reboot();
    const hOf = (legacyId: number) => p.one(`SELECT id FROM ${TR} WHERE legacy_payment_id = ?`, legacyId).id as number;
    // Served: never (422, a reason), while a sane old receipt still is.
    const r = fail(await p.call('get', `/fee-payments/${hOf(bad)}/proof`), 422, 'invalid_proof');
    assert.match(r.error, /no es una imagen válida o es demasiado grande/);
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${hOf(good)}/proof`)).proof, PROOF);
    const listed = ok(await p.call('get', `/inscriptions/${w.a1}/payments?with_proof=1`));
    assert.strictEqual(listed[0].proof, null, 'the person parts with_proof=1 carry no flood either');
    // Copied: «Duplicar» from it is refused, nothing written.
    const n = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    const dup = fail(await pay(p, { conference_id: w.cid, amount: 10, method: 'Transferencia', reference: 'NEW-1', copy_proof_from: hOf(badCash), allocations: [{ inscription_id: w.b1, amount: 10 }] }), 400, 'proof_source');
    assert.match(dup.error, /no es una imagen válida/);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, n);
    // Moved: editing the old transfer keeps no flood — a transfer then needs a new receipt.
    const t = ok(await p.call('get', `/fee-payments/${hOf(bad)}`));
    fail(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 10, method: 'Transferencia', reference: 'OLD', allocations: [{ inscription_id: w.a1, amount: 10 }] } }), 400, 'proof_required');
    ok(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 10, method: 'Transferencia', reference: 'OLD', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 10 }] } }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${t.id}/proof`)).proof, PROOF2);
});

test('admin fee routes check the permission BEFORE the schema: no 503 and no migration attempt for an account without the section', async () => {
    const mk = (id: number, login: string): HarnessUser => ({ id, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: login, userEmail: `${login}@example.test` });
    const insc = mk(61, 'recepcion'), cashier = mk(62, 'caja');
    const p = await bootPlugin({ users: [insc, cashier] });
    const w = await world(p);
    ok(await p.call('post', '/staff/members', { body: { user_id: insc.id, role_id: ok(await p.call('post', '/staff/roles', { body: { name: 'Insc', permissions: { inscriptions: 'manage' } } })).id } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: cashier.id, role_id: ok(await p.call('post', '/staff/roles', { body: { name: 'Caja', permissions: { payments: 'view' } } })).id } }));
    p.exec(`DROP TABLE ${EV}`);
    p.exec(`DROP TABLE ${TR}`);
    let attempts = 0;
    p.onSql((sql) => { if (sql === `CREATE TABLE ${TR}`) { attempts++; throw new Error('lock wait timeout exceeded'); } });
    await p.reboot();
    attempts = 0;
    const calls: [string, string, any][] = [['get', `/fee-payments?conference_id=${w.cid}`, undefined], ['get', '/fee-payments/1', undefined], ['get', '/fee-payments/1/proof', undefined],
        ['post', '/fee-payments', { conference_id: w.cid }], ['put', '/fee-payments/1', {}], ['post', '/fee-payments/1/validate', {}], ['delete', '/fee-payments/1', undefined]];
    for (const [m, url, body] of calls) fail(await p.call(m, url, { user: insc, body }), 403, undefined, `${m} ${url}`);
    assert.strictEqual(attempts, 0, 'no migration attempt for an account without «Pagos»');
    // Pagos › ver: the schema is attempted and the reason given.
    fail(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { user: cashier }), 503, 'unavailable');
    assert.strictEqual(attempts, 1);
    fail(await p.call('post', '/fee-payments', { user: cashier, body: { conference_id: w.cid } }), 403, undefined, 'view cannot write');
    assert.strictEqual(attempts, 1);
    p.onSql(null);
});

test('D-P20: Pagos alone never reads the roster; «Pagos de cuotas» names its people itself — name, location, family group, nothing else', async () => {
    const mk = (id: number, login: string): HarnessUser => ({ id, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: login, userEmail: `${login}@example.test` });
    const cashier = mk(71, 'caja'), clerk = mk(72, 'caja-recepcion');
    const p = await bootPlugin({ users: [cashier, clerk] });
    const w = await world(p);
    // A contact among the form answers and an internal note: the roster has them, «Pagos» must not.
    p.exec(`UPDATE ${INS} SET family_group = 'Pérez', notes = 'nota interna', custom_data = '{"email":"ana@example.test"}' WHERE id = ${w.a1}`);
    const role = async (name: string, permissions: any) => ok(await p.call('post', '/staff/roles', { body: { name, permissions } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: cashier.id, role_id: await role('Caja', { payments: 'manage' }) } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: clerk.id, role_id: await role('Caja y recepción', { payments: 'view', inscriptions: 'view' }) } }));
    // The roster (contacts, form answers, notes) is not «Pagos»: 403 on the list and on one row.
    fail(await p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: cashier }), 403);
    fail(await p.call('get', `/inscriptions/${w.a1}`, { user: cashier }), 403);
    // «Pagos de cuotas» knows who each person is from its own view — and nothing more.
    const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { user: cashier }));
    const ana = view.people.find((x: any) => x.id === w.a1);
    assert.deepStrictEqual(Object.keys(ana).sort(), ['cancelled', 'credit', 'due', 'family_group', 'id', 'location', 'location_id', 'name', 'payable', 'pending', 'reg_code', 'returned', 'status', 'to_cover', 'total_due', 'validated']);
    assert.deepStrictEqual({ name: ana.name, location: ana.location, family_group: ana.family_group, status: ana.status, reg_code: ana.reg_code },
        { name: 'Ana Pérez', location: 'Bogotá', family_group: 'Pérez', status: 'pending', reg_code: null });
    assert.strictEqual(view.people.find((x: any) => x.id === w.cx).status, 'cancelled');
    assert.strictEqual(view.people.find((x: any) => x.id === w.b1).location, 'Cali');
    const text = JSON.stringify(view);
    for (const secret of ['ana@example.test', 'nota interna']) assert.ok(!text.includes(secret), secret);
    // The registration code only for Inscripciones › ver, as everywhere else.
    const code = p.one(`SELECT reg_code FROM ${INS} WHERE id = ?`, w.a1).reg_code;
    const withCodes = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`, { user: clerk }));
    assert.strictEqual(withCodes.people.find((x: any) => x.id === w.a1).reg_code, code);
    ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: clerk }), 'inscriptions:view still reads the roster');
});

// ── round 5: findings of the money / concurrency review ─────────────────────────────────────────────────

test('«Duplicar» copies the receipt of a VOIDED payment only: a pending, validated or returned source is refused (D-P10)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    // A $250 cash receipt, photographed, recorded as an installment of Ana's $500 fee: born validated.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    assert.strictEqual(t.status, 'validated');
    const before = row(p, w.a1);
    assert.deepStrictEqual(before, { amount_paid: 250, payment_status: 'partial' });
    const n = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    // Copying it while it still counts would make one handover count twice (Ana «paid» from $250).
    const live2 = fail(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'proof_source_live');
    assert.match(live2.error, /Anula \(rechaza\) el pago de origen/);
    assert.deepStrictEqual(live2.source, { id: t.id, status: 'validated' });
    assert.deepStrictEqual(row(p, w.a1), before, 'nothing counted');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, n, 'nothing written');
    // Pending and returned sources can still count: refused too — for the admin and for the portal.
    const pend = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', proof: PROOF, leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 10 }] })).transfer;
    fail(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', copy_proof_from: pend.id, allocations: [{ inscription_id: w.a3, amount: 10 }] }), 409, 'proof_source_live');
    ok(await p.call('post', `/fee-payments/${pend.id}/return`, { body: { note: 'Revisa', expected: expectOf(pend) } }));
    fail(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', copy_proof_from: pend.id, allocations: [{ inscription_id: w.a3, amount: 10 }] }), 409, 'proof_source_live');
    const portalA = await portalOf(p, w.A, w.codeA);
    const own = ok(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', proof: PROOF, allocations: [{ inscription_id: w.a3, amount: 10 }] }));
    fail(await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', copy_proof_from: own.id, allocations: [{ inscription_id: w.a2, amount: 10 }] }), 409, 'proof_source_live');
    // An edit never copies from another payment, live or not: a correction keeps the payment's family (R4-M1).
    const ownT = ok(await p.call('get', `/fee-payments/${own.id}`));
    fail(await p.call('put', `/fee-payments/${own.id}`, { body: { expected: expectOf(ownT), amount: 10, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a3, amount: 10 }] } }), 400, 'source_fixed');
    // Voided first, then «Duplicar»: the receipt is re-used and counted once.
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'Se registra de nuevo', expected: expectOf(t) } }));
    const dup = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${dup.id}/proof`)).proof, PROOF2);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
});

test('a crash between the parts and the header flip leaves parts nobody counts — not even degraded mode or an older plugin', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // The admin records $100 for Ana, born validated; the flip of its header fails (a deadlock, a crash).
    p.onSql((sql) => { if (/^UPDATE \S+payment_transfers SET status = 'validated'/.test(sql)) throw new Error('Deadlock found when trying to get lock'); });
    assert.strictEqual((await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }] })).status, 500);
    p.onSql(null);
    const draft = p.one(`SELECT id, status FROM ${TR} WHERE status = 'draft'`);
    assert.ok(draft, 'the draft header is left behind');
    assert.deepStrictEqual(parts(p, draft.id).map(r => r.status), ['draft'], 'its part is no «validated» money');
    // A pending payment whose edit dies after writing its new generation, before the swap.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 40 }] })).transfer;
    p.onSql((sql) => { if (/^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/.test(sql)) throw new Error('Lock wait timeout exceeded'); });
    assert.strictEqual((await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 60 }] } })).status, 500);
    p.onSql(null);
    assert.deepStrictEqual(parts(p, t.id).map(r => [r.alloc_gen, r.amount, r.status]), [[1, 40, 'pending'], [2, 60, 'draft']]);
    // Next boot: the fee migration fails (its schema probe hits a lock timeout) → degraded mode, no hygiene;
    // the one recompute and every reader go by the parts' own status.
    p.onSql((sql) => { if (/^SELECT xp\.id, xp\.transfer_id, xp\.alloc_gen, xp\.created_at/.test(sql)) throw new Error('Lock wait timeout exceeded'); });
    await p.reboot();
    p.onSql(null);
    assert.ok(p.logs.some((l: any) => /fee payments migration failed/.test(l[1])), 'degraded mode');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' }, 'the crashed draft never became income');
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a2}`)).pending_amount, 40, 'one generation awaits validation, not both');
    assert.strictEqual(ok(await p.call('get', `/accounting?conference_id=${w.cid}`)).totals.income, 0);
    // A healthy boot: the fresh draft waits out its TTL, and successful writes still mirror their status.
    await p.reboot();
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE id = ?`, draft.id).n, 1);
    const ok2 = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 30 }] }));
    assert.deepStrictEqual(parts(p, ok2.id).map(r => r.status), ['validated']);
    const e = ok(await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(ok(await p.call('get', `/fee-payments/${t.id}`))), amount: 50, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 50 }] } })).transfer;
    assert.deepStrictEqual(parts(p, t.id).map(r => [r.alloc_gen, r.status]), [[e.alloc_gen, 'pending']]);
});

test('several nodes: an edit that backs off never undoes a validation another node made at the new split', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    // Ana owes 100. A pending payment of 40 for her is corrected to her whole fee on node A.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 40 }] })).transfer;
    // Node A has swapped to the new split and is re-checking; meanwhile node B validates that new split, and a
    // third writer's $10 for Ana lands (so node A's re-check sees her past her fee).
    const b = pauseAt(p, /^SELECT id, status, total_due FROM \S+inscriptions WHERE id IN/, async () => {
        const now = ok(await nodeB.call('get', `/fee-payments/${t.id}`));
        const v = await nodeB.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(now) } });
        const q = Number(p.exec(`INSERT INTO ${TR} (conference_id, location_id, amount, method, status, alloc_gen, recorded_via, recorded_by) VALUES (?, ?, 10, 'Efectivo', 'pending', 1, 'admin', 'otro')`, w.cid, w.A).lastInsertRowid);
        p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 1, 10, 'Efectivo', 'pending')`, w.a1, q);
        return { v, now };
    });
    const a = await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }] } });
    p.onSql(null);
    assert.strictEqual(b.value.v.status, 200, JSON.stringify(b.value.v.body));
    assert.strictEqual(a.status, 200, `the validated split stands: ${JSON.stringify(a.body)}`);
    const now = ok(await p.call('get', `/fee-payments/${t.id}`));
    assert.deepStrictEqual([now.status, now.alloc_gen, now.amount], ['validated', b.value.now.alloc_gen, 100], 'node B\'s validation was not reverted');
    assert.deepStrictEqual(live(p, t.id).map(x => [x.inscription_id, x.amount]), [[w.a1, 100]]);
    assert.deepStrictEqual(parts(p, t.id).map(r => r.status), ['validated'], 'the mirror follows the header');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 100, payment_status: 'paid' });
});

test('DELETE /locations waits for a portal payment of that location being recorded: it never names a deleted location', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    let deleting: Promise<any> | null = null;
    // The coordinator's payment has checked its people and is about to write its header when the admin
    // deletes location A.
    pauseAt(p, /^INSERT INTO \S+payment_transfers \(conference_id, location_id/, async () => {
        deleting = p.call('delete', `/locations/${w.A}`);
        await Promise.race([deleting, sleep(300)]);
    });
    const r = await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }] });
    p.onSql(null);
    ok(await deleting!, 'the location delete');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM wjp_conference_manager_locations WHERE id = ?`, w.A).n, 0);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const h = p.one(`SELECT location_id FROM ${TR} WHERE id = ?`, r.body.id);
    assert.strictEqual(h.location_id, null, 'the payment no longer names the deleted location');
    const t = ok(await p.call('get', `/fee-payments/${r.body.id}`));
    fail(await p.call('post', `/fee-payments/${t.id}/return`, { body: { note: 'x', expected: expectOf(t) } }), 409, 'no_recorder');
});

// ── round 6: findings of the third review round (money / concurrency / permissions) ─────────────────────

test('«Duplicar» is single-use: one voided receipt records ONE payment that counts — never a second copy, never the voided one again', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    // Ana owes $500. A $250 cash handover, photographed and recorded (born validated), then voided.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    const voided = ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'Se registra de nuevo', expected: expectOf(t) } })).transfer;
    const dup = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    const n = p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n;
    // A second «Duplicar» of the same voided receipt: refused, nothing written, Ana still $250.
    const again = fail(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'source_used');
    assert.deepStrictEqual(again.used_by, { id: dup.id, status: 'validated' });
    assert.match(again.error, /ya se registró de nuevo/);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, n, 'nothing written');
    // Validating the voided one again while its copy counts: refused.
    fail(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } }), 409, 'source_used');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' }, 'one $250 handover never counts as $500');
    assert.strictEqual(p.one(`SELECT status FROM ${TR} WHERE id = ?`, t.id).status, 'rejected');
    // Traced and visible: the copy names the voided one, the voided one names its live copy (detail and list).
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${dup.id}`)).duplicate_of, t.id);
    assert.deepStrictEqual(ok(await p.call('get', `/fee-payments/${t.id}`)).reused_by, [{ id: dup.id, status: 'validated' }]);
    const list = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`)).transfers;
    assert.deepStrictEqual(list.find((x: any) => x.id === t.id).reused_by, [{ id: dup.id, status: 'validated' }]);
    assert.deepStrictEqual(list.find((x: any) => x.id === dup.id).reused_by, []);
    // A copy of the copy belongs to the same family (it names the first payment): still one live at a time.
    const dupT = ok(await p.call('get', `/fee-payments/${dup.id}`));
    ok(await p.call('post', `/fee-payments/${dup.id}/reject`, { body: { note: 'Otra vez', expected: expectOf(dupT) } }));
    const dup2 = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: dup.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${dup2.id}`)).duplicate_of, t.id, 'the root of the chain');
    fail(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'source_used');
    fail(await p.call('post', `/fee-payments/${dup.id}/validate`, { body: { expected: { status: 'rejected', alloc_gen: 1 } } }), 409, 'source_used');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    // Voiding the live copy frees the family: the first payment may count again.
    const dup2T = ok(await p.call('get', `/fee-payments/${dup2.id}`));
    ok(await p.call('post', `/fee-payments/${dup2.id}/reject`, { body: { note: 'Era el original', expected: expectOf(dup2T) } }));
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } })).status, 'validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
});

test('«Duplicar» of cash without a photo is traced too (duplicate_of); deleting the copy frees the voided one; the portal never copies twice', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // Cash without a photo: nothing to copy, but «Duplicar» still names the payment it records again.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 100 }] })).transfer;
    const voided = ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'Fecha equivocada', expected: expectOf(t) } })).transfer;
    const dup = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', duplicate_of: t.id, leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 100 }] }));
    fail(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } }), 409, 'source_used');
    fail(await pay(p, { conference_id: w.cid, amount: 50, method: 'Efectivo', duplicate_of: t.id, allocations: [{ inscription_id: w.a3, amount: 50 }] }), 409, 'source_used');
    // A live payment can never be named, and two different sources in one body are refused.
    fail(await pay(p, { conference_id: w.cid, amount: 5, method: 'Efectivo', duplicate_of: dup.id, allocations: [{ inscription_id: w.a3, amount: 5 }] }), 409, 'proof_source_live');
    fail(await pay(p, { conference_id: w.cid, amount: 5, method: 'Efectivo', duplicate_of: t.id, copy_proof_from: dup.id, allocations: [{ inscription_id: w.a3, amount: 5 }] }), 400, 'proof_source');
    // Deleting the (pending) copy frees the voided payment.
    ok(await p.call('delete', `/fee-payments/${dup.id}`));
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } })).status, 'validated');
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 100, payment_status: 'paid' });
    // The portal: its own voided payment is copied once; the second copy is refused and named (its own).
    const portalA = await portalOf(p, w.A, w.codeA);
    const own = ok(await portalA('post', '/portal/fee-payments', { amount: 30, method: 'Efectivo', proof: PROOF, allocations: [{ inscription_id: w.a3, amount: 30 }] }));
    const ownT = ok(await p.call('get', `/fee-payments/${own.id}`));
    ok(await p.call('post', `/fee-payments/${own.id}/reject`, { body: { note: 'No llegó', expected: expectOf(ownT) } }));
    const c1 = ok(await portalA('post', '/portal/fee-payments', { amount: 30, method: 'Efectivo', copy_proof_from: own.id, allocations: [{ inscription_id: w.a3, amount: 30 }] }));
    const c2 = fail(await portalA('post', '/portal/fee-payments', { amount: 30, method: 'Efectivo', copy_proof_from: own.id, allocations: [{ inscription_id: w.a3, amount: 30 }] }), 409, 'source_used');
    assert.deepStrictEqual(c2.used_by, { id: c1.id, status: 'pending' });
    let view = ok(await portalA('get', '/portal/fee-payments'));
    const src = view.transfers.find((x: any) => x.id === own.id);
    assert.deepStrictEqual([src.reused, src.reused_by], [true, c1.id]);
    assert.strictEqual(view.transfers.find((x: any) => x.id === c1.id).duplicate_of, own.id);
    // The administration validates the copy; the voided original can never be validated beside it.
    const c1T = ok(await p.call('get', `/fee-payments/${c1.id}`));
    ok(await p.call('post', `/fee-payments/${c1.id}/validate`, { body: { expected: expectOf(c1T) } }));
    fail(await p.call('post', `/fee-payments/${own.id}/validate`, { body: { expected: { status: 'rejected', alloc_gen: 1 } } }), 409, 'source_used');
    assert.deepStrictEqual(row(p, w.a3), { amount_paid: 30, payment_status: 'partial' });
    // A copy the ADMINISTRATION made of a coordinator's voided payment: the portal learns it is used, not its number.
    const own2 = ok(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 20 }] }));
    const own2T = ok(await p.call('get', `/fee-payments/${own2.id}`));
    ok(await p.call('post', `/fee-payments/${own2.id}/reject`, { body: { note: 'Lo registra la sede', expected: expectOf(own2T) } }));
    const adminCopy = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', duplicate_of: own2.id, allocations: [{ inscription_id: w.a1, amount: 20 }] }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${adminCopy.id}`)).duplicate_of, own2.id);
    view = ok(await portalA('get', '/portal/fee-payments'));
    const src2 = view.transfers.find((x: any) => x.id === own2.id);
    assert.deepStrictEqual([src2.reused, src2.reused_by], [true, null]);
    const c3 = fail(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', duplicate_of: own2.id, allocations: [{ inscription_id: w.a1, amount: 20 }] }), 409, 'source_used');
    assert.strictEqual(c3.used_by, null, 'not the location\'s own payment: not named');
});

test('a voided transfer whose reference another live payment uses is flagged «Referencia repetida» before it is validated again', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 50, method: 'Transferencia', reference: 'BANK-77', proof: PROOF, allocations: [{ inscription_id: w.a1, amount: 50 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'Duplicada', expected: expectOf(t) } }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${t.id}`)).flags.duplicate_reference, false, 'nothing else uses it yet');
    // The same transfer entered again by hand (not «Duplicar»): the voided one now says so.
    ok(await pay(p, { conference_id: w.cid, amount: 50, method: 'Transferencia', reference: 'bank-77', proof: PROOF2, allow_duplicate_reference: true, allocations: [{ inscription_id: w.a2, amount: 50 }] }));
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${t.id}`)).flags.duplicate_reference, true);
    // Its own «Duplicar» copy is NOT a «Referencia repetida» (reused_by says it).
    const u = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Transferencia', reference: 'BANK-88', proof: PROOF, allocations: [{ inscription_id: w.a3, amount: 40 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${u.id}/reject`, { body: { note: 'Reparto', expected: expectOf(u) } }));
    const copy = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Transferencia', reference: 'BANK-88', copy_proof_from: u.id, allocations: [{ inscription_id: w.a3, amount: 40 }] }));
    const uv = ok(await p.call('get', `/fee-payments/${u.id}`));
    assert.deepStrictEqual([uv.flags.duplicate_reference, uv.reused_by], [false, [{ id: copy.id, status: 'validated' }]]);
});

test('several nodes: two «Duplicar» of one voided payment at once — one stands; a validation racing a copy backs off', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    const voided = ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'void', expected: expectOf(t) } })).transfer;
    const body = { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: t.id, allocations: [{ inscription_id: w.a1, amount: 250 }] };
    // Node A has checked the source and is about to write its header when node B records the same copy.
    const b = pauseAt(p, /^INSERT INTO \S+payment_transfers \(conference_id, location_id/, () => pay(nodeB, body));
    const a = await pay(p, body);
    p.onSql(null);
    assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
    fail(a, 409, 'source_used');
    assert.deepStrictEqual(a.body.used_by, { id: b.value.body.id, status: 'validated' });
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE duplicate_of = ?`, t.id).n, 1, 'the second copy was removed');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    // Node A validates the voided one again while node B, between that check and the flip, voids the copy
    // and records ANOTHER copy: the validation backs off — never two live payments of one handover.
    const copy = ok(await p.call('get', `/fee-payments/${b.value.body.id}`));
    ok(await p.call('post', `/fee-payments/${copy.id}/reject`, { body: { note: 'otra', expected: expectOf(copy) } }));
    const v = pauseAt(p, /^UPDATE \S+payment_transfers SET status = 'validated', updated_at/, () => pay(nodeB, { ...body, copy_proof_from: copy.id }));
    const r = await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } });
    p.onSql(null);
    assert.strictEqual(v.value.status, 200, JSON.stringify(v.value.body));
    fail(r, 409, 'source_used');
    assert.strictEqual(p.one(`SELECT status FROM ${TR} WHERE id = ?`, t.id).status, 'rejected', 'the flip was undone');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
});

test('boot hygiene mirrors only the live generation: an edit that crashed after writing its parts never counts, even after a healthy boot', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    // Luis owes $100 and has a pending $40 payment; correcting it to $60 dies at the header swap.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a2, amount: 40 }] })).transfer;
    p.onSql((sql) => { if (/^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/.test(sql)) throw new Error('Lock wait timeout exceeded'); });
    assert.strictEqual((await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 60 }] } })).status, 500);
    p.onSql(null);
    // The admin validates the live $40 split.
    ok(await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(ok(await p.call('get', `/fee-payments/${t.id}`))) } }));
    assert.deepStrictEqual(parts(p, t.id).map(r => [r.alloc_gen, r.amount, r.status]), [[1, 40, 'validated'], [2, 60, 'draft']]);
    // A healthy boot within the TTL: the newer generation keeps its 'draft' mirror (it may be an edit in flight).
    await p.reboot();
    assert.deepStrictEqual(parts(p, t.id).map(r => [r.alloc_gen, r.amount, r.status]), [[1, 40, 'validated'], [2, 60, 'draft']]);
    // A later degraded boot (the fee migration fails): readers go by the parts' own status — $40, never $100.
    p.onSql((sql) => { if (/^SELECT xp\.id, xp\.transfer_id, xp\.alloc_gen, xp\.created_at/.test(sql)) throw new Error('Lock wait timeout exceeded'); });
    await p.reboot();
    p.onSql(null);
    assert.ok(p.logs.some((l: any) => /fee payments migration failed/.test(l[1])), 'degraded mode');
    assert.deepStrictEqual(row(p, w.a2), { amount_paid: 40, payment_status: 'partial' });
});

test('several nodes: a validation whose mirror write lands late never overwrites another node\'s void', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    const t = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
    // Node A has validated the header and is about to write the parts' mirror when node B voids the payment.
    const b = pauseAt(p, /^UPDATE \S+payments SET status = /, async () => {
        const now = ok(await nodeB.call('get', `/fee-payments/${t.id}`));
        return nodeB.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'no llegó', expected: expectOf(now) } });
    });
    const a = await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } });
    p.onSql(null);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
    assert.strictEqual(p.one(`SELECT status FROM ${TR} WHERE id = ?`, t.id).status, 'rejected');
    assert.deepStrictEqual(parts(p, t.id).map(r => r.status), ['rejected'], 'the mirror follows the header');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
});

test('DELETE /inscriptions: a role with Inscripciones but without Pagos never learns payment numbers, statuses or sizes', async () => {
    const insc: HarnessUser = { id: 61, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'recepcion', userEmail: 'recepcion@example.test' };
    const p = await bootPlugin({ users: [insc] });
    const w = await world(p);
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Solo inscripciones', permissions: { inscriptions: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: insc.id, role_id: role } }));
    const shared = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a2, amount: 10 }, { inscription_id: w.a3, amount: 10 }] }));
    const b = fail(await p.call('delete', `/inscriptions/${w.a1}`, { user: insc }), 409);
    assert.notStrictEqual(b.code, 'shared');
    for (const k of ['transfer_ids', 'transfers', 'people']) assert.ok(!(k in b), `no ${k}: ${JSON.stringify(b)}`);
    assert.ok(!b.error.includes(`#${shared.id}`) && !/validado|compartido/.test(b.error), b.error);
    assert.match(b.error, /tiene pagos registrados/);
    // The administration (payments:manage) still gets the precise answer.
    const admin = fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    assert.deepStrictEqual(admin.transfer_ids, [shared.id]);
});

test('a resent or corrected payment awaits a new review: «Revisado por» is cleared, the history keeps the return', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const portalA = await portalOf(p, w.A, w.codeA);
    const r = ok(await portalA('post', '/portal/fee-payments', { amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 20 }] }));
    const t = ok(await p.call('get', `/fee-payments/${r.id}`));
    ok(await p.call('post', `/fee-payments/${r.id}/return`, { body: { note: 'Falta Luis', expected: expectOf(t) } }));
    const back = ok(await p.call('get', `/fee-payments/${r.id}`));
    assert.ok(back.reviewed_at && back.reviewed_by, 'returned: reviewed');
    let mine = ok(await portalA('get', '/portal/fee-payments')).transfers.find((x: any) => x.id === r.id);
    ok(await portalA('put', `/portal/fee-payments/${r.id}`, { expected: expectOf(mine), amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 10 }, { inscription_id: w.a2, amount: 10 }] }));
    const resent = ok(await p.call('get', `/fee-payments/${r.id}`));
    assert.deepStrictEqual([resent.status, resent.reviewed_at, resent.reviewed_by], ['pending', null, null]);
    assert.deepStrictEqual(resent.events.map((e: any) => [e.action, e.actor]), [['created', `portal:${w.A}`], ['returned', 'boss'], ['resent', `portal:${w.A}`]]);
    mine = ok(await portalA('get', '/portal/fee-payments')).transfers.find((x: any) => x.id === r.id);
    assert.strictEqual(mine.reviewed_at, null);
    // The administration correcting a returned payment of its own: the same.
    const a = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a3, amount: 10 }] })).transfer;
    const ret = ok(await p.call('post', `/fee-payments/${a.id}/return`, { body: { note: 'Monto', expected: expectOf(a) } })).transfer;
    const fixed = ok(await p.call('put', `/fee-payments/${a.id}`, { body: { expected: expectOf(ret), amount: 15, method: 'Efectivo', allocations: [{ inscription_id: w.a3, amount: 15 }] } })).transfer;
    assert.deepStrictEqual([fixed.status, fixed.reviewed_at, fixed.reviewed_by], ['pending', null, null]);
});

// ── round 7: the fourth review round (money / concurrency) ──────────────────────────────────────────────

/** Every non-draft payment adds up: its amount equals the sum of its live parts (no receipt left with a part missing). */
const allAddUp = (p: P) => {
    for (const h of p.q(`SELECT id, amount, status, alloc_gen FROM ${TR} WHERE status <> 'draft'`) as any[]) {
        const sum = (p.q(`SELECT amount FROM ${PAY} WHERE transfer_id = ? AND alloc_gen = ?`, h.id, h.alloc_gen) as any[]).reduce((s, x) => s + Math.round(x.amount * 100), 0);
        assert.strictEqual(sum, Math.round(h.amount * 100), `payment #${h.id} (${h.status}) adds up`);
    }
};

test('R4-M1: a correction never moves a «Duplicar» copy into another family — the first receipt can never count twice (admin)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    // R1: $250 cash with a photo for Ana, voided. R2: an unrelated $10 for Luis, voided.
    const r1 = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${r1.id}/reject`, { body: { note: 'Anulado', expected: expectOf(r1) } }));
    const r2 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${r2.id}/reject`, { body: { note: 'Anulado', expected: expectOf(r2) } }));
    // C = Duplicar(R1), left pending, carrying R1's receipt.
    const c = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: r1.id, duplicate_of: r1.id, leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    // A correction naming another source — with or without its receipt — is refused; nothing moves.
    const body = (extra: any) => ({ expected: expectOf(c), amount: 250, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 250 }], ...extra });
    fail(await p.call('put', `/fee-payments/${c.id}`, { body: body({ duplicate_of: r2.id }) }), 400, 'source_fixed');
    fail(await p.call('put', `/fee-payments/${c.id}`, { body: body({ copy_proof_from: r2.id, duplicate_of: r2.id }) }), 400, 'source_fixed');
    assert.deepStrictEqual(p.one(`SELECT duplicate_of, alloc_gen, proof FROM ${TR} WHERE id = ?`, c.id), { duplicate_of: r1.id, alloc_gen: 1, proof: PROOF2 });
    // Naming its own family changes nothing (an idempotent client): the copy stays R1's, with R1's receipt.
    const same = ok(await p.call('put', `/fee-payments/${c.id}`, { body: body({ duplicate_of: r1.id }) })).transfer;
    assert.strictEqual(same.duplicate_of, r1.id);
    assert.strictEqual(p.one(`SELECT proof FROM ${TR} WHERE id = ?`, c.id).proof, PROOF2);
    // R1 stays blocked while its copy counts: one $250 handover counts once.
    ok(await p.call('post', `/fee-payments/${c.id}/validate`, { body: { expected: expectOf(same) } }));
    const r1now = ok(await p.call('get', `/fee-payments/${r1.id}`));
    assert.deepStrictEqual(r1now.reused_by.map((m: any) => m.id), [c.id]);
    fail(await p.call('post', `/fee-payments/${r1.id}/validate`, { body: { expected: expectOf(r1now) } }), 409, 'source_used');
    fail(await pay(p, { conference_id: w.cid, amount: 250, method: 'Efectivo', copy_proof_from: r1.id, duplicate_of: r1.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'source_used');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
});

test('R4-M1: the same through the portal — a hand-made PUT cannot re-home a copy, and a second «Duplicar» stays refused', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    const portalA = await portalOf(p, w.A, w.codeA);
    const mk = async (b: any) => { const r = ok(await portalA('post', '/portal/fee-payments', b)); return r.view.transfers.find((t: any) => t.id === r.id); };
    const r1 = await mk({ amount: 250, method: 'Efectivo', proof: PROOF2, client_key: 'r7-m1-r1-0001', allocations: [{ inscription_id: w.a1, amount: 250 }] });
    ok(await p.call('post', `/fee-payments/${r1.id}/reject`, { body: { note: 'No llegó', expected: expectOf(r1) } }));
    const r2 = await mk({ amount: 10, method: 'Efectivo', client_key: 'r7-m1-r2-0001', allocations: [{ inscription_id: w.a2, amount: 10 }] });
    ok(await p.call('post', `/fee-payments/${r2.id}/reject`, { body: { note: 'No llegó', expected: expectOf(r2) } }));
    const c = await mk({ amount: 250, method: 'Efectivo', copy_proof_from: r1.id, duplicate_of: r1.id, client_key: 'r7-m1-c-00001', allocations: [{ inscription_id: w.a1, amount: 250 }] });
    fail(await portalA('put', `/portal/fee-payments/${c.id}`, { expected: expectOf(c), amount: 250, method: 'Efectivo', duplicate_of: r2.id, allocations: [{ inscription_id: w.a1, amount: 250 }] }), 400, 'source_fixed');
    assert.strictEqual(p.one(`SELECT duplicate_of FROM ${TR} WHERE id = ?`, c.id).duplicate_of, r1.id);
    fail(await portalA('post', '/portal/fee-payments', { amount: 250, method: 'Efectivo', copy_proof_from: r1.id, duplicate_of: r1.id, client_key: 'r7-m1-d2-0001', allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'source_used');
    // Only ONE payment carrying R1's receipt can count.
    assert.deepStrictEqual(p.q(`SELECT id FROM ${TR} WHERE status IN ('pending', 'validated', 'returned') AND proof = ?`, PROOF2).map((x: any) => x.id), [c.id]);
});

test('R4-L1: degraded mode never deletes a person who is part of a shared receipt (503), and the receipt still adds up after recovery', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const t = ok(await pay(p, { conference_id: w.cid, amount: 300, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }, { inscription_id: w.a3, amount: 100 }] })).transfer;
    fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared', 'healthy');
    // The next boot's schema probe hits a lock timeout: degraded mode (and the route's own retry fails too).
    p.onSql((sql) => { if (/^SELECT xp\.id, xp\.transfer_id, xp\.alloc_gen, xp\.created_at/.test(sql)) throw new Error('Lock wait timeout exceeded'); });
    await p.reboot();
    const refused = fail(await p.call('delete', `/inscriptions/${w.a1}`), 503, 'unavailable', 'degraded');
    assert.match(refused.error, /Cancela la inscripción/);
    assert.ok(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), 'Ana is still there');
    // A person without any payment can still be deleted in degraded mode.
    ok(await p.call('delete', `/inscriptions/${w.b1}`), 'no payments: deleted');
    p.onSql(null);
    await p.reboot();
    allAddUp(p);
    assert.deepStrictEqual(live(p, t.id).map((x) => x.inscription_id), [w.a1, w.a2, w.a3]);
    const acc = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    assert.strictEqual(acc.entries.find((x: any) => x.transfer_id === t.id).amount, 300);
});

test('R4-L2: several nodes — DELETE /inscriptions racing a shared payment on another node never leaves a receipt with a part missing', async () => {
    // (a) Node B records a shared payment with Ana right after node A's first check: A sees it again and refuses.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        const b = pauseAt(p, /^SELECT status FROM \S+inscriptions WHERE id = \?/, () =>
            nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 200, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }] } }));
        const del = await p.call('delete', `/inscriptions/${w.a1}`);
        p.onSql(null);
        assert.strictEqual(b.value.status, 200, JSON.stringify(b.value.body));
        fail(del, 409, 'shared');
        assert.notStrictEqual(p.one(`SELECT status FROM ${INS} WHERE id = ?`, w.a1).status, 'cancelled', 'Ana is as she was');
        allAddUp(p);
        assert.deepStrictEqual([row(p, w.a1), row(p, w.a2)], [{ amount_paid: 100, payment_status: 'paid' }, { amount_paid: 100, payment_status: 'paid' }]);
    }
    // (b) Node B is mid-way (its parts written, the payment not yet live) when node A deletes Ana: B backs off.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        const a = pauseAt(nodeB, /^UPDATE \S+payment_transfers SET status = 'validated'/, () => p.call('delete', `/inscriptions/${w.a1}`));
        const b = await nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 200, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }] } });
        nodeB.onSql(null);
        ok(a.value, 'A deleted Ana');
        fail(b, 400, 'unknown_people');
        assert.deepStrictEqual(b.body.ids, [w.a1]);
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE status <> 'draft'`).n, 0, 'no payment stands');
        allAddUp(p);
        assert.deepStrictEqual(row(p, w.a2), { amount_paid: 0, payment_status: 'unpaid' });
    }
    // (c) Node B starts after node A marked Ana: B is refused at once, A deletes her.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        // (paused right before Ana's own row goes: she is already marked)
        const b = pauseAt(p, /^DELETE FROM \S+inscriptions WHERE id = \?/, () =>
            nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 200, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 100 }, { inscription_id: w.a2, amount: 100 }] } }));
        ok(await p.call('delete', `/inscriptions/${w.a1}`));
        p.onSql(null);
        fail(b.value, 400, 'cancelled_people');
        assert.strictEqual(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), undefined);
        allAddUp(p);
    }
});

test('R4-L3: several nodes — an edit that backs off while another node boots puts the old split back; the payment and its receipt never vanish', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    // Ana owes 100: a pending $40 payment with a receipt (generation 1). Node A edits it to $60.
    const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', proof: PROOF2, leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 40 }] })).transfer;
    let stage = 0;
    p.onSql(async (sql) => {
        // 1) the edit checked the caps and mints its generation: node B records $50 for Ana meanwhile;
        if (stage === 0 && /^SELECT gen_seq, alloc_gen FROM \S+payment_transfers WHERE id = \?/.test(sql)) {
            stage = 1;
            ok(await nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 50, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 50 }] } }), 'node B');
        }
        // 2) the edit swapped to its generation and re-checks: a third node boots now (a rolling restart).
        if (stage === 1 && /^SELECT id, status, total_due FROM \S+inscriptions WHERE id IN/.test(sql)) {
            stage = 2;
            await bootPlugin({ raw: p.raw });
        }
    });
    const e = await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] } });
    p.onSql(null);
    assert.strictEqual(stage, 2, 'the interleaving happened');
    fail(e, 409, 'over_cap');
    const back = ok(await p.call('get', `/fee-payments/${t.id}`));
    assert.deepStrictEqual([back.status, back.amount, back.has_proof, back.allocations.map((x: any) => x.amount)], ['pending', 40, true, [40]]);
    assert.ok(back.alloc_gen > 2, 'a fresh generation, above the one of the edit');
    assert.strictEqual(p.one(`SELECT proof FROM ${TR} WHERE id = ?`, t.id).proof, PROOF2);
    const list = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
    assert.deepStrictEqual(list.transfers.filter((x: any) => x.status === 'pending').map((x: any) => x.amount).sort(), [40, 50]);
    assert.strictEqual(list.people.find((x: any) => x.id === w.a1).pending, 90);
    allAddUp(p);
    // The mirror of the restored split is the header's, and a later boot keeps it.
    assert.deepStrictEqual(p.q(`SELECT status FROM ${PAY} WHERE transfer_id = ?`, t.id).map((x: any) => x.status), ['pending']);
    await p.reboot();
    assert.deepStrictEqual(live(p, t.id).map((x) => x.amount), [40]);
});

// ── round 7: findings of the fifth review round (money / concurrency / docs) ────────────────────────────

test('R5-M1: validating a voided transfer again re-runs the duplicate-reference check — one bank transfer never counts twice', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    const portal = await portalOf(p, w.A, w.codeA);
    // P1: the coordinator records transfer REF-777 ($250); the admin voids it («No se recibió el dinero»).
    const r1 = ok(await portal('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: 'REF-777', proof: PROOF, client_key: 'r5m1-first-01', allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    const p1 = ok(await p.call('get', `/fee-payments/${r1.id}`));
    ok(await p.call('post', `/fee-payments/${p1.id}/reject`, { body: { note: 'No se recibió el dinero', expected: expectOf(p1) } }));
    // P2: the same transfer recorded again by hand as a NEW payment (new photo, same reference), validated.
    const r2 = ok(await portal('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: ' ref-777 ', proof: PROOF2, client_key: 'r5m1-second-1', allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    const p2 = ok(await p.call('get', `/fee-payments/${r2.id}`));
    ok(await p.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2) } }));
    // Validating the voided P1 again is refused: P2 already counts that transfer.
    const p1now = ok(await p.call('get', `/fee-payments/${p1.id}`));
    assert.deepStrictEqual([p1now.flags.duplicate_reference, p1now.flags.duplicate_reference_of], [true, p2.id]);
    // Refused BEFORE any write: the voided payment never counts, not even for an instant another node could read.
    const seen: string[] = [];
    p.onSql((sql) => { seen.push(sql); });
    const refused = fail(await p.call('post', `/fee-payments/${p1.id}/validate`, { body: { expected: expectOf(p1now) } }), 409, 'duplicate_reference');
    p.onSql(null);
    assert.deepStrictEqual([refused.other, refused.details], [{ id: p2.id }, { other: { id: p2.id } }]);
    assert.ok(!seen.some((sql) => /^UPDATE \S+payment_transfers SET status = 'validated'/.test(sql)), 'no flip to validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${p1.id}`)).status, 'rejected', 'still voided');
    // The pre-2.18 part route refuses it the same way.
    const partOfP1 = p.one(`SELECT p.id FROM ${PAY} p JOIN ${TR} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen WHERE t.id = ?`, p1.id).id;
    fail(await p.call('post', `/payments/${partOfP1}/validate`), 409, 'duplicate_reference');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    // The admin confirms it is ANOTHER transfer: allowed explicitly.
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${p1.id}/validate`, { body: { expected: expectOf(p1now), allow_duplicate_reference: true } })).status, 'validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 500, payment_status: 'paid' });
    // Cash has no transfer reference to compare.
    const c = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', reference: 'REF-777', allocations: [{ inscription_id: w.a2, amount: 10 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${c.id}/reject`, { body: { note: 'x', expected: expectOf(c) } }));
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${c.id}/validate`, { body: { expected: expectOf(ok(await p.call('get', `/fee-payments/${c.id}`))) } })).status, 'validated');
});

test('R5-M1: several nodes — a voided transfer validated again while another node records its reference: never both count', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    const nodeB = await bootPlugin({ raw: p.raw });
    const t = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Transferencia', reference: 'BANK-9', proof: PROOF, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'No llegó', expected: expectOf(t) } }));
    const voided = ok(await p.call('get', `/fee-payments/${t.id}`));
    // Node A has checked the reference (nothing else uses it) and is about to flip; node B records BANK-9 again.
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET status = 'validated', updated_at/, () =>
        nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 250, method: 'Transferencia', reference: 'BANK-9', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 250 }] } }));
    const a = await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(voided) } });
    p.onSql(null);
    ok(b.value, 'node B recorded it first');
    fail(a, 409, 'duplicate_reference');
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${t.id}`)).status, 'rejected', 'the voided one backed off');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    allAddUp(p);
});

test('R5-M1 twin: several nodes — two payments recorded at once with the same transfer reference: one backs off', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    // Node A wrote its payment (still a draft: invisible) when node B records the same reference whole.
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET status = 'validated', submitted_at/, () =>
        nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 40, method: 'Transferencia', reference: 'TRX-1', proof: PROOF2, allocations: [{ inscription_id: w.a2, amount: 40 }] } }));
    const a = await pay(p, { conference_id: w.cid, amount: 50, method: 'Transferencia', reference: 'trx-1', proof: PROOF, allocations: [{ inscription_id: w.a1, amount: 50 }] });
    p.onSql(null);
    ok(b.value, 'node B');
    const refused = fail(a, 409, 'duplicate_reference');
    assert.deepStrictEqual(refused.other, { id: b.value.body.id });
    assert.deepStrictEqual(ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`)).transfers.map((x: any) => x.reference), ['TRX-1']);
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
    // A correction that takes a reference another node records meanwhile backs off too, and the split stays.
    const e = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Transferencia', reference: 'OLD-1', proof: PROOF, leave_pending: true, allocations: [{ inscription_id: w.a3, amount: 30 }] })).transfer;
    const c = pauseAt(p, /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/, () =>
        nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 20, method: 'Transferencia', reference: 'NEW-2', proof: PROOF2, allocations: [{ inscription_id: w.a1, amount: 20 }] } }));
    const edit = await p.call('put', `/fee-payments/${e.id}`, { body: { expected: expectOf(e), amount: 30, method: 'Transferencia', reference: 'NEW-2', allocations: [{ inscription_id: w.a3, amount: 30 }] } });
    p.onSql(null);
    ok(c.value, 'node B');
    fail(edit, 409, 'duplicate_reference');
    const back = ok(await p.call('get', `/fee-payments/${e.id}`));
    assert.deepStrictEqual([back.status, back.reference, back.amount, back.has_proof], ['pending', 'OLD-1', 30, true]);
    allAddUp(p);
});

test('R5-L1: several nodes — deleting a person while another node re-splits their 1-person payment never deletes that payment', async () => {
    for (const variant of ['move', 'add'] as const) {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        // X: $50 cash recorded for Ana by mistake (pending). Node A corrects it: to Luis («move»), or adds Luis.
        const x = ok(await pay(p, { conference_id: w.cid, amount: 50, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 50 }] })).transfer;
        const anaBefore = p.one(`SELECT status FROM ${INS} WHERE id = ?`, w.a1);
        assert.notStrictEqual(anaBefore.status, 'cancelled');
        let releaseB: () => void = () => {};
        const bGate = new Promise<void>((r) => { releaseB = r; });
        let bPaused: () => void = () => {};
        const bAtDelete = new Promise<void>((r) => { bPaused = r; });
        let bArmed = true;
        // Node B (deleting Ana) stops right before it deletes Ana's 1-person payments.
        nodeB.onSql(async (sql) => {
            if (bArmed && /^DELETE FROM \S+payment_transfers WHERE id/.test(sql)) { bArmed = false; bPaused(); await bGate; }
        });
        let bp: Promise<any> | null = null;
        let stage = 0;
        p.onSql(async (sql) => {
            // A is at its header compare-and-set: B plans (X is still Ana's alone) and stops before deleting.
            if (stage === 0 && /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/.test(sql)) {
                stage = 1;
                bp = nodeB.call('delete', `/inscriptions/${w.a1}`);
                await bAtDelete;
            } else if (stage === 1 && /^SELECT id, status, total_due FROM \S+inscriptions WHERE id IN/.test(sql)) {
                // A swapped the split and re-checks: B goes on now.
                stage = 2;
                releaseB();
                await bp;
            }
        });
        const allocations = variant === 'move' ? [{ inscription_id: w.a2, amount: 50 }] : [{ inscription_id: w.a1, amount: 25 }, { inscription_id: w.a2, amount: 25 }];
        const e = await p.call('put', `/fee-payments/${x.id}`, { body: { expected: expectOf(x), amount: 50, method: 'Efectivo', allocations } });
        p.onSql(null); nodeB.onSql(null);
        assert.strictEqual(stage, 2, `${variant}: the interleaving happened`);
        const del = await bp!;
        const edited = ok(e, `${variant}: the correction stands`);
        assert.ok(edited.transfer, `${variant}: a success always comes with its payment`);
        assert.deepStrictEqual(edited.transfer.allocations.map((a: any) => [a.inscription_id, a.amount]), allocations.map(a => [a.inscription_id, a.amount]));
        if (variant === 'move') {
            // R6-L2: the payment moved to Luis is no longer Ana's — the delete leaves it alone and does what the admin
            // asked: Ana goes, the payment stays, now Luis's.
            ok(del, 'move: the delete');
            assert.strictEqual(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), undefined, 'Ana is deleted');
            assert.strictEqual(ok(await p.call('get', `/fee-payments/${x.id}`)).allocations[0].inscription_id, w.a2, 'the payment stays, now Luis\'s');
        } else {
            // Now shared with Ana in it: 409 stale before anything was deleted; Ana is still there, as she was.
            fail(del, 409, 'stale', `${variant}: the delete`);
            assert.match(del.body.error, new RegExp(`#${x.id}`));
            assert.deepStrictEqual(del.body.deleted_transfer_ids === undefined ? [] : del.body.deleted_transfer_ids, []);
            assert.deepStrictEqual(p.one(`SELECT status FROM ${INS} WHERE id = ?`, w.a1), anaBefore);
        }
        allAddUp(p);
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} p WHERE p.transfer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${TR} t WHERE t.id = p.transfer_id)`).n, 0, 'no orphan part');
        const view = ok(await p.call('get', `/fee-payments?conference_id=${w.cid}`));
        assert.strictEqual(view.people.find((x2: any) => x2.id === w.a2).pending, variant === 'move' ? 50 : 25, `${variant}: Luis's part counts`);
        // Deleting Ana again now: she is part of a shared payment.
        if (variant === 'add') fail(await p.call('delete', `/inscriptions/${w.a1}`), 409, 'shared');
    }
});

test('R5-L1: a correction or a validation whose payment was deleted meanwhile never answers success', async () => {
    // (a) An edit backs off (node B recorded money meanwhile) and finds its payment deleted: 409 stale, no event.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        const t = ok(await pay(p, { conference_id: w.cid, amount: 40, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 40 }] })).transfer;
        let stage = 0;
        p.onSql(async (sql) => {
            if (stage === 0 && /^SELECT gen_seq, alloc_gen FROM \S+payment_transfers WHERE id = \?/.test(sql)) {
                stage = 1;
                ok(await nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 50, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 50 }] } }), 'node B');
            } else if (stage === 1 && /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/.test(sql)) {
                stage = 2;   // the edit's own compare-and-set
            } else if (stage === 2 && /^UPDATE \S+payment_transfers SET alloc_gen = \?, amount = \?/.test(sql)) {
                stage = 3;   // its undo: another node deleted the payment just before it
                p.exec(`DELETE FROM ${TR} WHERE id = ?`, t.id);
            }
        });
        const events = p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id = ?`, t.id).n;
        const e = await p.call('put', `/fee-payments/${t.id}`, { body: { expected: expectOf(t), amount: 60, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 60 }] } });
        p.onSql(null);
        assert.strictEqual(stage, 3, 'the interleaving happened');
        fail(e, 409, 'stale');
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id = ?`, t.id).n, events, 'no history line for a payment that is gone');
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE transfer_id = ?`, t.id).n, 0, 'no part left behind');
        assert.strictEqual(ok(await p.call('get', `/inscriptions/${w.a1}`)).pending_amount, 50);
    }
    // (b) A validation backs off (node B validated meanwhile) and finds its payment deleted: 409 stale.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        const p1 = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
        ok(await p.call('post', `/fee-payments/${p1.id}/return`, { body: { note: 'Revisa la fecha', expected: expectOf(p1) } }));
        const p2 = ok(await pay(p, { conference_id: w.cid, amount: 100, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 100 }] })).transfer;
        const p1r = ok(await p.call('get', `/fee-payments/${p1.id}`));
        let stage = 0;
        p.onSql(async (sql) => {
            if (stage === 0 && /^UPDATE \S+payment_transfers SET status = 'validated', updated_at/.test(sql)) {
                stage = 1;
                ok(await nodeB.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2) } }), 'node B');
            } else if (stage === 1 && /^UPDATE \S+payment_transfers SET status = \?, updated_at = CURRENT_TIMESTAMP, updated_by = \? WHERE id = \? AND status = 'validated'/.test(sql)) {
                stage = 2;
                p.exec(`DELETE FROM ${TR} WHERE id = ?`, p1.id);
            }
        });
        const a = await p.call('post', `/fee-payments/${p1.id}/validate`, { body: { expected: expectOf(p1r) } });
        p.onSql(null);
        assert.strictEqual(stage, 2, 'the interleaving happened');
        fail(a, 409, 'stale');
        assert.deepStrictEqual(row(p, w.a1), { amount_paid: 100, payment_status: 'paid' });
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${EV} WHERE transfer_id = ? AND action = 'validated'`, p1.id).n, 0);
    }
});

test('R5-L2: several nodes — a portal payment recorded while its location is deleted elsewhere names no location; «Devolver» refuses a dead one', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const nodeB = await bootPlugin({ raw: p.raw });
    const portalA = await portalOf(p, w.A, w.codeA);
    // Node A is about to write the header when node B deletes location A (its own node's lock does not see A's).
    const b = pauseAt(p, /^INSERT INTO \S+payment_transfers \(conference_id, location_id/, () => nodeB.call('delete', `/locations/${w.A}`));
    const r = await portalA('post', '/portal/fee-payments', { amount: 50, method: 'Efectivo', client_key: 'r5l2-key-0001', allocations: [{ inscription_id: w.a1, amount: 50 }] });
    p.onSql(null);
    ok(b.value, 'node B deleted the location');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(p.one(`SELECT location_id FROM ${TR} WHERE id = ?`, r.body.id).location_id, null, 'no deleted location named');
    const t = ok(await p.call('get', `/fee-payments/${r.body.id}`));
    fail(await p.call('post', `/fee-payments/${t.id}/return`, { body: { note: 'foto borrosa', expected: expectOf(t) } }), 409, 'no_recorder');
    // A header that still names a deleted location (a crash in between): «Devolver» looks the location up…
    const portalB = await portalOf(p, w.B, w.codeB);
    const rb = ok(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] }));
    p.exec(`UPDATE ${TR} SET location_id = 987654 WHERE id = ?`, rb.id);
    const tb = ok(await p.call('get', `/fee-payments/${rb.id}`));
    fail(await p.call('post', `/fee-payments/${tb.id}/return`, { body: { note: 'x', expected: expectOf(tb) } }), 409, 'no_recorder');
    // …and the next boot clears it; a live location's payment keeps its own.
    await p.reboot();
    assert.strictEqual(p.one(`SELECT location_id FROM ${TR} WHERE id = ?`, rb.id).location_id, null);
    const rb2 = ok(await portalB('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] }));
    await p.reboot();
    assert.strictEqual(p.one(`SELECT location_id FROM ${TR} WHERE id = ?`, rb2.id).location_id, w.B);
});

test('R5-L3: degraded mode records no payment, and the portal says so in words meant for the coordinator; the docs say the same', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`DROP TABLE ${EV}`);
    p.exec(`DROP TABLE ${TR}`);
    p.onSql((sql) => { if (sql === `CREATE TABLE ${TR}`) throw new Error('lock wait timeout exceeded'); });
    await p.reboot();
    const portalA = await portalOf(p, w.A, w.codeA);
    const coordinator = 'Los pagos no están disponibles en este momento; inténtalo más tarde.';
    for (const r of [
        await portalA('post', '/portal/payments/bulk', { inscription_ids: [w.a2], amount_per_person: 10, method: 'Efectivo' }),
        await portalA('get', '/portal/fee-payments'),
        await portalA('post', '/portal/fee-payments', { amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 10 }] }),
    ]) {
        const body = fail(r, 503, 'unavailable');
        assert.strictEqual(body.error, coordinator);
    }
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY}`).n, 0, 'nothing recorded');
    // The administration keeps the precise reason.
    assert.match(fail(await p.call('get', `/fee-payments?conference_id=${w.cid}`), 503, 'unavailable').error, /registro del servidor/);
    p.onSql(null);
    // The docs no longer promise that the previous payment flow keeps working while degraded.
    const root = path.resolve(__dirname, '..', '..', '..');
    for (const name of ['CHANGELOG.md', path.join('documentation', 'plugins-reference.md')]) {
        const flat = fs.readFileSync(path.join(root, name), 'utf8').replace(/\s+/g, ' ');
        assert.doesNotMatch(flat, /portal keeps its previous payment form, and the «Pagos de cuotas» routes/, name);
        assert.doesNotMatch(flat, /\(a core portal keeps its previous flow\)/, name);
        assert.match(flat, /no payment can be recorded until the migration completes/, name);
    }
});

// ── 2.18.0 review round 6 (money / concurrency) ──────────────────────────────────────────────────────

test('R6-M1: validating a PENDING or RETURNED payment re-checks the transfer reference too — one bank transfer never counts twice', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id = ?`, w.a1);
    const portal = await portalOf(p, w.A, w.codeA);
    // P1: Ana pays $250 by transfer REF-777 (portal); the admin validates it.
    const r1 = ok(await portal('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: 'REF-777', proof: PROOF, client_key: 'r6m1-first-001', allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    const p1 = ok(await p.call('get', `/fee-payments/${r1.id}`));
    ok(await p.call('post', `/fee-payments/${p1.id}/validate`, { body: { expected: expectOf(p1) } }));
    // A week later the coordinator uploads the same screenshot again: «Registrar de todas formas».
    fail(await portal('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: 'ref-777', proof: PROOF2, client_key: 'r6m1-second-01', allocations: [{ inscription_id: w.a1, amount: 250 }] }), 409, 'duplicate_reference');
    const r2 = ok(await portal('post', '/portal/fee-payments', { amount: 250, method: 'Transferencia', reference: 'ref-777', proof: PROOF2, client_key: 'r6m1-second-01', allow_duplicate_reference: true, allocations: [{ inscription_id: w.a1, amount: 250 }] }));
    const p2 = ok(await p.call('get', `/fee-payments/${r2.id}`));
    assert.deepStrictEqual([p2.status, p2.flags.duplicate_reference, p2.flags.duplicate_reference_of], ['pending', true, p1.id]);
    // «Validar y siguiente»: refused BEFORE any write, naming the payment that counts the transfer.
    const seen: string[] = [];
    p.onSql((sql) => { seen.push(sql); });
    const refused = fail(await p.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2) } }), 409, 'duplicate_reference');
    p.onSql(null);
    assert.deepStrictEqual([refused.other, refused.details], [{ id: p1.id }, { other: { id: p1.id } }]);
    assert.ok(!seen.some((sql) => /^UPDATE \S+payment_transfers SET status = 'validated'/.test(sql)), 'no flip to validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    // A returned one too.
    ok(await p.call('post', `/fee-payments/${p2.id}/return`, { body: { note: '¿Es la misma transferencia?', expected: expectOf(p2) } }));
    const p2r = ok(await p.call('get', `/fee-payments/${p2.id}`));
    fail(await p.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2r) } }), 409, 'duplicate_reference');
    // The pre-2.18 part route refuses it the same way.
    const partOfP2 = p.one(`SELECT p.id FROM ${PAY} p JOIN ${TR} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen WHERE t.id = ?`, p2.id).id;
    fail(await p.call('post', `/payments/${partOfP2}/validate`), 409, 'duplicate_reference');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 250, payment_status: 'partial' });
    // The admin checked the bank — it IS another transfer: confirmed, it counts, and the history says so.
    assert.strictEqual(ok(await p.call('post', `/fee-payments/${p2.id}/validate`, { body: { expected: expectOf(p2r), allow_duplicate_reference: true } })).status, 'validated');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 500, payment_status: 'paid' });
    const events = ok(await p.call('get', `/fee-payments/${p2.id}`)).events.map((e: any) => [e.action, e.note]);
    assert.deepStrictEqual(events.slice(-2), [['validated', null], ['reference_confirmed', String(p1.id)]]);
    // An old portal's /portal/payments/bulk always records a repeated reference: validating the second asks too.
    const b1 = ok(await portal('post', '/portal/payments/bulk', { inscription_ids: [w.a2], amount_per_person: 50, method: 'Transferencia', reference: 'BANK-55', proof: PROOF }));
    const b2 = ok(await portal('post', '/portal/payments/bulk', { inscription_ids: [w.a3], amount_per_person: 50, method: 'Transferencia', reference: 'BANK-55', proof: PROOF }));
    const t1 = ok(await p.call('get', `/fee-payments/${b1.id}`));
    fail(await p.call('post', `/fee-payments/${b1.id}/validate`, { body: { expected: expectOf(t1) } }), 409, 'duplicate_reference');
    ok(await p.call('post', `/fee-payments/${b1.id}/validate`, { body: { expected: expectOf(t1), allow_duplicate_reference: true } }));
    const t2 = ok(await p.call('get', `/fee-payments/${b2.id}`));
    fail(await p.call('post', `/fee-payments/${b2.id}/validate`, { body: { expected: expectOf(t2) } }), 409, 'duplicate_reference');
    // A validation without a repeated reference leaves no such line; nor does cash.
    const c = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', reference: 'BANK-55', leave_pending: true, allocations: [{ inscription_id: w.b1, amount: 10 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${c.id}/validate`, { body: { expected: expectOf(c) } }));
    assert.ok(!ok(await p.call('get', `/fee-payments/${c.id}`)).events.some((e: any) => e.action === 'reference_confirmed'));
});

test('R6-M1: several nodes — a pending payment validated while another node records its transfer reference: never both count', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 500 WHERE id IN (?, ?)`, w.a1, w.a2);
    const nodeB = await bootPlugin({ raw: p.raw });
    const t = ok(await pay(p, { conference_id: w.cid, amount: 250, method: 'Transferencia', reference: 'BANK-6', proof: PROOF, leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 250 }] })).transfer;
    const b = pauseAt(p, /^UPDATE \S+payment_transfers SET status = 'validated', updated_at/, () =>
        nodeB.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 250, method: 'Transferencia', reference: 'bank-6', proof: PROOF2, allow_duplicate_reference: true, allocations: [{ inscription_id: w.a2, amount: 250 }] } }));
    const a = await p.call('post', `/fee-payments/${t.id}/validate`, { body: { expected: expectOf(t) } });
    p.onSql(null);
    ok(b.value, 'node B recorded it');
    fail(a, 409, 'duplicate_reference');
    assert.strictEqual(ok(await p.call('get', `/fee-payments/${t.id}`)).status, 'pending', 'the validation backed off');
    assert.deepStrictEqual(row(p, w.a1), { amount_paid: 0, payment_status: 'unpaid' });
    allAddUp(p);
});

test('R6-M2: a reused client_key with OTHER data is refused naming the recorded payment — never «registered» for a payment not on screen', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    p.exec(`UPDATE ${INS} SET total_due = 300 WHERE id IN (?, ?, ?)`, w.a1, w.a2, w.a3);
    // Admin: a born-validated cash payment Ana 250 + Luis 250 lands, but its answer is lost.
    const first = { conference_id: w.cid, client_key: 'r6m2-admin-0001', amount: 500, method: 'Efectivo', paid_on: today(), allocations: [{ inscription_id: w.a1, amount: 250 }, { inscription_id: w.a2, amount: 250 }] };
    const r1 = ok(await pay(p, first));
    // The admin corrects the split on screen (Ana 200 + Luis 300 + Sol 100) and sends again with the same key.
    const changed = fail(await pay(p, { ...first, amount: 600, allocations: [{ inscription_id: w.a1, amount: 200 }, { inscription_id: w.a2, amount: 300 }, { inscription_id: w.a3, amount: 100 }] }), 409, 'client_key_changed');
    assert.deepStrictEqual([changed.id, changed.details], [r1.id, { id: r1.id }]);
    assert.match(changed.error, new RegExp(`pago #${r1.id}`));
    // Nothing else was written: one payment, the first amounts.
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR}`).n, 1);
    assert.deepStrictEqual(live(p, r1.id).map((x: any) => [x.inscription_id, x.amount]), [[w.a1, 250], [w.a2, 250]]);
    assert.deepStrictEqual(row(p, w.a3), { amount_paid: 0, payment_status: 'unpaid' });
    // The same total split otherwise (Ana 300 + Luis 200) is another payment too.
    fail(await pay(p, { ...first, allocations: [{ inscription_id: w.a1, amount: 300 }, { inscription_id: w.a2, amount: 200 }] }), 409, 'client_key_changed', 'split');
    // Each other difference counts too: method, reference, note, date, amount, a photo.
    for (const [what, extra] of [['method', { method: 'Transferencia', proof: PROOF }], ['note', { note: 'otra' }], ['reference', { reference: 'R-1' }],
        ['photo', { proof: PROOF }], ['date', { paid_on: '2026-01-02' }]] as const) {
        fail(await pay(p, { ...first, ...extra }), 409, 'client_key_changed', what);
    }
    // The SAME request replayed is still the replay it always was.
    const again = ok(await pay(p, first));
    assert.deepStrictEqual([again.id, again.replayed], [r1.id, true]);
    // The same without its date (it meant «today») replays too.
    const { paid_on: _d, ...noDate } = first;
    assert.strictEqual(ok(await pay(p, noDate)).replayed, true);
    // Portal: the same thing after the coordinator adds a person and changes the amounts.
    const portal = await portalOf(p, w.A, w.codeA);
    const pf = { client_key: 'r6m2-portal-001', amount: 40, method: 'Efectivo', paid_on: today(), allocations: [{ inscription_id: w.a3, amount: 40 }] };
    const pr = ok(await portal('post', '/portal/fee-payments', pf));
    const pc = fail(await portal('post', '/portal/fee-payments', { ...pf, amount: 50, allocations: [{ inscription_id: w.a3, amount: 30 }, { inscription_id: w.a1, amount: 20 }] }), 409, 'client_key_changed');
    assert.strictEqual(pc.id, pr.id);
    assert.deepStrictEqual(live(p, pr.id).map((x: any) => [x.inscription_id, x.amount]), [[w.a3, 40]]);
    const pa = ok(await portal('post', '/portal/fee-payments', pf));
    assert.deepStrictEqual([pa.id, pa.replayed], [pr.id, true]);
    // «Duplicar» names its voided payment: a replay must name the same one.
    const v = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', allocations: [{ inscription_id: w.b1, amount: 10 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${v.id}/reject`, { body: { note: 'x', expected: expectOf(v) } }));
    const dup = { conference_id: w.cid, client_key: 'r6m2-dup-00001', amount: 10, method: 'Efectivo', paid_on: today(), duplicate_of: v.id, allocations: [{ inscription_id: w.b1, amount: 10 }] };
    const d1 = ok(await pay(p, dup));
    assert.strictEqual(ok(await pay(p, dup)).replayed, true);
    fail(await pay(p, { ...dup, duplicate_of: undefined }), 409, 'client_key_changed');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${TR} WHERE duplicate_of = ?`, v.id).n, 1, d1.id);
});

test("R6-L1: Inscripciones without Pagos reads a person's parts without the payment behind them (number, size, people, reference, review)", async () => {
    const mk = (id: number, login: string): HarnessUser => ({ id, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: login, userEmail: `${login}@example.test` });
    const insc = mk(71, 'recepcion6'), cashier = mk(72, 'caja6');
    const p = await bootPlugin({ users: [insc, cashier] });
    const w = await world(p);
    const role = async (name: string, permissions: any) => ok(await p.call('post', '/staff/roles', { body: { name, permissions } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: insc.id, role_id: await role('Solo inscripciones', { inscriptions: 'manage' }) } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: cashier.id, role_id: await role('Caja ver', { payments: 'view' }) } }));
    const t = ok(await pay(p, { conference_id: w.cid, amount: 90, method: 'Transferencia', reference: 'SECRET-1', proof: PROOF, leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 30 }, { inscription_id: w.a2, amount: 30 }, { inscription_id: w.a3, amount: 30 }] })).transfer;
    ok(await p.call('post', `/fee-payments/${t.id}/reject`, { body: { note: 'No llegó el dinero; comprobante sospechoso', expected: expectOf(t) } }));
    const brief = ok(await p.call('get', `/inscriptions/${w.a1}/payments`, { user: insc }));
    assert.strictEqual(brief.length, 1);
    assert.deepStrictEqual(Object.keys(brief[0]).sort(), ['amount', 'date', 'id', 'inscription_id', 'method', 'status']);
    assert.deepStrictEqual([brief[0].amount, brief[0].method, brief[0].status], [30, 'Transferencia', 'rejected']);
    assert.ok(!JSON.stringify(brief).includes('SECRET-1') && !JSON.stringify(brief).includes('sospechoso') && !JSON.stringify(brief).includes('boss'));
    // with_proof=1 changes nothing for it.
    assert.deepStrictEqual(ok(await p.call('get', `/inscriptions/${w.a1}/payments?with_proof=1`, { user: insc })), brief);
    // Pagos › ver keeps the whole shape.
    const full = ok(await p.call('get', `/inscriptions/${w.a1}/payments`, { user: cashier }));
    assert.deepStrictEqual([full[0].transfer_id, full[0].transfer.people, full[0].review_note, full[0].reference], [t.id, 3, 'No llegó el dinero; comprobante sospechoso', 'SECRET-1']);
});

test('R6-L2: several nodes — deleting a person never loses a validated payment of theirs while they stay', async () => {
    // (a) The reviewer's interleaving: Ana has #1 validated $30 and #2 pending $20. While node B deletes Ana, node A moves
    //     #2 to Luis. Either Ana goes with #1 and #2 stands as Luis's, or the delete answers 409 with #1 kept — never a
    //     409 with #1 gone.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const nodeB = await bootPlugin({ raw: p.raw });
        const v = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 30 }] })).transfer;
        const q = ok(await pay(p, { conference_id: w.cid, amount: 20, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 20 }] })).transfer;
        let moved: any = null;
        let armed = true;
        nodeB.onSql(async (sql) => {
            // Right after node B's FIRST payment delete, node A moves the other payment to Luis (if it still can).
            if (armed && /^DELETE FROM \S+payment_transfers WHERE id = \? AND alloc_gen = \?/.test(sql)) {
                armed = false;
                moved = await p.call('put', `/fee-payments/${q.id}`, { body: { expected: expectOf(q), amount: 20, method: 'Efectivo', allocations: [{ inscription_id: w.a2, amount: 20 }] } });
            }
        });
        const del = await nodeB.call('delete', `/inscriptions/${w.a1}`);
        nodeB.onSql(null);
        assert.ok(moved, 'the interleaving happened');
        if (del.status === 200) {
            assert.strictEqual(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), undefined);
            assert.strictEqual(p.one(`SELECT id FROM ${TR} WHERE id = ?`, v.id), undefined, '#1 went with Ana');
            // #2: deleted with Ana before node A could move it, or moved to Luis and left alone — never half of it.
            if (moved.status === 200) assert.deepStrictEqual(live(p, q.id).map((x: any) => [x.inscription_id, x.amount]), [[w.a2, 20]]);
            else assert.strictEqual(p.one(`SELECT id FROM ${TR} WHERE id = ?`, q.id), undefined);
        } else {
            fail(del, 409, 'stale');
            assert.ok(p.one(`SELECT id FROM ${TR} WHERE id = ?`, v.id), 'never a 409 with the validated #1 gone');
            assert.deepStrictEqual(row(p, w.a1), { amount_paid: 30, payment_status: 'partial' });
        }
        allAddUp(p);
    }
    // (b) The VALIDATED payment goes last: when a pending one of theirs becomes shared between two deletes, the delete
    //     answers 409 naming what it already deleted, and the validated money is still there.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const v = ok(await pay(p, { conference_id: w.cid, amount: 30, method: 'Efectivo', allocations: [{ inscription_id: w.a1, amount: 30 }] })).transfer;
        const q1 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
        const q2 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
        let armed = true;
        const order: number[] = [];
        p.onSql((sql, params) => {
            if (!/^DELETE FROM \S+payment_transfers WHERE id = \? AND alloc_gen = \?/.test(sql)) return;
            order.push(Number(params && params[0]));
            if (!armed) return;
            armed = false;
            // Another node re-splits q2 between the two deletes: Ana + Luis at a new generation.
            p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 7, 5, 'Efectivo', 'pending'), (?, ?, 7, 5, 'Efectivo', 'pending')`, w.a1, q2.id, w.a2, q2.id);
            p.exec(`UPDATE ${TR} SET alloc_gen = 7 WHERE id = ?`, q2.id);
            p.exec(`DELETE FROM ${PAY} WHERE transfer_id = ? AND alloc_gen = 1`, q2.id);
        });
        const del = await p.call('delete', `/inscriptions/${w.a1}`);
        p.onSql(null);
        assert.strictEqual(order[0], q1.id, 'a pending payment goes first');
        const body = fail(del, 409, 'stale');
        assert.deepStrictEqual(body.deleted_transfer_ids, [q1.id]);
        assert.match(body.error, new RegExp(`#${q2.id}[\\s\\S]*#${q1.id}`));
        assert.ok(p.one(`SELECT id FROM ${TR} WHERE id = ?`, v.id), 'the validated payment is still there');
        assert.deepStrictEqual(row(p, w.a1), { amount_paid: 30, payment_status: 'partial' });
        assert.notStrictEqual(p.one(`SELECT status FROM ${INS} WHERE id = ?`, w.a1).status, 'cancelled', 'Ana is back as she was');
        allAddUp(p);
    }
    // (c) Still theirs alone at a NEW generation (another node's correction that backed off put it back): deleted.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const q = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
        let armed = true;
        p.onSql((sql) => {
            if (!armed || !/^DELETE FROM \S+payment_transfers WHERE id = \? AND alloc_gen = \?/.test(sql)) return;
            armed = false;
            p.exec(`UPDATE ${PAY} SET alloc_gen = 4 WHERE transfer_id = ?`, q.id);
            p.exec(`UPDATE ${TR} SET alloc_gen = 4 WHERE id = ?`, q.id);
        });
        ok(await p.call('delete', `/inscriptions/${w.a1}`));
        p.onSql(null);
        assert.strictEqual(p.one(`SELECT id FROM ${TR} WHERE id = ?`, q.id), undefined, 'deleted at its new generation');
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${PAY} WHERE transfer_id = ?`, q.id).n, 0);
    }
    // (d) One became shared between the plan and the first delete: 409 stale before ANYTHING is deleted.
    {
        const p = await bootPlugin();
        const w = await world(p);
        const q1 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
        const q2 = ok(await pay(p, { conference_id: w.cid, amount: 10, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: w.a1, amount: 10 }] })).transfer;
        let armed = true;
        p.onSql((sql) => {
            // The delete reads its planned payments again: right before that, another node shares q2 with Luis.
            if (!armed || !/^SELECT id, alloc_gen, status FROM \S+payment_transfers WHERE id = \?/.test(sql)) return;
            armed = false;
            p.exec(`INSERT INTO ${PAY} (inscription_id, transfer_id, alloc_gen, amount, method, status) VALUES (?, ?, 9, 5, 'Efectivo', 'pending'), (?, ?, 9, 5, 'Efectivo', 'pending')`, w.a1, q2.id, w.a2, q2.id);
            p.exec(`UPDATE ${TR} SET alloc_gen = 9 WHERE id = ?`, q2.id);
            p.exec(`DELETE FROM ${PAY} WHERE transfer_id = ? AND alloc_gen = 1`, q2.id);
        });
        const del = await p.call('delete', `/inscriptions/${w.a1}`);
        p.onSql(null);
        const body = fail(del, 409, 'stale');
        assert.strictEqual(body.deleted_transfer_ids, undefined, 'nothing deleted');
        assert.ok(p.one(`SELECT id FROM ${TR} WHERE id = ?`, q1.id), 'q1 is still there');
        assert.ok(p.one(`SELECT id FROM ${INS} WHERE id = ?`, w.a1), 'Ana is still there');
        allAddUp(p);
    }
});
