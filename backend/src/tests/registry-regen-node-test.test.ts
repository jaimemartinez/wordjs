/**
 * regenerateRegistry() — the dev-HMR hop that rewrites frontend/src/lib/*Registry.ts after a plugin
 * activate/deactivate/delete — must be INERT under node:test, at the SOURCE, not per test file.
 *
 * Two defects hid behind it, both measured on CI (2026-09-16, PR #347 Backend job):
 *   · the three frontend generators REWRITE registry sources in the working tree — a test that
 *     activates a plugin edited the repo it ran in;
 *   · their output was echoed from the execFile callback with console.log, i.e. asynchronously to
 *     stdout. A node:test child reports results to the runner over stdout as V8-serialized frames;
 *     that write landed inside one, the runner threw "Unable to deserialize cloned data", the whole
 *     test FILE failed with no failed assertion, and scripts/test-with-flake-retry.mjs re-ran the
 *     entire suite twice — 3 × 10 min, past the job's 32-minute timeout.
 *
 * plugin-delete-teardown.test.ts had already met the first defect and worked around it by pinning
 * NODE_ENV=production for its own process. That is a per-file escape hatch, and the next test that
 * forgot it (plugin-orphaned-active.test.ts) tripped the second defect. The guard now lives in
 * regenerateRegistry() itself: NODE_TEST_CONTEXT, which the runner sets in every test child, makes it
 * a no-op before it resolves anything or spawns anything.
 *
 * The test drives the real function: it installs a recording `child_process.execFile` (the module's
 * own import is destructured at load, so the interception has to happen BEFORE routes/plugins is
 * required), calls regenerateRegistry() through the exported test seam, and asserts that nothing was
 * spawned and nothing was written to stdout while the runner's channel was live.
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('regenerateRegistry() spawns nothing and writes nothing to stdout under node:test', async () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'this file only proves anything when run by node:test');

    // Intercept execFile BEFORE the route module binds it.
    const cp = require('child_process');
    const spawned: string[][] = [];
    const realExecFile = cp.execFile;
    cp.execFile = (...args: any[]) => { spawned.push(args.map(String)); return realExecFile.apply(cp, args as any); };

    // Intercept stdout writes made by the module while we drive it.
    const stdoutWrites: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => { stdoutWrites.push(String(chunk)); return realWrite(chunk, ...rest); };

    try {
        const routes = require('../routes/plugins');
        assert.strictEqual(typeof routes.__regenerateRegistryForTests, 'function', 'test seam must be exported');
        routes.__regenerateRegistryForTests();
        // The function resolves the active list asynchronously before spawning; give it real turns.
        await new Promise((r) => setTimeout(r, 300));
    } finally {
        cp.execFile = realExecFile;
        (process.stdout as any).write = realWrite;
    }

    const generatorSpawns = spawned.filter((a) => a.some((s) => /generate-.*-registry\.js|generate-plugin-registry\.js/.test(s)));
    assert.deepStrictEqual(generatorSpawns, [], 'no frontend registry generator may be spawned from a test child');
    const leaked = stdoutWrites.filter((w) => /🔄|Generating plugin registry|Registry unchanged|Script not found/.test(w));
    assert.deepStrictEqual(leaked, [], 'nothing from the regenerator may reach stdout under the runner');
});
