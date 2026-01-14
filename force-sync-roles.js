const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Hardcoded paths to be safe
const DB_PATH = path.resolve(__dirname, 'backend/data/wordjs.db');
const APP_CONFIG_PATH = path.resolve(__dirname, 'backend/src/config/app.js');

async function run() {
    try {
        console.log("Loading database from:", DB_PATH);
        if (!fs.existsSync(DB_PATH)) {
            console.error("Database file not found at", DB_PATH);
            process.exit(1);
        }

        const SQL = await initSqlJs();
        const buffer = fs.readFileSync(DB_PATH);
        const db = new SQL.Database(buffer);

        // Load config to get new role definitions
        const config = require(APP_CONFIG_PATH);
        const roles = config.roles;

        console.log("Syncing roles to database...");
        const serializedRoles = JSON.stringify(roles);

        // Update or Insert the option
        const existing = db.prepare('SELECT option_id FROM options WHERE option_name = "wordjs_user_roles"');
        let found = false;
        if (existing.step()) {
            found = true;
        }
        existing.free();

        if (found) {
            console.log("Updating existing roles in DB...");
            const stmt = db.prepare('UPDATE options SET option_value = ? WHERE option_name = "wordjs_user_roles"');
            stmt.run([serializedRoles]);
            stmt.free();
        } else {
            console.log("Creating roles option in DB...");
            const stmt = db.prepare('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)');
            stmt.run(["wordjs_user_roles", serializedRoles, "yes"]);
            stmt.free();
        }

        // Save back
        const data = db.export();
        fs.writeFileSync(DB_PATH, Buffer.from(data));

        console.log("Successfully synced roles! Subscribers now have access_admin_panel.");
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

run();
