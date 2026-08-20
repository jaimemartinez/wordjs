/**
 * Fail-closed sandbox regression (roadmap Wave 1 / security gap #1).
 *
 * With sandbox.requireHardening ON, an isolated plugin must be REFUSED — not silently degraded to
 * JS-guards-only isolation — when kernel hardening is not ACTIVE on this host. Previously the sandbox
 * ALWAYS fell back silently, so a host without a working native mechanism ran untrusted plugins with only
 * the in-process guards and no operator signal ("looks secure but isn't").
 *
 * Deterministic + host-independent: we force useKernelHardening=false BEFORE any isolate probe runs, so the
 * hardening state is non-'active' on EVERY platform ('disabled' on Linux, 'unsupported' off-Linux). Runs in
 * its own process (node --test file isolation), so the lazy hardening probe is pristine.
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('compiled production requires the native sandbox by default', () => {
    const cfg = require('../config/app');
    const isolate = require('../core/plugin-isolate');
    assert.strictEqual(cfg.sandbox.requireHardening, true);
    for (const platform of ['linux', 'win32', 'darwin']) {
        assert.strictEqual(isolate.__nativeSandboxRequired({ configured: true, platform, tsNode: false }), true);
    }
});

test('only an explicit false permits the unsafe compatibility fallback', () => {
    const isolate = require('../core/plugin-isolate');
    for (const platform of ['linux', 'win32', 'darwin']) {
        assert.strictEqual(isolate.__nativeSandboxRequired({ configured: false, platform, tsNode: false }), false);
    }
});

test('the source-only Windows worker has a narrow development carve-out', () => {
    const isolate = require('../core/plugin-isolate');
    assert.strictEqual(isolate.__nativeSandboxRequired({ configured: true, platform: 'win32', tsNode: true }), false);
    assert.strictEqual(isolate.__nativeSandboxRequired({ configured: true, platform: 'linux', tsNode: true }), true);
    assert.strictEqual(isolate.__nativeSandboxRequired({ configured: true, platform: 'darwin', tsNode: true }), true);
});
