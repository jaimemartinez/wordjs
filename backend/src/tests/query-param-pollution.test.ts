/**
 * THE CLASS: A REPEATED QUERY PARAMETER IS AN ARRAY, AND EVERY GUARD HERE COMPARES IT TO A STRING.
 *
 * `?force=true` is the string 'true'. `?force=true&force=true` is `['true','true']`, and
 * `['true','true'] === 'true'` is false. So a caller who repeats a parameter takes the OTHER branch
 * of the guard without being told — on `DELETE /posts/:id` that is the difference between a
 * permanent delete and a trash, answered with a 200 that says the request succeeded.
 *
 * THE DECISION (one rule, every site): a query parameter this API declares as a scalar must arrive
 * exactly once, as a string, or the request is refused with 400 `rest_invalid_param`. It is NOT
 * resolved to the first or the last value.
 *
 * Why refuse rather than pick one:
 *   · routes/posts.ts ALREADY refuses. `GET /posts?page=1&page=2` has answered 400 rest_invalid_param
 *     since the list handler grew LIST_QUERY_STRING_FIELDS. Picking a value at these eight sites
 *     would mean the same polluted URL answers 400 on one list route and 200 on its twin — which is
 *     the one outcome that is definitely wrong.
 *   · There is no single value the caller means. Every resolution rule is a guess, and a guess is an
 *     HTTP-parameter-pollution primitive: last-wins hands the request to whoever can APPEND to the
 *     URL (a link in an email, an open redirect, a proxy that re-adds a parameter), first-wins hands
 *     it to whoever can prepend. On `force` either guess can be steered into a PERMANENT DELETE.
 *     Refusing is the only rule under which a polluted request never decides a destructive branch.
 *   · It is what WordPress answers for the shape Express hands us: a scalar-typed parameter that
 *     arrives as an array is rest_invalid_param, 400.
 *
 * The tests below drive the REAL routes, because the defect is not in the helper — it is in what the
 * routes did with the value.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-qpp-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Term = require('../models/Term');
const FormSubmission = require('../models/FormSubmission');
const postTypes = require('../core/post-types');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
// GET /analytics/stats is mounted by src/index.ts, NOT by routes/index.ts, so a suite that only
// mounts routes/index.ts cannot see it at all — which is one reason its `period` survived the first
// round. Mounted here exactly as src/index.ts:917 does, so this drives the real handler.
app.use('/api/v1/analytics', require('../routes/analytics'));
// MOUNTED, because the refusal is THROWN and this is what renders it — exactly as src/index.ts does
// (notFound + errorHandler after the router). Without it Express's default finalhandler answers the
// right status with an empty body, which is a test that cannot see the failure shape at all.
app.use(require('../middleware/errorHandler').errorHandler);

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

/** What the refusal looks like, everywhere. Asserted as one shape so the rule cannot drift per site. */
function assertInvalidParam(res: any, field: string, where: string) {
    assert.strictEqual(res.status, 400,
        `${where}: expected 400 rest_invalid_param for a repeated '${field}', got ${res.status} ` +
        `body=${JSON.stringify(res.body).slice(0, 300)}`);
    assert.strictEqual(res.body.code, 'rest_invalid_param', `${where}: wrong error code`);
    assert.strictEqual(res.body.data.status, 400, `${where}: wrong data.status`);
    assert.ok(String(res.body.message).includes(`'${field}'`),
        `${where}: the message must name the offending parameter, got ${JSON.stringify(res.body.message)}`);
}

const statusOf = async (id: number) => {
    const row = await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [id]);
    return row ? row.post_status : null;
};

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    await postTypes.initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE DESTRUCTIVE HALF — `force` decides PERMANENT DELETE vs trash.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: a repeated `force` cannot decide the delete branch', () => {
    test('DELETE /posts/:id?force=true&force=true is refused, and the post is not touched', async () => {
        const post = await Post.create({
            authorId: U.admin, title: `qpp-force-${STAMP}`, type: 'post', status: 'publish',
        });
        const res = await as('admin', 'delete', `/posts/${post.id}?force=true&force=true`);
        assertInvalidParam(res, 'force', 'DELETE /posts/:id');
        assert.strictEqual(await statusOf(post.id), 'publish',
            'a request whose force flag could not be read must change nothing — it was trashed instead');
    });

    test('DELETE /comments/:id?force=true&force=true is refused, and the comment is not touched', async () => {
        const post = await Post.create({
            authorId: U.admin, title: `qpp-force-comment-${STAMP}`, type: 'post', status: 'publish',
        });
        const comment = await Comment.create({
            postId: post.id, author: 'A', authorEmail: 'a@example.com', content: 'hello', status: '1',
        });
        const res = await as('admin', 'delete', `/comments/${comment.commentId}?force=true&force=true`);
        assertInvalidParam(res, 'force', 'DELETE /comments/:id');
        const row = await dbAsync.get('SELECT comment_approved FROM comments WHERE comment_id = ?', [comment.commentId]);
        assert.ok(row, 'the comment row must survive a request that could not be read');
        assert.strictEqual(row.comment_approved, '1', 'the comment was trashed by an unreadable request');
    });

    test('a single `force=true` still permanently deletes — the rule refuses ambiguity, not the feature',
        async () => {
            const post = await Post.create({
                authorId: U.admin, title: `qpp-force-ok-${STAMP}`, type: 'post', status: 'publish',
            });
            const res = await as('admin', 'delete', `/posts/${post.id}?force=true`);
            assert.strictEqual(res.status, 200, `expected the ordinary force delete to still work, got ${res.status}`);
            assert.strictEqual(res.body.deleted, true);
            assert.strictEqual(await statusOf(post.id), null, 'force=true must still remove the row');
        });

    test('no `force` at all still trashes', async () => {
        const post = await Post.create({
            authorId: U.admin, title: `qpp-trash-ok-${STAMP}`, type: 'post', status: 'publish',
        });
        const res = await as('admin', 'delete', `/posts/${post.id}`);
        assert.strictEqual(res.status, 200, `expected the ordinary trash to still work, got ${res.status}`);
        assert.strictEqual(await statusOf(post.id), 'trash');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE READ HALF — the same shape walking through filters, flags and a crash.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: a repeated filter cannot silently change what a list returns', () => {
    test('GET /comments?status=1&status=1 is refused instead of reaching the model as an Array', async () => {
        const res = await as('admin', 'get', '/comments?status=1&status=1');
        assertInvalidParam(res, 'status', 'GET /comments');
    });

    test('GET /tags?hide_empty=true&hide_empty=true is refused instead of ignoring the flag', async () => {
        await Term.create({ name: `qpp-empty-tag-${STAMP}`, taxonomy: 'post_tag' });
        const res = await anon('get', '/tags?hide_empty=true&hide_empty=true');
        assertInvalidParam(res, 'hide_empty', 'GET /tags');
    });

    test('GET /categories?hide_empty=true&hide_empty=true is refused instead of ignoring the flag', async () => {
        await Term.create({ name: `qpp-empty-cat-${STAMP}`, taxonomy: 'category' });
        const res = await anon('get', '/categories?hide_empty=true&hide_empty=true');
        assertInvalidParam(res, 'hide_empty', 'GET /categories');
    });

    test('GET /users?order=asc&order=desc is a 400, not a 500', async () => {
        const res = await as('admin', 'get', '/users?order=asc&order=desc');
        assertInvalidParam(res, 'order', 'GET /users');
    });

    test('GET /forms/submissions?page=1&page=2 is refused instead of silently answering page 1', async () => {
        await FormSubmission.create({ formName: `qpp-${STAMP}`, fields: { a: '1' } });
        await FormSubmission.create({ formName: `qpp-${STAMP}`, fields: { a: '2' } });
        const res = await as('admin', 'get', `/forms/submissions?per_page=1&page=1&page=2`);
        assertInvalidParam(res, 'page', 'GET /forms/submissions');
    });

    test('GET /export?users=true&users=true is refused instead of quietly omitting the users', async () => {
        const res = await as('admin', 'get', '/export?users=true&users=true');
        assertInvalidParam(res, 'users', 'GET /export');
    });

    test('the export flags that DEFAULT to on are the same class, and refuse the same way', async () => {
        const res = await as('admin', 'get', '/export?media=false&media=false');
        assertInvalidParam(res, 'media', 'GET /export');
    });

    test('the `users` flag is LOAD-BEARING — which is what made repeating it a data defect', async () => {
        // Pin what the refused request was silently doing: `['true','true'] === 'true'` is false, so a
        // repeated `?users=true` took the include-nothing branch and the operator got an archive with
        // no user rows in it, with a 200. Both single-value spellings still work exactly as before.
        const included = await as('admin', 'get', '/export?users=true');
        assert.strictEqual(included.status, 200);
        assert.ok(Array.isArray(included.body.content.users) && included.body.content.users.length > 0,
            'a single ?users=true must still include the users');
        const omitted = await as('admin', 'get', '/export');
        assert.strictEqual(omitted.status, 200);
        assert.ok(!omitted.body.content.users || omitted.body.content.users.length === 0,
            'and omitting the flag must still leave them out');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ONE RULE, NOT EIGHT — the twin that was already fixed must answer identically to the new ones.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: every list route answers a polluted parameter the same way', () => {
    test('GET /posts and GET /forms/submissions refuse a repeated `page` with the same body shape', async () => {
        const already = await anon('get', '/posts?page=1&page=2');
        const fixed = await as('admin', 'get', '/forms/submissions?page=1&page=2');
        assert.strictEqual(already.status, 400, 'the pre-existing precedent changed — read it before trusting this file');
        assertInvalidParam(fixed, 'page', 'GET /forms/submissions');
        // The WHOLE body, not just the code: routes/posts.ts writes this refusal inline and
        // core/query-params throws it, and a client must not be able to tell which happened.
        assert.deepStrictEqual(fixed.body, already.body,
            'the same polluted URL must not answer with two different failure shapes');
    });

    test('the bracketed spelling of the same pollution is refused too', async () => {
        const post = await Post.create({
            authorId: U.admin, title: `qpp-bracket-${STAMP}`, type: 'post', status: 'publish',
        });
        const res = await as('admin', 'delete', `/posts/${post.id}?force[]=true`);
        assertInvalidParam(res, 'force', 'DELETE /posts/:id (bracketed)');
        assert.strictEqual(await statusOf(post.id), 'publish', 'the bracketed form trashed the post');
    });

    test('a nested-object parameter is refused rather than stringified to [object Object]', async () => {
        const res = await as('admin', 'get', '/forms/submissions?page[x]=2');
        assertInvalidParam(res, 'page', 'GET /forms/submissions (object)');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE HELPER ITSELF — the routes above are the proof it is WIRED; this is the proof of what it DOES.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('core/query-params: the shape rule, exhaustively', () => {
    const { scalarQueryParam, requireScalarQuery, InvalidQueryParamError } = require('../core/query-params');

    test('a single string passes through untouched — including the empty string', () => {
        assert.strictEqual(scalarQueryParam('true', 'force'), 'true');
        assert.strictEqual(scalarQueryParam('', 'search'), '',
            'empty is SUPPLIED-BUT-EMPTY, which several handlers distinguish from absent');
        assert.strictEqual(scalarQueryParam('banana', 'force'), 'banana',
            'the rule is about SHAPE, not value — a wrong value is still the caller\'s business');
    });

    test('absent is absent, not a violation', () => {
        assert.strictEqual(scalarQueryParam(undefined, 'force'), undefined);
        assert.strictEqual(scalarQueryParam(null as any, 'force'), undefined);
    });

    test('every non-string shape qs can produce is refused, by name', () => {
        const shapes: Array<[string, any]> = [
            ['repeated key', ['true', 'true']],
            ['repeated key, differing values', ['false', 'true']],
            ['single-element array (?force[]=true)', ['true']],
            ['empty array', []],
            ['bracketed object (?force[x]=true)', { x: 'true' }],
            ['array of objects', [{ x: 'true' }]],
            ['nested array', [['true']]],
        ];
        for (const [label, value] of shapes) {
            assert.throws(() => scalarQueryParam(value, 'force'), (err: any) => {
                assert.ok(err instanceof InvalidQueryParamError, `${label}: wrong error type`);
                assert.strictEqual(err.status, 400, `${label}: wrong status`);
                assert.strictEqual(err.code, 'rest_invalid_param', `${label}: wrong code`);
                assert.strictEqual(err.message, `Invalid parameter 'force': expected a string.`);
                assert.deepStrictEqual(err.invalidParams, { force: 'Expected a string.' });
                return true;
            }, `${label} must be refused`);
        }
    });

    test('requireScalarQuery is the plural of the same rule, and names the FIRST offender', () => {
        assert.doesNotThrow(() => requireScalarQuery({ page: '1', order: 'asc' }, ['page', 'order', 'absent']));
        assert.throws(
            () => requireScalarQuery({ page: ['1', '2'], order: ['asc', 'desc'] }, ['page', 'order']),
            /Invalid parameter 'page'/,
            'the field list is the order the caller is told about',
        );
        // A key NOT in the table is not this handler's business — declaring the table is what opts a
        // parameter in, so an undeclared one must not 400 a request that is legal today.
        assert.doesNotThrow(() => requireScalarQuery({ undeclared: ['a', 'b'] }, ['page']));
        assert.doesNotThrow(() => requireScalarQuery(undefined, ['page']));
    });

    test('a prototype-named parameter cannot be smuggled through the plural form', () => {
        // `{}['constructor']` is a FUNCTION, i.e. neither a string nor undefined. The rule must call
        // that a violation rather than reading an inherited value off the query object.
        assert.throws(() => requireScalarQuery({}, ['constructor']), /Invalid parameter 'constructor'/);
        assert.doesNotThrow(() => requireScalarQuery(Object.create(null), ['constructor']));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 — THE SAME CLASS, DERIVED FROM THE SOURCE INSTEAD OF FROM THE BUG REPORT.
//
// The first round fixed the eight sites it had been handed and stopped. The class is not eight sites:
// it is "a value that came out of req.query reaches a guard that compares it to a STRING", and an AST
// walk over backend/src/routes + backend/src/middleware finds that shape at 35 places in 12 files.
// Twenty-five were already covered — by `firstNonStringField` in the posts list, by
// `requireScalarQuery` at the top of the categories/tags/comments/users/forms/export handlers, or by
// `scalarQueryParam` at the read. TEN were not, in six files nobody had looked at, and they are the
// members below. They failed in both directions:
//
//   · `req.query.rest !== 'false'` (types, taxonomies) — a repeat is an Array, `!== 'false'` is TRUE,
//     so `?rest=false&rest=false` answered with the REST-VISIBLE types: the exact opposite list from
//     the one asked for, with a 200.
//   · `String(req.query.refresh || '') === '1'` (marketplace) — String() only stops the TypeError;
//     ['1','1'] becomes '1,1', which is not '1', so a repeat silently served the CACHED catalog to an
//     admin who explicitly asked to bypass the cache, and an attacker who can append to a URL can
//     pin an admin to a stale plugin/theme index.
//   · `['asc','desc'].includes(String(order).toLowerCase())` and `orderByMap[String(orderby)]`
//     (media) — same shape: the whitelist misses and the media library silently sorts by the default.
//   · `ALLOWED_BUNDLE_TYPES.has(String(bundleType))` (plugin bundles) — this one already FAILED
//     CLOSED (400 'Invalid bundle type'), so it was not a security defect; it is here because the
//     rule must not differ per call site, and 400 rest_invalid_param naming the parameter is the
//     answer every other member gives.
//   · `analytics.getStats(period || 'weekly')` — the comparison lives one call away, in
//     models/Analytics.getStats (`period === 'weekly' ? 7 : 30`). A repeat silently changes the
//     reporting window from 7 days to 30. A guard that is in another file is still this guard.
//
// The table is driven, not enumerated in prose, so a member added to it is exercised by every
// assertion at once.
//
// DIVISION OF LABOUR, because this table cannot grow by itself: COMPLETENESS is the AST gate's job —
// tests/request-field-types.test.ts, "CLASS 1b", reads EVERY file in routes/ and middleware/ and goes
// red on a member nobody has heard of, including one added tomorrow. What this table adds is the
// BEHAVIOUR at the live route: that the refusal really is a 400 with the same body everywhere, and
// that the parameter it refuses was deciding something.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: every guard that compares a query value to a string refuses the repeated shape', () => {
    interface Site { where: string; persona: 'anon' | 'admin'; path: string; field: string; decided: string }

    /** Every site the AST walk found OPEN, plus the round-1 twins, so this is a class test. */
    const SITES: readonly Site[] = Object.freeze([
        // ── round 2: derived from the source ──────────────────────────────────────────────────────
        { where: 'GET /types', persona: 'anon', path: '/types?rest=false&rest=false', field: 'rest',
            decided: 'which post types are listed at all' },
        { where: 'GET /types/schemas', persona: 'anon', path: '/types/schemas?rest=false&rest=false', field: 'rest',
            decided: 'which content schemas are listed' },
        { where: 'GET /taxonomies', persona: 'anon', path: '/taxonomies?rest=false&rest=false', field: 'rest',
            decided: 'which taxonomies are listed' },
        { where: 'GET /media (order)', persona: 'admin', path: '/media?order=asc&order=asc', field: 'order',
            decided: 'which end of the library the first page shows' },
        { where: 'GET /media (orderby)', persona: 'admin', path: '/media?orderby=title&orderby=title', field: 'orderby',
            decided: 'which column the library is sorted by' },
        { where: 'GET /marketplace/catalog', persona: 'admin', path: '/marketplace/catalog?refresh=1&refresh=1', field: 'refresh',
            decided: 'whether the admin sees a fresh plugin index or a cached one' },
        { where: 'GET /marketplace/themes/catalog', persona: 'admin', path: '/marketplace/themes/catalog?refresh=1&refresh=1', field: 'refresh',
            decided: 'whether the admin sees a fresh theme index or a cached one' },
        { where: 'GET /plugins/:slug/bundle', persona: 'anon', path: '/plugins/hello-world/bundle?type=admin&type=admin', field: 'type',
            decided: 'which compiled bundle is served' },
        { where: 'GET /plugins/:slug/bundle/css', persona: 'anon', path: '/plugins/hello-world/bundle/css?type=admin&type=admin', field: 'type',
            decided: 'which compiled stylesheet is served' },
        { where: 'GET /analytics/stats', persona: 'admin', path: '/analytics/stats?period=weekly&period=weekly', field: 'period',
            decided: 'whether the numbers cover 7 days or 30' },
        // ── round 1: the twins that were already closed, re-asserted HERE so the rule is one rule ──
        { where: 'GET /export', persona: 'admin', path: '/export?users=true&users=true', field: 'users',
            decided: 'whether the archive contains the user rows' },
        { where: 'GET /comments', persona: 'admin', path: '/comments?status=1&status=1', field: 'status',
            decided: 'which moderation queue is shown' },
    ]);

    const call = (s: Site) => (s.persona === 'anon' ? anon('get', s.path) : as('admin', 'get', s.path));

    // The whole table is driven before anything is asserted, so a red run NAMES EVERY open site
    // instead of stopping at the first one — the failure report is the site list.
    async function surveyEvery(paths: (s: Site) => string): Promise<string[]> {
        const broken: string[] = [];
        for (const s of SITES) {
            const res = await call({ ...s, path: paths(s) });
            try {
                assertInvalidParam(res, s.field, `${s.where} — '${s.field}' decides ${s.decided}`);
            } catch (e: any) {
                broken.push(String(e.message).split('\n')[0]);
            }
        }
        return broken;
    }

    test('every site answers 400 rest_invalid_param, with the SAME body shape', async () => {
        assert.deepStrictEqual(await surveyEvery((s) => s.path), [],
            'a repeated scalar reached a guard that compares it to a string');
    });

    test('and none of them answers 2xx — the silent wrong branch is the defect', async () => {
        const accepted: string[] = [];
        for (const s of SITES) {
            const res = await call(s);
            if (res.status < 400) {
                accepted.push(`${s.where}: a repeated '${s.field}' was ACCEPTED with ${res.status}; ` +
                    `the value the guard could not read still decided ${s.decided}`);
            }
        }
        assert.deepStrictEqual(accepted, []);
    });

    test('the bracketed spelling of the same pollution is refused at every site too', async () => {
        const bracket = (s: Site) => {
            const rewritten = s.path.replace(new RegExp(`${s.field}=([^&]*)&${s.field}=`), `${s.field}[]=$1&${s.field}[]=`);
            assert.notStrictEqual(rewritten, s.path, `${s.where}: the bracketed rewrite did not apply`);
            return rewritten;
        };
        assert.deepStrictEqual(await surveyEvery(bracket), [],
            '`?x[]=a&x[]=b` is the same Array by another spelling and must answer the same way');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE REFUSED REQUESTS WERE SILENTLY DOING — the refusal is only worth anything if the value it
// refuses is load-bearing. Each of these pins the single-value behaviour that must NOT change.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: the refused parameters are load-bearing, and the honest spelling still works', () => {
    test('?rest=false selects the INTERNAL types — the answer a repeat quietly inverted', async () => {
        const internal = await anon('get', '/types?rest=false');
        assert.strictEqual(internal.status, 200);
        const internalNames = internal.body.map((t: any) => t.name);
        const exposed = await anon('get', '/types');
        assert.strictEqual(exposed.status, 200);
        const exposedNames = exposed.body.map((t: any) => t.name);

        assert.ok(exposedNames.includes('post'), 'precondition: the default list is the REST-visible one');
        assert.ok(!internalNames.includes('post'), '?rest=false must not return the REST-visible types');
        assert.ok(internalNames.length > 0, 'precondition: some type is registered with showInRest:false');
        assert.strictEqual(internalNames.filter((n: string) => exposedNames.includes(n)).length, 0,
            'the two answers are disjoint — which is why answering one for the other is a defect, not a nuance');
    });

    test('?order=asc still sorts the media library ascending', async () => {
        const first = await Post.create({ authorId: U.admin, title: `qpp-media-a-${STAMP}`, type: 'attachment', status: 'inherit' });
        const second = await Post.create({ authorId: U.admin, title: `qpp-media-b-${STAMP}`, type: 'attachment', status: 'inherit' });
        const asc = await as('admin', 'get', '/media?order=asc&per_page=100');
        assert.strictEqual(asc.status, 200, `?order=asc must still work, got ${asc.status}`);
        const ids = asc.body.map((m: any) => m.id).filter((id: number) => id === first.id || id === second.id);
        assert.deepStrictEqual(ids, [first.id, second.id], 'ascending order stopped working');
    });

    test('a single ?period= still reaches the model, and no period at all still defaults', async () => {
        for (const qs of ['', '?period=weekly', '?period=monthly']) {
            const res = await as('admin', 'get', `/analytics/stats${qs}`);
            assert.strictEqual(res.status, 200, `GET /analytics/stats${qs} must still answer 200, got ${res.status}`);
        }
    });

    test('a single ?rest= / ?refresh= / ?type= still answers, so the rule refuses ambiguity only', async () => {
        assert.strictEqual((await anon('get', '/taxonomies?rest=true')).status, 200);
        assert.strictEqual((await as('admin', 'get', '/marketplace/catalog?refresh=1')).status, 200);
        // An unknown plugin is a 404 — the point is that it got PAST the bundle-type guard.
        const bundle = await anon('get', '/plugins/hello-world/bundle?type=admin');
        assert.ok(bundle.status === 200 || bundle.status === 404,
            `a single ?type=admin must reach the file lookup, got ${bundle.status}`);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// NOT EVERY MATCH IS A DEFECT — the two the walk flagged that are already answered, pinned so nobody
// "fixes" them into a different answer and so the exemptions are evidence rather than assertion.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CLASS: the sites that already refuse are left alone, and proven to refuse', () => {
    test('GET /posts/slug/:slug?type= is narrowed by a typeof check at the read, and 400s', async () => {
        // routes/posts.ts:594 compares `requestedType !== ''` — but the SAME if-condition also asks
        // `typeof requestedType !== 'string'`, so the Array never reaches the comparison's other
        // branch. It answers rest_invalid_post_type rather than rest_invalid_param, which is a
        // different name for the same refusal, and it is the route's own vocabulary.
        const post = await Post.create({
            authorId: U.admin, title: `qpp-slug-${STAMP}`, type: 'post', status: 'publish', slug: `qpp-slug-${STAMP}`,
        });
        assert.ok(post.id);
        const res = await anon('get', `/posts/slug/qpp-slug-${STAMP}?type=post&type=post`);
        assert.strictEqual(res.status, 400, 'a repeated ?type must not resolve to a post');
        assert.strictEqual(res.body.code, 'rest_invalid_post_type');
    });

    test('PUT /users/:id `role` is a BODY field, so a repeated ?role= decides nothing', async () => {
        // The walk reports `role === 'administrator'` at routes/users.ts:953, but that `role` is
        // `suppliedText(req.body.role)` (users.ts:831) — the query-scoped `role` of the list handler
        // one function up is a different binding. Pinned because a file-global name→field map calls
        // this a member of the class and it is not one; the query value is simply never read here.
        const target = await seedUser(`qpp-role-${STAMP}`, 'subscriber');
        const res = await as('admin', 'put', `/users/${target}?role=administrator&role=administrator`)
            .send({ displayName: 'still a subscriber' });
        assert.strictEqual(res.status, 200, `the query parameter must be inert, got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbAsync.get(
            `SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = 'role'`, [target]);
        assert.strictEqual(row.meta_value, 'subscriber', 'a query parameter changed a role');
    });
});
