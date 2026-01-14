/**
 * WordJS - Plugin System
 * Equivalent to wp-includes/plugin.php (plugin loading)
 */

const fs = require('fs');
const path = require('path');
const { addAction, doAction, addFilter } = require('./hooks');
const { getOption, updateOption } = require('./options');

const PLUGINS_DIR = path.resolve('./plugins');

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
        const mainFile = findMainFile(pluginDir);

        if (!mainFile) continue;

        try {
            const pluginModule = require(mainFile);
            const metadata = pluginModule.metadata || {};

            plugins.push(new Plugin({
                name: metadata.name || entry.name,
                slug: entry.name,
                version: metadata.version,
                description: metadata.description,
                author: metadata.author,
                path: pluginDir,
                init: pluginModule.init || pluginModule.activate,
                deactivate: pluginModule.deactivate
            }));
        } catch (error) {
            console.error(`Error loading plugin ${entry.name}:`, error.message);
        }
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
