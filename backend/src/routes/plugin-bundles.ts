/**
 * Plugin Bundle API Routes
 * Serves pre-compiled plugin frontend bundles, and the styling of a plugin's admin page.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { authenticate } = require('../middleware/auth');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');

// Allow-listed bundle types. The `type` query param is interpolated into the on-disk path, so an
// unvalidated value (e.g. '../../..') is a path-traversal primitive even with the fixed '.bundle.js'
// suffix. Only these bundles are produced by the build pipeline and requested by the frontend
// (pluginBundleLoader: 'admin' | 'component' | 'hooks' | 'portal').
//
// (#3, verification) THESE ROUTES ARE THE OTHER PUBLIC SINK FOR A PLUGIN'S FILES. They are mounted
// under /api/v1/plugins (routes/plugins.ts) WITHOUT `authenticate`, and they hand out files from
// plugins/<folder>/dist/ — a directory the plugin itself could write, since the first remediation
// only declared `dist/component.bundle.css` off-limits. That is the exact write→unauthenticated-read
// channel #3 is about, one door along. The declaration now lives in core/io-guard (dist/ is published
// in full ⇒ read-only to the plugin) and this file RESOLVES AGAINST IT instead of building the path
// by hand, so "what may be served" and "what may not be written" cannot drift apart again.
const {
    isPluginBundleRelPath,
    PLUGIN_BUNDLE_DIR,
    PLUGIN_BUNDLE_TYPES,
    PLUGIN_ADMIN_STYLESHEET,
} = require('../core/io-guard');
const ALLOWED_BUNDLE_TYPES = new Set(PLUGIN_BUNDLE_TYPES);
// The JavaScript bundle file names GET /:slug/bundle serves — what /bundle/manifest may list.
const SERVED_BUNDLE_NAMES: readonly string[] = PLUGIN_BUNDLE_TYPES.map((t: string) => `${t}.bundle.js`);
// WHICH plugins may be served (active; dist/ also needs browser:script) — one answer, shared with the
// static /plugins mount in index.ts. Read through the module object at request time.
const pluginServing = require('../core/plugin-serving');

const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery } = require('../core/query-params');

/**
 * The one query parameter the two bundle routes read.
 *
 * This site FAILED CLOSED before the rule reached it: `ALLOWED_BUNDLE_TYPES.has(String(bundleType))`
 * turns ['admin','admin'] into 'admin,admin', misses the allow-list, and answers 400 — so it was not
 * a security defect, and nothing here is a fix for one. It is declared because the rule must not
 * differ per call site: the same polluted URL now answers 400 `rest_invalid_param` naming `type`
 * here, exactly as it does on every other route, instead of a generic "Invalid bundle type" that
 * describes a mistake the caller did not make.
 */
const BUNDLE_QUERY_FIELDS: readonly string[] = Object.freeze(['type']);

/**
 * Resolve one of the published bundle files for `folder`, proving BOTH halves on the values actually
 * used: the relative name must be on io-guard's bundle allowlist, and the joined path must stay
 * inside PLUGINS_DIR. Returns null if either proof fails.
 */
function resolveBundleFile(folder: string, relName: string): string | null {
    const rel = `${PLUGIN_BUNDLE_DIR}/${relName}`;
    if (!isPluginBundleRelPath(rel)) return null;
    return safeJoin(PLUGINS_DIR, folder, ...rel.split('/'));
}

// Join request-influenced segments under a root and confirm the result stays INSIDE it — the
// path-injection barrier. Returns an absolute path, or null if the segments escape the root. Every
// filesystem access below flows through this so a crafted slug can never read outside PLUGINS_DIR.
function safeJoin(root: string, ...segs: string[]): string | null {
    const base = path.resolve(root);
    const resolved = path.resolve(base, ...segs);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/** The parsed manifest of an installed plugin folder, or null (absent, unreadable, not JSON). */
function readManifest(folder: string): any {
    const mp = safeJoin(PLUGINS_DIR, folder, 'manifest.json');
    if (!mp) return null;
    try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        return m && typeof m === 'object' ? m : null;
    } catch { return null; }
}

/**
 * Resolve a request slug to the on-disk FOLDER of an ACTIVE plugin. Returns null when no active plugin
 * answers to it.
 *
 * The admin URL uses `manifest.frontend.adminPage.slug` ("youtube"), which frequently DIFFERS from the
 * folder ("youtube-videos") — so keying the bundle path off the raw slug 404s for every such plugin.
 * An exact folder match is tried first, then the adminPage slugs the active plugins declare.
 *
 * ONLY ACTIVE PLUGINS ARE CANDIDATES. This used to resolve against every INSTALLED folder, which made
 * these anonymous routes an inventory of the install in three ways: the admin-slug alias of an
 * inactive plugin resolved; an installed folder was found with one existsSync while an unknown slug
 * paid a readdir plus a parse of every manifest on disk; and the routes then answered the two cases
 * with different bodies (a build hint naming the folder, a 200 empty stylesheet for "no such plugin"
 * against a 404 for "installed, inactive"). The work done here now depends only on the active list —
 * public by design (GET /plugins/active) — so an inactive plugin is indistinguishable from one that
 * was never installed.
 */
async function resolvePluginDir(slug: string): Promise<string | null> {
    if (!SLUG_RE.test(slug)) return null;
    if (await pluginServing.pluginFilesServable(slug)) return slug;
    const { getActivePlugins } = require('../core/plugins');
    let active: unknown;
    try { active = await getActivePlugins(); } catch { return null; }
    if (!Array.isArray(active)) return null;
    for (const folder of active) {
        if (typeof folder !== 'string' || !SLUG_RE.test(folder)) continue;   // never route to an odd dir name
        if (readManifest(folder)?.frontend?.adminPage?.slug === slug) return folder;
    }
    return null;
}

function bundlePathFor(folder: string, bundleType: string): string | null {
    return resolveBundleFile(folder, `${bundleType}.bundle.js`);
}

/**
 * Resolve a PORTAL slug (manifest frontend.portalPage.slug — the `<slug>` of /portal/<slug>) to the
 * folder of the one ACTIVE plugin that declares it (core/portal-pages.ts). Never by folder name: the
 * portal URL is the only name the frontend has for a plugin installed at runtime, and a folder that
 * happens to share a portal's name must not answer for it.
 */
async function resolvePortalDir(slug: string): Promise<string | null> {
    const { getActivePlugins } = require('../core/plugins');
    let active: unknown;
    try { active = await getActivePlugins(); } catch { return null; }
    return require('../core/portal-pages').portalPageFolder(slug, active, readManifest);
}

/**
 * The folder whose build output may be served for `slug`, or null: an ACTIVE plugin (resolvePluginDir,
 * or resolvePortalDir for the portal bundle) that is granted browser:script (core/plugin-serving
 * browserCodeServable — the gate the static /plugins/<folder>/dist/component.bundle.css applies too).
 * Every refusal below is the SAME 404 as "no such plugin", so it says nothing about what is installed.
 */
async function servableBundleFolder(slug: string, bundleType: string = 'admin'): Promise<string | null> {
    const folder = bundleType === 'portal' ? await resolvePortalDir(slug) : await resolvePluginDir(slug);
    if (!folder) return null;
    return (await pluginServing.browserCodeServable(folder)) ? folder : null;
}

const NOT_SERVED = { error: 'Bundle not found' };

/**
 * GET /api/v1/plugins/:slug/bundle
 * 
 * Returns the admin.bundle.js for a plugin.
 * The bundle uses external references to React which are
 * provided by the WordJS host at runtime.
 */
// asyncHandler, because requireScalarQuery THROWS and this handler is async: without it Express 4
// never sees the rejection, the caller waits for a response that is not coming, and the refusal is
// rendered by nobody. It also stops any other rejection in here from hanging the request.
/**
 * @swagger
 * /plugins/{slug}/bundle:
 *   get:
 *     summary: Download a plugin pre-compiled frontend bundle
 *     description: Serves plugins/<folder>/dist/<type>.bundle.js - ONLY while the plugin is active and the administrator has granted it the browser:script capability (the bundle runs in the admin origin with the viewer's session); otherwise 404. Unauthenticated, because the public site loads Verso block bundles and plugin portal pages too. The slug may be either the on-disk folder or the admin page slug declared in the manifest of an ACTIVE plugin (inactive plugins are not candidates, so a slug alias never reveals an installed but inactive plugin); for type=portal it is the portal slug an active plugin declares (frontend.portalPage.slug), and only that; anything outside the character allowlist, and any bundle type outside the allowlist, is refused rather than joined into a path. The URL is unversioned, so the response carries a weak ETag and Cache-Control no-cache - send If-None-Match to get a 304.
 *     tags: [Plugins]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *       - in: query
 *         name: type
 *         required: false
 *         description: Which published bundle to serve. Defaults to admin.
 *         schema:
 *           type: string
 *           enum: [admin, component, hooks, portal]
 *       - in: header
 *         name: If-None-Match
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The bundle
 *         content:
 *           application/javascript:
 *             schema:
 *               type: string
 *       304:
 *         description: The bundle is unchanged (ETag match)
 *       400:
 *         description: Invalid plugin slug, an unknown bundle type, or a repeated type parameter (rest_invalid_param)
 *       404:
 *         description: No such plugin, the plugin is inactive or not granted browser:script, or it has not been built
 */
router.get('/:slug/bundle', asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, BUNDLE_QUERY_FIELDS);

    const { slug } = req.params as { slug: string };
    const bundleType = req.query.type || 'admin';

    // Validate slug (prevent path traversal)
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Validate bundle type against the allow-list (prevent `type=../..` path traversal).
    if (!ALLOWED_BUNDLE_TYPES.has(String(bundleType))) {
        return res.status(400).json({ error: 'Invalid bundle type' });
    }

    // Map the ADMIN slug (or, for the portal bundle, the PORTAL slug) to the on-disk folder (they differ
    // for most plugins) — among ACTIVE plugins only — and apply the browser:script gate. Not installed,
    // inactive and not granted are ONE answer.
    const folder = await servableBundleFolder(slug, String(bundleType));
    if (!folder) return res.status(404).json(NOT_SERVED);
    const bundlePath = bundlePathFor(folder, String(bundleType));

    if (!bundlePath || !fs.existsSync(bundlePath)) {
        // Reachable only for an active, granted plugin — whose existence the caller can already read
        // from GET /plugins/registry — so naming its folder in the hint discloses nothing new.
        return res.status(404).json({
            error: 'Bundle not found',
            hint: `Plugin '${slug}' may not have been built. Run: node scripts/build-plugin.js ${folder}`
        });
    }

    // CACHE CORRECTNESS: the bundle URL is UNVERSIONED (`/:slug/bundle?type=admin`) but its content
    // changes on every plugin rebuild/update. A prior `max-age=31536000` (1 year, immutable) meant an
    // updated plugin's new UI was invisible to already-cached clients for a YEAR. Use a validator
    // (ETag from size+mtime) + `no-cache` so the browser MUST revalidate: it gets a tiny 304 when the
    // bundle is unchanged (still fast) and the fresh bytes the moment the file changes.
    res.setHeader('Content-Type', 'application/javascript');
    const stat = fs.statSync(bundlePath);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
    }

    // Stream the file
    const stream = fs.createReadStream(bundlePath);
    stream.pipe(res);
}));

/**
 * GET /api/v1/plugins/:slug/bundle/manifest
 * 
 * Returns build manifest for a plugin bundle
 */
/**
 * @swagger
 * /plugins/{slug}/bundle/manifest:
 *   get:
 *     summary: List the bundles a plugin build published
 *     description: Reads plugins/<folder>/dist/manifest.build.json, under the same active + browser:script gate as the bundle, and returns only the names of the bundles it lists that this API would serve. The rest of the build manifest (slug, externals, the plugin version) is never returned - the endpoint is unauthenticated, and an exact version is an inventory to match against known-vulnerable releases. A slug that resolves to no active plugin is a 404, identical to the refusal - the raw slug is never used as a directory name.
 *     tags: [Plugins]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *     responses:
 *       200:
 *         description: The bundles the build published
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [bundles]
 *               properties:
 *                 bundles:
 *                   type: array
 *                   items:
 *                     type: string
 *                     enum: [admin.bundle.js, component.bundle.js, hooks.bundle.js, portal.bundle.js]
 *       400:
 *         description: Invalid plugin slug
 *       404:
 *         description: No such plugin, the plugin is inactive or not granted browser:script, or no build manifest was published
 *       500:
 *         description: The manifest could not be read or parsed
 */
router.get('/:slug/bundle/manifest', asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // A slug that resolves to no active, granted plugin is a 404 — never fall back to the RAW slug as
    // a directory name (that reintroduced request-controlled text into the path after the folder
    // mapping had already refused it).
    const folder = await servableBundleFolder(slug);
    const manifestPath = folder ? resolveBundleFile(folder, 'manifest.build.json') : null;

    if (!manifestPath || !fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: 'Build manifest not found' });
    }

    // NEVER PASS THE FILE THROUGH. build-plugin.js writes { slug, bundles, externals, version } here,
    // and this route is anonymous: handing the file out published the exact version of every active
    // plugin that ships browser code — the inventory the static mount stopped serving with
    // manifest.json. Return only what a client can use, the bundle names, and only names this router
    // would itself serve (the file is plugin build output; nothing else in it is echoed).
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const listed: unknown[] = Array.isArray(manifest?.bundles) ? manifest.bundles : [];
        const bundles = SERVED_BUNDLE_NAMES.filter((name) => listed.includes(name));
        res.json({ bundles });
    } catch {
        res.status(500).json({ error: 'Failed to read manifest' });
    }
}));

/**
 * GET /api/v1/plugins/:slug/bundle/css
 * 
 * Returns CSS bundle for a plugin (if exists)
 */
/**
 * @swagger
 * /plugins/{slug}/bundle/css:
 *   get:
 *     summary: Download the stylesheet that goes with a plugin bundle
 *     description: Same slug mapping (the portal slug for type=portal), allowlist, containment proof and active + browser:script gate as the JavaScript bundle. A served plugin with no stylesheet is not an error - the response is 200 with an empty body, so the loader can always issue the request. A slug that is not installed, inactive or not granted is the same 404. Cached by ETag revalidation, like the bundle.
 *     tags: [Plugins]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *       - in: query
 *         name: type
 *         required: false
 *         description: Which published bundle stylesheet to serve. Defaults to admin.
 *         schema:
 *           type: string
 *           enum: [admin, component, hooks, portal]
 *       - in: header
 *         name: If-None-Match
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The stylesheet, or an empty body when the plugin ships none
 *         content:
 *           text/css:
 *             schema:
 *               type: string
 *       304:
 *         description: The stylesheet is unchanged (ETag match)
 *       400:
 *         description: Invalid plugin slug, an unknown bundle type, or a repeated type parameter (rest_invalid_param)
 *       404:
 *         description: No such plugin, or the plugin is inactive or not granted browser:script (one answer for all three)
 */
router.get('/:slug/bundle/css', asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, BUNDLE_QUERY_FIELDS);

    const { slug } = req.params as { slug: string };
    const bundleType = req.query.type || 'admin';

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Validate bundle type against the allow-list (prevent `type=../..` path traversal).
    if (!ALLOWED_BUNDLE_TYPES.has(String(bundleType))) {
        return res.status(400).json({ error: 'Invalid bundle type' });
    }

    // Same folder mapping + containment proof as the JS bundle. This route used to join the RAW slug
    // with path.join and no containment check at all — the one call site of this shape that the
    // hardening pass missed.
    //
    // Same gate as the JavaScript: the stylesheet of a bundle that is not served is not served either.
    // And "no such plugin" is the SAME 404: it used to fall through to the 200-empty answer below while
    // an installed-but-inactive plugin got a 404, so the status code alone told an anonymous caller
    // which slugs were installed.
    const folder = await servableBundleFolder(slug, String(bundleType));
    if (!folder) return res.status(404).json(NOT_SERVED);
    const cssPath = resolveBundleFile(folder, `${bundleType}.bundle.css`);

    if (!cssPath || !fs.existsSync(cssPath)) {
        // A served plugin that ships no CSS is fine: return empty, so the loader can always ask.
        res.setHeader('Content-Type', 'text/css');
        return res.send('');
    }

    // Same unversioned-URL cache trap as the JS bundle above — revalidate via ETag instead of a
    // year-long immutable cache, so an updated plugin's CSS reaches already-cached clients.
    res.setHeader('Content-Type', 'text/css');
    const stat = fs.statSync(cssPath);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
    }

    const stream = fs.createReadStream(cssPath);
    stream.pipe(res);
}));

// ═══ A PLUGIN PORTAL PAGE — anonymous, like the bundles ═══════════════════════════════════════════
//
// /portal/<slug> (frontend src/app/portal/[slug]/[[...path]]) is the standalone public page a plugin declares in
// frontend.portalPage (core/portal-pages.ts). Its server page asks this route first: a portal no active,
// granted plugin declares is a 404 there (a real HTTP 404, not a blank page), and a served one gets the
// few <head> details its manifest sets. Same resolution and gate as GET /:slug/bundle?type=portal, so
// the page and its bundle cannot disagree about whether the portal exists.

const PORTAL_NOT_FOUND = { error: 'Portal not found' };

/**
 * @swagger
 * /plugins/{slug}/portal:
 *   get:
 *     summary: Describe a plugin portal page
 *     description: For the portal slug an ACTIVE plugin declares in frontend.portalPage.slug, and only while the administrator has granted it browser:script, returns the optional head details of /portal/{slug} (title, themeColor, viewportFit), those of its sub-pages (pages), whether it has a service worker (serviceWorker) and, when it declares a file route, the API path that answers its tickets (fileEndpoint). Anything else - an unknown slug, an inactive plugin, a plugin not granted browser:script - is the same 404. Unauthenticated, because a portal's visitors are not WordJS users.
 *     tags: [Plugins]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
 *     responses:
 *       200:
 *         description: The portal is served
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug]
 *               properties:
 *                 slug:
 *                   type: string
 *                 title:
 *                   type: string
 *                 themeColor:
 *                   type: string
 *                 viewportFit:
 *                   type: string
 *                   enum: [auto, cover, contain]
 *                 pages:
 *                   type: object
 *                   description: Head details of sub-pages (/portal/{slug}/{page}), keyed by page.
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       title:
 *                         type: string
 *                       private:
 *                         type: boolean
 *                       app:
 *                         type: object
 *                         required: [name]
 *                         properties:
 *                           name:
 *                             type: string
 *                           shortName:
 *                             type: string
 *                           description:
 *                             type: string
 *                           backgroundColor:
 *                             type: string
 *                           themeColor:
 *                             type: string
 *                 serviceWorker:
 *                   type: boolean
 *                 fileEndpoint:
 *                   type: string
 *                   description: API path (under /api/v1) of the plugin's public route that turns a ticket (?d=) into a file.
 *       404:
 *         description: No active plugin granted browser:script declares this portal
 */
router.get('/:slug/portal', asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const portalPages = require('../core/portal-pages');
    // Shape first: nothing outside one lowercase URL segment is looked up at all.
    if (!portalPages.PORTAL_SLUG_RE.test(slug)) return res.status(404).json(PORTAL_NOT_FOUND);
    const folder = await servableBundleFolder(slug, 'portal');
    if (!folder) return res.status(404).json(PORTAL_NOT_FOUND);
    // Presentation of a public page — but per-install state (activation, grants), so never stored.
    res.setHeader('Cache-Control', 'no-store');
    const manifest = readManifest(folder);
    const { file, ...head } = portalPages.portalPageHead(manifest);
    const fileRoute = file ? portalPages.portalFileRoute(manifest) : null;
    // The plugin's own public route (routes are mounted under the plugin FOLDER) — the frontend's
    // /portal/<slug>/file asks it and answers the bytes.
    res.json({ slug, ...head, ...(fileRoute ? { fileEndpoint: `/plugin/${folder}${fileRoute}` } : {}) });
}));

/**
 * @swagger
 * /plugins/portals:
 *   get:
 *     summary: List the plugin portal pages that are served
 *     description: The portal pages (/portal/{slug}) that ACTIVE plugins granted browser:script serve right now - the same rule as GET /plugins/{slug}/portal - with their title, for the admin's menu editor to offer them as links. Signed-in users only.
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: The served portals, by slug
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 required: [slug]
 *                 properties:
 *                   slug:
 *                     type: string
 *                   title:
 *                     type: string
 *       401:
 *         description: Not signed in
 */
router.get('/portals', authenticate, asyncHandler(async (_req: Request, res: Response) => {
    const portalPages = require('../core/portal-pages');
    const { getActivePlugins } = require('../core/plugins');
    let active: unknown;
    try { active = await getActivePlugins(); } catch { active = []; }
    const out: Array<{ slug: string; title?: string }> = [];
    for (const folder of Array.isArray(active) ? active : []) {
        if (typeof folder !== 'string' || !SLUG_RE.test(folder)) continue;
        const slug = portalPages.portalPageSlugOf(readManifest(folder));
        // Exactly the portals GET /:slug/portal serves: the slug resolves to THIS folder (one owner, a valid
        // declaration) and the folder may serve browser code.
        if (!slug || await servableBundleFolder(slug, 'portal') !== folder) continue;
        const { title } = portalPages.portalPageHead(readManifest(folder));
        out.push(title ? { slug, title } : { slug });
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
}));

const PORTAL_SW_MAX_BYTES = 256 * 1024;

/**
 * @swagger
 * /plugins/{slug}/portal/sw:
 *   get:
 *     summary: A plugin portal's service worker
 *     description: The plain JavaScript file an ACTIVE plugin granted browser:script declares in frontend.portalPage.serviceWorker, as-is. The frontend serves it at /portal/{slug}/sw.js, so its scope can be the portal or any page below it. Anything else is the same 404 as GET /plugins/{slug}/portal. Unauthenticated.
 *     tags: [Plugins]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
 *     responses:
 *       200:
 *         description: The service worker script
 *         content:
 *           text/javascript:
 *             schema:
 *               type: string
 *       404:
 *         description: No active plugin granted browser:script declares this portal, or it has no service worker
 */
router.get('/:slug/portal/sw', asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const portalPages = require('../core/portal-pages');
    if (!portalPages.PORTAL_SLUG_RE.test(slug)) return res.status(404).json(PORTAL_NOT_FOUND);
    const folder = await servableBundleFolder(slug, 'portal');
    if (!folder) return res.status(404).json(PORTAL_NOT_FOUND);
    const rel = portalPages.portalServiceWorker(readManifest(folder));
    // The declaration is validated (a .js file under client/, no ".."), and the join is proven to stay
    // inside the plugin's folder all the same.
    const file = rel ? safeJoin(PLUGINS_DIR, folder, ...rel.split('/')) : null;
    const clientRoot = safeJoin(PLUGINS_DIR, folder, 'client');
    if (!file || !clientRoot || !file.startsWith(clientRoot + path.sep)) return res.status(404).json(PORTAL_NOT_FOUND);
    let body: Buffer;
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > PORTAL_SW_MAX_BYTES) return res.status(404).json(PORTAL_NOT_FOUND);
        body = fs.readFileSync(file);
    } catch { return res.status(404).json(PORTAL_NOT_FOUND); }
    // Revalidated on every update check (the browser compares it byte for byte); never sniffed.
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
}));

// ═══ THE ADMIN PAGE'S STYLING — signed-in sessions only ════════════════════════════════════════════
//
// The generated admin page (frontend/scripts/generate-admin-plugin-registry.js → /admin/plugin/<slug>)
// styles a plugin's page from two things the plugin ships: the manifest's `style` / `theme` fields and
// client/admin/admin.css. It used to fetch both from the STATIC /plugins mount, which answered anyone
// for every installed plugin, active or not — and serving the manifest meant serving all of it: name,
// exact version, author, requested permissions, dependencies. That is an inventory an attacker matches
// against known-vulnerable versions. These two routes replace that: they hand out exactly what the page
// reads, to a signed-in session, for an ACTIVE plugin.
//
// WHO: any signed-in user, not only administrators. Plugin admin pages are opened by non-administrators
// too — GET /plugins/menus shows a plugin's menu item to whoever holds its capability (the mail
// plugin's webmail is the shipped case) — so an administrator-only stylesheet would leave pages those
// users can open unstyled. Nothing here is sensitive to a signed-in user: the plugin is active (which
// GET /plugins/active already tells everyone), and what is returned is presentation.
//
// ANONYMOUS: `authenticate` answers 401 before the slug is looked at, identically for every slug —
// installed, inactive or never heard of — so the refusal confirms nothing. The old static URLs
// (/plugins/<slug>/manifest.json, /plugins/<slug>/client/admin/admin.css) are now a 404 for everyone.

const ADMIN_STYLE_NOT_FOUND = { error: 'Plugin admin page not found' };
// A theme variable becomes `--plugin-<key>: <value>` in a <style> the page injects; keys outside this
// shape are dropped here, and the page strips rule-breaking characters from values as well.
const THEME_KEY_RE = /^[a-zA-Z0-9-]+$/;

/** `manifest.theme` reduced to { key: string } with well-formed keys, or null if nothing is left. */
function themeVarsOf(theme: unknown): Record<string, string> | null {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(theme as Record<string, unknown>)) {
        if (!THEME_KEY_RE.test(key)) continue;
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        out[key] = String(value);
    }
    return Object.keys(out).length ? out : null;
}

/** Absolute path of `folder`'s admin stylesheet if it is a regular file, else null. */
function adminStylesheetOf(folder: string): string | null {
    const abs = safeJoin(PLUGINS_DIR, folder, ...PLUGIN_ADMIN_STYLESHEET.split('/'));
    if (!abs) return null;
    try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
}

/**
 * @swagger
 * /plugins/{slug}/admin-style:
 *   get:
 *     summary: Read the styling of a plugin admin page
 *     description: Returns only what the generated admin page reads to style /admin/plugin/<slug> - the manifest's style string and theme variables, and whether the plugin ships client/admin/admin.css (served by GET /plugins/{slug}/admin-style/css). Signed-in users only (any role - plugin admin pages are not administrator-only), and only for an ACTIVE plugin. The slug may be the plugin folder or the admin page slug its manifest declares. The plugin manifest itself is never returned. Responses are private and not stored.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *     responses:
 *       200:
 *         description: The admin page styling
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [style, theme, stylesheet]
 *               properties:
 *                 style:
 *                   type: string
 *                   nullable: true
 *                   description: The manifest's style string, or null.
 *                 theme:
 *                   type: object
 *                   nullable: true
 *                   additionalProperties:
 *                     type: string
 *                   description: The manifest's theme variables with well-formed keys, or null.
 *                 stylesheet:
 *                   type: boolean
 *                   description: Whether GET /plugins/{slug}/admin-style/css has a stylesheet to serve.
 *       400:
 *         description: Invalid plugin slug
 *       401:
 *         description: Not signed in (answered before the slug is looked at, the same for every slug)
 *       404:
 *         description: No ACTIVE plugin answers to that slug (not installed and inactive are one answer)
 */
router.get('/:slug/admin-style', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid plugin slug' });
    const folder = await resolvePluginDir(slug);
    if (!folder) return res.status(404).json(ADMIN_STYLE_NOT_FOUND);
    const manifest = readManifest(folder) || {};
    // The stylesheet is offered under the SAME rule that serves it (browserCodeServable, below), so the
    // page never links a URL that answers 404.
    const stylesheet = adminStylesheetOf(folder) !== null && await pluginServing.browserCodeServable(folder);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
        style: typeof manifest.style === 'string' && manifest.style ? manifest.style : null,
        theme: themeVarsOf(manifest.theme),
        stylesheet,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/admin-style/css:
 *   get:
 *     summary: Download the stylesheet of a plugin admin page
 *     description: Serves plugins/<folder>/client/admin/admin.css to a signed-in user - the stylesheet the generated admin page links - only for an ACTIVE plugin that is granted browser:script, the same rule as its dist/ bundles. The file is confined before it is served - rules that would load another resource (@import, url() other than data:, image-set() and the like) are removed, and every style rule is scoped so it does not reach the admin's own interface. It is not served from the static /plugins mount. Cache-Control private, no-cache with an ETag, so a deactivation or a revoke is seen at the next load and no shared cache keeps a copy.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *       - in: header
 *         name: If-None-Match
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The stylesheet
 *         content:
 *           text/css:
 *             schema:
 *               type: string
 *       304:
 *         description: The stylesheet is unchanged (ETag match)
 *       400:
 *         description: Invalid plugin slug
 *       401:
 *         description: Not signed in (answered before the slug is looked at, the same for every slug)
 *       404:
 *         description: No ACTIVE plugin granted browser:script answers to that slug, or it ships no admin stylesheet
 */
router.get('/:slug/admin-style/css', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid plugin slug' });
    const folder = await resolvePluginDir(slug);
    // A STYLESHEET IN THE ADMIN IS BROWSER CODE. It is linked as a full-page sheet on the plugin's admin
    // page, so it is served under the same rule as the plugin's dist/ build output: active AND granted
    // browser:script (core/plugin-serving browserCodeServable). The refusal is the same 404 as "no such
    // plugin". BOTH facts are evaluated before answering, like servableBundleFolder does.
    const servable = folder ? await pluginServing.browserCodeServable(folder) : false;
    const cssPath = folder && servable ? adminStylesheetOf(folder) : null;
    if (!cssPath) return res.status(404).json(ADMIN_STYLE_NOT_FOUND);
    let confined: { css: string; etag: string } | null;
    try {
        confined = confinedAdminStylesheet(cssPath);
    } catch {
        return res.status(500).json({ error: 'Failed to read stylesheet' });
    }
    if (!confined) return res.status(404).json(ADMIN_STYLE_NOT_FOUND);
    // private + no-cache: an admin asset never belongs in a shared cache, and revalidating (a cheap 304
    // on the ETag of the CONFINED output) is what makes a deactivation or a revoke take effect at the next
    // page load.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', confined.etag);
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').map((t) => t.trim()).includes(confined.etag)) {
        return res.status(304).end();
    }
    res.type('text/css; charset=utf-8').send(confined.css);
}));

/**
 * The confined form of a plugin's admin.css (core/plugin-admin-css: nothing that fetches, every rule
 * scoped away from the host's own UI), cached per file version — path, size and mtime — so a rebuilt or
 * updated plugin is re-confined at the next request and an unchanged one is not re-parsed. null when the
 * file is gone.
 */
const confinedCache = new Map<string, { version: string; css: string; etag: string }>();
const CONFINED_CACHE_MAX = 64;
function confinedAdminStylesheet(cssPath: string): { css: string; etag: string } | null {
    // ONE descriptor for the version check and the read: the file a stat describes and the file read
    // afterwards by path could differ (a plugin update swapping it in between).
    let fd: number;
    try { fd = fs.openSync(cssPath, 'r'); } catch { return null; }
    let source: string;
    let version: string;
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return null;
        version = `${stat.size}:${stat.mtimeMs}`;
        const hit = confinedCache.get(cssPath);
        if (hit && hit.version === version) return hit;
        source = fs.readFileSync(fd, 'utf8');
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    const { confinePluginAdminCss } = require('../core/plugin-admin-css');
    const css = confinePluginAdminCss(source);
    const etag = `"${require('crypto').createHash('sha256').update(css).digest('hex').slice(0, 32)}"`;
    if (confinedCache.size >= CONFINED_CACHE_MAX) confinedCache.delete(confinedCache.keys().next().value as string);
    const entry = { version, css, etag };
    confinedCache.set(cssPath, entry);
    return entry;
}

module.exports = router;
