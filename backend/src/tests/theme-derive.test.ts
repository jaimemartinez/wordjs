/**
 * Theme derive — byte-for-byte parity against the REAL generator.
 *
 * deriveTokens() is a port of canonicalAliases() in scripts/create-40-themes.js; per the
 * repo lesson (fixture-vs-producer trap) the suite requires the generator itself and
 * compares against what it derives at runtime — never against copied fixture values —
 * so parity breaks loudly if either side drifts.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { deriveTokens, archetypeCss, ARCHETYPE_NAMES, lum, onColor } = require('../core/theme-derive');
// The require.main guard in the generator makes this side-effect free (no marketplace writes).
const generator = require(path.join(__dirname, '..', '..', '..', 'scripts', 'create-40-themes.js'));

interface Seeds { primary: string; secondary: string; bg: string; text: string }

// deriveTokens takes seeds {primary,secondary,bg,text}; canonicalAliases takes the
// generator's palette-entry shape.
const toGeneratorShape = (s: Seeds) => ({ primaryColor: s.primary, secondaryColor: s.secondary, bgColor: s.bg, textColor: s.text });

// Pull the --wjs-* declarations out of the CSS canonicalAliases() emits, in document order.
function parseAliasTokens(css: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /(--wjs-[a-z-]+):\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) out[m[1]] = m[2].trim();
    return out;
}

// Varied on purpose: light and dark canvases, bg luminance straddling the generator's
// dark threshold (lum<0.35 → #565656=0.337 vs #5a5a5a=0.353), and seed colors straddling
// the onColor contrast limit (lum<0.55 → #8c8c8c=0.549 vs #8d8d8d=0.553).
const SEED_SETS: Array<[string, Seeds]> = [
    ['dark corporate (apex-enterprise palette)', { primary: '#6366f1', secondary: '#4f46e5', bg: '#0f172a', text: '#f8fafc' }],
    ['light saas', { primary: '#2563eb', secondary: '#1d4ed8', bg: '#ffffff', text: '#111827' }],
    ['bg just below the dark threshold (lum 0.337)', { primary: '#eab308', secondary: '#ca8a04', bg: '#565656', text: '#fef9c3' }],
    ['bg just above the dark threshold (lum 0.353)', { primary: '#9f1239', secondary: '#881337', bg: '#5a5a5a', text: '#0a0a0a' }],
    ['primary at the onColor limit, below (lum 0.549)', { primary: '#8c8c8c', secondary: '#8d8d8d', bg: '#fdf2f8', text: '#500724' }],
    ['secondary at the onColor limit, above (lum 0.553)', { primary: '#8d8d8d', secondary: '#8c8c8c', bg: '#000000', text: '#ffffff' }],
    ['monochrome extremes (monochrome-gallery palette)', { primary: '#ffffff', secondary: '#a1a1aa', bg: '#000000', text: '#ffffff' }],
    ['pastel organic light', { primary: '#f472b6', secondary: '#db2777', bg: '#fdf2f8', text: '#500724' }],
];

describe('deriveTokens — parity with generator canonicalAliases()', () => {
    for (const [label, seeds] of SEED_SETS) {
        it(`byte-identical names, values and order: ${label}`, () => {
            const derived = deriveTokens(seeds);
            const emitted = parseAliasTokens(generator.canonicalAliases(toGeneratorShape(seeds)));
            assert.ok(Object.keys(emitted).length > 0, 'generator emitted no --wjs-* tokens (parse broke?)');
            assert.deepStrictEqual(derived, emitted);
            // deepStrictEqual ignores key order; the emitted :root order is part of the contract.
            assert.deepStrictEqual(Object.keys(derived), Object.keys(emitted));
        });
    }

    it('is deterministic (same seeds → same bytes, same order)', () => {
        for (const [, seeds] of SEED_SETS) {
            assert.strictEqual(JSON.stringify(deriveTokens(seeds)), JSON.stringify(deriveTokens({ ...seeds })));
        }
    });

    it('covers every token canonicalAliases emits (17)', () => {
        const derived = deriveTokens(SEED_SETS[0][1]);
        assert.strictEqual(Object.keys(derived).length, 17);
        assert.ok(Object.keys(derived).every((k: string) => k.startsWith('--wjs-')));
    });
});

describe('lum / onColor — parity and limits', () => {
    it('lum matches the generator exactly (same floats)', () => {
        for (const hex of ['#000000', '#ffffff', '#565656', '#5a5a5a', '#8c8c8c', '#8d8d8d', '#eab308', '#0f172a']) {
            assert.strictEqual(lum(hex), generator.lum(hex));
        }
    });

    // onColor used to flip at a hand-picked luma of 0.55, which is a guess about where white stops
    // working. It now picks whichever candidate MEASURES better, which is the same one-line decision
    // taken on the number that governs readability — and it disagrees with the old threshold exactly
    // where the old threshold was wrong (mid-tone brand colours: white on #ec4899 is only 3.53:1).
    it('onColor picks the more readable candidate and matches the generator', () => {
        const relLum = (h: string) => {
            const c = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255)
                .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const ratio = (a: string, b: string) => {
            const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        assert.strictEqual(onColor('#000000'), '#ffffff');
        assert.strictEqual(onColor('#ffffff'), '#111111');
        // The case the threshold got wrong: hot pink takes dark text, not white.
        assert.strictEqual(onColor('#ec4899'), '#111111');
        assert.ok(ratio('#111111', '#ec4899') > ratio('#ffffff', '#ec4899'));

        for (const hex of ['#8c8c8c', '#8d8d8d', '#000000', '#ffffff', '#eab308', '#6366f1', '#ec4899', '#22c55e']) {
            assert.strictEqual(onColor(hex), generator.onColor(hex), `${hex}: derive and generator disagree`);
            // Whatever it returns must be the better of the two, by measurement.
            const other = onColor(hex) === '#ffffff' ? '#111111' : '#ffffff';
            assert.ok(ratio(onColor(hex), hex) >= ratio(other, hex), `${hex}: picked the less readable candidate`);
        }
    });

    // A link is TEXT on the page background, not a fill behind white letters. Deriving it as the raw
    // primary is how the catalogue ended up with link text at 1.72:1.
    it('derives a link colour that clears AA against the page, keeping primary when it already does', () => {
        // #818cf8 is 5.98:1 on this canvas, so it must survive untouched; #6366f1 would NOT (4.00:1),
        // which is the everyday case this derivation exists for.
        const dark = deriveTokens({ primary: '#818cf8', secondary: '#a5b4fc', bg: '#0f172a', text: '#f8fafc' });
        const light = deriveTokens({ primary: '#ff85a1', secondary: '#4cc9f0', bg: '#ffffff', text: '#141414' });
        const relLum = (h: string) => {
            const c = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255)
                .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const ratio = (a: string, b: string) => {
            const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        for (const t of [dark, light]) {
            assert.ok(ratio(t['--wjs-color-link'], t['--wjs-bg-canvas']) >= 4.5,
                `link ${t['--wjs-color-link']} on ${t['--wjs-bg-canvas']} is below AA`);
        }
        // #ff85a1 on white is 2.15:1, so it must have moved; a passing primary must not.
        assert.notStrictEqual(light['--wjs-color-link'], '#ff85a1');
        assert.strictEqual(dark['--wjs-color-link'], '#818cf8');
    });
});

describe('archetypeCss — presets without external imports', () => {
    it('exposes the same archetype set as the generator', () => {
        assert.deepStrictEqual([...ARCHETYPE_NAMES].sort(), Object.keys(generator.ARCHETYPES).sort());
        assert.strictEqual(ARCHETYPE_NAMES.length, 6);
    });

    it('every archetype renders the seeds and never reaches the network', () => {
        const seeds: Seeds = { primary: '#6366f1', secondary: '#4f46e5', bg: '#0f172a', text: '#f8fafc' };
        for (const name of ARCHETYPE_NAMES) {
            const css = archetypeCss(name, seeds);
            assert.ok(css.includes(seeds.primary), `${name}: primary seed missing`);
            assert.ok(css.includes(seeds.bg), `${name}: bg seed missing`);
            assert.ok(!css.includes('@import'), `${name}: @import must be stripped in core output`);
            assert.ok(!/url\s*\(/i.test(css), `${name}: no url() in core archetype CSS`);
            assert.ok(!/https?:/i.test(css), `${name}: no external URLs in core archetype CSS`);
        }
    });

    it('rejects unknown archetype names', () => {
        assert.throws(() => archetypeCss('vaporwave', { primary: '#000000', secondary: '#000000', bg: '#ffffff', text: '#000000' }), /Unknown archetype/);
    });

    // This test used to REQUIRE the remote @import to survive into every catalog theme ("font
    // vendoring is a separate program — the @import surviving here is the contract"). That program
    // has now run: all 64 catalog themes self-host their faces, so the contract is the opposite one
    // — no theme may reach the network, and each must import its OWN fonts.css instead. The
    // generator still emits the remote @import, because it is the SOURCE the vendoring script reads
    // to know which families a theme wants; what must never ship is a theme that still points at it.
    it('hybrid catalog: the generator names its fonts remotely, every shipped theme self-hosts them', () => {
        const t = { name: 'Fixture', primaryColor: '#6366f1', secondaryColor: '#4f46e5', bgColor: '#0f172a', textColor: '#f8fafc' };
        for (const key of Object.keys(generator.ARCHETYPES)) {
            assert.ok(generator.ARCHETYPES[key](t).includes("@import url('https://fonts.googleapis.com/"), `${key}: generator @import disappeared — vendoring would not know which families to fetch`);
        }

        const catalogDir = path.join(__dirname, '..', '..', '..', 'marketplace', 'themes');
        const seen = new Set<string>();
        for (const entry of generator.themes) {
            if (seen.has(entry.archetype)) continue;
            seen.add(entry.archetype);
            const dir = path.join(catalogDir, entry.slug);
            const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
            const start = css.indexOf('/* @wjs-generated:start');
            const end = css.indexOf('/* @wjs-generated:end */');
            assert.ok(start !== -1 && end > start, `${entry.slug}: catalog style.css has no @wjs-generated block`);
            const manual = css.slice(0, start);
            const block = css.slice(start, end);
            assert.ok(manual.includes("@import url('fonts.css')"), `${entry.slug}: manual section does not import its own fonts.css`);
            assert.ok(fs.existsSync(path.join(dir, 'fonts.css')), `${entry.slug}: imports fonts.css but does not ship it`);
            assert.ok(!/https?:\/\//.test(css), `${entry.slug}: style.css still reaches an external origin`);
            assert.ok(!block.includes('@import'), `${entry.slug}: compiled block must never contain @import`);
        }
        assert.strictEqual(seen.size, ARCHETYPE_NAMES.length, 'catalog no longer covers every archetype');
    });

    // The whole catalogue, not just one theme per archetype: this is the assertion that would have
    // caught 43 of 64 themes shipping a live Google Fonts import for as long as they did.
    it('no catalog theme references an external origin', () => {
        const catalogDir = path.join(__dirname, '..', '..', '..', 'marketplace', 'themes');
        const offenders: string[] = [];
        for (const slug of fs.readdirSync(catalogDir)) {
            for (const file of ['style.css', 'fonts.css']) {
                const p = path.join(catalogDir, slug, file);
                if (!fs.existsSync(p)) continue;
                const m = fs.readFileSync(p, 'utf8').match(/https?:\/\/[^\s'")]+/);
                if (m) offenders.push(`${slug}/${file} → ${m[0]}`);
            }
        }
        assert.deepStrictEqual(offenders, [], `themes reaching the network:\n  ${offenders.join('\n  ')}`);
    });
});
