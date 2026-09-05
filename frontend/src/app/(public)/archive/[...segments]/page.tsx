import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArchivePage, { archiveMetadata, type ArchiveSpec } from "@/lib/public/archiveRoute";
import {
    dateArchiveTitle,
    filterPostsByDate,
    getAllPublishedPosts,
    parseMonth,
    parsePagedSegments,
    parseYear,
} from "@/lib/public/archives";

/**
 * DATE ARCHIVES — `/archive/{yyyy}`, `/archive/{yyyy}/{mm}`, and `/page/{n}` under either.
 *
 * WHY NOT `/{yyyy}` AND `/{yyyy}/{mm}`, WHICH IS WHAT WORDPRESS SERVES.
 * Those two addresses are already taken by dynamic segments: `(public)/[slug]/page.tsx` owns every
 * one-segment public path and `(public)/[slug]/[postSlug]/page.tsx` owns every two-segment one. Next's
 * router refuses two different dynamic names in the same position at build time ("You cannot use
 * different slug names for the same dynamic path"), so `/[yyyy]` cannot exist beside `/[slug]` at all —
 * and even if it could, only ONE of them can match `/2026`, which would mean either a post slugged
 * `2026` or the year archive, never both. The literal `/archive` prefix is the collision-free address,
 * at the cost of reserving the slug `archive` for a post or page (the same trade `/search`, `/pages`
 * and `/preview` already make).
 *
 * `/archive` on its own is not a route: a catch-all (not an OPTIONAL catch-all) is used so Next 404s
 * it without this file being asked to invent "every post ever" as a listing.
 */

export const revalidate = 60;

interface RouteParams {
    segments: string[];
}

async function resolveRoute(params: Promise<RouteParams>): Promise<ArchiveSpec | null> {
    const { segments } = await params;
    const segs = Array.isArray(segments) ? segments : [];
    if (segs.length === 0) return null;

    const year = parseYear(segs[0]);
    if (!year) return null;

    // The second segment is either a month or the start of the `/page/{n}` tail — never both, and
    // never anything else. `/archive/2026/13` is a 404 rather than a listing that renders empty.
    let month: string | undefined;
    let tailAt = 1;
    if (segs.length > 1 && segs[1] !== "page") {
        const parsed = parseMonth(segs[1]);
        if (!parsed) return null;
        month = parsed;
        tailAt = 2;
    }

    const page = parsePagedSegments(segs.slice(tailAt));
    if (page === null) return null;

    // THE ONE ARCHIVE THAT STILL READS THE WHOLE SET. `GET /posts` filters on categories, tags and
    // author, but has no date filter at all, so a year/month is narrowed here on the date STRING.
    // getAllPublishedPosts' MAX_POST_PAGES ceiling is therefore real for this route: a site with more
    // published posts than that walks covers only the newest of them, and an older year answers 404.
    // Closing it needs a backend `?year=`/`?month=` (or `?after=`/`?before=`), not another pass here.
    const posts = filterPostsByDate(await getAllPublishedPosts("post"), year, month);
    // A month nobody published in is a URL for nothing. Refusing it keeps the crawlable surface finite:
    // without this, every year/month pair back to the year 1000 would answer 200 with an empty page.
    if (posts.length === 0) return null;

    const basePath = month ? `/archive/${year}/${month}` : `/archive/${year}`;
    return {
        kind: "date",
        kindLabel: "Archive",
        title: dateArchiveTitle(year, month),
        basePath,
        posts,
        page,
    };
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const spec = await resolveRoute(params);
    if (!spec) return { title: "Not found", robots: { index: false } };
    return archiveMetadata(spec);
}

export default async function DateArchive({ params }: { params: Promise<RouteParams> }) {
    const spec = await resolveRoute(params);
    if (!spec) notFound();
    return <ArchivePage {...spec} />;
}
