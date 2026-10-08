/**
 * Plugin stylesheets — the Tailwind utilities a plugin's UI uses, compiled when the plugin is BUILT.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Plugin UIs are written with Tailwind classes (`bg-black/80`, `w-[82%]`, `aspect-[2.6/1]`, …), but a
 * Tailwind class only exists if some stylesheet generated it. In development that stylesheet is the
 * host's own: `next dev` scans backend/plugins (frontend/src/app/globals.css `@source`), so every plugin
 * looks right on the developer's screen. A RELEASE build compiles only the plugins git tracks, and a
 * plugin installed from the marketplace is loaded at runtime from its pre-built dist/*.bundle.js —
 * nothing ever generated the classes only that plugin uses. On a live site those screens rendered with
 * whatever subset of classes the host happened to share: transparent full-screen overlays, a 0×0 aiming
 * frame, bars with no background (the conference-manager meal scanner on an iPhone).
 *
 * So the build compiles them: build-plugin.js runs Tailwind (the v4 already in the repository — a
 * pinned backend devDependency, so every job that builds the catalog has it; no network, no native
 * binary) over the plugin's own sources and writes the result where the host already loads plugin CSS:
 *
 *   admin page  → `client/admin/admin.css` INSIDE THE PACKAGE. Every host links that file on the plugin's
 *                 admin page (generate-admin-plugin-registry.js): released hosts up to 2.3.0 from the
 *                 static /plugins/<folder>/client/admin/admin.css, newer ones from the authenticated
 *                 GET /api/v1/plugins/<slug>/admin-style/css (any signed-in user who can open the page,
 *                 active plugin, no-cache + ETag; routes/plugin-bundles.ts) — so a plugin update alone
 *                 brings the classes to an older site. The package file is the plugin's own
 *                 hand-written admin.css (if it has one), verbatim, followed by the compiled utilities;
 *                 the build writes it to dist/admin.css and the packers ship it at the path the host
 *                 requests (see withPackagedStylesheet). The SOURCE tree is never written to.
 *   editor block → appended to dist/component.bundle.css, which pluginBundleLoader already links.
 *   hooks       → appended to dist/hooks.bundle.css, which pluginBundleLoader links once the hooks
 *                 bundle registers (hooks render inside OTHER admin screens, e.g. the user form).
 *
 * UNSCOPED, BUT ONE SUB-LAYER BELOW THE HOST. The utilities are compiled the way the host compiles its
 * own — same theme (Tailwind's defaults plus the host's `@theme` blocks from globals.css), no preflight
 * (the host has it). Prefixing them with `.plugin-admin-<slug>` would miss every portalled overlay (a
 * modal or scanner mounted on <body> lives outside that wrapper), which is precisely the UI that broke.
 *
 * What they must NOT do is compete with the host's own utilities. In development there is ONE sheet, in
 * Tailwind's order: `.flex` comes before `.md\:hidden`, so `flex md:hidden` hides the mobile header on a
 * desktop. A plugin sheet is a SECOND sheet, linked after the host's: a plain `.flex` in it — same layer,
 * same specificity, later in the document — beat the host's `.md\:hidden`, and the admin shell came out
 * as the phone layout on a desktop (mobile header shown, sidebar fixed over the page, collapse toggle
 * gone; a hooks or block sheet did the same on every admin / public page). So every rule a compiled
 * sheet emits is nested in a sub-layer of the layer it belongs to — `@layer utilities { @layer wjs-plugin
 * { … } }`, likewise theme/properties. A layer's own rules always win over its sub-layers' (CSS Cascade
 * 5), so:
 *   - any class the host also generated keeps the host's rule and the host's order — host chrome is never
 *     restyled by a plugin sheet;
 *   - a class only the plugin uses still applies (no host rule to lose to): the scanner is black, its frame
 *     82% wide, on hosts that never compiled those classes;
 *   - the price, on a host that did not compile the plugin's classes: a plugin-only VARIANT (`sm:p-10`)
 *     loses to a host BASE class (`p-6`) on the same element. A newer host compiles the catalog plugins'
 *     classes itself (globals.css `@source`), in its own order, so there it does not arise.
 * A plugin's own hand-written (unlayered) admin.css still wins over all of it.
 *
 * DETERMINISTIC. The output is a pure function of the plugin's sources, the host theme and the Tailwind
 * version: files are read in sorted order, candidates are sorted, Tailwind sorts its own output, and no
 * timestamp or absolute path is written. verify-marketplace.js --rebuild requires byte-identical zips.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
// The host stylesheet whose `@theme` blocks extend Tailwind's default theme (brand/editor colours,
// font-oswald). Plugins are compiled against the same theme so a class means the same thing in both.
const HOST_GLOBALS_CSS = path.join(REPO_ROOT, 'frontend', 'src', 'app', 'globals.css');
// Where Tailwind is looked up, in order. backend/ first: tailwindcss is a pinned backend
// devDependency, so the CI backend job, plugin-review.yml and release.yml (which all build the catalog)
// have it, and every one of them resolves the SAME copy.
const TAILWIND_BASES = [path.join(REPO_ROOT, 'backend'), path.join(REPO_ROOT, 'frontend'), REPO_ROOT];

/** The path the admin shell requests (and io-guard serves) — what the package must carry. */
const PACKAGED_STYLESHEET = 'client/admin/admin.css';
/** Where build-plugin.js writes that file; the packers move it to PACKAGED_STYLESHEET. */
const BUILT_STYLESHEET = 'dist/admin.css';
/** Opens every compiled block; verify-marketplace.js looks for it to prove the step ran. */
const UTILITIES_MARKER = 'wordjs:plugin-utilities';
/** The sub-layer every compiled rule sits in, below the host's own rules of the same layer. */
const PLUGIN_SUBLAYER = 'wjs-plugin';

// The sources a plugin's UI is written in. CSS files are not scanned (Tailwind does not either).
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
// Never part of the shipped UI: dependencies, build output, tests, dot-folders.
const SKIP_DIR_RE = /^(?:node_modules|dist|__tests__|tests?|\..+)$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

let tailwindCache = null;

/** Tailwind v4's compiler, its package folder and version. Throws a clear message when it is absent. */
function loadTailwind() {
    if (tailwindCache) return tailwindCache;
    for (const base of TAILWIND_BASES) {
        let pkgFile;
        try {
            pkgFile = require.resolve('tailwindcss/package.json', { paths: [base] });
        } catch {
            continue;
        }
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (!/^4\./.test(String(pkg.version))) continue; // the v3 API is a different program
        const compiler = require(require.resolve('tailwindcss', { paths: [base] }));
        if (typeof compiler.compile !== 'function') continue;
        tailwindCache = { compile: compiler.compile, dir: path.dirname(pkgFile), version: pkg.version };
        return tailwindCache;
    }
    throw new Error(
        'Tailwind CSS v4 was not found, so the plugin\'s styles cannot be compiled (its screens would ship '
        + 'without the classes they use). Run `npm install` in backend/ (tailwindcss is a devDependency there).',
    );
}

/**
 * The host's `@theme { … }` blocks, verbatim (comments stripped, LF line endings); '' when it has none.
 * Throws when the host stylesheet cannot be read: compiling without it would silently drop every class
 * built on a host token (`bg-brand-blue`, `text-editor-ink`, `font-oswald`) from the plugin's sheet.
 */
function hostThemeBlocks(file = HOST_GLOBALS_CSS) {
    let css;
    try {
        css = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(
            `plugin stylesheet: cannot read the host stylesheet ${path.relative(REPO_ROOT, file) || file} (${e.code || e.message}). `
            + 'Its @theme tokens define classes the plugin may use; build from a complete WordJS checkout or install.',
            { cause: e },
        );
    }
    css = css.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [];
    const re = /@theme\b[^{;]*\{/g;
    let m;
    while ((m = re.exec(css))) {
        let depth = 1;
        let i = re.lastIndex;
        for (; i < css.length && depth > 0; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
        }
        if (depth !== 0) break; // unbalanced — the host build would fail on it too
        blocks.push(css.slice(m.index, i));
        re.lastIndex = i;
    }
    return blocks.join('\n');
}

/**
 * Every source file under `dir` (absolute paths, sorted), skipping dependencies, build output and
 * tests. Symlinks are not followed: a link could point anywhere on the build machine.
 */
function sourceFilesUnder(dir) {
    const out = [];
    const walk = (abs) => {
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(abs, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIR_RE.test(e.name)) walk(p);
            } else if (e.isFile() && SOURCE_EXT_RE.test(e.name) && !TEST_FILE_RE.test(e.name) && !/\.d\.[cm]?ts$/i.test(e.name)) {
                out.push(p);
            }
        }
    };
    walk(dir);
    return out.sort();
}

/**
 * Class-name candidates in a source text — a deliberately generous superset, like Tailwind's own
 * scanner: anything that is not a valid utility is simply ignored by the compiler, so over-extraction
 * costs nothing but a missed candidate is an unstyled screen. Each whitespace/quote-delimited token is
 * kept whole (arbitrary values such as `shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]` contain `(`, `,`, `=`)
 * AND split on the JSX/JS punctuation that can surround a class name (`className={x}`, `cn(a,b)`),
 * each piece also with its leading/trailing punctuation trimmed. Arbitrary values that contain QUOTES
 * (`content-['']`, `font-['Inter']`, `bg-[url('/a.png')]`) would be cut by that quote split, so they are
 * also collected whole: a token whose `[…]` holds quotes but no whitespace (bounded, so a long
 * whitespace-free run such as an inlined data: URI cannot make the scan quadratic).
 */
const QUOTED_ARBITRARY_RE = /[^\s"'`{}<>;,=()]{0,200}\[[^\]\s]{0,200}['"][^\]\s]{0,200}\][^\s"'`{}<>;,=()]{0,64}/g;
function extractCandidates(text, into = new Set()) {
    const add = (tok) => {
        if (!tok || tok.length > 512) return;
        into.add(tok);
        const trimmed = tok.replace(/^[^A-Za-z0-9\-!@*[]+/, '').replace(/[^A-Za-z0-9\])!%]+$/, '');
        if (trimmed && trimmed !== tok) into.add(trimmed);
    };
    for (const raw of text.split(/[\s"'`\\]+/)) {
        if (!raw) continue;
        add(raw);
        if (/[{}<>;,=()]/.test(raw)) {
            for (const piece of raw.split(/[{}<>;,=()]+/)) add(piece);
        }
    }
    for (const m of text.match(QUOTED_ARBITRARY_RE) || []) add(m);
    return into;
}

/**
 * Index just past the `}` that closes the block opened at `open`, or -1 when it is unbalanced. Comments,
 * strings and escaped characters are skipped: the `{` of `content: "{"` or of `.a\{b` opens nothing.
 */
function blockEnd(css, open) {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        const c = css[i];
        if (c === '\\') { i++; continue; }
        if (c === '/' && css[i + 1] === '*') {
            const e = css.indexOf('*/', i + 2);
            if (e === -1) return -1;
            i = e + 1;
            continue;
        }
        if (c === '"' || c === '\'') {
            for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

/** The first `{` at or after `from` that is not inside a comment, a string or an escape; -1 if none. */
function nextBrace(css, from) {
    for (let i = from; i < css.length; i++) {
        const c = css[i];
        if (c === '\\') { i++; continue; }
        if (c === '/' && css[i + 1] === '*') {
            const e = css.indexOf('*/', i + 2);
            if (e === -1) return -1;
            i = e + 1;
            continue;
        }
        if (c === '"' || c === '\'') {
            for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++;
            continue;
        }
        if (c === '{') return i;
    }
    return -1;
}

/**
 * Nest the body of every top-level `@layer <name> { … }` block in the PLUGIN_SUBLAYER sub-layer, so each
 * rule of a plugin sheet ranks BELOW the host's own rules of the same layer (see the header). Layer
 * statements (`@layer a, b;`), `@property` and `@keyframes` are left as they are.
 */
function nestInPluginLayer(css) {
    let out = '';
    let i = 0;
    for (;;) {
        const open = nextBrace(css, i);
        if (open === -1) return out + css.slice(i);
        const end = blockEnd(css, open);
        if (end === -1) throw new Error('plugin stylesheet: unbalanced braces in the compiled CSS');
        const head = css.slice(i, open);
        out += head;
        if (/@layer\s+[A-Za-z_-][\w-]*\s*$/.test(head)) {
            const body = css.slice(open + 1, end - 1).replace(/^\s*\n/, '').replace(/\s+$/, '');
            const indented = body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
            out += `{\n  @layer ${PLUGIN_SUBLAYER} {\n${indented}\n  }\n}`;
        } else {
            out += css.slice(open, end);
        }
        i = end;
    }
}

/**
 * Compile the Tailwind utilities used by `files` (absolute paths). Returns the CSS block that opens
 * with the UTILITIES_MARKER comment, or '' when there are no files.
 */
async function compileUtilities(files, label) {
    const unique = [...new Set(files)].sort();
    if (unique.length === 0) return '';
    const tailwind = loadTailwind();
    const candidates = new Set();
    for (const f of unique) {
        let text;
        try {
            text = fs.readFileSync(f, 'utf8');
        } catch {
            continue;
        }
        extractCandidates(text, candidates);
    }
    // tailwindcss/index.css WITHOUT its preflight line: the host page already has the reset, and a second
    // copy loaded after the host's own CSS would re-reset everything the host styled in the base layer.
    const input = [
        '@layer theme, base, components, utilities;',
        '@import "tailwindcss/theme.css" layer(theme);',
        '@import "tailwindcss/utilities.css" layer(utilities);',
        hostThemeBlocks(),
    ].join('\n');
    const compiler = await tailwind.compile(input, {
        base: tailwind.dir,
        loadStylesheet: async (id) => {
            const m = /^tailwindcss\/([a-z-]+\.css)$/.exec(id);
            if (!m) throw new Error(`plugin stylesheet: unexpected @import "${id}"`);
            const file = path.join(tailwind.dir, m[1]);
            return { path: file, base: tailwind.dir, content: fs.readFileSync(file, 'utf8') };
        },
        loadModule: async (id) => {
            throw new Error(`plugin stylesheet: @plugin/@config "${id}" is not supported`);
        },
    });
    const css = nestInPluginLayer(compiler.build([...candidates].sort()).replace(/\r\n?/g, '\n').trimEnd());
    return `/*! ${UTILITIES_MARKER} ${label} — the Tailwind CSS v${tailwind.version} utilities this plugin's `
        + 'UI uses, compiled by backend/scripts/build-plugin.js from its sources, one cascade sub-layer '
        + `(${PLUGIN_SUBLAYER}) below the host's own. Generated: do not edit. */\n`
        + `${css}\n`;
}

/**
 * The hand-written part of a plugin stylesheet: everything before the first compiled block. An INSTALLED
 * package's client/admin/admin.css is already "own CSS + compiled utilities"; rebuilding or re-packing
 * that folder (pack:plugin on backend/plugins, the dev "Build & download ZIP") must not stack a second,
 * third… compiled block onto it — each one keeping classes the UI no longer uses.
 */
function handWritten(css) {
    const text = String(css || '').replace(/\r\n?/g, '\n');
    const at = text.indexOf(`/*! ${UTILITIES_MARKER}`);
    return (at === -1 ? text : text.slice(0, at)).replace(/\s+$/, '');
}

/** Absolute source paths of an esbuild metafile's inputs that belong to the plugin (no dependencies). */
function metafileSources(metafile, pluginDir) {
    if (!metafile || !metafile.inputs) return [];
    const root = path.resolve(pluginDir) + path.sep;
    const out = [];
    for (const key of Object.keys(metafile.inputs)) {
        // Namespaced virtual modules (`wjs-react:react`, `wjs-host:lib/api`) are not files. A drive
        // letter (`C:\…`) never appears here: esbuild reports file inputs relative to its cwd.
        if (/^[a-z][\w-]*:/i.test(key) && !/^[a-z]:[\\/]/i.test(key)) continue;
        const abs = path.resolve(process.cwd(), key);
        if (!abs.startsWith(root)) continue;
        if (abs.split(path.sep).includes('node_modules')) continue;
        if (!SOURCE_EXT_RE.test(abs)) continue;
        out.push(abs);
    }
    return out;
}

function readIfExists(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

/** `a` then `b`, separated by exactly one blank line ('' when both are empty). */
function joinCss(a, b) {
    const parts = [a, b].filter((s) => s && s.trim()).map((s) => s.replace(/\s+$/, ''));
    return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/**
 * Write the plugin's compiled stylesheets after its bundles were built.
 *
 * @param {string} pluginDir  the plugin folder
 * @param {string} slug       for the banner only
 * @param {{ admin?: object, component?: object, hooks?: object }} metafiles  esbuild metafile per built entry
 * @returns {string[]} the dist/ files written (relative), for the build log
 */
async function writePluginStylesheets(pluginDir, slug, metafiles) {
    const distDir = path.join(pluginDir, 'dist');
    const written = [];

    // ADMIN: the whole client/ tree (portalled screens, shared kits, hooks rendered on the page) plus
    // whatever the admin bundle pulls in from outside it (e.g. a plugin-level lib/).
    const builtAdmin = path.join(pluginDir, BUILT_STYLESHEET);
    if (metafiles.admin) {
        const files = [...sourceFilesUnder(path.join(pluginDir, 'client')), ...metafileSources(metafiles.admin, pluginDir)];
        const utilities = await compileUtilities(files, `${slug}/admin`);
        const own = handWritten(readIfExists(path.join(pluginDir, PACKAGED_STYLESHEET)));
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(builtAdmin, joinCss(own, utilities));
        written.push(BUILT_STYLESHEET);
    } else {
        fs.rmSync(builtAdmin, { force: true }); // a previous build's, for an admin page that is gone
    }

    // BLOCK and HOOKS: only what each bundle actually contains — a block's CSS reaches public pages.
    for (const name of ['component', 'hooks']) {
        if (!metafiles[name]) continue;
        const utilities = await compileUtilities(metafileSources(metafiles[name], pluginDir), `${slug}/${name}`);
        if (!utilities) continue;
        const file = path.join(distDir, `${name}.bundle.css`);
        // build-plugin.js deletes this file before esbuild runs, so what is here now is esbuild's own
        // extracted CSS for this build (or nothing) — appending is therefore idempotent. handWritten()
        // keeps it so even if a compiled block got here some other way.
        fs.writeFileSync(file, joinCss(handWritten(readIfExists(file)), utilities));
        written.push(`dist/${name}.bundle.css`);
    }
    return written;
}

/**
 * The files a plugin PACKAGE carries, given the plugin folder's files (`rels`, '/'-separated, in the
 * packer's order): when the list holds the build's dist/admin.css, it is shipped AS client/admin/admin.css —
 * replacing the hand-written source in place, or inserted at its sorted position when the plugin has
 * none — and the dist/ copy is not shipped twice. Everything else is passed through unchanged.
 *
 * @returns {{ rel: string, abs: string }[]}
 */
function withPackagedStylesheet(pluginDir, rels) {
    const built = path.join(pluginDir, BUILT_STYLESHEET);
    const hasBuilt = rels.includes(BUILT_STYLESHEET);
    const out = [];
    for (const rel of rels) {
        if (!hasBuilt) {
            out.push({ rel, abs: path.join(pluginDir, rel) });
            continue;
        }
        if (rel === BUILT_STYLESHEET) continue;
        out.push({ rel, abs: rel === PACKAGED_STYLESHEET ? built : path.join(pluginDir, rel) });
    }
    if (hasBuilt && !rels.includes(PACKAGED_STYLESHEET)) {
        const at = out.findIndex((e) => e.rel > PACKAGED_STYLESHEET);
        out.splice(at === -1 ? out.length : at, 0, { rel: PACKAGED_STYLESHEET, abs: built });
    }
    return out;
}

/**
 * withPackagedStylesheet, applied to a STAGED copy of a plugin (pack-plugin.js stages before it scans and
 * zips): moves dist/admin.css over client/admin/admin.css, so the installer checks run on exactly the
 * files the package will carry. Never call it on a source tree. Returns true when it moved the file.
 */
function stagePackagedStylesheet(stageDir) {
    const built = path.join(stageDir, BUILT_STYLESHEET);
    if (!fs.existsSync(built)) return false;
    const dest = path.join(stageDir, PACKAGED_STYLESHEET);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(built, dest);
    return true;
}

module.exports = {
    PACKAGED_STYLESHEET,
    BUILT_STYLESHEET,
    UTILITIES_MARKER,
    PLUGIN_SUBLAYER,
    extractCandidates,
    compileUtilities,
    nestInPluginLayer,
    handWritten,
    loadTailwind,
    hostThemeBlocks,
    sourceFilesUnder,
    writePluginStylesheets,
    withPackagedStylesheet,
    stagePackagedStylesheet,
};
