const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
const dbFiles = ['wordjs.db', 'wordjs-native.db'];

console.log('--- Database Content Check ---');

dbFiles.forEach(file => {
    const dbPath = path.join(dataDir, file);
    if (!fs.existsSync(dbPath)) {
        console.log(`[${file}] does not exist.`);
        return;
    }

    try {
        const db = new Database(dbPath, { readonly: true });

        // Count Users
        let userCount = 0;
        try {
            userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        } catch (e) { userCount = 'Error (no table?)'; }

        // Count Posts
        let postCount = 0;
        try {
            postCount = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
        } catch (e) { postCount = 'Error (no table?)'; }

        console.log(`[${file}]: Users=${userCount}, Posts=${postCount}`);
        db.close();
    } catch (err) {
        console.log(`[${file}] Error opening: ${err.message}`);
    }
});
