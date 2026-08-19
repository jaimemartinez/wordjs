/**
 * WordJS — MySQL driver: the session mode seam, and the TEXT→type rule.
 *
 * These tests drive the REAL driver singleton (`drivers/mysql`) through its REAL entry points —
 * connect(), getScopedPool(), runAsUser(), exec() — with mysql2's pool factory stubbed so no server is
 * needed. Nothing here hand-builds the object under test: the SQL asserted on is the SQL the driver
 * actually hands to mysql2, and the `SET SESSION sql_mode` asserted on is the one the driver's own
 * 'connection' listener emits.
 *
 * What they lock:
 *   1. (audit #2) The per-plugin scoped pool installs the SAME session sql_mode as the main pool. It
 *      used to re-enable NO_BACKSLASH_ESCAPES that the main pool had deliberately removed, which
 *      breaks mysql2's backslash escaping and turns `token = ?` into an injection point reachable by
 *      an anonymous visitor through an honest plugin.
 *   2. (audit #2) runAsUser binds through execute() — server-side prepared statements — so a plugin's
 *      parameters never depend on a session flag at all.
 *   3. (audit #13) A TEXT column becomes LONGTEXT unless it takes part in a key. The old rule matched
 *      the column NAME against a fixed list, so every plugin / imported-bundle TEXT column was created
 *      VARCHAR(255) and (STRICT being off) silently truncated.
 *   4. (audit #13) An index declared LATER over a now-LONGTEXT column still gets created: the driver
 *      narrows the column to VARCHAR(255) when that is provably lossless, and falls back to a bounded
 *      key prefix when it is not.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// ── Stub mysql2's pool factory BEFORE requiring the driver ───────────────────────────────────────
// The driver keeps a reference to the mysql2/promise MODULE and calls createPool() at use time, so
// patching the module object gives us the real options and the real 'connection' handler it installs.
const mysql2promise = require('mysql2/promise');
const realCreatePool = mysql2promise.createPool;

type FakePool = any;
const createdPools: FakePool[] = [];

mysql2promise.createPool = (options: any): FakePool => {
    const pool: FakePool = new EventEmitter();
    pool.options = options;
    pool.sessionStatements = [];              // what the driver SET on a connection
    pool.query = async () => [[], []];
    pool.end = async () => { /* fake */ };
    pool.getConnection = async () => ({
        query: async (sql: string) => {
            if (/^\s*SET\s+SESSION/i.test(String(sql))) { pool.sessionStatements.push(String(sql)); return [[], []]; }
            return [[{ v: '8.0.0-fake' }], []];
        },
        release() { /* fake */ }
    });
    createdPools.push(pool);
    return pool;
};

const driver = require('../drivers/mysql');

after(() => { mysql2promise.createPool = realCreatePool; });

const DB_CONFIG = { host: '127.0.0.1', port: 3306, user: 'root', password: 'pw', name: 'wordjs' };

/** Fire the 'connection' listener the driver registered on `pool` and return what it sent. */
function captureConnectionInit(pool: FakePool): string[] {
    const sent: string[] = [];
    pool.emit('connection', {
        query: (sql: string, cb: any) => { sent.push(String(sql)); if (typeof cb === 'function') cb(null); }
    });
    return sent;
}

test('audit #2: main pool and per-plugin pool install the SAME session sql_mode', async () => {
    driver.config = { ...DB_CONFIG };
    await driver.connect();
    const mainPool = driver.pool;

    const mainInit = captureConnectionInit(mainPool);
    assert.deepStrictEqual(mainInit, [driver.SET_SESSION_SQL_MODE], 'main pool sets the shared mode on every connection');
    // connect() also sets it eagerly on the first checked-out connection.
    assert.deepStrictEqual(mainPool.sessionStatements, [driver.SET_SESSION_SQL_MODE]);

    const scoped = driver.getScopedPool('wjp_seamtest_a', 'secret');
    const scopedInit = captureConnectionInit(scoped);
    assert.deepStrictEqual(scopedInit, mainInit,
        'the per-plugin pool must not declare its own sql_mode — that drift is the injection bug');

    // And the shared mode itself.
    assert.ok(!/NO_BACKSLASH_ESCAPES/i.test(driver.SESSION_SQL_MODE),
        'NO_BACKSLASH_ESCAPES breaks the backslash escaping mysql2 relies on');
    assert.ok(/\bSTRICT_TRANS_TABLES\b/.test(driver.SESSION_SQL_MODE),
        'STRICT turns a value that does not fit into an error instead of a silent truncation');
    assert.ok(/\bANSI_QUOTES\b/.test(driver.SESSION_SQL_MODE));
    assert.strictEqual(scoped.options.multipleStatements, false, 'a sandboxed plugin never stacks statements');
});

test('audit #2: runAsUser binds parameters with execute(), never through query() interpolation', async () => {
    driver.config = { ...DB_CONFIG };
    const pool = driver.getScopedPool('wjp_seamtest_b', 'secret');
    const executed: Array<{ sql: string; params: any[] }> = [];
    pool.execute = async (sql: string, params: any[]) => { executed.push({ sql, params }); return [[{ token: 'row' }], []]; };
    pool.query = async () => { throw new Error('runAsUser must not send plugin parameters through query()'); };

    // The exact shape the audit describes: an honest plugin, a hostile value.
    const hostile = "O' OR 1=1 -- ";
    const rows = await driver.runAsUser(
        'wjp_seamtest_b', 'secret', 'all',
        'SELECT * FROM "wjp_seamtest_b_sessions" WHERE token = ?', [hostile]
    );

    assert.deepStrictEqual(rows, [{ token: 'row' }]);
    assert.strictEqual(executed.length, 1, 'exactly one prepared statement');
    assert.deepStrictEqual(executed[0].params, [hostile], 'the value travels as a bound parameter, not as SQL text');
    assert.ok(!executed[0].sql.includes(hostile), 'the value must never be interpolated into the statement');
});

// ── The TEXT → type rule, through the real exec() path ───────────────────────────────────────────

/** Install a scripted fake as the driver's main pool; returns every statement it receives. */
function scriptMainPool(handlers: Array<[RegExp, (sql: string, params?: any[]) => any]> = []): string[] {
    const seen: string[] = [];
    driver.pool = {
        query: async (sql: string, params?: any[]) => {
            seen.push(String(sql));
            for (const [pattern, handler] of handlers) if (pattern.test(String(sql))) return handler(String(sql), params);
            return [[], []];
        },
        end: async () => { /* fake */ }
    };
    return seen;
}

test('audit #13: a plugin TEXT column is created LONGTEXT; only key columns stay VARCHAR(255)', async () => {
    const seen = scriptMainPool();
    // The shape marketplace/plugins/mail-server creates on activation — the live instance the audit names.
    await driver.exec(`CREATE TABLE IF NOT EXISTS wjp_mailserver_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        raw_content TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox'
    )`);
    const ddl = seen[0];

    for (const col of ['subject', 'body_text', 'body_html', 'raw_content', 'folder']) {
        assert.match(ddl, new RegExp(`${col}\\s+LONGTEXT`, 'i'), `${col} must not be capped`);
        assert.doesNotMatch(ddl, new RegExp(`${col}\\s+VARCHAR`, 'i'), `${col} must not become VARCHAR(255)`);
    }
    // message_id takes part in an INLINE key — MySQL cannot index a TEXT column without a length, so
    // this one (and only this one) stays bounded. Note the key words do NOT immediately follow the
    // type here, which is exactly the case migration.js's lookahead missed.
    assert.match(ddl, /message_id\s+VARCHAR\(255\)/i);
    // A literal default on a text-family column is legal only as a parenthesised expression default.
    assert.match(ddl, /folder\s+LONGTEXT\s+NOT NULL DEFAULT \('inbox'\)/i);
});

test('audit #13: a column named by a TABLE-LEVEL key clause also stays bounded', async () => {
    const seen = scriptMainPool();
    await driver.exec(`CREATE TABLE IF NOT EXISTS wjp_shop_options (
        option_id INTEGER PRIMARY KEY AUTOINCREMENT,
        option_name TEXT NOT NULL DEFAULT '',
        option_value TEXT NOT NULL DEFAULT '',
        UNIQUE (option_name)
    )`);
    const ddl = seen[0];
    assert.match(ddl, /option_name\s+VARCHAR\(255\)/i, 'named by a table-level UNIQUE ⇒ indexable');
    assert.match(ddl, /option_value\s+LONGTEXT/i, 'not a key ⇒ uncapped');
});

test('audit #13: an index declared LATER narrows its TEXT key column instead of failing', async () => {
    const seen = scriptMainPool([
        [/information_schema\.columns/i, () => [[{ c: 'id', t: 'int' }, { c: 'post_name', t: 'longtext' }], []]],
        [/CHAR_LENGTH/i, () => [[], []]],                       // nothing stored is longer than 255
        [/SHOW CREATE TABLE/i, () => [[{
            'Create Table':
                'CREATE TABLE `posts` (\n' +
                '  `id` int NOT NULL AUTO_INCREMENT,\n' +
                "  `post_name` longtext COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (_utf8mb4''),\n" +
                '  PRIMARY KEY (`id`)\n' +
                ') ENGINE=InnoDB'
        }], []]]
    ]);

    await driver.exec('CREATE INDEX IF NOT EXISTS idx_posts_name ON posts (post_name)');

    const alter = seen.find((s) => /^ALTER TABLE/i.test(s));
    assert.ok(alter, 'the TEXT key column is narrowed so MySQL can index it');
    assert.match(alter as string, /MODIFY COLUMN `post_name` VARCHAR\(255\)/i);
    // The rest of the definition comes verbatim from SHOW CREATE TABLE — nothing is reconstructed.
    assert.match(alter as string, /COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT \(_utf8mb4''\)/);
    const created = seen.find((s) => /^\s*CREATE\s+INDEX/i.test(s));
    assert.strictEqual(created, 'CREATE INDEX idx_posts_name ON posts (post_name)',
        'once narrowed, the index statement itself is untouched');
});

test('audit #13: when narrowing would truncate, the index falls back to a bounded prefix', async () => {
    const seen = scriptMainPool([
        [/information_schema\.columns/i, () => [[{ c: 'meta_key', t: 'longtext' }], []]],
        [/CHAR_LENGTH/i, () => [[{ x: 1 }], []]],                // a stored value is already too long
        [/SHOW CREATE TABLE/i, () => [[{ 'Create Table': 'CREATE TABLE `post_meta` (\n)' }], []]]
    ]);

    await driver.exec('CREATE INDEX IF NOT EXISTS idx_post_meta_key ON post_meta (meta_key)');

    assert.ok(!seen.some((s) => /^ALTER TABLE/i.test(s)), 'never shorten a column that holds longer content');
    const created = seen.find((s) => /^\s*CREATE\s+INDEX/i.test(s));
    assert.strictEqual(created, 'CREATE INDEX idx_post_meta_key ON post_meta (meta_key(191))');
});

// ── The rule on DDL that is NOT hand-shaped for it ───────────────────────────────────────────────
// Everything above feeds the rule a tidy CREATE TABLE. Real schemas are not tidy: they carry
// comments with commas in them, quoted constraint names, and columns whose NAME collides with a
// keyword. Each of the three below produced invalid MySQL DDL — that is, a table that is never
// created at all, or a column silently capped at the width this whole change exists to remove.

test('audit #13: a quoted CONSTRAINT name does not make a CHECK look like a key clause', async () => {
    const seen = scriptMainPool();
    await driver.exec(`CREATE TABLE IF NOT EXISTS wjp_notes_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        CONSTRAINT "chk one" CHECK (body <> '')
    )`);
    const ddl = seen[0];
    // A CHECK constrains VALUES; it creates no index, so its columns need no bound. Reading its
    // expression as a key-part list capped `body` at 255 — and with STRICT that is now an ERROR on
    // every note longer than a tweet, not a truncation.
    assert.match(ddl, /body\s+LONGTEXT\s+NOT\s+NULL/i);
    assert.doesNotMatch(ddl, /body\s+VARCHAR/i);
    assert.match(ddl, /CONSTRAINT "chk one" CHECK \(body <> ''\)/, 'the constraint itself passes through intact');
});

test('audit #13: a column NAMED key/text is translated (and quoted), not mistaken for a constraint or a type', async () => {
    const seen = scriptMainPool();
    // The shape of any key/value plugin table. `key` used to be classified as a table-level KEY
    // clause and left as `key TEXT` — untranslated AND unparseable (KEY is reserved in MySQL) — while
    // a column named `text` had its NAME rewritten, producing `LONGTEXT TEXT NOT NULL`.
    await driver.exec(`CREATE TABLE IF NOT EXISTS wjp_kv_store (
        key TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        value TEXT,
        UNIQUE (key)
    )`);
    const ddl = seen[0];
    // The same column with a PARAMETERISED type is the case that needs the type token, not just the
    // clause shape: `key VARCHAR(64)` looks exactly like `KEY idx_name (…)` — keyword, identifier,
    // parenthesised group — so without checking that the second token IS a type it is read as a
    // constraint and passes through unquoted, and the CREATE fails.
    const seen2 = scriptMainPool();
    await driver.exec(`CREATE TABLE IF NOT EXISTS wjp_kv_typed (
        key VARCHAR(64) NOT NULL,
        body TEXT
    )`);
    assert.match(seen2[0], /"key"\s+VARCHAR\(64\)\s+NOT\s+NULL/i, 'a parameterised type still marks a column definition');
    assert.match(seen2[0], /body\s+LONGTEXT/i);
    assert.match(ddl, /"key"\s+VARCHAR\(255\)\s+NOT\s+NULL/i, 'named by the UNIQUE ⇒ bounded, and quoted so the DDL parses');
    assert.match(ddl, /UNIQUE \("key"\)/i, 'the key CLAUSE has to be quoted too, or the CREATE still fails');
    assert.match(ddl, /^\s*text\s+LONGTEXT\s+NOT NULL DEFAULT \(''\)/im, 'the TYPE is replaced, not the identically-named column');
    assert.doesNotMatch(ddl, /LONGTEXT\s+TEXT/i);
    assert.match(ddl, /value\s+LONGTEXT/i);
});

test('audit #13: a CREATE INDEX over a reserved column name is quoted as well (the third surface)', () => {
    assert.strictEqual(
        driver.translateSql('CREATE INDEX IF NOT EXISTS idx_kv_key ON wjp_kv_store (key)'),
        'CREATE INDEX idx_kv_key ON wjp_kv_store ("key")');
    // …and an ordinary index is byte-identical to before.
    assert.strictEqual(
        driver.translateSql('CREATE INDEX IF NOT EXISTS idx_posts_name ON posts (post_name)'),
        'CREATE INDEX idx_posts_name ON posts (post_name)');
});

test('audit #13: the core analytics CREATE — comments with commas in them — survives the rule', async () => {
    const seen = scriptMainPool();
    // Verbatim from models/Analytics.ts, which every install runs at boot. Splitting the column list
    // without stripping comments first turned `-- 'page_view', 'api_call', 'engagement'` into three
    // parts, and `'api_call',` became a column definition → ERROR 1064, and (through
    // recreateTableOnTarget, whose targetExec is not wrapped) an aborted engine switch.
    await driver.exec(`
            CREATE TABLE IF NOT EXISTS wordjs_analytics (
                id VARCHAR(36) PRIMARY KEY,
                type VARCHAR(50) NOT NULL, -- 'page_view', 'api_call', 'engagement'
                resource VARCHAR(255), -- '/hello-world' or 'post_123'
                visitor_ip VARCHAR(64), -- Anonymized hash likely
                user_id VARCHAR(36), -- NULL if guest
                metadata TEXT, -- JSON extra data
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    const ddl = seen[0];
    assert.doesNotMatch(ddl, /'api_call'/, 'a comment must never survive as a column definition');
    assert.match(ddl, /metadata\s+LONGTEXT/i);
    assert.match(ddl, /created_at\s+TIMESTAMP\s+DEFAULT\s+CURRENT_TIMESTAMP/i);
    // Every part of the emitted column list is a real column or constraint.
    const body = driver.createTableBody(ddl) as string;
    for (const part of body.split('\n').map((l: string) => l.trim()).filter(Boolean)) {
        assert.match(part, /^["`]?\w+["`]?\s+\w|^(?:PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|CHECK|FOREIGN)\b/i,
            `not a column definition: ${part}`);
    }
});

// ── transaction(): the same preparation as the top-level methods ─────────────────────────────────

test('audit #13: a CREATE INDEX issued INSIDE transaction() gets the same widening as one outside', async () => {
    const seen = scriptMainPool([
        [/information_schema\.columns/i, () => [[{ c: 'slug', t: 'longtext' }], []]],
        [/CHAR_LENGTH/i, () => [[{ x: 1 }], []]],                 // cannot narrow ⇒ prefix fallback
        [/SHOW CREATE TABLE/i, () => [[{ 'Create Table': 'CREATE TABLE `terms` (\n)' }], []]]
    ]);
    const conn: any = {
        query: async (sql: string) => { seen.push(String(sql)); return [[], []]; },
        beginTransaction: async () => { seen.push('BEGIN'); },
        commit: async () => { seen.push('COMMIT'); },
        rollback: async () => { seen.push('ROLLBACK'); },
        release: () => { /* fake */ }
    };
    driver.pool.getConnection = async () => conn;

    await driver.transaction(async (tx: any) => {
        await tx.exec('CREATE INDEX IF NOT EXISTS idx_terms_slug ON terms (slug)');
    });

    const created = seen.find((s) => /^\s*CREATE\s+INDEX/i.test(s));
    assert.strictEqual(created, 'CREATE INDEX idx_terms_slug ON terms (slug(191))',
        'tx.exec used to run translateSql ONLY — a key part left unbounded by the TEXT rule would die with errno 1170');
});

// ── runAsUser parameter semantics: execute() is not query() ──────────────────────────────────────

test('audit #2: switching to execute() must not change what a plugin\'s parameters MEAN', async () => {
    driver.config = { host: '127.0.0.1', port: 3306, user: 'root', password: 'x', name: 'wordjs' };
    const pool = driver.getScopedPool('wjp_seamtest_c', 'secret');
    const executed: Array<{ sql: string; params: any[] }> = [];
    pool.execute = async (sql: string, params: any[]) => { executed.push({ sql, params }); return [[], []]; };

    // (a) An absent optional field. query() escaped undefined to NULL; execute() THROWS on it
    //     ("Bind parameters must not contain undefined"), so every plugin binding a nullable column
    //     went from inserting NULL to failing.
    await driver.runAsUser('wjp_seamtest_c', 'secret', 'run',
        'INSERT INTO "wjp_seamtest_c_rows" (title, subtitle) VALUES (?, ?)', ['t', undefined]);
    assert.deepStrictEqual(executed[0].params, ['t', null],
        'undefined must reach mysql2 as NULL, exactly as query() delivered it');
    assert.ok(!executed[0].params.some((p) => p === undefined),
        'mysql2 cannot encode undefined at all in the binary protocol');

    // (b) LIMIT ?. mysql2 encodes EVERY number as DOUBLE in a prepared statement, which MySQL refuses
    //     as a LIMIT argument ("Incorrect arguments to mysqld_stmt_execute"). `LIMIT ?` is in a dozen
    //     catalogue plugins, so this alone broke their list views.
    await driver.runAsUser('wjp_seamtest_c', 'secret', 'all',
        'SELECT * FROM "wjp_seamtest_c_rows" WHERE owner = ? LIMIT ? OFFSET ?', ['bob', 20, 40]);
    assert.strictEqual(executed[1].sql, 'SELECT * FROM "wjp_seamtest_c_rows" WHERE owner = ? LIMIT 20 OFFSET 40');
    assert.deepStrictEqual(executed[1].params, ['bob'], 'only the value that CAN be bound stays bound');

    // (c) The inlined value is validated as an integer, not merely trusted — the one place a plugin's
    //     parameter stops being a bound parameter is the one place it must be proved to be a number.
    await assert.rejects(
        () => driver.runAsUser('wjp_seamtest_c', 'secret', 'all', 'SELECT 1 LIMIT ?', ['1; DROP TABLE posts--']),
        /non-negative integer/);
    assert.strictEqual(executed.length, 2, 'the refused statement never reached the pool');
});

test('audit #2: a ? inside a string literal is not a placeholder', () => {
    const { sql, params } = driver.prepareExecuteParams("SELECT '?' AS q FROM t WHERE a = ? LIMIT ?", ['x', 5]);
    assert.strictEqual(sql, "SELECT '?' AS q FROM t WHERE a = ? LIMIT 5");
    assert.deepStrictEqual(params, ['x']);
});

// ── The upgrade path: an install created by the OLD rule ─────────────────────────────────────────

test('audit #13: an EXISTING install has its capped VARCHAR(255) columns widened, key columns excepted', async () => {
    const seen = scriptMainPool([
        // The scan already excludes any column that carries an index (LEFT JOIN … IS NULL).
        [/information_schema\.columns/i, () => [[
            { t: 'wjp_mailserver_messages', c: 'body_text' },
            { t: 'wjp_mailserver_messages', c: 'message_id' }   // the SQL missed it; SHOW CREATE will not
        ], []]],
        [/SHOW CREATE TABLE/i, () => [[{
            'Create Table':
                'CREATE TABLE "wjp_mailserver_messages" (\n' +
                '  "id" int NOT NULL AUTO_INCREMENT,\n' +
                '  "message_id" varchar(255) NOT NULL,\n' +
                '  "body_text" varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT \'\',\n' +
                '  PRIMARY KEY ("id"),\n' +
                '  UNIQUE KEY "uq_msg" ("message_id")\n' +
                ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        }], []]]
    ]);

    const widened = await driver.widenLegacyCappedTextColumns();

    assert.deepStrictEqual(widened, ['wjp_mailserver_messages.body_text'],
        'a non-key column capped by the OLD rule must be widened; on an existing install CREATE TABLE IF NOT EXISTS widens nothing, so STRICT would turn silent truncation into ERROR 1406');
    const alters = seen.filter((s) => /^ALTER TABLE/i.test(s));
    assert.strictEqual(alters.length, 1, 'a column named by a UNIQUE KEY must keep its bound — MySQL cannot index LONGTEXT');
    assert.match(alters[0], /MODIFY COLUMN "body_text" LONGTEXT/i);
    assert.doesNotMatch(alters[0], /varchar|\(255\)/i, 'the length must go with the type');
    assert.match(alters[0], /COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT \(''\)/,
        "MySQL's own definition, with only the type swapped — and a literal default is legal on LONGTEXT only in parentheses");
});

test('audit #13: the widening pass is a no-op when nothing was capped (idempotent, cheap on every boot)', async () => {
    const seen = scriptMainPool([[/information_schema\.columns/i, () => [[], []]]]);
    assert.deepStrictEqual(await driver.widenLegacyCappedTextColumns(), []);
    assert.ok(!seen.some((s) => /SHOW CREATE TABLE|^ALTER TABLE/i.test(s)),
        'no candidates ⇒ exactly one scan query and nothing else');
});

after(async () => { try { await driver.close(); } catch { /* fake pools */ } });
