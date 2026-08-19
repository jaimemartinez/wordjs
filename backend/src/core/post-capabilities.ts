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
    return {
        edit: `edit_${c}s`, publish: `publish_${c}s`, del: `delete_${c}s`,
        editPublished: `edit_published_${c}s`, deletePublished: `delete_published_${c}s`,
        editOthers: `edit_others_${c}s`, deleteOthers: `delete_others_${c}s`,
    };
}

// Resolve the capability family for a post type (post → edit_posts, page → edit_pages, custom →
// edit_<type>s) so an author holding only POST caps cannot create/edit/publish/delete PAGES.
// Returns null for an UNREGISTERED type so the CREATE path can reject it (400). Callers editing an
// existing post fall back to capsFor('post') instead of relying on this nullable result.
function capsForType(type: string) {
    const { getPostType } = require('./post-types');
    const pt = getPostType(String(type || 'post'));
    if (!pt) return null;
    return capsFor(pt.capability_type || 'post');
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
    // permission to rewrite what the site is currently serving.
    if (post.postStatus === 'publish' && !user.can(caps.editPublished)) allowed = false;
    return allowed;
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

module.exports = { capsFor, capsForType, canEditPostRecord, isRestExposedPostType };
