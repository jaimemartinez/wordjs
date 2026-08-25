/**
 * WordJS — THE ROUTE-ID CONTRACT (class suite).
 *
 * THE CLASS. A route segment declared `type: integer` in Swagger is parsed with `parseInt()`. A
 * non-numeric segment makes that `NaN`, and NOTHING between the parse and the driver stops it: the
 * `if (!term)` / `if (!comment)` / `if (!menu)` guards every one of these routes has run AFTER the
 * lookup, so the NaN is bound into `SELECT ... WHERE <int column> = ?` first. What the caller gets
 * then depends on the ENGINE, which is why the SQLite suite was green while two real engines were not:
 *
 *   • SQLite   — binds NaN as NULL, matches no row, and the route answers a correct 404;
 *   • Postgres — refuses the bind: `22P02 invalid input syntax for type integer: "NaN"`;
 *   • MySQL    — splices it in as a bare identifier: `ER_BAD_FIELD_ERROR Unknown column 'NaN' in 'where clause'`.
 *
 * On both real engines that is a 500 echoing the driver error, on a request whose only sin is a typo
 * in the URL, and on routes that are reachable ANONYMOUSLY (`GET /comments/abc`, `/categories/abc`,
 * `/tags/abc`, `/menus/abc`). SQLite is the leg that hides this, so the Postgres and MySQL blocks
 * below are the load-bearing ones.
 *
 * WHY THIS SUITE IS A CLASS SUITE AND NOT A ROUTE SUITE. The previous round closed exactly the
 * `/revisions` member and left its twins open. The table below is DERIVED from the route files (every
 * `parseInt(... req.params ...)` site whose value can reach a query) and is exercised in full — 21
 * sites over 5 route files — so a member that regresses, or a member added later to one of these
 * routers without the contract, fails here.
 *
 * WHAT THE ANSWER IS. 404, the same answer these routers already give for an id that simply does not
 * exist (`GET /categories/999999` → `rest_term_invalid`, `GET /posts/999999` → `rest_post_invalid_id`).
 * A bad id and an absent id both mean "no such resource", and the `sameAsAbsent` assertions below pin
 * that the two are indistinguishable — body for body, not just status for status.
 *
 * THE SECOND SPELLING. `GET /categories/9999999999` is a plain integer, so it survives every
 * `Number.isInteger` guard in the repo — and Postgres answers `22003 value "9999999999" is out of
 * range for type integer`, another 500 from the same sink. The contract in core/query-params states
 * the whole shape (a positive integer the 32-bit id columns can hold), so both spellings are one rule
 * and the overflow block below is asserted at every site alongside the NaN one.
 *
 * NOT DEFECTS (characterized here so the difference is evidence rather than memory):
 *   • `/posts/*`, `/media/*`, `/revisions/post/:postId` — `Post.findById` short-circuits on `if (!id)`
 *     and `!NaN` is true, so the NaN never reaches the driver and the route already 404s;
 *   • `/seo/meta/:postId` — an explicit `if (!postId)` does the same job inline;
 *   • `/auth/tokens/:id`, `/forms/submissions/:id`, `/presence/:postId`, `/webhooks/*`, `/collab/*` —
 *     already carry a `Number.isInteger`/`isFinite` guard. They answer 400 rather than 404; that
 *     predates this class and is left alone.
 *   • `/users/:id/mfa/reset` was in that list too. It is the ONE route whose answer this change moves
 *     (400 → 404), because it shares a router with three routes that were defective — see its row.
 *
 * CLOSED SINCE, by tests/route-id-residuals-class.test.ts — this paragraph used to say the rest of the
 * class was deliberately left open, and it no longer is. What was left open was the OVERFLOW spelling
 * on the routers this suite does not own (`/posts/9999999999`, `/media/…`, `/revisions/…`,
 * `/seo/meta/…`, `/webhooks/…`, `/forms/submissions/…` were all 500 on Postgres), plus the `12abc`
 * spelling everywhere, which `parseInt` resolved to 12 at every site including the five this suite
 * owns. The residual suite covers both spellings over the other nine routers; the `NON_DEFECTS` rows
 * below still hold, because the routes they name kept the status they already answered.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST so incidental writes stay out of the repo.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-route-id-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

/** The id used to prove "this is not a number". Any non-numeric segment does the same thing. */
const BAD_ID = 'abc';
/** A well-formed id that certainly denotes nothing — the control the bad id must be indistinguishable from. */
const ABSENT_ID = '999999';
/**
 * The OTHER spelling of "cannot denote a row", proven live on Postgres 16 alongside the NaN one:
 * `value "9999999999" is out of range for type integer`. Same sink, same 500, and the id columns are
 * 32-bit on every engine, so this is the same contract and not a second one.
 */
const OVERFLOW_IDS = ['9999999999', '99999999999999999999'];

// A missing engine is a graceful skip locally; under WORDJS_CI_DB=1 the service containers are wired
// precisely so these run, and an unreachable engine there is a hard FAILURE, never a silent green.
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

type Method = 'get' | 'put' | 'post' | 'delete';

interface Site {
    /** Route file the site lives in — the class spans five of them. */
    file: string;
    method: Method;
    /** Built from an id so the SAME row of the table drives the bad-id and the absent-id request. */
    url: (id: string) => string;
    /** The `code` this router already returns for "no such resource". */
    code: string;
    body?: Record<string, unknown>;
    /**
     * False where the route never looked the resource up in the first place, so an ABSENT id does not
     * 404 either. `POST /menus/:id/location` writes `nav_menu_locations` without checking the menu
     * exists, and `POST /menus/:id/items` inserts the item and simply skips the term relationship.
     * Both are real gaps, both are OUTSIDE this class (they are about existence, not about the id
     * being a number), and neither is touched here — only the non-numeric id is.
     */
    sameAsAbsent: boolean;
}

/**
 * THE DERIVED LIST: every `parseInt(... req.params ...)` site in backend/src/routes whose NaN can reach
 * a query. Derived by grep over the route files, then read one by one — the sites left out are the ones
 * whose NaN is stopped before the driver (see the header).
 */
const SITES: Site[] = [
    // routes/categories.ts — Term.findById(NaN, 'category'); Term.findById has no falsy guard.
    { file: 'categories.ts', method: 'get', url: (i) => `/api/v1/categories/${i}`, code: 'rest_term_invalid', sameAsAbsent: true },
    { file: 'categories.ts', method: 'put', url: (i) => `/api/v1/categories/${i}`, code: 'rest_term_invalid', body: { name: 'x' }, sameAsAbsent: true },
    { file: 'categories.ts', method: 'delete', url: (i) => `/api/v1/categories/${i}`, code: 'rest_term_invalid', sameAsAbsent: true },

    // routes/tags.ts — the exact twin of the categories block, on the other taxonomy.
    { file: 'tags.ts', method: 'get', url: (i) => `/api/v1/tags/${i}`, code: 'rest_term_invalid', sameAsAbsent: true },
    { file: 'tags.ts', method: 'put', url: (i) => `/api/v1/tags/${i}`, code: 'rest_term_invalid', body: { name: 'x' }, sameAsAbsent: true },
    { file: 'tags.ts', method: 'delete', url: (i) => `/api/v1/tags/${i}`, code: 'rest_term_invalid', sameAsAbsent: true },

    // routes/comments.ts — Comment.findById(NaN); approve/spam reach it through Comment.update.
    { file: 'comments.ts', method: 'get', url: (i) => `/api/v1/comments/${i}`, code: 'rest_comment_invalid_id', sameAsAbsent: true },
    { file: 'comments.ts', method: 'put', url: (i) => `/api/v1/comments/${i}`, code: 'rest_comment_invalid_id', body: { content: 'x' }, sameAsAbsent: true },
    { file: 'comments.ts', method: 'delete', url: (i) => `/api/v1/comments/${i}`, code: 'rest_comment_invalid_id', sameAsAbsent: true },
    // approve/spam are `sameAsAbsent: false` for a reason that is NOT this class: they reach the sink
    // through `Comment.update`, which THROWS `Error('Comment not found')` when the row is missing, so
    // `POST /comments/999999/approve` is a 500 on every engine — an ABSENT id, not a malformed one.
    // That is a separate defect (a missing row surfacing as 500) and is deliberately left alone here.
    { file: 'comments.ts', method: 'post', url: (i) => `/api/v1/comments/${i}/approve`, code: 'rest_comment_invalid_id', sameAsAbsent: false },
    { file: 'comments.ts', method: 'post', url: (i) => `/api/v1/comments/${i}/spam`, code: 'rest_comment_invalid_id', sameAsAbsent: false },

    // routes/menus.ts — Menu.findById(NaN) / MenuItem.findById(NaN); the two writes below never look up.
    { file: 'menus.ts', method: 'get', url: (i) => `/api/v1/menus/${i}`, code: 'rest_menu_invalid', sameAsAbsent: true },
    { file: 'menus.ts', method: 'put', url: (i) => `/api/v1/menus/${i}`, code: 'rest_menu_invalid', body: { name: 'x' }, sameAsAbsent: true },
    { file: 'menus.ts', method: 'delete', url: (i) => `/api/v1/menus/${i}`, code: 'rest_menu_invalid', sameAsAbsent: true },
    { file: 'menus.ts', method: 'post', url: (i) => `/api/v1/menus/${i}/location`, code: 'rest_menu_invalid', body: { location: 'primary' }, sameAsAbsent: false },
    { file: 'menus.ts', method: 'post', url: (i) => `/api/v1/menus/${i}/items`, code: 'rest_menu_invalid', body: { title: 'Home', url: '/' }, sameAsAbsent: false },
    { file: 'menus.ts', method: 'put', url: (i) => `/api/v1/menus/items/${i}`, code: 'rest_menu_item_invalid', body: { title: 'x' }, sameAsAbsent: true },
    { file: 'menus.ts', method: 'delete', url: (i) => `/api/v1/menus/items/${i}`, code: 'rest_menu_item_invalid', sameAsAbsent: true },

    // routes/users.ts — User.findById(NaN). /:id/mfa/reset is NOT here: it already guards (see header).
    { file: 'users.ts', method: 'get', url: (i) => `/api/v1/users/${i}`, code: 'rest_user_invalid_id', sameAsAbsent: true },
    { file: 'users.ts', method: 'put', url: (i) => `/api/v1/users/${i}`, code: 'rest_user_invalid_id', body: {}, sameAsAbsent: true },
    { file: 'users.ts', method: 'delete', url: (i) => `/api/v1/users/${i}`, code: 'rest_user_invalid_id', sameAsAbsent: true },
];

/**
 * Sites whose NaN was ALREADY stopped before the driver. Asserted on every engine as a
 * characterization: green before and after, which is the evidence that nothing needed changing there.
 */
const NON_DEFECTS: Array<{ method: Method; url: string; status: number; note: string }> = [
    { method: 'get', url: `/api/v1/posts/${BAD_ID}`, status: 404, note: 'Post.findById short-circuits on `if (!id)` and !NaN is true' },
    { method: 'delete', url: `/api/v1/posts/${BAD_ID}`, status: 404, note: 'same guard, write side' },
    { method: 'get', url: `/api/v1/posts/${BAD_ID}/meta`, status: 404, note: 'same guard, meta side' },
    { method: 'get', url: `/api/v1/media/${BAD_ID}`, status: 404, note: 'Media.findById delegates to Post.findById' },
    { method: 'get', url: `/api/v1/seo/meta/${BAD_ID}`, status: 404, note: 'explicit inline `if (!postId)`' },
    { method: 'get', url: `/api/v1/revisions/${BAD_ID}`, status: 404, note: 'closed by the previous round (revisionIdOrNull)' },
    { method: 'get', url: `/api/v1/revisions/post/${BAD_ID}`, status: 404, note: 'Post.findById guard again' },
    { method: 'delete', url: `/api/v1/auth/tokens/${BAD_ID}`, status: 400, note: 'deliberate Number.isInteger guard — 400 predates this class' },
    { method: 'delete', url: `/api/v1/forms/submissions/${BAD_ID}`, status: 400, note: 'deliberate Number.isInteger guard' },
    { method: 'post', url: `/api/v1/presence/${BAD_ID}`, status: 400, note: 'deliberate Number.isFinite guard' },
    { method: 'get', url: `/api/v1/webhooks/${BAD_ID}`, status: 400, note: 'webhooks parseId() returns null → 400' },
    // The one row where the class fix DOES change a route that was not itself defective. Its own
    // `Number.isInteger` guard already stopped the NaN, but it stopped it with a 400 while every other
    // route in the same router answered 404 for the same input — so `/users/abc/mfa/reset` was a 400
    // and `/users/999999/mfa/reset` a 404, for two spellings of "no such user". The router-level
    // contract now answers first and makes the whole router say one thing. The inline guard stays: it
    // is unreachable for a malformed id and still correct if the route is ever mounted elsewhere.
    { method: 'post', url: `/api/v1/users/${BAD_ID}/mfa/reset`, status: 404, note: 'now the router-wide 404, not its inline 400 — see the note in NON_DEFECTS' },
];

/** The real router tree, exactly as index.ts mounts it — a status here can only have come from a route. */
function mountApp() {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(cookieParser());
    app.use('/api/v1', require('../routes'));
    return app;
}

const sign = (userId: number) =>
    jwt.sign({ userId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

interface Fixtures { token: string; adminId: number; categoryId: number; tagId: number; commentId: number; menuId: number; }

/**
 * Seed through the REAL producers (the models the routes read back), not hand-written rows, so the
 * positive controls cannot pass against a fixture that the routes would never have created.
 */
async function seedFixtures(dbAsync: any): Promise<Fixtures> {
    await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['admin', 'x', 'admin@example.com', 'admin']);
    const adminRow = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, ['admin']);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
        [adminRow.id, 'administrator']);

    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();

    const Post = require('../models/Post');
    const Term = require('../models/Term');
    const Comment = require('../models/Comment');
    const { Menu, MenuItem } = require('../models/Menu');

    const post = await Post.create({
        authorId: adminRow.id, title: 'Host post', content: '<p>body</p>',
        status: 'publish', type: 'post', slug: 'route-id-host',
    });
    const category = await Term.create({ name: 'Route Id Cat', taxonomy: 'category', slug: 'route-id-cat' });
    const tag = await Term.create({ name: 'Route Id Tag', taxonomy: 'post_tag', slug: 'route-id-tag' });
    const comment = await Comment.create({
        postId: post.id, author: 'Guest', authorEmail: 'guest@example.com',
        content: 'hello', status: '1',
    });
    const menu = await Menu.create({ name: 'Route Id Menu', slug: 'route-id-menu' });
    await MenuItem.create({ menuId: menu.id, title: 'Home', url: '/' });

    return {
        token: sign(adminRow.id),
        adminId: adminRow.id,
        categoryId: category.termId ?? category.id,
        tagId: tag.termId ?? tag.id,
        commentId: comment.commentId ?? comment.id,
        menuId: menu.id ?? menu.termId,
    };
}

const describeSite = (s: Site, id: string) => `${s.method.toUpperCase()} ${s.url(id)} [${s.file}]`;

/**
 * POSITIVE CONTROL. Every router in the table answers 200 for an id that DOES denote a row, so a 404
 * in the assertions below can never be a false pass for the wrong reason (a router that failed to
 * mount, a gate that refused the token, a fixture that was never created).
 */
async function assertRoutersActuallyWork(request: any, app: any, f: Fixtures, engine: string) {
    const controls: Array<[string, string]> = [
        ['categories.ts', `/api/v1/categories/${f.categoryId}`],
        ['tags.ts', `/api/v1/tags/${f.tagId}`],
        ['comments.ts', `/api/v1/comments/${f.commentId}`],
        ['menus.ts', `/api/v1/menus/${f.menuId}`],
        ['users.ts', `/api/v1/users/${f.adminId}`],
    ];
    for (const [file, url] of controls) {
        const res = await request(app).get(url).set('Authorization', `Bearer ${f.token}`);
        assert.strictEqual(res.status, 200,
            `${engine}: positive control GET ${url} [${file}] must be 200, got ${res.status} ${JSON.stringify(res.body)}`);
    }
}

/** THE CLASS ASSERTION: a non-numeric id is a 404 at every site, on every engine. */
async function assertBadIdNeverReachesTheDriver(request: any, app: any, f: Fixtures, engine: string) {
    for (const s of SITES) {
        const req = (request(app) as any)[s.method](s.url(BAD_ID)).set('Authorization', `Bearer ${f.token}`);
        const res = s.body ? await req.send(s.body) : await req;
        assert.strictEqual(res.status, 404,
            `${engine}: ${describeSite(s, BAD_ID)} must answer 404, got ${res.status} — ` +
            `${JSON.stringify(res.body)}. A non-numeric id must never be bound into a query.`);
        assert.strictEqual(res.body && res.body.code, s.code,
            `${engine}: ${describeSite(s, BAD_ID)} must answer this router's own not-found code ` +
            `'${s.code}', got ${JSON.stringify(res.body)}`);
    }
}

/** A bad id and an absent id must be INDISTINGUISHABLE — same status, same body. */
async function assertBadIdMatchesAbsentId(request: any, app: any, f: Fixtures, engine: string) {
    for (const s of SITES.filter((x) => x.sameAsAbsent)) {
        const send = (id: string) => {
            const r = (request(app) as any)[s.method](s.url(id)).set('Authorization', `Bearer ${f.token}`);
            return s.body ? r.send(s.body) : r;
        };
        const bad = await send(BAD_ID);
        const absent = await send(ABSENT_ID);
        assert.strictEqual(absent.status, 404,
            `${engine}: control — ${describeSite(s, ABSENT_ID)} must be 404, got ${absent.status}`);
        assert.deepStrictEqual({ status: bad.status, body: bad.body }, { status: absent.status, body: absent.body },
            `${engine}: ${describeSite(s, BAD_ID)} must be indistinguishable from the same route with an ` +
            `absent id — both mean "no such resource"`);
    }
}

/** The sites that were never defective must keep answering exactly what they answered. */
async function assertNonDefectsUnchanged(request: any, app: any, f: Fixtures, engine: string) {
    for (const n of NON_DEFECTS) {
        const res = await (request(app) as any)[n.method](n.url).set('Authorization', `Bearer ${f.token}`).send({});
        assert.strictEqual(res.status, n.status,
            `${engine}: ${n.method.toUpperCase()} ${n.url} must still answer ${n.status} (${n.note}), ` +
            `got ${res.status} ${JSON.stringify(res.body)}`);
    }
}

/**
 * An id wider than the id columns is the same statement as a non-numeric one: it cannot name a row,
 * and letting it through means Postgres answers `22003 value out of range for type integer` as a 500.
 */
async function assertOutOfRangeIdIs404(request: any, app: any, f: Fixtures, engine: string) {
    for (const id of OVERFLOW_IDS) {
        for (const s of SITES) {
            const req = (request(app) as any)[s.method](s.url(id)).set('Authorization', `Bearer ${f.token}`);
            const res = s.body ? await req.send(s.body) : await req;
            assert.strictEqual(res.status, 404,
                `${engine}: ${describeSite(s, id)} must answer 404, got ${res.status} — ${JSON.stringify(res.body)}. ` +
                `An id wider than the id columns cannot name a row and must not be bound.`);
        }
    }
}

/**
 * The contract is a property of the ROUTE, so it is answered before the route's own auth middleware —
 * the same order WordPress uses, where `(?P<id>[\d]+)` fails to match and the request is a 404
 * `rest_no_route` before any permission_callback runs. An id that is not a number denotes nothing, so
 * answering "no such resource" to an anonymous caller discloses nothing about anything.
 */
async function assertAnonymousAlsoGets404(request: any, app: any, engine: string) {
    for (const url of [`/api/v1/comments/${BAD_ID}`, `/api/v1/menus/${BAD_ID}`]) {
        const res = await request(app).delete(url);
        assert.strictEqual(res.status, 404,
            `${engine}: anonymous DELETE ${url} must be 404 (the id denotes nothing), got ${res.status} ${JSON.stringify(res.body)}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SQLite — the leg that HIDES most of this class. Kept so the suite runs everywhere, and because two
// menus sites (`/items` throws, `/location` silently writes NaN) are wrong on SQLite too.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id contract — SQLite', () => {
    let request: any, app: any, f: Fixtures;

    before(async () => {
        request = require('supertest');
        config.dbDriver = 'sqlite-native';
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
    });

    after(async () => { try { await database.closeDatabase(); } catch { /* ignore */ } });

    it('every router in the class actually serves a real id (positive control)', async () => {
        await assertRoutersActuallyWork(request, app, f, 'sqlite');
    });
    it('a non-numeric id answers 404 at every site in the class', async () => {
        await assertBadIdNeverReachesTheDriver(request, app, f, 'sqlite');
    });
    it('a non-numeric id is indistinguishable from an absent id', async () => {
        await assertBadIdMatchesAbsentId(request, app, f, 'sqlite');
    });
    it('the sites that were never defective are unchanged', async () => {
        await assertNonDefectsUnchanged(request, app, f, 'sqlite');
    });
    it('an id wider than the id columns answers 404 at every site in the class', async () => {
        await assertOutOfRangeIdIs404(request, app, f, 'sqlite');
    });
    it('the contract is answered before the route auth gate', async () => {
        await assertAnonymousAlsoGets404(request, app, 'sqlite');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Postgres — refuses the NaN bind outright (22P02). This block is where the class is actually proven.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id contract — PostgreSQL', () => {
    const DBNAME = `wordjs_routeid_pg_${process.pid}`;
    let request: any, app: any, f: Fixtures, reachable = false;

    const adminCfg = () => ({
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT || 55432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'password',
        database: 'postgres',
    });

    before(async () => {
        request = require('supertest');
        try {
            // A THROWAWAY database per run: a suite that reuses one makes its verdict depend on history.
            const { Client } = require('pg');
            const admin = new Client(adminCfg());
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.query(`CREATE DATABASE ${DBNAME}`);
            await admin.end();
        } catch {
            return; // reachable stays false; every test skipOrFails
        }
        config.dbDriver = 'postgres';
        config.db = { ...adminCfg(), name: DBNAME };
        await database.init({ driver: 'postgres' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
        reachable = true;
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try {
            const { Client } = require('pg');
            const admin = new Client(adminCfg());
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.end();
        } catch { /* ignore */ }
    });

    it('every router in the class actually serves a real id (positive control)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertRoutersActuallyWork(request, app, f, 'postgres');
    });
    it('a non-numeric id answers 404 at every site in the class', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertBadIdNeverReachesTheDriver(request, app, f, 'postgres');
    });
    it('a non-numeric id is indistinguishable from an absent id', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertBadIdMatchesAbsentId(request, app, f, 'postgres');
    });
    it('the sites that were never defective are unchanged', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertNonDefectsUnchanged(request, app, f, 'postgres');
    });
    it('an id wider than the id columns answers 404 at every site in the class', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertOutOfRangeIdIs404(request, app, f, 'postgres');
    });
    it('the contract is answered before the route auth gate', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertAnonymousAlsoGets404(request, app, 'postgres');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MySQL — splices NaN in as an identifier (ER_BAD_FIELD_ERROR). Same class, different spelling.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id contract — MySQL', () => {
    const DBNAME = `wordjs_routeid_my_${process.pid}`;
    let request: any, app: any, f: Fixtures, reachable = false;

    const adminCfg = () => ({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'password',
    });

    before(async () => {
        request = require('supertest');
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection(adminCfg());
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.query(`CREATE DATABASE \`${DBNAME}\``);
            await admin.end();
        } catch {
            return; // reachable stays false
        }
        config.dbDriver = 'mysql';
        config.db = { ...adminCfg(), name: DBNAME };
        await database.init({ driver: 'mysql' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
        reachable = true;
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection(adminCfg());
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.end();
        } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('every router in the class actually serves a real id (positive control)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertRoutersActuallyWork(request, app, f, 'mysql');
    });
    it('a non-numeric id answers 404 at every site in the class', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertBadIdNeverReachesTheDriver(request, app, f, 'mysql');
    });
    it('a non-numeric id is indistinguishable from an absent id', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertBadIdMatchesAbsentId(request, app, f, 'mysql');
    });
    it('the sites that were never defective are unchanged', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertNonDefectsUnchanged(request, app, f, 'mysql');
    });
    it('an id wider than the id columns answers 404 at every site in the class', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertOutOfRangeIdIs404(request, app, f, 'mysql');
    });
    it('the contract is answered before the route auth gate', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertAnonymousAlsoGets404(request, app, 'mysql');
    });
});
