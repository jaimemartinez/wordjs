/**
 * WordJS - Backup Service
 * Handles creating, listing, and restoring full site backups (DB + Media)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { assertZipWithinBudget } = require('./zip-guard');
const { resolveWithin } = require('./safe-path');
const { exportSite, importSite } = require('./import-export');
const config = require('../config/app');
const { getOption } = require('./options');
const { captureDump, restoreDump, dumpEntryName, usesExternalDump } = require('./db-dump');
const { offloadBackup } = require('./s3-offload');

const UPLOADS_DIR = path.resolve(config.uploads.dir);

const BACKUPS_DIR = path.resolve(__dirname, '../../backups');

// Ensure backups dir exists
if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/**
 * Run `fn` with a PRIVATE scratch directory under the OS temp dir, and delete it afterwards.
 *
 * The database dump that passes through here is the whole site — every row, including password
 * hashes and tokens. It used to be written to `os.tmpdir()/wordjs-db{dump,restore}-<pid>-<ts>-<entry>`,
 * a name any local process can PREDICT and therefore win the race for: pre-create the path as a
 * symlink and the dump is written through it (or is simply readable, since writeFileSync/pg_dump
 * create with the process umask — 0644 on a typical host).
 *
 * mkdtemp is the fix, not a longer name: the OS picks six random characters AND creates the
 * directory with 0700 in one non-racy syscall, so the dump lands somewhere no other user can even
 * traverse. On Windows there is no 0700, but mkdtemp still lands inside the per-user %TEMP%, whose
 * ACL already excludes other users — and the unpredictable name closes the pre-creation race on
 * both platforms. Cleanup is in `finally`, so a failed dump/restore leaves nothing behind.
 */
async function withPrivateTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        return await fn(dir);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
    }
}

/**
 * The file name a dump gets INSIDE that private directory. dumpEntryName() only ever returns one of
 * two literals, but the guard is structural on purpose: a name is what CHOOSES the path, so it is
 * validated against an anchored allowlist (basename + [A-Za-z0-9._-]) instead of trusted because it
 * "looks fine" or because it contains no `..`.
 */
function safeDumpFileName(entry: string): string {
    const name = path.basename(String(entry));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new Error(`Refusing to use unsafe dump entry name: ${entry}`);
    }
    return name;
}

/**
 * Create a full backup
 * @returns {Promise<string>} Filename of the backup
 */
async function createBackup() {
    console.log('📦 Starting backup process...');
    // What this archive could NOT include. `complete:false` means the ZIP is missing something a
    // restore will need — see the class note above withIncidents().
    const incidents: BackupIncident[] = [];

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
    const driver = config.dbDriver || 'sqlite-native';
    if (driver === 'sqlite-native' || driver === 'sqlite-legacy') {
        // SQLite is a single file we copy. Best-effort: if the copy fails the logical export is still a
        // usable fallback for the file drivers, so a copy hiccup shouldn't abort the whole backup.
        try {
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
        } catch (e: any) {
            console.warn('   ⚠️ Could not add physical DB snapshot (logical export still included):', e && e.message);
            // The PRODUCER half of the same class. An archive without the snapshot can only be
            // restored logically, i.e. WITHOUT analytics, notifications, plugin tables or
            // schema_migrations — a fact the operator can otherwise only discover during a recovery.
            incidents.push({
                stage: 'database',
                message: `The physical database snapshot could not be added (${e && e.message}); this archive can only be restored logically, which does NOT cover analytics, notifications, plugin tables or schema_migrations.`
            });
        }
    } else if (usesExternalDump(driver)) {
        // Postgres / MySQL: the logical JSON export OMITS analytics / notifications / plugin tables /
        // schema_migrations, so a backup without a real pg_dump/mysqldump is a SILENT DATA-LOSS TRAP.
        // captureDump FAILS LOUD when the tool is missing — do NOT swallow it (that would ship an
        // incomplete archive that looks complete). Any error here aborts the backup.
        const entry = dumpEntryName(driver);
        if (entry) {
            await withPrivateTempDir('wordjs-dbdump-', async (tmpDir) => {
                const tmpDump = path.join(tmpDir, safeDumpFileName(entry));
                await captureDump(driver, tmpDump, config.db);
                zip.addLocalFile(tmpDump, 'database', entry);
                console.log(`   ✓ Added physical database dump (database/${entry}) to backup.`);
            });
        }
    }

    // 5. Save Zip
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.zip`;
    const filepath = path.join(BACKUPS_DIR, filename);

    zip.writeZip(filepath);

    console.log(`✅ Backup created: ${filename}`);

    // Enforce retention so scheduled/auto backups don't fill the disk unbounded.
    try { await pruneBackups(); } catch (e: any) { console.warn('   ⚠️ Backup prune failed:', e && e.message); }

    // Optional S3 offload (config-gated). No-op unless bucket + keys are configured; on failure the local
    // copy is kept and the failure is reported — an unreachable bucket never fails a good local backup.
    // Assigned on both paths below (the try's first statement, or the catch), so no initializer — the
    // value would be dead (eslint no-useless-assignment).
    let s3: any;
    try {
        s3 = await offloadBackup(filepath, filename);
        if (s3.offloaded) console.log(`   ☁ Offloaded backup to S3: s3://${s3.bucket}/${s3.key}`);
        else if (s3.reason === 'upload-failed') console.warn('   ⚠️ S3 offload failed (local copy kept):', s3.error);
    } catch (e: any) {
        // offloadBackup is designed not to throw; guard anyway so offload can never fail the backup.
        s3 = { offloaded: false, reason: 'upload-failed', error: e && e.message };
        console.warn('   ⚠️ S3 offload error (local copy kept):', e && e.message);
    }

    // `s3` stays a field of its own (an unreachable bucket does not make the ARCHIVE incomplete);
    // `complete`/`incidents` describe what is inside the ZIP.
    return withIncidents({
        filename,
        size: fs.statSync(filepath).size,
        date: new Date(),
        s3
    }, incidents);
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
 * ── WHAT DID NOT HAPPEN TRAVELS WITH THE RESULT ──────────────────────────────────────────────────
 *
 * THE CLASS: an operation here can complete PARTIALLY — an entry it could not write, a physical
 * snapshot it could not take or could not restore, a cache it could not flush — and every one of
 * those used to be told to `console.warn` alone, while the value returned to the caller was shaped
 * exactly like a total success. The API then answered `{success:true}` and the operator concluded
 * that a disaster recovery had brought everything back. That is the same lie the traversal fix
 * removed in the other direction ("the restore aborted" ≠ "nothing was written"), and in a recovery
 * it is the more expensive one: files the database still points at are simply gone.
 *
 * THE RULE, and it applies to every future partial outcome in this file: a step that could not do
 * its job records an INCIDENT, and the return value of the operation always carries the incident
 * list plus a boolean `complete`. Never a warning alone. `createBackup` already did this for the S3
 * offload (it returns `s3`), which is why that one failure mode was the only visible one.
 */
type BackupIncident = { stage: string; message: string; items?: string[] };

/** Attach the incident list to whatever the operation produced, without hiding its own shape. */
function withIncidents<T>(result: T, incidents: BackupIncident[]): any {
    const base = (result && typeof result === 'object' && !Array.isArray(result)) ? result : { result };
    return { ...base, complete: incidents.length === 0, incidents };
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

    // 1. PROVE THIS IS A BACKUP BEFORE WRITING ANYTHING. Parsing wordjs-content.json used to happen
    //    AFTER the extraction loop below, so an archive that turned out not to be a backup at all had
    //    already dropped its files on disk by the time it was rejected. Validation first, writes second.
    const contentEntry = zip.getEntry('wordjs-content.json');
    if (!contentEntry) {
        throw new Error('Invalid backup: wordjs-content.json missing');
    }
    const contentJson = contentEntry.getData().toString('utf8');
    const data = JSON.parse(contentJson);

    // 2. Restore ONLY content directories, each entry path-contained. We deliberately do NOT extract
    //    code or config from a backup (src/, node_modules/, package.json, wordjs-config*.json, .env):
    //    overwriting those is an RCE / JWT-secret-swap primitive, and a crafted zip could plant them.
    //    DB content is restored below via importSite (parameterized), not from files.
    //
    //    WHAT THE PREVIOUS GUARD GOT WRONG — and it is the recurring shape in this codebase: it checked
    //    ONE STRING and used ANOTHER. The prefix test ran on the RAW entry name (`name.startsWith('themes/')`)
    //    while the write used `path.resolve(backendRoot, name)`, and containment was proved against
    //    backendRoot instead of the content root the prefix claimed. So `themes/../dist/index.js`
    //    passed the prefix test (it does start with `themes/`) AND the containment test (it resolves
    //    inside backendRoot) and overwrote compiled code. adm-zip does not normalize entry names on
    //    READ, so the name reaches us exactly as the archive author wrote it.
    //
    //    The defence is the one routes/themes.ts already uses for uploaded theme zips: split into
    //    segments, drop empties, resolve with safe-path's resolveWithin (which rejects `..`, absolute
    //    and drive-relative segments by FORM, not by substring search), and prove containment against
    //    the CONCRETE content root.
    //
    //    TWO PASSES, AND THE REASON IS THE WHOLE POINT OF THE GUARD. Validating and writing in the
    //    same loop meant a hostile archive could put N legitimate entries in front of its traversal
    //    entry: the N were already on disk by the time the throw fired, so "the restore aborted"
    //    (what the operator sees) and "nothing was written" (what they conclude) were different
    //    statements — with plugin code planted under backend/plugins/<slug>/ in between. Pass 1
    //    resolves and classifies EVERY entry and writes nothing; pass 2 writes a list that is already
    //    proved. This is what routes/themes.ts and core/themes.ts do.
    //
    //    HOSTILE vs MERELY UNREPRESENTABLE. resolveWithin refuses a segment containing ':' or a
    //    backslash for Win32 reasons (NTFS alternate data streams, separator ambiguity) — but ':' is
    //    a perfectly legal character in a POSIX file name, and a backup's plugins/ and themes/ trees
    //    are arbitrary. Treating that as an attack aborted the entire disaster recovery and told the
    //    operator their backup was malicious. Disaster recovery is the one operation that must not
    //    refuse to run: an entry that only fails because its NAME cannot be represented here is
    //    SKIPPED and reported, while an entry that actually points somewhere else ('..', absolute,
    //    drive-relative) still aborts the whole restore before anything is written.
    const backendRoot = path.resolve(__dirname, '../../');
    const RESTORABLE_ROOTS = ['uploads', 'plugins', 'themes'];
    /** A segment that names somewhere OTHER than a child of the current directory. */
    const escapesUpward = (seg: string) =>
        seg === '..' || seg.includes('\0') || path.isAbsolute(seg) || /^[A-Za-z]:/.test(seg);
    const planned: Array<{ dest: string; entry: any }> = [];
    const skipped: string[] = [];
    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;
        const name = String(entry.entryName).replace(/\\/g, '/');
        // '.' names the directory it sits in, so dropping it changes nothing; '..' must survive to be
        // rejected below.
        const segments = name.split('/').filter((s: string) => s !== '' && s !== '.');
        const top = segments[0];
        if (!RESTORABLE_ROOTS.includes(top)) continue; // skip code/config/anything else
        if (segments.some(escapesUpward)) {
            throw new Error(`Malicious backup entry (path traversal): ${entry.entryName}`);
        }
        const contentRoot = path.resolve(backendRoot, top);
        const dest = resolveWithin(backendRoot, ...segments);
        if (dest === null || !dest.startsWith(contentRoot + path.sep)) {
            // Not upward-pointing (checked above) — the name simply cannot be written here.
            skipped.push(entry.entryName);
            continue;
        }
        planned.push({ dest, entry });
    }
    for (const { dest, entry } of planned) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
    }
    const incidents: BackupIncident[] = [];
    if (skipped.length) {
        console.warn(`   ⚠️ ${skipped.length} backup entr${skipped.length === 1 ? 'y' : 'ies'} skipped — the name cannot be represented on this filesystem: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', …' : ''}`);
        // …AND it goes back to the caller. A recovery that silently dropped files while answering
        // `{success:true}` leaves the operator with broken media the database still references, or a
        // plugin directory missing one file, and no way to know which.
        incidents.push({
            stage: 'files',
            message: `${skipped.length} archive entr${skipped.length === 1 ? 'y' : 'ies'} could not be written: the name is not representable on this filesystem. Restore those file(s) by hand from the archive.`,
            items: skipped
        });
    }

    // 3. Import Database

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
            // Same class as the skipped entries: the fallback restores the LOGICAL tables only, so
            // analytics, notifications, plugin tables and schema_migrations do not come back. The
            // operator must be told, not the log.
            incidents.push({
                stage: 'database',
                message: `The physical database snapshot could not be restored (${e && e.message}); the logical import ran instead, which does NOT restore analytics, notifications, plugin tables or schema_migrations.`
            });
            try { await dbModule.init(); } catch { /* ensure the DB is open again for the fallback below */ }
            physicalRestored = false;
        }
    } else if (usesExternalDump(dbType.driver)) {
        // 3a'. PHYSICAL restore (Postgres / MySQL). A backup made by the new path ships a real pg_dump /
        //      mysqldump under database/<driver>.*; restore it authoritatively with pg_restore / mysql.
        //      restoreDump FAILS LOUD if the vendor tool is missing — we deliberately do NOT catch that and
        //      fall back to the (incomplete) logical import, since that would silently under-restore the DB.
        //      A backup with NO dump entry (older logical-only archive) leaves physicalRestored=false and
        //      falls through to the logical path below — backward compatible.
        const entryName = dumpEntryName(dbType.driver);
        const dumpEntry = entryName ? zip.getEntry('database/' + entryName) : null;
        if (entryName && dumpEntry) {
            await withPrivateTempDir('wordjs-dbrestore-', async (tmpDir) => {
                const tmp = path.join(tmpDir, safeDumpFileName(entryName));
                // mode 0600 as well as the 0700 directory: defence in depth if the platform ever
                // hands back a temp dir with looser permissions than mkdtemp promises.
                fs.writeFileSync(tmp, dumpEntry.getData(), { mode: 0o600 });
                await restoreDump(dbType.driver, tmp, config.db);
                physicalRestored = true;
                console.log('   ✓ Physical database dump restored (all tables).');
            });
        }
    }

    // 3b. Logical restore (older backups with no physical snapshot, or a failed physical swap).
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
        // The DB just time-traveled: every cached value (L1 included) describes the PRE-restore
        // state and would be served for up to its TTL. Drop it all.
        try { await require('./cache').flush(); }
        catch (e: any) { incidents.push({ stage: 'cache', message: `The cache could not be flushed (${e && e.message}); pre-restore values may be served until their TTL expires.` }); }
        console.log(`✅ Restore ${incidents.length ? 'finished with warnings' : 'complete'} (logical import)`);
        return withIncidents(results, incidents);
    }

    try { await require('./cache').flush(); }
    catch (e: any) { incidents.push({ stage: 'cache', message: `The cache could not be flushed (${e && e.message}); pre-restore values may be served until their TTL expires.` }); }
    console.log(`✅ Restore ${incidents.length ? 'finished with warnings' : 'complete'} (physical snapshot)`);
    return withIncidents({ physical: true, driver: dbType.driver }, incidents);
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    getBackupPath,
    restoreBackup,
    pruneBackups
};
