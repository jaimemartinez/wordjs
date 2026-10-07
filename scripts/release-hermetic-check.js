/**
 * WordJS — DID THE RELEASE FRONTEND BUILD READ A LIVE BACKEND?
 *
 * `next build` prerenders the public pages, and every server-side read it makes during that render is
 * a request to a backend. CI builds from a clean checkout with nothing listening, so those reads fail
 * and the shipped pages carry the defaults. A release packaged on a developer machine used to read
 * the dev backend running there instead and ship private content from that running dev backend: its
 * site title on every prerendered page, its posts as prerendered paths. `make-release.js` now builds
 * hermetically (cleared `.next/cache`, `WORDJS_HERMETIC_BUILD=1` — see frontend/hermetic-build.js);
 * this module checks the OUTPUT, because "the build was told not to" is a statement about intent and
 * the artifact is what gets published.
 *
 * Each check looks for a trace only a backend that ANSWERED can leave:
 *
 *   1. FETCH CACHE. Next stores every successful cacheable server-side fetch of a build under
 *      `.next/cache/fetch-cache`. The packager deletes that directory before building, and in a
 *      hermetic build every backend read fails, so ANY entry is a read that succeeded.
 *   2. PATHS FROM DATA. `generateStaticParams` asks the backend for slugs; with no backend it returns
 *      nothing. A prerendered route generated from a dynamic route (`/[slug]` → `/some-post`) is a list
 *      of the packaging machine's content.
 *   3. TITLES. With no settings the root layout titles every page `WordJS` (or `<page> | WordJS`, its
 *      template). Any other title on a prerendered page is a site name that came from somewhere.
 *   4. API REWRITES. The `/api`, `/uploads`, … rewrites are baked into `.next/routes-manifest.json`, so
 *      they must be the compiled-in default (`http://localhost:3000`), not this machine's gatewayPort,
 *      WORDJS_BACKEND_URL or monolith setting.
 *   5. PLUGINS. The prebuild registries (frontend/scripts/generate-*-registry.js) decide which plugin
 *      code `next build` compiles into .next. Every plugin module they import must be one git tracks:
 *      anything else is a local or private plugin of the packaging machine, which would ship compiled
 *      even though its sources are dropped from the zip (see frontend/scripts/hermetic-plugins.js).
 *
 * A check that cannot look fails closed: a missing manifest or registry, or a prerendered page whose
 * HTML is not where the title check reads it, is a finding — never a silent pass.
 *
 * Pure functions over a frontend directory, so the test suite drives them against fake build output
 * instead of running `next build`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULT_PROXY_TARGET, rewriteSources } = require('../frontend/backend-proxy-target.js');

/**
 * The site name the root layout falls back to when settings are unavailable — `settings?.blogname ||
 * "WordJS"` in frontend/src/app/layout.tsx. A test pins the two together.
 */
const DEFAULT_SITE_NAME = 'WordJS';

/** At most this many examples per finding: enough to act on, short enough to read. */
const MAX_EXAMPLES = 5;

/**
 * The generated plugin registries, relative to the frontend dir — where the prebuild generators write
 * them (a test pins each path to its generator).
 */
const PLUGIN_REGISTRIES = [
    'src/lib/pluginRegistry.ts',
    'src/lib/versoPluginRegistry.ts',
    'src/app/admin/plugin/[slug]/page.tsx',
];

/** The extensions a registry's extension-less import specifier can resolve to. */
const MODULE_SUFFIXES = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'];

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function listFiles(dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out; // absent: nothing was cached
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(full));
        else out.push(full);
    }
    return out;
}

function examples(items, max = MAX_EXAMPLES) {
    const shown = items.slice(0, max).map((s) => `      - ${s}`);
    if (items.length > max) shown.push(`      - … and ${items.length - max} more`);
    return shown.join('\n');
}

/** 1. Every successful build-time fetch Next cached. */
function fetchCacheFindings(nextDir) {
    const files = listFiles(path.join(nextDir, 'cache', 'fetch-cache'));
    if (!files.length) return [];
    const urls = files.map((f) => {
        const entry = readJson(f);
        const url = entry && entry.data && entry.data.url;
        return url ? `GET ${url}` : path.relative(nextDir, f).replace(/\\/g, '/');
    });
    return [
        `${files.length} server-side fetch(es) SUCCEEDED during the build (cached in .next/cache/fetch-cache):\n${examples(urls)}`,
    ];
}

/** The prerendered page HTML for a route, as Next lays it out under .next/server/app. */
function prerenderedHtmlPath(nextDir, route) {
    const rel = route === '/' ? 'index' : route.replace(/^\//, '');
    return path.join(nextDir, 'server', 'app', `${rel}.html`);
}

/** The first <title> of a document, or null. Entities are left alone — the default name has none. */
function documentTitle(html) {
    const m = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
    return m ? m[1].trim() : null;
}

function isDefaultTitle(title) {
    return title === DEFAULT_SITE_NAME || title.endsWith(` | ${DEFAULT_SITE_NAME}`);
}

/** 2 + 3. Paths generated from backend data, and titles that are not the default site name. */
function prerenderFindings(nextDir) {
    const manifest = readJson(path.join(nextDir, 'prerender-manifest.json'));
    if (!manifest || typeof manifest.routes !== 'object' || !manifest.routes) {
        return ['.next/prerender-manifest.json is missing or unreadable — cannot prove the prerender is clean'];
    }
    const dynamicRoutes = new Set(Object.keys(manifest.dynamicRoutes || {}));
    const fromData = [];
    const titled = [];
    const unread = [];
    for (const [route, info] of Object.entries(manifest.routes)) {
        const src = info && info.srcRoute;
        if (src && src !== route && dynamicRoutes.has(src)) fromData.push(`${route}  (from ${src})`);

        // Route handlers (feeds, robots) have no HTML document, and Next lists them without a
        // dataRoute. A PAGE (it has one) always has its HTML here; when it does not, the title check
        // would be checking nothing — a Next upgrade that moved the output must fail, not pass.
        const htmlPath = prerenderedHtmlPath(nextDir, route);
        let html;
        try {
            html = fs.readFileSync(htmlPath, 'utf8');
        } catch {
            if (info && info.dataRoute) unread.push(`${route}  (expected ${path.relative(nextDir, htmlPath).replace(/\\/g, '/')})`);
            continue;
        }
        // Next's own error shell (`__next_error__`) is rendered without the app's layout and never
        // reads settings.
        if (html.includes('id="__next_error__"')) continue;
        const title = documentTitle(html);
        if (title !== null && !isDefaultTitle(title)) titled.push(`${route}  <title>${title}</title>`);
    }
    const out = [];
    if (unread.length) {
        out.push(`${unread.length} prerendered page(s) have no prerendered HTML where the title check reads it — cannot prove their titles are the default:\n${examples(unread)}`);
    }
    if (fromData.length) {
        out.push(`${fromData.length} path(s) were prerendered from generateStaticParams, i.e. from a backend's content list:\n${examples(fromData)}`);
    }
    if (titled.length) {
        out.push(`${titled.length} prerendered page(s) carry a title other than the default "${DEFAULT_SITE_NAME}":\n${examples(titled)}`);
    }
    return out;
}

/** 4. The baked backend rewrites must be the compiled-in default, one per proxied prefix. */
function rewriteFindings(nextDir) {
    const manifest = readJson(path.join(nextDir, 'routes-manifest.json'));
    if (!manifest) return ['.next/routes-manifest.json is missing or unreadable — cannot check the baked API rewrites'];
    const r = manifest.rewrites;
    const all = Array.isArray(r) ? r : [...((r && r.beforeFiles) || []), ...((r && r.afterFiles) || []), ...((r && r.fallback) || [])];
    const wrong = [];
    for (const source of rewriteSources()) {
        const expected = `${DEFAULT_PROXY_TARGET}${source}`;
        const found = all.filter((x) => x && x.source === source);
        if (!found.length) wrong.push(`${source}  → (no rewrite; expected ${expected})`);
        for (const x of found) if (x.destination !== expected) wrong.push(`${source}  → ${x.destination}  (expected ${expected})`);
    }
    return wrong.length
        // All of them: the list is bounded by PROXIED_PREFIXES, and a partial one hides which half broke.
        ? [`the baked backend rewrites are not the compiled-in default:\n${examples(wrong, Infinity)}`]
        : [];
}

/** Every relative import specifier in a generated registry. */
function importSpecifiers(source) {
    const out = [];
    const re = /(?:\bimport\s*\(\s*|\bfrom\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
    let m;
    while ((m = re.exec(source))) out.push(m[2]);
    return out;
}

/**
 * 5. Every plugin module the registries import, checked against git.
 * @returns {{ findings: string[], checked: number }}
 */
function pluginRegistryFindings(frontendDir, trackedFiles) {
    const findings = [];
    const untracked = [];
    let checked = 0;
    for (const registry of PLUGIN_REGISTRIES) {
        let source;
        try {
            source = fs.readFileSync(path.join(frontendDir, registry), 'utf8');
        } catch {
            findings.push(`frontend/${registry} is missing — cannot check which plugins the build compiled in`);
            continue;
        }
        if (trackedFiles === null) continue; // no git: the caller reports the skip
        const registryDir = path.posix.dirname(`frontend/${registry}`);
        for (const spec of importSpecifiers(source)) {
            const target = path.posix.normalize(path.posix.join(registryDir, spec));
            if (!target.startsWith('backend/plugins/')) continue;
            checked++;
            if (!MODULE_SUFFIXES.some((suffix) => trackedFiles.has(target + suffix))) {
                untracked.push(`${target}  (imported by frontend/${registry})`);
            }
        }
    }
    if (untracked.length) {
        findings.push(
            `${untracked.length} plugin module(s) compiled into this build are not tracked by git — a local or private plugin's code would ship inside .next:\n${examples(untracked)}`,
        );
    }
    return { findings, checked };
}

/**
 * @param {{ trackedFiles?: Set<string> | null }} options
 * @returns {Set<string> | null}
 */
function requireTrackedFiles(options) {
    const trackedFiles = options && options.trackedFiles;
    // Explicit on purpose: an omitted argument must not read as "git unavailable" and skip the check.
    if (trackedFiles !== null && !(trackedFiles instanceof Set)) {
        throw new TypeError(
            'release-hermetic-check: pass { trackedFiles } — the repo-relative paths git tracks, or null when git is unavailable',
        );
    }
    return trackedFiles;
}

function collect(frontendDir, trackedFiles) {
    const nextDir = path.join(frontendDir, '.next');
    const plugins = pluginRegistryFindings(frontendDir, trackedFiles);
    return {
        violations: [
            ...fetchCacheFindings(nextDir),
            ...prerenderFindings(nextDir),
            ...rewriteFindings(nextDir),
            ...plugins.findings,
        ],
        pluginModules: trackedFiles === null ? null : plugins.checked,
    };
}

/**
 * Every trace of a live backend, or of a plugin git does not track, in a frontend build output.
 * Empty means the output is what a clean, backend-less CI build produces.
 * @param {string} frontendDir the frontend workspace (the one holding `.next`)
 * @param {{ trackedFiles: Set<string> | null }} options the repo-relative paths git tracks; null when
 *   git is unavailable, which skips ONLY the plugin-module check (the registries must still exist)
 * @returns {string[]}
 */
function findHermeticBuildViolations(frontendDir, options) {
    return collect(frontendDir, requireTrackedFiles(options)).violations;
}

/**
 * Throw — aborting the release — when the frontend build shows any trace of a live backend or of a
 * plugin git does not track.
 * @param {string} frontendDir
 * @param {{ trackedFiles: Set<string> | null }} options see findHermeticBuildViolations
 * @returns {{ prerendered: number, pluginModules: number | null }} a summary for the packager's log;
 *   pluginModules is null when the plugin check was skipped for lack of git
 */
function assertHermeticFrontendBuild(frontendDir, options) {
    const { violations, pluginModules } = collect(frontendDir, requireTrackedFiles(options));
    if (violations.length) {
        throw new Error(
            'the frontend build is NOT hermetic — its prerendered output came from a live backend, ' +
                'so this bundle would ship that backend\'s content. Do NOT publish it.\n' +
                violations.map((v) => `   • ${v}`).join('\n') +
                '\n   The packager clears frontend/.next/cache and builds with WORDJS_HERMETIC_BUILD=1, which ' +
                'points every server-side read at a backend fetch() refuses (frontend/hermetic-build.js). ' +
                'A finding here means some build-time read did not go through that — a fetch that does not ' +
                'use resolveServerBase()/api.ts, or a config read that ignores the flag. Fix that read; ' +
                'stopping the local backend only hides it. An untracked plugin module means a registry ' +
                'generator did not keep to the plugins git tracks (frontend/scripts/hermetic-plugins.js).',
        );
    }
    const manifest = readJson(path.join(frontendDir, '.next', 'prerender-manifest.json'));
    return { prerendered: Object.keys((manifest && manifest.routes) || {}).length, pluginModules };
}

module.exports = { DEFAULT_SITE_NAME, PLUGIN_REGISTRIES, findHermeticBuildViolations, assertHermeticFrontendBuild };
