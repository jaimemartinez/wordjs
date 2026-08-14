/**
 * Theme provisioning guards.
 *
 * THE BUG THIS PINS. Boot called createDefaultTheme() unconditionally (index.ts) — the comment said
 * "if none exist", the code checked nothing — and five of the eight files it writes went out through a
 * bare fs.writeFileSync. So every restart destroyed hand edits to partials/{header,footer}.html and
 * templates/{index,single,archive}.html, and rewrote a directory the user owns. No comparable CMS does
 * this: WordPress falls back to WP_DEFAULT_THEME, Ghost ships casper and refuses to delete it, Drupal's
 * ThemeInstaller refuses to uninstall the default, Joomla locks core templates. Ship a fallback, refuse
 * to delete it, degrade gracefully — never rewrite.
 *
 * Three properties are asserted, each the way it can actually rot:
 *   1. boot writes NOTHING inside themes/ — proved both as a source-drift gate on index.ts (the call
 *      is gone) and behaviourally on all EIGHT files (even a stray call must not clobber an edit);
 *   2. the LAST remaining theme cannot be deleted — in core AND through the HTTP route, because the
 *      admin UI and an API client must hit the same wall;
 *   3. a missing active theme is REPORTED — the site's fallback to the framework's own :root tokens
 *      is correct and stays, but it must no longer be silent.
 *
 * Same CWD-sandbox ordering as theme-scan-cache.test.ts: THEMES_DIR ('./themes') resolves from the CWD
 * at module load, so we chdir into a temp root BEFORE requiring anything that loads core/themes.
 * node --test runs each file in its own process, so the chdir leaks nowhere.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST. Nothing in this file may touch the real backend/themes.
const REAL_MANIFEST = path.join(__dirname, '..', '..', 'public', 'theme-tokens.json');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-boot-'));
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
    createDefaultTheme,
    verifyDefaultTheme,
    deleteTheme,
    getActiveTheme,
    isActiveThemeMissing,
    invalidateThemeScanCache,
    scanThemes,
    DEFAULT_THEME_SLUG,
    REQUIRED_THEME_FILES,
    THEMES_DIR
} = require('../core/themes');
const { updateOption } = require('../core/options');

// tests are excluded from the dist build (tsconfig.build.json), so this only ever runs from src/tests
// under ts-node — backend/src/index.ts is always on disk next door.
const BOOT_SOURCE = path.join(__dirname, '..', 'index.ts');

/** Every file createDefaultTheme() writes. The five HTML ones are the ones that used to be clobbered. */
const SCAFFOLD_FILES = [
    'theme.json',
    'functions.js',
    'style.css',
    path.join('partials', 'header.html'),
    path.join('partials', 'footer.html'),
    path.join('templates', 'index.html'),
    path.join('templates', 'single.html'),
    path.join('templates', 'archive.html')
];

const defaultDir = () => path.join(THEMES_DIR, DEFAULT_THEME_SLUG);

const seedTheme = (slug: string) => {
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: `Theme ${slug}`, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'style.css'), `/* ${slug} */\n`);
    invalidateThemeScanCache();
    return dir;
};

const removeAllThemes = () => {
    for (const entry of fs.readdirSync(THEMES_DIR)) {
        fs.rmSync(path.join(THEMES_DIR, entry), { recursive: true, force: true });
    }
    invalidateThemeScanCache();
};

describe('theme provisioning guards', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    before(async () => {
        request = require('supertest');

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

        // Deleting a theme through the route purges the frontend and the (legacy) Handlebars engine
        // re-inits on activation. Neither is under test here — stub the collaborators, not the subject.
        require('../core/frontend-purge').purgeFrontend = () => { /* recorded nowhere: not under test */ };
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
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ 1. boot must not write

    it('boot does not provision themes: index.ts no longer calls createDefaultTheme', () => {
        assert.ok(fs.existsSync(BOOT_SOURCE), `${BOOT_SOURCE} must exist for this drift gate to mean anything`);
        // Comments mentioning the old call are fine — index.ts documents WHY it is gone — so drop
        // whole-line comments before looking for an invocation. Deliberately LINE-based and nothing
        // cleverer: a comment-stripper that understands strings could delete real code and turn this
        // gate into a false pass. Dropping only lines that begin as a comment can leave text in
        // (a trailing `// createDefaultTheme(` would fail this test) but can never hide a call.
        const source = fs.readFileSync(BOOT_SOURCE, 'utf8')
            .split('\n')
            .filter((line: string) => !/^\s*(\/\/|\/\*|\*)/.test(line))
            .join('\n');
        assert.ok(
            !/createDefaultTheme\s*\(/.test(source),
            'boot must not call createDefaultTheme() — provisioning belongs to the install wizard and ' +
            'POST /api/v1/themes/default, not to every restart'
        );
        assert.ok(
            /verifyDefaultTheme\s*\(/.test(source),
            'boot must still CHECK the default theme and warn — silently skipping the check is not the fix'
        );
    });

    it('verifyDefaultTheme() reports a missing/incomplete default and writes nothing', () => {
        removeAllThemes();

        let report = verifyDefaultTheme();
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.exists, false);
        assert.deepStrictEqual(report.missing, REQUIRED_THEME_FILES);
        assert.ok(!fs.existsSync(defaultDir()), 'the check must not CREATE the directory it is checking');

        // Present but incomplete: theme.json only.
        fs.mkdirSync(defaultDir(), { recursive: true });
        fs.writeFileSync(path.join(defaultDir(), 'theme.json'), JSON.stringify({ name: 'WordJS', version: '2.0.0' }));
        report = verifyDefaultTheme();
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.exists, true);
        assert.deepStrictEqual(report.missing, ['style.css']);
        assert.deepStrictEqual(
            fs.readdirSync(defaultDir()), ['theme.json'],
            'the check must not fill in what it found missing'
        );

        // Complete.
        fs.writeFileSync(path.join(defaultDir(), 'style.css'), ':root { --wjs-color-primary: #123456; }\n');
        report = verifyDefaultTheme();
        assert.strictEqual(report.ok, true);
        assert.deepStrictEqual(report.missing, []);
    });

    it('an edited default theme survives re-provisioning — ALL EIGHT files, including the five HTML ones', () => {
        removeAllThemes();
        createDefaultTheme();                       // first install: the scaffold lands
        for (const rel of SCAFFOLD_FILES) {
            assert.ok(fs.existsSync(path.join(defaultDir(), rel)), `scaffold did not write ${rel}`);
        }

        // The site owner edits every one of them by hand.
        const edited: Record<string, string> = {};
        for (const rel of SCAFFOLD_FILES) {
            const marker = `EDITED-BY-HAND ${rel.replace(/\\/g, '/')}`;
            const content = rel.endsWith('.json')
                ? JSON.stringify({ name: 'WordJS', version: '2.0.0', description: marker }, null, 2)
                : `${marker}\n`;
            fs.writeFileSync(path.join(defaultDir(), rel), content);
            edited[rel] = content;
        }

        // Anything that re-runs provisioning without `force` must leave every byte alone. (The five
        // HTML files used to be rewritten here — that is the regression this line catches.)
        createDefaultTheme();

        for (const rel of SCAFFOLD_FILES) {
            assert.strictEqual(
                fs.readFileSync(path.join(defaultDir(), rel), 'utf8'),
                edited[rel],
                `${rel} was overwritten — re-provisioning must never clobber a hand edit`
            );
        }
    });

    it('the admin restore (force) still rewrites all eight — that is what "restore" means', () => {
        createDefaultTheme(true);
        for (const rel of SCAFFOLD_FILES) {
            const content = fs.readFileSync(path.join(defaultDir(), rel), 'utf8');
            assert.ok(!content.includes('EDITED-BY-HAND'), `${rel} was NOT restored by createDefaultTheme(true)`);
        }
    });

    // ------------------------------------------------------------------ 2. the last theme is undeletable

    it('refuses to delete the LAST remaining theme, with a specific code and an actionable message', async () => {
        removeAllThemes();
        seedTheme('only-theme');
        await updateOption('template', 'some-other-theme');   // not the one on disk: the ACTIVE guard must not be what fires
        invalidateThemeScanCache();
        assert.strictEqual(scanThemes().length, 1);

        await assert.rejects(
            () => deleteTheme('only-theme'),
            (err: any) => {
                assert.strictEqual(err.code, 'theme_last_remaining', `wrong guard fired: ${err.message}`);
                assert.strictEqual(err.status, 409, 'must be a conflict, not an unhandled 500');
                assert.match(err.message, /last theme/i);
                assert.match(err.message, /themes\/default/, 'the refusal must name the way out');
                return true;
            }
        );
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'only-theme')), 'the refusal must leave the theme on disk');
    });

    it('the same wall stands in front of an API client, not only the admin UI', async () => {
        const res = await request(app)
            .delete('/api/v1/themes/only-theme')
            .set('Authorization', `Bearer ${adminToken}`);

        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'theme_last_remaining');
        assert.match(res.body.message, /themes\/default/);
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'only-theme')));
    });

    it('still deletes a theme when another one remains, and still refuses the ACTIVE one', async () => {
        seedTheme('second-theme');
        await updateOption('template', 'only-theme');
        invalidateThemeScanCache();

        await assert.rejects(
            () => deleteTheme('only-theme'),
            (err: any) => {
                assert.strictEqual(err.code, 'theme_active');
                assert.strictEqual(err.status, 409);
                return true;
            }
        );

        const result = await deleteTheme('second-theme');
        assert.strictEqual(result.success, true);
        assert.ok(!fs.existsSync(path.join(THEMES_DIR, 'second-theme')));
        assert.strictEqual(scanThemes().length, 1, 'the floor is exactly one theme');
    });

    // ------------------------------------------------------------------ 3. a missing active theme is visible

    it('reports a missing active theme instead of degrading silently', async () => {
        removeAllThemes();
        seedTheme('installed-theme');
        await updateOption('template', 'vanished-theme');
        invalidateThemeScanCache();

        assert.strictEqual(await getActiveTheme(), null, 'precondition: the active slug resolves to nothing');
        assert.strictEqual(await isActiveThemeMissing(), true);

        const payload = await request(app).get('/api/v1/settings');
        assert.strictEqual(payload.status, 200);
        assert.strictEqual(
            payload.body.active_theme_missing, true,
            'the settings payload the admin reads must carry the flag as a real boolean'
        );
        // Boolean, not "false"/"true": a stringified flag reads backwards through Boolean().
        assert.strictEqual(typeof payload.body.active_theme_missing, 'boolean');
        assert.strictEqual(payload.body.template, 'vanished-theme', 'the flag is useless without the slug to name');

        const single = await request(app).get('/api/v1/settings/active_theme_missing');
        assert.strictEqual(single.status, 200);
        assert.strictEqual(single.body.value, true);
    });

    it('clears the report once an installed theme is active again', async () => {
        await updateOption('template', 'installed-theme');
        invalidateThemeScanCache();

        assert.strictEqual(await isActiveThemeMissing(), false);
        const payload = await request(app).get('/api/v1/settings');
        assert.strictEqual(payload.body.active_theme_missing, false);
        assert.strictEqual(typeof payload.body.active_theme_missing, 'boolean');
    });
});
