/**
 * WordJS - SQLite Native Async Driver
 * Wrapper around better-sqlite3 to provide an Async Interface
 */

const DatabaseDriverInterface = require('./interface');
const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/app');

class SqliteNativeAsyncDriver extends DatabaseDriverInterface {
    constructor() {
        super();
        this.db = null;
        this.dbPath = path.resolve(config.dbPath || './data/wordjs-native.db');
    }

    async connect() {
        try {
            console.log(`🔌 SQLite Native Async: Connecting to ${this.dbPath}...`);
            this.db = new Database(this.dbPath);
            // Enable WAL mode for better concurrency
            this.db.pragma('journal_mode = WAL');
            console.log('✅ SQLite Native Async: Connected.');
        } catch (err) {
            console.error('❌ SQLite Native Async: Connection failed:', err.message);
            throw err;
        }
    }

    async get(sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this.db.prepare(sql);
                const row = stmt.get(...params);
                resolve(row);
            } catch (err) {
                reject(err);
            }
        });
    }

    async all(sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(...params);
                resolve(rows);
            } catch (err) {
                reject(err);
            }
        });
    }

    async run(sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this.db.prepare(sql);
                const info = stmt.run(...params);
                resolve({ lastID: info.lastInsertRowid, changes: info.changes });
            } catch (err) {
                reject(err);
            }
        });
    }

    async exec(sql) {
        return new Promise((resolve, reject) => {
            try {
                this.db.exec(sql);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    async getTables() {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                const rows = stmt.all();
                resolve(rows.map(r => r.name));
            } catch (err) {
                reject(err);
            }
        });
    }

    async getTableSchema(tableName) {
        return new Promise((resolve, reject) => {
            try {
                // Use PRAGMA to get column info similar to needed for createPluginTable
                const stmt = this.db.prepare(`PRAGMA table_info("${tableName}")`);
                const columns = stmt.all();

                // Reconstruct definitions compatible with createPluginTable inputs
                // Format: "name TYPE constraints"
                const defs = columns.map(col => {
                    let def = `${col.name} ${col.type}`;
                    if (col.notnull) def += ' NOT NULL';
                    if (col.dflt_value) def += ` DEFAULT ${col.dflt_value}`;
                    if (col.pk) def += ' PRIMARY KEY';
                    // Note: This is an approximation. Full DDL is better if available.
                    return def;
                });

                // Better approach for SQLite: Get actual CREATE statement!
                const sqlStmt = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?");
                const sqlRow = sqlStmt.get(tableName);

                resolve({
                    sql: sqlRow ? sqlRow.sql : null, // Use raw SQL if available (Best for SQLite)
                    columns: defs // Fallback or metadata
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            console.log('🔌 SQLite Native Async: Closed.');
        }
    }
}

module.exports = new SqliteNativeAsyncDriver();
