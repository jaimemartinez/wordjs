/**
 * Stitch import — the converter that replaces the by-hand Stitch → theme.json mapping.
 *
 * Driven by a REAL Stitch export payload (tests/fixtures/stitch-fixture.ts) that the suite
 * MATERIALISES itself into a throwaway .design/stitch.json: expectations are read back OUT of
 * that file (never copied as literals), so the suite fails if either the payload or the mapping
 * drifts — the fixture-vs-producer trap the repo has hit before.
 *
 * The payload used to be read out of an installed theme (backend/themes/herbario) at MODULE
 * SCOPE. When that theme was deleted the file threw while being imported and all 22 cases below
 * vanished from the run as a single failure. Hence two rules here: the fixture is self-contained
 * (no installed theme is required), and every read of it happens INSIDE a test case, so a missing
 * fixture is a loud failure per case instead of a silent disappearance.
 *
 * The contrast maths is re-implemented here on purpose. Hero legibility is the CLAIM this
 * converter makes, and a claim checked with the producer's own helper checks nothing.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { designToTheme, applyDesignToTheme } = require('../core/stitch-import');
const { compileTheme } = require('../core/theme-compile');
const { STITCH_DESIGN } = require('./fixtures/stitch-fixture');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(BACKEND_DIR, 'public', 'theme-tokens.json');

// Materialised lazily, on the first read from inside a test — nothing touches the disk while this
// module is being imported, so no failure here can ever cost the run a registered case.
let TMP_ROOT: string | null = null;
const fixturePath = (root: string): string => path.join(root, '.design', 'stitch.json');

function fixtureRoot(): string {
    if (TMP_ROOT !== null) return TMP_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-stitch-fixture-'));
    fs.mkdirSync(path.join(root, '.design'), { recursive: true });
    fs.writeFileSync(fixturePath(root), JSON.stringify(STITCH_DESIGN, null, 2) + '\n');
    TMP_ROOT = root;
    return root;
}

after(() => { if (TMP_ROOT) { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } } });

const readFixture = (): any => {
    const file = fixturePath(fixtureRoot());
    assert.ok(fs.existsSync(file), `the stitch fixture was not materialised at ${file} — this suite verifies nothing without it`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const OPTS = { slug: 'stitch-fixture', manifestPath: MANIFEST_PATH };

const clone = (v: any): any => JSON.parse(JSON.stringify(v));
const tmpDir = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wordjs-stitch-${tag}-`));

// WCAG 2.x contrast, written from the spec — independent of the module under test.
function ratio(a: string, b: string): number {
    const lum = (hex: string): number => {
        const ch = [1, 3, 5].map((i: number) => {
            const v = parseInt(hex.slice(i, i + 2), 16) / 255;
            return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const dropReason = (dropped: any[], token: string): string | null => {
    const hit = dropped.find((d: any) => d.token === token);
    return hit ? hit.reason : null;
};

describe('stitch-import — designToTheme', () => {
    it('maps the resolved Stitch palette onto the agreed tokens', () => {
        const FIXTURE = readFixture();
        const NAMED: Record<string, string> = FIXTURE.designTheme.namedColors;
        const { theme, dropped } = designToTheme(readFixture(), OPTS);

        // documentation/stitch-brief.md §1 — every pair read back from the fixture itself.
        const pairs: Array<[string, string]> = [
            ['--wjs-bg-canvas', 'background'],
            ['--wjs-bg-surface', 'surface_container_lowest'],
            ['--wjs-bg-muted', 'surface_container'],
            ['--wjs-color-text-main', 'on_surface'],
            ['--wjs-color-heading', 'on_surface'],
            ['--wjs-color-text-muted', 'on_surface_variant'],
            ['--wjs-color-primary', 'primary_container'],
            ['--wjs-color-primary-dark', 'primary'],
            ['--wjs-color-link', 'primary'],
            ['--wjs-color-on-primary', 'on_primary'],
            ['--wjs-color-secondary-dark', 'secondary'],
            ['--wjs-border-subtle', 'outline_variant'],
            ['--wjs-card-border-color', 'outline_variant'],
            ['--wjs-outline', 'outline'],
            ['--wjs-color-danger', 'error'],
            ['--wjs-color-on-danger', 'on_error']
        ];
        for (const [token, named] of pairs) {
            assert.strictEqual(theme.tokens[token], NAMED[named].toLowerCase(), `${token} must come from namedColors.${named}`);
        }
        // The explicit override outranks secondary_container for the secondary token.
        assert.strictEqual(theme.tokens['--wjs-color-secondary'], FIXTURE.designTheme.overrideSecondaryColor.toLowerCase());
        assert.deepStrictEqual(dropped, []);
    });

    it('seeds the palette from the overrides and the colour mode', () => {
        const FIXTURE = readFixture();
        const NAMED: Record<string, string> = FIXTURE.designTheme.namedColors;
        const { theme } = designToTheme(readFixture(), OPTS);
        assert.deepStrictEqual(theme.seeds, {
            primary: FIXTURE.designTheme.overridePrimaryColor.toLowerCase(),
            secondary: FIXTURE.designTheme.overrideSecondaryColor.toLowerCase(),
            bg: NAMED.background.toLowerCase(),      // LIGHT → background
            text: NAMED.on_surface.toLowerCase()
        });
        // DARK reads `surface` instead; namedColors already comes resolved for the mode.
        const darkDesign = clone(FIXTURE);
        darkDesign.designTheme.colorMode = 'DARK';
        darkDesign.designTheme.background = undefined;
        darkDesign.designTheme.namedColors.surface = '#101418';
        const dark = designToTheme(darkDesign, OPTS);
        assert.strictEqual(dark.theme.seeds.bg, '#101418');
    });

    it('accepts the API envelope and a bare designTheme alike', () => {
        const wrapped = designToTheme(readFixture(), OPTS);
        const bare = designToTheme(readFixture().designTheme, { ...OPTS, name: wrapped.theme.name });
        assert.deepStrictEqual(bare.theme, wrapped.theme);
    });

    it('turns the font enums into self-hostable stacks', () => {
        const { theme } = designToTheme(readFixture(), OPTS);
        // EB_GARAMOND → "EB Garamond" (Google's own casing, not Stitch's "Eb Garamond").
        assert.strictEqual(theme.tokens['--wjs-font-family-heading'], "'EB Garamond', Georgia, 'Times New Roman', serif");
        assert.strictEqual(theme.tokens['--wjs-font-family-base'], "'Work Sans', 'Segoe UI', system-ui, sans-serif");
        // No @import, no remote family: the doctor refuses external refs.
        for (const token of ['--wjs-font-family-heading', '--wjs-font-family-base']) {
            assert.ok(!/https?:|url\(|@import/.test(theme.tokens[token]), `${token} must not reach out to the network`);
        }
    });

    it('applies the roundness to every radius, pill included', () => {
        const radii = ['--wjs-radius', '--wjs-radius-sm', '--wjs-radius-md', '--wjs-radius-lg', '--wjs-radius-pill'];
        const FIXTURE = readFixture();
        const { theme } = designToTheme(readFixture(), OPTS);
        // ROUND_FOUR: crisp corners means the pill is 4px too, not 9999px.
        for (const token of radii) assert.strictEqual(theme.tokens[token], '4px', token);

        for (const [roundness, expected] of [['ROUND_EIGHT', '8px'], ['ROUND_TWELVE', '12px'], ['ROUND_FULL', '9999px']]) {
            const design = clone(FIXTURE);
            design.designTheme.roundness = roundness;
            const out = designToTheme(design, OPTS);
            for (const token of radii) assert.strictEqual(out.theme.tokens[token], expected, `${roundness} → ${token}`);
        }

        const bogus = clone(FIXTURE);
        bogus.designTheme.roundness = 'ROUND_SEVENTEEN';
        const out = designToTheme(bogus, OPTS);
        for (const token of radii) assert.strictEqual(out.theme.tokens[token], undefined, `${token} must not be invented`);
        assert.ok(out.notes.some((n: string) => n.includes('ROUND_SEVENTEEN')));
    });

    it('lays out the spacing ladder from spacingScale', () => {
        const steps = ['--wjs-xs', '--wjs-sm', '--wjs-md', '--wjs-lg', '--wjs-xl', '--wjs-2xl'];
        const FIXTURE = readFixture();
        const { theme } = designToTheme(readFixture(), OPTS);
        // Scale 2 is the framework's own rhythm (4/8/16/24px …).
        assert.deepStrictEqual(steps.map((t: string) => theme.tokens[t]), ['0.25rem', '0.5rem', '1rem', '1.5rem', '2.5rem', '4.5rem']);

        const ladders = [0, 1, 3, 4].map((scale: number) => {
            const design = clone(FIXTURE);
            design.designTheme.spacingScale = scale;
            const tokens = designToTheme(design, OPTS).theme.tokens;
            return steps.map((t: string) => parseFloat(tokens[t]));
        });
        for (const ladder of ladders) {
            assert.ok(ladder.every((v: number) => Number.isFinite(v) && v > 0), 'every step is a real length');
            for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] > ladder[i - 1], 'the ladder only goes up');
        }
        // Tighter scale → tighter rhythm, all the way through.
        for (let i = 0; i < steps.length; i++) assert.ok(ladders[0][i] < ladders[3][i]);

        const bogus = clone(FIXTURE);
        bogus.designTheme.spacingScale = 9;
        const out = designToTheme(bogus, OPTS);
        for (const token of steps) assert.strictEqual(out.theme.tokens[token], undefined, `${token} must not be invented`);
    });

    it('is deterministic byte for byte and leaves the input alone', () => {
        const input = readFixture();
        const before = JSON.stringify(input);
        const a = designToTheme(input, OPTS);
        const b = designToTheme(readFixture(), OPTS);
        assert.strictEqual(JSON.stringify(a.theme), JSON.stringify(b.theme), 'same input → identical bytes, key order included');
        assert.deepStrictEqual(a.notes, b.notes);
        assert.strictEqual(JSON.stringify(input), before, 'the design must not be mutated');
        // Key order of the theme object is fixed, not whatever V8 felt like.
        assert.deepStrictEqual(Object.keys(a.theme), ['name', 'version', 'description', 'author', 'generator', 'seeds', 'tokens']);
    });

    it('carries a layout only when one is actually supplied', () => {
        assert.strictEqual(designToTheme(readFixture(), OPTS).theme.layout, undefined);
        const withLayout = designToTheme(readFixture(), { ...OPTS, layout: { containerWidth: '1100px', sidebar: false } });
        assert.deepStrictEqual(withLayout.theme.layout, { containerWidth: '1100px', sidebar: false });
        assert.deepStrictEqual(Object.keys(withLayout.theme), ['name', 'version', 'description', 'author', 'generator', 'seeds', 'layout', 'tokens']);
    });
});

describe('stitch-import — nothing invented', () => {
    it('writes no token the manifest does not know', () => {
        const MANIFEST_TOKENS: Set<string> = new Set(Object.keys(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).tokens));
        assert.ok(MANIFEST_TOKENS.size > 0, `${MANIFEST_PATH} declares no tokens — this test would check nothing`);
        const full = designToTheme(readFixture(), OPTS);
        for (const token of Object.keys(full.theme.tokens)) {
            assert.ok(MANIFEST_TOKENS.has(token), `${token} is not in the contract manifest`);
        }

        // Same design, a manifest that only knows three tokens: everything else must be
        // reported as dropped instead of written.
        const dir = tmpDir('manifest');
        const stripped = path.join(dir, 'theme-tokens.json');
        const keep = ['--wjs-bg-canvas', '--wjs-color-primary', '--wjs-hero-color'];
        fs.writeFileSync(stripped, JSON.stringify({
            version: 1,
            tokens: Object.fromEntries(keep.map((t: string) => [t, { group: 'x', declaredDefault: null, fallbacks: [], consumers: [] }]))
        }));
        const out = designToTheme(readFixture(), { ...OPTS, manifestPath: stripped });
        assert.deepStrictEqual(Object.keys(out.theme.tokens).sort(), keep.slice().sort());
        assert.strictEqual(dropReason(out.dropped, '--wjs-hero-title-color'), 'not-in-manifest');
        assert.ok(out.dropped.length > 20, 'the rest of the mapping is reported, not silently lost');
        for (const d of out.dropped) assert.ok(!(d.token in out.theme.tokens));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('drops the heading tokens the contract has no room for', () => {
        const design = clone(readFixture());
        design.designTheme.typography = [
            { name: 'h1', fontSize: '3.5rem', letterSpacing: '-0.02em', lineHeight: '1.1' },
            { name: 'h4', fontSize: '1.5rem', letterSpacing: '0.02em' },   // --wjs-h4-tracking does not exist
            { name: 'h6', fontSize: '10 pixels' }                          // not a CSS length
        ];
        const { theme, dropped } = designToTheme(design, OPTS);
        assert.strictEqual(theme.tokens['--wjs-h1'], '3.5rem');
        assert.strictEqual(theme.tokens['--wjs-h1-tracking'], '-0.02em');
        assert.strictEqual(theme.tokens['--wjs-h1-leading'], '1.1');
        assert.strictEqual(theme.tokens['--wjs-h4'], '1.5rem');
        assert.strictEqual(theme.tokens['--wjs-h4-tracking'], undefined);
        assert.strictEqual(dropReason(dropped, '--wjs-h4-tracking'), 'not-in-manifest');
        assert.strictEqual(theme.tokens['--wjs-h6'], undefined);
        assert.strictEqual(dropReason(dropped, '--wjs-h6'), 'invalid-value');
    });

    it('refuses a malformed seed colour outright', () => {
        const NAMED: Record<string, string> = readFixture().designTheme.namedColors;
        for (const bad of ['#12345', 'rgb(47, 93, 80)', '2f5d50', '#2f5d5g', 42, null]) {
            const design = clone(readFixture());
            design.designTheme.overridePrimaryColor = bad;
            design.designTheme.customColor = bad;
            if (bad === null) {
                // null/absent is "the design said nothing" — it falls through to the palette.
                assert.strictEqual(designToTheme(design, OPTS).theme.seeds.primary, NAMED.primary_container.toLowerCase());
                continue;
            }
            assert.throws(() => designToTheme(design, OPTS), /is not a #rrggbb colour/, `${JSON.stringify(bad)} must be refused`);
        }
    });

    it('skips the tokens a malformed or missing namedColor feeds', () => {
        const NAMED: Record<string, string> = readFixture().designTheme.namedColors;
        const design = clone(readFixture());
        design.designTheme.namedColors.outline = 'rgb(113, 121, 117)';
        delete design.designTheme.namedColors.error;
        const { theme, dropped, notes } = designToTheme(design, OPTS);
        assert.strictEqual(theme.tokens['--wjs-outline'], undefined, 'a malformed colour is never repaired');
        assert.strictEqual(dropReason(dropped, '--wjs-outline'), 'invalid-color');
        assert.strictEqual(theme.tokens['--wjs-color-danger'], undefined);
        assert.strictEqual(dropReason(dropped, '--wjs-color-danger'), 'missing-color');
        assert.ok(notes.some((n: string) => n.includes('namedColors.outline')));
        // The rest of the palette is untouched by one bad entry.
        assert.strictEqual(theme.tokens['--wjs-bg-canvas'], NAMED.background.toLowerCase());
    });

    it('normalises hex input to the shape theme-compile accepts', () => {
        const design = clone(readFixture());
        design.designTheme.namedColors.background = '#FEF';
        design.designTheme.namedColors.on_surface = '#1D1C16';
        const { theme } = designToTheme(design, OPTS);
        assert.strictEqual(theme.tokens['--wjs-bg-canvas'], '#ffeeff');
        assert.strictEqual(theme.tokens['--wjs-color-text-main'], '#1d1c16');
        for (const value of Object.values(theme.seeds)) assert.match(value as string, /^#[0-9a-f]{6}$/);
    });
});

describe('stitch-import — the hero is readable', () => {
    const MIN = 4.5;

    it('puts the light-palette hero on the paper and keeps every word on it legible', () => {
        const NAMED: Record<string, string> = readFixture().designTheme.namedColors;
        const { theme } = designToTheme(readFixture(), OPTS);
        const bg = theme.tokens['--wjs-hero-bg'];
        assert.strictEqual(bg, NAMED.background.toLowerCase(), 'no hero band in the design → the hero is the page');
        assert.strictEqual(theme.tokens['--wjs-hero-gradient-from'], bg);
        assert.strictEqual(theme.tokens['--wjs-hero-gradient-to'], bg);

        for (const token of ['--wjs-hero-color', '--wjs-hero-title-color', '--wjs-hero-subtitle-color', '--wjs-hero-button-outline-color']) {
            const value = theme.tokens[token];
            assert.ok(value, `${token} must be emitted, not left to the framework default`);
            assert.ok(ratio(value, bg) >= MIN, `${token} ${value} reads ${ratio(value, bg).toFixed(2)}:1 on ${bg}`);
        }
        assert.strictEqual(theme.tokens['--wjs-hero-title-color'], NAMED.primary_container.toLowerCase());
        assert.strictEqual(theme.tokens['--wjs-hero-subtitle-color'], NAMED.on_surface_variant.toLowerCase());

        // The bug this exists for: the framework's own hero defaults are white-on-dark
        // (--wjs-hero-color → #fff, --wjs-hero-button-outline-color → #fff, the title
        // inheriting), which on this paper is invisible.
        assert.ok(ratio('#ffffff', bg) < MIN, 'the framework default would be unreadable here');
    });

    it('walks the fallback chain when the design colour cannot be read on the band', () => {
        const design = clone(readFixture());
        design.designTheme.namedColors.primary_container = '#f4efe4';       // barely off the paper
        design.designTheme.namedColors.on_surface_variant = '#efe9df';
        const { theme, notes } = designToTheme(design, OPTS);
        const bg = theme.tokens['--wjs-hero-bg'];
        assert.notStrictEqual(theme.tokens['--wjs-hero-title-color'], '#f4efe4');
        assert.ok(ratio(theme.tokens['--wjs-hero-title-color'], bg) >= MIN);
        assert.ok(ratio(theme.tokens['--wjs-hero-subtitle-color'], bg) >= MIN);
        assert.ok(notes.some((n: string) => n.startsWith('hero title:')), 'the substitution is reported');
    });

    it('stays legible on any palette, including one with no readable colour at all', () => {
        const design = clone(readFixture());
        // Every text-ish colour collapsed onto a mid grey where neither black nor white is
        // comfortable: the chain must still terminate above 4.5:1.
        for (const key of Object.keys(design.designTheme.namedColors)) design.designTheme.namedColors[key] = '#777777';
        design.designTheme.namedColors.background = '#777777';
        const { theme } = designToTheme(design, OPTS);
        const bg = theme.tokens['--wjs-hero-bg'];
        for (const token of ['--wjs-hero-color', '--wjs-hero-title-color', '--wjs-hero-subtitle-color']) {
            assert.ok(ratio(theme.tokens[token], bg) >= MIN, `${token} on ${bg}`);
        }
    });

    it('honours a hero band the design does declare', () => {
        const design = clone(readFixture());
        design.designTheme.hero = { background: '#12211C' };
        const { theme } = designToTheme(design, OPTS);
        assert.strictEqual(theme.tokens['--wjs-hero-bg'], '#12211c');
        assert.strictEqual(theme.tokens['--wjs-hero-gradient-from'], '#12211c');
        for (const token of ['--wjs-hero-color', '--wjs-hero-title-color', '--wjs-hero-subtitle-color']) {
            assert.ok(ratio(theme.tokens[token], '#12211c') >= MIN, `${token} on the declared band`);
        }
    });
});

describe('stitch-import — applyDesignToTheme', () => {
    it('creates theme.json when the theme directory has none', () => {
        const root = tmpDir('create');
        const dir = path.join(root, 'nueva');
        const out = applyDesignToTheme(dir, readFixture(), { slug: 'nueva', manifestPath: MANIFEST_PATH });
        assert.strictEqual(out.created, true);
        assert.deepStrictEqual(out.preserved, []);
        const raw = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
        assert.ok(raw.endsWith('}\n'), 'trailing newline like every other generated file');
        assert.deepStrictEqual(JSON.parse(raw), out.theme);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('refreshes what the design owns and preserves everything the author wrote', () => {
        const NAMED: Record<string, string> = readFixture().designTheme.namedColors;
        const root = tmpDir('merge');
        const dir = path.join(root, 'stitch-fixture');
        fs.mkdirSync(dir, { recursive: true });
        const authored = {
            name: 'Stitch Fixture',
            version: '1.0.4',
            description: 'Botica herbal.',
            author: 'Someone Real',
            generator: 'wordjs',
            seeds: { primary: '#000000', secondary: '#000000', bg: '#ffffff', text: '#000000' },
            layout: { containerWidth: '1100px', sidebar: false, header: { variant: 'classic', sticky: true } },
            tokens: {
                '--wjs-color-primary': '#000000',            // the design owns this one
                '--wjs-color-link-hover': '#904c2f',         // hand-written, outside the mapping
                '--wjs-hero-title-size': '4.5rem',           // hand-written, outside the mapping
                '--wjs-line-height-base': '1.7'
            },
            styles: { hero: { 'min-height': '62vh', button: { 'text-transform': 'uppercase' } } },
            screenshot: 'screenshot.png'
        };
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(authored, null, 2) + '\n');

        const out = applyDesignToTheme(dir, readFixture(), { manifestPath: MANIFEST_PATH });
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
        assert.strictEqual(out.created, false);

        // Owned by the design → refreshed.
        assert.strictEqual(written.tokens['--wjs-color-primary'], NAMED.primary_container.toLowerCase());
        assert.deepStrictEqual(written.seeds, out.theme.seeds);
        assert.notDeepStrictEqual(written.seeds, authored.seeds);
        // Not owned → byte for byte what the author wrote.
        for (const token of ['--wjs-color-link-hover', '--wjs-hero-title-size', '--wjs-line-height-base']) {
            assert.strictEqual(written.tokens[token], (authored.tokens as any)[token], token);
            assert.ok(out.preserved.includes(token));
        }
        assert.deepStrictEqual(written.styles, authored.styles, 'styles are authorial');
        assert.deepStrictEqual(written.layout, authored.layout, 'layout is authorial');
        assert.strictEqual(written.screenshot, 'screenshot.png', 'unknown keys survive');
        assert.strictEqual(written.name, 'Stitch Fixture');
        assert.strictEqual(written.version, '1.0.4', 'the version is the author\'s to bump');
        assert.strictEqual(written.author, 'Someone Real');
        // Existing tokens keep their position; the new ones are appended.
        assert.deepStrictEqual(Object.keys(written.tokens).slice(0, 4), Object.keys(authored.tokens));

        // Re-running writes the same bytes: safe to wire into a build.
        const first = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
        applyDesignToTheme(dir, readFixture(), { manifestPath: MANIFEST_PATH });
        assert.strictEqual(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'), first, 'idempotent');
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('lets an explicit option override the metadata already on disk', () => {
        const root = tmpDir('meta');
        const dir = path.join(root, 'stitch-fixture');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: 'Old', version: '2.0.0', tokens: {} }, null, 2));
        const out = applyDesignToTheme(dir, readFixture(), { manifestPath: MANIFEST_PATH, name: 'Stitch Fixture', author: 'WordJS' });
        assert.strictEqual(out.theme.name, 'Stitch Fixture');
        assert.strictEqual(out.theme.author, 'WordJS');
        assert.strictEqual(out.theme.version, '2.0.0');
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('refuses a theme.json it cannot read rather than overwriting it', () => {
        const root = tmpDir('broken');
        const dir = path.join(root, 'stitch-fixture');
        fs.mkdirSync(dir, { recursive: true });
        const broken = '{ "tokens": { "--wjs-color-primary": "#000000" ';
        fs.writeFileSync(path.join(dir, 'theme.json'), broken);
        assert.throws(() => applyDesignToTheme(dir, readFixture(), { manifestPath: MANIFEST_PATH }), /is not valid JSON/);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'), broken, 'left exactly as it was');
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('stitch-import — the output is a theme the compiler accepts', () => {
    it('compiles with no diagnostics at all', () => {
        const root = tmpDir('compile');
        const dir = path.join(root, 'stitch-fixture');
        applyDesignToTheme(dir, readFixture(), { slug: 'stitch-fixture', manifestPath: MANIFEST_PATH });
        const result = compileTheme(dir, { slug: 'stitch-fixture', themesDir: root, manifestPath: MANIFEST_PATH, dryRun: true });
        assert.deepStrictEqual(result.diagnostics, [], 'the converter must not hand the compiler anything to complain about');
        assert.strictEqual(result.stats.errors, 0);
        assert.ok(result.stats.tokens > 40);
        // The hero tokens survive the compiler's own charset/grammar checks.
        assert.match(result.css, /--wjs-hero-title-color:\s*#2f5d50/);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
