const { initSqlJsDb, getDb } = require('../src/config/database');

async function run() {
    try {
        await initSqlJsDb();
        const db = getDb();
        const row = db.prepare('SELECT option_value FROM options WHERE option_name = "wordjs_user_roles"').get();
        if (row) {
            const roles = JSON.parse(row.option_value);
            console.log("SUBSCRIBER_CAPS:", JSON.stringify(roles.subscriber?.capabilities || []));
        } else {
            console.log("ROLES_NOT_FOUND");
        }
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

run();
