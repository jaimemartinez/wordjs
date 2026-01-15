/**
 * WordJS - Legacy SQLite Driver (In-Memory + File Flush)
 * Uses sql.js (WASM)
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('../config/app');

let dbInstance = null;
let SQL = null;
let activeDbPath = null;

async function init(options = {}) {
    SQL = await initSqlJs();
    activeDbPath = path.resolve(options.dbPath || config.dbPath);

    // Ensure data directory exists
    const dbDir = path.dirname(activeDbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // Load existing database or create new one
    if (fs.existsSync(activeDbPath)) {
        const buffer = fs.readFileSync(activeDbPath);
        dbInstance = new SQL.Database(buffer);
    } else {
        dbInstance = new SQL.Database();
    }

    // Enable foreign keys
    dbInstance.run('PRAGMA foreign_keys = ON;');

    return dbInstance;
}

function save() {
    if (!dbInstance || !activeDbPath) return;
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(activeDbPath, buffer);
}

function get() {
    if (!dbInstance) {
        throw new Error('Database not initialized. Call init() first.');
    }
    return new DatabaseWrapper(dbInstance);
}

function close() {
    if (dbInstance) {
        save();
        dbInstance.close();
    }
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
        save();
    }

    run(sql, params = []) {
        this.sqlDb.run(sql, params);
        save();
    }

    pragma(pragma) {
        this.sqlDb.run(`PRAGMA ${pragma};`);
    }

    close() {
        if (this.sqlDb) {
            save();
            this.sqlDb.close();
        }
    }
}

class StatementWrapper {
    constructor(sqlDb, sql) {
        this.sqlDb = sqlDb;
        this.sql = sql;
    }

    run(...params) {
        this.sqlDb.run(this.sql, params);

        const lastId = this.sqlDb.exec('SELECT last_insert_rowid() as id')[0];
        const changes = this.sqlDb.exec('SELECT changes() as changes')[0];

        save(); // Critical: Save after every write
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

module.exports = {
    init,
    get,
    save,
    close
};
