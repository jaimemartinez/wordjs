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

const PLUGINS_DIR = path.resolve(__dirname, '../plugins');

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
    const componentEntry = manifest.frontend?.components?.[0]?.entry;
    const hooksEntry = manifest.frontend?.hooks;

    const entryPoints = [];

    if (adminEntry) {
        const fullPath = path.join(pluginDir, adminEntry.replace('./', ''));
        if (fs.existsSync(fullPath)) {
            entryPoints.push({ name: 'admin', path: fullPath });
        }
    }

    if (componentEntry) {
        const fullPath = path.join(pluginDir, componentEntry.replace('./', ''));
        if (fs.existsSync(fullPath)) {
            entryPoints.push({ name: 'component', path: fullPath });
        }
    }

    if (hooksEntry) {
        const fullPath = path.join(pluginDir, hooksEntry.replace('./', ''));
        if (fs.existsSync(fullPath)) {
            entryPoints.push({ name: 'hooks', path: fullPath });
        }
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

                // CRITICAL: External dependencies (prevents React duplication)
                external: EXTERNALS,

                // Minify for production
                minify: true,

                // Source maps for debugging
                sourcemap: true,

                // Handle JSX
                jsx: 'automatic',

                // Inject banner with metadata
                banner: {
                    js: `/* WordJS Plugin Bundle: ${slug}/${entry.name} - Built ${new Date().toISOString()} */`
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

    // Update manifest with build info
    const buildManifest = {
        slug: slug,
        builtAt: new Date().toISOString(),
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
