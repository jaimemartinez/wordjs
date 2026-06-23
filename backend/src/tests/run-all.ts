#!/usr/bin/env node
/**
 * WordJS - Test Runner
 * Runs all unit tests and returns status for installer
 * 
 * Usage: node src/tests/run-all.js
 * Exit code 0 = All tests passed
 * Exit code 1 = Some tests failed
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TESTS_DIR = path.join(__dirname);

// Find all test files
const testFiles = fs.readdirSync(TESTS_DIR)
    .filter((f: string) => f.endsWith('.test.js'))
    .map((f: string) => path.join(TESTS_DIR, f));

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║          WordJS Installation - System Verification         ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`📋 Found ${testFiles.length} test suites to run...`);
console.log('');

let totalTests = 0;
let totalPassed = 0;
let totalFailed = 0;
let currentIndex = 0;

function runNextTest() {
    if (currentIndex >= testFiles.length) {
        // All tests complete
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('                      FINAL RESULTS');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`   Total Tests:  ${totalTests}`);
        console.log(`   ✅ Passed:    ${totalPassed}`);
        console.log(`   ❌ Failed:    ${totalFailed}`);
        console.log('═══════════════════════════════════════════════════════════════');

        if (totalFailed === 0) {
            console.log('');
            console.log('🎉 All tests passed! System is ready for use.');
            console.log('');
            process.exit(0);
        } else {
            console.log('');
            console.log('⚠️  Some tests failed. Please review the errors above.');
            console.log('');
            process.exit(1);
        }
        return;
    }

    const testFile = testFiles[currentIndex];
    const testName = path.basename(testFile);

    console.log(`\n▶ Running: ${testName}`);
    console.log('─'.repeat(50));

    const child = spawn('node', ['--test', testFile], {
        stdio: 'pipe',
        cwd: path.join(__dirname, '../..')
    });

    let output = '';

    child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        process.stdout.write(data);
    });

    child.stderr.on('data', (data: Buffer) => {
        output += data.toString();
        process.stderr.write(data);
    });

    child.on('close', (code: number | null) => {
        // Parse results from output
        const testsMatch = output.match(/ℹ tests (\d+)/);
        const passMatch = output.match(/ℹ pass (\d+)/);
        const failMatch = output.match(/ℹ fail (\d+)/);

        if (testsMatch) totalTests += parseInt(testsMatch[1], 10);
        if (passMatch) totalPassed += parseInt(passMatch[1], 10);
        if (failMatch) totalFailed += parseInt(failMatch[1], 10);

        currentIndex++;
        runNextTest();
    });
}

// Start running tests
runNextTest();
