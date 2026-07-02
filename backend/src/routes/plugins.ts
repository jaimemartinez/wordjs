/**
 * WordJS - Plugins Routes
 * /api/v1/plugins/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getAllPlugins, activatePlugin, deactivatePlugin, createSamplePlugin, isPluginActive, validatePluginPermissions, validateManifestPermissions, PLUGINS_DIR } = require('../core/plugins');
const { assertZipWithinBudget } = require('../core/zip-guard');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { execFile } = require('child_process');

/**
 * @swagger
 * tags:
 *   name: Plugins
 *   description: Plugin management (Install, Activate, Delete)
 */

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
    fileFilter: (req: any, file: any, cb: any) => {
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
    // In production the frontend ships as a pre-built .next bundle, so the registries are baked in at
    // build time — regenerating the source .ts at runtime can't help (and frontend/scripts may not
    // ship). Only useful in dev, where rewriting the registry sources triggers Next HMR so a newly
    // activated plugin's admin page / Puck blocks appear WITHOUT the old manual "regenerate + restart".
    // (The path was '../../../admin-next/scripts' — a directory that does not exist — so this silently
    // no-op'd on every activate/deactivate. The real generators live in frontend/scripts/.)
    if (process.env.NODE_ENV === 'production') return;
    const scriptsDir = path.resolve(__dirname, '../../../frontend/scripts');
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
        execFile('node', [scriptPath], (error: Error | null, stdout: string, stderr: string) => {
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
function validateSlug(slug: string) {
    // Only allow alphanumeric, dashes, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return false;
    }
    // Ensure the resolved path is still within PLUGINS_DIR
    const safePath = path.resolve(PLUGINS_DIR, slug);
    return safePath.startsWith(path.resolve(PLUGINS_DIR));
}
/**
 * @swagger
 * /plugins/upload:
 *   post:
 *     summary: Upload and install a plugin (ZIP)
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               plugin:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Plugin installed
 *       400:
 *         description: Invalid file or zip slip detected
 */
router.post('/upload', authenticate, isAdmin, upload.single('plugin'), asyncHandler(async (req: any, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const zipPath = req.file.path;

    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // SECURITY: reject a decompression bomb BEFORE extracting (multer only capped the compressed
        // upload — a ~10MB DEFLATE stream can expand to many GB and fill the disk).
        try {
            assertZipWithinBudget(zipEntries, { kind: 'plugin' });
        } catch (e: any) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: e.message });
        }

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
        const rootDirs = new Set(zipEntries.map((e: any) => e.entryName.split('/')[0]).filter(Boolean));

        // SECURITY: Determine the extraction target, then verify EVERY entry
        // resolves inside it (Zip Slip: absolute paths, '..', symlink-style escapes).
        const targetDir = rootDirs.size === 1 ? PLUGINS_DIR : potentialDir;
        const resolvedTarget = path.resolve(targetDir);

        for (const entry of zipEntries) {
            const dest = path.resolve(targetDir, entry.entryName);
            const isContained = dest === resolvedTarget || dest.startsWith(resolvedTarget + path.sep);
            if (!isContained || entry.entryName.indexOf('..') !== -1) {
                fs.unlinkSync(zipPath);
                return res.status(400).json({ error: 'Malicious zip file detected (Zip Slip / path traversal)' });
            }
        }

        // SECURITY: an uploaded plugin must NOT claim a reserved system-plugin slug (which would let
        // it overwrite the bundled one via extractAllTo(..., true)). There is no trust tier anymore, so
        // this is just a small hardcoded reserved-name list (empty by default).
        const intendedSlug = (rootDirs.size === 1 ? Array.from(rootDirs)[0] : zipName) as string;
        // Canonicalize for comparison: a case-insensitive / Unicode-variant filesystem (Windows, macOS)
        // lets 'Mail-Server' overwrite the bundled 'mail-server' dir. Compare case-insensitively after NFC.
        const canonSlug = String(intendedSlug).normalize('NFC').toLowerCase();
        const RESERVED_SLUGS: string[] = [];
        if (RESERVED_SLUGS.some(s => String(s).normalize('NFC').toLowerCase() === canonSlug)) {
            fs.unlinkSync(zipPath);
            return res.status(409).json({ error: `Refused: '${intendedSlug}' is a reserved system plugin slug and cannot be uploaded or overwritten.` });
        }
        // Refuse a different-cased / Unicode-variant name that collides with an EXISTING plugin dir
        // (re-uploading the SAME exact name is still allowed = a normal update; a squat that only
        // differs by case/normalization is rejected so it can't clobber another plugin by path).
        try {
            const clash = fs.readdirSync(PLUGINS_DIR).find((d: string) => d !== intendedSlug && d.normalize('NFC').toLowerCase() === canonSlug);
            if (clash) {
                fs.unlinkSync(zipPath);
                return res.status(409).json({ error: `Refused: name collides with existing plugin '${clash}' (case/Unicode squat).` });
            }
        } catch { /* PLUGINS_DIR missing — nothing to clobber */ }

        // INTEGRITY: refuse to overwrite a RUNNING plugin's code in place — a botched extract would
        // corrupt a working plugin and the next reload would swap live code with no warning. The admin
        // must deactivate first (a real update flow can relax this later with staging + version checks).
        if (await isPluginActive(intendedSlug)) {
            fs.unlinkSync(zipPath);
            return res.status(409).json({ error: `Plugin '${intendedSlug}' is currently active. Deactivate it before re-uploading (this prevents corrupting a running plugin).` });
        }

        if (rootDirs.size === 1) {
            // Extract as is
            zip.extractAllTo(PLUGINS_DIR, true);
            pluginSlug = Array.from(rootDirs)[0] as string;
        } else {
            // Extract into a new folder named after zip
            // This happens if the user zipped files directly without a parent folder
            zip.extractAllTo(potentialDir, true);
            pluginSlug = zipName;
        }

        // VALIDATE what we just extracted BEFORE reporting success: a plugin must have a well-formed
        // manifest, be isolated, use only known permissions, and pass the AST scan. Doing it here (not
        // only at activate) means a junk/dangerous ZIP fails immediately with a clear reason and its
        // code never lingers on disk. On any failure, remove the extracted dir and 400.
        const installedDir = path.join(PLUGINS_DIR, pluginSlug);
        try {
            const manifestPath = path.join(installedDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) throw new Error('Missing manifest.json — this is not a valid WordJS plugin.');
            const rawManifest = fs.readFileSync(manifestPath, 'utf8');
            if (rawManifest.length > 64 * 1024) throw new Error('manifest.json is implausibly large (>64KB).');
            let manifest: any;
            try { manifest = JSON.parse(rawManifest); } catch { throw new Error('manifest.json is not valid JSON.'); }
            if (!manifest.name) throw new Error('manifest.json is missing a "name".');
            if (manifest.isolated !== true) throw new Error('Plugin must declare "isolated": true (all WordJS plugins run sandboxed).');
            const permProblems = validateManifestPermissions(manifest.permissions);
            if (permProblems.length) throw new Error(`Invalid permissions:\n- ${permProblems.join('\n- ')}`);
            // Static AST scan (also re-runs at activation for defense in depth).
            validatePluginPermissions(pluginSlug, installedDir, manifest);
        } catch (valErr: any) {
            try { fs.rmSync(installedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: valErr.message, details: { missingPermissions: valErr.missingPermissions, dangerousCalls: valErr.dangerousCalls } });
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
 * @swagger
 * /plugins/registry:
 *   get:
 *     summary: Get public plugin registry (for frontend)
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: List of active plugins with manifest data
 */
/**
 * @swagger
 * /plugins/assets:
 *   get:
 *     summary: Enqueued frontend assets (scripts/styles) for ACTIVE plugins — public, for the site layout
 *     tags: [Plugins]
 */
router.get('/assets', asyncHandler(async (req: Request, res: Response) => {
    const { getActiveAssets } = require('../core/plugin-assets');
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getActiveAssets());
}));

router.get('/registry', asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activePlugins = plugins.filter((p: any) => p.active);

    const registry: any[] = [];

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
 * @swagger
 * /plugins/active:
 *   get:
 *     summary: Get list of active plugin slugs
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: Array of active plugin slugs
 */
router.get('/active', asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activeSlugs = plugins
        .filter((p: any) => p.active)
        .map((p: any) => p.slug);
    res.json(activeSlugs);
}));

/**
 * @swagger
 * /plugins:
 *   get:
 *     summary: List all installed plugins (Admin)
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all plugins
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    // Annotate each with its requested/granted permissions so the admin UI can render the per-permission
    // switches. `requestedPermissions` = what the manifest asks for ("scope:access"), the set of switches
    // to show; `grantedPermissions` = what the admin has granted (+ "network"). No trust tier exists.
    const { getGrants } = require('../core/plugin-permissions');
    // Live runtime health per isolate (running/crashed/crash-looping/restarting + rss/restarts) so the
    // admin sees the TRUE state, not just the persisted 'active' flag which can lie after a crash.
    const { getIsolateStatus } = require('../core/plugin-isolate');
    res.json(plugins.map((p: any) => {
        const requested = Array.from(new Set((p.permissions || [])
            .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
            .filter(Boolean)));
        return {
            ...p,
            requestedPermissions: requested,
            grantedPermissions: getGrants(p.slug),
            runtime: p.active ? (getIsolateStatus(p.slug) || null) : null,
        };
    }));
}));

/**
 * @swagger
 * /plugins/{slug}/status:
 *   get:
 *     summary: Live runtime health of an isolated plugin
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/:slug/status', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    if (!validateSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
    const { getIsolateStatus } = require('../core/plugin-isolate');
    const status = getIsolateStatus(req.params.slug);
    if (!status) return res.status(404).json({ error: 'Plugin is not a loaded isolate.' });
    res.json(status);
}));

/**
 * @swagger
 * /plugins/{slug}/activate:
 *   post:
 *     summary: Activate a plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Plugin activated
 */
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const slug = req.params.slug;

    // Default-deny grants: when an admin activates a plugin (having seen its requested permissions in the
    // activation dialog), grant exactly what its manifest DECLARES — but ONLY if it has no grant record
    // yet, so a later REVOKE via the per-permission switches survives a re-activation. The admin can
    // refine grants anytime in /admin/plugins.
    //
    // Resolve the declared set BEFORE activation (so we can spawn with the grants), but only PERSIST it
    // AFTER activation SUCCEEDS — a plugin that fails its AST scan / test gate must not leave behind a
    // persisted grant record. To make init see the grants, seed them in-memory first, then either
    // persist-on-success or roll back the in-memory seed on failure.
    const { getGrants, setGrants, _setGrantsInMemory } = require('../core/plugin-permissions');
    let seededDeclared: string[] | null = null;
    const hadNoGrants = getGrants(slug).length === 0;
    if (hadNoGrants) {
        try {
            const all = await getAllPlugins();
            const p = all.find((x: any) => x.slug === slug);
            const declared = Array.from(new Set(((p && p.permissions) || [])
                .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
                .filter(Boolean))) as string[];
            if (declared.length) { _setGrantsInMemory(slug, declared); seededDeclared = declared; }
        } catch (e: any) { console.warn(`[Permissions] grant-on-activate (seed) for '${slug}' failed:`, e && e.message); }
    }

    let result;
    try {
        result = await activatePlugin(req.params.slug);
    } catch (e: any) {
        // Activation failed (scan/test/init) — undo the in-memory grant seed so nothing is persisted and
        // a failed-activation plugin holds no grants.
        if (seededDeclared) { try { _setGrantsInMemory(slug, []); } catch { /* */ } }
        // A STRUCTURED validation failure (AST scan) carries a fixable-vs-blocked split. Surface it as a
        // 400 with `details` so the admin UI can show a rejection panel instead of one mangled string.
        if (e && e.code === 'PLUGIN_VALIDATION_FAILED') {
            return res.status(400).json({
                message: e.message,
                details: {
                    missingPermissions: e.missingPermissions || [],
                    dangerousCalls: e.dangerousCalls || [],
                },
            });
        }
        throw e;
    }

    // Activation succeeded — NOW persist the grants we seeded (idempotent; only when it had none before).
    if (seededDeclared && hadNoGrants && getGrants(slug).length > 0) {
        try { await setGrants(slug, seededDeclared); } catch (e: any) { console.warn(`[Permissions] grant-on-activate (persist) for '${slug}' failed:`, e && e.message); }
    }

    // Trigger frontend registry regeneration
    regenerateRegistry();

    res.json(result);
}));

/**
 * @swagger
 * /plugins/{slug}/permissions:
 *   post:
 *     summary: Set the per-permission grants for a plugin (admin) — Android-style, default-deny
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/:slug/permissions', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const slug = req.params.slug;
    const { setGrants, getGrants } = require('../core/plugin-permissions');

    // Body: { granted: ["scope:access", ...], network: boolean }. The admin's granted set is the source
    // of truth (default-deny). We don't constrain to the manifest here — hasPermission already requires
    // BOTH the manifest declaration AND the grant, so granting an undeclared scope simply has no effect.
    const body = req.body || {};
    const tokens: string[] = Array.isArray(body.granted) ? body.granted.map((t: any) => String(t)) : [];
    if (body.network) tokens.push('network');
    await setGrants(slug, tokens);

    // Re-spawn the isolate so the NETWORK grant (passed in cfg → __WORDJS_PLUGIN_NETWORK__) takes effect.
    // Bridge-scope grants are read live per call on the host, but reloading keeps everything consistent.
    // Best-effort: the grant is already persisted, so a reload hiccup must not fail the change.
    let reloaded = false;
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
    } catch (e: any) {
        console.warn(`[Permissions] reload of '${slug}' after grant change failed:`, e && e.message);
    }

    const granted = getGrants(slug);
    res.json({
        success: true,
        slug,
        granted,
        network: granted.includes('network'),
        reloaded,
        message: `Permissions updated for '${slug}' (${granted.length} granted).${reloaded ? ' Isolate reloaded — changes are in effect.' : ' Reactivate the plugin to fully apply.'}`,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/reload:
 *   post:
 *     summary: Hot-reload an isolated plugin's child process (e.g. after editing its files)
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Isolate re-spawned (the reload re-runs the full load pipeline, AST scan included)
 *       404:
 *         description: Plugin is not a loaded isolated plugin
 */
router.post('/:slug/reload', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const slug = req.params.slug as string;

    // Reuse the exact same reload the grants route and the dev watcher use: tear the child process
    // down and load it again from its original entry file — the full pipeline (AST scan included)
    // re-runs, so this cannot be used to sidestep the security model.
    const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
    if (!isIsolated(slug)) {
        return res.status(404).json({ error: `Plugin '${slug}' is not a loaded isolated plugin (is it active?)` });
    }
    await reloadIsolatedPlugin(slug);
    res.json({ success: true, slug, message: `Isolate for '${slug}' reloaded.` });
}));

/**
 * @swagger
 * /plugins/{slug}/deactivate:
 *   post:
 *     summary: Deactivate a plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Plugin deactivated
 */
router.post('/:slug/deactivate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const result = await deactivatePlugin(req.params.slug);

    // Trigger frontend registry regeneration
    regenerateRegistry();

    res.json(result);
}));

/**
 * @swagger
 * /plugins/{slug}:
 *   delete:
 *     summary: Delete a plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *                 description: Admin password for confirmation
 *     responses:
 *       200:
 *         description: Plugin deleted
 *       403:
 *         description: Invalid password
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    const slug = req.params.slug;
    const { password, dropData } = req.body;
    const { isPluginActive, deactivatePlugin, PLUGINS_DIR, uninstallPluginData } = require('../core/plugins');
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

        // Purge the plugin's persisted footprint. ALWAYS clear grants (else a re-uploaded slug inherits
        // old, possibly-revoked grants) + crash strikes; only DROP the plugin's data tables when the
        // admin explicitly asked (dropData) — WordPress-parity: keep data by default on delete.
        const cleanup = await uninstallPluginData(slug, { dropTables: !!dropData });

        // Regenerate registry to remove traces
        regenerateRegistry();

        res.json({ success: true, message: `Plugin ${slug} deleted successfully`, cleanup });
    } catch (err) {
        throw new Error(`Failed to delete plugin: ${err.message}`);
    }
}));

/**
 * @swagger
 * /plugins/{slug}/download:
 *   get:
 *     summary: Download plugin as ZIP
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *         description: Bearer token for download authentication
 *     responses:
 *       200:
 *         description: Plugin ZIP file
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/:slug/download', authenticateAllowQuery, isAdmin, asyncHandler(async (req: Request, res: Response) => {
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
 * @swagger
 * /plugins/sample:
 *   post:
 *     summary: Generate a sample plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sample plugin created
 */
router.post('/sample', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    createSamplePlugin();
    res.json({ success: true, message: 'Sample plugin created in /plugins/hello-world' });
}));

/**
 * @swagger
 * /plugins/menus:
 *   get:
 *     summary: Get admin menu items from active plugins
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of menu items
 */
router.get('/menus', authenticate, asyncHandler(async (req: any, res: Response) => {
    const { getAdminMenuItems } = require('../core/adminMenu');
    const { getActivePlugins } = require('../core/plugins');
    const { applyFiltersSync } = require('../core/hooks');

    const allMenus = getAdminMenuItems();
    console.log(`DEBUG: /menus - allMenus count: ${allMenus.length}`);
    // Await async getActivePlugins
    const activePlugins = await getActivePlugins();

    // 1. Filter menus to only include those from active plugins or core
    let activeMenus = allMenus.filter((menu: any) => menu.plugin === 'core' || activePlugins.includes(menu.plugin));

    // 2. Apply filters to allows plugins to hide/modify items per user
    activeMenus = applyFiltersSync('admin_menu_items', activeMenus, { user: req.user });

    console.log('DEBUG: /plugins/menus response:', JSON.stringify(activeMenus, null, 2));

    res.json(activeMenus);
}));

// Mount bundle routes for pre-compiled plugin frontends
const bundleRoutes = require('./plugin-bundles');
router.use('/', bundleRoutes);

module.exports = router;
