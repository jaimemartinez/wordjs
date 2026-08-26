/**
 * WHAT THE SCANNER SKIPS AND WHAT THE RUNTIME REFUSES MUST BE THE SAME SET.
 *
 * The install-time AST scan walks a package and reads its JavaScript. It skips some directories, and a
 * skipped directory is harmless only while nothing can load code from it. `secure-require` therefore
 * refuses a runtime `require()` into those directories, and its comment claimed it did so "mirroring the
 * scanner's skip so the two cannot diverge".
 *
 * They had diverged, twice, and both were measured by booting a real isolated plugin:
 *
 *   1. The scanner skips HIDDEN directories for plugins; the runtime rule named only
 *      dist/client/frontend. `require('./.assets/payload.js')` loaded and ran code the scanner had never
 *      read. Every dangerous sink that payload reached was still refused at runtime — `process.binding`,
 *      `process.dlopen`, an obfuscated `child_process.spawn`, an eval-built `fs.readFileSync` — so this
 *      was not privilege escalation. It was the difference between a reviewer seeing a plugin's code and
 *      not seeing it, which is what an install-time scan is for.
 *   2. The scanner skips a matching directory at ANY depth; the runtime checked only the first directory
 *      under the plugin slug. `lib/dist/payload.js` was unscanned and requirable.
 *
 * Both sides now read `core/scan-exclusions.ts`. These tests exercise the predicate across the cases
 * that matter in both directions — including the two things that must NOT be blocked, because a guard
 * that over-refuses breaks every plugin with dependencies and is reverted rather than fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const { isScannerSkippedDir, isUnscannedCodePath } = require('../core/scan-exclusions');

const segs = (p: string) => p.split('/');

test('a plugin cannot load code the scanner never read', () => {
    for (const p of [
        'dist/payload.js',
        'client/payload.js',
        'frontend/payload.js',
        'DIST/payload.js',              // case: the scanner's skip is case-sensitive on the name it sees,
        '.assets/payload.js',           // hidden: the first divergence
        '.hidden/nested/payload.js',
        'lib/dist/payload.js',          // any depth: the second divergence
        'a/b/c/.secret/payload.js',
        'src/.build/out.js',
    ]) {
        assert.strictEqual(isUnscannedCodePath(segs(p), false), true,
            `'${p}' is not read by the install scan but the runtime would load it`);
    }
});

test('ordinary plugin code stays requirable', () => {
    for (const p of [
        'index.js',
        'lib/helper.js',
        'src/routes/api.js',
        'handlers/hooks.js',
    ]) {
        assert.strictEqual(isUnscannedCodePath(segs(p), false), false,
            `'${p}' is scanned normally and must remain requirable`);
    }
});

test('dependencies stay requirable — over-blocking breaks every real plugin', () => {
    // node_modules IS skipped by the scanner, and is deliberately NOT refused at runtime: a plugin must
    // be able to require what it depends on. A rule derived naively from "everything the scan skips"
    // would break the entire marketplace, get reverted, and take the rest of the fix with it.
    for (const p of [
        'node_modules/lodash/index.js',
        'node_modules/.bin/thing.js',
        'node_modules/@scope/pkg/dist/index.js',   // a DEPENDENCY's own dist — still its own business
        'lib/node_modules/x/index.js',
    ]) {
        assert.strictEqual(isUnscannedCodePath(segs(p), false), false,
            `'${p}' is a dependency and must stay requirable`);
    }
});

test('themes are scanned in full, so nothing of theirs is refused on this ground', () => {
    for (const p of ['dist/payload.js', '.assets/payload.js', 'lib/dist/x.js', 'functions.js']) {
        assert.strictEqual(isUnscannedCodePath(segs(p), true), false,
            `'${p}' belongs to a theme, whose whole tree is scanned — refusing it would be a rule with no reason`);
    }
});

test('the directory predicate agrees with the runtime one', () => {
    // The scanner walks directory NAMES; the runtime walks path SEGMENTS. Both must classify the same
    // names the same way, or the divergence simply moves to a new place.
    for (const name of ['dist', 'client', 'frontend', '.hidden', '.assets', 'node_modules']) {
        const skipped = isScannerSkippedDir(name, false);
        const refused = isUnscannedCodePath([name, 'x.js'], false);
        if (name.includes('node_modules')) {
            assert.strictEqual(skipped, true, 'node_modules must still be skipped by the scan');
            assert.strictEqual(refused, false, 'node_modules must still be requirable');
            continue;
        }
        assert.strictEqual(skipped, refused,
            `'${name}': the scanner ${skipped ? 'skips' : 'reads'} it but the runtime ${refused ? 'refuses' : 'allows'} it`);
    }
});

test('themes skip only dependencies', () => {
    assert.strictEqual(isScannerSkippedDir('node_modules', true), true);
    for (const name of ['dist', 'client', 'frontend', '.assets']) {
        assert.strictEqual(isScannerSkippedDir(name, true), false,
            `a theme's '${name}' must be scanned — its functions.js can require from any of its own subdirs`);
    }
});
