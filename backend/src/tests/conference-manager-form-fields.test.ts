/**
 * conference-manager 2.17.0 — the registration form starts EMPTY and every field is the admin's to shape.
 *
 * The user's rule: «al crear la conferencia ya viene con esos campos por defecto y no debería ser así; en la
 * parte de agregar campos podríamos tener esos templates pero del resto todo debe poderse editar». Pinned here
 * against the REAL plugin (fixtures/conference-manager-harness.ts):
 *   - a new conference (POST /create, and the Default Conference of a fresh install) has no field and no
 *     assignment rule, and a restart does not seed them back (the old boot backfill is gone);
 *   - existing conferences keep their fields across the upgrade;
 *   - POST /fields { template } creates a base field with the exact column / type / options / role the
 *     features read, appended at the end, refuses a duplicate (409) even under a double click, honours the
 *     published-form lock, and never steals the «one grouping field» flag;
 *   - base fields can be deleted while the form is unpublished (the lock stays for a published form);
 *   - every feature degrades gracefully without a base field: an inscription with no form at all, a price
 *     rule on a deleted field (skipped, never matched against an empty value), the lodging view and the
 *     gender report without a «Género» field.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, type HarnessUser } from './fixtures/conference-manager-harness';

const F = 'wjp_conference_manager_fields';

let seq = 0;
async function newConference(p: any, name = 'Congreso 2027') {
    const r = await p.call('post', '/create', { body: { name, slug: `conf-${++seq}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
}
const fieldsOf = (p: any, cid: number) => p.q(`SELECT name, label, type, options, is_required, role, is_group, is_unique, sort_order FROM ${F} WHERE conference_id = ? ORDER BY sort_order, id`, cid);
async function addTemplate(p: any, cid: number, template: string, label?: string) {
    return p.call('post', '/fields', { body: { conference_id: cid, template, ...(label ? { label } : {}) } });
}

test('a new conference starts with no field and no assignment rule — also the Default Conference of a fresh install', async () => {
    const p = await bootPlugin();
    const def = p.one('SELECT id FROM wjp_conference_manager_conferences WHERE slug = ?', 'default-conf');
    assert.ok(def, 'the default conference is still seeded');
    assert.deepStrictEqual(fieldsOf(p, def.id), []);
    assert.strictEqual(p.q('SELECT id FROM wjp_conference_manager_assignment_rules WHERE conference_id = ?', def.id).length, 0);

    const cid = await newConference(p);
    assert.deepStrictEqual(fieldsOf(p, cid), []);
    assert.strictEqual(p.q('SELECT id FROM wjp_conference_manager_assignment_rules WHERE conference_id = ?', cid).length, 0);
    const api = await p.call('get', `/fields?conference_id=${cid}`);
    assert.deepStrictEqual(api.body, []);
});

test('a restart does not seed fields back onto an empty form, and keeps the fields an existing conference has', async () => {
    const p = await bootPlugin();
    const empty = await newConference(p, 'Vacío');
    const built = await newConference(p, 'Con campos');
    assert.strictEqual((await addTemplate(p, built, 'first_name')).status, 200);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: built, label: 'Talla', type: 'text' } })).status, 200);
    // A pre-2.17.0 conference: the old default form, rows as the old seed wrote them.
    p.exec(`INSERT INTO wjp_conference_manager_conferences (name, slug) VALUES ('Legacy', 'legacy')`);
    const legacy = p.one(`SELECT id FROM wjp_conference_manager_conferences WHERE slug = 'legacy'`).id;
    p.exec(`INSERT INTO ${F} (conference_id, name, label, type, options, is_required, sort_order, role) VALUES (?, 'gender', 'Género', 'select', 'M, F', 1, 3, 'gender')`, legacy);
    const before = { empty: fieldsOf(p, empty), built: fieldsOf(p, built), legacy: fieldsOf(p, legacy) };

    await p.reboot();
    await p.reboot();
    assert.deepStrictEqual(fieldsOf(p, empty), [], 'no field seeded onto the empty form');
    assert.deepStrictEqual(fieldsOf(p, built), before.built);
    assert.deepStrictEqual(fieldsOf(p, legacy), before.legacy);
    assert.deepStrictEqual(p.logs.filter((l: any) => l[0] !== 'log'), [], 'boot and restarts log no warning');
});

test('templates create the base fields with the exact definition the features read, at the end of the form', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Iglesia', type: 'text' } })).status, 200);
    for (const t of ['first_name', 'last_name', 'email', 'phone', 'gender', 'family_group']) {
        const r = await addTemplate(p, cid, t);
        assert.strictEqual(r.status, 200, `${t}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.name, t);
    }
    const rows = fieldsOf(p, cid).map((f: any) => [f.name, f.label, f.type, f.options, f.is_required, f.role, f.is_group]);
    assert.deepStrictEqual(rows.slice(1), [
        ['first_name', 'Nombre', 'text', '', 1, 'first_name', 0],
        ['last_name', 'Apellido', 'text', '', 1, 'last_name', 0],
        ['email', 'Email', 'text', '', 0, 'email', 0],
        ['phone', 'Teléfono', 'text', '', 0, 'phone', 0],
        ['gender', 'Género', 'select', 'M, F', 1, 'gender', 0],
        ['family_group', 'Grupo Familiar', 'text', '', 0, '', 1],
    ]);
    assert.match(rows[0][0], /^f_/, 'the custom field added first keeps its generated column, first in the form');
    const orders = fieldsOf(p, cid).map((f: any) => f.sort_order);
    assert.deepStrictEqual(orders, [...orders].sort((a: number, b: number) => a - b));
    assert.strictEqual(new Set(orders).size, orders.length, 'each new field goes after the previous one');

    // A custom field added now goes after them, not to the top (the builder sends sort_order 0 for a new field).
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Talla', type: 'text', sort_order: 0 } })).status, 200);
    const all = fieldsOf(p, cid);
    assert.strictEqual(all[all.length - 1].label, 'Talla');

    // The label may be given (the UI sends it in the admin's language); the rest stays fixed.
    const c2 = await newConference(p, 'English');
    assert.strictEqual((await addTemplate(p, c2, 'first_name', 'First name')).status, 200);
    assert.deepStrictEqual(fieldsOf(p, c2).map((f: any) => [f.name, f.label, f.role]), [['first_name', 'First name', 'first_name']]);
});

test('a template refuses a duplicate — by column or by role — and a double click creates one field', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await addTemplate(p, cid, 'email')).status, 200);
    const dup = await addTemplate(p, cid, 'email');
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.body.code, 'field_exists');
    assert.match(dup.body.error, /Email/);

    // A legacy field that carries the role under another column name still counts.
    p.exec(`INSERT INTO ${F} (conference_id, name, label, type, role) VALUES (?, 'f_tel', 'Celular', 'text', 'phone')`, cid);
    assert.strictEqual((await addTemplate(p, cid, 'phone')).status, 409);

    // Two requests at once (a double click): exactly one row.
    const [a, b] = await Promise.all([addTemplate(p, cid, 'first_name'), addTemplate(p, cid, 'first_name')]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
    assert.strictEqual(p.q(`SELECT id FROM ${F} WHERE conference_id = ? AND name = 'first_name'`, cid).length, 1);

    assert.strictEqual((await addTemplate(p, cid, 'location')).status, 400, 'the location is not a form field');
    assert.strictEqual((await addTemplate(p, cid, 'constructor')).status, 400);
    assert.strictEqual((await addTemplate(p, 9999, 'gender')).status, 404);
});

test('the family group template never takes the grouping flag from another field', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Delegación', type: 'text', is_group: 1 } })).status, 200);
    const r = await addTemplate(p, cid, 'family_group');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.is_group, 0);
    const groups = p.q(`SELECT label FROM ${F} WHERE conference_id = ? AND is_group = 1`, cid).map((x: any) => x.label);
    assert.deepStrictEqual(groups, ['Delegación']);
});

test('every field is deletable while the form is unpublished; a published form stays locked', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    for (const t of ['first_name', 'last_name', 'gender', 'family_group']) assert.strictEqual((await addTemplate(p, cid, t)).status, 200);
    const id = (name: string) => p.one(`SELECT id FROM ${F} WHERE conference_id = ? AND name = ?`, cid, name).id;

    assert.strictEqual((await p.call('delete', `/fields/${id('first_name')}`)).status, 200);
    assert.strictEqual((await p.call('delete', `/fields/${id('gender')}`)).status, 200);
    assert.deepStrictEqual(fieldsOf(p, cid).map((f: any) => f.name), ['last_name', 'family_group']);
    // Re-adding a deleted base field works (the form is not published).
    assert.strictEqual((await addTemplate(p, cid, 'gender')).status, 200);

    // Editing a base field (label, type, options) works while unpublished.
    const g = p.one(`SELECT * FROM ${F} WHERE conference_id = ? AND name = 'gender'`, cid);
    const edit = await p.call('post', '/fields', { body: { ...g, conference_id: cid, label: 'Sexo', options: 'Hombre, Mujer' } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
    assert.deepStrictEqual([p.one(`SELECT label, options, role FROM ${F} WHERE id = ?`, g.id)].map((x: any) => [x.label, x.options, x.role]), [['Sexo', 'Hombre, Mujer', 'gender']]);

    assert.strictEqual((await p.call('post', '/publish', { body: { conference_id: cid, published: true } })).status, 200);
    assert.strictEqual((await p.call('delete', `/fields/${id('last_name')}`)).status, 400);
    assert.strictEqual((await addTemplate(p, cid, 'email')).status, 400);
    assert.strictEqual(p.q(`SELECT id FROM ${F} WHERE conference_id = ?`, cid).length, 3);
});

test('an inscription can be created on a conference with no form at all', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    const r = await p.call('post', '/inscriptions', { body: { conference_id: cid } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const row = p.one('SELECT first_name, last_name, reg_code FROM wjp_conference_manager_inscriptions WHERE id = ?', r.body.id);
    assert.deepStrictEqual([row.first_name, row.last_name], ['', '']);
    assert.ok(row.reg_code);
    const list = await p.call('get', `/inscriptions?conference_id=${cid}`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.length, 1);
});

test('a price rule on a deleted field is skipped, never matched against an empty value', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('put', `/${cid}`, { body: { fee_default: 100 } })).status, 200);
    assert.strictEqual((await addTemplate(p, cid, 'gender')).status, 200);
    // «Género ≠ F → 30»: with the field deleted, an always-empty value would be «≠ F» for everybody.
    assert.strictEqual((await p.call('post', '/fee-rules', { body: { conference_id: cid, label: 'Varones', field_name: 'gender', operator: 'neq', value: 'F', action: 'set', amount: 30 } })).status, 200);
    // An unconditional rule keeps applying.
    assert.strictEqual((await p.call('post', '/fee-rules', { body: { conference_id: cid, label: 'Recargo', field_name: '', operator: 'any', action: 'add', amount: 5, priority: 99 } })).status, 200);

    const before = await p.call('post', '/inscriptions', { body: { conference_id: cid, gender: 'M' } });
    assert.strictEqual(p.one('SELECT total_due FROM wjp_conference_manager_inscriptions WHERE id = ?', before.body.id).total_due, 35);

    const gid = p.one(`SELECT id FROM ${F} WHERE conference_id = ? AND name = 'gender'`, cid).id;
    assert.strictEqual((await p.call('delete', `/fields/${gid}`)).status, 200);
    const after = await p.call('post', '/inscriptions', { body: { conference_id: cid } });
    assert.strictEqual(p.one('SELECT total_due FROM wjp_conference_manager_inscriptions WHERE id = ?', after.body.id).total_due, 105, 'base fee + the unconditional rule only');

    // «Recalcular todos» follows the same rule.
    const rp = await p.call('post', '/reprice', { body: { conference_id: cid } });
    assert.strictEqual(rp.status, 200);
    assert.strictEqual(p.one('SELECT total_due FROM wjp_conference_manager_inscriptions WHERE id = ?', before.body.id).total_due, 105);
});

test('without a «Género» field the lodging view carries no gender and the report no gender breakdown', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    const loc = await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 10 } });
    assert.strictEqual(loc.status, 200, JSON.stringify(loc.body));
    const ins = await p.call('post', '/inscriptions', { body: { conference_id: cid, location_id: loc.body.id } });
    assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
    // A value left in the column (a «Género» field that was deleted).
    p.exec('UPDATE wjp_conference_manager_inscriptions SET gender = ? WHERE id = ?', 'F', ins.body.id);

    const noField = await p.call('get', `/locations/${loc.body.id}/lodging`);
    assert.strictEqual(noField.status, 200, JSON.stringify(noField.body));
    assert.strictEqual(noField.body.unassigned.length, 1);
    assert.strictEqual(noField.body.unassigned[0].gender, null);
    const rep = await p.call('get', `/reports/summary?conference_id=${cid}`);
    assert.strictEqual(rep.status, 200);
    assert.deepStrictEqual(rep.body.byGender, []);

    assert.strictEqual((await addTemplate(p, cid, 'gender')).status, 200);
    const withField = await p.call('get', `/locations/${loc.body.id}/lodging`);
    assert.strictEqual(withField.body.unassigned[0].gender, 'F');
    assert.ok(withField.body.fields.some((f: any) => f.name === 'gender' && f.role === 'gender'), 'the view names each field\'s role');
    const rep2 = await p.call('get', `/reports/summary?conference_id=${cid}`);
    assert.deepStrictEqual(rep2.body.byGender, [{ gender: 'F', count: 1 }]);
});

test('without Nombre / Apellido fields the meals screens name (and find) people by the other form fields fit to be a name', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Nombre completo', type: 'text' } })).status, 200);
    assert.strictEqual((await addTemplate(p, cid, 'email')).status, 200);
    const col = p.one(`SELECT name FROM ${F} WHERE conference_id = ? AND label = 'Nombre completo'`, cid).name;
    const ana = await p.call('post', '/inscriptions', { body: { conference_id: cid, [col]: 'Ana Ruiz', email: 'ana@example.test' } });
    const blank = await p.call('post', '/inscriptions', { body: { conference_id: cid } });
    assert.strictEqual(ana.status, 200, JSON.stringify(ana.body));
    const svc = await p.call('post', '/meals/services', { body: { conference_id: cid, service_date: '2027-03-01', meal: 'almuerzo' } });
    assert.strictEqual(svc.status, 200, JSON.stringify(svc.body));

    const found = await p.call('get', `/meals/people?conference_id=${cid}&q=ruiz`);
    assert.strictEqual(found.status, 200, JSON.stringify(found.body));
    assert.deepStrictEqual(found.body.people.map((x: any) => [x.id, x.name]), [[ana.body.id, 'Ana Ruiz']]);
    const all = await p.call('get', `/meals/people?conference_id=${cid}`);
    assert.deepStrictEqual(all.body.people.map((x: any) => x.name).sort(), [`#${blank.body.id}`, 'Ana Ruiz']);

    const one = await p.call('get', `/meals/inscriptions/${ana.body.id}`);
    assert.strictEqual(one.body.person.name, 'Ana Ruiz');
    const served = await p.call('post', '/meals/deliver', { body: { service_id: svc.body.id, inscription_id: ana.body.id, force: true } });
    assert.strictEqual(served.status, 200, JSON.stringify(served.body));
    assert.strictEqual(served.body.person.name, 'Ana Ruiz');
    const recent = await p.call('get', `/meals/services/${svc.body.id}/deliveries`);
    assert.deepStrictEqual(recent.body.deliveries.map((d: any) => d.name), ['Ana Ruiz']);
    const report = await p.call('get', `/meals/services/${svc.body.id}/report`);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    assert.deepStrictEqual(report.body.rows.map((r: any) => r.name), ['Ana Ruiz']);

    // Empty name fields do not take the fallback's places: a value in the third other field still names the person.
    const c2 = await newConference(p, 'Orden');
    for (const t of ['first_name', 'last_name']) assert.strictEqual((await addTemplate(p, c2, t)).status, 200);
    for (const label of ['A', 'B', 'C']) assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: c2, label, type: 'text' } })).status, 200);
    const colC = p.one(`SELECT name FROM ${F} WHERE conference_id = ? AND label = 'C'`, c2).name;
    p.exec(`UPDATE ${F} SET is_required = 0 WHERE conference_id = ?`, c2);
    const onlyC = await p.call('post', '/inscriptions', { body: { conference_id: c2, [colC]: 'Solo C' } });
    assert.strictEqual(onlyC.status, 200, JSON.stringify(onlyC.body));
    assert.strictEqual((await p.call('get', `/meals/inscriptions/${onlyC.body.id}`)).body.person.name, 'Solo C');

    // With name fields, they win — as before.
    assert.strictEqual((await addTemplate(p, cid, 'first_name')).status, 200);
    p.exec('UPDATE wjp_conference_manager_inscriptions SET first_name = ? WHERE id = ?', 'Anita', ana.body.id);
    assert.strictEqual((await p.call('get', `/meals/inscriptions/${ana.body.id}`)).body.person.name, 'Anita');
});

// ── review round ─────────────────────────────────────────────────────────────────────────────────────────

/** A coordinator's portal call (the portal authenticates with its own token, never a WordJS session). */
async function portalCall(p: any, method: string, path: string, token: string, body?: any) {
    const r = p.routes.find((x: any) => x.method === method && x.path === path);
    assert.ok(r, `portal route ${method} ${path}`);
    const res: any = {
        statusCode: 200, _body: undefined,
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this._body = JSON.parse(JSON.stringify(b)); return this; },
        cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; },
    };
    await r.handler({ params: {}, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
    return { status: res.statusCode, body: res._body };
}

test('the fallback name is never an ID document, a contact or notes — a kitchen role that cannot read the roster sees a number', async () => {
    const KITCHEN: HarnessUser = { id: 50, role: 'conference_manager_team', userLogin: 'cocina' };
    const p = await bootPlugin({ users: [KITCHEN] });
    const cid = await newConference(p);
    // A form with no Nombre / Apellido: an ID document (unique), the e-mail template, a phone and notes.
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Documento', type: 'text', is_unique: 1 } })).status, 200);
    assert.strictEqual((await addTemplate(p, cid, 'email')).status, 200);
    assert.strictEqual((await addTemplate(p, cid, 'phone')).status, 200);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Notas', type: 'textarea' } })).status, 200);
    const col = (label: string) => p.one(`SELECT name FROM ${F} WHERE conference_id = ? AND label = ?`, cid, label).name;
    const ins = await p.call('post', '/inscriptions', { body: { conference_id: cid, [col('Documento')]: '12.345.678-9', email: 'ana@example.test', phone: '300 123', [col('Notas')]: 'alergia al maní' } });
    assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
    const role = await p.call('post', '/staff/roles', { body: { name: 'Solo entregas', permissions: { meals_delivery: 'manage' } } });
    assert.strictEqual(role.status, 200, JSON.stringify(role.body));
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: KITCHEN.id, role_id: role.body.id } })).status, 200);
    const svc = await p.call('post', '/meals/services', { body: { conference_id: cid, service_date: '2027-03-01', meal: 'almuerzo' } });
    assert.strictEqual((await p.call('get', `/inscriptions?conference_id=${cid}`, { user: KITCHEN })).status, 403, 'the kitchen may not read the roster');

    const scan = await p.call('post', '/meals/deliver', { user: KITCHEN, body: { service_id: svc.body.id, inscription_id: ins.body.id } });
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.strictEqual(scan.body.person.name, `#${ins.body.id}`);
    const people = await p.call('get', `/meals/people?conference_id=${cid}`, { user: KITCHEN });
    assert.deepStrictEqual(people.body.people.map((x: any) => x.name), [`#${ins.body.id}`]);
    for (const secret of ['12.345.678-9', 'ana@example.test', '300 123', 'maní']) {
        assert.ok(!JSON.stringify(scan.body).includes(secret) && !JSON.stringify(people.body).includes(secret), `the kitchen was shown ${secret}`);
    }
    // Positive control: a plain text field still names the person.
    const plain = await p.call('post', '/fields', { body: { conference_id: cid, label: 'Nombre completo', type: 'text' } });
    assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
    p.exec(`UPDATE wjp_conference_manager_inscriptions SET ${col('Nombre completo')} = 'Ana Ruiz' WHERE id = ?`, ins.body.id);
    assert.strictEqual((await p.call('get', `/meals/people?conference_id=${cid}`, { user: KITCHEN })).body.people[0].name, 'Ana Ruiz');
});

test('a price rule on the location (a column the server always fills) still applies when the form has no such field', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('put', `/${cid}`, { body: { fee_default: 100 } })).status, 200);
    const norte = await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 10 } });
    const sur = await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 10 } });
    const rule = await p.call('post', '/fee-rules', { body: { conference_id: cid, label: 'Norte', field_name: 'location', operator: 'eq', value: 'Norte', action: 'set', amount: 80 } });
    assert.strictEqual(rule.status, 200, JSON.stringify(rule.body));
    const a = await p.call('post', '/inscriptions', { body: { conference_id: cid, location_id: norte.body.id } });
    const b = await p.call('post', '/inscriptions', { body: { conference_id: cid, location_id: sur.body.id } });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    const due = (id: number) => Number(p.one('SELECT total_due FROM wjp_conference_manager_inscriptions WHERE id = ?', id).total_due);
    assert.strictEqual(due(a.body.id), 80, 'the location rule applies');
    assert.strictEqual(due(b.body.id), 100, 'control: another location pays the base fee');
});

test('a form with no field cannot be published (server-side, not only in the page); unpublishing always can', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    const empty = await p.call('post', '/publish', { body: { conference_id: cid, published: true } });
    assert.strictEqual(empty.status, 400, JSON.stringify(empty.body));
    assert.strictEqual(empty.body.code, 'form_empty');
    assert.strictEqual(p.one('SELECT is_form_published FROM wjp_conference_manager_conferences WHERE id = ?', cid).is_form_published, 0);
    assert.strictEqual((await p.call('post', '/publish', { body: { conference_id: cid, published: false } })).status, 200);
    assert.strictEqual((await addTemplate(p, cid, 'first_name')).status, 200);
    assert.strictEqual((await p.call('post', '/publish', { body: { conference_id: cid, published: true } })).status, 200);
});

test('the coordinators\' portal names attendees like the admin does: display_name in the lodging view, roles in the public fields', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Documento', type: 'text', is_unique: 1 } })).status, 200);
    assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, label: 'Nombre completo', type: 'text', is_required: 1 } })).status, 200);
    const col = (label: string) => p.one(`SELECT name FROM ${F} WHERE conference_id = ? AND label = ?`, cid, label).name;
    const loc = await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 10 } });
    const ins = await p.call('post', '/inscriptions', { body: { conference_id: cid, location_id: loc.body.id, [col('Documento')]: '12.345', [col('Nombre completo')]: 'Ana Ruiz' } });
    assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
    assert.strictEqual((await p.call('post', '/publish', { body: { conference_id: cid, published: true } })).status, 200);
    const code = p.one('SELECT code FROM wjp_conference_manager_locations WHERE id = ?', loc.body.id).code;
    const login = await p.call('post', '/portal/login', { anonymous: true, body: { location_id: loc.body.id, code } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const view = await portalCall(p, 'get', '/portal/lodging', login.body.token);
    assert.strictEqual(view.status, 200, JSON.stringify(view.body));
    assert.strictEqual(view.body.unassigned[0].display_name, 'Ana Ruiz', 'not the document, not «#id»');
    // The public fields carry `role` and `is_unique`: the portal's inscription list names people from them
    // (the fields tagged Nombre / Apellido; never the ID document) — frontend portal form.ts portalPersonName.
    const pub = await p.call('get', `/public/fields?conference_id=${cid}`, { anonymous: true });
    assert.strictEqual(pub.status, 200, JSON.stringify(pub.body));
    assert.deepStrictEqual(pub.body.map((f: any) => [f.label, Number(f.is_unique), 'role' in f]), [['Documento', 1, true], ['Nombre completo', 0, true]]);
    const c2 = await newConference(p, 'Con plantillas');
    assert.strictEqual((await addTemplate(p, c2, 'first_name')).status, 200);
    assert.strictEqual((await p.call('post', '/publish', { body: { conference_id: c2, published: true } })).status, 200);
    const pub2 = await p.call('get', `/public/fields?conference_id=${c2}`, { anonymous: true });
    assert.deepStrictEqual(pub2.body.map((f: any) => [f.name, f.role]), [['first_name', 'first_name']]);
});

test('an assignment rule on a field the form no longer has takes no effect (engine skipped), and a new one is refused', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await addTemplate(p, cid, 'gender')).status, 200);
    const hard = await p.call('post', '/assignment/rules', { body: { conference_id: cid, name: 'Separar por género', type: 'separate_by', config: 'gender', hard: 1 } });
    assert.strictEqual(hard.status, 200, JSON.stringify(hard.body));
    const hotel = await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Hotel Sol' } });
    assert.strictEqual((await p.call('post', '/rooms', { body: { hotel_id: hotel.body.id, room_number: '101', capacity: 2 } })).status, 200);
    const a = await p.call('post', '/inscriptions', { body: { conference_id: cid, gender: 'M' } });
    const b = await p.call('post', '/inscriptions', { body: { conference_id: cid, gender: 'F' } });
    const roomOf = (id: number) => p.one('SELECT room_id FROM wjp_conference_manager_inscriptions WHERE id = ?', id).room_id;
    const reset = () => p.exec('UPDATE wjp_conference_manager_inscriptions SET room_id = NULL WHERE conference_id = ?', cid);

    // Control: while the form has «Género», the hard rule keeps a man and a woman out of one room.
    assert.strictEqual((await p.call('post', '/assignment/run', { body: { conference_id: cid } })).status, 200);
    assert.ok(!(roomOf(a.body.id) && roomOf(b.body.id)), 'the rule acted');
    reset();

    // «Género» deleted (the values stay in the column): the rule no longer acts — what the page says.
    const gid = p.one(`SELECT id FROM ${F} WHERE conference_id = ? AND name = 'gender'`, cid).id;
    assert.strictEqual((await p.call('delete', `/fields/${gid}`)).status, 200);
    const run = await p.call('post', '/assignment/run', { body: { conference_id: cid } });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    assert.ok(roomOf(a.body.id) && roomOf(a.body.id) === roomOf(b.body.id), 'both placed in the one room: the rule was skipped');

    // A NEW rule on it is refused (the form does not have it); one on the location (always filled) is accepted.
    const again = await p.call('post', '/assignment/rules', { body: { conference_id: cid, name: 'Otra', type: 'separate_by', config: 'gender' } });
    assert.strictEqual(again.status, 400, JSON.stringify(again.body));
    const byLoc = await p.call('post', '/assignment/rules', { body: { conference_id: cid, name: 'Por localidad', type: 'keep_together', config: 'location', priority: 20 } });
    assert.strictEqual(byLoc.status, 200, JSON.stringify(byLoc.body));
});

test('GET /assignment/rules?all=1 adds every location\'s own rules with the location\'s name (for the delete-field warning)', async () => {
    const p = await bootPlugin();
    const cid = await newConference(p);
    assert.strictEqual((await addTemplate(p, cid, 'family_group')).status, 200);
    const loc = await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 10 } });
    assert.strictEqual((await p.call('post', '/assignment/rules', { body: { conference_id: cid, name: 'Familias juntas', type: 'keep_together', config: 'family_group' } })).status, 200);
    p.exec(`INSERT INTO wjp_conference_manager_assignment_rules (conference_id, location_id, name, type, config, params, enabled, priority, hard) VALUES (?, ?, 'Familias del norte', 'keep_together', 'family_group', '{}', 1, 0, 0)`, cid, loc.body.id);
    const conferenceOnly = await p.call('get', `/assignment/rules?conference_id=${cid}`);
    assert.deepStrictEqual(conferenceOnly.body.map((r: any) => r.name), ['Familias juntas']);
    const all = await p.call('get', `/assignment/rules?conference_id=${cid}&all=1`);
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.deepStrictEqual(all.body.map((r: any) => [r.name, r.location_name ?? null]).sort(), [['Familias del norte', 'Norte'], ['Familias juntas', null]]);
});
