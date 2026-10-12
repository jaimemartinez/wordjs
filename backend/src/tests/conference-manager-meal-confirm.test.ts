/**
 * conference-manager 2.16.0 — the kitchen CONFIRMS before a meal is recorded.
 *
 * The site owner: «apenas lee un código enseguida sale entregado, el usuario debería de poder validar si lo
 * entrega o no» and «también debería mostrar qué comida, y la info del usuario a quien se le va a entregar
 * … debe poder configurarse, o sea que yo escojo qué campos se van a mostrar». Pinned against the REAL
 * plugin (fixtures/conference-manager-harness.ts — its SQL goes through the host's real guard):
 *   - POST /meals/check answers the verdict /meals/deliver would reach — 'ready' | 'not_entitled' |
 *     'already' | 'cancelled' | 'unknown' | 'other_conference' — with the service and the configured
 *     person fields, and NEVER writes (only SELECTs reach the database). «Cancelar» on the card is simply
 *     not calling /deliver: the person stays pending and the next scan answers 'ready' again;
 *   - /check and /deliver share one decision (every fixture person gets the corresponding verdict from
 *     both, with the same service and person projection);
 *   - permissions: /check needs meals_delivery:manage like /deliver; the display setting is read with
 *     meals:view | meals_delivery:manage and written with meals:manage only;
 *   - data minimisation: the answers carry the configured fields' values only (never an e-mail, a phone,
 *     a document or the raw row unless configured), and the registration code stays masked without
 *     inscriptions:view even when configured;
 *   - the display setting: default (name + location), validation against the conference's CURRENT form,
 *     order kept, duplicates collapsed, reset with null, deleted fields ignored on read, the full name always
 *     the first entry (review round 1: a card without WHO it is was possible);
 *   - what travels is what the dialog and the docs say (review round 1): configured values in person.fields,
 *     next to the 2.15 person projection that the search by name already gives the same staff;
 *   - the migration: the column exists on a fresh install, is added to an existing schema on boot without
 *     touching the data, survives restarts, and a missing column never breaks a scan.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type HarnessUser } from './fixtures/conference-manager-harness';

const CONF = 'wjp_conference_manager_conferences';
const FIELDS = 'wjp_conference_manager_fields';
const INS = 'wjp_conference_manager_inscriptions';
const DELIVERIES = 'wjp_conference_manager_meal_deliveries';

type P = Awaited<ReturnType<typeof bootPlugin>>;

let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function newConference(p: P, name = 'Congreso') {
    return ok(await p.call('post', '/create', { body: { name, slug: `meal-confirm-${++seq}` } }), 'create').id as number;
}
/** The field exists on the conference's form (created when missing — a conference may start with or without the base fields). */
async function ensureField(p: P, cid: number, name: string, label: string, type = 'text', options = '') {
    const list = ok(await p.call('get', `/fields?conference_id=${cid}`), 'fields');
    if (list.some((f: any) => f.name === name)) return;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, name, label, type, options, sort_order: 50 + (++seq) } }), `field ${name}`);
}
async function newLocation(p: P, cid: number, name: string) {
    return ok(await p.call('post', '/locations', { body: { conference_id: cid, name, capacity: 100 } }), 'location').id as number;
}
async function newPerson(p: P, cid: number, values: Record<string, any>) {
    const id = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, gender: 'M', ...values } }), 'inscription').id as number;
    const code = p.one(`SELECT reg_code FROM ${INS} WHERE id = ?`, id).reg_code as string;
    return { id, code };
}
const deliveries = (p: P) => Number(p.one(`SELECT COUNT(*) AS n FROM ${DELIVERIES}`).n);

/**
 * A conference with one lunch service planned for location A (not for B) and one person per verdict:
 *   ready (A), notEntitled (B, no plan), excluded (A, exclude override), included (B, include override),
 *   cancelled (A, cancelled), served (A, already delivered); plus a person of ANOTHER conference.
 */
async function scenario(p: P) {
    const cid = await newConference(p, 'Congreso 2027');
    await ensureField(p, cid, 'first_name', 'Nombre');
    await ensureField(p, cid, 'last_name', 'Apellido');
    await ensureField(p, cid, 'email', 'Email');
    await ensureField(p, cid, 'phone', 'Teléfono');
    await ensureField(p, cid, 'dieta', 'Dieta', 'select', 'Normal, Vegetariana, Sin gluten');
    await ensureField(p, cid, 'document_number', 'Documento');
    const A = await newLocation(p, cid, 'Bogotá');
    const B = await newLocation(p, cid, 'Cali');
    const svc = ok(await p.call('post', '/meals/services', { body: { conference_id: cid, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', location_ids: [A] } }), 'service').id as number;
    const base = { email: 'secret@example.test', phone: '+57 300 000 0000', document_number: 'CC-998877', dieta: 'Vegetariana' };
    const people = {
        ready: await newPerson(p, cid, { ...base, first_name: 'Ana', last_name: 'Pérez', location_id: A }),
        notEntitled: await newPerson(p, cid, { ...base, first_name: 'Beto', last_name: 'Gómez', location_id: B }),
        excluded: await newPerson(p, cid, { ...base, first_name: 'Carla', last_name: 'Ruiz', location_id: A }),
        included: await newPerson(p, cid, { ...base, first_name: 'Dani', last_name: 'Soto', location_id: B }),
        cancelled: await newPerson(p, cid, { ...base, first_name: 'Eva', last_name: 'Luna', location_id: A }),
        served: await newPerson(p, cid, { ...base, first_name: 'Fabio', last_name: 'Mora', location_id: A }),
    };
    ok(await p.call('put', `/meals/inscriptions/${people.excluded.id}/overrides`, { body: { service_id: svc, mode: 'exclude' } }), 'exclude');
    ok(await p.call('put', `/meals/inscriptions/${people.included.id}/overrides`, { body: { service_id: svc, mode: 'include' } }), 'include');
    p.exec(`UPDATE ${INS} SET status = 'cancelled' WHERE id = ?`, people.cancelled.id);
    assert.strictEqual(ok(await p.call('post', '/meals/deliver', { body: { service_id: svc, code: people.served.code } })).result, 'delivered');
    const other = await newConference(p, 'Otro congreso');
    await ensureField(p, other, 'first_name', 'Nombre');
    const foreign = await newPerson(p, other, { first_name: 'Gil', last_name: 'Vega' });
    return { cid, A, B, svc, people, foreign, other };
}

/** The SQL statements a call sends (the harness logs every statement, after the host guard passed it). */
async function sqlOf(p: P, fn: () => Promise<any>) {
    const from = p.sqlLog.length;
    const result = await fn();
    return { result, sql: p.sqlLog.slice(from) };
}
const writes = (sql: string[]) => sql.filter(s => !/^\s*(?:select|with)\b/i.test(s));

// ── /meals/check: every verdict, read-only ─────────────────────────────────────────────────────────────

test('POST /meals/check answers every verdict with the service and the person, and never writes', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const before = deliveries(p);
    const check = async (body: any) => {
        const { result, sql } = await sqlOf(p, () => p.call('post', '/meals/check', { body: { service_id: s.svc, ...body } }));
        assert.deepStrictEqual(writes(sql), [], `check wrote: ${JSON.stringify(writes(sql))}`);
        return ok(result, JSON.stringify(body));
    };
    const expect = [
        ['ready', s.people.ready, 'location'],
        ['not_entitled', s.people.notEntitled, 'none'],
        ['not_entitled', s.people.excluded, 'exclude'],
        ['ready', s.people.included, 'include'],
    ] as const;
    for (const [result, who, source] of expect) {
        for (const body of [{ code: who.code }, { inscription_id: who.id }]) {
            const v = await check(body);
            assert.strictEqual(v.result, result, `${who.code} ${JSON.stringify(body)}`);
            assert.strictEqual(v.source, source);
            assert.strictEqual(v.person.id, who.id);
        }
    }
    const ready = await check({ code: s.people.ready.code });
    assert.deepStrictEqual(ready.service, { id: s.svc, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', start_time: null, end_time: null });
    assert.strictEqual(ready.service_id, s.svc);
    assert.strictEqual(ready.person.name, 'Ana Pérez');
    assert.strictEqual(ready.person.location, 'Bogotá');
    assert.strictEqual(ready.person.reg_code, s.people.ready.code, 'the administrator sees the code');
    assert.deepStrictEqual(ready.person.fields, [
        { key: '@name', label: 'Nombre completo', value: 'Ana Pérez' },
        { key: '@location', label: 'Localidad', value: 'Bogotá' },
    ], 'unset = the default: display name + location');

    const served = await check({ code: s.people.served.code });
    assert.strictEqual(served.result, 'already');
    assert.ok(served.delivered_at && served.delivery_id, JSON.stringify(served));
    assert.strictEqual(served.delivered_by, 'boss');
    assert.strictEqual(served.method, 'scan');
    assert.strictEqual(served.person.name, 'Fabio Mora');

    const cancelled = await check({ code: s.people.cancelled.code });
    assert.strictEqual(cancelled.result, 'cancelled');
    assert.strictEqual(cancelled.person.id, s.people.cancelled.id);

    for (const body of [{ code: 'ZZZZZZZZZZ' }, { code: 'nope' }, { inscription_id: 999999 }, { code: { evil: true } }]) {
        const v = await check(body);
        assert.strictEqual(v.result, 'unknown', JSON.stringify(body));
        assert.strictEqual(v.person, undefined, 'no person for an unknown code');
        assert.strictEqual(v.service.id, s.svc);
    }
    const foreign = await check({ code: s.foreign.code });
    assert.strictEqual(foreign.result, 'other_conference');
    assert.strictEqual(foreign.person, undefined, 'another conference\'s attendee is not revealed');

    assert.strictEqual(deliveries(p), before, 'no delivery was recorded by any check');
    // Input errors keep /deliver's contract.
    assert.strictEqual((await p.call('post', '/meals/check', { body: { service_id: s.svc } })).status, 400);
    assert.strictEqual((await p.call('post', '/meals/check', { body: { service_id: 999999, code: s.people.ready.code } })).status, 404);
    assert.strictEqual((await p.call('post', '/meals/check', { body: { code: s.people.ready.code } })).status, 404);
});

test('«Cancelar» records nothing: the person stays pending and a later scan shows the card (ready) again', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const body = { service_id: s.svc, code: s.people.ready.code };
    const before = deliveries(p);
    assert.strictEqual(ok(await p.call('post', '/meals/check', { body })).result, 'ready');
    // Cancelar = the card closes without calling /meals/deliver. Nothing changed:
    assert.strictEqual(deliveries(p), before);
    const stats = ok(await p.call('get', `/meals/services/${s.svc}/stats`));
    assert.strictEqual(stats.pending, 2, 'Ana (and Dani, included) still pending');
    // The same badge later: the card again, still 'ready'.
    assert.strictEqual(ok(await p.call('post', '/meals/check', { body })).result, 'ready');
    assert.strictEqual(ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, inscription_id: s.people.ready.id } })).result, 'ready');
    // «Entregar» = /meals/deliver with the same body: recorded once, as a scan.
    const d = ok(await p.call('post', '/meals/deliver', { body }));
    assert.strictEqual(d.result, 'delivered');
    assert.strictEqual(d.method, 'scan');
    assert.strictEqual(deliveries(p), before + 1);
    assert.strictEqual(ok(await p.call('post', '/meals/check', { body })).result, 'already');
});

test('/meals/check and /meals/deliver reach the same decision (one shared function), with the same projection', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const pairs: [string, any][] = [
        ['ready', s.people.ready], ['not_entitled', s.people.notEntitled], ['not_entitled', s.people.excluded],
        ['ready', s.people.included], ['cancelled', s.people.cancelled], ['already', s.people.served],
    ];
    const deliverOf: Record<string, string> = { ready: 'delivered' };
    for (const [expected, who] of pairs) {
        for (const via of ['code', 'inscription_id'] as const) {
            const body = { service_id: s.svc, ...(via === 'code' ? { code: who.code } : { inscription_id: who.id }) };
            const c = ok(await p.call('post', '/meals/check', { body }));
            assert.strictEqual(c.result, expected, `${who.code} via ${via}`);
            const d = ok(await p.call('post', '/meals/deliver', { body }));
            assert.strictEqual(d.result, deliverOf[c.result] || c.result, `deliver after check «${c.result}» (${who.code} via ${via})`);
            assert.deepStrictEqual(d.service, c.service);
            // /deliver keeps its 2.15 person contract, plus `fields`.
            assert.deepStrictEqual(Object.keys(d.person).sort(), ['family_group', 'fields', 'id', 'location', 'location_id', 'name', 'reg_code']);
            assert.deepStrictEqual(d.person, c.person, 'deliver carries the same person projection as the card');
            if (d.result === 'delivered') {
                assert.strictEqual(d.method, via === 'code' ? 'scan' : 'manual');
                // Undo, so the inscription_id pass meets the same state.
                ok(await p.call('delete', `/meals/deliveries/${d.delivery_id}`));
            }
        }
    }
    for (const body of [{ code: 'ZZZZZZZZZZ' }, { code: s.foreign.code }]) {
        const c = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, ...body } }));
        const d = ok(await p.call('post', '/meals/deliver', { body: { service_id: s.svc, ...body } }));
        assert.strictEqual(d.result, c.result);
    }
    // 'not_entitled' needs the authorised override — exactly what the card's «Entregar sin derecho» sends.
    const forced = ok(await p.call('post', '/meals/deliver', { body: { service_id: s.svc, code: s.people.notEntitled.code, force: true, note: 'Autorizado' } }));
    assert.strictEqual(forced.result, 'delivered');
    assert.strictEqual(forced.method, 'override');
    assert.strictEqual(forced.note, 'Autorizado');
    // force never turns any other verdict into a delivery.
    assert.strictEqual(ok(await p.call('post', '/meals/deliver', { body: { service_id: s.svc, code: s.people.cancelled.code, force: true } })).result, 'cancelled');
});

// ── Permissions ──────────────────────────────────────────────────────────────────────────────────────

test('permission gates: /check like /deliver (meals_delivery:manage); the display setting read by the kitchen, written by meals:manage', async () => {
    // Team members hold the plugin's own WordJS role (2.17.0): the staff routes refuse an account whose
    // role does not carry conference_manager_access (not_team_role).
    const kitchen: HarnessUser = { id: 21, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'cocina', userEmail: 'cocina@example.test' };
    const viewer: HarnessUser = { id: 22, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'lector', userEmail: 'lector@example.test' };
    const planner: HarnessUser = { id: 23, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'plan', userEmail: 'plan@example.test' };
    const stranger: HarnessUser = { id: 24, role: 'subscriber', userLogin: 'nadie', userEmail: 'nadie@example.test' };
    const p = await bootPlugin({ users: [kitchen, viewer, planner, stranger] });
    const s = await scenario(p);
    const role = async (name: string, permissions: any) => ok(await p.call('post', '/staff/roles', { body: { name, permissions } }), name).id;
    const member = async (u: HarnessUser, roleId: number) => ok(await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: roleId } }), u.userLogin);
    await member(kitchen, await role('Cocina 2', { meals_delivery: 'manage' }));
    await member(viewer, await role('Ver comidas', { meals: 'view' }));
    await member(planner, await role('Planifica', { meals: 'manage' }));

    const check = (user: HarnessUser | null) => p.call('post', '/meals/check', user ? { user, body: { service_id: s.svc, code: s.people.ready.code } } : { anonymous: true, body: { service_id: s.svc, code: s.people.ready.code } });
    assert.strictEqual((await check(null)).status, 401);
    assert.strictEqual((await check(stranger)).status, 403);
    assert.strictEqual((await check(viewer)).status, 403, 'seeing the meals is not delivering them');
    assert.strictEqual((await check(planner)).status, 403, 'planning is not delivering');
    const k = ok(await check(kitchen), 'kitchen check');
    assert.strictEqual(k.result, 'ready');
    // reg_code stays masked without inscriptions:view — on the person and on a configured '@reg_code'.
    assert.strictEqual(k.person.reg_code, null);

    const read = (user: HarnessUser) => p.call('get', `/meals/display-fields?conference_id=${s.cid}`, { user });
    assert.strictEqual((await read(kitchen)).status, 200);
    assert.strictEqual((await read(viewer)).status, 200);
    assert.strictEqual((await read(planner)).status, 200);
    assert.strictEqual((await read(stranger)).status, 403);
    const write = (user: HarnessUser) => p.call('put', '/meals/display-fields', { user, body: { conference_id: s.cid, keys: ['@name', '@reg_code', 'dieta'] } });
    assert.strictEqual((await write(kitchen)).status, 403, 'the kitchen cannot widen what it is shown');
    assert.strictEqual((await write(viewer)).status, 403);
    assert.strictEqual((await write(stranger)).status, 403);
    assert.strictEqual((await p.call('put', '/meals/display-fields', { anonymous: true, body: { conference_id: s.cid, keys: ['@name'] } })).status, 401);
    ok(await write(planner), 'meals:manage writes');

    const masked = ok(await check(kitchen));
    assert.deepStrictEqual(masked.person.fields.find((f: any) => f.key === '@reg_code'), { key: '@reg_code', label: 'Código de inscripción', value: null, hidden: true });
    const admin = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
    assert.deepStrictEqual(admin.person.fields.find((f: any) => f.key === '@reg_code'), { key: '@reg_code', label: 'Código de inscripción', value: s.people.ready.code });
});

// ── Data minimisation ────────────────────────────────────────────────────────────────────────────────

test('data minimisation: /check and /deliver carry the configured fields only, in the configured order', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const secrets = ['secret@example.test', '+57 300 000 0000', 'CC-998877'];
    const check = async () => ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
    // Default: no e-mail, phone, document or diet anywhere in the answer, and no raw row.
    let v = await check();
    for (const x of [...secrets, 'Vegetariana']) assert.ok(!JSON.stringify(v).includes(x), `default answer leaks ${x}`);
    for (const k of ['email', 'phone', 'document_number', 'custom_data', 'notes', 'total_due', 'amount_paid', 'payment_status', 'room_id', 'status']) {
        assert.ok(!(k in v.person), `person carries ${k}`);
    }

    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['dieta', '@name', '@payment_status'] } }));
    v = await check();
    assert.deepStrictEqual(v.person.fields, [
        { key: '@name', label: 'Nombre completo', value: 'Ana Pérez' },
        { key: 'dieta', label: 'Dieta', value: 'Vegetariana' },
        { key: '@payment_status', label: 'Estado de pago', value: 'unpaid' },
    ]);
    for (const x of secrets) assert.ok(!JSON.stringify(v).includes(x), `configured answer leaks ${x}`);

    // /deliver shows the same entries on its result card.
    const d = ok(await p.call('post', '/meals/deliver', { body: { service_id: s.svc, code: s.people.ready.code } }));
    assert.strictEqual(d.result, 'delivered');
    assert.deepStrictEqual(d.person.fields, v.person.fields);
    for (const x of secrets) assert.ok(!JSON.stringify(d).includes(x), `deliver leaks ${x}`);

    // A configured e-mail is shown — it is the manager's choice — and only then.
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['@name', 'email'] } }));
    const e = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.included.code } }));
    assert.deepStrictEqual(e.person.fields.map((f: any) => [f.key, f.value]), [['@name', 'Dani Soto'], ['email', 'secret@example.test']]);
    assert.ok(!JSON.stringify(e).includes('CC-998877'));
});

test('what travels is what the docs and the dialog say: configured values in fields; the 2.15 projection the manual search already shows', async () => {
    const kitchen: HarnessUser = { id: 31, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'cocina3', userEmail: 'cocina3@example.test' };
    const p = await bootPlugin({ users: [kitchen] });
    const s = await scenario(p);
    const roleId = ok(await p.call('post', '/staff/roles', { body: { name: 'Cocina 3', permissions: { meals_delivery: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: kitchen.id, role_id: roleId } }));
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: s.cid, name: 'Hotel Norte', capacity: 10 } })).id;
    const room = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '318', capacity: 2 } })).id;
    p.exec(`UPDATE ${INS} SET room_id = ?, payment_status = 'partial' WHERE id = ?`, room, s.people.ready.id);
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['@name'] } }));
    const v = ok(await p.call('post', '/meals/check', { user: kitchen, body: { service_id: s.svc, code: s.people.ready.code } }));
    assert.deepStrictEqual(v.person.fields, [{ key: '@name', label: 'Nombre completo', value: 'Ana Pérez' }]);
    // Form answers, payment status and room travel only when configured…
    const json = JSON.stringify(v);
    for (const x of ['Vegetariana', 'partial', 'Hotel Norte', '318', 'secret@example.test', 'CC-998877']) assert.ok(!json.includes(x), `unconfigured ${x} travelled`);
    // …while `person` keeps the 2.15 projection, which the same staff get from the manual search anyway:
    // the setting chooses what the card shows; it does not (and cannot) hide the name or the location.
    assert.strictEqual(v.person.name, 'Ana Pérez');
    assert.strictEqual(v.person.location, 'Bogotá');
    const found = ok(await p.call('get', `/meals/people?conference_id=${s.cid}&q=Ana`, { user: kitchen }));
    const ana = found.people.find((x: any) => x.id === s.people.ready.id);
    assert.ok(ana, JSON.stringify(found));
    assert.strictEqual(ana.name, 'Ana Pérez');
    assert.strictEqual(ana.location, 'Bogotá');
});

test('the name is always on the card, first: added when a choice leaves it out, moved up when it is elsewhere', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const put = async (keys: any) => ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys } }));
    const get = async () => ok(await p.call('get', `/meals/display-fields?conference_id=${s.cid}`));
    const stored = () => p.one(`SELECT meal_display_fields AS v FROM ${CONF} WHERE id = ?`, s.cid).v;
    const card = async () => ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } })).person.fields.map((f: any) => f.key);

    assert.deepStrictEqual((await put(['@location', 'dieta'])).keys, ['@name', '@location', 'dieta']);
    assert.strictEqual(stored(), JSON.stringify(['@name', '@location', 'dieta']), 'stored with the name first');
    assert.deepStrictEqual((await get()).keys, ['@name', '@location', 'dieta']);
    assert.deepStrictEqual(await card(), ['@name', '@location', 'dieta']);
    assert.deepStrictEqual((await put(['@reg_code'])).keys, ['@name', '@reg_code'], 'a single other key still gets the name');
    assert.deepStrictEqual((await put(['dieta', '@name'])).keys, ['@name', 'dieta'], 'moved up');
    // A list stored without it (an older client, a hand edit) is read with the name first.
    p.exec(`UPDATE ${CONF} SET meal_display_fields = ? WHERE id = ?`, JSON.stringify(['dieta', '@location']), s.cid);
    assert.deepStrictEqual((await get()).keys, ['@name', 'dieta', '@location']);
    assert.deepStrictEqual(await card(), ['@name', 'dieta', '@location']);
    // Only the name: kept as is (not the default).
    assert.deepStrictEqual((await put(['@name'])).keys, ['@name']);
    assert.deepStrictEqual(await card(), ['@name']);
});

test('built-in fields: location (live), room, payment status and an empty value', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: s.cid, name: 'Hotel Central', capacity: 10 } })).id;
    const room = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '204', capacity: 2 } })).id;
    p.exec(`UPDATE ${INS} SET room_id = ?, payment_status = 'paid', dieta = '' WHERE id = ?`, room, s.people.ready.id);
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['@location', '@room', '@payment_status', 'dieta'] } }));
    const v = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
    // The name is always the first entry (see the next test), the rest in the configured order.
    assert.deepStrictEqual(v.person.fields.map((f: any) => [f.key, f.value]), [['@name', 'Ana Pérez'], ['@location', 'Bogotá'], ['@room', 'Hotel Central · 204'], ['@payment_status', 'paid'], ['dieta', null]]);
    // A deleted location no longer feeds or names the attendee (the live location, never the stored label).
    ok(await p.call('delete', `/locations/${s.B}`));
    const w = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.included.code } }));
    assert.strictEqual(w.person.fields[1].value, null);
    assert.strictEqual(w.person.fields[2].value, null, 'no room');
});

// ── The display setting ──────────────────────────────────────────────────────────────────────────────

test('display fields: default, validation against the conference\'s current form, order, duplicates, reset', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    const get = async (cid = s.cid) => ok(await p.call('get', `/meals/display-fields?conference_id=${cid}`));
    const put = (keys: any, cid: any = s.cid) => p.call('put', '/meals/display-fields', { body: { conference_id: cid, keys } });

    const g = await get();
    assert.deepStrictEqual(g.keys, ['@name', '@location']);
    assert.strictEqual(g.configured, false);
    assert.deepStrictEqual(g.default_keys, ['@name', '@location']);
    assert.deepStrictEqual(g.available.slice(0, 5).map((f: any) => [f.key, f.builtin]), [['@name', true], ['@location', true], ['@reg_code', true], ['@payment_status', true], ['@room', true]]);
    const formKeys = g.available.filter((f: any) => !f.builtin).map((f: any) => f.key);
    const form = p.q(`SELECT name FROM ${FIELDS} WHERE conference_id = ? ORDER BY sort_order, id`, s.cid).map((r: any) => r.name);
    assert.deepStrictEqual(formKeys, form, 'every form field, in the form\'s order');
    assert.deepStrictEqual(g.available.find((f: any) => f.key === 'dieta'), { key: 'dieta', label: 'Dieta', builtin: false, type: 'select' });

    // Invalid bodies: nothing stored.
    for (const [keys, why] of [
        [['@name', 'no_such_field'], 'unknown key'], [['@nombre'], 'unknown built-in'], [[], 'empty'], ['@name', 'not a list'],
        [[42], 'not a string'], [[{ key: '@name' }], 'object'], [Array(201).fill('@name'), 'over the cap'], [['id'], 'a reserved column'],
        [['reg_code'], 'a reserved column'], [['first_name; DROP'], 'not a field'],
    ] as [any, string][]) {
        const r = await put(keys);
        assert.strictEqual(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual(p.one(`SELECT meal_display_fields AS v FROM ${CONF} WHERE id = ?`, s.cid).v, null);
    // A field of ANOTHER conference is not a field of this one.
    await ensureField(p, s.other, 'talla', 'Talla');
    assert.strictEqual((await put(['@name', 'talla'])).status, 400);
    assert.strictEqual((await put(['@name'], 999999)).status, 404);
    assert.strictEqual((await p.call('put', '/meals/display-fields', { body: { keys: ['@name'] } })).status, 400);
    assert.strictEqual((await p.call('get', '/meals/display-fields')).status, 400);
    assert.strictEqual((await p.call('get', '/meals/display-fields?conference_id=999999')).status, 404);

    // Order kept (after the name, always first), duplicates collapsed.
    const saved = ok(await put(['dieta', '@room', 'dieta', '@name']));
    assert.deepStrictEqual(saved.keys, ['@name', 'dieta', '@room']);
    assert.strictEqual(saved.configured, true);
    assert.deepStrictEqual((await get()).keys, ['@name', 'dieta', '@room']);
    assert.deepStrictEqual((await get(s.other)).keys, ['@name', '@location'], 'per conference');

    // Reset with null → the default again.
    const reset = ok(await put(null));
    assert.deepStrictEqual(reset.keys, ['@name', '@location']);
    assert.strictEqual(reset.configured, false);
    assert.strictEqual(p.one(`SELECT meal_display_fields AS v FROM ${CONF} WHERE id = ?`, s.cid).v, null);
});

test('display fields: a deleted form field is ignored on read; nothing left = the default', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    await ensureField(p, s.cid, 'alergias', 'Alergias');
    p.exec(`UPDATE ${INS} SET alergias = 'Maní' WHERE id = ?`, s.people.ready.id);
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['alergias', '@name'] } }));
    const check = async () => ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
    assert.deepStrictEqual((await check()).person.fields.map((f: any) => [f.key, f.value]), [['@name', 'Ana Pérez'], ['alergias', 'Maní']]);

    const fid = p.one(`SELECT id FROM ${FIELDS} WHERE conference_id = ? AND name = 'alergias'`, s.cid).id;
    ok(await p.call('delete', `/fields/${fid}`));
    assert.deepStrictEqual((await check()).person.fields.map((f: any) => f.key), ['@name'], 'the deleted field is dropped, the rest kept in order');
    assert.ok(!JSON.stringify(await check()).includes('Maní'), 'its value (still in the column) never travels');
    assert.deepStrictEqual(ok(await p.call('get', `/meals/display-fields?conference_id=${s.cid}`)).keys, ['@name']);

    // Only deleted fields stored → the default.
    p.exec(`UPDATE ${CONF} SET meal_display_fields = ? WHERE id = ?`, JSON.stringify(['alergias', 'gone']), s.cid);
    assert.deepStrictEqual((await check()).person.fields.map((f: any) => f.key), ['@name', '@location']);
    // A corrupt stored value → the default, never a 500.
    for (const bad of ['{not json', '{"a":1}', '42', '']) {
        p.exec(`UPDATE ${CONF} SET meal_display_fields = ? WHERE id = ?`, bad, s.cid);
        assert.deepStrictEqual((await check()).person.fields.map((f: any) => f.key), ['@name', '@location'], bad);
    }
});

test('a configured field whose column is missing never breaks a scan (empty value, the delivery still works)', async () => {
    const p = await bootPlugin();
    const s = await scenario(p);
    // A field row without its column (a failed ADD COLUMN on some engine).
    p.exec(`INSERT INTO ${FIELDS} (conference_id, name, label, type, sort_order) VALUES (?, 'ghost_col', 'Fantasma', 'text', 99)`, s.cid);
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['@name', 'ghost_col', 'dieta'] } }));
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: any[]) => { warned.push(args.join(' ')); };
    try {
        const v = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
        assert.strictEqual(v.result, 'ready');
        assert.deepStrictEqual(v.person.fields.map((f: any) => [f.key, f.value]), [['@name', 'Ana Pérez'], ['ghost_col', null], ['dieta', 'Vegetariana']]);
        assert.strictEqual(ok(await p.call('post', '/meals/deliver', { body: { service_id: s.svc, code: s.people.ready.code } })).result, 'delivered');
    } finally { console.warn = warn; }
    assert.ok(warned.some(w => /delivery card fields unreadable/.test(w)), 'the broken column is reported in the log');
});

// ── Migration ────────────────────────────────────────────────────────────────────────────────────────

const columns = (p: P) => p.q(`PRAGMA table_info(${CONF})`).map((c: any) => c.name);

test('migration: a fresh install has the column; an existing schema gets it on boot, data intact; restarts keep the setting', async () => {
    const fresh = await bootPlugin();
    assert.ok(columns(fresh).includes('meal_display_fields'), 'fresh install');

    const p = await bootPlugin();
    const s = await scenario(p);
    // The schema of a 2.15.x install: no column yet.
    p.exec(`ALTER TABLE ${CONF} DROP COLUMN meal_display_fields`);
    assert.ok(!columns(p).includes('meal_display_fields'));
    // Before the boot that adds it, a scan still works (the default applies) — a failed migration never
    // breaks the kitchen.
    const before = ok(await p.call('post', '/meals/check', { body: { service_id: s.svc, code: s.people.ready.code } }));
    assert.strictEqual(before.result, 'ready');
    assert.deepStrictEqual(before.person.fields.map((f: any) => f.key), ['@name', '@location']);
    const confs = p.q(`SELECT id, name, slug FROM ${CONF} ORDER BY id`);

    await p.reboot();
    assert.ok(columns(p).includes('meal_display_fields'), 'added on boot');
    assert.deepStrictEqual(p.q(`SELECT id, name, slug FROM ${CONF} ORDER BY id`), confs, 'conferences untouched');
    assert.deepStrictEqual(p.q(`SELECT meal_display_fields AS v FROM ${CONF}`).map((r: any) => r.v), confs.map(() => null), 'existing conferences start with the default');
    ok(await p.call('put', '/meals/display-fields', { body: { conference_id: s.cid, keys: ['dieta', '@location'] } }));

    await p.reboot();
    await p.reboot();
    assert.deepStrictEqual(ok(await p.call('get', `/meals/display-fields?conference_id=${s.cid}`)).keys, ['@name', 'dieta', '@location'], 'kept across restarts');
    assert.deepStrictEqual(p.logs.filter((l: any) => l[0] !== 'log' && /meal_display_fields|ALTER TABLE/.test(l[1])), [], 'the migration logs no failure');
});
