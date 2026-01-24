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
  constructor(data) {
    this.name = data.name;
    this.slug = data.slug;
    this.version = data.version || '1.0.0';
    this.description = data.description || '';
    this.author = data.author || '';
    this.authorUri = data.authorUri || '';
    this.screenshot = data.screenshot || '';
    this.path = data.path;
    this.templatePath = data.templatePath;
  }

  /**
   * Get template file path
   */
  getTemplate(name) {
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
function parseThemeMetadata(themeDir, slug) {
  const metadataFile = path.join(themeDir, 'theme.json');

  let metadata = {
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
  const themes = [];

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
async function switchTheme(slug) {
  const themes = scanThemes();
  const theme = themes.find(t => t.slug === slug);

  if (!theme) {
    throw new Error(`Theme ${slug} not found`);
  }

  const previousTheme = await getCurrentTheme();

  await updateOption('template', slug);
  await updateOption('stylesheet', slug);

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
    active: theme.slug === current
  }));
}

/**
 * Render a template with data
 */
async function renderTemplate(templateName, data = {}) {
  const themeEngine = require('./theme-engine');
  return await themeEngine.render(templateName, data);
}

/**
 * Create default theme
 */
function createDefaultTheme() {
  const defaultDir = path.join(THEMES_DIR, 'default');

  // Ensure directories exist
  if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

  fs.mkdirSync(path.join(defaultDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(defaultDir, 'partials'), { recursive: true });

  // theme.json
  const themeJson = {
    name: 'Default Theme',
    version: '1.0.0',
    description: 'The default robust WordJS theme',
    author: 'WordJS'
  };
  fs.writeFileSync(path.join(defaultDir, 'theme.json'), JSON.stringify(themeJson, null, 2));

  // functions.js
  const functionsJs = `/**
 * Theme logic and hooks
 */
module.exports = () => {
    console.log('🎨 Default theme logic loaded!');
};
`;
  fs.writeFileSync(path.join(defaultDir, 'functions.js'), functionsJs);

  // style.css
  const styleCss = `/* Default Theme Styles */
:root {
  --primary: #2563eb;
  --primary-dark: #1e40af;
  --text: #1f2937;
  --text-muted: #6b7280;
  --bg: #f9fafb;
  --border: #e5e7eb;
}

body {
  font-family: 'Inter', -apple-system, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.6;
  margin: 0;
  padding: 0;
}

.container { max-width: 900px; margin: 0 auto; padding: 0 20px; }
header { background: white; border-bottom: 1px solid var(--border); padding: 40px 0; }
header h1 { margin: 0; font-weight: 800; font-size: 2.5rem; letter-spacing: -0.025em; }
header p { color: var(--text-muted); margin-top: 10px; font-size: 1.1rem; }

main { padding: 60px 0; min-height: 60vh; }
footer { border-top: 1px solid var(--border); color: var(--text-muted); padding: 40px 0; text-align: center; background: white; margin-top: 60px; }

article { margin-bottom: 60px; background: white; padding: 40px; border-radius: 24px; border: 1px solid var(--border); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
article h2 { margin-top: 0; font-weight: 800; font-size: 1.8rem; }
article h2 a { color: inherit; text-decoration: none; transition: color 0.2s; }
article h2 a:hover { color: var(--primary); }

.post-meta { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 20px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.content { font-size: 1.125rem; }
.excerpt { font-size: 1.1rem; color: #4b5563; }
`;
  fs.writeFileSync(path.join(defaultDir, 'style.css'), styleCss);

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
async function deleteTheme(slug) {
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
 * Create a zip of a theme for download
 */
async function createThemeZip(slug) {
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
  THEMES_DIR
};
