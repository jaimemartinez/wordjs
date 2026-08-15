/**
 * WordJS — Scheduled ("future") publishing.
 *
 * WordPress parity: a post saved with status 'publish' and a post_date in the FUTURE is stored as
 * 'future' instead, and a one-off cron event ('publish_future_post', [postId]) is armed for that
 * timestamp. When it fires, the post is flipped to 'publish' — through Post.update(), so it fires the
 * SAME post_updated hook a normal publish fires and the frontend cache purges (frontend-purge listens
 * on post_updated). Editing a future post's date re-arms the event; moving it off 'publish' (draft /
 * pending / trash) cancels it. A 'future' post is not 'publish', so every public query already hides it.
 *
 * The clock is injectable (__setNow) so tests never depend on the wall clock. The flip handler is
 * fail-safe and idempotent: the post may have been deleted, rescheduled, already published, or the
 * event may have fired early — each case is handled without publishing ahead of schedule.
 */

const { scheduleSingleEvent, clearScheduledHook, nextScheduled } = require('./cron');
const { addAction } = require('./hooks');

const FUTURE_HOOK = 'publish_future_post';

// Injectable clock. Production uses Date.now(); tests swap it for a fixed value.
let _nowMs: () => number = () => Date.now();
function __setNow(fn: (() => number) | null) { _nowMs = fn || (() => Date.now()); }
function nowMs(): number { return _nowMs(); }

/**
 * PURE future-detection: the single decision "does this save become 'future'?".
 * A request to 'publish' (or re-affirm a 'future') whose target time is strictly LATER than now — in
 * whole seconds, matching WordPress — is stored as 'future'; now/past publishes immediately. Any other
 * requested status (draft/pending/private/trash) passes through untouched.
 */
function resolveScheduledStatus(requestedStatus: any, whenMs: any, now: number = nowMs()): string {
    if (requestedStatus === 'publish' || requestedStatus === 'future') {
        if (Number.isFinite(whenMs) && Math.floor(whenMs / 1000) > Math.floor(now / 1000)) {
            return 'future';
        }
        return 'publish';
    }
    return requestedStatus;
}

/** Parse a GMT/local "YYYY-MM-DD HH:MM:SS" string to epoch ms. `utc` appends 'Z'. null if unparseable. */
function parseDbDateMs(value: any, utc: boolean): number | null {
    if (!value) return null;
    const iso = String(value).replace(' ', 'T') + (utc ? 'Z' : '');
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
}

/**
 * (Re)schedule the flip event for a post. IDEMPOTENT: any prior event for this post is cleared first,
 * so a reschedule leaves exactly one event and there are never orphan events for the same post.
 */
async function scheduleFuturePublish(postId: any, whenMs: number): Promise<void> {
    await clearScheduledHook(FUTURE_HOOK, [postId]);
    await scheduleSingleEvent(Math.floor(whenMs), FUTURE_HOOK, [postId]);
}

/** Cancel a pending flip (post moved off 'publish', deleted, or its date pulled into the past). */
async function cancelFuturePublish(postId: any): Promise<void> {
    await clearScheduledHook(FUTURE_HOOK, [postId]);
}

/**
 * The flip handler — the callback the cron event runs. Fail-safe and idempotent:
 *  - post gone            → nothing to do (deleted between arming and firing);
 *  - no longer 'future'   → someone rescheduled it to draft / it was already published → do nothing;
 *  - its time not arrived → the event fired early (clock skew / manual trigger) → re-arm and wait;
 *  - otherwise            → publish via Post.update(), firing post_updated → the frontend cache purges.
 */
async function checkAndPublishFuture(postId: any): Promise<void> {
    const Post = require('../models/Post');
    const post = await Post.findById(postId);
    if (!post) return;                        // deleted since the event was armed
    if (post.postStatus !== 'future') return; // rescheduled / cancelled / already published

    const whenMs = parseDbDateMs(post.postDateGmt, true) ?? parseDbDateMs(post.postDate, false);
    if (whenMs !== null && Math.floor(whenMs / 1000) > Math.floor(nowMs() / 1000)) {
        // Fired ahead of time — re-arm for the real moment rather than publishing early.
        await scheduleFuturePublish(postId, whenMs);
        return;
    }

    await Post.update(postId, { status: 'publish' });
}

let _wired = false;
/** Register the flip handler. Call ONCE from initialize() after the hook system is up. */
function initScheduledPublish(): void {
    if (_wired) return;
    _wired = true;
    addAction(FUTURE_HOOK, checkAndPublishFuture);
}

/** Is there a pending flip event for this post? (epoch ms, or false). Test/introspection helper. */
async function nextScheduledPublish(postId: any): Promise<number | false> {
    return await nextScheduled(FUTURE_HOOK, [postId]);
}

module.exports = {
    FUTURE_HOOK,
    resolveScheduledStatus,
    parseDbDateMs,
    scheduleFuturePublish,
    cancelFuturePublish,
    checkAndPublishFuture,
    initScheduledPublish,
    nextScheduledPublish,
    nowMs,
    __setNow,
};
