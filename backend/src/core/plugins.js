/**
 * WordJS - Plugin System
 * Equivalent to wp-includes/plugin.php (plugin loading)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { addAction, doAction, addFilter } = require('./hooks');
const { getOption, updateOption } = require('./options');

const semver = require('semver');

const PLUGINS_DIR = path.resolve('./plugins');
const ROOT_DIR = path.resolve('.');

/**
 * Check if a plugin is bundled (has its own dependencies packaged)
 * A plugin is considered bundled if:
 * 1. manifest.json has "bundled": true
 * 2. Plugin has its own node_modules/ directory
 * 3. Plugin has a dist/*.bundle.js file
 */
function isBundledPlugin(pluginPath, manifest = {}) {
    // 1. Explicit flag in manifest
    if (manifest.bundled === true) {
        return true;
    }

    // 2. Has own node_modules
    const nodeModulesPath = path.join(pluginPath, 'node_modules');
    if (fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory()) {
        // Check it's not empty
        try {
            const contents = fs.readdirSync(nodeModulesPath);
            if (contents.length > 0) {
                return true;
            }
        } catch { }
    }

    // 3. Has bundle file in dist/
    const distPath = path.join(pluginPath, 'dist');
    if (fs.existsSync(distPath) && fs.statSync(distPath).isDirectory()) {
        try {
            const files = fs.readdirSync(distPath);
            if (files.some(f => f.endsWith('.bundle.js'))) {
                return true;
            }
        } catch { }
    }

    return false;
}

/**
 * Check for dependency conflicts between a plugin and active plugins
 * Uses SemVer to determine if version ranges are compatible
 * 
 * @param {string} slug - Plugin slug being activated
 * @param {object} manifest - Plugin manifest with dependencies
 * @returns {{ compatible: boolean, conflicts: Array<{dep: string, newRange: string, existingRange: string, conflictPlugin: string}> }}
 */
async function checkDependencyConflicts(slug, manifest) {
    if (!manifest || !manifest.dependencies) {
        return { compatible: true, conflicts: [] };
    }

    const conflicts = [];
    const activePlugins = await getActivePlugins();
    const plugins = scanPlugins();

    // Build map of all dependencies from active plugins
    const activeDependencies = new Map(); // dep -> { range, pluginSlug }

    for (const activeSlug of activePlugins) {
        if (activeSlug === slug) continue; // Skip self

        const plugin = plugins.find(p => p.slug === activeSlug);
        if (!plugin) continue;

        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const activeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Skip bundled plugins - they don't contribute to shared dependencies
            if (isBundledPlugin(plugin.path, activeManifest)) continue;

            if (activeManifest.dependencies) {
                for (const [dep, range] of Object.entries(activeManifest.dependencies)) {
                    activeDependencies.set(dep, { range, pluginSlug: activeSlug });
                }
            }
        } catch { }
    }

    // Check each new dependency against existing ones
    for (const [dep, newRange] of Object.entries(manifest.dependencies)) {
        if (!activeDependencies.has(dep)) continue;

        const existing = activeDependencies.get(dep);
        const existingRange = existing.range;

        // Check if ranges intersect (have at least one common version)
        // We do this by checking if there's a version that satisfies both
        const rangesIntersect = semverRangesIntersect(newRange, existingRange);

        if (!rangesIntersect) {
            conflicts.push({
                dep,
                newRange,
                existingRange,
                conflictPlugin: existing.pluginSlug
            });
        }
    }

    return {
        compatible: conflicts.length === 0,
        conflicts
    };
}

/**
 * Check if two SemVer ranges have any intersection
 * Uses a simple heuristic: coerce to concrete version and check
 */
function semverRangesIntersect(range1, range2) {
    try {
        // Try to find a version that satisfies both ranges
        // We test common major versions to find intersection
        const testVersions = [];

        // Extract potential major versions from ranges
        const majors = new Set();
        const extractMajor = (range) => {
            const match = range.match(/(\d+)/);
            if (match) majors.add(parseInt(match[1]));
        };
        extractMajor(range1);
        extractMajor(range2);

        // Generate test versions for each major (0-30 to cover most cases)
        for (let major = 0; major <= 30; major++) {
            for (let minor = 0; minor <= 20; minor += 5) {
                testVersions.push(`${major}.${minor}.0`);
            }
        }

        // Check if any test version satisfies both ranges
        for (const version of testVersions) {
            if (semver.satisfies(version, range1) && semver.satisfies(version, range2)) {
                return true;
            }
        }

        // More precise: use semver.intersects if available (semver 7.x)
        if (typeof semver.intersects === 'function') {
            return semver.intersects(range1, range2);
        }

        return false;
    } catch {
        // If parsing fails, assume compatible (fail open for edge cases)
        console.warn(`⚠️ Could not parse semver ranges: ${range1}, ${range2}`);
        return true;
    }
}

/**
 * Format dependency conflict error message
 */
function formatDependencyConflictError(slug, conflicts) {
    const conflictDetails = conflicts.map(c => {
        return `  ┌─────────────────────────────────────────────────────────────────┐
  │  Dependencia: ${c.dep.padEnd(49)}│
  │  ${slug} requiere: ${c.newRange.padEnd(44)}│
  │  ${c.conflictPlugin} (activo) usa: ${c.existingRange.padEnd(36)}│
  │  Versiones incompatibles: No hay versión que satisfaga ambos    │
  └─────────────────────────────────────────────────────────────────┘`;
    }).join('\n\n');

    const pluginNames = [...new Set(conflicts.map(c => c.conflictPlugin))];
    const solutions = pluginNames.map((p, i) => `  ${i + 1}. Desactivar "${p}" antes de activar "${slug}"`).join('\n');

    return `❌ No se puede activar "${slug}"

Conflicto de dependencias detectado:
${conflictDetails}

Soluciones posibles:
${solutions}
  ${pluginNames.length + 1}. Contactar al desarrollador de "${slug}" para actualizar dependencias
  ${pluginNames.length + 2}. Solicitar una versión "bundled" del plugin con dependencias incluidas`;
}

/**
 * Install dependencies defined in manifest.json
 * @param {string} slug - Plugin slug
 * @param {object} manifest - Plugin manifest
 * @param {string} pluginPath - Path to the plugin directory
 */
function installPluginDependencies(slug, manifest, pluginPath = null) {
    if (!manifest || !manifest.dependencies) return;

    // Skip bundled plugins - they have their own dependencies
    if (pluginPath && isBundledPlugin(pluginPath, manifest)) {
        console.log(`📦 Plugin '${slug}' is bundled - skipping shared dependency installation.`);
        return;
    }

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
            execSync(`npm install ${toInstall.join(' ')} --save --ignore-scripts`, {
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
async function prunePluginDependencies(slug, manifest) {
    if (!manifest || !manifest.dependencies) return;

    // 1. Get all other active plugins
    const activePlugins = await getActivePlugins();
    const activeSlugs = activePlugins.filter(s => s !== slug);
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
            execSync(`npm uninstall ${toRemove.join(' ')} --save`, { stdio: 'inherit', cwd: ROOT_DIR });
            console.log(`   ✅ Dependencies removed successfully.`);
        } catch (e) {
            console.error(`   ⚠️ Failed to prune dependencies:`, e.message);
        }
    }
}

const PLUGINS_DIR_REAL = path.resolve('./plugins');
const acorn = require('acorn');
const walk = require('acorn-walk');

/**
 * Static Analysis 2.0: AST-based scan
 * Detects API calls even if split, renamed, or accessed via global.
 */
function validatePluginPermissions(slug, pluginPath, manifest) {
    const permissions = manifest.permissions || [];
    const missingPermissions = new Set();
    const dangerousCalls = new Set();

    const hasDeclared = (scope, access) => {
        return permissions.some(p => p.scope === scope && (p.access === access || p.access === 'admin'));
    };

    // SYSTEM BYPASS: Allow trusted system utilities to skip AST analysis
    // This allows plugins like db-migration to use child_process/process.exit
    if (hasDeclared('system', 'admin')) {
        console.log(`🛡️ Security: Plugin '${slug}' granted SYSTEM access (AST scan skipped).`);
        return true;
    }

    function getFiles(dir) {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        list.forEach(file => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) {
                // Skip node_modules, hidden files, and FRONTEND directories
                if (!file.includes('node_modules') && !file.startsWith('.') &&
                    !['client', 'frontend'].includes(file)) {
                    results = results.concat(getFiles(fullPath));
                }
            } else if (file.endsWith('.js') || file.endsWith('.ts')) {
                // Exclude .tsx (frontend components) from backend security scan
                results.push(fullPath);
            }
        });
        return results;
    }

    const files = getFiles(pluginPath);

    // API Mappings for AST detection
    const apiAccess = {
        'dbAsync': { scope: 'database', access: 'write', label: 'Database' },
        'updateOption': { scope: 'settings', access: 'write', label: 'Settings modification' },
        'addOption': { scope: 'settings', access: 'write', label: 'Settings modification' },
        'deleteOption': { scope: 'settings', access: 'write', label: 'Settings modification' },
        'getOption': { scope: 'settings', access: 'read', label: 'Settings read' }
    };

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        let ast;
        try {
            ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e) {
            console.warn(`[Security] Could not parse ${file} for AST analysis, skipping...`);
            continue;
        }

        walk.ancestor(ast, {
            CallExpression(node, ancestors) {
                let name = '';
                // 1. Direct calls: eval(), execSync()
                if (node.callee.type === 'Identifier') {
                    name = node.callee.name;

                    // Detect require of sensitive modules
                    if (name === 'require' && node.arguments.length > 0) {
                        const arg = node.arguments[0];
                        if (arg.type === 'Literal') {
                            const moduleName = arg.value;
                            const sensitiveModules = ['child_process', 'fs', 'http', 'https', 'net', 'dgram', 'dns', 'cluster', 'async_hooks', 'vm', 'worker_threads'];
                            if (sensitiveModules.includes(moduleName)) {
                                if (moduleName === 'dns' || moduleName === 'net') {
                                    if (!hasDeclared('network', 'admin') && !hasDeclared('email', 'admin')) {
                                        missingPermissions.add(`Network/System access (require('${moduleName}'))`);
                                    }
                                } else if (moduleName !== 'fs') {
                                    dangerousCalls.add(`require('${moduleName}')`);
                                }
                            }
                        } else {
                            dangerousCalls.add(`Dynamic require detected (obfuscation risk)`);
                        }
                    }
                }
                // 2. Member calls: fs.writeFile(), global.eval()
                else if (node.callee.type === 'MemberExpression') {
                    if (node.callee.property.type === 'Identifier') {
                        name = node.callee.property.name;
                    }

                    if (node.callee.computed) {
                        dangerousCalls.add(`Computed/Dynamic Call (obfuscation risk)`);
                    }

                    // Special handling for fs
                    if (node.callee.object.type === 'Identifier' && node.callee.object.name === 'fs') {
                        const isRead = ['readFileSync', 'readFile', 'createReadStream', 'existsSync', 'statSync'].includes(name);
                        const scope = 'filesystem';
                        const access = isRead ? 'read' : 'write';
                        if (!hasDeclared(scope, access)) {
                            missingPermissions.add(`Filesystem ${isRead ? 'Read' : 'Write'} (fs.${name || 'unknown'})`);
                        }
                    }
                }

                // SAFE LOOKUP: Prevent prototype-based false positives (like toString)
                if (name && Object.prototype.hasOwnProperty.call(apiAccess, name)) {
                    const { scope, access, label } = apiAccess[name];
                    if (!hasDeclared(scope, access)) {
                        missingPermissions.add(`${label} (${scope}:${access})`);
                    }
                }

                if (['eval', 'Function', 'exec', 'execSync', 'spawn', 'fork'].includes(name)) {
                    dangerousCalls.add(name);
                }
            },
            MemberExpression(node, ancestors) {
                // Detect access to sensitive globals
                const sensitiveGlobals = ['process', 'global', 'require', 'module', 'arguments', '__dirname', '__filename', 'Buffer'];
                if (node.object.type === 'Identifier' && sensitiveGlobals.includes(node.object.name)) {
                    // Check if this is an assignment (e.g. global.x = 1 or module.exports = ...)
                    // We allow WRITING to them for legitimate sharing/exporting, but BLOCK reading them as objects
                    const parent = ancestors[ancestors.length - 2];
                    const grandParent = ancestors[ancestors.length - 3];

                    let isAssignment = false;
                    if (parent && parent.type === 'AssignmentExpression' && parent.left === node) {
                        isAssignment = true;
                    }
                    // Also check if we are assigning to a property of the global (e.g. global.foo = ...)
                    if (!isAssignment && parent && parent.type === 'MemberExpression' && parent.object === node) {
                        if (grandParent && grandParent.type === 'AssignmentExpression' && grandParent.left === parent) {
                            isAssignment = true;
                        }
                    }

                    if (node.object.name === 'process') {
                        // Allow process.env (handled by runtime proxy), block everything else
                        if (node.property.name !== 'env') {
                            dangerousCalls.add(`Forbidden 'process' property: ${node.property.name || 'computed'}`);
                        }
                    } else if (!isAssignment) {
                        dangerousCalls.add(`Direct '${node.object.name}' access (restricted)`);
                    }
                }

                // Detect dynamic property access: obj["perm" + "ission"] on ANY object
                if (node.computed && node.property.type !== 'Literal' && node.property.type !== 'NumberLiteral') {
                    // Only flag if it's a sensitive base or looks suspicious
                    const base = node.object.type === 'Identifier' ? node.object.name : '';
                    if (sensitiveGlobals.includes(base)) {
                        dangerousCalls.add(`Obfuscated/Dynamic access to ${base}`);
                    }
                }
            },
            TemplateLiteral(node) {
                // Check if any template literal contains dangerous keywords
                const text = content.slice(node.start, node.end);
                if (/eval|exec|dbAsync|updateOption/.test(text)) {
                    // Only flag if it looks like it might be used for execution
                    // This is conservative
                }
            }
        });
    }

    const errors = [];
    if (missingPermissions.size > 0) {
        errors.push(`Undeclared capabilities required by code:\n- ${Array.from(missingPermissions).join('\n- ')}`);
    }
    if (dangerousCalls.size > 0) {
        // We block eval and shell execution by default for security
        errors.push(`Blocked dangerous calls detected: ${Array.from(dangerousCalls).join(', ')}`);
    }

    if (errors.length > 0) {
        throw new Error(`🛡️ Security Block: Plugin '${slug}' failed validation:\n\n${errors.join('\n\n')}\n\nPlease update manifest.json or remove the unauthorized code.`);
    }

    return true;
}

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
        this.permissions = data.permissions || [];
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
                    author: manifest.author,
                    permissions: manifest.permissions || []
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
            permissions: metadata.permissions || [],
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
async function getActivePlugins() {
    return await getOption('active_plugins', []);
}

/**
 * Check if plugin is active
 */
async function isPluginActive(slug) {
    const active = await getActivePlugins();
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

    if (await isPluginActive(slug)) {
        return { success: true, message: 'Plugin already active' };
    }

    // Check if already active
    if (await isPluginActive(slug)) {
        return { success: true, message: `Plugin ${slug} is already active` };
    }

    // 1. Dependency Check & Auto-Install
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // 0. Static Permission Verification
            validatePluginPermissions(slug, plugin.path, manifest);

            // 1a. Check if this is a bundled plugin
            const isBundled = isBundledPlugin(plugin.path, manifest);

            if (isBundled) {
                console.log(`📦 Plugin '${slug}' detected as bundled - no shared dependencies.`);
            } else {
                // 1b. HARD LOCK: Check for dependency conflicts with active plugins
                const conflictResult = await checkDependencyConflicts(slug, manifest);

                if (!conflictResult.compatible) {
                    const errorMessage = formatDependencyConflictError(slug, conflictResult.conflicts);
                    console.error(errorMessage);
                    throw new Error(errorMessage);
                }

                // 1c. Install dependencies (only if not bundled and no conflicts)
                installPluginDependencies(slug, manifest, plugin.path);
            }
        } catch (e) {
            // CRITICAL: Must throw to stop execution if security block or other failure occurs
            console.error(`🛡️ Protection Active: Blocking ${slug} activation due to:`, e.message);
            throw e;
        }
    }

    // 2. Run Plugin Tests (if present)
    const { verifyPluginTests } = require('./plugin-test-runner');
    try {
        const testResult = await verifyPluginTests(slug);
        if (!testResult.skipped) {
            console.log(`   🧪 Tests verified: ${testResult.passed}/${testResult.tests} passed`);
        }
    } catch (testError) {
        console.error(`🧪 Test Failure: Plugin '${slug}' blocked due to failing tests.`);
        throw testError;
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

        const { runWithContext } = require('./plugin-context');

        // Call init/activate function if exists
        if (typeof pluginModule.init === 'function') {
            await runWithContext(slug, () => pluginModule.init());
        } else if (typeof pluginModule.activate === 'function') {
            await runWithContext(slug, () => pluginModule.activate());
        }

        // Reorder middleware to ensure plugin routes work
        fixMiddlewareOrder();

        // Add to active plugins
        const active = await getActivePlugins();
        active.push(slug);
        await updateOption('active_plugins', active);

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
    if (!await isPluginActive(slug)) {
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
                await prunePluginDependencies(slug, manifest);
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
    const active = await getActivePlugins();
    const index = active.indexOf(slug);
    if (index > -1) {
        active.splice(index, 1);
        await updateOption('active_plugins', active);
    }

    loadedPlugins.delete(slug);

    await doAction('deactivated_plugin', slug);

    return { success: true, message: `Plugin ${slug} deactivated` };
}

/**
 * Load all active plugins
 */
async function loadActivePlugins() {
    const activePlugins = await getActivePlugins();
    const plugins = scanPlugins();
    const CrashGuard = require('./crash-guard');

    // 1. CRASH RECOVERY CHECK (with 3-Strike Rule)
    // Did we crash last time?
    const crashInfo = CrashGuard.checkPreviousCrash();

    if (crashInfo && crashInfo.shouldDisable) {
        const culpritSlug = crashInfo.slug;
        console.error(`🚨 CRASH DETECTED: Plugin '${culpritSlug}' has ${crashInfo.strikes} strikes.`);
        console.error(`🛡️  CrashGuard: Automatically disabling '${culpritSlug}' to prevent boot loop.`);

        // Remove from active plugins list
        const newActive = activePlugins.filter(s => s !== culpritSlug);
        await updateOption('active_plugins', newActive);

        // Also notify via persistent admin notice
        const notices = await getOption('admin_notices', []);
        notices.push({
            id: `crash-${culpritSlug}-${Date.now()}`,
            type: 'error',
            message: `🚨 <b>Critical Error:</b> The plugin <strong>${culpritSlug}</strong> caused ${crashInfo.strikes} consecutive crashes during startup and has been automatically disabled for your safety. Please check the logs or contact the plugin author.`,
            dismissible: true,
            timestamp: Date.now()
        });
        await updateOption('admin_notices', notices);

        // Update local list for THIS run
        const index = activePlugins.indexOf(culpritSlug);
        if (index > -1) activePlugins.splice(index, 1);
    } else if (crashInfo && !crashInfo.shouldDisable) {
        // Crash detected but not at 3 strikes yet, just log and continue
        console.warn(`⚠️ [CrashGuard] Previous crash during '${crashInfo.slug}' load (Strike ${crashInfo.strikes}/${CrashGuard.MAX_STRIKES}). Retrying...`);
    }

    // 2. Load Plugins
    for (const slug of activePlugins) {
        const plugin = plugins.find(p => p.slug === slug);
        if (!plugin) continue;

        const mainFile = findMainFile(plugin.path);
        if (!mainFile) continue;

        // Auto-Check/Install Deps and VALIDATE permissions on Load
        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

                // CRITICAL: Re-validate permissions on every boot to prevent code poisoning
                validatePluginPermissions(slug, plugin.path, manifest);

                installPluginDependencies(slug, manifest, plugin.path);
            } catch (e) {
                console.error(`   ✗ Security Block for ${slug} on load:`, e.message);
                // We don't load plugins that fail validation
                continue;
            }
        }

        try {
            // MARK START
            CrashGuard.startLoading(slug);

            const pluginModule = require(mainFile);

            const { runWithContext } = require('./plugin-context');
            if (typeof pluginModule.init === 'function') {
                await runWithContext(slug, () => pluginModule.init());
            }

            // MARK SUCCESS
            CrashGuard.finishLoading(slug);

            loadedPlugins.set(slug, pluginModule);
            console.log(`   ✓ Plugin loaded: ${plugin.name}`);
        } catch (error) {
            // If we caught the error (it didn't crash the process), we should still clear the lock
            CrashGuard.finishLoading(slug);

            console.error(`   ✗ Failed to load plugin ${slug}:`, error.message);
        }
    }
}

/**
 * Get all plugins with their status
 */
async function getAllPlugins() {
    const plugins = scanPlugins();
    const active = await getActivePlugins();

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
    validatePluginPermissions,
    // Hard Lock + Bundling utilities
    isBundledPlugin,
    checkDependencyConflicts,
    PLUGINS_DIR
};
