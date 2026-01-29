
const { getDbAsync, init } = require('../src/config/database');

async function check() {
    await init();
    const db = getDbAsync();
    try {
        const TABLES = await db.getTables();
        console.log('Tables:', TABLES);

        const row = await db.get("SELECT * FROM test_custom_schema LIMIT 1");
        console.log('Row:', row);
    } catch (e) {
        console.error('Error:', e.message);
    }
    await db.close();
}
check();
