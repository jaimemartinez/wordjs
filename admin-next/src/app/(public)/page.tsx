"use client";

import { useEffect, useState, Fragment } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import PluginLoader from "@/components/PluginLoader";
import { useActivePlugins } from "@/lib/useActivePlugins";
import { Render, Config } from "@measured/puck";
import "@measured/puck/puck.css";
import { pageConfig } from "@/components/puckConfig";
import { sanitizeHTML } from "@/lib/sanitize";

export default function HomePage() {
    const [posts, setPosts] = useState<Post[]>([]);
    const [homePageContent, setHomePageContent] = useState<Post | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        // Force timeout after 5 seconds to prevent infinite loading
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Request successful")), 5000)
        );

        try {
            const loadPromise = async () => {
                const { postsApi, settingsApi } = await import("@/lib/api");

                // 1. Load Settings (Critical: Fail validation if this fails)
                const settings = await settingsApi.get();
                const homepageId = settings.homepage_id;

                // 2. Load Content
                if (homepageId) {
                    // Static Home Page
                    const page = await postsApi.get(parseInt(homepageId));
                    setHomePageContent(page);
                } else {
                    // Blog Roll
                    const postsData = await postsApi.list("post");
                    setPosts(postsData.filter((p) => p.status === "publish"));
                }
            };

            await Promise.race([loadPromise(), timeoutPromise]);

        } catch (error) {
            console.error("Failed to load data:", error);
            setError(true);
        } finally {
            setLoading(false);
        }
    };

    // Helper to render content with shortcodes - handles multiple shortcode types
    const renderContent = (htmlContent: string) => {
        if (!htmlContent) return null;

        // Define shortcodes to process
        const shortcodes = [
            { tag: '[cards]', slug: 'card-gallery' },
            { tag: '[vgallery]', slug: 'video-gallery' },
        ];

        // Process content by replacing shortcodes with markers, then splitting
        let processedContent = htmlContent;
        const markerPrefix = '___PLUGIN_MARKER___';

        shortcodes.forEach((sc, idx) => {
            processedContent = processedContent.split(sc.tag).join(`${markerPrefix}${idx}${markerPrefix}`);
        });

        // If no shortcodes found, return simple HTML
        if (!processedContent.includes(markerPrefix)) {
            return <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(htmlContent) }} />;
        }

        // Split by markers and render
        const regex = new RegExp(`${markerPrefix}(\\d+)${markerPrefix}`, 'g');
        const parts: (string | { type: 'plugin', slug: string })[] = [];
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(processedContent)) !== null) {
            // Add text before the marker
            if (match.index > lastIndex) {
                parts.push(processedContent.slice(lastIndex, match.index));
            }
            // Add plugin marker
            const pluginIndex = parseInt(match[1]);
            parts.push({ type: 'plugin', slug: shortcodes[pluginIndex].slug });
            lastIndex = match.index + match[0].length;
        }
        // Add remaining text
        if (lastIndex < processedContent.length) {
            parts.push(processedContent.slice(lastIndex));
        }

        return (
            <div>
                {parts.map((part, index) => (
                    <Fragment key={index}>
                        {typeof part === 'string' ? (
                            <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(part) }} />
                        ) : (
                            <PluginLoader slug={part.slug} />
                        )}
                    </Fragment>
                ))}
            </div>
        );
    };

    if (error && !homePageContent && !posts.length) {
        if (typeof document === 'undefined') return null;

        const { createPortal } = require('react-dom');
        return createPortal(
            <div className="fixed inset-0 bg-white z-[9999] flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-300">
                <style jsx global>{`
                    body { overflow: hidden !important; }
                `}</style>
                <div className="text-red-500 text-6xl mb-6">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                </div>
                <h1 className="text-3xl font-bold text-gray-800 mb-3">Service Temporarily Unavailable</h1>
                <p className="text-gray-600 max-w-md text-lg">
                    We are currently experiencing technical difficulties connecting to the server. Please check back soon.
                </p>
                <button
                    onClick={() => window.location.reload()}
                    className="mt-8 px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-lg hover:shadow-xl hover:-translate-y-0.5 transform active:scale-95"
                >
                    Retry Connection
                </button>
            </div>,
            document.body
        );
    }

    return (
        <div className="space-y-4">
            {/* HERO SECTION REMOVED - User manages via Editor */}

            {/* MAIN CONTENT */}
            {loading ? null : homePageContent ? (
                // STATIC PAGE CONTENT
                homePageContent.meta?._puck_data ? (
                    <div className="puck-content w-full">
                        <Render config={pageConfig} data={homePageContent.meta._puck_data} />
                    </div>
                ) : (
                    <div className="prose prose-lg max-w-none px-4">
                        <h1 className="text-4xl font-bold mb-4 text-center">{homePageContent.title}</h1>
                        {renderContent(homePageContent.content)}
                    </div>
                )
            ) : (
                // BLOG ROLL
                <>
                    <div className="border-b border-gray-200 pb-4 mb-8">
                        <h2 className="text-2xl font-bold text-gray-800">Latest Posts</h2>
                    </div>

                    {posts.length === 0 ? (
                        <div className="text-center py-12 bg-gray-50 rounded-lg">
                            <p className="text-gray-500">No posts found. Go to Admin to create one!</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-12">
                            {posts.map((post) => (
                                <article key={post.id} className="group bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-300 border border-gray-100 overflow-hidden">
                                    <div className="p-8">
                                        <div className="flex items-center gap-3 text-sm text-gray-500 mb-4">
                                            <span className="bg-blue-50 text-blue-700 px-3 py-1 rounded-full font-medium">Article</span>
                                            <span>•</span>
                                            <span>{new Date(post.date).toLocaleDateString()}</span>
                                            <span>•</span>
                                            <span>{post.author?.displayName || "Admin"}</span>
                                        </div>

                                        <Link href={`/${post.slug || post.id}`} className="block group-hover:text-blue-600 transition-colors">
                                            <h3 className="text-3xl font-bold text-gray-900 mb-4 leading-tight">
                                                {post.title}
                                            </h3>
                                        </Link>

                                        <p className="text-gray-600 mb-6 line-clamp-3 leading-relaxed">
                                            {post.excerpt || post.content.substring(0, 200).replace(/<[^>]*>?/gm, "") + "..."}
                                        </p>

                                        <Link href={`/${post.slug || post.id}`} className="inline-flex items-center text-blue-600 font-semibold hover:gap-2 transition-all">
                                            Read Article <i className="fa-solid fa-arrow-right ml-2 text-sm"></i>
                                        </Link>
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
