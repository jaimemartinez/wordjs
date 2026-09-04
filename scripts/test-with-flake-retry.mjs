#!/usr/bin/env node
/**
 * Run `node --test …` and retry ONCE, but only for a specific, known runner FLAKE — never for a real
 * test failure.
 *
 * The flake: with `--test-force-exit`, node:test occasionally cannot deserialize a subprocess's final
 * IPC message when the process is force-exited mid-serialization, and reports the FILE as failed with
 *
 *     not ok N - src/tests/<file>
 *       error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
 *       code: 'ERR_TEST_FAILURE'
 *
 * while the file's own inner suite reported `# fail 0` — i.e. every assertion passed and the runner
 * mishandled the exit. It is a Node bug, not our code; force-exit is needed because these suites leave
 * DB pools, Redis clients and isolate workers open, so dropping the flag would hang the run.
 *
 * THE SAFETY RULE, and it is the whole point: retry ONLY when every failure in the run is this
 * deserialize flake. If there is a single `not ok` that is NOT a deserialize error, or the run reports
 * `# fail` with a real assertion, this is a genuine failure and it is NOT retried — a flake-retry that
 * can swallow a real failure is worse than the flake.
 *
 * Usage: node scripts/test-with-flake-retry.mjs <all the args you'd pass to `node --test …`>
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_TEST_ARGS = process.argv.slice(2);
const FLAKE = 'Unable to deserialize cloned data';

function run() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', ...NODE_TEST_ARGS], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const echo = (b) => { const s = b.toString(); out += s; process.stdout.write(s); };
        child.stdout.on('data', echo);
        child.stderr.on('data', echo);
        child.on('error', (e) => resolve({ code: -1, out: out + '\n' + String(e && e.message || e) }));
        child.on('exit', (code) => resolve({ code, out }));
    });
}

/**
 * Is EVERY failure in this run the deserialize flake, and nothing else? Only then may we retry.
 * A `not ok` line that is not immediately explained by the deserialize error is a real failure.
 */
export function onlyDeserializeFlake(out) {
    if (!out.includes(FLAKE)) return false;                 // this run did not hit the flake at all
    const lines = out.split('\n');
    const notOk = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /^\s*not ok \d+/.test(l));
    if (notOk.length === 0) return false;                   // failed but no `not ok` — unknown shape, do not retry
    // Every `not ok` must be a deserialize-flake failure: the error appears within a few lines below it.
    for (const { i } of notOk) {
        const window = lines.slice(i, i + 6).join('\n');
        if (!window.includes(FLAKE)) return false;          // a real failure sits here — do not retry
    }
    return true;
}

// Only run when invoked directly; importing for a test gets onlyDeserializeFlake without spawning.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
let res = await run();
if (res.code === 0) process.exit(0);

if (onlyDeserializeFlake(res.out)) {
    console.warn('::warning::node:test hit the known --test-force-exit deserialize flake (every failure was the runner, not an assertion) — retrying the suite once.');
    res = await run();
    if (res.code === 0) process.exit(0);
    // Second failure: if it is STILL only the flake, the environment is degraded — report it as such
    // rather than pretending success, but make clear it was the runner, not a test.
    if (onlyDeserializeFlake(res.out)) {
        console.error('::error::the --test-force-exit deserialize flake persisted across a retry — this is a node:test runner problem, not a failed assertion, but the suite could not be certified this run.');
    }
    process.exit(res.code || 1);
}

// Not the flake — a real failure. Do not retry.
process.exit(res.code || 1);
}
