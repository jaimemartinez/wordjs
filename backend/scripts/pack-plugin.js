#!/usr/bin/env node
/**
 * WordJS Plugin Packer — one installable ZIP for ONE plugin, from any folder.
 *
 * The marketplace builder (build-marketplace.js) packs the catalog under marketplace/plugins and writes
 * its index; a plugin that is not in the catalog — a private or client plugin kept untracked in
 * backend/plugins, or in a repository of its own — had no equivalent, and the documented path was
 * "compress the folder by hand". This does what that step needs, the same way the catalog does it:
 *
 *   1. checks the manifest the installer will check (valid JSON, id == folder, a name, "isolated": true)
 *      and runs the installer's own permission + code scan (validatePluginPermissions), so a package the
 *      upload would refuse is refused here instead;
 *   2. compiles the frontend entries with build-plugin.js (a no-op for a backend-only plugin);
 *   3. zips `<slug>/…` with the catalog's rules — never the top-level runtime data/ (keys, attachments),
 *      never OS junk or .git, node_modules only with --include-node-modules (otherwise the installer
 *      installs the declared dependencies on activation), fixed entry times so an unchanged plugin packs
 *      to the same bytes;
 *   4. refuses an archive the upload route would refuse (10 MB upload, 5000 entries, 200 MB unpacked).
 *
 * Usage (from backend/):
 *   node scripts/pack-plugin.js <slug> [--dir <plugins-folder>] [--out <folder>] [--include-node-modules]
 *   npm run pack:plugin -- <slug> --dir ../../my-private-plugins
 *
 *   --dir   the folder that CONTAINS the plugin folder (default: backend/plugins)
 *   --out   where the ZIP is written (default: <repo>/release/plugins, which is gitignored)
 *
 * Output: <out>/<slug>-<version>.zip, plus its size and sha256. Upload it in Admin → Plugins → Add New.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

// The limits the install path enforces (routes/plugins.ts multer fileSize; core/zip-guard.ts DEFAULTS).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SKIP_RE = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git)([\\/]|$)/i;
const NODE_MODULES_RE = /(^|[\\/])node_modules([\\/]|$)/;
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

function fail(message) {
    console.error(`❌ ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { slug: null, dir: path.resolve(__dirname, '../plugins'), out: path.resolve(__dirname, '../../release/plugins'), includeNodeModules: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') opts.dir = path.resolve(argv[++i] || '');
        else if (a === '--out') opts.out = path.resolve(argv[++i] || '');
        else if (a === '--include-node-modules') opts.includeNodeModules = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('-')) fail(`unknown option ${a}`);
        else if (!opts.slug) opts.slug = a;
        else fail(`unexpected argument ${a}`);
    }
    return opts;
}

function walk(dir, includeNodeModules) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (SKIP_RE.test(p)) continue;
        if (!includeNodeModules && NODE_MODULES_RE.test(e.name)) continue;
        if (e.isSymbolicLink()) continue; // never follow a link out of the plugin folder
        if (e.isDirectory()) out.push(...walk(p, includeNodeModules));
        else if (e.isFile()) out.push(p);
    }
    return out;
}

/** The installer's own permission + code scan, from the compiled backend when present, else the source. */
function installerScan(slug, pluginDir, manifest) {
    let plugins;
    const compiled = path.resolve(__dirname, '../dist/core/plugins.js');
    if (fs.existsSync(compiled)) {
        plugins = require(compiled);
    } else {
        try { require('ts-node/register/transpile-only'); } catch {
            console.warn('⚠️  Skipping the permission and code scan: no compiled backend (npm run build) and no ts-node. The installer will still run it on upload.');
            return;
        }
        plugins = require(path.resolve(__dirname, '../src/core/plugins.ts'));
    }
    plugins.validatePluginPermissions(slug, pluginDir, manifest, { mode: 'grant' });
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.slug) {
        console.log('Usage: node scripts/pack-plugin.js <slug> [--dir <plugins-folder>] [--out <folder>] [--include-node-modules]');
        process.exit(opts.help ? 0 : 1);
    }
    const slug = opts.slug;
    if (!SLUG_RE.test(slug)) fail(`"${slug}" is not a plugin slug (lowercase letters, digits, - and _).`);

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

    console.log(`🔎 Checking ${slug} ${version} the way the installer does…`);
    try { installerScan(slug, pluginDir, manifest); } catch (e) { fail(`the installer would refuse this plugin: ${e.message}`); }

    if (manifest.frontend) {
        console.log('🛠️  Compiling the frontend entries…');
        const r = spawnSync(process.execPath, [path.join(__dirname, 'build-plugin.js'), slug], {
            env: { ...process.env, WORDJS_PLUGINS_DIR: opts.dir },
            stdio: 'inherit',
        });
        if (r.status !== 0) fail('the frontend build failed (see above).');
    }

    const zip = new AdmZip();
    let unpacked = 0;
    const files = walk(pluginDir, opts.includeNodeModules).sort();
    for (const abs of files) {
        const rel = path.relative(pluginDir, abs).split(path.sep).join('/');
        // A plugin's top-level data/ is runtime state (encryption keys, attachments): never shipped.
        if (rel === 'data' || rel.startsWith('data/')) continue;
        const body = fs.readFileSync(abs);
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
}

if (require.main === module) main();

module.exports = { parseArgs };
