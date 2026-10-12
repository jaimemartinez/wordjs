/**
 * Unit test for the cross-node plugin-propagation handler (coherence.handlePluginChange) and the
 * option-change handler (coherence.handleOptionChange).
 * No Redis needed — invokes the handlers directly with crafted messages and asserts they dispatch
 * load/unload/reload for OTHER nodes' changes, SKIP this node's own publish (origin === our HOLDER),
 * ignore malformed/incomplete messages without throwing, and re-read the grant/egress maps on the
 * `plugin_grants` / `plugin_egress_hosts` option changes, respawning only children whose spawn-time
 * policy is stale.
 */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app');

const tick = () => new Promise((r) => setTimeout(r, 25));

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

// The two cases below stub the policy store and the isolate registry, so they pin only the DECISION a
// node takes (respawn a running child whose spawn-time policy is stale, leave a current one alone). The
// outcome across two real nodes — the real routes on one, a real child respawned on the other, with the
// bus delivering, dropping, or reconnecting — is plugin-policy-multinode.test.ts.
function stubPolicyAndIsolates(state: { current: Record<string, string>; spawned: Record<string, string> }) {
    const perms = require('../core/plugin-permissions');
    const isolate = require('../core/plugin-isolate');
    const calls: any[] = [];
    const orig = {
        loadGrants: perms.loadGrants, loadEgressHosts: perms.loadEgressHosts, policyFingerprint: perms.policyFingerprint,
        isIsolated: isolate.isIsolated, reloadIsolatedPlugin: isolate.reloadIsolatedPlugin, listIsolates: isolate.listIsolates,
        spawnPolicyFingerprint: isolate.spawnPolicyFingerprint, awaitIsolateSettled: isolate.awaitIsolateSettled,
    };
    perms.loadGrants = () => { calls.push('loadGrants'); return Promise.resolve(); };
    perms.loadEgressHosts = () => { calls.push('loadEgressHosts'); return Promise.resolve(); };
    perms.policyFingerprint = (slug: string) => state.current[slug] || '[]';
    isolate.isIsolated = (slug: string) => Object.prototype.hasOwnProperty.call(state.spawned, slug);
    isolate.listIsolates = () => Object.keys(state.spawned);
    isolate.spawnPolicyFingerprint = (slug: string) => state.spawned[slug];
    isolate.awaitIsolateSettled = () => Promise.resolve();
    isolate.reloadIsolatedPlugin = (slug: string) => {
        calls.push(['respawn', slug]);
        state.spawned[slug] = state.current[slug] || '[]'; // a fresh child is born with the current policy
        return Promise.resolve();
    };
    return {
        calls,
        restore: () => {
            Object.assign(perms, { loadGrants: orig.loadGrants, loadEgressHosts: orig.loadEgressHosts, policyFingerprint: orig.policyFingerprint });
            Object.assign(isolate, {
                isIsolated: orig.isIsolated, reloadIsolatedPlugin: orig.reloadIsolatedPlugin, listIsolates: orig.listIsolates,
                spawnPolicyFingerprint: orig.spawnPolicyFingerprint, awaitIsolateSettled: orig.awaitIsolateSettled,
            });
        },
    };
}

test('coherence.handlePluginChange: a cross-node "reload" re-reads the policy and respawns the child only if its policy is stale', async () => {
    const coherence = require('../core/coherence');
    const { HOLDER } = require('../core/dist-lock');
    const state = { current: { iso: '["new"]', fresh: '["same"]' } as Record<string, string>, spawned: { iso: '["old"]', fresh: '["same"]' } as Record<string, string> };
    const s = stubPolicyAndIsolates(state);
    try {
        coherence.handlePluginChange(JSON.stringify({ slug: 'iso', action: 'reload', origin: 'other-node:1:abc' }));
        await tick();
        assert.deepStrictEqual(s.calls, ['loadGrants', 'loadEgressHosts', ['respawn', 'iso']],
            'both policies are re-read, THEN the child spawned under the old policy is respawned');
        assert.strictEqual(state.spawned.iso, '["new"]', 'the running child now carries the current policy');

        // A child whose spawn-time policy is already current is left alone (no needless restart), and a
        // slug not running on this node only gets the maps refreshed.
        s.calls.length = 0;
        coherence.handlePluginChange(JSON.stringify({ slug: 'fresh', action: 'reload', origin: 'other-node:1:abc' }));
        coherence.handlePluginChange(JSON.stringify({ slug: 'not-here', action: 'reload', origin: 'other-node:1:abc' }));
        await tick();
        assert.deepStrictEqual([...s.calls].sort(), ['loadEgressHosts', 'loadEgressHosts', 'loadGrants', 'loadGrants'], 'maps re-read twice, nothing respawned');

        // This node's OWN publish is skipped (it already applied the change locally).
        s.calls.length = 0;
        state.current.iso = '["newer"]';
        coherence.handlePluginChange(JSON.stringify({ slug: 'iso', action: 'reload', origin: HOLDER }));
        await tick();
        assert.deepStrictEqual(s.calls, [], 'self-origin reload must be skipped');
    } finally {
        s.restore();
    }
});

test('coherence.handleOptionChange: plugin_grants / plugin_egress_hosts re-read the policy and reconcile every running child', async () => {
    const coherence = require('../core/coherence');
    const state = { current: { a: '["g2"]', b: '["same"]' } as Record<string, string>, spawned: { a: '["g1"]', b: '["same"]' } as Record<string, string> };
    const s = stubPolicyAndIsolates(state);
    try {
        await coherence.handleOptionChange('plugin_grants');
        assert.deepStrictEqual(s.calls, ['loadGrants', 'loadEgressHosts', ['respawn', 'a']],
            'a grants change re-reads both maps and respawns only the child whose policy changed');
        s.calls.length = 0;
        state.current.b = '["h2"]';
        await coherence.handleOptionChange('plugin_egress_hosts');
        assert.deepStrictEqual(s.calls, ['loadGrants', 'loadEgressHosts', ['respawn', 'b']]);
        s.calls.length = 0;
        await coherence.handleOptionChange('some_unrelated_option'); // must touch neither map nor any child
        assert.deepStrictEqual(s.calls, []);
    } finally {
        s.restore();
    }
});

// ── One slow child must not stretch the bound for every other child ────────────────────────────────────
// A respawn waits for the new child to report ready — up to plugin-isolate's READY_TIMEOUT_MS (60 s). The
// cases below hold chosen respawns open at a gate and look at what happens to the OTHER children.

function gateFor() {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    return { open, opened };
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return pred();
}

/** stubPolicyAndIsolates, with the respawn of each slug in `slow` held until its gate opens. */
function stubWithSlowRespawns(state: { current: Record<string, string>; spawned: Record<string, string> }, slow: string[]) {
    const s = stubPolicyAndIsolates(state);
    const isolate = require('../core/plugin-isolate');
    const gates = new Map(slow.map((slug) => [slug, gateFor()]));
    const starts: Record<string, number> = {};
    let inFlight = 0;
    let peak = 0;
    isolate.reloadIsolatedPlugin = async (slug: string) => {
        starts[slug] = (starts[slug] || 0) + 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
            const g = gates.get(slug);
            if (g) await g.opened;
            s.calls.push(['respawn', slug]);
            state.spawned[slug] = state.current[slug] || '[]';
        } finally {
            inFlight -= 1;
        }
    };
    return { ...s, gates, starts, peak: () => peak, openAll: () => { for (const g of gates.values()) g.open(); } };
}

test('a re-sync respawns every stale child on its own: one slow respawn does not hold back the others', async () => {
    const coherence = require('../core/coherence');
    const state = {
        current: { slow: '["new"]', b: '["new"]', c: '["new"]' } as Record<string, string>,
        spawned: { slow: '["old"]', b: '["old"]', c: '["old"]' } as Record<string, string>, // 'slow' comes first
    };
    const s = stubWithSlowRespawns(state, ['slow']);
    try {
        const resync = coherence.resyncPluginPolicy();
        const othersDone = await until(() => state.spawned.b === '["new"]' && state.spawned.c === '["new"]', 3000);
        assert.ok(othersDone, `b and c still run their old (revoked) policy while 'slow' is respawning: ${JSON.stringify(state.spawned)}`);
        assert.strictEqual(state.spawned.slow, '["old"]', 'control: the slow respawn is still in progress');
        s.openAll();
        assert.deepStrictEqual((await resync).sort(), ['b', 'c', 'slow']);
    } finally {
        s.openAll();
        s.restore();
    }
});

test('the periodic re-sync keeps detecting changes while a slow respawn is in progress, and does not pile up behind it', async () => {
    const coherence = require('../core/coherence');
    const plugins = require('../core/plugins');
    const origReconcile = plugins.reconcileDeactivatedPlugins;
    plugins.reconcileDeactivatedPlugins = async () => [];
    const state = {
        current: { slow: '["new"]', b: '["same"]' } as Record<string, string>,
        spawned: { slow: '["old"]', b: '["same"]' } as Record<string, string>,
    };
    const s = stubWithSlowRespawns(state, ['slow']);
    try {
        coherence.initCoherence({ policyResyncMs: 40 });
        assert.ok(await until(() => (s.starts.slow || 0) === 1, 3000), 'precondition: a tick started respawning the slow child');
        // Meanwhile, another node changes b's policy and the broadcast is lost: only a tick can catch it.
        state.current.b = '["revoked"]';
        assert.ok(await until(() => state.spawned.b === '["revoked"]', 3000),
            'no tick re-read the policy while the slow respawn was in progress: b keeps its revoked policy');
        await new Promise((r) => setTimeout(r, 300)); // several more ticks while 'slow' is still held
        assert.strictEqual(s.starts.slow, 1, 'the slow child was respawned again although its respawn was still running');
        s.openAll();
        assert.ok(await until(() => state.spawned.slow === '["new"]', 3000));
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(s.starts.slow, 1, 'the ticks queued behind the slow respawn each respawned it again');
    } finally {
        coherence.stopCoherence();
        s.openAll();
        s.restore();
        plugins.reconcileDeactivatedPlugins = origReconcile;
    }
});

test('stale children are respawned side by side, but never more than MAX_CONCURRENT_RESPAWNS at once', async () => {
    const coherence = require('../core/coherence');
    const slugs = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const state = { current: {} as Record<string, string>, spawned: {} as Record<string, string> };
    for (const slug of slugs) { state.current[slug] = '["new"]'; state.spawned[slug] = '["old"]'; }
    const s = stubWithSlowRespawns(state, slugs);
    try {
        const resync = coherence.resyncPluginPolicy();
        assert.ok(await until(() => s.peak() >= 2, 3000), `only ${s.peak()} respawn ran at a time: one slow child holds back the rest`);
        const max = coherence.MAX_CONCURRENT_RESPAWNS;
        assert.ok(max > 1 && max < slugs.length, 'precondition: the bound is between 1 and the number of children');
        assert.ok(await until(() => s.peak() >= max, 3000), `only ${s.peak()} respawns ran at once (bound ${max})`);
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(s.peak(), max, `${s.peak()} respawns ran at once (bound ${max})`);
        s.openAll();
        assert.deepStrictEqual((await resync).sort(), slugs);
        assert.ok(slugs.every((slug) => state.spawned[slug] === '["new"]'));
    } finally {
        s.openAll();
        s.restore();
    }
});
