#!/usr/bin/env node
/**
 * WordJS Plugin Packer — one installable ZIP for ONE plugin, from any folder.
 *
 * The marketplace builder (build-marketplace.js) packs the catalog under marketplace/plugins and writes
 * its index; a plugin that is not in the catalog — a private or client plugin kept untracked in
 * backend/plugins, or in a repository of its own — had no equivalent, and the documented path was
 * "compress the folder by hand". This does what that step needs, the same way the catalog does it:
 *
 *   1. checks the manifest the installer will check (valid JSON, id == folder, a name, "isolated": true);
 *   2. compiles the frontend entries with build-plugin.js (skipped for a backend-only plugin), including
 *      the Tailwind classes its UI uses (plugin-stylesheet.js);
 *   3. copies the plugin into a staging folder with the catalog's rules (core/plugin-package-files.ts,
 *      shared with the admin Download route) — never the top-level runtime
 *      data/ (keys, attachments), never OS junk, .git or symlinks, never the working node_modules/ — and
 *      puts the compiled stylesheet at client/admin/admin.css, where the admin shell loads it;
 *   4. settles the npm dependencies on its own (see resolveDependencies below), so the ZIP either lets
 *      the host install them at activation or carries exactly the production ones;
 *   5. runs the installer's own permission + code scan (validatePluginPermissions) on the STAGED copy —
 *      exactly the files the upload will see, shipped node_modules included;
 *   6. zips `<slug>/…` with fixed entry times, so unchanged sources pack to the same bytes, and refuses
 *      an archive the upload route would refuse (10 MB upload, 5000 entries, 200 MB unpacked).
 *
 * Usage (from backend/):
 *   node scripts/pack-plugin.js <slug> [--dir <plugins-folder>] [--out <folder>]
 *   npm run pack:plugin -- <slug> --dir ../../my-private-plugins
 *
 *   --dir   the folder that CONTAINS the plugin folder (default: backend/plugins)
 *   --out   where the ZIP is written (default: <repo>/release/plugins, which is gitignored)
 *
 * Output: <out>/<slug>-<version>.zip, plus its size and sha256. Upload it in Admin → Plugins → Add New.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { builtinModules } = require('module');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const acorn = require('acorn');
const walkAst = require('acorn-walk');
const { stagePackagedStylesheet, PACKAGED_STYLESHEET } = require('./plugin-stylesheet');

// The limits the install path enforces (routes/plugins.ts multer fileSize; core/zip-guard.ts DEFAULTS).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/; // the installer's slug rule (routes/plugins.ts)
// Backend files whose require()s say nothing about runtime: tests, compiled/front-end code, fixtures.
const NOT_RUNTIME_DIR_RE = /(?:^|\/)(?:tests?|__tests__|dist|client|data|node_modules)\//;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?js$/;
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const REPO_ROOT = path.resolve(__dirname, '../..');
const HOST_NODE_MODULES = [path.join(REPO_ROOT, 'backend', 'node_modules'), path.join(REPO_ROOT, 'node_modules')];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));

class PackError extends Error {}
function fail(message) { throw new PackError(message); }

function parseArgs(argv) {
    const opts = { slug: null, dir: path.resolve(__dirname, '../plugins'), out: path.resolve(REPO_ROOT, 'release/plugins') };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') opts.dir = path.resolve(argv[++i] || '');
        else if (a === '--out') opts.out = path.resolve(argv[++i] || '');
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('-')) fail(`unknown option ${a}`);
        else if (!opts.slug) opts.slug = a;
        else fail(`unexpected argument ${a}`);
    }
    return opts;
}

/**
 * Copy the plugin's own files (no node_modules, data/, .git, junk or symlinks) into `dest`. WHICH files
 * is not decided here: core/plugin-package-files.ts holds the rule, shared with the admin Download route
 * (GET /plugins/:slug/download), so the two ways of turning a plugin folder into a ZIP cannot drift apart
 * again — the route used to archive data/ (mail-server's encryption key) while this skipped it.
 */
function stageFiles(src, dest) {
    const { listPluginPackageFiles } = loadCore('plugin-package-files');
    for (const rel of listPluginPackageFiles(src)) {
        const to = path.join(dest, ...rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(src, ...rel.split('/')), to);
    }
}

function listFiles(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) out.push(...listFiles(dir, r));
        else if (e.isFile()) out.push(r);
    }
    return out;
}

/** `lodash/fp` → `lodash`, `@scope/pkg/x` → `@scope/pkg`; null for relative, absolute and built-in specifiers. */
function packageName(spec) {
    if (typeof spec !== 'string' || !spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
    if (/^[A-Za-z]:[\\/]/.test(spec)) return null;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    return BUILTINS.has(name) ? null : name;
}

/** Every npm package the plugin's backend code loads by a literal require()/import. */
function requiredPackages(stageDir) {
    const found = new Map(); // name → first file that loads it
    for (const rel of listFiles(stageDir)) {
        if (!/\.[cm]?js$/.test(rel) || NOT_RUNTIME_DIR_RE.test(rel) || TEST_FILE_RE.test(rel)) continue;
        const code = fs.readFileSync(path.join(stageDir, rel), 'utf8');
        let ast = null;
        for (const sourceType of ['module', 'script']) {
            try {
                ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
                break;
            } catch { /* try the other source type */ }
        }
        if (!ast) { console.warn(`⚠️  ${rel} does not parse; its dependencies are not checked (the installer scan will report it).`); continue; }
        const note = (spec) => { const n = packageName(spec); if (n && !found.has(n)) found.set(n, rel); };
        walkAst.simple(ast, {
            CallExpression(node) {
                if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') note(node.arguments[0].value);
            },
            ImportExpression(node) { if (node.source.type === 'Literal') note(node.source.value); },
            ImportDeclaration(node) { note(node.source.value); },
            ExportAllDeclaration(node) { note(node.source.value); },
            ExportNamedDeclaration(node) { if (node.source) note(node.source.value); },
        });
    }
    return found;
}

const hasPackage = (nodeModules, name) => fs.existsSync(path.join(nodeModules, name, 'package.json'));

/**
 * Decide how the plugin's npm dependencies reach the server — nothing to pass on the command line.
 *
 * SHARED (the default): node_modules/ is NOT shipped. The plugin's package.json `dependencies` are merged
 * into the packed manifest's `dependencies`, which the host installs at activation (and garbage-collects
 * at deactivation). A package the code requires that is in neither, and that the host does not already
 * provide, is an error — it would only surface as "Cannot find module" after upload.
 *
 * BUNDLED ("bundled": true, or forced because the plugin needs a package the host refuses to auto-install
 * — native builds such as sharp/sqlite3): the production dependencies are installed fresh into the staged
 * copy (`npm ci`/`npm install --omit=dev`), so dev tools never ship and the working folder is untouched.
 */
function resolveDependencies(stageDir, manifest, installer) {
    const pkgPath = path.join(stageDir, 'package.json');
    let pkg = null;
    if (fs.existsSync(pkgPath)) {
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { fail(`package.json is not valid JSON: ${e.message}`); }
    }
    const pkgDeps = { ...(pkg && pkg.dependencies) };
    const declared = { ...pkgDeps, ...(manifest.dependencies || {}) };
    const required = requiredPackages(stageDir);
    const hostProvides = (name) => HOST_NODE_MODULES.some((nm) => hasPackage(nm, name));

    const blocked = Object.keys(declared).filter((d) => installer.BLOCKED_RUNTIME_DEPS.has(d));
    let bundled = manifest.bundled === true;
    if (!bundled && blocked.length) {
        bundled = true;
        manifest.bundled = true;
        console.log(`📦 ${blocked.join(', ')} cannot be installed by the server, so the dependencies ship inside the ZIP ("bundled": true).`);
    }

    if (!bundled) {
        const added = Object.keys(pkgDeps).filter((d) => !(manifest.dependencies && d in manifest.dependencies));
        if (Object.keys(declared).length) manifest.dependencies = declared;
        if (added.length) console.log(`📦 Added to the manifest's dependencies from package.json: ${added.join(', ')}.`);
        for (const [name, file] of required) {
            if (name in declared) continue;
            if (hostProvides(name)) {
                console.warn(`⚠️  ${file} requires '${name}', which is not declared; it works only because the WordJS server already has it. Add it to package.json "dependencies" to be safe.`);
                continue;
            }
            fail(`${file} requires '${name}', which is not declared. Add it to the plugin's package.json "dependencies" (npm install ${name}).`);
        }
        if (Object.keys(declared).length) console.log(`📦 The server installs on activation: ${Object.keys(declared).join(', ')}.`);
        return { bundled: false };
    }

    const nm = path.join(stageDir, 'node_modules');
    if (pkg && Object.keys(pkgDeps).length) {
        const lock = fs.existsSync(path.join(stageDir, 'package-lock.json'));
        const args = lock
            ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
            : ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'];
        console.log(`📥 Installing the production dependencies into the package (npm ${args[0]} --omit=dev)…`);
        const r = spawnSync(NPM_BIN, args, { cwd: stageDir, stdio: 'inherit', shell: process.platform === 'win32' });
        if (r.status !== 0) fail(`npm ${args[0]} failed (see above).`);
    } else if (manifest.dependencies && Object.keys(manifest.dependencies).length) {
        fail('a bundled plugin needs a package.json with its "dependencies" so the packer can install them. Move the manifest\'s dependencies there.');
    }
    for (const [name, file] of required) {
        if (hasPackage(nm, name)) continue;
        if (hostProvides(name)) {
            console.warn(`⚠️  ${file} requires '${name}', which is not bundled; it works only because the WordJS server already has it.`);
            continue;
        }
        fail(`${file} requires '${name}', which is not in package.json "dependencies" (npm install ${name}).`);
    }
    const native = fs.existsSync(nm) && listFiles(nm).some((f) => f.endsWith('.node'));
    if (native) console.warn(`⚠️  The bundled dependencies contain native binaries built for ${process.platform}-${process.arch}; the server must run the same platform.`);
    return { bundled: true };
}

/** A host core module, compiled when present, else from source through ts-node. */
function loadCore(name) {
    const compiled = path.resolve(__dirname, `../dist/core/${name}.js`);
    if (fs.existsSync(compiled)) return require(compiled);
    try { require('ts-node/register/transpile-only'); } catch {
        fail('cannot load the WordJS installer checks: run `npm install` (or `npm run build`) in backend/ first.');
    }
    return require(path.resolve(__dirname, `../src/core/${name}.ts`));
}

/** The installer module (permission + code scan, dependency rules). */
function loadInstaller() {
    return loadCore('plugins');
}

/**
 * Refuse a plugin whose dependencies the INSTALLER would refuse: anything that is not a plain registry
 * version range (core/plugins.ts validateManifestDependencies — the same function the installer calls).
 * The host installs a manifest's `dependencies` with npm at activation, and npm builds a `git+…`,
 * `github:` or `file:<dir>` dependency by running its `prepare` script even under --ignore-scripts; an
 * `npm:` alias or a tarball URL installs unscanned code under another name.
 *
 * Checked twice: the manifest as written, here, before anything else runs; and the PACKED manifest after
 * resolveDependencies, which is where package.json `dependencies` are folded in for a shared (non-bundled)
 * plugin — i.e. every spec the server would ever be asked to install. A BUNDLED plugin's package.json
 * dependencies never reach the server's npm: the packer installs them into the package on the author's
 * machine and they ship as files, which the installer's scan then reads like the rest of the plugin.
 */
function checkDependencySpecs(manifest, installer, where) {
    const problems = installer.validateManifestDependencies(manifest.dependencies);
    if (problems.length) fail(`the installer would refuse this plugin's ${where} dependencies:\n   - ${problems.join('\n   - ')}`);
}

function pack(opts) {
    const slug = opts.slug;
    if (!SLUG_RE.test(slug)) fail(`"${slug}" is not a plugin slug (letters, digits, - and _).`);

    const pluginDir = path.join(opts.dir, slug);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) fail(`${pluginDir} has no manifest.json.`);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { fail(`manifest.json is not valid JSON: ${e.message}`); }
    if (manifest.id !== undefined && manifest.id !== slug) fail(`manifest id "${manifest.id}" does not match the folder name "${slug}".`);
    if (!manifest.name) fail('manifest.json has no "name".');
    if (manifest.isolated !== true) fail('manifest.json must declare "isolated": true.');
    const version = String(manifest.version || '0.0.0');
    if (!/^[0-9A-Za-z.+-]{1,32}$/.test(version)) fail(`manifest version "${version}" is not usable in a file name.`);

    const installer = loadInstaller();
    checkDependencySpecs(manifest, installer, 'manifest.json');

    if (manifest.frontend) {
        console.log('🛠️  Compiling the frontend entries…');
        const r = spawnSync(process.execPath, [path.join(__dirname, 'build-plugin.js'), slug], {
            env: { ...process.env, WORDJS_PLUGINS_DIR: opts.dir },
            stdio: 'inherit',
        });
        if (r.status !== 0) fail('the frontend build failed (see above).');
    }

    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-pack-'));
    try {
        const stageDir = path.join(stageRoot, slug);
        fs.mkdirSync(stageDir);
        stageFiles(pluginDir, stageDir);
        // Same substitution the catalog makes (build-marketplace.js): the BUILT stylesheet is the
        // package's client/admin/admin.css. Done on the stage, before the installer checks below.
        if (stagePackagedStylesheet(stageDir)) console.log(`🎨 ${PACKAGED_STYLESHEET} carries the compiled Tailwind classes.`);

        const packed = JSON.parse(JSON.stringify(manifest));
        resolveDependencies(stageDir, packed, installer);
        if (JSON.stringify(packed) !== JSON.stringify(manifest)) {
            fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(packed, null, 4) + '\n');
        }

        console.log(`🔎 Checking ${slug} ${version} the way the installer does…`);
        try { installer.validatePluginPermissions(slug, stageDir, packed, { mode: 'grant' }); } catch (e) {
            fail(`the installer would refuse this plugin: ${e.message}`);
        }
        // The merged dependency set (package.json folded into the manifest above) and the browser:script
        // declaration the installer requires of a plugin that ships browser code.
        checkDependencySpecs(packed, installer, 'package.json/manifest.json');
        for (const p of installer.validateBrowserCapability(stageDir, packed)) {
            fail(`the installer would refuse this plugin: ${p}`);
        }

        const zip = new AdmZip();
        let unpacked = 0;
        for (const rel of listFiles(stageDir).sort()) {
            const body = fs.readFileSync(path.join(stageDir, rel));
            unpacked += body.length;
            zip.addFile(`${slug}/${rel}`, body);
        }
        for (const entry of zip.getEntries()) entry.header.time = FIXED_DATE;

        const entries = zip.getEntries().length;
        if (entries > MAX_ENTRIES) fail(`${entries} files, over the installer's ${MAX_ENTRIES}-entry limit.`);
        if (unpacked > MAX_UNPACKED_BYTES) fail(`${(unpacked / 1048576).toFixed(1)} MB unpacked, over the installer's 200 MB limit.`);
        const buf = zip.toBuffer();
        if (buf.length > MAX_UPLOAD_BYTES) fail(`the ZIP is ${(buf.length / 1048576).toFixed(1)} MB, over the 10 MB upload limit.`);

        fs.mkdirSync(opts.out, { recursive: true });
        const file = path.join(opts.out, `${slug}-${version}.zip`);
        fs.writeFileSync(file, buf);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        console.log(`📦 ${file}`);
        console.log(`   ${entries} files, ${(buf.length / 1024).toFixed(1)} KB, sha256 ${sha256}`);
        console.log('   Upload it in Admin → Plugins → Add New (deactivate or uninstall an installed copy first).');
        return file;
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
}

function main() {
    try {
        const opts = parseArgs(process.argv.slice(2));
        if (opts.help || !opts.slug) {
            console.log('Usage: node scripts/pack-plugin.js <slug> [--dir <plugins-folder>] [--out <folder>]');
            process.exit(opts.help ? 0 : 1);
        }
        pack(opts);
    } catch (e) {
        if (!(e instanceof PackError)) throw e;
        console.error(`❌ ${e.message}`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { parseArgs, packageName };
