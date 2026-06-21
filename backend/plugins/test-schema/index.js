/**
 * Isolated plugin — runs in its own OS process (child_process sandbox) and uses ONLY the injected
 * `wordjs` capability bridge (no direct core requires). See documentation/plugin-isolation-proposal.md.
 */
exports.init = function (wordjs) {
    wordjs.hooks.addAction('init', async () => {
        try {
            // The sandbox confines an untrusted plugin's SQL to tables under its OWN prefix, so the
            // table name MUST be built from wordjs.db.tablePrefix (e.g. wjp_test_schema_custom). A bare
            // `test_custom_schema` is rejected by the per-plugin SQL scoping (createTable + assertSqlAllowed).
            const table = wordjs.db.tablePrefix + 'custom';
            console.log(`🧪 Test Schema: Initializing custom table ${table}...`);

            await wordjs.db.createTable(table, ['id INT_PK', 'custom_value TEXT']);

            const existing = await wordjs.db.get(`SELECT COUNT(*) as count FROM ${table}`);
            if (!existing || existing.count === 0 || existing.count === '0') {
                await wordjs.db.run(`INSERT INTO ${table} (custom_value) VALUES (?)`, ['persistence-check-123']);
                console.log('   ✅ Test Schema: Inserted test data.');
            } else {
                console.log('   ℹ️  Test Schema: Data already exists.');
            }
        } catch (e) {
            console.error('❌ Test Schema Error:', e.message);
        }
    });
};
