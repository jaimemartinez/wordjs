import Link from "next/link";
import type { Metadata } from "next";
import { searchPosts } from "@/lib/server-api";

interface SearchParams {
    q?: string | string[];
}

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
    const query = readQuery((await searchParams).q);
    const results = query ? await searchPosts(query) : [];

    return (
        <div className="max-w-4xl mx-auto px-4 py-12">
            {/* Header */}
            <div className="mb-12">
                <h1 className="text-4xl font-bold text-[var(--wjs-color-text-main,#1a1a1a)] mb-4">
                    Search Results
                </h1>
                {query && (
                    <p className="text-lg text-[var(--wjs-color-text-muted,#6b7280)] break-words">
                        {results.length} result{results.length !== 1 ? "s" : ""} for &quot;{query}&quot;
                    </p>
                )}
            </div>

            {/* Search form — a plain GET form, so it works with JavaScript disabled. */}
            <form className="mb-12" action="/search" method="get">
                <div className="flex gap-3">
                    <input
                        type="search"
                        name="q"
                        defaultValue={query}
                        placeholder="Search again..."
                        className="flex-1 min-w-0 px-5 py-4 text-lg border border-[var(--wjs-border-subtle,#e5e7eb)] rounded-xl bg-[var(--wjs-bg-surface,#fff)] focus:outline-none focus:ring-2 focus:ring-[var(--wjs-color-primary,#2563eb)] focus:border-transparent transition-all"
                    />
                    <button
                        type="submit"
                        className="px-8 py-4 bg-[var(--wjs-color-primary,#2563eb)] text-white rounded-xl font-semibold hover:opacity-90 transition-opacity flex items-center gap-2"
                    >
                        <i className="fa-solid fa-search"></i>
                        Search
                    </button>
                </div>
            </form>

            {/* No query */}
            {!query && (
                <div className="text-center py-16 bg-[var(--wjs-bg-surface,#f9fafb)] rounded-2xl">
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
                <div className="text-center py-16 bg-[var(--wjs-bg-surface,#f9fafb)] rounded-2xl">
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
                <div className="space-y-6">
                    {results.map((post) => (
                        <article
                            key={post.id}
                            className="group bg-[var(--wjs-bg-surface,#fff)] rounded-2xl border border-[var(--wjs-border-subtle,#e5e7eb)] p-6 hover:shadow-lg hover:border-[var(--wjs-color-primary,#2563eb)] transition-all duration-300"
                        >
                            <div className="flex items-center gap-3 mb-3">
                                <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${post.type === "page"
                                    ? "bg-purple-100 text-purple-700"
                                    : "bg-blue-100 text-blue-700"
                                    }`}>
                                    {post.type === "page" ? "Page" : "Post"}
                                </span>
                                <span className="text-sm text-[var(--wjs-color-text-muted,#9ca3af)]">
                                    {post.date
                                        ? new Date(post.date).toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" })
                                        : ""}
                                </span>
                            </div>

                            <Link href={`/${post.slug || post.id}`}>
                                <h2 className="text-2xl font-bold text-[var(--wjs-color-text-main,#1a1a1a)] mb-3 group-hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                                    {post.title}
                                </h2>
                            </Link>

                            <p className="text-[var(--wjs-color-text-muted,#6b7280)] line-clamp-2 mb-4">
                                {post.excerpt || post.content?.substring(0, 200).replace(/<[^>]*>?/gm, "") + "..."}
                            </p>

                            <Link
                                href={`/${post.slug || post.id}`}
                                className="inline-flex items-center text-[var(--wjs-color-primary,#2563eb)] font-semibold hover:gap-2 transition-all"
                            >
                                Read more <i className="fa-solid fa-arrow-right ml-2 text-sm"></i>
                            </Link>
                        </article>
                    ))}
                </div>
            )}

            {/* Back to home */}
            <div className="mt-12 pt-8 border-t border-[var(--wjs-border-subtle,#e5e7eb)]">
                <Link
                    href="/"
                    className="inline-flex items-center text-[var(--wjs-color-text-muted,#6b7280)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors"
                >
                    <i className="fa-solid fa-arrow-left mr-2"></i>
                    Back to Home
                </Link>
            </div>
        </div>
    );
}
