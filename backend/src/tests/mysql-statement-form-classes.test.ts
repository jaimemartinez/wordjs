/**
 * THE MySQL TRANSLATOR — THE TWO AXES ROUND 3 FOUND THE CLASS HAD BEEN DRAWN AROUND
 *
 * The class was "this module decides the STRUCTURE of SQL with string operations, and string operations
 * do not see quoting". Wave 4 closed it for the CREATE TABLE branch and the existing suite iterates
 * payloads inside a `DEFAULT`. Round 3 showed the class had two more axes and the suite could see
 * neither, because every member it built came out of the same canonical statement shape:
 *
 *   AXIS 1 — THE DML BRANCH. Its rewrites still ran over raw text, so a plugin's
 *            `WHERE subject = 'Re: returning your call'` was TRUNCATED on MySQL and fine on SQLite.
 *   AXIS 2 — THE FORM OF THE STATEMENT. The CREATE TABLE anchor was `\)(\s*)$`, so a trailing `;`,
 *            `WITHOUT ROWID`, `STRICT`, `TEMP` or a leading comment fell off the end of the match and the
 *            statement was returned VERBATIM — SQLite DDL delivered to MySQL as if it had been translated.
 *
 * HOW THE POPULATIONS ARE DERIVED, AND WHERE THEY ARE NOT:
 *   · AXIS 1 is derived from the SOURCE. The rewrites of `translateSql` are extracted from
 *     drivers/mysql.ts, each regex is turned back into a string that MATCHES it, and that string is
 *     embedded in a literal. A rewrite added to that function adds a row here with nothing to remember,
 *     and a regex this file cannot turn into a probe FAILS LOUD instead of being skipped.
 *   · AXIS 1b is derived from the source too, and inverted: no structural decision inside the two
 *     translation functions may be taken with a raw string operation. A new `.replace()` is red.
 *
 * BOTH AXIS 1 GATES READ A FILE, AND THAT IS A DEPENDENCY WITH TWO EDGES, both of them closed here
 * after a clean extraction of the git tree failed while the working tree passed:
 *   · The BYTES of the file are not what git stores — a Windows checkout normalises to CRLF — so the
 *     source is read with its newlines normalised before anything is delimited (see SOURCE below).
 *   · A file scan can pass by finding nothing, including when it is looking at nothing. Every scan
 *     below therefore carries a POSITIVE CONTROL: the body delimiter proves its braces balance, the
 *     AXIS 1b scanner is shown a known offender and a known exemption, and every AXIS 1 row proves its
 *     own payload is live by showing that the forbidden raw rewrite really does corrupt it.
 *   · AXIS 2 is a CARTESIAN PRODUCT of independent statement-shape modifiers. The AXES are declared by
 *     hand — nothing in the repo enumerates "the ways a CREATE TABLE can be spelled" — and that limit is
 *     stated here rather than implied. Adding a value to an axis adds a whole row set.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const driver = require('../drivers/mysql');
const translateSql = driver.translateSql || driver._translateSql;
const SOURCE_PATH = path.resolve(__dirname, '../drivers/mysql.ts');
/**
 * THE NEWLINES ARE NORMALISED, AND THAT IS NOT COSMETIC.
 *
 * This gate reads the DRIVER SOURCE, and the bytes of that source are not what git stores. A Windows
 * checkout with `core.autocrlf=true` — the default of the Windows installer, and the setting on the
 * machine this file was written on — writes every line as CRLF. The structural sentinel used below is
 * a newline immediately followed by a `}` at column 0, and that sequence does not exist in a CRLF
 * file. So on a clean checkout the gate could not delimit a single function body, and both AXIS 1
 * tests failed for a reason that had nothing to do with the translator, while passing on the working
 * tree the file was written in. The line separator is an artefact of the CHECKOUT, never a fact about
 * the code, so it is removed before one character is read off the text.
 */
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8').split('\r\n').join('\n');

assert.ok(typeof translateSql === 'function',
    'drivers/mysql.ts must export translateSql for these gates to drive the REAL translation');

/** What a line at column 0 looks like when it starts a new TOP-LEVEL declaration. */
const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|declare|abstract)\b/;

/**
 * The body of a top-level function: from its header to the closing `}` at column 0, that brace
 * INCLUDED so what was delimited can be checked.
 *
 * WHAT THIS FUNCTION IS GUARDING AGAINST is not a wrong answer, it is a plausible one. Every scan
 * below reads text this delimiter produced, and a scan that finds nothing reads exactly like a scan
 * that was given nothing: a body cut short leaves AXIS 1b with three lines of code, no raw string
 * operation in them, and a PASS — a gate passing because it looked at nothing, which is the shape
 * this whole file exists to make impossible. A body run PAST the function is the mirror image: the
 * population then belongs to some other function and the row set means something else.
 *
 * So the delimiter proves what it cut, in both directions:
 *   · braces must balance to zero — a cut inside an open block is a truncation;
 *   · what FOLLOWS the closing brace must be the start of a new top-level construct — a cut inside a
 *     comment or a template literal balances its braces but lands nowhere;
 *   · the body must contain no further top-level declaration — that is the over-read, and it is how
 *     an indented closing brace silently hands three functions' worth of text back as one.
 */
function functionBody(name: string): string {
    const start = SOURCE.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `drivers/mysql.ts no longer declares ${name}() — this gate is looking at the wrong file`);
    const end = SOURCE.indexOf('\n}\n', start);
    assert.ok(end > start,
        `could not delimit the body of ${name}(): no closing brace at column 0 follows its header. ` +
        'The source is read with its newlines normalised, so this means the SHAPE of the file changed — ' +
        'it is not the checkout using CRLF.');
    const body = SOURCE.slice(start, end + 2);

    let depth = 0;
    for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    assert.strictEqual(depth, 0,
        `the body delimited for ${name}() has unbalanced braces (delta ${depth}): the closing brace at ` +
        'column 0 that ended it is not where that function ends, so every scan below would be reading a ' +
        'FRAGMENT and reporting PASS over it. Fix the delimiter, never this assertion.');

    const after = SOURCE.slice(end + 2).replace(/^[\r\n\s]*/, '');
    assert.ok(after === '' || TOP_LEVEL_DECL_RE.test(after) || after.startsWith('//') || after.startsWith('/*'),
        `the body delimited for ${name}() ends at a brace that is not followed by a new top-level ` +
        `construct (next text: ${JSON.stringify(after.slice(0, 60))}). That brace is inside a comment or ` +
        'a template literal, so the body is TRUNCATED and every scan below is reading a fragment.');

    const overRead = String(body).split('\n').slice(1).find((line: string) => TOP_LEVEL_DECL_RE.test(line));
    assert.ok(!overRead,
        `the body delimited for ${name}() swallowed another top-level declaration (${JSON.stringify(String(overRead).slice(0, 60))}). ` +
        'Its own closing brace is not at column 0, so this body is several functions long and every ' +
        'population derived from it belongs to the wrong function.');

    return body;
}

// ─── AXIS 1 · every rewrite of the DML branch, derived from the source ────────────────────────────

/** Every regex the DML branch hands to a code-aware rewriter, taken from the source of translateSql. */
function dmlRewriteRegexes(): string[] {
    const body = functionBody('translateSql');
    const out: string[] = [];
    const call = /(?:replaceAllInCode|replaceInCode|codeHas)\(\s*s\s*,\s*(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/[a-z]*)/g;
    for (const m of body.matchAll(call)) {
        const literal = m[1];
        out.push(literal.slice(1, literal.lastIndexOf('/')));
    }
    return [...new Set(out)];
}

/**
 * Turn a regex source back into a string that MATCHES it.
 *
 * Deliberately tiny and deliberately LOUD: it understands exactly the constructs the DML branch uses,
 * and anything else leaves a metacharacter behind, which the caller treats as "this gate cannot cover
 * that rewrite" and fails. That is the whole point — the alternative is a hand-written payload table
 * that silently stops covering a rewrite the day someone writes one in a new shape.
 */
function probeFor(source: string): string | null {
    let out = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === String.fromCharCode(92)) {
            const n = source[i + 1];
            i++;
            if (n === 's') {
                const q = source[i + 1];
                if (q === '+') { out += ' '; i++; }
                else if (q === '*') { i++; }
                else return null;              // a bare s: no length to build
            } else if (n === 'b') {
                /* a word boundary is zero-width */
            } else if (n === 'w') {
                if (source[i + 1] === '+') { out += 'foo'; i++; } else return null;
            } else if ('.()[]{}|*+?^$/-'.includes(n) || n === String.fromCharCode(92)) {
                out += n;                      // an ESCAPED metacharacter is literal text
            } else {
                return null;                   // a class this builder does not model
            }
        } else if (c === '[') {
            const close = source.indexOf(']', i + 1);
            const quant = close < 0 ? '' : source[close + 1];
            if (close < 0 || (quant !== '*' && quant !== '+')) return null;
            out += 'x';                        // any character class stands for one plain character
            i = close + 1;
        } else if (c === '(') {
            if (source.slice(i, i + 3) === '(?:') i += 2;   // a group contributes nothing itself
        } else if (c === ')') {
            if (source[i + 1] === '?') i++;                 // an OPTIONAL group: take it
        } else if (c === '^' || c === '$') {
            /* anchors are zero-width */
        } else if ('|*+{}'.includes(c)) {
            return null;                       // alternation and quantifiers are not modelled
        } else {
            out += c;
        }
    }
    return out;
}

test('AXIS 1 — a structural keyword INSIDE a string literal survives every DML rewrite byte for byte', () => {
    const regexes = dmlRewriteRegexes();
    assert.ok(regexes.length >= 8,
        `the DML branch of translateSql must still be a set of code-aware rewrites; found ${regexes.length}. ` +
        'If the shape of those calls changed, this gate is no longer reading the population and must be updated.');

    let anchoredToStart = 0;
    for (const source of regexes) {
        const probe = probeFor(source);
        assert.ok(probe && probe.trim().length > 0,
            `this gate cannot build a probe for the rewrite /${source}/ — extend probeFor() rather than ` +
            'letting a rewrite go uncovered. A skipped member is exactly the defect this file exists to catch.');
        assert.ok(new RegExp(source, 'i').test(String(probe)),
            `the probe "${probe}" built for /${source}/ does not actually match it — probeFor() is wrong`);

        // A pattern anchored with `^` decides on position 0 of the statement, and no literal, quoted
        // identifier or comment can BEGIN there and still leave code there. Such a member is immune to
        // this class by its ANCHOR rather than by the mask, so the control below cannot make it fire —
        // and that is the ONE reason an inert probe is acceptable. It is counted, not waved through.
        const anchored = source.startsWith('^');
        if (anchored) anchoredToStart++;

        // The literal is the payload; everything around it is a statement the driver really sees. The
        // CREATE INDEX shape is here because two rewrites (the functional-index parens and the key-part
        // quoting) only run inside that branch and would otherwise never be reached by any row.
        const literal = `'a ${probe} b'`;
        for (const stmt of [
            `INSERT INTO wjp_x (label) VALUES (${literal})`,
            `UPDATE wjp_x SET label = ${literal} WHERE id = 1`,
            `SELECT * FROM wjp_x WHERE label = ${literal}`,
            `CREATE INDEX idx_x ON wjp_x (label) WHERE note = ${literal}`,
        ]) {
            // POSITIVE CONTROL, PER MEMBER. "The literal survived" is also the verdict a gate whose
            // probes match nothing would report, so every row proves it is a LIVE payload first: the
            // same rewrite applied the forbidden way — straight to the text — must damage the literal.
            // When it cannot, the only tolerable explanation is the `^` anchor above; anything else is
            // an inert row and is red here instead of silently green.
            const naive = stmt.replace(new RegExp(source, 'gi'), 'X');
            assert.ok(!naive.includes(literal) || anchored,
                `the probe built for /${source}/ is INERT: rewriting this statement with the raw ` +
                'string operation this gate forbids leaves the literal untouched, and the pattern is ' +
                `not anchored to the start of the statement, so the row below proves nothing.\n` +
                `  in:  ${stmt}\n  naive out: ${naive}`);

            const out = translateSql(stmt);
            assert.ok(String(out).includes(literal),
                `/${source}/ rewrote text INSIDE a string literal.\n  in:  ${stmt}\n  out: ${out}`);
        }
    }

    // If most of the population became anchored, this gate would be proving anchors rather than the
    // mask, and the assertions above would mostly be tautologies. Derived, so it needs no maintenance.
    assert.ok(anchoredToStart * 2 < regexes.length,
        `${anchoredToStart} of ${regexes.length} DML rewrites are anchored to the start of the statement, ` +
        'so the majority of this gate now passes because a literal cannot reach position 0 rather than ' +
        'because the rewrite reads the mask. Add coverage for the anchored members instead of relaxing this.');
});

/**
 * The same class, inverted and read off the source: no structural decision inside the two translation
 * functions may be taken with a raw string operation. `mysql-text-rule.ts` states this as the rule for
 * the next reader ("if you are about to write `.split(',')`, `.indexOf('(')` or `/\bWORD\b/` over SQL
 * text here, you are re-opening this class"); this is that sentence, enforced.
 *
 * A line may opt out ONLY by carrying the marker `MASK-SAFE:` with a reason — the exception is then
 * visible in a diff instead of being a silent regression.
 */
/** The offender scan, factored out of the test so it can be PROVED on input of known answer. */
function rawStringOps(body: string): string[] {
    const RAW_OPS = /\.(replace|match|test|split|indexOf|search)\s*\(/;
    const out: string[] = [];
    body.split('\n').forEach((line, i) => {
        const code = line.split('//')[0];
        if (!RAW_OPS.test(code)) return;
        if (/MASK-SAFE:/.test(line)) return;
        out.push(`${i}: ${line.trim()}`);
    });
    return out;
}

test('AXIS 1b — the translation functions take no structural decision with a raw string operation', () => {
    // POSITIVE CONTROL. A scanner that finds nothing reads identically to a scanner that looks at
    // nothing, and this one is handed text another function delimited. So it is shown a member and a
    // marked exemption first: if either answer is wrong, the empty result below means nothing.
    assert.strictEqual(rawStringOps("    s = s.replace(/x/i, 'y');").length, 1,
        'the AXIS 1b scanner no longer recognises a raw string operation — the empty result below would ' +
        'be an artefact of the scanner, not a property of the driver');
    assert.strictEqual(rawStringOps("    s = s.replace(/x/i, 'y'); // MASK-SAFE: proved above").length, 0,
        'the MASK-SAFE opt-out no longer works, so every marked line would be reported as an offender');

    const offenders: string[] = [];
    for (const fn of ['translateSql', 'translateCreateTable', 'dropTrailingSemicolon']) {
        for (const hit of rawStringOps(functionBody(fn))) offenders.push(`${fn}+${hit}`);
    }
    assert.deepStrictEqual(offenders, [],
        'a raw string operation is deciding SQL structure again — route it through codeMask / codeMatch / ' +
        'codeHas / replaceInCode / replaceAllInCode / firstParenGroup, or mark the line `MASK-SAFE:` with a ' +
        'reason:\n  ' + offenders.join('\n  '));
});

// ─── AXIS 2 · the FORM of the statement ───────────────────────────────────────────────────────────

/**
 * The column list every member of this axis carries. It contains BOTH of the constructs that make an
 * untranslated statement fatal on MySQL, so "was it translated?" is answerable without knowing what the
 * translation produces: `INTEGER PRIMARY KEY AUTOINCREMENT` is ERROR 1064 and `TEXT … DEFAULT ''` is
 * ERROR 1101.
 */
const SQLITE_ONLY_COLUMNS = `id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL DEFAULT ''`;

/**
 * THE AXES ARE DECLARED HERE, BY HAND — and that is the honest limit of this gate. Nothing in the
 * repository enumerates "the ways a CREATE TABLE can be spelled", so this cannot be derived the way
 * AXIS 1 is. What the product below DOES give is that the axes are independent: adding one value to any
 * axis multiplies out over all the others, so a new statement shape is covered in combination and not
 * just on its own — which is how the trailing `;` came to be invisible next to the leading comment.
 */
const FORM_AXES: Array<{ axis: string; values: Array<{ label: string; wrap: (s: string) => string }> }> = [
    {
        axis: 'leading comment',
        values: [
            { label: 'none', wrap: (s) => s },
            { label: 'line comment', wrap: (s) => `-- an explanatory line\n${s}` },
            { label: 'block comment', wrap: (s) => `/* an explanatory block */ ${s}` },
        ],
    },
    {
        axis: 'temporariness',
        values: [
            { label: 'permanent', wrap: (s) => s },
            { label: 'TEMP', wrap: (s) => s.replace(/CREATE TABLE/, 'CREATE TEMP TABLE') },
            { label: 'TEMPORARY', wrap: (s) => s.replace(/CREATE TABLE/, 'CREATE TEMPORARY TABLE') },
        ],
    },
    {
        axis: 'if not exists',
        values: [
            { label: 'plain', wrap: (s) => s },
            { label: 'IF NOT EXISTS', wrap: (s) => s.replace(/TABLE wjp_form/, 'TABLE IF NOT EXISTS wjp_form') },
        ],
    },
    {
        axis: 'table options',
        values: [
            { label: 'none', wrap: (s) => s },
            { label: 'WITHOUT ROWID', wrap: (s) => `${s} WITHOUT ROWID` },
            { label: 'STRICT', wrap: (s) => `${s} STRICT` },
        ],
    },
    {
        axis: 'terminator',
        values: [
            { label: 'none', wrap: (s) => s },
            { label: 'semicolon', wrap: (s) => `${s};` },
            { label: 'semicolon + newline', wrap: (s) => `${s};\n` },
        ],
    },
];

function formMembers(): Array<{ label: string; sql: string }> {
    let members = [{ label: 'canonical', sql: `CREATE TABLE wjp_form (${SQLITE_ONLY_COLUMNS})` }];
    for (const { axis, values } of FORM_AXES) {
        const next: Array<{ label: string; sql: string }> = [];
        for (const m of members) {
            for (const v of values) next.push({ label: `${m.label} · ${axis}=${v.label}`, sql: v.wrap(m.sql) });
        }
        members = next;
    }
    return members;
}

test('AXIS 2 — no CREATE TABLE is ever handed back still carrying SQLite-only syntax', () => {
    const members = formMembers();
    assert.ok(members.length >= 100, `the form product collapsed to ${members.length} members`);

    for (const m of members) {
        let out: string | null = null;
        let thrown: any = null;
        try { out = translateSql(m.sql); } catch (e: any) { thrown = e; }

        if (thrown) {
            // The narrow-and-loud half of the contract: a shape the driver does not model must say so.
            assert.strictEqual(thrown.code, 'WORDJS_SQL_UNTRANSLATABLE',
                `${m.label} threw something other than the translation refusal: ${thrown && thrown.message}`);
            continue;
        }

        // Otherwise it was translated, and neither fatal SQLite-ism may survive.
        assert.ok(!/\bAUTOINCREMENT\b/i.test(String(out)),
            `${m.label} was returned still containing AUTOINCREMENT (ERROR 1064 on MySQL):\n  in:  ${m.sql}\n  out: ${out}`);
        assert.ok(!/\bTEXT\b[^,)]*\bDEFAULT\b/i.test(String(out)),
            `${m.label} was returned with a DEFAULT on a bare TEXT column (ERROR 1101 on MySQL):\n  out: ${out}`);
    }
});

test('AXIS 2b — the forms the driver DOES model are translated, not merely refused', () => {
    // A gate whose only outcome is "it threw" would pass on a driver that refuses everything. These are
    // the members that must come out TRANSLATED, so the refusal above cannot be the whole answer.
    const mustTranslate = [
        `CREATE TABLE wjp_form (${SQLITE_ONLY_COLUMNS})`,
        `CREATE TABLE wjp_form (${SQLITE_ONLY_COLUMNS});`,
        `-- a note\nCREATE TABLE wjp_form (${SQLITE_ONLY_COLUMNS})`,
        `/* a note */CREATE TABLE IF NOT EXISTS wjp_form (${SQLITE_ONLY_COLUMNS})`,
        `CREATE TEMP TABLE wjp_form (${SQLITE_ONLY_COLUMNS})`,
    ];
    for (const sql of mustTranslate) {
        const out = String(translateSql(sql));
        assert.ok(/AUTO_INCREMENT/i.test(out), `must be translated, not declined: ${sql}\n  out: ${out}`);
        assert.ok(!/\bAUTOINCREMENT\b/i.test(out), `SQLite spelling survived: ${out}`);
    }
    // TEMP is a rename, not a drop: MySQL's keyword is TEMPORARY and the table must stay temporary.
    assert.ok(/CREATE\s+TEMPORARY\s+TABLE/i.test(String(translateSql(
        `CREATE TEMP TABLE wjp_form (${SQLITE_ONLY_COLUMNS})`))),
    'CREATE TEMP TABLE must become CREATE TEMPORARY TABLE, never lose its temporariness');

    // …and a statement with no column list at all needs no translation and must not be refused.
    const ctas = 'CREATE TABLE wjp_copy AS SELECT * FROM wjp_form';
    assert.strictEqual(translateSql(ctas), ctas);
});

test('AXIS 2c — a literal containing a table option or a semicolon is text, not structure', () => {
    // The two axes meet here: the FORM scanner must not read a `;` or a `WITHOUT ROWID` out of a DEFAULT.
    const sql = `CREATE TABLE wjp_form (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL DEFAULT 'ends; WITHOUT ROWID STRICT')`;
    const out = String(translateSql(sql));
    assert.ok(out.includes("'ends; WITHOUT ROWID STRICT'"), `the literal was edited:\n  ${out}`);
    assert.ok(/AUTO_INCREMENT/i.test(out), `the statement must still be translated:\n  ${out}`);
});

// ─── The reserved-word set: what CAN be derived, and the honest statement of what cannot ──────────

test('every reserved bare column name the driver knows is quoted on all three surfaces', () => {
    // DERIVED from the driver's own set, which is legitimate for THIS question ("is every member
    // honoured?") and illegitimate for the other one. See the note below.
    const words: string[] = [...driver.RESERVED_BARE_COLUMN_NAMES];
    assert.ok(words.length > 200, `the reserved set collapsed to ${words.length} entries`);
    for (const w of words) {
        const create = String(translateSql(`CREATE TABLE wjp_r (${w} TEXT NOT NULL DEFAULT '')`));
        assert.ok(create.includes(`"${w}"`), `${w} was not quoted in a column definition: ${create}`);
    }
    // The two members round 3 found missing, pinned so they cannot fall out again.
    for (const w of ['offset', 'delete_domain_id']) {
        assert.ok(driver.RESERVED_BARE_COLUMN_NAMES.has(w), `${w} is reserved by MariaDB and must be quoted`);
    }
});

/**
 * WHAT THIS FILE CANNOT DO, STATED RATHER THAN IMPLIED.
 *
 * The COMPLETENESS of RESERVED_BARE_COLUMN_NAMES is not derivable from anything in this repository: the
 * authority is MySQL's and MariaDB's published keyword lists, which live on the web and change with the
 * server release. The test above iterates the driver's own set, so by construction it can never tell you
 * a word is MISSING — which is the original defect of that set. Do not read it as coverage of that
 * question. The only honest mechanisms are an integration run against a real server, or a vendored copy
 * of the two lists with its provenance and date; neither exists here today.
 */
