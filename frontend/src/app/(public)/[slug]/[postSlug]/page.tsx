import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { getPostBySlug, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";

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
    return (
        <>
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname)} />
            <PostContent post={post} settings={settings} category={slug} />
        </>
    );
}
