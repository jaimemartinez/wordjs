/**
 * generate-puck-plugin-registry.js
 * 
 * Generates puckPluginRegistry.ts based on ACTIVE plugins only.
 * Called automatically when plugins are activated/deactivated.
 * 
 * READS FROM: Each plugin's manifest.json
 * NO HARDCODED PLUGIN CONFIGURATIONS
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PLUGINS_DIR = path.resolve(__dirname, '../../backend/plugins');
const OUTPUT_FILE = path.resolve(__dirname, '../src/lib/puckPluginRegistry.ts');
const API_URL = 'http://localhost:3000/api/v1/plugins/active';

function toPascalCase(str) {
    return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

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
                    const parsed = JSON.parse(data);
                    if (Array.isArray(parsed)) {
                        resolve(parsed);
                    } else {
                        console.log('   ⚠️  Invalid API response format (expected array), including all existing plugins');
                        resolve(null);
                    }
                } catch {
                    console.log('   ⚠️  API invalid JSON, including all existing plugins');
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
 * Discover plugins with Puck components from manifest.json
 */
function discoverPuckPlugins() {
    const plugins = [];

    if (!fs.existsSync(PLUGINS_DIR)) {
        return plugins;
    }

    const folders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const folder of folders) {
        const manifestPath = path.join(PLUGINS_DIR, folder, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            continue;
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Check if plugin has puck components defined
            const puckEntry = manifest.frontend?.puckComponents?.entry;
            if (!puckEntry) {
                // Fallback: look for convention-based Puck file
                const pascalName = toPascalCase(folder);
                const conventionPath = path.join(PLUGINS_DIR, folder, 'client/puck', `${pascalName}Puck.tsx`);

                if (fs.existsSync(conventionPath)) {
                    plugins.push({
                        id: manifest.id || folder,
                        folder: folder,
                        PascalName: pascalName,
                        importPath: `client/puck/${pascalName}Puck`,
                    });
                }
                continue;
            }

            // Use manifest-defined path
            const puckPath = puckEntry.replace('./', '').replace('.tsx', '');
            const fullPath = path.join(PLUGINS_DIR, folder, puckEntry.replace('./', ''));

            if (!fs.existsSync(fullPath)) {
                console.log(`   ✗ Puck component not found: ${folder} (${puckEntry})`);
                continue;
            }

            // A plugin can expose MULTIPLE blocks via `export const puckComponents = {...}`, or a
            // single block via `puckComponentDef` + default export. Detect which by reading the entry.
            let multi = false;
            try { multi = /export\s+const\s+puckComponents\b/.test(fs.readFileSync(fullPath, 'utf8')); } catch { /* single */ }

            plugins.push({
                id: manifest.id || folder,
                folder: folder,
                PascalName: toPascalCase(manifest.id || folder),
                importPath: puckPath,
                multi,
            });

        } catch (err) {
            console.log(`   ✗ Invalid manifest: ${folder} - ${err.message}`);
        }
    }

    return plugins;
}

async function generateRegistry() {
    console.log('🔌 Generating Puck plugin registry from manifests...');

    // Discover all plugins with Puck components
    const allPlugins = discoverPuckPlugins();
    console.log(`   Found ${allPlugins.length} plugin(s) with Puck components`);

    // Fetch active plugins from API
    const activePlugins = await fetchActivePlugins();
    const filterByActive = activePlugins !== null;

    if (filterByActive) {
        console.log(`   Active from API: ${activePlugins.join(', ') || 'none'}`);
    }

    // Filter to only active plugins
    const includedPlugins = allPlugins.filter(p => {
        if (filterByActive && !activePlugins.includes(p.id)) {
            console.log(`   ○ Inactive: ${p.id}`);
            return false;
        }
        console.log(`   ✓ Included: ${p.id} -> ${p.PascalName}`);
        return true;
    });

    // Generate content
    const imports = includedPlugins.map(p =>
        `import * as ${p.PascalName}Puck from "../../../backend/plugins/${p.folder}/${p.importPath}";`
    ).join('\n');

    // Emit ONLY the reference that exists on each module (see `multi` detection above) — Turbopack
    // statically errors on any `import * as X` member that isn't an actual export.
    const exports = includedPlugins.map(p => p.multi
        ? `    ...${p.PascalName}Puck.puckComponents,`
        : `    "${p.PascalName}": {
        ...${p.PascalName}Puck.puckComponentDef,
        render: ${p.PascalName}Puck.default
    },`
    ).join('\n');

    const fileContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated by: scripts/generate-puck-plugin-registry.js
// Plugin info is read from each plugin's manifest.json

${imports}

export const puckPluginComponents: Record<string, any> = {
${exports}
};
`;

    // Write-if-changed: an identical rewrite still bumps mtime, which makes Next/Turbopack
    // invalidate + full-reload the browser for nothing (e.g. uninstalling a never-active plugin).
    if (fs.existsSync(OUTPUT_FILE) && fs.readFileSync(OUTPUT_FILE, 'utf8') === fileContent) {
        console.log(`\n✅ Puck Registry unchanged (${includedPlugins.length} component(s)) — write skipped, no rebuild`);
        return;
    }
    fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
    console.log(`\n✅ Puck Registry generated with ${includedPlugins.length} component(s)`);
}

generateRegistry();
