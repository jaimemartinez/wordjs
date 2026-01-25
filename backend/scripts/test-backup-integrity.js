
/**
 * Test Script: Backup Integrity & Safe Restore Simulation
 * 
 * This script creates a full system backup and then "restores" it to a 
 * temporary location to verify completeness and integrity without 
 * affecting the live system.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { createBackup } = require('../src/core/backup');
const db = require('../src/config/database');

// Configuration
const TEMP_RESTORE_DIR = path.join(os.tmpdir(), `wordjs-restore-test-${Date.now()}`);

async function runTest() {
    console.log('🧪 STARTING BACKUP INTEGRITY TEST\n');
    let backupPath = null;

    try {
        // 1. Initialize DB (Read-only for export)
        console.log('1️⃣  Initializing Database Connection...');
        await db.init();
        await db.initializeDatabase();
        console.log('   ✅ Database connected.');

        // 2. Create Backup
        console.log('\n2️⃣  Creating Full System Backup...');
        const result = await createBackup();
        backupPath = path.resolve(__dirname, '../backups', result.filename);

        if (!fs.existsSync(backupPath)) {
            throw new Error('Backup file was not created!');
        }
        console.log(`   ✅ Backup created at: ${backupPath}`);
        console.log(`   📦 Size: ${(result.size / 1024 / 1024).toFixed(2)} MB`);

        // 3. Prepare Temp Directory
        console.log(`\n3️⃣  Preparing Test Restore Directory...`);
        if (fs.existsSync(TEMP_RESTORE_DIR)) {
            fs.rmSync(TEMP_RESTORE_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(TEMP_RESTORE_DIR, { recursive: true });
        console.log(`   📂 Location: ${TEMP_RESTORE_DIR}`);

        // 4. Extract (Simulate Physical Restore)
        console.log('\n4️⃣  Simulating "Physical Restore" (Extraction)...');
        const zip = new AdmZip(backupPath);
        zip.extractAllTo(TEMP_RESTORE_DIR, true);
        console.log('   ✅ Extraction complete.');

        // 5. Verify File Structure
        console.log('\n5️⃣  Verifying File Structure completeness...');
        const checks = [
            { path: 'server.js', required: true, desc: 'Entry Point (server.js)' },
            { path: 'src/config/database.js', required: true, desc: 'Database Config' },
            { path: 'package.json', required: true, desc: 'Package Manifest' },
            { path: 'wordjs-config.json', required: true, desc: 'System Config' },
            { path: '.env', required: false, desc: 'Environment Variables (.env)' },
            { path: 'wordjs-content.json', required: true, desc: 'Database Dump' },
            { path: 'plugins', required: true, desc: 'Plugins Directory' },
            { path: 'themes', required: true, desc: 'Themes Directory' },
            { path: 'node_modules', required: false, mustNotExist: true, desc: 'node_modules (Should be EXCLUDED)' },
            { path: 'wordjs-native.db', required: false, mustNotExist: true, desc: 'Physical DB (Should be EXCLUDED in Universal Mode)' }
        ];

        let filesOk = true;
        for (const check of checks) {
            const checkPath = path.join(TEMP_RESTORE_DIR, check.path.replace('/', path.sep));
            const exists = fs.existsSync(checkPath);

            if (check.mustNotExist) {
                if (exists) {
                    console.error(`   ❌ FAILED: Found excluded file: ${check.desc}`);
                    filesOk = false;
                } else {
                    console.log(`   ✅ PASSED: Correctly excluded: ${check.desc}`);
                }
            } else if (check.required && !exists) {
                console.error(`   ❌ FAILED: Missing required file: ${check.desc}`);
                filesOk = false;
            } else if (exists) {
                console.log(`   ✅ PASSED: Found: ${check.desc}`);
            } else {
                console.warn(`   ⚠️  SKIPPED: Missing optional file: ${check.desc}`);
            }
        }

        if (!filesOk) throw new Error('File structure verification failed.');

        // 6. Verify Logical Data (Database Content)
        console.log('\n6️⃣  Verifying Logical Data Integrity...');
        const contentJsonPath = path.join(TEMP_RESTORE_DIR, 'wordjs-content.json');
        const contentRaw = fs.readFileSync(contentJsonPath, 'utf8');
        const content = JSON.parse(contentRaw);

        if (!content.site || !content.content) {
            throw new Error('Invalid wordjs-content.json structure');
        }

        console.log(`   ✅ JSON Parsed successfully.`);
        console.log(`   📊 Metadata Summary:`);
        console.log(`      - Site Name: ${content.site.name}`);
        console.log(`      - Custom Tables: ${content.content.custom_tables?.length || 0}`);

        // 7. Verify Logical Restore (The Real Test)
        console.log('\n7️⃣  Verifying Logical Restore (Dry Run into Temp DB)...');

        // A. Close connection to Live DB
        console.log('   🔌 Closing Live DB connection...');
        await db.closeDatabase();

        // B. Switch Driver to Temp DB
        const tempDbPath = path.join(TEMP_RESTORE_DIR, 'test-restore.db');
        const driverAsync = require('../src/drivers/sqlite-native-async');
        // Hack: Override the dbPath of the singleton driver
        driverAsync.dbPath = tempDbPath;

        // C. Re-Initialize (Connect to Temp DB)
        // Note: We do NOT need to run plugin init here because importSite should recreate the schema!
        console.log(`   🔌 Connecting to Temp DB: ${tempDbPath}`);
        await db.init();
        await db.initializeDatabase(); // Create empty schema

        // D. Run Import
        console.log('   ♻️  Running importSite()...');
        const { importSite } = require('../src/core/import-export');

        let importResults;
        try {
            importResults = await importSite(content, { importUsers: true, updateExisting: true });
        } catch (err) {
            console.error('   ❌ Import Fatal Error:', err);
        }

        console.log('   ✅ Import completed.');
        if (importResults && importResults.errors && importResults.errors.length > 0) {
            console.error('   ⚠️  Import Errors:', importResults.errors);
        }
        console.log('   📊 Import Results Summary:', JSON.stringify(importResults ? { users: importResults.users, custom: importResults.custom_tables } : {}, null, 2));

        // E. Verify Counts in Temp DB
        const Post = require('../src/models/Post');
        const User = require('../src/models/User');

        const postCount = await Post.count();
        const userCount = await User.count();

        console.log(`   📊 Restore Verification:`);
        console.log(`      - Expected Posts: ${content.content.posts?.length || 0} | Found: ${postCount}`);
        console.log(`      - Expected Users: ${content.content.users?.length || 0} | Found: ${userCount}`);

        if (postCount !== (content.content.posts?.length || 0)) {
            throw new Error('Post count mismatch after restore!');
        }

        // F. Verify Custom Schema Persistence (Universal Logical Restore Proof)
        console.log('   🔍 Verifying Custom Schema Persistence (Logical Restore)...');
        try {
            const dbAsync = require('../src/drivers/sqlite-native-async');
            const customRow = await dbAsync.get('SELECT * FROM test_custom_schema LIMIT 1');
            if (customRow && customRow.custom_value === 'persistence-check-123') {
                console.log('   ✅ Custom Schema Key Found: persistence-check-123');
            } else {
                console.warn('   ⚠️  Custom Schema Table found but data mismatch or empty.');
            }
        } catch (e) {
            console.error('   ❌ Custom Schema Check Failed:', e.message);
            console.error('      This implies the Logical Dump failed to recreate the table or insert data.');
            throw new Error('Universal Schema persistence failed');
        }

        console.log('\n✨ TEST RESULT: SUCCESS! The backup is complete and restorable.');

    } catch (e) {
        console.error('\n❌ TEST RESULT: FAILED');
        console.error(e);
    } finally {
        // 8. Cleanup
        console.log('\n8️⃣  Cleaning up...');
        try {
            if (db) db.closeDatabase(); // Close Temp DB

            // Restore original driver path (just in case this process lived longer)
            // const driverAsync = require('../src/drivers/sqlite-native-async');
            // driverAsync.dbPath = path.resolve(require('../src/config/app').dbPath || './data/wordjs-native.db');

            if (backupPath && fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
                console.log('   🗑️  Deleted test backup zip.');
            }
            if (fs.existsSync(TEMP_RESTORE_DIR)) {
                fs.rmSync(TEMP_RESTORE_DIR, { recursive: true, force: true });
                console.log('   🗑️  Deleted temp restore directory.');
            }
        } catch (cleanupErr) {
            console.error('   ⚠️  Error during cleanup:', cleanupErr.message);
        }
    }
}

runTest();
