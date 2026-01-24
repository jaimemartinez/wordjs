/**
 * WordJS - Plugins Routes
 * /api/v1/plugins/*
 */

const express = require('express');
const router = express.Router();
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getAllPlugins, activatePlugin, deactivatePlugin, createSamplePlugin, PLUGINS_DIR } = require('../core/plugins');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { execFile } = require('child_process');

// Configure multer for zip uploads
const upload = multer({
    dest: 'os-tmp/', // Use system temp dir or local tmp
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        // SECURITY: Prevent CVE-2025-47935/47944 DoS
        files: 1,           // Only 1 plugin zip per request
        fields: 10,         // Minimal fields needed
        parts: 15           // Limited total parts
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed'));
        }
    }
});

/**
 * Regenerate the frontend and admin plugin registries
 * Called when plugins are activated/deactivated
 */
function regenerateRegistry() {
    const scriptsDir = path.resolve(__dirname, '../../../admin-next/scripts');
    const scripts = [
        'generate-plugin-registry.js',         // Frontend components
        'generate-admin-plugin-registry.js',   // Admin pages
        'generate-puck-plugin-registry.js'     // Puck components
    ];

    for (const script of scripts) {
        const scriptPath = path.join(scriptsDir, script);

        if (!fs.existsSync(scriptPath)) {
            console.log(`⚠️  Script not found: ${script}`);
            continue;
        }

        // SECURITY: Use execFile instead of exec to prevent command injection
        execFile('node', [scriptPath], (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Failed to run ${script}:`, error.message);
                return;
            }
            if (process.env.NODE_ENV !== 'production') {
                console.log(`🔄 ${script}:`);
                console.log(stdout);
            }
        });
    }
}

/**
 * SECURITY: Validate plugin slug to prevent path traversal
 */
function validateSlug(slug) {
    // Only allow alphanumeric, dashes, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return false;
    }
    // Ensure the resolved path is still within PLUGINS_DIR
    const safePath = path.resolve(PLUGINS_DIR, slug);
    return safePath.startsWith(path.resolve(PLUGINS_DIR));
}
/**
 * POST /plugins/upload
 * Upload and install a plugin
 */
router.post('/upload', authenticate, isAdmin, upload.single('plugin'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const zipPath = req.file.path;

    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // Security: Check for Zip Slip (Directory Traversal)
        zipEntries.forEach(entry => {
            if (entry.entryName.indexOf('..') !== -1) {
                throw new Error('Malicious zip file detected (Zip Slip)');
            }
        });

        // Basic validation: ensure it extracts into a folder
        // We expect the zip to contain a root folder, e.g. "my-plugin/"
        // If it contains directly files, we might want to create a folder based on filename, 
        // but standard WP plugins usually come in a folder. 
        // Let's assume standard structure or create folder from filename.

        // Check if root entry is a folder
        const mainEntry = zipEntries[0];
        let targetFolder = PLUGINS_DIR;
        let pluginSlug = '';

        // Simple extraction: extract all to PLUGINS_DIR
        // If the zip creates a folder, great. If not, messy.
        // Let's create a folder based on the zip filename (minus extension) to be safe.
        const zipName = path.parse(req.file.originalname).name;
        const potentialDir = path.join(PLUGINS_DIR, zipName);

        // Check if zip has a single root directory
        const rootDirs = new Set(zipEntries.map(e => e.entryName.split('/')[0]).filter(Boolean));

        if (rootDirs.size === 1) {
            // Extract as is
            zip.extractAllTo(PLUGINS_DIR, true);
            pluginSlug = Array.from(rootDirs)[0];
        } else {
            // Extract into a new folder named after zip
            // This happens if the user zipped files directly without a parent folder
            zip.extractAllTo(potentialDir, true);
            pluginSlug = zipName;
        }

        // Cleanup temp file
        fs.unlinkSync(zipPath);

        res.json({ success: true, message: 'Plugin installed successfully', slug: pluginSlug });
    } catch (error) {
        // Cleanup temp file on error
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        throw new Error(`Failed to install plugin: ${error.message}`);
    }
}));

/**
 * GET /plugins/registry
 * Public endpoint - returns full manifest data for active plugins
 * Used by frontend for dynamic plugin loading
 */
router.get('/registry', asyncHandler(async (req, res) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activePlugins = plugins.filter(p => p.active);

    const registry = [];

    for (const plugin of activePlugins) {
        const manifestPath = path.join(PLUGINS_DIR, plugin.slug, 'manifest.json');

        if (fs.existsSync(manifestPath)) {
            try {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                registry.push({
                    ...manifest,
                    active: true,
                    path: `/plugins/${plugin.slug}`
                });
            } catch (err) {
                console.warn(`Failed to read manifest for ${plugin.slug}:`, err.message);
                // Still include basic info even without manifest
                registry.push({
                    id: plugin.slug,
                    name: plugin.name || plugin.slug,
                    version: plugin.version || '1.0.0',
                    active: true,
                    path: `/plugins/${plugin.slug}`,
                    frontend: null
                });
            }
        } else {
            // Plugin exists but no manifest - include basic info
            registry.push({
                id: plugin.slug,
                name: plugin.name || plugin.slug,
                version: plugin.version || '1.0.0',
                active: true,
                path: `/plugins/${plugin.slug}`,
                frontend: null
            });
        }
    }

    res.json({ plugins: registry });
}));

/**
 * GET /plugins/active
 * Public endpoint - returns only active plugin slugs (no auth required)
 */
router.get('/active', asyncHandler(async (req, res) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activeSlugs = plugins
        .filter(p => p.active)
        .map(p => p.slug);
    res.json(activeSlugs);
}));

/**
 * GET /plugins
 * List all plugins (requires admin)
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    res.json(plugins);
}));

/**
 * POST /plugins/:slug/activate
 * Activate a plugin and regenerate frontend registry
 */
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // SECURITY: Validate slug to prevent path traversal
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const result = await activatePlugin(req.params.slug);

    // Trigger frontend registry regeneration
    regenerateRegistry();

    res.json(result);
}));

/**
 * POST /plugins/:slug/deactivate
 * Deactivate a plugin and regenerate frontend registry
 */
router.post('/:slug/deactivate', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const result = await deactivatePlugin(req.params.slug);

    // Trigger frontend registry regeneration
    regenerateRegistry();

    res.json(result);
}));

/**
 * DELETE /plugins/:slug
 * Delete a plugin (must be inactive)
 * Requires password in body for security
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const slug = req.params.slug;
    const { password } = req.body;
    const { isPluginActive, deactivatePlugin, PLUGINS_DIR } = require('../core/plugins');
    const User = require('../models/User');

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    // 0. Verify password
    // req.user is populated by authenticate middleware
    try {
        await User.authenticate(req.user.userLogin, password);
    } catch (error) {
        return res.status(403).json({ message: 'Invalid password' });
    }

    // 1. Check if active (Async)
    if (await isPluginActive(slug)) {
        return res.status(400).json({ message: 'Cannot delete an active plugin. Deactivate it first.' });
    }

    // 2. Locate directory
    const pluginPath = path.join(PLUGINS_DIR, slug);
    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ message: 'Plugin not found' });
    }

    // 3. Delete directory recursively
    try {
        fs.rmSync(pluginPath, { recursive: true, force: true });

        // Regenerate registry to remove traces
        regenerateRegistry();

        res.json({ success: true, message: `Plugin ${slug} deleted successfully` });
    } catch (err) {
        throw new Error(`Failed to delete plugin: ${err.message}`);
    }
}));

/**
 * GET /plugins/:slug/download
 * Download a plugin as a ZIP file
 */
router.get('/:slug/download', authenticateAllowQuery, isAdmin, asyncHandler(async (req, res) => {
    const slug = req.params.slug;
    const { PLUGINS_DIR } = require('../core/plugins');
    const pluginPath = path.join(PLUGINS_DIR, slug);

    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ error: 'Plugin not found' });
    }

    // Initialize zip
    const zip = new AdmZip();

    // Add local folder to zip
    // 2nd param defines path in zip - we want it in a folder named {slug}
    zip.addLocalFolder(pluginPath, slug);

    // Create a buffer
    const zipBuffer = zip.toBuffer();

    // Set headers for download
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=${slug}.zip`);
    res.set('Content-Length', zipBuffer.length);

    res.send(zipBuffer);
}));

/**
 * POST /plugins/sample
 * Create sample plugin
 */
router.post('/sample', authenticate, isAdmin, asyncHandler(async (req, res) => {
    createSamplePlugin();
    res.json({ success: true, message: 'Sample plugin created in /plugins/hello-world' });
}));

/**
 * GET /plugins/menus
 * Get all admin menu items registered by ACTIVE plugins only
 * Uses filters to allow dynamic visibility rules
 */
router.get('/menus', authenticate, asyncHandler(async (req, res) => {
    const { getAdminMenuItems } = require('../core/adminMenu');
    const { getActivePlugins } = require('../core/plugins');
    const { applyFiltersSync } = require('../core/hooks');

    const allMenus = getAdminMenuItems();
    console.log(`DEBUG: /menus - allMenus count: ${allMenus.length}`);
    // Await async getActivePlugins
    const activePlugins = await getActivePlugins();

    // 1. Filter menus to only include those from active plugins or core
    let activeMenus = allMenus.filter(menu => menu.plugin === 'core' || activePlugins.includes(menu.plugin));

    // 2. Apply filters to allows plugins to hide/modify items per user
    activeMenus = applyFiltersSync('admin_menu_items', activeMenus, { user: req.user });

    console.log('DEBUG: /plugins/menus response:', JSON.stringify(activeMenus, null, 2));

    res.json(activeMenus);
}));

module.exports = router;
