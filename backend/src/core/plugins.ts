/**
 * WordJS - Plugin System
 * Equivalent to wp-includes/plugin.php (plugin loading)
 */

const { execSync, execFile } = require('child_process'); // execSync retained for parity; execFile used async below
const { promisify } = require('util');
const log = require('./module-logger').moduleLogger('core/plugins');
// Async execFile so npm install/uninstall does NOT block the event loop on the request path.
const execFileAsync = promisify(execFile);
// npm is npm.cmd on Windows; execFile needs the exact binary name.
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const fs = require('fs');
const path = require('path');
const { addAction, doAction, addFilter } = require('./hooks');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('./plugin-isolate');
// The static half of plugin-declared roles (the namespace rules); the stateful half is core/roles.ts.
const { validateManifestRoles } = require('./plugin-roles');
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
/**
 * MULTISITE. Plugin CODE is network-wide — installed, updated and removed by a network administrator on
 * the main site, with one shared node_modules. ACTIVATION and GRANTS are per site (they are options, and
 * options are per site), and each site runs its own worker of each plugin it activates (core/plugin-isolate).
 * A site other than the main one can activate only a plugin the network OFFERS it (a ceiling recorded by a
 * network administrator, core/network pluginCeiling), and never installs or prunes dependencies: that is
 * code installation, the network's job, done when the plugin is offered (offerPluginToSites).
 */
const siteContext = require('./site-context');
function onSecondarySite(): boolean {
    return siteContext.multisiteEnabled() && siteContext.currentSiteId() !== siteContext.PRIMARY_SITE_ID;
}
function notOfferedError(slug: string): Error & { code: string; status: number } {
    const e = new Error(`Plugin ${slug} is not available on this site: the network administrator has not offered it to the sites of the network.`) as Error & { code: string; status: number };
    e.code = 'plugin_not_offered';
    e.status = 403;
    return e;
}

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
 * Packages the host never auto-installs from a manifest's `dependencies`: they ship native builds or
 * spawn servers, which execute outside the plugin sandbox and would turn a manifest entry into host-level
 * code execution. A plugin that needs one must ship it (`"bundled": true` + its own node_modules/).
 * Exported so the plugin packer (scripts/pack-plugin.js) bundles exactly these, not a copy of the list.
 */
const BLOCKED_RUNTIME_DEPS = new Set([
    'embedded-postgres', 'better-sqlite3', 'sqlite3', 'node-gyp', 'node-pre-gyp',
    'node-sass', 'sharp', 'puppeteer', 'playwright', 'canvas', 'windows-build-tools'
]);

/**
 * ═══ WHAT A MANIFEST MAY ASK THE HOST TO `npm install` ═══════════════════════════════════════════════
 *
 * A plugin's `dependencies` are installed by the HOST, outside the plugin sandbox, into the host's own
 * node_modules (installPluginDependencies below). `--ignore-scripts` was believed to make that inert. It
 * does not: npm still runs the `prepare` script of a dependency it has to BUILD from source — a
 * `git+…`/`github:` spec and a `file:<directory>` spec — even with --ignore-scripts (verified on npm
 * 10.9: both a `file:../dep` and a `git+file://` dependency executed their `prepare`). A manifest entry
 * `"x": "file:../evil"` was therefore host code execution at activation. And the specs that do not run
 * anything are not harmless either: `npm:<other>@1` (an alias) and a tarball URL install arbitrary,
 * never-scanned code under a benign name, and a `link:`/`workspace:` spec reaches outside the registry
 * altogether.
 *
 * So the rule is an ALLOWLIST of shape, not a denylist of protocols: the name must be an npm package
 * name and the version must be a semver RANGE that semver itself accepts, containing none of the
 * characters every non-registry form needs (':' for a protocol or a drive letter, '/' or '\' for a
 * path, a URL or a `user/repo` shorthand) and not starting with '.' (a relative path). What survives is
 * exactly "this package, from the configured registry, in this version range" — which npm resolves as
 * a registry fetch and nothing else. A dist-tag (`latest`, `next`) is refused too: it is not a range,
 * and it is a moving target that a review of the manifest cannot pin.
 *
 * Enforced at THREE points that must agree, so they all call this one function: the install pipeline
 * (routes/plugins.ts installPluginFromZip — upload AND marketplace), installPluginDependencies itself
 * (defense in depth: whatever reached the disk by another path is still refused before npm runs), and
 * the packer (scripts/pack-plugin.js), which refuses to produce a ZIP the installer would refuse.
 */
// An npm package name, scoped or not. The first character of each part is alphanumeric on purpose:
// npm itself refuses '.'/'_' there, and a leading '-' would let a manifest KEY read as an npm flag
// (`--registry=…`) in the argv. Upper case is accepted because pre-2017 packages may carry it.
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
// Every non-registry spec form needs one of these: a protocol or drive letter (':'), a path, URL or
// `user/repo` shorthand ('/' or '\'). Control characters have no place in a range either.
const NON_REGISTRY_SPEC_CHARS_RE = /[:/\\\t\r\n\0]/;

/**
 * Is `spec` (the value of one manifest `dependencies` entry) a plain registry version range? Returns
 * null when it is, or a human-readable reason when it is not.
 */
function dependencySpecProblem(name: unknown, spec: unknown): string | null {
    const n = logSafe(name);
    if (typeof name !== 'string' || name.length === 0 || name.length > 214 || !NPM_PACKAGE_NAME_RE.test(name)) {
        return `dependency "${n}" is not a valid npm package name`;
    }
    if (typeof spec !== 'string' || spec.trim().length === 0) {
        return `dependency "${n}" must declare a semver version range as a string (e.g. "^1.2.3")`;
    }
    if (spec.length > 256) return `dependency "${n}" has an implausibly long version range`;
    const s = spec.trim();
    if (NON_REGISTRY_SPEC_CHARS_RE.test(s) || s.startsWith('.') || s.startsWith('~/')) {
        return `dependency "${n}": "${logSafe(spec)}" is not a registry version range — git, GitHub, file:, link:, workspace:, npm: aliases, paths and tarball URLs are not accepted (they can run build scripts on the server or install code under another name). Publish the package to npm and depend on a version range, or ship it inside the plugin ("bundled": true).`;
    }
    if (!semver.validRange(s)) {
        return `dependency "${n}": "${logSafe(spec)}" is not a valid semver range (dist-tags such as "latest" are not accepted — use a range like "^1.2.3")`;
    }
    return null;
}

/**
 * Validate a manifest's whole `dependencies` field. Returns human-readable problems (empty = valid).
 * Absent is valid; anything other than a plain object of name → range is not.
 */
function validateManifestDependencies(dependencies: any): string[] {
    if (dependencies === undefined || dependencies === null) return [];
    if (typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        return ['`dependencies` must be an object mapping npm package names to semver ranges.'];
    }
    const problems: string[] = [];
    for (const name of Object.keys(dependencies)) {
        const p = dependencySpecProblem(name, dependencies[name]);
        if (p) problems.push(p);
    }
    return problems;
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
            log.warn({ err: e }, `[Plugins] Error reading manifest for ${logSafe(activeSlug)}`);
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
        log.warn(`⚠️ Could not parse semver ranges: ${logSafe(range1)}, ${logSafe(range2)}`);
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

    // SECURITY (defense in depth): only plain registry version ranges ever reach `npm install`. The
    // install pipeline already refuses anything else, but a manifest can reach the disk by other paths
    // (a hand-copied folder, an install that predates the rule), so the refusal is repeated HERE,
    // before npm runs — and before the bundled shortcut, because a manifest declaring a git/file/alias
    // spec is not one this host accepts whether or not it would be installed. See dependencySpecProblem.
    const depProblems = validateManifestDependencies(manifest.dependencies);
    if (depProblems.length) {
        throw new Error(`Plugin '${slug}' declares dependencies the host refuses to install:\n- ${depProblems.join('\n- ')}`);
    }

    // Skip bundled plugins - they have their own dependencies
    if (pluginPath && isBundledPlugin(pluginPath, manifest)) {
        log.info({ slug: logSafe(slug) }, `📦 Plugin '${logSafe(slug)}' is bundled - skipping shared dependency installation.`);
        return;
    }

    // SECURITY: never auto-install packages that ship native builds or spawn servers (BLOCKED_RUNTIME_DEPS).
    // (Bundled plugins skipped above are operator-trusted and exempt.) Bundle these or install as an operator.
    for (const dep of Object.keys(manifest.dependencies)) {
        if (BLOCKED_RUNTIME_DEPS.has(dep)) {
            throw new Error(`Plugin '${slug}' declares dependency '${dep}', which cannot be auto-installed at runtime (native build / server process). Bundle it with the plugin or install it as an operator.`);
        }
    }

    let rootPkg: any = {};
    try {
        rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    } catch (e) {
        log.error({ err: e }, '⚠️ Could not read root package.json');
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
        log.info({ slug: logSafe(slug) }, `📦 Plugin '${logSafe(slug)}' requires: ${logSafe(toInstall.join(', '))}`);
        log.info('   ⏳ Installing dependencies... (server may restart)');
        try {
            // SECURITY: execFile with an argument array (no shell) so dependency names from
            // the plugin manifest cannot inject shell commands. Async so we don't block the event loop.
            // --ignore-scripts on the argv AND npm_config_ignore_scripts in the environment, so an .npmrc
            // the operator did not write cannot turn lifecycle scripts back on for the nested installs
            // npm spawns. Neither stops a git/file dependency's `prepare` (npm builds those regardless) —
            // which is why such specs never get this far (validateManifestDependencies above).
            await execFileAsync(NPM_BIN, ['install', ...toInstall, '--save', '--ignore-scripts'], {
                cwd: ROOT_DIR,
                env: { ...process.env, npm_config_ignore_scripts: 'true' },
            });
            log.info('   ✅ Dependencies installed successfully.');
            recordPluginInstalledDeps(slug, Object.keys(manifest.dependencies).filter((d) => toInstall.some((t) => t.startsWith(d + '@'))));
        } catch (error) {
            throw new Error(`Failed to install dependencies for ${slug}: ${error.message}`, { cause: error });
        }
    }
}

// ── WHICH PACKAGES THE DEPENDENCY GC MAY REMOVE (FALLOS 116) ──────────────────────────────────────
// Plugin dependencies are installed with `--save` into the host's own package.json, next to the core's,
// so that file cannot tell them apart. The GC used to remove every dependency of a deactivated plugin no
// other active plugin declared, shielded only by a hard-coded list — and `uuid`, which the core requires
// at load (routes/media) and three gallery plugins also declare, was uninstalled: the next restart died
// with "Cannot find module 'uuid'". So the GC now removes ONLY packages the plugin installer itself added
// (recorded here when it installs them), and never one the host process has loaded or another active
// plugin declares. A package that was already present when a plugin asked for it — every core
// dependency — is never recorded, so it can never be removed. An install from before this ledger existed
// has no record: its packages are kept, which costs disk, never a boot.
const PLUGIN_DEPS_LEDGER = path.join(ROOT_DIR, 'data', 'plugin-installed-deps.json');

function readPluginInstalledDeps(): Set<string> {
    try {
        const raw = JSON.parse(fs.readFileSync(PLUGIN_DEPS_LEDGER, 'utf8'));
        return new Set(Object.keys(raw && typeof raw === 'object' ? raw : {}));
    } catch { return new Set(); }
}

function writePluginInstalledDeps(mutate: (ledger: Record<string, string[]>) => void): void {
    // Host bookkeeping: written as the host even when an activation runs under a plugin's context.
    require('./plugin-context').runAsHost(() => {
        let ledger: Record<string, string[]> = {};
        try { ledger = JSON.parse(fs.readFileSync(PLUGIN_DEPS_LEDGER, 'utf8')) || {}; } catch { /* first entry */ }
        mutate(ledger);
        try {
            fs.mkdirSync(path.dirname(PLUGIN_DEPS_LEDGER), { recursive: true });
            fs.writeFileSync(PLUGIN_DEPS_LEDGER, JSON.stringify(ledger, null, 2));
        } catch (e: any) { log.warn({ err: e }, '[Plugins] could not record plugin-installed dependencies (they will be kept on deactivation)'); }
    });
}

function recordPluginInstalledDeps(slug: string, deps: string[]): void {
    if (!deps.length) return;
    writePluginInstalledDeps((ledger) => {
        for (const d of deps) ledger[d] = Array.from(new Set([...(Array.isArray(ledger[d]) ? ledger[d] : []), slug]));
    });
}

function forgetPluginInstalledDeps(deps: string[]): void {
    writePluginInstalledDeps((ledger) => { for (const d of deps) delete ledger[d]; });
}

/** True when the HOST process has loaded code from this package (plugins run in their own processes). */
function isLoadedByHost(dep: string): boolean {
    const marker = `${path.sep}node_modules${path.sep}${String(dep).split('/').join(path.sep)}${path.sep}`;
    return Object.keys(require.cache).some((f) => f.includes(marker));
}

/** The dependencies of a deactivated plugin that the GC may uninstall. Pure, so the rule is testable. */
function selectPrunableDependencies(deps: string[], ctx: { usedByOtherPlugins: Set<string>; installedByPlugins: Set<string>; loadedByHost: (dep: string) => boolean }): string[] {
    return deps.filter((dep) => !ctx.usedByOtherPlugins.has(dep) && ctx.installedByPlugins.has(dep) && !ctx.loadedByHost(dep));
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
                    log.warn({ err: e }, `[Plugins] Error reading manifest during cleanup for ${logSafe(activeSlug)}`);
                }
            }
        }
    }

    // 3. Only what the plugin installer itself added may go (see selectPrunableDependencies).
    const toRemove = selectPrunableDependencies(Object.keys(manifest.dependencies), {
        usedByOtherPlugins: usedDependencies as Set<string>,
        installedByPlugins: readPluginInstalledDeps(),
        loadedByHost: isLoadedByHost,
    });
    for (const dep of Object.keys(manifest.dependencies)) {
        if (!toRemove.includes(dep)) log.info({ dep: logSafe(dep) }, `🛡️ Keeping dependency '${logSafe(dep)}' (the host or another plugin uses it, or the plugin installer did not add it)`);
    }

    if (toRemove.length > 0) {
        log.info({ slug: logSafe(slug) }, `♻️ Garbage Collector: Removing unused dependencies for ${logSafe(slug)}: ${logSafe(toRemove.join(', '))}`);
        try {
            // Async so pruning on the deactivate request path doesn't block the event loop.
            await execFileAsync(NPM_BIN, ['uninstall', ...toRemove, '--save'], { cwd: ROOT_DIR });
            forgetPluginInstalledDeps(toRemove);
            log.info('   ✅ Dependencies removed successfully.');
        } catch (e) {
            log.error({ err: e }, '   ⚠️ Failed to prune dependencies');
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
    // Content DATA grants. There is no bridge call that reads core posts/comments (database:* is scoped
    // to the plugin's own wjp_<slug>_ tables); these gate the core hooks that CARRY that data
    // (core/hook-access): posts:read → wp_insert_post/post_updated/deleted_post (drafts and private
    // posts included); comments:read → wp_insert_comment/deleted_comment/comments:pre_insert without
    // the commenter's personal data; comments:pii → also the commenter's email, IP and user agent
    // (explicit only — never implied, like provider).
    posts: ['read'],
    comments: ['read', 'pii'],
    email: ['admin', 'provider'],
    // read → the notification_sent hook (every user's notifications, secrets redacted).
    notifications: ['send', 'provider', 'read'],
    express: ['register_route'],
    admin_menu: ['register'],
    assets: ['write'],
    // PRIVATE MEDIA (core/private-media.ts): read a private attachment's description and STREAM its bytes
    // as the response of one of the plugin's own routes. A special verb — `admin` never implies it.
    media: ['private_read'],
    // browser:script — the plugin's compiled frontend bundles (dist/{admin,hooks,component}.bundle.js)
    // run in the ADMIN SHELL's origin, with the session of whoever is viewing. See BROWSER_SCRIPT_TOKEN.
    browser: ['script'],
    // Register the roles the manifest's `roles` block declares (core/plugin-roles.ts). Every such role and
    // capability lives in the plugin's own namespace; the grant cannot reach a core capability.
    roles: ['declare'],
    // smtp:inbound — the HOST opens the public SMTP port (25) for this plugin and hands it every inbound
    // message (core/inbound-smtp.ts). EXCLUSIVE: at most one plugin may hold it (core/plugin-permissions
    // EXCLUSIVE_GRANTS). A special verb — nothing implies it.
    smtp: ['inbound'],
    // ai:use — ask the site's AI provider (core/ai-provider) for a text completion through wordjs.ai.complete.
    // The plugin gets text back, never the provider's key or settings. A special verb: `admin` never implies it.
    ai: ['use'],
    // content_access:provider — answer the members-only content filters (core/content-access): which
    // access levels a signed-in account HOLDS, and which levels the post editor offers. What a provider
    // answers unlocks gated bodies site-wide, so it is a special verb nothing implies.
    content_access: ['provider'],
    network: [], // scope-only: {scope:'network'} carries no access token
};

/**
 * ═══ browser:script — RUNNING CODE IN THE ADMINISTRATOR'S BROWSER IS A CAPABILITY ═══════════════════
 *
 * A plugin's frontend bundles are not sandboxed. The admin SPA import()s them into its own origin: the
 * hooks bundle of every active plugin on EVERY admin page load, the admin bundle when its page opens,
 * and the Verso block bundle in the editor and on public pages. Code that runs there runs with the
 * viewer's session — an administrator's, on the admin screens — and can call any API the administrator
 * can (create users, change roles, install plugins). Those bundles are never AST-scanned
 * (core/scan-exclusions skips dist/, client/, frontend/: they are browser code, and the scanner models
 * Node). So before this capability existed, a plugin granted nothing but `settings:read` could act as
 * the administrator simply by shipping a hooks bundle.
 *
 * This does NOT isolate that code — the real fix is to run plugin UI in separate-origin sandboxed
 * iframes, which is a redesign of the plugin frontend contract and is planned separately. What it does
 * is make the exposure an explicit, DEFAULT-DENY grant that the administrator sees and approves like
 * any other permission, with the consequence spelled out:
 *   · a plugin that ships browser code must DECLARE browser:script (install and activation refuse it
 *     otherwise — validateBrowserCapability below);
 *   · the host SERVES a plugin's bundles only while the plugin is active AND browser:script is granted
 *     (core/plugin-serving.ts browserCodeServable — read by routes/plugin-bundles.ts and by the static
 *     /plugins mount for dist/component.bundle.css), so revoking the switch stops the code at the next
 *     page load;
 *   · plugins that were already active with frontend entries when this shipped were granted it once,
 *     at boot (migrateBrowserCapabilityGrants), so an upgrade does not silently break a working site.
 */
const BROWSER_SCRIPT_TOKEN = 'browser:script';
// The compiled bundles build-plugin.js produces and routes/plugin-bundles.ts serves. Shipping one of
// these (even with no manifest entry that would build it) is shipping browser code.
const BROWSER_BUNDLE_FILES = ['dist/admin.bundle.js', 'dist/component.bundle.js', 'dist/hooks.bundle.js', 'dist/portal.bundle.js'];

function pascalCaseId(id: string): string {
    return String(id).split(/[-_]/).filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * What browser code does this plugin ship? Returns a list of human-readable sources (empty = none).
 *
 * Mirrors what build-plugin.js compiles — the manifest's frontend.adminPage.entry, frontend.hooks,
 * frontend.portalPage.entry (the public /portal/<slug> page, core/portal-pages.ts), the
 * block entry in either spelling (frontend.versoComponents / legacy frontend.puckComponents), the legacy
 * frontend.components[].entry channel, and the folder CONVENTION that compiles a block with no manifest
 * key at all (client/verso/<Pascal>Verso.tsx, legacy client/puck/<Pascal>Puck.tsx; see
 * scripts/plugin-block-contract.js) — plus any compiled bundle already present in dist/, because a zip
 * can ship a prebuilt bundle no manifest key accounts for. Over-reporting here costs a plugin author
 * one declaration; under-reporting would be code in the admin's origin nobody was asked about.
 */
function browserCodeSources(pluginDir: string | null, manifest: any): string[] {
    const out: string[] = [];
    const fe = manifest && typeof manifest.frontend === 'object' && manifest.frontend ? manifest.frontend : null;
    if (fe) {
        if (fe.adminPage && fe.adminPage.entry) out.push('frontend.adminPage');
        if (fe.hooks) out.push('frontend.hooks');
        if (fe.portalPage && fe.portalPage.entry) out.push('frontend.portalPage');
        if (fe.versoComponents && fe.versoComponents.entry) out.push('frontend.versoComponents');
        if (fe.puckComponents && fe.puckComponents.entry) out.push('frontend.puckComponents');
        if (Array.isArray(fe.components) && fe.components.some((c: any) => c && c.entry)) out.push('frontend.components');
    }
    if (pluginDir) {
        const id = String((manifest && manifest.id) || path.basename(String(pluginDir)));
        const pascal = pascalCaseId(id);
        for (const rel of [`client/verso/${pascal}Verso.tsx`, `client/puck/${pascal}Puck.tsx`, ...BROWSER_BUNDLE_FILES]) {
            try {
                if (fs.statSync(path.join(pluginDir, ...rel.split('/'))).isFile()) out.push(rel);
            } catch { /* absent */ }
        }
    }
    return out;
}

/** Does the manifest DECLARE browser:script? */
function declaresBrowserScript(manifest: any): boolean {
    const list = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
    return list.some((p: any) => p && p.scope === 'browser' && p.access === 'script');
}

/**
 * Install/activation/pack gate: a plugin that ships browser code must declare browser:script, so the
 * administrator is asked about it. Returns problems (empty = valid).
 */
function validateBrowserCapability(pluginDir: string | null, manifest: any): string[] {
    const sources = browserCodeSources(pluginDir, manifest);
    if (sources.length === 0 || declaresBrowserScript(manifest)) return [];
    return [
        `This plugin ships code that runs in the administrator's browser (${sources.join(', ')}) but does not declare the `
        + `"browser:script" permission. Add {"scope": "browser", "access": "script", "reason": "<what the UI does>"} to `
        + `manifest.json "permissions" — the administrator must approve running plugin code with their session.`,
    ];
}

/**
 * One-time upgrade step: grant browser:script to every plugin that was ALREADY ACTIVE and already
 * shipped browser code when this capability was introduced, so the upgrade does not silently remove the
 * admin pages, hooks and blocks of a working site. Plugins activated later go through the normal
 * default-deny path (declare → shown in the activation dialog → granted on activation).
 *
 * Idempotent twice over: it records completion and never runs again once that is recorded, and it only
 * ADDS the token (an existing grant is left alone, no other grant is touched). Must run AFTER
 * plugin-permissions.loadGrants()/backfillActive(). Returns the slugs it granted.
 *
 * DECIDED ON THE STORED RECORD, and only once the store has been read. Each grant is
 * plugin-permissions addUpgradeGrant: the plugin's record read fresh under the policy lease, the token
 * added to what is STORED (every other grant in it kept), written guarded on that read — this node's map
 * is never what gets written back. And while this boot has not read `plugin_grants` at all (the boot
 * load and the backfill's retry both failed), the step does nothing and records nothing, so it runs at
 * the next boot: the backfill skipped too, and a plugin given a record holding browser:script alone
 * would then never be given what its manifest declares (the backfill only fills a missing record).
 *
 * WHERE "DONE" IS RECORDED IS PART OF THE GUARANTEE. After the first run, every plugin with browser code
 * that lacks the token lacks it because an administrator decided so (a revoke, or a re-activation of a
 * record that had it revoked) — so a second run can only ever undo administrators' decisions. The
 * completion marker used to be its own option, `plugin_browser_capability_migrated`, which any plugin
 * holding settings:write could clear through the options bridge; the next boot then re-granted
 * browser:script to every active plugin that ships browser code, its own included. The marker is now a
 * host entry INSIDE the grant store (plugin-permissions setHostMarker), which only a writer that can
 * already rewrite every grant can reset. The old option still counts as "done" where it exists (an
 * install that ran the earlier version of this step), and its name stays protected from the bridge.
 *
 * "MARKER ABSENT" IS NOT "THIS SITE PREDATES THE CAPABILITY". A site installed through the setup wizard
 * never ran this step: the process that served the wizard booted in setup mode, which skips the boot
 * block, and the install happens in-process. So the first run came at the first restart after real use,
 * and it read every plugin the administrator had activated since — and whose browser:script they had
 * then revoked — as a pre-upgrade plugin, and granted it back. Two rules close that:
 *   · a site created by the installer records the step as done (recordFreshInstallBrowserCapability,
 *     called by routes/setup.ts), since none of its plugins can predate the capability;
 *   · whatever the marker says, the step never touches a plugin whose grants an administrator has
 *     decided (plugin-permissions ADMIN_DECISIONS_MARKER, read in the same row as the record: the
 *     activation dialog, the permissions screen), so a decision made under this version is never undone
 *     by it.
 */
const BROWSER_CAPABILITY_MIGRATION_OPTION = 'plugin_browser_capability_migrated';
const BROWSER_CAPABILITY_MIGRATION_MARKER = 'browserCapabilityMigrated';
async function migrateBrowserCapabilityGrants(): Promise<string[]> {
    const perms = require('./plugin-permissions');
    if (!perms.isGrantsLoaded()) {
        log.warn(`[PluginPermissions] The one-time "${BROWSER_SCRIPT_TOKEN}" upgrade did not run: plugin_grants could not be read. It runs at the next boot.`);
        return [];
    }
    if (await perms.getHostMarker(BROWSER_CAPABILITY_MIGRATION_MARKER)) return [];
    const legacyDone = await getOption(BROWSER_CAPABILITY_MIGRATION_OPTION, null);
    if (legacyDone) {
        await perms.setHostMarker(BROWSER_CAPABILITY_MIGRATION_MARKER, String(legacyDone));
        return [];
    }
    const active: string[] = await getActivePlugins();
    const granted: string[] = [];
    for (const plugin of scanPlugins()) {
        if (!active.includes(plugin.slug)) continue;
        let manifest: any = {};
        try { manifest = JSON.parse(fs.readFileSync(path.join(plugin.path, 'manifest.json'), 'utf8')); } catch { /* no/invalid manifest: dist/ files still count */ }
        if (browserCodeSources(plugin.path, manifest).length === 0) continue;
        // Added to the STORED record, unless it already holds the token or an administrator has decided
        // this plugin's grants under a version that knows browser:script (addUpgradeGrant decides both on
        // the row it reads under the lease).
        if (await perms.addUpgradeGrant(plugin.slug, BROWSER_SCRIPT_TOKEN)) granted.push(plugin.slug);
    }
    await perms.setHostMarker(BROWSER_CAPABILITY_MIGRATION_MARKER, new Date().toISOString());
    if (granted.length) {
        log.info(`[PluginPermissions] One-time upgrade: granted "${BROWSER_SCRIPT_TOKEN}" to already-active plugins that ship browser code: ${logSafe(granted.join(', '))}. Review it in Admin → Plugins → Permissions.`);
    }
    return granted;
}

/**
 * A site the installer just CREATED has no plugin that was active before browser:script existed, so the
 * one-time upgrade above has nothing to do on it — record it as done (see "MARKER ABSENT" above). Called
 * by routes/setup.ts once the database is initialized. A database that already has active plugins (the
 * installer pointed at an existing database) is left to the upgrade, which still never touches a plugin
 * an administrator has decided. Returns true when it recorded the step as done.
 */
async function recordFreshInstallBrowserCapability(): Promise<boolean> {
    const perms = require('./plugin-permissions');
    if (await perms.getHostMarker(BROWSER_CAPABILITY_MIGRATION_MARKER)) return false;
    // The active set as STORED in the database being installed, like the marker above — not
    // getActivePlugins(), which reads through the option cache. The wizard can run again in the same
    // process after a failed attempt (routes/setup.ts undoes it), against another database, and the cache
    // may still answer what that attempt read in the first one: "no active plugins", recorded here as done
    // on a database whose active plugins the upgrade was meant to keep working. A read error throws, and
    // the caller records nothing (the upgrade then runs at the next boot).
    const active: string[] = await require('./options').getOptionFresh('active_plugins', []);
    if (Array.isArray(active) && active.length > 0) return false;
    await perms.setHostMarker(BROWSER_CAPABILITY_MIGRATION_MARKER, `install:${new Date().toISOString()}`);
    return true;
}

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
        // hasOwnProperty, NOT `in`: `in` walks the prototype chain, so 'toString'/'valueOf'/'constructor'/
        // '__proto__' would pass as valid scopes (and KNOWN_PERMISSIONS['constructor'] is a function, whose
        // later `.includes` would throw). Only own keys are real permission scopes.
        if (!Object.prototype.hasOwnProperty.call(KNOWN_PERMISSIONS, p.scope)) {
            problems.push(`Unknown permission scope "${p.scope}" (valid: ${Object.keys(KNOWN_PERMISSIONS).join(', ')}).`);
            return;
        }
        const allowed = KNOWN_PERMISSIONS[p.scope];
        // The network permission may name the TCP ports the plugin connects to beyond DNS and the web
        // (the kernel sandbox refuses every other port): at most 16 integers 1-65535.
        if (p.scope === 'network' && p.ports !== undefined) {
            const ok = Array.isArray(p.ports) && p.ports.length <= 16 && p.ports.every((n: any) => Number.isInteger(n) && n >= 1 && n <= 65535);
            if (!ok) problems.push(`permissions[${i}].ports must be an array of at most 16 TCP port numbers (1-65535).`);
        }
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

/**
 * BOUNDS FOR THE SHIPPED-DEPENDENCY SCAN (node_modules/ inside an uploaded plugin).
 *
 * The scan runs at install, at activation and at boot for every active plugin, so it must have a ceiling
 * that does not depend on what the uploader put in the ZIP: a 60k-file dependency tree would otherwise
 * turn a boot into a multi-minute AST run, which is a denial of service dressed as a security feature.
 *
 * The bounds are therefore small, fixed, and — this is the part that keeps them honest — REPORTED. When
 * a bound is hit the caller emits a finding instead of a pass, so the ceiling can never quietly become a
 * way to hide code: a tree engineered to exceed it fails validation rather than skipping the check.
 *
 * 1 MB per file skips minified/bundled artifacts. Those are the files whose AST is both enormous and
 * least readable; a plugin that needs one can ship the unminified source next to it, or stop shipping
 * `node_modules/` altogether — leaving `"bundled"` unset — and declare the packages in the manifest's
 * `dependencies` so the host installs them from the registry instead. Note the direction: `"bundled":
 * true` (or an own `node_modules/`) tells the host to SKIP that shared install because the plugin is
 * already self-contained, so it is the opposite of asking the host to install anything.
 */
const DEP_SCAN_MAX_FILES = 4000;
const DEP_SCAN_MAX_FILE_BYTES = 1024 * 1024;
const DEP_SCAN_MAX_DEPTH = 32;

/**
 * Test-only narrowing of the bounds above. Every field is CLAMPED to the production ceiling
 * (`Math.min`), so this can only ever make the scan stricter — a caller cannot use it to raise a bound
 * and scan less carefully than production does. It exists so the "tree too large" branch is testable
 * without writing 4000 files to disk.
 */
type DependencyScanLimits = { maxFiles?: number; maxFileBytes?: number; maxDepth?: number };

type ShippedDependencyScan = {
    /** Does the plugin ship a node_modules/ directory at all? */
    present: boolean;
    /** Files to scan (.js/.cjs/.mjs), already proven to live inside the plugin directory. */
    files: string[];
    /** True when the file cap stopped the walk — the tree is bigger than what was read. */
    capHit: boolean;
    depthCut: number;
    skippedTooLarge: number;
    skippedEscaping: number;
    unreadable: number;
    maxFiles: number;
    maxFileBytes: number;
    maxDepth: number;
};

/**
 * Walk a plugin's SHIPPED node_modules/ depth-first and return the JavaScript files to scan, together
 * with a truthful account of everything the walk did NOT read.
 *
 * Containment is proved with realpath, per entry, before the entry is used: a `node_modules/x` symlink
 * pointing at `../../../../etc` (or at another plugin's directory, or at the host's own source) must not
 * pull host code into the plugin's report — and, more importantly, must not let an attacker aim the
 * scanner at a path it should not read. Anything resolving outside the plugin directory is skipped AND
 * counted, so it surfaces as a finding rather than as silence. Directory realpaths are memoised so a
 * symlink loop inside the plugin cannot spin the walk forever.
 */
function collectShippedDependencyFiles(pluginPath: string, limits: DependencyScanLimits = {}): ShippedDependencyScan {
    const clamp = (given: any, ceiling: number) =>
        (typeof given === 'number' && Number.isFinite(given) && given > 0) ? Math.min(given, ceiling) : ceiling;
    const maxFiles = clamp(limits.maxFiles, DEP_SCAN_MAX_FILES);
    const maxFileBytes = clamp(limits.maxFileBytes, DEP_SCAN_MAX_FILE_BYTES);
    const maxDepth = clamp(limits.maxDepth, DEP_SCAN_MAX_DEPTH);

    const result: ShippedDependencyScan = {
        present: false, files: [], capHit: false, depthCut: 0,
        skippedTooLarge: 0, skippedEscaping: 0, unreadable: 0,
        maxFiles, maxFileBytes, maxDepth,
    };

    const root = path.join(pluginPath, 'node_modules');
    try {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return result;
    } catch {
        return result;                                    // unreadable/absent → nothing shipped
    }
    result.present = true;

    let pluginReal: string;
    try {
        pluginReal = fs.realpathSync(pluginPath);
    } catch {
        // We cannot establish the containment baseline, so we cannot prove ANY path is inside the
        // plugin. Report the whole tree as unread rather than scanning paths we cannot vouch for.
        result.unreadable++;
        return result;
    }
    // path.relative is case-insensitive on win32, which is what the filesystem is there.
    const isInsidePlugin = (p: string) => {
        const rel = path.relative(pluginReal, p);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const seenDirs = new Set<string>();
    const walkDir = (dir: string, depth: number) => {
        if (result.files.length >= maxFiles) { result.capHit = true; return; }
        if (depth > maxDepth) { result.depthCut++; return; }
        let entries: any[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            result.unreadable++;                          // permissions, a broken junction, a race
            return;
        }
        for (const entry of entries) {
            if (result.files.length >= maxFiles) { result.capHit = true; return; }
            const full = path.join(dir, entry.name);
            let real: string;
            try {
                real = fs.realpathSync(full);             // resolves EVERY symlink on the way
            } catch {
                result.unreadable++;                      // dangling symlink, vanished entry
                continue;
            }
            if (!isInsidePlugin(real)) { result.skippedEscaping++; continue; }
            let stat: any;
            try {
                stat = fs.statSync(real);
            } catch {
                result.unreadable++;
                continue;
            }
            if (stat.isDirectory()) {
                if (seenDirs.has(real)) continue;         // symlink loop / already walked
                seenDirs.add(real);
                walkDir(full, depth + 1);                 // recurse on the LOGICAL path (readable labels)
                continue;
            }
            if (!stat.isFile()) continue;                 // sockets, fifos, devices: not code we can parse
            if (!/\.(js|cjs|mjs)$/i.test(entry.name)) continue;
            if (stat.size > maxFileBytes) { result.skippedTooLarge++; continue; }
            result.files.push(full);
        }
    };
    walkDir(root, 0);
    return result;
}

function validatePluginPermissions(
    slug: string,
    pluginPath: string,
    manifest: any,
    options: { mode?: PermissionScanMode; dependencyScanLimits?: DependencyScanLimits } = {},
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
        // `network` is SCOPE-ONLY: its grant token is the bare literal `network`, never `network:<access>`,
        // and every real manifest declares it as `{"scope":"network"}` with no access at all — so it must
        // match on scope alone, exactly as isGrantedByAdmin below already routes it to isNetworkGranted.
        // Requiring an access here made a plugin that DID declare network read as undeclared, so the
        // net/dns gate reported "missing Network access" against a manifest that had asked for it.
        if (scope === 'network') return permissions.some((p: any) => p && p.scope === 'network');
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
    // The `process` properties that hand out a NATIVE binding — C++ land, below every JS-level guard the
    // sandbox installs. These are the subset the shipped-dependency pass keeps of the (much broader)
    // process gate applied to a plugin's own code; see that gate for why the rest is dropped there.
    const NATIVE_BINDING_PROCESS_PROPS = new Set(['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule']);
    // THEMES ARE SCANNED HARDER THAN PLUGINS — but no longer for the reason this comment used to give.
    //
    // It used to read: "THEMES run functions.js IN-PROCESS on the host, where there is NO ESM import()
    // resolve hook (unlike the isolated worker), so a theme's import() of anything loads UNSCANNED module
    // code = host RCE". That was true until 2026-07-18 and is now FALSE: theme-engine.ts loads
    // functions.js through `loadIsolatedPlugin('theme:<slug>', …)` — the same fork, the same OS
    // confinement and the same worker, which installs the ESM import() guard and dies if it cannot
    // (plugin-worker.js: "sandbox ESM import() guard unavailable — Node >= 18.19 is required").
    //
    // Leaving that wrong was the actual risk. It named this static scan as the ONLY control standing
    // between a theme and host RCE, so a reader deciding what is safe to relax would have relaxed the
    // wrong one — and a reader trusting it would not have looked for the runtime hook at all. A comment
    // about where a trust boundary sits is part of the boundary.
    //
    // The stricter theme scan stays, as defence in depth: it is the static half of the same guarantee the
    // worker enforces at runtime, and a theme is installed from a catalogue with a wider blast radius
    // than its file count suggests.
    const isThemeScan = /[\\/]themes[\\/]/.test(pluginPath);
    /**
     * The require()/import() module-literal gate, as a FACTORY over its two sinks.
     *
     * It is a factory only so the SHIPPED-DEPENDENCY pass (see scanShippedDependencies below) can run
     * this exact function against a different sink — one that prefixes every finding with the
     * `node_modules/<pkg>/…` path it came from — instead of a second copy of the rules drifting out of
     * step with this one. `isDependency` suppresses the two THEME-only specifier rules, which are about
     * a theme's own code importing OUT of the scanned tree; inside node_modules a bare specifier is how
     * packages require each other, and that tree is now scanned.
     */
    const makeFlagModuleLiteral = (
        dangerousCalls: { add: (v: string) => unknown },
        noteMissing: (label: string, scope: any, access: any) => void,
        isDependency: boolean,
    ) => (rawValue: any, kindLabel: string) => {
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
            if (!isDependency && isThemeScan && !/^\.\.?[\\/]/.test(spec) && spec !== '.' && spec !== '..') {
                dangerousCalls.add(`import('${spec.slice(0, 40)}') — non-relative import specifier is not permitted in a theme`);
                return;
            }
            // Even a RELATIVE theme import that points into node_modules (`./node_modules/pwn`) reaches an
            // unscanned tree — reject it (#7). node_modules is not part of a theme's scanned own-code.
            if (!isDependency && isThemeScan && /(^|[\\/])node_modules([\\/]|$)/i.test(spec)) {
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
        /**
         * A DEPENDENCY's networking builtins are charged as the NETWORK PERMISSION, not blocked outright.
         *
         * For a plugin's OWN code the hard block is the right answer: the author is told to use the host
         * bridge instead of opening sockets by hand, and they can change their code. A shipped dependency
         * is code they did not write — and `require('http')` inside it is not an escape at all: at runtime
         * secure-require classifies every module under `plugins/<slug>/` as plugin code and gates exactly
         * these modules on the admin's Network grant, per require, at the socket. Blocking them here would
         * make the static scan STRICTER THAN THE RUNTIME and refuse to install a network-granted plugin
         * that ships express or nodemailer, for a call the sandbox would have allowed.
         *
         * The population is read from secure-require's own NETWORK_MODULES so there is ONE list: if that
         * policy is ever narrowed, this follows it the same day. Unreadable ⇒ keep the strict verdict.
         */
        const isRuntimeNetworkModule = () => {
            try { return !!require('./secure-require').NETWORK_MODULES?.has(moduleName); }
            catch { return false; }   // fail CLOSED
        };
        if (moduleName === 'dns' || moduleName === 'net' || (isDependency && isRuntimeNetworkModule())) {
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
    // The own-source instance: the plugin's own files report into the plugin's own buckets, unprefixed.
    const flagModuleLiteral = makeFlagModuleLiteral(dangerousCalls as any, noteMissing, false);

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
                // The list lives in core/scan-exclusions.ts, because secure-require must refuse a
                // runtime require() from exactly the directories this walk skips. It used to be spelled
                // out in both places, and the two had drifted apart in two ways — see that file.
                const { isScannerSkippedDir } = require('./scan-exclusions');
                const skipDir = isScannerSkippedDir(file, isThemeScan);
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

    /**
     * SCAN ONE FILE. This is the body the plugin's own source has always been run through, lifted out of
     * its `for` loop UNCHANGED so that the shipped-dependency pass below can run the very same rules
     * instead of a second copy of them drifting away from this one (the whole reason node_modules went
     * unscanned for so long is that scanning it "properly" looked like writing a parallel detector).
     *
     * Everything the body reports through is a PARAMETER, so the caller decides where findings land:
     *  · own source  — the plugin's own `dangerousCalls` / `missingPermissions`, verbatim, unprefixed;
     *  · dependency  — a sink that prefixes each finding with `node_modules/<pkg>/…`, plus `dependency`
     *                  set, which narrows the gates that are pure noise inside third-party code (see
     *                  each `dependency` check below for the individual WHY). `dependency` is null for
     *                  own source, so every own-source verdict is bit-for-bit what it was before.
     */
    type DependencyScanCtx = { label: string; unscannable: (file: string, why: string) => void };
    const scanOneFile = (file: string, sinks: {
        dangerousCalls: { add: (v: string) => unknown };
        flagModuleLiteral: (rawValue: any, kindLabel: string) => void;
        noteFsCall: (methodName: string, how?: string) => void;
        noteMissing: (label: string, scope: any, access: any) => void;
        dependency: DependencyScanCtx | null;
    }) => {
        const { dangerousCalls, flagModuleLiteral, noteFsCall, noteMissing, dependency } = sinks;
        const content = fs.readFileSync(file, 'utf8');
        let ast;
        try {
            ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e) {
            // FAIL-CLOSED: a file that is actually loaded but cannot be parsed is treated as
            // a violation, so an attacker cannot hide a payload behind a deliberate parse-buster.
            log.warn({ file: logSafe(file) }, `[Security] Could not parse ${logSafe(file)} for AST analysis — treating as a violation (fail-closed).`);
            // A DEPENDENCY file that will not parse is still a violation, but it is reported through the
            // ONE aggregated "tree could not be scanned in full" finding rather than as N separate lines:
            // a package shipping a Flow-typed or otherwise exotic .js would otherwise bury the real hits.
            // Either way the plugin does not install — unscannable is a finding, not a pass.
            if (dependency) { dependency.unscannable(file, 'could not be parsed'); return; }
            dangerousCalls.add(`Unparseable source file (${path.basename(file)})`);
            return;
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

        // `const NAME = /re/` — the identifiers that PROVABLY hold a RegExp, for the `exec` exemption
        // below. Only `const` counts, and only a direct regex literal: a `const` binding cannot be
        // reassigned, so `NAME.exec(x)` is RegExp.prototype.exec and can never become a child_process
        // handle. `let`/`var`, destructuring and computed initialisers are deliberately not collected —
        // this must stay a proof, not a guess.
        const regexConstBindings = new Set<string>();
        walk.simple(ast, {
            VariableDeclaration(node: any) {
                if (node.kind !== 'const') return;
                for (const declarator of node.declarations || []) {
                    if (declarator.id && declarator.id.type === 'Identifier'
                        && declarator.init && declarator.init.type === 'Literal' && declarator.init.regex) {
                        regexConstBindings.add(declarator.id.name);
                    }
                }
            },
        });

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
                        } else if (!dependency) {
                            // Computed require() is an obfuscation signal in code someone wrote FOR this
                            // plugin. Inside node_modules it is how half of npm loads an optional peer
                            // (`require(name)`), so flagging it there would block every real tree and
                            // teach operators to ignore the whole finding class. secure-require resolves
                            // the runtime require by identity regardless of how the specifier was spelled.
                            dangerousCalls.add(`Dynamic require detected (obfuscation risk)`);
                        }
                    }
                }
                // 2. Member calls: fs.writeFile(), global.eval()
                else if (node.callee.type === 'MemberExpression') {
                    if (node.callee.property.type === 'Identifier') {
                        name = node.callee.property.name;
                    }

                    if (node.callee.computed && !dependency) {
                        // Same calibration as dynamic require(): `handlers[k]()` is ordinary dispatch in
                        // third-party code and would fire on nearly every package.
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
                // the scanner only sees the method name `exec`. Exempt the regex-LITERAL form, and the one
                // variable form that is equally PROVABLE: an identifier bound by `const NAME = /re/`, which
                // cannot be reassigned to a child_process handle.
                //
                // That second case is not hypothetical. Driving a sticky or global regex with
                // `ATTR_RE.exec(input)` in a loop is the standard way to tokenise, and it is what
                // mail-server's HTML sanitiser does — so this scanner, which runs on upload AND on
                // activation, refused to install a first-party plugin because its XSS sanitiser iterates a
                // regex. `let`/`var` and computed initialisers stay flagged: there the binding really could
                // hold something else by the time it is called.
                const isRegexLiteralExec = name === 'exec'
                    && node.callee.type === 'MemberExpression'
                    && node.callee.object
                    && ((node.callee.object.type === 'Literal' && !!node.callee.object.regex)
                        || (node.callee.object.type === 'Identifier' && regexConstBindings.has(node.callee.object.name)));

                // In a DEPENDENCY only the code-generation half of this list is kept. `exec`/`spawn`/`fork`
                // are matched on the bare METHOD NAME, and inside third-party code that name belongs to
                // someone else far more often than to child_process (`re.exec(s)` where `re` is a `let`,
                // `emitter.fork()`, a stream's `spawn`) — while the way a dependency actually REACHES
                // child_process, requiring or importing it, is caught by flagModuleLiteral above and does
                // not depend on this list at all. eval/Function have no such collision.
                const nameIsSink = ['eval', 'Function', 'exec', 'execSync', 'spawn', 'fork'].includes(name)
                    && (!dependency || name === 'eval' || name === 'Function');
                if (!isRegexLiteralExec && nameIsSink) {
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
                        // Allow process.env (handled by runtime proxy), block everything else.
                        // In a DEPENDENCY, narrow this to the NATIVE-BINDING escapes (process.binding,
                        // process._linkedBinding, process.dlopen, process.getBuiltinModule): every other
                        // property — process.platform, process.cwd(), process.version, process.nextTick —
                        // appears in almost every npm package and is already virtualised by the sandbox's
                        // process proxy, so charging it here would block every tree without adding a
                        // single bit of signal. The escapes above are the ones that reach C++ directly.
                        if (node.property.name !== 'env'
                            && (!dependency || NATIVE_BINDING_PROCESS_PROPS.has(node.property.name))) {
                            dangerousCalls.add(`Forbidden 'process' property: ${node.property.name || 'computed'}`);
                        }
                    } else if (!isAssignment && !dependency) {
                        // `global.x` / `module.parent` / `require.resolve` reads are routine in packages.
                        dangerousCalls.add(`Direct '${node.object.name}' access (restricted)`);
                    }
                }

                // Detect dynamic property access: obj["perm" + "ission"] on ANY object
                if (node.computed && node.property.type !== 'Literal' && node.property.type !== 'NumberLiteral') {
                    // Only flag if it's a sensitive base or looks suspicious
                    const base = node.object.type === 'Identifier' ? node.object.name : '';
                    if (sensitiveGlobals.includes(base) && !dependency) {
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
                } else if (!dependency) {
                    // See dynamic require() above: a computed import() specifier is a signal in the
                    // plugin's own code and a lazy-loading idiom inside a package.
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
                // `const _global = global` / `var proc = process` are ordinary environment-shim lines in
                // packages, so in a DEPENDENCY only the two CODEGEN primitives keep their alias check —
                // aliasing eval/Function has no benign reading anywhere.
                const aliasNames = dependency ? ['eval', 'Function']
                    : ['process', 'global', 'globalThis', 'require', 'module', 'eval', 'Function'];
                if (node.init && node.init.type === 'Identifier' && aliasNames.includes(node.init.name)) {
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
    };

    // The plugin's OWN source: same files, same rules, same buckets as before this function existed.
    for (const file of files) {
        scanOneFile(file, { dangerousCalls: dangerousCalls as any, flagModuleLiteral, noteFsCall, noteMissing, dependency: null });
    }

    // === THE SHIPPED DEPENDENCY TREE (node_modules/) — BOUNDED, AND UNSCANNABLE MEANS BLOCKED ========
    //
    // Marketplace plugins ship no node_modules (the host installs their declared dependencies), but an
    // UPLOADED plugin may ship a whole tree — and until now the scanner walked straight past it, so
    // `node_modules/left-pad/index.js` was the cheapest place in a package to park a
    // `require('child_process')` that the operator's install-time review would never see. That gap was
    // named in documentation/security.md §4 and in core/scan-exclusions.ts; this is it being closed.
    //
    // What this is NOT: a supply-chain audit. It is the same install-time smell test the plugin's own
    // code gets, applied to the code it ships alongside it, with HARD BOUNDS so a package with a
    // 60k-file tree cannot turn an install (or a boot-time activation) into a minutes-long AST run:
    //   · at most DEP_SCAN_MAX_FILES files, · nothing larger than DEP_SCAN_MAX_FILE_BYTES (minified
    //   bundles), · .js/.cjs/.mjs only, · no symlink followed outside the plugin directory (realpath).
    // Hitting ANY of those bounds is itself reported as a finding: a dependency tree we could not read
    // in full is exactly the situation where "nothing was found" means nothing at all, so it fails
    // closed rather than passing quietly.
    //
    // Runtime containment (secure-require, io-guard, the worker's ESM hook, blockCodeGen) remains the
    // control that actually STOPS a dependency — as it always was. This pass buys the operator a look.
    const deps = collectShippedDependencyFiles(pluginPath, options.dependencyScanLimits);
    if (deps.present) {
        const unscannable: string[] = [];
        for (const depFile of deps.files) {
            // The dependency-relative path is what makes a finding actionable ("which package?"), so it
            // prefixes every line this file produces. logSafe because the path comes from an uploaded ZIP.
            const label = logSafe(path.relative(pluginPath, depFile).split(path.sep).join('/'));
            const depSink = { add: (v: string) => dangerousCalls.add(`${label}: ${v}`) };
            const noteUnscannable = (_f: string, why: string) => { unscannable.push(`${label} (${why})`); };
            try {
                scanOneFile(depFile, {
                    dangerousCalls: depSink,
                    // A dependency's require('net')/require('dns') is a REAL capability the plugin will
                    // exercise at runtime — the network gate charges the plugin either way — so it stays a
                    // missing-permission (fixable in manifest.json), not a hard block.
                    flagModuleLiteral: makeFlagModuleLiteral(depSink, (l, s, a) => noteMissing(`${label}: ${l}`, s, a), true),
                    // Filesystem and host-API charges are deliberately NOT collected from dependencies.
                    // io-guard gates every fs call against the PLUGIN's grants at the call itself, so
                    // nothing is un-gated by staying silent here; whereas charging statically would make
                    // essentially every dependency demand filesystem:read and bury the real findings. The
                    // host-API gate matches on a bare NAME (`getOption`), which inside a third-party
                    // package is a name collision, not a call into WordJS.
                    noteFsCall: () => { /* see above */ },
                    noteMissing: () => { /* see above */ },
                    dependency: { label, unscannable: noteUnscannable },
                });
            } catch (e: any) {
                // A crash in the scan of a dependency file must not read as "clean" (fail closed).
                unscannable.push(`${label} (scan failed: ${logSafe(e && e.message)})`);
            }
        }

        const reasons: string[] = [];
        if (deps.capHit) reasons.push(`the tree holds more than ${deps.maxFiles} scannable files`);
        if (deps.depthCut > 0) reasons.push(`${deps.depthCut} director${deps.depthCut === 1 ? 'y' : 'ies'} nested deeper than ${deps.maxDepth} levels`);
        if (deps.skippedTooLarge > 0) reasons.push(`${deps.skippedTooLarge} file(s) larger than ${deps.maxFileBytes} bytes (likely minified bundles)`);
        if (deps.skippedEscaping > 0) reasons.push(`${deps.skippedEscaping} path(s) resolving OUTSIDE the plugin directory via symlink`);
        if (deps.unreadable > 0) reasons.push(`${deps.unreadable} unreadable director${deps.unreadable === 1 ? 'y' : 'ies'}`);
        if (unscannable.length > 0) reasons.push(`${unscannable.length} file(s) could not be scanned: ${unscannable.slice(0, 5).join(', ')}`);
        if (reasons.length > 0) {
            dangerousCalls.add(`node_modules/: the shipped dependency tree could not be scanned in full — ${reasons.join('; ')} (${deps.files.length} file(s) were scanned). An unscannable dependency tree is a finding, not a pass: ship fewer/smaller dependencies, or stop shipping node_modules/ (and leave "bundled" unset) and declare the packages in manifest.json's "dependencies" so the host installs them from the registry.`);
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
    roles: any;
    /** The manifest's raw `accountCapabilities` block (core/account-capabilities.ts validates it on read). */
    accountCapabilities: any;

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
        // The roles the manifest DECLARES (shown on the grant screens next to `roles:declare`). Display
        // data only: registration re-reads and re-validates the manifest (core/roles.registerPluginRoles).
        this.roles = Array.isArray(data.roles) ? data.roles : [];
        // The per-account capabilities it declares — display data too (core/account-capabilities.ts reads them).
        this.accountCapabilities = Array.isArray(data.accountCapabilities) ? data.accountCapabilities : [];
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
/**
 * Every installed plugin, read from the install tree. Host bookkeeping: it is reached while the host
 * serves a plugin's bridged call (account capabilities resolve the user a plugin asks about, menus, portal
 * pages), and under that plugin's context io-guard judged the readdir of plugins/ as the PLUGIN reading
 * outside its zones — refused, logged on every queue pass (X4-15), and the caller got an empty install.
 * Never hands plugin-controlled paths to the guard bypass: the directory is the host's constant.
 */
const reservedSlugsLogged = new Set<string>();
function scanPlugins(): Plugin[] {
    return require('./plugin-context').runAsHost(() => scanPluginsImpl());
}
function scanPluginsImpl(): Plugin[] {
    ensurePluginsDir();
    const plugins: Plugin[] = [];

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // A directory whose name is a host-reserved slug (`core`, `theme-*`, `@*` — core/plugin-slug-policy)
        // is never listed, so it can never be activated or loaded: the installer refuses such a slug, and
        // a directory that reached plugins/ some other way is refused here, once per name in the log.
        const reserved = require('./plugin-slug-policy').reservedPluginSlugReason(entry.name);
        if (reserved) {
            if (!reservedSlugsLogged.has(entry.name)) {
                reservedSlugsLogged.add(entry.name);
                log.warn(`[Plugins] Not loading plugins/${logSafe(entry.name)}: ${logSafe(reserved)}. Rename the directory to load it.`);
            }
            continue;
        }

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
                    permissions: manifest.permissions || [],
                    roles: Array.isArray(manifest.roles) ? manifest.roles : [],
                    accountCapabilities: Array.isArray(manifest.accountCapabilities) ? manifest.accountCapabilities : []
                };
                // We don't load init/deactivate here to avoid requiring the file before deps match
            } catch (e) {
                log.error({ err: e }, `Error parsing manifest for ${logSafe(entry.name)}`);
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
            roles: metadata.roles || [],
            accountCapabilities: metadata.accountCapabilities || [],
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

// ── ORPHANED PLUGINS ──────────────────────────────────────────────────────────────────────────────
/**
 * THE ONE DEFINITION OF "ORPHANED", because three surfaces used to hold three different ones.
 *
 * `plugins/<slug>/` can be left holding only build output — a `dist/` with no manifest.json and no
 * entry file — while the `active_plugins` option still names <slug>. The product then contradicted
 * itself three ways, and each surface's answer was locally reasonable:
 *
 *   · scanPlugins() skips a directory with neither a manifest nor a main file, so getAllPlugins() —
 *     GET /plugins and the marketplace catalog annotation — never listed it. The "Instalados" tab did
 *     not show it, and the catalog card offered Install.
 *   · every install guard asked isPluginActive(), which reads the OPTION alone, so the install was
 *     refused with 409 "currently active. Deactivate it before re-uploading" — about something the
 *     administrator could not see, let alone deactivate. A dead end with no way out of it.
 *   · the boot loop `for (const slug of activePlugins)` merely `continue`d on a slug it could not
 *     resolve, so the contradiction survived every restart, forever, and the dev registry generators
 *     went on printing "No manifest: <slug>".
 *
 * A slug is ORPHANED when it is CLAIMED — listed in `active_plugins`, or present as a directory — and
 * NOT loadable, i.e. not something scanPlugins() would return. "Loadable" is deliberately expressed
 * as "scanPlugins listed it" rather than re-derived from the same files: a second copy of that rule
 * is a second thing to drift, which is the shape of the bug this exists to end.
 *
 * ONE STATE IS DELIBERATELY NOT AN ORPHAN: a directory whose only entry is `data/`. Uninstall leaves
 * that on purpose (routes/plugins removePluginDirPreservingData — encryption keys, attachments) and
 * installPluginFromZip ADOPTS it on reinstall. It is the intended residue of a plugin that WAS
 * uninstalled, so reporting it would put a red "broken install" card in the admin after every
 * successful uninstall. It becomes an orphan the moment `active_plugins` names it, because only then
 * is it a contradiction.
 */
type OrphanedPlugin = {
    slug: string;
    /** Listed in `active_plugins` — the half that made install and deactivate misbehave. */
    active: boolean;
    /** `plugins/<slug>/` exists on this node. */
    hasDirectory: boolean;
    /**
     * The directory holds NO manifest.json and NO entry file, so removing it destroys no plugin code.
     * FALSE for a directory whose manifest is merely unreadable: that is a BROKEN plugin, not a
     * residue, and its files are someone's work — nothing may delete it on the orphan path.
     */
    residual: boolean;
    reason: 'missing' | 'no-manifest' | 'unreadable-manifest';
};

/**
 * Notice id convention, matching 'db.sqlite-legacy-fallback' and 'sandbox.cgroup-no-cpu-quota':
 * `<area>.<condition>`, with the slug appended because this condition is per-plugin. Stable across
 * boots, so core/admin-notices upserts ONE row per slug however many times the site restarts.
 */
const ORPHAN_NOTICE_PREFIX = 'plugins.orphaned-active.';
const orphanNoticeId = (slug: string) => `${ORPHAN_NOTICE_PREFIX}${slug}`;

/** Why scanPlugins() would skip this directory — or null when it would list it. */
function pluginDirDefect(pluginDir: string): { reason: 'no-manifest' | 'unreadable-manifest'; residual: boolean } | null {
    const manifestPath = path.join(pluginDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try { JSON.parse(fs.readFileSync(manifestPath, 'utf8')); return null; }
        // scanPlugins `continue`s on an unparsable manifest, so this directory is not loadable — but
        // the plugin's CODE is still in it. Never residual, therefore never deletable from here.
        catch { return { reason: 'unreadable-manifest', residual: false }; }
    }
    if (findMainFile(pluginDir)) return null; // manifest-less legacy plugin: scanPlugins lists it
    return { reason: 'no-manifest', residual: true };
}

/** The `data/`-only residue an uninstall leaves on purpose (see the header above). */
function isPreservedDataResidue(pluginDir: string): boolean {
    try {
        const entries = fs.readdirSync(pluginDir);
        return entries.length > 0 && entries.every((e: string) => e === 'data');
    } catch { return false; } // unreadable → not something we get to call "intended"
}

/**
 * Every orphan on this node, given the active list.
 *
 * SYNCHRONOUS on purpose: the prune below decides INSIDE the `active_plugins` lock, on the very array
 * it is about to write, so a concurrent activation cannot be judged against a list read before it
 * landed. It also does NOT swallow a failure to read the plugins directory — scanPlugins throws there
 * — because a prune computed from an empty listing would drop EVERY active plugin. Fail closed.
 */
function orphansFrom(active: string[]): OrphanedPlugin[] {
    ensurePluginsDir();
    const loadable = new Set(scanPlugins().map((p: any) => p.slug));
    const activeSet = new Set((Array.isArray(active) ? active : []).map((s) => String(s)));
    const dirs = new Set<string>(
        fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
            .filter((e: any) => e.isDirectory())
            .map((e: any) => e.name as string)
    );

    const out: OrphanedPlugin[] = [];
    for (const slug of new Set<string>([...activeSet, ...dirs])) {
        if (loadable.has(slug)) continue;
        if (!dirs.has(slug)) {
            out.push({ slug, active: activeSet.has(slug), hasDirectory: false, residual: false, reason: 'missing' });
            continue;
        }
        const dir = path.join(PLUGINS_DIR, slug);
        if (isPreservedDataResidue(dir) && !activeSet.has(slug)) continue; // intended, not a fault
        const defect = pluginDirDefect(dir);
        if (!defect) continue; // loadable after all (the tree changed under scanPlugins) — nothing to report
        out.push({ slug, active: activeSet.has(slug), hasDirectory: true, residual: defect.residual, reason: defect.reason });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The orphans as the routes see them (reads `active_plugins` itself). */
async function listOrphanedPlugins(): Promise<OrphanedPlugin[]> {
    return orphansFrom(await getActivePlugins());
}

/**
 * BOOT RECONCILIATION: drop every `active_plugins` entry whose files are not loadable, and TELL the
 * administrator.
 *
 * The write goes through withActivePluginsLock — the same atomic read-modify-write activate,
 * deactivate and CrashGuard use — and the orphan set is computed inside the mutator, so nothing is
 * dropped on the strength of a stale read. A healthy site writes NOTHING (the mutator returns
 * undefined), so this costs one option read per boot.
 *
 * The notice is what makes the fix visible: a `console.warn` on a boot nobody watched is exactly how
 * this state stayed invisible in the first place. Best-effort — losing a notice is acceptable,
 * wedging boot is not.
 */
async function pruneOrphanedActivePlugins(): Promise<OrphanedPlugin[]> {
    const pruned: OrphanedPlugin[] = [];
    await withActivePluginsLock((active) => {
        const orphans = orphansFrom(active).filter((o) => o.active);
        if (!orphans.length) return undefined; // healthy: no write at all
        pruned.push(...orphans);
        const drop = new Set(orphans.map((o) => o.slug));
        return active.filter((s) => !drop.has(s));
    });

    for (const o of pruned) {
        log.warn({ slug: logSafe(o.slug), reason: logSafe(o.reason) }, `[plugins] '${logSafe(o.slug)}' was listed active but is not loadable (${logSafe(o.reason)}) — removed from active_plugins.`);
        try {
            await require('./admin-notices').pushAdminNotice({
                id: orphanNoticeId(o.slug),
                level: 'warning',
                message: `Plugin ${o.slug} was marked active but its files are missing; it has been removed from the active list — reinstall it from the Marketplace`,
                since: Date.now(),
            });
        } catch (e: any) {
            log.warn({ slug: logSafe(o.slug), err: e }, `[plugins] the orphan notice for '${logSafe(o.slug)}' could not be raised`);
        }
    }
    return pruned;
}

/** Retire ONE slug's orphan notice — the administrator has dealt with it. Never throws. */
async function clearOrphanNotice(slug: string): Promise<boolean> {
    try { return await require('./admin-notices').clearAdminNotice(orphanNoticeId(slug)); }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugins] the orphan notice for '${logSafe(slug)}' could not be retired`); return false; }
}

/**
 * Retire the orphan notice of every slug that is loadable again — the boot after a reinstall. Without
 * it the panel keeps demanding a fix that has already been made, and an operator who is contradicted
 * by the screen that told them to act learns to ignore that screen (see core/admin-notices).
 */
async function retireResolvedOrphanNotices(): Promise<string[]> {
    const retired: string[] = [];
    try {
        const stored = await getOption('admin_notices', []);
        if (!Array.isArray(stored) || !stored.length) return retired;
        const loadable = new Set(scanPlugins().map((p: any) => p.slug));
        for (const row of stored) {
            const id = row && typeof row.id === 'string' ? row.id : '';
            if (!id.startsWith(ORPHAN_NOTICE_PREFIX)) continue;
            const slug = id.slice(ORPHAN_NOTICE_PREFIX.length);
            if (!loadable.has(slug)) continue;
            if (await clearOrphanNotice(slug)) retired.push(slug);
        }
    } catch (e: any) {
        log.warn({ err: e }, '[plugins] resolved orphan notices could not be retired');
    }
    return retired;
}

/**
 * RECLAIM one orphaned slug for the install/cleanup paths: drop its stale `active_plugins` entry
 * (atomically, under the same lock as every other writer) and report what the caller still has to do
 * about the files on disk.
 *
 * Returns null when the slug is NOT an orphan — the caller must then go on treating it as a real,
 * possibly RUNNING plugin, which is what keeps the "refuse to overwrite a live plugin" guard intact.
 */
async function reclaimOrphanedPlugin(slug: string): Promise<(OrphanedPlugin & { droppedActiveEntry: boolean }) | null> {
    // Boxed so the assignment inside the mutator is not narrowed away by control-flow analysis.
    const box: { found: OrphanedPlugin | null; dropped: boolean } = { found: null, dropped: false };
    await withActivePluginsLock((active) => {
        box.found = orphansFrom(active).find((o) => o.slug === slug) || null;
        if (!box.found || !box.found.active) return undefined;
        box.dropped = true;
        return active.filter((s) => s !== slug);
    });
    const found = box.found;
    if (!found) return null;
    if (box.dropped) {
        log.warn({ slug: logSafe(slug), reason: logSafe(found.reason) }, `[plugins] '${logSafe(slug)}' was listed active with no loadable files (${logSafe(found.reason)}) — stale entry dropped so the slug can be reinstalled.`);
        // A pending supervised restart can still hold the slug even though nothing is registered
        // (see the DELETE handler's note); unloadIsolatedPlugin cancels it and is idempotent.
        try { unloadIsolatedPlugin(slug); } catch { /* nothing of ours is running for an orphan */ }
    }
    return { ...found, droppedActiveEntry: box.dropped };
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
        // FRESH and STRICT, not getActivePlugins(): that reads through the option cache, so a peer's
        // write whose invalidation broadcast this node missed came back as the OLD set and was written
        // back over the peer's change (re-activating a plugin the peer had just deactivated, or dropping
        // one it activated) — under the very lock meant to prevent lost updates. And getOption answers a
        // database error with the default `[]`, which the mutator then extended and wrote: every other
        // plugin deactivated cluster-wide by one failed read. A read error now fails the operation.
        const active = await require('./options').getOptionFresh('active_plugins', []);
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
// Slugs with an activation running on THIS node — queued, or between its child being spawned and the
// active set being written. reconcileDeactivatedPlugins() must not mistake that window for a lost
// deactivation. A count, not a flag: the same slug can be queued twice.
const activationsInFlight = new Map<string, number>();
async function activatePlugin(slug: string) {
    activationsInFlight.set(slug, (activationsInFlight.get(slug) || 0) + 1);
    const prev = _pluginActivationChain;
    let release!: () => void;
    _pluginActivationChain = new Promise<void>((r) => { release = r; });
    try {
        await prev.catch(() => { /* a prior failed activation must not block the next */ });
        return await _activatePluginUnlocked(slug);
    } finally {
        release();
        const n = (activationsInFlight.get(slug) || 1) - 1;
        if (n > 0) activationsInFlight.set(slug, n); else activationsInFlight.delete(slug);
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

    // Multisite: another site activates only what the network offers it.
    const secondary = onSecondarySite();
    if (secondary && !require('./plugin-permissions').isOfferedHere(slug)) throw notOfferedError(slug);

    // 1. Dependency Check & Auto-Install
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // 0. Static Permission Verification. GRANT mode: the admin has already seen the requested
            // permissions (install-time validation fed that screen), so from here a capability that was
            // declared but DENIED must block activation — otherwise the per-permission switch is inert.
            validatePluginPermissions(slug, plugin.path, manifest, { mode: 'grant' });

            // 0b. The roles block (core/plugin-roles.ts) — refused as a whole BEFORE anything is installed
            // or spawned, so an invalid block can never half-apply. The checks that need live state run
            // again at registration below.
            const roleProblems = validateManifestRoles(slug, manifest);
            if (roleProblems.length) throw new Error(`Invalid roles in manifest.json:\n- ${roleProblems.join('\n- ')}`);
            // 0b'. The account-capabilities block (core/account-capabilities.ts) — the same namespace rules,
            // against the plugins installed now. (Read time re-checks too, so a hand-edited block is inert.)
            const accountCapProblems = require('./account-capabilities').validateManifestAccountCapabilities(slug, manifest, listInstalledPluginIds());
            if (accountCapProblems.length) throw new Error(`Invalid accountCapabilities in manifest.json:\n- ${accountCapProblems.join('\n- ')}`);

            // 0c. Its admin page is its own: no other installed plugin answers to the same
            // /admin/plugin/<slug> (core/adminMenu.ts adminPageConflict) — checked again here because the
            // plugins installed since its upload count, and a folder copied by hand never went through it.
            const pageConflict = require('./adminMenu').adminPageConflict(slug, manifest);
            if (pageConflict) throw new Error(`Invalid admin page in manifest.json: ${pageConflict}`);
            // 0d. Likewise its portal page (/portal/<slug>, core/portal-pages.ts): a valid declaration that no
            // other installed plugin already claims.
            const portalConflict = require('./portal-pages').portalPageConflict(slug, manifest);
            if (portalConflict) throw new Error(`Invalid portal page in manifest.json: ${portalConflict}`);

            // 1a. Check if this is a bundled plugin
            const isBundled = isBundledPlugin(plugin.path, manifest);

            if (isBundled) {
                log.info({ slug: logSafe(slug) }, `📦 Plugin '${logSafe(slug)}' detected as bundled - no shared dependencies.`);
            } else if (secondary) {
                // Multisite: the shared node_modules is the network's — its dependencies were installed when
                // the network offered it (offerPluginToSites). A site never installs code.
            } else {
                // 1b. HARD LOCK: Check for dependency conflicts with active plugins
                const conflictResult = await checkDependencyConflicts(slug, manifest);

                if (!conflictResult.compatible) {
                    const errorMessage = formatDependencyConflictError(slug, conflictResult.conflicts);
                    log.error(errorMessage);
                    throw new Error(errorMessage);
                }

                // 1c. Install dependencies (only if not bundled and no conflicts)
                await installPluginDependencies(slug, manifest, plugin.path);
            }
        } catch (e) {
            // CRITICAL: Must throw to stop execution if security block or other failure occurs
            log.error({ slug: logSafe(slug), err: e }, `🛡️ Protection Active: Blocking ${logSafe(slug)} activation (see err)`);
            throw e;
        }
    }

    // 2. Run Plugin Tests (if present) — once per network: on another site the code is the one the
    // network already verified when it was installed and offered.
    const { verifyPluginTests } = require('./plugin-test-runner');
    try {
        const testResult = secondary ? { skipped: true } as any : await verifyPluginTests(slug);
        if (!testResult.skipped) {
            log.info(`   🧪 Tests verified: ${logSafe(testResult.passed)}/${logSafe(testResult.tests)} passed`);
        }
    } catch (testError) {
        log.error({ slug: logSafe(slug) }, `🧪 Test Failure: Plugin '${logSafe(slug)}' blocked due to failing tests.`);
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

        // The roles it declares are checked against the LIVE state (a slug already taken, another installed
        // plugin's namespace, a content type's capability) BEFORE its code runs: a refusal found only after
        // the spawn would leave whatever init() did (tables, cron, options) behind a failed activation.
        await checkPluginRoles(slug, manifest);

        // Provision the plugin's low-privilege DB role (Postgres) BEFORE the worker can issue a query, so
        // its SELECT/DML runs under a role GRANTed only its own wjp_<slug>_ tables — the database enforces
        // isolation below the SQL text-guard. No-op off Postgres; graceful if the pool user lacks CREATEROLE.
        try { await require('./plugin-db-isolation').provision(slug); } catch { /* best-effort — text-guard remains */ }

        await loadIsolatedPlugin(slug, mainFile);

        // Register the roles the manifest declares (when the administrator granted `roles:declare`). All
        // or nothing: a refusal tears the just-spawned isolate down again, so the plugin is not active
        // and no role was written — the activation did not half-apply.
        try {
            await syncPluginRoles(slug, manifest);
        } catch (roleErr: any) {
            try { unloadIsolatedPlugin(slug); } catch { /* already gone */ }
            throw roleErr;
        }

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
    // Multisite: never on another site (the shared node_modules is the network's), and not on the main
    // site while the network offers the plugin to the other sites — their workers still need it.
    const offered = siteContext.multisiteEnabled() && (() => { try { return require('./network').pluginCeiling(slug) !== null; } catch { return true; } })();
    if (opts.prune !== false && !onSecondarySite() && !offered) {
        const plugins = scanPlugins();
        const plugin = plugins.find(p => p.slug === slug);
        if (plugin) {
            const manifestPath = path.join(plugin.path, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    await prunePluginDependencies(slug, manifest);
                } catch (e) {
                    log.error({ slug: logSafe(slug), err: e }, `⚠️ Failed to process manifest for prune ${logSafe(slug)}`);
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
    if (!plugin) { log.warn({ slug: logSafe(slug) }, `[plugins] cross-node activate '${logSafe(slug)}': not present on this node`); return false; }
    const mainFile = findMainFile(plugin.path);
    if (!mainFile) { log.warn({ slug: logSafe(slug) }, `[plugins] cross-node activate '${logSafe(slug)}': no main file`); return false; }
    let manifest: any = null;
    const manifestPath = path.join(plugin.path, 'manifest.json');
    if (fs.existsSync(manifestPath)) { try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* */ } }
    if (!manifest || !manifest.isolated) return false;
    try {
        // Re-read the grant/egress policy FIRST. The activating node persists the plugin's grants before
        // it publishes 'activate', but this node only learns of them through its own re-read: the
        // 'option-changed' message that precedes this one is handled asynchronously (its DB read may not
        // have landed yet) or may have been lost outright. Validating and spawning against the map as it
        // happened to be refused the plugin here (every declared capability "not granted") or ran it
        // without its grants. loadGrants/loadEgressHosts are serialized, so this read is ordered after
        // any in flight, and a failed read keeps what this node already had.
        try {
            const perms = require('./plugin-permissions');
            await perms.loadGrants();
            await perms.loadEgressHosts();
        } catch { /* keep the maps this node already has */ }
        // Re-validate locally (code-poisoning guard). GRANT mode: grants are replicated through the same
        // `plugin_grants` option just re-read, so a capability the admin revoked on ANOTHER node must not
        // be authorized here just because the manifest still declares it.
        validatePluginPermissions(slug, plugin.path, manifest, { mode: 'grant' });
        await installPluginDependencies(slug, manifest, plugin.path); // shared node_modules; idempotent
        try { unloadIsolatedPlugin(slug); } catch { /* not loaded here yet */ }
        await loadIsolatedPlugin(slug, mainFile);
        fixMiddlewareOrder();
        log.info({ slug: logSafe(slug) }, `[plugins] '${logSafe(slug)}' loaded live (cross-node activation)`);
        return true;
    } catch (e: any) {
        log.error({ slug: logSafe(slug), err: e }, `[plugins] cross-node load of '${logSafe(slug)}' failed`);
        return false;
    }
}

/**
 * Unload ONE plugin live from THIS node (cross-node deactivation). Does NOT touch `active_plugins`.
 */
function unloadOnePlugin(slug: string) {
    try { unloadIsolatedPlugin(slug); log.info({ slug: logSafe(slug) }, `[plugins] '${logSafe(slug)}' unloaded live (cross-node deactivation)`); return true; }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[plugins] cross-node unload of '${logSafe(slug)}'`); return false; }
}

/**
 * Stop plugins that run on THIS node although the shared active set no longer lists them — a
 * deactivation (an admin's, a revoke that condemned the plugin, CrashGuard's) whose 'wordjs:plugin-changed'
 * broadcast this node never received. Pub/sub drops messages silently, and without this such a plugin
 * kept running here, with whatever it had been granted, until the node restarted. Called by the periodic
 * and on-reconnect re-sync in core/coherence.ts.
 *
 * Deliberately ONE-directional and conservative: it only ever STOPS a plugin, only one this node runs as a
 * plugin (theme isolates are not in the active set), never one with an activation in flight here (its
 * child is spawned before the active set is written), and only on the SECOND consecutive observation,
 * so a write landing between two reads is not acted on. An unreadable active set changes nothing. The
 * other direction (a lost 'activate') is an availability gap, not a containment one, and loading code
 * from a timer is not something to do quietly; it is left to the next activation or restart.
 */
const strayObservations = new Map<string, number>();
async function reconcileDeactivatedPlugins(): Promise<string[]> {
    let active: any;
    try { active = await require('./options').getOptionFresh('active_plugins', []); }
    catch { return []; }
    if (!Array.isArray(active)) return [];
    const { listIsolates } = require('./plugin-isolate');
    const stray = new Set<string>();
    for (const slug of listIsolates()) {
        if (String(slug).startsWith('theme:')) continue;
        if (active.includes(slug) || activationsInFlight.has(slug)) continue;
        stray.add(slug);
    }
    const stopped: string[] = [];
    for (const slug of [...strayObservations.keys()]) if (!stray.has(slug)) strayObservations.delete(slug);
    for (const slug of stray) {
        const seen = (strayObservations.get(slug) || 0) + 1;
        if (seen < 2) { strayObservations.set(slug, seen); continue; }
        strayObservations.delete(slug);
        log.warn({ slug: logSafe(slug) }, `[plugins] '${logSafe(slug)}' runs here but is no longer active in the shared active set (a lost deactivation) — stopping it`);
        if (unloadOnePlugin(slug)) stopped.push(slug);
    }
    return stopped;
}

/**
 * Load all active plugins
 */
async function loadActivePlugins() {
    // 0. RECONCILE THE STORED INTENTION WITH WHAT IS ON DISK, before anything reads the list.
    //
    // The loop at the bottom of this function used to `continue` past an active slug it could not
    // resolve, which left the contradiction in place for the next boot, and the next — while the
    // install path went on refusing "it is currently active" for a plugin no screen could show. The
    // prune drops those entries and raises a persistent admin notice per slug; the retirement pass is
    // its counterpart, clearing the notice of anything that is loadable again after a reinstall.
    // Guarded: a reconciliation that cannot run must not take the boot down with it.
    try {
        await pruneOrphanedActivePlugins();
        await retireResolvedOrphanNotices();
    } catch (e: any) {
        log.warn({ err: e }, '[plugins] orphaned-entry reconciliation skipped');
    }

    const activePlugins = await getActivePlugins();
    const plugins = scanPlugins();
    const secondary = onSecondarySite();
    // CrashGuard watches the BOOT of the process (the main site's plugins load during it); another site's
    // plugins load when that site is first prepared, long after, so they are not part of its strike count.
    const CrashGuard = secondary
        ? { checkPreviousCrash: () => null, startLoading: () => {}, finishLoading: () => {}, MAX_STRIKES: 0 }
        : require('./crash-guard');

    // 1. CRASH RECOVERY CHECK (with 3-Strike Rule)
    // Did we crash last time?
    const crashInfo = CrashGuard.checkPreviousCrash();

    if (crashInfo && crashInfo.shouldDisable) {
        const culpritSlug = crashInfo.slug;
        log.error(`🚨 CRASH DETECTED: Plugin '${logSafe(culpritSlug)}' has ${logSafe(crashInfo.strikes)} strikes.`);
        log.error(`🛡️  CrashGuard: Automatically disabling '${logSafe(culpritSlug)}' to prevent boot loop.`);

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
            log.error({ err: e }, '[CrashGuard] Failed to record admin notice');
        }

        // Update local list for THIS run
        const index = activePlugins.indexOf(culpritSlug);
        if (index > -1) activePlugins.splice(index, 1);
    } else if (crashInfo && !crashInfo.shouldDisable) {
        // Crash detected but not at 3 strikes yet, just log and continue
        log.warn(`⚠️ [CrashGuard] Previous crash during '${logSafe(crashInfo.slug)}' load (Strike ${logSafe(crashInfo.strikes)}/${logSafe(CrashGuard.MAX_STRIKES)}). Retrying...`);
    }

    // 2. Load Plugins
    for (const slug of activePlugins) {
        const plugin = plugins.find(p => p.slug === slug);
        if (!plugin) continue;
        // Multisite: a plugin the network stopped offering stays listed (the site's choice is kept) but
        // does not run here until it is offered again.
        if (secondary && !require('./plugin-permissions').isOfferedHere(slug)) {
            log.warn(`   ⚠ Skipping '${logSafe(slug)}' on site ${siteContext.currentSiteId()}: not offered by the network.`);
            continue;
        }

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

                if (!secondary) await installPluginDependencies(slug, manifest, plugin.path);
            } catch (e) {
                log.error({ err: e }, `   ✗ Security Block for ${logSafe(slug)} on load`);
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
                log.info(`   ✓ Plugin loaded ISOLATED: ${logSafe(plugin.name)} (${logSafe(slug)})`);
                CrashGuard.finishLoading(slug);
                // Keep its declared roles in line with the manifest on disk (a plugin updated in place
                // between two boots). Best-effort: a refusal is logged and the roles stay as they were.
                try { await syncPluginRoles(slug, manifest); }
                catch (e: any) { log.error({ err: e }, `   ✗ Roles of ${logSafe(slug)} not refreshed`); }
                continue;
            }

            log.warn(`   ⚠ Skipping '${logSafe(slug)}': not isolated. Set "isolated": true to run it in the sandbox (legacy in-process loading was removed).`);
            CrashGuard.finishLoading(slug);
        } catch (error) {
            // If we caught the error (it didn't crash the process), we should still clear the lock
            CrashGuard.finishLoading(slug);

            log.error({ err: error }, `   ✗ Failed to load plugin ${logSafe(slug)}`);
        }
    }
}

/** The ids (folder names) of every installed plugin. */
function listInstalledPluginIds(): string[] {
    try { return scanPlugins().map((p) => p.slug); } catch { return []; }
}

// The installed ids, for a per-request caller (the isolate's req.user projection): scanning every manifest on
// each plugin route request would be wasteful, and the list only changes on install / delete. A short TTL
// bounds the staleness after one.
const INSTALLED_IDS_TTL_MS = 2000;
let installedIdsCache: { at: number; ids: string[] } | null = null;
function listInstalledPluginIdsCached(): string[] {
    const now = Date.now();
    if (installedIdsCache && now - installedIdsCache.at < INSTALLED_IDS_TTL_MS) return installedIdsCache.ids;
    const ids = listInstalledPluginIds();
    installedIdsCache = { at: now, ids };
    return ids;
}

/** Is a plugin with this id installed (its folder holds a manifest.json)? */
function isPluginInstalled(pluginId: string): boolean {
    if (typeof pluginId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(pluginId)) return false;
    return fs.existsSync(path.join(PLUGINS_DIR, pluginId, 'manifest.json'));
}

/**
 * Bring the roles plugin `slug` provides in line with its manifest (core/roles.registerPluginRoles):
 *
 *   · declares roles AND the administrator granted `roles:declare` → registered / refreshed (all or
 *     nothing; throws code PLUGIN_ROLES_REFUSED on any problem);
 *   · declares roles but the grant is missing → nothing is registered; roles registered earlier stay
 *     (inert — core/roles.ts confers their plugin capabilities only while the grant stands);
 *   · declares no roles → roles it registered earlier are retired.
 *
 * Then every stored plugin role is re-checked against the installed plugins (nested namespaces).
 */
async function syncPluginRoles(slug: string, manifest: any) {
    return applyPluginRoles(slug, manifest, false);
}

/**
 * syncPluginRoles without writing anything: every check registration would run, throwing the same
 * PLUGIN_ROLES_REFUSED error. Activation calls it before the plugin's code is spawned.
 */
async function checkPluginRoles(slug: string, manifest: any) {
    return applyPluginRoles(slug, manifest, true);
}

async function applyPluginRoles(slug: string, manifest: any, dryRun: boolean) {
    const roles = require('./roles');
    const { declaresRoles, ROLES_PERMISSION } = require('./plugin-roles');
    const { isGranted } = require('./plugin-permissions');
    const installed = listInstalledPluginIds();
    let result = { registered: [] as string[], removed: [] as string[], orphaned: [] as string[], skipped: false };
    if (declaresRoles(manifest) && !isGranted(slug, ROLES_PERMISSION.scope, ROLES_PERMISSION.access)) {
        if (!dryRun) log.warn({ slug: logSafe(slug) }, `[plugins] '${logSafe(slug)}' declares roles but roles:declare is not granted — no role registered.`);
        result.skipped = true;
    } else {
        result = { ...(await roles.registerPluginRoles(slug, manifest, { installedPluginIds: installed, dryRun })), skipped: false };
        if (dryRun) return result;
        if (result.registered.length) log.info({ slug: logSafe(slug) }, `[plugins] '${logSafe(slug)}' roles registered: ${logSafe(result.registered.join(', '))}`);
    }
    if (dryRun) return result;
    await roles.enforcePluginRoleNamespaces(installed);
    return result;
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
 * Create the sample plugin (POST /plugins/sample) when backend/plugins/hello-world/ is missing.
 *
 * It used to write an in-process plugin that require()d core's hooks and filtered `the_content` — no
 * manifest (so not a plugin the list could show), a require the sandbox refuses, and a hook core never
 * applies. It now writes the isolated example kept in documentation/examples/plugins/hello-world/ (the core
 * ships no plugin): a [hello] shortcode through the bridge, no permissions.
 */
function createSamplePlugin() {
    const sampleDir = path.join(PLUGINS_DIR, 'hello-world');

    if (fs.existsSync(sampleDir)) return;

    fs.mkdirSync(sampleDir, { recursive: true });

    const manifest = {
        name: 'Hello World',
        version: '1.1.0',
        description: 'A sample plugin that adds a [hello] shortcode',
        author: 'WordJS',
        isolated: true,
        permissions: [],
    };
    const sampleCode = [
        '/**',
        ' * Hello World Plugin for WordJS: put [hello] or [hello name="Ada"] in a post or page.',
        ' * Isolated: it reaches core only through the injected `wordjs` bridge. Shortcodes need no permission.',
        ' */',
        '',
        'exports.metadata = {',
        "    name: 'Hello World',",
        "    version: '1.1.0',",
        "    description: 'A sample plugin that adds a [hello] shortcode',",
        "    author: 'WordJS'",
        '};',
        '',
        "const escapeHtml = (s) => String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));",
        '',
        'exports.renderHello = function (attrs) {',
        "    const name = attrs && typeof attrs.name === 'string' && attrs.name.trim() ? attrs.name.trim().slice(0, 80) : 'world';",
        "    return '<p class=\"hello-world-greeting\">Hello, ' + escapeHtml(name) + '!</p>';",
        '};',
        '',
        'exports.init = function (wordjs) {',
        "    wordjs.shortcodes.add('hello', (attrs) => exports.renderHello(attrs));",
        '};',
        '',
        'exports.deactivate = function () {};',
        '',
    ].join('\n');

    fs.writeFileSync(path.join(sampleDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');
    fs.writeFileSync(path.join(sampleDir, 'index.js'), sampleCode);
}

/**
 * Purge a plugin's persisted footprint on uninstall. Clears grants and the egress allowlist (security:
 * otherwise a re-uploaded slug silently inherits the old, possibly-revoked grants) + crash strikes. When
 * dropTables is set, also drops the plugin's OWN wjp_<slug>_* tables — the sandbox confines each
 * plugin to exactly that prefix, so dropping them is complete and can't touch core or another plugin.
 * Options are intentionally NOT auto-purged: the options bridge is a GLOBAL key space with no
 * per-plugin namespace, so a plugin's keys can't be identified safely (a plugin.uninstall hook is the
 * clean path for that). Best-effort: each step is guarded so one failure doesn't abort the rest.
 *
 * `keepGrants` is for an in-place UPDATE (routes/plugins runPluginUpdate), which keeps the plugin and so
 * keeps what an administrator decided for it: the stored grant record and egress allowlist are left as
 * they are. Clearing them and writing back a copy taken from this node's memory undid, on a node that had
 * not heard of it, a revoke or a narrowed allowlist another node had stored.
 */
// --- Multisite: plugins across the sites of a network ---------------------------------------------

/**
 * Load the active plugins of the site being prepared (core/network-sites initSiteRuntime): its grants and
 * egress policy first (they are that site's options), then one worker per active, offered plugin. Runs
 * inside that site's context. Never throws: a site whose plugins fail to load still serves its content.
 */
async function loadSitePlugins(): Promise<void> {
    try {
        const perms = require('./plugin-permissions');
        await perms.loadGrants();
        await perms.loadEgressHosts();
        await loadActivePlugins();
        fixMiddlewareOrder();
    } catch (e: any) {
        log.warn(`[plugins] site ${siteContext.currentSiteIdOrNull()}: plugins not loaded: ${logSafe(e && e.message)}`);
    }
}

/**
 * Stop `slug` on every site other than the main one and drop it from their active sets — the plugin is
 * leaving the network (deleted) or no longer offered. Each site's own record of the deactivation (its
 * `deactivated_plugin` hook, its active set) is written in that site's context. Grants are kept, so an
 * offer made again later restores each site's own decisions. Returns the site ids it was active on.
 */
async function deactivatePluginOnSecondarySites(slug: string): Promise<number[]> {
    const done: number[] = [];
    if (!siteContext.multisiteEnabled()) return done;
    await require('./network-sites').forEachSecondarySite(`deactivate ${slug}`, async (siteId: number) => {
        if (!(await isPluginActive(slug))) {
            // Not in the active set, but a worker may still run (activation in flight): stop it anyway.
            try { await unloadIsolatedPlugin(slug); } catch { /* not running */ }
            return;
        }
        await deactivatePlugin(slug, { prune: false });
        done.push(siteId);
    });
    // Suspended sites are skipped by forEachSecondarySite; stop any worker they still have.
    try {
        const iso = require('./plugin-isolate');
        for (const key of iso.listIsolateKeys()) {
            const { siteId, slug: s } = iso.splitIsolateKey(key);
            if (s === slug && siteId !== siteContext.PRIMARY_SITE_ID) { try { await iso.unloadIsolateKey(key); } catch { /* gone */ } }
        }
    } catch { /* isolate layer unavailable */ }
    return done;
}

/**
 * Network administrator: offer `slug` to the other sites with `tokens` as its grant ceiling (or change the
 * ceiling). Installs its dependencies into the shared node_modules once (the main site's job; sites never
 * install code), then respawns every running worker of it on the other sites, so a lowered ceiling takes
 * effect in the children too (the host gates already read it live). Runs as the main site.
 */
async function offerPluginToSites(slug: string, tokens: unknown): Promise<string[]> {
    const plugin = scanPlugins().find((p) => p.slug === slug);
    if (!plugin) { const e: any = new Error(`Plugin ${slug} not found`); e.code = 'plugin_not_found'; e.status = 404; throw e; }
    const manifestPath = path.join(plugin.path, 'manifest.json');
    let manifest: any = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* checked below */ }
    if (!manifest || !manifest.isolated) { const e: any = new Error(`Plugin ${slug} is not an isolated plugin`); e.code = 'plugin_not_isolated'; e.status = 400; throw e; }
    const stored = await require('./network').setPluginCeiling(slug, tokens);
    if (!isBundledPlugin(plugin.path, manifest)) {
        try { await installPluginDependencies(slug, manifest, plugin.path); }
        catch (e: any) { log.warn(`[plugins] '${logSafe(slug)}' offered, but its dependencies could not be installed: ${logSafe(e && e.message)}`); }
    }
    await respawnOnSecondarySites(slug);
    return stored;
}

/** Network administrator: stop offering `slug` to the other sites (deactivates it there). */
async function withdrawPluginFromSites(slug: string): Promise<{ withdrawn: boolean; deactivatedOn: number[] }> {
    const withdrawn = await require('./network').clearPluginCeiling(slug);
    const deactivatedOn = await deactivatePluginOnSecondarySites(slug);
    return { withdrawn, deactivatedOn };
}

/** Respawn every running worker of `slug` on the sites other than the main one (a policy change). */
async function respawnOnSecondarySites(slug: string): Promise<void> {
    if (!siteContext.multisiteEnabled()) return;
    const iso = require('./plugin-isolate');
    for (const key of iso.listIsolateKeys()) {
        const { siteId, slug: s } = iso.splitIsolateKey(key);
        if (s !== slug || siteId === siteContext.PRIMARY_SITE_ID) continue;
        try {
            await siteContext.runWithSite(siteId, async () => {
                await require('./plugin-permissions').loadGrants();
                await iso.reloadIsolatedPlugin(slug);
            });
        } catch (e: any) { log.warn(`[plugins] respawn of '${logSafe(slug)}' on site ${siteId} failed: ${logSafe(e && e.message)}`); }
    }
}

/**
 * Retire the AppContainer profile (and its SID's ACEs) of `slug`'s worker on every site other than the
 * main one. Windows only — the other platforms keep no persistent profile. Every site of the registry is
 * covered, suspended ones too (a suspended site's worker had a profile as well). Returns the site ids
 * whose profile was removed. Never throws.
 */
async function retireOnSecondarySites(slug: string): Promise<number[]> {
    const retired: number[] = [];
    // No platform check here: retireAppContainerPlugin is the no-op off Windows (one place decides it).
    if (!siteContext.multisiteEnabled()) return retired;
    let ids: number[];
    try { ids = require('./network').listSites().map((s: any) => Number(s.id)).filter((id: number) => id !== siteContext.PRIMARY_SITE_ID); }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] could not list the network's sites`); return retired; }
    const appRoot = path.resolve(__dirname, '..', '..');
    const win = require('./sandbox-windows');
    for (const id of ids) {
        try { if (await win.retireAppContainerPlugin(appRoot, slug, id)) retired.push(id); }
        catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] AppContainer cleanup on site ${id} failed`); }
    }
    return retired;
}

/**
 * Drop a plugin's tables whatever foreign keys link them (S4-14). The catalog lists tables in name order,
 * not dependency order, so dropping one by one hit a parent before its children: MySQL/MariaDB and Postgres
 * refused ("a foreign key constraint fails" / "other objects depend on it"), the first refusal ended the
 * loop, and the admin was told every table was gone. Each pass drops what it can; a table refused because a
 * sibling still references it goes on the next pass, once that sibling is gone. No foreign-key checks are
 * switched off and nothing CASCADEs, so a table OUTSIDE the plugin that references one of its tables keeps
 * that table in place — and the caller reports it instead of claiming success.
 */
async function dropTablesInDependencyOrder(names: string[], drop: (name: string) => Promise<any>): Promise<{ dropped: string[]; kept: string[]; lastError: any }> {
    const dropped: string[] = [];
    let pending = names.slice();
    let lastError: any = null;
    while (pending.length) {
        const next: string[] = [];
        for (const name of pending) {
            try { await drop(name); dropped.push(name); }
            catch (e: any) { lastError = e; next.push(name); }
        }
        if (next.length === pending.length) return { dropped, kept: next, lastError };
        pending = next;
    }
    return { dropped, kept: [], lastError };
}

/**
 * "Delete this plugin's data" covers everything the plugin left in the SITE, not only its tables (S4-21): the
 * options it created (core/plugin-owned-options), the per-account capabilities it declared (an account still
 * carrying `mail_server_mailbox` after the mail server is gone is a grant nobody can see or revoke), and its
 * private storage directories under data/, logs/ and os-tmp/ on every site. `accountCapabilities` are the
 * capability slugs its manifest declared, read by the caller BEFORE the plugin's files were removed.
 */
async function purgePluginSiteData(slug: string, accountCapabilities: string[], networkWide: boolean) {
    const out: { optionsRemoved: string[]; accountCapabilitiesRevoked: number; storageRemoved: string[] } = { optionsRemoved: [], accountCapabilitiesRevoked: 0, storageRemoved: [] };
    try { out.optionsRemoved = await require('./plugin-owned-options').purgePluginOptions(slug); }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] could not remove the plugin's options`); }

    const CAP_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
    for (const cap of accountCapabilities.filter((c) => CAP_RE.test(String(c)))) {
        try {
            const { dbAsync } = require('../config/database');
            const { metaKeyFor } = require('./account-capabilities');
            const key = metaKeyFor(cap);
            const rows = await dbAsync.all('SELECT user_id FROM user_meta WHERE meta_key = ?', [key]);
            if (!rows || !rows.length) continue;
            await dbAsync.run('DELETE FROM user_meta WHERE meta_key = ?', [key]);
            const cache = require('./cache');
            for (const r of rows) {
                await cache.del(`user:${r.user_id}`);
                // A node still on the previous release reads the legacy flag: answer it "not granted" too.
                try { await require('./legacy-account-flags').mirrorLegacyWrite(Number(r.user_id), cap, '0'); } catch { /* no legacy key for this capability */ }
            }
            out.accountCapabilitiesRevoked += rows.length;
        } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] could not revoke account capability '${logSafe(cap)}'`); }
    }
    try { require('./account-capabilities').invalidateDeclarations(); } catch { /* cache only */ }

    const appRoot = path.resolve(__dirname, '..', '..');
    const { privateStorageDirs } = require('./sandbox-paths');
    let siteIds = [siteContext.PRIMARY_SITE_ID];
    if (networkWide) {
        try { siteIds = siteIds.concat(require('./network').listSites().map((s: any) => Number(s.id)).filter((id: number) => id !== siteContext.PRIMARY_SITE_ID)); }
        catch { /* single site */ }
    }
    // The plugin's own data folder (what used to be its code dir's data/; core/plugin-own-data).
    try {
        const ownData = require('./sandbox-paths').ownDataDir(appRoot, slug);
        if (fs.existsSync(ownData)) {
            require('./plugin-context').runAsHost(() => fs.rmSync(ownData, { recursive: true, force: true }));
            out.storageRemoved.push(path.relative(appRoot, ownData));
        }
    } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] could not remove its data folder`); }
    for (const siteId of siteIds) {
        for (const dir of privateStorageDirs(appRoot, slug, siteId)) {
            try {
                if (!fs.existsSync(dir)) continue;
                require('./plugin-context').runAsHost(() => fs.rmSync(dir, { recursive: true, force: true }));
                out.storageRemoved.push(path.relative(appRoot, dir));
            } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] could not remove its storage directory`); }
        }
    }
    return out;
}

/**
 * The site ids a plugin's workers run on: the main site, plus every other site of the network when multisite
 * is enabled (suspended ones too). Never throws — a network that cannot be listed yields the main site alone.
 */
function pluginWorkerSiteIds(): number[] {
    const ids = [siteContext.PRIMARY_SITE_ID];
    if (!siteContext.multisiteEnabled()) return ids;
    try { ids.push(...require('./network').listSites().map((s: any) => Number(s.id)).filter((id: number) => id !== siteContext.PRIMARY_SITE_ID)); }
    catch (e: any) { log.warn({ err: e }, '[plugins] could not list the network\'s sites'); }
    return ids;
}

/**
 * The tables of the current site's database that carry `slug`'s prefix (wjp_<slug>_*). Used by the
 * uninstall that drops them and by the installer, which reports the ones a previous uninstall kept.
 * Throws when the database cannot be listed — callers decide whether that is fatal.
 */
async function listPluginTables(slug: string): Promise<string[]> {
    const { dbAsync, getDbType } = require('../config/database');
    const { isPostgres, isMySQL } = getDbType();
    // Mirror plugin-worker.js's tablePrefix normalization exactly.
    const prefix = ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
    const rows = isPostgres
        ? await dbAsync.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()")
        : isMySQL
            ? await dbAsync.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()")
            : await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table'");
    // Filter in JS by the exact plugin prefix (no LIKE params → no cross-driver escaping pitfalls).
    return (rows || []).map((r: any) => String(r.name)).filter((n: string) => n.toLowerCase().startsWith(prefix));
}

/**
 * `retireSandbox: false` — the in-place UPDATE (runPluginUpdate): the plugin stays, under the same slug and
 * so the same AppContainer profile and zones, and its next launch is granted exactly what retiring would
 * revoke. Skipping it is what keeps an update from walking node_modules twice on Windows (FALLOS 149); the
 * update re-grants the plugin's own folder instead (sandbox-windows refreshPluginDirGrants).
 */
async function uninstallPluginData(slug: string, { dropTables = false, keepGrants = false, networkWide = false, accountCapabilities = [], retireSandbox = true }: { dropTables?: boolean; keepGrants?: boolean; networkWide?: boolean; accountCapabilities?: string[]; retireSandbox?: boolean } = {}) {
    const result: { grantsRemoved: boolean; strikesCleared: boolean; tablesDropped: string[]; tablesKept?: string[]; appContainerRetired: boolean; appContainerRetiredSites: number[]; optionsRemoved?: string[]; accountCapabilitiesRevoked?: number; storageRemoved?: string[] } = { grantsRemoved: false, strikesCleared: false, tablesDropped: [], appContainerRetired: false, appContainerRetiredSites: [] };
    if (!keepGrants) {
        try { const { removeGrants } = require('./plugin-permissions'); await removeGrants(slug); result.grantsRemoved = true; }
        catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] removeGrants failed`); }
    }
    try { const { clearStrikes } = require('./crash-guard'); clearStrikes(slug); result.strikesCleared = true; }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] clearStrikes failed`); }
    try { await require('./plugin-assets').clearAssets(slug); } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] clearAssets failed`); }
    if (dropTables) {
        try {
            const { dbAsync } = require('../config/database');
            const mine = await listPluginTables(slug);
            const dropped = await dropTablesInDependencyOrder(mine, (name) => dbAsync.run(`DROP TABLE IF EXISTS "${String(name).replace(/"/g, '')}"`));
            result.tablesDropped.push(...dropped.dropped);
            if (dropped.kept.length) {
                result.tablesKept = dropped.kept;
                log.warn({ slug: logSafe(slug), err: dropped.lastError }, `[uninstall ${logSafe(slug)}] ${dropped.kept.length} table(s) could not be dropped`);
            }
        } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] table drop failed`); }
    }
    if (dropTables) Object.assign(result, await purgePluginSiteData(slug, accountCapabilities, networkWide));
    // Drop the plugin's DB role (Postgres) — AFTER its tables so DROP ROLE has no dependency errors. No-op else.
    try { await require('./plugin-db-isolation').deprovision(slug); }
    catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] db role drop failed`); }
    // The code goes (or is replaced): its fingerprint is taken again at the next install's first launch.
    try { require('./plugin-integrity').forgetPluginIntegrity(path.resolve(__dirname, '..', '..'), slug); } catch { /* recorded again at launch */ }
    if (process.platform === 'win32' && retireSandbox) {
        try {
            const appRoot = path.resolve(__dirname, '..', '..');
            result.appContainerRetired = await require('./sandbox-windows').retireAppContainerPlugin(appRoot, slug);
        } catch (e: any) { log.warn({ slug: logSafe(slug), err: e }, `[uninstall ${logSafe(slug)}] AppContainer ACL/profile cleanup failed`); }
    }
    // The plugin is leaving the NETWORK (deleted, not updated in place — an update keeps the other sites'
    // workers running on the new code): every other site's worker had its own profile, keyed s<id>:<slug>.
    if (networkWide) result.appContainerRetiredSites = await retireOnSecondarySites(slug);
    log.info({ slug: logSafe(slug), grantsRemoved: logSafe(result.grantsRemoved), strikesCleared: logSafe(result.strikesCleared) }, `[uninstall ${logSafe(slug)}] grants=${logSafe(result.grantsRemoved)} strikes=${logSafe(result.strikesCleared)} tablesDropped=${logSafe(result.tablesDropped.length)}`);
    return result;
}

module.exports = {
    dropTablesInDependencyOrder,
    purgePluginSiteData,
    selectPrunableDependencies,
    isLoadedByHost,
    loadSitePlugins, deactivatePluginOnSecondarySites, retireOnSecondarySites, offerPluginToSites, withdrawPluginFromSites, respawnOnSecondarySites, onSecondarySite,
    scanPlugins,
    getActivePlugins,
    isPluginActive,
    // The orphan reconciliation. getAllPlugins() deliberately keeps its contract (only loadable
    // plugins), so every consumer that filters it — /plugins/active, the registry generators, the
    // marketplace's `installed` flag — stays honest; the routes project these separately.
    listOrphanedPlugins,
    pruneOrphanedActivePlugins,
    retireResolvedOrphanNotices,
    reclaimOrphanedPlugin,
    clearOrphanNotice,
    ORPHAN_NOTICE_PREFIX,
    uninstallPluginData,
    listPluginTables,
    pluginWorkerSiteIds,
    activatePlugin,
    deactivatePlugin,
    loadActivePlugins,
    loadOnePlugin,
    unloadOnePlugin,
    reconcileDeactivatedPlugins,
    getAllPlugins,
    createSamplePlugin,
    validatePluginPermissions,
    // The residue pass' exemption tables — every weakening of the only fail-closed part of the scan.
    // Exported so a gate can enumerate them from the code instead of restating them in a test.
    RESIDUE_NOT_A_USE,
    RESIDUE_JUDGED_ELSEWHERE,
    validateManifestPermissions,
    validateManifestRoles,
    syncPluginRoles,
    listInstalledPluginIds,
    listInstalledPluginIdsCached,
    isPluginInstalled,
    KNOWN_PERMISSIONS,
    // Non-registry dependency specs (git/file/alias/URL) are refused — see dependencySpecProblem.
    validateManifestDependencies,
    installPluginDependencies,
    // browser:script — plugin code in the admin's browser is a declared, granted capability.
    BROWSER_SCRIPT_TOKEN,
    browserCodeSources,
    validateBrowserCapability,
    migrateBrowserCapabilityGrants,
    recordFreshInstallBrowserCapability,
    BROWSER_CAPABILITY_MIGRATION_OPTION,
    BROWSER_CAPABILITY_MIGRATION_MARKER,
    fixMiddlewareOrder,
    // Cross-node propagation primitive (multi-node): the permission/egress routes publish a
    // {action:'reload', slug} so every node refreshes its grant/egress maps and respawns the isolate.
    publishPluginChange,
    // Hard Lock + Bundling utilities
    isBundledPlugin,
    checkDependencyConflicts,
    BLOCKED_RUNTIME_DEPS,
    PLUGINS_DIR
};
