import Link from "next/link";
import type { Metadata } from "next";
import { getSettings, searchPostsPaged } from "@/lib/server-api";
import { getPostsPerPage } from "@/lib/public/archives";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import { postCardExcerpt } from "@/lib/postExcerpt";
import { formatSiteDate, siteDateLanguage, siteTimeZone } from "@/lib/public/siteDate";

interface SearchParams {
    q?: string | string[];
    page?: string | string[];
}

function readPage(p: SearchParams["page"]): number {
    const n = parseInt(String(Array.isArray(p) ? p[0] : p || "1"), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

const searchHref = (query: string, page: number) =>
    `/search?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;

function readQuery(q: SearchParams["q"]): string {
    const raw = Array.isArray(q) ? q[0] : q;
    return (raw || "").trim();
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
    const query = readQuery((await searchParams).q);
    // Search result pages should not be indexed (thin/duplicate content).
    return {
        title: query ? `Search: ${query}` : "Search",
        robots: { index: false, follow: true },
    };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const params = await searchParams;
    const query = readQuery(params.q);
    // A page of results with the REAL total (it said "10 results" with hundreds, and had no pager).
    const found = query ? await searchPostsPaged(query, readPage(params.page), await getPostsPerPage()) : null;
    const results = found ? found.posts : [];
    const total = found ? found.total : 0;
    const siteSettings = await getSettings();
    const dateLang = siteDateLanguage(siteSettings);
    const dateZone = siteTimeZone(siteSettings);

    // The route hands the template its OWN results: a listing a theme places on the search template
    // must answer the search, not show the newest posts.
    return (
        <ThemeTemplate kind="search" context={{ posts: results }}>
        {/* `wjs-*` hooks are the theme contract: STABLE names alongside the Tailwind utilities. They add
            no styling of their own — the manifest promises them and the chrome-selector contract test
            proves the markup still emits them. */}
        <div className="wjs-search-page max-w-4xl mx-auto px-4 py-12">
            {/* Header */}
            <div className="wjs-search-header mb-12">
                <h1 className="wjs-search-title text-4xl font-bold text-[var(--wjs-color-text-main,#1a1a1a)] mb-4">
                    Search Results
                </h1>
                {query && (
                    <p className="wjs-search-summary text-lg text-[var(--wjs-color-text-muted,#6b7280)] break-words">
                        {total} result{total !== 1 ? "s" : ""} for &quot;{query}&quot;
                        {found && found.totalPages > 1 ? ` · page ${found.page} of ${found.totalPages}` : ""}
                    </p>
                )}
            </div>

            {/* Search form — a plain GET form, so it works with JavaScript disabled. */}
            <form className="wjs-search-form mb-12" action="/search" method="get">
                <div className="flex gap-3">
                    <input
                        type="search"
                        name="q"
                        defaultValue={query}
                        placeholder="Search again..."
                        className="flex-1 min-w-0 p-[var(--wjs-search-input-pad,1rem_1.25rem)] text-lg border border-[var(--wjs-border-subtle,#e5e7eb)] rounded-[var(--wjs-search-input-radius,0.75rem)] bg-[var(--wjs-bg-surface,#fff)] focus:outline-none focus:ring-2 focus:ring-[var(--wjs-color-primary,#2563eb)] focus:border-transparent transition-all"
                    />
                    <button
                        type="submit"
                        className="p-[var(--wjs-search-button-pad,1rem_2rem)] bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] rounded-[var(--wjs-search-button-radius,0.75rem)] font-semibold hover:opacity-90 transition-opacity flex items-center gap-2"
                    >
                        <i className="fa-solid fa-search"></i>
                        Search
                    </button>
                </div>
            </form>

            {/* No query */}
            {/* rounded-2xl (1rem) maps to the UNDECLARED --wjs-card-radius: ui.css :root pre-declares
                --wjs-radius-lg at 0.75rem, which would beat a 1rem parity fallback. */}
            {!query && (
                <div className="wjs-search-empty text-center py-16 bg-[var(--wjs-bg-surface,#f9fafb)] rounded-[var(--wjs-card-radius,1rem)]">
                    <div className="text-6xl mb-6 text-[var(--wjs-color-text-muted,#9ca3af)]">
                        <i className="fa-solid fa-magnifying-glass"></i>
                    </div>
                    <h2 className="text-2xl font-semibold mb-3 text-[var(--wjs-color-text-main,#1a1a1a)]">
                        Start Searching
                    </h2>
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)]">
                        Enter a search term above to find content.
                    </p>
                </div>
            )}

            {/* No results */}
            {query && results.length === 0 && (
                <div className="wjs-search-empty text-center py-16 bg-[var(--wjs-bg-surface,#f9fafb)] rounded-[var(--wjs-card-radius,1rem)]">
                    <div className="text-6xl mb-6 text-[var(--wjs-color-text-muted,#9ca3af)]">
                        <i className="fa-solid fa-face-meh"></i>
                    </div>
                    <h2 className="text-2xl font-semibold mb-3 text-[var(--wjs-color-text-main,#1a1a1a)]">
                        No Results Found
                    </h2>
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] mb-6 break-words">
                        We couldn&apos;t find anything matching &quot;{query}&quot;.
                    </p>
                    <p className="text-sm text-[var(--wjs-color-text-muted,#9ca3af)]">
                        Try different keywords or check for typos.
                    </p>
                </div>
            )}

            {/* Results */}
            {results.length > 0 && (
                <div className="wjs-search-results space-y-6">
                    {results.map((post) => (
                        <article
                            key={post.id}
                            className="wjs-search-result group bg-[var(--wjs-bg-surface,#fff)] rounded-[var(--wjs-card-radius,1rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] p-[var(--wjs-card-pad,1.5rem)] hover:shadow-lg hover:border-[var(--wjs-color-primary,#2563eb)] transition-all duration-300"
                        >
                            <div className="wjs-search-result-meta flex items-center gap-3 mb-3">
                                <span className={`wjs-search-result-badge px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${post.type === "page"
                                    ? "bg-purple-100 text-purple-700"
                                    : "bg-blue-100 text-blue-700"
                                    }`}>
                                    {post.type === "page" ? "Page" : "Post"}
                                </span>
                                <span className="text-sm text-[var(--wjs-color-text-muted,#9ca3af)]">
                                    {formatSiteDate(post.date, dateLang, { gmt: post.dateGmt, timeZone: dateZone })}
                                </span>
                            </div>

                            <Link href={`/${post.slug || post.id}`} className="wjs-search-result-link">
                                <h2 className="wjs-search-result-title text-2xl font-bold text-[var(--wjs-color-text-main,#1a1a1a)] mb-3 group-hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                                    {post.title}
                                </h2>
                            </Link>

                            <p className="wjs-search-result-excerpt text-[var(--wjs-color-text-muted,#6b7280)] line-clamp-2 mb-4">
                                {postCardExcerpt(post)}
                            </p>

                            <Link
                                href={`/${post.slug || post.id}`}
                                className="wjs-search-result-more inline-flex items-center text-[var(--wjs-color-primary,#2563eb)] font-semibold hover:gap-2 transition-all"
                            >
                                Read more <i className="fa-solid fa-arrow-right ms-2 text-sm"></i>
                            </Link>
                        </article>
                    ))}
                </div>
            )}

            {found && found.totalPages > 1 && (
                <nav className="wjs-pagination mt-12 flex flex-wrap items-center justify-center gap-2" aria-label="Search results pages">
                    {found.page > 1 && (
                        <Link href={searchHref(query, found.page - 1)} rel="prev" className="wjs-pagination-prev inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                            <i className="fa-solid fa-arrow-left text-sm" aria-hidden="true"></i> Previous
                        </Link>
                    )}
                    <span className="wjs-pagination-current px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] font-semibold" aria-current="page">
                        {found.page} / {found.totalPages}
                    </span>
                    {found.page < found.totalPages && (
                        <Link href={searchHref(query, found.page + 1)} rel="next" className="wjs-pagination-next inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                            Next <i className="fa-solid fa-arrow-right text-sm" aria-hidden="true"></i>
                        </Link>
                    )}
                </nav>
            )}

            {/* Back to home */}
            <div className="mt-12 pt-8 border-t border-[var(--wjs-border-subtle,#e5e7eb)]">
                <Link
                    href="/"
                    className="inline-flex items-center text-[var(--wjs-color-text-muted,#6b7280)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                >
                    <i className="fa-solid fa-arrow-left me-2"></i>
                    Back to Home
                </Link>
            </div>
        </div>
        </ThemeTemplate>
    );
}
