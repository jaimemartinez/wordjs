/**
 * Theme verifier — verifyTheme() against the REAL Stitch export shipped with herbario
 * (backend/themes/herbario/.design/stitch.json) and the REAL token manifest.
 *
 * Fixture-vs-producer: the theme under test is a copy of the installed herbario (its
 * compiled style.css, byte for byte) dropped into a throwaway themes dir, so the tests
 * exercise the values a browser would actually get instead of a hand-written stand-in.
 * Nothing here writes inside backend/themes.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { verifyTheme, normalizeColor } = require('../core/theme-verify');

// __dirname works from both src/tests and dist/tests — ../.. is backend either way.
const BACKEND_DIR = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(BACKEND_DIR, 'public', 'theme-tokens.json');
const HERBARIO_DIR = path.join(BACKEND_DIR, 'themes', 'herbario');
const DESIGN = JSON.parse(fs.readFileSync(path.join(HERBARIO_DIR, '.design', 'stitch.json'), 'utf8'));

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-verify-'));
const THEMES_DIR = path.join(TMP_ROOT, 'themes');
fs.mkdirSync(THEMES_DIR, { recursive: true });
after(() => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const clone = (v: any): any => JSON.parse(JSON.stringify(v));
const verify = (slug: string, design: any = DESIGN): any =>
    verifyTheme(slug, design, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH });

let counter = 0;

// Copy the installed herbario into the temp themes dir, optionally hand-editing its CSS
// or theme.json first — the way a theme author would.
function fixture(editCss?: (css: string) => string, editJson?: (json: any) => any): string {
    const slug = `herbario-${counter++}`;
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    const css = fs.readFileSync(path.join(HERBARIO_DIR, 'style.css'), 'utf8');
    fs.writeFileSync(path.join(dir, 'style.css'), editCss ? editCss(css) : css);
    const json = JSON.parse(fs.readFileSync(path.join(HERBARIO_DIR, 'theme.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(editJson ? editJson(json) : json, null, 2));
    return slug;
}

// Rewrite one declared token value in place (the token is always present in the block).
function setToken(css: string, name: string, value: string): string {
    const re = new RegExp(`(${name}\\s*:\\s*)[^;\\n]*`);
    assert.ok(re.test(css), `fixture precondition: ${name} is declared in herbario/style.css`);
    return css.replace(re, `$1${value}`);
}

// herbario leaves --wjs-outline to the seed derivation, so the shipped theme differs from
// the design there. Every "theme matches" case starts from that one correction.
const FAITHFUL = (css: string): string => setToken(css, '--wjs-outline', DESIGN.designTheme.namedColors.outline);

const find = (list: any[], token: string): any => list.find((e: any) => e.token === token);

describe('theme-verify — a theme that matches its design', () => {
    it('reports no mismatches', () => {
        const report = verify(fixture(FAITHFUL));
        assert.deepStrictEqual(report.mismatches, []);
        assert.strictEqual(report.ok, true);
        assert.ok(report.matches.length >= 25, `expected the whole mapping to be checked, got ${report.matches.length}`);
    });

    it('checks each namedColor against the token the brief maps it to', () => {
        const { matches } = verify(fixture(FAITHFUL));
        const named = DESIGN.designTheme.namedColors;
        assert.deepStrictEqual(find(matches, '--wjs-bg-canvas'),
            { token: '--wjs-bg-canvas', expected: named.background, actual: named.background, source: 'namedColors.background' });
        assert.deepStrictEqual(find(matches, '--wjs-color-primary'),
            { token: '--wjs-color-primary', expected: named.primary_container, actual: named.primary_container, source: 'namedColors.primary_container' });
        assert.deepStrictEqual(find(matches, '--wjs-color-link'),
            { token: '--wjs-color-link', expected: named.primary, actual: named.primary, source: 'namedColors.primary' });
        assert.deepStrictEqual(find(matches, '--wjs-card-border-color'),
            { token: '--wjs-card-border-color', expected: named.outline_variant, actual: named.outline_variant, source: 'namedColors.outline_variant' });
        assert.deepStrictEqual(find(matches, '--wjs-color-on-danger'),
            { token: '--wjs-color-on-danger', expected: named.on_error, actual: named.on_error, source: 'namedColors.on_error' });
    });

    it('takes the brand override over the resolved secondary container', () => {
        const { matches } = verify(fixture(FAITHFUL));
        const entry = find(matches, '--wjs-color-secondary');
        assert.strictEqual(entry.source, 'designTheme.overrideSecondaryColor');
        assert.strictEqual(entry.expected, DESIGN.designTheme.overrideSecondaryColor.toLowerCase());
    });

    it('compares fonts by family, not by stack: "Eb Garamond" satisfies \'EB Garamond\', Georgia, serif', () => {
        const { matches } = verify(fixture(FAITHFUL));
        assert.deepStrictEqual(find(matches, '--wjs-font-family-heading'),
            { token: '--wjs-font-family-heading', expected: 'eb garamond', actual: 'eb garamond', source: 'designTheme.headlineFontFamily' });
        assert.strictEqual(find(matches, '--wjs-font-family-base').expected, 'work sans');
    });

    it('maps ROUND_FOUR onto every radius token, pill included', () => {
        const { matches } = verify(fixture(FAITHFUL));
        for (const token of ['--wjs-radius', '--wjs-radius-md', '--wjs-radius-lg', '--wjs-radius-pill']) {
            assert.deepStrictEqual(find(matches, token),
                { token, expected: '4px', actual: '4px', source: 'designTheme.roundness=ROUND_FOUR' });
        }
    });

    // seeds.bg is checked against the RESOLVED paper, not the neutral the designer typed: Stitch runs
    // that input through its tonal system and its own screens paint namedColors.background, so a theme
    // that reproduces the design exactly carries the resolved value and must not be failed for it.
    it('checks the theme.json seeds against the resolved palette', () => {
        const { matches } = verify(fixture(FAITHFUL));
        assert.strictEqual(find(matches, 'seeds.primary').expected, DESIGN.designTheme.overridePrimaryColor.toLowerCase());
        assert.strictEqual(find(matches, 'seeds.bg').source, 'namedColors.background');
        assert.strictEqual(find(matches, 'seeds.bg').actual, DESIGN.designTheme.namedColors.background.toLowerCase());
    });

    it('accepts the bare designTheme as well as the whole stitch.json', () => {
        const slug = fixture(FAITHFUL);
        assert.deepStrictEqual(verify(slug, DESIGN.designTheme).matches, verify(slug, DESIGN).matches);
    });
});

describe('theme-verify — a hand-edited token', () => {
    it('is reported by name, with what was expected and what is there', () => {
        const slug = fixture((css: string) => setToken(FAITHFUL(css), '--wjs-color-primary', '#ff0000'));
        const report = verify(slug);
        assert.strictEqual(report.ok, false);
        assert.deepStrictEqual(report.mismatches, [{
            token: '--wjs-color-primary',
            expected: DESIGN.designTheme.namedColors.primary_container,
            actual: '#ff0000',
            source: 'namedColors.primary_container'
        }]);
        assert.strictEqual(find(report.matches, '--wjs-color-primary'), undefined);
    });

    it('is caught in the seeds too', () => {
        const slug = fixture(FAITHFUL, (json: any) => { json.seeds.secondary = '#000000'; return json; });
        const mismatch = find(verify(slug).mismatches, 'seeds.secondary');
        assert.strictEqual(mismatch.actual, '#000000');
        assert.strictEqual(mismatch.expected, DESIGN.designTheme.overrideSecondaryColor.toLowerCase());
    });

    it('is caught when the theme swaps the headline font family', () => {
        const slug = fixture((css: string) => setToken(FAITHFUL(css), '--wjs-font-family-heading', 'Georgia, serif'));
        assert.deepStrictEqual(find(verify(slug).mismatches, '--wjs-font-family-heading'), {
            token: '--wjs-font-family-heading', expected: 'eb garamond', actual: 'georgia', source: 'designTheme.headlineFontFamily'
        });
    });

    it('is NOT raised for a spelling change: rgb() and uppercase hex are the same paint', () => {
        const slug = fixture((css: string) => setToken(FAITHFUL(css), '--wjs-color-primary', 'RGB(47, 93, 80)'));
        assert.deepStrictEqual(verify(slug).mismatches, []);
    });
});

describe('theme-verify — what the design does not say', () => {
    it('lists a token whose namedColor is absent as unmapped, not as a mismatch', () => {
        const design = clone(DESIGN);
        delete design.designTheme.namedColors.error;
        const report = verify(fixture(FAITHFUL), design);
        assert.deepStrictEqual(find(report.unmapped, '--wjs-color-danger'),
            { token: '--wjs-color-danger', source: 'namedColors.error', reason: 'design-missing' });
        assert.strictEqual(find(report.mismatches, '--wjs-color-danger'), undefined);
        assert.strictEqual(find(report.matches, '--wjs-color-danger'), undefined);
        // …and the rest of the palette is still verified.
        assert.deepStrictEqual(report.mismatches, []);
    });

    it('lists the spacing tokens as unmapped when the export only carries a scale factor', () => {
        const report = verify(fixture(FAITHFUL));
        for (const token of ['--wjs-xs', '--wjs-sm', '--wjs-md', '--wjs-lg', '--wjs-xl', '--wjs-2xl']) {
            assert.strictEqual(find(report.unmapped, token).reason, 'design-missing');
        }
        assert.ok(report.unmapped.some((u: any) => u.source === 'designTheme.spacingScale' && u.reason === 'no-rule'));
    });

    it('lists design colors no token consumes, and does not count the mapped ones', () => {
        const spare = verify(fixture(FAITHFUL)).unmapped
            .filter((u: any) => u.reason === 'no-token').map((u: any) => u.source);
        assert.ok(spare.includes('namedColors.tertiary'));
        // Outranked by overrideSecondaryColor, but part of the mapping all the same.
        assert.ok(!spare.includes('namedColors.secondary_container'));
        assert.ok(!spare.includes('namedColors.on_surface'));
    });

    it('refuses to invent a size for an unknown roundness', () => {
        const design = clone(DESIGN);
        design.designTheme.roundness = 'ROUND_SEVENTEEN';
        const report = verify(fixture(FAITHFUL), design);
        assert.strictEqual(find(report.unmapped, '--wjs-radius-pill').reason, 'no-rule');
        assert.deepStrictEqual(report.mismatches, []);
    });
});

describe('theme-verify — resolution', () => {
    it('follows the framework alias: --wjs-color-heading defaults to --wjs-color-text-main', () => {
        const slug = `alias-${counter++}`;
        fs.mkdirSync(path.join(THEMES_DIR, slug), { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, slug, 'style.css'),
            `:root { --wjs-color-text-main: ${DESIGN.designTheme.namedColors.on_surface}; }`);
        const { matches, mismatches } = verify(slug);
        assert.ok(find(matches, '--wjs-color-heading'), 'heading inherits text-main through the manifest default');
        assert.strictEqual(find(mismatches, '--wjs-color-heading'), undefined);
    });

    it('takes the last :root declaration, like the cascade', () => {
        const slug = fixture((css: string) => `${FAITHFUL(css)}\n:root { --wjs-color-danger: #00ff00; }\n`);
        assert.strictEqual(find(verify(slug).mismatches, '--wjs-color-danger').actual, '#00ff00');
    });

    it('reports a token nothing declares as a mismatch with no actual value', () => {
        const emptyManifest = path.join(TMP_ROOT, 'empty-manifest.json');
        fs.writeFileSync(emptyManifest, JSON.stringify({ version: 1, tokens: {} }));
        const slug = `bare-${counter++}`;
        fs.mkdirSync(path.join(THEMES_DIR, slug), { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, slug, 'style.css'), 'body { color: red }');
        const report = verifyTheme(slug, DESIGN, { themesDir: THEMES_DIR, manifestPath: emptyManifest });
        assert.strictEqual(find(report.mismatches, '--wjs-bg-canvas').actual, null);
        assert.deepStrictEqual(report.matches, []);
    });

    it('switches the canvas source in DARK mode', () => {
        const design = clone(DESIGN);
        design.designTheme.colorMode = 'DARK';
        design.designTheme.namedColors.surface = '#101010';
        const mismatch = find(verify(fixture(FAITHFUL), design).mismatches, '--wjs-bg-canvas');
        assert.deepStrictEqual(mismatch, {
            token: '--wjs-bg-canvas', expected: '#101010',
            actual: DESIGN.designTheme.namedColors.background, source: 'namedColors.surface'
        });
    });

    it('normalizes hex shorthand, case and rgb()/rgba() to one canonical form', () => {
        assert.strictEqual(normalizeColor('#ABC'), '#aabbcc');
        assert.strictEqual(normalizeColor(' #2F5D50 '), '#2f5d50');
        assert.strictEqual(normalizeColor('#2f5d50ff'), '#2f5d50');
        assert.strictEqual(normalizeColor('rgb(47, 93, 80)'), '#2f5d50');
        assert.strictEqual(normalizeColor('rgba(47 93 80 / 100%)'), '#2f5d50');
        assert.strictEqual(normalizeColor('rgba(47,93,80,0.5)'), '#2f5d5080');
        assert.strictEqual(normalizeColor('currentColor'), 'currentcolor');
    });
});

describe('theme-verify — nothing to verify fails closed', () => {
    it('throws instead of returning a clean report', () => {
        assert.throws(() => verify('../escape'), /Invalid theme slug/);
        assert.throws(() => verify('no-such-theme'), /style\.css/);
        assert.throws(() => verifyTheme('herbario', 'not-a-design' as any, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH }), /not an object/);
        assert.throws(
            () => verifyTheme(fixture(), DESIGN, { themesDir: THEMES_DIR, manifestPath: path.join(TMP_ROOT, 'missing.json') }),
            /Token manifest/
        );
    });
});
