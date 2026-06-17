/**
 * WordJS — Schema migration runner (versioned, cross-driver).
 *
 * The base schema is created idempotently by `initializeSchema` (CREATE TABLE/INDEX IF NOT EXISTS).
 * That cannot EVOLVE a live schema (add/alter columns, backfill data) without dropping data. This
 * runner layers ordered, recorded migrations on top: each runs once, in order, and is recorded in a
 * `schema_migrations` table, so upgrades to an existing install apply only the pending changes.
 *
 * Works across all drivers (sqlite-native / sqlite-legacy / postgres): migrations receive a ctx with
 * `exec/run/get/all` (the driver methods — `?` placeholders are normalized by the Postgres driver) and
 * an `isPostgres` flag for the few dialect-specific cases. A failing migration aborts boot (we never
 * run on a half-migrated schema).
 *
 * To add a migration: append `{ id, up }` to MIGRATIONS below. `id` must be unique and stable (it is
 * the recorded key); prefix with a zero-padded ordinal, e.g. '0001_add_posts_author_index'.
 */

type MigrationCtx = {
    exec: (sql: string) => Promise<any>;
    run: (sql: string, params?: any[]) => Promise<any>;
    get: (sql: string, params?: any[]) => Promise<any>;
    all: (sql: string, params?: any[]) => Promise<any>;
    isPostgres: boolean;
};

type Migration = { id: string; up: (ctx: MigrationCtx) => Promise<void> };

// Ordered list of schema migrations. Empty = base schema only (the framework is wired and will apply
// the first real migration the moment one is added here). KEEP IN ORDER; never edit an applied id.
const MIGRATIONS: Migration[] = [];

async function runSchemaMigrations(db: any, isAsync: boolean, driverName: string, migrations: Migration[] = MIGRATIONS): Promise<void> {
    const isPostgres = driverName === 'postgres';
    // The async drivers return promises; the legacy sync driver returns values that `await` resolves
    // through — so a single awaited path works for both.
    const exec = async (sql: string) => (isAsync ? db.exec(sql) : db.exec(sql));
    const run = async (sql: string, params: any[] = []) => (isAsync ? db.run(sql, params) : db.run(sql, params));
    const get = async (sql: string, params: any[] = []) => (isAsync ? db.get(sql, params) : db.get(sql, params));
    const all = async (sql: string, params: any[] = []) => (isAsync ? db.all(sql, params) : db.all(sql, params));

    await exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (` +
        `id TEXT PRIMARY KEY, ` +
        `applied_at ${isPostgres ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP)`
    );

    const appliedRows = (await all('SELECT id FROM schema_migrations')) || [];
    const applied = new Set(appliedRows.map((r: any) => r.id));
    const pending = migrations.filter((m) => !applied.has(m.id));

    if (pending.length === 0) return;

    console.log(`🧬 Schema migrations: applying ${pending.length} pending...`);
    const ctx: MigrationCtx = { exec, run, get, all, isPostgres };
    for (const m of pending) {
        try {
            await m.up(ctx);
            // Idempotent recording: under the multi-node boot lock only one node applies migrations,
            // but make the INSERT conflict-safe too so a duplicate id can never crash a boot.
            await run(
                isPostgres
                    ? 'INSERT INTO schema_migrations (id) VALUES (?) ON CONFLICT (id) DO NOTHING'
                    : 'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
                [m.id]
            );
            console.log(`   ✓ applied schema migration ${m.id}`);
        } catch (e: any) {
            // Fail closed: do NOT continue on a half-migrated schema.
            console.error(`   ✗ schema migration ${m.id} FAILED: ${e && e.message}`);
            throw e;
        }
    }
}

module.exports = { runSchemaMigrations };
