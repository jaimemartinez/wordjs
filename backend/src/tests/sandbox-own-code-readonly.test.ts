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
    const p = sandboxPaths(root, 'sample-plugin', CORE, 1);
    assert.ok(!p.writable.includes(p.own), 'the code directory is never a write zone');
    assert.ok(p.readOnly.includes(p.own), 'it stays readable');
    assert.ok(p.writable.includes(p.ownData), 'the own data directory is site 1\'s write floor');
    assert.strictEqual(p.ownDataLink, path.join(p.own, 'data'));
    assert.ok(!p.ownData.startsWith(p.own + path.sep), 'the data directory lives OUTSIDE the code directory');
    const s2 = sandboxPaths(root, 'sample-plugin', CORE, 2);
    assert.ok(!s2.writable.includes(s2.ownData) && !s2.writable.includes(s2.own), 'another site writes neither');
    fs.rmSync(root, { recursive: true, force: true });
});

test('an existing data/ folder moves to the private data directory without losing a byte, behind a link', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'sample-plugin');
    fs.mkdirSync(path.join(own, 'data', 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(own, 'index.js'), 'exports.init = () => {};');
    const key = 'a'.repeat(64);
    fs.writeFileSync(path.join(own, 'data', 'secret.key'), key);
    fs.writeFileSync(path.join(own, 'data', 'attachments', 'x.bin'), Buffer.from([1, 2, 3]));

    assert.strictEqual(prepareOwnDataLink(root, 'sample-plugin'), 'migrated');
    const target = ownDataDir(root, 'sample-plugin');
    assert.ok(fs.lstatSync(path.join(own, 'data')).isSymbolicLink(), 'data/ is now a link');
    assert.strictEqual(fs.readFileSync(path.join(target, 'secret.key'), 'utf8'), key, 'the encryption key moved intact');
    assert.strictEqual(fs.readFileSync(path.join(own, 'data', 'secret.key'), 'utf8'), key, 'and is still reachable at the old path');
    assert.deepStrictEqual([...fs.readFileSync(path.join(own, 'data', 'attachments', 'x.bin'))], [1, 2, 3]);
    // Idempotent: the next launch finds the link and does nothing else.
    assert.strictEqual(prepareOwnDataLink(root, 'sample-plugin'), 'linked');
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
    fs.writeFileSync(path.join(target, 'secret.key'), 'old-key');
    fs.mkdirSync(path.join(own, 'data'), { recursive: true });
    fs.writeFileSync(path.join(own, 'data', 'secret.key'), 'zip-key');
    fs.writeFileSync(path.join(own, 'data', 'new.json'), '1');
    assert.strictEqual(prepareOwnDataLink(root, 'p1'), 'merged');
    assert.strictEqual(fs.readFileSync(path.join(target, 'secret.key'), 'utf8'), 'old-key', 'the private data wins');
    assert.strictEqual(fs.readFileSync(path.join(target, 'new.json'), 'utf8'), '1');
    const kept = fs.readdirSync(target).find((n: string) => n.startsWith('.migrated-'));
    assert.ok(kept && fs.readFileSync(path.join(target, kept, 'secret.key'), 'utf8') === 'zip-key', 'the conflicting copy is kept aside');
    fs.rmSync(root, { recursive: true, force: true });
});

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
function unlinkData(own: string) { try { fs.unlinkSync(path.join(own, 'data')); } catch { fs.rmdirSync(path.join(own, 'data')); } }

test('a plugin with no data/ gets an empty one; a dangling link is pointed at it', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p2');
    fs.mkdirSync(own, { recursive: true });
    assert.strictEqual(prepareOwnDataLink(root, 'p2'), 'created');
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-gone-'));
    unlinkData(own);
    fs.symlinkSync(gone, path.join(own, 'data'), LINK);
    fs.rmSync(gone, { recursive: true, force: true });
    assert.strictEqual(prepareOwnDataLink(root, 'p2'), 'relinked');
    fs.writeFileSync(path.join(own, 'data', 'x'), 'y');
    assert.ok(fs.existsSync(path.join(ownDataDir(root, 'p2'), 'x')), 'the link leads to the plugin\'s own data directory');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a data/ link to a folder WordJS did not choose is refused and left exactly as it is', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p3');
    fs.mkdirSync(own, { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-elsewhere-'));
    try {
        fs.writeFileSync(path.join(elsewhere, 'kept.db'), 'operator data');
        fs.symlinkSync(elsewhere, path.join(own, 'data'), LINK);
        assert.throws(() => prepareOwnDataLink(root, 'p3'), /links to another folder/);
        assert.ok(fs.lstatSync(path.join(own, 'data')).isSymbolicLink(), 'the link is not replaced');
        assert.strictEqual(fs.readFileSync(path.join(own, 'data', 'kept.db'), 'utf8'), 'operator data');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
    }
});

test('a data/ folder that is a mount point is refused, and nothing in it moves', () => {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', 'p4');
    fs.mkdirSync(path.join(own, 'data'), { recursive: true });
    fs.writeFileSync(path.join(own, 'data', 'a.txt'), 'a');
    const realStat = fs.statSync;
    // The code folder reports another device than its data/ folder: data/ is mounted there.
    fs.statSync = (p: any, ...rest: any[]) => {
        const st = realStat(p, ...rest);
        return path.resolve(String(p)) === path.resolve(own) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
    };
    try {
        assert.throws(() => prepareOwnDataLink(root, 'p4'), /is a mount point/);
    } finally { fs.statSync = realStat; }
    assert.ok(!fs.lstatSync(path.join(own, 'data')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(own, 'data', 'a.txt'), 'utf8'), 'a');
    fs.rmSync(root, { recursive: true, force: true });
});

/** A plugin data tree of every common shape: nested folders, binary and text files, a key, an SQLite-style
 *  file, an empty folder, and a link to a file outside the tree (moved as a link, never followed). */
function seedPluginData(dataDir: string, outsideFile: string) {
    fs.mkdirSync(path.join(dataDir, 'uploads', '2026', '10'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', '2026', '10', 'photo.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
    fs.writeFileSync(path.join(dataDir, 'secret.key'), 'k'.repeat(64), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'store.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1024, 7)]));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"a":1}');
    let linked = false;
    try { fs.symlinkSync(outsideFile, path.join(dataDir, 'outside-link'), 'file'); linked = true; } catch { /* no symlink privilege on this Windows account */ }
    return linked;
}
// What the plugin stored as paths RELATIVE to its data folder (what a database row would hold).
const STORED = ['uploads/2026/10/photo.bin', 'secret.key', 'store.sqlite', 'settings.json'];

function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string, rel: string) => {
        for (const n of fs.readdirSync(d).sort()) {
            const a = path.join(d, n); const r = rel ? `${rel}/${n}` : n;
            const st = fs.lstatSync(a);
            if (st.isSymbolicLink()) out[r] = `L:${fs.readlinkSync(a)}`;
            else if (st.isDirectory()) { out[r] = 'D'; walk(a, r); }
            else out[r] = `F:${require('crypto').createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`;
        }
    };
    walk(dir, '');
    return out;
}

function fixture(slug: string) {
    const root = tmpRoot();
    const own = path.join(root, 'plugins', slug);
    fs.mkdirSync(path.join(own, 'data'), { recursive: true });
    fs.writeFileSync(path.join(own, 'index.js'), 'exports.init = () => {};');
    const outsideFile = path.join(root, 'outside.txt');
    fs.writeFileSync(outsideFile, 'not plugin data');
    const linked = seedPluginData(path.join(own, 'data'), outsideFile);
    return { root, own, outsideFile, linked, before: snapshot(path.join(own, 'data')) };
}

function assertMovedIntact(fx: any, slug: string) {
    const target = ownDataDir(fx.root, slug);
    assert.ok(fs.lstatSync(path.join(fx.own, 'data')).isSymbolicLink(), 'data/ is a link');
    assert.deepStrictEqual(snapshot(target), fx.before, 'every entry moved with the same bytes, and the link stayed a link');
    for (const rel of STORED) {
        assert.deepStrictEqual(fs.readFileSync(path.join(fx.own, 'data', rel)), fs.readFileSync(path.join(target, rel)), `${rel} resolves through the old path`);
    }
    if (fx.linked) assert.strictEqual(fs.readlinkSync(path.join(target, 'outside-link')), fx.outsideFile, 'the inner link was not followed');
    assert.strictEqual(fs.readFileSync(fx.outsideFile, 'utf8'), 'not plugin data');
    assert.ok(!fs.readdirSync(path.dirname(target)).some((n: string) => /\.incoming-/.test(n)), 'no half-made copy is left behind');
    assert.strictEqual(prepareOwnDataLink(fx.root, slug), 'linked', 'idempotent');
    assert.deepStrictEqual(snapshot(target), fx.before);
}

test('any plugin data tree moves intact on one volume, and every stored relative path still resolves', () => {
    const fx = fixture('sample-a');
    try {
        assert.strictEqual(prepareOwnDataLink(fx.root, 'sample-a'), 'migrated');
        assertMovedIntact(fx, 'sample-a');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

/** Make every rename of a path outside a half-made copy fail as it does between two volumes. */
function acrossVolumes<T>(fn: () => T): T {
    const realRename = fs.renameSync;
    fs.renameSync = (a: any, b: any) => {
        if (!/\.incoming-/.test(String(a))) { const e: any = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
        return realRename(a, b);
    };
    try { return fn(); } finally { fs.renameSync = realRename; }
}

test('across volumes the tree is copied, compared, put in place, and only then removed from the code folder', () => {
    const fx = fixture('sample-b');
    try {
        assert.strictEqual(acrossVolumes(() => prepareOwnDataLink(fx.root, 'sample-b')), 'migrated');
        assertMovedIntact(fx, 'sample-b');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('an interrupted move finishes on the next start, at every point it can stop', () => {
    // 1. Stopped during the cross-volume copy: a half-made copy, the source complete.
    let fx = fixture('sample-c');
    try {
        const target = ownDataDir(fx.root, 'sample-c');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(`${target}.incoming-1-2`);
        fs.writeFileSync(path.join(`${target}.incoming-1-2`, 'secret.key'), 'trunc');
        assert.strictEqual(acrossVolumes(() => prepareOwnDataLink(fx.root, 'sample-c')), 'migrated');
        assertMovedIntact(fx, 'sample-c');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }

    // 2. Stopped after the copy landed, before the source was removed: both complete and identical.
    fx = fixture('sample-d');
    try {
        const target = ownDataDir(fx.root, 'sample-d');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(fx.own, 'data'), target, { recursive: true, verbatimSymlinks: true });
        assert.strictEqual(prepareOwnDataLink(fx.root, 'sample-d'), 'merged');
        assert.ok(!fs.readdirSync(target).some((n: string) => n.startsWith('.migrated-')), 'identical entries are recognised, not set aside');
        assertMovedIntact(fx, 'sample-d');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }

    // 3. Stopped after the move, before the link was made.
    fx = fixture('sample-e');
    try {
        assert.strictEqual(prepareOwnDataLink(fx.root, 'sample-e'), 'migrated');
        unlinkData(fx.own);
        assert.strictEqual(prepareOwnDataLink(fx.root, 'sample-e'), 'created');
        assertMovedIntact(fx, 'sample-e');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('a link that cannot be made puts the data back where the plugin expects it', () => {
    const fx = fixture('sample-f');
    const realSymlink = fs.symlinkSync;
    fs.symlinkSync = () => { const e: any = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
    try {
        assert.throws(() => prepareOwnDataLink(fx.root, 'sample-f'), /could not link/);
    } finally { fs.symlinkSync = realSymlink; }
    try {
        assert.ok(!fs.lstatSync(path.join(fx.own, 'data')).isSymbolicLink());
        assert.deepStrictEqual(snapshot(path.join(fx.own, 'data')), fx.before, 'the data is back, intact');
        assert.strictEqual(prepareOwnDataLink(fx.root, 'sample-f'), 'migrated', 'and the next start retries');
        assertMovedIntact(fx, 'sample-f');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
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
