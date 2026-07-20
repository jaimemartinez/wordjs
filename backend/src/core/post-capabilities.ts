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

module.exports = { capsFor, capsForType };
