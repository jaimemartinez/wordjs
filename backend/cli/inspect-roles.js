// Debug helper: print the stored role map (the `wordjs_user_roles` option) as raw JSON.
// Usage (from backend/): node -r ts-node/register cli/inspect-roles.js
const { withDatabase, ROLES_OPTION, runMain } = require('./lib/diagnostic-db');

async function main() {
    const row = await withDatabase((dbAsync) =>
        dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [ROLES_OPTION]));
    console.log('ROLES_DB:', row ? row.option_value : 'NOT_FOUND');
    return 0;
}

module.exports = { main };
runMain(module, main);
