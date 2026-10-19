// Debug helper: print each stored role's capabilities (the `wordjs_user_roles` option).
// Usage (from backend/): node -r ts-node/register cli/verify-roles.js [role]
//   With a role slug (e.g. subscriber), prints only that role.
const { withDatabase, readStoredRoles, runMain } = require('./lib/diagnostic-db');

async function main(argv = []) {
    const roles = await withDatabase(readStoredRoles);
    if (!roles || typeof roles !== 'object') {
        console.log('ROLES_NOT_FOUND');
        return 1;
    }
    const only = argv[0];
    if (only && !Object.prototype.hasOwnProperty.call(roles, only)) {
        console.log(`ROLE_NOT_FOUND: ${only}`);
        return 1;
    }
    for (const slug of only ? [only] : Object.keys(roles)) {
        const caps = (roles[slug] && roles[slug].capabilities) || [];
        console.log(`${slug.toUpperCase()}_CAPS:`, JSON.stringify(caps));
    }
    return 0;
}

module.exports = { main };
runMain(module, main);
