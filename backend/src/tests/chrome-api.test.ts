/**
 * Composable chrome write API (PUT/DELETE /api/v1/chrome/:part) + public settings exposure.
 *
 * Drives the REAL routers via supertest against a throwaway temp DB. Adversarial focus: every
 * rejected PUT asserts the NEGATIVE SPACE too — the site_chrome_* option must NOT exist after
 * a 400/401/403, and the generic settings writers must refuse to become a validation bypass
 * for site_chrome_* (chrome-validate is the only write authority).
 *
 * Same CWD-sandbox ordering as theme-write-api.test.ts: chdir into a temp root BEFORE
 * requiring anything that resolves paths from the CWD at module load. node --test runs each
 * file in its own process, so the chdir leaks nowhere.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-chrome-api-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

// A composition that satisfies the contract v1 (row nesting depth 2, safe hrefs).
const validComposition = () => ({
    root: { props: {} },
    content: [
        {
            type: 'ChromeRow',
            props: {
                id: 'ChromeRow-1', align: 'between', gap: 'md', wrap: false,
                items: [
                    { type: 'ChromeLogo', props: { size: 'md' } },
                    { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } },
                    { type: 'ChromeButton', props: { label: 'Sign up', href: '/register', variant: 'primary' } }
                ]
            }
        },
        { type: 'ChromeText', props: { text: 'Plain tagline' } },
        { type: 'ChromeSpacer', props: { size: 'sm' } }
    ]
});

// One isolated fault per vector, so a 400 can never pass for the wrong reason.
const invalidVectors: Array<[string, any, string]> = [
    ['unknown block type', { root: { props: {} }, content: [{ type: 'ChromeIframe', props: {} }] }, 'CHROME_UNKNOWN_TYPE'],
    // `in`-style lookups would find these on Object.prototype — the allowlist must be hasOwnProperty.
    ['prototype-chain block type', { root: { props: {} }, content: [{ type: 'constructor', props: {} }] }, 'CHROME_UNKNOWN_TYPE'],
    ['prototype-chain prop name', { root: { props: {} }, content: [{ type: 'ChromeLogo', props: { toString: 'x' } }] }, 'CHROME_UNKNOWN_PROP'],
    ['javascript: href', { root: { props: {} }, content: [{ type: 'ChromeButton', props: { label: 'x', href: 'javascript:alert(1)', variant: 'primary' } }] }, 'CHROME_UNSAFE_HREF'],
    ['protocol-relative href', { root: { props: {} }, content: [{ type: 'ChromeButton', props: { label: 'x', href: '//evil.example/x', variant: 'ghost' } }] }, 'CHROME_UNSAFE_HREF'],
    ['data: href', { root: { props: {} }, content: [{ type: 'ChromeButton', props: { label: 'x', href: 'data:text/html,x', variant: 'primary' } }] }, 'CHROME_UNSAFE_HREF'],
    ['missing required prop', { root: { props: {} }, content: [{ type: 'ChromeButton', props: { label: 'x', href: '/ok' } }] }, 'CHROME_MISSING_PROP'],
    ['wrong prop type', { root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 42 } }] }, 'CHROME_INVALID_PROP'],
    ['enum out of range', { root: { props: {} }, content: [{ type: 'ChromeSpacer', props: { size: 'xl' } }] }, 'CHROME_INVALID_PROP'],
    ['unknown prop', { root: { props: {} }, content: [{ type: 'ChromeLogo', props: { size: 'md', onClick: 'x' } }] }, 'CHROME_UNKNOWN_PROP'],
    ['content not an array', { root: { props: {} }, content: {} }, 'CHROME_INVALID_SHAPE'],
    // root is part of the format — a root-less composition would fail at render time (frontend parity).
    ['missing root', { content: [{ type: 'ChromeText', props: { text: 'hola' } }] }, 'CHROME_INVALID_SHAPE'],
    ['depth 4 via nested rows', {
        root: { props: {} },
        content: [{ type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [
            { type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [
                { type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [
                    { type: 'ChromeSpacer', props: { size: 'sm' } }
                ] } }
            ] } }
        ] } }]
    }, 'CHROME_TOO_DEEP'],
    ['101 blocks', {
        root: { props: {} },
        content: Array.from({ length: 101 }, () => ({ type: 'ChromeSpacer', props: { size: 'sm' } }))
    }, 'CHROME_TOO_MANY_BLOCKS'],
];

describe('chrome API (PUT/DELETE /api/v1/chrome/:part)', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;
    let subscriberToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const optionRow = (part: string) =>
        dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [`site_chrome_${part}`]);

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['subscriber', 'x', 'sub@example.com', 'Subscriber']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );

        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        // 2mb: big enough that the 64KB contract budget answers (400), not the body parser (413).
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/chrome', require('../routes/chrome'));
        app.use('/api/v1/settings', require('../routes/settings')); // exposure + bypass guard
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ authn/authz

    it('PUT rejects anonymous requests (401) and writes nothing', async () => {
        const res = await request(app).put('/api/v1/chrome/header').send({ data: validComposition() });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(await optionRow('header'), undefined);
    });

    it('DELETE rejects anonymous requests (401)', async () => {
        const res = await request(app).delete('/api/v1/chrome/header');
        assert.strictEqual(res.status, 401);
    });

    it('PUT rejects a non-admin user (403) and writes nothing', async () => {
        const res = await request(app)
            .put('/api/v1/chrome/header')
            .set('Authorization', `Bearer ${subscriberToken}`)
            .send({ data: validComposition() });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(await optionRow('header'), undefined);
    });

    it('DELETE rejects a non-admin user (403)', async () => {
        const res = await request(app)
            .delete('/api/v1/chrome/header')
            .set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual(res.status, 403);
    });

    // ------------------------------------------------------------------ part gate

    it('rejects a part outside header|footer with 400 on both verbs', async () => {
        for (const part of ['sidebar', 'HEADER', 'header%20', 'x']) {
            const put = await asAdmin(request(app).put(`/api/v1/chrome/${part}`)).send({ data: validComposition() });
            assert.strictEqual(put.status, 400, `PUT ${part} must 400, got ${put.status}`);
            const del = await asAdmin(request(app).delete(`/api/v1/chrome/${part}`));
            assert.strictEqual(del.status, 400, `DELETE ${part} must 400, got ${del.status}`);
        }
    });

    // ------------------------------------------------------------------ contract rejections

    it('rejects every contract-violating composition with 400 + the exact code, storing nothing', async () => {
        for (const [name, data, code] of invalidVectors) {
            const res = await asAdmin(request(app).put('/api/v1/chrome/header')).send({ data });
            assert.strictEqual(res.status, 400, `${name}: expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
            assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0, `${name}: errors[] expected`);
            assert.ok(res.body.errors.some((e: any) => e.code === code),
                `${name}: expected ${code} in ${JSON.stringify(res.body.errors)}`);
            assert.ok(res.body.errors.every((e: any) => typeof e.path === 'string' && typeof e.message === 'string'),
                `${name}: every error carries path+message`);
            assert.strictEqual(await optionRow('header'), undefined, `${name}: a rejected PUT must store nothing`);
        }
    });

    it('rejects a >64KB composition with 400 CHROME_TOO_LARGE (not the body-parser 413)', async () => {
        const res = await asAdmin(request(app).put('/api/v1/chrome/header'))
            .send({ data: { content: [{ type: 'ChromeText', props: { text: 'x'.repeat(66 * 1024) } }] } });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body).slice(0, 200));
        assert.ok(res.body.errors.some((e: any) => e.code === 'CHROME_TOO_LARGE'), JSON.stringify(res.body.errors));
        assert.strictEqual(await optionRow('header'), undefined);
    });

    it('rejects a body without data (400) — an absent composition is not an empty one', async () => {
        const res = await asAdmin(request(app).put('/api/v1/chrome/header')).send({});
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.errors.some((e: any) => e.code === 'CHROME_INVALID_SHAPE'), JSON.stringify(res.body.errors));
    });

    // ------------------------------------------------------------------ happy path + exposure

    it('PUT stores a valid composition as a JSON string in site_chrome_<part> (200)', async () => {
        const data = validComposition();
        const res = await asAdmin(request(app).put('/api/v1/chrome/header')).send({ data });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body, { part: 'header', saved: true });

        const row = await optionRow('header');
        assert.ok(row, 'option row must exist');
        assert.strictEqual(typeof row.option_value, 'string');
        assert.deepStrictEqual(JSON.parse(row.option_value), data, 'stored JSON string must round-trip');
    });

    it('the public /api/v1/settings payload carries site_chrome_header (and a null footer)', async () => {
        const res = await request(app).get('/api/v1/settings'); // anonymous — it IS public content
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.site_chrome_header, validComposition(),
            'the renderer needs the composition in the public settings payload');
        assert.strictEqual(res.body.site_chrome_footer, null);
    });

    it('a second PUT replaces the stored composition', async () => {
        const data = { root: { props: {} }, content: [{ type: 'ChromeSiteTitle', props: { showTagline: true } }] };
        const res = await asAdmin(request(app).put('/api/v1/chrome/header')).send({ data });
        assert.strictEqual(res.status, 200);
        const row = await optionRow('header');
        assert.deepStrictEqual(JSON.parse(row.option_value), data);
    });

    // ------------------------------------------------------------------ no bypass via generic settings writers

    it('PUT /api/v1/settings/:key refuses site_chrome_* (400) — chrome-validate cannot be bypassed', async () => {
        const before = (await optionRow('header')).option_value;
        const res = await asAdmin(request(app).put('/api/v1/settings/site_chrome_header'))
            .send({ value: '{"content":[{"type":"ChromeIframe","props":{}}]}' });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.message, /dedicated API/);
        assert.strictEqual((await optionRow('header')).option_value, before, 'the option must be untouched');
    });

    it('bulk PUT /api/v1/settings skips site_chrome_* keys', async () => {
        const before = (await optionRow('header')).option_value;
        const res = await asAdmin(request(app).put('/api/v1/settings'))
            .send({ blogname: 'Chrome Suite', site_chrome_header: '{"content":[]}' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.blogname, 'Chrome Suite');
        assert.ok(!('site_chrome_header' in res.body), JSON.stringify(res.body));
        assert.strictEqual((await optionRow('header')).option_value, before, 'the option must be untouched');
    });

    // ------------------------------------------------------------------ DELETE

    it('DELETE removes the option (deleted:true) so the theme/variant chrome takes over', async () => {
        const res = await asAdmin(request(app).delete('/api/v1/chrome/header'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { part: 'header', deleted: true });
        assert.strictEqual(await optionRow('header'), undefined);

        const settings = await request(app).get('/api/v1/settings');
        assert.strictEqual(settings.body.site_chrome_header, null);
    });

    it('DELETE is idempotent: a second call answers 200 with deleted:false', async () => {
        const res = await asAdmin(request(app).delete('/api/v1/chrome/header'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { part: 'header', deleted: false });
    });
});
