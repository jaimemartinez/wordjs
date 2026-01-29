
const { init, closeDatabase } = require('../src/config/database');
const { activatePlugin } = require('../src/core/plugins');

async function run() {
    await init();
    try {
        console.log('🔌 Activating test-schema...');
        const result = await activatePlugin('test-schema');
        console.log('Result:', result);
    } catch (e) {
        console.error('Error:', e.message);
    }
    // Allow hooks to finish (async sql)
    setTimeout(async () => {
        try {
            if (closeDatabase) await closeDatabase();
        } catch (e) { }
        process.exit(0);
    }, 2000);
}
run();
