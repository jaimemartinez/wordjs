/**
 * An isolated plugin's code directory is read-only; its own data lives outside it.
 *
 * Every sandbox layer used to grant site 1's worker WRITE access to the plugin's own code directory, so a
 * plugin with no permissions could rewrite its code or manifest for good. The code directory is now
 * read-only everywhere, `<code dir>/data` is a link to the plugin's own data directory (migrated there
 * without losing a byte), and the code + manifest are fingerprinted and checked before every launch.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../config/app');
const { sandboxPaths, ownDataDir } = require('../core/sandbox-paths');
const { prepareOwnDataLink } = require('../core/plugin-own-data');
const integrity = require('../core/plugin-integrity');
const { validateManifestPermissions } = require('../core/plugins');

const CORE = path.resolve(__dirname, '..', 'core');

function tmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-owncode-'));
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    return root;
}

test('the code directory is read-only at every layer; site 1 writes its own data directory instead', () => {
    const root = tmpRoot();
    const p = sandboxPaths(root, 'mail-server', CORE, 1);
    assert.ok(!p.writable.includes(p.own), 'the code directory is never a write zone');
    assert.ok(p.readOnly.includes(p.own), 'it stays readable');
    assert.ok(p.writable.includes(p.ownData), 'the own data directory is site 1\'s write floor');
    assert.strictEqual(p.ownDataLink, path.join(p.own, 'data'));
    assert.ok(!p.ownData.startsWith(p.own + path.sep), 'the data directory lives OUTSIDE the code directory');
    const s2 = sandboxPaths(root, 'mail-server', CORE, 2);
    assert.ok(!s2.writable.includes(s2.ownData) && !s2.writable.includes(s2.own), 'another site writes neither');
    fs.rmSync(root, { recursive: true, force: true });
});

test('an existing data/ folder moves to the private data directory without losing a byte, behind a link', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'mail-server');
    fs.mkdirSync(path.join(own, 'data', 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(own, 'index.js'), 'exports.init = () => {};');
    const key = 'a'.repeat(64);
    fs.writeFileSync(path.join(own, 'data', '.mailenc'), key);
    fs.writeFileSync(path.join(own, 'data', 'attachments', 'x.bin'), Buffer.from([1, 2, 3]));

    assert.strictEqual(prepareOwnDataLink(root, 'mail-server'), 'migrated');
    const target = ownDataDir(root, 'mail-server');
    assert.ok(fs.lstatSync(path.join(own, 'data')).isSymbolicLink(), 'data/ is now a link');
    assert.strictEqual(fs.readFileSync(path.join(target, '.mailenc'), 'utf8'), key, 'the encryption key moved intact');
    assert.strictEqual(fs.readFileSync(path.join(own, 'data', '.mailenc'), 'utf8'), key, 'and is still reachable at the old path');
    assert.deepStrictEqual([...fs.readFileSync(path.join(own, 'data', 'attachments', 'x.bin'))], [1, 2, 3]);
    // Idempotent: the next launch finds the link and does nothing else.
    assert.strictEqual(prepareOwnDataLink(root, 'mail-server'), 'linked');
    // A write through the link lands in the private directory.
    fs.writeFileSync(path.join(own, 'data', 'bayes.json'), '{}');
    assert.ok(fs.existsSync(path.join(target, 'bayes.json')));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a data/ folder recreated beside existing private data is MERGED, never overwriting what is there', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p1');
    const target = ownDataDir(root, 'p1');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.mailenc'), 'old-key');
    fs.mkdirSync(path.join(own, 'data'), { recursive: true });
    fs.writeFileSync(path.join(own, 'data', '.mailenc'), 'zip-key');
    fs.writeFileSync(path.join(own, 'data', 'new.json'), '1');
    assert.strictEqual(prepareOwnDataLink(root, 'p1'), 'merged');
    assert.strictEqual(fs.readFileSync(path.join(target, '.mailenc'), 'utf8'), 'old-key', 'the private data wins');
    assert.strictEqual(fs.readFileSync(path.join(target, 'new.json'), 'utf8'), '1');
    const kept = fs.readdirSync(target).find((n: string) => n.startsWith('.migrated-'));
    assert.ok(kept && fs.readFileSync(path.join(target, kept, '.mailenc'), 'utf8') === 'zip-key', 'the conflicting copy is kept aside');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a plugin with no data/ gets an empty one, and a link pointing elsewhere is replaced', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p2');
    fs.mkdirSync(own, { recursive: true });
    assert.strictEqual(prepareOwnDataLink(root, 'p2'), 'created');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-elsewhere-'));
    try { fs.unlinkSync(path.join(own, 'data')); } catch { fs.rmdirSync(path.join(own, 'data')); }
    fs.symlinkSync(elsewhere, path.join(own, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(prepareOwnDataLink(root, 'p2'), 'relinked');
    assert.ok(fs.existsSync(elsewhere), 'the foreign target itself is left alone');
    fs.writeFileSync(path.join(own, 'data', 'x'), 'y');
    assert.ok(fs.existsSync(path.join(ownDataDir(root, 'p2'), 'x')), 'the link leads to the plugin\'s own data directory again');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('the code and manifest are fingerprinted: a changed file refuses the launch in production, and is re-recorded in development', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p3');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'manifest.json'), '{"name":"p3","isolated":true}');
    fs.writeFileSync(path.join(own, 'index.js'), 'exports.init = () => {};');
    prepareOwnDataLink(root, 'p3');
    const prod = { NODE_ENV: 'production' };
    assert.deepStrictEqual(integrity.verifyPluginIntegrity(root, 'p3', prod), { ok: true, recorded: true });
    // Data is not code: writing it never changes the fingerprint.
    fs.writeFileSync(path.join(own, 'data', 'state.json'), '{"n":1}');
    assert.strictEqual(integrity.verifyPluginIntegrity(root, 'p3', prod).ok, true);
    fs.writeFileSync(path.join(own, 'manifest.json'), '{"name":"p3","isolated":true,"permissions":[{"scope":"network"}]}');
    const refused = integrity.verifyPluginIntegrity(root, 'p3', prod);
    assert.strictEqual(refused.ok, false, 'a rewritten manifest refuses the launch');
    assert.ok(integrity.listIntegrityMismatches().includes('p3'), 'Site Health lists it');
    integrity.acceptPluginIntegrity(root, 'p3');
    assert.strictEqual(integrity.verifyPluginIntegrity(root, 'p3', prod).ok, true, 'until an administrator accepts the files');
    fs.writeFileSync(path.join(own, 'index.js'), 'exports.init = () => { /* edited */ };');
    assert.strictEqual(integrity.verifyPluginIntegrity(root, 'p3', { NODE_ENV: 'development' }).ok, true, 'development records the edit');
    integrity.forgetPluginIntegrity(root, 'p3');
    assert.strictEqual(integrity.verifyPluginIntegrity(root, 'p3', prod).recorded, true, 'a host update forgets the record');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a file is hashed through one descriptor, and one swapped after its lstat is not hashed at all', () => {
    const root = tmpRoot();
    try {
        const a = path.join(root, 'index.js');
        fs.writeFileSync(a, 'module.exports = 1;');
        const seen = fs.lstatSync(a);
        assert.match(String(integrity.__hashRegularFile(a, seen)), /^[0-9a-f]{64}$/);
        // Replaced by another file (a new inode) between the walk's lstat and the open.
        fs.rmSync(a);
        fs.writeFileSync(a, 'module.exports = 2; // longer');
        assert.strictEqual(integrity.__hashRegularFile(a, seen), null);
        // Replaced by a directory.
        fs.rmSync(a);
        fs.mkdirSync(a);
        assert.strictEqual(integrity.__hashRegularFile(a, seen), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a network permission may name its TCP ports, and only valid ones', () => {
    assert.deepStrictEqual(validateManifestPermissions([{ scope: 'network', ports: [25, 587] }]), []);
    assert.strictEqual(validateManifestPermissions([{ scope: 'network', ports: [0] }]).length, 1);
    assert.strictEqual(validateManifestPermissions([{ scope: 'network', ports: '25' }]).length, 1);
    assert.strictEqual(validateManifestPermissions([{ scope: 'network', ports: Array.from({ length: 17 }, (_, i) => i + 1) }]).length, 1);
});

// ── the live boundary, through a real isolate ─────────────────────────────────────────────────────
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const hooks = require('../core/hooks');
const SLUG = 'test-own-code-readonly';
const APP_ROOT = path.resolve(__dirname, '..', '..');
const dir = path.join(APP_ROOT, 'plugins', SLUG);

before(async () => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'seed.txt'), 'seeded-before-migration');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true }));
    fs.writeFileSync(path.join(dir, 'index.js'),
        "const fs = require('fs'); const path = require('path');\n" +
        "function attempt(fn) { try { fn(); return 'OK'; } catch (e) { return String(e && (e.code || e.message)).slice(0, 80); } }\n" +
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('test_own_code_probe', () => JSON.stringify({\n" +
        "    seed: attempt(() => { if (fs.readFileSync(path.join(__dirname, 'data', 'seed.txt'), 'utf8') !== 'seeded-before-migration') throw new Error('LOST'); }),\n" +
        "    dataWrite: attempt(() => fs.writeFileSync(path.join(__dirname, 'data', 'state.json'), '{}')),\n" +
        "    codeWrite: attempt(() => fs.writeFileSync(path.join(__dirname, 'evil.txt'), 'x')),\n" +
        "    codeRewrite: attempt(() => fs.appendFileSync(path.join(__dirname, 'index.js'), '\\n// tampered')),\n" +
        "  }));\n" +
        "};\n");
    await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
});
after(() => {
    unloadIsolatedPlugin(SLUG);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(ownDataDir(APP_ROOT, SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { integrity.forgetPluginIntegrity(APP_ROOT, SLUG); } catch { /* */ }
});

test('inside a real isolate: data/ survives the move and is writable, the code folder is not', async () => {
    const before = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    const r = JSON.parse(await hooks.applyFilters('test_own_code_probe', ''));
    assert.strictEqual(r.seed, 'OK', 'the data written before the upgrade is still there');
    assert.strictEqual(r.dataWrite, 'OK', 'writing under data/ keeps working');
    assert.notStrictEqual(r.codeWrite, 'OK', 'a new file in the code folder is refused');
    assert.notStrictEqual(r.codeRewrite, 'OK', 'rewriting its own code is refused');
    assert.ok(fs.existsSync(path.join(ownDataDir(APP_ROOT, SLUG), 'state.json')), 'the write landed in the private data directory');
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')), 'no file appeared in the code folder');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), before, 'the code is unchanged');
});
