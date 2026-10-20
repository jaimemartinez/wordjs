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
const { logSafe } = require('./log-safe');
const log = require('./module-logger').moduleLogger('core/backup');

/** Top-level archive directory that carries config.uploads.privateDir (see createBackup step 4a). */
const PRIVATE_UPLOADS_ARCHIVE_ROOT = 'private-uploads';

const BACKUPS_DIR = path.resolve(__dirname, '../../backups');

/**
 * MULTISITE. Each site of a network has its own backups, made and restored by its own administrators
 * (the main site's stay with the network administrators). A backup of a site other than the main one is
 * that site only: its database (its SQLite file, its Postgres schema, its MySQL database), its uploads
 * and its private files — never the network's plugin and theme code, which a site's restore must not be
 * able to replace. Its archives live with the site, in `<data dir>/sites/<id>/backups`.
 */
function currentSiteId(): number {
    return require('./site-context').currentSiteId();
}
function onSecondarySite(): boolean {
    return currentSiteId() !== 1;
}
function backupsDir(): string {
    if (!onSecondarySite()) return BACKUPS_DIR;
    const dir = path.join(require('./network').siteDataDir(currentSiteId()), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    return dir;
}

/**
 * Where the current site's database is, for the dump tools: the main site's connection settings, or a
 * site's own Postgres schema / MySQL database (core/site-storage). On a network over Postgres the main
 * site's dump is limited to ITS schema: the database also holds every other site and the network store.
 */
async function dumpConfigForCurrentSite(driver: string): Promise<any> {
    const storage = require('./site-storage');
    const multisite = require('./site-context').multisiteEnabled();
    if (!onSecondarySite()) {
        if (multisite && driver === 'postgres') {
            const d = require('../config/database').getDbAsync();
            return { ...config.db, schema: typeof d.currentSchema === 'function' ? await d.currentSchema() : 'public' };
        }
        return config.db;
    }
    if (driver === 'postgres') return { ...config.db, schema: storage.sitePgSchema(currentSiteId()) };
    return { ...config.db, name: storage.siteMysqlDatabase(currentSiteId()) };
}

/** The current site's SQLite file (the main site's config.dbPath, or a site's own database file). */
function sqliteFileForCurrentSite(driver: string): string {
    if (onSecondarySite()) {
        const d = require('../config/database').getDbAsync();
        if (d && typeof d.dbPath === 'string') return path.resolve(d.dbPath);
    }
    return path.resolve(config.dbPath || (driver === 'sqlite-native' ? './data/wordjs-native.db' : './data/wordjs.db'));
}

/**
 * A backup archive is the whole site (the database, password hashes, tokens, private media), so the
 * directory is owner-only (0700) and every archive is created 0600, whatever the process umask.
 * Archives written by an older version keep the mode they were created with, so the directory and
 * every archive in it are tightened when this module loads (boot). POSIX only: Windows has no mode
 * bits, and the directory inherits the install's ACL.
 */
const BACKUP_FILE_MODE = 0o600;
const BACKUP_DIR_MODE = 0o700;

function hardenBackupPermissions(dir: string = BACKUPS_DIR): number {
    if (process.platform === 'win32') return 0;
    let fixed = 0;
    try {
        if ((fs.statSync(dir).mode & 0o777) !== BACKUP_DIR_MODE) { fs.chmodSync(dir, BACKUP_DIR_MODE); fixed++; }
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.zip')) continue;
            const file = path.join(dir, f);
            const st = fs.lstatSync(file);
            if (!st.isFile()) continue; // never chmod through a symlink
            if ((st.mode & 0o777) !== BACKUP_FILE_MODE) { fs.chmodSync(file, BACKUP_FILE_MODE); fixed++; }
        }
    } catch (e: any) {
        log.warn({ err: e }, '   ⚠️ Could not tighten the permissions of the backups directory');
    }
    return fixed;
}

// Ensure backups dir exists
if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: BACKUP_DIR_MODE });
}
hardenBackupPermissions();

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
    log.info('📦 Starting backup process...');
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
    // A site other than the main one archives its own uploads (as uploads/) and no code.
    const CONTENT_ROOTS = onSecondarySite() ? [] : ['uploads', 'plugins', 'themes'];
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
    if (onSecondarySite()) {
        const siteUploads = require('./private-media').publicUploadsRoot();
        let present = true;
        try { await fs.promises.access(siteUploads); } catch { present = false; }
        if (present) {
            const walk = async (rel: string): Promise<void> => {
                for (const name of await fs.promises.readdir(rel ? path.join(siteUploads, rel) : siteUploads)) {
                    if (excludes.includes(name)) continue;
                    const childRel = rel ? path.join(rel, name) : name;
                    const st = await fs.promises.lstat(path.join(siteUploads, childRel));
                    if (st.isDirectory()) await walk(childRel);
                    else if (st.isFile()) zip.addFile(`uploads/${childRel.replace(/\\/g, '/')}`, await fs.promises.readFile(path.join(siteUploads, childRel)));
                }
            };
            await walk('');
        }
    }

    // 4a. PRIVATE media (core/private-media.ts) lives outside uploads/ — by design nothing serves it —
    //     so it is archived under its own top-level name and restored back into the configured
    //     private root. A backup without it would restore rows pointing at files that are gone.
    {
        const privateRoot = require('./private-media').privateUploadsRoot();
        let present = true;
        try { await fs.promises.access(privateRoot); } catch { present = false; }
        if (present) {
            const walk = async (rel: string): Promise<void> => {
                const dir = rel ? path.join(privateRoot, rel) : privateRoot;
                for (const name of await fs.promises.readdir(dir)) {
                    const childRel = rel ? path.join(rel, name) : name;
                    const st = await fs.promises.lstat(path.join(privateRoot, childRel));
                    if (st.isDirectory()) await walk(childRel);
                    else if (st.isFile()) {
                        const data = await fs.promises.readFile(path.join(privateRoot, childRel));
                        zip.addFile(`${PRIVATE_UPLOADS_ARCHIVE_ROOT}/${childRel.replace(/\\/g, '/')}`, data);
                    }
                }
            };
            await walk('');
        }
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
            const dbFile = sqliteFileForCurrentSite(driver);
            if (fs.existsSync(dbFile)) {
                zip.addLocalFile(dbFile, 'database', 'wordjs.db');
                log.info('   ✓ Added physical database snapshot (database/wordjs.db) to backup.');
            }
        } catch (e: any) {
            log.warn({ err: e }, '   ⚠️ Could not add physical DB snapshot (logical export still included)');
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
                await captureDump(driver, tmpDump, await dumpConfigForCurrentSite(driver));
                zip.addLocalFile(tmpDump, 'database', entry);
                log.info(`   ✓ Added physical database dump (database/${entry}) to backup.`);
            });
        }
    }

    // 5. Save Zip
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.zip`;
    const filepath = path.join(backupsDir(), filename);

    // Created owner-only and exclusively (adm-zip's writeZip would create it with the process umask).
    fs.writeFileSync(filepath, zip.toBuffer(), { mode: BACKUP_FILE_MODE, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(filepath, BACKUP_FILE_MODE);

    log.info({ filename }, `✅ Backup created: ${filename}`);

    // Enforce retention so scheduled/auto backups don't fill the disk unbounded.
    try { await pruneBackups(); } catch (e: any) { log.warn({ err: e }, '   ⚠️ Backup prune failed'); }

    // Optional S3 offload (config-gated). No-op unless bucket + keys are configured; on failure the local
    // copy is kept and the failure is reported — an unreachable bucket never fails a good local backup.
    // Assigned on both paths below (the try's first statement, or the catch), so no initializer — the
    // value would be dead (eslint no-useless-assignment).
    let s3: any;
    try {
        // A site's archives go under its own key space of the backup bucket.
        s3 = await offloadBackup(filepath, onSecondarySite() ? `sites/${currentSiteId()}/${filename}` : filename);
        if (s3.offloaded) log.info(`   ☁ Offloaded backup to S3: s3://${s3.bucket}/${s3.key}`);
        else if (s3.reason === 'upload-failed') log.warn({ err: s3.error }, '   ⚠️ S3 offload failed (local copy kept)');
    } catch (e: any) {
        // offloadBackup is designed not to throw; guard anyway so offload can never fail the backup.
        s3 = { offloaded: false, reason: 'upload-failed', error: e && e.message };
        log.warn({ err: e }, '   ⚠️ S3 offload error (local copy kept)');
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
        try { fs.unlinkSync(path.join(backupsDir(), b.filename)); pruned++; }
        catch (e: any) { log.warn({ err: e }, `   ⚠️ Could not prune backup ${b.filename}`); }
    }
    if (pruned) log.info({ pruned, n }, `   🧹 Pruned ${pruned} old backup(s); kept newest ${n}.`);
    return { pruned, kept: Math.min(all.length, n) };
}

/**
 * List all backups
 */
function listBackups() {
    const dir = backupsDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
        .filter((f: string) => f.endsWith('.zip'))
        .map((f: string) => {
            const stats = fs.statSync(path.join(dir, f));
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

    const filepath = path.join(backupsDir(), filename);
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

    const filepath = path.join(backupsDir(), filename);
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
/**
 * Multisite: the restored main database may give the network administrators' ids to other accounts, or
 * drop them. Each row follows its own account again (core/network reconcileNetworkAdmins). A failure is
 * the operator's to see; it never undoes the restore.
 */
async function recheckNetworkAdminsAfterRestore(incidents: BackupIncident[]) {
    if (onSecondarySite()) return; // only the main site's accounts can be network administrators
    try { await require('./network-auth').recheckNetworkAdmins(); }
    catch (e: any) { incidents.push({ stage: 'network', message: `The network administrators could not be re-checked against the restored accounts (${e && e.message}).` }); }
}

async function restoreBackup(filename: string) {
    // Security: Prevent Directory Traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename');
    }

    const filepath = path.join(backupsDir(), filename);
    if (!fs.existsSync(filepath)) {
        throw new Error('Backup file not found');
    }

    // The name is the request's (POST /backups/:filename/restore): one inert line in the log.
    log.info({ filename: logSafe(filename) }, `♻️ Restoring backup: ${logSafe(filename)}...`);

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
    // A site other than the main one restores its own uploads and private files, and never code: the
    // plugin and theme trees are the network's.
    const secondary = onSecondarySite();
    const RESTORABLE_ROOTS = secondary ? ['uploads', PRIVATE_UPLOADS_ARCHIVE_ROOT] : ['uploads', 'plugins', 'themes', PRIVATE_UPLOADS_ARCHIVE_ROOT];
    const siteUploadsRoot = secondary ? path.resolve(require('./private-media').publicUploadsRoot()) : null;
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
        // Private media restores into the CONFIGURED private root, not next to the code.
        const isPrivateRoot = top === PRIVATE_UPLOADS_ARCHIVE_ROOT;
        const privateBase = isPrivateRoot ? require('./private-media').privateUploadsRoot() : null;
        // A site's uploads/ restores into the site's own uploads root.
        const siteUploads = !isPrivateRoot && siteUploadsRoot !== null;
        const contentRoot = isPrivateRoot ? privateBase : siteUploads ? siteUploadsRoot : path.resolve(backendRoot, top);
        const dest = isPrivateRoot
            ? (segments.length > 1 ? resolveWithin(privateBase, ...segments.slice(1)) : null)
            : siteUploads
                ? (segments.length > 1 ? resolveWithin(siteUploadsRoot, ...segments.slice(1)) : null)
                : resolveWithin(backendRoot, ...segments);
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
        log.warn(`   ⚠️ ${skipped.length} backup entr${skipped.length === 1 ? 'y' : 'ies'} skipped — the name cannot be represented on this filesystem: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', …' : ''}`);
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
    if (physEntry && secondary) {
        try {
            // Read while the site's database is still open (restoreSiteDatabase closes it first).
            const dbFile = sqliteFileForCurrentSite(dbType.driver);
            await restoreSiteDatabase(async () => {
                for (const sidecar of [dbFile + '-wal', dbFile + '-shm']) {
                    try { if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); } catch { /* best-effort */ }
                }
                // A private directory (mkdtemp: unpredictable name, created 0700 in one call) beside the
                // file, so the snapshot is renamed into place on the same file system.
                const tmpDir = fs.mkdtempSync(path.join(path.dirname(dbFile), '.restore-'));
                try {
                    const tmp = path.join(tmpDir, 'wordjs.db');
                    fs.writeFileSync(tmp, physEntry.getData(), { mode: 0o600, flag: 'wx' });
                    fs.renameSync(tmp, dbFile);
                } finally {
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
                }
            });
            physicalRestored = true;
            log.info('   ✓ Physical database snapshot of the site restored (all tables).');
        } catch (e: any) {
            log.warn({ err: e }, '   ⚠️ Physical DB restore of the site failed — falling back to logical import');
            incidents.push({
                stage: 'database',
                message: `The physical database snapshot could not be restored (${e && e.message}); the logical import ran instead, which does NOT restore analytics, notifications, plugin tables or schema_migrations.`
            });
            await reopenCurrentSite();
            physicalRestored = false;
        }
    } else if (physEntry) {
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
            log.info('   ✓ Physical database snapshot restored (all tables).');
        } catch (e: any) {
            log.warn({ err: e }, '   ⚠️ Physical DB restore failed — falling back to logical import');
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
                const cfg = await dumpConfigForCurrentSite(dbType.driver);
                if (secondary) {
                    // A site's schema / database is replaced whole: dropped, then restored from the dump
                    // into a fresh one, so nothing created after the backup survives it.
                    await restoreSiteDatabase(async () => {
                        await require('../config/database').dropSiteDatabase(currentSiteId());
                        await restoreDump(dbType.driver, tmp, { ...cfg, fresh: true });
                    });
                } else {
                    await restoreDump(dbType.driver, tmp, cfg);
                }
                physicalRestored = true;
                log.info('   ✓ Physical database dump restored (all tables).');
            });
        }
    }

    // 3b. Logical restore (older backups with no physical snapshot, or a failed physical swap).
    //     WIPE first so rows deleted since the backup actually disappear — this previously ran for non-file
    //     drivers ONLY, so a SQLite logical restore was a merge that resurrected deleted content (audit
    //     F-03, defect #1). importSite then repopulates the logical tables.
    if (!physicalRestored) {
        log.info(`🧹 Logical restore: wiping content tables (${dbType.driver}) before import...`);
        await clearDatabase();
        const results = await importSite(data, {
            updateExisting: true, // Overwrite existing content
            importUsers: true
        });
        await recheckNetworkAdminsAfterRestore(incidents);
        // The DB just time-traveled: every cached value (L1 included) describes the PRE-restore
        // state and would be served for up to its TTL. Drop it all.
        try { await require('./cache').flush(); }
        catch (e: any) { incidents.push({ stage: 'cache', message: `The cache could not be flushed (${e && e.message}); pre-restore values may be served until their TTL expires.` }); }
        log.info(`✅ Restore ${incidents.length ? 'finished with warnings' : 'complete'} (logical import)`);
        return withIncidents(results, incidents);
    }

    await recheckNetworkAdminsAfterRestore(incidents);
    try { await require('./cache').flush(); }
    catch (e: any) { incidents.push({ stage: 'cache', message: `The cache could not be flushed (${e && e.message}); pre-restore values may be served until their TTL expires.` }); }
    log.info(`✅ Restore ${incidents.length ? 'finished with warnings' : 'complete'} (physical snapshot)`);
    return withIncidents({ physical: true, driver: dbType.driver }, incidents);
}

/**
 * Replace the current site's (not the main site's) database with `swap`: its workers stop and its
 * connection closes first, and afterwards the site is prepared again from the restored database (schema
 * migrations, roles, its plugins with fresh database principals, its theme).
 */
async function restoreSiteDatabase(swap: () => Promise<void>): Promise<void> {
    const id = currentSiteId();
    await require('./network-sites').forgetSite(id);
    require('./plugin-db-isolation').forgetSiteProvisioning(id);
    try {
        await swap();
    } finally {
        await reopenCurrentSite();
    }
}

async function reopenCurrentSite(): Promise<void> {
    const id = currentSiteId();
    if (id === 1) return;
    try { await require('./network-sites').prepareSite(id); }
    catch (e: any) { log.warn({ err: e }, '   ⚠️ The site could not be prepared again after the restore'); throw e; }
}

module.exports = {
    hardenBackupPermissions,
    BACKUP_FILE_MODE,
    createBackup,
    listBackups,
    deleteBackup,
    getBackupPath,
    restoreBackup,
    pruneBackups
};
