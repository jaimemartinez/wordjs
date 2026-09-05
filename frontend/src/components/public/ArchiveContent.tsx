import Link from "next/link";
import type { Post } from "@/lib/api";
import { pageHref, postDateLabel, type Paginated } from "@/lib/public/archives";

/**
 * The listing every archive route renders — category, tag, author, date, custom taxonomy.
 *
 * Server Component, no client island: an archive is a list of links and a pager, and shipping JS for
 * it would only delay the thing a crawler and a reader both want in the first byte.
 *
 * THE CARD MARKUP IS THE BLOG ROLL'S. Same `wjs-post-*` hooks, same order, same Tailwind utilities as
 * `(public)/page.tsx`, because a theme that styled the front page's list must style the archive's list
 * without learning a second vocabulary. The archive adds hooks of its own (`wjs-archive-*`,
 * `wjs-pagination-*`) for the two things the front page has no equivalent of: a term header and a pager.
 * It diverges in exactly ONE place, deliberately: the card's date is formatted from the date string
 * (`postDateLabel`) instead of `toLocaleDateString()`, because this list is cached SSR HTML and a
 * server locale must not be baked into it. See the comment at the date itself.
 */

export interface ArchiveContentProps {
    /** "Category" / "Tag" / "Author" / "Archive" — the eyebrow above the term name. */
    kindLabel: string;
    /** The term's own name, the author's, or "March 2026". */
    title: string;
    /** The term description, when the taxonomy carries one. */
    description?: string;
    /** The page of posts this route resolved, already sliced. */
    page: Paginated<Post>;
    /** The archive's page-1 URL: pagination hrefs are built from it. */
    basePath: string;
    /** Shown when the term exists but has no posts. */
    emptyMessage?: string;
}

/**
 * Which page numbers to show around the current one. A site with 400 pages must not emit 400 links;
 * a window of two either side plus the two ends is what a reader can actually use, and `…` marks the
 * jumps so nobody reads `2 3 47` as consecutive.
 */
function pageWindow(current: number, total: number): Array<number | "gap"> {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const wanted = new Set<number>([1, total, current]);
    for (let d = 1; d <= 2; d++) {
        if (current - d >= 1) wanted.add(current - d);
        if (current + d <= total) wanted.add(current + d);
    }
    const sorted = [...wanted].sort((a, b) => a - b);
    const out: Array<number | "gap"> = [];
    let previous = 0;
    for (const n of sorted) {
        if (previous && n - previous > 1) out.push("gap");
        out.push(n);
        previous = n;
    }
    return out;
}

function ArchivePagination({ page, basePath }: { page: Paginated<Post>; basePath: string }) {
    if (page.totalPages <= 1) return null;
    const { page: current, totalPages } = page;
    return (
        <nav
            className="wjs-pagination mt-12 flex flex-wrap items-center justify-center gap-2 border-t border-[var(--wjs-border-subtle,#e5e7eb)] pt-8"
            aria-label="Archive pagination"
        >
            {current > 1 && (
                <Link
                    href={pageHref(basePath, current - 1)}
                    rel="prev"
                    className="wjs-pagination-prev inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                >
                    <i className="fa-solid fa-arrow-left text-sm"></i>
                    Previous
                </Link>
            )}

            {pageWindow(current, totalPages).map((entry, i) =>
                entry === "gap" ? (
                    <span key={`gap-${i}`} className="wjs-pagination-gap px-2 text-[var(--wjs-color-text-muted,#9ca3af)]">
                        &hellip;
                    </span>
                ) : entry === current ? (
                    <span
                        key={entry}
                        aria-current="page"
                        className="wjs-pagination-current px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] font-semibold"
                    >
                        {entry}
                    </span>
                ) : (
                    <Link
                        key={entry}
                        href={pageHref(basePath, entry)}
                        className="wjs-pagination-link px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                    >
                        {entry}
                    </Link>
                ),
            )}

            {current < totalPages && (
                <Link
                    href={pageHref(basePath, current + 1)}
                    rel="next"
                    className="wjs-pagination-next inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                >
                    Next
                    <i className="fa-solid fa-arrow-right text-sm"></i>
                </Link>
            )}
        </nav>
    );
}

export default function ArchiveContent({
    kindLabel,
    title,
    description,
    page,
    basePath,
    emptyMessage = "No posts here yet.",
}: ArchiveContentProps) {
    const { items, page: current, total, totalPages } = page;
    return (
        <div className="wjs-archive space-y-4">
            <header className="wjs-archive-header border-b border-[var(--wjs-border-subtle,#e5e7eb)] pb-4 mb-8">
                <p className="wjs-archive-kind text-sm font-semibold uppercase tracking-wide text-[var(--wjs-color-text-muted,#6b7280)]">
                    {kindLabel}
                </p>
                <h1 className="wjs-archive-title text-3xl font-bold text-[var(--wjs-color-heading,#1f2937)] mt-1 break-words">
                    {title}
                </h1>
                {description && (
                    <p className="wjs-archive-description mt-3 text-[var(--wjs-color-text-muted,#4b5563)] max-w-2xl">
                        {description}
                    </p>
                )}
                <p className="wjs-archive-count mt-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)]">
                    {total} post{total !== 1 ? "s" : ""}
                    {totalPages > 1 ? ` · page ${current} of ${totalPages}` : ""}
                </p>
            </header>

            {items.length === 0 ? (
                <div className="wjs-post-list-empty text-center py-12 bg-[var(--wjs-bg-muted,#f9fafb)] rounded-lg">
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)]">{emptyMessage}</p>
                </div>
            ) : (
                <div className="wjs-post-list grid grid-cols-1 gap-12">
                    {items.map((post) => (
                        <article
                            key={post.id}
                            className="wjs-post-card group bg-[var(--wjs-bg-surface,#ffffff)] rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 border border-[var(--wjs-border-subtle,#f3f4f6)] overflow-hidden"
                        >
                            <div className="wjs-post-card-body p-8">
                                <div className="wjs-post-card-meta flex flex-wrap items-center gap-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)] mb-4">
                                    <span className="wjs-post-card-badge bg-[var(--wjs-bg-muted,#eff6ff)] text-[var(--wjs-color-primary,#1d4ed8)] px-3 py-1 rounded-full font-medium">
                                        Article
                                    </span>
                                    <span>&bull;</span>
                                    {/* postDateLabel, NOT toLocaleDateString(): this markup is
                                        server-rendered into ISR-cached HTML, so a locale/zone read
                                        here is the HOST's and every visitor gets it — including the
                                        off-by-one day a post published just after midnight shows to
                                        anyone across UTC. Same date-STRING rule as postYearMonth and
                                        dateArchiveTitle, so the card and the archive title agree. */}
                                    <span>{postDateLabel(post)}</span>
                                </div>

                                <Link
                                    href={`/${post.slug || post.id}`}
                                    className="wjs-post-card-link block group-hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                                >
                                    <h2 className="wjs-post-card-title text-3xl font-bold text-[var(--wjs-color-heading,#111827)] mb-4 leading-tight">
                                        {post.title}
                                    </h2>
                                </Link>

                                <p className="wjs-post-card-excerpt text-[var(--wjs-color-text-muted,#4b5563)] mb-6 line-clamp-3 leading-relaxed">
                                    {post.excerpt || (post.content || "").substring(0, 200).replace(/<[^>]*>?/gm, "") + "..."}
                                </p>

                                <Link
                                    href={`/${post.slug || post.id}`}
                                    className="wjs-post-card-more inline-flex items-center text-[var(--wjs-color-primary,#2563eb)] font-semibold hover:gap-2 transition-all"
                                >
                                    Read Article <i className="fa-solid fa-arrow-right ms-2 text-sm"></i>
                                </Link>
                            </div>
                        </article>
                    ))}
                </div>
            )}

            <ArchivePagination page={page} basePath={basePath} />
        </div>
    );
}
