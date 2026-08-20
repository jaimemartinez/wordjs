/**
 * WordJS - WebhookDelivery model. This table IS the durable delivery queue + audit log for outgoing
 * webhooks (it survives a process restart — retry state is never held only in memory).
 *
 * Concurrency across nodes is handled WITHOUT a distributed lock by a single-statement atomic CLAIM
 * (`claim`): the claiming UPDATE both flips status→'delivering' AND pushes next_attempt_at into the
 * future (a lease), guarded by `status IN (...) AND next_attempt_at <= now`. A racing node running the
 * same guarded UPDATE therefore matches 0 rows. If a node crashes mid-delivery, the lease expires and the
 * poller reclaims the stale 'delivering' row. All logic timestamps are epoch SECONDS (INTEGER).
 */

const { dbAsync } = require('../config/database');

// Terminal + transient states.
const STATUS = { PENDING: 'pending', DELIVERING: 'delivering', SUCCESS: 'success', DEAD: 'dead' };

function toDisplay(row: any) {
    return {
        id: row.id,
        webhookId: row.webhook_id,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        responseStatus: row.response_status != null ? Number(row.response_status) : null,
        error: row.error || null,
        nextAttemptAt: row.next_attempt_at != null ? Number(row.next_attempt_at) : null,
        deliveredAt: row.delivered_at != null ? Number(row.delivered_at) : null,
        createdAt: row.created_at,
        payload: row.payload
    };
}

class WebhookDelivery {
    static STATUS = STATUS;

    /** Enqueue a delivery, due immediately (next_attempt_at = now). Returns the new delivery id. */
    static async enqueue(webhookId: number, event: string, payload: string, nowSec: number, sourceEventId: string | null = null): Promise<number> {
        const result = await dbAsync.run(
            `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, attempts, next_attempt_at, source_event_id)
             VALUES (?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
            [webhookId, event, payload, nowSec, sourceEventId]
        );
        const changed = Number(result.changes ?? result.rowCount ?? 0);
        return changed > 0 ? Number(result.lastID || 0) : 0;
    }

    /** Ids of deliveries due to run now (pending, or a 'delivering' whose lease has expired). */
    static async dueIds(nowSec: number, limit: number): Promise<number[]> {
        const rows = await dbAsync.all(
            `SELECT id FROM webhook_deliveries
             WHERE status IN ('pending','delivering') AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC LIMIT ?`,
            [nowSec, limit]
        );
        return (rows || []).map((r: any) => r.id);
    }

    /**
     * Atomically claim a delivery for THIS worker: flip to 'delivering', bump attempts, and set the lease
     * (next_attempt_at = leaseUntil, in the future) so no one else picks it up. Returns true iff we won.
     * `leaseUntil` doubles as the claim TOKEN — the outcome writers below require it to still be the row's
     * next_attempt_at, so a worker that lost its lease (was re-claimed) can never clobber the winner.
     */
    static async claim(id: number, nowSec: number, leaseUntil: number): Promise<boolean> {
        const result = await dbAsync.run(
            `UPDATE webhook_deliveries SET status = 'delivering', attempts = attempts + 1, next_attempt_at = ?
             WHERE id = ? AND status IN ('pending','delivering') AND next_attempt_at <= ?`,
            [leaseUntil, id, nowSec]
        );
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    static async get(id: number) {
        const row = await dbAsync.get('SELECT * FROM webhook_deliveries WHERE id = ?', [id]);
        return row ? toDisplay(row) : null;
    }

    // Outcome writers are LEASE-OWNED: `WHERE ... status='delivering' AND next_attempt_at=<leaseToken>`,
    // so only the worker still holding the lease can finalize the row.
    static async markSuccess(id: number, leaseToken: number, responseStatus: number | null, nowSec: number): Promise<void> {
        await dbAsync.run(
            `UPDATE webhook_deliveries SET status = 'success', response_status = ?, delivered_at = ?, error = NULL
             WHERE id = ? AND status = 'delivering' AND next_attempt_at = ?`,
            [responseStatus, nowSec, id, leaseToken]
        );
    }

    /** Schedule the next retry (stays 'pending'). Lease-owned. */
    static async reschedule(id: number, leaseToken: number, nextAttemptAtSec: number, responseStatus: number | null, error: string | null): Promise<void> {
        await dbAsync.run(
            `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, response_status = ?, error = ?
             WHERE id = ? AND status = 'delivering' AND next_attempt_at = ?`,
            [nextAttemptAtSec, responseStatus, error ? String(error).slice(0, 500) : null, id, leaseToken]
        );
    }

    /** Give up permanently (max attempts exhausted). Lease-owned. */
    static async markDead(id: number, leaseToken: number, responseStatus: number | null, error: string | null): Promise<void> {
        await dbAsync.run(
            `UPDATE webhook_deliveries SET status = 'dead', response_status = ?, error = ?
             WHERE id = ? AND status = 'delivering' AND next_attempt_at = ?`,
            [responseStatus, error ? String(error).slice(0, 500) : null, id, leaseToken]
        );
    }

    /**
     * Admin "redeliver": reset a TERMINAL delivery back to pending+due-now with a fresh attempt count.
     * Guarded to terminal rows only so it can never reset a delivery underneath a worker holding its lease
     * (an in-flight or missing row yields 0 changes → the route returns 404).
     */
    static async requeue(id: number, nowSec: number): Promise<boolean> {
        const result = await dbAsync.run(
            `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, error = NULL, response_status = NULL, delivered_at = NULL
             WHERE id = ? AND status IN ('dead','success')`,
            [nowSec, id]
        );
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    static async listForWebhook(webhookId: number, limit = 50) {
        const rows = await dbAsync.all(
            'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?',
            [webhookId, limit]
        );
        return (rows || []).map(toDisplay);
    }
}

module.exports = WebhookDelivery;
