/**
 * conference-manager 2.31.0 — «Requiere hospedaje».
 *
 * The site owner: «en el formulario irá un switch para decir si requiere o no hospedaje y la asignación debe
 * tener eso en cuenta; igual para los encargados de cada localidad: no debe dejar asignar a esas personas, ni
 * automáticamente ni manualmente». Pinned against the REAL plugin (fixtures/conference-manager-harness.ts):
 *   - the `lodging` template adds a `switch` field `needs_lodging`, stored as «Sí» / «No» (true/false, si/no,
 *     1/0, on/off accepted; anything else 400); a custom field may not take that column;
 *   - whoever answers «No» is skipped by the conference-wide run, a location's own run and «Sugerir reparto»,
 *     and a manual placement — the admin's POST /inscriptions/:id/assign and the coordinator's
 *     POST /portal/lodging/assign — is refused (400); taking them out of a room still works;
 *   - they are no «sin habitación»: the portal lists them apart (`no_lodging`), GET /locations does not count
 *     them as unlodged, and a location whose only attendees need no lodging has nothing to submit;
 *   - switching an attendee to «No» frees the bed they held; deleting the field clears every answer;
 *   - blank, or a form without the field, means the attendee needs lodging (nothing changes).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type Plugin } from './fixtures/conference-manager-harness';

const T = (n: string) => `wjp_conference_manager_${n}`;
const NO_LODGING = 'Este participante indicó que no requiere hospedaje: no se le puede asignar habitación.';
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function portal(p: Plugin, method: string, url: string, token: string, body?: any) {
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

let seq = 0;
/** «Norte» owns rooms 101 and 102 (2 beds each); room 201 stays in the pool. Nobody placed yet. */
async function world({ lodgingField = true } = {}) {
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `nl-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    if (lodgingField) ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'lodging' } }), 'lodging template');
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } })).id as number;
    const sol = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Hotel Sol' } })).id as number;
    const room = async (room_number: string) => ok(await p.call('post', '/rooms', { body: { hotel_id: sol, room_number, capacity: 2 } })).id as number;
    const r101 = await room('101'), r102 = await room('102'), r201 = await room('201');
    ok(await p.call('post', `/hotels/${sol}/allot`, { body: { location_id: norte, room_ids: [r101, r102] } }));
    const person = async (first_name: string, extra: Record<string, unknown> = {}, location_id: number | null = norte) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, ...(location_id ? { location_id } : {}), ...extra } }), first_name).id as number;
    const code = p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, norte).code;
    const token = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: norte, code } })).token as string;
    const roomOf = (id: number) => (p.one(`SELECT room_id FROM ${T('inscriptions')} WHERE id = ?`, id) || {}).room_id ?? null;
    const answerOf = (id: number) => (p.one(`SELECT needs_lodging FROM ${T('inscriptions')} WHERE id = ?`, id) || {}).needs_lodging ?? null;
    return { p, cid, norte, sol, r101, r102, r201, person, token, roomOf, answerOf };
}

test('the lodging template is a Sí / No switch on needs_lodging; values are canonicalised, others refused', async () => {
    const w = await world();
    const field = w.p.one(`SELECT name, type, role FROM ${T('fields')} WHERE conference_id = ? AND name = 'needs_lodging'`, w.cid);
    assert.deepStrictEqual({ ...field }, { name: 'needs_lodging', type: 'switch', role: 'lodging' });
    // A second copy is refused like any template.
    assert.strictEqual((await w.p.call('post', '/fields', { body: { conference_id: w.cid, template: 'lodging' } })).status, 400, 'published form');

    for (const [raw, stored] of [[true, 'Sí'], [false, 'No'], ['si', 'Sí'], ['Sí', 'Sí'], ['NO', 'No'], ['0', 'No'], ['on', 'Sí'], ['', '']] as const) {
        const id = await w.person(`P${String(raw)}`, { needs_lodging: raw });
        assert.strictEqual(w.answerOf(id), stored, `${JSON.stringify(raw)} → ${stored}`);
    }
    const bad = await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'X', location_id: w.norte, needs_lodging: 'tal vez' } });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
});

test('a custom field may not take the needs_lodging column, and the template stays a switch', async () => {
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'C', slug: `nl-${++seq}` } })).id as number;
    const custom = await p.call('post', '/fields', { body: { conference_id: cid, name: 'needs_lodging', label: 'Hospedaje', type: 'text' } });
    assert.strictEqual(custom.status, 400, JSON.stringify(custom.body));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'lodging' } }));
    const f = p.one(`SELECT id FROM ${T('fields')} WHERE conference_id = ? AND name = 'needs_lodging'`, cid);
    const retype = await p.call('post', '/fields', { body: { id: f.id, conference_id: cid, label: 'Hospedaje', type: 'select', options: 'Sí, No' } });
    assert.strictEqual(retype.status, 400, JSON.stringify(retype.body));
    ok(await p.call('post', '/fields', { body: { id: f.id, conference_id: cid, label: '¿Necesitas hospedaje?', type: 'switch' } }), 'relabel');
});

test('the admin cannot place a «No» by hand; the conference-wide run skips them', async () => {
    const w = await world();
    const ana = await w.person('Ana', { needs_lodging: 'No' });
    const bea = await w.person('Bea', { needs_lodging: 'Sí' });
    const cam = await w.person('Cam');                       // blank: needs lodging
    const pool = await w.person('Pol', { needs_lodging: false }, null);

    for (const [who, room] of [[ana, w.r101], [pool, w.r201]]) {
        const r = await w.p.call('post', `/inscriptions/${who}/assign`, { body: { room_id: room } });
        assert.strictEqual(r.status, 400, JSON.stringify(r.body));
        assert.strictEqual(r.body.error, NO_LODGING);
        assert.strictEqual(w.roomOf(who), null);
    }

    ok(await w.p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    assert.strictEqual(w.roomOf(ana), null, 'Ana said No');
    assert.strictEqual(w.roomOf(pool), null, 'the pool run skips a No too');
    assert.notStrictEqual(w.roomOf(bea), null, 'Bea needs a bed');
    assert.notStrictEqual(w.roomOf(cam), null, 'blank = needs a bed');

    // GET /locations does not count the No as unlodged; the roster filter «sin asignar» leaves them out.
    const locs = ok(await w.p.call('get', `/locations?conference_id=${w.cid}`));
    const norte = (locs.locations || locs).find((l: any) => l.id === w.norte);
    assert.strictEqual(Number(norte.unlodged), 0, JSON.stringify(norte));
});

test('the coordinator cannot place a «No» by hand; the location run skips them; the portal lists them apart', async () => {
    const w = await world();
    const ana = await w.person('Ana', { needs_lodging: 'No' });
    const bea = await w.person('Bea');

    const r = await portal(w.p, 'post', '/portal/lodging/assign', w.token, { inscription_id: ana, room_id: w.r101 });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, NO_LODGING);

    const view = ok(await portal(w.p, 'get', '/portal/lodging', w.token));
    assert.deepStrictEqual(view.unassigned.map((a: any) => a.id), [bea]);
    assert.deepStrictEqual(view.no_lodging.map((a: any) => a.id), [ana]);
    assert.strictEqual(view.counts.unassigned, 1);

    ok(await portal(w.p, 'post', '/portal/lodging/run', w.token), 'location run');
    assert.strictEqual(w.roomOf(ana), null);
    assert.notStrictEqual(w.roomOf(bea), null);
});

test('a location whose only attendees need no lodging has nothing to submit', async () => {
    const w = await world();
    await w.person('Ana', { needs_lodging: 'No' });
    const sub = await portal(w.p, 'post', '/portal/lodging/submit', w.token);
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.body));
});

test('«Sugerir reparto» plans no bed for a «No»', async () => {
    const w = await world();
    const ana = await w.person('Ana', { needs_lodging: 'No' });
    await w.person('Bea');
    const plan = ok(await w.p.call('post', '/assignment/plan', { body: { conference_id: w.cid } }), 'plan').plan;
    assert.ok(plan.placements.length > 0 && !plan.placements.some((x: any) => Number(x.inscription_id) === ana), JSON.stringify(plan.placements));
});

test('switching to «No» frees the bed; switching back makes them assignable again', async () => {
    const w = await world();
    const ana = await w.person('Ana');
    ok(await w.p.call('post', `/inscriptions/${ana}/assign`, { body: { room_id: w.r101 } }));
    assert.strictEqual(w.roomOf(ana), w.r101);

    ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { needs_lodging: 'No' } }), 'switch off');
    assert.strictEqual(w.answerOf(ana), 'No');
    assert.strictEqual(w.roomOf(ana), null, 'the bed is freed');

    ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { needs_lodging: 'Sí' } }), 'switch on');
    ok(await w.p.call('post', `/inscriptions/${ana}/assign`, { body: { room_id: w.r102 } }), 'assignable again');
    assert.strictEqual(w.roomOf(ana), w.r102);
});

test('deleting the field clears every answer: everyone needs lodging again', async () => {
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'C', slug: `nl-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'lodging' } }));
    const ana = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Ana', needs_lodging: 'No' } })).id as number;
    const f = p.one(`SELECT id FROM ${T('fields')} WHERE conference_id = ? AND name = 'needs_lodging'`, cid);
    ok(await p.call('delete', `/fields/${f.id}`), 'delete field');
    assert.strictEqual(p.one(`SELECT needs_lodging FROM ${T('inscriptions')} WHERE id = ?`, ana).needs_lodging, null);
});

test('a conference without the field behaves as before', async () => {
    const w = await world({ lodgingField: false });
    const ana = await w.person('Ana', { needs_lodging: 'No' });   // not a form field: ignored
    assert.strictEqual(w.answerOf(ana), null);
    ok(await w.p.call('post', `/inscriptions/${ana}/assign`, { body: { room_id: w.r101 } }));
    assert.strictEqual(w.roomOf(ana), w.r101);
});

// The administration's automatic assignment, every way it can run (the site owner: «en la asignación automática del
// admin tampoco se le debe asignar hospedaje»). Plenty of free beds everywhere, so only the switch can keep anyone out.
test('the admin automatic assignment never lodges a «No»: the run, a second run, the pool overflow, simulate and «Sugerir reparto» → Aplicar', async () => {
    const w = await world();
    // Norte has 4 beds of its own (101, 102) and the pool has 201: four Norte people who need a bed overflow into the pool.
    const nos = [await w.person('No1', { needs_lodging: 'No' }), await w.person('No2', { needs_lodging: 'No' }), await w.person('NoPool', { needs_lodging: 'No' }, null)];
    const yes = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) yes.push(await w.person(n, { needs_lodging: 'Sí' }));
    const noneLodged = () => { for (const id of nos) assert.strictEqual(w.roomOf(id), null, `#${id} said No`); };

    const sim = ok(await w.p.call('post', '/assignment/simulate', { body: { conference_id: w.cid } }), 'simulate');
    assert.ok(!sim.placements.some((x: any) => nos.includes(Number(x.inscription_id))), JSON.stringify(sim.placements));

    const run = ok(await w.p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    noneLodged();
    assert.strictEqual(yes.filter(id => w.roomOf(id) != null).length, 5, 'the five who need a bed are placed (one overflows to the pool)');
    assert.strictEqual(run.remaining, 0, 'nobody who needs a bed is left waiting');
    ok(await w.p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'second run');
    noneLodged();

    // Reset, then «Sugerir reparto» → Aplicar (which ends with a run of its own).
    ok(await w.p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }), 'reset');
    const plan = ok(await w.p.call('post', '/assignment/plan', { body: { conference_id: w.cid } }), 'plan').plan;
    assert.ok(!plan.placements.some((x: any) => nos.includes(Number(x.inscription_id))));
    const applied = await w.p.call('post', '/assignment/plan/apply', { body: { conference_id: w.cid, token: plan.token } });
    assert.ok(applied.status === 200 || applied.status === 409, JSON.stringify(applied.body));
    noneLodged();
    ok(await w.p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run after the plan');
    noneLodged();
});
