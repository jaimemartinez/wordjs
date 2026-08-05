/**
 * POST ↔ TERM ATTACHMENT SUITE (perf F5)
 *
 * setTerms/updateTermCounts had NO coverage, and F5 rewrote both: the per-term resolve/probe/insert
 * loop became two IN() queries plus one transaction, and the recount became SCOPED to the rows a
 * save actually touched instead of the whole taxonomy. Both changes can silently corrupt counts, so
 * this pins the observable contract rather than the implementation:
 *
 *   • replacing a post's terms attaches exactly the new ones and detaches the old ones;
 *   • the count of a term the post LEFT is corrected (the scoped recount's easiest thing to miss);
 *   • only PUBLISHED posts count (the pre-existing rule);
 *   • append adds without duplicating;
 *   • an empty list detaches everything;
 *   • updateMeta creates a row, then updates it in place (the UPDATE-then-INSERT path).
 *
 * Same config-repoint-first pattern as the other DB-backed suites (point config.dbPath at a temp
 * file BEFORE the DB layer resolves it).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-terms-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Post = require('../models/Post');

let dbAsync: any;

/** Create a term + its taxonomy row directly (no Term model dependency). */
async function makeTerm(name: string, taxonomy: string): Promise<{ termId: number; ttId: number }> {
    const t = await dbAsync.run('INSERT INTO terms (name, slug) VALUES (?, ?)', [name, name.toLowerCase()]);
    const termId = t.lastID;
    const tt = await dbAsync.run(
        'INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count) VALUES (?, ?, ?, 0, 0)',
        [termId, taxonomy, '']
    );
    return { termId, ttId: tt.lastID };
}

async function makePost(title: string, status = 'publish'): Promise<number> {
    const r = await dbAsync.run(
        `INSERT INTO posts (post_title, post_content, post_status, post_type, post_name, author_id)
         VALUES (?, '', ?, 'post', ?, 1)`,
        [title, status, title.toLowerCase().replace(/\s+/g, '-')]
    );
    return r.lastID;
}

const countOf = async (ttId: number): Promise<number> =>
    (await dbAsync.get('SELECT count FROM term_taxonomy WHERE term_taxonomy_id = ?', [ttId])).count;

const attachedTtIds = async (postId: number): Promise<number[]> =>
    (await dbAsync.all('SELECT term_taxonomy_id FROM term_relationships WHERE object_id = ? ORDER BY term_taxonomy_id', [postId]))
        .map((r: any) => r.term_taxonomy_id);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* */ }
    }
});

test('replacing terms attaches the new ones, detaches the old ones, and fixes BOTH counts', async () => {
    const news = await makeTerm('News', 'category');
    const guides = await makeTerm('Guides', 'category');
    const postId = await makePost('Post A');

    await Post.setTerms(postId, [news.termId], 'category');
    assert.deepStrictEqual(await attachedTtIds(postId), [news.ttId]);
    assert.strictEqual(await countOf(news.ttId), 1);

    // Replace News with Guides. The scoped recount must also correct the term the post LEFT —
    // recounting only the newly attached rows would leave News stuck at 1.
    await Post.setTerms(postId, [guides.termId], 'category');
    assert.deepStrictEqual(await attachedTtIds(postId), [guides.ttId]);
    assert.strictEqual(await countOf(guides.ttId), 1, 'the newly attached term must be counted');
    assert.strictEqual(await countOf(news.ttId), 0, 'the term the post LEFT must be recounted to 0');
});

test('only published posts count', async () => {
    const t = await makeTerm('Drafts', 'category');
    const draft = await makePost('Draft Post', 'draft');
    const live = await makePost('Live Post', 'publish');

    await Post.setTerms(draft, [t.termId], 'category');
    assert.strictEqual(await countOf(t.ttId), 0, 'a draft must not raise the count');

    await Post.setTerms(live, [t.termId], 'category');
    assert.strictEqual(await countOf(t.ttId), 1, 'only the published post counts');
});

test('append adds without duplicating an existing relationship', async () => {
    const a = await makeTerm('Alpha', 'post_tag');
    const b = await makeTerm('Beta', 'post_tag');
    const postId = await makePost('Post B');

    await Post.setTerms(postId, [a.termId], 'post_tag');
    // Appending a term it ALREADY has plus a new one must not create a duplicate row.
    await Post.setTerms(postId, [a.termId, b.termId], 'post_tag', true);

    assert.deepStrictEqual(await attachedTtIds(postId), [a.ttId, b.ttId]);
    assert.strictEqual(await countOf(a.ttId), 1);
    assert.strictEqual(await countOf(b.ttId), 1);
});

test('an empty list detaches everything and zeroes the counts', async () => {
    const t = await makeTerm('Temporary', 'category');
    const postId = await makePost('Post C');

    await Post.setTerms(postId, [t.termId], 'category');
    assert.strictEqual(await countOf(t.ttId), 1);

    await Post.setTerms(postId, [], 'category');
    assert.deepStrictEqual(await attachedTtIds(postId), []);
    assert.strictEqual(await countOf(t.ttId), 0);
});

test('terms of ANOTHER taxonomy are left alone', async () => {
    const cat = await makeTerm('Mixed', 'category');
    const tag = await makeTerm('Mixed', 'post_tag');
    const postId = await makePost('Post D');

    await Post.setTerms(postId, [cat.termId], 'category');
    await Post.setTerms(postId, [tag.termId], 'post_tag');
    // Replacing the categories must not touch the post's tags.
    await Post.setTerms(postId, [], 'category');

    assert.deepStrictEqual(await attachedTtIds(postId), [tag.ttId]);
    assert.strictEqual(await countOf(tag.ttId), 1);
});

test('updateMeta inserts once, then updates in place', async () => {
    const postId = await makePost('Post E');

    await Post.updateMeta(postId, '_probe', 'first');
    let rows = await dbAsync.all('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, '_probe']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].meta_value, 'first');

    // The UPDATE-then-INSERT-if-nothing-matched path must UPDATE here, never add a second row.
    await Post.updateMeta(postId, '_probe', 'second');
    rows = await dbAsync.all('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, '_probe']);
    assert.strictEqual(rows.length, 1, 'updating an existing key must not insert a duplicate');
    assert.strictEqual(rows[0].meta_value, 'second');
});

// ── cached COUNT(*) must never go stale for the writer ────────────────────────────────────────
// Listings cache their total (the X-WP-Total header) to avoid repeating the COUNT behind paging
// and per-keystroke search. Publishing and then looking at the list must show the NEW total — a
// plain TTL cache would show a stale number for seconds, which is why the key carries a
// generation that every post write bumps.

test('a cached post count is invalidated by the very next create', async () => {
    const before = await Post.count({ type: 'post', status: 'publish' });

    // Warm the cache, then write through the model (which bumps the generation).
    assert.strictEqual(await Post.count({ type: 'post', status: 'publish' }), before);
    await Post.create({ authorId: 1, title: 'Counted post', content: '', status: 'publish', type: 'post' });

    assert.strictEqual(
        await Post.count({ type: 'post', status: 'publish' }),
        before + 1,
        'the count must reflect a post created after it was cached'
    );
});
