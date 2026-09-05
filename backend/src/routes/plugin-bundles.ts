/**
 * Plugin Bundle API Routes
 * Serves pre-compiled plugin frontend bundles
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');

// Allow-listed bundle types. The `type` query param is interpolated into the on-disk path, so an
// unvalidated value (e.g. '../../..') is a path-traversal primitive even with the fixed '.bundle.js'
// suffix. Only these three bundles are produced by the build pipeline and requested by the frontend
// (pluginBundleLoader: 'admin' | 'component' | 'hooks').
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
} = require('../core/io-guard');
const ALLOWED_BUNDLE_TYPES = new Set(PLUGIN_BUNDLE_TYPES);

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

/**
 * Resolve a request slug to the plugin's on-disk FOLDER.
 *
 * The admin URL uses `manifest.frontend.adminPage.slug` ("youtube"), which frequently DIFFERS from the
 * folder ("youtube-videos") — so keying the bundle path off the raw slug 404s for every such plugin.
 * Prefer an exact folder match (cheap, and what already-matching plugins rely on), else scan manifests
 * for a declared adminPage slug. Returns null when nothing matches.
 */
// Join request-influenced segments under a root and confirm the result stays INSIDE it — the
// path-injection barrier. Returns an absolute path, or null if the segments escape the root. Every
// filesystem access below flows through this so a crafted slug can never read outside PLUGINS_DIR.
function safeJoin(root: string, ...segs: string[]): string | null {
    const base = path.resolve(root);
    const resolved = path.resolve(base, ...segs);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

function resolvePluginDir(slug: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    const direct = safeJoin(PLUGINS_DIR, slug, 'manifest.json');
    if (direct && fs.existsSync(direct)) return slug;
    let entries: string[];
    try {
        entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);
    } catch { return null; }
    for (const folder of entries) {
        if (!/^[a-zA-Z0-9_-]+$/.test(folder)) continue;   // never route to an odd dir name
        const mp = safeJoin(PLUGINS_DIR, folder, 'manifest.json');
        if (!mp) continue;
        try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            if (m?.frontend?.adminPage?.slug === slug) return folder;
        } catch { /* unreadable/invalid manifest → skip */ }
    }
    return null;
}

function bundlePathFor(folder: string, bundleType: string): string | null {
    return resolveBundleFile(folder, `${bundleType}.bundle.js`);
}

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
 *     description: Serves plugins/<folder>/dist/<type>.bundle.js. Unauthenticated, like the other static plugin assets. The slug may be either the on-disk folder or the admin page slug declared in the plugin manifest; anything outside the character allowlist, and any bundle type outside the allowlist, is refused rather than joined into a path. The URL is unversioned, so the response carries a weak ETag and Cache-Control no-cache - send If-None-Match to get a 304.
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
 *           enum: [admin, component, hooks]
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
 *         description: No such plugin, or the plugin has not been built
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

    // Map the ADMIN slug to the on-disk folder (they differ for most plugins).
    const folder = resolvePluginDir(slug);
    const bundlePath = folder ? bundlePathFor(folder, String(bundleType)) : null;

    if (!bundlePath || !fs.existsSync(bundlePath)) {
        return res.status(404).json({
            error: 'Bundle not found',
            hint: `Plugin '${slug}' may not have been built. Run: node scripts/build-plugin.js ${folder || slug}`
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
 *     summary: Read the build manifest of a plugin bundle
 *     description: Serves plugins/<folder>/dist/manifest.build.json. A slug that resolves to no installed folder is a 404 - the raw slug is never used as a directory name.
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
 *         description: The build manifest
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid plugin slug
 *       404:
 *         description: No such plugin, or no build manifest was published
 *       500:
 *         description: The manifest could not be read or parsed
 */
router.get('/:slug/bundle/manifest', async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // A slug that resolves to no installed folder is a 404 — never fall back to the RAW slug as a
    // directory name (that reintroduced request-controlled text into the path after the folder
    // mapping had already refused it).
    const folder = resolvePluginDir(slug);
    const manifestPath = folder ? resolveBundleFile(folder, 'manifest.build.json') : null;

    if (!manifestPath || !fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: 'Build manifest not found' });
    }

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        res.json(manifest);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read manifest' });
    }
});

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
 *     description: Same slug mapping, allowlist and containment proof as the JavaScript bundle. A plugin with no stylesheet is not an error - the response is 200 with an empty body, so the loader can always issue the request. Cached by ETag revalidation, like the bundle.
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
 *           enum: [admin, component, hooks]
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
    const folder = resolvePluginDir(slug);
    const cssPath = folder ? resolveBundleFile(folder, `${bundleType}.bundle.css`) : null;

    if (!cssPath || !fs.existsSync(cssPath)) {
        // No CSS is fine, return empty
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

module.exports = router;
