/**
 * MEMBERS-ONLY CONTENT NEVER LEAKS (core/content-access) — every read surface, three kinds of reader.
 *
 * The provider is the REAL bundled `memberships` plugin (marketplace/plugins/memberships), booted
 * in-process through the marketplace harness with its `wordjs.hooks.addFilter` wired to core's hook
 * system, so core asks exactly the filter the plugin registers in production. Readers:
 *   · anonymous;
 *   · a FREE member (a signed-in subscriber: free sign-up is on);
 *   · PAID members — one comped to the cheaper "Silver" tier, one to "Gold";
 * and the managers (the author, an editor) as the positive control that the body is really there.
 *
 * Each gated entry hides a unique marker after its access break. The assertions look for that marker in
 * the WHOLE serialized answer of every surface — REST (item, list, slug lookup, search), the RSS / Atom /
 * JSON feeds and a category feed, the sitemap, the comments API and the comments feed — so a leak
 * through any field (content, excerpt, the page-builder tree, a legacy zone) fails the test.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-content-access-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const hooks = require('../core/hooks');
const contentAccess = require('../core/content-access');
import { bootPlugin, type BootedPlugin } from './fixtures/marketplace-plugin-harness';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
const seo = express();
seo.use('/', require('../routes/seo'));

const U: Record<string, number> = {};
const P: Record<string, number> = {};
let db: any;
let plugin: BootedPlugin;
let seq = 0;
const registered: Array<[string, any]> = [];

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (who: string, m: string, p: string) => anon(m, p).set('Authorization', `Bearer ${tok(U[who], who)}`);
const ADMIN = { id: 1, role: 'administrator' };

const SECRET = {
    members: 'SECRET-MEMBERS-0f3a',
    paid: 'SECRET-PAID-77c1',
    gold: 'SECRET-GOLD-91be',
    nobreak: 'SECRET-NOBREAK-4d20',
    unknown: 'SECRET-UNKNOWN-a5e2',
    comment: 'SECRET-COMMENT-6b8d',
};
const ALL_SECRETS = Object.values(SECRET);

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename) VALUES (?, 'x', ?, ?, ?)`, [login, `${login}@example.com`, login, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/** A published post whose HTML body and Verso tree both put `secret` after an access break. */
async function seedGated(key: string, level: string, secret: string, opts: { withBreak?: boolean; title?: string } = {}) {
    seq++;
    const withBreak = opts.withBreak !== false;
    const html = withBreak
        ? `<p>Free teaser ${key}</p><hr class="wjs-access-break" /><p>${secret} hidden paragraph</p>`
        : `<p>${secret} the whole body is for members</p>`;
    const r = await db.run(
        `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, comment_status)
         VALUES (?, ?, ?, 'publish', 'post', ?, 'open')`,
        [U.author, opts.title || `Gated ${key}`, html, `gated-${key}-${seq}`]);
    const id = r.lastID;
    const tree = {
        root: { props: { title: `Gated ${key}` } },
        content: withBreak ? [
            { type: 'Text', props: { id: `t-${key}`, content: `Free teaser ${key}` } },
            { type: 'MembershipsPaywall', props: { id: `wall-${key}`, contentAccessBreak: true, title: 'Join' } },
            { type: 'Text', props: { id: `s-${key}`, content: `${secret} in the tree` } },
            { type: 'Section', props: { id: `sec-${key}` } },
        ] : [
            { type: 'Text', props: { id: `s-${key}`, content: `${secret} in the tree` } },
        ],
        zones: {
            [`sec-${key}:inner`]: [{ type: 'Text', props: { id: `z-${key}`, content: `${secret} in a legacy zone` } }],
            [`t-${key}:aside`]: [{ type: 'Text', props: { id: `za-${key}`, content: `public aside ${key}` } }],
        },
    };
    await db.run(`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, '_puck_data', ?)`, [id, JSON.stringify(tree)]);
    await db.run(`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, '_wjs_access', ?)`, [id, level]);
    return id;
}

const leaks = (body: unknown, secrets = ALL_SECRETS) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return secrets.filter((s) => text.includes(s));
};

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('editor', 'editor');
    await seedUser('author', 'author');
    await seedUser('free', 'subscriber');
    await seedUser('silver', 'subscriber');
    await seedUser('gold', 'subscriber');

    const coreUser = async (sql: string, v: any) => {
        const row = await db.get(`SELECT id, user_login, user_email, display_name FROM users WHERE ${sql} = ?`, [v]);
        return row ? { id: row.id, userLogin: row.user_login, userEmail: row.user_email, displayName: row.display_name } : null;
    };
    plugin = await bootPlugin('memberships', {
        hooks: {
            addFilter: (h, cb, pr) => { hooks.addFilter(h, cb, pr); registered.push([h, cb]); },
        },
        users: {
            findById: (id: any) => coreUser('id', id),
            findByEmail: (e: any) => coreUser('user_email', e),
            findByLogin: (l: any) => coreUser('user_login', l),
        },
    });
    const silver = await plugin.call('post', '/tiers', { user: ADMIN, body: { name: 'Silver', price_cents: 500 } });
    const gold = await plugin.call('post', '/tiers', { user: ADMIN, body: { name: 'Gold', price_cents: 1500, interval: 'year' } });
    assert.strictEqual(silver.status, 200, JSON.stringify(silver.body));
    assert.strictEqual(gold.status, 200, JSON.stringify(gold.body));
    for (const [login, tier] of [['silver', silver], ['gold', gold]] as const) {
        const r = await plugin.call('post', '/members/comp', { user: ADMIN, body: { user: `${login}@example.com`, tier_id: tier.body.tier.id } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }

    P.members = await seedGated('members', 'members', SECRET.members);
    P.paid = await seedGated('paid', 'paid', SECRET.paid);
    P.gold = await seedGated('gold', 'tier:gold', SECRET.gold);
    P.nobreak = await seedGated('nobreak', 'members', SECRET.nobreak, { withBreak: false });
    P.unknown = await seedGated('unknown', 'tier:does-not-exist', SECRET.unknown);
    const pub = await db.run(`INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, comment_status)
        VALUES (?, 'Open post', '<p>open body</p>', 'publish', 'post', 'open-post', 'open')`, [U.author]);
    P.open = pub.lastID;
    await db.run(`INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type)
        VALUES (?, 'Reader', 'r@example.com', ?, '1', 0, 'comment')`, [P.paid, SECRET.comment]);

    // A category with every post in it, for the scoped feed.
    const t = await db.run(`INSERT INTO terms (name, slug) VALUES ('News', 'news')`);
    const tt = await db.run(`INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count) VALUES (?, 'category', '', 0, 0)`, [t.lastID]);
    for (const id of Object.values(P)) await db.run(`INSERT INTO term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)`, [id, tt.lastID]);
});

after(async () => {
    for (const [h, cb] of registered) { try { hooks.removeFilter(h, cb); } catch { /* */ } }
    try { plugin.close(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

describe('the core cut (core/content-access)', () => {
    test('teaserHtml cuts at the access break and withholds a body that has none', () => {
        assert.strictEqual(contentAccess.teaserHtml('<p>a</p><hr class="x wjs-access-break" /><p>b</p>'), '<p>a</p>');
        assert.strictEqual(contentAccess.teaserHtml("<p>a</p><hr class='wjs-access-break'><p>b</p>"), '<p>a</p>');
        assert.strictEqual(contentAccess.teaserHtml('<p>a</p><hr /><p>b</p>'), '', 'a plain <hr> is not a break');
        assert.strictEqual(contentAccess.teaserHtml(undefined), '');
    });

    test('teaserVersoData keeps the items before the break, the break (annotated), and only their zones', () => {
        const out = contentAccess.teaserVersoData({
            root: { props: { title: 'x' } },
            content: [
                { type: 'Text', props: { id: 'a' } },
                { type: 'Wall', props: { id: 'w', contentAccessBreak: true } },
                { type: 'Text', props: { id: 'b' } },
            ],
            zones: { 'a:z': [{ type: 'Text', props: { id: 'a2' } }], 'a2:z': [{ type: 'T', props: { id: 'a3' } }], 'b:z': [{ type: 'Text', props: { id: 'b2' } }] },
        }, 'paid');
        assert.deepStrictEqual(out.content.map((i: any) => i.props.id), ['a', 'w']);
        assert.strictEqual(out.content[1].props.accessState, 'locked');
        assert.strictEqual(out.content[1].props.accessLevel, 'paid');
        assert.deepStrictEqual(Object.keys(out.zones).sort(), ['a2:z', 'a:z'], 'nested zones of kept items survive; others do not');
        assert.deepStrictEqual(out.root, { props: { title: 'x' } });
    });

    test('a break nested in a container cuts before the container and is lifted to the top level', () => {
        const out = contentAccess.teaserVersoData({
            content: [
                { type: 'Text', props: { id: 'a' } },
                { type: 'Section', props: { id: 's', items: [{ type: 'Text', props: { id: 'hidden' } }, { type: 'Wall', props: { id: 'w', contentAccessBreak: true } }] } },
            ],
        });
        assert.deepStrictEqual(out.content.map((i: any) => i.props.id), ['a', 'w']);
        assert.strictEqual(leaks(out, ['hidden']).length, 0);
    });

    test('no break in the tree → no items at all', () => {
        const out = contentAccess.teaserVersoData({ content: [{ type: 'Text', props: { id: 'a' } }] });
        assert.deepStrictEqual(out.content, []);
    });

    test('levels from a provider are validated and bounded', () => {
        assert.deepStrictEqual(contentAccess.cleanLevels(['members', 'members', 'tier:gold', 'BAD', 42, '', 'x y']), ['members', 'tier:gold']);
        assert.deepStrictEqual(contentAccess.cleanLevels('members'), []);
    });
});

describe('REST: what each reader receives', () => {
    test('anonymous: every gated entry is its teaser — no body, no derived excerpt, no tree beyond the wall', async () => {
        for (const key of ['members', 'paid', 'gold', 'nobreak', 'unknown']) {
            const r = await anon('get', `/posts/${P[key]}`);
            assert.strictEqual(r.status, 200, key);
            assert.deepStrictEqual(leaks(r.body), [], `GET /posts/${key} leaks`);
            assert.deepStrictEqual(r.body.access, { level: r.body.access.level, gated: true, granted: false }, key);
        }
        const r = await anon('get', `/posts/${P.paid}`);
        assert.ok(r.body.content.includes('Free teaser paid'), 'the teaser is served');
        assert.ok(r.body.excerpt.includes('Free teaser paid'), 'the excerpt is derived from the teaser');
        const tree = r.body.meta._puck_data;
        assert.deepStrictEqual(tree.content.map((i: any) => i.type), ['Text', 'MembershipsPaywall']);
        assert.strictEqual(tree.content[1].props.accessState, 'locked');
        assert.strictEqual(tree.content[1].props.accessLevel, 'paid');
        assert.deepStrictEqual(Object.keys(tree.zones), ['t-paid:aside']);
        const nb = await anon('get', `/posts/${P.nobreak}`);
        assert.strictEqual(nb.body.content, '');
        assert.deepStrictEqual(nb.body.meta._puck_data.content, []);
    });

    test('anonymous: lists, slug lookups and the public projection carry no gated body', async () => {
        const list = await anon('get', '/posts?per_page=100');
        assert.strictEqual(list.status, 200);
        assert.deepStrictEqual(leaks(list.body), []);
        assert.ok(list.body.some((p: any) => p.id === P.paid), 'gated entries are listed (as teasers)');
        const slug = (await db.get('SELECT post_name FROM posts WHERE id = ?', [P.gold])).post_name;
        const bySlug = await anon('get', `/posts?slug=${slug}`);
        assert.deepStrictEqual(leaks(bySlug.body), []);
        assert.ok(JSON.stringify(bySlug.body).includes('Free teaser gold'));
        assert.ok(!('_wjs_access' in list.body.find((p: any) => p.id === P.paid).meta), 'the raw meta stays internal');
    });

    test('free member: the `members` level opens, paid levels stay locked', async () => {
        const m = await as('free', 'get', `/posts/${P.members}`);
        assert.strictEqual(m.body.access.granted, true);
        assert.ok(m.body.content.includes(SECRET.members), 'positive control: the free member reads the members body');
        assert.strictEqual(m.body.meta._puck_data.content.find((i: any) => i.type === 'MembershipsPaywall').props.accessState, 'granted');
        for (const key of ['paid', 'gold', 'unknown']) {
            const r = await as('free', 'get', `/posts/${P[key]}`);
            assert.strictEqual(r.body.access.granted, false, key);
            assert.deepStrictEqual(leaks(r.body), [], `${key} leaks to a free member`);
        }
    });

    test('paid members: a tier opens `paid` and its own tier and cheaper ones, never a dearer one', async () => {
        const silverPaid = await as('silver', 'get', `/posts/${P.paid}`);
        assert.ok(silverPaid.body.content.includes(SECRET.paid));
        const silverGold = await as('silver', 'get', `/posts/${P.gold}`);
        assert.strictEqual(silverGold.body.access.granted, false);
        assert.deepStrictEqual(leaks(silverGold.body), []);
        const goldGold = await as('gold', 'get', `/posts/${P.gold}`);
        assert.ok(goldGold.body.content.includes(SECRET.gold));
        assert.ok(JSON.stringify(goldGold.body.meta._puck_data).includes(`${SECRET.gold} in a legacy zone`), 'the full tree, zones included');
        const unknown = await as('gold', 'get', `/posts/${P.unknown}`);
        assert.deepStrictEqual(leaks(unknown.body), [], 'a level no provider grants is locked for everyone (fail closed)');
    });

    test('managers read every gated entry in full (the editor loads through this projection)', async () => {
        for (const who of ['author', 'editor']) {
            for (const key of ['paid', 'gold', 'unknown', 'nobreak']) {
                const r = await as(who, 'get', `/posts/${P[key]}`);
                assert.strictEqual(r.body.access.granted, true, `${who}/${key}`);
                assert.ok(JSON.stringify(r.body).includes(SECRET[key as keyof typeof SECRET]), `${who} reads ${key}`);
            }
        }
    });

    test('search matches a gated entry by its title, never by its withheld body', async () => {
        const a = await anon('get', `/posts?search=${SECRET.paid}`);
        assert.strictEqual(a.status, 200);
        assert.ok(!a.body.some((p: any) => p.id === P.paid), 'anonymous body match');
        assert.strictEqual(a.headers['x-wp-total'], '0');
        const f = await as('free', 'get', `/posts?search=${SECRET.members}`);
        assert.ok(!f.body.some((p: any) => p.id === P.members), 'no body oracle for members either');
        const byTitle = await anon('get', '/posts?search=Gated%20paid');
        assert.ok(byTitle.body.some((p: any) => p.id === P.paid), 'positive control: found by title');
        assert.deepStrictEqual(leaks(byTitle.body), []);
        const e = await as('editor', 'get', `/posts?search=${SECRET.paid}`);
        assert.ok(e.body.some((p: any) => p.id === P.paid), 'positive control: an editor searches bodies');
    });
});

describe('feeds and sitemaps', () => {
    test('RSS, Atom, JSON and a category feed publish teasers only', async () => {
        for (const feed of ['/feed.xml', '/feed.atom', '/feed.json', '/category/news/feed.xml']) {
            const r = await (request(seo) as any).get(feed);
            assert.strictEqual(r.status, 200, feed);
            const text = r.text || String(r.body);
            assert.deepStrictEqual(leaks(text), [], `${feed} leaks`);
            assert.ok(text.includes('Free teaser paid'), `${feed}: the gated entry is listed with its teaser`);
            assert.ok(text.includes('open body'), `${feed}: positive control`);
        }
    });

    test('the sitemap lists a gated entry (its page is public) and carries no body', async () => {
        const r = await (request(seo) as any).get('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        const slug = (await db.get('SELECT post_name FROM posts WHERE id = ?', [P.paid])).post_name;
        assert.ok(String(r.text).includes(`/${slug}<`), 'listed');
        assert.deepStrictEqual(leaks(r.text), []);
    });
});

describe('comments of a gated entry are gated with it', () => {
    test('anonymous and free members: not listed (per entry or site-wide), not fetchable, not writable, not in the feed', async () => {
        for (const who of [null, 'free']) {
            const call = (m: string, p: string) => (who ? as(who, m, p) : anon(m, p));
            const perPost = await call('get', `/comments?post=${P.paid}`);
            assert.deepStrictEqual(perPost.body, [], `${who || 'anon'} per-entry list`);
            const site = await call('get', '/comments?per_page=100');
            assert.deepStrictEqual(leaks(site.body), [], `${who || 'anon'} site-wide list`);
            const id = (await db.get('SELECT comment_id FROM comments WHERE comment_content = ?', [SECRET.comment])).comment_id;
            assert.strictEqual((await call('get', `/comments/${id}`)).status, 404);
            const w = await call('post', '/comments').send({ post: P.paid, content: 'let me in', author_name: 'x', author_email: 'x@x.example' });
            assert.strictEqual(w.status, 404, `${who || 'anon'} cannot comment`);
        }
        const feed = await (request(seo) as any).get('/comments/feed.xml');
        assert.strictEqual(feed.status, 200);
        assert.deepStrictEqual(leaks(feed.text), []);
    });

    test('a member who holds the level reads and writes them', async () => {
        const list = await as('silver', 'get', `/comments?post=${P.paid}`);
        assert.ok(JSON.stringify(list.body).includes(SECRET.comment));
        const w = await as('silver', 'post', '/comments').send({ post: P.paid, content: 'member reply' });
        assert.strictEqual(w.status, 201, JSON.stringify(w.body));
    });
});

describe('the provider contract', () => {
    test('the editor is offered the provider\'s levels', async () => {
        const r = await as('author', 'get', '/content-access/levels');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.metaKey, '_wjs_access');
        assert.deepStrictEqual(r.body.levels.map((l: any) => l.value), ['members', 'paid', 'tier:silver', 'tier:gold']);
        assert.strictEqual((await as('free', 'get', '/content-access/levels')).status, 403, 'subscribers cannot list them');
        assert.strictEqual((await anon('get', '/content-access/levels')).status, 401);
    });

    test('the grants filter is never asked for an anonymous reader', async () => {
        let asked = 0;
        const spy = (v: any) => { asked++; return v; };
        hooks.addFilter('content_access_grants', spy);
        try {
            await anon('get', `/posts/${P.paid}`);
            assert.strictEqual(asked, 0);
            await as('free', 'get', '/posts?per_page=100');
            assert.strictEqual(asked, 1, 'once per request, however many gated entries the list holds');
        } finally {
            hooks.removeFilter('content_access_grants', spy);
        }
    });

    test('without a provider every gated entry is locked (fail closed); managers still read it', async () => {
        for (const [h, cb] of registered) hooks.removeFilter(h, cb);
        try {
            const m = await as('free', 'get', `/posts/${P.members}`);
            assert.strictEqual(m.body.access.granted, false);
            assert.deepStrictEqual(leaks(m.body), []);
            const g = await as('gold', 'get', `/posts/${P.gold}`);
            assert.deepStrictEqual(leaks(g.body), []);
            const e = await as('editor', 'get', `/posts/${P.gold}`);
            assert.ok(e.body.content.includes(SECRET.gold));
        } finally {
            for (const [h, cb] of registered) hooks.addFilter(h, cb);
        }
    });
});

describe('the posts bridge and the editor-field seam', () => {
    const PROBE = 'wjs-posts-bridge-probe';
    const probeDir = path.join(path.resolve(__dirname, '../../plugins'), PROBE);
    const { createPluginApi } = require('../core/plugin-api');
    const { runWithContext } = require('../core/plugin-context');

    test('posts.get: published public entries only, full body + access level; denied without posts:read', async () => {
        fs.mkdirSync(probeDir, { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ name: PROBE, permissions: [{ scope: 'posts', access: 'read' }] }));
        const grants = require('../core/plugin-permissions');
        try {
            grants._setGrantsInMemory(PROBE, []);
            await runWithContext(PROBE, async () => {
                await assert.rejects(() => createPluginApi(PROBE).posts.get(P.paid));
            });
            grants._setGrantsInMemory(PROBE, ['posts:read']);
            await runWithContext(PROBE, async () => {
                const api = createPluginApi(PROBE);
                const paid = await api.posts.get(P.paid);
                assert.strictEqual(paid.accessLevel, 'paid');
                assert.ok(paid.content.includes(SECRET.paid), 'the full body: the plugin decides per recipient');
                assert.strictEqual(paid.excerpt, '', 'never an excerpt derived from the body');
                assert.ok(paid.url.endsWith(paid.path) && paid.path.startsWith('/gated-paid-'));
                assert.ok(!('_wjs_access' in paid.meta) && !('_puck_data' in paid.meta), 'public meta only');
                const draft = (await db.run(`INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name) VALUES (?, 'D', 'draft body', 'draft', 'post', 'pb-draft')`, [U.author])).lastID;
                const locked = (await db.run(`INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_password) VALUES (?, 'L', 'pw body', 'publish', 'post', 'pb-pw', 'x')`, [U.author])).lastID;
                for (const id of [draft, locked, 999999, 'x']) assert.strictEqual(await api.posts.get(id), null, String(id));
            });
        } finally {
            try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* */ }
        }
    });

    test('GET /editor/fields: validated plugin declarations for the post type, editors only', async () => {
        const decl = async (fields: any[]) => [...fields,
            { metaKey: 'newsletter_audience', label: 'Send', type: 'select', options: [{ value: '', label: 'No' }, { value: 'all', label: 'All' }] },
            { metaKey: '_internal', label: 'x', type: 'text' },
            { metaKey: 'page_only', label: 'P', type: 'text', postTypes: ['page'] },
        ];
        hooks.addFilter('post_editor_fields', decl);
        try {
            const r = await as('author', 'get', '/editor/fields?type=post');
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body.fields.map((f: any) => f.metaKey), ['newsletter_audience']);
            assert.deepStrictEqual((await as('author', 'get', '/editor/fields?type=page')).body.fields.map((f: any) => f.metaKey), ['page_only']);
            assert.strictEqual((await as('free', 'get', '/editor/fields')).status, 403);
            assert.strictEqual((await anon('get', '/editor/fields')).status, 401);
        } finally {
            hooks.removeFilter('post_editor_fields', decl);
        }
    });
});

describe('every twin of the REST projection (second audit)', () => {
    /** A published post by the author with this raw `_puck_data` text and this raw `_wjs_access` text. */
    async function seedRaw(title: string, html: string, puckText: string | null, levelText: string) {
        seq++;
        const r = await db.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, comment_status)
             VALUES (?, ?, ?, 'publish', 'post', ?, 'open')`,
            [U.author, title, html, `raw-${seq}`]);
        if (puckText !== null) await db.run(`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, '_puck_data', ?)`, [r.lastID, puckText]);
        await db.run(`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, '_wjs_access', ?)`, [r.lastID, levelText]);
        return r.lastID;
    }

    test('GET /posts/:id/meta serves the same teaser tree as GET /posts/:id', async () => {
        for (const key of ['members', 'paid', 'gold', 'nobreak', 'unknown']) {
            const r = await anon('get', `/posts/${P[key]}/meta`);
            assert.strictEqual(r.status, 200, key);
            assert.deepStrictEqual(leaks(r.body), [], `GET /posts/${key}/meta leaks to anonymous`);
        }
        const free = await as('free', 'get', `/posts/${P.paid}/meta`);
        assert.deepStrictEqual(leaks(free.body), [], 'a free member reads no paid tree through /meta');
        assert.strictEqual(free.body._puck_data.content.find((i: any) => i.type === 'MembershipsPaywall').props.accessState, 'locked');
        const silver = await as('silver', 'get', `/posts/${P.paid}/meta`);
        assert.ok(JSON.stringify(silver.body).includes(SECRET.paid), 'positive control: a paid member reads the tree');
        const author = await as('author', 'get', `/posts/${P.gold}/meta`);
        assert.ok(JSON.stringify(author.body).includes(SECRET.gold), 'positive control: the author reads the raw map');
    });

    test('the excerpt the editor stores in the root props of the tree is not served to a locked reader', async () => {
        const secret = 'SECRET-ROOT-EXCERPT-31aa';
        const tree = {
            root: { props: { title: 'Root excerpt', excerpt: `${secret} first words of the whole body` } },
            content: [
                { type: 'Text', props: { id: 'r1', content: 'teaser' } },
                { type: 'MembershipsPaywall', props: { id: 'rw', contentAccessBreak: true } },
            ],
        };
        const id = await seedRaw('Root excerpt', '<p>teaser</p><hr class="wjs-access-break" /><p>rest</p>', JSON.stringify(tree), 'paid');
        for (const path of [`/posts/${id}`, `/posts/${id}/meta`]) {
            const r = await anon('get', path);
            assert.deepStrictEqual(leaks(r.body, [secret]), [], `${path} leaks the root excerpt`);
        }
        const r = await anon('get', `/posts/${id}`);
        assert.strictEqual(r.body.meta._puck_data.root.props.title, 'Root excerpt', 'the rest of the root stays');
        const silver = await as('silver', 'get', `/posts/${id}`);
        assert.ok(JSON.stringify(silver.body).includes(secret), 'positive control: a reader with access gets it');
    });

    test('a tree the cut cannot read (double-encoded, zones only) is withheld whole, not served whole', async () => {
        const secret = 'SECRET-MALFORMED-c0de';
        const inner = { content: [{ type: 'Text', props: { id: 'm1', content: `${secret} encoded twice` } }] };
        const twice = await seedRaw('Twice', '', JSON.stringify(JSON.stringify(inner)), 'members');
        const zonesOnly = await seedRaw('Zones only', '', JSON.stringify({ root: { props: {} }, zones: { 'x:y': [{ type: 'Text', props: { id: 'm2', content: `${secret} in a zone` } }] } }), 'members');
        for (const id of [twice, zonesOnly]) {
            for (const path of [`/posts/${id}`, `/posts/${id}/meta`]) {
                const r = await anon('get', path);
                assert.strictEqual(r.status, 200, path);
                assert.deepStrictEqual(leaks(r.body, [secret]), [], `${path} leaks a malformed tree`);
            }
        }
    });

    test('a break inside a legacy zone cuts before the container that owns the zone', async () => {
        const secret = 'SECRET-ZONE-BREAK-7e7e';
        const tree = {
            content: [
                { type: 'Text', props: { id: 'zb1', content: 'teaser' } },
                { type: 'Section', props: { id: 'zbs' } },
                { type: 'MembershipsPaywall', props: { id: 'zbw2', contentAccessBreak: true } },
            ],
            zones: { 'zbs:inner': [
                { type: 'MembershipsPaywall', props: { id: 'zbw', contentAccessBreak: true } },
                { type: 'Text', props: { id: 'zbt', content: `${secret} after the break of the zone` } },
            ] },
        };
        const id = await seedRaw('Zone break', '', JSON.stringify(tree), 'paid');
        const r = await anon('get', `/posts/${id}`);
        assert.deepStrictEqual(leaks(r.body, [secret]), []);
        assert.deepStrictEqual(r.body.meta._puck_data.content.map((i: any) => i.props.id), ['zb1', 'zbw']);
    });

    test('a level stored as a non-string (null, [], a number) gates on REST as the SQL gate does', async () => {
        for (const levelText of ['null', '[]', '{}', '42', 'true']) {
            const secret = `SECRET-LEVEL-${levelText.replace(/\W/g, 'x')}-55`;
            const id = await seedRaw(`Level ${levelText}`, `<p>${secret}</p>`, null, levelText);
            const r = await anon('get', `/posts/${id}`);
            assert.deepStrictEqual(leaks(r.body, [secret]), [], `level ${levelText} served the body`);
            assert.strictEqual(r.body.access.gated, true, levelText);
            const g = await as('gold', 'get', `/posts/${id}`);
            assert.deepStrictEqual(leaks(g.body, [secret]), [], `no provider level unlocks ${levelText}`);
            const a = await as('author', 'get', `/posts/${id}`);
            assert.ok(a.body.content.includes(secret), 'positive control: the author reads it');
        }
        assert.deepStrictEqual(contentAccess.cleanLevels(['null', 'true', 'false', '42', '9lives', 'members']), ['members'],
            'a provider cannot offer or grant a level that JSON-decodes to something else');
    });

    test('the files attached to a gated entry are not listed or served by id to who does not manage it', async () => {
        const att = await db.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_parent, post_mime_type, guid)
             VALUES (?, 'Premium download', '', 'inherit', 'attachment', 'premium-download', ?, 'application/pdf', '/uploads/SECRET-FILE-premium.pdf')`,
            [U.author, P.paid]);
        const id = att.lastID;
        for (const who of [null, 'free', 'silver']) {
            const call = (m: string, p: string) => (who ? as(who, m, p) : anon(m, p));
            assert.strictEqual((await call('get', `/media/${id}`)).status, 404, `${who || 'anon'} GET /media/:id`);
            const list = await call('get', '/media?per_page=100');
            assert.strictEqual(list.status, 200);
            assert.ok(!JSON.stringify(list.body).includes('SECRET-FILE-premium'), `${who || 'anon'} media list`);
            const posts = await call('get', '/posts?type=attachment&per_page=100');
            assert.ok(!JSON.stringify(posts.body).includes('SECRET-FILE-premium'), `${who || 'anon'} /posts?type=attachment`);
        }
        assert.strictEqual((await as('author', 'get', `/media/${id}`)).status, 200, 'positive control: the author');
        const list = await as('editor', 'get', '/media?per_page=100');
        assert.ok(JSON.stringify(list.body).includes('SECRET-FILE-premium'), 'positive control: an editor lists it');
    });

    test('search does not RANK a gated entry by its withheld body', async () => {
        // Same title word; the OLDER entry repeats it all over its withheld body. By date alone the newer
        // one comes first — any other order tells the searcher what the hidden part says.
        const word = 'quokkaword';
        const older = await db.run(`INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_date)
            VALUES (?, ?, ?, 'publish', 'post', 'rank-older', '2020-01-01 00:00:00')`,
            [U.author, `${word} older`, `<p>t</p><hr class="wjs-access-break" /><p>${Array(60).fill(word).join(' ')}</p>`]);
        const newer = await db.run(`INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_date)
            VALUES (?, ?, ?, 'publish', 'post', 'rank-newer', '2021-01-01 00:00:00')`,
            [U.author, `${word} newer`, '<p>t</p><hr class="wjs-access-break" /><p>nothing here</p>']);
        for (const id of [older.lastID, newer.lastID]) {
            await db.run(`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, '_wjs_access', 'paid')`, [id]);
        }
        const r = await anon('get', `/posts?search=${word}&per_page=10`);
        assert.strictEqual(r.status, 200);
        const ids = r.body.map((p: any) => p.id);
        assert.deepStrictEqual(ids.filter((i: number) => i === older.lastID || i === newer.lastID), [newer.lastID, older.lastID]);
    });
});
