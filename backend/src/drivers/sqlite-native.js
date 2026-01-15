/**
 * WordJS - Native SQLite Driver
 * Uses better-sqlite3 (Native Row-Level Locking + WAL)
 */
const path = require('path');
const fs = require('fs');
const config = require('../config/app');

let dbInstance = null;

function init(options = {}) {
    const dbPath = path.resolve(options.dbPath || config.dbPath);
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    try {
        // Lazy load to avoid crashing if not installed
        const Database = require('better-sqlite3');
        dbInstance = new Database(dbPath, {
            verbose: config.env === 'development' ? console.log : null
        });

        // Performance optimizations
        dbInstance.pragma('journal_mode = WAL'); // Write-Ahead Logging
        dbInstance.pragma('synchronous = NORMAL'); // Faster writes, safe for WAL
        dbInstance.pragma('foreign_keys = ON');

        console.log('⚡ Native SQLite Driver initialized with WAL mode.');
        return dbInstance;
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            throw new Error('Driver "db-driver-sqlite" requires "better-sqlite3". Please run: npm install better-sqlite3 --save --prefix backend');
        }
        throw e;
    }
}

function get() {
    if (!dbInstance) throw new Error('Native DB not initialized. Call init() first.');
    return new NativeWrapper(dbInstance);
}

function save() {
    // No-op for Native SQLite (Auto-persisted by WAL)
}

function close() {
    if (dbInstance) dbInstance.close();
}

/**
 * Adapter to match the exact API of the Legacy Wrapper
 * better-sqlite3 is almost identical, but we standardize just in case.
 */
class NativeWrapper {
    constructor(db) {
        this.db = db;
    }

    prepare(sql) {
        return this.db.prepare(sql);
    }

    exec(sql) {
        return this.db.exec(sql);
    }

    run(sql, params = []) {
        return this.db.prepare(sql).run(params);
    }

    pragma(str) {
        return this.db.pragma(str);
    }

    close() {
        this.db.close();
    }
}

module.exports = {
    init,
    get,
    save,
    close
};
