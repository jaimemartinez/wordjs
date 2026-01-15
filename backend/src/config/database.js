/**
 * WordJS - Database Manager (ABSTRACTION LAYER)
 * Dynamically loads the configured driver (Legacy vs Native vs Postgres)
 */

const config = require('./app');
const path = require('path');

// 1. Load the Configured Driver
const driverName = config.dbDriver || 'sqlite-legacy';
let driver = null;
let driverAsync = null; // New Async Driver

try {
  console.log(`🔌 DB Manager: Loading driver '${driverName}'...`);
  driver = require(`../drivers/${driverName}`);

  // Try to load async version if available (convention: driver-name + '-async')
  try {
    if (driverName === 'sqlite-native') {
      driverAsync = require('../drivers/sqlite-native-async');
      console.log(`🔌 DB Manager: Loaded Async Driver for '${driverName}'`);
    } else if (driverName === 'postgres') {
      // Postgres is natively async
      driverAsync = require('../drivers/postgres');
      console.log(`🔌 DB Manager: Loaded Async Driver for '${driverName}'`);

      // For Postgres, we don't have a sync driver. 
      // We must mock it or ensure app checks for dbAsync.
      // Current architecture enforces sync 'driver' for some fallback.
      // We'll just define a dummy driver that throws errors for Sync calls.
      driver = {
        init: async () => { }, // No-op
        get: () => { throw new Error('Synchronous DB access not supported with Postgres. Use dbAsync.'); },
        close: () => { }
      };
    }
  } catch (e) {
    console.warn(`⚠️  Async driver not found for '${driverName}', some features may be disabled.`);
  }

} catch (e) {
  console.error(`❌ Failed to load driver '${driverName}':`, e.message);
  console.warn(`⚠️  Falling back to 'sqlite-legacy'`);
  driver = require('../drivers/sqlite-legacy');
}

// 2. Abstraction Proxies
const init = async () => {

  // Auto-Start Embedded Core DB if configured
  if (driverName === 'postgres' && (config.db.port == 5433 || process.env.DB_PORT == '5433')) {
    try {
      const embedded = require('../core/embedded-db');
      await embedded.startServer();
    } catch (e) {
      console.warn('⚠️  Could not auto-start embedded postgres:', e.message);
    }
  }

  // Initialize Sync Driver
  if (driver && driver.init) await driver.init();

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

  // Migration: Add missing columns if they don't exist
  try { await exec("ALTER TABLE notifications ADD COLUMN icon TEXT"); } catch (e) { }
  try { await exec("ALTER TABLE notifications ADD COLUMN color TEXT"); } catch (e) { }
  try { await exec("ALTER TABLE notifications ADD COLUMN action_url TEXT"); } catch (e) { }

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

// Async Proxy
const dbAsyncProxy = new Proxy({}, {
  get(target, prop) {
    // Only verify on top-level access, not every property
    verifyPermission('database', 'read');

    const db = getDbAsync();
    if (!db) throw new Error('Async Database not initialized');
    // If prop is a function on the driver, bind it
    if (typeof db[prop] === 'function') {
      return (...args) => {
        // Double check for write operations
        if (['run', 'exec', 'save'].includes(prop)) {
          verifyPermission('database', 'write');
        }
        return db[prop].bind(db)(...args);
      }
    }
    return db[prop];
  }
});

module.exports = {
  init,
  getDb,
  getDbAsync,
  initializeDatabase,
  initializeSchema,
  saveDatabase,
  closeDatabase,
  db: dbProxy,
  dbAsync: dbAsyncProxy
};
