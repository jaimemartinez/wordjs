/**
 * WordJS - outgoing webhook dispatcher (roadmap: open the platform / headless).
 *
 * Derives semantic events from TWO existing seams — never from emit calls of its own scattered through
 * the routes — and delivers HMAC-signed POSTs to registered endpoints:
 *   - the action hooks core already fires (wp_insert_post / post_updated / deleted_post for every post
 *     write including imports and scheduled publishing, wp_insert_comment / deleted_comment,
 *     activated_plugin / deactivated_plugin, switch_theme);
 *   - core/audit's in-process observer: every lifecycle moment the product audits (users, sign-ins,
 *     comment moderation, media, terms, menus, plugin install/uninstall, settings) is already one
 *     recordAudit call, made after the mutation succeeded, so the audit row IS the event.
 * The full catalogue lives in models/Webhook.ts; each payload is built by an allowlisted serializer in
 * core/webhook-payloads.ts, and documentation/webhooks.md documents every one.
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
const payloads = require('./webhook-payloads');
const { postPayload, commentPayload } = payloads;
const log = require('./module-logger').moduleLogger('core/webhooks');

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

/** Enqueue a durable delivery per matching active endpoint, then (in prod) kick an immediate pump. */
async function fanout(event: string, data: any, meta: { actorId?: number | null } = {}): Promise<void> {
    const ids = await Webhook.activeIdsForEvent(event);
    if (!ids.length) return;
    // A content outbox retry replays hooks at-least-once. Carry its immutable id into the delivery
    // queue so fan-out is idempotent per endpoint+semantic event; comment/legacy hooks use NULL and
    // retain their existing behavior.
    const sourceEventId = require('./content-outbox').currentContentEventId();
    // `actor` (the acting user's id) is known for audit-derived events; absent otherwise.
    const actor = meta.actorId != null ? meta.actorId : undefined;
    const body = JSON.stringify({ event, eventId: sourceEventId || undefined, timestamp: nowSec(), actor, data });
    const now = nowSec();
    for (const id of ids) await WebhookDelivery.enqueue(id, event, body, now, sourceEventId);
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
        if (post.postStatus === 'future') await fanout('post.scheduled', payload);
    } catch (e) { warn('wp_insert_post', e); }
}
async function onPostUpdated(id: number, _data: any, prevStatus?: string): Promise<void> {
    try {
        const post = await Post.findById(id);
        if (!post || SKIP_TYPES.has(post.postType)) return;
        const now = post.postStatus;
        const payload = postPayload(post);
        // Events are derived from a real TRANSITION (prevStatus → now), not the post-write state, so a
        // plain re-save of an already-published/-trashed post does not re-fire published/deleted.
        if (now === 'trash') {
            if (prevStatus !== 'trash') {
                await fanout('post.trashed', { ...payload, previousStatus: prevStatus ?? null });
                // The app's soft-delete has always been announced as post.deleted too; kept so existing
                // receivers keep working. post.trashed is the specific signal.
                await fanout('post.deleted', payload);
            }
            return;
        }
        await fanout('post.updated', payload);
        if (prevStatus === 'trash') await fanout('post.restored', payload);
        if (now === 'publish' && prevStatus !== 'publish') await fanout('post.published', payload);
        if (now === 'future' && prevStatus !== 'future') await fanout('post.scheduled', payload);
        if (prevStatus === 'publish' && now !== 'publish') {
            await fanout('post.unpublished', { ...payload, previousStatus: prevStatus });
        }
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

// ── Extension lifecycle hooks ───────────────────────────────────────────────────────────────────────
// activated_plugin / deactivated_plugin fire on every real state change (including the brief
// deactivate → activate an in-place update performs), wherever it was requested from.
async function onPluginActivated(slug: string): Promise<void> {
    try { await fanout('plugin.activated', payloads.pluginPayload(slug)); } catch (e) { warn('activated_plugin', e); }
}
async function onPluginDeactivated(slug: string): Promise<void> {
    try { await fanout('plugin.deactivated', payloads.pluginPayload(slug)); } catch (e) { warn('deactivated_plugin', e); }
}
async function onSwitchTheme(slug: string, previous?: string): Promise<void> {
    try { await fanout('theme.activated', payloads.themePayload(slug, previous)); } catch (e) { warn('switch_theme', e); }
}

// ── Audit-derived events ────────────────────────────────────────────────────────────────────────────
// Audit action → webhook event. Only actions NOT already announced by a hook above appear here (post.*
// and plugin.activate/deactivate audit rows would be duplicates); an unlisted action is ignored.
const AUDIT_EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({
    'auth.login.success': 'user.login',
    'user.create': 'user.created',
    'user.update': 'user.updated',
    // A role-ONLY change has no user.update row; when other fields were saved too, the user.update row
    // (which lists 'role') is the event and this one is skipped (profileUpdate: true) — see routes/users.ts.
    'user.role_change': 'user.updated',
    'user.delete': 'user.deleted',
    'comment.update': 'comment.updated',
    'comment.approve': 'comment.approved',
    'comment.spam': 'comment.spam',
    'comment.trash': 'comment.trashed',
    'media.upload': 'media.uploaded',
    'media.update': 'media.updated',
    'media.delete': 'media.deleted',
    'term.create': 'term.created',
    'term.update': 'term.updated',
    'term.delete': 'term.deleted',
    'menu.create': 'menu.updated',
    'menu.update': 'menu.updated',
    'menu.delete': 'menu.updated',
    'plugin.install': 'plugin.installed',
    'marketplace.install': 'plugin.installed',
    'plugin.uninstall': 'plugin.uninstalled',
    'settings.update': 'settings.updated'
});

/** Field names of a profile/media edit, as a receiver may see them (names only; never a credential). */
function fieldNames(v: any): string[] {
    return (Array.isArray(v) ? v : []).map((f) => String(f)).filter((f) => !/passw|secret|token|key|hash|mfa/i.test(f));
}

/** Build the payload of an audit-derived event, or null when there is nothing (left) to announce. */
async function auditEventPayload(ev: any): Promise<any> {
    const d = ev.detail || {};
    const id = Number(ev.targetId);
    const hasId = ev.targetId !== '' && Number.isFinite(id);
    switch (ev.action) {
        case 'auth.login.success':
        case 'user.create':
        case 'user.role_change':
        case 'user.update': {
            if (ev.action === 'user.role_change' && d.profileUpdate) return null;
            const User = require('../models/User');
            const u = hasId ? await User.findById(id) : null;
            if (!u) return null;
            const out: any = payloads.userPayload(u);
            if (ev.action === 'user.update') out.changed = fieldNames(d.fields);
            if (ev.action === 'user.role_change') out.changed = ['role'];
            if (ev.action === 'user.create' && d.via) out.via = String(d.via).slice(0, 32);
            return out;
        }
        case 'user.delete':
            return { id: hasId ? id : null, username: d.username ?? null, role: d.role ?? null };
        case 'comment.update':
        case 'comment.approve':
        case 'comment.spam':
        case 'comment.trash': {
            const c = hasId ? await Comment.findById(id) : null;
            if (!c) return null;
            return { ...commentPayload(c), previousStatus: d.from ?? null };
        }
        case 'media.upload':
        case 'media.update': {
            const Media = require('../models/Media');
            const m = hasId ? await Media.findById(id) : null;
            if (!m) return null;
            const out: any = payloads.mediaPayload(m);
            if (ev.action === 'media.update') out.changed = fieldNames(d.fields);
            return out;
        }
        case 'media.delete':
            return {
                id: hasId ? id : null,
                title: d.title ?? null,
                mimeType: d.mimeType ?? null,
                visibility: d.visibility === 'private' ? 'private' : 'public'
            };
        case 'term.create':
        case 'term.update': {
            const Term = require('../models/Term');
            const t = hasId ? await Term.findById(id, d.taxonomy || null) : null;
            if (!t) return null;
            return payloads.termPayload(t);
        }
        case 'term.delete':
            return payloads.termPayload({ id: hasId ? id : null, name: d.name, slug: d.slug, taxonomy: d.taxonomy });
        case 'menu.create':
        case 'menu.update': {
            const { Menu } = require('../models/Menu');
            const m = hasId ? await Menu.findById(id) : null;
            return payloads.menuPayload(m || { id: hasId ? id : null }, d);
        }
        case 'menu.delete':
            return payloads.menuPayload({ id: hasId ? id : null, name: d.name, slug: d.slug }, d);
        case 'plugin.install':
            return payloads.pluginPayload(ev.targetId, { via: d.via || 'upload' });
        case 'marketplace.install':
            if (!d.ok) return null; // a failed install is audited, but nothing was installed
            return payloads.pluginPayload(ev.targetId, { via: 'marketplace', source: d.source, version: d.version });
        case 'plugin.uninstall':
            return payloads.pluginPayload(ev.targetId);
        case 'settings.update': {
            const out = payloads.settingsPayload(d.keys);
            return out.keys.length ? out : null;
        }
        default:
            return null;
    }
}

/** core/audit observer. TOTAL-CATCH, like every listener here: it must never surface into a route. */
async function onAuditRecorded(ev: any): Promise<void> {
    try {
        const event = AUDIT_EVENT_MAP[ev && ev.action];
        if (!event) return;
        // Cheap pre-check before any model read: nobody subscribed → nothing to build.
        if (!(await Webhook.activeIdsForEvent(event)).length) return;
        const data = await auditEventPayload(ev);
        if (data) await fanout(event, data, { actorId: ev.actorId });
    } catch (e) { warn(`audit:${ev && ev.action}`, e); }
}

/**
 * Send the `ping` test delivery to ONE endpoint (the admin's "Send test" button) and deliver it at once
 * through the normal signed, SSRF-guarded path, so the result is exactly what a real event would get.
 * Returns the delivery id (0 if it could not be queued).
 */
async function sendPing(webhookId: number, actorId?: number | null): Promise<number> {
    const now = nowSec();
    const body = JSON.stringify({
        event: Webhook.PING_EVENT,
        timestamp: now,
        actor: actorId != null ? actorId : undefined,
        data: { webhookId, message: 'Test delivery from WordJS. If this signature verifies, the endpoint is set up correctly.' }
    });
    const id = await WebhookDelivery.enqueue(webhookId, Webhook.PING_EVENT, body, now, null);
    if (id) await deliverOne(id);
    return id;
}

function warn(hook: string, e: any): void {
    try { log.warn({ hook, err: e }, `[webhooks] listener ${hook} failed (non-fatal)`); } catch { /* */ }
}

const LISTENERS: Array<[string, (...a: any[]) => any]> = [
    ['wp_insert_post', onPostInsert],
    ['post_updated', onPostUpdated],
    ['deleted_post', onPostDeleted],
    ['wp_insert_comment', onCommentInsert],
    ['deleted_comment', onCommentDeleted],
    ['activated_plugin', onPluginActivated],
    ['deactivated_plugin', onPluginDeactivated],
    ['switch_theme', onSwitchTheme]
];

let _unobserveAudit: null | (() => void) = null;

function registerListeners(): void {
    for (const [hook, fn] of LISTENERS) addAction(hook, fn);
    if (!_unobserveAudit) _unobserveAudit = require('./audit').onAuditRecorded(onAuditRecorded);
}
function unregisterListeners(): void {
    for (const [hook, fn] of LISTENERS) removeAction(hook, fn);
    if (_unobserveAudit) { _unobserveAudit(); _unobserveAudit = null; }
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
        log.warn('⚠️  [webhooks] SSRF defense for PRIVATE targets is DISABLED (WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE is set in a non-production env). Webhook delivery can reach loopback/RFC1918/cloud-metadata. NEVER enable this in production.');
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
    sendPing,
    WEBHOOK_EVENTS: Webhook.EVENTS,
    MAX_ATTEMPTS
};
