/**
 * Sandbox hardening regression test — three fixes that close self-code-modification / exfil vectors:
 *
 *   #1  io-guard now patches copyFile/cp/link (previously UNPATCHED): the SOURCE is read-checked and the
 *       DEST write-checked, so a plugin can neither copy a secret/out-of-zone file OUT (read-confinement
 *       bypass) nor copy/hard-link a file INTO an executable name.
 *   #2  io-guard blocks CREATING or renaming/copying a file into an executable code extension
 *       (.js/.cjs/.mjs/.node/.wasm/…) anywhere a plugin can write — so the "write payload.txt then rename
 *       it to payload.js" trick, and direct .js writes into its own dir, are denied. Data files stay OK.
 *   #3  secure-require denies a plugin/theme module require()-ing code out of a writable data dir
 *       (uploads/data/os-tmp/logs) — so a planted payload there can't be loaded even if it existed.
 *   #4  io-guard now also patches open/openSync/opendir/readlink (previously UNPATCHED): a plugin doing
 *       fs.openSync(p,'r') + fs.readSync(fd) read ANY file's CONTENT, bypassing the readFile guard. open is
 *       FLAG-AWARE — open-for-write is confined as a write (read-only-zone / exec-ext blocks apply).
 *
 * Each fix is asserted BOTH ways: the attack is blocked AND a legitimate equivalent still works.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('../core/io-guard'); // installs the global fs monkey-patches (guarded by effective-plugin context)
const { installSecureRequire } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const ROOT_DIR = path.resolve(__dirname, '../../'); // backend/
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const OS_TMP = path.join(ROOT_DIR, 'os-tmp');
const SLUG = 'ioguard-harden-test-plugin';
const dir = path.join(PLUGINS_DIR, SLUG);

// A file OUTSIDE every safe zone (real OS temp, unrelated to backend/os-tmp) — stands in for the DB /
// a secret file that a plugin must not be able to copy or hard-link out of.
const OUTSIDE = path.join(os.tmpdir(), `wjs-ioguard-outside-${process.pid}.txt`);
// An executable payload planted in a writable data dir (os-tmp) — must not be require()-able by a plugin.
const OSTMP_PAYLOAD = path.join(OS_TMP, `wjs-harden-payload-${process.pid}.js`);

function expectEACCES(fn: () => void): any {
    try { fn(); } catch (e: any) { return e; }
    assert.fail('expected the guarded fs op to throw, but it succeeded');
}

before(() => {
    // All setup runs OUTSIDE any plugin context → getEffectivePlugin() is null → io-guard is a no-op here,
    // so the host can freely create the fixtures (incl. .js files) that a plugin later must not.
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(OS_TMP, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'data.txt'), 'owndata');
    fs.writeFileSync(OUTSIDE, 'PRETEND-SECRET');
    fs.writeFileSync(OSTMP_PAYLOAD, "module.exports = 'PWNED';");
    // A plugin's OWN modules — legitimate to require. Written by the host here.
    fs.writeFileSync(path.join(dir, 'util.js'), "module.exports = 'own-module-ok';");
    fs.writeFileSync(path.join(dir, 'loader.js'), 'module.exports = (p) => require(p);');
});

after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.rmSync(OUTSIDE, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(OSTMP_PAYLOAD, { force: true }); } catch { /* best effort */ }
});

// ---- Fix #2: executable-extension write block ----

test('#2 a plugin CANNOT write a .js file into its own dir', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.writeFileSync(path.join(dir, 'evil.js'), 'x'));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'evil.js')), 'evil.js must not have been created');
});

test('#2 a plugin CAN still write a .json data file into its own dir (no regression)', () => {
    runWithContext(SLUG, () => {
        fs.writeFileSync(path.join(dir, 'cache.json'), '{"ok":true}');
    });
    assert.ok(fs.existsSync(path.join(dir, 'cache.json')));
});

test('#2 write-.txt-then-rename-to-.js is blocked on the rename destination', () => {
    runWithContext(SLUG, () => {
        fs.writeFileSync(path.join(dir, 'stager.txt'), "module.exports='x';"); // allowed: data file
        const e = expectEACCES(() => fs.renameSync(path.join(dir, 'stager.txt'), path.join(dir, 'stager.js')));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'stager.js')), 'stager.js must not exist');
});

// ---- Fix #1: copyFile / hard-link confinement (both ends) ----

test('#1 copyFile to a .js destination is blocked (copy-then-rename trick closed)', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.copyFileSync(path.join(dir, 'data.txt'), path.join(dir, 'copied.js')));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'copied.js')));
});

test('#1 copyFile FROM an out-of-zone source is blocked (exfil / read-confinement closed)', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.copyFileSync(OUTSIDE, path.join(dir, 'imported.txt')));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'imported.txt')), 'the out-of-zone file must not have been copied in');
});

test('#1 copyFile within the plugin dir to a data-file destination still works (no regression)', () => {
    runWithContext(SLUG, () => {
        fs.copyFileSync(path.join(dir, 'data.txt'), path.join(dir, 'data-copy.txt'));
    });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'data-copy.txt'), 'utf8'), 'owndata');
});

test('#1 hard link FROM an out-of-zone source is blocked (link-then-read exfil closed)', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.linkSync(OUTSIDE, path.join(dir, 'linked.txt')));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'linked.txt')));
});

// ---- Fix #3: require() confinement away from writable data dirs ----

test('#3 a plugin module CANNOT require code out of a writable data dir (os-tmp)', () => {
    const loader = require(path.join(dir, 'loader.js')); // required by the TEST (host) → loads fine
    let threw = false, msg = '';
    try { loader(OSTMP_PAYLOAD); } catch (e: any) { threw = true; msg = String(e && e.message); }
    assert.ok(threw, 'require() of an os-tmp payload from a plugin module must be blocked');
    assert.match(msg, /writable data directory|not permitted/i);
});

test('#3 a plugin module CAN still require its OWN sibling module (no regression)', () => {
    const loader = require(path.join(dir, 'loader.js'));
    assert.strictEqual(loader('./util'), 'own-module-ok');
});

// ---- Fix #4: open / opendir read-family confinement (open is flag-aware) ----

test('#4 a plugin CANNOT open an out-of-zone file for reading (arbitrary-read bypass closed)', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.openSync(OUTSIDE, 'r'));
        assert.strictEqual(e.code, 'EACCES');
    });
});

test('#4 a plugin CAN still open its OWN data file for reading (no regression)', () => {
    runWithContext(SLUG, () => {
        const fd = fs.openSync(path.join(dir, 'data.txt'), 'r');
        assert.ok(fd >= 0);
        fs.closeSync(fd);
    });
});

test('#4 open is FLAG-AWARE: open-for-WRITE into a read-only zone (src/) is denied as a write', () => {
    // src/ is a READ safe-zone (so plugins can require core) but NOT a write zone. If open were treated as
    // a read this would be waved through; the flag check confines it as the write it is.
    const probe = path.join(ROOT_DIR, 'src', `wjs-open-probe-${process.pid}.txt`);
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.openSync(probe, 'w'));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(probe), 'no probe file may be created in the read-only src/ zone');
});

test('#4 open-for-write of a .js in the plugin dir is still blocked (exec-ext, via the open path)', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.openSync(path.join(dir, 'viaopen.js'), 'w'));
        assert.strictEqual(e.code, 'EACCES');
    });
    assert.ok(!fs.existsSync(path.join(dir, 'viaopen.js')));
});

test('#4 opendir on an out-of-zone directory is blocked', () => {
    runWithContext(SLUG, () => {
        const e = expectEACCES(() => fs.opendirSync(os.tmpdir()));
        assert.strictEqual(e.code, 'EACCES');
    });
});

test('#4 a plugin CAN still opendir its OWN dir (no regression)', () => {
    runWithContext(SLUG, () => {
        const d = fs.opendirSync(dir);
        assert.ok(d);
        d.closeSync();
    });
});
