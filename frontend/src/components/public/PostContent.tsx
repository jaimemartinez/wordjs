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
import PageId from "./PageId";
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
    // WHICH TYPES GET THE POST FRAME (title + date + byline), by an explicit allowlist rather than
    // "anything that is not a page".
    //
    // The negative form was accidental in its reach: every CUSTOM post type a plugin registers fell
    // into it and had a title, a date and an author prepended to content whose presentation the
    // plugin owns — silently duplicating a heading its own blocks may already render. We do not own
    // a plugin's content type, so we do not decide it needs our furniture.
    //
    // The rule is not invented here: `commentsAllowed` below already gates on `type === 'post'`.
    // This file was deciding one piece of post furniture by an allowlist and another by a denylist,
    // for the same question. Now they agree, and `singlePost` in the token manifest means what its
    // name says.
    //
    // Consequence worth naming: a CPT whose own content carries no heading renders without a title.
    // That is the plugin's call to make, and it is what the Puck path already did before the frame
    // was lifted out of the classic branch.
    const isFramedPost = post.type === 'post';

    const commentsAllowed =
        showComments &&
        post.type === 'post' &&
        settings?.comments_enabled !== "0" &&
        post.commentStatus === 'open';

    return (
        <div className="w-full">
            {/* Page identity for client-side blocks (the Form block stamps its submissions with it).
                A client effect, NOT an inline <script>: a script executes only while the browser
                parses the server document, so after a soft navigation the global kept the PREVIOUS
                page's id and a form submission was stamped against the wrong page. See PageId.tsx. */}
            <PageId id={post.id} />
            {!isFramedPost ? (
                puckData ? (
                    <div className="wjs-post-body puck-content">
                        <ContentRenderer data={puckData} />
                    </div>
                ) : (
                    // Page fallback (no card). `wjs-post-body` rides here too: the FRAME is post-only,
                    // but the body hook must match wherever a body renders, or `singlePost.body` would
                    // stop applying depending on whether the content happens to be Puck data or HTML —
                    // a selector that matches sometimes is the defect this file exists to catch.
                    <div className="wjs-post-body w-full px-4 py-8">
                        <h1 className="text-4xl font-bold mb-8 text-center">{post.title}</h1>
                        <div
                            className="wjs-content prose prose-lg max-w-none mx-auto overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto"
                            suppressHydrationWarning
                            dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                        />
                        <LegacyCarousels postId={post.id} />
                    </div>
                )
            ) : (
                // THE POST FRAME — emitted on BOTH body paths, deliberately.
                //
                // `wjs-post*` hooks are the theme contract: STABLE names alongside the Tailwind
                // utilities. They carry no styling themselves; the manifest promises them and the
                // contract tests prove this markup emits them.
                //
                // The frame used to live INSIDE the classic branch, so the moment an author opened the
                // post in the visual editor (`_puck_data` appears) the whole frame vanished from the
                // public page and every rule a theme had compiled for `.wjs-post`, `-header`, `-title`
                // and `.wjs-post-meta*` silently stopped matching. A manifest selector that sometimes
                // matches nothing is the same defect as one that never matches, so the frame is now
                // outside the branch and only the BODY differs.
                //
                // It also restores what the editor already promises: postConfig's root render draws the
                // title above the blocks in the canvas, and the public page drew nothing — a Puck-edited
                // post shipped with no <h1>, no date and no byline. Only the body is author-composed.
                <article className={`wjs-post ${puckData ? 'w-full' : 'max-w-3xl mx-auto py-8'}`}>
                    {/* Puck bodies are full-bleed (heroes, full-width sections), so the frame must not
                        constrain them — the header carries its own measure instead of the article's. */}
                    <div className={`wjs-post-header mb-8 text-center${puckData ? ' max-w-3xl mx-auto px-4 pt-8' : ''}`}>
                        <div className="wjs-post-meta flex flex-wrap items-center justify-center gap-3 text-sm text-[var(--wjs-color-text-muted,#6b7280)] mb-4">
                            {category && (
                                <>
                                    <span className="wjs-post-meta-category font-semibold text-[var(--wjs-color-primary,#2563eb)] uppercase tracking-wide">
                                        {decodeURIComponent(category).replace(/-/g, ' ')}
                                    </span>
                                    <span>•</span>
                                </>
                            )}
                            <span className="wjs-post-meta-date"><LocalizedDate date={post.date} /></span>
                            <span>•</span>
                            <span className="wjs-post-meta-author">{post.author?.displayName || "Admin"}</span>
                        </div>
                        {/* Title size intentionally NOT tokenized: every h-scale token (--wjs-h1…) is
                            pre-declared in ui.css :root (2.5rem), so a var() here would override the
                            Tailwind-parity fallback and change today's text-4xl/md:text-5xl render. */}
                        <h1 className="wjs-post-title text-4xl md:text-5xl font-bold text-[var(--wjs-color-heading,#111827)] leading-tight mb-6 text-center">
                            {post.title}
                        </h1>
                    </div>
                    {/* `wjs-post-body` names the body REGION on both paths — the manifest's
                        singlePost.body. It cannot be `.wjs-post .wjs-content`: `.wjs-content` is
                        framework-STYLED in ui.css (heading margins, image radii, table and field
                        rules), so putting it on Puck output would restyle every block. The Puck body
                        keeps `.puck-content`, which is what ui.css already treats as its twin. */}
                    {puckData ? (
                        <div className="wjs-post-body puck-content">
                            <ContentRenderer data={puckData} />
                        </div>
                    ) : (
                        <>
                            {/* Card hooks use UNDECLARED contract tokens (card-*): ui.css :root pre-declares
                                --wjs-radius-lg at 0.75rem, which would beat a 1rem parity fallback. */}
                            <div
                                className="wjs-post-body wjs-content prose prose-lg mx-auto p-[var(--wjs-card-pad,2rem)] rounded-[var(--wjs-card-radius,1rem)] shadow-[var(--wjs-card-shadow,0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1))] bg-[var(--wjs-bg-surface,#ffffff)] border border-[var(--wjs-border-subtle,#e5e7eb)] overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto"
                                suppressHydrationWarning
                                dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                            />
                            {/* Classic-only: it initialises [photo-carousel] shortcodes inside the
                                sanitized HTML body, which Puck content has no equivalent of. */}
                            <LegacyCarousels postId={post.id} />
                        </>
                    )}
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
