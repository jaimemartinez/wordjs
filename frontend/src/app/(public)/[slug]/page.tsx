import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import { getPostBySlug, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase, contentNotFound, getLatestPostsPage } from "@/lib/server-api";
import BlogRoll from "@/components/public/BlogRoll";
import { isPostsPage, postsPageHref } from "@/lib/public/postsPage";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";

// The site's hottest route serves from the Full-Route Cache: no request-header/searchParams reads
// (draft preview lives at /preview/[slug], which is dynamic on purpose). Content revalidates every
// 60s; on-demand purge on publish/update makes changes instant.
export const revalidate = 60;

// Prerender the published posts the build can see; anything else (new posts, CI builds with no
// backend) renders on demand and is then ISR-cached — dynamicParams stays on by default.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
    try {
        const { getPosts } = await import("@/lib/server-api");
        const posts = await getPosts("post", "publish");
        return (posts || []).filter((p) => p.slug).slice(0, 50).map((p) => ({ slug: String(p.slug) }));
    } catch {
        return [];
    }
}

/**
 * Reusable symbols (lib/symbols, type `wjs_symbol`) are public so pages can render them, but a symbol is
 * a fragment of other pages, not a page: the untyped slug lookup must not serve one at its own URL.
 */
function isRoutedEntry(post: { type?: string }): boolean {
    return post.type !== "wjs_symbol";
}

interface RouteParams {
    slug: string;
}

export async function generateMetadata(
    { params }: { params: Promise<RouteParams> }
): Promise<Metadata> {
    const { slug } = await params;
    const post = await getPostBySlug(slug);
    if (!post || !isRoutedEntry(post)) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    return buildPostMetadata(post, {
        siteName: settings?.blogname,
        mediaBase: settings?.media_public_base,
        canonicalPath: `/${post.slug || post.id}`,
    });
}

export default async function SinglePostPage(
    { params }: { params: Promise<RouteParams> }
) {
    const { slug } = await params;
    const [post, settings, base] = await Promise.all([
        getPostBySlug(slug),
        getSettings(),
        resolveSiteBase(),
    ]);
    if (!post || !isRoutedEntry(post)) contentNotFound();
    // The posts page (Settings → Reading) shows the blog roll, page 1 (lib/public/postsPage).
    if (isPostsPage(post, settings)) {
        const roll = await getLatestPostsPage(1);
        const slugOf = post.slug || String(post.id);
        return (
            <ThemeTemplate kind="home">
                <div className="space-y-4">
                    <h1 className="sr-only">{post.title}</h1>
                    <BlogRoll posts={roll.posts} page={roll.page} totalPages={roll.totalPages} settings={settings!} hrefFor={(n) => postsPageHref(slugOf, n)} />
                </div>
            </ThemeTemplate>
        );
    }
    // Real posts for the dynamic blocks, resolved server-side (see resolveDynamicBlocks).
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname, settings?.media_public_base)} />
            {/* The hierarchy needs what this route knows: single-<type>-<slug> → single-<type> →
                single → page. The post's own slug, not the URL param, so /42 and /hello-world (the
                numeric-id fallback) resolve to the same template. */}
            {/* This route serves BOTH posts and pages — a page's canonical URL is `/{slug}`, not
                `/pages/{slug}` (see canonicalPath in generateMetadata above). Passing "single"
                unconditionally meant a page here asked for `single-page-about` and never for
                `page-about`, so the per-slug page template documented in the route table applied on
                no URL a visitor or a crawler ever sees. The kind follows what was actually loaded. */}
            <ThemeTemplate
                kind={post.type === "page" ? "page" : "single"}
                postType={post.type}
                slug={post.slug}
                assignedTemplate={typeof post.meta?._wjs_template === "string" ? post.meta._wjs_template : undefined}
            >
                <PostContent post={withBlocks} settings={settings} showComments />
            </ThemeTemplate>
        </>
    );
}
