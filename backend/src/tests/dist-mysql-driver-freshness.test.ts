/**
 * WordJS — the COMPILED tree is what production runs, so it is what must be checked.
 *
 * Audit #2 (the per-plugin pool re-enabling NO_BACKSLASH_ESCAPES, which turns every parameterised
 * plugin query into an injection point) and #13 (TEXT capped at VARCHAR(255) from a name list) were
 * both fixed in src/. They stayed EXPLOITABLE anyway, on this machine and in any deployment that did
 * not rebuild, because `backend/dist/` still held the August build: `LONG_TEXT_COLUMNS`, and
 * `SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION'` in BOTH pools.
 * loadCore() prefers backend/dist/, and dist/ is what the release ZIP and the npm package ship.
 *
 * "We remembered to rebuild" is not a control. This is.
 *
 * ── THE CLASS, AND WHY THE FIRST VERSION OF THIS FILE WAS NOT A GATE ──────────────────────────────
 * THE CLASS: *any* compiled file can be older than its source, and then every change made to it
 * since — a security fix as easily as a typo — is inert in the artefact production loads. The first
 * version enumerated TWO instances of that class (dist/drivers/mysql.js and dist/drivers/
 * mysql-text-rule.js) out of 153 compiled files. That is not a smaller gate, it is a gate with a
 * hole the shape of the whole tree: while it reported green, six other compiled files were stale,
 * `dist/models/Post.js` among them — the artefact carrying two of this wave's own fixes.
 *
 * So the check ITERATES THE POPULATION instead of naming members: every file `npm run build`
 * compiles (src/**\/*.{ts,js} minus src/tests, per tsconfig.build.json) is matched against its
 * dist/ output, and the failure lists ALL of them. A file added tomorrow is covered the day it is
 * added, with nothing to remember.
 *
 * ── A RELEASE GATE THAT PASSES WHEN IT CANNOT RUN ────────────────────────────────────────────────
 * ROUND-3 FINDING (verify3 #52): both tests below used to `return` when dist/ was absent, and
 * node:test counts a test that returns as a PASS. In CI — a fresh checkout, dist/ gitignored, never
 * built — this file therefore reported two green release gates while checking nothing at all. Green
 * by ABSENCE is worse than no test, because it is counted as coverage.
 *
 * They now call `t.skip()`, so the runner reports them under `skipped` and the run's pass count no
 * longer includes a gate that did not execute.
 *
 * TWO THINGS THIS STILL DOES NOT DO, and they are limits, not scope decisions:
 *   · dist/ is gitignored, so on a checkout that has never built there is nothing to compare and
 *     these tests SKIP. Only a run that happens after a build exercises them. The check that would
 *     not have this hole is the packaging step calling staleCompiledFiles() itself.
 *   · `staleCompiledFiles()` is exported for the release packaging and STILL HAS NO CALLER: grepping
 *     the repo for it returns this file and nothing else. Until the script that builds the ZIP/npm
 *     tarball calls it and aborts on a non-empty result, "we remembered to rebuild" is still the
 *     control for anyone who does not run the suite. That wiring lives in scripts/, outside this
 *     file, and is deliberately NOT asserted here — an assertion about a producer that does not
 *     exist would just be another green gate over an open hole.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
const DIST_ROOT = path.join(BACKEND_ROOT, 'dist');
const DIST_MYSQL = path.join(DIST_ROOT, 'drivers', 'mysql.js');
const DIST_RULE = path.join(DIST_ROOT, 'drivers', 'mysql-text-rule.js');

/** Strip comments so an assertion about the CODE is not satisfied (or defeated) by prose about it. */
function codeOnly(js: string): string {
    return String(js)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').map((l: string) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}

/**
 * Everything `npm run build` compiles: `include: ["src/**\/*"]` minus `exclude: [… "src/tests"]`
 * from tsconfig.build.json, with allowJs on (db-admin/*.js, plugin-worker.js are copied through).
 * Declaration files emit nothing, so they are not part of the population.
 */
const EXCLUDED_SRC_DIRS = new Set([path.join(SRC_ROOT, 'tests')]);

function compiledSources(dir: string = SRC_ROOT, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDED_SRC_DIRS.has(full)) continue;
            compiledSources(full, acc);
        } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            acc.push(full);
        }
    }
    return acc;
}

/** The dist file a source compiles to. */
function distFor(srcFile: string): string {
    return path.join(DIST_ROOT, path.relative(SRC_ROOT, srcFile).replace(/\.ts$/, '.js'));
}

/**
 * EVERY compiled file that is missing from dist/ or older than its source. Exported so the release
 * packaging can make the same check a hard gate before it publishes an artefact.
 */
function staleCompiledFiles(): { missing: string[]; stale: string[]; orphaned: string[]; checked: number } {
    const missing: string[] = [];
    const stale: string[] = [];
    const sources = compiledSources();
    const expected = new Set<string>();
    for (const src of sources) {
        const dist = distFor(src);
        expected.add(path.resolve(dist));
        if (!fs.existsSync(dist)) { missing.push(path.relative(BACKEND_ROOT, dist)); continue; }
        if (fs.statSync(dist).mtimeMs < fs.statSync(src).mtimeMs) {
            stale.push(`${path.relative(BACKEND_ROOT, src)} → ${path.relative(BACKEND_ROOT, dist)}`);
        }
    }
    // …AND THE OTHER DIRECTION. The src→dist walk cannot see a compiled file whose SOURCE WAS DELETED:
    // `npm run build` clears dist/ in its prebuild, but `tsc -p tsconfig.build.json` run on its own does
    // not, and loadCore() happily requires whatever is sitting there. A module deleted for a security
    // reason (a route retired, a driver withdrawn) then keeps shipping, and every check above is green.
    const orphaned: string[] = [];
    if (fs.existsSync(DIST_ROOT)) {
        const walkDist = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walkDist(full); continue; }
                if (!entry.name.endsWith('.js')) continue;          // .d.ts/.map carry no behaviour
                if (!expected.has(path.resolve(full))) orphaned.push(path.relative(BACKEND_ROOT, full));
            }
        };
        walkDist(DIST_ROOT);
    }
    return { missing, stale, orphaned, checked: sources.length };
}

test('release gate: the COMPILED mysql driver carries the fixed session mode, not the vulnerable one', (t: any) => {
    if (!fs.existsSync(DIST_MYSQL)) {
        // EXPLICIT skip, not `return`: a returned test is counted as a PASS, and a release gate that
        // reports pass when it could not run is the shape this file exists to remove.
        t.skip('backend/dist is absent (never built on this checkout) — nothing is shipped, nothing to check');
        return;
    }
    const code = codeOnly(fs.readFileSync(DIST_MYSQL, 'utf8'));

    assert.doesNotMatch(code, /NO_BACKSLASH_ESCAPES/,
        'dist/drivers/mysql.js still installs NO_BACKSLASH_ESCAPES — mysql2 escapes with backslashes, so the fix for audit #2 is inert in the artefact production loads. Run `npm run build` in backend/.');
    assert.match(code, /SESSION_SQL_MODE\s*=\s*'ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'/,
        'the compiled driver must carry the ONE session mode constant both pools install');
    // Both pools take the mode FROM that constant. Any `SET SESSION sql_mode=` in the artefact must
    // therefore interpolate it; a spelled-out mode list is the drift that WAS the bug.
    const modeStatements = code.match(/SET SESSION sql_mode='[^']*'/g) || [];
    const spelledOut = modeStatements.filter((s: string) => !s.includes('${SESSION_SQL_MODE}'));
    assert.deepStrictEqual(spelledOut, [],
        `a hard-coded sql_mode literal is back in the compiled driver (${spelledOut.join(' | ')}) — two declarations, two behaviours, one seam: that drift IS the bug`);
    assert.doesNotMatch(code, /LONG_TEXT_COLUMNS/,
        'the compiled driver still decides the TEXT type from a hard-coded column-name list (audit #13). Run `npm run build`.');
    assert.ok(fs.existsSync(DIST_RULE),
        'dist/drivers/mysql-text-rule.js is missing — the compiled driver cannot load the shared rule it now requires');
});

test('release gate: EVERY compiled file is present and no older than its source (stale dist detector)', (t: any) => {
    if (!fs.existsSync(DIST_ROOT)) {
        t.skip('backend/dist is absent (never built on this checkout) — nothing is shipped, nothing to check');
        return;
    }

    const { missing, stale, orphaned, checked } = staleCompiledFiles();
    assert.ok(checked > 100, `the population walk found only ${checked} compiled sources — it is not seeing the tree`);

    assert.deepStrictEqual(missing, [],
        `dist/ exists but ${missing.length} compiled file(s) are missing from it — the build is incomplete, so production would load a tree that does not have them:\n  ${missing.join('\n  ')}\nRun \`npm run build\` in backend/.`);

    assert.deepStrictEqual(stale, [],
        `${stale.length} of ${checked} compiled file(s) are OLDER than their source. Production loads dist/, so every change made to them since is INERT there — this is exactly how audit #2 and #13 stayed exploitable after being fixed:\n  ${stale.join('\n  ')}\nRun \`npm run build\` in backend/.`);

    assert.deepStrictEqual(orphaned, [],
        `${orphaned.length} compiled file(s) in dist/ have NO source. loadCore() prefers dist/, so a module whose source was deleted keeps shipping and keeps being loaded — deleting the source is not the same as withdrawing the code:\n  ${orphaned.join('\n  ')}\nRun \`npm run build\` in backend/ (its prebuild clears dist/); \`tsc -p tsconfig.build.json\` on its own does not.`);
});

module.exports = { staleCompiledFiles };
