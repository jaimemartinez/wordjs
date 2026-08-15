/**
 * WordJS - Database Manager (ABSTRACTION LAYER)
 * Dynamically loads the configured driver (Legacy vs Native vs Postgres)
 */

const config = require('./app');
const path = require('path');

// 1. Load the Configured Driver
// 1. Driver State
// Canonical SQLite driver is 'sqlite-native' (better-sqlite3). 'sqlite-legacy' (sql.js / pure-JS
// WASM) is the automatic fallback when the native binary isn't available — it reads the same file.
let driverName = config.dbDriver || 'sqlite-native';
let driver: any = null;
let driverAsync: any = null; // New Async Driver

// Helper to load driver dynamically
async function loadDriver(overrideName: string | null = null) {
  const name = overrideName || config.dbDriver || 'sqlite-native';

  // Close the prior async driver before swapping it out, so re-init (tests/migrations)
  // doesn't leak the previous connection pool / file handle.
  if (driverAsync && typeof driverAsync.close === 'function') {
    try { await driverAsync.close(); } catch (e) { /* best-effort cleanup */ }
  }

  driverName = name; // Update global state

  try {
    console.log(`🔌 DB Manager: Loading driver '${name}'...`);
    driver = require(`../drivers/${name}`);
    driverAsync = null; // Reset

    // Try to load async version
    try {
      if (name === 'sqlite-native') {
        driverAsync = require('../drivers/sqlite-native-async');
        console.log(`🔌 DB Manager: Loaded Async Driver for '${name}'`);
      } else if (name === 'postgres') {
        driverAsync = require('../drivers/postgres');
        console.log(`🔌 DB Manager: Loaded Async Driver for '${name}'`);

        // Mock sync driver for Postgres
        driver = {
          init: async () => { },
          get: () => { throw new Error('Synchronous DB access not supported with Postgres. Use dbAsync.'); },
          close: () => { }
        };
      } else if (name === 'mysql' || name === 'mariadb') {
        driverAsync = require('../drivers/mysql');
        console.log(`🔌 DB Manager: Loaded Async Driver for '${name}'`);

        // Mock sync driver for MySQL (async-only, like Postgres).
        driver = {
          init: async () => { },
          get: () => { throw new Error('Synchronous DB access not supported with MySQL. Use dbAsync.'); },
          close: () => { }
        };
      }
    } catch (e) {
      console.warn(`⚠️  Async driver not found for '${name}': ${e.message}`);
    }

  } catch (e) {
    console.error(`❌ Failed to load driver '${name}':`, e.message);
    // SQLite is always recoverable: 'sqlite-native' (better-sqlite3) needs a native binary that may
    // be missing, while 'sqlite-legacy' (sql.js / pure-JS WASM) reads the SAME file format. Fall back
    // to it whenever ANY sqlite driver fails (even an explicit one) or on the default path. A failed
    // NON-sqlite override (e.g. an explicit 'postgres') is NOT silently downgraded to SQLite.
    const recoverable = (!overrideName || /^sqlite/.test(name)) && name !== 'sqlite-legacy';
    if (recoverable) {
      console.warn(`⚠️  DB Manager: '${name}' unavailable — falling back to pure-JS 'sqlite-legacy'.`);
      driver = require('../drivers/sqlite-legacy');
      driverName = 'sqlite-legacy';
      driverAsync = null;
    } else {
      throw e;
    }
  }
}

// Initial Load (Default). loadDriver is async to close any prior async driver before
// swapping; the very first load has none, so this resolves synchronously in practice.
loadDriver();

// 2. Abstraction Proxies
const init = async (options: any = {}) => {
  // Support dynamic driver switching (e.g. for Tests or Migrations)
  if (options.driver) {
    await loadDriver(options.driver);
  }

  // The 'postgres' driver connects to an EXTERNAL Postgres via the pg client (host/port/user/password
  // from wordjs-config.json). WordJS does NOT bundle or spawn a database server.

  // Initialize Sync Driver
  if (driver && driver.init) await driver.init(options);

  // Initialize Async Driver
  if (driverAsync) {
    await driverAsync.connect();
  }
};

const getDb = () => {
  return driver.get();
};

const getDbAsync = () => {
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
  console.log('🏗️  Verifying Database Schema...');

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
      console.warn(`⚠️  Could not create unique index (continuing): ${e && e.message}`);
    }
  }

  console.log('✅ Database Schema verified.');
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
    console.warn('[DB] Analytics table init skipped:', e.message);
  }
  await checkDbDivergence();
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
        console.warn('');
        console.warn('⚠️  ⚠️  DB DIVERGENCE DETECTED ⚠️  ⚠️');
        console.warn(`   Active driver '${driverName}' is using an EMPTY database (${activePath}),`);
        console.warn(`   but ${f} contains ${otherUsers} user(s) of real data.`);
        console.warn(`   You likely switched dbDriver without migrating. To move the data:  npm run migrate`);
        console.warn(`   (or restore the previous dbDriver/dbPath in backend/wordjs-config.json).`);
        console.warn('');
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

    // If prop is a function on the driver, wrap it with automatic normalization
    if (typeof db[prop] === 'function') {
      return async (...args: any[]) => {
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

  // SECURITY: the table name and column strings are concatenated into DDL and run via exec(), which
  // executes STACKED statements. An unvalidated column like 'id INT); INSERT INTO users (...) VALUES
  // (...); CREATE TABLE z (a' would create an admin user / rewrite options. Validate the identifier
  // and reject any statement-breaking or comment tokens BEFORE building the SQL.
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (typeof tableName !== 'string' || !IDENT_RE.test(tableName)) {
    throw new Error(`🛡️ createTable: invalid table name '${tableName}' (must be a simple identifier).`);
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('createTable: columns must be a non-empty array of definitions.');
  }
  const BAD_COL = /;|--|\/\*|\*\//; // no statement break, no SQL comments
  for (const col of columns) {
    if (typeof col !== 'string' || BAD_COL.test(col)) {
      throw new Error(`🛡️ createTable: invalid column definition (stacked statements / comments are not allowed).`);
    }
    const firstTok = col.trim().split(/\s+/)[0];
    if (!IDENT_RE.test(firstTok)) {
      throw new Error(`🛡️ createTable: invalid column name '${firstTok}' (must be a simple identifier).`);
    }
  }

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
  const mappedColumns = columns.map(col => {
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

  const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${mappedColumns.join(',\n  ')}\n)`;

  // Defense in depth: the assembled DDL must be a SINGLE statement (no stacked queries reached exec).
  if (sql.replace(/;\s*$/, '').includes(';')) {
    throw new Error('🛡️ createTable: refusing to run multiple statements.');
  }

  if (driverAsync) {
    await driverAsync.exec(sql);
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
  const targetDb = db || driverAsync || getDb();
  console.log('🧹 DB Manager: Clearing database content...');

  // Tables to clear (Order matters for foreign keys if enforced, though SQLite usually permissive)
  const tables = [
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
      // Ignore "no such table" errors if schema is broken
      if (!e.message.includes('no such table')) {
        console.warn(`⚠️ Failed to clear table ${table}: ${e.message}`);
      }
    }
  }
  console.log('✅ Database cleared.');
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
  createPluginTable,
  getDbType,
  db: dbProxy,
  dbAsync: dbAsyncProxy
};
