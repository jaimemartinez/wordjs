/**
 * WordJS - Plugins Routes
 * /api/v1/plugins/*
 */

import type { Request, Response } from 'express';
// Type-only, and load-bearing: tsconfig pins `types` to ["node"], so @types/multer only enters the
// program when something imports it. That package is what declares `Express.Multer.File` and augments
// Express's Request with `file` — the two names the upload route below needs. `import type` is erased
// at emit, so multer itself stays the plain runtime require() a line down.
import type { FileFilterCallback } from 'multer';

const express = require('express');
const log = require('../core/module-logger').moduleLogger('routes/plugins');
const router = express.Router();

// ---- PLUGIN LIFECYCLE RATE LIMIT ----------------------------------------------------------------------
// Activating, deactivating and reloading a plugin (and changing its grants, egress hosts, private
// destinations or port, which reload it) each tear down and spawn a sandboxed child process
// (and run the full load pipeline). They are administrator routes, but nothing bounded how often they
// ran, so a script holding one admin session — on any site of a network — could keep the host busy
// starting processes. One bucket per (site, account) for all of these routes together: generous for a
// person (or a deploy script) working through a list of plugins, a ceiling for a loop.
const PLUGIN_LIFECYCLE_WINDOW_MS = 10 * 60 * 1000;
const PLUGIN_LIFECYCLE_MAX = 60;
const rateLimit = require('express-rate-limit');

/** The lifecycle limiter, built with `store` (the shared Redis store, or undefined for in-process). Exported for tests. */
function createPluginLifecycleLimiter(store?: unknown) {
    return rateLimit({
        windowMs: PLUGIN_LIFECYCLE_WINDOW_MS,
        max: PLUGIN_LIFECYCLE_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        // Runs after authenticate + isAdmin, so the caller is known. Keyed by site and account: one
        // site's administrator cannot spend another site's budget.
        keyGenerator: (req: Request) => {
            const site = require('../core/site-context').currentSiteIdOrNull();
            return `s${site === null ? 0 : site}:u:${req.user ? req.user.id : 'anon'}`;
        },
        store,
        passOnStoreError: true,
        message: {
            code: 'rest_plugin_lifecycle_rate_limited',
            message: 'Too many plugin activations, deactivations or reloads; wait a few minutes and try again.',
            data: { status: 429 },
        },
    });
}
// Built at module scope (express-rate-limit flags a limiter constructed inside a handler); index.ts hands
// over the shared store at boot, before any request (same contract as routes/comments).
let pluginLifecycleLimiterImpl: any = createPluginLifecycleLimiter(undefined);
function usePluginLifecycleLimiterStore(store: unknown) {
    pluginLifecycleLimiterImpl = createPluginLifecycleLimiter(store);
}
function pluginLifecycleLimiter(req: Request, res: Response, next: any) {
    return pluginLifecycleLimiterImpl(req, res, next);
}
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getAllPlugins, activatePlugin, deactivatePlugin, createSamplePlugin, isPluginActive, listPluginTables, validatePluginPermissions, validateManifestPermissions, validateManifestRoles, syncPluginRoles, validateManifestDependencies, validateBrowserCapability, browserCodeSources, BROWSER_SCRIPT_TOKEN, listOrphanedPlugins, reclaimOrphanedPlugin, clearOrphanNotice, PLUGINS_DIR } = require('../core/plugins');
const { assertZipWithinBudget } = require('../core/zip-guard');
// refusePluginGrantByToken: an API token may revoke a plugin's grants or narrow its egress, never add to
// them — nor activate a plugin whose activation would seed its declared permissions. isHeadless puts a
// token's grant / egress write in `narrowOnly` mode, judged against what is STORED (core/plugin-permissions).
const { authenticate, authenticateAllowQuery, optionalAuth, refusePluginGrantByToken, isHeadless } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler, publicErrorText, UploadRejectedError } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');
const { findSandboxUnavailable, sandboxRefusalBody } = require('../core/sandbox-refusal');
const { execFile } = require('child_process');
const { resolveWithin } = require('../core/safe-path');

/**
 * @swagger
 * tags:
 *   name: Plugins
 *   description: Plugin management (Install, Activate, Delete)
 */

/**
 * The ONE directory an install zip may ever live in, absolute and resolved once at load.
 *
 * It used to be the string 'os-tmp/' here and `path.resolve(PLUGINS_DIR, '..', 'os-tmp')` further down —
 * the same directory only as long as process.cwd() happened to be the backend root. Resolving it once,
 * from PLUGINS_DIR, makes that an invariant instead of a coincidence, and gives the containment guard
 * inside installPluginFromZip() a fixed base to prove against. (io-guard already treats ROOT_DIR/os-tmp
 * as scratch.)
 */
const OS_TMP_DIR = path.resolve(PLUGINS_DIR, '..', 'os-tmp');

// Configure multer for zip uploads
const upload = multer({
    // Absoluto a proposito: es la base de contencion que installPluginFromZip() comprueba inline.
    // Sigue siendo almacenamiento EN DISCO — memoryStorage cargaria en RAM plugins enteros.
    dest: OS_TMP_DIR,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        // SECURITY: Prevent CVE-2025-47935/47944 DoS
        files: 1,           // Only 1 plugin zip per request
        fields: 10,         // Minimal fields needed
        fieldSize: 16 * 1024,
        fieldNameSize: 100,
        parts: 15,          // Limited total parts
        headerPairs: 200
    },
    fileFilter: (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new UploadRejectedError(415, 'rest_upload_invalid_type', 'Only .zip files are allowed'));
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
    // activated plugin's admin page / editor blocks appear WITHOUT the old manual "regenerate + restart".
    // (The path was '../../../admin-next/scripts' — a directory that does not exist — so this silently
    // no-op'd on every activate/deactivate. The real generators live in frontend/scripts/.)
    if (process.env.NODE_ENV === 'production') return;
    // UNDER node:test, NEVER. Two reasons, both measured. (1) The generators rewrite frontend/src
    // registry sources — a test that activates a plugin must not edit the working tree. (2) Their
    // output used to be echoed from the execFile callback with console.log, i.e. ASYNCHRONOUSLY to
    // stdout — and a node:test child reports results to the runner over stdout as V8-serialized
    // frames. That write landed inside a frame, the runner threw 'Unable to deserialize cloned data',
    // the whole test FILE failed with no failed assertion, and scripts/test-with-flake-retry.mjs
    // re-ran the entire suite twice: 3 x 10 min, past the Backend job's timeout. Same class as the
    // Redis connect banner in core/cache.ts (2026-09-04); same rule — no async stdout in code a test
    // can reach. NODE_TEST_CONTEXT is set by the runner in every test child (see index.ts).
    if (process.env.NODE_TEST_CONTEXT) return;
    const scriptsDir = path.resolve(__dirname, '../../../frontend/scripts');
    const scripts = [
        'generate-plugin-registry.js',         // Frontend components
        'generate-admin-plugin-registry.js',   // Admin pages
        'generate-verso-plugin-registry.js',   // Verso block components
        'generate-portal-plugin-registry.js'   // Portal pages (/portal/<slug>)
    ];

    // Resolve the authoritative active list IN-PROCESS and hand it to the generators via env.
    // Their own fallback (GET /plugins/active over plain http) fails against an https dev server —
    // they then include EVERY plugin found on disk, active or not — and can race uninstall's
    // directory deletion, leaving the registries importing a deleted plugin (Module not found).
    getAllPlugins().then((plugins: any) => {
        const activeSlugs = (plugins || []).filter((p: any) => p.active).map((p: any) => p.slug);
        const env = { ...process.env, WORDJS_ACTIVE_PLUGINS: JSON.stringify(activeSlugs) };

        for (const script of scripts) {
            const scriptPath = path.join(scriptsDir, script);

            if (!fs.existsSync(scriptPath)) {
                log.info({ script }, `⚠️  Script not found: ${script}`);
                continue;
            }

            // SECURITY: Use execFile instead of exec to prevent command injection
            execFile('node', [scriptPath], { env }, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    log.error({ script, err: error }, `❌ Failed to run ${script}`);
                    return;
                }
                if (process.env.NODE_ENV !== 'production') {
                    // stderr on purpose: this runs from an async callback, and stdout is the
                    // node:test result channel (see the guard at the top of this function).
                    process.stderr.write(`🔄 ${script}:\n${stdout}`);
                }
            });
        }
    }).catch((e: any) => log.error({ err: e }, 'regenerateRegistry: could not resolve active plugins'));
}

/**
 * Remove a plugin directory but PRESERVE its top-level data/ subdir (runtime state: encryption keys,
 * attachments…). Without this, uninstalling mail-server destroys data/.mailenc — the AES root key —
 * and every stored mail secret becomes permanently undecryptable even though its wjp_ tables survive.
 * If no data/ exists the directory is removed entirely. The residual data-only dir is understood by
 * installPluginFromZip, which ADOPTS it on reinstall instead of refusing with a 409.
 */
function removePluginDirPreservingData(dir: string) {
    const dataDir = path.join(dir, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
    }
    for (const entry of fs.readdirSync(dir)) {
        if (entry === 'data') continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
}

// Strict plugin-slug charset. A slug is a SINGLE path segment (starts alnum, then alnum/dash/underscore,
// max 64) — so it can never be '.', '..', a separator, or resolve to a parent/other directory.
// IDENTICAL to core/plugin-permissions' PLUGIN_SLUG (asserted in backend/src/tests/plugin-path-guards.test.ts).
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isValidSlug(slug: any): boolean {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Resolve a REQUEST-supplied slug to the validated slug string, or null.
 *
 * This replaces the old `validateSlug()`, which was the exact anti-pattern this codebase keeps
 * re-shipping: it validated a COPY and returned a BOOLEAN, so every one of its ten call sites went on to
 * re-read the RAW `req.params.slug` and concatenate that. Worse, its containment test was a BARE prefix
 * (`resolved.startsWith(path.resolve(PLUGINS_DIR))`, no `path.sep`) — the very check safe-path exists to
 * stop us writing, because `plugins-evil` "starts with" `plugins`.
 *
 * Here the FORM gate (SLUG_RE) and the CONTAINMENT proof (safe-path.resolveWithin → absolute, normalized,
 * `base + path.sep`) both run, and what comes back is the value the caller must use. Null = fail closed;
 * callers turn it into 400 and never touch the raw parameter again.
 */
function safeSlugParam(raw: unknown): string | null {
    if (!isValidSlug(raw)) return null;
    const slug = raw as string;
    // Proves the slug names a proper CHILD of PLUGINS_DIR (never PLUGINS_DIR itself, never an ancestor).
    return resolveWithin(PLUGINS_DIR, slug) ? slug : null;
}

/**
 * `<PLUGINS_DIR>/<slug>/<...rest>` with the same three-part defense, or null. The single helper every
 * read of a plugin-owned file goes through, so no route re-invents path.join(PLUGINS_DIR, slug, …) —
 * including the ones fed by a readdir listing (an entry name is still a segment we did not write).
 */
function pluginFile(slug: unknown, ...rest: string[]): string | null {
    if (!isValidSlug(slug)) return null;
    return resolveWithin(PLUGINS_DIR, slug as string, ...rest);
}

/**
 * La respuesta a un paquete de instalacion que no esta dentro de nuestro directorio de trabajo.
 *
 * Es una FUNCION, no una constante compartida: cada rechazo devuelve su propio objeto, para que un
 * llamante que decore `body` no contamine el siguiente rechazo. La prueba de contencion en si NO vive
 * aqui — vive escrita dentro de installPluginFromZip, junto al sumidero (ver el comentario alli).
 */
function refuseUncontainedZip(): { ok: boolean; status: number; body: any } {
    return { ok: false, status: 400, body: { error: 'Install package is not inside the plugin scratch directory' } };
}

/**
 * Allocate a PRIVATE scratch directory for a downloaded install package.
 *
 * A predictable path in a shared temp dir is a file to be pre-created, not a file to be written: whoever
 * owns the inode first owns the bytes, and `writeFileSync` follows a symlink that is already there — the
 * `{ mode: 0o600 }` argument is ignored entirely for an existing file. mkdtemp is the fix rather than a
 * longer random name: the kernel creates the directory exclusively, at 0700, so there is no window in
 * which a name can be squatted and no other user can look inside it.
 *
 * The file itself is then written with `flag: 'wx'` (exclusive create — refuses to follow anything) into
 * that fresh dir. Callers MUST call dispose() in a finally: the install pipeline deletes the ZIP, never
 * the directory around it.
 */
function createInstallTmp(): { dir: string; zipPath: string; dispose: () => void } {
    fs.mkdirSync(OS_TMP_DIR, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(OS_TMP_DIR, 'install-'));
    return {
        dir,
        zipPath: path.join(dir, 'package.zip'),
        dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
    };
}

/**
 * Strip line breaks from a request-derived value before it goes into a log line, so a crafted slug or
 * driver error cannot forge or split entries in the operator's log.
 *
 * TWO single-constant replacements, each replacing with the empty string, is deliberate: the
 * log-injection analysis recognises a sanitizer SYNTACTICALLY, and an alternation (`/\n|\r/g`) has no
 * constant value, so it is not matched. Match the documented remediation shape, not an equivalent.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * Wait out a grant / egress-allowlist write's `updated_option` fan-out (core/plugin-permissions
 * applyGrants / applyEgressAllowlist) once the route has acted on the change. By then the change is
 * persisted, in force on this node and in the respawned child, so a subscriber that threw is logged — not
 * reported to the administrator as a failure of a change that took effect.
 */
async function awaitPolicyAnnounced(announced: Promise<void>, tag: string, slug: string): Promise<void> {
    try { await announced; }
    catch (e: any) { log.warn({ tag, slug: logSafe(slug), err: e }, `[${tag}] '${logSafe(slug)}': the change is in effect; an updated_option subscriber failed`); }
}

// How long DELETE waits for the slug's child process to actually be gone before it refuses to remove
// the directory. Generous enough for a SIGKILL to be reaped, short enough to answer the request.
const DELETE_STOP_TIMEOUT_MS = 3000;

// The SINGLE choke point every slug-derived fs op must go through (download / delete / extract-install).
// Resolves an untrusted slug to its plugin dir or THROWS (400), guaranteeing the result is a proper CHILD
// of PLUGINS_DIR — never PLUGINS_DIR itself (which would let a failure-path rmSync wipe every plugin) or
// an ancestor (which a crafted '..' filename / './'-prefixed zip entry could otherwise reach).
// The containment proof itself is core/safe-path's resolveWithin — ONE implementation for themes and
// plugins alike, so the two can never drift into different dialects of "inside".
function resolveSafePluginDir(slug: any): string {
    if (!isValidSlug(slug)) {
        const e: any = new Error(`Invalid plugin slug: ${JSON.stringify(slug)}`);
        e.status = 400;
        throw e;
    }
    const dir = resolveWithin(PLUGINS_DIR, slug as string);
    if (!dir) {
        const e: any = new Error('Invalid plugin slug: resolves outside the plugins directory');
        e.status = 400;
        throw e;
    }
    return dir;
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
 *               existingData:
 *                 type: string
 *                 enum: [adopt, discard]
 *                 description: Required only when a previous uninstall kept this plugin's data directory or tables. adopt keeps them and reconnects the plugin to them; discard removes them once the new package has passed validation.
 *     responses:
 *       200:
 *         description: Plugin installed
 *       400:
 *         description: Invalid file or zip slip detected
 *       409:
 *         description: existing_plugin_data - a previous installation left its data directory or tables and the request did not say whether to adopt or discard them (the body lists them in data.dataDir and data.tables); reserved_plugin_slug - the slug is reserved by the host (core, theme-*, @*); core_version_too_old - the plugin's manifest requires a newer WordJS (requires.wordjs) than this install runs; nothing is installed. The body names requires, minimum and current.
 */
router.post('/upload', authenticate, isAdmin, upload.single('plugin'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    // What to do with data a previous uninstall kept (see installPluginFromZip): only these two words count.
    const rawChoice = req.body && req.body.existingData;
    const existingData = rawChoice === 'adopt' || rawChoice === 'discard' ? rawChoice : undefined;
    const result = await installPluginFromZip(req.file.path, req.file.originalname, undefined, req.user && req.user.id, { existingData });
    // The marketplace path records its own `marketplace.install`; a direct zip upload is the same
    // lifecycle mutation and is recorded too (only when it actually installed something).
    if (result.ok && result.body && result.body.slug) {
        await recordAudit(req.user && req.user.id, 'plugin.install', 'plugin', result.body.slug, { via: 'upload' });
    }
    res.status(result.status).json(result.body);
}));

/**
 * @swagger
 * /plugins/{slug}/update:
 *   post:
 *     summary: Update an installed plugin from a new zip (in place)
 *     description: >-
 *       The zip's root folder must be the plugin's slug. The new code is extracted to a private staging
 *       directory and validated there first, so a zip that fails validation leaves the installed plugin
 *       untouched (and running). Only then is the plugin stopped, its code swapped, and the plugin restarted
 *       if it was active. Its data/ directory, its database tables, its stored grants and its egress list
 *       are kept. Permissions the new version declares that are not granted are reported in
 *       `ungrantedPermissions` (and the ones the previous version did not declare in `newPermissions`) —
 *       they stay off until an administrator grants them. A plugin installed from a catalog loses its
 *       recorded catalog origin: its code now comes from this upload.
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
 *         description: Updated ({ updated, fromVersion, toVersion, reactivated, newPermissions, ungrantedPermissions })
 *       400:
 *         description: Invalid zip, or its root folder names a different plugin (nothing was changed)
 *       404:
 *         description: The plugin is not installed
 *       409:
 *         description: Another operation on this plugin is in progress, the sandbox refused to start the new version (rolled back), or core_version_too_old - the zip's manifest requires a newer WordJS (requires.wordjs) than this install runs (nothing was changed)
 */
// Multisite: not in core/multisite-guards' SITE_PLUGIN_ROUTES, so another site gets the network's 403.
router.post('/:slug/update', authenticate, isAdmin, upload.single('plugin'), asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!slug) {
        try { fs.unlinkSync(path.resolve(OS_TMP_DIR, path.basename(req.file.path))); } catch { /* */ }
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    // Update only what is INSTALLED, and carry the directory's own name from here on — the value read
    // off the disk, not the request's copy of it — into the stash, the swap and the reactivation.
    let installed: string | undefined;
    try { installed = fs.readdirSync(PLUGINS_DIR).find((d: string) => d === slug); } catch { /* no plugins dir */ }
    if (!installed) {
        try { fs.unlinkSync(path.resolve(OS_TMP_DIR, path.basename(req.file.path))); } catch { /* */ }
        return res.status(404).json({ error: `Plugin '${slug}' is not installed.` });
    }
    const result = await runPluginUpdate(installed, req.file.path, null, { via: 'upload' });
    if (result.ok) {
        await recordAudit(req.user && req.user.id, 'plugin.update', 'plugin', slug, {
            via: 'upload', fromVersion: result.body.fromVersion, toVersion: result.body.toVersion,
            newPermissions: result.body.newPermissions,
        });
    }
    res.status(result.status).json(result.body);
}));

/**
 * The 409 for a zip whose plugin is already installed. It used to tell an admin with an ACTIVE plugin to
 * "Deactivate it before re-uploading" — and then, once deactivated, refuse again with "Uninstall it",
 * whose uninstall drops the plugin's grants. Neither was the way to update. Now it names the way that is:
 * POST /plugins/:slug/update with the same zip (the Plugins screen offers it from this answer, keyed on
 * `code`, with the two versions to show).
 */
function alreadyInstalled(slug: string, active: boolean, zip: any): { ok: boolean; status: number; body: any } {
    let installedVersion: string | null = null;
    let incomingVersion: string | null = null;
    try {
        const m = JSON.parse(fs.readFileSync(path.join(resolveSafePluginDir(slug), 'manifest.json'), 'utf8'));
        if (m && m.version != null) installedVersion = String(m.version).slice(0, 64);
    } catch { /* unreadable manifest — no version to show */ }
    try {
        const entry = zip.getEntry(`${slug}/manifest.json`) || zip.getEntry('manifest.json');
        const m = entry && entry.header && entry.header.size <= 64 * 1024 ? JSON.parse(entry.getData().toString('utf8')) : null;
        if (m && m.version != null) incomingVersion = String(m.version).slice(0, 64);
    } catch { /* the update validates the manifest properly */ }
    const v = installedVersion ? ` (v${installedVersion})` : '';
    return {
        ok: false,
        status: 409,
        body: {
            error: `Plugin '${slug}'${v} is already installed${active ? ' and active' : ''}. To replace it with this zip, update it `
                + `instead — its data, tables and permissions are kept (Plugins → Upload Plugin offers the update; API: POST /api/v1/plugins/${slug}/update).`,
            code: 'plugin_exists',
            // Under `data`, the member the admin's API client keeps on a thrown error (lib/api.ts).
            data: { slug, active, installedVersion, incomingVersion },
        },
    };
}

/**
 * Shared plugin-zip install pipeline — the SINGLE implementation of every security check
 * (zip bomb, Zip Slip, slug validation, squat/clobber refusal, manifest + AST validation),
 * used by BOTH the direct upload above and the marketplace installer (routes/marketplace.ts).
 * Always deletes zipPath before returning. Expected failures come back as { ok:false, status, body }
 * rather than throwing, so callers map them straight onto the HTTP response.
 */
/**
 * @param expectedSlug When the caller already owns a plugin directory (the UPDATE path), the slug it
 *   is replacing. The install target is derived from the zip's own root folder, so without this the
 *   update path could extract somewhere else entirely: a release zip rooted at 'mail-server-2.3.0/'
 *   installs to plugins/mail-server-2.3.0/ while runPluginUpdate has already stashed the real
 *   plugins/mail-server/ code — and because that install SUCCEEDS, no rollback fires and the success
 *   path then deletes the stash. The plugin is destroyed and a stray directory is left behind.
 *   Mismatch is refused rather than retargeted: silently extracting a zip into a directory it did not
 *   name would let a zip for one plugin overwrite another.
 * @param actorId The administrator behind the request, for the audit row this pipeline can write on
 *   its own (reclaiming an ORPHANED slug drops an `active_plugins` entry and deletes from disk, which
 *   is a lifecycle mutation like activate/deactivate and is logged like one). The two HTTP callers
 *   pass `req.user.id`; the update path leaves it undefined — it cannot reach an orphan, because it
 *   refuses a slug with no manifest.json long before this.
 */
/**
 * @param opts.stageRoot STAGING mode (the update path). Extract into `<stageRoot>/<slug>/` — a private
 *   directory under os-tmp that runPluginUpdate created — and run every validation THERE, so a zip that
 *   fails validation never touches the installed plugin, which keeps running. The live-plugin checks
 *   (orphan reclaim, "already active", "directory already exists") do not apply: replacing that plugin is
 *   the point, and runPluginUpdate owns the swap. The case/Unicode squat check still runs against
 *   PLUGINS_DIR. The zip is consumed either way; the staged files are what the caller moves into place.
 */
async function installPluginFromZip(zipPathIn: string, originalName: string, expectedSlug?: string, actorId?: any, opts: { stageRoot?: string; existingData?: 'adopt' | 'discard' } = {}): Promise<{ ok: boolean; status: number; body: any }> {
    // CONTENCION PRIMERO — INLINE, Y AQUI SE QUEDA.
    //
    // POR QUE AQUI Y NO EN UN HELPER (no lo refactorices a una utilidad). Esta funcion borra su zip
    // con fs.unlinkSync en trece caminos de fallo y ademas lo abre como archivo, y la ruta se la elige
    // el LLAMANTE: el fichero temporal de multer en POST /plugins/upload, la descarga del marketplace,
    // el zip de la actualizacion. Antes esto delegaba en un `assertZipInOsTmp(zipPathIn)` que hacia
    // exactamente las mismas tres comprobaciones — y no servia, porque el analisis de rutas
    // contaminadas razona DENTRO de una funcion: un barrier escrito en otra funcion no apaga el
    // sumidero de esta, aunque devuelva el valor ya probado. De ahi que la alerta js/path-injection
    // siguiera senalando el unlink de discardZip(). Sacar esto a un helper la vuelve a encender.
    //
    // Las tres partes de la defensa, sobre el valor QUE SE USA despues (nunca sobre el argumento):
    //   1. FORMA: cadena no vacia y sin NUL (un NUL trunca la ruta que ve la capa C);
    //   2. RESOLUCION CANONICA: path.resolve() da la ruta absoluta y normalizada que recibira el
    //      syscall, no el texto que paso el llamante;
    //   3. CONTENCION PROBADA contra `base + path.sep` — nunca un prefijo pelado, que aceptaria un
    //      hermano llamado `os-tmp-evil`, y exigiendo un HIJO, nunca el propio directorio base.
    // Falla cerrado: una ruta que no podemos situar dentro de nuestro scratch no se ofrece como
    // objetivo de borrado; se devuelve 400 y no se toca el disco.
    if (typeof zipPathIn !== 'string' || zipPathIn.length === 0 || zipPathIn.includes('\0')) {
        return refuseUncontainedZip();
    }
    const zipPath = path.resolve(zipPathIn);
    if (!zipPath.startsWith(OS_TMP_DIR + path.sep)) {
        return refuseUncontainedZip();
    }
    // ONE deletion helper, so no failure path can grow a raw unlink again.
    // The containment is proved again INSIDE the closure, on the exact value it deletes: the check above
    // guards the straight-line code, but a closure called from a dozen later failure paths is analysed
    // on its own, and an unproved unlink there is the alert this comment block exists to prevent.
    const discardZip = () => {
        const target = path.resolve(zipPath);
        if (!target.startsWith(OS_TMP_DIR + path.sep)) return;
        try { fs.unlinkSync(target); } catch { /* already gone */ }
    };
    // existingData === 'discard': where the previous installation's data/ waits until the new package
    // has passed validation. Any failure puts it back (restoreDiscardedData); success deletes it.
    let discardedDataAside: string | null = null;
    const restoreDiscardedData = (dir: string) => {
        if (!discardedDataAside) return;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.renameSync(path.join(discardedDataAside, 'data'), path.join(dir, 'data'));
            fs.rmSync(discardedDataAside, { recursive: true, force: true });
            discardedDataAside = null;
        } catch (e: any) { log.error({ err: e, aside: discardedDataAside }, '[plugins] could not restore the previous data directory after a failed install'); }
    };
    let restoreTarget: string | null = null;
    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // SECURITY: reject a decompression bomb BEFORE extracting (multer only capped the compressed
        // upload — a ~10MB DEFLATE stream can expand to many GB and fill the disk).
        try {
            assertZipWithinBudget(zipEntries, { kind: 'plugin' });
        } catch (e: any) {
            discardZip();
            return { ok: false, status: 400, body: { error: e.message } };
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
        // Derive the intended install slug and VALIDATE it before building any path. The slug comes from
        // the zip's single root dir, or (files-at-root) from the filename. It MUST be a clean single
        // segment: a crafted filename ('...zip' → path.parse().name === '..') or a './'-prefixed entry
        // (first segment '.') would otherwise redirect extractAllTo into the host code tree (backend/) or
        // collapse the target to PLUGINS_DIR itself (a later failure-path rmSync then wipes every plugin).
        const zipName = path.parse(originalName).name;

        // OS archivers add sibling junk at the zip root (__MACOSX/, .DS_Store, Thumbs.db, desktop.ini) —
        // ignore it for root detection and skip extracting it, so a valid single-folder plugin isn't
        // misread as multi-root (which would double-nest it under the filename and fail the manifest check).
        const isJunkEntry = (raw: string): boolean => {
            const norm = String(raw).replace(/\\/g, '/');
            const first = norm.split('/')[0];
            return first === '__MACOSX' || first === '.git'
                || /(^|\/)(\.DS_Store|Thumbs\.db|\.AppleDouble|\.Spotlight-V100|desktop\.ini)$/i.test(norm);
        };
        const contentEntries = zipEntries.filter((e: any) => !isJunkEntry(e.entryName));
        if (contentEntries.length === 0) {
            discardZip();
            return { ok: false, status: 400, body: { error: 'Zip contains no plugin files.' } };
        }

        // First path segment of every CONTENT entry (normalize backslashes). Reject '.'/'..' tokens
        // outright — adm-zip preserves a leading './', and split('/')[0] would otherwise yield '.'.
        const rootDirs = new Set<string>();
        for (const e of contentEntries) {
            const first = String(e.entryName).replace(/\\/g, '/').split('/')[0];
            if (!first) continue;
            if (first === '.' || first === '..') {
                discardZip();
                return { ok: false, status: 400, body: { error: 'Malicious zip: entry names contain "." / ".." path segments.' } };
            }
            rootDirs.add(first);
        }

        const singleRoot = rootDirs.size === 1;
        const intendedSlug = (singleRoot ? Array.from(rootDirs)[0] : zipName) as string;
        if (!isValidSlug(intendedSlug)) {
            discardZip();
            return { ok: false, status: 400, body: { error: `Refused: '${intendedSlug}' is not a valid plugin folder name (expected a single [A-Za-z0-9_-] segment, no dots or separators).` } };
        }
        // Replacing a specific plugin: the zip must name that same plugin. See expectedSlug above —
        // installing to a different directory here is silently destructive, so fail loudly instead
        // and let the caller roll back.
        if (expectedSlug && intendedSlug !== expectedSlug) {
            discardZip();
            return {
                ok: false,
                status: 400,
                body: {
                    error: `Refused: this archive installs '${intendedSlug}', but the plugin being updated is '${expectedSlug}'. `
                        + `The zip's root folder must be named '${expectedSlug}' (a version-suffixed folder such as `
                        + `'${expectedSlug}-1.2.3' is not accepted, because the update must replace the existing directory).`,
                    intendedSlug,
                    expectedSlug,
                },
            };
        }
        // Guaranteed a proper CHILD of PLUGINS_DIR (throws otherwise). In BOTH shapes the plugin's files
        // must land under installedDir: single-root entries carry the '<slug>/' prefix and extract to
        // PLUGINS_DIR; files-at-root extract into installedDir. Confinement is checked against installedDir
        // either way — so cross-plugin overwrite (my-plugin/../victim/evil.js) is blocked by CONTAINMENT,
        // not merely by a '..' substring heuristic.
        const staging = typeof opts.stageRoot === 'string' && opts.stageRoot.length > 0;
        let installRoot = PLUGINS_DIR;
        let installedDir: string;
        if (staging) {
            // The stage root is ours (makeStageDir), but prove it anyway: a child of os-tmp, and the
            // plugin dir a proper child of it.
            const stageRoot = path.resolve(String(opts.stageRoot));
            const stagedDir = stageRoot.startsWith(OS_TMP_DIR + path.sep) ? resolveWithin(stageRoot, intendedSlug) : null;
            if (!stagedDir) { discardZip(); return refuseUncontainedZip(); }
            installRoot = stageRoot;
            installedDir = stagedDir;
        } else {
            installedDir = resolveSafePluginDir(intendedSlug);
        }
        const targetDir = singleRoot ? installRoot : installedDir;
        const confineDir = path.resolve(installedDir);

        // SECURITY: Zip Slip — every content entry must resolve INSIDE the plugin's own dir. Segment-level
        // '..' check (a filename that merely embeds '..' like 'a..b.min.js' is legitimate and allowed).
        for (const entry of contentEntries) {
            const rel = String(entry.entryName).replace(/\\/g, '/');
            const dest = path.resolve(targetDir, rel);
            const isContained = dest === confineDir || dest.startsWith(confineDir + path.sep);
            const hasDotDotSegment = rel.split('/').includes('..');
            if (!isContained || hasDotDotSegment) {
                discardZip();
                return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip / path traversal)' } };
            }
        }

        // SECURITY: an uploaded plugin must NOT claim a slug the host reserves for itself (`core`, the
        // theme namespace `theme-*`, `@*` — core/plugin-slug-policy.ts, the one rule shared with the
        // boot-time scan) nor clobber an existing plugin by case/Unicode variant. Canonicalize for comparison.
        const canonSlug = String(intendedSlug).normalize('NFC').toLowerCase();
        const reservedReason = require('../core/plugin-slug-policy').reservedPluginSlugReason(intendedSlug);
        if (reservedReason) {
            discardZip();
            return { ok: false, status: 409, body: { error: `Refused: ${reservedReason}. Rename the plugin's folder (its slug) and upload it again.`, code: 'reserved_plugin_slug' } };
        }
        try {
            const clash = fs.readdirSync(PLUGINS_DIR).find((d: string) => d !== intendedSlug && d.normalize('NFC').toLowerCase() === canonSlug);
            if (clash) {
                discardZip();
                return { ok: false, status: 409, body: { error: `Refused: name collides with existing plugin '${clash}' (case/Unicode squat).` } };
            }
        } catch { /* PLUGINS_DIR missing — nothing to clobber */ }

        // INTEGRITY: refuse to overwrite a RUNNING plugin's code in place — a botched extract would
        // corrupt a working plugin and the next reload would swap live code with no warning.
        //
        // AN ORPHAN IS NOT RUNNING. `active_plugins` is a stored INTENTION, and it can name a slug
        // whose files are not loadable at all (core/plugins' orphan header). This guard used to read
        // that option ALONE, so a residual `plugins/<slug>/dist/` with the option still listing <slug>
        // answered 409 "Deactivate it before re-uploading" — about a plugin the Instalados tab did not
        // show and therefore could not deactivate. So reconcile FIRST: reclaimOrphanedPlugin drops the
        // stale entry atomically and returns null for anything that is a real plugin, which is what
        // leaves the live-plugin refusal below exactly as strict as it was.
        const orphan = staging ? null : await reclaimOrphanedPlugin(intendedSlug);
        if (orphan) {
            // Remove the RESIDUE — and only a residue. `residual` is core's proof that the directory
            // holds no manifest.json and no entry file; a merely unreadable manifest is a broken
            // plugin whose code is still someone's work, so it keeps `residual: false` and falls
            // through to the "a plugin directory already exists" refusal below. data/ survives either
            // way (removePluginDirPreservingData), so the adopt path reconnects the preserved state.
            let removedResidue = false;
            if (orphan.residual && fs.existsSync(installedDir)) {
                try { removePluginDirPreservingData(installedDir); removedResidue = true; }
                catch (e: any) { log.warn({ intendedSlug: logSafe(intendedSlug), err: e }, `[plugins] residue of orphaned ${logSafe(intendedSlug)} could not be removed`); }
            }
            await recordAudit(actorId, 'plugin.orphan_reclaim', 'plugin', intendedSlug, {
                via: 'install', reason: orphan.reason,
                droppedActiveEntry: orphan.droppedActiveEntry, removedResidue,
            });
            await clearOrphanNotice(intendedSlug);
        } else if (!staging && await isPluginActive(intendedSlug)) {
            const refusal = alreadyInstalled(intendedSlug, true, zip);
            discardZip();
            return refusal;
        }

        // INTEGRITY: refuse to install over an EXISTING (even inactive) plugin directory. The extract
        // overwrites in place and, if post-extract validation fails, the catch below rmSync's the whole
        // dir — which would destroy a legitimate same-named plugin's files that were there first (audit
        // LOW). To update a plugin, POST /plugins/:slug/update (runPluginUpdate stages the new code,
        // validates it, then swaps it in) — the refusal below says so.
        //
        // EXCEPTION — residual runtime data: uninstall preserves plugins/<slug>/data/ (encryption keys,
        // attachments — see removePluginDirPreservingData). A dir containing NOTHING but data/ is not a
        // plugin (no manifest, no code); adopt it and extract around it so reinstall reconnects with the
        // preserved state instead of 409ing.
        let hadResidualData = false;
        if (!staging && fs.existsSync(installedDir)) {
            let residualOnly = false;
            try {
                residualOnly = fs.readdirSync(installedDir).every((e: string) => e === 'data');
            } catch { /* unreadable → treat as a real plugin and refuse */ }
            if (!residualOnly) {
                const refusal = alreadyInstalled(intendedSlug, false, zip);
                discardZip();
                return refusal;
            }
            hadResidualData = fs.existsSync(path.join(installedDir, 'data'));
        }

        // WHAT A PREVIOUS UNINSTALL KEPT IS ADOPTED ONLY ON AN EXPLICIT CHOICE. Uninstall-with-keep-data
        // leaves plugins/<slug>/data/ and the wjp_<slug>_* tables behind; a later install under the same
        // slug used to reconnect with them silently, so a different package that happened to carry the
        // slug inherited the previous plugin's keys, attachments and rows. Now the caller must say which:
        //   'adopt'   — keep them and reconnect (the previous behaviour, for a genuine reinstall);
        //   'discard' — remove them and start clean (only once the new package has passed validation).
        // Without a choice the answer is 409 `existing_plugin_data`, listing what was found, so the admin
        // UI can ask. The update path (staging) replaces a plugin in place and is not concerned.
        let discardLeftovers = false;
        if (!staging) {
            let leftoverTables: string[] = [];
            try {
                leftoverTables = await listPluginTables(intendedSlug);
                // Only tables that are this slug's by the SQL guard's own ownership rule: 'acme' must not
                // report (or, on discard, drop) the wjp_acme_shop_* tables of an installed 'acme-shop'.
                const pluginApi = require('../core/plugin-api');
                if (typeof pluginApi.isTableOwnedBy === 'function') {
                    leftoverTables = leftoverTables.filter((t: string) => pluginApi.isTableOwnedBy(t, intendedSlug));
                }
            }
            catch (e: any) { log.warn({ intendedSlug: logSafe(intendedSlug), err: e }, `[plugins] could not list the tables of ${logSafe(intendedSlug)} before installing it`); }
            if (hadResidualData || leftoverTables.length > 0) {
                const choice = opts.existingData;
                if (choice !== 'adopt' && choice !== 'discard') {
                    discardZip();
                    return {
                        ok: false,
                        status: 409,
                        body: {
                            error: `A previous installation of '${intendedSlug}' left data behind`
                                + `${hadResidualData ? ' (its data directory)' : ''}${leftoverTables.length ? ` (${leftoverTables.length} database table(s))` : ''}. `
                                + 'Choose whether to keep it and reconnect the plugin to it, or to discard it and start clean, then upload again '
                                + '(API: send existingData=adopt or existingData=discard with the zip).',
                            code: 'existing_plugin_data',
                            data: { slug: intendedSlug, dataDir: hadResidualData, tables: leftoverTables },
                        },
                    };
                }
                if (choice === 'discard') {
                    // Set the preserved data/ aside (same volume: os-tmp is a sibling of plugins/) rather than
                    // deleting it now: a package that fails validation below must leave the previous state
                    // exactly as it was. Deleted for good — together with the tables — only on success.
                    if (hadResidualData) {
                        fs.mkdirSync(OS_TMP_DIR, { recursive: true, mode: 0o700 });
                        const aside = fs.mkdtempSync(path.join(OS_TMP_DIR, 'discard-'));
                        fs.renameSync(path.join(installedDir, 'data'), path.join(aside, 'data'));
                        discardedDataAside = aside;
                        restoreTarget = installedDir;
                        hadResidualData = false; // a clean install: the zip's own data/ (if any) is extracted
                    }
                    discardLeftovers = true;
                }
            }
        }

        // Write ONLY the already-validated FILE content entries OURSELVES — never zip.extractEntryTo (audit
        // #29 — adm-zip directory-entry Zip-Slip). extractEntryTo on a DIRECTORY entry re-enumerates that
        // dir's children by RAW startsWith-prefix, which re-introduces junk-filtered '..' entries that never
        // passed the containment scan above (e.g. 'my-plugin/../victim/desktop.ini' → sibling write past
        // installedDir). By skipping directory entries and mkdir'ing each file's parent, every write is
        // confined to the plugin's own dir. Re-assert containment on the FINAL dest (defense-in-depth —
        // identical rule to the pre-scan; unreachable for the entries validated at the loop above).
        for (const entry of contentEntries) {
            if (entry.isDirectory) continue; // dirs are re-created from file paths below; never extract-enumerate them
            const rel = String(entry.entryName).replace(/\\/g, '/');
            const dest = path.resolve(targetDir, rel);
            const isContained = dest === confineDir || dest.startsWith(confineDir + path.sep);
            const hasDotDotSegment = rel.split('/').includes('..');
            if (!isContained || hasDotDotSegment) {
                discardZip();
                try { if (hadResidualData) removePluginDirPreservingData(installedDir); else fs.rmSync(installedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
                restoreDiscardedData(installedDir);
                return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip / path traversal)' } };
            }
            // When adopting residual runtime data, the zip's own data/ payload is ignored ENTIRELY:
            // preserved keys/attachments always win, and a zip that fails validation later can never
            // have mixed its files into the preserved data dir.
            if (hadResidualData) {
                const residualDataDir = path.join(installedDir, 'data');
                if (dest === residualDataDir || dest.startsWith(residualDataDir + path.sep)) continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, entry.getData());
        }
        pluginSlug = intendedSlug;

        // VALIDATE what we just extracted BEFORE reporting success: a plugin must have a well-formed
        // manifest, be isolated, use only known permissions, and pass the AST scan. On any failure,
        // remove the extracted dir (installedDir is guaranteed a proper child of PLUGINS_DIR) and 400.
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
            // C1: `dependencies` are installed by the HOST with npm at activation. Only plain registry
            // version ranges are accepted — git/GitHub/file:/link:/workspace:/npm: aliases/tarball URLs
            // can run build scripts on the server or install unscanned code under another name. Refused
            // here, at install, so the administrator sees why before anything is activated (and again
            // inside installPluginDependencies, for whatever reaches the disk another way).
            const depProblems = validateManifestDependencies(manifest.dependencies);
            if (depProblems.length) throw new Error(`Invalid dependencies:\n- ${depProblems.join('\n- ')}`);
            // The WordJS it needs (`requires.wordjs`, core/core-requirement.ts): a malformed range is a 400, and
            // a package that needs a newer core than this one is a 409 core_version_too_old — refused here,
            // before it replaces anything, so an update cannot leave the admin on a blank screen. Upload,
            // catalog install, update and adopt all pass through this point.
            const coreRequirement = require('../core/core-requirement');
            const requiresProblems = coreRequirement.validateManifestRequires(manifest.requires);
            if (requiresProblems.length) throw new Error(`Invalid requires:\n- ${requiresProblems.join('\n- ')}`);
            coreRequirement.assertCoreCompatible(manifest, pluginSlug);
            // Browser code (admin page, hooks, Verso blocks, prebuilt dist bundles) runs in the admin's
            // origin with the viewer's session — it must be DECLARED as browser:script so the activation
            // dialog asks about it. See core/plugins.ts BROWSER_SCRIPT_TOKEN.
            const browserProblems = validateBrowserCapability(installedDir, manifest);
            if (browserProblems.length) throw new Error(`Invalid permissions:\n- ${browserProblems.join('\n- ')}`);
            // Declared roles must live in the plugin's own namespace (core/plugin-roles.ts) — refused at
            // the door, before an administrator is ever asked to grant `roles:declare`.
            const roleProblems = validateManifestRoles(pluginSlug, manifest);
            if (roleProblems.length) throw new Error(`Invalid roles:\n- ${roleProblems.join('\n- ')}`);
            // Declared per-account capabilities, the same namespace rule (core/account-capabilities.ts).
            const accountCapProblems = require('../core/account-capabilities').validateManifestAccountCapabilities(pluginSlug, manifest);
            if (accountCapProblems.length) throw new Error(`Invalid accountCapabilities:\n- ${accountCapProblems.join('\n- ')}`);
            // Two installed plugins never answer to the same /admin/plugin/<slug> (core/adminMenu.ts
            // adminPageConflict): the admin layout opens a plugin page through the menu items pointing there.
            const pageConflict = require('../core/adminMenu').adminPageConflict(pluginSlug, manifest);
            if (pageConflict) throw new Error(`Invalid admin page: ${pageConflict}`);
            // Same for its public portal page (/portal/<slug>, core/portal-pages.ts).
            const portalConflict = require('../core/portal-pages').portalPageConflict(pluginSlug, manifest);
            if (portalConflict) throw new Error(`Invalid portal page: ${portalConflict}`);
            // Static AST scan in DECLARATION mode (the default) — deliberately NOT grant mode. Nothing is
            // granted at install time; this pass is what produces the requested-permission list the admin
            // approves from. The grant-aware pass runs at ACTIVATION (core/plugins.ts), which is where a
            // capability the admin denied must actually block the code.
            validatePluginPermissions(pluginSlug, installedDir, manifest);
        } catch (valErr: any) {
            // Failed validation → undo the extract. If we ADOPTED residual data, restore the residual
            // state (data/ survives, extracted files go); otherwise remove the whole dir as before —
            // a rejected zip must never leave lingering files behind.
            try {
                if (hadResidualData) removePluginDirPreservingData(installedDir);
                else fs.rmSync(installedDir, { recursive: true, force: true });
            } catch { /* best-effort */ }
            restoreDiscardedData(installedDir);
            discardZip();
            if (valErr && valErr.status === 409 && valErr.body) return { ok: false, status: 409, body: valErr.body };
            return { ok: false, status: 400, body: { error: valErr.message, details: { missingPermissions: valErr.missingPermissions, dangerousCalls: valErr.dangerousCalls } } };
        }

        // Cleanup temp file
        discardZip();

        // existingData === 'discard', and the package is valid: now the previous installation's leftovers
        // go — its data/ (set aside above), its wjp_<slug>_* tables, owned options and private storage,
        // as "delete with data" removes them.
        if (discardLeftovers) {
            if (discardedDataAside) {
                try { fs.rmSync(discardedDataAside, { recursive: true, force: true }); }
                catch (e: any) { log.warn({ err: e }, `[plugins] the previous data directory of ${logSafe(pluginSlug)} could not be removed from os-tmp`); }
                discardedDataAside = null;
            }
            try { await require('../core/plugins').uninstallPluginData(pluginSlug, { dropTables: true, retireSandbox: false }); }
            catch (e: any) { log.warn({ err: e }, `[plugins] the previous tables of ${logSafe(pluginSlug)} could not be removed`); }
            await recordAudit(actorId, 'plugin.discard_previous_data', 'plugin', pluginSlug, { via: 'install' });
        }

        if (staging) return { ok: true, status: 200, body: { success: true, staged: true, slug: pluginSlug } };
        return { ok: true, status: 200, body: { success: true, message: 'Plugin installed successfully', slug: pluginSlug } };
    } catch (error: any) {
        // Cleanup temp file on error
        discardZip();
        if (restoreTarget) restoreDiscardedData(restoreTarget);
        log.error({ err: error }, '[plugins] install failed');
        return { ok: false, status: 500, body: { error: publicErrorText(error, 'Failed to install plugin.') } };
    }
}

// ── One-click in-place UPDATE ────────────────────────────────────────────────────────────────────────
// installPluginFromZip deliberately 409s on an existing/active plugin so a botched extract can never
// corrupt a working install. Updating therefore means running the full cycle AROUND the installer, while
// PRESERVING the plugin's data/ dir and its wjp_<slug>_* tables and REPLAYING the admin's grants — with a
// fail-safe rollback if anything fails, and an origin gate so only the source it was installed from may
// update it. This is the feature previously proposed as PR #258 (held), re-implemented on top of the
// isolate-teardown invariants that landed in #260.

// The stash of the old code lives in OS_TMP_DIR (a project dir backups exclude), not the OS temp — so a
// crash mid-update leaves it where `recoverInterruptedPluginUpdates()` can find it at the next boot.
// Stash dir name: `plugin-update-<random>` (mkdtemp), with the slug it belongs to in a marker file inside
// (STASH_SLUG_FILE). The name carries no request value at all, so no path built under it depends on one.
// STASH_RE_LEGACY is the earlier `plugin-update-<slug>-<16 hex>` form, still recovered at boot.
const STASH_RE = /^plugin-update-[A-Za-z0-9]{6}$/;
const STASH_RE_LEGACY = /^plugin-update-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})-[0-9a-f]{16}$/;
const STASH_SLUG_FILE = '.wordjs-stash-slug';

// Single-node mutual exclusion: install / update / uninstall of ONE slug are mutually exclusive within a
// process. (Cross-node exclusion is the dist-lock lease below; it is a no-op on single-host SQLite, so the
// in-process guard is what actually serializes the common single-node case.)
const pluginOpInProgress = new Set<string>();

/**
 * A private scratch dir under os-tmp for an update: `plugin-update-<random>` (the stash of the old code)
 * or `plugin-stage-<random>` (where the new code is validated). Created exclusively by mkdtemp at 0700,
 * from a fixed prefix only — the plugin's slug never becomes part of the path. The stash records its slug
 * in STASH_SLUG_FILE (validated again when read back) so boot recovery knows where to restore it.
 */
function makeStashDir(slug: string, kind: 'update' | 'stage' = 'update'): string {
    fs.mkdirSync(OS_TMP_DIR, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(OS_TMP_DIR, kind === 'stage' ? 'plugin-stage-' : 'plugin-update-'));
    if (kind === 'update') fs.writeFileSync(path.join(dir, STASH_SLUG_FILE), slug, { flag: 'wx', mode: 0o600 });
    return dir;
}
// The STAGING dir an update extracts and validates the new code in, before the installed plugin is touched.
// Never the only copy of anything: boot recovery just deletes a leftover one (new and legacy names).
const STAGE_RE = /^plugin-stage-(?:[A-Za-z0-9]{6}|[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}-[0-9a-f]{16})$/;

/**
 * A manifest declares permissions as {scope, access} objects; grants are "scope:access" tokens (or the
 * literal "network"). Convert one to the other so the update's permission diff compares like with like —
 * the SAME shape used at activation (see the manifest→token maps elsewhere in this file).
 */
function manifestPermTokens(manifest: any): string[] {
    const list = Array.isArray(manifest && manifest.permissions) ? manifest.permissions : [];
    return list
        .map((p: any) => {
            if (p && p.scope) return p.scope === 'network' ? 'network' : `${p.scope}:${p.access || 'read'}`;
            return typeof p === 'string' ? p : null;
        })
        .filter(Boolean) as string[];
}

/** Move every top-level entry of `from` into `to`, replacing any collision. Used to swap code dirs. */
function moveEntriesInto(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
        if (entry === STASH_SLUG_FILE) continue; // the stash's own marker, not plugin code
        const dest = path.join(to, entry);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* nothing there */ }
        fs.renameSync(path.join(from, entry), dest);
    }
}

/**
 * In-place update of an installed plugin from a new zip. `origin` is the catalog provenance that gates
 * the update (must match what the plugin was installed from). Returns the same {ok,status,body} contract
 * as installPluginFromZip. Always consumes `newZipPath`.
 *
 * `opts.via === 'upload'`: an administrator uploaded the zip by hand (POST /plugins/:slug/update). There
 * is no catalog to match, so the origin gate does not apply — the admin choosing the file IS the
 * provenance, exactly as for a fresh upload — and a recorded catalog origin is DROPPED afterwards: the code
 * no longer comes from that catalog, so a later one-click update must not present itself as one.
 *
 * `opts.via === 'adopt' | 'reinstall'`: the code comes from a catalog OTHER than the one recorded for the
 * plugin (no origin and the official catalog → 'adopt'; any other source change → 'reinstall'; see
 * plugin-origins catalogApplyMode). The origin gate is assertAdoptableFrom instead, and what the update
 * otherwise carries over is decided again:
 *  - the grants and the egress/private-destination lists are NOT replayed: they are replaced by
 *    `opts.grants` (what the administrator approved in the consent dialog just now), kept only where the
 *    new manifest declares them. A failure rolls the previous policy back with the previous code.
 *  - `opts.keepData === false` (reinstall only, an explicit choice) also removes the plugin's data: its
 *    data/ dir goes to the stash with the old code (deleted on success, restored on a rollback) and its
 *    tables, owned options, account capabilities and private storage are purged as on "delete with data".
 *    Adopting from the official catalog always keeps the data.
 *  - the new origin is recorded, so the next update is a normal one.
 *
 * Order: the new code is extracted and VALIDATED in a private staging dir first (installPluginFromZip in
 * staging mode). A zip that fails there changes nothing — the installed plugin keeps running. Only then
 * is the plugin stopped and its code swapped (old code to a stash, staged code in, manifest.json LAST so
 * boot recovery reads "no manifest" as "the swap did not finish" and restores the stash).
 */
async function runPluginUpdate(
    slug: string,
    newZipPath: string,
    origin: { source: string; catalogId: string; version?: any } | null,
    opts: { via?: 'upload' | 'adopt' | 'reinstall'; officialSource?: string; grants?: string[]; keepData?: boolean; confirmedSourceChange?: boolean } = {}
): Promise<{ ok: boolean; status: number; body: any }> {
    const perms = require('../core/plugin-permissions');
    const core = require('../core/plugins');
    const origins = require('../core/plugin-origins');
    const distLock = require('../core/dist-lock');

    let zipConsumed = false;
    // The zip comes from the caller (multer's temp file for POST /:slug/update, the marketplace
    // download): only a file PROVED to sit inside os-tmp is ever unlinked here — the same inline
    // form / canonical-resolve / containment check installPluginFromZip makes before its own unlink.
    const ownZip = typeof newZipPath === 'string' && newZipPath.length > 0 && !newZipPath.includes('\0')
        ? path.resolve(newZipPath) : '';
    const cleanupZip = () => {
        if (zipConsumed) return;
        zipConsumed = true;
        if (ownZip.startsWith(OS_TMP_DIR + path.sep)) { try { fs.unlinkSync(ownZip); } catch { /* */ } }
    };

    // Resolve + validate the slug BEFORE anything (CodeQL-clean; guarantees a proper child of PLUGINS_DIR).
    let installedDir: string;
    try { installedDir = resolveSafePluginDir(slug); }
    catch (e: any) { cleanupZip(); return { ok: false, status: e.status || 400, body: { error: e.message } }; }

    if (!fs.existsSync(path.join(installedDir, 'manifest.json'))) {
        cleanupZip();
        return { ok: false, status: 404, body: { error: `Plugin '${slug}' is not installed.` } };
    }

    // Mutual exclusion (in-process, then cross-node lease).
    if (pluginOpInProgress.has(slug)) {
        cleanupZip();
        return { ok: false, status: 409, body: { error: `Another operation on plugin '${slug}' is already in progress.` } };
    }
    pluginOpInProgress.add(slug);
    const lease = await distLock.acquireBlocking(`wordjs:plugin-op:${slug}`, { ttlMs: 120000, renewMs: 40000, timeoutMs: 3000 });
    if (!lease.held) {
        pluginOpInProgress.delete(slug);
        cleanupZip();
        return { ok: false, status: 409, body: { error: `Plugin '${slug}' is busy on another node — try again shortly.` } };
    }

    const readManifest = (dir: string): any => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
    };
    const oldManifest = readManifest(installedDir);
    const fromVersion = oldManifest && oldManifest.version != null ? String(oldManifest.version) : null;
    const oldPermissions: string[] = manifestPermTokens(oldManifest);

    let stashDir: string | null = null;
    let wasActive = false;
    // adopt / reinstall: the grants are decided again (see the doc comment), and keeping the data is a choice.
    const takeover = opts.via === 'adopt' || opts.via === 'reinstall';
    const keepData = opts.via !== 'reinstall' || opts.keepData !== false;
    // The policy in force before a takeover, to put back on a rollback and to report (audit).
    let previousPolicy: { grants: string[]; egress: string[]; privateDestinations: string[] } | null = null;
    let previousOrigin: any = null;
    let policyReplaced = false;
    let approvedGrants: string[] = [];
    const restorePreviousPolicy = async (): Promise<void> => {
        if (!policyReplaced || !previousPolicy) return;
        try {
            await perms.removeGrants(slug);
            await perms.setGrants(slug, previousPolicy.grants, { adminDecision: true });
            if (previousPolicy.egress.length) await perms.setEgressAllowlist(slug, previousPolicy.egress);
            if (previousPolicy.privateDestinations.length) await (await perms.applyPrivateDestinations(slug, previousPolicy.privateDestinations)).announced;
            policyReplaced = false;
        } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] the previous permissions could not be restored`); }
    };

    // AN UPDATE NEVER REWRITES THE GRANTS OR THE EGRESS LIST. The plugin stays installed, so what an
    // administrator decided for it stays as it is stored (uninstallPluginData keepGrants). The update used
    // to clear the record and write back a copy taken from this node's memory — which a revoke or a
    // narrowed allowlist made through another node does not reach — so an update served by a stale node
    // re-granted what had been revoked and widened the egress list (to every public host when the copy was
    // empty). The one write it makes is to a plugin with NO grant record, which gets an empty one before
    // anything moves (perms.ensureGrantRecord: insert-if-absent, no administrator decision): the boot
    // backfill grants an active plugin without a record whatever its manifest declares, and the manifest
    // is about to be the new version's. What this node RUNS the plugin with is its in-memory copy, so the
    // stored record is adopted into it before every (re)activation here.
    const adoptStoredPolicy = async (): Promise<boolean> => {
        try { await perms.adoptStoredPolicy(slug); return true; }
        catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] the stored grants could not be read`); return false; }
    };
    // Put the previous version back exactly: partial new code out (data/ kept), stashed code in,
    // reactivated if it had been running — with the stored grants, and not at all when they cannot be
    // read. Best-effort — a rollback must never itself throw.
    // Resolves to whether the plugin is RUNNING again (true when it did not need to be), because "rolled
    // back" without that is the claim an admin acts on: when the reactivation fails too (or the stored
    // grants cannot be read), the previous version is on disk but switched off, and the answer has to
    // say so.
    const rollback = async (): Promise<boolean> => {
        await restorePreviousPolicy();
        try { removePluginDirPreservingData(installedDir); } catch { /* */ }
        if (stashDir) { try { moveEntriesInto(stashDir, installedDir); fs.rmSync(stashDir, { recursive: true, force: true }); } catch { /* */ } stashDir = null; }
        if (!wasActive) return true;
        if (!(await adoptStoredPolicy())) return false;
        try { await core.activatePlugin(slug); return true; } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] rollback reactivate failed`); return false; }
    };

    let stageDir: string | null = null;
    try {
        // ORIGIN GATE — before any destructive action (no rollback needed if this throws). A hand upload
        // has no catalog to match (see the doc comment).
        // An adopt / reinstall is gated on the origin read now: the mode asked for must be the plugin's.
        if (takeover) {
            ({ recorded: previousOrigin } = await origins.assertAdoptableFrom(slug, origin, String(opts.officialSource || ''), opts.via, { confirmedSourceChange: opts.confirmedSourceChange }));
        } else if (opts.via !== 'upload') await origins.assertUpdatableFrom(slug, origin);

        // A GRANT RECORD BEFORE ANYTHING MOVES, so neither the new version nor a crash half-way through
        // the update finds the plugin without one. An ACTIVE plugin with no record is granted, at the next
        // boot, everything its manifest declares (backfillActive), and from step 4 on that manifest is the
        // new version's: without this, a plugin activated while declaring nothing (an API token may
        // activate one) and then updated to a version that declares `network` or `database:write` would
        // get them at the next restart, approved by nobody. Created empty and undecided, a plugin that was
        // never activated is still seeded on its first activation (shouldSeedDeclaredGrants), and an
        // existing record — or one another writer stores meanwhile — is never touched. A database error
        // here fails the update before anything has moved.
        await perms.ensureGrantRecord(slug);

        // 0. STAGE + VALIDATE the new version while the installed one keeps running. Every check of a
        //    fresh install runs here (zip bomb, Zip Slip, manifest, permissions, AST scan, page
        //    conflicts), and the destination is pinned to THIS plugin: a zip whose root folder names
        //    another plugin is refused before anything moves. installPluginFromZip consumes the zip.
        stageDir = makeStashDir(slug, 'stage');
        zipConsumed = true;
        const staged = await installPluginFromZip(newZipPath, `${slug}.zip`, slug, undefined, { stageRoot: stageDir });
        if (!staged.ok) {
            // Nothing was touched; `rolledBack`/`restoredVersion` keep their meaning for callers: the
            // previous version is what is installed.
            return { ok: false, status: staged.status, body: { ...staged.body, unchanged: true, rolledBack: true, restoredVersion: fromVersion } };
        }
        const stagedPluginDir = resolveWithin(stageDir, slug);
        if (!stagedPluginDir) throw new Error('staging path escaped os-tmp');

        // SNAPSHOT the state we must replay.
        wasActive = await core.isPluginActive(slug);
        if (takeover) {
            // The STORED policy (not this node's memory, which a revoke elsewhere may not have reached).
            await perms.adoptStoredPolicy(slug);
            previousPolicy = { grants: perms.getGrants(slug), egress: perms.getEgressAllowlist(slug), privateDestinations: perms.getPrivateDestinations(slug) };
        }

        // 1. Nothing runs while the files move (don't prune deps — the new version reinstalls them).
        if (wasActive) await core.deactivatePlugin(slug, { prune: false });

        // 2. Stash the old CODE aside, keeping plugins/<slug>/data/ (mail keys, DKIM, attachments).
        stashDir = makeStashDir(slug);
        //    A reinstall that does NOT keep the data stashes data/ too: gone on success, back on a rollback.
        for (const entry of fs.readdirSync(installedDir)) {
            if (entry === 'data' && keepData) continue;
            fs.renameSync(path.join(installedDir, entry), path.join(stashDir, entry));
        }

        // 3. Clear the old version's strikes/enqueued assets — KEEP the wjp_<slug>_* tables and the
        //    stored grants and egress allowlist. A reinstall without its data purges the tables, owned
        //    options, account capabilities and private storage, as "delete with data" does.
        const declaredCapabilities = Array.isArray(oldManifest && oldManifest.accountCapabilities)
            ? oldManifest.accountCapabilities.map((c: any) => String(c && c.slug || '')).filter(Boolean) : [];
        //    The Windows sandbox profile: a plain update (the same source's code) keeps it — the plugin keeps
        //    its slug, so its next launch is granted exactly the same zones, and only its own folder is
        //    re-granted after the swap below. An adopt or a reinstall brings code of ANOTHER provenance: the
        //    profile is retired on every site as an uninstall does, so that code starts from no ACE at all and
        //    is granted only what its launch grants (a root-only revoke takes seconds).
        const retireSandbox = takeover;
        await core.uninstallPluginData(slug, keepData
            ? { dropTables: false, keepGrants: true, retireSandbox }
            : { dropTables: true, keepGrants: true, accountCapabilities: declaredCapabilities, retireSandbox });
        if (retireSandbox) {
            try { await core.retireOnSecondarySites(slug); }
            catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] the sandbox profiles of the other sites could not be retired`); }
        }

        // 4. SWAP the validated staged code in. The preserved data/ always wins over a data/ the zip
        //    ships (only a plugin that had none receives the zip's). manifest.json goes LAST: until it
        //    lands, boot recovery sees an unfinished swap and restores the stash.
        const hasData = fs.existsSync(path.join(installedDir, 'data'));
        const stagedEntries = fs.readdirSync(stagedPluginDir)
            .filter((e: string) => !(e === 'data' && hasData))
            .sort((a: string, b: string) => (a === 'manifest.json' ? 1 : 0) - (b === 'manifest.json' ? 1 : 0));
        for (const entry of stagedEntries) {
            fs.renameSync(path.join(stagedPluginDir, entry), path.join(installedDir, entry));
        }
        // The swap rewrote the manifest from outside the sandbox — drop io-guard's cached declaration.
        try { require('../core/io-guard').forgetDeclaredPermissions(slug); } catch { /* io-guard optional */ }
        // Windows: the new files came in by rename, keeping the staging folder's security descriptor, so
        // the plugin's own folder is granted again at the next launch of every site's worker (no-op elsewhere).
        try { await require('../core/sandbox-windows').refreshPluginDirGrants(path.resolve(PLUGINS_DIR, '..'), slug, core.pluginWorkerSiteIds()); }
        catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] the sandbox grants of its folder could not be refreshed`); }

        // 5. Adopt the STORED grants + egress BEFORE reactivating — they are baked into the isolate at
        //    spawn time. A database error here is thrown (and rolls back): nothing starts on a guess.
        //    An adopt / reinstall REPLACES them first with what the administrator approved now, limited to
        //    what the new manifest declares; the old egress and private destinations are not carried over.
        if (takeover) {
            const declaredNow = new Set(manifestPermTokens(readManifest(installedDir)));
            approvedGrants = Array.from(new Set((Array.isArray(opts.grants) ? opts.grants : []).map(String))).filter((t) => declaredNow.has(t));
            policyReplaced = true;
            await perms.removeGrants(slug);
            await perms.setGrants(slug, approvedGrants, { adminDecision: true });
        }
        await perms.adoptStoredPolicy(slug);

        // 6. Re-record the origin under the lease (so it can't land on a slug a concurrent op just removed).
        //    A hand upload drops it instead: the code on disk is no longer that catalog's.
        if (origin) { try { await origins.setPluginOrigin(slug, origin); } catch { /* */ } }
        else if (opts.via === 'upload') {
            try { await origins.removePluginOrigin(slug); } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] the catalog origin could not be cleared`); }
        }

        // 7. Reactivate if it was running. activatePlugin can throw AFTER loadIsolatedPlugin registered the
        //    child — that orphan must be torn down BEFORE rolling back, or its hooks/routes/providers stay
        //    wired to a process nobody supervises.
        if (wasActive) {
            try {
                await core.activatePlugin(slug);
            } catch (actErr: any) {
                try { require('../core/plugin-isolate').unloadIsolatedPlugin(slug); } catch { /* */ }
                const reactivated = await rollback();
                const stillOff = reactivated ? '' : ` The previous version${fromVersion ? ` (v${fromVersion})` : ''} is back on disk but is NOT running: it could not be started again either, so it is now inactive. Activate it once the cause is fixed.`;
                // THE SANDBOX REFUSED the new version (and, on a host whose sandbox is down, the old one
                // too): the same 409 `sandbox_unavailable` the activation route answers, so the stable
                // code, the failure line and the operator action reach this caller as well, instead of a
                // generic 500 whose only trace of the cause was the wrapped message.
                const refusal = findSandboxUnavailable(actErr);
                if (refusal) {
                    return { ok: false, status: 409, body: sandboxRefusalBody(refusal, {
                        message: `Update of '${slug}' installed, but the plugin sandbox refused to start it, so the update was rolled back.${stillOff} ${refusal.message}`,
                        rolledBack: true, restoredVersion: fromVersion, reactivated,
                    }) };
                }
                return { ok: false, status: 500, body: { error: `Update installed but reactivation failed and was rolled back: ${actErr && actErr.message}.${stillOff}`, rolledBack: true, restoredVersion: fromVersion, reactivated } };
            }
        }

        // Success — the old code is no longer needed.
        if (stashDir) { try { fs.rmSync(stashDir, { recursive: true, force: true }); } catch { /* */ } stashDir = null; }
        // Multisite: the other sites' workers of this plugin still run the previous code — restart them on
        // the new one (each in its own site, with its own grants). No-op on a single site.
        try { await core.respawnOnSecondarySites(slug); } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugin-update ${logSafe(slug)}] restart on the other sites failed: ${logSafe(e && e.message)}`); }

        const newManifest = readManifest(installedDir);
        const toVersion = newManifest && newManifest.version != null ? String(newManifest.version) : null;
        const newDeclared: string[] = manifestPermTokens(newManifest);
        const oldSet = new Set(oldPermissions);
        const grantedSet = new Set(perms.getGrants(slug));
        // newPermissions = declared by THIS version and NOT by the previous manifest (a real diff, so a
        // permission the admin deliberately refused is not re-reported as "new" on every update).
        const newPermissions = newDeclared.filter((p) => !oldSet.has(p));
        // ungrantedPermissions = declared by this version and still not granted (usable only once approved).
        const ungrantedPermissions = newDeclared.filter((p) => !grantedSet.has(p));

        const body: any = { success: true, updated: true, slug, fromVersion, toVersion, reactivated: wasActive, newPermissions, ungrantedPermissions };
        if (takeover) {
            Object.assign(body, {
                mode: opts.via, keptData: keepData,
                previousSource: previousOrigin ? previousOrigin.source : null, newSource: origin ? origin.source : null,
                previousGrants: previousPolicy ? previousPolicy.grants : [], grants: approvedGrants,
            });
        }
        return { ok: true, status: 200, body };
    } catch (e: any) {
        if (stashDir) { try { await rollback(); } catch { /* */ } }
        else await restorePreviousPolicy();
        cleanupZip();
        log.error({ slug: logSafe(slug), err: e }, `[plugins] update of '${logSafe(slug)}' failed`);
        return { ok: false, status: e.status || 500, body: e.body || { error: publicErrorText(e, `Failed to update plugin '${slug}'.`) } };
    } finally {
        if (stageDir) { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ } }
        try { await lease.release(); } catch { /* */ }
        pluginOpInProgress.delete(slug);
    }
}

/**
 * At boot, reconcile any stash left by an update that was killed mid-flight (between "stash old code" and
 * "install new"). If plugins/<slug>/ has a manifest, the update finished (or the new code is already in
 * place) → discard the stash. If it has NO manifest (only data/), the plugin's only copy of its code is in
 * the stash → restore it. Runs BEFORE loadActivePlugins so a plugin is never loaded from a half-updated dir.
 * Per-slug lease so a replica booting mid-update on a shared plugins dir skips a stash another node owns.
 */
async function recoverInterruptedPluginUpdates(): Promise<void> {
    let names: string[];
    try { names = fs.readdirSync(OS_TMP_DIR); } catch { return; }
    const distLock = require('../core/dist-lock');
    const base = path.resolve(OS_TMP_DIR);
    for (const name of names) {
        // A leftover STAGING dir is never the only copy of anything (the swap moves out of it). Remove it
        // once it is clearly abandoned — an hour old, so a replica's in-flight update keeps its own.
        if (STAGE_RE.test(name)) {
            const stage = path.resolve(base, name);
            try {
                if (stage.startsWith(base + path.sep) && Date.now() - fs.statSync(stage).mtimeMs > 3600_000) {
                    fs.rmSync(stage, { recursive: true, force: true });
                }
            } catch { /* best-effort */ }
            continue;
        }
        const legacy = STASH_RE_LEGACY.exec(name);
        if (!legacy && !STASH_RE.test(name)) continue;
        const stashDir = path.resolve(base, name);
        if (stashDir !== base && !stashDir.startsWith(base + path.sep)) continue; // containment
        let slug = legacy ? legacy[1] : '';
        if (!legacy) {
            try { slug = fs.readFileSync(path.join(stashDir, STASH_SLUG_FILE), 'utf8').trim(); } catch { /* no marker */ }
            if (!isValidSlug(slug)) { log.warn({ name: logSafe(name) }, `[plugin-update] stash '${logSafe(name)}' names no valid plugin — left in place.`); continue; }
        }
        let installedDir: string;
        try { installedDir = resolveSafePluginDir(slug); } catch { continue; }
        const lease = await distLock.acquireBlocking(`wordjs:plugin-op:${slug}`, { ttlMs: 60000, renewMs: 20000, timeoutMs: 1500 });
        if (!lease.held) { log.warn({ slug: logSafe(slug) }, `[plugin-update] '${logSafe(slug)}' stash owned by another node — skipping recovery here.`); continue; }
        try {
            if (fs.existsSync(path.join(installedDir, 'manifest.json'))) {
                fs.rmSync(stashDir, { recursive: true, force: true });
                log.info({ slug: logSafe(slug) }, `[plugin-update] discarded a completed update's stash for '${logSafe(slug)}'.`);
            } else {
                // No manifest: the swap did not finish (it moves manifest.json last). Clear whatever part
                // of the new code landed — data/ stays — then put the previous version back.
                if (fs.existsSync(installedDir)) removePluginDirPreservingData(installedDir);
                moveEntriesInto(stashDir, installedDir);
                fs.rmSync(stashDir, { recursive: true, force: true });
                log.info({ slug: logSafe(slug) }, `[plugin-update] recovered an interrupted update for '${logSafe(slug)}' — restored the previous version.`);
            }
        } catch (e: any) {
            log.warn({ slug: logSafe(slug), err: e }, `[plugin-update] recovery failed for '${logSafe(slug)}'`);
        } finally {
            try { await lease.release(); } catch { /* */ }
        }
    }
}

/**
 * @swagger
 * /plugins/registry:
 *   get:
 *     summary: Get public plugin registry (for frontend)
 *     description: >-
 *       No sign-in required. One entry per ACTIVE plugin carrying only what the bundle loaders need: which
 *       plugins serve an editor-block bundle, and what explains a missing hooks bundle — never the manifest (no name, version, author,
 *       permissions or dependencies), so the endpoint cannot be used to fingerprint the install. Whether a
 *       plugin's browser:script capability is granted (`browser`) is included only for a signed-in caller
 *       with admin-panel access (access_admin_panel); every other caller gets the entries without it.
 *       Sent with Cache-Control private, no-cache.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     responses:
 *       200:
 *         description: The active plugins
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [plugins]
 *               properties:
 *                 plugins:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [id, path]
 *                     properties:
 *                       id:
 *                         type: string
 *                       path:
 *                         type: string
 *                       browser:
 *                         type: boolean
 *                         description: >-
 *                           Whether the plugin's browser:script capability is granted (its bundles are
 *                           served). Present only for a signed-in caller with access_admin_panel.
 *                       frontend:
 *                         type: object
 *                         nullable: true
 *                         description: >-
 *                           Absent when the manifest declares no frontend; null when the manifest could not
 *                           be read; otherwise an object whose `hooks` is true when a hooks bundle is declared.
 *                         properties:
 *                           hooks:
 *                             type: boolean
 *                       blocks:
 *                         type: boolean
 *                         description: >-
 *                           Whether GET /plugins/{id}/bundle?type=component serves the plugin's editor-block
 *                           bundle (active, browser:script granted and built). Block loaders ask only these.
 */
/**
 * @swagger
 * /plugins/assets:
 *   get:
 *     summary: Enqueued frontend assets (scripts/styles) for ACTIVE plugins — public, for the site layout
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: >-
 *           Scripts and styles enqueued by the currently ACTIVE plugins that currently hold the assets:write
 *           grant (a revoked grant stops a plugin's entries at the next read). Every stored entry is
 *           re-checked against the published plugin surface on the way out, so an entry pointing at a path
 *           that is no longer served is omitted rather than emitted as a broken tag. Sent with
 *           Cache-Control private, no-cache (no shared cache may hold it: the list changes on a revoke).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [scripts, styles]
 *               properties:
 *                 scripts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       handle:
 *                         type: string
 *                         description: Namespaced as "<slug>:<handle>".
 *                       src:
 *                         type: string
 *                       inFooter:
 *                         type: boolean
 *                       strategy:
 *                         type: string
 *                       origins:
 *                         type: array
 *                         description: The https origins the script loads code from (e.g. an analytics provider); the public pages' Content-Security-Policy allows exactly these.
 *                         items:
 *                           type: string
 *                 styles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       handle:
 *                         type: string
 *                         description: Namespaced as "<slug>:<handle>".
 *                       src:
 *                         type: string
 *                       media:
 *                         type: string
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/assets', asyncHandler(async (req: Request, res: Response) => {
    const { getActiveAssets } = require('../core/plugin-assets');
    // NOT shared-cacheable. The list changes the moment a plugin is deactivated or loses assets:write, and
    // its one consumer, the public layout's server render (frontend/src/lib/server-api getPublicAssets),
    // caches it in its own Data Cache under the `plugin-assets` tag, which those changes purge — it does
    // not read this header. `public, max-age=60` let any shared cache in front of /api keep handing out a
    // revoked plugin's <script src> for a minute that no purge reaches; `private, no-cache` keeps every
    // copy revalidated (the weak ETag makes that a 304) and out of shared caches. Set here, the index.ts
    // public-JSON default (which would add s-maxage + stale-while-revalidate) leaves it alone.
    res.set('Cache-Control', 'private, no-cache');
    res.json(await getActiveAssets());
}));

/** Does the bundle route serve this plugin's editor-block bundle (dist/component.bundle.js)? */
async function componentBundleServed(slug: string): Promise<boolean> {
    const bundle = pluginFile(slug, 'dist', 'component.bundle.js');
    if (!bundle || !fs.existsSync(bundle)) return false;
    try { return await require('../core/plugin-serving').browserCodeServable(slug); } catch { return false; }
}

router.get('/registry', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // ANONYMOUS endpoint, so it answers only what its one consumer needs — never the manifest.
    //
    // This used to spread each active plugin's FULL manifest: name, exact version, author, every
    // requested permission and its reason, the dependency list. To an anonymous caller that is a
    // fingerprint of the install ("which plugins, which versions, which of them hold network or
    // database:write") — exactly the inventory an attacker needs to pick a known-vulnerable version.
    // The consumer is frontend/src/lib/pluginBundleLoader.ts, which reads it ONLY to explain a 404 on
    // an active plugin's hooks bundle or admin page: it needs the id/path to find the entry, whether the
    // plugin declares `frontend.hooks`, whether its manifest was readable at all (`frontend: null`), and
    // whether its browser:script capability is granted (a 404 for an ungranted plugin is the gate
    // working, not a broken build). Nothing else is emitted. The slugs themselves are already public
    // through GET /plugins/active, which the public site needs to load blocks.
    //
    // THE REGISTRY STATES THE GRANT ONLY TO THE ADMIN SHELL. `browser` is one of the plugin's permissions,
    // and the admin shell is the only place it is read — the loader runs in the admin layout, with the session cookie, for users who
    // can open the admin panel. So it is emitted only for a signed-in caller holding access_admin_panel;
    // everyone else gets the entries without it, and the loader then reads every 404 as "not found"
    // rather than "not granted". The answer depends on who asks: no shared cache may hold it.
    const { isGranted } = require('../core/plugin-permissions');
    const showsGrant = !!(req.user && typeof req.user.can === 'function' && req.user.can('access_admin_panel'));
    const plugins = await getAllPlugins();
    const activePlugins = plugins.filter((p: any) => p.active);

    const registry: any[] = [];

    for (const plugin of activePlugins) {
        const entry: any = {
            id: plugin.slug,
            path: `/plugins/${plugin.slug}`,
        };
        if (showsGrant) entry.browser = isGranted(plugin.slug, 'browser', 'script');
        // A directory name read back from disk is still a segment we did not write — resolve it through
        // the same allowlist + containment proof, and treat "cannot resolve" as "no manifest" (fail closed).
        const manifestPath = pluginFile(plugin.slug, 'manifest.json');
        let manifest: any = null;
        if (manifestPath && fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch (err) {
                log.warn({ slug: logSafe(plugin.slug), err }, `Failed to read manifest for ${logSafe(plugin.slug)}`);
            }
        }
        if (!manifest || typeof manifest !== 'object') {
            // `frontend: null` is the "manifest unreadable" signal the loader reports as a broken install.
            entry.frontend = null;
        } else if (manifest.frontend && typeof manifest.frontend === 'object') {
            entry.frontend = manifest.frontend.hooks ? { hooks: true } : {};
        }
        // (A readable manifest with no `frontend` key leaves the property ABSENT — "declares nothing".)
        // `minWordjs` (admin session only, like `browser`): the WordJS the plugin declares it needs
        // (`requires.wordjs`), so an admin screen whose bundle cannot run on this core can say which
        // version to update to instead of rendering nothing.
        if (showsGrant && manifest && typeof manifest === 'object') {
            const core = require('../core/core-requirement').coreCompatibility(manifest);
            if (core.minimum) entry.minWordjs = core.minimum;
        }
        // `blocks`: would GET /plugins/<id>/bundle?type=component serve something? The public site and
        // the editor asked EVERY active plugin for its block bundle, so each plugin without editor blocks
        // cost a 404 and a console error on every page view (S1-21). This is the same answer that request
        // gives (active + browser:script granted + built), so it tells an anonymous caller nothing the
        // bundle URL does not already tell them.
        entry.blocks = await componentBundleServed(plugin.slug);
        registry.push(entry);
    }

    res.set('Cache-Control', 'private, no-cache');
    res.json({ plugins: registry });
}));

/**
 * The shortcode tags the ACTIVE plugins declare in their manifest (`shortcodes: [{ tag }]`) that a public
 * page renders with the plugin's own site component (`frontend.components`), as [{ tag, plugin }]. The
 * front end used to keep its own hardcoded tag → plugin list; it now asks, so the core names no plugin.
 * Tags are identifiers (letters, digits, `_`, `-`); the first plugin (by slug) to declare a tag owns it.
 */
const SHORTCODE_TAG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
async function declaredPluginShortcodes(): Promise<Array<{ tag: string; plugin: string }>> {
    const plugins = (await getAllPlugins()).filter((p: any) => p.active).sort((a: any, b: any) => String(a.slug).localeCompare(String(b.slug)));
    const owners = new Map<string, string>();
    for (const p of plugins) {
        let manifest: any;
        try { manifest = JSON.parse(fs.readFileSync(path.join(p.path, 'manifest.json'), 'utf8')); } catch { continue; }
        const components = manifest && manifest.frontend && manifest.frontend.components;
        if (!Array.isArray(components) || components.length === 0) continue;   // nothing to render it with
        const id = typeof manifest.id === 'string' && manifest.id ? manifest.id : p.slug;
        for (const sc of Array.isArray(manifest.shortcodes) ? manifest.shortcodes : []) {
            const tag = sc && typeof sc.tag === 'string' ? sc.tag.trim().toLowerCase() : '';
            if (SHORTCODE_TAG.test(tag) && !owners.has(tag)) owners.set(tag, id);
        }
    }
    return Array.from(owners, ([tag, plugin]) => ({ tag, plugin }));
}

/**
 * @swagger
 * /plugins/shortcodes:
 *   get:
 *     summary: Shortcode tags the active plugins render with their own site component
 *     description: >-
 *       Public. Each active plugin's manifest `shortcodes` whose plugin ships a site component
 *       (`frontend.components`). A static HTML front page replaces `[tag]` with that component.
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: The declared tags and their owning plugin.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   tag:
 *                     type: string
 *                   plugin:
 *                     type: string
 */
router.get('/shortcodes', asyncHandler(async (_req: Request, res: Response) => {
    res.json(await declaredPluginShortcodes());
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
 *         description: >-
 *           List of all plugins. ORPHANED slugs — claimed by the active_plugins option, or merely left
 *           on disk, with no loadable files — are included with `broken: true`, `active: false`,
 *           `brokenReason` (missing | no-manifest | unreadable-manifest), `wasActive` and `removable`
 *           (its directory holds no code, so the deactivate route may delete it). They are NOT part of
 *           GET /plugins/active nor of the marketplace catalog's `installed` flag. Each role a plugin's
 *           manifest declares (`roles`) carries `holders`: how many users already hold that role slug.
 *           `activationSeedsGrants` says whether activating the plugin now would grant every permission
 *           its manifest declares (it has no grant record, or an empty one no administrator decided);
 *           false means activation changes no grant — after an administrator revoked every grant, the
 *           plugin is activated with nothing granted.
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    // Annotate each with its requested/granted permissions so the admin UI can render the per-permission
    // switches. `requestedPermissions` = what the manifest asks for ("scope:access"), the set of switches
    // to show; `grantedPermissions` = what the admin has granted (+ "network"). No trust tier exists.
    const { getGrants, activationSeedsDeclaredGrants, ceilingFor, isOfferedHere } = require('../core/plugin-permissions');
    // Live runtime health per isolate (running/crashed/crash-looping/restarting + rss/restarts) so the
    // admin sees the TRUE state, not just the persisted 'active' flag which can lie after a crash.
    const { getIsolateStatus } = require('../core/plugin-isolate');
    const { THEMES_DIR } = require('../core/themes');
    // ORPHANS ride along as an EXPLICIT projection, they are not folded into getAllPlugins().
    //
    // That list is consumed by GET /plugins/active, by the dev registry generators and by the
    // marketplace's `installed` flag, and every one of them would start lying if an entry with no
    // files appeared in it (the catalog card would offer "Installed" for something that cannot run).
    // So the contract of getAllPlugins() is unchanged and this screen — the only place an
    // administrator can act on an orphan — projects them itself, flagged `broken: true` and never
    // `active`, next to the plugins that really are installed.
    const orphanRows = (await listOrphanedPlugins()).map((o: any) => ({
        name: o.slug,
        slug: o.slug,
        version: '',
        description: '',
        author: '',
        homepage: '',
        path: '',
        active: false,
        permissions: [],
        requestedPermissions: [],
        grantedPermissions: getGrants(o.slug),
        runtime: null,
        hasTheme: false,
        themeInstalled: false,
        broken: true,
        brokenReason: o.reason,          // 'missing' | 'no-manifest' | 'unreadable-manifest'
        wasActive: !!o.active,           // it was listed in active_plugins when we looked
        removable: !!o.residual,         // its directory holds no code, so cleanup may delete it
    }));
    // How many users ALREADY hold each role a plugin declares: a role left behind by an earlier
    // installation of the same plugin (orphaned, its holders kept) comes back to those users the moment
    // `roles:declare` is granted again — the grant screen says so, next to the role.
    const { countRoleHolders } = require('../core/roles');
    const holdersOf = new Map<string, number>();
    for (const p of plugins) {
        for (const r of Array.isArray(p.roles) ? p.roles : []) {
            const slug = r && typeof r.slug === 'string' ? r.slug : '';
            if (!slug || holdersOf.has(slug) || !/^[a-z0-9_]{1,64}$/.test(slug)) continue;
            try { holdersOf.set(slug, await countRoleHolders(slug)); } catch { /* unknown: not shown */ }
        }
    }
    // What confirming the activation dialog grants: POST /:slug/activate stores the manifest's permissions
    // only when shouldSeedDeclaredGrants() says so (no record, or an empty one no administrator decided) —
    // so a plugin whose every grant an administrator revoked is activated with nothing granted, and the
    // dialog must say that instead of listing the permissions as granted. Decided on the stored record, as
    // the activation decides it. A read failure leaves the flag out (the dialog then reads the grants).
    let seedsOnActivation: Record<string, boolean> = {};
    try { seedsOnActivation = await activationSeedsDeclaredGrants(plugins.map((p: any) => p.slug)); }
    catch (e: any) { log.warn({ err: e }, '[plugins] could not read the stored grants for the activation dialog'); }
    res.json(orphanRows.concat(plugins.map((raw: any) => {
        // browser:script for a plugin that ships browser code WITHOUT declaring it — one installed before
        // the capability existed. Its manifest cannot be rewritten from here, but the administrator must
        // still see (and be able to revoke) the capability: the permissions screen only offers switches
        // for what is listed, and saving that screen would otherwise drop the upgrade-time grant. So the
        // listing projects an explicit, flagged entry; the manifest on disk is untouched.
        let permissions: any[] = Array.isArray(raw.permissions) ? raw.permissions : [];
        try {
            const mp = pluginFile(raw.slug, 'manifest.json');
            const manifest = mp ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
            const sources = manifest ? browserCodeSources(path.dirname(mp as string), manifest) : [];
            const declared = permissions.some((x: any) => x && x.scope === 'browser' && x.access === 'script');
            if (sources.length && !declared) {
                permissions = [...permissions, {
                    scope: 'browser',
                    access: 'script',
                    undeclared: true,
                    reason: `Not declared by this plugin (it predates the "${BROWSER_SCRIPT_TOKEN}" permission), but it ships browser code: ${sources.join(', ')}.`,
                }];
            }
        } catch { /* unreadable manifest: nothing to project */ }
        const p = { ...raw, permissions };
        const roles = (Array.isArray(p.roles) ? p.roles : []).map((r: any) => (r && typeof r === 'object' && holdersOf.has(r.slug)
            ? { ...r, holders: holdersOf.get(r.slug) }
            : r));
        const requested = Array.from(new Set((p.permissions || [])
            .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
            .filter(Boolean)));
        // Companion theme (option B): does this plugin bundle a theme/, and is it installed already?
        // lstat (not stat) so a symlinked theme/ reads as "no theme" — install-theme refuses it anyway.
        let hasTheme = false;
        const themeProbe = pluginFile(p.slug, 'theme');
        try { hasTheme = !!themeProbe && fs.lstatSync(themeProbe).isDirectory(); } catch { /* none */ }
        const ceiling = ceilingFor(p.slug);
        return {
            ...p,
            roles,
            requestedPermissions: requested,
            grantedPermissions: getGrants(p.slug),
            // Multisite: on a site other than the main one, whether the network offers this plugin here and
            // the most this site may grant it (absent on the main site and on a single site).
            ...(ceiling ? { offered: isOfferedHere(p.slug), grantCeiling: Array.from(ceiling) } : {}),
            ...(typeof seedsOnActivation[p.slug] === 'boolean' ? { activationSeedsGrants: seedsOnActivation[p.slug] } : {}),
            runtime: p.active ? (getIsolateStatus(p.slug) || null) : null,
            hasTheme,
            themeInstalled: hasTheme && fs.existsSync(path.join(THEMES_DIR, `${p.slug}-theme`)),
            // Dev-only "build & download ZIP" (POST /plugins/:slug/pack) is available.
            packable: isDevMode(),
        };
    })));
}));

/**
 * @swagger
 * /plugins/{slug}/status:
 *   get:
 *     summary: Live runtime health of an isolated plugin
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
 *         description: >-
 *           The isolate's live health — the TRUE runtime state, which can disagree with the persisted
 *           "active" flag after a crash. A managed isolate with no health record yet reports only its state.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [state]
 *               properties:
 *                 state:
 *                   type: string
 *                   description: >-
 *                     running, crashed, crash-looping, restarting, stopped, or refused — the plugin sandbox
 *                     would not start it (at boot, on a supervised restart or on another node); lastError is
 *                     the refusal and `sandbox` its details.
 *                 pid:
 *                   type: integer
 *                 startedAt:
 *                   type: integer
 *                   description: Epoch milliseconds.
 *                 uptimeMs:
 *                   type: integer
 *                 restarts:
 *                   type: integer
 *                 lastExitCode:
 *                   type: integer
 *                   nullable: true
 *                 lastError:
 *                   type: string
 *                   nullable: true
 *                 rssBytes:
 *                   type: integer
 *                 sandbox:
 *                   type: object
 *                   description: Only with state `refused` — the same object as `details.sandbox` of a 409 sandbox_unavailable.
 *                   properties:
 *                     mechanism:
 *                       type: string
 *                     state:
 *                       type: string
 *                     reason:
 *                       type: string
 *                     failure:
 *                       type: string
 *                       nullable: true
 *                     action:
 *                       type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug (rejected before any path is built).
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       404:
 *         description: The plugin is not a loaded isolate (never loaded, or not run in isolation).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/status', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid slug' });
    const { getIsolateStatus } = require('../core/plugin-isolate');
    const status = getIsolateStatus(slug);
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
 *       400:
 *         description: >
 *           The plugin was rejected before it started: an undeclared browser capability
 *           (`plugin_browser_capability_undeclared`) or a failed static validation, whose `details`
 *           split missing permissions from forbidden calls.
 *       403:
 *         description: >-
 *           Not an administrator, or rest_token_management_forbidden: an API token asked to activate a
 *           plugin whose activation would grant the permissions it declares — one with no grant record, or
 *           with an empty one no administrator decided (data.params lists them). Nothing is activated or
 *           granted; an administrator activates it once from an interactive session, after which a token
 *           may deactivate and re-activate it. A plugin whose every grant an administrator revoked is
 *           re-activated by a token with nothing granted.
 *       409:
 *         description: >
 *           `sandbox_unavailable` — the plugin sandbox refused to start the plugin, either because the
 *           native sandbox is not active on this server under the fail-closed policy
 *           (`sandbox.requireHardening`) or because its launcher refused this launch. `message` is the
 *           human reason; `details.sandbox` names the mechanism, its state, the launcher's own failure
 *           line when there is one, and the operator action. Paths are never included.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                   enum: [sandbox_unavailable]
 *                 message:
 *                   type: string
 *                 details:
 *                   type: object
 *                   properties:
 *                     sandbox:
 *                       type: object
 *                       properties:
 *                         mechanism:
 *                           type: string
 *                           enum: [landlock, appcontainer, seatbelt, none]
 *                         state:
 *                           type: string
 *                         reason:
 *                           type: string
 *                         failure:
 *                           type: string
 *                           nullable: true
 *                         action:
 *                           type: string
 */
/** Multisite: the answer for a plugin the network has not offered to this site. */
function refuseNotOffered(res: Response, slug: string) {
    return res.status(403).json({
        code: 'plugin_not_offered',
        message: `Plugin '${slug}' is not available on this site: the network administrator has not offered it to the sites of the network.`,
        data: { status: 403 },
    });
}

router.post('/:slug/activate', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // browser:script must be DECLARED by a plugin that ships browser code, or the activation dialog
    // the admin just confirmed never mentioned that this plugin's code will run with their session.
    // Checked HERE (the administrator's activation) and at install, deliberately NOT inside
    // core.activatePlugin: that function also re-activates an already-running plugin after an update
    // or its rollback, and a plugin that was active before this rule existed must keep running (it was
    // granted the capability once at upgrade — see migrateBrowserCapabilityGrants).
    {
        const manifestPath = pluginFile(slug, 'manifest.json');
        let manifest: any = null;
        try { if (manifestPath) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* activatePlugin reports it */ }
        if (manifest && manifestPath && !(await isPluginActive(slug))) {
            const problems = validateBrowserCapability(path.dirname(manifestPath), manifest);
            if (problems.length) {
                return res.status(400).json({ message: problems.join(' '), error: problems.join(' '), code: 'plugin_browser_capability_undeclared' });
            }
        }
    }

    // Default-deny grants: when an admin activates a plugin (having seen its requested permissions in the
    // activation dialog), grant exactly what its manifest DECLARES — but ONLY when the plugin holds no
    // grants an administrator decided (shouldSeedDeclaredGrants: no record, or an empty one with no
    // administrator decision recorded — what an older in-place update left behind). A partial REVOKE via
    // the per-permission switches survives a re-activation, and so does a revoke of EVERY grant: the
    // permissions route records it as the administrator's decision. The admin can refine grants anytime
    // in /admin/plugins.
    //
    // PERSIST the declared set BEFORE activating, and drop it again if the activation fails (a plugin that
    // fails its AST scan / test gate must not leave a grant record behind). Persisting only after success
    // was wrong on a cluster: activatePlugin() publishes 'activate' to the other nodes as it finishes, so
    // they loaded the plugin before its grants existed anywhere but this node's memory — refusing it
    // ("declared but not granted") or spawning it without its grants. An in-memory-only seed was also
    // erased by any policy re-read landing mid-activation (a peer's change, the periodic re-sync).
    //
    // Whether to seed is decided by seedGrants() on the row it reads fresh under the policy lease (not on
    // this node's map, which may be a re-sync behind), with the one rule in shouldSeedDeclaredGrants(), and
    // the seed is recorded as the administrator's decision in the same write: they approved it in the
    // activation dialog (core/plugin-permissions ADMIN_DECISIONS_MARKER).
    //
    // AN API TOKEN NEVER SEEDS. The grant-on-activate IS the administrator's approval of the activation
    // dialog, and a token read no dialog: a token-driven activation that would seed permissions is refused,
    // before anything runs, naming them. A plugin that declares nothing, or holds what an administrator
    // decided (re-activating it after a deactivation or an update), seeds nothing, so a headless deploy may
    // still activate it. For a token the question is asked of the STORED record, and the stored record —
    // grants AND egress allowlist — is adopted into this node's copy before the plugin starts here
    // (adoptStoredPolicy): an administrator's revoke or narrowed allowlist made on another node may not
    // have reached this node's memory yet, and the token must not start the plugin with the stale copy
    // (core/plugin-permissions "against what is stored").
    const { seedGrants, clearGrants, adoptStoredPolicy, isOfferedHere } = require('../core/plugin-permissions');
    // Multisite: another site activates only what the network offers it (and nothing is seeded otherwise).
    if (!isOfferedHere(slug)) return refuseNotOffered(res, slug);
    let declared: string[] = [];
    try {
        const all = await getAllPlugins();
        const p = all.find((x: any) => x.slug === slug);
        declared = Array.from(new Set(((p && p.permissions) || [])
            .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
            .filter(Boolean))) as string[];
    } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[Permissions] grant-on-activate (seed) for '${logSafe(slug)}' failed`); }
    let seededDeclared: string[] | null = null;
    if (isHeadless(req)) {
        const stored = await adoptStoredPolicy(slug);
        if (declared.length && stored.seedsDeclaredGrants && refusePluginGrantByToken(req, res, declared)) return;
    } else if (declared.length) {
        try { if (await seedGrants(slug, declared, { adminDecision: true })) seededDeclared = declared; }
        catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[Permissions] grant-on-activate (seed) for '${logSafe(slug)}' failed`); }
    }

    let result;
    try {
        result = await activatePlugin(slug);
    } catch (e: any) {
        // Activation failed (scan/test/init) — drop the grant record seeded above, so a failed-activation
        // plugin holds no grants (in memory or in the database).
        if (seededDeclared) { try { await clearGrants(slug); } catch (ce: any) { log.warn({ slug: logSafe(slug), err: ce }, `[Permissions] grant-on-activate (rollback) for '${logSafe(slug)}' failed`); } }
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
        // THE SANDBOX REFUSED TO START IT. core/plugins.ts wraps every activation failure, so the
        // refusal is found in the cause chain, not by matching words. A 409 with the stable code
        // `sandbox_unavailable`: the request was fine, this SERVER cannot confine plugins right now,
        // and the body says which sandbox, what failed and what the operator can do. It used to fall
        // through to the generic 500 below - "The server encountered an internal error" - on the exact
        // host where every activation was being refused and the administrator needed to know why.
        // The text is path-free by construction (core/sandbox-refusal.ts); the log keeps the rest.
        const refusal = findSandboxUnavailable(e);
        if (refusal) return res.status(409).json(sandboxRefusalBody(refusal));
        throw e;
    }

    // Trigger frontend registry regeneration
    regenerateRegistry();

    // AUDIT: an admin activated a plugin. Slug only — no secret material.
    await recordAudit(req.user && req.user.id, 'plugin.activate', 'plugin', slug, {});

    res.json(result);
}));

/**
 * @swagger
 * /plugins/{slug}/permissions:
 *   post:
 *     summary: Set the per-permission grants for a plugin (admin) — Android-style, default-deny
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               granted:
 *                 type: array
 *                 description: The full granted set, as "scope:access" tokens. Absent or non-array means "grant nothing".
 *                 items:
 *                   type: string
 *               network:
 *                 type: boolean
 *                 description: Truthy adds the "network" grant to the set above.
 *     responses:
 *       200:
 *         description: >-
 *           Grants persisted. A revoke is re-validated against the code on disk immediately: if the plugin
 *           still needs a capability that was just denied it is deactivated (deactivated/deactivationReason);
 *           otherwise a running isolate is re-spawned so the change takes effect now (reloaded). Both the
 *           deactivation and the reload are best-effort — the grant itself is already stored either way.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slug, granted, network, reloaded, deactivated, message]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slug:
 *                   type: string
 *                 granted:
 *                   type: array
 *                   items:
 *                     type: string
 *                 network:
 *                   type: boolean
 *                 reloaded:
 *                   type: boolean
 *                 deactivated:
 *                   type: boolean
 *                 deactivationReason:
 *                   type: string
 *                   nullable: true
 *                 rolesError:
 *                   type: string
 *                   nullable: true
 *                   description: >-
 *                     Set when the plugin is running and declares roles that could not be registered after this
 *                     change (the grant is stored regardless); null otherwise.
 *                 message:
 *                   type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); an API token asking for a grant the plugin
 *           does not hold now (rest_token_management_forbidden, data.params names it: a token may revoke,
 *           never grant, and nothing is written); or a cookie-authenticated request that failed the
 *           same-origin / double-submit CSRF gate (rest_csrf_invalid, rest_csrf_token).
 *       409:
 *         description: >-
 *           `sandbox_unavailable` — the grants WERE saved (`saved: true`), but the plugin sandbox refused to
 *           restart the plugin, which is now stopped (`stopped: true`). Same body as POST
 *           /plugins/{slug}/activate's 409: `details.sandbox` names the mechanism, state, failure line and
 *           operator action.
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.post('/:slug/permissions', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const { applyGrants, getGrants, isOfferedHere } = require('../core/plugin-permissions');
    if (!isOfferedHere(slug)) return refuseNotOffered(res, slug);

    // Body: { granted: ["scope:access", ...], network: boolean }. The admin's granted set is the source
    // of truth (default-deny). We don't constrain to the manifest here — hasPermission already requires
    // BOTH the manifest declaration AND the grant, so granting an undeclared scope simply has no effect.
    const body = req.body || {};
    // A JSON boolean or nothing: "false", 0 or {} must never read as "grant the network".
    if (body.network !== undefined && typeof body.network !== 'boolean') {
        return res.status(400).json({ error: 'network must be true or false.' });
    }
    const tokens: string[] = Array.isArray(body.granted) ? body.granted.map((t: any) => String(t)) : [];
    if (body.network === true) tokens.push('network');
    // An administrator's decision (core/plugin-permissions ADMIN_DECISIONS_MARKER): no upgrade step may
    // later add back a capability this request left out, and a revoke of EVERY grant survives the next
    // activation instead of being re-seeded (shouldSeedDeclaredGrants).
    //
    // An API token may take grants away (a revoke from a runbook) but never add one: what it grants a
    // plugin outlives the token (middleware/auth.ts refusePluginGrantByToken). `narrowOnly` judges the set
    // as it would be stored against what the plugin holds in the DATABASE at the moment of the write — not
    // this node's mirror, which may be a re-sync behind another node's revoke — and refuses it as a whole
    // (`refused` names the additions; nothing is written).
    //
    // Persisted and in force on this node's gates — but NOT yet in the running child, which holds what it
    // was spawned with (the network grant, the egress allowlist, the child-side fs gate). So the scan and
    // the respawn below run NOW, and the `updated_option` fan-out (`announced`, every subscriber told in
    // turn) is waited for only after them: waiting first kept a revoked grant in force in the child for
    // as long as the subscribers took.
    let applied: any;
    try {
        applied = await applyGrants(slug, tokens, { adminDecision: true, narrowOnly: isHeadless(req) });
    } catch (e: any) {
        // An EXCLUSIVE capability (smtp:inbound) another plugin holds: nothing was written. Say who holds it.
        if (e && e.code === 'plugin_grant_exclusive') {
            return res.status(409).json({ code: e.code, error: e.message, conflicts: e.conflicts });
        }
        // Multisite (isolation guarantee I8): a site administrator cannot grant beyond the network's ceiling.
        if (e && e.code === 'plugin_grant_beyond_ceiling') {
            return res.status(403).json({ code: e.code, message: e.message, data: { status: 403, beyond: e.beyond || [] } });
        }
        throw e;
    }
    const { announced, refused } = applied;
    if (refused.length && refusePluginGrantByToken(req, res, refused)) return;

    // A REVOKE has to take effect NOW, not at the next boot. Some capabilities the AST scan gates have no
    // per-call runtime gate to fall back on — filesystem writes inside the plugin's own directory are the
    // motivating case (audit #3) — so a running isolate whose code needs a capability the admin just
    // denied would keep exercising it until someone restarted the site. Re-run the grant-aware scan
    // against the code on disk; if it no longer passes, deactivate instead of reloading. Fail closed and
    // SAY SO in the response, so the admin sees the consequence of the switch they flipped.
    let deactivated = false;
    let deactivationReason: string | null = null;
    if (await isPluginActive(slug)) {
        try {
            const manifestPath = pluginFile(slug, 'manifest.json');
            if (!manifestPath) throw new Error('unresolvable plugin path');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            validatePluginPermissions(slug, path.dirname(manifestPath), manifest, { mode: 'grant' });
        } catch (valErr: any) {
            if (valErr && valErr.code === 'PLUGIN_VALIDATION_FAILED') {
                deactivationReason = (valErr.missingPermissions || []).join('; ') || valErr.message;
                try { await deactivatePlugin(slug); deactivated = true; }
                catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[Permissions] deactivation of '${logSafe(slug)}' after revoke failed`); }
            } else {
                // A read/parse problem is not evidence of a violation — leave the plugin running and log.
                log.warn({ slug: logSafe(slug), err: valErr }, `[Permissions] post-grant re-validation of '${logSafe(slug)}' could not run`);
            }
        }
    }

    // Re-spawn the isolate so the NETWORK grant (passed in cfg → __WORDJS_PLUGIN_NETWORK__) takes effect.
    // Bridge-scope grants are read live per call on the host, but reloading keeps everything consistent.
    // Best-effort: the grant is already persisted, so a reload hiccup must not fail the change.
    // Gate on the REASON, not on `deactivated`: if the scan condemned the plugin but the deactivation
    // itself failed, restarting the isolate would put the condemned code straight back to work.
    let reloaded = false;
    let reloadRefusal: any = null;
    if (!deactivationReason) {
        try {
            const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
            if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
        } catch (e: any) {
            log.warn({ slug: logSafe(slug), err: e }, `[Permissions] reload of '${logSafe(slug)}' after grant change failed`);
            reloadRefusal = findSandboxUnavailable(e);
        }
    }
    // Multi-node: this node applied the change locally (maps + isolate). Tell every OTHER node to reload
    // its grant map and respawn its isolate — otherwise a node that did not serve this request keeps the
    // OLD grants (and the OLD egress allowlist, including the wordjs.dns name check) until it restarts.
    // No-op on single-node (Redis not configured); coherence skips this node's own publish (self-origin).
    // A revoke that CONDEMNED the plugin propagates via deactivatePlugin's own 'deactivate' publish.
    if (!deactivationReason) { try { require('../core/plugins').publishPluginChange(slug, 'reload'); } catch { /* best-effort */ } }

    await awaitPolicyAnnounced(announced, 'Permissions', slug);

    // Plugin-declared roles follow the `roles:declare` grant of a RUNNING plugin: granting it registers the
    // manifest's roles now (all or nothing); revoking it leaves them registered but inert (core/roles.ts
    // confers a plugin role's own capabilities only while the grant stands). A refusal is reported, not
    // thrown — the grant itself is already stored.
    let rolesError: string | null = null;
    if (!deactivationReason && await isPluginActive(slug)) {
        try {
            const manifestPath = pluginFile(slug, 'manifest.json');
            if (manifestPath) await syncPluginRoles(slug, JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
        } catch (e: any) {
            rolesError = String((e && e.message) || e);
            log.warn({ slug: logSafe(slug), err: rolesError }, `[Permissions] roles of '${logSafe(slug)}' not registered`);
        }
    }

    const granted = getGrants(slug);
    // THE SANDBOX REFUSED THE RESTART. reloadIsolatedPlugin stops the running child BEFORE it loads the
    // new one, so the plugin is now STOPPED - and "permissions updated, reactivate to fully apply" with a
    // 200 told the admin the opposite. The grants ARE saved (they were persisted above); the answer is
    // the refusal contract plus exactly that.
    if (reloadRefusal) {
        return res.status(409).json(sandboxRefusalBody(reloadRefusal, {
            message: `Permissions for '${slug}' were saved (${granted.length} granted), but the plugin is now STOPPED: the plugin sandbox refused to restart it. ${reloadRefusal.message}`,
            slug, granted, network: granted.includes('network'), saved: true, reloaded: false, stopped: true,
        }));
    }
    const tail = deactivationReason
        ? (deactivated
            ? ` Plugin DEACTIVATED — its code requires a capability you denied: ${deactivationReason}`
            : ` Its code requires a capability you denied (${deactivationReason}) and the automatic deactivation FAILED — deactivate it manually.`)
        : (reloaded ? ' Isolate reloaded — changes are in effect.' : ' Reactivate the plugin to fully apply.');
    res.json({
        success: true,
        slug,
        granted,
        network: granted.includes('network'),
        reloaded,
        deactivated,
        deactivationReason,
        rolesError,
        message: `Permissions updated for '${slug}' (${granted.length} granted).${tail}${rolesError ? ` Its roles were NOT registered: ${rolesError}` : ''}`,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/egress-hosts:
 *   parameters:
 *     - in: path
 *       name: slug
 *       required: true
 *       schema:
 *         type: string
 *   get:
 *     summary: Get a plugin's egress allowlist (admin). Only meaningful for a network-granted plugin.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The stored allowlist, plus whether the plugin actually holds the network grant.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug, hosts, network]
 *               properties:
 *                 slug:
 *                   type: string
 *                 hosts:
 *                   type: array
 *                   description: Empty means "no allowlist" — every public host is reachable.
 *                   items:
 *                     type: string
 *                 network:
 *                   type: boolean
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 *   post:
 *     summary: Set a plugin's egress allowlist (admin). Empty = allow all public hosts; non-empty = default-deny except listed hosts + their subdomains.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hosts:
 *                 type: array
 *                 description: >-
 *                   Hostnames, optionally wildcarded. Entries carrying a scheme, path or port are dropped
 *                   silently. An empty array clears the list (back to allow-all-public). Absent or non-array
 *                   is treated as an empty array.
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: >-
 *           Allowlist stored (hosts echoes back what SURVIVED validation, not what was sent). A running
 *           isolate is re-spawned best-effort so the child re-installs the list; reloaded says whether that
 *           happened.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slug, hosts, reloaded, message]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slug:
 *                   type: string
 *                 hosts:
 *                   type: array
 *                   items:
 *                     type: string
 *                 reloaded:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); an API token whose list would let the plugin
 *           reach a host it cannot reach now — a host outside the current list, or an empty list replacing
 *           one, which means every public host (rest_token_management_forbidden, data.params names them,
 *           "*" for every public host; a token may only narrow, and nothing is written); or a
 *           cookie-authenticated request that failed the same-origin / double-submit CSRF gate
 *           (rest_csrf_invalid, rest_csrf_token).
 *       409:
 *         description: >-
 *           `sandbox_unavailable` — the allowlist WAS saved (`saved: true`), but the plugin sandbox refused to
 *           restart the plugin, which is now stopped (`stopped: true`). Same body as POST
 *           /plugins/{slug}/activate's 409.
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/egress-hosts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const { getEgressAllowlist, getGrants } = require('../core/plugin-permissions');
    res.json({ slug, hosts: getEgressAllowlist(slug), network: getGrants(slug).includes('network') });
}));

router.post('/:slug/egress-hosts', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const { applyEgressAllowlist, getEgressAllowlist } = require('../core/plugin-permissions');
    // Body: { hosts: ["api.stripe.com", "*.example.com", ...] }. Invalid entries (schemes/paths/ports) are
    // dropped by applyEgressAllowlist. An empty array clears the list (back to allow-all-public).
    const body = req.body || {};
    const hosts: string[] = Array.isArray(body.hosts) ? body.hosts.map((h: any) => String(h)) : [];
    // The grants route's rule for the network half: an API token may narrow the list, never let the plugin
    // reach a host it cannot reach now — and clearing the list is the widest write there is ("*"). Judged,
    // like the grants, against the list STORED at the moment of the write (`narrowOnly`).
    //
    // In memory now; the running child still enforces the allowlist it was spawned with. Respawn first,
    // then wait for the `updated_option` fan-out (see POST /:slug/permissions).
    const { announced, refused } = await applyEgressAllowlist(slug, hosts, { narrowOnly: isHeadless(req) });
    if (refused.length && refusePluginGrantByToken(req, res, refused)) return;

    // Re-spawn the isolate so the child re-installs the new allowlist (pushed in cfg → egress-guard.setAllowedHosts).
    let reloaded = false;
    let reloadRefusal: any = null;
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
    } catch (e: any) {
        log.warn({ slug: logSafe(slug), err: e }, `[EgressHosts] reload of '${logSafe(slug)}' after egress change failed`);
        reloadRefusal = findSandboxUnavailable(e);
    }
    // Multi-node: propagate so every OTHER node reloads its egress-allowlist map and respawns its isolate.
    // Otherwise a node that did not serve this request keeps resolving/reaching the old host set — the
    // host-side wordjs.dns name check reads getEgressAllowlist from memory. No-op on single-node.
    try { require('../core/plugins').publishPluginChange(slug, 'reload'); } catch { /* best-effort */ }

    await awaitPolicyAnnounced(announced, 'EgressHosts', slug);

    const saved = getEgressAllowlist(slug);
    // Same as the grants route: the child was stopped before the refused load, so say so - with the
    // refusal contract - instead of "reactivate the plugin to apply".
    if (reloadRefusal) {
        return res.status(409).json(sandboxRefusalBody(reloadRefusal, {
            message: `The egress allowlist for '${slug}' was saved (${saved.length} host(s)), but the plugin is now STOPPED: the plugin sandbox refused to restart it. ${reloadRefusal.message}`,
            slug, hosts: saved, saved: true, reloaded: false, stopped: true,
        }));
    }
    res.json({
        success: true,
        slug,
        hosts: saved,
        reloaded,
        message: saved.length
            ? `Egress allowlist set for '${slug}' (${saved.length} host(s); all other public hosts now denied).${reloaded ? ' Isolate reloaded — in effect.' : ' Reactivate the plugin to apply.'}`
            : `Egress allowlist cleared for '${slug}' (all public hosts allowed again).${reloaded ? ' Isolate reloaded — in effect.' : ''}`,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/private-egress:
 *   parameters:
 *     - in: path
 *       name: slug
 *       required: true
 *       schema:
 *         type: string
 *   get:
 *     summary: List the private destinations (exact host:port) an administrator approved for a plugin.
 *     description: >-
 *       Plugins may reach public addresses only. An approved destination is the one exception: exactly that
 *       host on exactly that port (for example a LAN SMTP relay), and only while the plugin holds the
 *       network grant. Link-local (cloud metadata), unspecified and multicast addresses cannot be approved.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The approved destinations and whether the plugin holds the network grant.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug, destinations, network]
 *               properties:
 *                 slug:
 *                   type: string
 *                 destinations:
 *                   type: array
 *                   items:
 *                     type: string
 *                     example: 192.168.1.20:587
 *                 network:
 *                   type: boolean
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: Not authenticated.
 *       403:
 *         description: Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not reach this resource.
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 *   post:
 *     summary: Replace the private destinations approved for a plugin (admin). The egress allowlist is not changed.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               destinations:
 *                 type: array
 *                 description: >-
 *                   `host:port` or `[ipv6]:port` entries (at most 4). Invalid entries are dropped. An empty array
 *                   withdraws every approval.
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Saved (destinations echoes what survived validation); the running plugin is restarted so it applies.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slug, destinations, reloaded]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slug:
 *                   type: string
 *                 destinations:
 *                   type: array
 *                   items:
 *                     type: string
 *                 reloaded:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       404:
 *         description: No plugin with this slug is installed.
 *       401:
 *         description: Not authenticated.
 *       403:
 *         description: >-
 *           Not an administrator (rest_forbidden); a failed CSRF check (rest_csrf_invalid, rest_csrf_token); or an
 *           API token whose list would approve a destination not approved now (rest_token_management_forbidden —
 *           a token may withdraw an approval, never make one; nothing is written).
 *       409:
 *         description: >-
 *           `sandbox_unavailable` — the list WAS saved (`saved: true`), but the plugin sandbox refused to restart
 *           the plugin, which is now stopped (`stopped: true`).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/private-egress', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const { getPrivateDestinations, getGrants } = require('../core/plugin-permissions');
    res.json({ slug, destinations: getPrivateDestinations(slug), network: getGrants(slug).includes('network') });
}));

router.post('/:slug/private-egress', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    const requested = safeSlugParam(req.params.slug);
    if (!requested) return res.status(400).json({ error: 'Invalid plugin slug' });
    // Approvals are for an INSTALLED plugin, and the slug used below (store key, reload) is the one read from
    // the installed list — never the request's own string.
    const slug = (await getAllPlugins()).map((p: any) => String(p.slug)).find((s: string) => s === requested);
    if (!slug) return res.status(404).json({ error: 'Plugin not installed' });
    const { applyPrivateDestinations, getPrivateDestinations } = require('../core/plugin-permissions');
    const body = req.body || {};
    const entries: string[] = Array.isArray(body.destinations) ? body.destinations.slice(0, 32).map((h: any) => String(h)) : [];
    // Same rule as the egress allowlist: an API token may narrow, never widen (judged on the stored list).
    const { announced, refused } = await applyPrivateDestinations(slug, entries, { narrowOnly: isHeadless(req) });
    if (refused.length && refusePluginGrantByToken(req, res, refused)) return;

    // The running child enforces the list it was spawned with: respawn it, then propagate to other nodes.
    let reloaded = false;
    let reloadRefusal: any = null;
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
    } catch (e: any) {
        log.warn({ slug: logSafe(slug), err: e }, `[PrivateEgress] reload of '${logSafe(slug)}' after the change failed`);
        reloadRefusal = findSandboxUnavailable(e);
    }
    try { require('../core/plugins').publishPluginChange(slug, 'reload'); } catch { /* best-effort */ }
    await awaitPolicyAnnounced(announced, 'PrivateEgress', slug);

    const saved = getPrivateDestinations(slug);
    await recordAudit(req.user && req.user.id, 'plugin.private_egress', 'plugin', slug, { destinations: saved });
    if (reloadRefusal) {
        return res.status(409).json(sandboxRefusalBody(reloadRefusal, {
            message: `The private destinations for '${slug}' were saved, but the plugin is now STOPPED: the plugin sandbox refused to restart it. ${reloadRefusal.message}`,
            slug, destinations: saved, saved: true, reloaded: false, stopped: true,
        }));
    }
    res.json({
        success: true,
        slug,
        destinations: saved,
        reloaded,
        message: saved.length
            ? `'${slug}' may now reach ${saved.join(', ')} (and no other private address).${reloaded ? ' Plugin reloaded — in effect.' : ' Reactivate the plugin to apply.'}`
            : `'${slug}' may no longer reach any private address.${reloaded ? ' Plugin reloaded — in effect.' : ''}`,
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
 *         description: Plugin is not active
 *       500:
 *         description: An active plugin that was not running could not be started (its runtime lastError says why)
 *       409:
 *         description: >-
 *           `sandbox_unavailable` — the plugin sandbox refused to start the new child; the old one was
 *           already stopped, so the plugin is now stopped (`stopped: true`). Same body as POST
 *           /plugins/{slug}/activate's 409.
 */
router.post('/:slug/reload', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Reuse the exact same reload the grants route and the dev watcher use: tear the child process
    // down and load it again from its original entry file — the full pipeline (AST scan included)
    // re-runs, so this cannot be used to sidestep the security model.
    const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
    if (!isIsolated(slug)) {
        // An ACTIVE plugin that failed to start (at boot, or its child died for good) has no isolate to
        // reload, and answering 404 left the admin no way back short of deactivating and activating it
        // again (FALLOS 112). Start it through the same pipeline a cross-node activation uses —
        // grants re-read, permissions re-validated, full load with the AST scan — so "Restart" recovers it.
        const core = require('../core/plugins');
        if (!(await core.isPluginActive(slug))) {
            return res.status(404).json({ error: `Plugin '${slug}' is not a loaded isolated plugin (is it active?)` });
        }
        const started = await core.loadOnePlugin(slug);
        if (!started || !isIsolated(slug)) {
            return res.status(500).json({ error: `Plugin '${slug}' could not be started. Its last error is shown on the plugin card.`, slug, stopped: true });
        }
        return res.json({ success: true, slug, message: `Plugin '${slug}' started.` });
    }
    try {
        await reloadIsolatedPlugin(slug);
    } catch (e: any) {
        // The same 409 body as the activation route (the old child is already stopped at this point).
        const refusal = findSandboxUnavailable(e);
        if (refusal) {
            return res.status(409).json(sandboxRefusalBody(refusal, {
                message: `Plugin '${slug}' is now STOPPED: the plugin sandbox refused to restart it. ${refusal.message}`,
                slug, stopped: true,
            }));
        }
        throw e;
    }
    res.json({ success: true, slug, message: `Isolate for '${slug}' reloaded.` });
}));

/**
 * DEV-ONLY "build & download": the same thing as `npm run pack:plugin -- <slug>` (scripts/pack-plugin.js),
 * from the admin screen. Only when config.nodeEnv === 'development' — the same switch as the plugin
 * hot-reload watcher — because packing runs esbuild and may run `npm ci` for a bundled plugin: tools a
 * production server should not be launching on request. Outside development the route answers 404, as if
 * it did not exist, and GET /plugins advertises `packable: false` so the UI hides the button.
 *
 * The packer runs as a CHILD PROCESS (async execFile, argument array, no shell), never in this process:
 * the build is CPU-heavy, may take a while, and loads ts-node for the installer scan. Its last "❌" line is
 * the refusal reason (bad manifest, undeclared dependency, AST-scan block…), returned as a 422.
 */
const PACK_SCRIPT = path.resolve(__dirname, '../../scripts/pack-plugin.js');
const PACK_TIMEOUT_MS = 5 * 60 * 1000;
const isDevMode = () => require('../config/app').nodeEnv === 'development';

/**
 * @swagger
 * /plugins/{slug}/pack:
 *   post:
 *     summary: Build a plugin and download it as an installable ZIP (development mode only)
 *     description: >
 *       Runs scripts/pack-plugin.js on the installed plugin folder: manifest check, frontend build,
 *       dependency resolution, the installer's permission + AST scan, and the upload limits. Answers
 *       404 unless the backend runs with NODE_ENV=development.
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
 *         description: The packed plugin ZIP (`<slug>-<version>.zip`)
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid plugin slug
 *       404:
 *         description: Not in development mode, or the plugin is not installed
 *       409:
 *         description: Another operation on this plugin is in progress
 *       422:
 *         description: The packer refused the plugin; `error` holds the reason and `details.log` the output tail
 */
router.post('/:slug/pack', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    if (!isDevMode()) return res.status(404).json({ error: 'Not found' });
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    if (!pluginFile(slug, 'manifest.json') || !fs.existsSync(pluginFile(slug, 'manifest.json') as string)) {
        return res.status(404).json({ error: `Plugin '${slug}' is not installed.` });
    }
    if (pluginOpInProgress.has(slug)) {
        return res.status(409).json({ error: `Another operation on plugin '${slug}' is already in progress.` });
    }
    pluginOpInProgress.add(slug);
    fs.mkdirSync(OS_TMP_DIR, { recursive: true });
    const outDir = fs.mkdtempSync(path.join(OS_TMP_DIR, 'plugin-pack-'));
    try {
        const run = await new Promise<{ code: number; output: string }>((resolve) => {
            execFile(process.execPath, [PACK_SCRIPT, slug, '--dir', path.resolve(PLUGINS_DIR), '--out', outDir],
                { cwd: path.dirname(PACK_SCRIPT), timeout: PACK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
                (err: any, stdout: string, stderr: string) => {
                    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout || ''}${stderr || ''}` });
                });
        });
        const zipName = run.code === 0 ? fs.readdirSync(outDir).find((f: string) => f.endsWith('.zip')) : undefined;
        if (!zipName) {
            const lines = run.output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
            const reason = [...lines].reverse().find((l) => l.startsWith('❌'));
            return res.status(422).json({
                error: reason ? reason.replace(/^❌\s*/, '') : `Packing '${slug}' failed.`,
                details: { log: lines.slice(-40).join('\n') },
            });
        }
        const buf = fs.readFileSync(path.join(outDir, zipName));
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename="${zipName}"`);
        res.set('Content-Length', String(buf.length));
        res.send(buf);
    } finally {
        pluginOpInProgress.delete(slug);
        fs.rmSync(outDir, { recursive: true, force: true });
    }
}));

/**
 * @swagger
 * /plugins/{slug}/install-theme:
 *   post:
 *     summary: Install the companion theme a plugin bundles (its top-level theme/ folder)
 *     description: >
 *       Copies plugins/<slug>/theme/ to themes/<slug>-theme, validated like an uploaded theme
 *       (footprint budget, no symlinks, never overwrites). Optionally switches the site to it.
 *       HOST-side and admin-only by design (plugin-completeness program, option B) — the plugin
 *       process gains no new capability and is not involved at all.
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
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               activate:
 *                 type: boolean
 *                 description: Switch the active theme to the installed one
 *     responses:
 *       200:
 *         description: Theme installed (and optionally activated)
 *       400:
 *         description: Invalid slug / theme folder failed validation
 *       404:
 *         description: Plugin not found or bundles no theme
 *       409:
 *         description: The companion theme is already installed
 */
router.post('/:slug/install-theme', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Validate ONCE and use what came back — reading req.params.slug again below would be the same
    // "guard a copy, then re-concatenate the raw value" shape this file just finished removing.
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const pluginDir = resolveSafePluginDir(slug);
    if (!fs.existsSync(pluginDir)) {
        return res.status(404).json({ error: `Plugin '${slug}' is not installed` });
    }

    // The bundled theme must be a REAL directory — lstat so a symlinked theme/ (pointing anywhere
    // on the host) is refused, not followed.
    const themeSrc = path.join(pluginDir, 'theme');
    let srcStat: any = null;
    try { srcStat = fs.lstatSync(themeSrc); } catch { /* absent */ }
    if (!srcStat || !srcStat.isDirectory()) {
        return res.status(404).json({ error: `Plugin '${slug}' does not bundle a theme` });
    }

    const { installThemeFromDir, switchTheme } = require('../core/themes');
    const targetSlug = `${slug}-theme`;
    try {
        installThemeFromDir(themeSrc, targetSlug);
    } catch (e: any) {
        if (e && e.code === 'THEME_EXISTS') {
            return res.status(409).json({ error: `Theme "${targetSlug}" is already installed. Delete it in Appearance → Themes to reinstall.` });
        }
        if (e && e.code === 'THEME_INVALID') {
            return res.status(400).json({ error: e.message });
        }
        throw e;
    }

    // Optional one-click switch. Runs AFTER a successful copy; switchTheme re-runs the theme
    // engine init (AST scan + isolated functions.js), same as activating any theme.
    let activated = false;
    if (req.body && req.body.activate === true) {
        await switchTheme(targetSlug);
        activated = true;
    }

    res.json({
        success: true,
        slug: targetSlug,
        activated,
        message: activated
            ? `Theme "${targetSlug}" installed and activated`
            : `Theme "${targetSlug}" installed`
    });
}));

// Ports a plugin declares it needs to bind (manifest `claimPorts: [25]`). Only these are eligible
// for the consensual port-liberation flow below — the endpoints can never act on arbitrary ports.
function getClaimedPorts(slug: string): number[] {
    try {
        const manifestPath = pluginFile(slug, 'manifest.json');
        if (!manifestPath || !fs.existsSync(manifestPath)) return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(manifest.claimPorts)) return [];
        return manifest.claimPorts.filter((p: any) => Number.isInteger(p) && p > 0 && p < 65536);
    } catch {
        return [];
    }
}

/**
 * @swagger
 * /plugins/freed-services:
 *   get:
 *     summary: System mail services WordJS disabled to free a plugin's port, and whether that plugin is still active
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ services: [{ slug, port, service, label, at, pluginActive }] }"
 */
router.get('/freed-services', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const list = await require('../core/port-conflicts').listFreedServices();
    const services = [];
    for (const r of list) services.push({ ...r, pluginActive: await isPluginActive(r.slug) });
    res.json({ services });
}));

/**
 * @swagger
 * /plugins/freed-services/restore:
 *   post:
 *     summary: Turn a system mail service WordJS disabled back on (admin-confirmed) once its plugin no longer needs the port
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service, allowEnable]
 *             properties:
 *               service:
 *                 type: string
 *               allowEnable:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: The service was enabled and started.
 *       404:
 *         description: No service of that name was disabled by WordJS.
 *       409:
 *         description: Missing confirmation, or the plugin that needed the port is still active.
 *       502:
 *         description: systemctl failed.
 */
router.post('/freed-services/restore', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    const service = String(req.body?.service || '');
    const pc = require('../core/port-conflicts');
    const rec = (await pc.listFreedServices()).find((r: any) => r.service === service);
    if (rec && await isPluginActive(rec.slug)) {
        return res.status(409).json({ error: `Plugin '${rec.slug}' is active and listens on port ${rec.port}; deactivate it first.`, code: 'PLUGIN_STILL_ACTIVE' });
    }
    try {
        res.json({ success: true, ...(await pc.restoreFreedService(service, { allowEnable: req.body?.allowEnable === true })) });
    } catch (e: any) {
        if (e && e.status) return res.status(e.status).json({ error: publicErrorText(e, 'The service could not be turned back on.'), code: e.code });
        throw e;
    }
}));

/**
 * @swagger
 * /plugins/{slug}/port-conflicts:
 *   get:
 *     summary: Who is squatting the ports this plugin's manifest claims, and can WordJS free them?
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
 *         description: >-
 *           One verdict per port the manifest claims. Inspection only works on Linux with ss available;
 *           anywhere else the verdict is uninspectable, which callers must NOT read as "free".
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug, conflicts]
 *               properties:
 *                 slug:
 *                   type: string
 *                 conflicts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [port, inUse, canFree]
 *                     properties:
 *                       port:
 *                         type: integer
 *                       inUse:
 *                         type: boolean
 *                       canFree:
 *                         type: boolean
 *                         description: Whether POST /plugins/{slug}/free-port could act on this occupant.
 *                       uninspectable:
 *                         type: boolean
 *                         description: The sockets could not be looked at — distinct from a genuinely free port.
 *                       reason:
 *                         type: string
 *                       occupant:
 *                         type: object
 *                         properties:
 *                           process:
 *                             type: string
 *                           pids:
 *                             type: array
 *                             items:
 *                               type: integer
 *                           loopbackOnly:
 *                             type: boolean
 *                           service:
 *                             type: string
 *                           label:
 *                             type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/port-conflicts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const claimPorts = getClaimedPorts(slug);
    const { detectPortConflict } = require('../core/port-conflicts');
    const conflicts = [];
    for (const port of claimPorts) {
        conflicts.push(await detectPortConflict(port));
    }
    res.json({ slug, conflicts });
}));

/**
 * @swagger
 * /plugins/{slug}/free-port:
 *   post:
 *     summary: Permanently disable the known system MTA holding a manifest-claimed port (admin-confirmed), then reload the plugin so it can bind it
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
 *             required: [port]
 *             properties:
 *               port:
 *                 type: integer
 *                 description: Must be one of the ports this plugin's manifest declares in claimPorts.
 *               allowDisable:
 *                 type: boolean
 *                 description: >-
 *                   The admin's explicit confirmation, travelling WITH the request. Strictly true or the
 *                   core refuses to disable anything (409 CONSENT_REQUIRED), so a stale client snapshot can
 *                   never turn into an unconsented service disable.
 *     responses:
 *       200:
 *         description: >-
 *           The port was freed, or was already free. A running isolate is reloaded afterwards so the
 *           plugin's own bind logic can take the port right away.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, port, reloaded]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 port:
 *                   type: integer
 *                 freed:
 *                   type: boolean
 *                 alreadyFree:
 *                   type: boolean
 *                 service:
 *                   type: string
 *                 label:
 *                   type: string
 *                 reloaded:
 *                   type: boolean
 *       400:
 *         description: >-
 *           The slug is not a well-formed plugin slug, or the port is not an integer this plugin's manifest
 *           declares in claimPorts. This endpoint is a targeted fix for a declared need, never a generic
 *           service-stopping API.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); or a cookie-authenticated request that failed
 *           the same-origin / double-submit CSRF gate (rest_csrf_invalid, rest_csrf_token).
 *       409:
 *         description: >-
 *           The port cannot be freed as asked. code is CONSENT_REQUIRED (allowDisable was not sent, and
 *           details.conflict carries a fresh look at the occupant so the client can re-prompt) or
 *           PORT_NOT_FREEABLE (the occupant is not a known, disableable system MTA).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 code:
 *                   type: string
 *                 details:
 *                   type: object
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 *       502:
 *         description: >-
 *           The disable ran but the port did not come free (PORT_STILL_IN_USE), or the disable command
 *           itself failed (DISABLE_FAILED).
 */
router.post('/:slug/free-port', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const port = req.body?.port;
    // The port MUST be one the plugin's manifest claims — this endpoint is a targeted fix for a
    // declared need, not a generic service-stopping API (core/port-conflicts additionally only ever
    // touches its known-MTA allowlist).
    if (!Number.isInteger(port) || !getClaimedPorts(slug).includes(port)) {
        return res.status(400).json({ error: 'Port is not declared in this plugin\'s manifest claimPorts.' });
    }
    const { freeClaimedPort } = require('../core/port-conflicts');
    const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
    try {
        // allowDisable = the admin's explicit modal confirmation travels WITH the request. Without it
        // the core refuses to disable anything (CONSENT_REQUIRED below) — so a stale client snapshot
        // can never turn into an unconsented systemctl disable (TOCTOU).
        const result = await freeClaimedPort(port, { allowDisable: req.body?.allowDisable === true });
        // Remembered so the plugins screen can offer to turn it back on once this plugin stops using the port.
        if (result.freed && result.service) {
            try { await require('../core/port-conflicts').recordFreedService(slug, port, result.service, result.label || result.service); }
            catch { /* best effort: the port is freed either way */ }
        }
        // Reload the (running) plugin so its own bind logic can take the freed port right away.
        let reloaded = false;
        if (isIsolated(slug)) {
            try {
                await reloadIsolatedPlugin(slug);
            } catch (reloadErr: any) {
                // The port WAS freed; the restart is what the sandbox refused, and the plugin is stopped.
                const refusal = findSandboxUnavailable(reloadErr);
                if (refusal) {
                    return res.status(409).json(sandboxRefusalBody(refusal, {
                        ...result,
                        message: `Port ${port} was freed, but plugin '${slug}' is now STOPPED: the plugin sandbox refused to restart it. ${refusal.message}`,
                        reloaded: false, stopped: true,
                    }));
                }
                throw reloadErr;
            }
            reloaded = true;
        }
        res.json({ success: true, ...result, reloaded });
    } catch (e: any) {
        // `details` is the one structured field the frontend api() helper preserves on thrown errors —
        // carry the machine-readable code + fresh conflict there so the client can re-prompt consent.
        if (e && e.code === 'CONSENT_REQUIRED') return res.status(409).json({ error: publicErrorText(e, 'Confirmation required before freeing the port.'), code: e.code, details: { code: e.code, conflict: e.conflict } });
        if (e && e.code === 'PORT_NOT_FREEABLE') return res.status(409).json({ error: publicErrorText(e, 'The port could not be freed.'), code: e.code });
        if (e && (e.code === 'PORT_STILL_IN_USE' || e.code === 'DISABLE_FAILED')) return res.status(502).json({ error: publicErrorText(e, 'The port is still in use.'), code: e.code });
        throw e;
    }
}));

/**
 * @swagger
 * /plugins/{slug}/deactivate:
 *   post:
 *     summary: Deactivate a plugin — or clean up an orphaned slug
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
 *         description: >-
 *           Plugin deactivated. For an ORPHANED slug (listed active, or left on disk, with no loadable
 *           files) the response also carries `orphaned: true` and `residueRemoved` — the stale
 *           active_plugins entry is always cleared, and the leftover directory is removed only when it
 *           holds no manifest.json and no entry file (its data/ subdir is preserved either way).
 */
router.post('/:slug/deactivate', authenticate, isAdmin, pluginLifecycleLimiter, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug — and use the VALIDATED value below, never req.params.slug again.
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Is this an ORPHAN rather than a plugin? This route is the ONE door out of that state — the admin
    // UI's "Quitar restos" presses it — so it has to answer for a slug whose files are not loadable.
    // deactivatePlugin() already clears the `active_plugins` entry (it early-returns for a slug that is
    // not listed, which is why the orphan is looked up BEFORE the call, not after), so the extra work
    // here is the RESIDUE on disk: removed only when core proved the directory holds no manifest.json
    // and no entry file, and even then data/ survives (removePluginDirPreservingData).
    const orphan = (await listOrphanedPlugins()).find((o: any) => o.slug === slug) || null;

    const result = await deactivatePlugin(slug);

    let residueRemoved = false;
    if (orphan) {
        if (orphan.residual) {
            try {
                const dir = resolveSafePluginDir(slug);
                if (fs.existsSync(dir)) { removePluginDirPreservingData(dir); residueRemoved = true; }
            } catch (e: any) {
                log.warn({ slug: logSafe(slug), err: e }, `[plugins] residue of orphaned ${logSafe(slug)} could not be removed`);
            }
        }
        await clearOrphanNotice(slug);
    }

    // Trigger frontend registry regeneration
    regenerateRegistry();

    // AUDIT: an admin deactivated a plugin — or reclaimed an orphaned slug, which is a different act
    // (it deletes from disk) and gets its own action name rather than hiding inside 'plugin.deactivate'.
    if (orphan) {
        await recordAudit(req.user && req.user.id, 'plugin.orphan_reclaim', 'plugin', slug, {
            via: 'deactivate', reason: orphan.reason,
            droppedActiveEntry: !!orphan.active, removedResidue: residueRemoved,
        });
    } else {
        await recordAudit(req.user && req.user.id, 'plugin.deactivate', 'plugin', slug, {});
    }

    if (!orphan) return res.json(result);
    res.json({
        ...result,
        orphaned: true,
        residueRemoved,
        message: residueRemoved
            ? `Plugin '${slug}' had no loadable files; its stale entry and leftover directory were removed.`
            : `Plugin '${slug}' had no loadable files; its stale entry was removed.${orphan.hasDirectory ? ' Its directory still holds files and was left untouched — delete the plugin to remove it.' : ''}`,
    });
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
 *         description: Invalid password (rest_bad_current_password — the shared sudo re-auth)
 *       429:
 *         description: Too many simultaneous verifications for this account from this address
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug;
    // Reject a traversal slug (%2f-decoded '../…') BEFORE any fs op — path.join(PLUGINS_DIR, '../../data')
    // would otherwise let an admin confused-deputy rmSync an arbitrary host directory.
    if (!isValidSlug(slug)) {
        return res.status(400).json({ message: 'Invalid plugin slug' });
    }
    const { password } = req.body;
    // Deleting the plugin's data is irreversible, so only a JSON `true` asks for it: "false", "0", [false]
    // or {} are refused rather than read as truthy. Absent = keep the data (the default).
    if (req.body.dropData !== undefined && typeof req.body.dropData !== 'boolean') {
        return res.status(400).json({ message: 'dropData must be true or false.' });
    }
    const dropData = req.body.dropData === true;
    const { isPluginActive, deactivatePlugin, PLUGINS_DIR, uninstallPluginData } = require('../core/plugins');

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    // 0. Verify the password — through THE shared sudo door (routes/users.ts requireSudoPassword), never
    // through the login lockout.
    //
    // THE INVARIANT THIS BROKE: no mutation that a mere cookie can drive may leave the account in a state
    // its owner cannot undo. This door used to verify against `auth.resolveLockIdentifier(req.user.userLogin)`
    // — the RAW /auth/login bucket, with no purpose prefix — and call `auth.recordLoginFail(lockId)` on
    // every miss. So a hijacked admin session, from a single address and without ever knowing the password,
    // could fire a dozen DELETE /plugins/<any slug> (the password check precedes the existence check, so the
    // slug need not even exist) and arm the OWNER'S login lockout: the owner then gets 429
    // rest_account_locked from /auth/login with the CORRECT password, renewable every 15 minutes, with no
    // recovery action available to them. It was strictly worse than the hostage wave 4 removed, because the
    // door it jammed was the front door.
    //
    // Two separate rules, both restated here so the next reader does not have to rediscover them:
    //   · KEY SPACE — an authenticated purpose gets its OWN bucket, keyed by the numeric session identity.
    //     `requireSudoPassword` keys by `Number(req.user.id)` over module-private maps and the `wjsudo:*`
    //     Redis space, disjoint from `wjlock:*`. Nothing derived from a body, a query or a header enters
    //     the key. NEVER call recordLoginFail/resolveLockIdentifier on `req.user.*` outside routes/auth.ts.
    //   · SHAPE — the refusal is a BOUNDED, escalating delay paid before the check, not a lockout: the
    //     correct password always gets in and clears the counter. A re-authentication gate that refuses the
    //     right credential is the hostage, whoever is holding it.
    const { requireSudoPassword } = require('./users');
    if (await requireSudoPassword(req, res, password)) return;

    // 1. Check if active (Async)
    if (await isPluginActive(slug)) {
        return res.status(400).json({ message: 'Cannot delete an active plugin. Deactivate it first.' });
    }

    // 1b. …then UNCONDITIONALLY stop whatever this slug still owns in the isolate layer.
    //
    // Two distinct leftovers have to go, and the check above sees NEITHER of them:
    //
    //   - a REGISTERED child. `active_plugins` is a stored intention; the isolate registry is the
    //     running truth, and they can disagree — a load that failed after registering its child, or a
    //     cross-node/dev-watcher load of a plugin this node never had listed. In that state the check
    //     above passes and this handler would rmSync the directory of a LIVE process still holding this
    //     plugin's hooks, routes and any claimed provider, leaving them wired to code that no longer
    //     exists on disk. "Deactivate it first" is not an option the admin has either: deactivatePlugin
    //     early-returns 'Plugin not active' for precisely this state, so it can only be cleared here.
    //
    //   - a PENDING SUPERVISED RESTART. When a child crashes, its 'exit' handler removes it from the
    //     isolate registry and schedules a backoff restart (superviseRestart, up to 60s). Throughout
    //     that window nothing is registered while a live timer still holds the slug — and that timer is
    //     cancelled ONLY inside unloadIsolatedPlugin. Skipping the call therefore deleted the directory
    //     and left the timer armed: it fires on a deleted entry file, retries up to 5 times and ends in
    //     a "keeps crashing and was stopped" admin notice for a plugin that no longer exists. Worse, if
    //     the slug is REINSTALLED inside that window the stale timer registers an isolate for the NEW
    //     code that no activation asked for.
    //
    // unloadIsolatedPlugin does both (cancel the timer, tear the child down) and is idempotent, so it
    // is called unconditionally.
    //
    // Then VERIFY, and verify the thing that is actually at stake. Deleting the directory is
    // irreversible, so the precondition has to be "no process of ours is running for this slug" — and
    // the registry cannot answer that: unloadIsolatedPlugin removes the entry SYNCHRONOUSLY while
    // `kill(SIGKILL)` is asynchronous, so an `isIsolated()` re-check goes false the instant we ask it to
    // stop, whether or not the signal has landed. awaitIsolateStopped waits (bounded) for BOTH
    // conditions — nothing registered AND every pid we spawned for this slug observed to exit — so the
    // 409 below means a process really is still alive, not that a Map entry lingered.
    const isolate = require('../core/plugin-isolate');
    // Multisite: the code is leaving the NETWORK — stop it on every other site (each site's own
    // deactivation record) and stop offering it, before any of its files go away.
    try {
        await require('../core/plugins').deactivatePluginOnSecondarySites(slug);
        if (require('../core/site-context').multisiteEnabled()) await require('../core/network').clearPluginCeiling(slug);
    } catch (e: any) { log.error({ slug: logSafe(slug), err: e }, `[plugin ${logSafe(slug)}] delete: could not stop it on the other sites: ${logSafe(e && e.message)}`); }
    if (!(await isolate.awaitOtherSitesStopped(slug, DELETE_STOP_TIMEOUT_MS))) {
        return res.status(409).json({ message: `Plugin '${slug}' still runs on another site of the network; nothing was deleted. Try again in a moment.` });
    }
    if (isolate.isIsolated(slug)) {
        log.warn({ slug: logSafe(slug) }, `[plugin ${logSafe(slug)}] delete: a child process is still registered although the plugin is not listed active (orphaned isolate) — stopping it before removing the directory.`);
    }
    try { isolate.unloadIsolatedPlugin(slug); }
    catch (e: any) { log.error({ slug: logSafe(slug), err: e }, `[plugin ${logSafe(slug)}] delete: could not stop the isolate / cancel its pending restart`); }
    //
    // THE WAIT IS BOUNDED, AND THE REFUSAL CAN BE PERMANENT — an accepted trade, new here (main deleted
    // unconditionally). A pid enters the live set at spawn and leaves it in the child's OWN 'exit'
    // handler, so a pid whose exit event never arrives — a host paused/suspended across the child's
    // death, a handler lost to a host-side crash — is never cleared. `livePids` is in-process state, so
    // for that slug awaitIsolateStopped can then never succeed and DELETE answers 409 until the server
    // is restarted. That is why the message below is explicit and names the restart.
    //
    // We take it because the two failure directions are not comparable. Refusing costs a restart and
    // nothing else: the files are still there, and the plugin can be deleted right after. Deleting on a
    // wrong "it's gone" is irreversible and lands on a RUNNING child that still holds this plugin's
    // hooks, routes and any claimed provider — now wired to code that no longer exists on disk. So the
    // check fails SAFE (refuse) rather than open (delete anyway).
    //
    // Bounded, not unbounded, for the same reason: an unbounded wait would hang the admin's request
    // forever in exactly the case that has no resolution, and would still need this 409 to say anything
    // at all — it would only turn a clear refusal into a hang. The escalation is carried by the response
    // instead: it states that nothing was deleted, names the pids we still believe are alive (the same
    // pid an admin can already read from GET /plugins/:slug/status) so they can be checked or killed
    // directly, and gives the restart as the guaranteed way out.
    if (!(await isolate.awaitIsolateStopped(slug, DELETE_STOP_TIMEOUT_MS))) {
        const stuckPids: number[] = (typeof isolate.getLivePids === 'function' && isolate.getLivePids(slug)) || [];
        log.error({ slug: logSafe(slug), stopTimeoutMs: logSafe(DELETE_STOP_TIMEOUT_MS) }, `[plugin ${logSafe(slug)}] delete REFUSED: a child process was still alive ${logSafe(DELETE_STOP_TIMEOUT_MS)}ms after it was told to stop (pid ${logSafe(stuckPids.join(', ') || 'unknown')}) — the plugin directory was left untouched.`);
        return res.status(409).json({
            message: `'${slug}' still has a running process${stuckPids.length ? ` (pid ${stuckPids.join(', ')})` : ''} that did not stop within ${DELETE_STOP_TIMEOUT_MS}ms. Nothing was deleted. End that process, or restart the server, then delete the plugin again.`,
            stillRunning: true,
            pids: stuckPids,
        });
    }

    // 2. Locate directory (resolveSafePluginDir guarantees a proper child of PLUGINS_DIR)
    const pluginPath = resolveSafePluginDir(slug);
    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ message: 'Plugin not found' });
    }

    // The account capabilities the plugin declares, read now: its manifest goes with the directory below,
    // and "delete its data" revokes them from every account (uninstallPluginData).
    let declaredCapabilities: string[] = [];
    try {
        const m = JSON.parse(fs.readFileSync(path.join(pluginPath, 'manifest.json'), 'utf8'));
        if (Array.isArray(m && m.accountCapabilities)) declaredCapabilities = m.accountCapabilities.map((c: any) => String(c && c.slug || '')).filter(Boolean);
    } catch { /* no readable manifest: nothing declared */ }

    // 3. Delete directory recursively — but PRESERVE the plugin's runtime data/ subdir by default,
    // the same WordPress-parity rule the tables follow below: e.g. mail-server's data/.mailenc AES
    // root key must survive an uninstall→reinstall cycle or every stored mail secret becomes
    // permanently undecryptable. `dropData: true` (the admin explicitly asked) removes it too, and
    // installPluginFromZip ADOPTS the residual data/ dir on reinstall.
    try {
        if (dropData) {
            fs.rmSync(pluginPath, { recursive: true, force: true });
        } else {
            removePluginDirPreservingData(pluginPath);
        }

        // Purge the plugin's persisted footprint. ALWAYS clear grants (else a re-uploaded slug inherits
        // old, possibly-revoked grants) + crash strikes; only DROP the plugin's data tables when the
        // admin explicitly asked (dropData) — WordPress-parity: keep data by default on delete.
        const cleanup = await uninstallPluginData(slug, { dropTables: !!dropData, networkWide: true, accountCapabilities: declaredCapabilities });

        // The roles this plugin declared go with it: removed when nobody holds them, otherwise kept as
        // ORPHANED (their holders keep only read/access_admin_panel). Deliberately here and not in
        // uninstallPluginData, which an in-place update also runs — an update must not strip the team.
        try {
            cleanup.roles = await require('../core/roles').releasePluginRoles(slug);
        } catch (e: any) {
            log.warn({ slug: logSafe(slug), err: e }, `[plugin-delete ${logSafe(slug)}] could not release its roles`);
        }

        // Drop the origin binding too. Leaving it behind is not cosmetic: the record says "this slug may
        // only be updated from source X", so a slug re-installed later from somewhere else inherits a
        // stale binding and its updates are refused by assertUpdatableFrom — with no UI to clear it.
        // Best-effort: a delete that already removed the files must not fail on bookkeeping.
        try {
            await require('../core/plugin-origins').removePluginOrigin(slug);
        } catch (e: any) {
            log.warn({ slug: logSafe(slug), err: e }, `[plugin-delete ${logSafe(slug)}] could not clear origin binding`);
        }

        // Regenerate registry to remove traces
        regenerateRegistry();

        await recordAudit(req.user && req.user.id, 'plugin.uninstall', 'plugin', slug, { dropData: !!dropData });
        res.json({ success: true, message: `Plugin ${slug} deleted successfully`, cleanup });
    } catch (err) {
        throw new Error(`Failed to delete plugin: ${err.message}`, { cause: err });
    }
}));

/**
 * @swagger
 * /plugins/{slug}/download:
 *   get:
 *     summary: Download plugin as ZIP
 *     description: >-
 *       The plugin's own files under `<slug>/`. Its top-level data/ folder (runtime state such as
 *       encryption keys and attachments), node_modules/, .git, OS junk and symbolic links are never
 *       included — the same rule the plugin packer stages with.
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
 *         description: A query ticket for this path (POST /auth/query-ticket), for a download opened without the session cookie. A session token is not accepted here.
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
    // Reject a traversal slug BEFORE building a path — without this, '..%2f..%2f..%2fdata/download'
    // decodes to slug='../../../data' and addLocalFolder zips + streams the DB, JWT secret and .env.
    let pluginPath: string;
    try {
        pluginPath = resolveSafePluginDir(slug);
    } catch {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ error: 'Plugin not found' });
    }

    // The plugin's CODE, never its runtime state. `zip.addLocalFolder(pluginPath)` used to archive the
    // whole folder: data/ (mail-server's data/.mailenc — the key to every stored mailbox secret — and
    // its attachments), node_modules/, .git and whatever a symlink pointed at. The file list now comes
    // from the same rule the packer stages with (core/plugin-package-files.ts), and each file is added
    // under `<slug>/` by its relative path.
    const { listPluginPackageFiles } = require('../core/plugin-package-files');
    const zip = new AdmZip();
    for (const rel of listPluginPackageFiles(pluginPath)) {
        zip.addFile(`${slug}/${rel}`, fs.readFileSync(path.join(pluginPath, ...rel.split('/'))));
    }

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
// isAdmin: the admin menu (labels + /admin/* route paths of every active plugin) is control-plane
// metadata — gate it like the rest of this file, not authenticate-only, so a logged-in non-admin
// (e.g. a self-registered subscriber) can't enumerate it or trigger plugin menu filters as itself.
// NOTE: authenticate (NOT isAdmin). This route feeds the sidebar's plugin menu items. Gating it to
// administrators hid EVERY plugin menu item from non-admin admin-panel users (editors, authors,
// subscribers) — so a plugin's per-user UI (e.g. the mail plugin's webmail, whose data routes are
// already scoped per user via findAllByUser / canUserAccess) was unreachable for them. Visibility is
// now per-CAPABILITY: each item is returned only if the caller holds its capability, exactly like the
// frontend's can(item.cap) filter. Items that declare NO capability keep the old admin-only default
// (manage_options), so nothing previously hidden becomes visible unless it opted into a broader cap.
router.get('/menus', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const { getAdminMenuItems } = require('../core/adminMenu');
    const { getActivePlugins } = require('../core/plugins');
    const { applyFiltersSync } = require('../core/hooks');

    const allMenus = getAdminMenuItems();
    // Await async getActivePlugins
    const activePlugins = await getActivePlugins();

    // 1. Filter menus to only include those from active plugins or core
    let activeMenus = allMenus.filter((menu: any) => menu.plugin === 'core' || activePlugins.includes(menu.plugin));

    // 2. Apply filters to allow plugins to hide/modify items per user
    activeMenus = applyFiltersSync('admin_menu_items', activeMenus, { user: req.user });

    // 3. Per-capability visibility. req.user is the host User model (has .can()); unspecified caps
    //    default to manage_options (admin-only) to preserve the prior admin-only behavior.
    const networkAdmin = activeMenus.some((menu: any) => menu.networkAdmin) && require('../core/network-auth').isNetworkAdminRequest(req);
    const visibleMenus = activeMenus.filter((menu: any) => {
        if (menu.networkAdmin && !networkAdmin) return false;
        const requiredCap = menu.cap || menu.capability || 'manage_options';
        return typeof req.user.can === 'function' && req.user.can(requiredCap);
    });

    // 4. Some plugin menu items are only meaningful to an account an administrator granted one of the
    //    plugin's account capabilities (core/account-capabilities.ts) — e.g. a per-account screen that is
    //    an empty shell for anyone else. A plugin marks those items with `requiresAccountCapability:
    //    '<its capability>'` when it registers them (adminMenu.add, which keeps only the plugin's own
    //    namespace), and core hides them from every other non-administrator. Administrators ALWAYS keep
    //    them. The grant read is the SAME one the plugin's route gate reads (req.user.accountCapabilities),
    //    so menu visibility and route access cannot disagree — and it is admin-owned, never derived from
    //    anything the account writes (its email domain used to be read here, which made it self-grantable).
    const isAdmin = typeof req.user.getRole === 'function' && req.user.getRole() === 'administrator';
    const { hasAccountCapability } = require('../core/account-capabilities');
    const finalMenus = isAdmin
        ? visibleMenus
        : visibleMenus.filter((m: any) => !m.requiresAccountCapability || hasAccountCapability(req.user, m.requiresAccountCapability));

    res.json(finalMenus);
}));

// Mount bundle routes for pre-compiled plugin frontends
const bundleRoutes = require('./plugin-bundles');
router.use('/', bundleRoutes);

module.exports = router;
// Exposed for unit tests of the path-traversal guards (the router remains the default export).
module.exports.isValidSlug = isValidSlug;
module.exports.usePluginLifecycleLimiterStore = usePluginLifecycleLimiterStore;
module.exports.createPluginLifecycleLimiter = createPluginLifecycleLimiter;
module.exports.PLUGIN_LIFECYCLE_MAX = PLUGIN_LIFECYCLE_MAX;
module.exports.resolveSafePluginDir = resolveSafePluginDir;
module.exports.safeSlugParam = safeSlugParam;
module.exports.pluginFile = pluginFile;
module.exports.createInstallTmp = createInstallTmp;
module.exports.OS_TMP_DIR = OS_TMP_DIR;
// The shared zip-install pipeline — consumed by routes/marketplace.ts so marketplace installs
// go through the exact same security gauntlet as manual uploads.
module.exports.installPluginFromZip = installPluginFromZip;
// One-click in-place update (marketplace route) + boot-time recovery of an interrupted update (index.ts).
module.exports.runPluginUpdate = runPluginUpdate;
module.exports.recoverInterruptedPluginUpdates = recoverInterruptedPluginUpdates;
// Test seam only: lets registry-regen-node-test.test.ts drive the real function and prove it is inert
// under the runner. Not part of the route surface.
module.exports.__regenerateRegistryForTests = regenerateRegistry;
