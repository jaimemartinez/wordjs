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

        console.log('\nChecking for received emails table...');
        const tables = await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table' AND name='received_emails'");
        if (tables.length > 0) {
            const count = await dbAsync.get('SELECT COUNT(*) as count FROM received_emails');
            console.log(`Table "received_emails" exists with ${count.count} rows.`);

            if (count.count > 0) {
                const lastEmails = await dbAsync.all('SELECT id, to_address, subject, date_received FROM received_emails ORDER BY id DESC LIMIT 3');
                console.log('Last 3 emails:');
                console.table(lastEmails);
            }
        } else {
            console.log('Table "received_emails" does NOT exist!');
        }

    } catch (e) {
        console.error('Error:', e.message);
        console.error(e.stack);
    } finally {
        process.exit(0);
    }
}

listUsers();
