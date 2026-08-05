// Debug helper: print the `active_plugins` option straight from the SQLite file.
// Not shipped in releases (make-release excludes backend/cli except the product CLI).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Resolve from THIS file, not the cwd: `path.resolve('../data/…')` only found the database when the
// script happened to be run from backend/cli, and silently reported "not found" from anywhere else.
const DATA_DIR = path.resolve(__dirname, '..', 'data');

// The two SQLite drivers keep SEPARATE files (native → wordjs-native.db, legacy → wordjs.db), so
// hardcoding one of them reports the wrong install's plugins. Prefer whatever the config selects.
function candidateDatabases() {
    const named = [];
    try {
        const configPath = path.resolve(__dirname, '..', '..', 'wordjs-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const configured = config && config.database && config.database.path;
        if (configured) named.push(path.resolve(path.dirname(configPath), configured));
    } catch { /* no config (fresh checkout) — fall back to the well-known names */ }
    named.push(path.join(DATA_DIR, 'wordjs-native.db'), path.join(DATA_DIR, 'wordjs.db'));
    return named.filter((file, i) => named.indexOf(file) === i && fs.existsSync(file));
}

const files = candidateDatabases();
if (files.length === 0) {
    console.error(`Error: no SQLite database found (looked in ${DATA_DIR}).`);
    process.exit(1);
}

for (const file of files) {
    try {
        const db = new Database(file, { readonly: true });
        const row = db.prepare("SELECT option_value FROM options WHERE option_name = 'active_plugins'").get();
        console.log(`${path.basename(file)}:`, row ? row.option_value : 'option "active_plugins" not found.');
        db.close();
    } catch (e) {
        console.error(`${path.basename(file)}: ${e.message}`);
    }
}
