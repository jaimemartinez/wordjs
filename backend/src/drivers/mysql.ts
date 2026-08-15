/**
 * WordJS - MySQL / MariaDB Driver
 * Implements DatabaseDriverInterface using 'mysql2'.
 *
 * WordJS models, the core schema and plugins all speak ONE dialect: SQLite. The Postgres driver
 * only rewrites `?` placeholders; MySQL needs more, because the SQLite-style DDL/DML the rest of the
 * codebase emits is not all valid MySQL. This driver therefore carries a small **translation layer**
 * (translateSql) that rewrites, at the driver boundary, the handful of constructs that differ:
 *
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT`     → `INTEGER AUTO_INCREMENT PRIMARY KEY`
 *   - `TEXT`                                  → `VARCHAR(255)` (indexable, literal-default-able) or
 *                                               `LONGTEXT` for known long-content columns
 *   - text-column `DEFAULT '' / CURRENT_TIMESTAMP` → parenthesised EXPRESSION default (MySQL ≥ 8.0.13
 *                                               is the only way TEXT/BLOB and CURRENT_TIMESTAMP-on-text
 *                                               columns may carry a default)
 *   - `INSERT OR IGNORE` → `INSERT IGNORE`,  `INSERT OR REPLACE` → `REPLACE`
 *   - `CREATE [UNIQUE] INDEX IF NOT EXISTS`   → `CREATE [UNIQUE] INDEX` (MySQL has no IF NOT EXISTS
 *                                               for indexes; the driver swallows the idempotent
 *                                               "duplicate key name" error on re-runs)
 *
 * Identifier quoting: the session runs with sql_mode=ANSI_QUOTES so `"col"` is an identifier exactly
 * like SQLite/Postgres (WordJS already single-quotes string literals to work on Postgres). Dates are
 * returned as strings (dateStrings) since WordJS stores timestamps as TEXT.
 */

const DatabaseDriverInterface = require('./interface');
const mysql = require('mysql2/promise');
// Static SqlString helpers re-exported by mysql2 — escape() / escapeId() are CodeQL-recognized
// SQL-injection barriers, used for the dynamic identifiers (user, table) in the role-isolation DDL below.
const mysqlSync = require('mysql2');
const config = require('../config/app');

// Allowlist for any identifier interpolated into isolation DDL (plugin DB user, table name). A caller
// only ever passes normalized wjp_<slug>_ names, but we re-validate at the driver boundary: reject
// anything outside [a-z0-9_], not starting with a digit, or longer than a MySQL identifier (64).
function safeIdent(name: string): string {
    const s = String(name);
    if (!/^[a-z_][a-z0-9_]*$/.test(s) || s.length > 64) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
    return s;
}

// Core columns that legitimately hold long content and must become LONGTEXT (never VARCHAR(255), which
// would truncate). Everything else maps to VARCHAR(255) so it stays indexable and can keep a literal
// default. Keyed by column NAME (lower-cased); indexed/short columns are deliberately excluded.
const LONG_TEXT_COLUMNS = new Set([
    'post_content', 'post_content_filtered', 'post_excerpt', 'post_title', 'guid', 'to_ping', 'pinged',
    'meta_value', 'comment_content', 'comment_agent', 'description', 'message', 'data', 'option_value',
    'link_description', 'link_notes', 'link_image', 'link_url', 'action_url', 'metadata',
    'fields', // form_submissions.fields — the submitted key→value map as JSON (route-bounded at 64KB)
    'detail' // audit_log.detail — the small sanitized JSON blob for an audit event (never a secret)
]);

// Strip `-- line` and `/* block */` comments (string-literal aware). Core DDL sometimes carries inline
// comments whose text contains commas (e.g. the analytics table) — leaving them in would make the
// top-level column split break inside the comment. Plugin DDL never has comments (createPluginTable
// rejects them), so this only cleans up trusted core DDL.
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

    const nameMatch = def.trim().match(/^["`]?(\w+)["`]?/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    let d = def;

    // Auto-increment primary key (SQLite / Postgres forms → MySQL).
    d = d.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'INTEGER AUTO_INCREMENT PRIMARY KEY');
    d = d.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/i, 'INTEGER AUTO_INCREMENT PRIMARY KEY');
    d = d.replace(/\bSERIAL\b/i, 'INTEGER AUTO_INCREMENT');

    // TEXT → VARCHAR(255) (default) or LONGTEXT (known long content). Skip if already a *TEXT variant.
    const isTextCol = /\bTEXT\b/i.test(d) && !/\b(LONG|MEDIUM|TINY)TEXT\b/i.test(d);
    if (isTextCol) {
        d = d.replace(/\bTEXT\b/i, LONG_TEXT_COLUMNS.has(name) ? 'LONGTEXT' : 'VARCHAR(255)');
        // MySQL rejects a literal default on TEXT/BLOB, and CURRENT_TIMESTAMP as a literal default on a
        // non-datetime column — both are legal only as parenthesised EXPRESSION defaults (≥ 8.0.13).
        d = d.replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/i, 'DEFAULT (CURRENT_TIMESTAMP)');
        d = d.replace(/\bDEFAULT\s+('(?:[^']|'')*')/i, 'DEFAULT ($1)'); // literal string default → (…)
    }
    return d;
}

function translateCreateTable(sql: string): string {
    sql = stripSqlComments(sql);
    const m = sql.match(/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?\w+["`]?\s*)\(([\s\S]*)\)(\s*)$/i);
    if (!m) return sql;
    const cols = splitTopLevel(m[2]).map((c) => c.trim()).filter(Boolean).map(translateColumnDef);
    return `${m[1]}(\n  ${cols.join(',\n  ')}\n)${m[3] || ''}`;
}

/** Rewrite one SQLite-dialect statement to MySQL. */
function translateSql(sql: string): string {
    if (typeof sql !== 'string') return sql;
    if (/^\s*CREATE\s+TABLE\b/i.test(sql)) return translateCreateTable(sql);
    let s = sql;
    // MySQL has no RETURNING; strip it (like the legacy sql.js driver does) and rely on insertId — which
    // is exactly the AUTO_INCREMENT key these `RETURNING id` / `RETURNING term_id` clauses return.
    s = s.replace(/\s+RETURNING\s+[\s\S]*$/i, '');
    s = s.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');
    s = s.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
    // MySQL has no IF NOT EXISTS for CREATE INDEX; strip it and treat the idempotent re-run error as ok.
    s = s.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, (_m, u) => `CREATE ${u || ''}INDEX`);
    // A MySQL functional-index key part needs an extra set of parens: (LOWER(x)) → ((LOWER(x))).
    // (A partial-index `... WHERE <expr>` has no MySQL equivalent; those statements are wrapped in
    // try/catch by the caller and simply skipped — app-layer logic enforces that uniqueness.)
    if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(s)) {
        s = s.replace(/\(\s*(LOWER\s*\([^()]*\))\s*\)/gi, '(($1))');
    }
    // Upsert: SQLite (≥3.24) and Postgres both accept `ON CONFLICT`, so core writes it unconditionally.
    // MySQL has no ON CONFLICT — map DO NOTHING → INSERT IGNORE, and DO UPDATE SET → ON DUPLICATE KEY
    // UPDATE (with `excluded.col` → `VALUES(col)`). Requires a UNIQUE/PRIMARY key on the conflict target,
    // which the schema provides (e.g. the options(option_name) unique index).
    if (/\bON\s+CONFLICT\b/i.test(s)) {
        if (/\bDO\s+NOTHING\b/i.test(s)) {
            s = s.replace(/\s*\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING\b/gi, '');
            s = s.replace(/^(\s*)INSERT\s+INTO\b/i, '$1INSERT IGNORE INTO');
        } else {
            s = s.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\b/gi, 'ON DUPLICATE KEY UPDATE');
            s = s.replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)');
        }
    }
    return s;
}

// True when an error is a benign idempotent re-run we can ignore (e.g. re-creating an index that the
// boot path creates every start, since we stripped IF NOT EXISTS).
function isBenignDup(err: any, sql: string): boolean {
    if (!err) return false;
    if ((err.errno === 1061 || err.code === 'ER_DUP_KEYNAME') && /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql)) return true;
    return false;
}

class MysqlDriver extends DatabaseDriverInterface {
    pool: any;
    config: any;
    // Per-plugin low-privilege pools, keyed by DB user name (see runAsUser / getScopedPool below).
    scopedPools: Map<string, any> = new Map();

    constructor() {
        super();
        this.pool = null;
        this.config = null;
    }

    async init(options: any = {}) {
        if (options.dbConfig) this.config = options.dbConfig;
    }

    async connect() {
        const dbConfig = this.config || config.db;
        console.log(`🔌 MySQL: Connecting to ${dbConfig.host}:${dbConfig.port || 3306}/${dbConfig.name}...`);
        try {
            this.pool = mysql.createPool({
                host: dbConfig.host,
                port: dbConfig.port || 3306,
                user: dbConfig.user,
                password: dbConfig.password,
                database: dbConfig.name,
                waitForConnections: true,
                connectionLimit: dbConfig.connectionLimit || 10,
                multipleStatements: true, // migrations/exec may ship several statements at once
                charset: 'utf8mb4_unicode_ci',
                dateStrings: true,        // WordJS stores/reads timestamps as TEXT, not JS Date
                ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined
            });

            // Every physical connection speaks the same dialect as SQLite/Postgres: "x" is an identifier
            // (ANSI_QUOTES), and STRICT is relaxed so the SQLite-style '' / 0 defaults and loose typing
            // don't reject inserts the other drivers accept.
            //
            // NO_BACKSLASH_ESCAPES was REMOVED (was: a data-corruption + syntax bug). node-mysql2 escapes
            // string parameters with BACKSLASH escaping (a value's `'` becomes `\'`, `\` becomes `\\`).
            // With NO_BACKSLASH_ESCAPES the server treats `\` as a literal, so `\'` ended the string one
            // char early — any value with a quote broke the SQL (an apostrophe in a title; the FULLTEXT
            // search term `'1'='1'` is what CI caught) and any value with a backslash was stored doubled.
            // Default (backslash-escapes ON) is exactly what mysql2's escaping assumes, so this is the
            // correct mode; ANSI_QUOTES/NO_ENGINE_SUBSTITUTION stay.
            // NOTE: the pool's 'connection' event hands back the RAW (callback-style) connection, not a
            // promise wrapper — so use a callback here, never .then/.catch (that throws "not a promise").
            this.pool.on('connection', (conn: any) => {
                conn.query("SET SESSION sql_mode='ANSI_QUOTES,NO_ENGINE_SUBSTITUTION'", () => { });
            });

            const conn = await this.pool.getConnection();
            await conn.query("SET SESSION sql_mode='ANSI_QUOTES,NO_ENGINE_SUBSTITUTION'");
            const [rows] = await conn.query('SELECT VERSION() AS v');
            conn.release();
            console.log('✅ MySQL: Connected successfully to', rows[0].v);
        } catch (err: any) {
            console.error('❌ MySQL: Connection failed:', err.message);
            throw err;
        }
    }

    async get(sql: string, params: any[] = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql), params);
            return Array.isArray(rows) ? rows[0] : undefined;
        } catch (err: any) {
            console.error('❌ MySQL Query Error (get):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async all(sql: string, params: any[] = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql), params);
            return Array.isArray(rows) ? rows : [];
        } catch (err: any) {
            console.error('❌ MySQL Query Error (all):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async run(sql: string, params: any[] = []) {
        const translated = translateSql(sql);
        try {
            const [result] = await this.pool.query(translated, params);
            // mysql2 returns a ResultSetHeader for writes: insertId is the AUTO_INCREMENT value (0 for a
            // table without one — matching better-sqlite3/Postgres lastID semantics), affectedRows the
            // row count. RETURNING is not needed.
            return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
        } catch (err: any) {
            if (isBenignDup(err, translated)) return { lastID: 0, changes: 0 };
            console.error('❌ MySQL Query Error (run):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async exec(sql: string) {
        const translated = translateSql(sql);
        try {
            await this.pool.query(translated);
        } catch (err: any) {
            if (isBenignDup(err, translated)) return;
            console.error('❌ MySQL Exec Error:', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    /**
     * Atomic transaction on a single pinned connection: BEGIN → fn(tx) → COMMIT, ROLLBACK on throw.
     * tx.get/all/run/exec use the SAME translation as the top-level methods so callers write identical
     * SQLite-style SQL inside and outside a transaction.
     */
    async transaction(fn: any) {
        const conn = await this.pool.getConnection();
        const tx = {
            get: async (sql: string, params: any[] = []) => {
                const [rows] = await conn.query(translateSql(sql), params);
                return Array.isArray(rows) ? rows[0] : undefined;
            },
            all: async (sql: string, params: any[] = []) => {
                const [rows] = await conn.query(translateSql(sql), params);
                return Array.isArray(rows) ? rows : [];
            },
            run: async (sql: string, params: any[] = []) => {
                const translated = translateSql(sql);
                try {
                    const [result] = await conn.query(translated, params);
                    return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
                } catch (err: any) {
                    if (isBenignDup(err, translated)) return { lastID: 0, changes: 0 };
                    throw err;
                }
            },
            exec: async (sql: string) => {
                const translated = translateSql(sql);
                try { await conn.query(translated); }
                catch (err: any) { if (!isBenignDup(err, translated)) throw err; }
            }
        };
        try {
            await conn.beginTransaction();
            const result = await fn(tx);
            await conn.commit();
            return result;
        } catch (err: any) {
            try { await conn.rollback(); }
            catch (rbErr: any) { console.error('❌ MySQL ROLLBACK failed:', rbErr && rbErr.message); }
            throw err;
        } finally {
            conn.release();
        }
    }

    async getTables() {
        try {
            const [rows] = await this.pool.query(
                'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
            );
            return rows.map((r: any) => r.name || r.NAME || r.table_name);
        } catch (err: any) {
            console.error('❌ MySQL getTables Error:', err.message);
            throw err;
        }
    }

    async getTableSchema(tableName: string) {
        try {
            const [rows] = await this.pool.query(
                'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
                [tableName]
            );
            const columns = rows.map((col: any) => {
                let type = String(col.column_name ? col.data_type : col.DATA_TYPE || '').toUpperCase();
                if (type.includes('CHAR') || type.includes('TEXT')) type = 'TEXT';
                else if (type.includes('INT')) type = 'INTEGER';
                else if (type.includes('DATETIME') || type.includes('TIMESTAMP')) type = 'DATETIME';
                else if (type.includes('JSON')) type = 'TEXT';
                const cname = col.column_name || col.COLUMN_NAME;
                let def = `${cname} ${type}`;
                if ((col.is_nullable || col.IS_NULLABLE) === 'NO') def += ' NOT NULL';
                return def;
            });
            return { sql: null, columns };
        } catch (err: any) {
            console.error('❌ MySQL getTableSchema Error:', err.message);
            throw err;
        }
    }

    // ── Per-plugin DB user isolation (defense-in-depth BELOW the SQL text-guard) ──────────────────
    // MySQL has no usable SET ROLE equivalent for this: SET ROLE only *activates already-granted roles*
    // for the connected user and can't strip the admin user's DIRECT privileges, so a role switch on the
    // admin connection would still see every table. True isolation therefore needs a SEPARATE login user
    // per plugin, GRANTed only its own wjp_<slug>_ tables, with the plugin's DML/SELECT run on a pool
    // authenticated AS that user — so the DATABASE denies any cross-plugin/core access. Requires the pool
    // user to hold CREATE USER + GRANT OPTION; callers fall back to the text-guard alone if it doesn't.

    /** CREATE (or reset the password of) a plugin's low-privilege login user. Idempotent. */
    async ensurePluginUser(user: string, password: string): Promise<void> {
        const uLit = mysqlSync.escape(safeIdent(user));
        const pLit = mysqlSync.escape(String(password));
        await this.pool.query(`CREATE USER IF NOT EXISTS ${uLit}@'%' IDENTIFIED BY ${pLit}`);
        // Always (re)set the password so a fresh process boot owns the credential its scoped pool will use.
        await this.pool.query(`ALTER USER ${uLit}@'%' IDENTIFIED BY ${pLit}`);
    }

    /** GRANT CRUD on ONE existing table to a plugin user. */
    async grantPluginTableToUser(user: string, table: string): Promise<void> {
        const uLit = mysqlSync.escape(safeIdent(user));
        const db = mysqlSync.escapeId(String((this.config || config.db).name));
        const tbl = mysqlSync.escapeId(safeIdent(table));
        await this.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db}.${tbl} TO ${uLit}@'%'`);
    }

    /** GRANT CRUD on every EXISTING wjp_<slug>_* table to a plugin user (initial provisioning). */
    async grantPluginPrefixToUser(user: string, prefix: string): Promise<void> {
        const dbName = String((this.config || config.db).name);
        // Escape LIKE metacharacters in the literal prefix. sql_mode=NO_BACKSLASH_ESCAPES means '\' is NOT
        // a LIKE escape here, so use an explicit ESCAPE clause with a char that never appears in a table name.
        const likePat = String(prefix).replace(/[%_!]/g, (m) => '!' + m) + '%';
        const [rows] = await this.pool.query(
            "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ? ESCAPE '!'",
            [dbName, likePat]
        );
        for (const r of rows) {
            const t = r.t || r.T || r.table_name;
            if (t) await this.grantPluginTableToUser(user, String(t).toLowerCase());
        }
    }

    /** DROP a plugin user (on uninstall) and dispose its scoped pool. */
    async dropPluginUser(user: string): Promise<void> {
        const key = safeIdent(user);
        const p = this.scopedPools.get(key);
        if (p) { try { await p.end(); } catch { /* */ } this.scopedPools.delete(key); }
        const uLit = mysqlSync.escape(key);
        await this.pool.query(`DROP USER IF EXISTS ${uLit}@'%'`);
    }

    /** Lazily build (and cache) a small pool authenticated AS the plugin user. multipleStatements OFF. */
    getScopedPool(user: string, password: string): any {
        const key = safeIdent(user);
        let p = this.scopedPools.get(key);
        if (p) return p;
        const dbConfig = this.config || config.db;
        p = mysql.createPool({
            host: dbConfig.host,
            port: dbConfig.port || 3306,
            user: key,
            password: String(password),
            database: dbConfig.name,
            waitForConnections: true,
            connectionLimit: dbConfig.pluginConnectionLimit || 3,
            multipleStatements: false, // a sandboxed plugin never runs stacked statements
            charset: 'utf8mb4_unicode_ci',
            dateStrings: true,
            ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined
        });
        p.on('connection', (conn: any) => {
            conn.query("SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION'", () => { });
        });
        this.scopedPools.set(key, p);
        return p;
    }

    /** Run a plugin's DML/SELECT AS its low-privilege user — the DB enforces table isolation. */
    async runAsUser(user: string, password: string, method: 'all' | 'get' | 'run', sql: string, params: any[] = []): Promise<any> {
        const pool = this.getScopedPool(user, password);
        const translated = translateSql(sql);
        const [result] = await pool.query(translated, params);
        if (method === 'all') return Array.isArray(result) ? result : [];
        if (method === 'get') return Array.isArray(result) ? result[0] : undefined;
        return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
    }

    async close() {
        for (const p of this.scopedPools.values()) { try { await p.end(); } catch { /* */ } }
        this.scopedPools.clear();
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('🔌 MySQL: Pool Closed.');
        }
    }
}

module.exports = new MysqlDriver();
// Exported for unit tests of the dialect translation.
module.exports.translateSql = translateSql;
module.exports.translateCreateTable = translateCreateTable;
