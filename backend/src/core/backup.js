/**
 * WordJS - Backup Service
 * Handles creating, listing, and restoring full site backups (DB + Media)
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { exportSite, importSite } = require('./import-export');
const config = require('../config/app');
const { getOption } = require('./options');

const UPLOADS_DIR = path.resolve(config.uploads.dir);

const BACKUPS_DIR = path.resolve(__dirname, '../../backups');

// Ensure backups dir exists
if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/**
 * Create a full backup
 * @returns {Promise<string>} Filename of the backup
 */
async function createBackup() {
    console.log('📦 Starting backup process...');

    // 1. Generate Logical DB Export
    const siteData = exportSite({
        includeMedia: true,
        includePosts: true,
        includePages: true,
        includeUsers: true,
        includeSettings: true,
        includeMenus: true
    });

    // 2. Prepare Zip
    const zip = new AdmZip();

    // 3. Add DB Dump
    zip.addFile('wordjs-content.json', Buffer.from(JSON.stringify(siteData, null, 2)));

    // 4. Add Media Files
    // We only add the folder if it exists
    if (fs.existsSync(UPLOADS_DIR)) {
        zip.addLocalFolder(UPLOADS_DIR, 'uploads');
    }

    // 5. Save Zip
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.zip`;
    const filepath = path.join(BACKUPS_DIR, filename);

    zip.writeZip(filepath);

    console.log(`✅ Backup created: ${filename}`);
    return {
        filename,
        size: fs.statSync(filepath).size,
        date: new Date()
    };
}

/**
 * List all backups
 */
function listBackups() {
    if (!fs.existsSync(BACKUPS_DIR)) return [];

    const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.endsWith('.zip'))
        .map(f => {
            const stats = fs.statSync(path.join(BACKUPS_DIR, f));
            return {
                filename: f,
                size: stats.size,
                date: stats.birthtime
            };
        })
        .sort((a, b) => b.date - a.date); // Newest first

    return files;
}

/**
 * Delete a backup
 */
function deleteBackup(filename) {
    // Security: Prevent Directory Traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename');
    }

    const filepath = path.join(BACKUPS_DIR, filename);
    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return true;
    }
    return false;
}

/**
 * Get absolute path for a backup (for download)
 */
function getBackupPath(filename) {
    // Security: Prevent Directory Traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename');
    }

    const filepath = path.join(BACKUPS_DIR, filename);
    if (fs.existsSync(filepath)) {
        return filepath;
    }
    return null;
}

/**
 * Restore a backup
 * WARNING: Destructive operation
 */
async function restoreBackup(filename) {
    // Security: Prevent Directory Traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename');
    }

    const filepath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(filepath)) {
        throw new Error('Backup file not found');
    }

    console.log(`♻️ Restoring backup: ${filename}...`);

    const zip = new AdmZip(filepath);
    const zipEntries = zip.getEntries();

    // 1. Security Check (Zip Slip)
    zipEntries.forEach(entry => {
        if (entry.entryName.indexOf('..') !== -1) {
            throw new Error('Malicious backup file detected (Zip Slip)');
        }
    });

    // 2. Extract uploads
    // We look for entries starting with 'uploads/'
    // We can extract everything, effectively overwriting uploads
    zip.extractAllTo(path.resolve(UPLOADS_DIR, '..'), true); // Extracts 'uploads/file.jpg' to '../uploads/file.jpg' relative to UPLOADS_DIR?? 
    // Wait, UPLOADS_DIR is absolute. 
    // If zip contains 'uploads/foo.jpg', we want to extract it to the PARENT of UPLOADS_DIR so it reconstructs the folder?
    // Or simpler: Extract 'uploads' content directly into UPLOADS_DIR.
    // AdmZip extractAllTo(targetPath, overwrite)

    // Let's inspect structure. We added local folder 'uploads' as 'uploads'.
    // So root of zip has 'wordjs-content.json' and 'uploads/'.
    // If we extract to backend root, it will overwrite 'uploads/'.
    const backendRoot = path.resolve(__dirname, '../../');
    zip.extractAllTo(backendRoot, true);

    // 3. Import Database
    const contentEntry = zip.getEntry('wordjs-content.json');
    if (!contentEntry) {
        throw new Error('Invalid backup: wordjs-content.json missing');
    }

    const contentJson = contentEntry.getData().toString('utf8');
    const data = JSON.parse(contentJson);

    // Run import
    const results = await importSite(data, {
        updateExisting: true, // Overwrite existing content
        importUsers: true
    });

    console.log('✅ Restore complete');
    return results;
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    getBackupPath,
    restoreBackup
};
