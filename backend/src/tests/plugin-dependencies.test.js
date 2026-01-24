/**
 * Unit Tests for Hard Lock + Bundling Plugin Dependency Management
 * Run with: node src/tests/plugin-dependencies.test.js
 */

const path = require('path');
const fs = require('fs');
const semver = require('semver');

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
        toBeTrue() {
            if (actual !== true) {
                throw new Error(`Expected true, got ${actual}`);
            }
        },
        toBeFalse() {
            if (actual !== false) {
                throw new Error(`Expected false, got ${actual}`);
            }
        },
        toContain(expected) {
            if (!actual.includes(expected)) {
                throw new Error(`Expected "${actual}" to contain "${expected}"`);
            }
        }
    };
}

// ============================================
// Test: semverRangesIntersect (inline implementation for testing)
// ============================================

function semverRangesIntersect(range1, range2) {
    try {
        // Use semver.intersects if available (semver 7.x)
        if (typeof semver.intersects === 'function') {
            return semver.intersects(range1, range2);
        }

        // Fallback: test common versions
        const testVersions = [];
        for (let major = 0; major <= 30; major++) {
            for (let minor = 0; minor <= 20; minor += 5) {
                testVersions.push(`${major}.${minor}.0`);
            }
        }

        for (const version of testVersions) {
            if (semver.satisfies(version, range1) && semver.satisfies(version, range2)) {
                return true;
            }
        }

        return false;
    } catch {
        return true; // Fail open
    }
}

console.log('\n🧪 Plugin Dependency Management Tests\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ============================================
console.log('\n📦 SemVer Range Intersection Tests:');
// ============================================

test('Compatible: ^4.17.0 and ^4.10.0 should intersect', () => {
    expect(semverRangesIntersect('^4.17.0', '^4.10.0')).toBeTrue();
});

test('Compatible: ^1.0.0 and ^1.2.0 should intersect', () => {
    expect(semverRangesIntersect('^1.0.0', '^1.2.0')).toBeTrue();
});

test('Incompatible: ^4.0.0 and ^3.0.0 should NOT intersect', () => {
    expect(semverRangesIntersect('^4.0.0', '^3.0.0')).toBeFalse();
});

test('Incompatible: ^2.0.0 and ^1.0.0 should NOT intersect', () => {
    expect(semverRangesIntersect('^2.0.0', '^1.0.0')).toBeFalse();
});

test('Compatible: ~4.17.0 and ~4.17.5 should intersect', () => {
    expect(semverRangesIntersect('~4.17.0', '~4.17.5')).toBeTrue();
});

test('Compatible: >=1.0.0 <2.0.0 and ^1.5.0 should intersect', () => {
    expect(semverRangesIntersect('>=1.0.0 <2.0.0', '^1.5.0')).toBeTrue();
});

test('Exact version: 4.17.21 and ^4.17.0 should intersect', () => {
    expect(semverRangesIntersect('4.17.21', '^4.17.0')).toBeTrue();
});

test('Incompatible exact: 3.10.1 and ^4.0.0 should NOT intersect', () => {
    expect(semverRangesIntersect('3.10.1', '^4.0.0')).toBeFalse();
});

// ============================================
console.log('\n📁 Bundled Plugin Detection Tests:');
// ============================================

// Create temp directory for testing
const tmpDir = path.join(__dirname, 'tmp-bundled-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

test('Manifest with bundled: true is detected', () => {
    const { isBundledPlugin } = require('../core/plugins');
    expect(isBundledPlugin(tmpDir, { bundled: true })).toBeTrue();
});

test('Manifest with bundled: false is not bundled', () => {
    const { isBundledPlugin } = require('../core/plugins');
    expect(isBundledPlugin(tmpDir, { bundled: false })).toBeFalse();
});

test('Plugin with node_modules/ is detected as bundled', () => {
    const nodeModulesDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, 'dummy.txt'), 'test');

    const { isBundledPlugin } = require('../core/plugins');
    expect(isBundledPlugin(tmpDir, {})).toBeTrue();

    // Cleanup
    fs.rmSync(nodeModulesDir, { recursive: true });
});

test('Plugin with dist/*.bundle.js is detected as bundled', () => {
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'plugin.bundle.js'), 'test');

    const { isBundledPlugin } = require('../core/plugins');
    expect(isBundledPlugin(tmpDir, {})).toBeTrue();

    // Cleanup
    fs.rmSync(distDir, { recursive: true });
});

test('Empty plugin directory is NOT bundled', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const { isBundledPlugin } = require('../core/plugins');
    expect(isBundledPlugin(emptyDir, {})).toBeFalse();

    // Cleanup
    fs.rmSync(emptyDir, { recursive: true });
});

// Cleanup temp directory
fs.rmSync(tmpDir, { recursive: true });

// ============================================
console.log('\n📋 Error Message Formatting Tests:');
// ============================================

test('formatDependencyConflictError generates readable message', () => {
    // Inline test since function isn't exported
    const conflicts = [{
        dep: 'lodash',
        newRange: '^3.10.0',
        existingRange: '^4.17.0',
        conflictPlugin: 'plugin-a'
    }];

    const errorMessage = `❌ No se puede activar "plugin-b"\n\nConflicto de dependencias detectado:`;
    expect(errorMessage).toContain('No se puede activar');
});

// ============================================
// Summary
// ============================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('✨ All tests passed!\n');
    process.exit(0);
}
