/**
 * Model behaviour that must not depend on the database engine (QA of the three deploy modes), held on
 * SQLite here — the Postgres/MySQL halves live in db-engine-resilience.test.ts:
 *   · a post over 64 K characters is created, revised and edited again (it used to become uneditable);
 *   · concurrent posts with one title get distinct slugs;
 *   · a search for `%` or `_` finds only those characters, a user search ignores case;
 *   · terms: the same name under another parent, or with its own slug (a WordPress import), is a
 *     second term; the same name under the same parent is a duplicate.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-db-parity-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Post = require('../models/Post');
const Term = require('../models/Term');
const User = require('../models/User');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

test('a post over 64 K characters is created, revised and edited again', async () => {
    const revisions = require('../core/revisions');
    const big = '<p>' + 'w'.repeat(120_000) + '</p>';
    const post = await Post.create({ title: 'Long read', content: big, status: 'draft', authorId: 1 });
    // What PUT /posts/:id does before every write: snapshot the CURRENT version.
    await revisions.saveRevision(post.id);
    await Post.update(post.id, { title: 'Long read, edited' });
    await revisions.saveRevision(post.id);
    const back = await Post.findById(post.id);
    assert.strictEqual(back.postTitle || back.title, 'Long read, edited');
    assert.ok(String(back.postContent ?? back.content).length > 120_000);
    assert.ok((await revisions.countRevisions(post.id)) >= 2);
});

test('posts created at once with one title get distinct slugs', async () => {
    const made = await Promise.all(Array.from({ length: 8 }, () => Post.create({ title: 'Same title race', status: 'draft', authorId: 1 })));
    const slugs = made.map((p: any) => p.postName ?? p.slug);
    assert.strictEqual(new Set(slugs).size, 8, `distinct slugs: ${slugs.join(', ')}`);
});

test('search: % and _ are literal, never "everything"', async () => {
    await Post.create({ title: 'Discount 100% off', status: 'publish', authorId: 1 });
    const all = await Post.findAll({ search: '%', status: 'any', limit: 100 });
    const titles = (all.posts || all).map((p: any) => p.postTitle ?? p.title);
    assert.ok(titles.every((t: string) => t.includes('%')), `only titles with a literal %: ${titles.join(' | ')}`);
    const under = await Post.findAll({ search: '_', status: 'any', limit: 100 });
    assert.strictEqual((under.posts || under).length, 0);
});

test('user search ignores case', async () => {
    await User.create({ username: 'jose_parity', email: 'jose.parity@example.com', password: 'Correct-Horse-9!', displayName: 'José Parity' });
    const found = await User.findAll({ search: 'JOSE_PAR' });
    const list = found.users || found;
    assert.ok(list.some((u: any) => (u.userLogin ?? u.username ?? u.user_login) === 'jose_parity'));
});

test('terms: same name under another parent, or with its own slug, is a second term; same parent is a duplicate', async () => {
    const parentA = await Term.create({ name: 'Parity Parent', taxonomy: 'category' });
    const pid = parentA.termId ?? parentA.term_id ?? parentA.id;
    await Term.create({ name: 'Parity Child', taxonomy: 'category' });
    const nested = await Term.create({ name: 'Parity Child', taxonomy: 'category', parent: pid });
    assert.ok(nested, 'the same name under another parent is allowed (WordPress does)');
    await assert.rejects(Term.create({ name: 'Parity Child', taxonomy: 'category', parent: pid }), /already exists/);
    await Term.create({ name: 'Parity Tag', taxonomy: 'post_tag' });
    await assert.rejects(Term.create({ name: 'Parity Tag', taxonomy: 'post_tag' }), /already exists/);
    const imported = await Term.create({ name: 'Parity Tag', taxonomy: 'post_tag', slug: 'parity-tag-2-from-wp' });
    assert.ok(imported, 'an importer naming its own slug keeps the source term');
    // Case and accents are distinct names on every engine (MySQL compares them exactly now).
    assert.ok(await Term.create({ name: 'parity tag', taxonomy: 'post_tag' }));
});

test('order by title ignores case and accents (M3-12 / S3-14), as MySQL does', async () => {
    for (const t of ['Zebra QA', 'apple QA', 'Árbol QA', 'banana QA', 'Éclair QA']) {
        await Post.create({ title: t, status: 'publish', authorId: 1 });
    }
    const res = await Post.findAll({ search: undefined, status: 'publish', orderBy: 'post_title', order: 'ASC', limit: 200 });
    const titles = (res.posts || res).map((p: any) => p.postTitle ?? p.title).filter((t: string) => / QA$/.test(t));
    assert.deepStrictEqual(titles, ['apple QA', 'Árbol QA', 'banana QA', 'Éclair QA', 'Zebra QA']);
});

test('terms: the slug is unique in the database, and a same-name race ends with one tag (S3-12)', async () => {
    const db = database.getDbAsync();
    const idx = await db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_terms_slug'");
    assert.ok(idx, 'migration 0023 created the unique index');
    await assert.rejects(
        (async () => { await db.run("INSERT INTO terms (name, slug, term_group) VALUES ('A', 'race-slug', 0)"); await db.run("INSERT INTO terms (name, slug, term_group) VALUES ('B', 'race-slug', 0)"); })(),
        (e: any) => require('../core/db-errors').isUniqueViolation(e)
    );
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => Term.create({ name: 'Race tag QA', taxonomy: 'post_tag' })));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r: any) => /already exists/.test(r.reason.message)));
});

test('revisions: rows committed by parallel saves are pruned once this save commits (S3-16)', async () => {
    const revisions = require('../core/revisions');
    const post = await Post.create({ title: 'Busy post', content: '<p>v0</p>', status: 'draft', authorId: 1 });
    for (let i = 0; i < 10; i++) await revisions.saveRevision(post.id);
    assert.strictEqual(Number(await revisions.countRevisions(post.id)), 10);
    await database.dbAsync.transaction(async (q: any) => {
        await revisions.saveRevision(post.id);
        // What the other transactions add: rows this save's own prune did not count. On Postgres and
        // MySQL they commit beside this one; here they are written after the in-transaction prune.
        for (let i = 0; i < 3; i++) {
            await q.run(
                "INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_parent, guid) VALUES (1, 'r', '', '', 'inherit', ?, 'revision', ?, '')",
                [`${post.id}-revision-parallel-${i}`, post.id]
            );
        }
    });
    assert.strictEqual(Number(await revisions.countRevisions(post.id)), 10, 'the post ends at the cap');
});
