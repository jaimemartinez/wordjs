/**
 * WordJS - Theme Engine (Robust)
 * Uses Handlebars for rendering and supports recursive partials, components and theme logic.
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { getOption } = require('./options');
const { doAction, applyFilters } = require('./hooks');

const THEMES_DIR = path.resolve('./themes');

class ThemeEngine {
    constructor() {
        this.activeTheme = null;
        this.partialsLoaded = false;

        // Register helpers
        this.registerHelpers();
    }

    registerHelpers() {
        Handlebars.registerHelper('wordjs_head', () => {
            let headElements = applyFilters('wordjs_head', [
                '<link rel="stylesheet" href="/public/css/core.css">'
            ]);
            // Defensive: ensure it's an array
            if (!Array.isArray(headElements)) {
                headElements = headElements ? [headElements] : [];
            }
            return new Handlebars.SafeString(headElements.join('\n'));
        });

        Handlebars.registerHelper('wordjs_footer', () => {
            let footerElements = applyFilters('wordjs_footer', []);
            // Defensive: ensure it's an array
            if (!Array.isArray(footerElements)) {
                footerElements = footerElements ? [footerElements] : [];
            }
            return new Handlebars.SafeString(footerElements.join('\n'));
        });

        Handlebars.registerHelper('get_stylesheet_uri', () => {
            if (!this.activeTheme) return '';
            return `/themes/${this.activeTheme.slug}/style.css`;
        });

        Handlebars.registerHelper('formatDate', (date) => {
            return new Date(date).toLocaleDateString();
        });

        Handlebars.registerHelper('json', (context) => {
            return JSON.stringify(context);
        });
    }

    async init() {
        const themeSlug = await getOption('template', 'default');
        const themePath = path.join(THEMES_DIR, themeSlug);

        if (!fs.existsSync(themePath)) {
            console.error(`❌ Theme ${themeSlug} not found at ${themePath}`);
            return;
        }

        this.activeTheme = {
            slug: themeSlug,
            path: themePath,
            templatesDir: path.join(themePath, 'templates'),
            partialsDir: path.join(themePath, 'partials')
        };

        this.loadPartials();
        this.loadThemeLogic();
    }

    loadPartials() {
        if (!this.activeTheme || !fs.existsSync(this.activeTheme.partialsDir)) return;

        const files = fs.readdirSync(this.activeTheme.partialsDir);
        files.forEach(file => {
            if (file.endsWith('.html')) {
                const name = path.parse(file).name;
                const template = fs.readFileSync(path.join(this.activeTheme.partialsDir, file), 'utf8');
                Handlebars.registerPartial(name, template);
            }
        });
        this.partialsLoaded = true;
    }

    loadThemeLogic() {
        const logicPath = path.join(this.activeTheme.path, 'functions.js');
        if (fs.existsSync(logicPath)) {
            try {
                const { runWithContext } = require('./plugin-context');

                // We sandbox the theme logic using 'theme:slug' to trigger special handling in plugin-context/io-guard
                const contextSlug = `theme:${this.activeTheme.slug}`;

                // SECURITY: AST Scan the theme for dangerous calls (child_process, eval, etc.)
                const { validatePluginPermissions } = require('./plugins');

                // Define the permissions we allow for themes (Strict)
                // If a theme needs more, it must add a manifest.json
                let manifest = {
                    permissions: [
                        { scope: 'settings', access: 'read' },
                        { scope: 'content', access: 'read' }
                    ]
                };

                // Try to load actual manifest if exists
                const manifestPath = path.join(this.activeTheme.path, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { }
                }

                try {
                    validatePluginPermissions(this.activeTheme.slug, this.activeTheme.path, manifest);
                } catch (securityError) {
                    console.error(`🚨 Security Block: Theme '${this.activeTheme.slug}' contains unsafe code and was blocked.`);
                    console.error(securityError.message);
                    return; // STOP loading
                }

                // Clear cache if previously loaded
                delete require.cache[require.resolve(logicPath)];

                const themeLogic = require(logicPath);

                if (typeof themeLogic === 'function') {
                    // Execute inside the security context
                    runWithContext(contextSlug, () => {
                        themeLogic();
                    });
                }
            } catch (e) {
                console.error(`❌ Error loading theme functions.js:`, e.message);
            }
        }
    }

    async render(templateName, data = {}) {
        // Detect theme change and re-init if necessary
        const currentOption = await getOption('template', 'default');
        if (!this.activeTheme || this.activeTheme.slug !== currentOption) {
            console.log(`🎨 Theme engine reloading: ${this.activeTheme?.slug} -> ${currentOption}`);
            await this.init();
        }

        const templatePath = path.join(this.activeTheme.templatesDir, `${templateName}.html`);
        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template ${templateName} not found in theme ${this.activeTheme.slug}`);
        }

        const source = fs.readFileSync(templatePath, 'utf8');
        const template = Handlebars.compile(source);

        // Global context
        const context = {
            ...data,
            siteTitle: await getOption('blogname', 'WordJS'),
            siteDescription: await getOption('blogdescription', ''),
            year: new Date().getFullYear(),
            theme: this.activeTheme
        };

        return template(context);
    }
}

module.exports = new ThemeEngine();
