/**
 * Memoized theme scan (core/themes) + the derived `active_theme_version` the public settings
 * payload carries.
 *
 * scanThemes() is synchronous fs work on a hot, unauthenticated path (GET /api/v1/themes, and now
 * every public settings read), so it is memoized with a 60s TTL. The TTL is the easy half; the half
 * that can rot is the INVALIDATION, so every mutation is proved with a canary: a theme dir planted
 * behind the app's back, which can only become visible if the mutation actually dropped the memo.
 * A mutation that silently stops invalidating fails here instead of shipping a theme list — and a
 * stylesheet URL — that is up to a minute stale.
 *
 * Same CWD-sandbox ordering as theme-write-api.test.ts: THEMES_DIR ('./themes') and the compiler's
 * manifest path ('./public/theme-tokens.json') resolve from the CWD at module load, so we chdir into
 * a temp root BEFORE requiring anything that transitively loads core/themes. node --test runs each
 * file in its own process, so the chdir leaks nowhere.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST.
const REAL_MANIFEST = path.join(__dirname, '..', '..', 'public', 'theme-tokens.json');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-scan-'));
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

const {
    Theme,
    scanThemes,
    invalidateThemeScanCache,
    getActiveThemeVersion,
    switchTheme,
    deleteTheme,
    createDefaultTheme,
    installThemeFromDir,
    installThemeFromZip,
    THEMES_DIR
} = require('../core/themes');

// Count only the scans of THEMES_DIR — installThemeFromDir walks its SOURCE with readdirSync too.
let readdirCount = 0;
const realReaddirSync = fs.readdirSync;
function countingReaddirSync(this: any, dir: any, ...rest: any[]) {
    try {
        if (path.resolve(String(dir)) === path.resolve(THEMES_DIR)) readdirCount++;
    } catch { /* non-path argument — not our scan */ }
    return realReaddirSync.call(this, dir, ...rest);
}

const seedTheme = (slug: string, version = '1.0.0') => {
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(
        { name: `Theme ${slug}`, version, description: 'seeded', author: 'suite' }, null, 2));
    fs.writeFileSync(path.join(dir, 'style.css'), `/* ${slug} */\n`);
    return dir;
};

const slugs = () => scanThemes().map((t: any) => t.slug);

describe('theme scan memo + derived active_theme_version', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let purgeCalls: any[][] = [];

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const themePath = (slug: string, ...rest: string[]) => path.join(THEMES_DIR, slug, ...rest);
    const writePayload = (slug: string, version: string) => ({
        slug,
        metadata: { name: `Theme ${slug}`, description: 'generated in tests', author: 'suite', version },
        tokens: { '--wjs-color-primary': '#123456' }
    });

    before(async () => {
        request = require('supertest');
        fs.readdirSync = countingReaddirSync;

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // Record the explicit purge instead of firing it. routes/themes destructures purgeFrontend at
        // module load, so the stub MUST be installed before that require below.
        const purge = require('../core/frontend-purge');
        purge.purgeFrontend = (...args: any[]) => { purgeCalls.push(args); };

        // switchTheme re-inits the (legacy) Handlebars engine, which forks the theme's functions.js
        // as an OS isolate. Irrelevant to the cache and expensive here — stub the collaborator, not
        // the function under test.
        require('../core/theme-engine').init = async () => { /* no-op */ };

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        fs.readdirSync = realReaddirSync;
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ the memo itself

    it('two consecutive scans read the themes dir once', () => {
        seedTheme('alpha-theme', '1.0.0');
        invalidateThemeScanCache();

        readdirCount = 0;
        const first = slugs();
        const second = slugs();
        const third = slugs();

        assert.strictEqual(readdirCount, 1, 'the memo must serve every scan after the first');
        assert.deepStrictEqual(second, first);
        assert.deepStrictEqual(third, first);
        assert.ok(first.includes('alpha-theme'));
    });

    it('a cold scan after invalidation hits the filesystem again', () => {
        invalidateThemeScanCache();
        readdirCount = 0;
        scanThemes();                  // cold
        scanThemes();                  // memo
        invalidateThemeScanCache();
        scanThemes();                  // cold again
        assert.strictEqual(readdirCount, 2);
    });

    it('serves full Theme instances (no field filtered) and isolates callers from each other', () => {
        const theme = scanThemes().find((t: any) => t.slug === 'alpha-theme');
        assert.ok(theme instanceof Theme, 'callers still get Theme instances, not plain records');
        assert.strictEqual(theme.name, 'Theme alpha-theme');
        assert.strictEqual(theme.version, '1.0.0');
        assert.strictEqual(theme.description, 'seeded');
        assert.strictEqual(theme.author, 'suite');
        assert.strictEqual(theme.path, themePath('alpha-theme'));
        assert.strictEqual(theme.templatePath, themePath('alpha-theme', 'templates'));
        assert.strictEqual(theme.layout, null);
        assert.strictEqual(theme.getStylesheet(), '/themes/alpha-theme/style.css');

        // A caller that mutates what it got back must not poison the next caller.
        const mine = scanThemes();
        const count = mine.length;
        mine.push(new Theme({ slug: 'not-real', path: 'x', templatePath: 'x' }));
        mine[0].version = 'clobbered';
        const theirs = scanThemes();
        assert.strictEqual(theirs.length, count);
        assert.ok(!theirs.some((t: any) => t.slug === 'not-real'));
        assert.notStrictEqual(theirs[0].version, 'clobbered');
    });

    it('hides a theme planted behind the app\'s back until the memo is dropped (the documented TTL worst case)', () => {
        scanThemes(); // warm
        seedTheme('offband-theme');
        assert.ok(!slugs().includes('offband-theme'), 'an out-of-app fs write is invisible for up to the TTL');
        invalidateThemeScanCache();
        assert.ok(slugs().includes('offband-theme'));
    });

    // ------------------------------------------------------------------ invalidation on every mutation

    let canaryN = 0;
    /**
     * A mutation must DROP the memo, not merely make its own change visible. So we warm the memo,
     * plant an unrelated theme directly on disk (invisible to a warm memo), then run the mutation:
     * the canary can only appear if a real re-scan happened.
     */
    const assertInvalidates = async (label: string, mutate: () => any) => {
        scanThemes();
        const canary = `canary-${++canaryN}`;
        seedTheme(canary);
        assert.ok(!slugs().includes(canary), `${label}: precondition — the memo must be warm`);
        await mutate();
        assert.ok(slugs().includes(canary), `${label} must invalidate the theme scan memo`);
    };

    it('createDefaultTheme(force) invalidates', async () => {
        await assertInvalidates('createDefaultTheme(true)', () => createDefaultTheme(true));
        assert.ok(slugs().includes('default'));
    });

    it('installThemeFromDir invalidates', async () => {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-src-'));
        fs.writeFileSync(path.join(src, 'theme.json'), JSON.stringify({ name: 'From Dir', version: '1.0.0' }));
        fs.writeFileSync(path.join(src, 'style.css'), '/* from dir */\n');
        await assertInvalidates('installThemeFromDir', () => installThemeFromDir(src, 'fromdir-theme'));
        assert.ok(slugs().includes('fromdir-theme'));
        fs.rmSync(src, { recursive: true, force: true });
    });

    it('installThemeFromZip invalidates', async () => {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('fromzip-theme/theme.json', Buffer.from(JSON.stringify({ name: 'From Zip', version: '1.0.0' })));
        zip.addFile('fromzip-theme/style.css', Buffer.from('/* from zip */\n'));
        const zipPath = path.join(os.tmpdir(), `wordjs-fromzip-${process.pid}.zip`);
        zip.writeZip(zipPath);

        await assertInvalidates('installThemeFromZip', async () => {
            const result = await installThemeFromZip(zipPath, 'fromzip-theme');
            assert.ok(result.ok, JSON.stringify(result.body));
        });
        assert.ok(slugs().includes('fromzip-theme'));
    });

    it('deleteTheme invalidates', async () => {
        await assertInvalidates('deleteTheme', () => deleteTheme('fromzip-theme'));
        assert.ok(!slugs().includes('fromzip-theme'));
    });

    it('switchTheme invalidates', async () => {
        await assertInvalidates('switchTheme', () => switchTheme('alpha-theme'));
    });

    it('POST /api/v1/themes/upload invalidates (it writes into THEMES_DIR without going through core)', async () => {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile('uploaded-theme/theme.json', Buffer.from(JSON.stringify({ name: 'Uploaded', version: '1.0.0' })));
        zip.addFile('uploaded-theme/style.css', Buffer.from('/* uploaded */\n'));
        const zipPath = path.join(os.tmpdir(), `uploaded-theme.zip`);
        zip.writeZip(zipPath);

        await assertInvalidates('POST /themes/upload', async () => {
            const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zipPath);
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        });
        assert.ok(slugs().includes('uploaded-theme'));
        fs.rmSync(zipPath, { force: true });
    });

    it('POST /api/v1/themes invalidates', async () => {
        await assertInvalidates('POST /api/v1/themes', async () => {
            const res = await asAdmin(request(app).post('/api/v1/themes')).send(writePayload('live-theme', '1.0.0'));
            assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        });
        assert.ok(slugs().includes('live-theme'));
    });

    it('PUT /api/v1/themes/:slug invalidates (an in-place rebuild bypasses core/themes entirely)', async () => {
        await assertInvalidates('PUT /api/v1/themes/:slug', async () => {
            const res = await asAdmin(request(app).put('/api/v1/themes/live-theme'))
                .send({ tokens: { '--wjs-color-primary': '#654321' } });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.version, '1.0.1');
        });
        // ...and the memo now reports the bumped version, not the one it was holding.
        assert.strictEqual(scanThemes().find((t: any) => t.slug === 'live-theme').version, '1.0.1');
    });

    // ------------------------------------------------------------------ public settings payload

    it('GET /api/v1/settings carries active_theme_version for the ACTIVE theme', async () => {
        const activate = await asAdmin(request(app).post('/api/v1/themes/live-theme/activate'));
        assert.strictEqual(activate.status, 200, JSON.stringify(activate.body));

        const res = await request(app).get('/api/v1/settings'); // anonymous — it IS public content
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.template, 'live-theme');
        assert.strictEqual(res.body.active_theme_version, '1.0.1',
            'the frontend versions the stylesheet URL with this');
        assert.strictEqual(await getActiveThemeVersion(), '1.0.1');
    });

    it('the version in the payload follows an in-place rebuild of the active theme', async () => {
        const put = await asAdmin(request(app).put('/api/v1/themes/live-theme'))
            .send({ tokens: { '--wjs-color-primary': '#abcdef' } });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        assert.strictEqual(put.body.version, '1.0.2');

        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.body.active_theme_version, '1.0.2',
            'a stale scan memo here would serve a stylesheet URL that never busts');
    });

    it('the version in the payload follows an activation', async () => {
        const create = await asAdmin(request(app).post('/api/v1/themes')).send(writePayload('spare-theme', '2.5.0'));
        assert.strictEqual(create.status, 201, JSON.stringify(create.body));

        const activate = await asAdmin(request(app).post('/api/v1/themes/spare-theme/activate'));
        assert.strictEqual(activate.status, 200, JSON.stringify(activate.body));

        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.body.template, 'spare-theme');
        assert.strictEqual(res.body.active_theme_version, '2.5.0');
    });

    it('GET /api/v1/settings/active_theme_version is publicly readable', async () => {
        const res = await request(app).get('/api/v1/settings/active_theme_version');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { key: 'active_theme_version', value: '2.5.0' });
    });

    it('is DERIVED: the generic settings writers refuse to store it', async () => {
        const single = await asAdmin(request(app).put('/api/v1/settings/active_theme_version')).send({ value: '9.9.9' });
        assert.strictEqual(single.status, 400);

        const bulk = await asAdmin(request(app).put('/api/v1/settings')).send({ active_theme_version: '9.9.9' });
        assert.strictEqual(bulk.status, 200);
        assert.ok(!('active_theme_version' in bulk.body), 'the bulk writer must skip it');

        const row = await database.getDbAsync().get(
            'SELECT option_value FROM options WHERE option_name = ?', ['active_theme_version']);
        assert.strictEqual(row, undefined, 'no option row may shadow the theme on disk');

        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.body.active_theme_version, '2.5.0');
    });

    // ------------------------------------------------------------------ on-demand purge

    it('a rebuild of the ACTIVE theme purges the settings tag; an inactive one does not', async () => {
        purgeCalls = [];
        const active = await asAdmin(request(app).put('/api/v1/themes/spare-theme'))
            .send({ tokens: { '--wjs-color-primary': '#0000ff' } });
        assert.strictEqual(active.status, 200, JSON.stringify(active.body));
        assert.deepStrictEqual(purgeCalls, [[['settings'], ['/']]],
            'the public HTML embeds the versioned stylesheet URL — it must be re-rendered');

        purgeCalls = [];
        const inactive = await asAdmin(request(app).put('/api/v1/themes/live-theme'))
            .send({ tokens: { '--wjs-color-primary': '#00ff00' } });
        assert.strictEqual(inactive.status, 200, JSON.stringify(inactive.body));
        assert.deepStrictEqual(purgeCalls, [], 'no public page renders an inactive theme');
    });
});
