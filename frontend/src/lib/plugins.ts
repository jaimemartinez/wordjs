"use client";

import { loadPluginHooks } from "./pluginRegistry";

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

    // Load hooks systematically from the generated registry. Hook chunks load ASYNCHRONOUSLY — a
    // network/chunk failure surfaces as a promise rejection, not a synchronous throw — so un-latch the
    // run-once guard in BOTH paths, letting the next admin-layout mount retry. Retrying is safe:
    // registration is idempotent (keyed hooks replace, never stack).
    try {
        const result: unknown = loadPluginHooks();
        if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((e) => {
                pluginsInitialized = false;
                console.error("Failed to load plugin hooks:", e);
            });
        }
    } catch (e) {
        pluginsInitialized = false;
        console.error("Failed to load plugin hooks:", e);
    }
}
