import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { getPostBySlug, getPostById, contentNotFound, getSettings, getLatestPostsPage } from "@/lib/server-api";
import { ancestryMatches, ownPath } from "@/lib/public/nestedPath";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import BlogRoll from "@/components/public/BlogRoll";
import { isPostsPage, postsPageHref } from "@/lib/public/postsPage";

/** `/<posts page>/page/<n>`: page n of the blog roll on the posts page (lib/public/postsPage), or null. */
async function postsPageRoll(params: Promise<RouteParams>) {
    const { slug, postSlug, rest } = await params;
    if (postSlug !== "page" || !rest || rest.length !== 1 || !/^[1-9][0-9]{0,5}$/.test(rest[0])) return null;
    const [entry, settings] = await Promise.all([getPostBySlug(slug), getSettings()]);
    if (!entry || !settings || !isPostsPage(entry, settings)) return null;
    return { entry, settings, page: parseInt(rest[0], 10) };
}

/**
 * `/<a>/<b>/<c>…` — a WordPress nested page address (`/level-1/level-2/level-3`). Every page is served
 * at its own slug here, so an address whose segments are exactly the page's ancestry redirects there
 * permanently (old links and search results keep working); anything else is a 404.
 */

export const revalidate = 60;

interface RouteParams {
    slug: string;
    postSlug: string;
    rest: string[];
}

async function nestedTarget(params: Promise<RouteParams>): Promise<string | null> {
    const { slug, postSlug, rest } = await params;
    const segments = [slug, postSlug, ...(rest || [])].filter(Boolean);
    const last = segments[segments.length - 1];
    const entry = last ? await getPostBySlug(last) : null;
    if (!entry || entry.type === "post") return null;
    return (await ancestryMatches(entry, segments.slice(0, -1), getPostById)) ? ownPath("", entry.slug || String(entry.id)) : null;
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const roll = await postsPageRoll(params);
    if (roll) return { title: roll.entry.title + " — Page " + roll.page, alternates: { canonical: postsPageHref(roll.entry.slug || String(roll.entry.id), roll.page) } };
    // Every other answer is a redirect or a 404; neither is indexed.
    return { robots: { index: false } };
}

export default async function NestedPageRedirect({ params }: { params: Promise<RouteParams> }) {
    const roll = await postsPageRoll(params);
    if (roll) {
        const slugOf = roll.entry.slug || String(roll.entry.id);
        if (roll.page === 1) permanentRedirect(postsPageHref(slugOf, 1));
        const data = await getLatestPostsPage(roll.page);
        if (roll.page > data.totalPages) contentNotFound();
        return (
            <ThemeTemplate kind="home">
                <div className="space-y-4">
                    <h1 className="sr-only">{roll.entry.title}</h1>
                    <BlogRoll posts={data.posts} page={data.page} totalPages={data.totalPages} settings={roll.settings} hrefFor={(n) => postsPageHref(slugOf, n)} />
                </div>
            </ThemeTemplate>
        );
    }
    const target = await nestedTarget(params);
    if (!target) contentNotFound();
    permanentRedirect(target);
    return null;
}
