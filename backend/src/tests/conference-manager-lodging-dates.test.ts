/**
 * conference-manager 2.21.0 — the lodging dates: a general OPENING beside the general closing, and dates of a
 * location's own that replace them.
 *
 * The site owner: «a los encargados de cada localidad no se les deja asignar enseguida los hospedajes, hay una
 * fecha para todos donde se les habilita» and «el cierre de hospedaje … debería ser uno general a menos que se
 * configure uno específico para una localidad». Pinned here against the REAL plugin
 * (fixtures/conference-manager-harness.ts):
 *   - before the general opening every portal lodging write answers 403 «Los hospedajes se habilitan el …», and
 *     GET /portal/lodging says so (opens, not_yet_open, can_edit false); the admin arranges whenever it likes;
 *   - after the closing, 403 as before; a location's own closing (a later date, an earlier one, or none) and its
 *     own opening (a date, or no wait) replace the general ones; «Usar las generales» (null, null) goes back;
 *   - a window that could never open is refused (400), for the general dates and for a location's own;
 *   - a bare date is a whole day in the conference's zone (lodging_tz, the admin's): the same date is still open
 *     where the day has not ended and over where it has;
 *   - the 2.8.0 «permiso fuera de plazo» becomes the location's own closing, once (the later of the general
 *     deadline and its date; no date = no closing), and the old API fields still set it;
 *   - Localidades › gestionar may set the general dates alone (not the rest of the conference);
 *   - GET /portal/me leaks none of the new columns; a DATETIME read back as JSON (Postgres / MySQL) is a bare date.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type HarnessUser, type Plugin } from './fixtures/conference-manager-harness';

const T = (n: string) => `wjp_conference_manager_${n}`;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

/** A calendar date in a zone, `days` from today there ('YYYY-MM-DD'). */
const dayIn = (tz: string, days = 0) => {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days)).toISOString().slice(0, 10);
};
const utc = (days = 0) => dayIn('UTC', days);
const ddmm = (d: string) => d.split('-').reverse().join('/');

let seq = 0;
/** A conference with «Norte» (room 101, Ana without a bed) and «Sur» (room 201); a coordinator token for each. */
async function world(users: HarnessUser[] = []) {
    const p: Plugin = await bootPlugin({ users });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `dates-${++seq}` } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } })).id as number;
    const sur = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 50 } })).id as number;
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Hotel Sol' } })).id as number;
    const r101 = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '101', capacity: 2 } })).id as number;
    const r201 = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '201', capacity: 2 } })).id as number;
    ok(await p.call('post', `/hotels/${hotel}/allot`, { body: { location_id: norte, room_ids: [r101] } }));
    ok(await p.call('post', `/hotels/${hotel}/allot`, { body: { location_id: sur, room_ids: [r201] } }));
    const ana = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Ana', location_id: norte } })).id as number;
    const bea = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Bea', location_id: sur } })).id as number;
    const tokenOf = async (id: number) => {
        const code = p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, id).code;
        return ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: id, code } })).token as string;
    };
    const tokens: Record<number, string> = { [norte]: await tokenOf(norte), [sur]: await tokenOf(sur) };
    const portal = (loc: number, method: string, url: string, body?: any) =>
        p.call(method, url, { anonymous: true, body, headers: { 'x-portal-token': tokens[loc] } });
    /** The coordinator places its attendee (and takes it out again): 200, or the 403 of a closed window. */
    const tryAssign = async (loc: number) => {
        const [who, room] = loc === norte ? [ana, r101] : [bea, r201];
        const r = await portal(loc, 'post', '/portal/lodging/assign', { inscription_id: who, room_id: room });
        if (r.status === 200) ok(await portal(loc, 'post', '/portal/lodging/assign', { inscription_id: who, room_id: null }), 'undo');
        return r;
    };
    const lodging = async (loc: number) => ok(await portal(loc, 'get', '/portal/lodging'), 'GET /portal/lodging');
    const dates = (body: any) => p.call('put', `/${cid}`, { body });
    const own = (loc: number, body: any) => p.call('put', `/locations/${loc}`, { body });
    const locations = async () => ok(await p.call('get', `/locations?conference_id=${cid}`), 'GET /locations');
    return { p, cid, norte, sur, ana, bea, r101, r201, tokens, portal, tryAssign, lodging, dates, own, locations };
}

test('before the general opening the coordinators cannot arrange (403, read-only), the admin can; from that day they can', async () => {
    const w = await world();
    ok(await w.dates({ lodging_opens: utc(2), lodging_deadline: utc(10) }), 'general dates');

    const r = await w.tryAssign(w.norte);
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, `Los hospedajes se habilitan el ${ddmm(utc(2))}. Hasta entonces solo el administrador puede acomodarlos.`);
    for (const [url, body] of [['/portal/lodging/run', {}], ['/portal/lodging/reset', {}], ['/portal/lodging/submit', {}]] as [string, any][]) {
        assert.strictEqual((await w.portal(w.norte, 'post', url, body)).status, 403, url);
    }
    const view = await w.lodging(w.norte);
    assert.deepStrictEqual([view.opens, view.not_yet_open, view.deadline, view.deadline_passed, view.window_open, view.can_edit],
        [utc(2), true, utc(10), false, false, false]);
    assert.strictEqual('permission' in view, false, 'the 2.8.0 permission is gone into the own closing');

    // The administration is never held by the dates.
    ok(await w.p.call('post', `/inscriptions/${w.ana}/assign`, { body: { room_id: w.r101 } }), 'admin assign');

    // The opening is today: open from its first instant (UTC here — no zone saved).
    ok(await w.dates({ lodging_opens: utc(0) }), 'opens today');
    const now = await w.lodging(w.norte);
    assert.deepStrictEqual([now.not_yet_open, now.window_open, now.can_edit], [false, true, true]);
    ok(await w.portal(w.norte, 'post', '/portal/lodging/assign', { inscription_id: w.ana, room_id: null }), 'coordinator writes');

    const list = await w.locations();
    assert.deepStrictEqual(list.conference.lodging_window, { opens: utc(0), closes: utc(10), not_yet: false, passed: false, open: true });
});

test('the general closing applies to every location unless one has its own: a later date, an earlier one, or none', async () => {
    const w = await world();
    ok(await w.dates({ lodging_deadline: utc(-1) }), 'closed yesterday');
    for (const loc of [w.norte, w.sur]) assert.strictEqual((await w.tryAssign(loc)).status, 403);
    assert.strictEqual((await w.tryAssign(w.norte)).body.error, `El plazo para acomodar los hospedajes venció el ${ddmm(utc(-1))}. Solo el administrador puede modificarlos.`);

    // Norte's own closing, later: Norte arranges, Sur does not.
    ok(await w.own(w.norte, { lodging_closes: utc(3) }), 'own closing');
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200);
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403);
    const v = await w.lodging(w.norte);
    assert.deepStrictEqual([v.deadline, v.deadline_passed, v.window_open], [utc(3), false, true], 'the closing that applies to Norte');

    // No closing for Norte at all.
    ok(await w.own(w.norte, { lodging_closes: 'never' }), 'never');
    assert.strictEqual((await w.lodging(w.norte)).deadline, null);
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200);

    // The general closing reopens; Sur's own closing, earlier, keeps Sur shut.
    ok(await w.dates({ lodging_deadline: utc(5) }), 'reopen');
    ok(await w.own(w.sur, { lodging_closes: utc(-2) }), 'Sur closes earlier');
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403);
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200);

    // «Usar las generales».
    ok(await w.own(w.sur, { lodging_opens: null, lodging_closes: null }), 'back to the general dates');
    assert.strictEqual((await w.tryAssign(w.sur)).status, 200);

    const list = await w.locations();
    const byId = Object.fromEntries(list.locations.map((l: any) => [l.id, l]));
    assert.deepStrictEqual([byId[w.norte].lodging_opens, byId[w.norte].lodging_closes, byId[w.norte].lodging_window.closes], [null, 'never', null]);
    assert.deepStrictEqual([byId[w.sur].lodging_opens, byId[w.sur].lodging_closes, byId[w.sur].lodging_window.closes], [null, null, utc(5)]);
    assert.strictEqual('lodging_permission' in byId[w.norte], false);
});

test('a location\'s own opening: no wait while the others wait, or a later day than the general one', async () => {
    const w = await world();
    ok(await w.dates({ lodging_opens: utc(4) }), 'general opening in 4 days');
    ok(await w.own(w.norte, { lodging_opens: 'now' }), 'Norte does not wait');
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200);
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403);

    ok(await w.dates({ lodging_opens: null }), 'no general opening');
    ok(await w.own(w.sur, { lodging_opens: utc(1) }), 'Sur opens tomorrow');
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403);
    const v = await w.lodging(w.sur);
    assert.deepStrictEqual([v.opens, v.not_yet_open], [utc(1), true]);
});

test('a window that could never open is refused: general opening after the closing, a location\'s own against the general one', async () => {
    const w = await world();
    const r = await w.dates({ lodging_opens: utc(5), lodging_deadline: utc(4) });
    assert.deepStrictEqual([r.status, r.body.error], [400, 'La apertura de los hospedajes no puede ser posterior a su cierre.']);
    ok(await w.dates({ lodging_opens: utc(4), lodging_deadline: utc(4) }), 'one day is a window');
    assert.strictEqual((await w.dates({ lodging_deadline: utc(3) })).status, 400, 'the stored opening counts');

    const own = await w.own(w.norte, { lodging_opens: utc(6) });
    assert.strictEqual(own.status, 400);
    assert.match(own.body.error, /nunca podría acomodar/);
    ok(await w.own(w.norte, { lodging_opens: utc(6), lodging_closes: utc(8) }), 'its own closing too');

    for (const [body, what] of [[{ lodging_opens: 'never' }, 'never as an opening'], [{ lodging_closes: 'now' }, 'now as a closing'], [{ lodging_closes: '2026-02-31' }, 'no such day'], [{ lodging_opens: 12 }, 'not a string']] as [any, string][]) {
        assert.strictEqual((await w.own(w.sur, body)).status, 400, what);
    }
    assert.strictEqual((await w.dates({ lodging_tz: 'Mars/Olympus' })).status, 400, 'a zone that does not exist');
    assert.strictEqual((await w.dates({ lodging_opens: 'pronto' })).status, 400);
});

test('a bare date is a whole day in the conference\'s zone: still open where the day goes on, over where it has ended', async () => {
    const w = await world();
    // Today in Pago Pago (UTC−11) is always one or two days behind today in Kiritimati (UTC+14).
    const pago = dayIn('Pacific/Pago_Pago'), kiri = dayIn('Pacific/Kiritimati');
    assert.ok(pago < kiri);

    ok(await w.dates({ lodging_deadline: pago, lodging_tz: 'Pacific/Pago_Pago' }));
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200, 'the closing day is not over in Pago Pago');
    ok(await w.dates({ lodging_tz: 'Pacific/Kiritimati' }));
    assert.strictEqual((await w.tryAssign(w.norte)).status, 403, 'that day ended in Kiritimati');

    ok(await w.dates({ lodging_deadline: null, lodging_opens: kiri, lodging_tz: 'Pacific/Kiritimati' }));
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200, 'the opening day has begun in Kiritimati');
    ok(await w.dates({ lodging_tz: 'Pacific/Pago_Pago' }));
    assert.strictEqual((await w.tryAssign(w.norte)).status, 403, 'it has not begun in Pago Pago');

    // A location's dates are judged in the same zone; the admin's zone comes with its own dates too.
    ok(await w.dates({ lodging_opens: null }));
    ok(await w.own(w.sur, { lodging_closes: pago, lodging_tz: 'Pacific/Kiritimati' }));
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403);
    assert.strictEqual(w.p.one(`SELECT lodging_tz FROM ${T('conferences')} WHERE id = ?`, w.cid).lodging_tz, 'Pacific/Kiritimati');
    assert.strictEqual((await w.locations()).conference.lodging_tz, 'Pacific/Kiritimati');
});

test('the 2.8.0 permission becomes the location\'s own closing, once; the old API fields still set it', async () => {
    const w = await world();
    const L = T('locations');
    w.p.exec(`UPDATE ${T('conferences')} SET lodging_deadline = ? WHERE id = ?`, utc(-5), w.cid);
    // Norte: a permission until a date after the deadline; Sur: until revoked.
    w.p.exec(`UPDATE ${L} SET lodging_permission = 1, lodging_permission_until = ? WHERE id = ?`, utc(2), w.norte);
    w.p.exec(`UPDATE ${L} SET lodging_permission = 1, lodging_permission_until = NULL WHERE id = ?`, w.sur);
    await w.p.reboot();
    const row = (id: number) => w.p.one(`SELECT lodging_closes, lodging_permission, lodging_permission_until FROM ${L} WHERE id = ?`, id);
    assert.deepStrictEqual(row(w.norte), { lodging_closes: utc(2), lodging_permission: 0, lodging_permission_until: null });
    assert.deepStrictEqual(row(w.sur), { lodging_closes: 'never', lodging_permission: 0, lodging_permission_until: null });
    assert.strictEqual((await w.tryAssign(w.norte)).status, 200);
    assert.strictEqual((await w.tryAssign(w.sur)).status, 200);

    // A permission dated before the deadline kept the location open until the deadline: so does its closing.
    w.p.exec(`UPDATE ${T('conferences')} SET lodging_deadline = ? WHERE id = ?`, utc(6), w.cid);
    w.p.exec(`UPDATE ${L} SET lodging_closes = NULL, lodging_permission = 1, lodging_permission_until = ? WHERE id = ?`, utc(1), w.norte);
    await w.p.reboot();
    assert.strictEqual(row(w.norte).lodging_closes, utc(6));
    await w.p.reboot();
    assert.strictEqual(row(w.norte).lodging_closes, utc(6), 'nothing left to move');

    // The old fields: a permission = an own closing; revoking = the general closing.
    ok(await w.own(w.sur, { lodging_permission: true, lodging_permission_until: utc(9) }));
    assert.strictEqual(row(w.sur).lodging_closes, utc(9));
    ok(await w.own(w.sur, { lodging_permission: true }));
    assert.strictEqual(row(w.sur).lodging_closes, 'never');
    ok(await w.own(w.sur, { lodging_permission: false }));
    assert.strictEqual(row(w.sur).lodging_closes, null);
});

test('Localidades › gestionar sets the general dates, and only them', async () => {
    const LOCS: HarnessUser = { id: 30, role: 'conference_manager_team', userLogin: 'locs', userEmail: 'locs@example.test', displayName: 'Locs' };
    const w = await world([LOCS]);
    const roleId = ok(await w.p.call('post', '/staff/roles', { body: { name: 'Localidades', permissions: { locations: 'manage' } } })).id;
    ok(await w.p.call('post', '/staff/members', { body: { user_id: LOCS.id, role_id: roleId } }));
    ok(await w.p.call('put', `/${w.cid}`, { user: LOCS, body: { lodging_opens: utc(1), lodging_deadline: utc(9), lodging_tz: 'America/Bogota' } }), 'dates only');
    assert.deepStrictEqual(w.p.one(`SELECT lodging_opens, lodging_deadline, lodging_tz FROM ${T('conferences')} WHERE id = ?`, w.cid),
        { lodging_opens: utc(1), lodging_deadline: utc(9), lodging_tz: 'America/Bogota' });
    assert.strictEqual((await w.p.call('put', `/${w.cid}`, { user: LOCS, body: { lodging_opens: utc(1), name: 'Otro' } })).status, 403, 'not with the rest');
    ok(await w.p.call('put', `/locations/${w.norte}`, { user: LOCS, body: { lodging_opens: 'now' } }), 'a location\'s own');
    assert.strictEqual(w.p.one(`SELECT lodging_opens FROM ${T('locations')} WHERE id = ?`, w.norte).lodging_opens, 'now');
});

test('GET /portal/me leaks none of the lodging columns; a DATETIME read back as JSON is a bare date again', async () => {
    const w = await world();
    ok(await w.own(w.norte, { lodging_opens: 'now', lodging_closes: utc(3) }));
    const me = ok(await w.portal(w.norte, 'get', '/portal/me'));
    for (const k of ['lodging_opens', 'lodging_closes', 'lodging_permission', 'lodging_permission_until']) assert.strictEqual(k in me, false, k);

    // Postgres / MySQL hand a DATETIME back as a Date: through the bridge, its JSON.
    w.p.exec(`UPDATE ${T('conferences')} SET lodging_deadline = ? WHERE id = ?`, `${utc(-1)}T00:00:00.000Z`, w.cid);
    const list = await w.locations();
    assert.deepStrictEqual([list.conference.lodging_deadline, list.conference.lodging_window.passed], [utc(-1), true]);
    assert.strictEqual((await w.tryAssign(w.sur)).status, 403, 'the whole day, then closed');
});

test('rule priorities: two rules that apply together may not share a number — the admin\'s with every location\'s, a location\'s with the admin\'s and its own', async () => {
    const w = await world();
    const rule = (body: any) => w.p.call('post', '/assignment/rules', { body: { conference_id: w.cid, type: 'keep_together', config: 'first_name', ...body } });
    const mine = (loc: number, body: any) => w.portal(loc, 'post', '/portal/lodging/rules', { type: 'keep_together', config: 'first_name', ...body });

    ok(await rule({ name: 'A', priority: 50 }), 'A');
    const dup = await rule({ name: 'B', priority: 50 });
    assert.deepStrictEqual([dup.status, dup.body.error], [409, 'La prioridad 50 ya la usa la regla «A». Dos reglas no pueden tener la misma prioridad: usa otro número.']);
    ok(await rule({ name: 'B', priority: 40 }), 'B');
    const bId = w.p.one(`SELECT id FROM ${T('assignment_rules')} WHERE name = 'B'`).id;
    assert.strictEqual((await rule({ id: bId, name: 'B', priority: 50 })).status, 409, 'not by editing either');
    ok(await rule({ id: bId, name: 'B', priority: 40, enabled: 0 }), 'saved again with its own number');

    // A coordinator's rule: not the admin's numbers, not its own twice; another location may use the same number.
    const n1 = await mine(w.norte, { name: 'Mía', priority: 50 });
    assert.deepStrictEqual([n1.status, n1.body.error], [409, 'La prioridad 50 ya la usa la regla «A» de la administración. Dos reglas no pueden tener la misma prioridad: usa otro número.']);
    ok(await mine(w.norte, { name: 'Mía', priority: 45 }), 'Norte 45');
    assert.strictEqual((await mine(w.norte, { name: 'Otra mía', priority: 45 })).status, 409);
    ok(await mine(w.sur, { name: 'De Sur', priority: 45 }), 'Sur 45');
    // …and the admin may not take a number a location's rule uses (they apply together there).
    const taken = await rule({ name: 'C', priority: 45 });
    assert.strictEqual(taken.status, 409);
    assert.match(taken.body.error, /de la localidad (Norte|Sur)/);

    // An older tie (before 2.21.0) is not refused when the rule is saved again with its number.
    w.p.exec(`INSERT INTO ${T('assignment_rules')} (conference_id, name, type, enabled, priority, config, params, hard, location_id) VALUES (?, 'Vieja', 'keep_together', 1, 40, 'first_name', '{}', 0, NULL)`, w.cid);
    ok(await rule({ id: bId, name: 'B renombrada', priority: 40 }), 'old tie kept');

    // The list: the highest priority first.
    const list = ok(await w.p.call('get', `/assignment/rules?conference_id=${w.cid}`)).map((r: any) => r.priority);
    assert.deepStrictEqual(list, [...list].sort((a: number, b: number) => b - a));
});
