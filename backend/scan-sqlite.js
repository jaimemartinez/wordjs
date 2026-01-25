const fs = require('fs');
const path = require('path');
const sqlite3 = require('better-sqlite3');

const search = (dir) => {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const full = path.join(dir, file);
            const stat = fs.statSync(full);

            if (stat.isDirectory()) {
                if (!file.includes('node_modules') && !file.startsWith('.')) {
                    search(full);
                }
            } else if (file.endsWith('.db')) {
                try {
                    const db = new sqlite3(full);
                    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

                    let hasData = false;
                    const results = [];

                    for (const t of tables) {
                        try {
                            const row = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
                            if (row.count > 0) {
                                results.push(`  ${t.name}: ${row.count} rows`);
                                hasData = true;
                            }
                        } catch (e) { }
                    }

                    if (hasData) {
                        console.log(`--- DB: ${full} ---`);
                        results.forEach(r => console.log(r));
                    }
                    db.close();
                } catch (e) {
                    // console.error('Error reading', full, e.message);
                }
            }
        }
    } catch (e) { }
};

console.log('🔍 Scanning for non-empty SQLite databases...');
search('..'); // Start from root
