/**
 * WordJS — Move the existing media library into the bucket (offload) and back (restore).
 *
 * Both directions walk the PUBLIC attachments in id order, a batch at a time, and are:
 *
 *   - IDEMPOTENT per item. The per-attachment marker (`_wjs_media_storage` = 's3', core/media-storage)
 *     says where an item's files are. Offload skips a marked item (and an object already in the bucket
 *     with the same size is not uploaded again); restore skips an unmarked one (and a file already on
 *     disk with the object's size is not downloaded again). Running either twice is a no-op the second
 *     time.
 *   - RESUMABLE. The progress — direction, the last id finished, counters, the failures — is the
 *     `media_storage_migration` option, written after every item. A run that stops (crash, restart,
 *     Ctrl-C) continues from that cursor on the next start of the SAME direction; `restart: true`
 *     starts over (still idempotent, it only re-checks).
 *   - EXCLUSIVE. One run at a time across the cluster (core/dist-lock on Postgres/MySQL) and in this
 *     process (a module flag — single-host SQLite has no lock table).
 *
 * The database is never rewritten: rows keep their relative `/uploads/...` paths in both directions. The
 * only per-row write is the marker. When a full offload finishes with no failures the site-wide state
 * (`media_storage_state`) becomes 'offloaded', which is what lets the public SSR emit CDN URLs; a restore
 * sets it back to 'local' FIRST, before a single file moves, so no page is rendered against a bucket the
 * restore is draining. Objects are never deleted from the bucket by a restore, and local files are
 * deleted by an offload only when asked (`deleteLocal`) and only after the object verified by size.
 */

const fs = require('fs');

export type MigrationDirection = 'offload' | 'restore';
export type MigrationState = 'local' | 'migrating' | 'offloaded' | 'restoring';

export type MigrationProgress = {
    direction: MigrationDirection;
    status: 'running' | 'done' | 'failed' | 'interrupted';
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    cursor: number;
    total: number;
    processed: number;
    moved: number;
    skipped: number;
    failed: number;
    failures: Array<{ id: number; error: string }>;
    deleteLocal: boolean;
    error: string | null;
};

const STATE_OPTION = 'media_storage_state';
const PROGRESS_OPTION = 'media_storage_migration';
const LOCK_NAME = 'media-storage-migration';
const MAX_FAILURES_KEPT = 50;
const BATCH = 50;
/**
 * A run refreshes its progress record at least this often (and after every item), so every node can
 * tell a run that is alive on ANOTHER node from one that died: a 'running' record older than
 * PROGRESS_STALE_MS has nobody behind it. (The dist lock answers the same question on Postgres/MySQL,
 * but only to the node that holds it; the record is what the others can read.)
 */
const PROGRESS_HEARTBEAT_MS = 30_000;
const PROGRESS_STALE_MS = 120_000;

let running = false;

/** Is this 'running' record backed by a live run — here, or on a node that refreshed it recently? */
function isLiveRecord(v: any, now = Date.now()): boolean {
    if (!v || typeof v !== 'object' || v.status !== 'running') return false;
    if (running) return true;
    const at = Date.parse(String(v.updatedAt || ''));
    return Number.isFinite(at) && now - at < PROGRESS_STALE_MS;
}

function deps() {
    return {
        database: require('../config/database'),
        options: require('./options'),
        Post: require('../models/Post'),
        Media: require('../models/Media'),
        privateMedia: require('./private-media'),
        storage: require('./media-storage'),
        distLock: require('./dist-lock'),
    };
}

async function getState(): Promise<MigrationState> {
    const v = await deps().options.getOptionFresh(STATE_OPTION, 'local');
    return (['local', 'migrating', 'offloaded', 'restoring'] as const).includes(v) ? v : 'local';
}

async function getProgress(): Promise<MigrationProgress | null> {
    const v = await deps().options.getOptionFresh(PROGRESS_OPTION, null);
    if (!v || typeof v !== 'object') return null;
    // A 'running' record that no run here backs and that no other node has refreshed lately is a run
    // that died.
    return v.status === 'running' && !isLiveRecord(v) ? { ...v, status: 'interrupted' } : v;
}

/** Is a migration running in THIS process? */
function isRunning(): boolean { return running; }

/** Is a migration running anywhere in the cluster (this process, or a node whose record is fresh)? */
async function isRunningAnywhere(): Promise<boolean> {
    if (running) return true;
    return isLiveRecord(await deps().options.getOptionFresh(PROGRESS_OPTION, null));
}

/** How many attachments carry the bucket marker (their files are in the s3 store). */
async function countOffloaded(): Promise<number> {
    const { database, storage } = deps();
    const row = await database.dbAsync.get(`SELECT COUNT(*) AS n FROM post_meta WHERE meta_key = ? AND meta_value = ?`, [storage.STORAGE_META_KEY, 's3']);
    return Number(row?.n || 0);
}

/**
 * Is any media still served from the bucket, anywhere the storage block serves? The block is
 * network-wide (multisite): every site's uploads follow it, while the state, the progress record and the
 * bucket markers live in each site's own database. So the answer covers this site AND every other site
 * of the network — suspended ones too, since their media comes back when they resume. A site whose
 * database cannot be read counts as in use: switching storage away from media that may still be there
 * is what this check exists to prevent.
 */
async function bucketUsage(): Promise<{ state: MigrationState; inBucket: number; inUse: boolean; sites: number[] }> {
    const state = await getState();
    let inBucket = await countOffloaded();
    let busy = state !== 'local' || inBucket > 0 || await isRunningAnywhere();
    const sites: number[] = [];
    const siteContext = require('./site-context');
    if (siteContext.multisiteEnabled()) {
        const network = require('./network');
        const { openSiteDatabase } = deps().database;
        for (const site of network.listSites()) {
            if (site.id === siteContext.PRIMARY_SITE_ID) continue;
            try {
                await siteContext.runWithSite(site.id, async () => {
                    await openSiteDatabase(site.id, site.dbPath || network.siteDbPath(site.id));
                    const n = await countOffloaded();
                    const s = await getState();
                    const live = isLiveRecord(await deps().options.getOptionFresh(PROGRESS_OPTION, null));
                    if (n > 0 || s !== 'local' || live) { inBucket += n; sites.push(site.id); }
                });
            } catch {
                sites.push(site.id);
            }
        }
        if (sites.length) busy = true;
    }
    return { state, inBucket, inUse: busy, sites };
}

/** The files one attachment owns, absolute under the public root (same resolver delete/visibility use). */
function attachmentFiles(meta: any, root: string): string[] {
    const { Media } = deps();
    const md = meta['_wp_attachment_metadata'] || {};
    const file = meta['_wp_attached_file'] || md.file || '';
    return Media._deletableFiles(file, md.sizes, md.sources, root);
}

/**
 * Move ONE attachment. Returns 'moved' | 'skipped'; throws with a short reason on failure (the caller
 * records it and carries on with the next item).
 */
async function migrateOne(id: number, direction: MigrationDirection, adapter: any, opts: { deleteLocal: boolean }): Promise<'moved' | 'skipped'> {
    const { Post, privateMedia, storage } = deps();
    const meta = await Post.getAllMeta(id);
    if (typeof meta['_wxr_remote_url'] === 'string' && /^https?:\/\//i.test(meta['_wxr_remote_url'])) return 'skipped';
    const root = privateMedia.publicUploadsRoot();
    const files = attachmentFiles(meta, root);
    if (!files.length) return 'skipped';
    const marked = meta[storage.STORAGE_META_KEY] === 's3';

    if (direction === 'offload') {
        if (marked) {
            if (opts.deleteLocal) {
                const present = files.filter((f) => fs.existsSync(f));
                if (present.length) {
                    await storage.pushFiles(adapter, root, present); // verifies before anything is deleted
                    for (const f of present) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
                    return 'moved';
                }
            }
            return 'skipped';
        }
        const present = files.filter((f) => fs.existsSync(f));
        if (!fs.existsSync(files[0])) throw new Error('the original file is missing on this node');
        await storage.pushFiles(adapter, root, present);
        await Post.updateMeta(id, storage.STORAGE_META_KEY, 's3');
        await Post._invalidatePostCacheById(id);
        if (opts.deleteLocal) for (const f of present) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
        return 'moved';
    }

    // restore
    if (!marked) return 'skipped';
    // Only the files the bucket actually holds are pulled; a derivative that was never written is not
    // an error, the original is.
    const pulled = [];
    for (const f of files) {
        const rel = storage.relativeTo(root, f);
        if (!rel || !storage.isOffloadablePath(rel)) continue;
        if (f === files[0] || (await adapter.head(rel)) !== null || fs.existsSync(f)) pulled.push(f);
    }
    await storage.pullFiles(adapter, root, pulled);
    await Post.deleteMeta(id, storage.STORAGE_META_KEY);
    await Post._invalidatePostCacheById(id);
    return 'moved';
}

async function saveProgress(p: MigrationProgress): Promise<void> {
    p.updatedAt = new Date().toISOString();
    await deps().options.updateOption(PROGRESS_OPTION, p, 'no');
}

/**
 * Run (or resume) a migration. Resolves with the final progress record. Rejects only when it cannot
 * START (not configured, already running); per-item failures are recorded and counted, never thrown.
 *
 * @param opts.limit process at most this many items in this call (the rest stays for a resume).
 * @param opts.onProgress called after each item with the current record (CLI output).
 * @param opts.adapter injected storage adapter (tests); defaults to the configured s3 adapter.
 */
async function runMigration(direction: MigrationDirection, opts: {
    deleteLocal?: boolean; restart?: boolean; limit?: number; dryRun?: boolean;
    onProgress?: (p: MigrationProgress) => void; adapter?: any; store?: any;
} = {}): Promise<MigrationProgress> {
    if (direction !== 'offload' && direction !== 'restore') throw new Error('direction must be offload or restore');
    const { storage, distLock, options, database } = deps();
    const store = opts.store || storage.resolveMediaStorage();
    if (!opts.adapter && store.driver !== 's3') {
        const why = store.incomplete ? ` (missing or invalid: ${store.incomplete.join(', ')})` : '';
        const err: any = new Error(`S3 media storage is not configured${why}.`);
        err.code = 'media_storage_not_configured';
        throw err;
    }
    if (running) {
        const err: any = new Error('A media storage migration is already running.');
        err.code = 'media_storage_busy';
        throw err;
    }
    running = true;
    try {
        const result = await distLock.runAsLeader(LOCK_NAME, { ttlMs: 120000 }, async () => {
            const adapter = opts.adapter || storage.getMediaStorage(store);
            const { dbAsync } = database;
            const previous = await options.getOptionFresh(PROGRESS_OPTION, null);
            // Only a run that stopped mid-walk ('running' on disk: a crash, a restart, a `limit`) resumes.
            // A finished run — clean or with failures — starts a fresh, idempotent walk.
            const resume = !opts.restart && previous && previous.direction === direction && previous.status === 'running';
            const totalRow = await dbAsync.get(`SELECT COUNT(*) AS n FROM posts WHERE post_type = 'attachment' AND post_status = 'inherit'`);
            const now = new Date().toISOString();
            const p: MigrationProgress = resume
                ? { ...previous, status: 'running', total: Number(totalRow?.n || 0), error: null, finishedAt: null, deleteLocal: !!opts.deleteLocal }
                : {
                    direction, status: 'running', startedAt: now, updatedAt: now, finishedAt: null,
                    cursor: 0, total: Number(totalRow?.n || 0), processed: 0, moved: 0, skipped: 0, failed: 0,
                    failures: [], deleteLocal: !!opts.deleteLocal, error: null,
                };
            if (opts.dryRun) return { ...p, status: 'done' as const };

            // A restore flips delivery back to local BEFORE moving anything (see the header).
            await options.updateOption(STATE_OPTION, direction === 'offload' ? 'migrating' : 'restoring');
            await saveProgress(p);

            let budget = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
            // Keep the record fresh while one slow item (a large video) is in flight.
            const heartbeat = setInterval(() => { saveProgress(p).catch(() => { /* next item saves it */ }); }, PROGRESS_HEARTBEAT_MS);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
            try {
                while (budget > 0) {
                    const rows = await dbAsync.all(
                        `SELECT id FROM posts WHERE post_type = 'attachment' AND post_status = 'inherit' AND id > ? ORDER BY id ASC LIMIT ?`,
                        [p.cursor, Math.min(BATCH, budget === Infinity ? BATCH : budget)]
                    );
                    if (!rows.length) break;
                    for (const row of rows) {
                        const id = Number(row.id);
                        try {
                            const outcome = await migrateOne(id, direction, adapter, { deleteLocal: !!opts.deleteLocal });
                            if (outcome === 'moved') p.moved++; else p.skipped++;
                            // A retried item that succeeds this time drops out of the failure list.
                            p.failures = p.failures.filter((f) => f.id !== id);
                        } catch (e: any) {
                            p.failures = p.failures.filter((f) => f.id !== id);
                            if (p.failures.length < MAX_FAILURES_KEPT) p.failures.push({ id, error: String(e?.message || e).slice(0, 300) });
                        }
                        p.failed = p.failures.length;
                        p.processed++;
                        p.cursor = id;
                        budget--;
                        await saveProgress(p);
                        if (opts.onProgress) opts.onProgress(p);
                        if (budget <= 0) break;
                    }
                }
            } catch (e: any) {
                p.status = 'failed';
                p.error = String(e?.message || e).slice(0, 300);
                await saveProgress(p);
                return p;
            } finally {
                clearInterval(heartbeat);
            }

            const finished = budget > 0; // the walk reached the end (not stopped by `limit`)
            if (finished && p.failed === 0) {
                p.status = 'done';
                p.finishedAt = new Date().toISOString();
                await options.updateOption(STATE_OPTION, direction === 'offload' ? 'offloaded' : 'local');
            } else if (finished) {
                // Failed items stay behind: a fresh run of the same direction re-checks everything (it
                // is idempotent) and only those still need work.
                p.status = 'failed';
                p.finishedAt = new Date().toISOString();
                p.cursor = 0;
                p.error = `${p.failed} item(s) could not be moved`;
            }
            await saveProgress(p);
            return p;
        });
        if (!result) {
            const err: any = new Error('Another node is running a media storage migration.');
            err.code = 'media_storage_busy';
            throw err;
        }
        return result;
    } finally {
        running = false;
    }
}

module.exports = { runMigration, getState, getProgress, isRunning, isRunningAnywhere, isLiveRecord, PROGRESS_STALE_MS, countOffloaded, bucketUsage, migrateOne, STATE_OPTION, PROGRESS_OPTION };
