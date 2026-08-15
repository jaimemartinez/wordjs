/**
 * Subprocess harness for the IPC-frame containment guard (plugin-isolate-ipc-frame-guard.test.ts).
 *
 * WHY A SEPARATE PROCESS. The guard is a process-level uncaughtException listener. It cannot be proven
 * from inside a `node --test` test, because node:test installs its OWN uncaughtException listener that
 * marks the running test failed on ANY uncaught throw — even one our guard swallows. So the test spawns
 * THIS harness instead and checks its EXIT CODE: the malformed-frame throw (or its containment) happens
 * here, in a plain process with no node:test runner, where the outcome is a clean 0 (guard held) or 1
 * (guard absent → the real Node fatal path).
 *
 * It uses the REAL guard from the compiled dist (argv[2] = path to dist/core/plugin-isolate), so a
 * regression in the shipped guard makes this harness exit 1 and the test fail. POSIX only: fd 3 is the
 * IPC byte pipe there, so the child's raw write injects a genuine misaligned frame. On Windows the IPC
 * is a named-pipe handle and the raw write is a harmless no-op, so the harness exits 0 trivially — the
 * test documents that it cannot mutation-prove there.
 */
'use strict';
const { spawn } = require('child_process');

const isolatePath = process.argv[2];
// `mutate` (argv[3] === 'nogaurd') deliberately does NOT install the guard, to prove the harness DOES
// crash without it — the negative control the test uses to confirm it is not vacuous.
const installGuard = process.argv[3] !== 'noguard';

if (installGuard) {
    const isolate = require(isolatePath);
    isolate.__retainIpcFrameGuard(); // install the real, shipped guard on THIS process
}

// A grandchild that attaches advanced IPC, sends one valid frame, then writes RAW misaligned bytes to
// fd 3: a 4-byte big-endian length header claiming 8 bytes, then 8 bytes whose first byte is not the V8
// version tag — exactly what a truncated / interleaved / foreign frame looks like to the advanced parser,
// which then throws "Unable to deserialize cloned data …" in THIS (parent) process's channel reader.
const CHILD_SRC = [
    'const fs = require("fs");',
    'process.send({ ready: 1 }, () => {',
    '  const buf = Buffer.from([0x00,0x00,0x00,0x08, 0x41,0x42,0x43,0x44,0x45,0x46,0x47,0x48]);',
    '  try { fs.writeSync(3, buf); } catch (e) {}',
    '  setTimeout(() => process.exit(0), 300);',
    '});',
].join('\n');

const child = spawn(process.execPath, ['-e', CHILD_SRC], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});

let done = false;
const finish = () => {
    if (done) return;
    done = true;
    try { child.kill('SIGKILL'); } catch { /* */ }
    // Reaching here means the parent SURVIVED the malformed frame → the guard held. Without the guard
    // the uncaughtException would already have exited this process with code 1 before we got here.
    process.exit(0);
};

child.on('exit', () => setTimeout(finish, 250));
child.on('error', () => setTimeout(finish, 250));
// Hard cap so the harness can never hang the test.
setTimeout(finish, 4000);
