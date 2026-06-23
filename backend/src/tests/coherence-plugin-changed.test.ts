/**
 * Unit test for the cross-node plugin-propagation handler (coherence.handlePluginChange).
 * No Redis needed — invokes the handler directly with crafted messages and asserts it dispatches
 * load/unload for OTHER nodes' changes, SKIPS this node's own publish (origin === our HOLDER), and
 * ignores malformed/incomplete messages without throwing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app');

test('coherence.handlePluginChange: dispatches cross-node activate/deactivate, skips self-origin + junk', () => {
    const coherence = require('../core/coherence');
    const plugins = require('../core/plugins');
    const { HOLDER } = require('../core/dist-lock');

    const calls: any[] = [];
    const origLoad = plugins.loadOnePlugin;
    const origUnload = plugins.unloadOnePlugin;
    plugins.loadOnePlugin = (slug: string) => { calls.push(['load', slug]); return Promise.resolve(true); };
    plugins.unloadOnePlugin = (slug: string) => { calls.push(['unload', slug]); return true; };
    try {
        coherence.handlePluginChange(JSON.stringify({ slug: 'demo', action: 'activate', origin: 'other-node:1:abc' }));
        coherence.handlePluginChange(JSON.stringify({ slug: 'demo2', action: 'deactivate', origin: 'other-node:1:abc' }));
        coherence.handlePluginChange(JSON.stringify({ slug: 'self', action: 'activate', origin: HOLDER })); // our own publish → skip
        coherence.handlePluginChange('{ not json');                                   // malformed → ignore
        coherence.handlePluginChange(JSON.stringify({ action: 'activate' }));          // no slug → ignore
        coherence.handlePluginChange(JSON.stringify({ slug: 'x' }));                   // no action → ignore
        coherence.handlePluginChange(JSON.stringify({ slug: 'y', action: 'bogus', origin: 'n' })); // unknown action → ignore

        assert.deepStrictEqual(calls, [['load', 'demo'], ['unload', 'demo2']],
            'only cross-node activate/deactivate dispatch; self-origin, malformed and unknown actions are skipped');
    } finally {
        plugins.loadOnePlugin = origLoad;
        plugins.unloadOnePlugin = origUnload;
    }
});
