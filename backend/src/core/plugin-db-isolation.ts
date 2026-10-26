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
 * DDL (CREATE/ALTER/DROP) runs under the same principal (runDdl): on Postgres the role holds CREATE on its
 * schema and OWNS its plugin's tables; on MySQL the user is granted, just before the statement, ALL on
 * exactly the objects the SQL guard proved the plugin owns. The database therefore judges plugin DDL by
 * the plugin's own rights, and a view or trigger it creates runs as the plugin, never as the admin.
 *
 * Fails GRACEFULLY: if the pool user can't provision (no CREATEROLE / CREATE USER / GRANT OPTION), or
 * the driver is SQLite, the plugin falls back to the text-guard alone on the admin connection — never
 * broken — and the fallback is recorded (degradedPrincipals) so Site Health can tell the administrator.
 */
const config = require('../config/app');
const crypto = require('crypto');
const log = require('./module-logger').moduleLogger('core/plugin-db-isolation');
const siteContext = require('./site-context');

/*
 * MULTISITE: one principal per (site, plugin). Each site has its own database, and each site's worker of
 * a plugin runs its queries under that SITE's principal for the plugin: `wjp_role_<slug>` / `wjp_<slug>`
 * on site 1 (unchanged), `…__s<id>` on any other site. A slug cannot produce a double underscore
 * (normalizeSlug collapses every run of other characters into one), so no site-1 plugin's principal can
 * ever be named like another site's. The tables themselves keep the plugin's prefix in every site's
 * database. Every function below takes the plugin SLUG and acts for the current site.
 */
function principalSuffix(siteId: number = siteContext.currentSiteId()): string {
    return siteId === siteContext.PRIMARY_SITE_ID ? '' : `__s${siteId}`;
}
/** The registry key of the current site's principal for `slug`. */
function principalKey(slug: string): string {
    return `${slug}${principalSuffix()}`;
}

// Principal keys (slug + site suffix) provisioned in THIS process → their DML/SELECT routes through it.
const provisioned = new Set<string>();
// MySQL only: the per-process password for each principal's login user (never persisted).
const pluginPasswords = new Map<string, string>();
// Postgres only: principals whose role may run its plugin's DDL (enablePluginDdl succeeded).
const ddlCapable = new Set<string>();
// Principal key → why it could not be set up (or lost its DDL scope) on Postgres/MySQL. Read by Site Health.
const degraded = new Map<string, { slug: string; reason: string }>();
function markDegraded(slug: string, reason: string, e?: any): void {
    degraded.set(principalKey(slug), { slug, reason: clean(String((e && e.message) || reason)).slice(0, 300) });
}

/** Does `table` (under the plugin's prefix) really belong to `slug`? A longer sibling prefix owns its own. */
function ownsTable(slug: string, table: string): boolean {
    try { return require('./plugin-api').isTableOwnedBy(table, slug); } catch { return false; }
}

// Strip line breaks before logging an untrusted value (a plugin slug, or a driver error echoing one),
// so a crafted slug can't forge or split log entries.
//
// TWO single-constant replacements, each replacing with the empty string, is deliberate and must stay
// that way: the log-injection analysis recognises a sanitizer SYNTACTICALLY, and neither the original
// `/\r\n|\r|\n/g` nor `/\n|\r/g` was matched (an alternation has no constant value), so every call site
// here was still reported as an unsanitized log entry. Match the documented remediation shape.
function clean(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/** Driver work for a principal is the host's own, whatever context asked for it (see runScoped). */
function asHost<T>(fn: () => Promise<T>): Promise<T> {
    return require('./plugin-context').runAsHost(fn);
}

function normalizeSlug(slug: string): string { return String(slug).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(); }
function roleName(slug: string): string { return 'wjp_role_' + normalizeSlug(slug) + principalSuffix(); }
function tablePrefix(slug: string): string { return 'wjp_' + normalizeSlug(slug) + '_'; }

/** MySQL login-user name for a plugin. Bounded to 32 chars (MySQL's user-name limit) via a short hash. */
function userName(slug: string): string {
    const suffix = principalSuffix();
    const base = 'wjp_' + normalizeSlug(slug) + suffix;
    if (base.length <= 32) return base;
    const h = crypto.createHash('sha1').update(String(slug) + suffix).digest('hex').slice(0, 8);
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
    return asHost(() => provisionImpl(slug));
}
async function provisionImpl(slug: string): Promise<void> {
    if (!enabled() || provisioned.has(principalKey(slug))) return;
    const pg = pgDriver();
    if (pg) {
        const role = roleName(slug);
        const owns = (t: string) => ownsTable(slug, t);
        try {
            await pg.ensurePluginRole(role);
            await pg.grantPluginPrefix(role, tablePrefix(slug), owns);
            provisioned.add(principalKey(slug));
        } catch (e: any) {
            provisioned.delete(principalKey(slug));
            markDegraded(slug, 'provision', e);
            log.warn({ slug: clean(slug), err: e }, `[plugin-db-roles] could not provision role for '${clean(slug)}' (falling back to the SQL text-guard)`);
            return;
        }
        try {
            await pg.enablePluginDdl(role, tablePrefix(slug), owns);
            ddlCapable.add(principalKey(slug));
            degraded.delete(principalKey(slug));
        } catch (e: any) {
            ddlCapable.delete(principalKey(slug));
            markDegraded(slug, 'ddl', e);
            log.warn({ slug: clean(slug), err: e }, `[plugin-db-roles] could not hand '${clean(slug)}' its own tables (its DDL runs on the SQL text-guard)`);
        }
        return;
    }
    const my = mysqlDriver();
    if (my) {
        const user = userName(slug);
        const pw = crypto.randomBytes(24).toString('hex');
        try {
            await my.ensurePluginUser(user, pw);
            await my.grantPluginPrefixToUser(user, tablePrefix(slug), (t: string) => ownsTable(slug, t));
            pluginPasswords.set(principalKey(slug), pw);
            provisioned.add(principalKey(slug));
            degraded.delete(principalKey(slug));
        } catch (e: any) {
            provisioned.delete(principalKey(slug));
            pluginPasswords.delete(principalKey(slug));
            markDegraded(slug, 'provision', e);
            log.warn({ slug: clean(slug), err: e }, `[plugin-db-users] could not provision user for '${clean(slug)}' (falling back to the SQL text-guard)`);
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
    return asHost(() => deprovisionImpl(slug));
}
async function deprovisionImpl(slug: string): Promise<void> {
    provisioned.delete(principalKey(slug));
    pluginPasswords.delete(principalKey(slug));
    ddlCapable.delete(principalKey(slug));
    degraded.delete(principalKey(slug));
    const pg = pgDriver();
    if (pg) {
        try { await pg.dropPluginRole(roleName(slug)); }
        catch (e: any) { log.warn({ slug: clean(slug), err: e }, `[plugin-db-roles] drop role for '${clean(slug)}' failed`); }
        return;
    }
    const my = mysqlDriver();
    if (my) {
        try { await my.dropPluginUser(userName(slug)); }
        catch (e: any) { log.warn({ slug: clean(slug), err: e }, `[plugin-db-users] drop user for '${clean(slug)}' failed`); }
    }
}

/**
 * GRANT a newly-created table to the plugin's DB principal (called right after a plugin CREATE TABLE).
 *
 * If the GRANT is refused the principal can never read that table, so routing the plugin's queries through
 * it would fail every one of them with "access denied" (M3-03 / S4-01: a MySQL/MariaDB user holding ALL
 * PRIVILEGES without GRANT OPTION — the usual managed-database user — creates the plugin's login user but
 * cannot grant it anything; the first activation then left the plugin provisioned with no rights at all
 * until the next restart, where provision() itself failed and fell back). The principal is dropped from
 * this process's routing instead, so the plugin runs on the SQL text-guard, exactly as it would have if
 * provisioning had failed up-front. Never broken, as the header promises.
 */
async function grantNewTable(slug: string, table: string): Promise<void> {
    return asHost(() => grantNewTableImpl(slug, table));
}
async function grantNewTableImpl(slug: string, table: string): Promise<void> {
    if (!provisioned.has(principalKey(slug))) return;
    const tbl = String(table).toLowerCase();
    const pg = pgDriver();
    const my = pg ? null : mysqlDriver();
    if (!pg && !my) return;
    try {
        if (pg) {
            await pg.grantPluginTable(roleName(slug), tbl);
            // A table the HOST created for the plugin (createTable) goes to the role like the rest, so the
            // plugin's later ALTER/INDEX on it run under the role too.
            if (ddlCapable.has(principalKey(slug))) await pg.ownPluginTable(roleName(slug), tbl);
        }
        else await my.grantPluginTableToUser(userName(slug), tbl);
    } catch (e: any) {
        provisioned.delete(principalKey(slug));
        pluginPasswords.delete(principalKey(slug));
        ddlCapable.delete(principalKey(slug));
        markDegraded(slug, 'grant', e);
        log.warn({ table: clean(table), slug: clean(slug), err: e },
            `[plugin-db-${pg ? 'roles' : 'users'}] grant new table '${clean(table)}' to '${clean(slug)}' failed (falling back to the SQL text-guard)`);
    }
}

/**
 * Run a plugin's DML/SELECT under its DB principal when provisioned; otherwise the normal (text-guard-only)
 * path. DDL goes through runDdl below.
 */
async function runScoped(slug: string, method: 'all' | 'get' | 'run', sql: string, params: any[]): Promise<any> {
    const { dbAsync } = require('../config/database');
    if (provisioned.has(principalKey(slug))) {
        // The principal's connection belongs to the HOST, like the shared pool (config/database): opened
        // under the plugin's context it would be judged by that plugin's sandbox and keep its context.
        const { runAsHost } = require('./plugin-context');
        const pg = pgDriver();
        if (pg) return runAsHost(() => pg.runAsRole(roleName(slug), method, sql, params));
        const my = mysqlDriver();
        const pw = pluginPasswords.get(principalKey(slug));
        if (my && pw) return runAsHost(() => my.runAsUser(userName(slug), pw, method, sql, params));
    }
    return dbAsync[method](sql, params);
}

/**
 * Run a plugin's DDL (CREATE/ALTER/DROP) under its DB principal. `owned` is what the SQL guard proved the
 * plugin owns in this statement; on MySQL exactly those names are granted to the user first. A statement the
 * database refuses under the principal FAILS — it is never retried with the admin's rights. Only a plugin
 * with no usable principal (SQLite, or a database user that cannot create one: see degradedPrincipals) runs
 * its DDL on the shared connection, on the text-guard alone.
 */
async function runDdl(slug: string, sql: string, params: any[], owned: string[]): Promise<any> {
    const { dbAsync } = require('../config/database');
    const key = principalKey(slug);
    if (provisioned.has(key)) {
        const pg = pgDriver();
        if (pg) {
            if (ddlCapable.has(key)) return asHost(() => pg.runDdlAsRole(roleName(slug), sql, params));
        } else {
            const my = mysqlDriver();
            const pw = pluginPasswords.get(key);
            if (my && pw) {
                let granted = true;
                try { await asHost(() => my.grantPluginDdlToUser(userName(slug), owned)); }
                catch (e: any) {
                    granted = false;
                    markDegraded(slug, 'ddl', e);
                    log.warn({ slug: clean(slug), err: e }, `[plugin-db-users] could not grant '${clean(slug)}' its DDL objects (this statement runs on the SQL text-guard)`);
                }
                if (granted) return asHost(() => my.runDdlAsUser(userName(slug), pw, sql, params));
            }
        }
    }
    return dbAsync.run(sql, params);
}

/**
 * The plugins whose queries run WITHOUT their own DB principal on an engine that has principals (Postgres /
 * MySQL), and why — Site Health's warning. Empty on SQLite and when isolation was switched off on purpose.
 */
function degradedPrincipals(): { slug: string; reason: string }[] {
    if (!enabled() || (!pgDriver() && !mysqlDriver())) return [];
    const suffix = principalSuffix();
    return Array.from(degraded.entries())
        .filter(([k]) => (suffix ? k.endsWith(suffix) : !k.includes('__s')))
        .map(([, v]) => ({ ...v }));
}

/**
 * A site of the network is being deleted: drop the principal each plugin had on it (Postgres role / MySQL
 * user `…__s<id>`), whether or not this process provisioned it — another node may have. Runs in the
 * deleted site's context, before its database goes; site 1's principals are never named here.
 */
async function dropSitePrincipals(slugs: string[]): Promise<void> {
    if (siteContext.currentSiteId() === siteContext.PRIMARY_SITE_ID) throw new Error('dropSitePrincipals: not for the main site');
    const pg = pgDriver();
    const my = pg ? null : mysqlDriver();
    const suffix = principalSuffix();
    // The installed plugins' principals, those this process provisioned, and — on Postgres — every role the
    // server holds with this site's suffix (another node, or a plugin since deleted, may have made one).
    const names = new Set<string>(slugs.map((s) => (pg ? roleName(s) : userName(s))));
    for (const key of Array.from(provisioned)) {
        if (key.endsWith(suffix)) names.add(pg ? roleName(key.slice(0, -suffix.length)) : userName(key.slice(0, -suffix.length)));
    }
    if (pg) {
        try {
            const rows = await pg.all("SELECT rolname FROM pg_roles WHERE rolname LIKE 'wjp!_role!_%' ESCAPE '!' AND right(rolname, length(?)) = ?", [suffix, suffix]);
            for (const r of rows) names.add(String(r.rolname));
        } catch { /* the roles above are still dropped */ }
    } else if (my) {
        try {
            const rows = await my.all("SELECT User AS u FROM mysql.user WHERE User LIKE 'wjp!_%' ESCAPE '!' AND RIGHT(User, CHAR_LENGTH(?)) = ?", [suffix, suffix]);
            for (const r of rows) names.add(String(r.u || r.User));
        } catch { /* no read access to mysql.user: the names above are still dropped */ }
    }
    for (const key of Array.from(provisioned)) {
        if (key.endsWith(suffix)) { provisioned.delete(key); pluginPasswords.delete(key); ddlCapable.delete(key); degraded.delete(key); }
    }
    for (const name of names) {
        try {
            if (pg) await pg.dropPluginRole(name);
            else if (my) await my.dropPluginUser(name);
        } catch (e: any) {
            log.warn({ principal: clean(name), err: e }, `[plugin-db-roles] could not drop the principal '${clean(name)}' of a deleted site`);
        }
    }
}

/**
 * A site's database was replaced (a restore) or dropped: its grants are gone, so its principals must be
 * provisioned again (the role / user itself may remain). Forgets this process's record of them.
 */
function forgetSiteProvisioning(siteId: number): void {
    const suffix = principalSuffix(siteId);
    for (const key of Array.from(provisioned)) {
        const mine = suffix ? key.endsWith(suffix) : !key.includes('__s');
        if (mine) { provisioned.delete(key); pluginPasswords.delete(key); ddlCapable.delete(key); degraded.delete(key); }
    }
}

module.exports = {
    provision, reconcile, deprovision, grantNewTable, runScoped, runDdl, dropSitePrincipals, forgetSiteProvisioning,
    degradedPrincipals, roleName, userName, tablePrefix, isProvisioned: (s: string) => provisioned.has(principalKey(s)),
    isDdlScoped: (s: string) => ddlCapable.has(principalKey(s)),
};
