"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { postsApi, Post } from "@/lib/api";
import Link from "next/link";
import { Render, Config } from "@measured/puck";
import "@measured/puck/puck.css";
import { puckConfig } from "@/components/puckConfig";
import Header from "@/components/public/Header";
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

        el.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseInt((btn as HTMLElement).dataset.dir || '1');
                go(current + dir);
            });
        });

        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const idx = parseInt((dot as HTMLElement).dataset.index || '0');
                go(idx);
            });
        });

        const autoplay = el.getAttribute('data-autoplay') === 'true';
        const interval = parseInt(el.getAttribute('data-interval') || '5000');
        if (autoplay) setInterval(() => go(current + 1), interval);
    });
}

export default function SinglePage() {
    const params = useParams();
    const [page, setPage] = useState<Post | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        if (params.slug) {
            loadPage(params.slug as string);
        }
    }, [params.slug]);

    // Initialize carousels after page loads
    useEffect(() => {
        if (page) {
            setTimeout(initCarousels, 100);
        }
    }, [page]);

    const loadPage = async (slug: string) => {
        try {
            // Fetch pages
            const pages = await postsApi.list("page", "any"); // Fetch all status to be safe, or 'publish'
            const found = pages.find(p => p.slug === slug || String(p.id) === slug);

            if (found) {
                setPage(found);
            } else {
                setError("Page not found");
            }
        } catch (err) {
            console.error(err);
            setError("Failed to load page");
        } finally {
            setLoading(false);
        }
    };

    if (loading) return (
        <div className="max-w-3xl mx-auto py-24 animate-pulse space-y-8 px-4">
            <div className="h-8 bg-gray-200 rounded w-3/4"></div>
            <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
    );

    if (error || !page) return (
        <div className="text-center py-40 px-4">
            <h1 className="text-4xl font-bold text-gray-800 mb-4">404</h1>
            <p className="text-gray-600 mb-8">{error || "Page not found"}</p>
            <Link href="/" className="text-blue-600 hover:underline">Back to Home</Link>
        </div>
    );

    const config: Config = puckConfig;

    // Prepare data with meta info for Puck
    const dataWithMeta = page.meta?._puck_data ? {
        ...page.meta._puck_data,
        root: {
            ...page.meta._puck_data.root,
            title: page.meta._puck_data.root?.title || page.title,
            // Categories/Pages might not need author/date, so we keep them empty unless explicitly set
            author: page.meta._puck_data.root?.author || "",
            date: page.meta._puck_data.root?.date || ""
        }
    } : null;

    return (
        <div className="w-full">
            {dataWithMeta ? (
                <div className="puck-content">
                    <Render config={config} data={dataWithMeta} />
                </div>
            ) : (
                <article className="max-w-4xl mx-auto py-12 px-4">
                    <div className="mb-12 text-center">
                        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 leading-tight mb-6">
                            {page.title}
                        </h1>
                    </div>

                    <div
                        className="prose prose-lg prose-blue mx-auto bg-white p-8 md:p-12 rounded-2xl shadow-sm border border-gray-100"
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(page.content) }}
                    />
                </article>
            )}
        </div>
    );
}
