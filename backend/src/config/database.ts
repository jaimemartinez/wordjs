/**
 * WordJS - Database Manager (ABSTRACTION LAYER)
 * Dynamically loads the configured driver (Legacy vs Native vs Postgres)
 */

const config = require('./app');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const log = require('../core/module-logger').moduleLogger('config/database');

// 1. Load the Configured Driver
// 1. Driver State
// Canonical SQLite driver is 'sqlite-native' (better-sqlite3). 'sqlite-legacy' (sql.js / pure-JS
// WASM) is the automatic fallback when the native binary isn't available — it reads the same file.
let driverName = config.dbDriver || 'sqlite-native';
let driver: any = null;
let driverAsync: any = null; // New Async Driver

// THE FALLBACK, REMEMBERED.
//
// The downgrade below ('sqlite-native' unavailable ⇒ pure-JS 'sqlite-legacy') is not cosmetic: the
// legacy driver has NO FTS5, so migration 0008 declines to build posts_fts and site search silently
// drops from ranked full-text to LIKE matching (see core/schema-migrations.ts). Until now the only
// trace was one console.warn on a boot nobody reads, and every surface that answers "which driver?"
// answered from `config.dbDriver` — i.e. what the operator ASKED for — so the admin health panel
// confidently named 'sqlite-native' on the very host that was not running it.
//
// Kept as STATE rather than a log line so /health/details and the persistent admin notice can both
// read the one fact. Postgres and MySQL are never downgraded (an explicit non-sqlite driver that
// fails still throws), so this can only ever describe the sqlite pair.
type DriverDegradation = {
  driverRequested: string;
  driverActive: string;
  reason: string;
  at: string;
};
let driverDegradation: DriverDegradation | null = null;

/** The active downgrade, or null when the requested driver really is the one running. */
function getDriverDegradation(): DriverDegradation | null {
  return driverDegradation;
}

// One id per CONDITION (see core/admin-notices): a hundred restarts on a broken native binary leave
// one row on /admin/notices, and the first boot that loads the native driver retires it.
const DEGRADED_DRIVER_NOTICE_ID = 'db.sqlite-legacy-fallback';

// STRICT DRIVER MODE (config "dbStrictDriver" / env WORDJS_DB_STRICT, resolved in config/app.ts).
//
// The downgrade above keeps a site up, which is the right default for a self-hosted CMS whose usual
// way of losing better-sqlite3 is a Node.js upgrade. It is the wrong one for an operator who would
// rather not serve at all than serve with ranked search quietly gone — a fleet behind a health check, a
// CI image, a host provisioned by automation that nobody watches the admin panel of. Strict mode turns
// every fallback into a boot error that says what failed, what the fallback would have cost, and how to
// fix it. Read at call time (not captured at module load) so a test can flip it on the config object.
function isStrictDriverMode(): boolean {
  return config.dbStrictDriver === true;
}

/** The boot error strict mode raises where the manager would otherwise fall back to 'sqlite-legacy'. */
function strictDriverError(requested: string, cause: any): Error {
  const fix = requested === 'sqlite-native'
    ? 'restore the native driver: run `npm rebuild better-sqlite3` in backend/ (it is needed after a Node.js ' +
      'upgrade or an install made with --ignore-scripts), then restart'
    : `make the '${requested}' driver loadable (run \`npm ci\` in backend/ to restore its dependencies), then restart`;
  const err: any = new Error(
    `Strict database driver mode is on (WORDJS_DB_STRICT / "dbStrictDriver"), and the '${requested}' driver ` +
    `failed to load: ${(cause && cause.message) || cause}. Without strict mode WordJS would fall back to the ` +
    `pure-JS 'sqlite-legacy' driver, which has no FTS5: ranked full-text search would be disabled and site ` +
    `search would fall back to LIKE matching. To fix it, ${fix}. To accept the fallback instead, unset ` +
    `WORDJS_DB_STRICT and remove "dbStrictDriver" from backend/wordjs-config.json.`
  );
  err.code = 'WORDJS_DB_STRICT_DRIVER';
  err.cause = cause;
  return err;
}

// The failure of the most recent loadDriver(), kept because the boot-time load runs at module scope
// where nobody can await it: init() rethrows it, so a strict-mode refusal (or any other driver that
// cannot load) stops the boot at the point that opens the database, with the message above.
let driverLoadError: Error | null = null;

type TransactionQuery = {
  get: (...args: any[]) => Promise<any>;
  all: (...args: any[]) => Promise<any>;
  run: (...args: any[]) => Promise<any>;
  exec: (...args: any[]) => Promise<any>;
};

type TransactionScope = {
  query: TransactionQuery;
  // The site whose database this transaction is pinned to (null: site 1). A pinned connection is never
  // handed to work running for another site.
  siteId: number | null;
  afterCommit: Array<() => any | Promise<any>>;
  active: boolean;
  rollbackOnly?: any;
};

// One request may cross dozens of model helpers. Keeping the pinned transaction in async-local
// state means all dbAsync calls in that request use the SAME connection without threading a `tx`
// argument through every historical API. A nested dbAsync.transaction joins the current unit rather
// than issuing a second BEGIN (which SQLite cannot do and pooled drivers would pin independently).
const transactionScope: {
  getStore: () => TransactionScope | undefined;
  run: <T>(store: TransactionScope, callback: () => T) => T;
} = new AsyncLocalStorage();

function assertSameSite(scope: TransactionScope): void {
  if (scope.siteId !== routedSiteId()) {
    throw new Error('A database transaction of one site was used by work running for another site.');
  }
}

function hasActiveTransaction(): boolean {
  return transactionScope.getStore()?.active === true;
}

/** Queue an external effect for the instant after COMMIT. Returns false outside a transaction. */
function afterCommit(callback: () => any | Promise<any>): boolean {
  const scope = transactionScope.getStore();
  if (!scope?.active) return false;
  scope.afterCommit.push(callback);
  return true;
}

async function runTransaction<T>(fn: (tx: TransactionQuery) => Promise<T>): Promise<T> {
  const active = transactionScope.getStore();
  if (active?.active) {
    assertSameSite(active);
    try { return await fn(active.query); }
    catch (error) {
      // There are no cross-driver savepoints in the public contract. If a joined nested unit fails,
      // poison the outer transaction even when an intermediate caller catches the error; committing
      // the statements that ran before that failure would violate the all-or-nothing promise.
      if (!active.rollbackOnly) active.rollbackOnly = error;
      throw error;
    }
  }

  const current = getDbAsync();
  if (!current || typeof current.transaction !== 'function') {
    throw new Error('The active database driver does not implement transaction()');
  }

  let committedScope: TransactionScope | null = null;
  const result = await current.transaction(async (query: TransactionQuery) => {
    const scope: TransactionScope = { query, afterCommit: [], active: true, siteId: routedSiteId() };
    committedScope = scope;
    return await transactionScope.run(scope, async () => {
      try {
        const value = await fn(query);
        if (scope.rollbackOnly) throw scope.rollbackOnly;
        return value;
      } finally {
        // Async resources created inside this callback retain the store after run() returns. Mark it
        // closed so a detached timer/promise cannot reuse a released pooled connection later.
        scope.active = false;
      }
    });
  });

  // The database is already committed. External effects are deliberately best-effort here: a cache,
  // plugin or network failure cannot turn a successful durable mutation into a misleading 500. Core
  // content events use the durable outbox (not this volatile queue), so they remain retryable.
  const committedCallbacks = committedScope
    ? (committedScope as TransactionScope).afterCommit
    : [];
  for (const callback of committedCallbacks) {
    try { await callback(); }
    catch (error: any) {
      log.warn({ err: error }, '[database] after-commit effect failed (non-fatal)');
    }
  }
  return result;
}

/**
 * Why the native SQLite driver cannot open a database in this process, or null when it can.
 *
 * `require('better-sqlite3')` succeeds without the compiled binary: the package only opens it on the
 * first `new Database()`. The binary is put in place by the package's install script (a prebuilt
 * download, or a local compile), so `npm install --ignore-scripts` — or a Node.js upgrade after the
 * install — leaves a driver that loads and then fails at its first connection. The installer asks this
 * before it writes anything; a throwaway in-memory database touches no file.
 */
function nativeSqliteLoadError(): Error | null {
  try {
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (e: any) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// Helper to load driver dynamically
async function loadDriver(overrideName: string | null = null) {
  const name = overrideName || config.dbDriver || 'sqlite-native';

  // Close the prior async driver before swapping it out, so re-init (tests/migrations)
  // doesn't leak the previous connection pool / file handle.
  if (driverAsync && typeof driverAsync.close === 'function') {
    try { await driverAsync.close(); } catch (e) { /* best-effort cleanup */ }
  }

  driverName = name; // Update global state
  // Every load attempt starts from "not degraded", so a re-init that finally gets the native driver
  // (tests, migrations, or simply the next boot after `npm rebuild better-sqlite3`) clears the state
  // instead of inheriting a stale downgrade from the previous attempt.
  driverDegradation = null;
  driverLoadError = null;

  try {
    log.info(`🔌 DB Manager: Loading driver '${name}'...`);
    driver = require(`../drivers/${name}`);
    driverAsync = null; // Reset

    // Try to load async version
    try {
      if (name === 'sqlite-native') {
        driverAsync = require('../drivers/sqlite-native-async');
        log.info(`🔌 DB Manager: Loaded Async Driver for '${name}'`);
      } else if (name === 'postgres') {
        driverAsync = require('../drivers/postgres');
        log.info(`🔌 DB Manager: Loaded Async Driver for '${name}'`);

        // Mock sync driver for Postgres
        driver = {
          init: async () => { },
          get: () => { throw new Error('Synchronous DB access not supported with Postgres. Use dbAsync.'); },
          close: () => { }
        };
      } else if (name === 'mysql' || name === 'mariadb') {
        driverAsync = require('../drivers/mysql');
        log.info(`🔌 DB Manager: Loaded Async Driver for '${name}'`);

        // Mock sync driver for MySQL (async-only, like Postgres).
        driver = {
          init: async () => { },
          get: () => { throw new Error('Synchronous DB access not supported with MySQL. Use dbAsync.'); },
          close: () => { }
        };
      }
    } catch (e) {
      // For sqlite-native the ASYNC driver is the one that loads better-sqlite3 at module scope; the sync
      // driver above requires it lazily inside init(), so its require never fails and the outer catch —
      // the documented "native binary unavailable → pure-JS sqlite-legacy" fallback — was unreachable: a
      // host without a working binary got a warning here and then died later in init(). Rethrow for
      // exactly that case so the recoverable path below runs; other drivers keep the warn-only behaviour.
      if (name === 'sqlite-native') throw e;
      log.warn({ err: e }, `⚠️  Async driver not found for '${name}'`);
    }

  } catch (e) {
    log.error({ err: e }, `❌ Failed to load driver '${name}'`);
    // SQLite is always recoverable: 'sqlite-native' (better-sqlite3) needs a native binary that may
    // be missing, while 'sqlite-legacy' (sql.js / pure-JS WASM) reads the SAME file format. Fall back
    // to it whenever ANY sqlite driver fails (even an explicit one) or on the default path. A failed
    // NON-sqlite override (e.g. an explicit 'postgres') is NOT silently downgraded to SQLite.
    //
    // Strict mode (dbStrictDriver / WORDJS_DB_STRICT) refuses every such fallback with an explanatory
    // error instead — the operator opted out of running degraded.
    const recoverable = (!overrideName || /^sqlite/.test(name)) && name !== 'sqlite-legacy';
    if (recoverable && isStrictDriverMode()) {
      driver = null;
      driverAsync = null;
      driverLoadError = strictDriverError(name, e);
      log.error(`❌ DB Manager: ${driverLoadError.message}`);
      throw driverLoadError;
    }
    if (recoverable) {
      log.warn(`⚠️  DB Manager: '${name}' unavailable — falling back to pure-JS 'sqlite-legacy'.`);
      log.warn('⚠️  DB Manager: \'sqlite-legacy\' has no FTS5 — ranked full-text search is DISABLED and site search falls back to LIKE matching.');
      driver = require('../drivers/sqlite-legacy');
      driverName = 'sqlite-legacy';
      driverAsync = null;
      // Remembered, not just logged. Published as an admin notice + /health/details once the database
      // is up (reportDriverDegradation, called from initializeDatabase).
      driverDegradation = {
        driverRequested: name,
        driverActive: 'sqlite-legacy',
        reason: `'${name}' failed to load (${e.message}) — the pure-JS 'sqlite-legacy' driver has no FTS5, so ranked full-text search is unavailable and site search falls back to LIKE matching`,
        at: new Date().toISOString(),
      };
    } else {
      driverLoadError = e;
      throw e;
    }
  }
}

// Initial Load (Default). loadDriver is async to close any prior async driver before
// swapping; the very first load has none, so this resolves synchronously in practice.
// A failure is recorded in driverLoadError and raised by init(), not left as an unhandled rejection.
loadDriver().catch(() => { /* surfaced by init() */ });

// 2. Abstraction Proxies
const init = async (options: any = {}) => {
  // Support dynamic driver switching (e.g. for Tests or Migrations)
  if (options.driver) {
    await loadDriver(options.driver);
  }
  if (driverLoadError) throw driverLoadError;

  // The 'postgres' driver connects to an EXTERNAL Postgres via the pg client (host/port/user/password
  // from wordjs-config.json). WordJS does NOT bundle or spawn a database server.

  // Initialize Sync Driver
  if (driver && driver.init) await driver.init(options);

  // Initialize Async Driver
  if (driverAsync) {
    await driverAsync.connect();
  }
};

// MULTISITE: one database per site (documentation/multisite-design.md). Site 1 is the database above,
// unchanged. Every other site has its own database — a SQLite file, a Postgres schema or a MySQL
// database (core/site-storage) — opened once by openSiteDatabase (the HTTP layer and forEachSite await
// it before entering the site) and then returned by getDb/getDbAsync whenever the current work belongs
// to that site. Nothing else changes: every model, migration and plugin query keeps its literal table
// names, and simply runs against the current site's database. A site whose database is not open is an
// error, never a fall-through to site 1's.
const siteContext = require('../core/site-context');
const siteStorage = require('../core/site-storage');
const siteDrivers = new Map<number, any>();
const siteDriversOpening = new Map<number, Promise<any>>();

/** The site whose database the current work must use, or null for site 1 (and every single-site install). */
function routedSiteId(): number | null {
  if (!siteContext.multisiteEnabled()) return null;
  const id = siteContext.currentSiteId();
  return id === siteContext.PRIMARY_SITE_ID ? null : id;
}

function openSiteDriver(siteId: number): any {
  const d = siteDrivers.get(siteId);
  if (!d) throw new siteContext.SiteContextError('site_db_not_open', `The database of site ${siteId} is not open.`);
  return d;
}

/** The main site's driver, as the administrator of the engine (it creates and drops the namespaces). */
function adminDriver(): any {
  if (!driverAsync || !driverAsync.pool) throw new Error('The database is not connected.');
  return driverAsync;
}

// Namespace names come from core/site-storage (derived from a site id, [a-z0-9_] only); quoted anyway.
const qPg = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';
const qMy = (ident: string) => '`' + ident.replace(/`/g, '``') + '`';

/**
 * Make sure the Postgres schema / MySQL database `name` exists. Creating it needs CREATE on the
 * database (Postgres) or the CREATE privilege (MySQL); an operator who does not grant that may create it
 * beforehand, so a refused CREATE is accepted when the namespace is already there.
 */
async function ensureNamespace(engine: string, name: string): Promise<void> {
  const admin = adminDriver();
  if (engine === 'postgres') {
    try { await admin.pool.query(`CREATE SCHEMA IF NOT EXISTS ${qPg(name)}`); return; } catch (e: any) {
      const r = await admin.pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [name]);
      if (r.rows.length) return;
      throw new Error(`The Postgres schema "${name}" could not be created (${e && e.message}). Grant the WordJS user CREATE on the database, or create the schema for it.`);
    }
  }
  try { await admin.pool.query(`CREATE DATABASE IF NOT EXISTS ${qMy(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); return; } catch (e: any) {
    const [rows] = await admin.pool.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
    if (rows.length) return;
    throw new Error(`The MySQL database ${name} could not be created (${e && e.message}). Grant the WordJS user CREATE, or create the database for it.`);
  }
}

/**
 * A new, connected driver over the namespace `name` of the configured server: a pool pinned to a
 * Postgres schema, or a pool on a MySQL database. A site's pool is small (multisite.sitePoolMax,
 * default 4): a network keeps one per open site.
 */
async function connectNamespaceDriver(name: string, poolMax = 4): Promise<any> {
  const engine = siteStorage.storageEngine(driverName);
  await ensureNamespace(engine, name);
  const configured = Number(config.multisite && config.multisite.sitePoolMax);
  const max = Number.isSafeInteger(configured) && configured > 0 ? configured : poolMax;
  let d: any;
  if (engine === 'postgres') {
    const { PostgresDriver } = require('../drivers/postgres');
    d = new PostgresDriver();
    d.config = { ...config.db, schema: name, poolMax: max };
  } else {
    const { MysqlDriver } = require('../drivers/mysql');
    d = new MysqlDriver();
    d.config = { ...config.db, name, connectionLimit: max };
  }
  await d.connect();
  return d;
}

/** The Postgres schema / MySQL database of site `siteId`. */
function siteNamespace(siteId: number): string {
  const engine = siteStorage.storageEngine(driverName);
  if (engine === 'postgres') return siteStorage.sitePgSchema(siteId);
  if (engine === 'mysql') return siteStorage.siteMysqlDatabase(siteId);
  throw new Error(`No database namespace on '${driverName}'`);
}

/**
 * Open (once) the database of site `siteId`, bring its schema to the current version, and keep it for
 * the life of the process. `dbPath` locates a SQLite site's file; on Postgres and MySQL the site's
 * schema / database is derived from its id (core/site-storage). Concurrent callers share one opening.
 */
async function openSiteDatabase(siteId: number, dbPath: string | null): Promise<void> {
  if (!siteContext.isSiteId(siteId) || siteId === siteContext.PRIMARY_SITE_ID) throw new Error(`Not a secondary site id: ${siteId}`);
  if (siteDrivers.has(siteId)) return;
  const pending = siteDriversOpening.get(siteId);
  if (pending) { await pending; return; }
  const opening = (async () => {
    const problem = siteStorage.storageProblem(driverName);
    if (!driverAsync || problem) {
      throw new Error(`Multisite cannot run on the '${driverName}' database driver: ${problem || 'it is not connected'}.`);
    }
    let d: any;
    if (driverName === 'sqlite-native') {
      if (!dbPath) throw new Error(`No database file for site ${siteId}`);
      const fs = require('fs');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const Driver = driverAsync.constructor;
      d = new Driver();
      d.dbPath = path.resolve(dbPath);
      await d.connect();
    } else {
      d = await connectNamespaceDriver(siteNamespace(siteId));
    }
    try {
      await siteContext.runWithSite(siteId, async () => {
        await initializeSchema(d, true);
        await runSchemaMigrations(d, true, driverName);
        siteDrivers.set(siteId, d);
        await require('../models/Analytics').init();
        // Postgres/MySQL: the site's leases (its cron leader, its plugin operations) live in its own
        // database, so every node of a multi-node network coordinates that site's work there.
        await require('../core/dist-lock').ensureLockTable();
      });
    } catch (e) {
      siteDrivers.delete(siteId);
      try { await d.close(); } catch { /* best-effort */ }
      throw e;
    }
  })();
  siteDriversOpening.set(siteId, opening);
  try { await opening; } finally { siteDriversOpening.delete(siteId); }
}

function isSiteDatabaseOpen(siteId: number): boolean {
  return siteId === siteContext.PRIMARY_SITE_ID || siteDrivers.has(siteId);
}

/** Close one secondary site's database (a failed provisioning, a deleted site). */
async function closeSiteDatabase(siteId: number): Promise<void> {
  const d = siteDrivers.get(siteId);
  siteDrivers.delete(siteId);
  if (d) await d.close();
}

/**
 * Remove a deleted site's database for good: its Postgres schema (CASCADE: every table, sequence and
 * grant in it) or its MySQL database. A SQLite site's file goes with its directory (core/network-sites).
 * Never site 1's.
 */
async function dropSiteDatabase(siteId: number): Promise<void> {
  if (!siteContext.isSiteId(siteId) || siteId === siteContext.PRIMARY_SITE_ID) throw new Error(`Not a secondary site id: ${siteId}`);
  await closeSiteDatabase(siteId);
  const engine = siteStorage.storageEngine(driverName);
  if (engine === 'sqlite') return;
  const admin = adminDriver();
  if (engine === 'postgres') await admin.pool.query(`DROP SCHEMA IF EXISTS ${qPg(siteStorage.sitePgSchema(siteId))} CASCADE`);
  else await admin.pool.query(`DROP DATABASE IF EXISTS ${qMy(siteStorage.siteMysqlDatabase(siteId))}`);
}

/** Close every secondary site's database (shutdown, tests). Site 1's is closeDatabase's. */
async function closeSiteDatabases(): Promise<void> {
  const all = Array.from(siteDrivers.values());
  siteDrivers.clear();
  for (const d of all) {
    try { await d.close(); } catch { /* best-effort */ }
  }
}

/**
 * The network store's own connection on Postgres (schema wordjs_network) and MySQL (database
 * <db.name>_network): core/network's records live on the server every node shares, beside the sites and
 * never inside any site's database. Not used on SQLite, where network.db is a file of its own.
 */
async function openNetworkDatabase(): Promise<any> {
  const engine = siteStorage.storageEngine(driverName);
  if (engine === 'sqlite') throw new Error('On SQLite the network store is a file of its own.');
  const name = engine === 'postgres' ? siteStorage.NETWORK_PG_SCHEMA : siteStorage.networkMysqlDatabase();
  return connectNamespaceDriver(name, 2);
}

const getDb = () => {
  const sid = routedSiteId();
  if (sid !== null) {
    const d = openSiteDriver(sid);
    // Postgres and MySQL have no synchronous access on any site: the main driver's stub says so.
    if (driverName !== 'sqlite-native') return driver.get();
    return new (require('../drivers/sqlite-native').NativeWrapper)(d.db);
  }
  return driver.get();
};

const getDbAsync = () => {
  const sid = routedSiteId();
  if (sid !== null) return openSiteDriver(sid);
  if (driverAsync) return driverAsync;
  // Fallback for legacy sync drivers (sqlite-legacy)
  // Since we rely on await in the codebase, returning the sync DB object
  // works because await syncResult resolves to the result.
  if (driver) return driver.get();
  return null;
}

const saveDatabase = () => {
  if (driver.save && typeof driver.save === 'function') {
    driver.save();
  }
};

const closeDatabase = async () => {
  if (driver.close && typeof driver.close === 'function') {
    driver.close();
  }
  if (driverAsync) {
    await driverAsync.close();
  }
}

// 3. Schema Management (Core Tables)
async function initializeSchema(db: any, isAsync = false) {
  log.info('🏗️  Verifying Database Schema...');

  // Helper to run exec
  const exec = async (sql: string) => {
    if (isAsync) await db.exec(sql);
    else db.exec(sql);
  };

  // Detect Dialect (Global config OR overridden by migration passing async driver)
  const isPostgres = driverName === 'postgres';
  const AUTO_INCREMENT = isPostgres ? 'SERIAL' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const INT_PK = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  // Postgres doesn't strictly use AUTOINCREMENT keyword in the same way, SERIAL implies INT + DEFAULT sequence

  // Note: standardizing DDL is hard. 
  // For PG: id SERIAL PRIMARY KEY
  // For SQLite: id INTEGER PRIMARY KEY AUTOINCREMENT

  const createTable = async (name: string, columns: string[]) => {
    let sql = `CREATE TABLE IF NOT EXISTS ${name} (\n`;
    sql += columns.map((c: string) => `  ${c}`).join(',\n');
    sql += '\n)';
    await exec(sql);
  };

  // Posts table (equivalent to wp_posts)
  // We use a cleaner variable approach to constructing schema

  await createTable('posts', [
    `id ${INT_PK}`,
    "author_id INTEGER NOT NULL DEFAULT 0",
    "post_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "post_date_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "post_content TEXT NOT NULL DEFAULT ''",
    "post_title TEXT NOT NULL DEFAULT ''",
    "post_excerpt TEXT NOT NULL DEFAULT ''",
    "post_status TEXT NOT NULL DEFAULT 'draft'",
    "comment_status TEXT NOT NULL DEFAULT 'open'",
    "ping_status TEXT NOT NULL DEFAULT 'open'",
    // post_password: DATA-BEARING, NOT ENFORCED. Populated by WXR import (core/wxr-import.ts) and
    // round-tripped by the Post model (models/Post.ts reads/writes it), so it holds real per-post
    // values and export/import fidelity depends on it. What is NOT implemented is WordPress's
    // password GATE — no public route challenges the visitor for this password before rendering a
    // protected post. Kept as an unenforced field (removing it would break import/model round-trip);
    // implementing the gate is a feature, not a schema fix.
    "post_password TEXT NOT NULL DEFAULT ''",
    "post_name TEXT NOT NULL DEFAULT ''",
    // to_ping / pinged: DEAD. These are WordPress's outbound pingback/trackback queues (URLs still to
    // ping, URLs already pinged). WordJS implements no pingback/trackback/XML-RPC sender — WXR import
    // even skips inbound pingback/trackback comments (core/wxr-import.ts). Nothing reads or writes
    // these columns; the Post model does not map them. Retained inert (harmless empty-string defaults)
    // rather than risk a cross-driver posts-table column drop; a dedicated migration could remove them.
    // NOTE: ping_status ABOVE is live (stored, exposed in settings, honored by the comment form).
    "to_ping TEXT NOT NULL DEFAULT ''",
    "pinged TEXT NOT NULL DEFAULT ''",
    "post_modified TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "post_modified_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "post_content_filtered TEXT NOT NULL DEFAULT ''",
    "post_parent INTEGER NOT NULL DEFAULT 0",
    "guid TEXT NOT NULL DEFAULT ''",
    "menu_order INTEGER NOT NULL DEFAULT 0",
    "post_type TEXT NOT NULL DEFAULT 'post'",
    "post_mime_type TEXT NOT NULL DEFAULT ''",
    "comment_count INTEGER NOT NULL DEFAULT 0",
    // MULTILINGUAL (opt-in, Polylang-adapted). Both NULLABLE — a monolingual site never sets either,
    // and every renderer treats NULL as "site default / not in a translation set" (zero behavior change).
    //   post_language     — the post's own content language as a canonical BCP-47 tag (e.g. 'en', 'pt-BR').
    //   translation_group — a uuid shared by a post and its translations in other languages; two posts
    //                       are translations of one another iff they carry the same non-NULL group.
    // Fresh installs get these here; EXISTING databases get them from migration 0011 (same shape).
    "post_language TEXT",
    "translation_group TEXT"
  ]);

  // Post meta table
  await createTable('post_meta', [
    `meta_id ${INT_PK}`,
    "post_id INTEGER NOT NULL DEFAULT 0",
    "meta_key TEXT DEFAULT NULL",
    "meta_value TEXT"
  ]);

  // Users table
  await createTable('users', [
    `id ${INT_PK}`,
    "user_login TEXT NOT NULL DEFAULT ''",
    "user_pass TEXT NOT NULL DEFAULT ''",
    "user_nicename TEXT NOT NULL DEFAULT ''",
    "user_email TEXT NOT NULL DEFAULT ''",
    "user_url TEXT NOT NULL DEFAULT ''",
    "user_registered TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "user_activation_key TEXT NOT NULL DEFAULT ''",
    "user_status INTEGER NOT NULL DEFAULT 0",
    "display_name TEXT NOT NULL DEFAULT ''"
  ]);

  // User meta table
  await createTable('user_meta', [
    `umeta_id ${INT_PK}`,
    "user_id INTEGER NOT NULL DEFAULT 0",
    "meta_key TEXT DEFAULT NULL",
    "meta_value TEXT"
  ]);

  // Comments table
  await createTable('comments', [
    `comment_id ${INT_PK}`,
    "comment_post_id INTEGER NOT NULL DEFAULT 0",
    "comment_author TEXT NOT NULL DEFAULT ''",
    "comment_author_email TEXT NOT NULL DEFAULT ''",
    "comment_author_url TEXT NOT NULL DEFAULT ''",
    "comment_author_ip TEXT NOT NULL DEFAULT ''",
    "comment_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "comment_date_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "comment_content TEXT NOT NULL",
    "comment_karma INTEGER NOT NULL DEFAULT 0",
    "comment_approved TEXT NOT NULL DEFAULT '1'",
    "comment_agent TEXT NOT NULL DEFAULT ''",
    "comment_type TEXT NOT NULL DEFAULT 'comment'",
    "comment_parent INTEGER NOT NULL DEFAULT 0",
    "user_id INTEGER NOT NULL DEFAULT 0"
  ]);

  // Comment meta table
  await createTable('comment_meta', [
    `meta_id ${INT_PK}`,
    "comment_id INTEGER NOT NULL DEFAULT 0",
    "meta_key TEXT DEFAULT NULL",
    "meta_value TEXT"
  ]);

  // Terms table
  await createTable('terms', [
    `term_id ${INT_PK}`,
    "name TEXT NOT NULL DEFAULT ''",
    "slug TEXT NOT NULL DEFAULT ''",
    "term_group INTEGER NOT NULL DEFAULT 0"
  ]);

  // Term taxonomy table
  await createTable('term_taxonomy', [
    `term_taxonomy_id ${INT_PK}`,
    "term_id INTEGER NOT NULL DEFAULT 0",
    "taxonomy TEXT NOT NULL DEFAULT ''",
    "description TEXT NOT NULL DEFAULT ''",
    "parent INTEGER NOT NULL DEFAULT 0",
    "count INTEGER NOT NULL DEFAULT 0"
  ]);

  // Term relationships table
  // Composite PK is standard SQL
  await createTable('term_relationships', [
    "object_id INTEGER NOT NULL DEFAULT 0",
    "term_taxonomy_id INTEGER NOT NULL DEFAULT 0",
    "term_order INTEGER NOT NULL DEFAULT 0",
    "PRIMARY KEY (object_id, term_taxonomy_id)"
  ]);

  // Options table
  await createTable('options', [
    `option_id ${INT_PK}`,
    "option_name TEXT NOT NULL DEFAULT ''",
    "option_value TEXT NOT NULL DEFAULT ''",
    "autoload TEXT NOT NULL DEFAULT 'yes'"
  ]);

  // Links table — DEAD SCHEMA (no model, no router, no writer anywhere in WordJS).
  // This is WordPress's legacy "blogroll" (wp_links). WordJS ships no link-manager UI, API, or
  // model; the only other reference is clearDatabase() below, which truncates it for completeness.
  // It is created empty on every install and never populated. Retained rather than dropped because
  // removing a table cleanly across all four drivers (SQLite/Postgres/MySQL) is a migration change
  // with its own risk surface, and the audit guidance prefers documenting an inert table over a
  // risky drop. Safe to delete in a dedicated migration (DROP TABLE IF EXISTS links) if the blogroll
  // is confirmed out of scope for good — remove this createTable AND the 'links' entry in clearDatabase().
  await createTable('links', [
    `link_id ${INT_PK}`,
    "link_url TEXT NOT NULL DEFAULT ''",
    "link_name TEXT NOT NULL DEFAULT ''",
    "link_image TEXT NOT NULL DEFAULT ''",
    "link_target TEXT NOT NULL DEFAULT ''",
    "link_description TEXT NOT NULL DEFAULT ''",
    "link_visible TEXT NOT NULL DEFAULT 'Y'",
    "link_owner INTEGER NOT NULL DEFAULT 1",
    "link_rating INTEGER NOT NULL DEFAULT 0",
    "link_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "link_rel TEXT NOT NULL DEFAULT ''",
    "link_notes TEXT NOT NULL DEFAULT ''",
    "link_rss TEXT NOT NULL DEFAULT ''"
  ]);

  // Notifications table
  await createTable('notifications', [
    `id ${INT_PK}`,
    "uuid TEXT NOT NULL UNIQUE",
    "user_id INTEGER NOT NULL DEFAULT 0",
    "type TEXT NOT NULL",
    "title TEXT NOT NULL",
    "message TEXT NOT NULL",
    "data TEXT",
    "is_read INTEGER NOT NULL DEFAULT 0",
    "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "read_at TEXT",
    "icon TEXT",
    "color TEXT",
    "action_url TEXT"
  ]);

  // Postgres doesn't need these manual ALTERS if table is created fresh
  // and for SQLite we already have them in the createTable call above.

  // Performance indexes for hot lookup columns.
  // CREATE INDEX IF NOT EXISTS is supported by both SQLite and Postgres.
  // Column names verified against the CREATE TABLE statements above and the
  // queries in the Post/User/options models.
  const indexes = [
    // post_meta: getAllMeta() filters by post_id; getMeta/updateMeta by (post_id, meta_key)
    'CREATE INDEX IF NOT EXISTS idx_post_meta_post_id ON post_meta (post_id)',
    'CREATE INDEX IF NOT EXISTS idx_post_meta_post_id_key ON post_meta (post_id, meta_key)',
    // user_meta: loadMeta() by user_id; getMeta/updateMeta by (user_id, meta_key)
    'CREATE INDEX IF NOT EXISTS idx_user_meta_user_id ON user_meta (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_user_meta_user_id_key ON user_meta (user_id, meta_key)',
    // term_relationships: lookups by object_id and by term_taxonomy_id
    'CREATE INDEX IF NOT EXISTS idx_term_rel_object_id ON term_relationships (object_id)',
    'CREATE INDEX IF NOT EXISTS idx_term_rel_tt_id ON term_relationships (term_taxonomy_id)',
    // term_taxonomy: filtered by taxonomy in getTerms/setTerms/updateTermCounts, and joined by
    // (term_id, taxonomy) when resolving a term's taxonomy row
    'CREATE INDEX IF NOT EXISTS idx_term_taxonomy_taxonomy ON term_taxonomy (taxonomy)',
    'CREATE INDEX IF NOT EXISTS idx_term_taxonomy_term_tax ON term_taxonomy (term_id, taxonomy)',
    // terms: slug lookups (category/tag archives) were full table scans
    'CREATE INDEX IF NOT EXISTS idx_terms_slug ON terms (slug)',
    // posts: findAll filters by (post_status, post_type); findBySlug/generateUniqueSlug by post_name; children by post_parent
    'CREATE INDEX IF NOT EXISTS idx_posts_status_type ON posts (post_status, post_type)',
    'CREATE INDEX IF NOT EXISTS idx_posts_name ON posts (post_name)',
    'CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts (post_parent)',
    // the hottest public listing: WHERE post_type/post_status ORDER BY post_date — without the
    // date column the sort happens on a temp b-tree for every page view
    'CREATE INDEX IF NOT EXISTS idx_posts_type_status_date ON posts (post_type, post_status, post_date)',
    // author archives / dashboards filter by author_id
    'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id)',
    // meta lookups BY KEY across posts (featured images, plugin queries): key-first ordering
    'CREATE INDEX IF NOT EXISTS idx_post_meta_key_post ON post_meta (meta_key, post_id)',
    // comments: typical lookup by (comment_post_id, comment_approved)
    'CREATE INDEX IF NOT EXISTS idx_comments_post_approved ON comments (comment_post_id, comment_approved)',
    // options: getOption/updateOption/addOption/deleteOption lookup by option_name; getAutoloadedOptions by autoload
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_options_name ON options (option_name)',
    'CREATE INDEX IF NOT EXISTS idx_options_autoload ON options (autoload)',
    // notifications: per-user listing filtered by is_read and ordered by created_at
    'CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications (user_id, is_read, created_at)'
  ];

  for (const idx of indexes) {
    await exec(idx);
  }

  // UNIQUE constraints — close the TOCTOU window where a check-then-insert race (or two concurrent
  // requests) can create duplicate logins/emails/slugs. These match the existing app lookups:
  //   - user_login: case-SENSITIVE (User.findByLogin uses exact match) → plain unique index.
  //   - user_email: case-INSENSITIVE. The PRIMARY canonicalization is app-layer: User.create/update
  //     store a full-Unicode-lowercased (NFC) email via normalizeEmail(), and findByEmail compares the
  //     same canonical form. This LOWER(user_email) expression index is a backstop that also folds any
  //     legacy ASCII mixed-case rows. (SQLite LOWER() is ASCII-only, so it CANNOT be the sole defense:
  //     'Ä@x'/'ä@x' would slip past it — hence the app-layer fold.) Supported by SQLite ≥3.9 + Postgres.
  //   - posts(post_name, post_type): PARTIAL on post_name <> '' — many drafts/auto-drafts legitimately
  //     carry an empty post_name, so we only enforce uniqueness for real slugs (Post.create always
  //     fills post_name via generateUniqueSlug). Partial unique indexes work on both engines.
  // On FRESH installs these always succeed (no data yet). Existing installs get them via
  // schema-migrations (which dedupes/defensively guards first).
  const uniqueIndexes = [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users (user_login)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(user_email))',
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_name_type ON posts (post_name, post_type) WHERE post_name <> ''"
  ];
  for (const idx of uniqueIndexes) {
    try {
      await exec(idx);
    } catch (e: any) {
      // Should not happen on a fresh schema, but never let a unique-index hiccup abort boot — the
      // schema-migration path will retry/dedupe on existing data. Log loudly so it's visible.
      log.warn({ err: e }, '⚠️  Could not create unique index (continuing)');
    }
  }

  log.info('✅ Database Schema verified.');
}

const { runSchemaMigrations } = require('../core/schema-migrations');

async function initializeDatabase() {
  if (driverAsync) {
    await initializeSchema(driverAsync, true);
    await runSchemaMigrations(driverAsync, true, driverName);
  } else {
    await initializeSchema(getDb(), false);
    await runSchemaMigrations(getDb(), false, driverName);
  }
  // The analytics table is defined on the Analytics model (kept out of the core schema to avoid a
  // boot race). Create it here so it exists after a FRESH INSTALL too — the install wizard's setup
  // flow calls initializeDatabase() but never the app's initialize() (where Analytics.init() also
  // runs), so without this a fresh deploy hits "no such table: wordjs_analytics" on every request.
  try {
    await require('../models/Analytics').init();
  } catch (e) {
    log.warn({ err: e }, '[DB] Analytics table init skipped');
  }
  await checkDbDivergence();
  // The options table exists from here on, so this is the first moment a persistent notice can be
  // written — for this degradation and for anything raised earlier (an isolated plugin can launch
  // before the schema is up). index.ts is not involved: the manager publishes its own state.
  await reportDriverDegradation();
}

/**
 * Publish — or RETIRE — the persistent admin notice for a silent driver downgrade.
 *
 * The argument exists so the state and its publication can be exercised independently (there is no
 * way to make better-sqlite3 vanish mid-suite); production calls it with no arguments.
 *
 * BEST-EFFORT BY CONSTRUCTION: a notice that cannot be stored must never take the boot down with it.
 */
async function reportDriverDegradation(degradation: DriverDegradation | null = driverDegradation): Promise<void> {
  try {
    const { pushAdminNotice, clearAdminNotice, flushPendingAdminNotices } = require('../core/admin-notices');
    if (degradation) {
      await pushAdminNotice({
        id: DEGRADED_DRIVER_NOTICE_ID,
        level: 'error',
        title: 'Ranked search is disabled:',
        message:
          `this site is running on the pure-JS '${degradation.driverActive}' database driver because ` +
          `'${degradation.driverRequested}' could not be loaded, and that driver has no full-text index — ` +
          'site search is matching with LIKE instead of ranking results. To fix it, restore the native ' +
          'driver (npm rebuild better-sqlite3 in backend/, then restart) or set "dbDriver" explicitly in ' +
          'backend/wordjs-config.json. Both SQLite drivers read a database file of their own, so switch ' +
          'with npm run migrate rather than by editing the config alone.',
        since: Date.parse(degradation.at) || Date.now(),
      });
    } else {
      // A boot on the requested driver retires the notice. Without this the panel would go on
      // demanding a fix that has already been made, and an operator learns to ignore the panel.
      await clearAdminNotice(DEGRADED_DRIVER_NOTICE_ID);
    }
    await flushPendingAdminNotices();
  } catch (e: any) {
    log.warn({ err: e }, '[DB] the driver-degradation notice could not be recorded');
  }
}

// Boot guard for the per-driver-file footgun: each SQLite driver keeps its OWN data file
// (sqlite-native → data/wordjs-native.db, sqlite-legacy → data/wordjs.db) and switching drivers is
// meant to go through `npm run migrate`, which copies the data across. If dbDriver is flipped in the
// config WITHOUT migrating, the new driver opens a FRESH (empty) file and the data looks lost — it's
// actually safe in the other file. Detect that and shout, instead of silently serving an empty DB.
async function checkDbDivergence() {
  try {
    if (!/^sqlite/.test(driverName)) return; // only SQLite has the dual-file shape
    const fs = require('fs');
    const dbi = driverAsync || getDb();
    let activeUsers = 0;
    try {
      const r = await dbi.get('SELECT COUNT(*) AS c FROM users');
      activeUsers = Number(r && (r.c ?? r.C)) || 0;
    } catch { /* users table may not exist yet — treat as empty */ }
    if (activeUsers > 0) return; // active DB has data — all good

    const activePath = path.resolve(config.dbPath || './data/wordjs.db');
    const candidates = ['./data/wordjs.db', './data/wordjs-native.db']
      .map((p) => path.resolve(p))
      .filter((p) => p !== activePath);
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      let otherUsers = 0;
      try {
        const Database = require('better-sqlite3');
        const other = new Database(f, { readonly: true, fileMustExist: true });
        try { otherUsers = Number(other.prepare('SELECT COUNT(*) AS c FROM users').get().c) || 0; } catch { /* no users table */ }
        other.close();
      } catch { /* better-sqlite3 unavailable — best-effort skip */ }
      if (otherUsers > 0) {
        log.warn('⚠️  ⚠️  DB DIVERGENCE DETECTED ⚠️  ⚠️');
        log.warn(`   Active driver '${driverName}' is using an EMPTY database (${activePath}),`);
        log.warn({ otherUsers }, `   but ${f} contains ${otherUsers} user(s) of real data.`);
        log.warn('   You likely switched dbDriver without migrating. To move the data:  npm run migrate');
        log.warn('   (or restore the previous dbDriver/dbPath in backend/wordjs-config.json).');
        return;
      }
    }
  } catch { /* guard must never break boot */ }
}

// 3. Permission Enforcement
const { verifyPermission } = require('../core/plugin-context');

// Create a proxy that returns getDb() when accessed (SYNC)
const dbProxy = new Proxy({}, {
  get(target, prop) {
    verifyPermission('database', 'write'); // Sync calls usually imply writes or critical reads
    const db = getDb();
    return db[prop].bind(db);
  }
});

/**
 * GLOBAL DATABASE SYNTAX UNIFICATION
 * 
 * PRINCIPIO: Los plugins escriben SIEMPRE sintaxis SQLite estándar para TODAS las operaciones.
 * El core normaliza automáticamente para PostgreSQL cuando es necesario.
 * 
 * Sintaxis unificada para plugins:
 * - Placeholders: ? (nunca $1, $2)
 * - Tipos en CREATE TABLE: INT_PK, DATETIME, TEXT, REAL, INT
 * - SQL estándar: SELECT, INSERT, UPDATE, DELETE, JOIN, LIMIT, OFFSET (funciona igual)
 * 
 * Esto aplica a TODAS las operaciones: get(), all(), run(), exec()
 */
const dbAsyncProxy = new Proxy({}, {
  get(target, prop) {
    // Only verify on top-level access, not every property
    verifyPermission('database', 'read');

    const db = getDbAsync();
    if (!db) throw new Error('Async Database not initialized');

    if (prop === 'transaction') {
      return async (fn: (tx: TransactionQuery) => Promise<any>) => {
        verifyPermission('database', 'write');
        return await runTransaction(fn);
      };
    }

    const scoped = transactionScope.getStore();
    if (scoped?.active && ['get', 'all', 'run', 'exec'].includes(prop as string)) {
      assertSameSite(scoped);
      const method = scoped.query[prop as keyof TransactionQuery];
      return async (...args: any[]) => {
        if (['run', 'exec'].includes(prop as string)) verifyPermission('database', 'write');
        return await method(...args);
      };
    }

    // If prop is a function on the driver, wrap it with automatic normalization
    if (typeof db[prop] === 'function') {
      return async (...args: any[]) => {
        // Both SQLite implementations expose one connection. A query from another async context must
        // wait for every queued transaction, otherwise it could be committed or rolled back as if it
        // belonged to that unrelated request. Transaction-owned calls took the scoped branch above.
        if (['get', 'all', 'run', 'exec'].includes(prop as string) && typeof db.waitForTransaction === 'function') {
          await db.waitForTransaction();
        }
        // Double check for write operations. transaction() wraps writes, so it requires write
        // permission too (the tx.run/tx.exec calls inside go straight to the pinned connection and
        // are not re-checked through this proxy — the transaction-level check covers them).
        if (['run', 'exec', 'save', 'transaction'].includes(prop as string)) {
          verifyPermission('database', 'write');
        }

        // Placeholder normalization (? -> $1, $2 for Postgres) is handled by the
        // Postgres driver's normalizeSql (single source of truth). The proxy passes
        // SQL through untouched so SQLite-style placeholders work everywhere and we
        // never double-normalize. Standard SQL (SELECT/INSERT/UPDATE/DELETE/JOIN/
        // LIMIT/OFFSET) works the same in both SQLite and PostgreSQL.
        // Covers both SQL and non-SQL operations (close, connect, etc.) — the
        // proxy passes every method through untouched after the permission check.
        return await db[prop].bind(db)(...args);
      }
    }
    return db[prop];
  }
});

/**
 * Plugin Schema Helper - Create tables with automatic driver compatibility
 * Plugins should use this instead of raw CREATE TABLE statements
 * 
 * @param {string} tableName - Name of the table to create
 * @param {Array<string>} columns - Array of column definitions using SQLite syntax
 * @returns {Promise<void>}
 * 
 * @example
 * await createPluginTable('my_table', [
 *   'id INT_PK',
 *   'name TEXT NOT NULL',
 *   'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
 * ]);
 */
async function createPluginTable(tableName: string, columns: string[]) {
  const isPostgres = driverName === 'postgres';

  // SECURITY (js/sql-injection, CodeQL #579 — source: the import bundle at POST /api/v1/import,
  // routes/export.ts:71 → core/import-export custom_tables → here; also every untrusted plugin via
  // plugin-api db.createTable). The table name and column strings are concatenated into DDL and run
  // via exec(), which executes STACKED statements.
  //
  // This used to be a DENYLIST on the column text (`/;|--|\/\*|\*\//`) plus an identifier test on a
  // DERIVED COPY (`col.trim().split(/\s+/)[0]`), after which the ORIGINAL `col` was interpolated —
  // both halves of the failure mode this project keeps re-shipping: infer safety from the ABSENCE of
  // a token, and validate a copy while concatenating the raw value. Replaced by core/safe-sql, which
  // allowlists the FORM and REBUILDS the identifier / definition from a constant alphabet, so the
  // string that reaches the SQL is by construction a member of the allowed language. See safe-sql.ts.
  const { assertPlainIdent, assertColumnDefinition, buildCreateTable } = require('../core/safe-sql');

  // The CANONICAL name — the raw `tableName` is never concatenated anywhere below.
  const table: string = assertPlainIdent(tableName, 'createTable: table name');
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('🛡️ createTable: columns must be a non-empty array of definitions.');
  }
  // Gate 1: the caller's definitions, canonicalized. The alias mapping below only ever runs on these.
  const safeColumns = columns.map((col) => assertColumnDefinition(col, 'createTable'));

  // Type mappings for compatibility
  const typeMap = {
    'INT_PK': isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT',
    'INT': 'INTEGER',
    'TEXT': 'TEXT',
    'REAL': 'REAL',
    'DATETIME': isPostgres ? 'TIMESTAMP' : 'DATETIME',
    'TIMESTAMP': isPostgres ? 'TIMESTAMP' : 'DATETIME',
  };

  // Replace type aliases with driver-specific syntax
  const mappedColumns = safeColumns.map((col: string) => {
    let mapped = col;
    // Replace INT_PK
    mapped = mapped.replace(/\bINT_PK\b/g, typeMap.INT_PK);
    // Replace other types (more careful replacement to avoid partial matches)
    for (const [alias, replacement] of Object.entries(typeMap)) {
      if (alias !== 'INT_PK') {
        // Use word boundaries to avoid replacing parts of words
        const regex = new RegExp(`\\b${alias}\\b`, 'g');
        mapped = mapped.replace(regex, replacement);
      }
    }
    return mapped;
  });

  // Gate 2: the DDL is ASSEMBLED by safe-sql from re-validated parts (the alias expansion above
  // inserts only constant text, and this proves it). buildCreateTable also refuses a `;` anywhere in
  // the assembled statement, so nothing stacked can reach exec().
  const sql = buildCreateTable(table, mappedColumns);

  // The CURRENT site's database (getDbAsync), never site 1's driver directly: on a network a plugin's
  // table belongs in the database of the site whose worker created it.
  if (driverAsync) {
    await getDbAsync().exec(sql);
  } else {
    const db = getDb();
    db.exec(sql);
  }
}

/**
 * Get database type information for plugins
 * Useful for conditional logic if needed
 */
function getDbType() {
  const isPostgres = driverName === 'postgres';
  const isMySQL = driverName === 'mysql' || driverName === 'mariadb';
  return {
    isPostgres,
    isMySQL,
    // isSQLite stays true for MySQL so the many binary `isPostgres ? pg : sqlite` branches keep taking
    // the SQLite path (the MySQL driver translates that dialect at the boundary). The few genuinely
    // SQLite-ONLY catalog queries (sqlite_master / PRAGMA) are branched on isMySQL explicitly.
    isSQLite: !isPostgres,
    driver: driverName
  };
}

async function clearDatabase(db: any = null) {
  // The current site's database (a restore on a site of a network clears that site, never site 1).
  const targetDb = db || (driverAsync ? getDbAsync() : getDb());
  log.info('🧹 DB Manager: Clearing database content...');

  // Tables to clear (Order matters for foreign keys if enforced, though SQLite usually permissive)
  const tables = [
    // Never let an event or an already-fanned-out webhook from the pre-clear database replay against
    // newly imported ids. These two deletes are fail-closed below because continuing would emit an
    // externally visible action for content that no longer exists.
    'webhook_deliveries', 'content_outbox',
    'term_relationships', 'term_taxonomy', 'terms',
    'comment_meta', 'comments',
    'post_meta', 'posts',
    'user_meta', 'users',
    'options', 'links', 'notifications'
  ];

  for (const table of tables) {
    // Determine deletion syntax
    const sql = driverName === 'postgres'
      ? `TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`
      : `DELETE FROM ${table}`;

    try {
      if (driverAsync || (db && db.run)) {
        await targetDb.run(sql);
        // Reset sequence for SQLite
        if (driverName !== 'postgres') {
          try {
            await targetDb.run(`DELETE FROM sqlite_sequence WHERE name='${table}'`);
          } catch (seqErr) {
            // sqlite_sequence only exists once an AUTOINCREMENT table has rows; ignore its
            // absence, but surface real failures (e.g. a locked DB) instead of swallowing them.
            if (!seqErr.message || !seqErr.message.includes('no such table')) throw seqErr;
          }
        }
      } else {
        targetDb.exec(sql); // Sync legacy
      }
    } catch (e) {
      const message = String(e?.message || e || 'unknown database clear failure');
      const missing = /no such table|does not exist|doesn't exist|undefined table/i.test(message);
      if (missing) continue;
      if (table === 'content_outbox' || table === 'webhook_deliveries') {
        throw new Error(`Refusing to clear content while stale external work remains in ${table}: ${message}`, { cause: e });
      }
      log.warn({ table }, `⚠️ Failed to clear table ${table}: ${message}`);
    }
  }
  log.info('✅ Database cleared.');
}

module.exports = {
  init,
  getDb,
  getDbAsync,
  initializeDatabase,
  initializeSchema,
  saveDatabase,
  closeDatabase,
  clearDatabase, // Exposed
  // Multisite: the per-site databases (see openSiteDatabase above).
  openSiteDatabase,
  isSiteDatabaseOpen,
  closeSiteDatabase,
  closeSiteDatabases,
  dropSiteDatabase,
  openNetworkDatabase,
  createPluginTable,
  getDbType,
  // The silent-downgrade state and its publisher (see DriverDegradation above). routes/health.ts
  // reads the getter so /health/details reports the ACTIVE driver, not the configured one.
  getDriverDegradation,
  reportDriverDegradation,
  isStrictDriverMode,
  strictDriverError,
  nativeSqliteLoadError,
  hasActiveTransaction,
  afterCommit,
  db: dbProxy,
  dbAsync: dbAsyncProxy
};
