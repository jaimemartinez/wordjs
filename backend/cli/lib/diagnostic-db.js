// Shared by the diagnostic scripts in backend/cli (inspect-roles, inspect-user, verify-roles,
// force-sync-roles): open the database the backend itself would open — same config
// (backend/wordjs-config.json: dbDriver, dbPath, ...) and same init() — run one task against it, close it.
//
// Run the scripts from backend/ so a relative dbPath resolves exactly as it does for the server:
//   node -r ts-node/register cli/<name>.js
// They act on the main site's database (site 1); in a multisite network every other site has its own.

const ROLES_OPTION = 'wordjs_user_roles';

/** The database module, required lazily so loading a script never opens anything. */
function database() {
    return require('../../src/config/database');
}

/** Initialize the configured driver, run `task(dbAsync)`, save (sql.js), close, and return its result. */
async function withDatabase(task) {
    const db = database();
    await db.init();
    try {
        return await task(db.dbAsync);
    } finally {
        try { db.saveDatabase(); } catch { /* nothing to save on this driver */ }
        try { await db.closeDatabase(); } catch { /* already closed */ }
    }
}

/** The stored role map, parsed; null when the option row does not exist. */
async function readStoredRoles(dbAsync) {
    const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [ROLES_OPTION]);
    if (!row) return null;
    try { return JSON.parse(String(row.option_value || '')); } catch { return String(row.option_value || ''); }
}

/**
 * Run a script's main() when it is executed directly, with its status as the exit code. The process is
 * left to exit on its own: calling process.exit() right after closing the sql.js (sqlite-legacy) driver
 * aborts Node on Windows (a libuv handle still closing). The unref'd timer only forces the exit if
 * something keeps the event loop alive.
 */
function runMain(mod, main) {
    if (require.main !== mod) return;
    const finish = (code) => {
        process.exitCode = code;
        setTimeout(() => process.exit(code), 5000).unref();
    };
    main(process.argv.slice(2)).then(
        (code) => finish(typeof code === 'number' ? code : 0),
        (e) => { console.error('Error:', e && e.message ? e.message : e); finish(1); },
    );
}

module.exports = { ROLES_OPTION, withDatabase, readStoredRoles, runMain };
