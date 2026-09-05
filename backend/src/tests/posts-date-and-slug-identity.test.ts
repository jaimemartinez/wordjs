/**
 * POSTS ROUTER — the publish DATE as a capability, and slug lookup as a TYPED identity.
 *
 * Two audit findings, both about the /posts routes handing out something the caller never earned:
 *
 *   #17 (routes half) — PUT/POST downgraded the STATUS when the actor lacks publish_<type>s and then
 *       forwarded `date` untouched. An explicit date is the ONLY thing that schedules (the model turns
 *       a future date into 'future' by itself), so the date was a publishing capability with no gate:
 *       a contributor could stamp their own draft in 2099, and `date` with NO status at all makes
 *       Post.update re-evaluate the CURRENT status — a future date on a published post unpublishes it.
 *
 *   #18 (read twin) — a slug is unique PER TYPE (generateUniqueSlug de-duplicates within one
 *       post_type), so a post `about` and a page `about` is an ordinary pair. GET /posts/slug/:slug
 *       looked the row up with NO type, and `WHERE post_name = ?` with nothing ordering it served
 *       whichever row came back first.
 *
 * Everything here goes through the REAL router with supertest and the REAL post-type registry: a
 * hand-built object would prove nothing about what the producer emits.
 *
 * Same config-repoint + CWD-sandbox ordering as the other supertest suites.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-posts-date-slug-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const iso = (ms: number) => new Date(ms).toISOString();
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

describe('posts router: date capability + typed slug identity', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string, authorToken: string, contributorToken: string;

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);

    /** The stored publication instant, straight out of the row the route wrote. */
    async function dateGmtOf(postId: number): Promise<string> {
        const row = await dbAsync.get('SELECT post_date_gmt FROM posts WHERE id = ?', [postId]);
        return String(row.post_date_gmt);
    }

    async function statusOf(postId: number): Promise<string> {
        const row = await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [postId]);
        return String(row.post_status);
    }

    async function seedUser(login: string, role: string): Promise<number> {
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            [login, 'x', `${login}@example.com`, login]
        );
        const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, [login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [row.id, role]);
        return row.id;
    }

    const sign = (userId: number, username: string) =>
        jwt.sign({ userId, username }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        // The router's type gate (capsForType / isRestExposedPostType) resolves against the post-type
        // registry, which boot fills AFTER the DB connects — same here or every create 400s.
        await require('../core/post-types').initPostTypes();

        const adminId = await seedUser('admin', 'administrator');
        const authorId = await seedUser('author1', 'author');
        const contributorId = await seedUser('contrib', 'contributor');
        adminToken = sign(adminId, 'admin');
        authorToken = sign(authorId, 'author1');
        contributorToken = sign(contributorId, 'contrib');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.close?.(); } catch { /* */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    // ─────────────────────────────────────────────── #17: the date is a publishing capability

    it('PUT: a contributor sending {status:publish, date:2099} on their OWN draft moves neither', async () => {
        const created = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib draft', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);
        const id = created.body.id;
        const before = await dateGmtOf(id);

        const res = await as(contributorToken)(request(app).put(`/api/v1/posts/${id}`))
            .send({ status: 'publish', date: FAR_FUTURE });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'pending', 'the status downgrade still happens');
        assert.strictEqual(
            await dateGmtOf(id), before,
            'the ungated date must NOT be written: post_date_gmt stays exactly where it was'
        );
        assert.ok(!(await dateGmtOf(id)).startsWith('2099'), 'no 2099 stamp survives the downgrade');
    });

    it('PUT: `date` with NO status is the same capability — a contributor cannot move it either', async () => {
        const created = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib draft 2', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);
        const id = created.body.id;
        const before = await dateGmtOf(id);

        // Post.update re-evaluates the CURRENT status against a bare date, so this shape is how a
        // future date unpublishes live content without ever naming a status.
        const res = await as(contributorToken)(request(app).put(`/api/v1/posts/${id}`))
            .send({ date: FAR_FUTURE });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await dateGmtOf(id), before, 'a bare date is gated exactly like a dated publish');
        assert.strictEqual(await statusOf(id), 'draft', 'and the status cannot be flipped through it');
    });

    it('POST: the create path carries the same gate (contributor → pending, and dated NOW)', async () => {
        const res = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib dated create', status: 'publish', type: 'post', date: FAR_FUTURE });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.status, 'pending', 'scheduling IS publishing — downgraded');
        const stored = await dateGmtOf(res.body.id);
        assert.ok(!stored.startsWith('2099'), `the dropped date must not land in the row (got ${stored})`);
    });

    it('CONTROL: a user who MAY publish still schedules — an explicit date is the only way to', async () => {
        const when = Date.now() + 3_600_000;
        const created = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Author draft', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);

        const res = await as(authorToken)(request(app).put(`/api/v1/posts/${created.body.id}`))
            .send({ status: 'publish', date: iso(when) });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'future', 'the gate must not break scheduling for the capable');
        assert.ok((await dateGmtOf(created.body.id)).startsWith(iso(when).slice(0, 10)), 'the chosen day is stored');
    });

    // ─────────────────────────────────────────────── #18 twin: slug lookup is typed

    let postId: number, pageId: number;

    it('a post and a page may legally share a slug (generateUniqueSlug is per type)', async () => {
        const p = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'About the blog', slug: 'about', status: 'publish', type: 'post' });
        assert.strictEqual(p.status, 201);
        postId = p.body.id;

        const pg = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'About us', slug: 'about', status: 'publish', type: 'page' });
        assert.strictEqual(pg.status, 201);
        pageId = pg.body.id;

        const row = await dbAsync.get('SELECT post_name FROM posts WHERE id = ?', [pageId]);
        assert.strictEqual(row.post_name, 'about', 'the page keeps the slug — the collision is real, not de-duplicated');
        assert.notStrictEqual(postId, pageId);
    });

    it('GET /slug/:slug?type=page returns the PAGE, not whichever row came first', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'page' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, pageId, 'the declared type decides the identity');
        assert.strictEqual(res.body.type, 'page');
    });

    it('GET /slug/:slug?type=post returns the POST', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'post' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, postId);
        assert.strictEqual(res.body.type, 'post');
    });

    it('with NO declared type the answer is DETERMINISTIC (post wins) and repeats', async () => {
        for (let i = 0; i < 3; i++) {
            const res = await request(app).get('/api/v1/posts/slug/about');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.id, postId, 'same request, same row, every time');
        }
    });

    it('a page-only slug still resolves without a declared type (the precedence falls through)', async () => {
        const pg = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contact', slug: 'contact-only', status: 'publish', type: 'page' });
        assert.strictEqual(pg.status, 201);

        const res = await request(app).get('/api/v1/posts/slug/contact-only');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, pg.body.id, 'pages stay reachable at the bare slug URL');
    });

    it('an INTERNAL type cannot be addressed by slug either (400, same rule as the list)', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'nav_menu_item' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'rest_invalid_post_type');
    });

    // UNREGISTERED is NOT internal — and this assertion used to say it was, which is how the two
    // guards over one invariant went on contradicting each other: the LIST accepts an unregistered
    // type (isInternalPostType) while this route refused it (isRestExposedPostType), so after a
    // `DELETE /types/book` the content was listable and not readable by slug. Both routes now ask the
    // same question, and an unregistered type simply resolves to "no such slug".
    it('an UNREGISTERED type is ADDRESSABLE (404 for a slug it has no row for), like the list', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'not_a_type' });
        assert.strictEqual(res.status, 404, 'the list accepts this type; the slug route must not 400 on it');
        const list = await request(app).get('/api/v1/posts').query({ type: 'not_a_type' });
        assert.strictEqual(list.status, 200, 'the two guards must agree about what a type is');
    });

    /* ══════════════════════════════════════════════════════════════════════════════════════════════
     * THE LIST FILTERS, AND THE AUTHOR ON THE WIRE
     *
     * Two halves of one defect: the list ACCEPTED `?categories=`, `?tags=` and `?author=` and applied
     * none of them, and the author it serialised was a bare number that no consumer of the content
     * contract could read.
     *
     *   · `categories`/`tags` were destructured out of req.query and handed to neither
     *     Post.findAllWithRelations nor Post.count, so `?categories=3` returned exactly the rows no
     *     filter returns — with an X-WP-Total that agreed, which is what made it invisible.
     *   · `?author=jane-doe` was WORSE than ignored: parseInt('jane-doe') is NaN and NaN is falsy, so
     *     an author slug silently widened the request to the whole site.
     *   · `toJSON()` emitted `author: this.authorId` while the generated ContentRecord has typed it as
     *     `{ id, displayName }` since F2 — so the OpenGraph `authors`, the JSON-LD `author` and the
     *     blog roll byline all read `undefined` off a number, forever.
     *
     * EVERY ASSERTION HERE CARRIES ITS CONTROL. A filter test that only checks "the expected post is
     * present" passes just as happily when the filter does nothing at all, which is precisely how the
     * defect survived: each one below also proves the rows the filter must EXCLUDE are excluded, and
     * the total that accompanies them moves with the rows.
     * ══════════════════════════════════════════════════════════════════════════════════════════════ */

    let newsId: number, guidesId: number, reactId: number, astroId: number;
    let author1Id: number, nickId: number, adaId: number;
    let pNewsReact: number, pNewsAstro: number, pGuidesReact: number, pUntagged: number, pAda: number;

    /** A term + its taxonomy row, straight into the tables (no dependency on the Term model). */
    async function makeTerm(name: string, slug: string, taxonomy: string): Promise<number> {
        const t = await dbAsync.run('INSERT INTO terms (name, slug) VALUES (?, ?)', [name, slug]);
        await dbAsync.run(
            'INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count) VALUES (?, ?, ?, 0, 0)',
            [t.lastID, taxonomy, ''],
        );
        return t.lastID;
    }

    /** The ids `GET /posts` answers with, plus the total header that must agree with them. */
    async function listIds(query: string): Promise<{ status: number; ids: number[]; total: string }> {
        const res = await request(app).get(`/api/v1/posts?${query}`);
        return {
            status: res.status,
            ids: Array.isArray(res.body) ? res.body.map((p: any) => p.id) : [],
            total: res.headers['x-wp-total'],
        };
    }

    it('seeds a taxonomy and an author matrix (news/guides × react/astro, two authors)', async () => {
        const Post = require('../models/Post');
        author1Id = (await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['author1'])).id;

        // A user whose PUBLIC slug is not their login: user_nicename is WordPress's author slug, and
        // this schema defaults it to '' — so both branches of the resolution need a row to exercise.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename)
             VALUES (?, 'x', ?, ?, ?)`,
            ['nick', 'nick@example.com', 'Nick Name', 'nick-name'],
        );
        nickId = (await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['nick'])).id;

        // The OTHER branch, and the one the leak lived in: an account whose nicename was never
        // written (every account, before migration 0015) and whose login is nothing like its display
        // name. Seeded raw, exactly as a pre-0015 row looks, so the assertion below measures the
        // serialiser's fallback and not something User.create arranged for it.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name)
             VALUES (?, 'x', ?, ?)`,
            ['ada.lovelace.1815', 'ada@example.com', 'Ada Lovelace'],
        );
        adaId = (await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['ada.lovelace.1815'])).id;

        newsId = await makeTerm('News', 'news', 'category');
        guidesId = await makeTerm('Guides', 'guides', 'category');
        reactId = await makeTerm('React', 'react', 'post_tag');
        astroId = await makeTerm('Astro', 'astro', 'post_tag');

        const mk = async (title: string, authorId: number, cats: number[], tags: number[]) => {
            const p = await Post.create({ authorId, title, content: 'x', status: 'publish', type: 'post' });
            if (cats.length) await Post.setTerms(p.id, cats, 'category');
            if (tags.length) await Post.setTerms(p.id, tags, 'post_tag');
            return p.id;
        };
        pNewsReact = await mk('News + React', author1Id, [newsId], [reactId]);
        pNewsAstro = await mk('News + Astro', author1Id, [newsId], [astroId]);
        pGuidesReact = await mk('Guides + React', nickId, [guidesId], [reactId]);
        pUntagged = await mk('No terms at all', nickId, [], []);
        // No terms either, so it changes no filtered total below — it exists only to be serialised.
        pAda = await mk('Notes on the Analytical Engine', adaId, [], []);

        // CONTROL FOR EVERY FILTER BELOW: unfiltered, all four are in one page together.
        const all = await listIds('type=post&status=publish&per_page=100');
        assert.strictEqual(all.status, 200);
        for (const id of [pNewsReact, pNewsAstro, pGuidesReact, pUntagged]) {
            assert.ok(all.ids.includes(id), `the unfiltered list must contain ${id} — otherwise nothing below measures a filter`);
        }
    });

    it('toJSON emits author as {id, displayName, slug} — the shape the content contract declares', async () => {
        const res = await request(app).get(`/api/v1/posts/${pNewsReact}`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.author, { id: author1Id, displayName: 'author1', slug: String(author1Id) },
            'a bare number here is the bug: every consumer reads author.displayName');
        assert.strictEqual(res.body.authorId, author1Id, 'the raw id keeps a name of its own');

        // user_nicename IS the slug — the author feed resolves the same column, so the slug a post
        // carries is the slug /author/<slug> is addressed by.
        const other = await request(app).get(`/api/v1/posts/${pGuidesReact}`);
        assert.strictEqual(other.status, 200);
        assert.deepStrictEqual(other.body.author, { id: nickId, displayName: 'Nick Name', slug: 'nick-name' });

        // …and the LIST carries the identical object (hydrateRelations must not answer differently).
        const list = await request(app).get('/api/v1/posts?type=post&status=publish&per_page=100');
        const listed = list.body.find((p: any) => p.id === pGuidesReact);
        assert.deepStrictEqual(listed.author, other.body.author, 'the list and the item must serialise one author');

        // NOT AN ACCOUNT LISTING: an author byline must never become an e-mail enumeration.
        assert.deepStrictEqual(Object.keys(listed.author).sort(), ['displayName', 'id', 'slug']);
    });

    /**
     * THE LOGIN IS NOT A PUBLIC IDENTITY.
     *
     * `user_nicename` is NOT NULL DEFAULT '' and, before this change, nothing ever wrote it — so the
     * serialiser's `nicename || login` precedence resolved to `user_login` for EVERY account on a
     * default install, and `GET /posts` is anonymous. That is the string the login form takes,
     * published on every byline, feed and JSON-LD fragment of every post ever written. The fallback
     * is now the user id, which `?author=` and `/author/<id>` already resolve.
     *
     * Ada is seeded as a pre-migration row (empty nicename, login nothing like her name), so this
     * measures the fallback itself rather than a value some other writer happened to supply.
     */
    it('an account with no nicename falls back to its ID — never to user_login', async () => {
        const res = await request(app).get(`/api/v1/posts/${pAda}`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.author, { id: adaId, displayName: 'Ada Lovelace', slug: String(adaId) });

        // The whole serialised post, not just the author key: the login must appear NOWHERE in it.
        assert.ok(!JSON.stringify(res.body).includes('ada.lovelace.1815'),
            'the login leaked into the public payload');

        // Same for the anonymous LIST, which is the surface that turns one leak into an enumeration.
        const list = await request(app).get('/api/v1/posts?type=post&status=publish&per_page=100');
        assert.strictEqual(list.status, 200);
        assert.ok(!JSON.stringify(list.body).includes('ada.lovelace.1815'),
            'a public listing must not enumerate logins');

        // And the fallback is ADDRESSABLE: the slug a reader is handed narrows the list it came from.
        const byIdSlug = await listIds(`type=post&status=publish&per_page=100&author=${res.body.author.slug}`);
        assert.deepStrictEqual(byIdSlug.ids, [pAda], 'the emitted slug must resolve back to its author');
    });

    it('?categories= narrows by slug AND by id — and the total goes with the rows', async () => {
        const bySlug = await listIds('type=post&status=publish&per_page=100&categories=news');
        assert.strictEqual(bySlug.status, 200);
        assert.deepStrictEqual(bySlug.ids.slice().sort((a, b) => a - b), [pNewsReact, pNewsAstro].sort((a, b) => a - b));
        assert.ok(!bySlug.ids.includes(pGuidesReact) && !bySlug.ids.includes(pUntagged), 'the filter must EXCLUDE');
        assert.strictEqual(bySlug.total, '2', 'X-WP-Total must count the filtered set, not the site');

        const byId = await listIds(`type=post&status=publish&per_page=100&categories=${newsId}`);
        assert.deepStrictEqual(byId.ids.slice().sort((a, b) => a - b), bySlug.ids.slice().sort((a, b) => a - b),
            'the id and the slug address the same term');
        assert.strictEqual(byId.total, '2');
    });

    it('a list is OR within one taxonomy, and AND across two', async () => {
        const orWithin = await listIds(`type=post&status=publish&per_page=100&categories=news,${guidesId}`);
        assert.deepStrictEqual(orWithin.ids.slice().sort((a, b) => a - b),
            [pNewsReact, pNewsAstro, pGuidesReact].sort((a, b) => a - b), 'any of the listed terms matches');
        assert.strictEqual(orWithin.total, '3');

        const andAcross = await listIds('type=post&status=publish&per_page=100&categories=news&tags=react');
        assert.deepStrictEqual(andAcross.ids, [pNewsReact], 'both taxonomies must match');
        assert.strictEqual(andAcross.total, '1');

        // A pair that no single post satisfies is EMPTY, not "whatever the last filter said".
        const impossible = await listIds('type=post&status=publish&per_page=100&categories=guides&tags=astro');
        assert.deepStrictEqual(impossible.ids, []);
        assert.strictEqual(impossible.total, '0');
    });

    it('?tags= narrows on its own taxonomy only', async () => {
        const react = await listIds('type=post&status=publish&per_page=100&tags=react');
        assert.deepStrictEqual(react.ids.slice().sort((a, b) => a - b),
            [pNewsReact, pGuidesReact].sort((a, b) => a - b));
        assert.strictEqual(react.total, '2');

        // A category slug handed to `tags` matches NOTHING: the subquery is scoped by taxonomy, so the
        // two term namespaces cannot bleed into each other.
        const crossed = await listIds('type=post&status=publish&per_page=100&tags=news');
        assert.deepStrictEqual(crossed.ids, []);
        assert.strictEqual(crossed.total, '0');
    });

    it('?author= resolves a nicename, a login and an id — the public author identity, with no /users', async () => {
        const byNicename = await listIds('type=post&status=publish&per_page=100&author=nick-name');
        assert.deepStrictEqual(byNicename.ids.slice().sort((a, b) => a - b),
            [pGuidesReact, pUntagged].sort((a, b) => a - b));
        assert.strictEqual(byNicename.total, '2');

        // A LOGIN still resolves — but only for an account that has no nicename, which is the
        // back-compat case the next test pins from the other side. author1 is seeded raw, so it is one.
        const byLogin = await listIds('type=post&status=publish&per_page=100&author=author1');
        assert.ok(byLogin.ids.includes(pNewsReact) && byLogin.ids.includes(pNewsAstro));
        assert.ok(!byLogin.ids.includes(pGuidesReact), 'the other author must be excluded');

        const byId = await listIds(`type=post&status=publish&per_page=100&author=${nickId}`);
        assert.deepStrictEqual(byId.ids.slice().sort((a, b) => a - b), byNicename.ids.slice().sort((a, b) => a - b));

        // Nobody's slug is zero rows — never "everybody's".
        const nobody = await listIds('type=post&status=publish&per_page=100&author=not-a-user');
        assert.deepStrictEqual(nobody.ids, []);
        assert.strictEqual(nobody.total, '0');

        // Two authors OR together, and the author filter composes with a taxonomy one.
        const both = await listIds(`type=post&status=publish&per_page=100&author=author1,nick-name&tags=react`);
        assert.deepStrictEqual(both.ids.slice().sort((a, b) => a - b),
            [pNewsReact, pGuidesReact].sort((a, b) => a - b));
        assert.strictEqual(both.total, '2');
    });

    /**
     * `?author=<login>` IS NOT A LOGIN ORACLE.
     *
     * The slug branch used to read `(user_nicename IN (…) AND user_nicename <> '') OR user_login IN
     * (…)` — unconditionally. On an anonymous endpoint that answers "does this login exist?" for any
     * guess: a hit narrows the list to that account's posts, a miss returns an empty one. It is the
     * same fact the serialiser stopped publishing, confirmable one request at a time, which would
     * have moved the leak rather than closed it. The login now matches ONLY for an account that has
     * no nicename — the pre-migration rows the backfill could not name.
     *
     * `nick` is the login of an account whose nicename IS set ('nick-name'), and the assertion that
     * makes this test mean something is the pair: the miss must be indistinguishable from a login
     * that does not exist at all.
     */
    it('a LOGIN whose account has a nicename resolves nothing — no login-existence oracle', async () => {
        const byLogin = await listIds('type=post&status=publish&per_page=100&author=nick');
        assert.deepStrictEqual(byLogin.ids, [], 'the login of a named account must not narrow the list');
        assert.strictEqual(byLogin.total, '0');

        // …and it answers EXACTLY like a login nobody holds. Anything else is the oracle.
        const invented = await listIds('type=post&status=publish&per_page=100&author=no-such-login-at-all');
        assert.deepStrictEqual(byLogin.ids, invented.ids);
        assert.strictEqual(byLogin.total, invented.total);

        // CONTROL: the account IS reachable — by its nicename, which is the identity the API publishes.
        const bySlug = await listIds('type=post&status=publish&per_page=100&author=nick-name');
        assert.deepStrictEqual(bySlug.ids.slice().sort((a, b) => a - b),
            [pGuidesReact, pUntagged].sort((a, b) => a - b),
            'closing the oracle must not cost the author their own archive');

        // CONTROL: a login still works where it is the ONLY identity there is (pre-0015 rows).
        const legacy = await listIds('type=post&status=publish&per_page=100&author=ada.lovelace.1815');
        assert.deepStrictEqual(legacy.ids, [pAda], 'an account with no nicename keeps its login as a selector');

        // The OR list must not launder it either: one named login among real slugs stays inert.
        const mixed = await listIds('type=post&status=publish&per_page=100&author=nick,author1');
        assert.ok(!mixed.ids.includes(pGuidesReact) && !mixed.ids.includes(pUntagged),
            'a named account cannot be reached through its login by hiding it in a list');
        assert.ok(mixed.ids.includes(pNewsReact), 'while the nicename-less login in the same list still resolves');
    });

    it('pagination is right UNDER a filter (the count shares the WHERE with the rows)', async () => {
        const page1 = await request(app).get('/api/v1/posts?type=post&status=publish&categories=news&per_page=1&page=1');
        assert.strictEqual(page1.status, 200);
        assert.strictEqual(page1.body.length, 1);
        assert.strictEqual(page1.headers['x-wp-total'], '2');
        assert.strictEqual(page1.headers['x-wp-totalpages'], '2', 'the page count must come from the FILTERED total');

        const page2 = await request(app).get('/api/v1/posts?type=post&status=publish&categories=news&per_page=1&page=2');
        assert.strictEqual(page2.body.length, 1, 'page 2 of a filtered set must not be empty');
        assert.notStrictEqual(page2.body[0].id, page1.body[0].id, 'and must not repeat page 1');
        for (const id of [page1.body[0].id, page2.body[0].id]) {
            assert.ok([pNewsReact, pNewsAstro].includes(id), 'every page stays inside the filter');
        }

        const page3 = await request(app).get('/api/v1/posts?type=post&status=publish&categories=news&per_page=1&page=3');
        assert.deepStrictEqual(page3.body, [], 'past the filtered total there is nothing');
    });

    it('a malformed filter value is 400 rest_invalid_param, not a silently narrowed list', async () => {
        const malformed: Array<[string, string]> = [
            ['categories', 'categories=news,,guides'],   // a hole in the list
            ['categories', 'categories=news,'],          // a trailing separator is the same hole
            ['tags', 'tags=0'],                          // all digits, but no id column holds 0
            ['tags', 'tags=9999999999'],                 // out of range → 22003 on Postgres
            ['author', 'author=1,,2'],
            ['author', 'author=0'],
        ];
        for (const [field, qs] of malformed) {
            const res = await request(app).get(`/api/v1/posts?type=post&${qs}`);
            assert.strictEqual(res.status, 400, `GET /posts?${qs} was accepted with ${res.status}`);
            assert.strictEqual(res.body.code, 'rest_invalid_param');
            assert.ok(res.body.data && res.body.data.params && res.body.data.params[field],
                `the refusal must NAME ${field} (got ${JSON.stringify(res.body.data)})`);
        }

        // The SHAPE rule reaches them too, now that they are read: `?categories[]=news` is an Array.
        for (const qs of ['categories[]=news', 'tags[]=react', 'categories[k]=news']) {
            const res = await request(app).get(`/api/v1/posts?type=post&${qs}`);
            assert.strictEqual(res.status, 400, `GET /posts?${qs} was accepted with ${res.status}`);
            assert.strictEqual(res.body.code, 'rest_invalid_param');
        }

        // An ENTIRELY empty value is ABSENT, not malformed — the reading `?type=` already gets.
        const empty = await listIds('type=post&status=publish&per_page=100&categories=&tags=&author=');
        assert.strictEqual(empty.status, 200);
        assert.ok(empty.ids.includes(pUntagged), 'an empty filter must not narrow anything');
    });

    it('the filters cannot widen the status gate: an anonymous caller still sees only published', async () => {
        const Post = require('../models/Post');
        const hidden = await Post.create({
            authorId: author1Id, title: 'Filtered draft', content: 'x', status: 'draft', type: 'post',
        });
        await Post.setTerms(hidden.id, [newsId], 'category');

        const anon = await listIds('type=post&status=any&per_page=100&categories=news&author=author1');
        assert.ok(!anon.ids.includes(hidden.id), 'a taxonomy filter is not a way past the visibility gate');
        assert.deepStrictEqual(anon.ids.slice().sort((a, b) => a - b), [pNewsReact, pNewsAstro].sort((a, b) => a - b));
    });
});
