/**
 * Companion-theme install (plugin-completeness program, option B).
 *
 * Two layers:
 *  1. core/themes installThemeFromDir — the dir-copy twin of the /themes/upload validation
 *     (budget, symlink refusal, never-overwrite), exercised against throwaway temp dirs.
 *  2. The REAL router via supertest: POST /api/v1/plugins/:slug/install-theme must demand an
 *     admin, refuse traversal-shaped slugs before any fs op, 404 on missing plugin/theme, copy
 *     to themes/<slug>-theme, 409 on re-install, and honor { activate: true }.
 *
 * IMPORTANT ordering: PLUGINS_DIR ('./plugins') and THEMES_DIR ('./themes') are resolved from the
 * CWD at module load, so we chdir into a temp root BEFORE requiring anything that transitively
 * loads core/plugins or core/themes. Same idea as api.test.ts's config.dbPath mutation (which we
 * also do). node --test runs each file in its own process, so the chdir leaks nowhere.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (plugins/ + themes/ resolve from it at module load).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-install-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const { installThemeFromDir, THEMES_DIR, getCurrentTheme } = require('../core/themes');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');

function writePlugin(slug: string, { withTheme = true } = {}) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: slug, name: slug, version: '1.0.0', isolated: true }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    if (withTheme) {
        const themeDir = path.join(dir, 'theme');
        fs.mkdirSync(path.join(themeDir, 'templates'), { recursive: true });
        fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({ name: `${slug} theme`, version: '1.0.0' }));
        fs.writeFileSync(path.join(themeDir, 'style.css'), ':root { --wjs-color-primary: #123456; }\n');
        fs.writeFileSync(path.join(themeDir, 'templates', 'index.html'), '<html></html>\n');
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Layer 1: the core copy/validation primitive (temp dirs only, no HTTP).
// ---------------------------------------------------------------------------

describe('installThemeFromDir (core)', () => {
    const mkTmp = (name: string) => {
        const d = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
        return d;
    };

    const mkThemeSrc = () => {
        const src = mkTmp('src');
        fs.mkdirSync(path.join(src, 'templates'), { recursive: true });
        fs.writeFileSync(path.join(src, 'style.css'), 'body{}');
        fs.writeFileSync(path.join(src, 'theme.json'), '{"name":"t"}');
        fs.writeFileSync(path.join(src, 'templates', 'index.html'), '<html></html>');
        return src;
    };

    it('copies the tree (nested dirs included) into themesDir/<slug>', () => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        const res = installThemeFromDir(src, 'demo-theme', { themesDir });
        assert.strictEqual(res.slug, 'demo-theme');
        assert.strictEqual(res.files, 3);
        assert.ok(fs.existsSync(path.join(themesDir, 'demo-theme', 'style.css')));
        assert.ok(fs.existsSync(path.join(themesDir, 'demo-theme', 'templates', 'index.html')));
    });

    it('refuses to overwrite an existing theme (THEME_EXISTS)', () => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        installThemeFromDir(src, 'demo-theme', { themesDir });
        assert.throws(() => installThemeFromDir(src, 'demo-theme', { themesDir }), (e: any) => e.code === 'THEME_EXISTS');
    });

    it('refuses a source that does not look like a theme', () => {
        const themesDir = mkTmp('themes');
        const src = mkTmp('notatheme');
        fs.writeFileSync(path.join(src, 'readme.txt'), 'hi');
        assert.throws(() => installThemeFromDir(src, 'x-theme', { themesDir }), (e: any) => e.code === 'THEME_INVALID' && /style\.css|theme\.json/.test(e.message));
    });

    it('refuses traversal-shaped target slugs before touching the fs', () => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        for (const bad of ['../evil', '..', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65)]) {
            assert.throws(() => installThemeFromDir(src, bad, { themesDir }), (e: any) => e.code === 'THEME_INVALID', `slug ${JSON.stringify(bad)} must be refused`);
        }
        assert.strictEqual(fs.readdirSync(themesDir).length, 0, 'nothing may be created for a refused slug');
    });

    it('enforces the entry budget (zip-guard parity)', () => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        assert.throws(() => installThemeFromDir(src, 'over-budget', { themesDir, maxEntries: 2 }), (e: any) => e.code === 'THEME_INVALID' && /entries/.test(e.message));
        assert.ok(!fs.existsSync(path.join(themesDir, 'over-budget')));
    });

    it('enforces the byte budget (zip-guard parity)', () => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        assert.throws(() => installThemeFromDir(src, 'too-big', { themesDir, maxTotalBytes: 4 }), (e: any) => e.code === 'THEME_INVALID' && /size budget/.test(e.message));
        assert.ok(!fs.existsSync(path.join(themesDir, 'too-big')));
    });

    it('refuses a symlink inside the source (dir-copy zip-slip)', (t: any) => {
        const themesDir = mkTmp('themes');
        const src = mkThemeSrc();
        const outside = mkTmp('outside');
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'host file');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(src, 'link.css'));
        } catch {
            // Symlink creation needs privileges on Windows — the guard still matters on the
            // Linux hosts we deploy to; skip only when the fixture itself cannot be built.
            t.skip('cannot create symlinks on this host');
            return;
        }
        assert.throws(() => installThemeFromDir(src, 'sym-theme', { themesDir }), (e: any) => e.code === 'THEME_INVALID' && /symlink/.test(e.message));
        assert.ok(!fs.existsSync(path.join(themesDir, 'sym-theme')));
    });
});

// ---------------------------------------------------------------------------
// Layer 2: the REAL router (auth, slug gate, 404/409, copy, activate).
// ---------------------------------------------------------------------------

describe('POST /api/v1/plugins/:slug/install-theme (route)', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        // Admin (user_meta role) + plain subscriber (no role meta → 'subscriber').
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

        // Fixture plugins inside the sandboxed PLUGINS_DIR.
        writePlugin('demo-with-theme', { withTheme: true });
        writePlugin('demo-no-theme', { withTheme: false });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('rejects anonymous requests (401)', async () => {
        const res = await request(app).post('/api/v1/plugins/demo-with-theme/install-theme').send({});
        assert.strictEqual(res.status, 401);
    });

    it('rejects a non-admin user (403)', async () => {
        const res = await request(app)
            .post('/api/v1/plugins/demo-with-theme/install-theme')
            .set('Authorization', `Bearer ${subscriberToken}`)
            .send({});
        assert.strictEqual(res.status, 403);
    });

    it('refuses traversal-shaped slugs with 400, before any fs effect', async () => {
        // NOTE: a literal '%2e%2e' ('..') can't be exercised here — the HTTP client normalizes the
        // dot-dot segment out of the path before Express sees it (the request 404s at the router,
        // which is also safe). Slash and backslash traversal DO reach the handler as :slug.
        for (const bad of ['..%2f..%2fetc', '..%5c..%5cwindows', '.hidden']) {
            const res = await request(app)
                .post(`/api/v1/plugins/${bad}/install-theme`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});
            assert.strictEqual(res.status, 400, `slug ${bad} must 400, got ${res.status}`);
        }
        assert.deepStrictEqual(fs.readdirSync(THEMES_DIR), [], 'no theme dir may appear');
    });

    it('404s a well-formed slug that is not an installed plugin', async () => {
        const res = await request(app)
            .post('/api/v1/plugins/definitely-not-installed/install-theme')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});
        assert.strictEqual(res.status, 404);
    });

    it('404s a plugin that bundles no theme/', async () => {
        const res = await request(app)
            .post('/api/v1/plugins/demo-no-theme/install-theme')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});
        assert.strictEqual(res.status, 404);
        assert.match(res.body.error, /does not bundle a theme/);
    });

    it('installs the bundled theme to themes/<slug>-theme (no activation by default)', async () => {
        const res = await request(app)
            .post('/api/v1/plugins/demo-with-theme/install-theme')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'demo-with-theme-theme');
        assert.strictEqual(res.body.activated, false);
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'demo-with-theme-theme', 'style.css')));
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'demo-with-theme-theme', 'templates', 'index.html')));
        // Default install must NOT switch the site's theme.
        assert.notStrictEqual(await getCurrentTheme(), 'demo-with-theme-theme');
    });

    it('409s a re-install of an already-installed companion theme', async () => {
        const res = await request(app)
            .post('/api/v1/plugins/demo-with-theme/install-theme')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});
        assert.strictEqual(res.status, 409);
    });

    it('{ activate: true } switches the active theme after install', async () => {
        writePlugin('demo-activate', { withTheme: true });
        const res = await request(app)
            .post('/api/v1/plugins/demo-activate/install-theme')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ activate: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.activated, true);
        assert.strictEqual(await getCurrentTheme(), 'demo-activate-theme');
    });

    it('GET /plugins advertises hasTheme + themeInstalled to the admin UI', async () => {
        const res = await request(app)
            .get('/api/v1/plugins')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        const withTheme = res.body.find((p: any) => p.slug === 'demo-with-theme');
        const noTheme = res.body.find((p: any) => p.slug === 'demo-no-theme');
        assert.ok(withTheme && withTheme.hasTheme === true && withTheme.themeInstalled === true, JSON.stringify(withTheme));
        assert.ok(noTheme && noTheme.hasTheme === false, JSON.stringify(noTheme));
    });
});
