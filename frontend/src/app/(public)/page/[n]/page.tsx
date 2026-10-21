import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import BlogRoll, { blogRollHref } from "@/components/public/BlogRoll";
import { contentNotFound, getLatestPostsPage, getSettings } from "@/lib/server-api";

/**
 * `/page/{n}` — page n of the «Latest posts» front page (`/` is page 1).
 *
 * It exists only while the front page IS the blog roll: with a static front page (Settings → Homepage
 * display = a page) there is no roll to page through, so the route is a 404. `/page/1` redirects to `/`,
 * and a page past the end is a 404 rather than an empty roll.
 */
export const revalidate = 60;
export async function generateStaticParams() { return []; }

interface RouteParams {
    n: string;
}

function parsePage(raw: string): number | null {
    return /^[1-9][0-9]{0,5}$/.test(raw) ? parseInt(raw, 10) : null;
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const page = parsePage((await params).n);
    const settings = await getSettings();
    const siteName = settings?.blogname || "WordJS";
    if (!page) return { title: "Not found", robots: { index: false } };
    return {
        title: { absolute: `${siteName} — Page ${page}` },
        alternates: { canonical: blogRollHref(page) },
    };
}

export default async function BlogRollPage({ params }: { params: Promise<RouteParams> }) {
    const page = parsePage((await params).n);
    const settings = await getSettings();
    if (!page || !settings || settings.homepage_id) contentNotFound();
    if (page === 1) permanentRedirect("/");
    const roll = await getLatestPostsPage(page!);
    if (page! > roll.totalPages) contentNotFound();
    return (
        <ThemeTemplate kind="home">
            <div className="space-y-4">
                <BlogRoll posts={roll.posts} page={roll.page} totalPages={roll.totalPages} settings={settings!} />
            </div>
        </ThemeTemplate>
    );
}
