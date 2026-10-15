/**
 * WordJS — the network store: which sites exist, which addresses each one answers, and who may
 * administer the network (multisite).
 *
 * It is a small SQLite file of its own (`network.db`, next to the main database), deliberately
 * separate from every site's database: a site's export, backup or wipe never carries the network's
 * records, and no site-scoped code path (a model, a plugin bridge) can reach it through `dbAsync`.
 *
 * Site 1 is the install that existed before multisite was enabled. Its database, uploads and addresses
 * stay exactly where they were: its main address is still `siteUrl` in wordjs-config.json (written only
 * by core/site-address.ts), so its row here is a record, not the master. Every other site's address
 * lives only here and is written only by this module.
 *
 * This module is the single writer of the network store. Reads are served from an in-memory snapshot
 * that every write replaces; `policySites()` keeps one array identity per snapshot so the host policy
 * (built from it) is rebuilt only when the registry really changed.
 */
const path = require('path');
const fs = require('fs');
const config = require('../config/app');
const hostPolicy = require('./host-policy');
import { PRIMARY_SITE_ID, isSiteId, currentSiteId } from './site-context';

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

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

let db: any = null;
let snapshot: { sites: SiteRecord[]; byId: Map<number, SiteRecord>; byHost: Map<string, number>; policy: PolicySite[] } | null = null;

/** Where the network store lives: next to the main database file. */
function networkDbPath(): string {
    const override = (config as any).multisite && (config as any).multisite.networkDbPath;
    if (typeof override === 'string' && override) return path.resolve(override);
    return path.join(path.dirname(path.resolve(config.dbPath || './data/wordjs-native.db')), 'network.db');
}

/** The directory that holds the databases of the sites other than site 1. */
function sitesDataDir(): string {
    return path.join(path.dirname(path.resolve(config.dbPath || './data/wordjs-native.db')), 'sites');
}

/**
 * Everything a site other than site 1 owns on disk lives in ONE directory: its database and its public
 * and private uploads. Outside the main site's served `/uploads` tree on purpose — the main site's
 * address can never serve another site's files — and self-contained, so a site can be backed up, moved
 * or removed as one folder. Site 1 keeps config.dbPath and config.uploads, as it always did.
 */
function siteDataDir(id: number): string {
    return path.join(sitesDataDir(), String(id));
}

/** The database file of site `id` (> 1). Site 1's is config.dbPath, as it always was. */
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

function openStore(): any {
    if (db) return db;
    const Database = require('better-sqlite3');
    const file = networkDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = new Database(file);
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    handle.exec(`
        CREATE TABLE IF NOT EXISTS network_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS network_sites (
            id INTEGER PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            main_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            db_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS network_site_hosts (
            host TEXT PRIMARY KEY,
            site_id INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'main'
        );
        CREATE TABLE IF NOT EXISTS network_admins (
            user_id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS network_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            actor_user_id INTEGER,
            action TEXT NOT NULL,
            site_id INTEGER,
            detail TEXT NOT NULL DEFAULT ''
        );
    `);
    db = handle;
    snapshot = null;
    return db;
}

/** Close the store (tests, shutdown). The next read reopens it. */
function closeNetworkStore(): void {
    if (db) {
        try { db.close(); } catch { /* already closed */ }
    }
    db = null;
    snapshot = null;
}

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

function load() {
    if (snapshot) return snapshot;
    const store = openStore();
    const rows = store.prepare('SELECT * FROM network_sites ORDER BY id').all();
    const sites: SiteRecord[] = rows.map(rowToSite);
    const byId = new Map<number, SiteRecord>(sites.map((s) => [s.id, s]));
    const byHost = new Map<string, number>();
    for (const h of store.prepare('SELECT host, site_id FROM network_site_hosts').all()) {
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

function audit(action: string, opts: { actor?: number | null; siteId?: number | null; detail?: unknown } = {}): void {
    const detail = opts.detail === undefined ? '' : JSON.stringify(opts.detail).slice(0, 4000);
    openStore().prepare('INSERT INTO network_audit_log (at, actor_user_id, action, site_id, detail) VALUES (?, ?, ?, ?, ?)')
        .run(now(), opts.actor ?? null, action, opts.siteId ?? null, detail);
}

function auditLog(limit = 100): any[] {
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    return openStore().prepare('SELECT id, at, actor_user_id AS actorUserId, action, site_id AS siteId, detail FROM network_audit_log ORDER BY id DESC LIMIT ?').all(n);
}

/**
 * Record site 1 (the existing install). Idempotent: enabling twice, or booting a network whose store
 * already has site 1, changes nothing but the recorded address.
 */
function registerPrimarySite(mainUrl: string): SiteRecord {
    const store = openStore();
    const t = now();
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

/** Normalize a site address to `scheme://host[:port]`, or null when it is not one. */
function normalizeSiteUrl(raw: unknown): { url: string; hostname: string } | null {
    const site = hostPolicy.parseSiteUrl(raw);
    if (!site) return null;
    return { url: site.origin, hostname: site.hostname };
}

/**
 * Insert the record of a new site in the `provisioning`-free shape: the caller (core/network-sites)
 * provisions its database and first administrator, and removes the record again if that fails.
 * Throws a coded error when the slug or the address is taken.
 */
function insertSite(input: { slug: string; url: string; hostname: string }): SiteRecord {
    const store = openStore();
    if (!SLUG_RE.test(input.slug)) throw codedError('network_invalid_slug', 'The site slug must be 1-40 lower-case letters, digits or dashes.');
    const t = now();
    const tx = store.transaction(() => {
        if (store.prepare('SELECT 1 FROM network_sites WHERE slug = ?').get(input.slug)) {
            throw codedError('network_slug_taken', 'Another site already uses this slug.');
        }
        if (store.prepare('SELECT 1 FROM network_site_hosts WHERE host = ?').get(input.hostname)) {
            throw codedError('network_host_taken', 'Another site already answers on this address.');
        }
        const row = store.prepare('SELECT COALESCE(MAX(id), 1) AS m FROM network_sites').get();
        const id = Math.max(PRIMARY_SITE_ID, Number(row.m)) + 1;
        store.prepare('INSERT INTO network_sites (id, slug, main_url, status, db_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, input.slug, input.url, 'active', siteDbPath(id), t, t);
        store.prepare('INSERT INTO network_site_hosts (host, site_id, kind) VALUES (?, ?, ?)').run(input.hostname, id, 'main');
        return id;
    });
    const id = tx();
    invalidate();
    return getSite(id) as SiteRecord;
}

/** Remove a site's record and addresses (used to undo a failed provisioning only). */
function deleteSiteRecord(id: number): void {
    if (!isSiteId(id) || id === PRIMARY_SITE_ID) return;
    const store = openStore();
    store.transaction(() => {
        store.prepare('DELETE FROM network_site_hosts WHERE site_id = ?').run(id);
        store.prepare('DELETE FROM network_sites WHERE id = ?').run(id);
    })();
    invalidate();
}

function setSiteStatus(id: number, status: SiteStatus): SiteRecord {
    if (!isSiteId(id) || id === PRIMARY_SITE_ID) throw codedError('network_primary_site', 'The main site cannot be suspended.');
    if (status !== 'active' && status !== 'suspended') throw codedError('network_invalid_status', 'Unknown site status.');
    const r = openStore().prepare('UPDATE network_sites SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    if (!r.changes) throw codedError('network_site_not_found', 'No such site.');
    invalidate();
    return getSite(id) as SiteRecord;
}

function isNetworkAdmin(userId: unknown): boolean {
    if (!isSiteId(userId)) return false;
    return !!openStore().prepare('SELECT 1 FROM network_admins WHERE user_id = ?').get(userId);
}

function listNetworkAdmins(): number[] {
    return openStore().prepare('SELECT user_id FROM network_admins ORDER BY user_id').all().map((r: any) => Number(r.user_id));
}

function addNetworkAdmin(userId: number): void {
    if (!isSiteId(userId)) throw codedError('network_invalid_user', 'Not a user id.');
    openStore().prepare('INSERT OR IGNORE INTO network_admins (user_id, created_at) VALUES (?, ?)').run(userId, now());
}

function removeNetworkAdmin(userId: number): void {
    openStore().prepare('DELETE FROM network_admins WHERE user_id = ?').run(userId);
}

function codedError(code: string, message: string): Error & { code: string } {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
}

module.exports = {
    networkDbPath,
    sitesDataDir,
    siteDataDir,
    siteDbPath,
    currentSiteUrl,
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
    audit,
    auditLog,
    invalidate,
};
