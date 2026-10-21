const path = require('path');
const fs = require('fs');
const config = require('../../config/app');
const configManager = require('../../core/configManager');
const dbManager = require('../../config/database');
// THE one TEXT→MySQL-type rule, shared with drivers/mysql.ts. Dependency-free on purpose (it does not
// pull in mysql2), so requiring it here keeps migration.js loadable on an install that has no MySQL.
const { rewriteTextForMysql } = require('../../drivers/mysql-text-rule');
const log = require('../module-logger').moduleLogger('core/db-admin/migration');

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
    // A Postgres TIMESTAMP comes back from `pg` as a Date (parsed in local time). Written back as
    // `YYYY-MM-DD HH:MM:SS.mmm` in the same local time — every engine takes that, while MySQL's strict
    // mode refuses an ISO `…T…Z` string, which made every Postgres → MySQL switch fail.
    if (val instanceof Date) return require('../portable-dump').localTimestamp(val);
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
        rows = await readAll("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
    } else if (sourceDriverName === 'mysql') {
        rows = await readAll("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    } else {
        rows = await readAll("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        // A SQLite VIRTUAL table (the FTS5 search index `posts_fts`) and the shadow tables that back it
        // (`posts_fts_data`, `_idx`, `_content`, `_docsize`, `_config`) are not data: they are an index
        // the target engine builds its own way (FTS5 on SQLite, a tsvector on Postgres, FULLTEXT on
        // MySQL — see rebuildEngineSpecificSchema). Copying them sent `CREATE VIRTUAL TABLE … USING fts5`
        // to Postgres/MySQL, so no SQLite-native site could ever switch engine.
        const virtualTables = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(r.sql || ''))).map((r) => r.name);
        const isIndexTable = (name) => virtualTables.some((v) => name === v || SQLITE_SHADOW_SUFFIXES.some((sfx) => name === v + sfx));
        rows = rows.filter((r) => !isIndexTable(r.name));
    }
    return rows.map((r) => r.name || r.NAME || r.table_name).filter((n) => typeof n === 'string' && n.length > 0);
}
const SQLITE_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

// Columns the SOURCE engine computes itself (Postgres `GENERATED ALWAYS … STORED` — posts.search_vector —
// and MySQL generated columns). No engine accepts an INSERT into them (the target computes its own), so
// the copy leaves them out. { table: Set(column) }.
async function listGeneratedColumns(readAll, sourceDriverName) {
    let rows = [];
    try {
        if (sourceDriverName === 'postgres') {
            rows = await readAll("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND is_generated = 'ALWAYS'");
        } else if (sourceDriverName === 'mysql') {
            rows = await readAll("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND extra LIKE '%GENERATED%'");
        }
    } catch (_) { rows = []; }
    const out = {};
    for (const r of rows || []) {
        const t = r.t || r.T || r.table_name || r.TABLE_NAME;
        const c = r.c || r.C || r.column_name || r.COLUMN_NAME;
        if (t && c) (out[t] = out[t] || new Set()).add(c);
    }
    return out;
}

// Order the copy so a table comes after every table it references (SQLite source: PRAGMA
// foreign_key_list). The core schema declares no foreign keys, but a plugin's tables may, and a Postgres
// target only lets a superuser switch FK checks off: for everyone else the order is what keeps every
// INSERT valid. Cycles and references to tables outside the copy keep their listed order.
async function orderByForeignKeys(tables, readAll, sourceIsSqlite) {
    if (!sourceIsSqlite || typeof readAll !== 'function') return tables;
    const deps = {};
    for (const t of tables) {
        let fks = [];
        try { fks = await readAll(`PRAGMA foreign_key_list(${quoteIdent(t)})`); } catch (_) { fks = []; }
        deps[t] = new Set((fks || []).map((f) => f && f.table).filter((r) => r && r !== t && tables.includes(r)));
    }
    const out = [], seen = new Set(), visiting = new Set();
    const visit = (t) => {
        if (seen.has(t) || visiting.has(t)) return;
        visiting.add(t);
        for (const d of deps[t] || []) visit(d);
        visiting.delete(t); seen.add(t); out.push(t);
    };
    for (const t of tables) visit(t);
    return out;
}

// Build a target-dialect CREATE TABLE for a non-core table from the source's schema ({sql, columns} —
// the real getTableSchema() shape). Prefer the raw SQLite CREATE (full fidelity: PK, AUTOINCREMENT,
// UNIQUE) whenever it's available, because EVERY async target driver now TRANSLATES it at its boundary
// (MySQL: AUTOINCREMENT→AUTO_INCREMENT, TEXT→VARCHAR/LONGTEXT; Postgres: INTEGER PRIMARY KEY
// AUTOINCREMENT→SERIAL PRIMARY KEY, DATETIME→TIMESTAMP, BLOB→BYTEA) and SQLite IS the source dialect.
// Only a source with NO raw CREATE (a Postgres/MySQL source, whose getTableSchema returns sql:null)
// falls back to the normalized column list mapped to the target's types. On MySQL the TEXT decision
// comes from ONE shared rule (drivers/mysql-text-rule.ts): LONGTEXT unless the column takes part in a
// key, so plugin content is never silently capped at VARCHAR(255) and a key column stays indexable.
// Build a QUOTED column list for a SQLite table from PRAGMA table_info. Used as the fallback recreate
// path when no raw CREATE is available (e.g. a sqlite-legacy source that has no getTableSchema). Names
// are quoted (reserved-word / hyphenated columns are safe); types stay generic and buildTargetCreate
// maps them to the target dialect.
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
    if (rawSql) {
        // Full-fidelity path (PK / AUTOINCREMENT / UNIQUE preserved). Every target dialect can take the
        // raw SQLite CREATE now: SQLite IS the source dialect, and the MySQL and Postgres drivers each
        // TRANSLATE it at their exec boundary (see drivers/mysql.ts, drivers/postgres.ts).
        //
        // Rewrite only the `CREATE TABLE [IF NOT EXISTS] <name>` PREFIX, matching a quoted/bracketed name
        // (any chars) OR a bare identifier — so a hyphenated name like "order-items" isn't truncated by a
        // \w+ name token (which would splice a broken CREATE). Everything after the name is preserved and
        // handed to the driver, which does the dialect rewrite (INTEGER PRIMARY KEY AUTOINCREMENT →
        // SERIAL PRIMARY KEY / AUTO_INCREMENT, DATETIME → TIMESTAMP, BLOB → BYTEA, TEXT → LONGTEXT, …).
        let sql = rawSql.replace(
            /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z0-9_]+)/i,
            `CREATE TABLE IF NOT EXISTS ${qt}`
        );
        if (targetKind === 'mysql') {
            // MySQL is the one dialect where a bare-statement TEXT rewrite also happens HERE (not only in
            // the driver): plugin content must not be capped at VARCHAR(255). This used to be a private
            // regex with a negative lookahead — `\bTEXT\b(?!\s+(?:PRIMARY|UNIQUE))` — and that copy was
            // strictly WEAKER than the driver's rule: its lookahead only saw a key word IMMEDIATELY after
            // the type, so `uuid TEXT NOT NULL UNIQUE` (core notifications) and any column named by a
            // TABLE-LEVEL `UNIQUE (…)` / `KEY (…)` became LONGTEXT and MySQL killed the CREATE with
            // errno 1170 ("BLOB/TEXT column used in key specification without a key length"). One rule,
            // one implementation: drivers/mysql-text-rule.ts. Applying it here AND at the driver's exec
            // boundary is deliberate defence in depth — the rule is idempotent (`\bTEXT\b` matches
            // neither LONGTEXT nor VARCHAR(255)), so the second pass is a no-op.
            sql = rewriteTextForMysql(sql);
        }
        return sql;
    }
    if (!cols.length) {
        throw new Error(`Cannot recreate table '${table}' on ${targetKind}: no schema (raw CREATE or columns) available from the source.`);
    }
    // FALLBACK column path — reached ONLY when the source exposes no raw CREATE (a Postgres/MySQL source,
    // whose getTableSchema returns sql:null). getTableSchema().columns does NOT expose PRIMARY KEY /
    // autoincrement, so a table recreated this way is DATA-complete (every row copies, ids preserved) but
    // may lack its PK/serial. This is not data loss; plugins re-establish their own schema on activation.
    // A SQLite source (the common case) always has the raw CREATE above, so it keeps full fidelity on
    // EVERY target, Postgres included.
    const mapType = (def) => {
        if (targetKind === 'postgres') return def.replace(/\bDATETIME\b/g, 'TIMESTAMP').replace(/\bBLOB\b/g, 'BYTEA');
        return def; // MySQL's TEXT decision is made on the assembled statement below, by the shared rule.
    };
    const created = `CREATE TABLE IF NOT EXISTS ${qt} (\n  ${cols.map(mapType).join(',\n  ')}\n)`;
    // Same ONE rule as the raw-CREATE path above, applied to the statement we just assembled, so this
    // fallback can never drift from it (an unconditional `TEXT → LONGTEXT` here was the third copy of a
    // decision that only ever needs one). These columns carry no key information at all — getTableSchema()
    // .columns does not expose PRIMARY KEY — so the rule sees no key parts and correctly leaves every TEXT
    // uncapped; a later `CREATE INDEX` over one of them is widened by the driver (ensureIndexableKeyParts).
    return targetKind === 'mysql' ? rewriteTextForMysql(created) : created;
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
async function copyTablesInto(tables, { sourceRead, targetTx, onProgress, generatedColumns }) {
    let totalRows = 0;
    for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        const qt = quoteIdent(table);
        if (onProgress) onProgress(table, i, tables.length);
        const rows = await Promise.resolve(sourceRead.all(`SELECT * FROM ${qt}`));
        await targetTx.exec(`DELETE FROM ${qt}`);
        const skip = (generatedColumns && generatedColumns[table]) || null;
        for (const row of rows) {
            if (skip) for (const c of skip) delete row[c];
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
    const { nonCore, isAsyncTarget, isMysqlTarget, targetModule, targetWrapper, sourceRead, onProgress, generatedColumns } = ctx;
    const tables = await orderByForeignKeys(ctx.tables, ctx.readAll, ctx.sourceIsSqlite);

    // 1. Recreate non-core (plugin / analytics / schema_migrations / notifications) tables on the target.
    for (const t of nonCore) {
        await recreateTableOnTarget(t, ctx);
    }

    // 2. Copy all data atomically on ONE pinned connection.
    if (isAsyncTarget) {
        return await targetModule.transaction(async (tx) => {
            // FK/replication toggles run on the PINNED connection (previously issued on throwaway pooled
            // connections, so they never applied to the writes).
            //
            // THE COPY RUNS UNDER STRICT sql_mode, and nothing here relaxes it. That is deliberate, and
            // it is the opposite of what this comment used to claim ("the live MySQL session runs
            // relaxed so SQLite's loose values insert the same way they do at runtime") — the session
            // mode is now ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION for every connection
            // the driver opens (SESSION_SQL_MODE, drivers/mysql.ts), so the copy sees exactly what the
            // live site will see. What a value that does not fit does now: MySQL raises the error, this
            // transaction rolls back, runMigration rethrows and the caller does NOT switch config — the
            // engine change fails and the ORIGINAL database is left untouched. That is the intended
            // outcome. A migration that silently truncated a row on the way in would hand the operator
            // a target that passes the row-COUNT guard while holding mutilated content, and the switch
            // would be irreversible. The width itself is not the failure mode: plugin/content TEXT is
            // recreated as LONGTEXT by the shared rule (buildTargetCreate → rewriteTextForMysql), so
            // only a value that genuinely cannot fit a key column's VARCHAR(255) can abort the copy.
            if (isMysqlTarget) {
                await tx.exec('SET FOREIGN_KEY_CHECKS = 0');
            } else {
                // Postgres: switching FK triggers off needs a superuser. On an ordinary application role
                // (the documented setup, and every managed database) the SET fails — and in Postgres a
                // failed statement ABORTS the whole transaction ("current transaction is aborted"), which
                // a JS try/catch cannot undo. A SAVEPOINT can: roll back to it and carry on; the copy
                // order (orderByForeignKeys) keeps the inserts valid without the switch.
                await tx.exec('SAVEPOINT wjs_replication_role');
                try {
                    await tx.exec("SET LOCAL session_replication_role = 'replica'");
                    await tx.exec('RELEASE SAVEPOINT wjs_replication_role');
                } catch (_) {
                    await tx.exec('ROLLBACK TO SAVEPOINT wjs_replication_role');
                }
            }
            const total = await copyTablesInto(tables, { sourceRead, targetTx: tx, onProgress, generatedColumns });
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
        const total = await copyTablesInto(tables, { sourceRead, targetTx: tx, onProgress, generatedColumns });
        w.exec('COMMIT');
        return total;
    } catch (e) {
        try { w.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
    }
}

/**
 * Every table the core's schema migrations create (content_outbox, api_tokens, webhooks, audit_log,
 * collab_*, …), built on the TARGET by its own migrations before the copy — with its real primary key and
 * auto-increment. Recreated from a Postgres/MySQL source's bare column list instead (the only schema those
 * engines expose here), they had neither, and the first post written after the switch failed on the
 * outbox insert. Only tables no migration knows (a plugin's) are recreated from the source afterwards
 * (CREATE TABLE IF NOT EXISTS skips the rest). On an empty target the data migrations are no-ops.
 */
async function buildTargetSchema(target, isAsync, targetDriver) {
    const { runSchemaMigrations } = require('../schema-migrations');
    await runSchemaMigrations(target, isAsync, targetDriver);
}
exports.buildTargetSchema = buildTargetSchema;

/**
 * The schema migrations that build an ENGINE-SPECIFIC structure (search index, unique indexes). The
 * copied `schema_migrations` rows say they ran — on the SOURCE engine. On the target they are cleared
 * and run again under the target's own driver name, after the data is in (so a full-text index covers
 * the copied posts). Each of them is idempotent.
 */
async function rebuildEngineSpecificSchema(target, isAsync, targetDriver) {
    const { runSchemaMigrations, MIGRATIONS, ENGINE_SPECIFIC_MIGRATIONS } = require('../schema-migrations');
    for (const id of ENGINE_SPECIFIC_MIGRATIONS) {
        // No schema_migrations table yet (a source without one): nothing to clear, the runner creates it.
        try { await Promise.resolve(target.run('DELETE FROM schema_migrations WHERE id = ?', [id])); } catch (_) { /* */ }
    }
    await runSchemaMigrations(target, isAsync, targetDriver, MIGRATIONS.filter((m) => ENGINE_SPECIFIC_MIGRATIONS.includes(m.id)));
    if (targetDriver === 'postgres') await resetPgSequences(target);
}

/**
 * Postgres: move every serial/identity sequence past the highest id now in its table. The copy INSERTs
 * the source's ids explicitly, which never advances a sequence — so the first post, user or comment
 * created after a switch to Postgres (or after a restore) was handed id 1 and refused as a duplicate.
 * MySQL's AUTO_INCREMENT and SQLite's rowid follow explicit ids on their own.
 */
async function resetPgSequences(db) {
    const cols = (await db.all(
        "SELECT table_name AS t, column_name AS c FROM information_schema.columns " +
        "WHERE table_schema = current_schema() AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')"
    )) || [];
    for (const { t, c } of cols) {
        const qt = quoteIdent(t), qc = quoteIdent(c);
        await db.get(
            `SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${qc}) FROM ${qt}), 0) + 1, false) AS v`,
            [qt, c]
        );
    }
}
exports.resetPgSequences = resetPgSequences;
exports.quoteIdent = quoteIdent;
exports.sanitizeValue = sanitizeValue;

// Exported for tests of the cross-driver copy (round-trip a seeded DB across engines / drivers).
exports.copyAllTables = copyAllTables;
exports.listGeneratedColumns = listGeneratedColumns;
exports.orderByForeignKeys = orderByForeignKeys;
exports.rebuildEngineSpecificSchema = rebuildEngineSpecificSchema;
exports.listSourceTables = listSourceTables;
exports.recreateTableOnTarget = recreateTableOnTarget;
exports.CORE_TABLES = CORE_TABLES;

// ── MULTISITE: the rest of the network moves with site 1 ─────────────────────────────────────────
//
// A network keeps one database per site and a network store (core/site-storage: SQLite files, Postgres
// schemas, MySQL databases). Switching engine moves ALL of them: each site's database is copied into its
// namespace on the target (data/sites/<id>/wordjs-native.db, schema wordjs_site_<id>, or database
// <name>_site_<id>) with the same complete, fail-closed copy as site 1's, and the network store's records
// into the target's network store. Any failure throws, so runMigration never switches the config and the
// whole network keeps running on the source.

const SITE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/** A site id from the network registry, checked: a positive integer. */
function checkedSiteId(id) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n < 2) throw new Error(`Not a secondary site id: ${String(id)}`);
    return n;
}

/** Where site `id` (or the network store, id null) lives on a SERVER target: its schema / database name. */
function targetNamespace(targetDriver, dbName, id) {
    const site = id === null ? null : checkedSiteId(id);
    if (targetDriver === 'postgres') return site === null ? 'wordjs_network' : `wordjs_site_${site}`;
    if (!SITE_NAME_RE.test(String(dbName || ''))) throw new Error(`A network on MySQL needs a database name of lower-case letters, digits and underscores (got ${JSON.stringify(dbName)}).`);
    const n = site === null ? `${dbName}_network` : `${dbName}_site_${site}`;
    if (n.length > 64) throw new Error(`The MySQL database name ${n} is longer than 64 characters.`);
    return n;
}

/**
 * The file of site `id` (or of the network store, id null) on a SQLite target, under data/. Built only
 * from the checked id and constant segments, and proved contained (core/safe-path resolveWithin): no
 * part of the request names a path.
 */
function sqliteTargetFile(id) {
    const { resolveWithin } = require('../safe-path');
    const root = path.resolve('./data');
    const file = id === null
        ? resolveWithin(root, 'network.db')
        : resolveWithin(root, 'sites', String(checkedSiteId(id)), 'wordjs-native.db');
    if (!file) throw new Error('The target database file could not be placed under data/.');
    return file;
}

/**
 * Open the target namespace: a connected Postgres/MySQL driver pinned to it (created first through the
 * main target connection), or a fresh SQLite file at `<file>.tmp` that `commit()` moves into place.
 */
async function openTargetNamespace(targetDriver, mainTarget, conn, id) {
    if (targetDriver === 'postgres' || targetDriver === 'mysql') {
        const ns = targetNamespace(targetDriver, conn && conn.name, id);
        const q = (s) => (targetDriver === 'postgres' ? `"${s}"` : `\`${s}\``);
        await mainTarget.pool.query(targetDriver === 'postgres'
            ? `CREATE SCHEMA IF NOT EXISTS ${q(ns)}`
            : `CREATE DATABASE IF NOT EXISTS ${q(ns)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        const Driver = targetDriver === 'postgres' ? require('../../drivers/postgres').PostgresDriver : require('../../drivers/mysql').MysqlDriver;
        const d = new Driver();
        d.config = targetDriver === 'postgres' ? { ...conn, schema: ns, poolMax: 2 } : { ...conn, name: ns, connectionLimit: 2 };
        await d.connect();
        return { isAsync: true, module: d, wrapper: null, commit: async () => { await d.close(); }, abort: async () => { try { await d.close(); } catch (_) { /* */ } } };
    }
    const Database = require('better-sqlite3');
    const { NativeWrapper } = require('../../drivers/sqlite-native');
    const ns = sqliteTargetFile(id);
    fs.mkdirSync(path.dirname(ns), { recursive: true });
    const tmp = ns + '.tmp';
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
    const handle = new Database(tmp);
    handle.pragma('journal_mode = DELETE');
    handle.exec('PRAGMA foreign_keys = OFF;');
    const wrapper = new NativeWrapper(handle);
    return {
        isAsync: false, module: null, wrapper,
        commit: async () => {
            handle.close();
            for (const f of [ns, ns + '-wal', ns + '-shm']) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
            fs.renameSync(tmp, ns);
        },
        abort: async () => { try { handle.close(); } catch (_) { /* */ } try { fs.unlinkSync(tmp); } catch (_) { /* */ } },
    };
}

/** Copy one whole database (a site's) from `source` (a connected driver of the current engine) into `target`. */
async function copySiteDatabase(source, currentDriver, target, targetDriver, onProgress) {
    const sourceIsAsync = currentDriver === 'postgres' || currentDriver === 'mysql';
    const readAll = (sql) => Promise.resolve(source.all(sql));
    const tables = await listSourceTables(readAll, currentDriver);
    const nonCore = tables.filter((t) => !CORE_TABLES.has(t));
    const schemaByTable = {};
    for (const t of nonCore) {
        let s = null;
        if (typeof source.getTableSchema === 'function') { try { s = await source.getTableSchema(t); } catch (_) { s = null; } }
        let sqlText = s && s.sql;
        let columns = (s && s.columns) || [];
        if (!sourceIsAsync) {
            if (!sqlText) {
                const r = await readAll(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escLit(t)}'`);
                sqlText = r && r[0] && r[0].sql;
            }
            columns = await sqliteColumnsFromPragma(readAll, t);
        }
        schemaByTable[t] = { sql: sqlText || null, columns };
    }
    const generatedColumns = await listGeneratedColumns(readAll, currentDriver);
    await dbManager.initializeSchema(target.isAsync ? target.module : target.wrapper, target.isAsync);
    await buildTargetSchema(target.isAsync ? target.module : target.wrapper, target.isAsync, targetDriver);
    const targetKind = targetDriver === 'mysql' ? 'mysql' : (targetDriver === 'postgres' ? 'postgres' : 'sqlite');
    const copied = await copyAllTables({
        generatedColumns,
        tables,
        nonCore,
        isAsyncTarget: target.isAsync,
        isMysqlTarget: targetDriver === 'mysql',
        targetKind,
        targetModule: target.module,
        targetWrapper: target.wrapper,
        targetExec: target.isAsync ? (s) => target.module.exec(s) : (s) => target.wrapper.exec(s),
        schemaByTable,
        readAll,
        sourceIsSqlite: !sourceIsAsync,
        sourceRead: source,
        onProgress,
    });
    await rebuildEngineSpecificSchema(target.isAsync ? target.module : target.wrapper, target.isAsync, targetDriver);
    return copied;
}

/**
 * Copy every site other than site 1, and the network store, onto the target engine. `mainTarget` is the
 * connected target driver of site 1 (Postgres/MySQL), used to create the namespaces; `conn` its settings.
 * Returns the rows copied. Throws on the first failure, after removing what it had written.
 */
async function migrateNetwork({ currentDriver, targetDriver, mainTarget, conn, onProgress }) {
    const siteContext = require('../site-context');
    if (!siteContext.multisiteEnabled()) return 0;
    const network = require('../network');
    const sourceIsSql = currentDriver === 'postgres' || currentDriver === 'mysql';
    const committed = [];
    let rows = 0;
    const sites = network.listSites().filter((s) => s.id !== siteContext.PRIMARY_SITE_ID);
    for (const site of sites) {
        const target = await openTargetNamespace(targetDriver, mainTarget, conn, site.id);
        try {
            rows += await siteContext.runWithSite(site.id, async () => {
                await dbManager.openSiteDatabase(site.id, sourceIsSql ? null : (site.dbPath || network.siteDbPath(site.id)));
                return copySiteDatabase(dbManager.getDbAsync(), currentDriver, target, targetDriver,
                    (table, i, n) => onProgress && onProgress(`site ${site.id}: ${table}`, i, n));
            });
            committed.push(target);
        } catch (e) {
            await target.abort();
            for (const t of committed) await t.abort();
            throw new Error(`Site ${site.id} (${site.mainHost}) could not be copied: ${e.message}`, { cause: e });
        }
    }
    // The network store: the same records, in the target's network store.
    const store = await openTargetNamespace(targetDriver, mainTarget, conn, null);
    try {
        const exec = store.isAsync ? (s) => store.module.exec(s) : (s) => store.wrapper.exec(s);
        for (const ddl of network.TABLES) await exec(ddl);
        const names = network.TABLES.map((ddl) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl)[1]);
        const sourceRead = { all: (sql) => network.storeAll(sql) };
        const copy = async (tx) => copyTablesInto(names, { sourceRead, targetTx: tx });
        if (store.isAsync) rows += await store.module.transaction(copy);
        else {
            const w = store.wrapper;
            w.exec('BEGIN');
            try {
                rows += await copy({ exec: (s) => w.exec(s), run: (s, p) => w.prepare(s).run(...(p || [])), get: (s) => w.prepare(s).get() });
                w.exec('COMMIT');
            } catch (e) { try { w.exec('ROLLBACK'); } catch (_) { /* */ } throw e; }
        }
    } catch (e) {
        await store.abort();
        for (const t of committed) await t.abort();
        throw new Error(`The network store could not be copied: ${e.message}`, { cause: e });
    }
    for (const t of committed) await t.commit();
    await store.commit();
    // The sources are left as they were (a rollback is the config backup away); their connections close.
    try { await dbManager.closeSiteDatabases(); } catch (_) { /* */ }
    try { network.closeNetworkStore(); } catch (_) { /* */ }
    return rows;
}

exports.migrateNetwork = migrateNetwork;
exports.targetNamespace = targetNamespace;
exports.sqliteTargetFile = sqliteTargetFile;

// ── What belongs to the database the site is running on ─────────────────────────────────────────
//
// POST /cleanup deletes a leftover database from data/ after a migration, and it used to check only that
// the name was one of three: `{file: 'wordjs-native.db'}` unlinked the LIVE default SQLite file and its
// -wal/-shm while the site ran on it (getStatus never listed it, but nothing stopped the request). The
// files of the active database are therefore worked out from what the site actually opened — the
// configured path and the path the async driver holds — never from the driver's default file name, which
// a pinned `dbPath` (the installer pins it; a failed migration swap leaves `<name>.tmp` active) makes
// wrong. Every spelling is compared: the resolved path, its real path (a symlink or junction anywhere on
// the way, data/ itself included), case-insensitively where the file system is, and the file's identity.

const CLEANUP_FILES = ['wordjs.db', 'wordjs-native.db', 'postgres-embed'];
// A SQLite database is its file and the journal files beside it; deleting any one of them corrupts it.
const SQLITE_COMPANIONS = ['', '-wal', '-shm', '-journal'];
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

function spellingsOf(p) {
    const abs = path.resolve(p);
    const out = new Set([abs]);
    try { out.add(fs.realpathSync.native(abs)); } catch (_) { /* absent */ }
    // An absent companion file under a linked directory is still that directory's file.
    try { out.add(path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs))); } catch (_) { /* absent */ }
    return [...out].map((k) => (FOLDS_CASE ? k.toLowerCase() : k));
}

function identityOf(p) {
    try {
        const st = fs.statSync(p, { bigint: true });
        return st.ino ? `${st.dev}:${st.ino}` : null;
    } catch (_) { return null; }
}

/** The paths of the database the site is running on (absolute; files that may not exist yet included). */
function activeDatabaseFiles() {
    const driver = String(dbManager.getDbType().driver || '');
    const files = [];
    if (/^sqlite/.test(driver)) {
        const roots = [];
        if (config.dbPath) roots.push(config.dbPath);
        try { const a = dbManager.getDbAsync(); if (a && typeof a.dbPath === 'string') roots.push(a.dbPath); } catch (_) { /* not connected */ }
        for (const root of roots) for (const suffix of SQLITE_COMPANIONS) files.push(path.resolve(root + suffix));
    }
    // The embedded Postgres data directory the status screen has always treated as live under 'postgres'.
    if (driver === 'postgres') files.push(path.resolve('./data/postgres-embed'));
    return files;
}

/**
 * Does deleting `target` (and, for a file, its SQLite companions) touch the database the site is running
 * on? A directory conflicts when an active file is that directory or lies inside it.
 */
function belongsToActiveDatabase(target) {
    const active = activeDatabaseFiles();
    const activeKeys = new Set(active.flatMap(spellingsOf));
    const activeIds = new Set(active.map(identityOf).filter(Boolean));
    for (const suffix of SQLITE_COMPANIONS) {
        const candidate = path.resolve(target + suffix);
        if (spellingsOf(candidate).some((k) => activeKeys.has(k))) return true;
        const id = identityOf(candidate);
        if (id && activeIds.has(id)) return true;
    }
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch (_) { /* absent */ }
    if (isDir) {
        const dirKeys = spellingsOf(target).map((d) => (d.endsWith(path.sep) ? d : d + path.sep));
        for (const k of activeKeys) {
            if (dirKeys.some((d) => k.startsWith(d))) return true;
        }
    }
    return false;
}
exports.belongsToActiveDatabase = belongsToActiveDatabase;

exports.getStatus = (req, res) => {
    // Check for legacy files to allow cleanup
    const legacyFiles = [];
    const dbType = dbManager.getDbType();
    const currentDriver = dbType.driver;

    // Only offer what the site is NOT running on — judged the way POST /cleanup judges it.
    for (const file of CLEANUP_FILES) {
        const target = path.resolve('./data', file);
        if (fs.existsSync(target) && !belongsToActiveDatabase(target)) legacyFiles.push(file);
    }

    res.json({
        currentDriver,
        availableDrivers: ['sqlite-legacy', 'sqlite-native', 'postgres', 'mysql'],
        status: globalStatus,
        legacyFiles,
        // Changes on every boot: the panel waits for a new one after a migration (core/restart).
        bootId: require('../restart').BOOT_ID,
        restart: require('../restart').restartMode()
    });
};

exports.cleanup = (req, res) => {
    const { file } = req.body || {};
    // Security: Only allow specific filenames to prevent arbitrary deletion
    if (!CLEANUP_FILES.includes(file)) return res.status(403).json({ error: 'Invalid file' });

    const target = path.resolve('./data', file);
    if (belongsToActiveDatabase(target)) {
        return res.status(409).json({
            code: 'db_cleanup_active_database',
            error: `'${file}' belongs to the database the site is running on; nothing was deleted.`
        });
    }
    if (fs.existsSync(target)) {
        try {
            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                fs.rmSync(target, { recursive: true, force: true });
            } else {
                fs.unlinkSync(target);

                // Also clean WAL/SHM/journal if they exist
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix);
                }
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
    // TLS to a server target: verified unless explicitly opted out; a CA is accepted inline (PEM) only,
    // the same rule as the installer — a path would make this request read a file of the caller's choice.
    const dbTls = {
        ssl: req.body.dbSsl === true,
        ...(typeof req.body.dbSslCa === 'string' && req.body.dbSslCa.includes('-----BEGIN') ? { sslCa: req.body.dbSslCa } : {}),
        sslRejectUnauthorized: req.body.dbSslRejectUnauthorized !== false,
    };
    let targetFile = null;
    let targetDriverModule = null;

    // Safety Checks
    if (!targetDriver || !['sqlite-legacy', 'sqlite-native', 'postgres', 'mysql'].includes(targetDriver)) {
        return res.status(400).json({ error: 'Invalid target driver' });
    }

    const currentDriver = config.dbDriver || 'sqlite-legacy';
    // A network moves whole (every site and the network store, migrateNetwork): onto an engine that can
    // hold one, and never onto the server it already runs on (its sites' schemas / databases ARE there).
    if (require('../site-context').multisiteEnabled()) {
        if (targetDriver === 'sqlite-legacy') {
            return res.status(400).json({ code: 'db_migration_network_engine', error: 'A network of sites needs the sqlite-native, postgres or mysql driver.' });
        }
        if (targetDriver === currentDriver) {
            return res.status(409).json({ code: 'db_migration_network_same_engine', error: 'A network cannot be re-migrated onto the engine it runs on; move its databases with the tools of the engine.' });
        }
    }
    if (targetDriver === currentDriver && targetDriver !== 'postgres' && targetDriver !== 'mysql') {
        // Allow re-migration to postgres/mysql for credential updates, but block file-to-file defaults
        return res.status(400).json({ error: 'Already using this driver' });
    }
    // A SQLite target is written to data/<its default name> (and .tmp beside it), deleting what is there
    // at the swap. With a pinned dbPath that can be the file the site is running on: refused before
    // anything is read, written or installed (the cleanup's own rule).
    if (targetDriver === 'sqlite-native' || targetDriver === 'sqlite-legacy') {
        const planned = path.resolve('./data', targetDriver === 'sqlite-native' ? 'wordjs-native.db' : 'wordjs.db');
        if (belongsToActiveDatabase(planned) || belongsToActiveDatabase(planned + '.tmp')) {
            return res.status(409).json({
                code: 'db_migration_target_is_active',
                error: `The ${targetDriver} target file '${path.basename(planned)}' belongs to the database the site is running on. Point dbPath at another file first.`
            });
        }
    }

    try {
        log.info(`🚀 Migration Started: ${currentDriver} -> ${targetDriver}`);
        globalStatus = { step: 'initializing', progress: 0, currentTable: '', totalTables: 0, warnings: [] };

        // 0. Auto-Install Dependencies (Zero Config)
        if (targetDriver === 'sqlite-native') {
            try { require.resolve('better-sqlite3'); } catch (e) {
                log.info('📦 Installing Native Driver (better-sqlite3)...');
                const { execSync } = require('child_process');
                execSync('npm install better-sqlite3 --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }
        if (targetDriver === 'postgres') {
            try { require.resolve('pg'); } catch (e) {
                log.info('📦 Installing Postgres Driver (pg)...');
                const { execSync } = require('child_process');
                execSync('npm install pg --save', { cwd: path.resolve(__dirname, '../../../../'), stdio: 'inherit' });
            }
        }
        if (targetDriver === 'mysql') {
            try { require.resolve('mysql2'); } catch (e) {
                log.info('📦 Installing MySQL Driver (mysql2)...');
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
        const generatedColumns = await listGeneratedColumns(liveReadAll, currentDriver);

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
                log.error({ err: e }, '❌ Failed to clean up temp files');
                throw new Error(`Temp file locked: ${e.message}`);
            }
        }

        // 3. Connect to Target Driver
        targetDriverModule = require(`../../drivers/${targetDriver}`);

        if (isAsyncTarget) {
            // Dynamic init for an async client-server driver (Postgres / MySQL).
            await targetDriverModule.init({
                dbConfig: { host: dbHost, user: dbUser, password: dbPassword, name: dbName, port: dbPort, ...dbTls }
            });
            try {
                await targetDriverModule.connect();
            } catch (connErr) {
                throw refusal(`Could not connect to the target database: ${connErr.message}`, connErr);
            }

            // 3.1 REFUSE a lossy (non-UTF8) target. The old code silently rewrote every non-Latin1
            //     character to '?' — invisible to the row-COUNT guard — permanently mangling content
            //     (emoji, CJK, smart quotes) while reporting success. Fail closed instead: the operator
            //     creates the database with ENCODING 'UTF8'. MySQL always runs utf8mb4, so it's exempt.
            if (isPostgresTarget) {
                try {
                    const encRes = await targetDriverModule.all("SELECT pg_encoding_to_char(encoding) as enc FROM pg_database WHERE datname = current_database()");
                    targetEncoding = encRes[0]?.enc || 'UTF8';
                    log.info({ targetEncoding }, `   Target Encoding: ${targetEncoding}`);
                } catch (encErr) {
                    // Can't verify the encoding → can't guarantee it's UTF8 → fail closed rather than
                    // risk silently mangling non-Latin1 content into '?' on a WIN1252 target.
                    throw new Error(`Could not verify the target Postgres database encoding (${encErr.message}) — migration refused. Ensure the target database uses ENCODING 'UTF8'.`);
                }
                if (targetEncoding !== 'UTF8' && targetEncoding !== 'UTF-8') {
                    throw refusal(`Target Postgres database encoding is ${targetEncoding}, not UTF8 — migration refused to avoid silently corrupting non-Latin1 content. Recreate the target database with ENCODING 'UTF8' (CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0) and retry.`);
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
        await buildTargetSchema(isAsyncTarget ? targetDriverModule : targetWrapper, isAsyncTarget, targetDriver);
        log.info('   Schema initialized on target.');

        // 5. Copy ALL user data — complete (every table, dynamically enumerated, NOT a hardcoded list),
        //    atomic (one pinned connection via the driver's transaction()), and FAIL-CLOSED (a row-count
        //    mismatch throws → rollback → the caller never switches the live DB). See copyAllTables above.
        globalStatus.step = 'copying';
        globalStatus.warnings = [];

        // (allTables / nonCore / schemaByTable / sourceRead were captured from the LIVE source above,
        //  BEFORE the target connected — see the pre-read block — so an aliased re-migration can't read
        //  the empty target here.)
        globalStatus.totalTables = allTables.length;
        log.info(`   Copying ${allTables.length} table(s); ${nonCore.length} non-core to recreate: ${nonCore.join(', ') || 'none'}.`);

        const totalRows = await copyAllTables({
            tables: allTables,
            nonCore,
            generatedColumns,
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
        // The target's own search index and unique indexes (FTS5 / tsvector / FULLTEXT), over the copied rows.
        await rebuildEngineSpecificSchema(isAsyncTarget ? targetDriverModule : targetWrapper, isAsyncTarget, targetDriver);

        // Multisite: every other site and the network store follow (all or nothing — a failure throws
        // before the config is switched, so the network keeps running on the source).
        const networkRows = await migrateNetwork({
            currentDriver,
            targetDriver,
            mainTarget: isAsyncTarget ? targetDriverModule : null,
            conn: isAsyncTarget ? { host: dbHost, user: dbUser, password: dbPassword, name: dbName, port: dbPort, ...dbTls } : null,
            onProgress: (table, i, n) => { globalStatus.currentTable = table; globalStatus.progress = Math.round((i / n) * 100); },
        });
        if (networkRows) log.info(`✅ Network copied: ${networkRows} row(s) of the other sites and the network store.`);

        // Open the connection the NEXT BOOT will open — the config this migration is about to write, resolved
        // by config/app's own rule — while the source is still the live database. If it cannot connect,
        // nothing is written and the site keeps running on the source instead of restarting into
        // "Access denied" (a flat dbPassword left by the SQLite install used to shadow the new password).
        if (isAsyncTarget) {
            const planned = withTargetDatabase(configManager.getConfig() || {}, {
                targetDriver, dbPath: null,
                conn: { host: dbHost, port: dbPort, user: dbUser, name: dbName, password: dbPassword, ...dbTls },
            });
            try {
                await verifyBootConnection(targetDriver, planned);
            } catch (verifyErr) {
                throw new Error(`The data was copied, but WordJS could not connect with the settings the restart would use (${verifyErr.message}); nothing was switched and the site stays on its current database.`, { cause: verifyErr });
            }
        }

        // Close Source DB now that we are done reading.
        try { if (dbManager.closeDatabase) await dbManager.closeDatabase(); } catch (e) { log.warn({ err: e }, 'Could not close source DB'); }

        log.info(`✅ Data copied: ${totalRows} row(s) across ${allTables.length} table(s).`);

        // 6. Persist & Close Target
        if (targetDriverModule.save) targetDriverModule.save();
        if (targetDriverModule.close) await targetDriverModule.close();

        // 7. Atomic Swap (Move .tmp -> Real) with Failover
        let finalPath = targetFile;

        if (tempTargetFile) {
            log.info('   Stats: Swapping temporary database to final location...');
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
                log.warn(`⚠️ Swap Failed (File Locked). Using temporary file '${path.basename(tempTargetFile)}' as the new active database.`);
                // If we can't write to the standard filename, we stick with the temp file
                // This ensures the user doesn't lose data, even if the filename is ugly.
                finalPath = tempTargetFile;
            }
        }

        // 8. Update Configuration
        let dbPathValue = null;
        if (!isAsyncTarget) {
            // Relative to the backend root, in the ./data convention.
            const rel = path.relative(process.cwd(), finalPath).replace(/\\/g, '/');
            dbPathValue = rel.startsWith('.') ? rel : `./${rel}`;
        }

        // Save Backup for Auto-Fallback
        const backupConfig = configManager.getConfig();
        if (backupConfig) {
            const backupFile = path.resolve('wordjs-config.backup.json');
            // The backup is a full copy of the config (jwtSecret, dbPassword…): owner-only, like the config.
            require('fs').writeFileSync(backupFile, JSON.stringify(backupConfig, null, 2), { mode: 0o600 });
            try { require('fs').chmodSync(backupFile, 0o600); } catch { /* Windows: no POSIX bits */ }
        }

        const written = configManager.updateConfig((current) => withTargetDatabase(current, {
            targetDriver, dbPath: dbPathValue,
            conn: isAsyncTarget ? { host: dbHost, port: dbPort, user: dbUser, name: dbName, password: dbPassword, ...dbTls } : null,
        }));
        if (!written || !written.ok) throw new Error('The data was copied, but the new database settings could not be saved; the site stays on its current database.');

        // Restart so the new database config is picked up (core/restart: the supervisor, node --watch or
        // the service manager starts the process again). The old `process.exit(0)` here STOPPED a supervised
        // install for good (backend/server.js treats exit 0 as "stopped on purpose").
        globalStatus = { ...globalStatus, step: 'done', progress: 100, currentTable: '' };
        const restart = require('../restart');
        const mode = restart.scheduleRestart(`database moved to ${targetDriver}`, { delayMs: 1000 });
        res.json({
            success: true,
            restart: mode,
            message: mode === 'manual'
                ? `Migration successful! Copied ${totalRows} rows to ${targetDriver}. Restart WordJS to start using it.`
                : `Migration successful! Copied ${totalRows} rows to ${targetDriver}. Restarting server...`
        });

    } catch (e) {
        log.error({ err: e }, 'Migration Failed');
        // The panel polls the status: leave it on "failed" with the reason, not on the last step reached.
        globalStatus = { ...globalStatus, step: 'failed', error: e.message };

        // Attempt to cleanup driver connection to release locks
        if (targetDriverModule) {
            try { if (targetDriverModule.exec) await targetDriverModule.exec('ROLLBACK'); } catch (err) { }
            try { if (targetDriverModule.close) await targetDriverModule.close(); } catch (err) { }
        }

        // A target the migration refuses (wrong encoding, unreachable, bad credentials) is the caller's
        // to fix: 400 with the reason. Anything else is a server-side failure.
        res.status(e && e.statusCode === 400 ? 400 : 500).json({ error: e.message });
    }
};

/** An error that is the request's to fix (answered 400, not 500). */
function refusal(message, cause) {
    const e = new Error(message, cause ? { cause } : undefined);
    e.statusCode = 400;
    return e;
}

const FLAT_DB_KEYS = ['dbHost', 'dbPort', 'dbUser', 'dbPassword', 'dbName', 'dbSsl', 'dbSslCa', 'dbSslRejectUnauthorized'];

/**
 * The config with its database switched to the migration's target. For a server engine the connection
 * goes in the nested `db` block AND the password under the flat `dbPassword`, the shape the installer
 * writes (routes/setup.ts): config/app reads the flat keys FIRST, so a flat `dbPassword` left over from
 * the SQLite install (generated at its first boot) used to shadow the new password and lock the site
 * out of its new database at the restart. Every other flat connection key is dropped for the same
 * reason. Pure, for the tests.
 */
function withTargetDatabase(current, { targetDriver, dbPath, conn }) {
    const next = { ...(current || {}), dbDriver: targetDriver };
    if (!conn) {
        next.dbPath = dbPath;
        return next;
    }
    for (const k of FLAT_DB_KEYS) delete next[k];
    const port = Number(conn.port) || (targetDriver === 'mysql' ? 3306 : 5432);
    next.db = {
        ...(current && current.db && typeof current.db === 'object' ? current.db : {}),
        host: conn.host, port, user: conn.user, name: conn.name, database: conn.name,
        password: conn.password || '',
        ssl: conn.ssl === true,
        sslRejectUnauthorized: conn.sslRejectUnauthorized !== false,
        ...(conn.sslCa ? { sslCa: conn.sslCa } : {}),
    };
    if (!conn.sslCa) delete next.db.sslCa;
    if (conn.password) next.dbPassword = String(conn.password);
    return next;
}
exports.withTargetDatabase = withTargetDatabase;

/** Connect a throwaway pool with the connection config/app resolves from `fileConfig` (the planned config). */
async function verifyBootConnection(targetDriver, fileConfig) {
    const { resolveDbConnection } = require('../../config/app');
    const conn = resolveDbConnection(fileConfig);
    const Driver = targetDriver === 'postgres' ? require('../../drivers/postgres').PostgresDriver : require('../../drivers/mysql').MysqlDriver;
    const d = new Driver();
    d.config = targetDriver === 'postgres' ? { ...conn, poolMax: 2 } : { ...conn, connectionLimit: 2 };
    try {
        await d.connect();
        await d.get('SELECT 1 AS ok');
    } finally {
        try { await d.close(); } catch (_) { /* */ }
    }
}
exports.verifyBootConnection = verifyBootConnection;
