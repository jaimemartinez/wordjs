/**
 * WordJS Plugin: Related Posts
 *
 * Blocks-only plugin (WordPress YARPP / Jetpack Related Posts parity).
 *
 * All the logic lives in the Puck block (client/puck/RelatedPostsPuck.tsx): it runs in the
 * visitor's browser, detects the current post from the URL, and reads the CORE public REST API
 * (/api/v1/posts + /api/v1/posts/slug/:slug) with the visitor's same-origin session. The plugin
 * backend cannot query core tables from the sandbox, so there is deliberately NO backend surface:
 * no routes, no tables, no options — permissions: [].
 *
 * Category detection note (verified against core): Post.toJSON() does NOT expose taxonomy terms,
 * and the posts LIST endpoint ignores its `categories` query param on the read path. The only
 * API-visible category association is meta._puck_data.root.props.category (the category NAME the
 * post editor stores). The block therefore fetches the latest posts and matches that field
 * client-side, falling back to "most recent posts" when nothing shares a category.
 */

exports.metadata = {
    name: 'Related Posts',
    version: '1.0.0',
    description: 'Automatic per-post related-article cards via the Puck block "RelatedPosts"',
    author: 'WordJS',
};

exports.init = async function (wordjs) {
    // No bridge usage: the block is self-contained client code served through the generated
    // puck registry. Keeping init a no-op (and permissions empty) means there is nothing to
    // grant and nothing that can fail at boot.
    void wordjs;
    console.log('[related-posts] initialized (blocks-only plugin, no backend surface)');
};

exports.deactivate = function () {
    // Nothing to tear down: no routes, timers, tables or assets were registered.
};
