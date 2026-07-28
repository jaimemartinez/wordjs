/**
 * FORM SUBMISSIONS (Webflow "Forms + submissions" parity) — route + storage suite.
 *
 * Drives the REAL router over supertest against a throwaway temp DB (same config-repoint-first
 * pattern as mailbox-grant.test.ts / api.test.ts). Pins the contract the editor's form block and the
 * admin viewer rely on:
 *
 *   1. a valid public POST /forms/submit stores the submission (fields tag-stripped, ip + UA recorded);
 *   2. the `_hp` honeypot answers with the EXACT success payload while storing NOTHING;
 *   3. the hard input bounds reject an oversized submission (>30 fields, >5000-char values);
 *   4. the admin surfaces (list / names / delete) demand auth AND `manage_options` — a plain
 *      authenticated subscriber is refused;
 *   5. DELETE actually removes the row.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-forms-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);

async function seedUser(login: string, role: string, email: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, email, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

const countRows = async () =>
    Number((await dbAsync.get('SELECT COUNT(*) AS c FROM form_submissions')).c);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    await roles.loadRoles();
    await seedUser('admin', 'administrator', 'admin@example.com');
    await seedUser('sub', 'subscriber', 'sub@example.com');
});

after(async () => {
    try { await database.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

// =================================================================================================
describe('POST /forms/submit (public)', () => {

    test('a valid submission is stored: fields tag-stripped, ip and user-agent recorded', async () => {
        const res = await anon('post', '/forms/submit')
            .set('User-Agent', 'forms-suite/1.0')
            .send({
                formName: 'contact',
                pageId: 42,
                fields: {
                    name: 'Ada Lovelace',
                    message: 'Hello <script>alert(1)</script>world',
                    _hp: '' // an honest browser submits the honeypot EMPTY — it must not block the save
                }
            });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { success: true });

        const row = await dbAsync.get('SELECT * FROM form_submissions WHERE form_name = ?', ['contact']);
        assert.ok(row, 'the submission must be stored');
        assert.equal(row.page_id, 42);
        const fields = JSON.parse(row.fields);
        assert.equal(fields.name, 'Ada Lovelace');
        assert.equal(fields.message, 'Hello world', 'markup must be stripped before storage');
        assert.equal(fields._hp, undefined, 'the empty honeypot field is plumbing, not an answer — never stored');
        assert.ok(row.ip !== undefined && row.ip !== null, 'the client ip column is populated');
        assert.equal(row.user_agent, 'forms-suite/1.0');
    });

    test('a filled honeypot answers with the EXACT success payload and stores nothing', async () => {
        const beforeCount = await countRows();
        const real = await anon('post', '/forms/submit')
            .send({ formName: 'hp-probe', fields: { name: 'human' } });
        assert.equal(real.status, 200, 'positive control: the same shape without _hp does save');
        assert.equal(await countRows(), beforeCount + 1);

        const trapped = await anon('post', '/forms/submit')
            .send({ formName: 'hp-probe', fields: { name: 'bot', _hp: 'gotcha' } });
        assert.equal(trapped.status, real.status, 'status must not reveal the trap');
        assert.deepEqual(trapped.body, real.body, 'body must be byte-identical to a real success');
        assert.equal(await countRows(), beforeCount + 1, 'the trapped submission must NOT be stored');
    });

    test('hard bounds: more than 30 fields is rejected', async () => {
        const fields: Record<string, string> = {};
        for (let i = 0; i < 31; i++) fields[`f${i}`] = 'v';
        const res = await anon('post', '/forms/submit').send({ formName: 'big', fields });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'rest_invalid_param');
        assert.equal(await dbAsync.get('SELECT id FROM form_submissions WHERE form_name = ?', ['big']), undefined,
            'nothing may be stored from a rejected submission');
    });

    test('hard bounds: an over-long value, a non-string value, and a missing formName are rejected', async () => {
        const long = await anon('post', '/forms/submit')
            .send({ formName: 'x', fields: { msg: 'a'.repeat(5001) } });
        assert.equal(long.status, 400, 'values are capped at 5000 chars');

        const nested = await anon('post', '/forms/submit')
            .send({ formName: 'x', fields: { msg: { deep: 'object' } } });
        assert.equal(nested.status, 400, 'fields must be flat string values');

        const unnamed = await anon('post', '/forms/submit').send({ fields: { a: 'b' } });
        assert.equal(unnamed.status, 400, 'formName is required');
    });
});

// =================================================================================================
describe('the admin viewer is gated on manage_options', () => {

    test('GET /forms/submissions without auth is 401; a subscriber is 403', async () => {
        const anonRes = await anon('get', '/forms/submissions');
        assert.equal(anonRes.status, 401);
        assert.equal(anonRes.body.code, 'rest_not_logged_in');

        const subRes = await as('sub', 'get', '/forms/submissions');
        assert.equal(subRes.status, 403, 'authentication alone is not enough — the capability decides');
        assert.equal(subRes.body.code, 'rest_forbidden');
    });

    test('an admin lists submissions (filtered + paginated, newest first)', async () => {
        const res = await as('admin', 'get', '/forms/submissions?formName=contact&per_page=10');
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-wp-total'], '1');
        assert.equal(res.headers['x-wp-totalpages'], '1');
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].formName, 'contact');
        assert.equal(res.body[0].pageId, 42);
        assert.equal(res.body[0].fields.name, 'Ada Lovelace', 'fields come back as a parsed object');

        const all = await as('admin', 'get', '/forms/submissions');
        assert.equal(all.status, 200);
        assert.ok(all.body.length >= 2, 'the unfiltered listing sees every form');
        assert.ok(all.body[0].id > all.body[all.body.length - 1].id, 'newest first');
    });

    test('GET /forms/names returns the DISTINCT names with counts (and is auth-gated too)', async () => {
        assert.equal((await anon('get', '/forms/names')).status, 401);

        const res = await as('admin', 'get', '/forms/names');
        assert.equal(res.status, 200);
        const byName = Object.fromEntries(res.body.names.map((n: any) => [n.formName, n.count]));
        assert.equal(byName['contact'], 1);
        assert.equal(byName['hp-probe'], 1, 'the honeypotted duplicate never made it into the count');
    });

    test('DELETE /forms/submissions/:id removes the row (and demands the capability)', async () => {
        const row = await dbAsync.get('SELECT id FROM form_submissions WHERE form_name = ?', ['hp-probe']);
        assert.ok(row, 'precondition: the hp-probe submission exists');

        assert.equal((await anon('delete', `/forms/submissions/${row.id}`)).status, 401);
        assert.equal((await as('sub', 'delete', `/forms/submissions/${row.id}`)).status, 403);

        const del = await as('admin', 'delete', `/forms/submissions/${row.id}`);
        assert.equal(del.status, 200);
        assert.equal(del.body.deleted, true);
        assert.equal(del.body.previous.formName, 'hp-probe');
        assert.equal(await dbAsync.get('SELECT id FROM form_submissions WHERE id = ?', [row.id]), undefined,
            'the row must actually be gone');

        const again = await as('admin', 'delete', `/forms/submissions/${row.id}`);
        assert.equal(again.status, 404, 'deleting a gone submission is a 404, not a silent success');
    });
});
