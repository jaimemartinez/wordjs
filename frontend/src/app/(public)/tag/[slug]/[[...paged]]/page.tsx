import { notFound } from "next/navigation";
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
 * `/tag/{slug}` and `/tag/{slug}/page/{n}` — WordPress's tag archive.
 *
 * Identical in every respect to the category archive except the taxonomy it narrows on and the
 * template chain it asks for (`tag-{slug}` → `tag` → `archive` → `page`). See
 * `(public)/category/[slug]/[[...paged]]/page.tsx` for why pagination lives in the path.
 */

export const revalidate = 60;

/** Same reasoning as the category archive's: prerender the tag landings the build can see. */
export async function generateStaticParams(): Promise<{ slug: string; paged: string[] }[]> {
    try {
        const terms = await getTerms("post_tag");
        return terms.filter((t) => t.slug).slice(0, 50).map((t) => ({ slug: String(t.slug), paged: [] }));
    } catch {
        return [];
    }
}

interface RouteParams {
    slug: string;
    paged?: string[];
}

async function resolveRoute(params: Promise<RouteParams>): Promise<ArchiveSpec | null> {
    const { slug, paged } = await params;
    const page = parsePagedSegments(paged);
    if (page === null) return null;

    const term = await findTermBySlug("post_tag", slug);
    if (!term) return null;

    // `?tags=` is a REAL filter (see the archives.ts header): one bounded walk over THIS tag's posts.
    const posts = await getPostsBy("tags", termSelector(term));
    const basePath = `/tag/${encodeURIComponent(term.slug)}`;
    return {
        kind: "tag",
        templateSlug: term.slug,
        kindLabel: "Tag",
        title: term.name || term.slug,
        description: term.description || undefined,
        basePath,
        feedPath: taxonomyFeedPath("tag", term.slug),
        posts,
        page,
        emptyMessage: "No posts with this tag yet.",
    };
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const spec = await resolveRoute(params);
    if (!spec) return { title: "Not found", robots: { index: false } };
    return archiveMetadata(spec);
}

export default async function TagArchive({ params }: { params: Promise<RouteParams> }) {
    const spec = await resolveRoute(params);
    if (!spec) notFound();
    return <ArchivePage {...spec} />;
}
