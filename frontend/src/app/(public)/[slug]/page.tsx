import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import { getPostBySlug, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
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

interface RouteParams {
    slug: string;
}

export async function generateMetadata(
    { params }: { params: Promise<RouteParams> }
): Promise<Metadata> {
    const { slug } = await params;
    const post = await getPostBySlug(slug);
    if (!post) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    return buildPostMetadata(post, {
        siteName: settings?.blogname,
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
    if (!post) notFound();
    // Real posts for the dynamic blocks, resolved server-side (see resolveDynamicBlocks).
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname)} />
            <ThemeTemplate kind="single">
                <PostContent post={withBlocks} settings={settings} showComments />
            </ThemeTemplate>
        </>
    );
}
