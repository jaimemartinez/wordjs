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

exports.getStatus = (req, res) => {
    res.json({
        currentDriver: config.dbDriver || 'sqlite-legacy',
        availableDrivers: ['sqlite-legacy', 'sqlite-native']
    });
};

exports.runMigration = async (req, res) => {
    const { targetDriver } = req.body;
    let targetFile = null;

    // Safety Checks
    if (!targetDriver || !['sqlite-legacy', 'sqlite-native'].includes(targetDriver)) {
        return res.status(400).json({ error: 'Invalid target driver' });
    }

    const currentDriver = config.dbDriver || 'sqlite-legacy';
    if (targetDriver === currentDriver) {
        return res.status(400).json({ error: 'Already using this driver' });
    }

    try {
        console.log(`🚀 Migration Started: ${currentDriver} -> ${targetDriver}`);

        // 0. Auto-Install Dependencies (Zero Config)
        if (targetDriver === 'sqlite-native') {
            try {
                require.resolve('better-sqlite3');
            } catch (e) {
                console.log('📦 Installing Native Driver (better-sqlite3)...');
                const { execSync } = require('child_process');
                const backendDir = path.resolve(__dirname, '../../../../');

                try {
                    execSync('npm install better-sqlite3 --save', {
                        cwd: backendDir,
                        stdio: 'inherit' // Show output in server logs
                    });
                    console.log('✅ Driver installed successfully.');
                } catch (installErr) {
                    throw new Error('Failed to auto-install better-sqlite3. Please install manually.');
                }
            }
        }

        // 1. Connect to Source (Current Active DB)
        const sourceDb = dbManager.getDb();

        // 2. Prepare Target (New DB File)
        const targetFilename = targetDriver === 'sqlite-native' ? 'wordjs-native.db' : 'wordjs.db';
        targetFile = path.resolve('./data', targetFilename);

        // CLEAN START: Delete existing target file to avoid collisions/corruption
        if (fs.existsSync(targetFile)) {
            console.log(`🧹 Creating fresh target file: ${targetFilename}`);
            try {
                fs.unlinkSync(targetFile);
            } catch (e) { /* ignore locked file error if any, driver init might handle or crash */ }
        }

        console.log(`   Target DB File: ${targetFile}`);

        // 3. Connect to Target Driver
        const targetDriverModule = require(`../../../src/drivers/${targetDriver}`);

        // Initialize with override path
        const targetDbInstance = await targetDriverModule.init({ dbPath: targetFile });
        const targetWrapper = targetDriverModule.get();

        // CRITICAL: Disable Foreign Keys to allow clearing/bulk insert without order issues
        if (targetWrapper.exec) targetWrapper.exec('PRAGMA foreign_keys = OFF;');
        else targetWrapper.run('PRAGMA foreign_keys = OFF;');

        // 4. Initialize Schema on Target
        dbManager.initializeSchema(targetWrapper);
        console.log('   Schema initialized on target.');

        // 5. Copy Data Table-by-Table
        let totalRows = 0;
        for (const table of TABLES) {
            // Read Source
            const rows = sourceDb.prepare(`SELECT * FROM ${table}`).all();

            if (rows.length > 0) {
                console.log(`   Copying ${rows.length} rows from table '${table}'...`);

                // Clear Table First (Idempotency fix for locked files)
                if (targetWrapper.exec) targetWrapper.exec(`DELETE FROM ${table}`);
                else targetWrapper.run(`DELETE FROM ${table}`);

                // Prepare Insert
                const keys = Object.keys(rows[0]);
                const placeholders = keys.map(() => '?').join(',');
                const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`;
                const stmt = targetWrapper.prepare(sql);

                // Execute Insert
                const isNative = targetDriver === 'sqlite-native';

                if (isNative) {
                    // use better-sqlite3 transaction for speed
                    const insertMany = targetWrapper.db.transaction((data) => {
                        for (const row of data) stmt.run(Object.values(row));
                    });
                    insertMany(rows);
                } else {
                    // Legacy Loop
                    for (const row of rows) {
                        stmt.run(...Object.values(row)); // CORRECT: Spread args for legacy wrapper
                    }
                }
                totalRows += rows.length;
            }
        }

        console.log(`✅ Data Copied (${totalRows} rows).`);

        // 6. Persist & Close Target
        if (targetDriverModule.save) targetDriverModule.save();
        // Don't close immediately, let the user switch?
        // Or close to release the file lock if we are about to switch.
        // If we switch config, the next server restart will try to open this file.
        // It's safe to close now.
        if (targetDriverModule.close) targetDriverModule.close();

        // 7. Update Configuration (ATOMIC SWITCH)
        configManager.saveConfig({
            dbDriver: targetDriver,
            dbPath: `./data/${targetFilename}`
        });

        res.json({
            success: true,
            message: `Migration successful! Installed driver & copied ${totalRows} rows. Restarting server...`
        });

        // Auto-Restart logic
        setTimeout(() => {
            console.log('🔄 Restarting server to apply new driver...');
            process.exit(0);
        }, 1000);

    } catch (e) {
        console.error('Migration Failed:', e);

        // ROLLBACK: Delete partial target file
        if (targetFile && fs.existsSync(targetFile)) {
            console.warn('⚠️ Rolling back: Deleting partial DB file.');
            try { fs.unlinkSync(targetFile); } catch (delErr) { console.error('Failed to cleanup:', delErr); }
        }

        res.status(500).json({ error: e.message });
    }
};
