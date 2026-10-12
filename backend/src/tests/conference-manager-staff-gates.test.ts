/**
 * conference-manager — two staff gates that sit next to another section's data.
 *
 *   1. DELETE /:id (deleting a conference) takes the conference's attendees, fee payments, transport payments
 *      and accounting ledger with it (the foreign keys cascade). Erasing any of those through its own route
 *      needs that section's manage level (DELETE /inscriptions/:id refuses an attendee with payments to a
 *      role that cannot manage them), so the conference delete asks for the same: settings:manage, plus
 *      manage on every section whose records the conference still holds. An empty conference needs
 *      settings:manage only; an administrator deletes any conference, as before.
 *   2. GET /meals/people (the meals people search, open to the kitchen's meals_delivery:manage) carries the
 *      attendee's ID document (document_number) only for a caller with inscriptions:view, like reg_code; the
 *      kitchen finds a person by the whole document and never by a part of it.
 *
 * Every assertion drives the REAL plugin (fixtures/conference-manager-harness.ts), whose database enforces
 * the foreign keys like the host's drivers do.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin, PREFIX, type HarnessUser } from './fixtures/conference-manager-harness';

const TEAM_ROLE = 'conference_manager_team';
const TEAM_CAP = 'conference_manager_access';
const member = (id: number, login: string): HarnessUser => ({
    id, role: TEAM_ROLE, userLogin: login, userEmail: `${login}@example.test`, displayName: login, extra: { pluginCapabilities: [TEAM_CAP] },
});

async function addMember(p: any, u: HarnessUser, permissions: Record<string, string>) {
    const role = await p.call('post', '/staff/roles', { body: { name: `Rol ${u.userLogin}`, permissions } });
    assert.strictEqual(role.status, 200, JSON.stringify(role.body));
    const m = await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: role.body.id } });
    assert.strictEqual(m.status, 200, JSON.stringify(m.body));
}

const count = (p: any, table: string) => Number(p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}${table}`).n);
/** What is left of conference `cid` and of the money tables (a fresh install also holds a default, empty conference). */
const rowsLeft = (p: any, cid: number) => ({
    conference: Number(p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}conferences WHERE id = ?`, cid).n),
    inscriptions: count(p, 'inscriptions'),
    payments: count(p, 'payments'),
    transport_payments: count(p, 'transport_payments'),
    ledger: count(p, 'ledger_entries'),
});

/** A conference holding money of every kind: a validated fee payment (100), a paid ticket (30), a ledger entry (500). */
async function conferenceWithMoney(p: any) {
    const conf = await p.call('post', '/create', { body: { name: 'Congreso', fee_default: 100 } });
    assert.strictEqual(conf.status, 200, JSON.stringify(conf.body));
    const cid = conf.body.id;
    const ins = await p.call('post', '/inscriptions', { body: { conference_id: cid } });
    assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
    const iid = ins.body.id;
    const pay = p.exec(`INSERT INTO ${PREFIX}payments (inscription_id, amount, method, proof, status) VALUES (?, 100, 'Efectivo', 'x', 'pending')`, iid);
    assert.strictEqual((await p.call('post', `/payments/${pay.lastInsertRowid}/validate`)).status, 200);
    const bus = await p.call('post', '/buses', { body: { conference_id: cid, name: 'Bus 1', capacity: 40, price: 30 } });
    assert.strictEqual(bus.status, 200, JSON.stringify(bus.body));
    assert.strictEqual((await p.call('post', `/buses/${bus.body.id}/passengers`, { body: { inscription_ids: [iid] } })).status, 200);
    const ticket = p.one(`SELECT id FROM ${PREFIX}transport_tickets WHERE inscription_id = ?`, iid);
    assert.strictEqual((await p.call('post', `/tickets/${ticket.id}/payments`, { body: { amount: 30, method: 'Efectivo' } })).status, 200);
    const led = await p.call('post', '/accounting/entries', { body: { conference_id: cid, kind: 'income', amount: 500, date: '2026-10-01', description: 'Donación' } });
    assert.strictEqual(led.status, 200, JSON.stringify(led.body));
    const acc = await p.call('get', `/accounting?conference_id=${cid}`);
    assert.strictEqual(acc.body.totals.income, 630, JSON.stringify(acc.body.totals));
    return { cid, iid };
}

test('DELETE /:id: settings:manage alone cannot erase a conference\'s attendees, payments and ledger; an empty conference it can', async () => {
    const SET = member(50, 'cfg');
    const SET_ACC = member(51, 'cfgacc');
    const ALL = member(52, 'all');
    const p = await bootPlugin({ users: [SET, SET_ACC, ALL] });
    await addMember(p, SET, { settings: 'manage' });
    await addMember(p, SET_ACC, { settings: 'manage', accounting: 'manage' });
    await addMember(p, ALL, { settings: 'manage', inscriptions: 'manage', payments: 'manage', transport: 'manage', accounting: 'manage' });
    const { cid } = await conferenceWithMoney(p);
    const before = rowsLeft(p, cid);
    assert.deepStrictEqual(before, { conference: 1, inscriptions: 1, payments: 1, transport_payments: 1, ledger: 1 });

    // The same member is refused each record through its own route…
    assert.strictEqual((await p.call('get', `/accounting?conference_id=${cid}`, { user: SET })).status, 403);
    // …and so through the conference: 409, naming what it holds, nothing erased.
    const refused = await p.call('delete', `/${cid}`, { user: SET });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'conference_has_records');
    assert.deepStrictEqual(refused.body.sections, ['inscriptions', 'payments', 'transport', 'accounting']);
    assert.deepStrictEqual(rowsLeft(p, cid), before);
    assert.strictEqual((await p.call('get', `/accounting?conference_id=${cid}`)).body.totals.income, 630);

    // Managing the ledger is not enough while attendees and their payments are there.
    const partly = await p.call('delete', `/${cid}`, { user: SET_ACC });
    assert.strictEqual(partly.status, 409, JSON.stringify(partly.body));
    assert.deepStrictEqual(partly.body.sections, ['inscriptions', 'payments', 'transport']);
    assert.deepStrictEqual(rowsLeft(p, cid), before);

    // Positive controls: an empty conference is the settings role's to delete…
    const empty = await p.call('post', '/create', { body: { name: 'Vacía' } });
    assert.strictEqual(empty.status, 200, JSON.stringify(empty.body));
    assert.deepStrictEqual((await p.call('delete', `/${empty.body.id}`, { user: SET })).body, { success: true });
    assert.strictEqual(p.one(`SELECT id FROM ${PREFIX}conferences WHERE id = ?`, empty.body.id), undefined);
    // …one that holds only a ledger is the settings + accounting role's…
    const ledgerOnly = await p.call('post', '/create', { body: { name: 'Solo contabilidad' } });
    assert.strictEqual((await p.call('post', '/accounting/entries', { body: { conference_id: ledgerOnly.body.id, kind: 'expense', amount: 5, date: '2026-10-02', description: 'Gasto' } })).status, 200);
    assert.strictEqual((await p.call('delete', `/${ledgerOnly.body.id}`, { user: SET })).status, 409);
    assert.deepStrictEqual((await p.call('delete', `/${ledgerOnly.body.id}`, { user: SET_ACC })).body, { success: true });
    // …and a role that manages every section the money conference holds deletes it, everything with it.
    assert.deepStrictEqual((await p.call('delete', `/${cid}`, { user: ALL })).body, { success: true });
    assert.deepStrictEqual(rowsLeft(p, cid), { conference: 0, inscriptions: 0, payments: 0, transport_payments: 0, ledger: 0 });
});

test('DELETE /:id: an administrator still deletes a conference with money, and an unknown id still answers success', async () => {
    const p = await bootPlugin();
    const { cid } = await conferenceWithMoney(p);
    assert.deepStrictEqual((await p.call('delete', `/${cid}`)).body, { success: true });
    assert.deepStrictEqual(rowsLeft(p, cid), { conference: 0, inscriptions: 0, payments: 0, transport_payments: 0, ledger: 0 });
    const again = await p.call('delete', `/${cid}`);
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
});

test('GET /meals/people: the kitchen gets no ID document and finds a person only by the whole document', async () => {
    const COOK = member(60, 'cook');
    const DESK = member(61, 'desk');
    const p = await bootPlugin({ users: [COOK, DESK] });
    await addMember(p, COOK, { meals_delivery: 'manage' });
    await addMember(p, DESK, { meals: 'view', inscriptions: 'view' });
    const conf = await p.call('post', '/create', { body: { name: 'C' } });
    const cid = conf.body.id;
    for (const t of ['first_name', 'last_name']) assert.strictEqual((await p.call('post', '/fields', { body: { conference_id: cid, template: t } })).status, 200);
    const doc = await p.call('post', '/fields', { body: { conference_id: cid, name: 'document_number', label: 'DNI', type: 'text', is_unique: true } });
    assert.strictEqual(doc.status, 200, JSON.stringify(doc.body));
    for (let i = 0; i < 3; i++) {
        const ins = await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: `Ana${i}`, last_name: 'Pérez', document_number: `X-1234567${i}` } });
        assert.strictEqual(ins.status, 200, JSON.stringify(ins.body));
    }
    assert.strictEqual((await p.call('get', `/inscriptions?conference_id=${cid}`, { user: COOK })).status, 403, 'the kitchen may not read the roster');
    const people = (u: HarnessUser | undefined, q = '') => p.call('get', `/meals/people?conference_id=${cid}&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`, { user: u });

    // The kitchen: every attendee listed, no document on any of them.
    const all = await people(COOK);
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.strictEqual(all.body.people.length, 3);
    assert.deepStrictEqual(all.body.people.map((x: any) => x.document_number), [null, null, null]);
    assert.ok(!JSON.stringify(all.body).includes('X-1234567'), 'no document anywhere in the answer');
    // The whole document finds the person (with or without its separators); a part of it finds nobody.
    const names = async (q: string) => (await people(COOK, q)).body.people.map((x: any) => x.name);
    assert.deepStrictEqual(await names('X-12345671'), ['Ana1 Pérez']);
    assert.deepStrictEqual(await names('x12345671'), ['Ana1 Pérez']);
    assert.deepStrictEqual(await names('X-1234567'), []);
    assert.deepStrictEqual(await names('1234'), []);
    assert.deepStrictEqual(await names('Ana1'), ['Ana1 Pérez'], 'control: the name search is unchanged');

    // Whoever may read the roster (inscriptions:view) — and the administrator — still get it, and part-match.
    for (const u of [DESK, undefined]) {
        const desk = await people(u);
        assert.deepStrictEqual(desk.body.people.map((x: any) => x.document_number).sort(), ['X-12345670', 'X-12345671', 'X-12345672']);
        assert.strictEqual((await people(u, '1234567')).body.people.length, 3);
    }
});
