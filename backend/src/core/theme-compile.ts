/**
 * WordJS - Theme Compiler
 * Compiles the declarative theme.json v1 contract (seeds / archetype / tokens / styles)
 * into a marked, regenerable block inside the theme's style.css.
 *
 * Security posture: nothing user-controlled is ever concatenated into the output as-is.
 * Token values are constrained to the F1 portable charset; declaration values are parsed
 * with css-tree, matched against the property grammar and RE-SERIALIZED FROM THE AST —
 * which is what kills `red;} body{...}` style injection. url() is allowed only for the
 * theme's own /themes/<slug>/ assets. @import and author selectors cannot be expressed.
 *
 * LIMITATION — var() cannot appear in a "styles" DECLARATION value: substitution is only
 * resolved at render time, so css-tree answers matchProperty() with "Matching for a tree
 * with var() is not supported" and the declaration is refused as VALUE_INVALID. The route
 * for var() is the "tokens" map instead: token values land verbatim in `:root`, which is
 * where a reference to another token belongs — and a style key that RESOLVES to a token
 * takes that route too (the token grammar check below has no opinion on var() values for
 * the same reason). Same limitation, author-facing, in documentation/themes.md.
 *
 * compileTheme(dirOrSlug, { slug?, themesDir?, manifestPath?, dryRun?, derive? })
 *   → { css, diagnostics, stats }        (css = the complete marked block)
 * writeCompiled(dir, blockCss) swaps only the marked block in style.css (prepends when
 * absent), preserving manual CSS outside the markers byte for byte. Atomic (tmp+rename).
 */

const fs = require('fs');
const path = require('path');
const csstree = require('css-tree');
const { closestToken } = require('./theme-doctor');

// Same cwd conventions as core/themes.ts (the backend always runs from backend/).
const THEMES_DIR = path.resolve('./themes');
const MANIFEST_PATH = path.resolve('./public/theme-tokens.json');

interface Diagnostic {
  level: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
  suggestion?: string;
}

interface CompileStats {
  tokens: number;
  declarations: number;
  rules: number;
  errors: number;
  warnings: number;
}

interface CompileResult {
  css: string;
  diagnostics: Diagnostic[];
  stats: CompileStats;
}

interface CompileOpts {
  slug?: string;
  themesDir?: string;
  manifestPath?: string;
  dryRun?: boolean;
  // Test escape hatch for the theme-derive contract ({ deriveTokens, archetypeCss,
  // ARCHETYPE_NAMES }); production resolves ./theme-derive lazily at compile time.
  derive?: any;
}

interface WalkCtx {
  el: string;
  child: string | null;
  selector: string;
  media: string | null;
  state: string | null;
  children: any;
}

// Same slug shape installThemeFromDir/theme-doctor enforce — containment under themesDir.
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
// F1 sanitizer rules for portable token values (mirrors the customizer/doctor charset).
const TOKEN_VALUE_RE = /^[#a-zA-Z0-9 ,.%()/_'"-]+$/;
const TOKEN_NAME_RE = /^--wjs-[a-zA-Z0-9_-]+$/;
const SEED_RE = /^#[0-9a-fA-F]{6}$/;
const SEED_KEYS = ['primary', 'secondary', 'bg', 'text'];
const MAX_TOKEN_VALUE = 120;
const MAX_DECL_VALUE = 300;
const MAX_DECLARATIONS = 2000;
const MAX_THEME_JSON = 256 * 1024;

const GLOBAL_ELEMENTS: Record<string, string> = {
  body: 'body',
  headings: 'h1,h2,h3,h4,h5,h6',
  links: 'a'
};
const STATES: Record<string, string> = { hover: ':hover', focus: ':focus', active: ':active', disabled: ':disabled' };
// The framework's breakpoints — declaration order is also the emission order.
const BREAKPOINTS: Record<string, string> = {
  mobile: '(max-width: 767.98px)',
  tablet: '(min-width: 768px) and (max-width: 1023.98px)',
  desktop: '(min-width: 1024px)'
};
// Used only until theme-derive lands (it exports the authoritative ARCHETYPE_NAMES).
const ARCHETYPE_FALLBACK = ['cyber', 'brutalist', 'editorial', 'glassmorphism', 'organic', 'obsidian'];

const MARKER_START_PREFIX = '/* @wjs-generated:start';
const MARKER_END = '/* @wjs-generated:end */';
const markerStart = (slug: string): string =>
  `/* @wjs-generated:start — compiled from theme.json; DO NOT EDIT inside. Edit theme.json and run: node backend/cli/wordjs.js build theme ${slug} */`;

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

// css-tree's lexer also knows legacy/nonstandard properties through its own patches (IE
// `behavior` even matches url() syntax) — the contract admits only standard CSS, so the
// accept-set is lexer-known ∩ mdn-data status "standard".
let STANDARD_PROPS: Set<string> | null = null;
function standardProps(): Set<string> {
  if (!STANDARD_PROPS) {
    const known: string[] = Object.keys(csstree.lexer.properties);
    let mdn: any = null;
    try { mdn = require('mdn-data/css/properties.json'); } catch { /* fall back to lexer-known */ }
    STANDARD_PROPS = new Set(mdn ? known.filter((n: string) => mdn[n] && mdn[n].status === 'standard') : known);
  }
  return STANDARD_PROPS;
}

// F1 value rules shared by explicit tokens, style-resolved tokens and derived tokens.
function tokenValueProblem(raw: any): string | null {
  const value = typeof raw === 'number' ? String(raw) : raw;
  if (typeof value !== 'string' || value.trim().length === 0) return 'must be a non-empty string';
  if (value.length > MAX_TOKEN_VALUE) return `is longer than ${MAX_TOKEN_VALUE} chars`;
  if (value.includes('\\')) return 'contains a backslash';
  if (value.includes('//')) return 'contains "//"';
  if (/url\s*\(/i.test(value)) return 'contains url() (not allowed in token values)';
  if (!TOKEN_VALUE_RE.test(value)) return 'contains characters outside the portable token charset';
  // A token value is emitted verbatim into `:root`, so it must be a COMPLETE CSS value on its own.
  // The charset above admits '(' and quotes, and an unbalanced one keeps the CSS parser inside that
  // construct: everything after the token — the rest of the block, and every rule following it in
  // style.css — is swallowed as part of the value. The stylesheet then loads with no error anywhere,
  // just silently missing most of itself. Cheap structural check; the grammar of the consuming
  // properties is checked separately (tokenGrammarProblem, warning-level).
  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return 'closes a parenthesis that was never opened';
  }
  if (depth !== 0) return 'leaves a parenthesis unclosed';
  if (quote) return 'leaves a quote unclosed';
  return null;
}

const grammarAccepts = (prop: string, value: string): boolean => {
  try { return !csstree.lexer.matchProperty(prop, value).error; } catch { return false; }
};

/**
 * Grammar check for a token value against the properties the manifest says consume it.
 * Returns an example consuming property when EVERY one of them rejects the value, else null.
 *
 * Warning-level on purpose, and deliberately conservative: the manifest records WHICH
 * property reads a token, not HOW — a token spliced into `blur(var(--x))` or
 * `0 0 0 3px var(--x)` is a valid value for nothing on its own. So the framework's own
 * default/fallback for that token is used as a control: if it is rejected too, the model is
 * wrong for this token and nothing is reported (that alone silences ~40% of the manifest,
 * e.g. --wjs-focus-ring, whose only consumer is a box-shadow it never fills alone).
 */
function tokenGrammarProblem(entry: any, value: string): string | null {
  if (!isPlainObject(entry) || !Array.isArray(entry.consumers)) return null;
  // var() is outside matchProperty's reach (see the header) — and a token value MAY point at
  // another token, so this is a no-opinion case, not a finding.
  if (/var\s*\(/i.test(value)) return null;
  const props: string[] = Array.from(new Set<string>(entry.consumers
    .map((c: any) => (isPlainObject(c) && typeof c.property === 'string' ? c.property : ''))
    // A custom property accepts anything: it carries no grammar to check against.
    .filter((p: string) => p !== '' && !p.startsWith('--'))))
    // Shortest name first — "color" reads better than "border-left" in the diagnostic.
    .sort((a: string, b: string) => a.length - b.length || (a < b ? -1 : 1));
  if (props.length === 0) return null;
  if (props.some((p: string) => grammarAccepts(p, value))) return null;
  const controls: string[] = [entry.declaredDefault, ...(Array.isArray(entry.fallbacks) ? entry.fallbacks : [])]
    .filter((v: any) => typeof v === 'string' && v.trim() !== '' && !/var\s*\(/i.test(v));
  for (const p of props) {
    if (controls.some((c: string) => grammarAccepts(p, c))) return p;
  }
  return null;
}

function compileTheme(dirOrSlug: string, opts: CompileOpts = {}): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const stats: CompileStats = { tokens: 0, declarations: 0, rules: 0, errors: 0, warnings: 0 };

  const push = (level: 'error' | 'warning', code: string, p: string, message: string, suggestion?: string | null): void => {
    const d: Diagnostic = { level, code, path: p, message };
    if (suggestion) d.suggestion = suggestion;
    diagnostics.push(d);
  };
  const error = (code: string, p: string, message: string, suggestion?: string | null): void => push('error', code, p, message, suggestion);
  const warning = (code: string, p: string, message: string, suggestion?: string | null): void => push('warning', code, p, message, suggestion);

  const finish = (css: string): CompileResult => {
    stats.errors = diagnostics.filter((d: Diagnostic) => d.level === 'error').length;
    stats.warnings = diagnostics.length - stats.errors;
    return { css, diagnostics, stats };
  };

  // --- resolve theme dir + slug (slug drives the url() policy and the start marker) ---
  const looksLikePath = path.isAbsolute(dirOrSlug) || /[\\/]/.test(dirOrSlug);
  const themeDir = looksLikePath
    ? path.resolve(dirOrSlug)
    : path.join(path.resolve(opts.themesDir || THEMES_DIR), dirOrSlug);
  const slug: string = opts.slug || (looksLikePath ? path.basename(themeDir) : dirOrSlug);
  if (!SLUG_RE.test(slug)) {
    error('THEME_SLUG_INVALID', 'slug', `Invalid theme slug: ${JSON.stringify(slug)}`);
    return finish('');
  }

  // --- manifest (fail-open to a diagnostics error: never throw out of the compiler) ---
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifestPath || MANIFEST_PATH), 'utf8'));
  } catch { manifest = null; }
  if (!manifest || !isPlainObject(manifest.tokens)) {
    error('MANIFEST_MISSING', 'manifest', 'token manifest (public/theme-tokens.json) is missing or unreadable — cannot resolve tokens/elements');
    return finish('');
  }
  const manifestTokens: any = manifest.tokens;
  const manifestElements: any = isPlainObject(manifest.elements) ? manifest.elements : {};
  // Editor-internal tokens are excluded from suggestions (declaring them is forbidden).
  const tokenNames: string[] = Object.keys(manifestTokens).filter(
    (n: string) => !(Array.isArray(manifestTokens[n].flags) && manifestTokens[n].flags.includes('editor-internal'))
  );

  // --- theme.json ---
  const themeJsonPath = path.join(themeDir, 'theme.json');
  let st: any = null;
  try { st = fs.statSync(themeJsonPath); } catch { /* missing */ }
  if (!st || !st.isFile()) {
    error('THEME_JSON_MISSING', 'theme.json', `no theme.json at themes/${slug}`);
    return finish('');
  }
  if (st.size > MAX_THEME_JSON) {
    error('THEME_JSON_TOO_LARGE', 'theme.json', `theme.json is ${st.size} bytes (cap: ${MAX_THEME_JSON})`);
    return finish('');
  }
  let themeJson: any;
  try {
    themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
  } catch (e) {
    error('THEME_JSON_INVALID', 'theme.json', `theme.json is not valid JSON: ${e.message}`);
    return finish('');
  }
  if (!isPlainObject(themeJson)) {
    error('THEME_JSON_INVALID', 'theme.json', 'theme.json must be a JSON object');
    return finish('');
  }

  // --- emitters + global declaration cap ---
  const rootTokens = new Map<string, string>();
  // mediaKey '' = base rules; per media, selectors keep first-appearance order.
  const buckets = new Map<string, Map<string, string[]>>();
  let total = 0;
  let capReported = false;
  const reserve = (p: string): boolean => {
    if (total >= MAX_DECLARATIONS) {
      if (!capReported) {
        capReported = true;
        error('TOO_MANY_DECLARATIONS', p, `over the ${MAX_DECLARATIONS}-declaration cap — remaining declarations dropped`);
      }
      return false;
    }
    total++;
    return true;
  };
  const addToken = (name: string, value: string, p: string): void => {
    if (!rootTokens.has(name) && !reserve(p)) return;
    rootTokens.set(name, value);
    // Every route into :root lands here (seeds, tokens map, token-resolving style keys), so
    // the grammar check runs once for all three instead of at each call site.
    const consumedBy = tokenGrammarProblem(manifestTokens[name], value);
    if (consumedBy) {
      warning('TOKEN_VALUE_GRAMMAR', p,
        `${name}: ${JSON.stringify(value)} is not a valid value for any property that consumes this token (e.g. "${consumedBy}") — it will be ignored where it is used`);
    }
  };
  const addDecl = (mediaKey: string, selector: string, prop: string, value: string, p: string): void => {
    if (!reserve(p)) return;
    let rules = buckets.get(mediaKey);
    if (!rules) { rules = new Map(); buckets.set(mediaKey, rules); }
    let list = rules.get(selector);
    if (!list) { list = []; rules.set(selector, list); }
    list.push(`${prop}: ${value}`);
  };

  // --- seeds → derived palette (theme-derive contract, lazy so tsc/boot never depend on it) ---
  let derive: any = opts.derive || null;
  if (!derive) {
    try { derive = require('./theme-derive'); } catch { derive = null; }
  }
  const seeds: any = themeJson.seeds;
  if (seeds !== undefined) {
    if (!isPlainObject(seeds)) {
      error('SEEDS_INVALID', 'seeds', '"seeds" must be an object of #rrggbb colors');
    } else {
      let seedsOk = true;
      for (const k of SEED_KEYS) {
        if (seeds[k] !== undefined && !SEED_RE.test(String(seeds[k]))) {
          seedsOk = false;
          error('SEED_INVALID', `seeds.${k}`, `seeds.${k} must be a #rrggbb color (got ${JSON.stringify(seeds[k])})`);
        }
      }
      // deriveTokens() reads all four seeds unconditionally, so a partial map used to reach it
      // and come back as a raw JS TypeError under DERIVE_FAILED. Refuse it here with a
      // diagnostic that names what is missing (a missing seed is an authoring mistake, not a
      // derivation failure).
      const missing = SEED_KEYS.filter((k: string) => seeds[k] === undefined);
      if (missing.length > 0) {
        seedsOk = false;
        error('SEEDS_INCOMPLETE', 'seeds', `seeds is missing ${missing.join(', ')} — all four (${SEED_KEYS.join(', ')}) are required to derive the palette`);
      }
      if (seedsOk) {
        if (!derive || typeof derive.deriveTokens !== 'function') {
          error('DERIVE_UNAVAILABLE', 'seeds', 'theme-derive is not available — seeds cannot be expanded into the palette');
        } else {
          let derived: any = null;
          try { derived = derive.deriveTokens(seeds); } catch (e) {
            error('DERIVE_FAILED', 'seeds', `deriveTokens threw: ${e.message}`);
          }
          if (derived !== null && !isPlainObject(derived)) {
            error('DERIVE_FAILED', 'seeds', 'deriveTokens did not return a token map');
          } else if (derived) {
            for (const [name, value] of Object.entries(derived)) {
              const problem = tokenValueProblem(value);
              if (!TOKEN_NAME_RE.test(name) || problem) {
                warning('DERIVED_TOKEN_INVALID', 'seeds', `derived token ${name} skipped${problem ? `: value ${problem}` : ': invalid name'}`);
              } else {
                addToken(name, String(value), 'seeds');
              }
            }
          }
        }
      }
    }
  }

  // --- archetype (personality label; NO LONGER emits CSS) ---
  //
  // The archetype presets used to append a block of hand-written CSS to every compiled stylesheet:
  // `.theme-container`, `.theme-hero`, `.theme-card-grid`, `.theme-card`, `.theme-badge`,
  // `button.theme-btn`, plus bare `body {}` and `h1, h2, h3 {}` rules. That is the LEGACY theme model
  // and it is retired — themes are declarative now, and a theme's look must come from the --wjs-*
  // token contract alone.
  //
  // Removing it loses nothing and fixes two things:
  //   - The `.theme-*` classes are DEMO markup. Nothing in the CMS renders them — not the block
  //     components, not a theme template, not functions.js (verified across the whole tree). They were
  //     dead bytes shipped to every visitor of 58 of the 64 catalogue themes.
  //   - The `body` and `h1, h2, h3` rules were the only live ones, and they are pure duplication:
  //     wordjs-ui.css already sets exactly those properties from --wjs-font-family-base /
  //     --wjs-color-text-main / --wjs-bg-canvas / --wjs-font-family-heading / --wjs-color-heading. As
  //     bare ELEMENT selectors they also leaked into surfaces the theme has no business styling.
  //
  // The field itself stays as validated metadata (the CLI's --archetype, the catalogue's grouping), so
  // an unknown name is still an error rather than a silent typo. It just no longer reaches the
  // stylesheet. Note it never fed a single TOKEN either: deriveTokens() takes the four seeds and
  // nothing else, so no theme's palette depends on this.
  const archetype: any = themeJson.archetype;
  if (archetype !== undefined) {
    const names: string[] = derive && Array.isArray(derive.ARCHETYPE_NAMES) ? derive.ARCHETYPE_NAMES : ARCHETYPE_FALLBACK;
    if (typeof archetype !== 'string' || !names.includes(archetype)) {
      const suggestion = typeof archetype === 'string' ? closestToken(archetype, names) : null;
      error('ARCHETYPE_UNKNOWN', 'archetype', `"${archetype}" is not an archetype (${names.join(', ')})${suggestion ? ` — did you mean ${suggestion}?` : ''}`, suggestion);
    }
  }

  // --- explicit tokens map ---
  const tokensMap: any = themeJson.tokens;
  if (tokensMap !== undefined) {
    if (!isPlainObject(tokensMap)) {
      error('TOKENS_INVALID', 'tokens', '"tokens" must be a flat { "--wjs-name": "value" } map');
    } else {
      for (const [name, raw] of Object.entries(tokensMap)) {
        const p = `tokens.${name}`;
        if (/^--wjs-r-/.test(name)) {
          error('TOKEN_EDITOR_INTERNAL', p, `${name} is an editor-internal token — themes must not declare it`);
          continue;
        }
        // --wjs-footer-* is the documented bridge family: valid even before the manifest
        // learns it (the chrome reads those vars directly).
        const isBridge = /^--wjs-footer-[a-zA-Z0-9_-]+$/.test(name);
        if (!Object.prototype.hasOwnProperty.call(manifestTokens, name) && !isBridge) {
          const suggestion = closestToken(name, tokenNames);
          error('TOKEN_UNKNOWN', p, `${name} is not in the token manifest${suggestion ? ` — did you mean ${suggestion}?` : ''}`, suggestion);
          continue;
        }
        if (!TOKEN_NAME_RE.test(name)) {
          error('TOKEN_NAME_INVALID', p, `${name} is not a valid --wjs-* token name`);
          continue;
        }
        const problem = tokenValueProblem(raw);
        if (problem) {
          error('TOKEN_VALUE_INVALID', p, `${name} value ${problem}`);
          continue;
        }
        addToken(name, String(raw), p);
      }
    }
  }

  // --- styles: token-vs-declaration resolution -----------------------------------------

  function validateDeclaration(prop: string, rawValue: string, p: string): string | null {
    if (prop.startsWith('--')) {
      error('PROPERTY_UNKNOWN', p, 'custom properties are only writable through "tokens" or token-resolving style keys');
      return null;
    }
    if (!standardProps().has(prop)) {
      const suggestion = closestToken(prop, Array.from(standardProps()));
      error('PROPERTY_UNKNOWN', p, `"${prop}" is not a standard CSS property${suggestion ? ` — did you mean ${suggestion}?` : ''}`, suggestion);
      return null;
    }
    if (rawValue.length > MAX_DECL_VALUE) {
      error('VALUE_TOO_LONG', p, `value is ${rawValue.length} chars (cap: ${MAX_DECL_VALUE})`);
      return null;
    }
    let ast: any;
    try {
      ast = csstree.parse(rawValue, { context: 'value' });
    } catch (e) {
      error('VALUE_INVALID', p, `value does not parse as CSS: ${e.rawMessage || e.message}`);
      return null;
    }
    let badUrl: string | null = null;
    csstree.walk(ast, {
      visit: 'Url',
      enter(node: any) {
        const u = String(node.value);
        if (badUrl === null && (u.includes('..') || u.includes('\\') || !u.startsWith(`/themes/${slug}/`))) badUrl = u;
      }
    });
    if (badUrl !== null) {
      error('URL_FORBIDDEN', p, `url(${badUrl}) — only this theme's own /themes/${slug}/ assets are allowed`);
      return null;
    }
    const match = csstree.lexer.matchProperty(prop, ast);
    if (match.error) {
      error('VALUE_INVALID', p, `value rejected for "${prop}": ${String(match.error.rawMessage || match.error.message).split('\n')[0]}`);
      return null;
    }
    // Serialize FROM THE AST — the author's raw string never reaches the output.
    return csstree.generate(ast);
  }

  function handleProp(key: string, value: string, ctx: WalkCtx, p: string): void {
    const prop = key.toLowerCase();
    // Token resolution only at the base level: states/breakpoints are ALWAYS declarations.
    if (!ctx.media && !ctx.state) {
      const candidates = ctx.child
        ? [`--wjs-${ctx.el}-${ctx.child}-${prop}`, `--wjs-${ctx.el}-${prop}`]
        : [`--wjs-${ctx.el}-${prop}`];
      const hit = candidates.find((c: string) => Object.prototype.hasOwnProperty.call(manifestTokens, c));
      if (hit) {
        const problem = tokenValueProblem(value);
        if (problem) error('TOKEN_VALUE_INVALID', p, `resolves to ${hit} but the value ${problem}`);
        else addToken(hit, value, p);
        return;
      }
    }
    const cssValue = validateDeclaration(prop, value, p);
    if (cssValue === null) return;
    const selector = ctx.state ? `${ctx.selector}${STATES[ctx.state]}` : ctx.selector;
    addDecl(ctx.media || '', selector, prop, cssValue, p);
  }

  function walkStyleNode(node: any, ctx: WalkCtx, pathPrefix: string): void {
    for (const [key, raw] of Object.entries(node)) {
      const p = `${pathPrefix}.${key}`;
      if (isPlainObject(raw)) {
        if (Object.prototype.hasOwnProperty.call(STATES, key)) {
          if (ctx.state) error('STYLE_UNKNOWN_KEY', p, 'states cannot nest inside states');
          else walkStyleNode(raw, { ...ctx, state: key, children: null }, p);
        } else if (Object.prototype.hasOwnProperty.call(BREAKPOINTS, key)) {
          if (ctx.media || ctx.state) error('STYLE_UNKNOWN_KEY', p, 'breakpoints cannot nest inside states or other breakpoints');
          else walkStyleNode(raw, { ...ctx, media: key }, p);
        } else if (!ctx.child && ctx.children && isPlainObject(ctx.children[key]) && typeof ctx.children[key].selector === 'string') {
          walkStyleNode(raw, { ...ctx, child: key, selector: ctx.children[key].selector }, p);
        } else {
          const valid = [
            ...(ctx.children && !ctx.child ? Object.keys(ctx.children) : []),
            ...Object.keys(STATES),
            ...Object.keys(BREAKPOINTS)
          ];
          const suggestion = closestToken(key, valid);
          error('STYLE_UNKNOWN_KEY', p, `"${key}" is not a child, state or breakpoint here${suggestion ? ` — did you mean ${suggestion}?` : ''}`, suggestion);
        }
      } else if (typeof raw === 'string' || typeof raw === 'number') {
        handleProp(key, String(raw), ctx, p);
      } else {
        error('STYLE_INVALID_VALUE', p, 'style values must be strings/numbers (declarations) or nested objects');
      }
    }
  }

  const styles: any = themeJson.styles;
  if (styles !== undefined) {
    if (!isPlainObject(styles)) {
      error('STYLES_INVALID', 'styles', '"styles" must be an object keyed by element');
    } else {
      for (const [el, node] of Object.entries(styles)) {
        const p = `styles.${el}`;
        let selector: string | null = null;
        let children: any = null;
        if (Object.prototype.hasOwnProperty.call(GLOBAL_ELEMENTS, el)) {
          selector = GLOBAL_ELEMENTS[el];
        } else if (isPlainObject(manifestElements[el]) && typeof manifestElements[el].selector === 'string') {
          selector = manifestElements[el].selector;
          children = isPlainObject(manifestElements[el].children) ? manifestElements[el].children : null;
        }
        if (selector === null) {
          const suggestion = closestToken(el, [...Object.keys(manifestElements), ...Object.keys(GLOBAL_ELEMENTS)]);
          error('ELEMENT_UNKNOWN', p, `"${el}" is not a themable element${suggestion ? ` — did you mean ${suggestion}?` : ''}`, suggestion);
          continue;
        }
        if (!isPlainObject(node)) {
          error('STYLE_INVALID_VALUE', p, `styles.${el} must be an object`);
          continue;
        }
        walkStyleNode(node, { el, child: null, selector, media: null, state: null, children }, p);
      }
    }
  }

  // --- emit the marked block (deterministic order ⇒ recompiling is idempotent) ---
  const lines: string[] = [markerStart(slug)];
  if (rootTokens.size > 0) {
    lines.push(':root {');
    for (const [name, value] of rootTokens) lines.push(`  ${name}: ${value};`);
    lines.push('}');
  }
  const emitRules = (rules: Map<string, string[]>, indent: string): void => {
    for (const [selector, decls] of rules) {
      lines.push(`${indent}${selector} { ${decls.join('; ')} }`);
      stats.rules++;
      stats.declarations += decls.length;
    }
  };
  const base = buckets.get('');
  if (base) emitRules(base, '');
  for (const bp of Object.keys(BREAKPOINTS)) {
    const rules = buckets.get(bp);
    if (!rules) continue;
    lines.push(`@media ${BREAKPOINTS[bp]} {`);
    emitRules(rules, '  ');
    lines.push('}');
  }
  // (no archetype CSS block — see the archetype section above: the legacy preset stylesheet is retired)
  lines.push(MARKER_END);
  const css = lines.join('\n');

  stats.tokens = rootTokens.size;
  if (!opts.dryRun) writeCompiled(themeDir, css);
  return finish(css);
}

/**
 * Replace the marked block in <dir>/style.css with `blockCss` (the full block including
 * both markers). No block → the block is prepended; a missing style.css is created.
 * Everything outside the markers is preserved byte for byte. Atomic within the theme dir.
 */
function writeCompiled(dir: string, blockCss: string): void {
  const target = path.join(path.resolve(dir), 'style.css');
  let existing: string | null = null;
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
  let next: string;
  if (existing !== null) {
    // Replace EVERY marked block, not just the first pair. Taking the first start and the first end
    // leaves any later block untouched, and a stale one sitting AFTER the fresh one wins the cascade —
    // the theme then renders from CSS the author already replaced. Duplicates collapse into one.
    let rest = existing;
    let out = '';
    let replaced = false;
    for (;;) {
      const start = rest.indexOf(MARKER_START_PREFIX);
      if (start === -1) break;
      const endAt = rest.indexOf(MARKER_END, start);
      // A start marker with no closing one is not a block: leave the remainder alone rather than
      // guess where it ends (guessing would delete the author's CSS).
      if (endAt === -1) break;
      out += rest.slice(0, start) + (replaced ? '' : blockCss);
      replaced = true;
      rest = rest.slice(endAt + MARKER_END.length);
    }
    if (replaced) {
      next = out + rest;
    } else {
      next = existing.length > 0 ? `${blockCss}\n\n${existing}` : `${blockCss}\n`;
    }
  } else {
    next = `${blockCss}\n`;
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, next, 'utf8');
  // Windows refuses to replace a file another handle has open (EPERM/EBUSY) — an editor, a virus
  // scanner or the static server reading style.css is enough, and it is transient. POSIX rename has
  // no such failure, so this loop is a no-op there. Retry briefly, then surface the error: the write
  // is atomic either way, so the theme is never left half-written.
  let lastError: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e: any) {
      lastError = e;
      if (e && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
      const until = Date.now() + 40;
      while (Date.now() < until) { /* the callers are synchronous; a short spin is the only wait available */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw lastError;
}

module.exports = { compileTheme, writeCompiled };
