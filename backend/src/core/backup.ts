/**
 * WordJS - Backup Service
 * Handles creating, listing, and restoring full site backups (DB + Media)
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { assertZipWithinBudget } = require('./zip-guard');
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

    async function addDirectoryToZip(zip: any, rootPath: string, relPath = '') {
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

    // Enforce retention so scheduled/auto backups don't fill the disk unbounded.
    try { await pruneBackups(); } catch (e: any) { console.warn('   ⚠️ Backup prune failed:', e && e.message); }

    return {
        filename,
        size: fs.statSync(filepath).size,
        date: new Date()
    };
}

/**
 * Prune old backups, keeping the newest `keep` (by date). When `keep` is omitted it is read from the
 * 'backup_retention' option (default 7); 0 or negative disables pruning (keep everything). This is the
 * disk-exhaustion guard for scheduled backups, which previously grew without bound.
 */
async function pruneBackups(keep?: number) {
    let n = keep;
    if (n == null) {
        const opt = await getOption('backup_retention', 7);
        n = parseInt(String(opt), 10);
        if (Number.isNaN(n)) n = 7;
    }
    if (!n || n <= 0) return { pruned: 0, kept: listBackups().length }; // 0 = unlimited

    const all = listBackups(); // newest first
    const toDelete = all.slice(n);
    let pruned = 0;
    for (const b of toDelete) {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, b.filename)); pruned++; }
        catch (e: any) { console.warn(`   ⚠️ Could not prune backup ${b.filename}:`, e && e.message); }
    }
    if (pruned) console.log(`   🧹 Pruned ${pruned} old backup(s); kept newest ${n}.`);
    return { pruned, kept: Math.min(all.length, n) };
}

/**
 * List all backups
 */
function listBackups() {
    if (!fs.existsSync(BACKUPS_DIR)) return [];

    const files = fs.readdirSync(BACKUPS_DIR)
        .filter((f: string) => f.endsWith('.zip'))
        .map((f: string) => {
            const stats = fs.statSync(path.join(BACKUPS_DIR, f));
            return {
                filename: f,
                size: stats.size,
                date: stats.birthtime
            };
        })
        .sort((a: any, b: any) => b.date - a.date); // Newest first

    return files;
}

/**
 * Delete a backup
 */
function deleteBackup(filename: string) {
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
function getBackupPath(filename: string) {
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
async function restoreBackup(filename: string) {
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

    // SECURITY: bound the uncompressed footprint before per-entry getData() (a RAM/disk bomb). A real
    // backup legitimately holds all uploads, so the cap is generous but finite.
    assertZipWithinBudget(zipEntries, { kind: 'backup', maxTotalBytes: 2 * 1024 * 1024 * 1024, maxEntries: 100000 });

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

    const dbModule = require('../config/database');
    const { getDbType, clearDatabase } = dbModule;
    const dbType = getDbType();
    const isSqlite = dbType.driver === 'sqlite-native' || dbType.driver === 'sqlite-legacy';

    // 3a. PHYSICAL restore (SQLite). createBackup() ships a COMPLETE snapshot as database/wordjs.db to
    //     carry the tables the logical export omits (analytics, notifications, plugin tables,
    //     schema_migrations). Previously restore IGNORED it (database/ was never extracted) and did a
    //     logical MERGE, which (a) never removed rows deleted since the backup and (b) never restored those
    //     out-of-scope tables — so the snapshot was dead weight (audit F-03). Restore it authoritatively:
    //     close the DB (releases the file lock), drop stale WAL/SHM sidecars so an old WAL can't overlay the
    //     restored file, atomically replace the .db at the SAME path createBackup read, then reopen. Any
    //     failure falls back to the logical path below, so a restore never leaves the DB half-swapped.
    const physEntry = isSqlite ? zip.getEntry('database/wordjs.db') : null;
    let physicalRestored = false;
    if (physEntry) {
        const dbFile = path.resolve(
            config.dbPath || (dbType.driver === 'sqlite-native' ? './data/wordjs-native.db' : './data/wordjs.db')
        );
        try {
            const snapshot = physEntry.getData();
            await dbModule.closeDatabase();
            for (const sidecar of [dbFile + '-wal', dbFile + '-shm']) {
                try { if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); } catch { /* best-effort */ }
            }
            fs.mkdirSync(path.dirname(dbFile), { recursive: true });
            // temp sibling + rename ⇒ no half-written .db if the write is interrupted.
            const tmp = dbFile + '.restore-tmp';
            fs.writeFileSync(tmp, snapshot);
            fs.renameSync(tmp, dbFile);
            await dbModule.init();               // reopen driver + async connection against the restored file
            await dbModule.initializeDatabase(); // re-run migrations (idempotent) + analytics + divergence guard
            physicalRestored = true;
            console.log('   ✓ Physical database snapshot restored (all tables).');
        } catch (e: any) {
            console.warn('   ⚠️ Physical DB restore failed — falling back to logical import:', e && e.message);
            try { await dbModule.init(); } catch { /* ensure the DB is open again for the fallback below */ }
            physicalRestored = false;
        }
    }

    // 3b. Logical restore (Postgres, older backups with no physical snapshot, or a failed physical swap).
    //     WIPE first so rows deleted since the backup actually disappear — this previously ran for non-file
    //     drivers ONLY, so a SQLite logical restore was a merge that resurrected deleted content (audit
    //     F-03, defect #1). importSite then repopulates the logical tables.
    if (!physicalRestored) {
        console.log(`🧹 Logical restore: wiping content tables (${dbType.driver}) before import...`);
        await clearDatabase();
        const results = await importSite(data, {
            updateExisting: true, // Overwrite existing content
            importUsers: true
        });
        console.log('✅ Restore complete (logical import)');
        return results;
    }

    console.log('✅ Restore complete (physical snapshot)');
    return { physical: true, driver: dbType.driver };
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    getBackupPath,
    restoreBackup,
    pruneBackups
};
