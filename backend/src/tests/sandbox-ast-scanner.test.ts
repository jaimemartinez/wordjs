/**
 * Regression tests for the plugin AST scanner (validatePluginPermissions in core/plugins.ts).
 *
 * Locks the fixes for two confirmed sandbox-escape findings (2026-06-20 audit):
 *  - dynamic AND static import() of Node builtins (the import() RCE that bypassed the CJS require
 *    proxy at runtime — the scanner had no ImportExpression/ImportDeclaration visitor); and
 *  - building executable code via `(()=>{}).constructor(...)` (the literal eval/Function name check
 *    missed the indirect Function constructor).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validatePluginPermissions } = require('../core/plugins');

// Write `code` as a plugin entry file in a temp dir and run the scanner. Returns true if the scan
// PASSES (no throw); the scanner throws a "Security Block" error when it flags a dangerous call.
function scan(code: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-scan-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.js'), code);
        validatePluginPermissions('test-scan', dir, { name: 'test-scan', permissions: [] });
        return true;
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// Same as scan(), but with the manifest permissions the plugin DECLARES — for the gates whose verdict
// depends on the declaration (net/dns need `network`), not only on the call.
function scanWith(code: string, permissions: any[]): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-scan-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.js'), code);
        validatePluginPermissions('test-scan', dir, { name: 'test-scan', permissions });
        return true;
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// Docs-vs-code audit (2026-09-04): `network` is SCOPE-ONLY — its token is the bare literal and every
// real manifest declares it as {"scope":"network"} with no access. `declares()` required an access, so a
// plugin that HAD declared network was reported as missing it. Pin both directions.
test('the net/dns gate still fires when the manifest declares nothing', () => {
    assert.throws(() => scanWith("const net = require('net'); module.exports.init = () => { void net; };", []),
        /Network\/System access|network/i, 'an undeclared require(\'net\') must be reported as a missing Network permission');
});

test('a bare {"scope":"network"} declaration satisfies the net/dns gate', () => {
    // Must not be reported as a MISSING network permission. (Any other verdict the scanner reaches for
    // this file is not this test's concern — only that the declared network grant is recognised.)
    let err: any = null;
    try { scanWith("const net = require('net'); module.exports.init = () => { void net; };", [{ scope: 'network' }]); }
    catch (e) { err = e; }
    if (err) assert.doesNotMatch(String(err.message), /Network\/System access/i,
        `a declared {"scope":"network"} must not be read as undeclared, got: ${err.message}`);
});

test('scanner blocks dynamic import() of child_process (the import() RCE)', () => {
    assert.throws(() => scan("module.exports.init = async () => { await import('child_process'); };"), /import|child_process/i);
});

test('scanner blocks node:-prefixed dynamic import()', () => {
    assert.throws(() => scan("module.exports.init = async () => { await import('node:child_process'); };"), /import|child_process/i);
});

test('scanner flags a non-literal dynamic import() as obfuscation', () => {
    assert.throws(() => scan("module.exports.init = async () => { await import('child' + '_process'); };"), /import|obfuscation/i);
});

test('scanner blocks a static import of a sensitive builtin', () => {
    assert.throws(() => scan("import cp from 'child_process'; export const init = () => { void cp; };"), /import|child_process/i);
});

test('scanner blocks dynamic import() of worker_threads', () => {
    assert.throws(() => scan("module.exports.init = async () => { await import('worker_threads'); };"), /import|worker_threads/i);
});

test('scanner blocks Function built via .constructor', () => {
    assert.throws(() => scan("module.exports.init = () => { (() => {}).constructor('return process')(); };"), /constructor|Function/i);
});

test('scanner blocks aliasing the process global (const p = process)', () => {
    assert.throws(() => scan("module.exports.init = () => { const p = process; return p.pid; };"), /process|alias/i);
});

test('scanner blocks destructuring getBuiltinModule from process', () => {
    assert.throws(() => scan("module.exports.init = () => { const { getBuiltinModule: g } = process; g('fs'); };"), /process|alias/i);
});

test('scanner still passes a clean plugin', () => {
    assert.ok(scan("module.exports.init = (wordjs) => { wordjs.hooks.addAction('x', () => 1); };"));
});

// ===========================================================================================
// THE SHIPPED DEPENDENCY TREE (node_modules/ inside an uploaded plugin).
//
// Until 2026-09-04 the scanner walked past node_modules entirely, so the cheapest place in an uploaded
// package to park a require('child_process') was inside a fake dependency — the operator's install-time
// review never saw it. These tests pin the bounded scan that closes that: the SAME rules the plugin's
// own source gets, run over the shipped tree, with every bound it hits reported as a finding instead of
// as a pass. They go red if the dependency pass is removed, or if its bounds stop being reported.
// ===========================================================================================

/** Build a temp plugin from a {relative path -> contents} map and run the scanner over it. */
function scanTree(files: Record<string, string>, options: any = {}, permissions: any[] = []): any {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-deps-'));
    try {
        for (const [rel, contents] of Object.entries(files)) {
            const full = path.join(dir, rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, contents);
        }
        try {
            validatePluginPermissions('test-scan', dir, { name: 'test-scan', permissions }, options);
            return null;                      // scan PASSED
        } catch (e) {
            return e;                         // the Security Block error
        }
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

const CLEAN_ENTRY = "module.exports.init = (wordjs) => { wordjs.hooks.addAction('x', () => 1); };";

test('a shipped dependency that requires child_process is flagged, naming the file', () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/evil/index.js': "const cp = require('child_process'); module.exports = () => cp;",
    });
    assert.ok(err, 'a dependency requiring child_process must NOT scan clean');
    assert.match(String(err.message), /child_process/,
        `the finding must name the sink, got: ${err && err.message}`);
    assert.ok(err.dangerousCalls.some((d: string) => d.startsWith('node_modules/evil/index.js:')),
        `the finding must be attributed to the dependency file, got: ${JSON.stringify(err && err.dangerousCalls)}`);
});

test('a shipped dependency that eval()s is flagged', () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/sneaky/lib/run.js': "module.exports = (s) => eval(s);",
    });
    assert.ok(err, 'eval() inside a dependency must be flagged');
    assert.ok(err.dangerousCalls.some((d: string) => d.startsWith('node_modules/sneaky/lib/run.js:')),
        `expected the nested dependency path in the finding, got: ${JSON.stringify(err && err.dangerousCalls)}`);
});

test('a shipped dependency reaching a native binding (process.binding) is flagged', () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/native/index.js': "module.exports = () => process.binding('spawn_sync');",
    });
    assert.ok(err, 'process.binding() inside a dependency must be flagged');
    assert.match(String(err.message), /binding/, `expected the native-binding finding, got: ${err && err.message}`);
});

test('a clean dependency does NOT block the plugin', () => {
    // Deliberately full of the shapes that are obfuscation signals in a plugin's OWN code and ordinary
    // idiom inside a package: computed dispatch, a computed require(), process.platform, module.exports.
    // If this test starts failing, the dependency pass has been re-calibrated to the own-source rules and
    // no real plugin with a node_modules/ will install any more.
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/tidy/index.js': [
            "const plat = process.platform;",
            "const handlers = { a: () => 1 };",
            "function pick(k) { return handlers[k](); }",
            "function load(name) { return require(name); }",
            "module.exports = { plat, pick, load };",
        ].join('\n'),
        'node_modules/tidy/package.json': '{"name":"tidy","version":"1.0.0"}',
    });
    assert.equal(err, null, `a clean dependency must not block the plugin, got: ${err && err.message}`);
});

test('a dependency tree over the file bound produces the "could not be scanned in full" finding', () => {
    const files: Record<string, string> = { 'index.js': CLEAN_ENTRY };
    for (let i = 0; i < 6; i++) files[`node_modules/pkg${i}/index.js`] = 'module.exports = ' + i + ';';
    // The bound is narrowed (never widened — collectShippedDependencyFiles clamps to the production
    // ceiling) so the branch is testable without writing 4000 files.
    const err = scanTree(files, { dependencyScanLimits: { maxFiles: 2 } });
    assert.ok(err, 'a tree that could not be read in full must fail closed, not pass');
    assert.match(String(err.message), /could not be scanned in full/,
        `expected the bounded-scan finding, got: ${err && err.message}`);
    assert.match(String(err.message), /more than 2 scannable files/,
        `the finding must say WHICH bound was hit, got: ${err && err.message}`);
});

test('an oversized dependency file is skipped, and the skip is itself reported', () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/bundle/dist.js': `module.exports = ${JSON.stringify('x'.repeat(5000))};`,
    }, { dependencyScanLimits: { maxFileBytes: 512 } });
    assert.ok(err, 'a file too large to scan must be reported, not silently skipped');
    assert.match(String(err.message), /larger than 512 bytes/,
        `expected the size-skip reason, got: ${err && err.message}`);
});

test('an unparseable dependency file fails closed', () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/broken/index.js': 'module.exports = function ( { ;;; <<<',
    });
    assert.ok(err, 'a dependency file that will not parse must fail closed');
    assert.match(String(err.message), /could not be scanned/,
        `expected the unscannable finding, got: ${err && err.message}`);
});

test('a plugin with no node_modules/ is unaffected by the dependency pass', () => {
    assert.equal(scanTree({ 'index.js': CLEAN_ENTRY }), null);
});

test('a node_modules symlink pointing outside the plugin is not followed, and is reported', (t: any) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-deps-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-outside-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.js'), CLEAN_ENTRY);
        fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
        // Code the scanner must never pull into a plugin's report, and never read on an uploader's
        // instruction. It is dangerous ON PURPOSE: if the link WERE followed, the finding would name
        // child_process and the assertion below fails loudly instead of the escape passing silently.
        fs.writeFileSync(path.join(outside, 'index.js'), "require('child_process');");
        try {
            fs.symlinkSync(outside, path.join(dir, 'node_modules', 'escape'), 'junction');
        } catch {
            t.skip('this platform/account cannot create symlinks');
            return;
        }
        let err: any = null;
        try { validatePluginPermissions('test-scan', dir, { name: 'test-scan', permissions: [] }); }
        catch (e) { err = e; }
        assert.ok(err, 'an escaping symlink is unscannable code and must fail closed');
        assert.doesNotMatch(String(err.message), /child_process/,
            `the escaping symlink must NOT be followed, got: ${err.message}`);
        assert.match(String(err.message), /OUTSIDE the plugin directory/,
            `the skip must be reported, got: ${err.message}`);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test("a dependency's require('http') is a NETWORK charge, not a hard block", () => {
    // Real packages do this (express, nodemailer, axios). At runtime secure-require gates exactly these
    // modules on the admin's Network grant for anything under plugins/<slug>/, so blocking them here
    // would make the install-time scan stricter than the sandbox and refuse a plugin the sandbox would
    // have run. It must still be REPORTED — as the fixable kind of finding.
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/httpish/index.js': "const http = require('http'); module.exports = () => http;",
    });
    assert.ok(err, "an undeclared network dependency must not scan clean");
    assert.deepEqual(err.dangerousCalls, [],
        `require('http') in a dependency must not be a hard block, got: ${JSON.stringify(err.dangerousCalls)}`);
    assert.ok(err.missingPermissions.some((m: string) => /Network/.test(m) && m.startsWith('node_modules/httpish/index.js:')),
        `expected a path-attributed Network charge, got: ${JSON.stringify(err.missingPermissions)}`);
});

test("a declared network permission covers the dependency's require('http')", () => {
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/httpish/index.js': "const http = require('http'); module.exports = () => http;",
    }, {}, [{ scope: 'network' }]);
    assert.equal(err, null, `a network-declaring plugin must install, got: ${err && err.message}`);
});

test('a dependency requiring a NON-network sensitive builtin is still blocked', () => {
    // The network carve-out above is exactly the modules the runtime gates by grant — nothing else.
    // vm/worker_threads/child_process have no grant that unlocks them, so they stay hard blocks.
    const err = scanTree({
        'index.js': CLEAN_ENTRY,
        'node_modules/vmish/index.js': "const vm = require('vm'); module.exports = () => vm;",
    }, {}, [{ scope: 'network' }]);
    assert.ok(err, "require('vm') in a dependency must stay a hard block");
    assert.ok(err.dangerousCalls.some((d: string) => d.includes("require('vm')")),
        `expected the vm finding, got: ${JSON.stringify(err && err.dangerousCalls)}`);
});
