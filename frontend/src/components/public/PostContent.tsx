"use client";

/**
 * Unified renderer for a single post / page / category-post.
 *
 * This is a Client Component, but it receives the already-fetched `post` as a prop from a Server
 * Component, so it RENDERS ON THE SERVER during SSR (real HTML body + sanitized content reach the
 * crawler) and then hydrates for the interactive bits (carousels, comments). The old version fetched
 * inside useEffect, which only runs in the browser — hence the empty-skeleton SSR this replaces.
 */
import { useEffect } from "react";
import Link from "next/link";
import { Render, Config } from "@measured/puck";
import "@measured/puck/puck.css";
import { postConfig, pageConfig } from "@/components/puckConfig";
import CommentsSection from "@/components/CommentsSection";
import { sanitizeHTML } from "@/lib/sanitize";
import type { Post } from "@/lib/api";

// Wire up any [photo-carousel] widgets rendered inside the post HTML. Returns a disposer that clears
// autoplay timers so we don't leak intervals across client navigations.
function initCarousels(): () => void {
    const intervals: ReturnType<typeof setInterval>[] = [];
    document.querySelectorAll('.photo-carousel:not([data-initialized])').forEach((el) => {
        el.setAttribute('data-initialized', 'true');
        const slides = el.querySelectorAll('.slide');
        const dots = el.querySelectorAll('.dot');
        const counter = el.querySelector('.current');
        const slidesContainer = el.querySelector('.slides') as HTMLElement | null;
        const total = slides.length;
        let current = 0;

        const go = (index: number) => {
            current = ((index % total) + total) % total;
            if (slidesContainer) slidesContainer.style.transform = `translateX(-${current * 100}%)`;
            dots.forEach((d, i) => d.classList.toggle('active', i === current));
            if (counter) counter.textContent = String(current + 1);
        };

        el.querySelectorAll('.nav-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const dir = parseInt((btn as HTMLElement).dataset.dir || '1');
                go(current + dir);
            });
        });
        dots.forEach((dot) => {
            dot.addEventListener('click', () => {
                const idx = parseInt((dot as HTMLElement).dataset.index || '0');
                go(idx);
            });
        });

        const autoplay = el.getAttribute('data-autoplay') === 'true';
        const interval = parseInt(el.getAttribute('data-interval') || '5000');
        if (autoplay) intervals.push(setInterval(() => go(current + 1), interval));
    });
    return () => intervals.forEach(clearInterval);
}

interface PostContentProps {
    post: Post;
    settings?: Record<string, string> | null;
    /** Decoded category label to show above the title (category-post route). */
    category?: string;
    /** Render the comments section under the post (single-post route). */
    showComments?: boolean;
}

export default function PostContent({ post, settings, category, showComments }: PostContentProps) {
    // Carousels live inside dangerouslySetInnerHTML content; initialise them after mount/hydration.
    useEffect(() => {
        let dispose: (() => void) | undefined;
        const timeoutId = setTimeout(() => { dispose = initCarousels(); }, 100);
        return () => { clearTimeout(timeoutId); dispose?.(); };
    }, [post.id]);

    const config: Config = post.type === 'page' ? pageConfig : postConfig;

    // Feed the post's stored meta (title/author/date) into Puck's root props.
    const dataWithMeta = post.meta?._puck_data ? {
        ...post.meta._puck_data,
        root: {
            ...post.meta._puck_data.root,
            title: post.meta._puck_data.root?.title || post.title,
            author: post.author?.displayName || "Admin",
            date: post.date ? new Date(post.date).toLocaleDateString() : "",
        },
    } : null;

    const commentsAllowed =
        showComments &&
        post.type === 'post' &&
        settings?.comments_enabled !== "0" &&
        post.commentStatus === 'open';

    return (
        <div className="w-full">
            {dataWithMeta ? (
                <div className="puck-content">
                    <Render config={config} data={dataWithMeta} />
                </div>
            ) : post.type === 'page' ? (
                // Page fallback (no card)
                <div className="w-full px-4 py-8">
                    <h1 className="text-4xl font-bold mb-8 text-center">{post.title}</h1>
                    <div
                        className="prose prose-lg max-w-none mx-auto"
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                    />
                </div>
            ) : (
                // Post fallback (card style)
                <article className="max-w-3xl mx-auto py-8">
                    <div className="mb-8 text-center">
                        <div className="flex items-center justify-center gap-3 text-sm text-gray-500 mb-4">
                            {category && (
                                <>
                                    <span className="font-semibold text-blue-600 uppercase tracking-wide">
                                        {decodeURIComponent(category).replace(/-/g, ' ')}
                                    </span>
                                    <span>•</span>
                                </>
                            )}
                            <span>{post.date ? new Date(post.date).toLocaleDateString() : ''}</span>
                            <span>•</span>
                            <span>{post.author?.displayName || "Admin"}</span>
                        </div>
                        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 leading-tight mb-6 text-center">
                            {post.title}
                        </h1>
                    </div>
                    <div
                        className="prose prose-lg prose-blue mx-auto bg-white p-8 rounded-2xl shadow-sm border border-gray-100"
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                    />
                </article>
            )}

            {commentsAllowed && <CommentsSection postId={post.id} />}

            <div className="max-w-4xl mx-auto mt-12 pt-8 border-t border-gray-100 flex justify-between items-center px-4">
                <Link href="/" className="text-gray-500 hover:text-blue-600 font-medium flex items-center gap-2">
                    <i className="fa-solid fa-arrow-left"></i> Back to Home
                </Link>
            </div>
        </div>
    );
}
