/**
 * CUSTOM TAXONOMY PERSISTENCE + CRUD SUITE
 *
 * The write half of the taxonomy registry: saveCustomTaxonomy()/deleteCustomTaxonomy() must
 * round-trip through the custom_taxonomies option (before this, a custom taxonomy lived in
 * memory only and vanished on restart), the /api/v1/taxonomies router must be admin-only with
 * strict shape validation, and one poisoned persisted entry must never brick initTaxonomies().
 * The registry (read) half is covered by taxonomies.test.ts.
 *
 * Same config-repoint-first pattern as webhooks.test.ts: point config.dbPath at a temp file
 * BEFORE requiring ../config/database so the sqlite driver binds the temp path.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
config.nodeEnv = 'test';
const TMP_DB = path.join(os.tmpdir(), `wjs-taxonomies-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');
const { getOption, updateOption } = require('../core/options');
const {
    initTaxonomies, registerTaxonomy, unregisterTaxonomy, getTaxonomy, taxonomyExists,
    saveCustomTaxonomy, deleteCustomTaxonomy
} = require('../core/post-types');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
const jwtFor = (p: string) => jwt.sign({ userId: U[p], username: p }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

let dbAsync: any;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await initTaxonomies();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('subscriber', 'subscriber');
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try {
        fs.rmSync(TMP_DB, { force: true });
        fs.rmSync(TMP_DB + '-wal', { force: true });
        fs.rmSync(TMP_DB + '-shm', { force: true });
    } catch { /* */ }
});

// ── core: the persistence round-trip that did not exist before ────────────────────────────────

test('saveCustomTaxonomy survives a registry wipe: initTaxonomies re-registers it from the option', async () => {
    await saveCustomTaxonomy('genre', { label: 'Genres', hierarchical: true, postTypes: 'book' });

    // Simulate the restart memory wipe: the in-memory registry forgets, the option remembers.
    unregisterTaxonomy('genre');
    assert.strictEqual(taxonomyExists('genre'), false, 'gone from the registry');

    await initTaxonomies(); // what boot runs
    const genre = getTaxonomy('genre');
    assert.ok(genre, 'genre re-registered from the persisted option');
    assert.strictEqual(genre.label, 'Genres');
    assert.strictEqual(genre.hierarchical, true);
    assert.deepStrictEqual(genre.postTypes, ['book'], 'the persisted entry is the NORMALIZED object');

    assert.strictEqual(await deleteCustomTaxonomy('genre'), true, 'cleanup');
    assert.strictEqual(taxonomyExists('genre'), false);
});

test('saveCustomTaxonomy rejects a malformed shape and persists nothing', async () => {
    await assert.rejects(() => saveCustomTaxonomy('', {}), /non-empty string/);
    await assert.rejects(() => saveCustomTaxonomy('bad', 'nope' as any), /plain object/);

    const stored = await getOption('custom_taxonomies', {});
    assert.ok(!stored[''] && !stored.bad, 'nothing was written for the rejected shapes');
});

test('deleteCustomTaxonomy refuses what is not persisted (unknown, runtime-only, built-ins)', async () => {
    assert.strictEqual(await deleteCustomTaxonomy('nope'), false, 'unknown name');

    // A plugin-registered taxonomy lives in memory only — deleting it via the persistence API
    // must refuse (it would come back on the next boot anyway) and must not touch the registry.
    registerTaxonomy('runtime_only', { postTypes: ['post'] });
    assert.strictEqual(await deleteCustomTaxonomy('runtime_only'), false);
    assert.ok(taxonomyExists('runtime_only'), 'registry untouched');
    unregisterTaxonomy('runtime_only');

    assert.strictEqual(await deleteCustomTaxonomy('category'), false, 'built-in');
    assert.ok(taxonomyExists('category'), 'built-in still registered');
});

// ── boot resilience: the per-entry guard plus the cleanup path ───────────────────────────────

test('a poisoned persisted entry does not brick initTaxonomies, and is deletable afterwards', async () => {
    await updateOption('custom_taxonomies', {
        good: { name: 'good', label: 'Good', hierarchical: true, postTypes: ['post'] },
        numeric: 42,                     // not even an object
        noname: { label: 'No name' },    // missing .name → registerTaxonomy throws
        nully: null
    });

    await initTaxonomies(); // must resolve, never reject

    assert.ok(taxonomyExists('good'), 'the valid entry registered');
    assert.strictEqual(getTaxonomy('good').hierarchical, true);
    assert.ok(taxonomyExists('category') && taxonomyExists('post_tag'), 'built-ins intact');
    assert.strictEqual(taxonomyExists('noname'), false, 'poisoned entries were skipped');

    // Cleanup path: a poisoned entry is persisted-but-never-registered; deleting it must
    // succeed (this is exactly why delete's success is "persisted entry gone", not
    // unregisterTaxonomy()'s return value).
    assert.strictEqual(await deleteCustomTaxonomy('numeric'), true, 'poisoned entry is deletable');
    assert.strictEqual(await deleteCustomTaxonomy('noname'), true);
    assert.strictEqual(await deleteCustomTaxonomy('nully'), true);
    assert.strictEqual(await deleteCustomTaxonomy('good'), true);

    const stored = await getOption('custom_taxonomies', {});
    assert.deepStrictEqual(Object.keys(stored), [], 'option left clean');
});

// ── router: happy path, validation, authz ────────────────────────────────────────────────────

test('POST /taxonomies as admin creates + normalizes + persists; GETs serve it; DELETE removes it', async () => {
    const res = await request(app).post('/api/v1/taxonomies')
        .set('Authorization', `Bearer ${jwtFor('admin')}`)
        .send({ name: 'genre', label: 'Genres', hierarchical: 'yes', postTypes: 'book', showInRest: true });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.name, 'genre');
    assert.strictEqual(res.body.hierarchical, false, 'non-boolean hierarchical cannot be smuggled through the API');
    assert.deepStrictEqual(res.body.postTypes, ['book'], 'postTypes string normalized to array');

    const one = await request(app).get('/api/v1/taxonomies/genre');
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.name, 'genre');

    const list = await request(app).get('/api/v1/taxonomies');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.some((t: any) => t.name === 'genre'), 'listed');

    const forBook = await request(app).get('/api/v1/taxonomies?postType=book');
    assert.ok(forBook.body.some((t: any) => t.name === 'genre'), 'postType filter includes genre');
    assert.ok(!forBook.body.some((t: any) => t.name === 'category'), 'postType filter excludes category');

    const stored = await getOption('custom_taxonomies', {});
    assert.ok(stored.genre, 'persisted in the custom_taxonomies option');
    assert.strictEqual(stored.genre.hierarchical, false, 'the stored entry is the normalized object');

    const dup = await request(app).post('/api/v1/taxonomies')
        .set('Authorization', `Bearer ${jwtFor('admin')}`).send({ name: 'genre' });
    assert.strictEqual(dup.status, 409, 'duplicate name');
    const builtin = await request(app).post('/api/v1/taxonomies')
        .set('Authorization', `Bearer ${jwtFor('admin')}`).send({ name: 'category' });
    assert.strictEqual(builtin.status, 409, 'built-in name');

    const del = await request(app).delete('/api/v1/taxonomies/genre')
        .set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(del.body, { success: true });
    assert.strictEqual(taxonomyExists('genre'), false, 'gone from the registry');
    const stored2 = await getOption('custom_taxonomies', {});
    assert.ok(!stored2.genre, 'gone from the option');

    const again = await request(app).delete('/api/v1/taxonomies/genre')
        .set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(again.status, 400, 'second delete refuses');
    const gone = await request(app).get('/api/v1/taxonomies/genre');
    assert.strictEqual(gone.status, 404);
});

test('POST /taxonomies validation: bad names and shapes are 400 and persist nothing', async () => {
    const cases: any[] = [
        {},                                  // no name
        { name: 42 },                        // non-string
        { name: 'UPPER' },                   // not a lowercase slug
        { name: 'has space' },
        { name: '__proto__' },               // object plumbing must not become a stored key
        { name: '-leading-dash' },           // must start alphanumeric
        { name: 'x'.repeat(33) },            // over the 32-char cap
        { name: 'okname', labels: 'nope' },  // labels must be an object
        { name: 'okname2', postTypes: [{}] } // postTypes entries must be strings
    ];
    for (const body of cases) {
        const r = await request(app).post('/api/v1/taxonomies')
            .set('Authorization', `Bearer ${jwtFor('admin')}`).send(body);
        assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    const stored = await getOption('custom_taxonomies', {});
    assert.ok(!stored.okname && !stored.okname2, 'rejected requests persisted nothing');
    assert.strictEqual(taxonomyExists('okname'), false);
    assert.strictEqual(taxonomyExists('__proto__'), false);
});

test('authz: writes are admin-only, and refused writes leave no trace', async () => {
    // Header-less anonymous write: blocked by the CSRF backstop before auth even runs.
    const anon = await request(app).post('/api/v1/taxonomies').send({ name: 'sneaky' });
    assert.strictEqual(anon.status, 403);
    assert.strictEqual(anon.body.code, 'rest_csrf_invalid');

    // A Bearer caller passes CSRF; an invalid token then fails authentication.
    const badTok = await request(app).post('/api/v1/taxonomies')
        .set('Authorization', 'Bearer not.a.jwt').send({ name: 'sneaky' });
    assert.strictEqual(badTok.status, 401);

    // A real non-admin passes authentication and is refused by isAdmin.
    const sub = await request(app).post('/api/v1/taxonomies')
        .set('Authorization', `Bearer ${jwtFor('subscriber')}`).send({ name: 'sneaky' });
    assert.strictEqual(sub.status, 403);
    assert.strictEqual(sub.body.code, 'rest_forbidden', 'refusal comes from isAdmin, not CSRF');

    const subDel = await request(app).delete('/api/v1/taxonomies/category')
        .set('Authorization', `Bearer ${jwtFor('subscriber')}`);
    assert.strictEqual(subDel.status, 403);
    assert.strictEqual(subDel.body.code, 'rest_forbidden');

    assert.strictEqual(taxonomyExists('sneaky'), false, 'nothing registered');
    const stored = await getOption('custom_taxonomies', {});
    assert.ok(!stored.sneaky, 'nothing persisted');
    assert.ok(taxonomyExists('category'), 'built-in untouched');

    // The read half stays public.
    const list = await request(app).get('/api/v1/taxonomies');
    assert.strictEqual(list.status, 200);
});
