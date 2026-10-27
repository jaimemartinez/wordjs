/** Regression tests for the invariant that a network grant never removes native confinement. */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app');
const isolate = require('../core/plugin-isolate');

test('Linux keeps Landlock for a plugin without the network grant', () => {
    const decision = isolate.__linuxFloorDecision({
        platform: 'linux', zeroConf: 'active', netGranted: false,
    });
    assert.strictEqual(decision.layer, 'landlock');
    assert.strictEqual(decision.denyNetwork, true);
});

test('Linux keeps Landlock AND the socket denial when network is granted: the host egress tunnel serves it', () => {
    const decision = isolate.__linuxFloorDecision({
        platform: 'linux', zeroConf: 'active', netGranted: true,
    });
    assert.strictEqual(decision.layer, 'landlock');
    assert.strictEqual(decision.denyNetwork, true);
    assert.match(decision.reason, /host egress tunnel/i);
});

test('Windows and macOS keep their native container for both network policies', () => {
    for (const platform of ['win32', 'darwin']) {
        for (const netGranted of [false, true]) {
            const decision = isolate.__platformLaunchDecision({
                platform, state: 'active', netGranted, tsNode: false,
            });
            assert.strictEqual(decision.use, true);
        }
    }
});

test('an uncertified native mechanism is never claimed as active', () => {
    for (const zeroConf of ['unknown', 'unsupported', 'disabled', 'degraded']) {
        const decision = isolate.__linuxFloorDecision({
            platform: 'linux', zeroConf, netGranted: false,
        });
        assert.strictEqual(decision.layer, 'none');
    }
});
