
const { initSqlJsDb, db } = require('./backend/src/config/database');
const path = require('path');

// Mock config for initSqlJsDb if needed, or proper path setup
// Adjust process.cwd() if needed?
// backend/src/config/database.js likely expects to run from root

// Just manually query if possible?
// backend/src/config/database.js exports 'db' but it needs init if sql.js
// Let's rely on standard sqlite3 if available, or try to load the wordjs db.

// Simplest way: use the wordjs codebase functions
(async () => {
    try {
        console.log("Checking active plugins...");
        await initSqlJsDb();

        // Manual query
        const stmt = db.prepare("SELECT option_value FROM options WHERE option_name = 'active_plugins'");
        const row = stmt.get();
        if (row) {
            console.log("Active Plugins Raw:", row.option_value);
        } else {
            console.log("No active_plugins option found.");
        }

        const list = db.prepare("SELECT option_value FROM options WHERE option_name = 'card_galleries_list'").get();
        console.log("Card Galleries List:", list ? list.option_value : "Not found");

    } catch (e) {
        console.error(e);
    }
})();
