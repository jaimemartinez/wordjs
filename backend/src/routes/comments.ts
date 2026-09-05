/**
 * WordJS - Comments Routes
 * /api/v1/comments/*
 */

import type { NextFunction, Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params. A parameter this router declares scalar arrives
// once, as a string, or the request is a 400 (the same answer routes/posts.ts already gives).
const { scalarQueryParam, requireScalarQuery, requireRouteId } = require('../core/query-params');
const { stripTags, escUrl, sanitizeContent, currentTime, currentTimeGMT } = require('../core/formatting');
// THE COMMENT ABUSE POSTURE (see the block below the query-field table) needs three more things: the
// limiter constructor, the one honest per-request IP every limiter on this server keys on, and the
// filter an anti-spam plugin hooks so it can veto an insert without a core change.
const rateLimit = require('express-rate-limit');
const { clientIp } = require('../core/client-ip');
const { applyFilters } = require('../core/hooks');
// Two reads the model does not offer and that this router must not fake: the id a real insert would
// take (so a discarded comment answers with a plausible one) and the CALLER'S OWN recent comments on
// a post (Comment.findAll can filter by user, but not by the author IP a guest is identified by).
const { dbAsync } = require('../config/database');
const crypto = require('crypto');

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is a comment id: `/comments/abc` reached
// Comment.findById as NaN (directly on get/put/delete, through Comment.update on approve/spam) and
// was bound into `WHERE comment_id = ?` — a 500 on Postgres/MySQL, and GET is anonymous. Declared for
// the whole router so approve/spam, which reach the sink through the model, are covered by the same
// statement as the routes that call findById themselves.
router.param('id', requireRouteId({ code: 'rest_comment_invalid_id', message: 'Invalid comment ID.' }));

// Shared, length-capped email validator (the one shape rule) — guards against ReDoS on unbounded input.
const { isValidAddress } = require('../core/mailbox');

/**
 * Validate a guest-supplied author URL: only http/https are permitted, and the value must be a
 * well-formed absolute URL. escUrl returns '' for anything else (javascript:, data:, mailto:, etc.).
 */
function safeAuthorUrl(raw: any) {
    if (!raw) return '';
    const cleaned = escUrl(String(raw).trim());
    if (!cleaned) return '';
    try {
        const proto = new URL(cleaned).protocol;
        return (proto === 'http:' || proto === 'https:') ? cleaned : '';
    } catch {
        return '';
    }
}

/**
 * Every query parameter GET /comments reads. Each one is a scalar in this API's contract, so each one
 * must arrive as a single string — see core/query-params for why a repeat is refused rather than
 * resolved. Listed as a table, and checked in one place, so that a parameter added to the handler and
 * not to this list shows up in the diff instead of becoming the next silent branch flip.
 * (Mirrors LIST_QUERY_STRING_FIELDS in routes/posts.ts, which is the same rule for that router.)
 */
const COMMENT_LIST_QUERY_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'post', 'status', 'parent', 'search', 'orderby', 'order',
]);

/* ==================================================================================================
 * THE COMMENT ABUSE POSTURE
 *
 * POST /comments is anonymous by default — `optionalAuth`, and `comment_registration` is '0' until an
 * operator turns it on — and it writes a PERMANENT row per call. Its only ceiling used to be the
 * GLOBAL apiLimiter (1000 requests / 15 min per IP), while the two sibling public write surfaces are
 * roughly a hundred times tighter (POST /forms/submit is 10/min, POST /analytics/track 60/min). The
 * one endpoint a spam bot actually wants was therefore the loosest door on the server, with human
 * moderation as the only defence. The layers below are the same four routes/forms.ts already applies,
 * in the same order and with the same field name, so a site has ONE convention and not two:
 *
 *   1. a dedicated per-IP limiter (createCommentLimiter) — 5 comments / 10 min anonymous,
 *      COMMENT_RATE_MAX_AUTH / 10 min once a caller is identified;
 *   2. a HARD input bound (MAX_COMMENT_BYTES) checked with the validation the route already did, i.e.
 *      BEFORE the honeypot, so a bot sees byte-identical behaviour whether or not it tripped the trap;
 *   3. the repeat guard (same author, same post, same body, inside DUPLICATE_WINDOW_MS) — also BEFORE
 *      the trap, for the same reason;
 *   4. the `_hp` honeypot (non-empty ⇒ the success payload, and nothing stored) and the
 *      `comments:pre_insert` filter, which is where an Akismet/Turnstile plugin plugs in and which
 *      discards through that same payload.
 *
 * THE DISCARD IS NOT AN ORACLE — WHICH TOOK MORE THAN ORDERING THE LAYERS. A trap a bot can identify
 * in one probe is not a trap: it learns the field name, omits it for ever, and takes layer 4 and the
 * plugin veto with it. Two tells had to go, and both were about a value the honest branch had and the
 * discarded one did not:
 *   · THE ROW ID. The fake payload carried `comment_id: 0` while an accepted one carries `id >= 1`,
 *     and `Comment.toJSON()` publishes it — one request, no comparison needed. It now carries an id
 *     drawn from a per-process mark that is kept ahead of the table and CLIMBS on every discard, so a
 *     pair of trapped posts advances exactly as a pair of accepted ones does — plain `MAX + 1` gave
 *     two different bodies the same id, which is a pair the honest path cannot produce (see
 *     discardedComment).
 *   · THE SECOND ATTEMPT. The trap used to return BEFORE the repeat guard, so the same body twice
 *     answered 201/409 when honest and 201/201 when trapped. Ordering the guard first is only half of
 *     that: the honest path is refused because its first comment is IN THE TABLE, and a discarded one
 *     never got there. So the guard also consults a small, bounded in-process memory of what was
 *     discarded inside the same window (see rememberDiscard) — the table cannot answer for a row it
 *     never saw, and "we stored nothing" must not be observable as "we forgot".
 * What remains different is persistence itself, which is the point of the trap and is not visible in
 * any response.
 *
 * WHERE THE LIMITER IS MOUNTED, AND WHY IT IS NOT index.ts LIKE ITS SIBLINGS. Two reasons, both
 * structural rather than stylistic:
 *   · The F0 REST inventory (backend/scripts/verify-f0-baseline.ts) reads every `app.<method>(path)`
 *     and `router.<method>(path)` declaration in routes/ AND index.ts. A second
 *     `app.post('${prefix}/comments', …)` mount in index.ts is a NEW endpoint declaration in that
 *     inventory — restSource.endpointDeclarations and its hash both move — so the limiter cannot be
 *     mounted there without re-cutting f0-baseline.json. Hanging it on the `router.post('/')` this
 *     file already declares changes no declaration at all.
 *   · An app-level mount runs BEFORE the router's `optionalAuth`, so `req.user` is undefined there and
 *     the authenticated tier would be a branch that never runs (a prefix mount would also charge the
 *     moderator's POST /comments/:id/approve to the public write budget). Here the limiter sits right
 *     after `optionalAuth` on the one mutating route, so the tier is resolved from a real identity.
 * index.ts still owns the multi-node decision: it hands over the SHARED Redis store through
 * useCommentLimiterStore() next to where it builds the store for every other limiter.
 * ================================================================================================ */

const COMMENT_RATE_WINDOW_MS = 10 * 60 * 1000;
// An anonymous poster is a stranger with a permanent row; five in ten minutes is far more than any
// human reader produces and far less than a bot needs.
const COMMENT_RATE_MAX_ANON = 5;
// An identified caller signs every row with a user id and is reachable by moderation, so the cap only
// has to stop a runaway client — not a stranger.
const COMMENT_RATE_MAX_AUTH = 30;

// …AND THE OPERATOR CAN MOVE THEM WITHOUT EDITING THIS FILE. The two numbers above are DEFAULTS, not
// the policy. Five per ten minutes is 0.5/min against POST /forms/submit's 10/min, and the anonymous
// bucket is per IP — so on CGNAT, on an office NAT, or on a monolith behind a proxy the operator has
// not marked trusted (where the TCP peer is 127.0.0.1 for every visitor), the sixth distinct human
// commenter in ten minutes is refused, and on an upgrade that starts happening silently. index.ts:245
// moved apiLimiter's numbers into `config.api.rateLimit` for exactly this reason; this limiter is
// declared in the router rather than in index.ts (see above), so its knob is an OPTION instead — read
// at request time, so a raise takes effect without a restart.
const COMMENT_RATE_OPTION_ANON = 'comment_rate_anon';
const COMMENT_RATE_OPTION_AUTH = 'comment_rate_auth';
/** An operator may raise the ceiling; they may not turn the limiter into a formality. */
const COMMENT_RATE_CAP_MAX = 1000;

/**
 * The cap in force for this tier: the operator's option when there is a usable one, the default
 * otherwise. CLAMPED rather than trusted — 0, a negative or a typo'd 1e9 are all "no limiter", which
 * is not a ceiling anyone can have meant to type — and it never throws: an unreachable options table
 * must leave the door narrower, not open.
 */
async function commentRateCap(option: string, fallback: number): Promise<number> {
    try {
        const raw = await getOption(option, null);
        if (raw === null || raw === undefined || raw === '') return fallback;
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(n, 1), COMMENT_RATE_CAP_MAX);
    } catch {
        return fallback;
    }
}

// The SAME hidden-field name routes/forms.ts traps on (HONEYPOT_FIELD there). One convention per site:
// a second spelling would mean the block that renders a comment form and the block that renders a
// contact form disagree about what "the honeypot" is called.
const HONEYPOT_FIELD = '_hp';

// The repeat window. A bot that re-posts the same body is the cheapest spam there is, and a human who
// double-submits the same comment (impatient click, flaky network) wants exactly the same answer.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
// How far back the repeat check reads over the CALLER'S OWN comments on the post — not the post's, which
// is what made the old justification false: the limiter bounds one identity to a handful of comments per
// window, but a scan of the newest 25 rows across ALL authors loses the caller's own row as soon as the
// thread is busier than that, and the guard then stops firing silently (fail-open).
const DUPLICATE_SCAN_LIMIT = 25;

// The hard body bound. `comment_content` is declared TEXT and the MySQL migration rewrites TEXT to
// LONGTEXT, so the SCHEMA is not the binding constraint here — this is the policy one, and it is the
// same 64KB ceiling routes/forms.ts puts on a whole public submission. Counted in BYTES: a character
// cap would let a multibyte body land far above the number it advertises.
const MAX_COMMENT_BYTES = 64 * 1024;

/**
 * The one extension point an anti-spam / captcha add-on needs. A plugin registers
 * `addFilter('comments:pre_insert', fn)`; `fn` receives `true` plus a plain description of the comment
 * about to be written and may:
 *   · return `false` — the comment is discarded exactly as a tripped honeypot is (the caller is told
 *     nothing, which is the whole point of a spam verdict); or
 *   · throw — the error travels the ordinary asyncHandler path, so a captcha plugin that wants a
 *     VISIBLE refusal (its own status and `rest_*` code) simply throws one; or
 *   · return anything else — the insert proceeds.
 * The context is a plain object on purpose: an isolated plugin receives it across a process boundary,
 * and `req` does not survive that trip.
 */
const COMMENT_PRE_INSERT_FILTER = 'comments:pre_insert';

/**
 * Build the dedicated POST /comments limiter.
 *
 * Exported as a FACTORY so a test can mount the REAL middleware behind supertest with its own fresh
 * store, instead of re-deriving the numbers and asserting against its own copy of them. (index.ts's
 * limiters are reachable only by reading its source — see analytics-retention-couplings.test.ts — so
 * their 429 is a regex, not a behaviour. This one's is a behaviour.)
 *
 * @param store the shared (Redis) store index.ts builds, or undefined for the in-process MemoryStore.
 */
function createCommentLimiter(store?: unknown) {
    return rateLimit({
        windowMs: COMMENT_RATE_WINDOW_MS,
        // Resolved per request, from the identity `optionalAuth` has already attached and from the
        // operator's option if there is one (express-rate-limit accepts a promise here).
        max: (req: Request) => (req.user
            ? commentRateCap(COMMENT_RATE_OPTION_AUTH, COMMENT_RATE_MAX_AUTH)
            : commentRateCap(COMMENT_RATE_OPTION_ANON, COMMENT_RATE_MAX_ANON)),
        standardHeaders: true,
        legacyHeaders: false,
        // TWO KEY SPACES, not one bucket with two ceilings. An anonymous caller is keyed by IP —
        // through clientIp(), not express-rate-limit's default req.ip, for the reason index.ts states
        // once for every limiter on this server: the bucket must never diverge from the trust-proxy
        // decision. An identified caller is keyed by USER, so a logged-in author on a shared office
        // address cannot spend the strangers' budget behind that same address, and so the higher
        // allowance follows the account it was granted to rather than whoever shares its NAT.
        keyGenerator: (req: Request) => (req.user ? `u:${req.user.id}` : `ip:${clientIp(req)}`),
        store,
        passOnStoreError: true, // a Redis outage must slow comments down, not 500 the endpoint
        message: {
            code: 'rest_comment_rate_limited',
            message: 'Too many comments from your network, please try again later.',
            data: { status: 429 }
        }
    });
}

// Built HERE, at module scope, with the in-process MemoryStore, so that index.ts — which is evaluated
// before the cache client exists — can hand the shared store over at boot without this module having
// to reach back into it (that require would be circular: index.ts requires ./routes at module scope).
//
// Eagerly, not on first use: express-rate-limit 8 flags a limiter CONSTRUCTED inside a request handler
// (ERR_ERL_CREATED_IN_REQUEST_HANDLER, printed with a stack trace on the first POST /comments) for any
// consumer that mounts this router without index.ts — an integration harness, a monolith-less embed.
// Nothing here touches the database, so module scope is a safe place to build it, and the
// store-arrives-late contract below is unchanged.
let commentLimiterImpl: any = createCommentLimiter(undefined);

/**
 * Hand this router the SHARED limiter store. Called once by index.ts, next to where it builds the same
 * store for every other limiter, so a multi-node install enforces ONE cap across all nodes instead of
 * N× the configured number. Called before any request; a later call would reset the window.
 */
function useCommentLimiterStore(store: unknown) {
    commentLimiterImpl = createCommentLimiter(store);
}

/** The middleware `router.post('/')` carries. Kept a thin shim so the store can arrive after load. */
function commentLimiter(req: Request, res: Response, next: NextFunction) {
    return commentLimiterImpl(req, res, next);
}

/* ---- WHAT THE TABLE CANNOT REMEMBER --------------------------------------------------------------
 * A discarded comment leaves no row, so the repeat guard — which asks the table — would answer "no"
 * for ever on the discarded path while the honest one answers 409 from the second attempt onwards.
 * That difference IS the trap announcing itself, one request later than the id did. This is the other
 * half of the guard: what THIS process discarded, inside the same window, keyed the same way.
 *
 * Bounded on purpose, and deliberately not a cache: an entry is a hash and a timestamp, entries expire
 * with the repeat window, and the map is capped — a spam run cannot grow it without bound. It is
 * per-process, so on a multi-node install a bot could in principle observe the difference by hitting
 * two nodes; the table half of the guard is shared and unaffected, and closing that residue would mean
 * writing a row for a comment we are refusing to store, which is the thing the trap exists to avoid.
 * ------------------------------------------------------------------------------------------------ */
const discardedRecently = new Map<string, number>();
const DISCARD_MEMORY_MAX = 1000;

/** The identity of "this body, from this caller, on this post" — the same triple the guard compares. */
function discardMemoryKey(draft: any, storedContent: string): string {
    const who = draft.userId ? `u:${draft.userId}` : `ip:${draft.authorIp || ''}`;
    return crypto.createHash('sha256')
        .update(JSON.stringify([draft.postId, who, storedContent]))
        .digest('hex');
}

function rememberDiscard(key: string): void {
    const now = Date.now();
    if (discardedRecently.size >= DISCARD_MEMORY_MAX) {
        for (const [k, at] of discardedRecently) {
            if (at <= now - DUPLICATE_WINDOW_MS) discardedRecently.delete(k);
        }
        // Still full of live entries? Drop the oldest. A bounded map that refuses to forget is just an
        // unbounded map with extra steps.
        while (discardedRecently.size >= DISCARD_MEMORY_MAX) {
            const oldest = discardedRecently.keys().next();
            if (oldest.done) break;
            discardedRecently.delete(oldest.value);
        }
    }
    discardedRecently.set(key, now);
}

function wasDiscardedRecently(key: string): boolean {
    const at = discardedRecently.get(key);
    if (at === undefined) return false;
    if (at <= Date.now() - DUPLICATE_WINDOW_MS) { discardedRecently.delete(key); return false; }
    return true;
}

/**
 * The 201 a comment that never reached the table still gets.
 *
 * Built from the same `Comment` shape the honest branch returns, so the two payloads cannot drift into
 * telling a bot which one it got — the row id INCLUDED. Emitting 0 there, as this did, made the whole
 * posture a one-request oracle: `Comment.toJSON()` publishes `id`, so an honest 201 carried `id >= 1`
 * and every discard carried `id: 0`, with every other byte identical. Every other value, `status`
 * included, is exactly what the honest branch would have answered.
 *
 * AND THE ID HAS TO ADVANCE, NOT MERELY LOOK PLAUSIBLE. A bare `SELECT MAX(comment_id) + 1` was still
 * an oracle, one comparison wide: a discard stores nothing, so MAX never moves, so two trapped posts
 * with DIFFERENT bodies came back with the SAME id — and two accepted inserts ALWAYS report strictly
 * increasing ids, so that pair is a state the honest path cannot produce. The repeat guard does not
 * mask it either: different bodies are different discardMemoryKey values, so both attempts are 201s.
 * The id therefore comes from a per-process high-water mark: seeded from the table on first use,
 * raised to `MAX + 1` on every call so a real insert in between always pushes it ahead of the table,
 * and then consumed. Consecutive discards climb exactly the way consecutive accepts do, and the number
 * handed out is still one the table has not reached — nothing was stored, and this is not a promise.
 *
 * A RESIDUE LEFT ON PURPOSE: the mark is per PROCESS. On a multi-node install two replicas keep two
 * marks, so a bot that spreads its probes across nodes can still see a fake id repeat. Closing that
 * would mean reserving a value in the SHARED sequence — an INSERT that is rolled back, or a nextval()
 * — which is writing on behalf of a comment we are refusing to store, the one cost the trap exists to
 * avoid. It is the same bound the discard memory above already accepts, for the same reason.
 */
let phantomIdWatermark = 0;

async function nextPhantomCommentId(): Promise<number> {
    let dbMax = 0;
    try {
        // One read on the primary key. MAX() over an indexed column is not a scan.
        const row = await dbAsync.get('SELECT MAX(comment_id) AS m FROM comments');
        const max = row ? Number(row.m) : 0;
        if (Number.isFinite(max)) dbMax = max;
    } catch {
        // A read that failed here would have failed for the honest branch too — keep answering from the
        // mark (or with the first id, if it was never seeded) rather than with the tell.
        dbMax = 0;
    }
    // Raise, then consume, in ONE synchronous step after the await: two discards can sit parked on that
    // SELECT at the same time, and taking the maximum before the increment is what keeps the second one
    // strictly above the first instead of repeating it.
    const id = Math.max(phantomIdWatermark, dbMax + 1);
    phantomIdWatermark = id + 1;
    return id;
}

async function discardedComment(draft: any, storedContent: string) {
    return new Comment({
        comment_id: await nextPhantomCommentId(),
        comment_post_id: draft.postId,
        comment_author: draft.author,
        comment_author_email: draft.authorEmail,
        comment_author_url: draft.authorUrl,
        comment_author_ip: draft.authorIp,
        comment_date: currentTime(),
        comment_date_gmt: currentTimeGMT(),
        comment_content: storedContent,
        comment_karma: 0,
        comment_approved: draft.status,
        comment_agent: draft.agent,
        comment_type: 'comment',
        comment_parent: draft.parent,
        user_id: draft.userId
    });
}

/**
 * Has this author already posted this exact body on this post inside the window?
 *
 * `storedContent` is the body AFTER sanitizeContent, because that is what the rows being compared
 * against went through — comparing the raw request body would be a guard asking about a value the
 * table never held. Same rule for the author: a logged-in one is their user id, a guest is
 * `req.ip`, which is the value the INSERT below writes into comment_author_ip — deliberately not
 * clientIp(), which is what the limiter keys on and which can differ from the stored column under a
 * different trust-proxy setting.
 *
 * THE SCOPE IS THE CALLER, NOT THE POST. This used to read the post's newest DUPLICATE_SCAN_LIMIT
 * comments across all authors and filter them in memory, on the reasoning that the limiter keeps a
 * repeat within a handful of rows. It does — of the CALLER'S rows. On a thread livelier than the scan
 * window the caller's earlier comment is simply not in the page that was read, so the guard stopped
 * firing: silently, and fail-open. Scoping the query itself is also what makes the constant's "bounded
 * read, not a scan" true. The two scopes are written out as whole statements rather than a WHERE
 * assembled from fragments — nothing about this query should ever be built by concatenation.
 */
const DUPLICATE_SQL_BY_USER = `SELECT comment_content, comment_date_gmt FROM comments
     WHERE comment_post_id = ? AND comment_type = 'comment' AND user_id = ?
     ORDER BY comment_id DESC LIMIT ?`;
const DUPLICATE_SQL_BY_IP = `SELECT comment_content, comment_date_gmt FROM comments
     WHERE comment_post_id = ? AND comment_type = 'comment' AND (user_id = 0 OR user_id IS NULL)
       AND comment_author_ip = ?
     ORDER BY comment_id DESC LIMIT ?`;

async function isDuplicateComment(draft: any, storedContent: string) {
    let sql: string;
    let author: any;
    if (draft.userId) {
        sql = DUPLICATE_SQL_BY_USER;
        author = draft.userId;
    } else if (draft.authorIp) {
        sql = DUPLICATE_SQL_BY_IP;
        author = draft.authorIp;
    } else {
        // A guest whose address we do not have: there is no author to compare, so no repeat can be
        // PROVEN. Fail open rather than refuse a comment on someone else's evidence.
        return false;
    }
    // comment_id, not comment_date, for the ordering: the date column is a LOCAL-time string, so
    // ordering by it is ordering by text. The id is the insertion order this needs.
    const recent = await dbAsync.all(sql, [draft.postId, author, DUPLICATE_SCAN_LIMIT]);
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (const row of recent || []) {
        // Compared HERE and not in SQL: MySQL's default collation is case-insensitive, so an `=` in the
        // statement would make 'Great post!' and 'great post!' one comment on one driver and two on
        // another.
        if (row.comment_content !== storedContent) continue;
        // comment_date_gmt is 'YYYY-MM-DD HH:MM:SS' in UTC (core/formatting.currentTimeGMT).
        const at = Date.parse(`${String(row.comment_date_gmt || '').replace(' ', 'T')}Z`);
        // A row whose date will not parse — a WXR import can carry one — is treated as OUTSIDE the
        // window. This guard may only ever refuse a comment it can PROVE is a recent repeat.
        if (Number.isFinite(at) && at >= cutoff) return true;
    }
    return false;
}

/**
 * @swagger
 * tags:
 *   name: Comments
 *   description: Comment management
 */

/**
 * @swagger
 * /comments:
 *   get:
 *     summary: List comments
 *     tags: [Comments]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: post
 *         description: Filter by post ID
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: ['1', '0', 'spam', 'trash', 'any']
*       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: parent
 *         description: Filter by parent comment ID
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: >-
 *           List of comments. Author email and IP are included only for a caller holding
 *           moderate_comments; everyone else gets the public projection.
 *         headers:
 *           X-WP-Total:
 *             schema:
 *               type: integer
 *           X-WP-TotalPages:
 *             schema:
 *               type: integer
 *       400:
 *         description: >-
 *           rest_invalid_param — a scalar query parameter was repeated or bracketed (e.g.
 *           ?status=1&status=1). The offending parameter is named in data.params.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *     security: []
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // THE WHOLE SCALAR CLASS, ONCE, BEFORE ANY OF IT IS READ. `?status=1&status=1` used to reach
    // Comment.findAll as an Array and crash the SQLite driver with "Too many parameter values were
    // provided" — a 500 — while `?order=asc&order=desc` and `?page=1&page=2` each answered something
    // the caller never asked for. Refusing here means every comparison below is a string comparison.
    requireScalarQuery(req.query, COMMENT_LIST_QUERY_FIELDS);

    const {
        page = 1,
        per_page = 10,
        post,
        status = '1', // approved
        parent,
        search,
        orderby = 'date',
        order = 'desc'
    } = req.query;

    // A query value is never plainly a string: `?per_page[]=5` makes it an Array and `?per_page[x]=5`
    // an object. parseInt already ToString()s its argument, so String() here is that same coercion
    // written where the compiler can see it - identical result for every shape, junk included.
    const limit = Math.min(parseInt(String(per_page), 10) || 10, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    // Only comment moderators can see non-approved comments AND the private commenter PII (email/IP
    // are gated in toJSON(canModerate) below).
    const canModerate = !!(req.user && req.user.can('moderate_comments'));
    // Only the NON-moderator branch overwrites this, so a MODERATOR's value flows straight through to
    // the two `commentStatus === 'any'` reads below and into the model. It is a string here because
    // requireScalarQuery refused anything else at the top of the handler — not because `status` is
    // typed one.
    let commentStatus = status;
    if (!canModerate) {
        commentStatus = '1';
    }

    // TWO request-value defects live in these three lines, and both are members of classes this repo has
    // already fixed elsewhere and not here:
    //  · PROTOTYPE — a `{}` literal answers orderByMap['constructor'] with a FUNCTION, so `|| 'x'` never
    //    fires and a Function reaches the model layer (contained today only by Comment.findAll's own
    //    allowlist, in another module, which nothing ties to this map). Object.create(null) has no
    //    inherited keys to find. Same fix routes/posts.ts already carries.
    //  · TYPE — `?order[]=asc` makes `order` an Array and `order.toLowerCase()` threw a 500 to an
    //    ANONYMOUS caller. String() first, exactly as routes/categories.ts and routes/tags.ts do.
    const orderByMap: Record<string, string> = Object.assign(Object.create(null), {
        date: 'comment_date',
        id: 'comment_id'
    });

    const comments = await Comment.findAll({
        postId: post ? parseInt(String(post), 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus,
        parent: parent !== undefined ? parseInt(String(parent), 10) : undefined,
        search,
        limit,
        offset,
        orderBy: orderByMap[String(orderby)] || 'comment_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(String(order).toLowerCase()) ? String(order).toUpperCase() : 'DESC'
    });

    const total = await Comment.count({
        postId: post ? parseInt(String(post), 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus,
        parent: parent !== undefined ? parseInt(String(parent), 10) : undefined,
        search
    });
    const totalPages = Math.ceil(total / limit);

    // res.set() String()s a non-array value itself before writing the header; doing it here sends the
    // identical bytes and keeps the call inside the typed `string | string[]` signature.
    res.set('X-WP-Total', String(total));
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(comments.map((comment: any) => comment.toJSON(canModerate)));
}));

/**
 * @swagger
 * /comments/{id}:
 *   get:
 *     summary: Get a comment
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
*     responses:
 *       200:
 *         description: Comment details
 *       404:
 *         description: >-
 *           rest_comment_invalid_id — no such comment, a malformed route id, OR a comment that is not
 *           approved and the caller does not hold moderate_comments. The three are deliberately
 *           indistinguishable, so this is never an existence oracle over pending or spam comments.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *     security: []
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // `:id` is typed `string | string[]`; parseInt ToString()s it either way, so this is the same value.
    const comment = await Comment.findById(parseInt(String(req.params.id), 10));

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    // Check if user can view non-approved comments
    if (comment.commentApproved !== '1') {
        if (!req.user || !req.user.can('moderate_comments')) {
            return res.status(404).json({
                code: 'rest_comment_invalid_id',
                message: 'Invalid comment ID.',
                data: { status: 404 }
            });
        }
    }

    res.json(comment.toJSON(!!(req.user && req.user.can('moderate_comments'))));
}));

/**
 * @swagger
 * /comments:
*   post:
 *     summary: Create a comment
 *     description: >-
 *       Open to guests unless the site requires registration to comment. Rate limited per identity —
 *       5 comments per 10 minutes for an anonymous caller, 30 for an authenticated one.
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [post, content]
 *             properties:
 *               post:
 *                 type: integer
 *               content:
 *                 type: string
 *                 description: At most 65536 bytes of UTF-8. Sanitized before storage.
 *               author_name:
 *                 type: string
 *                 description: Required for a guest; ignored for a logged-in caller, whose profile is used instead.
 *               author_email:
 *                 type: string
 *                 description: Required for a guest; ignored for a logged-in caller.
 *               author_url:
 *                 type: string
 *                 description: Restricted to http(s) — any other scheme is dropped rather than stored.
 *               parent:
 *                 type: integer
 *                 description: Must be an existing comment ON THE SAME POST.
 *               _hp:
 *                 type: string
 *                 description: >-
 *                   Honeypot. A real client leaves this absent or blank. A filled one is answered 201
 *                   exactly like an accepted comment, and nothing is stored.
 *     responses:
 *       201:
 *         description: >-
 *           Comment created — or silently discarded, with an identical body, when the honeypot was
 *           filled or a spam-filter plugin vetoed it. The two are indistinguishable on purpose.
 *       400:
 *         description: >-
 *           rest_missing_param (post/content absent, or a guest without name and email),
 *           rest_comment_too_long (over 65536 bytes), rest_invalid_param (malformed guest email) or
 *           rest_comment_invalid_parent (the parent does not exist or belongs to another post).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_comment_login_required — the site requires registration to comment."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_comment_closed (comments are closed for that post) or rest_csrf_invalid."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_post_invalid_id — no such post."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       409:
 *         description: "rest_comment_duplicate — the same body, author and post again inside 10 minutes."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_comment_rate_limited — the per-identity comment limiter refused this request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
// `commentLimiter` sits AFTER optionalAuth (so the tier is read from a real identity) and before the
// handler — see THE COMMENT ABUSE POSTURE above for why it lives on this declaration and not in index.ts.
router.post('/', optionalAuth, commentLimiter, asyncHandler(async (req: Request, res: Response) => {
    const {
        post: postId,
        author_name,
        author_email,
        author_url,
        content,
        parent
    } = req.body;

    if (!postId || !content) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Post ID and content are required.',
            data: { status: 400 }
        });
    }

    // The hard body bound, stated with the rest of the validation and so BEFORE the honeypot: both
    // honeypot branches must behave identically up to the trap (routes/forms.ts orders it the same way).
    const rawContent = String(content);
    if (Buffer.byteLength(rawContent, 'utf8') > MAX_COMMENT_BYTES) {
        return res.status(400).json({
            code: 'rest_comment_too_long',
            message: `A comment may be at most ${MAX_COMMENT_BYTES} bytes.`,
            data: { status: 400 }
        });
    }

    // Check if registration is required to comment
    const requireRegistration = await getOption('comment_registration', '0') === '1';
    if (requireRegistration && !req.user) {
        return res.status(401).json({
            code: 'rest_comment_login_required',
            message: 'Sorry, you must be logged in to post a comment.',
            data: { status: 401 }
        });
    }

    // Check post exists
    const post = await Post.findById(parseInt(postId, 10));
    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Check if comments are open
    if (post.commentStatus !== 'open') {
        return res.status(403).json({
            code: 'rest_comment_closed',
            message: 'Comments are closed for this post.',
            data: { status: 403 }
        });
    }

    // Get author info
    let author = author_name;
    let email = author_email;
    let url = author_url || '';
    let userId = 0;

    if (req.user) {
        author = req.user.displayName;
        email = req.user.userEmail;
        // SECURITY: a logged-in user's stored profile URL is also rendered as a clickable comment-author
        // link (admin moderation UI + public post page), so hold it to the SAME http(s)-only rule the
        // guest branch applies — otherwise a self-service `javascript:`/`data:` profile URL (see the
        // profile-update guard in models/User.ts) would reach that href sink verbatim (second-order XSS).
        url = safeAuthorUrl(req.user.userUrl);
        userId = req.user.id;
    } else {
        // Require name and email for guests
        if (!author || !email) {
            return res.status(400).json({
                code: 'rest_missing_param',
                message: 'Author name and email are required.',
                data: { status: 400 }
            });
        }

        // SECURITY: guest author fields are persisted and later rendered. Treat the display name as
        // plain text (strip any markup), validate the email shape, and restrict author_url to
        // http(s) so a value like `javascript:...` can never become a clickable comment-author link.
        author = stripTags(String(author)).trim();
        if (!author) {
            return res.status(400).json({
                code: 'rest_missing_param',
                message: 'Author name is required.',
                data: { status: 400 }
            });
        }
        email = String(email).trim();
        if (!isValidAddress(email)) {
            return res.status(400).json({
                code: 'rest_invalid_param',
                message: 'A valid author email is required.',
                data: { status: 400 }
            });
        }
        url = safeAuthorUrl(url);
    }

    // SECURITY (VAL-01): a reply must point at a real parent comment on the SAME post. Without this an
    // attacker can thread a reply under an unrelated post's comment (thread spoofing / cross-post linking)
    // or reference a non-existent id. Top-level comments (no parent) are still allowed.
    const parentId = parent ? parseInt(parent, 10) : 0;
    if (parentId) {
        const parentComment = await Comment.findById(parentId);
        if (!parentComment || parentComment.commentPostId !== parseInt(postId, 10)) {
            return res.status(400).json({
                code: 'rest_comment_invalid_parent',
                message: 'Invalid parent comment.',
                data: { status: 400 }
            });
        }
    }

    // Determine initial status. Read once, and BEFORE the honeypot, so the discarded branch can report
    // exactly the status the honest one would have.
    const canModerate = !!(req.user && req.user.can('moderate_comments'));
    const status = canModerate ? '1' /* approved */ : '0'; /* pending */

    // The row this request would insert, described ONCE, so the honeypot's success payload, the repeat
    // comparison, the plugin filter and the real INSERT can never end up describing different comments.
    // `content` stays RAW here: Comment.create runs sanitizeContent itself, and sanitize-html escapes
    // entities, so pre-sanitizing would double-escape every `&` in the stored body.
    const draft = {
        postId: parseInt(postId, 10),
        author,
        authorEmail: email,
        authorUrl: url,
        authorIp: req.ip || '',
        content: rawContent,
        status,
        parent: parentId,
        userId,
        agent: req.get('User-Agent') || ''
    };
    // The body as it will be STORED — what the repeat check must compare, and what the discarded
    // branch must show.
    const storedContent = sanitizeContent(rawContent);
    // One key for both halves of the repeat guard: the rows in the table, and the discards the table
    // was never told about.
    const repeatKey = discardMemoryKey(draft, storedContent);

    // ---- the same body, from the same author, on the same post, twice inside the window -------------
    // BEFORE the honeypot, and asking the discard memory as well as the table: this branch has to answer
    // the same whether or not the caller's previous attempt was discarded, or the trap tells a bot which
    // branch it is on with its second request (see THE DISCARD IS NOT AN ORACLE above).
    if (wasDiscardedRecently(repeatKey) || await isDuplicateComment(draft, storedContent)) {
        return res.status(409).json({
            code: 'rest_comment_duplicate',
            message: 'Duplicate comment detected; it looks as though you have already said that.',
            data: { status: 409 }
        });
    }

    // ---- honeypot: after every validation AND after the repeat guard, so both paths behave identically
    // up to this point --------------------------------------------------------------------------------
    // A hidden field humans never fill (the comment form renders it off-screen, out of the tab order and
    // aria-hidden). Non-empty ⇒ answer as if the comment had been accepted and store nothing; never
    // reveal the trap. Any non-string value counts as filled: only an absent or blank field is a human.
    const honeypot = req.body[HONEYPOT_FIELD];
    const honeypotTripped = typeof honeypot === 'string'
        ? honeypot.trim() !== ''
        : (honeypot !== undefined && honeypot !== null);
    if (honeypotTripped) {
        rememberDiscard(repeatKey);
        return res.status(201).json((await discardedComment(draft, storedContent)).toJSON(canModerate));
    }

    // ---- the extension point an Akismet / Turnstile plugin hooks (see COMMENT_PRE_INSERT_FILTER) ----
    const verdict = await applyFilters(COMMENT_PRE_INSERT_FILTER, true, {
        postId: draft.postId,
        author: draft.author,
        authorEmail: draft.authorEmail,
        authorUrl: draft.authorUrl,
        authorIp: draft.authorIp,
        content: storedContent,
        status: draft.status,
        parent: draft.parent,
        userId: draft.userId,
        agent: draft.agent,
        isAuthenticated: !!req.user
    });
    if (verdict === false) {
        // A veto is a discard like the trap's, and it answers through the same payload — so it must be
        // remembered the same way, or the plugin's verdict becomes the tell the honeypot no longer is.
        rememberDiscard(repeatKey);
        return res.status(201).json((await discardedComment(draft, storedContent)).toJSON(canModerate));
    }

    const comment = await Comment.create(draft);

    res.status(201).json(comment.toJSON(canModerate));
}));

/**
 * @swagger
 * /comments/{id}:
 *   put:
 *     summary: Update a comment
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
*               status:
 *                 type: string
 *                 description: >-
 *                   Changing the moderation status additionally requires moderate_comments —
 *                   edit_comments alone fixes content and author fields but is not a back door to
 *                   moderation.
 *                 enum: ['1', '0', 'spam', 'trash']
 *               author:
 *                 type: string
 *               author_email:
 *                 type: string
 *               author_url:
 *                 type: string
 *                 description: Restricted to http(s), exactly as on the guest-create path.
 *     responses:
 *       200:
 *         description: Comment updated (moderator projection, including author email and IP)
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (no edit_comments, or a status change attempted without moderate_comments),
 *           rest_csrf_token / rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_comment_invalid_id — no such comment, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.put('/:id', authenticate, can('edit_comments'), asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(String(req.params.id), 10);
    const comment = await Comment.findById(commentId);

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    const { author, author_email, author_url, content, status } = req.body;

    // SECURITY: changing a comment's MODERATION status (approve '1' / unapprove '0' / spam / trash) is a
    // privileged action gated by moderate_comments — the SAME capability POST /:id/approve and /:id/spam
    // require. edit_comments alone lets a caller fix a comment's content/author fields, but must NOT be a
    // back door to moderation: a custom role granting edit_comments without moderate_comments could
    // otherwise approve/spam any comment via this field. Reject a status change from a non-moderator.
    if (status !== undefined && !req.user.can('moderate_comments')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You do not have permission to moderate comments.',
            data: { status: 403 }
        });
    }

    // SECURITY: enforce the SAME http(s)-only constraint the guest-create path applies via
    // safeAuthorUrl, so an edit_comments user can't set a `javascript:`/`data:` comment_author_url that
    // bypasses guest validation. Only transform when the field was actually provided — leaving it
    // undefined preserves Comment.update's "field omitted → stored value unchanged" behavior.
    const safeUrl = author_url === undefined ? undefined : safeAuthorUrl(author_url);

    const updated = await Comment.update(commentId, {
        author,
        authorEmail: author_email,
        authorUrl: safeUrl,
        content,
        status
    });

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

/**
 * @swagger
 * /comments/{id}:
 *   delete:
 *     summary: Delete a comment (Trash or Force)
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
*       - in: query
 *         name: force
 *         description: >-
 *           "true" deletes permanently and echoes the removed comment as `previous`; anything else
 *           moves it to the trash and echoes the trashed row. A REPEATED force parameter is refused.
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Comment trashed or permanently deleted
 *       400:
 *         description: "rest_invalid_param — the force parameter was repeated or bracketed."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (no moderate_comments), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_comment_invalid_id — no such comment, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.delete('/:id', authenticate, can('moderate_comments'), asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(String(req.params.id), 10);
    const comment = await Comment.findById(commentId);

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    // Twin of DELETE /posts/:id: `?force=true&force=true` is an Array, which is not 'true', so the
    // permanent delete quietly became a trash — and then the re-read below could not find the trashed
    // row and answered 404 "Invalid comment ID", after the comment had already been moved. One rule:
    // a repeated scalar is refused, not resolved. See core/query-params.
    const force = scalarQueryParam(req.query.force, 'force') === 'true';
    await Comment.delete(commentId, force);

    if (force) {
        res.json({ deleted: true, previous: comment.toJSON(true) });
    } else {
        const fresh = await Comment.findById(commentId);
        if (!fresh) {
            return res.status(404).json({
                code: 'rest_comment_invalid_id',
                message: 'Invalid comment ID.',
                data: { status: 404 }
            });
        }
        res.json(fresh.toJSON(true)); // moderation route — moderator sees full PII
    }
}));

/**
 * POST /comments/:id/approve
 * Approve comment
 */
/**
 * @swagger
 * /comments/{id}/approve:
 *   post:
 *     summary: Approve a comment
 *     description: Moderation shortcut for setting the comment's status to approved.
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     responses:
 *       200:
 *         description: The approved comment, in the moderator projection (author email and IP included)
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (no moderate_comments), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_comment_invalid_id — no such comment, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/:id/approve', authenticate, can('moderate_comments'), asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(String(req.params.id), 10);
    const updated = await Comment.approve(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

/**
 * POST /comments/:id/spam
 * Mark comment as spam
 */
/**
 * @swagger
 * /comments/{id}/spam:
 *   post:
 *     summary: Mark a comment as spam
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     responses:
 *       200:
 *         description: The comment, now marked spam, in the moderator projection
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (no moderate_comments), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_comment_invalid_id — no such comment, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/:id/spam', authenticate, can('moderate_comments'), asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(String(req.params.id), 10);
    const updated = await Comment.spam(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

module.exports = router;
// The dedicated POST /comments limiter is BUILT and MOUNTED here — see THE COMMENT ABUSE POSTURE for
// why it is not an index.ts mount like its siblings. index.ts calls useCommentLimiterStore() once at
// boot so the multi-node (Redis) store decision still lives in one place, and the factory is exported
// so a test can drive the real middleware instead of rebuilding it from its own copy of the numbers.
module.exports.createCommentLimiter = createCommentLimiter;
module.exports.useCommentLimiterStore = useCommentLimiterStore;
module.exports.COMMENT_RATE_WINDOW_MS = COMMENT_RATE_WINDOW_MS;
module.exports.COMMENT_RATE_MAX_ANON = COMMENT_RATE_MAX_ANON;
module.exports.COMMENT_RATE_MAX_AUTH = COMMENT_RATE_MAX_AUTH;
// The option names that override the two defaults above, exported so a test drives the REAL knob
// rather than its own copy of the spelling.
module.exports.COMMENT_RATE_OPTION_ANON = COMMENT_RATE_OPTION_ANON;
module.exports.COMMENT_RATE_OPTION_AUTH = COMMENT_RATE_OPTION_AUTH;
module.exports.COMMENT_HONEYPOT_FIELD = HONEYPOT_FIELD;
module.exports.COMMENT_PRE_INSERT_FILTER = COMMENT_PRE_INSERT_FILTER;
module.exports.COMMENT_DUPLICATE_WINDOW_MS = DUPLICATE_WINDOW_MS;
module.exports.COMMENT_DUPLICATE_SCAN_LIMIT = DUPLICATE_SCAN_LIMIT;
module.exports.MAX_COMMENT_BYTES = MAX_COMMENT_BYTES;
