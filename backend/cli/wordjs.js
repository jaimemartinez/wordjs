#!/usr/bin/env node
/**
 * WordJS CLI — plugin/theme scaffolder + plugin packer.
 *
 * Plain Node (no ts-node, no core imports). Run from the repo root (or backend/):
 *
 *   node backend/cli/wordjs.js create plugin <slug>     # scaffold backend/plugins/<slug>/
 *   node backend/cli/wordjs.js create theme  <slug>     # scaffold backend/themes/<slug>/
 *       [--primary --secondary --bg --text <#rrggbb>]   #   … or generate it from 4 seed colors
 *       [--archetype <name>] [--name/--author/--description <text>]
 *   node backend/cli/wordjs.js build theme <slug>       # recompile theme.json → style.css block
 *   node backend/cli/wordjs.js pack <slug> [--build] [--out <dir>]   # zip a plugin for distribution
 *   node backend/cli/wordjs.js doctor theme <slug>      # lint a theme against the token contract
 *   node backend/cli/wordjs.js import stitch <slug>     # map a Stitch design system into theme.json
 *       [--from <stitch.json>] [--name/--author/--description <text>]
 *   node backend/cli/wordjs.js verify theme <slug>      # compare a theme with its Stitch design
 *       [--against <stitch.json>]
 *
 * Templates live in backend/cli/templates/{plugin,theme}/ with __SLUG__ / __PASCAL__ / __NAME__
 * placeholders replaced in both file contents and file names.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(BACKEND_DIR, 'plugins');
// Theme commands honor WORDJS_THEMES_DIR (tests/CI point it at a throwaway dir).
const THEMES_DIR = process.env.WORDJS_THEMES_DIR
    ? path.resolve(process.env.WORDJS_THEMES_DIR)
    : path.join(BACKEND_DIR, 'themes');
const MANIFEST_PATH = path.join(BACKEND_DIR, 'public', 'theme-tokens.json');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Must match theme-compile's markers (only used to tell "regenerated" from "added").
const GENERATED_START = '/* @wjs-generated:start';
const GENERATED_END = '/* @wjs-generated:end */';

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

// `--flag value` pairs only; unknown flags die loudly (typos must not silently scaffold).
function parseFlags(args, known) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('--')) die(`Unexpected argument '${args[i]}'.`);
        const name = args[i].slice(2);
        if (!known.includes(name)) die(`Unknown flag '--${name}'. Known: ${known.map((k) => `--${k}`).join(', ')}.`);
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) die(`Flag --${name} needs a value.`);
        flags[name] = value;
        i++;
    }
    return flags;
}

// Seeds are strict #rrggbb (theme-compile's SEED_RE); the leading '#' may be omitted on
// the command line because most shells are happier without it.
function parseSeedColor(flag, value) {
    const hex = value.startsWith('#') ? value : `#${value}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) die(`--${flag} must be a #rrggbb color (got '${value}').`);
    return hex.toLowerCase();
}

function printDiagnostics(diagnostics) {
    for (const d of diagnostics) {
        console.log(`${d.level === 'error' ? '❌' : '⚠️ '} [${d.code}] ${d.path} — ${d.message}`);
    }
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

function scaffold(kind, slug, nameOverride) {
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
        __NAME__: nameOverride || toTitleCase(slug),
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

function createTheme(slug, args) {
    const flags = parseFlags(args, ['primary', 'secondary', 'bg', 'text', 'archetype', 'name', 'author', 'description']);
    const seedCount = ['primary', 'secondary', 'bg', 'text'].filter((k) => flags[k] !== undefined).length;
    if (seedCount === 0 && flags.archetype === undefined) {
        createThemeFromTemplate(slug, flags);
        return;
    }
    // theme-derive needs all four seeds to derive the token set.
    if (seedCount < 4) {
        die('Seeded creation needs all four colors: --primary --secondary --bg --text (#rrggbb).');
    }
    createSeededTheme(slug, flags);
}

function createThemeFromTemplate(slug, flags) {
    const { destDir } = scaffold('theme', slug, flags.name);
    if (flags.author !== undefined || flags.description !== undefined) {
        const themeJsonPath = path.join(destDir, 'theme.json');
        const json = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
        if (flags.author !== undefined) json.author = flags.author;
        if (flags.description !== undefined) json.description = flags.description;
        fs.writeFileSync(themeJsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }

    console.log(`
Next steps:
  1. Restart the backend once so the theme is discovered, then activate it in /admin/themes.
  2. Edit style.css — the :root --wjs-* block IS the token contract (seeded from
     backend/themes/default/style.css); the WordJS UI framework styles the whole public site
     from those tokens. See backend/themes/default/ for a complete real theme.
  3. theme.json "layout" controls the public shell (containerWidth, sidebar). Admins can
     override tokens live in /admin/themes/customize.
  4. Lint any time: node backend/cli/wordjs.js doctor theme ${slug} — checks your tokens
     against the contract manifest (backend/public/theme-tokens.json).

Tip: pass --primary/--secondary/--bg/--text seed colors to generate a declarative theme.json
     compiled by theme-compile instead of the static template (see \`help\`).
`);
}

function createSeededTheme(slug, flags) {
    if (!isValidSlug(slug)) {
        die(`Invalid slug '${slug}'. Use lowercase kebab-case: my-theme (a-z, 0-9, dashes).`);
    }
    const destDir = path.join(THEMES_DIR, slug);
    if (fs.existsSync(destDir)) die(`theme '${slug}' already exists at ${destDir} — refusing to overwrite.`);

    const seeds = {
        primary: parseSeedColor('primary', flags.primary),
        secondary: parseSeedColor('secondary', flags.secondary),
        bg: parseSeedColor('bg', flags.bg),
        text: parseSeedColor('text', flags.text),
    };
    // Validate before anything touches the disk.
    if (flags.archetype !== undefined) {
        const names = loadCore('theme-derive').ARCHETYPE_NAMES;
        if (!names.includes(flags.archetype)) {
            die(`Unknown archetype '${flags.archetype}'. Available: ${names.join(', ')}.`);
        }
    }
    const { compileTheme, writeCompiled } = loadCore('theme-compile');

    const name = flags.name || toTitleCase(slug);
    const themeJson = {
        name,
        version: '1.0.0',
        description: flags.description || `${name} — a WordJS theme generated from four seed colors.`,
        author: flags.author || 'Your Name',
        generator: 'wordjs',
        seeds,
        layout: { containerWidth: '1100px', sidebar: false },
    };
    if (flags.archetype !== undefined) themeJson.archetype = flags.archetype;

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'theme.json'), JSON.stringify(themeJson, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(destDir, 'functions.js'), `/**\n * ${name} — theme logic and hooks\n */\nmodule.exports = () => {};\n`, 'utf8');

    // dryRun first: a failed compile must not leave a half-scaffolded theme behind.
    const result = compileTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true });
    printDiagnostics(result.diagnostics);
    if (result.stats.errors > 0) {
        fs.rmSync(destDir, { recursive: true, force: true });
        die(`compile failed with ${result.stats.errors} error(s) — nothing created.`);
    }
    writeCompiled(destDir, result.css);

    console.log(`\n✅ Theme '${slug}' created at ${path.relative(process.cwd(), destDir) || destDir}\n`);
    console.log('Created:');
    console.log(`   theme.json    declarative source (generator "wordjs": seeds${flags.archetype !== undefined ? ` + archetype '${flags.archetype}'` : ''})`);
    console.log(`   style.css     compiled @wjs-generated block — ${result.stats.tokens} token(s), ${result.stats.rules} rule(s)`);
    console.log('   functions.js  theme logic stub');
    console.log(`
Next steps:
  1. Restart the backend once so the theme is discovered, then activate it in /admin/themes.
  2. Edit theme.json (seeds / tokens / styles / archetype) and recompile:
       node backend/cli/wordjs.js build theme ${slug}
     Only the marked block in style.css is regenerated — manual CSS outside it is preserved.
  3. Lint any time: node backend/cli/wordjs.js doctor theme ${slug}
`);
}

// Load a dependency-free core module (theme-doctor / theme-derive / theme-compile: fs, path
// and css-tree only — never boots core subsystems). Prefer the compiled build (what prod
// runs); fall back to transpiling src via ts-node. Checked per module — dist/ may predate
// the newer theme files.
function loadCore(name) {
    const dist = path.join(BACKEND_DIR, 'dist', 'core', `${name}.js`);
    if (fs.existsSync(dist)) return require(dist);
    try {
        // Explicit project: the CLI runs from the repo root, where ts-node's own
        // tsconfig discovery would miss backend/tsconfig.json.
        require('ts-node').register({ project: path.join(BACKEND_DIR, 'tsconfig.json'), transpileOnly: true });
    } catch {
        die('ts-node not found — run `npm install` inside backend/ (or `npm run build`) first.');
    }
    return require(path.join(BACKEND_DIR, 'src', 'core', `${name}.ts`));
}

function doctorTheme(slug) {
    // Installed themes may use any slug the routes accept (not just kebab-case scaffolds).
    if (!/^[a-zA-Z0-9_-]+$/.test(slug || '')) die(`Invalid theme slug '${slug}'.`);
    const { analyzeTheme } = loadCore('theme-doctor');
    const report = analyzeTheme(slug, {
        themesDir: THEMES_DIR,
        manifestPath: MANIFEST_PATH,
        layoutSchemaPath: path.join(BACKEND_DIR, 'public', 'theme-layouts.schema.json'),
    });

    if (!report.available) {
        console.log('⚠️  Token manifest (backend/public/theme-tokens.json) not found — nothing to lint against.');
        return;
    }

    console.log(`\n🩺 Theme doctor — ${slug}`);
    for (const [icon, level] of [['❌', 'errors'], ['⚠️ ', 'warnings'], ['ℹ️ ', 'info']]) {
        for (const f of report[level]) {
            console.log(`${icon} [${f.code}] ${f.message}`);
        }
    }
    console.log(`\n${report.errors.length} error(s), ${report.warnings.length} warning(s), ${report.info.length} info.`);
    if (report.errors.length > 0) process.exit(1);
}

/**
 * Stitch design system → theme.json, mechanically. The mapping used to be done by hand, which is
 * how a theme ended up with a hero title the same colour as its band; stitch-import owns it now and
 * only emits tokens the manifest knows. Recompiles afterwards so style.css never lags theme.json.
 */
function importStitch(slug, args) {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug || '')) die(`Invalid theme slug '${slug}'.`);
    const themeDir = path.join(THEMES_DIR, slug);
    if (!fs.existsSync(themeDir)) die(`No theme at ${themeDir}. Scaffold it first: create theme ${slug}`);

    const flags = parseFlags(args, ['from', 'name', 'author', 'description']);
    // Default location doubles as provenance: a theme built from a design keeps it next to itself.
    const designPath = flags.from
        ? path.resolve(flags.from)
        : path.join(themeDir, '.design', 'stitch.json');
    let design;
    try {
        design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
    } catch (e) {
        die(`Cannot read the design system at ${designPath} — ${e.message}`
            + (flags.from ? '' : '\n   Save the get_project payload there, or pass --from <file>.'));
    }

    const { applyDesignToTheme } = loadCore('stitch-import');
    let result;
    try {
        result = applyDesignToTheme(themeDir, design, { slug, manifestPath: MANIFEST_PATH, name: flags.name, author: flags.author, description: flags.description });
    } catch (e) {
        die(`Import failed — ${e.message}`);
    }

    const tokenCount = Object.keys((result.theme && result.theme.tokens) || {}).length;
    console.log(`\n✅ themes/${slug}/theme.json — ${tokenCount} token(s) from ${path.relative(process.cwd(), designPath) || designPath}`);
    if (result.preserved && result.preserved.length > 0) {
        console.log(`   kept ${result.preserved.length} value(s) the design does not own: ${result.preserved.slice(0, 6).join(', ')}${result.preserved.length > 6 ? '…' : ''}`);
    }
    if (result.dropped && result.dropped.length > 0) {
        console.log(`   ⚠️  ${result.dropped.length} mapped token(s) are not in the manifest and were skipped: ${result.dropped.slice(0, 6).join(', ')}${result.dropped.length > 6 ? '…' : ''}`);
    }
    for (const note of result.notes || []) console.log(`   ℹ️  ${note}`);

    console.log('\nRecompiling…');
    buildTheme(slug);
}

function verifyThemeCmd(slug, args) {
    // Installed themes may use any slug the routes accept (not just kebab-case scaffolds).
    if (!/^[a-zA-Z0-9_-]+$/.test(slug || '')) die(`Invalid theme slug '${slug}'.`);
    const flags = parseFlags(args, ['against']);
    const designPath = flags.against
        ? path.resolve(flags.against)
        : path.join(THEMES_DIR, slug, '.design', 'stitch.json');

    let design;
    try {
        design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
    } catch (e) {
        die(`Cannot read the design system at ${designPath} — ${e.message}`
            + (flags.against ? '' : '\n   Themes built from Stitch keep it at themes/<slug>/.design/stitch.json; pass --against <file> for one stored elsewhere.'));
    }

    const { verifyTheme } = loadCore('theme-verify');
    let report;
    try {
        report = verifyTheme(slug, design, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH });
    } catch (e) {
        die(e.message);
    }

    // A design kept outside the repo reads better absolute than as a stack of '..'.
    const shownPath = path.relative(process.cwd(), designPath);
    console.log(`\n🔎 Theme verify — ${slug}`);
    console.log(`   design: ${!shownPath || shownPath.startsWith('..') ? designPath : shownPath}\n`);

    for (const m of report.mismatches) {
        console.log(`❌ ${m.token}`);
        console.log(`     expected  ${m.expected}   ← ${m.source}`);
        console.log(`     actual    ${m.actual === null ? '(nothing declares it)' : m.actual}`);
    }

    // Not comparable — reported so a silent gap can never read as a pass.
    const byReason = (r) => report.unmapped.filter((u) => u.reason === r);
    const missing = byReason('design-missing');
    if (missing.length > 0) {
        console.log(`⚠️  ${missing.length} value(s) the design does not pin:`);
        for (const u of missing) console.log(`     ${u.token}   ← ${u.source} (absent)`);
    }
    for (const u of byReason('no-rule')) {
        console.log(`⚠️  ${u.source} has no mapping rule${u.token ? ` for ${u.token}` : ''}${u.note ? ` — ${u.note}` : ''}`);
    }
    const spare = byReason('no-token');
    if (spare.length > 0) {
        console.log(`ℹ️  ${spare.length} design value(s) no token consumes: ${spare.map((u) => u.source.replace(/^namedColors\./, '')).join(', ')}`);
    }

    console.log(`\n${report.matches.length} matched, ${report.mismatches.length} mismatched, ${report.unmapped.length} not comparable.`);
    if (report.mismatches.length > 0) {
        console.log(`\nFix themes/${slug}/theme.json, then recompile: node backend/cli/wordjs.js build theme ${slug}`);
        process.exit(1);
    }
    console.log(`✅ themes/${slug} matches its design system.`);
}

function buildTheme(slug) {
    // Installed themes may use any slug the routes accept (not just kebab-case scaffolds).
    if (!/^[a-zA-Z0-9_-]+$/.test(slug || '')) die(`Invalid theme slug '${slug}'.`);
    const themeDir = path.join(THEMES_DIR, slug);
    const { compileTheme, writeCompiled } = loadCore('theme-compile');

    const result = compileTheme(slug, { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true });
    printDiagnostics(result.diagnostics);
    if (result.stats.errors > 0) {
        console.error(`\n❌ ${result.stats.errors} error(s) — style.css NOT written.`);
        process.exit(1);
    }

    let existing = null;
    try { existing = fs.readFileSync(path.join(themeDir, 'style.css'), 'utf8'); } catch { /* no style.css yet */ }
    const hasBlock = existing !== null && existing.includes(GENERATED_START) && existing.includes(GENERATED_END);

    // A theme that never opted into the declarative contract compiles to an empty block —
    // don't prepend one; only refresh a block that already exists.
    const themeJsonPath = path.join(themeDir, 'theme.json');
    let themeJson = null;
    try { themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8')); } catch { /* compile already diagnosed it */ }
    const declarative = ['seeds', 'archetype', 'tokens', 'styles'].some((k) => themeJson && themeJson[k] !== undefined);
    if (!declarative && !hasBlock) {
        console.log(`ℹ️  themes/${slug}/theme.json has no declarative keys (seeds/archetype/tokens/styles) and style.css has no @wjs-generated block — nothing to build.`);
        return;
    }

    if (!hasBlock) {
        console.log('⚠️  style.css has no @wjs-generated block yet — prepending it (existing CSS is preserved below it).');
    }
    writeCompiled(themeDir, result.css);

    // The stylesheet URL is keyed by the theme's version, so a rebuild that leaves theme.json alone
    // ships new CSS behind the old cache key — browsers keep the pre-build copy for up to an hour.
    // The write API bumps the patch for exactly this reason; the CLI has to do the same.
    let bumped = null;
    try {
        if (!themeJson) throw new Error('theme.json unreadable');
        const parts = String(themeJson.version || '1.0.0').split('.');
        if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
            bumped = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
            themeJson.version = bumped;
            fs.writeFileSync(themeJsonPath, JSON.stringify(themeJson, null, 2) + '\n');
        }
    } catch (e) {
        console.warn(`⚠️  Could not bump theme.json version (${e.message}) — browsers may serve the previous CSS until it expires.`);
        bumped = null;
    }

    console.log(`\n✅ themes/${slug}/style.css — @wjs-generated block ${hasBlock ? 'regenerated' : 'added'}: ` +
        `${result.stats.tokens} token(s), ${result.stats.rules} rule(s), ${result.stats.declarations} declaration(s), ` +
        `${result.stats.variations} variation(s), ${result.stats.warnings} warning(s).` +
        (bumped ? `\n   theme.json version → ${bumped} (busts the cached stylesheet).` : ''));
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
  node backend/cli/wordjs.js create theme  <slug> [options]    Scaffold a theme (full --wjs-* token contract)
    --primary --secondary --bg --text <#rrggbb>   All 4 together: write a DECLARATIVE theme.json
                                                  (generator "wordjs" + seeds) and compile style.css
                                                  from it instead of copying the static template
    --archetype <name>                            Personality LABEL recorded in theme.json: cyber,
                                                  brutalist, editorial, glassmorphism, organic,
                                                  obsidian. Validated, but emits no CSS and derives
                                                  no token — the look comes from the seeds/tokens
    --name / --author / --description <text>      theme.json metadata (both modes)
  node backend/cli/wordjs.js build theme <slug>                Recompile theme.json → the @wjs-generated
                                                               block in style.css (manual CSS outside the
                                                               markers is preserved; errors → no write)
  node backend/cli/wordjs.js pack <slug> [--build] [--out <dir>]  Zip a plugin for distribution
  node backend/cli/wordjs.js doctor theme <slug>               Lint a theme against the --wjs-* token contract
  node backend/cli/wordjs.js verify theme <slug>               Compare the theme's compiled tokens with the
    --against <stitch.json>                       Stitch design system it was built from (default:
                                                  themes/<slug>/.design/stitch.json). Prints every
                                                  token/expected/actual difference; exits 1 if any

Examples:
  node backend/cli/wordjs.js create plugin my-plugin
  node backend/cli/wordjs.js create theme  my-theme
  node backend/cli/wordjs.js create theme  neon-shop --primary "#7c3aed" --secondary "#0ea5e9" --bg "#0b1020" --text "#e5e7eb" --archetype cyber --name "Neon Shop"
  node backend/cli/wordjs.js build theme  neon-shop
  node backend/cli/wordjs.js pack my-plugin --build
  node backend/cli/wordjs.js doctor theme default
  node backend/cli/wordjs.js verify theme herbario

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
    createTheme(argv[2], argv.slice(3));
} else if (cmd === 'build' && argv[1] === 'theme' && argv[2]) {
    buildTheme(argv[2]);
} else if (cmd === 'pack' && argv[1]) {
    pack(argv[1], argv.slice(2));
} else if (cmd === 'doctor' && argv[1] === 'theme' && argv[2]) {
    doctorTheme(argv[2]);
} else if (cmd === 'import' && argv[1] === 'stitch' && argv[2]) {
    importStitch(argv[2], argv.slice(3));
} else if (cmd === 'verify' && argv[1] === 'theme' && argv[2]) {
    verifyThemeCmd(argv[2], argv.slice(3));
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
    printHelp();
    if (!cmd) process.exit(1);
} else {
    printHelp();
    process.exit(1);
}
