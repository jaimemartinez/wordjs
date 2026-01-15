/**
 * WordJS - Database Manager (ABSTRACTION LAYER)
 * Dynamically loads the configured driver (Legacy vs Native vs Postgres)
 */

const config = require('./app');
const path = require('path');

// 1. Load the Configured Driver
const driverName = config.dbDriver || 'sqlite-legacy';
let driver = null;

try {
  console.log(`🔌 DB Manager: Loading driver '${driverName}'...`);
  driver = require(`../drivers/${driverName}`);
} catch (e) {
  console.error(`❌ Failed to load driver '${driverName}':`, e.message);
  console.warn(`⚠️  Falling back to 'sqlite-legacy'`);
  driver = require('../drivers/sqlite-legacy');
}

// 2. Abstraction Proxies
const initSqlJsDb = async () => {
  return await driver.init();
};

const getDb = () => {
  return driver.get();
};

const saveDatabase = () => {
  if (driver.save && typeof driver.save === 'function') {
    driver.save();
  }
};

const closeDatabase = () => {
  if (driver.close && typeof driver.close === 'function') {
    driver.close();
  }
}

// 3. Schema Management (Core Tables)
function initializeSchema(db) {
  console.log('🏗️  Verifying Database Schema...');

  // Posts table (equivalent to wp_posts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL DEFAULT 0,
      post_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      post_date_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      post_content TEXT NOT NULL DEFAULT '',
      post_title TEXT NOT NULL DEFAULT '',
      post_excerpt TEXT NOT NULL DEFAULT '',
      post_status TEXT NOT NULL DEFAULT 'draft',
      comment_status TEXT NOT NULL DEFAULT 'open',
      ping_status TEXT NOT NULL DEFAULT 'open',
      post_password TEXT NOT NULL DEFAULT '',
      post_name TEXT NOT NULL DEFAULT '',
      to_ping TEXT NOT NULL DEFAULT '',
      pinged TEXT NOT NULL DEFAULT '',
      post_modified TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      post_modified_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      post_content_filtered TEXT NOT NULL DEFAULT '',
      post_parent INTEGER NOT NULL DEFAULT 0,
      guid TEXT NOT NULL DEFAULT '',
      menu_order INTEGER NOT NULL DEFAULT 0,
      post_type TEXT NOT NULL DEFAULT 'post',
      post_mime_type TEXT NOT NULL DEFAULT '',
      comment_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Post meta table
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_meta (
      meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT
    )
  `);

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_login TEXT NOT NULL DEFAULT '',
      user_pass TEXT NOT NULL DEFAULT '',
      user_nicename TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      user_url TEXT NOT NULL DEFAULT '',
      user_registered TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_activation_key TEXT NOT NULL DEFAULT '',
      user_status INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL DEFAULT ''
    )
  `);

  // User meta table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_meta (
      umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT
    )
  `);

  // Comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_post_id INTEGER NOT NULL DEFAULT 0,
      comment_author TEXT NOT NULL DEFAULT '',
      comment_author_email TEXT NOT NULL DEFAULT '',
      comment_author_url TEXT NOT NULL DEFAULT '',
      comment_author_ip TEXT NOT NULL DEFAULT '',
      comment_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment_date_gmt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment_content TEXT NOT NULL,
      comment_karma INTEGER NOT NULL DEFAULT 0,
      comment_approved TEXT NOT NULL DEFAULT '1',
      comment_agent TEXT NOT NULL DEFAULT '',
      comment_type TEXT NOT NULL DEFAULT 'comment',
      comment_parent INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Comment meta table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_meta (
      meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT
    )
  `);

  // Terms table
  db.exec(`
    CREATE TABLE IF NOT EXISTS terms (
      term_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      term_group INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Term taxonomy table
  db.exec(`
    CREATE TABLE IF NOT EXISTS term_taxonomy (
      term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL DEFAULT 0,
      taxonomy TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      parent INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Term relationships table
  db.exec(`
    CREATE TABLE IF NOT EXISTS term_relationships (
      object_id INTEGER NOT NULL DEFAULT 0,
      term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
      term_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (object_id, term_taxonomy_id)
    )
  `);

  // Options table
  db.exec(`
    CREATE TABLE IF NOT EXISTS options (
      option_id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_name TEXT NOT NULL DEFAULT '',
      option_value TEXT NOT NULL DEFAULT '',
      autoload TEXT NOT NULL DEFAULT 'yes'
    )
  `);

  // Links table
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      link_id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_url TEXT NOT NULL DEFAULT '',
      link_name TEXT NOT NULL DEFAULT '',
      link_image TEXT NOT NULL DEFAULT '',
      link_target TEXT NOT NULL DEFAULT '',
      link_description TEXT NOT NULL DEFAULT '',
      link_visible TEXT NOT NULL DEFAULT 'Y',
      link_owner INTEGER NOT NULL DEFAULT 1,
      link_rating INTEGER NOT NULL DEFAULT 0,
      link_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      link_rel TEXT NOT NULL DEFAULT '',
      link_notes TEXT NOT NULL DEFAULT '',
      link_rss TEXT NOT NULL DEFAULT ''
    )
  `);

  console.log('✅ Database Schema verified.');
}

function initializeDatabase() {
  initializeSchema(getDb());
}

// Create a proxy that returns getDb() when accessed
const dbProxy = new Proxy({}, {
  get(target, prop) {
    const db = getDb();
    return db[prop].bind(db);
  }
});

module.exports = {
  initSqlJsDb,
  getDb,
  initializeDatabase,
  initializeSchema,
  saveDatabase,
  closeDatabase,
  db: dbProxy
};
