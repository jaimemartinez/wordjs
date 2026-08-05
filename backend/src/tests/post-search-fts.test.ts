/**
 * FULL-TEXT SEARCH SUITE (perf F5)
 *
 * Search was `LIKE '%q%'` over post_title AND post_content — a full table scan that reads every
 * body, run twice per request (rows + COUNT). Migration 0008 builds an FTS5 index and Post's filter
 * uses it when present. That is a change to a user-visible feature, so this pins:
 *
 *   • the index actually EXISTS and the query PLAN uses it (not just "results look right");
 *   • results match what a user expects: title hits, body hits, multi-word AND, prefix/type-ahead;
 *   • a post edited or deleted after indexing is reflected (the sync triggers);
 *   • FTS5 syntax in the search box is treated as literal text, never as operators (a raw `"` or
 *     `NEAR(` used to be a 500 to the visitor);
 *   • the LIKE fallback still produces the same rows when the index is unavailable.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-fts-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Post = require('../models/Post');

let dbAsync: any;

async function seed(title: string, content: string, status = 'publish'): Promise<number> {
    const r = await dbAsync.run(
        `INSERT INTO posts (post_title, post_content, post_status, post_type, post_name, author_id)
         VALUES (?, ?, ?, 'post', ?, 1)`,
        [title, content, status, title.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
    );
    return r.lastID;
}

const titlesFor = async (search: string): Promise<string[]> => {
    const rows = await Post.findAll({ search, status: 'publish', type: 'post', limit: 50 });
    return rows.map((p: any) => p.postTitle).sort();
};

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await seed('Rendering on the server', 'React Server Components remove hydration from the page.');
    await seed('Caching strategies', 'An on-demand purge beats waiting for a TTL to expire.');
    await seed('Draft about caching', 'This one is not published.', 'draft');
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* */ }
    }
});

test('migration 0008 created the FTS index and backfilled it', async () => {
    const tbl = await dbAsync.get("SELECT name FROM sqlite_master WHERE type='table' AND name='posts_fts'");
    assert.ok(tbl, 'posts_fts must exist after the migrations run');
    const n = await dbAsync.get('SELECT COUNT(*) AS c FROM posts_fts');
    assert.ok(n.c >= 3, 'the index must contain the seeded posts');
});

test('the REAL search path takes the index branch, and its plan is not a table scan', async () => {
    // Two separate claims, both necessary. Asserting only on RESULTS would pass just as happily
    // against the old LIKE scan, and asserting only on a hand-written EXPLAIN would pass even if
    // Post never used the index. So: (1) the model reports the index as usable and builds a MATCH
    // expression, (2) the filter it produces mentions posts_fts, (3) that SQL's plan is not a scan.
    assert.strictEqual(Post._ftsAvailable(), true, 'the model must detect the FTS index on this install');
    assert.strictEqual(Post._ftsMatchQuery('caching'), '"caching"*');

    const built = Post.buildWhere({ search: 'caching', status: 'publish', type: 'post' });
    const where = built.conditions.join(' AND ');
    assert.match(where, /posts_fts MATCH/i, `the built filter must use the index — got: ${where}`);

    const plan = await dbAsync.all(`EXPLAIN QUERY PLAN SELECT p.* FROM posts p WHERE ${where}`, built.params);
    const text = plan.map((r: any) => r.detail || '').join(' | ');
    assert.match(text, /posts_fts/i, `the plan should touch posts_fts — got: ${text}`);
    assert.doesNotMatch(text, /SCAN p\b(?!.*USING)/i, `posts must not be full-scanned — got: ${text}`);
});

test('finds by title and by body, and respects the other filters', async () => {
    assert.deepStrictEqual(await titlesFor('rendering'), ['Rendering on the server']);
    // "hydration" only appears in the BODY.
    assert.deepStrictEqual(await titlesFor('hydration'), ['Rendering on the server']);
    // The draft also says "caching" but must not surface in a published-only query.
    assert.deepStrictEqual(await titlesFor('caching'), ['Caching strategies']);
});

test('multiple words are ANDed, and the last one matches as a prefix (type-ahead)', async () => {
    assert.deepStrictEqual(await titlesFor('purge demand'), ['Caching strategies']);
    assert.deepStrictEqual(await titlesFor('nothing caching'), [], 'a word that appears nowhere must exclude the row');
    // Typing "hydra" must already find "hydration" — the closest honest equivalent of substring LIKE.
    assert.deepStrictEqual(await titlesFor('hydra'), ['Rendering on the server']);
});

test('FTS5 syntax typed into the search box is literal text, never operators', async () => {
    // Each of these used to be either a SQLITE_ERROR (a 500 for the visitor) or an unintended
    // operator. They must simply return results — or nothing — without throwing.
    for (const q of ['"', 'caching"', 'NEAR(caching', 'caching OR rendering', '-caching', 'post_title:caching', '*']) {
        await assert.doesNotReject(() => titlesFor(q), `search must never throw on input: ${q}`);
    }
    // `-caching` must NOT be read as "exclude caching": the token is literal.
    assert.deepStrictEqual(await titlesFor('-caching'), ['Caching strategies']);
});

test('edits and deletes are reflected (the sync triggers)', async () => {
    const id = await seed('Ephemeral entry', 'Contains the word zeppelin.');
    assert.deepStrictEqual(await titlesFor('zeppelin'), ['Ephemeral entry']);

    await dbAsync.run('UPDATE posts SET post_content = ? WHERE id = ?', ['Now it mentions dirigible instead.', id]);
    assert.deepStrictEqual(await titlesFor('zeppelin'), [], 'the old body must stop matching after an edit');
    assert.deepStrictEqual(await titlesFor('dirigible'), ['Ephemeral entry']);

    await dbAsync.run('DELETE FROM posts WHERE id = ?', [id]);
    assert.deepStrictEqual(await titlesFor('dirigible'), [], 'a deleted post must leave the index');
});

test('the LIKE fallback returns the same rows when the index is unavailable', async () => {
    const probe = Post._ftsProbe;
    Post._ftsProbe = false; // force the fallback branch
    try {
        assert.deepStrictEqual(await titlesFor('hydration'), ['Rendering on the server']);
        assert.deepStrictEqual(await titlesFor('caching'), ['Caching strategies']);
    } finally {
        Post._ftsProbe = probe;
    }
});
