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
    const siteData = await exportSite({
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

    // 4. Add ONLY the content roots that restoreBackup() actually restores (uploads/, plugins/,
    //    themes/). Walking the entire backend tree synchronously blocked the event loop and zipped
    //    code/config that restore never extracts anyway. Use async fs (fs.promises) so the walk does
    //    not block the event loop on large media libraries.
    const backendRoot = path.resolve(__dirname, '../../');
    const CONTENT_ROOTS = ['uploads', 'plugins', 'themes'];
    const excludes = [
        'node_modules', 'backups', 'logs', 'os-tmp', '.git', '.DS_Store', 'wordjs-content.json',
        'postgres-embed',
        'wordjs-native.db', 'wordjs-native.db-wal', 'wordjs-native.db-shm',
        'wordjs.db', 'wordjs.db-wal', 'wordjs.db-shm'
    ];

    async function addDirectoryToZip(zip, rootPath, relPath = '') {
        const fullPath = path.join(rootPath, relPath);
        const files = await fs.promises.readdir(fullPath);

        for (const file of files) {
            if (excludes.includes(file)) continue;
            // Also ignore backup zip files if they are somehow in root
            if (file.endsWith('.zip')) continue;

            const filePath = path.join(fullPath, file);
            const entryPath = relPath ? path.join(relPath, file) : file;
            const stats = await fs.promises.stat(filePath);

            if (stats.isDirectory()) {
                await addDirectoryToZip(zip, rootPath, entryPath);
            } else {
                const data = await fs.promises.readFile(filePath);
                zip.addFile(entryPath.replace(/\\/g, '/'), data);
            }
        }
    }

    for (const root of CONTENT_ROOTS) {
        const rootDir = path.join(backendRoot, root);
        try {
            await fs.promises.access(rootDir);
        } catch {
            continue; // content root doesn't exist on this install — skip
        }
        await addDirectoryToZip(zip, backendRoot, root);
    }

    // 4b. Physical database snapshot — a COMPLETE copy of the live DB (every table, incl.
    //     analytics/notifications/plugin tables/schema_migrations that the logical export above does
    //     NOT cover). The dir-walk excludes the live .db on purpose; we add a consistent snapshot here.
    try {
        const driver = config.dbDriver || 'sqlite-native';
        if (driver === 'sqlite-native' || driver === 'sqlite-legacy') {
            const dbModule = require('../config/database');
            // Flush in-memory (legacy sql.js) state to its file, then checkpoint the WAL (native) so the
            // .db file on disk is a consistent, complete snapshot before we copy it.
            try { if (typeof dbModule.saveDatabase === 'function') dbModule.saveDatabase(); } catch { /* best-effort flush */ }
            try {
                const dbi = typeof dbModule.getDbAsync === 'function' ? dbModule.getDbAsync() : null;
                if (dbi && typeof dbi.exec === 'function') await dbi.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } catch { /* no WAL / legacy — fine */ }
            const dbFile = path.resolve(
                config.dbPath || (driver === 'sqlite-native' ? './data/wordjs-native.db' : './data/wordjs.db')
            );
            if (fs.existsSync(dbFile)) {
                zip.addLocalFile(dbFile, 'database', 'wordjs.db');
                console.log('   ✓ Added physical database snapshot (database/wordjs.db) to backup.');
            }
        } else if (driver === 'postgres') {
            // Physical pg_dump is not bundled (needs the pg_dump binary); the logical export above is the
            // portable backup for Postgres. (pg_dump snapshot = follow-up.)
            console.log('   ℹ Postgres: physical snapshot skipped — logical export is the portable backup.');
        }
    } catch (e: any) {
        console.warn('   ⚠️ Could not add physical DB snapshot (logical export still included):', e && e.message);
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

    // 1. Restore ONLY content directories, each entry path-contained. We deliberately do NOT extract
    //    code or config from a backup (src/, node_modules/, package.json, wordjs-config*.json, .env):
    //    overwriting those is an RCE / JWT-secret-swap primitive, and a crafted zip could plant them.
    //    The previous guard only rejected the substring '..' and then extractAllTo'd the WHOLE archive
    //    over backendRoot. DB content is restored below via importSite (parameterized), not from files.
    const backendRoot = path.resolve(__dirname, '../../');
    const ALLOWED_TOP = ['uploads/', 'plugins/', 'themes/'];
    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replace(/\\/g, '/');
        if (!ALLOWED_TOP.some(top => name.startsWith(top))) continue; // skip code/config/anything else
        // Per-entry containment (defense-in-depth over adm-zip's own canonicalization): the resolved
        // destination must stay strictly inside backendRoot.
        const dest = path.resolve(backendRoot, name);
        if (dest !== backendRoot && !dest.startsWith(backendRoot + path.sep)) {
            throw new Error(`Malicious backup entry (path traversal): ${entry.entryName}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
    }

    // 3. Import Database
    const contentEntry = zip.getEntry('wordjs-content.json');
    if (!contentEntry) {
        throw new Error('Invalid backup: wordjs-content.json missing');
    }

    const contentJson = contentEntry.getData().toString('utf8');
    const data = JSON.parse(contentJson);

    // CRITICAL: For non-file-based drivers (like Postgres) OR for exact restoration,
    // we should effectively WIPE the database before importing if we want to match valid state.
    // For SQLite, the zip extraction might have already replaced the .db file physically.
    // If it did, 'importSite' is technically redundant but harmless (merge).
    // If we want to support "System State" for Postgres, we must Wipe then Import.

    const { getDbType, clearDatabase } = require('../config/database');
    const dbType = getDbType();

    if (dbType.driver !== 'sqlite-native' && dbType.driver !== 'sqlite-legacy') {
        // e.g. Postgres. Zip extraction didn't touch the DB. 
        // We must wipe it to ensure "deleted" items during backup window disappear.
        console.log(`🧹 Non-file driver detected (${dbType.driver}). Wiping database for clean restore...`);
        await clearDatabase();
    }

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
