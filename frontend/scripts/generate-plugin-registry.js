/**
 * generate-plugin-registry.js
 * 
 * Generates pluginRegistry.ts based on ACTIVE plugins only.
 * Called automatically when plugins are activated/deactivated.
 * 
 * READS FROM: Each plugin's manifest.json
 * NO HARDCODED PLUGIN CONFIGURATIONS
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PLUGINS_DIR = path.resolve(__dirname, '../../backend/plugins');
const OUTPUT_FILE = path.resolve(__dirname, '../src/lib/pluginRegistry.ts');
const API_URL = 'http://localhost:3000/api/v1/plugins/active';

/**
 * Fetch active plugins from backend API
 */
function fetchActivePlugins() {
    // Authoritative path: the backend (regenerateRegistry) passes the active list via env when it
    // spawns this script — no network, no race with uninstall's dir deletion, and independent of
    // whether the dev server listens on http or https (http.get fails against an https listener,
    // which used to silently disable active-filtering and include every plugin on disk).
    if (process.env.WORDJS_ACTIVE_PLUGINS) {
        try {
            const fromEnv = JSON.parse(process.env.WORDJS_ACTIVE_PLUGINS);
            if (Array.isArray(fromEnv)) return Promise.resolve(fromEnv);
        } catch { /* fall through to the API */ }
    }
    return new Promise((resolve) => {
        http.get(API_URL, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    console.log('   ⚠️  API not available, including all existing plugins');
                    resolve(null);
                }
            });
        }).on('error', () => {
            console.log('   ⚠️  Backend not running, including all existing plugins');
            resolve(null);
        });
    });
}

/**
 * Discover plugins by reading manifest.json from each plugin folder
 */
function discoverPlugins() {
    const plugins = [];

    if (!fs.existsSync(PLUGINS_DIR)) {
        console.log('   ⚠️  Plugins directory not found');
        return plugins;
    }

    const folders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const folder of folders) {
        const manifestPath = path.join(PLUGINS_DIR, folder, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            console.log(`   ○ No manifest: ${folder}`);
            continue;
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Get frontend component info
            const componentEntry = manifest.frontend?.components?.[0]?.entry || manifest.frontend?.adminPage?.entry;
            const hooks = manifest.frontend?.hooks;
            let componentPath = null;
            let hooksPath = null;

            if (componentEntry) {
                componentPath = componentEntry.replace('./', '').replace('.tsx', '');
                const fullPath = path.join(PLUGINS_DIR, folder, componentEntry.replace('./', ''));
                if (!fs.existsSync(fullPath)) {
                    console.log(`   ✗ Component not found: ${folder}`);
                }
            }

            if (hooks) {
                hooksPath = hooks.replace('./', '').replace('.tsx', '');
                const fullHooksPath = path.join(PLUGINS_DIR, folder, hooks.replace('./', ''));
                if (!fs.existsSync(fullHooksPath)) {
                    console.log(`   ✗ Hooks file not found: ${folder}`);
                    hooksPath = null;
                }
            }

            if (componentPath || hooksPath) {
                plugins.push({
                    id: manifest.id || folder,
                    folder: folder,
                    componentPath: componentPath,
                    hooksPath: hooksPath,
                    permissions: manifest.permissions || []
                });
            }

        } catch (err) {
            console.log(`   ✗ Invalid manifest: ${folder} - ${err.message}`);
        }
    }

    return plugins;
}

async function generateRegistry() {
    console.log('🔌 Generating plugin registry from manifests...');

    // Discover all plugins from manifests
    const allPlugins = discoverPlugins();
    console.log(`   Found ${allPlugins.length} plugin(s) with manifests`);

    // Fetch active plugins from API
    let activePlugins = await fetchActivePlugins();

    // Check filter status
    const filterByActive = Array.isArray(activePlugins);
    const activeList = filterByActive ? activePlugins : [];

    if (filterByActive) {
        console.log(`   Active from API: ${activeList.join(', ') || 'none'}`);
    } else {
        console.log('   ⚠️  Filtering disabled (API unavailable or invalid response)');
    }

    // Filter to only active plugins
    const includedPlugins = allPlugins.filter(p => {
        if (filterByActive && !activeList.includes(p.id)) {
            console.log(`   ○ Inactive: ${p.id}`);
            return false;
        }
        console.log(`   ✓ Included: ${p.id}`);
        return true;
    });

    // 1. Generate Components
    const imports = includedPlugins
        .filter(p => p.componentPath)
        .map(p => `    "${p.id}": () => import("../../../backend/plugins/${p.folder}/${p.componentPath}"),`)
        .join('\n');

    // 2. Generate Hooks — emitted as an ARRAY of promises so loadPluginHooks can report async
    // chunk-load failures to its caller (a bare fire-and-forget .then() hides them forever).
    const hooksImports = includedPlugins
        .filter(p => p.hooksPath)
        .map(p => `
        import("../../../backend/plugins/${p.folder}/${p.hooksPath}").then(m => {
            // Auto-register any export starting with 'register'
            Object.keys(m).forEach(key => {
                const exportFn = (m as any)[key];
                if (key.startsWith('register') && typeof exportFn === 'function') {
                    try { exportFn(); } catch(e) { console.error('Error in hook ${p.id}:', e); }
                }
            });
        }),`)
        .join('\n');

    const content = `"use client";

/**
 * AUTO-GENERATED FILE - Do not edit directly!
 * 
 * Generated by: scripts/generate-plugin-registry.js
 *
 * HYBRID LOADING SYSTEM:
 * - Development: Static imports for hot reload
 * - Production: Pre-compiled bundles for instant activation
 */

import dynamic from "next/dynamic";
import { ComponentType } from "react";

// Detect environment
const IS_DEV = process.env.NODE_ENV === 'development';

const componentCache: Record<string, ComponentType<any> | null> = {};

// ============================================
// DEVELOPMENT: Static Imports (Hot Reload)
// ============================================
const DEV_DEFINITIONS: Record<string, () => Promise<any>> = {
${imports}
};

// ============================================
// PRODUCTION: Pre-compiled Bundle Loader
// ============================================
async function loadProductionBundle(slug: string): Promise<any> {
    try {
        const response = await fetch(\`/api/v1/plugins/\${slug}/bundle?type=admin\`);
        if (!response.ok) {
            console.warn(\`[PluginLoader] Bundle not found for \${slug}\`);
            return { default: () => null };
        }
        
        const bundleCode = await response.text();
        const blob = new Blob([bundleCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        
        try {
            const module = await import(/* webpackIgnore: true */ blobUrl);
            URL.revokeObjectURL(blobUrl);
            return module;
        } catch (err) {
            console.error(\`[PluginLoader] Failed to evaluate bundle for \${slug}:\`, err);
            URL.revokeObjectURL(blobUrl);
            return { default: () => null };
        }
    } catch (err) {
        console.error(\`[PluginLoader] Failed to fetch bundle for \${slug}:\`, err);
        return { default: () => null };
    }
}

// List of plugins with pre-compiled bundles
const PRODUCTION_PLUGINS: string[] = [${includedPlugins.filter(p => p.componentPath).map(p => `"${p.id}"`).join(', ')}];

// ============================================
// Unified Plugin Loader
// ============================================
function createSafeComponent(
    importFn: () => Promise<any>,
    fallback: ComponentType<any> = () => null
): ComponentType<any> {
    return dynamic(
        () => importFn().catch((err) => {
            console.warn("Plugin load failed:", err?.message || err);
            return { default: fallback };
        }),
        {
            loading: () => null,
            ssr: false,
        }
    );
}

export function isPluginAvailable(slug: string): boolean {
    if (IS_DEV) {
        return slug in DEV_DEFINITIONS;
    }
    return PRODUCTION_PLUGINS.includes(slug);
}

export function getPluginComponent(slug: string): ComponentType<any> | null {
    if (!isPluginAvailable(slug)) {
        return null;
    }
    if (componentCache[slug]) {
        return componentCache[slug];
    }
    
    let component: ComponentType<any>;
    
    if (IS_DEV) {
        // Development: Use static imports (hot reload works)
        component = createSafeComponent(DEV_DEFINITIONS[slug]);
    } else {
        // Production: Use pre-compiled bundles (no next build needed)
        component = createSafeComponent(() => loadProductionBundle(slug));
    }
    
    componentCache[slug] = component;
    return component;
}

export function getRegisteredPlugins(): string[] {
    if (IS_DEV) {
        return Object.keys(DEV_DEFINITIONS);
    }
    return PRODUCTION_PLUGINS;
}

/**
 * Initialize Plugin Hooks (e.g., extensions, form modifiers)
 */
export function loadPluginHooks(): Promise<void> {
    if (typeof window === 'undefined') return Promise.resolve();
    const loaders: Promise<any>[] = [
    ${hooksImports}
    ];
    // A failed hook chunk must be VISIBLE to the caller: initPlugins un-latches its run-once guard on
    // rejection so a later mount retries (hook registration is idempotent via keys, so retrying the
    // already-loaded plugins is safe). allSettled: one broken plugin never blocks the others.
    return Promise.allSettled(loaders).then((results) => {
        const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
        failed.forEach(f => console.error('Plugin hook bundle failed to load:', f.reason));
        if (failed.length) throw new Error(failed.length + ' plugin hook bundle(s) failed to load');
    });
}
`;

    // Write-if-changed: an identical rewrite still bumps mtime, which makes Next/Turbopack
    // invalidate + full-reload the browser for nothing (e.g. uninstalling a never-active plugin).
    if (fs.existsSync(OUTPUT_FILE) && fs.readFileSync(OUTPUT_FILE, 'utf8') === content) {
        console.log(`\n✅ Registry unchanged (${includedPlugins.length} plugin(s)) — write skipped, no rebuild`);
        return;
    }
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`\n✅ Registry generated with ${includedPlugins.length} plugin(s)`);
}

// Run
generateRegistry();
