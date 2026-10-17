/**
 * WordJS - Plugin Test Runner
 * Executes unit tests for plugins before activation
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('./module-logger').moduleLogger('core/plugin-test-runner');

const PLUGINS_DIR = path.resolve('./plugins');

// Secret-free env allowlist for spawned test processes — never leak host secrets (JWT_SECRET, DB
// creds, etc.) into a child node process running plugin/test code.
const SAFE_ENV_KEYS = ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'COMSPEC'];
function safeTestEnv() {
    const e: Record<string, string> = {};
    for (const k of SAFE_ENV_KEYS) { if (process.env[k] !== undefined) e[k] = process.env[k] as string; }
    e.NODE_ENV = 'test';
    return e;
}

/**
 * Run tests for a specific plugin
 * @param {string} slug - Plugin slug
 * @returns {Promise<{success: boolean, tests: number, passed: number, failed: number, output: string}>}
 */
async function runPluginTests(_slug: string) {
    // SECURITY: a plugin's test files are arbitrary code; `node --test` runs them on the HOST, OUTSIDE
    // the worker sandbox — a host-RCE vector at activation time. There is no trust tier anymore, so NO
    // plugin's tests are ever executed on the host; every plugin is sandboxed at load time in the worker.
    return { success: true, tests: 0, passed: 0, failed: 0, output: 'Skipped: pre-activation tests are not executed (plugins are sandboxed at load time).', skipped: true };
}

/** The suite's files: TypeScript (`*.test.ts`, the source tree) or compiled (`*.test.js`). */
function coreTestFiles(testsDir: string): string[] {
    if (!fs.existsSync(testsDir)) return [];
    return fs.readdirSync(testsDir)
        .filter((f: string) => f.endsWith('.test.ts') || f.endsWith('.test.js'))
        .sort()
        .map((f: string) => path.join(testsDir, f));
}

/**
 * Run all CMS core tests (`src/tests`), one `node --test` child per file with a secret-free env.
 * TypeScript files run through ts-node, a dev dependency: without it — or without a suite at all, as in
 * a release build — nothing runs and the answer says `skipped`, never a pass of 0 tests.
 * Not called by the installer (routes/setup.ts explains why); kept for operators and tooling.
 * @returns {Promise<{success: boolean, tests: number, passed: number, failed: number, skipped?: boolean, reason?: string}>}
 */
async function runCoreTests(testsDir: string = path.resolve('./src/tests')) {
    const testFiles = coreTestFiles(testsDir);
    if (testFiles.length === 0) {
        return { success: true, tests: 0, passed: 0, failed: 0, skipped: true, reason: 'This install has no core test suite.' };
    }
    const needsTsNode = testFiles.some((f) => f.endsWith('.ts'));
    let tsNodeRegister: string | null = null;
    if (needsTsNode) {
        try {
            tsNodeRegister = require.resolve('ts-node/register/transpile-only', { paths: [path.resolve('.')] });
        } catch {
            return { success: true, tests: 0, passed: 0, failed: 0, skipped: true, reason: 'The core test suite needs the dev dependencies (ts-node); run npm install in backend/.' };
        }
    }

    log.info('🧪 Running CMS core tests...');

    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;

    for (const testFile of testFiles) {
        const result = await new Promise<any>((resolve) => {
            const args = ['--test', '--test-force-exit'];
            if (testFile.endsWith('.ts') && tsNodeRegister) args.push('-r', tsNodeRegister);
            args.push(testFile);
            const child = spawn(process.execPath, args, {
                cwd: path.resolve('.'),
                env: safeTestEnv(),
                stdio: 'pipe'
            });

            let output = '';
            child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
            child.stderr.on('data', (data: Buffer) => { output += data.toString(); });

            child.on('close', (code: number | null) => {
                const testsMatch = output.match(/ℹ tests (\d+)/);
                const passMatch = output.match(/ℹ pass (\d+)/);
                const failMatch = output.match(/ℹ fail (\d+)/);

                resolve({
                    tests: testsMatch ? parseInt(testsMatch[1], 10) : 0,
                    passed: passMatch ? parseInt(passMatch[1], 10) : 0,
                    failed: failMatch ? parseInt(failMatch[1], 10) : 0,
                    success: code === 0
                });
            });
        });

        totalTests += result.tests;
        totalPassed += result.passed;
        totalFailed += result.failed;
    }

    const success = totalFailed === 0;

    if (success) {
        log.info({ totalTests }, `✅ Core tests passed: ${totalPassed}/${totalTests}`);
    } else {
        log.error({ totalFailed, totalTests }, `❌ Core tests failed: ${totalFailed}/${totalTests}`);
    }

    return {
        success,
        tests: totalTests,
        passed: totalPassed,
        failed: totalFailed
    };
}

/**
 * Verify a plugin's tests pass before activation
 * Throws error if tests fail
 */
async function verifyPluginTests(slug: string) {
    const result = await runPluginTests(slug);

    if (!result.success && !result.skipped) {
        throw new Error(
            `🧪 Plugin '${slug}' failed unit tests (${result.failed}/${result.tests} failed).\n` +
            `The plugin cannot be activated until tests pass.\n\n` +
            `Test Output:\n${result.output}`
        );
    }

    return result;
}

module.exports = {
    runPluginTests,
    runCoreTests,
    coreTestFiles,
    verifyPluginTests
};
