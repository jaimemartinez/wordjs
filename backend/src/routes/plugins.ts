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
 * FAIL FAST (409) rather than queue: an admin double-clicking "Update" must be told the plugin is
 * locked, not silently start a second full cycle minutes later against a directory that has since
 * changed (see pluginBusyError for why the message does not assert that something IS running).
 */
const pluginOpsInFlight = new Set<string>();

// Lease sizing. The TTL must outlive a full cycle (npm install + isolate spawn) — the heartbeat keeps
// it alive while we are running — and it is ALSO the worst-case delay before a lease stranded by a
// killed process becomes claimable again, which is why both the 409 text and the boot-recovery retry
// below are derived from it instead of hardcoding a second copy of the number.
const PLUGIN_OP_TTL_MS = 120000;
const PLUGIN_OP_RENEW_MS = 30000;
const PLUGIN_OP_ACQUIRE_TIMEOUT_MS = 3000;

// How long DELETE waits for the plugin's child process to actually be gone before it refuses to remove
// the directory. SIGKILL normally lands in milliseconds; this only has to cover a loaded host.
const DELETE_STOP_TIMEOUT_MS = 3000;

/**
 * ONE lock key per plugin DIRECTORY, case-folded.
 *
 * SLUG_RE deliberately allows mixed case, but resolveSafePluginDir resolves 'Mail-Server' and
 * 'mail-server' to the SAME directory on a case-insensitive filesystem (Windows / default macOS).
 * Keying the guard on the raw spelling therefore hands out two independent locks — and two different
 * lease names — for one directory, so a DELETE spelled one way runs concurrently with an update
 * holding the other and rmSync's the plugin dir mid-swap. Fold the key (never the slug itself: the
 * on-disk name and the isolate registry keep the original spelling).
 *
 * On a case-SENSITIVE filesystem two genuinely distinct plugins whose slugs differ only by case now
 * serialize against each other. That is the safe direction of the trade — an unnecessary 409 the admin
 * can retry, versus a plugin directory deleted out from under a running swap.
 */
function pluginOpKey(slug: any): string {
    return String(slug).toLowerCase();
}

/**
 * Strip line breaks from a request-derived value before it goes into a log line, so a crafted slug or
 * an error message echoing one cannot forge or split an entry in the operator's log.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n|\r/g, ' ');
}

/**
 * Set once the process is on its way out, so no NEW plugin operation can start.
 *
 * This is the half of the graceful shutdown that makes releasing the leases safe. `heldLocks` only ever
 * contains a lease whose critical section has NOT finished (the handle removes it on release), so
 * handing them all back at exit is, by construction, handing back the ones still in use: a peer could
 * take 'wordjs:plugin-op:<slug>' and start extracting into a directory this process is mid-swap on.
 * Refusing new work first is what lets the drain below actually converge instead of racing an admin who
 * clicks Update while the unit is stopping.
 */
let pluginOpsShuttingDown = false;

/**
 * Refuse new plugin operations and report which ones are still running.
 * Idempotent — a second signal must not reset the drain.
 */
function beginPluginOpShutdown(): string[] {
    pluginOpsShuttingDown = true;
    return Array.from(pluginOpsInFlight);
}

/**
 * Wait (bounded) for the in-flight plugin operations to finish, and return the keys of any that did
 * NOT. The caller leaves those leases alone: a lease whose critical section is still executing must
 * expire on its TTL rather than be handed to a peer, which is exactly what an abrupt kill already does
 * and what the boot stash sweep above exists to clean up. Everything else is freed immediately, so the
 * ordinary restart — nothing in flight, hence no plugin-op lease held at all — is unchanged.
 */
async function drainPluginOps(timeoutMs: number, pollMs = 25): Promise<string[]> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (pluginOpsInFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return Array.from(pluginOpsInFlight);
}

/** The dist-lock lease name a given in-flight key corresponds to (kept next to the one that builds it). */
function pluginOpLeaseName(key: string): string { return `wordjs:plugin-op:${key}`; }

/**
 * Plugin-operation leases this process TOOK and has not CONFIRMED handing back, keyed by op key.
 *
 * THIS IS THE STATE THE SHUTDOWN NEEDED AND DID NOT HAVE. The previous attempt asked dist-lock for it
 * — releaseAllHeld({ only: finishedOps }) — and that call could never release anything, because
 * `heldLocks` answers a different question: the lease handle deletes its name from that map in the
 * SAME synchronous step that begins the DB release, and the drain only ever observes an operation as
 * finished AFTER that step has run. So every name the sweep was permitted to free was already gone
 * from the map by construction, and both states it was meant to cover were missed:
 *
 *   - the release's DB write FAILED (it is swallowed as best-effort) — the row is still leased to us;
 *   - the process exited between the operation finishing and that write completing — the drain sees an
 *     empty in-flight set and the handler runs on to process.exit(0) while the UPDATE is in flight.
 *
 * Either way a 120s lease is stranded on a plugin whose critical section is provably over, which is
 * exactly what blocks the next boot's crash recovery and 409s every operation on that plugin. Recorded
 * when the lease is taken, deleted only once the release is CONFIRMED, so the shutdown can re-issue a
 * holder-guarded release for whatever is left.
 *
 * It also makes the safety argument structural rather than a matter of building the allow-list
 * correctly: only plugin-op leases are ever recorded here, so 'wordjs:active-plugins' and 'wordjs:cron'
 * — held while activate/deactivate rewrites the option and while a backup or ACME renewal runs — are
 * not reachable from this path at all, and cannot be handed to a peer mid-critical-section.
 */
const unreleasedOpLeases = new Map<string, string>();

/**
 * Hand back the leases of plugin operations whose critical section is CONFIRMED finished.
 *
 * Called from the graceful-shutdown handler with the keys the drain saw finish. Fails CLOSED per key:
 * an operation still listed in flight keeps its lease and expires on its TTL, exactly as an abrupt kill
 * leaves it (releasing it would hand a peer a plugin this process may be mid-swap on). Returns the
 * lease names actually freed.
 */
async function releaseFinishedOpLeases(keys: string[]): Promise<string[]> {
    const freed: string[] = [];
    let release: (name: string) => Promise<void>;
    try { ({ release } = require('../core/dist-lock')); }
    catch (e: any) { console.warn(`[shutdown] dist-lock unavailable, leases will expire on their TTL: ${logSafe(e && e.message)}`); return freed; }
    for (const key of Array.isArray(keys) ? keys : []) {
        if (pluginOpsInFlight.has(key)) continue; // still executing ⇒ not ours to give away
        const name = unreleasedOpLeases.get(key);
        if (!name) continue;                      // already confirmed released by its own handle
        try { await release(name); unreleasedOpLeases.delete(key); freed.push(name); }
        catch (e: any) { console.warn(`[shutdown] could not release '${logSafe(name)}' (it will expire on its TTL): ${logSafe(e && e.message)}`); }
    }
    return freed;
}

/** Lease names this process has not confirmed releasing (diagnostics + tests). */
function unreleasedOpLeaseNames(): string[] { return Array.from(unreleasedOpLeases.values()); }

type PluginOpLock = { ok: true; release: () => Promise<void> } | { ok: false };

async function acquirePluginOpLock(slug: string): Promise<PluginOpLock> {
    const key = pluginOpKey(slug);
    // Shutting down: starting a full install/update cycle now would either be aborted mid-swap by the
    // imminent process.exit, or hold a lease past the drain window and force it to expire on its TTL.
    if (pluginOpsShuttingDown) return { ok: false };
    if (pluginOpsInFlight.has(key)) return { ok: false };
    pluginOpsInFlight.add(key); // claimed synchronously — before any await, so two concurrent requests can't both pass
    let lease: any = null;
    try {
        const { acquireBlocking } = require('../core/dist-lock');
        // Short timeout = fail fast (but tolerate a lease released microseconds ago); long TTL +
        // heartbeat so a slow cycle is never preempted mid-swap.
        lease = await acquireBlocking(pluginOpLeaseName(key), {
            ttlMs: PLUGIN_OP_TTL_MS, renewMs: PLUGIN_OP_RENEW_MS, timeoutMs: PLUGIN_OP_ACQUIRE_TIMEOUT_MS,
        });
    } catch (e: any) {
        // DB unreachable / pre-boot: degrade to the in-process guard rather than blocking the admin.
        console.warn(`[plugin-op ${key}] distributed lock unavailable, using the in-process guard only:`, e && e.message);
        lease = null;
    }
    if (lease && !lease.held) {
        pluginOpsInFlight.delete(key);
        return { ok: false };
    }
    // From here the lease is OURS until a release is CONFIRMED — see unreleasedOpLeases for why that
    // record cannot be read back out of dist-lock's heldLocks.
    if (lease) unreleasedOpLeases.set(key, pluginOpLeaseName(key));
    let released = false;
    return {
        ok: true,
        release: async () => {
            if (released) return; // idempotent: several exit paths may release
            released = true;
            pluginOpsInFlight.delete(key);
            if (!lease) { unreleasedOpLeases.delete(key); return; }
            // CONFIRMED means the UPDATE reached the database — dist-lock's release() reports that
            // rather than swallowing the failure, which is what made a failed hand-back look identical
            // to a successful one. Anything else keeps the record so the shutdown retries it, instead
            // of leaving the successor locked out for the full TTL on a lease nobody is using.
            let confirmed = false;
            try { confirmed = (await lease.release()) !== false; }
            catch (e: any) { console.warn(`[plugin-op ${logSafe(key)}] releasing the lease threw: ${logSafe(e && e.message)}`); }
            if (confirmed) unreleasedOpLeases.delete(key);
            else console.warn(`[plugin-op ${logSafe(key)}] the lease was not confirmed handed back; it will be retried at shutdown.`);
        },
    };
}

/**
 * The 409 payload for "someone else is already touching this plugin".
 *
 * It deliberately does NOT claim an operation is running: the distributed lease survives the process
 * that took it (holder-guarded, TTL-expiring), so on Postgres this also fires for up to the TTL after
 * a node was killed mid-cycle — telling the admin something is "running" when nothing is would send
 * them hunting for a phantom. Say what is actually known, and that waiting resolves it.
 */
function pluginBusyError(slug: string): string {
    return `'${slug}' is locked by another install/update/uninstall — either one is still running, or one was interrupted and its lock has not expired yet (up to ${Math.round(PLUGIN_OP_TTL_MS / 1000)}s). Wait and try again.`;
}

/**
 * Is a child process actually registered for this plugin RIGHT NOW?
 *
 * The `active_plugins` option is a stored intention; the isolate registry is the running truth. They
 * diverge precisely on the paths that matter here — an activation that threw after isolates.set, and
 * an activatePlugin that early-returned 'Plugin already active' without spawning anything — so any
 * claim to the admin that a plugin "was reactivated" has to be checked against this, not against a
 * call having returned. The raw slug is used (never the folded lock key): the registry is keyed by
 * the plugin's real slug.
 */
function isPluginRunning(slug: string): boolean {
    try { return require('../core/plugin-isolate').isIsolated(slug) === true; }
    catch (e: any) {
        console.warn(`[plugin ${slug}] could not read the isolate registry:`, e && e.message);
        return false;
    }
}

/**
 * Re-spawn a running isolate — the ONE place the routes that change a plugin's runtime configuration
 * do it, and it exists because reloadIsolatedPlugin is an UNLOAD FOLLOWED BY AN AWAITED LOAD.
 *
 * Every caller must already hold the per-slug plugin-op lock. Without it, four admin routes
 * (/permissions, /egress-hosts, /reload, /free-port) reloaded outside any serialization, so a
 * deactivate landing inside that await produced an orphan — it unloaded the child that was already
 * gone, and the load then re-registered a fresh one for a plugin `active_plugins` no longer lists.
 * A deactivate + DELETE landing there was worse: DELETE's own post-unload verify runs BEFORE the
 * reload's registration, so it returned 200, removed the directory, and the reload then registered a
 * live child for a plugin that no longer exists on disk.
 *
 * `isIsolated` is read here, inside the caller's lock, rather than by the caller before taking it.
 * Best-effort by design: the configuration change these routes make is already persisted, so a reload
 * hiccup is reported as `reloaded: false` instead of failing the change.
 */
async function reloadUnderLock(slug: string, label: string): Promise<boolean> {
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (!isIsolated(slug)) return false;
        await reloadIsolatedPlugin(slug);
        return true;
    } catch (e: any) {
        console.warn(`[${label}] reload of '${logSafe(slug)}' failed: ${logSafe(e && e.message)}`);
        return false;
    }
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
 * mid-update on a shared plugins dir, that node holds the lease and we must not touch its stash —
 * restoring the old code from under a live update is exactly the corruption this function exists to
 * prevent.
 *
 * But losing that lock is NOT proof another node is working. On Postgres the lease outlives the
 * process that took it (holder-guarded, so the successor's new HOLDER cannot free it; claimable only
 * once locked_until lapses), so the single most likely reason THIS boot cannot take it is that the
 * predecessor — the very process that was killed mid-update, leaving the stash we are looking at —
 * still owns it for up to PLUGIN_OP_TTL_MS. Skipping silently in that case leaves the plugin GUTTED
 * with its only code copy in a directory backups exclude, until some later restart happens to fall
 * outside the TTL window. So we RETRY instead of skipping, and say so honestly in the log.
 *
 * Retrying (rather than stealing a lease whose recorded holder looks dead) is deliberate: pid
 * liveness is only meaningful inside one pid namespace, and two containers can share a hostname, so
 * "provably gone" cannot be decided from the holder string alone — and a wrong steal would let two
 * live processes work on the same slug, the one outcome that must never happen. Waiting out the TTL
 * is always safe, and the graceful-shutdown release (index.ts) means the common restart never waits.
 *
 * RESTORING THE CODE IS NOT THE SAME AS RECOVERING THE PLUGIN, and the two diverge on exactly the
 * retry path. index.ts runs the first sweep immediately before loadActivePlugins(), so there the
 * loader starts whatever was put back. A deferred retry runs ~PLUGIN_OP_TTL_MS later — the loader has
 * already been through and found no code for this slug — so a retry that only restores files leaves
 * `active_plugins` listing a plugin with no process behind it. Every attempt after the first therefore
 * RESTARTS what it restores and reports the outcome from the isolate registry: `reactivated` only
 * names plugins with a confirmed live child, and anything still listed-active-but-down lands in
 * `needsAttention` with an error, never in an optimistic "recovered" line.
 */
const RECOVERY_RETRY_MS = PLUGIN_OP_TTL_MS + 10000; // just past the worst-case stranded lease
const RECOVERY_MAX_ATTEMPTS = 3;

type RecoveryResult = {
    restored: string[];
    discarded: string[];
    deferred: string[];
    /** Restored AND confirmed to have a live child again (only ever set on a post-boot retry). */
    reactivated: string[];
    /** Restored, still listed in `active_plugins`, and NOT running. The admin has to look. */
    needsAttention: string[];
};

/**
 * Bring a plugin the sweep has just restored back UP — used only when the boot's own plugin load can
 * no longer do it for us.
 *
 * WHY THIS IS NOT SYMMETRIC ACROSS ATTEMPTS. index.ts runs the FIRST sweep immediately before
 * loadActivePlugins(), so on that pass putting the code back is the entire job: the loader starts every
 * plugin `active_plugins` lists, including this one. A DEFERRED retry fires ~PLUGIN_OP_TTL_MS later,
 * long after that loader ran and failed to find any code for this slug — so restoring the files there
 * and stopping leaves `active_plugins` claiming a plugin that has no process, which the previous
 * revision then reported with an optimistic "recovered" line.
 *
 * Restarting has to go through deactivate-then-activate, not a bare activatePlugin: the flag is still
 * set (that IS the inconsistency), and activatePlugin early-returns { success: true, 'Plugin already
 * active' } while it is, spawning nothing. And the answer is read back from the isolate registry rather
 * than from "no exception was thrown", for the same reason it is everywhere else in this file.
 */
async function restartRecoveredPlugin(slug: string): Promise<'running' | 'not-active' | 'failed'> {
    const core = require('../core/plugins');
    if (!(await core.isPluginActive(slug))) return 'not-active';
    if (isPluginRunning(slug)) return 'running';
    try { await core.deactivatePlugin(slug, { prune: false }); }
    catch (e: any) { console.warn(`[plugin-update] '${slug}': clearing the stale active flag before the restart failed:`, e && e.message); }
    try { await core.activatePlugin(slug); }
    catch (e: any) { console.error(`[plugin-update] '${slug}': restart after recovery threw:`, e && e.message); return 'failed'; }
    return isPluginRunning(slug) ? 'running' : 'failed';
}

async function recoverInterruptedPluginUpdates(
    opts: { retryMs?: number; attempt?: number; maxAttempts?: number; reactivate?: boolean } = {},
): Promise<RecoveryResult> {
    const attempt = opts.attempt ?? 1;
    const maxAttempts = opts.maxAttempts ?? RECOVERY_MAX_ATTEMPTS;
    const retryMs = opts.retryMs ?? RECOVERY_RETRY_MS;
    // Attempt 1 is the BOOT sweep and runs before loadActivePlugins(), which does the starting; every
    // later attempt fires after boot finished, so it has to restart the plugin itself (see above).
    const reactivate = opts.reactivate ?? attempt > 1;
    const out: RecoveryResult = { restored: [], discarded: [], deferred: [], reactivated: [], needsAttention: [] };
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
            out.deferred.push(slug);
            console.warn(
                `[plugin-update] ${entry}: could not take the operation lock for '${slug}' — either another node is mid-update, `
                + `or a process was killed while holding the lease and it has not expired yet. `
                + (attempt < maxAttempts
                    ? `Retrying in ${retryMs >= 1000 ? `${Math.round(retryMs / 1000)}s` : `${retryMs}ms`} (attempt ${attempt}/${maxAttempts}).`
                    : `Giving up after ${maxAttempts} attempts — if '${slug}' is missing, restart the server or reinstall it from the marketplace.`),
            );
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
                // Restoring the CODE is not the same as recovering the PLUGIN. Say which one happened.
                if (!fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
                    out.needsAttention.push(slug);
                    console.error(`[plugin-update] '${slug}': code restored from ${entry}, but it still has no manifest.json — the stash itself was incomplete. Reinstall it from the marketplace.`);
                } else if (!reactivate) {
                    console.warn(`[plugin-update] '${slug}': code restored from ${entry} by the boot sweep — loadActivePlugins starts it next if it is listed active.`);
                } else {
                    const state = await restartRecoveredPlugin(slug);
                    if (state === 'running') {
                        out.reactivated.push(slug);
                        console.warn(`[plugin-update] '${slug}': code restored from ${entry} and the plugin is running again.`);
                    } else if (state === 'not-active') {
                        console.warn(`[plugin-update] '${slug}': code restored from ${entry}; it is not listed active, so nothing was started.`);
                    } else {
                        out.needsAttention.push(slug);
                        console.error(`[plugin-update] '${slug}': code restored from ${entry} but it could NOT be started — active_plugins lists it and no process is serving it. Check Plugins.`);
                    }
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
    if (out.deferred.length && attempt < maxAttempts) scheduleRecoveryRetry({ retryMs, attempt, maxAttempts, reactivate: opts.reactivate });
    return out;
}

/**
 * Re-run the sweep once the stranded lease can have expired. unref'd on purpose: a pending retry must
 * never be the reason the process stays alive (and must never keep `node --test` from exiting), and a
 * shutdown before it fires costs nothing — the next boot sweeps again from the same directory.
 */
let recoveryRetryTimer: NodeJS.Timeout | null = null;
function scheduleRecoveryRetry(opts: { retryMs: number; attempt: number; maxAttempts: number; reactivate?: boolean }): void {
    if (recoveryRetryTimer) return; // one pending sweep at a time; it covers every deferred slug
    recoveryRetryTimer = setTimeout(() => {
        recoveryRetryTimer = null;
        // attempt > 1 ⇒ the retry RESTARTS what it restores: boot's loadActivePlugins is long past by
        // now, so nothing else would (see restartRecoveredPlugin).
        recoverInterruptedPluginUpdates({ retryMs: opts.retryMs, attempt: opts.attempt + 1, maxAttempts: opts.maxAttempts, reactivate: opts.reactivate })
            .catch((e: any) => console.warn('[plugin-update] deferred stash recovery failed:', e && e.message));
    }, opts.retryMs);
    if (typeof recoveryRetryTimer.unref === 'function') recoveryRetryTimer.unref();
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
    //
    // KNOWN LIMIT, deliberately not closed here. This returns BEFORE the provenance gate below, so after
    // an uninstall WITHOUT dropData — which keeps plugins/<slug>/data/ but clears the grants and the
    // recorded origin — a DIFFERENT catalog source that lists the same id can install over the preserved
    // data dir (for mail-server: the AES root key and the DKIM private keys). What stops that from being
    // a live takeover is that the gate below is not the only control: the grants restart at default-deny,
    // so the new code gets no `network`, no egress allowlist and no host capability until an admin
    // approves each one — it cannot exfiltrate what it inherits. Closing it properly means binding the
    // preserved data/ to the origin that wrote it, which uninstall deliberately forgets today (so a
    // manual upload cannot inherit a catalog provenance); that trade-off is a change of its own, not a
    // line in this one. Operators who do not want the adoption at all: uninstall with `dropData: true`.
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

    /**
     * Make sure NO child process is left registered for this slug.
     *
     * activatePlugin loads the isolate FIRST (isolates.set) and only then writes active_plugins and
     * fires the 'activated_plugin' hook — and both of those can throw (the active_plugins write takes
     * a lease that throws by design when it cannot be won within 15s; a hook is arbitrary code). The
     * plugin is then NOT in active_plugins, so deactivatePlugin() alone early-returns 'Plugin not
     * active' and leaves that child ALIVE. A later activation spawns a SECOND child and overwrites
     * isolates[slug]; the orphan's 'exit' handler then sees wasCurrent === false and SKIPS teardown,
     * so its hooks, routes and any claimed provider (the system mail sender!) stay wired to a process
     * nobody supervises. unloadIsolatedPlugin is idempotent and runs teardown, so it is called
     * unconditionally after deactivatePlugin (which covers the case where the flag DID get written).
     */
    const tearDownIsolate = async (what: string) => {
        try { await deactivatePlugin(slug, { prune: false }); }
        catch (e: any) { console.warn(`[update ${slug}] deactivating ${what}:`, e && e.message); }
        try { require('../core/plugin-isolate').unloadIsolatedPlugin(slug); }
        catch (e: any) { console.warn(`[update ${slug}] unloading ${what}:`, e && e.message); }
    };

    /**
     * Bring the plugin back up and answer HONESTLY whether it is running. Two ways "it did not throw"
     * lies, and both end with the admin told the site was restored while nothing is serving it:
     *   - it threw AFTER the isolate was registered → an orphan (see tearDownIsolate);
     *   - it did not spawn at all: activatePlugin EARLY-RETURNS { success:true, 'Plugin already
     *     active' } while the slug is still listed in active_plugins, which is exactly the state a
     *     failed deactivation leaves behind (its lease can time out and throw).
     * So: tear down on throw, and confirm against the isolate registry — the process that would
     * actually be serving the plugin's hooks and routes — rather than against the absence of an
     * exception.
     */
    const reactivateAndConfirm = async (what: string): Promise<boolean> => {
        try {
            await activatePlugin(slug);
        } catch (e: any) {
            console.error(`[update ${slug}] could not reactivate ${what}:`, e && e.message);
            await tearDownIsolate(`the isolate left behind by the failed activation of ${what}`);
            return false;
        }
        if (isPluginRunning(slug)) return true;
        console.error(
            `[update ${slug}] activatePlugin reported success for ${what} but no isolate is registered — `
            + `the plugin is NOT running (it is most likely still listed in active_plugins after a deactivation that failed).`,
        );
        return false;
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
        // The throw can come from deactivatePlugin itself, i.e. the plugin may already be half-down (or
        // half-up) — so restart it through the same guarded path as the rollback, never a bare
        // activatePlugin: an orphaned isolate here would keep serving the routes of a plugin the admin
        // is about to be told is untouched.
        const backUp = wasActive ? await reactivateAndConfirm('the version that was running') : true;
        return {
            ok: false,
            status: 500,
            body: {
                error: `Could not prepare the update of '${slug}': ${e.message}`
                    + (wasActive ? (backUp ? ' — it is still running.' : ' — and it could NOT be restarted, check Plugins.') : ''),
                reactivated: wasActive ? backUp : undefined,
            },
        };
    }

    // Old version's persisted footprint: grants/strikes/assets go, its DATA TABLES stay.
    await uninstallPluginData(slug, { dropTables: false });

    const rollback = async (reason: string, status: number, body: any) => {
        // FIRST: make sure the FAILED new version is not still running (see tearDownIsolate) — the old
        // version is about to be spawned into the same isolate slot.
        await tearDownIsolate('the failed new version');
        try { restorePluginCode(installedDir, backupDir); } catch (e: any) { console.error(`[update ${slug}] ROLLBACK FAILED:`, e && e.message); }
        await restoreAdminState();
        // NOT `try { activate } catch`: the deactivation just above can throw (its active_plugins lease
        // times out), which leaves the slug listed as active, and activatePlugin then early-returns
        // 'Plugin already active' having spawned NOTHING — so a throw-based flag would report "v1 was
        // restored and reactivated" with no process running at all.
        const reactivated = wasActive ? await reactivateAndConfirm('the restored version') : false;
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

    // No tearDownIsolate on throw here (rollback() below does it, and doing it twice would double the
    // deactivate/unload pair) — but `reactivated` is still derived from the ISOLATE REGISTRY, exactly
    // like the two rollback-side reactivations, so every path in this function answers "is it running?"
    // from the same fact. The 'Plugin already active' early-return is not *supposed* to be reachable
    // here (installPluginFromZip refuses with 409 while the slug is still listed in active_plugins, so
    // getting this far proves the deactivation took effect) — which is precisely why a throw-based flag
    // is the wrong thing to leave in place: if that reasoning ever stops holding, it reports a running
    // plugin where there is no process, and the admin is told the update succeeded.
    let reactivated = false;
    let activationError: string | null = null;
    if (wasActive) {
        try {
            await activatePlugin(slug);
            reactivated = isPluginRunning(slug);
            if (!reactivated) activationError = 'activatePlugin reported success but no isolate is registered — the plugin is not running';
        } catch (e: any) { activationError = (e && e.message) || String(e); }
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
    const slug = req.params.slug as string;

    // Serialize against install/update/delete of the SAME slug — the identical lock those take, so the
    // four mutating operations are now mutually exclusive rather than three-of-four.
    //
    // Unserialized, activation and DELETE interleave destructively: loadIsolatedPlugin is an await, and a
    // DELETE that lands while it is in flight passes its "is it active?" check (the flag is not written
    // until afterwards), stops the freshly-registered child as an orphan and rmSyncs the directory —
    // while this handler carries on and completes its `active_plugins` write, leaving the flag naming a
    // slug with no code on disk. The same window lets an update stash the code out from under an
    // activation that is about to spawn from it.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        // Default-deny grants: when an admin activates a plugin (having seen its requested permissions in
        // the activation dialog), grant exactly what its manifest DECLARES — but ONLY if it has no grant
        // record yet, so a later REVOKE via the per-permission switches survives a re-activation. The admin
        // can refine grants anytime in /admin/plugins.
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
            result = await activatePlugin(slug);
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
    } finally {
        await lock.release();
    }
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
    const slug = req.params.slug as string;
    const { setGrants, getGrants } = require('../core/plugin-permissions');

    // Same per-slug lock as activate/deactivate/install/update/delete — see reloadUnderLock for why
    // EVERY route that reloads an isolate has to hold it.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
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
        const reloaded = await reloadUnderLock(slug, 'Permissions');

        const granted = getGrants(slug);
        res.json({
            success: true,
            slug,
            granted,
            network: granted.includes('network'),
            reloaded,
            message: `Permissions updated for '${slug}' (${granted.length} granted).${reloaded ? ' Isolate reloaded — changes are in effect.' : ' Reactivate the plugin to fully apply.'}`,
        });
    } finally {
        await lock.release();
    }
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
    const slug = req.params.slug as string;
    const { setEgressAllowlist, getEgressAllowlist } = require('../core/plugin-permissions');

    // Under the per-slug lock like every other isolate-reloading route — see reloadUnderLock.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        // Body: { hosts: ["api.stripe.com", "*.example.com", ...] }. Invalid entries (schemes/paths/ports) are
        // dropped by setEgressAllowlist. An empty array clears the list (back to allow-all-public).
        const body = req.body || {};
        const hosts: string[] = Array.isArray(body.hosts) ? body.hosts.map((h: any) => String(h)) : [];
        await setEgressAllowlist(slug, hosts);

        // Re-spawn the isolate so the child re-installs the new allowlist (pushed in cfg → egress-guard.setAllowedHosts).
        const reloaded = await reloadUnderLock(slug, 'EgressHosts');

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
    } finally {
        await lock.release();
    }
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
    //
    // Under the per-slug lock, and the isIsolated() precondition is re-read INSIDE it: checked outside,
    // a deactivate landing in between turns this into a load of a plugin that is no longer active.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (!isIsolated(slug)) {
            return res.status(404).json({ error: `Plugin '${slug}' is not a loaded isolated plugin (is it active?)` });
        }
        await reloadIsolatedPlugin(slug);
        res.json({ success: true, slug, message: `Isolate for '${slug}' reloaded.` });
    } finally {
        await lock.release();
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
    // Under the per-slug lock like every other isolate-reloading route — see reloadUnderLock.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        // allowDisable = the admin's explicit modal confirmation travels WITH the request. Without it
        // the core refuses to disable anything (CONSENT_REQUIRED below) — so a stale client snapshot
        // can never turn into an unconsented systemctl disable (TOCTOU).
        const result = await freeClaimedPort(port, { allowDisable: req.body?.allowDisable === true });
        // Reload the (running) plugin so its own bind logic can take the freed port right away.
        const reloaded = await reloadUnderLock(slug, 'FreePort');
        res.json({ success: true, ...result, reloaded });
    } catch (e: any) {
        // `details` is the one structured field the frontend api() helper preserves on thrown errors —
        // carry the machine-readable code + fresh conflict there so the client can re-prompt consent.
        if (e && e.code === 'CONSENT_REQUIRED') return res.status(409).json({ error: e.message, code: e.code, details: { code: e.code, conflict: e.conflict } });
        if (e && e.code === 'PORT_NOT_FREEABLE') return res.status(409).json({ error: e.message, code: e.code });
        if (e && (e.code === 'PORT_STILL_IN_USE' || e.code === 'DISABLE_FAILED')) return res.status(502).json({ error: e.message, code: e.code });
        throw e;
    } finally {
        await lock.release();
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

    const slug = req.params.slug as string;

    // Same per-slug lock as activate/install/update/delete — see the activate route. A deactivation that
    // runs alongside an update is the mirror image of the race described there: it unloads the isolate
    // and rewrites `active_plugins` while the update is deciding, from those very facts, whether the
    // plugin has to be brought back up.
    const lock = await acquirePluginOpLock(slug);
    if (!lock.ok) {
        return res.status(409).json({ message: pluginBusyError(slug), busy: true });
    }
    try {
        const result = await deactivatePlugin(slug);

        // Trigger frontend registry regeneration
        regenerateRegistry();

        res.json(result);
    } finally {
        await lock.release();
    }
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

        // 1b. …then UNCONDITIONALLY stop whatever this slug still owns in the isolate layer.
        //
        // Two distinct leftovers have to go, and only one of them is visible to isPluginRunning():
        //
        //   - a REGISTERED child. `active_plugins` is a stored intention; the isolate registry is the
        //     running truth, and an activation that threw after registering its child leaves them
        //     disagreeing (see core/plugins.activatePlugin). In that state the check above passes — the
        //     flag does not list the plugin — and this handler would rmSync the directory of a live
        //     process still holding this plugin's hooks, routes and any claimed provider, leaving them
        //     wired to code that no longer exists on disk. "Deactivate it first" is not an option the
        //     admin has either: deactivatePlugin early-returns 'Plugin not active' for precisely this
        //     state, so the orphan can only be cleared here.
        //
        //   - a PENDING SUPERVISED RESTART. When a child crashes, its 'exit' handler removes it from the
        //     isolate registry and schedules a backoff restart (superviseRestart, up to 60s). Throughout
        //     that window isPluginRunning() is FALSE while a live timer is still holding the slug — and
        //     that timer is cancelled ONLY inside unloadIsolatedPlugin. Making the call conditional on
        //     isPluginRunning() therefore deleted the directory and left the timer armed: it fires on a
        //     deleted entry file, retries up to 5 times and ends in a "keeps crashing and was stopped"
        //     admin notice for a plugin that no longer exists. Worse, if the slug is REINSTALLED inside
        //     that window the stale timer registers an isolate OUTSIDE activatePlugin — manufacturing
        //     exactly the orphan the bullet above exists to clean up.
        //
        // unloadIsolatedPlugin does both (cancel the timer, tear the child down) and is idempotent, so
        // it is called unconditionally — the same thing the update cycle's tearDownIsolate does.
        //
        // Then VERIFY, and verify the thing that is actually at stake. Deleting the directory is
        // irreversible, so the precondition has to be "no process of ours is running for this slug" —
        // and the registry cannot answer that: unloadIsolatedPlugin removes the entry SYNCHRONOUSLY
        // while `kill(SIGKILL)` is asynchronous, so isPluginRunning() goes false the instant we ask it
        // to stop, whether or not the signal has landed. awaitIsolateStopped waits (bounded) for both
        // conditions — nothing registered AND every pid we spawned for this slug observed to exit —
        // so a 409 here now means a process really is still alive.
        if (isPluginRunning(slug)) {
            console.warn(`[plugin ${logSafe(slug)}] delete: a child process is still registered although the plugin is not listed active (orphaned isolate) — stopping it before removing the directory.`);
        }
        const isolate = require('../core/plugin-isolate');
        try { isolate.unloadIsolatedPlugin(slug); }
        catch (e: any) { console.error(`[plugin ${logSafe(slug)}] delete: could not stop the isolate / cancel its pending restart: ${logSafe(e && e.message)}`); }
        if (!(await isolate.awaitIsolateStopped(slug, DELETE_STOP_TIMEOUT_MS))) {
            return res.status(409).json({
                message: `'${slug}' still has a running process that could not be stopped. Restart the server, then delete it.`,
                stillRunning: true,
            });
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
// The per-slug operation lock itself — exported so tests can HOLD a slug and prove what the boot
// sweep does when it cannot take it (defer + retry, never a silent skip).
module.exports.acquirePluginOpLock = acquirePluginOpLock;
// Graceful-shutdown hooks (index.ts): refuse NEW plugin operations, then wait out the in-flight ones,
// BEFORE the distributed leases are handed back — otherwise the shutdown frees the very lease whose
// critical section is still running and a peer can start work on the same slug.
module.exports.beginPluginOpShutdown = beginPluginOpShutdown;
module.exports.drainPluginOps = drainPluginOps;
module.exports.pluginOpLeaseName = pluginOpLeaseName;
// …and then hand back the leases of the operations the drain saw FINISH. This is the step that has to
// own the bookkeeping itself (unreleasedOpLeases): dist-lock's heldLocks has already forgotten a lease
// by the time an operation counts as finished, so asking IT which ones to free frees nothing at all.
module.exports.releaseFinishedOpLeases = releaseFinishedOpLeases;
module.exports.unreleasedOpLeaseNames = unreleasedOpLeaseNames;
