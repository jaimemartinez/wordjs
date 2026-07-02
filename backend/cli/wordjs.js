#!/usr/bin/env node
/**
 * WordJS CLI — plugin/theme scaffolder + plugin packer.
 *
 * Plain Node (no ts-node, no core imports). Run from the repo root (or backend/):
 *
 *   node backend/cli/wordjs.js create plugin <slug>     # scaffold backend/plugins/<slug>/
 *   node backend/cli/wordjs.js create theme  <slug>     # scaffold backend/themes/<slug>/
 *   node backend/cli/wordjs.js pack <slug> [--build] [--out <dir>]   # zip a plugin for distribution
 *
 * Templates live in backend/cli/templates/{plugin,theme}/ with __SLUG__ / __PASCAL__ / __NAME__
 * placeholders replaced in both file contents and file names.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(BACKEND_DIR, 'plugins');
const THEMES_DIR = path.join(BACKEND_DIR, 'themes');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function die(msg) {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

// Lowercase kebab-case, must also satisfy the backend's route slug check (^[a-zA-Z0-9_-]+$).
function isValidSlug(slug) {
    return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug || '');
}

function toPascalCase(slug) {
    return slug.split(/[-_]+/).filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function toTitleCase(slug) {
    return slug.split(/[-_]+/).filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function applyReplacements(str, replacements) {
    let out = str;
    for (const [token, value] of Object.entries(replacements)) {
        out = out.split(token).join(value);
    }
    return out;
}

/**
 * Recursively copy a template directory, replacing placeholders in file names AND contents.
 * Returns the list of created files (paths relative to destDir).
 */
function copyTemplates(srcDir, destDir, replacements, created = [], relBase = '') {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const outName = applyReplacements(entry.name, replacements);
        const destPath = path.join(destDir, outName);
        const relPath = relBase ? `${relBase}/${outName}` : outName;
        if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyTemplates(srcPath, destPath, replacements, created, relPath);
        } else {
            const content = applyReplacements(fs.readFileSync(srcPath, 'utf8'), replacements);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, content, 'utf8');
            created.push(relPath);
        }
    }
    return created;
}

function scaffold(kind, slug) {
    if (!isValidSlug(slug)) {
        die(`Invalid slug '${slug}'. Use lowercase kebab-case: my-${kind} (a-z, 0-9, dashes).`);
    }
    const templateDir = path.join(TEMPLATES_DIR, kind);
    if (!fs.existsSync(templateDir)) die(`Template directory not found: ${templateDir}`);

    const baseDir = kind === 'plugin' ? PLUGINS_DIR : THEMES_DIR;
    const destDir = path.join(baseDir, slug);
    if (fs.existsSync(destDir)) die(`${kind} '${slug}' already exists at ${destDir} — refusing to overwrite.`);

    const replacements = {
        __SLUG__: slug,
        __PASCAL__: toPascalCase(slug),
        __NAME__: toTitleCase(slug),
    };

    fs.mkdirSync(destDir, { recursive: true });
    const created = copyTemplates(templateDir, destDir, replacements);

    console.log(`\n✅ ${kind === 'plugin' ? 'Plugin' : 'Theme'} '${slug}' scaffolded at ${path.relative(process.cwd(), destDir) || destDir}\n`);
    console.log('Created:');
    for (const f of created) console.log(`   ${f}`);
    return { destDir, replacements };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function createPlugin(slug) {
    scaffold('plugin', slug);

    console.log(`
Next steps:
  1. Restart the backend ONCE so the new plugin folder is discovered
     (after that, activation hot-loads it — no further restarts needed).
  2. Activate it in /admin/plugins. Activation spawns the sandboxed child process and
     grants exactly the permissions declared in manifest.json (default-deny — the admin
     can refine every grant later).
  3. Regenerate the frontend registries so the admin page and Puck block show up:
       node frontend/scripts/generate-admin-plugin-registry.js
       node frontend/scripts/generate-puck-plugin-registry.js

Dev loop: run the backend with NODE_ENV=development (npm run dev) and every .js/.json save
inside the plugin hot-reloads its child process (re-running the security scan). You can also
force it: POST /api/v1/plugins/${slug}/reload (admin).

API base:   /api/v1/plugin/${slug}/
Admin page: /admin/plugin/${slug}
Types:      the injected bridge is typed in backend/types/wordjs-bridge.d.ts (JSDoc IntelliSense).
`);
}

function createTheme(slug) {
    scaffold('theme', slug);

    console.log(`
Next steps:
  1. Restart the backend once so the theme is discovered, then activate it in /admin/themes.
  2. Edit style.css — the :root --wjs-* block IS the token contract (seeded from
     backend/themes/default/style.css); the WordJS UI framework styles the whole public site
     from those tokens. See backend/themes/midnight-luxury/ for a complete real theme.
  3. theme.json "layout" controls the public shell (containerWidth, sidebar). Admins can
     override tokens live in /admin/themes/customize.
`);
}

function pack(slug, args) {
    if (!isValidSlug(slug)) die(`Invalid plugin slug '${slug}'.`);
    const pluginDir = path.join(PLUGINS_DIR, slug);
    if (!fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
        die(`No plugin at backend/plugins/${slug} (manifest.json not found).`);
    }

    // Optionally pre-compile the frontend bundles (reuses backend/scripts/build-plugin.js).
    if (args.includes('--build')) {
        const builder = path.join(BACKEND_DIR, 'scripts', 'build-plugin.js');
        if (fs.existsSync(builder)) {
            const { spawnSync } = require('child_process');
            const r = spawnSync(process.execPath, [builder, slug], { stdio: 'inherit', cwd: BACKEND_DIR });
            if (r.status !== 0) die(`build-plugin.js failed for '${slug}' — fix the build, then pack again.`);
        } else {
            console.warn('⚠️  backend/scripts/build-plugin.js not found — skipping --build.');
        }
    }

    let AdmZip;
    try {
        AdmZip = require('adm-zip'); // backend dependency (resolved via backend/node_modules)
    } catch {
        die("adm-zip not found — run `npm install` inside backend/ first.");
    }

    const outIdx = args.indexOf('--out');
    const outDir = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : process.cwd();
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${slug}.zip`);

    // Zip with a single <slug>/ root folder (what POST /api/v1/plugins/upload expects), excluding
    // dev/runtime junk. adm-zip's filter receives each entry's path — keep it unless excluded.
    const EXCLUDE = /(^|[\\/])(node_modules|data|\.git|os-tmp)([\\/]|$)/;
    const zip = new AdmZip();
    zip.addLocalFolder(pluginDir, slug, (p) => !EXCLUDE.test(p));
    zip.writeZip(outFile);

    const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`\n📦 Packed '${slug}' → ${outFile} (${sizeKB} KB)`);
    console.log('   Install it on any WordJS site: /admin/plugins → Add New → upload the zip.');
    console.log('   (node_modules/, data/, .git/ excluded — dependencies reinstall on activation.)');
}

function printHelp() {
    console.log(`WordJS CLI

Usage (from the repo root):
  node backend/cli/wordjs.js create plugin <slug>              Scaffold an isolated plugin
  node backend/cli/wordjs.js create theme  <slug>              Scaffold a theme (full --wjs-* token contract)
  node backend/cli/wordjs.js pack <slug> [--build] [--out <dir>]  Zip a plugin for distribution

Examples:
  node backend/cli/wordjs.js create plugin my-plugin
  node backend/cli/wordjs.js create theme  my-theme
  node backend/cli/wordjs.js pack my-plugin --build

Docs: documentation/cli.md · documentation/plugins.md · documentation/themes.md`);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'create' && argv[1] === 'plugin' && argv[2]) {
    createPlugin(argv[2]);
} else if (cmd === 'create' && argv[1] === 'theme' && argv[2]) {
    createTheme(argv[2]);
} else if (cmd === 'pack' && argv[1]) {
    pack(argv[1], argv.slice(2));
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
    printHelp();
    if (!cmd) process.exit(1);
} else {
    printHelp();
    process.exit(1);
}
