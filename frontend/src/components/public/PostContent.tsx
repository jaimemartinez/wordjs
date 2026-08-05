/**
 * Unified renderer for a single post / page / category-post — SERVER COMPONENT (perf F3).
 *
 * The Puck body renders through ContentRenderer (server twin of the editor canvas: same shared
 * block components, same SharedBlockShell wrapper), so the page ships as HTML with no body
 * hydration. The interactive pieces are their own small islands: comments, the locale-aware date,
 * the legacy [photo-carousel] initialiser, and whatever interactive/plugin blocks the content
 * itself contains (each code-split per page). Before F3 this file was a client component that
 * imported <Render> + the ENTIRE editor config — ~378KB of hydrated JS on every public page.
 */
import Link from "next/link";
import ContentRenderer from "@/components/content/ContentRenderer";
import LocalizedDate from "@/components/content/LocalizedDate";
import LegacyCarousels from "@/components/content/LegacyCarousels";
import CommentsSection from "@/components/CommentsSection";
import { sanitizeHTML } from "@/lib/sanitize";
import type { Post } from "@/lib/api";

interface PostContentProps {
    post: Post;
    settings?: Record<string, string> | null;
    /** Decoded category label to show above the title (category-post route). */
    category?: string;
    /** Render the comments section under the post (single-post route). */
    showComments?: boolean;
}

export default function PostContent({ post, settings, category, showComments }: PostContentProps) {
    const puckData = post.meta?._puck_data || null;

    const commentsAllowed =
        showComments &&
        post.type === 'post' &&
        settings?.comments_enabled !== "0" &&
        post.commentStatus === 'open';

    return (
        <div className="w-full">
            {/* Page identity for client-side blocks (the Form block stamps its submissions with it).
                A plain global, set before hydration completes — read lazily inside event handlers. */}
            <script
                dangerouslySetInnerHTML={{ __html: `window.__WJS_PAGE_ID=${JSON.stringify(post.id)};` }}
            />
            {puckData ? (
                <div className="puck-content">
                    <ContentRenderer data={puckData} />
                </div>
            ) : post.type === 'page' ? (
                // Page fallback (no card)
                <div className="w-full px-4 py-8">
                    <h1 className="text-4xl font-bold mb-8 text-center">{post.title}</h1>
                    <div
                        className="wjs-content prose prose-lg max-w-none mx-auto overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto"
                        suppressHydrationWarning
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                    />
                    <LegacyCarousels postId={post.id} />
                </div>
            ) : (
                // Post fallback (card style)
                <article className="max-w-3xl mx-auto py-8">
                    <div className="mb-8 text-center">
                        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)] mb-4">
                            {category && (
                                <>
                                    <span className="font-semibold text-[var(--wjs-color-primary,#2563eb)] uppercase tracking-wide">
                                        {decodeURIComponent(category).replace(/-/g, ' ')}
                                    </span>
                                    <span>•</span>
                                </>
                            )}
                            <span><LocalizedDate date={post.date} /></span>
                            <span>•</span>
                            <span>{post.author?.displayName || "Admin"}</span>
                        </div>
                        {/* Title size intentionally NOT tokenized: every h-scale token (--wjs-h1…) is
                            pre-declared in ui.css :root (2.5rem), so a var() here would override the
                            Tailwind-parity fallback and change today's text-4xl/md:text-5xl render. */}
                        <h1 className="text-4xl md:text-5xl font-bold text-[var(--wjs-color-heading,#111827)] leading-tight mb-6 text-center">
                            {post.title}
                        </h1>
                    </div>
                    {/* Card hooks use UNDECLARED contract tokens (card-*): ui.css :root pre-declares
                        --wjs-radius-lg at 0.75rem, which would beat a 1rem parity fallback. */}
                    <div
                        className="wjs-content prose prose-lg mx-auto p-[var(--wjs-card-pad,2rem)] rounded-[var(--wjs-card-radius,1rem)] shadow-[var(--wjs-card-shadow,0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1))] bg-[var(--wjs-bg-surface,#ffffff)] border border-[var(--wjs-border-subtle,#e5e7eb)] overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto"
                        suppressHydrationWarning
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                    />
                    <LegacyCarousels postId={post.id} />
                </article>
            )}

            {commentsAllowed && <CommentsSection postId={post.id} />}

            <div className="max-w-4xl mx-auto mt-12 pt-8 border-t border-[var(--wjs-border-subtle,#e5e7eb)] flex justify-between items-center px-4">
                <Link href="/" className="text-[var(--wjs-color-text-muted,#6b7280)] hover:text-[var(--wjs-color-primary,#2563eb)] font-medium flex items-center gap-2">
                    <i className="fa-solid fa-arrow-left"></i> Back to Home
                </Link>
            </div>
        </div>
    );
}
