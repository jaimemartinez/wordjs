const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const TEST_DIR = path.resolve(__dirname, '../../tmp-installer-test');
const SRC_CONFIG_DIR = path.join(TEST_DIR, 'src/config');
const APP_JS_PATH = path.join(SRC_CONFIG_DIR, 'app.js');
const TARGET_CONFIG_JSON = path.join(TEST_DIR, 'wordjs-config.json');

// Helper to cleanup
const cleanup = () => {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
};

test('Installer: Should ENTRY in SETUP MODE (No Auto-Config)', async (t) => {
    // 1. Setup isolated environment
    cleanup();
    fs.mkdirSync(SRC_CONFIG_DIR, { recursive: true });

    // 2. Copy the actual app.js code to the isolated environment
    const originalAppJsContent = fs.readFileSync(path.resolve(__dirname, '../config/app.js'), 'utf8');
    fs.writeFileSync(APP_JS_PATH, originalAppJsContent);

    // 3. Trigger Logic by requiring the isolated file
    console.log('--- Triggering App Config Logic in Isolated Env ---');
    console.log(`   Simulated Root: ${TEST_DIR}`);

    // We expect it NOT to write anything
    const config = require(APP_JS_PATH);

    // 4. Assertions
    const exists = fs.existsSync(TARGET_CONFIG_JSON);

    // It should NOT exist
    assert.strictEqual(exists, false, '✅ Correct behavior: Config file was NOT created automatically.');
    console.log('✅ Verified: System stays in Setup Mode when config is missing.');

    // Cleanup
    cleanup();
});
