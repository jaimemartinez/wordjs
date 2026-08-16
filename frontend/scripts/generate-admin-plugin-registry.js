/**
 * generate-admin-plugin-registry.js
 * 
 * Generates the admin plugin registry for dynamic routes.
 * Maps plugin slugs to their admin page component paths.
 * 
 * READS FROM: Each plugin's manifest.json
 * NO HARDCODED PLUGIN CONFIGURATIONS
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PLUGINS_DIR = path.resolve(__dirname, '../../backend/plugins');
const OUTPUT_FILE = path.resolve(__dirname, '../src/app/admin/plugin/[slug]/page.tsx');
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
 * Discover plugins with admin pages from manifest.json
 */
function discoverPluginsWithAdmin() {
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

            // Check if plugin has admin page defined in manifest
            const adminPage = manifest.frontend?.adminPage;
            if (!adminPage?.entry || !adminPage?.slug) {
                continue;
            }

            // Verify admin page file exists
            const adminPath = adminPage.entry.replace('./', '').replace('.tsx', '');
            const fullPath = path.join(PLUGINS_DIR, folder, adminPage.entry.replace('./', ''));

            if (!fs.existsSync(fullPath)) {
                console.log(`   ✗ Admin page not found: ${folder} (${adminPage.entry})`);
                continue;
            }

            plugins.push({
                id: manifest.id || folder,
                folder: folder,
                adminSlug: adminPage.slug,
                adminPath: adminPath,
            });

        } catch (err) {
            console.log(`   ✗ Invalid manifest: ${folder} - ${err.message}`);
        }
    }

    return plugins;
}

async function generateAdminRegistry() {
    console.log('📋 Generating admin plugin registry from manifests...');

    // Discover all plugins with admin pages
    const allPlugins = discoverPluginsWithAdmin();
    console.log(`   Found ${allPlugins.length} plugin(s) with admin pages`);

    // Fetch active plugins from API
    const fetched = await fetchActivePlugins();
    const filterByActive = Array.isArray(fetched);
    const activeList = filterByActive ? fetched : [];

    if (filterByActive) {
        console.log(`   Active from API: ${activeList.join(', ') || 'none'}`);
    } else {
        console.log('   ⚠️  Filtering disabled (API unavailable or invalid response)');
    }

    // Filter to only active plugins
    const availablePlugins = allPlugins.filter(p => {
        if (filterByActive && !activeList.includes(p.id)) {
            console.log(`   ○ Inactive: ${p.id}`);
            return false;
        }
        console.log(`   ✓ Included: ${p.adminSlug} -> ${p.id}`);
        return true;
    });

    // Generate imports
    const imports = availablePlugins.map(p =>
        `    "${p.adminSlug}": () => import("../../../../../../backend/plugins/${p.folder}/${p.adminPath}"),`
    ).join('\n');

    // Slug → plugin FOLDER id. The URL uses adminPage.slug, but a plugin's static assets
    // (admin.css, manifest.json) are served from /plugins/<folder-id>/ — which frequently differs
    // from the slug (e.g. slug "store" → folder "online-store", "youtube" → "youtube-videos").
    // Without this map the admin-stylesheet feature silently 404s for every slug≠folder plugin.
    const dirMap = availablePlugins.map(p => `    "${p.adminSlug}": "${p.folder}",`).join('\n');

    const content = `"use client";

/**
 * AUTO-GENERATED FILE - Do not edit directly!
 * 
 * Generated by: scripts/generate-admin-plugin-registry.js
 *
 * Plugin info is read from each plugin's manifest.json
 */

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, Suspense } from "react";
import { createRemotePluginComponent } from "@/lib/pluginBundleLoader";

const PLUGIN_ADMIN_PAGES: Record<string, () => Promise<any>> = {
${imports}
};

// Maps the URL admin-slug to the plugin's on-disk FOLDER id, so admin.css / manifest.json are
// fetched from the correct /plugins/<folder>/ path (the slug and folder often differ).
const PLUGIN_ADMIN_DIRS: Record<string, string> = {
${dirMap}
};

function LoadingFallback() {
    return (
        <div className="p-8 flex items-center justify-center">
            <div className="text-center">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4 font-black"></div>
                <p className="text-gray-500">Loading plugin...</p>
            </div>
        </div>
    );
}

function PluginNotFound({ slug }: { slug: string }) {
    return (
        <div className="p-8 text-center">
            <div className="text-6xl mb-4">🔌</div>
            <h1 className="text-2xl font-bold text-gray-800 mb-2">Plugin Not Found</h1>
            <p className="text-gray-600 mb-4">
                The plugin <code className="bg-gray-100 px-2 py-1 rounded">{slug}</code> is not installed.
            </p>
            <a href="/admin/plugins" className="text-blue-600 hover:underline font-bold">
                ← Back to Plugins
            </a>
        </div>
    );
}

export default function PluginAdminPage() {
    const params = useParams();
    const slug = params.slug as string;
    const [hasCss, setHasCss] = useState(false);
    const [themeStyle, setThemeStyle] = useState("");

    // Static assets are served under the plugin's FOLDER id, which can differ from the URL slug.
    const dir = PLUGIN_ADMIN_DIRS[slug] || slug;
    const cssUrl = \`/plugins/\${dir}/client/admin/admin.css\`;

    useEffect(() => {
        if (!slug) return;
        setHasCss(false);
        setThemeStyle("");

        // Check for admin.css existence
        fetch(cssUrl, { method: "HEAD" })
            .then((res) => {
                if (res.ok) setHasCss(true);
            })
            .catch(() => {});

        // Fetch manifest.json to check for style/theme fields. The plugin admin page is already
        // trusted first-party JS, but this string reaches a dangerouslySetInnerHTML sink, so strip
        // characters that could break out of the injected <style> ('}' rule breakout, '<' tag
        // breakout, '@'/';' extra rules) — defense in depth, not the sandbox boundary.
        fetch(\`/plugins/\${dir}/manifest.json\`)
            .then((res) => res.json())
            .then((manifest) => {
                const clean = (s: unknown) => String(s).replace(/[<>{}@;]/g, "");
                if (typeof manifest.style === "string" && manifest.style) {
                    setThemeStyle(manifest.style.replace(/</g, ""));
                } else if (manifest.theme && typeof manifest.theme === "object") {
                    const vars = Object.entries(manifest.theme)
                        .filter(([key]) => /^[a-zA-Z0-9-]+$/.test(key))
                        .map(([key, val]) => \`--plugin-\${key}: \${clean(val)};\`)
                        .join(" ");
                    if (vars) setThemeStyle(\`.plugin-admin-\${slug} { \${vars} }\`);
                }
            })
            .catch(() => {});
    }, [slug, cssUrl, dir]);

    // Plugins present at BUILD time are compiled into the map above. Plugins installed at RUNTIME
    // (from the marketplace) can NEVER be in it: a production install ships a pre-built .next and has
    // no rebuild step, so the map is frozen at whatever shipped. Fall back to the runtime loader,
    // which fetches the plugin's pre-compiled dist/admin.bundle.js from the backend. Without this
    // fallback EVERY marketplace-installed plugin's admin page renders "Plugin Not Found" in prod.
    const PluginPage = useMemo(() => {
        const staticLoader = PLUGIN_ADMIN_PAGES[slug];
        if (staticLoader) {
            return dynamic(
                () => staticLoader().catch(() => ({ default: () => <PluginNotFound slug={slug} /> })),
                { loading: () => <LoadingFallback />, ssr: false }
            );
        }
        return createRemotePluginComponent(slug, "admin", () => <PluginNotFound slug={slug} />);
    }, [slug]);

    return (
        <div className={\`plugin-admin-wrapper plugin-admin-\${slug} h-full overflow-y-auto custom-scrollbar\`}>
            {themeStyle && <style dangerouslySetInnerHTML={{ __html: themeStyle }} />}
            {hasCss && <link rel="stylesheet" href={cssUrl} />}
            <Suspense fallback={<LoadingFallback />}>
                <PluginPage />
            </Suspense>
        </div>
    );
}
`;

    // Write-if-changed: an identical rewrite still bumps mtime, which makes Next/Turbopack
    // invalidate + full-reload the browser for nothing (e.g. uninstalling a never-active plugin).
    //
    // THE READ IS THE EXISTENCE CHECK — same reasoning as generate-plugin-registry.js: an
    // existsSync() before the read is a check-then-use race, and losing this file is a hard build
    // error rather than a missing plugin. "Could not read it" means "rewrite"; any other errno
    // still throws.
    let current = null;
    try {
        current = fs.readFileSync(OUTPUT_FILE, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR' && e.code !== 'EISDIR') throw e;
    }
    if (current === content) {
        console.log(`\n✅ Admin registry unchanged (${availablePlugins.length} plugin(s)) — write skipped, no rebuild`);
        return;
    }
    // Create the output directory. This file is GENERATED and untracked, and it is the only thing in
    // `src/app/admin/plugin/[slug]/` — so on a fresh checkout that directory does not exist at all and
    // writeFileSync fails with ENOENT. It used to work only because the file was committed.
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`\n✅ Admin registry generated with ${availablePlugins.length} plugin(s)`);
}

generateAdminRegistry();
