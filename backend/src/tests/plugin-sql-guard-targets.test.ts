/**
 * PLUGIN SQL TEXT-GUARD — every TARGET a statement names, and comments.
 *
 * The table walker judges each name it finds in a table slot. These pin the slots it has to read beyond
 * a single name after FROM/JOIN/INTO/UPDATE/TABLE: target LISTS (`DROP TABLE a, b`, MySQL's multi-table
 * `UPDATE a, b` / `DELETE a, b FROM`), the table a TRIGGER is attached to, and the tables a CREATE TABLE
 * copies or extends (`LIKE`, `INHERITS (…)`, `PARTITION OF`). DDL may name one object per DROP and carry
 * no clause that hands the object to another identity or engine. Comments are refused in every spelling,
 * and the drivers' own comment scanners read comments the way their engine does.
 *
 * Each "refused" case is matched by legitimate plugin SQL that must keep passing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app'); // preload (trusted context)
const { assertSqlAllowed } = require('../core/plugin-api');

const WRITE = ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'];
const READ = ['select', 'with'];
const P = 'wjp_tgt_';
const SLUG = 'tgt';

const verdict = (sql: string, verbs: string[] = WRITE): string => {
    try { assertSqlAllowed(sql, verbs, P, SLUG); return 'allowed'; } catch (e: any) { return String(e && e.message); }
};

const REFUSED: string[] = [
    // Target lists: every name after the first used to go unjudged.
    `DROP TABLE ${P}a, users`,
    `DROP TABLE IF EXISTS ${P}a, wjp_other_orders`,
    `UPDATE ${P}a, users SET user_pass = ?`,
    `UPDATE ${P}a x, users u SET u.user_pass = x.v`,
    `UPDATE ${P}a AS x, wjp_other_orders o SET o.total = 0`,
    `DELETE users FROM ${P}a JOIN users ON 1 = 1`,
    `DELETE ${P}a, users FROM ${P}a JOIN users ON ${P}a.id = users.id`,
    // A trigger runs its body on every write to the table it is attached to.
    `CREATE TRIGGER ${P}trg AFTER INSERT ON users FOR EACH ROW UPDATE ${P}a SET n = n + 1`,
    `CREATE TRIGGER ${P}trg BEFORE UPDATE OF user_pass ON users FOR EACH ROW SET NEW.x = 1`,
    `DROP TRIGGER ${P}trg ON users`,
    `CREATE TRIGGER ${P}trg AFTER INSERT ON ${P}a FOR EACH ROW EXECUTE FUNCTION some_fn()`,
    // Names a CREATE TABLE takes from elsewhere.
    `CREATE TABLE ${P}copy (LIKE users INCLUDING ALL)`,
    `CREATE TABLE ${P}copy LIKE users`,
    `CREATE TABLE ${P}child () INHERITS (${P}a, users)`,
    `CREATE TABLE ${P}part PARTITION OF wjp_other_orders FOR VALUES IN (1)`,
    // One object per DROP, no CASCADE.
    `DROP TABLE ${P}a, ${P}b`,
    `DROP TABLE ${P}a CASCADE`,
    `DROP VIEW ${P}v CASCADE`,
    // Clauses that move an object out of the plugin's hands.
    `CREATE DEFINER = root VIEW ${P}v AS SELECT 1`,
    `ALTER TABLE ${P}a OWNER TO postgres`,
    `ALTER TABLE ${P}a SET SCHEMA other_site`,
    `CREATE TABLE ${P}m (id INT) ENGINE=MERGE UNION=(users)`,
    `CREATE TABLE ${P}f (id INT) ENGINE=FEDERATED CONNECTION='mysql://x/y/users'`,
    `CREATE TABLE ${P}d (id INT) DATA DIRECTORY = '/tmp'`,
    `CREATE TABLE ${P}t2 (id INT) TABLESPACE pg_default`,
    // Every rename spelling lands on an owned name.
    `ALTER TABLE ${P}a RENAME AS users`,
    `ALTER TABLE ${P}a RENAME users`,
    `ALTER TABLE ${P}a RENAME TO wjp_other_orders`,
    // View names, whether created, replaced or altered.
    `CREATE OR REPLACE VIEW wjp_other_v AS SELECT * FROM ${P}a`,
    `ALTER VIEW wjp_other_v AS SELECT * FROM ${P}a`,
    `ALTER INDEX ${P}i RENAME TO wjp_other_i`,
];

for (const sql of REFUSED) {
    test(`refused: ${sql}`, () => {
        assert.notStrictEqual(verdict(sql), 'allowed', 'must be refused');
    });
}

const COMMENTS: string[] = [
    // MySQL reads `#` as a line comment; the guard used to read it as an operator and the quote after it
    // as the start of a literal that swallowed the rest.
    `SELECT a FROM ${P}a # '\nUNION SELECT user_pass FROM users -- '`,
    // Postgres nests block comments; the guard used to close at the first `*/`.
    `SELECT a FROM ${P}a /* /* */ UNION SELECT 1 */`,
    // Postgres and SQLite read any `--` as a comment, MySQL only `--` followed by whitespace.
    `SELECT a FROM ${P}a WHERE b = 1 --'\nUNION SELECT user_pass FROM users --'`,
    `SELECT a FROM ${P}a -- trailing`,
];
for (const sql of COMMENTS) {
    test(`comments refused: ${JSON.stringify(sql).slice(0, 70)}`, () => {
        assert.match(verdict(sql, READ), /comments/);
    });
}

const ALLOWED: [string, string[]?][] = [
    [`CREATE TABLE IF NOT EXISTS ${P}a (id INTEGER PRIMARY KEY, color TEXT DEFAULT '#3b82f6', note TEXT DEFAULT '-- /* x */')`],
    [`CREATE TABLE IF NOT EXISTS ${P}c (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES ${P}a(id) ON DELETE CASCADE ON UPDATE CASCADE, code TEXT CHECK (code LIKE 'A%'))`],
    [`ALTER TABLE ${P}a ADD COLUMN x INTEGER DEFAULT 0, ADD COLUMN y TEXT`],
    [`ALTER TABLE ${P}a RENAME COLUMN x TO z`],
    [`ALTER TABLE ${P}a RENAME x TO z`],
    [`ALTER TABLE ${P}a RENAME TO ${P}a2`],
    [`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_a ON ${P}a (color)`],
    [`DROP INDEX IF EXISTS ${P}uidx_a`],
    [`DROP TABLE IF EXISTS ${P}a`],
    [`CREATE TABLE ${P}copy (LIKE ${P}a INCLUDING ALL)`],
    [`CREATE TRIGGER ${P}trg AFTER INSERT ON ${P}a FOR EACH ROW UPDATE ${P}c SET code = 'x'`],
    [`UPDATE ${P}a SET color = ? WHERE id = ?`],
    [`UPDATE IGNORE ${P}a SET color = ?`],
    [`UPDATE ${P}a x JOIN ${P}c y ON x.id = y.a_id SET x.color = y.code`],
    [`UPDATE ${P}a x, ${P}c y SET x.color = y.code WHERE x.id = y.a_id`],
    [`DELETE FROM ${P}a WHERE id = ?`],
    [`DELETE ${P}a FROM ${P}a JOIN ${P}c ON ${P}a.id = ${P}c.a_id`],
    [`INSERT INTO ${P}a (id, color) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET color = excluded.color`],
    [`INSERT INTO ${P}a (id, color) VALUES (?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color)`],
    [`SELECT id FROM ${P}a WHERE color LIKE ? FOR UPDATE`, READ],
];
for (const [sql, verbs] of ALLOWED) {
    test(`still allowed: ${sql.slice(0, 80)}`, () => {
        assert.strictEqual(verdict(sql, verbs || WRITE), 'allowed');
    });
}

test('the guard returns the owned names a statement touches (for the scoped DDL grant)', () => {
    const r = assertSqlAllowed(`ALTER TABLE ${P}a RENAME TO ${P}a2`, WRITE, P, SLUG);
    assert.deepStrictEqual([...r.owned].sort(), [`${P}a`, `${P}a2`]);
    const t = assertSqlAllowed(`CREATE TRIGGER ${P}trg AFTER INSERT ON ${P}a FOR EACH ROW UPDATE ${P}c SET code = 'x'`, WRITE, P, SLUG);
    assert.deepStrictEqual([...t.owned].sort(), [`${P}a`, `${P}c`]);
    const v = assertSqlAllowed(`CREATE VIEW ${P}v AS SELECT * FROM ${P}a`, WRITE, P, SLUG);
    assert.deepStrictEqual([...v.owned].sort(), [`${P}a`, `${P}v`]);
});

test('MySQL scanner: `#` opens a comment, `--` only with whitespace after it', () => {
    const { stripSqlComments } = require('../drivers/mysql-text-rule');
    assert.strictEqual(stripSqlComments('SELECT 1 # note\nFROM t'), 'SELECT 1 \nFROM t');
    assert.strictEqual(stripSqlComments('SELECT 2--1 FROM t'), 'SELECT 2--1 FROM t', '`--1` is arithmetic on MySQL');
    assert.strictEqual(stripSqlComments('SELECT 1 -- note\nFROM t'), 'SELECT 1 \nFROM t');
    assert.strictEqual(stripSqlComments("SELECT '#x' FROM t"), "SELECT '#x' FROM t", 'a # inside a literal is data');
});

test('Postgres scanner: block comments nest', () => {
    const { stripSqlComments } = require('../drivers/postgres');
    assert.strictEqual(stripSqlComments('a /* x /* y */ z */ b'), 'a  b');
    assert.strictEqual(stripSqlComments("a '/*' b"), "a '/*' b");
});

test('an installed theme claims its real table prefix (wjp_theme_<name>_) from boot', () => {
    const fs = require('fs');
    const path = require('path');
    const themes = fs.readdirSync(path.resolve(__dirname, '../../themes')).filter((n: string) => !n.startsWith('.') && !n.startsWith('zz-'));
    assert.ok(themes.length > 0, 'the repository ships themes');
    const name = String(themes[0]).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
    // A plugin whose prefix is the start of the theme's must not reach the theme's tables, even before the
    // theme itself has loaded and claimed them.
    assert.notStrictEqual(
        (() => { try { assertSqlAllowed(`SELECT * FROM wjp_theme_${name}_settings`, READ, 'wjp_theme_', 'theme'); return 'allowed'; } catch (e: any) { return e.message; } })(),
        'allowed');
    assert.strictEqual(require('../core/plugin-api').isTableOwnedBy(`wjp_theme_${name}_settings`, `theme:${themes[0]}`), true);
});
