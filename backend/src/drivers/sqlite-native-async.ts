/**
 * WordJS - SQLite Native Async Driver  ★ CANONICAL SQLite driver
 * Wrapper around better-sqlite3 (native, fast) implementing the async DatabaseDriverInterface.
 * This is the default SQLite engine. If its native binary can't load, the DB manager falls back
 * to the pure-JS 'sqlite-legacy' (sql.js) driver, which reads the same file format.
 */

const DatabaseDriverInterface = require('./interface');
const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/app');

class SqliteNativeAsyncDriver extends DatabaseDriverInterface {
    db: any;
    dbPath: string;
    // Promise-chain mutex: serializes transaction() so two overlapping callers can never interleave
    // their BEGIN/COMMIT on the single shared better-sqlite3 connection. See transaction() below.
    _txChain: Promise<any>;

    constructor() {
        super();
        this.db = null;
        this.dbPath = path.resolve(config.dbPath || './data/wordjs-native.db');
        this._txChain = Promise.resolve();
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
        return new Promise<void>((resolve, reject) => {
            try {
                this.db.exec(sql);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Run an atomic transaction. SQLite (better-sqlite3) is single-connection, so BEGIN/COMMIT/
     * ROLLBACK around fn on the same handle is genuinely atomic — this matches the existing behavior
     * (revisions previously did BEGIN/COMMIT via run() and it worked precisely because there is one
     * connection). `tx` exposes get/all/run with the SAME shape as the top-level methods.
     *
     * NOTE: better-sqlite3 itself is synchronous; we keep the async/Promise surface for interface
     * parity with the Postgres driver. Do not nest transaction() calls (SQLite has no nested BEGIN).
     *
     * CONCURRENCY: the callback is async and may `await` between BEGIN and COMMIT, which yields the
     * event loop. With a single shared connection that would let a second transaction() issue its own
     * BEGIN inside the first (SQLite throws "cannot start a transaction within a transaction") AND let
     * an interleaved write land inside the wrong transaction scope. We therefore SERIALIZE transaction()
     * via a per-driver promise-chain mutex (_txChain): each call waits for the previous to fully settle
     * (commit/rollback) before its own BEGIN runs, so transactions execute strictly one-at-a-time.
     *
     * @param {(tx: {get,all,run,exec}) => Promise<any>} fn
     * @returns {Promise<any>} the value returned by fn
     */
    async transaction(fn) {
        // Queue this transaction behind any in-flight one. We chain off a settled-no-matter-what tail
        // (catch swallows the PREVIOUS tx's error for chaining only) so one failed tx never blocks the
        // queue; the caller still receives their own tx's result/error via `run`.
        const run = this._txChain.then(() => this._runTransaction(fn), () => this._runTransaction(fn));
        this._txChain = run.catch(() => { });
        return run;
    }

    async _runTransaction(fn) {
        const tx = {
            get: async (sql, params = []) => this.db.prepare(sql).get(...params),
            all: async (sql, params = []) => this.db.prepare(sql).all(...params),
            run: async (sql, params = []) => {
                const info = this.db.prepare(sql).run(...params);
                return { lastID: info.lastInsertRowid, changes: info.changes };
            },
            exec: async (sql) => { this.db.exec(sql); }
        };

        this.db.exec('BEGIN');
        try {
            const result = await fn(tx);
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            try {
                this.db.exec('ROLLBACK');
            } catch (rbErr: any) {
                console.error('❌ SQLite ROLLBACK failed:', rbErr && rbErr.message);
            }
            throw err;
        }
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
