/**
 * Theme compiler — compileTheme()/writeCompiled() against a fixture manifest + fixture
 * themes in throwaway temp dirs (opts.{themesDir,manifestPath}, the same escape hatch the
 * doctor tests use), so nothing touches backend/themes or the real theme-tokens.json.
 *
 * The derive contract is stubbed via opts.derive for unit tests; the last test is the
 * integration pass against the REAL ../core/theme-derive and self-skips until it lands.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { compileTheme, writeCompiled } = require('../core/theme-compile');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-compile-'));
const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const MANIFEST_PATH = path.join(TMP_ROOT, 'theme-tokens.json');
const CAP_MANIFEST_PATH = path.join(TMP_ROOT, 'cap-manifest.json');

// Minimal but shape-faithful manifest (same layout as backend/public/theme-tokens.json).
const MANIFEST = {
    version: 1,
    source: 'backend/public/css/wordjs-ui.css',
    counts: { tokens: 4, varUses: 4, elements: 2 },
    tokens: {
        '--wjs-color-primary': { group: 'color', declaredDefault: '#3b82f6', fallbacks: [], consumers: [] },
        '--wjs-color-on-primary': { group: 'color', declaredDefault: '#ffffff', fallbacks: [], consumers: [] },
        '--wjs-hero-bg': { group: 'hero', declaredDefault: '#ffffff', fallbacks: [], consumers: [] },
        '--wjs-hero-button-background': { group: 'hero', declaredDefault: '#111827', fallbacks: [], consumers: [] }
    },
    elements: {
        hero: { selector: '.wp-block-hero', children: { button: { selector: '.wp-block-hero__button' } } },
        card: { selector: '.wp-block-card' }
    }
};

fs.mkdirSync(THEMES_DIR, { recursive: true });
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST, null, 2));

// Cap fixture: enough manifest tokens to legally reach 2001 declarations.
const capTokens: any = {};
for (let i = 0; i < 2100; i++) capTokens[`--wjs-cap-${i}`] = { group: 'cap', declaredDefault: '0', fallbacks: [], consumers: [] };
fs.writeFileSync(CAP_MANIFEST_PATH, JSON.stringify({ version: 1, source: 'fixture', counts: {}, tokens: capTokens, elements: {} }));

// theme-derive contract stub (deriveTokens / archetypeCss / ARCHETYPE_NAMES).
const STUB_DERIVE = {
    ARCHETYPE_NAMES: ['cyber', 'brutalist'],
    deriveTokens: (seeds: any) => ({ '--wjs-color-primary': seeds.primary, '--wjs-color-on-primary': '#ffffff' }),
    archetypeCss: (name: string) => `.wjs-archetype-${name} { letter-spacing: 0.05em }`
};

let counter = 0;
function writeTheme(themeJson: any): string {
    const slug = `fixture-${counter++}`;
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: slug, version: '1.0.0', generator: 'wordjs', ...themeJson }));
    return slug;
}

// dryRun by default: only the marker/idempotency tests exercise the write path.
const compile = (slug: string, extra: any = {}) =>
    compileTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true, ...extra });
const stylePath = (slug: string) => path.join(THEMES_DIR, slug, 'style.css');
const errsOf = (r: any, code: string) => r.diagnostics.filter((d: any) => d.level === 'error' && d.code === code);

describe('compileTheme (declarative theme compiler)', () => {
    after(() => {
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('fails open to a MANIFEST_MISSING error diagnostic when the manifest is absent', () => {
        const slug = writeTheme({ tokens: { '--wjs-color-primary': '#123456' } });
        const r = compile(slug, { manifestPath: path.join(TMP_ROOT, 'missing.json') });
        assert.strictEqual(r.css, '');
        assert.strictEqual(errsOf(r, 'MANIFEST_MISSING').length, 1, JSON.stringify(r.diagnostics));
    });

    it('expands seeds into :root via the derive contract', () => {
        const slug = writeTheme({ seeds: { primary: '#123456', secondary: '#654321', bg: '#ffffff', text: '#111111' } });
        const r = compile(slug, { derive: STUB_DERIVE });
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes(':root {'), r.css);
        assert.ok(r.css.includes('  --wjs-color-primary: #123456;'), r.css);
        assert.ok(r.css.includes('  --wjs-color-on-primary: #ffffff;'), r.css);
        assert.strictEqual(r.stats.tokens, 2);
    });

    it('rejects a malformed seed and never calls derive with it', () => {
        const slug = writeTheme({ seeds: { primary: 'red', secondary: '#654321', bg: '#ffffff', text: '#111111' } });
        let called = false;
        const r = compile(slug, { derive: { ...STUB_DERIVE, deriveTokens: () => { called = true; return {}; } } });
        assert.strictEqual(errsOf(r, 'SEED_INVALID').length, 1, JSON.stringify(r.diagnostics));
        assert.strictEqual(called, false);
    });

    it('emits the archetype CSS inside the block for a known archetype', () => {
        const slug = writeTheme({ archetype: 'cyber' });
        const r = compile(slug, { derive: STUB_DERIVE });
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes('.wjs-archetype-cyber'), r.css);
    });

    it('rejects an unknown archetype with a suggestion', () => {
        const slug = writeTheme({ archetype: 'cybr' });
        const r = compile(slug, { derive: STUB_DERIVE });
        const e = errsOf(r, 'ARCHETYPE_UNKNOWN');
        assert.strictEqual(e.length, 1, JSON.stringify(r.diagnostics));
        assert.strictEqual(e[0].suggestion, 'cyber');
        assert.ok(!r.css.includes('cybr'), r.css);
    });

    it('resolves the same style prop to a token when the manifest has it and to a declaration when not', () => {
        const slug = writeTheme({
            styles: { hero: { bg: '#fafafa', button: { background: '#0f172a', 'border-radius': '8px' } } }
        });
        const r = compile(slug);
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        // --wjs-hero-button-background exists → token in :root, NOT a rule declaration.
        assert.ok(r.css.includes('  --wjs-hero-button-background: #0f172a;'), r.css);
        assert.ok(!r.css.includes('.wp-block-hero__button { background'), r.css);
        // element-level candidate --wjs-hero-bg also resolves as a token.
        assert.ok(r.css.includes('  --wjs-hero-bg: #fafafa;'), r.css);
        // border-radius has no token candidate → declaration on the mapped child selector.
        assert.ok(r.css.includes('.wp-block-hero__button { border-radius: 8px }'), r.css);
    });

    it('always emits states and breakpoints as declarations (never tokens)', () => {
        const slug = writeTheme({
            styles: {
                hero: {
                    button: { hover: { background: '#000000' } },
                    mobile: { padding: '8px' }
                },
                card: { desktop: { padding: '24px' } },
                links: { hover: { 'text-decoration': 'underline' } }
            }
        });
        const r = compile(slug);
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        // background on hover stays a declaration even though the token exists for the base level.
        assert.ok(r.css.includes('.wp-block-hero__button:hover { background: #000000 }'), r.css);
        assert.ok(!r.css.includes('--wjs-hero-button-background'), r.css);
        assert.ok(r.css.includes('@media (max-width: 767.98px) {\n  .wp-block-hero { padding: 8px }\n}'), r.css);
        assert.ok(r.css.includes('@media (min-width: 1024px) {\n  .wp-block-card { padding: 24px }\n}'), r.css);
        assert.ok(r.css.includes('a:hover { text-decoration: underline }'), r.css);
    });

    it('accepts manifest tokens and the documented --wjs-footer-* bridge in the tokens map', () => {
        const slug = writeTheme({ tokens: { '--wjs-color-primary': '#2563eb', '--wjs-footer-bg': '#0b0b0b' } });
        const r = compile(slug);
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes('  --wjs-color-primary: #2563eb;'), r.css);
        assert.ok(r.css.includes('  --wjs-footer-bg: #0b0b0b;'), r.css);
    });

    it('rejects an unknown token name with a suggestion', () => {
        const slug = writeTheme({ tokens: { '--wjs-color-primry': '#ffffff' } });
        const r = compile(slug);
        const e = errsOf(r, 'TOKEN_UNKNOWN');
        assert.strictEqual(e.length, 1, JSON.stringify(r.diagnostics));
        assert.strictEqual(e[0].suggestion, '--wjs-color-primary');
        assert.ok(!r.css.includes('--wjs-color-primry'), r.css);
    });

    it('allows url() only for the theme\'s own /themes/<slug>/ assets', () => {
        const slug = writeTheme({ styles: { card: { 'background-image': `url(/themes/PLACEHOLDER/bg.png)` } } });
        // Rewrite with the real slug (writeTheme assigns it) so the positive case is exercised.
        fs.writeFileSync(
            path.join(THEMES_DIR, slug, 'theme.json'),
            JSON.stringify({ name: slug, generator: 'wordjs', styles: { card: { 'background-image': `url(/themes/${slug}/bg.png)` } } })
        );
        const r = compile(slug);
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes(`.wp-block-card { background-image: url(/themes/${slug}/bg.png) }`), r.css);
    });

    describe('injection and abuse payloads never reach the css', () => {
        it('breakout value "red;} body{...}" is rejected (VALUE_INVALID)', () => {
            const slug = writeTheme({ styles: { card: { background: 'red;} body{background:url(//evil)}' } } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'VALUE_INVALID').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes('evil'), r.css);
            assert.ok(!r.css.includes('background'), r.css);
        });

        it('protocol-relative url(//x) is rejected (URL_FORBIDDEN)', () => {
            const slug = writeTheme({ styles: { card: { 'background-image': 'url(//x)' } } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'URL_FORBIDDEN').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes('//x'), r.css);
        });

        it('url() into ANOTHER theme\'s dir is rejected (URL_FORBIDDEN)', () => {
            const slug = writeTheme({ styles: { card: { 'background-image': 'url(/themes/OTRO/x.png)' } } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'URL_FORBIDDEN').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes('OTRO'), r.css);
        });

        it('nonstandard property "behavior" is rejected (PROPERTY_UNKNOWN)', () => {
            const slug = writeTheme({ styles: { card: { behavior: 'url(x.htc)' } } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'PROPERTY_UNKNOWN').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes('behavior'), r.css);
            assert.ok(!r.css.includes('x.htc'), r.css);
        });

        it('unknown element "heroo" is rejected with suggestion "hero"', () => {
            const slug = writeTheme({ styles: { heroo: { padding: '8px' } } });
            const r = compile(slug);
            const e = errsOf(r, 'ELEMENT_UNKNOWN');
            assert.strictEqual(e.length, 1, JSON.stringify(r.diagnostics));
            assert.strictEqual(e[0].suggestion, 'hero');
            assert.ok(!r.css.includes('padding'), r.css);
        });

        it('a 400-char declaration value is rejected (VALUE_TOO_LONG)', () => {
            const long = '1px '.repeat(100); // 400 chars
            const slug = writeTheme({ styles: { card: { padding: long } } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'VALUE_TOO_LONG').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes('1px 1px'), r.css);
        });

        it('a token value with breakout chars is rejected (TOKEN_VALUE_INVALID)', () => {
            const slug = writeTheme({ tokens: { '--wjs-color-primary': 'red;}body{background:#000}' } });
            const r = compile(slug);
            assert.strictEqual(errsOf(r, 'TOKEN_VALUE_INVALID').length, 1, JSON.stringify(r.diagnostics));
            assert.ok(!r.css.includes(';}'), r.css);
            assert.ok(!r.css.includes('--wjs-color-primary'), r.css);
        });

        it('the 2001st declaration trips TOO_MANY_DECLARATIONS and is dropped', () => {
            const tokens: any = {};
            for (let i = 0; i < 2001; i++) tokens[`--wjs-cap-${i}`] = '1px';
            const slug = writeTheme({ tokens });
            const r = compileTheme(slug, { themesDir: THEMES_DIR, manifestPath: CAP_MANIFEST_PATH, dryRun: true });
            assert.strictEqual(errsOf(r, 'TOO_MANY_DECLARATIONS').length, 1, JSON.stringify(r.diagnostics.slice(0, 3)));
            assert.strictEqual(r.stats.tokens, 2000);
            assert.ok(r.css.includes('--wjs-cap-1999:'), 'first 2000 kept');
            assert.ok(!r.css.includes('--wjs-cap-2000:'), 'excess dropped');
        });
    });

    describe('markers, idempotency and dryRun', () => {
        it('writeCompiled replaces ONLY the marked block, preserving manual CSS byte for byte', () => {
            const slug = writeTheme({ tokens: { '--wjs-color-primary': '#111111' } });
            const r1 = compile(slug);
            const head = '/* hand-written head */\nbody { outline: none }\n';
            const tail = '\n/* hand-written tail */\n.custom { color: teal }\n';
            fs.writeFileSync(stylePath(slug), head + r1.css + tail);
            // Recompile with a different token value and write through the real path.
            fs.writeFileSync(
                path.join(THEMES_DIR, slug, 'theme.json'),
                JSON.stringify({ name: slug, generator: 'wordjs', tokens: { '--wjs-color-primary': '#222222' } })
            );
            const r2 = compile(slug, { dryRun: false });
            const out = fs.readFileSync(stylePath(slug), 'utf8');
            assert.strictEqual(out, head + r2.css + tail);
            assert.ok(out.includes('#222222') && !out.includes('#111111'), out);
        });

        it('prepends the block when style.css has no markers yet (direct writeCompiled)', () => {
            const slug = writeTheme({ tokens: { '--wjs-color-primary': '#123123' } });
            const manual = '/* manual */\nbody { margin: 0 }\n';
            fs.writeFileSync(stylePath(slug), manual);
            const r = compile(slug); // dryRun — write explicitly through writeCompiled
            writeCompiled(path.join(THEMES_DIR, slug), r.css);
            const out = fs.readFileSync(stylePath(slug), 'utf8');
            assert.strictEqual(out, `${r.css}\n\n${manual}`);
        });

        it('is idempotent: two compiles produce identical css and identical file bytes', () => {
            const slug = writeTheme({
                seeds: { primary: '#123456', secondary: '#654321', bg: '#ffffff', text: '#111111' },
                tokens: { '--wjs-color-primary': '#2563eb' },
                styles: { hero: { button: { 'border-radius': '8px', hover: { opacity: '0.9' } }, mobile: { padding: '8px' } } }
            });
            const r1 = compile(slug, { dryRun: false, derive: STUB_DERIVE });
            const bytes1 = fs.readFileSync(stylePath(slug), 'utf8');
            const r2 = compile(slug, { dryRun: false, derive: STUB_DERIVE });
            const bytes2 = fs.readFileSync(stylePath(slug), 'utf8');
            assert.strictEqual(r1.css, r2.css);
            assert.strictEqual(bytes1, bytes2);
            // The explicit tokens map wins over the seed-derived value for the same token.
            assert.ok(r1.css.includes('  --wjs-color-primary: #2563eb;'), r1.css);
        });

        it('dryRun never writes style.css', () => {
            const slug = writeTheme({ tokens: { '--wjs-color-primary': '#333333' } });
            const r = compile(slug); // dryRun: true
            assert.ok(r.css.includes('@wjs-generated:start'), r.css);
            assert.strictEqual(fs.existsSync(stylePath(slug)), false);
        });

        it('the block starts/ends with the exact markers and names the slug', () => {
            const slug = writeTheme({ tokens: { '--wjs-color-primary': '#444444' } });
            const r = compile(slug);
            const first = r.css.split('\n')[0];
            assert.ok(first.startsWith('/* @wjs-generated:start'), first);
            assert.ok(first.includes(`build theme ${slug}`), first);
            assert.ok(r.css.endsWith('/* @wjs-generated:end */'), r.css.slice(-60));
        });
    });

    // Runs against the REAL derive module once the parallel agent lands it; self-skips
    // (not fails) until then so this suite stays green in isolation.
    it('integration: seeds + archetype compile with the real theme-derive', (t: any) => {
        let real: any = null;
        try { real = require('../core/theme-derive'); } catch { /* not landed yet */ }
        if (!real || typeof real.deriveTokens !== 'function' || typeof real.archetypeCss !== 'function' || !Array.isArray(real.ARCHETYPE_NAMES) || real.ARCHETYPE_NAMES.length === 0) {
            t.skip('theme-derive not available yet');
            return;
        }
        const slug = writeTheme({
            seeds: { primary: '#0ea5e9', secondary: '#f97316', bg: '#0b1120', text: '#e2e8f0' },
            archetype: real.ARCHETYPE_NAMES[0]
        });
        const r = compile(slug); // no stub → compileTheme lazy-requires the real module
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes(':root {'), r.css.slice(0, 400));
        assert.ok(/--wjs-[a-z0-9_-]+: /.test(r.css), r.css.slice(0, 400));
    });
});
