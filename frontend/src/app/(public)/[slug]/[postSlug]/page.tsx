import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { getPostBySlug, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";
import ThemeTemplate from "@/components/content/ThemeTemplate";

// Public content: on-demand ISR like /[slug] (no gSP — the category/post combinations are open).
export const revalidate = 60;

interface RouteParams {
    slug: string;      // category segment
    postSlug: string;  // the post slug/id
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const { postSlug } = await params;
    const post = await getPostBySlug(postSlug);
    if (!post) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    // Canonical resolves to the post's primary URL (/slug), not the category path, so the two URLs
    // don't compete as duplicate content.
    return buildPostMetadata(post, {
        siteName: settings?.blogname,
        canonicalPath: `/${post.slug || post.id}`,
    });
}

export default async function CategoryPostPage({ params }: { params: Promise<RouteParams> }) {
    const { slug, postSlug } = await params;
    const [post, settings, base] = await Promise.all([getPostBySlug(postSlug), getSettings(), resolveSiteBase()]);
    if (!post) notFound();
    // Real posts for the dynamic blocks, resolved server-side (see resolveDynamicBlocks).
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname)} />
            {/* Same post, same template chain as /[slug] — the category segment is a path, not a
                different kind of thing, so it must not resolve to a different arrangement. */}
            <ThemeTemplate kind="single" postType={post.type} slug={post.slug}>
                <PostContent post={withBlocks} settings={settings} category={slug} />
            </ThemeTemplate>
        </>
    );
}
