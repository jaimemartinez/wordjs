#!/usr/bin/env node
/**
 * WordJS Plugin Builder
 * 
 * Compiles plugin frontend code (TSX/JSX) into a production-ready bundle
 * that can be loaded dynamically WITHOUT requiring `next build`.
 * 
 * CRITICAL: Uses externals to prevent React Singleton duplication.
 * The host (WordJS) provides React/ReactDOM at runtime.
 * 
 * Usage:
 *   node scripts/build-plugin.js <plugin-slug>
 *   node scripts/build-plugin.js mail-server
 *   node scripts/build-plugin.js --all
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Defaults to backend/plugins (the installed set). build-marketplace.js points this at
// marketplace/plugins so catalog zips ship their pre-compiled dist/*.bundle.js — without that, a
// marketplace-installed plugin has no runtime bundle and its admin page can't load in production.
const PLUGINS_DIR = path.resolve(process.env.WORDJS_PLUGINS_DIR || path.resolve(__dirname, '../plugins'));

// ============================================
// EXTERNALS CONFIGURATION (Critical for React Singleton)
// ============================================

/**
 * These dependencies are provided by the WordJS host application.
 * They MUST NOT be bundled into the plugin to avoid duplicate instances.
 */
const EXTERNALS = [
    // React Core (CRITICAL - Singleton requirement)
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',

    // Next.js (if used)
    'next',
    'next/*',
    'next/dynamic',
    'next/image',
    'next/link',
    'next/router',
    'next/navigation',

    // ALL WordJS Core (@/* imports) - Host provides these
    '@/*',
    '@/components/*',
    '@/lib/*',
    '@/hooks/*',
    '@/contexts/*',
    '@/providers/*',
    '@/types/*',
    '@/utils/*',
    '@/services/*',
    '@/config/*',
];

/**
 * Global variables that will be available at runtime.
 * These are injected by the WordJS plugin loader.
 */
const GLOBAL_EXTERNALS_MAP = {
    'react': 'WordJS.React',
    'react-dom': 'WordJS.ReactDOM',
    'react-dom/client': 'WordJS.ReactDOMClient',
    'react/jsx-runtime': 'WordJS.JSXRuntime',
    'react/jsx-dev-runtime': 'WordJS.JSXRuntime',
};

// ============================================
// Build Single Plugin
// ============================================

async function buildPlugin(slug) {
    const pluginDir = path.join(PLUGINS_DIR, slug);
    const manifestPath = path.join(pluginDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        console.log(`❌ No manifest.json found for plugin: ${slug}`);
        return false;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Find frontend entry points
    const adminEntry = manifest.frontend?.adminPage?.entry;
    // The Puck block entry. Prefer the explicit puckComponents.entry (what plugins actually declare),
    // then legacy components[0].entry, then the conventional client/puck/<Pascal>Puck.tsx — the SAME
    // resolution generate-puck-plugin-registry.js uses. Without this the block bundle never built (the
    // old code only read the unused `components[0]` key), so marketplace plugins shipped no runtime
    // block and their Puck blocks couldn't load in production.
    let componentEntry = manifest.frontend?.puckComponents?.entry || manifest.frontend?.components?.[0]?.entry;
    if (!componentEntry) {
        const pascal = String(manifest.id || path.basename(pluginDir)).split('-')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        const conv = `client/puck/${pascal}Puck.tsx`;
        if (fs.existsSync(path.join(pluginDir, conv))) componentEntry = conv;
    }
    const hooksEntry = manifest.frontend?.hooks;

    // A DECLARED entry whose file is missing is a build error, not something to skip past. Silently
    // dropping it produced a plugin that installs fine and whose UI is simply absent at runtime — the
    // exact shape of the bug this pipeline keeps hitting (admin pages, then Puck blocks, then hooks).
    // The conventional client/puck/<Pascal>Puck.tsx fallback above is DISCOVERY, not a declaration, so
    // it only reaches here when the file exists.
    const entryPoints = [];
    const missing = [];

    for (const [name, declared] of [['admin', adminEntry], ['component', componentEntry], ['hooks', hooksEntry]]) {
        if (!declared) continue;
        const fullPath = path.join(pluginDir, String(declared).replace('./', ''));
        if (fs.existsSync(fullPath)) entryPoints.push({ name, path: fullPath });
        else missing.push(`${name}: ${declared}`);
    }

    if (missing.length) {
        console.error(`   ❌ ${slug}: manifest declares frontend entr${missing.length > 1 ? 'ies' : 'y'} that do not exist — ${missing.join(', ')}`);
        return false;
    }

    if (entryPoints.length === 0) {
        console.log(`⚪ Plugin ${slug} has no frontend entries, skipping.`);
        return true;
    }

    console.log(`\n🔨 Building plugin: ${slug}`);
    console.log(`   Entry points: ${entryPoints.map(e => e.name).join(', ')}`);

    // Create dist directory
    const distDir = path.join(pluginDir, 'dist');
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // ---- Host runtime surface exposed to plugin bundles ------------------------------------------
    // A plugin bundle must NOT contain its own React or host modules: React must be a singleton (two
    // copies → "Invalid Hook Call") and host modules must be the host's OWN instances (so a plugin's
    // api() shares the host session and useI18n()/useModal() read the host's providers). We rewrite
    // those imports to `globalThis.WordJS.*`, which pluginBundleLoader.ts populates. Leaving them as
    // esbuild `external` instead emits a bare `import ... from "react"`, which a blob-URL module (how
    // the loader evaluates the bundle) CANNOT resolve — that is why runtime plugin loading was dead.
    //
    // Plugins reach host modules TWO ways: the `@/…` path alias AND relative paths into the host tree
    // (e.g. "../../../../../frontend/src/contexts/I18nContext" — older plugins predate the alias). Both
    // are intercepted. Export NAMES are read from the real host source so the virtual module re-exports
    // exactly what the module does (pluginBundleLoader injects each as a namespace, so every name is
    // present at runtime). Keep HOST_MODULES in sync with the imports in pluginBundleLoader.ts — the
    // loud-fail turns any drift into a build error instead of a blank panel in production.
    const HOST_SRC = path.resolve(__dirname, '../../frontend/src');
    const HOST_MODULES = [
        'lib/api', 'lib/i18n', 'lib/plugin-hooks', 'lib/sanitize',
        'contexts/ModalContext', 'contexts/I18nContext', 'contexts/ToastContext', 'contexts/AuthContext',
        'components/MediaPickerModal',
        'components/ui/StatCard', 'components/ui/PageHeader', 'components/ui/Card', 'components/ui/ActionCard',
    ];
    const REACT_GLOBALS = {
        'react': ['WordJS.React', ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useTransition', 'useDeferredValue', 'useId', 'useSyncExternalStore', 'createContext', 'createElement', 'cloneElement', 'isValidElement', 'Children', 'Fragment', 'StrictMode', 'Suspense', 'memo', 'forwardRef', 'lazy', 'startTransition', 'Component', 'PureComponent']],
        'react-dom': ['WordJS.ReactDOM', ['createPortal', 'flushSync', 'render', 'unmountComponentAtNode', 'findDOMNode']],
        'react-dom/client': ['WordJS.ReactDOMClient', ['createRoot', 'hydrateRoot']],
        'react/jsx-runtime': ['WordJS.JSXRuntime', ['jsx', 'jsxs', 'Fragment']],
        'react/jsx-dev-runtime': ['WordJS.JSXRuntime', ['jsx', 'jsxs', 'jsxDEV', 'Fragment']],
    };
    // Extract runtime export names from a host source file (values only — types are erased).
    function hostExportNames(key) {
        const base = path.join(HOST_SRC, key);
        const file = ['.ts', '.tsx', '.js', '.jsx'].map((e) => base + e).find((f) => fs.existsSync(f));
        if (!file) return [];
        const src = fs.readFileSync(file, 'utf8');
        const names = new Set();
        let m;
        const re1 = /export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g;
        while ((m = re1.exec(src))) names.add(m[1]);
        const re2 = /export\s*\{([^}]+)\}(?!\s*from)/g;   // `export { a, b as c }` (not re-exports)
        while ((m = re2.exec(src))) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop().trim();
                if (name && name !== 'default') names.add(name);
            }
        }
        names.delete('default');
        return [...names];
    }
    function shim(runtimeExpr, names) {
        return [
            `const __m = ${runtimeExpr};`,
            `if (!__m) throw new Error(${JSON.stringify(`WordJS host did not provide ${runtimeExpr} — plugin bundle cannot run`)});`,
            `export default (__m && __m.default !== undefined) ? __m.default : __m;`,
            ...names.map((n) => `export const ${n} = __m[${JSON.stringify(n)}];`),
        ].join('\n');
    }
    // Map an import path (alias or relative) to a host-module key, or null if it is not host source.
    function hostKeyFor(importPath, resolveDir) {
        if (importPath.startsWith('@/')) return importPath.slice(2);
        if (/frontend[\\/]src[\\/]/.test(importPath)) {
            const abs = path.resolve(resolveDir, importPath);
            const root = path.resolve(HOST_SRC);
            if (abs === root || abs.startsWith(root + path.sep)) {
                return path.relative(root, abs).split(path.sep).join('/').replace(/\.(tsx?|jsx?)$/, '');
            }
        }
        return null;
    }
    const wordjsGlobals = {
        name: 'wordjs-globals',
        setup(build) {
            build.onResolve({ filter: /^(react($|\/)|react-dom($|\/))/ }, (args) => (
                REACT_GLOBALS[args.path] ? { path: args.path, namespace: 'wjs-react' } : null
            ));
            build.onResolve({ filter: /(^@\/)|(frontend[\\/]src[\\/])/ }, (args) => {
                const key = hostKeyFor(args.path, args.resolveDir);
                if (key == null) return null;                         // a plugin-local relative path
                if (HOST_MODULES.includes(key)) return { path: key, namespace: 'wjs-host' };
                return { errors: [{ text: `Plugin imports host module "${args.path}" (${key}) which is not exposed to plugin bundles. Add it to HOST_MODULES in build-plugin.js and inject it in pluginBundleLoader.ts, or drop the import.` }] };
            });
            build.onLoad({ filter: /.*/, namespace: 'wjs-react' }, (args) => {
                const [globalPath, names] = REACT_GLOBALS[args.path];
                return { contents: shim(`globalThis.${globalPath}`, names), loader: 'js' };
            });
            build.onLoad({ filter: /.*/, namespace: 'wjs-host' }, (args) => {
                const expr = `globalThis.WordJS.host && globalThis.WordJS.host[${JSON.stringify(args.path)}]`;
                return { contents: shim(expr, hostExportNames(args.path)), loader: 'js' };
            });
        },
    };

    // Build each entry point
    for (const entry of entryPoints) {
        const outfile = path.join(distDir, `${entry.name}.bundle.js`);

        try {
            await esbuild.build({
                entryPoints: [entry.path],
                bundle: true,
                format: 'esm',
                target: ['es2020'],
                platform: 'browser',
                outfile: outfile,

                // React & friends resolve to the host-injected globals (see wordjsGlobals above);
                // anything else in EXTERNALS stays a genuine external.
                external: EXTERNALS.filter((e) => !/^(react|react-dom)(\/.*)?$/.test(e)),
                plugins: [wordjsGlobals],

                // Minify for production
                minify: true,

                // Source maps for debugging
                sourcemap: true,

                // Handle JSX
                jsx: 'automatic',

                // Inject banner with metadata. NO build timestamp: this banner is the first line of a
                // bundle that ships inside the marketplace catalog zip, so a `new Date()` here changed
                // every plugin's published sha256 on every build — reproducibility was impossible and
                // each release republished untouched plugins as "changed". Keep it source-derived only.
                banner: {
                    js: `/* WordJS Plugin Bundle: ${slug}/${entry.name} */`
                },

                // Define replacements for imports
                define: {
                    'process.env.NODE_ENV': '"production"'
                },

                // NO ALIAS - All @/* imports are external (provided by host)
                // This prevents bundling core dependencies into plugins

                // Loader for different file types
                loader: {
                    '.tsx': 'tsx',
                    '.ts': 'ts',
                    '.jsx': 'jsx',
                    '.js': 'js',
                    '.css': 'css',
                    '.svg': 'dataurl',
                    '.png': 'dataurl',
                    '.jpg': 'dataurl',
                },
            });

            // Get file size
            const stats = fs.statSync(outfile);
            const sizeKB = (stats.size / 1024).toFixed(1);

            console.log(`   ✅ ${entry.name}.bundle.js (${sizeKB} KB)`);

        } catch (error) {
            console.error(`   ❌ Failed to build ${entry.name}:`, error.message);
            return false;
        }
    }

    // Update manifest with build info.
    // DELIBERATELY has no build timestamp: this file ships inside every marketplace catalog zip, so a
    // `builtAt: new Date()` made each zip's bytes — and therefore its published sha256 — differ on every
    // build. That silently broke reproducibility (nobody could re-derive a published package from the
    // tagged sources) and republished every plugin as "changed" on each release. Keep this object a pure
    // function of the plugin's sources; verify-marketplace.js --rebuild enforces it.
    const buildManifest = {
        slug: slug,
        bundles: entryPoints.map(e => `${e.name}.bundle.js`),
        externals: Object.keys(GLOBAL_EXTERNALS_MAP),
        version: manifest.version || '1.0.0'
    };

    fs.writeFileSync(
        path.join(distDir, 'manifest.build.json'),
        JSON.stringify(buildManifest, null, 2)
    );

    console.log(`   📦 Build complete for ${slug}`);
    return true;
}

// ============================================
// Build All Plugins
// ============================================

async function buildAllPlugins() {
    console.log('🔌 WordJS Plugin Builder\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const folders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const slug of folders) {
        const manifestPath = path.join(PLUGINS_DIR, slug, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            skipped++;
            continue;
        }

        const result = await buildPlugin(slug);
        if (result) {
            success++;
        } else {
            failed++;
        }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 Results: ${success} built, ${failed} failed, ${skipped} skipped`);
}

// ============================================
// CLI
// ============================================

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log('Usage: node build-plugin.js <plugin-slug>');
    console.log('       node build-plugin.js --all');
    process.exit(1);
}

if (args[0] === '--all') {
    buildAllPlugins().catch(console.error);
} else {
    buildPlugin(args[0])
        .then(success => process.exit(success ? 0 : 1))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}
