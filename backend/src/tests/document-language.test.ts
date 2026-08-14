/**
 * F3a — the document's language/direction contract, and the theme's `color-scheme` token.
 *
 * Three things are pinned here, all of which were previously unrepresentable:
 *
 *  1. WPLANG and site_text_direction are PUBLIC settings, because the SSR root layout has to read
 *     them to render <html lang dir> on first paint. If they stop being public the site silently
 *     goes back to English/LTR — a regression with no error anywhere.
 *  2. Neither may be written as an arbitrary string. They are the only two options that end up in
 *     an HTML ATTRIBUTE rather than in text, so the write path is a closed shape and fail-closed.
 *     Every rejection asserts the NEGATIVE SPACE: after a 400 the option must be unchanged.
 *  3. `--wjs-color-scheme` survives the whole declarative pipeline — it is in the token manifest,
 *     the compiler emits it into the theme's :root, and wordjs-ui.css contains the `html` rule that
 *     consumes it. A token nothing consumes is a defect here, so the consumer is asserted too.
 *
 * Same CWD-sandbox ordering as chrome-api.test.ts: chdir into a temp root BEFORE requiring anything
 * that resolves paths from the CWD at module load.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_BACKEND = process.cwd();               // backend/ — captured before the chdir below
const UI_CSS = path.join(REPO_BACKEND, 'public', 'css', 'wordjs-ui.css');
const MANIFEST = path.join(REPO_BACKEND, 'public', 'theme-tokens.json');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-doclang-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('site language + text direction (settings contract)', () => {
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
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    // NOTE: no cleanup here. TMP_ROOT is shared with the compile describes below, and node:test runs
    // a describe's `after` as soon as ITS subtests finish — deleting the root here would pull the
    // directory out from under them. Cleanup is the top-level `after` at the bottom of this file.
    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ public exposure

    it('exposes WPLANG and site_text_direction on the anonymous /settings read', async () => {
        await asAdmin(request(app).put('/api/v1/settings')).send({ WPLANG: 'ar', site_text_direction: '' });
        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.status, 200);
        assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'WPLANG'), 'WPLANG must be public — the SSR root layout reads it');
        assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'site_text_direction'), 'site_text_direction must be public');
        assert.strictEqual(res.body.WPLANG, 'ar');
    });

    // ------------------------------------------------------------------ accepted shapes

    it('accepts the locale shapes a real site uses', async () => {
        for (const locale of ['en', 'ja', 'es_ES', 'ar-SA', 'he_IL', 'pa_Arab', 'pa_Arab_PK', 'es-419', '']) {
            const res = await asAdmin(request(app).put('/api/v1/settings/WPLANG')).send({ value: locale });
            assert.strictEqual(res.status, 200, `${JSON.stringify(locale)} should be accepted, got ${res.status}`);
        }
    });

    it('accepts exactly the enum, plus the empty/absent "derive from the locale" sentinel', async () => {
        for (const dir of ['ltr', 'rtl', 'auto', '']) {
            const res = await asAdmin(request(app).put('/api/v1/settings/site_text_direction')).send({ value: dir });
            assert.strictEqual(res.status, 200, `${JSON.stringify(dir)} should be accepted, got ${res.status}`);
            assert.strictEqual(await optionValue('site_text_direction'), dir);
        }
        // null ≡ unset ≡ '' — options never persist the text "null" (see core/options updateOption).
        const res = await asAdmin(request(app).put('/api/v1/settings/site_text_direction')).send({ value: null });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await optionValue('site_text_direction'), '');
    });

    // ------------------------------------------------------------------ rejections + negative space

    it('rejects a hostile or malformed locale with 400 and leaves the option untouched', async () => {
        await asAdmin(request(app).put('/api/v1/settings/WPLANG')).send({ value: 'en_US' });
        const before = await optionValue('WPLANG');
        assert.strictEqual(before, 'en_US');

        const hostile = [
            'en" onload="alert(1)',          // attribute break-out
            'en><script>alert(1)</script>',  // tag injection
            "en' autofocus onfocus='x",
            'en us',                         // whitespace
            'e',                             // too short
            'toolongsubtag',
            'en_USA',                        // 3-letter region
            'en-US-x-private',               // extensions are outside the accepted subset
            'javascript:alert(1)',
            '../../etc/passwd',
            42,                              // not a string
            { toString: 'x' },
            ['en'],
            true,
            // A TRAILING NEWLINE, pinned explicitly. In Perl, Python and PHP `$` also matches just
            // before a final line terminator, so an anchored regex that looks airtight there lets
            // "en\n<script>…" through on the last line. JavaScript's `$` (without /m) does not — but
            // that is a property of this language, not of this pattern, and the moment someone adds
            // /m to LOCALE_RE or ports the check, every value below starts passing. So the four
            // shapes that would exploit that are asserted rather than assumed.
            'en\n',
            'en\r\n',
            'en\nes',
            'en\n<script>alert(1)</script>',
            '\nen',
            'en\u0000',                     // NUL — truncates in anything C-ish downstream
            'en\u2028',                     // LINE SEPARATOR: a line break to a JS parser
            'en\u202Ertl',                  // RIGHT-TO-LEFT OVERRIDE smuggled into the tag
            '\uFF45\uFF4E',                // full-width homoglyphs: looks like "en", is not [A-Za-z]
            'a'.repeat(5000),                // an option row used as a payload
        ];
        for (const value of hostile) {
            const res = await asAdmin(request(app).put('/api/v1/settings/WPLANG')).send({ value });
            assert.strictEqual(res.status, 400, `${JSON.stringify(value)} must be rejected, got ${res.status}`);
            assert.strictEqual(await optionValue('WPLANG'), before, `${JSON.stringify(value)} must not have been stored`);
        }
    });

    it('rejects any direction outside the enum with 400 and leaves the option untouched', async () => {
        await asAdmin(request(app).put('/api/v1/settings/site_text_direction')).send({ value: 'rtl' });
        const before = await optionValue('site_text_direction');
        assert.strictEqual(before, 'rtl');

        // `site_text_direction` is compared against a three-literal array, so the only way to defeat
        // it is to smuggle something a LATER reader trims, folds or truncates back into one of the
        // three. Case, surrounding space, a trailing newline (see the `$` note above — the same trap
        // in list form) and a NUL are all exactly that, and none of them may be stored.
        for (const value of [
            'RTL', 'rtl ', 'inherit', 'rtl" dir="ltr', 'ltr;', 'rtl><script>',
            'rtl\n', '\nltr', 'auto\r\n', 'ltr\u0000', '\u202Ertl', 'Rtl',
            0, 1, {}, ['rtl'],
        ]) {
            const res = await asAdmin(request(app).put('/api/v1/settings/site_text_direction')).send({ value });
            assert.strictEqual(res.status, 400, `${JSON.stringify(value)} must be rejected, got ${res.status}`);
            assert.strictEqual(await optionValue('site_text_direction'), before, `${JSON.stringify(value)} must not have been stored`);
        }
    });

    it('refuses the WHOLE bulk save when one key is invalid (no partial write)', async () => {
        await asAdmin(request(app).put('/api/v1/settings')).send({ WPLANG: 'es_ES', site_text_direction: 'ltr', blogname: 'Before' });
        const res = await asAdmin(request(app).put('/api/v1/settings'))
            .send({ blogname: 'After', WPLANG: 'ar', site_text_direction: 'sideways' });
        assert.strictEqual(res.status, 400);
        // Nothing in the payload may have landed — not the invalid key, and not its neighbours.
        assert.strictEqual(await optionValue('blogname'), 'Before');
        assert.strictEqual(await optionValue('WPLANG'), 'es_ES');
        assert.strictEqual(await optionValue('site_text_direction'), 'ltr');
    });

    it('still refuses an anonymous or non-admin write of either key', async () => {
        for (const key of ['WPLANG', 'site_text_direction']) {
            const res = await request(app).put(`/api/v1/settings/${key}`).send({ value: 'ltr' });
            assert.strictEqual(res.status, 401, `${key} must require authentication`);
        }
    });
});

describe('color-scheme reaches the compiled CSS', () => {
    it('is a real token in the manifest with a real consumer', () => {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
        const entry = manifest.tokens['--wjs-color-scheme'];
        assert.ok(entry, '--wjs-color-scheme must exist in backend/public/theme-tokens.json');
        assert.strictEqual(entry.declaredDefault, 'normal', 'the default must be a no-op for unaware themes');
        const consumer = (entry.consumers || []).find((c: any) => c.property === 'color-scheme');
        assert.ok(consumer, '--wjs-color-scheme must be CONSUMED by a color-scheme declaration, not just declared');
        assert.strictEqual(consumer.selector, 'html', 'color-scheme only affects the canvas/scrollbar from the ROOT element');
    });

    it('wordjs-ui.css actually ships that declaration', () => {
        const css = fs.readFileSync(UI_CSS, 'utf8');
        assert.match(css, /html\s*\{\s*color-scheme:\s*var\(--wjs-color-scheme\);\s*\}/,
            'the html rule consuming --wjs-color-scheme is what makes the token do anything');
    });

    it('a theme declaring it compiles to a :root custom property, with no diagnostics', () => {
        const themeDir = path.join(TMP_ROOT, 'themes', 'midnight');
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({
            name: 'Midnight', version: '1.0.0',
            tokens: { '--wjs-color-scheme': 'dark', '--wjs-bg-canvas': '#0b1020' },
        }));

        const { compileTheme } = require('../core/theme-compile');
        const res = compileTheme(themeDir, { slug: 'midnight', dryRun: true, manifestPath: MANIFEST });

        assert.deepStrictEqual(res.diagnostics, [], 'declaring color-scheme must not warn or error');
        assert.match(res.css, /--wjs-color-scheme:\s*dark;/);
    });

    it('reports a value the color-scheme grammar cannot accept', () => {
        // HONEST LIMIT, pinned here so nobody assumes more than the compiler gives: the CSS grammar
        // for `color-scheme` is `normal | [ light | dark | <custom-ident> ]+ && only?`, and
        // <custom-ident> matches ANY identifier. So a typo like "darc" or "dark-mode-please" is a
        // grammatically valid color-scheme and the compiler cannot flag it — only non-identifiers
        // (a colour, a length, a quoted string) are catchable. `#0b1020` is the realistic mistake:
        // reaching for the token expecting it to take a background colour.
        const themeDir = path.join(TMP_ROOT, 'themes', 'bogus');
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({
            name: 'Bogus', version: '1.0.0',
            tokens: { '--wjs-color-scheme': '#0b1020' },
        }));

        const { compileTheme } = require('../core/theme-compile');
        const res = compileTheme(themeDir, { slug: 'bogus', dryRun: true, manifestPath: MANIFEST });
        assert.ok(
            res.diagnostics.some((d: any) => d.code === 'TOKEN_VALUE_GRAMMAR'),
            'a value no consuming property accepts must be reported, not emitted silently'
        );
    });
});

describe('wordjs-ui.css is direction-agnostic where it matters', () => {
    // The framework stylesheet is the floor every theme stands on. Under dir="rtl" a physical
    // left/right in one of these load-bearing rules is not a cosmetic slip — the container padding,
    // the grid gutters, the quote bar and the start/end utility families define the page's geometry.
    const load_bearing: Array<[string, RegExp]> = [
        ['container padding/centering', /\.container, \.container-fluid,[\s\S]{0,120}padding-inline: 1rem; margin-inline: auto;/],
        ['row gutters', /\.row \{[^}]*margin-inline: calc\(-0\.5 \* var\(--_gx\)\);/],
        ['row child gutters', /\.row > \* \{[^}]*padding-inline: calc\(var\(--_gx\) \* 0\.5\);/],
        ['blockquote bar', /blockquote \{[\s\S]{0,200}border-inline-start: var\(--wjs-blockquote-border-width/],
        ['block-contract quote bar', /\.wp-block-quote--bar \{[\s\S]{0,120}border-inline-start:/],
        ['list indent', /ul, ol \{ margin: 0 0 1rem; padding-inline-start: 2rem; \}/],
    ];

    it('uses logical properties in the load-bearing rules', () => {
        const css = fs.readFileSync(UI_CSS, 'utf8');
        for (const [name, re] of load_bearing) {
            assert.match(css, re, `${name} must use logical properties so dir="rtl" mirrors it`);
        }
    });

    after(() => {
        // Single owner of the temp root — see the note in the settings describe above.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('implements the start/end utility families as start/end, not left/right', () => {
        const css = fs.readFileSync(UI_CSS, 'utf8');
        // These utilities are NAMED for the inline axis. Implemented as left/right they lie: in an
        // RTL document `.ms-3` ("margin start") has to put the space on the RIGHT.
        for (const decl of [
            '.ms-3{margin-inline-start:',
            '.me-3{margin-inline-end:',
            '.ps-3{padding-inline-start:',
            '.pe-3{padding-inline-end:',
            '.text-start{text-align:start!important}',
            '.text-end{text-align:end!important}',
            '.border-start{border-inline-start:',
            '.border-end{border-inline-end:',
            '.start-0{inset-inline-start:0!important}',
            '.end-0{inset-inline-end:0!important}',
        ]) {
            assert.ok(css.includes(decl), `expected ${decl} in wordjs-ui.css`);
        }

        // FLOAT is checked by intent, not by an exact byte string. `float` is the one property here
        // that carries a PHYSICAL fallback — `float: left; float: inline-start` — because a browser
        // without logical-float support would otherwise drop the declaration entirely and leave the
        // element unfloated. Demanding the exact minified string forbade that fallback, so the
        // assertion is: the logical value is present, and it comes LAST so it wins where supported.
        for (const [util, physical, logical] of [
            ['.float-start', 'left', 'inline-start'],
            ['.float-end', 'right', 'inline-end'],
        ]) {
            // `util + '{'`, not `util`: the name also appears in a COMMENT above these rules, and
            // slicing from there produced braces belonging to nothing. Third time this session a
            // comment has fooled a checker in this repo — always anchor on syntax, never on a name.
            const at = css.indexOf(util + '{');
            assert.ok(at !== -1, `${util} rule not found in wordjs-ui.css`);
            const body = css.slice(at, css.indexOf('}', at) + 1);
            assert.ok(body.includes(`float:${logical}`), `${util} must set float:${logical}`);
            assert.ok(
                body.lastIndexOf(`float:${logical}`) > body.lastIndexOf(`float:${physical}`),
                `${util}: the logical value must come after the ${physical} fallback, or the fallback wins`,
            );
        }
    });
});
