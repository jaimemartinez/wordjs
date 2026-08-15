/**
 * SCHEDULED ("future") PUBLISHING SUITE — FRENTE C-1.
 *
 * WordPress parity: a post saved with status 'publish' and a post_date in the FUTURE is stored as
 * 'future' and armed with a one-off cron event ('publish_future_post', [id]) that flips it to
 * 'publish' when its time arrives — firing the SAME post_updated hook a normal publish fires, so the
 * frontend cache purges. This pins the observable contract, not the implementation:
 *
 *   • a future-dated publish becomes 'future' and arms exactly one event  (the CORE assertion —
 *     mutation-proven: revert the future-detection and the post publishes immediately, test goes red);
 *   • a past/now-dated publish publishes immediately and arms nothing;
 *   • firing the event (via the cron dispatcher) publishes the post AND fires post_updated;
 *   • editing a future post's date moves the event and leaves no orphan;
 *   • moving a future post off 'publish' cancels the event;
 *   • the public query (default status='publish') never returns a 'future' post;
 *   • the flip handler is idempotent / fail-safe (deleted, already-off-future, fired-early).
 *
 * The clock is INJECTED (scheduledPublish.__setNow) so nothing depends on the wall clock. Same
 * config-repoint-first pattern as the other DB-backed suites.
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-sched-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const Post = require('../models/Post');
const options = require('../core/options');
const { addAction, doAction } = require('../core/hooks');
const { runCron } = require('../core/cron');
const scheduledPublish = require('../core/scheduled-publish');

let dbAsync: any;

/** Count of pending flip events for a given post id in the persisted 'cron' option blob. */
async function eventCountFor(postId: number): Promise<number> {
    const events = await options.getOption('cron', {});
    const wanted = JSON.stringify([postId]);
    let n = 0;
    for (const ts of Object.keys(events || {})) {
        for (const key of Object.keys(events[ts] || {})) {
            const e = events[ts][key];
            if (e && e.hook === scheduledPublish.FUTURE_HOOK && JSON.stringify(e.args) === wanted) n++;
        }
    }
    return n;
}

/** Insert a post row directly (bypasses Post.create) so a test can stage an arbitrary status/date. */
async function insertRow(status: string, gmtDate: string): Promise<number> {
    const r = await dbAsync.run(
        `INSERT INTO posts (post_title, post_content, post_status, post_type, post_name, author_id,
            post_date, post_date_gmt, post_modified, post_modified_gmt)
         VALUES (?, '', ?, 'post', ?, 1, ?, ?, ?, ?)`,
        ['Staged', status, `staged-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            gmtDate, gmtDate, gmtDate, gmtDate]
    );
    return r.lastID;
}

const iso = (ms: number) => new Date(ms).toISOString();

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    // Wire the flip handler exactly as boot does, so doAction/runCron dispatch reaches it.
    scheduledPublish.initScheduledPublish();
});

afterEach(() => {
    scheduledPublish.__setNow(null); // restore the real clock between tests
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* */ }
    }
});

// ---------------------------------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------------------------------

test('resolveScheduledStatus: strictly-future publish → future; same-second/past → publish; others pass through', () => {
    const now = 1_000_000_000_000;
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('publish', now + 1000, now), 'future');
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('publish', now + 999, now), 'publish', 'same whole second is not future');
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('publish', now - 5000, now), 'publish');
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('future', now + 5000, now), 'future');
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('draft', now + 5000, now), 'draft', 'draft is never scheduled');
    assert.strictEqual(scheduledPublish.resolveScheduledStatus('pending', now + 5000, now), 'pending');
});

// ---------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------

test('CORE: a future-dated publish is stored as future and arms exactly one flip event', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const when = now + 3_600_000; // +1h

    const post = await Post.create({ authorId: 1, title: 'Scheduled A', status: 'publish', type: 'post', date: iso(when) });

    // The heart of the feature: a publish with a future date does NOT go live now.
    assert.strictEqual(post.postStatus, 'future', 'a future-dated publish must be stored as future, not publish');
    assert.strictEqual(await eventCountFor(post.id), 1, 'exactly one flip event is armed');
    const ts = await scheduledPublish.nextScheduledPublish(post.id);
    assert.strictEqual(ts, when, 'event armed at the scheduled timestamp');
});

test('a past-dated publish publishes immediately and arms no event', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);

    const post = await Post.create({ authorId: 1, title: 'Past pub', status: 'publish', type: 'post', date: iso(now - 60_000) });

    assert.strictEqual(post.postStatus, 'publish');
    assert.strictEqual(await eventCountFor(post.id), 0, 'a past date must not schedule anything');
});

test('a future date with a non-publish status is honoured as-is (draft stays draft, no event)', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);

    const post = await Post.create({ authorId: 1, title: 'Future draft', status: 'draft', type: 'post', date: iso(now + 3_600_000) });

    assert.strictEqual(post.postStatus, 'draft');
    assert.strictEqual(await eventCountFor(post.id), 0);
});

// ---------------------------------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------------------------------

test('firing the flip event publishes the post AND fires the post_updated purge hook', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const when = now + 3_600_000;
    const post = await Post.create({ authorId: 1, title: 'Fires', status: 'publish', type: 'post', date: iso(when) });
    assert.strictEqual(post.postStatus, 'future');

    // Time arrives.
    scheduledPublish.__setNow(() => when + 1000);

    let purgedId: any = null;
    const listener = (id: any) => { purgedId = id; };
    addAction('post_updated', listener);

    // Dispatch exactly as cron would (proves initScheduledPublish wired the hook).
    await doAction(scheduledPublish.FUTURE_HOOK, post.id);

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'publish', 'the fired event publishes the post');
    assert.strictEqual(purgedId, post.id, 'publishing fires post_updated so frontend-purge evicts the cache');
    assert.strictEqual(await eventCountFor(post.id), 0, 'the consumed event is gone');
});

test('runCron dispatches a due flip event end-to-end', async () => {
    // Stage a future-status post whose GMT date is already in the past, armed at a past timestamp so
    // runCron (which reads the REAL clock) fires it this tick.
    scheduledPublish.__setNow(null);
    const pastMs = Date.now() - 5000;
    const id = await insertRow('future', new Date(pastMs).toISOString().slice(0, 19).replace('T', ' '));
    await scheduledPublish.scheduleFuturePublish(id, pastMs);
    assert.strictEqual(await eventCountFor(id), 1);

    await runCron();

    const fresh = await Post.findById(id);
    assert.strictEqual(fresh.postStatus, 'publish', 'runCron flipped the due post to publish');
    assert.strictEqual(await eventCountFor(id), 0);
});

// ---------------------------------------------------------------------------------------------------
// Reschedule / cancel
// ---------------------------------------------------------------------------------------------------

test('editing a future post\'s date moves the event and leaves no orphan', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const when1 = now + 3_600_000;
    const when2 = now + 7_200_000;
    const post = await Post.create({ authorId: 1, title: 'Reschedule', status: 'publish', type: 'post', date: iso(when1) });
    assert.strictEqual(await scheduledPublish.nextScheduledPublish(post.id), when1);

    await Post.update(post.id, { date: iso(when2) });

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'future', 'still scheduled');
    assert.strictEqual(await eventCountFor(post.id), 1, 'no orphan event left at the old time');
    assert.strictEqual(await scheduledPublish.nextScheduledPublish(post.id), when2, 'event moved to the new time');
});

test('moving a future post to draft cancels its flip event', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const post = await Post.create({ authorId: 1, title: 'To draft', status: 'publish', type: 'post', date: iso(now + 3_600_000) });
    assert.strictEqual(await eventCountFor(post.id), 1);

    await Post.update(post.id, { status: 'draft' });

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'draft');
    assert.strictEqual(await eventCountFor(post.id), 0, 'no orphan event after unscheduling');
});

test('pulling a future post\'s date into the past publishes it now and cancels the event', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const post = await Post.create({ authorId: 1, title: 'Pull back', status: 'publish', type: 'post', date: iso(now + 3_600_000) });
    assert.strictEqual(post.postStatus, 'future');

    // Editor drags the date to the past (no explicit status) → re-evaluates to publish.
    await Post.update(post.id, { date: iso(now - 60_000) });

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'publish');
    assert.strictEqual(await eventCountFor(post.id), 0);
});

// ---------------------------------------------------------------------------------------------------
// Public visibility
// ---------------------------------------------------------------------------------------------------

test('the public query never returns a future post', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const scheduled = await Post.create({ authorId: 1, title: 'Hidden future', status: 'publish', type: 'post', date: iso(now + 3_600_000) });
    const live = await Post.create({ authorId: 1, title: 'Live now', status: 'publish', type: 'post' });

    const def = await Post.findAll({ type: 'post', limit: 100 });          // default status = publish
    const pub = await Post.findAll({ type: 'post', status: 'publish', limit: 100 });

    const ids = (rows: any[]) => rows.map((p) => p.id);
    assert.ok(!ids(def).includes(scheduled.id), 'default listing must not leak a future post');
    assert.ok(!ids(pub).includes(scheduled.id), 'explicit publish listing must not leak a future post');
    assert.ok(ids(def).includes(live.id), 'a genuinely published post is still listed');
    assert.ok(def.every((p: any) => p.postStatus !== 'future'), 'no row in the public listing is future');
});

// ---------------------------------------------------------------------------------------------------
// Idempotent / fail-safe handler
// ---------------------------------------------------------------------------------------------------

test('flip handler on a deleted post is a no-op (no throw)', async () => {
    await assert.doesNotReject(() => scheduledPublish.checkAndPublishFuture(9_999_999));
});

test('flip handler does NOT publish a post that is no longer future', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const post = await Post.create({ authorId: 1, title: 'Went draft', status: 'publish', type: 'post', date: iso(now + 3_600_000) });
    await Post.update(post.id, { status: 'draft' }); // author cancelled

    scheduledPublish.__setNow(() => now + 7_200_000); // event fires anyway
    await scheduledPublish.checkAndPublishFuture(post.id);

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'draft', 'a cancelled schedule must not resurrect as publish');
});

test('flip handler fired EARLY re-arms instead of publishing ahead of schedule', async () => {
    const now = Date.now();
    scheduledPublish.__setNow(() => now);
    const when = now + 3_600_000;
    const post = await Post.create({ authorId: 1, title: 'Early fire', status: 'publish', type: 'post', date: iso(when) });

    // Fire while still before the scheduled time.
    await scheduledPublish.checkAndPublishFuture(post.id);

    const fresh = await Post.findById(post.id);
    assert.strictEqual(fresh.postStatus, 'future', 'must not publish before its time');
    assert.strictEqual(await eventCountFor(post.id), 1, 'still armed for the real moment');
});
