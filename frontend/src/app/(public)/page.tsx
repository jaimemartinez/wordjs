import Link from "next/link";
import type { Metadata } from "next";
import HomeContent from "@/components/public/HomeContent";
import JsonLd from "@/components/public/JsonLd";
import { getSettings, getPostById, getPosts, htmlToText, buildWebSiteJsonLd, resolveSiteBase } from "@/lib/server-api";

// Homepage is dynamic: content is fetched server-side per request (no-store), so crawlers and first
// paint get the real blog roll / static page, not an empty skeleton.
export async function generateMetadata(): Promise<Metadata> {
    const settings = await getSettings();
    const siteName = settings?.blogname || "WordJS";
    const tagline = settings?.blogdescription || "";
    let description: string | undefined = tagline || undefined;

    const homepageId = settings?.homepage_id;
    if (homepageId) {
        const page = await getPostById(parseInt(homepageId, 10));
        if (page) description = htmlToText(page.excerpt || page.content, 160) || description;
    }

    // `absolute` bypasses the root layout's "%s | site" template so the homepage title isn't doubled.
    const title = tagline ? `${siteName} — ${tagline}` : siteName;
    return {
        title: { absolute: title },
        description,
        alternates: { canonical: "/" },
        openGraph: { title, description, type: "website", url: "/", siteName },
        twitter: { card: "summary", title, description },
    };
}

function ServiceUnavailable() {
    return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center p-8 text-center">
            <div className="text-red-500 text-6xl mb-6">
                <i className="fa-solid fa-triangle-exclamation"></i>
            </div>
            <h1 className="text-3xl font-bold text-[var(--wjs-color-heading,#1f2937)] mb-3">Service Temporarily Unavailable</h1>
            <p className="text-[var(--wjs-color-text-muted,#4b5563)] max-w-md text-lg">
                We&apos;re having trouble reaching the server right now. Please check back soon.
            </p>
        </div>
    );
}

export default async function HomePage() {
    const settings = await getSettings();
    if (!settings) return <ServiceUnavailable />;

    // WebSite schema (+SearchAction → /search?q=) on the front page enables sitelinks search box
    // and names the site for rich results.
    const base = await resolveSiteBase();
    const siteJsonLd = <JsonLd data={buildWebSiteJsonLd(base, settings.blogname || "WordJS", settings.blogdescription || undefined)} />;

    // Static front page (a specific page chosen in Settings)
    const homepageId = settings.homepage_id;
    if (homepageId) {
        const page = await getPostById(parseInt(homepageId, 10));
        if (page) {
            return (
                <div className="space-y-4">
                    {siteJsonLd}
                    <HomeContent post={page} />
                </div>
            );
        }
    }

    // Otherwise: the blog roll (latest published posts) — pure server-rendered markup.
    const posts = (await getPosts("post", "publish")) || [];
    const published = posts.filter((p) => p.status === "publish");

    return (
        <div className="space-y-4">
            {siteJsonLd}
            <div className="border-b border-[var(--wjs-border-subtle,#e5e7eb)] pb-4 mb-8">
                <h2 className="text-2xl font-bold text-[var(--wjs-color-heading,#1f2937)]">Latest Posts</h2>
            </div>

            {published.length === 0 ? (
                <div className="text-center py-12 bg-[var(--wjs-bg-muted,#f9fafb)] rounded-lg">
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)]">No posts found. Go to Admin to create one!</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-12">
                    {published.map((post) => (
                        <article key={post.id} className="group bg-[var(--wjs-bg-surface,#ffffff)] rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 border border-[var(--wjs-border-subtle,#f3f4f6)] overflow-hidden">
                            <div className="p-8">
                                <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)] mb-4">
                                    <span className="bg-[var(--wjs-bg-muted,#eff6ff)] text-[var(--wjs-color-primary,#1d4ed8)] px-3 py-1 rounded-full font-medium">Article</span>
                                    <span>•</span>
                                    <span>{post.date ? new Date(post.date).toLocaleDateString() : ''}</span>
                                    <span>•</span>
                                    <span>{post.author?.displayName || "Admin"}</span>
                                </div>

                                <Link href={`/${post.slug || post.id}`} className="block group-hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                                    <h3 className="text-3xl font-bold text-[var(--wjs-color-heading,#111827)] mb-4 leading-tight">
                                        {post.title}
                                    </h3>
                                </Link>

                                <p className="text-[var(--wjs-color-text-muted,#4b5563)] mb-6 line-clamp-3 leading-relaxed">
                                    {post.excerpt || post.content.substring(0, 200).replace(/<[^>]*>?/gm, "") + "..."}
                                </p>

                                <Link href={`/${post.slug || post.id}`} className="inline-flex items-center text-[var(--wjs-color-primary,#2563eb)] font-semibold hover:gap-2 transition-all">
                                    Read Article <i className="fa-solid fa-arrow-right ml-2 text-sm"></i>
                                </Link>
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}
