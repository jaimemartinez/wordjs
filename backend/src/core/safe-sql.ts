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
 *      the column list), quotes balanced and unescaped (a literal cannot swallow what follows), and
 *      no `--` in CODE. Everything else that could break out is impossible BY CONSTRUCTION, because
 *      the code alphabet simply has no `;` (statement separator), no `/` or `*` (`/*` … `* /`, and
 *      MySQL's executable `/*!` comments), no `#` (MySQL line comment), no `"`, no backtick, no `\`
 *      (identifier quoting and string escapes), and no newline.
 *
 * THE ALPHABET IS STRUCTURE-AWARE (2026-09, the second lesson). The first version applied `DEF_CHARS`
 * to the WHOLE definition, including the inside of a `DEFAULT '…'` literal — so `params TEXT DEFAULT
 * '{}'` (an empty-JSON default) and `color TEXT DEFAULT '#3b82f6'` were refused, and three shipped
 * catalog plugins could not be activated at all. That was the mirror image of the original bug:
 * having learnt that structure must be validated, the guard went on to validate TEXT as if it were
 * structure. Once the quoting around it is proved balanced and unescaped, the content of a literal
 * is inert to every lexer this project targets; `{`, `#`, `;`, `"`, `--` inside it are characters,
 * not syntax. So there are TWO alphabets, chosen by position:
 *   · OUTSIDE quotes — `DEF_CHARS`, unchanged, and the structural proofs above run on that text;
 *   · INSIDE a single-quoted literal — any printable character except `'` (which ends the literal)
 *     and `\` (an escape in MySQL's default mode; either would let a literal extend past its closing
 *     quote). Control characters and line breaks are refused everywhere: a definition is ONE visible
 *     line, wherever the character sits.
 * Both alphabets are applied by the same character-by-character rebuild, so nothing outside either
 * can survive — and nothing is ever accepted "because it is in a string" until the string is proven.
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
 * The only characters the CODE of a column DEFINITION may be built from — everything that stands
 * OUTSIDE a single-quoted literal: identifier characters plus the punctuation a type/constraint
 * clause legitimately needs.
 *
 * What is deliberately ABSENT is the whole point:
 *   ;            statement separator — no stacked statement can exist in a definition
 *   / *          `/ *` … `* /` block comments, and MySQL's version-gated executable `/*!…* /`
 *   #            MySQL line comment
 *   " ` \        identifier quoting and string escapes — a literal cannot be escaped out of
 *   \n \r        no line breaks: a definition is one line, so a line comment has nothing to hide
 *   everything else not listed (%, :, ?, $, @, !, &, |, [, ], {, }, ~, ^) has no legitimate use here
 *
 * `-` IS present (negative numeric defaults like `DEFAULT -1` are legitimate) — which is why `--` is
 * rejected explicitly below rather than left to the alphabet.
 *
 * This alphabet does NOT apply INSIDE a literal — see LITERAL_FORBIDDEN. `DEFAULT '{}'`, `DEFAULT
 * '#3b82f6'`, `DEFAULT 'a;b'` are legitimate defaults whose text merely contains characters that are
 * syntax only in code position.
 */
const DEF_CHARS = IDENT_CHARS + " \t,()'.+-<>=";

/**
 * What may NOT appear INSIDE a single-quoted literal. Everything else — any printable character of
 * any script, and every punctuation mark the code alphabet lacks — is inert text once the quoting
 * around it has been proved balanced (canonicalizeDefinition proves it in the same pass).
 *
 *   '              ends the literal. It is structure, handled by the quote toggle, never content.
 *   \              MySQL (without NO_BACKSLASH_ESCAPES, the session this project's driver runs) reads
 *                  `\'` as an escaped quote, so a backslash could carry a literal past the quote that
 *                  this module counted as closing it. SQLite and Postgres would disagree with MySQL
 *                  about where the literal ends — the one thing this module must never allow.
 *   \p{Cc}         every C0/C1 control character (\t \n \r NUL DEL NEL …): a definition is ONE
 *                  visible line, and nothing invisible may hide in it, in code or in text.
 *   \p{Zl} \p{Zp}  Unicode line / paragraph separators, the same concern.
 *   \p{Cs}         a lone surrogate is not a character; it has no printable form to accept.
 *
 * Format characters (U+200D ZERO WIDTH JOINER, variation selectors, bidi marks) are deliberately NOT
 * refused: they are the glue of emoji sequences and of several scripts, and inside a literal they are
 * data. The standard `''` (a doubled quote for a literal quote) needs no special case: the toggle
 * reads it as close-then-open, which leaves nothing in code position between the two.
 */
const LITERAL_FORBIDDEN = /['\\\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u;

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

/**
 * The column-definition rebuild: `canonicalize`, made aware of where a single-quoted literal begins
 * and ends. Returns the canonical definition together with its CODE MASK — the same text with the
 * content of every literal blanked to spaces (delimiters kept, same length) — or null.
 *
 * One pass, one quote toggle, two alphabets:
 *   · in code position a character must come from DEF_CHARS, and is emitted FROM DEF_CHARS;
 *   · `'` flips the position and is emitted as the constant quote — it is never literal content;
 *   · inside a literal a character (iterated by CODE POINT, so a non-BMP character is one unit) must
 *     not match LITERAL_FORBIDDEN, and is emitted from its checked code point.
 * The pass fails if the input ends inside a literal, so the returned value's quotes are balanced by
 * construction and every structural test downstream (`--`, parentheses, the leading identifier, the
 * final `;` belt-and-braces) is run on the MASK, where a literal's text cannot be mistaken for code.
 *
 * This is the ONLY place that decides which characters a definition may contain. Nothing else in
 * this module, and no caller, re-scans a definition against an alphabet of its own.
 */
function canonicalizeDefinition(s: string): { def: string; code: string } | null {
    let def = '';
    let code = '';
    let inQuote = false;
    for (const ch of s) {
        if (ch === "'") {
            inQuote = !inQuote;
            def += "'";
            code += "'";
            continue;
        }
        if (!inQuote) {
            const idx = DEF_CHARS.indexOf(ch);
            if (idx < 0) return null;
            def += DEF_CHARS[idx];
            code += DEF_CHARS[idx];
            continue;
        }
        if (LITERAL_FORBIDDEN.test(ch)) return null;
        def += String.fromCodePoint(ch.codePointAt(0) as number);
        code += ' ';
    }
    if (inQuote) return null; // an unterminated literal would swallow the columns that follow
    return { def, code };
}

/**
 * The code mask of an ASSEMBLED statement whose every literal has already been proved balanced and
 * unescaped by canonicalizeDefinition (buildCreateTable's template adds no quotes of its own). Null if
 * the quotes do not pair up after all — the belt-and-braces caller then fails closed.
 */
function codeMaskOf(sql: string): string | null {
    let code = '';
    let inQuote = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") { inQuote = !inQuote; code += ch; continue; }
        code += inQuote ? ' ' : ch;
    }
    return inQuote ? null : code;
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
 * Beyond the alphabets, three structural facts are proved — on the CODE MASK, so a literal's text can
 * neither trip nor satisfy them:
 *   · single quotes are balanced (canonicalizeDefinition fails otherwise) — a literal cannot stay
 *     open across the following columns;
 *   · it starts with an identifier — a definition names something;
 *   · parentheses are balanced and never go negative — it cannot close the enclosing column list and
 *     append arbitrary table-level SQL. A `DEFAULT '('` is text and is not counted.
 * `--` is refused in code (it opens a comment in every dialect here) and accepted inside a literal,
 * where it is two characters of text.
 */
function safeColumnDefinition(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_COLUMN_DEF_LEN) return null;

    // 1. FORM: every character comes from the alphabet of its position (code / literal), the value is
    //    REBUILT from those alphabets, and the literals are balanced — or there is no value at all.
    const scanned = canonicalizeDefinition(trimmed);
    if (scanned === null) return null;
    const { def, code } = scanned;

    // 2. `-` is legal (DEFAULT -1) but `--` in code opens a comment in every dialect here.
    if (code.includes('--')) return null;

    // 3. It must NAME something: the leading word is a plain identifier (a `'` is not one).
    const head = code.split(/[\s(,]/, 1)[0];
    if (!PLAIN_IDENT.test(head)) return null;

    // 4. Parens balanced and never negative, counted on the mask (a quoted paren is blank there).
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth < 0) return null; }
    }
    if (depth !== 0) return null;

    return def;
}

/** safeColumnDefinition, but throwing. */
function assertColumnDefinition(v: unknown, what = 'column definition'): string {
    const safe = safeColumnDefinition(v);
    if (safe === null) {
        throw new Error(`🛡️ ${what}: '${String(v)}' is not an acceptable column definition (a plain identifier followed by type/constraint text; outside single-quoted literals no statement separators, comments or quoting characters; no backslashes, control characters or unbalanced parentheses/quotes anywhere).`);
    }
    return safe;
}

/**
 * Build `CREATE TABLE IF NOT EXISTS <table> (<columns>)` from validated parts, or throw.
 *
 * Every fragment placed in the string is a value RETURNED by the helpers above (rebuilt from the
 * constant alphabets), never a caller string. The final single-statement assertion stays as a
 * belt-and-braces check on the assembled text: if a future edit ever reintroduces a way to smuggle
 * a `;` into CODE position, this fails closed instead of executing two statements. It reads the code
 * mask, not the raw text, for the same reason safeColumnDefinition does — `DEFAULT 'a;b'` is one
 * statement — and it fails closed too if the assembled statement's quotes do not pair up.
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
    const code = codeMaskOf(sql);
    if (code === null || code.includes(';')) {
        throw new Error('🛡️ createTable: refusing to run multiple statements.');
    }
    return sql;
}

module.exports = {
    IDENT_CHARS,
    DEF_CHARS,
    LITERAL_FORBIDDEN,
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
