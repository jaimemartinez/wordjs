'use strict';
/**
 * The examples of a release tag never name a real version (FALLOS 134).
 *
 * `--help` said "e.g. v2.1.0" long after 2.10 shipped, and the README carried v2.9.0: a concrete example goes
 * stale with the next release and reads as a recommendation to install an old one. The examples use the
 * placeholder `vX.Y.Z`. A real minimum the CLI states on purpose ("Install v1.6.1 or later" when a bundle
 * predates separate mode) is a fact, not an example, and lives in an error message, not in these texts.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONCRETE_TAG = /\bv\d+\.\d+\.\d+\b/g;

test('--help gives version examples as vX.Y.Z, never a real release', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'index.js'), '--help'], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = `${r.stdout}${r.stderr}`;
    assert.deepStrictEqual(out.match(CONCRETE_TAG) || [], [], 'a concrete release tag in --help goes stale');
    assert.match(out, /--version vX\.Y\.Z/);
});

test('the README gives version examples as vX.Y.Z, never a real release', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.deepStrictEqual(readme.match(CONCRETE_TAG) || [], [], 'a concrete release tag in the README goes stale');
    assert.match(readme, /--version vX\.Y\.Z/);
});

test('the --version error message uses the placeholder too', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'index.js'), 'my-site', '--version'], { encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /e\.g\. vX\.Y\.Z/);
});
