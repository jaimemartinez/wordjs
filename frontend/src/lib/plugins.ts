"use client";

import { loadPluginHooks } from "./pluginRegistry";
import { loadRuntimePluginHooks } from "./pluginBundleLoader";

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
    const run = (label: string, load: () => unknown) => {
        try {
            const result: unknown = load();
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch((e) => {
                    pluginsInitialized = false;
                    console.error(`Failed to load ${label}:`, e);
                });
            }
        } catch (e) {
            pluginsInitialized = false;
            console.error(`Failed to load ${label}:`, e);
        }
    };

    run("plugin hooks", loadPluginHooks);
    run("marketplace plugin hooks", loadRuntimePluginHooks);
}
