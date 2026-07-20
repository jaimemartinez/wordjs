/**
 * WordJS - outgoing webhook dispatcher (roadmap: open the platform / headless).
 *
 * Subscribes to the internal content hooks, derives semantic events (post.created/published/updated/
 * deleted, comment.created/deleted), and delivers HMAC-signed POSTs to registered endpoints.
 *
 * Two hard constraints from the hook bus (see core/hooks.ts): doAction is awaited INLINE in the content
 * write path with NO error isolation. So every listener here is:
 *   (1) TOTAL-CATCH — it never throws, or it would fail the originating post/comment save; and
 *   (2) NON-BLOCKING on the network — it only ENQUEUES a durable delivery row (a few fast local DB ops)
 *       and returns; the actual outbound HTTP happens out of band in the poller.
 *
 * Delivery is SSRF-safe: native http/https.request with lookup=validatingLookup pins the connection to
 * the validated resolved IP (blocking loopback/RFC1918/link-local/cloud-metadata and closing DNS
 * rebinding), and native request does NOT follow redirects, so a 30x cannot be bounced to an internal
 * host. Cross-node concurrency is handled by WebhookDelivery.claim's atomic single-statement lease — no
 * distributed lock required.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const egress = require('./egress-guard');
const { hmacSha256Hex } = require('./crypto-utils');
const { addAction, removeAction } = require('./hooks');
const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const Post = require('../models/Post');
const Comment = require('../models/Comment');

const nowSec = () => Math.floor(Date.now() / 1000);

// Delivery/retry tuning.
const MAX_ATTEMPTS = 6;              // initial + 5 retries → ~a few hours, then dead-lettered
const LEASE_SEC = 60;                // a claimed delivery is invisible to other workers for this long
const DELIVERY_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 4096;     // we only need the status; drain a little for logging, then cut off
const POLL_INTERVAL_MS = 5000;
const BATCH = 20;
const BACKOFF_BASE_SEC = 30;
const BACKOFF_CAP_SEC = 6 * 3600;

// Internal post types that must never emit content webhooks (revisions, media attachments, menu items).
const SKIP_TYPES = new Set(['revision', 'attachment', 'nav_menu_item']);

function backoffSec(attempts: number): number {
    const raw = BACKOFF_BASE_SEC * Math.pow(2, Math.max(0, attempts - 1));
    const capped = Math.min(raw, BACKOFF_CAP_SEC);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1); // ±20% to de-synchronize retry storms
    return Math.max(BACKOFF_BASE_SEC, Math.round(capped + jitter));
}

/** The signature header value: sha256=<hex HMAC of `${timestamp}.${rawBody}`>. */
function signPayload(secret: string, timestamp: number, rawBody: string): string {
    return 'sha256=' + hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
}

// Explicit, ENV-ONLY test seam (never a persisted config option): allow delivery to loopback/private
// targets so the test suite can run a local receiver. Requires BOTH the flag AND a non-production
// environment, so a single env var can never silently disable SSRF defense in prod (the flag name is
// deliberately alarming). initWebhooks() logs a loud warning whenever it is active.
function allowPrivateTargets(): boolean {
    if (process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE !== '1') return false;
    let env = 'production';
    try { env = require('../config/app').nodeEnv || process.env.NODE_ENV || 'production'; } catch { /* */ }
    return env !== 'production';
}

/**
 * Deliver one signed POST. SSRF-safe. Resolves the result rather than rejecting on an HTTP error status;
 * rejects only on a transport/SSRF error. Returns { status } (0 if none).
 *
 * SSRF defense is two-layer: (1) assertUrlAllowed rejects an IP-literal internal target outright AND any
 * hostname that resolves to an internal address — this is what catches a raw 127.0.0.1/::1/metadata IP,
 * because Node's `lookup` option is ONLY consulted for hostnames, never IP literals; (2) validatingLookup
 * as the connect-time lookup then pins the resolved IP so a hostname cannot rebind to an internal address
 * between the check and the connection. Both are skipped only under the explicit env test seam.
 */
async function postSigned(targetUrl: string, event: string, deliveryId: number, rawBody: string, secret: string): Promise<{ status: number }> {
    let u: URL;
    try { u = new URL(targetUrl); } catch { throw new Error('invalid webhook url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme');
    if (!allowPrivateTargets()) await egress.assertUrlAllowed(u.href); // throws on a blocked/internal target
    const lib = u.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
        const ts = nowSec();
        const body = Buffer.from(rawBody, 'utf8');
        const opts: any = {
            method: 'POST',
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            timeout: DELIVERY_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(body.length),
                'User-Agent': 'WordJS-Webhook/1.0',
                'X-WordJS-Event': event,
                'X-WordJS-Delivery': String(deliveryId),
                'X-WordJS-Timestamp': String(ts),
                'X-WordJS-Signature-256': signPayload(secret, ts, rawBody)
            }
        };
        // SSRF pin: resolve+validate the connect IP unless the explicit test seam is on. validatingLookup
        // makes Node connect to exactly the validated address, so check and connect share one resolution.
        if (!allowPrivateTargets()) opts.lookup = egress.validatingLookup;

        let settled = false;
        let deadline: any;
        const settle = (fn: any, arg: any) => { if (settled) return; settled = true; clearTimeout(deadline); fn(arg); };
        const req = lib.request(opts, (res: any) => {
            let received = 0;
            res.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > MAX_RESPONSE_BYTES) res.destroy(); // we don't need the body
            });
            res.on('end', () => settle(resolve, { status: res.statusCode || 0 }));
            res.on('error', () => settle(resolve, { status: res.statusCode || 0 }));
        });
        req.on('error', (e: any) => settle(reject, e));
        req.on('timeout', () => req.destroy(new Error('delivery idle timeout')));
        // ABSOLUTE deadline: the `timeout` option above is idle-only, so a byte-trickling receiver could
        // otherwise outlive the claim lease (LEASE_SEC) and cause a duplicate delivery on another worker.
        deadline = setTimeout(() => req.destroy(new Error('delivery deadline exceeded')), DELIVERY_TIMEOUT_MS);
        if (deadline.unref) deadline.unref();
        req.write(body);
        req.end();
    });
}

/** Deliver a single queued delivery by id (claim → send → record outcome). Never throws. */
async function deliverOne(deliveryId: number): Promise<void> {
    try {
        const now = nowSec();
        const leaseUntil = now + LEASE_SEC; // also the claim TOKEN that guards every outcome write below
        if (!(await WebhookDelivery.claim(deliveryId, now, leaseUntil))) return; // another worker owns it
        const d = await WebhookDelivery.get(deliveryId);
        if (!d) return;
        const attempts = d.attempts; // already incremented by claim
        const wh = await Webhook.getSigning(d.webhookId);
        if (!wh) { await WebhookDelivery.markDead(deliveryId, leaseUntil, null, 'webhook deleted'); return; }
        // A paused / auto-disabled endpoint is authoritative: don't send queued or redelivered payloads.
        if (!wh.active) { await WebhookDelivery.markDead(deliveryId, leaseUntil, null, 'webhook inactive'); return; }
        if (!wh.secret) {
            await WebhookDelivery.markDead(deliveryId, leaseUntil, null, 'signing secret undecryptable');
            await Webhook.recordOutcome(d.webhookId, false, now); // count it so the endpoint eventually auto-pauses
            warn('delivery', new Error(`webhook ${d.webhookId} signing secret is undecryptable (jwt.secret rotated?)`));
            return;
        }

        let status = 0; let err: string | null = null;
        try {
            const res = await postSigned(wh.url, d.event, deliveryId, d.payload, wh.secret);
            status = res.status;
        } catch (e: any) {
            err = (e && e.message) ? String(e.message) : String(e);
        }
        const done = nowSec();
        const ok = status >= 200 && status < 300;
        if (ok) {
            await WebhookDelivery.markSuccess(deliveryId, leaseUntil, status, done);
            await Webhook.recordOutcome(d.webhookId, true, done);
        } else {
            const reason = err || `HTTP ${status}`;
            if (attempts >= MAX_ATTEMPTS) {
                await WebhookDelivery.markDead(deliveryId, leaseUntil, status || null, reason);
            } else {
                await WebhookDelivery.reschedule(deliveryId, leaseUntil, done + backoffSec(attempts), status || null, reason);
            }
            await Webhook.recordOutcome(d.webhookId, false, done);
        }
    } catch { /* a single delivery must never break the pump */ }
}

let _pumping = false;
let _pollTimer: any = null;

/** Process all currently-due deliveries once. Safe to call concurrently across nodes (atomic claim). */
async function pump(): Promise<void> {
    if (_pumping) return; // one pass at a time on this node
    _pumping = true;
    try {
        const ids = await WebhookDelivery.dueIds(nowSec(), BATCH);
        for (const id of ids) await deliverOne(id);
    } catch { /* poll error — try again next tick */ }
    finally { _pumping = false; }
}

function postPayload(post: any) {
    return {
        id: post.id,
        type: post.postType,
        status: post.postStatus,
        title: post.postTitle,
        slug: post.postName,
        author: post.authorId,
        date: post.postDate,
        modified: post.postModified
    };
}

// Deliberately EXCLUDES author email + IP (PII) — a webhook payload should not leak commenter contact data.
function commentPayload(c: any) {
    return {
        id: c.id,
        postId: c.commentPostId,
        author: c.commentAuthor,
        content: c.commentContent,
        approved: c.commentApproved,
        userId: c.userId
    };
}

/** Enqueue a durable delivery per matching active endpoint, then (in prod) kick an immediate pump. */
async function fanout(event: string, data: any): Promise<void> {
    const ids = await Webhook.activeIdsForEvent(event);
    if (!ids.length) return;
    const body = JSON.stringify({ event, timestamp: nowSec(), data });
    const now = nowSec();
    for (const id of ids) await WebhookDelivery.enqueue(id, event, body, now);
    // Low-latency kick — only when the poller is running (prod). In tests (poller off) delivery is driven
    // explicitly via pump(), keeping the suite deterministic.
    if (_pollTimer) setImmediate(() => { pump().catch(() => {}); });
}

// ── Content-hook listeners (each TOTAL-CATCH — must never throw into the awaited doAction chain) ──────
async function onPostInsert(postId: number, _data: any): Promise<void> {
    try {
        const post = await Post.findById(postId);
        if (!post || SKIP_TYPES.has(post.postType)) return;
        const payload = postPayload(post);
        await fanout('post.created', payload);
        if (post.postStatus === 'publish') await fanout('post.published', payload);
    } catch (e) { warn('wp_insert_post', e); }
}
async function onPostUpdated(id: number, _data: any, prevStatus?: string): Promise<void> {
    try {
        const post = await Post.findById(id);
        if (!post || SKIP_TYPES.has(post.postType)) return;
        const now = post.postStatus;
        // Events are derived from a real TRANSITION (prevStatus → now), not the post-write state, so a
        // plain re-save of an already-published/-trashed post does not re-fire published/deleted.
        if (now === 'trash') {
            if (prevStatus !== 'trash') await fanout('post.deleted', postPayload(post)); // the app's soft-delete
            return;
        }
        await fanout('post.updated', postPayload(post));
        if (now === 'publish' && prevStatus !== 'publish') await fanout('post.published', postPayload(post));
    } catch (e) { warn('post_updated', e); }
}
async function onPostDeleted(id: number, prevStatus?: string): Promise<void> {
    // Hard delete. If the post was already trashed, the trash transition already emitted post.deleted —
    // don't double-signal. A direct force-delete of a live post still emits it.
    if (prevStatus === 'trash') return;
    try { await fanout('post.deleted', { id }); } catch (e) { warn('deleted_post', e); }
}
async function onCommentInsert(commentId: number, _data: any): Promise<void> {
    try {
        const c = await Comment.findById(commentId);
        if (!c) return;
        await fanout('comment.created', commentPayload(c));
    } catch (e) { warn('wp_insert_comment', e); }
}
async function onCommentDeleted(id: number): Promise<void> {
    try { await fanout('comment.deleted', { id }); } catch (e) { warn('deleted_comment', e); }
}

function warn(hook: string, e: any): void {
    try { console.warn(`[webhooks] listener ${hook} failed (non-fatal): ${(e && e.message) || e}`); } catch { /* */ }
}

const LISTENERS: Array<[string, (...a: any[]) => any]> = [
    ['wp_insert_post', onPostInsert],
    ['post_updated', onPostUpdated],
    ['deleted_post', onPostDeleted],
    ['wp_insert_comment', onCommentInsert],
    ['deleted_comment', onCommentDeleted]
];

function registerListeners(): void {
    for (const [hook, fn] of LISTENERS) addAction(hook, fn);
}
function unregisterListeners(): void {
    for (const [hook, fn] of LISTENERS) removeAction(hook, fn);
}

function startPoller(): void {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => { pump().catch(() => {}); }, POLL_INTERVAL_MS);
    if (_pollTimer.unref) _pollTimer.unref(); // never keep the process alive for the poller
}
function stopPoller(): void {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

/** Boot entry: wire the content listeners and start the delivery poller. */
function initWebhooks(opts: { startPoller?: boolean } = {}): void {
    if (allowPrivateTargets()) {
        console.warn('⚠️  [webhooks] SSRF defense for PRIVATE targets is DISABLED (WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE is set in a non-production env). Webhook delivery can reach loopback/RFC1918/cloud-metadata. NEVER enable this in production.');
    }
    registerListeners();
    if (opts.startPoller !== false) startPoller();
}

module.exports = {
    initWebhooks,
    registerListeners,
    unregisterListeners,
    startPoller,
    stopPoller,
    pump,
    deliverOne,
    signPayload,
    fanout,
    WEBHOOK_EVENTS: Webhook.EVENTS,
    MAX_ATTEMPTS
};
