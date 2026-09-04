'use strict';

/**
 * Is `backend/dist/` a faithful compilation of `backend/src/`?
 *
 * Production loads `dist/`, and `dist/` is what the release ZIP and the npm package ship. A compiled
 * file that is missing, older than its source, or left behind after its source was deleted means the
 * artefact behaves differently from the tree everyone reads — and every change made to it since is
 * inert exactly where it matters.
 *
 * That is not hypothetical here. Two audit findings — the per-plugin pool re-enabling
 * `NO_BACKSLASH_ESCAPES` (which turns every parameterised plugin query into an injection point) and
 * `TEXT` capped at `VARCHAR(255)` from a name list — were fixed in `src/` and stayed **exploitable**
 * in any deployment that did not rebuild, because `dist/` still held the older build.
 *
 * WHY THIS FILE EXISTS SEPARATELY: this walk used to live inside
 * `src/tests/dist-mysql-driver-freshness.test.ts`, which documented, in its own header, that it was
 * exported "so the release packaging can make the same check a hard gate" and had **no caller**. So
 * the suite could report the artefact stale while the packaging script happily zipped it, and on a
 * fresh checkout — `dist/` gitignored, never built — the tests skip and check nothing at all. Plain
 * CommonJS, outside `src/`, so `scripts/make-release.js` can require it with no ts-node and no test
 * runner. One walk, two callers: the suite for the developer, the packaging step for the artefact.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ───────────────────────────────────────────────────────
 * The staleness half compares MODIFICATION TIMES, not content. That is enough for the failure it
 * exists to catch — a build that never ran, ran partially, or ran before the last edit — and it would
 * be an overclaim to call it proof that `dist/x.js` IS the compilation of `src/x.ts`:
 *   · Same-second granularity. On a filesystem with coarse mtime, a source edited in the same second
 *     the compiler wrote its output compares as not-older, and reads fresh while being stale. Narrow,
 *     but it is the false-GREEN direction, which is the one that matters in a release gate.
 *   · Touching an output makes it look fresh. Nothing here reads the bytes.
 * The check without those limits records a content hash per source at build time and compares it.
 * That is a larger change than this one, and the distance between the two is small next to the
 * distance between this and what the packaging step had before: nothing.
 *
 * The other two directions — a MISSING output and an ORPHANED one — are content-independent and exact.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
const DIST_ROOT = path.join(BACKEND_ROOT, 'dist');

/**
 * `include: ["src/**\/*"]` minus the `src/…` entries of `exclude` in tsconfig.build.json — READ FROM THAT
 * FILE, not restated here. This used to be a hand-copied `Set([src/tests])`: the day tsconfig.build.json
 * also excluded `src/tests-integration` (so compiled integration tests stop shipping in the release ZIP),
 * this walk kept expecting their outputs and reported the build "incomplete" — two copies of one policy,
 * drifting the moment one moved. One declaration, two consumers. The literal list survives only as the
 * fallback for an unreadable config, so a broken tsconfig fails the build loudly rather than this gate.
 */
function excludedSrcDirs() {
    const fallback = ['tests', 'tests-integration'];
    let dirs = fallback;
    try {
        // tsconfig.build.json carries `//` line comments; strip them (no string value contains `//`).
        const raw = fs.readFileSync(path.join(BACKEND_ROOT, 'tsconfig.build.json'), 'utf8')
            .replace(/^\s*\/\/.*$/gm, '');
        const exclude = JSON.parse(raw).exclude;
        if (Array.isArray(exclude)) {
            const fromConfig = exclude
                .filter((e) => typeof e === 'string' && e.startsWith('src/'))
                .map((e) => e.slice('src/'.length));
            if (fromConfig.length) dirs = fromConfig;
        }
    } catch { /* unreadable config → fallback; the compiler itself will refuse a broken tsconfig */ }
    return new Set(dirs.map((d) => path.join(SRC_ROOT, d)));
}
const EXCLUDED_SRC_DIRS = excludedSrcDirs();

function compiledSources(dir = SRC_ROOT, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDED_SRC_DIRS.has(full)) continue;
            compiledSources(full, acc);
        } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            // Declaration files emit nothing, so they are not part of the population.
            acc.push(full);
        }
    }
    return acc;
}

/** The dist file a source compiles to. */
function distFor(srcFile) {
    return path.join(DIST_ROOT, path.relative(SRC_ROOT, srcFile).replace(/\.ts$/, '.js'));
}

/**
 * EVERY compiled file that is missing from dist/, older than its source, or orphaned in dist/ with no
 * source at all.
 *
 * It ITERATES THE POPULATION rather than naming members. An earlier version enumerated two known-bad
 * files out of 153, and reported green while six others were stale — `dist/models/Post.js` among them,
 * the artefact carrying two of that wave's own fixes. A file added tomorrow is covered the day it is
 * added, with nothing to remember.
 */
function staleCompiledFiles() {
    const missing = [];
    const stale = [];
    const sources = compiledSources();
    const expected = new Set();

    for (const src of sources) {
        const dist = distFor(src);
        expected.add(path.resolve(dist));
        if (!fs.existsSync(dist)) { missing.push(path.relative(BACKEND_ROOT, dist)); continue; }
        if (fs.statSync(dist).mtimeMs < fs.statSync(src).mtimeMs) {
            stale.push(`${path.relative(BACKEND_ROOT, src)} → ${path.relative(BACKEND_ROOT, dist)}`);
        }
    }

    // …AND THE OTHER DIRECTION. The src→dist walk cannot see a compiled file whose SOURCE WAS DELETED:
    // `npm run build` clears dist/ in its prebuild, but `tsc -p tsconfig.build.json` run on its own
    // does not, and loadCore() happily requires whatever is sitting there. A module deleted for a
    // security reason (a route retired, a driver withdrawn) then keeps shipping, and every check above
    // is green.
    const orphaned = [];
    if (fs.existsSync(DIST_ROOT)) {
        const walkDist = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walkDist(full); continue; }
                if (!entry.name.endsWith('.js')) continue;      // .d.ts/.map carry no behaviour
                if (!expected.has(path.resolve(full))) orphaned.push(path.relative(BACKEND_ROOT, full));
            }
        };
        walkDist(DIST_ROOT);
    }

    return { missing, stale, orphaned, checked: sources.length };
}

/**
 * The packaging gate. Throws with the full list when the compiled tree does not match the source
 * tree, so a release aborts instead of zipping an artefact nobody compared against its source.
 *
 * `distMustExist` is deliberately the caller's decision, not this module's: the suite runs on
 * checkouts that have never built and must skip, while the packaging step has just run the compiler
 * and an absent dist/ there means the build silently did nothing.
 */
function assertCompiledTreeIsFresh({ distMustExist = true } = {}) {
    if (!fs.existsSync(DIST_ROOT)) {
        if (!distMustExist) return { skipped: true, reason: 'backend/dist is absent' };
        throw new Error('backend/dist does not exist after the backend build step — the compiled tree production loads was never produced.');
    }

    const { missing, stale, orphaned, checked } = staleCompiledFiles();

    if (checked <= 100) {
        // A population walk that stops seeing the tree would report "nothing stale" forever.
        throw new Error(`the compiled-source walk found only ${checked} files — it is not seeing backend/src, so its verdict means nothing.`);
    }

    const problems = [];
    if (missing.length) {
        problems.push(`${missing.length} compiled file(s) MISSING from dist/ — production would load a tree without them:\n    ${missing.join('\n    ')}`);
    }
    if (stale.length) {
        problems.push(`${stale.length} of ${checked} compiled file(s) are OLDER than their source — every change made to them since is inert in the artefact:\n    ${stale.join('\n    ')}`);
    }
    if (orphaned.length) {
        problems.push(`${orphaned.length} compiled file(s) in dist/ have NO source — deleting the source is not the same as withdrawing the code, and dist/ keeps shipping it:\n    ${orphaned.join('\n    ')}`);
    }

    if (problems.length) {
        throw new Error(
            'The compiled backend does not match its source, so the artefact would not behave like the tree it claims to be:\n  '
            + problems.join('\n  ')
            + '\n  Run `npm run build` in backend/ (its prebuild clears dist/; `tsc -p tsconfig.build.json` on its own does not).');
    }

    return { skipped: false, checked };
}

module.exports = { staleCompiledFiles, assertCompiledTreeIsFresh, BACKEND_ROOT, SRC_ROOT, DIST_ROOT };
