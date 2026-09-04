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

const { deriveTokens, ARCHETYPE_NAMES, lum, onColor } = require('../core/theme-derive');
// The require.main guard in the generator makes this side-effect free (no marketplace writes).
const generator = require(path.join(__dirname, '..', '..', '..', 'scripts', 'create-40-themes.js'));

interface Seeds { primary: string; secondary: string; bg: string; text: string }

// ---------------------------------------------------------------------------------------------
// The population the "no theme reaches the network" invariants run over.
//
// They used to enumerate marketplace/themes and nothing else. That directory is gone, and the
// tempting repairs — skip when it is missing, or just iterate whatever readdir returns — would let
// both tests report PASS while examining zero themes. A vacuous green is the failure mode this repo
// hunts, so the population is (a) widened to every theme actually shipped, wherever it lives, and
// (b) asserted non-empty at the point of use, with a message that says why.
//
// A privately installed client theme is not ours to police and is excluded on purpose. The skip
// list is READ from .gitignore — the one file where those private paths are legitimately named —
// instead of being hardcoded here, so this suite names no client and cannot drift out of sync with
// what is actually kept out of the tree.
// ---------------------------------------------------------------------------------------------
const CATALOG_DIR = path.join(__dirname, '..', '..', '..', 'marketplace', 'themes');

function gitignoredThemeSlugs(): string[] {
    const file = path.join(__dirname, '..', '..', '..', '.gitignore');
    if (!fs.existsSync(file)) return [];
    const out: string[] = [];
    for (const line of String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)) {
        const m = /^backend\/themes\/([A-Za-z0-9._-]+)\/?$/.exec(line.trim());
        if (m) out.push(m[1]);
    }
    return out;
}

const THEME_ROOTS: Array<{ label: string; dir: string; skip: string[] }> = [
    { label: 'backend/themes', dir: path.join(__dirname, '..', '..', 'themes'), skip: gitignoredThemeSlugs() },
    { label: 'marketplace/themes', dir: CATALOG_DIR, skip: [] }
];

function shippedThemes(): Array<{ id: string; dir: string }> {
    const out: Array<{ id: string; dir: string }> = [];
    for (const root of THEME_ROOTS) {
        if (!fs.existsSync(root.dir)) continue;
        for (const slug of fs.readdirSync(root.dir).sort()) {
            if (root.skip.includes(slug)) continue;
            const dir = path.join(root.dir, slug);
            if (!fs.statSync(dir).isDirectory()) continue;
            if (!fs.existsSync(path.join(dir, 'theme.json'))) continue;   // a directory, but not a theme
            out.push({ id: `${root.label}/${slug}`, dir });
        }
    }
    return out;
}

// Never call shippedThemes() directly from a test: an empty list must be a loud failure, not a
// silent pass over nothing.
function themesToCheck(): Array<{ id: string; dir: string }> {
    const themes = shippedThemes();
    assert.ok(themes.length > 0,
        `no theme found under ${THEME_ROOTS.map((r) => r.label).join(' or ')} — this invariant cannot be checked against ` +
        'anything, so it would pass VACUOUSLY. Failing loudly instead: restore a theme, or retire the invariant on purpose.');
    return themes;
}

// Every @import the hand-written section of a style.css declares, as written.
function importTargets(css: string): string[] {
    const out: string[] = [];
    const re = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) out.push(m[1]);
    return out;
}

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

// The archetype is a LABEL now. It used to be a CSS generator, and this block used to assert that
// every preset interpolated the seeds and reached no network. Those presets are gone with the legacy
// theme model (nothing rendered their .theme-* classes, and their body/h1,h2,h3 rules duplicated what
// wordjs-ui.css already derives from the tokens), so what is left to pin is the only part still
// load-bearing: the NAME LIST that theme-compile validates against and the CLI offers for --archetype.
describe('ARCHETYPE_NAMES — the label set', () => {
    it('is the six names the compiler and the CLI accept', () => {
        assert.deepStrictEqual([...ARCHETYPE_NAMES].sort(),
            ['brutalist', 'cyber', 'editorial', 'glassmorphism', 'obsidian', 'organic']);
    });

    it('no longer exports a CSS generator — the label must not be able to emit styling again', () => {
        const core = require('../core/theme-derive');
        assert.strictEqual(typeof core.archetypeCss, 'undefined',
            'archetypeCss is retired: re-exporting it would put 526 lines of unrendered CSS one require() away');
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

        // Not "one theme per archetype out of the catalogue" any more — EVERY theme on disk, so the
        // rule keeps biting after the catalogue was deleted. What each must satisfy is unchanged:
        // its faces come from files it ships, and the compiled block never imports anything.
        for (const { id, dir } of themesToCheck()) {
            const cssPath = path.join(dir, 'style.css');
            assert.ok(fs.existsSync(cssPath), `${id}: ships a theme.json but no style.css`);
            const css = fs.readFileSync(cssPath, 'utf8');
            const start = css.indexOf('/* @wjs-generated:start');
            const end = css.indexOf('/* @wjs-generated:end */');

            // A theme whose theme.json carries tokens is compiled, so it must carry the block those
            // tokens compile into; a hand-written theme legitimately has none.
            const tokens = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')).tokens || {};
            if (Object.keys(tokens).length > 0) {
                assert.ok(start !== -1 && end > start, `${id}: theme.json declares tokens but style.css has no @wjs-generated block`);
            }
            const manual = start === -1 ? css : css.slice(0, start) + css.slice(end === -1 ? css.length : end);
            if (start !== -1 && end > start) {
                assert.ok(!css.slice(start, end).includes('@import'), `${id}: compiled block must never contain @import`);
            }

            // Every face is served from this repo: no remote origin anywhere, every @import points at
            // a file the theme actually ships, and a vendored fonts.css is imported rather than dead.
            assert.ok(!/https?:\/\//.test(css), `${id}: style.css still reaches an external origin`);
            const imports = importTargets(manual);
            for (const target of imports) {
                assert.ok(!/^(https?:)?\/\//.test(target), `${id}: style.css imports the network (${target})`);
                assert.ok(fs.existsSync(path.join(dir, target)), `${id}: imports ${target} but does not ship it`);
            }
            if (fs.existsSync(path.join(dir, 'fonts.css'))) {
                assert.ok(imports.includes('fonts.css'), `${id}: ships fonts.css but never imports it — its faces would not load`);
            }

            // SELF-HOSTING, asserted unconditionally rather than only when a fonts.css happens to
            // exist. Gating it on that file made the check vacuous in the one case it exists for: a
            // theme that NAMES a webfont family and ships no faces at all passed, and the browser
            // silently fell back to a system face. "Ships no fonts.css" is the failure, not the excuse.
            const allCss = fs.readdirSync(dir).filter((f: string) => f.endsWith('.css'))
                .map((f: string) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
            const declared = new Set<string>();
            for (const m of allCss.matchAll(/@font-face\s*\{[^}]*?font-family:\s*(['"]?)([^;'"}]+)\1/gi)) {
                declared.add(m[2].trim().toLowerCase());
            }
            // Generic families the browser always has; a stack made only of these needs no @font-face.
            const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
                'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset',
                '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue',
                'arial', 'georgia', 'times new roman', 'courier new', 'emoji', 'math', 'fangsong']);
            for (const m of allCss.matchAll(/(?:^|[;{])\s*font-family:\s*([^;}]+)/gi)) {
                const value = m[1];
                // A var() reference resolves to a token whose value is checked on its own line if it
                // is concrete; nothing here can resolve it, so it is skipped rather than guessed at.
                if (/var\s*\(/i.test(value)) continue;
                for (const raw of value.split(',')) {
                    const family = raw.replace(/!important/i, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
                    if (!family || GENERIC.has(family)) continue;
                    assert.ok(declared.has(family),
                        `${id}: names the font family "${family}" but ships no @font-face for it — it is not self-hosted, it is a silent fallback`);
                }
            }
        }

        // The catalogue's archetype-coverage promise used to be checked here behind
        // `if (fs.existsSync(CATALOG_DIR))`. marketplace/themes was deleted on purpose, so that branch
        // stopped running the day it was written — a silently dead assertion, which this suite treats
        // as worse than a deleted one (it reads as coverage and is none).
        //
        // It is not deleted, it is RE-AIMED at the subject that still exists. "The catalogue covers
        // every archetype" was never a fact about a directory: the catalogue IS the generator's theme
        // table, and the directory was only its rendering. Asserted against the table, the invariant
        // runs unconditionally on every CI run, with or without themes on disk — and it is the half
        // that can actually regress, because a new archetype added to ARCHETYPE_NAMES with no theme
        // using it is a name the compiler accepts and nothing exercises.
        const seen = new Set<string>();
        for (const entry of generator.themes) seen.add(entry.archetype);
        assert.ok(generator.themes.length > 0, 'the generator declares no themes — this would pass vacuously');
        assert.deepStrictEqual([...seen].sort(), [...ARCHETYPE_NAMES].sort(),
            'the theme catalogue no longer covers every archetype (or names one that does not exist)');
    });

    // Every theme, every stylesheet in it: this is the assertion that would have caught 43 of 64
    // themes shipping a live Google Fonts import for as long as they did.
    it('no shipped theme references an external origin', () => {
        const themes = themesToCheck();
        const offenders: string[] = [];
        let scanned = 0;
        for (const { id, dir } of themes) {
            for (const file of fs.readdirSync(dir)) {
                if (!file.endsWith('.css')) continue;
                scanned++;
                // PROTOCOL-RELATIVE COUNTS. `//fonts.googleapis.com/…` reaches the network exactly as
                // an https:// URL does — the browser just borrows the page's scheme — and the previous
                // pattern let it straight through, which made this guard weaker than its own title.
                const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/(?:https?:)?\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
                if (m) offenders.push(`${id}/${file} → ${m[0]}`);
            }
        }
        assert.ok(scanned > 0,
            `${themes.length} theme(s) enumerated but not one stylesheet among them was read — nothing was actually ` +
            'scanned, so a pass here would mean nothing.');
        assert.deepStrictEqual(offenders, [], `themes reaching the network:\n  ${offenders.join('\n  ')}`);
    });
});
