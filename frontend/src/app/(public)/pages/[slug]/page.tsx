import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import JsonLd from "@/components/public/JsonLd";
import { getPostBySlug, getPostById, getSettings, buildPostMetadata, buildPostJsonLd, resolveSiteBase } from "@/lib/server-api";
import type { Post } from "@/lib/api";

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
    return (
        <>
            <JsonLd data={buildPostJsonLd(page, base, settings?.blogname)} />
            <PostContent post={page} settings={settings} />
        </>
    );
}
