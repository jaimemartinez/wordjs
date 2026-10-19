// Repair helper: reset the built-in roles (administrator, editor, author, contributor, subscriber) in the
// stored role map to the defaults the server uses (core/roles DEFAULT_ROLES, overridden by config.roles
// when an operator set it). Roles that are not built in (plugin roles, custom roles) are kept as stored.
// A running server picks the change up within its roles cache TTL (about 10 seconds).
// Usage (from backend/): node -r ts-node/register cli/force-sync-roles.js
const { withDatabase, readStoredRoles, ROLES_OPTION, runMain } = require('./lib/diagnostic-db');

async function main() {
    const config = require('../src/config/app');
    const { defaultRoles } = require('../src/core/roles');
    const effective = { ...defaultRoles(), ...(config.roles || {}) };

    await withDatabase(async (dbAsync) => {
        const stored = await readStoredRoles(dbAsync);
        const current = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        const next = { ...current, ...effective };
        const value = JSON.stringify(next);
        if (stored === null) {
            console.log('Creating the roles option...');
            await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [ROLES_OPTION, value, 'yes']);
        } else {
            console.log('Updating the stored roles...');
            await dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [value, ROLES_OPTION]);
        }
        console.log(`Built-in roles reset: ${Object.keys(effective).join(', ')}`);
        const kept = Object.keys(current).filter((slug) => !(slug in effective));
        if (kept.length) console.log(`Other roles kept: ${kept.join(', ')}`);
    });
    return 0;
}

module.exports = { main };
runMain(module, main);
