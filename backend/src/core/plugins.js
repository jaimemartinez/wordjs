/**
 * WordJS - Plugin System
 * Equivalent to wp-includes/plugin.php (plugin loading)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { addAction, doAction, addFilter } = require('./hooks');
const { getOption, updateOption } = require('./options');

const PLUGINS_DIR = path.resolve('./plugins');
const ROOT_DIR = path.resolve('.');

/**
 * Install dependencies defined in manifest.json
 */
function installPluginDependencies(slug, manifest) {
    if (!manifest || !manifest.dependencies) return;

    let rootPkg = {};
    try {
        rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    } catch (e) {
        console.error('⚠️ Could not read root package.json', e.message);
    }

    const installed = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    const toInstall = [];

    for (const [dep, version] of Object.entries(manifest.dependencies)) {
        if (!installed[dep]) {
            toInstall.push(`${dep}@${version}`);
        }
    }

    if (toInstall.length > 0) {
        console.log(`📦 Plugin '${slug}' requires: ${toInstall.join(', ')}`);
        console.log(`   ⏳ Installing dependencies... (server may restart)`);
        try {
            execSync(`npm install ${toInstall.join(' ')} --save`, {
                stdio: 'inherit',
                cwd: ROOT_DIR
            });
            console.log(`   ✅ Dependencies installed successfully.`);
        } catch (error) {
            throw new Error(`Failed to install dependencies for ${slug}: ${error.message}`);
        }
    }
}

/**
 * Remove dependencies if not used by other active plugins
 */
function prunePluginDependencies(slug, manifest) {
    if (!manifest || !manifest.dependencies) return;

    // 1. Get all other active plugins
    const activeSlugs = getActivePlugins().filter(s => s !== slug);
    const plugins = scanPlugins();

    const usedDependencies = new Set();

    // 2. Build whitelist of dependencies used by other active plugins
    for (const activeSlug of activeSlugs) {
        const p = plugins.find(pl => pl.slug === activeSlug);
        if (p) {
            const mPath = path.join(p.path, 'manifest.json');
            if (fs.existsSync(mPath)) {
                try {
                    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
                    if (m.dependencies) {
                        for (const dep of Object.keys(m.dependencies)) {
                            usedDependencies.add(dep);
                        }
                    }
                } catch { }
            }
        }
    }

    // 3. Check for unused dependencies
    const toRemove = [];

    for (const dep of Object.keys(manifest.dependencies)) {
        if (!usedDependencies.has(dep)) {
            // Check if it's a known core dependency (Shield for core packages)
            const isLikelyCore = ['express', 'cors', 'dotenv', 'helmet', 'multer', 'nodemailer', 'sql.js', 'mongoose', 'pg', 'sqlite3', 'jsonwebtoken', 'bcryptjs'].includes(dep);

            if (isLikelyCore) {
                console.log(`🛡️ Persisting core dependency: ${dep}`);
            } else {
                toRemove.push(dep);
            }
        }
    }

    if (toRemove.length > 0) {
        console.log(`♻️ Garbage Collector: Removing unused dependencies for ${slug}: ${toRemove.join(', ')}`);
        try {
            // execSync(`npm uninstall ${toRemove.join(' ')} --save`, { stdio: 'inherit', cwd: ROOT_DIR }); // Disabled for safety until explicit confirm
            console.log(`   (Simulated verify): npm uninstall ${toRemove.join(' ')}`);
        } catch (e) {
            console.error(`   ⚠️ Failed to prune dependencies:`, e.message);
        }
    }
}

const PLUGINS_DIR_REAL = path.resolve('./plugins'); // Just to keep logic if needed, but we reused PLUGINS_DIR above.

// Loaded plugins registry
const loadedPlugins = new Map();

/**
 * Plugin metadata structure
 */
class Plugin {
    constructor(data) {
        this.name = data.name;
        this.slug = data.slug;
        this.version = data.version || '1.0.0';
        this.description = data.description || '';
        this.author = data.author || '';
        this.path = data.path;
        this.active = data.active || false;
        this.init = data.init || null;
        this.deactivate = data.deactivate || null;
    }
}

/**
 * Ensure plugins directory exists
 */
function ensurePluginsDir() {
    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }
}

/**
 * Scan for installed plugins
 * Plugins must have a main.js or index.js file with metadata export
 */
function scanPlugins() {
    ensurePluginsDir();
    const plugins = [];

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'manifest.json');

        let metadata = {};
        let mainFile = null;

        // 1. Try manifest.json (Preferred - Safe)
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                metadata = {
                    name: manifest.name,
                    version: manifest.version,
                    description: manifest.description,
                    author: manifest.author
                };
                // We don't load init/deactivate here to avoid requiring the file before deps match
            } catch (e) {
                console.error(`Error parsing manifest for ${entry.name}:`, e.message);
                continue;
            }
        }
        // 2. Fallback to finding main file (Legacy)
        else {
            mainFile = findMainFile(pluginDir);
            if (!mainFile) continue;

            try {
                const pluginModule = require(mainFile);
                metadata = pluginModule.metadata || {};
            } catch (error) {
                console.error(`Error loading plugin ${entry.name}:`, error.message);
                continue;
            }
        }

        plugins.push(new Plugin({
            name: metadata.name || entry.name,
            slug: entry.name,
            version: metadata.version || '1.0.0',
            description: metadata.description || '',
            author: metadata.author || '',
            path: pluginDir,
            // We defer loading 'init' and 'deactivate' hooks until activation/load time
            // However, existing code expects them in the object.
            // If we didn't require the module, these will be undefined.
            // 'activatePlugin' should handle re-requiring the module.
            init: null,
            deactivate: null
        }));
    }

    return plugins;
}

/**
 * Find main plugin file
 */
function findMainFile(pluginDir) {
    const candidates = ['index.js', 'main.js', 'plugin.js'];

    for (const candidate of candidates) {
        const filePath = path.join(pluginDir, candidate);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }

    return null;
}

/**
 * Get list of active plugin slugs
 */
function getActivePlugins() {
    return getOption('active_plugins', []);
}

/**
 * Check if plugin is active
 */
function isPluginActive(slug) {
    const active = getActivePlugins();
    return active.includes(slug);
}

const { getApp } = require('./appRegistry');

// ...

/**
 * Fix middleware order (move error handlers to end)
 * This allows dynamic routes from plugins to work without restart
 */
function fixMiddlewareOrder() {
    const app = getApp();
    if (!app || !app._router || !app._router.stack) return;

    const stack = app._router.stack;
    const errorHandlers = [];

    // Find and remove error handlers (iterating backwards)
    for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (layer.handle.name === 'notFound' || layer.handle.name === 'errorHandler') {
            // Remove from stack and add to temp array
            // splice returns array, we take first element
            errorHandlers.unshift(stack.splice(i, 1)[0]);
        }
    }

    // Re-add error handlers at the end
    // errorHandlers should maintain order: [notFound, errorHandler]
    if (errorHandlers.length > 0) {
        stack.push(...errorHandlers);
        // console.log('🔄 Middleware stack reordered: Error handlers moved to end.');
    }
}

/**
 * Activate a plugin
 */
async function activatePlugin(slug) {
    const plugins = scanPlugins();
    const plugin = plugins.find(p => p.slug === slug);

    if (!plugin) {
        throw new Error(`Plugin ${slug} not found`);
    }

    if (isPluginActive(slug)) {
        return { success: true, message: 'Plugin already active' };
    }

    // 1. Dependency Check & Auto-Install
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            installPluginDependencies(slug, manifest);
        } catch (e) {
            console.error(`⚠️ Failed to process manifest for ${slug}:`, e.message);
        }
    }

    // Load and initialize plugin
    const mainFile = findMainFile(plugin.path);
    if (!mainFile) {
        throw new Error(`Plugin ${slug} has no main file`);
    }

    try {
        // Clear require cache to ensure fresh load
        const resolvedPath = require.resolve(mainFile);
        delete require.cache[resolvedPath];

        const pluginModule = require(mainFile);

        // Call init/activate function if exists
        if (typeof pluginModule.init === 'function') {
            await pluginModule.init();
        } else if (typeof pluginModule.activate === 'function') {
            await pluginModule.activate();
        }

        // Reorder middleware to ensure plugin routes work
        fixMiddlewareOrder();

        // Add to active plugins
        const active = getActivePlugins();
        active.push(slug);
        updateOption('active_plugins', active);

        loadedPlugins.set(slug, pluginModule);

        await doAction('activated_plugin', slug);

        return { success: true, message: `Plugin ${slug} activated` };
    } catch (error) {
        throw new Error(`Failed to activate plugin ${slug}: ${error.message}`);
    }
}

// ...

/**
 * Deactivate a plugin
 */
async function deactivatePlugin(slug) {
    if (!isPluginActive(slug)) {
        return { success: true, message: 'Plugin not active' };
    }

    // 1. Auto-Prune Dependencies
    const plugins = scanPlugins();
    const plugin = plugins.find(p => p.slug === slug);
    if (plugin) {
        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                prunePluginDependencies(slug, manifest);
            } catch (e) {
                console.error(`⚠️ Failed to process manifest for prune ${slug}:`, e.message);
            }
        }
    }

    const pluginModule = loadedPlugins.get(slug);

    // Call deactivate function if exists
    if (pluginModule && typeof pluginModule.deactivate === 'function') {
        await pluginModule.deactivate();
    }

    // Remove from active plugins
    const active = getActivePlugins();
    const index = active.indexOf(slug);
    if (index > -1) {
        active.splice(index, 1);
        updateOption('active_plugins', active);
    }

    loadedPlugins.delete(slug);

    await doAction('deactivated_plugin', slug);

    return { success: true, message: `Plugin ${slug} deactivated` };
}

/**
 * Load all active plugins
 */
async function loadActivePlugins() {
    const activePlugins = getActivePlugins();
    const plugins = scanPlugins();

    for (const slug of activePlugins) {
        const plugin = plugins.find(p => p.slug === slug);
        if (!plugin) continue;

        const mainFile = findMainFile(plugin.path);
        if (!mainFile) continue;

        // Auto-Check/Install Deps on Load
        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                installPluginDependencies(slug, manifest);
            } catch (e) {
                console.error(`⚠️ Failed to process manifest for load ${slug}:`, e.message);
            }
        }

        try {
            const pluginModule = require(mainFile);

            if (typeof pluginModule.init === 'function') {
                await pluginModule.init();
            }

            loadedPlugins.set(slug, pluginModule);
            console.log(`   ✓ Plugin loaded: ${plugin.name}`);
        } catch (error) {
            console.error(`   ✗ Failed to load plugin ${slug}:`, error.message);
        }
    }
}

/**
 * Get all plugins with their status
 */
function getAllPlugins() {
    const plugins = scanPlugins();
    const active = getActivePlugins();

    return plugins.map(plugin => ({
        ...plugin,
        active: active.includes(plugin.slug)
    }));
}

/**
 * Create sample plugin
 */
function createSamplePlugin() {
    const sampleDir = path.join(PLUGINS_DIR, 'hello-world');

    if (fs.existsSync(sampleDir)) return;

    fs.mkdirSync(sampleDir, { recursive: true });

    const sampleCode = `/**
 * Hello World Plugin for WordJS
 */

// Plugin metadata
exports.metadata = {
  name: 'Hello World',
  version: '1.0.0',
  description: 'A sample plugin that adds a greeting filter',
  author: 'WordJS'
};

// Called when plugin is activated
exports.init = function() {
  const { addFilter } = require('../../src/core/hooks');
  
  // Add a filter to post content
  addFilter('the_content', (content) => {
    return '<p><em>Hello from the Hello World plugin!</em></p>' + content;
  });
  
  console.log('Hello World plugin initialized!');
};

// Called when plugin is deactivated
exports.deactivate = function() {
  console.log('Hello World plugin deactivated!');
};
`;

    fs.writeFileSync(path.join(sampleDir, 'index.js'), sampleCode);
}

module.exports = {
    scanPlugins,
    getActivePlugins,
    isPluginActive,
    activatePlugin,
    deactivatePlugin,
    loadActivePlugins,
    getAllPlugins,
    createSamplePlugin,
    PLUGINS_DIR
};
