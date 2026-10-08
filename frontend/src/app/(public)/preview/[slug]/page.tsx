import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import { getPostBySlugPreview, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";

// Author/editor draft preview, split OUT of the public /[slug] route: preview needs the session
// cookie (per-user, never cacheable), and while it lived there as ?preview=1 the searchParams read
// forced the site's hottest route to render dynamically on EVERY hit. Here dynamic is explicit and
// correct; the public route stays static. The backend serves drafts only to their author/editors —
// an anonymous visitor gets a 404 from it, so nothing leaks.
export const dynamic = "force-dynamic";

interface RouteParams {
    slug: string;
}

// `?type=` names the type of the entry the editor opened (lib/previewHref). Without it, a slug that a
// post and a page share resolves to the PAGE (the backend's order for the bare URL), so previewing the
// post's draft showed the published page instead. getPostBySlugPreview sends only a well-formed type.
type PreviewSearch = Promise<{ type?: string | string[] }>;
const typeOf = async (searchParams?: PreviewSearch): Promise<string | undefined> => {
    const t = searchParams ? (await searchParams).type : undefined;
    return typeof t === "string" ? t : undefined;
};

export async function generateMetadata(
    { params, searchParams }: { params: Promise<RouteParams>; searchParams?: PreviewSearch }
): Promise<Metadata> {
    const { slug } = await params;
    const post = await getPostBySlugPreview(slug, await typeOf(searchParams));
    if (!post) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    const meta = buildPostMetadata(post, {
        siteName: settings?.blogname,
        // canonical points at the LIVE URL — the preview route must never be indexed as the page
        canonicalPath: `/${post.slug || post.id}`,
    });
    meta.robots = { index: false, follow: false };
    return meta;
}

export default async function PostPreviewPage(
    { params, searchParams }: { params: Promise<RouteParams>; searchParams?: PreviewSearch }
) {
    const { slug } = await params;
    const type = await typeOf(searchParams);
    const [post, settings, base] = await Promise.all([
        getPostBySlugPreview(slug, type),
        getSettings(),
        resolveSiteBase(),
    ]);
    if (!post) notFound();
    const withBlocks = await withResolvedBlocks(post);
    return (
        <>
            {post.status !== "publish" && (
                <div className="sticky top-24 z-40 bg-amber-500 text-amber-950 text-center text-sm font-semibold px-4 py-2 shadow rounded-lg">
                    <i className="fa-solid fa-eye me-2" aria-hidden="true"></i>
                    Draft preview — only you can see this. Publish it to make it public.
                </div>
            )}
            <JsonLd data={buildPostJsonLd(post, base, settings?.blogname)} />
            {/* Same theme-template wrap as the live /[slug] route (kind follows what was loaded,
                assignment hoisted): a preview that dropped the template — now author-visible via the
                template dropdown — would show an arrangement the published page won't have. */}
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
