/**
 * conference-manager 2.18.0 — beds per location («camas por localidad»): ONE room shared by several locations.
 *
 * The site owner: «si a una localidad le quiero dar n número de camas de hotel y eso hace que una habitación
 * esté a medias, ¿las siguientes camas se pueden asignar a otra localidad?» — yes, by beds. Pinned against the
 * REAL plugin (fixtures/conference-manager-harness.ts):
 *   - PUT /rooms/:id/beds splits a room: each location gets N beds there, the rest are pool beds; one location
 *     with every bed is its whole room; no share is a pool room; the occupants must fit the new split;
 *   - POST /locations/:id/beds gives a location N FREE beds: empty rooms whole first, then shared beds; it is
 *     all-or-nothing (409 `not_enough_beds` with `available`) and never moves anybody;
 *   - GET /hotels reports each room's shares (taken / given) and its pool beds;
 *   - a person takes a bed of their location's share first, then a pool bed — the admin's manual assign, the
 *     conference-wide run and the coordinator's portal all hold to it; the portal sees only its own beds and
 *     people of a shared room, and never a pool bed;
 *   - allotting a shared room whole, deleting its room / hotel / a sharing location, and resizing it keep the
 *     split consistent, and every location whose beds change is stamped once reviewed (2.17.0 adjustments).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type Plugin } from './fixtures/conference-manager-harness';

const T = (n: string) => `wjp_conference_manager_${n}`;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

/** A coordinator's portal call: the portal authenticates with its own token (never a WordJS session). */
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
/**
 * A conference with three locations (Norte, Sur, Oeste) and one hotel «Dorado» whose rooms are all in the
 * pool and empty: A1 (2 beds), A2 (2) and A3 (4).
 */
async function world() {
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `beds-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const loc = async (name: string) => ok(await p.call('post', '/locations', { body: { conference_id: cid, name, capacity: 50 } })).id as number;
    const norte = await loc('Norte'), sur = await loc('Sur'), oeste = await loc('Oeste');
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Dorado' } })).id as number;
    const room = async (room_number: string, capacity: number) => ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number, capacity } })).id as number;
    const a1 = await room('A1', 2), a2 = await room('A2', 2), a3 = await room('A3', 4);
    const person = async (first_name: string, location_id: number | null) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, ...(location_id ? { location_id } : {}) } }), first_name).id as number;
    const shares = (roomId: number) => p.q(`SELECT location_id, beds FROM ${T('room_beds')} WHERE room_id = ? ORDER BY location_id`, roomId) as { location_id: number; beds: number }[];
    const ownerOf = (roomId: number) => p.one(`SELECT location_id FROM ${T('rooms')} WHERE id = ?`, roomId).location_id as number | null;
    const roomOf = (id: number) => (p.one(`SELECT room_id FROM ${T('inscriptions')} WHERE id = ?`, id) || {}).room_id ?? null;
    const assign = (id: number, room_id: number | null) => p.call('post', `/inscriptions/${id}/assign`, { body: { room_id } });
    const tokenOf = async (location_id: number) => {
        const code = p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, location_id).code;
        return ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id, code } })).token as string;
    };
    const hotelRoom = async (roomId: number) => {
        const hotels = ok(await p.call('get', `/hotels?conference_id=${cid}`)) as any[];
        return hotels.flatMap(h => h.rooms || []).find((r: any) => Number(r.id) === roomId);
    };
    return { p, cid, norte, sur, oeste, hotel, a1, a2, a3, person, shares, ownerOf, roomOf, assign, tokenOf, hotelRoom };
}

test('PUT /rooms/:id/beds splits a room between locations; every bed to one location is its whole room, none is the pool', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }), 'split');
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }]);
    assert.strictEqual(w.ownerOf(w.a3), null, 'a shared room belongs to no single location');

    const listed = await w.hotelRoom(w.a3);
    assert.deepStrictEqual(listed.shares.map((s: any) => [s.location_name, s.beds, s.occupied]), [['Norte', 2, 0], ['Sur', 1, 0]]);
    assert.strictEqual(listed.pool_beds, 1);
    assert.strictEqual(listed.pool_occupied, 0);
    assert.deepStrictEqual((await w.hotelRoom(w.a1)).shares, [], 'a pool room has no share');

    // The locations listing counts the shared room and its beds.
    const locs = ok(await p.call('get', `/locations?conference_id=${w.cid}`)).locations as any[];
    const norte = locs.find(l => l.id === w.norte);
    assert.strictEqual(norte.rooms_allotted, 1);
    assert.strictEqual(norte.beds_allotted, 2);

    // Every bed to Norte = Norte's whole room (no share rows); then nothing = the pool.
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 4 }] } }), 'whole');
    assert.strictEqual(w.ownerOf(w.a3), w.norte);
    assert.deepStrictEqual(w.shares(w.a3), []);
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [] } }), 'pool');
    assert.strictEqual(w.ownerOf(w.a3), null);
    assert.deepStrictEqual(w.shares(w.a3), []);

    // Refusals: more beds than the room has, a location twice, a location of another conference, junk.
    const bad = [
        [{ location_id: w.norte, beds: 3 }, { location_id: w.sur, beds: 2 }],
        [{ location_id: w.norte, beds: 1 }, { location_id: w.norte, beds: 1 }],
        [{ location_id: 999999, beds: 1 }],
        [{ location_id: w.norte, beds: -1 }],
        [{ location_id: w.norte, beds: 1.5 }],
    ];
    for (const shares of bad) {
        const r = await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares } });
        assert.strictEqual(r.status, 400, `${JSON.stringify(shares)} → ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual((await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: 'x' } })).status, 400);
    assert.strictEqual((await p.call('put', `/rooms/999999/beds`, { body: { shares: [] } })).status, 404);
    assert.deepStrictEqual(w.shares(w.a3), [], 'no refused split wrote anything');
});

test('a person takes one of their location\'s beds first, then a pool bed; the admin\'s manual assign holds to it', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    const n1 = await w.person('N1', w.norte), n2 = await w.person('N2', w.norte), n3 = await w.person('N3', w.norte), n4 = await w.person('N4', w.norte);
    const s1 = await w.person('S1', w.sur), s2 = await w.person('S2', w.sur);
    const o1 = await w.person('O1', w.oeste);

    ok(await w.assign(n1, w.a3), 'N1 — Norte bed');
    ok(await w.assign(n2, w.a3), 'N2 — Norte bed');
    ok(await w.assign(n3, w.a3), 'N3 — the pool bed (overflow)');
    // Norte's 2 beds and the pool bed are taken: N4 and O1 have nowhere; Sur's bed is Sur's.
    const n4r = await w.assign(n4, w.a3);
    assert.strictEqual(n4r.status, 400, JSON.stringify(n4r.body));
    assert.match(n4r.body.error, /camas de su localidad/);
    const o1r = await w.assign(o1, w.a3);
    assert.strictEqual(o1r.status, 400, JSON.stringify(o1r.body));
    assert.match(o1r.body.error, /repartida entre localidades/);
    ok(await w.assign(s1, w.a3), 'S1 — Sur bed');
    assert.strictEqual((await w.assign(s2, w.a3)).status, 400, 'the room is full');
    assert.deepStrictEqual([n1, n2, n3, s1].map(w.roomOf), [w.a3, w.a3, w.a3, w.a3]);

    const listed = await w.hotelRoom(w.a3);
    assert.deepStrictEqual(listed.shares.map((s: any) => [s.location_name, s.occupied]), [['Norte', 2], ['Sur', 1]]);
    assert.strictEqual(listed.pool_occupied, 1);

    // The split must keep fitting its occupants: giving the pool bed to Sur leaves N3 without a bed.
    const squeeze = await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 2 }] } });
    assert.strictEqual(squeeze.status, 409, JSON.stringify(squeeze.body));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 3 }, { location_id: w.sur, beds: 1 }] } }), 'N3 now in a Norte bed');
    // Whole to Norte is refused while Sur sleeps there; capacity never drops below the beds given.
    assert.strictEqual((await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 4 }] } })).status, 409);
    const shrink = await p.call('put', `/rooms/${w.a3}`, { body: { capacity: 3 } });
    assert.strictEqual(shrink.status, 400, JSON.stringify(shrink.body));

    // Moving N1 to Oeste: no Oeste bed and no free pool bed in A3 → N1 leaves the room.
    ok(await p.call('put', `/inscriptions/${n1}`, { body: { location_id: w.oeste } }), 'move N1');
    assert.strictEqual(w.roomOf(n1), null);
});

test('the conference-wide run fills each location\'s beds with its own people and the pool beds with everyone else', async () => {
    const w = await world();
    const { p } = w;
    // Only A3 counts: A1 and A2 go to Oeste whole and stay empty (Oeste has nobody).
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.oeste, room_ids: [w.a1, w.a2] } }));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    const norte = [await w.person('N1', w.norte), await w.person('N2', w.norte), await w.person('N3', w.norte)];
    const sur = [await w.person('S1', w.sur), await w.person('S2', w.sur)];
    const loose = [await w.person('L1', null), await w.person('L2', null)];

    ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    const inA3 = (ids: number[]) => ids.filter(id => w.roomOf(id) === w.a3).length;
    assert.strictEqual(inA3(norte), 2, 'Norte fills its 2 beds; the pool bed went to the pool\'s own people first');
    assert.strictEqual(inA3(sur), 1, 'Sur fills its bed');
    assert.strictEqual(inA3(loose), 1, 'the pool bed goes to the pool');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE room_id = ?`, w.a3).n, 4);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE room_id IN (?, ?)`, w.a1, w.a2).n, 0, 'Oeste\'s rooms stay Oeste\'s');

    // A second run changes nothing (everything that fits is placed).
    ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run again');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE room_id = ?`, w.a3).n, 4);
});

test('the conference-wide run puts the people a location\'s beds cannot hold in the pool beds left — after the pool\'s own people', async () => {
    const w = await world();
    const { p } = w;
    // A1 is Oeste's (whole), A2 stays in the pool (2 beds), A3 is split Norte 2 / Sur 1 / pool 1.
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.oeste, room_ids: [w.a1] } }));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    const norte = [await w.person('N1', w.norte), await w.person('N2', w.norte), await w.person('N3', w.norte), await w.person('N4', w.norte), await w.person('N5', w.norte)];
    const s1 = await w.person('S1', w.sur);
    const loose = await w.person('L1', null);

    // The coordinator's own run never takes a pool bed: Norte's 2 beds, nothing more.
    const tn = await w.tokenOf(w.norte);
    ok(await portal(p, 'post', '/portal/lodging/run', tn), 'portal run');
    assert.strictEqual(norte.filter(id => w.roomOf(id) != null).length, 2);

    const run = ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    // The pool's own person first, then Norte's leftovers in the 2 pool beds still free; one stays out.
    assert.notStrictEqual(w.roomOf(loose), null, 'the pool person has a bed');
    assert.strictEqual(w.roomOf(s1), w.a3);
    assert.strictEqual(norte.filter(id => w.roomOf(id) != null).length, 4);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE room_id = ?`, w.a1).n, 0, 'Oeste\'s room is never a pool bed');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE room_id IN (?, ?)`, w.a2, w.a3).n, 6, 'every pool bed is used');
    const line = run.by_location.find((l: any) => l.location_id === w.norte);
    assert.deepStrictEqual([line.assignedCount, line.pool_beds, line.remaining], [2, 2, 1]);
    assert.deepStrictEqual(line.violations.map((v: any) => v.detail), ['1 inscrito quedó sin cupo — faltan habitaciones.']);
    assert.strictEqual(run.remaining, 1);
    assert.ok(run.violations.some((v: any) => v.detail === '«Norte»: 1 inscrito quedó sin cupo — faltan habitaciones.'), JSON.stringify(run.violations));
    // The split still holds: Norte's people beyond its 2 beds are on pool beds, which the listing shows.
    const a3 = await w.hotelRoom(w.a3);
    assert.strictEqual(a3.occupied, 4);

    // A location whose arrangement is submitted / validated is not touched, overflow included.
    const sur2 = await w.person('S2', w.sur);
    const ts = await w.tokenOf(w.sur);
    ok(await portal(p, 'post', '/portal/lodging/submit', ts), 'Sur submits');
    ok(await w.assign(norte.find(id => w.roomOf(id) != null && w.roomOf(id) === w.a2)!, null), 'free a pool bed');
    const again = ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run again');
    assert.strictEqual(w.roomOf(sur2), null, 'Sur is frozen: S2 waits');
    assert.ok(again.skipped_frozen.some((l: any) => l.location_id === w.sur));
    assert.strictEqual(norte.filter(id => w.roomOf(id) != null).length, 4, 'Norte takes the freed pool bed again');
});

test('the overflow is the admin\'s: admin rules only, and pool beds only — never a bed of the location\'s own share', async () => {
    const w = await world();
    const { p } = w;
    // The «Género» field (fields are added while the form is unpublished).
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }), 'unpublish');
    ok(await p.call('post', '/fields', { body: { conference_id: w.cid, template: 'gender' } }), 'gender field');
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: true } }), 'publish');
    const genderOpt = (p.one(`SELECT options FROM ${T('fields')} WHERE conference_id = ? AND name = 'gender'`, w.cid).options as string).split(',').map(s => s.trim());
    // A1 is Oeste's; A3 is split Norte 2 / pool 2; A2 stays a pool room.
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.oeste, room_ids: [w.a1] } }));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }] } }));
    const tn = await w.tokenOf(w.norte);
    // Norte's own HARD rule: never mix genders.
    ok(await portal(p, 'post', '/portal/lodging/rules', tn, { name: 'Separar género', type: 'separate_by', config: 'gender', hard: 1, enabled: 1, priority: 10 }), 'Norte rule');
    const m1 = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'M1', gender: genderOpt[0], location_id: w.norte } })).id;
    const f1 = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'F1', gender: genderOpt[1], location_id: w.norte } })).id;

    const run = ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    // Norte's run puts M1 on one of its beds and refuses F1 next to him (its own rule). The overflow — the
    // admin's — may not fill Norte's free bed in A3, so F1 takes the pool room A2.
    assert.strictEqual(w.roomOf(m1), w.a3);
    assert.strictEqual(w.roomOf(f1), w.a2, 'a pool bed, never Norte\'s own free bed');
    const line = run.by_location.find((l: any) => l.location_id === w.norte);
    assert.deepStrictEqual([line.assignedCount, line.pool_beds, line.remaining], [2, 1, 0]);
    const a3 = await w.hotelRoom(w.a3);
    assert.deepStrictEqual([a3.shares[0].occupied, a3.pool_occupied], [1, 0]);
});

test('the sweep reports each companion breach once, on the final rooms, and blames no sharing location for a pool bed', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.oeste, room_ids: [w.a1] } }));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 1 }, { location_id: w.sur, beds: 1 }] } }));
    // A soft conference rule: a «Kid» needs an «Adult» in the room.
    ok(await p.call('post', '/assignment/rules', { body: { conference_id: w.cid, name: 'Niño con adulto', type: 'require_companion', hard: 0, enabled: 1, priority: 5,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Kid' }], needs: [{ field: 'first_name', op: 'contains', value: 'Adult' }], min: 1 } } }), 'rule');
    await w.person('Kid1', null);
    await w.person('NorteOne', w.norte);
    await w.person('SurOne', w.sur);
    const run = ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }), 'run');
    const details = run.violations.map((v: any) => v.detail);
    assert.strictEqual(new Set(details).size, details.length, `no breach twice: ${JSON.stringify(details)}`);
    const companion = details.filter((d: string) => d.includes('Niño con adulto'));
    assert.strictEqual(companion.length, 1, JSON.stringify(details));
    assert.ok(!companion[0].startsWith('«'), 'a pool / shared room breach is the conference\'s, not a sharing location\'s');
    for (const l of run.by_location) assert.ok(!l.violations.some((v: any) => v.detail.includes('Niño con adulto')), `${l.name}: ${JSON.stringify(l.violations)}`);
});

test('a coordinator\'s own rule never reads nor reacts to another location\'s people in a shared room', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 2 }] } }));
    const val = await w.person('Valentina', w.sur);
    ok(await w.assign(val, w.a3), 'Valentina (Sur) in A3');
    const tn = await w.tokenOf(w.norte);
    // A probe rule: «a room with a Val… needs a zz-nobody». If Norte's run judged Sur's people, it would
    // report A3 — telling the coordinator that someone called Val… sleeps there.
    ok(await portal(p, 'post', '/portal/lodging/rules', tn, { name: 'Sonda', type: 'require_companion', hard: 0, enabled: 1, priority: 1,
        params: { subject: [{ field: 'first_name', op: 'contains', value: 'Val' }], needs: [{ field: 'first_name', op: 'eq', value: 'zz-nobody' }], min: 1 } }), 'probe rule');
    await w.person('NorteOne', w.norte);
    const run = ok(await portal(p, 'post', '/portal/lodging/run', tn), 'portal run');
    assert.ok(!JSON.stringify(run.violations || []).includes('A3'), JSON.stringify(run.violations));
    const view = ok(await portal(p, 'get', '/portal/lodging', tn), 'view');
    assert.ok(!JSON.stringify(view).includes('Valentina'), 'Sur\'s person never reaches Norte\'s portal');
});

test('«Dar camas» turns the location\'s people already on pool beds into its share, and gives the beds asked on top', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.oeste, room_ids: [w.a1, w.a2] } }));
    const n1 = await w.person('N1', w.norte), n2 = await w.person('N2', w.norte);
    ok(await w.assign(n1, w.a3)); ok(await w.assign(n2, w.a3));   // the admin, on pool beds of A3 (4 beds)
    const given = ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 1 } }), 'Norte +1');
    assert.deepStrictEqual(given.shared_rooms.map((r: any) => [r.room_number, r.beds, r.added]), [['A3', 3, 1]]);
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 3 }], 'N1 and N2 are on Norte\'s beds now, and 1 more is free');
    const a3 = await w.hotelRoom(w.a3);
    assert.deepStrictEqual([a3.shares[0].occupied, a3.pool_beds, a3.pool_occupied], [2, 1, 0]);
    // Only the pool bed is free to give (Norte's own free bed is Norte's already); taking it makes A3 Norte's.
    assert.strictEqual((await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 2 } })).body.available, 1);
    ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 1 } }), 'Norte +1 more');
    assert.strictEqual(w.ownerOf(w.a3), w.norte);
    assert.deepStrictEqual(w.shares(w.a3), []);
});

test('the coordinator neither empties nor moves the people the administration put on pool beds of a shared room', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.norte, room_ids: [w.a1] } }));
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 1 }] } }));
    const n1 = await w.person('N1', w.norte), n2 = await w.person('N2', w.norte), n3 = await w.person('N3', w.norte);
    ok(await w.assign(n1, w.a3)); ok(await w.assign(n2, w.a3));   // N2 on a pool bed — the admin's call
    ok(await w.assign(n3, w.a1));
    const tn = await w.tokenOf(w.norte);
    for (const [body, what] of [[{ inscription_id: n2, room_id: null }, 'unassign'], [{ inscription_id: n1, room_id: w.a1 }, 'move out']] as const) {
        const r = await portal(p, 'post', '/portal/lodging/assign', tn, body);
        assert.strictEqual(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /camas del pool/);
    }
    ok(await portal(p, 'post', '/portal/lodging/reset', tn), 'reset');
    assert.deepStrictEqual([n1, n2, n3].map(w.roomOf), [w.a3, w.a3, null], 'reset keeps the admin\'s pool placements, empties the rest');
    // Once the admin takes N2 off the pool bed, the coordinator manages A3 again.
    ok(await w.assign(n2, null));
    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n1, room_id: null }), 'unassign within its beds');
});

test('the coordinator sees only its own beds and people of a shared room, fills only its beds, and resets only its people', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    const n1 = await w.person('N1', w.norte), n2 = await w.person('N2', w.norte), n3 = await w.person('N3', w.norte);
    const s1 = await w.person('S1', w.sur);
    ok(await w.assign(s1, w.a3), 'S1 by the admin');
    const tn = await w.tokenOf(w.norte);

    const view = ok(await portal(p, 'get', '/portal/lodging', tn), 'view');
    const room = view.rooms.find((r: any) => r.id === w.a3);
    assert.ok(room, 'the shared room is part of Norte\'s arrangement');
    assert.strictEqual(room.capacity, 2, 'Norte sees its 2 beds');
    assert.strictEqual(room.occupied, 0, 'Sur\'s person is not Norte\'s');
    assert.deepStrictEqual(room.occupants, []);
    assert.deepStrictEqual(room.shared, { beds: 2, room_capacity: 4 });
    const me = ok(await portal(p, 'get', '/portal/me', tn), 'me');
    assert.strictEqual(me.lodging?.rooms_allotted ?? me.rooms_allotted, 1);

    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n1, room_id: w.a3 }), 'N1');
    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n2, room_id: w.a3 }), 'N2');
    const third = await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n3, room_id: w.a3 });
    assert.strictEqual(third.status, 400, `the pool bed is the admin's: ${JSON.stringify(third.body)}`);
    assert.strictEqual(w.roomOf(n3), null);

    // A room only Sur shares is not Norte's at all.
    ok(await p.call('put', `/rooms/${w.a1}/beds`, { body: { shares: [{ location_id: w.sur, beds: 1 }] } }));
    assert.strictEqual((await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n3, room_id: w.a1 })).status, 404);

    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n1, room_id: null }), 'free N1');
    assert.strictEqual(w.roomOf(n1), null);
    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n1, room_id: w.a3 }), 'N1 again');
    ok(await portal(p, 'post', '/portal/lodging/submit', tn), 'a placement in a shared room is an arrangement to submit');
    ok(await portal(p, 'post', '/portal/lodging/withdraw', tn), 'withdraw');
    ok(await portal(p, 'post', '/portal/lodging/reset', tn), 'reset');
    assert.deepStrictEqual([n1, n2, s1].map(w.roomOf), [null, null, w.a3], 'Sur\'s person stays');
});

test('POST /locations/:id/beds gives free beds: empty rooms whole first, then shared beds; all or nothing', async () => {
    const w = await world();
    const { p } = w;
    const given = ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 5, hotel_id: w.hotel } }), 'Norte 5');
    assert.deepStrictEqual(given.whole_rooms.map((r: any) => r.room_number), ['A1', 'A2']);
    assert.deepStrictEqual(given.shared_rooms.map((r: any) => [r.room_number, r.beds, r.added]), [['A3', 1, 1]]);
    assert.deepStrictEqual([w.ownerOf(w.a1), w.ownerOf(w.a2), w.ownerOf(w.a3)], [w.norte, w.norte, null]);
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 1 }]);

    // Sur asks for 4: only 3 free beds are left → 409, nothing written.
    const short = await p.call('post', `/locations/${w.sur}/beds`, { body: { beds: 4 } });
    assert.strictEqual(short.status, 409, JSON.stringify(short.body));
    assert.strictEqual(short.body.code, 'not_enough_beds');
    assert.strictEqual(short.body.error, 'Solo quedan 3 camas libres; pediste 4.');
    assert.strictEqual(short.body.available, 3);
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 1 }]);

    ok(await p.call('post', `/locations/${w.sur}/beds`, { body: { beds: 3 } }), 'Sur 3');
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 1 }, { location_id: w.sur, beds: 3 }]);
    assert.strictEqual((await w.hotelRoom(w.a3)).pool_beds, 0);
    const none = await p.call('post', `/locations/${w.oeste}/beds`, { body: { beds: 1, hotel_id: w.hotel } });
    assert.strictEqual(none.body.available, 0);
    assert.strictEqual(none.body.error, 'No quedan camas libres en ese hotel; pediste 1.');

    // Norte gets 2 more of A3 after Sur gives some back: the bed count of its share grows (one row).
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 1 }, { location_id: w.sur, beds: 1 }] } }));
    ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 2 } }), 'Norte +2');
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 3 }, { location_id: w.sur, beds: 1 }]);

    for (const beds of [0, -1, 1.5, 'x', 5001]) assert.strictEqual((await p.call('post', `/locations/${w.norte}/beds`, { body: { beds } })).status, 400, String(beds));
    assert.strictEqual((await p.call('post', '/locations/999999/beds', { body: { beds: 1 } })).status, 404);
});

test('a room with somebody inside is never taken whole by «Dar camas», and nobody is moved', async () => {
    const w = await world();
    const { p } = w;
    const o1 = await w.person('O1', w.oeste);
    ok(await w.assign(o1, w.a1), 'O1 in the pool room A1');
    const given = ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 3 } }), 'Norte 3');
    assert.deepStrictEqual(given.whole_rooms.map((r: any) => r.room_number), ['A2']);
    assert.deepStrictEqual(given.shared_rooms.map((r: any) => [r.room_number, r.added]), [['A1', 1]], 'A1\'s free bed, shared');
    assert.strictEqual(w.roomOf(o1), w.a1, 'O1 keeps the pool bed');
    assert.deepStrictEqual(w.shares(w.a1), [{ location_id: w.norte, beds: 1 }]);
});

test('allotting a shared room whole, resizing it, and deleting its room, hotel or a sharing location keep the split consistent', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    const n1 = await w.person('N1', w.norte), s1 = await w.person('S1', w.sur);
    ok(await w.assign(n1, w.a3)); ok(await w.assign(s1, w.a3));

    // Whole to Norte through the hotel allotment: refused while Sur sleeps there; fine once S1 leaves.
    assert.strictEqual((await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.norte, room_ids: [w.a3] } })).status, 409);
    ok(await w.assign(s1, null));
    ok(await p.call('post', `/hotels/${w.hotel}/allot`, { body: { location_id: w.norte, room_ids: [w.a3] } }), 'whole');
    assert.strictEqual(w.ownerOf(w.a3), w.norte);
    assert.deepStrictEqual(w.shares(w.a3), [], 'the split is gone with the whole allotment');

    // Back to a split, then delete Sur: its share goes and S1 (back in a Sur bed) leaves the room.
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }, { location_id: w.sur, beds: 1 }] } }));
    ok(await w.assign(s1, w.a3));
    ok(await p.call('delete', `/locations/${w.sur}`), 'delete Sur');
    assert.deepStrictEqual(w.shares(w.a3), [{ location_id: w.norte, beds: 2 }]);
    assert.strictEqual(w.roomOf(n1), w.a3, 'Norte\'s people stay');

    // Capacity may grow (more pool beds) but never below the beds given.
    ok(await p.call('put', `/rooms/${w.a3}`, { body: { capacity: 5 } }), 'grow');
    assert.strictEqual((await w.hotelRoom(w.a3)).pool_beds, 3);
    assert.strictEqual((await p.call('put', `/rooms/${w.a3}`, { body: { capacity: 1 } })).status, 400);

    // Deleting the room deletes its shares; so does deleting the hotel.
    ok(await p.call('delete', `/rooms/${w.a3}`), 'delete A3');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('room_beds')} WHERE room_id = ?`, w.a3).n, 0);
    assert.strictEqual(w.roomOf(n1), null);
    ok(await p.call('put', `/rooms/${w.a1}/beds`, { body: { shares: [{ location_id: w.norte, beds: 1 }] } }));
    ok(await p.call('delete', `/hotels/${w.hotel}`), 'delete hotel');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('room_beds')}`).n, 0);
});

test('a split that changes a VALIDATED location\'s beds is an administration adjustment on it', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 2 }] } }));
    const n1 = await w.person('N1', w.norte);
    const tn = await w.tokenOf(w.norte);
    ok(await portal(p, 'post', '/portal/lodging/assign', tn, { inscription_id: n1, room_id: w.a3 }));
    ok(await portal(p, 'post', '/portal/lodging/submit', tn));
    ok(await p.call('post', `/locations/${w.norte}/lodging/validate`));

    const r = ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.norte, beds: 3 }, { location_id: w.sur, beds: 1 }] } }), 'resplit');
    assert.deepStrictEqual(r.lodging_adjusted.map((x: any) => [x.name, x.status]), [['Norte', 'validated']]);
    const row = p.one(`SELECT lodging_status, lodging_admin_changes FROM ${T('locations')} WHERE id = ?`, w.norte);
    assert.strictEqual(row.lodging_status, 'validated', 'it stays validated');
    assert.strictEqual(row.lodging_admin_changes, 1);

    // The same split again changes nothing and stamps nothing.
    const same = ok(await p.call('put', `/rooms/${w.a3}/beds`, { body: { shares: [{ location_id: w.sur, beds: 1 }, { location_id: w.norte, beds: 3 }] } }), 'same');
    assert.deepStrictEqual(same.lodging_adjusted, []);
    const g = ok(await p.call('post', `/locations/${w.norte}/beds`, { body: { beds: 1, hotel_id: w.hotel } }), 'give Norte 1');
    assert.deepStrictEqual(g.lodging_adjusted.map((x: any) => x.name), ['Norte']);
});
