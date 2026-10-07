/**
 * Guards `npm run pack:plugin` (backend/scripts/pack-plugin.js).
 *
 * WHAT THIS LOCKS DOWN: the ZIP it writes is the one the installer accepts — a single `<slug>/` root
 * with the plugin's code, and none of the local state (`data/`), dependencies (`node_modules/`) or
 * OS junk that would leak into a hand-made archive. It also proves the script refuses, before
 * writing anything, what the installer would refuse (bad manifest, code the AST scan blocks).
 */
import { test } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { spawnSync } = require('child_process');

const PACK = path.resolve(__dirname, '../../scripts/pack-plugin.js');
const { parseArgs } = require(PACK);

function fixture(slug: string, manifest: object, indexJs: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-plugin-'));
    const dir = path.join(root, 'plugins', slug);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), indexJs);
    fs.writeFileSync(path.join(dir, 'lib', 'util.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), '{"secret":true}');
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    return { root, plugins: path.join(root, 'plugins'), out: path.join(root, 'out') };
}

function run(args: string[]) {
    return spawnSync(process.execPath, [PACK, ...args], { encoding: 'utf8', timeout: 120000 });
}

const OK_MANIFEST = { name: 'Packed', version: '1.2.3', isolated: true, permissions: [] };
const OK_INDEX = "module.exports = { init() {} };\n";

test('pack:plugin writes <slug>-<version>.zip with a single slug root and no local state', () => {
    const f = fixture('packed', OK_MANIFEST, OK_INDEX);
    try {
        const r = run(['packed', '--dir', f.plugins, '--out', f.out]);
        assert.strictEqual(r.status, 0, r.stderr + r.stdout);
        const zipPath = path.join(f.out, 'packed-1.2.3.zip');
        assert.ok(fs.existsSync(zipPath), 'zip written');
        const names = new AdmZip(zipPath).getEntries().map((e: any) => e.entryName).sort();
        assert.deepStrictEqual(names, ['packed/index.js', 'packed/lib/util.js', 'packed/manifest.json']);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('pack:plugin keeps node_modules only when asked', () => {
    const f = fixture('packed', OK_MANIFEST, OK_INDEX);
    try {
        const r = run(['packed', '--dir', f.plugins, '--out', f.out, '--include-node-modules']);
        assert.strictEqual(r.status, 0, r.stderr + r.stdout);
        const names = new AdmZip(path.join(f.out, 'packed-1.2.3.zip')).getEntries().map((e: any) => e.entryName);
        assert.ok(names.includes('packed/node_modules/dep/index.js'));
        assert.ok(!names.some((n: string) => n.startsWith('packed/data/')), 'data/ never shipped');
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('pack:plugin refuses what the installer would refuse, and writes nothing', () => {
    const cases: Array<[string, object, string, RegExp]> = [
        ['not-isolated', { name: 'X', isolated: false }, OK_INDEX, /isolated/],
        ['no-name', { isolated: true }, OK_INDEX, /name/],
        ['wrong-id', { id: 'other', name: 'X', isolated: true }, OK_INDEX, /does not match/],
        ['blocked', OK_MANIFEST, "require('child_process').execSync('id');\n", /child_process/],
    ];
    for (const [slug, manifest, indexJs, reason] of cases) {
        const f = fixture(slug, manifest, indexJs);
        try {
            const r = run([slug, '--dir', f.plugins, '--out', f.out]);
            assert.notStrictEqual(r.status, 0, `${slug} must be refused`);
            assert.match(r.stderr + r.stdout, reason, slug);
            assert.ok(!fs.existsSync(f.out) || fs.readdirSync(f.out).length === 0, `${slug}: nothing written`);
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true });
        }
    }
});

test('pack:plugin rejects a slug that could escape the plugins folder', () => {
    const r = run(['../etc', '--out', path.join(os.tmpdir(), 'pack-plugin-never')]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /not a plugin slug/);
    assert.deepStrictEqual(parseArgs(['x', '--include-node-modules']).includeNodeModules, true);
});
