import type { Metadata } from "next";
import HomeContent from "@/components/public/HomeContent";
import JsonLd from "@/components/public/JsonLd";
import { getSettings, getPostById, getLatestPostsPage, getPluginShortcodes, htmlToText, buildWebSiteJsonLd, resolveSiteBase } from "@/lib/server-api";
import { withResolvedBlocks } from "@/lib/resolveDynamicBlocks";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import BlogRoll from "@/components/public/BlogRoll";

// Server-rendered AND cached: the homepage serves from the Full-Route Cache (crawlers and first
// paint still get the real blog roll / static page), revalidating every 60s + purged on publish.
export const revalidate = 60;
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
            // The same resolver pass every other public route runs ([slug], pages/[slug], preview):
            // NavMenu / SiteLogo / ToC / PostsGrid on the configured front page get their real data
            // injected HERE, at the route seam, so HomeContent stays a pure renderer. Without it the
            // most-visited URL served raw _puck_data and those blocks rendered empty at '/'.
            const withBlocks = await withResolvedBlocks(page);
            // The [tag] embeds an HTML front page may carry — declared by the active plugins, not listed here.
            const shortcodes = await getPluginShortcodes().catch(() => []);
            return (
                <div className="space-y-4">
                    {siteJsonLd}
                    {/* A static front page is a PAGE (front-page → page-{slug} → page), not the blog
                        index: `home` stays the blog roll's template, below. */}
                    <ThemeTemplate
                        kind="frontPage"
                        slug={page.slug}
                        assignedTemplate={typeof page.meta?._wjs_template === "string" ? page.meta._wjs_template : undefined}
                    >
                        <HomeContent post={withBlocks} settings={settings} shortcodes={shortcodes} />
                    </ThemeTemplate>
                </div>
            );
        }
    }

    // Otherwise: the blog roll (latest published posts) — pure server-rendered markup, page 1 of
    // /page/{n} (components/public/BlogRoll).
    const roll = await getLatestPostsPage(1);

    return (
        <ThemeTemplate kind="home">
        <div className="space-y-4">
            {siteJsonLd}
            <BlogRoll posts={roll.posts} page={roll.page} totalPages={roll.totalPages} settings={settings} />
        </div>
        </ThemeTemplate>
    );
}
