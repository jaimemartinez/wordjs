/**
 * scripts/test-with-flake-retry.mjs — the CI wrapper that retries `node --test …` for the known
 * `--test-force-exit` deserialize flake, and ONLY for that.
 *
 * Why this file exists: the wrapper is the last thing standing between a runner flake and a red CI
 * run, and until now nothing exercised it. Its `RETRIES` constant used to be declared AFTER the
 * top-level `await main()`, so the retry loop read a `const` still in its temporal dead zone: the
 * first real flake in CI did not get retried, it crashed the wrapper with
 * `ReferenceError: Cannot access 'RETRIES' before initialization`. The exit code was non-zero either
 * way, which is exactly why a naive "did it fail?" assertion would have missed it — so every case
 * below asserts on the wrapper's OWN output (the `::warning::` / `::error::` annotations it prints
 * and the number of times it re-ran the suite), and every case asserts that no `ReferenceError`
 * reached either stream.
 *
 * The wrapper is driven as a CHILD PROCESS against throwaway `.test.mjs` files: that is the only way
 * to cover the retry path, because the decision to retry is made on a real child's TAP stream.
 * `--test-reporter=tap` is mandatory here — Node 23+ defaults to the `spec` reporter even when piped
 * (CI runs Node 22, where TAP is the piped default) and the detector only understands TAP.
 *
 * Not covered here: importing `onlyDeserializeFlake` in-process. The suite runs under
 * `-r ts-node/register/transpile-only` with `module: commonjs`, which rewrites `await import()` into
 * `require()`, and `require()` cannot load the wrapper's `.mjs`. The three spawn cases below cover
 * the detector through the wrapper anyway.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPER_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'test-with-flake-retry.mjs');

// Copied verbatim from the wrapper's own console.warn/console.error templates. If somebody reworks
// the annotations, these break loudly rather than silently stopping to prove anything.
const RETRY_WARNING_1 = '::warning::node:test hit the known --test-force-exit deserialize flake (every failure was the runner, not an assertion) — retrying the suite (attempt 1 of 2).';
const RETRY_WARNING_2 = '::warning::node:test hit the known --test-force-exit deserialize flake (every failure was the runner, not an assertion) — retrying the suite (attempt 2 of 2).';
const PERSISTED_ERROR = '::error::the --test-force-exit deserialize flake persisted across 2 retries — this is a node:test runner problem, not a failed assertion, but the suite could not be certified this run.';

/**
 * The environment the wrapper must be spawned in. THIS file runs inside a node:test child process,
 * which exports `NODE_TEST_CONTEXT` (and friends) to say "you are already inside a test run". If that
 * leaks into the wrapper, the `node --test` it spawns decides it is a nested runner, prints
 * `run() is being called recursively within a test file. skipping running files.` and emits NOTHING
 * on stdout — so the detector would see an empty TAP stream and every case here would fail for a
 * reason that has nothing to do with the wrapper. Scrub the whole `NODE_TEST_*` family.
 */
function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('NODE_TEST_')) delete env[key];
    }
    return env;
}

interface WrapperRun {
    status: number | null;
    stdout: string;
    stderr: string;
    attempts: number;
}

/**
 * Write `body` to a throwaway `.test.mjs`, run the wrapper over it, and return what the wrapper
 * emitted. `attempts` counts the child suites the wrapper actually ran: each `node --test` child
 * opens its report with a fresh `TAP version 13` line, so 1 means "no retry" and 3 means
 * "first run plus both retries".
 */
function runWrapper(body: string): WrapperRun {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-flake-'));
    try {
        const file = path.join(dir, 'probe.test.mjs');
        fs.writeFileSync(file, body, 'utf8');
        const res = spawnSync(
            process.execPath,
            [
                WRAPPER_PATH,
                '--test-force-exit',
                '--test-reporter=tap',
                '--test-reporter-destination=stdout',
                file,
            ],
            { encoding: 'utf8', timeout: 120000, env: childEnv() },
        );
        const stdout = res.stdout || '';
        const stderr = res.stderr || '';
        return { status: res.status, stdout, stderr, attempts: (stdout.match(/TAP version 13/g) || []).length };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const FLAKE_SUITE = [
    "import { test } from 'node:test';",
    "test('runner flake', () => {",
    "    throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');",
    '});',
    '',
].join('\n');

const REAL_FAILURE_SUITE = [
    "import { test } from 'node:test';",
    "test('real failure', () => {",
    "    throw new Error('assertion failed for real');",
    '});',
    '',
].join('\n');

const PASSING_SUITE = [
    "import { test } from 'node:test';",
    "test('honest pass', () => {});",
    '',
].join('\n');

describe('scripts/test-with-flake-retry.mjs', () => {
    it('retries a pure deserialize flake twice, then reports it as the runner\'s fault', () => {
        const run = runWrapper(FLAKE_SUITE);

        // The retry path must have been REACHED — a crash on the way there (the TDZ regression) also
        // exits non-zero, so the annotations, not the exit code, are the evidence.
        assert.ok(
            run.stderr.includes(RETRY_WARNING_1),
            `wrapper never announced retry 1 of 2.\nstderr:\n${run.stderr}`,
        );
        assert.ok(
            run.stderr.includes(RETRY_WARNING_2),
            `wrapper never announced retry 2 of 2.\nstderr:\n${run.stderr}`,
        );
        assert.strictEqual(run.attempts, 3, 'the wrapper must run the suite once and retry it twice');
        assert.ok(
            run.stderr.includes(PERSISTED_ERROR),
            `wrapper did not blame the runner after the retries were exhausted.\nstderr:\n${run.stderr}`,
        );

        // A flake that never clears is still a failure: the wrapper must not fake success.
        assert.strictEqual(run.status, 1);

        assert.ok(
            !`${run.stdout}${run.stderr}`.includes('ReferenceError'),
            `the wrapper crashed instead of retrying.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
    });

    it('never retries a real failure', () => {
        const run = runWrapper(REAL_FAILURE_SUITE);

        assert.ok(
            !run.stderr.includes('::warning::'),
            `a real assertion failure was treated as a flake.\nstderr:\n${run.stderr}`,
        );
        assert.strictEqual(run.attempts, 1, 'a real failure must be surfaced on the first attempt');
        assert.ok(run.stdout.includes('not ok'), `the real failure was not surfaced.\nstdout:\n${run.stdout}`);
        assert.notStrictEqual(run.status, 0, 'a real failure must not exit 0');
        assert.ok(
            !`${run.stdout}${run.stderr}`.includes('ReferenceError'),
            `the wrapper crashed on the non-retry path.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
    });

    it('passes a green suite straight through with exit 0 and no annotations', () => {
        const run = runWrapper(PASSING_SUITE);

        assert.strictEqual(run.status, 0, `a passing suite must exit 0.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
        assert.strictEqual(run.attempts, 1, 'a passing suite must not be re-run');
        assert.ok(!run.stderr.includes('::warning::'), `a green run must not warn.\nstderr:\n${run.stderr}`);
        assert.ok(!run.stderr.includes('::error::'), `a green run must not error.\nstderr:\n${run.stderr}`);
        assert.ok(
            !`${run.stdout}${run.stderr}`.includes('ReferenceError'),
            `the wrapper crashed on the happy path.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
    });
});
