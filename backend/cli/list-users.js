const path = require('path');
const fs = require('fs');

// Ensure we are in the backend directory for relative path resolutions inside the core
const backendDir = path.resolve(__dirname, 'backend');
process.chdir(backendDir);

// Use absolute paths for the backend modules to avoid require issues
const { init, dbAsync } = require(path.join(backendDir, 'src/config/database'));

async function listUsers() {
    try {
        console.log('--- DB Debug (sqlite-native) ---');
        console.log('Backend Dir:', backendDir);

        await init();

        console.log('\nChecking for users...');
        const users = await dbAsync.all('SELECT id, user_login, user_email FROM users');
        console.log('Users found:', users.length);
        console.table(users);

    } catch (e) {
        console.error('Error:', e.message);
        console.error(e.stack);
    } finally {
        process.exit(0);
    }
}

listUsers();
