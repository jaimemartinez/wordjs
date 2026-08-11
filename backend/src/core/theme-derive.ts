/**
 * WordJS - Theme Derive
 * Canonical palette derivation + archetype presets, promoted to core from the
 * marketplace generator (scripts/create-40-themes.js).
 *
 * PARITY CONTRACT: deriveTokens() must emit the exact token names and byte-identical
 * values that the generator's canonicalAliases() writes into style.css today — the
 * parity suite (tests/theme-derive.test.ts) compares both against the REAL generator,
 * so any drift here fails loudly. Dependency-free (no fs, no core subsystems): pure
 * string math the CLI/doctor/compiler can load without booting anything.
 */

interface ThemeSeeds {
  primary: string;
  secondary: string;
  bg: string;
  text: string;
}

// Ported verbatim from scripts/create-40-themes.js L12-16 — same numbers, same rounding,
// so derived values stay byte-identical to what the generator emits.
const hex2rgb = (h: string): number[] => { h = h.replace('#', ''); return [0, 2, 4].map((i: number) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v: number) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number): string => { const A = hex2rgb(a), B = hex2rgb(b); const [r, g, bl] = A.map((v: number, i: number) => v + (B[i] - v) * t); return rgb2hex(r, g, bl); };
const lum = (h: string): number => { const [r, g, b] = hex2rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

/**
 * Real WCAG relative luminance and contrast ratio. `lum` above is a plain luma kept byte-identical
 * to the generator's; these are for the places where the NUMBER has to be right, not merely
 * monotonic — near the middle of the range the two disagree enough to flip a decision.
 */
const relLum = (h: string): number => {
  const c = hex2rgb(h).map((v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x: number, y: number) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Text colour for a filled surface. It used to be a bare luma threshold at 0.55, which is a guess
 * about where white stops working — and on mid-tone brand colours the guess is wrong in both
 * directions (white on #ec4899 is 3.53:1, black on #22c55e is what you want but luma says white).
 * Picking whichever candidate has the higher measured ratio is the same one-line decision, made on
 * the number that actually governs readability.
 */
const onColor = (h: string): string => (contrast('#ffffff', h) >= contrast('#111111', h) ? '#ffffff' : '#111111');

/**
 * A link colour that can be read. The palette's `primary` is chosen as a FILL — the colour behind
 * white letters — and using it unchanged as the colour OF letters on the page background is how a
 * catalogue ends up with link text at 1.72:1. Walks the fill toward the page's own ink until it
 * clears AA, and stops there: the hue is kept, only the level moves, so the link still reads as the
 * brand colour. Returns `primary` untouched when it already passes, which is the common case.
 */
const readableOn = (colour: string, bg: string, min = 4.5): string => {
  if (contrast(colour, bg) >= min) return colour;
  const toward = relLum(bg) > 0.5 ? '#000000' : '#ffffff';
  for (let t = 0.08; t <= 0.92; t += 0.08) {
    const c = mix(colour, toward, t);
    if (contrast(c, bg) >= min) return c;
  }
  return toward === '#000000' ? '#111111' : '#ffffff';
};

/**
 * Full canonical --wjs-* palette from the four seeds. Mirrors canonicalAliases() in
 * the generator: same token set, same derivation, same insertion order as the emitted
 * :root block.
 */
function deriveTokens(seeds: ThemeSeeds): Record<string, string> {
  const dark = lum(seeds.bg) < 0.35;
  const toward = dark ? '#ffffff' : '#000000';
  return {
    '--wjs-bg-canvas': seeds.bg,
    '--wjs-bg-surface': mix(seeds.bg, toward, dark ? 0.06 : 0.03),
    '--wjs-bg-surface-raised': mix(seeds.bg, toward, dark ? 0.11 : 0.06),
    '--wjs-color-primary': seeds.primary,
    '--wjs-color-primary-dark': seeds.secondary,
    '--wjs-color-on-primary': onColor(seeds.primary),
    '--wjs-color-accent': seeds.secondary,
    '--wjs-color-on-accent': onColor(seeds.secondary),
    '--wjs-color-text-main': seeds.text,
    '--wjs-color-text-muted': mix(seeds.text, seeds.bg, 0.38),
    '--wjs-color-heading': seeds.text,
    '--wjs-color-link': readableOn(seeds.primary, seeds.bg),
    '--wjs-color-link-hover': readableOn(seeds.secondary, seeds.bg),
    '--wjs-border-subtle': mix(seeds.text, seeds.bg, 0.82),
    '--wjs-outline': mix(seeds.text, seeds.bg, 0.62),
    '--wjs-outline-variant': mix(seeds.text, seeds.bg, 0.85),
    '--wjs-focus-ring': seeds.primary,
  };
}

// Archetype presets ported from the generator's ARCHETYPES, minus every external
// @import: core-compiled CSS must never reach out to Google Fonts (offline installs,
// CSP). The imported families stay FIRST in each stack (they apply when locally
// installed) followed by system fallbacks equivalent in spirit; real font-file
// vendoring is a separate program.
/**
 * The archetype names a theme.json may declare.
 *
 * These used to be CSS GENERATORS: a 526-line map of six preset stylesheets (.theme-container,
 * .theme-hero, .theme-card-grid, .theme-card, .theme-badge, button.theme-btn, plus bare `body` and
 * `h1, h2, h3` rules) that the compiler appended to every theme. That model is retired — nothing in
 * the CMS renders those demo classes, and the element rules duplicated what wordjs-ui.css already
 * derives from the tokens. The compiler stopped emitting them, which left the generators reachable
 * only from their own tests.
 *
 * What survives is the only part still load-bearing: the NAME LIST. theme-compile validates a
 * declared archetype against it (ARCHETYPE_UNKNOWN) and the CLI offers it for --archetype, so an
 * unknown name is still an error rather than a silent typo. The label carries no styling and derives
 * no token — deriveTokens() reads the four seeds and nothing else.
 */
const ARCHETYPE_NAMES: string[] = ['cyber', 'brutalist', 'editorial', 'glassmorphism', 'organic', 'obsidian'];

// readableOn is exported because THREE places decide the link colour — this derivation, the Stitch
// importer and the verifier that compares them — and they have to agree or a theme is told it does
// not match the design it was built from.
// archetypeCss is GONE, not merely unexported: it returned the retired preset stylesheets, and
// leaving it callable would keep 526 lines of CSS that nothing renders one require() away.
module.exports = { deriveTokens, ARCHETYPE_NAMES, lum, onColor, contrast, readableOn };
