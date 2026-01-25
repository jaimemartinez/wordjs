"use client";

import { loadPluginHooks } from "./pluginRegistry";

/**
 * WordJS Plugin Frontend Loader
 * This file centralizes the registration of all plugin-contributed UI extensions.
 * Add new plugin registrations here.
 */
export function initPlugins() {
    if (typeof window === 'undefined') return;

    console.log("🔌 Initializing WordJS Frontend Plugins...");

    // Load hooks systematically from the generated registry
    try {
        loadPluginHooks();
    } catch (e) {
        console.error("Failed to load plugin hooks:", e);
    }
}
