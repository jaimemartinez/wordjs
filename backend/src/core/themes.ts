/**
 * WordJS - Theme System
 * Equivalent to wp-includes/theme.php
 */

const fs = require('fs');
const path = require('path');
const { getOption, updateOption } = require('./options');
const { doAction } = require('./hooks');
// The one place a name becomes a path: allowlist the FORM, resolve canonically, prove containment on
// the value RETURNED (core/safe-path).
const { resolveThemeDir, resolveWithin, isThemeSlug, isPlainSegment } = require('./safe-path');

const THEMES_DIR = path.resolve('./themes');

/**
 * Theme metadata structure
 */
class Theme {
  name: any;
  slug: any;
  version: any;
  description: any;
  author: any;
  authorUri: any;
  screenshot: any;
  path: any;
  templatePath: any;
  layout: any;

  constructor(data: any) {
    this.name = data.name;
    this.slug = data.slug;
    this.version = data.version || '1.0.0';
    this.description = data.description || '';
    this.author = data.author || '';
    this.authorUri = data.authorUri || '';
    this.screenshot = data.screenshot || '';
    this.path = data.path;
    this.templatePath = data.templatePath;
    // Optional structure config from theme.json (e.g. { containerWidth, sidebar, headerStyle }).
    // The Next.js public layout honors it via the active_theme_layout option (see switchTheme).
    this.layout = (data.layout && typeof data.layout === 'object') ? data.layout : null;
  }

  /**
   * Get template file path
   */
  getTemplate(name: string) {
    const templateFile = path.join(this.path, 'templates', `${name}.html`);
    if (fs.existsSync(templateFile)) {
      return templateFile;
    }
    return null;
  }

  /**
   * Get theme stylesheet URL
   */
  getStylesheet() {
    const stylePath = path.join(this.path, 'style.css');
    if (fs.existsSync(stylePath)) {
      return `/themes/${this.slug}/style.css`;
    }
    return null;
  }
}

/**
 * Ensure themes directory exists
 */
function ensureThemesDir() {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }
}

/**
 * Parse theme.json for metadata
 */
function parseThemeMetadata(themeDir: string, slug: string) {
  const metadataFile = path.join(themeDir, 'theme.json');

  let metadata: Record<string, any> = {
    name: slug,
    version: '1.0.0',
    description: '',
    author: ''
  };

  if (fs.existsSync(metadataFile)) {
    try {
      const content = fs.readFileSync(metadataFile, 'utf8');
      metadata = { ...metadata, ...JSON.parse(content) };
    } catch (e) {
      console.error(`Error parsing theme.json for ${slug}:`, e.message);
    }
  }

  // Check for screenshot
  const screenshotFiles = ['screenshot.png', 'screenshot.jpg', 'screenshot.webp'];
  for (const file of screenshotFiles) {
    if (fs.existsSync(path.join(themeDir, file))) {
      metadata.screenshot = `/themes/${slug}/${file}`;
      break;
    }
  }

  return metadata;
}

/**
 * Memoized theme scan.
 *
 * The scan is SYNCHRONOUS fs work: one readdir plus, per theme, a readFile of theme.json and up to
 * three existsSync for the screenshot — ~200 blocking syscalls on a 40-theme install. It ran on every
 * GET /api/v1/themes (public, unauthenticated, polled by the frontend's ThemeLoader on each tab focus)
 * and on every read of the active theme, so it is cached.
 *
 * The TTL is only a backstop: every mutation THIS process performs drops the cache explicitly
 * (switch/delete/install/createDefaultTheme here, the declarative write API + zip upload in
 * routes/themes.ts), so anything done through the app is visible immediately.
 * WORST CASE: a theme added/edited/removed on disk from OUTSIDE the app (scp, git pull, an editor,
 * another node's filesystem) stays invisible for up to SCAN_TTL_MS — no code here observes that write.
 */
const SCAN_TTL_MS = 60_000;
let scanCache: { at: number; records: any[] } | null = null;
const THEME_SCAN_CHANNEL = 'wjs:theme-scan-invalidate';

/**
 * Drop the memoized scan. MUST be called by every path that writes inside THEMES_DIR.
 *
 * Also BROADCASTS so peer nodes drop theirs: a theme installed/switched/deleted through one replica
 * used to stay invisible on the others for up to SCAN_TTL_MS (the memo is per-process). Reuses the
 * object cache's pub/sub, which is a no-op when Redis isn't configured — single-node behaviour is
 * unchanged, and the TTL remains the backstop for out-of-band disk edits either way.
 */
function invalidateThemeScanCache(broadcast = true) {
  scanCache = null;
  if (!broadcast) return;
  try {
    const cache = require('./cache');
    if (cache.pubsubAvailable && cache.pubsubAvailable()) cache.publish(THEME_SCAN_CHANNEL, '1');
  } catch { /* cache module unavailable (unit tests) — local invalidation already happened */ }
}

// Peer invalidation. Subscribing is a no-op without Redis; `false` stops the echo from re-publishing.
try {
  const cache = require('./cache');
  if (cache.subscribe) cache.subscribe(THEME_SCAN_CHANNEL, () => invalidateThemeScanCache(false));
} catch { /* cache module unavailable */ }

/**
 * Scan for installed themes
 */
function scanThemes() {
  const now = Date.now();
  let cached = scanCache;
  if (!cached || now - cached.at >= SCAN_TTL_MS) {
    ensureThemesDir();
    const records: any[] = [];

    const entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const themeDir = path.join(THEMES_DIR, entry.name);
      const metadata = parseThemeMetadata(themeDir, entry.name);

      records.push({
        ...metadata,
        slug: entry.name,
        path: themeDir,
        templatePath: path.join(themeDir, 'templates')
      });
    }

    cached = { at: now, records };
    scanCache = cached;
  }

  // Fresh Theme instances per call, from the cached metadata: callers get exactly what they got
  // before the memo existed (same class, same fields, nothing filtered) and no caller can corrupt
  // another's copy by mutating the array or an instance.
  return cached.records.map((record: any) => new Theme(record));
}

/**
 * Get current active theme slug
 */
async function getCurrentTheme() {
  return await getOption('template', 'default');
}

/**
 * Get current theme object
 */
async function getActiveTheme() {
  const currentSlug = await getCurrentTheme();
  const themes = scanThemes();
  // NO fallback to "whatever theme happens to be installed first". A missing active slug used to
  // resolve to themes[0] — an arbitrary theme decided by directory enumeration order — so deleting or
  // renaming the active theme silently promoted an unrelated one: the site rendered with a look nobody
  // selected, and every derived answer (active_theme_version, the purge check, the SSR layout) agreed
  // with each other while ALL of them disagreed with the `template` option. Resolve honestly or not at
  // all; callers already handle null (getActiveThemeVersion returns '', the purge check is guarded).
  return themes.find(t => t.slug === currentSlug) || null;
}

/**
 * Is the configured active theme absent from disk?
 *
 * getActiveTheme() resolves honestly or not at all (see above), and every downstream caller degrades
 * quietly: getActiveThemeVersion returns '', the SSR layout ships no theme stylesheet, and the public
 * site falls back to the framework's own :root tokens in public/css/wordjs-ui.css. That fallback is
 * CORRECT — the site keeps rendering — but until now it was also SILENT: nothing told the admin that
 * the `template` option names a directory that no longer exists. This is the observable that makes it
 * visible; it is served in the public settings payload (routes/settings.ts) and logged at boot.
 *
 * NEVER THROWS: it is on the settings read path, and a themes-dir hiccup must not 500 it. A scan that
 * cannot be performed reports "not missing" — an unknown is not evidence of breakage, and a false
 * alarm on every settings read would train the admin to ignore the banner.
 */
async function isActiveThemeMissing(): Promise<boolean> {
  try {
    return (await getActiveTheme()) === null;
  } catch {
    return false;
  }
}

/**
 * The files a theme directory MUST carry to be usable, and the slug of the fallback theme.
 *
 * Only these two. functions.js is OPTIONAL by design — theme-engine.loadThemeLogic treats a theme
 * with no functions.js as one that simply owns no logic — and the five legacy Handlebars files
 * (partials/{header,footer}.html, templates/{index,single,archive}.html) feed a renderer with no live
 * callers, so their absence is not a fault worth warning about on every boot. theme.json (metadata,
 * layout, version) and style.css (the --wjs-* tokens the live site actually loads) are the theme.
 */
const DEFAULT_THEME_SLUG = 'default';
const REQUIRED_THEME_FILES = ['theme.json', 'style.css'];

/**
 * READ-ONLY health check of the bundled fallback theme. Writes NOTHING.
 *
 * Boot used to call createDefaultTheme() unconditionally to "guarantee a default theme exists" —
 * which meant the process rewrote files inside a user-owned directory on every restart. No comparable
 * CMS does that: WordPress falls back to WP_DEFAULT_THEME (validate_current_theme), Ghost ships
 * casper in the package and refuses to delete it, Drupal's ThemeInstaller refuses to uninstall the
 * default, Joomla marks core templates locked. Ship a fallback, refuse to delete it, degrade
 * gracefully — never rewrite. So boot now VERIFIES and warns; provisioning stayed where a user asked
 * for it: the install wizard (routes/setup.ts) and POST /api/v1/themes/default (the admin restore).
 */
function verifyDefaultTheme(): { ok: boolean; dir: string; exists: boolean; missing: string[] } {
  const dir = path.join(THEMES_DIR, DEFAULT_THEME_SLUG);
  const exists = fs.existsSync(dir);
  const missing = exists
    ? REQUIRED_THEME_FILES.filter(file => !fs.existsSync(path.join(dir, file)))
    : REQUIRED_THEME_FILES.slice();
  return { ok: exists && missing.length === 0, dir, exists, missing };
}

/**
 * Of the states verifyDefaultTheme() can report, which one is worth an admin's attention at boot?
 *
 * NOT "themes/default is absent". That is a SUPPORTED configuration: deleteTheme() deliberately
 * permits removing the bundled default once it is neither active nor the last theme installed, and a
 * site running a different, healthy theme is not broken by its absence — nothing renders from it, and
 * `POST /api/v1/themes/default` can put it back at any time. Warning on every restart about a state
 * the API grants on request is how an admin learns to skim past the console; the same change that
 * added this check declined to fault the five legacy Handlebars files for exactly that reason.
 *
 * What IS actionable is a default directory that is THERE but incomplete — missing theme.json or
 * style.css. No supported path produces that (createDefaultTheme writes all eight files, and delete
 * removes the tree), so it is corruption: a half-copied upload, an interrupted restore, an editor
 * that removed a file. Activating it would then degrade the whole site to the framework tokens.
 *
 * The remaining bad state — default absent AND the theme the site is configured to render — is not
 * this function's to report: isActiveThemeMissing() already covers it, by slug, with the same restore
 * instruction, and boot prints that warning instead. Two warnings for one fault is the same noise
 * problem in a different shape.
 */
function defaultThemeNeedsAttention(report = verifyDefaultTheme()): boolean {
  return !report.ok && report.exists;
}

/** getOption may hand back a parsed OBJECT or the raw JSON STRING — normalize to the string form. */
function serializeOptionValue(value: any): string {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Republish the ACTIVE theme's manifest `layout` into the active_theme_layout option.
 *
 * switchTheme already writes this when the admin activates a theme, but the option then goes stale on
 * any path that changes the layout WITHOUT a switch — a theme update, an edit to theme.json, or a
 * restore. This is the boot-time reconciliation for those.
 *
 * IDEMPOTENT ON PURPOSE, and that is the whole difficulty: active_theme_layout is on the frontend-purge
 * allowlist, so a needless write evicts the public cache on every boot. getOption can return either the
 * parsed object or the JSON string depending on how the value was stored, and comparing those two
 * representations naively always differs — which is exactly how a "no-op" sync becomes a purge storm.
 * Compare in the serialized form, and write only on a real change.
 *
 * Returns the serialized layout ('' when there is no active theme, or it declares none).
 */
async function syncActiveThemeLayout(): Promise<string> {
  const theme = await getActiveTheme();
  const desired = theme && theme.layout ? JSON.stringify(theme.layout) : '';
  const current = serializeOptionValue(await getOption('active_theme_layout', ''));
  if (current !== desired) await updateOption('active_theme_layout', desired);
  return desired;
}

/**
 * The active theme as ONE runtime snapshot: the slug that renders, the manifest layout, and the live
 * customizer token overrides. Callers that need all three (the SSR public layout, the customizer) were
 * each re-deriving them from separate options and could observe a torn mix — a layout from one theme
 * beside another's mods — mid-activation.
 */
async function getActiveThemeSnapshot(): Promise<{ slug: string; layout: any; mods: any }> {
  const theme = await getActiveTheme();
  const rawMods = await getOption('active_theme_mods', '');
  let mods: any = {};
  if (rawMods && typeof rawMods === 'object') mods = rawMods;
  else if (typeof rawMods === 'string' && rawMods.trim()) {
    try { mods = JSON.parse(rawMods); } catch { mods = {}; }
  }
  return { slug: theme ? theme.slug : '', layout: theme && theme.layout ? theme.layout : null, mods };
}

/**
 * theme.json `version` of the theme that actually renders (same fallback chain as getActiveTheme).
 *
 * Served in the PUBLIC settings payload so the frontend can version the theme stylesheet URL: the
 * build-time asset version cannot see an in-place theme edit, this can. Costs no fs (memoized scan)
 * and no extra SQL (the `template` option is already cached). Never throws — a themes-dir hiccup
 * must not 500 the public settings payload; the stylesheet URL just goes unversioned.
 */
async function getActiveThemeVersion() {
  try {
    const theme = await getActiveTheme();
    return theme ? String(theme.version) : '';
  } catch {
    return '';
  }
}

/**
 * Switch to a different theme.
 *
 * DELIBERATELY NOT JOINED PER SLUG. An earlier version kept a Map<slug, inflight> so a double-clicked
 * "Activate" joined the running switch instead of re-running it. That is unsound here: the join key is the
 * SLUG, but the resource is GLOBAL — there is exactly one active theme. Joining "the same slug" is only
 * correct when no OTHER slug was requested in between, and A -> B -> A inside one window breaks it: the
 * third call joined the first, never ran, and the `template` option was left on B while the API answered
 * `{ success: true, message: "Switched to theme A" }`. The admin's last click was silently lost and
 * `doAction('switch_theme')` fired once, carrying the FIRST call's previousTheme.
 *
 * Losing a write to save a re-fork is a bad trade, and the re-fork was never what made this safe: overlapping
 * activations cannot orphan a child because theme-engine.init() serializes them AND loadIsolatedPlugin
 * retires any live child it would displace (core/plugin-isolate.ts). Correctness does not depend on this
 * function being idempotent, so it does not pretend to be — every call runs, and the last writer wins.
 */
async function switchTheme(slug: string) {
  return doSwitchTheme(slug);
}

async function doSwitchTheme(slug: string) {
  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);

  if (!theme) {
    throw new Error(`Theme ${slug} not found`);
  }

  const previousTheme = await getCurrentTheme();

  await updateOption('template', slug);
  await updateOption('stylesheet', slug);

  // Expose the active theme's structure config to the (SSR) Next.js public layout, and reset any live
  // customizer token overrides (they belong to the previous theme's look). Both are read via getSettings.
  await updateOption('active_theme_layout', theme.layout ? JSON.stringify(theme.layout) : '');
  await updateOption('active_theme_mods', '');

  // Trigger engine re-initialization
  const themeEngine = require('./theme-engine');
  await themeEngine.init();

  await doAction('switch_theme', slug, previousTheme);

  // Activation is the moment everything downstream re-reads the active theme (getActiveThemeVersion
  // → the public settings payload), and both theme-engine.init() and a switch_theme listener may
  // have written inside THEMES_DIR by now — so this runs LAST, after those writes, not before them.
  invalidateThemeScanCache();

  return { success: true, message: `Switched to theme ${theme.name}` };
}

/**
 * Get all themes with their status
 */
async function getAllThemes() {
  const themes = scanThemes();
  const current = await getCurrentTheme();

  return themes.map(theme => ({
    name: theme.name,
    slug: theme.slug,
    version: theme.version,
    description: theme.description,
    author: theme.author,
    screenshot: theme.screenshot,
    layout: theme.layout,
    active: theme.slug === current
  }));
}

/**
 * Render a Handlebars theme template with data.
 * LEGACY: this is NOT the public renderer — the live public site is rendered by the Next.js frontend
 * (which consumes a theme only via its style.css tokens). Kept for potential monolith/standalone use;
 * it currently has no callers.
 */
async function renderTemplate(templateName: string, data = {}) {
  const themeEngine = require('./theme-engine');
  return await themeEngine.render(templateName, data);
}

/**
 * Provision the default theme. USER-INITIATED ONLY — boot does not call this.
 *
 * Two callers, both of them a person asking for the theme to be put on disk: the install wizard
 * (routes/setup.ts, the Ghost-style "ship a fallback at install time") and POST /api/v1/themes/default,
 * the admin's explicit "restore default theme", which passes force=true. Boot instead calls
 * verifyDefaultTheme() and warns — see that function for why no comparable CMS rewrites theme files at
 * runtime.
 *
 * EVERY file goes through writeIfAbsent, and that is load-bearing, not tidiness. The committed
 * default/style.css carries the curated `--wjs-*` design tokens (94 lines) while the `styleCss`
 * fallback below is the old token-less version; writing it unconditionally stripped the tokens on
 * every restart (the recurring "default theme tokens=0" corruption — long misattributed to subagents,
 * it was this write). The same trap was still live for the five legacy Handlebars files
 * (partials/{header,footer}.html, templates/{index,single,archive}.html), which were written with a
 * bare fs.writeFileSync and so destroyed any hand edit on every call. They are guarded now too.
 * `force` overwrites all eight deliberately — that is what "restore" means.
 */
function createDefaultTheme(force = false) {
  const defaultDir = path.join(THEMES_DIR, 'default');
  const writeIfAbsent = (filePath: string, content: string) => {
    if (force || !fs.existsSync(filePath)) fs.writeFileSync(filePath, content);
  };

  // Ensure directories exist
  if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

  fs.mkdirSync(path.join(defaultDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(defaultDir, 'partials'), { recursive: true });

  // theme.json
  const themeJson: Record<string, any> = {
    name: 'WordJS',
    version: '2.0.0',
    description: 'The default WordJS theme — modern, JavaScript-native, developer-first. Signature indigo→violet gradient, Space Grotesk display type, and a deep-indigo footer.',
    author: 'WordJS'
  };
  // A restore rewrites style.css, and the stylesheet URL is keyed by this version — leaving it alone
  // (or resetting it to the literal above, which would move it BACKWARDS) means every browser keeps
  // the copy it already had. Carry the installed version forward by one patch instead.
  if (force) {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(defaultDir, 'theme.json'), 'utf8'));
      const parts = String(current.version || themeJson.version).split('.');
      if (parts.length === 3 && parts.every((p: string) => /^\d+$/.test(p))) {
        themeJson.version = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
      }
    } catch { /* no readable theme.json — the literal version below is the right starting point */ }
  }
  writeIfAbsent(path.join(defaultDir, 'theme.json'), JSON.stringify(themeJson, null, 2));

  // functions.js
  const functionsJs = `/**
 * Theme logic and hooks
 */
module.exports = () => {
    console.log('🎨 Default theme logic loaded!');
};
`;
  writeIfAbsent(path.join(defaultDir, 'functions.js'), functionsJs);

  // style.css — WordJS's own visual identity. This embedded copy is written on `force` (the admin's
  // "restore default theme") or when the file is missing, so it must MATCH the committed
  // themes/default/style.css byte for byte: it had drifted to an old 17-token version, and restoring
  // silently replaced the curated 75-token palette with it. The parity is now asserted by
  // tests/default-theme-parity.test.ts — regenerate this literal from the file, never by hand.
  const styleCss = `/* =========================================================================
   THEME: WORDJS  (default)
   WordJS's own visual identity — modern, JavaScript-native, developer-first.
   Signature indigo→violet gradient, Space Grotesk display + Inter body +
   JetBrains Mono for code. Light, airy canvas with a deep-indigo footer edged
   by the brand gradient. Rounded corners, soft indigo-tinted depth.

   Styles the live (Next.js) public chrome via the .wjs-header- and footer
   hooks and the --wjs- framework tokens — the same contract every theme uses.
   ========================================================================= */

@import url('fonts.css');

:root {
  /* --- SIGNATURE GRADIENT (the WordJS mark) --- */
  --wjs-gradient: linear-gradient(120deg, #4f46e5 0%, #7c3aed 55%, #a855f7 100%);
  --wjs-gradient-soft: linear-gradient(120deg, rgba(79, 70, 229, 0.10), rgba(168, 85, 247, 0.10));

  /* --- COLOR PALETTE: Indigo / Violet --- */
  --wjs-color-primary: #4f46e5;        /* Indigo */
  --wjs-color-primary-dark: #4338ca;
  --wjs-color-secondary: #64748b;      /* Slate */
  --wjs-color-secondary-dark: #475569;
  --wjs-color-accent: #a855f7;         /* Violet */
  --wjs-color-success: #10b981;
  --wjs-color-danger: #ef4444;
  --wjs-color-warning: #f59e0b;
  --wjs-color-info: #3b82f6;
  --wjs-color-light: #f8f9ff;
  --wjs-color-dark: #0b1120;
  /* --- on-color tokens (max-contrast text on each solid color) --- */
  --wjs-color-on-primary: #ffffff;
  --wjs-color-on-secondary: #ffffff;
  --wjs-color-on-success: #ffffff;
  --wjs-color-on-danger: #ffffff;
  --wjs-color-on-warning: #161616;
  --wjs-color-on-info: #ffffff;
  --wjs-color-on-light: #161616;
  --wjs-color-on-dark: #ffffff;

  /* --- SURFACES / TEXT / BORDER --- */
  --wjs-bg-canvas: #f8f9ff;            /* barely-tinted indigo white */
  --wjs-bg-surface: #ffffff;
  --wjs-bg-muted: #f1f2fb;
  --wjs-color-text-main: #1e293b;
  --wjs-color-text-muted: #64748b;
  --wjs-color-heading: #0b1120;
  --wjs-color-link: #4f46e5;
  --wjs-color-link-hover: #7c3aed;
  --wjs-border-subtle: #e6e8f4;
  --wjs-border-width: 1px;
  --wjs-focus-ring: rgba(79, 70, 229, 0.28);

  /* --- NAVIGATION CONFIG --- */
  --wjs-nav-font-family: 'Inter', sans-serif;
  --wjs-nav-font-size: 0.95rem;
  --wjs-nav-font-weight: 500;
  --wjs-nav-text-transform: none;
  --wjs-nav-letter-spacing: 0;
  --wjs-nav-color: #475569;
  --wjs-nav-color-hover: #4f46e5;
  --wjs-nav-transition: color 0.2s ease;
  --wjs-logo-color: #4f46e5;

  /* --- FOOTER CONFIG (deep indigo) --- */
  --wjs-footer-bg: #0b1120;
  --wjs-footer-text-heading: #ffffff;
  --wjs-footer-text-body: #94a3b8;
  --wjs-footer-text-hover: #ffffff;
  --wjs-footer-icon-bg: rgba(255, 255, 255, 0.06);
  --wjs-footer-icon-color: #c4b5fd;

  /* --- TYPOGRAPHY --- */
  --wjs-font-family-base: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --wjs-font-family-heading: 'Space Grotesk', 'Inter', sans-serif;
  --wjs-font-family-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --wjs-font-size-base: 1rem;
  --wjs-line-height-base: 1.7;
  --wjs-heading-weight: 700;
  --wjs-heading-line-height: 1.15;
  --wjs-h1: 3rem;
  --wjs-h2: 2.1rem;
  --wjs-h3: 1.6rem;
  --wjs-h4: 1.3rem;
  --wjs-h5: 1.1rem;
  --wjs-h6: 1rem;

  /* --- SPACING / SHAPE / DEPTH --- */
  --wjs-spacer: 1rem;
  --wjs-radius-sm: 8px;
  --wjs-radius: 12px;
  --wjs-radius-md: 16px;
  --wjs-radius-lg: 24px;
  --wjs-radius-pill: 9999px;
  --wjs-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
  --wjs-shadow: 0 6px 20px -6px rgba(79, 70, 229, 0.15), 0 2px 6px rgba(15, 23, 42, 0.05);
  --wjs-shadow-md: 0 14px 34px -10px rgba(79, 70, 229, 0.22);
  --wjs-shadow-lg: 0 28px 60px -18px rgba(79, 70, 229, 0.30);

  /* --- CARD BLOCK --- keeps this theme's depth and hover lift through the token contract instead of a
     rule that would override whatever colour the author gave an individual card. */
  --wjs-card-radius: var(--wjs-radius-lg);
  --wjs-card-shadow: var(--wjs-shadow-sm);
  --wjs-card-hover-transform: translateY(-3px);
  --wjs-card-hover-shadow: var(--wjs-shadow-md);
  --wjs-card-hover-border-color: rgba(79, 70, 229, 0.35);
}

/* ============================ BASE ============================ */
body {
  background-color: var(--wjs-bg-canvas) !important;
  color: var(--wjs-color-text-main) !important;
  font-family: var(--wjs-font-family-base) !important;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--wjs-font-family-heading) !important;
  color: var(--wjs-color-heading) !important;
  font-weight: 700 !important;
  letter-spacing: -0.02em;
  line-height: var(--wjs-heading-line-height);
}

a { color: var(--wjs-color-link); transition: color 0.2s ease; }
a:hover { color: var(--wjs-color-link-hover); }

code, pre, kbd, samp { font-family: var(--wjs-font-family-mono) !important; }
code:not(pre code) { background: var(--wjs-gradient-soft); color: var(--wjs-color-primary-dark); padding: 0.15em 0.4em; border-radius: 6px; font-size: 0.9em; }
::selection { background: rgba(124, 58, 237, 0.18); }

/* ============================ HEADER ============================ */
header {
  background-color: rgba(255, 255, 255, 0.85) !important;
  border-bottom: 1px solid var(--wjs-border-subtle) !important;
  backdrop-filter: saturate(180%) blur(12px) !important;
  -webkit-backdrop-filter: saturate(180%) blur(12px) !important;
}

/* Logo: WordJS gradient wordmark */
.wjs-header-logo {
  font-family: var(--wjs-font-family-heading) !important;
  font-weight: 700 !important;
  font-size: 1.6rem !important;
  letter-spacing: -0.03em !important;
  background: var(--wjs-gradient);
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: var(--wjs-logo-color) !important; /* fallback for no background-clip */
}

/* Nav links with an animated gradient underline */
.wjs-header-nav a {
  font-family: var(--wjs-nav-font-family) !important;
  font-size: var(--wjs-nav-font-size) !important;
  font-weight: var(--wjs-nav-font-weight) !important;
  color: var(--wjs-nav-color) !important;
  text-transform: var(--wjs-nav-text-transform) !important;
  letter-spacing: var(--wjs-nav-letter-spacing) !important;
  transition: var(--wjs-nav-transition) !important;
  text-decoration: none !important;
  position: relative;
}
.wjs-header-nav a::after {
  content: "";
  position: absolute;
  left: 0; bottom: -4px;
  height: 2px; width: 0;
  background: var(--wjs-gradient);
  border-radius: 2px;
  transition: width 0.25s ease;
}
.wjs-header-nav a:hover { color: var(--wjs-nav-color-hover) !important; }
.wjs-header-nav a:hover::after { width: 100%; }

/* ============================ CONTENT ============================ */
/* Gutters only — NEVER the \`padding\` shorthand. The public layout puts \`pt-24 pb-10\` on this same
   element to clear the fixed header; a shorthand here resets those to 0 (equal specificity, and the
   theme sheet loads after the app CSS), which left the page title rendering underneath the header. */
.container { max-width: 1100px; margin: 0 auto; padding-inline: 24px; }

/* \`article\` only. This used to include \`.wp-block-card\`, and the \`!important\` background overrode the
   card's own --wjs-card-bg while leaving the block's paired text colours alone — an accent card became
   white with white text, so its icon and description vanished. The card's surface, border, radius and
   hover already come from the token contract in wordjs-ui.css, which falls back to this theme's
   --wjs-bg-surface / --wjs-border-subtle anyway. */
article {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-lg) !important;
  box-shadow: var(--wjs-shadow-sm);
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}
article:hover {
  transform: translateY(-3px);
  border-color: rgba(79, 70, 229, 0.35) !important;
  box-shadow: var(--wjs-shadow-md);
}

.post-meta {
  color: var(--wjs-color-text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.8rem;
}
.content { font-size: 1.125rem; }
.excerpt { font-size: 1.1rem; color: var(--wjs-color-text-muted); }

/* Buttons — the gradient pill is the WordJS call to action */
.wjs-btn-primary,
.wjs-block-button a, .wp-block-button a,
.wp-button.button-primary,
.wjs-block-button .wjs-block-button__link, .wp-block-button .wp-block-button__link {
  background: var(--wjs-gradient) !important;
  color: #ffffff !important;
  border: none !important;
  border-radius: var(--wjs-radius-pill) !important;
  box-shadow: 0 8px 20px -8px rgba(124, 58, 237, 0.55);
  transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
.wjs-btn-primary:hover,
.wjs-block-button a:hover, .wp-block-button a:hover,
.wp-button.button-primary:hover,
.wjs-block-button .wjs-block-button__link:hover, .wp-block-button .wp-block-button__link:hover {
  transform: translateY(-2px);
  filter: brightness(1.05);
  box-shadow: 0 12px 26px -8px rgba(124, 58, 237, 0.6);
  color: #ffffff !important;
}

/* ============================ FOOTER ============================ */
footer {
  background-color: var(--wjs-footer-bg) !important;
  color: var(--wjs-footer-text-body) !important;
  border-top: 3px solid transparent !important;
  border-image: var(--wjs-gradient) 1 !important;
}
footer h3, footer h4 {
  color: var(--wjs-footer-text-heading) !important;
  font-family: var(--wjs-font-family-heading) !important;
  font-weight: 700 !important;
}
footer a { color: var(--wjs-footer-text-body) !important; text-decoration: none !important; transition: color 0.2s ease; }
footer a:hover { color: var(--wjs-footer-text-hover) !important; }
footer .w-10 {
  background-color: var(--wjs-footer-icon-bg) !important;
  color: var(--wjs-footer-icon-color) !important;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}
footer .w-10:hover {
  background: var(--wjs-gradient) !important;
  color: #ffffff !important;
  border-color: transparent !important;
  transform: translateY(-2px);
}

/* ============================ BLOCKS ============================ */
/* Hero — the blanket \`h1..h6 { color: heading !important }\` above also hits the title of a hero,
   which sits on the hero's OWN band (wordjs-ui.css gives .wp-block-hero \`color: var(--wjs-hero-color,
   #fff)\` and lets the title inherit it). On the usual dark gradient that painted the title in the dark
   heading color — invisible. Restore the framework's own declaration verbatim so \`--wjs-hero-title-color\`
   still wins when a theme or block instance sets it. Same treatment the footer and CTA bands already get. */
.wjs-block-hero h1, .wp-block-hero h1, .wjs-block-hero h2, .wp-block-hero h2, .wjs-block-hero__title, .wp-block-hero__title {
  font-family: var(--wjs-font-family-heading) !important;
  color: var(--wjs-hero-title-color, inherit) !important;
}

/* Stats — gradient figures */
.wjs-block-stats .stat-value, .wp-block-stats .stat-value,
.wjs-block-stats [class*="value"], .wp-block-stats [class*="value"] {
  background: var(--wjs-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  font-family: var(--wjs-font-family-heading) !important;
}

/* Accordion */
.wjs-block-accordion, .wp-block-accordion {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius) !important;
}
.wjs-block-accordion .accordion-item button, .wp-block-accordion .accordion-item button { color: var(--wjs-color-heading) !important; }
.wjs-block-accordion .accordion-item button i, .wp-block-accordion .accordion-item button i { color: var(--wjs-color-primary) !important; }
.wjs-block-accordion .accordion-item > div, .wp-block-accordion .accordion-item > div { background: var(--wjs-gradient-soft) !important; color: var(--wjs-color-text-muted) !important; }

/* Tabs — gradient indicator */
.wjs-block-tabs > div:first-child, .wp-block-tabs > div:first-child { border-bottom: 1px solid var(--wjs-border-subtle) !important; }
.wjs-block-tabs button, .wp-block-tabs button { color: var(--wjs-color-text-muted) !important; }
.wjs-block-tabs button:hover, .wp-block-tabs button:hover,
.wjs-block-tabs button:focus, .wp-block-tabs button:focus {
  color: var(--wjs-color-primary) !important;
  border-bottom-color: var(--wjs-color-primary) !important;
}

/* Pricing — featured tier wears the gradient */
.wjs-block-pricing > div, .wp-block-pricing > div {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-md) !important;
  transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
}
.wjs-block-pricing > div:hover, .wp-block-pricing > div:hover { border-color: rgba(79, 70, 229, 0.4) !important; box-shadow: var(--wjs-shadow-md); }
.wjs-block-pricing > div[style*="scale(1.05)"], .wp-block-pricing > div[style*="scale(1.05)"] {
  border: 2px solid transparent !important;
  background:
    linear-gradient(var(--wjs-bg-surface), var(--wjs-bg-surface)) padding-box,
    var(--wjs-gradient) border-box !important;
  box-shadow: 0 0 50px -10px rgba(124, 58, 237, 0.35) !important;
}

/* Testimonial */
.wjs-block-testimonial, .wp-block-testimonial {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-md) !important;
}
.wjs-block-testimonial > div:first-child, .wp-block-testimonial > div:first-child { color: var(--wjs-color-primary) !important; }

/* CTA Banner — full gradient */
.wjs-block-cta-banner, .wp-block-cta-banner {
  background: var(--wjs-gradient) !important;
  color: #ffffff !important;
  border: none !important;
  border-radius: var(--wjs-radius-lg) !important;
}
.wjs-block-cta-banner h2, .wp-block-cta-banner h2, .wjs-block-cta-banner p, .wp-block-cta-banner p { color: #ffffff !important; }
.wjs-block-cta-banner a, .wp-block-cta-banner a {
  background: #ffffff !important;
  color: var(--wjs-color-primary) !important;
  border-radius: var(--wjs-radius-pill) !important;
  font-weight: 700 !important;
}

/* Posts grid */
.wjs-block-posts-grid article, .wp-block-posts-grid article { border-radius: var(--wjs-radius-md) !important; }
.wjs-block-posts-grid article:hover, .wp-block-posts-grid article:hover { border-color: rgba(79, 70, 229, 0.35) !important; }

/* Category posts */
.wjs-block-category-posts h3, .wp-block-category-posts h3 { color: var(--wjs-color-primary) !important; }
.wjs-block-category-posts li, .wp-block-category-posts li { border-color: var(--wjs-border-subtle) !important; }
.wjs-block-category-posts li a:hover, .wp-block-category-posts li a:hover { color: var(--wjs-color-primary) !important; }

/* Icon list */
.wjs-block-icon-list i, .wp-block-icon-list i, .wjs-block-icon-list .icon, .wp-block-icon-list .icon { color: var(--wjs-color-primary) !important; }

/* Search */
.wjs-block-search input, .wp-block-search input {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-pill) !important;
  color: var(--wjs-color-text-main) !important;
}
.wjs-block-search input:focus, .wp-block-search input:focus {
  border-color: var(--wjs-color-primary) !important;
  box-shadow: 0 0 0 4px var(--wjs-focus-ring);
  outline: none;
}
.wjs-block-search button, .wp-block-search button {
  background: var(--wjs-gradient) !important;
  color: #ffffff !important;
  border: none !important;
  border-radius: var(--wjs-radius-pill) !important;
}

/* Divider / video / audio */
.wjs-block-divider, .wp-block-divider { border-color: var(--wjs-border-subtle) !important; }
.wjs-block-video-embed, .wp-block-video-embed { border-radius: var(--wjs-radius-md) !important; box-shadow: var(--wjs-shadow-md); }
.wjs-block-audio-player, .wp-block-audio-player {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-md) !important;
}
.wjs-block-audio-player div:first-child > div:first-child, .wp-block-audio-player div:first-child > div:first-child { background: var(--wjs-gradient) !important; color: #ffffff !important; }

/* ===== Mobile (auto responsive pass) ===== */
@media (max-width: 767.98px) {
  /* Featured pricing tier: the block flags it with an inline
     \`transform: scale(1.05)\` — a deliberate pop-out in the desktop
     multi-column row, but once the tiers stack into a single column the
     enlarged card bleeds into the container gutters and overlaps the
     cards stacked above/below it. Flatten the scale on small screens;
     the tier keeps its gradient border + violet glow (the desktop rule
     above still matches on the same style attribute), so it stays
     visually "featured" without breaking the layout. !important is
     required to beat the inline style. */
  .wjs-block-pricing > div[style*="scale(1.05)"], .wp-block-pricing > div[style*="scale(1.05)"] {
    transform: none !important;
  }
}

`;
  writeIfAbsent(path.join(defaultDir, 'style.css'), styleCss);

  // partials/header.html
  const headerPartial = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{#if title}}{{title}} - {{/if}}{{siteTitle}}</title>
  <link rel="stylesheet" href="{{get_stylesheet_uri}}">
  {{wordjs_head}}
</head>
<body>
  <header>
    <div class="container">
      <h1><a href="/" style="color:inherit;text-decoration:none">{{siteTitle}}</a></h1>
      <p>{{siteDescription}}</p>
    </div>
  </header>
  <main>
    <div class="container">`;
  writeIfAbsent(path.join(defaultDir, 'partials', 'header.html'), headerPartial);

  // partials/footer.html
  const footerPartial = `    </div>
  </main>
  <footer>
    <div class="container">
      <p>&copy; {{year}} {{siteTitle}}. Built with ❤️ using WordJS.</p>
    </div>
  </footer>
  {{wordjs_footer}}
</body>
</html>`;
  writeIfAbsent(path.join(defaultDir, 'partials', 'footer.html'), footerPartial);

  // templates/index.html
  const indexTemplate = `{{> header}}
      {{#each posts}}
      <article>
        <div class="post-meta">{{formatDate date}}</div>
        <h2><a href="/{{slug}}">{{title}}</a></h2>
        <div class="excerpt">{{{excerpt}}}</div>
      </article>
      {{/each}}
{{> footer}}`;
  writeIfAbsent(path.join(defaultDir, 'templates', 'index.html'), indexTemplate);

  // templates/single.html
  const singleTemplate = `{{> header}}
      <article>
        <div class="post-meta">{{formatDate date}} — By {{author}}</div>
        <h1>{{title}}</h1>
        <div class="content">{{{content}}}</div>
      </article>
{{> footer}}`;
  writeIfAbsent(path.join(defaultDir, 'templates', 'single.html'), singleTemplate);

  // templates/archive.html
  const archiveTemplate = `{{> header}}
      <h2 style="margin-bottom: 40px; color: var(--text-muted)">Archive: {{term.name}}</h2>
      {{#each posts}}
      <article>
        <div class="post-meta">{{formatDate date}}</div>
        <h2><a href="/{{slug}}">{{title}}</a></h2>
        <div class="excerpt">{{{excerpt}}}</div>
      </article>
      {{/each}}
{{> footer}}`;
  writeIfAbsent(path.join(defaultDir, 'templates', 'archive.html'), archiveTemplate);

  // Unconditional: the scaffold writes on `force` AND whenever a file was missing (first install),
  // and an earlier scan may already have observed the dir half-populated.
  invalidateThemeScanCache();
}

/** A refusal the API layer can turn into a real status + code instead of a generic 500. */
function refuse(message: string, code: string, status = 409) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Delete a theme.
 *
 * TWO REFUSALS, and they live HERE rather than in routes/themes.ts on purpose: switchTheme, the admin
 * UI, and any API client all funnel through this function, so a guard placed in the route would only
 * cover one of them.
 *
 *  - the ACTIVE theme: deleting it leaves `template` naming a directory that no longer exists, and the
 *    site renders with no theme at all (getActiveTheme deliberately refuses to promote an arbitrary
 *    replacement).
 *  - the LAST remaining theme: this is the sibling guard. Every comparable CMS keeps a floor — Ghost's
 *    service layer throws "Deleting the default theme is not allowed.", Drupal's ThemeInstaller throws
 *    for the default theme, Joomla marks core templates locked=1 — because an empty themes directory
 *    is a state the product cannot recover from through its own UI: there is nothing left to activate,
 *    and (since boot no longer rewrites theme files) nothing re-creates one behind the admin's back.
 *    The escape hatch is deliberate and named in the message: POST /api/v1/themes/default.
 *
 * Both carry `status`/`code`, so callers get 409 + a specific code instead of an unhandled 500.
 */
async function deleteTheme(slug: string) {
  const current = await getCurrentTheme();
  if (slug === current) {
    throw refuse('Cannot delete the currently active theme. Activate another theme first.', 'theme_active');
  }

  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);
  if (!theme) {
    throw refuse(`Theme ${slug} not found`, 'theme_not_found', 404);
  }

  // Counted from the SAME scan the lookup used, so the decision cannot straddle two views of the dir.
  if (themes.length <= 1) {
    throw refuse(
      `Cannot delete "${theme.name}" — it is the last theme installed, and the site would be left with none. ` +
      'Install or restore another theme first (POST /api/v1/themes/default restores the bundled default).',
      'theme_last_remaining'
    );
  }

  // Security: Ensure we only delete from themes directory
  const targetDir = path.join(THEMES_DIR, slug);
  if (!targetDir.startsWith(THEMES_DIR)) {
    throw new Error('Invalid theme path');
  }

  // Recursive delete
  fs.rmSync(targetDir, { recursive: true, force: true });
  invalidateThemeScanCache();
  return { success: true, message: `Theme ${theme.name} deleted successfully` };
}

/**
 * Install a theme by COPYING an on-disk directory into the themes dir — the "companion theme" path
 * (a plugin's bundled theme/, plugin-completeness program option B). Applies the same guarantees as
 * the /themes/upload zip path, translated from zip entries to directory entries:
 *   - footprint budget (entry count + total bytes, zip-guard's theme numbers),
 *   - containment (no symlinks anywhere in the tree — the dir-copy equivalent of zip-slip: a link
 *     could otherwise read from or, on later writes, escape to arbitrary host paths),
 *   - never overwrites an existing theme (`.code = 'THEME_EXISTS'`).
 * The source must LOOK like a theme (style.css or theme.json at its root) so a stray folder can't
 * install as a broken empty theme. Validation failures throw with `.code = 'THEME_INVALID'`.
 * Like an uploaded theme, the copied code is NOT trusted: activation still runs the AST scan and
 * loads functions.js OS-isolated (theme-engine.loadThemeLogic).
 * `opts` ({ themesDir, maxTotalBytes, maxEntries }) exists for tests.
 */
function installThemeFromDir(sourceDir: string, targetSlug: string, opts: { themesDir?: string; maxTotalBytes?: number; maxEntries?: number } = {}) {
  const fail = (message: string, code = 'THEME_INVALID') => {
    const err: any = new Error(message);
    err.code = code;
    throw err;
  };

  // Same numbers as zip-guard's defaults for the 'theme' kind.
  const maxTotalBytes = opts.maxTotalBytes ?? 200 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? 5000;
  const themesDir = path.resolve(opts.themesDir || THEMES_DIR);

  // Target slug must be a single safe path segment (same charset theme-engine.init later enforces).
  // Through core/safe-path so the FORM check, the canonical resolve and the containment proof are the
  // same three steps every other path in this project takes — and so the directory used below is the
  // one that was proved, not a re-resolve of the raw argument. The regex and the prefix test that
  // used to live here were correct, but they made the guard a pair of statements whose only link to
  // the write was that the same variable happened to be in scope.
  //
  // The refusal is an INLINE `throw`, not a call to the `fail()` helper the rest of this function
  // uses: a guard whose exit is hidden behind an indirect call is a guard neither a reader nor a
  // static analyzer can follow to the sink it protects. Here the barrier and the use are adjacent.
  const targetDir = resolveThemeDir(themesDir, targetSlug);
  if (targetDir === null) {
    const err: any = new Error(`Invalid theme slug: ${JSON.stringify(targetSlug)}`);
    err.code = 'THEME_INVALID';
    throw err;
  }

  const src = path.resolve(sourceDir);
  let srcStat = null;
  try { srcStat = fs.lstatSync(src); } catch { /* missing */ }
  if (!srcStat || !srcStat.isDirectory()) fail('Theme source is not a directory');
  if (!fs.existsSync(path.join(src, 'style.css')) && !fs.existsSync(path.join(src, 'theme.json'))) {
    fail('Theme source has no style.css or theme.json — not a theme');
  }
  if (fs.existsSync(targetDir)) {
    fail(`Theme "${targetSlug}" already exists`, 'THEME_EXISTS');
  }

  // Enumerate with lstat (never following links) and enforce the budget BEFORE writing anything.
  // `segments` (not a joined `rel` string) is what the copy loop below re-resolves under targetDir:
  // a list of names cannot smuggle a separator between two of them, and each one is checked as a
  // single plain segment on the way in. The joined form is kept only for the error messages.
  const files: Array<{ abs: string; segments: string[] }> = [];
  let totalBytes = 0;
  let entries = 0;
  const walk = (dir: string, prefix: string[]) => {
    for (const entry of fs.readdirSync(dir)) {
      const rel = prefix.length ? `${prefix.join('/')}/` : '';
      // A readdir entry is a single name by construction — assert it anyway. This is the boundary
      // where a name from an UPLOADED, attacker-authored theme becomes a path segment, and "the OS
      // would never hand us a separator" is an assumption about the OS, not a check.
      if (!isPlainSegment(entry)) fail(`Theme source contains an unusable file name (${rel}${entry}) — refusing to install`);
      const abs = path.join(dir, entry);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) fail(`Theme source contains a symlink (${rel}${entry}) — refusing to install`);
      entries += 1;
      if (entries > maxEntries) fail(`Theme has over ${maxEntries} entries — refusing to install`);
      if (st.isDirectory()) {
        walk(abs, [...prefix, entry]);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > maxTotalBytes) fail('Theme exceeds the size budget — refusing to install');
        files.push({ abs, segments: [...prefix, entry] });
      } else {
        // FIFOs, sockets, devices: nothing a theme legitimately ships — fail closed.
        fail(`Theme source contains an unsupported file type (${rel}${entry})`);
      }
    }
  };
  walk(src, []);

  fs.mkdirSync(targetDir, { recursive: true });
  try {
    for (const f of files) {
      // Containment is proved again on the destination actually written, under the target directory
      // that was itself proved above — not on the source listing that produced the segments.
      const dest = resolveWithin(targetDir, ...f.segments);
      if (dest === null) {
        throw new Error(`Theme source entry ${JSON.stringify(f.segments.join('/'))} does not resolve inside the theme directory`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
  } catch (e) {
    // Never leave a half-copied theme behind.
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  } finally {
    // The dir existed, even if only briefly (rollback path) — no scan may answer from before it.
    invalidateThemeScanCache();
  }

  return { slug: targetSlug, files: files.length };
}

/**
 * Create a zip of a theme for download.
 *
 * THE SLUG CHOOSES TWO PATHS HERE, and until now neither was checked in this function: the folder
 * that gets packed, and the file the zip is written to. The route (GET /themes/:slug/download) did
 * call its slug guard first — but that guard returns a BOOLEAN and the handler then passed the RAW
 * `req.params.slug` on, so the value that reached `path.join(cwd, 'os-tmp', `${slug}.zip`)` was
 * never the value anything had proved. That is the same defect the theme routes were already fixed
 * for once; a callee that trusts "my caller validated this" is where it survives.
 *
 * So the form is checked here, the destination is RESOLVED under os-tmp/ and proved contained, and
 * the packed directory is proved to be inside THEMES_DIR — scanThemes reads it off disk, which makes
 * it data, not a constant.
 */
async function createThemeZip(slug: string) {
  if (!isThemeSlug(slug)) {
    throw new Error(`Invalid theme slug: ${JSON.stringify(String(slug))}`);
  }
  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);
  if (!theme) {
    throw new Error(`Theme ${slug} not found`);
  }
  const themeDir = resolveThemeDir(THEMES_DIR, theme.slug);
  if (themeDir === null) {
    throw new Error(`Invalid theme slug: ${JSON.stringify(String(slug))}`);
  }

  const tmpDir = path.resolve(process.cwd(), 'os-tmp');
  const tempPath = resolveWithin(tmpDir, `${slug}.zip`);
  if (tempPath === null) {
    throw new Error(`Invalid theme slug: ${JSON.stringify(String(slug))}`);
  }
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(themeDir);
  zip.writeZip(tempPath);
  return tempPath;
}

/**
 * Install a theme from a zip THROUGH THE SAME SECURITY GATES as the admin upload route
 * (zip-bomb budget, Zip Slip containment) — shared by the theme marketplace. Unlike the upload
 * route (which trusts the zip's filename and layout for back-compat), this STRICT variant requires
 * every entry to live under `<slug>/` and a `<slug>/theme.json` to exist, so a catalog zip can only
 * ever materialize the one theme directory it claims to be. Returns {ok, status, body} and owns
 * the temp-file cleanup, mirroring plugins' installPluginFromZip.
 */
async function installThemeFromZip(zipPath: any, slug: any): Promise<{ ok: boolean; status: number; body: any }> {
  const AdmZip = require('adm-zip');
  const { assertZipWithinBudget } = require('./zip-guard');
  const cleanup = () => { try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch { /* best-effort */ } };
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(slug))) {
      cleanup();
      return { ok: false, status: 400, body: { error: 'Invalid theme slug' } };
    }
    const targetDir = path.resolve(THEMES_DIR, slug);
    if (!targetDir.startsWith(path.resolve(THEMES_DIR) + path.sep)) {
      cleanup();
      return { ok: false, status: 400, body: { error: 'Invalid theme slug' } };
    }
    if (fs.existsSync(targetDir)) {
      cleanup();
      return { ok: false, status: 409, body: { error: `Theme "${slug}" already exists. Delete it before reinstalling.` } };
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    try {
      assertZipWithinBudget(entries, { kind: 'theme' });
    } catch (e: any) {
      cleanup();
      return { ok: false, status: 400, body: { error: e.message } };
    }

    // STRICT containment: every entry under <slug>/ inside THEMES_DIR, no '..' segments.
    const resolvedRoot = path.resolve(THEMES_DIR);
    for (const entry of entries) {
      const name = String(entry.entryName).replace(/\\/g, '/');
      if (name.split('/').includes('..')) { cleanup(); return { ok: false, status: 400, body: { error: 'Malicious zip file detected (path traversal)' } }; }
      if (!(name === `${slug}/` || name.startsWith(`${slug}/`))) {
        cleanup();
        return { ok: false, status: 400, body: { error: `Zip entries must live under "${slug}/" (found "${name}").` } };
      }
      const dest = path.resolve(THEMES_DIR, name);
      if (!(dest === resolvedRoot || dest.startsWith(resolvedRoot + path.sep))) {
        cleanup();
        return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip)' } };
      }
    }
    if (!entries.some((e: any) => String(e.entryName).replace(/\\/g, '/') === `${slug}/theme.json`)) {
      cleanup();
      return { ok: false, status: 400, body: { error: 'Not a valid WordJS theme (missing theme.json).' } };
    }

    // Write file entries ourselves (never extract directory entries — mirrors the plugin installer's
    // defense against adm-zip directory-entry re-enumeration).
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const dest = path.resolve(THEMES_DIR, String(entry.entryName).replace(/\\/g, '/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
    invalidateThemeScanCache();
    cleanup();
    return { ok: true, status: 200, body: { success: true, message: `Theme "${slug}" installed successfully`, slug } };
  } catch (error: any) {
    cleanup();
    try { const t = path.resolve(THEMES_DIR, String(slug)); if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true }); } catch { /* best-effort */ }
    // Entries may already have landed before the throw (and the rollback above removed them).
    invalidateThemeScanCache();
    return { ok: false, status: 500, body: { error: `Failed to install theme: ${error.message}` } };
  }
}

module.exports = {
  Theme,
  scanThemes,
  invalidateThemeScanCache,
  getCurrentTheme,
  getActiveTheme,
  getActiveThemeVersion,
  getActiveThemeSnapshot,
  isActiveThemeMissing,
  verifyDefaultTheme,
  defaultThemeNeedsAttention,
  DEFAULT_THEME_SLUG,
  REQUIRED_THEME_FILES,
  syncActiveThemeLayout,
  switchTheme,
  getAllThemes,
  renderTemplate,
  createDefaultTheme,
  deleteTheme,
  createThemeZip,
  installThemeFromZip,
  installThemeFromDir,
  THEMES_DIR
};
