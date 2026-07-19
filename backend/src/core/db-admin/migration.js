const path = require('path');
const fs = require('fs');
const config = require('../../config/app');
const configManager = require('../../core/configManager');
const dbManager = require('../../config/database');

let globalStatus = { step: 'idle', progress: 0, currentTable: '', totalTables: 0, warnings: [] };
let targetEncoding = 'UTF8';

/**
 * Sanitize string for the target database encoding.
 * If target is WIN1252, it removes characters that cannot be translated from UTF8.
 */
const sanitizeForEncoding = (str) => {
    if (!str || typeof str !== 'string') return str;
    if (targetEncoding === 'UTF8' || targetEncoding === 'UTF-8') return str;

    // Very basic replacement for most common untranslatable chars if target is restricted
    // This is a "best effort" to let the migration complete.
    return str.replace(/[^\x00-\xFF]/g, (match) => {
        // Map some common ones or just generic placeholder
        const map = { '❱': '>', '❰': '<', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'" };
        return map[match] || '?';
    });
};

// ── Cross-driver data copy: complete, atomic, fail-closed ───────────────────────────────────────
// Replaces the old copy path, which iterated a HARDCODED 11-table list (silently dropping every
// plugin wjp_*, wordjs_analytics, schema_migrations and notifications table on an engine switch),
// used a non-atomic cross-connection BEGIN/COMMIT (each statement grabbed a different pooled
// connection), and treated a row-count mismatch as a mere warning before switching the live DB.
// This copies EVERY user table, recreates non-core schema on the target, runs the DML inside the
// target driver's REAL single-connection transaction(), and FAILS CLOSED — any mismatch throws so
// the transaction rolls back and the caller must not switch config/restart.

// Tables initializeSchema() creates on the target — they already exist there, so only their DATA is
// copied. Every OTHER user table must be recreated on the target before its rows can be inserted.
const CORE_TABLES = new Set([
    'users', 'user_meta', 'posts', 'post_meta', 'comments', 'comment_meta',
    'terms', 'term_taxonomy', 'term_relationships', 'options', 'links', 'notifications',
]);

// Quote an identifier for the target so a reserved-word or hyphenated plugin table/column name is
// safe (double quotes work on Postgres + SQLite, and on MySQL because the migration session runs with
// ANSI_QUOTES). A name that can't be safely quoted aborts the migration FAIL-CLOSED — never silently
// dropped (which was the whole class of bug this rewrite eliminates).
function quoteIdent(name) {
    // Reject a double-quote (breaks quoting), NUL, or ANY whitespace. A whitespace name would slip past
    // the aliased-snapshot reader's table regex and silently empty that table — rejecting it here fails
    // CLOSED with a clear error. Hyphens / dots / reserved words are fine once double-quoted.
    if (typeof name !== 'string' || name.length === 0 || /["\s\u0000]/.test(name)) {
        throw new Error(`Unsafe SQL identifier '${name}' — migration aborted (rename it or migrate that table manually).`);
    }
    return `"${name}"`;
}
const escLit = (s) => String(s).replace(/'/g, "''"); // escape a value into a single-quoted SQL literal

// Coerce a source value into something every target driver accepts: Date → ISO string, nested object
// → JSON, boolean → 0/1. Strings pass through unchanged — the migration REFUSES a lossy (non-UTF8)
// target up-front (see runMigration) rather than silently substituting characters here.
const sanitizeValue = (val) => {
    if (val instanceof Date) return val.toISOString();
    if (val !== null && typeof val === 'object' && !Buffer.isBuffer(val)) return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
};

// Enumerate every user table in the SOURCE (dialect-specific), excluding engine internals + views.
// Does NOT drop odd-looking names — quoteIdent makes special-char names safe, and a truly unsafe name
// throws at use — so a table can never silently vanish from the copy set.
async function listSourceTables(readAll, sourceDriverName) {
    let rows;
    if (sourceDriverName === 'postgres') {
        rows = await readAll("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    } else if (sourceDriverName === 'mysql') {
        rows = await readAll("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    } else {
        rows = await readAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    }
    return rows.map((r) => r.name || r.NAME || r.table_name).filter((n) => typeof n === 'string' && n.length > 0);
}

// Build a target-dialect CREATE TABLE for a non-core table from the source's schema ({sql, columns} —
// the real getTableSchema() shape). Prefer the raw SQLite CREATE (full fidelity: PK, AUTOINCREMENT,
// UNIQUE) when the target driver TRANSLATES it (MySQL) or IS SQLite; for Postgres — whose exec does no
// DDL translation — build from the normalized column list mapped to Postgres types. MySQL TEXT → LONGTEXT
// so plugin content is never silently capped at VARCHAR(255).
// Build a QUOTED column list for a SQLite table from PRAGMA table_info. Used so a Postgres target —
// whose exec can't translate raw SQLite DDL — always has a column list to recreate from, even when the
// source driver has no getTableSchema (sqlite-legacy). Names are quoted (reserved-word / hyphenated
// columns are safe); types stay generic and buildTargetCreate maps them to the target dialect.
async function sqliteColumnsFromPragma(readAll, table) {
    let rows;
    try { rows = await readAll(`PRAGMA table_info(${quoteIdent(table)})`); } catch (_) { return []; }
    return (rows || [])
        .filter((c) => c && c.name)
        .map((c) => `${quoteIdent(c.name)} ${(c.type && String(c.type).trim()) || 'TEXT'}`);
}

function buildTargetCreate(table, schema, targetKind) {
    const qt = quoteIdent(table);
    const rawSql = schema && schema.sql;
    const cols = (schema && schema.columns) || [];
    if (rawSql && (targetKind === 'mysql' || targetKind === 'sqlite')) {
        // Rewrite only the `CREATE TABLE [IF NOT EXISTS] <name>` PREFIX, matching a quoted/bracketed name
        // (any chars) OR a bare identifier — so a hyphenated name like "order-items" isn't truncated by a
        // \w+ name token (which would splice a broken CREATE). Everything after the name is preserved.
        let sql = rawSql.replace(
            /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z0-9_]+)/i,
            `CREATE TABLE IF NOT EXISTS ${qt}`
        );
        if (targetKind === 'mysql') {
            // TEXT → LONGTEXT so plugin content isn't capped at VARCHAR(255) — but NOT when the column is
            // an inline PRIMARY KEY / UNIQUE: MySQL rejects a TEXT/BLOB key without a prefix length, so a
            // `id TEXT PRIMARY KEY` (e.g. schema_migrations) must stay TEXT → the driver maps it to a
            // bounded VARCHAR(255) key. The negative lookahead leaves those key columns alone.
            sql = sql.replace(/\bTEXT\b(?!\s+(?:PRIMARY|UNIQUE))/gi, 'LONGTEXT');
        }
        return sql;
    }
    if (!cols.length) {
        throw new Error(`Cannot recreate table '${table}' on ${targetKind}: no schema (raw CREATE or columns) available from the source.`);
    }
    // KNOWN LIMITATION: the column path (Postgres target, or a Postgres/MySQL source with no raw CREATE)
    // reconstructs from getTableSchema().columns, which does NOT expose PRIMARY KEY / autoincrement — so
    // the recreated plugin table is DATA-complete (every row copies, ids preserved) but may lack its
    // PK/serial. This is not data loss; plugins re-establish their own schema on activation. SQLite→MySQL
    // and SQLite→SQLite keep full fidelity via the raw CREATE above.
    const mapType = (def) => {
        if (targetKind === 'postgres') return def.replace(/\bDATETIME\b/g, 'TIMESTAMP').replace(/\bBLOB\b/g, 'BYTEA');
        if (targetKind === 'mysql') return def.replace(/\bTEXT\b/g, 'LONGTEXT');
        return def;
    };
    return `CREATE TABLE IF NOT EXISTS ${qt} (\n  ${cols.map(mapType).join(',\n  ')}\n)`;
}

// Recreate a non-core table's schema on the target BEFORE the data copy. DDL runs OUTSIDE the copy
// transaction — on MySQL, CREATE TABLE (like TRUNCATE) causes an implicit COMMIT that would end the
// atomic copy. The source schema is captured by the CALLER before the target connects (see
// runMigration) so this never re-reads a source that may alias the target's connection.
async function recreateTableOnTarget(table, ctx) {
    const { schemaByTable, sourceIsSqlite, readAll, targetExec, targetKind } = ctx;
    let schema = (schemaByTable && schemaByTable[table]) || null;
    if ((!schema || (!schema.sql && !(schema.columns || []).length)) && sourceIsSqlite) {
        // sqlite-legacy source (no getTableSchema) — read the canonical CREATE directly.
        const r = await readAll(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${escLit(table)}'`);
        schema = { sql: r && r[0] && r[0].sql, columns: [] };
    }
    if (!schema || (!schema.sql && !(schema.columns || []).length)) {
        throw new Error(`Cannot introspect schema for non-core table '${table}'`);
    }
    await targetExec(buildTargetCreate(table, schema, targetKind));

    // Replay the table's secondary indexes (SQLite source) so a migrated plugin table isn't degraded to
    // full-table scans. Skipped for a Postgres target (raw SQLite index DDL wouldn't translate there);
    // non-fatal — a plugin recreates its indexes idempotently on activation.
    if (sourceIsSqlite && targetKind !== 'postgres') {
        const idx = await readAll(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${escLit(table)}' AND sql IS NOT NULL`);
        for (const row of idx || []) {
            const isql = (row.sql || '').replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `);
            try { await targetExec(isql); } catch (_) { /* non-essential; plugin re-creates on activation */ }
        }
    }
}

// Copy every table's rows into the target through `targetTx` (bound to ONE connection), fail-closed:
// identifiers are quoted (reserved-word/plugin names), rows cleared with DELETE (never TRUNCATE — it
// implicit-commits on MySQL and breaks the transaction), and a row-count mismatch THROWS on the FIRST
// table so the whole unit of work rolls back.
async function copyTablesInto(tables, { sourceRead, targetTx, onProgress }) {
    let totalRows = 0;
    for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        const qt = quoteIdent(table);
        if (onProgress) onProgress(table, i, tables.length);
        const rows = await Promise.resolve(sourceRead.all(`SELECT * FROM ${qt}`));
        await targetTx.exec(`DELETE FROM ${qt}`);
        for (const row of rows) {
            const keys = Object.keys(row);
            if (!keys.length) continue;
            const qcols = keys.map(quoteIdent).join(',');
            // Always '?' — SQLite-dialect in; each driver's tx.run normalizes (Postgres → $n, MySQL/SQLite native '?').
            const placeholders = keys.map(() => '?').join(',');
            const values = Object.values(row).map(sanitizeValue);
            await targetTx.run(`INSERT INTO ${qt} (${qcols}) VALUES (${placeholders})`, values);
        }
        const cntRow = await Promise.resolve(targetTx.get(`SELECT COUNT(*) as c FROM ${qt}`));
        const got = parseInt((cntRow && (cntRow.c ?? cntRow.C)) || 0, 10) || 0;
        if (got !== rows.length) {
            throw new Error(`Row count mismatch after copying '${table}': source ${rows.length} vs target ${got}. Migration aborted; the original database is left untouched.`);
        }
        totalRows += rows.length;
    }
    return totalRows;
}

// Orchestrate: recreate non-core schema (DDL, outside any transaction), then copy ALL data atomically
// and fail-closed. Returns the total rows copied, or THROWS (the caller must then NOT switch config).
async function copyAllTables(ctx) {
    const { tables, nonCore, isAsyncTarget, isMysqlTarget, targetModule, targetWrapper, sourceRead, onProgress } = ctx;

    // 1. Recreate non-core (plugin / analytics / schema_migrations / notifications) tables on the target.
    for (const t of nonCore) {
        await recreateTableOnTarget(t, ctx);
    }

    // 2. Copy all data atomically on ONE pinned connection.
    if (isAsyncTarget) {
        return await targetModule.transaction(async (tx) => {
            // FK/replication toggles run on the PINNED connection (previously issued on throwaway pooled
            // connections, so they never applied to the writes). We deliberately DO NOT force STRICT
            // sql_mode: the live MySQL session runs relaxed (mysql.ts) so SQLite's loose values insert
            // the same way they do at runtime; plugin TEXT is protected from truncation by recreating it
            // as LONGTEXT (buildTargetCreate), not by weaponizing STRICT (which would abort valid data).
            if (isMysqlTarget) {
                await tx.exec('SET FOREIGN_KEY_CHECKS = 0');
            } else {
                // Postgres: disabling FK triggers needs superuser — degrade gracefully on managed
                // instances (the core schema declares no FK constraints, so insert order is safe).
                try { await tx.exec("SET session_replication_role = 'replica'"); } catch (_) { /* non-superuser */ }
            }
            const total = await copyTablesInto(tables, { sourceRead, targetTx: tx, onProgress });
            if (isMysqlTarget) await tx.exec('SET FOREIGN_KEY_CHECKS = 1');
            return total;
        });
    }

    // File-based SQLite target: better-sqlite3 is a single synchronous connection, so its BEGIN/COMMIT
    // is genuinely atomic. Adapt the wrapper to the tx shape copyTablesInto expects.
    const w = targetWrapper;
    const tx = {
        exec: (s) => (w.exec ? w.exec(s) : w.run(s)),
        run: (s, p) => w.prepare(s).run(...(p || [])),
        get: (s) => w.prepare(s).get(),
    };
    w.exec('BEGIN');
    try {
        const total = await copyTablesInto(tables, { sourceRead, targetTx: tx, onProgress });
        w.exec('COMMIT');
        return total;
    } catch (e) {
        try { w.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
    }
}

// Exported for tests of the cross-driver copy (round-trip a seeded DB across engines / drivers).
exports.copyAllTables = copyAllTables;
exports.listSourceTables = listSourceTables;
exports.recreateTableOnTarget = recreateTableOnTarget;
exports.CORE_TABLES = CORE_TABLES;

exports.getStatus = (req, res) => {
    // Check for legacy files to allow cleanup
    const legacyFiles = [];
    const dbType = dbManager.getDbType();
    const currentDriver = dbType.driver;

    // Only allow cleanup if we are NOT using the file execution
    if (currentDriver !== 'sqlite-legacy' && fs.existsSync(path.resolve('./data/wordjs.db'))) legacyFiles.push('wordjs.db');
    if (currentDriver !== 'sqlite-native' && fs.existsSync(path.resolve('./data/wordjs-native.db'))) legacyFiles.push('wordjs-native.db');
    if (currentDriver !== 'postgres' && fs.existsSync(path.resolve('./data/postgres-embed'))) legacyFiles.push('postgres-embed');

    res.json({
        currentDriver,
        availableDrivers: ['sqlite-legacy', 'sqlite-native', 'postgres', 'mysql'],
        status: globalStatus,
        legacyFiles
    });
};

exports.cleanup = (req, res) => {
    const { file } = req.body;
    // Security: Only allow specific filenames to prevent arbitrary deletion
    const ALLOWED = ['wordjs.db', 'wordjs-native.db', 'postgres-embed'];

    if (!ALLOWED.includes(file)) return res.status(403).json({ error: 'Invalid file' });

    const target = path.resolve('./data', file);
    if (fs.existsSync(target)) {
        try {
            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                fs.rmSync(target, { recursive: true, force: true });
            } else {
                fs.unlinkSync(target);

                // Also clean WAL/SHM if they exist
                if (fs.existsSync(target + '-wal')) fs.unlinkSync(target + '-wal');
                if (fs.existsSync(target + '-shm')) fs.unlinkSync(target + '-shm');
            }

            res.json({ success: true, message: 'File deleted' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.status(404).json({ error: 'File not found' });
    }
};

exports.runMigration = async (req, res) => {
    const { targetDriver, dbHost, dbUser, dbPassword, dbName, dbPort } = req.body;
    let targetFile = null;
    let targetDriverModule = null;

    // Safety Checks
    if (!targetDriver || !['sqlite-legacy', 'sqlite-native', 'postgres', 'mysql'].includes(targetDriver)) {
        return res.status(400).json({ error: 'Invalid target driver' });
    }

    const currentDriver = config.dbDriver || 'sqlite-legacy';
    if (targetDriver === currentDriver && targetDriver !== 'postgres' && targetDriver !== 'mysql') {
        // Allow re-migration to postgres/mysql for credential updates, but block file-to-file defaults
        return res.status(400).json({ error: 'Already using this driver' });
    }

    try {
        console.log(`🚀 Migration Started: ${currentDriver} -> ${targetDriver}`);
        globalStatus = { step: 'initializing', progress: 0, currentTable: '', totalTables: 0, warnings: [] };

        // 0. Auto-Install Dependencies (Zero Config)
        if (targetDriver === 'sqlite-native') {
            try { require.resolve('better-sqlite3'); } catch (e) {
                console.log('📦 Installing Native Driver (better-sqlite3)...');
                const { execSync } = require('child_process');
                execSync('npm install better-sqlite3 --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }
        if (targetDriver === 'postgres') {
            try { require.resolve('pg'); } catch (e) {
                console.log('📦 Installing Postgres Driver (pg)...');
                const { execSync } = require('child_process');
                execSync('npm install pg --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }
        if (targetDriver === 'mysql') {
            try { require.resolve('mysql2'); } catch (e) {
                console.log('📦 Installing MySQL Driver (mysql2)...');
                const { execSync } = require('child_process');
                execSync('npm install mysql2 --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }

        // 1. Connect to Source (Current Active DB). Postgres and MySQL are async client-server drivers
        //    (no local file, sync getDb() throws for them); the file-based SQLite drivers use getDb().
        let sourceDb = null;
        if (config.dbDriver !== 'postgres' && config.dbDriver !== 'mysql') {
            sourceDb = dbManager.getDb();
        }
        // ASYNC targets (Postgres + MySQL) share the client-server path: init({dbConfig}) + connect(),
        // schema via the async driver, a `db` connection block in config (not a dbPath file).
        const isPostgresTarget = targetDriver === 'postgres';
        const isMysqlTarget = targetDriver === 'mysql';
        const isAsyncTarget = isPostgresTarget || isMysqlTarget;
        const targetKind = isMysqlTarget ? 'mysql' : (isPostgresTarget ? 'postgres' : 'sqlite');

        // ── Pre-read the SOURCE before the target connects ────────────────────────────────────────
        // Enumerate tables + capture each non-core table's schema from the LIVE source NOW, before the
        // target driver initialises. For a SAME-ENGINE async re-migration (e.g. postgres→postgres to
        // repoint the server, permitted above) source and target are the SAME driver singleton, and
        // targetDriverModule.connect() below OVERWRITES its pool to the target — so reading the source
        // afterwards would read the (empty) target, silently copy 0 rows past the 0===0 guard, and
        // switch the live DB to an empty server. We therefore ALSO snapshot all rows here when aliased.
        const sourceIsAsync = currentDriver === 'postgres' || currentDriver === 'mysql';
        const liveSource = sourceIsAsync ? dbManager.getDbAsync() : sourceDb;
        const liveReadAll = (sql) => Promise.resolve(liveSource.all(sql));
        const liveIntrospector = (() => {
            const m = dbManager.getDbAsync();
            return m && typeof m.getTableSchema === 'function' && typeof m.getTables === 'function' ? m : null;
        })();

        const allTables = await listSourceTables(liveReadAll, currentDriver);
        const nonCore = allTables.filter((t) => !CORE_TABLES.has(t));

        // Capture non-core schema from the live source now (before the target can alias the connection).
        // For a SQLite source we capture BOTH: the raw CREATE (full-fidelity path for MySQL/SQLite targets)
        // AND a PRAGMA column list (the ONLY path a Postgres target can use, since its exec can't translate
        // SQLite DDL) — so no target dialect is left without a usable schema.
        const schemaByTable = {};
        for (const t of nonCore) {
            let s = null;
            if (liveIntrospector) { try { s = await liveIntrospector.getTableSchema(t); } catch (_) { s = null; } }
            let sqlText = s && s.sql;
            let columns = (s && s.columns) || [];
            if (!sourceIsAsync) {
                if (!sqlText) {
                    const r = await liveReadAll(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escLit(t)}'`);
                    sqlText = r && r[0] && r[0].sql;
                }
                columns = await sqliteColumnsFromPragma(liveReadAll, t);
            }
            schemaByTable[t] = { sql: sqlText || null, columns };
        }

        // Same-engine async re-migration aliases source↔target on one singleton → snapshot rows NOW (the
        // only moment the source is still readable). Other combos (different modules, or a sync SQLite
        // source unaffected by the target connecting) stream per-table during the copy.
        const aliased = isAsyncTarget && currentDriver === targetDriver;
        let sourceRead = liveSource;
        if (aliased) {
            // TRADEOFF: buffers the whole DB in memory. Because the source and target share ONE driver
            // singleton, this pre-connect read is the ONLY safe window; a very large same-engine repoint
            // could pressure memory. Acceptable for the CMS's typical data sizes; a future improvement is
            // a streamed second connection or an on-disk spool. quoteIdent(t) throws on a whitespace name,
            // so the snapshot reader's table regex only ever sees safe (quotable) names.
            const snapshot = {};
            for (const t of allTables) snapshot[t] = await liveReadAll(`SELECT * FROM ${quoteIdent(t)}`);
            sourceRead = { all: (sql) => { const m = sql.match(/FROM\s+"?([^"\s]+)"?/i); return (m && snapshot[m[1]]) || []; } };
        }

        // 2. Prepare Target
        let tempTargetFile = null;

        // Simple retry helper for Windows file locking
        const forceDelete = async (f) => {
            if (!fs.existsSync(f)) return;
            try {
                fs.unlinkSync(f);
            } catch (e) {
                if (e.code === 'EBUSY' || e.code === 'EPERM') {
                    // Wait without busy-spinning the event loop (the lock is usually a transient
                    // OneDrive/zombie-reader handle that clears on its own).
                    await new Promise(r => setTimeout(r, 1000));
                    try { fs.unlinkSync(f); } catch (e2) { throw e; }
                } else {
                    throw e;
                }
            }
        };

        if (!isAsyncTarget) {
            const targetFilename = targetDriver === 'sqlite-native' ? 'wordjs-native.db' : 'wordjs.db';
            targetFile = path.resolve('./data', targetFilename);
            // Use a temporary file for writing to avoid locking issues on the main file during the process
            // (e.g. OneDrive syncing, or zombie readers)
            tempTargetFile = targetFile + '.tmp';

            try {
                // Ensure temp is clean
                await forceDelete(tempTargetFile);
                if (fs.existsSync(tempTargetFile + '-wal')) await forceDelete(tempTargetFile + '-wal');
                if (fs.existsSync(tempTargetFile + '-shm')) await forceDelete(tempTargetFile + '-shm');
            } catch (e) {
                console.error('❌ Failed to clean up temp files:', e.message);
                throw new Error(`Temp file locked: ${e.message}`);
            }
        }

        // 3. Connect to Target Driver
        targetDriverModule = require(`../../drivers/${targetDriver}`);

        if (isAsyncTarget) {
            // Dynamic init for an async client-server driver (Postgres / MySQL).
            await targetDriverModule.init({
                dbConfig: { host: dbHost, user: dbUser, password: dbPassword, name: dbName, port: dbPort }
            });
            await targetDriverModule.connect();

            // 3.1 REFUSE a lossy (non-UTF8) target. The old code silently rewrote every non-Latin1
            //     character to '?' — invisible to the row-COUNT guard — permanently mangling content
            //     (emoji, CJK, smart quotes) while reporting success. Fail closed instead: the operator
            //     creates the database with ENCODING 'UTF8'. MySQL always runs utf8mb4, so it's exempt.
            if (isPostgresTarget) {
                try {
                    const encRes = await targetDriverModule.all("SELECT pg_encoding_to_char(encoding) as enc FROM pg_database WHERE datname = current_database()");
                    targetEncoding = encRes[0]?.enc || 'UTF8';
                    console.log(`   Target Encoding: ${targetEncoding}`);
                } catch (encErr) {
                    // Can't verify the encoding → can't guarantee it's UTF8 → fail closed rather than
                    // risk silently mangling non-Latin1 content into '?' on a WIN1252 target.
                    throw new Error(`Could not verify the target Postgres database encoding (${encErr.message}) — migration refused. Ensure the target database uses ENCODING 'UTF8'.`);
                }
                if (targetEncoding !== 'UTF8' && targetEncoding !== 'UTF-8') {
                    throw new Error(`Target Postgres database encoding is ${targetEncoding}, not UTF8 — migration refused to avoid silently corrupting non-Latin1 content. Recreate the target database with ENCODING 'UTF8' and retry.`);
                }
            }
        } else {
            // File-based SQLite driver takes a path — write to .tmp first.
            await targetDriverModule.init({ dbPath: tempTargetFile });
        }

        let targetWrapper;
        if (!isAsyncTarget) {
            targetWrapper = targetDriverModule.get();
            if (targetWrapper.exec) targetWrapper.exec('PRAGMA foreign_keys = OFF;');
            else targetWrapper.run('PRAGMA foreign_keys = OFF;');

            if (targetDriver === 'sqlite-native') {
                // Disable WAL during migration to ensure single-file consistency on exit
                // This prevents 'malformed disk image' errors if WAL checkpointing is incomplete
                targetWrapper.pragma('journal_mode = DELETE');
            }
        }
        // For async targets, the FK/replication-role toggles + STRICT sql_mode now run INSIDE the copy
        // transaction on the PINNED connection (see copyAllTables) — previously they were issued on
        // throwaway pooled connections and never applied to the writing connection.

        // 4. Initialize Schema on Target. For an async target the schema DDL is emitted in the SOURCE
        //    driver's dialect (module-global driverName) and TRANSLATED at the target driver's boundary
        //    — the MySQL driver rewrites sqlite/postgres DDL to MySQL, so this works for any source.
        await dbManager.initializeSchema(isAsyncTarget ? targetDriverModule : targetWrapper, isAsyncTarget);
        console.log('   Schema initialized on target.');

        // 5. Copy ALL user data — complete (every table, dynamically enumerated, NOT a hardcoded list),
        //    atomic (one pinned connection via the driver's transaction()), and FAIL-CLOSED (a row-count
        //    mismatch throws → rollback → the caller never switches the live DB). See copyAllTables above.
        globalStatus.step = 'copying';
        globalStatus.warnings = [];

        // (allTables / nonCore / schemaByTable / sourceRead were captured from the LIVE source above,
        //  BEFORE the target connected — see the pre-read block — so an aliased re-migration can't read
        //  the empty target here.)
        globalStatus.totalTables = allTables.length;
        console.log(`   Copying ${allTables.length} table(s); ${nonCore.length} non-core to recreate: ${nonCore.join(', ') || 'none'}.`);

        const totalRows = await copyAllTables({
            tables: allTables,
            nonCore,
            isAsyncTarget,
            isMysqlTarget,
            targetKind,
            targetModule: targetDriverModule,
            targetWrapper,
            targetExec: isAsyncTarget
                ? (s) => targetDriverModule.exec(s)
                : (s) => (targetWrapper.exec ? targetWrapper.exec(s) : targetWrapper.run(s)),
            schemaByTable,
            // Non-aliased: the source is still live during the copy (index recreation + any sqlite-legacy
            // schema fallback read through it). Aliased: reads the pre-taken snapshot. Never the target.
            readAll: (sql) => Promise.resolve(sourceRead.all(sql)),
            sourceIsSqlite: !sourceIsAsync,
            sourceRead,
            onProgress: (table, i, n) => {
                globalStatus.currentTable = table;
                globalStatus.progress = Math.round((i / n) * 100);
            },
        });

        // Close Source DB now that we are done reading.
        try { if (dbManager.closeDatabase) await dbManager.closeDatabase(); } catch (e) { console.warn('Could not close source DB:', e.message); }

        console.log(`✅ Data copied: ${totalRows} row(s) across ${allTables.length} table(s).`);

        // 6. Persist & Close Target
        if (targetDriverModule.save) targetDriverModule.save();
        if (targetDriverModule.close) await targetDriverModule.close();

        // 7. Atomic Swap (Move .tmp -> Real) with Failover
        let finalPath = targetFile;

        if (tempTargetFile) {
            console.log('   Stats: Swapping temporary database to final location...');
            try {
                // Inline retry delete
                const retryDelete = async (f) => {
                    if (!fs.existsSync(f)) return;
                    try { fs.unlinkSync(f); } catch (e) {
                        // Yield to the event loop for the lock to clear instead of busy-spinning.
                        await new Promise(r => setTimeout(r, 1000));
                        fs.unlinkSync(f);
                    }
                };

                await retryDelete(targetFile);
                if (fs.existsSync(targetFile + '-wal')) await retryDelete(targetFile + '-wal');
                if (fs.existsSync(targetFile + '-shm')) await retryDelete(targetFile + '-shm');

                fs.renameSync(tempTargetFile, targetFile);
            } catch (e) {
                console.warn(`⚠️ Swap Failed (File Locked). Using temporary file '${path.basename(tempTargetFile)}' as the new active database.`);
                // If we can't write to the standard filename, we stick with the temp file
                // This ensures the user doesn't lose data, even if the filename is ugly.
                finalPath = tempTargetFile;
            }
        }

        // 8. Update Configuration
        const newConfig = { dbDriver: targetDriver };
        if (!isAsyncTarget) {
            // Make path relative to backend root (e.g. ./data/wordjs.db)
            // path.relative might return 'data/wordjs.db', we want './data/...' usually, but 'data/...' works too.
            // Let's stick to the current convention of ./data
            const rel = path.relative(process.cwd(), finalPath).replace(/\\/g, '/');
            newConfig.dbPath = rel.startsWith('.') ? rel : `./${rel}`;
        } else {
            // pgConfig is not defined in the provided context, assuming it should be dbHost, dbPort, etc.
            // based on the original code's usage for newConfig.db.
            newConfig.db = {
                host: dbHost,
                port: dbPort,
                user: dbUser,
                name: dbName,
                // Password is usually saved in .env OR config.
                // We'll pass it to saveConfig to decide.
                password: dbPassword
            };
        }

        // Save Backup for Auto-Fallback
        const backupConfig = configManager.getConfig();
        if (backupConfig) {
            const backupFile = path.resolve('wordjs-config.backup.json');
            require('fs').writeFileSync(backupFile, JSON.stringify(backupConfig, null, 2));
        }

        configManager.saveConfig(newConfig);

        res.json({
            success: true,
            message: `Migration successful! Copied ${totalRows} rows to ${targetDriver}. Restarting server...`
        });

        setTimeout(() => {
            console.log('🔄 Restarting server...');

            // Trigger a restart so the new DB config is picked up. In dev (`node --watch`) this means
            // touching the ACTUAL entry node is running — process.argv[1] is src/index.ts under ts-node
            // (or dist/index.js when compiled) — so the watcher reruns it. The previous code hardcoded a
            // non-existent 'src/index.js' (the entry is .ts), so utimesSync threw ENOENT and nothing
            // restarted. In production the server.js supervisor restarts the child after this exit.
            const candidates = [
                process.argv[1],
                path.resolve(__dirname, '../../index.ts'),
                path.resolve(__dirname, '../../index.js')
            ].filter(Boolean);
            let touched = false;
            for (const f of candidates) {
                try {
                    const t = new Date();
                    fs.utimesSync(f, t, t);
                    console.log(`🔄 Touched ${f} to trigger watch restart.`);
                    touched = true;
                    break;
                } catch (err) { /* not this one — try the next candidate */ }
            }
            if (!touched) {
                console.warn('🔄 Could not touch an entry file to trigger a watch restart; relying on process exit (the supervisor restarts in production).');
            }

            process.exit(0);
        }, 1000);

    } catch (e) {
        console.error('Migration Failed:', e);

        // Attempt to cleanup driver connection to release locks
        if (targetDriverModule) {
            try { if (targetDriverModule.exec) await targetDriverModule.exec('ROLLBACK'); } catch (err) { }
            try { if (targetDriverModule.close) await targetDriverModule.close(); } catch (err) { }
        }

        res.status(500).json({ error: e.message });
    }
};
