/**
 * WordJS - Post capability-family resolution
 *
 * SINGLE SOURCE OF TRUTH for mapping a post TYPE to its capability family
 * (post → edit_posts, page → edit_pages, custom → edit_<type>s) plus the
 * publish/delete-published variants. Shared by routes/posts.ts and
 * routes/revisions.ts so the type-aware + publish-aware authorization gate
 * cannot DRIFT between the two write surfaces: revisions restore/delete used to
 * enforce a weaker, post-only, publish-blind gate (a contributor could roll back
 * their OWN already-published post, and pages were gated as posts) precisely
 * because it kept its own copy of this logic. Both callers now build caps here.
 */

// Pure capability-name builder for a capability_type family. NEVER null — used as the guaranteed
// fallback for an EXISTING post whose registered type may since have been removed.
function capsFor(c: string) {
    const { policyFromCapabilityType } = require('./content-contract');
    return policyFromCapabilityType(c);
}

// Resolve the capability family for a post type (post → edit_posts, page → edit_pages, custom →
// edit_<type>s) so an author holding only POST caps cannot create/edit/publish/delete PAGES.
// Returns null for an UNREGISTERED type so the CREATE path can reject it (400). Callers editing an
// existing post fall back to capsFor('post') instead of relying on this nullable result.
function capsForType(type: string) {
    const { getPostType, getContentTypeSchema } = require('./post-types');
    const name = String(type || 'post');
    const schema = getContentTypeSchema(name);
    if (schema) {
        const { policyFromContentSchema } = require('./content-contract');
        return policyFromContentSchema(schema);
    }
    // Pre-F1 registries created by an older embedder still get the historical projection.
    const pt = getPostType(name);
    return pt ? capsFor(pt.capability_type || 'post') : null;
}

/**
 * The statuses that carry the "published" capability bar (edit_published_<type>s /
 * delete_published_<type>s), WordPress semantics:
 *
 *  · 'publish' — what the site is serving right now;
 *  · 'future'  — APPROVED content on a timer. Treating it like a draft let a contributor whose post an
 *    editor scheduled rewrite it after the review: the unreviewed copy then went live on its own at
 *    the scheduled moment (and an edit after that moment flipped it straight to 'publish');
 *  · 'private' — published to a restricted audience. WordPress gates it with edit_private_<type>s,
 *    which the built-in roles here do not define (and stored role maps of existing installs would not
 *    gain), so the published-family capability stands in for it: editors and authors keep working on
 *    their private entries, a contributor cannot touch one.
 *
 * The SET of statuses a caller may write lives with the routes (POST/PUT /posts); this answers only
 * "which existing rows are past editorial review".
 */
const PUBLISHED_FAMILY_STATUSES: ReadonlySet<string> = new Set(['publish', 'future', 'private']);

function isPublishedFamilyStatus(status: unknown): boolean {
    return typeof status === 'string' && PUBLISHED_FAMILY_STATUSES.has(status);
}

/**
 * THE EDIT GATE for one existing post record — the single definition of "may this user rewrite this
 * post's content", shared instead of copied.
 *
 * The three parts are not separable: the post's TYPE picks the capability family (a post-only author
 * must not edit a PAGE), OWNERSHIP picks edit vs edit_others, and a post that is already PUBLISHED
 * additionally demands edit_published_<type>s — otherwise a contributor whose draft an editor published
 * can still rewrite the live page with plain edit_posts.
 *
 * WHY IT MOVED HERE. PUT /posts/:id, routes/revisions.ts and routes/collab.ts each enforced all three;
 * POST /posts/:id/meta enforced only the first two, and `_puck_data` — the public body of the page — is
 * writable through it. Three surfaces against one is not a policy, it is a copy that drifted, which is
 * the argument this module exists on. Callers pass the Post INSTANCE (post.type/postType,
 * post.authorId, post.postStatus) and the authenticated user.
 */
function canEditPostRecord(user: any, post: any): boolean {
    if (!user || !post) return false;
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const isOwn = post.authorId === user.id;
    let allowed = isOwn ? user.can(caps.edit) : user.can(caps.editOthers);
    // An already-published post needs the publish-aware capability on top; a bare edit cap is not
    // permission to rewrite what the site is currently serving. "Published" is the whole family —
    // see isPublishedFamilyStatus — not only the literal 'publish'.
    if (isPublishedFamilyStatus(post.postStatus) && !user.can(caps.editPublished)) allowed = false;
    return allowed;
}

/** Delete twin of canEditPostRecord, generated from the same declared operation map. */
function canDeletePostRecord(user: any, post: any): boolean {
    if (!user || !post) return false;
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const isOwn = post.authorId === user.id;
    let allowed = isOwn ? user.can(caps.del) : user.can(caps.deleteOthers);
    if (isPublishedFamilyStatus(post.postStatus) && !user.can(caps.deletePublished)) allowed = false;
    return allowed;
}

/** Whether a user may see a non-public record of this declared type. */
function canReadUnpublishedPostRecord(user: any, post: any): boolean {
    if (!user || !post) return false;
    if (post.authorId === user.id) return true;
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    return user.can(caps.editOthers) || user.can(caps.readPrivate);
}

/** Public records are readable by anyone; every other state uses the generated type policy. */
function canReadPostRecord(user: any, post: any): boolean {
    if (!post) return false;
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const published = post.postStatus === 'publish' || post.status === 'publish';
    return (published && caps.publiclyReadable) || canReadUnpublishedPostRecord(user, post);
}

/**
 * May this user MANAGE this record — type family + ownership, WITHOUT the published-family bar.
 *
 * This is "is this one of the people who work on this entry" (its author with the type's edit cap,
 * or someone holding edit_others for the type), not "may they rewrite it now". It decides what the
 * READ surfaces hand over beyond the public projection: the full meta map (editorial review thread,
 * plugin bookkeeping) and the body of a password-protected entry. A contributor whose entry an
 * editor published can no longer EDIT it, but must still read the review thread on it.
 */
function canManagePostRecord(user: any, post: any): boolean {
    if (!user || !post || typeof user.can !== 'function') return false;
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    return post.authorId === user.id ? user.can(caps.edit) : user.can(caps.editOthers);
}

/**
 * Does this record carry a post password (WordPress "password protected" visibility)?
 *
 * Nothing in WordJS sets one through the REST surface today, but the WXR importer keeps
 * `wp:post_password` verbatim, so every protected entry of a migrated WordPress site arrives with
 * one — and no read path used to look at it, which served the protected body to everyone. Accepts
 * both a Post instance (postPassword) and a raw row (post_password).
 */
function isPasswordProtected(post: any): boolean {
    if (!post) return false;
    const value = post.postPassword !== undefined ? post.postPassword : post.post_password;
    return value !== undefined && value !== null && String(value) !== '';
}

/**
 * Underscore-prefixed meta keys the PUBLIC site renders, and therefore the only ones a caller who
 * cannot manage the entry receives.
 *
 * The leading underscore is WordPress's "protected / internal" convention, and WordJS follows it:
 * `_wjs_review_comments` is the editorial review thread, `_wp_trash_meta_*` and `_edit_*` are
 * bookkeeping, plugins stash state under their own `_` prefixes. Post.toJSON() used to hand the
 * whole map to anyone who could read the entry. The public frontend reads exactly these three
 * (frontend/src/components/public/PostContent.tsx, HomeContent.tsx, ThemeTemplate.tsx,
 * lib/resolveDynamicBlocks.ts, lib/editorRootFields.ts) plus the UNPREFIXED SEO keys
 * (seo_title, seo_description, og_image, noindex), which stay public along with every other
 * unprefixed key — that is where plugins put meta they intend to be rendered.
 */
const PUBLIC_PROTECTED_META_KEYS: ReadonlySet<string> = new Set(['_puck_data', '_wjs_template', '_thumbnail_id']);

/**
 * The meta map a caller who cannot manage the entry may see: unprefixed keys plus the allowlist
 * above. The decision is taken on the CANONICAL spelling (core/protected-meta.canonicalMetaKey), so
 * a key stored with a lookalike prefix or a leading ignorable character is still treated as internal.
 */
function publicPostMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!meta || typeof meta !== 'object') return out;
    const { canonicalMetaKey } = require('./protected-meta');
    for (const [key, value] of Object.entries(meta)) {
        if (PUBLIC_PROTECTED_META_KEYS.has(key)) { out[key] = value; continue; }
        const canonical = String(canonicalMetaKey(key));
        if (canonical.startsWith('_') || key.startsWith('_')) continue;
        out[key] = value;
    }
    return out;
}

/**
 * May this caller read the BODY of the entry (content, excerpt, the page-builder tree)?
 * Readable (canReadPostRecord) and, when the entry is password protected, one the caller manages.
 */
function canReadPostContent(user: any, post: any): boolean {
    if (!canReadPostRecord(user, post)) return false;
    return !isPasswordProtected(post) || canManagePostRecord(user, post);
}

/**
 * The post types whose entries are NEVER public, whatever their status: the internal ones
 * (isInternalPostType — always nav_menu_item and revision, plus any registered `showInRest: false`)
 * and every registered type not declared publicly readable. This is the complement the public
 * comment list filters on, written as an exclusion on purpose: an entry of an UNREGISTERED type is
 * readable through GET /posts/:id under the `post` family fallback (canReadPostRecord), so its
 * comments must not disappear just because the registry does not know the type — and the two core
 * internals are excluded even before the registry has loaded.
 */
function nonPublicPostTypes(): string[] {
    const { getPostTypes } = require('./post-types');
    const out = new Set<string>(ALWAYS_INTERNAL_POST_TYPES);
    for (const pt of getPostTypes() as Array<{ name: string }>) {
        const caps = capsForType(pt.name);
        if (isInternalPostType(pt.name) || !caps || !caps.publiclyReadable) out.add(pt.name);
    }
    return Array.from(out);
}

/**
 * Is this post type INTERNAL — registered, but marked `showInRest: false`?
 *
 * "Unregistered" and "internal" are NOT the same answer, and conflating them was a regression:
 * isRestExposedPostType() says false to both, so a post whose custom type an admin later removed
 * (DELETE /types/:name is one click) became unreachable through EVERY route in routes/posts.ts — 404 on
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
    const { getPostType } = require('./post-types');
    const pt = getPostType(name);
    return !!(pt && pt.showInRest === false);
}

/**
 * Is `type` a post type the GENERIC /posts routes may act on at all?
 *
 * `showInRest: false` is how the registry marks a type as INTERNAL: nav_menu_item and revision are
 * rows in `posts` that belong to their own APIs (menus.ts is admin-only; revisions.ts carries the
 * restore/delete gate), and they carry no capability_type, so capsForType() lands them in the plain
 * `post` family. That is how an editor could rewrite a menu item's `_menu_item_url` — and thus every
 * page's navigation — through POST /posts/:id/meta, and how a contributor could mint `revision` rows
 * with an arbitrary `parent`. The fix is not to invent capability families for internal types (the
 * `|| capsFor('post')` fallback would swallow them anyway) but to make the generic surface refuse to
 * SEE them: unknown type and internal type are the same answer.
 *
 * An unregistered type answers false too — a caller must never fall back to "treat it as a post".
 */
function isRestExposedPostType(type: string): boolean {
    const { getPostType } = require('./post-types');
    const pt = getPostType(String(type || 'post'));
    return !!(pt && pt.showInRest);
}

module.exports = {
    capsFor, capsForType, canEditPostRecord, canDeletePostRecord,
    canReadPostRecord, canReadUnpublishedPostRecord, isRestExposedPostType,
    isPublishedFamilyStatus, PUBLISHED_FAMILY_STATUSES,
    canManagePostRecord, isPasswordProtected, canReadPostContent,
    PUBLIC_PROTECTED_META_KEYS, publicPostMeta, nonPublicPostTypes, isInternalPostType,
};
