/**
 * WordJS — Per-plugin DB role isolation (defense-in-depth BELOW the SQL text-guard).
 *
 * On Postgres each active plugin gets its OWN low-privilege NOLOGIN role, GRANTed CRUD ONLY on its own
 * wjp_<slug>_ tables; the plugin's DML/SELECT runs under that role (SET ROLE on a pinned client). So the
 * DATABASE itself denies any cross-plugin/core read even if the SQL text-guard (assertSqlAllowed) is
 * bypassed — the definitive isolation control the 2026-07-20 audit called for.
 *
 * Fails GRACEFULLY: if the pool user lacks CREATEROLE, or the driver isn't Postgres, provisioning is a
 * no-op and the plugin falls back to the text-guard alone — never broken. DDL (CREATE/ALTER/DROP) still
 * runs as the admin user (a NOLOGIN role has no CREATE), scoped to the plugin's prefix by the text-guard,
 * and each new table is GRANTed to the role afterward.
 *
 * SQLite (no roles) and MySQL (needs per-user pools — follow-up) keep the text-guard as their boundary.
 */
const config = require('../config/app');

// Slugs whose role is provisioned in THIS process → their DML/SELECT routes through the role.
const provisioned = new Set<string>();

function normalizeSlug(slug: string): string { return String(slug).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(); }
function roleName(slug: string): string { return 'wjp_role_' + normalizeSlug(slug); }
function tablePrefix(slug: string): string { return 'wjp_' + normalizeSlug(slug) + '_'; }

/** Opt-out via config.sandbox.pluginDbRoles=false. Only takes effect on Postgres (checked at provision). */
function enabled(): boolean {
    return !(config.sandbox && config.sandbox.pluginDbRoles === false);
}

/** The active driver iff it is Postgres AND exposes the role helpers; null otherwise (SQLite/MySQL). */
function pgDriver(): any {
    try {
        const { getDbType, getDbAsync } = require('../config/database');
        const t = getDbType();
        if (!t || !t.isPostgres) return null;
        const d = getDbAsync();
        return d && typeof d.runAsRole === 'function' ? d : null;
    } catch { return null; }
}

/** Provision (or reconcile) a plugin's role + grants. Idempotent; no-op off Postgres; graceful on failure. */
async function provision(slug: string): Promise<void> {
    if (!enabled()) return;
    const d = pgDriver();
    if (!d) return; // SQLite / MySQL → text-guard only
    const role = roleName(slug);
    try {
        await d.ensurePluginRole(role);
        await d.grantPluginPrefix(role, tablePrefix(slug));
        provisioned.add(slug);
    } catch (e: any) {
        provisioned.delete(slug);
        console.warn(`[plugin-db-roles] could not provision role for '${slug}' (falling back to the SQL text-guard): ${e && e.message}`);
    }
}

/** Reconcile roles for every currently-active plugin at boot (existing installs get a role + grants). */
async function reconcile(slugs: string[]): Promise<void> {
    if (!enabled() || !pgDriver()) return;
    for (const slug of slugs) { await provision(slug); }
}

/** Drop a plugin's role on uninstall (best-effort; its tables are dropped separately). */
async function deprovision(slug: string): Promise<void> {
    const d = pgDriver();
    provisioned.delete(slug);
    if (!d) return;
    try { await d.dropPluginRole(roleName(slug)); }
    catch (e: any) { console.warn(`[plugin-db-roles] drop role for '${slug}' failed: ${e && e.message}`); }
}

/** GRANT a newly-created table to the plugin's role (called right after a plugin CREATE TABLE). */
async function grantNewTable(slug: string, table: string): Promise<void> {
    if (!provisioned.has(slug)) return;
    const d = pgDriver();
    if (!d) return;
    try { await d.grantPluginTable(roleName(slug), String(table).toLowerCase()); }
    catch (e: any) { console.warn(`[plugin-db-roles] grant new table '${table}' to '${slug}' failed: ${e && e.message}`); }
}

/**
 * Run a plugin's DML/SELECT under its role when provisioned; otherwise the normal (text-guard-only) path.
 * NOTE: DDL is NOT routed here — a NOLOGIN role has no CREATE, so the caller runs CREATE/ALTER/DROP as the
 * admin user (prefix-scoped by the text-guard) and then GRANTs the new table via grantNewTable().
 */
async function runScoped(slug: string, method: 'all' | 'get' | 'run', sql: string, params: any[]): Promise<any> {
    const { dbAsync } = require('../config/database');
    if (provisioned.has(slug)) {
        const d = pgDriver();
        if (d) return d.runAsRole(roleName(slug), method, sql, params);
    }
    return dbAsync[method](sql, params);
}

module.exports = {
    provision, reconcile, deprovision, grantNewTable, runScoped,
    roleName, tablePrefix, isProvisioned: (s: string) => provisioned.has(s),
};
