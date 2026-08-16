/**
 * generate-verso-plugin-registry.js
 *
 * Generates versoPluginRegistry.ts based on ACTIVE plugins only.
 * Called automatically when plugins are activated/deactivated.
 *
 * READS FROM: Each plugin's manifest.json
 * NO HARDCODED PLUGIN CONFIGURATIONS
 *
 * NAMING: the HOST side of this file is Verso (output file, exported symbol). The PLUGIN side is
 * NOT: an installed plugin may declare its block under the historical `frontend.puckComponents`
 * manifest key, in a `client/puck/` folder, exporting `puckComponents` / `puckComponentDef`. Those
 * installs are out there and nobody is going to edit them. Every plugin-facing name is therefore read
 * in BOTH spellings, new first, by the single shared resolver in
 * backend/scripts/plugin-block-contract.js — which is also what build-plugin.js and
 * verify-marketplace.js use, so the registry can never disagree with the bundler about where a
 * plugin's block is.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { resolveBlockEntry, resolveBlockExports, toPascalCase } = require('../../backend/scripts/plugin-block-contract');

// WORDJS_PLUGINS_DIR / WORDJS_VERSO_REGISTRY_OUT let the compatibility test drive THIS script — the
// real generator — over a fixture tree of old- and new-convention plugins. A test that re-implements
// the resolution instead of running the shipping script proves nothing about the shipping script.
// They move only the DISCOVERY root and the output path; the import prefix emitted below stays
// `../../../backend/plugins/…`, so the override is a test seam and not a deployment knob.
const PLUGINS_DIR = path.resolve(process.env.WORDJS_PLUGINS_DIR || path.resolve(__dirname, '../../backend/plugins'));
const OUTPUT_FILE = path.resolve(process.env.WORDJS_VERSO_REGISTRY_OUT || path.resolve(__dirname, '../src/lib/versoPluginRegistry.ts'));
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
 * Discover plugins that ship editor blocks, from manifest.json
 */
function discoverBlockPlugins() {
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
            const pluginDir = path.join(PLUGINS_DIR, folder);

            // Manifest declaration (versoComponents, then the deprecated puckComponents) and, failing
            // that, the folder convention (client/verso/<Pascal>Verso.tsx, then the deprecated
            // client/puck/<Pascal>Puck.tsx). The legacy `frontend.components[]` channel is NOT read
            // here — those files export neither block shape, and importing one would be a hard
            // Turbopack build error rather than a missing block.
            const block = resolveBlockEntry(pluginDir, manifest);
            if (!block) continue;

            const rel = block.entry.replace('./', '');
            const fullPath = path.join(pluginDir, rel);

            // Only a DECLARED entry can be missing: a convention hit is proved on disk before it is
            // returned. Keep it a skip-with-a-line, not a throw — one broken plugin must not take the
            // whole registry (and therefore the whole frontend build) down with it.
            if (!fs.existsSync(fullPath)) {
                console.log(`   ✗ Block component not found: ${folder} (${block.entry})`);
                continue;
            }

            // A plugin can expose MULTIPLE blocks via `export const versoComponents` (historically
            // `puckComponents`), or a single block via `versoComponentDef`/`puckComponentDef` plus a
            // default export. Read the entry to learn which member name to emit — Turbopack
            // hard-errors on an `import * as X` member that is not a real export, so it is never
            // assumed.
            plugins.push({
                id: manifest.id || folder,
                folder: folder,
                PascalName: toPascalCase(manifest.id || folder),
                importPath: rel.replace(/\.tsx?$/, ''),
                ...resolveBlockExports(fullPath),
            });

        } catch (err) {
            console.log(`   ✗ Invalid manifest: ${folder} - ${err.message}`);
        }
    }

    return plugins;
}

async function generateRegistry() {
    console.log('🔌 Generating Verso plugin registry from manifests...');

    // Discover all plugins that ship editor blocks
    const allPlugins = discoverBlockPlugins();
    console.log(`   Found ${allPlugins.length} plugin(s) with editor blocks`);

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
        `import * as ${p.PascalName}Blocks from "../../../backend/plugins/${p.folder}/${p.importPath}";`
    ).join('\n');

    // Emit ONLY the reference that exists on each module (see resolveBlockExports) — Turbopack
    // statically errors on any `import * as X` member that isn't an actual export, which is exactly
    // why the member NAME is resolved from the plugin's source instead of assumed.
    const exports = includedPlugins.map(p => p.multi
        ? `    ...${p.PascalName}Blocks.${p.member},`
        : `    "${p.PascalName}": {
        ...${p.PascalName}Blocks.${p.member},
        render: ${p.PascalName}Blocks.default
    },`
    ).join('\n');

    const fileContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated by: scripts/generate-verso-plugin-registry.js
// Plugin info is read from each plugin's manifest.json

${imports}

export const versoPluginComponents: Record<string, any> = {
${exports}
};
`;

    // Write-if-changed: an identical rewrite still bumps mtime, which makes Next/Turbopack
    // invalidate + full-reload the browser for nothing (e.g. uninstalling a never-active plugin).
    if (fs.existsSync(OUTPUT_FILE) && fs.readFileSync(OUTPUT_FILE, 'utf8') === fileContent) {
        console.log(`\n✅ Verso Registry unchanged (${includedPlugins.length} component(s)) — write skipped, no rebuild`);
        return;
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true }); // generated + untracked: the dir may not exist
    fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
    console.log(`\n✅ Verso Registry generated with ${includedPlugins.length} component(s)`);
}

generateRegistry();
