/**
 * Unit Tests for CrashGuard v2.0
 * Run with: node src/tests/crash-guard.test.js
 */

const fs = require('fs');
const path = require('path');

// Test utilities
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (error) {
        console.log(`  ❌ ${name}`);
        console.log(`     Error: ${error.message}`);
        failed++;
    }
}

function expect(actual) {
    return {
        toBe(expected) {
            if (actual !== expected) {
                throw new Error(`Expected ${expected}, got ${actual}`);
            }
        },
        toBeNull() {
            if (actual !== null) {
                throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
            }
        },
        toBeTrue() {
            if (actual !== true) {
                throw new Error(`Expected true, got ${actual}`);
            }
        },
        toBeFalse() {
            if (actual !== false) {
                throw new Error(`Expected false, got ${actual}`);
            }
        }
    };
}

console.log('\n🛡️ CrashGuard v2.0 Tests\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Clean up any existing test files
const DATA_DIR = path.resolve(__dirname, '../../data');
const LOCK_FILE = path.join(DATA_DIR, 'plugin_boot.lock');
const STRIKE_FILE = path.join(DATA_DIR, 'plugin_strikes.json');
const BLAME_FILE = path.join(DATA_DIR, 'runtime_crash.lock');

function cleanupFiles() {
    [LOCK_FILE, STRIKE_FILE, BLAME_FILE].forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { }
    });
}

cleanupFiles();

const CrashGuard = require('../core/crash-guard');

// ============================================
console.log('\n📊 3-Strike Rule Tests:');
// ============================================

test('getStrikes returns 0 for new plugin', () => {
    expect(CrashGuard.getStrikes('test-plugin')).toBe(0);
});

test('addStrike increments counter', () => {
    const strikes = CrashGuard.addStrike('strike-test');
    expect(strikes).toBe(1);
    expect(CrashGuard.getStrikes('strike-test')).toBe(1);
});

test('addStrike accumulates', () => {
    CrashGuard.addStrike('strike-test'); // 2
    CrashGuard.addStrike('strike-test'); // 3
    expect(CrashGuard.getStrikes('strike-test')).toBe(3);
});

test('clearStrikes resets counter', () => {
    CrashGuard.clearStrikes('strike-test');
    expect(CrashGuard.getStrikes('strike-test')).toBe(0);
});

// ============================================
console.log('\n🔒 Boot Lock Tests:');
// ============================================

test('checkPreviousCrash returns null when no lock', () => {
    cleanupFiles();
    expect(CrashGuard.checkPreviousCrash()).toBeNull();
});

test('startLoading creates lock file', () => {
    CrashGuard.startLoading('test-plugin');
    expect(fs.existsSync(LOCK_FILE)).toBeTrue();
});

test('finishLoading clears lock file', () => {
    CrashGuard.finishLoading('test-plugin');
    expect(fs.existsSync(LOCK_FILE)).toBeFalse();
});

test('First crash returns shouldDisable: false', () => {
    cleanupFiles();
    CrashGuard.startLoading('fragile-plugin');
    // Simulate crash - lock file remains

    const result = CrashGuard.checkPreviousCrash();
    expect(result.slug).toBe('fragile-plugin');
    expect(result.strikes).toBe(1);
    expect(result.shouldDisable).toBeFalse();
});

test('Second crash returns shouldDisable: false', () => {
    CrashGuard.startLoading('fragile-plugin');

    const result = CrashGuard.checkPreviousCrash();
    expect(result.strikes).toBe(2);
    expect(result.shouldDisable).toBeFalse();
});

test('Third crash returns shouldDisable: true', () => {
    CrashGuard.startLoading('fragile-plugin');

    const result = CrashGuard.checkPreviousCrash();
    expect(result.strikes).toBe(3);
    expect(result.shouldDisable).toBeTrue();
});

// ============================================
console.log('\n🔍 Stack Trace Analysis Tests:');
// ============================================

test('extractPluginFromStack finds plugin slug', () => {
    const stack = `Error: test
    at Object.<anonymous> (/app/plugins/my-cool-plugin/index.js:15:10)
    at Module._compile (node:internal/modules/cjs/loader:1256:14)`;

    expect(CrashGuard.extractPluginFromStack(stack)).toBe('my-cool-plugin');
});

test('extractPluginFromStack finds theme slug', () => {
    const stack = `Error: test
    at Object.<anonymous> (/app/themes/dark-theme/functions.js:22:5)`;

    expect(CrashGuard.extractPluginFromStack(stack)).toBe('theme:dark-theme');
});

test('extractPluginFromStack returns null for core error', () => {
    const stack = `Error: test
    at Object.<anonymous> (/app/src/core/database.js:100:1)`;

    expect(CrashGuard.extractPluginFromStack(stack)).toBeNull();
});

test('extractPluginFromStack handles Windows paths', () => {
    const stack = `Error: test
    at Object.<anonymous> (C:\\app\\plugins\\windows-plugin\\main.js:5:1)`;

    expect(CrashGuard.extractPluginFromStack(stack)).toBe('windows-plugin');
});

// ============================================
// Cleanup
// ============================================
cleanupFiles();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('✨ All tests passed!\n');
    process.exit(0);
}
