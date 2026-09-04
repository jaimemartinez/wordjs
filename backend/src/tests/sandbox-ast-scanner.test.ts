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
