/**
 * WordJS — the network store: which sites exist, which addresses each one answers, and who may
 * administer the network (multisite).
 *
 * It is deliberately separate from every site's database: a site's export, backup or wipe never carries
 * the network's records, and no site-scoped code path (a model, a plugin bridge) can reach it through
 * `dbAsync`. Where it lives follows the engine (core/site-storage):
 *
 *   sqlite-native   a SQLite file of its own, `network.db`, next to the main database (one host)
 *   postgres        the schema `wordjs_network` of the configured database
 *   mysql/mariadb   the database `<db.name>_network` of the configured server
 *
 * On Postgres and MySQL the store is on the server every backend node shares, which is what lets a
 * network run on several nodes (documentation/multi-node.md): each node keeps an in-memory MIRROR of the
 * store's small tables, so the request path reads it synchronously as before, and reloads it when a
 * node announces a change (`wordjs:network-changed` on the Redis bus) and every NETWORK_RESYNC_MS in case
 * that announcement was lost. A write goes to the shared store first (in one transaction), then reloads
 * this node's mirror and announces itself, so the writing node always reads its own write.
 *
 * Site 1 is the install that existed before multisite was enabled. Its database, uploads and addresses
 * stay exactly where they were: its main address is still `siteUrl` in wordjs-config.json (written only
 * by core/site-address.ts), so its row here is a record, not the master. Every other site's address
 * lives only here and is written only by this module.
 *
 * This module is the single writer of the network store. Every write is async (it may cross the
 * network); every read is synchronous. `policySites()` keeps one array identity per snapshot so the host
 * policy (built from it) is rebuilt only when the registry really changed.
 */
const path = require('path');
const fs = require('fs');
const config = require('../config/app');
const hostPolicy = require('./host-policy');
const siteStorage = require('./site-storage');
import { PRIMARY_SITE_ID, isSiteId, currentSiteId, runWithSite } from './site-context';

export type SiteStatus = 'active' | 'suspended';

export type SiteRecord = {
    id: number;
    slug: string;
    mainUrl: string;
    mainHost: string;
    status: SiteStatus;
    dbPath: string | null;
    createdAt: string;
    updatedAt: string;
};

export type PolicySite = { id: number; url: string; status: SiteStatus };

type Row = Record<string, any>;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** The bus channel a node announces a network change on (core/cache publishes it to every node). */
const CHANNEL = 'wordjs:network-changed';
/** How stale a node's mirror of the shared store may get when an announcement is lost. */
const NETWORK_RESYNC_MS = 15_000;
/** network_meta: the highest site id ever handed out. Ids are never reused (core/site-storage). */
const LAST_SITE_ID_KEY = 'last_site_id';

let db: any = null;
// slug -> granted-token ceiling (see pluginCeiling). Rebuilt from the store on first read after a write.
let ceilings: Map<string, string[]> | null = null;
let snapshot: { sites: SiteRecord[]; byId: Map<number, SiteRecord>; byHost: Map<string, number>; policy: PolicySite[] } | null = null;

// ── The SQL store (Postgres / MySQL) ─────────────────────────────────────────────────────────────────
type Mirror = {
    sites: Row[];
    hosts: Row[];
    admins: Row[];
    ceilings: Row[];
    quotas: Row[];
    meta: Map<string, string>;
};
let sqlDriver: any = null;
let sqlOpening: Promise<any> | null = null;
let mirror: Mirror | null = null;
let resyncTimer: any = null;
let watching = false;
const changeListeners = new Set<(change: { before: SiteRecord[]; after: SiteRecord[] }) => void>();

/** Is the store on the shared SQL server (Postgres/MySQL) rather than a SQLite file? */
function isSqlStore(): boolean {
    return siteStorage.storageEngine() !== 'sqlite';
}

function codedError(code: string, message: string): Error & { code: string } {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
}

/** Where the network store lives: next to the main database (SQLite). */
function networkDbPath(): string {
    const override = (config as any).multisite && (config as any).multisite.networkDbPath;
    if (typeof override === 'string' && override) return path.resolve(override);
    return path.join(path.dirname(path.resolve(config.dbPath || './data/wordjs-native.db')), 'network.db');
}

/** A human description of where the store is (the CLI's status). */
function describeStore(): string {
    const engine = siteStorage.storageEngine();
    if (engine === 'postgres') return `postgres schema ${siteStorage.NETWORK_PG_SCHEMA}`;
    if (engine === 'mysql') return `mysql database ${siteStorage.networkMysqlDatabase()}`;
    return networkDbPath();
}

/** The directory that holds the files of the sites other than site 1. */
function sitesDataDir(): string {
    return path.join(path.dirname(path.resolve(config.dbPath || './data/wordjs-native.db')), 'sites');
}

/**
 * Everything a site other than site 1 owns on disk lives in ONE directory: its database (SQLite) and its
 * public and private uploads. Outside the main site's served `/uploads` tree on purpose — the main site's
 * address can never serve another site's files — and self-contained, so a site can be backed up, moved
 * or removed as one folder. Site 1 keeps config.dbPath and config.uploads, as it always did.
 */
function siteDataDir(id: number): string {
    return path.join(sitesDataDir(), String(id));
}

/** The database file of site `id` (> 1) on SQLite. Site 1's is config.dbPath, as it always was. */
function siteDbPath(id: number): string {
    return path.join(siteDataDir(id), 'wordjs-native.db');
}

/**
 * The main address (origin, no trailing slash) of the site the current work belongs to: `config.site.url`
 * for site 1 (as every link always used), the registry's main address for any other site. Never the
 * request's host.
 */
function currentSiteUrl(): string {
    const id = currentSiteId();
    if (id === PRIMARY_SITE_ID) return (config as any).site.url;
    const site = getSite(id);
    if (!site) throw codedError('network_site_not_found', `No such site: ${id}`);
    return site.mainUrl;
}

// ── Schema ───────────────────────────────────────────────────────────────────────────────────────────
// One definition for both stores, in the SQLite dialect every WordJS driver translates (VARCHAR keys so
// MySQL can index them; TEXT columns carry no default because MySQL refuses one).
const TABLES = [
    `CREATE TABLE IF NOT EXISTS network_meta (
        meta_key VARCHAR(191) PRIMARY KEY,
        meta_value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS network_sites (
        id INTEGER PRIMARY KEY,
        slug VARCHAR(64) NOT NULL UNIQUE,
        main_url VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        db_path TEXT,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS network_site_hosts (
        host VARCHAR(255) PRIMARY KEY,
        site_id INTEGER NOT NULL,
        kind VARCHAR(16) NOT NULL DEFAULT 'main'
    )`,
    `CREATE TABLE IF NOT EXISTS network_admins (
        user_id INTEGER PRIMARY KEY,
        created_at VARCHAR(40) NOT NULL,
        user_login VARCHAR(255)
    )`,
    `CREATE TABLE IF NOT EXISTS network_plugin_ceilings (
        slug VARCHAR(64) PRIMARY KEY,
        tokens TEXT NOT NULL,
        updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS network_site_quotas (
        site_id INTEGER PRIMARY KEY,
        upload_bytes BIGINT,
        updated_at VARCHAR(40) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS network_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at VARCHAR(40) NOT NULL,
        actor_user_id INTEGER,
        action VARCHAR(64) NOT NULL,
        site_id INTEGER,
        detail TEXT NOT NULL
    )`,
    // ACME http-01 answers, shared by every node (core/cert-manager): the CA may ask any of them.
    `CREATE TABLE IF NOT EXISTS network_acme_challenges (
        token VARCHAR(191) PRIMARY KEY,
        key_authorization TEXT NOT NULL,
        expires_at BIGINT NOT NULL
    )`,
    // The network administrator's "open as administrator" handoffs (core/network-handoff): one row per
    // token issued, deleted when it is redeemed, so a token works once, on whichever node receives it.
    `CREATE TABLE IF NOT EXISTS network_handoffs (
        jti VARCHAR(64) PRIMARY KEY,
        site_id INTEGER NOT NULL,
        admin_user_id INTEGER NOT NULL,
        expires_at BIGINT NOT NULL
    )`,
    // One certificate per site address (core/site-certs), readable by every node.
    `CREATE TABLE IF NOT EXISTS network_site_certs (
        host VARCHAR(255) PRIMARY KEY,
        site_id INTEGER NOT NULL,
        cert_pem TEXT NOT NULL,
        key_pem TEXT NOT NULL,
        not_after VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
    )`,
];

function openStore(): any {
    if (isSqlStore()) throw codedError('network_store_sql', 'The network store is on the database server on this engine.');
    if (db) return db;
    const Database = require('better-sqlite3');
    const file = networkDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = new Database(file);
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    for (const ddl of TABLES) handle.exec(ddl);
    // Each network administrator row names the account's login as well as its id (added after the first
    // release of the table: older rows have none until reconcileNetworkAdmins fills it in). A database
    // restored from a backup can give an id to a different account; the login says whose row it is.
    if (!handle.prepare('PRAGMA table_info(network_admins)').all().some((c: any) => c.name === 'user_login')) {
        handle.exec('ALTER TABLE network_admins ADD COLUMN user_login TEXT');
    }
    db = handle;
    snapshot = null;
    ceilings = null;
    return db;
}

/** The connected SQL store, creating its schema on first use. */
async function sqlStore(): Promise<any> {
    if (sqlDriver) return sqlDriver;
    if (!sqlOpening) {
        sqlOpening = (async () => {
            const d = await require('../config/database').openNetworkDatabase();
            try {
                for (const ddl of TABLES) await d.exec(ddl);
            } catch (e) {
                try { await d.close(); } catch { /* best-effort */ }
                throw e;
            }
            sqlDriver = d;
            return d;
        })();
        sqlOpening.catch(() => { sqlOpening = null; });
    }
    return sqlOpening;
}

/** Re-read the SQL store's small tables into this node's mirror, and tell the listeners what changed. */
async function reloadMirror(): Promise<void> {
    const d = await sqlStore();
    const [sites, hosts, admins, ceil, quotas, meta] = await Promise.all([
        d.all('SELECT * FROM network_sites ORDER BY id'),
        d.all('SELECT host, site_id, kind FROM network_site_hosts'),
        d.all('SELECT user_id, created_at, user_login FROM network_admins ORDER BY user_id'),
        d.all('SELECT slug, tokens FROM network_plugin_ceilings'),
        d.all('SELECT site_id, upload_bytes FROM network_site_quotas'),
        d.all('SELECT meta_key, meta_value FROM network_meta'),
    ]);
    const before = mirror ? listSitesUnchecked() : [];
    mirror = { sites, hosts, admins, ceilings: ceil, quotas, meta: new Map(meta.map((r: Row) => [String(r.meta_key), String(r.meta_value)])) };
    snapshot = null;
    ceilings = null;
    const after = listSitesUnchecked();
    const changed = before.length !== after.length || before.some((s, i) => {
        const a = after[i];
        return !a || a.id !== s.id || a.status !== s.status || a.mainUrl !== s.mainUrl || a.updatedAt !== s.updatedAt;
    });
    if (changed && before.length) {
        for (const fn of changeListeners) {
            try { fn({ before, after }); } catch { /* a listener never breaks the reload */ }
        }
    }
}

function mirrorOrThrow(): Mirror {
    if (!mirror) throw codedError('network_store_unavailable', 'The network store has not been loaded yet.');
    return mirror;
}

/**
 * Load the store (SQL engines: connect and fill the mirror; SQLite: open the file). With `watch`, also
 * follow the other nodes' changes: the bus announcement, and a re-read every NETWORK_RESYNC_MS. The
 * backend's boot calls it with `watch`; the CLI without.
 */
async function ready(opts: { watch?: boolean } = {}): Promise<void> {
    if (!isSqlStore()) { openStore(); return; }
    await reloadMirror();
    if (opts.watch && !watching) {
        watching = true;
        const cache = require('./cache');
        cache.subscribe(CHANNEL, () => { reloadMirror().catch(() => { /* the periodic re-read retries */ }); });
        if (typeof cache.onBusReady === 'function') cache.onBusReady(() => { reloadMirror().catch(() => { /* the periodic re-read retries */ }); });
        resyncTimer = setInterval(() => { reloadMirror().catch(() => { /* next tick */ }); }, NETWORK_RESYNC_MS);
        if (resyncTimer.unref) resyncTimer.unref();
    }
}

/** Is the store open in this process (a read would not throw for want of it)? */
function isLoaded(): boolean {
    return isSqlStore() ? mirror !== null : db !== null || fs.existsSync(networkDbPath());
}

/** Run `fn` whenever another node (or this one) changes the registry: sites added, removed, suspended. */
function onRegistryChange(fn: (change: { before: SiteRecord[]; after: SiteRecord[] }) => void): () => void {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
}

/** Close the store (tests, shutdown). The next read reopens it (SQLite) or needs ready() again (SQL). */
function closeNetworkStore(): void {
    if (db) {
        try { db.close(); } catch { /* already closed */ }
    }
    db = null;
    snapshot = null;
    ceilings = null;
    if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; }
    const d = sqlDriver;
    sqlDriver = null;
    sqlOpening = null;
    mirror = null;
    if (d) Promise.resolve(d.close()).catch(() => { /* best-effort */ });
}

/** After a write to the SQL store: re-read it here, and tell every other node. */
async function afterSqlWrite(): Promise<void> {
    await reloadMirror();
    try {
        await runWithSite(PRIMARY_SITE_ID, () => require('./cache').publish(CHANNEL, String(Date.now())));
    } catch { /* the other nodes re-read within NETWORK_RESYNC_MS */ }
}

/** A row of the SQL store already exists (a concurrent node wrote it first). */
function isDuplicateKey(e: any): boolean {
    const code = e && (e.code || e.errno);
    return code === '23505' || code === 'ER_DUP_ENTRY' || code === 1062 || /duplicate|unique/i.test(String(e && e.message));
}

/** UPDATE the row with `key`, or INSERT it when there is none (portable across Postgres and MySQL). */
async function sqlUpsert(q: any, table: string, key: Row, values: Row): Promise<void> {
    const keyCols = Object.keys(key);
    const valCols = Object.keys(values);
    const where = keyCols.map((k) => `${k} = ?`).join(' AND ');
    const update = async () => q.run(`UPDATE ${table} SET ${valCols.map((c) => `${c} = ?`).join(', ')} WHERE ${where}`,
        [...valCols.map((c) => values[c]), ...keyCols.map((k) => key[k])]);
    const existing = await q.get(`SELECT 1 AS x FROM ${table} WHERE ${where}`, keyCols.map((k) => key[k]));
    if (existing) { await update(); return; }
    const cols = [...keyCols, ...valCols];
    try {
        await q.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => (c in key ? key[c] : values[c])));
    } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        await update();
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────

function rowToSite(r: any): SiteRecord {
    const parsed = hostPolicy.parseSiteUrl(r.main_url);
    return Object.freeze({
        id: Number(r.id),
        slug: String(r.slug),
        mainUrl: String(r.main_url),
        mainHost: parsed ? parsed.hostname : '',
        status: r.status === 'suspended' ? 'suspended' : 'active',
        dbPath: r.db_path ? String(r.db_path) : null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
    });
}

function siteRows(): Row[] {
    if (isSqlStore()) return mirrorOrThrow().sites;
    return openStore().prepare('SELECT * FROM network_sites ORDER BY id').all();
}

function hostRows(): Row[] {
    if (isSqlStore()) return mirrorOrThrow().hosts;
    return openStore().prepare('SELECT host, site_id FROM network_site_hosts').all();
}

function load() {
    if (snapshot) return snapshot;
    const rows = siteRows();
    const sites: SiteRecord[] = rows.map(rowToSite);
    const byId = new Map<number, SiteRecord>(sites.map((s) => [s.id, s]));
    const byHost = new Map<string, number>();
    for (const h of hostRows()) {
        const id = Number(h.site_id);
        if (id !== PRIMARY_SITE_ID && byId.has(id)) byHost.set(String(h.host), id);
    }
    const policy: PolicySite[] = Object.freeze(sites
        .filter((s) => s.id !== PRIMARY_SITE_ID)
        .map((s) => Object.freeze({ id: s.id, url: s.mainUrl, status: s.status }))) as PolicySite[];
    snapshot = { sites, byId, byHost, policy };
    return snapshot;
}

function invalidate(): void {
    snapshot = null;
}

function now(): string {
    return new Date().toISOString();
}

/** Every site, site 1 first. */
function listSites(): SiteRecord[] {
    return load().sites.slice();
}

/** listSites() of a mirror being replaced (no throw before the first load). */
function listSitesUnchecked(): SiteRecord[] {
    try { return load().sites.slice(); } catch { return []; }
}

function getSite(id: number): SiteRecord | null {
    return isSiteId(id) ? load().byId.get(id) || null : null;
}

/** The site (other than site 1) whose address is `hostname`, or null. Site 1's addresses are the host policy's. */
function siteIdForHostname(hostname: string): number | null {
    return load().byHost.get(String(hostname)) ?? null;
}

/**
 * The sites other than site 1, in the shape the host policy reads (`config.networkSites`). The same
 * array is returned until the registry changes, so a policy memoized on it is rebuilt only then.
 */
function policySites(): PolicySite[] {
    return load().policy;
}

function metaValue(key: string): string | null {
    if (isSqlStore()) {
        const v = mirrorOrThrow().meta.get(key);
        return v === undefined ? null : v;
    }
    const row = openStore().prepare('SELECT meta_value FROM network_meta WHERE meta_key = ?').get(key);
    return row ? String(row.meta_value) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────

async function audit(action: string, opts: { actor?: number | null; siteId?: number | null; detail?: unknown } = {}): Promise<void> {
    const detail = opts.detail === undefined ? '' : JSON.stringify(opts.detail).slice(0, 4000);
    const params = [now(), opts.actor ?? null, action, opts.siteId ?? null, detail];
    const sql = 'INSERT INTO network_audit_log (at, actor_user_id, action, site_id, detail) VALUES (?, ?, ?, ?, ?)';
    if (!isSqlStore()) { openStore().prepare(sql).run(...params); return; }
    await (await sqlStore()).run(sql, params);
}

async function auditLog(limit = 100): Promise<any[]> {
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const sql = `SELECT id, at, actor_user_id AS "actorUserId", action, site_id AS "siteId", detail FROM network_audit_log ORDER BY id DESC LIMIT ${n}`;
    if (!isSqlStore()) return openStore().prepare(sql.replace(/"/g, '')).all();
    const rows = await (await sqlStore()).all(siteStorage.storageEngine() === 'mysql' ? sql.replace(/"/g, '`') : sql);
    return rows.map((r: Row) => ({ id: Number(r.id), at: String(r.at), actorUserId: r.actorUserId === null || r.actorUserId === undefined ? null : Number(r.actorUserId), action: String(r.action), siteId: r.siteId === null || r.siteId === undefined ? null : Number(r.siteId), detail: String(r.detail ?? '') }));
}

/**
 * Record site 1 (the existing install). Idempotent: enabling twice, or booting a network whose store
 * already has site 1, changes nothing but the recorded address.
 */
async function registerPrimarySite(mainUrl: string): Promise<SiteRecord> {
    const t = now();
    if (!isSqlStore()) {
        const store = openStore();
        const existing = store.prepare('SELECT id FROM network_sites WHERE id = ?').get(PRIMARY_SITE_ID);
        if (existing) {
            store.prepare('UPDATE network_sites SET main_url = ?, updated_at = ? WHERE id = ?').run(mainUrl, t, PRIMARY_SITE_ID);
        } else {
            store.prepare('INSERT INTO network_sites (id, slug, main_url, status, db_path, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
                .run(PRIMARY_SITE_ID, 'main', mainUrl, 'active', t, t);
        }
        invalidate();
        return getSite(PRIMARY_SITE_ID) as SiteRecord;
    }
    const d = await sqlStore();
    const existing = await d.get('SELECT main_url FROM network_sites WHERE id = ?', [PRIMARY_SITE_ID]);
    if (existing && existing.main_url === mainUrl) {
        if (!mirror) await reloadMirror();
        return getSite(PRIMARY_SITE_ID) as SiteRecord;
    }
    await sqlUpsert(d, 'network_sites', { id: PRIMARY_SITE_ID }, existing
        ? { main_url: mainUrl, updated_at: t }
        : { slug: 'main', main_url: mainUrl, status: 'active', db_path: null, created_at: t, updated_at: t });
    await afterSqlWrite();
    return getSite(PRIMARY_SITE_ID) as SiteRecord;
}

/** Normalize a site address to `scheme://host[:port]`, or null when it is not one. */
function normalizeSiteUrl(raw: unknown): { url: string; hostname: string } | null {
    const site = hostPolicy.parseSiteUrl(raw);
    if (!site) return null;
    return { url: site.origin, hostname: site.hostname };
}

/**
 * Insert the record of a new site: the caller (core/network-sites) provisions its database and first
 * administrator, and removes the record again if that fails. Throws a coded error when the slug or the
 * address is taken. Ids are never reused: the next id is above every id ever handed out.
 */
async function insertSite(input: { slug: string; url: string; hostname: string }): Promise<SiteRecord> {
    if (!SLUG_RE.test(input.slug)) throw codedError('network_invalid_slug', 'The site slug must be 1-40 lower-case letters, digits or dashes.');
    const t = now();
    if (!isSqlStore()) {
        const store = openStore();
        const tx = store.transaction(() => {
            if (store.prepare('SELECT 1 FROM network_sites WHERE slug = ?').get(input.slug)) {
                throw codedError('network_slug_taken', 'Another site already uses this slug.');
            }
            if (store.prepare('SELECT 1 FROM network_site_hosts WHERE host = ?').get(input.hostname)) {
                throw codedError('network_host_taken', 'Another site already answers on this address.');
            }
            const row = store.prepare('SELECT COALESCE(MAX(id), 1) AS m FROM network_sites').get();
            const mark = store.prepare('SELECT meta_value FROM network_meta WHERE meta_key = ?').get(LAST_SITE_ID_KEY);
            const id = Math.max(PRIMARY_SITE_ID, Number(row.m), Number(mark && mark.meta_value) || 0) + 1;
            store.prepare('INSERT INTO network_sites (id, slug, main_url, status, db_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(id, input.slug, input.url, 'active', siteDbPath(id), t, t);
            store.prepare('INSERT INTO network_site_hosts (host, site_id, kind) VALUES (?, ?, ?)').run(input.hostname, id, 'main');
            store.prepare('INSERT INTO network_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
                .run(LAST_SITE_ID_KEY, String(id));
            return id;
        });
        const id = tx();
        invalidate();
        return getSite(id) as SiteRecord;
    }
    const d = await sqlStore();
    // Two nodes creating a site at once compete for the same next id: the loser's INSERT hits the
    // primary key and it tries again with the id after it. The slug and the address are unique keys too,
    // so whichever node is second for those gets the refusal a single node would give.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const id = await d.transaction(async (q: any) => {
                if (await q.get('SELECT 1 AS x FROM network_sites WHERE slug = ?', [input.slug])) {
                    throw codedError('network_slug_taken', 'Another site already uses this slug.');
                }
                if (await q.get('SELECT 1 AS x FROM network_site_hosts WHERE host = ?', [input.hostname])) {
                    throw codedError('network_host_taken', 'Another site already answers on this address.');
                }
                const row = await q.get('SELECT COALESCE(MAX(id), 1) AS m FROM network_sites');
                const mark = await q.get('SELECT meta_value FROM network_meta WHERE meta_key = ?', [LAST_SITE_ID_KEY]);
                const next = Math.max(PRIMARY_SITE_ID, Number(row && row.m) || 1, Number(mark && mark.meta_value) || 0) + 1;
                await q.run('INSERT INTO network_sites (id, slug, main_url, status, db_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [next, input.slug, input.url, 'active', null, t, t]);
                await q.run('INSERT INTO network_site_hosts (host, site_id, kind) VALUES (?, ?, ?)', [input.hostname, next, 'main']);
                await sqlUpsert(q, 'network_meta', { meta_key: LAST_SITE_ID_KEY }, { meta_value: String(next) });
                return next;
            });
            await afterSqlWrite();
            return getSite(id) as SiteRecord;
        } catch (e: any) {
            if (e && typeof e.code === 'string' && e.code.startsWith('network_')) throw e;
            if (!isDuplicateKey(e) || attempt === 4) throw e;
        }
    }
    throw codedError('network_busy', 'The site could not be recorded; try again.');
}

/** Remove a site's record, addresses, quota and certificates (a failed provisioning, or a deletion). */
async function deleteSiteRecord(id: number): Promise<void> {
    if (!isSiteId(id) || id === PRIMARY_SITE_ID) return;
    const stmts: Array<[string, any[]]> = [
        ['DELETE FROM network_site_hosts WHERE site_id = ?', [id]],
        ['DELETE FROM network_site_quotas WHERE site_id = ?', [id]],
        ['DELETE FROM network_site_certs WHERE site_id = ?', [id]],
        ['DELETE FROM network_sites WHERE id = ?', [id]],
    ];
    if (!isSqlStore()) {
        const store = openStore();
        store.transaction(() => { for (const [sql, p] of stmts) store.prepare(sql).run(...p); })();
        invalidate();
        return;
    }
    await (await sqlStore()).transaction(async (q: any) => { for (const [sql, p] of stmts) await q.run(sql, p); });
    await afterSqlWrite();
}

async function setSiteStatus(id: number, status: SiteStatus): Promise<SiteRecord> {
    if (!isSiteId(id) || id === PRIMARY_SITE_ID) throw codedError('network_primary_site', 'The main site cannot be suspended.');
    if (status !== 'active' && status !== 'suspended') throw codedError('network_invalid_status', 'Unknown site status.');
    const sql = 'UPDATE network_sites SET status = ?, updated_at = ? WHERE id = ?';
    if (!isSqlStore()) {
        const r = openStore().prepare(sql).run(status, now(), id);
        if (!r.changes) throw codedError('network_site_not_found', 'No such site.');
        invalidate();
        return getSite(id) as SiteRecord;
    }
    const d = await sqlStore();
    if (!(await d.get('SELECT 1 AS x FROM network_sites WHERE id = ?', [id]))) throw codedError('network_site_not_found', 'No such site.');
    await d.run(sql, [status, now(), id]);
    await afterSqlWrite();
    return getSite(id) as SiteRecord;
}

function adminRow(userId: number): Row | null {
    if (isSqlStore()) return mirrorOrThrow().admins.find((r) => Number(r.user_id) === userId) || null;
    return openStore().prepare('SELECT user_login FROM network_admins WHERE user_id = ?').get(userId) || null;
}

/**
 * Is `userId` a network administrator? With `login` (the account's current login), a row that names a
 * DIFFERENT login is not this account's: the id was given to someone else (a restored database).
 */
function isNetworkAdmin(userId: unknown, login?: unknown): boolean {
    if (!isSiteId(userId)) return false;
    const row = adminRow(userId);
    if (!row) return false;
    if (login !== undefined && row.user_login && row.user_login !== login) return false;
    return true;
}

function listNetworkAdmins(): number[] {
    if (isSqlStore()) return mirrorOrThrow().admins.map((r) => Number(r.user_id)).sort((a, b) => a - b);
    return openStore().prepare('SELECT user_id FROM network_admins ORDER BY user_id').all().map((r: any) => Number(r.user_id));
}

async function addNetworkAdmin(userId: number, login?: string | null): Promise<void> {
    if (!isSiteId(userId)) throw codedError('network_invalid_user', 'Not a user id.');
    const name = typeof login === 'string' && login ? login : null;
    if (!isSqlStore()) {
        openStore().prepare(`INSERT INTO network_admins (user_id, created_at, user_login) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET user_login = COALESCE(excluded.user_login, network_admins.user_login)`).run(userId, now(), name);
        return;
    }
    const d = await sqlStore();
    const existing = await d.get('SELECT user_login FROM network_admins WHERE user_id = ?', [userId]);
    if (existing) {
        if (name !== null && existing.user_login !== name) await d.run('UPDATE network_admins SET user_login = ? WHERE user_id = ?', [name, userId]);
    } else {
        await sqlUpsert(d, 'network_admins', { user_id: userId }, { created_at: now(), user_login: name });
    }
    await afterSqlWrite();
}

async function removeNetworkAdmin(userId: number): Promise<void> {
    if (!isSqlStore()) { openStore().prepare('DELETE FROM network_admins WHERE user_id = ?').run(userId); return; }
    await (await sqlStore()).run('DELETE FROM network_admins WHERE user_id = ?', [userId]);
    await afterSqlWrite();
}

/**
 * A main-site account was deleted: it is no longer a network administrator. Never creates the store
 * (an install that never had a network has nothing to forget).
 */
async function forgetNetworkAdmin(userId: number): Promise<void> {
    if (!isSiteId(userId)) return;
    if (isSqlStore()) { if (!mirror) return; }
    else if (!db && !fs.existsSync(networkDbPath())) return;
    await removeNetworkAdmin(userId);
}

type AdminAccount = { id: number; login: string } | null;

/**
 * Re-check every network administrator row against the main site's accounts (at boot, and after the
 * main database is restored from a backup). A row whose login names an account keeps following THAT
 * account (a logical restore gives accounts new ids); a row whose account is gone, or whose id now
 * belongs to another login, is removed; an older row with no login is bound to the account its id
 * names today. Never creates the store.
 */
async function reconcileNetworkAdmins(lookup: { byId: (id: number) => Promise<AdminAccount>; byLogin: (login: string) => Promise<AdminAccount> }) {
    const outcome = { kept: 0, rebound: 0, removed: 0 };
    if (isSqlStore()) { if (!mirror) return outcome; }
    else if (!db && !fs.existsSync(networkDbPath())) return outcome;
    const rows: Row[] = isSqlStore()
        ? mirrorOrThrow().admins.slice()
        : openStore().prepare('SELECT user_id, user_login FROM network_admins ORDER BY user_id').all();
    for (const row of rows) {
        const id = Number(row.user_id);
        const login = typeof row.user_login === 'string' && row.user_login ? row.user_login : null;
        const current = await lookup.byId(id);
        if (login === null) {
            if (current) { await addNetworkAdmin(id, current.login); outcome.kept++; }
            else { await removeNetworkAdmin(id); outcome.removed++; }
            continue;
        }
        if (current && current.login === login) { outcome.kept++; continue; }
        const owner = await lookup.byLogin(login);
        await removeNetworkAdmin(id);
        if (owner && isSiteId(owner.id)) {
            await addNetworkAdmin(owner.id, owner.login);
            outcome.rebound++;
        } else {
            outcome.removed++;
        }
    }
    if (outcome.rebound || outcome.removed) await audit('network.admins.reconciled', { detail: outcome });
    return outcome;
}

// ── Plugin grant ceilings ─────────────────────────────────────────────────────────────────────────────
//
// Plugin code is network-wide; activation and grants are per site. A network administrator OFFERS a
// plugin to the other sites by recording its ceiling: the most any site may grant it ("scope:access"
// tokens and/or "network"). No row = not offered: the plugin cannot be activated on a site other than the
// main one. The main site is never bounded by it (core/plugin-permissions ceilingFor).

const CEILING_TOKEN = /^(?:network|[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9_-]{0,31})$/;
const PLUGIN_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function loadCeilings(): Map<string, string[]> {
    if (ceilings) return ceilings;
    const map = new Map<string, string[]>();
    const rows: Row[] = isSqlStore() ? mirrorOrThrow().ceilings : openStore().prepare('SELECT slug, tokens FROM network_plugin_ceilings').all();
    for (const r of rows) {
        let list: unknown;
        try { list = JSON.parse(String(r.tokens)); } catch { list = []; }
        // A malformed row offers the plugin with NOTHING grantable — never more than it says.
        const clean = Array.isArray(list) ? list.filter((t: unknown) => typeof t === 'string' && CEILING_TOKEN.test(t)) as string[] : [];
        map.set(String(r.slug), Object.freeze(clean) as string[]);
    }
    ceilings = map;
    return map;
}

/** The ceiling of `slug` (the most another site may grant it), or null when it is not offered to the other sites. */
function pluginCeiling(slug: string): string[] | null {
    if (!PLUGIN_SLUG_RE.test(String(slug))) return null;
    const c = loadCeilings().get(String(slug));
    return c ? c.slice() : null;
}

/** Every recorded ceiling, by slug. */
function listPluginCeilings(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [slug, tokens] of loadCeilings()) out[slug] = tokens.slice();
    return out;
}

/** Offer `slug` to the other sites with `tokens` as its ceiling (replaces any previous one). Returns the stored list. */
async function setPluginCeiling(slug: string, tokens: unknown): Promise<string[]> {
    if (!PLUGIN_SLUG_RE.test(String(slug))) throw codedError('network_invalid_plugin', 'Not a plugin slug.');
    if (!Array.isArray(tokens)) throw codedError('network_invalid_ceiling', 'The ceiling must be a list of permissions.');
    const clean: string[] = [];
    for (const t of tokens) {
        if (typeof t !== 'string' || !CEILING_TOKEN.test(t)) throw codedError('network_invalid_ceiling', `Not a permission: ${String(t).slice(0, 80)}`);
        if (!clean.includes(t)) clean.push(t);
    }
    clean.sort();
    if (!isSqlStore()) {
        openStore().prepare('INSERT INTO network_plugin_ceilings (slug, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at')
            .run(String(slug), JSON.stringify(clean), now());
        ceilings = null;
        return clean;
    }
    await sqlUpsert(await sqlStore(), 'network_plugin_ceilings', { slug: String(slug) }, { tokens: JSON.stringify(clean), updated_at: now() });
    await afterSqlWrite();
    return clean;
}

/** Stop offering `slug` to the other sites. Returns whether a ceiling was recorded. */
async function clearPluginCeiling(slug: string): Promise<boolean> {
    if (!PLUGIN_SLUG_RE.test(String(slug))) return false;
    if (!isSqlStore()) {
        const r = openStore().prepare('DELETE FROM network_plugin_ceilings WHERE slug = ?').run(String(slug));
        ceilings = null;
        return r.changes > 0;
    }
    const r = await (await sqlStore()).run('DELETE FROM network_plugin_ceilings WHERE slug = ?', [String(slug)]);
    await afterSqlWrite();
    return Number(r && r.changes) > 0;
}

// ---- per-site upload quotas ---------------------------------------------------------------------------
// The most bytes of media a site other than site 1 may hold (its uploads, with their derivatives),
// set by a network administrator. A site's own value wins; without one, the network's default applies;
// with neither (and always for site 1, and on a single site) there is no limit — what every install
// had before quotas existed.

const DEFAULT_QUOTA_KEY = 'default_site_upload_quota_bytes';
/** The largest quota accepted: 1 PiB, far beyond any real disk, and exact as a JS number. */
const MAX_QUOTA_BYTES = 2 ** 50;

function cleanQuota(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_QUOTA_BYTES) {
        throw codedError('network_invalid_quota', 'The upload quota must be a whole number of bytes (or empty for no limit).');
    }
    return n;
}

/** The network's default upload quota for its sites, or null (no limit). */
function defaultUploadQuota(): number | null {
    const v = metaValue(DEFAULT_QUOTA_KEY);
    if (v === null || v === '') return null;
    try { return cleanQuota(v); } catch { return null; }
}

async function setDefaultUploadQuota(value: unknown): Promise<number | null> {
    const bytes = cleanQuota(value);
    if (!isSqlStore()) {
        if (bytes === null) openStore().prepare('DELETE FROM network_meta WHERE meta_key = ?').run(DEFAULT_QUOTA_KEY);
        else openStore().prepare('INSERT INTO network_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value').run(DEFAULT_QUOTA_KEY, String(bytes));
        return bytes;
    }
    const d = await sqlStore();
    if (bytes === null) await d.run('DELETE FROM network_meta WHERE meta_key = ?', [DEFAULT_QUOTA_KEY]);
    else await sqlUpsert(d, 'network_meta', { meta_key: DEFAULT_QUOTA_KEY }, { meta_value: String(bytes) });
    await afterSqlWrite();
    return bytes;
}

/** A site's OWN quota (null when it has none and follows the network default). */
function siteUploadQuotaOverride(siteId: number): number | null {
    if (!isSiteId(siteId)) return null;
    const row = isSqlStore()
        ? mirrorOrThrow().quotas.find((r) => Number(r.site_id) === siteId)
        : openStore().prepare('SELECT upload_bytes FROM network_site_quotas WHERE site_id = ?').get(siteId);
    return row && row.upload_bytes !== null && row.upload_bytes !== undefined ? Number(row.upload_bytes) : null;
}

/** Set (a number of bytes) or clear (null) a site's own quota. Site 1 has none. */
async function setSiteUploadQuota(siteId: number, value: unknown): Promise<number | null> {
    if (!getSite(siteId)) throw codedError('network_site_not_found', 'No such site.');
    if (siteId === PRIMARY_SITE_ID) throw codedError('network_primary_site', 'The main site has no upload quota.');
    const bytes = cleanQuota(value);
    if (!isSqlStore()) {
        if (bytes === null) openStore().prepare('DELETE FROM network_site_quotas WHERE site_id = ?').run(siteId);
        else openStore().prepare('INSERT INTO network_site_quotas (site_id, upload_bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET upload_bytes = excluded.upload_bytes, updated_at = excluded.updated_at').run(siteId, bytes, now());
        return bytes;
    }
    const d = await sqlStore();
    if (bytes === null) await d.run('DELETE FROM network_site_quotas WHERE site_id = ?', [siteId]);
    else await sqlUpsert(d, 'network_site_quotas', { site_id: siteId }, { upload_bytes: bytes, updated_at: now() });
    await afterSqlWrite();
    return bytes;
}

/** The quota in effect for a site: its own, else the network default; null = no limit (site 1, always). */
function effectiveUploadQuota(siteId: number): number | null {
    if (!isSiteId(siteId) || siteId === PRIMARY_SITE_ID) return null;
    const own = siteUploadQuotaOverride(siteId);
    return own !== null ? own : defaultUploadQuota();
}

// ── Shared records for certificates (core/site-certs, core/cert-manager) ─────────────────────────────
// Not mirrored: they are read when the CA calls or a certificate is installed, never on the request path.

/** Run a statement against the store, whichever it is; resolves to the number of rows it changed. */
async function storeRun(sql: string, params: any[] = []): Promise<number> {
    if (!isSqlStore()) return Number(openStore().prepare(sql).run(...params).changes) || 0;
    const r = await (await sqlStore()).run(sql, params);
    return Number(r && r.changes) || 0;
}
async function storeGet(sql: string, params: any[] = []): Promise<Row | undefined> {
    if (!isSqlStore()) return openStore().prepare(sql).get(...params);
    return (await sqlStore()).get(sql, params);
}
async function storeAll(sql: string, params: any[] = []): Promise<Row[]> {
    if (!isSqlStore()) return openStore().prepare(sql).all(...params);
    return (await sqlStore()).all(sql, params);
}
async function storeUpsert(table: string, key: Row, values: Row): Promise<void> {
    if (!isSqlStore()) {
        const store = openStore();
        store.transaction(() => {
            const keys = Object.keys(key);
            const vals = Object.keys(values);
            const where = keys.map((k) => `${k} = ?`).join(' AND ');
            const r = store.prepare(`UPDATE ${table} SET ${vals.map((c) => `${c} = ?`).join(', ')} WHERE ${where}`).run(...vals.map((c) => values[c]), ...keys.map((k) => key[k]));
            if (!r.changes) {
                const cols = [...keys, ...vals];
                store.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => (c in key ? key[c] : values[c])));
            }
        })();
        return;
    }
    await sqlUpsert(await sqlStore(), table, key, values);
}

module.exports = {
    CHANNEL,
    NETWORK_RESYNC_MS,
    isSqlStore,
    networkDbPath,
    describeStore,
    sitesDataDir,
    siteDataDir,
    siteDbPath,
    currentSiteUrl,
    ready,
    isLoaded,
    reloadMirror,
    onRegistryChange,
    closeNetworkStore,
    listSites,
    getSite,
    siteIdForHostname,
    policySites,
    registerPrimarySite,
    normalizeSiteUrl,
    insertSite,
    deleteSiteRecord,
    setSiteStatus,
    isNetworkAdmin,
    listNetworkAdmins,
    addNetworkAdmin,
    removeNetworkAdmin,
    forgetNetworkAdmin,
    reconcileNetworkAdmins,
    audit,
    auditLog,
    invalidate,
    pluginCeiling,
    listPluginCeilings,
    setPluginCeiling,
    clearPluginCeiling,
    defaultUploadQuota,
    setDefaultUploadQuota,
    siteUploadQuotaOverride,
    setSiteUploadQuota,
    effectiveUploadQuota,
    storeRun,
    storeGet,
    storeAll,
    storeUpsert,
    TABLES,
    MAX_QUOTA_BYTES,
};
