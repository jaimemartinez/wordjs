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
 * Strip line breaks from a value before it goes into a log line. A plugin slug, a manifest field and a
 * driver error message that echoes either are all request-derived, so an unescaped one can forge or
 * split entries in the operator's log — and passing it as a template literal FOLLOWED by more arguments
 * additionally makes it a console format string, so `%s`/`%d` in a crafted value consume the rest.
 * Every console call in this module therefore builds ONE sanitized string and passes no extra argument.
 *
 * TWO single-constant replacements, each replacing with the empty string, is deliberate: the
 * log-injection analysis recognises a sanitizer SYNTACTICALLY, and an alternation (`/\n|\r/g`) has no
 * constant value, so it is not matched. Match the documented remediation shape, not an equivalent.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * True when a plugin's npm RUNTIME DEPENDENCIES are already packaged, so the host must NOT auto-install
 * them at activation. That is the case when either:
 *   1. manifest.json declares "bundled": true (operator says it's self-contained), OR
 *   2. the plugin ships a non-empty node_modules/ (the deps are physically present).
 *
 * A `dist/*.bundle.js` does NOT count. That file is the plugin's compiled FRONTEND (admin page / Puck
 * block / hooks, built by esbuild with externals) — it has nothing to do with the backend npm packages
 * its index.js `require()`s. Every marketplace plugin now ships a dist bundle (build-marketplace compiles
 * one), so treating a dist bundle as "bundled" made EVERY marketplace plugin skip its declared-dependency
 * install → activation failed with e.g. "Cannot find module 'smtp-server'". Frontend-bundle detection
 * belongs to the loader, not to dependency management.
 */
function isBundledPlugin(pluginPath: string, manifest: any = {}) {
    // 1. Explicit flag in manifest
    if (manifest.bundled === true) {
        return true;
    }

    // 2. Ships its own non-empty node_modules
    const nodeModulesPath = path.join(pluginPath, 'node_modules');
    if (fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory()) {
        try {
            if (fs.readdirSync(nodeModulesPath).length > 0) return true;
        } catch { /* unreadable node_modules — treat as absent */ }
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
            console.warn(`[Plugins] Error reading manifest for ${logSafe(activeSlug)}: ${logSafe(e.message)}`);
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
        console.warn(`⚠️ Could not parse semver ranges: ${logSafe(range1)}, ${logSafe(range2)}`);
        return true;
    }
}

/**
 * Format dependency conflict error message
 */
function formatDependencyConflictError(rawSlug: string, conflicts: any[]) {
    // Sanitized HERE rather than around the console.error at the call site: this report is deliberately
    // multi-line (a boxed table), so stripping line breaks from the finished string would destroy it.
    // Cutting the untrusted values at the point they enter the message keeps the layout and still means
    // no crafted slug or plugin name can forge an entry in the operator's log.
    const slug = logSafe(rawSlug);
    const conflictDetails = conflicts.map((c: any) => {
        return `  ┌─────────────────────────────────────────────────────────────────┐
  │  Dependencia: ${logSafe(c.dep).padEnd(49)}│
  │  ${slug} requiere: ${logSafe(c.newRange).padEnd(44)}│
  │  ${logSafe(c.conflictPlugin)} (activo) usa: ${logSafe(c.existingRange).padEnd(36)}│
  │  Versiones incompatibles: No hay versión que satisfaga ambos    │
  └─────────────────────────────────────────────────────────────────┘`;
    }).join('\n\n');

    const pluginNames = [...new Set(conflicts.map((c: any) => c.conflictPlugin))];
    const solutions = pluginNames.map((p, i) => `  ${i + 1}. Desactivar "${logSafe(p)}" antes de activar "${slug}"`).join('\n');

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
        console.log(`📦 Plugin '${logSafe(slug)}' is bundled - skipping shared dependency installation.`);
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
    const declared = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

    // A dependency is "already present" if root/package.json declares it OR it is physically installed in
    // any node_modules the plugin's require() walks through (its own → backend's → root's). Checking only
    // root/package.json missed deps that ship in backend/node_modules (e.g. the mail server's smtp-server),
    // which made activation redundantly `npm install` deps that were already resolvable.
    const NM_DIRS = [
        pluginPath ? path.join(pluginPath, 'node_modules') : null,
        path.join(ROOT_DIR, 'backend', 'node_modules'),
        path.join(ROOT_DIR, 'node_modules'),
    ].filter(Boolean) as string[];
    const isPresent = (dep: string) =>
        !!declared[dep] || NM_DIRS.some((d) => {
            try { return fs.existsSync(path.join(d, dep, 'package.json')); } catch { return false; }
        });

    const toInstall: string[] = [];
    for (const [dep, version] of Object.entries(manifest.dependencies)) {
        if (!isPresent(dep)) {
            toInstall.push(`${dep}@${version}`);
        }
    }

    if (toInstall.length > 0) {
        console.log(`📦 Plugin '${logSafe(slug)}' requires: ${logSafe(toInstall.join(', '))}`);
        console.log(`   ⏳ Installing dependencies... (server may restart)`);
        try {
            // SECURITY: execFile with an argument array (no shell) so dependency names from
            // the plugin manifest cannot inject shell commands. Async so we don't block the event loop.
            await execFileAsync(NPM_BIN, ['install', ...toInstall, '--save', '--ignore-scripts'], {
                cwd: ROOT_DIR
            });
            console.log(`   ✅ Dependencies installed successfully.`);
        } catch (error) {
            throw new Error(`Failed to install dependencies for ${slug}: ${error.message}`, { cause: error });
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
                    console.warn(`[Plugins] Error reading manifest during cleanup for ${logSafe(activeSlug)}: ${logSafe(e.message)}`);
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
                console.log(`🛡️ Persisting core dependency: ${logSafe(dep)}`);
            } else {
                toRemove.push(dep);
            }
        }
    }

    if (toRemove.length > 0) {
        console.log(`♻️ Garbage Collector: Removing unused dependencies for ${logSafe(slug)}: ${logSafe(toRemove.join(', '))}`);
        try {
            // Async so pruning on the deactivate request path doesn't block the event loop.
            await execFileAsync(NPM_BIN, ['uninstall', ...toRemove, '--save'], { cwd: ROOT_DIR });
            console.log(`   ✅ Dependencies removed successfully.`);
        } catch (e) {
            console.error(`   ⚠️ Failed to prune dependencies: ${logSafe(e.message)}`);
        }
    }
}

const PLUGINS_DIR_REAL = path.resolve('./plugins');
const acorn = require('acorn');
const walk = require('acorn-walk');

// ── THE RESIDUE PASS' EXEMPTION TABLES ──────────────────────────────────────────────────────────────
//
// The residue pass is the only fail-closed part of the AST scan: an fs value sitting anywhere the
// resolver did not consume is CHARGED the permission. Every entry below is therefore a WEAKENING of the
// only honest thing this scanner does, and the two of them are the complete list of them.
//
// They used to be an inline array of PARENT NODE TYPES, and that shape is what let the class stay open:
// 'PropertyDefinition', 'MethodDefinition' and 'AssignmentPattern' were listed as "not a use of the
// value", which is true of a class field's NAME and false of its INITIALIZER — so `class B { fsx =
// require('fs') }` and `function f(m = require('fs'))` were exempted from the very pass that exists to
// catch what the resolver missed. A type is not a position. Each entry is now a PREDICATE over
// (parent, node), so an exemption can only cover the syntactic slot whose justification it states.
//
// Exported so a gate can enumerate the exemptions from the code itself and demand a fail-closed probe
// for each: adding a weakening here without proving it cannot hide an fs value turns that test red.

/** parentType -> "in THIS slot the node is a name being introduced, never the value being used". */
const RESIDUE_NOT_A_USE: Record<string, (parent: any, node: any) => boolean> = {
    // Declaration / assignment TARGETS.
    VariableDeclarator: (p, n) => p.id === n,
    AssignmentExpression: (p, n) => p.left === n,
    AssignmentPattern: (p, n) => p.left === n,          // `function f(fs = 1)` — the name, NOT the default
    // Property NAMES (`o.fs`, `{ fs: 1 }`, `class C { fs = 1 }`, `class C { fs() {} }`).
    MemberExpression: (p, n) => p.property === n,
    Property: (p, n) => p.key === n,
    PropertyDefinition: (p, n) => p.key === n,           // the field NAME; its value is charged
    MethodDefinition: (p, n) => p.key === n,             // the method NAME; its body is walked normally
    // Binding patterns: every identifier inside one is a name being introduced.
    ObjectPattern: () => true,
    ArrayPattern: () => true,
    RestElement: () => true,
    ImportSpecifier: () => true,
    ImportDefaultSpecifier: () => true,
    ImportNamespaceSpecifier: () => true,
    // Function/class NAMES and PARAMETERS — but never a body or a default value.
    FunctionDeclaration: (p, n) => p.id === n || (p.params || []).includes(n),
    FunctionExpression: (p, n) => p.id === n || (p.params || []).includes(n),
    ArrowFunctionExpression: (p, n) => (p.params || []).includes(n),
    ClassDeclaration: (p, n) => p.id === n,
    ClassExpression: (p, n) => p.id === n,
    CatchClause: (p, n) => p.param === n,
    // Labels are a namespace of their own.
    LabeledStatement: (p, n) => p.label === n,
    BreakStatement: (p, n) => p.label === n,
    ContinueStatement: (p, n) => p.label === n,
};

/** parentType -> "the ENCLOSING expression is itself evaluated by the resolver, so judging the node
 *  here would double-charge the same flow". These are not blind spots; they are the same value seen
 *  one node earlier. */
const RESIDUE_JUDGED_ELSEWHERE: Record<string, (parent: any, node: any) => boolean> = {
    MemberExpression: (p, n) => p.object === n && !p.computed,   // `fs.writeFileSync` — the member is judged
    CallExpression: (p, n) => p.callee === n,                    // `g()` — the call is judged
    AwaitExpression: () => true,
    ExpressionStatement: () => true,
    ConditionalExpression: () => true,
    LogicalExpression: () => true,
    SequenceExpression: () => true,
};

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

/**
 * ═══ WHAT THIS SCANNER IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT ══════════════════════════════════
 *
 * It is a BEST-EFFORT, INSTALL-TIME WARNING. It reads a plugin's source and reports which capabilities
 * the code appears to need, so the approval screen can tell an operator what they are being asked to
 * grant. That is a genuinely useful thing and it is all this is.
 *
 * IT IS NOT THE GATE. No denial depends on it any more, and no claim of coverage should be read into a
 * green run of it. The reason is structural, not a matter of effort: "does this code reach fs?" is a
 * DATA-FLOW question, and this file answers it by walking an AST and recognising the SHAPES in which a
 * value can be declared and carried. Three audit rounds in a row found new shapes — a class field, a
 * static field, a private field, a default parameter, `this.x = require('fs')`, an object getter, a
 * module returned from a helper — and each round the fix was another shape. That race cannot be won by
 * enumeration: the population is "every JavaScript expression that can hold a value", and it grows with
 * the language.
 *
 * KNOWN, DELIBERATE BLIND SPOTS (stated here so nobody has to rediscover them):
 *   · The FILE SET is not the plugin's whole tree. getFiles() below skips node_modules, hidden dirs and,
 *     for plugins, client/ frontend/ dist/ (browser bundles), and it only reads .js/.ts/.cjs/.mjs — so a
 *     payload in dist/p.js, in .h/p.js, or in an extensionless file is never even opened, while Node can
 *     still require() all three.
 *   · Anything that leaves the file (a re-export, a value handed to a helper) is followed only as far as
 *     the residue pass can charge it, and cross-file flow is not followed at all.
 *   · Reflection — a computed member, a Proxy, `Function('return require')`, a string built at runtime —
 *     is by construction outside what any AST walk can decide.
 *
 * WHERE THE ACTUAL DENIAL LIVES: at the moment of the call, in core/io-guard.ts (fsCapabilityRevoked +
 * isPathSafe) and core/secure-require.ts (guardFsCall). By then the module object has been obtained and
 * the syntax that carried it no longer exists, so no spelling can matter. A capability the plugin
 * DECLARED and the administrator DID NOT GRANT is refused there, on every path including the plugin's
 * own directory, and the refusal takes effect on the next call because the grant store is read live.
 *
 * What this scanner still buys, honestly:
 *   · the approval screen's capability list (declaration mode), so an operator is not asked to approve
 *     a blank cheque;
 *   · a loud, early failure for the shapes it DOES follow, at install and at activation, which is
 *     cheaper for an honest plugin author than a runtime EACCES;
 *   · a fail-CLOSED residue pass: an fs value the resolver cannot follow to a call site is CHARGED the
 *     permission rather than ignored, so an unrecognised shape over-reports instead of under-reporting.
 * It buys no containment. Treat a clean scan as "nothing obvious was found", never as "this plugin
 * cannot reach fs".
 *
 * The two modes of the AST scan, and WHY they must differ (audit #3 — "declaration ≠ authorization").
 *
 *  · 'declaration' (default) — the INSTALL-time pass. No grant record exists yet at install: the whole
 *    point of that pass is to produce the requested-permission list the admin sees on the approval
 *    screen before granting anything. Reading the grants there would reject every plugin that asks for
 *    a capability, and the operator would never get the chance to say yes. It is also the mode for
 *    THEMES (theme-engine.ts), which have no grant records at all.
 *
 *  · 'grant' — the ACTIVATION/LOAD pass (activate, cross-node load, boot load). Here the admin HAS had
 *    the chance to decide, so a declared-but-DENIED capability must fail the scan. Before this, the
 *    predicate read manifest.permissions only, so declaring `filesystem:write` passed the scanner even
 *    when the admin had explicitly revoked it in /admin/plugins: the toggle persisted, reloaded the
 *    isolate… and authorized nothing. Grant mode is strictly NARROWER than declaration mode (declared
 *    AND granted), so it can never let through code that install-time validation would have rejected.
 */
type PermissionScanMode = 'declaration' | 'grant';

function validatePluginPermissions(
    slug: string,
    pluginPath: string,
    manifest: any,
    options: { mode?: PermissionScanMode } = {},
) {
    // io-guard caches each slug's DECLARED permissions for the life of the process (a plugin cannot
    // rewrite its own manifest at runtime — isPathSafe refuses that write). But an INSTALL or UPDATE
    // rewrites it from outside the sandbox, and this function is called at exactly those moments (install,
    // activation, boot load, and the revocation path in routes/plugins.ts). Dropping the entry here is
    // what keeps the runtime gate reading the declaration that is on disk now, rather than the one that
    // was there when this process first touched the plugin.
    try { require('./io-guard').forgetDeclaredPermissions(slug); } catch { /* io-guard optional at boot */ }

    const permissions = manifest.permissions || [];
    const missingPermissions = new Set();
    const dangerousCalls = new Set();
    const mode: PermissionScanMode = options.mode === 'grant' ? 'grant' : 'declaration';

    const declares = (scope: any, access: any) => {
        return permissions.some((p: any) => p.scope === scope && (p.access === access || p.access === 'admin'));
    };

    /**
     * Did the OPERATOR grant this capability? Delegated to plugin-permissions.isGranted so there is ONE
     * definition of what a grant token means (in particular `scope:admin` implies only read+write, never
     * the high-power verbs). `network` is scope-only — its token is the bare literal, never
     * `network:<access>` — so it routes to isNetworkGranted instead. Required lazily: this module is on
     * the boot path and plugin-permissions pulls in options/plugin-context.
     */
    const isGrantedByAdmin = (scope: any, access: any) => {
        try {
            const perms = require('./plugin-permissions');
            if (scope === 'network') return perms.isNetworkGranted(slug);
            return perms.isGranted(slug, scope, access);
        } catch {
            return false; // fail CLOSED: no readable grant store ⇒ no authorization
        }
    };

    // The predicate the scan actually consults. In grant mode it is the AND of the two halves, so the
    // manifest still bounds what a grant can authorize (granting an undeclared scope stays inert, exactly
    // as plugin-context.hasPermission already behaves at runtime).
    const hasDeclared = (scope: any, access: any) => {
        if (!declares(scope, access)) return false;
        return mode === 'declaration' || isGrantedByAdmin(scope, access);
    };

    // Distinguishes the two failure shapes in the operator-facing message: "you forgot to declare it" is
    // fixed by editing manifest.json; "you declared it and the admin denied it" is fixed in /admin/plugins.
    // Same `missingPermissions` bucket either way — both are FIXABLE, unlike dangerousCalls.
    const noteMissing = (label: string, scope: any, access: any) => {
        if (!declares(scope, access)) { missingPermissions.add(label); return; } // unchanged legacy wording
        const token = scope === 'network' ? 'network' : `${scope}:${access}`;
        const hint = label.includes(`(${token})`) ? '' : ` (${token})`; // some labels already name the token
        missingPermissions.add(`${label}${hint} — declared but NOT granted by the administrator; enable it in /admin/plugins`);
    };

    // Sensitive Node builtins. Reached via require(), dynamic import(), or static import — all three
    // must be policed here. Dynamic import() in particular bypasses the CommonJS require proxy at
    // runtime (different module loader), so catching it statically is the primary defense; the worker's
    // ESM resolve hook is the runtime backstop.
    const SENSITIVE_MODULES = ['child_process', 'fs', 'fs/promises', 'http', 'https', 'net', 'dgram', 'dns', 'cluster', 'async_hooks', 'vm', 'worker_threads', 'module', 'inspector', 'v8', 'repl', 'sqlite', 'wasi'];
    // THEMES run functions.js IN-PROCESS on the host, where there is NO ESM import() resolve hook (unlike
    // the isolated worker), so a theme's import() of anything loads UNSCANNED module code = host RCE (#7/#8).
    const isThemeScan = /[\\/]themes[\\/]/.test(pluginPath);
    const flagModuleLiteral = (rawValue: any, kindLabel: string) => {
        const raw = String(rawValue);
        // An import specifier can bypass both this static scan AND the require proxy. The WHATWG URL parser
        // STRIPS ASCII whitespace/control chars before scheme detection, so `da\tta:` ≡ `data:` at runtime —
        // strip them here too before inspecting (#7).
        if (kindLabel === 'import') {
            const spec = raw.split('').filter(c => c.charCodeAt(0) > 0x20).join('');
            // For THEMES, only RELATIVE import specifiers (./ ../) are allowed — they resolve inside the
            // theme's own AST-scanned tree. A bare package ('evilpkg' from the theme's node_modules), an
            // absolute path, or a URL scheme all load code the scan never saw (#7). require() (CJS) stays
            // governed by secure-require at runtime; only ESM import() lacks a host hook.
            if (isThemeScan && !/^\.\.?[\\/]/.test(spec) && spec !== '.' && spec !== '..') {
                dangerousCalls.add(`import('${spec.slice(0, 40)}') — non-relative import specifier is not permitted in a theme`);
                return;
            }
            // Even a RELATIVE theme import that points into node_modules (`./node_modules/pwn`) reaches an
            // unscanned tree — reject it (#7). node_modules is not part of a theme's scanned own-code.
            if (isThemeScan && /(^|[\\/])node_modules([\\/]|$)/i.test(spec)) {
                dangerousCalls.add(`import('${spec.slice(0, 40)}') — importing from node_modules is not permitted in a theme`);
                return;
            }
            // For PLUGINS, reject data:/file:/blob:/remote URL-scheme specifiers (a bare/builtin import is
            // governed by the worker's ESM resolve hook; a URL scheme bypasses it and the require proxy).
            if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^node:/i.test(spec)) {
                dangerousCalls.add(`import('${spec.slice(0, 40)}') — non-relative URL-scheme import specifier is not permitted`);
                return;
            }
        }
        const moduleName = raw.replace(/^node:/, '');
        if (!SENSITIVE_MODULES.includes(moduleName)) return;
        if (moduleName === 'dns' || moduleName === 'net') {
            if (!hasDeclared('network', 'admin') && !hasDeclared('email', 'admin')) {
                // Either declaration satisfies this gate, so report against whichever one the manifest
                // actually asked for — otherwise a plugin that declared email:admin and was denied it
                // would be told it never declared anything, and the admin would edit the wrong thing.
                noteMissing(`Network/System access (${kindLabel}('${moduleName}'))`,
                    declares('network', 'admin') ? 'network' : 'email', 'admin');
            }
        } else if (moduleName !== 'fs') {
            dangerousCalls.add(`${kindLabel}('${moduleName}')`);
        }
    };

    // No plugin may skip the AST scan: there is no trust tier, and declaring system:admin grants
    // nothing. EVERY plugin runs the full scan (so its child_process/eval/native use is caught).

    // (isThemeScan is defined above.) THEMES run functions.js in-process, so EVERY .js they could require()
    // must be scanned — a theme shipping dist/payload.js + require('./dist/payload.js') would otherwise run
    // never-scanned host code (#8). For plugins, dist/client/frontend are browser bundles (never the worker).
    function getFiles(dir: string): string[] {
        let results: string[] = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        list.forEach((file: string) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) {
                // For PLUGINS skip node_modules, hidden dirs, and FRONTEND/dist bundles (browser-only, and
                // bundling falsely trips the scan). For THEMES skip ONLY node_modules — a theme's functions.js
                // runs in-process and can require() from ANY of its own subdirs incl. hidden ones like
                // `.assets/payload.js`, so those MUST be scanned too (#8).
                const skipDir = file.includes('node_modules') ||
                    (!isThemeScan && (file.startsWith('.') || ['client', 'frontend', 'dist'].includes(file)));
                if (!skipDir) {
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

    // === WHICH EXPRESSIONS ARE THE FILESYSTEM MODULE? (a DATA-FLOW question, not a spelling one) ===
    //
    // THE CLASS — and it has now bitten three times: "does this code reach fs?" is a data-flow question,
    // and every previous version of this gate answered it by ENUMERATING DECLARATION SHAPES. First the
    // callee object had to be LITERALLY NAMED `fs`; then the two shapes the audit wrote out verbatim were
    // added (`const q = require('fs'); q.writeFileSync(…)` and `const { writeFileSync } = require('fs')`);
    // then `require('fs').x()` and `fs.promises`. Each round the NEXT spelling in the same family walked
    // past with zero permissions declared, zero granted and a clean scan: a captured method
    // (`const w = require('fs').writeFileSync`), an alias of an alias, a method off an alias, an
    // assignment instead of a declaration, a function that RETURNS the module, a property of an object
    // literal. Enumerating forms can only ever close the forms enumerated — and this scan is not advisory:
    // routes/plugins.ts leans on it to REVOKE filesystem:write, so a form it cannot see used to make the
    // admin's toggle inert. Own-dir writes DO have a per-call runtime gate now (io-guard's
    // fsCapabilityRevoked, enforced in the isolate as well as on the host), which is what actually closed
    // that class; this scan is the belt that refuses to ACTIVATE code needing a denied capability, so the
    // operator learns at the switch instead of through a runtime error.
    //
    // So resolve the VALUE instead. Below is a small local abstract interpretation, per file:
    //   · SOURCES  — require('fs'|'node:fs'|'fs/promises'|…), import … from 'fs', (await) import('fs')
    //                — produce the value `ns` (the module namespace);
    //   · MEMBERS  — a non-computed read off `ns` produces `m:<name>` (and `ns` again for `.promises`);
    //   · FLOW     — the value propagates through declarations, assignments, destructuring (incl. nested),
    //                object-literal properties, aliases-of-aliases and function RETURN values, iterated to
    //                a FIXPOINT so a call above its own declaration still resolves.
    // The call gate then asks what the callee EVALUATES to, once, instead of matching N shapes.
    //
    // No such analysis is complete, so the leftovers FAIL CLOSED: any fs value that escapes into a
    // position this resolver does not follow (passed as an argument, exported, stored behind a computed
    // member, returned from an untracked function…) demands the permission on the spot — see the residue
    // pass below. EXTEND THE RESOLVER; never add a sibling shape-matcher next to it.
    const FS_MODULE_NAMES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
    const isFsRequireCall = (n: any): boolean =>
        !!n && n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier'
        && n.callee.name === 'require' && n.arguments.length > 0
        && n.arguments[0].type === 'Literal' && FS_MODULE_NAMES.has(String(n.arguments[0].value));
    const isFsImportExpr = (n: any): boolean =>
        !!n && n.type === 'ImportExpression' && n.source && n.source.type === 'Literal'
        && FS_MODULE_NAMES.has(String(n.source.value));
    // Read-only fs methods — the SAME list the member-call gate has always used (unchanged on
    // purpose: this change is about which CALLS are seen, never about relaxing what they require).
    // Everything else is treated as a write, so an unknown name fails closed.
    const FS_READ_METHODS = new Set(['readFileSync', 'readFile', 'createReadStream', 'existsSync', 'statSync']);
    const noteFsCall = (methodName: string, how?: string) => {
        const isRead = FS_READ_METHODS.has(methodName);
        if (!hasDeclared('filesystem', isRead ? 'read' : 'write')) {
            noteMissing(`Filesystem ${isRead ? 'Read' : 'Write'} (${how || `fs.${methodName || 'unknown'}`})`, 'filesystem', isRead ? 'read' : 'write');
        }
    };

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        let ast;
        try {
            ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e) {
            // FAIL-CLOSED: a file that is actually loaded but cannot be parsed is treated as
            // a violation, so an attacker cannot hide a payload behind a deliberate parse-buster.
            console.warn(`[Security] Could not parse ${logSafe(file)} for AST analysis — treating as a violation (fail-closed).`);
            dangerousCalls.add(`Unparseable source file (${path.basename(file)})`);
            continue;
        }

        // === THE PER-FILE VALUE ENVIRONMENT (see "WHICH EXPRESSIONS ARE THE FILESYSTEM MODULE?") ======
        //
        // fsEnv maps a KEY — an identifier name (`q`) or a dotted member path (`o.f`, `exports.fs`) — to
        // the abstract value it holds: 'ns' (the fs namespace) or 'm:<method>' (one bound method).
        // 'fs' is seeded so the historical spelling behaves exactly as it always did.
        const fsEnv = new Map<string, string>([['fs', 'ns']]);
        const fsFnReturns = new Map<string, string>();   // function key -> the fs value it RETURNS
        const apiEnv = new Map<string, string>();        // local name -> apiAccess method it is an alias of
        const resolvedUse = new Set<any>();              // AST nodes consumed by a form the resolver follows
        let envChanged = true;   // read by the fixpoint loop below (first round always runs)
        // Every bind* returns WHETHER IT ACTUALLY BOUND. That boolean is the safety net of the whole
        // analysis: markUse() means "the resolver is now tracking this value, so the residue pass need
        // not charge it", and calling it after a bind that silently did nothing DISARMS the fail-closed
        // pass in precisely the case where the resolver failed. `this.fsx = require('fs')` was the
        // demonstration — pathKey() had no key for a ThisExpression and bindPattern() cannot bind a
        // MemberExpression, so nothing was tracked, yet the require was marked consumed and scanned
        // clean. Nothing may be marked as consumed unless a bind returned true.
        const bind = (key: string | null | undefined, val: string | null | undefined): boolean => {
            if (!key || !val) return false;
            if (fsEnv.get(key) !== val) { fsEnv.set(key, val); envChanged = true; }
            return true;
        };
        const bindFn = (key: string | null | undefined, val: string | null | undefined): boolean => {
            if (!key || !val) return false;
            if (fsFnReturns.get(key) !== val) { fsFnReturns.set(key, val); envChanged = true; }
            return true;
        };
        const bindApi = (key: string | null | undefined, val: string | null | undefined): boolean => {
            if (!key || !val) return false;
            if (apiEnv.get(key) !== val) { apiEnv.set(key, val); envChanged = true; }
            return true;
        };
        const markUse = (n: any) => { if (n && !resolvedUse.has(n)) { resolvedUse.add(n); envChanged = true; } };
        /** Dotted key for an identifier or a chain of non-computed members; null if any hop is dynamic. */
        const pathKey = (n: any): string | null => {
            if (!n) return null;
            if (n.type === 'Identifier') return n.name;
            // `this` gets a key so `this.fsx = require('fs')` in a constructor binds and
            // `this.fsx.writeFileSync(...)` in a method resolves to a WRITE instead of falling to the
            // residue pass as an anonymous escape. The key is file-scoped, not per-class: two classes in
            // one file with the same field name share it. That is deliberately imprecise in the SAFE
            // direction — it can only make more expressions resolve to an fs value, never fewer.
            if (n.type === 'ThisExpression') return 'this';
            if (n.type === 'MemberExpression' && !n.computed && n.property && n.property.type === 'Identifier') {
                const base = pathKey(n.object);
                return base ? `${base}.${n.property.name}` : null;
            }
            return null;
        };
        /** What fs value does this EXPRESSION evaluate to? 'ns' | 'm:<method>' | null. */
        const evalFs = (n: any, depth = 0): string | null => {
            if (!n || depth > 16) return null;
            switch (n.type) {
                case 'Identifier':
                    return fsEnv.get(n.name) || null;
                case 'MemberExpression': {
                    if (n.computed) return null;   // dynamic member — flagged separately as obfuscation
                    const obj = evalFs(n.object, depth + 1);
                    const prop = n.property && n.property.type === 'Identifier' ? n.property.name : null;
                    if (obj === 'ns' && prop) return prop === 'promises' ? 'ns' : `m:${prop}`;
                    const key = pathKey(n);
                    return (key && fsEnv.get(key)) || null;
                }
                case 'CallExpression': {
                    if (isFsRequireCall(n)) return 'ns';                       // require('fs')
                    const k = pathKey(n.callee);                               // g() / o.g() returning fs
                    return (k && fsFnReturns.get(k)) || null;
                }
                case 'ImportExpression':
                    return isFsImportExpr(n) ? 'ns' : null;
                case 'AwaitExpression':
                    return evalFs(n.argument, depth + 1);                      // await import('fs') / await g()
                case 'ConditionalExpression':
                    return evalFs(n.consequent, depth + 1) || evalFs(n.alternate, depth + 1);
                case 'LogicalExpression':
                    return evalFs(n.left, depth + 1) || evalFs(n.right, depth + 1);
                case 'SequenceExpression':
                    return evalFs(n.expressions[n.expressions.length - 1], depth + 1);
                case 'ParenthesizedExpression':
                case 'TSAsExpression':
                case 'TSNonNullExpression':
                    return evalFs((n as any).expression, depth + 1);
                default:
                    return null;
            }
        };
        /** Bind a declaration target (identifier or destructuring pattern) to a resolved fs value. */
        // Returns TRUE only if at least one name was actually bound (see the note on bind()). A pattern
        // the resolver does not model — a MemberExpression target, an ArrayPattern, a nested shape past
        // the depth cap — returns false, and the caller must then leave the value for the residue pass.
        const bindPattern = (id: any, val: string, depth = 0): boolean => {
            if (!id || depth > 4) return false;
            if (id.type === 'Identifier') return bind(id.name, val);
            if (id.type === 'AssignmentPattern') return bindPattern(id.left, val, depth + 1);
            if (id.type !== 'ObjectPattern' || val !== 'ns') return false;
            let bound = false;
            for (const p of id.properties || []) {
                if (p.type === 'RestElement') { bound = bindPattern(p.argument, 'ns', depth + 1) || bound; continue; }
                if (p.type !== 'Property' || p.computed) continue;
                const imported = p.key.type === 'Identifier' ? p.key.name
                    : (p.key.type === 'Literal' ? String(p.key.value) : '');
                if (!imported) continue;
                const childVal = (imported === 'promises' || imported === 'default') ? 'ns' : `m:${imported}`;
                bound = bindPattern(p.value, childVal, depth + 1) || bound;   // incl. `const { promises: { writeFile } } = fs`
            }
            return bound;
        };
        /**
         * The fs value a function body RETURNS (arrow-expression body or any `return` inside it).
         *
         * The return expressions are COLLECTED into `sites` rather than marked as consumed here: whether
         * they may be marked depends on whether the CALLER managed to bind the function under a key the
         * resolver can look up again. A getter bound into a map nobody consults, or a function whose key
         * came out null, must leave its `require('fs')` for the residue pass — marking it there was how
         * `const h = { get f() { return require('fs'); } }` scanned clean.
         */
        const returnValueOf = (fnNode: any, sites?: any[]): string | null => {
            if (!fnNode || !fnNode.body) return null;
            if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body.type !== 'BlockStatement') {
                const v = evalFs(fnNode.body);
                if (v && sites) sites.push(fnNode.body);
                return v;
            }
            let found: string | null = null;
            try {
                walk.simple(fnNode.body, {
                    ReturnStatement(r: any) {
                        const v = evalFs(r.argument);
                        if (v) { found = found || v; if (sites) sites.push(r.argument); }
                    },
                });
            } catch { /* body shape we can't walk — the residue pass still fails closed */ }
            return found;
        };
        /** Bind a function-shaped initializer under `key`, marking its return sites only if it bound. */
        const bindFnFrom = (key: string | null, fnNode: any): boolean => {
            const sites: any[] = [];
            const bound = bindFn(key, returnValueOf(fnNode, sites));
            if (bound) sites.forEach(markUse);
            return bound;
        };
        /** Record fs values held by an object literal's properties: `const o = { f: require('fs') }`. */
        const recordObjectLiteral = (baseKey: string | null, obj: any, depth = 0) => {
            if (!baseKey || !obj || obj.type !== 'ObjectExpression' || depth > 4) return;
            for (const p of obj.properties || []) {
                if (p.type !== 'Property' || p.computed) continue;
                const k = p.key.type === 'Identifier' ? p.key.name
                    : (p.key.type === 'Literal' ? String(p.key.value) : '');
                if (!k) continue;
                const childKey = `${baseKey}.${k}`;
                const v = evalFs(p.value);
                if (v) { if (bind(childKey, v)) markUse(p.value); continue; }
                if (p.value && p.value.type === 'ObjectExpression') { recordObjectLiteral(childKey, p.value, depth + 1); continue; }
                if (p.value && (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression')) {
                    // A GETTER is not a function you call — READING the property IS the value. Binding it
                    // into fsFnReturns (which evalFs only consults for a CallExpression) left `holder.f`
                    // resolving to null at the use site while its inner require was marked consumed, so
                    // `{ get f() { return require('fs'); } }` reached fs with a clean scan. The equivalent
                    // Object.defineProperty getter was blocked all along — the difference was pure syntax.
                    const sites: any[] = [];
                    const rv = returnValueOf(p.value, sites);
                    const bound = p.kind === 'get' ? bind(childKey, rv) : bindFn(childKey, rv);
                    if (bound) sites.forEach(markUse);
                }
            }
        };
        // Re-EXPORTING the module (or one of its methods) hands it to ANOTHER FILE, and this resolver is
        // per-file: `module.exports = require('fs')` in a.js + `require('./a').writeFileSync(...)` in b.js
        // would otherwise be two clean scans that add up to an ungranted write. Exported keys are bound
        // (so calls in THIS file still resolve) but never marked as a resolved use, so the residue pass
        // below charges the permission at the export site — the fail-closed answer to a flow that leaves
        // the file. Covers CJS here; the ESM `export` forms are handled in the residue pass.
        const isExportKey = (key: string | null | undefined): boolean =>
            !!key && (key === 'exports' || key.startsWith('exports.')
                || key === 'module.exports' || key.startsWith('module.exports.'));
        /**
         * Keys whose value the resolver binds for LOCAL readability but must never treat as consumed.
         * `exports.*`/`module.exports.*` leave the file. `this.*` leaves the SCOPE: an instance property
         * is readable from anywhere the instance travels (`new Box().fsx`, a getter, another module that
         * received the object), and this resolver is per-file with no notion of which class `this` is.
         * Binding them makes an in-file use resolve to the right verb; not marking them keeps the residue
         * pass charging the permission, which is the honest answer for a flow we cannot follow to its end.
         */
        const isEscapingKey = (key: string | null | undefined): boolean =>
            isExportKey(key) || key === 'this' || (!!key && key.startsWith('this.'));

        // Names that are aliases of a permission-gated API method (`const d = wordjs.dbAsync; d(sql)`).
        // Same class, same resolver: apiAccess is matched on the CALLED NAME, so a captured method used to
        // slip past exactly like the fs ones did.
        const apiNameOf = (n: any): string | null => {
            if (!n) return null;
            if (n.type === 'Identifier') return apiEnv.get(n.name) || (Object.prototype.hasOwnProperty.call(apiAccess, n.name) ? n.name : null);
            if (n.type === 'MemberExpression' && !n.computed && n.property && n.property.type === 'Identifier') {
                return Object.prototype.hasOwnProperty.call(apiAccess, n.property.name) ? n.property.name : null;
            }
            return null;
        };

        // BINDING PASS (per file), run BEFORE the main walk so a call that appears above its own
        // declaration is still resolved, and ITERATED TO A FIXPOINT so aliases-of-aliases and
        // functions declared after their use converge instead of depending on source order.
        const collect = () => walk.simple(ast, {
            VariableDeclarator(node: any) {
                const init = node.init;
                if (!init) return;
                const val = evalFs(init);
                if (val) {
                    const bound = bindPattern(node.id, val);
                    if (bound && !isExportKey(node.id && node.id.type === 'Identifier' ? node.id.name : null)) markUse(init);
                    return;
                }
                const key = node.id && node.id.type === 'Identifier' ? node.id.name : null;
                if (!key) return;
                if (init.type === 'ObjectExpression') { recordObjectLiteral(key, init); return; }
                if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') { bindFnFrom(key, init); return; }
                if (init.type === 'Identifier' && fsFnReturns.has(init.name)) { bindFn(key, fsFnReturns.get(init.name)); return; }
                bindApi(key, apiNameOf(init));
            },
            AssignmentExpression(node: any) {
                if (node.operator !== '=') return;
                const key = pathKey(node.left);
                const val = evalFs(node.right);
                if (val) {
                    // `q = require('fs')`, `o.f = require('fs')`, `this.f = require('fs')`,
                    // `({ writeFileSync } = require('fs'))`. markUse is conditional on the bind having
                    // HAPPENED — a target the resolver cannot key (a computed member, an array pattern)
                    // must fall through to the residue pass, not be silently declared "handled".
                    const bound = key ? bind(key, val) : bindPattern(node.left, val);
                    if (bound && !isEscapingKey(key)) markUse(node.right);   // exporting / `this` is an escape (see above)
                    return;
                }
                if (!key) return;
                if (node.right.type === 'ObjectExpression') { recordObjectLiteral(key, node.right); return; }
                if (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression') { bindFnFrom(key, node.right); return; }
                if (node.right.type === 'Identifier' && fsFnReturns.has(node.right.name)) { bindFn(key, fsFnReturns.get(node.right.name)); return; }
                bindApi(key, apiNameOf(node.right));
            },
            FunctionDeclaration(node: any) {
                if (node.id && node.id.type === 'Identifier') bindFnFrom(node.id.name, node);
            },
            // A CLASS FIELD is an assignment with different punctuation: `class B { fsx = require('fs') }`.
            // It was in neither the binding pass nor (as a parent type) chargeable by the residue pass, so
            // it was the single cheapest way to hold the fs module invisibly. Binding `this.<field>` lets a
            // use INSIDE the class resolve to the right verb (write vs read) so the operator gets a useful
            // label — but the value is deliberately NEVER marked as consumed here, because a field can
            // equally be read from OUTSIDE (`new B().fsx`, a `static` read as `B.fsx`, a private `#fsx`),
            // and this per-file resolver has no key for any of those. Binding without marking means the
            // residue pass still charges the permission: better attribution, no loss of fail-closed.
            PropertyDefinition(node: any) {
                if (!node.value || node.static) return;
                const val = evalFs(node.value);
                const kName = node.key && node.key.type === 'Identifier' && !node.computed ? node.key.name : null;
                if (!val || !kName) return;
                bind(`this.${kName}`, val);
            },
            ImportDeclaration(node: any) {
                if (!node.source || node.source.type !== 'Literal') return;
                if (!FS_MODULE_NAMES.has(String(node.source.value))) return;
                for (const s of node.specifiers || []) {
                    if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') {
                        bind(s.local.name, 'ns');                      // import fsx, * as fsy from 'fs'
                    } else if (s.type === 'ImportSpecifier') {
                        const imported = s.imported && s.imported.type === 'Identifier'
                            ? s.imported.name : String(s.imported && s.imported.value);
                        if (imported) bind(s.local.name, (imported === 'promises' || imported === 'default') ? 'ns' : `m:${imported}`);
                    }
                }
            },
        });
        for (let round = 0; round < 8 && envChanged; round++) {   // monotone (maps only grow) ⇒ terminates
            envChanged = false;
            collect();
        }

        walk.ancestor(ast, {
            NewExpression(node: any) {
                // `new Function('…')` / new (Async|Generator)Function('…') build code from a STRING that this
                // static scan cannot see. The isolated worker also blocks code-gen at runtime
                // (--disallow-code-generation-from-strings), but an IN-PROCESS theme has no such backstop, so
                // flagging here is the only gate against `new Function('return import("child_process")')()` (#8).
                if (node.callee && node.callee.type === 'Identifier' && ['Function', 'GeneratorFunction', 'AsyncFunction'].includes(node.callee.name)) {
                    dangerousCalls.add(`new ${node.callee.name}() — runtime code generation is not permitted`);
                }
            },
            CallExpression(node: any, ancestors: any) {
                let name = '';
                // 1. Direct calls: eval(), execSync()
                if (node.callee.type === 'Identifier') {
                    name = node.callee.name;

                    // Runtime code-generation (eval()/Function()) defeats this static scan — an in-process
                    // theme has no runtime code-gen block (unlike the worker). Flag it (#8).
                    if (name === 'eval' || name === 'Function') {
                        dangerousCalls.add(`${name}() — runtime code generation is not permitted`);
                    }

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

                }

                // === THE FS GATE: ONE question, asked of the VALUE the callee evaluates to ===
                // There is deliberately no list of call shapes here any more. `fs.x()`, `q.x()`,
                // `require('fs').x()`, `p.x()` (p = fs.promises), a bare `writeFileSync()` destructured out
                // of it, a captured `w = require('fs').writeFileSync`, an alias of an alias, `o.f.x()`,
                // `g().x()` where g returns the module — every one of them is the SAME fact to the
                // resolver above, and a new spelling is covered without touching this line.
                const calleeVal = evalFs(node.callee);
                if (calleeVal) {
                    markUse(node.callee);
                    if (calleeVal.startsWith('m:')) noteFsCall(calleeVal.slice(2));
                    // Calling the namespace ITSELF (`require('fs')(…)`) is not a known read → fails closed.
                    else noteFsCall('', 'the fs module value is called directly');
                }

                // SAFE LOOKUP: Prevent prototype-based false positives (like toString). Asked of the
                // BINDING too (`const d = wordjs.dbAsync; d(sql)`), same class as the fs gate above.
                const apiName = (name && Object.prototype.hasOwnProperty.call(apiAccess, name)) ? name : apiNameOf(node.callee);
                if (apiName && Object.prototype.hasOwnProperty.call(apiAccess, apiName)) {
                    const { scope, access, label } = (apiAccess as any)[apiName];
                    if (!hasDeclared(scope, access)) {
                        noteMissing(`${label} (${scope}:${access})`, scope, access);
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

        // === RESIDUE PASS: WHAT THE RESOLVER COULD NOT FOLLOW FAILS CLOSED =========================
        //
        // The resolver above is deliberately small, so it is INCOMPLETE — and an incomplete analysis that
        // stays silent about its own blind spots is exactly how the previous three versions of this gate
        // shipped a bypass. So the leftovers are charged instead of ignored: if an fs value (the module,
        // or one of its methods) appears anywhere that is NOT one of the positions the resolver follows —
        // handed to a function (`helper(fs)`), exported, stored behind a computed member, returned from a
        // shape we did not bind — then the plugin must hold the permission for it, because from here on we
        // cannot say what it does with it. A method whose name is a known read costs `filesystem:read`;
        // anything else (the namespace, an unknown method) costs `filesystem:write`.
        //
        // Extending the resolver REMOVES entries from here; it never needs a new check of its own.
        walk.ancestor(ast, {
            Identifier: checkFsEscape,
            MemberExpression: checkFsEscape,
            CallExpression: checkFsEscape,
            ImportExpression: checkFsEscape,
            AwaitExpression: checkFsEscape,
            // The ESM twins of `module.exports = require('fs')` — same escape, different syntax.
            ExportNamedDeclaration(node: any) {
                for (const sp of node.specifiers || []) noteEscape(evalFs(sp.local));
                const decl = node.declaration;
                if (decl && decl.type === 'VariableDeclaration') {
                    for (const d of decl.declarations || []) noteEscape(evalFs(d.id));
                }
            },
            ExportDefaultDeclaration(node: any) { noteEscape(evalFs(node.declaration)); },
            ExportAllDeclaration(node: any) {
                if (node.source && node.source.type === 'Literal' && FS_MODULE_NAMES.has(String(node.source.value))) {
                    noteFsCall('', 're-exporting the fs module escapes static analysis here');
                }
            },
        });
        function noteEscape(val: string | null) {
            if (!val) return;
            noteFsCall(val.startsWith('m:') ? val.slice(2) : '',
                val.startsWith('m:')
                    ? `fs.${val.slice(2)} — the bound method escapes static analysis here`
                    : 'the fs module value escapes static analysis here');
        }
        function checkFsEscape(node: any, ancestors: any[]) {
            const val = evalFs(node);
            if (!val) return;
            if (resolvedUse.has(node)) return;                       // consumed by a binding we resolved
            const parent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
            if (!parent) return;
            // (a) NOT a use of the value at all — a declaration target, a property NAME, a parameter name.
            const notAUse = RESIDUE_NOT_A_USE[parent.type];
            if (notAUse && notAUse(parent, node)) return;
            // (b) a position the gates above already judged: the enclosing member/call is evaluated itself.
            const judged = RESIDUE_JUDGED_ELSEWHERE[parent.type];
            if (judged && judged(parent, node)) return;
            noteEscape(val);
        }
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
                console.error(`Error parsing manifest for ${logSafe(entry.name)}: ${logSafe(e.message)}`);
                continue;
            }
        }
        // 2. Manifest-less (legacy) plugin. SECURITY: do NOT require() the entry on the HOST to read
        //    metadata — that executes untrusted top-level code OUTSIDE the worker sandbox (host RCE on
        //    plugin enumeration / GET /plugins). Use directory-name metadata only; real loading happens
        //    later, sandboxed, in the worker. Plugins wanting proper metadata must ship a manifest.json.
        else {
            const mainFile = findMainFile(pluginDir);
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
 * change is silently LOST. We serialize ONLY the option read+write (NOT worker start/stop) to avoid any
 * deadlock or holding a lease across slow plugin I/O, at TWO levels — both are needed:
 *
 *  · ACROSS nodes: the distributed lock 'wordjs:active-plugins'. Real on Postgres/multi-node.
 *  · WITHIN this process: `_activePluginsChain`. The dist-lock is a deliberate NO-OP on SQLite (single
 *    host, so there is no cross-process contention to resolve), and the earlier comment here claimed
 *    "the now-atomic updateOption UPSERT keeps it correct" — it does not. The UPSERT is atomic for the
 *    WRITE of the array; the cycle is read → mutate → write with an `await` at every step, and Node is
 *    single-THREADED but not atomic ACROSS awaits. Two concurrent requests in one process (activate +
 *    deactivate, or an activation racing CrashGuard's boot-time disable) both read the same base array
 *    and the second write clobbers the first — exactly the lost update the dist-lock was added to stop,
 *    on the deployment shape most installs actually run. The promise chain closes it; it also makes the
 *    Postgres path re-entrancy-safe, since dist-lock leases are keyed per PROCESS (HOLDER), so two
 *    in-process callers could otherwise both "hold" the same lease.
 *
 * `mutator(active)` returns the new array (or undefined to leave it unchanged).
 */
let _activePluginsChain: Promise<any> = Promise.resolve();
async function withActivePluginsLock(mutator: (active: string[]) => string[] | undefined | Promise<string[] | undefined>) {
    const prev = _activePluginsChain;
    let release!: () => void;
    _activePluginsChain = new Promise<void>((r) => { release = r; });
    // A prior failed mutation must not wedge the queue for everyone behind it.
    await prev.catch(() => { /* ignore the predecessor's outcome, only its completion */ });
    try {
        return await _withActivePluginsDistLock(mutator);
    } finally {
        release();
    }
}

/** The cross-node half. Only ever called from inside the in-process chain above. */
async function _withActivePluginsDistLock(mutator: (active: string[]) => string[] | undefined | Promise<string[] | undefined>) {
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

// Serializes plugin ACTIVATIONS end-to-end. The dependency conflict-check reads active_plugins and the
// `npm install --save` mutates the shared ROOT_DIR tree, but active_plugins is only written at the very
// end (after the isolate loads). Without serialization, two concurrent activations of mutually-incompatible
// non-bundled plugins each pass the conflict check (neither committed yet) AND run concurrent npm installs —
// bypassing the compat invariant and corrupting root package.json/node_modules. Chaining every activation so
// B cannot start until A has committed to active_plugins closes both races. Activation is an admin action,
// not a hot path, so full serialization is acceptable.
let _pluginActivationChain: Promise<any> = Promise.resolve();
async function activatePlugin(slug: string) {
    const prev = _pluginActivationChain;
    let release!: () => void;
    _pluginActivationChain = new Promise<void>((r) => { release = r; });
    await prev.catch(() => { /* a prior failed activation must not block the next */ });
    try {
        return await _activatePluginUnlocked(slug);
    } finally {
        release();
    }
}

/**
 * Activate a plugin
 */
async function _activatePluginUnlocked(slug: string) {
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

            // 0. Static Permission Verification. GRANT mode: the admin has already seen the requested
            // permissions (install-time validation fed that screen), so from here a capability that was
            // declared but DENIED must block activation — otherwise the per-permission switch is inert.
            validatePluginPermissions(slug, plugin.path, manifest, { mode: 'grant' });

            // 1a. Check if this is a bundled plugin
            const isBundled = isBundledPlugin(plugin.path, manifest);

            if (isBundled) {
                console.log(`📦 Plugin '${logSafe(slug)}' detected as bundled - no shared dependencies.`);
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
            console.error(`🛡️ Protection Active: Blocking ${logSafe(slug)} activation due to: ${logSafe(e.message)}`);
            throw e;
        }
    }

    // 2. Run Plugin Tests (if present)
    const { verifyPluginTests } = require('./plugin-test-runner');
    try {
        const testResult = await verifyPluginTests(slug);
        if (!testResult.skipped) {
            console.log(`   🧪 Tests verified: ${logSafe(testResult.passed)}/${logSafe(testResult.tests)} passed`);
        }
    } catch (testError) {
        console.error(`🧪 Test Failure: Plugin '${logSafe(slug)}' blocked due to failing tests.`);
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

        // Provision the plugin's low-privilege DB role (Postgres) BEFORE the worker can issue a query, so
        // its SELECT/DML runs under a role GRANTed only its own wjp_<slug>_ tables — the database enforces
        // isolation below the SQL text-guard. No-op off Postgres; graceful if the pool user lacks CREATEROLE.
        try { await require('./plugin-db-isolation').provision(slug); } catch { /* best-effort — text-guard remains */ }

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
        throw new Error(`Failed to activate plugin ${slug}: ${error.message}`, { cause: error });
    }
}

// ...

/**
 * Deactivate a plugin
 */
async function deactivatePlugin(slug: string, opts: { prune?: boolean } = {}) {
    if (!await isPluginActive(slug)) {
        return { success: true, message: 'Plugin not active' };
    }

    // 1. Auto-Prune Dependencies — SKIPPED for an in-place update (`prune: false`). During an update the
    // code is only moving aside for a moment and the new version reinstalls its deps immediately; a
    // prune-then-reinstall round trip strands a plugin whose declared range no longer resolves (and the
    // update's rollback can't rescue that). Normal deactivation still prunes (default).
    if (opts.prune !== false) {
        const plugins = scanPlugins();
        const plugin = plugins.find(p => p.slug === slug);
        if (plugin) {
            const manifestPath = path.join(plugin.path, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    await prunePluginDependencies(slug, manifest);
                } catch (e) {
                    console.error(`⚠️ Failed to process manifest for prune ${logSafe(slug)}: ${logSafe(e.message)}`);
                }
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
    if (!plugin) { console.warn(`[plugins] cross-node activate '${logSafe(slug)}': not present on this node`); return false; }
    const mainFile = findMainFile(plugin.path);
    if (!mainFile) { console.warn(`[plugins] cross-node activate '${logSafe(slug)}': no main file`); return false; }
    let manifest: any = null;
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) { try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* */ } }
    if (!manifest || !manifest.isolated) return false;
    try {
        // Re-validate locally (code-poisoning guard). GRANT mode: grants are replicated through the same
        // `plugin_grants` option this node already loaded, so a capability the admin revoked on ANOTHER
        // node must not be authorized here just because the manifest still declares it.
        validatePluginPermissions(slug, plugin.path, manifest, { mode: 'grant' });
        await installPluginDependencies(slug, manifest, plugin.path); // shared node_modules; idempotent
        try { unloadIsolatedPlugin(slug); } catch { /* not loaded here yet */ }
        await loadIsolatedPlugin(slug, mainFile);
        fixMiddlewareOrder();
        console.log(`[plugins] '${logSafe(slug)}' loaded live (cross-node activation)`);
        return true;
    } catch (e: any) {
        console.error(`[plugins] cross-node load of '${logSafe(slug)}' failed: ${logSafe(e && e.message)}`);
        return false;
    }
}

/**
 * Unload ONE plugin live from THIS node (cross-node deactivation). Does NOT touch `active_plugins`.
 */
function unloadOnePlugin(slug: string) {
    try { unloadIsolatedPlugin(slug); console.log(`[plugins] '${logSafe(slug)}' unloaded live (cross-node deactivation)`); return true; }
    catch (e: any) { console.warn(`[plugins] cross-node unload of '${logSafe(slug)}': ${logSafe(e && e.message)}`); return false; }
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
        console.error(`🚨 CRASH DETECTED: Plugin '${logSafe(culpritSlug)}' has ${logSafe(crashInfo.strikes)} strikes.`);
        console.error(`🛡️  CrashGuard: Automatically disabling '${logSafe(culpritSlug)}' to prevent boot loop.`);

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
        console.warn(`⚠️ [CrashGuard] Previous crash during '${logSafe(crashInfo.slug)}' load (Strike ${logSafe(crashInfo.strikes)}/${logSafe(CrashGuard.MAX_STRIKES)}). Retrying...`);
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

                // CRITICAL: Re-validate permissions on every boot to prevent code poisoning. GRANT mode
                // is safe here because index.ts loads plugin_grants (and backfills already-active
                // plugins with their declared set) BEFORE calling loadActivePlugins — so an install
                // predating the grant store still boots, while a revoked capability stays revoked
                // across restarts instead of quietly coming back.
                validatePluginPermissions(slug, plugin.path, manifest, { mode: 'grant' });

                await installPluginDependencies(slug, manifest, plugin.path);
            } catch (e) {
                console.error(`   ✗ Security Block for ${logSafe(slug)} on load: ${logSafe(e.message)}`);
                // We don't load plugins that fail validation
                continue;
            }
        }

        try {
            // MARK START
            CrashGuard.startLoading(slug);

            // Reconcile the plugin's DB role BEFORE its worker can query — existing installs get a role +
            // grants on their already-created wjp_<slug>_ tables. No-op off Postgres; graceful on failure.
            try { await require('./plugin-db-isolation').provision(slug); } catch { /* text-guard remains */ }

            // Plugins run ISOLATED in a worker (separate heap; core only via the bridge). Legacy
            // in-process execution has been removed — a plugin MUST declare "isolated": true.
            if (manifest && manifest.isolated) {
                await loadIsolatedPlugin(slug, mainFile);
                console.log(`   ✓ Plugin loaded ISOLATED: ${logSafe(plugin.name)} (${logSafe(slug)})`);
                CrashGuard.finishLoading(slug);
                continue;
            }

            console.warn(`   ⚠ Skipping '${logSafe(slug)}': not isolated. Set "isolated": true to run it in the sandbox (legacy in-process loading was removed).`);
            CrashGuard.finishLoading(slug);
        } catch (error) {
            // If we caught the error (it didn't crash the process), we should still clear the lock
            CrashGuard.finishLoading(slug);

            console.error(`   ✗ Failed to load plugin ${logSafe(slug)}: ${logSafe(error.message)}`);
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
    catch (e: any) { console.warn(`[uninstall ${logSafe(slug)}] removeGrants failed: ${logSafe(e && e.message)}`); }
    try { const { clearStrikes } = require('./crash-guard'); clearStrikes(slug); result.strikesCleared = true; }
    catch (e: any) { console.warn(`[uninstall ${logSafe(slug)}] clearStrikes failed: ${logSafe(e && e.message)}`); }
    try { await require('./plugin-assets').clearAssets(slug); } catch (e: any) { console.warn(`[uninstall ${logSafe(slug)}] clearAssets failed: ${logSafe(e && e.message)}`); }
    if (dropTables) {
        try {
            const { dbAsync, getDbType } = require('../config/database');
            const { isPostgres, isMySQL } = getDbType();
            // Mirror plugin-worker.js's tablePrefix normalization exactly.
            const prefix = ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
            const rows = isPostgres
                ? await dbAsync.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")
                : isMySQL
                    ? await dbAsync.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()")
                    : await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table'");
            // Filter in JS by the exact plugin prefix (no LIKE params → no cross-driver escaping pitfalls).
            const mine = (rows || []).map((r: any) => r.name).filter((n: string) => String(n).toLowerCase().startsWith(prefix));
            for (const name of mine) {
                await dbAsync.run(`DROP TABLE IF EXISTS "${String(name).replace(/"/g, '')}"`);
                result.tablesDropped.push(name);
            }
        } catch (e: any) { console.warn(`[uninstall ${logSafe(slug)}] table drop failed: ${logSafe(e && e.message)}`); }
    }
    // Drop the plugin's DB role (Postgres) — AFTER its tables so DROP ROLE has no dependency errors. No-op else.
    try { await require('./plugin-db-isolation').deprovision(slug); }
    catch (e: any) { console.warn(`[uninstall ${logSafe(slug)}] db role drop failed: ${logSafe(e && e.message)}`); }
    console.log(`[uninstall ${logSafe(slug)}] grants=${logSafe(result.grantsRemoved)} strikes=${logSafe(result.strikesCleared)} tablesDropped=${logSafe(result.tablesDropped.length)}`);
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
    // The residue pass' exemption tables — every weakening of the only fail-closed part of the scan.
    // Exported so a gate can enumerate them from the code instead of restating them in a test.
    RESIDUE_NOT_A_USE,
    RESIDUE_JUDGED_ELSEWHERE,
    validateManifestPermissions,
    KNOWN_PERMISSIONS,
    fixMiddlewareOrder,
    // Hard Lock + Bundling utilities
    isBundledPlugin,
    checkDependencyConflicts,
    PLUGINS_DIR
};
