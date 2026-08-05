/**
 * WordJS - Stitch design system → theme.json
 *
 * Turns the JSON a Stitch design system returns (`designTheme`: seed overrides, fonts,
 * roundness, spacing scale and the RESOLVED `namedColors` palette) into the declarative
 * theme.json contract that core/theme-compile.ts compiles. The mapping is the one
 * documented in documentation/stitch-brief.md §1 — until now it was applied by hand,
 * which is where the hero bug below came from.
 *
 *   designToTheme(design, opts)        → { theme, tokens, dropped, notes }   (no writes)
 *   applyDesignToTheme(dir, design, o) → { …, path, created, preserved }     (writes theme.json)
 *
 * `theme` is the complete theme.json object; `dropped` lists every token the mapping
 * produced but refused to write, with the reason. Compiling is NOT done here — that is
 * `node backend/cli/wordjs.js build theme <slug>`.
 *
 * INVARIANTS
 *  1. Nothing invented. Every emitted token must exist in the token manifest
 *     (backend/public/theme-tokens.json); anything else is dropped and reported. A
 *     namedColor the design does not carry produces NO token rather than a guess.
 *  2. Every colour that enters is a validated hex (#rgb or #rrggbb) normalised to
 *     lowercase #rrggbb — the shape theme-compile's SEED_RE/token charset accept.
 *  3. Deterministic: same input → byte-identical output. No clock, no randomness, key
 *     order fixed by the emission table below, JSON written with a stable key order.
 *  4. The hero is legible by construction (see HERO below).
 *
 * HERO — the failure this converter exists to prevent. The framework's hero defaults
 * assume a DARK band: --wjs-hero-color falls back to `#fff`, --wjs-hero-title-color to
 * `inherit` and --wjs-hero-button-outline-color to `#fff`, while --wjs-hero-bg falls back
 * to the light var(--wjs-bg-muted). A light Stitch palette therefore renders white text on
 * cream — the title simply disappears. So the hero band is always emitted explicitly, and
 * every one of its text colours is checked against the band at WCAG 4.5:1 with a
 * deterministic fallback chain ending in black-or-white ink (which always clears 4.5).
 *
 * MERGE RULE (applyDesignToTheme) — the design owns exactly the tokens it emits: those are
 * overwritten on every re-import. Every other key of the existing `tokens` map is the
 * author's and is preserved verbatim, as are `styles`, `layout` and any extra top-level
 * key. Nothing is ever deleted.
 */

const fs = require('fs');
const path = require('path');

// Same cwd convention as core/theme-compile.ts (the backend always runs from backend/).
const MANIFEST_PATH = path.resolve('./public/theme-tokens.json');

interface StitchImportOpts {
  name?: string;
  description?: string;
  author?: string;
  slug?: string;
  version?: string;
  manifestPath?: string;
  /** Passed through untouched when the design carries no layout of its own. */
  layout?: any;
}

type DropReason = 'not-in-manifest' | 'editor-internal' | 'missing-color' | 'invalid-color' | 'invalid-value';

interface DroppedToken {
  token: string;
  value: string | null;
  reason: DropReason;
}

interface StitchImportResult {
  theme: any;
  tokens: Record<string, string>;
  dropped: DroppedToken[];
  notes: string[];
}

interface StitchApplyResult extends StitchImportResult {
  path: string;
  created: boolean;
  /** Token names found in the existing theme.json that the design does not own. */
  preserved: string[];
}

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

// --- colour ----------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** #rgb / #rrggbb (any case) → #rrggbb lowercase. Anything else → null. */
function normalizeHex(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!HEX_RE.test(v)) return null;
  const h = v.slice(1).toLowerCase();
  return '#' + (h.length === 3 ? h.split('').map((c: string) => c + c).join('') : h);
}

const hex2rgb = (h: string): number[] => [1, 3, 5].map((i: number) => parseInt(h.slice(i, i + 2), 16));

// WCAG 2.x relative luminance — deliberately NOT theme-derive's lum(), which is the
// generator's cheap weighted average with no sRGB linearisation. Hero legibility is a
// contrast CLAIM, so it is measured the way the spec measures it.
const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const relLuminance = (hex: string): number => {
  const [r, g, b] = hex2rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const CONTRAST_MIN = 4.5;
// PURE black, not the generator's softer #111111: the terminal fallback has to clear 4.5:1
// on ANY background, and only the extremes do. max(ratio(#000), ratio(#fff)) bottoms out at
// 4.58:1 (relative luminance ≈ 0.179, around #777777) — with #111111 that floor drops to
// 4.22:1 and the chain can end on an illegible colour. Last resort only.
const INK_DARK = '#000000';
const INK_LIGHT = '#ffffff';
const ink = (bg: string): string => (contrastRatio(INK_DARK, bg) >= contrastRatio(INK_LIGHT, bg) ? INK_DARK : INK_LIGHT);

// --- fonts -----------------------------------------------------------------------------

// Family names are compared case-insensitively by CSS, so the stack only has to name the
// family the theme self-hosts. Classification is a NAME heuristic — Stitch says which
// Google family, not which category — and it only picks the fallback stack, so a miss
// degrades to a different generic rather than to a broken value.
const SERIF_HINT = /(serif|slab|garamond|georgia|times|playfair|merriweather|lora|baskerville|crimson|spectral|bodoni|didot|caslon|cormorant|bitter|arvo|rockwell|cardo|vollkorn|newsreader|literata|prata|abril|domine|neuton|tinos|gelasio|alegreya|marcellus|cinzel|eczar|zilla|frank ruhl|libre caslon|source serif|pt serif|noto serif|roboto slab)/i;
const MONO_HINT = /(mono|code|courier|consol)/i;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,40}$/;

const SANS_FALLBACK = "'Segoe UI', system-ui, sans-serif";
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * WORK_SANS → "Work Sans", EB_GARAMOND → "EB Garamond". Parts of one or two letters stay
 * uppercase, which is how Google names them (EB, PT, DM); the enum is preferred over
 * Stitch's own *FontFamily string because that one comes back title-cased ("Eb Garamond").
 */
function familyFromEnum(name: any): string | null {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
  return name.split('_').filter(Boolean)
    .map((p: string) => (p.length <= 2 ? p : p.charAt(0) + p.slice(1).toLowerCase()))
    .join(' ');
}

function fontStack(family: string): string {
  const generic = MONO_HINT.test(family) ? MONO_FALLBACK : SERIF_HINT.test(family) ? SERIF_FALLBACK : SANS_FALLBACK;
  return `'${family}', ${generic}`;
}

// --- shape / spacing -------------------------------------------------------------------

// The design says how sharp the corners are; the pill radius follows it. With
// ROUND_FOUR/EIGHT/TWELVE the pill is NOT 9999px — a design that asks for crisp corners
// does not want lozenge buttons — and ROUND_FULL already IS the pill value.
const ROUNDNESS: Record<string, string> = {
  ROUND_NONE: '0px',
  ROUND_FOUR: '4px',
  ROUND_EIGHT: '8px',
  ROUND_TWELVE: '12px',
  ROUND_FULL: '9999px'
};
const RADIUS_TOKENS = ['--wjs-radius', '--wjs-radius-sm', '--wjs-radius-md', '--wjs-radius-lg', '--wjs-radius-pill'];

// spacingScale is an index into a five-step ladder. Step 2 reproduces the framework's own
// 4/8/16/24/40 rhythm, so the middle of the scale changes nothing the theme did not ask for.
const SPACING_UNITS_REM = [0.125, 0.1875, 0.25, 0.375, 0.5];
const SPACING_STEPS: Array<[string, number]> = [
  ['--wjs-xs', 1], ['--wjs-sm', 2], ['--wjs-md', 4], ['--wjs-lg', 6], ['--wjs-xl', 10], ['--wjs-2xl', 18]
];
// 0.25 → "0.25rem", 1 → "1rem" (never "1.0000rem"). Every unit×step here is an exact
// binary fraction, so this is lossless.
const rem = (n: number): string => `${String(Number(n.toFixed(4)))}rem`;

// --- typography (optional; the design system carries none today) ------------------------

const LEVEL_RE = /^(?:h|heading)([1-6])$/;
const LENGTH_RE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%)$/;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;

// --- manifest ---------------------------------------------------------------------------

function loadManifestTokens(manifestPath?: string): Set<string> {
  const p = path.resolve(manifestPath || MANIFEST_PATH);
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {
    throw new Error(`stitch-import: token manifest is missing or unreadable at ${p}`);
  }
  if (!parsed || !isPlainObject(parsed.tokens)) {
    throw new Error(`stitch-import: token manifest at ${p} has no "tokens" map`);
  }
  return new Set<string>(Object.keys(parsed.tokens));
}

// --- the conversion ---------------------------------------------------------------------

const toTitleCase = (slug: string): string =>
  slug.split('-').filter(Boolean).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * The Stitch payload comes either as the API envelope ({ designTheme, title, … }) or as a
 * bare designTheme. Both are accepted; the envelope's `title` seeds the theme name.
 */
function unwrap(input: any): { design: any; title: string } {
  if (!isPlainObject(input)) throw new TypeError('stitch-import: design must be an object');
  const design = isPlainObject(input.designTheme) ? input.designTheme : input;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  return { design, title };
}

/**
 * First candidate that carries a value wins. A seed is the foundation of the palette, so a
 * malformed colour is refused outright (theme-compile would reject it anyway, at a point
 * where the theme is already on disk) — null means the design simply said nothing.
 */
function seedColor(candidates: Array<[string, any]>): string | null {
  for (const [field, raw] of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const hex = normalizeHex(raw);
    if (!hex) throw new TypeError(`stitch-import: ${field} is not a #rrggbb colour (got ${JSON.stringify(raw)})`);
    return hex;
  }
  return null;
}

function requireSeed(label: string, candidates: Array<[string, any]>): string {
  const hex = seedColor(candidates);
  if (!hex) throw new TypeError(`stitch-import: the design carries no usable colour for seeds.${label}`);
  return hex;
}

function designToTheme(design: any, opts: StitchImportOpts = {}): StitchImportResult {
  const { design: dt, title } = unwrap(design);
  const notes: string[] = [];
  const dropped: DroppedToken[] = [];
  const emitted: Array<[string, string]> = [];

  const named: any = isPlainObject(dt.namedColors) ? dt.namedColors : {};
  // Reading a namedColor is the only route into the palette: missing → no token,
  // malformed → no token plus a report. Never a substitute value.
  const seen = new Set<string>();
  const colour = (key: string): string | null => {
    const raw = named[key];
    if (raw === undefined || raw === null || raw === '') return null;
    const hex = normalizeHex(raw);
    if (!hex && !seen.has(key)) {
      seen.add(key);
      notes.push(`namedColors.${key} is not a hex colour (${JSON.stringify(raw)}) — every token that reads it was skipped`);
    }
    return hex;
  };
  const put = (token: string, value: string | null, key: string): void => {
    if (value === null) {
      dropped.push({ token, value: null, reason: named[key] === undefined ? 'missing-color' : 'invalid-color' });
      return;
    }
    emitted.push([token, value]);
  };

  // --- seeds (theme-compile derives the base palette from these; the tokens below
  //     override it wherever the resolved Stitch palette has an exact answer) ---
  const colorMode = typeof dt.colorMode === 'string' ? dt.colorMode.toUpperCase() : 'LIGHT';
  const dark = colorMode === 'DARK';
  const canvasKey = dark ? 'surface' : 'background';
  const seedPrimary = requireSeed('primary', [
    ['overridePrimaryColor', dt.overridePrimaryColor], ['customColor', dt.customColor],
    ['namedColors.primary_container', named.primary_container], ['namedColors.primary', named.primary]
  ]);
  // LIGHT reads `background`, DARK reads `surface`: namedColors already comes resolved for
  // the mode, so the neutral override is only the last resort.
  const seedBg = requireSeed('bg', [
    [`namedColors.${canvasKey}`, named[canvasKey]],
    ['namedColors.background', named.background], ['namedColors.surface', named.surface],
    ['overrideNeutralColor', dt.overrideNeutralColor]
  ]);
  let seedSecondary = seedColor([
    ['overrideSecondaryColor', dt.overrideSecondaryColor],
    ['namedColors.secondary_container', named.secondary_container], ['namedColors.secondary', named.secondary]
  ]);
  if (!seedSecondary) {
    seedSecondary = seedPrimary;
    notes.push('the design carries no secondary colour — seeds.secondary reuses seeds.primary');
  }
  let seedText = seedColor([
    ['namedColors.on_surface', named.on_surface], ['namedColors.on_background', named.on_background]
  ]);
  if (!seedText) {
    seedText = ink(seedBg);
    notes.push(`the design carries no on_surface/on_background — seeds.text falls back to ${seedText}`);
  }
  const seeds: Record<string, string> = { primary: seedPrimary, secondary: seedSecondary, bg: seedBg, text: seedText };

  // --- palette (documentation/stitch-brief.md §1) ---
  put('--wjs-bg-canvas', colour('background'), 'background');
  put('--wjs-bg-surface', colour('surface_container_lowest'), 'surface_container_lowest');
  put('--wjs-bg-muted', colour('surface_container'), 'surface_container');
  put('--wjs-color-primary', colour('primary_container'), 'primary_container');
  put('--wjs-color-primary-dark', colour('primary'), 'primary');
  put('--wjs-color-on-primary', colour('on_primary'), 'on_primary');
  // The explicit secondary override outranks the container: it is what the author picked.
  const secondaryHex = normalizeHex(dt.overrideSecondaryColor) || colour('secondary_container');
  put('--wjs-color-secondary', secondaryHex, 'secondary_container');
  put('--wjs-color-secondary-dark', colour('secondary'), 'secondary');
  put('--wjs-color-on-secondary', colour('on_secondary'), 'on_secondary');
  put('--wjs-color-text-main', colour('on_surface'), 'on_surface');
  put('--wjs-color-heading', colour('on_surface'), 'on_surface');
  put('--wjs-color-text-muted', colour('on_surface_variant'), 'on_surface_variant');
  put('--wjs-color-link', colour('primary'), 'primary');
  put('--wjs-border-subtle', colour('outline_variant'), 'outline_variant');
  put('--wjs-card-border-color', colour('outline_variant'), 'outline_variant');
  put('--wjs-outline', colour('outline'), 'outline');
  put('--wjs-color-danger', colour('error'), 'error');
  put('--wjs-color-on-danger', colour('on_error'), 'on_error');

  // --- fonts ---
  const family = (enumField: any, plainField: any, label: string): string | null => {
    const fromEnum = familyFromEnum(enumField);
    const raw = fromEnum || (typeof plainField === 'string' ? plainField.trim() : '');
    if (!raw) return null;
    if (!FAMILY_RE.test(raw)) {
      notes.push(`${label} ${JSON.stringify(raw)} is not a plain font family name — the font token was skipped`);
      return null;
    }
    return raw;
  };
  const headingFamily = family(dt.headlineFont, dt.headlineFontFamily, 'headlineFont');
  const bodyFamily = family(dt.bodyFont, dt.bodyFontFamily, 'bodyFont');
  if (headingFamily) emitted.push(['--wjs-font-family-heading', fontStack(headingFamily)]);
  if (bodyFamily) emitted.push(['--wjs-font-family-base', fontStack(bodyFamily)]);

  // --- typography (optional: today's design system carries none) ---
  const typography: any[] = Array.isArray(dt.typography)
    ? dt.typography
    : isPlainObject(dt.typography)
      ? Object.entries(dt.typography).map(([k, v]: [string, any]) => (isPlainObject(v) ? { name: k, ...v } : { name: k }))
      : [];
  const levelSeen = new Set<string>();
  for (const entry of typography) {
    if (!isPlainObject(entry)) continue;
    const rawName = [entry.name, entry.role, entry.level, entry.tag].find((v: any) => typeof v === 'string') || '';
    const m = LEVEL_RE.exec(String(rawName).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!m || levelSeen.has(m[1])) continue;
    levelSeen.add(m[1]);
    const n = m[1];
    const scalar = (v: any): string => (typeof v === 'number' ? `${v}px` : typeof v === 'string' ? v.trim() : '');
    const take = (token: string, raw: any, re: RegExp): void => {
      const value = scalar(raw);
      if (value === '') return;
      if (!re.test(value)) { dropped.push({ token, value, reason: 'invalid-value' }); return; }
      emitted.push([token, value]);
    };
    take(`--wjs-h${n}`, entry.fontSize, LENGTH_RE);
    take(`--wjs-h${n}-tracking`, entry.letterSpacing, LENGTH_RE);
    take(`--wjs-h${n}-leading`, entry.lineHeight, NUMBER_RE);
  }

  // --- shape ---
  if (dt.roundness !== undefined) {
    const radius = ROUNDNESS[String(dt.roundness).toUpperCase()];
    if (!radius) {
      notes.push(`roundness ${JSON.stringify(dt.roundness)} is not one of ${Object.keys(ROUNDNESS).join(', ')} — radius tokens were skipped`);
    } else {
      for (const token of RADIUS_TOKENS) emitted.push([token, radius]);
    }
  }

  // --- spacing ---
  if (dt.spacingScale !== undefined) {
    const scale = dt.spacingScale;
    if (!Number.isInteger(scale) || scale < 0 || scale >= SPACING_UNITS_REM.length) {
      notes.push(`spacingScale ${JSON.stringify(scale)} is outside 0..${SPACING_UNITS_REM.length - 1} — spacing tokens were skipped`);
    } else {
      const unit = SPACING_UNITS_REM[scale];
      for (const [token, steps] of SPACING_STEPS) emitted.push([token, rem(unit * steps)]);
    }
  }

  // --- hero (see the HERO note in the header) ---
  const band = isPlainObject(dt.hero) ? dt.hero : null;
  const bandBg = band ? normalizeHex(band.background || band.bg) : null;
  if (band && !bandBg) notes.push('the design declares a hero band with no usable background colour — the hero falls back to the page');
  const paper = colour('background') || colour('surface') || seeds.bg;
  const heroBg = bandBg || paper;

  // First candidate that clears 4.5:1 against the band wins; the chains all end in
  // black-or-white ink, which clears it on any background.
  const legible = (label: string, candidates: Array<[string, string | null]>): string => {
    const tried: string[] = [];
    for (const [why, hex] of candidates) {
      if (!hex) continue;
      const ratio = contrastRatio(hex, heroBg);
      if (ratio >= CONTRAST_MIN) {
        if (tried.length > 0) notes.push(`hero ${label}: ${tried.join(', ')} — used ${why} ${hex} (${ratio.toFixed(2)}:1) instead`);
        return hex;
      }
      tried.push(`${why} ${hex} reads ${ratio.toFixed(2)}:1 on ${heroBg}`);
    }
    const fallback = ink(heroBg);
    notes.push(`hero ${label}: ${tried.length > 0 ? `${tried.join(', ')} — ` : ''}used plain ink ${fallback} instead`);
    return fallback;
  };

  const fromBand = (field: string): Array<[string, string | null]> =>
    (band && band[field] !== undefined ? [[`the band's own ${field}`, normalizeHex(band[field])]] : []);

  const heroText = legible('text', [
    ...fromBand('on_background'), ...fromBand('color'),
    ['on_surface', colour('on_surface')],
    ['on_background', colour('on_background')]
  ]);
  const heroTitle = legible('title', [
    ...fromBand('title'),
    ['primary_container', colour('primary_container')],
    ['primary', colour('primary')],
    ['the hero text colour', heroText]
  ]);
  const heroSubtitle = legible('subtitle', [
    ...fromBand('subtitle'),
    ['on_surface_variant', colour('on_surface_variant')],
    ['on_surface', colour('on_surface')],
    ['the hero text colour', heroText]
  ]);
  emitted.push(['--wjs-hero-bg', heroBg]);
  emitted.push(['--wjs-hero-gradient-from', heroBg]);
  emitted.push(['--wjs-hero-gradient-to', heroBg]);
  emitted.push(['--wjs-hero-color', heroText]);
  emitted.push(['--wjs-hero-title-color', heroTitle]);
  emitted.push(['--wjs-hero-subtitle-color', heroSubtitle]);
  // Same defect as the title: the framework's outline button is #fff on both counts, so an
  // outlined call to action vanishes on a light band.
  emitted.push(['--wjs-hero-button-outline-color', heroTitle]);
  emitted.push(['--wjs-hero-button-outline-border', heroTitle]);

  // --- manifest filter: nothing reaches theme.json that the contract does not know ---
  const manifest = loadManifestTokens(opts.manifestPath);
  const tokens: Record<string, string> = {};
  for (const [token, value] of emitted) {
    if (/^--wjs-r-/.test(token)) { dropped.push({ token, value, reason: 'editor-internal' }); continue; }
    if (!manifest.has(token)) { dropped.push({ token, value, reason: 'not-in-manifest' }); continue; }
    tokens[token] = value;
  }

  const slug = typeof opts.slug === 'string' ? opts.slug : '';
  const theme: any = {
    name: opts.name || title || (slug ? toTitleCase(slug) : 'Stitch theme'),
    version: opts.version || '1.0.0',
    description: opts.description || 'Compiled from a Stitch design system.',
    author: opts.author || 'WordJS × Stitch',
    generator: 'wordjs',
    seeds
  };
  // The design system carries no layout: it is the theme author's, so it only appears when
  // the payload (or the caller) actually supplies one.
  const layout = isPlainObject(dt.layout) ? dt.layout : isPlainObject(opts.layout) ? opts.layout : null;
  if (layout) theme.layout = JSON.parse(JSON.stringify(layout));
  theme.tokens = tokens;

  return { theme, tokens, dropped, notes };
}

/**
 * Read <themeDir>/theme.json if it exists, merge the design into it (see MERGE RULE in the
 * header) and write it back atomically. Does not compile: run
 * `node backend/cli/wordjs.js build theme <slug>` afterwards.
 */
function applyDesignToTheme(themeDir: string, design: any, opts: StitchImportOpts = {}): StitchApplyResult {
  const dir = path.resolve(themeDir);
  const target = path.join(dir, 'theme.json');

  let existing: any = null;
  let raw: string | null;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { raw = null; }
  if (raw !== null) {
    try { existing = JSON.parse(raw); } catch (e: any) {
      // Refuse rather than overwrite: a theme.json we cannot read may hold hand-written
      // tokens and styles that the merge is supposed to preserve.
      throw new Error(`stitch-import: ${target} is not valid JSON (${e.message}) — fix or move it before importing`, { cause: e });
    }
    if (!isPlainObject(existing)) {
      throw new Error(`stitch-import: ${target} is not a JSON object — refusing to overwrite it`);
    }
  }

  const slug = opts.slug || path.basename(dir);
  const result = designToTheme(design, { ...opts, slug });
  const fresh = result.theme;
  const prevTokens: any = existing && isPlainObject(existing.tokens) ? existing.tokens : {};
  const preserved: string[] = [];

  const tokens: Record<string, string> = {};
  // Existing keys keep their position: a hand-edited theme.json comes back recognisable.
  for (const [name, value] of Object.entries(prevTokens)) {
    if (Object.prototype.hasOwnProperty.call(result.tokens, name)) {
      tokens[name] = result.tokens[name];
    } else {
      tokens[name] = value as string;
      preserved.push(name);
    }
  }
  for (const [name, value] of Object.entries(result.tokens)) {
    if (!Object.prototype.hasOwnProperty.call(tokens, name)) tokens[name] = value;
  }

  const merged: any = {};
  // Metadata: an explicit opt wins, then whatever the theme already said, then the default.
  merged.name = opts.name || (existing && typeof existing.name === 'string' ? existing.name : fresh.name);
  merged.version = opts.version || (existing && typeof existing.version === 'string' ? existing.version : fresh.version);
  merged.description = opts.description
    || (existing && typeof existing.description === 'string' ? existing.description : fresh.description);
  merged.author = opts.author || (existing && typeof existing.author === 'string' ? existing.author : fresh.author);
  merged.generator = 'wordjs';
  merged.seeds = fresh.seeds;
  // layout and styles are authorial — the design never speaks for them.
  const layout = existing && existing.layout !== undefined ? existing.layout : fresh.layout;
  if (layout !== undefined) merged.layout = layout;
  merged.tokens = tokens;
  if (existing && existing.styles !== undefined) merged.styles = existing.styles;
  // Anything else the author put in theme.json (archetype, screenshot, …) survives.
  if (existing) {
    for (const key of Object.keys(existing)) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = existing[key];
    }
  }

  writeJsonAtomic(target, merged);
  return { ...result, theme: merged, path: target, created: raw === null, preserved };
}

/** tmp + rename, with the Windows retry core/theme-compile.ts documents (EPERM/EBUSY). */
function writeJsonAtomic(target: string, value: any): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  let lastError: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e: any) {
      lastError = e;
      if (e && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
      const until = Date.now() + 40;
      while (Date.now() < until) { /* callers are synchronous; a short spin is the only wait available */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw lastError;
}

module.exports = { designToTheme, applyDesignToTheme, normalizeHex, contrastRatio };
