const { initSqlJsDb, getDb } = require('../src/config/database');

async function run() {
    try {
        await initSqlJsDb();
        const db = getDb();
        const row = db.prepare('SELECT users.*, user_meta.meta_value as role FROM users LEFT JOIN user_meta ON users.id = user_meta.user_id AND user_meta.meta_key = "role" WHERE user_login = "dherrera"').get();
        console.log("USER_DATA:", JSON.stringify(row, null, 2));
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

run();
