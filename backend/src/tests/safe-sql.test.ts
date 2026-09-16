/**
 * core/safe-sql — the two CodeQL HIGH findings of "datos y ejecución dinámica", closed at the cause.
 *
 *   #579 js/sql-injection            backend/src/drivers/sqlite-native-async.ts:119 (`this.db.exec(sql)`)
 *        source: routes/export.ts:71 (`req.body` on POST /api/v1/import)
 *        path:   import bundle → core/import-export custom_tables → config/database.createPluginTable
 *                → driverAsync.exec() → better-sqlite3 exec(), which runs STACKED statements.
 *        The table NAME was allowlisted. Each column DEFINITION was not: it was checked by a DENYLIST
 *        (`/;|--|\/\*|\*\//`) plus an identifier test on a DERIVED COPY (`col.trim().split(/\s+/)[0]`),
 *        and then the ORIGINAL `col` was interpolated. Both halves of the failure mode this project
 *        keeps re-shipping. The same door is open to every untrusted plugin (plugin-api db.createTable).
 *
 *   #611 js/unvalidated-dynamic-method-call  backend/src/routes/settings.ts:284
 *        source: `req.params.key` on GET /api/v1/settings/:key — an outside string INDEXED an object
 *        literal and the result was CALLED. hasOwnProperty closed the hole of the day but left the
 *        shape (an external string indexing an object) for the next edit to reopen.
 *
 * Sections:
 *   A. safe-sql unit — identifiers: form, canonicalization, fail-closed.
 *   B. safe-sql unit — column definitions: every escape SHAPE, including the ones the OLD denylist let
 *      through (`"`, backtick, `\`, `#`, newline, unbalanced parens/quotes), plus the real definitions
 *      the product ships, which must keep working.
 *   C. createPluginTable end to end against the REAL sqlite-native-async driver (the CodeQL sink):
 *      injection shapes fail closed AND leave no collateral, legitimate DDL still runs.
 *   D. import-export's custom_tables path — the actual POST /api/v1/import taint source.
 *   E. GET /settings/:key through supertest — no prototype member is ever dispatched.
 *   F. Source locks: neither shape may come back.
 *   G. The catalog regression guard: every column definition a shipped marketplace plugin hands to
 *      db.createTable must be accepted by the producer. Since the 2026-08-15 hardening the alphabet
 *      was applied INSIDE string literals too, so `params TEXT DEFAULT '{}'` (an empty-JSON default)
 *      and `color TEXT DEFAULT '#3b82f6'` were refused and three catalog plugins died at boot — and
 *      f6-plugin-compatibility could not see it because its bridge stubs createTable.
 *
 * CWD/DB sandbox ordering copied from safe-path.test.ts / sandbox-settings-visibility.test.ts: chdir
 * into a temp root and repoint config.dbPath BEFORE the DB layer or any router is required. The DB is
 * opened/closed by ROOT-level hooks so section C's teardown cannot pull it out from under D and E.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-safe-sql-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const {
    isPlainIdent,
    safeIdent,
    assertPlainIdent,
    safeColumnDefinition,
    assertColumnDefinition,
    buildCreateTable,
    MAX_IDENT_LEN,
    MAX_COLUMN_DEF_LEN,
} = require('../core/safe-sql');

const SRC = path.resolve(__dirname, '..');
const NUL = '\u0000';

let dbAsync: any;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* ignore */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------------------------
// A. identifiers
// ---------------------------------------------------------------------------------------------

describe('safe-sql: identifiers', () => {
    it('accepts the identifiers the product actually creates, and returns them UNCHANGED', () => {
        for (const name of [
            'received_emails', 'email_attachments', 'posts', 'post_meta', '_private',
            'wjp_mail_server_secrets', 'wjp_online_store_orders', 'A1', 'x',
        ]) {
            assert.strictEqual(safeIdent(name), name, `${name} must survive canonicalization byte for byte`);
            assert.strictEqual(isPlainIdent(name), true);
        }
    });

    it('fails CLOSED on every non-identifier shape (null, never a "sanitized" fallback)', () => {
        const shapes: [string, unknown][] = [
            ['empty', ''],
            ['leading digit', '1abc'],
            ['hyphen', 'wjp-orders'],
            ['space', 'my table'],
            ['dot-qualified', 'main.users'],
            ['statement break', 'users; DROP TABLE users'],
            ['double quote', 'us"ers'],
            ['single quote', "us'ers"],
            ['backtick', 'us`ers'],
            ['backslash', 'us\\ers'],
            ['line comment', 'users--'],
            ['block comment', 'users/*x*/'],
            ['hash comment', 'users#'],
            ['newline', 'users\nDROP TABLE users'],
            ['NUL', `users${NUL}`],
            ['unicode homoglyph', 'usеrs'], // Cyrillic е
            ['too long', 'a'.repeat(MAX_IDENT_LEN + 1)],
            ['not a string (number)', 42],
            ['not a string (object)', { toString: () => 'users' }],
            ['not a string (null)', null],
            ['not a string (undefined)', undefined],
        ];
        for (const [label, value] of shapes) {
            assert.strictEqual(safeIdent(value), null, `safeIdent must refuse: ${label}`);
            assert.strictEqual(isPlainIdent(value), false, `isPlainIdent must refuse: ${label}`);
            assert.throws(() => assertPlainIdent(value), /not a plain SQL identifier/, `assertPlainIdent must throw: ${label}`);
        }
    });

    it('accepts an identifier exactly at the length ceiling', () => {
        const at = 'a'.repeat(MAX_IDENT_LEN);
        assert.strictEqual(safeIdent(at), at);
    });
});

// ---------------------------------------------------------------------------------------------
// B. column definitions
// ---------------------------------------------------------------------------------------------

describe('safe-sql: column definitions', () => {
    it('accepts every definition the product ships (models/Email.ts, the mail-server fixtures)', () => {
        const real = [
            'id INT_PK',
            'message_id TEXT',
            'date_received DATETIME DEFAULT CURRENT_TIMESTAMP',
            'is_read INT DEFAULT 0',
            'parent_id INT DEFAULT 0',
            'scheduled_at DATETIME',
            'name TEXT NOT NULL',
            'value TEXT',
            'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'title VARCHAR(255) NOT NULL',
            "post_status TEXT NOT NULL DEFAULT 'draft'",
            'price REAL DEFAULT 0.0',
            'balance INTEGER DEFAULT -1',
            'user_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
            'PRIMARY KEY (a, b)',
            'FOREIGN KEY (user_id) REFERENCES users(id)',
            'qty INTEGER CHECK (qty >= 0)',
            "kind TEXT DEFAULT '('", // a quoted paren must NOT read as unbalanced
        ];
        for (const def of real) {
            assert.strictEqual(safeColumnDefinition(def), def, `must accept and return verbatim: ${def}`);
        }
    });

    it("trims, and returns the CANONICAL string it validated (not the caller's value)", () => {
        assert.strictEqual(safeColumnDefinition('   id INT_PK   '), 'id INT_PK');
    });

    it('accepts a literal whose TEXT carries characters that are syntax only in code position (the activation regression)', () => {
        // Every one of these was refused between 2026-08-15 and this fix because DEF_CHARS was applied
        // inside the quotes. The first three are verbatim from shipped catalog plugins (bookings,
        // conference-manager); each one killed the plugin's isolated child at boot with
        // "createTable: '…' is not an acceptable column definition" and the route answered 500.
        const literals = [
            "params TEXT DEFAULT '{}'",
            "color TEXT DEFAULT '#3b82f6'",
            "availability TEXT NOT NULL DEFAULT '{}'",
            "note TEXT DEFAULT 'a;b'",          // a statement separator INSIDE a literal is text
            "kind TEXT DEFAULT '('",            // still: a quoted paren is not counted
            "label TEXT DEFAULT 'año'",         // non-ASCII printable text
            "dash TEXT DEFAULT '--'",           // a comment marker INSIDE a literal is text (documented)
            "hash TEXT DEFAULT '# not a comment'",
            "q TEXT DEFAULT 'it''s'",           // the SQL-standard doubled quote: close, then open
            "empty TEXT DEFAULT ''",
            "quoted TEXT DEFAULT '\"x\"'",      // a double quote inside a single-quoted literal
            "tick TEXT DEFAULT '`x`'",
            "comment TEXT DEFAULT '/* x */'",
            "pct TEXT DEFAULT '%s $1 :x ?'",    // every punctuation mark the code alphabet lacks
            "emoji TEXT DEFAULT '👨‍👩‍👧'",     // a ZERO WIDTH JOINER sequence is one printable glyph
        ];
        for (const def of literals) {
            assert.strictEqual(safeColumnDefinition(def), def, `must accept and return verbatim: ${def}`);
            assert.strictEqual(assertColumnDefinition(def), def);
        }
    });

    it('keeps refusing those same characters OUTSIDE quotes, and anything that could carry a literal past its quote', () => {
        const shapes: [string, string][] = [
            ['brace in code', 'x TEXT DEFAULT {}'],
            ['hash in code (MySQL comment)', 'x TEXT DEFAULT #'],
            ['semicolon in code', 'x TEXT; DROP TABLE y'],
            ['semicolon in code after a closed literal', "x TEXT DEFAULT 'a'; DROP TABLE y"],
            ['comment marker in code after a closed literal', "x TEXT DEFAULT 'a' -- , y TEXT"],
            ['backslash inside the literal (an escape in MySQL)', "x TEXT DEFAULT 'a\\'b'"],
            ['backslash inside the literal, quotes still even', "x TEXT DEFAULT 'a\\b'"],
            ['unterminated literal', "x TEXT DEFAULT 'a"],
            ['unterminated literal hiding a statement', "x TEXT DEFAULT 'a; DROP TABLE users; --"],
            ['line break inside the literal', "x TEXT DEFAULT 'a\nb'"],
            ['carriage return inside the literal', "x TEXT DEFAULT 'a\rb'"],
            ['tab inside the literal (a control character)', "x TEXT DEFAULT 'a\tb'"],
            ['NUL inside the literal', `x TEXT DEFAULT 'a${NUL}b'`],
            ['C1 control (NEL) inside the literal', "x TEXT DEFAULT 'ab'"],
            ['Unicode LINE SEPARATOR inside the literal', "x TEXT DEFAULT 'a b'"],
            ['lone surrogate inside the literal', "x TEXT DEFAULT 'a\ud800b'"],
            ['non-ASCII in code', 'x TEXT DEFAULT año'],
            ['a literal cannot be the leading word', "'x' TEXT"],
            ['closing the column list right after a literal', "x TEXT DEFAULT 'a'); DROP TABLE users; CREATE TABLE z (b TEXT"],
        ];
        for (const [label, def] of shapes) {
            assert.strictEqual(safeColumnDefinition(def), null, `must refuse: ${label} — ${JSON.stringify(def)}`);
            assert.throws(() => assertColumnDefinition(def), /not an acceptable column definition/, label);
        }
    });

    it('refuses the shapes the OLD denylist let through — the actual regression this closes', () => {
        // Every one of these passed `/;|--|\/\*|\*\//` AND had an identifier first token, so the old
        // guard accepted them and the raw string went into `CREATE TABLE …`.
        const shapes: [string, string][] = [
            ['double quote (identifier quoting / MySQL string)', 'a TEXT DEFAULT "x"'],
            ['backtick (MySQL identifier quoting)', 'a TEXT DEFAULT `x`'],
            ['backslash (string escape)', "a TEXT DEFAULT 'x\\'"],
            ['MySQL # line comment', 'a TEXT # the rest of the DDL is now a comment'],
            ['newline', 'a TEXT\n  , b TEXT'],
            ['carriage return', 'a TEXT\r  , b TEXT'],
            ['NUL', `a TEXT${NUL}`],
            ['closes the column list', 'a TEXT)'],
            ['opens a paren it never closes', 'a VARCHAR(255'],
            ['closes before opening', 'a TEXT) NOT NULL ('],
            ['unterminated string literal', "a TEXT DEFAULT 'x"],
            ['odd number of quotes', "a TEXT DEFAULT 'x' || '"],
            ['percent / format smuggling', 'a TEXT DEFAULT %s'],
            ['dollar-quoted (Postgres)', 'a TEXT DEFAULT $$x$$'],
            ['colon (bind parameter)', 'a TEXT DEFAULT :x'],
            ['square brackets (T-SQL quoting)', 'a TEXT DEFAULT [x]'],
        ];
        for (const [label, def] of shapes) {
            assert.strictEqual(safeColumnDefinition(def), null, `must refuse: ${label} — ${JSON.stringify(def)}`);
            assert.throws(() => assertColumnDefinition(def), /not an acceptable column definition/, label);
        }
    });

    it('refuses the shapes the old denylist already caught (no regression in coverage)', () => {
        for (const def of [
            "a TEXT); INSERT INTO users (user_login) VALUES ('evil'); CREATE TABLE z (b TEXT",
            'a TEXT -- comment',
            'a TEXT /* comment */',
            'a TEXT */',
            'a TEXT /*!50000 , evil TEXT */',
        ]) {
            assert.strictEqual(safeColumnDefinition(def), null, `must refuse: ${JSON.stringify(def)}`);
        }
    });

    it('allows a negative default but never the `--` a second dash would make', () => {
        assert.strictEqual(safeColumnDefinition('n INTEGER DEFAULT -1'), 'n INTEGER DEFAULT -1');
        assert.strictEqual(safeColumnDefinition('n INTEGER DEFAULT --1'), null);
        assert.strictEqual(safeColumnDefinition('n INTEGER DEFAULT - -1'), 'n INTEGER DEFAULT - -1');
    });

    it('requires the definition to NAME something (a plain identifier leads)', () => {
        for (const def of ['', '   ', '(a)', '123 TEXT', '-- x', "'a' TEXT", '"a" TEXT']) {
            assert.strictEqual(safeColumnDefinition(def), null, `must refuse: ${JSON.stringify(def)}`);
        }
    });

    it('bounds the work done on a hostile string, and refuses non-strings', () => {
        assert.strictEqual(safeColumnDefinition('a TEXT ' + 'x'.repeat(MAX_COLUMN_DEF_LEN)), null);
        assert.strictEqual(safeColumnDefinition(['a', 'TEXT'] as any), null);
        assert.strictEqual(safeColumnDefinition(null), null);
    });
});

describe('safe-sql: buildCreateTable', () => {
    it('builds exactly one statement out of validated parts', () => {
        const sql = buildCreateTable('wjp_x_notes', ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'body TEXT']);
        assert.match(sql, /^CREATE TABLE IF NOT EXISTS wjp_x_notes \(/);
        assert.strictEqual(sql.includes(';'), false, 'no statement separator may exist in the assembled DDL');
    });

    it('refuses an empty / non-array / oversized column list', () => {
        assert.throws(() => buildCreateTable('t', []), /non-empty array/);
        assert.throws(() => buildCreateTable('t', 'id INT' as any), /non-empty array/);
        assert.throws(() => buildCreateTable('t', new Array(201).fill('a TEXT')), /too many columns/);
    });

    it('refuses a poisoned table name before any column is even looked at', () => {
        assert.throws(() => buildCreateTable('t (a TEXT); DROP TABLE users; --', ['id INT']), /not a plain SQL identifier/);
    });

    it('its single-statement belt-and-braces reads CODE: a `;` inside a literal is one statement, a `;` in code is refused', () => {
        const sql = buildCreateTable('wjp_x_notes', ['id INT_PK', "note TEXT DEFAULT 'a;b'", "params TEXT DEFAULT '{}'"]);
        assert.ok(sql.includes("note TEXT DEFAULT 'a;b'"), 'the literal must reach the DDL verbatim');
        assert.ok(sql.includes("params TEXT DEFAULT '{}'"));
        // Blank every literal and the assembled statement has no separator left.
        assert.strictEqual(sql.replace(/'[^']*'/g, "''").includes(';'), false);
        for (const col of ['a TEXT; DROP TABLE users', "a TEXT DEFAULT 'x'; DROP TABLE users", "a TEXT DEFAULT 'x; DROP TABLE users"]) {
            assert.throws(() => buildCreateTable('wjp_x_notes', ['id INT_PK', col]), /not an acceptable column definition/, col);
        }
    });
});

// ---------------------------------------------------------------------------------------------
// C. the real sink: createPluginTable → sqlite-native-async.exec
// ---------------------------------------------------------------------------------------------

describe('createPluginTable against the real better-sqlite3 driver (the CodeQL sink)', () => {
    const tableExists = async (name: string) => {
        const row = await dbAsync.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
        return !!row;
    };

    it('still creates a real plugin table (the product path must keep working)', async () => {
        await database.createPluginTable('wjp_safe_sql_emails', [
            'id INT_PK',
            'subject TEXT',
            'date_received DATETIME DEFAULT CURRENT_TIMESTAMP',
            'is_read INT DEFAULT 0',
        ]);
        assert.strictEqual(await tableExists('wjp_safe_sql_emails'), true);
        await dbAsync.run('INSERT INTO wjp_safe_sql_emails (subject) VALUES (?)', ['hello']);
        const row = await dbAsync.get('SELECT subject, is_read FROM wjp_safe_sql_emails');
        assert.strictEqual(row.subject, 'hello');
        assert.strictEqual(row.is_read, 0);
    });

    it('refuses a stacked-statement TABLE NAME and leaves `users` untouched', async () => {
        const pre = await dbAsync.get('SELECT COUNT(*) AS n FROM users');
        await assert.rejects(
            database.createPluginTable('wjp_x; DROP TABLE users; CREATE TABLE wjp_pwned (a TEXT', ['id INT_PK']),
            /not a plain SQL identifier/
        );
        assert.strictEqual(await tableExists('users'), true, 'users must survive');
        assert.strictEqual(await tableExists('wjp_pwned'), false, 'no collateral table may exist');
        const post = await dbAsync.get('SELECT COUNT(*) AS n FROM users');
        assert.strictEqual(post.n, pre.n);
    });

    it('refuses a stacked-statement COLUMN and leaves no collateral', async () => {
        await assert.rejects(
            database.createPluginTable('wjp_safe_sql_a', [
                'id INT_PK',
                "x TEXT); INSERT INTO users (user_login, user_pass, user_email) VALUES ('backdoor','x','b@x'); CREATE TABLE wjp_pwned2 (a",
            ]),
            /not an acceptable column definition/
        );
        assert.strictEqual(await tableExists('wjp_safe_sql_a'), false);
        assert.strictEqual(await tableExists('wjp_pwned2'), false);
        const backdoor = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['backdoor']);
        assert.strictEqual(backdoor, undefined, 'no row may have been inserted');
    });

    it('refuses the column shapes the OLD guard accepted (what made this a real finding)', async () => {
        const shapes: [string, string][] = [
            ['quote-character smuggling', 'x TEXT DEFAULT "y"'],
            ['MySQL # comment', 'x TEXT # rest of DDL commented out'],
            ['column list escape', 'x TEXT)'],
            ['unterminated literal', "x TEXT DEFAULT 'y"],
            ['newline', 'x TEXT\n, y TEXT'],
            ['backslash escape', "x TEXT DEFAULT 'y\\'"],
        ];
        for (const [label, col] of shapes) {
            await assert.rejects(
                database.createPluginTable('wjp_safe_sql_b', ['id INT_PK', col]),
                /not an acceptable column definition/,
                `must refuse: ${label}`
            );
            assert.strictEqual(await tableExists('wjp_safe_sql_b'), false, `no table may exist after: ${label}`);
        }
    });

    it('the DDL that reaches SQLite contains only characters from the allowed alphabet', async () => {
        await database.createPluginTable('wjp_safe_sql_c', ['id INT_PK', "kind TEXT NOT NULL DEFAULT 'a'", 'n INTEGER DEFAULT -1']);
        const row = await dbAsync.get("SELECT sql FROM sqlite_master WHERE type='table' AND name = 'wjp_safe_sql_c'");
        assert.ok(row && typeof row.sql === 'string');
        // Whatever the caller passed, what SQLite stored is built from the code alphabet only (no literal
        // in this table carries text outside it; the next case covers the literal alphabet).
        assert.match(row.sql, /^[A-Za-z0-9_ \t\r\n,()'.+\-<>=]*$/);
        assert.strictEqual(row.sql.includes(';'), false);
    });

    it("creates a table whose quoted defaults carry `{}` / `#` / `;` and reads them back verbatim (the activation regression)", async () => {
        // The three shipped definitions, plus a separator inside a literal. Before the fix the first of
        // these threw here and the plugin never got past initSchema().
        await database.createPluginTable('wjp_safe_sql_json', [
            'id INT_PK',
            "params TEXT DEFAULT '{}'",
            "color TEXT DEFAULT '#3b82f6'",
            "availability TEXT NOT NULL DEFAULT '{}'",
            "note TEXT DEFAULT 'a;b'",
            'n INT DEFAULT 0',
        ]);
        assert.strictEqual(await tableExists('wjp_safe_sql_json'), true);
        // The DDL SQLite stored still has each literal intact and no separator outside one.
        const ddl = await dbAsync.get("SELECT sql FROM sqlite_master WHERE type='table' AND name = 'wjp_safe_sql_json'");
        assert.ok(ddl.sql.includes("DEFAULT '{}'") && ddl.sql.includes("DEFAULT '#3b82f6'") && ddl.sql.includes("DEFAULT 'a;b'"), ddl.sql);
        assert.strictEqual(ddl.sql.replace(/'[^']*'/g, "''").includes(';'), false);
        // Insert nothing but a value the defaults do not cover, and the defaults come back as data.
        await dbAsync.run('INSERT INTO wjp_safe_sql_json (n) VALUES (?)', [7]);
        const row = await dbAsync.get('SELECT params, color, availability, note, n FROM wjp_safe_sql_json');
        assert.deepStrictEqual(row, { params: '{}', color: '#3b82f6', availability: '{}', note: 'a;b', n: 7 });
        assert.deepStrictEqual(JSON.parse(row.params), {}, 'the empty-JSON default must parse as JSON');
        assert.strictEqual(await tableExists('users'), true, 'nothing else may have been touched');
    });
});

// ---------------------------------------------------------------------------------------------
// D. the taint source: import bundle → custom_tables
// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/import custom_tables (the CodeQL source at routes/export.ts:71)', () => {
    it('reports the malicious table instead of executing it, and touches nothing', async () => {
        const { importSite } = require('../core/import-export');
        const results = await importSite({
            content: {
                custom_tables: [{
                    name: 'wjp_import_evil',
                    schema: {
                        columns: [
                            'id INT_PK',
                            "x TEXT); INSERT INTO users (user_login, user_pass, user_email) VALUES ('imported','x','i@x'); CREATE TABLE wjp_import_pwned (a",
                        ],
                    },
                }],
            },
        }, {});

        assert.ok(Array.isArray(results.errors));
        assert.ok(results.errors.some((e: string) => /column definition/.test(e)),
            `the refusal must be reported, got ${JSON.stringify(results.errors)}`);

        const pwned = await dbAsync.get("SELECT name FROM sqlite_master WHERE type='table' AND name = 'wjp_import_pwned'");
        assert.strictEqual(pwned, undefined);
        const injected = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['imported']);
        assert.strictEqual(injected, undefined);
    });

    it('still round-trips a legitimate custom table', async () => {
        const { importSite } = require('../core/import-export');
        const results = await importSite({
            content: {
                custom_tables: [{
                    name: 'wjp_import_ok',
                    schema: { columns: ['id INT_PK', 'label TEXT'] },
                    rows: [{ id: 1, label: 'first' }],
                }],
            },
        }, {});
        assert.deepStrictEqual(results.errors, [], `no error expected, got ${JSON.stringify(results.errors)}`);
        const row = await dbAsync.get('SELECT label FROM wjp_import_ok WHERE id = 1');
        assert.strictEqual(row.label, 'first');
    });
});

// ---------------------------------------------------------------------------------------------
// E. GET /settings/:key — no prototype member may be dispatched
// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/settings/:key dispatches only what the Map holds', () => {
    let request: any;
    let app: any;

    before(() => {
        request = require('supertest');
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    it('resolves a REAL derived setting (not in PUBLIC_SETTINGS — it can only come from the Map)', async () => {
        const res = await request(app).get('/api/v1/settings/active_theme_version');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.key, 'active_theme_version');
        assert.strictEqual(typeof res.body.value, 'string');
    });

    it('never calls an inherited member — every prototype name is a plain 403, not a dispatch', async () => {
        for (const key of [
            'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
            'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
            '__defineGetter__', '__defineSetter__', '__lookupGetter__',
        ]) {
            const res = await request(app).get(`/api/v1/settings/${encodeURIComponent(key)}`);
            assert.strictEqual(res.status, 403,
                `'${key}' must be refused as a non-public setting, got ${res.status} ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.code, 'rest_forbidden');
            // A dispatched Object.prototype member would have answered 200 with its result (or 500 from
            // the thrown TypeError). Neither may ever appear.
            assert.strictEqual(res.body.value, undefined);
        }
    });
});

// ---------------------------------------------------------------------------------------------
// F. source locks — neither shape may come back
// ---------------------------------------------------------------------------------------------

describe('source locks', () => {
    it('config/database.createPluginTable no longer denylists column text', () => {
        const src = fs.readFileSync(path.join(SRC, 'config', 'database.ts'), 'utf8');
        assert.strictEqual(/const BAD_COL\s*=/.test(src), false,
            'the column DENYLIST is gone for good — allowlist the form in core/safe-sql instead');
        assert.strictEqual(/const\s+firstTok\s*=/.test(src), false,
            'no validating a DERIVED COPY of a value that is then concatenated raw');
        assert.ok(/require\('\.\.\/core\/safe-sql'\)/.test(src),
            'createPluginTable must build its DDL through core/safe-sql');
    });

    it('routes/settings.ts never indexes a derived-setting registry with an outside string', () => {
        const src = fs.readFileSync(path.join(SRC, 'routes', 'settings.ts'), 'utf8');
        assert.ok(/const DERIVED_PUBLIC_SETTINGS[^\n]*new Map\(/.test(src),
            'DERIVED_PUBLIC_SETTINGS must be a Map (no prototype chain to dispatch through)');
        assert.ok(/const DERIVED_ADMIN_SETTINGS[^\n]*new Map\(/.test(src),
            'DERIVED_ADMIN_SETTINGS must be a Map, so no future single-key route reintroduces the shape');
        assert.strictEqual(/DERIVED_(?:PUBLIC|ADMIN)_SETTINGS\[/.test(src), false,
            'no bracket indexing of a derived-setting registry');
    });

    it('core/import-export shares safe-sql, so the two ends of the import path cannot drift', () => {
        const src = fs.readFileSync(path.join(SRC, 'core', 'import-export.ts'), 'utf8');
        assert.ok(/require\('\.\/safe-sql'\)/.test(src));
        assert.strictEqual(/IMPORT_IDENT_RE/.test(src), false, 'no second, private copy of the identifier shape');
    });
});

// ---------------------------------------------------------------------------------------------
// G. the catalog regression guard — every shipped plugin's column definitions pass the producer
// ---------------------------------------------------------------------------------------------

/**
 * Pull, out of one plugin entry point's SOURCE, every string that is handed to the host as a column
 * definition: each element of the array literal in `db.createTable(<table>, [ … ])`, plus the
 * `<col> <type>` pair of every `addColumn*(<table>, '<col>', '<type>')` call whose two arguments are
 * string literals (those reach the host as `ALTER TABLE … ADD COLUMN <col> <type>` through db.run and
 * the SQL guard rather than through safe-sql, so for them this is a consistency check on the same
 * definition language, not the gate they actually cross).
 *
 * This is a PRAGMATIC extractor, not a JavaScript parser, and its limits are deliberate:
 *   · the array must be a literal that starts at the `[` following `createTable(<first argument>,`;
 *     an array built elsewhere and passed by name is not seen (no shipped plugin does that today —
 *     the count assertions below are what turn a refactor into a red test rather than a silent skip);
 *   · elements are `'…'`, `"…"` (with `\'`, `\"`, `\\`, `\n`, `\t` unescaped) or `` `…` `` templates,
 *     whose `${…}` interpolations are replaced by a plain identifier — every shipped interpolation is
 *     a table name (`REFERENCES ${T.conferences}(id)`), so that is what the host would see;
 *   · line comments and block comments inside the array are skipped (the catalog annotates columns
 *     inline, and those annotations legitimately contain quotes);
 *   · nested brackets inside an element are not expected and would end the array early — an element
 *     the producer must accept has no `[` or `]` in code position anyway.
 */
function extractCatalogColumnDefinitions(src: string): string[] {
    const defs: string[] = [];

    const readJsString = (s: string, start: number): { value: string; end: number } | null => {
        const quote = s[start];
        let i = start + 1;
        let out = '';
        while (i < s.length) {
            const ch = s[i];
            if (ch === '\\') {
                const next = s[i + 1];
                out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
                i += 2;
                continue;
            }
            if (ch === quote) return { value: out, end: i + 1 };
            if (quote === '`' && ch === '$' && s[i + 1] === '{') {
                let depth = 1;
                let j = i + 2;
                while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
                out += 'wjp_interpolated_table';
                i = j;
                continue;
            }
            out += ch;
            i++;
        }
        return null; // unterminated — not a string we can read
    };

    // Every string element of the array literal that begins at `open` (the index of its `[`).
    const readArrayStrings = (s: string, open: number): string[] => {
        const found: string[] = [];
        let i = open + 1;
        while (i < s.length) {
            const ch = s[i];
            if (ch === ']') return found;
            if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
            if (ch === '/' && s[i + 1] === '*') { const close = s.indexOf('*/', i + 2); i = close < 0 ? s.length : close + 2; continue; }
            if (ch === "'" || ch === '"' || ch === '`') {
                const str = readJsString(s, i);
                if (!str) return found;
                found.push(str.value);
                i = str.end;
                continue;
            }
            i++;
        }
        return found;
    };

    const createRe = /\bcreateTable\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(src)) !== null) {
        // Skip the first argument (the table-name expression) up to the top-level comma, then expect `[`.
        let i = m.index + m[0].length;
        let depth = 0;
        while (i < src.length && !(src[i] === ',' && depth === 0)) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') { if (depth === 0) break; depth--; }
            i++;
        }
        if (src[i] !== ',') continue;
        i++;
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] !== '[') continue;
        defs.push(...readArrayStrings(src, i));
    }

    const addColumnRe = /\baddColumn\w*\s*\(\s*[^,()]+,\s*(['"])([^'"]*)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3\s*\)/g;
    while ((m = addColumnRe.exec(src)) !== null) {
        const type = m[4].replace(/\\(.)/g, (_w: string, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
        defs.push(`${m[2]} ${type}`);
    }
    return defs;
}

describe('catalog regression guard: every shipped plugin column definition passes the producer', () => {
    const PLUGINS_ROOT = path.resolve(__dirname, '../../..', 'marketplace', 'plugins');

    it('the extractor reads the shapes the catalog actually uses (so an empty result cannot pass)', () => {
        const sample = [
            'await db.createTable(T.rules, [',
            "    'id INT_PK',",
            "    'params TEXT DEFAULT \\'{}\\'',     // '' / operator 'any' = unconditional",
            '    "color TEXT DEFAULT \'#3b82f6\'",',
            "    /* a block comment, with a 'quote' */",
            '    `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`',
            ']);',
            'await addColumnIfMissing(T.rules, \'params\', "TEXT DEFAULT \'{}\'");',
        ].join('\n');
        assert.deepStrictEqual(extractCatalogColumnDefinitions(sample), [
            'id INT_PK',
            "params TEXT DEFAULT '{}'",
            "color TEXT DEFAULT '#3b82f6'",
            'FOREIGN KEY (conference_id) REFERENCES wjp_interpolated_table(id) ON DELETE CASCADE',
            "params TEXT DEFAULT '{}'",
        ]);
    });

    it('safeColumnDefinition accepts every column definition in marketplace/plugins/*/index.js', () => {
        const slugs = fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })
            .filter((d: any) => d.isDirectory() && fs.existsSync(path.join(PLUGINS_ROOT, d.name, 'index.js')))
            .map((d: any) => d.name)
            .sort();
        assert.ok(slugs.length >= 30, `expected the shipped catalog, found ${slugs.length} plugin entry points`);

        let total = 0;
        const pluginsWithTables = new Set<string>();
        for (const slug of slugs) {
            const src = fs.readFileSync(path.join(PLUGINS_ROOT, slug, 'index.js'), 'utf8');
            const defs = extractCatalogColumnDefinitions(src);
            if (defs.length) pluginsWithTables.add(slug);
            for (const def of defs) {
                total++;
                assert.notStrictEqual(safeColumnDefinition(def), null,
                    `plugin '${slug}': safeColumnDefinition refuses ${JSON.stringify(def)} — the plugin's isolated child `
                    + 'dies at boot with "createTable: … is not an acceptable column definition" and it can never be activated');
            }
        }
        // The two plugins that shipped the regressed shapes must be among those seen, and the count must
        // be in the range the catalog actually has — a scan that matched nothing would otherwise pass.
        for (const slug of ['bookings', 'conference-manager']) {
            assert.ok(pluginsWithTables.has(slug), `the extractor must see ${slug}'s createTable calls`);
        }
        assert.ok(total >= 150, `expected the catalog's column definitions, extracted only ${total}`);
    });
});
