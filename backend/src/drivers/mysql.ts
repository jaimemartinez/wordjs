/**
 * WordJS - MySQL / MariaDB Driver
 * Implements DatabaseDriverInterface using 'mysql2'.
 *
 * WordJS models, the core schema and plugins all speak ONE dialect: SQLite. The Postgres driver
 * only rewrites `?` placeholders; MySQL needs more, because the SQLite-style DDL/DML the rest of the
 * codebase emits is not all valid MySQL. This driver therefore carries a small **translation layer**
 * (translateSql) that rewrites, at the driver boundary, the handful of constructs that differ:
 *
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT`     → `INTEGER AUTO_INCREMENT PRIMARY KEY`
 *   - `TEXT`                                  → `LONGTEXT`, or `VARCHAR(255)` when the column takes
 *                                               part in a key (see drivers/mysql-text-rule.ts)
 *   - text-column `DEFAULT '' / CURRENT_TIMESTAMP` → parenthesised EXPRESSION default (MySQL ≥ 8.0.13
 *                                               is the only way TEXT/BLOB and CURRENT_TIMESTAMP-on-text
 *                                               columns may carry a default)
 *   - `INSERT OR IGNORE` → `INSERT IGNORE`,  `INSERT OR REPLACE` → `REPLACE`
 *   - `CREATE [UNIQUE] INDEX IF NOT EXISTS`   → `CREATE [UNIQUE] INDEX` (MySQL has no IF NOT EXISTS
 *                                               for indexes; the driver swallows the idempotent
 *                                               "duplicate key name" error on re-runs)
 *
 * Identifier quoting: the session runs with sql_mode=ANSI_QUOTES so `"col"` is an identifier exactly
 * like SQLite/Postgres (WordJS already single-quotes string literals to work on Postgres). Dates are
 * returned as strings (dateStrings) since WordJS stores timestamps as TEXT.
 */

const DatabaseDriverInterface = require('./interface');
const mysql = require('mysql2/promise');
// Static SqlString helpers re-exported by mysql2 — escape() / escapeId() are CodeQL-recognized
// SQL-injection barriers, used for the dynamic identifiers (user, table) in the role-isolation DDL below.
const mysqlSync = require('mysql2');
const config = require('../config/app');
// THE rule for TEXT → LONGTEXT / VARCHAR(255). Lives in its own dependency-free module so this driver
// and core/db-admin/migration.js consume ONE implementation and cannot drift apart again.
const {
    LONG_TEXT, KEY_TEXT, IDENT, isTableConstraint, columnNameOf, columnTypeToken, replaceColumnType,
    splitTopLevel, keyColumnsFromDefs, mysqlTypeForText, stripSqlComments,
    // The scanner and its projections. EVERY structural read of SQL text in this driver goes through
    // these — see the class note at the top of mysql-text-rule.ts. A `.split(',')` or a `/\bWORD\b/`
    // over a definition here is the defect that module exists to close.
    codeMask, codeMatch, replaceInCode, firstParenGroup
} = require('./mysql-text-rule');

/**
 * The session SQL mode EVERY connection runs with — the main pool AND every per-plugin scoped pool.
 *
 * IT IS ONE CONSTANT ON PURPOSE. It used to be written out twice, and the two copies drifted: the main
 * pool had `NO_BACKSLASH_ESCAPES` REMOVED (it is a data-corruption *and* an injection bug — node-mysql2
 * escapes string parameters with BACKSLASH escaping, so with that mode on the server treats `\` as a
 * literal, `\'` ends the string one char early, and a value like `O' OR 1=1 -- ` breaks out of its
 * literal), while the per-plugin pool created later in the isolation layer still turned it back ON.
 * An honest plugin doing `wordjs.db.get('… WHERE token = ?', [req.body.token])` was therefore
 * injectable by an anonymous visitor. Two declarations, two behaviours, one seam.
 *
 *   · ANSI_QUOTES          — `"col"` is an identifier, exactly like SQLite/Postgres, so the rest of the
 *                            codebase can keep writing one dialect.
 *   · STRICT_TRANS_TABLES  — a value that does not fit is an ERROR, not a warning. Without it MySQL
 *                            TRUNCATES an overlong value and reports success, which is how a backup
 *                            restore could destroy plugin content while counting the rows as imported.
 *   · NO_ENGINE_SUBSTITUTION — a missing storage engine fails loudly instead of silently changing.
 *
 * `NO_BACKSLASH_ESCAPES` must never appear here: mysql2's escaping assumes backslash escapes are ON,
 * which is the server default.
 */
const SESSION_SQL_MODE = 'ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
/**
 * TWO MORE SESSION SETTINGS, for the same reason the mode is here: a value whose meaning is decided
 * by a server-side default nobody sets is not a decision, it is a coincidence.
 *
 *   · time_zone='+00:00' — WordJS computes every timestamp in UTC (core/analytics-retention's cutoff,
 *     the models' ISO strings) but the column defaults are written by the SERVER as
 *     `CURRENT_TIMESTAMP`, which MySQL renders in the SESSION zone. With the server in, say, UTC-5
 *     the two clocks differ by five hours, so a retention cut in UTC deletes rows that are still
 *     inside the window. One clock, declared here, for every connection this driver opens.
 *   · lock_wait_timeout=60 — MySQL's default is 31 536 000 seconds, so a metadata lock that is never
 *     granted looks exactly like a slow query FOR A YEAR. Any DDL this driver issues (the CREATE
 *     INDEX widening, the legacy widening pass) must fail loudly instead of hanging.
 */
const SESSION_TIME_ZONE = '+00:00';
const SESSION_LOCK_WAIT_TIMEOUT = 60;
const SET_SESSION_SQL_MODE =
    `SET SESSION sql_mode='${SESSION_SQL_MODE}', time_zone='${SESSION_TIME_ZONE}', lock_wait_timeout=${SESSION_LOCK_WAIT_TIMEOUT}`;

// Allowlist for any identifier interpolated into isolation DDL (plugin DB user, table name). A caller
// only ever passes normalized wjp_<slug>_ names, but we re-validate at the driver boundary: reject
// anything outside [a-z0-9_], not starting with a digit, or longer than a MySQL identifier (64).
function safeIdent(name: string): string {
    const s = String(name);
    if (!/^[a-z_][a-z0-9_]*$/.test(s) || s.length > 64) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
    return s;
}

// ── Bare column names MySQL/MariaDB reserve ──────────────────────────────────────────────────────
// THE CLASS: a SQLite-dialect table may legitimately name a column with a word MySQL reserves, and
// MySQL then refuses the whole CREATE with ERROR 1064 — so the table is never created, the plugin
// activation fails, and (through core/db-admin/migration.js's unguarded recreateTableOnTarget) an
// engine switch aborts entirely. The session runs ANSI_QUOTES, so quoting makes the DDL parse and
// keeps the identifier the rest of the codebase writes.
//
// THE LIST USED TO BE SEVEN WORDS chosen by THIS module's parser ("the words that also start a
// table-level constraint clause"), which is a criterion about our own disambiguation, not about what
// the SERVER refuses: `order` — the most predictable column name a CMS plugin has — still produced an
// invalid CREATE. The membership question is MySQL's, so the answer is MySQL's list: the reserved
// words of MySQL 8.4 (dev.mysql.com/doc/refman/8.4/en/keywords.html) plus the ones MariaDB reserves
// and MySQL does not. NON-reserved keywords are deliberately absent (`text`, `value`, `type`,
// `status`, `comment`, `data`, `enum`, `year`, …): they are legal bare, and quoting them would
// change the DDL every existing install already has for no gain.
const RESERVED_BARE_COLUMN_NAMES = new Set([
    'accessible', 'add', 'all', 'alter', 'analyze', 'and', 'as', 'asc', 'asensitive', 'before',
    'between', 'bigint', 'binary', 'blob', 'both', 'by', 'call', 'cascade', 'case', 'change', 'char',
    'character', 'check', 'collate', 'column', 'condition', 'constraint', 'continue', 'convert',
    'create', 'cross', 'cube', 'cume_dist', 'current_date', 'current_time', 'current_timestamp',
    'current_user', 'cursor', 'database', 'databases', 'day_hour', 'day_microsecond', 'day_minute',
    'day_second', 'dec', 'decimal', 'declare', 'default', 'delayed', 'delete', 'dense_rank', 'desc',
    'describe', 'deterministic', 'distinct', 'distinctrow', 'div', 'double', 'drop', 'dual', 'each',
    'else', 'elseif', 'empty', 'enclosed', 'escaped', 'except', 'exists', 'exit', 'explain', 'false',
    'fetch', 'first_value', 'float', 'float4', 'float8', 'for', 'force', 'foreign', 'from',
    'fulltext', 'function', 'generated', 'get', 'grant', 'group', 'grouping', 'groups', 'having',
    'high_priority', 'hour_microsecond', 'hour_minute', 'hour_second', 'if', 'ignore', 'in', 'index',
    'infile', 'inner', 'inout', 'insensitive', 'insert', 'int', 'int1', 'int2', 'int3', 'int4',
    'int8', 'integer', 'intersect', 'interval', 'into', 'io_after_gtids', 'io_before_gtids', 'is',
    'iterate', 'join', 'json_table', 'key', 'keys', 'kill', 'lag', 'last_value', 'lateral', 'lead',
    'leading', 'leave', 'left', 'like', 'limit', 'linear', 'lines', 'load', 'localtime',
    'localtimestamp', 'lock', 'long', 'longblob', 'longtext', 'loop', 'low_priority',
    'master_bind', 'master_ssl_verify_server_cert', 'match', 'maxvalue', 'mediumblob', 'mediumint',
    'mediumtext', 'middleint', 'minute_microsecond', 'minute_second', 'mod', 'modifies', 'natural',
    'not', 'no_write_to_binlog', 'nth_value', 'ntile', 'null', 'numeric', 'of', 'on', 'optimize',
    'optimizer_costs', 'option', 'optionally', 'or', 'order', 'out', 'outer', 'outfile', 'over',
    'partition', 'percent_rank', 'precision', 'primary', 'procedure', 'purge', 'range', 'rank',
    'read', 'reads', 'read_write', 'real', 'recursive', 'references', 'regexp', 'release', 'rename',
    'repeat', 'replace', 'require', 'resignal', 'restrict', 'return', 'revoke', 'right', 'rlike',
    'row', 'rows', 'row_number', 'schema', 'schemas', 'second_microsecond', 'select', 'sensitive',
    'separator', 'set', 'show', 'signal', 'smallint', 'spatial', 'specific', 'sql', 'sqlexception',
    'sqlstate', 'sqlwarning', 'sql_big_result', 'sql_calc_found_rows', 'sql_small_result', 'ssl',
    'starting', 'stored', 'straight_join', 'system', 'table', 'terminated', 'then', 'tinyblob',
    'tinyint', 'tinytext', 'to', 'trailing', 'trigger', 'true', 'undo', 'union', 'unique', 'unlock',
    'unsigned', 'update', 'usage', 'use', 'using', 'utc_date', 'utc_time', 'utc_timestamp', 'values',
    'varbinary', 'varchar', 'varcharacter', 'varying', 'virtual', 'when', 'where', 'while', 'window',
    'with', 'write', 'xor', 'year_month', 'zerofill',
    // MariaDB-only reserved words (a WordJS install may run either engine).
    'current_role', 'delete_domain_id', 'do_domain_ids', 'general', 'ignore_domain_ids',
    'ignore_server_ids', 'master_heartbeat_period', 'offset', 'page_checksum', 'parse_vcol_expr',
    'position', 'ref_system_id', 'returning', 'slow', 'stats_auto_recalc', 'stats_persistent',
    'stats_sample_pages'
    // `offset` (MariaDB ≥ 10.6) and `delete_domain_id` (MariaDB ≥ 10.4) were missing while the comment
    // above claimed the MariaDB set was included — and a column called `offset` (a timezone offset, a
    // saved pagination cursor) is exactly the name a plugin reaches for.
    //
    // HONEST LIMIT OF THE GATE FOR THIS SET. Its COMPLETENESS cannot be derived from anything in this
    // repository: the authority is the two engines' published keyword lists, which live on the web and
    // are versioned by server release. A test can (and does) iterate this set and prove that every
    // member is quoted on all three surfaces a column name reaches — but no test here can tell you a
    // member is MISSING, and a test that iterates this same set to answer that question is answering
    // itself. Treat an ERROR 1064 on a bare column name as evidence and add the word.
]);

/**
 * Quote reserved bare column names inside a KEY-PART LIST — `UNIQUE (key)` → `UNIQUE ("key")`.
 *
 * THE TWIN of the column-definition quoting above, and it has to move with it: quoting `key` where
 * the column is DECLARED while leaving it bare where the same column is NAMED by a table-level
 * UNIQUE/KEY clause (or by a later CREATE INDEX) produces DDL that still fails to parse — the fix
 * would look applied and change nothing. Only a bare name is touched; an already-quoted one, an
 * expression key part and a prefix/ordering suffix are preserved.
 */
function quoteReservedKeyParts(list: string): string {
    // splitTopLevel, not split(','): a key part may carry a prefix length or an expression, and a
    // comma inside either is not a separator (see the class note in mysql-text-rule.ts).
    return splitTopLevel(String(list)).map((part: string) => part.replace(
        /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*(?:\(\s*\d+\s*\))?\s*(?:ASC|DESC)?\s*)$/i,
        (whole, lead, name, tail) => (RESERVED_BARE_COLUMN_NAMES.has(name.toLowerCase()) ? `${lead}"${name}"${tail}` : whole)
    )).join(',');
}

/** The head of a table-level clause whose first parenthesised group is a list of COLUMN NAMES. */
const KEY_CLAUSE_HEAD_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE(?:\s+(?:KEY|INDEX))?|KEY|INDEX)\b/i;

function translateColumnDef(def: string, keyColumns: Set<string>): string {
    // Table-level constraints (composite PK, UNIQUE(...), etc.) carry no type to translate — only
    // their key-part list may need the same reserved-name quoting the columns get below.
    if (isTableConstraint(def)) {
        if (!KEY_CLAUSE_HEAD_RE.test(codeMask(def))) return def;
        // The FIRST BALANCED group (not the first group with nothing nested inside it): a key part may
        // carry a prefix length, `KEY idx_slug (slug(191))`.
        const group = firstParenGroup(def);
        if (!group) return def;
        return `${def.slice(0, group.start)}(${quoteReservedKeyParts(group.inner)})${def.slice(group.end + 1)}`;
    }

    const name = columnNameOf(def);
    let d = def;

    // Auto-increment primary key (SQLite / Postgres forms → MySQL).
    //
    // BY POSITION, like the TEXT rewrite below and for the same reason: `d.replace(/\bSERIAL\b/i, …)`
    // matched the column NAME, so a perfectly ordinary `serial TEXT NOT NULL` (a serial number, a
    // licence key) reached MySQL as `INTEGER AUTO_INCREMENT LONGTEXT NOT NULL` — ERROR 1064, the
    // plugin's activation dead and, through migration.js's unguarded targetExec, the engine switch
    // aborted. The type token is the ONLY place a type may appear; the keyword tail is matched in the
    // CODE, so a DEFAULT that spells out 'PRIMARY KEY AUTOINCREMENT' is text.
    const autoIncType = columnTypeToken(d);
    if (autoIncType) {
        const token = autoIncType.token.toUpperCase();
        const tail = codeMask(d).slice(autoIncType.start + autoIncType.token.length);
        if ((token === 'INTEGER' || token === 'INT') && /^\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(tail)) {
            d = replaceColumnType(d, 'INTEGER AUTO_INCREMENT');
            d = replaceInCode(d, /\bPRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'PRIMARY KEY');
        } else if (token === 'SERIAL' || token === 'BIGSERIAL') {
            // `SERIAL PRIMARY KEY` becomes `INTEGER AUTO_INCREMENT PRIMARY KEY` by the same swap —
            // the PRIMARY KEY that follows is already in the right place.
            d = replaceColumnType(d, 'INTEGER AUTO_INCREMENT');
        }
    }

    // TEXT → LONGTEXT, or VARCHAR(255) when this column takes part in a key. The decision comes from
    // the DDL (drivers/mysql-text-rule.ts), NOT from a list of column names: the old name list could
    // never know a plugin's or an imported bundle's columns, so every one of them was capped at 255.
    //
    // The TYPE is read and replaced BY POSITION (the token after the column name), not by searching
    // for the first `\bTEXT\b`: a column literally named `text` — `text TEXT NOT NULL` — otherwise had
    // its NAME rewritten and reached MySQL as `LONGTEXT TEXT NOT NULL`.
    const typeToken = columnTypeToken(d);
    const wasBareText = !!typeToken && typeToken.token.toUpperCase() === 'TEXT';
    if (wasBareText) d = replaceColumnType(d, mysqlTypeForText(name, keyColumns));

    // MySQL rejects a literal default on TEXT/BLOB, and CURRENT_TIMESTAMP as a literal default on a
    // non-datetime column — both are legal only as parenthesised EXPRESSION defaults (≥ 8.0.13).
    // This now also covers a column that arrived ALREADY as *TEXT/BLOB (core/db-admin/migration.js
    // pre-rewrites TEXT→LONGTEXT for a migrated plugin table): it used to fall outside the `isTextCol`
    // branch, so a `LONGTEXT NOT NULL DEFAULT ''` reached MySQL as invalid DDL and the CREATE failed.
    // The type is read by position here too, so a column merely NAMED `text` no longer drags a
    // non-text column into the expression-default rewrite.
    const finalType = columnTypeToken(d);
    if (finalType && /^(?:(?:LONG|MEDIUM|TINY)?TEXT|(?:LONG|MEDIUM|TINY)?BLOB)$/i.test(finalType.token)) {
        // Matched in the CODE and replaced against the ORIGINAL: a default whose TEXT happens to read
        // `DEFAULT CURRENT_TIMESTAMP` is a value, not a clause.
        d = replaceInCode(d, /\bDEFAULT\s+CURRENT_TIMESTAMP\b/i, 'DEFAULT (CURRENT_TIMESTAMP)');
        d = replaceInCode(d, /\bDEFAULT\s+((?:_[A-Za-z0-9]+)?'(?:[^']|'')*')/i, 'DEFAULT ($1)'); // literal → (…)
    }

    // Finally, quote a bare column name MySQL reserves (`key`, `index`, …). Done LAST, so every step
    // above still sees the definition in the shape it was written.
    if (RESERVED_BARE_COLUMN_NAMES.has(name) && new RegExp(`^\\s*${name}\\b`, 'i').test(d)) {
        d = d.replace(new RegExp(`^(\\s*)${name}\\b`, 'i'), `$1"${name}"`);
    }
    return d;
}

/**
 * `replaceInCode`, but for EVERY occurrence.
 *
 * The shared helper rewrites the first match only, which is all a column definition ever needs. The DML
 * branch below rewrites keywords that legitimately occur more than once per statement (`excluded.col`
 * in an upsert SET list), so it needs the repeated form — and it must still read structure off the mask,
 * never off the raw text. Edits are applied back to front so an earlier index is never invalidated by a
 * later replacement, and every captured group is taken from the ORIGINAL by its own offsets (`d`), so a
 * group whose text lives next to a literal is never re-found by searching for its masked spelling.
 */
function replaceAllInCode(
    sql: string, re: RegExp, replacement: string | ((...args: any[]) => string),
): string {
    const s = String(sql);
    let flags = re.flags;
    if (!flags.includes('g')) flags += 'g';
    if (!flags.includes('d')) flags += 'd';
    const rx = new RegExp(re.source, flags);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const raw of codeMask(s).matchAll(rx)) {
        const m = raw as RegExpMatchArray & { indices?: Array<[number, number] | undefined> };
        if (m.index === undefined || !m.indices || m[0].length === 0) continue;
        const textAt = (pair: [number, number] | undefined) => (pair ? s.slice(pair[0], pair[1]) : undefined);
        const whole = textAt(m.indices[0] as [number, number]) as string;
        const groups = m.indices.slice(1).map(textAt);
        const out = typeof replacement === 'function'
            ? replacement(whole, ...groups)
            : replacement.replace(/\$(\d)/g, (_w: string, d: string) => String(groups[Number(d) - 1] ?? ''));
        edits.push({ start: m.index, end: m.index + m[0].length, text: out });
    }
    let out = s;
    for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i].start) + edits[i].text + out.slice(edits[i].end);
    return out;
}

/** Is there a match in the CODE of `sql`? (`codeMatch` returns MASKED text; this only asks yes/no.) */
function codeHas(sql: string, re: RegExp): boolean {
    return codeMatch(sql, re) !== null;
}

/**
 * WHAT THIS DRIVER REFUSES TO GUESS AT.
 *
 * The translation is a narrow contract: a documented subset of SQLite DDL, rewritten to MySQL. Anything
 * outside that subset used to be returned VERBATIM — a silent decline, which is the worst of the three
 * possible answers: on SQLite nothing happens, and on MySQL the untranslated text is `ERROR 1064`
 * ("INTEGER PRIMARY KEY AUTOINCREMENT") or `ERROR 1101` ("DEFAULT '' on a TEXT column") at a call site
 * that believed it had been handed valid MySQL. So the contract is narrow AND LOUD: a form this driver
 * does not model stops here, named, instead of arriving at the server as something nobody translated.
 */
function untranslatable(sql: string, why: string): Error {
    const err: any = new Error(
        `MySQL driver: this statement is outside the SQLite→MySQL translation contract (${why}). ` +
        `Rewrite it in the supported form or extend drivers/mysql.ts. Statement: ${String(sql).slice(0, 300)}`
    );
    err.code = 'WORDJS_SQL_UNTRANSLATABLE';
    return err;
}

// THE STATEMENT FORMS. Both are read off the MASK, never off the raw text: a leading comment used to
// hide the whole statement from the dispatcher (`/^\s*CREATE\s+TABLE/` over raw text), so the driver
// declined a statement that core/db-admin/migration.js — which strips comments before matching — did
// translate. Two consumers of "the one rule" that disagreed about which statements the rule applies to.
const CREATE_TABLE_DISPATCH_RE = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i;
/** Anchored superset of the above: what a statement must START with for the mask to be worth building. */
const CREATE_TABLE_MAYBE_RE = /^\s*(?:CREATE\b|--|\/\*)/i;
// Same identifier shape the shared rule parses (quoted / bracketed / bare), so a hyphenated table
// name like "wjp-orders" is not left untranslated here while migration.js translates it. A dotted
// `main.x` deliberately does NOT match: SQLite's schema prefix is not a MySQL database name.
const CREATE_TABLE_HEAD_RE = new RegExp(
    `^(\\s*CREATE\\s+)(?:(TEMP|TEMPORARY)\\s+)?(TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s*)$`, 'i'
);

/** Drop ONE trailing `;` — decided on the mask, so a statement ending in `… DEFAULT ';'` keeps its text. */
function dropTrailingSemicolon(sql: string): string {
    const mask = codeMask(sql);
    let i = mask.length - 1;
    while (i >= 0 && /\s/.test(mask[i])) i--; // MASK-SAFE: reads the mask, one character at a time
    if (i >= 0 && mask[i] === ';') return sql.slice(0, i) + sql.slice(i + 1);
    return sql;
}

/**
 * THE SECOND AXIS OF THIS CLASS: the FORM OF THE STATEMENT, not the content of its literals.
 *
 * The anchor used to be `\)(\s*)$` over the whole text, so anything that did not END at the closing
 * paren of the column list fell off the end of the match and was returned unchanged. Every one of these
 * was a silent decline reaching MySQL as raw SQLite: a trailing `;` (which core/plugin-api explicitly
 * PERMITS on plugin DDL), `WITHOUT ROWID`, `STRICT`, `CREATE TEMP TABLE`, `main.x`, and a leading
 * comment. Now the column list is found as the first BALANCED group (`firstParenGroup`, read off the
 * mask) and everything else is classified:
 *
 *   · no parenthesised group at all → `CREATE TABLE … AS SELECT`: no column list to rewrite, and valid
 *     MySQL as written. Returned unchanged, which is the honest answer for it.
 *   · `TEMP` → `TEMPORARY`: an exact equivalent, so it is translated rather than refused.
 *   · anything AFTER the column list (`WITHOUT ROWID`, `STRICT`, a second statement, a stray `;`) has no
 *     MySQL equivalent and changes storage or type semantics — refused by name, never dropped quietly.
 *   · a header shape this driver does not model (a dotted schema prefix, an unexpected keyword) — refused.
 */
function translateCreateTable(sql: string): string {
    const body = dropTrailingSemicolon(stripSqlComments(sql));
    const group = firstParenGroup(body);
    if (!group) return body; // no column list (CREATE TABLE … AS SELECT) — nothing here to translate
    const head = body.slice(0, group.start);
    const tail = body.slice(group.end + 1);
    // `head` is the text BEFORE the balanced column group, which firstParenGroup located on the mask,
    // and IDENT consumes a quoted table name whole — no literal can begin inside it.
    const hm = head.match(CREATE_TABLE_HEAD_RE); // MASK-SAFE: header segment delimited on the mask
    if (!hm) throw untranslatable(sql, `unsupported CREATE TABLE header "${head.trim()}"`);
    if (tail.trim() !== '') throw untranslatable(sql, `unsupported table options after the column list: "${tail.trim()}"`);
    const defs = splitTopLevel(group.inner).map((c: string) => c.trim()).filter(Boolean);
    // The key set is computed over the WHOLE column list BEFORE any column is translated: a column may
    // be named by a table-level PRIMARY KEY / UNIQUE / KEY clause that appears after it.
    const keyColumns = keyColumnsFromDefs(defs);
    const cols = defs.map((c: string) => translateColumnDef(c, keyColumns));
    const temporary = hm[2] ? 'TEMPORARY ' : '';
    return `${hm[1]}${temporary}${hm[3]}(\n  ${cols.join(',\n  ')}\n)`;
}

/**
 * Rewrite one SQLite-dialect statement to MySQL.
 *
 * THE CLASS, and why every `.replace()` below became a `replaceAllInCode`: this module decides the
 * STRUCTURE of SQL with string operations, and string operations do not see quoting. The CREATE TABLE
 * branch was put behind the scanner in an earlier round; the DML branch was not, and it was rewriting
 * INSIDE string literals — verified against the real driver:
 *
 *     INSERT … VALUES ('is returning customer')      →  INSERT … VALUES ('is        (statement truncated)
 *     UPDATE … SET c = 'we insert or replace nothing' →  … = 'we REPLACE nothing'   (STORED VALUE CHANGED)
 *     … VALUES ('excluded.foo is a word') ON CONFLICT…→  … 'VALUES(foo) is a word'  (STORED VALUE CHANGED)
 *
 * Core parameterises everything, so no core statement carried a live literal — but the plugin bridge
 * runs plugin SQL through this same function (`runAsUser`), and a plugin's `WHERE subject = 'Re:
 * returning your call'` was truncated on MySQL while working perfectly on SQLite. Structure now comes
 * off the mask in every branch, so a literal is text, always.
 */
function translateSql(sql: string): string {
    if (typeof sql !== 'string') return sql;
    // The dispatch is decided on the MASK so a leading comment cannot hide the statement from it. The
    // anchored pre-filter in front is a conservative SUPERSET — anything the mask could match must start,
    // after whitespace, with CREATE or with a comment opener — and exists only so that the O(n) mask is
    // not built for every INSERT and SELECT on the hot path.
    if (CREATE_TABLE_MAYBE_RE.test(sql) // MASK-SAFE: anchored superset; the decision below is the mask's
        && CREATE_TABLE_DISPATCH_RE.test(codeMask(sql))) return translateCreateTable(sql); // MASK-SAFE: on the mask
    let s = sql;
    // MySQL has no RETURNING; strip it (like the legacy sql.js driver does) and rely on insertId — which
    // is exactly the AUTO_INCREMENT key these `RETURNING id` / `RETURNING term_id` clauses return.
    s = replaceInCode(s, /\s+RETURNING\s+[\s\S]*$/i, '');
    s = replaceAllInCode(s, /\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');
    s = replaceAllInCode(s, /\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
    // MySQL has no IF NOT EXISTS for CREATE INDEX; strip it and treat the idempotent re-run error as ok.
    s = replaceAllInCode(s, /\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, (_m: string, u?: string) => `CREATE ${u || ''}INDEX`);
    // A MySQL functional-index key part needs an extra set of parens: (LOWER(x)) → ((LOWER(x))).
    // (A partial-index `... WHERE <expr>` has no MySQL equivalent; those statements are wrapped in
    // try/catch by the caller and simply skipped — app-layer logic enforces that uniqueness.)
    if (codeHas(s, /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i)) {
        s = replaceAllInCode(s, /\(\s*(LOWER\s*\([^()]*\))\s*\)/gi, '(($1))');
        // Third and last place a column name reaches MySQL: quote the reserved bare ones here too, or
        // a table whose CREATE we just made parseable still cannot be indexed (see quoteReservedKeyParts).
        // The SHAPE is checked on the mask; the key-part TEXT is sliced from the original by the balanced
        // group, because `codeMatch` hands back the MASKED spelling of every capture.
        if (codeHas(s, CREATE_INDEX_RE)) {
            const parts = firstParenGroup(s);
            if (parts) s = `${s.slice(0, parts.start + 1)}${quoteReservedKeyParts(parts.inner)}${s.slice(parts.end)}`;
        }
    }
    // Upsert: SQLite (≥3.24) and Postgres both accept `ON CONFLICT`, so core writes it unconditionally.
    // MySQL has no ON CONFLICT — map DO NOTHING → INSERT IGNORE, and DO UPDATE SET → ON DUPLICATE KEY
    // UPDATE (with `excluded.col` → `VALUES(col)`). Requires a UNIQUE/PRIMARY key on the conflict target,
    // which the schema provides (e.g. the options(option_name) unique index).
    if (codeHas(s, /\bON\s+CONFLICT\b/i)) {
        if (codeHas(s, /\bDO\s+NOTHING\b/i)) {
            s = replaceAllInCode(s, /\s*\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING\b/gi, '');
            s = replaceInCode(s, /^(\s*)INSERT\s+INTO\b/i, '$1INSERT IGNORE INTO');
        } else {
            s = replaceAllInCode(s, /\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\b/gi, 'ON DUPLICATE KEY UPDATE');
            s = replaceAllInCode(s, /\bexcluded\.(\w+)/gi, 'VALUES($1)');
        }
    }
    return s;
}

// ── Indexing a column the TEXT rule left unbounded ───────────────────────────────────────────────
// MySQL refuses a TEXT/BLOB column as an index key part without a key length (errno 1170,
// ER_BLOB_KEY_WITHOUT_LENGTH). Now that a TEXT column defaults to LONGTEXT unless the CREATE TABLE
// itself declares it a key (drivers/mysql-text-rule.ts), a column that only becomes a key in a LATER
// `CREATE INDEX` — which is exactly how the core schema (config/database.ts) and every schema
// migration declare their secondary indexes — would hit that error and the index would never exist.
//
// The driver therefore closes the loop where the missing information finally arrives. At CREATE INDEX
// time it looks up the key parts' real types and NARROWS each TEXT-family key column to VARCHAR(255) —
// the same type the rule would have picked had the key been declared inline. Two properties make that
// safe: (a) it is proved lossless first (no stored value longer than 255 characters), and (b) the new
// definition is MySQL's OWN `SHOW CREATE TABLE` line with only the type token swapped, so NOT NULL /
// DEFAULT (…) / CHARACTER SET / COLLATE cannot be dropped by a reconstruction mistake. When a stored
// value is already too long to narrow, the index falls back to a bounded prefix (`col(191)`) instead
// of failing: 191 is the classic utf8mb4 width that fits InnoDB's 767-byte index prefix on every row
// format, and a prefix index still enforces (more strictly) the uniqueness a UNIQUE index asks for.
const TEXT_FAMILY_TYPES = new Set([
    'tinytext', 'text', 'mediumtext', 'longtext',
    'tinyblob', 'blob', 'mediumblob', 'longblob'
]);
const KEY_PREFIX_CHARS = 191;
// Matches only a plain `CREATE [UNIQUE] INDEX <name> ON <table> (<key parts>)` — IF NOT EXISTS has
// already been stripped by translateSql. A partial index (`… WHERE <expr>`) does not match and is left
// alone: MySQL has no equivalent and the caller already skips those.
const CREATE_INDEX_RE =
    /^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:"[^"]*"|`[^`]*`|[A-Za-z0-9_]+)\s+ON\s+["`]?([A-Za-z0-9_]+)["`]?\s*)\(([\s\S]*)\)(\s*)$/i;

/**
 * The column list of a `SHOW CREATE TABLE` result: everything between the FIRST `(` and ITS matching
 * `)`. Not `lastIndexOf(')')` — the trailing table options can carry parentheses of their own
 * (partitioning clauses, versioned comments), and a body that swallowed them would split into
 * nonsense parts.
 */
function createTableBody(ddl: string): string | null {
    // ONE implementation of "find the matching parenthesis", in mysql-text-rule.ts. This used to be a
    // second, private scanner here — two scanners is how the quoting rules drift apart again.
    const group = firstParenGroup(String(ddl));
    return group ? group.inner : null;
}

/**
 * Where a statement is sent. The driver's DDL helpers take one instead of reaching for `this.pool`,
 * because "which connection" is a correctness question, not plumbing: an ALTER issued on a DIFFERENT
 * session than the transaction that holds the table's metadata lock waits for a lock that cannot be
 * released until it returns (see transaction() below).
 */
type SqlExecutor = (sql: string, params?: any[]) => Promise<any>;

// ── Which tables this driver may rewrite ─────────────────────────────────────────────────────────
// THE CLASS: a maintenance pass that decides its own scope from `table_schema = DATABASE()` claims
// every table in the database, and a WordJS database is very often SHARED (the default shape of
// cheap hosting: one MySQL schema, several applications). Anything that ALTERs must therefore prove
// the table is OURS first. Ownership is: a table of the core schema (config/database.ts), a plugin
// table (`wjp_` — the prefix core/plugin-api enforces), or a core-owned auxiliary (`wordjs_`).
// A table we do not recognise is LEFT ALONE, which is the safe direction: the only cost is a legacy
// column that stays capped, and that is visible, whereas rewriting a co-tenant's schema is not.
const CORE_TABLE_NAMES = new Set([
    'posts', 'post_meta', 'users', 'user_meta', 'comments', 'comment_meta',
    'terms', 'term_taxonomy', 'term_relationships', 'options', 'links', 'notifications',
    'schema_migrations', 'api_tokens', 'audit_log', 'webhooks', 'webhook_deliveries',
    'form_submissions', 'collab_docs', 'collab_members', 'collab_ops'
]);

function isWordjsOwnedTable(name: string): boolean {
    const t = String(name).toLowerCase();
    return CORE_TABLE_NAMES.has(t) || t.startsWith('wjp_') || t.startsWith('wordjs_');
}

/** The advisory lock that makes the legacy widening pass a single-node operation. */
const WIDEN_LOCK_NAME = 'wordjs_widen_legacy_text';

function isCreateIndex(sql: string): boolean {
    return typeof sql === 'string' && /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql);
}

// ── Prepared-statement parameter semantics (runAsUser) ───────────────────────────────────────────
// A plugin's parameters used to reach mysql2's `query()`, which INTERPOLATES them with the
// client-side escaper. They now reach `execute()`, which binds them over the binary protocol — the
// right call (an escaper that depends on a session flag is not a barrier), but mysql2 does NOT treat
// the two identically, and plugin-api.ts forwards a plugin's array verbatim:
//
//   · `undefined`: query() escapes it to NULL; execute() throws "Bind parameters must not contain
//     undefined". Every plugin that binds an absent optional field ([row.title, row.subtitle]) went
//     from inserting NULL to throwing.
//   · a NUMBER binds as DOUBLE, never as an integer — the classic mysql2 failure on `LIMIT ?`
//     ("Incorrect arguments to mysqld_stmt_execute"). `LIMIT ?` / `OFFSET ?` is in a dozen catalogue
//     plugins, so this alone would have broken their list views.
//
// Both are fixed HERE, at the boundary, on the SAME values that reach the sink: `undefined` becomes
// null, and a LIMIT/OFFSET placeholder is replaced by its own VALIDATED integer literal (never the
// raw parameter text — the value must satisfy Number.isInteger/^\d+$ or the statement is refused).
const LIMIT_OFFSET_TAIL_RE = /\b(?:LIMIT|OFFSET)\s*(?:\d+\s*,\s*)?$/i;

function integerForLimit(value: any, index: number): string {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return String(Number(value));
    if (typeof value === 'bigint' && value >= 0n) return value.toString();
    throw new Error(
        `MySQL: parameter ${index + 1} feeds a LIMIT/OFFSET and must be a non-negative integer, got ${JSON.stringify(value)}`
    );
}

/**
 * Rewrite a statement + parameter list into the form `execute()` accepts, preserving the semantics
 * `query()` gave plugins. String/identifier literals are walked over so a `?` inside one is not
 * mistaken for a placeholder. Exported for tests.
 */
function prepareExecuteParams(sql: string, params: any[]): { sql: string; params: any[] } {
    const s = String(sql);
    // Anything that is not a positional list (an object of named placeholders, a missing argument)
    // is handed on exactly as it arrived — this function reconciles POSITIONAL semantics and must not
    // quietly discard a shape it does not model.
    if (!Array.isArray(params)) return { sql: s, params };
    const list = params;
    let out = '', i = 0, index = 0;
    const bound: any[] = [];
    const n = s.length;
    while (i < n) {
        const c = s[i];
        if (c === "'" || c === '"' || c === '`') {         // copy a quoted literal/identifier verbatim
            const quote = c;
            out += c; i++;
            while (i < n) {
                out += s[i];
                if (s[i] === quote) { if (s[i + 1] === quote) { out += s[i + 1]; i += 2; continue; } i++; break; }
                if (quote === "'" && s[i] === '\\' && i + 1 < n) { out += s[i + 1]; i += 2; continue; }
                i++;
            }
            continue;
        }
        if (c === '?') {
            const value = list[index];
            // The prefix tested is the OUTPUT built so far, so `LIMIT ?, ?` works: the first
            // placeholder has already become a literal by the time the second is examined.
            if (LIMIT_OFFSET_TAIL_RE.test(out)) out += integerForLimit(value, index);
            else { out += '?'; bound.push(value === undefined ? null : value); }
            index++; i++;
            continue;
        }
        out += c; i++;
    }
    // Extra parameters (more supplied than placeholders) are handed on untouched so mysql2 still
    // reports the arity mismatch the caller needs to see, minus the undefined it cannot encode.
    for (let k = index; k < list.length; k++) bound.push(list[k] === undefined ? null : list[k]);
    return { sql: out, params: bound };
}

// True when an error is a benign idempotent re-run we can ignore (e.g. re-creating an index that the
// boot path creates every start, since we stripped IF NOT EXISTS).
function isBenignDup(err: any, sql: string): boolean {
    if (!err) return false;
    if ((err.errno === 1061 || err.code === 'ER_DUP_KEYNAME') && /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql)) return true;
    return false;
}

class MysqlDriver extends DatabaseDriverInterface {
    pool: any;
    config: any;
    // Per-plugin low-privilege pools, keyed by DB user name (see runAsUser / getScopedPool below).
    scopedPools: Map<string, any> = new Map();

    constructor() {
        super();
        this.pool = null;
        this.config = null;
    }

    async init(options: any = {}) {
        if (options.dbConfig) this.config = options.dbConfig;
    }

    async connect() {
        const dbConfig = this.config || config.db;
        console.log(`🔌 MySQL: Connecting to ${dbConfig.host}:${dbConfig.port || 3306}/${dbConfig.name}...`);
        try {
            this.pool = mysql.createPool({
                host: dbConfig.host,
                port: dbConfig.port || 3306,
                user: dbConfig.user,
                password: dbConfig.password,
                database: dbConfig.name,
                waitForConnections: true,
                connectionLimit: dbConfig.connectionLimit || 10,
                multipleStatements: true, // migrations/exec may ship several statements at once
                charset: 'utf8mb4_unicode_ci',
                dateStrings: true,        // WordJS stores/reads timestamps as TEXT, not JS Date
                ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined
            });

            // Every physical connection speaks the same dialect as SQLite/Postgres. The mode itself is
            // SESSION_SQL_MODE — ONE constant, shared with getScopedPool() (see its comment for why
            // NO_BACKSLASH_ESCAPES must never come back and why STRICT_TRANS_TABLES is on).
            // NOTE: the pool's 'connection' event hands back the RAW (callback-style) connection, not a
            // promise wrapper — so use a callback here, never .then/.catch (that throws "not a promise").
            this.pool.on('connection', (conn: any) => {
                conn.query(SET_SESSION_SQL_MODE, () => { });
            });

            const conn = await this.pool.getConnection();
            await conn.query(SET_SESSION_SQL_MODE);
            const [rows] = await conn.query('SELECT VERSION() AS v');
            conn.release();
            console.log('✅ MySQL: Connected successfully to', rows[0].v);
            // A database created by the OLD name-list rule still holds VARCHAR(255) columns that this
            // session's STRICT mode would now REJECT instead of truncating. Widen them once, here,
            // where the schema is finally reachable. Never fatal — it warns and boots.
            // It is still AWAITED on purpose: rebuilding a table while the application is already
            // serving is worse than a slower boot, and after the first upgrade the pass costs exactly
            // one information_schema query (no candidates ⇒ no locks, no ALTERs, no SHOW CREATE).
            // Its scope, cost and concurrency bounds are documented on the method itself.
            try { await this.widenLegacyCappedTextColumns(); }
            catch (e: any) { console.warn('⚠️  MySQL: legacy TEXT widening pass failed:', e && e.message); }
        } catch (err: any) {
            console.error('❌ MySQL: Connection failed:', err.message);
            throw err;
        }
    }

    async get(sql: string, params: any[] = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql), params);
            return Array.isArray(rows) ? rows[0] : undefined;
        } catch (err: any) {
            console.error('❌ MySQL Query Error (get):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async all(sql: string, params: any[] = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql), params);
            return Array.isArray(rows) ? rows : [];
        } catch (err: any) {
            console.error('❌ MySQL Query Error (all):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    /**
     * Narrow ONE TEXT-family column to VARCHAR(255) so it can carry an index key, or report that it
     * cannot. Returns false (never throws) when the column already holds a value that would not fit,
     * when SHOW CREATE TABLE gives nothing recognizable, or when the ALTER is refused — the caller
     * then falls back to a bounded key prefix.
     */
    async narrowTextColumnForKey(table: string, column: string, exec?: SqlExecutor): Promise<boolean> {
        const qt = mysqlSync.escapeId(String(table));
        const qc = mysqlSync.escapeId(String(column));
        const alterOn: SqlExecutor = exec || ((sql: string, params?: any[]) => this.pool.query(sql, params));
        try {
            // LOSSLESSNESS FIRST. Shortening a column that already holds longer content would be
            // exactly the silent truncation this whole change exists to remove.
            const [tooLong] = await this.pool.query(`SELECT 1 AS x FROM ${qt} WHERE CHAR_LENGTH(${qc}) > 255 LIMIT 1`);
            if (Array.isArray(tooLong) && tooLong.length > 0) return false;

            const [ddlRows] = await this.pool.query(`SHOW CREATE TABLE ${qt}`);
            const row = Array.isArray(ddlRows) ? ddlRows[0] : null;
            const ddl = row ? String(row['Create Table'] || '') : '';
            // ANSI_QUOTES makes SHOW CREATE TABLE quote identifiers with `"`; without it, a backtick.
            const esc = String(column).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const lineRe = new RegExp(`^\\s*["\`]${esc}["\`]\\s+\\S`, 'i');
            const line = ddl.split('\n').find((l: string) => lineRe.test(l));
            if (!line) return false;
            const def = line.trim().replace(/,\s*$/, '');
            // The TYPE token by position (the shared rule), not `\S+` after a `["`]\w+["`]` prefix:
            // that pattern cannot see a quoted name with a space in it and, on a definition it does
            // not recognise, silently changed nothing. Any length parameter goes WITH the old type.
            const type = columnTypeToken(def);
            if (!type) return false;
            const afterType = def.slice(type.start + type.token.length);
            const narrowed = def.slice(0, type.start) + KEY_TEXT + afterType.replace(/^\s*\(\s*\d+\s*\)/, '');
            if (narrowed === def) return false;
            await alterOn(`ALTER TABLE ${qt} MODIFY COLUMN ${narrowed}`);
            return true;
        } catch (err: any) {
            console.warn(`⚠️  MySQL: could not narrow ${table}.${column} for indexing:`, err && err.message);
            return false;
        }
    }

    /**
     * Make a `CREATE INDEX` legal when one of its key parts is an unbounded TEXT-family column.
     * Returns the statement unchanged when nothing needs it (the common case after the first boot, and
     * every index over non-text columns). See the TEXT_FAMILY_TYPES block above for the reasoning.
     */
    async ensureIndexableKeyParts(sql: string, exec?: SqlExecutor): Promise<string> {
        const m = String(sql).match(CREATE_INDEX_RE);
        if (!m) return sql;
        const table = m[2];
        let columnRows: any[];
        try {
            const [rows] = await this.pool.query(
                'SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
                [table]
            );
            columnRows = Array.isArray(rows) ? rows : [];
        } catch {
            return sql; // can't introspect (no such table yet) — let MySQL report the real error
        }
        const typeByColumn = new Map<string, string>();
        for (const r of columnRows) {
            const name = String(r.c ?? r.COLUMN_NAME ?? r.column_name ?? '').toLowerCase();
            const type = String(r.t ?? r.DATA_TYPE ?? r.data_type ?? '').toLowerCase();
            if (name) typeByColumn.set(name, type);
        }
        // Every identifier token in the key-part list that is really a TEXT-family column of this table.
        // Tokenising (rather than reading bare column names) also catches a FUNCTIONAL key part such as
        // `LOWER(user_email)`, which MySQL rejects outright over a TEXT column and which takes no prefix.
        const touched = new Set<string>();
        for (const token of String(m[3]).match(/[A-Za-z0-9_]+/g) || []) {
            const key = token.toLowerCase();
            if (typeByColumn.has(key) && TEXT_FAMILY_TYPES.has(typeByColumn.get(key) as string)) touched.add(key);
        }
        if (touched.size === 0) return sql;

        const stillWide = new Set<string>();
        for (const column of touched) {
            if (!(await this.narrowTextColumnForKey(table, column, exec))) stillWide.add(column);
        }
        if (stillWide.size === 0) return sql;

        const parts = splitTopLevel(m[3]).map((p: string) => p.trim()).filter(Boolean);
        const rebuilt = parts.map((p: string) => {
            // Only a BARE column key part can take a prefix length; an expression key part is left as
            // written (MySQL will refuse it, and the caller that wrote it already tolerates that).
            if (!/^["`]?\w+["`]?$/.test(p)) return p;
            return stillWide.has(columnNameOf(p)) ? `${p}(${KEY_PREFIX_CHARS})` : p;
        });
        return `${m[1]}(${rebuilt.join(', ')})${m[4] || ''}`;
    }

    /**
     * The ONE preparation every statement gets before it reaches a connection: dialect translation,
     * plus the CREATE INDEX widening when the statement is one. `run`, `exec` and BOTH of
     * transaction()'s equivalents consume this — they used to be two paths with two rules, so a
     * `CREATE INDEX` issued INSIDE a transaction skipped ensureIndexableKeyParts and would have died
     * with errno 1170 on the very columns the TEXT rule now leaves unbounded.
     */
    async prepareStatement(sql: string, exec?: SqlExecutor): Promise<string> {
        const translated = translateSql(sql);
        return isCreateIndex(translated) ? await this.ensureIndexableKeyParts(translated, exec) : translated;
    }

    /**
     * UPGRADE PATH for a database created by the OLD rule — the half of the TEXT fix that a new
     * default alone cannot deliver.
     *
     * The rule above only fires inside `CREATE TABLE`, and on an existing install every
     * `CREATE TABLE IF NOT EXISTS` is a no-op: the columns the name-list rule capped at VARCHAR(255)
     * stay capped. What DID change for that install is the session mode — with STRICT_TRANS_TABLES an
     * overlong value stops being truncated with a warning and becomes ERROR 1406. So without this
     * pass an upgrade delivers the hardening WITHOUT the widening: a mail body over 255 characters
     * goes from being mutilated to being rejected. That is not the fix, that is half of it.
     *
     * WHAT IT WIDENS: every `VARCHAR(255)` column of this schema that takes part in NO key. WordJS,
     * its core schema and its plugins all write the SQLite dialect (`TEXT`), so a VARCHAR(255) in a
     * WordJS database is the fingerprint of the old translation; a key column keeps its bound because
     * MySQL cannot index an unbounded type (the same reason the rule bounds it at CREATE time). The
     * key set is read TWICE from two independent sources — information_schema.statistics prunes the
     * candidates in SQL, and keyColumnsFromDefs re-reads the table's real `SHOW CREATE TABLE` — so a
     * column that is a key part in either view is left alone.
     *
     * Widening is lossless by construction (nothing stored can fail to fit a longer type), idempotent
     * (a widened column is no longer VARCHAR(255), so it is not a candidate next boot) and never
     * fatal: a failure warns and the boot continues.
     *
     * ── WHAT IT IS NOT ALLOWED TO COST (the three bounds the first version was missing) ───────────
     * A VARCHAR→LONGTEXT change is ALGORITHM=COPY: InnoDB rebuilds the whole table under an exclusive
     * metadata lock. Three things therefore bound it, and each closes a DIFFERENT unbounded axis:
     *
     *   1. SCOPE — only tables WordJS owns (isWordjsOwnedTable). The scan used to be the whole
     *      schema, so on the shared-database hosting shape it rebuilt a co-tenant application's
     *      tables at boot.
     *   2. COST — ONE `ALTER TABLE … MODIFY COLUMN a …, MODIFY COLUMN b …` per TABLE, not per column.
     *      A legacy `posts` has eight non-key candidates: that was eight full rebuilds of the same
     *      table, back to back, on the first boot after upgrading.
     *   3. CONCURRENCY — a MySQL advisory lock (GET_LOCK) held on ONE pinned connection for the whole
     *      pass. Every node of a multi-node deployment boots at once and used to fire the same ALTERs
     *      simultaneously; now the others see the lock is taken and skip the pass entirely (the
     *      leader's work is what they would have done, and it is idempotent). The lock lives in the
     *      server, not in the application, precisely because this runs before the app layer exists.
     *
     * WHAT IT DOES NOT DECIDE: whether a short-domain core column (a date, a status) should be
     * LONGTEXT at all. It converges an upgraded install to EXACTLY the schema a fresh MySQL install
     * gets from the current rule; if that type is wrong for sorting, it is wrong on fresh installs
     * too, and the place to fix it is the RULE (mysql-text-rule.ts), not a second name list here.
     */
    async widenLegacyCappedTextColumns(): Promise<string[]> {
        const widened: string[] = [];
        // ONE pinned connection for the pass: an advisory lock is released when its OWN session ends,
        // so it must not travel around the pool. A pool that cannot hand one out (or a server too old
        // for GET_LOCK) is not a reason to skip the widening — only a reason not to claim leadership.
        let lockConn: any;
        try { lockConn = await this.pool.getConnection(); } catch { lockConn = null; }
        if (lockConn) {
            try {
                const [rows] = await lockConn.query(`SELECT GET_LOCK(${mysqlSync.escape(WIDEN_LOCK_NAME)}, 0) AS ok`);
                const got = Array.isArray(rows) && rows[0] && Number(rows[0].ok ?? rows[0].OK) === 1;
                if (!got) {
                    console.log('   ↷ MySQL: another node is running the legacy TEXT widening pass — skipping.');
                    try { lockConn.release(); } catch { /* pool may already be gone */ }
                    return widened;
                }
            } catch { /* no advisory lock available — continue unguarded rather than skip the fix */ }
        }
        try {
            return await this.widenLegacyCappedTextColumnsLocked(widened);
        } finally {
            if (lockConn) {
                try { await lockConn.query(`SELECT RELEASE_LOCK(${mysqlSync.escape(WIDEN_LOCK_NAME)})`); } catch { /* released with the session anyway */ }
                try { lockConn.release(); } catch { /* pool may already be gone */ }
            }
        }
    }

    /** The pass itself, once this node has established that it is the one running it. */
    private async widenLegacyCappedTextColumnsLocked(widened: string[]): Promise<string[]> {
        let candidates: any[];
        try {
            const [rows] = await this.pool.query(
                'SELECT col.table_name AS t, col.column_name AS c ' +
                'FROM information_schema.columns col ' +
                'LEFT JOIN information_schema.statistics idx ' +
                '  ON idx.table_schema = col.table_schema AND idx.table_name = col.table_name ' +
                ' AND idx.column_name = col.column_name ' +
                "WHERE col.table_schema = DATABASE() AND col.data_type = 'varchar' " +
                '  AND col.character_maximum_length = 255 AND idx.column_name IS NULL'
            );
            candidates = Array.isArray(rows) ? rows : [];
        } catch (err: any) {
            console.warn('⚠️  MySQL: could not scan for legacy VARCHAR(255) text columns:', err && err.message);
            return widened;
        }
        if (candidates.length === 0) return widened;

        const byTable = new Map<string, string[]>();
        const foreign = new Set<string>();
        for (const r of candidates) {
            const t = String(r.t ?? r.TABLE_NAME ?? r.table_name ?? '');
            const c = String(r.c ?? r.COLUMN_NAME ?? r.column_name ?? '');
            if (!t || !c) continue;
            // SCOPE BOUND: never touch a table this application did not create. The schema may be
            // shared with another application, and its columns are none of our business.
            if (!isWordjsOwnedTable(t)) { foreign.add(t); continue; }
            if (!byTable.has(t)) byTable.set(t, []);
            (byTable.get(t) as string[]).push(c);
        }
        if (foreign.size) {
            console.log(`   ↷ MySQL: ${foreign.size} table(s) in this schema are not WordJS's and were not touched: ${[...foreign].slice(0, 10).join(', ')}${foreign.size > 10 ? ', …' : ''}`);
        }

        for (const [table, columns] of byTable) {
            const qt = mysqlSync.escapeId(table);
            let ddl: string;
            try {
                const [ddlRows] = await this.pool.query(`SHOW CREATE TABLE ${qt}`);
                const row = Array.isArray(ddlRows) ? ddlRows[0] : null;
                ddl = row ? String(row['Create Table'] || row['Create View'] || '') : '';
            } catch (err: any) {
                console.warn(`⚠️  MySQL: could not read the definition of ${table}:`, err && err.message);
                continue;
            }
            const body = createTableBody(ddl);
            if (!body) continue;
            const defs = splitTopLevel(stripSqlComments(body)).map((d: string) => d.trim()).filter(Boolean);
            const keyColumns = keyColumnsFromDefs(defs);
            const clauses: string[] = [];
            const named: string[] = [];
            for (const column of columns) {
                if (keyColumns.has(column.toLowerCase())) continue;   // second, independent key check
                const def = defs.find((d: string) => !isTableConstraint(d) && columnNameOf(d) === column.toLowerCase());
                if (!def) continue;
                const type = columnTypeToken(def);
                if (!type || type.token.toLowerCase() !== 'varchar') continue;
                // MySQL's OWN line with only the type swapped, so NOT NULL / COLLATE / DEFAULT cannot be
                // lost to a reconstruction mistake. `(255)` sits right after the type token; a literal
                // default is legal on LONGTEXT only as a parenthesised expression. Both DEFAULT
                // rewrites are matched in the CODE, so a default whose TEXT reads like a clause is
                // left alone (see the class note in mysql-text-rule.ts).
                let widenedDef = def.slice(0, type.start) + LONG_TEXT
                    + def.slice(type.start + type.token.length).replace(/^\s*\(\s*255\s*\)/, '');
                widenedDef = replaceInCode(widenedDef, /\bDEFAULT\s+CURRENT_TIMESTAMP\b/i, 'DEFAULT (CURRENT_TIMESTAMP)');
                widenedDef = replaceInCode(widenedDef, /\bDEFAULT\s+((?:_[A-Za-z0-9]+)?'(?:[^']|'')*')/i, 'DEFAULT ($1)');
                widenedDef = widenedDef.replace(/,\s*$/, '');
                clauses.push(`MODIFY COLUMN ${widenedDef}`);
                named.push(`${table}.${column}`);
            }
            if (clauses.length === 0) continue;
            // COST BOUND: ONE statement per table ⇒ ONE table rebuild, however many columns it widens.
            try {
                await this.pool.query(`ALTER TABLE ${qt} ${clauses.join(', ')}`);
                widened.push(...named);
            } catch (err: any) {
                console.warn(`⚠️  MySQL: could not widen ${named.length} legacy column(s) of ${table} to LONGTEXT:`, err && err.message);
            }
        }
        if (widened.length) {
            console.log(`   ✓ MySQL: widened ${widened.length} legacy VARCHAR(255) column(s) to LONGTEXT: ${widened.join(', ')}`);
        }
        return widened;
    }

    async run(sql: string, params: any[] = []) {
        const translated = await this.prepareStatement(sql);
        try {
            const [result] = await this.pool.query(translated, params);
            // mysql2 returns a ResultSetHeader for writes: insertId is the AUTO_INCREMENT value (0 for a
            // table without one — matching better-sqlite3/Postgres lastID semantics), affectedRows the
            // row count. RETURNING is not needed.
            return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
        } catch (err: any) {
            if (isBenignDup(err, translated)) return { lastID: 0, changes: 0 };
            console.error('❌ MySQL Query Error (run):', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    async exec(sql: string) {
        const translated = await this.prepareStatement(sql);
        try {
            await this.pool.query(translated);
        } catch (err: any) {
            if (isBenignDup(err, translated)) return;
            console.error('❌ MySQL Exec Error:', err.message, '\nSQL:', sql);
            throw err;
        }
    }

    /**
     * Atomic transaction on a single pinned connection: BEGIN → fn(tx) → COMMIT, ROLLBACK on throw.
     * tx.get/all/run/exec use the SAME translation as the top-level methods so callers write identical
     * SQLite-style SQL inside and outside a transaction.
     */
    async transaction(fn: any) {
        const conn = await this.pool.getConnection();
        const tx = {
            get: async (sql: string, params: any[] = []) => {
                const [rows] = await conn.query(translateSql(sql), params);
                return Array.isArray(rows) ? rows[0] : undefined;
            },
            all: async (sql: string, params: any[] = []) => {
                const [rows] = await conn.query(translateSql(sql), params);
                return Array.isArray(rows) ? rows : [];
            },
            // run/exec go through the SAME prepareStatement as the top-level methods — including the
            // CREATE INDEX widening.
            //
            // THE ALTER RUNS ON *THIS* CONNECTION, and that is not a detail. When it went to the pool
            // it was a DIFFERENT session: if the open transaction had already touched the table,
            // InnoDB held the shared metadata lock until COMMIT, so the pool's ALTER waited for the
            // MDL while the transaction waited for the ALTER's await — a deadlock MySQL does not
            // detect (metadata locks are not the InnoDB deadlock detector's business) and, with the
            // default lock_wait_timeout of a year, an indefinite hang rather than an error. On the
            // pinned connection there is nothing to wait for; the DDL implicit-commits, which it did
            // on the pool as well, so an index created inside a transaction was never part of its
            // atomic unit either way. (The introspection stays on the pool: SHOW CREATE TABLE and a
            // non-locking SELECT take a SHARED MDL, which is compatible with the transaction's.)
            run: async (sql: string, params: any[] = []) => {
                const translated = await this.prepareStatement(sql, (s: string, p?: any[]) => conn.query(s, p));
                try {
                    const [result] = await conn.query(translated, params);
                    return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
                } catch (err: any) {
                    if (isBenignDup(err, translated)) return { lastID: 0, changes: 0 };
                    throw err;
                }
            },
            exec: async (sql: string) => {
                const translated = await this.prepareStatement(sql, (s: string, p?: any[]) => conn.query(s, p));
                try { await conn.query(translated); }
                catch (err: any) { if (!isBenignDup(err, translated)) throw err; }
            }
        };
        try {
            await conn.beginTransaction();
            const result = await fn(tx);
            await conn.commit();
            return result;
        } catch (err: any) {
            try { await conn.rollback(); }
            catch (rbErr: any) { console.error('❌ MySQL ROLLBACK failed:', rbErr && rbErr.message); }
            throw err;
        } finally {
            conn.release();
        }
    }

    async getTables() {
        try {
            const [rows] = await this.pool.query(
                'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
            );
            return rows.map((r: any) => r.name || r.NAME || r.table_name);
        } catch (err: any) {
            console.error('❌ MySQL getTables Error:', err.message);
            throw err;
        }
    }

    async getTableSchema(tableName: string) {
        try {
            const [rows] = await this.pool.query(
                'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
                [tableName]
            );
            const columns = rows.map((col: any) => {
                let type = String(col.column_name ? col.data_type : col.DATA_TYPE || '').toUpperCase();
                if (type.includes('CHAR') || type.includes('TEXT')) type = 'TEXT';
                else if (type.includes('INT')) type = 'INTEGER';
                else if (type.includes('DATETIME') || type.includes('TIMESTAMP')) type = 'DATETIME';
                else if (type.includes('JSON')) type = 'TEXT';
                const cname = col.column_name || col.COLUMN_NAME;
                let def = `${cname} ${type}`;
                if ((col.is_nullable || col.IS_NULLABLE) === 'NO') def += ' NOT NULL';
                return def;
            });
            return { sql: null, columns };
        } catch (err: any) {
            console.error('❌ MySQL getTableSchema Error:', err.message);
            throw err;
        }
    }

    // ── Per-plugin DB user isolation (defense-in-depth BELOW the SQL text-guard) ──────────────────
    // MySQL has no usable SET ROLE equivalent for this: SET ROLE only *activates already-granted roles*
    // for the connected user and can't strip the admin user's DIRECT privileges, so a role switch on the
    // admin connection would still see every table. True isolation therefore needs a SEPARATE login user
    // per plugin, GRANTed only its own wjp_<slug>_ tables, with the plugin's DML/SELECT run on a pool
    // authenticated AS that user — so the DATABASE denies any cross-plugin/core access. Requires the pool
    // user to hold CREATE USER + GRANT OPTION; callers fall back to the text-guard alone if it doesn't.

    /** CREATE (or reset the password of) a plugin's low-privilege login user. Idempotent. */
    async ensurePluginUser(user: string, password: string): Promise<void> {
        const uLit = mysqlSync.escape(safeIdent(user));
        const pLit = mysqlSync.escape(String(password));
        await this.pool.query(`CREATE USER IF NOT EXISTS ${uLit}@'%' IDENTIFIED BY ${pLit}`);
        // Always (re)set the password so a fresh process boot owns the credential its scoped pool will use.
        await this.pool.query(`ALTER USER ${uLit}@'%' IDENTIFIED BY ${pLit}`);
    }

    /** GRANT CRUD on ONE existing table to a plugin user. */
    async grantPluginTableToUser(user: string, table: string): Promise<void> {
        const uLit = mysqlSync.escape(safeIdent(user));
        const db = mysqlSync.escapeId(String((this.config || config.db).name));
        const tbl = mysqlSync.escapeId(safeIdent(table));
        await this.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db}.${tbl} TO ${uLit}@'%'`);
    }

    /** GRANT CRUD on every EXISTING wjp_<slug>_* table to a plugin user (initial provisioning). */
    async grantPluginPrefixToUser(user: string, prefix: string): Promise<void> {
        const dbName = String((this.config || config.db).name);
        // Escape LIKE metacharacters in the literal prefix with an EXPLICIT ESCAPE clause, using a char
        // that never appears in a table name. (This used to say the session ran NO_BACKSLASH_ESCAPES so
        // '\' was not a LIKE escape — that mode is gone; the explicit clause is kept because it states
        // the escape character instead of inheriting it from a session flag.)
        const likePat = String(prefix).replace(/[%_!]/g, (m) => '!' + m) + '%';
        const [rows] = await this.pool.query(
            "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ? ESCAPE '!'",
            [dbName, likePat]
        );
        for (const r of rows) {
            const t = r.t || r.T || r.table_name;
            if (t) await this.grantPluginTableToUser(user, String(t).toLowerCase());
        }
    }

    /** DROP a plugin user (on uninstall) and dispose its scoped pool. */
    async dropPluginUser(user: string): Promise<void> {
        const key = safeIdent(user);
        const p = this.scopedPools.get(key);
        if (p) { try { await p.end(); } catch { /* */ } this.scopedPools.delete(key); }
        const uLit = mysqlSync.escape(key);
        await this.pool.query(`DROP USER IF EXISTS ${uLit}@'%'`);
    }

    /** Lazily build (and cache) a small pool authenticated AS the plugin user. multipleStatements OFF. */
    getScopedPool(user: string, password: string): any {
        const key = safeIdent(user);
        let p = this.scopedPools.get(key);
        if (p) return p;
        const dbConfig = this.config || config.db;
        p = mysql.createPool({
            host: dbConfig.host,
            port: dbConfig.port || 3306,
            user: key,
            password: String(password),
            database: dbConfig.name,
            waitForConnections: true,
            connectionLimit: dbConfig.pluginConnectionLimit || 3,
            multipleStatements: false, // a sandboxed plugin never runs stacked statements
            charset: 'utf8mb4_unicode_ci',
            dateStrings: true,
            ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined
        });
        // SAME session mode as the main pool — one constant, so the two can never drift again. This
        // pool used to re-enable NO_BACKSLASH_ESCAPES that the main pool had deliberately removed,
        // which turned every parameterised plugin query into an injection point (see SESSION_SQL_MODE).
        p.on('connection', (conn: any) => {
            conn.query(SET_SESSION_SQL_MODE, () => { });
        });
        this.scopedPools.set(key, p);
        return p;
    }

    /**
     * Run a plugin's DML/SELECT AS its low-privilege user — the DB enforces table isolation.
     *
     * execute(), not query(): execute() uses SERVER-SIDE PREPARED STATEMENTS, so `params` travel in the
     * binary protocol and are never interpolated into SQL text at all. query() interpolates them with
     * mysql2's client-side escaper, which is correct only while the session keeps backslash escapes on
     * — a coupling this pool already got wrong once. A plugin's parameters are the one place where an
     * anonymous visitor's bytes reach the database, so they must not depend on a session flag.
     */
    async runAsUser(user: string, password: string, method: 'all' | 'get' | 'run', sql: string, params: any[] = []): Promise<any> {
        const pool = this.getScopedPool(user, password);
        // Translate the dialect, THEN reconcile the parameter semantics query() used to give plugins
        // (see prepareExecuteParams): undefined → NULL, and a LIMIT/OFFSET placeholder → a validated
        // integer literal, because mysql2 binds every number as DOUBLE.
        const prepared = prepareExecuteParams(translateSql(sql), params);
        const [result] = await pool.execute(prepared.sql, prepared.params);
        if (method === 'all') return Array.isArray(result) ? result : [];
        if (method === 'get') return Array.isArray(result) ? result[0] : undefined;
        return { lastID: result.insertId || 0, changes: result.affectedRows || 0 };
    }

    async close() {
        for (const p of this.scopedPools.values()) { try { await p.end(); } catch { /* */ } }
        this.scopedPools.clear();
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('🔌 MySQL: Pool Closed.');
        }
    }
}

module.exports = new MysqlDriver();
// Exported for unit tests of the dialect translation.
module.exports.translateSql = translateSql;
module.exports.translateCreateTable = translateCreateTable;
// Exported so a test can assert the ONE session mode both pools install (see SESSION_SQL_MODE).
module.exports.SESSION_SQL_MODE = SESSION_SQL_MODE;
module.exports.SET_SESSION_SQL_MODE = SET_SESSION_SQL_MODE;
// Exported for the parameter-semantics tests (undefined → NULL, LIMIT ? → validated integer literal).
module.exports.prepareExecuteParams = prepareExecuteParams;
module.exports.createTableBody = createTableBody;
// Exported so the reserved-name test can ITERATE the whole set instead of naming a few members, and
// so the ownership predicate of the widening pass can be driven over a table of table names.
module.exports.RESERVED_BARE_COLUMN_NAMES = RESERVED_BARE_COLUMN_NAMES;
module.exports.isWordjsOwnedTable = isWordjsOwnedTable;
