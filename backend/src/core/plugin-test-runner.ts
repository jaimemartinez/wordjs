/**
 * WordJS - Plugin Test Runner
 * Executes unit tests for plugins before activation
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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
async function runPluginTests(slug) {
    const pluginPath = path.join(PLUGINS_DIR, slug);
    const testsDir = path.join(pluginPath, 'tests');

    // SECURITY: a plugin's test files are arbitrary code; `node --test` runs them on the HOST, OUTSIDE
    // the worker sandbox. For UNTRUSTED plugins that is a host-RCE vector at activation time, so we do
    // NOT execute them — untrusted plugins are sandboxed at load time in the worker instead. Only
    // operator-trusted plugins (full-Node by design) get the pre-activation test run.
    let trusted = false;
    try { trusted = require('./plugin-trust').isTrusted(slug); } catch { /* default: untrusted */ }
    if (!trusted) {
        return { success: true, tests: 0, passed: 0, failed: 0, output: 'Skipped: pre-activation tests are not executed for untrusted plugins (they are sandboxed at load time).', skipped: true };
    }

    // Check if tests directory exists
    if (!fs.existsSync(testsDir)) {
        // No tests = pass by default (optional tests)
        return {
            success: true,
            tests: 0,
            passed: 0,
            failed: 0,
            output: 'No tests found (tests/ directory not present)',
            skipped: true
        };
    }

    // Find test files
    const testFiles = fs.readdirSync(testsDir)
        .filter(f => f.endsWith('.test.js'))
        .map(f => path.join(testsDir, f));

    if (testFiles.length === 0) {
        return {
            success: true,
            tests: 0,
            passed: 0,
            failed: 0,
            output: 'No test files found in tests/',
            skipped: true
        };
    }

    console.log(`🧪 Running tests for plugin '${slug}'...`);

    // Run tests
    return new Promise<any>((resolve) => {
        const args = ['--test', ...testFiles];
        const child = spawn('node', args, {
            cwd: pluginPath,
            stdio: 'pipe',
            env: safeTestEnv()  // secret-free allowlist (no host secrets leak into the test process)
        });

        let output = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            output += data.toString();
        });

        child.on('close', (code) => {
            // Parse test results from output
            const testsMatch = output.match(/ℹ tests (\d+)/);
            const passMatch = output.match(/ℹ pass (\d+)/);
            const failMatch = output.match(/ℹ fail (\d+)/);

            const tests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
            const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
            const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

            const success = code === 0 && failed === 0;

            if (success) {
                console.log(`   ✅ All tests passed (${passed}/${tests})`);
            } else {
                console.error(`   ❌ Tests failed (${failed}/${tests})`);
            }

            resolve({
                success,
                tests,
                passed,
                failed,
                output,
                skipped: false
            });
        });

        child.on('error', (err) => {
            console.error(`   ❌ Failed to run tests: ${err.message}`);
            resolve({
                success: false,
                tests: 0,
                passed: 0,
                failed: 0,
                output: `Error executing tests: ${err.message}`,
                skipped: false
            });
        });
    });
}

/**
 * Run all CMS core tests
 * @returns {Promise<{success: boolean, tests: number, passed: number, failed: number}>}
 */
async function runCoreTests() {
    const testsDir = path.resolve('./src/tests');

    if (!fs.existsSync(testsDir)) {
        return { success: true, tests: 0, passed: 0, failed: 0 };
    }

    const testFiles = fs.readdirSync(testsDir)
        .filter(f => f.endsWith('.test.js'))
        .map(f => path.join(testsDir, f));

    if (testFiles.length === 0) {
        return { success: true, tests: 0, passed: 0, failed: 0 };
    }

    console.log('🧪 Running CMS core tests...');

    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;

    for (const testFile of testFiles) {
        const result = await new Promise<any>((resolve) => {
            const child = spawn('node', ['--test', testFile], {
                cwd: path.resolve('.'),
                stdio: 'pipe'
            });

            let output = '';
            child.stdout.on('data', (data) => { output += data.toString(); });
            child.stderr.on('data', (data) => { output += data.toString(); });

            child.on('close', (code) => {
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
        console.log(`✅ Core tests passed: ${totalPassed}/${totalTests}`);
    } else {
        console.error(`❌ Core tests failed: ${totalFailed}/${totalTests}`);
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
async function verifyPluginTests(slug) {
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
    verifyPluginTests
};
