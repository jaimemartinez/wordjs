import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { permanentRedirect } from "next/navigation";
import { getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase, contentNotFound } from "@/lib/server-api";
import { resolveCategoryPost } from "@/lib/public/categoryPostRoute";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";
import ThemeTemplate from "@/components/content/ThemeTemplate";

// Public content: on-demand ISR like /[slug] (no gSP — the category/post combinations are open).
export const revalidate = 60;

interface RouteParams {
    slug: string;      // category segment
    postSlug: string;  // the post slug/id
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const { slug, postSlug } = await params;
    // The POST of that slug first (getCategoryPostBySlug): a page sharing the slug owns the bare /<slug>,
    // not this category URL.
    const resolved = await resolveCategoryPost(slug, postSlug);
    if (!resolved || !("post" in resolved)) return { title: "Not found", robots: { index: false } };
    const post = resolved.post;
    const settings = await getSettings();
    // Canonical resolves to the post's primary URL (/slug), not the category path, so the two URLs
    // don't compete as duplicate content.
    return buildPostMetadata(post, {
        siteName: settings?.blogname,
        mediaBase: settings?.media_public_base,
        canonicalPath: `/${post.slug || post.id}`,
    });
}

export default async function CategoryPostPage({ params }: { params: Promise<RouteParams> }) {
    const { slug, postSlug } = await params;
    const [resolved, settings, base] = await Promise.all([resolveCategoryPost(slug, postSlug), getSettings(), resolveSiteBase()]);
    if (!resolved) contentNotFound();
    if ("redirect" in resolved) permanentRedirect(resolved.redirect);
    const post = resolved.post;
    // Real posts for the dynamic blocks, resolved server-side (see resolveDynamicBlocks).
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname, settings?.media_public_base)} />
            {/* Same post, same template chain as /[slug] — the category segment is a path, not a
                different kind of thing, so it must not resolve to a different arrangement. */}
            <ThemeTemplate
                kind="single"
                postType={post.type}
                slug={post.slug}
                assignedTemplate={typeof post.meta?._wjs_template === "string" ? post.meta._wjs_template : undefined}
            >
                <PostContent post={withBlocks} settings={settings} category={slug} />
            </ThemeTemplate>
        </>
    );
}
