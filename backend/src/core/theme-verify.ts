/**
 * WordJS - Theme Verifier
 * Checks an installed theme against the Stitch design system it was built from
 * (themes/<slug>/.design/stitch.json) using the mapping documented in
 * documentation/stitch-brief.md §1. Every value the brief promises to carry across is
 * resolved and compared, so "the theme is faithful to the design" stops being something
 * you confirm by pasting JavaScript into a browser console.
 *
 * WHAT IS COMPARED — the value a BROWSER would end up using, resolved like the cascade:
 *   1. the last `--wjs-*` declaration in a `:root` block of the theme's style.css;
 *   2. otherwise the framework's own value from public/theme-tokens.json (declaredDefault,
 *      or the fallback its consumers pass) — a token the theme leaves alone is not a hole,
 *      it keeps the framework value, and THAT is what ships;
 *   3. `var(--other)` references are followed through the same lookup (depth-capped).
 *
 * WHY style.css AND NOT A theme-compile DRY RUN: a visitor is served the stylesheet on
 * disk. A dry run verifies theme.json's INTENT, so it would report a match while the
 * shipped @wjs-generated block was stale, or while hand-written CSS below the markers
 * overrode it. That drift is the doctor's GENERATED_DRIFT — a different question from
 * fidelity, and one this verifier must not be able to answer wrongly. The only value read
 * from theme.json is `seeds`, which has no CSS representation at all.
 *
 * verifyTheme(slug, design, { themesDir?, manifestPath? })
 *   → { slug, ok, matches[], mismatches[], unmapped[] }
 * Throws only when there is nothing to verify (bad slug, no theme, unreadable style.css,
 * design not an object): unlike the fail-open doctor this is a gate, and a verifier that
 * silently reports "all good" because it could not read the theme is worse than no gate.
 */

const fs = require('fs');
const path = require('path');
const { THEME_SLUG: SLUG_RE } = require('./safe-path');

// Same cwd conventions as core/themes.ts (the backend always runs from backend/).
const THEMES_DIR = path.resolve('./themes');
const MANIFEST_PATH = path.resolve('./public/theme-tokens.json');

type CheckKind = 'color' | 'font' | 'length';
type UnmappedReason = 'design-missing' | 'no-token' | 'no-rule';

interface Comparison {
  token: string;
  expected: string;
  actual: string | null;
  source: string;
}

interface Unmapped {
  token: string | null;
  source: string;
  reason: UnmappedReason;
  note?: string;
}

interface VerifyReport {
  slug: string;
  ok: boolean;
  matches: Comparison[];
  mismatches: Comparison[];
  unmapped: Unmapped[];
}

interface VerifyOpts {
  themesDir?: string;
  manifestPath?: string;
}

interface Check {
  token: string;
  source: string;
  expected: string;
  kind: CheckKind;
}

// documentation/stitch-brief.md §1: roundness → --wjs-radius, -md, -lg, -pill. The pill
// only becomes 9999px under ROUND_FULL: with an explicit corner size the design asks for
// crisp corners everywhere, so the pill takes that same size. A roundness value outside
// this table has no documented size and is reported as unmapped, never guessed.
const ROUNDNESS: Record<string, string> = {
  ROUND_FOUR: '4px',
  ROUND_EIGHT: '8px',
  ROUND_TWELVE: '12px',
  ROUND_FULL: '9999px'
};
const RADIUS_TOKENS = ['--wjs-radius', '--wjs-radius-md', '--wjs-radius-lg', '--wjs-radius-pill'];
const SPACING_TOKENS: Record<string, string> = {
  xs: '--wjs-xs', sm: '--wjs-sm', md: '--wjs-md',
  lg: '--wjs-lg', xl: '--wjs-xl', '2xl': '--wjs-2xl'
};

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

// --- normalization ---------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function channelByte(part: string): number | null {
  const pct = part.endsWith('%');
  const n = Number(pct ? part.slice(0, -1) : part);
  if (!Number.isFinite(n)) return null;
  const byte = Math.round(pct ? (n / 100) * 255 : n);
  return byte < 0 || byte > 255 ? null : byte;
}

/**
 * Canonical form of a color so two spellings of the same paint compare equal: lowercase,
 * #abc expanded to #aabbcc, and rgb()/rgba() reduced to hex (a fully opaque alpha is
 * dropped, a partial one becomes #rrggbbaa). Anything else is returned trimmed and
 * lowercased, so unknown notations still compare literally instead of throwing.
 */
function normalizeColor(raw: string): string {
  const v = String(raw).trim().toLowerCase();
  if (HEX_RE.test(v)) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c: string) => c + c).join('');
    if (h.length === 8 && h.slice(6) === 'ff') h = h.slice(0, 6);
    return `#${h}`;
  }
  const fn = v.match(/^rgba?\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const bytes = parts.slice(0, 3).map(channelByte);
      if (bytes.every((b: number | null) => b !== null)) {
        const hex = `#${bytes.map((b: number | null) => (b as number).toString(16).padStart(2, '0')).join('')}`;
        if (parts.length === 3) return hex;
        const a = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
        if (!Number.isFinite(a)) return v;
        return a >= 1 ? hex : `${hex}${Math.round(Math.max(a, 0) * 255).toString(16).padStart(2, '0')}`;
      }
    }
  }
  return v;
}

// The design names one family; a theme token is a whole stack whose FIRST entry is the
// one that wins when the font is installed. Quotes and case are not meaningful ('EB
// Garamond' vs the API's "Eb Garamond" is the same family).
function firstFamily(stack: string): string {
  const first = String(stack).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return first.replace(/\s+/g, ' ').toLowerCase();
}

// Stitch returns both an enum (EB_GARAMOND) and a display name ("Eb Garamond").
const familyFromEnum = (v: string): string => String(v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const normalizeLength = (raw: string): string => String(raw).trim().toLowerCase().replace(/\s+/g, ' ');

function normalize(value: string, kind: CheckKind): string {
  if (kind === 'color') return normalizeColor(value);
  if (kind === 'font') return firstFamily(value);
  return normalizeLength(value);
}

// --- reading what the theme declares ----------------------------------------------------

/**
 * Every `--wjs-*: value` declared in a `:root` block, last declaration winning like the
 * cascade. Same flat block walk theme-doctor uses (rules nested in @media match too,
 * because their own braces are balanced — a media-scoped :root override wins here as it
 * would late in a real stylesheet).
 */
function parseRootTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) !== null) {
    const selector = (m[1].split(';').pop() || '').trim();
    if (!selector.split(',').some((s: string) => s.trim().startsWith(':root'))) continue;
    for (const raw of m[2].split(';')) {
      const d = raw.match(/^\s*(--wjs-[a-zA-Z0-9_-]+)\s*:\s*([\s\S]*?)\s*$/);
      if (d) out.set(d[1], d[2]);
    }
  }
  return out;
}

// What the framework itself paints when a theme says nothing: the manifest's declaredDefault,
// or the fallback every consumer passes (`var(--wjs-card-border-color, var(--wjs-border-subtle))`)
// when the token has no default of its own.
function frameworkValue(manifestTokens: any, name: string): string | null {
  const entry = manifestTokens[name];
  if (!entry) return null;
  if (typeof entry.declaredDefault === 'string') return entry.declaredDefault;
  if (Array.isArray(entry.fallbacks) && typeof entry.fallbacks[0] === 'string') return entry.fallbacks[0];
  return null;
}

/**
 * Effective value of a token: theme declaration → framework value → null, following a
 * whole-value `var(--other[, fallback])` through the same lookup. The depth cap is what
 * makes a cyclic alias terminate.
 */
function resolveToken(name: string, declared: Map<string, string>, manifestTokens: any, depth = 0): string | null {
  if (depth > 8) return null;
  const raw = declared.has(name) ? (declared.get(name) as string) : frameworkValue(manifestTokens, name);
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  const ref = value.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([\s\S]*))?\)$/);
  if (!ref) return value;
  const resolved = resolveToken(ref[1], declared, manifestTokens, depth + 1);
  if (resolved !== null) return resolved;
  const fallback = ref[2] === undefined ? '' : ref[2].trim();
  return fallback === '' ? null : fallback;
}

// --- the mapping (documentation/stitch-brief.md §1) --------------------------------------

/**
 * namedColors → tokens. The palette Stitch returns is already resolved FOR the color mode,
 * so DARK changes exactly one source: the page canvas comes from `surface` instead of
 * `background`. The ink is `on_surface` in both modes.
 */
function colorRules(colorMode: string): { token: string; key: string; adjust?: string }[] {
  return [
    { token: '--wjs-bg-canvas', key: colorMode === 'DARK' ? 'surface' : 'background' },
    { token: '--wjs-bg-surface', key: 'surface_container_lowest' },
    { token: '--wjs-bg-muted', key: 'surface_container' },
    { token: '--wjs-color-text-main', key: 'on_surface' },
    { token: '--wjs-color-heading', key: 'on_surface' },
    { token: '--wjs-color-text-muted', key: 'on_surface_variant' },
    { token: '--wjs-color-primary', key: 'primary_container' },
    { token: '--wjs-color-primary-dark', key: 'primary' },
    // Not the raw primary: the importer adjusts a link that cannot be read on the page canvas
    // (`readableOn`), so the expectation has to be the adjusted value or every theme whose brand
    // colour needed moving would report a mismatch against the design it faithfully came from.
    { token: '--wjs-color-link', key: 'primary', adjust: 'readable-on-canvas' },
    { token: '--wjs-color-on-primary', key: 'on_primary' },
    { token: '--wjs-color-secondary', key: 'secondary_container' },
    { token: '--wjs-color-secondary-dark', key: 'secondary' },
    { token: '--wjs-border-subtle', key: 'outline_variant' },
    { token: '--wjs-card-border-color', key: 'outline_variant' },
    { token: '--wjs-outline', key: 'outline' },
    { token: '--wjs-color-danger', key: 'error' },
    { token: '--wjs-color-on-danger', key: 'on_error' }
  ];
}

/**
 * Build the comparisons the design system supports, plus the entries nothing can be said
 * about. `checks` and `unmapped` are disjoint by construction: a mapping whose design
 * source is absent produces an unmapped entry INSTEAD of a check, which is what keeps a
 * palette that omits a color from reading as a wrong color.
 */
function buildChecks(dt: any): { checks: Check[]; unmapped: Unmapped[] } {
  const checks: Check[] = [];
  const unmapped: Unmapped[] = [];
  const named: any = isPlainObject(dt.namedColors) ? dt.namedColors : {};
  const colorOf = (key: string): string | null => (typeof named[key] === 'string' ? named[key] : null);

  // --- colors ---
  const rules = colorRules(String(dt.colorMode || 'LIGHT'));
  // Both canvas sources belong to the mapping whichever mode is active, and the secondary
  // container stays mapped even when the override outranks it — neither is "a design value
  // no token consumes".
  const consumed = new Set<string>(['background', 'surface', 'secondary_container']);
  for (const rule of rules) {
    consumed.add(rule.key);
    // The brief lets an explicit brand override outrank the resolved container.
    const override = rule.token === '--wjs-color-secondary' && typeof dt.overrideSecondaryColor === 'string'
      ? dt.overrideSecondaryColor
      : null;
    let expected = override !== null ? override : colorOf(rule.key);
    const source = override !== null ? 'designTheme.overrideSecondaryColor' : `namedColors.${rule.key}`;
    if (expected === null) {
      unmapped.push({ token: rule.token, source, reason: 'design-missing' });
      continue;
    }
    // Some tokens are the design value put to a DIFFERENT use — a fill becoming body text — and the
    // importer adjusts them for it. The expectation has to follow the same adjustment or a faithful
    // theme reports a mismatch against its own design.
    if ((rule as any).adjust === 'readable-on-canvas') {
      const canvas = colorOf(String(dt.colorMode || 'LIGHT') === 'DARK' ? 'surface' : 'background');
      const neutral = typeof dt.overrideNeutralColor === 'string' ? dt.overrideNeutralColor : null;
      const against = neutral || canvas;
      if (against) {
        const { readableOn } = require('./theme-derive');
        expected = readableOn(expected, against);
      }
    }
    checks.push({ token: rule.token, source, expected, kind: 'color' });
  }
  for (const key of Object.keys(named).sort()) {
    if (!consumed.has(key)) unmapped.push({ token: null, source: `namedColors.${key}`, reason: 'no-token' });
  }

  // --- seeds (theme.json, not CSS) ---
  const primarySeed = typeof dt.overridePrimaryColor === 'string' ? dt.overridePrimaryColor
    : (typeof dt.customColor === 'string' ? dt.customColor : null);
  const seedRules: { token: string; value: string | null; source: string }[] = [
    { token: 'seeds.primary', value: primarySeed, source: typeof dt.overridePrimaryColor === 'string' ? 'designTheme.overridePrimaryColor' : 'designTheme.customColor' },
    { token: 'seeds.secondary', value: typeof dt.overrideSecondaryColor === 'string' ? dt.overrideSecondaryColor : null, source: 'designTheme.overrideSecondaryColor' },
    // The RESOLVED paper, not the neutral the designer typed in. Stitch runs that input through its
    // tonal system and the screens it generates paint `bg-background`, so the resolved value is the
    // one a viewer sees — checking the override would fail a theme that reproduces the design exactly.
    {
      token: 'seeds.bg',
      value: typeof named[dt.colorMode === 'DARK' ? 'surface' : 'background'] === 'string'
        ? named[dt.colorMode === 'DARK' ? 'surface' : 'background']
        : null,
      source: `namedColors.${dt.colorMode === 'DARK' ? 'surface' : 'background'}`
    }
  ];
  for (const seed of seedRules) {
    if (seed.value === null) unmapped.push({ token: seed.token, source: seed.source, reason: 'design-missing' });
    else checks.push({ token: seed.token, source: seed.source, expected: seed.value, kind: 'color' });
  }
  // seeds.text has no source of its own: colorMode picks an ink from the palette, and that
  // ink is already verified where it ships, as --wjs-color-text-main.
  unmapped.push({
    token: 'seeds.text',
    source: 'designTheme.colorMode',
    reason: 'no-rule',
    note: 'the ink the mode resolves to is verified as --wjs-color-text-main'
  });

  // --- fonts ---
  const fontRules: { token: string; family: string | null; source: string }[] = [
    {
      token: '--wjs-font-family-heading',
      family: typeof dt.headlineFontFamily === 'string' ? dt.headlineFontFamily
        : (typeof dt.headlineFont === 'string' ? familyFromEnum(dt.headlineFont) : null),
      source: typeof dt.headlineFontFamily === 'string' ? 'designTheme.headlineFontFamily' : 'designTheme.headlineFont'
    },
    {
      token: '--wjs-font-family-base',
      family: typeof dt.bodyFontFamily === 'string' ? dt.bodyFontFamily
        : (typeof dt.bodyFont === 'string' ? familyFromEnum(dt.bodyFont) : null),
      source: typeof dt.bodyFontFamily === 'string' ? 'designTheme.bodyFontFamily' : 'designTheme.bodyFont'
    }
  ];
  for (const font of fontRules) {
    if (font.family === null) unmapped.push({ token: font.token, source: font.source, reason: 'design-missing' });
    else checks.push({ token: font.token, source: font.source, expected: font.family, kind: 'font' });
  }

  // --- roundness ---
  const roundness = typeof dt.roundness === 'string' ? dt.roundness : null;
  const radius = roundness !== null ? ROUNDNESS[roundness] : undefined;
  for (const token of RADIUS_TOKENS) {
    if (roundness === null) unmapped.push({ token, source: 'designTheme.roundness', reason: 'design-missing' });
    else if (radius === undefined) unmapped.push({ token, source: `designTheme.roundness=${roundness}`, reason: 'no-rule', note: `no documented size for ${roundness}` });
    else checks.push({ token, source: `designTheme.roundness=${roundness}`, expected: radius, kind: 'length' });
  }

  // --- spacing ---
  const spacing: any = isPlainObject(dt.spacing) ? dt.spacing : null;
  for (const [step, token] of Object.entries(SPACING_TOKENS)) {
    const value = spacing && typeof spacing[step] === 'string' ? spacing[step] : null;
    if (value === null) unmapped.push({ token, source: `designTheme.spacing.${step}`, reason: 'design-missing' });
    else checks.push({ token, source: `designTheme.spacing.${step}`, expected: value, kind: 'length' });
  }
  // The live API answers with a scale factor instead of a step table, and no rule turns
  // that factor into rem values — reported rather than invented.
  if (spacing === null && dt.spacingScale !== undefined) {
    unmapped.push({
      token: null,
      source: 'designTheme.spacingScale',
      reason: 'no-rule',
      note: 'a scale factor does not resolve to --wjs-xs…--wjs-2xl sizes'
    });
  }

  return { checks, unmapped };
}

// --- entry point --------------------------------------------------------------------------

/**
 * Verify themes/<slug> against a Stitch design system. `design` may be the whole
 * .design/stitch.json ({ designTheme, name, title }) or just the designTheme object.
 */
function verifyTheme(slug: string, design: any, opts: VerifyOpts = {}): VerifyReport {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid theme slug: ${JSON.stringify(slug)}`);
  }
  if (!isPlainObject(design)) throw new Error('Design system is not an object — expected the JSON Stitch returns.');
  const dt: any = isPlainObject(design.designTheme) ? design.designTheme : design;

  const themesDir = path.resolve(opts.themesDir || THEMES_DIR);
  const themeDir = path.join(themesDir, slug);
  let css: string;
  try {
    css = fs.readFileSync(path.join(themeDir, 'style.css'), 'utf8');
  } catch {
    throw new Error(`No readable themes/${slug}/style.css — nothing to verify.`);
  }

  // FAIL-CLOSED, unlike the doctor: without the manifest an undeclared token would look
  // like "nothing paints it" and every such comparison would be reported as a mismatch.
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifestPath || MANIFEST_PATH), 'utf8'));
  } catch {
    manifest = null;
  }
  if (!manifest || !isPlainObject(manifest.tokens)) {
    throw new Error('Token manifest (public/theme-tokens.json) is missing or unreadable — cannot resolve framework defaults.');
  }

  let seeds: any = null;
  try {
    const themeJson = JSON.parse(fs.readFileSync(path.join(themeDir, 'theme.json'), 'utf8'));
    if (isPlainObject(themeJson) && isPlainObject(themeJson.seeds)) seeds = themeJson.seeds;
  } catch { /* a theme without a readable theme.json simply declares no seeds */ }

  const declared = parseRootTokens(css);
  const { checks, unmapped } = buildChecks(dt);

  const matches: Comparison[] = [];
  const mismatches: Comparison[] = [];
  for (const check of checks) {
    // seeds.* are theme.json keys, not CSS custom properties.
    const actual = check.token.startsWith('seeds.')
      ? (seeds && typeof seeds[check.token.slice(6)] === 'string' ? seeds[check.token.slice(6)] : null)
      : resolveToken(check.token, declared, manifest.tokens);
    const expected = normalize(check.expected, check.kind);
    const got = actual === null ? null : normalize(actual, check.kind);
    const entry: Comparison = { token: check.token, expected, actual: got, source: check.source };
    // A token nothing declares is a mismatch, not an omission: the design asks for a value
    // the rendered page will not have.
    (got !== null && got === expected ? matches : mismatches).push(entry);
  }

  return { slug, ok: mismatches.length === 0, matches, mismatches, unmapped };
}

module.exports = { verifyTheme, normalizeColor };
