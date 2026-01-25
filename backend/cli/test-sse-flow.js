const notificationService = require('../src/core/notifications');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, './debug-notifications.log');

function readLog() {
    if (fs.existsSync(LOG_FILE)) {
        return fs.readFileSync(LOG_FILE, 'utf8');
    }
    return 'Log file not found.';
}

async function testSSEFlow() {
    console.log('--- Starting SSE Flow Test ---');

    // 1. Mock a client response object
    const mockRes = {
        _wordjs_user_id: 1,
        write: (data) => {
            console.log('   MATCHING CLIENT RECEIVED DATA:', data.trim());
        },
        on: (event, cb) => {
            console.log(`   Client registered event handler: ${event}`);
        }
    };

    // 2. Register the mock client
    console.log('Registering mock client for User 1...');
    notificationService.addClient(mockRes, 1);

    // 3. Trigger a notification for User 1
    console.log('Triggering notification for User 1...');
    await notificationService.send({
        user_id: 1,
        type: 'success',
        title: 'SSE Internal Test',
        message: 'This should reach the mock client.',
        icon: 'fa-check',
        color: 'green'
    });

    // 4. Trigger a notification for a DIFFERENT user (should NOT match)
    console.log('Triggering notification for User 99 (should not match)...');
    await notificationService.send({
        user_id: 99,
        type: 'info',
        title: 'Mismatch Test',
        message: 'This should NOT reach the mock client.'
    });

    console.log('\n--- Final Log State ---');
    console.log(readLog());
}

// Simple mock for verifyPermission to allow script to run
const pluginContext = require('../src/core/plugin-context');
const originalVerify = pluginContext.verifyPermission;
pluginContext.verifyPermission = () => true;

testSSEFlow().then(() => {
    // Restore
    pluginContext.verifyPermission = originalVerify;
});
