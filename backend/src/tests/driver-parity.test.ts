/**
 * WordJS - Driver-parity regression tests (core/revisions + models/User)
 *
 * These lock in three cross-driver SQL bugs that were invisible on SQLite but broke (or silently
 * mis-answered) on Postgres/MySQL. They run against a throwaway temp SQLite DB — deterministic and
 * offline — so what they prove is the FUNCTION-LEVEL logic: that limitRevisions prunes to the cap and
 * cleans up the pruned revisions' meta, and that User.count/findAll honor their filters + ordering.
 *
 * The cross-engine SQL PORTABILITY of the previously-broken statement is proven separately, on the real
 * CI Postgres + MySQL engines (WORDJS_CI_DB=1), by the "revision-prune portability" block in
 * driver-conformance.test.ts: it executes the exact shape limitRevisions now emits — `SELECT id ...
 * ORDER BY ... LIMIT ?` then `DELETE ... WHERE id IN (<list>)` — the form the old
 * `DELETE ... WHERE id IN (SELECT ... LIMIT ?)` could NOT run on MySQL. (A SQLite-only test can't catch
 * that syntax rejection — the old form runs fine on SQLite; only a real MySQL exercises the difference.)
 *
 * Bugs pinned here:
 *  1. limitRevisions() used `DELETE ... WHERE id IN (SELECT id FROM posts ... LIMIT ?)` — a form MySQL
 *     rejects (ER 1093 self-reference + ER 1235 LIMIT-in-subquery), so pruning threw and any restore of
 *     a >10-revision post 500'd. It must prune to the cap AND clean up the pruned revisions' meta.
 *  2. User.count() ignored its filter args (`SELECT COUNT(*) FROM users`), so paginated list totals
 *     (X-WP-Total) were wrong whenever a role/search filter was applied.
 *  3. User.findAll() had NO ORDER BY, so the whitelisted orderby/order the route passes were silently
 *     dropped and rows came back in undefined engine order.
 *
 * Same config-repoint-first ordering as api.test.ts: point config.dbPath at a temp file BEFORE the DB
 * layer resolves it, so the real data DB is never touched.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Repoint the DB singleton at a throwaway temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(
    os.tmpdir(),
    `wordjs-parity-test-${process.pid}-${Date.now()}.db`
);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer + the units under test.
const database = require('../config/database');
const revisions = require('../core/revisions');
const User = require('../models/User');

describe('driver-parity: revisions + User', () => {
    let dbAsync: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
    });

    after(async () => {
        try {
            await database.closeDatabase();
        } catch {
            /* ignore */
        }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try {
                if (fs.existsSync(f)) fs.rmSync(f, { force: true });
            } catch {
                /* ignore */
            }
        }
    });

    // --- Bug 1: limitRevisions prunes to the cap AND removes the pruned revisions' meta (no orphans). ---
    it('limitRevisions prunes the oldest revisions down to the cap and cleans up their meta', async () => {
        // A parent post to hang revisions off of.
        const parent = await dbAsync.run(
            `INSERT INTO posts (post_title, post_type, post_status) VALUES (?, 'post', 'publish')`,
            ['Parent']
        );
        const postId = parent.lastID;

        // 12 revisions with strictly-increasing post_modified so "oldest" is unambiguous, each with one
        // meta row so we can prove meta is pruned alongside the revision.
        const revIds: number[] = [];
        for (let i = 0; i < 12; i++) {
            const stamp = `2026-01-01 00:00:${String(i).padStart(2, '0')}`;
            const r = await dbAsync.run(
                `INSERT INTO posts (post_parent, post_type, post_status, post_title, post_content, post_name, post_modified)
                 VALUES (?, 'revision', 'inherit', ?, ?, ?, ?)`,
                [postId, `rev ${i}`, `body ${i}`, `${postId}-revision-v${i}`, stamp]
            );
            revIds.push(r.lastID);
            await dbAsync.run(
                `INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, 'k', ?)`,
                [r.lastID, `v${i}`]
            );
        }

        assert.strictEqual(await revisions.countRevisions(postId), 12, 'precondition: 12 revisions exist');

        // Prune to 10. Must not throw on the portable SQL, and must report the number removed.
        const removed = await revisions.limitRevisions(postId, 10);
        assert.strictEqual(removed, 2, 'exactly the 2 oldest revisions must be pruned');
        assert.strictEqual(await revisions.countRevisions(postId), 10, 'revision count must drop to the cap');

        // The two oldest (i=0, i=1) must be gone; the newest (i=11) must remain.
        const oldestGone = await dbAsync.get('SELECT id FROM posts WHERE id = ?', [revIds[0]]);
        assert.strictEqual(oldestGone, undefined, 'the oldest revision row must be deleted');
        const newestKept = await dbAsync.get('SELECT id FROM posts WHERE id = ?', [revIds[11]]);
        assert.ok(newestKept, 'the newest revision row must survive');

        // Meta of the pruned revisions must be gone too (no orphans left in post_meta).
        const orphanMeta = await dbAsync.get(
            'SELECT COUNT(*) as c FROM post_meta WHERE post_id IN (?, ?)',
            [revIds[0], revIds[1]]
        );
        assert.strictEqual(Number(orphanMeta.c), 0, 'pruned revisions must not orphan their meta');
        // Meta of a surviving revision must be intact.
        const keptMeta = await dbAsync.get('SELECT COUNT(*) as c FROM post_meta WHERE post_id = ?', [revIds[11]]);
        assert.strictEqual(Number(keptMeta.c), 1, 'surviving revision meta must be untouched');
    });

    // --- Bugs 2 + 3: seed users with roles/names, then assert count reflects filters and findAll orders. ---
    describe('User.count filters + User.findAll ordering', () => {
        before(async () => {
            // Insert order (carol, alice, bob) deliberately matches NEITHER ascending NOR descending login
            // order — so SQLite's no-ORDER-BY rowid/insertion order differs from both. Without this, a seed
            // inserted alphabetically would make the ascending assertion pass even against the buggy
            // (no ORDER BY) code, masking the very bug this test locks in.
            const users = [
                ['carol', 'Carol', 'carol@example.com', 'subscriber'],
                ['alice', 'Alice', 'alice@example.com', 'editor'],
                ['bob', 'Bob', 'bob@example.com', 'editor'],
            ];
            for (const [login, display, email, role] of users) {
                const r = await dbAsync.run(
                    `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
                    [login, email, display]
                );
                await dbAsync.run(
                    `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
                    [r.lastID, role]
                );
            }
        });

        it('count() with no filter returns every user', async () => {
            assert.strictEqual(await User.count({}), 3);
        });

        it('count({role}) reflects the role filter (was: ignored → wrong X-WP-Total)', async () => {
            assert.strictEqual(await User.count({ role: 'editor' }), 2);
            assert.strictEqual(await User.count({ role: 'subscriber' }), 1);
            assert.strictEqual(await User.count({ role: 'nonexistent' }), 0);
        });

        it('count({search}) reflects the search filter across login/display/email', async () => {
            assert.strictEqual(await User.count({ search: 'ali' }), 1, 'matches alice by login');
            assert.strictEqual(await User.count({ search: 'example.com' }), 3, 'matches all by email');
            assert.strictEqual(await User.count({ search: 'Carol' }), 1, 'matches carol by display_name');
        });

        it('count() matches the DISTINCT user count findAll returns under a role filter', async () => {
            const rows = await User.findAll({ role: 'editor', limit: 100 });
            assert.strictEqual(rows.length, await User.count({ role: 'editor' }),
                'count and findAll must agree on the filtered total (pagination correctness)');
        });

        it('findAll respects orderby/order (was: no ORDER BY → undefined order)', async () => {
            const asc = (await User.findAll({ orderBy: 'user_login', order: 'ASC', limit: 100 }))
                .map((u: any) => u.userLogin);
            assert.deepStrictEqual(asc, ['alice', 'bob', 'carol'], 'ascending by login');

            const desc = (await User.findAll({ orderBy: 'user_login', order: 'DESC', limit: 100 }))
                .map((u: any) => u.userLogin);
            assert.deepStrictEqual(desc, ['carol', 'bob', 'alice'], 'descending by login');
        });

        it('findAll ignores a non-whitelisted orderby column (no injection, falls back to id)', async () => {
            const rows = await User.findAll({ orderBy: 'user_pass); DROP TABLE users;--', order: 'ASC', limit: 100 });
            assert.strictEqual(rows.length, 3, 'a bogus orderby must not break the query, just fall back to id');
        });

        it('findAll applies the role filter to the returned rows', async () => {
            const editors = await User.findAll({ role: 'editor', limit: 100 });
            assert.strictEqual(editors.length, 2);
            assert.ok(editors.every((u: any) => u.meta && u.meta.role === 'editor'),
                'every returned row must actually have the filtered role');
        });
    });
});
