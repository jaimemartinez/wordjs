/**
 * term_taxonomy.count HAS ONE MAINTAINER — the nav_menu half (audit #16 twin).
 *
 * The categories/tags half of #16 was fixed by making the counter a DERIVED consequence of the write
 * (Post.updateTermCounts / Post._recountTermTaxonomies). `models/Menu.ts` was the second writer of the
 * SAME column and it was left behind: MenuItem.create did `SET count = count + 1` and MenuItem.delete
 * dropped the term_relationships row without ever decrementing. One removed menu item inflated the
 * counter for ever — the same permanent, one-directional drift #16 describes, on a taxonomy whose
 * counter `Term.findAll`'s `hide_empty` reads as `tt.count > 0`.
 *
 * Everything below goes through the REAL router (`routes/menus.ts` via supertest) — no hand-built
 * MenuItem calls — and then reads the column straight out of SQL, so the assertion is about what a
 * user clicking "add item" / "remove item" in the admin actually leaves in the database. The invariant
 * asserted is the strong one: `count` equals the number of relationship rows that really exist, after
 * every transition. Under the old code the delete case fails with count=2, rows=1.
 *
 * Same config-repoint-first harness as authz-idor.test.ts (point config.dbPath at a temp file BEFORE
 * the DB layer resolves it).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-menucount-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/v1', require('../routes'));

let dbAsync: any;
let adminToken = '';

/** The two numbers that must never disagree, for one nav_menu term. */
async function counters(menuId: number): Promise<{ count: number; rows: number }> {
    const tt = await dbAsync.get(
        `SELECT term_taxonomy_id, count FROM term_taxonomy WHERE term_id = ? AND taxonomy = 'nav_menu'`,
        [menuId]);
    assert.ok(tt, 'the nav_menu term_taxonomy row must exist');
    const rel = await dbAsync.get(
        `SELECT COUNT(*) AS n FROM term_relationships WHERE term_taxonomy_id = ?`,
        [tt.term_taxonomy_id]);
    return { count: Number(tt.count), rows: Number(rel.n) };
}

const asAdmin = (m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${adminToken}`);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    // The default post types must be registered before the routers run — the app initializer does this
    // after connecting, but this harness does not boot it.
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    const u = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [u.lastID]);
    adminToken = jwt.sign({ userId: u.lastID, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

describe('nav_menu: term_taxonomy.count is derived, not incremented', () => {
    test('add two items, remove one — count tracks reality at every step', async () => {
        const created = await asAdmin('post', '/menus').send({ name: 'Header nav counts' });
        assert.strictEqual(created.status, 201, `menu create failed: ${created.status} ${JSON.stringify(created.body)}`);
        const menuId = created.body.id;
        assert.ok(menuId, 'the created menu must report its term id');

        assert.deepStrictEqual(await counters(menuId), { count: 0, rows: 0 }, 'a fresh menu starts empty');

        const first = await asAdmin('post', `/menus/${menuId}/items`).send({ title: 'Home', url: '/' });
        assert.strictEqual(first.status, 201, `item create failed: ${first.status} ${JSON.stringify(first.body)}`);
        assert.deepStrictEqual(await counters(menuId), { count: 1, rows: 1 }, 'first item counted');

        const second = await asAdmin('post', `/menus/${menuId}/items`).send({ title: 'About', url: '/about' });
        assert.strictEqual(second.status, 201);
        assert.deepStrictEqual(await counters(menuId), { count: 2, rows: 2 }, 'second item counted');

        // THE REGRESSION. The incremental writer had no counterpart on this path: the relationship row
        // went away and `count` stayed at 2 for ever.
        const removed = await asAdmin('delete', `/menus/items/${second.body.id}`);
        assert.strictEqual(removed.status, 200, `item delete failed: ${removed.status} ${JSON.stringify(removed.body)}`);
        assert.deepStrictEqual(await counters(menuId), { count: 1, rows: 1 },
            'removing a menu item must DECREMENT the counter — an incremented-only count reports items that no longer exist');

        // And back to empty: `hide_empty` reads `count > 0`, so an emptied menu that still claims 1
        // would keep advertising itself as populated.
        const last = await asAdmin('delete', `/menus/items/${first.body.id}`);
        assert.strictEqual(last.status, 200);
        assert.deepStrictEqual(await counters(menuId), { count: 0, rows: 0 }, 'an emptied menu reports 0');
    });

    test('the counter survives a second menu untouched (the recount is SCOPED)', async () => {
        // Post.updateTermCounts takes the term_taxonomy_ids the write actually touched. If Menu.ts ever
        // passed the wrong scope — or none, recounting the whole taxonomy — this is where it shows:
        // menu B must be unaffected by every write to menu A.
        const a = await asAdmin('post', '/menus').send({ name: 'Scope A' });
        const b = await asAdmin('post', '/menus').send({ name: 'Scope B' });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(b.status, 201);

        const bItem = await asAdmin('post', `/menus/${b.body.id}/items`).send({ title: 'B only', url: '/b' });
        assert.strictEqual(bItem.status, 201);

        const aItem = await asAdmin('post', `/menus/${a.body.id}/items`).send({ title: 'A only', url: '/a' });
        assert.strictEqual(aItem.status, 201);
        await asAdmin('delete', `/menus/items/${aItem.body.id}`);

        assert.deepStrictEqual(await counters(a.body.id), { count: 0, rows: 0 }, 'menu A is empty again');
        assert.deepStrictEqual(await counters(b.body.id), { count: 1, rows: 1 }, 'menu B was never touched');
    });
});
