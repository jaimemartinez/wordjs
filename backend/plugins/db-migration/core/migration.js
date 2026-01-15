const path = require('path');
const fs = require('fs');
const config = require('../../../src/config/app');
const configManager = require('../../../src/core/configManager');
const dbManager = require('../../../src/config/database');

const TABLES = [
    'users', 'user_meta',
    'posts', 'post_meta',
    'comments', 'comment_meta',
    'terms', 'term_taxonomy', 'term_relationships',
    'options', 'links'
];

let globalStatus = { step: 'idle', progress: 0, currentTable: '', totalTables: TABLES.length, warnings: [] };

exports.getStatus = (req, res) => {
    // Check for legacy files to allow cleanup
    const legacyFiles = [];
    const currentDriver = config.dbDriver || 'sqlite-legacy';

    // Only allow cleanup if we are NOT using the file execution
    if (currentDriver !== 'sqlite-legacy' && fs.existsSync(path.resolve('./data/wordjs.db'))) legacyFiles.push('wordjs.db');
    if (currentDriver !== 'sqlite-native' && fs.existsSync(path.resolve('./data/wordjs-native.db'))) legacyFiles.push('wordjs-native.db');

    res.json({
        currentDriver,
        availableDrivers: ['sqlite-legacy', 'sqlite-native', 'postgres'],
        status: globalStatus,
        legacyFiles
    });
};

exports.cleanup = (req, res) => {
    const { file } = req.body;
    // Security: Only allow specific filenames to prevent arbitrary deletion
    const ALLOWED = ['wordjs.db', 'wordjs-native.db'];

    if (!ALLOWED.includes(file)) return res.status(403).json({ error: 'Invalid file' });

    const target = path.resolve('./data', file);
    if (fs.existsSync(target)) {
        try {
            fs.unlinkSync(target);

            // Also clean WAL/SHM if they exist
            if (fs.existsSync(target + '-wal')) fs.unlinkSync(target + '-wal');
            if (fs.existsSync(target + '-shm')) fs.unlinkSync(target + '-shm');

            res.json({ success: true, message: 'File deleted' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.status(404).json({ error: 'File not found' });
    }
};

exports.runMigration = async (req, res) => {
    const { targetDriver, dbHost, dbUser, dbPassword, dbName, dbPort } = req.body;
    let targetFile = null;
    let targetDriverModule = null;

    // Safety Checks
    if (!targetDriver || !['sqlite-legacy', 'sqlite-native', 'postgres'].includes(targetDriver)) {
        return res.status(400).json({ error: 'Invalid target driver' });
    }

    const currentDriver = config.dbDriver || 'sqlite-legacy';
    if (targetDriver === currentDriver && targetDriver !== 'postgres') {
        // Allow re-migration to postgres for credential updates, but block file-to-file defaults
        return res.status(400).json({ error: 'Already using this driver' });
    }

    try {
        console.log(`🚀 Migration Started: ${currentDriver} -> ${targetDriver}`);
        globalStatus = { step: 'initializing', progress: 0, currentTable: '', totalTables: TABLES.length, warnings: [] };

        // 0. Auto-Install Dependencies (Zero Config)
        if (targetDriver === 'sqlite-native') {
            try { require.resolve('better-sqlite3'); } catch (e) {
                console.log('📦 Installing Native Driver (better-sqlite3)...');
                const { execSync } = require('child_process');
                execSync('npm install better-sqlite3 --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }
        if (targetDriver === 'postgres') {
            try { require.resolve('pg'); } catch (e) {
                console.log('📦 Installing Postgres Driver (pg)...');
                const { execSync } = require('child_process');
                execSync('npm install pg --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }

        // 1. Connect to Source (Current Active DB)
        let sourceDb = null;
        if (config.dbDriver !== 'postgres') {
            sourceDb = dbManager.getDb();
        }
        const isPostgresTarget = targetDriver === 'postgres';

        // 2. Prepare Target
        let tempTargetFile = null;

        // Simple retry helper for Windows file locking
        const forceDelete = (f) => {
            if (!fs.existsSync(f)) return;
            try {
                fs.unlinkSync(f);
            } catch (e) {
                if (e.code === 'EBUSY' || e.code === 'EPERM') {
                    const end = Date.now() + 1000; // Increased wait to 1s
                    while (Date.now() < end) { }
                    try { fs.unlinkSync(f); } catch (e2) { throw e; }
                } else {
                    throw e;
                }
            }
        };

        if (!isPostgresTarget) {
            const targetFilename = targetDriver === 'sqlite-native' ? 'wordjs-native.db' : 'wordjs.db';
            targetFile = path.resolve('./data', targetFilename);
            // Use a temporary file for writing to avoid locking issues on the main file during the process
            // (e.g. OneDrive syncing, or zombie readers)
            tempTargetFile = targetFile + '.tmp';

            try {
                // Ensure temp is clean
                forceDelete(tempTargetFile);
                if (fs.existsSync(tempTargetFile + '-wal')) forceDelete(tempTargetFile + '-wal');
                if (fs.existsSync(tempTargetFile + '-shm')) forceDelete(tempTargetFile + '-shm');
            } catch (e) {
                console.error('❌ Failed to clean up temp files:', e.message);
                throw new Error(`Temp file locked: ${e.message}`);
            }
        }

        // 3. Connect to Target Driver
        targetDriverModule = require(`../../../src/drivers/${targetDriver}`);

        if (isPostgresTarget) {
            // Dynamic Init for Postgres
            await targetDriverModule.init({
                dbConfig: { host: dbHost, user: dbUser, password: dbPassword, name: dbName, port: dbPort }
            });
            await targetDriverModule.connect();
        } else {
            // Legacy driver takes path
            // Write to .tmp first
            await targetDriverModule.init({ dbPath: tempTargetFile });
        }

        let targetWrapper;
        if (isPostgresTarget) {
            await targetDriverModule.exec("SET session_replication_role = 'replica';"); // Disable Triggers/FKs
        } else {
            targetWrapper = targetDriverModule.get();
            if (targetWrapper.exec) targetWrapper.exec('PRAGMA foreign_keys = OFF;');
            else targetWrapper.run('PRAGMA foreign_keys = OFF;');

            if (targetDriver === 'sqlite-native') {
                // Disable WAL during migration to ensure single-file consistency on exit
                // This prevents 'malformed disk image' errors if WAL checkpointing is incomplete
                targetWrapper.pragma('journal_mode = DELETE');
            }
        }

        // 4. Initialize Schema on Target
        await dbManager.initializeSchema(isPostgresTarget ? targetDriverModule : targetWrapper, isPostgresTarget);
        console.log('   Schema initialized on target.');

        // 5. Copy Data Table-by-Table
        let totalRows = 0;

        // Start Transaction
        if (isPostgresTarget) await targetDriverModule.exec('BEGIN');

        let tablesProcessed = 0;
        globalStatus.step = 'copying';
        globalStatus.warnings = [];

        // Define Source Type for Read Logic
        // Postgres uses sourceAsync, SQLite (Native/Legacy) uses sourceDb
        const sourceAsync = currentDriver === 'postgres' ? dbManager.getDbAsync() : null;

        for (const table of TABLES) {
            globalStatus.currentTable = table;

            // Read Source
            let rows = [];
            if (currentDriver === 'postgres') {
                rows = await sourceAsync.all(`SELECT * FROM ${table}`);
            } else {
                // SQLite (Native or Legacy)
                // Both wrappers expose .all(sql) which handles preparation and cleanup internally
                rows = sourceDb.all(`SELECT * FROM ${table}`);
            }



            if (rows.length > 0) {
                console.log(`   Copying ${rows.length} rows from table '${table}'...`);

                // Clear Table
                if (isPostgresTarget) {
                    await targetDriverModule.exec(`TRUNCATE TABLE ${table} CASCADE`);
                } else {
                    if (targetWrapper.exec) targetWrapper.exec(`DELETE FROM ${table}`);
                    else targetWrapper.run(`DELETE FROM ${table}`);
                }

                // Insert Data
                if (isPostgresTarget) {
                    for (const row of rows) {
                        const keys = Object.keys(row);
                        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
                        const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`;
                        await targetDriverModule.run(sql, Object.values(row));
                    }
                } else {
                    // SQLite Bulk
                    const keys = Object.keys(rows[0]);
                    const placeholders = keys.map(() => '?').join(',');
                    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`;
                    const stmt = targetWrapper.prepare(sql);

                    const sanitize = (val) => {
                        if (val instanceof Date) return val.toISOString();
                        if (typeof val === 'object' && val !== null) return JSON.stringify(val);
                        if (typeof val === 'boolean') return val ? 1 : 0;
                        return val;
                    };

                    const BATCH_SIZE = 500;
                    const useTransactions = targetDriver !== 'sqlite-legacy';

                    if (useTransactions) targetWrapper.exec('BEGIN TRANSACTION');
                    try {
                        let count = 0;
                        for (const row of rows) {
                            const values = Object.values(row).map(sanitize);
                            stmt.run(...values);
                            count++;
                            if (useTransactions && count % BATCH_SIZE === 0) {
                                targetWrapper.exec('COMMIT');
                                targetWrapper.exec('BEGIN TRANSACTION');
                            }
                        }
                        if (useTransactions) targetWrapper.exec('COMMIT');
                    } catch (err) {
                        try { if (useTransactions) targetWrapper.exec('ROLLBACK'); } catch (e) { }
                        throw err;
                    }
                }

                // VERIFICATION LOGIC
                try {
                    let targetCount = 0;
                    if (isPostgresTarget) {
                        const allRows = await targetDriverModule.all(`SELECT COUNT(*) as c FROM ${table}`);
                        targetCount = parseInt(allRows[0].c);
                    } else {
                        // SQLite Verification check
                        // Both Native and Legacy wrappers support .get()
                        if (targetWrapper.get && typeof targetWrapper.get === 'function') {
                            const res = targetWrapper.get(`SELECT COUNT(*) as c FROM ${table}`);
                            targetCount = res ? res.c : 0;
                        } else {
                            const stmt = targetWrapper.prepare(`SELECT COUNT(*) as c FROM ${table}`);
                            const res = stmt.get();
                            targetCount = res ? res.c : 0;
                        }
                    }

                    if (targetCount !== rows.length) {
                        const msg = `Mismatch in ${table}: Source=${rows.length} vs Target=${targetCount}`;
                        console.warn('❌ ' + msg);
                        globalStatus.warnings.push(msg);
                    } else {
                        console.log(`   ✅ Verified ${table}: ${targetCount} rows.`);
                    }
                } catch (vErr) {
                    console.warn(`⚠️ Verification skipped for ${table}:`, vErr.message);
                    console.error(vErr);
                }

                totalRows += rows.length;
            }

            tablesProcessed++;
            globalStatus.progress = Math.round((tablesProcessed / TABLES.length) * 100);
        }

        // Close Source DB now that we are done reading
        try { if (dbManager.closeDatabase) dbManager.closeDatabase(); } catch (e) { console.warn('Could not close source DB:', e.message); }

        if (isPostgresTarget) {
            await targetDriverModule.exec("SET session_replication_role = 'origin';");
            await targetDriverModule.exec('COMMIT');
        }

        console.log(`✅ Data Copied (${totalRows} rows).`);

        // 6. Persist & Close Target
        if (targetDriverModule.save) targetDriverModule.save();
        if (targetDriverModule.close) await targetDriverModule.close();

        // 7. Atomic Swap (Move .tmp -> Real) with Failover
        let finalPath = targetFile;

        if (tempTargetFile) {
            console.log('   Stats: Swapping temporary database to final location...');
            try {
                // Inline retry delete
                const retryDelete = (f) => {
                    if (!fs.existsSync(f)) return;
                    try { fs.unlinkSync(f); } catch (e) {
                        const end = Date.now() + 1000;
                        while (Date.now() < end) { }
                        fs.unlinkSync(f);
                    }
                };

                retryDelete(targetFile);
                if (fs.existsSync(targetFile + '-wal')) retryDelete(targetFile + '-wal');
                if (fs.existsSync(targetFile + '-shm')) retryDelete(targetFile + '-shm');

                fs.renameSync(tempTargetFile, targetFile);
            } catch (e) {
                console.warn(`⚠️ Swap Failed (File Locked). Using temporary file '${path.basename(tempTargetFile)}' as the new active database.`);
                // If we can't write to the standard filename, we stick with the temp file
                // This ensures the user doesn't lose data, even if the filename is ugly.
                finalPath = tempTargetFile;
            }
        }

        // 8. Update Configuration
        const newConfig = { dbDriver: targetDriver };
        if (!isPostgresTarget) {
            // Make path relative to backend root (e.g. ./data/wordjs.db)
            // path.relative might return 'data/wordjs.db', we want './data/...' usually, but 'data/...' works too.
            // Let's stick to the current convention of ./data
            const rel = path.relative(process.cwd(), finalPath).replace(/\\/g, '/');
            newConfig.dbPath = rel.startsWith('.') ? rel : `./${rel}`;
        } else {
            // pgConfig is not defined in the provided context, assuming it should be dbHost, dbPort, etc.
            // based on the original code's usage for newConfig.db.
            newConfig.db = {
                host: dbHost,
                port: dbPort,
                user: dbUser,
                name: dbName,
                // Password is usually saved in .env OR config.
                // We'll pass it to saveConfig to decide.
                password: dbPassword
            };
        }

        // Save Backup for Auto-Fallback
        const backupConfig = configManager.getConfig();
        if (backupConfig) {
            const backupFile = path.resolve('wordjs-config.backup.json');
            require('fs').writeFileSync(backupFile, JSON.stringify(backupConfig, null, 2));
        }

        configManager.saveConfig(newConfig);

        res.json({
            success: true,
            message: `Migration successful! Copied ${totalRows} rows to ${targetDriver}. Restarting server...`
        });

        setTimeout(() => {
            console.log('🔄 Restarting server...');

            // Force touch src/index.js to trigger node --watch restart
            // (Just saving config might not be enough if it's out of watch scope)
            const indexFile = path.resolve(__dirname, '../../../src/index.js');
            try {
                const time = new Date();
                fs.utimesSync(indexFile, time, time);
            } catch (err) {
                console.error('Could not touch index.js:', err);
            }

            process.exit(0);
        }, 1000);

    } catch (e) {
        console.error('Migration Failed:', e);

        // Attempt to cleanup driver connection to release locks
        if (targetDriverModule) {
            try { if (targetDriverModule.exec) await targetDriverModule.exec('ROLLBACK'); } catch (err) { }
            try { if (targetDriverModule.close) await targetDriverModule.close(); } catch (err) { }
        }

        res.status(500).json({ error: e.message });
    }
};
