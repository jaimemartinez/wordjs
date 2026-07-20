/**
 * WordJS - Webhook model (outgoing webhook subscriptions).
 *
 * A row is an endpoint the operator registers to receive signed POSTs when content events fire. The
 * per-endpoint signing secret is stored in PLAINTEXT (column `secret`) — it must be re-read verbatim to
 * sign each delivery AND stay stable across restarts and all deploy modes; app-level encryption keyed off
 * a rotatable app secret silently broke deliveries when that secret changed (see crypto-utils.ts). The
 * secret is returned ONCE at creation/rotation and never again; list/detail views expose only a non-secret
 * prefix, and it is never logged. At-rest protection is deferred to DB/disk encryption.
 */

const { dbAsync } = require('../config/database');
const crypto = require('crypto');
const egress = require('../core/egress-guard');

// The canonical catalog of events a webhook can subscribe to. Kept here (the model) so both the routes
// (validation/UI) and the dispatcher agree on one source of truth. '*' subscribes to everything; a
// trailing '.*' (e.g. 'post.*') subscribes to a family.
const WEBHOOK_EVENTS = [
    'post.created',
    'post.published',
    'post.updated',
    'post.deleted',
    'comment.created',
    'comment.deleted'
];

const SECRET_PREFIX = 'whsec_';

function newSigningSecret(): string {
    return SECRET_PREFIX + crypto.randomBytes(32).toString('base64url'); // 256-bit, URL/header-safe
}

/**
 * Validate + normalize a webhook target URL. Rejects non-http(s) schemes and obvious internal IP-literal
 * targets at creation time for fast feedback; the AUTHORITATIVE SSRF defense (DNS resolution + rebinding
 * pin) happens at delivery time in core/webhooks.ts. Returns the normalized href or throws.
 */
function validateUrl(rawUrl: string): string {
    let u: URL;
    try { u = new URL(String(rawUrl)); } catch { throw new Error('Invalid webhook URL.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Webhook URL must use http or https.');
    }
    if (!u.hostname) throw new Error('Webhook URL must have a host.');
    // Reject an internal IP-literal target at creation (127.0.0.1, 169.254.169.254, RFC1918, ::1, …).
    // WHATWG URL keeps IPv6 hosts BRACKETED ('[::1]'), which net.isIP would reject — strip them first so
    // isBlockedIp actually sees the address. (The authoritative SSRF defense is still at delivery time.)
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (require('net').isIP(host) && egress.isBlockedIp(host)) {
        throw new Error('Webhook URL points to a disallowed internal address.');
    }
    return u.href;
}

/**
 * Coerce arbitrary events input into a deduped list of recognized events (or ['*']). Fails CLOSED: a
 * non-empty input that resolves to NOTHING recognized (a typo like 'post.publised') throws rather than
 * silently subscribing the endpoint to '*' (every event, including drafts). Only a genuinely absent/empty
 * input defaults to '*'.
 */
function normalizeEvents(input: any): string[] {
    let parts: string[];
    if (Array.isArray(input)) parts = input.map((s) => String(s));
    else if (typeof input === 'string') parts = input.split(',');
    else parts = [];
    const out = new Set<string>();
    let sawToken = false;
    for (const raw of parts) {
        const s = raw.trim();
        if (!s) continue;
        sawToken = true;
        if (s === '*') return ['*'];
        // Accept an exact event or a family wildcard 'x.*' whose prefix matches a known event.
        if (WEBHOOK_EVENTS.includes(s)) out.add(s);
        else if (s.endsWith('.*') && WEBHOOK_EVENTS.some((e) => e.startsWith(s.slice(0, -1)))) out.add(s);
    }
    if (out.size === 0) {
        if (sawToken) throw new Error(`No recognized events. Valid: ${WEBHOOK_EVENTS.join(', ')} (or '*').`);
        out.add('*'); // absent/empty input → subscribe to all
    }
    return Array.from(out);
}

/** Does a webhook subscribed to `events` want `event`? Supports '*' and family wildcards ('post.*'). */
function eventMatches(events: string[], event: string): boolean {
    for (const e of events) {
        if (e === '*') return true;
        if (e === event) return true;
        if (e.endsWith('.*') && event.startsWith(e.slice(0, -1))) return true;
    }
    return false;
}

function toDisplay(row: any) {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        url: row.url,
        events: String(row.events || '*').split(',').filter(Boolean),
        secretPrefix: row.secret_prefix,
        active: !!row.active,
        failureCount: row.failure_count || 0,
        lastDeliveryAt: row.last_delivery_at != null ? Number(row.last_delivery_at) : null,
        createdAt: row.created_at
    };
}

// Auto-pause an endpoint after this many CONSECUTIVE failed deliveries (a dead/misconfigured receiver
// should not accumulate unbounded retries forever).
const AUTO_DISABLE_AFTER = 20;

class Webhook {
    static EVENTS = WEBHOOK_EVENTS;
    static eventMatches = eventMatches;
    static normalizeEvents = normalizeEvents;
    static validateUrl = validateUrl;

    /** Create a webhook. Returns display metadata PLUS the plaintext `secret` (shown once). */
    static async create(opts: { userId: number; name?: string; url: string; events?: any; active?: boolean }) {
        const url = validateUrl(opts.url);
        const events = normalizeEvents(opts.events);
        const name = String(opts.name || '').slice(0, 200).trim() || 'Webhook';
        const secret = newSigningSecret();
        const active = opts.active === false ? 0 : 1;
        const result = await dbAsync.run(
            `INSERT INTO webhooks (user_id, name, url, events, secret, secret_prefix, active, failure_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
            [opts.userId, name, url, events.join(','), secret, secret.slice(0, 14), active]
        );
        const row = await dbAsync.get('SELECT * FROM webhooks WHERE id = ?', [result.lastID]);
        return { ...toDisplay(row), secret };
    }

    static async findById(id: number) {
        const row = await dbAsync.get('SELECT * FROM webhooks WHERE id = ?', [id]);
        return row ? toDisplay(row) : null;
    }

    static async list() {
        const rows = await dbAsync.all('SELECT * FROM webhooks ORDER BY id DESC');
        return (rows || []).map(toDisplay);
    }

    static async update(id: number, fields: { name?: string; url?: string; events?: any; active?: boolean }) {
        const sets: string[] = [];
        const params: any[] = [];
        if (fields.name !== undefined) { sets.push('name = ?'); params.push(String(fields.name).slice(0, 200)); }
        if (fields.url !== undefined) { sets.push('url = ?'); params.push(validateUrl(fields.url)); }
        if (fields.events !== undefined) { sets.push('events = ?'); params.push(normalizeEvents(fields.events).join(',')); }
        if (fields.active !== undefined) {
            sets.push('active = ?'); params.push(fields.active ? 1 : 0);
            // Re-enabling clears the consecutive-failure counter so a fixed endpoint starts fresh.
            if (fields.active) { sets.push('failure_count = 0'); }
        }
        if (sets.length === 0) return await Webhook.findById(id);
        params.push(id);
        await dbAsync.run(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, params);
        return await Webhook.findById(id);
    }

    /** Rotate the signing secret. Returns the new plaintext `secret` (shown once). */
    static async rotateSecret(id: number) {
        const exists = await dbAsync.get('SELECT id FROM webhooks WHERE id = ?', [id]);
        if (!exists) return null;
        const secret = newSigningSecret();
        await dbAsync.run('UPDATE webhooks SET secret = ?, secret_prefix = ? WHERE id = ?',
            [secret, secret.slice(0, 14), id]);
        return { id, secret, secretPrefix: secret.slice(0, 14) };
    }

    static async delete(id: number): Promise<boolean> {
        const result = await dbAsync.run('DELETE FROM webhooks WHERE id = ?', [id]);
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    /**
     * INTERNAL (dispatcher enqueue path): ids of ACTIVE webhooks that want `event`. No secret decryption
     * here — the hot content-write path only needs to know WHO to enqueue for; the secret is fetched per
     * webhook at delivery time via getSigning().
     */
    static async activeIdsForEvent(event: string): Promise<number[]> {
        const rows = await dbAsync.all('SELECT id, events FROM webhooks WHERE active = 1');
        const out: number[] = [];
        for (const row of rows || []) {
            const events = String(row.events || '*').split(',').filter(Boolean);
            if (eventMatches(events, event)) out.push(row.id);
        }
        return out;
    }

    /**
     * INTERNAL (dispatcher delivery path): a webhook's url + signing secret by id. Never expose the result
     * to an HTTP response.
     */
    static async getSigning(id: number): Promise<null | { id: number; url: string; active: boolean; secret: string | null }> {
        const row = await dbAsync.get('SELECT * FROM webhooks WHERE id = ?', [id]);
        if (!row) return null;
        return { id: row.id, url: row.url, active: !!row.active, secret: row.secret || null };
    }

    /**
     * Record a delivery outcome against the endpoint: refresh last_delivery_at, and track CONSECUTIVE
     * failures so a persistently-failing endpoint auto-pauses (active=0) instead of retrying forever.
     */
    static async recordOutcome(id: number, success: boolean, nowSec: number): Promise<void> {
        if (success) {
            await dbAsync.run('UPDATE webhooks SET last_delivery_at = ?, failure_count = 0 WHERE id = ?', [nowSec, id]);
            return;
        }
        await dbAsync.run('UPDATE webhooks SET last_delivery_at = ?, failure_count = failure_count + 1 WHERE id = ?', [nowSec, id]);
        // Auto-disable once the streak crosses the threshold (best-effort; a separate UPDATE keeps it simple).
        await dbAsync.run('UPDATE webhooks SET active = 0 WHERE id = ? AND failure_count >= ?', [id, AUTO_DISABLE_AFTER]);
    }
}

module.exports = Webhook;
