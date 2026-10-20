/**
 * WordJS — where each site of a network keeps its database, per engine (multisite).
 *
 * One rule on every engine: a site's tables live in a namespace of their own, opened through a
 * connection that can name nothing else unqualified, so core models, migrations and plugin SQL keep
 * their literal table names (documentation/multisite-design.md, "Tenancy model").
 *
 *   engine          main site (site 1)            site N                          network store
 *   sqlite-native   config.dbPath                 <data dir>/sites/N/wordjs-native.db   <data dir>/network.db
 *   postgres        config.db.name, its default   schema  wordjs_site_N           schema  wordjs_network
 *                   schema (public)               (same database)                 (same database)
 *   mysql/mariadb   config.db.name                database <db.name>_site_N       database <db.name>_network
 *
 * WHY A SCHEMA ON POSTGRES. A Postgres schema is a real namespace with its own privileges, and a pool
 * whose connections start with `search_path=<schema>` resolves every unqualified name there and only
 * there. It keeps one database (one set of credentials, one backup target, one connection limit to
 * plan) and needs only CREATE on that database, which the owner of a WordJS database already has —
 * where a database per site would need CREATEDB, which managed Postgres plans often withhold.
 *
 * WHY A DATABASE ON MYSQL. In MySQL a "database" IS the schema: `CREATE DATABASE` is the exact
 * equivalent of Postgres's `CREATE SCHEMA`, and a pool opened on it gets the same property (unqualified
 * names resolve there; `DATABASE()` — which the driver's introspection and its plugin grants already
 * key on — names it). A table prefix (`wp_2_posts`) was the alternative and is rejected: it would need
 * every core statement, the plugin validator and the plugin principals' `wjp_<slug>_%` grants rewritten,
 * and a forgotten prefix would hit the main site's tables (multisite-design.md, "Alternatives").
 *
 * The names are derived from the site id, never stored or taken from input. Site ids are never reused
 * (core/network keeps a high-water mark), so a namespace left behind by a failed deletion can never be
 * handed to a new site.
 */
const config = require('../config/app');

export type StorageEngine = 'sqlite' | 'postgres' | 'mysql';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
/** Postgres identifiers are cut at 63 bytes and MySQL database names at 64: refuse rather than truncate. */
const MAX_PG_IDENT = 63;
const MAX_MYSQL_DB = 64;

export const NETWORK_PG_SCHEMA = 'wordjs_network';

/** The engine family of a driver name (the configured one by default). */
export function storageEngine(driver: string = (config as any).dbDriver || 'sqlite-native'): StorageEngine {
    if (driver === 'postgres') return 'postgres';
    if (driver === 'mysql' || driver === 'mariadb') return 'mysql';
    return 'sqlite';
}

function siteNumber(id: number): number {
    if (!Number.isSafeInteger(id) || id < 2) throw new Error(`Not a secondary site id: ${String(id)}`);
    return id;
}

/** The Postgres schema of site `id` (> 1). */
export function sitePgSchema(id: number): string {
    return `wordjs_site_${siteNumber(id)}`;
}

/** The configured MySQL database name, validated as a plain identifier the site names can extend. */
function mysqlBaseName(): string {
    const name = String(((config as any).db && (config as any).db.name) || '');
    if (!IDENT_RE.test(name)) {
        throw new Error(`Multisite on MySQL needs a database name made of lower-case letters, digits and underscores (this install uses ${JSON.stringify(name)}).`);
    }
    return name;
}

function checkedMysqlName(name: string): string {
    if (name.length > MAX_MYSQL_DB) throw new Error(`The MySQL database name ${name} is longer than ${MAX_MYSQL_DB} characters; use a shorter db.name.`);
    return name;
}

/** The MySQL database of site `id` (> 1). */
export function siteMysqlDatabase(id: number): string {
    return checkedMysqlName(`${mysqlBaseName()}_site_${siteNumber(id)}`);
}

/** The MySQL database of the network store. */
export function networkMysqlDatabase(): string {
    return checkedMysqlName(`${mysqlBaseName()}_network`);
}

/** Why this install cannot hold a network on its engine, or null when it can. */
export function storageProblem(driver?: string): string | null {
    const engine = storageEngine(driver);
    try {
        if (engine === 'mysql') { networkMysqlDatabase(); siteMysqlDatabase(999999); }
        if (engine === 'postgres' && sitePgSchema(999999).length > MAX_PG_IDENT) return 'schema name too long';
    } catch (e: any) {
        return e && e.message ? e.message : String(e);
    }
    const name = driver || (config as any).dbDriver || 'sqlite-native';
    if (engine === 'sqlite' && name !== 'sqlite-native') {
        return `multisite needs the sqlite-native, postgres or mysql database driver (this install uses '${name}')`;
    }
    return null;
}

/** A human description of where site `id` keeps its database (status output, the network screen). */
export function describeSiteStorage(id: number, sqlitePath: string | null): string {
    const engine = storageEngine();
    if (id === 1) return engine === 'sqlite' ? String((config as any).dbPath) : `${engine} database ${String((config as any).db && (config as any).db.name)}`;
    if (engine === 'postgres') return `postgres schema ${sitePgSchema(id)}`;
    if (engine === 'mysql') return `mysql database ${siteMysqlDatabase(id)}`;
    return String(sqlitePath || '');
}

module.exports = {
    NETWORK_PG_SCHEMA,
    storageEngine,
    sitePgSchema,
    siteMysqlDatabase,
    networkMysqlDatabase,
    storageProblem,
    describeSiteStorage,
};
