/**
 * WordJS - Legacy SQLite Driver (In-Memory + File Flush)  ☂ PURE-JS / WASM FALLBACK
 * Uses sql.js (WASM) — no native build required, but slower than 'sqlite-native' (better-sqlite3).
 * Not the default: the DB manager selects this automatically only when the native SQLite driver
 * can't load. It reads/writes the same SQLite file format, so the fallback is transparent.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('../config/app');
const { AsyncLocalStorage } = require('async_hooks');

let dbInstance: any = null;
let SQL: any = null;
let activeDbPath: string | null = null;

// While a transaction() is open we SUPPRESS the per-write save() (StatementWrapper.run / exec) so the
// on-disk file is never overwritten with mid-transaction (uncommitted) state. The transaction does a
// single save() after COMMIT (and re-syncs to the last committed image on ROLLBACK). This makes the
// on-disk image transition atomically between committed states even if the process crashes mid-tx.
let inTransaction = false;
// Promise-chain mutex so concurrent transaction() callers run strictly one-at-a-time on the single
// shared in-memory connection (no interleaved BEGIN/COMMIT, mirrors the native driver's _txChain).
let txChain: Promise<any> = Promise.resolve();
const txContext = new AsyncLocalStorage();
let pendingTransactions = 0;

async function init(options: any = {}) {
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
    sqlDb: any;

    constructor(sqlDb: any) {
        this.sqlDb = sqlDb;
    }

    _assertTransactionAccess() {
        if (inTransaction && !txContext.getStore()?.active) {
            throw new Error('SQLite legacy connection is busy with another transaction');
        }
    }

    async waitForTransaction() {
        if (txContext.getStore()?.active) return;
        while (pendingTransactions > 0) await txChain;
    }

    prepare(sql: string) {
        this._assertTransactionAccess();
        return new StatementWrapper(this.sqlDb, sql);
    }

    exec(sql: string) {
        this._assertTransactionAccess();
        this.sqlDb.run(sql);
        // Suppress the disk flush while a transaction is open — transaction() saves once after COMMIT.
        if (!inTransaction) save();
    }

    // Helper methods to match dbAsync interface (and PostgresDriver)

    get(sql: string, params: any[] = []) {
        return this.prepare(sql).get(...params);
    }

    all(sql: string, params: any[] = []) {
        return this.prepare(sql).all(...params);
    }

    run(sql: string, params: any[] = []) {
        return this.prepare(sql).run(...params);
    }

    /**
     * Atomic transaction for the pure-JS (sql.js) fallback driver. sql.js is a single in-memory
     * database, so BEGIN/COMMIT/ROLLBACK around fn is atomic IN MEMORY. `tx` mirrors the get/all/run
     * surface of the async drivers so callers (e.g. dbAsync.transaction) work identically on the
     * fallback. Kept async for interface parity even though sql.js is synchronous.
     *
     * DURABILITY: StatementWrapper.run() normally save()s (dumps the whole DB) after EVERY write, which
     * would flush UNCOMMITTED state to disk mid-transaction — a crash before COMMIT could leave a
     * partially-applied transaction on disk with no journal to undo it. We therefore set `inTransaction`
     * so per-write save()s are suppressed, snapshot the last committed image at BEGIN, and write to disk
     * exactly once after COMMIT. On ROLLBACK we restore the in-memory DB from the snapshot (so a failed
     * tx leaves both memory AND disk at the prior committed state).
     *
     * CONCURRENCY: serialized via the module-level txChain promise-mutex so overlapping callers can't
     * interleave BEGIN/COMMIT on the single shared connection.
     */
    async transaction(fn: any) {
        // Re-entrancy guard: a transaction() invoked from INSIDE another transaction()'s callback would
        // chain off the OUTER tx's still-pending tail (which can't settle until this inner call resolves)
        // → circular wait that permanently wedges txChain and every future transaction(). sql.js has no
        // nested BEGIN anyway, so fail FAST and synchronously instead of silently deadlocking. The module
        // `inTransaction` flag is already true between BEGIN and COMMIT/ROLLBACK (see _runTransaction).
        if (txContext.getStore()?.active) {
            throw new Error('nested transaction() is not supported');
        }
        pendingTransactions++;
        const run = txChain
            .then(() => this._runTransaction(fn), () => this._runTransaction(fn))
            .finally(() => { pendingTransactions--; });
        txChain = run.catch(() => { });
        return run;
    }

    async _runTransaction(fn: any) {
        const tx = {
            get: async (sql: string, params: any[] = []) => this.get(sql, params),
            all: async (sql: string, params: any[] = []) => this.all(sql, params),
            run: async (sql: string, params: any[] = []) => this.run(sql, params),
            exec: async (sql: string) => { this.exec(sql); }
        };

        // NO PRE-EMPTIVE SNAPSHOT. This used to `export()` the WHOLE database — a full copy of every
        // byte, in WASM memory — before every BEGIN, as the material for a deterministic rollback.
        // That was affordable while only setTerms()/linkTranslations() opened transactions; it stopped
        // being affordable the moment ordinary writes (every publish, every trash, every scheduled
        // flip — models/Post.ts) started opening one, because it turned a single-row UPDATE into a
        // full database copy on a site whose database can be hundreds of MB.
        //
        // It was also redundant twice over. sql.js IS SQLite: its ROLLBACK is the real thing and
        // restores the in-memory image itself. And because `inTransaction` suppresses the per-write
        // save(), the FILE ON DISK still holds the last committed image for the whole transaction —
        // so the pre-BEGIN state is already durably available if ROLLBACK itself ever fails. The
        // recovery below reads it from there, and only in that path, so the cost is paid only when it
        // is actually needed. Net effect: a small transaction now costs exactly what the bare write it
        // replaced cost — one export+write, after COMMIT.
        inTransaction = true; // suppress per-write save() for the duration of the unit of work
        this.sqlDb.run('BEGIN');
        const context = { active: true };
        try {
            const result = await txContext.run(context, () => fn(tx));
            this.sqlDb.run('COMMIT');
            inTransaction = false;
            save(); // single durable flush of the COMMITTED state to disk
            return result;
        } catch (err) {
            let rolledBack = true;
            try {
                this.sqlDb.run('ROLLBACK');
            } catch (rbErr: any) {
                rolledBack = false;
                console.error('❌ SQLite (legacy) ROLLBACK failed:', rbErr && rbErr.message);
            }
            if (!rolledBack) {
                // ROLLBACK could not undo it, so the live handle may hold partially-applied state.
                // Reload the last COMMITTED image — the on-disk file, untouched since before BEGIN
                // (per-write save() was suppressed) — and replace the handle. Closing the old one
                // frees the WASM memory it held.
                try {
                    const committed = activeDbPath && fs.existsSync(activeDbPath) ? fs.readFileSync(activeDbPath) : null;
                    const restored = committed ? new SQL.Database(committed) : new SQL.Database();
                    restored.run('PRAGMA foreign_keys = ON;');
                    try { this.sqlDb.close(); } catch { /* ignore */ }
                    this.sqlDb = restored;
                    dbInstance = restored;
                } catch (restoreErr: any) {
                    console.error('❌ SQLite (legacy) committed-image restore failed:', restoreErr && restoreErr.message);
                }
            }
            inTransaction = false;
            // No save() here: the on-disk file was never written during the transaction, so it ALREADY
            // is the last committed state — writing it back would be another full export for nothing.
            throw err;
        } finally {
            context.active = false;
        }
    }

    pragma(pragma: string) {
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
    sqlDb: any;
    sql: string;

    constructor(sqlDb: any, sql: string) {
        this.sqlDb = sqlDb;
        // Strip RETURNING clause for SQLite (legacy/wasm) as it might not be supported or is handled manually
        this.sql = sql.replace(/\s+RETURNING\s+.*$/i, '');
    }

    run(...params: any[]) {
        this.sqlDb.run(this.sql, params);

        const lastId = this.sqlDb.exec('SELECT last_insert_rowid() as id')[0];
        const changes = this.sqlDb.exec('SELECT changes() as changes')[0];

        // Save after every write — EXCEPT inside an open transaction(), where mid-transaction
        // (uncommitted) state must not hit disk. transaction() does a single save() after COMMIT.
        if (!inTransaction) save();
        return {
            lastInsertRowid: lastId?.values?.[0]?.[0] || 0,
            lastID: lastId?.values?.[0]?.[0] || 0, // Alias for compatibility with refactored models
            changes: changes?.values?.[0]?.[0] || 0
        };
    }

    get(...params: any[]) {
        try {
            const stmt = this.sqlDb.prepare(this.sql);
            stmt.bind(params);

            if (stmt.step()) {
                const columns = stmt.getColumnNames();
                const values = stmt.get();
                stmt.free();

                const row: Record<string, any> = {};
                columns.forEach((col: string, i: number) => {
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

    all(...params: any[]) {
        try {
            const results: any[] = [];
            const stmt = this.sqlDb.prepare(this.sql);
            stmt.bind(params);

            const columns = stmt.getColumnNames();

            while (stmt.step()) {
                const values = stmt.get();
                const row: any = {};
                columns.forEach((col: string, i: number) => {
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
