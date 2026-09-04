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

// Capture stdout and stderr SEPARATELY. The flake decision is made on stdout alone, because the whole
// TAP report — the `not ok` line and its indented YAML detail (`failureType:`, `error: '…deserialize…'`)
// — is written to stdout as one contiguous run. Node prints an uncaughtException's stack to STDERR, and
// an earlier version of this wrapper merged both streams into one buffer by arrival order: that stderr
// stack landed BETWEEN the `not ok` line and its `error:` line, pushing the flake marker out of the
// fixed-size window the detector scanned, so a pure flake was judged a real failure and never retried.
// Separate streams cannot interleave; the block below is exactly what the runner emitted, in order.
function run() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', ...NODE_TEST_ARGS], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (b) => { const s = b.toString(); stdout += s; process.stdout.write(s); });
        child.stderr.on('data', (b) => { const s = b.toString(); stderr += s; process.stderr.write(s); });
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + '\n' + String(e && e.message || e) }));
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

const indentOf = (l) => (l.match(/^[ \t]*/)[0] || '').length;

/**
 * Is EVERY failure in this run the deserialize flake, and nothing else? Only then may we retry.
 * Pass the child's STDOUT (the TAP stream); a `not ok` whose YAML detail block does not name the
 * deserialize error is a real failure, and a real failure is never retried.
 */
export function onlyDeserializeFlake(stdout) {
    if (!stdout.includes(FLAKE)) return false;              // this run did not hit the flake at all
    const lines = stdout.split('\n');
    const notOkIdx = [];
    lines.forEach((l, i) => { if (/^\s*not ok \d+/.test(l)) notOkIdx.push(i); });
    if (notOkIdx.length === 0) return false;                // failed but no `not ok` — unknown shape, do not retry
    // Each `not ok`'s explanation is its TAP YAML block: the lines indented MORE than the `not ok`
    // itself, up to the first line that dedents back to (or past) it — which is the next `not ok`, an
    // `ok`, or the `# tests/pass/fail` summary. The block is delimited by INDENT, not a fixed line
    // count, so it can never borrow the next failure's error, and blank lines inside a block are kept.
    for (const start of notOkIdx) {
        const base = indentOf(lines[start]);
        let block = lines[start];
        for (let i = start + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') { block += '\n' + lines[i]; continue; }
            if (indentOf(lines[i]) <= base) break;          // dedent → this failure's block ended
            block += '\n' + lines[i];
        }
        if (!block.includes(FLAKE)) return false;           // this failure is explained by something else — real
    }
    return true;
}

// Only run when invoked directly; importing for a test gets onlyDeserializeFlake without spawning.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

// Up to two retries: the flake is a race in the runner's force-exit teardown, so a fresh run usually
// clears it, and the wrapped suites are small and fast enough that a couple of extra attempts cost
// seconds. A REAL failure exits on the first attempt — the retries only ever apply to a pure flake.
const RETRIES = 2;

async function main() {
let res = await run();
if (res.code === 0) process.exit(0);

let attempt = 0;
while (onlyDeserializeFlake(res.stdout) && attempt < RETRIES) {
    attempt++;
    console.warn(`::warning::node:test hit the known --test-force-exit deserialize flake (every failure was the runner, not an assertion) — retrying the suite (attempt ${attempt} of ${RETRIES}).`);
    res = await run();
    if (res.code === 0) process.exit(0);
}

// Still failing. If it is STILL only the flake, the runner never settled — report it as the runner's
// fault, loudly, rather than pretending success; otherwise fall through and surface the real failure.
if (onlyDeserializeFlake(res.stdout)) {
    console.error(`::error::the --test-force-exit deserialize flake persisted across ${RETRIES} retries — this is a node:test runner problem, not a failed assertion, but the suite could not be certified this run.`);
}
process.exit(res.code || 1);
}
