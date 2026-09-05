import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import ArchiveContent from "@/components/public/ArchiveContent";
import type { Post } from "@/lib/api";
import type { TemplateKind } from "@/lib/templateData";
import { getSettings } from "@/lib/server-api";
import { buildArchiveMetadata, getPostsPerPage, paginate } from "@/lib/public/archives";

/**
 * THE ONE ARCHIVE RENDERER. `/category`, `/tag`, `/author`, `/archive/{yyyy}[/{mm}]` and
 * `/taxonomy/{taxonomy}/{term}` differ only in how they NARROW the published set and what they call
 * the result; everything after that — page size, slicing, the template chain, the canonical, the feed
 * link, the markup — is identical, and identical is what it has to stay. Five copies of this would be
 * five chances for one archive to paginate, canonicalise or template differently from the others.
 *
 * Each route resolves its own term (and 404s when there isn't one), then hands the narrowed list here.
 */

export interface ArchiveSpec {
    /** Which template chain to ask the theme for: `category` → `category-{slug}` → `archive` → `page`. */
    kind: Extract<TemplateKind, "category" | "tag" | "author" | "date">;
    /** The term slug that makes the chain's first name specific. Omitted for date archives. */
    templateSlug?: string;
    /** Eyebrow above the title: "Category", "Tag", "Author", "Archive". */
    kindLabel: string;
    /** The term's name, the author's, or "March 2026". */
    title: string;
    description?: string;
    /** The archive's page-1 path — pagination, canonical and the feed link are all built from it. */
    basePath: string;
    /** Only when this URL is an ALIAS of another archive (see `/taxonomy/...`). */
    canonicalPath?: string;
    /** Where the per-archive RSS will be served. Omitted for archives that have no feed. */
    feedPath?: string;
    /** Every published post this archive is about, already narrowed and newest-first. */
    posts: Post[];
    /** 1-based, already validated by the route. */
    page: number;
    /**
     * Narrows a `CategoryPosts` block in the theme's template that declares no `categorySlug` of its
     * own, so a template shared by every taxonomy archive still shows THIS term's posts.
     */
    categorySlug?: string;
    emptyMessage?: string;
}

export async function archiveMetadata(spec: ArchiveSpec): Promise<Metadata> {
    const settings = await getSettings();
    return buildArchiveMetadata({
        basePath: spec.basePath,
        page: spec.page,
        title: spec.title,
        description: spec.description,
        siteName: settings?.blogname,
        feedPath: spec.feedPath,
        canonicalPath: spec.canonicalPath,
    });
}

/**
 * Renders the archive inside the theme's template.
 *
 * THE ROUTE HANDS THE TEMPLATE ITS OWN POSTS — the whole narrowed list, not the current page's slice.
 * A `PostsGrid`/`CategoryPosts` a theme places on `archive.json` carries its own `count`, and giving it
 * the slice would silently cap it at `posts_per_page` on page 1 and show page 3's posts on page 3. The
 * pager below the template's content is the route's own; the block's listing is the theme's.
 */
export default async function ArchivePage(spec: ArchiveSpec) {
    const perPage = await getPostsPerPage();
    const page = paginate(spec.posts, spec.page, perPage);
    // `/category/news/page/99` on a three-page archive is not an empty listing, it is a URL that does
    // not exist: rendering it would answer 200 with a page whose only content is a pager pointing
    // somewhere else, and a crawler would index one such page per number anyone ever guessed.
    if (spec.page > page.totalPages) notFound();
    return (
        <ThemeTemplate
            kind={spec.kind}
            slug={spec.templateSlug}
            context={{ posts: spec.posts, categorySlug: spec.categorySlug }}
        >
            <ArchiveContent
                kindLabel={spec.kindLabel}
                title={spec.title}
                description={spec.description}
                page={page}
                basePath={spec.basePath}
                emptyMessage={spec.emptyMessage}
            />
        </ThemeTemplate>
    );
}
