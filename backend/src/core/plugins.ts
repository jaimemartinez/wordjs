/**
 * WordJS - Plugin System
 * Equivalent to wp-includes/plugin.php (plugin loading)
 */

const { execSync, execFile } = require('child_process'); // execSync retained for parity; execFile used async below
const { promisify } = require('util');
// Async execFile so npm install/uninstall does NOT block the event loop on the request path.
const execFileAsync = promisify(execFile);
// npm is npm.cmd on Windows; execFile needs the exact binary name.
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const fs = require('fs');
const path = require('path');
const { addAction, doAction, addFilter } = require('./hooks');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('./plugin-isolate');
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
function isBundledPlugin(pluginPath, manifest: any = {}) {
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

    const conflicts: any[] = [];
    const activePlugins = await getActivePlugins();
    const plugins = scanPlugins();

    // Build map of all dependencies from active plugins. Multiple active plugins can require the same
    // dependency, so keep an ARRAY of {range, pluginSlug} per dep — a Map keyed by dep with a single
    // value would let the last writer silently overwrite (and hide) earlier conflicting requirements.
    const activeDependencies = new Map<string, Array<{ range: any; pluginSlug: any }>>(); // dep -> [{ range, pluginSlug }]

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
                    if (!activeDependencies.has(dep)) activeDependencies.set(dep, []);
                    activeDependencies.get(dep)!.push({ range, pluginSlug: activeSlug });
                }
            }
        } catch (e) {
            console.warn(`[Plugins] Error reading manifest for ${activeSlug}:`, e.message);
        }
    }

    // Check each new dependency against ALL existing requirements for that dep. Flag a conflict if the
    // new range fails to intersect ANY recorded range (each non-intersecting requirement is reported).
    for (const [dep, newRange] of Object.entries(manifest.dependencies)) {
        const existingList = activeDependencies.get(dep);
        if (!existingList) continue;

        for (const existing of existingList) {
            const existingRange = existing.range;

            // Check if ranges intersect (have at least one common version)
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
        const testVersions: string[] = [];

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
async function installPluginDependencies(slug, manifest, pluginPath = null) {
    if (!manifest || !manifest.dependencies) return;

    // Skip bundled plugins - they have their own dependencies
    if (pluginPath && isBundledPlugin(pluginPath, manifest)) {
        console.log(`📦 Plugin '${slug}' is bundled - skipping shared dependency installation.`);
        return;
    }

    let rootPkg: any = {};
    try {
        rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    } catch (e) {
        console.error('⚠️ Could not read root package.json', e.message);
    }

    const installed = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    const toInstall: string[] = [];

    for (const [dep, version] of Object.entries(manifest.dependencies)) {
        if (!installed[dep]) {
            toInstall.push(`${dep}@${version}`);
        }
    }

    if (toInstall.length > 0) {
        console.log(`📦 Plugin '${slug}' requires: ${toInstall.join(', ')}`);
        console.log(`   ⏳ Installing dependencies... (server may restart)`);
        try {
            // SECURITY: execFile with an argument array (no shell) so dependency names from
            // the plugin manifest cannot inject shell commands. Async so we don't block the event loop.
            await execFileAsync(NPM_BIN, ['install', ...toInstall, '--save', '--ignore-scripts'], {
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
                } catch (e) {
                    console.warn(`[Plugins] Error reading manifest during cleanup for ${activeSlug}:`, e.message);
                }
            }
        }
    }

    // 3. Check for unused dependencies
    const toRemove: string[] = [];

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
            // Async so pruning on the deactivate request path doesn't block the event loop.
            await execFileAsync(NPM_BIN, ['uninstall', ...toRemove, '--save'], { cwd: ROOT_DIR });
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

    // SYSTEM BYPASS: declaring system:admin in a manifest is NOT enough to skip the AST scan —
    // any uploaded plugin could self-declare it. The skip requires explicit operator trust via
    // config.trustedSystemPlugins (defaults to the first-party bundled plugins). Untrusted plugins
    // that declare system:admin fall through to the full scan (so their child_process/eval use is caught).
    if (hasDeclared('system', 'admin')) {
        let trusted: string[] = [];
        try { trusted = require('../config/app').trustedSystemPlugins || []; } catch { /* ignore */ }
        if (trusted.includes(slug)) {
            console.log(`🛡️ Security: Trusted plugin '${slug}' granted SYSTEM access (AST scan skipped).`);
            return true;
        }
        console.warn(`[Security] Plugin '${slug}' declares system:admin but is NOT in config.trustedSystemPlugins — running full AST scan (self-granted system access denied).`);
    }

    function getFiles(dir): string[] {
        let results: string[] = [];
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
            } else if (file.endsWith('.js') || file.endsWith('.ts') ||
                       file.endsWith('.cjs') || file.endsWith('.mjs')) {
                // Exclude .tsx (frontend components) from backend security scan.
                // .cjs/.mjs are scanned too since the runtime can load them.
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
            // FAIL-CLOSED: a file that is actually loaded but cannot be parsed is treated as
            // a violation, so an attacker cannot hide a payload behind a deliberate parse-buster.
            console.warn(`[Security] Could not parse ${file} for AST analysis — treating as a violation (fail-closed).`);
            dangerousCalls.add(`Unparseable source file (${path.basename(file)})`);
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
                            // Strip a leading 'node:' prefix so require('node:child_process')
                            // is detected the same as require('child_process').
                            const moduleName = String(arg.value).replace(/^node:/, '');
                            const sensitiveModules = ['child_process', 'fs', 'fs/promises', 'http', 'https', 'net', 'dgram', 'dns', 'cluster', 'async_hooks', 'vm', 'worker_threads'];
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
                const sensitiveGlobals = ['process', 'global', 'globalThis', 'require', 'module', 'arguments', '__dirname', '__filename', 'Buffer'];
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

    const errors: string[] = [];
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

/**
 * Plugin metadata structure
 */
class Plugin {
    name: any;
    slug: any;
    version: any;
    description: any;
    author: any;
    path: any;
    active: any;
    init: any;
    deactivate: any;
    permissions: any;

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
    const plugins: Plugin[] = [];

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const manifestPath = path.join(pluginDir, 'manifest.json');

        let metadata: any = {};
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
    const errorHandlers: any[] = [];

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
                await installPluginDependencies(slug, manifest, plugin.path);
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
        // Plugins run ISOLATED (in a worker, core only via the bridge). Legacy in-process execution
        // was removed — a plugin must declare "isolated": true in its manifest.
        let manifest: any = null;
        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* */ }
        }
        if (!manifest || !manifest.isolated) {
            throw new Error(`Plugin '${slug}' must declare "isolated": true and use the wordjs bridge — legacy in-process plugins are no longer supported.`);
        }

        await loadIsolatedPlugin(slug, mainFile);

        // Reorder middleware to ensure plugin routes work
        fixMiddlewareOrder();

        // Add to active plugins
        const active = await getActivePlugins();
        active.push(slug);
        await updateOption('active_plugins', active);

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

    // Terminate the plugin's worker — that IS deactivation for the isolated model.
    try { unloadIsolatedPlugin(slug); } catch (e) { /* worker may already be gone */ }

    // Remove from active plugins
    const active = await getActivePlugins();
    const index = active.indexOf(slug);
    if (index > -1) {
        active.splice(index, 1);
        await updateOption('active_plugins', active);
    }

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
        let manifest: any = null;
        const manifestPath = path.join(plugin.path, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

                // CRITICAL: Re-validate permissions on every boot to prevent code poisoning
                validatePluginPermissions(slug, plugin.path, manifest);

                await installPluginDependencies(slug, manifest, plugin.path);
            } catch (e) {
                console.error(`   ✗ Security Block for ${slug} on load:`, e.message);
                // We don't load plugins that fail validation
                continue;
            }
        }

        try {
            // MARK START
            CrashGuard.startLoading(slug);

            // Plugins run ISOLATED in a worker (separate heap; core only via the bridge). Legacy
            // in-process execution has been removed — a plugin MUST declare "isolated": true.
            if (manifest && manifest.isolated) {
                await loadIsolatedPlugin(slug, mainFile);
                console.log(`   ✓ Plugin loaded ISOLATED: ${plugin.name} (${slug})`);
                CrashGuard.finishLoading(slug);
                continue;
            }

            console.warn(`   ⚠ Skipping '${slug}': not isolated. Set "isolated": true to run it in the sandbox (legacy in-process loading was removed).`);
            CrashGuard.finishLoading(slug);
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
