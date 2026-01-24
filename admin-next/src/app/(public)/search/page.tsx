"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";

function SearchResults() {
    const searchParams = useSearchParams();
    const query = searchParams.get("q") || "";

    const [results, setResults] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchedQuery, setSearchedQuery] = useState("");

    useEffect(() => {
        if (query) {
            performSearch(query);
        } else {
            setLoading(false);
        }
    }, [query]);

    const performSearch = async (searchQuery: string) => {
        setLoading(true);
        setSearchedQuery(searchQuery);

        try {
            // Search in posts
            const postsResponse = await fetch(`/api/v1/posts?search=${encodeURIComponent(searchQuery)}&status=publish`);
            const posts = postsResponse.ok ? await postsResponse.json() : [];

            // Search in pages
            const pagesResponse = await fetch(`/api/v1/posts?type=page&search=${encodeURIComponent(searchQuery)}&status=publish`);
            const pages = pagesResponse.ok ? await pagesResponse.json() : [];

            // Combine results
            const allResults = [...(posts.posts || posts || []), ...(pages.posts || pages || [])];
            setResults(allResults);
        } catch (error) {
            console.error("Search failed:", error);
            setResults([]);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center py-20">
                <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto px-4 py-12">
            {/* Search Header */}
            <div className="mb-12">
                <h1 className="text-4xl font-bold text-[var(--wjs-color-text-main,#1a1a1a)] mb-4">
                    Search Results
                </h1>
                {searchedQuery && (
                    <p className="text-lg text-[var(--wjs-color-text-muted,#6b7280)]">
                        {results.length} result{results.length !== 1 ? 's' : ''} for "{searchedQuery}"
                    </p>
                )}
            </div>

            {/* New Search Form */}
            <form
                className="mb-12"
                onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const newQuery = formData.get("q") as string;
                    if (newQuery.trim()) {
                        window.location.href = `/search?q=${encodeURIComponent(newQuery.trim())}`;
                    }
                }}
            >
                <div className="flex gap-3">
                    <input
                        type="search"
                        name="q"
                        defaultValue={searchedQuery}
                        placeholder="Search again..."
                        className="flex-1 px-5 py-4 text-lg border border-[var(--wjs-border-subtle,#e5e7eb)] rounded-xl bg-[var(--wjs-bg-surface,#fff)] focus:outline-none focus:ring-2 focus:ring-[var(--wjs-color-primary,#2563eb)] focus:border-transparent transition-all"
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

            {/* No Query */}
            {!searchedQuery && (
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

            {/* No Results */}
            {searchedQuery && results.length === 0 && (
                <div className="text-center py-16 bg-[var(--wjs-bg-surface,#f9fafb)] rounded-2xl">
                    <div className="text-6xl mb-6 text-[var(--wjs-color-text-muted,#9ca3af)]">
                        <i className="fa-solid fa-face-meh"></i>
                    </div>
                    <h2 className="text-2xl font-semibold mb-3 text-[var(--wjs-color-text-main,#1a1a1a)]">
                        No Results Found
                    </h2>
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] mb-6">
                        We couldn't find anything matching "{searchedQuery}".
                    </p>
                    <p className="text-sm text-[var(--wjs-color-text-muted,#9ca3af)]">
                        Try different keywords or check for typos.
                    </p>
                </div>
            )}

            {/* Results List */}
            {results.length > 0 && (
                <div className="space-y-6">
                    {results.map((post) => (
                        <article
                            key={post.id}
                            className="group bg-[var(--wjs-bg-surface,#fff)] rounded-2xl border border-[var(--wjs-border-subtle,#e5e7eb)] p-6 hover:shadow-lg hover:border-[var(--wjs-color-primary,#2563eb)] transition-all duration-300"
                        >
                            <div className="flex items-center gap-3 mb-3">
                                <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${post.type === 'page'
                                    ? 'bg-purple-100 text-purple-700'
                                    : 'bg-blue-100 text-blue-700'
                                    }`}>
                                    {post.type === 'page' ? 'Page' : 'Post'}
                                </span>
                                <span className="text-sm text-[var(--wjs-color-text-muted,#9ca3af)]">
                                    {new Date(post.date).toLocaleDateString('es-ES', {
                                        year: 'numeric',
                                        month: 'long',
                                        day: 'numeric'
                                    })}
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

            {/* Back to Home */}
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

export default function SearchPage() {
    return (
        <Suspense fallback={
            <div className="flex justify-center items-center py-20">
                <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
            </div>
        }>
            <SearchResults />
        </Suspense>
    );
}
