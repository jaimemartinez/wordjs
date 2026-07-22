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
const ALLOWED_BUNDLE_TYPES = new Set(['admin', 'component', 'hooks']);

/**
 * Resolve a request slug to the plugin's on-disk FOLDER.
 *
 * The admin URL uses `manifest.frontend.adminPage.slug` ("youtube"), which frequently DIFFERS from the
 * folder ("youtube-videos") — so keying the bundle path off the raw slug 404s for every such plugin.
 * Prefer an exact folder match (cheap, and what already-matching plugins rely on), else scan manifests
 * for a declared adminPage slug. Returns null when nothing matches.
 */
function resolvePluginDir(slug: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    if (fs.existsSync(path.join(PLUGINS_DIR, slug, 'manifest.json'))) return slug;
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);
    } catch { return null; }
    for (const folder of entries) {
        if (!/^[a-zA-Z0-9_-]+$/.test(folder)) continue;   // never route to an odd dir name
        try {
            const m = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, folder, 'manifest.json'), 'utf8'));
            if (m?.frontend?.adminPage?.slug === slug) return folder;
        } catch { /* unreadable/invalid manifest → skip */ }
    }
    return null;
}

/** Join under PLUGINS_DIR and re-assert containment (defense in depth against a crafted folder name). */
function bundlePathFor(folder: string, bundleType: string): string | null {
    const p = path.join(PLUGINS_DIR, folder, 'dist', `${bundleType}.bundle.js`);
    const root = path.resolve(PLUGINS_DIR);
    const resolved = path.resolve(p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

/**
 * GET /api/v1/plugins/:slug/bundle
 * 
 * Returns the admin.bundle.js for a plugin.
 * The bundle uses external references to React which are
 * provided by the WordJS host at runtime.
 */
router.get('/:slug/bundle', async (req: Request, res: Response) => {
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
});

/**
 * GET /api/v1/plugins/:slug/bundle/manifest
 * 
 * Returns build manifest for a plugin bundle
 */
router.get('/:slug/bundle/manifest', async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const manifestPath = path.join(PLUGINS_DIR, slug, 'dist', 'manifest.build.json');

    if (!fs.existsSync(manifestPath)) {
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
router.get('/:slug/bundle/css', async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const bundleType = req.query.type || 'admin';

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Validate bundle type against the allow-list (prevent `type=../..` path traversal).
    if (!ALLOWED_BUNDLE_TYPES.has(String(bundleType))) {
        return res.status(400).json({ error: 'Invalid bundle type' });
    }

    const cssPath = path.join(PLUGINS_DIR, slug, 'dist', `${bundleType}.bundle.css`);

    if (!fs.existsSync(cssPath)) {
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
});

module.exports = router;
