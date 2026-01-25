const Database = require('better-sqlite3');
const path = require('path');

try {
    const db = new Database(path.resolve('../data/wordjs-native.db'));
    const row = db.prepare("SELECT option_value FROM options WHERE option_name = 'active_plugins'").get();

    if (row) {
        console.log('Active Plugins:', row.option_value);
    } else {
        console.log('Option "active_plugins" not found.');
    }
    db.close();
} catch (e) {
    console.error('Error:', e.message);
}
