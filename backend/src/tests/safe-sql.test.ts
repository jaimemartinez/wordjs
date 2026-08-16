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
        // Whatever the caller passed, what SQLite stored is built from the constant alphabet only.
        assert.match(row.sql, /^[A-Za-z0-9_ \t\r\n,()'.+\-<>=]*$/);
        assert.strictEqual(row.sql.includes(';'), false);
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
