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
function isBundledPlugin(pluginPath: string, manifest: any = {}) {
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
            if (files.some((f: string) => f.endsWith('.bundle.js'))) {
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
async function checkDependencyConflicts(slug: string, manifest: any) {
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
function semverRangesIntersect(range1: any, range2: any) {
    try {
        // Try to find a version that satisfies both ranges
        // We test common major versions to find intersection
        const testVersions: string[] = [];

        // Extract potential major versions from ranges
        const majors = new Set();
        const extractMajor = (range: any) => {
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
function formatDependencyConflictError(slug: string, conflicts: any[]) {
    const conflictDetails = conflicts.map((c: any) => {
        return `  ┌─────────────────────────────────────────────────────────────────┐
  │  Dependencia: ${c.dep.padEnd(49)}│
  │  ${slug} requiere: ${c.newRange.padEnd(44)}│
  │  ${c.conflictPlugin} (activo) usa: ${c.existingRange.padEnd(36)}│
  │  Versiones incompatibles: No hay versión que satisfaga ambos    │
  └─────────────────────────────────────────────────────────────────┘`;
    }).join('\n\n');

    const pluginNames = [...new Set(conflicts.map((c: any) => c.conflictPlugin))];
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
async function installPluginDependencies(slug: string, manifest: any, pluginPath: any = null) {
    if (!manifest || !manifest.dependencies) return;

    // Skip bundled plugins - they have their own dependencies
    if (pluginPath && isBundledPlugin(pluginPath, manifest)) {
        console.log(`📦 Plugin '${slug}' is bundled - skipping shared dependency installation.`);
        return;
    }

    // SECURITY: never auto-install packages that ship native builds or spawn servers — they execute
    // outside the plugin sandbox, turning a manifest entry into host-level code execution. (Bundled
    // plugins skipped above are operator-trusted and exempt.) Bundle these or install as an operator.
    const BLOCKED_RUNTIME_DEPS = new Set([
        'embedded-postgres', 'better-sqlite3', 'sqlite3', 'node-gyp', 'node-pre-gyp',
        'node-sass', 'sharp', 'puppeteer', 'playwright', 'canvas', 'windows-build-tools'
    ]);
    for (const dep of Object.keys(manifest.dependencies)) {
        if (BLOCKED_RUNTIME_DEPS.has(dep)) {
            throw new Error(`Plugin '${slug}' declares dependency '${dep}', which cannot be auto-installed at runtime (native build / server process). Bundle it with the plugin or install it as an operator.`);
        }
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
async function prunePluginDependencies(slug: string, manifest: any) {
    if (!manifest || !manifest.dependencies) return;

    // 1. Get all other active plugins
    const activePlugins = await getActivePlugins();
    const activeSlugs = activePlugins.filter((s: any) => s !== slug);
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
// Canonical permission vocabulary: scope -> allowed access tokens. 'network' is scope-only (no
// access token). Single source of truth for upload validation, the `wordjs check` CLI, and admin
// permission labels — so a typo'd scope/access is caught in ONE place instead of silently accepted.
const KNOWN_PERMISSIONS: Record<string, string[]> = {
    database: ['read', 'write'],
    filesystem: ['read', 'write'],
    settings: ['read', 'write'],
    users: ['read'],
    email: ['admin', 'provider'],
    notifications: ['send', 'provider'],
    express: ['register_route'],
    admin_menu: ['register'],
    assets: ['write'],
    network: [], // scope-only: {scope:'network'} carries no access token
};

/**
 * Validate a manifest.permissions array against KNOWN_PERMISSIONS. Returns human-readable problems
 * (empty = valid). Catches typo'd scopes ('databse') / accesses ('readwrite') that would otherwise
 * be silently accepted, yielding a dead admin toggle and a cryptic runtime denial.
 */
function validateManifestPermissions(permissions: any): string[] {
    const problems: string[] = [];
    if (permissions === undefined || permissions === null) return problems;
    if (!Array.isArray(permissions)) return ['`permissions` must be an array.'];
    permissions.forEach((p: any, i: number) => {
        if (!p || typeof p !== 'object') { problems.push(`permissions[${i}] must be an object like {scope, access}.`); return; }
        if (!(p.scope in KNOWN_PERMISSIONS)) {
            problems.push(`Unknown permission scope "${p.scope}" (valid: ${Object.keys(KNOWN_PERMISSIONS).join(', ')}).`);
            return;
        }
        const allowed = KNOWN_PERMISSIONS[p.scope];
        if (allowed.length === 0) return; // scope-only (network)
        if (!allowed.includes(p.access)) {
            problems.push(`Permission "${p.scope}" has invalid access "${p.access}" (valid: ${allowed.join(', ')}).`);
        }
    });
    return problems;
}

function validatePluginPermissions(slug: string, pluginPath: string, manifest: any) {
    const permissions = manifest.permissions || [];
    const missingPermissions = new Set();
    const dangerousCalls = new Set();

    const hasDeclared = (scope: any, access: any) => {
        return permissions.some((p: any) => p.scope === scope && (p.access === access || p.access === 'admin'));
    };

    // Sensitive Node builtins. Reached via require(), dynamic import(), or static import — all three
    // must be policed here. Dynamic import() in particular bypasses the CommonJS require proxy at
    // runtime (different module loader), so catching it statically is the primary defense; the worker's
    // ESM resolve hook is the runtime backstop.
    const SENSITIVE_MODULES = ['child_process', 'fs', 'fs/promises', 'http', 'https', 'net', 'dgram', 'dns', 'cluster', 'async_hooks', 'vm', 'worker_threads', 'module', 'inspector', 'v8', 'repl'];
    const flagModuleLiteral = (rawValue: any, kindLabel: string) => {
        const moduleName = String(rawValue).replace(/^node:/, '');
        if (!SENSITIVE_MODULES.includes(moduleName)) return;
        if (moduleName === 'dns' || moduleName === 'net') {
            if (!hasDeclared('network', 'admin') && !hasDeclared('email', 'admin')) {
                missingPermissions.add(`Network/System access (${kindLabel}('${moduleName}'))`);
            }
        } else if (moduleName !== 'fs') {
            dangerousCalls.add(`${kindLabel}('${moduleName}')`);
        }
    };

    // No plugin may skip the AST scan: there is no trust tier, and declaring system:admin grants
    // nothing. EVERY plugin runs the full scan (so its child_process/eval/native use is caught).

    function getFiles(dir: string): string[] {
        let results: string[] = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        list.forEach((file: string) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) {
                // Skip node_modules, hidden files, and FRONTEND directories. `dist/` is the BUILT
                // output of client/ (esbuild bundles like component.bundle.js) — it runs in the
                // browser, NOT in the isolated worker, and bundling injects require.*/process.cwd from
                // packed deps, which falsely trips the dangerous-call scan. The worker only loads the
                // backend entry (index.js), so scanning dist/ is both wrong and a false-positive source.
                if (!file.includes('node_modules') && !file.startsWith('.') &&
                    !['client', 'frontend', 'dist'].includes(file)) {
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
            CallExpression(node: any, ancestors: any) {
                let name = '';
                // 1. Direct calls: eval(), execSync()
                if (node.callee.type === 'Identifier') {
                    name = node.callee.name;

                    // Detect require of sensitive modules
                    if (name === 'require' && node.arguments.length > 0) {
                        const arg = node.arguments[0];
                        if (arg.type === 'Literal') {
                            flagModuleLiteral(arg.value, 'require');
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
                    const { scope, access, label } = (apiAccess as any)[name];
                    if (!hasDeclared(scope, access)) {
                        missingPermissions.add(`${label} (${scope}:${access})`);
                    }
                }

                // `/re/.exec(s)` is RegExp.prototype.exec (a benign string match), NOT child_process.exec —
                // the scanner only sees the method name `exec`. Exempt the regex-LITERAL form specifically
                // (a very common idiom that was falsely blocking legitimate plugins). `someVar.exec()` stays
                // flagged: we can't statically prove it isn't a child_process handle.
                const isRegexLiteralExec = name === 'exec'
                    && node.callee.type === 'MemberExpression'
                    && node.callee.object && node.callee.object.type === 'Literal' && !!node.callee.object.regex;

                if (!isRegexLiteralExec && ['eval', 'Function', 'exec', 'execSync', 'spawn', 'fork'].includes(name)) {
                    dangerousCalls.add(name);
                }

                // Indirect eval / Function: `(0, eval)(x)` / `(0, Function)(y)`. The comma-expression
                // callee is a SequenceExpression whose runtime value is its LAST element — a codegen
                // primitive the bare-name check above misses (name is '' for a SequenceExpression callee).
                if (node.callee.type === 'SequenceExpression') {
                    // Unwrap nested comma-expressions ((0,(0,eval))('x')) to the terminal value.
                    let last: any = node.callee;
                    while (last && last.type === 'SequenceExpression' && last.expressions.length) {
                        last = last.expressions[last.expressions.length - 1];
                    }
                    if (last && last.type === 'Identifier' && (last.name === 'eval' || last.name === 'Function')) {
                        dangerousCalls.add(`Indirect ${last.name}() call (obfuscation risk)`);
                    }
                }

                // Function constructor reached indirectly, e.g. (()=>{}).constructor('code')() or
                // [].constructor.constructor('code') — builds executable code at runtime, bypassing the
                // literal eval/Function name check above.
                if (node.callee.type === 'MemberExpression' && node.callee.property &&
                    node.callee.property.type === 'Identifier' && node.callee.property.name === 'constructor') {
                    dangerousCalls.add(`Function constructor via .constructor (obfuscation risk)`);
                }
            },
            MemberExpression(node: any, ancestors: any) {
                // Detect access to sensitive globals. NOTE: `Buffer` is intentionally NOT restricted —
                // under OS-process isolation (child_process) a plugin's Buffer (incl. allocUnsafe) only
                // ever exposes the plugin's OWN process memory, never the host heap or another plugin, so
                // it carries no cross-boundary risk; and it's essential for legitimate crypto/binary work
                // (e.g. AES-GCM secret encryption). Blocking it broke real plugins for no security gain.
                const sensitiveGlobals = ['process', 'global', 'globalThis', 'require', 'module', 'arguments', '__dirname', '__filename'];
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
            TemplateLiteral(node: any) {
                // Check if any template literal contains dangerous keywords
                const text = content.slice(node.start, node.end);
                if (/eval|exec|dbAsync|updateOption/.test(text)) {
                    // Only flag if it looks like it might be used for execution
                    // This is conservative
                }
            },
            // Dynamic import('child_process') — parses as ImportExpression (NOT a CallExpression), so it
            // was previously invisible to the walk and bypassed the require proxy at runtime. Treat it
            // exactly like require(); flag non-literal specifiers as obfuscation (catches import('child'+'_process')).
            ImportExpression(node: any) {
                const arg = node.source;
                if (arg && arg.type === 'Literal') {
                    flagModuleLiteral(arg.value, 'import');
                } else {
                    dangerousCalls.add(`Dynamic import() detected (obfuscation risk)`);
                }
            },
            // Static `import x from 'child_process'` — hoisted and runs before any runtime guard.
            ImportDeclaration(node: any) {
                if (node.source && node.source.type === 'Literal') {
                    flagModuleLiteral(node.source.value, 'import');
                }
            },
            // Aliasing/destructuring a sensitive global — `const p = process` or
            // `const { getBuiltinModule } = process` — dodges the MemberExpression guard and reaches
            // process.getBuiltinModule / process.binding / etc. Flag any binding initialized directly
            // from a restricted global identifier. (The runtime wrap of getBuiltinModule is the primary
            // defense; this is the static backstop.)
            VariableDeclarator(node: any) {
                if (node.init && node.init.type === 'Identifier' &&
                    ['process', 'global', 'globalThis', 'require', 'module', 'eval', 'Function'].includes(node.init.name)) {
                    // `const p = process` / `const e = eval` / `const F = Function` — binding a restricted
                    // global or a codegen primitive to a local dodges the direct name checks above.
                    dangerousCalls.add(`Aliasing restricted global '${node.init.name}' (obfuscation risk)`);
                }
                // `const F = [].constructor.constructor` aliases the Function constructor (constructor OF a
                // constructor) without ever naming it — then F('code')() runs arbitrary code while the call
                // callee is just an Identifier. Flag the DOUBLE .constructor.constructor init specifically
                // (a single .constructor, e.g. `this.constructor`, is common and benign → no false positive).
                if (node.init && node.init.type === 'MemberExpression' && node.init.property &&
                    node.init.property.type === 'Identifier' && node.init.property.name === 'constructor' &&
                    node.init.object && node.init.object.type === 'MemberExpression' && node.init.object.property &&
                    node.init.object.property.type === 'Identifier' && node.init.object.property.name === 'constructor') {
                    dangerousCalls.add(`Aliasing Function constructor via .constructor.constructor (obfuscation risk)`);
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
        const err: any = new Error(`🛡️ Security Block: Plugin '${slug}' failed validation:\n\n${errors.join('\n\n')}\n\nPlease update manifest.json or remove the unauthorized code.`);
        // Structured detail so callers (upload validation, the admin activation-reject panel) can tell
        // a FIXABLE missing-grant apart from a HARD-BLOCKED dangerous call, instead of parsing a string.
        err.code = 'PLUGIN_VALIDATION_FAILED';
        err.missingPermissions = Array.from(missingPermissions);
        err.dangerousCalls = Array.from(dangerousCalls);
        throw err;
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
    homepage: any;
    path: any;
    active: any;
    init: any;
    deactivate: any;
    permissions: any;

    constructor(data: any) {
        this.name = data.name;
        this.slug = data.slug;
        this.version = data.version || '1.0.0';
        this.description = data.description || '';
        this.author = data.author || '';
        this.homepage = data.homepage || '';
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
        // 2. Manifest-less (legacy) plugin. SECURITY: do NOT require() the entry on the HOST to read
        //    metadata — that executes untrusted top-level code OUTSIDE the worker sandbox (host RCE on
        //    plugin enumeration / GET /plugins). Use directory-name metadata only; real loading happens
        //    later, sandboxed, in the worker. Plugins wanting proper metadata must ship a manifest.json.
        else {
            mainFile = findMainFile(pluginDir);
            if (!mainFile) continue;
            // metadata stays {} → name falls back to entry.name below; nothing is executed here.
        }

        plugins.push(new Plugin({
            name: metadata.name || entry.name,
            slug: entry.name,
            version: metadata.version || '1.0.0',
            description: metadata.description || '',
            author: metadata.author || '',
            homepage: metadata.homepage || metadata.repository || '',
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
function findMainFile(pluginDir: string) {
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
async function isPluginActive(slug: string) {
    const active = await getActivePlugins();
    return active.includes(slug);
}

/**
 * Atomically read-modify-write the `active_plugins` array.
 *
 * activate/deactivate/CrashGuard each did `read → mutate array → updateOption(whole array)`, a
 * non-atomic read-modify-write of the WHOLE list. Two concurrent admin actions (or an activation
 * racing CrashGuard's boot-time disable) both read the same base array and both overwrite it, so one
 * change is silently LOST. We serialize ONLY the option read+write under the existing distributed
 * lock ('wordjs:active-plugins'). On Postgres/multi-node this is a real cross-node mutex; on SQLite
 * acquireBlocking is a no-op-held (single host) and the now-atomic updateOption UPSERT keeps it
 * correct. The lock is scoped to JUST the read+write (NOT worker start/stop) to avoid any deadlock or
 * holding the lease across slow plugin I/O.
 *
 * `mutator(active)` returns the new array (or undefined to leave it unchanged).
 */
async function withActivePluginsLock(mutator: (active: string[]) => string[] | undefined | Promise<string[] | undefined>) {
    const { acquireBlocking } = require('./dist-lock');
    const lock = await acquireBlocking('wordjs:active-plugins', { ttlMs: 15000, timeoutMs: 15000 });
    if (!lock.held) {
        // Could not win the lease within the timeout — fail closed rather than do a non-atomic write
        // that could clobber another node's concurrent change.
        throw new Error('Could not acquire active_plugins lock (another node/operation holds it)');
    }
    try {
        const active = await getActivePlugins();
        const next = await mutator(Array.isArray(active) ? active : []);
        if (next !== undefined) {
            await updateOption('active_plugins', next);
        }
        return next;
    } finally {
        await lock.release();
    }
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
async function activatePlugin(slug: string) {
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

        // Add to active plugins (atomic read-modify-write under the dist-lock — see helper).
        await withActivePluginsLock((active) => {
            if (active.includes(slug)) return undefined; // already present, no write needed
            return [...active, slug];
        });

        await doAction('activated_plugin', slug);
        publishPluginChange(slug, 'activate'); // propagate to other nodes (no-op on single-node)

        return { success: true, message: `Plugin ${slug} activated` };
    } catch (error) {
        throw new Error(`Failed to activate plugin ${slug}: ${error.message}`);
    }
}

// ...

/**
 * Deactivate a plugin
 */
async function deactivatePlugin(slug: string) {
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

    // Remove from active plugins (atomic read-modify-write under the dist-lock — see helper).
    await withActivePluginsLock((active) => {
        if (!active.includes(slug)) return undefined; // already absent, no write needed
        return active.filter(s => s !== slug);
    });

    await doAction('deactivated_plugin', slug);
    publishPluginChange(slug, 'deactivate'); // propagate to other nodes (no-op on single-node)

    return { success: true, message: `Plugin ${slug} deactivated` };
}

// --- Cross-node plugin propagation (multi-node) --------------------------------------------------
// When a plugin is activated/deactivated on one node, that node publishes 'wordjs:plugin-changed' and
// every OTHER node syncs its in-process load state via coherence.ts → loadOnePlugin/unloadOnePlugin.
// No-op on single-node (cache.publish does nothing without Redis), so single-node behavior is unchanged.
function publishPluginChange(slug: string, action: string) {
    try {
        const cache = require('./cache');
        const { HOLDER } = require('./dist-lock');
        cache.publish('wordjs:plugin-changed', JSON.stringify({ slug, action, origin: HOLDER }));
    } catch (e) { /* best-effort; single-node / Redis-down stays in-process */ }
}

/**
 * Load ONE already-active plugin live into THIS node (cross-node coherence handler, when another node
 * activated it). Mirrors the per-plugin load in loadActivePlugins but does NOT touch the shared
 * `active_plugins` option (the originating node already wrote it under the dist-lock). Unloads any
 * existing instance first so a re-fire can't double-register routes/hooks (idempotent).
 */
async function loadOnePlugin(slug: string) {
    const plugin = scanPlugins().find(p => p.slug === slug);
    if (!plugin) { console.warn(`[plugins] cross-node activate '${slug}': not present on this node`); return false; }
    const mainFile = findMainFile(plugin.path);
    if (!mainFile) { console.warn(`[plugins] cross-node activate '${slug}': no main file`); return false; }
    let manifest: any = null;
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) { try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* */ } }
    if (!manifest || !manifest.isolated) return false;
    try {
        validatePluginPermissions(slug, plugin.path, manifest); // re-validate locally (code-poisoning guard)
        await installPluginDependencies(slug, manifest, plugin.path); // shared node_modules; idempotent
        try { unloadIsolatedPlugin(slug); } catch { /* not loaded here yet */ }
        await loadIsolatedPlugin(slug, mainFile);
        fixMiddlewareOrder();
        console.log(`[plugins] '${slug}' loaded live (cross-node activation)`);
        return true;
    } catch (e: any) {
        console.error(`[plugins] cross-node load of '${slug}' failed:`, e && e.message);
        return false;
    }
}

/**
 * Unload ONE plugin live from THIS node (cross-node deactivation). Does NOT touch `active_plugins`.
 */
function unloadOnePlugin(slug: string) {
    try { unloadIsolatedPlugin(slug); console.log(`[plugins] '${slug}' unloaded live (cross-node deactivation)`); return true; }
    catch (e: any) { console.warn(`[plugins] cross-node unload of '${slug}':`, e && e.message); return false; }
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

        // Remove from active plugins list (atomic read-modify-write under the dist-lock so a
        // concurrent activation on another node can't resurrect the crasher by clobbering this write).
        await withActivePluginsLock((active) => {
            if (!active.includes(culpritSlug)) return undefined;
            return active.filter(s => s !== culpritSlug);
        });

        // Also notify via persistent admin notice. This is a read-modify-write of the WHOLE notices
        // array, so two replicas recovering from a crash concurrently could clobber each other's append
        // and silently drop one notice. Serialize the read+push+write under a dist-lock (same pattern as
        // withActivePluginsLock). BEST-EFFORT: the crash path must never throw, so swallow any lock /
        // option error — losing an admin notice is acceptable; wedging crash recovery is not.
        try {
            const { acquireBlocking } = require('./dist-lock');
            const lock = await acquireBlocking('wordjs:admin-notices', { ttlMs: 15000, timeoutMs: 15000 });
            if (lock.held) {
                try {
                    const notices = await getOption('admin_notices', []);
                    notices.push({
                        id: `crash-${culpritSlug}-${Date.now()}`,
                        type: 'error',
                        message: `🚨 <b>Critical Error:</b> The plugin <strong>${culpritSlug}</strong> caused ${crashInfo.strikes} consecutive crashes during startup and has been automatically disabled for your safety. Please check the logs or contact the plugin author.`,
                        dismissible: true,
                        timestamp: Date.now()
                    });
                    await updateOption('admin_notices', notices);
                } finally {
                    await lock.release();
                }
            }
        } catch (e: any) {
            console.error('[CrashGuard] Failed to record admin notice:', e && e.message);
        }

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

/**
 * Purge a plugin's persisted footprint on uninstall. ALWAYS clears grants (security: otherwise a
 * re-uploaded slug silently inherits the old, possibly-revoked grants) + crash strikes. When
 * dropTables is set, also drops the plugin's OWN wjp_<slug>_* tables — the sandbox confines each
 * plugin to exactly that prefix, so dropping them is complete and can't touch core or another plugin.
 * Options are intentionally NOT auto-purged: the options bridge is a GLOBAL key space with no
 * per-plugin namespace, so a plugin's keys can't be identified safely (a plugin.uninstall hook is the
 * clean path for that). Best-effort: each step is guarded so one failure doesn't abort the rest.
 */
async function uninstallPluginData(slug: string, { dropTables = false }: { dropTables?: boolean } = {}) {
    const result: { grantsRemoved: boolean; strikesCleared: boolean; tablesDropped: string[] } = { grantsRemoved: false, strikesCleared: false, tablesDropped: [] };
    try { const { removeGrants } = require('./plugin-permissions'); await removeGrants(slug); result.grantsRemoved = true; }
    catch (e: any) { console.warn(`[uninstall ${slug}] removeGrants failed:`, e && e.message); }
    try { const { clearStrikes } = require('./crash-guard'); clearStrikes(slug); result.strikesCleared = true; }
    catch (e: any) { console.warn(`[uninstall ${slug}] clearStrikes failed:`, e && e.message); }
    try { await require('./plugin-assets').clearAssets(slug); } catch (e: any) { console.warn(`[uninstall ${slug}] clearAssets failed:`, e && e.message); }
    if (dropTables) {
        try {
            const { dbAsync, getDbType } = require('../config/database');
            const { isPostgres } = getDbType();
            // Mirror plugin-worker.js's tablePrefix normalization exactly.
            const prefix = ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
            const rows = isPostgres
                ? await dbAsync.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")
                : await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table'");
            // Filter in JS by the exact plugin prefix (no LIKE params → no cross-driver escaping pitfalls).
            const mine = (rows || []).map((r: any) => r.name).filter((n: string) => String(n).toLowerCase().startsWith(prefix));
            for (const name of mine) {
                await dbAsync.run(`DROP TABLE IF EXISTS "${String(name).replace(/"/g, '')}"`);
                result.tablesDropped.push(name);
            }
        } catch (e: any) { console.warn(`[uninstall ${slug}] table drop failed:`, e && e.message); }
    }
    console.log(`[uninstall ${slug}] grants=${result.grantsRemoved} strikes=${result.strikesCleared} tablesDropped=${result.tablesDropped.length}`);
    return result;
}

module.exports = {
    scanPlugins,
    getActivePlugins,
    isPluginActive,
    uninstallPluginData,
    activatePlugin,
    deactivatePlugin,
    loadActivePlugins,
    loadOnePlugin,
    unloadOnePlugin,
    getAllPlugins,
    createSamplePlugin,
    validatePluginPermissions,
    validateManifestPermissions,
    KNOWN_PERMISSIONS,
    fixMiddlewareOrder,
    // Hard Lock + Bundling utilities
    isBundledPlugin,
    checkDependencyConflicts,
    PLUGINS_DIR
};
