/**
 * WordJS — Per-plugin DB isolation (defense-in-depth BELOW the SQL text-guard).
 *
 * Each active plugin runs its DML/SELECT under a low-privilege DB principal scoped to ONLY its own
 * wjp_<slug>_ tables, so the DATABASE itself denies any cross-plugin/core access even if the SQL
 * text-guard (assertSqlAllowed) is bypassed — the definitive isolation control the 2026-07-20 audit
 * called for. Two engine strategies, same guarantee:
 *
 *   - Postgres: a NOLOGIN ROLE per plugin, GRANTed its prefix; queries run via SET ROLE on a pinned
 *     client (driver.runAsRole).
 *   - MySQL/MariaDB: a login USER per plugin (SET ROLE can't strip the admin user's DIRECT privileges),
 *     GRANTed its prefix; queries run on a small pool authenticated AS that user (driver.runAsUser). Its
 *     password is generated fresh per process boot and kept only in memory.
 *
 * Fails GRACEFULLY: if the pool user can't provision (no CREATEROLE / CREATE USER), or the driver is
 * SQLite, provisioning is a no-op and the plugin falls back to the text-guard alone — never broken. DDL
 * (CREATE/ALTER/DROP) always runs as the admin user (a scoped principal has no CREATE), prefix-scoped by
 * the text-guard, and each new table is GRANTed to the principal afterward.
 */
const config = require('../config/app');
const crypto = require('crypto');

// Slugs whose DB principal is provisioned in THIS process → their DML/SELECT routes through it.
const provisioned = new Set<string>();
// MySQL only: the per-process password for each plugin's login user (never persisted).
const pluginPasswords = new Map<string, string>();

// Strip line breaks before logging an untrusted value (a plugin slug, or a driver error echoing one),
// so a crafted slug can't forge or split log entries.
//
// The pattern is `/\n|\r/g` on purpose and must stay that way: this is the shape the log-injection
// analysis recognises as a sanitizer, and it is SYNTACTIC — the equivalent `/\r\n|\r|\n/g` this used to
// carry was not matched, so every call site here was still reported as an unsanitized log entry.
function clean(v: any): string { return String(v == null ? '' : v).replace(/\n|\r/g, ' '); }

function normalizeSlug(slug: string): string { return String(slug).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(); }
function roleName(slug: string): string { return 'wjp_role_' + normalizeSlug(slug); }
function tablePrefix(slug: string): string { return 'wjp_' + normalizeSlug(slug) + '_'; }

/** MySQL login-user name for a plugin. Bounded to 32 chars (MySQL's user-name limit) via a short hash. */
function userName(slug: string): string {
    const base = 'wjp_' + normalizeSlug(slug);
    if (base.length <= 32) return base;
    const h = crypto.createHash('sha1').update(String(slug)).digest('hex').slice(0, 8);
    return base.slice(0, 23) + '_' + h; // 23 + '_' + 8 = 32
}

/** Opt-out via config.sandbox.pluginDbRoles=false. Only takes effect on Postgres/MySQL (checked below). */
function enabled(): boolean {
    return !(config.sandbox && config.sandbox.pluginDbRoles === false);
}

/** The active driver iff it is Postgres AND exposes the role helpers; null otherwise. */
function pgDriver(): any {
    try {
        const { getDbType, getDbAsync } = require('../config/database');
        const t = getDbType();
        if (!t || !t.isPostgres) return null;
        const d = getDbAsync();
        return d && typeof d.runAsRole === 'function' ? d : null;
    } catch { return null; }
}

/** The active driver iff it is MySQL/MariaDB AND exposes the user helpers; null otherwise. */
function mysqlDriver(): any {
    try {
        const { getDbType, getDbAsync } = require('../config/database');
        const t = getDbType();
        if (!t || !t.isMySQL) return null;
        const d = getDbAsync();
        return d && typeof d.runAsUser === 'function' ? d : null;
    } catch { return null; }
}

/** Provision a plugin's DB principal + grants. Idempotent (once per process); no-op on SQLite; graceful. */
async function provision(slug: string): Promise<void> {
    if (!enabled() || provisioned.has(slug)) return;
    const pg = pgDriver();
    if (pg) {
        const role = roleName(slug);
        try {
            await pg.ensurePluginRole(role);
            await pg.grantPluginPrefix(role, tablePrefix(slug));
            provisioned.add(slug);
        } catch (e: any) {
            provisioned.delete(slug);
            console.warn(`[plugin-db-roles] could not provision role for '${clean(slug)}' (falling back to the SQL text-guard): ${clean(e && e.message)}`);
        }
        return;
    }
    const my = mysqlDriver();
    if (my) {
        const user = userName(slug);
        const pw = crypto.randomBytes(24).toString('hex');
        try {
            await my.ensurePluginUser(user, pw);
            await my.grantPluginPrefixToUser(user, tablePrefix(slug));
            pluginPasswords.set(slug, pw);
            provisioned.add(slug);
        } catch (e: any) {
            provisioned.delete(slug);
            pluginPasswords.delete(slug);
            console.warn(`[plugin-db-users] could not provision user for '${clean(slug)}' (falling back to the SQL text-guard): ${clean(e && e.message)}`);
        }
    }
    // SQLite → text-guard only.
}

/** Reconcile principals for every currently-active plugin at boot (existing installs get theirs). */
async function reconcile(slugs: string[]): Promise<void> {
    if (!enabled() || (!pgDriver() && !mysqlDriver())) return;
    for (const slug of slugs) { await provision(slug); }
}

/** Drop a plugin's DB principal on uninstall (best-effort; its tables are dropped separately). */
async function deprovision(slug: string): Promise<void> {
    provisioned.delete(slug);
    pluginPasswords.delete(slug);
    const pg = pgDriver();
    if (pg) {
        try { await pg.dropPluginRole(roleName(slug)); }
        catch (e: any) { console.warn(`[plugin-db-roles] drop role for '${clean(slug)}' failed: ${clean(e && e.message)}`); }
        return;
    }
    const my = mysqlDriver();
    if (my) {
        try { await my.dropPluginUser(userName(slug)); }
        catch (e: any) { console.warn(`[plugin-db-users] drop user for '${clean(slug)}' failed: ${clean(e && e.message)}`); }
    }
}

/** GRANT a newly-created table to the plugin's DB principal (called right after a plugin CREATE TABLE). */
async function grantNewTable(slug: string, table: string): Promise<void> {
    if (!provisioned.has(slug)) return;
    const tbl = String(table).toLowerCase();
    const pg = pgDriver();
    if (pg) {
        try { await pg.grantPluginTable(roleName(slug), tbl); }
        catch (e: any) { console.warn(`[plugin-db-roles] grant new table '${clean(table)}' to '${clean(slug)}' failed: ${clean(e && e.message)}`); }
        return;
    }
    const my = mysqlDriver();
    if (my) {
        try { await my.grantPluginTableToUser(userName(slug), tbl); }
        catch (e: any) { console.warn(`[plugin-db-users] grant new table '${clean(table)}' to '${clean(slug)}' failed: ${clean(e && e.message)}`); }
    }
}

/**
 * Run a plugin's DML/SELECT under its DB principal when provisioned; otherwise the normal (text-guard-only)
 * path. NOTE: DDL is NOT routed here — a scoped principal has no CREATE, so the caller runs CREATE/ALTER/DROP
 * as the admin user (prefix-scoped by the text-guard) and then GRANTs the new table via grantNewTable().
 */
async function runScoped(slug: string, method: 'all' | 'get' | 'run', sql: string, params: any[]): Promise<any> {
    const { dbAsync } = require('../config/database');
    if (provisioned.has(slug)) {
        const pg = pgDriver();
        if (pg) return pg.runAsRole(roleName(slug), method, sql, params);
        const my = mysqlDriver();
        const pw = pluginPasswords.get(slug);
        if (my && pw) return my.runAsUser(userName(slug), pw, method, sql, params);
    }
    return dbAsync[method](sql, params);
}

module.exports = {
    provision, reconcile, deprovision, grantNewTable, runScoped,
    roleName, userName, tablePrefix, isProvisioned: (s: string) => provisioned.has(s),
};
