/**
 * WordJS — safe SQL identifiers and column definitions (the ONE place a caller-provided name or
 * column definition becomes part of a DDL statement).
 *
 * THE LESSON THIS FILE ENCODES — the same one core/safe-path encodes for paths. This codebase has
 * shipped the same class of bug repeatedly: the code sanitizes VALUES and forgets to validate what
 * chooses STRUCTURE (a tag, a DDL object class, a query inside a literal, a path segment, an
 * IDENTIFIER). And its twin: a guard that validates a COPY and returns a boolean, while the caller
 * goes on concatenating the RAW value.
 *
 * config/database.createPluginTable had exactly both shapes at once:
 *   · the table name was allowlisted (`^[A-Za-z_][A-Za-z0-9_]*$`) — that half was right;
 *   · each COLUMN DEFINITION was free text, checked by a DENYLIST (`/;|--|\/\*|\*\//`) plus an
 *     identifier test on a DERIVED COPY (`col.trim().split(/\s+/)[0]`) — and then the ORIGINAL,
 *     unmodified `col` was interpolated into `CREATE TABLE …`. Reachable from an untrusted plugin
 *     (plugin-api db.createTable) and from an import bundle (core/import-export custom_tables →
 *     createPluginTable), i.e. straight off POST /api/v1/import. Never infer safety from the ABSENCE
 *     of a token: a denylist is a guess about how four different SQL dialects will read the rest of
 *     the string.
 *
 * So there is one shape of defense here, and it has three parts:
 *   1. ALLOWLIST THE FORM. A closed description of what an identifier / a column definition may BE.
 *   2. CANONICALIZE against a CONSTANT alphabet — the returned string is REBUILT character by
 *      character out of `IDENT_CHARS` / `DEF_CHARS`, so the value that reaches the SQL is by
 *      construction a member of the allowed language. It is not "the caller's string, stamped OK":
 *      there is no copy to drift from the original, because the original is never returned.
 *   3. PROVE THE STRUCTURE the definition may not break: parentheses balanced (a column cannot close
 *      the column list), quotes balanced (a literal cannot swallow what follows), and no `--`.
 *      Everything else that could break out is impossible BY CONSTRUCTION, because the alphabet
 *      simply has no `;` (statement separator), no `/` or `*` (`/*` … `*​/`, and MySQL's executable
 *      `/*!` comments), no `#` (MySQL line comment), no `"`, no backtick, no `\` (identifier quoting
 *      and string escapes), and no newline.
 *
 * FAIL CLOSED: anything that does not pass returns null (or throws, for the assert* helpers). There
 * is no "sanitized" fallback — a definition that cannot be legitimate must never be run.
 *
 * NOTE ON SCOPE: this is for IDENTIFIERS and DDL fragments, which cannot be parameterized. Every
 * VALUE in this codebase still goes through `?` placeholders; nothing here is an excuse to stop.
 *
 * Dependency-free on purpose (no requires at all): config/database loads it at module scope.
 */

/** The only characters an identifier may be built from. Constant — canonicalization reads from it. */
const IDENT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

/**
 * The only characters a column DEFINITION may be built from: identifier characters plus the
 * punctuation a type/constraint clause legitimately needs.
 *
 * What is deliberately ABSENT is the whole point:
 *   ;            statement separator — no stacked statement can exist in a definition
 *   / *          `/​*` … `*​/` block comments, and MySQL's version-gated executable `/*!…*​/`
 *   #            MySQL line comment
 *   " ` \        identifier quoting and string escapes — a literal cannot be escaped out of
 *   \n \r        no line breaks: a definition is one line, so a line comment has nothing to hide
 *   everything else not listed (%, :, ?, $, @, !, &, |, [, ], {, }, ~, ^) has no legitimate use here
 *
 * `-` IS present (negative numeric defaults like `DEFAULT -1` are legitimate) — which is why `--` is
 * rejected explicitly below rather than left to the alphabet.
 */
const DEF_CHARS = IDENT_CHARS + " \t,()'.+-<>=";

/** Longest identifier accepted. 64 is MySQL's hard limit and above SQLite/Postgres practice. */
const MAX_IDENT_LEN = 64;
/** Longest single column definition accepted — bounds the work done on a hostile string. */
const MAX_COLUMN_DEF_LEN = 256;
/** Most columns a single CREATE TABLE may declare. */
const MAX_COLUMNS = 200;

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Rebuild `s` out of `alphabet`, or return null if it contains anything else.
 *
 * The rebuild is not decoration. The returned string is assembled from the CONSTANT alphabet, so
 * "the value that was checked" and "the value that is used" are the same object by construction —
 * the failure mode this project has already shipped (validate a derived copy, concatenate the raw
 * input) is not expressible here.
 */
function canonicalize(s: string, alphabet: string): string | null {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const idx = alphabet.indexOf(s[i]);
        if (idx < 0) return null;
        out += alphabet[idx];
    }
    return out;
}

/** Is `v` a plain, unqualified SQL identifier (letter or `_`, then letters/digits/`_`, ≤64)? */
function isPlainIdent(v: unknown): boolean {
    return typeof v === 'string' && PLAIN_IDENT.test(v);
}

/**
 * The identifier front door: returns the CANONICAL identifier (rebuilt from IDENT_CHARS), or null.
 *
 * Callers interpolate the RETURNED value, never their own input. The result needs no quoting — it
 * cannot contain a character that would require any — which is deliberate: quoting it (`"x"` /
 * `` `x` ``) is dialect-specific (MySQL needs backticks without ANSI_QUOTES; Postgres would make an
 * unquoted name case-folded and a quoted one case-SENSITIVE, silently splitting existing installs).
 */
function safeIdent(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    if (v.length === 0 || v.length > MAX_IDENT_LEN) return null;
    if (!PLAIN_IDENT.test(v)) return null;
    return canonicalize(v, IDENT_CHARS);
}

/** safeIdent, but throwing — for call sites where "not an identifier" is a programming/attack error. */
function assertPlainIdent(v: unknown, what = 'identifier'): string {
    const safe = safeIdent(v);
    if (safe === null) {
        throw new Error(`🛡️ ${what}: '${String(v)}' is not a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]*, ≤${MAX_IDENT_LEN}).`);
    }
    return safe;
}

/**
 * The column-definition front door: `<name> <type and constraints>` (or a table-level constraint such
 * as `PRIMARY KEY (a, b)` / `FOREIGN KEY (x) REFERENCES y(id)`, whose leading word is an identifier
 * too). Returns the CANONICAL definition to interpolate, or null.
 *
 * Beyond the alphabet, three structural facts are proved on the canonical value:
 *   · it starts with an identifier — a definition names something;
 *   · parentheses are balanced and never go negative — it cannot close the enclosing column list and
 *     append arbitrary table-level SQL;
 *   · single quotes are balanced — it cannot leave a string literal open across the following columns.
 */
function safeColumnDefinition(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_COLUMN_DEF_LEN) return null;

    // 1. FORM: every character comes from the closed alphabet, and the value is REBUILT from it.
    const def = canonicalize(trimmed, DEF_CHARS);
    if (def === null) return null;

    // 2. `-` is legal (DEFAULT -1) but `--` opens a comment in every dialect here.
    if (def.includes('--')) return null;

    // 3. It must NAME something: the leading word is a plain identifier.
    const head = def.split(/[\s(,]/, 1)[0];
    if (!PLAIN_IDENT.test(head)) return null;

    // 4. Parens balanced (never negative), quotes balanced. Quoted text is skipped when counting
    //    parens so a legitimate `DEFAULT '('` does not look like an unbalanced one.
    let depth = 0;
    let inQuote = false;
    for (let i = 0; i < def.length; i++) {
        const ch = def[i];
        if (ch === "'") { inQuote = !inQuote; continue; }
        if (inQuote) continue;
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth < 0) return null; }
    }
    if (depth !== 0 || inQuote) return null;

    return def;
}

/** safeColumnDefinition, but throwing. */
function assertColumnDefinition(v: unknown, what = 'column definition'): string {
    const safe = safeColumnDefinition(v);
    if (safe === null) {
        throw new Error(`🛡️ ${what}: '${String(v)}' is not an acceptable column definition (a plain identifier followed by type/constraint text; no statement separators, comments, quoting characters or unbalanced parentheses/quotes).`);
    }
    return safe;
}

/**
 * Build `CREATE TABLE IF NOT EXISTS <table> (<columns>)` from validated parts, or throw.
 *
 * Every fragment placed in the string is a value RETURNED by the helpers above (rebuilt from the
 * constant alphabets), never a caller string. The final single-statement assertion stays as a
 * belt-and-braces check on the assembled text: if a future edit ever reintroduces a way to smuggle
 * a `;`, this fails closed instead of executing two statements.
 */
function buildCreateTable(tableName: unknown, columns: unknown): string {
    const table = assertPlainIdent(tableName, 'createTable: table name');
    if (!Array.isArray(columns) || columns.length === 0) {
        throw new Error('🛡️ createTable: columns must be a non-empty array of definitions.');
    }
    if (columns.length > MAX_COLUMNS) {
        throw new Error(`🛡️ createTable: too many columns (max ${MAX_COLUMNS}).`);
    }
    const defs = columns.map((col) => assertColumnDefinition(col, 'createTable'));
    const sql = `CREATE TABLE IF NOT EXISTS ${table} (\n  ${defs.join(',\n  ')}\n)`;
    if (sql.includes(';')) {
        throw new Error('🛡️ createTable: refusing to run multiple statements.');
    }
    return sql;
}

module.exports = {
    IDENT_CHARS,
    DEF_CHARS,
    PLAIN_IDENT,
    MAX_IDENT_LEN,
    MAX_COLUMN_DEF_LEN,
    MAX_COLUMNS,
    isPlainIdent,
    safeIdent,
    assertPlainIdent,
    safeColumnDefinition,
    assertColumnDefinition,
    buildCreateTable,
};
