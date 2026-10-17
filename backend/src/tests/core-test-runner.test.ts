/**
 * core/plugin-test-runner runCoreTests — the CMS's own suite, run one `node --test` child per file.
 *
 * It filtered `*.test.js` while the suite is TypeScript (`*.test.ts`), so it never found a file and every
 * caller (the installer) reported "0 tests, OK". Locked here against a throwaway suite:
 *   · `.test.ts` files are found and run (through ts-node), and their counts add up — failures included;
 *   · a directory with no suite is `skipped`, not a pass;
 *   · the child gets the secret-free env allowlist, not the parent's environment.
 * MUTATION PROOF: put the `.test.js`-only filter back and the first case reads 0 tests; drop
 * `env: safeTestEnv()` from the spawn and the secret leaks into the child, failing its own test.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCoreTests, coreTestFiles } = require('../core/plugin-test-runner');

const dirs: string[] = [];
function suite(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-core-tests-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
}

after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('a TypeScript suite is found and run; passes and failures are counted', async () => {
    const dir = suite({
        'a.test.ts': `const { test } = require('node:test');\nconst n: number = 2;\ntest('one', () => {});\ntest('two', () => { if (n !== 2) throw new Error('x'); });\n`,
        'b.test.ts': `const { test } = require('node:test');\ntest('fails', () => { throw new Error('expected failure'); });\n`,
        'notes.ts': `throw new Error('not a test file');\n`,
    });
    assert.deepStrictEqual(coreTestFiles(dir).map((f: string) => path.basename(f)), ['a.test.ts', 'b.test.ts']);
    const r = await runCoreTests(dir);
    assert.strictEqual(r.tests, 3, JSON.stringify(r));
    assert.strictEqual(r.passed, 2);
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.success, false);
    assert.ok(!r.skipped);
});

test('no suite at all is reported as skipped, never as a pass of 0 tests', async () => {
    const r = await runCoreTests(suite({ 'readme.md': 'nothing here' }));
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.tests, 0);
    assert.match(r.reason, /no core test suite/);
    assert.strictEqual((await runCoreTests(path.join(os.tmpdir(), `wjs-missing-${process.pid}-${Date.now()}`))).skipped, true);
});

test('the child runs with the secret-free env allowlist', async () => {
    process.env.WJS_RUNNER_FAKE_SECRET = 'must-not-leak';
    try {
        const dir = suite({
            'env.test.ts': `const { test } = require('node:test');\ntest('no secret', () => { if (process.env.WJS_RUNNER_FAKE_SECRET !== undefined) throw new Error('leaked'); if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV'); });\n`,
        });
        const r = await runCoreTests(dir);
        assert.deepStrictEqual({ tests: r.tests, passed: r.passed, failed: r.failed }, { tests: 1, passed: 1, failed: 0 });
    } finally {
        delete process.env.WJS_RUNNER_FAKE_SECRET;
    }
});
