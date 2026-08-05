/**
 * Declarative theme write API (POST /api/v1/themes, PUT /api/v1/themes/:slug).
 *
 * Drives the REAL router via supertest against a throwaway temp DB and a sandboxed
 * THEMES_DIR, with the REAL token manifest (copied read-only into the sandbox) so
 * token/element resolution is exercised against production data. Adversarial focus:
 * every rejection asserts the NEGATIVE SPACE too — a failed POST must leave no theme
 * dir behind, a failed PUT must leave the installed theme byte-identical, and the
 * API must never touch functions.js after creation.
 *
 * IMPORTANT ordering (same as plugin-theme-install.test.ts): THEMES_DIR ('./themes')
 * and the compiler's manifest path ('./public/theme-tokens.json') resolve from the
 * CWD at module load, so we chdir into a temp root BEFORE requiring anything that
 * transitively loads core/themes or core/theme-compile. node --test runs each file
 * in its own process, so the chdir leaks nowhere.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (themes/ + public/theme-tokens.json resolve from it
//    at module load). __dirname is absolute, so the real manifest stays reachable.
const REAL_MANIFEST = path.join(__dirname, '..', '..', 'public', 'theme-tokens.json');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-write-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'public'), { recursive: true });
fs.copyFileSync(REAL_MANIFEST, path.join(TMP_ROOT, 'public', 'theme-tokens.json'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const { THEMES_DIR } = require('../core/themes');

const MARKER_START_PREFIX = '/* @wjs-generated:start';
const MARKER_END = '/* @wjs-generated:end */';

// A structurally valid creation payload — per-test overrides isolate ONE fault at a
// time, so a 400 can never pass for the wrong reason.
const validPayload = (slug: string, extra: any = {}) => ({
    slug,
    metadata: { name: `Theme ${slug}`, description: 'generated in tests', author: 'suite', version: '1.0.0' },
    tokens: { '--wjs-color-primary': '#123456' },
    ...extra
});

describe('theme write API (POST /api/v1/themes, PUT /api/v1/themes/:slug)', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const themePath = (slug: string, ...rest: string[]) => path.join(THEMES_DIR, slug, ...rest);

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
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
        // 2mb (vs index.ts's 10mb): big enough that the >256KB theme.json cap test reaches
        // the ROUTE's own cap instead of dying in the body parser.
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ authn/authz

    it('POST rejects anonymous requests (401)', async () => {
        const res = await request(app).post('/api/v1/themes').send(validPayload('anon-theme'));
        assert.strictEqual(res.status, 401);
        assert.ok(!fs.existsSync(themePath('anon-theme')));
    });

    it('PUT rejects anonymous requests (401)', async () => {
        const res = await request(app).put('/api/v1/themes/whatever').send({ tokens: {} });
        assert.strictEqual(res.status, 401);
    });

    it('POST rejects a non-admin user (403)', async () => {
        const res = await request(app)
            .post('/api/v1/themes')
            .set('Authorization', `Bearer ${subscriberToken}`)
            .send(validPayload('sub-theme'));
        assert.strictEqual(res.status, 403);
        assert.ok(!fs.existsSync(themePath('sub-theme')));
    });

    it('PUT rejects a non-admin user (403)', async () => {
        const res = await request(app)
            .put('/api/v1/themes/whatever')
            .set('Authorization', `Bearer ${subscriberToken}`)
            .send({ tokens: {} });
        assert.strictEqual(res.status, 403);
    });

    // ------------------------------------------------------------------ slug gate

    it('POST refuses traversal-shaped / malformed slugs with 400, before any fs effect', async () => {
        const snapshot = fs.readdirSync(THEMES_DIR);
        const bad: any[] = ['../evil', '..', 'a/b', 'a\\b', '/etc/passwd', 'C:\\evil', '%2e%2e', '.hidden', '', undefined, 42];
        for (const slug of bad) {
            const payload: any = validPayload('placeholder');
            if (slug === undefined) delete payload.slug; else payload.slug = slug;
            const res = await asAdmin(request(app).post('/api/v1/themes')).send(payload);
            assert.strictEqual(res.status, 400, `slug ${JSON.stringify(slug)} must 400, got ${res.status}`);
        }
        assert.deepStrictEqual(fs.readdirSync(THEMES_DIR), snapshot, 'no theme dir may appear');
    });

    it('PUT refuses traversal-shaped slugs in the URL with 400', async () => {
        // NOTE: a literal '%2e%2e' can't be exercised — the HTTP client normalizes the
        // dot-dot segment out of the path before Express sees it (also safe: it 404s).
        for (const bad of ['..%2f..%2fetc', '..%5c..%5cwindows', '.hidden']) {
            const res = await asAdmin(request(app).put(`/api/v1/themes/${bad}`)).send({ tokens: {} });
            assert.strictEqual(res.status, 400, `slug ${bad} must 400, got ${res.status}`);
        }
    });

    // ------------------------------------------------------------------ payload shape

    it('POST without any of seeds/tokens/styles is a 400', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes'))
            .send({ slug: 'empty-theme', metadata: { name: 'Empty' }, archetype: 'cyber' });
        assert.strictEqual(res.status, 400);
        assert.ok(!fs.existsSync(themePath('empty-theme')));
    });

    it('POST without metadata.name is a 400', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes'))
            .send({ slug: 'noname-theme', metadata: {}, tokens: { '--wjs-color-primary': '#123456' } });
        assert.strictEqual(res.status, 400);
        assert.ok(!fs.existsSync(themePath('noname-theme')));
    });

    it('POST with a >256KB theme.json is rejected (400 route cap / 413 body cap) and writes nothing', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes'))
            .send(validPayload('giant-theme', { tokens: { '--wjs-color-primary': 'x'.repeat(300 * 1024) } }));
        assert.ok([400, 413].includes(res.status), `expected 400/413, got ${res.status}`);
        assert.ok(!fs.existsSync(themePath('giant-theme')));
    });

    // ------------------------------------------------------------------ happy path

    it('POST creates the theme (201): compiled style.css, generator mark, functions.js stub', async () => {
        const res = await asAdmin(request(app).post('/api/v1/themes')).send(validPayload('green-theme', {
            styles: { body: { 'background-color': '#fafafa' } }
        }));
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'green-theme');
        assert.ok(Array.isArray(res.body.diagnostics));
        assert.strictEqual(res.body.diagnostics.filter((d: any) => d.level === 'error').length, 0, JSON.stringify(res.body.diagnostics));

        const themeJson = JSON.parse(fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8'));
        assert.strictEqual(themeJson.generator, 'wordjs');
        assert.strictEqual(themeJson.name, 'Theme green-theme');
        assert.strictEqual(themeJson.version, '1.0.0');

        const css = fs.readFileSync(themePath('green-theme', 'style.css'), 'utf8');
        assert.ok(css.includes(MARKER_START_PREFIX), css.slice(0, 200));
        assert.ok(css.includes('build theme green-theme'), 'marker must carry the slug');
        assert.ok(css.includes('--wjs-color-primary: #123456;'), css);
        assert.ok(css.includes('body { background-color: #fafafa }'), css);
        assert.ok(css.includes(MARKER_END));

        // The stub exists and is inert (the API writes it once and never again).
        const fn = fs.readFileSync(themePath('green-theme', 'functions.js'), 'utf8');
        assert.ok(fn.includes('module.exports'), fn);
    });

    it('GET /api/v1/themes lists the created theme', async () => {
        const res = await request(app).get('/api/v1/themes');
        assert.strictEqual(res.status, 200);
        const mine = res.body.find((t: any) => t.slug === 'green-theme');
        assert.ok(mine, JSON.stringify(res.body));
        assert.strictEqual(mine.name, 'Theme green-theme');
        assert.strictEqual(mine.version, '1.0.0');
    });

    it('POST on an existing slug is a 409 (THEME_EXISTS) and leaves the theme intact', async () => {
        const beforeJson = fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8');
        const res = await asAdmin(request(app).post('/api/v1/themes'))
            .send(validPayload('green-theme', { tokens: { '--wjs-color-primary': '#000000' } }));
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8'), beforeJson);
    });

    // ------------------------------------------------------------------ injection (compiler vectors through HTTP)

    it('POST with injection/abuse payloads is a 400 with diagnostics and writes NO files', async () => {
        // The same vectors the compiler suite proves are rejected — here the assertion is
        // that a rejected POST also has zero fs footprint.
        const vectors: Array<[string, any]> = [
            ['inj-breakout', { styles: { card: { background: 'red;} body{background:url(//evil)}' } } }],
            ['inj-url-proto', { styles: { card: { 'background-image': 'url(//x)' } } }],
            ['inj-url-other', { styles: { card: { 'background-image': 'url(/themes/OTRO/x.png)' } } }],
            ['inj-behavior', { styles: { card: { behavior: 'url(x.htc)' } } }],
            ['inj-custom-prop', { styles: { card: { '--wjs-color-primary': '#fff' } } }],
            ['inj-unknown-token', { tokens: { '--wjs-definitely-not-a-token-xyz': '#fff' } }],
            ['inj-token-breakout', { tokens: { '--wjs-color-primary': 'red;}body{background:#000}' } }]
        ];
        for (const [slug, extra] of vectors) {
            // validPayload spreads `extra` last, so a vector's tokens map REPLACES the valid
            // one — the injected fault is always the only fault in the payload.
            const res = await asAdmin(request(app).post('/api/v1/themes')).send(validPayload(slug, extra));
            assert.strictEqual(res.status, 400, `${slug}: expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
            assert.ok(Array.isArray(res.body.diagnostics) && res.body.diagnostics.length > 0, `${slug}: diagnostics expected`);
            assert.ok(!fs.existsSync(themePath(slug)), `${slug}: a rejected POST must not create the theme dir`);
        }
    });

    // ------------------------------------------------------------------ PUT

    it('PUT on a nonexistent theme is a 404', async () => {
        const res = await asAdmin(request(app).put('/api/v1/themes/ghost-theme'))
            .send({ tokens: { '--wjs-color-primary': '#ffffff' } });
        assert.strictEqual(res.status, 404);
    });

    it('PUT on a theme without generator "wordjs" is a 409 and touches nothing', async () => {
        // A hand-made theme (e.g. uploaded): the writer must refuse to rebuild it.
        fs.mkdirSync(themePath('manual-theme'), { recursive: true });
        fs.writeFileSync(themePath('manual-theme', 'theme.json'), JSON.stringify({ name: 'Manual', version: '2.0.0' }));
        fs.writeFileSync(themePath('manual-theme', 'style.css'), 'body { color: teal }\n');

        const res = await asAdmin(request(app).put('/api/v1/themes/manual-theme'))
            .send({ tokens: { '--wjs-color-primary': '#ffffff' } });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.match(res.body.error, /generator/);
        assert.strictEqual(fs.readFileSync(themePath('manual-theme', 'style.css'), 'utf8'), 'body { color: teal }\n');
        assert.strictEqual(JSON.parse(fs.readFileSync(themePath('manual-theme', 'theme.json'), 'utf8')).version, '2.0.0');
    });

    it('PUT swaps the marked block, bumps the patch version, preserves manual CSS and functions.js', async () => {
        // Manual CSS OUTSIDE the markers must survive a rebuild byte for byte.
        const manualTail = '\n/* hand-written */ .keep-me { color: pink }\n';
        fs.appendFileSync(themePath('green-theme', 'style.css'), manualTail);
        const fnBefore = fs.readFileSync(themePath('green-theme', 'functions.js'), 'utf8');

        const res = await asAdmin(request(app).put('/api/v1/themes/green-theme'))
            .send({ tokens: { '--wjs-color-primary': '#654321' } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'green-theme');
        assert.strictEqual(res.body.version, '1.0.1');

        const themeJson = JSON.parse(fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8'));
        assert.strictEqual(themeJson.version, '1.0.1');
        assert.strictEqual(themeJson.generator, 'wordjs');
        assert.deepStrictEqual(themeJson.tokens, { '--wjs-color-primary': '#654321' });

        const css = fs.readFileSync(themePath('green-theme', 'style.css'), 'utf8');
        assert.ok(css.includes('--wjs-color-primary: #654321;'), css);
        assert.ok(!css.includes('#123456'), 'the old token value must be gone');
        assert.ok(css.includes('body { background-color: #fafafa }'), 'untouched sections still compile');
        assert.ok(css.includes(manualTail), 'manual CSS outside the markers must survive');
        assert.strictEqual(css.indexOf(MARKER_END), css.lastIndexOf(MARKER_END), 'exactly one generated block');

        assert.strictEqual(fs.readFileSync(themePath('green-theme', 'functions.js'), 'utf8'), fnBefore,
            'the API must NEVER rewrite functions.js');
    });

    it('a PUT that fails compilation is a 400 and leaves the theme byte-identical', async () => {
        const cssBefore = fs.readFileSync(themePath('green-theme', 'style.css'), 'utf8');
        const jsonBefore = fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8');

        const res = await asAdmin(request(app).put('/api/v1/themes/green-theme'))
            .send({ styles: { card: { background: 'red;} body{background:url(//evil)}' } } });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.ok(Array.isArray(res.body.diagnostics) && res.body.diagnostics.length > 0);

        assert.strictEqual(fs.readFileSync(themePath('green-theme', 'style.css'), 'utf8'), cssBefore);
        assert.strictEqual(fs.readFileSync(themePath('green-theme', 'theme.json'), 'utf8'), jsonBefore);
    });
});
