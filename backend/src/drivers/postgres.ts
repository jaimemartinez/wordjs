/**
 * WordJS - PostgreSQL Driver
 * Implements DatabaseDriverInterface using 'pg'
 */

const DatabaseDriverInterface = require('./interface');
const { Pool } = require('pg');
const config = require('../config/app');

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
            this.pool = new Pool({
                host: dbConfig.host,
                port: dbConfig.port || 5432,
                user: dbConfig.user,
                password: dbConfig.password,
                database: dbConfig.name,
                ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
                // Force UTF-8 encoding to prevent errors on Windows servers with WIN1252 defaults
                connectionString: undefined, // ensure pool uses individual params
                client_encoding: 'UTF8'
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
    normalizeSql(sql) {
        let i = 1;
        // Replace ? with $1, $2, etc.
        return sql.replace(/\?/g, () => `$${i++}`);
    }

    async get(sql, params = []) {
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

    async all(sql, params = []) {
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

    async run(sql, params = []) {
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

    async exec(sql) {
        try {
            await this.pool.query(sql);
        } catch (err) {
            console.error('❌ Postgres Exec Error:', err.message);
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
    async transaction(fn) {
        const client = await this.pool.connect();

        const tx = {
            get: async (sql, params = []) => {
                const res = await client.query(this.normalizeSql(sql), params);
                return res.rows[0];
            },
            all: async (sql, params = []) => {
                const res = await client.query(this.normalizeSql(sql), params);
                return res.rows;
            },
            run: async (sql, params = []) => {
                let normalizedSql = this.normalizeSql(sql);
                // Mirror run(): auto-inject RETURNING * for INSERTs lacking it, so lastID works.
                if (/^\s*INSERT\s+/i.test(normalizedSql) && !/RETURNING\s+/i.test(normalizedSql)) {
                    normalizedSql += ' RETURNING *';
                }
                const res = await client.query(normalizedSql, params);
                // Same id-only attribution as run() — never fabricate lastID from an arbitrary column.
                return { lastID: extractLastId(res.rows), changes: res.rowCount };
            },
            exec: async (sql) => {
                await client.query(sql);
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
            return res.rows.map(r => r.table_name);
        } catch (err) {
            console.error('❌ Postgres getTables Error:', err.message);
            throw err;
        }
    }

    async getTableSchema(tableName) {
        try {
            const res = await this.pool.query(
                "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
                [tableName]
            );

            // Map to generic format roughly compatible with createPluginTable
            const columns = res.rows.map(col => {
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
