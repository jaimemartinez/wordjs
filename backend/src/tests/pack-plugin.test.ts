/**
 * Guards `npm run pack:plugin` (backend/scripts/pack-plugin.js).
 *
 * WHAT THIS LOCKS DOWN: the ZIP it writes is the one the installer accepts — a single `<slug>/` root
 * with the plugin's code and none of the local state (`data/`), working `node_modules/` or OS junk — and
 * the npm dependencies are settled without any flag: by default they are declared in the packed manifest
 * so the server installs them on activation; a bundled plugin (or one needing a package the server will
 * not auto-install) ships a fresh production-only node_modules. It also proves the script refuses, before
 * writing anything, what the installer would refuse and what would only fail after upload.
 *
 * Dependencies are local tarballs (`file:/…/x.tgz`), so nothing here touches the npm registry.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { spawnSync } = require('child_process');

const PACK = path.resolve(__dirname, '../../scripts/pack-plugin.js');
const { packageName } = require(PACK);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tmp(prefix: string) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(d);
    return d;
}

/** A local npm tarball for package `name`, so installs stay offline. */
function tarball(name: string) {
    const src = path.join(tmp('pack-dep-'), name);
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(src, 'index.js'), 'module.exports = 42;\n');
    const r = spawnSync(NPM, ['pack', '--silent', '--pack-destination', path.dirname(src)], { cwd: src, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.strictEqual(r.status, 0, r.stderr);
    return path.join(path.dirname(src), r.stdout.trim().split('\n').pop());
}

function fixture(slug: string, manifest: object, indexJs: string, pkg?: object) {
    const root = tmp('pack-plugin-');
    const dir = path.join(root, 'plugins', slug);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'stale'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), indexJs);
    fs.writeFileSync(path.join(dir, 'lib', 'util.js'), 'module.exports = 1;\n');
    // A test may require a dev-only package; that must not count as a runtime dependency.
    fs.writeFileSync(path.join(dir, 'tests', 'x.test.js'), "require('some-dev-only-tool');\n");
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), '{"secret":true}');
    fs.writeFileSync(path.join(dir, 'node_modules', 'stale', 'index.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return { plugins: path.join(root, 'plugins'), out: path.join(root, 'out') };
}

function run(args: string[]) {
    return spawnSync(process.execPath, [PACK, ...args], { encoding: 'utf8', timeout: 180000 });
}

function packOk(slug: string, f: { plugins: string; out: string }, version = '1.2.3') {
    const r = run([slug, '--dir', f.plugins, '--out', f.out]);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const zip = new AdmZip(path.join(f.out, `${slug}-${version}.zip`));
    const names = zip.getEntries().map((e: any) => e.entryName).sort();
    const manifest = JSON.parse(zip.readAsText(`${slug}/manifest.json`));
    return { names, manifest, output: r.stdout + r.stderr };
}

const MANIFEST = { name: 'Packed', version: '1.2.3', isolated: true, permissions: [] };
const OK_INDEX = "module.exports = { init() {} };\n";

test('pack:plugin writes <slug>-<version>.zip with a single slug root and no local state', () => {
    const f = fixture('packed', MANIFEST, OK_INDEX);
    const { names, manifest } = packOk('packed', f);
    assert.deepStrictEqual(names, ['packed/index.js', 'packed/lib/util.js', 'packed/manifest.json', 'packed/tests/x.test.js']);
    assert.deepStrictEqual(manifest, MANIFEST, 'manifest untouched when there is nothing to declare');
});

test('shared dependencies: package.json deps go into the manifest for the server to install, node_modules stays out', () => {
    const f = fixture('shared', { ...MANIFEST, dependencies: { 'already-declared': '^2.0.0' } },
        "const a = require('left-pad'); const b = require('@acme/util/sub'); module.exports = { init() {} };\n",
        { name: 'shared', dependencies: { 'left-pad': '^1.3.0', '@acme/util': '^1.0.0' }, devDependencies: { mocha: '^10.0.0' } });
    const { names, manifest } = packOk('shared', f);
    assert.ok(!names.some((n: string) => n.includes('node_modules')), 'no node_modules shipped');
    assert.deepStrictEqual(manifest.dependencies, { 'left-pad': '^1.3.0', '@acme/util': '^1.0.0', 'already-declared': '^2.0.0' });
    assert.strictEqual(manifest.bundled, undefined);
});

test('a required package declared nowhere is refused; one the server already has only warns', () => {
    const missing = fixture('missing', MANIFEST, "require('definitely-not-declared-pkg');\n");
    const r = run(['missing', '--dir', missing.plugins, '--out', missing.out]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /requires 'definitely-not-declared-pkg', which is not declared/);
    assert.ok(!fs.existsSync(missing.out), 'nothing written');

    const host = fixture('host', MANIFEST, "require('adm-zip');\n");
    const { output } = packOk('host', host);
    assert.match(output, /'adm-zip'.*server already has it/);
});

test('bundled plugin ships a fresh production-only node_modules, never dev dependencies', () => {
    const prod = tarball('prod-dep');
    const dev = tarball('dev-dep');
    const f = fixture('bundled', { ...MANIFEST, bundled: true }, "require('prod-dep'); module.exports = { init() {} };\n",
        { name: 'bundled', dependencies: { 'prod-dep': `file:${prod}` }, devDependencies: { 'dev-dep': `file:${dev}` } });
    const { names, manifest } = packOk('bundled', f);
    assert.ok(names.includes('bundled/node_modules/prod-dep/index.js'), names.join('\n'));
    assert.ok(!names.some((n: string) => n.includes('dev-dep')), 'dev dependency not shipped');
    assert.ok(!names.some((n: string) => n.includes('node_modules/stale')), 'working node_modules not copied');
    assert.strictEqual(manifest.bundled, true);
});

test('a package the server refuses to auto-install switches the plugin to bundled on its own', () => {
    const fakeSharp = tarball('sharp');
    const f = fixture('native', MANIFEST, "require('sharp');\n", { name: 'native', dependencies: { sharp: `file:${fakeSharp}` } });
    const { names, manifest, output } = packOk('native', f);
    assert.match(output, /sharp cannot be installed by the server/);
    assert.strictEqual(manifest.bundled, true);
    assert.ok(names.includes('native/node_modules/sharp/index.js'));
});

test('pack:plugin refuses what the installer would refuse, and writes nothing', () => {
    const cases: Array<[string, object, string, RegExp]> = [
        ['not-isolated', { name: 'X', isolated: false }, OK_INDEX, /isolated/],
        ['no-name', { isolated: true }, OK_INDEX, /name/],
        ['wrong-id', { id: 'other', name: 'X', isolated: true }, OK_INDEX, /does not match/],
        ['blocked', MANIFEST, "require('child_process').execSync('id');\n", /child_process/],
    ];
    for (const [slug, manifest, indexJs, reason] of cases) {
        const f = fixture(slug, manifest, indexJs);
        const r = run([slug, '--dir', f.plugins, '--out', f.out]);
        assert.notStrictEqual(r.status, 0, `${slug} must be refused`);
        assert.match(r.stderr + r.stdout, reason, slug);
        assert.ok(!fs.existsSync(f.out), `${slug}: nothing written`);
    }
});

test('pack:plugin refuses non-registry dependency specs the server would have to npm-install', () => {
    // C1: npm runs the `prepare` script of a git/file dependency even under --ignore-scripts, and an
    // npm: alias or a tarball URL installs unscanned code under another name. The installer refuses
    // all of them; the packer must not produce a ZIP that the installer would refuse.
    const cases: Array<[string, object, object | undefined]> = [
        ['dep-file', { ...MANIFEST, dependencies: { x: 'file:../evil' } }, undefined],
        ['dep-alias', { ...MANIFEST, dependencies: { lodash: 'npm:evil@1' } }, undefined],
        // A shared plugin's package.json dependencies are folded into the manifest the server installs.
        ['dep-git-pkg', MANIFEST, { name: 'dep-git-pkg', dependencies: { x: 'git+https://example.com/x.git' } }],
        ['dep-tgz-pkg', MANIFEST, { name: 'dep-tgz-pkg', dependencies: { x: 'https://example.com/x.tgz' } }],
    ];
    for (const [slug, manifest, pkg] of cases) {
        const f = fixture(slug, manifest, "require('x'); module.exports = { init() {} };\n", pkg);
        const r = run([slug, '--dir', f.plugins, '--out', f.out]);
        assert.notStrictEqual(r.status, 0, `${slug} must be refused`);
        assert.match(r.stderr, /not a registry version range/, slug);
        assert.ok(!fs.existsSync(f.out), `${slug}: nothing written`);
    }
});

test('pack:plugin refuses browser code that does not declare browser:script', () => {
    // A prebuilt bundle is browser code even with no manifest entry that would build it.
    const f = fixture('undeclared-ui', MANIFEST, OK_INDEX);
    const dir = path.join(f.plugins, 'undeclared-ui');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'hooks.bundle.js'), 'export function registerX() {}\n');
    const r = run(['undeclared-ui', '--dir', f.plugins, '--out', f.out]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /browser:script/);
    assert.ok(!fs.existsSync(f.out), 'nothing written');

    const ok = fixture('declared-ui', { ...MANIFEST, permissions: [{ scope: 'browser', access: 'script', reason: 'Registers the admin user-form extension.' }] }, OK_INDEX);
    const okDir = path.join(ok.plugins, 'declared-ui');
    fs.mkdirSync(path.join(okDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(okDir, 'dist', 'hooks.bundle.js'), 'export function registerX() {}\n');
    const { names } = packOk('declared-ui', ok);
    assert.ok(names.includes('declared-ui/dist/hooks.bundle.js'), names.join('\n'));
});

test('pack:plugin rejects a slug that could escape the plugins folder', () => {
    const r = run(['../etc', '--out', path.join(os.tmpdir(), 'pack-plugin-never')]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /not a plugin slug/);
});

test('packageName keeps the package and drops paths and Node built-ins', () => {
    assert.strictEqual(packageName('lodash/fp'), 'lodash');
    assert.strictEqual(packageName('@scope/pkg/deep/x'), '@scope/pkg');
    for (const s of ['./x', '../y', '/abs', 'fs', 'fs/promises', 'node:path', 'C:\\x']) assert.strictEqual(packageName(s), null, s);
});
