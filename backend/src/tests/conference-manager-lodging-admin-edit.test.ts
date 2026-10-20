/**
 * conference-manager 2.17.0 — the administration adjusts a lodging arrangement that a location SUBMITTED,
 * or that it VALIDATED, without reopening it.
 *
 * The site owner: «cuando una localidad manda una validación de hospedajes, el admin la valida pero no puede
 * cambiar nada de esa asignación» (and, earlier, «no le puedes quitar ninguna funcionalidad al admin»).
 * Until now a location whose lodging_status was submitted | validated was frozen for EVERYONE: every admin
 * lodging write answered 409 «reábrelo antes de …». Pinned here against the REAL plugin
 * (fixtures/conference-manager-harness.ts):
 *   - every admin write route the freeze refused goes through on a submitted / validated location: placing,
 *     moving and freeing its attendees, allotting rooms to it or taking them away, resizing and deleting its
 *     rooms and hotels, moving an attendee out of it, cancelling or deleting one who holds one of its beds;
 *   - the status stays as it is (validated stays validated, the review stamps untouched) and each change is
 *     an ADMINISTRATION ADJUSTMENT stamped on the location (when, who, how many since the last submission),
 *     reported as `lodging_adjusted`, shown to the admin (GET /locations, the review) and to the coordinator
 *     (GET /portal/lodging — never who: GET /portal/me does not leak the admin's login either);
 *   - a no-op write stamps nothing, and a change to a DRAFT location is no adjustment;
 *   - the coordinator's portal stays locked (409) while submitted / validated;
 *   - Hospedaje › gestionar is what adjusts (administrators and team roles with it); a role that may only
 *     manage inscriptions cannot move someone who holds a bed OUT of a reviewed arrangement (409), but its
 *     cancellation still frees the bed, as before, and is stamped;
 *   - the bed rule: an attendee WITHOUT a bed is part of no arrangement — entering, leaving, being cancelled,
 *     deleted or registered into a reviewed location takes inscriptions:manage alone and is never stamped,
 *     the same in both directions;
 *   - «Reabrir» keeps working; a validation keeps the stamp; the coordinator's next submission clears it;
 *   - the conference-wide run and reset still skip frozen locations;
 *   - concurrency: the stamp is a compare-and-set on the status, taken under the same lock as every status
 *     transition — a coordinator submitting or withdrawing while the admin edits never leaves a stamp that
 *     disagrees with the response, nor a stamp on a draft;
 *   - the three columns are added idempotently (twice = no warning) and every path copes without them.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, ADMIN, type HarnessUser, type Plugin } from './fixtures/conference-manager-harness';

const T = (n: string) => `wjp_conference_manager_${n}`;
const TEAM_ROLE = 'conference_manager_team';
const LODGER: HarnessUser = { id: 20, role: TEAM_ROLE, userLogin: 'lodger', userEmail: 'lodger@example.test', displayName: 'Lodger' };
const VIEWER: HarnessUser = { id: 21, role: TEAM_ROLE, userLogin: 'viewer', userEmail: 'viewer@example.test', displayName: 'Viewer' };
const CLERK: HarnessUser = { id: 22, role: TEAM_ROLE, userLogin: 'clerk', userEmail: 'clerk@example.test', displayName: 'Clerk' };
const PORTAL_FROZEN = 'El hospedaje está en validación/validado y no se puede modificar.';

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
 * A conference with two locations: «Norte» (rooms 101, 102 of Hotel Sol and M1 of Hotel Mar) and «Sur» (103);
 * room 201 stays in the pool. Norte: ana + bea in 101, eve in 102, dan without a room; Sur: carl in 103.
 * Everything placed by the admin while every location is a draft (no adjustment yet).
 */
async function world(opts: { users?: HarnessUser[] } = {}) {
    const p = await bootPlugin({ users: opts.users || [] });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `adj-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } })).id as number;
    const sur = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 50 } })).id as number;
    const sol = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Hotel Sol' } })).id as number;
    const mar = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Hotel Mar' } })).id as number;
    const room = async (hotel_id: number, room_number: string) => ok(await p.call('post', '/rooms', { body: { hotel_id, room_number, capacity: 2 } })).id as number;
    const r101 = await room(sol, '101'), r102 = await room(sol, '102'), r103 = await room(sol, '103'), r201 = await room(sol, '201');
    const m1 = await room(mar, 'M1');
    ok(await p.call('post', `/hotels/${sol}/allot`, { body: { location_id: norte, room_ids: [r101, r102] } }));
    ok(await p.call('post', `/hotels/${sol}/allot`, { body: { location_id: sur, room_ids: [r103] } }));
    ok(await p.call('post', `/hotels/${mar}/allot`, { body: { location_id: norte } }));
    const person = async (first_name: string, location_id: number) => ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, location_id } }), first_name).id as number;
    const ana = await person('Ana', norte), bea = await person('Bea', norte), eve = await person('Eve', norte), dan = await person('Dan', norte);
    const carl = await person('Carl', sur);
    for (const [who, r] of [[ana, r101], [bea, r101], [eve, r102], [carl, r103]]) ok(await p.call('post', `/inscriptions/${who}/assign`, { body: { room_id: r } }));
    const code = p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, norte).code;
    const token = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: norte, code } })).token as string;
    const loc = (id = norte) => p.one(`SELECT lodging_status, lodging_reviewed_at, lodging_reviewed_by, lodging_admin_changed_at, lodging_admin_changed_by, lodging_admin_changes FROM ${T('locations')} WHERE id = ?`, id);
    const roomOf = (id: number) => (p.one(`SELECT room_id FROM ${T('inscriptions')} WHERE id = ?`, id) || {}).room_id ?? null;
    const submit = async () => ok(await portal(p, 'post', '/portal/lodging/submit', token), 'submit');
    const validate = async () => ok(await p.call('post', `/locations/${norte}/lodging/validate`), 'validate');
    return { p, cid, norte, sur, sol, mar, r101, r102, r103, r201, m1, ana, bea, eve, dan, carl, token, loc, roomOf, submit, validate };
}
type World = Awaited<ReturnType<typeof world>>;

const NORTE_ADJUSTED = (w: World, status: string) => [{ location_id: w.norte, name: 'Norte', status }];

test('every admin write the freeze refused goes through on a VALIDATED location; it stays validated and each change is stamped', async () => {
    const w = await world();
    const { p } = w;
    await w.submit();
    await w.validate();
    const reviewed = w.loc();
    assert.strictEqual(reviewed.lodging_status, 'validated');
    assert.strictEqual(reviewed.lodging_admin_changed_at, null, 'nothing adjusted yet');

    const steps: [string, () => Promise<any>, () => void][] = [
        ['move ana from 101 to 102 (assign)', () => p.call('post', `/inscriptions/${w.ana}/assign`, { body: { room_id: w.r102 } }), () => assert.strictEqual(w.roomOf(w.ana), w.r102)],
        ['place dan, who had no room (assign)', () => p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r101 } }), () => assert.strictEqual(w.roomOf(w.dan), w.r101)],
        ['free bea (assign null)', () => p.call('post', `/inscriptions/${w.bea}/assign`, { body: { room_id: null } }), () => assert.strictEqual(w.roomOf(w.bea), null)],
        ['resize room 102 (PUT /rooms)', () => p.call('put', `/rooms/${w.r102}`, { body: { capacity: 3 } }), () => assert.strictEqual(p.one(`SELECT capacity FROM ${T('rooms')} WHERE id = ?`, w.r102).capacity, 3)],
        ['allot the pool room 201 to Norte (POST /hotels/:id/allot)', () => p.call('post', `/hotels/${w.sol}/allot`, { body: { location_id: w.norte, room_ids: [w.r201] } }), () => assert.strictEqual(p.one(`SELECT location_id FROM ${T('rooms')} WHERE id = ?`, w.r201).location_id, w.norte)],
        ['send room 201 back to the pool (PUT /rooms)', () => p.call('put', `/rooms/${w.r201}`, { body: { location_id: null } }), () => assert.strictEqual(p.one(`SELECT location_id FROM ${T('rooms')} WHERE id = ?`, w.r201).location_id, null)],
        ['allot room 201 to Norte again (PUT /rooms)', () => p.call('put', `/rooms/${w.r201}`, { body: { location_id: w.norte } }), () => assert.strictEqual(p.one(`SELECT location_id FROM ${T('rooms')} WHERE id = ?`, w.r201).location_id, w.norte)],
        ['delete Norte\'s room 201 (DELETE /rooms)', () => p.call('delete', `/rooms/${w.r201}`), () => assert.strictEqual(p.one(`SELECT id FROM ${T('rooms')} WHERE id = ?`, w.r201), undefined)],
        ['move ana out of Norte, to Sur (PUT /inscriptions)', () => p.call('put', `/inscriptions/${w.ana}`, { body: { location_id: w.sur } }), () => {
            const a = p.one(`SELECT location_id, room_id FROM ${T('inscriptions')} WHERE id = ?`, w.ana);
            assert.deepStrictEqual([a.location_id, a.room_id], [w.sur, null], 'moved, and the Norte bed freed');
        }],
        ['cancel dan, who holds a bed of 101 (PUT /inscriptions)', () => p.call('put', `/inscriptions/${w.dan}`, { body: { status: 'cancelled' } }), () => assert.strictEqual(w.roomOf(w.dan), null)],
        ['delete eve, who holds a bed of 102 (DELETE /inscriptions)', () => p.call('delete', `/inscriptions/${w.eve}`), () => assert.strictEqual(p.one(`SELECT id FROM ${T('inscriptions')} WHERE id = ?`, w.eve), undefined)],
        ['delete Hotel Mar, whose room M1 is Norte\'s (DELETE /hotels)', () => p.call('delete', `/hotels/${w.mar}`), () => assert.strictEqual(p.one(`SELECT id FROM ${T('rooms')} WHERE id = ?`, w.m1), undefined)],
    ];
    let n = 0;
    for (const [label, run, check] of steps) {
        const r = await run();
        assert.strictEqual(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
        check();
        n++;
        assert.deepStrictEqual(r.body.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'), `${label}: reported as an adjustment of Norte`);
        const now = w.loc();
        assert.strictEqual(now.lodging_status, 'validated', `${label}: still validated`);
        assert.strictEqual(now.lodging_admin_changes, n, `${label}: counted`);
        assert.ok(now.lodging_admin_changed_at, `${label}: stamped`);
        assert.strictEqual(now.lodging_admin_changed_by, 'boss');
        assert.strictEqual(now.lodging_reviewed_at, reviewed.lodging_reviewed_at, `${label}: the review stamp is untouched`);
        assert.strictEqual(now.lodging_reviewed_by, reviewed.lodging_reviewed_by);
    }
    // Sur (a draft) took ana in: no adjustment of anybody's reviewed arrangement there.
    assert.strictEqual(w.loc(w.sur).lodging_admin_changed_at, null);
    assert.strictEqual(w.loc(w.sur).lodging_admin_changes, 0);

    // What the admin reads.
    const list = ok(await p.call('get', `/locations?conference_id=${w.cid}`));
    const norte = list.locations.find((l: any) => l.id === w.norte);
    assert.strictEqual(norte.lodging_status, 'validated');
    assert.strictEqual(norte.lodging_admin_changes, steps.length);
    assert.ok(norte.lodging_admin_changed_at);
    assert.strictEqual(norte.lodging_admin_changed_by, 'boss');
    const review = ok(await p.call('get', `/locations/${w.norte}/lodging`));
    assert.strictEqual(review.location.lodging_admin_changes, steps.length);
    assert.strictEqual(review.location.lodging_admin_changed_by, 'boss');

    // MySQL refuses an UPDATE whose subquery reads the table it updates (error 1093): no statement of these
    // flows does that to the locations table (the stamp is a plain conditional UPDATE).
    const L = T('locations');
    const selfRef = p.sqlLog.filter(s => new RegExp(`^\\s*UPDATE\\s+${L}\\b`, 'i').test(s) && new RegExp(`\\(\\s*SELECT[\\s\\S]*\\bFROM\\s+${L}\\b`, 'i').test(s));
    assert.deepStrictEqual(selfRef, []);
});

test('a SUBMITTED location: the admin adjusts it before validating — visible in the review, kept by the validation', async () => {
    const w = await world();
    const { p } = w;
    await w.submit();
    const moved = ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } }));
    assert.deepStrictEqual(moved.lodging_adjusted, NORTE_ADJUSTED(w, 'submitted'));
    const allot = ok(await p.call('post', `/hotels/${w.sol}/allot`, { body: { location_id: w.norte, room_ids: [w.r201] } }));
    assert.deepStrictEqual(allot.lodging_adjusted, NORTE_ADJUSTED(w, 'submitted'));
    assert.strictEqual(w.loc().lodging_status, 'submitted', 'still waiting for the review');
    assert.strictEqual(w.loc().lodging_admin_changes, 2);

    // The review shows the arrangement as it is now, and that the administration changed it.
    const review = ok(await p.call('get', `/locations/${w.norte}/lodging`));
    assert.strictEqual(review.location.lodging_status, 'submitted');
    assert.strictEqual(review.location.lodging_admin_changes, 2);
    assert.ok(review.location.lodging_admin_changed_at);
    assert.strictEqual(review.location.lodging_admin_changed_by, 'boss');
    assert.ok(review.rooms.find((r: any) => r.id === w.r102).occupants.some((o: any) => o.id === w.dan), 'dan is shown where the admin put him');
    assert.ok(review.rooms.some((r: any) => r.id === w.r201), 'room 201 is part of the arrangement');

    // Validating keeps the stamp: the coordinator must still learn the validated arrangement is not
    // exactly the one sent.
    await w.validate();
    const v = w.loc();
    assert.strictEqual(v.lodging_status, 'validated');
    assert.strictEqual(v.lodging_admin_changes, 2);
    assert.ok(v.lodging_admin_changed_at);
});

test('a no-op write stamps nothing, and a change to a DRAFT location is no adjustment', async () => {
    const w = await world();
    const { p } = w;
    // Draft: the admin's placements are the arrangement the coordinator is still building — no stamp.
    const draft = ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } }));
    assert.deepStrictEqual(draft.lodging_adjusted, []);
    assert.strictEqual(w.loc().lodging_admin_changed_at, null);
    ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: null } }));

    await w.submit();
    await w.validate();
    const noops: [string, () => Promise<any>][] = [
        ['ana into the room she is in', () => p.call('post', `/inscriptions/${w.ana}/assign`, { body: { room_id: w.r101 } })],
        ['free dan, who has no room', () => p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: null } })],
        ['allot Norte\'s rooms to Norte', () => p.call('post', `/hotels/${w.sol}/allot`, { body: { location_id: w.norte, room_ids: [w.r101, w.r102] } })],
        ['a note on room 101', () => p.call('put', `/rooms/${w.r101}`, { body: { notes: 'vista al mar', room_number: '101-A' } })],
        ['the same capacity for room 101', () => p.call('put', `/rooms/${w.r101}`, { body: { capacity: 2 } })],
        ['a notes-only edit of ana', () => p.call('put', `/inscriptions/${w.ana}`, { body: { notes: 'llega tarde' } })],
        ['delete dan, who has no room', () => p.call('delete', `/inscriptions/${w.dan}`)],
    ];
    for (const [label, run] of noops) {
        const r = await run();
        assert.strictEqual(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(r.body.lodging_adjusted, [], label);
        assert.strictEqual(w.loc().lodging_admin_changed_at, null, `${label}: no stamp`);
        assert.strictEqual(w.loc().lodging_admin_changes, 0, label);
    }
});

test('the coordinator\'s portal stays locked while submitted / validated, and shows the stamp — never who made it', async () => {
    const w = await world();
    const { p, token } = w;
    ok(await portal(p, 'post', '/portal/lodging/rules', token, { name: 'Familias', type: 'keep_together', config: 'first_name' }), 'a rule while draft');
    const ruleId = p.one(`SELECT id FROM ${T('assignment_rules')} WHERE location_id = ?`, w.norte).id;
    await w.submit();
    ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } }));

    const writes: [string, string, any?][] = [
        ['post', '/portal/lodging/assign', { inscription_id: w.ana, room_id: w.r102 }],
        ['post', '/portal/lodging/assign', { inscription_id: w.ana, room_id: null }],
        ['post', '/portal/lodging/run'],
        ['post', '/portal/lodging/reset'],
        ['post', '/portal/lodging/rules', { name: 'Otra', type: 'separate_by', config: 'first_name' }],
        ['delete', `/portal/lodging/rules/${ruleId}`],
    ];
    for (const status of ['submitted', 'validated']) {
        if (status === 'validated') await w.validate();
        assert.strictEqual(w.loc().lodging_status, status);
        for (const [m, url, body] of writes) {
            const r = await portal(p, m, url, token, body);
            assert.strictEqual(r.status, 409, `${status} ${m} ${url}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.error, PORTAL_FROZEN, `${status} ${m} ${url}`);
        }
        assert.strictEqual((await portal(p, 'post', '/portal/lodging/submit', token)).status, 409);
        assert.strictEqual(w.roomOf(w.ana), w.r101, 'nothing the portal sent landed');
        assert.ok(p.one(`SELECT id FROM ${T('assignment_rules')} WHERE id = ?`, ruleId), 'the rule is still there');

        const view = ok(await portal(p, 'get', '/portal/lodging', token));
        assert.strictEqual(view.status, status);
        assert.strictEqual(view.can_edit, false);
        assert.strictEqual(view.admin_changes, 1);
        assert.ok(view.admin_changed_at, '«Ajustado por la administración el …»');
        assert.ok(!JSON.stringify(view).includes('boss'), 'the portal never names the admin');
        assert.ok(!Object.keys(view).some(k => /changed_by/.test(k)));
        const me = ok(await portal(p, 'get', '/portal/me', token));
        assert.deepStrictEqual(Object.keys(me).filter(k => /lodging_admin/.test(k)), [], '/portal/me carries no stamp column');
        assert.ok(!JSON.stringify(me).includes('boss'), '/portal/me does not leak the admin\'s login');
    }
    // A validated arrangement cannot be withdrawn by the coordinator either.
    assert.strictEqual((await portal(p, 'post', '/portal/lodging/withdraw', token)).status, 409);
});

test('Hospedaje › gestionar adjusts (team roles included); Hospedaje › ver does not; Inscripciones › gestionar cannot move someone who holds a bed out of a reviewed arrangement', async () => {
    const w = await world({ users: [LODGER, VIEWER, CLERK] });
    const { p } = w;
    const member = async (u: HarnessUser, permissions: any) => {
        const role = ok(await p.call('post', '/staff/roles', { body: { name: `Rol ${u.userLogin}`, permissions } })).id;
        ok(await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: role } }), String(u.userLogin));
    };
    await member(LODGER, { lodging: 'manage' });
    await member(VIEWER, { lodging: 'view', locations: 'view' });
    await member(CLERK, { inscriptions: 'manage' });
    await w.submit();
    await w.validate();

    // The team member with Hospedaje › gestionar adjusts, and the stamp names them.
    const lodger = await p.call('post', `/inscriptions/${w.dan}/assign`, { user: LODGER, body: { room_id: w.r102 } });
    assert.strictEqual(lodger.status, 200, JSON.stringify(lodger.body));
    assert.deepStrictEqual(lodger.body.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.strictEqual(w.loc().lodging_admin_changed_by, 'lodger');
    const allot = await p.call('post', `/hotels/${w.sol}/allot`, { user: LODGER, body: { location_id: w.norte, room_ids: [w.r201] } });
    assert.strictEqual(allot.status, 200, JSON.stringify(allot.body));
    // GET /locations: the count for everyone on the team, who made it only for Localidades › ver.
    const asLodger = ok(await p.call('get', `/locations?conference_id=${w.cid}`, { user: LODGER })).locations.find((l: any) => l.id === w.norte);
    assert.strictEqual(asLodger.lodging_admin_changes, 2);
    assert.ok(asLodger.lodging_admin_changed_at);
    assert.strictEqual(asLodger.lodging_admin_changed_by, null);
    const asViewer = ok(await p.call('get', `/locations?conference_id=${w.cid}`, { user: VIEWER })).locations.find((l: any) => l.id === w.norte);
    assert.strictEqual(asViewer.lodging_admin_changed_by, 'lodger');

    // Hospedaje › ver: 403, as for any lodging write.
    assert.strictEqual((await p.call('post', `/inscriptions/${w.dan}/assign`, { user: VIEWER, body: { room_id: null } })).status, 403);

    // Inscripciones › gestionar only: moving someone who holds one of its beds OUT of the validated arrangement
    // changes it — 409.
    const out = await p.call('put', `/inscriptions/${w.ana}`, { user: CLERK, body: { location_id: w.sur } });
    assert.strictEqual(out.status, 409, JSON.stringify(out.body));
    assert.match(out.body.error, /Norte/);
    assert.match(out.body.error, /Hospedaje/);
    const ana = p.one(`SELECT location_id, room_id FROM ${T('inscriptions')} WHERE id = ?`, w.ana);
    assert.deepStrictEqual([ana.location_id, ana.room_id], [w.norte, w.r101], 'nothing changed');
    assert.strictEqual(w.loc().lodging_admin_changes, 2);
    // …while out of a DRAFT location it still may (control), and the administrator may out of a validated one.
    const fromSur = await p.call('put', `/inscriptions/${w.carl}`, { user: CLERK, body: { location_id: w.norte } });
    assert.strictEqual(fromSur.status, 200, JSON.stringify(fromSur.body));
    assert.deepStrictEqual(fromSur.body.lodging_adjusted, []);
    // A cancellation still frees the bed, as before the change (no lodging permission needed) — stamped.
    const cancel = await p.call('put', `/inscriptions/${w.bea}`, { user: CLERK, body: { status: 'cancelled' } });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
    assert.strictEqual(w.roomOf(w.bea), null);
    assert.deepStrictEqual(cancel.body.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.strictEqual(w.loc().lodging_admin_changes, 3);
    assert.strictEqual(w.loc().lodging_admin_changed_by, 'clerk');
    const admin = await p.call('put', `/inscriptions/${w.ana}`, { user: ADMIN, body: { location_id: w.sur } });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.body));
    assert.strictEqual(w.loc().lodging_admin_changes, 4);
});

test('«Reabrir» still works; the stamp outlives it and the validation; the coordinator\'s next submission clears it', async () => {
    const w = await world();
    const { p, token } = w;
    await w.submit();
    await w.validate();
    ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } }));
    const stamped = w.loc();
    assert.strictEqual(stamped.lodging_admin_changes, 1);

    // Reopen: back to the coordinator (draft), who sees what the administration changed.
    ok(await p.call('post', `/locations/${w.norte}/lodging/reopen`));
    assert.strictEqual(w.loc().lodging_status, 'draft');
    assert.strictEqual(w.loc().lodging_admin_changes, 1, 'the stamp survives the reopening');
    const view = ok(await portal(p, 'get', '/portal/lodging', token));
    assert.strictEqual(view.status, 'draft');
    assert.strictEqual(view.can_edit, true);
    assert.strictEqual(view.admin_changes, 1);
    // The coordinator edits again (unlocked), then submits: the new submission is the coordinator's, as it
    // stands — the stamp starts over.
    ok(await portal(p, 'post', '/portal/lodging/assign', token, { inscription_id: w.dan, room_id: null }), 'portal edit after reopen');
    await w.submit();
    const fresh = w.loc();
    assert.strictEqual(fresh.lodging_status, 'submitted');
    assert.strictEqual(fresh.lodging_admin_changes, 0);
    assert.strictEqual(fresh.lodging_admin_changed_at, null);
    assert.strictEqual(fresh.lodging_admin_changed_by, null);
    // Validate / return / reopen keep their compare-and-set: a validated arrangement cannot be validated
    // or returned again, and only a validated one is reopened.
    await w.validate();
    assert.strictEqual((await p.call('post', `/locations/${w.norte}/lodging/validate`)).status, 409);
    assert.strictEqual((await p.call('post', `/locations/${w.norte}/lodging/return`, { body: { note: 'x' } })).status, 409);
    ok(await p.call('post', `/locations/${w.norte}/lodging/reopen`));
    assert.strictEqual((await p.call('post', `/locations/${w.norte}/lodging/reopen`)).status, 409);
});

test('the conference-wide run and reset still skip a submitted / validated location', async () => {
    const w = await world();
    const { p } = w;
    await w.submit();
    await w.validate();
    const run = ok(await p.call('post', '/assignment/run', { body: { conference_id: w.cid } }));
    assert.deepStrictEqual(run.skipped_frozen.map((l: any) => [l.location_id, l.status]), [[w.norte, 'validated']]);
    assert.strictEqual(w.roomOf(w.dan), null, 'the run placed nobody of Norte');
    // Its report counts who it left without a bed there (dan): its «pendientes» are remaining + those, the
    // explorer's «N sin asignar» once the run is done — not «Pendientes: 0» next to «1 sin asignar».
    assert.deepStrictEqual(run.skipped_frozen.map((l: any) => l.unassigned), [1]);
    assert.strictEqual(run.skipped_unassigned, 1);
    const stillUnassigned = p.one(`SELECT COUNT(*) AS n FROM ${T('inscriptions')} WHERE conference_id = ? AND room_id IS NULL AND (status IS NULL OR status != 'cancelled')`, w.cid).n;
    assert.strictEqual(run.remaining + run.skipped_unassigned, stillUnassigned);
    const reset = ok(await p.call('post', '/assignment/reset', { body: { conference_id: w.cid } }));
    // With its status, as the run's report: the admin panel names it («ya está validado»).
    assert.deepStrictEqual(reset.skipped_frozen.map((l: any) => [l.location_id, l.status]), [[w.norte, 'validated']]);
    assert.strictEqual(w.roomOf(w.ana), w.r101, 'the reset left Norte\'s arrangement alone');
    assert.strictEqual(w.roomOf(w.carl), null, 'and emptied the draft ones');
    assert.strictEqual(w.loc().lodging_admin_changed_at, null, 'no adjustment');
});

test('concurrency: the stamp is a compare-and-set on the status — never on a location that went back to draft', async () => {
    const w = await world();
    const { p } = w;
    await w.submit();
    // The coordinator's withdrawal lands between the admin's change and its stamp (the lock makes this
    // impossible in the plugin; forced here at the statement level): the stamp's UPDATE must not match.
    const log = p.sqlLog as any;
    const push = log.push;
    let flipped = false;
    log.push = function (sql: string) {
        if (!flipped && /SET lodging_admin_changed_at = CURRENT_TIMESTAMP/.test(sql)) {
            flipped = true;
            p.exec(`UPDATE ${T('locations')} SET lodging_status = 'draft' WHERE id = ?`, w.norte);
        }
        return push.call(this, sql);
    };
    const r = ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } }));
    log.push = push;
    assert.ok(flipped, 'the stamp ran');
    assert.strictEqual(w.roomOf(w.dan), w.r102, 'the change itself stands');
    assert.deepStrictEqual(r.lodging_adjusted, [], 'the response says no adjustment was recorded');
    assert.strictEqual(w.loc().lodging_admin_changes, 0, 'no stamp on a draft');
    assert.strictEqual(w.loc().lodging_admin_changed_at, null);
});

/**
 * Starts `other()` the moment `trigger` reaches the SQL guard (i.e. while the request issuing it is inside
 * its critical section), without awaiting it there: the second request then runs every step it can before
 * the lock and queues on it — the interleaving a real race produces. `second()` resolves to its result.
 */
function startDuring(p: Plugin, trigger: RegExp, other: () => Promise<any>) {
    const log = p.sqlLog as any;
    const push = log.push;
    let started: Promise<any> | null = null;
    log.push = function (sql: string) {
        if (!started && trigger.test(sql)) { log.push = push; started = other(); }
        return push.call(this, sql);
    };
    return { second: () => { log.push = push; assert.ok(started, `${trigger} was never reached`); return started!; } };
}

test('concurrency: a coordinator submitting or withdrawing while the admin edits — the stamp agrees with the order the lock gave them', async () => {
    const w = await world();
    const { p, token } = w;
    const SUBMIT_SQL = /SET lodging_status = 'submitted'/;
    const WITHDRAW_SQL = /SET lodging_status = 'draft' WHERE id = \? AND COALESCE\(lodging_status, 'draft'\) = 'submitted'/;
    const MOVE_SQL = /^UPDATE wjp_conference_manager_inscriptions SET room_id = /;
    const move = (room: number | null) => () => p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: room } });
    const send = () => portal(p, 'post', '/portal/lodging/submit', token);
    const pull = () => portal(p, 'post', '/portal/lodging/withdraw', token);

    // 1. The coordinator is submitting when the admin's change arrives: the change queues behind the
    //    submission and lands on the submitted arrangement — stamped, AFTER the submission's reset.
    let race = startDuring(p, SUBMIT_SQL, move(w.r102));
    ok(await send(), 'submit');
    let adj = ok(await race.second(), 'move during submit');
    assert.deepStrictEqual(adj.lodging_adjusted, NORTE_ADJUSTED(w, 'submitted'));
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['submitted', 1]);

    // 2. The coordinator withdraws while the admin's change is being written: the withdrawal queues; the
    //    change landed on the submitted arrangement (stamped), then the location is a draft again. The stamp
    //    is HELD for a while (a slow database): taken outside the lock, the queued withdrawal would land first
    //    and the stamp — rightly refusing a draft — would vanish from a change made on the submitted arrangement.
    p.setDbHook((sql) => (/SET lodging_admin_changed_at = CURRENT_TIMESTAMP/.test(sql) ? new Promise(r => setTimeout(r, 40)) : undefined));
    race = startDuring(p, MOVE_SQL, pull);
    adj = ok(await move(w.r201)(), 'move before withdraw');
    ok(await race.second(), 'withdraw during move');
    p.setDbHook(null);
    assert.deepStrictEqual(adj.lodging_adjusted, NORTE_ADJUSTED(w, 'submitted'));
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['draft', 2]);

    // 3. The admin's change is being written when the coordinator submits: the change landed on the draft
    //    (no adjustment); the submission that follows starts a clean stamp.
    race = startDuring(p, MOVE_SQL, send);
    adj = ok(await move(w.r102)(), 'move before submit');
    ok(await race.second(), 'submit during move');
    assert.deepStrictEqual(adj.lodging_adjusted, []);
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes, w.loc().lodging_admin_changed_at], ['submitted', 0, null]);

    // 4. The coordinator is withdrawing when the admin's change arrives: it lands on the draft — no stamp.
    race = startDuring(p, WITHDRAW_SQL, move(w.r201));
    ok(await pull(), 'withdraw');
    adj = ok(await race.second(), 'move during withdraw');
    assert.deepStrictEqual(adj.lodging_adjusted, []);
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['draft', 0]);

    // 5. Plain concurrency, both start orders: whatever the order, the response and the stamp agree.
    for (let i = 0; i < 4; i++) {
        const room = w.roomOf(w.dan) === w.r102 ? w.r201 : w.r102;
        const [a, s] = i % 2
            ? await Promise.all([move(room)(), send()])
            : await Promise.all([send(), move(room)()]).then(([x, m]) => [m, x]);
        assert.strictEqual(a.status, 200, JSON.stringify(a.body));
        assert.strictEqual(s.status, 200, JSON.stringify(s.body));
        assert.strictEqual(w.loc().lodging_admin_changes, a.body.lodging_adjusted.length ? 1 : 0, `round ${i}`);
        ok(await pull(), 'reset for the next round');
    }

    // 6. The validation and an adjustment, both orders: the arrangement ends validated and stamped once,
    //    the response naming the status the change landed on.
    for (const [first, status] of [['validate', 'validated'], ['move', 'submitted']] as const) {
        ok(await send(), 'submit');
        const validate = () => p.call('post', `/locations/${w.norte}/lodging/validate`);
        const room = w.roomOf(w.dan) === w.r102 ? w.r201 : w.r102;
        if (first === 'validate') {
            race = startDuring(p, /SET lodging_status = 'validated'/, move(room));
            ok(await validate(), 'validate');
            adj = ok(await race.second(), 'move during validate');
        } else {
            race = startDuring(p, MOVE_SQL, validate);
            adj = ok(await move(room)(), 'move before validate');
            ok(await race.second(), 'validate during move');
        }
        assert.deepStrictEqual(adj.lodging_adjusted, NORTE_ADJUSTED(w, status), first);
        assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['validated', 1], first);
        ok(await p.call('post', `/locations/${w.norte}/lodging/reopen`));
    }
});

test('migration: the stamp columns are added idempotently, and every path copes while they are missing', async () => {
    const w = await world();
    const { p, token } = w;
    const cols = () => p.q(`SELECT name FROM pragma_table_info('${T('locations')}')`).map((c: any) => c.name).filter((n: string) => n.startsWith('lodging_admin_'));
    assert.deepStrictEqual(cols().sort(), ['lodging_admin_changed_at', 'lodging_admin_changed_by', 'lodging_admin_changes']);

    // An install from before 2.17.0's adjustments: the columns do not exist.
    for (const c of ['lodging_admin_changed_at', 'lodging_admin_changed_by', 'lodging_admin_changes']) p.exec(`ALTER TABLE ${T('locations')} DROP COLUMN ${c}`);
    assert.deepStrictEqual(cols(), []);
    // Every path still works: the admin's list and review, a submission, an adjustment (its stamp is
    // skipped with a warning, never the change), the portal's view.
    const list = ok(await p.call('get', `/locations?conference_id=${w.cid}`));
    assert.strictEqual(list.locations.find((l: any) => l.id === w.norte).lodging_admin_changes, 0);
    // (console.warn captured: request-time logs are not the harness's — it only captures init.)
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: any[]) => { warned.push(a.join(' ')); };
    let adj: any;
    try {
        await w.submit();
        adj = await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } });
    } finally { console.warn = warn; }
    assert.strictEqual(adj.status, 200, JSON.stringify(adj.body));
    assert.strictEqual(w.roomOf(w.dan), w.r102, 'the change stands without the stamp columns');
    assert.ok(warned.some(m => /lodging adjustment stamp skipped/.test(m)), JSON.stringify(warned));
    assert.ok(warned.some(m => /lodging adjustment reset skipped/.test(m)), 'the submission went through without its reset');
    assert.strictEqual(p.one(`SELECT lodging_status FROM ${T('locations')} WHERE id = ?`, w.norte).lodging_status, 'submitted');
    assert.strictEqual(ok(await portal(p, 'get', '/portal/lodging', token)).admin_changes, 0);
    ok(await p.call('get', `/locations/${w.norte}/lodging`));

    // Boot = the upgrade: the columns come back; a second boot changes nothing and warns about nothing.
    p.logs.length = 0;
    await p.reboot();
    assert.deepStrictEqual(cols().sort(), ['lodging_admin_changed_at', 'lodging_admin_changed_by', 'lodging_admin_changes']);
    assert.strictEqual(w.loc().lodging_admin_changes, 0, 'the DEFAULT fills existing rows');
    await p.reboot();
    assert.deepStrictEqual(cols().sort(), ['lodging_admin_changed_at', 'lodging_admin_changed_by', 'lodging_admin_changes']);
    assert.deepStrictEqual(p.logs.filter(([lv, m]) => lv === 'warn' && /lodging_admin|ALTER TABLE/.test(m)), [], 'two boots, no ALTER warning');
    // And the stamp works again after the upgrade.
    const again = ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r201 } }));
    assert.deepStrictEqual(again.lodging_adjusted, NORTE_ADJUSTED(w, 'submitted'));
    assert.strictEqual(w.loc().lodging_admin_changes, 1);
});

// ── Round-1 review fixes ─────────────────────────────────────────────────────────────────────────────

test('deleting a POOL room, or a hotel of pool rooms, that holds a reviewed location\'s attendee is an adjustment of that location', async () => {
    const w = await world();
    const { p } = w;
    const hostal = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Hostal Pool' } })).id as number;
    const p1 = ok(await p.call('post', '/rooms', { body: { hotel_id: hostal, room_number: 'P1', capacity: 2 } })).id as number;
    const p2 = ok(await p.call('post', '/rooms', { body: { hotel_id: hostal, room_number: 'P2', capacity: 2 } })).id as number;
    // While Norte is a draft the admin puts dan in the pool room 201 and eve in the pool room P1 (Hostal Pool),
    // and Sur's carl in P2: all three are `placed_elsewhere` of their location's arrangement.
    ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r201 } }));
    ok(await p.call('post', `/inscriptions/${w.eve}/assign`, { body: { room_id: p1 } }));
    ok(await p.call('post', `/inscriptions/${w.carl}/assign`, { body: { room_id: p2 } }));
    await w.submit();
    await w.validate();
    assert.strictEqual(ok(await portal(p, 'get', '/portal/lodging', w.token)).placed_elsewhere.length, 2);

    // DELETE /rooms of a pool room with one of Norte's attendees inside: Norte's arrangement changed.
    const room = ok(await p.call('delete', `/rooms/${w.r201}`));
    assert.strictEqual(w.roomOf(w.dan), null, 'dan lost his bed');
    assert.deepStrictEqual(room.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['validated', 1]);

    // DELETE /hotels of a hotel whose pool rooms hold Norte's eve (and draft Sur's carl): Norte only.
    const hotel = ok(await p.call('delete', `/hotels/${hostal}`));
    assert.strictEqual(w.roomOf(w.eve), null, 'eve lost her bed');
    assert.deepStrictEqual(hotel.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.strictEqual(w.loc().lodging_admin_changes, 2);
    assert.strictEqual(w.loc(w.sur).lodging_admin_changes, 0, 'a draft is never stamped');

    // The coordinator learns it: the notice counts both, and nobody of Norte is shown in a pool room any more.
    const view = ok(await portal(p, 'get', '/portal/lodging', w.token));
    assert.strictEqual(view.admin_changes, 2);
    assert.deepStrictEqual(view.placed_elsewhere, []);

    // An EMPTY pool room changes nobody's arrangement.
    const spare = ok(await p.call('post', '/rooms', { body: { hotel_id: w.sol, room_number: '301', capacity: 2 } })).id as number;
    assert.deepStrictEqual(ok(await p.call('delete', `/rooms/${spare}`)).lodging_adjusted, []);
    assert.strictEqual(w.loc().lodging_admin_changes, 2);
});

test('validate / return refuse a review the admin did not see: an adjustment or a new submission in between answers 409 lodging_changed', async () => {
    const w = await world({ users: [LODGER] });
    const { p, token } = w;
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Hospedaje', permissions: { lodging: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: LODGER.id, role_id: role } }));
    const seenOf = (review: any) => ({ submitted_at: review.location.lodging_submitted_at, admin_changes: review.location.lodging_admin_changes });
    const review = async () => ok(await p.call('get', `/locations/${w.norte}/lodging`));
    await w.submit();

    // The admin opens the review; meanwhile a team member adjusts the arrangement.
    const before = await review();
    assert.strictEqual(before.location.lodging_admin_changes, 0);
    ok(await p.call('post', `/inscriptions/${w.dan}/assign`, { user: LODGER, body: { room_id: w.r102 } }));
    for (const [what, body] of [['validate', { seen: seenOf(before) }], ['return', { note: 'Revisa', seen: seenOf(before) }]] as const) {
        const r = await p.call('post', `/locations/${w.norte}/lodging/${what}`, { body });
        assert.strictEqual(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'lodging_changed', what);
        assert.match(r.body.error, /cambió mientras lo revisabas/);
        assert.strictEqual(w.loc().lodging_status, 'submitted', `${what}: nothing moved`);
        assert.strictEqual(w.loc().lodging_reviewed_at, null, `${what}: no review stamp`);
    }
    // Reviewing again (the adjustment is in it now): that review validates.
    const after = await review();
    assert.strictEqual(after.location.lodging_admin_changes, 1);
    ok(await p.call('post', `/locations/${w.norte}/lodging/validate`, { body: { seen: seenOf(after) } }));
    assert.strictEqual(w.loc().lodging_status, 'validated');

    // The coordinator withdraws and sends again between the review and the decision: a new submission.
    ok(await p.call('post', `/locations/${w.norte}/lodging/reopen`));
    await w.submit();
    p.exec(`UPDATE ${T('locations')} SET lodging_submitted_at = '2026-01-01 08:00:00' WHERE id = ?`, w.norte);
    const old = await review();
    ok(await portal(p, 'post', '/portal/lodging/withdraw', token));
    ok(await portal(p, 'post', '/portal/lodging/assign', token, { inscription_id: w.dan, room_id: null }), 'the coordinator changes it');
    await w.submit();
    const resent = await p.call('post', `/locations/${w.norte}/lodging/return`, { body: { note: 'Revisa', seen: seenOf(old) } });
    assert.strictEqual(resent.status, 409, JSON.stringify(resent.body));
    assert.strictEqual(resent.body.code, 'lodging_changed');
    ok(await p.call('post', `/locations/${w.norte}/lodging/return`, { body: { note: 'Revisa', seen: seenOf(await review()) } }));
    assert.strictEqual(w.loc().lodging_status, 'draft');

    // Without `seen` (an API caller) the status alone decides, as before; a non-submitted one is still 409.
    await w.submit();
    ok(await p.call('post', `/locations/${w.norte}/lodging/validate`));
    const again = await p.call('post', `/locations/${w.norte}/lodging/validate`, { body: { seen: seenOf(await review()) } });
    assert.strictEqual(again.status, 409);
    assert.notStrictEqual(again.body.code, 'lodging_changed', 'a validated arrangement is «no está enviado», not «cambió»');
});

test('validate with `seen` while the stamp columns are missing (a failed migration): the submission time alone decides', async () => {
    const w = await world();
    const { p, token } = w;
    for (const c of ['lodging_admin_changed_at', 'lodging_admin_changed_by', 'lodging_admin_changes']) p.exec(`ALTER TABLE ${T('locations')} DROP COLUMN ${c}`);
    const warn = console.warn;
    console.warn = () => {};
    try {
        await w.submit();
        p.exec(`UPDATE ${T('locations')} SET lodging_submitted_at = '2026-01-01 08:00:00' WHERE id = ?`, w.norte);
        const old = ok(await p.call('get', `/locations/${w.norte}/lodging`));
        ok(await portal(p, 'post', '/portal/lodging/withdraw', token));
        await w.submit();
        const stale = await p.call('post', `/locations/${w.norte}/lodging/validate`, { body: { seen: { submitted_at: old.location.lodging_submitted_at, admin_changes: 0 } } });
        assert.strictEqual(stale.status, 409, JSON.stringify(stale.body));
        assert.strictEqual(stale.body.code, 'lodging_changed');
        const fresh = ok(await p.call('get', `/locations/${w.norte}/lodging`));
        ok(await p.call('post', `/locations/${w.norte}/lodging/validate`, { body: { seen: { submitted_at: fresh.location.lodging_submitted_at, admin_changes: 0 } } }));
        assert.strictEqual(p.one(`SELECT lodging_status FROM ${T('locations')} WHERE id = ?`, w.norte).lodging_status, 'validated');
    } finally { console.warn = warn; }
});

test('moving an attendee INTO a submitted / validated location with the bed they keep is an adjustment of it, and needs Hospedaje › gestionar', async () => {
    const w = await world({ users: [CLERK] });
    const { p } = w;
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Solo inscripciones', permissions: { inscriptions: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: CLERK.id, role_id: role } }));
    const person = async (first_name: string, location_id: number) => ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name, location_id } })).id as number;
    // Sur's carl sleeps in the pool room 201 (a bed he keeps whatever his location); fred (Sur) has no room;
    // gil (Sur) sleeps in Sur's room 103 (a bed a move to Norte frees).
    ok(await p.call('post', `/inscriptions/${w.carl}/assign`, { body: { room_id: w.r201 } }));
    const fred = await person('Fred', w.sur), gil = await person('Gil', w.sur);
    ok(await p.call('post', `/inscriptions/${gil}/assign`, { body: { room_id: w.r103 } }));
    await w.submit();
    await w.validate();
    const row = (id: number) => { const r = p.one(`SELECT location_id, room_id FROM ${T('inscriptions')} WHERE id = ?`, id); return [r.location_id, r.room_id]; };
    // The roster says whose room each attendee sleeps in (the form's «entra con su cama» hint reads it).
    const roster = ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`));
    const rl = (id: number) => roster.find((x: any) => x.id === id).room_location_id;
    assert.deepStrictEqual([rl(w.carl), rl(gil), rl(fred), rl(w.ana)], [null, w.sur, null, w.norte]);

    // A role that may only manage inscriptions: carl would enter Norte's validated arrangement with his bed — 409.
    const clerk = await p.call('put', `/inscriptions/${w.carl}`, { user: CLERK, body: { location_id: w.norte } });
    assert.strictEqual(clerk.status, 409, JSON.stringify(clerk.body));
    assert.match(clerk.body.error, /Norte/);
    assert.match(clerk.body.error, /ya está validado/);
    assert.match(clerk.body.error, /Hospedaje/);
    assert.deepStrictEqual(row(w.carl), [w.sur, w.r201], 'nothing changed');
    assert.strictEqual(w.loc().lodging_admin_changes, 0);

    // Arriving WITHOUT a bed is like a new registration into Norte: no adjustment of who sleeps where.
    const noBed = await p.call('put', `/inscriptions/${fred}`, { user: CLERK, body: { location_id: w.norte } });
    assert.strictEqual(noBed.status, 200, JSON.stringify(noBed.body));
    assert.deepStrictEqual(noBed.body.lodging_adjusted, []);
    const freed = await p.call('put', `/inscriptions/${gil}`, { user: CLERK, body: { location_id: w.norte } });
    assert.strictEqual(freed.status, 200, JSON.stringify(freed.body));
    assert.deepStrictEqual(row(gil), [w.norte, null], 'Sur\'s bed freed (invariant 1): gil arrives without one');
    assert.deepStrictEqual(freed.body.lodging_adjusted, []);
    assert.strictEqual(w.loc().lodging_admin_changes, 0);

    // The administrator: carl enters Norte with his pool bed — stamped on Norte, which stays validated.
    const admin = ok(await p.call('put', `/inscriptions/${w.carl}`, { body: { location_id: w.norte } }));
    assert.deepStrictEqual(admin.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.deepStrictEqual(row(w.carl), [w.norte, w.r201], 'he keeps the pool bed');
    assert.deepStrictEqual([w.loc().lodging_status, w.loc().lodging_admin_changes], ['validated', 1]);
    const view = ok(await portal(p, 'get', '/portal/lodging', w.token));
    assert.ok(view.placed_elsewhere.some((x: any) => x.id === w.carl), 'Norte\'s coordinator sees him');
    assert.strictEqual(view.admin_changes, 1);
});

test('a refusal names the way back to a draft that the location\'s state HAS: «se devuelva al encargado» while submitted (it cannot be reopened), «se reabra» once validated', async () => {
    const w = await world({ users: [CLERK] });
    const { p } = w;
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Solo inscripciones', permissions: { inscriptions: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: CLERK.id, role_id: role } }));
    ok(await p.call('post', `/inscriptions/${w.carl}/assign`, { body: { room_id: w.r201 } }));     // Sur's carl: a pool bed
    await w.submit();
    // Submitted: «Reabrir» does not apply to it — the route refuses it — so no refusal may point there.
    assert.strictEqual((await p.call('post', `/locations/${w.norte}/lodging/reopen`)).status, 409);
    const refusals = async () => {
        const out = await p.call('put', `/inscriptions/${w.ana}`, { user: CLERK, body: { location_id: w.sur } });     // ana holds a Norte bed
        const into = await p.call('put', `/inscriptions/${w.carl}`, { user: CLERK, body: { location_id: w.norte } });  // carl keeps his pool bed
        for (const r of [out, into]) assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.match(out.body.error, /que tiene cama lo cambia/);
        assert.match(into.body.error, /entraría en él con la cama que ya tiene/);
        return [out.body.error as string, into.body.error as string];
    };
    for (const e of await refusals()) {
        assert.match(e, /está enviado a validación/);
        assert.match(e, /cuando se devuelva al encargado desde Localidades/);
        assert.doesNotMatch(e, /re[áa]br/i, `a submitted location cannot be reopened: ${e}`);
    }
    await w.validate();
    for (const e of await refusals()) {
        assert.match(e, /ya está validado/);
        assert.match(e, /cuando se reabra desde Localidades/);
        assert.doesNotMatch(e, /devuelva/);
    }
    assert.deepStrictEqual([w.roomOf(w.ana), w.roomOf(w.carl), w.loc().lodging_admin_changes], [w.r101, w.r201, 0], 'nothing changed');
});

test('the bed rule: WITHOUT a bed, entering or leaving a reviewed arrangement — or being cancelled, deleted or registered into it — takes inscriptions:manage alone and is never an adjustment, in both directions', async () => {
    const w = await world({ users: [CLERK] });
    const { p } = w;
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Solo inscripciones', permissions: { inscriptions: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: CLERK.id, role_id: role } }));
    const person = async (first_name: string, location_id: number, user: HarnessUser = ADMIN) =>
        ok(await p.call('post', '/inscriptions', { user, body: { conference_id: w.cid, first_name, location_id } }), first_name).id as number;
    const fred = await person('Fred', w.sur);                 // Sur (a draft), no room
    await w.submit();
    await w.validate();
    const row = (id: number) => { const r = p.one(`SELECT location_id, room_id FROM ${T('inscriptions')} WHERE id = ?`, id); return r ? [r.location_id, r.room_id] : null; };
    const unstamped = (what: string) => {
        const l = w.loc();
        assert.deepStrictEqual([l.lodging_status, l.lodging_admin_changes, l.lodging_admin_changed_at], ['validated', 0, null], `${what}: no adjustment of Norte`);
    };
    const put = async (id: number, body: any, user: HarnessUser, what: string) => {
        const r = await p.call('put', `/inscriptions/${id}`, { user, body });
        assert.strictEqual(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(r.body.lodging_adjusted, [], `${what}: reported as no adjustment`);
        unstamped(what);
    };

    // OUT and IN with one permission: dan (Norte, validated, no bed) leaves for Sur and comes back — the clerk.
    await put(w.dan, { location_id: w.sur }, CLERK, 'clerk: dan out of Norte');
    assert.deepStrictEqual(row(w.dan), [w.sur, null]);
    await put(w.dan, { location_id: w.norte }, CLERK, 'clerk: dan back into Norte');
    assert.deepStrictEqual(row(w.dan), [w.norte, null]);
    // The administrator, out and in: no adjustment either (no «Ajustado por la administración» for nothing).
    await put(w.dan, { location_id: w.sur }, ADMIN, 'admin: dan out of Norte');
    await put(w.dan, { location_id: w.norte }, ADMIN, 'admin: dan back into Norte');
    // Out and cancelled in ONE edit; cancelled in place; deleted — all without a bed.
    await put(fred, { location_id: w.norte }, CLERK, 'clerk: fred into Norte');
    await put(fred, { location_id: w.sur, status: 'cancelled' }, CLERK, 'clerk: fred out of Norte and cancelled');
    await put(w.dan, { status: 'cancelled' }, CLERK, 'clerk: dan cancelled in Norte');
    const del = await p.call('delete', `/inscriptions/${w.dan}`, { user: CLERK });
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.deepStrictEqual(del.body, { success: true, lodging_adjusted: [] });
    assert.strictEqual(row(w.dan), null);
    unstamped('clerk: dan deleted');
    // Registered into it: by the clerk, and by Norte's own coordinator in the portal.
    await person('Gus', w.norte, CLERK);
    unstamped('clerk: Gus registered into Norte');
    const hal = await portal(p, 'post', '/portal/inscriptions', w.token, { first_name: 'Hal' });
    assert.strictEqual(hal.status, 200, JSON.stringify(hal.body));
    unstamped('coordinator: Hal registered into Norte');
    const view = ok(await portal(p, 'get', '/portal/lodging', w.token));
    assert.deepStrictEqual([view.admin_changes, view.admin_changed_at], [0, null], 'the coordinator sees no adjustment notice');

    // Control — WITH a bed the same move is the lodging role's, and stamped: bea (Norte, room 101).
    const clerkOut = await p.call('put', `/inscriptions/${w.bea}`, { user: CLERK, body: { location_id: w.sur } });
    assert.strictEqual(clerkOut.status, 409, JSON.stringify(clerkOut.body));
    assert.deepStrictEqual(row(w.bea), [w.norte, w.r101], 'nothing changed');
    const adminOut = ok(await p.call('put', `/inscriptions/${w.bea}`, { body: { location_id: w.sur } }));
    assert.deepStrictEqual(adminOut.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.strictEqual(w.loc().lodging_admin_changes, 1);
});

/** A gate for setDbHook: `hold(re)` makes the FIRST statement matching `re` wait until `release()`. */
function gate(p: Plugin) {
    let open: () => void = () => {};
    const shut = new Promise<void>(r => { open = r; });
    let used = false;
    return {
        hold(re: RegExp) { p.setDbHook((sql) => (!used && re.test(sql) ? ((used = true), shut) : undefined)); },
        release() { open(); p.setDbHook(null); },
    };
}
const settledWithin = async (pr: Promise<any>, ms: number) => Promise.race([pr.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);

test('an inscription edit or delete that touches no bed does not queue behind the assignment lock (a conference-wide run holds it)', async () => {
    const w = await world();
    const { p } = w;
    const roomless = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Hugo', location_id: w.sur } })).id;
    // Hold the assignment lock: an assign whose in-lock read waits on the gate.
    const g = gate(p);
    g.hold(/^SELECT room_id, location_id, status FROM wjp_conference_manager_inscriptions/);
    const holder = p.call('post', `/inscriptions/${w.dan}/assign`, { body: { room_id: w.r102 } });
    await new Promise(r => setTimeout(r, 20));

    // A notes / field edit and the deletion of someone without a bed go through meanwhile.
    assert.ok(await settledWithin(p.call('put', `/inscriptions/${w.ana}`, { body: { notes: 'llega tarde' } }), 300), 'notes edit did not wait');
    assert.strictEqual(p.one(`SELECT notes FROM ${T('inscriptions')} WHERE id = ?`, w.ana).notes, 'llega tarde');
    const del = p.call('delete', `/inscriptions/${roomless}`);
    assert.ok(await settledWithin(del, 300), 'roomless delete did not wait');
    assert.deepStrictEqual((await del).body, { success: true, lodging_adjusted: [] });
    assert.strictEqual(p.one(`SELECT id FROM ${T('inscriptions')} WHERE id = ?`, roomless), undefined);

    // Edits that touch a bed (a move, a cancellation, deleting someone with a bed) still wait for it.
    const move = p.call('put', `/inscriptions/${w.carl}`, { body: { location_id: w.norte } });
    const cancel = p.call('put', `/inscriptions/${w.bea}`, { body: { status: 'cancelled' } });
    const gone = p.call('delete', `/inscriptions/${w.eve}`);
    assert.strictEqual(await settledWithin(Promise.race([move, cancel, gone]), 150), false, 'lodging edits queue behind the lock');
    g.release();
    for (const r of await Promise.all([holder, move, cancel, gone])) assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(w.roomOf(w.bea), null, 'the cancellation freed the bed');
    assert.strictEqual(p.one(`SELECT id FROM ${T('inscriptions')} WHERE id = ?`, w.eve), undefined);
});

test('PUT /inscriptions and PUT /rooms decide on the row as it is under the lock, not as it was read before it', async () => {
    const w = await world({ users: [CLERK] });
    const { p } = w;
    const role = ok(await p.call('post', '/staff/roles', { body: { name: 'Solo inscripciones', permissions: { inscriptions: 'manage' } } })).id;
    ok(await p.call('post', '/staff/members', { body: { user_id: CLERK.id, role_id: role } }));
    const oeste = ok(await p.call('post', '/locations', { body: { conference_id: w.cid, name: 'Oeste', capacity: 50 } })).id as number;
    const xavi = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Xavi', location_id: w.sur } })).id as number;
    await w.submit();
    await w.validate();
    const INS_UPDATE = /^UPDATE wjp_conference_manager_inscriptions SET /;

    // 1. The admin moves xavi (Sur, a draft) into validated Norte; a clerk's move of xavi to Oeste read him
    //    in Sur BEFORE that write landed. Under the lock xavi is Norte's, not where the clerk's edit found
    //    him: the move was decided on a stale origin — 409, and xavi stays in Norte.
    p.setDbHook((sql) => (INS_UPDATE.test(sql) ? new Promise(r => setTimeout(r, 40)) : undefined));
    let race = startDuring(p, INS_UPDATE, () => p.call('put', `/inscriptions/${xavi}`, { user: CLERK, body: { location_id: oeste } }));
    ok(await p.call('put', `/inscriptions/${xavi}`, { body: { location_id: w.norte } }), 'admin move');
    const clerk = await race.second();
    p.setDbHook(null);
    assert.strictEqual(clerk.status, 409, JSON.stringify(clerk.body));
    assert.strictEqual(p.one(`SELECT location_id FROM ${T('inscriptions')} WHERE id = ?`, xavi).location_id, w.norte);

    // 2. A capacity change of the pool room 201 read it in the pool; an allotment of 201 to validated Norte
    //    landed first. The capacity change resizes one of Norte's rooms now: stamped on Norte.
    const ROOM_UPDATE = /^UPDATE wjp_conference_manager_rooms SET location_id = /;
    const before = w.loc().lodging_admin_changes;
    p.setDbHook((sql) => (ROOM_UPDATE.test(sql) ? new Promise(r => setTimeout(r, 40)) : undefined));
    race = startDuring(p, ROOM_UPDATE, () => p.call('put', `/rooms/${w.r201}`, { body: { capacity: 4 } }));
    const allot = ok(await p.call('post', `/hotels/${w.sol}/allot`, { body: { location_id: w.norte, room_ids: [w.r201] } }));
    const resize = await race.second();
    p.setDbHook(null);
    assert.strictEqual(resize.status, 200, JSON.stringify(resize.body));
    assert.deepStrictEqual(allot.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'));
    assert.deepStrictEqual(resize.body.lodging_adjusted, NORTE_ADJUSTED(w, 'validated'), 'the resize changed Norte\'s room');
    assert.strictEqual(w.loc().lodging_admin_changes, before + 2);
});
