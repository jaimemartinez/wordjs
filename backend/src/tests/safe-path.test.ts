/**
 * core/safe-path — the one place a user-provided name becomes a path, and the three consumers that
 * CodeQL flagged as js/path-injection (backend/src/core/theme-doctor.ts and the /themes routes).
 *
 * WHAT THIS FILE IS DEFENDING. The project's own incident history: "the code sanitizes VALUES and
 * does not validate what chooses STRUCTURE — a tag, a DDL class, a query inside a literal, a PATH —
 * so never infer safety from the ABSENCE of a token". Concretely, for paths, three things must all
 * hold and the third is the one that was missing:
 *   1. the FORM is allowlisted (THEME_SLUG / THEME_ASSET_NAME, the shapes the installer and the
 *      chrome/template validators already enforce);
 *   2. the candidate is resolved CANONICALLY (absolute + normalized, what the syscall will see);
 *   3. CONTAINMENT is proved on THAT value — and the value proved safe is the value RETURNED.
 *
 * The old guards did (1) and a half of (2): routes/themes.validateSlug resolved a path into a local,
 * prefix-tested it WITHOUT a separator (so `themes/` would match a sibling `themes-evil/`), returned
 * a boolean, and every handler then re-joined the RAW slug. theme-doctor regex-checked the slug and
 * then trusted an INJECTED validator (opts.chromeValidate — a documented test escape hatch) to hand
 * it file names, which is a validator choosing a path.
 *
 * Sections:
 *   A. safe-path unit — every escape SHAPE, and the legitimate names that must keep resolving.
 *   B. the regex lock — safe-path's two shapes are character-identical to the ones chrome-validate
 *      and template-validate already own, so centralizing here cannot introduce a third dialect.
 *   C. theme-doctor — traversal/absolute/unicode/empty slugs fail closed, an injected validator can
 *      no longer make the doctor read (or even stat) a file outside the theme, and a real fixture
 *      still lints exactly as before.
 *   D. the REAL catalog — analyzeTheme against backend/themes must still work end to end.
 *   E. the routes — GET /:slug/templates and PUT/:slug through supertest: escape shapes are 400,
 *      a real theme is 200 with its templates.
 *
 * CWD-sandbox ordering copied from theme-mods-and-templates-api.test.ts: chdir into a temp root
 * BEFORE requiring anything that resolves paths from the CWD at module load (THEMES_DIR =
 * path.resolve('./themes')).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST — before core/themes or the routers are required anywhere below.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-safe-path-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const {
    THEME_SLUG,
    THEME_ASSET_NAME,
    isThemeSlug,
    isThemeAssetName,
    isPlainSegment,
    resolveWithin,
    isWithin,
    resolveThemeDir,
    resolveThemeAsset,
} = require('../core/safe-path');

// backend/ — __dirname is src/tests, so ../.. is the backend root from src AND from dist.
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────── A. safe-path unit

describe('core/safe-path — form, canonical resolution, containment', () => {
    const BASE = path.join(TMP_ROOT, 'base');

    // TWO TABLES ON PURPOSE, because the two halves of the defense answer different attacks and
    // conflating them is how a guard ends up looking complete while being half of one.
    //
    // (a) STRUCTURAL escapes: strings the FILESYSTEM itself reads as "somewhere else". These are what
    //     resolveWithin exists for — the segment rules plus the containment proof.
    const ESCAPES: Array<[string, string]> = [
        ['plain parent', '..'],
        ['relative traversal', '../evil'],
        ['deep traversal', '../../../etc/passwd'],
        ['traversal that comes back', 'a/../../b'],
        ['dot segment', '.'],
        ['posix absolute', '/etc/passwd'],
        ['windows absolute (backslash)', 'C:\\Windows\\System32\\config\\SAM'],
        ['windows absolute (forward slash)', 'C:/Windows'],
        ['windows drive-relative', 'C:evil'],           // path.isAbsolute() says false on win32
        ['unc path', '\\\\server\\share'],
        ['backslash traversal', '..\\evil'],
        ['nested legit-looking path', 'themes/other'],
        ['NTFS alternate data stream', 'style.css:evil'],
        ['NUL truncation', 'style.css\u0000.txt'],
        ['unicode ideographic full stop before a real slash', '\u3002\u3002/evil'],
        ['empty', ''],
    ];

    // (b) DECODING/LOOKALIKE escapes: strings that are ONE literal file name to the filesystem (fs
    //     does not percent-decode, and U+FF0F is not a separator) but that become a traversal one
    //     layer up — in a URL, in a re-decoded parameter, in an admin's eyes. resolveWithin must NOT
    //     pretend to defend against these: treating "%2e%2e%2f" as traversal would be exactly the
    //     "infer from the presence/absence of a token" reflex this codebase keeps getting burned by.
    //     They are defeated by the FORM allowlist instead, which is what the assertions below check.
    const LOOKALIKES: Array<[string, string]> = [
        ['percent-encoded traversal', '%2e%2e%2fevil'],
        ['percent-encoded slash', 'a%2Fb'],
        ['double-encoded traversal', '%252e%252e%252fevil'],
        ['unicode fullwidth solidus', '..\uFF0Fevil'],
        ['cyrillic homoglyph', 'd\u0435fault'],
        ['trailing dot (win32 strips it)', 'default.'],
        ['trailing space (win32 strips it)', 'default '],
    ];

    it('resolveWithin refuses every escape shape — and returns null, never a "cleaned" path', () => {
        for (const [label, seg] of ESCAPES) {
            assert.strictEqual(resolveWithin(BASE, seg), null, `${label}: ${JSON.stringify(seg)} must not resolve`);
        }
    });

    it('resolveWithin refuses an escape in ANY position of a multi-segment call', () => {
        assert.strictEqual(resolveWithin(BASE, '..', 'chrome', 'header.json'), null);
        assert.strictEqual(resolveWithin(BASE, 'chrome', '..', 'header.json'), null);
        assert.strictEqual(resolveWithin(BASE, 'chrome', '../../../etc/passwd'), null);
    });

    it('resolveWithin resolves a legitimate descendant, absolute and normalized', () => {
        assert.strictEqual(resolveWithin(BASE, 'default'), path.join(BASE, 'default'));
        assert.strictEqual(resolveWithin(BASE, 'default', 'style.css'), path.join(BASE, 'default', 'style.css'));
        assert.strictEqual(
            resolveWithin(BASE, 'default', 'chrome', 'header.json'),
            path.join(BASE, 'default', 'chrome', 'header.json'),
        );
        // A relative base still yields an absolute answer (the syscall never sees the caller's string).
        const rel = resolveWithin('./themes', 'default');
        assert.ok(rel !== null && path.isAbsolute(rel), 'a relative base must resolve to an absolute path');
    });

    it('resolveWithin refuses a base-only call and a non-string base', () => {
        assert.strictEqual(resolveWithin(BASE), null, 'containment here is STRICT: a child, never the base itself');
        assert.strictEqual(resolveWithin('', 'default'), null);
        assert.strictEqual(resolveWithin(null as any, 'default'), null);
        assert.strictEqual(resolveWithin(BASE, null as any), null);
        assert.strictEqual(resolveWithin(BASE, 42 as any), null);
        assert.strictEqual(resolveWithin(BASE, undefined as any), null);
    });

    it('THE SIBLING-PREFIX BUG: containment is by separator, not by string prefix', () => {
        // The shape the old routes/themes.validateSlug had: `resolved.startsWith(base)` with no sep.
        assert.strictEqual(isWithin(BASE, BASE + '-evil'), false);
        assert.strictEqual(isWithin(BASE, BASE + '-evil' + path.sep + 'style.css'), false);
        assert.strictEqual(isWithin(BASE, path.join(BASE, 'default')), true);
        assert.strictEqual(isWithin(BASE, BASE), true, 'isWithin() is the inclusive form, on purpose');
        assert.strictEqual(isWithin(BASE, path.join(BASE, '..', 'other')), false);
        assert.strictEqual(isWithin(BASE, 'x\u0000y'), false);
    });

    it('isPlainSegment describes what a segment may BE, not what it may not contain', () => {
        for (const ok of ['default', 'theme.json', 'single-post.json', 'a-b_c', '..hidden', 'x..y']) {
            assert.strictEqual(isPlainSegment(ok), true, `${JSON.stringify(ok)} is one plain name`);
        }
        for (const [, bad] of ESCAPES) {
            assert.strictEqual(isPlainSegment(bad), false, `${JSON.stringify(bad)} is not one plain name`);
        }
    });

    it('a decoding/lookalike escape is ONE file name to the fs — the FORM allowlist is what stops it', () => {
        for (const [label, s] of LOOKALIKES) {
            // Honest about the layering: as a literal segment it resolves, and it stays INSIDE.
            const resolved = resolveWithin(BASE, s);
            assert.ok(resolved !== null && isWithin(BASE, resolved), `${label}: a literal name must stay contained`);
            // And it can never be a theme directory or a chrome/template file, which is the gate that
            // actually runs before any of these reaches a path.
            assert.strictEqual(isThemeSlug(s), false, `${label}: must not pass the slug allowlist`);
            assert.strictEqual(isThemeAssetName(s), false, `${label}: must not pass the asset-name allowlist`);
            assert.strictEqual(resolveThemeDir(BASE, s), null, `${label}: must not become a theme dir`);
            assert.strictEqual(resolveThemeAsset(BASE, 'chrome', s), null, `${label}: must not become a chrome file`);
        }
    });

    it('isThemeSlug accepts only what the installer could have written', () => {
        for (const ok of ['default', 'toscano', 'a', 'Theme-1_x', 'a'.repeat(64)]) {
            assert.strictEqual(isThemeSlug(ok), true, `${ok} must be a legal slug`);
        }
        for (const bad of [
            '', '..', '../evil', '/etc/passwd', 'C:\\Windows', 'a/b', 'a\\b', 'a\u0000b',
            '-evil',           // leading dash — the OLD route regex ^[a-zA-Z0-9_-]+$ accepted this
            '_evil',           // leading underscore — same
            'a'.repeat(65),    // no length cap in the OLD route regex either
            'thème', 'dеmo',   // non-ASCII / Cyrillic homoglyph
            '%2e%2e%2f', 'a b', 'a.b',
            null, undefined, 42, {}, ['default'],
        ] as any[]) {
            assert.strictEqual(isThemeSlug(bad), false, `${JSON.stringify(bad)} must NOT be a legal slug`);
        }
    });

    it('resolveThemeDir refuses the escape shapes and resolves a real slug', () => {
        for (const [label, seg] of ESCAPES.concat(LOOKALIKES)) {
            assert.strictEqual(resolveThemeDir(BASE, seg), null, `${label} must not become a theme dir`);
        }
        assert.strictEqual(resolveThemeDir(BASE, 'default'), path.join(BASE, 'default'));
    });

    it('resolveThemeAsset gates the FILE NAME too — a validator cannot choose a path', () => {
        const themeDir = path.join(BASE, 'default');
        assert.strictEqual(
            resolveThemeAsset(themeDir, 'chrome', 'header'),
            path.join(themeDir, 'chrome', 'header.json'),
        );
        for (const bad of ['../../../outside/secret', 'Header', 'header.json', 'a/b', '', '..', 'a'.repeat(41), null]) {
            assert.strictEqual(resolveThemeAsset(themeDir, 'chrome', bad as any), null,
                `${JSON.stringify(bad)} must not name a chrome file`);
        }
        assert.strictEqual(isThemeAssetName('single-post'), true);
        assert.strictEqual(isThemeAssetName('Bad_Name'), false);
    });
});

// ─────────────────────────────────────────────────────────────────────── B. the regex lock

describe('core/safe-path — the shapes are the project\'s, not a third dialect', () => {
    it('THEME_ASSET_NAME is character-identical to chrome-validate and template-validate', () => {
        const chrome = require('../core/chrome-validate');
        const tpl = require('../core/template-validate');
        assert.strictEqual(THEME_ASSET_NAME.source, chrome.TEMPLATE_PART_NAME.source);
        assert.strictEqual(THEME_ASSET_NAME.flags, chrome.TEMPLATE_PART_NAME.flags);
        assert.strictEqual(THEME_ASSET_NAME.source, tpl.TEMPLATE_PART_NAME.source);
        assert.strictEqual(THEME_ASSET_NAME.source, '^[a-z0-9-]{1,40}$');
    });

    it('THEME_SLUG is the shape installThemeFromDir enforces on the way in', () => {
        // Locked literally: the reader's allowlist must never be WIDER than the writer's, or a
        // directory the installer could not create becomes readable through a route.
        assert.strictEqual(THEME_SLUG.source, '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');
        // And every theme actually shipped in the catalog satisfies it (narrowing broke nothing).
        const catalog = fs.readdirSync(path.join(BACKEND_ROOT, 'themes'), { withFileTypes: true })
            .filter((e: any) => e.isDirectory())
            .map((e: any) => e.name);
        assert.ok(catalog.length > 0, 'the catalog fixture must not be empty');
        for (const slug of catalog) {
            assert.strictEqual(isThemeSlug(slug), true, `catalog theme "${slug}" must stay resolvable`);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────── C. theme-doctor

describe('theme-doctor — a slug (or a validator) can no longer choose a path', () => {
    const { analyzeTheme } = require('../core/theme-doctor');

    const DOCTOR_ROOT = path.join(TMP_ROOT, 'doctor');
    const THEMES_DIR = path.join(DOCTOR_ROOT, 'themes');
    const MANIFEST_PATH = path.join(DOCTOR_ROOT, 'theme-tokens.json');
    // The canary: OUTSIDE the theme AND outside the themes dir. Nothing the doctor does may read it.
    const OUTSIDE_DIR = path.join(DOCTOR_ROOT, 'outside');
    const CANARY = path.join(OUTSIDE_DIR, 'secret.json');
    // ../../../ from <themes>/<slug>/chrome lands exactly on <DOCTOR_ROOT>/outside/secret.json.
    const ESCAPE_NAME = '../../../outside/secret';

    const MANIFEST = {
        version: 1,
        tokens: {
            '--wjs-bg-canvas': { group: 'bg', declaredDefault: '#ffffff', fallbacks: [], consumers: [] },
            '--wjs-color-text-main': { group: 'color', declaredDefault: '#111111', fallbacks: [], consumers: [] },
        },
        elements: {},
    };

    const STYLE = ':root{--wjs-bg-canvas:#ffffff;--wjs-color-text-main:#111111;}';

    before(() => {
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST));
        // Deliberately DISTINCT from any legitimate chrome file, so "the canary was read" can never be
        // confused with "a theme file that happens to have the same bytes was read".
        fs.writeFileSync(CANARY, JSON.stringify({ version: 1, canary: 'READ-OUTSIDE-THE-THEME', content: [] }));
    });

    let n = 0;
    function fixture(themeJson: any, files: Array<[string, string]> = []): string {
        const slug = `fixture-${n++}`;
        const dir = path.join(THEMES_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'style.css'), STYLE);
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: slug, version: '1.0.0', ...themeJson }));
        for (const [rel, content] of files) {
            const abs = path.join(dir, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
        }
        return slug;
    }

    const run = (slug: any) => analyzeTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH });

    it('fails CLOSED on every slug shape that is not a theme directory name', () => {
        const vectors: Array<[string, any]> = [
            ['empty', ''],
            ['parent', '..'],
            ['relative traversal', '../evil'],
            ['deep traversal', '../../../etc/passwd'],
            ['traversal that comes back', 'a/../../b'],
            ['posix absolute', '/etc/passwd'],
            ['windows absolute', 'C:\\Windows\\System32'],
            ['windows drive-relative', 'C:evil'],
            ['backslash traversal', '..\\evil'],
            ['percent-encoded traversal', '%2e%2e%2fevil'],
            ['double-encoded traversal', '%252e%252e%252f'],
            ['unicode fullwidth solidus', '..\uFF0Fevil'],
            ['cyrillic homoglyph', 'dеfault'],
            ['NUL truncation', 'default\u0000.txt'],
            ['leading dash', '-evil'],
            ['over-long', 'a'.repeat(65)],
            ['not a string', 42],
            ['null', null],
            ['array', ['default']],
            ['object', {}],
        ];
        for (const [label, slug] of vectors) {
            const report = run(slug);
            assert.strictEqual(report.available, true, `${label}: the manifest is present, so the doctor is available`);
            assert.ok(
                report.errors.some((e: any) => e.code === 'THEME_NOT_FOUND'),
                `${label}: expected THEME_NOT_FOUND, got ${JSON.stringify(report.errors)}`,
            );
            // Fail-closed means it STOPS: no style/layout/chrome findings can have been produced.
            assert.strictEqual(report.errors.length, 1, `${label}: nothing beyond the rejection ran`);
            assert.strictEqual(report.warnings.length, 0, `${label}: nothing beyond the rejection ran`);
        }
    });

    it('a real fixture still lints (the legitimate case is untouched)', () => {
        const slug = fixture({});
        const report = run(slug);
        assert.strictEqual(report.available, true);
        assert.strictEqual(report.slug, slug);
        assert.ok(!report.errors.some((e: any) => e.code === 'THEME_NOT_FOUND'), JSON.stringify(report.errors));
        assert.ok(!report.errors.some((e: any) => e.code === 'STYLE_UNREADABLE'), 'style.css must still be read');
    });

    it('a DECLARED template part cannot name a file outside the theme (it is reported missing instead)', () => {
        // The escape hatch is real: opts.chromeValidate is a documented stub point, so the doctor must
        // not inherit a validator's diligence. Before the fix, this name reached
        // fs.existsSync(<themeDir>/chrome/../../../outside/secret.json) — the canary EXISTS, so the
        // doctor stayed silent and had, in the process, probed a path outside the theme.
        const slug = fixture({ templateParts: [{ name: 'escape', area: 'general' }] });
        const report = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            chromeValidate: {
                CHROME_LAYOUT_SLOTS: ['header', 'footer'],
                validateTemplateParts: () => ({ ok: true, errors: [], parts: [{ name: ESCAPE_NAME, area: 'general' }] }),
                validateChromeData: () => ({ ok: true, errors: [] }),
            },
        });
        assert.ok(
            report.errors.some((e: any) => e.code === 'TEMPLATE_PART_MISSING' && e.detail && e.detail.name === ESCAPE_NAME),
            `a name that cannot resolve inside the theme must be reported missing, got ${JSON.stringify(report.errors)}`,
        );
    });

    it('an injected CHROME_LAYOUT_SLOTS cannot make the doctor READ a file outside the theme', () => {
        const seen: string[] = [];
        const bodies: string[] = [];
        const slug = fixture({}, [['chrome/header.json', JSON.stringify({ version: 1, content: [] })]]);
        const report = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            chromeValidate: {
                CHROME_LAYOUT_SLOTS: [ESCAPE_NAME, 'header'],
                validateTemplateParts: () => ({ ok: true, errors: [], parts: [] }),
                validateChromeData: (raw: string, o: any) => { seen.push(o.part); bodies.push(raw); return { ok: true, errors: [] }; },
            },
        });
        // Before the fix the escaping slot resolved to the canary, was read, and its bytes were handed
        // to the validator. Now it never becomes a path at all.
        assert.deepStrictEqual(seen, ['header'], `only the theme's own chrome may be read, got ${JSON.stringify(seen)}`);
        assert.ok(!bodies.some((b: string) => b.includes('READ-OUTSIDE-THE-THEME')),
            'the canary outside the theme must never be read');
        assert.ok(!report.warnings.some((w: any) => w.code === 'CHROME_UNREADABLE' && w.message.includes('outside')),
            'the escaping slot must be skipped silently, not reported as a theme file');
    });

    it('a legitimate declared part is still validated end to end', () => {
        const seen: string[] = [];
        const slug = fixture(
            { templateParts: [{ name: 'hero', area: 'general' }] },
            [['chrome/hero.json', JSON.stringify({ version: 1, content: [] })]],
        );
        const report = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            chromeValidate: {
                CHROME_LAYOUT_SLOTS: ['header', 'footer'],
                validateTemplateParts: () => ({ ok: true, errors: [], parts: [{ name: 'hero', area: 'general' }] }),
                validateChromeData: (_raw: string, o: any) => { seen.push(o.part); return { ok: true, errors: [] }; },
            },
        });
        assert.deepStrictEqual(seen, ['hero'], 'the declared part on disk must still be validated');
        assert.ok(!report.errors.some((e: any) => e.code === 'TEMPLATE_PART_MISSING'), JSON.stringify(report.errors));
    });

    it('templates/ is still enumerated and read for a real fixture', () => {
        const slug = fixture({}, [['templates/page.json', JSON.stringify({ version: 1, content: [{ type: 'nope' }] })]]);
        const report = analyzeTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH });
        // The file was READ (an invalid tree produces a finding); the point is only that it was reached.
        assert.ok(
            report.errors.some((e: any) => e.code === 'TEMPLATE_INVALID')
            || report.warnings.some((w: any) => w.code === 'TEMPLATE_UNREADABLE'),
            `templates/page.json must still be reached, got ${JSON.stringify(report)}`,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────── D. the real catalog

describe('theme-doctor — the shipped catalog still lints', () => {
    const { analyzeTheme } = require('../core/theme-doctor');
    const REAL_THEMES = path.join(BACKEND_ROOT, 'themes');
    const REAL_MANIFEST = path.join(BACKEND_ROOT, 'public', 'theme-tokens.json');

    it('every theme in backend/themes resolves, is found, and has a readable style.css', () => {
        const slugs = fs.readdirSync(REAL_THEMES, { withFileTypes: true })
            .filter((e: any) => e.isDirectory())
            .map((e: any) => e.name);
        assert.ok(slugs.length > 0, 'the shipped catalog must not be empty');
        for (const slug of slugs) {
            const report = analyzeTheme(slug, { themesDir: REAL_THEMES, manifestPath: REAL_MANIFEST });
            assert.strictEqual(report.slug, slug);
            assert.ok(!report.errors.some((e: any) => e.code === 'THEME_NOT_FOUND'),
                `${slug}: must still resolve — ${JSON.stringify(report.errors)}`);
            assert.ok(!report.errors.some((e: any) => e.code === 'STYLE_UNREADABLE'),
                `${slug}: style.css must still be read`);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────── E. the routes

describe('routes/themes — the slug gate returns the path it proved', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // A real theme under the sandboxed CWD's themes/ (THEMES_DIR = path.resolve('./themes')).
        const tdir = path.join(TMP_ROOT, 'themes', 'demo', 'templates');
        fs.mkdirSync(tdir, { recursive: true });
        fs.writeFileSync(path.join(TMP_ROOT, 'themes', 'demo', 'style.css'), '/* demo */');
        fs.writeFileSync(path.join(tdir, 'page.json'), '{"content":[]}');
        fs.writeFileSync(path.join(tdir, 'single-post.json'), '{"content":[]}');
        // A SIBLING directory whose name shares the themes/ prefix — the old prefix test had no
        // separator, so this is the directory a `themes` + `-evil` style check would have admitted.
        fs.mkdirSync(path.join(TMP_ROOT, 'themes-evil'), { recursive: true });
        fs.writeFileSync(path.join(TMP_ROOT, 'themes-evil', 'style.css'), '/* not a theme of ours */');

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

    // One URL-segment per vector. Express decodes %2e/%2f AFTER routing, so each of these really does
    // arrive at the handler as req.params.slug — this is the HTTP-level form of the unit table above.
    const BAD_SEGMENTS: Array<[string, string]> = [
        ['encoded traversal', '..%2f..%2fetc'],
        ['fully encoded traversal', '%2e%2e%2f%2e%2e%2fetc'],
        ['double-encoded traversal', '%252e%252e%252fetc'],
        ['encoded absolute path', '%2fetc%2fpasswd'],
        ['encoded windows path', 'C%3a%5cWindows'],
        ['encoded backslash traversal', '..%5c..%5cetc'],
        ['NUL truncation', 'demo%00.txt'],
        ['leading dash', '-evil'],
        ['leading underscore', '_evil'],
        ['over-long', 'a'.repeat(65)],
        ['cyrillic homoglyph', encodeURIComponent('dеmo')],
        ['sibling-prefix escape', '..%2fthemes-evil'],
    ];

    it('GET /:slug/templates refuses every escape shape with 400', async () => {
        for (const [label, seg] of BAD_SEGMENTS) {
            const res = await asAdmin(request(app).get(`/api/v1/themes/${seg}/templates`));
            assert.strictEqual(res.status, 400, `${label} (${seg}) must be 400, got ${res.status} ${JSON.stringify(res.body)}`);
        }
    });

    it('an UNENCODED ".." never reaches a handler — the URL layer collapses it first (404, not 200)', async () => {
        // Documented on purpose: this vector is stopped one layer earlier than the slug gate, so a
        // 400 here would be the wrong assertion. What matters is that it is never a 200.
        for (const url of ['/api/v1/themes/../templates', '/api/v1/themes/../../etc/templates']) {
            const res = await asAdmin(request(app).get(url));
            assert.notStrictEqual(res.status, 200, `${url} must never succeed`);
        }
    });

    it('GET /:slug/templates still lists a real theme', async () => {
        const res = await asAdmin(request(app).get('/api/v1/themes/demo/templates'));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'demo');
        assert.deepStrictEqual(res.body.templates, ['page', 'single-post']);
    });

    it('GET /:slug/doctor refuses every escape shape with 400', async () => {
        for (const [label, seg] of BAD_SEGMENTS) {
            const res = await asAdmin(request(app).get(`/api/v1/themes/${seg}/doctor`));
            assert.strictEqual(res.status, 400, `${label} (${seg}) must be 400, got ${res.status}`);
        }
    });

    it('PUT /:slug refuses every escape shape with 400 — before any fs effect', async () => {
        for (const [label, seg] of BAD_SEGMENTS) {
            const res = await asAdmin(request(app).put(`/api/v1/themes/${seg}`)).send({ tokens: { '--wjs-radius': '4px' } });
            assert.strictEqual(res.status, 400, `${label} (${seg}) must be 400, got ${res.status}`);
        }
        // Negative space: the sibling directory the old prefix test would have admitted is untouched.
        assert.strictEqual(
            fs.readFileSync(path.join(TMP_ROOT, 'themes-evil', 'style.css'), 'utf8'),
            '/* not a theme of ours */',
        );
        assert.ok(!fs.existsSync(path.join(TMP_ROOT, 'themes-evil', 'theme.json')), 'nothing may be written outside themes/');
    });
});
