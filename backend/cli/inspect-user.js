// Debug helper: print one user's row and stored role. Credential columns (password hash, activation
// key, ...) are never printed.
// Usage (from backend/): node -r ts-node/register cli/inspect-user.js <user_login>
const { withDatabase, runMain } = require('./lib/diagnostic-db');

const SECRET_COLUMN = /pass|key|token|secret/i;

async function main(argv = []) {
    const login = argv[0];
    if (!login) {
        console.error('Usage: node -r ts-node/register cli/inspect-user.js <user_login>');
        return 2;
    }
    const row = await withDatabase((dbAsync) => dbAsync.get(
        `SELECT users.*, user_meta.meta_value AS role FROM users
         LEFT JOIN user_meta ON users.id = user_meta.user_id AND user_meta.meta_key = 'role'
         WHERE users.user_login = ?`, [login]));
    if (!row) {
        console.log(`USER_NOT_FOUND: ${login}`);
        return 1;
    }
    const safe = {};
    for (const [k, v] of Object.entries(row)) if (!SECRET_COLUMN.test(k)) safe[k] = v;
    console.log('USER_DATA:', JSON.stringify(safe, null, 2));
    return 0;
}

module.exports = { main };
runMain(module, main);
