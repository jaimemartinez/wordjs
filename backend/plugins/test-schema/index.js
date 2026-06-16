/**
 * Isolated plugin — runs in a worker and uses ONLY the injected `wordjs` capability bridge
 * (no direct core requires). See documentation/plugin-isolation-proposal.md.
 */
exports.init = function (wordjs) {
    wordjs.hooks.addAction('init', async () => {
        try {
            console.log('🧪 Test Schema: Initializing custom table...');

            await wordjs.db.createTable('test_custom_schema', ['id INT_PK', 'custom_value TEXT']);

            const existing = await wordjs.db.get('SELECT COUNT(*) as count FROM test_custom_schema');
            if (!existing || existing.count === 0 || existing.count === '0') {
                await wordjs.db.run('INSERT INTO test_custom_schema (custom_value) VALUES (?)', ['persistence-check-123']);
                console.log('   ✅ Test Schema: Inserted test data.');
            } else {
                console.log('   ℹ️  Test Schema: Data already exists.');
            }
        } catch (e) {
            console.error('❌ Test Schema Error:', e.message);
        }
    });
};
