/**
 * The site's map tile server (`map_tile_url` + `map_tile_attribution`, core/map-tiles), on the server side.
 *
 * What would fail silently without these checks:
 *  1. Both are PUBLIC: every MapView, including the ones on public pages, reads them from the anonymous
 *     GET /settings. If they stop being public, every map falls back to OpenStreetMap without an error.
 *  2. Only an https:// template with {z} {x} {y} (and optionally {s} {r}) and no user name or password can be
 *     stored. A 400 leaves the option as it was.
 *  3. The stored value is trimmed, and '' brings back the OpenStreetMap default.
 *
 * Same CWD sandbox order as the rest of this folder: chdir BEFORE requiring anything.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-map-tiles-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');
const { tileUrlProblem, tileAttributionProblem } = require('../core/map-tiles');

describe('map tile server (core/map-tiles)', () => {
    it('accepts the usual template shapes and the empty default', () => {
        for (const ok of [
            '',
            null,
            undefined,
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://{s}.tile.example.org/{z}/{x}/{y}{r}.png',
            'https://tiles.example.org/styles/basic/{z}/{x}/{y}.png?key=public-browser-key',
            'https://maps.example.org:8443/wmts/{z}/{y}/{x}',
        ]) assert.strictEqual(tileUrlProblem(ok), null, `${JSON.stringify(ok)} should be accepted`);
    });

    it('rejects anything that is not an https template without credentials', () => {
        for (const bad of [
            'http://tile.example.org/{z}/{x}/{y}.png',             // not https
            '//tile.example.org/{z}/{x}/{y}.png',                  // protocol-relative
            'javascript:alert(1)//{z}/{x}/{y}',
            'data:image/png;base64,{z}{x}{y}',
            'https://tile.example.org/static.png',                 // no placeholders
            'https://tile.example.org/{z}/{x}.png',                // {y} missing
            'https://tile.example.org/{z}/{x}/{y}/{apikey}.png',   // a placeholder Leaflet would fill from options
            'https://tile.example.org/{{z}/{x}/{y}.png',           // stray brace
            'https://user:secret@tile.example.org/{z}/{x}/{y}.png', // credentials
            'https://token@tile.example.org/{z}/{x}/{y}.png',
            'https://tile.example.org/{z}/{x}/{y}.png" onerror="x',
            'https://tile.example.org/{z}/{x}/{y}.png <b>',
            'https:///{z}/{x}/{y}.png',                            // no host
            'https://tile.example.org/' + 'a'.repeat(600) + '/{z}/{x}/{y}.png',
            42,
            ['https://tile.example.org/{z}/{x}/{y}.png'],
            { url: 'https://tile.example.org/{z}/{x}/{y}.png' },
        ]) assert.ok(tileUrlProblem(bad), `${JSON.stringify(bad)} must be rejected`);
    });

    it('takes one line of attribution text', () => {
        assert.strictEqual(tileAttributionProblem(''), null);
        assert.strictEqual(tileAttributionProblem('© OpenStreetMap contributors, © Example Maps'), null);
        assert.ok(tileAttributionProblem('line one\nline two'));
        assert.ok(tileAttributionProblem('x'.repeat(201)));
        assert.ok(tileAttributionProblem(7));
    });
});

describe('map tile server (settings contract)', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const optionValue = async (name: string) => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return row ? row.option_value : undefined;
    };

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('is saved trimmed and read back on the ANONYMOUS settings read (public maps use it)', async () => {
        const res = await asAdmin(request(app).put('/api/v1/settings')).send({
            map_tile_url: '  https://{s}.tiles.example.org/{z}/{x}/{y}.png ',
            map_tile_attribution: ' © Example Maps ',
        });
        assert.strictEqual(res.status, 200);
        const pub = await request(app).get('/api/v1/settings');
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.map_tile_url, 'https://{s}.tiles.example.org/{z}/{x}/{y}.png');
        assert.strictEqual(pub.body.map_tile_attribution, '© Example Maps');
        const one = await request(app).get('/api/v1/settings/map_tile_url');
        assert.strictEqual(one.status, 200);
    });

    it('refuses a bad template with 400 and keeps the stored one', async () => {
        for (const value of ['http://tiles.example.org/{z}/{x}/{y}.png', 'https://a:b@tiles.example.org/{z}/{x}/{y}.png', 'https://tiles.example.org/x.png']) {
            const res = await asAdmin(request(app).put('/api/v1/settings/map_tile_url')).send({ value });
            assert.strictEqual(res.status, 400, `${value} must be rejected`);
            assert.strictEqual(await optionValue('map_tile_url'), 'https://{s}.tiles.example.org/{z}/{x}/{y}.png');
        }
        const bulk = await asAdmin(request(app).put('/api/v1/settings')).send({ map_tile_url: 'http://x.example.org/{z}/{x}/{y}.png' });
        assert.strictEqual(bulk.status, 400);
        assert.strictEqual(await optionValue('map_tile_url'), 'https://{s}.tiles.example.org/{z}/{x}/{y}.png');
    });

    it('goes back to the default when cleared, and only an administrator may change it', async () => {
        const anon = await request(app).put('/api/v1/settings/map_tile_url').send({ value: '' });
        assert.ok(anon.status === 401 || anon.status === 403, `anonymous write got ${anon.status}`);
        const res = await asAdmin(request(app).put('/api/v1/settings/map_tile_url')).send({ value: '' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await optionValue('map_tile_url'), '');
    });
});
