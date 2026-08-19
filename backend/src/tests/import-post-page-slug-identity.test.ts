/**
 * WordJS — a bundle holding a post AND a page with the same slug must round-trip (audit #18).
 *
 * `importSite` located existing records with `Post.findBySlug(slug)` and NO type, and `findBySlug`
 * only adds `AND post_type = ?` when it receives one (models/Post.ts). The strongest trigger needs no
 * attacker: within ONE run the posts loop executes before the pages loop, so the post it has just
 * created is visible to the pages loop's untyped lookup. A legal bundle with a post `about` and a page
 * `about` therefore OVERWROTE the post and never created the page — while reporting `pages.updated++`.
 * That is exactly the restoreBackup path (clearDatabase + importSite with updateExisting), so a backup
 * of such a site did not round-trip.
 *
 * This drives the REAL importer against a REAL SQLite database, with the real post types registered —
 * the producer, not a hand-built stand-in.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repoint the DB at a temp file BEFORE requiring the DB layer (models bind dbAsync at require time).
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-import-identity-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

describe('site import — slug + type is the identity, for lookup as well as for writing', () => {
    let importSite: any;
    let Post: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/post-types').initPostTypes();
        ({ importSite } = require('../core/import-export'));
        Post = require('../models/Post');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });

    it('creates BOTH a post and a page named "about" in a single run', async () => {
        const results = await importSite({
            content: {
                posts: [{ id: 1, slug: 'about', title: 'About the blog', content: 'post body', excerpt: '', status: 'publish' }],
                pages: [{ id: 2, slug: 'about', title: 'About us', content: 'page body', status: 'publish' }]
            }
        }, { updateExisting: true });

        assert.strictEqual(results.posts.created, 1, 'the post is created');
        assert.strictEqual(results.pages.created, 1, 'the page must be CREATED, not counted as an update of the post');
        assert.strictEqual(results.pages.updated, 0);
        assert.deepStrictEqual(results.errors, []);

        const post = await Post.findBySlug('about', 'post');
        const page = await Post.findBySlug('about', 'page');
        assert.ok(post, 'the post still exists');
        assert.ok(page, 'the page exists as its own record');
        assert.notStrictEqual(post.id, page.id, 'two records, not one overwritten twice');
        assert.strictEqual(post.postTitle, 'About the blog', 'the post was not clobbered by the page');
        assert.strictEqual(page.postTitle, 'About us');
    });

    it('re-importing the same bundle updates each record in its own type', async () => {
        const results = await importSite({
            content: {
                posts: [{ id: 1, slug: 'about', title: 'About the blog v2', content: 'post body 2', excerpt: '', status: 'publish' }],
                pages: [{ id: 2, slug: 'about', title: 'About us v2', content: 'page body 2', status: 'publish' }]
            }
        }, { updateExisting: true });

        assert.strictEqual(results.posts.updated, 1);
        assert.strictEqual(results.pages.updated, 1);
        assert.strictEqual(results.posts.created, 0);
        assert.strictEqual(results.pages.created, 0);
        assert.deepStrictEqual(results.errors, []);

        assert.strictEqual((await Post.findBySlug('about', 'post')).postTitle, 'About the blog v2');
        assert.strictEqual((await Post.findBySlug('about', 'page')).postTitle, 'About us v2');
    });
});
