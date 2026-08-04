import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { getPostBySlug, getPostById, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";
import type { Post } from "@/lib/api";

// Cacheable like /[slug]: no request-header reads, 60s revalidate + on-demand purge.
export const revalidate = 60;

// Prerender the published pages the build can see; the rest render on demand and ISR-cache.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
    try {
        const { getPosts } = await import("@/lib/server-api");
        const pages = await getPosts("page", "publish");
        return (pages || []).filter((p) => p.slug).slice(0, 50).map((p) => ({ slug: String(p.slug) }));
    } catch {
        return [];
    }
}

interface RouteParams {
    slug: string;
}

// Resolve a page by slug (published-only, enforced by the backend) with a numeric-id fallback.
async function loadPage(slug: string): Promise<Post | null> {
    const bySlug = await getPostBySlug(slug);
    if (bySlug) return bySlug;
    if (/^\d+$/.test(slug)) return getPostById(parseInt(slug, 10));
    return null;
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const { slug } = await params;
    const page = await loadPage(slug);
    if (!page) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    return buildPostMetadata(page, {
        siteName: settings?.blogname,
        canonicalPath: `/${page.slug || page.id}`,
    });
}

export default async function SinglePage({ params }: { params: Promise<RouteParams> }) {
    const { slug } = await params;
    const [page, settings, base] = await Promise.all([loadPage(slug), getSettings(), resolveSiteBase()]);
    if (!page) notFound();
    // Dynamic blocks (PostsGrid / CategoryPosts) are given their real posts HERE, on the server, so
    // the entries are in the SSR HTML for crawlers and no-JS visitors — not fetched, and certainly
    // not invented, in the browser.
    const withBlocks = await withResolvedBlocks(page);
    return (
        <>
            <JsonLd data={buildPostJsonLd(page, base, settings?.blogname)} />
            <PostContent post={withBlocks} settings={settings} />
        </>
    );
}
