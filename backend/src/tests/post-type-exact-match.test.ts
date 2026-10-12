/**
 * A TYPE NAME SELECTS THE ROWS ITS POLICY WAS DECIDED FOR — ON EVERY ENGINE (security).
 *
 * GET /posts decides two things from the `type` it is given, with exact JavaScript comparisons: whether the
 * attachment rule applies (`type === 'attachment'`) and which read policy governs the list
 * (capsForType(type); an unknown name falls back to the public `post` policy; an internal name is refused).
 * Post.buildWhere then selected the rows with `post_type = ?`, which MySQL/MariaDB evaluate under
 * utf8mb4_unicode_ci — case- and accent-insensitive, PAD SPACE. So on those engines:
 *   · `?type=ATTACHMENT&status=inherit` (or `attachment%20`) listed to an editor every attachment of the
 *     entries they may not read — the attachment rule was never applied;
 *   · anonymous `?type=LEDGER` listed the published entries of a `public: false` type;
 *   · anonymous `?type=NAV_MENU_ITEM` listed the menu items.
 * The comparison is now exact on every engine (core/sql-exact-text), so a spelling that only the collation
 * equates with a type selects nothing. Post.findBySlug's type filter is the twin. On top of that the route
 * refuses a `type` spelled outside the canonical alphabet before any query runs (400
 * rest_invalid_post_type, routes/posts isListablePostTypeParam — posts-type-param-collation.test.ts), so
 * through the route a twin answers either that refusal or an empty 200 list; the model-level checks below
 * (Post.findAll / Post.count / Post.findBySlug with the twin) keep proving the SQL itself is exact.
 *
 * THREE ENGINE BLOCKS, ONE PROCESS:
 *   · SQLite, with `posts.post_type` declared COLLATE NOCASE — the case-insensitivity of MySQL's collation,
 *     modelled on the engine every run has. The plain `=` really does fold there (asserted first), so the
 *     fixed SQL is exercised against a folding column, not merely inspected. Search runs on FTS5.
 *   · The same database with posts_fts removed — what the sqlite-legacy driver builds, and what MySQL and
 *     PostgreSQL have. Search falls back to LIKE, and the block proves that the next engine block does not
 *     inherit the previous one's full-text engine (see resetSearchEngine).
 *   · A real MySQL server when one is reachable, in a database created with utf8mb4_unicode_ci — case,
 *     accents AND trailing spaces. CI wires one (WORDJS_CI_DB=1), where an unreachable server fails.
 *
 * AN ERROR IS NOT "NOTHING LISTED". Every request a leak check reads must answer 200 (or the route's
 * documented 400 rest_invalid_post_type refusal of the spelling, whose SQL the model checks cover): a 500 lists no row,
 * so a check that reads only the rows passes on a route that is broken — which is how a MySQL block that
 * sent FTS5 syntax to MySQL could have reported "no leak" for every spelling.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-post-type-exact-${process.pid}-`));
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'wordjs.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(TMP_ROOT, 'uploads');
const database = require('../config/database');

const LEDGER_TYPE = 'pte_ledger'; // public:false, its own `pteledger` capability family

function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

/**
 * Forget the full-text engine Post resolved for the previous engine block.
 *
 * Post resolves its search engine ONCE per process (Post._searchEngineCache, and the FTS5 probe behind it,
 * Post._ftsProbe) — right for a server, which runs one engine for its lifetime, wrong for this file, which
 * runs several in one process. Left alone, the SQLite block's 'fts5' outlives it and every searched request
 * of the next block sends `posts_fts MATCH ?` to an engine that has no posts_fts: a 500 on every request.
 * Every engine block calls this on entry and on exit.
 */
function resetSearchEngine(): void {
    const Post = require('../models/Post');
    Post._searchEngineCache = undefined;
    Post._ftsProbe = null;
}

function mountApp() {
    const express = require('express');
    const { errorHandler } = require('../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/posts', require('../routes/posts'));
    app.use(errorHandler);
    return app;
}

interface Fixture {
    editorToken: string;
    token: string;           // a search word every seeded row carries in its title
    hiddenAttachments: number[];
    visibleAttachment: number;
    ledgerEntries: number[];
    menuItems: number[];
    attachmentSlug: string;
}

/** Seed one database: users, the ledger type, attachments hidden from the editor, menu items. */
async function seed(dbAsync: any): Promise<Fixture> {
    const Post = require('../models/Post');
    const postTypes = require('../core/post-types');
    await postTypes.initPostTypes();
    if (!postTypes.getPostType(LEDGER_TYPE)) {
        postTypes.registerPostType(LEDGER_TYPE, { public: false, capability_type: 'pteledger', label: 'Ledgers' });
    }
    await require('../core/roles').loadRoles();

    const users: Record<string, number> = {};
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor']]) {
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
            [login, `${login}@example.com`, login]);
        const row = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', [login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [row.id, role]);
        users[login] = Number(row.id);
    }
    const token = `ptetoken${process.pid}x${Date.now()}`;
    const typed = async (type: string, status: string, title: string, parent = 0) => {
        if (type === 'attachment') {
            const att = await Post.create({ authorId: users.admin, title, type, status, parent, mimeType: 'image/png' });
            return Number(att.id);
        }
        const row = await Post.create({ authorId: users.admin, title, type: 'post', status, parent });
        await dbAsync.run('UPDATE posts SET post_type = ? WHERE id = ?', [type, row.id]);
        await Post._invalidatePostCacheById(row.id);
        return Number(row.id);
    };
    const ledgerEntries = [await typed(LEDGER_TYPE, 'publish', `${token} ledger one`), await typed(LEDGER_TYPE, 'publish', `${token} ledger two`)];
    const hiddenAttachments = [
        await typed('attachment', 'inherit', `${token} scan a`, ledgerEntries[0]),
        await typed('attachment', 'inherit', `${token} scan b`, ledgerEntries[1]),
    ];
    const visibleAttachment = await typed('attachment', 'inherit', `${token} public image`);
    const menuItems = [await typed('nav_menu_item', 'publish', `${token} menu item`)];
    const attachmentSlug = (await Post.findById(hiddenAttachments[0])).postName;
    const editorToken = jwt.sign({ userId: users.editor, username: 'editor' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    return { editorToken, token, hiddenAttachments, visibleAttachment, ledgerEntries, menuItems, attachmentSlug };
}

interface Twins { attachment: string[]; ledger: string[]; menu: string[] }

/** The assertions every engine must satisfy. `twins` are spellings the engine's collation folds onto the canonical type. */
async function assertExact(app: any, f: Fixture, twins: Twins) {
    const request = require('supertest');
    const Post = require('../models/Post');
    const ids = (res: any): number[] => (Array.isArray(res.body) ? res.body.map((p: any) => p.id) : []);
    const wrong: string[] = [];
    // A leak check reads rows, and an error has none: a twin request that did not answer 200 is a failure
    // of its own, never "nothing leaked".
    // The one answer that is not a list and still proves something: the route's documented refusal of a
    // non-canonical spelling (it lists nothing by contract, before any query); the model checks below cover
    // the SQL for those spellings.
    const answered = (label: string, res: any): boolean => {
        if (res.status === 200 && Array.isArray(res.body)) return true;
        if (res.status === 400 && res.body && res.body.code === 'rest_invalid_post_type') return false;
        const detail = res.body && (res.body.code || res.body.message || res.body.error);
        wrong.push(`${label}: answered ${res.status}${detail ? ` (${String(detail)})` : ''}, not a 200 list — an error lists nothing, so it proves nothing`);
        return false;
    };

    for (const spelling of twins.attachment) {
        const label = `editor ?type=${JSON.stringify(spelling)}`;
        const res = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${f.editorToken}`)
            .query({ type: spelling, status: 'inherit', search: f.token, per_page: 100 });
        if (answered(label, res)) {
            const leaked = ids(res).filter((id) => f.hiddenAttachments.includes(id));
            if (leaked.length) wrong.push(`${label}: hidden attachments ${leaked.join(',')} listed`);
            if (Number(res.headers['x-wp-total']) > 0) wrong.push(`${label}: X-WP-Total ${res.headers['x-wp-total']}`);
        }
        if (await Post.findBySlug(f.attachmentSlug, spelling)) wrong.push(`findBySlug(…, ${JSON.stringify(spelling)}) resolved the attachment`);
    }
    for (const spelling of twins.ledger) {
        const label = `anonymous ?type=${JSON.stringify(spelling)}`;
        const res = await request(app).get('/api/v1/posts').query({ type: spelling, search: f.token, per_page: 100 });
        if (answered(label, res)) {
            const leaked = ids(res).filter((id) => f.ledgerEntries.includes(id));
            if (leaked.length) wrong.push(`${label}: ledger entries ${leaked.join(',')} listed`);
        }
    }
    for (const spelling of twins.menu) {
        const label = `anonymous ?type=${JSON.stringify(spelling)}`;
        const res = await request(app).get('/api/v1/posts').query({ type: spelling, search: f.token, per_page: 100 });
        if (answered(label, res)) {
            const leaked = ids(res).filter((id) => f.menuItems.includes(id));
            if (leaked.length) wrong.push(`${label}: menu items ${leaked.join(',')} listed`);
        }
    }
    // THE SQL ITSELF, below the route's refusal: every twin, as the type filter of the model's list and
    // count, selects none of the seeded rows (they all carry f.token in their title).
    const seeded = [...f.hiddenAttachments, f.visibleAttachment, ...f.ledgerEntries, ...f.menuItems];
    for (const spelling of [...twins.attachment, ...twins.ledger, ...twins.menu]) {
        const rows = await Post.findAll({ type: spelling, status: null, search: f.token, limit: 1000 });
        const selected = rows.map((p: any) => p.id).filter((id: number) => seeded.includes(id));
        if (selected.length) wrong.push(`Post.findAll({ type: ${JSON.stringify(spelling)} }) selected ${selected.join(',')}`);
        const counted = await Post.count({ type: spelling, status: null, search: f.token });
        if (counted !== 0) wrong.push(`Post.count({ type: ${JSON.stringify(spelling)} }) counted ${counted}`);
    }
    assert.deepStrictEqual(wrong, []);

    // Controls: the canonical names keep working exactly as before.
    const canonical = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${f.editorToken}`)
        .query({ type: 'attachment', status: 'inherit', search: f.token, per_page: 100 });
    assert.strictEqual(canonical.status, 200);
    assert.deepStrictEqual(ids(canonical), [f.visibleAttachment], 'the canonical type lists the visible attachment only (attachment rule)');
    assert.strictEqual(canonical.headers['x-wp-total'], '1');
    const anonLedger = await request(app).get('/api/v1/posts').query({ type: LEDGER_TYPE, search: f.token });
    assert.strictEqual(anonLedger.status, 200);
    assert.deepStrictEqual(ids(anonLedger), [], 'the canonical non-public type stays clamped');
    const menu = await request(app).get('/api/v1/posts').query({ type: 'nav_menu_item' });
    assert.strictEqual(menu.status, 400, 'the canonical internal type stays refused');
    const bySlug = await Post.findBySlug(f.attachmentSlug, 'attachment');
    assert.ok(bySlug && bySlug.id === f.hiddenAttachments[0], 'findBySlug still resolves the canonical type');
}

/** The SQLite block's rows, read again by the block after it (same database file, posts_fts removed). */
let sqliteFixture: Fixture | undefined;

const SQLITE_TWINS: Twins = {
    attachment: ['ATTACHMENT', 'Attachment'],
    ledger: [LEDGER_TYPE.toUpperCase(), 'Pte_Ledger'],
    menu: ['NAV_MENU_ITEM', 'Nav_Menu_Item'],
};

describe('SQLite with a case-folding post_type column (the MySQL model)', () => {
    let app: any;
    let fixture: Fixture;

    before(async () => {
        resetSearchEngine();
        await database.init({ driver: 'sqlite-native' });
        // THE ENGINE MODEL: the core schema creates `posts` with post_type COLLATE NOCASE.
        const driver = database.getDbAsync();
        const realExec = driver.exec;
        driver.exec = function (sql: string, ...rest: any[]) {
            const folded = /CREATE TABLE IF NOT EXISTS posts \(/.test(sql)
                ? sql.replace("post_type TEXT NOT NULL DEFAULT 'post'", "post_type TEXT COLLATE NOCASE NOT NULL DEFAULT 'post'")
                : sql;
            return realExec.call(this, folded, ...rest);
        };
        try {
            await database.initializeDatabase();
        } finally {
            driver.exec = realExec;
        }
        fixture = sqliteFixture = await seed(database.getDbAsync());
        app = mountApp();
    });

    after(async () => {
        resetSearchEngine();
        try { await require('../core/cache').flush(); } catch { /* */ }
        try { await database.closeDatabase(); } catch { /* */ }
    });

    it('the model is faithful: a plain `post_type = ?` folds case on this column', async () => {
        const dbAsync = database.getDbAsync();
        const ddl = await dbAsync.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'`);
        assert.match(String(ddl.sql), /post_type TEXT COLLATE NOCASE/);
        const rows = await dbAsync.all('SELECT id FROM posts WHERE post_type = ?', ['ATTACHMENT']);
        const got = rows.map((r: any) => Number(r.id));
        for (const id of [...fixture.hiddenAttachments, fixture.visibleAttachment]) assert.ok(got.includes(id), `row ${id} matched by the folded spelling`);
    });

    it('a folded spelling selects nothing: no hidden attachment, no ledger entry, no menu item', async () => {
        await assertExact(app, fixture, SQLITE_TWINS);
        // The searches above ran on FTS5 — the engine this block hands on to the next one unless it is reset.
        assert.strictEqual(await require('../models/Post')._resolveSearchEngine(), 'fts5');
    });

    it('the harness cannot pass on errors: a twin request answered with a 500 fails the check', async () => {
        // The real routes, except that every NON-canonical spelling answers 500 — what each searched twin
        // request of an engine block answers when it inherits the previous block's full-text engine. The
        // canonical controls still pass, so only the per-twin status check can catch it.
        const express = require('express');
        const canonical = new Set(['attachment', LEDGER_TYPE, 'nav_menu_item']);
        const broken = express();
        broken.use((req: any, res: any, next: any) => {
            if (req.path === '/api/v1/posts' && !canonical.has(String(req.query.type))) {
                return res.status(500).json({ code: 'internal_error', message: 'An internal error occurred.' });
            }
            return next();
        });
        broken.use(app);
        await assert.rejects(assertExact(broken, fixture, SQLITE_TWINS), (error: any) => {
            assert.match(String(error && error.message), /answered 500 \(internal_error\), not a 200 list/);
            return true;
        });
    });

    it('the exact comparison resolves its modules once per process, not once per query (F6 budget)', async () => {
        // Post.buildWhere and Post.findBySlug run on every list, count and slug lookup. They used to
        // require() core/sql-exact-text on every call, and its dialect check required config/database on
        // every call too — each a fresh path resolution, which took buildWhere from ~1 µs to ~50 µs and
        // pushed the F6 contentQuery ratio over its budget. The attachment rule did the same: sql-exact-text
        // four times per condition, and through core/post-capabilities' capsForType about fifty resolutions
        // of post-types and content-contract per attachment list.
        const Module = require('module');
        const Post = require('../models/Post');
        const { attachmentVisibilityCondition } = require('../core/attachment-visibility');
        const exercise = async (i: number) => {
            Post.buildWhere({ type: 'post', status: 'publish' }, 'p');
            Post.buildWhere({ type: ['post', 'page'], status: 'publish' }, '');
            Post.buildWhere({ type: 'attachment', status: 'inherit', attachmentViewer: { user: null } }, 'p');
            attachmentVisibilityCondition(null, 'p.', { user: null });
            await Post.findBySlug(`pte-absent-${process.pid}-${i}`, 'page'); // a miss: the SQL path every time
        };
        await exercise(0); // the first call may load what it needs

        // Who resolved what, by the requiring module. Only the modules of the exact comparison and of the
        // attachment rule are this test's concern (core/cache, which findBySlug also passes through, keeps
        // its own lazy requires).
        const OWN = /[\\/](models[\\/]Post|core[\\/](sql-exact-text|attachment-visibility|post-capabilities))\.[jt]s$/;
        const resolved: string[] = [];
        const realRequire = Module.prototype.require;
        Module.prototype.require = function (this: any, id: string) {
            if (OWN.test(String(this && this.filename))) resolved.push(`${path.basename(this.filename)} -> ${id}`);
            return realRequire.apply(this, arguments as any);
        };
        try {
            for (let i = 1; i <= 25; i++) await exercise(i);
        } finally {
            Module.prototype.require = realRequire;
        }
        assert.deepStrictEqual([...new Set(resolved)], [], `25 rounds of the query path made ${resolved.length} module resolutions`);
    });
});

describe('the next engine block resolves its own full-text engine (SQLite without posts_fts)', () => {
    let app: any;
    let fixture: Fixture;

    before(async () => {
        resetSearchEngine();
        try { await require('../core/cache').flush(); } catch { /* */ }
        // The previous block's database, reopened (the async SQLite driver keeps the path it was built
        // with), with its rows — and without posts_fts: what the sqlite-legacy driver builds, and what MySQL
        // and PostgreSQL have. Search there must fall back to LIKE.
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        for (const trigger of ['posts_fts_ai', 'posts_fts_ad', 'posts_fts_au']) await dbAsync.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
        await dbAsync.exec('DROP TABLE IF EXISTS posts_fts');
        fixture = sqliteFixture as Fixture;
        app = mountApp();
    });

    after(async () => {
        resetSearchEngine();
        try { await require('../core/cache').flush(); } catch { /* */ }
        try { await database.closeDatabase(); } catch { /* */ }
    });

    it('searches here answer 200 on LIKE — not a posts_fts MATCH inherited from the FTS5 block', async () => {
        assert.ok(fixture, 'the SQLite block seeded the rows this block reads');
        const row = await database.getDbAsync().get(`SELECT name FROM sqlite_master WHERE name = 'posts_fts'`);
        assert.strictEqual(row, undefined, 'the model: this database has no posts_fts');
        await assertExact(app, fixture, SQLITE_TWINS);
        assert.strictEqual(await require('../models/Post')._resolveSearchEngine(), null, 'search resolved for THIS engine: LIKE');
    });
});

describe('a real MySQL server (utf8mb4_unicode_ci)', () => {
    const DBNAME = `wordjs_ptexact_${process.pid}`;
    let app: any;
    let fixture: Fixture;
    let reachable = false;

    const adminCfg = () => ({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
    });

    before(async () => {
        resetSearchEngine();
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection({ ...adminCfg(), connectTimeout: 3000 });
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.query(`CREATE DATABASE \`${DBNAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.end();
        } catch {
            return; // reachable stays false
        }
        try { await require('../core/cache').flush(); } catch { /* */ }
        config.dbDriver = 'mysql';
        config.db = { ...adminCfg(), name: DBNAME };
        await database.init({ driver: 'mysql' });
        await database.initializeDatabase();
        fixture = await seed(database.getDbAsync());
        app = mountApp();
        reachable = true;
    });

    after(async () => {
        resetSearchEngine();
        try { await database.closeDatabase(); } catch { /* */ }
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection({ ...adminCfg(), connectTimeout: 3000 });
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.end();
        } catch { /* */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('the server folds: a plain `post_type = ?` matches the case, accent and trailing-space twins', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        const dbAsync = database.getDbAsync();
        for (const twin of ['ATTACHMENT', 'attachment ', 'attachmént']) {
            const rows = await dbAsync.all('SELECT id FROM posts WHERE post_type = ?', [twin]);
            assert.ok(rows.some((r: any) => Number(r.id) === fixture.hiddenAttachments[0]), `${JSON.stringify(twin)} folds onto attachment`);
        }
    });

    it('a folded spelling selects nothing on MySQL either', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertExact(app, fixture, {
            attachment: ['ATTACHMENT', 'attachment ', 'attachmént'],
            ledger: [LEDGER_TYPE.toUpperCase(), `${LEDGER_TYPE} `],
            menu: ['NAV_MENU_ITEM', 'nav_menu_item '],
        });
        // The searches above ran on MySQL's own engine (FULLTEXT, or LIKE without the index) — never FTS5.
        assert.notStrictEqual(await require('../models/Post')._resolveSearchEngine(), 'fts5');
    });
});
