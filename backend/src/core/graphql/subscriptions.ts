/**
 * WordJS - GraphQL subscriptions: GraphQL over Server-Sent Events, fed by the durable content outbox.
 *
 * WHY SSE AND NOT A WEBSOCKET PROTOCOL (graphql-ws). Every request in WordJS crosses the same chain —
 * host gate, CORS, rate limiter, CSRF, the MFA gate, the gateway in split/separate modes — and that chain is
 * HTTP. A subscription stream is one HTTP response (`text/event-stream`) behind all of it, authenticated by
 * the same cookie or Bearer token, proxied by the gateway exactly like the collaboration stream already is,
 * and resumable with the standard `Last-Event-ID` header. graphql-ws would need an upgrade path that skips
 * the Express middleware, its own authentication handshake and a gateway WebSocket route, for a feed that
 * only ever flows server → client. The wire format is the "distinct connections" mode of the GraphQL over
 * SSE protocol (`event: next` / `event: complete`), so off-the-shelf clients (graphql-sse) work.
 *
 * WHERE EVENTS COME FROM. Not from in-process hooks: on a multi-node install the write and the subscriber
 * may be on different nodes. The feed polls two committed, durable sources while it has listeners —
 *  · `content_outbox` (post.created / post.updated / post.deleted, written in the same transaction as the
 *    change, so a row exists only once the change committed), and
 *  · the `comments` table, for new comments.
 * Both are read by id with a small look-back window, so a row whose transaction committed out of id order
 * is still delivered once.
 *
 * AUTHORIZATION IS PER EVENT, AS THE SUBSCRIBER. The feed carries ids only. Before an event reaches a
 * subscriber, its subscription re-reads the entry through REST as the subscriber (GET /posts/:id,
 * GET /comments/:id — core/graphql/dispatch, a fresh read, never memoized), so it sees exactly what REST
 * would show that caller at that moment: an anonymous subscriber is told about published entries only, an
 * author about their own drafts, a token about what its scope may read. An entry that stops being visible
 * (trashed, unpublished, made private) is reported as DELETED with no body — and only to a subscriber that
 * had seen it in this stream (or named it in `ids:` and could read it then). An authenticated stream is
 * re-checked every RECHECK_MS (GET /users/me): a revoked token or an ended session closes it.
 */

import {
    GraphQLEnumType,
    GraphQLError,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLString,
} from 'graphql';
import type { GraphQLFieldConfig } from 'graphql';
import type { Request } from 'express';
import { CommentType, ContentNodeType } from './schema';
import type { GraphQLContext } from './schema';

const log = require('../module-logger').moduleLogger('core/graphql/subscriptions');

// ─── The feed ───────────────────────────────────────────────────────────────────────────────────────

export interface FeedEvent {
    /** Opaque resume cursor (`<contentOutboxId>.<commentId>`), sent as the SSE `id:`. */
    cursor: string;
    source: 'content' | 'comment';
    kind: 'CREATED' | 'UPDATED' | 'DELETED';
    id: number;
    previousStatus?: string | null;
}

type Listener = (e: FeedEvent) => void;

const tuning = {
    /** How often the feed polls while it has listeners. */
    pollMs: 1000,
    /** Rows re-read below the high-water mark, for transactions that committed out of id order. */
    lookBack: 50,
    /** Rows read per source per poll. */
    batch: 200,
    /** Most events replayed for a Last-Event-ID resume. */
    maxReplay: 500,
    /** How often an authenticated stream re-proves its credential. */
    recheckMs: 30_000,
};

/** Test seam: shorten the clocks. */
export function setFeedTuning(t: Partial<typeof tuning>): void {
    Object.assign(tuning, t);
}

function dbAsync() {
    return require('../../config/database').dbAsync;
}

function kindOf(eventType: string): FeedEvent['kind'] {
    return eventType === 'post.created' ? 'CREATED' : eventType === 'post.deleted' ? 'DELETED' : 'UPDATED';
}

function parsePrevious(payload: unknown): string | null {
    try {
        const p = JSON.parse(String(payload));
        return p && typeof p.previousStatus === 'string' ? p.previousStatus : null;
    } catch { return null; }
}

async function maxId(sql: string): Promise<number> {
    const row = await dbAsync().get(sql);
    const v = row ? Number(row.m ?? row.M ?? 0) : 0;
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

async function contentRowsAfter(after: number, limit: number): Promise<any[]> {
    return (await dbAsync().all(
        'SELECT id, event_type, aggregate_id, payload FROM content_outbox WHERE id > ? ORDER BY id ASC LIMIT ?',
        [after, limit],
    )) || [];
}

async function commentRowsAfter(after: number, limit: number): Promise<any[]> {
    return (await dbAsync().all(
        'SELECT comment_id FROM comments WHERE comment_id > ? ORDER BY comment_id ASC LIMIT ?',
        [after, limit],
    )) || [];
}

class SiteFeed {
    private readonly listeners = new Set<Listener>();
    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    /** High-water marks, and the ids already emitted inside the look-back window. */
    contentMark = 0;
    commentMark = 0;
    private readonly seenContent = new Set<number>();
    private readonly seenComment = new Set<number>();
    private ready: Promise<void> | null = null;

    constructor(private readonly siteId: number | null) {}

    private inSite<T>(fn: () => Promise<T>): Promise<T> {
        if (this.siteId === null) return fn();
        return require('../site-context').runWithSite(this.siteId, fn);
    }

    /** Start from "now": only changes committed after the first subscriber arrived are live events. */
    private start(): Promise<void> {
        if (!this.ready) {
            this.ready = this.inSite(async () => {
                this.contentMark = await maxId('SELECT MAX(id) AS m FROM content_outbox');
                this.commentMark = await maxId('SELECT MAX(comment_id) AS m FROM comments');
                // What already exists inside the look-back window is history, not a late commit.
                for (const row of await contentRowsAfter(Math.max(0, this.contentMark - tuning.lookBack), tuning.lookBack + 1)) {
                    if (Number(row.id) <= this.contentMark) this.seenContent.add(Number(row.id));
                }
                for (const row of await commentRowsAfter(Math.max(0, this.commentMark - tuning.lookBack), tuning.lookBack + 1)) {
                    if (Number(row.comment_id) <= this.commentMark) this.seenComment.add(Number(row.comment_id));
                }
            });
        }
        return this.ready;
    }

    cursor(): string {
        return `${this.contentMark}.${this.commentMark}`;
    }

    async add(listener: Listener): Promise<void> {
        await this.start();
        this.listeners.add(listener);
        if (!this.timer) {
            this.timer = setInterval(() => { this.poll().catch((e) => log.warn({ err: e }, '[graphql] subscription feed poll failed')); }, tuning.pollMs);
            if (this.timer.unref) this.timer.unref();
        }
    }

    remove(listener: Listener): void {
        this.listeners.delete(listener);
        if (!this.listeners.size && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            // The next subscriber starts from its own "now" again.
            this.ready = null;
            this.seenContent.clear();
            this.seenComment.clear();
        }
    }

    get size(): number { return this.listeners.size; }

    private emit(e: FeedEvent): void {
        for (const l of [...this.listeners]) {
            try { l(e); } catch { /* one subscriber cannot break the others */ }
        }
    }

    /** Note an emitted id; ids that fell out of the look-back window are forgotten. */
    private remember(seen: Set<number>, id: number, mark: number): void {
        seen.add(id);
        if (seen.size > tuning.lookBack * 4) {
            const floor = mark - tuning.lookBack * 2;
            for (const v of seen) if (v < floor) seen.delete(v);
        }
    }

    async poll(): Promise<void> {
        if (this.polling || !this.listeners.size) return;
        this.polling = true;
        try {
            await this.inSite(async () => {
                for (const row of await contentRowsAfter(Math.max(0, this.contentMark - tuning.lookBack), tuning.batch)) {
                    const id = Number(row.id);
                    if (this.seenContent.has(id) || id <= this.contentMark - tuning.lookBack) continue;
                    this.contentMark = Math.max(this.contentMark, id);
                    this.remember(this.seenContent, id, this.contentMark);
                    this.emit({
                        cursor: this.cursor(), source: 'content', kind: kindOf(String(row.event_type)),
                        id: Number(row.aggregate_id), previousStatus: parsePrevious(row.payload),
                    });
                }
                for (const row of await commentRowsAfter(Math.max(0, this.commentMark - tuning.lookBack), tuning.batch)) {
                    const id = Number(row.comment_id);
                    if (this.seenComment.has(id) || id <= this.commentMark - tuning.lookBack) continue;
                    this.commentMark = Math.max(this.commentMark, id);
                    this.remember(this.seenComment, id, this.commentMark);
                    this.emit({ cursor: this.cursor(), source: 'comment', kind: 'CREATED', id });
                }
            });
        } finally {
            this.polling = false;
        }
    }

    /** Events committed after `cursor` and up to the feed's current mark (a Last-Event-ID resume). */
    async replay(cursor: string): Promise<FeedEvent[]> {
        const m = /^(\d{1,15})\.(\d{1,15})$/.exec(String(cursor || ''));
        if (!m) return [];
        const fromContent = Number(m[1]);
        const fromComment = Number(m[2]);
        const out: FeedEvent[] = [];
        await this.inSite(async () => {
            let c = fromContent;
            let k = fromComment;
            for (const row of await contentRowsAfter(fromContent, tuning.maxReplay)) {
                const id = Number(row.id);
                if (id > this.contentMark) break;
                c = id;
                out.push({ cursor: `${c}.${k}`, source: 'content', kind: kindOf(String(row.event_type)), id: Number(row.aggregate_id), previousStatus: parsePrevious(row.payload) });
            }
            for (const row of await commentRowsAfter(fromComment, tuning.maxReplay)) {
                const id = Number(row.comment_id);
                if (id > this.commentMark) break;
                k = id;
                out.push({ cursor: `${c}.${k}`, source: 'comment', kind: 'CREATED', id });
            }
        });
        return out;
    }
}

const feeds = new Map<string, SiteFeed>();

function currentSite(): number | null {
    try { return require('../site-context').currentSiteIdOrNull(); } catch { return null; }
}

async function feedForCurrentSite(): Promise<SiteFeed> {
    const site = currentSite();
    const key = String(site ?? 'single');
    let feed = feeds.get(key);
    if (!feed) {
        feed = new SiteFeed(site);
        feeds.set(key, feed);
    }
    return feed;
}

/** Test seam: run one poll of every feed now, instead of waiting for the interval. */
export async function pollFeedsNow(): Promise<void> {
    for (const f of feeds.values()) await f.poll();
}

/** Open listeners across every feed (exposed for tests and diagnostics). */
export function openListenerCount(): number {
    let n = 0;
    for (const f of feeds.values()) n += f.size;
    return n;
}

// ─── One subscription: the feed, filtered and authorized as the subscriber ─────────────────────────

interface StreamOptions {
    lastEventId?: string | null;
}

/**
 * An async iterator of authorized events for one subscriber. `authorize` turns a raw feed event into the
 * payload to deliver, or null to drop it; it runs as the subscriber (core/graphql/dispatch).
 */
function subscriberStream<T>(
    ctx: GraphQLContext,
    authorize: (e: FeedEvent) => Promise<T | null>,
    opts: StreamOptions,
): AsyncGenerator<T> {
    const queue: FeedEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let failure: GraphQLError | null = null;
    let feed: SiteFeed | null = null;
    let recheck: NodeJS.Timeout | null = null;

    const listener: Listener = (e) => {
        if (queue.length >= 1000) queue.shift(); // a stalled reader keeps the newest 1000
        queue.push(e);
        if (wake) { const w = wake; wake = null; w(); }
    };
    const stop = () => {
        if (closed) return;
        closed = true;
        if (feed) feed.remove(listener);
        if (recheck) clearInterval(recheck);
        if (wake) { const w = wake; wake = null; w(); }
    };

    const authenticated = hasCredential(ctx.req);
    const ensureCredential = async () => {
        if (!authenticated || closed) return;
        const { restGet } = require('./dispatch');
        const r = await restGet(ctx.req, '/users/me');
        if (r.status !== 200) {
            failure = new GraphQLError('The credential this subscription was opened with no longer authenticates.', {
                extensions: { code: (r.body && r.body.code) || 'rest_not_logged_in', status: r.status },
            });
            stop();
        }
    };

    async function* run(): AsyncGenerator<T> {
        feed = await feedForCurrentSite();
        await feed.add(listener);
        if (opts.lastEventId) for (const e of await feed.replay(opts.lastEventId)) queue.push(e);
        if (authenticated) {
            recheck = setInterval(() => { ensureCredential().catch(() => stop()); }, tuning.recheckMs);
            if (recheck.unref) recheck.unref();
        }
        try {
            while (!closed) {
                const e = queue.shift();
                if (!e) {
                    await new Promise<void>((resolve) => { wake = resolve; });
                    continue;
                }
                const payload = await authorize(e);
                if (payload !== null && !closed) {
                    // The transport sends this as the SSE id, whether or not the client selected `cursor`.
                    (ctx as any).lastCursor = e.cursor;
                    yield payload;
                }
            }
            if (failure) throw failure;
        } finally {
            stop();
        }
    }

    const it = run();
    const ret = it.return.bind(it);
    // A consumer's return() must also unblock a reader parked on an empty queue.
    (it as any).return = (v?: any) => { stop(); return ret(v); };
    return it;
}

function hasCredential(req: Request): boolean {
    try { if (require('../../middleware/auth').bearerToken(req)) return true; } catch { /* unreadable header: the cookie check below decides */ }
    try { return !!require('../../middleware/auth').SESSION_COOKIE && !!(req.cookies && req.cookies[require('../../middleware/auth').SESSION_COOKIE]); }
    catch { return false; }
}

/** A fresh REST read as the subscriber — never the per-request memo, which would serve the state of an earlier event. */
async function readAs(ctx: GraphQLContext, path: string) {
    const { restGet, createRestClient } = require('./dispatch');
    const r = await restGet(ctx.req, path);
    // Nested fields of the delivered node (parent, comments, revisions) also read the current state.
    ctx.rest = createRestClient(ctx.req);
    return r;
}

// ─── Schema ─────────────────────────────────────────────────────────────────────────────────────────

export const ContentEventKindType = new GraphQLEnumType({
    name: 'ContentEventKind',
    values: {
        CREATED: { value: 'CREATED' },
        UPDATED: { value: 'UPDATED' },
        DELETED: { value: 'DELETED', description: 'Deleted, or no longer visible to this subscriber (trashed, unpublished, made private).' },
    },
});

export const ContentEventType = new GraphQLObjectType({
    name: 'ContentEvent',
    fields: {
        kind: { type: new GraphQLNonNull(ContentEventKindType) },
        id: { type: new GraphQLNonNull(GraphQLInt), description: 'The entry id.' },
        node: { type: ContentNodeType, description: 'The entry as GET /posts/:id answers the subscriber now; null for DELETED.' },
        cursor: { type: new GraphQLNonNull(GraphQLString), description: 'Resume point (also sent as the SSE id).' },
    },
});

export const CommentEventType = new GraphQLObjectType({
    name: 'CommentEvent',
    fields: {
        comment: { type: new GraphQLNonNull(CommentType), description: 'The comment as GET /comments/:id answers the subscriber.' },
        cursor: { type: new GraphQLNonNull(GraphQLString) },
    },
});

const MAX_WATCHED_IDS = 100;

type Field = GraphQLFieldConfig<any, GraphQLContext>;

export function buildSubscriptionFields(): Record<string, Field> {
    return {
        contentChanged: {
            type: new GraphQLNonNull(ContentEventType),
            description: 'Entries created, updated or deleted — each one re-authorized as the subscriber before it is sent.',
            args: {
                types: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)), description: 'Only these post types (default: all).' },
                kinds: { type: new GraphQLList(new GraphQLNonNull(ContentEventKindType)), description: 'Only these kinds (default: all).' },
                ids: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)), description: `Only these entries (at most ${MAX_WATCHED_IDS}); each must be readable now to be watched.` },
            },
            extensions: { cost: { rest: true } },
            subscribe: async (_root, args, ctx) => {
                const types: Set<string> | null = Array.isArray(args.types) && args.types.length ? new Set(args.types) : null;
                const kinds: Set<string> | null = Array.isArray(args.kinds) && args.kinds.length ? new Set(args.kinds) : null;
                const ids: Set<number> | null = Array.isArray(args.ids) && args.ids.length ? new Set(args.ids) : null;
                if (ids && ids.size > MAX_WATCHED_IDS) {
                    throw new GraphQLError(`"ids" may name at most ${MAX_WATCHED_IDS} entries.`, { extensions: { code: 'BAD_USER_INPUT' } });
                }
                // What this subscriber has been shown (or could read when it named it): the only entries
                // whose disappearance it is told about.
                const visible = new Set<number>();
                if (ids) {
                    const { restGet } = require('./dispatch');
                    for (const id of ids) {
                        const r = await restGet(ctx.req, `/posts/${id}`);
                        if (r.status === 200 && (!types || types.has(r.body && r.body.type))) visible.add(id);
                    }
                }
                const authorize = async (e: FeedEvent) => {
                    if (e.source !== 'content') return null;
                    if (ids && !ids.has(e.id)) return null;
                    const gone = () => {
                        if (!visible.has(e.id)) return null;
                        visible.delete(e.id);
                        if (kinds && !kinds.has('DELETED')) return null;
                        return { kind: 'DELETED', id: e.id, node: null, cursor: e.cursor };
                    };
                    if (e.kind === 'DELETED') return gone();
                    const r = await readAs(ctx, `/posts/${e.id}`);
                    if (r.status === 404) return gone();
                    if (r.status !== 200) {
                        throw new GraphQLError('The subscriber may no longer read content.', {
                            extensions: { code: (r.body && r.body.code) || 'REST_ERROR', status: r.status },
                        });
                    }
                    const node = r.body;
                    if (types && !types.has(node && node.type)) return null;
                    const wasVisible = visible.has(e.id);
                    visible.add(e.id);
                    // An entry that just became visible to this subscriber (published, shared) is new to it.
                    const kind = e.kind === 'UPDATED' && !wasVisible ? 'CREATED' : e.kind;
                    if (kinds && !kinds.has(kind)) return null;
                    return { kind, id: e.id, node, cursor: e.cursor };
                };
                return subscriberStream(ctx, authorize, { lastEventId: (ctx as any).lastEventId });
            },
            resolve: (payload) => payload,
        },
        commentAdded: {
            type: new GraphQLNonNull(CommentEventType),
            description: 'New comments the subscriber may read (GET /comments/:id as the subscriber: approved ones, on entries it can see).',
            args: { postId: { type: GraphQLInt, description: 'Only comments on this entry.' } },
            extensions: { cost: { rest: true } },
            subscribe: async (_root, args, ctx) => {
                const authorize = async (e: FeedEvent) => {
                    if (e.source !== 'comment') return null;
                    const r = await readAs(ctx, `/comments/${e.id}`);
                    if (r.status !== 200) return null;
                    if (args.postId != null && Number(r.body && r.body.postId) !== args.postId) return null;
                    return { comment: r.body, cursor: e.cursor };
                };
                return subscriberStream(ctx, authorize, { lastEventId: (ctx as any).lastEventId });
            },
            resolve: (payload) => payload,
        },
    };
}
