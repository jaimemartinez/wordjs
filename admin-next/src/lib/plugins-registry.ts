// @ts-nocheck
/**
 * Dynamic Plugin Registry
 * 
 * This file now provides dynamic discovery instead of static imports.
 * NO HARDCODED PLUGIN REFERENCES - all plugins are discovered at runtime.
 * 
 * For component loading, use pluginRegistry.ts instead.
 */

// Dynamic plugin list - populated at runtime
let pluginsCache: any[] | null = null;

/**
 * Fetch plugins from API and cache them
 */
export async function getPluginsRegistry(): Promise<any[]> {
  if (pluginsCache) return pluginsCache;

  try {
    const res = await fetch('/api/v1/plugins/registry');
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();
    pluginsCache = data.plugins || [];
    return pluginsCache;
  } catch (err) {
    console.warn('Failed to load plugins registry:', err);
    return [];
  }
}

/**
 * Clear cache (call after plugin activation/deactivation)
 */
export function clearPluginsCache(): void {
  pluginsCache = null;
}

// Legacy exports - empty by default, use getPluginsRegistry() instead
export const PLUGINS_REGISTRY: any[] = [];
export const PLUGIN_COMPONENTS: Record<string, any> = {};
export const EDITOR_TOOLS: Record<string, any> = {};

