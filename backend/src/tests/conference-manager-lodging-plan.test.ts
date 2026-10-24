/**
 * conference-manager 2.20.0 — the fewest rooms, and «Sugerir reparto».
 *
 * The site owner: allotting rooms to locations by head count alone leaves arrangements the automatic
 * assignment cannot fill without breaking a rule — the panel must suggest how to give beds to the locations
 * «de tal forma que se usen la menor cantidad de habitaciones y que no se incumplan las reglas»; and «el motor
 * debe buscar la menor cantidad de habitaciones a usar y sin o la menor cantidad de camas vacías en las
 * habitaciones con personas» (a preference — a soft rule — gives way to save a room: the owner's choice).
 * Pinned against the REAL plugin (fixtures/conference-manager-harness.ts):
 *   - lodging-pack.js: the room sets (fewest rooms, then fewest spare beds) and Best Fit Decreasing;
 *   - the run packs each class (the hard separate_by values) into the fewest rooms, fills rooms already holding
 *     people first, keeps a child with an adult, and lets a soft rule give way — reported, never hard;
 *   - POST /assignment/simulate is exactly what POST /assignment/run then does (the same engine on a copy);
 *   - POST /assignment/plan suggests the allotment AND who sleeps where — shared rooms only when that saves a
 *     room — judged as a run's final rooms; /plan/apply writes exactly that (the allotments and the people; a run
 *     left alone may give a shared room to another class and push people onto pool beds — seen live) and only
 *     the plan the admin saw (409 plan_changed otherwise); a frozen location is never touched, and without
 *     `replan` the allotments made stay.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { bootPlugin, type Plugin } from './fixtures/conference-manager-harness';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pack = require(path.resolve(__dirname, '../../../marketplace/plugins/conference-manager/server/lodging-pack.js'));

const T = (n: string) => `wjp_conference_manager_${n}`;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

let seq = 0;
/** A conference with the «Nombre» and «Género» fields and one hotel «Dorado» with `rooms` ([number, beds]), all pool. */
async function world(rooms: [string, number][]) {
    const p: Plugin = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `plan-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'gender' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const [M, F] = (p.one(`SELECT options FROM ${T('fields')} WHERE conference_id = ? AND name = 'gender'`, cid).options as string).split(',').map(s => s.trim());
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Dorado' } })).id as number;
    const room: Record<string, number> = {};
    for (const [n, c] of rooms) room[n] = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: n, capacity: c } })).id as number;
    const loc = async (name: string) => ok(await p.call('post', '/locations', { body: { conference_id: cid, name, capacity: 50 } })).id as number;
    const person = async (first_name: string, gender: string, location_id: number | null = null) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, gender, ...(location_id ? { location_id } : {}) } }), first_name).id as number;
    const rule = async (body: any) => ok(await p.call('post', '/assignment/rules', { body: { conference_id: cid, enabled: 1, priority: 10, ...body } }), body.name);
    const hardGender = () => rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1 });
    const roomOf = (id: number) => (p.one(`SELECT room_id FROM ${T('inscriptions')} WHERE id = ?`, id) || {}).room_id ?? null;
    /** Rooms with somebody: { number: [people, beds] }. */
    const used = () => Object.fromEntries((p.q(`SELECT r.room_number AS n, r.capacity AS c, COUNT(i.id) AS k FROM ${T('rooms')} r JOIN ${T('inscriptions')} i ON i.room_id = r.id GROUP BY r.id, r.room_number, r.capacity ORDER BY r.id`) as any[]).map(x => [x.n, [Number(x.k), Number(x.c)]]));
    const gendersIn = (roomId: number) => new Set((p.q(`SELECT gender FROM ${T('inscriptions')} WHERE room_id = ?`, roomId) as any[]).map(x => x.gender));
    const run = async () => ok(await p.call('post', '/assignment/run', { body: { conference_id: cid } }), 'run');
    const plan = async (opts: any = {}) => ok(await p.call('post', '/assignment/plan', { body: { conference_id: cid, ...opts } }), 'plan').plan;
    const ownerOf = (roomId: number) => p.one(`SELECT location_id FROM ${T('rooms')} WHERE id = ?`, roomId).location_id as number | null;
    const shares = (roomId: number) => p.q(`SELECT location_id, beds FROM ${T('room_beds')} WHERE room_id = ? ORDER BY location_id`, roomId) as any[];
    return { p, cid, M, F, hotel, room, loc, person, rule, hardGender, roomOf, used, gendersIn, run, plan, ownerOf, shares };
}
const hardOf = (r: any) => (r.violations || []).filter((v: any) => v.hard);

test('lodging-pack: the fewest rooms, then the fewest spare beds; Best Fit Decreasing keeps groups whole', () => {
    const caps = (c: number[], need: number) => pack.roomSets(c, need, 1)[0].map((i: number) => c[i]).sort((a: number, b: number) => b - a);
    assert.deepStrictEqual(caps([4, 4, 2], 3), [4]);
    assert.deepStrictEqual(caps([4, 4, 3, 3], 6), [3, 3], '2 rooms, no empty bed');
    assert.deepStrictEqual(caps([4, 4, 4, 3, 3], 10), [4, 3, 3]);
    assert.deepStrictEqual(caps([2, 2, 2, 2], 5), [2, 2, 2]);
    assert.deepStrictEqual(caps([2, 3, 4], 12), [4, 3, 2], 'not enough beds: every room');
    // A large conference: the bulk greedily, the tail exactly — still the fewest rooms.
    const big = Array.from({ length: 300 }, (_, i) => [2, 3, 4, 6][i % 4]);
    const set = pack.roomSets(big, 700, 1)[0];
    assert.strictEqual(set.length, 138);
    assert.ok(set.reduce((n: number, i: number) => n + big[i], 0) >= 700);
    // Two families of 3 and rooms of 4, 2, 2, 6: one room of 6 (fewest rooms), each family whole.
    const r = pack.packNew([{ size: 3 }, { size: 3 }], [{ free: 4 }, { free: 2 }, { free: 2 }, { free: 6 }], () => true);
    assert.deepStrictEqual([r.left.length, new Set(r.placed.map(([, b]: any) => b.free)).size, r.placed[0][1].free], [0, 1, 6]);
});

test('the run uses the fewest rooms for each class: 3 men and 3 women in rooms of 4, 4 and 2 take the two rooms of 4', async () => {
    const w = await world([['C2', 2], ['A4', 4], ['B4', 4]]);
    await w.hardGender();
    for (let i = 0; i < 3; i++) { await w.person(`M${i}`, w.M); await w.person(`F${i}`, w.F); }
    const r = await w.run();
    assert.deepStrictEqual(hardOf(r), []);
    assert.strictEqual(r.remaining, 0);
    assert.deepStrictEqual(w.used(), { A4: [3, 4], B4: [3, 4] }, 'two rooms, one empty bed each — the 2-bed room stays free');
    for (const n of ['A4', 'B4']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1, `${n} holds one gender`);
});

test('without rules: 6 people in rooms of 4, 4, 3 and 3 fill the two rooms of 3 — no empty bed', async () => {
    const w = await world([['A4', 4], ['B4', 4], ['C3', 3], ['D3', 3]]);
    for (let i = 0; i < 6; i++) await w.person(`P${i}`, i % 2 ? w.F : w.M);
    await w.run();
    assert.deepStrictEqual(w.used(), { C3: [3, 3], D3: [3, 3] });
});

test('rooms already holding people are filled first: no new room while their beds take the class', async () => {
    const w = await world([['B2', 2], ['A4', 4]]);
    await w.hardGender();
    const first = await w.person('M0', w.M);
    ok(await w.p.call('post', `/inscriptions/${first}/assign`, { body: { room_id: w.room.A4 } }), 'manual');
    await w.person('M1', w.M); await w.person('M2', w.M);
    await w.run();
    assert.deepStrictEqual(w.used(), { A4: [3, 4] }, 'the room with someone already, not the empty 2-bed one');
});

test('a soft rule gives way to save a room — reported as a preference, never as hard', async () => {
    const w = await world([['B2', 2], ['C2', 2], ['A4', 4]]);
    await w.rule({ name: 'Preferir separar por género', type: 'separate_by', config: 'gender', hard: 0 });
    await w.person('M0', w.M); await w.person('F0', w.F); await w.person('M1', w.M); await w.person('F1', w.F);
    const r = await w.run();
    assert.deepStrictEqual(w.used(), { A4: [4, 4] }, 'one room instead of two');
    assert.deepStrictEqual(hardOf(r), []);
    const soft = r.violations.filter((v: any) => v.rule === 'Preferir separar por género');
    assert.strictEqual(soft.length, 1, JSON.stringify(r.violations));
    assert.ok(soft[0].detail.includes('para usar menos habitaciones') && soft[0].hard === false, soft[0].detail);
});

test('a child travels with an adult of the class: a hard companion rule and hard genders in rooms of 2', async () => {
    const w = await world([['A2', 2], ['B2', 2], ['C2', 2], ['D2', 2]]);
    await w.hardGender();
    await w.rule({ name: 'Niño con adulto', type: 'require_companion', hard: 1, priority: 5,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });
    const kidM = await w.person('KidM', w.M), kidF = await w.person('KidF', w.F);
    await w.person('AdultM1', w.M); await w.person('AdultM2', w.M); await w.person('AdultF', w.F);
    const r = await w.run();
    assert.deepStrictEqual(hardOf(r), []);
    for (const kid of [kidM, kidF]) {
        const mates = (w.p.q(`SELECT first_name FROM ${T('inscriptions')} WHERE room_id = ?`, w.roomOf(kid)) as any[]).map(x => x.first_name);
        assert.ok(mates.some((n: string) => n.startsWith('Adult')), `${JSON.stringify(mates)}`);
    }
    assert.strictEqual(Object.keys(w.used()).length, 3, 'men 3 → 2 rooms, women 2 → 1 room');
});

test('POST /assignment/simulate is exactly what the run then does (locations, a shared room, own rules, the pool, the overflow)', async () => {
    const w = await world([['A2', 2], ['B3', 3], ['C4', 4], ['D2', 2], ['E3', 3]]);
    const { p } = w;
    await w.hardGender();
    await w.rule({ name: 'Niño con adulto', type: 'require_companion', hard: 0, priority: 5,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.B3] } }));
    ok(await p.call('put', `/rooms/${w.room.C4}/beds`, { body: { shares: [{ location_id: sur, beds: 2 }] } }));
    // A location's own rule (the coordinator's).
    p.exec(`INSERT INTO ${T('assignment_rules')} (conference_id, location_id, name, type, config, params, enabled, priority, hard) VALUES (?, ?, 'Sur separa', 'separate_by', 'gender', '{}', 1, 20, 1)`, w.cid, sur);
    for (const [n, g] of [['AdultN1', w.M], ['KidN', w.M], ['AdultN2', w.F], ['NF2', w.F]] as [string, string][]) await w.person(n, g, norte);
    for (const [n, g] of [['S1', w.F], ['S2', w.M], ['S3', w.F]] as [string, string][]) await w.person(n, g, sur);
    for (const [n, g] of [['P1', w.M], ['KidP', w.F], ['AdultP', w.F]] as [string, string][]) await w.person(n, g, null);
    const before = new Map((p.q(`SELECT id, room_id FROM ${T('inscriptions')}`) as any[]).map(x => [x.id, x.room_id]));
    const sim = ok(await p.call('post', '/assignment/simulate', { body: { conference_id: w.cid } }), 'simulate');
    // Nothing was written by the simulation.
    for (const x of p.q(`SELECT id, room_id FROM ${T('inscriptions')}`) as any[]) assert.strictEqual(x.room_id, before.get(x.id), 'simulate writes nothing');
    const run = await w.run();
    const placed = (p.q(`SELECT id, room_id FROM ${T('inscriptions')} WHERE room_id IS NOT NULL ORDER BY id`) as any[]).map(x => [x.id, x.room_id]);
    assert.deepStrictEqual(placed, sim.placements.map((x: any) => [x.inscription_id, x.room_id]).sort((a: any, b: any) => a[0] - b[0]));
    for (const k of ['assignedCount', 'remaining', 'violations', 'by_location', 'skipped_unassigned']) assert.deepStrictEqual(run[k], sim[k], k);
});

test('«Sugerir reparto»: shared rooms only where they save one — Norte 3 men 2 women, Sur 1 man 3 women in rooms of 4, 4, 3, 2, 2, 2', async () => {
    const w = await world([['A4', 4], ['B4', 4], ['C3', 3], ['D2', 2], ['E2', 2], ['F2', 2]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    for (let i = 0; i < 3; i++) await w.person(`NM${i}`, w.M, norte);
    for (let i = 0; i < 2; i++) await w.person(`NF${i}`, w.F, norte);
    await w.person('SM0', w.M, sur);
    for (let i = 0; i < 3; i++) await w.person(`SF${i}`, w.F, sur);

    const alone = await w.plan({ share: false });
    assert.deepStrictEqual([alone.totals.rooms, alone.totals.shared, alone.outcome.hard, alone.outcome.unplaced], [4, 0, 0, 0]);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.totals.rooms, plan.totals.empty_beds, plan.totals.shared], [3, 0, 1], JSON.stringify(plan.rooms));
    assert.deepStrictEqual([plan.outcome.hard, plan.outcome.unplaced, plan.outcome.placed, plan.placements.length], [0, 0, 9, 9]);
    const sharedRoom = plan.rooms.find((r: any) => r.after.kind === 'shared');
    assert.deepStrictEqual(sharedRoom.after.shares.map((x: any) => [x.location_id, x.beds]).sort(), [[norte, 3], [sur, 1]].sort());
    for (const l of plan.locations) assert.deepStrictEqual([l.unplaced, l.violations.filter((v: any) => v.hard).length], [0, 0], l.name);
    // Nothing is written until «Aplicar».
    assert.strictEqual((p.q(`SELECT id FROM ${T('rooms')} WHERE location_id IS NOT NULL`) as any[]).length, 0);
    const applied = ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.deepStrictEqual([applied.changed, applied.placed], [3, 9]);
    // Applied: everyone sleeps where the plan said — three full rooms; a run afterwards has nothing to change.
    for (const x of plan.placements) assert.strictEqual(w.roomOf(x.inscription_id), x.room_id);
    assert.deepStrictEqual(Object.values(w.used()).map(([k, c]: any) => c - k), [0, 0, 0], 'three full rooms');
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining, r.assignedCount], [[], 0, 0]);
});

test('a head-count allotment that breaks the rules is replanned: 2 men and 2 women given a room of 4 get two rooms of 2', async () => {
    const w = await world([['A4', 4], ['B2', 2], ['C2', 2]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte');
    for (const [n, g] of [['M0', w.M], ['F0', w.F], ['M1', w.M], ['F1', w.F]] as [string, string][]) await w.person(n, g, norte);
    ok(await p.call('post', `/locations/${norte}/beds`, { body: { beds: 4 } }), 'Dar camas');
    assert.strictEqual(w.ownerOf(w.room.A4), norte, 'by head count: the room of 4');
    // What the run would do with it: two people without a bed of their own (they go to pool beds).
    const sim = ok(await p.call('post', '/assignment/simulate', { body: { conference_id: w.cid } }), 'simulate');
    assert.strictEqual(sim.by_location[0].pool_beds, 2, JSON.stringify(sim.by_location));
    const plan = await w.plan();
    assert.deepStrictEqual(plan.rooms.map((r: any) => [r.room_number, r.after.kind, r.people[0].count]).sort(), [['B2', 'whole', 2], ['C2', 'whole', 2]]);
    assert.deepStrictEqual(plan.released.map((r: any) => r.room_number), ['A4']);
    assert.deepStrictEqual([plan.totals.empty_beds, plan.outcome.hard, plan.locations[0].unplaced], [0, 0, 0]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.deepStrictEqual([w.ownerOf(w.room.A4), w.ownerOf(w.room.B2), w.ownerOf(w.room.C2)], [null, norte, norte]);
    assert.deepStrictEqual(w.used(), { B2: [2, 2], C2: [2, 2] });
    for (const n of ['B2', 'C2']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1, `${n} holds one gender`);
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining], [[], 0]);
});

test('without «rehacer», the allotments made stay; a frozen location is never touched', async () => {
    const w = await world([['A4', 4], ['B2', 2], ['C2', 2], ['D3', 3]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    await w.person('NM0', w.M, norte); await w.person('NM1', w.M, norte);
    await w.person('SF0', w.F, sur); await w.person('SF1', w.F, sur);
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.A4] } }));
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: sur, room_ids: [w.room.D3] } }));
    p.exec(`UPDATE ${T('locations')} SET lodging_status = 'validated' WHERE id = ?`, sur);
    const keep = await w.plan({ replan: false });
    assert.deepStrictEqual(keep.changes, [], 'Norte\'s room of 4 still takes its two people');
    const again = await w.plan();
    assert.deepStrictEqual(again.changes.map((c: any) => c.room_id).sort(), [w.room.A4, w.room.B2].sort(), 'Norte moves to a room of 2; A4 is freed');
    assert.ok(!again.changes.some((c: any) => c.room_id === w.room.D3), 'Sur (validated) keeps its room');
    assert.ok(!again.locations.some((l: any) => l.location_id === sur));
    assert.deepStrictEqual(again.skipped_frozen.map((l: any) => l.location_id), [sur]);
});

test('«Aplicar» writes only the plan the admin saw: anything changed meanwhile is a 409 plan_changed, with the new plan', async () => {
    const w = await world([['A2', 2], ['B2', 2]]);
    const { p } = w;
    const norte = await w.loc('Norte');
    await w.person('N0', w.M, norte); await w.person('N1', w.M, norte);
    const plan = await w.plan();
    await w.person('N2', w.M, norte);
    const stale = await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'plan_changed');
    assert.strictEqual((p.q(`SELECT id FROM ${T('rooms')} WHERE location_id IS NOT NULL`) as any[]).length, 0, 'nothing written');
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: stale.body.plan.token } }), 'the new plan applies');
    // 2.36.6 (option (a)): the full room is Norte's; the half one gives Norte its one bed, the other is a pool bed.
    assert.strictEqual((p.q(`SELECT id FROM ${T('rooms')} WHERE location_id = ?`, norte) as any[]).length, 1);
    assert.deepStrictEqual((p.q(`SELECT location_id, beds FROM ${T('room_beds')}`) as any[]).map(b => [b.location_id, b.beds]), [[norte, 1]]);
    assert.strictEqual((await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid } })).status, 400, 'a token is required');
});

test('the live case: three locations by head count, then «Sugerir reparto» — applied, the rooms are the plan\'s, nobody on pool beds', async () => {
    const w = await world([['101', 2], ['102', 2], ['103', 2], ['104', 3], ['105', 3], ['106', 4], ['107', 4], ['108', 6], ['109', 2], ['110', 4]]);
    const { p } = w;
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }), 'unpublish');
    ok(await p.call('post', '/fields', { body: { conference_id: w.cid, template: 'family_group' } }), 'family field');
    ok(await p.call('post', '/fields', { body: { conference_id: w.cid, label: 'Edad', name: 'edad', type: 'number' } }), 'age field');
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: true } }), 'publish');
    const edad = (p.q(`SELECT name, label FROM ${T('fields')} WHERE conference_id = ?`, w.cid) as any[]).find(x => /edad/i.test(x.label || x.name)).name;
    await w.hardGender();
    await w.rule({ name: 'Familias juntas', type: 'keep_together', config: 'family_group', hard: 0, priority: 5 });
    await w.rule({ name: 'Menor con un adulto', type: 'require_companion', hard: 1, priority: 8,
        params: { subject: [{ field: edad, op: 'lt', value: '14' }], needs: [{ field: edad, op: 'gte', value: '18' }], min: 1 } });
    const loc: Record<string, number> = {};
    for (const n of ['Barranquilla', 'Soledad', 'Malambo']) loc[n] = await w.loc(n);
    const people: [string, string, string, string, number][] = [
        ['Barranquilla', 'Carlos', w.M, 'Pérez', 40], ['Barranquilla', 'Andrés', w.M, 'Pérez', 17], ['Barranquilla', 'Luis', w.M, '', 25], ['Barranquilla', 'Jorge', w.M, '', 33],
        ['Barranquilla', 'Ana', w.F, 'Mora', 38], ['Barranquilla', 'Sofía', w.F, 'Mora', 9], ['Barranquilla', 'Lucía', w.F, '', 22], ['Barranquilla', 'Marta', w.F, '', 51],
        ['Soledad', 'Pedro', w.M, '', 29], ['Soledad', 'Mateo', w.M, '', 31], ['Soledad', 'Elena', w.F, '', 27], ['Soledad', 'Rosa', w.F, '', 44], ['Soledad', 'Julia', w.F, '', 19],
        ['Malambo', 'Diego', w.M, 'Lara', 36], ['Malambo', 'Tomás', w.M, 'Lara', 10], ['Malambo', 'Iván', w.M, '', 23], ['Malambo', 'Clara', w.F, '', 30], ['Malambo', 'Nora', w.F, '', 26],
    ];
    for (const [l, first_name, gender, family_group, age] of people) {
        ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name, gender, family_group, [edad]: String(age), location_id: loc[l] } }), first_name);
    }
    for (const [l, beds] of [['Barranquilla', 8], ['Soledad', 5], ['Malambo', 5]] as [string, number][]) ok(await p.call('post', `/locations/${loc[l]}/beds`, { body: { beds } }), `beds ${l}`);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.outcome.hard, plan.outcome.unplaced, plan.outcome.placed], [0, 0, 18]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    const used = w.used();
    assert.strictEqual(Object.keys(used).length, plan.totals.rooms, `the plan's rooms: ${JSON.stringify(used)}`);
    assert.strictEqual(Object.values(used).reduce((n: number, [k, c]: any) => n + c - k, 0), plan.totals.empty_beds);
    for (const n of Object.keys(used)) assert.strictEqual(w.gendersIn(w.room[n]).size, 1, `${n} holds one gender`);
    // Nobody sits on a bed of a room their location has no beds in.
    for (const x of p.q(`SELECT i.location_id, i.room_id, r.location_id AS owner FROM ${T('inscriptions')} i JOIN ${T('rooms')} r ON r.id = i.room_id`) as any[]) {
        const share = p.one(`SELECT beds FROM ${T('room_beds')} WHERE room_id = ? AND location_id = ?`, x.room_id, x.location_id);
        assert.ok(x.owner === x.location_id || (share && share.beds > 0), JSON.stringify(x));
    }
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining, r.assignedCount], [[], 0, 0]);
});

// ── the review's cases (wf_ea2df50c-bcd): never worse than 2.19, every hard rule kept ─────────────────────────
/** Add form fields (templates, or { label, name, type }) — fields go in while the form is unpublished. */
async function addFields(w: any, ...defs: any[]) {
    ok(await w.p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }), 'unpublish');
    for (const d of defs) ok(await w.p.call('post', '/fields', { body: { conference_id: w.cid, ...(typeof d === 'string' ? { template: d } : d) } }), JSON.stringify(d));
    ok(await w.p.call('post', '/publish', { body: { conference_id: w.cid, published: true } }), 'publish');
}
const personF = async (w: any, body: any) => ok(await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, ...body } }), body.first_name).id as number;
const kidRule = (w: any, hard: number) => w.rule({ name: 'Niño con adulto', type: 'require_companion', hard, priority: 5,
    params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });

test('review: a hard family that outranks the gender rule keeps its room — loners do not take it first', async () => {
    const w = await world([['A4', 4], ['B2', 2], ['C2', 2]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 10 });
    const fam = [];
    for (const [n, g] of [['PM1', w.M], ['PM2', w.M], ['PF1', w.F], ['PF2', w.F]] as [string, string][]) fam.push(await personF(w, { first_name: n, gender: g, family_group: 'Perez' }));
    for (let i = 0; i < 4; i++) await personF(w, { first_name: `S${i}`, gender: w.M });
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining], [[], 0]);
    assert.strictEqual(new Set(fam.map(w.roomOf)).size, 1, 'the family in one room');
    assert.strictEqual(w.roomOf(fam[0]), w.room.A4);
});

test('review: short of beds, a run never leaves more people without a bed than 2.19 did', async () => {
    const a = await world([['A3', 3], ['B3', 3]]);
    await a.hardGender();
    for (let i = 0; i < 3; i++) await a.person(`M${i}`, a.M);
    for (let i = 0; i < 4; i++) await a.person(`W${i}`, a.F);
    const ra = await a.run();
    assert.deepStrictEqual([hardOf(ra), ra.remaining], [[{ rule: 'capacidad', detail: '1 inscrito quedó sin cupo — faltan habitaciones.', hard: true }], 1]);
    const b = await world([['A2', 2], ['B2', 2]]);
    await b.hardGender();
    for (const [n, g] of [['M1', b.M], ['F1', b.F], ['M2', b.M], ['F2', b.F], ['M3', b.M]] as [string, string][]) await b.person(n, g);
    assert.strictEqual((await b.run()).remaining, 1);
});

test('review: a companion bundled with a child never rides into a room the hard rules forbid it', async () => {
    const w = await world([['A2', 2], ['B1', 1]]);
    await w.hardGender();
    await kidRule(w, 1);
    const man = await w.person('M0', w.M);
    ok(await w.p.call('post', `/inscriptions/${man}/assign`, { body: { room_id: w.room.A2 } }), 'manual');
    const kidX = await w.person('KidX', w.M);
    w.p.exec(`UPDATE ${T('inscriptions')} SET gender = NULL WHERE id = ?`, kidX); // a legacy row: no gender
    const adultF = await w.person('AdultF', w.F);
    const r = await w.run();
    assert.ok(!w.gendersIn(w.room.A2).has(w.F), `no woman next to the man: ${JSON.stringify(w.used())}`);
    assert.ok(w.roomOf(adultF) !== w.room.A2);
    assert.ok(!r.violations.some((v: any) => v.hard && /género/.test(v.rule)), JSON.stringify(r.violations));
});

test('review: a companion is bundled only while the group still fits a room — a hard family is not split for it', async () => {
    const w = await world([['A3', 3], ['B3', 3], ['C2', 2]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 30 });
    await w.rule({ name: 'Dividir por género', type: 'split_by', config: 'gender', hard: 0, priority: 20 });
    await kidRule(w, 0);
    const fam = [];
    for (const [n, g] of [['KidM1', w.M], ['KidM2', w.M], ['KidF', w.F]] as [string, string][]) fam.push(await personF(w, { first_name: n, gender: g, family_group: 'Ruiz' }));
    await w.person('AdultM', w.M);
    const r = await w.run();
    assert.deepStrictEqual(hardOf(r), []);
    assert.strictEqual(new Set(fam.map(w.roomOf)).size, 1, 'the family whole');
});

test('review: the class with the largest indivisible group gets its room first', async () => {
    const w = await world([['A4', 4], ['B2', 2], ['C2', 2], ['D1', 1]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 20 });
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 10 });
    const garcia = [];
    for (let i = 0; i < 4; i++) garcia.push(await personF(w, { first_name: `G${i}`, gender: w.F, family_group: 'Garcia' }));
    for (const [n, f] of [['P1', 'Perez'], ['P2', 'Perez'], ['L1', 'Lopez'], ['L2', 'Lopez'], ['Solo', '']] as [string, string][]) await personF(w, { first_name: n, gender: w.M, family_group: f });
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining], [[], 0]);
    assert.deepStrictEqual([...new Set(garcia.map(w.roomOf))], [w.room.A4]);
});

test('review: a soft rule is kept when keeping it costs no room and no bed', async () => {
    const w = await world([['B2', 2], ['C2', 2]]);
    await w.rule({ name: 'Preferir separar por género', type: 'separate_by', config: 'gender', hard: 0 });
    for (const [n, g] of [['M0', w.M], ['F0', w.F], ['M1', w.M], ['F1', w.F]] as [string, string][]) await w.person(n, g);
    const r = await w.run();
    for (const n of ['B2', 'C2']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1, `${n} holds one gender`);
    assert.deepStrictEqual(r.violations.filter((v: any) => v.rule === 'Preferir separar por género'), []);
});

test('review: lodging-pack finds the exact fill Best Fit misses', () => {
    const items = [5, 4, 4, 3, 3, 3].map(size => ({ size }));
    const rooms = [5, 7, 1, 7, 8, 2].map(free => ({ free }));
    const r = pack.packNew(items, rooms, () => true);
    assert.strictEqual(r.left.length, 0);
    assert.strictEqual(new Set(r.placed.map(([, b]: any) => b)).size, 3, 'three rooms: 8 = 5+3, 7 = 4+3, 7 = 4+3');
});

test('review: /assignment/simulate also lists the people the run MOVES (the hard companion repair)', async () => {
    const w = await world([['A2', 2], ['B2', 2]]);
    const { p } = w;
    await kidRule(w, 1);
    const norte = await w.loc('Norte');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.A2, w.room.B2] } }));
    const kid = await w.person('Kid', w.M, norte), adult = await w.person('Adult', w.M, norte);
    ok(await p.call('post', `/inscriptions/${kid}/assign`, { body: { room_id: w.room.A2 } }));
    ok(await p.call('post', `/inscriptions/${adult}/assign`, { body: { room_id: w.room.B2 } }));
    const sim = ok(await p.call('post', '/assignment/simulate', { body: { conference_id: w.cid } }), 'simulate');
    assert.deepStrictEqual(sim.placements, [{ inscription_id: adult, room_id: w.room.A2, from_room_id: w.room.B2 }]);
    await w.run();
    assert.strictEqual(w.roomOf(adult), w.room.A2);
});

test('review «Sugerir reparto»: a child kept with its adult — the probe never leaves a group divided in a kept room', async () => {
    const w = await world([['A3', 3], ['B2', 2]]);
    const { p } = w;
    await w.hardGender();
    await kidRule(w, 1);
    const norte = await w.loc('Norte');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.A3] } }));
    for (const n of ['M1', 'M2']) { const id = await w.person(n, w.M, norte); ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room.A3 } })); }
    const kid = await w.person('KidM', w.M, norte), adult = await w.person('AdultM', w.M, norte);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.outcome.hard, plan.outcome.unplaced, plan.worse], [0, 0, false]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.strictEqual(w.roomOf(kid), w.roomOf(adult));
});

test('review «Sugerir reparto»: free beds in a room that already holds people come before a new room', async () => {
    const w = await world([['P4', 4], ['X3', 3]]);
    const { p } = w;
    await w.hardGender();
    const p0 = await w.person('P0', w.M);
    ok(await p.call('post', `/inscriptions/${p0}/assign`, { body: { room_id: w.room.P4 } }));
    const norte = await w.loc('Norte');
    for (let i = 0; i < 3; i++) await w.person(`N${i}`, w.M, norte);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.after.rooms, plan.after.empty_beds, plan.after.unplaced, plan.worse], [1, 0, 0, false]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.deepStrictEqual(w.used(), { P4: [4, 4] });
    assert.deepStrictEqual(w.shares(w.room.P4).map((x: any) => [x.location_id, x.beds]), [[norte, 3]]);
});

test('review «Sugerir reparto»: people with no value for the hard field fill the beds the others left', async () => {
    const w = await world([['A4', 4], ['B2', 2]]);
    await w.hardGender();
    const norte = await w.loc('Norte');
    for (let i = 0; i < 3; i++) await w.person(`M${i}`, w.M, norte);
    const blank = await w.person('Blank', w.M, norte);
    w.p.exec(`UPDATE ${T('inscriptions')} SET gender = NULL WHERE id = ?`, blank); // a legacy row: no gender
    const plan = await w.plan();
    assert.deepStrictEqual([plan.totals.rooms, plan.totals.empty_beds, plan.outcome.hard], [1, 0, 0]);
});

test('review «Sugerir reparto»: a location\'s own family rule counts in a shared room, as in a run', async () => {
    const w = await world([['S4', 4]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    ok(await p.call('put', `/rooms/${w.room.S4}/beds`, { body: { shares: [{ location_id: norte, beds: 2 }, { location_id: sur, beds: 2 }] } }));
    p.exec(`INSERT INTO ${T('assignment_rules')} (conference_id, location_id, name, type, config, params, enabled, priority, hard) VALUES (?, ?, 'Familia Norte', 'keep_together', 'family_group', '{}', 1, 20, 1)`, w.cid, norte);
    await personF(w, { first_name: 'Papa', gender: w.M, family_group: 'X', location_id: norte });
    await personF(w, { first_name: 'Mama', gender: w.F, family_group: 'X', location_id: norte });
    const plan = await w.plan({ replan: false });
    assert.strictEqual(plan.outcome.hard, 0, JSON.stringify(plan.outcome.violations));
});

test('review «Sugerir reparto»: never worse than today — a child already placed gets its adult, beds beside people come first', async () => {
    const w = await world([['A2', 2], ['B1', 1]]);
    const { p } = w;
    await kidRule(w, 1);
    const norte = await w.loc('Norte');
    const kid = await w.person('Kid', w.M, norte), adult = await w.person('Adult', w.M, norte);
    ok(await p.call('post', `/inscriptions/${kid}/assign`, { body: { room_id: w.room.A2 } }));
    const plan = await w.plan();
    assert.strictEqual(plan.worse, false);
    assert.ok(plan.after.hard <= plan.current.hard && plan.after.unplaced <= plan.current.unplaced, JSON.stringify([plan.current, plan.after]));
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.strictEqual(w.roomOf(adult), w.room.A2);
    const w2 = await world([['A3', 3], ['B2', 2]]);
    await w2.hardGender();
    const n2 = await w2.loc('Norte');
    const f0 = await w2.person('F0', w2.F, n2);
    ok(await w2.p.call('post', `/inscriptions/${f0}/assign`, { body: { room_id: w2.room.A3 } }));
    for (const [n, g] of [['F1', w2.F], ['F2', w2.F], ['M1', w2.M], ['M2', w2.M]] as [string, string][]) await w2.person(n, g, n2);
    const plan2 = await w2.plan();
    assert.deepStrictEqual([plan2.after.unplaced, plan2.after.rooms, plan2.after.hard, plan2.worse], [0, 2, 0, false]);
});

test('review «Sugerir reparto»: a location with nobody waiting keeps its rooms; nothing to suggest, nothing to apply', async () => {
    const w = await world([['A4', 4]]);
    const { p } = w;
    const norte = await w.loc('Norte');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.A4] } }));
    const plan = await w.plan();
    assert.deepStrictEqual([plan.people, plan.changes.length, plan.released.length], [0, 0, 0]);
    assert.strictEqual(w.ownerOf(w.room.A4), norte);
});

// ── the fuzz's cases (wf_41d08342-e12): the companion repair keeps the donor room's rules; the sweep as a whole is
//    never worse than 2.19; the plan never overfills a room and gives a child's free bed to its adult ──────────
/** A room whose people of differing gender are not all explained by a shared family (what a hard gender rule judges). */
const unexplainedMix = (w: any, roomId: number) => {
    const occ = w.p.q(`SELECT gender, family_group FROM ${T('inscriptions')} WHERE room_id = ?`, roomId) as any[];
    const judged = occ.filter(o => !(o.family_group && occ.some(x => x !== o && x.family_group === o.family_group)));
    return new Set(judged.map(o => o.gender).filter((g: any) => g != null && g !== '')).size > 1;
};

test('fuzz: the hard companion repair never leaves the room it takes an adult from mixed', async () => {
    const w = await world([['R00', 4], ['R01', 3]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 6 });
    await kidRule(w, 1);
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 0, priority: 10 });
    await personF(w, { first_name: 'Adult0', gender: w.F, family_group: 'Lopez' });
    await personF(w, { first_name: 'Adult4', gender: w.F, family_group: 'Mora' });
    await personF(w, { first_name: 'Adult2', gender: w.M });
    const p3 = await personF(w, { first_name: 'P3', gender: w.M, family_group: 'Ruiz' });
    w.p.exec(`UPDATE ${T('inscriptions')} SET gender = NULL WHERE id = ?`, p3);
    await personF(w, { first_name: 'P5', gender: w.M, family_group: 'Lopez' });
    await personF(w, { first_name: 'Kid1', gender: w.F });
    await w.run();
    for (const n of ['R00', 'R01']) assert.ok(!unexplainedMix(w, w.room[n]), `${n}: ${JSON.stringify(w.p.q(`SELECT first_name, gender, family_group FROM ${T('inscriptions')} WHERE room_id = ?`, w.room[n]))}`);
});

test('fuzz: the hard companion repair never takes someone away from their hard family', async () => {
    const w = await world([['R00', 4], ['R01', 4]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 10 });
    await w.rule({ name: 'Niño con adulto', type: 'require_companion', hard: 1, priority: 30,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });
    const adult2 = await personF(w, { first_name: 'Adult2', gender: w.M, family_group: 'Perez' });
    await personF(w, { first_name: 'P5', gender: w.M });
    const p4 = await personF(w, { first_name: 'P4', gender: w.M, family_group: 'Perez' });
    await personF(w, { first_name: 'Adult1', gender: w.M, family_group: 'Ruiz' });
    await personF(w, { first_name: 'Kid3', gender: w.M });
    await personF(w, { first_name: 'P0', gender: w.F, family_group: 'Lopez' });
    await w.run();
    if (w.roomOf(adult2) != null && w.roomOf(p4) != null) assert.strictEqual(w.roomOf(adult2), w.roomOf(p4), 'the Perez family stays together');
});

test('fuzz: the sweep is judged as a whole — a location\'s best alone never strands its people in the overflow', async () => {
    const w = await world([['R00', 4], ['R01', 6]]);
    const { p } = w;
    await w.hardGender();
    const l0 = await w.loc('L0');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: l0, room_ids: [w.room.R00] } }));
    for (const [n, g] of [['P4', w.M], ['Kid1', w.M], ['P3', w.F], ['P6', w.F], ['Kid0', w.F], ['Kid5', w.F], ['P2', w.F]] as [string, string][]) await w.person(n, g, l0);
    const sim = ok(await p.call('post', '/assignment/simulate', { body: { conference_id: w.cid } }), 'simulate');
    const r = await w.run();
    assert.deepStrictEqual([r.remaining, hardOf(r)], [0, []]);
    assert.deepStrictEqual([sim.remaining, sim.assignedCount], [r.remaining, r.assignedCount]);
    for (const n of ['R00', 'R01']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1);
});

test('fuzz «Sugerir reparto»: «Aplicar» never puts more people in a room than its beds (the probe moves nobody)', async () => {
    const w = await world([['R1', 2], ['R2', 3], ['R3', 4]]);
    const { p } = w;
    await kidRule(w, 1);
    const kid = await w.person('Kid', w.M), a1 = await w.person('AdultP1', w.M), a3 = await w.person('AdultP3', w.M);
    ok(await p.call('post', `/inscriptions/${kid}/assign`, { body: { room_id: w.room.R2 } }));
    ok(await p.call('post', `/inscriptions/${a1}/assign`, { body: { room_id: w.room.R1 } }));
    ok(await p.call('post', `/inscriptions/${a3}/assign`, { body: { room_id: w.room.R1 } }));
    const norte = await w.loc('Norte');
    await w.person('AdultA1', w.M, norte); await w.person('AdultA2', w.M, norte);
    const plan = await w.plan();
    if (!plan.worse) ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    for (const [n, [k, c]] of Object.entries(w.used()) as [string, [number, number]][]) assert.ok(k <= c, `${n}: ${k} people in ${c} beds`);
});

test('fuzz «Sugerir reparto»: the free bed next to a child already placed goes to the adult it needs', async () => {
    const w = await world([['K2', 2], ['X2', 2]]);
    const { p } = w;
    await kidRule(w, 1);
    const kid = await w.person('Kid', w.M);
    ok(await p.call('post', `/inscriptions/${kid}/assign`, { body: { room_id: w.room.K2 } }));
    await w.person('P1', w.M);
    const adult = await w.person('AdultA', w.M);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.after.hard, plan.worse], [0, false]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.strictEqual(w.roomOf(adult), w.room.K2);
});

// ── the confirmation fuzz's cases (wf_7a78357e-e59) ──────────────────────────────────────────────────────────
const noGender = (w: any, id: number) => w.p.exec(`UPDATE ${T('inscriptions')} SET gender = NULL WHERE id = ?`, id);
const adultsWith = (w: any, kid: number) => (w.p.q(`SELECT first_name FROM ${T('inscriptions')} WHERE room_id = ? AND id != ?`, w.roomOf(kid), kid) as any[]).some(x => /Adult/.test(x.first_name));

test('confirm: a family already divided still lends an adult to a child alone (the repair is not blocked)', async () => {
    const w = await world([['A4', 4], ['B2', 2], ['K2', 2]]);
    await addFields(w, 'family_group');
    await w.rule({ name: 'Preferir separar por género', type: 'separate_by', config: 'gender', hard: 0, priority: 11 });
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 10 });
    await w.rule({ name: 'Niño con adulto', type: 'require_companion', hard: 1, priority: 2,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });
    for (const n of ['Kid4', 'Adult0', 'P5', 'Adult1', 'P3']) await personF(w, { first_name: n, gender: w.M, family_group: 'Lara' });
    const kid = await w.person('Kid9', w.M);
    ok(await w.p.call('post', `/inscriptions/${kid}/assign`, { body: { room_id: w.room.K2 } }));
    await w.run();
    assert.ok(adultsWith(w, kid), `Kid9 has an adult: ${JSON.stringify(w.used())}`);
});

test('confirm: an adult a hard gender block already keeps apart from its family may go to a child', async () => {
    const w = await world([['R1', 2], ['R2', 3]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 11 });
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 10 });
    await w.rule({ name: 'Niño con adulto', type: 'require_companion', hard: 1, priority: 30,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } });
    const a3 = await personF(w, { first_name: 'Adult3', gender: w.M, family_group: 'Ruiz' });
    const a1 = await personF(w, { first_name: 'Adult1', gender: w.M, family_group: 'Ruiz' });
    noGender(w, a1);
    const kid = await personF(w, { first_name: 'Kid5', gender: w.F });
    const p4 = await personF(w, { first_name: 'P4', gender: w.F, family_group: 'Ruiz' });
    for (const [id, room] of [[a3, w.room.R1], [a1, w.room.R1], [kid, w.room.R2], [p4, w.room.R2]] as [number, number][]) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: room } }));
    const r = await w.run();
    assert.ok(adultsWith(w, kid), JSON.stringify(w.used()));
    assert.deepStrictEqual(hardOf(r), []);
});

test('confirm: a location\'s rooms are walked hotel by hotel, as 2.19 did — nobody left without a bed', async () => {
    const p: Plugin = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `plan-h-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'gender' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const [M, F] = (p.one(`SELECT options FROM ${T('fields')} WHERE conference_id = ? AND name = 'gender'`, cid).options as string).split(',').map(x => x.trim());
    ok(await p.call('post', '/assignment/rules', { body: { conference_id: cid, name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, enabled: 1, priority: 10 } }));
    const h0 = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'H0' } })).id, h1 = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'H1' } })).id;
    const room = async (hotel_id: number, room_number: string, capacity: number) => ok(await p.call('post', '/rooms', { body: { hotel_id, room_number, capacity } })).id as number;
    const r0 = await room(h1, 'R0', 6), r1 = await room(h0, 'R1', 1), r2 = await room(h0, 'R2', 5);
    const loc = async (name: string) => ok(await p.call('post', '/locations', { body: { conference_id: cid, name, capacity: 50 } })).id as number;
    const l0 = await loc('L0'), l1 = await loc('L1'); await loc('L2'); const l3 = await loc('L3');
    ok(await p.call('put', `/rooms/${r0}/beds`, { body: { shares: [{ location_id: l0, beds: 1 }, { location_id: l1, beds: 3 }, { location_id: l3, beds: 2 }] } }));
    ok(await p.call('post', `/hotels/${h0}/allot`, { body: { location_id: l0, room_ids: [r1] } }));
    ok(await p.call('put', `/rooms/${r2}/beds`, { body: { shares: [{ location_id: l0, beds: 3 }] } }));
    for (const [first_name, gender, location_id] of [['Adult1', F, l0], ['Adult3', M, l0], ['Adult7', M, l1], ['Kid8', M, l1], ['Adult15', M, l3]] as [string, string, number][]) {
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, gender, location_id } }), first_name);
    }
    const r = ok(await p.call('post', '/assignment/run', { body: { conference_id: cid } }), 'run');
    assert.deepStrictEqual([r.remaining, hardOf(r)], [0, []]);
});

test('confirm: a hard family is not taken apart from a relative already in a room (the sweep counts divided families)', async () => {
    const w = await world([['1', 4], ['3', 5]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await w.hardGender();
    const loc0 = await w.loc('Loc0');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: loc0, room_ids: [w.room['1'], w.room['3']] } }));
    const p7 = await personF(w, { first_name: 'P7', gender: w.F, family_group: 'Vega', location_id: loc0 });
    const kid0 = await personF(w, { first_name: 'Kid0', gender: w.F, location_id: loc0 });
    const p3 = await personF(w, { first_name: 'P3', gender: w.F, location_id: loc0 });
    for (const [id, room] of [[p7, w.room['1']], [kid0, w.room['1']], [p3, w.room['3']]] as [number, number][]) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: room } }));
    const p9 = await personF(w, { first_name: 'P9', gender: w.F, family_group: 'Vega', location_id: loc0 });
    const a1 = await personF(w, { first_name: 'Adult1', gender: w.F, family_group: 'Vega', location_id: loc0 });
    noGender(w, p9); noGender(w, a1);
    for (const n of ['P4', 'P5', 'Kid8']) await personF(w, { first_name: n, gender: w.F, location_id: loc0 });
    await w.run();
    assert.strictEqual(new Set([p7, p9, a1].map(w.roomOf)).size, 1, `the Vega family in one room: ${JSON.stringify([p7, p9, a1].map(w.roomOf))}`);
});

test('confirm «Sugerir reparto»: a plan that would divide a hard family kept together today is never applied', async () => {
    const w = await world([['X3', 3], ['A2', 2], ['B2', 2]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    const norte = await w.loc('Norte');
    const f1 = await personF(w, { first_name: 'F1', gender: w.M, family_group: 'Perez', location_id: norte });
    ok(await p.call('post', `/inscriptions/${f1}/assign`, { body: { room_id: w.room.X3 } }));
    const f2 = await personF(w, { first_name: 'F2', gender: w.M, family_group: 'Perez', location_id: norte });
    const f3 = await personF(w, { first_name: 'F3', gender: w.M, family_group: 'Perez', location_id: norte });
    const alone = await w.plan({ share: false });
    // Without sharing, Norte's two would go to a room of their own, away from F1: counted, so worse than today.
    assert.deepStrictEqual([alone.after.hard, alone.worse], [1, true], JSON.stringify([alone.current, alone.after]));
    assert.strictEqual((await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: alone.token, share: false } })).status, 409);
    const shared = await w.plan();
    assert.deepStrictEqual([shared.after.hard, shared.worse], [0, false]);
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: shared.token } }), 'apply');
    assert.strictEqual(new Set([f1, f2, f3].map(w.roomOf)).size, 1, 'the family together');
});

// ── the final fuzz's cases (wf_53d8d591-22e): 'legacy' is 2.19 exactly, so the sweep is never worse ───────────
test('final: a pool family\'s leftover never takes the last pool bed a location\'s overflow needed (2.19 placed everyone)', async () => {
    const w = await world([['B4', 4], ['C2', 2], ['L1', 1]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 10 });
    const oeste = await w.loc('Oeste');
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: oeste, room_ids: [w.room.L1] } }));
    const wpool = await w.person('Wpool', w.F), moeste = await w.person('Moeste', w.M, oeste);
    ok(await p.call('post', `/inscriptions/${wpool}/assign`, { body: { room_id: w.room.B4 } }));
    ok(await p.call('post', `/inscriptions/${moeste}/assign`, { body: { room_id: w.room.L1 } }));
    await w.person('Woeste', w.F, oeste);
    for (const [n, g] of [['M1', w.M], ['F1', w.F], ['F2', w.F], ['M2', w.M]] as [string, string][]) await personF(w, { first_name: n, gender: g, family_group: 'X' });
    const r = await w.run();
    assert.strictEqual(r.remaining, 0, JSON.stringify(w.used()));
});

test('final: a hard family that fits none of its location\'s rooms goes whole to the pool, as in 2.19', async () => {
    const w = await world([['S4', 4], ['P4', 4]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await w.rule({ name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1, priority: 5 });
    const sur = await w.loc('Sur');
    ok(await p.call('put', `/rooms/${w.room.S4}/beds`, { body: { shares: [{ location_id: sur, beds: 3 }] } }));
    const wpool = await w.person('Wpool', w.F);
    ok(await p.call('post', `/inscriptions/${wpool}/assign`, { body: { room_id: w.room.S4 } }));
    const fam = [];
    for (const [n, g] of [['M1', w.M], ['M2', w.M], ['F1', w.F], ['M3', w.M]] as [string, string][]) fam.push(await personF(w, { first_name: n, gender: g, family_group: 'X', location_id: sur }));
    const r = await w.run();
    assert.deepStrictEqual([hardOf(r), r.remaining], [[], 0]);
    assert.strictEqual(new Set(fam.map(w.roomOf)).size, 1, 'the family whole');
});

test('final: two children alone each get an adult, as 2.19 did, even if the adults\' family is then divided once', async () => {
    const w = await world([['K1', 2], ['K2', 2], ['F3', 3]]);
    const { p } = w;
    await addFields(w, 'family_group');
    await w.rule({ name: 'Familia', type: 'keep_together', config: 'family_group', hard: 1, priority: 20 });
    await kidRule(w, 1);
    const k1 = await w.person('Kid1', w.M), k2 = await w.person('Kid2', w.M);
    ok(await p.call('post', `/inscriptions/${k1}/assign`, { body: { room_id: w.room.K1 } }));
    ok(await p.call('post', `/inscriptions/${k2}/assign`, { body: { room_id: w.room.K2 } }));
    for (const n of ['Adult1', 'Adult2', 'Adult3']) await personF(w, { first_name: n, gender: w.M, family_group: 'Lara' });
    await w.run();
    assert.ok(adultsWith(w, k1) && adultsWith(w, k2), JSON.stringify(w.used()));
});

test('final «Sugerir reparto»: a registration the plan would leave to the run still changes the plan (409 plan_changed)', async () => {
    const w = await world([['A2', 2]]);
    const { p } = w;
    const norte = await w.loc('Norte');
    await w.person('N0', w.M, norte); await w.person('N1', w.M, norte);
    const plan = await w.plan();
    await w.person('Late', w.M);
    const r = await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'plan_changed']);
});

// ── beds short: location by location, in order (2.21.0; the owner: «en orden por localidad») ─────────────
test('beds short: the locations get beds in order (the Localidades list), the first everything it needs; the order can be changed', async () => {
    const w = await world([['R1', 4], ['R2', 4], ['R3', 4]]);
    await w.hardGender();
    // Name order Alfa, Beta, Gama; Gama is the biggest (2.20 gave the biggest location first).
    const alfa = await w.loc('Alfa'), beta = await w.loc('Beta'), gama = await w.loc('Gama');
    for (let i = 0; i < 4; i++) await w.person(`A${i}`, w.F, alfa);
    for (let i = 0; i < 6; i++) await w.person(`B${i}`, w.M, beta);
    for (let i = 0; i < 9; i++) await w.person(`G${i}`, w.F, gama);
    const plan = await w.plan();
    assert.deepStrictEqual(plan.short, { people: 19, beds: 12 });
    assert.deepStrictEqual(plan.order.map((o: any) => o.name), ['Alfa', 'Beta', 'Gama']);
    const out = (p: any) => Object.fromEntries(p.locations.map((l: any) => [l.name, l.unplaced]));
    // Alfa its room; Beta the one it fills (4 men), not a second with 2 empty beds Gama's women cannot use — Gama takes it whole.
    assert.deepStrictEqual(out(plan), { Alfa: 0, Beta: 2, Gama: 5 });
    assert.strictEqual(plan.worse, false);

    // Gama first, then Alfa: Gama takes two full rooms, Alfa the third; Beta none.
    ok(await w.p.call('post', '/assignment/location-order', { body: { conference_id: w.cid, location_ids: [gama, alfa] } }), 'order');
    const again = await w.plan();
    assert.deepStrictEqual(again.order.map((o: any) => o.name), ['Gama', 'Alfa', 'Beta'], 'the ones left out go after, by name');
    assert.deepStrictEqual(out(again), { Gama: 1, Alfa: 0, Beta: 6 });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: again.token } }), 'apply');
    assert.strictEqual((w.p.q(`SELECT id FROM ${T('inscriptions')} WHERE location_id = ? AND room_id IS NOT NULL`, gama) as any[]).length, 8);

    // The order route: a location of another conference, or not a list, is refused.
    assert.strictEqual((await w.p.call('post', '/assignment/location-order', { body: { conference_id: w.cid, location_ids: [999] } })).status, 400);
    assert.strictEqual((await w.p.call('post', '/assignment/location-order', { body: { conference_id: w.cid, location_ids: 'x' } })).status, 400);
});

test('beds short: a location fills whole rooms first — no bed left empty while its people wait', async () => {
    const w = await world([['R1', 4], ['R2', 4]]);
    await w.hardGender();
    const alfa = await w.loc('Alfa');
    for (let i = 0; i < 5; i++) await w.person(`W${i}`, w.F, alfa);
    for (let i = 0; i < 5; i++) await w.person(`M${i}`, w.M, alfa);
    const plan = await w.plan();
    assert.deepStrictEqual([plan.totals.beds, plan.totals.empty_beds, plan.locations[0].unplaced], [8, 0, 2], '4 women + 4 men, not 5 women in two rooms');
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.deepStrictEqual(w.used(), { R1: [4, 4], R2: [4, 4] });
    for (const n of ['R1', 'R2']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1, `${n} holds one gender`);
});

test('a hard «mantener juntos» group bigger than every room (by gender) no longer leaves every location without rooms', async () => {
    const w = await world([['R1', 4], ['R2', 4], ['R3', 4], ['R4', 4]]);
    // The owner's configuration: «Mismo genero» = keep_together by gender, hard (all the women in ONE room).
    await w.rule({ name: 'Mismo genero', type: 'keep_together', config: 'gender', hard: 1, priority: 50 });
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    for (let i = 0; i < 6; i++) await w.person(`NW${i}`, w.F, norte);
    for (let i = 0; i < 2; i++) await w.person(`NM${i}`, w.M, norte);
    for (let i = 0; i < 5; i++) await w.person(`SW${i}`, w.F, sur);
    const plan = await w.plan();
    assert.ok(plan.rooms.length > 0, 'rooms are given');
    assert.deepStrictEqual(plan.oversized.map((o: any) => [o.rule, o.value]), [['Mismo genero', w.F]]);
    assert.strictEqual(plan.worse, false);
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.strictEqual((w.p.q(`SELECT id FROM ${T('inscriptions')} WHERE room_id IS NULL`) as any[]).length, 0, 'everyone has a bed (13 people, 16 beds)');
});

test('beds short: the first location takes the rooms it fills with the MOST beds, not the small ones Best Fit reaches first', async () => {
    // The lab case: rooms of 2, 2, 4, 2, 4; Alfa 5 + 5, Beta 4 + 4, Gama 6 + 6 — 14 beds for 32 people.
    const w = await world([['D1', 2], ['D2', 2], ['Q1', 4], ['D3', 2], ['Q2', 4]]);
    await w.hardGender();
    const alfa = await w.loc('Alfa'), beta = await w.loc('Beta'), gama = await w.loc('Gama');
    for (const [loc, n, tag] of [[alfa, 5, 'A'], [beta, 4, 'B'], [gama, 6, 'G']] as [number, number, string][]) {
        for (let i = 0; i < n; i++) { await w.person(`${tag}W${i}`, w.F, loc); await w.person(`${tag}M${i}`, w.M, loc); }
    }
    const plan = await w.plan();
    const out = Object.fromEntries(plan.locations.map((l: any) => [l.name, l.unplaced]));
    assert.deepStrictEqual(out, { Alfa: 2, Beta: 2, Gama: 12 }, 'Alfa the two rooms of 4 (8 beds), Beta the three of 2');
    assert.deepStrictEqual([plan.totals.beds, plan.totals.empty_beds, plan.worse], [14, 0, false]);
    // lodging-pack: the sets people FILL — the most beds, then the fewest rooms.
    assert.deepStrictEqual(pack.fillSets([2, 2, 4, 2, 4], 5), [[2], [0]]);
    assert.deepStrictEqual(pack.fillSets([4, 4, 4], 9), [[0, 1], [0]]);
    assert.deepStrictEqual(pack.fillSets([3, 3], 1), []);
});

test('«Rehacer todo el reparto»: after a plan was applied and a rule added, the arrangement is thought again — people move; a submitted location is not touched', async () => {
    const w = await world([['R1', 4], ['R2', 4], ['R3', 2]]);
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    const nor = [];
    for (let i = 0; i < 2; i++) { nor.push(await w.person(`NW${i}`, w.F, norte)); nor.push(await w.person(`NM${i}`, w.M, norte)); }
    // Sur: a woman and a man in R3, and its arrangement submitted (frozen).
    const sw = await w.person('SW', w.F, sur), sm = await w.person('SM', w.M, sur);
    for (const id of [sw, sm]) ok(await w.p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room.R3 } }), 'sur');
    w.p.exec(`UPDATE ${T('locations')} SET lodging_status = 'submitted' WHERE id = ?`, sur);

    // No rule yet: Norte's four in one room of 4.
    const first = await w.plan();
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: first.token } }), 'first apply');
    assert.strictEqual(new Set(nor.map(w.roomOf)).size, 1);

    // The owner adds a rule, and «Sugerir reparto» again: nobody waits, nothing to suggest…
    await w.hardGender();
    assert.strictEqual((await w.plan()).people, 0, 'without «Rehacer todo» nobody with a bed is moved');
    // …unless the whole arrangement is thought again.
    const fresh = await w.plan({ fresh: true });
    assert.ok(fresh.current.hard > 0, 'today breaks the new rule');
    assert.deepStrictEqual([fresh.after.hard, fresh.after.unplaced, fresh.worse], [0, 0, false]);
    assert.strictEqual(fresh.moved, 2, 'two of the four change rooms');
    assert.deepStrictEqual(fresh.skipped_frozen.map((l: any) => l.name), ['Sur']);
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: fresh.token, fresh: true } }), 'fresh apply');
    for (const id of nor) assert.strictEqual(w.gendersIn(w.roomOf(id)).size, 1, 'men and women apart');
    assert.deepStrictEqual([w.roomOf(sw), w.roomOf(sm)], [w.room.R3, w.room.R3], 'the submitted location keeps its arrangement');
    // The token covers who moves: a plan made without «Rehacer todo» is not the one applied with it.
    const plain = await w.plan();
    assert.strictEqual((await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plain.token, fresh: true } })).status, 409);
});

test('«Sugerir reparto» lists every location: one with everyone in a bed stays listed (with the hard rules it breaks today) and keeps its place in the order', async () => {
    const w = await world([['R1', 4], ['R2', 4], ['R3', 4]]);
    const bq = await w.loc('Barranquilla'), ct = await w.loc('Cartagena');
    for (let i = 0; i < 2; i++) { await w.person(`BW${i}`, w.F, bq); await w.person(`BM${i}`, w.M, bq); }
    for (let i = 0; i < 3; i++) await w.person(`CW${i}`, w.F, ct);
    // No rule yet: Barranquilla's four in one room; Cartagena's three in another.
    const first = await w.plan();
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: first.token } }), 'first apply');

    // The owner adds a rule, and a third location has people waiting.
    await w.hardGender();
    const ma = await w.loc('Malambo');
    await w.person('MW0', w.F, ma);
    const again = await w.plan();
    const b = again.locations.find((l: any) => l.name === 'Barranquilla');
    assert.ok(b, 'Barranquilla is still listed');
    assert.deepStrictEqual([b.settled, b.people, b.unplaced], [true, 4, 0]);
    assert.ok(b.violations.some((v: any) => v.hard && v.rule === 'Separar por género'), 'the rule its arrangement breaks today');
    assert.strictEqual(again.locations.find((l: any) => l.name === 'Malambo').settled, undefined, 'Malambo is planned for');
    assert.deepStrictEqual(again.order.map((o: any) => [o.name, o.state]), [['Barranquilla', 'settled'], ['Cartagena', 'settled'], ['Malambo', 'waiting']]);
    // «Rehacer todo» is what fixes it.
    const fresh = await w.plan({ fresh: true });
    assert.deepStrictEqual([fresh.after.hard, fresh.worse], [0, false]);
});

test('a family bigger than every room under a preferred rule: as together as the rooms allow (4 + 1), reported as information', async () => {
    const w = await world([['R1', 4], ['R2', 4], ['R3', 4]]);
    await addFields(w, 'family_group');
    await w.hardGender();
    await w.rule({ name: 'Familias juntas', type: 'keep_together', config: 'family_group', hard: 0, priority: 20 });
    const loc = await w.loc('Norte');
    const fam: number[] = [];
    for (let i = 0; i < 5; i++) fam.push(await personF(w, { first_name: `F${i}`, gender: w.F, family_group: 'Familia Escorcia Guzmán', location_id: loc }));
    for (let i = 0; i < 3; i++) await personF(w, { first_name: `S${i}`, gender: w.F, location_id: loc });
    const plan = await w.plan();
    assert.deepStrictEqual(plan.oversized.map((o: any) => [o.rule, o.value, o.people, o.largest_room, o.hard]), [['Familias juntas', 'Familia Escorcia Guzmán', 5, 4, false]]);
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    const perRoom = new Map<number, number>();
    for (const id of fam) perRoom.set(w.roomOf(id), (perRoom.get(w.roomOf(id)) || 0) + 1);
    assert.deepStrictEqual([...perRoom.values()].sort(), [1, 4], 'four of the family together, the fifth next door');
    assert.deepStrictEqual(Object.keys(w.used()).length, 2, 'eight women in two rooms');
});

// ── a family's mixed room is the family's alone (2.21.0; the owner: «si se agrupa una familia en una habitación
// mixta no se pueda añadir a nadie más que no sea del grupo familiar») ───────────────────────────────────────
const familyWorld = async (rooms: [string, number][], hard = 0) => {
    const w = await world(rooms);
    await addFields(w, 'family_group');
    await w.hardGender();
    await w.rule({ name: 'Familias juntas', type: 'keep_together', config: 'family_group', hard, priority: 60 });
    return w;
};
const namesIn = (w: any, roomId: number) => (w.p.q(`SELECT first_name FROM ${T('inscriptions')} WHERE room_id = ? ORDER BY first_name`, roomId) as any[]).map(x => x.first_name);

test('a family in a mixed room: nobody from outside joins it, of either gender — they go to another room or wait', async () => {
    for (const hard of [0, 1]) {
        const w = await familyWorld([['R4', 4], ['R2', 2]], hard);
        for (const [n, g] of [['Ana', w.F], ['Bea', w.F], ['Carlos', w.M]] as [string, string][]) await personF(w, { first_name: n, gender: g, family_group: 'Pérez' });
        await personF(w, { first_name: 'Olga', gender: w.F });
        await personF(w, { first_name: 'Oscar', gender: w.M });
        await personF(w, { first_name: 'Otto', gender: w.M });
        const r = await w.run();
        const fam = w.roomOf(w.p.one(`SELECT id FROM ${T('inscriptions')} WHERE first_name = 'Ana'`).id);
        assert.deepStrictEqual(namesIn(w, fam), ['Ana', 'Bea', 'Carlos'], `hard=${hard}: the family alone in its mixed room (a bed stays free)`);
        assert.deepStrictEqual(hardOf(r).filter((v: any) => /mezcla/.test(v.detail)), [], `hard=${hard}: no mix reported`);
        assert.strictEqual(r.remaining, 1, `hard=${hard}: one of the three outsiders waits (two beds in R2)`);
    }
});

test('a family of one gender: people of that gender from outside may still complete its room', async () => {
    const w = await familyWorld([['R4', 4]]);
    for (const n of ['Ana', 'Bea', 'Cata']) await personF(w, { first_name: n, gender: w.F, family_group: 'Pérez' });
    await personF(w, { first_name: 'Olga', gender: w.F });
    const r = await w.run();
    assert.strictEqual(r.remaining, 0);
    assert.deepStrictEqual(namesIn(w, w.room.R4), ['Ana', 'Bea', 'Cata', 'Olga']);
});

test('someone from outside put by hand in a family\'s mixed room is reported as mixing genders; two mixed families may not share a room either', async () => {
    const w = await familyWorld([['R5', 5], ['R4', 4]], 1);
    const norte = await w.loc('Norte');
    ok(await w.p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: norte, room_ids: [w.room.R5] } }), 'allot');
    const ana = await personF(w, { first_name: 'Ana', gender: w.F, family_group: 'Pérez', location_id: norte });
    const carlos = await personF(w, { first_name: 'Carlos', gender: w.M, family_group: 'Pérez', location_id: norte });
    const olga = await personF(w, { first_name: 'Olga', gender: w.F, location_id: norte });
    for (const id of [ana, carlos]) ok(await w.p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room.R5 } }), 'the family by hand');
    const before = ok(await w.p.call('get', `/locations/${norte}/lodging`), 'review');
    assert.deepStrictEqual(before.violations.filter((v: any) => v.hard), [], 'the family alone mixes on purpose');
    ok(await w.p.call('post', `/inscriptions/${olga}/assign`, { body: { room_id: w.room.R5 } }), 'someone from outside by hand');
    const after = ok(await w.p.call('get', `/locations/${norte}/lodging`), 'review');
    assert.ok(after.violations.some((v: any) => v.hard && /mezcla 2 valores de «gender»/.test(v.detail)), JSON.stringify(after.violations));

    // Another mixed family: never in the Pérez room (it has a free bed for two? no — the López go to R4).
    const w2 = await familyWorld([['R6', 6], ['R4', 4]], 1);
    for (const [n, g, fam] of [['Ana', w2.F, 'Pérez'], ['Carlos', w2.M, 'Pérez'], ['Luz', w2.F, 'López'], ['Leo', w2.M, 'López']] as [string, string, string][]) await personF(w2, { first_name: n, gender: g, family_group: fam });
    const r2 = await w2.run();
    assert.strictEqual(r2.remaining, 0);
    assert.notStrictEqual(w2.roomOf(w2.p.one(`SELECT id FROM ${T('inscriptions')} WHERE first_name = 'Ana'`).id), w2.roomOf(w2.p.one(`SELECT id FROM ${T('inscriptions')} WHERE first_name = 'Luz'`).id), 'each mixed family in its own room');
});

// ── a preferred mixed family gives way when beds are short (2.21.0; the owner: «que ceda si falta cama, y las
// familias a habitaciones más grandes solo si no hay habitaciones con la cantidad de camas igual al número de
// integrantes y si no hay personas sin asignar») ──────────────────────────────────────────────────────────────
const yieldWorld = async (rooms: [string, number][]) => {
    const w = await world(rooms);
    await addFields(w, 'family_group');
    await w.hardGender();
    await w.rule({ name: 'Familias juntas', type: 'keep_together', config: 'family_group', hard: 0, priority: 90 });
    return w;
};
const fam = async (w: any, name: string, genders: string[]) => {
    const ids: number[] = [];
    for (let i = 0; i < genders.length; i++) ids.push(await personF(w, { first_name: `${name}${i}`, gender: genders[i], family_group: name }));
    return ids;
};

test('beds short: a preferred mixed family that would leave beds empty is divided by gender, so nobody is left without a bed', async () => {
    const w = await yieldWorld([['R1', 4], ['R2', 4]]);
    const couple = await fam(w, 'Pareja', [w.M, w.F]);
    for (let i = 0; i < 3; i++) await personF(w, { first_name: `W${i}`, gender: w.F });
    for (let i = 0; i < 3; i++) await personF(w, { first_name: `M${i}`, gender: w.M });
    const r = await w.run();
    assert.strictEqual(r.remaining, 0, 'eight people, eight beds');
    assert.notStrictEqual(w.roomOf(couple[0]), w.roomOf(couple[1]), 'the couple divided by gender');
    for (const n of ['R1', 'R2']) assert.strictEqual(w.gendersIn(w.room[n]).size, 1);
});

test('beds enough: a preferred mixed family stays together, even in a room bigger than it', async () => {
    const w = await yieldWorld([['R1', 4], ['R2', 4], ['R3', 4]]);
    const couple = await fam(w, 'Pareja', [w.M, w.F]);
    for (let i = 0; i < 4; i++) await personF(w, { first_name: `W${i}`, gender: w.F });
    const r = await w.run();
    assert.strictEqual(r.remaining, 0);
    assert.strictEqual(w.roomOf(couple[0]), w.roomOf(couple[1]), 'the couple together');
    assert.deepStrictEqual(namesIn(w, w.roomOf(couple[0])), ['Pareja0', 'Pareja1'], 'alone in its room');
});

test('«Sugerir reparto», beds short: only the families no room fits exactly give way — a family of 4 keeps its room of 4', async () => {
    const w = await yieldWorld([['R1', 4], ['R2', 4], ['R3', 4], ['R4', 4]]);
    const small = await fam(w, 'Pareja', [w.M, w.F]);
    const four = await fam(w, 'Cuatro', [w.M, w.M, w.F, w.F]);
    // 7 + 1 women and 5 + 1 men fill two rooms and one: the family of four in the fourth, whole. (With 6 + 6 the
    // genders would not pair and it would give way too — one more bed beats it: more people with a bed come first.)
    for (let i = 0; i < 7; i++) await personF(w, { first_name: `W${i}`, gender: w.F });
    for (let i = 0; i < 5; i++) await personF(w, { first_name: `M${i}`, gender: w.M });
    const plan = await w.plan();
    assert.deepStrictEqual([plan.after.unplaced, plan.after.empty_beds, plan.families_split], [2, 0, 1], 'eighteen people, sixteen beds; one family gives way');
    // Proven: 16 beds for 18 people — no arrangement beds more than 16, nor holds 16 in fewer than four rooms of 4.
    assert.deepStrictEqual(plan.proof, { people: 18, beds: 16, unplaced_min: 2, rooms_min: 4, beds_optimal: true, rooms_optimal: true });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.strictEqual(new Set(four.map(w.roomOf)).size, 1, 'the family of four together');
    assert.deepStrictEqual(namesIn(w, w.roomOf(four[0])), ['Cuatro0', 'Cuatro1', 'Cuatro2', 'Cuatro3']);
    assert.ok(small.some(id => w.roomOf(id) == null) || w.roomOf(small[0]) !== w.roomOf(small[1]), 'the couple gives way');
});

// ── a shared room keeps the class the plan gave it (2.21.0; the owner: «si el motor comparte habitación entre dos
// localidades es obligatorio que se quede el género que asignó el motor a esa habitación») ────────────────────────
/** A coordinator's portal call: the portal authenticates with its own token (never a WordJS session). */
async function portalCall(p: Plugin, method: string, url: string, token: string, body?: any) {
    for (const r of p.routes) {
        if (r.method !== method) continue;
        const a = r.path.split('/'), b = url.split('/');
        if (a.length !== b.length) continue;
        const params: Record<string, string> = {};
        if (!a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = b[i]), true) : seg === b[i]))) continue;
        const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; },
            cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; },
        };
        await r.handler({ params, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    }
    throw new Error(`no portal route ${method} ${url}`);
}
const tokenOf = async (w: any, location_id: number) => {
    const code = w.p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, location_id).code;
    return ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id, code } })).token as string;
};
const lockOf = (w: any, roomId: number) => { const v = w.p.one(`SELECT share_lock FROM ${T('rooms')} WHERE id = ?`, roomId).share_lock; return v == null ? null : JSON.parse(v); };

test('a room «Sugerir reparto» shares keeps its gender: no run, coordinator or admin puts anyone else there, even with its beds empty', async () => {
    const w = await yieldWorldShared();
    const { p, norte, sur, men, sm } = w;
    const plan = await w.plan();
    const shared = plan.rooms.find((r: any) => r.after.kind === 'shared');
    const roomId = shared.room_id as number;
    assert.deepStrictEqual(shared.after.lock, [{ field: 'gender', value: w.M }], 'the plan shares the men’s room');
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.deepStrictEqual(lockOf(w, roomId), [{ field: 'gender', value: w.M }], 'written on the room');
    const hotelRoom = (ok(await p.call('get', `/hotels?conference_id=${w.cid}`)) as any[]).flatMap(h => h.rooms).find((r: any) => r.id === roomId);
    assert.deepStrictEqual([hotelRoom.lock, hotelRoom.share_lock], [[{ field: 'gender', value: w.M }], undefined], 'the admin sees it');

    // Everyone leaves the room: its beds are free (Norte 3, Sur 1), and Sur has a woman without a bed.
    for (const id of [...men, sm]) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: null } }), 'unassign');
    const sf = await w.person('SF3', w.F, sur);
    const token = await tokenOf(w, sur);
    const view = ok(await portalCall(p, 'get', '/portal/lodging', token), 'portal view');
    assert.deepStrictEqual(view.rooms.find((r: any) => Number(r.id) === roomId).shared.lock, [{ field: 'gender', value: w.M }], 'the coordinator sees it');
    // Sur's run gives its bed there to its man, never to her…
    ok(await portalCall(p, 'post', '/portal/lodging/run', token), 'Sur run');
    assert.deepStrictEqual([w.roomOf(sm), w.roomOf(sf) === roomId], [roomId, false]);
    // …and with the bed free again, by hand neither the coordinator nor the admin may put her there.
    ok(await portalCall(p, 'post', '/portal/lodging/assign', token, { inscription_id: sm, room_id: null }), 'Sur man out');
    const byHand = await portalCall(p, 'post', '/portal/lodging/assign', token, { inscription_id: sf, room_id: roomId });
    assert.deepStrictEqual([byHand.status, /el reparto la dejó solo para hombres; esta persona es mujer\. Elige otra habitación\./.test(byHand.body.error)], [409, true], JSON.stringify(byHand.body));
    const byAdmin = await p.call('post', `/inscriptions/${sf}/assign`, { body: { room_id: roomId } });
    assert.deepStrictEqual([byAdmin.status, /Repartir camas/.test(byAdmin.body.error)], [409, true], JSON.stringify(byAdmin.body));
    // A man is welcome; the admin's run puts the men back and the room stays theirs.
    ok(await portalCall(p, 'post', '/portal/lodging/assign', token, { inscription_id: sm, room_id: roomId }), 'Sur man by hand');
    await w.run();
    assert.deepStrictEqual([...w.gendersIn(roomId)], [w.M]);
    assert.strictEqual(w.ownerOf(roomId), null);
    assert.deepStrictEqual(w.shares(roomId).map((x: any) => [x.location_id, x.beds]).sort(), [[norte, 3], [sur, 1]].sort());

    // The admin frees it in «Repartir camas»: the same split, and anyone may take a free bed again.
    ok(await p.call('post', `/inscriptions/${sm}/assign`, { body: { room_id: null } }), 'Sur man out');
    ok(await p.call('put', `/rooms/${roomId}/beds`, { body: { shares: w.shares(roomId), release_lock: true } }), 'release');
    assert.strictEqual(lockOf(w, roomId), null);
    ok(await p.call('post', `/inscriptions/${sf}/assign`, { body: { room_id: roomId } }), 'the admin, freed');
});

test('a shared room’s gender goes with the share: given whole to a location, it keeps none', async () => {
    const w = await yieldWorldShared();
    const { p, norte } = w;
    const plan = await w.plan();
    const roomId = plan.rooms.find((r: any) => r.after.kind === 'shared').room_id as number;
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } }), 'apply');
    assert.ok(lockOf(w, roomId));
    for (const id of p.q(`SELECT id FROM ${T('inscriptions')} WHERE room_id = ?`, roomId).map((x: any) => x.id)) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: null } }));
    ok(await p.call('put', `/rooms/${roomId}/beds`, { body: { shares: [{ location_id: norte, beds: 4 }] } }), 'whole to Norte');
    assert.deepStrictEqual([w.ownerOf(roomId), lockOf(w, roomId)], [norte, null]);
});
/** «Sugerir reparto» shares a room of 4 between Norte's 3 men and Sur's man (see the first plan test). */
async function yieldWorldShared() {
    const w = await world([['A4', 4], ['B4', 4], ['C3', 3], ['D2', 2], ['E2', 2], ['F2', 2]]);
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    const men: number[] = [];
    for (let i = 0; i < 3; i++) men.push(await w.person(`NM${i}`, w.M, norte));
    for (let i = 0; i < 2; i++) await w.person(`NF${i}`, w.F, norte);
    const sm = await w.person('SM0', w.M, sur);
    for (let i = 0; i < 3; i++) await w.person(`SF${i}`, w.F, sur);
    return { ...w, norte, sur, men, sm };
}

test('a shared room’s gender holds against 2.19’s placement too: a mixed family it chunks stops before the other gender', async () => {
    // The run's 'greedy' candidate (2.19) checks the first person of a run of people and used to take the rest unchecked.
    const w = await world([['S3', 3]]);
    await addFields(w, 'family_group');
    await w.hardGender();
    await w.rule({ name: 'Familias juntas', type: 'keep_together', config: 'family_group', hard: 0, priority: 20 });
    const norte = await w.loc('Norte');
    ok(await w.p.call('put', `/rooms/${w.room.S3}/beds`, { body: { shares: [{ location_id: norte, beds: 1 }] } }), 'share');
    w.p.exec(`UPDATE ${T('rooms')} SET share_lock = ? WHERE id = ?`, JSON.stringify([{ field: 'gender', value: w.M }]), w.room.S3);
    await fam(w, 'Fam', [w.M, w.F, w.F]);
    await w.run();
    assert.deepStrictEqual([...w.gendersIn(w.room.S3)].filter(g => g !== w.M), [], 'nobody but men in the room fixed for men');
});

// ── «Dividir familias» as an option: both answers computed (2.21.0; the owner: «que lo de dividir las familias sea
// una opción, que calcule ambos, le diga al admin cuántas habitaciones serían en ambos casos y en el caso que se
// dividen las familias diga cuántas se dividieron») ──────────────────────────────────────────────────────────────
test('«Dividir familias»: together 3 rooms, divided 2 rooms with 1 family divided; the chosen answer is planned and applied', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C1', 1]]);
    const couple = await fam(w, 'Pareja', [w.M, w.F]);
    await personF(w, { first_name: 'Solo', gender: w.M });
    await personF(w, { first_name: 'Sola', gender: w.F });
    const keep = await w.plan();
    const v = keep.variants;
    assert.deepStrictEqual([v.chosen, v.keep.rooms, v.divide.rooms, v.keep.families_divided, v.divide.families_divided, v.same], ['keep', 3, 2, 0, 1, false], JSON.stringify(v));
    assert.deepStrictEqual([keep.after.rooms, keep.options.divide_families], [3, false]);
    // The bed over is the same both ways (the owner: «¿no deberían quedar las mismas camas vacías? Lo que debería cambiar
    // es el número de habitaciones vacías»): together it is empty in a room used; divided, the room of 1 is left free.
    assert.deepStrictEqual([v.keep.used_rooms, v.keep.used_empty_beds, v.keep.free_rooms, v.keep.free_beds, v.divide.used_rooms, v.divide.used_empty_beds, v.divide.free_rooms, v.divide.free_beds], [3, 1, 0, 0, 2, 0, 1, 1], JSON.stringify(v));
    assert.deepStrictEqual([keep.after.free_rooms, keep.after.free_beds], [0, 0]);
    assert.strictEqual(typeof keep.current.free_rooms, 'number');
    const divide = await w.plan({ divide_families: true });
    assert.deepStrictEqual([divide.variants.chosen, divide.after.rooms, divide.options.divide_families, divide.after.unplaced], ['divide', 2, true, 0]);
    assert.deepStrictEqual(divide.variants.keep, v.keep, 'the other answer is still shown');
    // «Aplicar» re-plans with the same choice: one answer's token is not the other's.
    const wrong = await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: divide.token } });
    assert.strictEqual(wrong.status, 409);
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: divide.token, divide_families: true } }), 'apply');
    assert.strictEqual(Object.keys(w.used()).length, 2);
    assert.notStrictEqual(w.roomOf(couple[0]), w.roomOf(couple[1]), 'the couple divided');
    for (const n of ['A2', 'B2', 'C1']) assert.ok(w.gendersIn(w.room[n]).size <= 1);
});

test('«Dividir familias» when dividing uses no fewer rooms: both answers are the same and the family stays together', async () => {
    const w = await yieldWorld([['R1', 4], ['R2', 4], ['R3', 4]]);
    const couple = await fam(w, 'Pareja', [w.M, w.F]);
    for (let i = 0; i < 4; i++) await personF(w, { first_name: `W${i}`, gender: w.F });
    const plan = await w.plan({ divide_families: true });
    const v = plan.variants;
    assert.deepStrictEqual([v.same, v.keep.rooms, v.divide.rooms, v.divide.families_divided, plan.after.rooms], [true, 2, 2, 0, 2], JSON.stringify(v));
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token, divide_families: true } }), 'apply');
    assert.strictEqual(w.roomOf(couple[0]), w.roomOf(couple[1]));
});

test('«Dividir familias» without a preferred family rule: no second answer', async () => {
    const w = await world([['R1', 2], ['R2', 2]]);
    await w.hardGender();
    await w.person('H1', w.M); await w.person('M1', w.F);
    const plan = await w.plan({ divide_families: true });
    assert.deepStrictEqual([plan.variants, plan.options.divide_families], [null, false]);
});

test('«Dividir familias» counts families per location and only of the family rule: two «Pérez» couples in two locations, each whole, are no divided family', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C6', 6]]);
    // A second preferred rule the gender rule outranks: its groups are no «familias».
    await addFields(w, { label: 'Iglesia', name: 'iglesia', type: 'text' });
    await w.rule({ name: 'Misma iglesia', type: 'keep_together', config: 'iglesia', hard: 0, priority: 5 });
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    await personF(w, { first_name: 'NP1', gender: w.M, family_group: 'Pérez', location_id: norte });
    await personF(w, { first_name: 'NP2', gender: w.F, family_group: 'Pérez', location_id: norte });
    await personF(w, { first_name: 'SP1', gender: w.M, family_group: 'Pérez', location_id: sur });
    await personF(w, { first_name: 'SP2', gender: w.F, family_group: 'Pérez', location_id: sur });
    for (let i = 0; i < 4; i++) await personF(w, { first_name: `I${i}`, gender: i < 2 ? w.M : w.F, iglesia: 'Central', location_id: norte });
    const plan = await w.plan();
    assert.ok(plan.variants, 'both answers');
    assert.strictEqual(plan.variants.keep.families_divided, 0, JSON.stringify(plan.variants));
});

test('«Dividir familias» with beds short: no second answer (every free room is used anyway), the divided families are said once', async () => {
    const w = await yieldWorld([['R2', 2]]);
    await fam(w, 'Pareja', [w.M, w.F]);
    await personF(w, { first_name: 'Solo', gender: w.M });
    const plan = await w.plan({ divide_families: true });
    assert.deepStrictEqual([plan.short != null, plan.variants, plan.options.divide_families], [true, null, false]);
    assert.strictEqual(plan.after.unplaced, 1);
});

// ── held by the administration: a blocked room, a person fixed in their room (2.21.0; the owner: «el admin puede
// bloquear a alguien una habitación o bloquear una habitación entera para que la siguiente sugerencia no los tenga en
// cuenta»; «solo el admin» changes them by hand) ─────────────────────────────────────────────────────────────────
const block = async (w: any, roomId: number, blocked = true) => ok(await w.p.call('put', `/rooms/${roomId}/block`, { body: { blocked } }), 'block');
const pin = async (w: any, id: number, pinned = true) => w.p.call('put', `/inscriptions/${id}/pin`, { body: { pinned } });

test('a blocked room: no suggestion (not even «Rehacer todo»), run, reset or «Dar camas» places anyone in it or takes anyone out', async () => {
    const w = await world([['R1', 2], ['R2', 2], ['R3', 2]]);
    const { p } = w;
    await w.hardGender();
    const a = await w.person('A', w.M);
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: w.room.R1 } }), 'A by hand into R1');
    await block(w, w.room.R1);
    const b = await w.person('B', w.M), c = await w.person('C', w.M);
    // Without and with «Rehacer todo»: R1 keeps A and gets nobody (its free bed is not offered).
    for (const fresh of [false, true]) {
        const plan = await w.plan({ fresh });
        assert.ok(!plan.placements.some((x: any) => x.room_id === w.room.R1), `fresh=${fresh}: nobody into R1`);
        assert.ok(!(plan.moved_ids || []).some((x: any) => x.inscription_id === a), `fresh=${fresh}: A stays`);
        assert.deepStrictEqual(plan.held, { rooms: 1, people: 0 });
    }
    await w.run();
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b) === w.room.R1, w.roomOf(c) === w.room.R1], [w.room.R1, false, false]);
    ok(await p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }), 'reset');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.roomOf(c)], [w.room.R1, null, null], 'the reset leaves the blocked room as it is');
    const norte = await w.loc('Norte');
    const give = await p.call('post', `/locations/${norte}/beds`, { body: { beds: 6 } });
    assert.strictEqual(give.status, 409, 'only 4 free beds outside the blocked room');
    // Unblocked, it is a room like any other again.
    await block(w, w.room.R1, false);
    await w.run();
    assert.ok([b, c].some(id => w.roomOf(id) === w.room.R1));
});

test('a person fixed in their room: never moved by «Rehacer todo» nor emptied by a reset; out of the room by hand, the fix goes', async () => {
    const w = await world([['R1', 2], ['R2', 2]]);
    const { p } = w;
    await w.hardGender();
    const a = await w.person('A', w.M), b = await w.person('B', w.M);
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: w.room.R1 } }));
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: w.room.R2 } }));
    assert.strictEqual((await pin(w, a)).status, 200);
    const nobody = await w.person('C', w.M);
    assert.strictEqual((await pin(w, nobody)).status, 400, 'no bed, nothing to fix');
    // «Rehacer todo» would put the three men in fewer rooms; A stays in R1 whatever it does.
    const plan = await w.plan({ fresh: true });
    assert.ok(!(plan.moved_ids || []).some((x: any) => x.inscription_id === a));
    assert.deepStrictEqual(plan.held, { rooms: 0, people: 1 });
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token, fresh: true } }), 'apply');
    assert.strictEqual(w.roomOf(a), w.room.R1);
    ok(await p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }), 'reset');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.roomOf(nobody)], [w.room.R1, null, null]);
    // The administration takes A out by hand: A is no longer fixed.
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: null } }));
    assert.strictEqual(Number(p.one(`SELECT room_locked FROM ${T('inscriptions')} WHERE id = ?`, a).room_locked) || 0, 0);
});

test('held by the administration: the coordinator can neither fill a blocked room, nor empty it, nor move a fixed person; the admin can', async () => {
    const w = await world([['R1', 2], ['R2', 2], ['R3', 2]]);
    const { p } = w;
    const norte = await w.loc('Norte');
    for (const n of ['R1', 'R2', 'R3']) ok(await p.call('put', `/rooms/${w.room[n]}`, { body: { location_id: norte } }), `allot ${n}`);
    const a = await w.person('A', w.M, norte), b = await w.person('B', w.M, norte), c = await w.person('C', w.M, norte);
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: w.room.R1 } }));
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: w.room.R2 } }));
    await block(w, w.room.R1);
    assert.strictEqual((await pin(w, b)).status, 200);
    const token = await tokenOf(w, norte);
    const view = ok(await portalCall(p, 'get', '/portal/lodging', token), 'view');
    assert.strictEqual(view.rooms.find((r: any) => Number(r.id) === w.room.R1).blocked, true);
    assert.strictEqual(Number(view.rooms.find((r: any) => Number(r.id) === w.room.R2).occupants.find((o: any) => o.id === b).room_locked), 1);
    const tries: Array<[number, number | null, string]> = [
        [c, w.room.R1, 'into the blocked room'], [a, null, 'out of the blocked room'], [a, w.room.R3, 'moved out of the blocked room'],
        [b, w.room.R3, 'the fixed person moved'], [b, null, 'the fixed person taken out'],
    ];
    for (const [id, room, what] of tries) {
        const r = await portalCall(p, 'post', '/portal/lodging/assign', token, { inscription_id: id, room_id: room });
        assert.strictEqual(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /administración/);
    }
    // The location's own run and reset leave them too.
    ok(await portalCall(p, 'post', '/portal/lodging/run', token), 'run');
    assert.notStrictEqual(w.roomOf(c), w.room.R1);
    ok(await portalCall(p, 'post', '/portal/lodging/reset', token), 'reset');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.roomOf(c)], [w.room.R1, w.room.R2, null]);
    // The administration, by hand, still can.
    ok(await p.call('post', `/inscriptions/${c}/assign`, { body: { room_id: w.room.R1 } }), 'admin into the blocked room');
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: w.room.R3 } }), 'admin moves the fixed person');
});

test('a fix holds only in its room: cancelled and back, moved to another location or its room deleted, the person is no longer fixed anywhere', async () => {
    const w = await world([['R1', 2], ['R2', 2], ['R3', 2], ['R4', 2]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    const a = await w.person('A', w.M), b = await w.person('B', w.M, norte), c = await w.person('C', w.M);
    for (const [id, n] of [[a, 'R1'], [b, 'R2'], [c, 'R3']] as const) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room[n] } }));
    for (const id of [a, b, c]) assert.strictEqual((await pin(w, id)).status, 200);
    // A cancelled and back; B to another location; C's room deleted: each loses the bed and the fix with it.
    ok(await p.call('put', `/inscriptions/${a}`, { body: { status: 'cancelled' } }), 'cancel A');
    ok(await p.call('put', `/inscriptions/${a}`, { body: { status: 'pending' } }), 'back');
    ok(await p.call('put', `/rooms/${w.room.R2}`, { body: { location_id: norte } }), 'R2 to Norte');
    ok(await p.call('put', `/inscriptions/${b}`, { body: { location_id: sur } }), 'B to Sur');
    ok(await p.call('delete', `/rooms/${w.room.R3}`), 'delete R3');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.roomOf(c)], [null, null, null]);
    // The next placement fixes nobody: the plan holds no one, and a reset takes them out again.
    await w.run();
    assert.ok([a, b, c].every(id => w.roomOf(id) != null), 'all placed again');
    assert.deepStrictEqual((await w.plan({ fresh: true })).held, { rooms: 0, people: 0 });
    ok(await p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }), 'reset');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.roomOf(c)], [null, null, null]);
});

test('deleting a location leaves what the administration holds: a blocked room keeps its people, a fixed person stays', async () => {
    const w = await world([['N1', 2], ['N2', 2]]);
    const { p } = w;
    const norte = await w.loc('Norte');
    for (const n of ['N1', 'N2']) ok(await p.call('put', `/rooms/${w.room[n]}`, { body: { location_id: norte } }));
    const a = await w.person('A', w.M, norte), b = await w.person('B', w.M, norte);
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: w.room.N1 } }));
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: w.room.N2 } }));
    await block(w, w.room.N1);
    assert.strictEqual((await pin(w, b)).status, 200);
    ok(await p.call('delete', `/locations/${norte}`), 'delete Norte');
    assert.deepStrictEqual([w.roomOf(a), w.roomOf(b), w.ownerOf(w.room.N1), w.ownerOf(w.room.N2)], [w.room.N1, w.room.N2, null, null]);
});

test('«Sugerir reparto» for one hotel counts only the people fixed in that hotel', async () => {
    const w = await world([['A1', 2], ['A2', 2]]);
    const { p } = w;
    const other = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Otro' } })).id as number;
    const b1 = ok(await p.call('post', '/rooms', { body: { hotel_id: other, room_number: 'B1', capacity: 2 } })).id as number;
    const a = await w.person('A', w.M), b = await w.person('B', w.M);
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: w.room.A1 } }));
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: b1 } }));
    for (const id of [a, b]) assert.strictEqual((await pin(w, id)).status, 200);
    assert.deepStrictEqual((await w.plan({ fresh: true, hotel_id: w.hotel })).held, { rooms: 0, people: 1 });
});

test('a team role without «Hospedaje» cannot free a bed the administration holds by editing the person; the admin can', async () => {
    const TEAM = { id: 40, role: 'conference_manager_team', userLogin: 'team', userEmail: 't@example.test', displayName: 'Team' };
    const p = await bootPlugin({ users: [TEAM] });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `held-team-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Dorado' } })).id as number;
    const r1 = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: 'R1', capacity: 2 } })).id as number;
    const r2 = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: 'R2', capacity: 2 } })).id as number;
    const a = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'A' } })).id as number;
    const b = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'B' } })).id as number;
    ok(await p.call('post', `/inscriptions/${a}/assign`, { body: { room_id: r1 } }));
    ok(await p.call('post', `/inscriptions/${b}/assign`, { body: { room_id: r2 } }));
    ok(await p.call('put', `/inscriptions/${a}/pin`, { body: { pinned: true } }));
    ok(await p.call('put', `/rooms/${r2}/block`, { body: { blocked: true } }));
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Inscripciones', permissions: { inscriptions: 'manage' } } })).id as number;
    ok(await p.call('post', '/staff/members', { body: { user_id: TEAM.id, role_id: role } }));
    for (const id of [a, b]) {
        const r = await p.call('put', `/inscriptions/${id}`, { user: TEAM, body: { status: 'cancelled' } });
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /administración/);
    }
    ok(await p.call('put', `/inscriptions/${a}`, { body: { status: 'cancelled' } }), 'the admin');
});

test('the sheet’s rooms are those the plan may fill — not blocked, not a location’s with nobody waiting, with a hotel chosen that hotel’s — free or used, and used any other room holding its people', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C4', 4], ['X3', 3], ['S6', 6]]);
    const other = ok(await w.p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Otro' } })).id as number;
    ok(await w.p.call('post', '/rooms', { body: { hotel_id: other, room_number: 'O5', capacity: 5 } }));
    ok(await w.p.call('put', `/rooms/${w.room.S6}`, { body: { location_id: await w.loc('Sur') } }), 'S6 to Sur, nobody waiting');
    await block(w, w.room.X3);
    await fam(w, 'Pareja', [w.M, w.F]);
    const all = await w.plan();
    // A2, B2, C4 and the other hotel's O5 (13 beds): the couple in a room of 2, nothing empty in it.
    for (const x of [all.after, all.current, all.variants.keep, all.variants.divide]) {
        assert.deepStrictEqual([x.used_rooms + x.free_rooms, x.used_empty_beds + x.free_beds], [4, 11], JSON.stringify(x));
    }
    assert.deepStrictEqual([all.after.used_rooms, all.after.used_empty_beds, all.after.free_rooms, all.after.free_beds], [1, 0, 3, 11]);
    // Dorado alone: A2, B2 and C4. The plan by itself would send the couple to the other hotel’s O5 (3 beds empty); today’s
    // automatic assignment beds them in Dorado with none — so the suggestion is to leave it.
    const one = await w.plan({ hotel_id: w.hotel });
    assert.deepStrictEqual([one.keeps_today, one.after.used_rooms, one.after.used_empty_beds, one.after.free_rooms], [true, 1, 0, 2], JSON.stringify(one.after));
});

test('a location whose people all have a bed is not the plan’s to fill: its rooms, empty or not, are neither used nor free on the sheet', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C1', 1], ['S3', 3], ['S6', 6]]);
    const asentada = await w.loc('Asentada');
    for (const n of ['S3', 'S6']) ok(await w.p.call('put', `/rooms/${w.room[n]}`, { body: { location_id: asentada } }), n);
    const settled = await personF(w, { first_name: 'Asentado', gender: w.M, location_id: asentada });
    ok(await w.p.call('post', `/inscriptions/${settled}/assign`, { body: { room_id: w.room.S3 } }));
    await fam(w, 'Pareja', [w.M, w.F]);
    await personF(w, { first_name: 'Solo', gender: w.M });
    await personF(w, { first_name: 'Sola', gender: w.F });
    // As in the first «Dividir familias» world: the one bed over stays in a room used, or frees the room of 1.
    const v = (await w.plan()).variants;
    assert.deepStrictEqual([v.keep.used_rooms, v.keep.used_empty_beds, v.keep.free_rooms, v.keep.free_beds], [3, 1, 0, 0], JSON.stringify(v));
    assert.deepStrictEqual([v.divide.used_rooms, v.divide.used_empty_beds, v.divide.free_rooms, v.divide.free_beds], [2, 0, 1, 1], JSON.stringify(v));
});

// ── today is an answer too (2.21.0; the owner, on a suggestion for one hotel worse than the arrangement already
// applied: «revísalo») ─────────────────────────────────────────────────────────────────────────────────────────────
test('«Rehacer todo» never suggests worse than today: 4 men and 5 women everyone in a bed in rooms of 1, 1, 3, 1, 3 — the plan by itself leaves a man out, so it suggests leaving it', async () => {
    const w = await world([['R0', 1], ['R1', 1], ['R2', 3], ['R3', 1], ['R4', 3]]);
    const { p } = w;
    await w.hardGender();
    const men: number[] = [], women: number[] = [];
    for (let i = 0; i < 4; i++) men.push(await w.person(`M${i}`, w.M));
    for (let i = 0; i < 5; i++) women.push(await w.person(`F${i}`, w.F));
    const put = async (id: number, room: string) => ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room[room] } }), room);
    for (let i = 0; i < 3; i++) await put(men[i], 'R2');
    await put(men[3], 'R0');
    for (let i = 0; i < 3; i++) await put(women[i], 'R4');
    await put(women[3], 'R1'); await put(women[4], 'R3');
    const before = [...men, ...women].map(w.roomOf);
    const plan = await w.plan({ fresh: true });
    assert.deepStrictEqual([plan.keeps_today, plan.worse, plan.after.unplaced, plan.after.rooms, plan.changes.length, plan.placements.length, plan.moved_ids.length, plan.moved, plan.people],
        [true, false, 0, 5, 0, 0, 0, 0, 9], JSON.stringify({ current: plan.current, after: plan.after }));
    ok(await p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token, fresh: true } }), 'apply');
    assert.deepStrictEqual([...men, ...women].map(w.roomOf), before, 'nobody moved');
});

test('a tie goes to today (moving people for nothing gains nothing); a better arrangement is still suggested', async () => {
    const tie = await world([['A5', 5], ['B5', 5], ['C4', 4], ['D6', 6]]);
    await tie.hardGender();
    for (let i = 0; i < 5; i++) ok(await tie.p.call('post', `/inscriptions/${await tie.person(`M${i}`, tie.M)}/assign`, { body: { room_id: tie.room.A5 } }));
    for (let i = 0; i < 5; i++) ok(await tie.p.call('post', `/inscriptions/${await tie.person(`F${i}`, tie.F)}/assign`, { body: { room_id: tie.room.B5 } }));
    const same = await tie.plan({ fresh: true });
    assert.deepStrictEqual([same.keeps_today, same.placements.length, same.moved_ids.length, same.after.rooms], [true, 0, 0, 2]);
    // 3 men and 3 women in four rooms (4, 2, 2, 2): three rooms are enough.
    const better = await world([['A4', 4], ['B2', 2], ['C2', 2], ['D2', 2]]);
    await better.hardGender();
    const at: [string, string, string][] = [['M0', 'M', 'B2'], ['M1', 'M', 'B2'], ['M2', 'M', 'C2'], ['F0', 'F', 'D2'], ['F1', 'F', 'D2'], ['F2', 'F', 'A4']];
    for (const [n, g, r] of at) ok(await better.p.call('post', `/inscriptions/${await better.person(n, (better as any)[g])}/assign`, { body: { room_id: better.room[r] } }));
    const plan = await better.plan({ fresh: true });
    assert.deepStrictEqual([plan.keeps_today, plan.current.rooms, plan.after.rooms], [false, 4, 3]);
});

test('today competes only when it is an allotment: a location’s people in pool rooms (nothing given out yet) are planned rooms of their own', async () => {
    const w = await world([['A2', 2], ['B2', 2]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte');
    for (const n of ['M0', 'M1']) ok(await p.call('post', `/inscriptions/${await w.person(n, w.M, norte)}/assign`, { body: { room_id: w.room.A2 } }));
    const plan = await w.plan({ fresh: true });
    assert.strictEqual(plan.keeps_today, false);
    assert.ok(plan.rooms.some((r: any) => r.after.kind === 'whole' && r.after.location_id === norte), JSON.stringify(plan.rooms));
});

test('«Dividir familias» once applied: thought again, the divided answer IS today’s (nothing changes) and the families-together answer is still offered', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C1', 1]]);
    await fam(w, 'Pareja', [w.M, w.F]);
    await personF(w, { first_name: 'Solo', gender: w.M });
    await personF(w, { first_name: 'Sola', gender: w.F });
    const divide = await w.plan({ divide_families: true });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: divide.token, divide_families: true } }), 'apply');
    const again = await w.plan({ fresh: true });
    const v = again.variants;
    assert.deepStrictEqual([v.divide.today, v.keep.today, v.keep.families_divided, v.divide.families_divided, v.keep.rooms, v.divide.rooms], [true, false, 0, 1, 3, 2], JSON.stringify(v));
});

test('a tie the plan wins: it moves nobody and only gives back a room the location does not need', async () => {
    const w = await world([['A4', 4], ['B4', 4], ['C4', 4]]);
    const { p } = w;
    await w.hardGender();
    const norte = await w.loc('Norte');
    for (const n of ['A4', 'B4']) ok(await p.call('put', `/rooms/${w.room[n]}`, { body: { location_id: norte } }), n);
    const men: number[] = [];
    for (let i = 0; i < 4; i++) men.push(await w.person(`M${i}`, w.M, norte));
    const waiting = await w.plan();
    assert.deepStrictEqual([waiting.keeps_today, waiting.released.length], [false, 1], JSON.stringify(waiting.released));
    for (const id of men) ok(await p.call('post', `/inscriptions/${id}/assign`, { body: { room_id: w.room.A4 } }));
    const fresh = await w.plan({ fresh: true });
    assert.deepStrictEqual([fresh.keeps_today, fresh.moved, fresh.released.map((r: any) => r.room_number)], [false, 0, ['B4']]);
});

test('someone the plan cannot move, outside their location’s rooms, does not keep today out: nobody is sent to another hotel’s room with more beds empty', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C4', 4]]);
    const { p } = w;
    const other = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Otro' } })).id as number;
    const room = async (n: string, c: number) => ok(await p.call('post', '/rooms', { body: { hotel_id: other, room_number: n, capacity: c } })).id as number;
    const o5 = await room('O5', 5), op2 = await room('OP2', 2), nr2 = await room('NR2', 2);
    const norte = await w.loc('Norte');
    ok(await p.call('put', `/rooms/${nr2}`, { body: { location_id: norte } }), 'NR2 to Norte');
    const n1 = await personF(w, { first_name: 'N1', gender: w.M, location_id: norte });
    await personF(w, { first_name: 'N2', gender: w.M, location_id: norte });
    ok(await p.call('post', `/inscriptions/${n1}/assign`, { body: { room_id: op2 } }));
    ok(await p.call('put', `/inscriptions/${n1}/pin`, { body: { pinned: true } }));
    await fam(w, 'Pareja', [w.M, w.F]);
    const plan = await w.plan({ hotel_id: w.hotel });
    assert.deepStrictEqual([plan.keeps_today, plan.after.used_empty_beds], [true, plan.current.used_empty_beds], JSON.stringify([plan.current, plan.after]));
    assert.ok(!plan.placements.some((x: any) => x.room_id === o5));
});

test('the automatic assignment’s overflow (a location’s people on pool beds of another hotel) does not keep today out', async () => {
    const w = await world([['P4', 4], ['B1', 1]]);
    const { p } = w;
    await w.hardGender();
    const dos = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Dos' } })).id as number;
    const a2 = ok(await p.call('post', '/rooms', { body: { hotel_id: dos, room_number: 'A2', capacity: 2 } })).id as number;
    const norte = await w.loc('Norte');
    ok(await p.call('put', `/rooms/${a2}`, { body: { location_id: norte } }), 'A2 to Norte');
    for (let i = 0; i < 4; i++) await w.person(`M${i}`, w.M, norte);
    await w.run();
    const plan = await w.plan({ fresh: true, hotel_id: dos });
    assert.deepStrictEqual([plan.keeps_today, plan.moved, plan.changes.length, plan.placements.length], [true, 0, 0, 0]);
});

test('an answer once applied is today’s: thought again with the same options, nothing moves', async () => {
    const w = await yieldWorld([['A2', 2], ['B2', 2], ['C1', 1]]);
    await fam(w, 'Pareja', [w.M, w.F]);
    await personF(w, { first_name: 'Solo', gender: w.M });
    await personF(w, { first_name: 'Sola', gender: w.F });
    const first = await w.plan({ fresh: true });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: first.token, fresh: true } }), 'apply');
    const again = await w.plan({ fresh: true });
    assert.deepStrictEqual([again.keeps_today, again.moved, again.variants.keep.today], [true, 0, true]);
});

test('2.36.6 the owner\'s hotel: 4 men and 1 woman of one location in rooms of 3, genders apart — 3+1 and 1, nobody spread 2+2', async () => {
    const w = await world([['B1', 3], ['B2', 3], ['B10', 3]]);
    await w.hardGender();
    const norte = await w.loc('Norte');
    const men = [];
    for (let i = 0; i < 4; i++) men.push(await w.person(`M${i}`, w.M, norte));
    const woman = await w.person('F0', w.F, norte);
    await w.run();
    const menRooms = men.map(w.roomOf);
    const counts = [...new Set(menRooms)].map(r => menRooms.filter(x => x === r).length).sort();
    assert.deepStrictEqual(counts, [1, 3], 'the men fill one room of 3 before opening another');
    // The woman gets the third room, alone (the hard gender rule; a room's «Hombres / Mujeres» is only its label).
    assert.ok(w.roomOf(woman) != null && !menRooms.includes(w.roomOf(woman)));
    assert.deepStrictEqual(Object.values(w.used()).sort(), [[1, 3], [1, 3], [3, 3]]);
    // The run allots nothing: the free beds stay open to anyone.
    for (const n of ['B1', 'B2', 'B10']) assert.strictEqual(w.ownerOf(w.room[n]), null, n);
});

test('2.36.6 «Limpiar todas las asignaciones» frees the rooms the plan gave (any location may take them next); a reservation by hand only when asked; preview and audit', async () => {
    const w = await world([['A3', 3], ['B3', 3], ['C2', 2], ['D2', 2]]);
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    for (let i = 0; i < 3; i++) await w.person(`NM${i}`, w.M, norte);
    await w.person('NF0', w.F, norte);
    // A reservation by hand: «Dar camas» gives Sur 2 beds (a room of 2).
    ok(await w.p.call('post', `/locations/${sur}/beds`, { body: { beds: 2 } }), 'dar camas');
    const manualRoom = Object.values(w.room).find(id => w.ownerOf(id) === sur) as number;
    assert.ok(manualRoom, 'Sur got a room by hand');
    // The plan gives Norte its rooms and places its people.
    const pl = await w.plan({ replan: true });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, replan: true, token: pl.token } }), 'apply');
    const sourceOf = (id: number) => w.p.one(`SELECT allot_source FROM ${T('rooms')} WHERE id = ?`, id).allot_source;
    const planRooms = Object.values(w.room).filter(id => w.ownerOf(id) === norte || w.shares(id).some((b: any) => b.location_id === norte));
    assert.ok(planRooms.length > 0, 'the plan allotted rooms to Norte');
    for (const id of planRooms) if (w.ownerOf(id) === norte) assert.strictEqual(sourceOf(id), 'plan');
    assert.strictEqual(sourceOf(manualRoom), 'manual');
    // An allotment made before 2.36.6 (no source) counts as made by hand.
    w.p.exec(`UPDATE ${T('rooms')} SET allot_source = NULL WHERE id = ?`, manualRoom);

    // The preview: counts only, nothing changes.
    const pre = ok(await w.p.call('post', '/assignment/reset', { body: { conference_id: w.cid, preview: true } }), 'preview');
    assert.strictEqual(pre.people, 4);
    assert.ok(pre.plan_allotments >= 1);
    assert.strictEqual(pre.manual_allotments, 1);
    assert.ok(w.roomOf((w.p.one(`SELECT id FROM ${T('inscriptions')} WHERE first_name = 'NM0'`) as any).id) != null, 'preview moved nobody');

    // Clear all (box unticked): people out, the plan's rooms back to the pool, Sur's reservation by hand stays.
    const done = ok(await w.p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }), 'reset');
    assert.deepStrictEqual([done.people, done.plan_released, done.manual_released, done.manual_kept], [4, pre.plan_allotments, 0, 1]);
    assert.strictEqual(Number(w.p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE conference_id = ? AND room_id IS NOT NULL`, w.cid).n), 0);
    for (const id of Object.values(w.room)) {
        if (id === manualRoom) { assert.strictEqual(w.ownerOf(id), sur); continue; }
        assert.strictEqual(w.ownerOf(id), null, 'a pool room again');
        assert.deepStrictEqual(w.shares(id), [], 'no bed left reserved');
    }
    // Any location may take them now: Sur's people go into the freed rooms too (the run fills pool rooms for everyone).
    for (let i = 0; i < 3; i++) await w.person(`SM${i}`, w.M, sur);
    await w.run();
    const surMen = (w.p.q(`SELECT room_id FROM ${T('inscriptions')} WHERE first_name LIKE 'SM%'`) as any[]).map(r => r.room_id);
    assert.ok(surMen.every(r => r != null), 'Sur placed');
    assert.ok(surMen.some(r => r !== manualRoom), 'a room the plan had given Norte took Sur\'s people');

    // Ticked: the reservation by hand goes too.
    const all = ok(await w.p.call('post', '/assignment/reset', { body: { conference_id: w.cid, release_manual: true } }), 'reset manual');
    assert.deepStrictEqual([all.manual_released, all.manual_kept], [1, 0]);
    assert.strictEqual(w.ownerOf(manualRoom), null);
    // The audit: one row per reset, with who and what it freed.
    const log = w.p.q(`SELECT actor, people, plan_released, manual_released, manual_kept FROM ${T('lodging_resets')} WHERE conference_id = ? ORDER BY id`, w.cid) as any[];
    assert.strictEqual(log.length, 2);
    assert.deepStrictEqual([Number(log[0].manual_kept), Number(log[1].manual_released)], [1, 1]);
    assert.ok(log[0].actor);
});

// The coordinators' portal of a location, as the core calls a portal route (x-portal-token).
async function portalOf(w: Awaited<ReturnType<typeof world>>, locationId: number) {
    const code = w.p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, locationId).code;
    const token = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: locationId, code } })).token as string;
    return async (method: string, url: string, body?: any) => {
        const r = w.p.routes.find((x: any) => x.method === method && x.path === url) as any;
        const res: any = { statusCode: 200, _body: undefined, status(c: number) { this.statusCode = c; return this; }, json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; }, cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; } };
        await r.handler({ params: {}, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    };
}

test('2.36.6 option (a): a location holds only the beds its people use — its leftover beds go to another location of the same gender, never another gender, never a room reserved by hand', async () => {
    const w = await world([['A3', 3], ['B3', 3], ['D2', 2]]);
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    // D2 reserved for Norte by hand (the admin's own allotment): exclusive.
    ok(await w.p.call('put', `/rooms/${w.room.D2}`, { body: { location_id: norte } }), 'D2 by hand');
    for (let i = 0; i < 4; i++) await w.person(`NM${i}`, w.M, norte);
    const pl = await w.plan({ replan: false });
    ok(await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: pl.token } }), 'apply');
    // Norte's four men: two of them in D2 (its own room by hand), two in a 3-bed room — that room is not Norte's whole:
    // Norte holds the beds its men use, the free bed is a pool bed of the men's class.
    const menRooms = (w.p.q(`SELECT room_id FROM ${T('inscriptions')} WHERE first_name LIKE 'NM%'`) as any[]).map(r => r.room_id);
    const mixedRoom = [w.room.A3, w.room.B3].find(id => menRooms.includes(id)) as number;
    assert.ok(mixedRoom);
    const usedThere = menRooms.filter(r => r === mixedRoom).length;
    assert.strictEqual(w.ownerOf(mixedRoom), null, 'not a whole room of Norte');
    assert.deepStrictEqual(w.shares(mixedRoom).map((b: any) => [b.location_id, b.beds]), [[norte, usedThere]], 'Norte holds exactly the beds it uses');
    const lock = JSON.parse(w.p.one(`SELECT share_lock FROM ${T('rooms')} WHERE id = ?`, mixedRoom).share_lock);
    assert.deepStrictEqual(lock.map((x: any) => x.value), [w.M], 'the room keeps the men\'s class');

    // Sur: men and a woman. The run fills the empty room first, then Norte's leftover men's beds — the woman never goes there.
    const sm = [await w.person('SM0', w.M, sur), await w.person('SM1', w.M, sur), await w.person('SM2', w.M, sur), await w.person('SM3', w.M, sur)];
    const sf = await w.person('SF0', w.F, sur);
    await w.run();
    const otherRoom = mixedRoom === w.room.A3 ? w.room.B3 : w.room.A3;
    const surRooms = sm.map(w.roomOf);
    assert.strictEqual(surRooms.filter(r => r === otherRoom).length, 3, 'the empty room first (a location kept together)');
    assert.strictEqual(surRooms.filter(r => r === mixedRoom).length, 3 - usedThere, 'then the free beds of Norte\'s room, same gender');
    assert.ok(!surRooms.includes(w.room.D2), 'never a room reserved by hand for Norte');
    assert.strictEqual(w.roomOf(sf), null, 'a woman never takes a bed of the men\'s room (no bed left for her)');
    assert.deepStrictEqual(w.gendersIn(mixedRoom), new Set([w.M]));
    // Norte still holds only its occupied beds there.
    assert.deepStrictEqual(w.shares(mixedRoom).map((b: any) => [b.location_id, b.beds]), [[norte, usedThere]]);

    // Norte's portal: its own people, the room marked shared — Sur's names never reach it.
    const portal = await portalOf(w, norte);
    const view = ok(await portal('get', '/portal/lodging'), 'portal view');
    const text = JSON.stringify(view);
    for (const name of ['SM0', 'SM1', 'SM2', 'SM3', 'SF0']) assert.ok(!text.includes(name), name);
    assert.ok(text.includes('NM0'));
});

test('2.36.6 option (a): with an empty room free, another location never goes into a location\'s half-used room', async () => {
    const w = await world([['A3', 3], ['B3', 3], ['C3', 3]]);
    await w.hardGender();
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    for (let i = 0; i < 4; i++) await w.person(`NM${i}`, w.M, norte);
    for (let i = 0; i < 2; i++) await w.person(`SM${i}`, w.M, sur);
    await w.run();
    // Each location in rooms of its own: 3 + 1 for Norte, 2 for Sur — no room mixes them, though one fewer room would.
    for (const id of Object.values(w.room)) {
        const locs = new Set((w.p.q(`SELECT location_id FROM ${T('inscriptions')} WHERE room_id = ?`, id) as any[]).map(r => r.location_id));
        assert.ok(locs.size <= 1, `room ${id} mixes locations`);
    }
});

test('2.36.6 «Retirar inscripción»: a coordinator withdraws their own people before the deadline — never with a payment, never another location\'s; out of lists, counts, rooms and the scanner; the admin restores', async () => {
    const w = await world([['A3', 3]]);
    const norte = await w.loc('Norte'), sur = await w.loc('Sur');
    const ana = await w.person('Ana', w.F, norte), beto = await w.person('Beto', w.M, norte), carla = await w.person('Carla', w.F, sur);
    await w.run();
    assert.ok(w.roomOf(ana) != null, 'Ana has a bed');
    const portal = await portalOf(w, norte);
    const code = w.p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, norte).code;
    const token = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: norte, code } })).token as string;
    const withdraw = async (id: number, body: any = {}) => {
        const r = w.p.routes.find((x: any) => x.method === 'post' && x.path === '/portal/inscriptions/:id/withdraw') as any;
        const res: any = { statusCode: 200, _body: undefined, status(c: number) { this.statusCode = c; return this; }, json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; }, cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; } };
        await r.handler({ params: { id: String(id) }, query: {}, body, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    };
    const refused = async (id: number) => { const r = await withdraw(id); return [r.status, r.body.code]; };
    const stamp = (when: number) => { const d = new Date(when); const p2 = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
    const setDeadline = async (v: string | null) => ok(await w.p.call('put', `/${w.cid}`, { body: { withdraw_until: v, lodging_tz: 'UTC' } }), 'deadline');

    // No deadline set: coordinators cannot withdraw; /portal/me says so.
    const me0 = ok(await portal('get', '/portal/me'));
    assert.deepStrictEqual([me0.withdraw.until, me0.withdraw.open], [null, false]);
    assert.deepStrictEqual(await refused(beto), [409, 'withdraw_closed']);
    // Past the deadline: refused too.
    await setDeadline(stamp(Date.now() - 3600e3));
    assert.deepStrictEqual(await refused(beto), [409, 'withdraw_closed']);
    // Before the deadline: open.
    await setDeadline(stamp(Date.now() + 24 * 3600e3));
    assert.strictEqual(ok(await portal('get', '/portal/me')).withdraw.open, true);
    // Another location's person: not theirs.
    assert.strictEqual((await withdraw(carla)).status, 404);
    // Any payment recorded: the administrator withdraws them.
    w.p.exec(`UPDATE ${T('inscriptions')} SET amount_paid = 10 WHERE id = ?`, beto);
    assert.deepStrictEqual(await refused(beto), [409, 'has_payments']);
    w.p.exec(`UPDATE ${T('inscriptions')} SET amount_paid = 0 WHERE id = ?`, beto);

    // Ana withdrawn (with her bed): cancelled, stamped, the bed freed; gone from the portal list and the seat count.
    const seats = (m: any) => JSON.stringify(m.inscribed);
    const before = seats(ok(await portal('get', '/portal/me')));
    ok(await withdraw(ana, { reason: 'Se enfermó' }), 'withdraw Ana');
    const row = w.p.one(`SELECT status, room_id, withdrawn_at, withdrawn_by, withdraw_reason FROM ${T('inscriptions')} WHERE id = ?`, ana);
    assert.deepStrictEqual([row.status, row.room_id, !!row.withdrawn_at, row.withdrawn_by, row.withdraw_reason], ['cancelled', null, true, `portal:${norte}`, 'Se enfermó']);
    const list = ok(await portal('get', '/portal/inscriptions')) as any[];
    assert.deepStrictEqual(list.map(x => x.id), [beto], 'gone from the coordinator\'s list');
    assert.notStrictEqual(seats(ok(await portal('get', '/portal/me'))), before, 'the seat count drops');
    assert.deepStrictEqual(await refused(ana), [409, 'not_active']);
    // The meal scanner does not serve her.
    const svc = ok(await w.p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'almuerzo', location_ids: [norte] } }), 'service').id;
    assert.notStrictEqual(ok(await w.p.call('post', '/meals/check', { body: { service_id: svc, inscription_id: ana } })).result, 'ready');

    // The admin restores her: active again, the stamp gone, her old bed NOT given back; both steps audited.
    const back = ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { status: 'pending' } }), 'restore');
    assert.strictEqual(back.restored, true);
    const after = w.p.one(`SELECT status, room_id, withdrawn_at FROM ${T('inscriptions')} WHERE id = ?`, ana);
    assert.deepStrictEqual([after.status, after.room_id, after.withdrawn_at], ['pending', null, null]);
    const log = w.p.q(`SELECT kind, actor, reason FROM ${T('inscription_withdrawals')} WHERE inscription_id = ? ORDER BY id`, ana) as any[];
    assert.deepStrictEqual(log.map(x => [x.kind, x.reason]), [['withdraw', 'Se enfermó'], ['restore', null]]);
    assert.strictEqual(log[0].actor, `portal:${norte}`);
});
