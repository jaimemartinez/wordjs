/**
 * Unit Tests for Runtime Security Interception
 * Run with: node src/tests/secure-require.test.js
 */

const path = require('path');
const fs = require('fs');

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
        toThrow() {
            // This is for functions that should throw
            throw new Error('toThrow must be used with a function');
        }
    };
}

function expectThrows(fn, msgContains = '') {
    try {
        fn();
        throw new Error('Expected function to throw but it did not');
    } catch (error) {
        if (msgContains && !error.message.includes(msgContains)) {
            throw new Error(`Expected error to contain "${msgContains}" but got: ${error.message}`);
        }
        return true;
    }
}

console.log('\n🛡️ Runtime Security Interception Tests\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ============================================
// Import secure require module
// ============================================

const { createSecureFs, createSecureChildProcess } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

// ============================================
console.log('\n📁 Secure FS Tests (Outside Plugin Context):');
// ============================================

test('Core code can use fs.existsSync without context', () => {
    const secureFs = createSecureFs();
    const result = secureFs.existsSync(__filename);
    expect(result).toBeTrue();
});

test('Core code can use fs.readFileSync without context', () => {
    const secureFs = createSecureFs();
    const content = secureFs.readFileSync(__filename, 'utf8');
    expect(content.includes('Runtime Security')).toBeTrue();
});

// ============================================
console.log('\n🔒 Secure FS Tests (Inside Plugin Context - No Permission):');
// ============================================

test('Plugin without permission blocked from fs.readFileSync', () => {
    const secureFs = createSecureFs();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureFs.readFileSync('/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin without permission blocked from fs.writeFileSync', () => {
    const secureFs = createSecureFs();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureFs.writeFileSync('/tmp/malicious.txt', 'pwned');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin CAN access its own directory', () => {
    const secureFs = createSecureFs();
    const pluginsDir = path.resolve(__dirname, '../../plugins');
    const testPluginDir = path.join(pluginsDir, 'test-own-dir-plugin');

    // Create test dir if not exists
    if (!fs.existsSync(testPluginDir)) {
        fs.mkdirSync(testPluginDir, { recursive: true });
    }

    // Plugin should be able to write to its own directory
    runWithContext('test-own-dir-plugin', () => {
        const testFile = path.join(testPluginDir, 'test.txt');
        secureFs.writeFileSync(testFile, 'allowed');
        const content = secureFs.readFileSync(testFile, 'utf8');
        expect(content).toBe('allowed');
        secureFs.unlinkSync(testFile);
    });

    // Cleanup
    fs.rmdirSync(testPluginDir);
});

// ============================================
console.log('\n⚡ Secure child_process Tests:');
// ============================================

test('Core code can use child_process.execSync without context', () => {
    const secureCP = createSecureChildProcess();
    // Just verify it doesn't throw - we won't actually execute
    expect(typeof secureCP.execSync).toBe('function');
});

test('Plugin ALWAYS blocked from child_process.exec', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.execSync('echo pwned');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin ALWAYS blocked from child_process.spawn', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.spawnSync('ls', ['-la']);
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin ALWAYS blocked from child_process.fork', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.fork('./malicious.js');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

// ============================================
console.log('\n🎭 Obfuscation Resistance Tests:');
// ============================================

test('Obfuscated code still blocked (dynamic property access)', () => {
    const secureFs = createSecureFs();

    runWithContext('test-obfuscated-plugin', () => {
        expectThrows(() => {
            // Attacker tries: secureFs["read" + "FileSync"]
            const method = 'read' + 'File' + 'Sync';
            secureFs[method]('/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Obfuscated code still blocked (apply/call)', () => {
    const secureFs = createSecureFs();

    runWithContext('test-obfuscated-plugin', () => {
        expectThrows(() => {
            // Attacker tries: fs.readFileSync.call(fs, '/etc/passwd')
            secureFs.readFileSync.call(secureFs, '/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

// ============================================
// Summary
// ============================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('✨ All tests passed! Runtime security is working.\n');
    process.exit(0);
}
