/**
 * WordJS F3 — transactional content unit-of-work + durable outbox.
 *
 * A ContentMutation spans every relational write that represents one logical content change. The
 * database proxy propagates one pinned connection through AsyncLocalStorage, so historical model
 * helpers transparently join this transaction. Semantic events are collected in memory, inserted in
 * `content_outbox` before COMMIT, and dispatched only after COMMIT. Delivery is at-least-once: a
 * worker crash expires its lease and another node retries the same immutable event_id.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
const database = require('../config/database');
const { dbAsync } = database;

const EVENT_TYPES = new Set(['post.created', 'post.updated', 'post.deleted']);
const STATUS = Object.freeze({ PENDING: 'pending', PROCESSING: 'processing', PROCESSED: 'processed', DEAD: 'dead' });
const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 60;
const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 50;
const PROCESSED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const PRUNE_INTERVAL_SECONDS = 60 * 60;
const PRUNE_BATCH_SIZE = 500;
// The public JSON body limit is 10 MiB. Keep enough headroom for the event envelope without allowing
// an internal caller to turn the outbox into an unbounded serialization sink.
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024 + 64 * 1024;

type ContentEventType = 'post.created' | 'post.updated' | 'post.deleted';
type ContentEvent = {
    eventId: string;
    eventType: ContentEventType;
    aggregateId: number;
    payload: Record<string, any>;
};
type MutationScope = { events: ContentEvent[]; active: boolean };

const mutationScope: {
    getStore: () => MutationScope | undefined;
    run: <T>(store: MutationScope, callback: () => T) => T;
} = new AsyncLocalStorage();
const deliveryScope: {
    getStore: () => { eventId: string } | undefined;
    run: <T>(store: { eventId: string }, callback: () => T) => T;
} = new AsyncLocalStorage();
/**
 * One shared clock for multi-node leases. This deliberately fails closed: falling back to the
 * process clock after a database-clock failure would let a skewed node reclaim another worker's
 * live lease. The pump/health callers already surface and retry an unavailable database.
 */
async function databaseNowSeconds(): Promise<number> {
    const type = database.getDbType();
    const expression = type.isPostgres
        ? 'FLOOR(EXTRACT(EPOCH FROM now()))'
        : type.isMySQL
            ? 'CAST(UNIX_TIMESTAMP(NOW()) AS SIGNED)'
            : "CAST(strftime('%s', 'now') AS INTEGER)";
    const row = await dbAsync.get(`SELECT ${expression} AS now_seconds`);
    const value = Number(row?.now_seconds ?? row?.NOW_SECONDS);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Database clock returned an invalid epoch value');
    }
    return value;
}

function isContentMutationActive(): boolean {
    return mutationScope.getStore()?.active === true;
}

function currentContentEventId(): string | null {
    return deliveryScope.getStore()?.eventId || null;
}

function assertEvent(eventType: string, aggregateId: number, payload: unknown): void {
    if (!EVENT_TYPES.has(eventType)) throw new Error(`Unsupported content outbox event '${eventType}'`);
    if (!Number.isSafeInteger(aggregateId) || aggregateId <= 0) throw new Error('Content outbox aggregate id must be a positive integer');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Content outbox payload must be an object');
}

/** Record one immutable semantic event. It is a programming error to call this outside a mutation. */
function recordContentEvent(eventType: ContentEventType, aggregateId: number, payload: Record<string, any>): string {
    const scope = mutationScope.getStore();
    if (!scope?.active) throw new Error('recordContentEvent() requires runContentMutation()');
    assertEvent(eventType, aggregateId, payload);
    const eventId = randomUUID();
    // Serialize now as validation: circular structures, BigInt and payload amplification abort the
    // same transaction instead of producing an event that the worker can never decode.
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error(`Content outbox payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    scope.events.push({ eventId, eventType, aggregateId, payload: JSON.parse(encoded) });
    return eventId;
}

/**
 * Run one logical content change. Nested calls join the outer mutation; the outermost call owns the
 * transaction, persists every event and registers the post-commit delivery kick.
 */
async function runContentMutation<T>(work: () => Promise<T>): Promise<T> {
    if (mutationScope.getStore()?.active) return await work();

    return await dbAsync.transaction(async () => {
        const scope: MutationScope = { events: [], active: true };
        return await mutationScope.run(scope, async () => {
            try {
                const result = await work();
                const ids: number[] = [];
                const availableAt = scope.events.length ? await databaseNowSeconds() : 0;
                for (const event of scope.events) {
                    const encoded = JSON.stringify(event.payload);
                    const inserted = await dbAsync.run(
                        `INSERT INTO content_outbox
                         (event_id, event_type, aggregate_id, payload, status, attempts, available_at)
                         VALUES (?, ?, ?, ?, 'pending', 0, ?) RETURNING id`,
                        [event.eventId, event.eventType, event.aggregateId, encoded, availableAt]
                    );
                    ids.push(Number(inserted.lastID));
                }
                if (ids.length) {
                    // This callback is attached to the database transaction, not merely to this helper.
                    // If runContentMutation joins a caller-owned transaction it therefore cannot dispatch
                    // early; the kick runs only when that outer transaction actually commits.
                    database.afterCommit(async () => { await dispatchIds(ids); });
                }
                return result;
            } finally {
                // Detached async resources inherit this store. Closing it prevents a later write from
                // appending to an event array whose transaction has already committed.
                scope.active = false;
            }
        });
    });
}

function backoffSeconds(attempts: number): number {
    return Math.min(3600, 2 ** Math.min(12, Math.max(1, attempts)));
}

async function dueIds(now: number, limit = BATCH_SIZE): Promise<number[]> {
    const rows = await dbAsync.all(
        `SELECT id FROM content_outbox
         WHERE (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND claimed_until <= ?)
         ORDER BY id ASC LIMIT ?`,
        [now, now, limit]
    );
    return (rows || []).map((row: any) => Number(row.id));
}

async function claim(id: number, now: number, token: string, leaseUntil: number): Promise<boolean> {
    const result = await dbAsync.run(
        `UPDATE content_outbox
         SET status = 'processing', attempts = attempts + 1, claim_token = ?, claimed_until = ?
         WHERE id = ? AND (
             (status = 'pending' AND available_at <= ?)
             OR (status = 'processing' AND claimed_until <= ?)
         )`,
        [token, leaseUntil, id, now, now]
    );
    return !!(result && Number(result.changes ?? result.rowCount ?? 0) > 0);
}

async function invalidatePostEvent(eventType: string, aggregateId: number, payload: any): Promise<void> {
    const cache = require('./cache');
    const Post = require('../models/Post');
    const keys = new Set<string>([`post:id:${aggregateId}`]);
    const addSlug = (type: unknown, slug: unknown) => {
        if (typeof slug !== 'string' || !slug) return;
        keys.add(`post:slug:${typeof type === 'string' && type ? type : 'post'}:${slug}`);
        keys.add(`post:slug:any:${slug}`);
    };
    addSlug(payload?.previousType, payload?.previousSlug);
    const current = eventType === 'post.deleted'
        ? null
        : await dbAsync.get('SELECT post_type, post_name FROM posts WHERE id = ?', [aggregateId]);
    if (current) addSlug(current.post_type, current.post_name);
    for (const key of keys) await cache.del(key);
    Post._invalidateCounts();
}

async function dispatchEvent(row: any): Promise<void> {
    const eventType = String(row.event_type || '');
    const aggregateId = Number(row.aggregate_id);
    let payload: any;
    try { payload = JSON.parse(String(row.payload)); }
    catch { throw new Error('Content outbox payload is not valid JSON'); }
    assertEvent(eventType, aggregateId, payload);

    const eventId = String(row.event_id || '');
    if (!eventId) throw new Error('Content outbox event_id is missing');
    await deliveryScope.run({ eventId }, async () => {
        await invalidatePostEvent(eventType, aggregateId, payload);
        const { doAction } = require('./hooks');
        if (eventType === 'post.created') {
            await doAction('wp_insert_post', aggregateId, payload.data || {});
        } else if (eventType === 'post.updated') {
            await doAction('post_updated', aggregateId, payload.data || {}, payload.previousStatus);
        } else {
            await doAction('deleted_post', aggregateId, payload.previousStatus);
        }
    });
}

/** Claim and deliver one row. Failures stay durable and never throw into the committed request. */
async function dispatchOne(id: number): Promise<boolean> {
    const now = await databaseNowSeconds();
    const token = randomUUID();
    const leaseUntil = now + LEASE_SECONDS;
    if (!(await claim(id, now, token, leaseUntil))) return false;

    const row = await dbAsync.get(
        `SELECT * FROM content_outbox WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        [id, token]
    );
    if (!row) return false;

    try {
        await dispatchEvent(row);
        await dbAsync.run(
            `UPDATE content_outbox
             SET status = 'processed', processed_at = ?, claim_token = NULL, claimed_until = NULL, last_error = NULL
             WHERE id = ? AND status = 'processing' AND claim_token = ?`,
            [await databaseNowSeconds(), id, token]
        );
        return true;
    } catch (error: any) {
        const attempts = Number(row.attempts || 0);
        const message = String(error?.message || error || 'unknown content event failure').slice(0, 1000);
        if (attempts >= MAX_ATTEMPTS) {
            await dbAsync.run(
                `UPDATE content_outbox
                 SET status = 'dead', claim_token = NULL, claimed_until = NULL, last_error = ?
                 WHERE id = ? AND status = 'processing' AND claim_token = ?`,
                [message, id, token]
            );
            console.error(`[content-outbox] event ${row.event_id} is DEAD after ${attempts} attempts: ${message}`);
        } else {
            await dbAsync.run(
                `UPDATE content_outbox
                 SET status = 'pending', available_at = ?, claim_token = NULL, claimed_until = NULL, last_error = ?
                 WHERE id = ? AND status = 'processing' AND claim_token = ?`,
                [(await databaseNowSeconds()) + backoffSeconds(attempts), message, id, token]
            );
        }
        return false;
    }
}

async function dispatchIds(ids: number[]): Promise<void> {
    for (const id of ids) {
        if (Number.isSafeInteger(id) && id > 0) await dispatchOne(id);
    }
}

/**
 * Bound successful-event storage without deleting retryable or dead-letter evidence. Select first,
 * then delete explicit ids: this is portable to MySQL, which rejects LIMIT in a self-select DELETE.
 */
async function pruneProcessed(
    now: number | null = null,
    retentionSeconds = PROCESSED_RETENTION_SECONDS,
    limit = PRUNE_BATCH_SIZE
): Promise<number> {
    const referenceNow = now == null ? await databaseNowSeconds() : Math.floor(now);
    const safeRetention = Math.max(0, Math.floor(Number(retentionSeconds) || 0));
    const safeLimit = Math.max(1, Math.min(PRUNE_BATCH_SIZE, Math.floor(Number(limit) || PRUNE_BATCH_SIZE)));
    const rows = await dbAsync.all(
        `SELECT id FROM content_outbox
         WHERE status = 'processed' AND processed_at IS NOT NULL AND processed_at <= ?
         ORDER BY id ASC LIMIT ?`,
        [referenceNow - safeRetention, safeLimit]
    );
    const ids = (rows || [])
        .map((row: any) => Number(row.id))
        .filter((id: number) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = await dbAsync.run(
        `DELETE FROM content_outbox WHERE status = 'processed' AND id IN (${placeholders})`,
        ids
    );
    return Number(result?.changes ?? result?.rowCount ?? 0);
}

let pumping = false;
let lastPruneAt = 0;
async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
        const now = await databaseNowSeconds();
        await dispatchIds(await dueIds(now));
        if (now - lastPruneAt >= PRUNE_INTERVAL_SECONDS) {
            // Advance before the query so a broken table/connection cannot produce a 2-second error
            // storm. The next hourly pass retries and health still exposes the database failure.
            lastPruneAt = now;
            await pruneProcessed(now);
        }
    }
    catch (error: any) { console.warn(`[content-outbox] pump failed: ${error?.message || error}`); }
    finally { pumping = false; }
}

let pollTimer: any = null;
function startPoller(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { pump().catch(() => {}); }, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref();
}
function stopPoller(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}
function initContentOutbox(options: { startPoller?: boolean } = {}): void {
    if (options.startPoller !== false) startPoller();
    setImmediate(() => { pump().catch(() => {}); });
}

module.exports = {
    STATUS,
    MAX_ATTEMPTS,
    LEASE_SECONDS,
    PROCESSED_RETENTION_SECONDS,
    databaseNowSeconds,
    runContentMutation,
    recordContentEvent,
    isContentMutationActive,
    currentContentEventId,
    dueIds,
    claim,
    dispatchOne,
    dispatchIds,
    pruneProcessed,
    pump,
    startPoller,
    stopPoller,
    initContentOutbox,
};
