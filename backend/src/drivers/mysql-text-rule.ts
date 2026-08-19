/**
 * WordJS — the ONE rule for how a SQLite-dialect `TEXT` column becomes a MySQL column type.
 *
 * WHY THIS FILE EXISTS. The rule used to live in two places that disagreed, and the weaker of the two
 * silently destroyed data:
 *
 *   · drivers/mysql.ts decided the type from the column NAME, against a hard-coded set of ~20 core
 *     columns (`LONG_TEXT_COLUMNS`). Anything not on the list became VARCHAR(255). A literal list can
 *     never know a plugin's columns, or the columns of an imported bundle — so EVERY plugin `TEXT`
 *     column (a mail body, an auction description, a submitted form payload) was created 255 chars
 *     wide, and because the session also dropped STRICT_TRANS_TABLES an overlong value was TRUNCATED
 *     with a warning instead of rejected. `POST /api/v1/import` → createPluginTable therefore
 *     mutilated content while reporting `custom_tables.rows++` and an empty `errors` array.
 *   · core/db-admin/migration.js had already spotted the danger and closed it for ONE path:
 *     `TEXT → LONGTEXT` with a negative lookahead so an inline key column stays bounded
 *     ("plugin content must not be capped at VARCHAR(255)").
 *
 * The default is now inverted, and derived from the DDL itself rather than from a name:
 *
 *     TEXT → LONGTEXT, EXCEPT when the column takes part in a key → VARCHAR(255)
 *
 * "Takes part in a key" is read off the CREATE TABLE: an inline `PRIMARY KEY` / `UNIQUE` on the
 * column, or a table-level `PRIMARY KEY (…)` / `UNIQUE (…)` / `KEY (…)` / `INDEX (…)` / `FOREIGN KEY (…)`
 * that names it. MySQL refuses a TEXT/BLOB key part without a prefix length, so a key column must
 * stay bounded — and being declared a key is exactly the evidence that the column is short by design.
 * (A column that only becomes a key in a LATER `CREATE INDEX` is handled at that point by the driver;
 * see `ensureIndexableKeyParts` in drivers/mysql.ts.)
 *
 * NOTE this is STRICTLY stronger than migration.js's `\bTEXT\b(?!\s+(?:PRIMARY|UNIQUE))`: that
 * lookahead only sees a key that IMMEDIATELY follows the type, so the core schema's
 * `uuid TEXT NOT NULL UNIQUE` (notifications) slips past it and would have produced an illegal
 * key on a LONGTEXT column. Here the whole column definition is inspected.
 *
 * THREE THINGS THE FIRST VERSION OF THIS MODULE STILL GOT WRONG on real DDL, all of them the same
 * mistake — deciding what a token MEANS from the token alone, without looking at what follows it:
 *
 *   1. It re-joined the column list it had split without stripping SQL comments first. A `-- comment`
 *      containing a COMMA (the core `wordjs_analytics` table has three) was split into pieces and
 *      re-joined on new lines, so the `--` stopped covering the rest of the comment and `'api_call',`
 *      became a column definition. Comments are now stripped HERE, before any split, so the module is
 *      safe on the raw DDL that comes straight out of `sqlite_master`.
 *   2. `CONSTRAINT "chk one" CHECK (body <> '')` did not match the CHECK exemption (a `\S+` name
 *      pattern cannot span a quoted name with a space), so the CHECK's expression was read as a
 *      key-part list and `body` was capped at 255 — the exact cap this rule exists to remove. A
 *      constraint name may now be quoted.
 *   3. A column literally named `key`, `index`, `unique` or `check` was classified as a table-level
 *      constraint and left untranslated (and `KEY` is reserved in MySQL, so the DDL did not even
 *      parse). A part is a constraint only when the keyword is FOLLOWED by a constraint's shape —
 *      `KEY (…)` / `KEY name (…)` — and never when it is followed by a column TYPE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLASS BEHIND ALL THREE, AND THE FOURTH THAT KEPT COMING BACK
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLASS: this module decides SQL STRUCTURE (where a column definition ends, whether a keyword is
 * a keyword, where a key-part list starts) with plain string/regex operations, which cannot see
 * QUOTING. Every comma, parenthesis or keyword that lives inside a string literal, a quoted
 * identifier or a comment is therefore read as structure — and every structural thing that lives
 * inside NESTED parentheses is missed. That single blindness produced, in three consecutive rounds:
 * a comment's comma splitting the column list; a `CHECK` expression read as a key-part list; and
 * `DEFAULT 'hello, world'` splitting one column into two (silently CHANGING the stored default) while
 * `DEFAULT '('` left the split at depth 1 for ever, so every column after it stayed capped at 64 KB.
 *
 * WHICH OF THE TWO WAYS OUT WE TOOK, AND WHY. Either narrow the contract to what string operations
 * can do safely (i.e. refuse any DDL carrying a quoted literal) or give the subset a real scanner.
 * NARROWING IS NOT AVAILABLE: the producers legitimately emit quoted text — core/safe-sql's
 * `safeColumnDefinition` accepts `DEFAULT '…'` (and skips quoted text when it counts parens, so it
 * accepts an unbalanced one), the core schema ships `DEFAULT ''` on nearly every column, and
 * core/db-admin/migration.js feeds this module whatever `sqlite_master` stored. Refusing them would
 * abort an engine switch on valid DDL. So the subset gets a SCANNER:
 *
 *     scanSpans()  — ONE pass that classifies every character as code / string / quoted identifier /
 *                    comment. `'…'` ('' and \ escapes, as MySQL parses it with backslash escapes ON,
 *                    which is the session this driver installs), `"…"`, `` `…` ``, `[…]`, and both
 *                    comment forms (line and block).
 *     codeMask()   — the same text with the CONTENT of every non-code span blanked and its
 *                    DELIMITERS kept, so indices map 1:1 back to the original. Structure is read off
 *                    the mask; text is always sliced from the original.
 *
 * EVERY structural decision in this module and in drivers/mysql.ts goes through those two — split,
 * paren matching, keyword tests, keyword rewrites. THE RULE FOR THE NEXT READER: if you are about to
 * write `.split(',')`, `.indexOf('(')` or `/\bWORD\b/` over SQL text here, you are re-opening this
 * class; use splitTopLevel / firstParenGroup / codeMatch / replaceInCode instead.
 *
 * WHAT THE SCANNER DELIBERATELY DOES NOT DO: it is not a parser. It knows nothing of expressions,
 * operator precedence or statement structure, and the two shapes read positionally (a column's
 * NAME and its TYPE token, always the first two tokens of a part) are read from the original text
 * because neither can begin inside a literal.
 *
 * Dependency-free on purpose (no `require` at all): drivers/mysql.ts consumes it, and so may
 * core/db-admin/migration.js, which must stay loadable on an install with no mysql2 present.
 */

/** The type a TEXT column gets when nothing indexes it: no cap, so content is never truncated. */
const LONG_TEXT = 'LONGTEXT';
/** The type a TEXT column gets when it takes part in a key: bounded, so MySQL can index it. */
const KEY_TEXT = 'VARCHAR(255)';

/** What one stretch of the statement IS. Everything that is not `code` is TEXT, never structure. */
type SpanKind = 'code' | 'string' | 'ident' | 'comment';
type Span = { kind: SpanKind; start: number; end: number };

/** A bracketed SQLite identifier, on one line and non-empty — so a stray `[` stays code. */
const BRACKET_IDENT_RE = /^\[[^\]\n]+\]/;

/**
 * THE ONE PASS. Classify every character of a statement as code / string / quoted identifier /
 * comment. Nothing else in this module (or in drivers/mysql.ts) may decide what a character MEANS.
 *
 * Escapes follow the engine the output is fed to, which is the only reading that cannot disagree
 * with the server: inside `'…'`, `''` and a backslash escape both continue the literal (the driver's
 * session deliberately does NOT set NO_BACKSLASH_ESCAPES); inside a quoted identifier only the
 * doubled delimiter does. An UNTERMINATED span runs to the end of the input — the safe direction:
 * the rest is treated as text, so a malformed statement is left alone instead of being split into
 * nonsense and rewritten.
 */
function scanSpans(sql: string): Span[] {
    const s = String(sql);
    const n = s.length;
    const spans: Span[] = [];
    let i = 0, codeStart = 0;
    const push = (kind: SpanKind, start: number, end: number) => {
        if (start > codeStart) spans.push({ kind: 'code', start: codeStart, end: start });
        spans.push({ kind, start, end });
        codeStart = end;
    };
    while (i < n) {
        const c = s[i];
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (s[j] === '\\') { j += 2; continue; }
                if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } j++; break; }
                j++;
            }
            push('string', i, Math.min(j, n)); i = Math.min(j, n); continue;
        }
        if (c === '"' || c === '`') {
            let j = i + 1;
            while (j < n) {
                if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } j++; break; }
                j++;
            }
            push('ident', i, Math.min(j, n)); i = Math.min(j, n); continue;
        }
        if (c === '[') {
            const m = s.slice(i).match(BRACKET_IDENT_RE);
            if (m) { push('ident', i, i + m[0].length); i += m[0].length; continue; }
            i++; continue;
        }
        if (c === '-' && s[i + 1] === '-') {
            let j = i; while (j < n && s[j] !== '\n') j++;
            push('comment', i, j); i = j; continue;
        }
        if (c === '/' && s[i + 1] === '*') {
            let j = i + 2; while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
            j = Math.min(n, j + 2);
            push('comment', i, j); i = j; continue;
        }
        i++;
    }
    if (codeStart < n) spans.push({ kind: 'code', start: codeStart, end: n });
    return spans;
}

/**
 * The statement with every non-code span's CONTENT blanked and its DELIMITERS kept, same length as
 * the input so any index found in the mask addresses the same character of the original.
 *
 * This is what makes "read the structure, keep the text" a mechanism instead of a discipline: a
 * regex run over the mask can never match a keyword that lives inside a literal, and a `,`/`(`/`)`
 * counted in the mask is always a real one. Quotes survive so a pattern may still ANCHOR on a
 * literal (`DEFAULT '…'`) and slice its true text out of the original.
 */
function codeMask(sql: string): string {
    const s = String(sql);
    const out = s.split('');
    for (const span of scanSpans(sql)) {
        if (span.kind === 'code') continue;
        const keepDelimiters = span.kind !== 'comment';
        for (let i = span.start; i < span.end; i++) {
            if (keepDelimiters && (i === span.start || i === span.end - 1)) continue;
            if (out[i] !== '\n') out[i] = ' ';
        }
    }
    return out.join('');
}

/** Run `re` over the CODE of `sql`; the returned match indexes the ORIGINAL text. */
function codeMatch(sql: string, re: RegExp): RegExpMatchArray | null {
    return codeMask(sql).match(re);
}

/**
 * Replace, in the CODE only, what `re` matches — the replacement sees the ORIGINAL matched text.
 * Every keyword rewrite (AUTOINCREMENT, DEFAULT …) goes through this: a `\b…\b` applied straight to
 * the definition rewrites inside string literals, which is how `DEFAULT 'a, b text'` used to get its
 * contents edited.
 */
function replaceInCode(sql: string, re: RegExp, replacement: string | ((...args: any[]) => string)): string {
    const s = String(sql);
    // `d` (hasIndices) is what makes the mask→original mapping EXACT for capture groups too: every
    // group is taken from the original by its own offsets, never re-found by searching for its text.
    const withIndices = re.flags.includes('d') ? re : new RegExp(re.source, re.flags + 'd');
    const m = codeMask(s).match(withIndices) as (RegExpMatchArray & { indices?: Array<[number, number] | undefined> }) | null;
    if (!m || m.index === undefined || !m.indices) return s;
    const textAt = (pair: [number, number] | undefined) => (pair ? s.slice(pair[0], pair[1]) : undefined);
    const whole = textAt(m.indices[0] as [number, number]) as string;
    const groups = m.indices.slice(1).map(textAt);
    const replaced = typeof replacement === 'function'
        ? replacement(whole, ...groups)
        : replacement.replace(/\$(\d)/g, (_w: string, d: string) => String(groups[Number(d) - 1] ?? ''));
    return s.slice(0, m.index) + replaced + s.slice(m.index + m[0].length);
}

/**
 * Strip `-- line` and block comments — now a projection of the ONE scan.
 *
 * LIVES HERE, not in the driver. Core DDL carries inline comments whose text contains COMMAS
 * (`type VARCHAR(50) NOT NULL, -- 'page_view', 'api_call', 'engagement'` — models/Analytics.ts, a
 * table every install creates). `splitTopLevel` does not know a comma is inside a comment, so any
 * caller that splits and RE-JOINS the column list on new lines turns one comment into several bogus
 * column definitions. Both callers (the driver's translateCreateTable and this module's
 * rewriteTextForMysql) therefore strip FIRST: the rule must be safe on the raw CREATE that
 * `sqlite_master` hands to core/db-admin/migration.js, not only on DDL the driver pre-cleaned.
 */
function stripSqlComments(sql: string): string {
    const s = String(sql);
    let out = '';
    for (const span of scanSpans(s)) {
        if (span.kind === 'comment') continue;
        out += s.slice(span.start, span.end);
    }
    return out;
}

/** One identifier, however it is quoted: "a", `a`, [a], or bare. */
const IDENT = '(?:"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z0-9_]*)';

/**
 * Every token that can stand where a column's TYPE stands. This is a SYNTACTIC disambiguator, not a
 * semantic list: its ONLY job is to answer "is the second token of this part a type (⇒ the part is a
 * column definition whose NAME is the first token) or an index name (⇒ the part is a constraint)".
 * Nothing about the TEXT decision itself depends on it, so a type missing from this set cannot cap a
 * column — it can only leave a part looking like a constraint, and only for a part that already
 * STARTS with a constraint keyword.
 */
const TYPE_TOKENS = new Set([
    'TEXT', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT', 'CLOB',
    'VARCHAR', 'CHAR', 'NVARCHAR', 'NCHAR', 'CHARACTER', 'VARYING',
    'BLOB', 'LONGBLOB', 'MEDIUMBLOB', 'TINYBLOB', 'BINARY', 'VARBINARY', 'BYTEA',
    'INT', 'INTEGER', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'SERIAL', 'BIGSERIAL',
    'REAL', 'DOUBLE', 'FLOAT', 'NUMERIC', 'DECIMAL', 'NUMBER',
    'BOOL', 'BOOLEAN', 'BIT',
    'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR',
    'JSON', 'JSONB', 'UUID', 'ENUM', 'SET'
]);

/** `<name> <TYPE>` at the head of a part. */
const NAME_THEN_TOKEN_RE = new RegExp(`^(\\s*${IDENT}\\s+)([A-Za-z_][A-Za-z0-9_]*)`);

/**
 * The column's declared TYPE token, BY POSITION (the second token), or null when the part does not
 * have the `<name> <type> …` shape.
 *
 * Reading the type by position is what makes a column literally named `text` survive: searching the
 * definition for the first `\bTEXT\b` finds the NAME and produces `LONGTEXT TEXT NOT NULL`.
 */
function columnTypeToken(def: string): { start: number; token: string } | null {
    const m = String(def).match(NAME_THEN_TOKEN_RE);
    if (!m) return null;
    return { start: m[1].length, token: m[2] };
}

/** Replace the column's TYPE token (by position) with `type`; unchanged when the part has no type. */
function replaceColumnType(def: string, type: string): string {
    const s = String(def);
    const t = columnTypeToken(s);
    if (!t) return s;
    return s.slice(0, t.start) + String(type) + s.slice(t.start + t.token.length);
}

/** Does this part start with a keyword a TABLE-LEVEL constraint clause can start with? */
const CONSTRAINT_HEAD_RE = /^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CONSTRAINT|CHECK|KEY|INDEX)\b([\s\S]*)$/i;

/**
 * Is this top-level part a table-level constraint (composite PK, UNIQUE(...), …) rather than a column?
 *
 * The keyword alone does not decide. `KEY`, `INDEX`, `UNIQUE` and `CHECK` are all legal column names
 * in the SQLite dialect the rest of WordJS writes (a key/value plugin table calling its column `key`
 * is the common case), and treating such a column as a constraint left it untranslated — a bare
 * `key TEXT` reaching MySQL, where `KEY` is reserved and `TEXT` is exactly the type this rule exists
 * to widen. So the token that FOLLOWS the keyword decides: a constraint is followed by its key-part
 * list (`KEY (a)`) or by an index name and then the list (`KEY idx_a (a)`); a column is followed by
 * its TYPE (`key TEXT`, `key VARCHAR(255)`).
 */
function isTableConstraint(def: string): boolean {
    const s = String(def);
    // The head keyword is matched in the CODE (a literal cannot start a part, but a part may CARRY
    // one, and the shape tests below must not read a quoted name as an opening parenthesis).
    const m = codeMask(s).match(CONSTRAINT_HEAD_RE);
    if (!m) return false;
    // `<keyword> <TYPE>` is a COLUMN whose name happens to be that keyword.
    const t = columnTypeToken(s);
    if (t && TYPE_TOKENS.has(t.token.toUpperCase())) return false;
    const head = m[1].toUpperCase().replace(/\s+/g, ' ');
    // Two-word heads (and CONSTRAINT) cannot be a column name in any dialect WordJS emits.
    if (head === 'PRIMARY KEY' || head === 'FOREIGN KEY' || head === 'CONSTRAINT') return true;
    // The tail is taken from the ORIGINAL at the offset the mask found, so a QUOTED index name
    // (`KEY "idx one" (a)`) still matches the `<name> (` shape.
    const rest = s.slice(s.length - m[2].length).replace(/^\s+/, '');
    if (rest.startsWith('(')) return true;                     // KEY (a) / UNIQUE (a) / CHECK (…)
    if (/^(?:KEY|INDEX)\b/i.test(rest)) return true;           // UNIQUE KEY name (a)
    return new RegExp(`^${IDENT}\\s*\\(`).test(rest);          // KEY idx_name (a)
}

/**
 * The column's name, UNQUOTED and lower-cased, from a column definition or a key part
 * (`"post_name" TEXT …`, `` `slug`(191) ``, `[my col] TEXT`).
 *
 * Parsed as one identifier rather than as `\w+`: a `\w+` pattern stops at the first space, so a
 * quoted name that contains one (`"my col"`) came back EMPTY and the column could never be matched
 * against the key set — and a bare prefix length (`slug(191)`) came back as the number.
 */
function columnNameOf(def: string): string {
    const m = String(def).trim().match(new RegExp(`^(${IDENT})`));
    if (!m) return '';
    const raw = m[1];
    if (raw[0] === '"' || raw[0] === '`') return raw.slice(1, -1).split(raw[0] + raw[0]).join(raw[0]).toLowerCase();
    if (raw[0] === '[') return raw.slice(1, -1).toLowerCase();
    return raw.toLowerCase();
}

/**
 * Split a CREATE TABLE column list on TOP-LEVEL commas only, so `PRIMARY KEY (a, b)` stays one part.
 * Lives here (rather than in the driver) because the key set can only be computed from the whole,
 * correctly-split list — the two must never disagree about where a column definition ends.
 *
 * Depth and commas are counted in the CODE MASK, so a comma or a parenthesis inside a literal, a
 * quoted identifier or a comment is text. Both were live defects: `DEFAULT 'hello, world'` split one
 * column into two and silently changed the stored default, and `DEFAULT '('` left the depth at 1 for
 * the rest of the table so every following column stayed capped at VARCHAR(255)/TEXT. The PARTS are
 * sliced from the ORIGINAL, so nothing the caller re-joins is ever the mask.
 */
function splitTopLevel(body: string): string[] {
    const s = String(body);
    const mask = codeMask(s);
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < mask.length; i++) {
        const ch = mask[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    const tail = s.slice(start);
    if (tail.trim()) parts.push(tail);
    return parts;
}

/**
 * The FIRST balanced parenthesised group of `s` (its inner text and where it sits), or null.
 *
 * Replaces `/\(([^()]*)\)/`, which finds the first group with NOTHING nested in it — for
 * `KEY idx_slug (slug(191))` that is `(191)`, so the real key part was never seen and the column it
 * names was left unbounded. Parens are counted in the mask, so `DEFAULT '('` is text.
 */
function firstParenGroup(s: string): { start: number; end: number; inner: string } | null {
    const text = String(s);
    const mask = codeMask(text);
    const start = mask.indexOf('(');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < mask.length; i++) {
        if (mask[i] === '(') depth++;
        else if (mask[i] === ')') {
            depth--;
            if (depth === 0) return { start, end: i, inner: text.slice(start + 1, i) };
        }
    }
    return null;
}

/**
 * Does this COLUMN definition declare an inline key? `id TEXT PRIMARY KEY`, `uuid TEXT NOT NULL
 * UNIQUE` — the key words may sit anywhere after the type, which is why the whole definition is
 * tested instead of only the token that follows `TEXT`.
 */
function declaresInlineKey(def: string): boolean {
    // TWO ways this used to read a key that was not there, both of them the same mistake — looking
    // for a word without asking WHERE it is:
    //   · in the column's own DEFAULT: `note TEXT NOT NULL DEFAULT 'unique'` (tested on the CODE now);
    //   · in the column's own NAME: `unique TEXT NOT NULL` — a legal column name, capped at
    //     VARCHAR(255) by its own name. Only the text AFTER the type token can declare a key.
    const s = String(def);
    const t = columnTypeToken(s);
    const tail = t ? codeMask(s).slice(t.start + t.token.length) : codeMask(s);
    return /\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(tail);
}

/** A CHECK clause, with or without a (possibly QUOTED, possibly space-bearing) constraint name. */
const CHECK_CLAUSE_RE = new RegExp(`^\\s*(?:CONSTRAINT\\s+${IDENT}\\s+)?CHECK\\b`, 'i');

/** Column names (lower-cased) named by any TABLE-LEVEL key clause in this column list. */
function tableLevelKeyColumns(defs: string[]): Set<string> {
    const out = new Set<string>();
    for (const def of defs) {
        if (!isTableConstraint(def)) continue;
        // A CHECK constrains values, it does not create an index — its columns stay unbounded. The
        // name may be quoted (`CONSTRAINT "chk one" CHECK (…)`); a `\S+` name pattern misses that and
        // then reads the CHECK's own expression as a key-part list.
        if (CHECK_CLAUSE_RE.test(def)) continue;
        // The key-part list is the first BALANCED group (not the first group with nothing nested in
        // it), and it is split with the same top-level splitter the column list uses — a key part may
        // carry a prefix length, `KEY idx (a(191), b)`.
        const group = firstParenGroup(def);
        if (!group) continue;
        for (const part of splitTopLevel(group.inner)) {
            const name = columnNameOf(part);
            if (name) out.add(name);
        }
    }
    return out;
}

/** Every column (lower-cased) that takes part in a key declared inside this CREATE TABLE. */
function keyColumnsFromDefs(defs: string[]): Set<string> {
    const out = tableLevelKeyColumns(defs);
    for (const def of defs) {
        if (isTableConstraint(def)) continue;
        if (declaresInlineKey(def)) {
            const name = columnNameOf(def);
            if (name) out.add(name);
        }
    }
    return out;
}

/** THE RULE: the MySQL type a SQLite `TEXT` column gets, given the table's key columns. */
function mysqlTypeForText(columnName: string, keyColumns: Set<string> | null): string {
    return keyColumns && keyColumns.has(String(columnName).toLowerCase()) ? KEY_TEXT : LONG_TEXT;
}

const CREATE_TABLE_RE = new RegExp(
    `^(\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s*)\\(([\\s\\S]*)\\)(\\s*)$`, 'i'
);

/**
 * Whole-statement form of the rule, for callers that hold a raw `CREATE TABLE` and no column split of
 * their own (core/db-admin/migration.js). Rewrites ONLY the TEXT type token; the driver still applies
 * the rest of the dialect translation (expression defaults, AUTOINCREMENT, …) afterwards, and
 * re-running this over its own output is a no-op (a rewritten column's type token is LONGTEXT or
 * VARCHAR(255), neither of which is `TEXT`). A statement it cannot parse is returned with its
 * comments stripped — a comment is precisely what makes the parse unsafe downstream.
 */
function rewriteTextForMysql(sql: string): string {
    const stripped = stripSqlComments(String(sql));
    const m = stripped.match(CREATE_TABLE_RE);
    if (!m) return stripped;
    const defs = splitTopLevel(m[2]).map((c) => c.trim()).filter(Boolean);
    const keyColumns = keyColumnsFromDefs(defs);
    const out = defs.map((def) => {
        if (isTableConstraint(def)) return def;
        const t = columnTypeToken(def);
        if (!t || t.token.toUpperCase() !== 'TEXT') return def;
        return replaceColumnType(def, mysqlTypeForText(columnNameOf(def), keyColumns));
    });
    return `${m[1]}(\n  ${out.join(',\n  ')}\n)${m[3] || ''}`;
}

module.exports = {
    LONG_TEXT,
    KEY_TEXT,
    IDENT,
    TYPE_TOKENS,
    stripSqlComments,
    // The scanner and its projections — THE chokepoint every structural decision must go through.
    scanSpans,
    codeMask,
    codeMatch,
    replaceInCode,
    firstParenGroup,
    isTableConstraint,
    columnNameOf,
    columnTypeToken,
    replaceColumnType,
    splitTopLevel,
    declaresInlineKey,
    keyColumnsFromDefs,
    mysqlTypeForText,
    rewriteTextForMysql,
};
