/**
 * WAVE 4 — THE CLASSES BEHIND THE POSTS SURFACE, TESTED AS CLASSES.
 *
 * Three waves fixed this file's defects one EXAMPLE at a time: `key` was fixed and `status` was left,
 * one field over, in the same request, in the same wave — and `status` is the field that decides
 * whether a contributor's text appears on the public internet. The tests below therefore refuse to
 * enumerate cases. Each one ITERATES a table:
 *
 *   1. TYPE CONFUSION AT THE BOUNDARY — every string-typed request field × every non-string shape.
 *      The field list is READ OUT OF routes/posts.ts's own source, and a completeness test re-derives
 *      the destructured field names from that same source: a field added to the route and not to a
 *      table fails here, loudly, instead of becoming the next wave's critical.
 *   2. ATTACKER-CHOSEN OBJECT KEYS — every prototype-manipulating name, on the write path AND on the
 *      read path (a row that predates the write rule must not pollute either).
 *   3. THE COLLATION GAP — every protected key × every zero-weight code point × every position.
 *   4. THE BOUND AT THE WRITE — every writer of posts.post_name, including the ones that do not go
 *      through sanitizeTitle.
 *   5. THE PRODUCT JOURNEYS the previous waves broke: a published PAGE hidden behind an unpublished
 *      post, and a WordPress migration that loses the file path of every attachment.
 *
 * Same config-repoint-first pattern as verify-posts-remediation.test.ts.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-reqfields-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const Media = require('../models/Media');
const postTypes = require('../core/post-types');
const {
    PROTECTED_POST_META, RESERVED_META_KEYS, MAX_META_KEY_LENGTH,
    isProtectedPostMeta, metaKeyProblem, canonicalMetaKey, IGNORABLE_RANGES,
} = require('../core/protected-meta');
const { MAX_SLUG_LENGTH } = require('../core/formatting');
const { importWxr } = require('../core/wxr-import');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

const statusOf = async (id: number) => (await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [id])).post_status;
const nameOf = async (id: number) => (await dbAsync.get('SELECT post_name FROM posts WHERE id = ?', [id])).post_name;
const rawMeta = async (postId: number, key: string): Promise<string | null> => {
    const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
    return row ? row.meta_value : null;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE TABLES ARE READ OUT OF THE IMPLEMENTATION'S SOURCE.
//
// Not to mirror it — the completeness test below turns that around and proves the source's OWN
// destructured field names are all accounted for. Reading the tables means a field ADDED to a table
// is immediately driven through every shape by the loops, with no second list to keep in sync; the
// destructure cross-check means a field added to the ROUTE and to neither table fails the suite.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'posts.ts'), 'utf8');

function readTable(name: string): string[] {
    const m = ROUTE_SRC.match(new RegExp(`const ${name}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
    assert.ok(m, `routes/posts.ts must declare ${name} — the boundary normalizer is the fix for the whole class`);
    return (m![1].match(/'([^']+)'/g) || []).map((s: string) => s.slice(1, -1));
}

const BODY_STRING_FIELDS = readTable('POST_BODY_STRING_FIELDS');
const BODY_NON_STRING_FIELDS = readTable('POST_BODY_NON_STRING_FIELDS');
const QUERY_STRING_FIELDS = readTable('LIST_QUERY_STRING_FIELDS');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE POPULATION IS THE SYNTAX TREE, NOT ONE SYNTACTIC FORM.
//
// ROUND-3 FINDING (verify3 #6): the completeness gate did read the source — but through the regex
// /const\s*\{([^{}]*?)\}\s*=\s*req\.(body|query)/, which recognises ONE shape. Measured against real
// mutations of routes/posts.ts:
//   (A) a name added to a destructuring          → caught;
//   (B) `const x = req.body.x;`                  → INVISIBLE, suite green;
//   (C) a brace-carrying default in the SAME destructuring (`const { key, value, opts = {} } =
//       req.body || {}`) → `[^{}]` stopped matching and `key` and `value` VANISHED from the derived
//       set too, so the gate went blinder while staying green.
// Three live counterexamples already existed: req.query.type (:465), req.query.force (:1032) and
// req.body?.translationId (:1259) — and `force` is in NO table, while the gate reported nothing
// missing. `PUT /posts/:id/language` slipped through the same hole.
//
// So the reads are collected from the AST: destructurings, `req.body.x`, `req.body?.x` and
// `req.body['x']` alike. A computed read the gate cannot NAME is a hard failure rather than a silent
// omission, and the walk is cross-checked against a raw text count so it can never go quietly blind.
//
// A read is ACCOUNTED FOR when either
//   · its name is in one of the three tables (so the boundary normalizer covers it), or
//   · every one of its read sites NARROWS the value on the spot — `=== 'literal'`, `typeof … ===`,
//     or parseInt/Number(...). That is a mechanical property of the read, not a name on a list:
//     `req.query.force === 'true'` answers false for an Array exactly as it does for a wrong string,
//     which is the fail-safe direction.
// Anything else fails, by name and line.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ts = require('typescript');

interface FieldRead { name: string; line: number; narrowed: boolean; via: string }

/** `req.body`, `req.query`, and the `(req.body || {})` spelling — the bags a caller controls. */
function isRequestBag(text: string): boolean {
    return /^\(?\s*req\.(body|query)(\s*\|\|\s*\{\s*\})?\s*\)?$/.test(text.trim());
}

/** Is THIS read immediately narrowed to a safe shape at the read site? */
function readIsNarrowed(node: any, sf: any): boolean {
    let cur = node;
    let parent = node.parent;
    if (parent && ts.isNonNullExpression(parent)) { cur = parent; parent = parent.parent; }
    if (!parent) return false;
    // typeof req.body.x === 'string'
    if (ts.isTypeOfExpression(parent)) return true;
    // req.query.force === 'true'   (either side)
    if (ts.isBinaryExpression(parent)) {
        const op = parent.operatorToken.kind;
        const isEquality = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken
            || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
        if (!isEquality) return false;
        const other = parent.left === cur ? parent.right : parent.left;
        return !!other && ts.isStringLiteral(other);
    }
    // parseInt(req.body.translationId, 10) and friends — a non-string collapses to NaN, never to a value.
    if (ts.isCallExpression(parent) && parent.arguments.indexOf(cur) === 0) {
        return ['parseInt', 'parseFloat', 'Number'].includes(parent.expression.getText(sf));
    }
    return false;
}

/** EVERY name routes/posts.ts reads out of req.body / req.query, however it is written. */
function requestFieldReads(src: string): { reads: FieldRead[]; bagReferences: number } {
    const sf = ts.createSourceFile('posts.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const reads: FieldRead[] = [];
    let bagReferences = 0;
    const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    // ALIASES OF THE BAG. `const body = req.body` and then `body.status` is the same read written one
    // refactor later, and the text test below (`isRequestBag`) would not have recognised it — the same
    // shape of blindness round 4 demonstrated against the throttle scanner (an alias is not a new
    // channel, it is the same channel spelled differently). No alias exists in routes/posts.ts today;
    // this is what keeps that true. Propagated to a fixed point so an alias of an alias joins as well.
    const bagAliases = new Set<string>();
    const collectAliases = (node: any): void => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
            const text = node.initializer.getText(sf).trim();
            if (isRequestBag(text) || bagAliases.has(text.replace(/^\(|\)$/g, ''))) bagAliases.add(node.name.text);
        }
        ts.forEachChild(node, collectAliases);
    };
    for (let pass = 0; pass < 4; pass++) { const before = bagAliases.size; collectAliases(sf); if (bagAliases.size === before) break; }
    const isBag = (text: string) => isRequestBag(text) || bagAliases.has(text.trim().replace(/^\(|\)$/g, ''));

    const visit = (node: any): void => {
        // `req.body` / `req.query` itself, counted for the anti-blindness check below.
        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
            && ts.isIdentifier(node.expression) && node.expression.text === 'req'
            && ts.isPropertyAccessExpression(node) && ['body', 'query'].includes(node.name.text)) {
            bagReferences++;
        }
        // const { a, b = {}, c: renamed } = req.body | req.query | (req.body || {})
        if (ts.isVariableDeclaration(node) && node.initializer && isBag(node.initializer.getText(sf))
            && ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
                const key = el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf);
                reads.push({ name: key.replace(/^['"]|['"]$/g, ''), line: lineOf(el), narrowed: false, via: 'destructuring' });
            }
        }
        // req.body.x / req.query.x / req.body?.x
        if (ts.isPropertyAccessExpression(node) && isBag(node.expression.getText(sf))) {
            reads.push({ name: node.name.text, line: lineOf(node), narrowed: readIsNarrowed(node, sf), via: 'member access' });
        }
        // req.body['x'] — literal only; a COMPUTED key is a read this gate cannot name, so it fails.
        if (ts.isElementAccessExpression(node) && isBag(node.expression.getText(sf))) {
            const arg = node.argumentExpression;
            assert.ok(arg && ts.isStringLiteral(arg),
                `routes/posts.ts:${lineOf(node)} reads req.body/req.query with a COMPUTED key ` +
                `(\`${node.getText(sf)}\`). This gate cannot enumerate what that reads, so it cannot claim ` +
                'coverage — read the field by name, or state the exception here on purpose.');
            reads.push({ name: (arg as any).text, line: lineOf(node), narrowed: readIsNarrowed(node, sf), via: 'index access' });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { reads, bagReferences };
}

/** Reads that neither appear in a table nor narrow themselves at the read site. */
function unaccountedReads(src: string): string[] {
    const known = new Set([...BODY_STRING_FIELDS, ...BODY_NON_STRING_FIELDS, ...QUERY_STRING_FIELDS]);
    const { reads } = requestFieldReads(src);
    const byName = new Map<string, FieldRead[]>();
    for (const r of reads) byName.set(r.name, [...(byName.get(r.name) || []), r]);
    const out: string[] = [];
    for (const [name, sites] of byName) {
        if (known.has(name)) continue;
        if (sites.every((s) => s.narrowed)) continue;   // narrowed at EVERY site, not just one
        const where = sites.filter((s) => !s.narrowed).map((s) => `posts.ts:${s.line} (${s.via})`).join(', ');
        out.push(`${name} — ${where}`);
    }
    return out.sort();
}

/** A plausible legitimate value per field — the array shape wraps THIS, which is what the driver flattens. */
const SAMPLE: Record<string, string> = {
    title: 'A title', content: '<p>body</p>', excerpt: 'x', status: 'publish', type: 'post',
    slug: 'a-slug', comment_status: 'closed', date: new Date(Date.now() + 86_400_000).toISOString(),
    language: 'pt-BR', search: 'a', orderby: 'title', order: 'asc', page: '1', per_page: '5', author: '1',
};

/** The non-string shapes a JSON body / a qs-parsed query can deliver for ANY field. */
const nonStringShapes = (legit: string): Array<{ label: string; value: any }> => ([
    { label: 'single-element array (drivers flatten it back to the string)', value: [legit] },
    { label: 'two-element array', value: [legit, legit] },
    { label: 'object', value: { toString: legit } },
    { label: 'number', value: 7 },
    { label: 'boolean', value: true },
    { label: 'nested array', value: [[legit]] },
]);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    await postTypes.initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('contributor', 'contributor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// CLASS 1 — a request field the code compares against a literal/Set can arrive as a non-string.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: every string request field is a string, or the request is a 400', () => {
    test('the field tables cover EVERY name the routes READ out of req.body/req.query', () => {
        // ANTI-BLINDNESS: the walk must account for every textual `req.body`/`req.query`. If the two ever
        // disagree the AST walk is missing reads, and a gate that sees fewer reads than exist is exactly
        // the failure this rewrite is about — it must say so instead of reporting "nothing missing".
        const code = ROUTE_SRC
            .replace(/\/\*[\s\S]*?\*\//g, '\n')
            .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
        const textual = (code.match(/\breq\.(body|query)\b/g) || []).length;
        const { bagReferences } = requestFieldReads(ROUTE_SRC);
        assert.strictEqual(bagReferences, textual,
            `the AST walk saw ${bagReferences} req.body/req.query references but the code contains ${textual} — the walk is blind to one`);

        assert.deepStrictEqual(unaccountedReads(ROUTE_SRC), [],
            'a request field is read by routes/posts.ts and appears in NO table, and the read does not narrow '
            + 'the value on the spot: add it to POST_BODY_STRING_FIELDS (and it is covered automatically), or to '
            + 'POST_BODY_NON_STRING_FIELDS with the reason it is checked elsewhere. This assertion is the whole '
            + 'point of the tables.');
    });

    test('THE GATE IS FALSIFIABLE: a field read in ANY shape turns this red', () => {
        // A GATE IS ONLY REAL IF ADDING A MEMBER TURNS IT RED. The previous regex was green for four of
        // the five mutations below. Each is appended to the REAL source and driven through the REAL
        // derivation, so this is the mutation proof, re-run on every CI run.
        const mutations: Array<[string, string, string]> = [
            ['destructured (the only shape the old regex saw)',
                'router.put("/zz", async (req: any) => { const { newFeatureFlag } = req.body; return newFeatureFlag; });',
                'newFeatureFlag'],
            ['plain member access',
                'router.put("/zz", async (req: any) => { const v = req.body.newFeatureFlag; return v; });',
                'newFeatureFlag'],
            ['optional chaining',
                'router.put("/zz", async (req: any) => { const v = req.body?.newFeatureFlag; return v; });',
                'newFeatureFlag'],
            ['index access with a literal key',
                'router.put("/zz", async (req: any) => { const v = req.query["newFeatureFlag"]; return v; });',
                'newFeatureFlag'],
            ['a query field read straight into a comparison against a non-literal',
                'router.get("/zz", async (req: any) => { const v = req.query.newFeatureFlag; return v === wanted; });',
                'newFeatureFlag'],
            // ROUND-4 CLASS (the alias, demonstrated against the throttle scanner in verify4 #10): the bag
            // held in a local is the SAME channel one refactor later, and a reader that matches the TEXT
            // `req.body` cannot see it. routes/posts.ts has no such alias today; these two rows are what
            // keeps that from becoming a silent hole the first time someone writes one.
            ['the bag aliased into a local, then read',
                'router.put("/zz", async (req: any) => { const body = req.body || {}; return body.newFeatureFlag; });',
                'newFeatureFlag'],
            ['the bag aliased into a local, then destructured',
                'router.put("/zz", async (req: any) => { const body = req.body; const { newFeatureFlag } = body; return newFeatureFlag; });',
                'newFeatureFlag'],
            ['an alias of the alias',
                'router.put("/zz", async (req: any) => { const b1 = req.body; const b2 = b1; return b2["newFeatureFlag"]; });',
                'newFeatureFlag'],
        ];
        for (const [label, mutation, name] of mutations) {
            const found = unaccountedReads(`${ROUTE_SRC}\n${mutation}\n`);
            assert.ok(found.some((f) => f.startsWith(`${name} `)),
                `MUTATION SURVIVED — "${label}" reads ${name} out of the request and no table mentions it, `
                + `yet the gate reported: ${JSON.stringify(found)}`);
        }

        // CASE (C) FROM THE FINDING: a default value with braces in the SAME destructuring used to make
        // the regex stop matching, so `key` and `value` DISAPPEARED from the derived set as well — the
        // gate got blinder and stayed green. The AST cannot lose them.
        const braces = 'router.post("/zz", async (req: any) => { const { key, value, opts = {} } = req.body || {}; return [key, value, opts]; });';
        const names = requestFieldReads(`${ROUTE_SRC}\n${braces}\n`).reads.map((r) => r.name);
        for (const kept of ['key', 'value']) {
            assert.ok(names.includes(kept), `an inner brace made the derivation lose ${kept} — the gate went blind quietly`);
        }
        assert.ok(unaccountedReads(`${ROUTE_SRC}\n${braces}\n`).some((f) => f.startsWith('opts ')),
            'the new field in a brace-carrying destructuring was not reported');

        // A COMPUTED read cannot be enumerated at all, so it must fail LOUDLY rather than pass silently.
        assert.throws(
            () => unaccountedReads(`${ROUTE_SRC}\nrouter.put("/zz", async (req: any) => req.body[someName]);\n`),
            (e: any) => e instanceof assert.AssertionError);

        // CONTROL: the real source is clean, so the assertions above are not failing for another reason.
        assert.deepStrictEqual(unaccountedReads(ROUTE_SRC), []);
    });

    test('the fields that are accounted for WITHOUT a table entry are narrowed at the read site', () => {
        // The honest limit of the rule above, pinned: these reads never enter the tables, so the ONLY
        // thing that makes them safe is the shape of the read itself. If someone widens one of these
        // reads (drops the `=== 'true'`, or assigns it to a variable first), it becomes unaccounted and
        // the previous test fails — which is the behaviour we want, not an exemption list.
        const known = new Set([...BODY_STRING_FIELDS, ...BODY_NON_STRING_FIELDS, ...QUERY_STRING_FIELDS]);
        const narrowedOnly = requestFieldReads(ROUTE_SRC).reads.filter((r) => !known.has(r.name));
        for (const r of narrowedOnly) {
            assert.strictEqual(r.narrowed, true, `${r.name} at posts.ts:${r.line} is in no table and is not narrowed`);
        }
        // …and there is at least one, so this assertion is not vacuously true.
        assert.ok(narrowedOnly.length >= 1, 'no narrowed-only read found — re-check the derivation, it may be blind');
    });

    test('the table itself is not empty and contains the field that decides public visibility', () => {
        assert.ok(BODY_STRING_FIELDS.length >= 5);
        assert.ok(BODY_STRING_FIELDS.includes('status'), 'status is THE field of this class');
        assert.ok(BODY_STRING_FIELDS.includes('type'));
        assert.ok(BODY_STRING_FIELDS.includes('slug'));
    });

    test('POST /posts refuses every non-string shape of every string field', async () => {
        for (const field of BODY_STRING_FIELDS) {
            for (const shape of nonStringShapes(SAMPLE[field] || 'x')) {
                const body: any = { title: 'ok' };
                body[field] = shape.value;
                const res = await as('admin', 'post', '/posts').send(body);
                assert.strictEqual(res.status, 400,
                    `POST /posts accepted ${field} as ${shape.label} (status ${res.status})`);
                assert.strictEqual(res.body.code, 'rest_invalid_param', `${field}: wrong error code`);
            }
        }
    });

    test('PUT /posts/:id refuses every non-string shape of every string field', async () => {
        const own = await as('admin', 'post', '/posts').send({ title: 'target', status: 'draft' });
        assert.strictEqual(own.status, 201);
        for (const field of BODY_STRING_FIELDS) {
            for (const shape of nonStringShapes(SAMPLE[field] || 'x')) {
                const body: any = {};
                body[field] = shape.value;
                const res = await as('admin', 'put', `/posts/${own.body.id}`).send(body);
                assert.strictEqual(res.status, 400,
                    `PUT /posts/:id accepted ${field} as ${shape.label} (status ${res.status})`);
            }
        }
        assert.strictEqual(await statusOf(own.body.id), 'draft', 'no rejected shape reached the row');
    });

    test('GET /posts refuses every non-string shape of every query field it reads', async () => {
        // A query string has no numbers and no booleans — the shapes a caller CAN build here are the
        // bracket forms Express's parser turns into arrays and objects, which is exactly the family
        // `?type[]=post` came from. Written as raw query strings because supertest's own serializer
        // is not the thing under test.
        const queryShapes = (f: string, v: string) => ([
            { label: 'single-element array', qs: `${f}[]=${encodeURIComponent(v)}` },
            { label: 'two-element array', qs: `${f}[]=${encodeURIComponent(v)}&${f}[]=${encodeURIComponent(v)}` },
            { label: 'object', qs: `${f}[key]=${encodeURIComponent(v)}` },
            { label: 'nested array', qs: `${f}[][]=${encodeURIComponent(v)}` },
        ]);

        for (const field of QUERY_STRING_FIELDS) {
            for (const shape of queryShapes(field, SAMPLE[field] || 'x')) {
                const res = await anon('get', `/posts?${shape.qs}`);
                assert.strictEqual(res.status, 400,
                    `GET /posts accepted ${field} as ${shape.label} (${shape.qs}) — status ${res.status}`);
            }
        }
    });

    // The JOURNEY, not the shape: this is the critical, end to end.
    test('THE CRITICAL: a contributor cannot publish with status=[publish] (create or update)', async () => {
        // Control: the honest form is downgraded, and that still works.
        const control = await as('contributor', 'post', '/posts').send({ title: 'ctl', status: 'publish' });
        assert.strictEqual(control.status, 201);
        assert.strictEqual(await statusOf(control.body.id), 'pending', 'precondition: the publish gate downgrades');

        for (const payload of [['publish'], ['future'], [['publish']]]) {
            const res = await as('contributor', 'post', '/posts').send({ title: 'exploit', status: payload });
            assert.strictEqual(res.status, 400, `status ${JSON.stringify(payload)} was accepted with ${res.status}`);
        }
        const live = await dbAsync.all(
            `SELECT id FROM posts WHERE author_id = ? AND post_status IN ('publish','future')`, [U.contributor]);
        assert.strictEqual(live.length, 0, 'a contributor published to the public site');

        // The PUT twin, on the caller's own pending post.
        const put = await as('contributor', 'put', `/posts/${control.body.id}`).send({ status: ['publish'] });
        assert.strictEqual(put.status, 400);
        assert.strictEqual(await statusOf(control.body.id), 'pending');

        // And the anonymous public list still shows nothing of theirs.
        const list = await anon('get', '/posts').query({ per_page: '100' });
        assert.strictEqual(list.status, 200);
        assert.ok(!list.body.some((p: any) => p.title?.rendered === 'exploit'), 'the entry is live on the public API');
    });

    test('REGRESSION GUARD: the ordinary string forms of every field still work', async () => {
        const res = await as('admin', 'post', '/posts').send({
            title: 'Ordinary', content: '<p>hi</p>', excerpt: 'e', status: 'publish', type: 'post',
            slug: 'ordinary-post', comment_status: 'closed', language: 'pt-BR',
            parent: '', menu_order: '', categories: [], tags: [], meta: { seo_title: 'S' },
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(await statusOf(res.body.id), 'publish');
        assert.strictEqual(await nameOf(res.body.id), 'ordinary-post');
        assert.strictEqual(await rawMeta(res.body.id, 'seo_title'), 'S');

        const list = await anon('get', '/posts').query({ status: 'publish', type: 'post', orderby: 'date', order: 'desc', page: '1', per_page: '10' });
        assert.strictEqual(list.status, 200);
    });

    test('the SINK refuses a non-string too, so the column does not depend on which door the write came through', async () => {
        await assert.rejects(
            () => Post.create({ authorId: U.admin, title: 'direct', status: ['publish'] }),
            /status must be a string/, 'Post.create let a driver decide what post_status becomes');
        await assert.rejects(
            () => Post.create({ authorId: U.admin, title: 'direct', type: ['page'] }),
            /type must be a string/);
        const ok = await Post.create({ authorId: U.admin, title: 'direct ok', status: 'draft' });
        await assert.rejects(() => Post.update(ok.id, { status: ['publish'] }), /status must be a string/);
        assert.strictEqual(await statusOf(ok.id), 'draft');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// CLASS 2 — a key is not just a string: attacker-chosen names that mean something to an object.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: an attacker-chosen meta key cannot choose what a map inherits', () => {
    const POLLUTING_VALUE = '{"seo_title":"POLLUTED","_wp_attached_file":"../../data/wordjs.db"}';

    test('every reserved name is refused by the FORM gate, in every decorated spelling', () => {
        for (const name of RESERVED_META_KEYS) {
            for (const spelling of [name, name.toUpperCase(), ` ${name} `, `${name}\u200b`, `${name}\u0000`]) {
                assert.strictEqual(metaKeyProblem(spelling), 'reserved',
                    `${JSON.stringify(spelling)} must be refused: it canonicalizes to ${canonicalMetaKey(spelling)}`);
            }
        }
    });

    test('POST /posts/:id/meta refuses every reserved name and the map stays clean', async () => {
        const p = await as('admin', 'post', '/posts').send({ title: 'proto target', status: 'draft' });
        const id = p.body.id;

        for (const name of RESERVED_META_KEYS) {
            const res = await as('admin', 'post', `/posts/${id}/meta`).send({ key: name, value: POLLUTING_VALUE });
            assert.strictEqual(res.status, 400, `key ${name} was accepted (${res.status})`);
        }

        const meta = await Post.getAllMeta(id);
        assert.strictEqual(Object.getPrototypeOf(meta), Object.prototype, 'the meta map prototype was replaced');
        assert.strictEqual(meta.seo_title, undefined, 'a key with no row resolved through the prototype chain');
        assert.strictEqual(meta['_wp_attached_file'], undefined);
    });

    test('a reserved-name ROW already in the database still cannot pollute the reader', async () => {
        // Rows predating the write rule, or arriving through an import, are the reason the READER is
        // hardened too — a fix on the write path alone would leave every existing install exposed.
        const p = await as('admin', 'post', '/posts').send({ title: 'legacy row', status: 'draft' });
        const id = p.body.id;
        for (const name of RESERVED_META_KEYS) {
            await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
                [id, name, POLLUTING_VALUE]);
        }

        for (const meta of [await Post.getAllMeta(id), (await Post.getAllMetaForIds([id]))[id]]) {
            assert.strictEqual(Object.getPrototypeOf(meta), Object.prototype);
            assert.strictEqual(meta.seo_title, undefined, 'the prototype chain leaked an attacker value');
            assert.strictEqual(meta['_wp_attached_file'], undefined);
            assert.ok(Object.prototype.hasOwnProperty.call(meta, '__proto__'),
                'the row must be present as an OWN property — visible, inert');
        }
        // And the object literal built anywhere downstream is unaffected.
        assert.strictEqual(({} as any).seo_title, undefined, 'Object.prototype itself was polluted');
    });

    test('the meta BAG skips the same names instead of writing them', async () => {
        const res = await as('admin', 'post', '/posts').send({
            title: 'bag', meta: JSON.parse(`{"__proto__":${JSON.stringify(POLLUTING_VALUE)},"ok_key":"kept"}`),
        });
        assert.strictEqual(res.status, 201);
        const meta = await Post.getAllMeta(res.body.id);
        assert.strictEqual(meta.ok_key, 'kept', 'a bad name in the bag must not lose the rest of the save');
        assert.strictEqual(meta.seo_title, undefined);
        assert.strictEqual(await rawMeta(res.body.id, '__proto__'), null);
    });

    test('the FORM gate also bounds the key at the column width, and rejects empty/whitespace keys', async () => {
        const p = await as('admin', 'post', '/posts').send({ title: 'form gate', status: 'draft' });
        const id = p.body.id;
        const cases: Array<[any, string]> = [
            ['k'.repeat(MAX_META_KEY_LENGTH + 1), 'too_long'],
            ['', 'empty'],
            ['   ', 'empty'],
            ['\u200b\u00ad', 'empty'],
            [['_puck_data'], 'type'],
            [{ a: 1 }, 'type'],
            [7, 'type'],
        ];
        for (const [key, reason] of cases) {
            assert.strictEqual(metaKeyProblem(key), reason, `metaKeyProblem(${JSON.stringify(key)})`);
            const res = await as('admin', 'post', `/posts/${id}/meta`).send({ key, value: 'x' });
            assert.strictEqual(res.status, 400, `key ${JSON.stringify(key)} was accepted (${res.status})`);
        }
        assert.strictEqual(metaKeyProblem('k'.repeat(MAX_META_KEY_LENGTH)), null, 'exactly at the bound is legal');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// CLASS 3 — the guard compares text the DATABASE will compare under a different collation.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: protected keys are refused in every spelling the column collation equates', () => {
    /** One sample from each declared zero-weight range, plus the folds already covered. */
    const IGNORABLE_SAMPLES: string[] = IGNORABLE_RANGES.map(([lo]: [number, number]) => String.fromCodePoint(lo));

    test('every protected key × every zero-weight code point × every position is protected', () => {
        assert.ok(IGNORABLE_SAMPLES.length >= 10, 'the ignorable table must cover the UCA zero-weight blocks');
        for (const key of PROTECTED_POST_META) {
            const mid = Math.floor(key.length / 2);
            for (const ch of IGNORABLE_SAMPLES) {
                const spellings = [
                    `${ch}${key}`,
                    `${key}${ch}`,
                    `${key.slice(0, mid)}${ch}${key.slice(mid)}`,
                ];
                for (const spelling of spellings) {
                    assert.strictEqual(isProtectedPostMeta(spelling), true,
                        `${key} decorated with U+${ch.codePointAt(0)!.toString(16).toUpperCase()} `
                        + `(${JSON.stringify(spelling)}) reached the protected row`);
                }
            }
            // The folds the previous wave added must keep working (case / accent / PAD SPACE).
            assert.strictEqual(isProtectedPostMeta(key.toUpperCase()), true);
            assert.strictEqual(isProtectedPostMeta(`${key} `), true);
        }
    });

    test('the ROUTE answers 403 for the decorated spellings, and the real row is untouched', async () => {
        const att = await Post.create({
            authorId: U.admin, title: 'att', type: 'attachment', status: 'inherit', slug: 'att-collation',
        });
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [att.id, '_wp_attached_file', '2026/08/keep.png']);

        for (const ch of ['\u0000', '\u00ad', '\u200b', '\ufeff', '\u2060']) {
            const res = await as('admin', 'post', `/posts/${att.id}/meta`)
                .send({ key: `_wp_attached_file${ch}`, value: '../../data/wordjs.db' });
            assert.strictEqual(res.status, 403,
                `U+${ch.codePointAt(0)!.toString(16)} decoration was written (${res.status})`);
        }
        assert.strictEqual(await rawMeta(att.id, '_wp_attached_file'), '2026/08/keep.png');
        const rows = await dbAsync.all('SELECT meta_key FROM post_meta WHERE post_id = ?', [att.id]);
        assert.strictEqual(rows.length, 1, 'a decorated twin row was created next to the protected one');
    });

    test('REGRESSION GUARD: author-written keys stay writable, including look-alikes', async () => {
        for (const k of ['_puck_data', '_wjs_template', '_thumbnail_id', 'seo_title', '_wjs_review_comments',
            '_wp_attached_file_backup', 'wp_attached_file', '_wp_attachment_image_alt']) {
            assert.strictEqual(isProtectedPostMeta(k), false, `${k} must remain writable`);
            assert.strictEqual(metaKeyProblem(k), null, `${k} must pass the form gate`);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// CLASS 4 — the bound belongs where the write happens, not only in the usual producer.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: every writer of posts.post_name is bounded', () => {
    const LONG = 'z'.repeat(400);
    const COLUMN_MAX = 255; // drivers/mysql-text-rule narrows post_name to VARCHAR(255) for its index

    test('every writer bounds the slug it stores', async () => {
        const writers: Array<{ label: string; write: () => Promise<number> }> = [
            {
                label: 'POST /posts with a body slug',
                write: async () => (await as('admin', 'post', '/posts').send({ title: 'long slug', slug: LONG })).body.id,
            },
            {
                label: 'POST /posts with a long TITLE and no slug',
                write: async () => (await as('admin', 'post', '/posts').send({ title: `${LONG} title` })).body.id,
            },
            {
                label: 'PUT /posts/:id with a body slug',
                write: async () => {
                    const p = await as('admin', 'post', '/posts').send({ title: 'to rename' });
                    await as('admin', 'put', `/posts/${p.body.id}`).send({ slug: LONG });
                    return p.body.id;
                },
            },
            {
                label: 'Post.create called directly with a slug (the importer\'s door)',
                write: async () => (await Post.create({ authorId: U.admin, title: 'direct slug', slug: LONG })).id,
            },
            {
                label: 'Post.generateUniqueSlug collision suffix',
                write: async () => (await Post.create({ authorId: U.admin, title: 'dup', slug: LONG })).id,
            },
        ];

        for (const w of writers) {
            const id = await w.write();
            assert.ok(id, `${w.label}: no row was created`);
            const stored = await nameOf(id);
            assert.ok(stored.length <= COLUMN_MAX,
                `${w.label}: stored ${stored.length} characters — ERROR 1406 on MySQL`);
            assert.ok(stored.length <= MAX_SLUG_LENGTH + 8,
                `${w.label}: stored ${stored.length} characters, past the declared bound ${MAX_SLUG_LENGTH}`);
        }
    });

    test('a request slug is PRODUCED, not accepted verbatim (the public URL segment)', async () => {
        const res = await as('admin', 'post', '/posts').send({ title: 'weird', slug: 'Not A Slug/../%00' });
        assert.strictEqual(res.status, 201);
        const stored = await nameOf(res.body.id);
        assert.ok(!stored.includes('/') && !stored.includes('..') && !stored.includes('%'),
            `post_name stored a path-shaped public URL segment verbatim: ${JSON.stringify(stored)}`);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// REGRESSION — a published PAGE must not disappear because someone drafted a post with its slug.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('REGRESSION: /posts/slug/:slug resolves among the rows the CALLER may see', () => {
    let pageId: number, draftId: number;

    // Seeding a status with raw SQL bypasses the model's cache invalidation, and findBySlug caches the
    // WHOLE row — so the helper drops the same keys Post.update would. (Doing it through PUT instead
    // would not work for every status: 'future' with a past stored date resolves straight to publish.)
    const cache = require('../core/cache');
    async function setStatus(id: number, type: string, slug: string, status: string) {
        await dbAsync.run('UPDATE posts SET post_status = ? WHERE id = ?', [status, id]);
        await cache.del(`post:id:${id}`);
        await cache.del(`post:slug:${type}:${slug}`);
        await cache.del(`post:slug:any:${slug}`);
    }

    test('a published page and an unpublished post may share a slug', async () => {
        const pg = await as('admin', 'post', '/posts').send({ title: 'About us', slug: 'about-x', status: 'publish', type: 'page' });
        assert.strictEqual(pg.status, 201);
        pageId = pg.body.id;
        const dr = await as('admin', 'post', '/posts').send({ title: 'About draft', slug: 'about-x', status: 'draft', type: 'post' });
        assert.strictEqual(dr.status, 201);
        draftId = dr.body.id;
        assert.strictEqual(await nameOf(pageId), 'about-x');
        assert.strictEqual(await nameOf(draftId), 'about-x', 'the collision must be real, not de-duplicated');
    });

    test('THE JOURNEY: the anonymous visitor still gets the PUBLISHED page', async () => {
        for (let i = 0; i < 3; i++) {
            const res = await anon('get', '/posts/slug/about-x');
            assert.strictEqual(res.status, 200, 'a live public URL 404s because someone saved a draft');
            assert.strictEqual(res.body.id, pageId);
        }
    });

    test('every unpublished status hides the post from the precedence, not the page', async () => {
        for (const status of ['draft', 'pending', 'private', 'future', 'trash']) {
            await setStatus(draftId, 'post', 'about-x', status);
            const res = await anon('get', '/posts/slug/about-x');
            assert.strictEqual(res.status, 200, `status=${status} hid the published page`);
            assert.strictEqual(res.body.id, pageId, `status=${status} resolved to the wrong row`);
        }
        await setStatus(draftId, 'post', 'about-x', 'draft');
    });

    test('a caller who MAY see the post still gets the post first (precedence preserved)', async () => {
        const res = await as('admin', 'get', '/posts/slug/about-x');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, draftId, 'the author/editor view must not lose its own draft');
    });

    test('?type= still decides identity, and a published post wins for the anonymous caller too', async () => {
        assert.strictEqual((await anon('get', '/posts/slug/about-x').query({ type: 'page' })).body.id, pageId);
        await setStatus(draftId, 'post', 'about-x', 'publish');
        assert.strictEqual((await anon('get', '/posts/slug/about-x')).body.id, draftId, 'post keeps precedence when visible');
        await setStatus(draftId, 'post', 'about-x', 'draft');
    });

    test('the slug route and the LIST agree about what a type IS', async () => {
        // INTERNAL: refused by both.
        assert.strictEqual((await anon('get', '/posts/slug/about-x').query({ type: 'nav_menu_item' })).status, 400);
        assert.strictEqual((await anon('get', '/posts').query({ type: 'nav_menu_item' })).status, 400);
        // UNREGISTERED: accepted by both — the list returns rows, the slug route returns "no such slug".
        const list = await anon('get', '/posts').query({ type: 'not_a_type' });
        assert.strictEqual(list.status, 200, 'precondition: the list accepts an unregistered type');
        const slug = await anon('get', '/posts/slug/about-x').query({ type: 'not_a_type' });
        assert.strictEqual(slug.status, 404,
            'two guards contradict each other about the same invariant (400 here, 200 in the list)');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// REGRESSION — a WordPress migration must not lose the file path of every attachment.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('REGRESSION: the WXR importer keeps an attachment\'s path (a CORE-OWNED write)', () => {
    const attachmentItem = (id: string, name: string, attached: string, extra = '') => `
    <item>
      <title>${name}</title>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>${id}</wp:post_id>
      <wp:post_name>${name}</wp:post_name>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:post_parent>0</wp:post_parent>
      <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[${attached}]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value><![CDATA[alt text]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_edit_lock</wp:meta_key><wp:meta_value><![CDATA[1700000000:1]]></wp:meta_value></wp:postmeta>
      ${extra}
    </item>`;

    const XML = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Src</title>
    <wp:wxr_version>1.2</wp:wxr_version>
    ${items}
  </channel>
</rss>`;

    test('THE JOURNEY: an imported attachment resolves to its file, thumbnails included', async () => {
        const metadata = JSON.stringify({
            width: 800, height: 600, file: '2024/01/photo.jpg',
            sizes: { thumbnail: { file: 'photo-150x150.jpg', width: 150, height: 150 } },
        });
        const xml = XML(attachmentItem('9001', 'photo-a', '2024/01/photo.jpg',
            `<wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[${metadata}]]></wp:meta_value></wp:postmeta>`));

        const summary = await importWxr(xml, { defaultAuthorId: U.admin, importAttachments: true });
        assert.strictEqual(summary.attachments.created, 1, JSON.stringify(summary));

        const row = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'photo-a' AND post_type = 'attachment'`);
        assert.ok(row, 'the attachment row was not created');

        assert.strictEqual(await rawMeta(row.id, '_wp_attached_file'), '2024/01/photo.jpg',
            'EVERY migrated attachment lost its path — the media library shows an item with no file');

        const media = await Media.findById(row.id);
        assert.strictEqual(media.sourceUrl, '/uploads/2024/01/photo.jpg');
        assert.strictEqual(media.mediaDetails.file, '2024/01/photo.jpg');
        assert.strictEqual(media.mediaDetails.width, 800);
        assert.deepStrictEqual(Object.keys(media.mediaDetails.sizes), ['thumbnail']);
        assert.strictEqual(media.alt, 'alt text', 'ordinary attachment meta must keep importing');
        assert.strictEqual(await rawMeta(row.id, '_edit_lock'), null, 'a genuinely server-owned key still refused');
    });

    test('the VALUE is validated by shape: a traversal path is dropped, never stored or repaired', async () => {
        const evil = [
            '../../data/wordjs.db',
            '/etc/passwd',
            'C:\\Windows\\win.ini',
            '2024/01/../../../secret.png',
            'file\u0000.png',
            'a/b/c/d/e/f/g/deep.png',
            `${'x'.repeat(300)}.png`,
            'http://evil.example/x.png',
        ];
        for (let i = 0; i < evil.length; i++) {
            const name = `photo-evil-${i}`;
            const summary = await importWxr(XML(attachmentItem(`92${i}`, name, evil[i])),
                { defaultAuthorId: U.admin, importAttachments: true });
            assert.strictEqual(summary.attachments.created, 1, `${evil[i]}: row not created`);
            const row = await dbAsync.get(`SELECT id FROM posts WHERE post_name = ? AND post_type = 'attachment'`, [name]);
            assert.strictEqual(await rawMeta(row.id, '_wp_attached_file'), null,
                `an unresolvable path was stored for ${JSON.stringify(evil[i])}`);
        }
    });

    test('a NON-attachment item cannot smuggle the same keys in', async () => {
        const xml = XML(`
    <item>
      <title>post-with-path</title>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[<p>x</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>9500</wp:post_id>
      <wp:post_name>post-with-path</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[2024/01/ok.jpg]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>__proto__</wp:meta_key><wp:meta_value><![CDATA[{"seo_title":"POLLUTED"}]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>seo_title</wp:meta_key><wp:meta_value><![CDATA[Kept]]></wp:meta_value></wp:postmeta>
    </item>`);
        await importWxr(xml, { defaultAuthorId: U.admin });
        const row = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'post-with-path'`);
        assert.ok(row);
        assert.strictEqual(await rawMeta(row.id, '_wp_attached_file'), null,
            'the exception must be scoped to attachments');
        assert.strictEqual(await rawMeta(row.id, '__proto__'), null, 'the importer wrote a reserved key');
        assert.strictEqual(await rawMeta(row.id, 'seo_title'), 'Kept', 'ordinary meta must still import');
    });
});
