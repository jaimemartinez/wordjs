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
    // True while a transaction() is between BEGIN and COMMIT/ROLLBACK. Used to detect a RE-ENTRANT
    // transaction() (one called from inside another's callback), which would deadlock _txChain.
    _inTransaction: boolean;

    constructor() {
        super();
        this.db = null;
        this.dbPath = path.resolve(config.dbPath || './data/wordjs-native.db');
        this._txChain = Promise.resolve();
        this._inTransaction = false;
    }

    async connect() {
        try {
            console.log(`🔌 SQLite Native Async: Connecting to ${this.dbPath}...`);
            this.db = new Database(this.dbPath);
            // Enable WAL mode for better concurrency. Every query in the app runs on THIS connection,
            // so the perf pragmas must live here (the sync driver configuring its own connection does
            // nothing for these models). NORMAL is the documented pairing for WAL: fsync on checkpoint
            // instead of per-commit — a crash can lose the last transactions but cannot corrupt.
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = -64000');      // 64 MB page cache
            this.db.pragma('mmap_size = 268435456');    // 256 MB mmap window
            this.db.pragma('temp_store = MEMORY');
            console.log('✅ SQLite Native Async: Connected.');
        } catch (err) {
            console.error('❌ SQLite Native Async: Connection failed:', err.message);
            throw err;
        }
    }

    // Prepared-statement LRU: parse+plan once per SQL string instead of on every call (~100
    // prepares per cold page). DDL invalidates everything — a statement compiled against an old
    // schema must never run against the new one.
    _stmtCache: Map<string, any> = new Map();
    static _STMT_CACHE_MAX = 200;
    _prepare(sql: string) {
        let stmt = this._stmtCache.get(sql);
        if (stmt) {
            // refresh LRU position
            this._stmtCache.delete(sql);
            this._stmtCache.set(sql, stmt);
            return stmt;
        }
        stmt = this.db.prepare(sql);
        if (/^\s*(CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH)\b/i.test(sql)) {
            // schema-changing statement: run uncached and drop everything compiled so far
            this._stmtCache.clear();
            return stmt;
        }
        this._stmtCache.set(sql, stmt);
        if (this._stmtCache.size > SqliteNativeAsyncDriver._STMT_CACHE_MAX) {
            const oldest = this._stmtCache.keys().next().value;
            if (oldest !== undefined) this._stmtCache.delete(oldest);
        }
        return stmt;
    }

    async get(sql: string, params: any[] = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this._prepare(sql);
                const row = stmt.get(...params);
                resolve(row);
            } catch (err) {
                reject(err);
            }
        });
    }

    async all(sql: string, params: any[] = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this._prepare(sql);
                const rows = stmt.all(...params);
                resolve(rows);
            } catch (err) {
                reject(err);
            }
        });
    }

    async run(sql: string, params: any[] = []) {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this._prepare(sql);
                const info = stmt.run(...params);
                resolve({ lastID: info.lastInsertRowid, changes: info.changes });
            } catch (err) {
                reject(err);
            }
        });
    }

    async exec(sql: string) {
        return new Promise<void>((resolve, reject) => {
            try {
                this.db.exec(sql);
                // exec is the raw multi-statement path (migrations, DDL): cached plans may be stale
                this._stmtCache.clear();
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
    async transaction(fn: any) {
        // Re-entrancy guard: a transaction() invoked from INSIDE another transaction()'s callback would
        // chain off the OUTER tx's still-pending tail (which can't settle until this inner call resolves)
        // → circular wait that permanently wedges _txChain and every future transaction(). SQLite has no
        // nested BEGIN anyway, so fail FAST and synchronously (the throw rejects this call's promise)
        // instead of silently deadlocking. The happy (non-nested) path is unchanged.
        if (this._inTransaction) {
            throw new Error('nested transaction() is not supported');
        }
        // Queue this transaction behind any in-flight one. We chain off a settled-no-matter-what tail
        // (catch swallows the PREVIOUS tx's error for chaining only) so one failed tx never blocks the
        // queue; the caller still receives their own tx's result/error via `run`.
        const run = this._txChain.then(() => this._runTransaction(fn), () => this._runTransaction(fn));
        this._txChain = run.catch(() => { });
        return run;
    }

    async _runTransaction(fn: any) {
        const tx = {
            get: async (sql: string, params: any[] = []) => this.db.prepare(sql).get(...params),
            all: async (sql: string, params: any[] = []) => this.db.prepare(sql).all(...params),
            run: async (sql: string, params: any[] = []) => {
                const info = this.db.prepare(sql).run(...params);
                return { lastID: info.lastInsertRowid, changes: info.changes };
            },
            exec: async (sql: string) => { this.db.exec(sql); this._stmtCache.clear(); }
        };

        this.db.exec('BEGIN');
        this._inTransaction = true; // mark open so a re-entrant transaction() fails fast (see transaction())
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
        } finally {
            this._inTransaction = false;
        }
    }

    async getTables() {
        return new Promise((resolve, reject) => {
            try {
                const stmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                const rows = stmt.all();
                resolve(rows.map((r: any) => r.name));
            } catch (err) {
                reject(err);
            }
        });
    }

    async getTableSchema(tableName: string) {
        return new Promise((resolve, reject) => {
            try {
                // Use PRAGMA to get column info similar to needed for createPluginTable
                const stmt = this.db.prepare(`PRAGMA table_info("${tableName}")`);
                const columns = stmt.all();

                // Reconstruct definitions compatible with createPluginTable inputs
                // Format: "name TYPE constraints"
                const defs = columns.map((col: any) => {
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
            this._stmtCache.clear();
            this.db.close();
            this.db = null;
            console.log('🔌 SQLite Native Async: Closed.');
        }
    }
}

module.exports = new SqliteNativeAsyncDriver();
