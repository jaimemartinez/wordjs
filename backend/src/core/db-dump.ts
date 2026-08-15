/**
 * WordJS — External database dump / restore (Postgres + MySQL).
 *
 * SQLite is a single file the backup service copies directly. Postgres and MySQL live in a server the
 * app only reaches over a wire protocol, so a COMPLETE, restorable snapshot needs the vendor tool:
 *   - Postgres → `pg_dump` (custom format `-Fc`) captured here, restored with `pg_restore`.
 *   - MySQL    → `mysqldump` (plain SQL) captured here, restored with the `mysql` client.
 *
 * The historical bug this closes: when the driver was Postgres the backup SKIPPED the physical snapshot
 * and shipped only the logical JSON export (which omits analytics / notifications / plugin tables /
 * schema_migrations) — a silent, incomplete archive that looked like a full backup. The rule here is the
 * opposite: if the required tool is missing we FAIL THE BACKUP LOUDLY rather than produce a partial one.
 *
 * Credentials come from the SAME normalized config.db the driver connects with; the password is passed
 * via the tool's environment variable (PGPASSWORD / MYSQL_PWD), never on argv (argv is world-readable in
 * the host process list).
 */

const { spawn } = require('child_process');
const fs = require('fs');

export type DbDumpConfig = {
    host?: string;
    port?: number | string;
    user?: string;
    password?: string;
    name?: string;
};

// External tool a driver needs to CAPTURE a dump, and to RESTORE one.
const DUMP_TOOL: Record<string, string> = { postgres: 'pg_dump', mysql: 'mysqldump' };
const RESTORE_TOOL: Record<string, string> = { postgres: 'pg_restore', mysql: 'mysql' };
// Entry name (under the zip's `database/` folder) that carries each driver's dump.
const DUMP_ENTRY: Record<string, string> = { postgres: 'postgres.dump', mysql: 'mysql.sql' };

/** The zip entry name (basename) for a driver's physical dump, or null for a driver that has none. */
function dumpEntryName(driver: string): string | null {
    return DUMP_ENTRY[driver] || null;
}

/** True when `driver` is one whose physical snapshot is produced by an external tool (pg/mysql). */
function usesExternalDump(driver: string): boolean {
    return Object.prototype.hasOwnProperty.call(DUMP_TOOL, driver);
}

/**
 * Probe whether an executable is actually runnable on this host by invoking `<tool> --version`.
 * Resolves false on ENOENT / spawn error / non-zero exit — i.e. "not usable", never throws.
 */
function isToolAvailable(tool: string, spawnFn: any = spawn): Promise<boolean> {
    return new Promise((resolve) => {
        let child: any;
        try {
            child = spawnFn(tool, ['--version'], { stdio: 'ignore' });
        } catch {
            return resolve(false);
        }
        child.on('error', () => resolve(false)); // ENOENT: binary not on PATH
        child.on('close', (code: number) => resolve(code === 0));
    });
}

/** Run an external tool to completion; resolve on exit 0, reject with captured stderr otherwise. */
function runTool(spawnFn: any, tool: string, args: string[], opts: any = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const stdin = opts.stdinFile ? 'pipe' : 'ignore';
        let child: any;
        try {
            child = spawnFn(tool, args, { stdio: [stdin, 'ignore', 'pipe'], env: opts.env || process.env });
        } catch (e) {
            return reject(e);
        }
        let stderr = '';
        if (child.stderr) {
            child.stderr.on('data', (d: any) => {
                stderr += d.toString();
                if (stderr.length > 8192) stderr = stderr.slice(-8192); // bound: some tools are chatty
            });
        }
        if (opts.stdinFile) {
            const rs = fs.createReadStream(opts.stdinFile);
            rs.on('error', reject);
            rs.pipe(child.stdin);
        }
        child.on('error', reject);
        child.on('close', (code: number) => {
            if (code === 0) return resolve();
            reject(new Error(`${tool} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        });
    });
}

// ── argv builders (pure, unit-tested) ────────────────────────────────────────────────────────────────
function buildPgDumpArgs(cfg: DbDumpConfig, destPath: string): string[] {
    return [
        '-Fc',                       // custom (compressed, pg_restore-able) format
        '--no-owner', '--no-privileges',
        '-h', String(cfg.host || 'localhost'),
        '-p', String(cfg.port || 5432),
        '-U', String(cfg.user || 'postgres'),
        '-f', destPath,
        String(cfg.name || 'wordjs'),
    ];
}
function buildPgRestoreArgs(cfg: DbDumpConfig, srcPath: string): string[] {
    return [
        '--clean', '--if-exists',    // drop each object before recreating ⇒ authoritative overwrite
        '--no-owner', '--no-privileges',
        '-h', String(cfg.host || 'localhost'),
        '-p', String(cfg.port || 5432),
        '-U', String(cfg.user || 'postgres'),
        '-d', String(cfg.name || 'wordjs'),
        srcPath,
    ];
}
function buildMysqldumpArgs(cfg: DbDumpConfig, destPath: string): string[] {
    return [
        '-h', String(cfg.host || 'localhost'),
        '-P', String(cfg.port || 3306),
        '-u', String(cfg.user || 'root'),
        '--single-transaction', '--routines', '--triggers', '--events',
        '--add-drop-table',
        '--result-file=' + destPath,
        '--databases', String(cfg.name || 'wordjs'),
    ];
}
function buildMysqlRestoreArgs(cfg: DbDumpConfig): string[] {
    // The `mysql` client reads the dump from STDIN; `--databases` in the dump selects the schema, so we
    // do NOT pass a db name here (that would collide with the dump's own USE/CREATE DATABASE).
    return [
        '-h', String(cfg.host || 'localhost'),
        '-P', String(cfg.port || 3306),
        '-u', String(cfg.user || 'root'),
    ];
}

function passwordEnv(driver: string, cfg: DbDumpConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (driver === 'postgres') env.PGPASSWORD = String(cfg.password || '');
    else if (driver === 'mysql') env.MYSQL_PWD = String(cfg.password || '');
    return env;
}

function missingToolError(tool: string, driver: string, phase: 'backup' | 'restore'): Error {
    const install = tool.startsWith('pg') ? 'the PostgreSQL client tools (postgresql-client)' : 'the MySQL client tools (mysql-client)';
    const verb = phase === 'backup' ? 'captured' : 'restored';
    return new Error(
        `${phase === 'backup' ? 'Backup' : 'Restore'} aborted: \`${tool}\` was not found on this host, so the ` +
        `${driver} database cannot be ${verb}. Proceeding would ${phase === 'backup' ? 'silently produce an INCOMPLETE archive with no database content' : 'leave the database unchanged while claiming success'}. ` +
        `Install ${install} (which provides \`${tool}\`) on the WordJS host and retry.`,
    );
}

/**
 * Capture a physical dump of the given server-backed driver's database to `destPath`.
 * FAILS LOUD (throws) if the required vendor tool is not runnable on this host — the caller must NOT
 * swallow this, otherwise the backup silently omits all DB content.
 * @param deps injectable { isToolAvailable, spawn } for tests.
 */
async function captureDump(driver: string, destPath: string, cfg: DbDumpConfig, deps: any = {}): Promise<void> {
    const tool = DUMP_TOOL[driver];
    if (!tool) throw new Error(`captureDump: driver '${driver}' has no external dump tool`);

    const spawnFn = deps.spawn || spawn;
    const available = deps.isToolAvailable || isToolAvailable;
    if (!(await available(tool, spawnFn))) {
        throw missingToolError(tool, driver, 'backup');
    }

    const args = driver === 'postgres' ? buildPgDumpArgs(cfg, destPath) : buildMysqldumpArgs(cfg, destPath);
    await runTool(spawnFn, tool, args, { env: passwordEnv(driver, cfg) });
}

/**
 * Restore a physical dump previously produced by captureDump. FAILS LOUD if the restore tool is missing
 * (so a "successful" restore can never silently leave the DB untouched).
 * @param deps injectable { isToolAvailable, spawn } for tests.
 */
async function restoreDump(driver: string, srcPath: string, cfg: DbDumpConfig, deps: any = {}): Promise<void> {
    const tool = RESTORE_TOOL[driver];
    if (!tool) throw new Error(`restoreDump: driver '${driver}' has no external restore tool`);

    const spawnFn = deps.spawn || spawn;
    const available = deps.isToolAvailable || isToolAvailable;
    if (!(await available(tool, spawnFn))) {
        throw missingToolError(tool, driver, 'restore');
    }

    if (driver === 'postgres') {
        await runTool(spawnFn, tool, buildPgRestoreArgs(cfg, srcPath), { env: passwordEnv(driver, cfg) });
    } else {
        // mysql client consumes the dump from stdin.
        await runTool(spawnFn, tool, buildMysqlRestoreArgs(cfg), { env: passwordEnv(driver, cfg), stdinFile: srcPath });
    }
}

module.exports = {
    captureDump,
    restoreDump,
    isToolAvailable,
    dumpEntryName,
    usesExternalDump,
    // exported for unit tests of the pure argv/env builders
    buildPgDumpArgs,
    buildPgRestoreArgs,
    buildMysqldumpArgs,
    buildMysqlRestoreArgs,
    passwordEnv,
};
