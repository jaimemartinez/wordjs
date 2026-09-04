/**
 * PLUGIN SQL TEXT-GUARD — STRUCTURAL rules (security audit, 2026-08-05).
 *
 * assertSqlAllowed is the primary control on plugin SQL: the per-plugin DB role is defence in depth
 * BELOW it (provisioning fails gracefully when the pool user has no CREATEROLE, and then everything
 * runs on the admin connection). The audit found its value-level defences thorough — literals,
 * comments, $-quoting, prefix squatting, RETURNING, multi-statement — and both gaps STRUCTURAL:
 * places where the guard inferred safety from the ABSENCE of a token.
 *
 *   1. The prefix rule is enforced by walking the TABLE tokens of the statement. DDL whose object
 *      class is a SCHEMA / DATABASE / ROLE / FUNCTION / EXTENSION / SYSTEM names no table, so the
 *      walk yielded nothing and the default-deny rule passed VACUOUSLY — while db.run routes
 *      create/alter/drop to the ADMIN connection precisely because "the guard already forced the
 *      target under the plugin's prefix".
 *   2. The guard blanks string literals so their contents can never be read as SQL structure.
 *      Postgres' *_to_xml family takes a SQL QUERY as a string argument and executes it, laundering a
 *      whole statement past both the table walk and the core-table denylist.
 *
 * These pin the fixes AND, just as importantly, the legitimate plugin DDL that must keep working —
 * a previous over-tightening of this guard broke 14 shipped plugins.
 */

const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app'); // preload (trusted context)
const { assertSqlAllowed } = require('../core/plugin-api');

const WRITE_VERBS = ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'];
const READ_VERBS = ['select', 'with'];
const PREFIX = 'wjp_evil_';

const allowed = (sql: string, verbs: string[]): boolean => {
    try { assertSqlAllowed(sql, verbs, PREFIX, 'evil'); return true; } catch { return false; }
};

// ── 1. DDL object class ───────────────────────────────────────────────────────────────────────────
// Every one of these was ALLOWED before the fix, and each runs on the ADMIN connection.

const FORBIDDEN_DDL = [
    'DROP SCHEMA public CASCADE',                        // deletes the entire site
    'DROP DATABASE wordjs',
    "CREATE ROLE wjp_evil_r SUPERUSER LOGIN PASSWORD 'x'",
    "ALTER SYSTEM SET archive_command = 'curl x'",
    'CREATE EXTENSION IF NOT EXISTS plpython3u',         // + LANGUAGE plpython3u = host RCE
    // The body is a single-quoted literal, so `FROM users` is invisible to the guard BY DESIGN; the
    // function is created by the pool user, which owns `users`, and SECURITY DEFINER runs it as them.
    "CREATE FUNCTION wjp_evil_f() RETURNS text AS 'SELECT user_pass FROM users LIMIT 1' LANGUAGE sql SECURITY DEFINER",
    "CREATE PROCEDURE wjp_evil_p() LANGUAGE sql AS 'SELECT 1'",
    'CREATE PUBLICATION p FOR ALL TABLES',
    'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO public',
    'DROP OWNED BY someone',
    'CREATE SERVER s FOREIGN DATA WRAPPER w',
    'CREATE TABLESPACE ts LOCATION /tmp',
];

for (const sql of FORBIDDEN_DDL) {
    test(`DDL object class is denied: ${sql.slice(0, 52)}`, () => {
        assert.strictEqual(allowed(sql, WRITE_VERBS), false,
            'a plugin may only create/alter/drop its own TABLE, INDEX, VIEW or TRIGGER');
    });
}

test('a rename cannot retarget an owned table onto a core table name', () => {
    // The PRE-rename token is owned, so the table walk accepts it and says nothing about where it lands.
    assert.strictEqual(allowed('ALTER TABLE wjp_evil_notes RENAME TO users', WRITE_VERBS), false);
    assert.strictEqual(allowed('ALTER TABLE wjp_evil_notes RENAME TO wjp_other_notes', WRITE_VERBS), false);
    assert.strictEqual(allowed('ALTER TABLE wjp_evil_notes RENAME TO wjp_evil_notes2', WRITE_VERBS), true,
        'renaming within the plugin\'s own prefix stays allowed');
});

// ── 2. SQL laundered through a string literal ─────────────────────────────────────────────────────

test('the xml-export family cannot smuggle a query through a literal', () => {
    for (const sql of [
        "SELECT query_to_xml('select user_login, user_pass from users', true, false, '')",
        "SELECT query_to_xml('select option_value from options', true, false, '')", // jwt_secret, SMTP creds
        "SELECT query_to_xmlschema('select 1', true, false, '')",
        "SELECT table_to_xml('users', true, false, '')",
        "SELECT schema_to_xml('public', true, false, '')",
        'SELECT database_to_xml(true, false, \'\')',                                 // the whole DB in one row
        "SELECT cursor_to_xml('c', 1, true, false, '')",
    ]) {
        assert.strictEqual(allowed(sql, READ_VERBS), false, `must be denied: ${sql}`);
    }
});

// ── 3. Legitimate plugin DDL must be UNAFFECTED ───────────────────────────────────────────────────
// The regression risk of tightening this guard: an earlier pass tokenized the `if` of
// `CREATE TABLE IF NOT EXISTS` and broke every shipped plugin. These are the shapes plugins use.

const LEGITIMATE = [
    'CREATE TABLE IF NOT EXISTS wjp_evil_notes (id INTEGER PRIMARY KEY, v TEXT)',
    'CREATE TEMPORARY TABLE wjp_evil_tmp (a TEXT)',
    'ALTER TABLE wjp_evil_notes ADD COLUMN extra VARCHAR(255)',
    'DROP TABLE IF EXISTS wjp_evil_notes',
    'CREATE UNIQUE INDEX wjp_evil_idx ON wjp_evil_notes (v)',
    'CREATE INDEX IF NOT EXISTS wjp_evil_i2 ON wjp_evil_notes (id)',
    'DROP INDEX wjp_evil_idx',
    'CREATE VIEW wjp_evil_v AS SELECT id FROM wjp_evil_notes',
    'DROP VIEW IF EXISTS wjp_evil_v',
];

for (const sql of LEGITIMATE) {
    test(`legitimate plugin DDL still passes: ${sql.slice(0, 52)}`, () => {
        assert.strictEqual(allowed(sql, WRITE_VERBS), true, 'must not have been tightened into a regression');
    });
}

test('ordinary scoped DML and reads are untouched', () => {
    assert.strictEqual(allowed('INSERT INTO wjp_evil_notes (v) VALUES (?)', WRITE_VERBS), true);
    assert.strictEqual(allowed('UPDATE wjp_evil_notes SET v = ? WHERE id = ?', WRITE_VERBS), true);
    assert.strictEqual(allowed('DELETE FROM wjp_evil_notes WHERE id = ?', WRITE_VERBS), true);
    assert.strictEqual(allowed('SELECT * FROM wjp_evil_notes WHERE v = ?', READ_VERBS), true);
});

// ── 4. A data-modifying CTE is a WRITE ────────────────────────────────────────────────────────────
// Callers classify by leading verb and `with` is on the read list, so these demanded only
// database:read and dispatched as reads — on Postgres the CTE executes regardless of whether the
// outer query reads its output, silently voiding a revoked write grant.

test('a data-modifying CTE is not accepted as a read', () => {
    for (const sql of [
        'WITH t AS (INSERT INTO wjp_evil_notes (v) VALUES (?)) SELECT 1',
        'WITH t AS (UPDATE wjp_evil_notes SET v = ? WHERE id = ?) SELECT 1',
        'WITH t AS (DELETE FROM wjp_evil_notes WHERE id = ?) SELECT 1',
    ]) {
        assert.strictEqual(allowed(sql, READ_VERBS), false, `must not pass as a read: ${sql}`);
        // And it does not simply move to the write branch either: `with` is not a WRITE verb, so the
        // pre-existing leading-verb allowlist already refuses it there. Net effect — a plugin cannot use
        // a data-modifying CTE at all, which is the right answer: it has db.run for writes.
        assert.strictEqual(allowed(sql, WRITE_VERBS), false, 'nor pass as a write (verb allowlist)');
    }
});

test('an ordinary read-only CTE is unaffected', () => {
    // The prefix rule denies the CTE ALIAS itself (pre-existing behaviour, unrelated to this rule), so
    // assert the classification directly: a plain CTE must not trip the data-modifying check.
    const readOnly = 'WITH wjp_evil_t AS (SELECT id FROM wjp_evil_notes) SELECT * FROM wjp_evil_t';
    assert.strictEqual(allowed(readOnly, READ_VERBS), true, 'a read-only CTE must still be a read');
});

test('the pre-existing controls still fail closed', () => {
    assert.strictEqual(allowed('DROP TABLE users', WRITE_VERBS), false);
    assert.strictEqual(allowed('SELECT user_pass FROM users', READ_VERBS), false);
    assert.strictEqual(allowed("COPY x FROM PROGRAM 'id'", WRITE_VERBS), false);
    assert.strictEqual(allowed("ATTACH DATABASE 'x' AS y", WRITE_VERBS), false);
    assert.strictEqual(allowed('SELECT * FROM wjp_other_notes', READ_VERBS), false);
});

// Docs-vs-code audit (2026-09-04): two places where the guard deviated from the documented rules.
test('the DDL object-class allowlist accepts BOTH spellings, TEMP and TEMPORARY', () => {
    // `(?:temp(?:orary)\s+)?` lacked the inner `?`, so only TEMPORARY matched and `CREATE TEMP TABLE` was
    // refused as "DDL on 'temp'" — while the sibling regexes and plugin-database.md accept both spellings.
    assert.strictEqual(allowed('CREATE TEMP TABLE wjp_evil_t (id INT)', WRITE_VERBS), true, 'TEMP must be accepted');
    assert.strictEqual(allowed('CREATE TEMPORARY TABLE wjp_evil_t (id INT)', WRITE_VERBS), true, 'TEMPORARY must be accepted');
    assert.strictEqual(allowed('CREATE TEMP VIEW wjp_evil_v AS SELECT id FROM wjp_evil_t', WRITE_VERBS), true, 'TEMP applies to views too');
});

test('REFERENCES is a table position: a foreign key into a core or foreign table is refused', () => {
    // Neither the table walker nor the protected-table check treated `REFERENCES` as introducing a table,
    // so a plugin table could constrain a core row (its delete then fails) and probe its existence —
    // the documented "out of bounds for any plugin" was not enforced.
    assert.strictEqual(allowed('CREATE TABLE wjp_evil_t (uid INT REFERENCES users(id))', WRITE_VERBS), false, 'inline FK to a core table');
    assert.strictEqual(allowed('CREATE TABLE wjp_evil_t (uid INT, FOREIGN KEY (uid) REFERENCES users(id))', WRITE_VERBS), false, 'table-constraint FK to a core table');
    assert.strictEqual(allowed('CREATE TABLE wjp_evil_t (oid INT REFERENCES wjp_other_t(id))', WRITE_VERBS), false, 'FK into another plugin\'s table (ownership rule)');
    assert.strictEqual(allowed('CREATE TABLE wjp_evil_t (oid INT REFERENCES wjp_evil_other(id))', WRITE_VERBS), true, 'FK into the plugin\'s OWN table stays allowed');
});
