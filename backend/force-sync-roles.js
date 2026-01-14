const { initSqlJsDb, getDb, saveDatabase } = require('./src/config/database');
const config = require('./src/config/app');

async function run() {
    try {
        console.log("Initializing database connection...");
        await initSqlJsDb();
        const db = getDb();

        const roles = config.roles;
        console.log("Syncing roles to database...");
        const serializedRoles = JSON.stringify(roles);

        // Update or Insert the option
        const existing = db.prepare('SELECT option_value FROM options WHERE option_name = "wordjs_user_roles"').get();

        if (existing) {
            console.log("Updating existing roles in DB...");
            db.prepare('UPDATE options SET option_value = ? WHERE option_name = "wordjs_user_roles"').run(serializedRoles);
        } else {
            console.log("Creating roles option in DB...");
            db.prepare('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)')
                .run(['wordjs_user_roles', serializedRoles, 'yes']);
        }

        saveDatabase();
        console.log("Successfully synced roles! Subscribers now have access_admin_panel.");
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

run();
