/**
 * WordJS — development-only hot-reload for isolated plugins.
 *
 * When config.nodeEnv === 'development', watches each ACTIVE isolated plugin's directory
 * (fs.watch, recursive) and, after a short debounce, tears down and re-spawns the plugin's
 * child process via reloadIsolatedPlugin() (plugin-isolate.ts). The reload path re-runs the
 * FULL load pipeline — AST security scan included — so the security model is untouched;
 * this is strictly a convenience loop for plugin authors.
 *
 * Non-goals: production use (hard no-op outside development) and plugins activated AFTER
 * boot (restart the dev server, or hit POST /api/v1/plugins/:slug/reload). Failures only
 * log — a watcher problem or a broken save must never crash the host.
 */

import type { FSWatcher } from 'fs';

const fs = require('fs');
const path = require('path');
const config = require('../config/app');

const DEBOUNCE_MS = 300;
// Directory names whose changes never trigger a reload (deps, runtime data, built bundles).
const IGNORED_DIRS = new Set(['node_modules', 'data', 'dist', '.git']);
// Only source/manifest changes matter to the child process (client .tsx is the frontend's job).
const WATCHED_EXTS = new Set(['.js', '.json']);

const watchers = new Map<string, FSWatcher>();
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

function isRelevantChange(filename: unknown): boolean {
    // fs.watch may report a null/undefined filename on some platforms — reload conservatively.
    if (!filename || typeof filename !== 'string') return true;
    const parts = filename.split(/[\\/]/);
    if (parts.some((p: string) => IGNORED_DIRS.has(p))) return false;
    return WATCHED_EXTS.has(path.extname(filename).toLowerCase());
}

async function reloadNow(slug: string): Promise<void> {
    if (inFlight.has(slug)) return; // a reload is already running; the next save re-triggers
    inFlight.add(slug);
    try {
        const { isIsolated, reloadIsolatedPlugin } = require('./plugin-isolate');
        if (!isIsolated(slug)) return; // deactivated since the watch started — nothing to respawn
        console.log(`[plugin-dev-watch] change in '${slug}' — reloading isolate...`);
        await reloadIsolatedPlugin(slug);
        console.log(`[plugin-dev-watch] '${slug}' reloaded`);
    } catch (e: any) {
        // A broken save just logs and waits for the fix — never crash the host over a dev reload.
        console.error(`[plugin-dev-watch] reload of '${slug}' failed:`, e && e.message);
    } finally {
        inFlight.delete(slug);
    }
}

function scheduleReload(slug: string): void {
    const t = timers.get(slug);
    if (t) clearTimeout(t);
    timers.set(slug, setTimeout(() => {
        timers.delete(slug);
        void reloadNow(slug);
    }, DEBOUNCE_MS));
}

function watchPlugin(slug: string, dir: string): boolean {
    if (watchers.has(slug)) return true;
    try {
        // recursive fs.watch is supported on win32/darwin and on Linux since Node 20 (engines >= 20.9).
        const watcher: FSWatcher = fs.watch(dir, { recursive: true }, (_event: string, filename: string | null) => {
            if (!isRelevantChange(filename)) return;
            scheduleReload(slug);
        });
        watcher.on('error', (e: any) => {
            console.warn(`[plugin-dev-watch] watcher for '${slug}' errored:`, e && e.message);
        });
        watchers.set(slug, watcher);
        return true;
    } catch (e: any) {
        console.warn(`[plugin-dev-watch] cannot watch '${slug}':`, e && e.message);
        return false;
    }
}

/**
 * Start watching every ACTIVE isolated plugin's directory. Called once from index.ts right
 * after loadActivePlugins(). Hard no-op unless config.nodeEnv === 'development'; never throws.
 * Returns the number of plugins being watched.
 */
async function startPluginDevWatch(): Promise<number> {
    if (config.nodeEnv !== 'development') return 0;
    try {
        const { getActivePlugins, PLUGINS_DIR } = require('./plugins');
        const { isIsolated } = require('./plugin-isolate');
        const active: string[] = (await getActivePlugins()) || [];
        let count = 0;
        for (const slug of active) {
            if (!isIsolated(slug)) continue; // only a loaded isolate can be re-spawned
            const dir = path.join(PLUGINS_DIR, slug);
            if (!fs.existsSync(dir)) continue;
            if (watchPlugin(slug, dir)) count++;
        }
        if (count > 0) console.log(`👀 [plugin-dev-watch] watching ${count} plugin(s) for changes (dev hot-reload)`);
        return count;
    } catch (e: any) {
        console.warn('[plugin-dev-watch] failed to start (dev hot-reload disabled):', e && e.message);
        return 0;
    }
}

/** Close all watchers and cancel pending reloads (shutdown / tests). */
function stopPluginDevWatch(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const w of watchers.values()) {
        try { w.close(); } catch { /* */ }
    }
    watchers.clear();
}

module.exports = { startPluginDevWatch, stopPluginDevWatch };
