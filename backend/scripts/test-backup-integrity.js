
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
            { path: 'node_modules', required: false, mustNotExist: true, desc: 'node_modules (Should be EXCLUDED)' }
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
        console.log(`      - Generator: ${content.generator}`);
        console.log(`      - Posts: ${content.content.posts?.length || 0}`);
        console.log(`      - Pages: ${content.content.pages?.length || 0}`);
        console.log(`      - Users: ${content.content.users?.length || 0}`);

        if (!content.content.posts && !content.content.pages) {
            console.warn('   ⚠️  Warning: No posts or pages found in dump. Is the DB empty?');
        } else {
            console.log('   ✅ Data content seems valid.');
        }

        console.log('\n✨ TEST RESULT: SUCCESS! The backup is complete and restorable.');

    } catch (e) {
        console.error('\n❌ TEST RESULT: FAILED');
        console.error(e);
    } finally {
        // 7. Cleanup
        console.log('\n7️⃣  Cleaning up...');
        try {
            if (db) db.closeDatabase();
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
