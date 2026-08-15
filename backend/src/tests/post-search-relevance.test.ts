/**
 * FULL-TEXT SEARCH — CROSS-ENGINE RELEVANCE CONFORMANCE (FRENTE D)
 *
 * Migration 0008 gave SQLite an FTS5 index; 0010 adds a Postgres tsvector column (GIN + ts_rank) and a
 * MySQL InnoDB FULLTEXT index (MATCH…AGAINST). Post's search path (models/Post.ts) queries whichever
 * exists, most-relevant document first, behind ONE engine-agnostic interface (`Post._searchClauses` +
 * findAll ordering). This suite pins the contract on every reachable engine:
 *
 *   1. a multi-term query returns the MORE-RELEVANT document ahead of the less-relevant one — and the
 *      less-relevant one is deliberately NEWER, so a plain date sort would put it first; only real
 *      relevance ordering passes. (Reverting the relevance ORDER BY in findAll turns this RED — the
 *      mutation proof, verified on SQLite locally.)
 *   2. FTS special characters typed into the search box can neither break the SQL (parse error / 500)
 *      nor act as operators — every engine treats the box as literal text.
 *
 * SQLite runs end-to-end through the real Post model locally. Postgres and MySQL execute the REAL
 * clause SQL (Post._searchClauses) against a real engine and are CI-gated (WORDJS_CI_DB=1): a wired
 * service container that never came up FAILS the job rather than skipping green. See ci.yml.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-relv-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Post = require('../models/Post');

// A term that appears MANY times in one doc and ONCE in another, so the tf-driven relevance score of
// every engine ranks them the same way. The low-relevance doc is dated in the FUTURE so a naive date
// sort would surface it first — only true relevance ordering puts HIGH ahead of LOW.
const HIGH_TITLE = 'Server rendering guide';
const LOW_TITLE = 'Weekly notes';
const HIGH_CONTENT = 'Server rendering explained: server-side rendering. Rendering on the server, then more server rendering.';
const LOW_CONTENT = 'A brief mention of server rendering, exactly once, buried in an unrelated weekly update.';
// Filler rows that contain NEITHER term give the IDF weighting a sane corpus (and keep InnoDB FULLTEXT
// from treating a term present in most rows as noise).
const FILLERS = [
    ['Cooking pasta', 'Boil water, add salt, drop the pasta, drain after eleven minutes.'],
    ['Gardening tips', 'Prune roses in early spring and mulch the beds before the first frost.'],
    ['Travel journal', 'The train wound through alpine valleys and stopped at a lakeside town.'],
];
const NASTY = ['"', 'server"', 'NEAR(server', 'server OR rendering', '-server', 'post_title:server', '*', "server' OR '1'='1"];

// ── Part A: SQLite, end-to-end through the real Post model (local, mutation-provable). ──────────────
let dbAsync: any;

async function seed(title: string, content: string, postDate: string, status = 'publish'): Promise<number> {
    const r = await dbAsync.run(
        `INSERT INTO posts (post_title, post_content, post_excerpt, post_status, post_type, post_name, post_date, author_id)
         VALUES (?, ?, '', ?, 'post', ?, ?, 1)`,
        [title, content, status, title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), postDate]
    );
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    // Insert the low-relevance doc with the NEWER date so a date sort would rank it first.
    await seed(HIGH_TITLE, HIGH_CONTENT, '2000-01-01 00:00:00');
    await seed(LOW_TITLE, LOW_CONTENT, '2099-01-01 00:00:00');
    for (const [t, c] of FILLERS) await seed(t, c, '2010-01-01 00:00:00');
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* */ }
    }
});

test('sqlite: the resolved engine is fts5', async () => {
    assert.strictEqual(await Post._resolveSearchEngine(), 'fts5');
});

test('sqlite: a multi-term search returns the MORE-relevant doc first (not the newer one)', async () => {
    const rows = await Post.findAll({ search: 'server rendering', status: 'publish', type: 'post', limit: 50 });
    const titles = rows.map((p: any) => p.postTitle);
    assert.deepStrictEqual(
        titles,
        [HIGH_TITLE, LOW_TITLE],
        `relevance must rank the term-dense doc first even though it is OLDER — got: ${JSON.stringify(titles)}`
    );
    // Guard the mutation proof: LOW really is newer, so a date sort WOULD invert this.
    assert.ok(rows[0].postDate < rows[1].postDate, 'the relevant doc must be the older one, else the test proves nothing');
});

test('sqlite: FTS5 syntax in the box is literal text and never breaks the query', async () => {
    for (const q of NASTY) {
        await assert.doesNotReject(
            () => Post.findAll({ search: q, status: 'publish', type: 'post', limit: 50 }),
            `search must never throw on input: ${q}`
        );
    }
});

// ── Part B: Postgres + MySQL, the REAL clause SQL against a real engine (CI-gated). ─────────────────
const withTimeout = (p: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

const T = 'search_relv_conf'; // dedicated table — never touch the app's real `posts` on a shared CI DB

// Build the runnable search SQL from the REAL clause generator, so this test exercises the actual code
// path, falling back to LIKE exactly where the model would (null clauses → too-short/empty query).
function buildSearchSql(engine: string, query: string) {
    const c = Post._searchClauses(engine, query, 'p.');
    if (c) {
        return {
            sql: `SELECT p.id, p.post_title FROM ${T} p WHERE ${c.filterSql} ORDER BY ${c.orderSql}, p.post_date DESC LIMIT 50`,
            params: [...c.filterParams, ...c.orderParams],
        };
    }
    const like = `%${query}%`;
    return {
        sql: `SELECT p.id, p.post_title FROM ${T} p WHERE (p.post_title LIKE ? OR p.post_content LIKE ?) LIMIT 50`,
        params: [like, like],
    };
}

async function runEngineRelevance(t: any, driver: any, engine: string, setupFts: (d: any) => Promise<void>) {
    try {
        await driver.exec(`DROP TABLE IF EXISTS ${T}`);
        // SQLite-dialect CREATE TABLE — both the Postgres and MySQL drivers TRANSLATE it at their exec
        // boundary (SERIAL / AUTO_INCREMENT, TEXT→LONGTEXT for the body columns), so we feed one form.
        await driver.exec(
            `CREATE TABLE ${T} (` +
            `id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
            `post_title TEXT NOT NULL DEFAULT '', ` +
            `post_content TEXT NOT NULL DEFAULT '', ` +
            `post_excerpt TEXT NOT NULL DEFAULT '', ` +
            `post_date TEXT NOT NULL DEFAULT '')`
        );
        await setupFts(driver);

        const ins = async (title: string, content: string, date: string) =>
            driver.run(`INSERT INTO ${T} (post_title, post_content, post_excerpt, post_date) VALUES (?, ?, '', ?)`, [title, content, date]);
        await ins(HIGH_TITLE, HIGH_CONTENT, '2000-01-01 00:00:00'); // relevant, OLD
        await ins(LOW_TITLE, LOW_CONTENT, '2099-01-01 00:00:00');   // barely relevant, NEW
        for (const [ti, co] of FILLERS) await ins(ti, co, '2010-01-01 00:00:00');

        // 1) Relevance: the term-dense doc comes first even though it is the OLDER row.
        const { sql, params } = buildSearchSql(engine, 'server rendering');
        const rows = await driver.all(sql, params);
        assert.ok(rows.length >= 2, `${engine}: a multi-term search must return both matching docs, got ${rows.length}`);
        assert.strictEqual(
            rows[0].post_title, HIGH_TITLE,
            `${engine}: the more-relevant (older) doc must rank first — got ${JSON.stringify(rows.map((r: any) => r.post_title))}`
        );

        // 2) Injection / parse safety: no special-character query may throw or act as an operator.
        for (const q of NASTY) {
            const built = buildSearchSql(engine, q);
            await assert.doesNotReject(() => driver.all(built.sql, built.params), `${engine}: search must never throw on input: ${q}`);
        }
    } finally {
        try { await driver.exec(`DROP TABLE IF EXISTS ${T}`); } catch { /* */ }
        try { await driver.close(); } catch { /* */ }
    }
}

test('postgres: tsvector/ts_rank ranks the more-relevant doc first (skipped if no PG reachable)', async (t: any) => {
    let driver: any;
    try {
        driver = require('../drivers/postgres');
    } catch (e: any) {
        return skipOrFail(t, `pg driver not loadable: ${e && e.message}`);
    }
    try {
        await withTimeout(driver.connect(), 3000);
    } catch (e: any) {
        return skipOrFail(t, `no reachable Postgres: ${e && e.message}`);
    }
    await runEngineRelevance(t, driver, 'pg', async (d: any) => {
        // Mirror migration 0010: a STORED generated tsvector + GIN index. ADD COLUMN / CREATE INDEX pass
        // through the driver untranslated (only CREATE TABLE is rewritten).
        await d.exec(
            `ALTER TABLE ${T} ADD COLUMN search_vector tsvector ` +
            `GENERATED ALWAYS AS (to_tsvector('english', ` +
            `coalesce(post_title,'') || ' ' || coalesce(post_content,'') || ' ' || coalesce(post_excerpt,''))) STORED`
        );
        await d.exec(`CREATE INDEX idx_${T}_sv ON ${T} USING GIN (search_vector)`);
    });
});

test('mysql: FULLTEXT MATCH…AGAINST ranks the more-relevant doc first (skipped if no MySQL reachable)', async (t: any) => {
    let driver: any;
    try {
        driver = require('../drivers/mysql');
    } catch (e: any) {
        return skipOrFail(t, `mysql2 driver not loadable: ${e && e.message}`);
    }
    driver.config = {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
    try {
        await withTimeout(driver.connect(), 5000);
    } catch (e: any) {
        return skipOrFail(t, `no reachable MySQL: ${e && e.message}`);
    }
    await runEngineRelevance(t, driver, 'mysql', async (d: any) => {
        // Mirror migration 0010: an InnoDB FULLTEXT index over the three body columns.
        await d.exec(`ALTER TABLE ${T} ADD FULLTEXT INDEX ft_${T} (post_title, post_content, post_excerpt)`);
    });
});
