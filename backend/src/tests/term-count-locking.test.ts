/**
 * updateTermCounts takes the row lock BEFORE it derives the count (adversarial re-verify of #16).
 *
 * `SET count = (SELECT COUNT(*) …)` is only correct if the subquery sees every committed transition.
 * On PostgreSQL under READ COMMITTED — the default, and the driver does not raise it — the SET
 * subquery is evaluated against the snapshot the statement took when it STARTED. Two concurrent
 * publishes of two posts in the same category: the second blocks on the row lock and, when it wakes,
 * EvalPlanQual re-checks the target row against the new version while the subquery keeps its original
 * snapshot, which does not contain the rival's committed post_status change. The counter settles on 1
 * instead of 2, permanently, because nothing ever repairs it.
 *
 * The suite runs on SQLite, where this cannot happen (writes are serialized, and there is no FOR
 * UPDATE to ask for), so the property has to be asserted where it lives: in the statements the model
 * emits for each engine. The REAL Post.updateTermCounts is driven here with a recording `q` — the
 * same parameter Post.update/Post.delete hand it inside their transactions — so what is pinned is the
 * producer's own SQL, not a description of it.
 *
 * MUTATION PROOF: delete the _lockTermTaxonomies call and the Postgres/MySQL tests fail (no lock
 * statement is recorded). Emit the lock unconditionally and the SQLite test fails, which matters
 * because there FOR UPDATE is a syntax error, not a no-op.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// Nothing here opens a database (the recorder below stands in for the connection), but requiring the
// config must not point at the developer's real file either.
const os = require('os');
const path = require('path');
const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-lock-${process.pid}-${Date.now()}.db`);

// The engine is what decides whether a lock statement may be emitted at all, so it is INPUT to the
// test. Patch it before requiring the model: Post.ts destructures getDbType at load time.
const database = require('../config/database');
let engine: any = { isPostgres: false, isMySQL: false, isSQLite: true, driver: 'sqlite-native' };
database.getDbType = () => engine;

const Post = require('../models/Post');

/** A connection that records what it is asked to do instead of doing it — the shape of a driver's
 *  transaction handle (`q`), which is what every writer of this column passes in. */
function recorder() {
    const calls: Array<{ method: string; sql: string; params: any[] }> = [];
    const push = (method: string) => async (sql: string, params: any[] = []) => {
        calls.push({ method, sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return method === 'all' ? [] : { changes: 0 };
    };
    return { calls, all: push('all'), run: push('run'), get: push('get') };
}

beforeEach(() => {
    engine = { isPostgres: false, isMySQL: false, isSQLite: true, driver: 'sqlite-native' };
});

test('PostgreSQL: the rows are locked first, in a stable order, and for the SAME ids the UPDATE uses', async () => {
    engine = { isPostgres: true, isMySQL: false, isSQLite: false, driver: 'postgres' };
    const q = recorder();

    await Post.updateTermCounts('category', [7, 3], q);

    assert.strictEqual(q.calls.length, 2, 'exactly one lock and one update');
    const [lock, update] = q.calls;

    assert.match(lock.sql, /SELECT term_taxonomy_id FROM term_taxonomy/);
    assert.match(lock.sql, /FOR UPDATE$/, 'the lock must actually be a locking read');
    assert.match(lock.sql, /ORDER BY term_taxonomy_id FOR UPDATE$/,
        'a stable lock order is what stops two concurrent recounts from deadlocking');
    assert.ok(q.calls.indexOf(lock) < q.calls.indexOf(update), 'the lock comes BEFORE the derivation');

    assert.match(update.sql, /^UPDATE term_taxonomy SET count = \( SELECT COUNT\(\*\)/);
    // The value checked and the value used must be the same set: a lock on other rows would be
    // decoration.
    assert.deepStrictEqual(lock.params, ['category', 7, 3]);
    assert.deepStrictEqual(update.params, ['category', 7, 3]);
});

test('MySQL gets the same treatment — it has the same READ COMMITTED default', async () => {
    engine = { isPostgres: false, isMySQL: true, isSQLite: true, driver: 'mysql' };
    const q = recorder();

    await Post.updateTermCounts('post_tag', [11], q);

    assert.strictEqual(q.calls.length, 2);
    assert.match(q.calls[0].sql, /FOR UPDATE$/);
    assert.deepStrictEqual(q.calls[0].params, ['post_tag', 11]);
});

test('SQLite emits NO lock statement — there is none, and asking would be a syntax error', async () => {
    const q = recorder();

    await Post.updateTermCounts('category', [7, 3], q);

    assert.strictEqual(q.calls.length, 1, 'only the UPDATE');
    assert.match(q.calls[0].sql, /^UPDATE term_taxonomy/);
    assert.doesNotMatch(q.calls[0].sql, /FOR UPDATE/);
});

test('the unscoped repair pass (whole taxonomy) is locked too — same shape, no id list', async () => {
    engine = { isPostgres: true, isMySQL: false, isSQLite: false, driver: 'postgres' };
    const q = recorder();

    await Post.updateTermCounts('category', undefined, q);

    assert.strictEqual(q.calls.length, 2);
    assert.match(q.calls[0].sql, /WHERE taxonomy = \? ORDER BY term_taxonomy_id FOR UPDATE$/);
    assert.deepStrictEqual(q.calls[0].params, ['category']);
    assert.match(q.calls[1].sql, /WHERE taxonomy = \?$/);
    assert.deepStrictEqual(q.calls[1].params, ['category']);
});
