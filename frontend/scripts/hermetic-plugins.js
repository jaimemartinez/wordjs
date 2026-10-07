/**
 * WordJS — WHICH PLUGINS A RELEASE BUILD COMPILES IN.
 *
 * The prebuild generators beside this file (generate-plugin-registry.js,
 * generate-admin-plugin-registry.js, generate-verso-plugin-registry.js) turn backend/plugins/* into
 * the registries the frontend imports, and `next build` compiles every plugin a registry references
 * into .next. For the dev loop they take the plugins the running backend reports as active (passed in
 * WORDJS_ACTIVE_PLUGINS, or asked at http://localhost:3000) and fall back to every folder on disk.
 * In a release build both answers come from the packaging machine:
 *   · the dev site's active set decides which plugins the release can load at all (PRODUCTION_PLUGINS
 *     in pluginRegistry.ts), so a plugin inactive on that dev site is missing from the release;
 *   · "every folder on disk" includes untracked and gitignored private plugins, whose code then ships
 *     compiled inside .next even though the packager drops their sources from the zip.
 * CI builds from a clean checkout: nothing answers the query and the folders on disk are exactly the
 * ones git tracks. Under WORDJS_HERMETIC_BUILD=1 the generators reach that same answer on any
 * machine — they ask no backend, read no WORDJS_ACTIVE_PLUGINS, and keep only the folders whose
 * manifest.json git tracks. scripts/release-hermetic-check.js then checks the generated registries
 * against git, because the artifact is what gets published.
 *
 * Without git (a tree with no .git, like the Docker build context) tracked and local cannot be told
 * apart: every folder is kept and the build says so — the same fallback, with the same warning, as the
 * packager's own "untracked does not ship" rule in scripts/make-release.js.
 *
 * Kept out of frontend/hermetic-build.js on purpose: that module is imported by src/lib/api.ts, which
 * is also client code, and must not pull child_process into a browser bundle.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const { isHermeticBuild } = require('../hermetic-build.js');

/**
 * The plugin folders under `pluginsDir` whose manifest.json git tracks, or null when git cannot say
 * (not installed, not a work tree).
 * @param {string} pluginsDir
 * @returns {Set<string> | null}
 */
function gitTrackedPluginFolders(pluginsDir) {
    let out;
    try {
        // Run from the plugins dir: ls-files lists only what is under it, relative to it.
        out = execFileSync('git', ['ls-files', '-z'], {
            cwd: pluginsDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    }
    const folders = new Set();
    for (const file of out.split('\0')) {
        const m = /^([^/]+)\/manifest\.json$/.exec(file);
        if (m) folders.add(m[1]);
    }
    return folders;
}

/**
 * The plugin selection a generator must use.
 *
 * @param {string} pluginsDir the directory the generator discovers plugins in
 * @param {{ env?: Record<string, string|undefined>, listTracked?: (dir: string) => Set<string> | null,
 *           log?: (line: string) => void }} [options] injectable for tests
 * @returns {null | { includes: (folder: string) => boolean }} null outside a release build (the
 *   generator's own dev-loop selection applies). In a release build, the folder filter — and the
 *   generator must not ask any backend or read WORDJS_ACTIVE_PLUGINS.
 */
function releasePluginSelection(pluginsDir, options = {}) {
    const { env = process.env, listTracked = gitTrackedPluginFolders, log = console.log } = options;
    if (!isHermeticBuild(env)) return null;

    // Nothing to filter, and nothing to ask git about.
    if (!fs.existsSync(pluginsDir)) return { includes: () => false };

    const tracked = listTracked(pluginsDir);
    if (!tracked) {
        log('   ⚠️  Release build, but git is unavailable — cannot tell tracked plugins from local ones;');
        log('      including every plugin folder on disk. Review the build before publishing it.');
        return { includes: () => true };
    }
    log(`   🔒 Release build: only the ${tracked.size} plugin(s) git tracks; no backend is asked which are active`);
    return { includes: (folder) => tracked.has(folder) };
}

module.exports = { releasePluginSelection, gitTrackedPluginFolders };
