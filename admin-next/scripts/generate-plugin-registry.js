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
            const component = manifest.frontend?.components?.[0];
            if (!component) {
                console.log(`   ○ No frontend component: ${folder}`);
                continue;
            }

            // Verify the component file exists
            const componentPath = component.entry.replace('./', '').replace('.tsx', '');
            const fullPath = path.join(PLUGINS_DIR, folder, component.entry.replace('./', ''));

            if (!fs.existsSync(fullPath)) {
                console.log(`   ✗ Component not found: ${folder} (${component.entry})`);
                continue;
            }

            plugins.push({
                id: manifest.id || folder,
                folder: folder,
                componentPath: componentPath,
                componentName: component.name,
            });

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

    // Ensure activePlugins is an array
    if (!Array.isArray(activePlugins)) {
        console.log('   ⚠️  Invalid response from API, treating as empty list');
        activePlugins = [];
    }

    // Only filter if we actually got a list (even if empty, it implies backend is up and returned 0 plugins)
    // Actually, if backend is down (fetch returns null from catch), we should probably SHOW ALL for dev?
    // But fetchActivePlugins returns null on error.

    // Better logic:
    // If API failed (null), show all (dev mode safety).
    // If API returned list, strictly filter.
    const apiAvailable = activePlugins !== null;

    // Re-fetch logic: fetchActivePlugins returns null on error.
    // Let's check the implementation of fetchActivePlugins again.
    // It resolves null on error.

    // So:
    // const activePlugins = await fetchActivePlugins(); // Array or null
    // const filterByActive = activePlugins !== null;

    // Wait, the error was "activePlugins.join is not a function".
    // This implies it wasn't null, but maybe an object? Or fetchActivePlugins resolved something else?
    // JSON.parse(data) might have returned an error object { error: ... } 

    // Let's make it robust:
    const fetched = await fetchActivePlugins();
    const filterByActive = Array.isArray(fetched);
    const activeList = filterByActive ? fetched : [];

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

    // Generate the TypeScript file
    const imports = includedPlugins.map(p =>
        `    "${p.id}": () => import("../../../backend/plugins/${p.folder}/${p.componentPath}"),`
    ).join('\n');

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
`;

    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`\n✅ Registry generated with ${includedPlugins.length} plugin(s)`);
}

// Run
generateRegistry();
