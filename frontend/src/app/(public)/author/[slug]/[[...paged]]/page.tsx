import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArchivePage, { archiveMetadata, type ArchiveSpec } from "@/lib/public/archiveRoute";
import {
    getPostsBy,
    parsePagedSegments,
    postAuthorName,
    postAuthorSlug,
} from "@/lib/public/archives";

/**
 * `/author/{nicename}` and `/author/{id}` (plus `/page/{n}` under either) — the author archive.
 *
 * IT TAKES EITHER SPELLING, BECAUSE THE API RESOLVES EITHER. `GET /posts?author=` accepts an id or a
 * slug and resolves the slug against `user_nicename`/`user_login` in a parameterised subquery
 * (`Post._authorCondition`), and `Post.toJSON()` now serialises `author: { id, displayName, slug }`,
 * so a post payload hands this route the very value the filter takes. That closes what this file used
 * to describe as a gap in the API: an all-digit segment is read as an id (so a user whose LOGIN is
 * digits is not reachable by login — the right trade when the archive is also addressed by id) and
 * anything else is read as the nicename. The backend's own author feed makes exactly the same choice
 * (`/api/v1/seo/author/{slug}/feed.xml`), which matters because that channel prints
 * `{siteUrl}/author/{slug}` as its link: while this route 404'd a nicename, every author feed
 * published a canonical URL this site answered with a 404.
 *
 * THE ARCHIVE CANONICALISES TO THE SLUG when the posts carry one, exactly as the category archive
 * canonicalises to `term.slug`: `/author/4` and `/author/jane-roe` are one archive and must have one
 * address (the one the feed already advertises). Without a slug in the payload — a cached or imported
 * response that still carries a bare number — the id remains the address.
 */

export const revalidate = 60;

interface RouteParams {
    slug: string;
    paged?: string[];
}

/** A user id as a path segment: base-10, positive, and within what the id columns hold. */
function parseAuthorId(raw: string): number | null {
    if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return n <= 2147483647 ? n : null;
}

/**
 * A user_nicename / user_login as a path segment.
 *
 * Positive allowlist, and no comma: the list grammar splits `?author=` on commas into an OR-list, so
 * a segment carrying one could never denote a single author. Bounded at the same 200 characters the
 * backend's own identity grammar accepts, so an over-long segment is refused here rather than 400'd
 * there.
 */
function parseAuthorSlug(raw: string): string | null {
    return /^[A-Za-z0-9._~@+-]{1,200}$/.test(raw) ? raw : null;
}

async function resolveRoute(params: Promise<RouteParams>): Promise<ArchiveSpec | null> {
    const { slug, paged } = await params;
    const page = parsePagedSegments(paged);
    if (page === null) return null;

    const authorId = parseAuthorId(slug);
    const selector = authorId !== null ? String(authorId) : parseAuthorSlug(slug);
    if (!selector) return null;

    const posts = await getPostsBy("author", selector);
    // An author nobody wrote a post under is not an author archive with nothing in it — it is a URL
    // for a user that, as far as anything public can tell, does not exist. 404 rather than publish one
    // empty indexable page per integer (and per guessed name).
    if (posts.length === 0) return null;

    // The AUTHOR's slug, not the URL's — one archive, one address, the one the feed already prints.
    const canonicalSegment = posts.map(postAuthorSlug).find((s) => s) || selector;
    const basePath = `/author/${encodeURIComponent(canonicalSegment)}`;
    return {
        kind: "author",
        templateSlug: canonicalSegment,
        kindLabel: "Author",
        // The display name the API sends; the addressed spelling only when a payload carries no name.
        title: posts.map(postAuthorName).find((n) => n) || `Author ${canonicalSegment}`,
        basePath,
        // The author's own RSS channel, served at this public URL by author/[slug]/feed.xml/route.ts
        // (the backend resolves an id or a nicename there too). Without this the route existed and
        // nothing linked to it: no <link rel="alternate"> on the page, so no reader could find it.
        feedPath: `${basePath}/feed.xml`,
        posts,
        page,
    };
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const spec = await resolveRoute(params);
    if (!spec) return { title: "Not found", robots: { index: false } };
    return archiveMetadata(spec);
}

export default async function AuthorArchive({ params }: { params: Promise<RouteParams> }) {
    const spec = await resolveRoute(params);
    if (!spec) notFound();
    return <ArchivePage {...spec} />;
}
