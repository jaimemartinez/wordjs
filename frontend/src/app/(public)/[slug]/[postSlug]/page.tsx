"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { postsApi, Post } from "@/lib/api";
import Link from "next/link";
import { Render, Config } from "@measured/puck";
import "@measured/puck/puck.css";
import { puckConfig, postConfig, pageConfig } from "@/components/puckConfig";
import NotFoundState from "@/components/NotFoundState";
import { sanitizeHTML } from "@/lib/sanitize";

// Initialize any carousels in the content
function initCarousels() {
    document.querySelectorAll('.photo-carousel:not([data-initialized])').forEach((el) => {
        el.setAttribute('data-initialized', 'true');
        const slides = el.querySelectorAll('.slide');
        const dots = el.querySelectorAll('.dot');
        const counter = el.querySelector('.current');
        const slidesContainer = el.querySelector('.slides') as HTMLElement;
        const total = slides.length;
        let current = 0;

        const go = (index: number) => {
            current = ((index % total) + total) % total;
            if (slidesContainer) slidesContainer.style.transform = `translateX(-${current * 100}%)`;
            dots.forEach((d, i) => d.classList.toggle('active', i === current));
            if (counter) counter.textContent = String(current + 1);
        };

        // Navigation buttons
        el.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseInt((btn as HTMLElement).dataset.dir || '1');
                go(current + dir);
            });
        });

        // Dot buttons
        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const idx = parseInt((dot as HTMLElement).dataset.index || '0');
                go(idx);
            });
        });

        // Autoplay
        const autoplay = el.getAttribute('data-autoplay') === 'true';
        const interval = parseInt(el.getAttribute('data-interval') || '5000');
        if (autoplay) setInterval(() => go(current + 1), interval);
    });
}

export default function CategoryPostPage() {
    const params = useParams();
    const [post, setPost] = useState<Post | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    // In this nested route:
    // [slug] matches the first segment (Category)
    // [postSlug] matches the second segment (Post ID/Slug)
    const category = params.slug as string;
    const postSlug = params.postSlug as string;

    useEffect(() => {
        if (postSlug) {
            loadPost(postSlug);
        }
    }, [postSlug]);

    // Initialize carousels after post loads
    useEffect(() => {
        if (post) {
            setTimeout(initCarousels, 100);
        }
    }, [post]);

    const loadPost = async (slugToFetch: string) => {
        try {
            // Use the optimized backend endpoint
            const data = await postsApi.getBySlug(slugToFetch);
            if (data) {
                setPost(data);
            } else {
                setError("Post not found");
            }
        } catch (err) {
            console.error(err);
            setError("Failed to load post");
        } finally {
            setLoading(false);
        }
    };

    if (loading) return (
        <div className="max-w-3xl mx-auto py-12 animate-pulse space-y-8">
            <div className="h-8 bg-gray-200 rounded w-3/4"></div>
            <div className="h-64 bg-gray-200 rounded-lg"></div>
            <div className="space-y-4">
                {[1, 2, 3].map(i => <div key={i} className="h-4 bg-gray-200 rounded w-full"></div>)}
            </div>
        </div>
    );

    if (error || !post) return (
        <NotFoundState
            title="Post no encontrado"
            message={error || "El contenido que buscas no existe."}
        />
    );

    const config: Config = post.type === 'page' ? pageConfig : postConfig;

    // Prepare data with meta info for Puck
    const dataWithMeta = post.meta?._puck_data ? {
        ...post.meta._puck_data,
        root: {
            ...post.meta._puck_data.root,
            title: post.meta._puck_data.root?.title || post.title,
            author: post.author?.displayName || "Admin",
            date: new Date(post.date).toLocaleDateString()
        }
    } : null;

    return (
        <div className="w-full">
            {dataWithMeta ? (
                <div className="puck-content">
                    <Render config={config} data={dataWithMeta} />
                </div>
            ) : (
                post.type === 'page' ? (
                    // Page Fallback (No Card)
                    <div className="w-full px-4 py-8">
                        <h1 className="text-4xl font-bold mb-8 text-center">{post.title}</h1>
                        <div
                            className="prose prose-lg max-w-none mx-auto"
                            dangerouslySetInnerHTML={{ __html: sanitizeHTML(post.content) }}
                        />
                    </div>
                ) : (
                    // Post Fallback (Card Style)
                    <article className="max-w-3xl mx-auto py-8">
                        <div className="mb-8 text-center">
                            <div className="flex items-center justify-center gap-3 text-sm text-gray-500 mb-4">
                                <span className="font-semibold text-blue-600 uppercase tracking-wide">
                                    {category ? decodeURIComponent(category).replace(/-/g, ' ') : 'Blog'}
                                </span>
                                <span>•</span>
                                <span>{new Date(post.date).toLocaleDateString()}</span>
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
                )
            )}

            <div className="max-w-4xl mx-auto mt-12 pt-8 border-t border-gray-100 flex justify-between items-center px-4">
                <Link href="/" className="text-gray-500 hover:text-blue-600 font-medium flex items-center gap-2">
                    <i className="fa-solid fa-arrow-left"></i> Back to Home
                </Link>
            </div>
        </div>
    );
}
