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

    it('onColor flips at lum 0.55 and matches the generator at the boundary', () => {
        assert.strictEqual(onColor('#8c8c8c'), '#ffffff'); // lum 140/255 ≈ 0.549 < 0.55
        assert.strictEqual(onColor('#8d8d8d'), '#111111'); // lum 141/255 ≈ 0.553 ≥ 0.55
        assert.strictEqual(onColor('#000000'), '#ffffff');
        assert.strictEqual(onColor('#ffffff'), '#111111');
        for (const hex of ['#8c8c8c', '#8d8d8d', '#000000', '#ffffff', '#eab308', '#6366f1']) {
            assert.strictEqual(onColor(hex), generator.onColor(hex));
        }
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

    it('hybrid catalog: ARCHETYPES keep their @imports, manual CSS carries them, compiled blocks never do', () => {
        // (a) The generator's archetype CSS still declares its Google Fonts @imports —
        // they are the source the CLI extracts into the manual section of style.css.
        const t = { name: 'Fixture', primaryColor: '#6366f1', secondaryColor: '#4f46e5', bgColor: '#0f172a', textColor: '#f8fafc' };
        for (const key of Object.keys(generator.ARCHETYPES)) {
            assert.ok(generator.ARCHETYPES[key](t).includes("@import url('https://fonts.googleapis.com/"), `${key}: generator @import disappeared — the hybrid style.css would lose its fonts`);
        }

        // (b)+(c) One committed catalog theme per archetype: the @wjs-generated block
        // must not contain @import (core-compiled CSS never reaches the network); the
        // full style.css keeps it as manual CSS before the markers (spec-valid position).
        // Font vendoring is a separate program — the @import surviving here is the contract.
        const catalogDir = path.join(__dirname, '..', '..', '..', 'marketplace', 'themes');
        const seen = new Set<string>();
        for (const entry of generator.themes) {
            if (seen.has(entry.archetype)) continue;
            seen.add(entry.archetype);
            const css = fs.readFileSync(path.join(catalogDir, entry.slug, 'style.css'), 'utf8');
            const start = css.indexOf('/* @wjs-generated:start');
            const end = css.indexOf('/* @wjs-generated:end */');
            assert.ok(start !== -1 && end > start, `${entry.slug}: catalog style.css has no @wjs-generated block`);
            const manual = css.slice(0, start);
            const block = css.slice(start, end);
            assert.ok(manual.includes("@import url('https://fonts.googleapis.com/"), `${entry.slug}: manual section lost its Google Fonts @import`);
            assert.ok(!block.includes('@import'), `${entry.slug}: compiled block must never contain @import`);
        }
        assert.strictEqual(seen.size, ARCHETYPE_NAMES.length, 'catalog no longer covers every archetype');
    });
});
