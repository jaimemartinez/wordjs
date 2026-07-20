/**
 * WordJS - PostgreSQL Driver
 * Implements DatabaseDriverInterface using 'pg'
 */

const DatabaseDriverInterface = require('./interface');
const { Pool } = require('pg');
const config = require('../config/app');

/**
 * ── SQLite/generic DDL → Postgres translation ──────────────────────────────────────────────────
 * WordJS models, the core schema and plugins all speak ONE dialect: SQLite. Reads and writes only
 * need `?`→`$n` (see normalizeSql). DDL, however, is not all valid Postgres: SQLite's
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, plus `DATETIME`/`BLOB`, are foreign to Postgres.
 *
 * Historically exec() ran DDL RAW, with two consequences:
 *   • the cross-driver migration (core/db-admin/migration.js) recreated a SQLite plugin table on a
 *     Postgres target from a normalized COLUMN LIST — data-complete, but WITHOUT its PRIMARY KEY /
 *     autoincrement (SERIAL), so the table lacked its PK until the plugin re-ran its own schema; and
 *   • initializeSchema() emits DDL in the SOURCE driver's dialect during a migration (its driverName
 *     is still the source), so a SQLite→Postgres migration sent `INTEGER PRIMARY KEY AUTOINCREMENT`
 *     core DDL to Postgres untranslated.
 *
 * This translation layer (mirroring drivers/mysql.ts) rewrites, at the driver boundary, the handful
 * of constructs that differ, so exec() can run the RAW SQLite CREATE with full PK/autoincrement
 * fidelity:
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT`  → `SERIAL PRIMARY KEY`  (an int column backed by a sequence)
 *   - `DATETIME`                           → `TIMESTAMP`
 *   - `BLOB`                               → `BYTEA`
 *
 * Placeholders and quoting are already Postgres-compatible (WordJS single-quotes literals and
 * double-quotes identifiers), and Postgres natively supports `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
 * functional (`LOWER(x)`) and partial (`WHERE …`) indexes — so ONLY `CREATE TABLE` is rewritten;
 * every other statement passes through unchanged.
 */

// Strip `-- line` and `/* block */` comments (string-literal aware) so a comma inside a comment can't
// break the top-level column split. Mirrors the mysql driver.
function stripSqlComments(sql: string): string {
    let out = '', i = 0; const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (c === "'") {                                   // copy a string literal verbatim ('' = escape)
            out += c; i++;
            while (i < n) { out += sql[i]; if (sql[i] === "'") { if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; } i++; break; } i++; }
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
        if (c === '/' && sql[i + 1] === '*') { i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
        out += c; i++;
    }
    return out;
}

// Split a CREATE TABLE column list on top-level commas only (so `PRIMARY KEY (a, b)` stays intact).
function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
        else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

function translateColumnDef(def: string): string {
    // Table-level constraints (composite PK, UNIQUE(...), etc.) pass through unchanged.
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|CHECK|KEY|INDEX)\b/i.test(def)) return def;

    let d = def;
    // Auto-increment primary key: SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` → a real Postgres SERIAL
    // (int column + backing sequence). Do the full-phrase rewrite first, then strip any stray
    // AUTOINCREMENT keyword Postgres would reject.
    d = d.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'SERIAL PRIMARY KEY');
    d = d.replace(/\s*\bAUTOINCREMENT\b/gi, '');
    // Type keywords Postgres doesn't have.
    d = d.replace(/\bDATETIME\b/gi, 'TIMESTAMP');
    d = d.replace(/\bBLOB\b/gi, 'BYTEA');
    return d;
}

function translateCreateTable(sql: string): string {
    sql = stripSqlComments(sql);
    // Match a quoted/bracketed name (any chars, so a hyphenated `"wjp-orders"` isn't truncated) OR a
    // bare identifier; everything inside the outer parens is the column list. If it doesn't match this
    // shape, leave it alone.
    const m = sql.match(/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z0-9_]+)\s*)\(([\s\S]*)\)(\s*)$/i);
    if (!m) return sql;
    const cols = splitTopLevel(m[2]).map((c) => c.trim()).filter(Boolean).map(translateColumnDef);
    return `${m[1]}(\n  ${cols.join(',\n  ')}\n)${m[3] || ''}`;
}

/** Rewrite one SQLite-dialect statement to Postgres. Only CREATE TABLE needs it; all else is already
 *  Postgres-compatible and passes through untouched. */
function translateSql(sql: string): string {
    if (typeof sql !== 'string') return sql;
    if (/^\s*CREATE\s+TABLE\b/i.test(sql)) return translateCreateTable(sql);
    return sql;
}

/**
 * Derive lastID from an INSERT ... RETURNING * result set, but ONLY from a genuine `id`/`ID` column.
 * Tables without an `id` column (post_meta=meta_id, options=option_id, term_relationships=composite PK)
 * must NOT report their first arbitrary column (e.g. meta_id/option_id/object_id) as `lastID` — callers
 * that treat lastID as a logical posts/users id would otherwise get a wrong value. Mirrors
 * better-sqlite3's lastInsertRowid, which is only meaningful for rowid (id-bearing) inserts; returns 0
 * for composite/no-id inserts so callers must use `changes`/explicit RETURNING instead.
 */
function extractLastId(rows: any[]): any {
    if (rows && rows.length > 0) {
        const firstRow = rows[0];
        if (firstRow.id !== undefined && firstRow.id !== null) return firstRow.id;
        if (firstRow.ID !== undefined && firstRow.ID !== null) return firstRow.ID;
        // Single-column explicit RETURNING (e.g. `RETURNING comment_id` / `term_id`): that one column IS
        // the new key — use it. Restricted to EXACTLY one returned column so a multi-column `RETURNING *`
        // never fabricates lastID from an arbitrary first column (the original mis-attribution finding).
        const keys = Object.keys(firstRow);
        if (keys.length === 1 && firstRow[keys[0]] !== undefined && firstRow[keys[0]] !== null) return firstRow[keys[0]];
    }
    return 0;
}

class PostgresDriver extends DatabaseDriverInterface {
    pool: any;
    config: any;

    constructor() {
        super();
        this.pool = null;
        this.config = null; // Dynamic config override
    }

    /**
     * Initialize with optional config (for migrations)
     */
    async init(options: any = {}) {
        if (options.dbConfig) {
            this.config = options.dbConfig;
        }
    }

    async connect() {
        const dbConfig = this.config || config.db;
        console.log(`🔌 Postgres: Connecting to ${dbConfig.host}:${dbConfig.port || 5432}/${dbConfig.name}...`);

        try {
            const num = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
            this.pool = new Pool({
                host: dbConfig.host,
                port: dbConfig.port || 5432,
                user: dbConfig.user,
                password: dbConfig.password,
                database: dbConfig.name,
                ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
                // Force UTF-8 encoding to prevent errors on Windows servers with WIN1252 defaults
                connectionString: undefined, // ensure pool uses individual params
                client_encoding: 'UTF8',
                // Pool sizing + resilience — safe defaults (override per-field via the db config block).
                max: num(dbConfig.poolMax, 10) > 0 ? num(dbConfig.poolMax, 10) : 10,
                idleTimeoutMillis: num(dbConfig.poolIdleMs, 30000),          // reclaim idle clients
                connectionTimeoutMillis: num(dbConfig.poolConnectTimeoutMs, 10000), // fail fast on an unreachable DB instead of hanging forever
                // Evict a connection left IDLE inside a transaction (a leaked/hung txn that would pin a pool
                // slot) — NOT an actively-running long query, so this doesn't break legit long migrations/imports.
                idle_in_transaction_session_timeout: num(dbConfig.idleInTxnTimeoutMs, 30000),
                // statement_timeout is OFF by default on purpose: a blanket per-statement cap would kill legit
                // long operations (engine-switch migration, large WXR import, backup). Opt-in via db.statementTimeoutMs.
                ...(num(dbConfig.statementTimeoutMs, 0) > 0 ? { statement_timeout: num(dbConfig.statementTimeoutMs, 0) } : {})
            });

            // Verify connection
            const client = await this.pool.connect();
            const res = await client.query('SELECT NOW()');
            client.release();

            console.log('✅ Postgres: Connected successfully at', res.rows[0].now);

        } catch (err) {
            console.error('❌ Postgres: Connection failed:', err.message);
            throw err;
        }
    }

    /**
     * Normalize SQL queries from SQLite style (?) to Postgres style ($1, $2)
     */
    normalizeSql(sql: string) {
        let i = 1;
        // Replace ? with $1, $2, etc.
        return sql.replace(/\?/g, () => `$${i++}`);
    }

    async get(sql: string, params: any[] = []) {
        try {
            // Normalize SQL from SQLite style (?) to Postgres style ($1, $2)
            // This allows plugins to always write SQLite-style SQL
            const normalizedSql = this.normalizeSql(sql);
            const res = await this.pool.query(normalizedSql, params);
            return res.rows[0];
        } catch (err) {
            console.error('❌ Postgres Query Error (get):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async all(sql: string, params: any[] = []) {
        try {
            // Normalize SQL from SQLite style (?) to Postgres style ($1, $2)
            const normalizedSql = this.normalizeSql(sql);
            const res = await this.pool.query(normalizedSql, params);
            return res.rows;
        } catch (err) {
            console.error('❌ Postgres Query Error (all):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async run(sql: string, params: any[] = []) {
        try {
            // Normalize SQL from SQLite style (?) to Postgres style ($1, $2)
            let normalizedSql = this.normalizeSql(sql);

            // AUTO-INJECT 'RETURNING *' for INSERTs if missing so we can surface the generated id for
            // SQLite-style models. We keep RETURNING * (not RETURNING id) because not every table has
            // an `id` column (post_meta=meta_id, options=option_id, term_relationships=composite PK),
            // and RETURNING id would raise "column id does not exist" on those.
            if (/^\s*INSERT\s+/i.test(normalizedSql) && !/RETURNING\s+/i.test(normalizedSql)) {
                normalizedSql += ' RETURNING *';
            }

            const res = await this.pool.query(normalizedSql, params);

            return {
                // lastID is meaningful ONLY for inserts into an `id`/serial table (mirrors
                // better-sqlite3's lastInsertRowid semantics). Do NOT fabricate it from an arbitrary
                // first column — that mis-reported option_id/meta_id/object_id as a logical id for
                // composite/no-id tables. Leave it 0 when there is no real id column.
                lastID: extractLastId(res.rows),
                changes: res.rowCount
            };
        } catch (err) {
            console.error('❌ Postgres Query Error (run):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async exec(sql: string) {
        // Translate SQLite-dialect DDL (CREATE TABLE) to Postgres at the boundary — so a raw SQLite
        // CREATE from the cross-driver migration, or source-dialect DDL from initializeSchema(), runs
        // with full PK/autoincrement fidelity (INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY,
        // DATETIME → TIMESTAMP, BLOB → BYTEA). Every non-CREATE-TABLE statement passes through unchanged.
        try {
            await this.pool.query(translateSql(sql));
        } catch (err) {
            console.error('❌ Postgres Exec Error:', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    /**
     * Run a real, atomic transaction on a SINGLE pooled connection.
     *
     * The per-statement get/all/run/exec methods above each grab a DIFFERENT connection from the
     * pool, so issuing BEGIN/COMMIT as separate statements is NOT atomic (they can land on different
     * backends and interleave with other queries). This pins ONE client for the whole unit of work:
     * BEGIN → fn(tx) → COMMIT, with ROLLBACK on any throw, and the client always released.
     *
     * `tx` exposes get/all/run bound to that single client, using the SAME SQL normalization
     * (normalizeSql, RETURNING auto-injection, lastID/changes shape) as the top-level methods so
     * callers write identical SQLite-style SQL inside and outside a transaction.
     *
     * @param {(tx: {get,all,run,exec}) => Promise<any>} fn
     * @returns {Promise<any>} the value returned by fn
     */
    async transaction(fn: any) {
        const client = await this.pool.connect();

        const tx = {
            get: async (sql: string, params: any[] = []) => {
                const res = await client.query(this.normalizeSql(sql), params);
                return res.rows[0];
            },
            all: async (sql: string, params: any[] = []) => {
                const res = await client.query(this.normalizeSql(sql), params);
                return res.rows;
            },
            run: async (sql: string, params: any[] = []) => {
                let normalizedSql = this.normalizeSql(sql);
                // Mirror run(): auto-inject RETURNING * for INSERTs lacking it, so lastID works.
                if (/^\s*INSERT\s+/i.test(normalizedSql) && !/RETURNING\s+/i.test(normalizedSql)) {
                    normalizedSql += ' RETURNING *';
                }
                const res = await client.query(normalizedSql, params);
                // Same id-only attribution as run() — never fabricate lastID from an arbitrary column.
                return { lastID: extractLastId(res.rows), changes: res.rowCount };
            },
            exec: async (sql: string) => {
                // Same DDL translation as the top-level exec(), on the pinned connection.
                await client.query(translateSql(sql));
            }
        };

        try {
            await client.query('BEGIN');
            const result = await fn(tx);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (rbErr: any) {
                console.error('❌ Postgres ROLLBACK failed:', rbErr && rbErr.message);
            }
            throw err;
        } finally {
            client.release();
        }
    }

    async getTables() {
        try {
            const res = await this.pool.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
            );
            return res.rows.map((r: any) => r.table_name);
        } catch (err) {
            console.error('❌ Postgres getTables Error:', err.message);
            throw err;
        }
    }

    async getTableSchema(tableName: string) {
        try {
            const res = await this.pool.query(
                "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
                [tableName]
            );

            // Map to generic format roughly compatible with createPluginTable
            const columns = res.rows.map((col: any) => {
                let type = col.data_type.toUpperCase();

                // Normalizations for Universal Compatibility
                if (type === 'CHARACTER VARYING') type = 'TEXT';
                if (type.includes('INT')) type = 'INTEGER';
                if (type === 'BOOLEAN') type = 'INTEGER'; // WordJS usually uses 0/1 for bools in SQLite
                if (type.includes('TIMESTAMP')) type = 'DATETIME'; // Strip time zone info
                if (type.includes('JSON')) type = 'TEXT'; // SQLite stores JSON as TEXT
                if (type === 'USER-DEFINED') type = 'TEXT'; // Enums etc

                let def = `${col.column_name} ${type}`;

                if (col.is_nullable === 'NO') def += ' NOT NULL';
                if (col.column_default) {
                    // Clean default value (Postgres adds type casts like '::text')
                    let dflt = col.column_default.replace(/::[a-z0-9_ ]+/i, '');
                    // Clean 'now()' or similar functions if possible, but basic strip helps
                    if (dflt.includes('nextval')) {
                        // It's a sequence/serial. If it's a PK, we might want INT_PK?
                        // For now, let's just strip default for sequences to avoid restore errors
                        // provided the app logic handles ID gen or we enable AUTOINCREMENT logic.
                        // But createPluginTable uses INT_PK for autoincrement. 
                        // If we can't detect PK, skipping default is safer than syntax error.
                        dflt = null;
                    }
                    if (dflt) def += ` DEFAULT ${dflt}`;
                }

                // Note: PK detection needs another query or complex logic. 
                // For simplicity in this universal backup, data restoration is priority.
                // Assuming Schema is recreated by Plugin OR we rely on generic Create.

                return def;
            });

            return {
                sql: null, // Postgres doesn't give us easy SQL
                columns: columns
            };
        } catch (err) {
            console.error('❌ Postgres getTableSchema Error:', err.message);
            throw err;
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('🔌 Postgres: Pool Closed.');
        }
    }
}

module.exports = new PostgresDriver();
// Exported for unit tests of the dialect translation.
module.exports.translateSql = translateSql;
module.exports.translateCreateTable = translateCreateTable;
