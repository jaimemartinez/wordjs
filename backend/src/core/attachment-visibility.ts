/**
 * WordJS - Attachment visibility
 *
 * THE ONE ANSWER to "may this caller learn that this attachment exists — its title and its URL?", and
 * to its write twin, "may this caller change it?".
 *
 * WHY IT IS ITS OWN MODULE. GET /media/:id decided this inline, the media LIST kept a second copy, and the
 * featured-image projection in Post.toJSON() did not decide it at all: it resolved `_thumbnail_id` with
 * Post.findById and copied the row's title and file URL into `featuredMedia`, whatever the row was.
 * `_thumbnail_id` is author-written meta that accepts any integer, so a contributor pointed it at an
 * editor's draft or private POST and read its title back from their own draft, and an author published
 * that projection to every anonymous reader; an attachment hanging off an unpublished entry — 404 on
 * GET /media/:id — shipped its real /uploads URL the same way. Surfaces answering the same question
 * differently is the bug; they all ask here.
 *
 * THE RULE:
 *   - the row must BE an attachment. Any other post type is never projected as media, for anyone;
 *   - `inherit` (an ordinary, public media item) passes on its own;
 *   - `private` (core/private-media.ts) passes only for a caller who may edit the item;
 *   - any other status (an attachment row created as a draft through the generic /posts surface, or one
 *     moved to the trash) is an ordinary unpublished post and gets the ordinary read rule;
 *   - and in every case the PARENT gate (parentAllowsAttachment): an attachment is visible only to a
 *     caller who may READ the entry it hangs off. No parent (unattached) or a dangling one (the post was
 *     deleted) hides nothing.
 *
 * THREE FORMS OF THE SAME RULE, ONE SOURCE. A route that loaded one row asks canViewAttachment; a LIST
 * asks attachmentVisibilityCondition, which hands the same decision to the database so that the rows,
 * X-WP-Total and X-WP-TotalPages are all computed over the visible set (deciding after the query and
 * subtracting what one page hid left every other page, every search and every page past the end counting
 * hidden items — an existence-and-title oracle); a list of rows that NAME a post by id (the comments) asks
 * attachmentReferenceCondition, which is that same condition applied to the named row; a write asks
 * attachmentWriteRefusal. The SQL is not a
 * second spelling of the policy: it is DERIVED from parentAllowsAttachment and attachmentAllowsItself by
 * evaluating them on every combination of the facts they depend on (see decisionToSql), so a change to
 * the type read policy reaches the lists without anyone touching SQL.
 */

const privateMedia = require('./private-media');
const {
    canReadPostRecord, canReadUnpublishedPostRecord, canReadPostContent, canEditPostRecord, isInternalPostType,
    withTypePolicyMemo, builtinPostTypeNames,
} = require('./post-capabilities');

/**
 * Does the attachment's PARENT let this caller see it? `parent` is the resolved row, null when none.
 *
 * THE SINGLE PLACE every attachment-parent READ decision is made — the single-row routes, the
 * featured-image projection, the media list's defensive re-check, and (by derivation, see
 * attachmentVisibilityCondition) the SQL every attachment list and total is computed with. A change to how
 * a parent's type policy is resolved (for example a type the registry does not know) belongs in the
 * post-capabilities predicates this calls, and reaches every one of those surfaces from there.
 *
 * The question is the one GET /posts/:id asks of the parent itself — may THIS READER read it — and not
 * merely "is it published". Asking only the status was a hole: the published entry of a `public: false`
 * type is 404 to an anonymous caller, yet its attachments were served to everyone. So:
 *   - the parent's TYPE POLICY decides (canReadPostRecord): a published entry of a public type is
 *     readable by anyone; a published entry of a non-public type, or an unpublished entry of any type,
 *     only by its author or a holder of that type's edit_others / read_private capability — the TYPE's
 *     family, not edit_others_posts, which says nothing about a type with its own capability family;
 *   - a parent whose type the registry does NOT KNOW (an imported type nobody registered, a deleted
 *     custom type, any custom type before the registry has loaded) is not public either: the type policy
 *     canReadPostRecord applies is post-capabilities readPolicyForType, which fails closed for it — its
 *     author and the `post` family's edit_others / read_private holders still see its attachments, and
 *     nobody else does, on GET /media/:id, in the media list or in its totals;
 *   - an INTERNAL parent (nav_menu_item, revision, any registered `showInRest: false` type) is never
 *     public, whatever its status. Those rows are not addressable through the content API at all; the
 *     ones who may still see their attachments are exactly the ones who could read such a row were it
 *     unpublished. The internal names are recognised even before the type registry has loaded, the
 *     window in which every type would otherwise fall back to the public `post` family;
 *   - a PASSWORD-PROTECTED parent: its attachments are part of what the password protects, so they reach
 *     only a caller who MANAGES the entry (its author with the type's edit capability, or a holder of
 *     edit_others for the type) — canReadPostContent. A caller who can read the entry but not manage it
 *     sees no attachment of it, on any surface, until it is unprotected. (The entry's FEATURED IMAGE is
 *     withheld from that caller whatever it names, attached or not — Post.toJSON.)
 *
 * THE FACTS IT MAY DEPEND ON. attachmentVisibilityCondition turns this function into SQL by evaluating it
 * for every combination of: the parent's post TYPE, whether its status is `publish`, whether the caller
 * wrote it, and whether it carries a password. Anything else this function starts to read about the
 * parent must be added there as a dimension too, or the lists will stop agreeing with the routes — the
 * cross-check in attachment-list-visibility.test.ts compares the two on real rows.
 */
function parentAllowsAttachment(user: any, parent: any): boolean {
    if (!parent) return true; // unattached, or the parent row is gone
    if (isInternalPostType(parent.type || parent.postType)) return canReadUnpublishedPostRecord(user, parent);
    return canReadPostContent(user, parent);
}

/**
 * The attachment's OWN half of the rule (status + ownership), without the parent. Facts it may depend on,
 * for the same reason as above: the row's status (`inherit`, `private`, `publish`, or anything else) and
 * whether the caller wrote it.
 */
function attachmentAllowsItself(user: any, attachment: any): boolean {
    const status = attachment.postStatus;
    if (status === privateMedia.PUBLIC_ATTACHMENT_STATUS) return true;
    if (status === privateMedia.PRIVATE_ATTACHMENT_STATUS) return privateMedia.canAccessPrivateMedia(user, attachment);
    return canReadPostRecord(user, attachment);
}

/**
 * May `user` (undefined/null = anonymous) see `attachment` (a Post instance)? `parent` is the Post its
 * `postParent` points at, resolved by the caller (null when unattached or when the row is gone) so a list
 * can batch the lookups.
 */
function canViewAttachment(user: any, attachment: any, parent: any): boolean {
    if (!attachment || attachment.postType !== 'attachment') return false;
    return attachmentAllowsItself(user, attachment) && parentAllowsAttachment(user, parent);
}

/**
 * The WRITE half of the parent rule: may `user` change an attachment of `parent`?
 *
 * Changing an attachment (its title, alt text, caption, visibility, its very existence) changes what the
 * parent entry shows, so it takes the PARENT's edit gate — the one attaching a file to that entry already
 * takes (routes/posts.ts, `parent` on create/update) — on top of the attachment's own gate. Without it an
 * editor holding `edit_others_posts` rewrote and deleted the files of entries of a type with its own
 * capability family, which they may not even read. Unattached or dangling: nothing to protect.
 */
function parentAllowsAttachmentWrite(user: any, parent: any): boolean {
    return !parent || canEditPostRecord(user, parent);
}

/** The row an attachment hangs off, or null (not an attachment, unattached, or the parent row is gone). */
async function resolveAttachmentParent(row: any): Promise<any> {
    if (!row || row.postType !== 'attachment' || !row.postParent) return null;
    // Required here, not at the top: models/Post requires this module for its featured-image projection.
    const Post = require('../models/Post');
    return (await Post.findById(row.postParent)) || null;
}

/**
 * For a route that loaded ONE row by id on a generic surface (/posts/:id and its meta, slug, translation
 * and revision routes): may `user` read it AS AN ATTACHMENT? Any other post type answers true — its own
 * read gate is the route's job; this only adds the attachment rule for attachment rows.
 */
async function attachmentReadable(user: any, row: any): Promise<boolean> {
    if (!row || row.postType !== 'attachment') return true;
    return canViewAttachment(user, row, await resolveAttachmentParent(row));
}

/**
 * THE READ RULE OF ONE LOADED ROW ON A CONTENT SURFACE — the question GET /posts/:id asks, for every route
 * that loads a row by id (or slug) and hands back any of its fields: may `user` read this row?
 *   - an INTERNAL type (nav_menu_item, revision, any `showInRest: false` type) is never readable here — it
 *     belongs to its own API;
 *   - the record gate (canReadPostRecord): published + publicly readable type, or the author, or a holder
 *     of the TYPE's edit_others / read_private capability;
 *   - and for an attachment, the attachment rule (canViewAttachment, parent entry included).
 * routes/posts.ts asks it for /posts/:id, its meta, slug and translations; GET /seo/meta/:postId and the
 * comment routes ask it too, so a field one of them withholds cannot be read through another. It answers
 * the READ question only: what a password protects (content, excerpt) is canReadPostContent's business,
 * applied by each projection on top of this.
 */
async function canReadRecordThroughRest(user: any, row: any): Promise<boolean> {
    if (!row) return false;
    if (isInternalPostType(row.type || row.postType || 'post')) return false;
    if (!canReadPostRecord(user, row)) return false;
    return attachmentReadable(user, row);
}

/**
 * THE GATE FOR EVERY ATTACHMENT WRITE (PUT/DELETE /media/:id, and PUT/DELETE/meta/language/translations
 * on /posts/:id, collaboration, presence and revision restore/delete when the row is an attachment).
 * Answers null to go ahead, 404 when the caller may not even see the attachment (the answer GET /media/:id
 * gives, so a write does not confirm what a read hides), or 403 when they see it but may not edit the
 * entry it hangs off. The attachment's OWN edit/delete gate stays with each route. Non-attachments: null.
 */
async function attachmentWriteRefusal(user: any, row: any): Promise<null | 403 | 404> {
    if (!row || row.postType !== 'attachment') return null;
    const parent = await resolveAttachmentParent(row);
    if (!canViewAttachment(user, row, parent)) return 404;
    if (!parentAllowsAttachmentWrite(user, parent)) return 403;
    return null;
}

/**
 * The media LIST's defensive re-check of one page (the SQL condition below already selected only what
 * `user` may see; this asks canViewAttachment item for item, so a drift between the two can only ever
 * hide a row, never show one). The parents of the whole page are resolved with ONE query.
 *
 * The items are FORMATTED media objects, and Media.findAll() lists only the two attachment statuses
 * (`inherit` and `private`), so `visibility` names the row's status exactly: 'private' is `private` and
 * 'public' is `inherit`.
 */
async function filterVisibleMediaItems(user: any, items: any[]): Promise<any[]> {
    const Post = require('../models/Post');
    const parentIds: number[] = [...new Set<number>(items.map((m: any) => m.parent).filter((id: any) => !!id))];
    const parentById: Map<number, any> = await Post.findByIds(parentIds);
    return items.filter((m: any) => canViewAttachment(user, {
        id: m.id,
        postType: 'attachment',
        postStatus: m.visibility === 'private' ? privateMedia.PRIVATE_ATTACHMENT_STATUS : privateMedia.PUBLIC_ATTACHMENT_STATUS,
        authorId: m.author,
    }, m.parent ? (parentById.get(Number(m.parent)) || null) : null));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE AS SQL
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface SqlFragment { sql: string; params: any[] }

const TRUE_SQL: SqlFragment = Object.freeze({ sql: '1 = 1', params: [] }) as SqlFragment;
const FALSE_SQL: SqlFragment = Object.freeze({ sql: '1 = 0', params: [] }) as SqlFragment;

/**
 * A text column compared EXACTLY, on every driver (core/sql-exact-text). SQLite and Postgres compare text
 * byte for byte; MySQL's default collation (utf8mb4_unicode_ci) is case- and accent-insensitive and pads
 * trailing spaces, so `post_status = 'publish'` would also match a stored 'PUBLISH' — a row the JS rule
 * (`=== 'publish'`) treats as unpublished. The SQL must never be MORE permissive than the function it was
 * derived from.
 */
function exactText(expr: string): string {
    return sqlExactText().exactTextExpr(expr);
}

/**
 * core/sql-exact-text and core/post-types, resolved ONCE per process: attachmentVisibilityCondition runs
 * on every attachment list and count and calls exactText four times, and a `require()` per call
 * re-resolves the path each time (see Post's sqlExactText). Each is cached only once complete — a module
 * still loading through a circular require exposes a partial `exports` — and as the module object, so a
 * test that replaces one of its exports is obeyed.
 */
let sqlExactTextModule: any = null;
function sqlExactText(): any {
    if (sqlExactTextModule) return sqlExactTextModule;
    const mod = require('./sql-exact-text');
    if (mod && typeof mod.exactTextExpr === 'function') sqlExactTextModule = mod;
    return mod;
}
let postTypesModule: any = null;
function postTypesRegistry(): any {
    if (postTypesModule) return postTypesModule;
    const mod = require('./post-types');
    if (mod && typeof mod.getPostTypes === 'function') postTypesModule = mod;
    return mod;
}

function andAll(parts: SqlFragment[]): SqlFragment {
    if (parts.length === 0) return TRUE_SQL;
    if (parts.length === 1) return parts[0];
    return { sql: parts.map((p) => `(${p.sql})`).join(' AND '), params: parts.flatMap((p) => p.params) };
}

function orAll(parts: SqlFragment[]): SqlFragment {
    if (parts.length === 0) return FALSE_SQL;
    if (parts.length === 1) return parts[0];
    return { sql: parts.map((p) => `(${p.sql})`).join(' OR '), params: parts.flatMap((p) => p.params) };
}

/** Every combination of one index per dimension. */
function combinations(sizes: number[]): number[][] {
    let out: number[][] = [[]];
    for (const size of sizes) {
        const next: number[][] = [];
        for (const prefix of out) for (let v = 0; v < size; v++) next.push([...prefix, v]);
        out = next;
    }
    return out;
}

/**
 * Turn a decision over a few small, finite dimensions into SQL — EXACTLY, by enumeration.
 *
 * `dims[i]` lists the values dimension i can take, each as the SQL that is TRUE for a row having that
 * value; the values of one dimension must be mutually exclusive, exhaustive, and never NULL (COALESCE).
 * `decide(combo)` answers for one combination of value indexes. The result is the OR of the true
 * combinations; a dimension the decision does not depend on is left out of every term, so an
 * administrator's condition collapses to `1 = 1` and an anonymous caller's to a couple of comparisons.
 */
function decisionToSql(dims: SqlFragment[][], decide: (combo: number[]) => boolean): SqlFragment {
    const combos = combinations(dims.map((d) => d.length));
    const outcome = new Map<string, boolean>();
    for (const c of combos) outcome.set(c.join(','), !!decide(c));
    const results = [...outcome.values()];
    if (results.every(Boolean)) return TRUE_SQL;
    if (!results.some(Boolean)) return FALSE_SQL;
    const at = (c: number[]) => outcome.get(c.join(','));
    const relevant = dims.map((d, i) => combos.some((c) => d.some((_, v) => {
        const flipped = c.slice();
        flipped[i] = v;
        return at(flipped) !== at(c);
    })));
    const terms: SqlFragment[] = [];
    for (const c of combos) {
        // One representative per combination of the RELEVANT dimensions (an irrelevant one is fixed at
        // its first value: by definition the outcome is the same for every value of it).
        if (c.some((v, i) => !relevant[i] && v !== 0)) continue;
        if (!at(c)) continue;
        terms.push(andAll(c.map((v, i) => (relevant[i] ? dims[i][v] : null)).filter(Boolean) as SqlFragment[]));
    }
    return orAll(terms);
}

/**
 * A type name no registry can hold (registered names match /^[a-z][a-z0-9_-]*$/): the probe for "a type
 * the registry does not know", whose answer every unknown name in the database shares.
 */
const UNKNOWN_TYPE_PROBE = '\u0000unregistered';

/**
 * THE MEDIA-LIST FORM OF canViewAttachment: a WHERE condition true exactly for the attachment rows `user`
 * (undefined/null = anonymous) may see. `outer` is how the listing query names the attachment row
 * (`p.` for Post.findAll, `posts.` for Post.count).
 *
 * HOW IT IS BUILT. Both halves of the rule are evaluated — not re-implemented — for every combination of
 * the facts they depend on, and the true combinations become the condition (decisionToSql):
 *   - the attachment itself: its status (`inherit` | `private` | `publish` | any other) × whether the
 *     caller wrote it;
 *   - its parent, joined by id: per post TYPE, whether it is published × whether the caller wrote it ×
 *     whether it has a password. Types are grouped by identical answers. Every name the registry knows,
 *     every built-in (builtinPostTypeNames: the names readPolicyForType knows without the registry), the
 *     core internal names and '' (read as `post`) are asked by name; every other name in the database
 *     is asked through UNKNOWN_TYPE_PROBE, because for a type nobody registered the rule cannot tell one
 *     name from another (readPolicyForType: not public).
 * No parent row (unattached, or the entry was deleted) hides nothing, exactly as in parentAllowsAttachment.
 */
function attachmentVisibilityCondition(user: any, outer: string, cacheKey?: object): SqlFragment {
    // Built once per listing (the rows and the count share `cacheKey`, the request's attachmentViewer
    // object), with every type policy resolved once (withTypePolicyMemo): the derivation asks the
    // predicates a few hundred times, and each uncached answer clones a declaration from the registry.
    let template = cacheKey ? conditionTemplates.get(cacheKey) : undefined;
    if (!template) {
        template = withTypePolicyMemo(() => buildAttachmentVisibilityTemplate(user)) as SqlFragment;
        if (cacheKey) conditionTemplates.set(cacheKey, template);
    }
    return { sql: template.sql.split(OUTER_TOKEN).join(outer), params: [...template.params] };
}

/**
 * THE SAME RULE FOR A LISTING OF ROWS THAT NAME A POST BY ID — the comment list and its totals
 * (Comment.findAll / Comment.count, `attachmentViewer`): a WHERE condition true exactly when the post that
 * `postIdExpr` names is not an attachment (or there is no such row), or is an attachment `user` may see
 * (attachmentVisibilityCondition, the parent entry included). A comment carries the id of the row it is
 * on, so listing — or counting — the comments of an attachment the caller may not see tells them that
 * attachment exists, by id. What else the listing requires of that row (its own status, a public type) is
 * the listing's business; this only adds the attachment rule. `postIdExpr` is the listing's own column
 * reference, never a request value. `cacheKey` as for attachmentVisibilityCondition.
 */
function attachmentReferenceCondition(user: any, postIdExpr: string, cacheKey?: object): SqlFragment {
    const visible = attachmentVisibilityCondition(user, 'aref.', cacheKey);
    return {
        sql: `NOT EXISTS (SELECT 1 FROM posts aref WHERE aref.id = ${postIdExpr} AND ${exactText('aref.post_type')} = ?)`
            + ` OR EXISTS (SELECT 1 FROM posts aref WHERE aref.id = ${postIdExpr} AND (${visible.sql}))`,
        params: ['attachment', ...visible.params],
    };
}

/** Stands for the listing's qualifier of the attachment row in a cached template (`p.` / `posts.`). */
const OUTER_TOKEN = '\u0001outer.';
const conditionTemplates: WeakMap<object, SqlFragment> = new WeakMap();

function buildAttachmentVisibilityTemplate(user: any): SqlFragment {
    const viewer = user || null;
    const uid = viewer ? viewer.id : null;
    // Some id that is not the caller's: the "somebody else wrote it" probe.
    const otherId = uid === -1 ? -2 : -1;
    const o = OUTER_TOKEN;

    // ── the attachment's own half ──────────────────────────────────────────────────────────────────
    const statusExpr = exactText(`COALESCE(${o}post_status, '')`);
    const ownStatuses = [privateMedia.PUBLIC_ATTACHMENT_STATUS, privateMedia.PRIVATE_ATTACHMENT_STATUS, 'publish'];
    const selfStatusDim: SqlFragment[] = [
        ...ownStatuses.map((s) => ({ sql: `${statusExpr} = ?`, params: [s] })),
        { sql: `${statusExpr} NOT IN (?, ?, ?)`, params: [...ownStatuses] },
    ];
    const selfStatusProbe = [...ownStatuses, 'draft'];
    const selfDims: SqlFragment[][] = [selfStatusDim];
    if (viewer) {
        selfDims.push([
            { sql: `COALESCE(${o}author_id, 0) = ?`, params: [uid] },
            { sql: `COALESCE(${o}author_id, 0) <> ?`, params: [uid] },
        ]);
    }
    const selfSql = decisionToSql(selfDims, (c) => attachmentAllowsItself(viewer, {
        postType: 'attachment', type: 'attachment',
        postStatus: selfStatusProbe[c[0]],
        authorId: viewer && c[1] === 0 ? uid : otherId,
    }));

    // ── the parent's half, per type ────────────────────────────────────────────────────────────────
    const parentStatus = exactText(`COALESCE(par.post_status, '')`);
    const parentDims: SqlFragment[][] = [
        [{ sql: `${parentStatus} = ?`, params: ['publish'] }, { sql: `${parentStatus} <> ?`, params: ['publish'] }],
        // LENGTH, not `<> ''`: MySQL's PAD SPACE collations call ' ' equal to '', and a one-space password
        // is a password to the JS rule.
        [{ sql: `LENGTH(COALESCE(par.post_password, '')) > 0`, params: [] }, { sql: `LENGTH(COALESCE(par.post_password, '')) = 0`, params: [] }],
    ];
    if (viewer) {
        parentDims.push([
            { sql: `COALESCE(par.author_id, 0) = ?`, params: [uid] },
            { sql: `COALESCE(par.author_id, 0) <> ?`, params: [uid] },
        ]);
    }
    const parentFor = (type: string) => decisionToSql(parentDims, (c) => parentAllowsAttachment(viewer, {
        type, postType: type,
        postStatus: c[0] === 0 ? 'publish' : 'draft',
        postPassword: c[1] === 0 ? 'password' : '',
        authorId: viewer && c[2] === 0 ? uid : otherId,
    }));

    const named = [...new Set<string>([
        ...postTypesRegistry().getPostTypes().map((t: any) => String(t && t.name)),
        ...builtinPostTypeNames(),
        'nav_menu_item', 'revision', '',
    ])];
    // Group the names by identical answers. The group the UNKNOWN probe falls in is spelled as "any name
    // outside the other groups", so the common case — every type answering alike (an administrator, or a
    // site whose types are all public) — needs no type list at all.
    const typeExpr = exactText(`COALESCE(par.post_type, '')`);
    const groups = new Map<string, { names: string[]; unknown: boolean; sql: SqlFragment }>();
    const addToGroup = (name: string | null) => {
        const sql = parentFor(name === null ? UNKNOWN_TYPE_PROBE : name);
        const key = `${sql.sql}\u0001${JSON.stringify(sql.params)}`;
        const group = groups.get(key) || { names: [], unknown: false, sql };
        if (name === null) group.unknown = true;
        else group.names.push(name);
        groups.set(key, group);
    };
    for (const name of named) addToGroup(name);
    addToGroup(null);
    const typeTerms: SqlFragment[] = [];
    for (const group of groups.values()) {
        if (group.sql === FALSE_SQL) continue;
        let typeSql: SqlFragment;
        if (group.unknown) {
            const others = named.filter((n) => !group.names.includes(n));
            typeSql = others.length
                ? { sql: `${typeExpr} NOT IN (${others.map(() => '?').join(', ')})`, params: others }
                : TRUE_SQL;
        } else {
            typeSql = { sql: `${typeExpr} IN (${group.names.map(() => '?').join(', ')})`, params: group.names };
        }
        typeTerms.push(andAll([typeSql, group.sql].filter((f) => f !== TRUE_SQL)));
    }
    const parentSql = orAll(typeTerms);

    const conditions: SqlFragment[] = [{ sql: `${exactText(`${o}post_type`)} = ?`, params: ['attachment'] }];
    if (selfSql !== TRUE_SQL) conditions.push(selfSql);
    if (parentSql !== TRUE_SQL) {
        conditions.push({
            sql: `NOT EXISTS (SELECT 1 FROM posts par WHERE par.id = ${o}post_parent)`
                + (parentSql === FALSE_SQL ? '' : ` OR EXISTS (SELECT 1 FROM posts par WHERE par.id = ${o}post_parent AND (${parentSql.sql}))`),
            params: parentSql === FALSE_SQL ? [] : [...parentSql.params],
        });
    }
    return andAll(conditions);
}

module.exports = {
    canViewAttachment, parentAllowsAttachment, parentAllowsAttachmentWrite, attachmentAllowsItself,
    attachmentReadable, attachmentWriteRefusal, resolveAttachmentParent, canReadRecordThroughRest,
    filterVisibleMediaItems, attachmentVisibilityCondition, attachmentReferenceCondition, decisionToSql,
};
