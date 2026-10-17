// Debug helper: print the `active_plugins` option straight from the SQLite file.
// Not shipped in releases (make-release excludes backend/cli except the product CLI).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Resolve from THIS file, not the cwd: `path.resolve('../data/…')` only found the database when the
// script happened to be run from backend/cli, and silently reported "not found" from anywhere else.
const DATA_DIR = path.resolve(__dirname, '..', 'data');

// The two SQLite drivers keep SEPARATE files (native → wordjs-native.db, legacy → wordjs.db), so
// hardcoding one of them reports the wrong install's plugins. Prefer what backend/wordjs-config.json
// selects: its `dbPath`, else the default file of its `dbDriver` (the same rule as src/config/app.ts).
// A relative dbPath is resolved against backend/, where the server is started from.
const BACKEND_DIR = path.resolve(__dirname, '..');

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'wordjs-config.json'), 'utf8')) || {};
    } catch {
        return {}; // no config (fresh checkout) — fall back to the driver defaults
    }
}

function candidateDatabases(config = readConfig()) {
    const named = [];
    const driver = config.dbDriver || 'sqlite-native';
    if (config.dbPath) named.push(path.resolve(BACKEND_DIR, config.dbPath));
    else named.push(path.join(DATA_DIR, driver === 'sqlite-legacy' ? 'wordjs.db' : 'wordjs-native.db'));
    named.push(path.join(DATA_DIR, 'wordjs-native.db'), path.join(DATA_DIR, 'wordjs.db'));
    return named.filter((file, i) => named.indexOf(file) === i && fs.existsSync(file));
}

function main() {
    const config = readConfig();
    if (config.dbDriver && !String(config.dbDriver).startsWith('sqlite')) {
        console.error(`Error: this install uses the '${config.dbDriver}' driver; check_plugins only reads SQLite files.`);
        return 1;
    }
    const files = candidateDatabases(config);
    if (files.length === 0) {
        console.error(`Error: no SQLite database found (looked in ${DATA_DIR}).`);
        return 1;
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
    return 0;
}

module.exports = { candidateDatabases, main };
if (require.main === module) process.exit(main());
