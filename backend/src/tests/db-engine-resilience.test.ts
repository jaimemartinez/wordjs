/**
 * Database drivers: resilience, engine switch, backups and parity across SQLite / Postgres / MySQL.
 *
 *   • A Postgres connection the server closes (restart, failover, pgbouncer, pg_terminate_backend) no
 *     longer kills the process: the pool and its clients listen for 'error'. The supervisor backs off
 *     instead of giving up after five fast crashes.
 *   • The engine switch from the panel works from a SQLite-native site: the FTS5 index tables are not
 *     copied (the target builds its own search index), generated columns are left out, the Postgres
 *     FK switch no longer aborts the copy for a non-superuser, sequences move past the copied ids, and
 *     the config written for the restart carries the new password (a leftover flat `dbPassword` from the
 *     SQLite install shadowed it, and the site could not boot).
 *   • A post over 64 K characters can be saved again (the revision snapshot bounded a column it never
 *     stores).
 *   • MySQL/MariaDB hold email and slug uniqueness in the database (generated key columns), a deadlock
 *     victim is retried, a concurrent duplicate slug becomes the next free slug.
 *   • Backups of Postgres/MySQL work without pg_dump/mysqldump (WordJS's own portable dump).
 *   • Postgres: a non-UTF8 database is refused by the installer, search folds accents and keeps every
 *     word ('simple' + unaccent), dates that took a column default read as `YYYY-MM-DD HH:MM:SS`.
 *   • LIKE searches escape % and _ and ignore case on every engine.
 *
 * Unit tests run everywhere. The real-engine tests run under WORDJS_CI_DB=1 (CI's services, or any
 * server reachable through PGHOST… / MYSQL_HOST…); each works in a throwaway schema / database it drops.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

require('../config/app');
const migration = require('../core/db-admin/migration');
const pgDriverModule = require('../drivers/postgres');
const mysqlDriverModule = require('../drivers/mysql');

const REAL = process.env.WORDJS_CI_DB === '1';
const SUFFIX = `${process.pid}_${Date.now() % 1e6}`;

function pgSettings() {
    return {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD ?? 'password',
        name: process.env.PGDATABASE || 'wordjs',
    };
}
function mysqlSettings() {
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
}

const withTimeout = (p: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); })])
        .finally(() => clearTimeout(timer));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Postgres pool: a closed connection is an event, not a crash ───────────────────────────────────
test('postgres pool: an idle connection the server closes is absorbed by the pool and client listeners', () => {
    const pool = new EventEmitter();
    pgDriverModule.attachPoolErrorHandlers(pool);
    const client = new EventEmitter();
    pool.emit('connect', client);
    const err: any = new Error('terminating connection due to administrator command');
    err.code = '57P01';
    // Without a listener, EventEmitter throws an 'error' event — that throw was the process crash.
    assert.doesNotThrow(() => pool.emit('error', err, client));
    assert.doesNotThrow(() => client.emit('error', err));
});

test('postgres: connection-lost errors are recognised; ordinary SQL errors are not', () => {
    for (const code of ['57P01', '57P02', '57P03', '08006', 'ECONNRESET']) {
        assert.strictEqual(pgDriverModule.isConnectionLost({ code }), true, code);
    }
    assert.strictEqual(pgDriverModule.isConnectionLost({ message: 'Connection terminated unexpectedly' }), true);
    assert.strictEqual(pgDriverModule.isConnectionLost({ code: '23505', message: 'duplicate key' }), false);
    assert.strictEqual(pgDriverModule.isConnectionLost({ code: '42P01' }), false);
});

test('supervisor: crashes back off (1 s, 2 s, 4 s … capped) instead of giving up', () => {
    const sup = require('../../server.js');
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(sup.backoffMs), [1000, 2000, 4000, 8000, 16000, 30000]);
    assert.strictEqual(sup.backoffMs(50), sup.MAX_BACKOFF_MS, 'a long crash loop keeps retrying at the cap');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    assert.ok(!/Giving up/.test(src), 'the supervisor has no give-up path left');
});

// ── Engine switch: the config the restart reads ───────────────────────────────────────────────────
test('engine switch: the written config resolves to the NEW password even with a flat dbPassword left by SQLite', () => {
    const { resolveDbConnection } = require('../config/app');
    const sqliteInstall = { installedAt: 'x', dbDriver: 'sqlite-native', dbPath: './data/wordjs-native.db', dbPassword: 'f'.repeat(32), dbHost: 'stale-host' };
    const next = migration.withTargetDatabase(sqliteInstall, {
        targetDriver: 'mysql', dbPath: null,
        conn: { host: 'db.example', port: '', user: 'app', name: 'site', password: 'the-new-one', ssl: false, sslRejectUnauthorized: true },
    });
    const conn = resolveDbConnection(next);
    assert.strictEqual(next.dbDriver, 'mysql');
    assert.strictEqual(conn.password, 'the-new-one', 'the flat key no longer shadows the new password');
    assert.strictEqual(conn.host, 'db.example', 'no flat connection key shadows the new host');
    assert.strictEqual(conn.port, 3306, 'an empty port is the engine default, not Postgres 5432');
    assert.strictEqual(conn.name, 'site');
    assert.strictEqual(next.installedAt, 'x', 'the rest of the config is kept');

    const toSqlite = migration.withTargetDatabase({ dbDriver: 'postgres', db: { host: 'h' } }, { targetDriver: 'sqlite-native', dbPath: './data/wordjs-native.db', conn: null });
    assert.strictEqual(toSqlite.dbPath, './data/wordjs-native.db');
});

function nativeDb(file = ':memory:') {
    let Database: any;
    try { Database = require('better-sqlite3'); } catch { return null; }
    return new Database(file);
}

test('engine switch: the FTS5 index and its shadow tables are not copied; real tables are', async (t: any) => {
    const db = nativeDb();
    if (!db) return t.skip('better-sqlite3 unavailable');
    db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, post_title TEXT, post_content TEXT);
             CREATE VIRTUAL TABLE posts_fts USING fts5(post_title, post_content, content='posts', content_rowid='id');
             CREATE TABLE wjp_faq_items (id INTEGER PRIMARY KEY, q TEXT);
             CREATE TABLE posts_fts_notes (id INTEGER PRIMARY KEY);`);
    const tables = await migration.listSourceTables((sql: string) => Promise.resolve(db.prepare(sql).all()), 'sqlite-native');
    assert.ok(tables.includes('posts') && tables.includes('wjp_faq_items'));
    for (const shadow of ['posts_fts', 'posts_fts_data', 'posts_fts_idx', 'posts_fts_docsize', 'posts_fts_config']) {
        assert.ok(!tables.includes(shadow), `${shadow} is an index, not data`);
    }
    assert.ok(tables.includes('posts_fts_notes'), 'a real table whose name merely starts like one is kept');
    db.close();
});

test('engine switch: tables are copied after the tables they reference', async (t: any) => {
    const db = nativeDb();
    if (!db) return t.skip('better-sqlite3 unavailable');
    db.exec(`CREATE TABLE wjp_a_lines (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES wjp_a_orders(id));
             CREATE TABLE wjp_a_orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES wjp_a_customers(id));
             CREATE TABLE wjp_a_customers (id INTEGER PRIMARY KEY);`);
    const ordered = await migration.orderByForeignKeys(['wjp_a_lines', 'wjp_a_orders', 'wjp_a_customers'],
        (sql: string) => Promise.resolve(db.prepare(sql).all()), true);
    assert.deepStrictEqual(ordered, ['wjp_a_customers', 'wjp_a_orders', 'wjp_a_lines']);
    db.close();
});

test('engine switch: generated columns of the source are left out of the copied rows', async () => {
    const tx: any = { rows: [] as any[], exec: async () => {}, run: async (_s: string, p: any[]) => { tx.rows.push(p); }, get: async () => ({ c: 1 }) };
    await migration.copyAllTables({
        tables: ['posts'], nonCore: [], isAsyncTarget: true, isMysqlTarget: true, targetKind: 'mysql',
        targetModule: { transaction: (fn: any) => fn(tx) }, targetExec: async () => {},
        schemaByTable: {}, readAll: async () => [], sourceIsSqlite: false,
        sourceRead: { all: () => [{ id: 1, post_title: 'a', search_vector: "'a':1" }] },
        generatedColumns: { posts: new Set(['search_vector']) },
    });
    assert.deepStrictEqual(tx.rows, [[1, 'a']], 'search_vector is not sent to the target');
});

// ── Long content ──────────────────────────────────────────────────────────────────────────────────
test('revisions: a post over 64 K characters can be snapshotted (and so saved); manifest values stay bounded', () => {
    const snapshots = require('../core/revision-snapshots');
    const big = '<p>' + 'x'.repeat(200_000) + '</p>';
    assert.doesNotThrow(() => snapshots.buildRevisionSnapshot({ post_type: 'post', post_title: 't', post_content: big, post_excerpt: '' }, []));
    assert.doesNotThrow(() => snapshots.buildRevisionSnapshot({ post_type: 'post', post_title: 'y'.repeat(70_000), post_content: '', post_excerpt: '' }, []));
});

// ── LIKE parity ───────────────────────────────────────────────────────────────────────────────────
test('LIKE search: % and _ are literal, and case does not matter', async (t: any) => {
    const { containsPattern, containsSql } = require('../core/sql-like');
    assert.strictEqual(containsPattern('50%_off!'), '%50!%!_off!!%');
    const db = nativeDb();
    if (!db) return t.skip('better-sqlite3 unavailable');
    require('../core/sqlite-functions').registerSqliteFunctions(db);
    db.exec("CREATE TABLE p (t TEXT); INSERT INTO p VALUES ('José Pérez'), ('100% real'), ('a_b'), ('MURCIÉLAGO árbol');");
    const q = (term: string) => db.prepare(`SELECT t FROM p WHERE ${containsSql('t')}`).all(containsPattern(term)).map((r: any) => r.t);
    assert.deepStrictEqual(q('%'), ['100% real']);
    assert.deepStrictEqual(q('_'), ['a_b']);
    assert.deepStrictEqual(q('JOS'), ['José Pérez']);
    // SQLite folds full Unicode case and accents on this path (S3-15: legacy found nothing for these).
    assert.deepStrictEqual(q('murciélago'), ['MURCIÉLAGO árbol']);
    assert.deepStrictEqual(q('ARBOL'), ['MURCIÉLAGO árbol']);
    assert.deepStrictEqual(q('perez'), ['José Pérez']);
    db.close();
});

test('postgres search: the query uses the column\'s own configuration and a prefix on the last word', () => {
    const Post = require('../models/Post');
    assert.strictEqual(Post._pgConfigFromExpression("to_tsvector('wordjs_search'::regconfig, ((COALESCE(post_title, ''::text)"), 'wordjs_search');
    assert.strictEqual(Post._pgConfigFromExpression("to_tsvector('english'::regconfig, x)"), 'english');
    assert.strictEqual(Post._pgConfigFromExpression("to_tsvector('x'); DROP TABLE posts; --'"), 'x');
    assert.strictEqual(Post._pgConfigFromExpression(null), 'english');
    const saved = Post._pgSearchConfig;
    Post._pgSearchConfig = 'wordjs_search';
    try {
        const c = Post._searchClauses('pg', 'canción', 'p.');
        assert.ok(c.filterSql.includes("plainto_tsquery('wordjs_search', ?)"));
        assert.ok(c.filterSql.includes(":*"), 'the last lexeme is a prefix match');
        assert.deepStrictEqual(c.filterParams, ['canción']);
    } finally { Post._pgSearchConfig = saved; }
});

test('postgres DDL: a TEXT date column defaulting to CURRENT_TIMESTAMP gets the UTC YYYY-MM-DD HH:MM:SS default', () => {
    const out = pgDriverModule.translateSql('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, post_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created DATETIME DEFAULT CURRENT_TIMESTAMP)');
    assert.ok(out.includes(`post_date TEXT NOT NULL DEFAULT ${pgDriverModule.PG_TEXT_NOW}`));
    assert.ok(/created TIMESTAMP DEFAULT CURRENT_TIMESTAMP/.test(out), 'a real TIMESTAMP column keeps CURRENT_TIMESTAMP');
});

test('mysql: a deadlock is recognised as retryable', () => {
    assert.strictEqual(mysqlDriverModule.isDeadlock({ code: 'ER_LOCK_DEADLOCK' }), true);
    assert.strictEqual(mysqlDriverModule.isDeadlock({ errno: 1213 }), true);
    assert.strictEqual(mysqlDriverModule.isDeadlock({ code: 'ER_DUP_ENTRY' }), false);
});

test('portable dump: binary, dates and big integers survive the encoding', () => {
    const pd = require('../core/portable-dump');
    const buf = Buffer.from([0, 1, 254, 255]);
    assert.ok(Buffer.isBuffer(pd.decodeValue(pd.encodeValue(buf))) && pd.decodeValue(pd.encodeValue(buf)).equals(buf));
    const d = new Date(2026, 9, 21, 13, 4, 5, 6);
    assert.strictEqual(pd.encodeValue(d), '2026-10-21 13:04:05.006');
    assert.strictEqual(pd.encodeValue(BigInt('9007199254740993')), '9007199254740993');
    assert.deepStrictEqual(pd.decodeValue({ $b64: 'AA==', other: 1 }), { $b64: 'AA==', other: 1 }, 'only an exact {$b64} is binary');
});

// ── Real engines ──────────────────────────────────────────────────────────────────────────────────

/** A SQLite-native source with the real core schema + migrations (FTS5 included) and some content. */
async function seededNativeSource(file: string) {
    const db = nativeDb(file);
    if (!db) return null;
    const { NativeWrapper } = require('../drivers/sqlite-native');
    const w = new NativeWrapper(db);
    const dbm = require('../config/database');
    const { runSchemaMigrations } = require('../core/schema-migrations');
    await dbm.initializeSchema(w, false);
    await runSchemaMigrations(w, false, 'sqlite-native');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'posts_fts'").get(), 'the source has its FTS5 index');
    const ins = db.prepare("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_date, post_date_gmt, post_modified, post_modified_gmt, guid) VALUES (1, ?, ?, '', 'publish', ?, 'post', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '')");
    ins.run('Ñandú Canción', '<p>Murciélago About pingüino</p>', 'nandu-cancion');
    ins.run('Second', '<p>' + 'z'.repeat(70_000) + '</p>', 'second');
    db.prepare("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'Admin')").run();
    db.exec('CREATE TABLE wjp_b_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)');
    db.prepare("INSERT INTO wjp_b_orders (note) VALUES ('日本語 🎉')").run();
    return { db, w };
}

async function migrateNativeInto(source: any, target: any, targetDriver: string) {
    const readAll = (sql: string) => Promise.resolve(source.db.prepare(sql).all());
    const tables = await migration.listSourceTables(readAll, 'sqlite-native');
    const nonCore = tables.filter((x: string) => !migration.CORE_TABLES.has(x));
    const schemaByTable: Record<string, any> = {};
    for (const x of nonCore) schemaByTable[x] = { sql: source.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(x).sql, columns: [] };
    await require('../config/database').initializeSchema(target, true);
    await migration.buildTargetSchema(target, true, targetDriver);
    const rows = await migration.copyAllTables({
        tables, nonCore, generatedColumns: {}, isAsyncTarget: true, isMysqlTarget: targetDriver === 'mysql', targetKind: targetDriver,
        targetModule: target, targetExec: (s: string) => target.exec(s), schemaByTable, readAll,
        sourceIsSqlite: true, sourceRead: { all: (sql: string) => source.db.prepare(sql).all() },
    });
    await migration.rebuildEngineSpecificSchema(target, true, targetDriver);
    return { rows, tables };
}

async function pgScratch(t: any): Promise<{ driver: any; schema: string; admin: any } | null> {
    if (!REAL) { t.skip('WORDJS_CI_DB!=1 — no real Postgres'); return null; }
    const { Client } = require('pg');
    const s = pgSettings();
    const admin = new Client({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.name, connectionTimeoutMillis: 5000 });
    admin.on('error', () => {});
    try { await admin.connect(); } catch (e: any) { t.skip(`no reachable Postgres: ${e.message}`); return null; }
    const schema = `wjs_t_${SUFFIX}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const driver = new pgDriverModule.PostgresDriver();
    driver.config = { ...s, schema, poolMax: 4 };
    await withTimeout(driver.connect(), 10000);
    return { driver, schema, admin };
}
async function pgDrop(ctx: any) {
    if (!ctx) return;
    try { await ctx.driver.close(); } catch { /* */ }
    try { await ctx.admin.query(`DROP SCHEMA IF EXISTS ${ctx.schema} CASCADE`); } catch { /* */ }
    try { await ctx.admin.end(); } catch { /* */ }
}

test('postgres (real): terminating the pool\'s idle connections does not crash the process; the next query reconnects', async (t: any) => {
    const ctx = await pgScratch(t);
    if (!ctx) return;
    const crashes: any[] = [];
    const onUncaught = (e: any) => crashes.push(e);
    process.on('uncaughtException', onUncaught);
    try {
        // Open several pooled connections, then let them go idle.
        await Promise.all([1, 2, 3].map(() => ctx.driver.get('SELECT pg_sleep(0.05) AS s')));
        const killed = await ctx.admin.query(
            `SELECT pg_terminate_backend(pid) AS k FROM pg_stat_activity
              WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid() AND state = 'idle'
                AND query LIKE '%pg_sleep(0.05)%'`
        );
        assert.ok(killed.rows.length >= 1, 'at least one idle pooled connection was terminated');
        await sleep(300);
        assert.deepStrictEqual(crashes, [], 'no uncaught exception');
        const r = await ctx.driver.get('SELECT 1 AS ok');
        assert.strictEqual(Number(r.ok), 1, 'the pool opened a fresh connection');
        // A read whose connection dies between checkout and query is retried once.
        const again = await ctx.driver.all('SELECT 2 AS ok');
        assert.strictEqual(Number(again[0].ok), 2);
    } finally {
        process.removeListener('uncaughtException', onUncaught);
        await pgDrop(ctx);
    }
});

test('postgres (real): a SQLite-native site switches to Postgres — search, sequences, dates, non-superuser copy', async (t: any) => {
    const ctx = await pgScratch(t);
    if (!ctx) return;
    const file = path.join(os.tmpdir(), `wjs-b-src-${SUFFIX}.db`);
    const src = await seededNativeSource(file);
    if (!src) { await pgDrop(ctx); return t.skip('better-sqlite3 unavailable'); }
    try {
        const { tables } = await migrateNativeInto(src, ctx.driver, 'postgres');
        assert.ok(!tables.includes('posts_fts'), 'the FTS5 index was not sent to Postgres');
        const n = await ctx.driver.get('SELECT COUNT(*) AS c FROM posts');
        assert.strictEqual(Number(n.c), 2);
        const big = await ctx.driver.get("SELECT length(post_content) AS l FROM posts WHERE post_name = 'second'");
        assert.ok(Number(big.l) > 70_000, 'long content copied whole');
        const plugin = await ctx.driver.get('SELECT note FROM wjp_b_orders');
        assert.strictEqual(plugin.note, '日本語 🎉');

        // The target's own search index, accent-folding, no English stopwords, prefix on the last word.
        const Post = require('../models/Post');
        const gen = await ctx.driver.get("SELECT generation_expression AS g FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'posts' AND column_name = 'search_vector'");
        assert.ok(gen && gen.g, 'search_vector built on the target');
        const saved = Post._pgSearchConfig;
        Post._pgSearchConfig = Post._pgConfigFromExpression(gen.g);
        try {
            const find = async (q: string) => {
                const c = Post._searchClauses('pg', q, '');
                return (await ctx.driver.all(`SELECT post_name FROM posts WHERE ${c.filterSql}`, c.filterParams)).map((r: any) => r.post_name);
            };
            assert.deepStrictEqual(await find('Canción'), ['nandu-cancion']);
            assert.deepStrictEqual(await find('about'), ['nandu-cancion'], 'no English stopword list');
            assert.deepStrictEqual(await find('murciél'), ['nandu-cancion'], 'prefix on the last word');
            const accentFolding = Post._pgSearchConfig === 'wordjs_search' &&
                !!(await ctx.driver.get("SELECT 1 AS ok FROM pg_extension WHERE extname = 'unaccent'"));
            if (accentFolding) {
                assert.deepStrictEqual(await find('cancion'), ['nandu-cancion'], 'accents folded');
                assert.deepStrictEqual(await find('nandu'), ['nandu-cancion']);
            } else {
                t.diagnostic('unaccent is not available to this role here: accent folding not asserted');
            }
        } finally { Post._pgSearchConfig = saved; }

        // Title order as readers expect (M3-12): the key models/Post._titleSortKey builds for Postgres.
        const ext = await ctx.driver.get("SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent'");
        const key = ext ? `LOWER("${ext.s}".unaccent(post_title))` : 'LOWER(post_title)';
        await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'Zebra', '', '', 'publish', 'zebra', 'post', ''), (1, 'apple', '', '', 'publish', 'apple', 'post', ''), (1, 'Éclair', '', '', 'publish', 'eclair', 'post', '')");
        const ordered = (await ctx.driver.all(`SELECT post_title FROM posts WHERE post_name IN ('zebra','apple','eclair') ORDER BY ${key}, post_title`)).map((r: any) => r.post_title);
        assert.deepStrictEqual(ordered, ['apple', 'Éclair', 'Zebra']);

        // Sequences moved past the copied ids: a new row gets a fresh id instead of a duplicate-key error.
        const ins = await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'New', '', '', 'draft', 'new', 'post', '')");
        assert.ok(Number(ins.lastID) > 2, `new id ${ins.lastID} is past the copied ones`);
        const row = await ctx.driver.get("SELECT post_date FROM posts WHERE post_name = 'new'");
        assert.match(String(row.post_date), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'a defaulted date reads YYYY-MM-DD HH:MM:SS');
        const u = await ctx.driver.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('second', 'x', 'second@example.com', 'S')");
        assert.ok(Number(u.lastID) > 1);
    } finally {
        try { src.db.close(); } catch { /* */ }
        for (const f of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
        await pgDrop(ctx);
    }
});

test('postgres (real): the engine switch opens the connection the restart will use, with the leftover SQLite dbPassword in the file', async (t: any) => {
    if (!REAL) return t.skip('WORDJS_CI_DB!=1 — no real Postgres');
    const s = pgSettings();
    const sqliteInstall = { installedAt: 'x', dbDriver: 'sqlite-native', dbPassword: 'f'.repeat(32) };
    const good = migration.withTargetDatabase(sqliteInstall, { targetDriver: 'postgres', dbPath: null, conn: { host: s.host, port: s.port, user: s.user, name: s.name, password: s.password } });
    try { await withTimeout(migration.verifyBootConnection('postgres', good), 15000); }
    catch (e: any) { return t.skip(`no reachable Postgres: ${e.message}`); }
    // What the old code wrote: the nested block only, so the flat SQLite password won.
    const old = { ...sqliteInstall, dbDriver: 'postgres', db: { host: s.host, port: s.port, user: s.user, name: s.name, password: s.password } };
    await assert.rejects(withTimeout(migration.verifyBootConnection('postgres', old), 15000), /password|authentication/i);
});

test('postgres (real): migration 0022 rewrites dates stored in Postgres\'s own text form', async (t: any) => {
    const ctx = await pgScratch(t);
    if (!ctx) return;
    try {
        await ctx.driver.exec("CREATE TABLE t_dates (id SERIAL PRIMARY KEY, d TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        await ctx.driver.exec("ALTER TABLE t_dates ALTER COLUMN d SET DEFAULT CURRENT_TIMESTAMP");
        await ctx.driver.run("INSERT INTO t_dates (d) VALUES ('2026-10-21 11:19:18.683525+00')");
        await ctx.driver.run("INSERT INTO t_dates (d) VALUES ('2026-10-21 13:00:00.5+02')");
        await ctx.driver.run("INSERT INTO t_dates (d) VALUES ('2026-10-21 09:00:00')");
        const { runSchemaMigrations, MIGRATIONS } = require('../core/schema-migrations');
        await runSchemaMigrations(ctx.driver, true, 'postgres', MIGRATIONS.filter((m: any) => m.id === '0022_pg_text_timestamp_format'));
        const rows = (await ctx.driver.all('SELECT d FROM t_dates ORDER BY id')).map((r: any) => r.d);
        assert.deepStrictEqual(rows, ['2026-10-21 11:19:18', '2026-10-21 11:00:00', '2026-10-21 09:00:00']);
        await ctx.driver.run('INSERT INTO t_dates DEFAULT VALUES');
        const fresh = await ctx.driver.get('SELECT d FROM t_dates ORDER BY id DESC LIMIT 1');
        assert.match(String(fresh.d), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    } finally { await pgDrop(ctx); }
});

test('postgres (real): a backup without pg_dump — the portable dump restores every table exactly', async (t: any) => {
    const ctx = await pgScratch(t);
    if (!ctx) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-b-dump-'));
    try {
        const pd = require('../core/portable-dump');
        await ctx.driver.exec('CREATE TABLE wjp_b_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, blob BLOB, at DATETIME)');
        await ctx.driver.run("INSERT INTO wjp_b_items (name, blob, at) VALUES (?, ?, '2026-10-21 10:11:12')", ['ünï 🎉', Buffer.from([1, 2, 3])]);
        await ctx.driver.run("INSERT INTO wjp_b_items (name) VALUES ('two')");
        const file = path.join(dir, pd.PORTABLE_ENTRY);
        const cap = await pd.capturePortableDump(file, { driver: 'postgres', db: ctx.driver });
        assert.ok(cap.tables >= 1 && cap.rows === 2);
        // Damage after the backup: a row changed, one deleted, one added, a table dropped.
        await ctx.driver.run("UPDATE wjp_b_items SET name = 'changed' WHERE name = 'two'");
        await ctx.driver.run("INSERT INTO wjp_b_items (name) VALUES ('after the backup')");
        await ctx.driver.exec('CREATE TABLE wjp_b_other (id SERIAL PRIMARY KEY, v TEXT)');
        await ctx.driver.run("INSERT INTO wjp_b_other (v) VALUES ('x')");
        const dumpOther = path.join(dir, 'second.jsonl');
        await pd.capturePortableDump(dumpOther, { driver: 'postgres', db: ctx.driver });
        await ctx.driver.exec('DROP TABLE wjp_b_other');
        await pd.restorePortableDump(file, { driver: 'postgres', db: ctx.driver });
        const rows = await ctx.driver.all('SELECT id, name, blob, at FROM wjp_b_items ORDER BY id');
        assert.deepStrictEqual(rows.map((r: any) => r.name), ['ünï 🎉', 'two']);
        assert.ok(Buffer.from(rows[0].blob).equals(Buffer.from([1, 2, 3])), 'binary restored');
        const next = await ctx.driver.run("INSERT INTO wjp_b_items (name) VALUES ('next')");
        assert.ok(Number(next.lastID) > 2, 'the sequence follows the restored ids');
        // A table dropped since the backup comes back from the dump.
        await pd.restorePortableDump(dumpOther, { driver: 'postgres', db: ctx.driver });
        const other = await ctx.driver.all('SELECT v FROM wjp_b_other');
        assert.deepStrictEqual(other.map((r: any) => r.v), ['x']);
        await assert.rejects(pd.restorePortableDump(file, { driver: 'mysql', db: ctx.driver }), /made on postgres/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await pgDrop(ctx);
    }
});

test('postgres (real): the installer refuses a SQL_ASCII database, accepts UTF8', async (t: any) => {
    if (!REAL) return t.skip('WORDJS_CI_DB!=1 — no real Postgres');
    const { pgEncodingProblem } = require('../routes/setup');
    const { Client } = require('pg');
    const s = pgSettings();
    const open = async (database: string) => {
        const c = new Client({ host: s.host, port: s.port, user: s.user, password: s.password, database, connectionTimeoutMillis: 5000 });
        c.on('error', () => {});
        await c.connect();
        return c;
    };
    let utf8: any;
    try { utf8 = await open(s.name); } catch (e: any) { return t.skip(`no reachable Postgres: ${e.message}`); }
    try {
        const enc = (await utf8.query('SHOW server_encoding')).rows[0].server_encoding;
        if (String(enc).toUpperCase() === 'UTF8') assert.strictEqual(await pgEncodingProblem(utf8), null);
        // A SQL_ASCII database: the one named in PG_SQL_ASCII_DB, or one this role may create.
        let asciiName = process.env.PG_SQL_ASCII_DB || '';
        let created = false;
        if (!asciiName) {
            asciiName = `wjs_ascii_${SUFFIX}`;
            try { await utf8.query(`CREATE DATABASE ${asciiName} ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`); created = true; }
            catch (e: any) { return t.skip(`cannot create a SQL_ASCII database here: ${e.message}`); }
        }
        const ascii = await open(asciiName);
        try {
            const problem = await pgEncodingProblem(ascii);
            assert.ok(problem && /SQL_ASCII/.test(problem) && /ENCODING 'UTF8'/.test(problem), problem || 'no problem reported');
        } finally {
            await ascii.end();
            if (created) await utf8.query(`DROP DATABASE IF EXISTS ${asciiName}`);
        }
    } finally { await utf8.end(); }
});

async function mysqlScratch(t: any): Promise<{ driver: any; name: string; admin: any } | null> {
    if (!REAL) { t.skip('WORDJS_CI_DB!=1 — no real MySQL'); return null; }
    const mysql = require('mysql2/promise');
    const s = mysqlSettings();
    let admin: any;
    try { admin = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, connectTimeout: 5000 }); }
    catch (e: any) { t.skip(`no reachable MySQL: ${e.message}`); return null; }
    const name = `wjs_t_${SUFFIX}`;
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const driver = new mysqlDriverModule.MysqlDriver();
    driver.config = { ...s, name, connectionLimit: 6 };
    await withTimeout(driver.connect(), 10000);
    return { driver, name, admin };
}
async function mysqlDrop(ctx: any) {
    if (!ctx) return;
    try { await ctx.driver.close(); } catch { /* */ }
    try { await ctx.admin.query(`DROP DATABASE IF EXISTS ${ctx.name}`); } catch { /* */ }
    try { await ctx.admin.end(); } catch { /* */ }
}

test('mysql (real): a SQLite-native site switches to MySQL — FTS tables skipped, unique email/slug enforced', async (t: any) => {
    const ctx = await mysqlScratch(t);
    if (!ctx) return;
    const file = path.join(os.tmpdir(), `wjs-b-srcmy-${SUFFIX}.db`);
    const src = await seededNativeSource(file);
    if (!src) { await mysqlDrop(ctx); return t.skip('better-sqlite3 unavailable'); }
    try {
        await migrateNativeInto(src, ctx.driver, 'mysql');
        const n = await ctx.driver.get('SELECT COUNT(*) AS c FROM posts');
        assert.strictEqual(Number(n.c), 2);
        const idx = await ctx.driver.all("SELECT DISTINCT index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name IN ('uq_users_email', 'uq_posts_slug', 'ftidx_posts_search')");
        assert.deepStrictEqual(idx.map((r: any) => r.i || r.INDEX_NAME).sort(), ['ftidx_posts_search', 'uq_posts_slug', 'uq_users_email']);
        await assert.rejects(
            ctx.driver.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('other', 'x', 'ADMIN@example.com', 'O')"),
            (e: any) => require('../core/db-errors').isUniqueViolation(e),
            'the same email in other case is refused by the database'
        );
        await assert.rejects(
            ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'x', '', '', 'draft', 'second', 'post', '')"),
            (e: any) => require('../core/db-errors').isUniqueViolation(e) && /uq_posts_slug/.test(e.message),
        );
        // Empty slugs never collide; the same slug under another type is allowed.
        await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'a', '', '', 'draft', '', 'post', '')");
        await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'b', '', '', 'draft', '', 'post', '')");
        await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'c', '', '', 'draft', 'second', 'page', '')");
        // A LIKE search for % finds only a literal %.
        const { containsSql, containsPattern } = require('../core/sql-like');
        const pct = await ctx.driver.all(`SELECT id FROM posts WHERE ${containsSql('post_title', 'mysql')}`, [containsPattern('%')]);
        assert.strictEqual(pct.length, 0);
        // The generated key columns stay out of an engine switch away from MySQL.
        const gen = await migration.listGeneratedColumns((sql: string) => ctx.driver.all(sql), 'mysql');
        assert.ok(gen.users && gen.users.has('user_email_key') && gen.posts && gen.posts.has('post_slug_key'));
    } finally {
        try { src.db.close(); } catch { /* */ }
        for (const f of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
        await mysqlDrop(ctx);
    }
});

test('mysql (real): migration 0020 lists duplicates instead of failing, and adds the key once they are gone', async (t: any) => {
    const ctx = await mysqlScratch(t);
    if (!ctx) return;
    try {
        await require('../config/database').initializeSchema(ctx.driver, true);
        await ctx.driver.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('a', 'x', 'dup@example.com', 'A')");
        await ctx.driver.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('b', 'x', 'DUP@example.com', 'B')");
        const { ensureMysqlUniqueKeys } = require('../core/mysql-unique-keys');
        const ctxm = { exec: (s: string) => ctx.driver.exec(s), get: (s: string, p?: any[]) => ctx.driver.get(s, p), all: (s: string, p?: any[]) => ctx.driver.all(s, p) };
        const first = await ensureMysqlUniqueKeys(ctxm);
        assert.ok(first.skipped.includes('uq_users_email') && first.created.includes('uq_posts_slug'));
        await ctx.driver.run("DELETE FROM users WHERE user_login = 'b'");
        const second = await ensureMysqlUniqueKeys(ctxm);
        assert.deepStrictEqual(second.created, ['uq_users_email']);
        const third = await ensureMysqlUniqueKeys(ctxm);
        assert.deepStrictEqual(third, { created: [], skipped: [] }, 'idempotent');
    } finally { await mysqlDrop(ctx); }
});

test('mysql (real): a deadlock victim is run again and both transactions commit', async (t: any) => {
    const ctx = await mysqlScratch(t);
    if (!ctx) return;
    try {
        await ctx.driver.exec('CREATE TABLE t_dl (id INT PRIMARY KEY, v INT NOT NULL)');
        await ctx.driver.run('INSERT INTO t_dl (id, v) VALUES (1, 0), (2, 0)');
        let arrived = 0;
        let release: () => void = () => {};
        const bothHoldOneLock = new Promise<void>((r) => { release = r; });
        let runs = 0;
        const unit = (first: number, second: number) => ctx.driver.transaction(async (tx: any) => {
            runs++;
            await tx.run('UPDATE t_dl SET v = v + 1 WHERE id = ?', [first]);
            if (++arrived === 2) release();
            await Promise.race([bothHoldOneLock, sleep(2000)]);
            await tx.run('UPDATE t_dl SET v = v + 1 WHERE id = ?', [second]);
        });
        await Promise.all([unit(1, 2), unit(2, 1)]);
        assert.ok(runs >= 3, `one transaction was run again (${runs} runs)`);
        const rows = await ctx.driver.all('SELECT v FROM t_dl ORDER BY id');
        assert.deepStrictEqual(rows.map((r: any) => Number(r.v)), [2, 2], 'both units applied exactly once');
    } finally { await mysqlDrop(ctx); }
});

test('mysql (real): a backup without mysqldump — the portable dump restores every table exactly', async (t: any) => {
    const ctx = await mysqlScratch(t);
    if (!ctx) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-b-mydump-'));
    try {
        const pd = require('../core/portable-dump');
        await require('../config/database').initializeSchema(ctx.driver, true);
        await require('../core/mysql-unique-keys').ensureMysqlUniqueKeys({ exec: (s: string) => ctx.driver.exec(s), get: (s: string, p?: any[]) => ctx.driver.get(s, p), all: (s: string, p?: any[]) => ctx.driver.all(s, p) });
        await ctx.driver.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('a', 'x', 'a@example.com', 'Ä 🎉')");
        await ctx.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'p', ?, '', 'publish', 'p', 'post', '')", ['y'.repeat(80_000)]);
        const file = path.join(dir, pd.PORTABLE_ENTRY);
        await pd.capturePortableDump(file, { driver: 'mysql', db: ctx.driver });
        await ctx.driver.run("DELETE FROM users");
        await ctx.driver.run("UPDATE posts SET post_title = 'changed'");
        await pd.restorePortableDump(file, { driver: 'mysql', db: ctx.driver });
        const u = await ctx.driver.all('SELECT display_name, user_email_key FROM users');
        assert.deepStrictEqual(u.map((r: any) => [r.display_name, r.user_email_key]), [['Ä 🎉', 'a@example.com']], 'rows back; the generated key recomputed');
        const p = await ctx.driver.get('SELECT post_title, CHAR_LENGTH(post_content) AS l FROM posts');
        assert.strictEqual(p.post_title, 'p');
        assert.strictEqual(Number(p.l), 80_000);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await mysqlDrop(ctx);
    }
});

test('installer: a failed "Test connection" says which field to check', () => {
    const { explainDbConnectError } = require('../routes/setup');
    const conn = { host: 'db.invalid', port: 5432 };
    assert.match(explainDbConnectError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.invalid' }, 'postgres', conn), /host name "db\.invalid" could not be found/);
    assert.match(explainDbConnectError({ message: 'timeout expired' }, 'postgres', conn), /No answer from db\.invalid:5432/);
    assert.match(explainDbConnectError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, 'mysql', { host: 'h', port: 3307 }), /Nothing accepts connections on h:3307/);
    assert.match(explainDbConnectError({ code: '28P01', message: 'password authentication failed for user "x"' }, 'postgres', conn), /User and Password/);
    assert.match(explainDbConnectError({ code: 'ER_BAD_DB_ERROR', message: "Unknown database 'w'" }, 'mysql', conn), /Database field/);
    assert.match(explainDbConnectError({ message: 'Received unexpected copyData message from backend.' }, 'postgres', { host: 'h', port: 3306 }), /other engine/);
    assert.strictEqual(explainDbConnectError({ message: 'something else' }, 'postgres', conn), 'something else');
});

test('sqlite files: the database and its companions are made owner-only', (t: any) => {
    if (process.platform === 'win32') return t.skip('no POSIX mode bits on Windows');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-b-mode-'));
    try {
        const f = path.join(dir, 'x.db');
        fs.writeFileSync(f, ''); fs.chmodSync(f, 0o644);
        fs.writeFileSync(f + '-wal', ''); fs.chmodSync(f + '-wal', 0o664);
        require('../core/db-file-mode').restrictDbFiles(f);
        assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
        assert.strictEqual(fs.statSync(f + '-wal').mode & 0o777, 0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('posts API: an invalid date is refused instead of becoming "now" or rolling into another month', () => {
    const { isInvalidPostDate } = require('../routes/posts');
    for (const ok of [undefined, null, '', '2026-10-21T10:00:00Z', '2026-10-21 10:00:00', '2024-02-29T00:00:00+05:00', '1969-12-31T23:59:59Z']) {
        assert.strictEqual(isInvalidPostDate(ok), false, String(ok));
    }
    for (const bad of ['not-a-date', '2025-02-30T10:00:00', '2026-13-01', '2026-04-31', { $gt: '' }]) {
        assert.strictEqual(isInvalidPostDate(bad), true, JSON.stringify(bad));
    }
});

test('postgres → mysql (real): TIMESTAMP values cross over (MySQL strict mode refused ISO …Z)', async (t: any) => {
    const pg = await pgScratch(t);
    if (!pg) return;
    const my = await mysqlScratch(t);
    if (!my) { await pgDrop(pg); return; }
    try {
        await pg.driver.exec('CREATE TABLE wjp_b_events (id SERIAL PRIMARY KEY, title TEXT, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
        await pg.driver.run("INSERT INTO wjp_b_events (title, at) VALUES ('fixed', '2026-10-21 10:11:12.345')");
        await pg.driver.run("INSERT INTO wjp_b_events (title) VALUES ('defaulted')");
        const readAll = (sql: string) => pg.driver.all(sql);
        const schema = await pg.driver.getTableSchema('wjp_b_events');
        await migration.copyAllTables({
            tables: ['wjp_b_events'], nonCore: ['wjp_b_events'], generatedColumns: {},
            isAsyncTarget: true, isMysqlTarget: true, targetKind: 'mysql', targetModule: my.driver,
            targetExec: (s: string) => my.driver.exec(s), schemaByTable: { wjp_b_events: schema }, readAll,
            sourceIsSqlite: false, sourceRead: { all: readAll },
        });
        const rows = await my.driver.all('SELECT title, at FROM wjp_b_events ORDER BY id');
        assert.strictEqual(rows.length, 2);
        assert.match(String(rows[0].at), /^2026-10-21 10:11:12/);
    } finally {
        await mysqlDrop(my);
        await pgDrop(pg);
    }
});

test('postgres: a read that lost its connection is retried once; a write never is', async () => {
    const d = new pgDriverModule.PostgresDriver();
    let calls = 0;
    d.pool = { query: async () => { calls++; if (calls === 1) { const e: any = new Error('terminating connection'); e.code = '57P01'; throw e; } return { rows: [{ ok: 1 }] }; } };
    assert.deepStrictEqual(await d.get('SELECT 1 AS ok'), { ok: 1 });
    assert.strictEqual(calls, 2, 'retried once');
    calls = 0;
    d.pool = { query: async () => { calls++; const e: any = new Error('terminating connection'); e.code = '57P01'; throw e; } };
    await assert.rejects(d.all('  WITH x AS (SELECT 1) SELECT * FROM x'), /terminating/);
    assert.strictEqual(calls, 2, 'a second loss is reported, not retried again');
    calls = 0;
    await assert.rejects(d.run('INSERT INTO t (a) VALUES (1)'), /terminating/);
    assert.strictEqual(calls, 1, 'a write is not repeated');
});

test('mysql (real): the engine switch\'s pre-restart connection check completes (it used to wait forever on a 1-connection pool)', async (t: any) => {
    if (!REAL) return t.skip('WORDJS_CI_DB!=1 — no real MySQL');
    const s = mysqlSettings();
    const planned = migration.withTargetDatabase({ dbDriver: 'sqlite-native', dbPassword: 'f'.repeat(32) }, { targetDriver: 'mysql', dbPath: null, conn: { host: s.host, port: s.port, user: s.user, name: s.name, password: s.password } });
    try { await withTimeout(migration.verifyBootConnection('mysql', planned), 20000); }
    catch (e: any) {
        if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(e.message)) return t.skip(`no reachable MySQL: ${e.message}`);
        throw e;
    }
});


test('postgres → mysql (real): a whole site switches — core tables keep their keys, BIGINT stays BIGINT, the next write works', async (t: any) => {
    const pg = await pgScratch(t);
    if (!pg) return;
    const my = await mysqlScratch(t);
    if (!my) { await pgDrop(pg); return; }
    try {
        const dbm = require('../config/database');
        const { runSchemaMigrations } = require('../core/schema-migrations');
        await dbm.initializeSchema(pg.driver, true);
        await runSchemaMigrations(pg.driver, true, 'postgres');
        await pg.driver.exec('CREATE TABLE IF NOT EXISTS wjp_b_locks (name TEXT PRIMARY KEY, locked_until BIGINT)');
        await pg.driver.run("INSERT INTO wjp_b_locks (name, locked_until) VALUES ('x', 1792594000000)");
        await pg.driver.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, guid) VALUES (1, 'Árbol', '<p>x</p>', '', 'publish', 'arbol', 'post', '')");

        const readAll = (sql: string) => pg.driver.all(sql);
        const tables = await migration.listSourceTables(readAll, 'postgres');
        const nonCore = tables.filter((x: string) => !migration.CORE_TABLES.has(x));
        const schemaByTable: Record<string, any> = {};
        for (const x of nonCore) schemaByTable[x] = await pg.driver.getTableSchema(x);
        const generatedColumns = await migration.listGeneratedColumns(readAll, 'postgres');
        assert.ok(generatedColumns.posts && generatedColumns.posts.has('search_vector'));
        await dbm.initializeSchema(my.driver, true);
        await migration.buildTargetSchema(my.driver, true, 'mysql');
        await migration.copyAllTables({
            tables, nonCore, generatedColumns, isAsyncTarget: true, isMysqlTarget: true, targetKind: 'mysql',
            targetModule: my.driver, targetExec: (x: string) => my.driver.exec(x), schemaByTable, readAll,
            sourceIsSqlite: false, sourceRead: { all: readAll },
        });
        await migration.rebuildEngineSpecificSchema(my.driver, true, 'mysql');

        const lock = await my.driver.get("SELECT locked_until FROM wjp_b_locks WHERE name = 'x'");
        assert.strictEqual(String(lock.locked_until), '1792594000000', 'epoch ms survived (BIGINT, not INT)');
        await my.driver.run("INSERT INTO wjp_b_locks (name, locked_until) VALUES ('y', 1792594999999)");
        // A core table created by a migration keeps its auto-increment key: the outbox insert every
        // content write makes works right after the switch.
        const out = await my.driver.run("INSERT INTO content_outbox (event_id, event_type, aggregate_id, payload, status, attempts, available_at) VALUES ('e1', 'content.created', 1, '{}', 'pending', 0, 0)");
        assert.ok(Number(out.lastID) > 0, 'content_outbox.id is generated');
        const p = await my.driver.get("SELECT post_title FROM posts WHERE post_name = 'arbol'");
        assert.strictEqual(p.post_title, 'Árbol');
    } finally {
        await mysqlDrop(my);
        await pgDrop(pg);
    }
});
