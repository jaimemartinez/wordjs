/**
 * WordJS - Plugin portal pages
 *
 * A plugin may ship ONE standalone public page, mounted by the frontend at `/portal/<slug>`: a portal for
 * people who are not WordJS users (a conference's coordinators, a vendor, a field team). It is declared in
 * the manifest:
 *
 *   "frontend": { "portalPage": { "entry": "client/portal/page.tsx", "slug": "my-portal",
 *                                 "title": "My portal", "themeColor": "#2563eb", "viewportFit": "cover" } }
 *
 * `title`, `themeColor` and `viewportFit` are optional: they go into the page's <head> (the server page
 * asks GET /api/v1/plugins/<slug>/portal for them, so a portal installed at runtime has them too).
 * `viewportFit: "cover"` lets the page draw under a phone's notch and home indicator — only for a page
 * that pads itself with env(safe-area-inset-*); the default keeps the browser's safe area.
 *
 * Also optional, for a portal with sub-pages of its own (/portal/<slug>/<page>):
 *   - `pages`: { "<page>": { title?, private?, app? } } — the <head> of one sub-page: its own title; `private`
 *     (a personal page: never indexed, never stored, no Referer leaves it); `app` { name, shortName?,
 *     description?, backgroundColor?, themeColor? } makes it installable to a phone's home screen (the core
 *     serves its web app manifest at /portal/<slug>/app.webmanifest?page=<page>, scoped to that sub-page);
 *   - `serviceWorker`: a plain .js file under client/, served as-is at /portal/<slug>/sw.js (its scope can be
 *     the portal or any sub-page of it) — e.g. to show Web Push notifications;
 *   - `file`: one of the plugin's PUBLIC GET routes ("/public/…") that turns a short-lived ticket (?d=) into
 *     { mime, filename, b64 }; the core answers its bytes at /portal/<slug>/file?d=<ticket> (PDF and images
 *     only), since a plugin route answers JSON.
 * The three core paths — file, sw.js, app.webmanifest — are never the portal's own sub-pages.
 *
 * build-plugin.js compiles the entry to dist/portal.bundle.js (+ dist/portal.bundle.css), and
 * GET /api/v1/plugins/<slug>/bundle{,/css}?type=portal serves them under the same gate as every other
 * plugin bundle (active + browser:script). The `<slug>` there is the PORTAL slug, never the folder: the
 * URL the visitor opens is the only name the frontend has for a plugin installed at runtime.
 *
 * This module is the one place that decides what a valid declaration is, who owns a portal slug, and
 * which active plugin a portal slug resolves to — so install, activation and the bundle routes cannot
 * disagree about it.
 */

const PLUGIN_FOLDER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** A portal slug is one URL path segment: lowercase letters, digits and inner hyphens. */
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The entry is a source file inside the plugin's client/ tree — never outside the plugin folder. */
const PORTAL_ENTRY_RE = /^(?:\.\/)?client\/[A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js)$/;
/** `<meta name="theme-color">`: a hex colour, nothing that could carry markup into the generated page. */
const PORTAL_THEME_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PORTAL_TITLE_MAX = 120;
const PORTAL_VIEWPORT_FITS = ['auto', 'cover', 'contain'];
/** The service worker: a plain .js file inside the plugin's client/ tree (served as-is, never compiled). */
const PORTAL_SW_RE = /^(?:\.\/)?client\/[A-Za-z0-9_./-]+\.js$/;
/** The file route: one of the plugin's public routes — letters, digits, _ - / only (no dot, so no "..", no query). */
const PORTAL_FILE_ROUTE_RE = /^\/public\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,7}$/;
/** Sub-pages that may carry <head> details, and the core's own paths under every portal. */
const PORTAL_PAGES_MAX = 20;
const PORTAL_RESERVED_PAGES = ['file'];
const PORTAL_APP_NAME_MAX = 60;
const PORTAL_APP_SHORT_NAME_MAX = 30;
const PORTAL_APP_DESCRIPTION_MAX = 200;

/** A head text (a title, an app name): non-empty, bounded, nothing that could carry markup. */
const isHeadText = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[<>]/.test(v);
const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with one `pages.<page>` entry, prefixed with its path. */
function pageProblems(name: string, page: any): string[] {
    const at = `frontend.portalPage.pages.${name}`;
    if (!isPlainObject(page)) return [`${at} must be an object { title?, private?, app? }.`];
    const out: string[] = [];
    for (const key of Object.keys(page)) if (!['title', 'private', 'app'].includes(key)) out.push(`${at}.${key} is not a known field (title, private, app).`);
    if (page.title !== undefined && !isHeadText(page.title, PORTAL_TITLE_MAX)) out.push(`${at}.title must be a non-empty string of at most ${PORTAL_TITLE_MAX} characters, without < or >.`);
    if (page.private !== undefined && typeof page.private !== 'boolean') out.push(`${at}.private must be true or false.`);
    if (page.app !== undefined) {
        const app = page.app;
        if (!isPlainObject(app)) out.push(`${at}.app must be an object { name, shortName?, description?, backgroundColor?, themeColor? }.`);
        else {
            if (!isHeadText(app.name, PORTAL_APP_NAME_MAX)) out.push(`${at}.app.name must be a non-empty string of at most ${PORTAL_APP_NAME_MAX} characters, without < or >.`);
            if (app.shortName !== undefined && !isHeadText(app.shortName, PORTAL_APP_SHORT_NAME_MAX)) out.push(`${at}.app.shortName must be a non-empty string of at most ${PORTAL_APP_SHORT_NAME_MAX} characters, without < or >.`);
            if (app.description !== undefined && !isHeadText(app.description, PORTAL_APP_DESCRIPTION_MAX)) out.push(`${at}.app.description must be a non-empty string of at most ${PORTAL_APP_DESCRIPTION_MAX} characters, without < or >.`);
            for (const key of ['backgroundColor', 'themeColor']) {
                if (app[key] !== undefined && (typeof app[key] !== 'string' || !PORTAL_THEME_COLOR_RE.test(app[key]))) out.push(`${at}.app.${key} must be a hex colour such as "#2563eb".`);
            }
            for (const key of Object.keys(app)) if (!['name', 'shortName', 'description', 'backgroundColor', 'themeColor'].includes(key)) out.push(`${at}.app.${key} is not a known field.`);
        }
    }
    return out;
}

/** The portal slug a manifest declares (`frontend.portalPage.slug`), or null when it declares none. */
function portalPageSlugOf(manifest: any): string | null {
    const slug = manifest && manifest.frontend && manifest.frontend.portalPage && manifest.frontend.portalPage.slug;
    return typeof slug === 'string' && slug ? slug : null;
}

/**
 * What is wrong with the manifest's `frontend.portalPage`, as a list of problems (empty = valid or absent).
 * The title and theme colour end up in a generated page's <head>, so they are held to a strict shape here
 * rather than escaped somewhere downstream.
 */
function validatePortalPage(manifest: any): string[] {
    const page = manifest && manifest.frontend && manifest.frontend.portalPage;
    if (page === undefined || page === null) return [];
    if (typeof page !== 'object' || Array.isArray(page)) return ['frontend.portalPage must be an object { entry, slug, title?, themeColor? }.'];
    const out: string[] = [];
    if (typeof page.entry !== 'string' || !PORTAL_ENTRY_RE.test(page.entry) || page.entry.split('/').includes('..')) {
        out.push('frontend.portalPage.entry must be a .tsx/.ts/.jsx/.js file under client/ (e.g. "client/portal/page.tsx").');
    }
    if (typeof page.slug !== 'string' || !PORTAL_SLUG_RE.test(page.slug)) {
        out.push('frontend.portalPage.slug must be lowercase letters, digits and inner hyphens (it becomes /portal/<slug>).');
    }
    if (page.title !== undefined && (typeof page.title !== 'string' || !page.title.trim() || page.title.length > PORTAL_TITLE_MAX || /[<>]/.test(page.title))) {
        out.push(`frontend.portalPage.title must be a non-empty string of at most ${PORTAL_TITLE_MAX} characters, without < or >.`);
    }
    if (page.themeColor !== undefined && (typeof page.themeColor !== 'string' || !PORTAL_THEME_COLOR_RE.test(page.themeColor))) {
        out.push('frontend.portalPage.themeColor must be a hex colour such as "#2563eb".');
    }
    if (page.viewportFit !== undefined && !PORTAL_VIEWPORT_FITS.includes(page.viewportFit)) {
        out.push(`frontend.portalPage.viewportFit must be one of ${PORTAL_VIEWPORT_FITS.join(', ')}.`);
    }
    if (page.serviceWorker !== undefined && (typeof page.serviceWorker !== 'string' || !PORTAL_SW_RE.test(page.serviceWorker) || page.serviceWorker.split('/').includes('..'))) {
        out.push('frontend.portalPage.serviceWorker must be a .js file under client/ (e.g. "client/portal/sw.js").');
    }
    if (page.file !== undefined && (typeof page.file !== 'string' || !PORTAL_FILE_ROUTE_RE.test(page.file))) {
        out.push('frontend.portalPage.file must be one of the plugin\'s public routes, such as "/public/file".');
    }
    if (page.pages !== undefined) {
        if (!isPlainObject(page.pages)) out.push('frontend.portalPage.pages must be an object { "<page>": { title?, private?, app? } }.');
        else {
            const names = Object.keys(page.pages);
            if (names.length > PORTAL_PAGES_MAX) out.push(`frontend.portalPage.pages may describe at most ${PORTAL_PAGES_MAX} pages.`);
            for (const name of names) {
                if (!PORTAL_SLUG_RE.test(name) || PORTAL_RESERVED_PAGES.includes(name)) {
                    out.push(`frontend.portalPage.pages: "${name.slice(0, 64)}" must be one lowercase path segment (letters, digits, inner hyphens), and not ${PORTAL_RESERVED_PAGES.join(', ')}.`);
                    continue;
                }
                out.push(...pageProblems(name, page.pages[name]));
            }
        }
    }
    return out;
}

/**
 * What the /portal/<slug> page puts in its <head>, from a VALID declaration (validatePortalPage): only the
 * optional fields that are set, never anything else from the manifest.
 */
type PortalApp = { name: string; shortName?: string; description?: string; backgroundColor?: string; themeColor?: string };
type PortalSubPage = { title?: string; private?: boolean; app?: PortalApp };
type PortalHead = {
    title?: string; themeColor?: string; viewportFit?: string;
    pages?: Record<string, PortalSubPage>; serviceWorker?: true; file?: true;
};
function portalPageHead(manifest: any): PortalHead {
    const page = (manifest && manifest.frontend && manifest.frontend.portalPage) || {};
    const out: PortalHead = {};
    if (typeof page.title === 'string') out.title = page.title;
    if (typeof page.themeColor === 'string') out.themeColor = page.themeColor;
    if (typeof page.viewportFit === 'string') out.viewportFit = page.viewportFit;
    // Whether the core serves the portal's service worker / file route — never their paths.
    if (typeof page.serviceWorker === 'string') out.serviceWorker = true;
    if (typeof page.file === 'string') out.file = true;
    if (isPlainObject(page.pages)) {
        const pages: Record<string, PortalSubPage> = {};
        for (const [name, p] of Object.entries(page.pages as Record<string, any>)) {
            const one: PortalSubPage = {};
            if (typeof p.title === 'string') one.title = p.title;
            if (p.private === true) one.private = true;
            if (isPlainObject(p.app)) {
                const app: PortalApp = { name: p.app.name };
                for (const key of ['shortName', 'description', 'backgroundColor', 'themeColor'] as const) {
                    if (typeof p.app[key] === 'string') app[key] = p.app[key];
                }
                one.app = app;
            }
            pages[name] = one;
        }
        if (Object.keys(pages).length) out.pages = pages;
    }
    return out;
}

/** The portal's service worker file (relative to the plugin folder) from a VALID declaration, or null. */
function portalServiceWorker(manifest: any): string | null {
    const sw = manifest && manifest.frontend && manifest.frontend.portalPage && manifest.frontend.portalPage.serviceWorker;
    return typeof sw === 'string' ? sw.replace(/^\.\//, '') : null;
}

/** The plugin route of the portal's file downloads from a VALID declaration ("/public/…"), or null. */
function portalFileRoute(manifest: any): string | null {
    const file = manifest && manifest.frontend && manifest.frontend.portalPage && manifest.frontend.portalPage.file;
    return typeof file === 'string' ? file : null;
}

/**
 * Every installed plugin folder with the portal slug its manifest declares (null: none, or unreadable).
 * Read from disk on every call — an install a moment ago must count — and as the HOST (plugin-context
 * runAsHost), for the same reason as core/adminMenu.ts installedAdminPages: this can run inside a bridged
 * plugin call, where io-guard refuses the plugin the plugins directory.
 */
function installedPortalPages(): Map<string, string | null> {
    return require('./plugin-context').runAsHost(readInstalledPortalPages);
}

function readInstalledPortalPages(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    try {
        const fs = require('fs');
        const path = require('path');
        const { PLUGINS_DIR } = require('./plugins');
        for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory() || !PLUGIN_FOLDER_RE.test(entry.name)) continue;
            const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            let slug: string | null = null;
            try { slug = portalPageSlugOf(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))); } catch { /* unreadable: no portal */ }
            out.set(entry.name, slug);
        }
    } catch { /* no plugins directory: nothing is installed */ }
    return out;
}

/**
 * Why plugin `pluginSlug` (installed, or being installed, in the folder of that name) may not have the
 * portal page its manifest declares, or null when it may. Checked at install and again at activation (a
 * folder copied by hand never went through the install). Two installed plugins never answer to the same
 * /portal/<slug>.
 */
function portalPageConflict(pluginSlug: string, manifest: any, installed: Map<string, string | null> = installedPortalPages()): string | null {
    const problems = validatePortalPage(manifest);
    if (problems.length) return problems.join(' ');
    const slug = portalPageSlugOf(manifest);
    if (slug === null) return null;
    const claimant = Array.from(installed).find(([folder, own]) => folder !== pluginSlug && own === slug);
    if (claimant) return `Its portal page "${slug}" (frontend.portalPage.slug) is already the portal page of the installed plugin "${claimant[0]}". Choose another portal slug.`;
    return null;
}

/**
 * The ACTIVE plugin folder whose valid manifest declares `slug` as its portal page, or null: none does,
 * or several do (then the portal is nobody's — the same rule as core/adminMenu.ts adminPageOwner).
 * `readManifest` is the caller's reader (routes/plugin-bundles.ts keeps its path-containment proof).
 */
function portalPageFolder(slug: string, activeFolders: unknown, readManifest: (folder: string) => any): string | null {
    if (!PORTAL_SLUG_RE.test(slug) || !Array.isArray(activeFolders)) return null;
    const owners: string[] = [];
    for (const folder of activeFolders) {
        if (typeof folder !== 'string' || !PLUGIN_FOLDER_RE.test(folder)) continue;
        const manifest = readManifest(folder);
        if (portalPageSlugOf(manifest) === slug && validatePortalPage(manifest).length === 0) owners.push(folder);
    }
    return owners.length === 1 ? owners[0] : null;
}

module.exports = {
    PORTAL_SLUG_RE,
    portalPageSlugOf,
    validatePortalPage,
    portalPageHead,
    portalServiceWorker,
    portalFileRoute,
    portalPageConflict,
    portalPageFolder,
};
