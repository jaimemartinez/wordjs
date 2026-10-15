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
    return out;
}

/**
 * What the /portal/<slug> page puts in its <head>, from a VALID declaration (validatePortalPage): only the
 * optional fields that are set, never anything else from the manifest.
 */
function portalPageHead(manifest: any): { title?: string; themeColor?: string; viewportFit?: string } {
    const page = (manifest && manifest.frontend && manifest.frontend.portalPage) || {};
    const out: { title?: string; themeColor?: string; viewportFit?: string } = {};
    if (typeof page.title === 'string') out.title = page.title;
    if (typeof page.themeColor === 'string') out.themeColor = page.themeColor;
    if (typeof page.viewportFit === 'string') out.viewportFit = page.viewportFit;
    return out;
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
    portalPageConflict,
    portalPageFolder,
};
