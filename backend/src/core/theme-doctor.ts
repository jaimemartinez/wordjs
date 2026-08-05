/**
 * WordJS - Theme Doctor
 * Lints an installed theme's style.css/theme.json against the wordjs-ui.css token
 * contract (backend/public/theme-tokens.json, generated from the framework CSS).
 *
 * Read-only and FAIL-OPEN by design: when the manifest is missing or unreadable the
 * report is { available: false } with no findings — the doctor must never break a
 * theme flow (install/activate/render keep working without it). Dependency-free
 * (fs/path only) at load time so the CLI can load it without booting any core
 * subsystem; theme-compile (which needs css-tree) is resolved lazily and only for
 * themes with declarative theme.json sections — absent, its checks are skipped.
 */

const fs = require('fs');
const path = require('path');

// Same cwd conventions as core/themes.ts (the backend always runs from backend/).
const THEMES_DIR = path.resolve('./themes');
const MANIFEST_PATH = path.resolve('./public/theme-tokens.json');
const LAYOUT_SCHEMA_PATH = path.resolve('./public/theme-layouts.schema.json');

// theme.json keys that make a theme "declarative" (the theme-compile v1 contract).
const DECLARATIVE_KEYS = ['seeds', 'archetype', 'tokens', 'styles'];
// Mirror of theme-compile's output markers (kept local so these checks still run when the
// compiler module itself cannot load). The marker text is a documented, stable contract.
const GENERATED_START_PREFIX = '/* @wjs-generated:start';
const GENERATED_END = '/* @wjs-generated:end */';

interface DoctorFinding {
  code: string;
  message: string;
  detail?: any;
}

interface DoctorReport {
  slug: string;
  available: boolean;
  errors: DoctorFinding[];
  warnings: DoctorFinding[];
  info: DoctorFinding[];
}

interface WjsDeclaration {
  name: string;
  value: string;
  selector: string;
  inRoot: boolean;
}

// Colors --wjs-color-<base> that the framework pairs with a --wjs-color-on-<base>
// text color (buttons/badges paint text over these surfaces).
const ON_COLOR_BASES = ['primary', 'secondary', 'danger', 'success', 'warning', 'info'];

// Charset the declarative-token sanitizer accepts; anything outside it can never be
// expressed as a portable token value (informational only in v1).
const PORTABLE_VALUE = /^[#a-zA-Z0-9 ,.%()/_'"-]+$/;

// Ported from scripts/create-40-themes.js (hex2rgb/lum/onColor) — same numbers, so the
// doctor's suggested on-colors match what the theme generator would have emitted.
const hex2rgb = (h: string): number[] => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c: string) => c + c).join('');
  return [0, 2, 4].map((i: number) => parseInt(h.slice(i, i + 2), 16));
};
const lum = (h: string): number => { const [r, g, b] = hex2rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const isHexColor = (v: string): boolean => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());

function levenshtein(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_v: unknown, i: number) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function closestToken(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  // A suggestion further than half the name away is noise, not a typo.
  return best !== null && bestDist <= Math.max(3, Math.floor(name.length / 2)) ? best : null;
}

const matchesType = (value: any, type: string): boolean => {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': case 'string': case 'number': return typeof value === type;
    default: return true; // unknown type keyword → fail-open
  }
};

// Human-readable rendering of what a schema node accepts, for LAYOUT_INVALID_VALUE messages.
function schemaExpectation(schema: any): string {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((v: any) => JSON.stringify(v)).join(', ')}`;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((s: any) => schemaExpectation(s)).join(' or ');
  if (typeof schema.type === 'string') return schema.type === 'object' ? 'an object' : `a ${schema.type}`;
  return 'a supported value';
}

/**
 * Hand-rolled walker for the draft-07 subset theme-layouts.schema.json uses (type, enum,
 * properties + additionalProperties:false, oneOf) — no validator dependency, keeping the
 * doctor loadable without npm deps. Unknown schema constructs are ignored (fail-open, same
 * posture as the token manifest). Pushes LAYOUT_UNKNOWN_KEY / LAYOUT_INVALID_VALUE findings.
 */
function validateLayoutNode(value: any, schema: any, keyPath: string, out: DoctorFinding[]): void {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.oneOf)) {
    const failed: { branch: any; findings: DoctorFinding[] }[] = [];
    for (const branch of schema.oneOf) {
      const findings: DoctorFinding[] = [];
      validateLayoutNode(value, branch, keyPath, findings);
      if (findings.length === 0) return; // any branch accepting the value wins
      failed.push({ branch, findings });
    }
    // Surface the branch whose base type matches the value (its findings describe the closest
    // intent — e.g. sidebar {position:"top"} reports the enum, not "must be a boolean").
    const typed = failed.filter((f) => typeof f.branch.type === 'string' && matchesType(value, f.branch.type));
    if (typed.length === 1) { out.push(...typed[0].findings); return; }
    out.push({
      code: 'LAYOUT_INVALID_VALUE',
      message: `${keyPath} must be ${schemaExpectation(schema)} (got ${JSON.stringify(value)})`,
      detail: { value }
    });
    return;
  }

  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    out.push({
      code: 'LAYOUT_INVALID_VALUE',
      message: `${keyPath} must be ${schemaExpectation(schema)} (got ${JSON.stringify(value)})`,
      detail: { value }
    });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push({
      code: 'LAYOUT_INVALID_VALUE',
      message: `${keyPath} must be ${schemaExpectation(schema)} (got ${JSON.stringify(value)})`,
      detail: { value, allowed: schema.enum }
    });
    return;
  }

  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const known = Object.keys(schema.properties);
    for (const [key, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        validateLayoutNode(v, schema.properties[key], `${keyPath}.${key}`, out);
      } else if (schema.additionalProperties === false) {
        const suggestion = closestToken(key, known);
        const finding: DoctorFinding = {
          code: 'LAYOUT_UNKNOWN_KEY',
          message: `${keyPath}.${key} is not a recognized layout key${suggestion ? ` — did you mean ${suggestion}?` : ''}`
        };
        if (suggestion) finding.detail = { suggestion };
        out.push(finding);
      }
    }
  }
}

/**
 * Extract every `--wjs-*: value` declaration from (comment-stripped) CSS. Flat regex walk:
 * matches each `selector { body }` pair; rules nested in @media still match because their
 * own braces are balanced. The selector is what follows the last `;` in the prelude, so
 * top-level statements (@import/@charset) glued before a block don't pollute it.
 */
function parseWjsDeclarations(css: string): WjsDeclaration[] {
  const decls: WjsDeclaration[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(css)) !== null) {
    const selector = (m[1].split(';').pop() || '').trim();
    const inRoot = selector.split(',').some((s: string) => s.trim().startsWith(':root'));
    for (const raw of m[2].split(';')) {
      const d = raw.match(/^\s*(--wjs-[a-zA-Z0-9_-]+)\s*:\s*([\s\S]*?)\s*$/);
      if (d) decls.push({ name: d[1], value: d[2], selector, inRoot });
    }
  }
  return decls;
}

/**
 * Lint a theme against the token manifest. `opts` ({ themesDir, manifestPath }) exists
 * for tests, mirroring installThemeFromDir. Errors only when the theme itself is
 * unreadable — or, for declarative themes, when the compiler rejects theme.json (those
 * sections are inert until they compile, so compiler errors ARE errors here).
 * `opts.compile` is a test escape hatch mirroring compileTheme's `derive`: pass null to
 * simulate an absent compiler; production resolves ./theme-compile lazily (fail-open).
 */
function analyzeTheme(slug: string, opts: { themesDir?: string; manifestPath?: string; layoutSchemaPath?: string; compile?: any; chromeValidate?: any } = {}): DoctorReport {
  const report: DoctorReport = { slug, available: false, errors: [], warnings: [], info: [] };

  // FAIL-OPEN: no manifest (or a corrupt one) → no contract to lint against.
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifestPath || MANIFEST_PATH), 'utf8'));
  } catch {
    return report;
  }
  if (!manifest || typeof manifest.tokens !== 'object' || manifest.tokens === null) return report;
  report.available = true;

  // Same slug shape installThemeFromDir enforces — containment even though we only read.
  const themesDir = path.resolve(opts.themesDir || THEMES_DIR);
  if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(slug)) {
    report.errors.push({ code: 'THEME_NOT_FOUND', message: `Invalid theme slug: ${JSON.stringify(slug)}` });
    return report;
  }
  const themeDir = path.join(themesDir, slug);
  let dirStat: any = null;
  try { dirStat = fs.statSync(themeDir); } catch { /* missing */ }
  if (!dirStat || !dirStat.isDirectory()) {
    report.errors.push({ code: 'THEME_NOT_FOUND', message: `No theme installed at themes/${slug}` });
    return report;
  }

  // theme.json is optional; a malformed one still renders (parseThemeMetadata falls back
  // to defaults) so it is a warning, not an error.
  const themeJsonPath = path.join(themeDir, 'theme.json');
  let themeJson: any = null;
  if (fs.existsSync(themeJsonPath)) {
    try {
      themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
    } catch (e) {
      report.warnings.push({ code: 'THEME_JSON_INVALID', message: `theme.json is not valid JSON: ${e.message}` });
    }
  }

  // LAYOUT_UNKNOWN_KEY / LAYOUT_INVALID_VALUE — theme.json "layout" against the structure
  // schema (backend/public/theme-layouts.schema.json). FAIL-OPEN like the token manifest:
  // a missing or corrupt schema simply skips the layout checks.
  if (themeJson && typeof themeJson === 'object' && themeJson.layout !== undefined) {
    try {
      const layoutSchema = JSON.parse(
        fs.readFileSync(path.resolve(opts.layoutSchemaPath || LAYOUT_SCHEMA_PATH), 'utf8')
      );
      if (layoutSchema && typeof layoutSchema === 'object') {
        validateLayoutNode(themeJson.layout, layoutSchema, 'layout', report.warnings);
      }
    } catch { /* fail-open */ }
  }

  // CHROME_INVALID / CHROME_UNREADABLE — composable chrome compositions the theme ships
  // (chrome/header.json / chrome/footer.json, contract v1). The runtime renderer fail-closes
  // on a bad file (falls back to the next precedence level), so at authoring time a contract
  // violation is an ERROR (the file is inert); a file that cannot be read or parsed at all is
  // a warning. FAIL-OPEN like the compiler: when chrome-validate cannot load, the checks are
  // skipped. `opts.chromeValidate` mirrors `opts.compile` (test escape hatch; pass null to
  // simulate an absent validator).
  let chromeValidate: any;
  if (Object.prototype.hasOwnProperty.call(opts, 'chromeValidate')) chromeValidate = opts.chromeValidate;
  else { try { chromeValidate = require('./chrome-validate'); } catch { chromeValidate = null; } }
  if (chromeValidate && typeof chromeValidate.validateChromeData === 'function') {
    for (const part of ['header', 'footer']) {
      const chromeJsonPath = path.join(themeDir, 'chrome', `${part}.json`);
      if (!fs.existsSync(chromeJsonPath)) continue;
      let rawChrome: string | null = null;
      try { rawChrome = fs.readFileSync(chromeJsonPath, 'utf8'); } catch { /* unreadable */ }
      let verdict: any = null;
      if (rawChrome !== null) {
        try { verdict = chromeValidate.validateChromeData(rawChrome, { part }); } catch { continue; } // fail-open
      }
      if (rawChrome === null
        || (verdict && Array.isArray(verdict.errors) && verdict.errors.some((e: any) => e.code === 'CHROME_INVALID_JSON'))) {
        // Non-JSON counts as unreadable too: the renderer never gets past parsing it.
        report.warnings.push({
          code: 'CHROME_UNREADABLE',
          message: `chrome/${part}.json is unreadable or not valid JSON — the renderer falls back to the next chrome level`
        });
        continue;
      }
      if (verdict && verdict.ok === false && Array.isArray(verdict.errors)) {
        for (const e of verdict.errors) {
          report.errors.push({
            code: 'CHROME_INVALID',
            message: `chrome/${part}.json ${e.path}: ${e.message}`,
            detail: { part, path: e.path, rule: e.code }
          });
        }
      }
    }
  }

  let css: string;
  try {
    css = fs.readFileSync(path.join(themeDir, 'style.css'), 'utf8');
  } catch {
    report.errors.push({ code: 'STYLE_UNREADABLE', message: 'style.css is missing or unreadable — nothing to lint' });
    return report;
  }

  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = parseWjsDeclarations(cleaned);
  const declared = new Map<string, string>();
  for (const d of decls) declared.set(d.name, d.value); // last declaration wins, like the cascade

  const tokens: any = manifest.tokens;
  // Editor-internal tokens are excluded from typo suggestions: EDITOR_INTERNAL forbids
  // declaring them, so proposing one would be contradictory advice.
  const tokenNames: string[] = Object.keys(tokens).filter(
    (n: string) => !(Array.isArray(tokens[n].flags) && tokens[n].flags.includes('editor-internal'))
  );

  // UNKNOWN_TOKEN / ALIAS_OVERRIDE / EDITOR_INTERNAL — per declared token name.
  for (const name of declared.keys()) {
    if (/^--wjs-r-/.test(name)) {
      report.warnings.push({
        code: 'EDITOR_INTERNAL',
        message: `${name} is an editor-internal token (injected inline per block instance) — themes must not declare it`
      });
      continue;
    }
    const entry = tokens[name];
    if (!entry) {
      const suggestion = closestToken(name, tokenNames);
      const finding: DoctorFinding = {
        code: 'UNKNOWN_TOKEN',
        message: `${name} is not in the token contract${suggestion ? ` — did you mean ${suggestion}?` : ''}`
      };
      if (suggestion) finding.detail = { suggestion };
      report.warnings.push(finding);
      continue;
    }
    if (Array.isArray(entry.flags) && entry.flags.includes('alias')) {
      const canonical = typeof entry.declaredDefault === 'string'
        ? (entry.declaredDefault.match(/var\((--wjs-[a-zA-Z0-9_-]+)/) || [])[1]
        : undefined;
      const finding: DoctorFinding = {
        code: 'ALIAS_OVERRIDE',
        message: `${name} is an alias — declaring it overrides the canonical ${canonical || 'token it remaps'}; declare ${canonical || 'the canonical token'} instead`
      };
      if (canonical) finding.detail = { canonical };
      report.warnings.push(finding);
    }
  }

  // MISSING_ON_COLOR — a surface color without its paired text color.
  for (const base of ON_COLOR_BASES) {
    const color = declared.get(`--wjs-color-${base}`);
    if (color === undefined || declared.has(`--wjs-color-on-${base}`)) continue;
    const finding: DoctorFinding = {
      code: 'MISSING_ON_COLOR',
      message: `--wjs-color-${base} is declared without --wjs-color-on-${base} — text on ${base} surfaces falls back to the framework default`
    };
    if (isHexColor(color)) {
      const suggested = lum(color.trim()) < 0.55 ? '#ffffff' : '#111111';
      finding.message += `; suggested by luminance: ${suggested}`;
      finding.detail = { suggested };
    }
    report.warnings.push(finding);
  }

  // LOW_CONTRAST — every text/background pair the page actually paints.
  //
  // This used to check ONE pair (main text over the canvas) at 3:1, which is how a catalogue theme
  // shipped a call-to-action with a 2.15:1 label and a clean doctor report. The pairs below are the
  // ones a visitor reads: the button they click, the link they follow, the footer they scan, the
  // hero headline. Each resolves through the same fallback chain wordjs-ui.css uses, so a theme that
  // sets only --wjs-color-primary is judged on the colour its buttons will really have.
  //
  // Ratios use the real WCAG relative luminance, not the `lum` luma above — that one exists to pick
  // an on-colour and is pinned byte-for-byte against the generator, so it cannot be changed here.
  const relLum = (h: string): number => {
    const c = hex2rgb(h.trim()).map((v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x: number, y: number) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** First declared token in the chain, as a hex colour, or undefined. */
  const resolve = (chain: string[]): string | undefined => {
    for (const name of chain) {
      const v = declared.get(name);
      if (v !== undefined && isHexColor(v)) return v.trim();
    }
    return undefined;
  };
  /**
   * Backgrounds only. A theme that says `--wjs-button-bg: transparent` has an OUTLINE button, and
   * its label sits on the page, not on the fill: chaining on to --wjs-color-primary would compare
   * the gold label against a gold fill that is never painted and report a 1.00:1 that does not
   * exist. Anything non-hex (transparent, none, a gradient) means "whatever is behind me".
   */
  const resolveBg = (chain: string[]): string | undefined => {
    const first = declared.get(chain[0]);
    if (first !== undefined && !isHexColor(first)) {
      return resolve(['--wjs-bg-surface', '--wjs-bg-canvas']);
    }
    return resolve(chain);
  };

  // [label, foreground chain, background chain, minimum]. 3:1 is the WCAG large-text threshold and
  // is only used where the text really is large (hero headline); everything else is body size.
  const CONTRAST_PAIRS: Array<[string, string[], string[], number]> = [
    ['body text on the page', ['--wjs-color-text-main'], ['--wjs-bg-canvas'], 4.5],
    ['muted text on the page', ['--wjs-color-text-muted'], ['--wjs-bg-canvas'], 4.5],
    ['headings on the page', ['--wjs-color-heading'], ['--wjs-bg-canvas'], 3],
    ['links on the page', ['--wjs-color-link'], ['--wjs-bg-canvas'], 4.5],
    ['text on a surface', ['--wjs-color-text-main'], ['--wjs-bg-surface', '--wjs-bg-canvas'], 4.5],
    ['button labels', ['--wjs-button-color', '--wjs-color-on-primary'], ['--wjs-button-bg', '--wjs-color-primary'], 4.5],
    ['nav items', ['--wjs-nav-color', '--wjs-color-text-main'], ['--wjs-bg-surface', '--wjs-bg-canvas'], 4.5],
    ['footer text', ['--wjs-color-text-footer-main', '--wjs-footer-text-heading'], ['--wjs-bg-footer', '--wjs-footer-bg'], 4.5],
    ['muted footer text', ['--wjs-color-text-footer-dim', '--wjs-footer-text-body'], ['--wjs-bg-footer', '--wjs-footer-bg'], 4.5],
    ['the hero headline', ['--wjs-hero-title-color'], ['--wjs-hero-bg'], 3],
    ['card titles', ['--wjs-card-title-color', '--wjs-color-heading'], ['--wjs-card-bg', '--wjs-bg-surface'], 4.5],
  ];

  for (const [label, fgChain, bgChain, min] of CONTRAST_PAIRS) {
    const fg = resolve(fgChain);
    const bg = resolveBg(bgChain);
    // Only judge a pair the theme actually decided: if neither side is declared there is nothing to
    // answer for, and the framework defaults are the framework's problem.
    if (fg === undefined || bg === undefined) continue;
    if (!declared.has(fgChain[0]) && !declared.has(bgChain[0])) continue;
    const ratio = contrast(fg, bg);
    if (ratio >= min) continue;
    report.warnings.push({
      code: 'LOW_CONTRAST',
      message: `${label}: ${fgChain[0]} on ${bgChain[0]} is ${ratio.toFixed(2)}:1 (needs ${min}:1)`,
      detail: { pair: label, ratio: Number(ratio.toFixed(2)), minimum: min, text: fg, background: bg }
    });
  }

  // IMPORTANT_CENSUS — !important defeats the token cascade; count is informational.
  const importantCount = (cleaned.match(/!\s*important\b/gi) || []).length;
  report.info.push({
    code: 'IMPORTANT_CENSUS',
    message: `style.css uses !important ${importantCount} time(s)`,
    detail: { count: importantCount }
  });

  // EXTERNAL_REF — http(s):// or protocol-relative // in @import/url(): blocked by the
  // public site's security posture and a third-party fetch on every page view.
  const externalRe = /(?:@import\s+(?:url\(\s*)?|url\(\s*)['"]?\s*((?:https?:)?\/\/[^)'";\s]+)/gi;
  let em: RegExpExecArray | null;
  while ((em = externalRe.exec(cleaned)) !== null) {
    report.warnings.push({
      code: 'EXTERNAL_REF',
      message: `external reference ${em[1]} — self-host the asset (external fetches clash with CSP and add a per-view request)`,
      detail: { url: em[1] }
    });
  }

  // UNPORTABLE_VALUE — :root values the declarative-token sanitizer would reject.
  const reported = new Set<string>();
  for (const d of decls) {
    if (!d.inRoot || reported.has(d.name)) continue;
    const v = d.value;
    if (v.length <= 120 && PORTABLE_VALUE.test(v) && !v.includes('//') && !/url\(/i.test(v)) continue;
    reported.add(d.name);
    report.info.push({
      code: 'UNPORTABLE_VALUE',
      message: `${d.name} value is not portable to declarative tokens (sanitizer charset/length)`,
      detail: { value: v.length > 120 ? `${v.slice(0, 117)}...` : v }
    });
  }

  // GENERATED_MARKERS — the generated block must appear exactly once and be closed. Counted on
  // the RAW css (the markers are comments, stripped from `cleaned`) and independent of the
  // declarative sections, since a leftover block outlives them. A second block is not
  // cosmetic: it comes later in the file, so it WINS the cascade until the next compile
  // collapses the duplicates — and an unclosed start marker is never touched by writeCompiled
  // (it refuses to guess where the block ends), so it survives every recompile.
  const countMarker = (marker: string): number => css.split(marker).length - 1;
  const starts = countMarker(GENERATED_START_PREFIX);
  const ends = countMarker(GENERATED_END);
  if (starts > 1 || starts !== ends) {
    report.warnings.push({
      code: 'GENERATED_MARKERS',
      message: `style.css has ${starts} @wjs-generated:start and ${ends} @wjs-generated:end marker(s) — expected one matched pair; a duplicate block wins the cascade and an unclosed one is left as-is — recompile: node backend/cli/wordjs.js build theme ${slug}`,
      detail: { starts, ends }
    });
  }

  // --- declarative sections (theme-compile v1 contract) × compiler ---------------------
  const hasDeclarative = themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)
    && DECLARATIVE_KEYS.some((k: string) => themeJson[k] !== undefined);

  // LEGACY_THEME — a theme.json with no "generator" stamp and none of the declarative
  // sections predates the theme-compile v1 contract. Informational nudge only: legacy
  // themes keep working, but the first-party catalog is declarative and migrating buys
  // the compiler's diagnostics and portable tokens.
  if (themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)
    && !hasDeclarative && themeJson.generator === undefined) {
    report.info.push({
      code: 'LEGACY_THEME',
      message: 'legacy hand-authored theme — consider migrating to declarative theme.json (see docs)'
    });
  }

  if (hasDeclarative) {
    const blockStart = css.indexOf(GENERATED_START_PREFIX);
    const blockEnd = css.indexOf(GENERATED_END);
    const hasBlock = blockStart !== -1 && blockEnd >= blockStart;

    // STALE_GENERATED is a pure fs check — it must not depend on the compiler loading.
    if (!hasBlock) {
      report.warnings.push({
        code: 'STALE_GENERATED',
        message: `theme.json has declarative sections but style.css has no @wjs-generated block — run: node backend/cli/wordjs.js build theme ${slug}`
      });
    }

    // FAIL-OPEN like the manifest/layout schema: no compiler (e.g. css-tree missing) →
    // skip its diagnostics and the drift check, everything above already ran.
    let compile: any;
    if (Object.prototype.hasOwnProperty.call(opts, 'compile')) compile = opts.compile;
    else { try { compile = require('./theme-compile'); } catch { compile = null; } }
    if (compile && typeof compile.compileTheme === 'function') {
      let compiled: any = null;
      try {
        compiled = compile.compileTheme(slug, {
          themesDir,
          manifestPath: path.resolve(opts.manifestPath || MANIFEST_PATH),
          dryRun: true
        });
      } catch { /* a compiler crash must never break the doctor */ }
      if (compiled && Array.isArray(compiled.diagnostics)) {
        // Compiler codes are re-namespaced DECLARATIVE_* so they can never collide with
        // the doctor's own (both sides emit e.g. THEME_JSON_INVALID).
        for (const d of compiled.diagnostics) {
          const finding: DoctorFinding = {
            code: `DECLARATIVE_${d.code}`,
            message: `theme.json ${d.path}: ${d.message}`,
            detail: d.suggestion ? { path: d.path, suggestion: d.suggestion } : { path: d.path }
          };
          (d.level === 'error' ? report.errors : report.warnings).push(finding);
        }
        // GENERATED_DRIFT — only comparable when the dry run actually produced a block.
        if (hasBlock && typeof compiled.css === 'string' && compiled.css.length > 0
          && css.slice(blockStart, blockEnd + GENERATED_END.length) !== compiled.css) {
          report.info.push({
            code: 'GENERATED_DRIFT',
            message: `the @wjs-generated block in style.css differs from what theme.json compiles to — recompile to sync: node backend/cli/wordjs.js build theme ${slug}`
          });
        }
      }
    }
  }

  return report;
}

// closestToken is shared with theme-compile.ts (same typo-suggestion semantics for
// tokens, elements and CSS properties) — additive export, the doctor API is unchanged.
module.exports = { analyzeTheme, closestToken };
