/**
 * generate-portal-plugin-registry.js
 *
 * Generates the registry of plugin PORTAL pages — the standalone public page a plugin may declare,
 * mounted at /portal/<slug> (and every path below it) by src/app/portal/[slug]/[[...path]]/page.tsx:
 *
 *   "frontend": { "portalPage": { "entry": "client/portal/page.tsx", "slug": "my-portal", … } }
 *
 * Writes src/lib/portalPluginRegistry.ts (generated, untracked, "use client"): portal slug → dynamic
 * import of the entry. Only the client portal host imports it, so a plugin's page is never pulled into
 * a server bundle. A portal installed at RUNTIME (marketplace, production build) is not in it: the page
 * loads its dist/portal.bundle.js instead. Whether a portal exists at all, and its <head> details, are
 * the backend's answer (GET /api/v1/plugins/<slug>/portal), never this file's.
 *
 * READS FROM: Each plugin's manifest.json
 * NO HARDCODED PLUGIN CONFIGURATIONS
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { releasePluginSelection } = require('./hermetic-plugins');

const PLUGINS_DIR = path.resolve(__dirname, '../../backend/plugins');
const OUTPUT_FILE = path.resolve(__dirname, '../src/lib/portalPluginRegistry.ts');
const API_URL = 'http://localhost:3000/api/v1/plugins/active';

// The slug and entry rules of backend/src/core/portal-pages.ts (validatePortalPage), which refuses any
// other shape at install and activation. Re-checked here because this script also reads folders nobody
// installed through the backend, and because both values are written into TypeScript source.
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PORTAL_ENTRY_RE = /^(?:\.\/)?client\/[A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js)$/;
const PLUGIN_FOLDER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// RELEASE BUILD (WORDJS_HERMETIC_BUILD=1): the plugins compiled in are the ones git tracks — never
// what this machine's running backend reports as active, nor its untracked plugin folders. See
// hermetic-plugins.js. null outside a release build.
const RELEASE = releasePluginSelection(PLUGINS_DIR);

/**
 * Fetch active plugins from backend API
 */
function fetchActivePlugins() {
    // Release build: no active-list filter — every tracked plugin, exactly as a clean CI build has.
    if (RELEASE) return Promise.resolve(null);
    // Authoritative path: the backend (regenerateRegistry) passes the active list via env when it
    // spawns this script — no network, no race with uninstall's dir deletion.
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

/** The manifest's portal page { slug, entry } if both are well-formed, else null (reason logged). */
function portalPageOf(folder, manifest) {
    const page = manifest.frontend?.portalPage;
    if (page === undefined || page === null) return null;
    const bad = (why) => { console.log(`   ✗ Invalid portal page: ${folder} — ${why}`); return null; };
    if (typeof page !== 'object' || Array.isArray(page)) return bad('frontend.portalPage must be an object');
    if (typeof page.slug !== 'string' || !PORTAL_SLUG_RE.test(page.slug)) return bad('invalid slug');
    if (typeof page.entry !== 'string' || !PORTAL_ENTRY_RE.test(page.entry) || page.entry.split('/').includes('..')) {
        return bad('entry must be a source file under client/');
    }
    return { slug: page.slug, entry: page.entry.replace(/^\.\//, '') };
}

/**
 * Discover plugins with a portal page from manifest.json
 */
function discoverPluginsWithPortal() {
    const plugins = [];

    if (!fs.existsSync(PLUGINS_DIR)) {
        return plugins;
    }

    const folders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && PLUGIN_FOLDER_RE.test(d.name))
        .map(d => d.name)
        .filter(name => !RELEASE || RELEASE.includes(name))
        .sort();

    for (const folder of folders) {
        const manifestPath = path.join(PLUGINS_DIR, folder, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            continue;
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const page = portalPageOf(folder, manifest);
            if (!page) continue;

            if (!fs.existsSync(path.join(PLUGINS_DIR, folder, page.entry))) {
                console.log(`   ✗ Portal page not found: ${folder} (${page.entry})`);
                continue;
            }

            plugins.push({
                id: manifest.id || folder,
                folder,
                slug: page.slug,
                // Extension-less, like the other registries' imports.
                importPath: page.entry.replace(/\.(?:tsx|ts|jsx|js)$/, ''),
            });
        } catch (err) {
            console.log(`   ✗ Invalid manifest: ${folder} - ${err.message}`);
        }
    }

    return plugins;
}

async function generatePortalRegistry() {
    console.log('📋 Generating portal plugin registry from manifests...');

    const allPlugins = discoverPluginsWithPortal();
    console.log(`   Found ${allPlugins.length} plugin(s) with a portal page`);

    const fetched = await fetchActivePlugins();
    const filterByActive = Array.isArray(fetched);
    const activeList = filterByActive ? fetched : [];
    if (filterByActive) {
        console.log(`   Active from API: ${activeList.join(', ') || 'none'}`);
    } else {
        console.log('   ⚠️  Filtering disabled (API unavailable or invalid response)');
    }

    const candidates = allPlugins.filter(p => {
        if (filterByActive && !activeList.includes(p.id)) {
            console.log(`   ○ Inactive: ${p.id}`);
            return false;
        }
        return true;
    });

    // A portal slug two plugins claim is nobody's (the backend refuses the second at install and
    // activation; this only meets it in folders copied by hand). Never pick one by folder order.
    const claims = new Map();
    for (const p of candidates) claims.set(p.slug, (claims.get(p.slug) || 0) + 1);
    const plugins = candidates.filter(p => {
        if (claims.get(p.slug) > 1) {
            console.log(`   ✗ Portal "${p.slug}" is declared by several plugins — none is included (${p.id})`);
            return false;
        }
        console.log(`   ✓ Included: /portal/${p.slug} -> ${p.id}`);
        return true;
    });

    // Both interpolated values are validated above, and quoted with JSON.stringify anyway.
    const imports = plugins.map(p =>
        `    ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(`../../../backend/plugins/${p.folder}/${p.importPath}`)}),`
    ).join('\n');

    const content = `"use client";

/**
 * AUTO-GENERATED FILE - Do not edit directly!
 *
 * Generated by: scripts/generate-portal-plugin-registry.js
 *
 * Plugin portal pages compiled into this build: portal slug → the plugin's portal entry. A portal
 * installed at runtime is not here; src/app/portal/[slug]/[[...path]] loads its dist/portal.bundle.js instead.
 */

export const PORTAL_PAGES: Record<string, () => Promise<any>> = {
${imports}
};
`;

    // Write-if-changed: an identical rewrite still bumps mtime, which makes Next/Turbopack
    // invalidate + full-reload the browser for nothing.
    //
    // THE READ IS THE EXISTENCE CHECK — same reasoning as generate-plugin-registry.js.
    let current = null;
    try {
        current = fs.readFileSync(OUTPUT_FILE, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR' && e.code !== 'EISDIR') throw e;
    }
    if (current === content) {
        console.log(`\n✅ Portal registry unchanged (${plugins.length} plugin(s)) — write skipped, no rebuild`);
        return;
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true }); // generated + untracked: the dir may not exist
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`\n✅ Portal registry generated with ${plugins.length} plugin(s)`);
}

generatePortalRegistry();
