/**
 * THE POSTS PAGE (Settings → Reading «Posts page», `page_for_posts`).
 *
 * With a static front page the blog roll had nowhere to live: posts were reachable only through author
 * and category archives (QA M2-07). The chosen page now shows the roll — `/<its slug>` is page 1 and
 * `/<its slug>/page/<n>` page n. It applies only while the front page IS a static page, as in WordPress:
 * with «Latest posts» on the front page the roll is `/` and the page renders as an ordinary page.
 */

type Settings = Record<string, unknown> | null | undefined;

function idOf(v: unknown): string {
    const s = v === null || v === undefined ? "" : String(v).trim();
    return /^[1-9][0-9]*$/.test(s) ? s : "";
}

/** The posts page's id while it is in effect (a static front page is set), or "". */
export function postsPageId(settings: Settings): string {
    if (!settings || !idOf(settings.homepage_id)) return "";
    const id = idOf(settings.page_for_posts);
    return id && id !== idOf(settings.homepage_id) ? id : "";
}

/** Is `post` the posts page? */
export function isPostsPage(post: { id?: unknown } | null | undefined, settings: Settings): boolean {
    const id = postsPageId(settings);
    return !!id && !!post && String(post.id) === id;
}

/** `/<slug>` for page 1 of the posts page, `/<slug>/page/<n>` after that. */
export function postsPageHref(slug: string, page: number): string {
    const base = "/" + encodeURIComponent(slug);
    return page <= 1 ? base : base + "/page/" + page;
}
