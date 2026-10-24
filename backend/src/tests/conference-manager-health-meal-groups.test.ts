/**
 * conference-manager 2.32.0 — «Condiciones de salud» and «Turnos de comida».
 *
 * The site owner asked for (1) a multiple-choice health field with «Otros» and free text, shown only to who needs
 * it, and (2) meal groups A–F from age and health so priority people are served first and everybody waits less.
 * The model they approved: S = min(100, E(age) + H), H = min(60, w1 + w2/2 + w3/4 …); six groups of nearly EQUAL
 * size («la cantidad de personas en cada grupo debe ser relativamente igual»), families together; sex counts only
 * through «Embarazo» / «Lactancia»; the age is asked in the form («Edad»). Pinned against the REAL plugin:
 *   - the `health` template stores NO column: its answers live in their own table; a custom field cannot take its
 *     name or type, a price rule cannot read it, deleting the field (or the person) deletes the answers;
 *   - health:view reads it (roster text, export column, GET /inscriptions/:id/health), health:manage writes it
 *     from the admin; a coordinator answers it when registering (write-only); a role without it never sees it;
 *   - the pure model (scores of the owner's worked example, equal cut, families, manual groups, daily rotation,
 *     call times of the 480-person example);
 *   - GET /meals/priority (letters for meals:view, scores only with health:view), «Fijar grupos», manual group.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { bootPlugin, PREFIX, PLUGIN_DIR, type HarnessUser, type Plugin } from './fixtures/conference-manager-harness';

const M = require(path.join(PLUGIN_DIR, 'server/meal-priority.js'));
const H = require(path.join(PLUGIN_DIR, 'server/health.js'));

const TEAM_ROLE = 'conference_manager_team';
const TEAM_CAP = 'conference_manager_access';
const member = (id: number, login: string): HarnessUser => ({
    id, role: TEAM_ROLE, userLogin: login, userEmail: `${login}@example.test`, displayName: login, extra: { pluginCapabilities: [TEAM_CAP] },
});
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };
const NOHEALTH = member(60, 'roster');   // inscriptions:manage, meals:manage, no health
const NURSE = member(61, 'nurse');       // inscriptions:manage + health:manage, meals:view

async function addMember(p: Plugin, u: HarnessUser, permissions: Record<string, string>) {
    const role = ok(await p.call('post', '/staff/roles', { body: { name: `Rol ${u.userLogin}`, permissions } }), 'role');
    ok(await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: role.id } }), 'member');
}

async function portal(p: Plugin, method: string, url: string, token: string, body?: any) {
    for (const r of p.routes) {
        if (r.method !== method || r.path !== url) continue;
        const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; },
            cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; },
        };
        await r.handler({ params: {}, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    }
    throw new Error(`no portal route ${method} ${url}`);
}

let seq = 0;
async function world({ publish = true } = {}) {
    const p = await bootPlugin({ users: [NOHEALTH, NURSE] });
    await addMember(p, NOHEALTH, { inscriptions: 'manage', meals: 'manage', reports: 'view' });
    await addMember(p, NURSE, { inscriptions: 'manage', health: 'manage', meals: 'view' });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `hm-${++seq}` } })).id as number;
    for (const template of ['first_name', 'age', 'family_group', 'health']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    if (publish) ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 2000 } })).id as number;
    const person = async (first_name: string, extra: Record<string, unknown> = {}, user?: HarnessUser) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, location_id: norte, ...extra }, ...(user ? { user } : {}) }), first_name).id as number;
    const healthRow = (id: number) => p.one(`SELECT answer, conditions, other_text FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id);
    return { p, cid, norte, person, healthRow };
}

// ── «Condiciones de salud» ──────────────────────────────────────────────────────────────────────────────────

test('the health template is a definition only: no inscriptions column, default options, its name and type are its own', async () => {
    const w = await world({ publish: false });
    const f = w.p.one(`SELECT name, type, role, options FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid);
    assert.strictEqual(f.type, 'health');
    assert.deepStrictEqual(f.options.split(',').map((s: string) => s.trim()), H.DEFAULT_OPTIONS);
    const cols = w.p.raw.prepare(`PRAGMA table_info(${PREFIX}inscriptions)`).all().map((c: any) => c.name);
    assert.ok(!cols.includes('health_conditions'), 'no column for the answers');
    assert.ok(cols.includes('age'));
    // A custom field cannot be a health field, nor take its name; the health field keeps its type.
    assert.strictEqual((await w.p.call('post', '/fields', { body: { conference_id: w.cid, label: 'Salud', type: 'health' } })).status, 400);
    assert.strictEqual((await w.p.call('post', '/fields', { body: { conference_id: w.cid, name: 'health_conditions', label: 'X', type: 'text' } })).status, 400);
    const fid = w.p.one(`SELECT id FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid).id;
    assert.strictEqual((await w.p.call('post', '/fields', { body: { id: fid, conference_id: w.cid, label: 'Salud', type: 'text' } })).status, 400);
    // Editing its options keeps them clean («Otros» is implicit, duplicates go).
    ok(await w.p.call('post', '/fields', { body: { id: fid, conference_id: w.cid, label: 'Salud', type: 'health', options: 'Diabetes, Otros, diabetes, Asma o EPOC' } }));
    assert.strictEqual(w.p.one(`SELECT options FROM ${PREFIX}fields WHERE id = ?`, fid).options, 'Diabetes, Asma o EPOC');
    // A price rule cannot read it.
    assert.strictEqual((await w.p.call('post', '/fee-rules', { body: { conference_id: w.cid, field_name: 'health_conditions', operator: 'filled', amount: 5 } })).status, 400);
});

test('answers are validated, stored apart, and «Edad» is a whole number 0–120', async () => {
    const w = await world();
    const id = await w.person('Elena', { age: '74', health_conditions: { conditions: ['Diabetes', 'Enfermedad del corazón', 'Otros'], other: 'migraña' } });
    assert.deepStrictEqual({ ...w.healthRow(id) }, { answer: 'list', conditions: JSON.stringify(['Diabetes', 'Enfermedad del corazón', 'Otros']), other_text: 'migraña' });
    const none = await w.person('Luis', { health_conditions: { answer: 'none' } });
    assert.strictEqual(w.healthRow(none).answer, 'none');
    const bad = async (body: any) => (await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'X', location_id: w.norte, ...body } })).status;
    assert.strictEqual(await bad({ health_conditions: { conditions: ['Gripa'] } }), 400, 'not an option');
    assert.strictEqual(await bad({ health_conditions: { conditions: ['Otros'] } }), 400, '«Otros» needs its text');
    assert.strictEqual(await bad({ health_conditions: 'Diabetes' }), 400, 'not the answer shape');
    assert.strictEqual(await bad({ health_conditions: { answer: 'maybe' } }), 400);
    assert.strictEqual(await bad({ age: '130' }), 400);
    assert.strictEqual(await bad({ age: '7.5' }), 400);
});

test('only health:view reads the answers, only health:manage writes them from the admin', async () => {
    const w = await world();
    const id = await w.person('Rosa', { age: 82, health_conditions: { conditions: ['Hipertensión'] } });
    // A role without the section: no answer in the roster, 403 on the dedicated read and on a write.
    const rows = ok(await w.p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: NOHEALTH }));
    assert.ok(!('health_conditions' in rows[0]), 'roster row carries no health key');
    assert.ok(!('health_conditions' in ok(await w.p.call('get', `/inscriptions/${id}`, { user: NOHEALTH }))));
    assert.strictEqual((await w.p.call('get', `/inscriptions/${id}/health`, { user: NOHEALTH })).status, 403);
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { user: NOHEALTH, body: { health_conditions: null } })).status, 403);
    assert.strictEqual((await w.p.call('post', '/inscriptions', { user: NOHEALTH, body: { conference_id: w.cid, first_name: 'Z', location_id: w.norte, health_conditions: { answer: 'none' } } })).status, 403);
    // …but it still edits everything else, and the answer stays.
    ok(await w.p.call('put', `/inscriptions/${id}`, { user: NOHEALTH, body: { first_name: 'Rosa M.' } }));
    assert.strictEqual(w.healthRow(id).answer, 'list');
    const csv = ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`, { user: NOHEALTH })).csv as string;
    assert.ok(!csv.includes('Condiciones de salud') && !csv.includes('Hipertensión'), 'no health column in the export');
    // health:view / manage.
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: NURSE }))[0].health_conditions, 'Hipertensión');
    assert.deepStrictEqual(ok(await w.p.call('get', `/inscriptions/${id}/health`, { user: NURSE })).answer, { conditions: ['Hipertensión'], other: '', answer: 'list' });
    ok(await w.p.call('put', `/inscriptions/${id}`, { user: NURSE, body: { health_conditions: { answer: 'declined' } } }));
    assert.strictEqual(w.healthRow(id).answer, 'declined');
    const csv2 = ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    assert.ok(csv2.split('\r\n')[0].includes('Condiciones de salud') && csv2.includes('Prefiere no responder'), csv2);
    ok(await w.p.call('put', `/inscriptions/${id}`, { user: NURSE, body: { health_conditions: null } }));
    assert.strictEqual(w.healthRow(id), undefined, 'null clears it');
});

test('the portal registers the answer (write-only); deleting the person or the field deletes the answers', async () => {
    const w = await world();
    const fields = ok(await w.p.call('get', `/public/fields?conference_id=${w.cid}`, { anonymous: true }));
    assert.ok(fields.some((f: any) => f.name === 'health_conditions' && f.type === 'health'), 'the portal gets the definition');
    const code = w.p.one(`SELECT code FROM ${PREFIX}locations WHERE id = ?`, w.norte).code;
    const token = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.norte, code } })).token as string;
    const r = await portal(w.p, 'post', '/portal/inscriptions', token, { first_name: 'Lucía', age: 29, health_conditions: { conditions: ['Embarazo'] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(w.healthRow(r.body.id).conditions, JSON.stringify(['Embarazo']));
    const list = await portal(w.p, 'get', '/portal/inscriptions', token);
    assert.ok(!JSON.stringify(list.body).includes('Embarazo'), 'the portal never reads it back');
    assert.strictEqual((await portal(w.p, 'post', '/portal/inscriptions', token, { first_name: 'X', health_conditions: { conditions: ['Nada'] } })).status, 400);

    ok(await w.p.call('delete', `/inscriptions/${r.body.id}`));
    assert.strictEqual(w.healthRow(r.body.id), undefined);
    const other = await w.person('Pedro', { health_conditions: { conditions: ['Movilidad reducida'] } });
    ok(await w.p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }));
    const fid = w.p.one(`SELECT id FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid).id;
    ok(await w.p.call('delete', `/fields/${fid}`));
    assert.strictEqual(w.healthRow(other), undefined, 'deleting the field clears the answers');
});

test('a required health field must be answered («Prefiero no responder» is an answer)', async () => {
    const w = await world({ publish: false });
    const fid = w.p.one(`SELECT id, options FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid);
    ok(await w.p.call('post', '/fields', { body: { id: fid.id, conference_id: w.cid, label: 'Condiciones de salud', type: 'health', options: fid.options, is_required: true } }));
    assert.strictEqual((await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'X', location_id: w.norte } })).status, 400);
    await w.person('Sofía', { health_conditions: { answer: 'declined' } });
});

// ── the model ───────────────────────────────────────────────────────────────────────────────────────────────

test('scores of the owner\'s worked example', () => {
    const L = (conditions: string[]) => ({ answer: 'list', conditions, other: '' });
    assert.strictEqual(M.priorityScore(74, L(['Diabetes', 'Enfermedad del corazón']), {}), 87.5);
    assert.strictEqual(M.priorityScore(82, L(['Hipertensión']), {}), 60);
    assert.strictEqual(M.priorityScore(35, L(['Movilidad reducida', 'Asma o EPOC']), {}), 40);
    assert.strictEqual(M.priorityScore(29, L(['Embarazo']), {}), 30);
    assert.strictEqual(M.priorityScore(4, null, {}), 30);
    assert.strictEqual(M.priorityScore(67, null, {}), 20);
    assert.strictEqual(M.priorityScore(22, L(['Otros']), {}), 10);
    assert.strictEqual(M.priorityScore(19, { answer: 'declined', conditions: [], other: '' }, {}), 0);
    assert.strictEqual(M.priorityScore(null, null, {}), 0, 'no age = adult');
    assert.strictEqual(M.healthPoints(L(['Diabetes', 'Movilidad reducida', 'Embarazo', 'Cáncer u otro tratamiento que debilita']), {}), 60, 'H is capped');
    assert.strictEqual(M.priorityScore(85, L(['Diabetes', 'Movilidad reducida']), {}), 100, 'S is capped');
    assert.strictEqual(M.priorityScore(40, L(['Diabetes']), { Diabetes: 12 }), 12, 'the conference\'s own weight');
});

test('six groups of (nearly) equal size, monotone in the score; families together; manual groups kept', () => {
    // 600 people: 1 in 5 with points.
    const people = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, score: i % 5 === 0 ? (i % 97) : 0, family: '', tie: (i * 2654435761) % 4294967296 }));
    const g = M.assignGroups(people, {});
    const sizes = M.GROUPS.map((L: string) => [...g.values()].filter(x => x === L).length);
    assert.deepStrictEqual(sizes, [100, 100, 100, 100, 100, 100]);
    for (const a of people) for (const b of people) {
        if (a.score > b.score) assert.ok(M.GROUPS.indexOf(g.get(a.id)) <= M.GROUPS.indexOf(g.get(b.id)), 'more points never later');
    }
    // The owner's 10-person example: 2, 1, 2, 2, 1, 2 with Mateo and his mother together.
    const ex = [
        { id: 1, score: 87.5 }, { id: 2, score: 60 }, { id: 3, score: 40 }, { id: 4, score: 40 }, { id: 5, score: 30 },
        { id: 6, score: 30, family: 'f' }, { id: 7, score: 0, family: 'f' }, { id: 8, score: 20 }, { id: 9, score: 10 }, { id: 10, score: 0 },
    ].map(p => ({ family: '', tie: p.id, ...p }));
    const ge = M.assignGroups(ex, {});
    assert.deepStrictEqual(ex.map(p => ge.get(p.id)).join(''), 'AABCCDDEFF');
    // A family lifts at most companionsMax companions per priority member.
    const fam = [{ id: 1, score: 50, family: 'x', tie: 1 }, ...Array.from({ length: 7 }, (_, i) => ({ id: i + 2, score: 0, family: 'x', tie: 5000 + i })),
        ...Array.from({ length: 40 }, (_, i) => ({ id: i + 100, score: 0, family: '', tie: 1000 + i }))];
    const gf = M.assignGroups(fam, { companionsMax: 4 });
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(i => gf.get(i)), ['A', 'A', 'A', 'A', 'A'], 'priority member + 4 companions together');
    assert.notStrictEqual(gf.get(6), 'A', 'the 5th companion keeps their own place');
    // A manual group is kept and left out of the cut.
    const gm = M.assignGroups(ex, { manual: new Map([[10, 'A']]) });
    assert.strictEqual(gm.get(10), 'A');
});

test('the trailing groups with 0 points alternate day by day', () => {
    assert.deepStrictEqual(M.callOrder(new Set(['E', 'F']), 0), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.deepStrictEqual(M.callOrder(new Set(['E', 'F']), 1), ['A', 'B', 'C', 'D', 'F', 'E']);
    assert.deepStrictEqual(M.callOrder(new Set(['D', 'E', 'F']), 2), ['A', 'B', 'C', 'F', 'D', 'E']);
    assert.deepStrictEqual(M.callOrder(new Set(['C', 'F']), 1), ['A', 'B', 'C', 'D', 'E', 'F'], 'only the trailing run rotates');
});

test('call times of the 480-person example (3 lines, 4 plates/min, 85 %)', () => {
    const counts = { A: 80, B: 80, C: 80, D: 80, E: 80, F: 80 };
    const out = M.serviceSlots({ meal: 'almuerzo', start_time: '12:00', end_time: '13:00' }, counts, M.GROUPS, { lines: 3, per_min: 4, occupancy: 0.85 });
    assert.deepStrictEqual(out.slots.map((s: any) => s.start), ['12:00', '12:07', '12:15', '12:23', '12:31', '12:39']);
    assert.strictEqual(out.end, '12:47');
    assert.strictEqual(out.overflow, false);
    assert.strictEqual(M.serviceSlots({ meal: 'almuerzo', start_time: '12:00', end_time: '12:30' }, counts, M.GROUPS, { lines: 3, per_min: 4, occupancy: 0.85 }).overflow, true);
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────

test('GET /meals/priority: letters, counts and times for meals:view; scores only with health:view', async () => {
    const w = await world();
    const ids: Record<string, number> = {};
    const add = async (n: string, extra: any) => { ids[n] = await w.person(n, extra); };
    await add('Elena', { age: 74, health_conditions: { conditions: ['Diabetes', 'Enfermedad del corazón'] } });
    await add('Rosa', { age: 82, health_conditions: { conditions: ['Hipertensión'] } });
    await add('Pedro', { age: 35, health_conditions: { conditions: ['Movilidad reducida', 'Asma o EPOC'] } });
    await add('Carlos', { age: 45, health_conditions: { conditions: ['Diabetes'] } });
    await add('Lucía', { age: 29, health_conditions: { conditions: ['Embarazo'] } });
    await add('Mateo', { age: 4, family_group: 'Pérez' });
    await add('Ana', { age: 31, family_group: 'Pérez' });
    await add('Jorge', { age: 67 });
    await add('Andrés', { age: 22, health_conditions: { conditions: ['Otros'], other: 'migraña' } });
    await add('Sofía', { age: 19, health_conditions: { answer: 'declined' } });
    const svc = ok(await w.p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'almuerzo', start_time: '12:00', end_time: '14:00', location_ids: [w.norte] } })).id;

    const nurse = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`, { user: NURSE }));
    assert.strictEqual(nurse.total, 10);
    assert.deepStrictEqual(Object.values(nurse.counts).reduce((a: number, b: any) => a + b, 0), 10);
    assert.ok(Math.max(...Object.values(nurse.counts) as number[]) - Math.min(...Object.values(nurse.counts) as number[]) <= 2, JSON.stringify(nurse.counts));
    const by = new Map(nurse.people.map((p: any) => [p.id, p]));
    assert.strictEqual((by.get(ids.Elena) as any).group, 'A');
    assert.strictEqual((by.get(ids.Elena) as any).score, 87.5);
    assert.strictEqual((by.get(ids.Mateo) as any).group, (by.get(ids.Ana) as any).group, 'the family together');
    const s = nurse.services.find((x: any) => x.id === svc);
    assert.strictEqual(s.entitled, 10);
    assert.strictEqual(s.slots[0].start, '12:00');

    const cook = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`, { user: NOHEALTH }));
    assert.ok(cook.people.length === 10 && cook.people.every((p: any) => !('score' in p) && !('health_points' in p) && !('age' in p)), 'no score without health:view');
    assert.strictEqual(cook.health_answered, null);

    // Manual group, then «Fijar grupos»: a later registrant joins a group without moving anybody.
    ok(await w.p.call('put', `/meals/priority/people/${ids.Sofía}`, { user: NOHEALTH, body: { group: 'A' } }));
    assert.strictEqual(w.p.one(`SELECT grp, manual FROM ${PREFIX}meal_groups WHERE inscription_id = ?`, ids.Sofía).grp, 'A');
    assert.strictEqual((await w.p.call('put', `/meals/priority/people/${ids.Sofía}`, { user: NOHEALTH, body: { group: 'G' } })).status, 400);
    ok(await w.p.call('post', '/meals/priority/freeze', { user: NOHEALTH, body: { conference_id: w.cid } }));
    const before = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).people.map((p: any) => [p.id, p.group]);
    const late = await w.person('Nuevo', { age: 90, health_conditions: { conditions: ['Diabetes'] } });
    const after = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`));
    assert.ok(after.frozen_at);
    for (const [id, g] of before) assert.strictEqual(after.people.find((p: any) => p.id === id).group, g, 'frozen letters stay');
    assert.strictEqual(after.people.find((p: any) => p.id === late).group, 'A', '90 points join the top group');
    assert.strictEqual(after.people.find((p: any) => p.id === ids.Sofía).group, 'A', 'the manual group survives the freeze');
    // Weights are the conference's own.
    assert.strictEqual((await w.p.call('put', '/meals/priority/config', { user: NURSE, body: { conference_id: w.cid, lines: 2 } })).status, 403, 'meals:manage');
    ok(await w.p.call('put', '/meals/priority/config', { user: NOHEALTH, body: { conference_id: w.cid, lines: 3, per_min: 5, weights: { Diabetes: 50 } } }));
    assert.strictEqual((await w.p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, weights: { Diabetes: 500 } } })).status, 400);
});

test('the letter reaches the scanner only while «Turnos de comida» is on, and never blocks a delivery', async () => {
    const w = await world();
    const ana = await w.person('Ana', { age: 85 });
    for (let i = 0; i < 5; i++) await w.person(`P${i}`, { age: 30 });
    const svc = ok(await w.p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'almuerzo', location_ids: [w.norte] } })).id;
    const check = async () => ok(await w.p.call('post', '/meals/check', { body: { service_id: svc, inscription_id: ana } }));
    assert.ok(!('meal_group' in (await check()).person), 'off by default: the projection is unchanged');
    assert.strictEqual(ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).config.enabled, false);
    ok(await w.p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, enabled: true } }));
    const on = await check();
    assert.strictEqual(on.person.meal_group, 'A');
    assert.strictEqual(on.result, 'ready');
    // A person of a later group is still served whenever they come.
    const late = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).people.find((p: any) => p.group === 'F');
    assert.strictEqual(ok(await w.p.call('post', '/meals/deliver', { body: { service_id: svc, inscription_id: late.id } })).result, 'delivered');
    assert.strictEqual((await w.p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, enabled: 'yes' } })).status, 400);
});

test('calling the groups (2.36.5): an uncalled group is warned and not served — priority people too; «Dejar pasar igual» serves and logs it', async () => {
    const w = await world();
    // Ana (88, Movilidad reducida) is a priority person: group A. The others, 30 years old, fill B–F.
    const ana = await w.person('Ana', { age: 88, health_conditions: { conditions: ['Movilidad reducida'] } });
    for (let i = 0; i < 11; i++) await w.person(`P${i}`, { age: 30 });
    const svc = ok(await w.p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'almuerzo', location_ids: [w.norte] } })).id as number;
    const people = async () => ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).people as any[];
    const call = (group: string, extra: any = {}, user?: HarnessUser) => w.p.call('post', '/meals/priority/call', { body: { service_id: svc, group, ...extra }, ...(user ? { user } : {}) });
    // Off: nothing to call.
    assert.strictEqual((await call('A')).status, 409);
    ok(await w.p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, enabled: true } }));
    const all = await people();
    assert.strictEqual(all.find((p: any) => p.id === ana).group, 'A', 'priority puts Ana in group A');
    const inB = all.find((p: any) => p.group === 'B').id, inC = all.find((p: any) => p.group === 'C').id;
    // Before any call nothing changes: everyone is served whenever they come.
    assert.strictEqual(ok(await w.p.call('post', '/meals/check', { body: { service_id: svc, inscription_id: inC } })).result, 'ready');

    // Call B first (out of order on purpose). The service is now calling: A — Ana — has not been called.
    const called = ok(await call('B'));
    assert.deepStrictEqual(called.state.called, ['B']);
    assert.strictEqual(called.push.subscribers, 0, 'nobody turned notices on');
    const priority = ok(await w.p.call('post', '/meals/check', { body: { service_id: svc, inscription_id: ana } }));
    assert.strictEqual(priority.result, 'group_not_called', 'a priority person waits for their group like everyone else');
    assert.deepStrictEqual([priority.group, priority.called_groups], ['A', ['B']]);
    // Not served on a plain scan…
    const warned = ok(await w.p.call('post', '/meals/deliver', { body: { service_id: svc, inscription_id: inC } }));
    assert.strictEqual(warned.result, 'group_not_called');
    assert.strictEqual(w.p.q(`SELECT id FROM ${PREFIX}meal_deliveries WHERE service_id = ? AND inscription_id = ?`, svc, inC).length, 0, 'not served');
    // …the called group is.
    assert.strictEqual(ok(await w.p.call('post', '/meals/deliver', { body: { service_id: svc, inscription_id: inB } })).result, 'delivered');
    // «Dejar pasar igual»: served as an exception, logged with who, when, the person and their group.
    const allowed = ok(await w.p.call('post', '/meals/deliver', { body: { service_id: svc, inscription_id: inC, allow_group: true } }));
    assert.strictEqual(allowed.result, 'delivered');
    assert.strictEqual(allowed.method, 'group_exception');
    const ex = w.p.one(`SELECT grp, kind, inscription_id, actor, at_utc FROM ${PREFIX}meal_calls WHERE service_id = ? AND kind = 'exception'`, svc);
    assert.deepStrictEqual([ex.grp, Number(ex.inscription_id)], ['C', inC]);
    assert.ok(ex.actor, 'who allowed it');
    assert.match(ex.at_utc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The «Turnos de comida» screen: per group, entitled / served / pending / exceptions; the audit in order.
    const st = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}&service_id=${svc}`)).calls;
    const g = (x: string) => st.groups.find((r: any) => r.group === x);
    assert.deepStrictEqual([g('B').served, g('C').served, g('C').exceptions, g('A').served], [1, 1, 1, 0]);
    assert.strictEqual(g('B').pending, g('B').entitled - 1);
    assert.ok(g('B').called_at && !g('A').called_at);
    assert.deepStrictEqual(st.exceptions.map((x: any) => [x.group, x.inscription_id]), [['C', inC]]);
    assert.deepStrictEqual(st.log.map((x: any) => x.kind), ['call', 'exception']);
    // Calling A lets Ana through; a called group stays called; calling it again is refused.
    ok(await call('A'));
    assert.strictEqual(ok(await w.p.call('post', '/meals/deliver', { body: { service_id: svc, inscription_id: ana } })).result, 'delivered');
    assert.strictEqual((await call('A')).status, 409);
    // Undo (a mistaken call): logged; undoing a group not called is refused; the kitchen team may call too.
    const undone = ok(await call('B', { undo: true }));
    assert.deepStrictEqual(undone.state.called, ['A']);
    assert.strictEqual((await call('D', { undo: true })).status, 409);
    assert.deepStrictEqual(ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}&service_id=${svc}`)).calls.log.map((x: any) => x.kind), ['call', 'exception', 'call', 'undo']);
    assert.strictEqual((await call('Z')).status, 400);
    assert.strictEqual((await call('C', {}, NURSE)).status, 403, 'meals:view cannot call');
});

// ── 2.36.9 «Tipo de sangre» and «EPS» ────────────────────────────────────────────────────────────────────────

test('2.36.9 blood type and EPS: stored with the health answer, shown only with health:view, validated, optional', async () => {
    const w = await world();
    const row = (id: number) => w.p.one(`SELECT answer, conditions, blood_type, eps FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id);
    // Saved with the conditions; a typed «o-» is the list's «O−», the EPS is trimmed.
    const id = await w.person('Marta', { health_conditions: { conditions: ['Diabetes'], blood_type: 'o-', eps: '  Sura  ' } });
    assert.deepStrictEqual({ ...row(id) }, { answer: 'list', conditions: JSON.stringify(['Diabetes']), blood_type: 'O−', eps: 'Sura' });
    // «Ninguna» keeps them; only a blood type / EPS is an answer too (no conditions).
    const none = await w.person('Iván', { health_conditions: { answer: 'none', blood_type: 'AB+' } });
    assert.deepStrictEqual([row(none).answer, row(none).blood_type, row(none).eps], ['none', 'AB+', null]);
    const only = await w.person('Nora', { health_conditions: { eps: 'Nueva EPS' } });
    assert.deepStrictEqual([row(only).answer, row(only).conditions, row(only).blood_type, row(only).eps], ['list', '[]', null, 'Nueva EPS']);
    const unknown = await w.person('Saúl', { health_conditions: { blood_type: 'No sabe' } });
    assert.strictEqual(row(unknown).blood_type, 'No sabe');
    // Shown to health:view: the dedicated read, the roster text, the export.
    assert.deepStrictEqual(ok(await w.p.call('get', `/inscriptions/${id}/health`, { user: NURSE })).answer,
        { conditions: ['Diabetes'], other: '', answer: 'list', blood_type: 'O−', eps: 'Sura' });
    const rosterNurse = ok(await w.p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: NURSE }));
    assert.strictEqual(rosterNurse.find((r: any) => r.id === id).health_conditions, 'Diabetes · Tipo de sangre: O− · EPS: Sura');
    assert.strictEqual(rosterNurse.find((r: any) => r.id === only).health_conditions, 'EPS: Nueva EPS');
    const csv = ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    assert.ok(csv.includes('Tipo de sangre: O−') && csv.includes('EPS: Sura'), csv);
    // Hidden without health:view: no key in the roster or the person, 403 on the read, nothing in the export.
    const rows = ok(await w.p.call('get', `/inscriptions?conference_id=${w.cid}`, { user: NOHEALTH }));
    assert.ok(rows.every((r: any) => !('health_conditions' in r)));
    assert.ok(!JSON.stringify(ok(await w.p.call('get', `/inscriptions/${id}`, { user: NOHEALTH }))).includes('Sura'));
    assert.strictEqual((await w.p.call('get', `/inscriptions/${id}/health`, { user: NOHEALTH })).status, 403);
    const csvNo = ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`, { user: NOHEALTH })).csv as string;
    assert.ok(!csvNo.includes('Sura') && !csvNo.includes('O−') && !csvNo.includes('Tipo de sangre'), 'no health in the export');
    // …and cannot write them (they are health data).
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { user: NOHEALTH, body: { health_conditions: { conditions: ['Diabetes'], blood_type: 'A+' } } })).status, 403);
    // health:manage edits and clears them (the rest of the answer stays).
    ok(await w.p.call('put', `/inscriptions/${id}`, { user: NURSE, body: { health_conditions: { conditions: ['Diabetes'], blood_type: 'B+' } } }));
    assert.deepStrictEqual([row(id).blood_type, row(id).eps], ['B+', null]);
    // Validation: a blood type outside the list, a too long EPS, a wrong type.
    const bad = async (h: any) => (await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'X', location_id: w.norte, health_conditions: h } }));
    const b1 = await bad({ blood_type: 'C+' });
    assert.strictEqual(b1.status, 400);
    assert.match(b1.body.error, /tipo de sangre/i);
    assert.strictEqual((await bad({ eps: 'x'.repeat(121) })).status, 400);
    assert.strictEqual((await bad({ blood_type: 7 })).status, 400);
    assert.strictEqual((await bad({ eps: ['Sura'] })).status, 400);
});

test('2.36.9 a required health field still asks for the conditions: a blood type or an EPS alone does not answer it', async () => {
    const w = await world({ publish: false });
    const fid = w.p.one(`SELECT id, options FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid);
    ok(await w.p.call('post', '/fields', { body: { id: fid.id, conference_id: w.cid, label: 'Condiciones de salud', type: 'health', options: fid.options, is_required: true } }));
    const r = await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'X', location_id: w.norte, health_conditions: { blood_type: 'A+', eps: 'Sura' } } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /obligatorio/);
    const id = await w.person('Sofía', { health_conditions: { answer: 'declined', blood_type: 'A+' } });
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { eps: 'Sura' } } })).status, 400, 'an edit to only an EPS drops the required answer');
});

test('2.36.9 the portal registers blood type and EPS (write-only); legacy rows and a pre-2.36.9 table still load and export', async () => {
    const w = await world();
    const code = w.p.one(`SELECT code FROM ${PREFIX}locations WHERE id = ?`, w.norte).code;
    const token = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.norte, code } })).token as string;
    const r = await portal(w.p, 'post', '/portal/inscriptions', token, { first_name: 'Lucía', health_conditions: { answer: 'none', blood_type: 'A−', eps: 'Compensar' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual({ ...w.p.one(`SELECT blood_type, eps FROM ${PREFIX}health_answers WHERE inscription_id = ?`, r.body.id) }, { blood_type: 'A−', eps: 'Compensar' });
    assert.ok(!JSON.stringify((await portal(w.p, 'get', '/portal/inscriptions', token)).body).includes('Compensar'), 'the portal never reads it back');

    // An install from before 2.36.9: the table without the two columns, a row from then.
    const legacy = await w.person('Ramón', { health_conditions: { conditions: ['Hipertensión'] } });
    w.p.raw.exec(`ALTER TABLE ${PREFIX}health_answers DROP COLUMN blood_type`);
    w.p.raw.exec(`ALTER TABLE ${PREFIX}health_answers DROP COLUMN eps`);
    const colsOf = (p: Plugin) => p.raw.prepare(`PRAGMA table_info(${PREFIX}health_answers)`).all().map((c: any) => c.name);
    assert.ok(!colsOf(w.p).includes('blood_type'));
    // Starting the plugin again adds them (the migration), and the old rows read as answers without them.
    const p2 = await bootPlugin({ users: [NOHEALTH, NURSE], raw: w.p.raw });
    assert.ok(colsOf(p2).includes('blood_type') && colsOf(p2).includes('eps'));
    assert.deepStrictEqual(ok(await p2.call('get', `/inscriptions/${legacy}/health`, { user: NURSE })).answer, { conditions: ['Hipertensión'], other: '', answer: 'list' });
    const roster = ok(await p2.call('get', `/inscriptions?conference_id=${w.cid}`, { user: NURSE }));
    assert.strictEqual(roster.find((x: any) => x.id === legacy).health_conditions, 'Hipertensión');
    const csv = ok(await p2.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    assert.ok(csv.includes('Hipertensión'), csv);
    // …and a new answer on the old install keeps them.
    ok(await p2.call('put', `/inscriptions/${legacy}`, { user: NURSE, body: { health_conditions: { conditions: ['Hipertensión'], blood_type: 'O+' } } }));
    assert.strictEqual(p2.one(`SELECT blood_type FROM ${PREFIX}health_answers WHERE inscription_id = ?`, legacy).blood_type, 'O+');
    // Deleting the field still clears everything, the new parts included.
    ok(await p2.call('post', '/publish', { body: { conference_id: w.cid, published: false } }));
    const fid = p2.one(`SELECT id FROM ${PREFIX}fields WHERE conference_id = ? AND name = 'health_conditions'`, w.cid).id;
    ok(await p2.call('delete', `/fields/${fid}`));
    assert.strictEqual(p2.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE conference_id = ?`, w.cid).n, 0);
});
