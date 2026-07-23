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
                console.log(`⚠️  Script not found: ${script}`);
                continue;
            }

            // SECURITY: Use execFile instead of exec to prevent command injection
            execFile('node', [scriptPath], { env }, (error: Error | null, stdout: string, stderr: string) => {
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
    }).catch((e: any) => console.error('regenerateRegistry: could not resolve active plugins:', e && e.message));
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

/**
 * Move one filesystem entry. rename() is atomic and instant on the same device (plugins/ and os-tmp/
 * are both under the app root, so that is the normal case); the copy+delete fallback covers a bind
 * mount / different device (EXDEV) so an update never fails just because of the layout.
 */
function moveEntry(from: string, to: string) {
    try {
        fs.renameSync(from, to);
    } catch (e: any) {
        if (!e || (e.code !== 'EXDEV' && e.code !== 'EPERM')) throw e;
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

/**
 * Move a plugin's CODE (every top-level entry EXCEPT its runtime data/) into `backupDir`, leaving
 * data/ untouched in place. This is removePluginDirPreservingData's reversible twin: what is left
 * behind is exactly the residual data-only dir installPluginFromZip adopts, and the old version is
 * still on disk so a failed update can be rolled back byte-for-byte.
 */
function stashPluginCode(dir: string, backupDir: string) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const entry of fs.readdirSync(dir)) {
        if (entry === 'data') continue;
        moveEntry(path.join(dir, entry), path.join(backupDir, entry));
    }
}

/**
 * Undo stashPluginCode. `clear` (the post-install rollback) first drops whatever the new version left
 * behind — keeping the preserved data/ — then moves the old code back. Without `clear` (a stash that
 * threw halfway) the entries still in `dir` are the ones that were never moved, so they are KEPT and
 * only the stashed remainder is moved back; a duplicate from a half-finished copy is discarded in
 * favour of the copy that never left the plugin dir.
 */
function restorePluginCode(dir: string, backupDir: string, { clear = true }: { clear?: boolean } = {}) {
    if (clear && fs.existsSync(dir)) removePluginDirPreservingData(dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(backupDir)) {
        const from = path.join(backupDir, entry);
        const to = path.join(dir, entry);
        if (!clear && fs.existsSync(to)) { fs.rmSync(from, { recursive: true, force: true }); continue; }
        moveEntry(from, to);
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
}

/** A plugin's declared version, read from its installed manifest (null when absent/unreadable). */
function readInstalledVersion(dir: string): string | null {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
        return v ? String(v) : null;
    } catch { return null; }
}

/** The permission tokens ("scope:access" / "network") a manifest DECLARES, normalized like the grants. */
function declaredPermissionTokens(dir: string): string[] {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        return Array.from(new Set((manifest.permissions || [])
            .map((p: any) => (p && p.scope) ? (p.scope === 'network' ? 'network' : `${p.scope}:${p.access || 'read'}`) : null)
            .filter(Boolean)
            .map((t: string) => t.toLowerCase()))) as string[];
    } catch { return []; }
}

// The scratch dir the update cycle stashes the OLD version in. Resolved from the CWD at module load,
// exactly like PLUGINS_DIR, so both always refer to the same install root.
const OS_TMP_DIR = path.resolve('os-tmp');
const UPDATE_STASH_PREFIX = 'plugin-update-';

/**
 * MUTUAL EXCLUSION for the whole install / update / uninstall cycle of ONE plugin.
 *
 * The update cycle stashes the plugin's code aside, so for the length of that cycle plugins/<slug>/
 * holds nothing but data/ — which is PRECISELY the shape installPluginFromZip recognizes as "residual
 * data from an uninstall, safe to install over". A second request arriving in that window therefore
 * sees no manifest, takes the plain-install branch, and the two extracts interleave in the same
 * directory; whichever one then rolls back deletes the other's files. A concurrent uninstall is worse
 * still: it removes the half-installed code and purges the grants the update is about to restore.
 *
 * NOT withActivePluginsLock (core/plugins.ts): that lease is global ('wordjs:active-plugins') and,
 * decisively, activatePlugin/deactivatePlugin acquire it THEMSELVES — holding it across an update
 * cycle would self-deadlock on Postgres (the lease is holder-guarded but not re-entrant). This is a
 * separate PER-SLUG lease with a TTL sized for a full cycle (npm install + isolate spawn).
 *
 * Two layers, because they cover different failure modes:
 *   - an in-process Set — on SQLite the dist-lock is a no-op-held (single host by construction), so
 *     this Set IS the mutex for the ordinary single-node install;
 *   - the dist-lock lease — on Postgres/multi-node it stops node B from updating the plugin node A is
 *     mid-swap on (they share the DB, and in monolith/split deploys the plugins dir too).
 *
 * FAIL FAST (409) rather than queue: an admin double-clicking "Update" must be told "already running",
 * not silently start a second full cycle minutes later against a directory that has since changed.
 */
const pluginOpsInFlight = new Set<string>();

type PluginOpLock = { ok: true; release: () => Promise<void> } | { ok: false };

async function acquirePluginOpLock(slug: string): Promise<PluginOpLock> {
    if (pluginOpsInFlight.has(slug)) return { ok: false };
    pluginOpsInFlight.add(slug); // claimed synchronously — before any await, so two concurrent requests can't both pass
    let lease: any = null;
    try {
        const { acquireBlocking } = require('../core/dist-lock');
        // Short timeout = fail fast (but tolerate a lease released microseconds ago); long TTL +
        // heartbeat so a slow cycle is never preempted mid-swap.
        lease = await acquireBlocking(`wordjs:plugin-op:${slug}`, { ttlMs: 120000, renewMs: 30000, timeoutMs: 3000 });
    } catch (e: any) {
        // DB unreachable / pre-boot: degrade to the in-process guard rather than blocking the admin.
        console.warn(`[plugin-op ${slug}] distributed lock unavailable, using the in-process guard only:`, e && e.message);
        lease = null;
    }
    if (lease && !lease.held) {
        pluginOpsInFlight.delete(slug);
        return { ok: false };
    }
    let released = false;
    return {
        ok: true,
        release: async () => {
            if (released) return; // idempotent: several exit paths may release
            released = true;
            pluginOpsInFlight.delete(slug);
            if (lease) { try { await lease.release(); } catch { /* best-effort */ } }
        },
    };
}

/** The 409 payload for "someone else is already touching this plugin". */
function pluginBusyError(slug: string): string {
    return `Another install/update/uninstall of '${slug}' is already running. Wait for it to finish and try again.`;
}

/**
 * Reclaim os-tmp/plugin-update-<slug>-<hex> stashes left behind by an update that never finished
 * (the process was killed between stashPluginCode and the final cleanup). Runs at BOOT, before active
 * plugins load — nothing else ever looks at these directories.
 *
 * Two very different situations share that directory name, and telling them apart is the whole point:
 *   - plugins/<slug>/ has NO manifest → the plugin is GUTTED and the stash holds the ONLY copy of its
 *     code (core/backup.ts excludes os-tmp/, so it is not in the backups either). RESTORE it, with the
 *     same semantics as the rollback path: drop whatever partial extract is there, KEEP data/, move
 *     the old code back. Restoring beats deleting: a wrong delete is unrecoverable.
 *   - plugins/<slug>/ HAS a manifest → the cycle completed (or already rolled back) and only the
 *     cleanup was lost. The stash is stale garbage: remove it.
 * Fully guarded and best-effort: a weird leftover must never stop the server from booting.
 *
 * Each stash is handled under the plugin's operation lock: if a REPLICA boots while another node is
 * mid-update on a shared plugins dir, that node holds the lease and we skip its stash — restoring the
 * old code from under a live update is exactly the corruption this function exists to prevent.
 */
async function recoverInterruptedPluginUpdates(): Promise<{ restored: string[]; discarded: string[] }> {
    const out = { restored: [] as string[], discarded: [] as string[] };
    let entries: string[];
    try {
        if (!fs.existsSync(OS_TMP_DIR)) return out;
        entries = fs.readdirSync(OS_TMP_DIR);
    } catch (e: any) {
        console.warn('[plugin-update] could not scan os-tmp for interrupted updates:', e && e.message);
        return out;
    }
    for (const entry of entries) {
        if (!entry.startsWith(UPDATE_STASH_PREFIX)) continue;
        // Shape: plugin-update-<slug>-<12 hex>. The greedy slug group splits on the LAST hex tail, so a
        // slug containing dashes is parsed correctly. Anything else is not ours — leave it alone.
        const m = /^plugin-update-(.+)-([0-9a-f]{12})$/.exec(entry);
        if (!m || !isValidSlug(m[1])) continue;
        const slug = m[1];
        const stashDir = path.join(OS_TMP_DIR, entry);
        const lock = await acquirePluginOpLock(slug);
        if (!lock.ok) {
            console.warn(`[plugin-update] skipping ${entry}: an install/update of '${slug}' is running elsewhere.`);
            continue;
        }
        try {
            if (!fs.statSync(stashDir).isDirectory()) continue;
            const pluginDir = resolveSafePluginDir(slug); // throws on anything that isn't a proper child
            const gutted = !fs.existsSync(path.join(pluginDir, 'manifest.json'));
            if (gutted) {
                // Restore whatever the stash holds, even if the kill landed mid-stash and it is
                // incomplete: the plugin dir has no manifest either way, so restoring can only ever
                // gain files back, while deleting is final.
                restorePluginCode(pluginDir, stashDir); // clear:true — a partial new extract must not survive
                out.restored.push(slug);
                console.warn(`[plugin-update] recovered '${slug}' from an interrupted update (code restored from ${entry}).`);
                if (!fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
                    console.error(`[plugin-update] '${slug}' still has no manifest.json after recovery — reinstall it from the marketplace.`);
                }
            } else {
                fs.rmSync(stashDir, { recursive: true, force: true });
                out.discarded.push(slug);
            }
        } catch (e: any) {
            console.error(`[plugin-update] could not recover ${entry}:`, e && e.message);
        } finally {
            await lock.release();
        }
    }
    return out;
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

// Strict plugin-slug charset. A slug is a SINGLE path segment (starts alnum, then alnum/dash/underscore,
// max 64) — so it can never be '.', '..', a separator, or resolve to a parent/other directory.
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isValidSlug(slug: any): boolean {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

// The SINGLE choke point every slug-derived fs op must go through (download / delete / extract-install).
// Resolves an untrusted slug to its plugin dir or THROWS (400), guaranteeing the result is a proper CHILD
// of PLUGINS_DIR — never PLUGINS_DIR itself (which would let a failure-path rmSync wipe every plugin) or
// an ancestor (which a crafted '..' filename / './'-prefixed zip entry could otherwise reach).
function resolveSafePluginDir(slug: any): string {
    if (!isValidSlug(slug)) {
        const e: any = new Error(`Invalid plugin slug: ${JSON.stringify(slug)}`);
        e.status = 400;
        throw e;
    }
    const base = path.resolve(PLUGINS_DIR);
    const dir = path.resolve(base, slug);
    if (dir === base || !dir.startsWith(base + path.sep)) {
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
    const result = await installPluginFromZip(req.file.path, req.file.originalname);
    res.status(result.status).json(result.body);
}));

/**
 * Shared plugin-zip install pipeline — the SINGLE implementation of every security check
 * (zip bomb, Zip Slip, slug validation, squat/clobber refusal, manifest + AST validation),
 * used by BOTH the direct upload above and the marketplace installer (routes/marketplace.ts).
 * Always deletes zipPath before returning. Expected failures come back as { ok:false, status, body }
 * rather than throwing, so callers map them straight onto the HTTP response.
 *
 * `opts.expectedSlug` pins the slug the package must install as. The UPDATE path depends on it: it
 * has already stashed <slug>'s code aside, so a zip whose root folder is a DIFFERENT slug would
 * install some other plugin and leave the one being updated gutted. Callers that know which plugin
 * they asked for (the marketplace: catalog id === folder slug) always pass it.
 *
 * `opts.holdsPluginLock` says the caller ALREADY holds this slug's operation lock (only the update
 * cycle does — its lock must span the stash window, and the lease is not re-entrant).
 *
 * `opts.origin` is the catalog source the package came from; it is recorded on success and is what
 * later authorizes a catalog entry to REPLACE this code. A manual upload passes none — deliberately:
 * an uploaded zip has no publisher to bind to, so it can never be updated from a catalog.
 */
async function installPluginFromZip(
    zipPath: string,
    originalName: string,
    opts: { expectedSlug?: string; holdsPluginLock?: boolean; origin?: { source: string; catalogId?: string } } = {},
): Promise<{ ok: boolean; status: number; body: any }> {
    // Released in the finally below — every early return inside the try must free it too.
    let releasePluginLock: (() => Promise<void>) | null = null;
    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // SECURITY: reject a decompression bomb BEFORE extracting (multer only capped the compressed
        // upload — a ~10MB DEFLATE stream can expand to many GB and fill the disk).
        try {
            assertZipWithinBudget(zipEntries, { kind: 'plugin' });
        } catch (e: any) {
            fs.unlinkSync(zipPath);
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
            fs.unlinkSync(zipPath);
            return { ok: false, status: 400, body: { error: 'Zip contains no plugin files.' } };
        }

        // First path segment of every CONTENT entry (normalize backslashes). Reject '.'/'..' tokens
        // outright — adm-zip preserves a leading './', and split('/')[0] would otherwise yield '.'.
        const rootDirs = new Set<string>();
        for (const e of contentEntries) {
            const first = String(e.entryName).replace(/\\/g, '/').split('/')[0];
            if (!first) continue;
            if (first === '.' || first === '..') {
                fs.unlinkSync(zipPath);
                return { ok: false, status: 400, body: { error: 'Malicious zip: entry names contain "." / ".." path segments.' } };
            }
            rootDirs.add(first);
        }

        const singleRoot = rootDirs.size === 1;
        const intendedSlug = (singleRoot ? Array.from(rootDirs)[0] : zipName) as string;
        if (!isValidSlug(intendedSlug)) {
            fs.unlinkSync(zipPath);
            return { ok: false, status: 400, body: { error: `Refused: '${intendedSlug}' is not a valid plugin folder name (expected a single [A-Za-z0-9_-] segment, no dots or separators).` } };
        }
        // The caller asked for a SPECIFIC plugin (see opts.expectedSlug above) — refuse a package that
        // would land anywhere else, BEFORE a single byte is extracted.
        if (opts.expectedSlug && intendedSlug !== opts.expectedSlug) {
            fs.unlinkSync(zipPath);
            return { ok: false, status: 400, body: { error: `Refused: the package installs plugin '${intendedSlug}' but '${opts.expectedSlug}' was requested.` } };
        }
        // From here on every step READS plugins/<slug> and then WRITES it (squat scan, refuse-if-exists,
        // extract, validate, undo). Serialize that against any other operation on the same slug —
        // otherwise a concurrent update's stash window makes the "is there already a plugin here?"
        // checks below answer about a directory that is being emptied out from under us.
        if (!opts.holdsPluginLock) {
            const lock = await acquirePluginOpLock(intendedSlug);
            if (!lock.ok) {
                fs.unlinkSync(zipPath);
                return { ok: false, status: 409, body: { error: pluginBusyError(intendedSlug), busy: true } };
            }
            releasePluginLock = lock.release;
        }

        // Guaranteed a proper CHILD of PLUGINS_DIR (throws otherwise). In BOTH shapes the plugin's files
        // must land under installedDir: single-root entries carry the '<slug>/' prefix and extract to
        // PLUGINS_DIR; files-at-root extract into installedDir. Confinement is checked against installedDir
        // either way — so cross-plugin overwrite (my-plugin/../victim/evil.js) is blocked by CONTAINMENT,
        // not merely by a '..' substring heuristic.
        const installedDir = resolveSafePluginDir(intendedSlug);
        const targetDir = singleRoot ? PLUGINS_DIR : installedDir;
        const confineDir = path.resolve(installedDir);

        // SECURITY: Zip Slip — every content entry must resolve INSIDE the plugin's own dir. Segment-level
        // '..' check (a filename that merely embeds '..' like 'a..b.min.js' is legitimate and allowed).
        for (const entry of contentEntries) {
            const rel = String(entry.entryName).replace(/\\/g, '/');
            const dest = path.resolve(targetDir, rel);
            const isContained = dest === confineDir || dest.startsWith(confineDir + path.sep);
            const hasDotDotSegment = rel.split('/').includes('..');
            if (!isContained || hasDotDotSegment) {
                fs.unlinkSync(zipPath);
                return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip / path traversal)' } };
            }
        }

        // SECURITY: an uploaded plugin must NOT claim a reserved system-plugin slug (empty list by default)
        // nor clobber an existing plugin by case/Unicode variant. Canonicalize for comparison.
        const canonSlug = String(intendedSlug).normalize('NFC').toLowerCase();
        const RESERVED_SLUGS: string[] = [];
        if (RESERVED_SLUGS.some(s => String(s).normalize('NFC').toLowerCase() === canonSlug)) {
            fs.unlinkSync(zipPath);
            return { ok: false, status: 409, body: { error: `Refused: '${intendedSlug}' is a reserved system plugin slug and cannot be uploaded or overwritten.` } };
        }
        try {
            const clash = fs.readdirSync(PLUGINS_DIR).find((d: string) => d !== intendedSlug && d.normalize('NFC').toLowerCase() === canonSlug);
            if (clash) {
                fs.unlinkSync(zipPath);
                return { ok: false, status: 409, body: { error: `Refused: name collides with existing plugin '${clash}' (case/Unicode squat).` } };
            }
        } catch { /* PLUGINS_DIR missing — nothing to clobber */ }

        // INTEGRITY: refuse to overwrite a RUNNING plugin's code in place — a botched extract would
        // corrupt a working plugin and the next reload would swap live code with no warning.
        if (await isPluginActive(intendedSlug)) {
            fs.unlinkSync(zipPath);
            return { ok: false, status: 409, body: { error: `Plugin '${intendedSlug}' is currently active. Deactivate it before re-uploading (this prevents corrupting a running plugin).` } };
        }

        // INTEGRITY: refuse to install over an EXISTING (even inactive) plugin directory. The extract
        // overwrites in place and, if post-extract validation fails, the catch below rmSync's the whole
        // dir — which would destroy a legitimate same-named plugin's files that were there first (audit
        // LOW). To update a plugin, remove the old one first (uninstall), then install.
        //
        // EXCEPTION — residual runtime data: uninstall preserves plugins/<slug>/data/ (encryption keys,
        // attachments — see removePluginDirPreservingData). A dir containing NOTHING but data/ is not a
        // plugin (no manifest, no code); adopt it and extract around it so reinstall reconnects with the
        // preserved state instead of 409ing.
        let hadResidualData = false;
        if (fs.existsSync(installedDir)) {
            let residualOnly = false;
            try {
                residualOnly = fs.readdirSync(installedDir).every((e: string) => e === 'data');
            } catch { /* unreadable → treat as a real plugin and refuse */ }
            if (!residualOnly) {
                fs.unlinkSync(zipPath);
                return { ok: false, status: 409, body: { error: `A plugin directory '${intendedSlug}' already exists. Uninstall it before installing this one (this prevents overwriting or deleting an existing plugin).` } };
            }
            hadResidualData = fs.existsSync(path.join(installedDir, 'data'));
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
                fs.unlinkSync(zipPath);
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
            // Static AST scan (also re-runs at activation for defense in depth).
            validatePluginPermissions(pluginSlug, installedDir, manifest);
        } catch (valErr: any) {
            // Failed validation → undo the extract. If we ADOPTED residual data, restore the residual
            // state (data/ survives, extracted files go); otherwise remove the whole dir as before —
            // a rejected zip must never leave lingering files behind.
            try {
                if (hadResidualData) removePluginDirPreservingData(installedDir);
                else fs.rmSync(installedDir, { recursive: true, force: true });
            } catch { /* best-effort */ }
            fs.unlinkSync(zipPath);
            return { ok: false, status: 400, body: { error: valErr.message, details: { missingPermissions: valErr.missingPermissions, dangerousCalls: valErr.dangerousCalls } } };
        }

        // Cleanup temp file
        fs.unlinkSync(zipPath);

        // Bind the code to WHERE it came from, while the slug lock is still held: recording it after
        // the release would race a concurrent uninstall (which clears origins) and could leave a
        // catalog provenance attached to a slug the admin has just removed — the next manual upload of
        // that slug would then inherit it, which is exactly what provenance exists to prevent.
        if (opts.origin && opts.origin.source) {
            try {
                await require('../core/plugins').setPluginOrigin(pluginSlug, {
                    source: opts.origin.source,
                    catalogId: opts.origin.catalogId || pluginSlug,
                    version: readInstalledVersion(installedDir),
                });
            } catch (e: any) {
                console.warn(`[install ${pluginSlug}] could not record the install origin (it will not be updatable from the catalog):`, e && e.message);
            }
        }

        return { ok: true, status: 200, body: { success: true, message: 'Plugin installed successfully', slug: pluginSlug } };
    } catch (error: any) {
        // Cleanup temp file on error
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        return { ok: false, status: 500, body: { error: `Failed to install plugin: ${error.message}` } };
    } finally {
        // Free the slug for the next operation on EVERY exit path (success, refusal or throw) —
        // a leaked lease would 409 every later install of this plugin until the TTL expired.
        if (releasePluginLock) await releasePluginLock();
    }
}

/**
 * IN-PLACE UPDATE of an already-installed plugin — the one-click "Actualizar a vX" path.
 *
 * installPluginFromZip deliberately refuses to overwrite a plugin (409 "is currently active" / 409
 * "already exists"): a botched extract must never corrupt a working install. That makes it a
 * dead end for updates, so this function performs the full cycle around it, preserving everything
 * the admin and the plugin own:
 *
 *   remember active state + permission grants + egress list
 *     → deactivate (unloads the isolate; nothing is running while the files move)
 *     → stash the OLD code aside, KEEPING plugins/<slug>/data/ (encryption keys, attachments…)
 *     → uninstallPluginData(dropTables:false) — clears the old version's grants/strikes/enqueued
 *       assets but KEEPS every wjp_<slug>_* table (mailboxes, DKIM keys… survive the update)
 *     → install the new version, which ADOPTS the preserved data/
 *     → restore the grants/egress the admin had approved, then reactivate if it was active.
 *
 * FAIL-SAFE: the stashed old version stays on disk until the new one is installed AND (if it was
 * running) reactivated. Any failure along the way rolls the code back, restores the grants and
 * reactivates the old version — so a bad package leaves the site exactly as it found it. A plugin
 * that migrated its own tables during a failed init is the one thing no rollback can undo; the
 * activation error is surfaced verbatim so the admin sees why.
 *
 * NOTHING is auto-granted (default-deny: a catalog update must never widen its own access silently).
 * Two DIFFERENT facts come back for the UI, and conflating them misleads the admin:
 *   - `newPermissions` — tokens the new manifest declares that the PREVIOUS version did not. This is
 *     the "does this update widen what it asks for?" answer, so it is diffed against the old manifest
 *     (snapshotted before its code is stashed), NOT against the grants: a permission the admin
 *     deliberately REFUSED is still declared by both versions and must not be reported as new;
 *   - `ungrantedPermissions` — everything the new version declares and still cannot use (the newly
 *     declared ones plus anything previously refused). That is the "approve these in Instalados" list.
 *
 * PROVENANCE IS MANDATORY. `opts.origin` names where the replacement package comes from, and the code
 * of an installed plugin may only be replaced by the origin it was INSTALLED from (see the gate in
 * runPluginUpdate). Never relax that: this function replays the admin's grants onto whatever code it
 * is handed and gives it the plugin's preserved data/ dir.
 */
async function updatePluginFromZip(
    zipPath: string,
    originalName: string,
    slug: string,
    opts: { origin?: { source: string; catalogId?: string } } = {},
): Promise<{ ok: boolean; status: number; body: any }> {
    let installedDir: string;
    try {
        installedDir = resolveSafePluginDir(slug);
    } catch (e: any) {
        try { fs.unlinkSync(zipPath); } catch { /* best-effort */ }
        return { ok: false, status: e.status || 400, body: { error: e.message } };
    }

    // Hold the slug for the WHOLE cycle. It must be taken before the "is it installed?" test below,
    // because the answer is exactly what a concurrent update's stash window falsifies (see
    // acquirePluginOpLock): mid-stash the dir looks like an uninstalled plugin with residual data.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        try { fs.unlinkSync(zipPath); } catch { /* best-effort */ }
        return { ok: false, status: 409, body: { error: pluginBusyError(slug), busy: true } };
    }
    try {
        return await runPluginUpdate(zipPath, originalName, slug, installedDir, opts);
    } finally {
        await lock.release();
    }
}

/** The update cycle itself. PRECONDITION: the caller holds `slug`'s operation lock. */
async function runPluginUpdate(
    zipPath: string,
    originalName: string,
    slug: string,
    installedDir: string,
    opts: { origin?: { source: string; catalogId?: string } },
): Promise<{ ok: boolean; status: number; body: any }> {
    const crypto = require('crypto');
    const {
        isPluginActive, deactivatePlugin, activatePlugin, uninstallPluginData,
        getPluginOrigin, setPluginOrigin, normalizeOriginSource,
    } = require('../core/plugins');
    const { getGrants, setGrants, getEgressAllowlist, setEgressAllowlist } = require('../core/plugin-permissions');

    /** Refuse before anything on disk has been touched: drop the temp zip and answer. */
    const refuse = (status: number, error: string, extra: any = {}) => {
        try { fs.unlinkSync(zipPath); } catch { /* best-effort */ }
        return { ok: false, status, body: { error, ...extra } };
    };

    // Not actually installed (absent, or only the residual data-only dir a previous uninstall left):
    // a plain install is already the right thing — it adopts the preserved data/. It also starts from
    // ZERO grants (uninstall purged them), so there is no provenance decision to make here; we just
    // record where the code came from, exactly like a first-time marketplace install.
    if (!fs.existsSync(path.join(installedDir, 'manifest.json'))) {
        return installPluginFromZip(zipPath, originalName, { expectedSlug: slug, holdsPluginLock: true, origin: opts.origin });
    }

    // ---- PROVENANCE GATE (security blocker) -------------------------------------------------------
    // An update REPLAYS the admin's grants — `network` and the egress allowlist included, and those are
    // read from the grant map alone, NOT re-gated by the new manifest — onto whatever code this zip
    // contains, and hands it the preserved plugins/<slug>/data/ dir (for mail-server: the AES root key
    // and the DKIM private keys). Deciding "this is an update" from the SLUG alone would therefore let
    // ANY catalog source that lists the same id take over an installed plugin, with all its approved
    // permissions and its secrets. So: code may only be replaced by the origin it was installed from.
    //
    // Checked here rather than at the route so every caller is covered, and INSIDE the lock so the
    // recorded origin can't change between the check and the swap.
    const wantSource = normalizeOriginSource(opts.origin && opts.origin.source);
    if (!wantSource) {
        return refuse(400, `Refusing to update '${slug}': the caller did not identify where the replacement package comes from. An update may only be applied by the source the plugin was installed from.`, { originMismatch: true });
    }
    const recordedOrigin = await getPluginOrigin(slug);
    if (!recordedOrigin) {
        // No origin on record: a manually uploaded plugin, or one installed before provenance was
        // recorded. Refusing is the POINT — grandfathering would restore exactly the silent-takeover
        // hole. The safe adoption path is uninstall (data is kept) + install from the catalog, which
        // also resets the grants to default-deny so nothing is inherited by unvetted code.
        return refuse(409, `Refusing to update '${slug}': WordJS has no record of where it was installed from (it was uploaded manually, or installed before install origins were recorded). Uninstall it — its data and tables are kept — and install it from the catalog to bind it to a source. Its permissions then start from default-deny.`, { originMismatch: true, recordedOrigin: null });
    }
    if (recordedOrigin.source !== wantSource) {
        return refuse(409, `Refusing to update '${slug}': it was installed from ${recordedOrigin.source}, but this package comes from ${wantSource}. A catalog entry may only update the plugin IT installed — sharing a slug is not an identity.`, { originMismatch: true, recordedOrigin: recordedOrigin.source, packageOrigin: wantSource });
    }

    const fromVersion = readInstalledVersion(installedDir);
    // What the version being REPLACED declared — read while its manifest is still in place (the stash
    // below moves it to backupDir, and the successful path deletes that stash). It is the baseline for
    // `newPermissions`: without it "new" can only be computed against the GRANTS, which reports every
    // permission the admin deliberately refused as if this version had just added it.
    const previousPermissions = declaredPermissionTokens(installedDir);
    const wasActive = await isPluginActive(slug);
    // The admin's permission decisions (and the plugin's provenance) belong to the PLUGIN, not to the
    // copy on disk — snapshot them so uninstallPluginData's (correct, for a real uninstall) purge
    // doesn't silently revoke everything the admin approved just because they clicked Update.
    const grants: string[] = getGrants(slug);
    const egress: string[] = getEgressAllowlist(slug);
    const restoreAdminState = async () => {
        try { await setGrants(slug, grants); } catch (e: any) { console.warn(`[update ${slug}] restoring grants failed:`, e && e.message); }
        try { await setEgressAllowlist(slug, egress); } catch (e: any) { console.warn(`[update ${slug}] restoring egress allowlist failed:`, e && e.message); }
        try { await setPluginOrigin(slug, { source: recordedOrigin.source, catalogId: recordedOrigin.catalogId, version: recordedOrigin.version }); }
        catch (e: any) { console.warn(`[update ${slug}] restoring install origin failed:`, e && e.message); }
    };

    // Same dir + name shape the boot sweep looks for (recoverInterruptedPluginUpdates), so a stash the
    // process is killed on top of is recognized and reclaimed on the next start.
    const backupDir = path.join(OS_TMP_DIR, `${UPDATE_STASH_PREFIX}${slug}-${crypto.randomBytes(6).toString('hex')}`);
    try {
        // prune:false — the plugin is coming right back, so its npm dependencies must NOT be
        // uninstalled in between (see deactivatePlugin: a prune+reinstall round trip can strand a
        // plugin whose declared range no longer resolves, and the rollback can't rescue it either).
        if (wasActive) await deactivatePlugin(slug, { prune: false });
        stashPluginCode(installedDir, backupDir);
    } catch (e: any) {
        // Nothing has been replaced yet. Put back whatever was moved and leave the site as it was.
        if (fs.existsSync(backupDir)) { try { restorePluginCode(installedDir, backupDir, { clear: false }); } catch { /* best-effort */ } }
        try { fs.unlinkSync(zipPath); } catch { /* best-effort */ }
        if (wasActive) { try { await activatePlugin(slug); } catch { /* reported below */ } }
        return { ok: false, status: 500, body: { error: `Could not prepare the update of '${slug}': ${e.message}` } };
    }

    // Old version's persisted footprint: grants/strikes/assets go, its DATA TABLES stay.
    await uninstallPluginData(slug, { dropTables: false });

    const rollback = async (reason: string, status: number, body: any) => {
        // FIRST: make sure the FAILED new version is not still running. activatePlugin can throw AFTER
        // loadIsolatedPlugin already registered the isolate (isolates.set) — the active_plugins write or
        // the 'activated_plugin' hook can fail — and the plugin is then NOT in active_plugins, so
        // deactivatePlugin() alone early-returns 'Plugin not active' and leaves that child alive.
        // Reactivating the old version below would spawn a SECOND child and overwrite isolates[slug];
        // the orphan's 'exit' handler then sees wasCurrent === false and SKIPS teardown, so its hooks,
        // routes and any claimed provider (the system mail sender!) stay wired to a process nobody
        // supervises. unloadIsolatedPlugin is idempotent and runs teardown, so call it unconditionally
        // after deactivatePlugin (which covers the case where the flag DID get written).
        try { await deactivatePlugin(slug, { prune: false }); }
        catch (e: any) { console.warn(`[update ${slug}] deactivating the failed version:`, e && e.message); }
        try { require('../core/plugin-isolate').unloadIsolatedPlugin(slug); }
        catch (e: any) { console.warn(`[update ${slug}] unloading the failed isolate:`, e && e.message); }
        try { restorePluginCode(installedDir, backupDir); } catch (e: any) { console.error(`[update ${slug}] ROLLBACK FAILED:`, e && e.message); }
        await restoreAdminState();
        let reactivated = false;
        if (wasActive) {
            try { await activatePlugin(slug); reactivated = true; }
            catch (e: any) { console.error(`[update ${slug}] could not reactivate the restored version:`, e && e.message); }
        }
        regenerateRegistry();
        const tail = wasActive
            ? (reactivated ? ' and reactivated' : ' but could NOT be reactivated — check Plugins')
            : '';
        return {
            ok: false,
            status,
            body: {
                ...body,
                error: `${reason} — v${fromVersion || '?'} was restored${tail}.`,
                rolledBack: true,
                restoredVersion: fromVersion,
                reactivated,
            },
        };
    };

    // holdsPluginLock: we already own this slug's lease for the whole cycle (it is not re-entrant).
    const result = await installPluginFromZip(zipPath, originalName, { expectedSlug: slug, holdsPluginLock: true });
    if (!result.ok) {
        return rollback(String((result.body && result.body.error) || 'The update failed'), result.status, result.body);
    }

    // Installed. Restore the admin's grants BEFORE reactivating: the network grant and the egress
    // allowlist are pushed into the isolate's cfg at SPAWN time, so a plugin activated without them
    // would come up with no network until the next reload.
    await restoreAdminState();

    const toVersion = readInstalledVersion(installedDir);
    // The two facts the admin needs, kept apart (see the header): what this version ADDED to what it
    // asks for, and what it asks for but cannot use. A refused permission stays refused and is NOT
    // "new" just because it is still ungranted — that misread is exactly what an admin would be
    // judging "did this update widen its access?" on.
    const declaredNow = declaredPermissionTokens(installedDir);
    const newPermissions = declaredNow.filter((t) => !previousPermissions.includes(t));
    const ungrantedPermissions = declaredNow.filter((t) => !grants.includes(t));

    let reactivated = false;
    let activationError: string | null = null;
    if (wasActive) {
        try { await activatePlugin(slug); reactivated = true; }
        catch (e: any) { activationError = (e && e.message) || String(e); }
    }
    if (wasActive && !reactivated) {
        // The new version installed but cannot run. Ending here would leave a site whose plugin is
        // simply down, so put the version that WAS working back (its stash is still on disk).
        return rollback(`v${toVersion || '?'} installed but failed to activate: ${activationError}`, 502, { activationError });
    }

    // The update is now IRREVERSIBLE (installed, grants restored, running) — everything below is
    // bookkeeping and must not be able to turn a successful update into an error response.

    // Re-record the provenance uninstallPluginData cleared, now pointing at the version on disk.
    try { await setPluginOrigin(slug, { source: recordedOrigin.source, catalogId: recordedOrigin.catalogId, version: toVersion }); }
    catch (e: any) { console.warn(`[update ${slug}] could not re-record the install origin:`, e && e.message); }

    // force:true only swallows ENOENT — on Windows an AV scanner or the search indexer holding a
    // handle raises EBUSY/EPERM. An uncaught throw here would skip regenerateRegistry() below and
    // report a 500 for an update that actually worked, inviting the admin to run the whole cycle
    // again. Log it and continue; the boot sweep (recoverInterruptedPluginUpdates) sees a plugin dir
    // with a manifest and discards the leftover stash on the next start.
    try { fs.rmSync(backupDir, { recursive: true, force: true }); }
    catch (e: any) { console.warn(`[update ${slug}] could not remove the backup stash ${backupDir} (it will be reclaimed at next boot):`, e && e.message); }
    regenerateRegistry();

    return {
        ok: true,
        status: 200,
        body: {
            success: true,
            updated: true,
            slug,
            fromVersion,
            version: toVersion,
            wasActive,
            reactivated,
            newPermissions,
            ungrantedPermissions,
            message: `Plugin '${slug}' updated${fromVersion ? ` from v${fromVersion}` : ''}${toVersion ? ` to v${toVersion}` : ''}`
                + `${reactivated ? ' and reactivated' : ''} — data preserved.`,
        },
    };
}

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
    const { THEMES_DIR } = require('../core/themes');
    res.json(plugins.map((p: any) => {
        const requested = Array.from(new Set((p.permissions || [])
            .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
            .filter(Boolean)));
        // Companion theme (option B): does this plugin bundle a theme/, and is it installed already?
        // lstat (not stat) so a symlinked theme/ reads as "no theme" — install-theme refuses it anyway.
        let hasTheme = false;
        try { hasTheme = fs.lstatSync(path.join(PLUGINS_DIR, p.slug, 'theme')).isDirectory(); } catch { /* none */ }
        return {
            ...p,
            requestedPermissions: requested,
            grantedPermissions: getGrants(p.slug),
            runtime: p.active ? (getIsolateStatus(p.slug) || null) : null,
            hasTheme,
            themeInstalled: hasTheme && fs.existsSync(path.join(THEMES_DIR, `${p.slug}-theme`)),
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
 * /plugins/{slug}/egress-hosts:
 *   get:
 *     summary: Get a plugin's egress allowlist (admin). Only meaningful for a network-granted plugin.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     summary: Set a plugin's egress allowlist (admin). Empty = allow all public hosts; non-empty = default-deny except listed hosts + their subdomains.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/:slug/egress-hosts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    if (!validateSlug(req.params.slug as string)) return res.status(400).json({ error: 'Invalid plugin slug' });
    const slug = req.params.slug;
    const { getEgressAllowlist, getGrants } = require('../core/plugin-permissions');
    res.json({ slug, hosts: getEgressAllowlist(slug), network: getGrants(slug).includes('network') });
}));

router.post('/:slug/egress-hosts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    if (!validateSlug(req.params.slug as string)) return res.status(400).json({ error: 'Invalid plugin slug' });
    const slug = req.params.slug;
    const { setEgressAllowlist, getEgressAllowlist } = require('../core/plugin-permissions');
    // Body: { hosts: ["api.stripe.com", "*.example.com", ...] }. Invalid entries (schemes/paths/ports) are
    // dropped by setEgressAllowlist. An empty array clears the list (back to allow-all-public).
    const body = req.body || {};
    const hosts: string[] = Array.isArray(body.hosts) ? body.hosts.map((h: any) => String(h)) : [];
    await setEgressAllowlist(slug, hosts);

    // Re-spawn the isolate so the child re-installs the new allowlist (pushed in cfg → egress-guard.setAllowedHosts).
    let reloaded = false;
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
    } catch (e: any) {
        console.warn(`[EgressHosts] reload of '${slug}' after egress change failed:`, e && e.message);
    }

    const saved = getEgressAllowlist(slug);
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
router.post('/:slug/install-theme', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    // Throws 400 on any traversal-shaped slug BEFORE any fs op (single choke point).
    const pluginDir = resolveSafePluginDir(req.params.slug);
    const slug = req.params.slug as string;
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
        const manifestPath = path.join(PLUGINS_DIR, slug, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(manifest.claimPorts)) return [];
        return manifest.claimPorts.filter((p: any) => Number.isInteger(p) && p > 0 && p < 65536);
    } catch {
        return [];
    }
}

/**
 * @swagger
 * /plugins/{slug}/port-conflicts:
 *   get:
 *     summary: Who is squatting the ports this plugin's manifest claims, and can WordJS free them?
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 */
router.get('/:slug/port-conflicts', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const slug = req.params.slug as string;
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
 */
router.post('/:slug/free-port', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    if (!validateSlug(req.params.slug as string)) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const slug = req.params.slug as string;
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
        // Reload the (running) plugin so its own bind logic can take the freed port right away.
        let reloaded = false;
        if (isIsolated(slug)) {
            await reloadIsolatedPlugin(slug);
            reloaded = true;
        }
        res.json({ success: true, ...result, reloaded });
    } catch (e: any) {
        // `details` is the one structured field the frontend api() helper preserves on thrown errors —
        // carry the machine-readable code + fresh conflict there so the client can re-prompt consent.
        if (e && e.code === 'CONSENT_REQUIRED') return res.status(409).json({ error: e.message, code: e.code, details: { code: e.code, conflict: e.conflict } });
        if (e && e.code === 'PORT_NOT_FREEABLE') return res.status(409).json({ error: e.message, code: e.code });
        if (e && (e.code === 'PORT_STILL_IN_USE' || e.code === 'DISABLE_FAILED')) return res.status(502).json({ error: e.message, code: e.code });
        throw e;
    }
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
    // Reject a traversal slug (%2f-decoded '../…') BEFORE any fs op — path.join(PLUGINS_DIR, '../../data')
    // would otherwise let an admin confused-deputy rmSync an arbitrary host directory.
    if (!isValidSlug(slug)) {
        return res.status(400).json({ message: 'Invalid plugin slug' });
    }
    const { password, dropData } = req.body;
    const { isPluginActive, deactivatePlugin, PLUGINS_DIR, uninstallPluginData } = require('../core/plugins');
    const User = require('../models/User');

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    // 0. Verify password — gated by the SAME shared per-account lockout as /auth/login, so a hijacked admin
    // session can't brute-force the password unthrottled (only the loose apiLimiter applies) (audit #26 —
    // unthrottled password oracle). req.user is populated by authenticate middleware. This path is
    // authenticated/session-scoped, so RECORDING failures here throttles the oracle without the
    // unauthenticated-lockout-DoS of #25.
    const auth = require('./auth');
    const lockId = await auth.resolveLockIdentifier(req.user.userLogin);
    if (await auth.isLoginLocked(lockId)) {
        return res.status(429).json({ message: 'Too many failed attempts. Try again later.' });
    }
    try {
        await User.authenticate(req.user.userLogin, password);
        await auth.clearLoginFails(lockId);
    } catch (error) {
        await auth.recordLoginFail(lockId);
        return res.status(403).json({ message: 'Invalid password' });
    }

    // Serialize against an install/update of the same slug. Without this, deleting a plugin that is
    // mid-update wipes the half-installed code and purges the grants the update is about to restore,
    // and the update then "rolls back" into a directory the admin asked to be gone.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        // 1. Check if active (Async)
        if (await isPluginActive(slug)) {
            return res.status(400).json({ message: 'Cannot delete an active plugin. Deactivate it first.' });
        }

        // 2. Locate directory (resolveSafePluginDir guarantees a proper child of PLUGINS_DIR)
        const pluginPath = resolveSafePluginDir(slug);
        if (!fs.existsSync(pluginPath)) {
            return res.status(404).json({ message: 'Plugin not found' });
        }

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
            // old, possibly-revoked grants) + the recorded install ORIGIN (else a later manual upload of the
            // same slug inherits a catalog provenance it never had) + crash strikes; only DROP the plugin's
            // data tables when the admin explicitly asked (dropData) — WordPress-parity: keep data by default.
            const cleanup = await uninstallPluginData(slug, { dropTables: !!dropData });

            // Regenerate registry to remove traces
            regenerateRegistry();

            res.json({ success: true, message: `Plugin ${slug} deleted successfully`, cleanup });
        } catch (err) {
            throw new Error(`Failed to delete plugin: ${err.message}`);
        }
    } finally {
        await lock.release();
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
router.get('/menus', authenticate, asyncHandler(async (req: any, res: Response) => {
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
    const visibleMenus = activeMenus.filter((menu: any) => {
        const requiredCap = menu.cap || menu.capability || 'manage_options';
        return typeof req.user.can === 'function' && req.user.can(requiredCap);
    });

    // 4. Some plugin menu items are only meaningful to a user who owns a PROFESSIONAL mailbox on the
    //    site domain (their account email is @site-domain) — e.g. a per-user webmail inbox; a personal-
    //    email user has no such inbox, so the page would be an empty shell. A plugin marks those items
    //    with `requiresProfessionalMailbox: true` when it registers them (adminMenu.add), and core hides
    //    them from everyone without a professional mailbox. Administrators ALWAYS keep them. This is
    //    slug/href-agnostic, so ANY mail (or other) plugin gets the behaviour — not just mail-server.
    const isAdmin = typeof req.user.getRole === 'function' && req.user.getRole() === 'administrator';
    // Compute the site domain the SAME way a mail plugin does (wordjs.site.domain() → plugin-api.ts):
    // from the live `siteurl` option (fallback `home`, then localhost). Deriving it from static
    // config.site.url could drift from a mail plugin's own catch-all/inbox test, so a user could be
    // hidden from the menu yet still own an inbox (or vice-versa). Use the one source.
    let siteDomain = '';
    try {
        const { getOption } = require('../core/options');
        siteDomain = new URL(await getOption('siteurl', await getOption('home', 'http://localhost'))).hostname.toLowerCase();
    } catch { siteDomain = ''; }
    const userDomain = String(req.user.userEmail || '').toLowerCase().split('@')[1] || '';
    const hasProfessionalMailbox = !!siteDomain && userDomain === siteDomain;
    const finalMenus = (isAdmin || hasProfessionalMailbox)
        ? visibleMenus
        : visibleMenus.filter((m: any) => !m.requiresProfessionalMailbox);

    res.json(finalMenus);
}));

// Mount bundle routes for pre-compiled plugin frontends
const bundleRoutes = require('./plugin-bundles');
router.use('/', bundleRoutes);

module.exports = router;
// Exposed for unit tests of the path-traversal guards (the router remains the default export).
module.exports.isValidSlug = isValidSlug;
module.exports.resolveSafePluginDir = resolveSafePluginDir;
// The shared zip-install pipeline — consumed by routes/marketplace.ts so marketplace installs
// go through the exact same security gauntlet as manual uploads.
module.exports.installPluginFromZip = installPluginFromZip;
// The in-place UPDATE cycle built around it (deactivate → stash → install → restore → reactivate),
// used by POST /marketplace/update and by /marketplace/install on an already-installed plugin.
module.exports.updatePluginFromZip = updatePluginFromZip;
// Boot-time crash recovery for an update that was killed mid-swap (called from index.ts BEFORE the
// active plugins load — a gutted plugins/<slug>/ would otherwise simply fail to load, with the only
// copy of its code sitting in an os-tmp dir nothing ever reads again).
module.exports.recoverInterruptedPluginUpdates = recoverInterruptedPluginUpdates;
