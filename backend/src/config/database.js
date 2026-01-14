/**
 * WordJS - Database Configuration
 * SQLite database setup using sql.js (pure JavaScript SQLite)
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./app');

let dbInstance = null;
let SQL = null;

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

/**
 * Initialize SQL.js and load/create database
 */
async function initSqlJsDb() {
  SQL = await initSqlJs();

  const dbPath = path.resolve(config.dbPath);

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    dbInstance = new SQL.Database(buffer);
  } else {
    dbInstance = new SQL.Database();
  }

  // Enable foreign keys
  dbInstance.run('PRAGMA foreign_keys = ON;');

  return dbInstance;
}

/**
 * Save database to file
 */
function saveDatabase() {
  if (!dbInstance) return;
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.resolve(config.dbPath), buffer);
}

/**
 * Get database instance
 */
function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initSqlJsDb() first.');
  }
  return new DatabaseWrapper(dbInstance);
}

/**
 * Wrapper class to provide better-sqlite3 compatible interface
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this.sqlDb = sqlDb;
  }

  prepare(sql) {
    return new StatementWrapper(this.sqlDb, sql);
  }

  exec(sql) {
    this.sqlDb.run(sql);
    saveDatabase();
  }

  run(sql, params = []) {
    this.sqlDb.run(sql, params);
    saveDatabase();
  }

  pragma(pragma) {
    this.sqlDb.run(`PRAGMA ${pragma};`);
  }

  close() {
    if (this.sqlDb) {
      saveDatabase();
      this.sqlDb.close();
    }
  }
}

/**
 * Statement wrapper to mimic better-sqlite3 prepared statements
 */
class StatementWrapper {
  constructor(sqlDb, sql) {
    this.sqlDb = sqlDb;
    this.sql = sql;
  }

  run(...params) {
    this.sqlDb.run(this.sql, params);

    // Return object with lastInsertRowid and changes
    const lastId = this.sqlDb.exec('SELECT last_insert_rowid() as id')[0];
    const changes = this.sqlDb.exec('SELECT changes() as changes')[0];

    saveDatabase();

    return {
      lastInsertRowid: lastId?.values?.[0]?.[0] || 0,
      changes: changes?.values?.[0]?.[0] || 0
    };
  }

  get(...params) {
    try {
      const stmt = this.sqlDb.prepare(this.sql);
      stmt.bind(params);

      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        stmt.free();

        const row = {};
        columns.forEach((col, i) => {
          row[col] = values[i];
        });
        return row;
      }

      stmt.free();
      return undefined;
    } catch (e) {
      console.error('SQL error:', e.message, 'SQL:', this.sql);
      return undefined;
    }
  }

  all(...params) {
    try {
      const results = [];
      const stmt = this.sqlDb.prepare(this.sql);
      stmt.bind(params);

      const columns = stmt.getColumnNames();

      while (stmt.step()) {
        const values = stmt.get();
        const row = {};
        columns.forEach((col, i) => {
          row[col] = values[i];
        });
        results.push(row);
      }

      stmt.free();
      return results;
    } catch (e) {
      console.error('SQL error:', e.message, 'SQL:', this.sql);
      return [];
    }
  }
}

/**
 * Initialize database with schema
 */
function initializeDatabase() {
  const db = getDb();

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

  console.log('Database initialized successfully');
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
  saveDatabase,
  db: dbProxy
};
