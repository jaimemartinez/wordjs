/**
 * conference-manager 2.17.0 — «Últimas entregas» says WHAT was delivered.
 *
 * The site owner, testing «Alimentación» on an iPhone: «en la parte de alimentación en últimas entregas no
 * muestra qué se le entregó». The rows of GET /meals/services/:id/deliveries named the person, the location,
 * the method and who recorded it — never the meal. Pinned against the REAL plugin
 * (fixtures/conference-manager-harness.ts):
 *   - the answer carries `service` — the same projection /meals/check and /meals/deliver name the meal with
 *     (id, day, meal, label, window) — and every row its `service_id`; the 2.15 row contract is otherwise
 *     unchanged;
 *   - each service's list names its own meal and holds only its own deliveries;
 *   - the service is read live: a label edited later names the rows with the new label;
 *   - the kitchen role (meals_delivery:manage) gets the same answer, its registration codes still masked.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type HarnessUser } from './fixtures/conference-manager-harness';

const INS = 'wjp_conference_manager_inscriptions';

type P = Awaited<ReturnType<typeof bootPlugin>>;

let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function ensureField(p: P, cid: number, name: string, label: string) {
    const list = ok(await p.call('get', `/fields?conference_id=${cid}`), 'fields');
    if (list.some((f: any) => f.name === name)) return;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, name, label, type: 'text', options: '', sort_order: 50 + (++seq) } }), `field ${name}`);
}
async function newPerson(p: P, cid: number, values: Record<string, any>) {
    const id = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, gender: 'M', ...values } }), 'inscription').id as number;
    return { id, code: p.one(`SELECT reg_code FROM ${INS} WHERE id = ?`, id).reg_code as string };
}

/** Lunch «Campestre» and dinner on one day, planned for Bogotá; Ana (Bogotá) eats both, Beto (no location) lunch by override. */
async function scenario(p: P) {
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso 2027', slug: `meal-recent-${++seq}` } }), 'create').id as number;
    await ensureField(p, cid, 'first_name', 'Nombre');
    await ensureField(p, cid, 'last_name', 'Apellido');
    const A = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Bogotá', capacity: 100 } }), 'location').id as number;
    const lunch = ok(await p.call('post', '/meals/services', { body: { conference_id: cid, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', location_ids: [A] } }), 'lunch').id as number;
    const dinner = ok(await p.call('post', '/meals/services', { body: { conference_id: cid, service_date: '2027-03-01', meal: 'cena', location_ids: [A] } }), 'dinner').id as number;
    const ana = await newPerson(p, cid, { first_name: 'Ana', last_name: 'Pérez', location_id: A });
    const beto = await newPerson(p, cid, { first_name: 'Beto', last_name: 'Gómez' });
    const deliver = async (body: any) => ok(await p.call('post', '/meals/deliver', { body }), JSON.stringify(body));
    assert.strictEqual((await deliver({ service_id: lunch, code: ana.code })).result, 'delivered');
    assert.strictEqual((await deliver({ service_id: lunch, inscription_id: beto.id, force: true, note: 'Autorizado en la entrega' })).result, 'delivered');
    assert.strictEqual((await deliver({ service_id: dinner, inscription_id: ana.id })).result, 'delivered');
    return { cid, A, lunch, dinner, ana, beto };
}

test('GET /meals/services/:id/deliveries names WHAT every row delivered: the service, and each row\'s service_id', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const recent = ok(await p.call('get', `/meals/services/${s.lunch}/deliveries`), 'lunch deliveries');
    const LUNCH = { id: s.lunch, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', start_time: null, end_time: null };
    assert.deepStrictEqual(recent.service, LUNCH);
    assert.strictEqual(recent.service_id, s.lunch);
    // The same projection the confirmation card and the «Entregado» card name the meal with.
    const check = ok(await p.call('post', '/meals/check', { body: { service_id: s.lunch, code: s.ana.code } }));
    assert.deepStrictEqual(recent.service, check.service);
    // Newest first, each row with the service it delivered; the dinner is not in the lunch's list.
    assert.deepStrictEqual(recent.deliveries.map((d: any) => [d.name, d.service_id, d.method]), [['Beto Gómez', s.lunch, 'override'], ['Ana Pérez', s.lunch, 'scan']]);
    // The 2.15 row contract is kept; `service_id` is the only addition.
    assert.deepStrictEqual(Object.keys(recent.deliveries[0]).sort(), [
        'delivered_at', 'delivered_by', 'delivery_id', 'family_group', 'inscription_id', 'location', 'location_id', 'method', 'name', 'note', 'reg_code', 'service_id',
    ]);
    assert.strictEqual(recent.deliveries[0].note, 'Autorizado en la entrega');
    assert.strictEqual(recent.deliveries[1].location, 'Bogotá');

    const dinner = ok(await p.call('get', `/meals/services/${s.dinner}/deliveries`), 'dinner deliveries');
    assert.deepStrictEqual(dinner.service, { id: s.dinner, service_date: '2027-03-01', meal: 'cena', label: null, start_time: null, end_time: null });
    assert.deepStrictEqual(dinner.deliveries.map((d: any) => [d.name, d.service_id, d.method]), [['Ana Pérez', s.dinner, 'manual']]);

    // `limit` still bounds the list (and the service still comes with it).
    const one = ok(await p.call('get', `/meals/services/${s.lunch}/deliveries?limit=1`));
    assert.deepStrictEqual(one.deliveries.map((d: any) => d.name), ['Beto Gómez']);
    assert.deepStrictEqual(one.service, LUNCH);
    // An unknown service is still a 404.
    assert.strictEqual((await p.call('get', '/meals/services/999999/deliveries')).status, 404);
});

test('the service is read live: a label edited after the deliveries names them with the new label', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    ok(await p.call('put', `/meals/services/${s.lunch}`, { body: { label: 'Campestre (sede norte)', start_time: '12:00', end_time: '14:30' } }), 'edit');
    const recent = ok(await p.call('get', `/meals/services/${s.lunch}/deliveries`));
    assert.deepStrictEqual(recent.service, { id: s.lunch, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre (sede norte)', start_time: '12:00', end_time: '14:30' });
    assert.ok(recent.deliveries.every((d: any) => d.service_id === s.lunch));
});

test('the kitchen role (meals_delivery:manage) gets the service too; registration codes stay masked', async () => {
    const kitchen: HarnessUser = { id: 41, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'cocina4', userEmail: 'cocina4@example.test' };
    const p = await bootPlugin({ users: [kitchen] });
    const s = await scenario(p);
    const roleId = ok(await p.call('post', '/staff/roles', { body: { name: 'Cocina 4', permissions: { meals_delivery: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: kitchen.id, role_id: roleId } }));
    const recent = ok(await p.call('get', `/meals/services/${s.lunch}/deliveries`, { user: kitchen }), 'kitchen');
    assert.strictEqual(recent.service.meal, 'almuerzo');
    assert.strictEqual(recent.service.label, 'Campestre');
    assert.deepStrictEqual(recent.deliveries.map((d: any) => d.reg_code), [null, null]);
    const admin = ok(await p.call('get', `/meals/services/${s.lunch}/deliveries`));
    assert.deepStrictEqual(admin.deliveries.map((d: any) => d.reg_code), [s.beto.code, s.ana.code]);
});
