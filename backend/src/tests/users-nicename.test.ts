/**
 * THE PUBLIC AUTHOR SLUG — `users.user_nicename`, written at last.
 *
 * The column has existed since the base schema as `NOT NULL DEFAULT ''` and NOTHING ever wrote it.
 * Every public author surface therefore fell back to `user_login`: the byline a post serialises
 * (`Post.getAuthorsForIds`), the `/author/<slug>` link the feed publishes, the value a page hands
 * back to `GET /posts?author=`. `GET /posts` is anonymous, so a default install published the exact
 * string its login form takes, for every account that had ever posted — an unauthenticated username
 * enumerator dressed as a byline.
 *
 * Three things had to become true, and all three are exercised against the REAL producers here:
 *
 *   1. `User.create` derives the column from the DISPLAY NAME (every account-creating path in the
 *      product goes through it — the REST route, self-registration, the WXR importer, the JSON
 *      importer, the boot seed and the installer), de-duplicated with -2/-3.
 *   2. Schema migration 0015 does the same for accounts that predate it, deterministically and
 *      without ever rewriting a nicename somebody already has.
 *   3. `Post.getAuthorsForIds` reads that column and, where it is empty, falls back to the user ID —
 *      an identity `?author=` and `/author/<id>` already resolve. NEVER to the login.
 *
 * Same config-repoint-first ordering as the other model suites: CWD and `config.dbPath` are pointed
 * at temp locations BEFORE the DB layer loads.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-nicename-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer loads.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const User = require('../models/User');
const Post = require('../models/Post');
const { MIGRATIONS } = require('../core/schema-migrations');

const PASSWORD = 'S3cret-passphrase!';

let dbAsync: any;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    // User.create validates the role against the seeded roles map; without this every create throws
    // 'Invalid role: subscriber' and the suite would fail for a reason that has nothing to do with slugs.
    await require('../core/roles').loadRoles();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

/** The stored column, read raw — never through a model that could be doing the deriving itself. */
const nicenameOf = async (id: number): Promise<string> => {
    const row = await dbAsync.get('SELECT user_nicename FROM users WHERE id = ?', [id]);
    return row.user_nicename == null ? '' : String(row.user_nicename);
};

/**
 * A published post by `authorId`, inserted raw. The thing under test is the author FILTER
 * (Post.identityFilter -> Post._authorCondition), so the row it selects must not come from a producer
 * that could be applying the same rule twice.
 */
const seedPost = async (authorId: number, title: string): Promise<number> => {
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name)
         VALUES (?, ?, 'publish', 'post', ?)`,
        [authorId, title, title.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
    );
    return r.lastID;
};

/** A row exactly as it looks BEFORE any of this existed: a display name and an empty nicename. */
const seedLegacyUser = async (login: string, displayName: string, nicename = ''): Promise<number> => {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename)
         VALUES (?, 'x', ?, ?, ?)`,
        [login, `${login}@legacy.example`, displayName, nicename],
    );
    return r.lastID;
};

describe('User.create writes the public author slug', () => {
    it('derives it from the DISPLAY NAME — and the byline carries it, never the login', async () => {
        const created = await User.create({
            username: 'ada.lovelace.1815',
            email: 'ada@example.com',
            password: PASSWORD,
            displayName: 'Ada Lovelace',
        });

        assert.strictEqual(await nicenameOf(created.id), 'ada-lovelace',
            'the column must be written at creation — an empty one is what forced the login fallback');

        // The PUBLIC contract, from the real serialiser: this is what every byline, feed and JSON-LD
        // fragment ends up carrying.
        const byId = await Post.getAuthorsForIds([created.id]);
        assert.deepStrictEqual(byId[created.id], {
            id: created.id, displayName: 'Ada Lovelace', slug: 'ada-lovelace',
        });
        assert.ok(!JSON.stringify(byId).includes('ada.lovelace.1815'),
            'the login must not appear anywhere in the public author identity');
    });

    it('de-duplicates a repeated display name with -2, -3 — two people, two archive URLs', async () => {
        const first = await User.create({
            username: 'ghopper', email: 'gh1@example.com', password: PASSWORD, displayName: 'Grace Hopper',
        });
        const second = await User.create({
            username: 'grace.h', email: 'gh2@example.com', password: PASSWORD, displayName: 'Grace Hopper',
        });
        const third = await User.create({
            username: 'g.hopper', email: 'gh3@example.com', password: PASSWORD, displayName: 'Grace Hopper',
        });

        assert.strictEqual(await nicenameOf(first.id), 'grace-hopper');
        assert.strictEqual(await nicenameOf(second.id), 'grace-hopper-2');
        assert.strictEqual(await nicenameOf(third.id), 'grace-hopper-3');

        // Distinct slugs are the point: one shared slug would make two authors' archives the same URL.
        const authors = await Post.getAuthorsForIds([first.id, second.id, third.id]);
        const slugs = [authors[first.id].slug, authors[second.id].slug, authors[third.id].slug];
        assert.strictEqual(new Set(slugs).size, 3, `two accounts share an author slug: ${slugs.join(', ')}`);
    });

    it('an EXPLICIT nicename wins over the derived one', async () => {
        // The escape hatch a caller that already holds a public slug needs — an importer carrying the
        // source site's own author slug, or an admin form that offers the field.
        const created = await User.create({
            username: 'kj', email: 'kj@example.com', password: PASSWORD,
            displayName: 'Katherine Johnson', nicename: 'the-human-computer',
        });
        assert.strictEqual(await nicenameOf(created.id), 'the-human-computer');
    });

    it('a display name that slugifies to nothing leaves it EMPTY, and the byline falls back to the id', async () => {
        // Inventing a slug here would be worse than emitting none: the id is an identity `?author=`
        // and `/author/<id>` already resolve, so the author stays addressable either way.
        const created = await User.create({
            username: 'nihongo', email: 'nihongo@example.com', password: PASSWORD, displayName: '日本語',
        });
        assert.strictEqual(await nicenameOf(created.id), '');

        const byId = await Post.getAuthorsForIds([created.id]);
        assert.strictEqual(byId[created.id].slug, String(created.id),
            'an empty column must fall back to the id — never to user_login');
        assert.ok(!JSON.stringify(byId).includes('nihongo'));
    });

    it('a display name that slugifies to ALL DIGITS is never stored in ID shape', async () => {
        // A magazine called "2024", an author called "007", a band called "1984". Author identity is
        // split by SHAPE at every consumer — Post.identityFilter/_authorCondition, parseIdentityList in
        // routes/posts.ts, the /author/<segment>/feed.xml handler, the frontend author page — and in
        // all of them all-digits means "a users.id". Storing '2024' in this column would therefore
        // publish a byline that resolves to user id 2024: a 404 if no such account exists, and ANOTHER
        // account's archive if one does. Nothing else in the grammar constrains it; the writer must.
        const created = await User.create({
            username: 'magazine.2024', email: 'mag2024@example.com', password: PASSWORD,
            displayName: '2024',
        });
        const slug = await nicenameOf(created.id);
        assert.ok(!/^[0-9]+$/.test(slug), `an all-digit nicename is a user id to every reader: ${slug}`);
        assert.strictEqual(slug, 'user-2024', 'the rule is a `user-` prefix — migration 0015 duplicates it');

        // Leading zeros are the same hazard in a different mask: the frontend's own id pattern rejects
        // '007', so it would travel as a slug while the backend's /^[0-9]+$/ reads it as id 7.
        const padded = await User.create({
            username: 'agent.007', email: '007@example.com', password: PASSWORD, displayName: '007',
        });
        assert.strictEqual(await nicenameOf(padded.id), 'user-007');

        // It is the value the byline publishes…
        const byId = await Post.getAuthorsForIds([created.id]);
        assert.strictEqual(byId[created.id].slug, 'user-2024');

        // …and BOTH identities resolve through the real split-by-shape filter: the slug the byline
        // carries, and the id every author is addressable by regardless.
        const postId = await seedPost(created.id, 'Issue One');
        assert.deepStrictEqual((await Post.findAll({ author: 'user-2024' })).map((p: any) => p.id), [postId],
            '?author=<nicename> must reach the author whose slug it is');
        assert.deepStrictEqual((await Post.findAll({ author: String(created.id) })).map((p: any) => p.id), [postId],
            '?author=<id> must keep working — the guard changes the slug, never the id identity');

        // And the shape the guard exists to prevent finds nothing, which is exactly what an unguarded
        // '2024' nicename would have done to this author's own archive.
        assert.deepStrictEqual((await Post.findAll({ author: '2024' })).map((p: any) => p.id), [],
            "'2024' is read as a user id, so it must not be a slug any account can be given");
    });

    it('an account created with NO display name still gets a slug of its own', async () => {
        // display_name defaults to the login (WordPress parity), so this account's slug IS the
        // slugified login — but as a real, separate, editable column rather than an invisible
        // fallback, which is what lets an admin change it without renaming the account.
        const created = await User.create({
            username: 'plainuser', email: 'plain@example.com', password: PASSWORD,
        });
        assert.strictEqual(await nicenameOf(created.id), 'plainuser');
        const row = await dbAsync.get('SELECT display_name FROM users WHERE id = ?', [created.id]);
        assert.strictEqual(row.display_name, 'plainuser',
            'the slug and the display name must be derived from the same value, or the two disagree');
    });
});

describe('migration 0015 backfills the accounts that predate the column', () => {
    /** The runner's ctx, over the same driver — so the migration body under test is the real one. */
    const migrationCtx = () => ({
        exec: (sql: string) => dbAsync.exec(sql),
        run: (sql: string, params: any[] = []) => dbAsync.run(sql, params),
        get: (sql: string, params: any[] = []) => dbAsync.get(sql, params),
        all: (sql: string, params: any[] = []) => dbAsync.all(sql, params),
        isPostgres: false,
        driverName: 'sqlite-native',
    });

    const migration = () => {
        const found = MIGRATIONS.find((m: any) => m.id === '0015_backfill_user_nicename');
        assert.ok(found, '0015_backfill_user_nicename must be registered in MIGRATIONS');
        return found;
    };

    let legacyA: number, legacyB: number, chosen: number, colliding: number, unnameable: number;

    it('fills every empty nicename, in id order, without colliding with one that already exists', async () => {
        // Two accounts that slugify to the SAME value: the lower id takes the bare slug.
        legacyA = await seedLegacyUser('legacy.one', 'Marie Curie');
        legacyB = await seedLegacyUser('legacy.two', 'Marie Curie');
        // An account that ALREADY has a slug, plus one whose display name derives that same slug —
        // the backfill must work around the existing value, never rewrite it.
        chosen = await seedLegacyUser('legacy.three', 'Rosalind Franklin', 'rosalind-franklin');
        colliding = await seedLegacyUser('legacy.four', 'Rosalind Franklin');
        // And one that slugifies to nothing at all.
        unnameable = await seedLegacyUser('legacy.five', '中文名');

        await migration().up(migrationCtx());

        assert.strictEqual(await nicenameOf(legacyA), 'marie-curie');
        assert.strictEqual(await nicenameOf(legacyB), 'marie-curie-2', 'the second one is disambiguated');
        assert.strictEqual(await nicenameOf(chosen), 'rosalind-franklin', 'an existing slug is never rewritten');
        assert.strictEqual(await nicenameOf(colliding), 'rosalind-franklin-2',
            'the taken-set must be seeded from the nicenames already in the table');
        assert.strictEqual(await nicenameOf(unnameable), '', 'nothing to slugify → nothing written');

        // The whole point of the migration: the byline of an upgraded install stops being the login.
        const byId = await Post.getAuthorsForIds([legacyA, legacyB, colliding, unnameable]);
        assert.strictEqual(byId[legacyA].slug, 'marie-curie');
        assert.strictEqual(byId[unnameable].slug, String(unnameable), 'the id fallback covers the rest');
        assert.ok(!JSON.stringify(byId).includes('legacy.'),
            'no login may reach the public author identity of a backfilled account');
    });

    it('is re-runnable: a second pass renames nobody', async () => {
        // A restored backup, or a re-recorded migration, must not hand every author a new archive URL.
        const before = await dbAsync.all('SELECT id, user_nicename FROM users ORDER BY id');
        await migration().up(migrationCtx());
        const after = await dbAsync.all('SELECT id, user_nicename FROM users ORDER BY id');
        assert.deepStrictEqual(after, before, 'a second run must be a no-op');
    });

    it('never aborts a boot: a failing backfill is swallowed, because a slug is not integrity', async () => {
        // The runner is fail-closed by design — it throws and stops the boot on any migration error.
        // An author slug is a display identity with a working fallback, so this one must not use that
        // budget: a DB hiccup here cannot be the reason an install refuses to start.
        const broken = {
            ...migrationCtx(),
            all: async () => { throw new Error('simulated driver failure'); },
        };
        await migration().up(broken); // must resolve, not reject
    });

    it('applies the all-digit guard TOO — and derives the same seed the model does', async () => {
        // The migration and User.generateUniqueNicename are deliberately independent writers (a model
        // required from a migration would re-enter config/database mid-initialisation), so the rule
        // lives in two places and this is what keeps them honest: the same display name must produce
        // the same slug whether the account predates the column or is created after it.
        const legacyNumeric = await seedLegacyUser('legacy.1984', '1984');
        await migration().up(migrationCtx());
        const backfilled = await nicenameOf(legacyNumeric);
        assert.ok(!/^[0-9]+$/.test(backfilled),
            `the backfill wrote a nicename every reader parses as a user id: ${backfilled}`);
        assert.strictEqual(backfilled, 'user-1984');

        // Same display name, the other writer. The value itself is taken now, so what is being pinned
        // is the SEED it disambiguates from: a model that had kept the bare '1984' base would answer
        // '1984' here, not 'user-1984-2'.
        const created = await User.create({
            username: 'orwell', email: 'orwell@example.com', password: PASSWORD, displayName: '1984',
        });
        assert.strictEqual(await nicenameOf(created.id), 'user-1984-2',
            'the two writers must disambiguate from the same seed, or an upgrade and a signup disagree');
    });
});
