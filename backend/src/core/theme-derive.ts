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
const ARCHETYPES: Record<string, (s: ThemeSeeds) => string> = {
  // 1. Cyber / Gaming / Tech RGB (Angled clip-paths, scanlines, neon glow)
  cyber: (s: ThemeSeeds) => `/* Archetype: Cyber */
:root {
    --cyber-primary: ${s.primary};
    --cyber-secondary: ${s.secondary};
    --cyber-bg: ${s.bg};
    --cyber-text: ${s.text};
}

body {
    background-color: var(--cyber-bg);
    color: var(--cyber-text);
    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, Menlo, monospace;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 30px 30px;
    margin: 0;
    line-height: 1.5;
}

h1, h2, h3, .brand {
    font-family: 'Chakra Petch', 'Bahnschrift', 'Trebuchet MS', 'Segoe UI', sans-serif;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--cyber-primary);
    text-shadow: 0 0 10px var(--cyber-primary);
}

.theme-container {
    max-width: 1300px;
    margin: 0 auto;
    padding: 2rem;
}

.theme-hero {
    background: rgba(0,0,0,0.8);
    border: 2px solid var(--cyber-primary);
    box-shadow: 0 0 20px var(--cyber-primary);
    clip-path: polygon(0 0, calc(100% - 30px) 0, 100% 30px, 100% 100%, 30px 100%, 0 calc(100% - 30px));
    padding: 4rem 2rem;
    text-align: center;
    margin-bottom: 3rem;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: #0d1117;
    border: 1px solid var(--cyber-secondary);
    clip-path: polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px);
    padding: 2rem;
    position: relative;
    transition: all 0.3s ease;
}

.theme-card:hover {
    border-color: var(--cyber-primary);
    box-shadow: 0 0 15px var(--cyber-primary);
    transform: translateY(-5px);
}

.theme-badge {
    background: var(--cyber-primary);
    color: #000;
    font-weight: bold;
    padding: 4px 10px;
    font-size: 0.75rem;
    display: inline-block;
    clip-path: polygon(5px 0, 100% 0, 95% 100%, 0 100%);
}

button.theme-btn {
    background: transparent;
    color: var(--cyber-primary);
    border: 2px solid var(--cyber-primary);
    padding: 12px 24px;
    font-family: 'Chakra Petch', 'Bahnschrift', 'Trebuchet MS', 'Segoe UI', sans-serif;
    font-weight: bold;
    cursor: pointer;
    clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
    transition: all 0.2s;
}

button.theme-btn:hover {
    background: var(--cyber-primary);
    color: #000;
    box-shadow: 0 0 15px var(--cyber-primary);
}
`,

  // 2. Brutalist / Neo-Brutalist (Hard black borders, stark offsets, mono fonts, zero border-radius)
  brutalist: (s: ThemeSeeds) => `/* Archetype: Brutalist */
:root {
    --brutal-primary: ${s.primary};
    --brutal-secondary: ${s.secondary};
    --brutal-bg: ${s.bg};
    --brutal-text: ${s.text};
}

body {
    background-color: var(--brutal-bg);
    color: var(--brutal-text);
    font-family: 'Public Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    margin: 0;
    padding: 0;
}

h1, h2, h3 {
    font-family: 'Space Grotesk', 'Arial Black', 'Segoe UI', Arial, sans-serif;
    font-size: 3rem;
    text-transform: uppercase;
    letter-spacing: -1px;
    margin: 0 0 1rem 0;
}

.theme-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 3rem 1.5rem;
}

.theme-hero {
    background: var(--brutal-primary);
    color: #000;
    border: 4px solid #000;
    box-shadow: 8px 8px 0px #000;
    padding: 4rem 2rem;
    margin-bottom: 4rem;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2.5rem;
}

.theme-card {
    background: #ffffff;
    color: #000;
    border: 4px solid #000;
    box-shadow: 6px 6px 0px #000;
    padding: 2rem;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.theme-card:hover {
    transform: translate(-4px, -4px);
    box-shadow: 10px 10px 0px #000;
}

.theme-badge {
    background: var(--brutal-secondary);
    color: #fff;
    border: 2px solid #000;
    padding: 6px 12px;
    font-weight: 800;
    text-transform: uppercase;
    font-size: 0.8rem;
}

button.theme-btn {
    background: #000;
    color: #fff;
    border: 3px solid #000;
    box-shadow: 4px 4px 0px var(--brutal-primary);
    padding: 14px 28px;
    font-weight: 800;
    font-size: 1rem;
    cursor: pointer;
}

button.theme-btn:hover {
    background: var(--brutal-primary);
    color: #000;
}
`,

  // 3. Editorial / High Luxury Serif (Warm cream paper, display serif fonts, gold borders, column layouts)
  editorial: (s: ThemeSeeds) => `/* Archetype: Editorial Luxury */
:root {
    --edit-primary: ${s.primary};
    --edit-secondary: ${s.secondary};
    --edit-bg: ${s.bg};
    --edit-text: ${s.text};
}

body {
    background-color: var(--edit-bg);
    color: var(--edit-text);
    font-family: 'Lora', Georgia, 'Times New Roman', serif;
    font-size: 1.1rem;
    line-height: 1.8;
    margin: 0;
}

h1, h2, h3 {
    font-family: 'Playfair Display', Didot, 'Bodoni MT', Georgia, serif;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--edit-primary);
}

.theme-container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 4rem 2rem;
}

.theme-hero {
    border-top: 3px double var(--edit-primary);
    border-bottom: 1px solid var(--edit-secondary);
    padding: 5rem 1rem;
    text-align: center;
    margin-bottom: 4rem;
}

.theme-hero h1 {
    font-size: 4rem;
    font-style: italic;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 3rem;
}

.theme-card {
    border-left: 2px solid var(--edit-primary);
    padding-left: 1.5rem;
    transition: border-color 0.3s ease;
}

.theme-card:hover {
    border-left-color: var(--edit-secondary);
}

.theme-badge {
    font-family: 'Playfair Display', Didot, 'Bodoni MT', Georgia, serif;
    font-style: italic;
    color: var(--edit-secondary);
    font-size: 0.9rem;
    border-bottom: 1px solid var(--edit-secondary);
}

button.theme-btn {
    background: transparent;
    color: var(--edit-primary);
    border: 1px solid var(--edit-primary);
    padding: 10px 24px;
    font-family: 'Playfair Display', Didot, 'Bodoni MT', Georgia, serif;
    font-style: italic;
    cursor: pointer;
    transition: all 0.3s ease;
}

button.theme-btn:hover {
    background: var(--edit-primary);
    color: var(--edit-bg);
}
`,

  // 4. Glassmorphism / Modern SaaS Aurora (Glowing blur cards, pill badges, gradient text)
  glassmorphism: (s: ThemeSeeds) => `/* Archetype: Glassmorphism Aurora */
:root {
    --glass-primary: ${s.primary};
    --glass-secondary: ${s.secondary};
    --glass-bg: ${s.bg};
    --glass-text: ${s.text};
}

body {
    background-color: var(--glass-bg);
    color: var(--glass-text);
    font-family: 'Plus Jakarta Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    margin: 0;
    background-image: radial-gradient(at 10% 10%, var(--glass-primary) 0px, transparent 50%),
                      radial-gradient(at 90% 90%, var(--glass-secondary) 0px, transparent 50%);
    background-attachment: fixed;
}

h1, h2, h3 {
    font-weight: 800;
    letter-spacing: -0.03em;
}

.theme-container {
    max-width: 1240px;
    margin: 0 auto;
    padding: 3rem 2rem;
}

.theme-hero {
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 24px;
    padding: 5rem 2rem;
    text-align: center;
    box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    margin-bottom: 3rem;
}

.theme-hero h1 {
    font-size: 3.8rem;
    background: linear-gradient(135deg, #ffffff 0%, var(--glass-primary) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 2rem;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.theme-card:hover {
    transform: translateY(-6px);
    border-color: var(--glass-primary);
    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
}

.theme-badge {
    background: rgba(255, 255, 255, 0.1);
    color: var(--glass-primary);
    border: 1px solid var(--glass-primary);
    border-radius: 9999px;
    padding: 4px 14px;
    font-size: 0.75rem;
    font-weight: 600;
}

button.theme-btn {
    background: linear-gradient(135deg, var(--glass-primary), var(--glass-secondary));
    color: #fff;
    border: none;
    border-radius: 9999px;
    padding: 12px 28px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    transition: transform 0.2s, box-shadow 0.2s;
}

button.theme-btn:hover {
    transform: scale(1.04);
    box-shadow: 0 15px 30px rgba(0,0,0,0.4);
}
`,

  // 5. Organic / Soft Pastel Minimalist (Rounded 32px borders, soft shadows, warm natural tones)
  organic: (s: ThemeSeeds) => `/* Archetype: Organic Pastel */
:root {
    --org-primary: ${s.primary};
    --org-secondary: ${s.secondary};
    --org-bg: ${s.bg};
    --org-text: ${s.text};
}

body {
    background-color: var(--org-bg);
    color: var(--org-text);
    font-family: 'Outfit', 'Century Gothic', 'Avenir Next', 'Segoe UI', sans-serif;
    margin: 0;
    line-height: 1.6;
}

.theme-container {
    max-width: 1180px;
    margin: 0 auto;
    padding: 3rem 2rem;
}

.theme-hero {
    background: var(--org-secondary);
    border-radius: 36px;
    padding: 5rem 3rem;
    text-align: center;
    margin-bottom: 3rem;
}

.theme-hero h1 {
    font-size: 3.5rem;
    color: var(--org-primary);
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: rgba(255, 255, 255, 0.06);
    border-radius: 28px;
    padding: 2rem;
    box-shadow: 0 10px 30px rgba(0,0,0,0.05);
    transition: transform 0.3s ease;
}

.theme-card:hover {
    transform: translateY(-4px);
}

.theme-badge {
    background: var(--org-primary);
    color: #fff;
    border-radius: 20px;
    padding: 4px 12px;
    font-size: 0.8rem;
    font-weight: 500;
}

button.theme-btn {
    background: var(--org-primary);
    color: #fff;
    border: none;
    border-radius: 24px;
    padding: 12px 26px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
}
`,

  // 6. Dark Obsidian & Gold Luxury (Brushed metal dark backgrounds, gold foil badges, sleek layout)
  obsidian: (s: ThemeSeeds) => `/* Archetype: Obsidian Luxury */
:root {
    --obs-primary: ${s.primary};
    --obs-secondary: ${s.secondary};
    --obs-bg: ${s.bg};
    --obs-text: ${s.text};
}

body {
    background-color: var(--obs-bg);
    color: var(--obs-text);
    font-family: 'Montserrat', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    margin: 0;
    letter-spacing: 0.5px;
}

h1, h2, h3 {
    font-family: 'Cinzel', 'Trajan Pro', 'Times New Roman', serif;
    font-weight: 800;
    color: var(--obs-primary);
    text-transform: uppercase;
}

.theme-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 4rem 2rem;
}

.theme-hero {
    background: linear-gradient(180deg, #111111 0%, #050505 100%);
    border: 1px solid var(--obs-primary);
    border-radius: 4px;
    padding: 6rem 2rem;
    text-align: center;
    margin-bottom: 4rem;
}

.theme-hero h1 {
    font-size: 3.5rem;
    letter-spacing: 4px;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2.5rem;
}

.theme-card {
    background: #0a0a0a;
    border: 1px solid #222222;
    padding: 2.5rem;
    transition: all 0.4s ease;
}

.theme-card:hover {
    border-color: var(--obs-primary);
    box-shadow: 0 0 25px rgba(234, 179, 8, 0.15);
}

.theme-badge {
    color: var(--obs-primary);
    border-bottom: 1px solid var(--obs-primary);
    font-size: 0.75rem;
    letter-spacing: 2px;
    text-transform: uppercase;
}

button.theme-btn {
    background: linear-gradient(135deg, var(--obs-primary), var(--obs-secondary));
    color: #000000;
    border: none;
    padding: 14px 32px;
    font-family: 'Cinzel', 'Trajan Pro', 'Times New Roman', serif;
    font-weight: 800;
    letter-spacing: 2px;
    cursor: pointer;
    transition: opacity 0.2s;
}

button.theme-btn:hover {
    opacity: 0.9;
}
`,
};

const ARCHETYPE_NAMES: string[] = Object.keys(ARCHETYPES);

/** CSS for one archetype preset. Callers validate the name against ARCHETYPE_NAMES first. */
function archetypeCss(name: string, seeds: ThemeSeeds): string {
  const gen = ARCHETYPES[name];
  if (!gen) throw new Error(`Unknown archetype "${name}" (expected one of: ${ARCHETYPE_NAMES.join(', ')})`);
  return gen(seeds);
}

// readableOn is exported because THREE places decide the link colour — this derivation, the Stitch
// importer and the verifier that compares them — and they have to agree or a theme is told it does
// not match the design it was built from.
module.exports = { deriveTokens, archetypeCss, ARCHETYPE_NAMES, lum, onColor, contrast, readableOn };
