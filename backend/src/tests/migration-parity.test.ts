/**
 * Cross-driver migration parity + safety.
 *
 * Guards the DB-engine-switch migration (core/db-admin/migration.js) against silent data-loss:
 *   1. It copied only a HARDCODED 11-table list → every plugin wjp_*, wordjs_analytics,
 *      schema_migrations and notifications table was silently dropped on an engine switch.
 *   2. Its "transaction" ran BEGIN/INSERT/COMMIT on different pooled connections → no atomicity,
 *      and it used TRUNCATE (implicit-commits on MySQL) instead of DELETE.
 *   3. Verification was count-only + WARNING-only → a half-copied target became the live DB while the
 *      UI reported "Migration successful".
 * Plus the adversarial-review hardening: identifiers are quoted (reserved-word plugin cols), a
 * row-count mismatch FAILS CLOSED, plugin TEXT is recreated as MySQL LONGTEXT (no VARCHAR(255) cap),
 * odd-but-safe table names are NOT dropped, and a same-engine re-migration snapshots the source first.
 *
 * Unit tests run everywhere; the integration test round-trips a real SQLite → Postgres/MySQL only
 * where a real engine is reachable (WORDJS_CI_DB=1 in CI).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

require('../config/app'); // preload config (host context)
const migration = require('../core/db-admin/migration');

// ── In-memory fake of a single-connection "tx" (the shape copyTablesInto expects). Handles QUOTED
//    identifiers (copyTablesInto now quotes everything). Tables are string→row[] maps. ──────────────
function makeFakeTx(seedTables: Record<string, any[]> = {}) {
    const store: Record<string, any[]> = {};
    for (const [t, rows] of Object.entries(seedTables)) store[t] = [...rows];
    const execLog: string[] = [];
    const runLog: string[] = [];
    const unquote = (s: string) => s.trim().replace(/^["'`]|["'`]$/g, '');
    return {
        store, execLog, runLog,
        exec: async (sql: string) => {
            execLog.push(sql);
            const del = sql.match(/^\s*DELETE\s+FROM\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i);
            if (del) store[del[1]] = [];
            const cre = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i);
            if (cre && !store[cre[1]]) store[cre[1]] = [];
        },
        run: async (sql: string, params: any[] = []) => {
            runLog.push(sql);
            const m = sql.match(/INSERT\s+INTO\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\(([^)]*)\)/i);
            if (!m) throw new Error('unexpected run(): ' + sql);
            const table = m[1];
            const keys = m[2].split(',').map((k) => unquote(k));
            const row: Record<string, any> = {};
            keys.forEach((k, i) => (row[k] = params[i]));
            (store[table] ||= []).push(row);
            return { lastID: store[table].length, changes: 1 };
        },
        get: async (sql: string) => {
            const m = sql.match(/FROM\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i);
            return { c: (store[(m ? m[1] : '')] || []).length };
        },
    };
}

const makeSource = (data: Record<string, any[]>) => ({
    all: (sql: string) => {
        const m = sql.match(/FROM\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i);
        return m ? (data[m[1]] || []) : [];
    },
});

function makeFakeWrapper() {
    const tx = makeFakeTx();
    return {
        _tx: tx,
        exec: (sql: string) => { tx.exec(sql); },
        prepare: (sql: string) => ({
            run: (...params: any[]) => tx.run(sql, params),
            get: () => tx.get(sql),
            all: () => [],
        }),
    };
}

// Common ctx for the file-target (sqlite) copy path.
const sqliteCtx = (over: any) => ({
    isAsyncTarget: false,
    isMysqlTarget: false,
    targetKind: 'sqlite',
    schemaByTable: {},
    readAll: async () => [],
    sourceIsSqlite: true,
    onProgress: () => {},
    ...over,
});

test('copyAllTables copies EVERY table it is given (no hardcoded list) and reports the total', async () => {
    const data = {
        users: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
        options: [{ id: 1, k: 'siteUrl', v: 'x' }],
        wjp_store_orders: [{ id: 1, total: 100 }, { id: 2, total: 200 }, { id: 3, total: 300 }],
        wordjs_analytics: [{ id: 1, path: '/' }],
        schema_migrations: [{ id: '0001' }],
    };
    const wrapper = makeFakeWrapper();
    const total = await migration.copyAllTables(sqliteCtx({
        tables: Object.keys(data),
        nonCore: ['wjp_store_orders', 'wordjs_analytics', 'schema_migrations'],
        targetWrapper: wrapper,
        targetExec: (s: string) => wrapper.exec(s),
        // Non-core schema captured up-front (the handler does this before the target connects).
        schemaByTable: {
            wjp_store_orders: { sql: 'CREATE TABLE wjp_store_orders (id INTEGER, total INTEGER)', columns: [] },
            wordjs_analytics: { sql: 'CREATE TABLE wordjs_analytics (id INTEGER, path TEXT)', columns: [] },
            schema_migrations: { sql: 'CREATE TABLE schema_migrations (id TEXT)', columns: [] },
        },
        sourceRead: makeSource(data),
    }));

    assert.strictEqual(total, 8, 'total rows across all 5 tables (2+1+3+1+1)');
    for (const [t, rows] of Object.entries(data)) {
        assert.strictEqual(wrapper._tx.store[t].length, rows.length, `all rows copied for ${t}`);
    }
    assert.strictEqual(wrapper._tx.store['wjp_store_orders'].length, 3, 'plugin table survives');
    assert.ok(wrapper._tx.store['wordjs_analytics'], 'analytics table survives');
    assert.ok(wrapper._tx.store['schema_migrations'], 'schema_migrations survives');
});

test('copyAllTables clears with DELETE, never TRUNCATE (TRUNCATE implicit-commits on MySQL)', async () => {
    const wrapper = makeFakeWrapper();
    await migration.copyAllTables(sqliteCtx({
        tables: ['users'], nonCore: [],
        targetWrapper: wrapper, targetExec: (s: string) => wrapper.exec(s),
        sourceRead: makeSource({ users: [{ id: 1 }] }),
    }));
    const execs = wrapper._tx.execLog.join('\n');
    assert.ok(/DELETE\s+FROM/i.test(execs), 'uses DELETE FROM');
    assert.ok(!/TRUNCATE/i.test(execs), 'never uses TRUNCATE');
});

test('copyAllTables quotes identifiers so reserved-word plugin columns are safe', async () => {
    const wrapper = makeFakeWrapper();
    await migration.copyAllTables(sqliteCtx({
        tables: ['events'], nonCore: [],
        targetWrapper: wrapper, targetExec: (s: string) => wrapper.exec(s),
        sourceRead: makeSource({ events: [{ id: 1, order: 5, group: 'a' }] }),
    }));
    const inserts = wrapper._tx.runLog.join('\n');
    assert.ok(/"order"/.test(inserts) && /"group"/.test(inserts), 'reserved-word columns are double-quoted');
    assert.ok(/INSERT\s+INTO\s+"events"/.test(inserts), 'table identifier is quoted');
    assert.strictEqual(wrapper._tx.store['events'][0].order, 5, 'the row copied intact');
});

test('copyAllTables FAILS CLOSED: a row-count mismatch throws (so the caller cannot switch the live DB)', async () => {
    const lossyWrapper: any = makeFakeWrapper();
    lossyWrapper._tx.run = async () => ({ lastID: 0, changes: 0 }); // swallow every insert
    lossyWrapper.prepare = (sql: string) => ({ run: () => lossyWrapper._tx.run(sql), get: () => lossyWrapper._tx.get(sql), all: () => [] });

    await assert.rejects(
        () => migration.copyAllTables(sqliteCtx({
            tables: ['users'], nonCore: [],
            targetWrapper: lossyWrapper, targetExec: (s: string) => lossyWrapper.exec(s),
            sourceRead: makeSource({ users: [{ id: 1 }, { id: 2 }] }),
        })),
        /Row count mismatch/,
        'a short copy must abort, not silently succeed'
    );
});

test('recreateTableOnTarget maps plugin TEXT → LONGTEXT for MySQL (no silent VARCHAR(255) truncation)', async () => {
    const execed: string[] = [];
    await migration.recreateTableOnTarget('wjp_notes', {
        // real getTableSchema shape: {sql, columns}; Postgres/MySQL source give sql:null + columns[]
        schemaByTable: { wjp_notes: { sql: null, columns: ['id INTEGER', 'body TEXT NOT NULL', 'title TEXT'] } },
        sourceIsSqlite: false,
        targetKind: 'mysql',
        readAll: async () => [],
        targetExec: async (s: string) => { execed.push(s); },
    });
    const sql = execed.join('\n');
    assert.ok(/body\s+LONGTEXT/i.test(sql), 'plugin TEXT column recreated as LONGTEXT on MySQL');
    assert.ok(!/\bTEXT\b/.test(sql), 'no bare TEXT type left to be capped at VARCHAR(255)');
});

test('recreateTableOnTarget uses the captured raw sqlite_master CREATE (full fidelity) for a SQLite source', async () => {
    const execed: string[] = [];
    await migration.recreateTableOnTarget('wjp_legacy', {
        schemaByTable: { wjp_legacy: { sql: 'CREATE TABLE wjp_legacy (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)', columns: [] } },
        sourceIsSqlite: true,
        targetKind: 'sqlite',
        readAll: async () => [],
        targetExec: async (s: string) => { execed.push(s); },
    });
    const sql = execed.join('\n');
    assert.ok(/CREATE TABLE IF NOT EXISTS "wjp_legacy"/i.test(sql), 'recreated idempotently with a quoted name');
    assert.ok(/AUTOINCREMENT/i.test(sql), 'PK/AUTOINCREMENT preserved from the raw CREATE');
});

test('recreateTableOnTarget maps DATETIME → TIMESTAMP for a Postgres target (whose exec does not translate)', async () => {
    const execed: string[] = [];
    await migration.recreateTableOnTarget('wjp_evt', {
        schemaByTable: { wjp_evt: { sql: null, columns: ['id INTEGER', 'created DATETIME', 'note TEXT'] } },
        sourceIsSqlite: false,
        targetKind: 'postgres',
        readAll: async () => [],
        targetExec: async (s: string) => { execed.push(s); },
    });
    const sql = execed.join('\n');
    assert.ok(/created\s+TIMESTAMP/i.test(sql), 'DATETIME mapped to TIMESTAMP for Postgres');
    assert.ok(!/DATETIME/i.test(sql), 'no invalid DATETIME left for the untranslating Postgres exec');
});

test('recreateTableOnTarget preserves a hyphenated table name (no CREATE-prefix corruption)', async () => {
    const execed: string[] = [];
    await migration.recreateTableOnTarget('wjp-orders', {
        schemaByTable: { 'wjp-orders': { sql: 'CREATE TABLE "wjp-orders" (id INTEGER, total INTEGER)', columns: [] } },
        sourceIsSqlite: true, targetKind: 'sqlite', readAll: async () => [], targetExec: async (s: string) => { execed.push(s); },
    });
    const sql = execed.join('\n');
    assert.ok(/CREATE TABLE IF NOT EXISTS "wjp-orders" \(/i.test(sql), 'hyphenated name recreated intact');
    assert.ok(!/-orders"-orders/.test(sql), 'the name token is not spliced/corrupted');
});

test('a whitespace table name FAILS CLOSED (quoteIdent rejects it) rather than silently emptying', async () => {
    await assert.rejects(
        () => migration.recreateTableOnTarget('my table', {
            schemaByTable: { 'my table': { sql: 'CREATE TABLE "my table" (id INTEGER)', columns: [] } },
            sourceIsSqlite: true, targetKind: 'sqlite', readAll: async () => [], targetExec: async () => {},
        }),
        /Unsafe SQL identifier/,
        'a space-containing table name must abort the migration, not vanish'
    );
});

test('listSourceTables enumerates dynamically and NO LONGER silently drops odd-but-safe names', async () => {
    const readAll = async () => [{ name: 'users' }, { name: 'wjp_orders' }, { name: 'order-items' }, { name: '' }];
    const tables = await migration.listSourceTables(readAll, 'sqlite-native');
    assert.ok(tables.includes('users') && tables.includes('wjp_orders'), 'core + plugin tables enumerated');
    assert.ok(tables.includes('order-items'), 'a hyphenated table name is INCLUDED (quoted at use), not dropped');
    assert.ok(!tables.includes(''), 'empty names are excluded');
});

// ── Integration: real cross-engine round-trip (only where a real engine is reachable) ────────────
const withTimeout = (p: Promise<any>, ms: number) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

async function seedSqliteSource(dbFile: string) {
    let Database: any;
    try { Database = require('better-sqlite3'); } catch { return null; }
    const db = new Database(dbFile);
    db.exec(`
        CREATE TABLE options (id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT, option_value TEXT);
        CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, body TEXT);
        CREATE TABLE wjp_store_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, total INTEGER, note TEXT);
        CREATE TABLE wordjs_analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT);
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    `);
    db.prepare('INSERT INTO options (option_name, option_value) VALUES (?, ?)').run('siteUrl', 'http://x');
    db.prepare('INSERT INTO notifications (user_id, body) VALUES (?, ?)').run(1, 'hi 日本語 🎉'); // unicode must survive
    const longNote = 'x'.repeat(2000); // > VARCHAR(255): proves plugin TEXT isn't truncated on MySQL
    db.prepare('INSERT INTO wjp_store_orders (total, note) VALUES (?, ?)').run(100, longNote);
    db.prepare('INSERT INTO wjp_store_orders (total, note) VALUES (?, ?)').run(200, 'ok');
    db.prepare('INSERT INTO wordjs_analytics (path) VALUES (?)').run('/home');
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('0001_init');
    return { db, longNote };
}

for (const target of ['postgres', 'mysql']) {
    test(`migration parity: SQLite → ${target} preserves plugin + analytics + schema_migrations data`, async (t: any) => {
        if (process.env.WORDJS_CI_DB !== '1') return t.skip('WORDJS_CI_DB!=1 — no real engine to migrate into');

        let driver: any;
        try { driver = require(`../drivers/${target}`); } catch (e: any) { return t.skip(`${target} driver not loadable: ${e && e.message}`); }
        const cfg = target === 'mysql'
            ? { host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT) || 3306, user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD ?? 'password', name: process.env.MYSQL_DB || 'wordjs' }
            : {};
        try {
            if (target === 'mysql') driver.config = cfg;
            await withTimeout(driver.connect(), 5000);
        } catch (e: any) { return t.skip(`no reachable ${target}: ${e && e.message}`); }

        const tmp = path.join(os.tmpdir(), `wjs-mig-${process.pid}-${Date.now()}.db`);
        const seeded = await seedSqliteSource(tmp);
        if (!seeded) return t.skip('better-sqlite3 unavailable — cannot build a SQLite source');
        const tables = ['options', 'notifications', 'wjp_store_orders', 'wordjs_analytics', 'schema_migrations'];

        try {
            const sourceRead = { all: (sql: string) => seeded.db.prepare(sql).all() };
            // Capture the raw CREATE for each table up-front (the handler does this before the target connects).
            const schemaByTable: Record<string, any> = {};
            for (const tbl of tables) {
                const r = seeded.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
                schemaByTable[tbl] = { sql: r && r.sql, columns: [] };
            }

            await migration.copyAllTables({
                tables, nonCore: tables.slice(),
                isAsyncTarget: true,
                isMysqlTarget: target === 'mysql',
                targetKind: target,
                targetModule: driver,
                targetExec: (s: string) => driver.exec(s),
                schemaByTable,
                readAll: (sql: string) => Promise.resolve(sourceRead.all(sql)),
                sourceIsSqlite: true,
                sourceRead,
                onProgress: () => {},
            });

            for (const tbl of tables) {
                const srcN = seeded.db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get().c;
                const tgt = await driver.all(`SELECT COUNT(*) as c FROM "${tbl}"`);
                assert.strictEqual(Number(tgt[0].c), srcN, `row count preserved for ${tbl} on ${target}`);
            }
            const back = await driver.all('SELECT note FROM "wjp_store_orders" WHERE total = 100');
            assert.strictEqual(back[0].note.length, 2000, `plugin TEXT not truncated on ${target}`);
            const uni = await driver.all('SELECT body FROM "notifications" WHERE user_id = 1');
            assert.ok(uni[0].body.includes('日本語') && uni[0].body.includes('🎉'), `unicode preserved on ${target}`);
        } finally {
            try { for (const tbl of tables) await driver.exec(`DROP TABLE IF EXISTS "${tbl}"`); } catch { /* */ }
            try { await driver.close(); } catch { /* */ }
            try { seeded.db.close(); } catch { /* */ }
            for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
        }
    });
}
