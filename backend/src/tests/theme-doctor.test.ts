/**
 * Theme doctor — analyzeTheme() against a fixture manifest + fixture themes.
 *
 * Pure fs checks (no DB, no router): opts.{themesDir,manifestPath} point every call at
 * throwaway temp dirs — the same test escape hatch installThemeFromDir exposes — so
 * nothing here touches backend/themes or the real backend/public/theme-tokens.json.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyzeTheme } = require('../core/theme-doctor');
// Real compiler on purpose (fixture-vs-producer): declarative fixtures are compiled with
// the same code the doctor consults, so the tests can never drift from the derivation.
const { compileTheme } = require('../core/theme-compile');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-doctor-'));
const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const MANIFEST_PATH = path.join(TMP_ROOT, 'theme-tokens.json');
// The layout schema is committed data (not generated), so the tests validate against the REAL
// file — copied into the temp root so the doctor still never reads backend/public directly.
const LAYOUT_SCHEMA_PATH = path.join(TMP_ROOT, 'theme-layouts.schema.json');

// Minimal but shape-faithful manifest (same layout as backend/public/theme-tokens.json).
const MANIFEST = {
    version: 1,
    source: 'backend/public/css/wordjs-ui.css',
    counts: { tokens: 8, varUses: 8, elements: 1 },
    tokens: {
        '--wjs-bg-canvas': { group: 'bg', declaredDefault: '#ffffff', fallbacks: [], consumers: [{ selector: 'body', property: 'background' }] },
        '--wjs-color-text-main': { group: 'color', declaredDefault: '#1f2937', fallbacks: [], consumers: [{ selector: 'body', property: 'color' }] },
        '--wjs-color-primary': { group: 'color', declaredDefault: '#3b82f6', fallbacks: [], consumers: [{ selector: '.wp-block-button', property: 'background' }] },
        '--wjs-color-on-primary': { group: 'color', declaredDefault: '#ffffff', fallbacks: [], consumers: [{ selector: '.wp-block-button', property: 'color' }] },
        '--wjs-color-secondary': { group: 'color', declaredDefault: '#6b7280', fallbacks: [], consumers: [{ selector: '.wp-block-badge', property: 'background' }] },
        '--wjs-color-on-secondary': { group: 'color', declaredDefault: '#ffffff', fallbacks: [], consumers: [{ selector: '.wp-block-badge', property: 'color' }] },
        '--wjs-h1': { group: 'h1', declaredDefault: '2.5rem', fallbacks: [], consumers: [{ selector: 'h1', property: 'font-size' }] },
        '--wjs-h1-size': { group: 'h1', declaredDefault: 'var(--wjs-h1)', fallbacks: [], consumers: [], flags: ['alias'] }
    },
    elements: { hero: { selector: '.wp-block-hero' } }
};

fs.mkdirSync(THEMES_DIR, { recursive: true });
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST, null, 2));
// __dirname works from both src/tests and dist/tests — ../../public is backend/public either way.
fs.copyFileSync(path.join(__dirname, '..', '..', 'public', 'theme-layouts.schema.json'), LAYOUT_SCHEMA_PATH);

let counter = 0;
function writeTheme(css: string, layout?: any, extra?: any): string {
    const slug = `fixture-${counter++}`;
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'style.css'), css);
    const meta: any = { name: slug, version: '1.0.0' };
    if (layout !== undefined) meta.layout = layout;
    if (extra !== undefined) Object.assign(meta, extra);
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(meta));
    return slug;
}

// Compile a fixture's declarative theme.json (dry run) with the fixture manifest.
const dryCompile = (slug: string) => compileTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true });

// Drop a chrome/<part>.json file (contract v1 composition) into a fixture theme.
function writeChrome(slug: string, part: string, content: string): void {
    const dir = path.join(THEMES_DIR, slug, 'chrome');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${part}.json`), content);
}

// A minimal composition that satisfies the chrome contract v1.
const VALID_CHROME = JSON.stringify({
    root: { props: {} },
    content: [
        { type: 'ChromeRow', props: { align: 'between', gap: 'md', items: [
            { type: 'ChromeLogo', props: { size: 'md' } },
            { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } }
        ] } },
        { type: 'ChromeText', props: { text: 'Hello' } }
    ]
});

// Declarative sections whose compiled :root tokens are exactly the clean token set.
const CLEAN_DECLARATIVE = {
    tokens: {
        '--wjs-color-primary': '#2563eb',
        '--wjs-color-on-primary': '#ffffff',
        '--wjs-bg-canvas': '#ffffff',
        '--wjs-color-text-main': '#1f2937'
    },
    styles: { hero: { 'text-align': 'center' } }
};

const doctor = (slug: string) => analyzeTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, layoutSchemaPath: LAYOUT_SCHEMA_PATH });

// Token set that produces zero warnings, so layout tests assert only their own findings.
const CLEAN_CSS = ':root { --wjs-color-primary: #2563eb; --wjs-color-on-primary: #ffffff; --wjs-bg-canvas: #ffffff; --wjs-color-text-main: #1f2937; }';

describe('analyzeTheme (theme doctor)', () => {
    after(() => {
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('fails open when the manifest is absent: { available: false }, no findings, no throw', () => {
        const slug = writeTheme(':root { --wjs-color-primary: #123456; }');
        const rep = analyzeTheme(slug, { themesDir: THEMES_DIR, manifestPath: path.join(TMP_ROOT, 'missing.json') });
        assert.deepStrictEqual(rep, { slug, available: false, errors: [], warnings: [], info: [] });
    });

    it('flags an unknown token and suggests the closest contract name', () => {
        const slug = writeTheme(':root { --wjs-color-primry: #123456; }');
        const rep = doctor(slug);
        assert.strictEqual(rep.available, true);
        assert.strictEqual(rep.errors.length, 0);
        const w = rep.warnings.find((f: any) => f.code === 'UNKNOWN_TOKEN');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.strictEqual(w.detail.suggestion, '--wjs-color-primary');
        assert.match(w.message, /--wjs-color-primary/);
    });

    it('flags an alias override and names the canonical token', () => {
        const slug = writeTheme(':root { --wjs-h1-size: 3rem; }');
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'ALIAS_OVERRIDE');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.strictEqual(w.detail.canonical, '--wjs-h1');
        // The alias must NOT also count as unknown — it IS in the manifest.
        assert.ok(!rep.warnings.some((f: any) => f.code === 'UNKNOWN_TOKEN'), JSON.stringify(rep.warnings));
    });

    it('flags a surface color missing its on-color, suggesting white/black by luminance', () => {
        // primary (dark, no pair) → warn + #ffffff; secondary (light, paired) → silent.
        const slug = writeTheme(':root { --wjs-color-primary: #111827; --wjs-color-secondary: #f9fafb; --wjs-color-on-secondary: #111111; }');
        const rep = doctor(slug);
        const missing = rep.warnings.filter((f: any) => f.code === 'MISSING_ON_COLOR');
        assert.strictEqual(missing.length, 1, JSON.stringify(rep.warnings));
        assert.match(missing[0].message, /--wjs-color-on-primary/);
        assert.strictEqual(missing[0].detail.suggested, '#ffffff');
    });

    it('flags editor-internal --wjs-r-* declarations', () => {
        const slug = writeTheme(':root { --wjs-r-align-mb: center; }');
        const rep = doctor(slug);
        assert.ok(rep.warnings.some((f: any) => f.code === 'EDITOR_INTERNAL'), JSON.stringify(rep.warnings));
    });

    it('warns on low approximate contrast between main text and background', () => {
        const slug = writeTheme(':root { --wjs-bg-canvas: #ffffff; --wjs-color-text-main: #dddddd; }');
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'LOW_CONTRAST');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.ok(w.detail.ratio < 3, JSON.stringify(w.detail));
    });

    it('warns on an external @import (and still parses the :root block after it)', () => {
        const slug = writeTheme('@import url("https://fonts.googleapis.com/css2?family=Inter");\n:root { --wjs-color-primary: #123456; --wjs-color-on-primary: #ffffff; }');
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'EXTERNAL_REF');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.detail.url, /^https:\/\/fonts\.googleapis\.com/);
        // The statement before :root must not break token detection (no bogus UNKNOWN_TOKEN,
        // no MISSING_ON_COLOR for the declared pair).
        assert.ok(!rep.warnings.some((f: any) => f.code === 'UNKNOWN_TOKEN' || f.code === 'MISSING_ON_COLOR'), JSON.stringify(rep.warnings));
    });

    it('marks :root values the sanitizer would reject as UNPORTABLE_VALUE (info)', () => {
        const slug = writeTheme(':root { --wjs-bg-canvas: url(bg.png); }');
        const rep = doctor(slug);
        const i = rep.info.find((f: any) => f.code === 'UNPORTABLE_VALUE');
        assert.ok(i, JSON.stringify(rep.info));
        assert.match(i.message, /--wjs-bg-canvas/);
    });

    it('always reports the !important census as info', () => {
        const slug = writeTheme(':root { --wjs-color-primary: #123456; --wjs-color-on-primary: #fff; }\nh1 { color: red !important; }');
        const rep = doctor(slug);
        const census = rep.info.find((f: any) => f.code === 'IMPORTANT_CENSUS');
        assert.ok(census, JSON.stringify(rep.info));
        assert.strictEqual(census.detail.count, 1);
    });

    it('reports a clean theme with zero errors and zero warnings', () => {
        const slug = writeTheme(':root { --wjs-color-primary: #2563eb; --wjs-color-on-primary: #ffffff; --wjs-bg-canvas: #ffffff; --wjs-color-text-main: #1f2937; }');
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        assert.strictEqual(rep.warnings.length, 0, JSON.stringify(rep.warnings));
    });

    it('accepts a fully-populated valid layout v2 block with zero warnings', () => {
        const slug = writeTheme(CLEAN_CSS, {
            header: { variant: 'centered', sticky: false, transparent: true },
            footer: { variant: 'columns', columns: 3 },
            sidebar: { position: 'left' },
            containerWidth: '72rem'
        });
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        assert.strictEqual(rep.warnings.length, 0, JSON.stringify(rep.warnings));
    });

    it('flags an unknown header variant as LAYOUT_INVALID_VALUE listing the allowed set', () => {
        const slug = writeTheme(CLEAN_CSS, { header: { variant: 'hero' } });
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        const w = rep.warnings.find((f: any) => f.code === 'LAYOUT_INVALID_VALUE');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.message, /layout\.header\.variant/);
        assert.match(w.message, /"classic", "centered", "minimal"/);
    });

    it('flags a typo layout key as LAYOUT_UNKNOWN_KEY with a suggestion', () => {
        const slug = writeTheme(CLEAN_CSS, { containerWidht: '60rem' });
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'LAYOUT_UNKNOWN_KEY');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.message, /layout\.containerWidht/);
        assert.strictEqual(w.detail.suggestion, 'containerWidth');
    });

    it('flags footer columns outside 1-4 as LAYOUT_INVALID_VALUE', () => {
        const slug = writeTheme(CLEAN_CSS, { footer: { variant: 'columns', columns: 7 } });
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'LAYOUT_INVALID_VALUE');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.message, /layout\.footer\.columns/);
        assert.deepStrictEqual(w.detail.allowed, [1, 2, 3, 4]);
    });

    it('accepts the legacy boolean sidebar form with zero warnings', () => {
        const slug = writeTheme(CLEAN_CSS, { sidebar: true });
        const rep = doctor(slug);
        assert.strictEqual(rep.warnings.length, 0, JSON.stringify(rep.warnings));
    });

    it('fails open on layout checks when the layout schema is absent (token checks intact)', () => {
        const slug = writeTheme(CLEAN_CSS, { header: { variant: 'hero' } });
        const rep = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            layoutSchemaPath: path.join(TMP_ROOT, 'missing-layout-schema.json')
        });
        assert.strictEqual(rep.available, true);
        assert.ok(!rep.warnings.some((f: any) => String(f.code).startsWith('LAYOUT_')), JSON.stringify(rep.warnings));
    });

    it('errors (only) when the theme does not exist', () => {
        const rep = doctor('definitely-not-installed');
        assert.strictEqual(rep.available, true);
        assert.ok(rep.errors.some((f: any) => f.code === 'THEME_NOT_FOUND'), JSON.stringify(rep.errors));
        assert.strictEqual(rep.warnings.length, 0);
    });

    it('accepts a valid declarative theme with an up-to-date generated block (0 errors, 0 warnings)', () => {
        const slug = writeTheme('', undefined, CLEAN_DECLARATIVE);
        fs.writeFileSync(path.join(THEMES_DIR, slug, 'style.css'), `${dryCompile(slug).css}\n`);
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        assert.strictEqual(rep.warnings.length, 0, JSON.stringify(rep.warnings));
        assert.ok(!rep.info.some((f: any) => f.code === 'GENERATED_DRIFT'), JSON.stringify(rep.info));
    });

    it('surfaces compiler diagnostics for invalid declarative sections as DECLARATIVE_* errors', () => {
        const slug = writeTheme(CLEAN_CSS, undefined, {
            tokens: { '--wjs-color-primry': '#123456' },
            styles: { hero: { colr: 'red' } }
        });
        const rep = doctor(slug);
        const tok = rep.errors.find((f: any) => f.code === 'DECLARATIVE_TOKEN_UNKNOWN');
        assert.ok(tok, JSON.stringify(rep.errors));
        assert.strictEqual(tok.detail.path, 'tokens.--wjs-color-primry');
        assert.strictEqual(tok.detail.suggestion, '--wjs-color-primary');
        const prop = rep.errors.find((f: any) => f.code === 'DECLARATIVE_PROPERTY_UNKNOWN');
        assert.ok(prop, JSON.stringify(rep.errors));
        assert.match(prop.message, /styles\.hero\.colr/);
    });

    it('warns STALE_GENERATED when declarative sections exist but style.css has no generated block', () => {
        const slug = writeTheme(CLEAN_CSS, undefined, { tokens: { '--wjs-color-primary': '#2563eb' } });
        const rep = doctor(slug);
        const w = rep.warnings.find((f: any) => f.code === 'STALE_GENERATED');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.message, new RegExp(`build theme ${slug}`));
        assert.ok(!rep.info.some((f: any) => f.code === 'GENERATED_DRIFT'), JSON.stringify(rep.info));
    });

    it('reports GENERATED_DRIFT (info) when the generated block no longer matches theme.json', () => {
        const slug = writeTheme('', undefined, CLEAN_DECLARATIVE);
        const dir = path.join(THEMES_DIR, slug);
        fs.writeFileSync(path.join(dir, 'style.css'), `${dryCompile(slug).css}\n`);
        // theme.json moves on; the block on disk is now one compile behind.
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
        meta.tokens['--wjs-color-primary'] = '#1d4ed8';
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(meta));
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        assert.ok(!rep.warnings.some((f: any) => f.code === 'STALE_GENERATED'), JSON.stringify(rep.warnings));
        const drift = rep.info.find((f: any) => f.code === 'GENERATED_DRIFT');
        assert.ok(drift, JSON.stringify(rep.info));
        assert.match(drift.message, /recompile/);
    });

    it('fails open when the compiler is absent: previous checks intact, no DECLARATIVE_* findings', () => {
        const slug = writeTheme(':root { --wjs-color-primry: #123456; }', undefined, {
            tokens: { '--wjs-color-primry': '#123456' }
        });
        const rep = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            layoutSchemaPath: LAYOUT_SCHEMA_PATH,
            compile: null // simulate require('./theme-compile') failing (e.g. css-tree missing)
        });
        assert.strictEqual(rep.available, true);
        const codes = [...rep.errors, ...rep.warnings, ...rep.info].map((f: any) => String(f.code));
        assert.ok(!codes.some((c: string) => c.startsWith('DECLARATIVE_')), JSON.stringify(codes));
        assert.ok(!codes.includes('GENERATED_DRIFT'), JSON.stringify(codes));
        // Pre-existing checks still ran…
        assert.ok(codes.includes('UNKNOWN_TOKEN'), JSON.stringify(codes));
        // …and STALE_GENERATED too: it is a pure fs check, independent of the compiler.
        assert.ok(codes.includes('STALE_GENERATED'), JSON.stringify(codes));
    });

    it('reports LEGACY_THEME (info) for a hand-authored theme.json with no generator and no declarative sections', () => {
        const slug = writeTheme(CLEAN_CSS); // writeTheme emits { name, version } only
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        assert.strictEqual(rep.warnings.length, 0, JSON.stringify(rep.warnings));
        const legacy = rep.info.find((f: any) => f.code === 'LEGACY_THEME');
        assert.ok(legacy, JSON.stringify(rep.info));
        assert.match(legacy.message, /declarative theme\.json/);
    });

    it('accepts a valid chrome/header.json with zero findings', () => {
        const slug = writeTheme(CLEAN_CSS);
        writeChrome(slug, 'header', VALID_CHROME);
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        const codes = [...rep.errors, ...rep.warnings].map((f: any) => String(f.code));
        assert.ok(!codes.some((c: string) => c.startsWith('CHROME_')), JSON.stringify(codes));
    });

    it('flags a contract-violating chrome/footer.json as CHROME_INVALID with the block path', () => {
        const slug = writeTheme(CLEAN_CSS);
        writeChrome(slug, 'footer', JSON.stringify({
            root: { props: {} },
            content: [
                { type: 'ChromeIframe', props: {} },
                { type: 'ChromeButton', props: { label: 'x', href: 'javascript:alert(1)', variant: 'primary' } }
            ]
        }));
        const rep = doctor(slug);
        const invalid = rep.errors.filter((f: any) => f.code === 'CHROME_INVALID');
        assert.strictEqual(invalid.length, 2, JSON.stringify(rep.errors));
        const unknown = invalid.find((f: any) => f.detail.rule === 'CHROME_UNKNOWN_TYPE');
        assert.ok(unknown, JSON.stringify(invalid));
        assert.strictEqual(unknown.detail.part, 'footer');
        assert.strictEqual(unknown.detail.path, 'content[0]');
        assert.match(unknown.message, /chrome\/footer\.json content\[0\]/);
        const href = invalid.find((f: any) => f.detail.rule === 'CHROME_UNSAFE_HREF');
        assert.ok(href, JSON.stringify(invalid));
        assert.strictEqual(href.detail.path, 'content[1].props.href');
        assert.ok(!rep.warnings.some((f: any) => f.code === 'CHROME_UNREADABLE'), JSON.stringify(rep.warnings));
    });

    it('warns CHROME_UNREADABLE (not error) when chrome/header.json is not valid JSON', () => {
        const slug = writeTheme(CLEAN_CSS);
        writeChrome(slug, 'header', '{ this is not json');
        const rep = doctor(slug);
        assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
        const w = rep.warnings.find((f: any) => f.code === 'CHROME_UNREADABLE');
        assert.ok(w, JSON.stringify(rep.warnings));
        assert.match(w.message, /chrome\/header\.json/);
    });

    it('fails open on chrome checks when chrome-validate is absent (other checks intact)', () => {
        const slug = writeTheme(':root { --wjs-color-primry: #123456; }');
        writeChrome(slug, 'header', JSON.stringify({ content: [{ type: 'ChromeIframe', props: {} }] }));
        const rep = analyzeTheme(slug, {
            themesDir: THEMES_DIR,
            manifestPath: MANIFEST_PATH,
            layoutSchemaPath: LAYOUT_SCHEMA_PATH,
            chromeValidate: null // simulate require('./chrome-validate') failing
        });
        assert.strictEqual(rep.available, true);
        const codes = [...rep.errors, ...rep.warnings].map((f: any) => String(f.code));
        assert.ok(!codes.some((c: string) => c.startsWith('CHROME_')), JSON.stringify(codes));
        assert.ok(codes.includes('UNKNOWN_TOKEN'), JSON.stringify(codes));
    });

    it('does not report LEGACY_THEME for declarative or generator-stamped themes', () => {
        // Declarative sections present → not legacy.
        const declarative = writeTheme('', undefined, CLEAN_DECLARATIVE);
        fs.writeFileSync(path.join(THEMES_DIR, declarative, 'style.css'), `${dryCompile(declarative).css}\n`);
        assert.ok(!doctor(declarative).info.some((f: any) => f.code === 'LEGACY_THEME'),
            JSON.stringify(doctor(declarative).info));
        // A generator stamp alone also counts as non-legacy (the hybrid catalog shape).
        const stamped = writeTheme(CLEAN_CSS, undefined, { generator: 'wordjs' });
        assert.ok(!doctor(stamped).info.some((f: any) => f.code === 'LEGACY_THEME'),
            JSON.stringify(doctor(stamped).info));
    });
});
