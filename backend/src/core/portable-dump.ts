/**
 * WordJS — portable database dump (Postgres / MySQL), written and read by WordJS itself.
 *
 * A complete backup of a server database used to REQUIRE the vendor tool (`pg_dump` / `mysqldump`, see
 * core/db-dump.ts) on the WordJS host. Without it every backup — the panel's "Create backup" and the
 * daily scheduled one — failed with an internal error, and the only fix was a package install on the
 * command line. This is the path that needs nothing installed: every table of the database (core,
 * analytics, notifications, plugin tables, schema_migrations — the same set the engine-switch migration
 * copies) is read through the site's own connection and written as JSON lines; a restore puts every row
 * back inside ONE transaction, fail-closed, through the same copy code as the migration
 * (core/db-admin/migration copyAllTables: row-count check per table, rollback on any error).
 *
 * The vendor dump stays the first choice when its tool is there (backup.ts): it also carries what this
 * format does not — views, functions, custom index definitions. A table this format has to RE-create on
 * restore (one dropped since the backup) gets its columns back, not its secondary indexes; a plugin
 * re-creates those on activation.
 *
 * File layout (`database/portable.jsonl` in the archive):
 *   line 1  {"format":"wordjs.portable-dump","version":1,"driver":…,"tables":[{"name","schema"}…]}
 *   then    {"t":"<table>","r":{…row…}}   one per row; a binary value is {"$b64":"…"}
 */

const fs = require('fs');

const PORTABLE_FORMAT = 'wordjs.portable-dump';
const PORTABLE_VERSION = 1;
const PORTABLE_ENTRY = 'portable.jsonl';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * A JS Date as `YYYY-MM-DD HH:MM:SS.mmm` in LOCAL time — the inverse of how `pg` turns a `timestamp`
 * (without time zone) column into a Date, so the value written back is the value that was read.
 */
function localTimestamp(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function encodeValue(v: any): any {
    if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') };
    if (v instanceof Date) return localTimestamp(v);
    if (typeof v === 'bigint') return v.toString();
    return v;
}

function decodeValue(v: any): any {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$b64 === 'string' && Object.keys(v).length === 1) {
        return Buffer.from(v.$b64, 'base64');
    }
    return v;
}

/**
 * Write every table of `db` (a connected Postgres/MySQL driver of the CURRENT site) to `destPath`.
 * Returns how many tables and rows went in.
 */
async function capturePortableDump(destPath: string, opts: { driver: string; db: any }): Promise<{ tables: number; rows: number }> {
    const { driver, db } = opts;
    const migration = require('./db-admin/migration');
    const readAll = (sql: string) => Promise.resolve(db.all(sql));
    const tables: string[] = await migration.listSourceTables(readAll, driver);
    const generated = await migration.listGeneratedColumns(readAll, driver);

    const header: any = { format: PORTABLE_FORMAT, version: PORTABLE_VERSION, driver, createdAt: new Date().toISOString(), tables: [] };
    for (const name of tables) {
        let schema: any = null;
        if (typeof db.getTableSchema === 'function') { try { schema = await db.getTableSchema(name); } catch { schema = null; } }
        const skip: Set<string> | undefined = generated[name];
        const columns = ((schema && schema.columns) || []).filter((c: string) => !skip || !skip.has(String(c).split(/\s+/)[0].replace(/"/g, '')));
        header.tables.push({ name, schema: { sql: null, columns } });
    }

    const fd = fs.openSync(destPath, 'wx', 0o600);
    let rows = 0;
    try {
        fs.writeSync(fd, JSON.stringify(header) + '\n');
        for (const name of tables) {
            const skip: Set<string> | undefined = generated[name];
            const result = await readAll(`SELECT * FROM ${migration.quoteIdent(name)}`);
            for (const row of result || []) {
                const out: Record<string, any> = {};
                for (const [k, v] of Object.entries(row)) if (!skip || !skip.has(k)) out[k] = encodeValue(v);
                fs.writeSync(fd, JSON.stringify({ t: name, r: out }) + '\n');
                rows++;
            }
        }
    } finally {
        fs.closeSync(fd);
    }
    return { tables: tables.length, rows };
}

/** Read a portable dump back: its header and the rows of each table. Throws on anything malformed. */
function readPortableDump(srcPath: string): { header: any; rowsByTable: Record<string, any[]> } {
    const text = fs.readFileSync(srcPath, 'utf8');
    const lines = text.split('\n');
    let header: any;
    try { header = JSON.parse(lines[0]); } catch { throw new Error('The portable database dump has no readable header.'); }
    if (!header || header.format !== PORTABLE_FORMAT || header.version !== PORTABLE_VERSION || !Array.isArray(header.tables)) {
        throw new Error('This is not a WordJS portable database dump (or a newer version of it).');
    }
    const rowsByTable: Record<string, any[]> = Object.create(null);
    for (const t of header.tables) rowsByTable[String(t.name)] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let rec: any;
        try { rec = JSON.parse(line); } catch { throw new Error(`The portable database dump is damaged at line ${i + 1}.`); }
        if (!rec || typeof rec.t !== 'string' || !rowsByTable[rec.t] || !rec.r || typeof rec.r !== 'object') {
            throw new Error(`The portable database dump has an invalid record at line ${i + 1}.`);
        }
        const row: Record<string, any> = {};
        for (const [k, v] of Object.entries(rec.r)) row[k] = decodeValue(v);
        rowsByTable[rec.t].push(row);
    }
    return { header, rowsByTable };
}

/**
 * Put a portable dump back into `db` (the live Postgres/MySQL driver of the current site): every table of
 * the dump gets exactly the dump's rows, in one transaction — all or nothing. Tables that no longer exist
 * are created from the dump's column list first. Tables the dump does not know are left alone.
 */
async function restorePortableDump(srcPath: string, opts: { driver: string; db: any }): Promise<{ tables: number; rows: number }> {
    const { driver, db } = opts;
    if (driver !== 'postgres' && driver !== 'mysql') throw new Error(`A portable dump restores into Postgres or MySQL, not ${driver}.`);
    const migration = require('./db-admin/migration');
    const { header, rowsByTable } = readPortableDump(srcPath);
    if (header.driver !== driver) {
        throw new Error(`This backup's database dump was made on ${header.driver}; the site now runs on ${driver}. Switch back to ${header.driver} to restore it, or use Database migration.`);
    }
    const tables: string[] = header.tables.map((t: any) => String(t.name));
    for (const t of tables) migration.quoteIdent(t); // fail closed on an unsafe name before writing anything
    const existing = new Set<string>(await migration.listSourceTables((sql: string) => Promise.resolve(db.all(sql)), driver));
    const schemaByTable: Record<string, any> = {};
    for (const t of header.tables) schemaByTable[String(t.name)] = t.schema || { sql: null, columns: [] };
    const missing = tables.filter((t) => !existing.has(t));

    const sourceRead = {
        all: (sql: string) => {
            const m = /FROM\s+"([^"]+)"/i.exec(sql);
            // A copy of each row: copyTablesInto edits the rows it is handed.
            return ((m && rowsByTable[m[1]]) || []).map((r: any) => ({ ...r }));
        },
    };
    const rows = await migration.copyAllTables({
        tables,
        nonCore: missing,
        isAsyncTarget: true,
        isMysqlTarget: driver === 'mysql',
        targetKind: driver,
        targetModule: db,
        targetWrapper: null,
        targetExec: (s: string) => db.exec(s),
        schemaByTable,
        readAll: async () => [],
        sourceIsSqlite: false,
        sourceRead,
        generatedColumns: {},
    });
    if (driver === 'postgres') await migration.resetPgSequences(db);
    return { tables: tables.length, rows };
}

module.exports = {
    PORTABLE_ENTRY,
    capturePortableDump,
    restorePortableDump,
    readPortableDump,
    // for tests
    encodeValue,
    decodeValue,
    localTimestamp,
};
