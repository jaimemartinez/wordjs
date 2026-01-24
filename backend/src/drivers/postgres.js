/**
 * WordJS - PostgreSQL Driver
 * Implements DatabaseDriverInterface using 'pg'
 */

const DatabaseDriverInterface = require('./interface');
const { Pool } = require('pg');
const config = require('../config/app');

class PostgresDriver extends DatabaseDriverInterface {
    constructor() {
        super();
        this.pool = null;
        this.config = null; // Dynamic config override
    }

    /**
     * Initialize with optional config (for migrations)
     */
    async init(options = {}) {
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

            // AUTO-INJECT 'RETURNING id' for INSERTs if missing
            // This makes the driver fully compatible with SQLite-style models
            if (/^\s*INSERT\s+/i.test(normalizedSql) && !/RETURNING\s+/i.test(normalizedSql)) {
                normalizedSql += ' RETURNING *';
            }

            const res = await this.pool.query(normalizedSql, params);

            let lastID = 0;
            // Extract ID if returned
            if (res.rows && res.rows.length > 0) {
                const firstRow = res.rows[0];
                // Check common ID column names
                if (firstRow.id) lastID = firstRow.id;
                else if (firstRow.ID) lastID = firstRow.ID;
                else {
                    // Fallback: take first value
                    const values = Object.values(firstRow);
                    if (values.length > 0) lastID = values[0];
                }
            }

            return {
                lastID: lastID,
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

    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('🔌 Postgres: Pool Closed.');
        }
    }
}

module.exports = new PostgresDriver();
