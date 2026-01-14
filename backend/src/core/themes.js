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
function getCurrentTheme() {
    return getOption('template', 'default');
}

/**
 * Get current theme object
 */
function getActiveTheme() {
    const currentSlug = getCurrentTheme();
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

    const previousTheme = getCurrentTheme();

    updateOption('template', slug);
    updateOption('stylesheet', slug);

    await doAction('switch_theme', slug, previousTheme);

    return { success: true, message: `Switched to theme ${theme.name}` };
}

/**
 * Get all themes with their status
 */
function getAllThemes() {
    const themes = scanThemes();
    const current = getCurrentTheme();

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
function renderTemplate(templateName, data = {}) {
    const theme = getActiveTheme();
    if (!theme) {
        throw new Error('No active theme');
    }

    const templateFile = theme.getTemplate(templateName);
    if (!templateFile) {
        throw new Error(`Template ${templateName} not found in theme ${theme.slug}`);
    }

    let template = fs.readFileSync(templateFile, 'utf8');

    // Simple template variable replacement {{variable}}
    template = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return data[key] !== undefined ? data[key] : match;
    });

    // Simple loop support {{#each items}}...{{/each}}
    template = template.replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, key, content) => {
        const items = data[key];
        if (!Array.isArray(items)) return '';
        return items.map(item => {
            return content.replace(/\{\{(\w+)\}\}/g, (m, k) => {
                return item[k] !== undefined ? item[k] : m;
            });
        }).join('');
    });

    // Simple if support {{#if condition}}...{{/if}}
    template = template.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
        return data[key] ? content : '';
    });

    return template;
}

/**
 * Create default theme
 */
function createDefaultTheme() {
    const defaultDir = path.join(THEMES_DIR, 'default');

    if (fs.existsSync(defaultDir)) return;

    fs.mkdirSync(path.join(defaultDir, 'templates'), { recursive: true });

    // theme.json
    const themeJson = {
        name: 'Default Theme',
        version: '1.0.0',
        description: 'The default WordJS theme',
        author: 'WordJS'
    };
    fs.writeFileSync(path.join(defaultDir, 'theme.json'), JSON.stringify(themeJson, null, 2));

    // style.css
    const styleCss = `/* Default Theme Styles */
:root {
  --primary: #0073aa;
  --text: #333;
  --bg: #fff;
  --border: #ddd;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.6;
  margin: 0;
  padding: 0;
}

.container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
header { background: var(--primary); color: white; padding: 20px 0; }
header h1 { margin: 0; }
header nav a { color: white; margin-right: 15px; text-decoration: none; }
main { padding: 40px 0; min-height: 60vh; }
footer { background: #333; color: #999; padding: 20px 0; text-align: center; }
article { margin-bottom: 40px; }
article h2 a { color: var(--primary); text-decoration: none; }
.post-meta { color: #666; font-size: 0.9em; }
`;
    fs.writeFileSync(path.join(defaultDir, 'style.css'), styleCss);

    // templates/index.html
    const indexTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{siteName}}</title>
  <link rel="stylesheet" href="/themes/default/style.css">
</head>
<body>
  <header>
    <div class="container">
      <h1>{{siteName}}</h1>
      <p>{{siteDescription}}</p>
    </div>
  </header>
  <main>
    <div class="container">
      {{#each posts}}
      <article>
        <h2><a href="/{{slug}}">{{title}}</a></h2>
        <div class="post-meta">By {{author}} on {{date}}</div>
        <div class="excerpt">{{excerpt}}</div>
      </article>
      {{/each}}
    </div>
  </main>
  <footer>
    <div class="container">
      <p>&copy; {{year}} {{siteName}}. Powered by WordJS.</p>
    </div>
  </footer>
</body>
</html>`;
    fs.writeFileSync(path.join(defaultDir, 'templates', 'index.html'), indexTemplate);

    // templates/single.html
    const singleTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}} - {{siteName}}</title>
  <link rel="stylesheet" href="/themes/default/style.css">
</head>
<body>
  <header>
    <div class="container">
      <h1><a href="/" style="color:white;text-decoration:none">{{siteName}}</a></h1>
    </div>
  </header>
  <main>
    <div class="container">
      <article>
        <h1>{{title}}</h1>
        <div class="post-meta">By {{author}} on {{date}}</div>
        <div class="content">{{content}}</div>
      </article>
    </div>
  </main>
  <footer>
    <div class="container">
      <p>&copy; {{year}} {{siteName}}. Powered by WordJS.</p>
    </div>
  </footer>
</body>
</html>`;
    fs.writeFileSync(path.join(defaultDir, 'templates', 'single.html'), singleTemplate);
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
    THEMES_DIR
};
