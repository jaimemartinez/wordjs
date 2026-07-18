/**
 * WordJS - Theme Engine (Robust) — LEGACY / NOT THE PUBLIC RENDERER.
 * Uses Handlebars for rendering and supports recursive partials, components and theme logic.
 *
 * The live public site is rendered by the Next.js frontend in both split and monolith mode; this
 * engine's render() is no longer mounted on any reachable route (see backend/src/index.ts). On the
 * live site a theme contributes only its `style.css` (--wjs-* tokens), loaded by the frontend's
 * ThemeLoader. init() is still called on boot/switchTheme and is harmless (loads partials +
 * sandboxed functions.js); keep this module for that + a potential standalone/monolith fallback.
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { getOption } = require('./options');
const { doAction, applyFilters } = require('./hooks');

const THEMES_DIR = path.resolve('./themes');

class ThemeEngine {
    activeTheme: any;
    partialsLoaded: boolean;

    constructor() {
        this.activeTheme = null;
        this.partialsLoaded = false;

        // Register helpers
        this.registerHelpers();
    }

    registerHelpers() {
        Handlebars.registerHelper('wordjs_head', () => {
            // The shared WordJS UI framework loads BEFORE core.css and the theme stylesheet so the
            // theme's own `:root` tokens + rules win at equal specificity (see public/css/wordjs-ui.css).
            let headElements = applyFilters('wordjs_head', [
                '<link rel="stylesheet" href="/public/css/wordjs-ui.css">',
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

        Handlebars.registerHelper('formatDate', (date: string | number | Date) => {
            return new Date(date).toLocaleDateString();
        });

        Handlebars.registerHelper('json', (context: any) => {
            return JSON.stringify(context);
        });
    }

    async init() {
        const themeSlug = String(await getOption('template', 'default') || 'default');

        // CONTAINMENT (#16): the 'template' option selects which directory's functions.js is require()d
        // IN-PROCESS on the host. A settings:write plugin (or any writer) could set it to '../plugins/evil'
        // to run arbitrary in-process code from outside THEMES_DIR. Require a single safe path segment and
        // re-assert the resolved path stays under THEMES_DIR before doing anything with it.
        if (!/^[a-zA-Z0-9._-]+$/.test(themeSlug) || themeSlug === '.' || themeSlug === '..') {
            console.error(`❌ Theme slug '${themeSlug}' is not a safe single path segment — refusing to load.`);
            return;
        }
        const themePath = path.join(THEMES_DIR, themeSlug);
        if (!path.resolve(themePath).startsWith(path.resolve(THEMES_DIR) + path.sep)) {
            console.error(`❌ Theme path '${themePath}' escaped the themes dir — refusing to load.`);
            return;
        }

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
        await this.loadThemeLogic();
    }

    loadPartials() {
        if (!this.activeTheme || !fs.existsSync(this.activeTheme.partialsDir)) return;

        const files = fs.readdirSync(this.activeTheme.partialsDir);
        files.forEach((file: string) => {
            if (file.endsWith('.html')) {
                const name = path.parse(file).name;
                const template = fs.readFileSync(path.join(this.activeTheme.partialsDir, file), 'utf8');
                Handlebars.registerPartial(name, template);
            }
        });
        this.partialsLoaded = true;
    }

    async loadThemeLogic() {
        const logicPath = path.join(this.activeTheme.path, 'functions.js');
        if (!fs.existsSync(logicPath)) return;
        const themeSlug = this.activeTheme.slug;
        const isoSlug = `theme:${themeSlug}`;
        try {
            // Static AST pre-scan (defense in depth). The REAL containment is the OS isolation below.
            const { validatePluginPermissions } = require('./plugins');
            let manifest: any = { permissions: [{ scope: 'settings', access: 'read' }, { scope: 'content', access: 'read' }] };
            const manifestPath = path.join(this.activeTheme.path, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
                catch (e) { console.warn(`[Theme] Failed to parse manifest for ${themeSlug}:`, e.message); }
            }
            try {
                validatePluginPermissions(themeSlug, this.activeTheme.path, manifest);
            } catch (securityError) {
                console.error(`🚨 Security Block: Theme '${themeSlug}' contains unsafe code and was blocked.`);
                console.error(securityError.message);
                return; // STOP loading
            }

            // OS-ISOLATION (2026-07-18, user-approved architecture): run functions.js in a CHILD PROCESS
            // exactly like an isolated plugin — NOT in-process. Theme code on the host main thread had NO
            // runtime eval/Function/dynamic-import guard, so a malicious theme achieved host RCE that NO
            // static scan can fully prevent (audit #6/#7/#8/#9/#20 — the in-process theme cluster). The
            // isolated worker gives OS-level containment; any hooks/shortcodes/mail the theme registers flow
            // through the SAME RPC bridge isolated plugins use (the isolate layer already namespaces theme:
            // slugs). Bundled themes' functions.js only console.log, so nothing host-side breaks; Handlebars
            // helpers remain built-in and host-side (they are not registered from functions.js).
            const { loadIsolatedPlugin, unloadIsolatedPlugin, isIsolated } = require('./plugin-isolate');
            if (isIsolated(isoSlug)) { try { await unloadIsolatedPlugin(isoSlug); } catch { /* stale worker */ } } // theme switch: tear down the old worker first
            await loadIsolatedPlugin(isoSlug, logicPath);
        } catch (e) {
            console.error(`❌ Error loading theme functions.js (isolated):`, (e as any) && (e as any).message);
        }
    }

    async render(templateName: string, data: any = {}) {
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

        // Render INSIDE the theme's security context: a theme-registered Handlebars helper executes HERE
        // (detached from loadThemeLogic's context), so without this it runs with an EMPTY ALS store =
        // "core"/trusted, and the option/cache/env context-gated guards don't fire against it (#20). Wrapping
        // template() re-anchors those helpers to the theme slug so secure-require + the guards apply.
        const { runWithContext } = require('./plugin-context');
        return runWithContext(`theme:${this.activeTheme.slug}`, () => template(context));
    }
}

module.exports = new ThemeEngine();
