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

            plugins.push({
                id: manifest.id || folder,
                folder: folder,
                PascalName: toPascalCase(manifest.id || folder),
                importPath: puckPath,
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

    const exports = includedPlugins.map(p =>
        `    "${p.PascalName}": {
        ...${p.PascalName}Puck.puckComponentDef,
        render: ${p.PascalName}Puck.default
    },`
    ).join('\n');

    const fileContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated by: scripts/generate-puck-plugin-registry.js
// Generated at: ${new Date().toISOString()}
// Plugin info is read from each plugin's manifest.json

${imports}

export const puckPluginComponents: Record<string, any> = {
${exports}
};
`;

    fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
    console.log(`\n✅ Puck Registry generated with ${includedPlugins.length} component(s)`);
}

generateRegistry();
