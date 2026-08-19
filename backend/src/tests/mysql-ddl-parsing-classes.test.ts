/**
 * WordJS — the MySQL DDL translation, tested as CLASSES rather than as the examples that were found.
 *
 * Three rounds of review found three different symptoms of ONE defect (a comment's comma; a CHECK
 * expression; a literal's comma and parenthesis) and each round fixed the symptom. These tests are
 * built the other way round: each one enumerates the MEMBERS of a class and iterates them, so a
 * member that nobody has thought of yet either passes or fails LOUDLY — it is never simply absent.
 *
 * CLASS 1 — QUOTING BLINDNESS. Structure decided by string operations cannot see quoting, so every
 *   structural character and every keyword that can appear INSIDE a string literal or a quoted
 *   identifier is a member: `,` `(` `)` `--` and PRIMARY KEY / UNIQUE / KEY / AUTOINCREMENT /
 *   DEFAULT / CURRENT_TIMESTAMP. The table below carries one DDL per member.
 * CLASS 2 — NAME READ AS KEYWORD. Any rewrite driven by `/\bWORD\b/` over a whole column definition
 *   can match the column's NAME. The members are the words the driver rewrites or dispatches on:
 *   TEXT, SERIAL, INTEGER, KEY, INDEX, UNIQUE, CHECK, PRIMARY, DEFAULT, TIMESTAMP…
 * CLASS 3 — RESERVED IDENTIFIERS. The set of column names MySQL refuses bare is MySQL's, not this
 *   parser's. The test iterates the driver's WHOLE set at all three surfaces a column name reaches
 *   the server through, and separately demands the practical suspects be members of it.
 *
 * The DDL is produced by the REAL producer wherever the producer accepts it (core/safe-sql's
 * buildCreateTable — what config/database.createPluginTable and the import bundle path call), so
 * these are statements a plugin can actually cause, not strings shaped for the assertion.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// Stub mysql2's pool factory BEFORE the driver is required (same seam as mysql-driver-dialect.test).
const mysql2promise = require('mysql2/promise');
const realCreatePool = mysql2promise.createPool;
mysql2promise.createPool = (options: any): any => {
    const pool: any = new EventEmitter();
    pool.options = options;
    pool.query = async () => [[], []];
    pool.end = async () => { /* fake */ };
    return pool;
};
const driver = require('../drivers/mysql');
mysql2promise.createPool = realCreatePool;

const { buildCreateTable } = require('../core/safe-sql');

/** Install a fake pool and return every statement the driver sends to it. */
function seenStatements(): string[] {
    const seen: string[] = [];
    driver.pool = {
        query: async (sql: string) => { seen.push(String(sql)); return [[], []]; },
        end: async () => { /* fake */ }
    };
    return seen;
}

/** Emit `CREATE TABLE` through the real producer and the real driver; return the DDL MySQL receives. */
async function emit(table: string, columns: string[]): Promise<string> {
    const seen = seenStatements();
    await driver.exec(buildCreateTable(table, columns));
    return seen[0];
}

/**
 * The OTHER real entry: a CREATE TABLE exactly as `sqlite_master` stored it, which is what
 * core/db-admin/migration.js hands to the rule when the operator switches engines. Used for the
 * members core/safe-sql refuses at the producer (it rejects `--` and `/*` outright) — those cannot
 * come from a plugin's createTable, but they can absolutely come out of an existing database.
 */
async function emitRaw(table: string, columns: string[]): Promise<string> {
    const seen = seenStatements();
    await driver.exec(`CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(',\n  ')}\n)`);
    return seen[0];
}

/** The column definition line for `name` in an emitted CREATE TABLE. */
function lineOf(ddl: string, name: string): string {
    const body = driver.createTableBody(ddl) as string;
    const re = new RegExp(`^\\s*["\`]?${name}["\`]?\\s`, 'i');
    return (body.split('\n').find((l: string) => re.test(l)) || '').trim().replace(/,$/, '');
}

// ── CLASS 1: every structural character and keyword, inside a string literal ─────────────────────
// One row per member. `payload` is the literal the DDL carries; the assertions are the same for all
// of them, because the property is the same for all of them: the literal survives BYTE FOR BYTE, and
// the columns around it are still translated by the rule (LONGTEXT unless they take part in a key).
const LITERAL_MEMBERS: Array<{ member: string; payload: string; viaProducer?: boolean }> = [
    { member: 'a top-level comma', payload: 'hello, world' },
    { member: 'an opening parenthesis', payload: '(' },
    { member: 'a closing parenthesis', payload: ')' },
    { member: 'both parentheses, unbalanced', payload: '((x)' },
    // safe-sql refuses a comment marker in a column definition, so these two can only arrive from an
    // EXISTING database through the engine-migration path — which is a real path, so they are tested
    // on it rather than dropped from the class.
    { member: 'a line-comment marker', payload: 'see -- here', viaProducer: false },
    { member: 'a block-comment opener', payload: 'a /* b', viaProducer: false },
    { member: 'the word PRIMARY KEY', payload: 'PRIMARY KEY' },
    { member: 'the word UNIQUE', payload: 'unique' },
    { member: 'the word KEY with a list', payload: 'KEY (x)' },
    { member: 'the word AUTOINCREMENT', payload: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
    { member: 'the word DEFAULT', payload: 'DEFAULT CURRENT_TIMESTAMP' },
    { member: 'a doubled quote', payload: "it''s" },
    { member: 'a comma AND a type token', payload: 'a, b text' },
    { member: 'a semicolon-free DROP', payload: 'DROP TABLE posts' }
];

for (const { member, payload, viaProducer } of LITERAL_MEMBERS) {
    test(`class 1 (quoting blindness): a DEFAULT containing ${member} is TEXT, never structure`, async () => {
        // Through the producer where the producer accepts it: safeColumnDefinition deliberately skips
        // quoted text when it counts parentheses, so an unbalanced one inside a literal is legal input.
        const enter = viaProducer === false ? emitRaw : emit;
        const ddl = await enter('wjp_class1_notes', [
            'id INTEGER PRIMARY KEY AUTOINCREMENT',
            `body TEXT NOT NULL DEFAULT '${payload}'`,
            'author TEXT',
            'slug TEXT'
        ]);

        // (a) The literal reaches MySQL unchanged — a split-and-rejoin used to REWRITE the value
        //     stored as the column's default, which is silent schema corruption.
        assert.ok(ddl.includes(`'${payload}'`),
            `the default literal must survive verbatim; got:\n${ddl}`);
        // (b) The column list still has exactly the four columns the producer declared: no part was
        //     invented by a split, and none was swallowed by one.
        const parts = (driver.createTableBody(ddl) as string).split('\n').map((l: string) => l.trim()).filter(Boolean);
        assert.strictEqual(parts.length, 4, `expected 4 column definitions, got ${parts.length}:\n${ddl}`);
        // (c) The columns AFTER the literal are still widened. `DEFAULT '('` left the splitter at
        //     depth 1 for ever, so everything after it stayed capped — silently.
        for (const col of ['author', 'slug']) {
            assert.match(lineOf(ddl, col), /LONGTEXT/i,
                `${col} must still be widened by the rule; got:\n${ddl}`);
        }
        // (d) …and the column that CARRIES the literal is widened too, unless the literal's text was
        //     read as a key declaration.
        assert.match(lineOf(ddl, 'body'), /LONGTEXT/i, `body must not be capped by text inside its own default:\n${ddl}`);
    });
}

test('class 1: a quoted IDENTIFIER carrying a comma is one column, not two', () => {
    // Not reachable through safe-sql (its identifiers are plain), but core/db-admin/migration.js
    // feeds this module whatever sqlite_master stored, and SQLite accepts `"weird, name"`.
    const { splitTopLevel } = require('../drivers/mysql-text-rule');
    assert.deepStrictEqual(
        splitTopLevel('"weird, name" TEXT, body TEXT').map((p: string) => p.trim()),
        ['"weird, name" TEXT', 'body TEXT']);
});

// ── CLASS 2: a column NAME that is also a keyword the driver rewrites or dispatches on ───────────
// The member list is derived from what the driver DOES: the type tokens it swaps (TEXT, SERIAL,
// INTEGER…), the clause heads it recognises (KEY, INDEX, UNIQUE, CHECK, PRIMARY, FOREIGN,
// CONSTRAINT) and the words it rewrites in a definition (DEFAULT, CURRENT_TIMESTAMP, AUTOINCREMENT).
const KEYWORD_NAMES = [
    'text', 'longtext', 'serial', 'bigserial', 'integer', 'int', 'blob', 'timestamp', 'varchar',
    'key', 'index', 'unique', 'check', 'primary', 'foreign', 'constraint',
    'default', 'current_timestamp', 'autoincrement', 'value', 'type', 'order', 'rank'
];

for (const name of KEYWORD_NAMES) {
    test(`class 2 (name read as keyword): a column named \`${name}\` keeps its name and gets its type`, async () => {
        const ddl = await emit(`wjp_class2_${name}`, ['id INTEGER PRIMARY KEY AUTOINCREMENT', `${name} TEXT NOT NULL`, 'note TEXT']);
        const line = lineOf(ddl, name);

        assert.ok(line, `the column \`${name}\` disappeared from the emitted DDL:\n${ddl}`);
        // The NAME is still the first token (bare or quoted) — `serial TEXT NOT NULL` used to reach
        // MySQL as `INTEGER AUTO_INCREMENT LONGTEXT NOT NULL`, i.e. with no name at all.
        assert.match(line, new RegExp(`^(?:"${name}"|${name})\\s`, 'i'),
            `the column name must survive as the first token; got: ${line}`);
        // The TYPE is translated exactly once: LONGTEXT, and nothing else in front of it.
        assert.match(line, /^\S+\s+LONGTEXT\b/i, `expected <name> LONGTEXT …; got: ${line}`);
        assert.doesNotMatch(line, /AUTO_INCREMENT/i, `no auto-increment may be conjured out of a NAME; got: ${line}`);
        // …and the neighbours are untouched.
        assert.match(lineOf(ddl, 'note'), /note\s+LONGTEXT/i, ddl);
    });
}

test('class 2: the autoincrement rewrites fire on the TYPE token, and only there', async () => {
    // Both dialect spellings the core schema emits (SQLite's and Postgres's), plus the case that
    // used to break: the same words as a NAME and as a DEFAULT's text.
    const sqlite = await emit('wjp_class2_ai_a', ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'body TEXT']);
    assert.match(lineOf(sqlite, 'id'), /^id\s+INTEGER AUTO_INCREMENT PRIMARY KEY$/i, sqlite);

    const pg = await emit('wjp_class2_ai_b', ['id SERIAL PRIMARY KEY', 'body TEXT']);
    assert.match(lineOf(pg, 'id'), /^id\s+INTEGER AUTO_INCREMENT PRIMARY KEY$/i, pg);

    const bare = await emit('wjp_class2_ai_c', ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'ticket SERIAL', 'body TEXT']);
    assert.match(lineOf(bare, 'ticket'), /^ticket\s+INTEGER AUTO_INCREMENT$/i, bare);

    const inLiteral = await emit('wjp_class2_ai_d', ['id INTEGER PRIMARY KEY AUTOINCREMENT', "body TEXT DEFAULT 'id INTEGER PRIMARY KEY AUTOINCREMENT'"]);
    assert.ok(inLiteral.includes("'id INTEGER PRIMARY KEY AUTOINCREMENT'"),
        `a default's TEXT must not be rewritten as a clause:\n${inLiteral}`);
});

// ── CLASS 3: identifiers MySQL reserves ─────────────────────────────────────────────────────────
// The list is not a sample: the test iterates the driver's WHOLE set, at the three surfaces a column
// name reaches MySQL through. Whatever is added to the set is covered on the same commit.
const RESERVED: string[] = [...driver.RESERVED_BARE_COLUMN_NAMES];

test('class 3: EVERY reserved column name is quoted in the definition, in a key clause and in CREATE INDEX', async () => {
    assert.ok(RESERVED.length > 100, `the reserved set has only ${RESERVED.length} entries — that is a hand-picked list again, not MySQL's`);
    const unquotedDefinition: string[] = [];
    const unquotedKeyClause: string[] = [];
    const unquotedIndex: string[] = [];

    for (const name of RESERVED) {
        // safe-sql refuses nothing here: every reserved word is a PLAIN_IDENT, which is exactly why
        // a plugin can create such a column and why MySQL then refuses the whole CREATE.
        const ddl = await emit(`wjp_class3_${name.replace(/[^a-z0-9_]/g, '_')}`, [
            'id INTEGER PRIMARY KEY AUTOINCREMENT', `${name} TEXT NOT NULL`, 'body TEXT', `UNIQUE (${name})`
        ]);
        const line = lineOf(ddl, name);
        if (!new RegExp(`^"${name}"\\s`, 'i').test(line)) unquotedDefinition.push(name);
        if (!new RegExp(`UNIQUE\\s*\\(\\s*"${name}"\\s*\\)`, 'i').test(ddl)) unquotedKeyClause.push(name);

        const index = driver.translateSql(`CREATE INDEX IF NOT EXISTS idx_x ON wjp_class3_x (${name})`);
        if (!new RegExp(`\\(\\s*"${name}"\\s*\\)`, 'i').test(index)) unquotedIndex.push(name);
    }

    assert.deepStrictEqual(unquotedDefinition, [], 'reserved names left BARE in the column definition — the CREATE fails with ERROR 1064');
    assert.deepStrictEqual(unquotedKeyClause, [], 'reserved names left BARE in a table-level key clause — quoting only the definition leaves the CREATE just as invalid');
    assert.deepStrictEqual(unquotedIndex, [], 'reserved names left BARE in CREATE INDEX — the third surface, and the table cannot be indexed without it');
});

test('class 3: the set is MySQL\'s, not the internal parser\'s — the practical suspects are members', () => {
    // Named in round 2 as the words a CMS plugin actually uses. `order` was the live defect.
    const suspects = ['order', 'rank', 'range', 'read', 'groups', 'system', 'interval', 'condition',
        'lines', 'long', 'match', 'option', 'usage', 'partition', 'signal', 'leave', 'exit', 'desc',
        'asc', 'to', 'from', 'where', 'values', 'rows', 'call', 'key', 'index', 'unique', 'check'];
    const missing = suspects.filter((w) => !driver.RESERVED_BARE_COLUMN_NAMES.has(w));
    assert.deepStrictEqual(missing, [], 'a reserved word MySQL refuses is not in the set');

    // …and NON-reserved keywords stay bare: quoting everything would rewrite the DDL of every
    // existing install for nothing. These are legal bare identifiers in MySQL 8.
    const nonReserved = ['text', 'value', 'type', 'status', 'comment', 'data', 'name', 'date', 'year'];
    const overQuoted = nonReserved.filter((w) => driver.RESERVED_BARE_COLUMN_NAMES.has(w));
    assert.deepStrictEqual(overQuoted, [], 'a NON-reserved keyword is being quoted — the set is drifting away from MySQL again');
});

// ── CLASS 4: WHICH CONNECTION a statement is sent on ────────────────────────────────────────────
// A statement issued on a DIFFERENT session than the transaction that holds a table's metadata lock
// waits for a lock only the transaction can release, and the transaction waits for the statement.
// MySQL's deadlock detector does not cover metadata locks and lock_wait_timeout defaults to a YEAR,
// so the symptom is an indefinite hang. Every DDL the driver issues on its own initiative is a
// member of this class; today that is the CREATE INDEX widening.
test('class 4 (which connection): a widening ALTER inside a transaction runs on the PINNED connection', async () => {
    const onPool: string[] = [];
    const onConn: string[] = [];
    const conn: any = {
        query: async (sql: string) => { onConn.push(String(sql)); return [[], []]; },
        beginTransaction: async () => { onConn.push('BEGIN'); },
        commit: async () => { onConn.push('COMMIT'); },
        rollback: async () => { onConn.push('ROLLBACK'); },
        release: () => { /* fake */ }
    };
    driver.pool = {
        query: async (sql: string) => {
            onPool.push(String(sql));
            if (/information_schema\.columns/i.test(sql)) return [[{ c: 'slug', t: 'longtext' }], []];
            if (/CHAR_LENGTH/i.test(sql)) return [[], []];                       // nothing too long ⇒ narrowable
            if (/SHOW CREATE TABLE/i.test(sql)) {
                return [[{ 'Create Table': 'CREATE TABLE "terms" (\n  "slug" longtext NOT NULL\n)' }], []];
            }
            return [[], []];
        },
        getConnection: async () => conn,
        end: async () => { /* fake */ }
    };

    await driver.transaction(async (tx: any) => {
        await tx.exec('CREATE INDEX IF NOT EXISTS idx_terms_slug ON terms (slug)');
    });

    assert.ok(!onPool.some((s) => /^\s*ALTER TABLE/i.test(s)),
        `the ALTER must not go to another session while this transaction holds the table's metadata lock; pool saw:\n${onPool.join('\n')}`);
    assert.ok(onConn.some((s) => /^\s*ALTER TABLE/i.test(s)),
        `the ALTER must travel on the pinned connection; it saw:\n${onConn.join('\n')}`);
    assert.ok(onConn.some((s) => /^\s*CREATE INDEX/i.test(s)), 'and the index itself is still created inside the transaction');
    // The introspection is allowed on the pool: a non-locking SELECT and SHOW CREATE TABLE take a
    // SHARED metadata lock, which is compatible with the one the transaction holds.
    assert.ok(onPool.some((s) => /information_schema\.columns/i.test(s)), 'introspection may stay on the pool');
});

test('class 4: every session this driver opens pins the clock and bounds the metadata-lock wait', () => {
    // The cutoff analytics/retention computes is UTC; `CURRENT_TIMESTAMP` is rendered in the SESSION
    // zone. One statement decides both, for the main pool and every per-plugin pool.
    assert.match(driver.SET_SESSION_SQL_MODE, /time_zone='\+00:00'/,
        'without a pinned session zone the server clock and the application clock disagree by the host offset');
    assert.match(driver.SET_SESSION_SQL_MODE, /lock_wait_timeout=\d+/,
        "MySQL's default lock_wait_timeout is 31536000s — a lost metadata lock must be an error, not a year-long hang");
    assert.ok(driver.SET_SESSION_SQL_MODE.includes(driver.SESSION_SQL_MODE),
        'the mode still comes from the ONE constant both pools share');
});

// ── The widening pass: its scope is a decision, so it is tested as one ───────────────────────────
test('the legacy widening pass may only ever touch tables WordJS owns', () => {
    const ours = ['posts', 'post_meta', 'users', 'options', 'wordjs_analytics', 'wordjs_locks',
        'wjp_mailserver_messages', 'wjp_shop_orders', 'schema_migrations', 'collab_ops'];
    const theirs = ['wp_posts', 'orders', 'customers', 'django_migrations', 'nextcloud_files',
        'mail', 'sessions', 'joomla_content'];

    for (const t of ours) assert.ok(driver.isWordjsOwnedTable(t), `${t} is ours and must be widened`);
    for (const t of theirs) {
        assert.ok(!driver.isWordjsOwnedTable(t),
            `${t} belongs to another application sharing this schema — rewriting its columns at boot is not ours to do`);
    }
});

test('the widening pass rebuilds a table ONCE, however many of its columns it widens', async () => {
    const statements: string[] = [];
    driver.pool = {
        query: async (sql: string) => {
            statements.push(String(sql));
            if (/information_schema\.columns/i.test(sql)) {
                return [[
                    { t: 'posts', c: 'post_content' }, { t: 'posts', c: 'post_excerpt' },
                    { t: 'posts', c: 'guid' }, { t: 'posts', c: 'post_password' },
                    { t: 'not_ours', c: 'anything' }
                ], []];
            }
            if (/SHOW CREATE TABLE/i.test(sql)) {
                return [[{
                    'Create Table':
                        'CREATE TABLE "posts" (\n' +
                        '  "id" int NOT NULL AUTO_INCREMENT,\n' +
                        '  "post_content" varchar(255) NOT NULL DEFAULT \'\',\n' +
                        '  "post_excerpt" varchar(255) NOT NULL DEFAULT \'\',\n' +
                        '  "guid" varchar(255) NOT NULL DEFAULT \'\',\n' +
                        '  "post_password" varchar(255) NOT NULL DEFAULT \'\',\n' +
                        '  PRIMARY KEY ("id")\n' +
                        ') ENGINE=InnoDB'
                }], []];
            }
            return [[], []];
        },
        end: async () => { /* fake */ }
    };

    const widened = await driver.widenLegacyCappedTextColumns();

    assert.deepStrictEqual(widened.sort(), [
        'posts.guid', 'posts.post_content', 'posts.post_excerpt', 'posts.post_password'
    ], 'every non-key capped column of an owned table is widened');
    const alters = statements.filter((s) => /^ALTER TABLE/i.test(s));
    assert.strictEqual(alters.length, 1,
        `a VARCHAR→LONGTEXT change is ALGORITHM=COPY: ${alters.length} statements means ${alters.length} full rebuilds of the same table at boot`);
    assert.strictEqual((alters[0].match(/MODIFY COLUMN/gi) || []).length, 4, 'all four columns travel in that one rebuild');
    assert.ok(!statements.some((s) => /not_ours/i.test(s)),
        'a table this application does not own must not even be INSPECTED, let alone altered');
});
