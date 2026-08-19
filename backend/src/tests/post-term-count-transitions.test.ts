/**
 * POST STATUS TRANSITIONS: TERM COUNTS + ORPHAN PUBLISH DATES (audit 2026-08-18, #16 + #17)
 *
 * Both defects lived in Post.update()/Post.delete() and both survived a green suite because nothing
 * exercised a TRANSITION — the existing post-terms suite only ever drives setTerms().
 *
 * #16 — term_taxonomy.count had exactly one writer, setTerms(). The operations that change it most
 *       never call setTerms: "Move to trash" and "Publish" send {status} with no `categories` key,
 *       and a force-delete drops term_relationships with a raw DELETE. So a trashed post kept
 *       inflating its category for ever, a force-deleted post left `count = 1` with zero rows, and a
 *       draft published without re-sending its terms stayed at 0 — which makes hide_empty HIDE a
 *       category that has content. Pinned here: the three transitions, both directions.
 *
 * #17 — a post_date in the future survived un-scheduling, so the next plain "Publish" (no date) was
 *       silently re-resolved back to 'future': the author pressed Publish and nothing published.
 *
 * Everything below drives the REAL producers — Post.create / Post.setTerms / Post.update /
 * Post.delete / Term.create, the same calls routes/posts.ts makes — never a hand-built row, so a
 * regression in the model cannot hide behind a fixture. The clock is INJECTED
 * (scheduledPublish.__setNow) so nothing depends on the wall clock.
 *
 * Same config-repoint-first pattern as the other DB-backed suites.
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-termcount-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const Post = require('../models/Post');
const Term = require('../models/Term');
const scheduledPublish = require('../core/scheduled-publish');

let dbAsync: any;
let seq = 0;

/** Create a term through the real Term model and return its term_taxonomy_id. */
async function makeTerm(taxonomy: string): Promise<{ termId: number; ttId: number }> {
    const name = `Term ${taxonomy} ${++seq}-${process.pid}`;
    const term = await Term.create({ name, taxonomy });
    return { termId: term.termId, ttId: term.termTaxonomyId };
}

/** Create a post through the real Post model. */
async function makePost(status: string, date?: string): Promise<number> {
    const created = await Post.create({
        authorId: 1,
        title: `Post ${++seq}-${process.pid}`,
        content: 'body',
        status,
        type: 'post',
        ...(date ? { date } : {})
    });
    return created.id;
}

const countOf = async (ttId: number): Promise<number> =>
    (await dbAsync.get('SELECT count FROM term_taxonomy WHERE term_taxonomy_id = ?', [ttId])).count;

const relRowsFor = async (ttId: number): Promise<number> =>
    (await dbAsync.get('SELECT COUNT(*) AS n FROM term_relationships WHERE term_taxonomy_id = ?', [ttId])).n;

const rowOf = async (postId: number): Promise<any> =>
    await dbAsync.get('SELECT post_status, post_date, post_date_gmt FROM posts WHERE id = ?', [postId]);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
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

// ---------------------------------------------------------------------------------------------
// #16 — the three transitions
// ---------------------------------------------------------------------------------------------

test('#16 publishing a draft that already has a category raises the count (hide_empty stops hiding it)', async () => {
    const { termId, ttId } = await makeTerm('category');
    const postId = await makePost('draft');
    await Post.setTerms(postId, [termId], 'category');

    // A draft counts for nothing.
    assert.strictEqual(await countOf(ttId), 0);

    // The editor's "Publish" — a status-only save, NO `categories` key. This is the exact shape
    // routes/posts.ts forwards, and it used to leave the count at 0 for ever.
    await Post.update(postId, { status: 'publish' });

    assert.strictEqual(await countOf(ttId), 1, 'publishing a draft must recount the terms it already had');
});

test('#16 trashing a published post lowers the count (one click no longer inflates it for ever)', async () => {
    const { termId, ttId } = await makeTerm('category');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [termId], 'category');
    assert.strictEqual(await countOf(ttId), 1);

    // "Move to trash" == DELETE /posts/:id without force == Post.update({status:'trash'}).
    await Post.delete(postId, false);

    assert.strictEqual(await rowOf(postId).then((r: any) => r.post_status), 'trash');
    assert.strictEqual(await countOf(ttId), 0, 'a trashed post must stop counting');
});

test('#16 untrashing restores the count (the drift is not one-way)', async () => {
    const { termId, ttId } = await makeTerm('category');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [termId], 'category');

    await Post.trash(postId);
    assert.strictEqual(await countOf(ttId), 0);

    await Post.untrash(postId);
    assert.strictEqual(await countOf(ttId), 1, 'restoring from trash must recount');
});

test('#16 force-delete leaves no count without rows (was: count=1 with zero relationships)', async () => {
    const { termId, ttId } = await makeTerm('category');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [termId], 'category');
    assert.strictEqual(await countOf(ttId), 1);

    await Post.delete(postId, true);

    assert.strictEqual(await relRowsFor(ttId), 0, 'the relationship row must be gone');
    assert.strictEqual(await countOf(ttId), 0, 'the counter must follow the rows it counts');
    assert.strictEqual(await dbAsync.get('SELECT id FROM posts WHERE id = ?', [postId]), undefined);
});

test('#16 force-delete recounts EVERY taxonomy the post was in, not just the first', async () => {
    const cat = await makeTerm('category');
    const tag = await makeTerm('post_tag');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [cat.termId], 'category');
    await Post.setTerms(postId, [tag.termId], 'post_tag');
    assert.strictEqual(await countOf(cat.ttId), 1);
    assert.strictEqual(await countOf(tag.ttId), 1);

    await Post.delete(postId, true);

    assert.strictEqual(await countOf(cat.ttId), 0);
    assert.strictEqual(await countOf(tag.ttId), 0, 'the recount is per taxonomy — a second one must not be skipped');
});

test('#16b force-delete recounts a term attached BETWEEN the read and the transaction', async () => {
    // The list of counters a delete invalidates used to be read on the loose connection, BEFORE the
    // transaction that deletes the relationships opened. Anything attached in that window was deleted
    // inside the transaction while its term_taxonomy_id was missing from the list being recounted —
    // an inflated count with zero relationship rows, permanently, which is the very symptom #16
    // existed to close. Post.update already read and recounted inside its own transaction; this pins
    // the twin.
    const cat = await makeTerm('category');
    const tag = await makeTerm('post_tag');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [cat.termId], 'category');
    assert.strictEqual(await countOf(cat.ttId), 1);

    // The concurrent writer (another request, the WXR importer) runs exactly when Post.delete opens
    // its transaction — i.e. after the moment the old code had already taken its snapshot.
    const drv = database.getDbAsync();
    const realTransaction = drv.transaction.bind(drv);
    drv.transaction = async (fn: any) => {
        drv.transaction = realTransaction;              // once, and the writer below needs the real one
        await Post.setTerms(postId, [tag.termId], 'post_tag');
        assert.strictEqual(await countOf(tag.ttId), 1, 'the concurrent write left the counter at 1');
        return realTransaction(fn);
    };

    try {
        await Post.delete(postId, true);
    } finally {
        drv.transaction = realTransaction;
    }

    assert.strictEqual(await relRowsFor(tag.ttId), 0, 'the delete removed the late relationship…');
    assert.strictEqual(await countOf(tag.ttId), 0, '…so its counter must have been recounted too');
    assert.strictEqual(await countOf(cat.ttId), 0);
});

test('#16b setTerms recounts a term attached BETWEEN its read and its transaction — the same twin', async () => {
    // setTerms had the identical shape as the delete above: it decided which counters it would touch
    // (`prev`) on the loose connection, then opened a transaction whose DELETE takes EVERY
    // relationship of that taxonomy. A term attached in between was therefore detached without ever
    // being recounted.
    const a = await makeTerm('category');
    const b = await makeTerm('category');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [a.termId], 'category');
    assert.strictEqual(await countOf(a.ttId), 1);

    const drv = database.getDbAsync();
    const realTransaction = drv.transaction.bind(drv);
    drv.transaction = async (fn: any) => {
        drv.transaction = realTransaction;
        // A concurrent editor adds a second category to the same post, through the real producer.
        await Post.setTerms(postId, [b.termId], 'category', true);
        assert.strictEqual(await countOf(b.ttId), 1, 'the concurrent write left the counter at 1');
        return realTransaction(fn);
    };

    try {
        // …and this save replaces the post's categories with just A, deleting B's relationship.
        await Post.setTerms(postId, [a.termId], 'category');
    } finally {
        drv.transaction = realTransaction;
    }

    assert.strictEqual(await relRowsFor(b.ttId), 0, 'B was detached…');
    assert.strictEqual(await countOf(b.ttId), 0, '…so B must have been recounted');
    assert.strictEqual(await countOf(a.ttId), 1, 'and A still has its post');
});

test('#16 a sibling published post keeps the term alive (the recount derives, it does not decrement)', async () => {
    const { termId, ttId } = await makeTerm('category');
    const keptId = await makePost('publish');
    const goneId = await makePost('publish');
    await Post.setTerms(keptId, [termId], 'category');
    await Post.setTerms(goneId, [termId], 'category');
    assert.strictEqual(await countOf(ttId), 2);

    await Post.delete(goneId, true);
    assert.strictEqual(await countOf(ttId), 1);

    await Post.update(keptId, { status: 'draft' });
    assert.strictEqual(await countOf(ttId), 0);
});

test('#16 an edit that does NOT cross the publish boundary leaves the count alone', async () => {
    const { termId, ttId } = await makeTerm('category');
    const postId = await makePost('publish');
    await Post.setTerms(postId, [termId], 'category');
    assert.strictEqual(await countOf(ttId), 1);

    await Post.update(postId, { title: 'Renamed' });
    assert.strictEqual(await countOf(ttId), 1);
});

// ---------------------------------------------------------------------------------------------
// #17 — an orphan future date must not turn "Publish" into "Schedule"
// ---------------------------------------------------------------------------------------------

test('#17 un-scheduling then publishing publishes NOW instead of rescheduling', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    // Path A, exactly as the editor drives it: schedule for December…
    const postId = await makePost('publish', '2026-12-01T09:00:00Z');
    assert.strictEqual((await rowOf(postId)).post_status, 'future');

    // …then un-schedule: {status:'draft'} with NO date. The December post_date_gmt survives.
    await Post.update(postId, { status: 'draft' });
    const staged = await rowOf(postId);
    assert.strictEqual(staged.post_status, 'draft');
    assert.ok(staged.post_date_gmt.startsWith('2026-12-01'), 'precondition: the orphan date is still stored');

    // …then plain "Publish": {status:'publish'} with NO date. This used to resolve back to 'future'.
    await Post.update(postId, { status: 'publish' });

    const after = await rowOf(postId);
    assert.strictEqual(after.post_status, 'publish', 'a bare publish must publish, not reschedule');
    assert.strictEqual(
        scheduledPublish.parseDbDateMs(after.post_date_gmt, true), now,
        'the orphan date must be replaced by the current time (wp_publish_post parity)'
    );
    assert.strictEqual(await scheduledPublish.nextScheduledPublish(postId), false, 'no flip event may remain armed');
});

test('#17 an EXPLICIT future date still schedules', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    const postId = await makePost('draft');
    await Post.update(postId, { status: 'publish', date: '2026-12-01T09:00:00Z' });

    const after = await rowOf(postId);
    assert.strictEqual(after.post_status, 'future', 'only an explicit date may schedule — and it must still do so');
    assert.ok(after.post_date_gmt.startsWith('2026-12-01'));
});

test('#17 re-saving an already-scheduled post does not publish it early', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    const postId = await makePost('publish', '2026-12-01T09:00:00Z');
    assert.strictEqual((await rowOf(postId)).post_status, 'future');

    // The guard is scoped to posts that are NOT already 'future'; the cron flip owns this one.
    await Post.update(postId, { status: 'publish' });

    const after = await rowOf(postId);
    assert.strictEqual(after.post_status, 'future');
    assert.ok(after.post_date_gmt.startsWith('2026-12-01'), 'a scheduled post keeps its date');
});

// ---------------------------------------------------------------------------------------------
// #17 (adversarial re-verify) — the rewrite must not eat a future date the AUTHOR chose
//
// The fix above cannot tell an ORPHAN date (left behind by a cancelled schedule) from one the author
// typed on a draft: the model receives them byte-for-byte identical. It used to stamp "now" over
// both, which destroyed the second — silently, with no undo. The mark written when a post is
// un-scheduled is what separates them, so both halves are pinned here.
// ---------------------------------------------------------------------------------------------

test('#17b a future date TYPED on a draft survives a bare Publish — and schedules, like WordPress', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    // The author opens the editor on a draft, sets December in the date control and saves. This is
    // exactly what buildStatusPatch sends: {status:'draft', date:…}. No schedule is armed (a draft
    // is not scheduled), and the December date is stored.
    const postId = await makePost('draft');
    await Post.update(postId, { status: 'draft', date: '2026-12-01T09:00:00Z' });
    assert.ok((await rowOf(postId)).post_date_gmt.startsWith('2026-12-01'), 'precondition: the date is stored');

    // The next day they pick "Published". The date control is not dirty, so the payload carries NO
    // date. Stamping now here is the data loss; scheduling is what they asked for.
    await Post.update(postId, { status: 'publish' });

    const after = await rowOf(postId);
    assert.ok(after.post_date_gmt.startsWith('2026-12-01'), "the author's date must survive the publish");
    assert.strictEqual(after.post_status, 'future', 'a future date + Publish is a SCHEDULE (wp_insert_post parity)');
    assert.strictEqual(
        await scheduledPublish.nextScheduledPublish(postId), Date.parse('2026-12-01T09:00:00Z'),
        'and the flip event is armed for that very moment, so it does publish itself'
    );
});

test('#17b a NEW explicit date clears the orphan mark, so the next bare Publish keeps it', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    // Schedule → un-schedule: the mark is set and the December date is an orphan…
    const postId = await makePost('publish', '2026-12-01T09:00:00Z');
    assert.strictEqual((await rowOf(postId)).post_status, 'future');
    await Post.update(postId, { status: 'draft' });

    // …but the author then picks a NEW date on the draft. That is a fresh statement of intent: the
    // mark must not outlive it, or the next Publish would eat this date too.
    await Post.update(postId, { status: 'draft', date: '2027-03-09T09:00:00Z' });
    await Post.update(postId, { status: 'publish' });

    const after = await rowOf(postId);
    assert.ok(after.post_date_gmt.startsWith('2027-03-09'), 'the re-chosen date must survive');
    assert.strictEqual(after.post_status, 'future');
});

test('#17 untrashing a published post keeps its original date (the rewrite is scoped to FUTURE dates)', async () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    scheduledPublish.__setNow(() => now);

    // Published in the past, then trashed. untrash() republishes with NO date — an unscoped
    // "always stamp now" would silently move this post's publication date to today.
    const postId = await makePost('publish', '2026-01-05T08:00:00Z');
    assert.strictEqual((await rowOf(postId)).post_status, 'publish');
    await Post.trash(postId);
    await Post.untrash(postId);

    const after = await rowOf(postId);
    assert.strictEqual(after.post_status, 'publish');
    assert.ok(after.post_date_gmt.startsWith('2026-01-05'), 'a past publication date must be preserved');
});
