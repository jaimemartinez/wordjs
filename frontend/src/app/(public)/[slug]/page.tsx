import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { getPostBySlug, getPostBySlugPreview, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";

interface RouteParams {
    slug: string;
}
interface QueryParams {
    preview?: string;
}

// ?preview=1 → forward the admin's session cookie so the backend serves the draft to its
// author/editors (anonymous visitors still get a 404 from the backend — nothing leaks).
const isPreview = (q: QueryParams | undefined) => q?.preview === "1";

export async function generateMetadata(
    { params, searchParams }: { params: Promise<RouteParams>; searchParams: Promise<QueryParams> }
): Promise<Metadata> {
    const { slug } = await params;
    const preview = isPreview(await searchParams);
    const post = await (preview ? getPostBySlugPreview(slug) : getPostBySlug(slug));
    if (!post) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    const meta = buildPostMetadata(post, {
        siteName: settings?.blogname,
        canonicalPath: `/${post.slug || post.id}`,
    });
    if (preview) meta.robots = { index: false, follow: false };
    return meta;
}

export default async function SinglePostPage(
    { params, searchParams }: { params: Promise<RouteParams>; searchParams: Promise<QueryParams> }
) {
    const { slug } = await params;
    const preview = isPreview(await searchParams);
    const [post, settings, base] = await Promise.all([
        preview ? getPostBySlugPreview(slug) : getPostBySlug(slug),
        getSettings(),
        resolveSiteBase(),
    ]);
    if (!post) notFound();
    // Real posts for the dynamic blocks, resolved server-side (see resolveDynamicBlocks).
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            {preview && post.status !== "publish" && (
                <div className="sticky top-24 z-40 bg-amber-500 text-amber-950 text-center text-sm font-semibold px-4 py-2 shadow rounded-lg">
                    <i className="fa-solid fa-eye mr-2" aria-hidden="true"></i>
                    Draft preview — only you can see this. Publish it to make it public.
                </div>
            )}
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname)} />
            <PostContent post={withBlocks} settings={settings} showComments />
        </>
    );
}
