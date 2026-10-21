/**
 * THE CORE SHIPS NO PLUGIN.
 *
 * A fresh install used to list two plugins nobody installed: a sample (`[hello]` shortcode) and a test
 * fixture that creates a table on activation. Both sat in backend/plugins/, which is where INSTALLED
 * plugins live, so every checkout, release ZIP and Docker image carried them into the admin's plugin
 * list. The sample now lives in documentation/examples/plugins/, and tests that need a plugin on disk
 * write their own.
 *
 * These checks are structural — no plugin is named — so the next one dropped into backend/plugins/ in
 * a commit fails here, whatever it is called:
 *   1. git tracks nothing inside a backend/plugins/<slug>/ folder;
 *   2. the release packager drops any backend/plugins/<slug>/ path even when git cannot answer;
 *   3. the plugin scan of a fresh checkout (backend/plugins/ exactly as git has it) finds nothing.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '../..');
const ROOT = path.resolve(BACKEND, '..');
const { shouldIgnore, INSTALLED_PLUGIN_RE, ROOT_DIR } = require('../../../scripts/make-release.js');

/** What git tracks under backend/plugins/, or null where git cannot answer (an archive extraction). */
function trackedPluginFiles(): string[] | null {
    const r = spawnSync('git', ['ls-files', '-z', '--', 'backend/plugins'], { cwd: ROOT });
    if (r.status !== 0 || !r.stdout) return null;
    const all = spawnSync('git', ['ls-files', '-z', '--', 'backend/package.json'], { cwd: ROOT });
    if (all.status !== 0 || !all.stdout || !all.stdout.length) return null;   // not a work tree
    return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

function gitOrSkip(t: any): string[] | null {
    const files = trackedPluginFiles();
    if (files) return files;
    // CI checks the repo out WITH git: a missing work tree there is a broken checkout, not a skip.
    assert.ok(!process.env.CI, 'CI checks the repo out WITH git: this gate must not self-skip here');
    t.skip('git cannot list the work tree here');
    return null;
}

test('git tracks no plugin inside backend/plugins/ (only the folder README)', (t: any) => {
    const files = gitOrSkip(t);
    if (!files) return;
    const inPluginFolders = files.filter((f) => INSTALLED_PLUGIN_RE.test(f));
    assert.deepStrictEqual(inPluginFolders, [],
        'a plugin committed to backend/plugins/ is listed by every fresh install — ship it through the marketplace, '
        + 'or as an example under documentation/examples/plugins/');
});

test('the release packager drops any backend/plugins/<slug>/ path, with or without git', () => {
    for (const rel of [
        'backend/plugins/any-slug/manifest.json',
        'backend/plugins/any-slug/index.js',
        'backend/plugins/another/client/admin/Page.tsx',
    ]) {
        assert.ok(INSTALLED_PLUGIN_RE.test(rel), rel);
        assert.strictEqual(shouldIgnore(path.join(ROOT_DIR, ...rel.split('/'))), true, `${rel} must not ship`);
    }
    // The folder itself and its README are not plugin paths (the README keeps the folder in the package).
    assert.ok(!INSTALLED_PLUGIN_RE.test('backend/plugins/README.md'));
    assert.ok(!INSTALLED_PLUGIN_RE.test('backend/src/core/plugins.ts'));
});

test('a fresh checkout lists no plugin: scanPlugins() over backend/plugins/ as git has it is empty', (t: any) => {
    const files = gitOrSkip(t);
    if (!files) return;
    // Materialise backend/plugins/ exactly as a fresh clone (and therefore the release) has it…
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-fresh-plugins-'));
    try {
        for (const rel of files) {
            const dest = path.join(cwd, 'plugins', path.relative('backend/plugins', rel));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(ROOT, rel), dest);
        }
        fs.mkdirSync(path.join(cwd, 'plugins'), { recursive: true });
        // …and run the real scan against it. core/plugins resolves its folder from the process cwd
        // (monolith.js chdir()s into backend/), so a child started in the temp dir sees only that copy.
        const script = `const { scanPlugins } = require(${JSON.stringify(path.join(BACKEND, 'src', 'core', 'plugins.ts'))});`
            + `process.stdout.write('\\n@@' + JSON.stringify(scanPlugins().map((p) => p.slug)) + '@@\\n');`
            + `process.exit(0);`;
        const r = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', script], {
            cwd, encoding: 'utf8', timeout: 120_000,
            env: { ...process.env, TS_NODE_PROJECT: path.join(BACKEND, 'tsconfig.json') },
        });
        const m = /@@(.*)@@/.exec(r.stdout || '');
        assert.ok(m, `the scan did not report (status ${r.status}): ${(r.stderr || '').slice(-800)}`);
        assert.deepStrictEqual(JSON.parse(m![1]), [], 'a fresh install must list no plugin');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
