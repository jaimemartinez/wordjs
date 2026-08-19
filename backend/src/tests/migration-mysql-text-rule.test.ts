/**
 * Audit #13 (wave 2) — the engine-switch migration consumes THE shared TEXT rule.
 *
 * core/db-admin/migration.js used to carry its own `TEXT → LONGTEXT` rewrite, guarded by the negative
 * lookahead `\bTEXT\b(?!\s+(?:PRIMARY|UNIQUE))`. That copy was strictly WEAKER than the rule the MySQL
 * driver applies, because the lookahead can only see a key word that IMMEDIATELY follows the type:
 *
 *   · `uuid TEXT NOT NULL UNIQUE`  (core `notifications`)      → rewritten to LONGTEXT
 *   · `slug TEXT, … UNIQUE (slug)` (a table-level key clause)  → rewritten to LONGTEXT
 *
 * MySQL then refuses the whole CREATE with errno 1170 ("BLOB/TEXT column used in key specification
 * without a key length"), so recreating that plugin/core table on a MySQL target aborts the migration.
 * Two implementations of one rule is the shape that produced a third of this audit's findings, so the
 * duplicate is gone and migration.js now calls drivers/mysql-text-rule.rewriteTextForMysql().
 *
 * These tests drive the REAL producer — the exported `recreateTableOnTarget`, with the raw CREATE it
 * actually receives from sqlite_master — and read the DDL it hands to the target. No hand-built DDL.
 */

const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app'); // preload config (host context), as the other migration tests do
const migration = require('../core/db-admin/migration');
const { rewriteTextForMysql } = require('../drivers/mysql-text-rule');

/** Run the real recreate path against a fake target and return the CREATE it emitted. */
async function ddlFor(table: string, rawCreate: string, targetKind = 'mysql'): Promise<string> {
    const execed: string[] = [];
    await migration.recreateTableOnTarget(table, {
        schemaByTable: { [table]: { sql: rawCreate, columns: [] } },
        sourceIsSqlite: true,
        targetKind,
        readAll: async () => [],          // no secondary indexes to replay
        targetExec: async (s: string) => { execed.push(s); },
    });
    return execed[0] || '';
}

test('audit #13: a UNIQUE that does not immediately follow TEXT no longer produces an illegal LONGTEXT key', async () => {
    // The core `notifications` shape. The old lookahead saw `NOT` after TEXT and capped nothing.
    const ddl = await ddlFor('notifications', `CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        payload TEXT
    )`);
    assert.match(ddl, /uuid\s+VARCHAR\(255\)/i, 'a key column must be bounded or MySQL fails with errno 1170');
    assert.doesNotMatch(ddl, /uuid\s+LONGTEXT/i, 'this is the exact statement the weaker copy killed');
    assert.match(ddl, /payload\s+LONGTEXT/i, 'a non-key column is still uncapped — content is never truncated');
});

test('audit #13: a column named by a TABLE-LEVEL key clause is bounded too (the copy could not see it at all)', async () => {
    const ddl = await ddlFor('wjp_shop_options', `CREATE TABLE wjp_shop_options (
        option_id INTEGER PRIMARY KEY AUTOINCREMENT,
        option_name TEXT NOT NULL DEFAULT '',
        option_value TEXT NOT NULL DEFAULT '',
        UNIQUE (option_name)
    )`);
    assert.match(ddl, /option_name\s+VARCHAR\(255\)/i, 'named by a table-level UNIQUE ⇒ indexable');
    assert.match(ddl, /option_value\s+LONGTEXT/i, 'not a key ⇒ uncapped');
});

test('audit #13: the migration emits a FIXED POINT of the shared rule (the driver re-applies it downstream)', async () => {
    // targetExec goes through the MySQL driver, which runs the same rule at its exec boundary. If the
    // two ever disagreed again, one of them would rewrite the other's output — so the emitted statement
    // must be unchanged by a second pass.
    const ddl = await ddlFor('wjp_notes', `CREATE TABLE wjp_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL UNIQUE,
        body TEXT
    )`);
    assert.strictEqual(rewriteTextForMysql(ddl), ddl, 'the rule must be idempotent over its own output');
    assert.match(ddl, /id\s+VARCHAR\(255\)\s+PRIMARY\s+KEY/i);
    assert.match(ddl, /body\s+LONGTEXT/i);
});

test('audit #13: the column-list FALLBACK path uses the same rule (no third copy of the decision)', async () => {
    // Reached only when the source exposes no raw CREATE (a Postgres/MySQL source). These columns carry
    // no key information at all, so every TEXT must come out uncapped.
    const execed: string[] = [];
    await migration.recreateTableOnTarget('wjp_notes', {
        schemaByTable: { wjp_notes: { sql: null, columns: ['id INTEGER', 'body TEXT NOT NULL', 'title TEXT'] } },
        sourceIsSqlite: false,
        targetKind: 'mysql',
        readAll: async () => [],
        targetExec: async (s: string) => { execed.push(s); },
    });
    const ddl = execed[0] || '';
    assert.match(ddl, /body\s+LONGTEXT\s+NOT\s+NULL/i);
    assert.match(ddl, /title\s+LONGTEXT/i);
    assert.doesNotMatch(ddl, /\bTEXT\b/, 'no bare TEXT left for MySQL to cap at VARCHAR(255)');
});

test('audit #13: the wordjs_analytics CREATE — comments with commas — migrates to valid MySQL DDL', async () => {
    // THE STATEMENT THAT ACTUALLY BREAKS. wordjs_analytics is created on EVERY install
    // (config/database.ts → models/Analytics.ts) and is not a CORE_TABLE, so an engine switch to
    // MySQL routes it through recreateTableOnTarget with the RAW sqlite_master CREATE — comments and
    // all. `splitTopLevel` does not know a comma is inside `-- 'page_view', 'api_call', …`, so the
    // shared rule split the comment into pieces and re-joined them on separate lines; `'api_call',`
    // then read as a column definition. The targetExec at migration.js:508 is not wrapped and the
    // error is not benign, so the whole engine switch aborted — on every install.
    const ddl = await ddlFor('wordjs_analytics', `CREATE TABLE IF NOT EXISTS wordjs_analytics (
                id VARCHAR(36) PRIMARY KEY,
                type VARCHAR(50) NOT NULL, -- 'page_view', 'api_call', 'engagement'
                resource VARCHAR(255), -- '/hello-world' or 'post_123'
                visitor_ip VARCHAR(64), -- Anonymized hash likely
                user_id VARCHAR(36), -- NULL if guest
                metadata TEXT, -- JSON extra data
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

    assert.doesNotMatch(ddl, /--/, 'comments are stripped before the split, not left to break it');
    assert.doesNotMatch(ddl, /'api_call'|'engagement'/, 'a comment must never survive as a column definition');
    assert.match(ddl, /metadata\s+LONGTEXT/i, 'the only TEXT column, and nothing indexes it');
    // Every emitted part is a real column or constraint — the property ERROR 1064 was reporting.
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
    for (const part of body.split('\n').map((l: string) => l.trim().replace(/,$/, '')).filter(Boolean)) {
        assert.match(part, /^["`]?\w+["`]?\s+\w|^(?:PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|CHECK|FOREIGN)\b/i,
            `not a column definition: ${part}`);
    }
    assert.strictEqual(rewriteTextForMysql(ddl), ddl, 'and it is still a fixed point of the rule');
});

test('audit #13: a quoted CHECK constraint name does not cap the column it constrains', async () => {
    const ddl = await ddlFor('wjp_notes', `CREATE TABLE wjp_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        CONSTRAINT "chk one" CHECK (body <> '')
    )`);
    assert.match(ddl, /body\s+LONGTEXT/i, 'a CHECK creates no index, so it bounds nothing');
    assert.doesNotMatch(ddl, /body\s+VARCHAR/i);
});

test('audit #13: a column literally named key or text is translated like any other', async () => {
    const ddl = await ddlFor('wjp_kv', `CREATE TABLE wjp_kv (
        key TEXT NOT NULL,
        text TEXT,
        value TEXT,
        UNIQUE (key)
    )`);
    assert.match(ddl, /key["\s]+VARCHAR\(255\)/i, 'named by the UNIQUE ⇒ bounded');
    assert.match(ddl, /\btext\s+LONGTEXT/i, 'the TYPE is replaced by position, never the identically-named column');
    assert.doesNotMatch(ddl, /LONGTEXT\s+TEXT/i);
    assert.match(ddl, /value\s+LONGTEXT/i);
});

test('audit #13: a non-MySQL target is untouched by the rule', async () => {
    const ddl = await ddlFor('wjp_notes', 'CREATE TABLE wjp_notes (id INTEGER PRIMARY KEY, body TEXT)', 'sqlite');
    assert.match(ddl, /body\s+TEXT/i, 'SQLite keeps its own dialect');
    assert.doesNotMatch(ddl, /LONGTEXT|VARCHAR/i);
});
