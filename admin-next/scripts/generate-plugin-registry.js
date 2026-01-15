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

    // 2. Generate Hooks
    const hooksImports = includedPlugins
        .filter(p => p.hooksPath)
        .map(p => `
            import("../../../backend/plugins/${p.folder}/${p.hooksPath}").then(m => {
                // Auto-register any export starting with 'register'
                Object.keys(m).forEach(key => {
                    if (key.startsWith('register') && typeof m[key] === 'function') {
                        try { m[key](); } catch(e) { console.error('Error in hook ${p.id}:', e); }
                    }
                });
            });`)
        .join('\n');

    const content = `"use client";

/**
 * AUTO-GENERATED FILE - Do not edit directly!
 * 
 * Generated by: scripts/generate-plugin-registry.js
 * Generated at: ${new Date().toISOString()}
 * 
 * Only ACTIVE plugins are included.
 * Plugin info is read from each plugin's manifest.json
 */

import dynamic from "next/dynamic";
import { ComponentType } from "react";

const componentCache: Record<string, ComponentType<any> | null> = {};

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

const PLUGIN_DEFINITIONS: Record<string, () => Promise<any>> = {
${imports}
};

export function isPluginAvailable(slug: string): boolean {
    return slug in PLUGIN_DEFINITIONS;
}

export function getPluginComponent(slug: string): ComponentType<any> | null {
    if (!isPluginAvailable(slug)) {
        return null;
    }
    if (componentCache[slug]) {
        return componentCache[slug];
    }
    const component = createSafeComponent(PLUGIN_DEFINITIONS[slug]);
    componentCache[slug] = component;
    return component;
}

export function getRegisteredPlugins(): string[] {
    return Object.keys(PLUGIN_DEFINITIONS);
}

/**
 * Initialize Plugin Hooks (e.g., extensions, form modifiers)
 */
export function loadPluginHooks() {
    if (typeof window === 'undefined') return;
    
    ${hooksImports}
}
`;

    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`\n✅ Registry generated with ${includedPlugins.length} plugin(s)`);
}

// Run
generateRegistry();
