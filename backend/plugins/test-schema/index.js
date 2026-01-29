
const { getDbAsync, createPluginTable } = require('../../src/config/database');
const { addAction } = require('../../src/core/hooks');

addAction('init', async () => {
    try {
        console.log('🧪 Test Schema: Initializing custom table...');

        // 1. Create Table
        await createPluginTable('test_custom_schema', [
            'id INT_PK',
            'custom_value TEXT'
        ]);

        // 2. Insert Data (if empty)
        const db = getDbAsync();
        // Determine syntax based on driver (though interface should abstract this, let's use raw SQL for test)
        // Actually, db.get() abstract it.
        try {
            const existing = await db.get('SELECT COUNT(*) as count FROM test_custom_schema');
            if (existing.count === 0 || existing.count === '0') {
                await db.run('INSERT INTO test_custom_schema (custom_value) VALUES (?)', ['persistence-check-123']);
                console.log('   ✅ Test Schema: Inserted test data.');
            } else {
                console.log('   ℹ️  Test Schema: Data already exists.');
            }
        } catch (err) {
            // might fail if table just created and wait needed? createPluginTable awaits so should be fine.
            console.log('   ⚠️  Test Schema: check failed ' + err.message);
        }

    } catch (e) {
        console.error('❌ Test Schema Error:', e.message);
    }
});
