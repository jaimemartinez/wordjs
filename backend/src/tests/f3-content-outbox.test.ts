/** F3 conformance: pinned transactions, durable post-commit events and multi-worker leases. */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-f3-outbox-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const { dbAsync } = database;
const Post = require('../models/Post');
const WebhookDelivery = require('../models/WebhookDelivery');
const { addAction, removeAction } = require('../core/hooks');
const {
    runContentMutation,
    recordContentEvent,
    dispatchOne,
    pruneProcessed,
    PROCESSED_RETENTION_SECONDS,
    databaseNowSeconds,
} = require('../core/content-outbox');

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${++seq}`;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* best effort */ }
    for (const file of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
});

describe('F3 durable event boundary', () => {
    test('lease time comes from the database rather than a skewed process clock', async () => {
        const realNow = Date.now;
        Date.now = () => 1000;
        try {
            assert.ok(await databaseNowSeconds() > 1_000_000_000);
        } finally {
            Date.now = realNow;
        }
    });

    test('an unavailable database clock fails closed instead of trusting a skewed node clock', async () => {
        const getDbType = database.getDbType;
        database.getDbType = () => { throw new Error('F3_DATABASE_CLOCK_UNAVAILABLE'); };
        try {
            await assert.rejects(databaseNowSeconds(), /F3_DATABASE_CLOCK_UNAVAILABLE/);
        } finally {
            database.getDbType = getDbType;
        }
    });

    test('a content hook observes committed content and a committed outbox row', async () => {
        const seen: any[] = [];
        const listener = async (postId: number) => {
            const post = await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [postId]);
            const event = await dbAsync.get('SELECT status FROM content_outbox WHERE aggregate_id = ? ORDER BY id DESC LIMIT 1', [postId]);
            seen.push({ title: post?.post_title, status: event?.status });
        };
        addAction('wp_insert_post', listener);
        try {
            const title = unique('committed');
            const post = await Post.create({ authorId: 1, title, content: 'body', status: 'draft' });
            assert.deepStrictEqual(seen, [{ title, status: 'processing' }]);
            const row = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            assert.strictEqual(row.status, 'processed');
            assert.strictEqual(Number(row.attempts), 1);
            assert.ok(row.event_id);
            assert.ok(row.processed_at);
        } finally {
            removeAction('wp_insert_post', listener);
        }
    });

    test('a thrown mutation persists neither its writes nor its event', async () => {
        const key = unique('rollback-option');
        const before = await dbAsync.get('SELECT COUNT(*) AS c FROM content_outbox');
        await assert.rejects(
            runContentMutation(async () => {
                await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [key, 'x', 'no']);
                recordContentEvent('post.updated', 999999, { data: { probe: true } });
                throw new Error('F3_ROLLBACK');
            }),
            /F3_ROLLBACK/
        );
        assert.strictEqual(await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [key]), undefined);
        const afterRow = await dbAsync.get('SELECT COUNT(*) AS c FROM content_outbox');
        assert.strictEqual(Number(afterRow.c), Number(before.c));
    });

    test('a failed hook leaves a retryable event and a later attempt processes the same event_id', async () => {
        let calls = 0;
        let fail = true;
        const listener = async () => {
            calls++;
            if (fail) throw new Error('F3_EXPECTED_HOOK_FAILURE');
        };
        addAction('wp_insert_post', listener);
        try {
            const post = await Post.create({ authorId: 1, title: unique('retry'), status: 'draft' });
            const pending = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            assert.strictEqual(pending.status, 'pending');
            assert.strictEqual(Number(pending.attempts), 1);
            const eventId = pending.event_id;

            fail = false;
            await dbAsync.run('UPDATE content_outbox SET available_at = 0 WHERE id = ?', [pending.id]);
            assert.strictEqual(await dispatchOne(Number(pending.id)), true);

            const processed = await dbAsync.get('SELECT * FROM content_outbox WHERE id = ?', [pending.id]);
            assert.strictEqual(processed.status, 'processed');
            assert.strictEqual(processed.event_id, eventId);
            assert.strictEqual(Number(processed.attempts), 2);
            assert.strictEqual(calls, 2, 'delivery is at-least-once and retries the immutable event');
        } finally {
            removeAction('wp_insert_post', listener);
        }
    });

    test('two workers racing one row produce one leased delivery', async () => {
        const post = await Post.create({ authorId: 1, title: unique('lease'), status: 'draft' });
        const row = await dbAsync.get('SELECT id FROM content_outbox WHERE aggregate_id = ?', [post.id]);
        await dbAsync.run(
            `UPDATE content_outbox SET status = 'pending', attempts = 0, available_at = 0,
             claim_token = NULL, claimed_until = NULL, processed_at = NULL WHERE id = ?`,
            [row.id]
        );

        let calls = 0;
        const listener = async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
        };
        addAction('wp_insert_post', listener);
        try {
            const results = await Promise.all([dispatchOne(Number(row.id)), dispatchOne(Number(row.id))]);
            assert.strictEqual(results.filter(Boolean).length, 1);
            assert.strictEqual(calls, 1);
            const final = await dbAsync.get('SELECT status, attempts FROM content_outbox WHERE id = ?', [row.id]);
            assert.deepStrictEqual({ status: final.status, attempts: Number(final.attempts) }, { status: 'processed', attempts: 1 });
        } finally {
            removeAction('wp_insert_post', listener);
        }
    });

    test('webhook fan-out is idempotent for one immutable content event', async () => {
        const sourceEventId = unique('event-id');
        const now = Math.floor(Date.now() / 1000);
        const first = await WebhookDelivery.enqueue(999999, 'post.updated', '{"ok":true}', now, sourceEventId);
        const duplicate = await WebhookDelivery.enqueue(999999, 'post.updated', '{"ok":true}', now, sourceEventId);
        assert.ok(first > 0);
        assert.strictEqual(duplicate, 0);
        const row = await dbAsync.get(
            'SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ? AND source_event_id = ?',
            [999999, sourceEventId]
        );
        assert.strictEqual(Number(row.c), 1);
    });

    test('retention prunes only old processed events and preserves retry/dead-letter evidence', async () => {
        const now = Math.floor(Date.now() / 1000);
        const old = now - PROCESSED_RETENTION_SECONDS - 1;
        const ids: Record<string, number> = {};
        for (const status of ['processed', 'pending', 'dead']) {
            const inserted = await dbAsync.run(
                `INSERT INTO content_outbox
                 (event_id, event_type, aggregate_id, payload, status, attempts, available_at, processed_at)
                 VALUES (?, 'post.updated', 777777, '{}', ?, 1, 0, ?) RETURNING id`,
                [unique(`retention-${status}`), status, old]
            );
            ids[status] = Number(inserted.lastID);
        }

        assert.strictEqual(await pruneProcessed(now), 1);
        assert.strictEqual(await dbAsync.get('SELECT id FROM content_outbox WHERE id = ?', [ids.processed]), undefined);
        assert.ok(await dbAsync.get('SELECT id FROM content_outbox WHERE id = ?', [ids.pending]));
        assert.ok(await dbAsync.get('SELECT id FROM content_outbox WHERE id = ?', [ids.dead]));
    });
});

describe('F3 transaction propagation', () => {
    test('a nested transaction joins the outer pinned connection and rolls back with it', async () => {
        const outer = unique('outer');
        const inner = unique('inner');
        await assert.rejects(
            dbAsync.transaction(async () => {
                await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [outer, '1', 'no']);
                await dbAsync.transaction(async () => {
                    await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [inner, '1', 'no']);
                });
                throw new Error('ROLLBACK_OUTER');
            }),
            /ROLLBACK_OUTER/
        );
        const rows = await dbAsync.all('SELECT option_name FROM options WHERE option_name IN (?, ?)', [outer, inner]);
        assert.deepStrictEqual(rows, []);
    });

    test('catching a failed joined transaction cannot commit its partial writes', async () => {
        const name = unique('rollback-only');
        await assert.rejects(
            dbAsync.transaction(async () => {
                try {
                    await dbAsync.transaction(async () => {
                        await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, '1', 'no']);
                        throw new Error('POISON_JOINED_UNIT');
                    });
                } catch { /* a caller may handle the local error, but the connection is rollback-only */ }
            }),
            /POISON_JOINED_UNIT/
        );
        assert.strictEqual(await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [name]), undefined);
    });

    test('overlapping SQLite transactions serialize instead of being mistaken for nesting', async () => {
        const names = Array.from({ length: 6 }, (_, i) => unique(`concurrent-${i}`));
        await Promise.all(names.map((name) => dbAsync.transaction(async () => {
            await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, '1', 'no']);
            await new Promise((resolve) => setImmediate(resolve));
            const own = await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [name]);
            assert.strictEqual(own.option_name, name);
        })));
        const placeholders = names.map(() => '?').join(',');
        const count = await dbAsync.get(`SELECT COUNT(*) AS c FROM options WHERE option_name IN (${placeholders})`, names);
        assert.strictEqual(Number(count.c), names.length);
    });

    test('an unrelated SQLite write cannot be absorbed by another request transaction', async () => {
        const doomed = unique('doomed-request');
        const outside = unique('outside-request');
        let entered!: () => void;
        let release!: () => void;
        const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
        const transactionRelease = new Promise<void>((resolve) => { release = resolve; });

        const failing = dbAsync.transaction(async () => {
            await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [doomed, '1', 'no']);
            entered();
            await transactionRelease;
            throw new Error('ROLLBACK_ISOLATED_REQUEST');
        });
        await transactionEntered;

        // Starts while BEGIN is open, but must wait outside it. Before the barrier this write landed
        // inside `failing` and disappeared with its rollback.
        const independent = dbAsync.run(
            'INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)',
            [outside, '1', 'no']
        );
        release();
        await assert.rejects(failing, /ROLLBACK_ISOLATED_REQUEST/);
        await independent;

        assert.strictEqual(await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [doomed]), undefined);
        assert.strictEqual((await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [outside])).option_name, outside);
    });

    test('a deferred task cannot reuse a closed transaction context', async () => {
        const name = unique('deferred-rollback');
        let release!: () => void;
        let deferred!: Promise<void>;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        await dbAsync.transaction(async () => {
            deferred = (async () => {
                await gate;
                await dbAsync.transaction(async () => {
                    await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, '1', 'no']);
                    throw new Error('DEFERRED_ROLLBACK');
                });
            })();
        });
        release();
        await assert.rejects(deferred, /DEFERRED_ROLLBACK/);
        assert.strictEqual(await dbAsync.get('SELECT option_name FROM options WHERE option_name = ?', [name]), undefined);
    });

    test('a deferred content write opens a new mutation and persists its own event', async () => {
        let release!: () => void;
        let deferred!: Promise<any>;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const title = unique('deferred-event');

        await runContentMutation(async () => {
            deferred = (async () => {
                await gate;
                return await Post.create({ authorId: 1, title, status: 'draft' });
            })();
        });
        release();
        const post = await deferred;
        const event = await dbAsync.get('SELECT event_type FROM content_outbox WHERE aggregate_id = ?', [post.id]);
        assert.strictEqual(event?.event_type, 'post.created');
    });

    test('cache hits cannot hide writes already made inside the transaction', async () => {
        const post = await Post.create({ authorId: 1, title: unique('cached-old'), status: 'draft' });
        await Post.findById(post.id); // seed L1
        const next = unique('cached-new');
        await dbAsync.transaction(async () => {
            await dbAsync.run('UPDATE posts SET post_title = ? WHERE id = ?', [next, post.id]);
            const inside = await Post.findById(post.id);
            assert.strictEqual(inside.postTitle, next);
        });
    });
});

describe('F3 restore boundary', () => {
    test('database clear fails closed when stale external work cannot be removed', async () => {
        const locked = {
            async run(sql: string) {
                if (/webhook_deliveries/i.test(sql)) throw new Error('database is locked');
                return { changes: 0 };
            }
        };
        await assert.rejects(
            database.clearDatabase(locked),
            /Refusing to clear content while stale external work remains in webhook_deliveries/
        );
    });

    test('database clear removes semantic events and already-fanned webhook deliveries', async () => {
        const sourceEventId = unique('restore-stale-event');
        await dbAsync.run(
            `INSERT INTO content_outbox
             (event_id, event_type, aggregate_id, payload, status, attempts, available_at)
             VALUES (?, 'post.updated', 888888, '{}', 'pending', 0, 0)`,
            [sourceEventId]
        );
        await WebhookDelivery.enqueue(999999, 'post.updated', '{}', 0, sourceEventId);

        await database.clearDatabase();

        assert.strictEqual(Number((await dbAsync.get('SELECT COUNT(*) AS c FROM content_outbox')).c), 0);
        assert.strictEqual(Number((await dbAsync.get('SELECT COUNT(*) AS c FROM webhook_deliveries')).c), 0);
    });
});
