/**
 * WordJS - Theme System
 * Equivalent to wp-includes/theme.php
 */

const fs = require('fs');
const path = require('path');
const { getOption, updateOption } = require('./options');
const { doAction, applyFilters } = require('./hooks');

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
 * Scan for installed themes
 */
function scanThemes() {
  ensureThemesDir();
  const themes: Theme[] = [];

  const entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const themeDir = path.join(THEMES_DIR, entry.name);
    const metadata = parseThemeMetadata(themeDir, entry.name);

    themes.push(new Theme({
      ...metadata,
      slug: entry.name,
      path: themeDir,
      templatePath: path.join(themeDir, 'templates')
    }));
  }

  return themes;
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
  return themes.find(t => t.slug === currentSlug) || themes[0] || null;
}

/**
 * Switch to a different theme
 */
async function switchTheme(slug: string) {
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
 * Create default theme.
 *
 * Called on EVERY boot (index.ts) to guarantee a default theme exists. It must therefore be an
 * idempotent SCAFFOLD, not a clobber: the committed default/style.css carries the curated `--wjs-*`
 * design tokens (94 lines), but the `styleCss` fallback below is the old token-less version. Writing
 * it unconditionally stripped the tokens on every restart (the recurring "default theme tokens=0"
 * corruption — previously misattributed to subagents; it was actually this boot-time write). So the
 * fallback is only written when the file is MISSING. `force` (used by the admin "restore default
 * theme" endpoint) overwrites deliberately.
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
  const themeJson = {
    name: 'WordJS',
    version: '2.0.0',
    description: 'The default WordJS theme — modern, JavaScript-native, developer-first. Signature indigo→violet gradient, Space Grotesk display type, and a deep-indigo footer.',
    author: 'WordJS'
  };
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

  // style.css — WordJS's own visual identity. KEEP IN SYNC with the committed
  // themes/default/style.css (this embedded copy is only written on `force`
  // = admin "restore default theme", or when the file is missing).
  const styleCss = `/* =========================================================================
   THEME: WORDJS  (default)
   WordJS's own visual identity — modern, JavaScript-native, developer-first.
   Signature indigo->violet gradient, Space Grotesk display + Inter body +
   JetBrains Mono for code. Light, airy canvas with a deep-indigo footer edged
   by the brand gradient. Styles the live (Next.js) chrome via the
   .wjs-header- and footer hooks and the --wjs- framework tokens.
   ========================================================================= */

@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

:root {
  /* Signature gradient (the WordJS mark) */
  --wjs-gradient: linear-gradient(120deg, #4f46e5 0%, #7c3aed 55%, #a855f7 100%);
  --wjs-gradient-soft: linear-gradient(120deg, rgba(79, 70, 229, 0.10), rgba(168, 85, 247, 0.10));

  /* Color palette: Indigo / Violet */
  --wjs-color-primary: #4f46e5;
  --wjs-color-primary-dark: #4338ca;
  --wjs-color-secondary: #64748b;
  --wjs-color-secondary-dark: #475569;
  --wjs-color-accent: #a855f7;
  --wjs-color-success: #10b981;
  --wjs-color-danger: #ef4444;
  --wjs-color-warning: #f59e0b;
  --wjs-color-info: #3b82f6;
  --wjs-color-light: #f8f9ff;
  --wjs-color-dark: #0b1120;
  --wjs-color-on-primary: #ffffff;
  --wjs-color-on-secondary: #ffffff;
  --wjs-color-on-success: #ffffff;
  --wjs-color-on-danger: #ffffff;
  --wjs-color-on-warning: #161616;
  --wjs-color-on-info: #ffffff;
  --wjs-color-on-light: #161616;
  --wjs-color-on-dark: #ffffff;

  --wjs-bg-canvas: #f8f9ff;
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

  /* Navigation config */
  --wjs-nav-font-family: 'Inter', sans-serif;
  --wjs-nav-font-size: 0.95rem;
  --wjs-nav-font-weight: 500;
  --wjs-nav-text-transform: none;
  --wjs-nav-letter-spacing: 0;
  --wjs-nav-color: #475569;
  --wjs-nav-color-hover: #4f46e5;
  --wjs-nav-transition: color 0.2s ease;
  --wjs-logo-color: #4f46e5;

  /* Footer config (deep indigo) */
  --wjs-footer-bg: #0b1120;
  --wjs-footer-text-heading: #ffffff;
  --wjs-footer-text-body: #94a3b8;
  --wjs-footer-text-hover: #ffffff;
  --wjs-footer-icon-bg: rgba(255, 255, 255, 0.06);
  --wjs-footer-icon-color: #c4b5fd;

  /* Typography */
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

  /* Spacing / shape / depth */
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
}

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

/* Header */
header {
  background-color: rgba(255, 255, 255, 0.85) !important;
  border-bottom: 1px solid var(--wjs-border-subtle) !important;
  backdrop-filter: saturate(180%) blur(12px) !important;
  -webkit-backdrop-filter: saturate(180%) blur(12px) !important;
}

.wjs-header-logo {
  font-family: var(--wjs-font-family-heading) !important;
  font-weight: 700 !important;
  font-size: 1.6rem !important;
  letter-spacing: -0.03em !important;
  background: var(--wjs-gradient);
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: var(--wjs-logo-color) !important;
}

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

/* Content */
.container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

article, .wp-block-card {
  background: var(--wjs-bg-surface) !important;
  border: 1px solid var(--wjs-border-subtle) !important;
  border-radius: var(--wjs-radius-lg) !important;
  box-shadow: var(--wjs-shadow-sm);
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}
article:hover, .wp-block-card:hover {
  transform: translateY(-3px);
  border-color: rgba(79, 70, 229, 0.35) !important;
  box-shadow: var(--wjs-shadow-md);
}

.post-meta { color: var(--wjs-color-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.8rem; }
.content { font-size: 1.125rem; }
.excerpt { font-size: 1.1rem; color: var(--wjs-color-text-muted); }

.wjs-btn-primary,
.wp-block-button a,
.wp-button.button-primary,
.wp-block-button .wp-block-button__link {
  background: var(--wjs-gradient) !important;
  color: #ffffff !important;
  border: none !important;
  border-radius: var(--wjs-radius-pill) !important;
  box-shadow: 0 8px 20px -8px rgba(124, 58, 237, 0.55);
  transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
.wjs-btn-primary:hover,
.wp-block-button a:hover,
.wp-button.button-primary:hover,
.wp-block-button .wp-block-button__link:hover {
  transform: translateY(-2px);
  filter: brightness(1.05);
  box-shadow: 0 12px 26px -8px rgba(124, 58, 237, 0.6);
  color: #ffffff !important;
}

/* Footer */
footer {
  background-color: var(--wjs-footer-bg) !important;
  color: var(--wjs-footer-text-body) !important;
  border-top: 3px solid transparent !important;
  border-image: var(--wjs-gradient) 1 !important;
}
footer h3, footer h4 { color: var(--wjs-footer-text-heading) !important; font-family: var(--wjs-font-family-heading) !important; font-weight: 700 !important; }
footer a { color: var(--wjs-footer-text-body) !important; text-decoration: none !important; transition: color 0.2s ease; }
footer a:hover { color: var(--wjs-footer-text-hover) !important; }
footer .w-10 {
  background-color: var(--wjs-footer-icon-bg) !important;
  color: var(--wjs-footer-icon-color) !important;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}
footer .w-10:hover { background: var(--wjs-gradient) !important; color: #ffffff !important; border-color: transparent !important; transform: translateY(-2px); }

/* Blocks */
.wp-block-hero h1, .wp-block-hero h2 { font-family: var(--wjs-font-family-heading) !important; }
.wp-block-stats .stat-value, .wp-block-stats [class*="value"] {
  background: var(--wjs-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  font-family: var(--wjs-font-family-heading) !important;
}
.wp-block-accordion { background: var(--wjs-bg-surface) !important; border: 1px solid var(--wjs-border-subtle) !important; border-radius: var(--wjs-radius) !important; }
.wp-block-accordion .accordion-item button { color: var(--wjs-color-heading) !important; }
.wp-block-accordion .accordion-item button i { color: var(--wjs-color-primary) !important; }
.wp-block-accordion .accordion-item > div { background: var(--wjs-gradient-soft) !important; color: var(--wjs-color-text-muted) !important; }
.wp-block-tabs > div:first-child { border-bottom: 1px solid var(--wjs-border-subtle) !important; }
.wp-block-tabs button { color: var(--wjs-color-text-muted) !important; }
.wp-block-tabs button:hover, .wp-block-tabs button:focus { color: var(--wjs-color-primary) !important; border-bottom-color: var(--wjs-color-primary) !important; }
.wp-block-pricing > div { background: var(--wjs-bg-surface) !important; border: 1px solid var(--wjs-border-subtle) !important; border-radius: var(--wjs-radius-md) !important; transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease; }
.wp-block-pricing > div:hover { border-color: rgba(79, 70, 229, 0.4) !important; box-shadow: var(--wjs-shadow-md); }
.wp-block-pricing > div[style*="scale(1.05)"] {
  border: 2px solid transparent !important;
  background: linear-gradient(var(--wjs-bg-surface), var(--wjs-bg-surface)) padding-box, var(--wjs-gradient) border-box !important;
  box-shadow: 0 0 50px -10px rgba(124, 58, 237, 0.35) !important;
}
.wp-block-testimonial { background: var(--wjs-bg-surface) !important; border: 1px solid var(--wjs-border-subtle) !important; border-radius: var(--wjs-radius-md) !important; }
.wp-block-testimonial > div:first-child { color: var(--wjs-color-primary) !important; }
.wp-block-cta-banner { background: var(--wjs-gradient) !important; color: #ffffff !important; border: none !important; border-radius: var(--wjs-radius-lg) !important; }
.wp-block-cta-banner h2, .wp-block-cta-banner p { color: #ffffff !important; }
.wp-block-cta-banner a { background: #ffffff !important; color: var(--wjs-color-primary) !important; border-radius: var(--wjs-radius-pill) !important; font-weight: 700 !important; }
.wp-block-posts-grid article { border-radius: var(--wjs-radius-md) !important; }
.wp-block-posts-grid article:hover { border-color: rgba(79, 70, 229, 0.35) !important; }
.wp-block-category-posts h3 { color: var(--wjs-color-primary) !important; }
.wp-block-category-posts li { border-color: var(--wjs-border-subtle) !important; }
.wp-block-category-posts li a:hover { color: var(--wjs-color-primary) !important; }
.wp-block-icon-list i, .wp-block-icon-list .icon { color: var(--wjs-color-primary) !important; }
.wp-block-search input { background: var(--wjs-bg-surface) !important; border: 1px solid var(--wjs-border-subtle) !important; border-radius: var(--wjs-radius-pill) !important; color: var(--wjs-color-text-main) !important; }
.wp-block-search input:focus { border-color: var(--wjs-color-primary) !important; box-shadow: 0 0 0 4px var(--wjs-focus-ring); outline: none; }
.wp-block-search button { background: var(--wjs-gradient) !important; color: #ffffff !important; border: none !important; border-radius: var(--wjs-radius-pill) !important; }
.wp-block-divider { border-color: var(--wjs-border-subtle) !important; }
.wp-block-video-embed { border-radius: var(--wjs-radius-md) !important; box-shadow: var(--wjs-shadow-md); }
.wp-block-audio-player { background: var(--wjs-bg-surface) !important; border: 1px solid var(--wjs-border-subtle) !important; border-radius: var(--wjs-radius-md) !important; }
.wp-block-audio-player div:first-child > div:first-child { background: var(--wjs-gradient) !important; color: #ffffff !important; }
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
  fs.writeFileSync(path.join(defaultDir, 'partials', 'header.html'), headerPartial);

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
  fs.writeFileSync(path.join(defaultDir, 'partials', 'footer.html'), footerPartial);

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
  fs.writeFileSync(path.join(defaultDir, 'templates', 'index.html'), indexTemplate);

  // templates/single.html
  const singleTemplate = `{{> header}}
      <article>
        <div class="post-meta">{{formatDate date}} — By {{author}}</div>
        <h1>{{title}}</h1>
        <div class="content">{{{content}}}</div>
      </article>
{{> footer}}`;
  fs.writeFileSync(path.join(defaultDir, 'templates', 'single.html'), singleTemplate);

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
  fs.writeFileSync(path.join(defaultDir, 'templates', 'archive.html'), archiveTemplate);
}

/**
 * Delete a theme
 */
async function deleteTheme(slug: string) {
  const current = await getCurrentTheme();
  if (slug === current) {
    throw new Error('Cannot delete the currently active theme');
  }

  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);
  if (!theme) {
    throw new Error(`Theme ${slug} not found`);
  }

  // Security: Ensure we only delete from themes directory
  const targetDir = path.join(THEMES_DIR, slug);
  if (!targetDir.startsWith(THEMES_DIR)) {
    throw new Error('Invalid theme path');
  }

  // Recursive delete
  fs.rmSync(targetDir, { recursive: true, force: true });
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
  if (typeof targetSlug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(targetSlug)) {
    fail(`Invalid theme slug: ${JSON.stringify(targetSlug)}`);
  }
  const targetDir = path.resolve(themesDir, targetSlug);
  if (targetDir === themesDir || !targetDir.startsWith(themesDir + path.sep)) {
    fail('Invalid theme slug: resolves outside the themes directory');
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
  const files: Array<{ abs: string; rel: string }> = [];
  let totalBytes = 0;
  let entries = 0;
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) fail(`Theme source contains a symlink (${rel}${entry}) — refusing to install`);
      entries += 1;
      if (entries > maxEntries) fail(`Theme has over ${maxEntries} entries — refusing to install`);
      if (st.isDirectory()) {
        walk(abs, `${rel}${entry}/`);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > maxTotalBytes) fail('Theme exceeds the size budget — refusing to install');
        files.push({ abs, rel: `${rel}${entry}` });
      } else {
        // FIFOs, sockets, devices: nothing a theme legitimately ships — fail closed.
        fail(`Theme source contains an unsupported file type (${rel}${entry})`);
      }
    }
  };
  walk(src, '');

  fs.mkdirSync(targetDir, { recursive: true });
  try {
    for (const f of files) {
      const dest = path.join(targetDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
  } catch (e) {
    // Never leave a half-copied theme behind.
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }

  return { slug: targetSlug, files: files.length };
}

/**
 * Create a zip of a theme for download
 */
async function createThemeZip(slug: string) {
  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);
  if (!theme) {
    throw new Error(`Theme ${slug} not found`);
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(theme.path);

  const tempPath = path.join(process.cwd(), 'os-tmp', `${slug}.zip`);
  if (!fs.existsSync(path.dirname(tempPath))) {
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
  }

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
    cleanup();
    return { ok: true, status: 200, body: { success: true, message: `Theme "${slug}" installed successfully`, slug } };
  } catch (error: any) {
    cleanup();
    try { const t = path.resolve(THEMES_DIR, String(slug)); if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, status: 500, body: { error: `Failed to install theme: ${error.message}` } };
  }
}

module.exports = {
  Theme,
  scanThemes,
  getCurrentTheme,
  getActiveTheme,
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
