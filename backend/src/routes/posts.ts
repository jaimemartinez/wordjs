/**
 * WordJS - Posts Routes
 * /api/v1/posts/*
 */

import type { Request, Response } from 'express';
import type { QueryValue } from '../core/query-params';
import type {
    ContentCreateInput,
    ContentListQuery,
    ContentUpdateInput,
} from '../generated/content-dtos.generated';

const express = require('express');
const router = express.Router();

interface ContentRouteUser {
    id: number;
    can(capability: string): boolean;
}
type MaybeAuthenticatedRequest<P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>> =
    Request<P, unknown, B, Q> & { user?: ContentRouteUser };
type AuthenticatedRequest<P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>> =
    Request<P, unknown, B, Q> & { user: ContentRouteUser };
interface IdParams { id: string }
interface SlugParams { slug: string }
interface TypeQuery { type?: string }
// `force` is DELIBERATELY not `string`. It is what Express can actually deliver, because declaring it
// a string is precisely what hid this route's worst defect: the compiler believed `req.query.force`
// was a string, so `req.query.force === 'true'` looked like a total comparison, while `?force=true&
// force=true` arrived as ['true','true'] and answered false — a permanent delete downgraded to a
// trash, with a 200. The honest type forces the read through scalarQueryParam.
interface ForceQuery { force?: QueryValue }
interface MetaWriteBody { key?: unknown; value?: unknown }
interface LanguageBody { language?: unknown }
interface TranslationBody { translationId?: unknown }
const Post = require('../models/Post');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE (core/query-params): a parameter declared scalar arrives once, as a string,
// or the request is a 400. Same rule firstNonStringField()/invalidParamType() below apply to this
// file's list and body fields — this is that rule for a single value, reusable by the other routers.
const { scalarQueryParam, requireRouteId, isRouteId } = require('../core/query-params');
const { saveRevision, isRevisionableMeta } = require('../core/revisions');
const sanitizeHtml = require('sanitize-html');

// The Puck/meta sanitizer (sanitize, sanitizePuckTree, sanitizeMetaValue, PUCK_*_FIELDS) lives in a
// shared core module so non-route write paths (e.g. the WXR importer) sanitize meta through the EXACT
// same code instead of bypassing it. Behavior here is unchanged — these are the same functions that
// previously lived inline in this file.
const {
    sanitize,
    sanitizeMetaValue,
    assertMetaValueWithinLimits,
    isMetaValueComplexityError,
} = require('../core/sanitize-meta');

// capsFor / capsForType resolve a post type to its capability family (post → edit_posts, page →
// edit_pages, custom → edit_<type>s, plus the *_published_* / *_others_* variants). They live in a
// shared core module so routes/revisions.ts enforces the EXACT same type-aware + publish-aware gate on
// restore/delete — the two write surfaces previously drifted (revisions used a weaker, post-only,
// publish-blind gate). capsForType returns null for an unregistered type (the CREATE path rejects it);
// callers editing an existing post fall back to capsFor('post').
// canEditPostRecord is the SHARED edit gate (type family + ownership + edit_published_<type>s) that
// PUT /:id used to keep inline; it now also gates POST /:id/meta, which enforced only the first two.
// isRestExposedPostType answers "may the GENERIC /posts surface touch this type at all" — see below.
const {
    capsFor, capsForType, canEditPostRecord, canDeletePostRecord,
    canReadPostRecord, isRestExposedPostType,
} = require('../core/post-capabilities');
const { contentContractForType } = require('../core/content-contract');
const { runContentMutation, recordContentEvent } = require('../core/content-outbox');

// Meta keys the generic writers must refuse: the attachment's on-disk path (`_wp_attached_file`,
// which Media.delete turns into an unlink target) and the other server-owned bookkeeping keys.
// metaKeyProblem is the FORM gate every meta writer in this file shares (type, emptiness, the
// prototype-manipulating names, the column's length bound) — see core/protected-meta.
const { isProtectedPostMeta, metaKeyProblem, canonicalMetaKey } = require('../core/protected-meta');

// The slug PRODUCER. A slug arriving in a request body is a segment of the site's public URL space, so
// it is produced here rather than accepted here — the same function PUT already applied through
// Post.update, so both writers of post_name emit the same representation.
const { sanitizeTitle } = require('../core/formatting');

// MULTILINGUAL: validate a BCP-47 language tag at the route boundary (the model canonicalizes; the
// route rejects an unparseable non-empty value with a 400 instead of silently clearing it).
const { parseLanguageTag } = require('../core/language-tag');

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// AUDIT — who changed which content, and how its VISIBILITY moved.
//
// ONE ROW PER REQUEST, and the action names the most specific thing that happened: a trash is not an
// "update", and "who put this live?" must be answerable with `WHERE action = 'post.publish'` rather
// than by parsing a detail blob. The status transition travels in `from`/`to` so the generic
// `post.update` rows stay informative too.
//
// The single exception is a creation that is BORN published (importers and headless clients do exactly
// this): it records post.create AND post.publish, because otherwise a publish query silently misses
// every post that never spent a moment as a draft.
//
// WHAT IS NEVER RECORDED: the title, the content, the excerpt, the meta bag. An audit row says that a
// write happened and who made it; the revision history is what stores what the text used to be, and
// copying content in here would turn a security log into a second, unbounded copy of the site.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const { recordAudit } = require('../core/audit');

/** True when a status makes content publicly reachable, now or on a schedule. */
function isPublicStatus(status: any): boolean {
    return status === 'publish' || status === 'future';
}

/**
 * THE DOWNGRADED EDIT GATE — type family + ownership, WITHOUT edit_published_<type>s.
 *
 * It exists for exactly ONE thing: the explicit allowlist of NON-CONTENT meta keys below. Everything
 * else in this file uses canEditPostRecord, the three-part rule. The multilingual endpoints used to
 * use this one on the theory that a language is "metadata, not content" — it is not: post_language
 * decides which listing and which hreflang set a PUBLISHED entry appears in, so a contributor whose
 * draft an editor published could still move the live page between language editions with plain
 * edit_posts while PUT /posts/:id answered 403. That was finding #7's asymmetry moved to another
 * route, not fixed, so those three routes now use canEditPostRecord like everything else.
 *
 * Anything reached through this function must be justified in NON_CONTENT_META_KEYS.
 */
function canEditPostIgnoringPublished(user: any, p: any): boolean {
    const caps = capsForType(p.type || p.postType || 'post') || capsFor('post');
    return p.authorId === user.id ? user.can(caps.edit) : user.can(caps.editOthers);
}

/**
 * NON-CONTENT meta keys: writable with the DOWNGRADED gate above, even on a published post.
 *
 * This is the explicit allowlist the audit asked for, and it is the exact OPPOSITE of
 * core/protected-meta: that file lists keys NOBODY may write through the generic surface, this one
 * lists keys whose write is not a content change and therefore must not demand edit_published.
 *
 *  · `_wjs_review_comments` — the editorial review THREAD (frontend/src/components/editor/
 *    ReviewComments.tsx is its only writer). Applying the published-post rule to it made a contributor
 *    unable to answer a reviewer on their own entry the moment an editor published it, which is
 *    precisely when the conversation matters. It renders nowhere on the public site, so a write to it
 *    cannot alter what the site serves.
 *
 * A key belongs here only if writing it changes NOTHING a visitor can see. `_puck_data`,
 * `_wjs_template`, `_thumbnail_id` and the SEO keys are public output and must never be listed.
 */
const NON_CONTENT_META_KEYS: Set<string> = new Set([
    '_wjs_review_comments',
]);

/** Keep WordJS-owned keys driver-independent while preserving plugin keys byte-for-byte. */
function storageMetaKey(key: string, contentType?: string): string {
    const canonical = canonicalMetaKey(key);
    return isRevisionableMeta(canonical, contentType) || NON_CONTENT_META_KEYS.has(canonical) ? canonical : key;
}

/**
 * Sanitize a request's writable metadata BEFORE the route mutates a post or creates a revision.
 * Besides keeping the three write surfaces on one policy, the ordering is important: structural
 * validation of `_puck_data` can reject an adversarial tree, and that rejection must not leave a
 * half-created post or a title update whose accompanying page tree was never stored.
 */
function sanitizeWritableMetaBag(meta: any, contentType?: string): Array<[string, any]> {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
    const entries: Array<[string, any]> = [];
    for (const [key, value] of Object.entries(meta)) {
        if (metaKeyProblem(key) !== null || isProtectedPostMeta(key)) continue;
        // Core/versioned keys have ONE spelling on disk on every driver. Without this, SQLite creates
        // `_PUCK_DATA` as a second inert row while MySQL updates `_puck_data` because its collation is
        // case/accent-insensitive — the same request has different meaning by database.
        const storedKey = storageMetaKey(key, contentType);
        // Every structured meta value eventually reaches Post.updateMeta → JSON.stringify. Bound the
        // class here, not only `_puck_data`, so another plugin/editor key cannot recreate the overflow.
        if (value && typeof value === 'object') assertMetaValueWithinLimits(value);
        entries.push([storedKey, sanitizeMetaValue(storedKey, value)]);
    }
    return entries;
}

/** Translate the sanitizer's branded availability bound into a stable REST response. */
function rejectOverComplexMeta(res: Response, error: any): boolean {
    if (!isMetaValueComplexityError(error)) return false;
    res.status(413).json({
        code: 'rest_meta_value_too_complex',
        message: error.message,
        data: { status: 413 }
    });
    return true;
}

/**
 * Is this post type INTERNAL — registered, but marked `showInRest: false`?
 *
 * "Unregistered" and "internal" are NOT the same answer, and conflating them was a regression:
 * isRestExposedPostType() says false to both, so a post whose custom type an admin later removed
 * (DELETE /types/:name is one click) became unreachable through EVERY route in this file — 404 on
 * read, 404 on update, 404 on delete, 400 on the list — with no way left to read, migrate or delete
 * the orphaned content, not even for an administrator. The explicit `|| capsFor('post')` fallback
 * that routes/posts.ts and routes/revisions.ts keep for "a post whose registered type was since
 * removed" became dead code the day that happened.
 *
 * The security argument only ever concerned INTERNAL types: nav_menu_item and revision are registered
 * (core/post-types registers them at boot, before any request), carry no capability_type, and so fall
 * into the plain `post` family — which is how an editor rewrote `_menu_item_url`. Those stay refused.
 * An unknown type falls back to the `post` family exactly as it did before the remediation, which is
 * a capability the caller must still hold.
 */
const ALWAYS_INTERNAL_POST_TYPES: Set<string> = new Set(['nav_menu_item', 'revision']);

function isInternalPostType(type: unknown): boolean {
    const name = String(type || 'post');
    // FAIL CLOSED ON THE CORE INTERNALS, whatever the registry currently says. initPostTypes() is where
    // `nav_menu_item` and `revision` get registered, and it is ASYNC (it awaits getOption for the custom
    // types), so between "the server accepts requests" and "initPostTypes resolved" getPostType() answers
    // null for both — a window in which asking the registry alone would let a menu item through. Those two
    // names are also the ones core/post-types refuses to unregister, so hard-coding them here states a
    // fact rather than duplicating a policy.
    if (ALWAYS_INTERNAL_POST_TYPES.has(name)) return true;
    const { getPostType } = require('../core/post-types');
    const pt = getPostType(name);
    return !!(pt && pt.showInRest === false);
}

/**
 * Is this loaded post INVISIBLE to the generic /posts routes?
 *
 * A `nav_menu_item` and a `revision` are rows in `posts`; they have their own APIs (menus.ts is
 * admin-only, revisions.ts carries the restore/delete gate) and are registered `showInRest: false`.
 * Reaching them through /posts routed them into the plain `post` capability family — which is how an
 * EDITOR could rewrite `_menu_item_url` on every menu item (persistent phishing from the site's own
 * origin) with nothing but edit_others_posts. Every route that loads a post by id/slug answers 404 for
 * these, exactly as it does for a post that does not exist: an internal type is not "a post you lack
 * permission for", it is not addressable here at all.
 *
 * An EXISTING post of an UNREGISTERED type stays addressable — see isInternalPostType. Hiding it was
 * a regression, not a hardening: creation still rejects an unregistered type (that check is
 * capsForType() returning null, on the CREATE path only).
 */
function isHiddenFromRest(post: any): boolean {
    return isInternalPostType(post.type || post.postType || 'post');
}

/**
 * Parse a caller-supplied non-negative integer, or null.
 *
 * THE POINT IS THAT THE RETURNED VALUE IS WHAT GETS WRITTEN. `parseInt` is a PREFIX parser: it reads
 * `"0.000007e6"` as 0 and `"7e3"` as 7, while SQLite's INTEGER affinity reads the SAME strings as
 * 7 and 7000. Validating one representation and storing the other is how an authorization check on
 * `parent` was passed with 0 ("no parent, nothing to authorize") and a post_parent of someone else's
 * page was stored anyway — a 403 turned into a 201. So this returns a NUMBER, callers hand that
 * number to the model, and the value the gate inspected is byte-identical to the value in the column.
 *
 * Only plain decimal digits are accepted: no sign, no exponent, no decimal point, no hex. A caller
 * that means 7 can always write 7.
 */
function toNonNegativeInt(raw: unknown): number | null {
    const n = toInt(raw);
    return n !== null && n >= 0 ? n : null;
}

/**
 * The signed twin, for ordering columns that carry no authorization of their own.
 *
 * `menu_order` is legitimately NEGATIVE in WordPress (a "pin above everything" order), so it must not
 * inherit `parent`'s non-negative rule; what it DOES share is that the parsed number — not the raw
 * body field — is what reaches the column, so '' becomes 0 here instead of an empty string that MySQL
 * under STRICT_TRANS_TABLES rejects with ERROR 1366.
 */
function toInt(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    const digits = s.startsWith('-') ? s.slice(1) : s;
    if (digits.length === 0 || digits.length > 15) return null;
    for (const ch of digits) {
        if (ch < '0' || ch > '9') return null;
    }
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

/** The 404 body every route in this file uses for "no such post". */
const NOT_FOUND = { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } };

// THE ROUTE-ID CONTRACT — see core/query-params.
//
// This router had NO id guard of any kind: nine routes did `parseInt(req.params.id, 10)` and handed
// the result to `Post.findById`. That left two ways to reach the driver with something that cannot be
// an id, and both were live on the ANONYMOUS `GET /posts/:id` (it is optionalAuth):
//
//   · `/posts/9999999999` — a valid decimal integer, so `if (!id)` waves it through, but wider than
//     the 32-bit `posts.id` column. Postgres refuses the bind with
//     `22003 value "9999999999" is out of range for type integer` and the caller gets a 500 with the
//     driver's own error in it. SQLite and MySQL match nothing, which is why the suites were green.
//   · `/posts/12abc` — `parseInt` stops at the 'a' and returns 12, so this SERVED POST 12 with a 200.
//     Every post had an unbounded family of URLs, each one a separate cache key, rate-limit bucket and
//     audit-log entry for the same row.
//
// Declared once here rather than at the nine call sites: express runs it for every route in this
// router that names `:id`, including routes added later — which is exactly how this class survived
// the previous round, where the guard went in at the routers somebody happened to be looking at.
// `:slug` is deliberately NOT declared: a post slug is a string and 'my-2026-recap' is a legitimate one.
router.param('id', requireRouteId(NOT_FOUND));

/* ── THE STRING-FIELD BOUNDARY ────────────────────────────────────────────────────────────────────
 *
 * THE CLASS, in one sentence: every request field this file compares against a string literal, a Set
 * or an allowlist while ASSUMING it is a string can arrive as an Array, an object, a number or a
 * boolean — the comparison then fails silently (`['publish'] === 'publish'` is false, `Set.has([...])`
 * is false) while the SINK turns it back into the very string the guard decided it was not looking at,
 * because better-sqlite3 binds a one-element array AS that string and mysql2 formats it through
 * arrayToList.
 *
 * WHY THIS IS A TABLE AND NOT N GUARDS. The previous three waves closed this one field at a time —
 * `key`, then `type`, then `parent` — and each time the NEXT field over was still open. The field
 * that was left open last time is the one that decides PUBLIC VISIBILITY: a contributor sending
 * `status: ['publish']` was downgraded by nothing, stored as `publish`, and answered 201, with the
 * entry live on the anonymous site and the term counts bumped. So the type is asserted ONCE, for
 * every named field, before any comparison in the route body runs.
 *
 * HOW TO EXTEND IT: add the field NAME to the table below. Never add a `typeof x === 'string'` next to
 * a single use — that is how the class survived three waves. `backend/src/tests/request-field-types.
 * test.ts` drives every name in these tables through every non-string shape AND re-derives the
 * destructured field list from this file's source, so a body field that is in neither table fails
 * loudly instead of being silently unguarded.
 */

/** Body fields of POST /posts and PUT /posts/:id that are STRINGS (or absent). */
const POST_BODY_STRING_FIELDS: readonly string[] = Object.freeze([
    'title', 'content', 'excerpt', 'status', 'type', 'slug', 'comment_status', 'date', 'language',
]);

/**
 * Body fields of the same two routes that are DELIBERATELY not strings, listed so the completeness
 * test can tell "checked elsewhere" from "forgotten":
 *   · parent / menu_order — numbers, normalized by toNonNegativeInt/toInt (which reject an Array,
 *     an object and a boolean by construction: they accept a number or a digits-only string).
 *   · categories / tags   — arrays; used only through `Array.isArray(...)`.
 *   · meta                — an object; its KEYS go through core/protected-meta.metaKeyProblem.
 *   · autosave            — a boolean, compared with `=== true` (anything else is "not an autosave").
 *   · translationId       — POST /posts/:id/translations only; parseInt + `!otherId` rejects the rest.
 *   · key / value         — POST /posts/:id/meta; `key` goes through metaKeyProblem, `value` may be
 *                           any JSON shape (sanitizeMetaValue walks it).
 */
const POST_BODY_NON_STRING_FIELDS: readonly string[] = Object.freeze([
    'parent', 'menu_order', 'categories', 'tags', 'meta', 'autosave', 'translationId', 'key', 'value',
]);

/**
 * Query parameters this file READS. Everything in a URL query is a string; an Array or an object here
 * is Express's qs parser reflecting `?status[]=publish`, i.e. a caller reaching for exactly this class.
 *
 * `categories`/`tags` joined the table when they became REAL filters. They were previously excluded
 * on the grounds that "adding them would 400 a request that is legal today" — which was true only
 * because the handler destructured them and passed them to nothing, so `?categories[]=3` was legal in
 * the sense that every spelling of it was equally ignored. A value that now decides which rows come
 * back is a value whose shape has to be settled first, like every other one here.
 */
const LIST_QUERY_STRING_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'status', 'type', 'search', 'orderby', 'order', 'author', 'categories', 'tags',
]);

/**
 * THE IDENTITY-LIST GRAMMAR of `?categories=`, `?tags=` and `?author=`.
 *
 * One comma-separated list per parameter. An element is either a row ID (all digits) or a SLUG — a
 * term's `slug`, or an author's `user_nicename`/`user_login` — split by shape, which is the same rule
 * `routes/seo.ts` applies to the `/author/<segment>/feed.xml` path segment so the two surfaces cannot
 * disagree about what `2` means.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE IS REFUSED RATHER THAN DROPPED:
 *   · an EMPTY element (`1,,2`, `1,`) — a list with a hole in it is a caller bug, and silently
 *     narrowing to the elements that did parse answers a question nobody asked;
 *   · an all-digit element that no id column can hold (`0`, `9999999999`) — the same bound
 *     core/query-params states for a route id, for the same reason: Postgres answers
 *     `22003 value out of range` and the caller gets a 500 from a filter;
 *   · a control character, or an element longer than a slug column can be;
 *   · more elements than MAX_IDENTITY_ELEMENTS, so one URL cannot expand into an unbounded IN() list.
 *
 * An ENTIRELY empty value (`?categories=`) is ABSENT, not malformed — the same reading `?type=` gets
 * three guards down, and the shape a form submits for "no filter chosen".
 */
const MAX_IDENTITY_ELEMENTS = 50;
const MAX_IDENTITY_SLUG_LENGTH = 200;
/** True when `value` carries a control character — never part of a slug, and a terminal-escape sink. */
function hasControlCharacter(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

type IdentityList = { ids: number[]; slugs: string[] };
type IdentityParse = { ok: true; value?: IdentityList } | { ok: false; detail: string };

function parseIdentityList(raw: string | undefined): IdentityParse {
    if (raw === undefined || raw === null || raw.trim() === '') return { ok: true };
    const elements = raw.split(',');
    if (elements.length > MAX_IDENTITY_ELEMENTS) {
        return { ok: false, detail: `At most ${MAX_IDENTITY_ELEMENTS} comma-separated values are accepted.` };
    }
    const ids: number[] = [];
    const slugs: string[] = [];
    for (const element of elements) {
        const value = element.trim();
        if (!value) return { ok: false, detail: 'Empty value in a comma-separated list.' };
        if (/^[0-9]+$/.test(value)) {
            // The SAME predicate the route-id contract uses (core/query-params.isRouteId), not a
            // second, weaker one written here — which is the exact drift that module documents.
            if (!isRouteId(value)) return { ok: false, detail: `'${value}' is not a valid ID.` };
            ids.push(Number(value));
            continue;
        }
        if (value.length > MAX_IDENTITY_SLUG_LENGTH || hasControlCharacter(value)) {
            return { ok: false, detail: 'Invalid slug in a comma-separated list.' };
        }
        slugs.push(value);
    }
    return { ok: true, value: { ids, slugs } };
}

/**
 * The FIRST field in `fields` that is present on `source` and is not a string, or null.
 *
 * null/undefined count as ABSENT, not as a violation: several of these fields use null as "clear this
 * value" and the handlers below already distinguish absent from empty.
 */
function firstNonStringField(source: unknown, fields: readonly string[]): string | null {
    if (!source || typeof source !== 'object') return null;
    const record = source as Record<string, unknown>;
    for (const field of fields) {
        const value = record[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return field;
    }
    return null;
}

/** The 400 for a field that arrived with the wrong TYPE. */
function invalidParamType(res: Response, field: string) {
    return res.status(400).json({
        code: 'rest_invalid_param',
        message: `Invalid parameter '${field}': expected a string.`,
        data: { status: 400, params: { [field]: 'Expected a string.' } },
    });
}

/**
 * The 400 for a field whose SHAPE was fine and whose VALUE cannot denote anything.
 *
 * Deliberately the same code and the same body layout as invalidParamType — one refusal shape for
 * `GET /posts`, so a caller parses one thing and `data.params` always names the offending field.
 */
function invalidParamValue(res: Response, field: string, detail: string) {
    return res.status(400).json({
        code: 'rest_invalid_param',
        message: `Invalid parameter '${field}': ${detail}`,
        data: { status: 400, params: { [field]: detail } },
    });
}

/** Stable F2 failure body shared by generated create/update validators. */
function invalidContentContract(res: Response, issues: Array<{ path: string; code: string; message: string }>) {
    return res.status(400).json({
        code: 'rest_content_contract_invalid',
        message: 'The content request does not match its declared schema.',
        errors: issues,
        data: {
            status: 400,
            params: Object.fromEntries(issues.map((issue) => [issue.path, issue.message])),
        },
    });
}

async function visibleTranslationRefs(
    translations: Array<{ id: number }>,
    user?: ContentRouteUser,
) {
    const decisions = await Promise.all(translations.map(async (translation) => {
        const candidate = await Post.findById(translation.id);
        return candidate && canReadPostRecord(user, candidate) ? translation : null;
    }));
    return decisions.filter((translation) => translation !== null);
}

/** Prevent private REST types from leaking sibling slugs through Post.toJSON().translations. */
async function serializeVisibleContent(post: any, user?: ContentRouteUser) {
    const json = await post.toJSON();
    const policy = capsForType(post.type || post.postType || 'post') || capsFor('post');
    if (!policy.publiclyReadable && Array.isArray(json.translations) && json.translations.length) {
        json.translations = await visibleTranslationRefs(json.translations, user);
    }
    return json;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     Post:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: object
 *           properties:
 *             rendered:
 *               type: string
 *         content:
 *           type: object
 *           properties:
 *             rendered:
 *               type: string
 *         date:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [publish, draft, pending, private, trash]
 *         author:
 *           type: object
 *           description: The post's author identity. `slug` is user_nicename, or the numeric id when the account has no nicename — never user_login.
 *           properties:
 *             id:
 *               type: integer
 *             displayName:
 *               type: string
 *             slug:
 *               type: string
 *         authorId:
 *           type: integer
 *
 * /posts:
 *   get:
 *     summary: Retrieve a list of posts
 *     tags: [Posts]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *       - in: query
 *         name: orderby
 *         schema:
 *           type: string
 *           enum: [date, modified, title, id, menu_order]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: categories
 *         description: >-
 *           Comma-separated category term IDs and/or slugs. A post matches when it carries ANY of
 *           them; combining this with `tags` requires BOTH taxonomies to match. Applied to the rows
 *           and to X-WP-Total alike. A malformed element answers 400 rest_invalid_param.
 *         schema:
 *           type: string
 *         example: news,3
 *       - in: query
 *         name: tags
 *         description: >-
 *           Comma-separated post_tag term IDs and/or slugs, with the same OR-within/AND-across
 *           semantics as `categories`.
 *         schema:
 *           type: string
 *         example: react
 *       - in: query
 *         name: author
 *         description: >-
 *           Comma-separated author IDs and/or slugs (user_nicename; a login matches only an account with no nicename) — the
 *           same identity the author feed resolves, so a public author archive can be listed without
 *           an authenticated users endpoint. Authorization may still narrow the result to the calling
 *           user's own posts when a non-published status is requested.
 *         schema:
 *           type: string
 *         example: jane-doe
 *     responses:
 *       200:
 *         description: A list of posts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Post'
 */
router.get('/', optionalAuth, asyncHandler(async (req: MaybeAuthenticatedRequest<Record<string, string>, unknown, ContentListQuery>, res: Response) => {
    // THE WHOLE STRING CLASS, ONCE — see LIST_QUERY_STRING_FIELDS. `?status[]=publish` reached every
    // comparison below as an Array (so `status === 'any'` and `status !== 'publish'` both answered the
    // wrong thing) and then reached the model, where the driver flattened it back into the string.
    const badQuery = firstNonStringField(req.query, LIST_QUERY_STRING_FIELDS);
    if (badQuery) return invalidParamType(res, badQuery);

    const {
        page = 1,
        per_page = 10,
        status = 'publish',
        type = 'post',
        author,
        search,
        orderby = 'date',
        order = 'desc',
        categories,
        tags
    } = req.query;

    // THE THREE FILTERS THE DOCUMENTATION HAS ALWAYS PROMISED, PARSED ONCE.
    //
    // `categories` and `tags` were destructured here and handed to NEITHER Post.findAllWithRelations
    // NOR Post.count, so `?categories=3` returned exactly what no filter returns — a listing that
    // answered a different question than the one it was asked, with a matching X-WP-Total to make it
    // look deliberate. `author` was worse than ignored: `parseInt('jane-doe', 10)` is NaN, NaN is
    // falsy, so an author SLUG silently widened the request to the whole site.
    //
    // Parsed before anything is authorized, and refused (not narrowed) when it cannot denote a row —
    // see the IDENTITY-LIST GRAMMAR above.
    const parsedFilters: Array<[string, IdentityParse]> = [
        ['categories', parseIdentityList(categories)],
        ['tags', parseIdentityList(tags)],
        ['author', parseIdentityList(author)],
    ];
    for (const [field, parsed] of parsedFilters) {
        if (!parsed.ok) return invalidParamValue(res, field, parsed.detail);
    }
    const categoriesFilter = (parsedFilters[0][1] as { ok: true; value?: IdentityList }).value;
    const tagsFilter = (parsedFilters[1][1] as { ok: true; value?: IdentityList }).value;
    const requestedAuthor = (parsedFilters[2][1] as { ok: true; value?: IdentityList }).value;

    // The LIST is the discovery half of the same surface: leaving it open let a caller enumerate every
    // nav_menu_item id (and then write its meta) without ever touching the menus API. Reject an
    // internal type here for the same reason the per-post routes 404 on it.
    //
    // THE TYPE IS RESOLVED ONCE AND THE RESOLVED VALUE IS WHAT THE QUERY GETS. The guard used to
    // inspect `type` through isRestExposedPostType, which normalizes with `String(type || 'post')` —
    // so `?type=` (empty) was CHECKED as 'post' and PASSED, while the raw `''` went on to
    // Post.findAllWithRelations/Post.count, which treat an empty value as "no type filter at all".
    // An ANONYMOUS `GET /posts?type=` therefore returned every nav_menu_item row with its
    // `_menu_item_url` meta — the exact enumeration this guard was added to stop, through the guard.
    // Same for `?type[]=post`: an Array stringifies to 'post' for the check and reaches the model as
    // an array. Resolving here means the checked value and the queried value are the same object.
    //
    // It rejects INTERNAL types, not unregistered ones — same rule as isHiddenFromRest, so listing and
    // reading agree about what exists. A type whose registration an admin removed must stay listable
    // or its content cannot be found, let alone migrated.
    const resolvedType = (type === undefined || type === null || type === '') ? 'post' : type;
    if (typeof resolvedType !== 'string' || isInternalPostType(resolvedType)) {
        return res.status(400).json({
            code: 'rest_invalid_post_type',
            message: `Invalid post type '${String(resolvedType)}'.`,
            data: { status: 400 }
        });
    }

    const limit = Math.min(parseInt(String(per_page), 10) || 10, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    // Map orderby to database column.
    //
    // PROTOTYPE-FREE, and looked up with hasOwnProperty — the OTHER half of the "a key is not just a
    // string" class (see RESERVED_META_KEYS in core/protected-meta). On a plain object literal,
    // `orderByMap['constructor']` answers with a FUNCTION rather than undefined, so `|| 'post_date'`
    // never fires and a caller chooses what reaches the model's ORDER BY. The model's own allowlist
    // contains the damage today; a lookup that cannot return an inherited member removes the question.
    const orderByMap: Record<string, string> = Object.assign(Object.create(null), {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id',
        menu_order: 'menu_order'
    });

    // Determine which statuses to show
    let includeStatuses: string[] | null = null;
    // SECURITY (BOLA): the per-post GET enforces an author/edit_others_posts gate on non-published
    // posts; the LIST path must do the same or it leaks every user's drafts/pending/private content.
    // A privileged caller (edit_others_posts / read_private_posts) may see others' unpublished posts;
    // an unprivileged logged-in user may only see THEIR OWN non-published posts, so we force the author
    // filter to their id whenever non-publish statuses are requested.
    //
    // The requested author selector is the STARTING point; every assignment below REPLACES it with a
    // concrete id, which is the pre-existing semantics of this gate and the reason it is safe: an
    // authorization that narrows to "your own posts" must not be intersectable with anything.
    let authorFilter: IdentityList | number | undefined = requestedAuthor;
    let effectiveStatus = status;
    const listPolicy = capsForType(resolvedType) || capsFor('post');
    const canReadAllOfType = !!(req.user
        && (req.user.can(listPolicy.editOthers) || req.user.can(listPolicy.readPrivate)));

    // showInRest controls addressability; public controls anonymous visibility. A private REST type
    // remains useful to its owners/editors, but a published row must not become public merely because
    // the lifecycle column says "publish".
    if (!listPolicy.publiclyReadable) {
        authorFilter = req.user
            ? (canReadAllOfType ? authorFilter : req.user.id)
            : -1; // User ids are positive; retain normal count/pagination response semantics.
    }
    if (req.user) {
        const isPrivileged = canReadAllOfType;
        // Logged in users can see their own drafts
        if (status === 'any') {
            // 'future' (scheduled) is part of the author-facing set: without it a scheduled post
            // simply vanished from the admin list until its publish moment.
            includeStatuses = ['publish', 'draft', 'pending', 'private', 'future'];
            if (!isPrivileged) {
                // Scope the unpublished content to the requesting user only.
                authorFilter = req.user.id;
            }
        } else if (status !== 'publish' && !isPrivileged) {
            // Asking for a specific non-publish status (draft/pending/private/future) without
            // privilege: only the caller's own posts of that status may be returned.
            authorFilter = req.user.id;
        }
    } else if (status !== 'publish') {
        // Anonymous callers may only ever list published content, regardless of requested status.
        effectiveStatus = 'publish';
    }

    // Use findAllWithRelations to batch-load post meta (avoids N+1 in the list path).
    const posts = await Post.findAllWithRelations({
        // resolvedType, NOT the raw query value — see the guard above.
        type: resolvedType,
        status: includeStatuses ? null : effectiveStatus,
        includeStatuses,
        author: authorFilter,
        categories: categoriesFilter,
        tags: tagsFilter,
        search,
        limit,
        offset,
        orderBy: orderByMap[orderby] || 'post_date',
        // SECURITY: Whitelist order direction to prevent injection
        order: ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'DESC'
    });

    // THE SAME FILTERS, VERBATIM. The count is what X-WP-Total/X-WP-TotalPages report, so a filter
    // applied to the rows and not here would announce pages the caller cannot reach.
    const total = await Post.count({
        type: resolvedType,
        status: includeStatuses ? null : effectiveStatus,
        includeStatuses,
        author: authorFilter,
        categories: categoriesFilter,
        tags: tagsFilter,
        search
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(await Promise.all(posts.map((post: any) => serializeVisibleContent(post, req.user))));
}));

/**
 * @swagger
 * /posts/slug/{slug}:
 *   get:
 *     summary: Get a single post by slug
 *     description: A slug is unique per post TYPE, not globally, so a post and a page may both own "about". Without a type the lookup runs post, then page, then untyped, and stops at the first candidate THIS caller may read - so a colleague's draft that happens to share the slug cannot take a published page off the public site. Authentication is optional and widens what counts as readable. Internal post types are never addressable here.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         required: false
 *         description: Narrow the lookup to one post type. An internal type is refused; an unregistered one stays addressable and simply matches nothing, so content whose custom type was removed can still be migrated.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The post
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: type is not a string, or it names an internal post type (rest_invalid_post_type)
 *       404:
 *         description: Nothing with that slug is visible to this caller. rest_post_invalid_id when a row exists but may not be read, rest_post_invalid_slug when nothing matches at all - both are 404, so neither answer confirms that a draft exists.
 */
router.get('/slug/:slug', optionalAuth, asyncHandler(async (req: MaybeAuthenticatedRequest<SlugParams, unknown, TypeQuery>, res: Response) => {
    // A SLUG IS UNIQUE PER TYPE, NOT GLOBALLY. generateUniqueSlug de-duplicates within one post_type,
    // so a post `about` and a page `about` is a legal, ordinary pair — and this route asked
    // Post.findBySlug(slug) with NO type, whose SQL is `WHERE post_name = ?` with no LIMIT ordering.
    // The public site therefore served whichever row the engine happened to return first: the same URL
    // could render the post today and the page after a VACUUM or an index change. This is the READ twin
    // of the importer defect (#18) — the same "look it up by an identity narrower than the one you
    // write with" shape, fixed there and left standing here.
    //
    // ?type= lets a caller that KNOWS what it wants say so (the /pages/<slug> route wants the page, not
    // whatever else shares the slug); it is validated against the same INTERNAL-type rule as the list,
    // so an internal type cannot be addressed by slug either.
    // The declared type must be a STRING before it is either checked or used: `?type[]=post` reaches
    // isRestExposedPostType as an Array that stringifies to 'post' and reaches Post.findBySlug as an
    // Array — the same guard/sink mismatch the LIST had.
    // AND THE RULE IS THE SAME ONE THE LIST USES. This guard asked isRestExposedPostType, which
    // answers false to an UNREGISTERED type as well as an internal one — so after a `DELETE
    // /types/book` the list still returned the rows (`isInternalPostType`) while this route answered
    // 400, two guards contradicting each other about the same invariant, and the 400 landed on exactly
    // the tool an admin would use to migrate the orphaned content. Internal is refused; unregistered
    // is addressable and simply resolves to nothing if no row matches.
    const requestedType = req.query.type;
    if (requestedType !== undefined && requestedType !== '' && (typeof requestedType !== 'string' || isInternalPostType(requestedType))) {
        return res.status(400).json({
            code: 'rest_invalid_post_type',
            message: `Invalid post type '${String(requestedType)}'.`,
            data: { status: 400 }
        });
    }

    /**
     * IDENTITY IS RESOLVED AMONG THE CANDIDATES THIS CALLER MAY SEE — not first, and filtered after.
     *
     * THE CLASS: a lookup that picks ONE row by an identity narrower than the one that is then
     * authorized. The fixed precedence (post → page → untyped) made the choice deterministic, which
     * was the point, but it chose before asking whether the chosen row is VISIBLE: since slugs are
     * unique PER TYPE, anyone who saved a draft named `about` took the published PAGE `about` off the
     * public site — this route found the draft, the visibility gate below refused it, and the page was
     * never consulted. A 404 on a live URL, caused by an ordinary editorial action, with no warning.
     *
     * So the precedence now runs over candidates and stops at the first one the caller may READ. The
     * anonymous answer is still deterministic (only published rows qualify) and an editor still sees
     * their draft first, because for them the draft IS visible.
     */
    const isVisible = (p: any) => !isHiddenFromRest(p) && canReadPostRecord(req.user, p);

    const lookups: Array<string | undefined> = requestedType
        ? [requestedType as string]
        : ['post', 'page', undefined];

    let post: any = null;
    let hiddenCandidate: any = null;
    for (const t of lookups) {
        const candidate = t === undefined
            ? await Post.findBySlug(req.params.slug)
            : await Post.findBySlug(req.params.slug, t);
        if (!candidate) continue;
        if (isVisible(candidate)) { post = candidate; break; }
        if (!hiddenCandidate) hiddenCandidate = candidate;
    }

    if (!post) {
        // Nothing visible. "Exists but you may not read it" and "does not exist" answer the same 404 —
        // the codes below only preserve the two bodies this route has always returned.
        return res.status(404).json(hiddenCandidate && !isHiddenFromRest(hiddenCandidate)
            ? { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } }
            : { code: 'rest_post_invalid_slug', message: 'Invalid post slug.', data: { status: 404 } });
    }

    res.json(await serializeVisibleContent(post, req.user));
}));

/**
 * @swagger
 * /posts/{id}:
 *   get:
 *     summary: Get a single post by id
 *     description: Authentication is optional and decides what counts as readable - an anonymous caller sees published content only. A post that exists but may not be read answers the same 404 as one that does not exist, so the endpoint never confirms that a draft is there. Internal post types are not addressable here.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The post
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       404:
 *         description: No such post, an id that is not a plain in-range integer, an internal post type, or a post this caller may not read (rest_post_invalid_id)
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: MaybeAuthenticatedRequest<IdParams>, res: Response) => {
    const post = await Post.findById(parseInt(req.params.id, 10));

    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }

    // Check if user can view non-published posts
    if (!canReadPostRecord(req.user, post)) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    res.json(await serializeVisibleContent(post, req.user));
}));

/**
 * @swagger
 * /posts:
 *   post:
 *     summary: Create a new post
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [publish, future, draft, pending]
 *               date:
 *                 type: string
 *                 format: date-time
 *                 description: Publish date. A 'publish' with a future date is stored as 'future' and auto-publishes at that moment.
 *     responses:
 *       201:
 *         description: Post created
 *       400:
 *         description: Missing title
 *       403:
 *         description: Forbidden
 */
router.post('/', authenticate, asyncHandler(async (req: AuthenticatedRequest<Record<string, string>, ContentCreateInput>, res: Response) => {
    // THE WHOLE STRING CLASS, ONCE, BEFORE ANY COMPARISON — see POST_BODY_STRING_FIELDS. `status:
    // ['publish']` from a contributor used to clear the publish gate (an Array is not 'publish') and
    // then land in post_status as `publish`, because the driver flattens it: 201, live on the public
    // site. Same shape for `slug`, `comment_status`, `type`, `date` and `language`.
    const badField = firstNonStringField(req.body, POST_BODY_STRING_FIELDS);
    if (badField) return invalidParamType(res, badField);

    const {
        title,
        content,
        excerpt,
        status = 'draft',
        type = 'post',
        slug,
        parent,
        menu_order,
        comment_status,
        categories,
        tags,
        meta,
        date,
        language
    } = req.body;

    if (!title) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Title is required.',
            data: { status: 400 }
        });
    }

    // Type-aware capability gate: an unknown type is rejected, and the caller must hold the EDIT cap for
    // THIS type's family (a post-only author cannot create a page). The old route gate was can('edit_posts')
    // regardless of type, and the publish check below only tested publish_posts (audit HIGH).
    //
    // AN INTERNAL TYPE IS REJECTED THE SAME WAY AN UNKNOWN ONE IS. The old check only asked "is it
    // registered", and `revision` IS registered — with no capability_type, so it fell into the plain
    // `post` family and a CONTRIBUTOR could mint revision rows. That is not a cosmetic forgery: a
    // fabricated revision carries `now` as post_modified while genuine ones copy the parent's, so ten
    // of them pointing at someone else's page make the next ordinary save prune the entire real
    // history (limitRevisions deletes oldest-first) and leave only the attacker's.
    //
    // AND THE RESOLVED TYPE IS THE ONE STORED. capsForType/isRestExposedPostType both normalize with
    // `String(type || 'post')`, so `type: ''` was CHECKED as 'post' and passed — and then reached
    // Post.create as `''`, creating a row with an EMPTY post_type that no typed query can ever find
    // again. `type: ['post']` was the array twin. Resolve once, reject a non-string, store the resolved
    // value.
    const createType = (type === undefined || type === null || type === '') ? 'post' : type;
    const caps = typeof createType === 'string' ? capsForType(createType) : null;
    if (!caps || !isRestExposedPostType(createType)) {
        return res.status(400).json({ code: 'rest_invalid_post_type', message: `Invalid post type '${String(createType)}'.`, data: { status: 400 } });
    }
    if (!req.user.can(caps.edit)) {
        return res.status(403).json({ code: 'rest_cannot_create', message: `You are not allowed to create content of type '${createType}'.`, data: { status: 403 } });
    }

    const createContract = contentContractForType(createType);
    if (createContract) {
        const checked = createContract.validateCreate(req.body);
        if (!checked.ok) return invalidContentContract(res, checked.issues);
    }

    // `parent` was passed to Post.create() verbatim: a post could be attached to ANY row by id, with no
    // check that the caller may touch that row. Parenthood is a write on the parent (it changes what
    // the parent's children query returns), so it takes the parent's own edit gate.
    //
    // AND THE AUTHORIZED VALUE IS THE ONE THAT IS WRITTEN. The first version of this gate ran
    // `parseInt(parent, 10)` and then handed the RAW `parent` to Post.create — two representations of
    // one field. `parseInt("0.000007e6")` is 0, so `parentId > 0` was false and the parent was never
    // checked at all, while SQLite's INTEGER affinity read the very same string as 7 and stored a
    // post_parent of someone else's published page: a 403 became a 201. `"7e3"` was the other half —
    // authorized against post 7, stored as 7000. toNonNegativeInt refuses both (digits only) and, when
    // it accepts, returns the NUMBER that goes into the column, so gate and sink cannot disagree.
    // It also removes MySQL's STRICT_TRANS_TABLES failure: the '' the route itself declares legal
    // ("<option value=''>None</option>") is normalized to 0 here instead of reaching post_parent as an
    // empty string and raising ERROR 1366.
    const hasParent = parent !== undefined && parent !== null && parent !== '';
    const parentId = hasParent ? toNonNegativeInt(parent) : 0;
    if (parentId === null) {
        return res.status(400).json({ code: 'rest_invalid_post_parent', message: 'Invalid post parent.', data: { status: 400 } });
    }
    if (parentId > 0) {
        const parentPost = await Post.findById(parentId);
        if (!parentPost || isHiddenFromRest(parentPost)) {
            return res.status(400).json({ code: 'rest_invalid_post_parent', message: 'Invalid post parent.', data: { status: 400 } });
        }
        if (!canEditPostRecord(req.user, parentPost)) {
            return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot attach content to that parent.', data: { status: 403 } });
        }
    }

    // THE SLUG IS PRODUCED, NOT ACCEPTED. Post.create used to take the body's `slug` VERBATIM
    // (`slug || sanitizeTitle(title)`) while PUT ran the same field through sanitizeTitle inside
    // Post.update: two writers of post_name, two representations, and the create side stored
    // `Not A Slug/../%00` and 300-character values unchanged — the latter an ERROR 1406 (a 500) on
    // MySQL, where post_name is narrowed to VARCHAR(255) for its index. One producer for both.
    // The LENGTH bound itself lives one level down, in Post.generateUniqueSlug, because a caller that
    // legitimately keeps a foreign slug verbatim (the WXR importer) must still be bounded.
    const requestedSlug = typeof slug === 'string' && slug.trim() !== ''
        ? (sanitizeTitle(slug) || undefined)
        : undefined;

    // menu_order is the same numeric column shape: absent keeps the model default, '' means 0, and a
    // non-numeric value is a 400 rather than a driver-dependent surprise.
    const menuOrderValue = menu_order === undefined || menu_order === null || menu_order === ''
        ? 0
        : toInt(menu_order);
    if (menuOrderValue === null) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid menu_order.', data: { status: 400 } });
    }

    // Check if user can publish THIS type; if not, downgrade to pending (needs review). 'future' IS
    // deferred publishing (the model stores a future-dated 'publish' as 'future' and auto-flips it
    // live), so it must clear the same bar — otherwise scheduling would be a side door around the gate.
    const mayPublish = req.user.can(caps.publish);
    let postStatus = status;
    if ((status === 'publish' || status === 'future') && !mayPublish) {
        postStatus = 'pending';
    }

    // THE DATE IS THE OTHER HALF OF THE SAME GATE — see the identical block in PUT /:id.
    // Downgrading only the STATUS still let the caller write post_date/post_date_gmt, and an explicit
    // date is the ONLY thing that schedules: the model resolves a future date into 'future' by itself.
    // A caller who may not publish may not choose WHEN the post goes live either, so the date is
    // dropped rather than forwarded (absent → the model stamps "now", the same as any plain draft).
    const requestedDate = mayPublish ? date : undefined;

    // Validate/sanitize the complete bag BEFORE Post.create. A rejected `_puck_data` tree must not
    // leave behind a post row with only half of the request applied.
    let safeMetaEntries: Array<[string, any]>;
    try {
        safeMetaEntries = sanitizeWritableMetaBag(meta, createType);
    } catch (error) {
        if (rejectOverComplexMeta(res, error)) return;
        throw error;
    }

    const post = await runContentMutation(async () => {
        const created = await Post.create({
            authorId: req.user.id,
            title: sanitizeHtml(title),
            content: sanitize(content),
            // En la CREACIÓN no hay valor anterior que preservar, así que "ausente" y "vacío" son lo mismo:
            // sanitize-html devuelve '' para undefined/null, que es justo el defecto de Post.create.
            excerpt: sanitizeHtml(excerpt),
            status: postStatus,
            type: createType,
            // The PRODUCED slug (see above), never the raw body field.
            slug: requestedSlug,
            // The value the gate above authorized, as a NUMBER — never the raw body field. See the
            // toNonNegativeInt comment: the two used to differ, and the difference was the bypass.
            parent: parentId,
            // Same normalization, same reason (minus the authorization): `menu_order: ""` reached
            // menu_order as an empty string and MySQL under STRICT_TRANS_TABLES rejects it with a 500.
            menuOrder: menuOrderValue,
            commentStatus: comment_status,
            date: requestedDate,
            // MULTILINGUAL (opt-in): the model canonicalizes a BCP-47 tag, or stores NULL. Absent → NULL.
            language
        });

        if (categories && Array.isArray(categories)) {
            await Post.setTerms(created.id, categories, 'category');
        }
        if (tags && Array.isArray(tags)) {
            await Post.setTerms(created.id, tags, 'post_tag');
        }
        // A BAG IS A PLAIN OBJECT. The sanitizer already rejected/skipped invalid keys before this
        // transaction, so all metadata joins the same atomic boundary.
        for (const [key, value] of safeMetaEntries) {
            await Post.updateMeta(created.id, key, value);
        }

        // Initial history is required state, not fire-and-forget. A failure rolls back the post,
        // terms, metadata and its not-yet-visible outbox event together.
        await saveRevision(created.id);
        return created;
    });

    await recordAudit(req.user.id, 'post.create', 'post', post.id, {
        type: post.postType, status: post.postStatus, slug: post.postName
    });
    // Born public — see the "single exception" note above the recordAudit import.
    if (isPublicStatus(post.postStatus)) {
        await recordAudit(req.user.id, 'post.publish', 'post', post.id, {
            type: post.postType, from: 'new', to: post.postStatus, slug: post.postName
        });
    }

    res.status(201).json(await serializeVisibleContent(post, req.user));
}));

/**
 * @swagger
 * /posts/{id}:
 *   put:
 *     summary: Update an existing post
 *     tags: [Posts]
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
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Post updated
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Post not found
 */
router.put('/:id', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams, ContentUpdateInput>, res: Response) => {
    // The TWIN of the check in POST / — the same table, the same reason, and the field that mattered
    // (`status`) was reachable through both. Closing one and leaving the other is how this class has
    // survived every wave so far.
    const badField = firstNonStringField(req.body, POST_BODY_STRING_FIELDS);
    if (badField) return invalidParamType(res, badField);

    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }

    // Type-aware permissions: post.type picks the capability family (a post-only author must not edit a
    // page). Editing an ALREADY-PUBLISHED post additionally requires edit_published_<type>s — a contributor
    // could otherwise rewrite or unpublish their own editor-published post via plain edit_posts (audit LOW).
    // The three-part rule now lives in core/post-capabilities so the meta route enforces the SAME one.
    const pcaps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    if (!canEditPostRecord(req.user, post)) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this post.',
            data: { status: 403 }
        });
    }

    // Orphaned rows whose custom type was unregistered remain manageable through the historical
    // fallback. Registered types are checked against their executable F1 contract.
    const updateContract = contentContractForType(post.type || post.postType || 'post');
    if (updateContract) {
        const checked = updateContract.validateUpdate(req.body);
        if (!checked.ok) return invalidContentContract(res, checked.issues);
    }

    const {
        title,
        content,
        excerpt,
        status,
        slug,
        parent,
        menu_order,
        comment_status,
        categories,
        tags,
        meta,
        autosave,
        date,
        language
    } = req.body;

    // Re-parenting takes the PARENT's edit gate too, exactly as creation does — the twin surface of the
    // same write. Without it, `parent` is a way to graft a post under a record you cannot touch.
    //
    // Normalized ONCE, and the normalized number is what Post.update receives — see the identical
    // block in POST / for why validating parseInt() while writing the raw string was the bypass.
    // ABSENT is not the same as EMPTY here: `parent` omitted must leave post_parent alone (undefined),
    // while an explicit '' / null is the editor saying "no parent" and writes 0.
    const parentProvided = parent !== undefined;
    const hasParent = parent !== undefined && parent !== null && parent !== '';
    const newParentId = hasParent ? toNonNegativeInt(parent) : 0;
    if (newParentId === null) {
        return res.status(400).json({ code: 'rest_invalid_post_parent', message: 'Invalid post parent.', data: { status: 400 } });
    }
    if (newParentId > 0 && newParentId !== (post.postParent || 0)) {
        const parentPost = await Post.findById(newParentId);
        if (!parentPost || isHiddenFromRest(parentPost) || parentPost.id === postId) {
            return res.status(400).json({ code: 'rest_invalid_post_parent', message: 'Invalid post parent.', data: { status: 400 } });
        }
        if (!canEditPostRecord(req.user, parentPost)) {
            return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot attach content to that parent.', data: { status: 403 } });
        }
    }

    // menu_order: same shape, same normalization as POST / (absent → untouched, '' → 0).
    const menuOrderProvided = menu_order !== undefined;
    const newMenuOrder = menu_order === undefined || menu_order === null || menu_order === ''
        ? 0
        : toInt(menu_order);
    if (newMenuOrder === null) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid menu_order.', data: { status: 400 } });
    }

    // Check if user can publish THIS type ('future' = deferred publish, same bar — see POST /).
    const mayPublish = req.user.can(pcaps.publish);
    let postStatus = status;
    if ((status === 'publish' || status === 'future') && !mayPublish) {
        postStatus = post.postStatus === 'publish' ? 'publish' : 'pending';
    }

    // THE DATE IS A PUBLISHING CAPABILITY WITH NO GATE OF ITS OWN, so it takes this one.
    //
    // The block above downgraded the STATUS and then forwarded `date` untouched, and an explicit date
    // is the ONE thing that schedules — Post.update writes post_date/post_date_gmt from it and lets
    // resolveScheduledStatus turn the result into 'future'. Two consequences, both reachable without
    // the publish capability:
    //   • a contributor stamps post_date_gmt in 2099 on their own draft, so the entry an editor later
    //     approves is dated (and ordered, and fed to feeds/sitemaps) at a moment nobody chose;
    //   • worse, `date` alone needs NO status at all: Post.update re-evaluates the CURRENT status
    //     against the new date, so a future date on a PUBLISHED post silently flips it to 'future' —
    //     unpublishing live content with nothing but an edit capability.
    // Hence the test is the CAPABILITY, not the shape of the request: no publish cap → no date. Absent
    // is not empty here (Post.update only touches the date columns when the key arrives non-empty), so
    // dropping it leaves the stored date exactly as it was.
    const requestedDate = mayPublish ? date : undefined;

    // The metadata belongs to this same logical write. Sanitize it before the recovery snapshot and
    // before Post.update, otherwise rejecting an over-complex page tree would still change the row.
    let safeMetaEntries: Array<[string, any]>;
    try {
        safeMetaEntries = sanitizeWritableMetaBag(meta, post.postType);
    } catch (error) {
        if (rejectOverComplexMeta(res, error)) return;
        throw error;
    }

    // SNAPSHOT BEFORE THE WRITE — the same instant POST /posts/:id/meta snapshots at.
    //
    // The two write surfaces disagreed: the meta route captured the state being DESTROYED while this
    // one captured the state that REPLACED it, so one revision list mixed "before" and "after"
    // snapshots depending on which route a save happened to use, and "restore the latest revision"
    // meant two different things. One semantics, chosen for the property finding #7 asked for: every
    // destructive write leaves a recovery point FOR WHAT IT DESTROYED, including the first edit to a
    // post that has no revision history yet (an imported or seeded post — where an after-snapshot
    // recovers nothing at all). AWAITED, not fire-and-forget: a snapshot racing the UPDATE it is
    // supposed to precede would silently become an after-snapshot again.
    // Editor autosaves still skip it so a background save every few seconds doesn't churn through the
    // revision cap (default 10) and wipe the user's meaningful history.
    // AND IT FAILS CLOSED, like the meta route: if the recovery point cannot be created, the
    // destructive write does not happen. Logging and writing anyway is the failure mode the snapshot
    // exists to prevent, performed silently.
    try {
        await runContentMutation(async () => {
            if (autosave !== true) {
                try { await saveRevision(postId); }
                catch (error: any) {
                    error.contentRevisionFailure = true;
                    throw error;
                }
            }

            await Post.update(postId, {
                title: title ? sanitizeHtml(title) : undefined,
                content: content ? sanitize(content) : undefined,
                // AUSENTE ≠ VACÍO. Only an absent key leaves the stored excerpt untouched.
                excerpt: excerpt === undefined || excerpt === null ? undefined : sanitizeHtml(String(excerpt)),
                status: postStatus,
                slug,
                parent: parentProvided ? newParentId : undefined,
                menuOrder: menuOrderProvided ? newMenuOrder : undefined,
                commentStatus: comment_status,
                date: requestedDate,
                language
            });

            if (categories && Array.isArray(categories)) {
                await Post.setTerms(postId, categories, 'category');
            }
            if (tags && Array.isArray(tags)) {
                await Post.setTerms(postId, tags, 'post_tag');
            }
            for (const [key, value] of safeMetaEntries) {
                await Post.updateMeta(postId, key, value);
            }
        });
    } catch (error: any) {
        if (!error?.contentRevisionFailure) throw error;
        console.error('Failed to save revision before update:', error);
        return res.status(500).json({
            code: 'rest_revision_failed',
            message: 'Could not snapshot the current version; the write was not applied.',
            data: { status: 500 }
        });
    }

    // (The revision snapshot is taken BEFORE the write — see the block above Post.update.)

    const fresh = await Post.findById(postId);
    if (!fresh) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // THE TRANSITION IS READ FROM THE STORED ROW, NOT FROM THE REQUEST. `status` in the body is a wish:
    // the publish gate above may have downgraded it to 'pending', and Post.update re-evaluates a
    // 'publish' with a future date into 'future'. Comparing the pre-write status with what is actually
    // in the table is the only way the log records what HAPPENED instead of what was asked for.
    const wasStatus = post.postStatus;
    const nowStatus = fresh.postStatus;
    const transition = { type: fresh.postType, from: wasStatus, to: nowStatus, slug: fresh.postName };
    if (wasStatus === 'trash' && nowStatus !== 'trash') {
        await recordAudit(req.user.id, 'post.restore', 'post', postId, transition);
    } else if (nowStatus === 'trash' && wasStatus !== 'trash') {
        await recordAudit(req.user.id, 'post.trash', 'post', postId, transition);
    } else if (isPublicStatus(nowStatus) && !isPublicStatus(wasStatus)) {
        await recordAudit(req.user.id, 'post.publish', 'post', postId, transition);
    } else if (autosave !== true) {
        // An ordinary edit. EDITOR AUTOSAVES ARE EXCLUDED, exactly as they are excluded from the
        // revision snapshot a few lines up: they are produced by a timer, not by a decision, and one
        // open tab emits thousands a day — enough to bury every deliberate action in the log and to
        // outpace the retention prune. A save that MOVES THE STATUS still lands, autosave or not,
        // through the three branches above; only the "nothing visible changed" case is dropped.
        await recordAudit(req.user.id, 'post.update', 'post', postId, transition);
    }

    res.json(await serializeVisibleContent(fresh, req.user));
}));

/**
 * @swagger
 * /posts/{id}:
 *   delete:
 *     summary: Delete a post
 *     tags: [Posts]
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
 *         schema:
 *           type: boolean
 *         description: Whether to bypass trash and force deletion
 *     responses:
 *       200:
 *         description: Post deleted
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Post not found
 */
router.delete('/:id', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams, unknown, ForceQuery>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    // Internal types 404 here too — `?force=true` on a nav_menu_item really removed it from the site's
    // navigation, and DELETE is the one verb where "it only trashed it" was never a mitigation.
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }

    // Type-aware permissions: post.type picks the capability family, and deleting an already-published
    // post additionally requires delete_published_<type>s (mirrors the edit gate).
    if (!canDeletePostRecord(req.user, post)) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot delete this post.',
            data: { status: 403 }
        });
    }

    // `?force=true&force=true` used to answer FALSE here — an Array is not the string 'true' — so the
    // caller who asked for a permanent delete got a trash and a 200 saying it worked. There is no
    // value a caller "means" by sending the flag twice, and guessing one would let anyone who can
    // append to this URL decide between trash and unrecoverable: refuse the request instead.
    const force = scalarQueryParam(req.query.force, 'force') === 'true';
    await Post.delete(postId, force);

    // `?force=true` is unrecoverable and a plain DELETE is a trash: two different events, and the audit
    // log is the only place that keeps the difference after the row is gone. Recorded with the state the
    // post HAD, since for a forced delete there is nothing left to read afterwards. Spelled as two
    // calls rather than one with a conditional action, so the catalogue gate in the audit test can read
    // both names straight out of the source.
    const gone = { type: post.postType, from: post.postStatus, slug: post.postName };
    if (force) {
        await recordAudit(req.user.id, 'post.delete', 'post', postId, { ...gone, to: 'deleted' });
    } else {
        await recordAudit(req.user.id, 'post.trash', 'post', postId, { ...gone, to: 'trash' });
    }

    if (force) {
        res.json({ deleted: true, previous: await serializeVisibleContent(post, req.user) });
    } else {
        const fresh = await Post.findById(postId);
        if (!fresh) {
            return res.status(404).json({
                code: 'rest_post_invalid_id',
                message: 'Invalid post ID.',
                data: { status: 404 }
            });
        }
        res.json(await serializeVisibleContent(fresh, req.user));
    }
}));


/**
 * @swagger
 * /posts/{id}/meta:
 *   post:
 *     summary: Write one post meta key
 *     description: A single-key write is an explicit statement of intent, so a key the server owns is REFUSED rather than silently skipped. The key must be a string - an array is refused, not coerced - non-empty, within the column bound, and never a reserved name. Authorization is the SAME gate as PUT /posts/{id}, edit_published capability included; the one documented exception is the narrow set of non-content keys such as the editorial review thread, where the published-post rule is not applied because writing them changes nothing a visitor can see. A revisionable key is snapshotted BEFORE the write and the write is abandoned if that snapshot fails, so a content write always leaves a recovery point. HTML- and URL-bearing values are sanitized on write.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key]
 *             properties:
 *               key:
 *                 type: string
 *                 description: The meta key.
 *               value:
 *                 description: Any JSON value. An object or an array is measured against the meta complexity bounds before it is sanitized.
 *     responses:
 *       200:
 *         description: The stored key and its sanitized value
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 key:
 *                   type: string
 *                   description: The STORAGE key, which differs from the key sent when a WordJS-owned alias was resolved.
 *                 value:
 *                   description: The value as stored, after sanitizing.
 *                 post_id:
 *                   type: integer
 *       400:
 *         description: The key is missing or not a string (rest_missing_param), or it is reserved or longer than the column allows (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: This caller may not edit the post (rest_forbidden), or the key is server-managed (rest_protected_meta)
 *       404:
 *         description: No such post, a malformed id, or an internal post type (rest_post_invalid_id)
 *       413:
 *         description: The value is past the meta complexity bounds (rest_meta_value_too_complex)
 *       500:
 *         description: The pre-write revision snapshot failed, so the write was NOT applied (rest_revision_failed)
 */
router.post('/:id/meta', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams, MetaWriteBody>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    // Internal types are not addressable here. THIS is where an editor rewrote `_menu_item_url` on a
    // nav_menu_item — author_id 0 never matches the caller, so the gate below took the editOthers
    // branch, which an editor holds — and pointed the header of every page at a phishing domain.
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }

    // SECURITY: Ownership check (prevents IDOR). This route was gated by authenticate only, letting any
    // logged-in user write arbitrary meta on ANY post.
    //
    const { key, value } = req.body || {};

    // THE KEY MUST BE A STRING, and the type check comes BEFORE any value check.
    //
    // `if (!key)` accepted an Array. Every guard downstream is a string comparison —
    // isProtectedPostMeta (typeof check), sanitizeMetaValue (`key === '_puck_data'`),
    // isRevisionableMeta (typeof check) — so `{"key":["_wp_attached_file"]}` answered "not protected,
    // not revisionable, nothing to sanitize" to all three. The DRIVERS, however, flatten a
    // single-element array parameter: better-sqlite3 binds it as the string and mysql2 formats it
    // through arrayToList, so the UPDATE landed on the REAL `_wp_attached_file` row. One value for the
    // guards, another for the sink. Three bypasses, one cause, one fix: refuse the type here.
    //
    // AND THE TYPE WAS ONLY THE FIRST MEMBER OF THAT CLASS. `'__proto__'` IS a string, so it passed —
    // and `Post.getAllMeta` builds its map by ASSIGNING the key into an object literal, where that
    // name creates no property at all: it replaces the map's prototype with an attacker-chosen object,
    // so every key with no row of its own (Media reads `allMeta['_wp_attached_file']` exactly that way)
    // resolves through the prototype chain while the API response looks clean. The whole FORM rule —
    // type, emptiness, the reserved names, the column's 255-character bound — now lives in ONE place
    // (core/protected-meta.metaKeyProblem) that all three meta writers call.
    const keyProblem = metaKeyProblem(key);
    if (keyProblem !== null) {
        const message = keyProblem === 'reserved'
            ? 'Meta key is reserved.'
            : keyProblem === 'too_long'
                ? 'Meta key is too long.'
                : 'Meta key is required and must be a string.';
        return res.status(400).json({
            code: keyProblem === 'type' || keyProblem === 'empty' ? 'rest_missing_param' : 'rest_invalid_param',
            message,
            data: { status: 400 }
        });
    }

    // IT USES THE SAME GATE AS PUT /posts/:id, not a copy of two thirds of it. The inline check here
    // rebuilt the type + ownership halves and OMITTED edit_published_<type>s — while `_puck_data`,
    // written through this exact route, IS the public body of the page. A contributor whose draft an
    // editor published got 403 from PUT and 200 from here, and replaced the approved page wholesale.
    // Three surfaces (PUT, revisions restore, collab) enforced all three parts; only this one did not.
    //
    // THE ONE DOCUMENTED EXCEPTION is NON_CONTENT_META_KEYS. Applying the published-post rule to EVERY
    // key was itself a regression: the only real client of this route writes `_wjs_review_comments`,
    // the editorial review thread, and a contributor could no longer answer a reviewer on their own
    // entry once it was published. The allowlist is explicit and narrow — a key is on it only when
    // writing it changes nothing a visitor can see — so the downgrade is a decision, not a hole.
    // Resolve WordJS-owned aliases before the policy decision as well as before SQL. Otherwise an
    // alias of `_wjs_review_comments` updates that row on MySQL but is treated as public content here.
    const storageKey = storageMetaKey(key as string, post.postType);
    const gate = NON_CONTENT_META_KEYS.has(storageKey) ? canEditPostIgnoringPublished : canEditPostRecord;
    if (!gate(req.user, post)) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this post.',
            data: { status: 403 }
        });
    }

    // SECURITY: server-owned keys are refused OUTRIGHT on this surface (unlike the `meta` bag, where a
    // skip mirrors models/User.ts): a single-key write is an explicit statement of intent, so answering
    // 200 to a request that wrote nothing would be a lie. `_wp_attached_file` is the file path
    // Media.delete() unlinks — writing it here was the arbitrary-file-delete source.
    if (isProtectedPostMeta(key)) {
        return res.status(403).json({
            code: 'rest_protected_meta',
            message: `The meta key '${key}' is managed by the server and cannot be set.`,
            data: { status: 403 }
        });
    }

    // SECURITY: sanitize HTML/URL-bearing meta (e.g. _puck_data) on write — see sanitizeMetaValue.
    let safeValue: any;
    try {
        if (value && typeof value === 'object') assertMetaValueWithinLimits(value);
        safeValue = sanitizeMetaValue(storageKey, value);
    } catch (error) {
        if (rejectOverComplexMeta(res, error)) return;
        throw error;
    }

    // A CONTENT write must leave a recovery point. This route never called saveRevision, so replacing
    // `_puck_data` through it destroyed the previous page tree with nothing to roll back to — while the
    // very same bytes sent through PUT /posts/:id snapshot first. The revisionable set is the one
    // core/revisions actually captures, so "worth a snapshot" and "in the snapshot" are one decision.
    // Snapshot BEFORE the write, and await it: the value being overwritten is what we are preserving.
    // PUT /posts/:id now snapshots at the same instant, so a revision means ONE thing on both surfaces.
    //
    // AND IT FAILS CLOSED. Logging the error and writing anyway destroyed the previous tree with no
    // recovery point — the failure mode this whole block exists to prevent, silently. If the safety net
    // cannot be created, the destructive write does not happen.
    try {
        await runContentMutation(async () => {
            if (isRevisionableMeta(storageKey, post.postType)) {
                try { await saveRevision(postId); }
                catch (error: any) {
                    error.contentRevisionFailure = true;
                    throw error;
                }
            }

            await Post.updateMeta(postId, storageKey, safeValue);

            // Public/content metadata is a post update. The event is written beside the meta and
            // revision, then dispatched only after the transaction commits. Editorial comments are
            // the explicit non-content exception and therefore produce no public event.
            if (!NON_CONTENT_META_KEYS.has(storageKey)) {
                recordContentEvent('post.updated', postId, {
                    data: { meta: { [storageKey]: safeValue } },
                    previousStatus: post.postStatus,
                    previousType: post.postType,
                    previousSlug: post.postName,
                });
            }
        });
    } catch (error: any) {
        if (!error?.contentRevisionFailure) throw error;
        console.error('Failed to save revision before meta write:', error);
        return res.status(500).json({
            code: 'rest_revision_failed',
            message: 'Could not snapshot the current version; the write was not applied.',
            data: { status: 500 }
        });
    }

    res.json({
        key: storageKey,
        value: safeValue,
        post_id: postId
    });
}));

/**
 * @swagger
 * /posts/{id}/meta:
 *   get:
 *     summary: Read the full meta map of a post
 *     description: The read twin of the write gate. Authentication is optional and the same visibility rule as the single-post read applies - without it the SEO drafts, internal notes, plugin-stashed data and trash bookkeeping of draft, private, pending and trashed posts would be world-readable. Internal post types are not addressable here.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Every meta key of the post, as a flat map of storage key to value
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       404:
 *         description: No such post, a malformed id, an internal post type, or a post this caller may not read (rest_post_invalid_id)
 */
router.get('/:id/meta', optionalAuth, asyncHandler(async (req: MaybeAuthenticatedRequest<IdParams>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    // The READ twin of the write gate above: a nav_menu_item is published, so without this any
    // anonymous caller could dump its meta and enumerate the ids the write surface used to accept.
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }

    // SECURITY (IDOR): mirror the single-post read gate. Without this, anyone could read the full meta
    // map (SEO drafts, internal notes, plugin-stashed data, _wp_trash_meta_status, etc.) of draft/
    // private/pending/trashed posts, or other users' content.
    if (!canReadPostRecord(req.user, post)) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    res.json(await Post.getAllMeta(postId));
}));

// ---------------------------------------------------------------------------
// MULTILINGUAL (opt-in) — set a post's language, and link/query its translations.
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /posts/{id}/language:
 *   put:
 *     summary: Set or clear a post's content language
 *     description: A non-empty value must parse as a BCP-47 tag. null or an empty string clears the language back to unset. The response is the post as it now stands.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               language:
 *                 type: string
 *                 nullable: true
 *                 description: A BCP-47 tag. null or an empty string clears it.
 *                 example: pt-BR
 *     responses:
 *       200:
 *         description: The post, with its language applied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: The value is not a valid BCP-47 tag (rest_invalid_language)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: This caller may not edit the post (rest_forbidden)
 *       404:
 *         description: No such post, a malformed id, or an internal post type (rest_post_invalid_id)
 */
router.put('/:id/language', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams, LanguageBody>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);
    // Internal types are not addressable through the generic /posts surface (see isHiddenFromRest).
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }
    if (!canEditPostRecord(req.user, post)) {
        return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot edit this post.', data: { status: 403 } });
    }

    const { language } = req.body;
    // A non-empty value MUST parse to a BCP-47 tag; null/'' clears the language back to NULL.
    if (language != null && language !== '' && !parseLanguageTag(language)) {
        return res.status(400).json({ code: 'rest_invalid_language', message: 'Invalid BCP-47 language tag.', data: { status: 400 } });
    }

    await runContentMutation(async () => {
        await Post.setLanguage(postId, language);
    });
    const fresh = await Post.findById(postId);
    res.json(await serializeVisibleContent(fresh, req.user));
}));

/**
 * @swagger
 * /posts/{id}/translations:
 *   get:
 *     summary: List this post's translations in other languages
 *     description: Authentication is optional. Every sibling is put through the same read gate as the single-post route, so an anonymous caller sees published translations only while the owner or an editor also sees the unpublished ones. The post itself is never in the list.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: This post's language and translation group, plus the siblings this caller may read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 language:
 *                   type: string
 *                   nullable: true
 *                 group:
 *                   type: string
 *                   nullable: true
 *                 translations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       language:
 *                         type: string
 *                       slug:
 *                         type: string
 *                       type:
 *                         type: string
 *                       status:
 *                         type: string
 *       404:
 *         description: No such post, a malformed id, an internal post type, or a post this caller may not read (rest_post_invalid_id)
 */
router.get('/:id/translations', optionalAuth, asyncHandler(async (req: MaybeAuthenticatedRequest<IdParams>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);
    // Internal types are not addressable through the generic /posts surface (see isHiddenFromRest).
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }
    // Mirror the single-post read gate for a non-published post.
    if (!canReadPostRecord(req.user, post)) {
        return res.status(404).json({ code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } });
    }
    const candidates = await Post.getTranslations(postId, undefined, { includeUnpublished: true });
    const translations = await visibleTranslationRefs(candidates, req.user);
    res.json({ language: post.postLanguage || null, group: post.translationGroup || null, translations });
}));

/**
 * @swagger
 * /posts/{id}/translations:
 *   post:
 *     summary: Link this post and another as translations of each other
 *     description: Symmetric and idempotent - both posts end up in one translation group, and when either already belongs to a group that WHOLE set is folded in, not just the two posts. The caller must be able to edit BOTH posts. Unlike the GET, the list returned here is the raw group and includes unpublished siblings, which is what the editor doing the linking needs to see.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [translationId]
 *             properties:
 *               translationId:
 *                 type: integer
 *                 description: The other post's id. A positive integer, and different from the id in the path.
 *     responses:
 *       200:
 *         description: The surviving translation group and its members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 group:
 *                   type: string
 *                 translations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       language:
 *                         type: string
 *                       slug:
 *                         type: string
 *                       type:
 *                         type: string
 *                       status:
 *                         type: string
 *       400:
 *         description: translationId is missing, not a positive integer, or equal to the id in the path (rest_invalid_param), or the two posts could not be linked (rest_link_failed)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: This caller may not edit both posts (rest_forbidden)
 *       404:
 *         description: Either post is missing, has a malformed id, or is an internal post type (rest_post_invalid_id)
 */
router.post('/:id/translations', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams, TranslationBody>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const parsedTranslationId = toNonNegativeInt(req.body?.translationId);
    const otherId = parsedTranslationId && parsedTranslationId > 0 ? parsedTranslationId : 0;
    if (!otherId || otherId === postId) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'A distinct translationId is required.', data: { status: 400 } });
    }
    const [post, other] = await Promise.all([Post.findById(postId), Post.findById(otherId)]);
    if (!post || !other || isHiddenFromRest(post) || isHiddenFromRest(other)) {
        return res.status(404).json(NOT_FOUND);
    }
    if (!canEditPostRecord(req.user, post) || !canEditPostRecord(req.user, other)) {
        return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot edit both posts.', data: { status: 403 } });
    }

    let group: string | false = false;
    await runContentMutation(async () => {
        group = await Post.linkTranslations(postId, otherId);
    });
    if (!group) {
        return res.status(400).json({ code: 'rest_link_failed', message: 'Could not link these posts.', data: { status: 400 } });
    }
    const translations = await Post.getTranslations(postId, group, { includeUnpublished: true });
    res.json({ group, translations });
}));

/**
 * @swagger
 * /posts/{id}/translations:
 *   delete:
 *     summary: Remove this post from its translation set
 *     description: The remaining members stay linked to each other. Idempotent - a post that belongs to no set answers the same success.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The post no longer belongs to a translation set
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: This caller may not edit the post (rest_forbidden)
 *       404:
 *         description: No such post, a malformed id, or an internal post type (rest_post_invalid_id)
 */
router.delete('/:id/translations', authenticate, asyncHandler(async (req: AuthenticatedRequest<IdParams>, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);
    // Internal types are not addressable through the generic /posts surface (see isHiddenFromRest).
    if (!post || isHiddenFromRest(post)) {
        return res.status(404).json(NOT_FOUND);
    }
    if (!canEditPostRecord(req.user, post)) {
        return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot edit this post.', data: { status: 403 } });
    }
    await runContentMutation(async () => {
        await Post.unlinkTranslation(postId);
    });
    res.json({ success: true });
}));

module.exports = router;
