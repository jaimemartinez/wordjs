/**
 * conference-manager 2.18.0 — the inscription tables' backend (tables design D1–D13, browser paging).
 *
 * Pinned against the REAL plugin (fixtures/conference-manager-harness.ts):
 *   - GET /inscriptions/:id is exactly one row of GET /inscriptions (same SELECT, same gate, same reg_code
 *     masking), 404 for a missing or non-integer id, and is registered AFTER /inscriptions/export so it
 *     never captures «export» (route shadowing);
 *   - GET /inscriptions without paging parameters is still the bare array; the legacy limit/offset pages
 *     are stable: the id breaks ties between equal names (no person repeated or dropped across pages), and
 *     the portal list is ordered by first name then id;
 *   - cancelled inscriptions: the admin row keeps `status: 'cancelled'`, the portal row says
 *     `cancelled: true` (never the raw status); cancelling frees the bed; reactivating into a full
 *     location answers 409.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type HarnessUser } from './fixtures/conference-manager-harness';

const INS = 'wjp_conference_manager_inscriptions';
type P = Awaited<ReturnType<typeof bootPlugin>>;
let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function world(p: P, capacity = 100) {
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `roster-${++seq}`, fee_default: 80 } })).id as number;
    for (const template of ['first_name', 'last_name']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, name: 'ciudad', label: 'Ciudad', type: 'text' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const loc = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Bogotá', capacity } }));
    const person = async (first: string, last: string, extra: any = {}) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: first, last_name: last, ciudad: 'Tunja', location_id: loc.id, ...extra } })).id as number;
    return { cid, loc: loc.id as number, code: loc.code as string, person };
}

test('GET /inscriptions/:id is exactly the roster row: every column, the room, the money under review', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const a = await w.person('Ana', 'Pérez'), b = await w.person('Luis', 'Gómez');
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Hotel Norte', capacity: 10 } })).id;
    const room = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '12', capacity: 2 } })).id;
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: room } }));
    ok(await p.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 30, method: 'Efectivo', leave_pending: true, allocations: [{ inscription_id: a, amount: 30 }] } }));
    ok(await p.call('post', '/fee-payments', { body: { conference_id: w.cid, amount: 20, method: 'Efectivo', allocations: [{ inscription_id: b, amount: 20 }] } }));
    const list = ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`));
    assert.ok(Array.isArray(list), 'no paging parameters → the bare array, as before');
    for (const r of list) {
        const one = await p.call('get', `/inscriptions/${r.id}`);
        assert.strictEqual(one.route, '/inscriptions/:id');
        assert.deepStrictEqual(ok(one), r, `row ${r.id}`);
    }
    const ana = ok(await p.call('get', `/inscriptions/${a}`));
    assert.deepStrictEqual([ana.room_number, ana.hotel_name, ana.pending_amount, ana.returned_amount, ana.ciudad], ['12', 'Hotel Norte', 30, 0, 'Tunja']);
    assert.ok(ana.reg_code, 'the administrator sees the code');
    assert.deepStrictEqual(ana.custom_data, {});
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${b}`)).amount_paid, 20);
    for (const bad of ['999999', 'abc', '0', '-1', '1.5', '1e2', '%20']) {
        const r = await p.call('get', `/inscriptions/${bad}`);
        assert.strictEqual(r.status, 404, `${bad}: ${JSON.stringify(r.body)}`);
    }
});

test('route shadowing: /inscriptions/export is still the CSV export, registered before /inscriptions/:id', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    await w.person('Ana', 'Pérez');
    const r = await p.call('get', `/inscriptions/export?conference_id=${w.cid}`);
    assert.strictEqual(r.route, '/inscriptions/export');
    const body = ok(r);
    assert.strictEqual(body.count, 1);
    assert.ok(String(body.csv).includes('Ana'));
    const paths = p.routes.filter(x => x.method === 'get').map(x => x.path);
    assert.ok(paths.indexOf('/inscriptions/export') < paths.indexOf('/inscriptions/:id'), 'export first');
});

test('GET /inscriptions/:id: the same gate as the roster, and reg_code only with inscriptions:view', async () => {
    const team = (id: number, login: string): HarnessUser => ({ id, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: login, userEmail: `${login}@example.test` });
    const sections = ['inscriptions', 'lodging', 'transport', 'accounting', 'dashboard', 'reports'];
    const users = sections.map((s, i) => team(60 + i, `u-${s}`));
    const cook = team(80, 'cocina');
    const cashier = team(81, 'caja');
    const p = await bootPlugin({ users: [...users, cook, cashier] });
    const w = await world(p);
    const a = await w.person('Ana', 'Pérez');
    const code = p.one(`SELECT reg_code FROM ${INS} WHERE id = ?`, a).reg_code;
    for (let i = 0; i < sections.length; i++) {
        const roleId = ok(await p.call('post', '/staff/roles', { body: { name: `R ${sections[i]}`, permissions: { [sections[i]]: 'view' } } })).id;
        ok(await p.call('post', '/staff/members', { body: { user_id: users[i].id, role_id: roleId } }));
        const one = ok(await p.call('get', `/inscriptions/${a}`, { user: users[i] }), sections[i]);
        const listed = ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: users[i] }))[0];
        assert.deepStrictEqual(one, listed, `${sections[i]}: same row as the roster`);
        assert.strictEqual(one.reg_code, sections[i] === 'inscriptions' ? code : null, `${sections[i]}: reg_code`);
    }
    const roleId = ok(await p.call('post', '/staff/roles', { body: { name: 'Cocina sola', permissions: { meals_delivery: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: cook.id, role_id: roleId } }));
    assert.strictEqual((await p.call('get', `/inscriptions/${a}`, { user: cook })).status, 403);
    // D-P20 (2.18.0): Pagos alone is not a door to the roster — «Pagos de cuotas» names people from its own view.
    const cashRole = ok(await p.call('post', '/staff/roles', { body: { name: 'Caja', permissions: { payments: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: cashier.id, role_id: cashRole } }));
    assert.strictEqual((await p.call('get', `/inscriptions/${a}`, { user: cashier })).status, 403);
    assert.strictEqual((await p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: cashier })).status, 403);
    assert.strictEqual((await p.call('get', `/inscriptions/${a}`, { anonymous: true })).status, 401);
});

test('stable order: equal names are ordered by id, so legacy limit/offset pages neither repeat nor drop anyone', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await w.person('María', 'López'));
    const other = await w.person('Abel', 'Arias');
    const from = p.sqlLog.length;
    const all = ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`)).map((r: any) => r.id);
    assert.ok(p.sqlLog.slice(from).some(s => /ORDER BY i\.last_name, i\.first_name, i\.id\s*$/.test(s)), 'the id breaks ties');
    assert.deepStrictEqual(all, [other, ...ids], 'Arias first, then the López by id');
    const seen: number[] = [];
    for (let off = 0; off < 10; off += 3) seen.push(...ok(await p.call('get', `/inscriptions?conference_id=${w.cid}&limit=3&offset=${off}`)).map((r: any) => r.id));
    assert.deepStrictEqual(seen, all, 'the pages are the list, in order, each person once');
    // The CSV export uses the same order.
    const from2 = p.sqlLog.length;
    ok(await p.call('get', `/inscriptions/export?conference_id=${w.cid}`));
    assert.ok(p.sqlLog.slice(from2).some(s => /ORDER BY i\.last_name, i\.first_name, i\.id\s*$/.test(s)));
});

test('portal list: ordered by first name then id; cancelled people flagged (never the raw status)', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    const z = await w.person('Zoe', 'A'), m1 = await w.person('Mia', 'B'), m2 = await w.person('Mia', 'C');
    ok(await p.call('put', `/inscriptions/${m1}`, { body: { status: 'cancelled' } }));
    const token = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.loc, code: w.code } })).token;
    const from = p.sqlLog.length;
    const list = ok(await p.call('get', '/portal/inscriptions', { anonymous: true, headers: { 'x-portal-token': token } }));
    assert.ok(p.sqlLog.slice(from).some(s => /ORDER BY i\.first_name, i\.id\s*$/.test(s)), 'id tie-breaker');
    assert.deepStrictEqual(list.map((r: any) => r.id), [m1, m2, z]);
    assert.deepStrictEqual(list.map((r: any) => r.cancelled), [true, false, false]);
    for (const r of list) for (const k of ['status', 'notes', 'reg_code', 'room_id', 'location_id', 'custom_data']) assert.ok(!(k in r), `portal row carries ${k}`);
    // The admin row keeps the status for the struck-through row and the «Cancelada» label.
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${m1}`)).status, 'cancelled');
});

test('cancel / reactivate (the person sheet): cancelling frees the bed and the seat; reactivating into a full location is 409', async () => {
    const p = await bootPlugin();
    const w = await world(p, 1);
    const a = await w.person('Ana', 'Pérez');
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'H', capacity: 4 } })).id;
    const room = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '1', capacity: 2 } })).id;
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: room } }));
    ok(await p.call('put', `/inscriptions/${a}`, { body: { status: 'cancelled' } }));
    const row = ok(await p.call('get', `/inscriptions/${a}`));
    assert.deepStrictEqual([row.status, row.room_id], ['cancelled', null]);
    const b = await w.person('Beto', 'Gómez');   // the freed seat
    const r = await p.call('put', `/inscriptions/${a}`, { body: { status: 'active' } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    ok(await p.call('put', `/inscriptions/${b}`, { body: { status: 'cancelled' } }));
    ok(await p.call('put', `/inscriptions/${a}`, { body: { status: 'active' } }));
    assert.strictEqual(ok(await p.call('get', `/inscriptions/${a}`)).status, 'active');
});
