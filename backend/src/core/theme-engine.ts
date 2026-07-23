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

// A theme's functions.js runs as an isolated child registered under this namespace (see loadThemeLogic).
const THEME_ISOLATE_PREFIX = 'theme:';

/**
 * Retire EVERY theme isolate before the incoming theme's own child is (re)loaded.
 *
 * THE LEAK THIS CLOSES. A theme's functions.js runs in a child process registered as `theme:<slug>`, and
 * everything it registers — hooks, filters, shortcodes, routes, mail/notify transports — lives on in the
 * HOST until that isolate is unloaded. init() assigns `this.activeTheme` to the INCOMING theme BEFORE it
 * calls loadThemeLogic(), so the old `if (isIsolated(theme:<incoming>)) unload` check could only ever
 * match a stale worker for the theme being loaded: switching A -> B computed `theme:B` and nobody ever
 * unloaded `theme:A`. Observable symptom: after the admin switched away from a theme, that theme's
 * orphaned process was still alive and its hooks/shortcodes still fired on every page the site rendered.
 *
 * WHY SWEEP THE NAMESPACE INSTEAD OF REMEMBERING THE PREVIOUS SLUG. "Unload the outgoing one" repairs
 * only the single expected transition: it still leaks if an earlier switch already leaked, or if several
 * theme children accumulated (boot + switch + a lazy re-init from render() racing). Sweeping the whole
 * `theme:` namespace repairs those too — the state every already-running install is in — instead of only
 * stopping new ones.
 *
 * The incoming slug is deliberately INCLUDED in the sweep: loadThemeLogic (re)loads it immediately
 * afterwards, so this preserves the stale-worker restart the old check performed for a same-theme
 * re-init, without needing a special case.
 *
 * Only `theme:`-prefixed slugs are touched — plugin isolates share this registry and must survive a
 * theme switch completely untouched.
 *
 * WHAT IT CONVERGES FROM, PRECISELY — the earlier claim that it is "self-healing from ANY already-leaked
 * state" was too strong, and worth stating exactly. It converges from every isolate the isolate layer
 * still holds a reference to: registered children, crashed children with a supervised restart armed, and
 * — since listIsolates() also reports `loading` — children whose load is still in flight. It does NOT and
 * cannot converge from an ORPHAN: a child the layer itself lost the handle to is not in any registry, so
 * nothing here can name it, let alone stop it. That is why the orphan is prevented at its source, in
 * loadIsolatedPlugin, rather than swept up here.
 *
 * An in-flight slug is not unloadable yet — unloadIsolatedPlugin stops a REGISTERED child — so this waits
 * for the load to settle and then unloads it. Skipping it would let the child register a moment after the
 * sweep passed (the leak, restated); SIGKILLing it mid-load would leave whatever registrations were still
 * in flight over IPC wired to a dead process.
 */
async function unloadThemeIsolates(incomingIsoSlug: string): Promise<void> {
    let iso: any;
    try {
        iso = require('./plugin-isolate');
    } catch (e: any) {
        console.error('[Theme] cannot reach the isolate layer to retire theme isolates:', e && e.message);
        return;
    }
    let slugs: string[];
    try {
        slugs = iso.listIsolates();
    } catch (e: any) {
        console.error('[Theme] failed to enumerate loaded isolates — a previous theme child may survive this switch:', e && e.message);
        return;
    }
    for (const slug of Array.isArray(slugs) ? slugs : []) {
        if (typeof slug !== 'string' || !slug.startsWith(THEME_ISOLATE_PREFIX)) continue; // never a plugin isolate
        try {
            // Let a load that is still in flight finish before retiring it (see the note above). Bounded:
            // on timeout we unload what IS registered rather than block the switch, and say so.
            if (typeof iso.awaitIsolateSettled === 'function' && !(await iso.awaitIsolateSettled(slug))) {
                console.error(`[Theme] isolate '${slug}' is still loading after the wait — retiring what is registered; a child of it may survive this switch.`);
            }
            await iso.unloadIsolatedPlugin(slug);
            if (slug !== incomingIsoSlug) console.log(`🎨 Theme switch: retired the outgoing theme isolate '${slug}'.`);
        } catch (e: any) {
            // BEST-EFFORT, BUT LOUD. A teardown that fails must not stop the incoming theme from loading
            // (the site would be left with no theme logic at all), yet it means a theme child may still be
            // alive and serving stale hooks — a silent catch here is precisely how this bug stayed hidden.
            console.error(`[Theme] failed to retire theme isolate '${slug}' — it may still be running and serving stale hooks/shortcodes:`, e && e.message);
        }
    }
}

// Promise-chain mutex for ThemeEngine.init() — see the doc on init(). Module-scoped so it covers the one
// engine instance this module exports (and any other), and so a re-require can never hand out a second.
let initChain: Promise<void> = Promise.resolve();

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

    /**
     * Re-initialise the engine against the theme the `template` option currently names.
     *
     * SERIALIZED, PROCESS-WIDE. Three entry points reach it — boot, themes.switchTheme() (the admin
     * action behind POST /themes/:slug/activate) and render()'s lazy re-init — and none of them held a
     * lock, so two overlapping calls interleaved their two steps: each one's sweep could run before
     * either one's load, and BOTH children then registered. That is one theme isolate too many, and if
     * both were for the same slug the second overwrote the first in the isolate registry, orphaning a live
     * child. A double-clicked "Activate" was enough to produce it.
     *
     * There is exactly ONE active theme, so the resource is global, not per-slug: serializing per slug
     * would still let activate(A) and activate(B) race each other. Queue rather than reject — a queued
     * re-init re-reads the option, so the last writer still wins and no caller has to retry. The chain
     * never carries a rejection (an init that throws must not wedge every later switch); the caller gets
     * its own failure through `run`.
     *
     * Defence in depth only: the isolate layer holds the invariant on its own (loadIsolatedPlugin joins an
     * in-flight same-slug load and retires any child it would displace), so a bypass of this lock cannot
     * orphan a process.
     */
    async init() {
        const run = initChain.then(() => this.initLocked(), () => this.initLocked());
        initChain = run.then(() => undefined, () => undefined);
        return run;
    }

    async initLocked() {
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
        const themeSlug = this.activeTheme.slug;
        const isoSlug = `${THEME_ISOLATE_PREFIX}${themeSlug}`;

        // TEAR DOWN FIRST — before the functions.js existence check and before the AST pre-scan below.
        // Reaching this method means init() already validated the incoming theme and committed
        // this.activeTheme to it, so the switch HAS happened and the previous theme's child must go
        // regardless of how the incoming one fares: a theme with no functions.js legitimately owns no
        // isolate, and a theme the pre-scan blocks must own none — but in BOTH cases leaving the outgoing
        // child alive would keep the old theme's hooks/shortcodes firing under the new theme, which is
        // strictly worse than the site running with no theme logic at all.
        //
        // Conversely, init()'s early returns (unsafe slug, path escape, missing directory) happen BEFORE
        // the this.activeTheme assignment and never reach here, so a rejected theme switch cannot tear
        // down the working theme it failed to replace.
        await unloadThemeIsolates(isoSlug);

        const logicPath = path.join(this.activeTheme.path, 'functions.js');
        if (!fs.existsSync(logicPath)) return;
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
            // Every theme isolate (this slug's own stale worker included) was already retired by the
            // unloadThemeIsolates sweep at the top of this method, so this is always a clean start.
            const { loadIsolatedPlugin } = require('./plugin-isolate');
            await loadIsolatedPlugin(isoSlug, logicPath);
        } catch (e) {
            console.error(`❌ Error loading theme functions.js (isolated):`, (e as any) && (e as any).message);
        }
    }

    async render(templateName: string, data: any = {}) {
        // Detect theme change and re-init if necessary. This is the SECOND entry point into the isolate
        // lifecycle: the theme can change without an explicit admin action reaching this process (another
        // node wrote the option, a plugin wrote it, an admin action on a sibling node), and then the switch
        // happens LAZILY on the next render. It goes through init() -> loadThemeLogic(), so the
        // outgoing-isolate teardown covers it too — there is no second place to fix.
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
