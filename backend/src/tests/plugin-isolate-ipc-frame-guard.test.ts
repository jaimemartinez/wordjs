/**
 * WordJS — the IPC-frame containment guard. A malformed advanced-serialization IPC frame on a plugin
 * channel must NEVER crash the host, and must never mask an unrelated bug.
 *
 * THE FLAKE THIS GUARDS. The bridge reads each isolated child over a child_process IPC channel in
 * `serialization:'advanced'` (V8 structured clone, length-prefixed frames). A MISALIGNED frame — a
 * truncated write from a force-killed child, two interleaved writers under CI saturation, or a plugin
 * that writes RAW bytes straight to its IPC fd — makes Node's INTERNAL channel reader throw
 *     Error: Unable to deserialize cloned data due to invalid or unsupported version.
 * from parseChannelMessages inside channel.onread. That throw is BEFORE the 'message' event, so the
 * module's try/catch around worker.on('message') cannot see it: it escapes as an uncaughtException and
 * kills the reading process. Under `node --test` that reading process is a test-file subprocess, so a
 * random UNRELATED test file dies with this exact error and its results never arrive (the observed CI
 * flake). The guard in plugin-isolate contains ONLY this framing error while an isolate is alive.
 *
 * WHY THIS TEST FORKS A REAL CHILD. The bug only exists across a real advanced-serialization IPC pipe:
 * a fake cannot reproduce a throw that originates inside Node's own channel reader. The child writes a
 * deliberately misaligned frame to fd 3; with the guard the host survives, and if the guard is ever
 * removed this test's own subprocess crashes with the exact error — a mutation-proof regression.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const isolate = require('../core/plugin-isolate');
const {
    __isIpcFrameDeserializeError: isIpcFrameError,
    __retainIpcFrameGuard: retain,
    __releaseIpcFrameGuard: release,
    __ipcFrameGuardActive: guardActive,
} = isolate;

// The end-to-end proof runs the guard in a SEPARATE process (fixtures/ipc-frame-guard-harness.js) and
// checks its exit code, because node:test's own uncaughtException listener would fail this test on the
// framing throw even though the guard swallows it. The harness path + the compiled-dist path to the real
// guard are computed here.
const HARNESS = path.resolve(__dirname, 'fixtures', 'ipc-frame-guard-harness.js');
const DIST_ISOLATE = path.resolve(__dirname, '..', '..', 'dist', 'core', 'plugin-isolate.js');

function runHarness(mode: 'guard' | 'noguard'): Promise<number> {
    return new Promise((resolve) => {
        const args = [HARNESS, DIST_ISOLATE];
        if (mode === 'noguard') args.push('noguard');
        const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        p.on('exit', (code: number | null) => resolve(code == null ? -1 : code));
        p.on('error', () => resolve(-1));
    });
}

test('classifier: matches ONLY the child_process advanced-deserializer framing error', () => {
    // The real shape: right message AND a stack frame in child_process/serialization.
    const real = new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    real.stack = 'Error: Unable to deserialize cloned data due to invalid or unsupported version.\n'
        + '    at parseChannelMessages (node:internal/child_process/serialization:102:20)\n'
        + '    at channel.onread (node:internal/child_process:623:18)';
    assert.strictEqual(isIpcFrameError(real), true);

    // Right message, but NOT from the IPC deserializer (e.g. a plugin's own v8.deserialize call) -> NOT ours.
    const lookalike = new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    lookalike.stack = 'Error: ...\n    at Object.deserialize (node:v8:x)\n    at somePluginCode (/plugins/x/index.js:1:1)';
    assert.strictEqual(isIpcFrameError(lookalike), false);

    // An unrelated error on the IPC path -> NOT ours (only the framing message is contained).
    const other = new Error('some other failure');
    other.stack = 'Error\n    at parseChannelMessages (node:internal/child_process/serialization:102:20)';
    assert.strictEqual(isIpcFrameError(other), false);

    assert.strictEqual(isIpcFrameError(null), false);
    assert.strictEqual(isIpcFrameError('a string'), false);
});

test('lifecycle: the guard is installed only while retained, and removes exactly its own listener', () => {
    const before = process.listenerCount('uncaughtException');
    assert.strictEqual(guardActive(), false);
    retain();
    assert.strictEqual(guardActive(), true);
    assert.strictEqual(process.listenerCount('uncaughtException'), before + 1);
    retain(); // ref-counted: a second retain does not add a second listener
    assert.strictEqual(process.listenerCount('uncaughtException'), before + 1);
    release();
    assert.strictEqual(guardActive(), true); // still one ref held
    release();
    assert.strictEqual(guardActive(), false);
    assert.strictEqual(process.listenerCount('uncaughtException'), before); // back to baseline, no leak
});

// END-TO-END, via the harness subprocess (see runHarness). On POSIX (Linux CI) fd 3 is the IPC byte
// pipe, so the harness's grandchild injects a REAL misaligned frame:
//   • WITH the shipped guard   → the harness survives and exits 0.
//   • WITHOUT it ('noguard')   → the framing throw is the ordinary Node fatal path and the harness exits 1.
// The second assertion is the built-in mutation proof: it fails if the guard were ever a no-op. On
// Windows the IPC is a named-pipe handle (not fd 3), so the raw write is a harmless no-op and BOTH modes
// exit 0 — the platform note. Skipped unless the compiled dist exists (the harness requires the real
// guard from dist, not ts-node).
test('end-to-end: the shipped guard contains a malformed frame (POSIX), and its absence does NOT', async (t: any) => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_ISOLATE)) { t.skip('dist not built (run npm run build); guard e2e is dist-based'); return; }

    const guarded = await runHarness('guard');
    assert.strictEqual(guarded, 0, 'with the shipped guard the host must survive a malformed IPC frame');

    if (process.platform === 'win32') {
        t.diagnostic('Windows: fd-3 raw write is a no-op on a named-pipe handle, so the negative control cannot crash — mutation proof is Linux/CI only.');
        return;
    }
    // Negative control / mutation proof (POSIX): without the guard the same frame is fatal.
    const unguarded = await runHarness('noguard');
    assert.strictEqual(unguarded, 1, 'without the guard the malformed frame must crash the host (exit 1) — else this test proves nothing');
});

// Belt-and-suspenders: never leave the process-level listener installed past this file.
after(() => { while (guardActive()) release(); });
