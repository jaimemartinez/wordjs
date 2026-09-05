import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArchivePage, { archiveMetadata, type ArchiveSpec } from "@/lib/public/archiveRoute";
import {
    ARCHIVE_TAXONOMIES,
    findTermBySlug,
    getPostsBy,
    getTaxonomy,
    parsePagedSegments,
    taxonomyBase,
    taxonomyFeedPath,
    termSelector,
    type ArchiveTaxonomy,
} from "@/lib/public/archives";

/**
 * `/taxonomy/{taxonomy}/{term}` — the generic taxonomy archive.
 *
 * WHAT IT SERVES TODAY: the taxonomies whose data the public API actually exposes, which is `category`
 * and `post_tag` and nothing else. Those two already have dedicated, WordPress-shaped addresses
 * (`/category/{slug}`, `/tag/{slug}` — the taxonomy's own `rewrite.slug`), so this route renders the
 * same listing but CANONICALISES to the dedicated URL: one archive, one indexable address, exactly the
 * way `/{category}/{postSlug}` canonicalises to `/{postSlug}`.
 *
 * WHY A CUSTOM TAXONOMY 404s HERE, AND WHAT WOULD HAVE TO CHANGE. Registering `genre` through
 * `POST /taxonomies` gives it a registry entry and a `rewrite.slug`, and this route can read that
 * (`GET /taxonomies/{name}` is public). What does not exist is either half of the data it would need:
 *
 *   1. NO TERM LIST. Terms are readable only through `GET /categories` and `GET /tags`, each of which
 *      hard-codes its taxonomy (`backend/src/routes/categories.ts`, `.../tags.ts`). There is no
 *      `GET /terms?taxonomy=genre`, so `genre/scifi` cannot even be resolved to a term.
 *   2. NO POST→TERM FILTER FOR IT. `GET /posts` filters for real on `?categories=` and `?tags=`, and
 *      on nothing else: those are the two taxonomies the query builder knows
 *      (`Post._taxonomyCondition`) and the two `Post.toJSON()` serialises
 *      (`SERIALIZED_TAXONOMIES = ['category','post_tag']`). There is no `?taxonomy=genre&term=scifi`,
 *      so even given a term id no public response says which posts carry it.
 *
 * A route that answered 200 with the newest posts for `/taxonomy/genre/scifi` would be a listing that
 * renders confidently and means nothing. 404 until the API can answer; then only `resolveRoute` changes.
 */

export const revalidate = 60;

interface RouteParams {
    taxonomy: string;
    term: string;
    paged?: string[];
}

const SERVED = new Set<string>(ARCHIVE_TAXONOMIES);

async function resolveRoute(params: Promise<RouteParams>): Promise<ArchiveSpec | null> {
    const { taxonomy: taxonomyName, term: termSlug, paged } = await params;
    const page = parsePagedSegments(paged);
    if (page === null) return null;

    // Shape-checked before it becomes a URL segment on the backend call, the same rule every other
    // caller-supplied name in this codebase goes through.
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(taxonomyName)) return null;

    const taxonomy = await getTaxonomy(taxonomyName);
    if (!taxonomy || taxonomy.public === false) return null;
    if (!SERVED.has(taxonomy.name)) return null; // registered, but no public term/relation data — see above

    const kindTaxonomy = taxonomy.name as ArchiveTaxonomy;
    const term = await findTermBySlug(kindTaxonomy, termSlug);
    if (!term) return null;

    // The same backend filter the dedicated address uses — this route is an ALIAS, so it must resolve
    // to the identical listing rather than to a second, differently-derived one.
    const posts = await getPostsBy(kindTaxonomy === "category" ? "categories" : "tags", termSelector(term));
    // The dedicated address this taxonomy's archive really lives at — `rewrite.slug` is the model's own
    // answer to "where does this taxonomy's archive live" (`category`, `tag`).
    const base = taxonomyBase(taxonomy);
    const dedicated = base ? `/${base}/${encodeURIComponent(term.slug)}` : "";
    const basePath = `/taxonomy/${encodeURIComponent(taxonomy.name)}/${encodeURIComponent(term.slug)}`;

    return {
        kind: kindTaxonomy === "category" ? "category" : "tag",
        templateSlug: term.slug,
        kindLabel: taxonomy.label || taxonomy.name,
        title: term.name || term.slug,
        description: term.description || undefined,
        basePath,
        // Never itself when a dedicated URL exists: two paths, one archive, one canonical.
        canonicalPath: dedicated || undefined,
        feedPath: base ? taxonomyFeedPath(base, term.slug) : undefined,
        posts,
        page,
        categorySlug: kindTaxonomy === "category" ? term.slug : undefined,
        emptyMessage: "No posts under this term yet.",
    };
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const spec = await resolveRoute(params);
    if (!spec) return { title: "Not found", robots: { index: false } };
    return archiveMetadata(spec);
}

export default async function TaxonomyArchive({ params }: { params: Promise<RouteParams> }) {
    const spec = await resolveRoute(params);
    if (!spec) notFound();
    return <ArchivePage {...spec} />;
}
