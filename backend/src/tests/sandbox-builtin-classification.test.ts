/**
 * EVERY Node builtin must be a DECISION, not a default.
 *
 * `secureModuleFor()` is a deny-list: it returns `undefined` — meaning "hand back the real, unwrapped
 * builtin" — for anything that is not fs / child_process / os / blocked / network-gated. Under a kernel
 * floor that is a defensible shape, but it has one property that does not survive time: **a builtin Node
 * adds tomorrow is permitted today, silently**.
 *
 * That was not hypothetical. Node 25 ships 58 builtins; the policy classified 24. The other 31 were not
 * decided, they were merely unlisted — and the standing instruction was "re-audit the blocklist on every
 * Node bump". An instruction is not a gate. It is carried out by whoever remembers, on the release where
 * they remember, and it had already been forgotten across at least one major version.
 *
 * So the population is DERIVED from `module.builtinModules` rather than restated here, and every member
 * must land in one of the four buckets. A Node upgrade that introduces a module nobody has looked at
 * turns this red, on the upgrade, before it ships — which is the only moment the decision is cheap.
 *
 * This file reads the policy's OWN lists through `classifyBuiltin`. It deliberately does not keep a
 * second copy of them: a copy agrees with itself while the thing it mirrors drifts.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const { classifyBuiltin, BLOCKED_PLUGIN_MODULES, NETWORK_MODULES, REVIEWED_SAFE_BUILTINS } = require('../core/secure-require');

/** Public builtins, `node:` stripped, internals (`_http_common`, …) excluded. */
function publicBuiltins(): string[] {
    const list = require('module').builtinModules as string[];
    return [...new Set(list.filter((m) => !m.startsWith('_')).map((m) => m.replace(/^node:/, '')))].sort();
}

test('the builtin population is being read at all', () => {
    // A derived gate whose population collapses to nothing passes forever while checking nothing.
    const all = publicBuiltins();
    assert.ok(all.length >= 40, `module.builtinModules yielded only ${all.length} names — the enumeration is broken, so this file's verdict is meaningless`);
    assert.ok(all.includes('fs') && all.includes('child_process'), 'the enumeration is missing modules that certainly exist');
});

test('every Node builtin is classified by the plugin module policy', () => {
    const unclassified = publicBuiltins().filter((m) => classifyBuiltin(m) === 'unclassified');
    assert.deepStrictEqual(unclassified, [],
        `these builtins exist on Node ${process.version} and the plugin module policy has no opinion about them, so a plugin gets the real module unwrapped:\n  `
        + unclassified.join('\n  ')
        + '\n\nDecide each one: add it to BLOCKED_PLUGIN_MODULES, NETWORK_MODULES, the interception set, or '
        + 'REVIEWED_SAFE_BUILTINS with the reason it cannot reach outside the process.');
});

test('the dangerous builtins are blocked, and stay blocked', () => {
    // Named individually because each was added for a specific demonstrated escape; a regression that
    // dropped one would otherwise only surface as a missing entry in a list nobody reads.
    for (const m of ['worker_threads', 'vm', 'module', 'inspector', 'repl', 'v8', 'wasi', 'cluster', 'async_hooks', 'diagnostics_channel', 'trace_events', 'sqlite', 'test']) {
        assert.strictEqual(classifyBuiltin(m), 'blocked', `'${m}' is no longer blocked for plugins`);
        // The `node:` form and the submodule form must resolve the same way — exact-string matching
        // missed `inspector/promises`, whose Session.connectToMainThread() is a worker→host escape.
        assert.strictEqual(classifyBuiltin('node:' + m), 'blocked', `'node:${m}' escapes the blocklist`);
        assert.strictEqual(classifyBuiltin(m + '/promises'), 'blocked', `'${m}/promises' escapes the blocklist`);
    }
});

test('network builtins stay grant-gated, including their submodules', () => {
    for (const m of ['net', 'tls', 'dgram', 'http', 'https', 'http2', 'dns']) {
        assert.strictEqual(classifyBuiltin(m), 'network', `'${m}' is no longer network-gated`);
        assert.strictEqual(classifyBuiltin('node:' + m), 'network');
    }
    assert.strictEqual(classifyBuiltin('dns/promises'), 'network');
});

test('fs, child_process and os are intercepted rather than merely listed', () => {
    for (const m of ['fs', 'fs/promises', 'child_process', 'os', 'node:fs', 'node:os']) {
        assert.strictEqual(classifyBuiltin(m), 'intercepted', `'${m}' is no longer routed through a guarded facade`);
    }
});

test('nothing is in two buckets at once', () => {
    // An entry that is both blocked and reviewed-safe means one of the two lists is a lie, and which one
    // wins is an implementation detail of the order of the checks.
    const overlap = [...REVIEWED_SAFE_BUILTINS].filter(
        (m: string) => BLOCKED_PLUGIN_MODULES.includes(m) || NETWORK_MODULES.has(m) || ['fs', 'child_process', 'os'].includes(m));
    assert.deepStrictEqual(overlap, [],
        `these are listed as reviewed-safe AND as restricted: ${overlap.join(', ')}`);
});

test('the reviewed-safe list does not name modules that do not exist', () => {
    // A stale entry is not harmful, but it is evidence the list is being edited from memory rather than
    // from the platform — which is exactly how the unclassified 31 accumulated.
    const all = new Set(publicBuiltins());
    const ghosts = [...REVIEWED_SAFE_BUILTINS].filter((m: string) => !all.has(m));
    assert.deepStrictEqual(ghosts, [],
        `reviewed-safe names no builtin on Node ${process.version}: ${ghosts.join(', ')}`);
});
