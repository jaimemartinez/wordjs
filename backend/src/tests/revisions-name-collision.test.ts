/**
 * WordJS — revision naming collisions (regression suite for F7/H3).
 *
 * core/revisions.saveRevision() named every revision `${postId}-revision-v${Date.now()}` while the
 * schema carries `CREATE UNIQUE INDEX idx_posts_name_type ON posts (post_name, post_type)
 * WHERE post_name <> ''` (config/database.ts). Two revisions of the SAME post inside one millisecond
 * therefore violated the index — and saveRevision takes ~5 ms, so the window is narrow but real (the
 * F7 drill hit it spontaneously twice while it was being written). The damage was silent, twice over:
 *
 *   - routes/posts.ts calls saveRevision fire-and-forget, so the snapshot was simply LOST: that edit
 *     had no recovery point and nobody was told.
 *   - core/revisions.restoreRevision() calls it OUTSIDE its try, so the throw escaped and the route
 *     answered 500 having restored NOTHING — the author lost the new content and the old one.
 *
 * Both halves are locked here: the cause (unique-by-construction name, verified with Date.now frozen,
 * which is the worst case a real clock can produce) and F3's fail-closed symptom (a restore whose
 * required safety snapshot fails leaves the edited post and its prior revision untouched).
 *
 * IMPORTANT: `config.dbPath` is repointed to a temp file BEFORE requiring `../config/database`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-revisions-collision-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer (and, later, the models / revisions core).
const database = require('../config/database');

const FROZEN_MS = 1_767_000_000_000; // a fixed "same millisecond" for every call under test

describe('post revisions — two snapshots in the same millisecond (H3)', () => {
    let dbAsync: any;
    let Post: any;
    let saveRevision: any, restoreRevision: any, countRevisions: any, getRevisions: any;
    let adminId: number;
    const realNow = Date.now;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@test.local', 'Administrator']
        );
        adminId = (await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`)).id;

        Post = require('../models/Post');
        ({ saveRevision, restoreRevision, countRevisions, getRevisions } = require('../core/revisions'));
    });

    after(async () => {
        Date.now = realNow;
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });

    const newPost = async (slug: string, content = '<p>v1</p>') => await Post.create({
        authorId: adminId, title: `T ${slug}`, content, status: 'publish', type: 'post', slug
    });

    it('two saveRevision calls in the same millisecond both persist', async () => {
        const post = await newPost('colision-doble');
        Date.now = () => FROZEN_MS;
        try {
            const a = await saveRevision(post.id);
            const b = await saveRevision(post.id);
            assert.ok(a, 'first revision must be created');
            assert.ok(b, 'second revision in the same ms used to throw SQLITE_CONSTRAINT_UNIQUE');
            assert.notStrictEqual(a, b);
        } finally {
            Date.now = realNow;
        }
        assert.strictEqual(await countRevisions(post.id), 2);

        const names = (await dbAsync.all(
            `SELECT post_name FROM posts WHERE post_parent = ? AND post_type = 'revision'`, [post.id]
        )).map((r: any) => r.post_name);
        assert.strictEqual(new Set(names).size, 2, 'revision post_name must be unique by construction');
        for (const n of names) assert.match(n, /^\d+-revision-v\d+-/, 'keep the greppable postId-revision-v prefix');
    });

    it('a burst of snapshots in one millisecond neither collides nor breaks the 10-revision cap', async () => {
        const post = await newPost('colision-rafaga');
        Date.now = () => FROZEN_MS;
        try {
            for (let i = 0; i < 20; i++) {
                assert.ok(await saveRevision(post.id), `snapshot #${i + 1} must not collide`);
            }
        } finally {
            Date.now = realNow;
        }
        assert.strictEqual(await countRevisions(post.id), 10, 'limitRevisions still prunes to the cap');
    });

    it('restoreRevision works while the clock is frozen (it snapshots before restoring)', async () => {
        const post = await newPost('restaurar-mismo-ms', '<p>original</p>');
        await Post.updateMeta(post.id, '_puck_data', { root: { props: {} }, content: [], zones: {} });

        Date.now = () => FROZEN_MS;
        let ok: boolean;
        let revisionId: number;
        try {
            revisionId = await saveRevision(post.id);
            await Post.update(post.id, { content: '<p>editado</p>' });
            await saveRevision(post.id);
            // The pre-restore snapshot lands in the very same millisecond as the two above.
            ok = await restoreRevision(revisionId);
        } finally {
            Date.now = realNow;
        }

        assert.strictEqual(ok, true, 'the restore used to 500 without restoring anything');
        const fresh = await dbAsync.get('SELECT post_content FROM posts WHERE id = ?', [post.id]);
        assert.match(fresh.post_content, /original/, 'the revision content must actually be restored');
        assert.strictEqual(await countRevisions(post.id), 3, 'the pre-restore snapshot must have persisted');
    });

    it('a restore rolls back when its pre-restore safety snapshot fails', async () => {
        const post = await newPost('restaurar-pese-a-fallo', '<p>original</p>');
        const revisionId = await saveRevision(post.id);
        await Post.update(post.id, { content: '<p>editado</p>' });

        // F3 routes writes through the transaction's pinned query object. Wrap that real connection
        // so the injected failure cannot accidentally test the non-transactional proxy instead.
        const driver = database.getDbAsync();
        const realTransaction = driver.transaction.bind(driver);
        let blocked = 0;
        driver.transaction = async (work: any) => realTransaction(async (tx: any) => {
            const guarded = new Proxy(tx, {
                get(target, prop) {
                    if (prop === 'run') return async (sql: string, params: any) => {
                        if (/INSERT INTO posts/i.test(sql)) { blocked++; throw new Error('boom: revision insert failed'); }
                        return await target.run(sql, params);
                    };
                    const value = target[prop];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            return await work(guarded);
        });
        let ok: boolean;
        try {
            ok = await restoreRevision(revisionId);
        } finally {
            driver.transaction = realTransaction;
        }

        assert.ok(blocked > 0, 'the fault injection must actually have fired on the pinned connection');
        assert.strictEqual(ok, false, 'a restore without its safety snapshot must fail closed');
        const fresh = await dbAsync.get('SELECT post_content FROM posts WHERE id = ?', [post.id]);
        assert.match(fresh.post_content, /editado/, 'the destructive restore must have rolled back');
        const revs = await getRevisions(post.id);
        assert.strictEqual(revs.length, 1, 'the failed snapshot and restore leave no partial revision');
    });
});
