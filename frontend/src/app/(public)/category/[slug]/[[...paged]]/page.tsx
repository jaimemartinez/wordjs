import { contentNotFound } from "@/lib/server-api";
import { permanentRedirect } from "next/navigation";
import { ancestryMatches } from "@/lib/public/nestedPath";
import type { Metadata } from "next";
import ArchivePage, { archiveMetadata, type ArchiveSpec } from "@/lib/public/archiveRoute";
import {
    findTermBySlug,
    getPostsBy,
    getTerms,
    parsePagedSegments,
    taxonomyFeedPath,
    termSelector,
} from "@/lib/public/archives";

/**
 * `/category/{slug}` and `/category/{slug}/page/{n}` — WordPress's category archive.
 *
 * PAGINATION IS IN THE PATH, NOT THE QUERY. Reading `searchParams` would opt this route out of the
 * Full-Route Cache for every page, turning the archive into an uncached SQL hot path — the one thing
 * the F0-F5 performance work says a public route must never become. `/page/2` is a static path, so
 * every page of every archive caches exactly like `/[slug]` does.
 *
 * The optional catch-all is what lets one file serve both addresses. Anything else in that position
 * (`/category/news/foo`, `/category/news/page/0`) is a 404, not a silent fallback to page 1.
 */

// Same ISR window as the blog roll and /[slug]; purged on publish by the `posts` tag the loaders carry.
export const revalidate = 60;

/**
 * Prerender the category landing pages the build can see, exactly as `/[slug]` does for posts — this
 * is what puts the archive in the Full-Route Cache instead of re-rendering it per request. Page 2+ and
 * any term added later render on demand and are then ISR-cached (`dynamicParams` stays on by default);
 * a build with no backend simply prerenders nothing, which is the CI case.
 */
export async function generateStaticParams(): Promise<{ slug: string; paged: string[] }[]> {
    try {
        const terms = await getTerms("category");
        return terms.filter((t) => t.slug).slice(0, 50).map((t) => ({ slug: String(t.slug), paged: [] }));
    } catch {
        return [];
    }
}

interface RouteParams {
    slug: string;
    paged?: string[];
}

/** Resolve the URL to an archive, or null when it names nothing (unknown term, malformed page). */
async function resolveRoute(params: Promise<RouteParams>): Promise<ArchiveSpec | null> {
    const { slug, paged } = await params;
    const page = parsePagedSegments(paged);
    if (page === null) return null;

    const term = await findTermBySlug("category", slug);
    if (!term) return null;

    // `?categories=` is a REAL filter (see the archives.ts header): the backend answers with this
    // term's posts and nothing else, so the archive is bounded by its own size rather than the site's.
    const posts = await getPostsBy("categories", termSelector(term));
    // The TERM's slug, not the URL's: `/category/NEWS` and `/category/news` are the same archive and
    // must canonicalise (and paginate) to the one address the term actually has.
    const basePath = `/category/${encodeURIComponent(term.slug)}`;
    return {
        kind: "category",
        templateSlug: term.slug,
        kindLabel: "Category",
        title: term.name || term.slug,
        description: term.description || undefined,
        basePath,
        // The scoped RSS channel, served at this PUBLIC URL by category/[slug]/feed.xml/route.ts —
        // see taxonomyFeedPath. Autodiscovery only works if the archive page itself points at it.
        feedPath: taxonomyFeedPath("category", term.slug),
        posts,
        page,
        categorySlug: term.slug,
        emptyMessage: "No posts in this category yet.",
    };
}

/**
 * `/category/parent/child` (and `…/child/page/2`) — WordPress's nested category address. A category has
 * one address here, `/category/<its slug>`, so a path naming exactly the term's ancestry redirects there
 * permanently; any other extra segment stays a 404.
 */
async function nestedCategoryTarget(params: Promise<RouteParams>): Promise<string | null> {
    const { slug, paged } = await params;
    if (!paged || paged.length === 0) return null;
    const segments = [slug, ...paged];
    const pageAt = segments.indexOf("page");
    const path = pageAt === -1 ? segments : segments.slice(0, pageAt);
    const pageTail = pageAt === -1 ? [] : segments.slice(pageAt);
    if (path.length < 2 || (pageTail.length > 0 && parsePagedSegments(pageTail) === null)) return null;
    const terms = await getTerms("category");
    const term = await findTermBySlug("category", path[path.length - 1]);
    if (!term) return null;
    const byId = async (id: number) => terms.find((t) => t.id === id) || null;
    if (!(await ancestryMatches(term, path.slice(0, -1), byId))) return null;
    return `/category/${encodeURIComponent(term.slug)}${pageTail.length ? `/${pageTail.join("/")}` : ""}`;
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const spec = await resolveRoute(params);
    if (!spec) return { title: "Not found", robots: { index: false } };
    return archiveMetadata(spec);
}

export default async function CategoryArchive({ params }: { params: Promise<RouteParams> }) {
    const spec = await resolveRoute(params);
    if (!spec) {
        const nested = await nestedCategoryTarget(params);
        if (nested) permanentRedirect(nested);
        contentNotFound();
    }
    return <ArchivePage {...spec} />;
}
