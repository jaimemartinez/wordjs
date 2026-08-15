/**
 * OLA 5 site-owner features, driven through the REAL themes router with supertest:
 *
 *   1. GET  /api/v1/themes/:slug/templates  — the per-page template picker's enumeration endpoint.
 *   2. GET  /api/v1/themes/mods/export       — download the active theme's customizer mods as JSON.
 *   3. POST /api/v1/themes/mods/import        — validate an uploaded mods file, then apply it.
 *
 * Plus the backend contract module core/theme-mods directly. Adversarial focus mirrors chrome-api.test:
 * every rejected import asserts the NEGATIVE SPACE — active_theme_mods must be UNCHANGED after a
 * 400/401/403 — and the template listing must never offer a name the hierarchy could not request.
 *
 * Same CWD-sandbox ordering as chrome-api.test.ts: chdir into a temp root BEFORE requiring anything that
 * resolves paths from the CWD at module load (THEMES_DIR = path.resolve('./themes')).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-mods-api-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────────────────────── unit: contract module
describe('core/theme-mods contract', () => {
    const { validateThemeMods, sanitizeThemeMods, parseStoredMods, extractImportMods } = require('../core/theme-mods');

    it('validateThemeMods accepts a clean --wjs-* map', () => {
        const r = validateThemeMods({ '--wjs-color-primary': '#ff0000', '--wjs-radius': '8px' });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.mods, { '--wjs-color-primary': '#ff0000', '--wjs-radius': '8px' });
        assert.strictEqual(r.errors.length, 0);
    });

    // One isolated fault per vector so a 400 can never pass for the wrong reason.
    const badVectors: Array<[string, any, string]> = [
        ['unknown key (not --wjs-*)', { 'color': '#fff' }, 'MODS_UNKNOWN_KEY'],
        ['prototype-chain key as data', { '__proto__x': 'red' }, 'MODS_UNKNOWN_KEY'],
        ['uppercase in key', { '--wjs-Color': 'red' }, 'MODS_UNKNOWN_KEY'],
        ['protocol-relative url value', { '--wjs-bg-canvas': 'url(//evil.example/x)' }, 'MODS_INVALID_VALUE'],
        ['bare // in value', { '--wjs-color-link': 'a//b' }, 'MODS_INVALID_VALUE'],
        ['backslash escape in value', { '--wjs-color-link': 'a\\3c b' }, 'MODS_INVALID_VALUE'],
        ['declaration break-out ; in value', { '--wjs-color-link': 'red;}body{x' }, 'MODS_INVALID_VALUE'],
        ['non-string value', { '--wjs-radius': 8 }, 'MODS_INVALID_VALUE'],
        ['empty value', { '--wjs-radius': '' }, 'MODS_INVALID_VALUE'],
        ['over-long value', { '--wjs-radius': 'a'.repeat(121) }, 'MODS_INVALID_VALUE'],
    ];
    it('validateThemeMods rejects the WHOLE import on any bad entry, with the exact code', () => {
        for (const [name, input, code] of badVectors) {
            const r = validateThemeMods(input);
            assert.strictEqual(r.ok, false, `${name}: expected reject`);
            assert.deepStrictEqual(r.mods, {}, `${name}: rejected import yields no mods`);
            assert.ok(r.errors.some((e: any) => e.code === code), `${name}: expected ${code}, got ${JSON.stringify(r.errors)}`);
        }
    });

    it('validateThemeMods rejects a non-object', () => {
        for (const bad of [null, 'x', 42, [1, 2]]) {
            assert.strictEqual(validateThemeMods(bad).ok, false, `${JSON.stringify(bad)} must reject`);
        }
    });

    it('sanitizeThemeMods DROPS invalid entries (lenient read path), keeping valid ones', () => {
        const out = sanitizeThemeMods({ '--wjs-color-primary': '#fff', 'bad': 'x', '--wjs-x': 'url(//e/y)' });
        assert.deepStrictEqual(out, { '--wjs-color-primary': '#fff' });
    });

    it('parseStoredMods tolerates a JSON string, an object, and junk', () => {
        assert.deepStrictEqual(parseStoredMods('{"--wjs-radius":"4px"}'), { '--wjs-radius': '4px' });
        assert.deepStrictEqual(parseStoredMods({ '--wjs-radius': '4px' }), { '--wjs-radius': '4px' });
        assert.deepStrictEqual(parseStoredMods('not json'), {});
        assert.deepStrictEqual(parseStoredMods(''), {});
        assert.deepStrictEqual(parseStoredMods(null), {});
    });

    it('extractImportMods accepts a bare map, the export wrapper, and rejects neither-shape', () => {
        assert.deepStrictEqual(extractImportMods({ '--wjs-radius': '4px' }), { '--wjs-radius': '4px' });
        assert.deepStrictEqual(extractImportMods({ theme: 'x', mods: { '--wjs-radius': '4px' } }), { '--wjs-radius': '4px' });
        assert.deepStrictEqual(extractImportMods({}), {}); // "clear all" import
        assert.strictEqual(extractImportMods({ mods: 'not-an-object' }), null);
        assert.strictEqual(extractImportMods(null), null);
    });
});

// ───────────────────────────────────────────────────────────────────────────────────── HTTP: the routes
describe('themes OLA5 routes (templates listing + mods export/import)', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;
    let subscriberToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const modsOption = () =>
        dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', ['active_theme_mods']);

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['subscriber', 'x', 'sub@example.com', 'Subscriber']);
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // A theme on disk with a templates/ directory holding both legal and illegal file names.
        const tdir = path.join(TMP_ROOT, 'themes', 'demo', 'templates');
        fs.mkdirSync(tdir, { recursive: true });
        fs.writeFileSync(path.join(tdir, 'page.json'), '{"content":[]}');
        fs.writeFileSync(path.join(tdir, 'single-post.json'), '{"content":[]}');
        fs.writeFileSync(path.join(tdir, 'home.json'), '{"content":[]}');
        fs.writeFileSync(path.join(tdir, 'README.md'), 'not a template');       // not .json → excluded
        fs.writeFileSync(path.join(tdir, 'Bad_Name.json'), '{}');               // fails TEMPLATE shape → excluded
        // A theme with NO templates/ directory at all.
        fs.mkdirSync(path.join(TMP_ROOT, 'themes', 'bare'), { recursive: true });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ─────────────────────────────────────────────────── template listing (Feature 1)

    it('GET /:slug/templates rejects anonymous (401) and non-admin (403)', async () => {
        assert.strictEqual((await request(app).get('/api/v1/themes/demo/templates')).status, 401);
        assert.strictEqual(
            (await request(app).get('/api/v1/themes/demo/templates').set('Authorization', `Bearer ${subscriberToken}`)).status,
            403,
        );
    });

    it('GET /:slug/templates lists ONLY legal *.json template names, sorted', async () => {
        const res = await asAdmin(request(app).get('/api/v1/themes/demo/templates'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.templates, ['home', 'page', 'single-post']);
        // Negative space: no README, no uppercase/underscore file.
        assert.ok(!res.body.templates.includes('README'));
        assert.ok(!res.body.templates.includes('Bad_Name'));
    });

    it('GET /:slug/templates returns an empty list (not an error) for a theme with no templates/', async () => {
        const res = await asAdmin(request(app).get('/api/v1/themes/bare/templates'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.templates, []);
    });

    it('GET /:slug/templates rejects a traversal slug (400)', async () => {
        const res = await asAdmin(request(app).get('/api/v1/themes/..%2f..%2fetc/templates'));
        assert.strictEqual(res.status, 400);
    });

    // ─────────────────────────────────────────────────── mods export/import (Feature 3)

    it('GET /mods/export and POST /mods/import reject anonymous (401) and non-admin (403)', async () => {
        assert.strictEqual((await request(app).get('/api/v1/themes/mods/export')).status, 401);
        assert.strictEqual((await request(app).post('/api/v1/themes/mods/import').send({})).status, 401);
        assert.strictEqual(
            (await request(app).get('/api/v1/themes/mods/export').set('Authorization', `Bearer ${subscriberToken}`)).status, 403);
        assert.strictEqual(
            (await request(app).post('/api/v1/themes/mods/import').set('Authorization', `Bearer ${subscriberToken}`).send({})).status, 403);
    });

    it('POST /mods/import rejects a bad file with 400 + errors[], writing NOTHING', async () => {
        const before = await modsOption();
        const res = await asAdmin(request(app).post('/api/v1/themes/mods/import'))
            .send({ '--wjs-color-primary': '#fff', 'evil': 'url(//x/y)' });
        assert.strictEqual(res.status, 400);
        assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0, JSON.stringify(res.body));
        assert.deepStrictEqual(await modsOption(), before, 'a rejected import must not write the option');
    });

    it('POST /mods/import applies a valid file, then GET /mods/export round-trips it', async () => {
        const mods = { '--wjs-color-primary': '#123456', '--wjs-radius': '10px' };
        const imp = await asAdmin(request(app).post('/api/v1/themes/mods/import')).send({ theme: 'demo', mods });
        assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
        assert.strictEqual(imp.body.applied, true);
        assert.strictEqual(imp.body.count, 2);

        const row = await modsOption();
        assert.deepStrictEqual(JSON.parse(row.option_value), mods);

        const exp = await asAdmin(request(app).get('/api/v1/themes/mods/export'));
        assert.strictEqual(exp.status, 200);
        assert.match(exp.headers['content-disposition'], /attachment; filename=".*customizer-mods\.json"/);
        // Round-trip: exporting then re-importing the exported wrapper reproduces the same mods.
        assert.deepStrictEqual(exp.body.mods, mods);
        const reimp = await asAdmin(request(app).post('/api/v1/themes/mods/import')).send(exp.body);
        assert.strictEqual(reimp.status, 200);
        assert.deepStrictEqual(JSON.parse((await modsOption()).option_value), mods);
    });

    it('POST /mods/import with an empty map clears the mods (a legitimate "reset" import)', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes/mods/import')).send({ mods: {} });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.count, 0);
        assert.deepStrictEqual(JSON.parse((await modsOption()).option_value), {});
    });
});
