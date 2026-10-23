import Link from "next/link";
import type { Post } from "@/lib/api";
import { postCardExcerpt } from "@/lib/postExcerpt";
import { formatSiteDate, siteDateLanguage, siteTimeZone, siteDateFormats } from "@/lib/public/siteDate";

/** `/` is page 1 of the blog roll; page n lives at `/page/{n}`. */
export const blogRollHref = (page: number) => (page <= 1 ? "/" : `/page/${page}`);

/**
 * The «Latest posts» front page: the blog roll and its pager. Shared by `/` and `/page/{n}`.
 */
export default function BlogRoll({ posts, page, totalPages, settings, hrefFor = blogRollHref }: { posts: Post[]; page: number; totalPages: number; settings: Record<string, any>; hrefFor?: (page: number) => string }) {
    const published = posts.filter((p) => p.status === "publish");
    return (
        <>
            {/* `wjs-*` hooks are the theme contract: STABLE names alongside the Tailwind utilities, so a
                theme can style the blog roll declaratively instead of guessing at `rounded-2xl`. They add
                no styling of their own — the manifest (backend/public/theme-tokens.json) promises them and
                frontend/src/lib/__tests__/chromeSelectorContract.test.ts proves they are still emitted. */}
            <div className="wjs-post-list-header border-b border-[var(--wjs-border-subtle,#e5e7eb)] pb-4 mb-8">
                <h1 className="wjs-post-list-title text-2xl font-bold text-[var(--wjs-color-heading,#1f2937)]">Latest Posts</h1>
            </div>

            {published.length === 0 ? (
                <div className="wjs-post-list-empty text-center py-12 bg-[var(--wjs-bg-muted,#f9fafb)] rounded-lg">
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)]">No posts found. Go to Admin to create one!</p>
                </div>
            ) : (
                <div className="wjs-post-list grid grid-cols-1 gap-12">
                    {published.map((post) => (
                        <article key={post.id} className="wjs-post-card group bg-[var(--wjs-bg-surface,#ffffff)] rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 border border-[var(--wjs-border-subtle,#f3f4f6)] overflow-hidden">
                            <div className="wjs-post-card-body p-8">
                                <div className="wjs-post-card-meta flex flex-wrap items-center gap-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)] mb-4">
                                    <span className="wjs-post-card-badge bg-[var(--wjs-bg-muted,#eff6ff)] text-[var(--wjs-color-primary,#1d4ed8)] px-3 py-1 rounded-full font-medium">Article</span>
                                    <span>•</span>
                                    <span>{formatSiteDate(post.date, siteDateLanguage(settings), { gmt: post.dateGmt, timeZone: siteTimeZone(settings), format: siteDateFormats(settings).format })}</span>
                                    <span>•</span>
                                    <span>{post.author?.displayName || "Admin"}</span>
                                </div>

                                <Link href={`/${post.slug || post.id}`} className="wjs-post-card-link block group-hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                                    <h2 className="wjs-post-card-title text-3xl font-bold text-[var(--wjs-color-heading,#111827)] mb-4 leading-tight">
                                        {post.title}
                                    </h2>
                                </Link>

                                <p className="wjs-post-card-excerpt text-[var(--wjs-color-text-muted,#4b5563)] mb-6 line-clamp-3 leading-relaxed">
                                    {postCardExcerpt(post)}
                                </p>

                                <Link href={`/${post.slug || post.id}`} className="wjs-post-card-more inline-flex items-center text-[var(--wjs-color-primary,#2563eb)] font-semibold hover:gap-2 transition-all">
                                    Read Article <i className="fa-solid fa-arrow-right ms-2 text-sm"></i>
                                </Link>
                            </div>
                        </article>
                    ))}
                </div>
            )}

            {totalPages > 1 && (
                <nav className="wjs-pagination mt-12 flex flex-wrap items-center justify-center gap-2" aria-label="Posts pages">
                    {page > 1 && (
                        <Link href={hrefFor(page - 1)} rel="prev" className="wjs-pagination-prev inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                            <i className="fa-solid fa-arrow-left text-sm" aria-hidden="true"></i> Newer posts
                        </Link>
                    )}
                    <span className="wjs-pagination-current px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] font-semibold" aria-current="page">
                        {page} / {totalPages}
                    </span>
                    {page < totalPages && (
                        <Link href={hrefFor(page + 1)} rel="next" className="wjs-pagination-next inline-flex items-center gap-2 px-4 py-2 rounded-[var(--wjs-radius-md,0.5rem)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-muted,#4b5563)] hover:text-[var(--wjs-color-primary,#2563eb)] transition-colors">
                            Older posts <i className="fa-solid fa-arrow-right text-sm" aria-hidden="true"></i>
                        </Link>
                    )}
                </nav>
            )}
        </>
    );
}
