/**
 * WordJS - Database Manager (ABSTRACTION LAYER)
 * Dynamically loads the configured driver (Legacy vs Native vs Postgres)
 */

const config = require('./app');
const path = require('path');

// 1. Load the Configured Driver
// 1. Driver State
let driverName = config.dbDriver || 'sqlite-legacy';
let driver = null;
let driverAsync = null; // New Async Driver

// Helper to load driver dynamically
function loadDriver(overrideName = null) {
  const name = overrideName || config.dbDriver || 'sqlite-legacy';
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
      }
    } catch (e) {
      console.warn(`⚠️  Async driver not found for '${name}': ${e.message}`);
    }

  } catch (e) {
    console.error(`❌ Failed to load driver '${name}':`, e.message);
    // Only fallback if we weren't forcing a specific valid driver test
    if (!overrideName) {
      console.warn(`⚠️  Falling back to 'sqlite-legacy'`);
      driver = require('../drivers/sqlite-legacy');
      driverName = 'sqlite-legacy';
    } else {
      throw e;
    }
  }
}

// Initial Load (Default)
loadDriver();

// 2. Abstraction Proxies
const init = async (options = {}) => {
  // Support dynamic driver switching (e.g. for Tests or Migrations)
  if (options.driver) {
    loadDriver(options.driver);
  }

  // Auto-Start Embedded Core DB if configured
  if (driverName === 'postgres' && config.db.port == 5433) {
    try {
      const embedded = require('../core/embedded-db');
      await embedded.startServer();
    } catch (e) {
      console.warn('⚠️  Could not auto-start embedded postgres:', e.message);
    }
  }

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

const closeDatabase = () => {
  if (driver.close && typeof driver.close === 'function') {
    driver.close();
  }
  if (driverAsync) {
    driverAsync.close();
  }
}

// 3. Schema Management (Core Tables)
async function initializeSchema(db, isAsync = false) {
  console.log('🏗️  Verifying Database Schema...');

  // Helper to run exec
  const exec = async (sql) => {
    if (isAsync) await db.exec(sql);
    else db.exec(sql);
  };

  // Detect Dialect (Global config OR overridden by migration passing async driver)
  const isPostgres = driverName === 'postgres' || isAsync;
  const AUTO_INCREMENT = isPostgres ? 'SERIAL' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const INT_PK = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  // Postgres doesn't strictly use AUTOINCREMENT keyword in the same way, SERIAL implies INT + DEFAULT sequence

  // Note: standardizing DDL is hard. 
  // For PG: id SERIAL PRIMARY KEY
  // For SQLite: id INTEGER PRIMARY KEY AUTOINCREMENT

  const createTable = async (name, columns) => {
    let sql = `CREATE TABLE IF NOT EXISTS ${name} (\n`;
    sql += columns.map(c => `  ${c}`).join(',\n');
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
    "post_password TEXT NOT NULL DEFAULT ''",
    "post_name TEXT NOT NULL DEFAULT ''",
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
    "comment_count INTEGER NOT NULL DEFAULT 0"
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

  // Links table
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

  console.log('✅ Database Schema verified.');
}

async function initializeDatabase() {
  if (driverAsync) {
    await initializeSchema(driverAsync, true);
  } else {
    await initializeSchema(getDb(), false);
  }
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
      return async (...args) => {
        // Double check for write operations
        if (['run', 'exec', 'save'].includes(prop)) {
          verifyPermission('database', 'write');
        }

        // Automatically normalize SQL queries (first argument is SQL string)
        // This ensures ALL database operations use the same syntax globally
        if (args.length > 0 && typeof args[0] === 'string') {
          const sql = args[0];
          const params = args.slice(1);

          // For PostgreSQL: normalize placeholders ? -> $1, $2, etc.
          // For SQLite: pass SQL as-is (already uses ? placeholders)
          // The Postgres driver also normalizes internally, ensuring double safety
          let normalizedSql = sql;
          if (driverName === 'postgres') {
            let paramIndex = 1;
            normalizedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
          }

          // Execute with normalized SQL
          // Standard SQL (SELECT, INSERT, UPDATE, DELETE, JOIN, LIMIT, OFFSET)
          // works the same in both SQLite and PostgreSQL.
          // The only difference is placeholders, which we normalize automatically.
          return await db[prop].bind(db)(normalizedSql, ...params);
        }

        // Non-SQL operations (like close, connect, etc.) - pass through
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
async function createPluginTable(tableName, columns) {
  const isPostgres = driverName === 'postgres';

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
  return {
    isPostgres: driverName === 'postgres',
    isSQLite: driverName !== 'postgres',
    driver: driverName
  };
}

async function clearDatabase(db = null) {
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
          } catch (ignore) { }
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
