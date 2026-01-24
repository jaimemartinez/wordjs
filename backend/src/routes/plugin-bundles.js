/**
 * Plugin Bundle API Routes
 * Serves pre-compiled plugin frontend bundles
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');

/**
 * GET /api/v1/plugins/:slug/bundle
 * 
 * Returns the admin.bundle.js for a plugin.
 * The bundle uses external references to React which are
 * provided by the WordJS host at runtime.
 */
router.get('/:slug/bundle', async (req, res) => {
    const { slug } = req.params;
    const bundleType = req.query.type || 'admin';

    // Validate slug (prevent path traversal)
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const bundlePath = path.join(PLUGINS_DIR, slug, 'dist', `${bundleType}.bundle.js`);

    if (!fs.existsSync(bundlePath)) {
        return res.status(404).json({
            error: 'Bundle not found',
            hint: `Plugin '${slug}' may not have been built. Run: node scripts/build-plugin.js ${slug}`
        });
    }

    // Set cache headers (bundles are versioned via manifest)
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year

    // Stream the file
    const stream = fs.createReadStream(bundlePath);
    stream.pipe(res);
});

/**
 * GET /api/v1/plugins/:slug/bundle/manifest
 * 
 * Returns build manifest for a plugin bundle
 */
router.get('/:slug/bundle/manifest', async (req, res) => {
    const { slug } = req.params;

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
router.get('/:slug/bundle/css', async (req, res) => {
    const { slug } = req.params;
    const bundleType = req.query.type || 'admin';

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const cssPath = path.join(PLUGINS_DIR, slug, 'dist', `${bundleType}.bundle.css`);

    if (!fs.existsSync(cssPath)) {
        // No CSS is fine, return empty
        res.setHeader('Content-Type', 'text/css');
        return res.send('');
    }

    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = fs.createReadStream(cssPath);
    stream.pipe(res);
});

module.exports = router;
