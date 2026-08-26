/**
 * The sandbox health surface must report what the launcher DOES, not what the policy SAYS.
 *
 * THE DEFECT THIS LOCKS DOWN. `SystemHealth.checkSandbox()` computed its status as
 * `… : requireHardening ? 'REFUSING' : …`. `sandbox.requireHardening` is the policy; whether a launch
 * is refused is a decision `nativeSandboxRequired()` takes, and that decision EXEMPTS the source-only
 * Windows ts-node worker. On such a host the surface reported **REFUSING** — "this host turns away
 * launches it cannot confine" — at the very moment isolated plugins were starting with no AppContainer
 * at all. Verified on a live Windows host before the fix.
 *
 * That is not a cosmetic mismatch. `requireHardening` defaults to ON, so this is the posture an
 * operator is told they have; a monitoring surface that states the rule instead of the outcome is
 * worse than one that says nothing, because it is believed. And `server.js` reaches the exempt path by
 * the ABSENCE OF `dist/`, not by being development — so "the development worker is exempt" is a
 * justification whose predicate is not the thing it justifies.
 *
 * The tests below are platform-independent: they drive the same predicate on every platform/state
 * combination rather than only the one this runner happens to be.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const isolate = require('../core/plugin-isolate');
const SystemHealth = require('../core/system-health');

test('the status mapping never claims REFUSING for a posture that starts plugins', () => {
    // THE MATRIX, not this host. The first version of this file asked the live host — and this host is
    // the exempt one, so the `wouldRefuse` branch and the exempt branch each produced a correct answer
    // and masked the absence of the other. Removing either fix left the suite green. Every combination
    // is driven here so each branch is individually load-bearing.
    const P = (o: Partial<Record<string, any>>) => ({
        wouldRefuse: false, exempt: false, confined: false, requireHardening: true, ...o,
    });

    // Policy ON, host not confined, but the launcher exempts it → plugins RUN. Never 'REFUSING'.
    const exemptCase = SystemHealth.sandboxStatusFor({
        effective: 'disabled', requireHardening: true, posture: P({ exempt: true }),
    });
    assert.strictEqual(exemptCase.status, 'NOT_HARDENED_EXEMPT',
        'a host that starts plugins unconfined under a hardening policy must be named, never reported as refusing');
    assert.strictEqual(exemptCase.hardeningExempt, true);

    // Policy ON and the launcher really does refuse → 'REFUSING' is the truth.
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'disabled', requireHardening: true, posture: P({ wouldRefuse: true }),
    }).status, 'REFUSING');

    // Policy OFF: degraded and not-hardened keep their own words.
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'degraded', requireHardening: false, posture: P({ requireHardening: false }),
    }).status, 'DEGRADED');
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'disabled', requireHardening: false, posture: P({ requireHardening: false }),
    }).status, 'NOT_HARDENED');

    // An active kernel floor outranks everything else.
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'active', requireHardening: true, posture: P({ confined: true }),
    }).status, 'OK');

    // Before the first probe, say so rather than guessing either way.
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'unknown', requireHardening: true, posture: null,
    }).status, 'UNKNOWN');

    // No posture available at all (isolate module unloadable): fall back to the policy, which is the
    // conservative direction, and never to silence.
    assert.strictEqual(SystemHealth.sandboxStatusFor({
        effective: 'disabled', requireHardening: true, posture: null,
    }).status, 'REFUSING');
});

test('health never claims REFUSING while the launcher would start a plugin', async () => {
    await isolate.probePlatformConfinement();
    const posture = isolate.isolatedLaunchPosture();
    const health = SystemHealth.checkSandbox();

    if (health.status === 'REFUSING') {
        assert.strictEqual(posture.wouldRefuse, true,
            `health reports REFUSING but the launcher would START an isolated plugin (state='${posture.state}', nativeRequired=${posture.nativeRequired}). `
            + 'This is the defect: the surface is reporting the policy, not the decision.');
    }
    if (posture.wouldRefuse) {
        assert.strictEqual(health.status, 'REFUSING',
            `the launcher would refuse (${posture.reason}) but health reports '${health.status}'`);
    }
});

test('an exempt-but-unconfined host is named as such, not reported as hardened', async () => {
    await isolate.probePlatformConfinement();
    const posture = isolate.isolatedLaunchPosture();
    const health = SystemHealth.checkSandbox();

    if (posture.exempt && !posture.confined) {
        assert.strictEqual(health.hardeningExempt, true,
            'a host whose policy demands hardening, whose kernel confinement is not active, and which starts plugins anyway must say so');
        assert.strictEqual(health.status, 'NOT_HARDENED_EXEMPT');
        assert.match(String(health.postureNote || ''), /WITHOUT the kernel floor/,
            'the note must state the consequence in plain words, not only the mechanism state');
    }
    // Whatever the host, the two must agree about whether plugins are confined.
    assert.strictEqual(health.confined, posture.confined);
    assert.strictEqual(health.launchesRefused, posture.wouldRefuse);
});

test('the exemption is exactly one case, and it is stated', () => {
    // If this list ever grows, it grows deliberately: every entry is a host where the operator asked
    // for hardening and does not get it.
    const exempt: string[] = [];
    for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
        for (const tsNode of [true, false]) {
            const required = isolate.__nativeSandboxRequired({ configured: true, platform, tsNode });
            if (!required) exempt.push(`${platform}/tsNode=${tsNode}`);
        }
    }
    assert.deepStrictEqual(exempt, ['win32/tsNode=true'],
        `requireHardening=ON must be honoured everywhere except the one documented case. Exempt: ${exempt.join(', ')}`);
});

test('with hardening OFF, nothing anywhere claims to be refusing', () => {
    // The other direction of the same confusion: policy off must never read as enforcement on.
    for (const platform of ['linux', 'darwin', 'win32']) {
        for (const tsNode of [true, false]) {
            assert.strictEqual(isolate.__nativeSandboxRequired({ configured: false, platform, tsNode }), false,
                `requireHardening=OFF still demanded the native sandbox on ${platform}/tsNode=${tsNode}`);
        }
    }
});
