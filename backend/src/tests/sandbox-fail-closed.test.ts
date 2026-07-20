/**
 * Fail-closed sandbox regression (roadmap Wave 1 / security gap #1).
 *
 * With sandbox.requireHardening ON, an isolated plugin must be REFUSED — not silently degraded to
 * JS-guards-only isolation — when kernel hardening is not ACTIVE on this host. Previously the sandbox
 * ALWAYS fell back silently, so a host without bwrap/unprivileged-userns ran untrusted plugins with only
 * the in-process guards and no operator signal ("looks secure but isn't").
 *
 * Deterministic + host-independent: we force useKernelHardening=false BEFORE any isolate probe runs, so the
 * hardening state is non-'active' on EVERY platform ('disabled' on Linux, 'unsupported' off-Linux). Runs in
 * its own process (node --test file isolation), so the lazy hardening probe is pristine.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('requireHardening REFUSES to launch an isolated plugin when hardening is not ACTIVE', async () => {
    const cfg = require('../config/app');
    cfg.sandbox.useKernelHardening = false; // guarantees a non-active state on any platform
    cfg.sandbox.requireHardening = true;

    const isolate = require('../core/plugin-isolate');
    await assert.rejects(
        () => isolate.loadIsolatedPlugin('failclosed-probe', path.join(__dirname, 'no-such-entry.js')),
        /requireHardening is ON|not ACTIVE|refusing to launch/i,
        'loadIsolatedPlugin must reject FAIL-CLOSED before forking when requireHardening is ON and hardening is not active'
    );

    const state = isolate.getSandboxHardeningState();
    assert.notStrictEqual(state, 'active', `hardening state must not be 'active' with useKernelHardening off (got '${state}')`);
    assert.ok(['disabled', 'unsupported', 'degraded'].includes(state), `expected a non-active state, got '${state}'`);
});
