"use client";

import { loadPluginHooks } from "./pluginRegistry";
import { invalidateActivePluginIds, loadRuntimePluginHooks } from "./pluginBundleLoader";

/**
 * WordJS Plugin Frontend Loader
 * This file centralizes the registration of all plugin-contributed UI extensions.
 * Add new plugin registrations here.
 */
// Run-once guard. Plugin hooks register into a module-level singleton (pluginHooks) that OUTLIVES any
// component. initPlugins() is called from a mount effect in the admin layout, which remounts across
// navigation (and double-invokes under React StrictMode in dev) — so without this guard every remount
// re-registered every plugin's UI hook, stacking duplicate toggles (e.g. two "Professional Mail" switches).
let pluginsInitialized = false;

// Start one hook-loading pass and keep the run-once latch honest: an ASYNC failure (network, chunk load)
// surfaces as a rejection rather than a throw, and either way the latch must re-open so the next
// admin-layout mount can retry. Module-scoped because reloadActivePlugins() runs a pass too and must
// behave identically to the ones initPlugins() runs.
//
// Returns a promise that settles when the pass is done and NEVER rejects (the failure is handled right
// here). Callers are free to ignore it — initPlugins does — or to await it, which is what makes a pass
// observable to a test without a sleep.
const run = (label: string, load: () => unknown): Promise<void> => {
    try {
        const result: unknown = load();
        if (result && typeof (result as Promise<void>).catch === 'function') {
            return (result as Promise<void>).catch((e) => {
                pluginsInitialized = false;
                console.error(`Failed to load ${label}:`, e);
            });
        }
    } catch (e) {
        pluginsInitialized = false;
        console.error(`Failed to load ${label}:`, e);
    }
    return Promise.resolve();
};

export function initPlugins() {
    if (typeof window === 'undefined') return;
    if (pluginsInitialized) return;
    pluginsInitialized = true;

    console.log("🔌 Initializing WordJS Frontend Plugins...");

    // TWO sources of frontend hooks, because a plugin can arrive two ways:
    //  1. loadPluginHooks()        — the generated registry: plugins present on disk when the frontend was
    //                                BUILT, statically imported (hot-reload works in dev).
    //  2. loadRuntimePluginHooks() — plugins installed from the MARKETPLACE after the build, loaded from
    //                                their pre-compiled hooks bundle. A production install ships a frozen
    //                                .next, so this is the ONLY path that can ever see them.
    // Hook chunks/bundles load ASYNCHRONOUSLY — a network/chunk failure surfaces as a promise rejection,
    // not a synchronous throw — so un-latch the run-once guard in BOTH paths, letting the next
    // admin-layout mount retry.
    //
    // Note what un-latching means with TWO loaders under ONE latch: whichever rejects first re-opens the
    // guard while the other is very likely STILL IN FLIGHT, so the next mount runs a pass that OVERLAPS
    // the previous one — passes are concurrent, not merely sequential. The runtime loader is safe under
    // that because it dedupes on the in-flight registration promise per plugin (pluginBundleLoader's
    // hooksRegistration), so an overlapping caller joins the existing attempt rather than registering a
    // second time. loadPluginHooks() — the generated build-time registry — has no such dedupe and leans
    // purely on registration being idempotent, which holds only for plugins that pass pluginHooks KEYS
    // (a keyless addAction/addFilter appends, so it would stack duplicate UI). First-party plugins pass
    // keys; a third-party one need not.
    run("plugin hooks", loadPluginHooks);
    run("marketplace plugin hooks", loadRuntimePluginHooks);
}

/**
 * Re-read the set of ACTIVE plugins and register whatever is newly active — WITHOUT a page reload.
 *
 * Call this right after an activate/deactivate succeeds (admin/plugins/page.tsx: togglePlugin,
 * confirmActivate). Those flows only re-fetch the plugin list into React state; nothing in them reloads
 * the document, and in production nothing regenerates the build-time registry either (regenerateRegistry()
 * returns early when NODE_ENV=production). So the runtime loader is the ONLY thing that can pick up a
 * just-activated plugin, and it was reading a list memoized before the activation: the plugin's hooks and
 * Puck blocks stayed invisible until the admin manually reloaded the tab.
 *
 * Two steps, in order:
 *  1. invalidateActivePluginIds() — drop the memoized list so the pass below sees the NEW plugin. It is
 *     an explicit event, not a poll: nothing re-validates the list on a timer.
 *  2. loadRuntimePluginHooks() — register the newly active plugin's frontend hooks. pluginHooks.notify()
 *     re-renders every mounted <PluginHook>, so the plugin's UI extensions appear immediately.
 *
 * Cannot double-register: loadRuntimePluginHooks dedupes per plugin on the IN-FLIGHT registration promise
 * (hooksRegistration), so plugins an earlier pass already handled are joined, not re-fetched and not
 * re-invoked — only the genuinely new one does any work. Failures follow the same rule as initPlugins':
 * logged, with the run-once latch re-opened so the next admin-layout mount retries.
 *
 * Puck blocks need no second step — the editor loads them on its next mount, and step 1 is what makes
 * that mount see the new plugin.
 *
 * In DEVELOPMENT step 2 is a deliberate no-op (loadRuntimePluginHooks returns early there, so the live
 * static import is never raced by a stale dist/). Dev needs no equivalent: the backend regenerates the
 * registry sources on activate and Next's HMR reloads them. Step 1 still runs — the block loader and the
 * editor read the same memo in every environment.
 *
 * Deactivation is necessarily asymmetric: pluginHooks has no removal API, so a deactivated plugin's
 * already-registered UI extensions stay until the page is reloaded. Invalidating is still required there,
 * otherwise the stale list would go on hiding the NEXT activation.
 */
export function reloadActivePlugins(): Promise<void> {
    if (typeof window === 'undefined') return Promise.resolve();
    invalidateActivePluginIds();
    return run("marketplace plugin hooks", loadRuntimePluginHooks);
}
