// @ts-nocheck
"use client";

import { useEffect, useState, useRef } from "react";
import "./VideoCarousel.css";

interface Video {
    id: number;
    title: string;
    youtube_url: string;
    thumbnail: string | null;
    button_text: string;
    description?: string;
}

export default function VideoCarousel() {
    const [videos, setVideos] = useState<Video[]>([]);
    const [loading, setLoading] = useState(true);
    const carouselRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        console.log("🎬 VideoCarousel MOUNTED. Videos:", videos.length);
        loadVideos();
    }, []);

    const loadVideos = async () => {
        try {
            const res = await fetch("/api/v1/videos");
            if (res.ok) {
                const data = await res.json();
                setVideos(data);
            }
        } catch (err) {
            console.error("Failed to load videos:", err);
        } finally {
            setLoading(false);
        }
    };

    const scroll = (direction: "left" | "right") => {
        if (!carouselRef.current) return;
        const scrollAmount = 340; // card width + gap
        carouselRef.current.scrollBy({
            left: direction === "left" ? -scrollAmount : scrollAmount,
            behavior: "smooth",
        });
    };

    // Extract YouTube video ID for thumbnail fallback
    const getYoutubeThumbnail = (url: string): string => {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match?.[1]) {
                return `https://img.youtube.com/vi/${match[1]}/maxresdefault.jpg`;
            }
        }
        return "";
    };

    if (loading) {
        return (
            <section className="video-gallery-section">
                <h2 className="video-gallery-title">Videos</h2>
                <div className="video-gallery-empty">Cargando videos...</div>
            </section>
        );
    }

    if (videos.length === 0) {
        return null; // Don't render section if no videos
    }

    return (
        <section className="video-gallery-section">
            <h2 className="video-gallery-title">Videos</h2>

            <div className="video-carousel-wrapper">
                <button
                    className="video-scroll-arrow left"
                    onClick={() => scroll("left")}
                    aria-label="Scroll left"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>

                <div className="video-carousel-container" ref={carouselRef}>
                    {videos.map((video) => (
                        <article key={video.id} className="video-card">
                            {video.thumbnail ? (
                                <img
                                    src={video.thumbnail}
                                    alt={video.title}
                                    className="video-thumbnail"
                                    onError={(e) => {
                                        // Fallback to default YouTube thumbnail
                                        const fallback = getYoutubeThumbnail(video.youtube_url);
                                        if (fallback && e.currentTarget.src !== fallback) {
                                            e.currentTarget.src = fallback;
                                        }
                                    }}
                                />
                            ) : (
                                <div className="video-thumbnail-placeholder" />
                            )}
                            <div className="video-content">
                                <h3 className="video-title">{video.title}</h3>
                                <a
                                    href={video.youtube_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="video-button"
                                >
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z" />
                                    </svg>
                                    {video.button_text || "VER EN YOUTUBE"}
                                </a>
                            </div>
                        </article>
                    ))}
                </div>

                <button
                    className="video-scroll-arrow right"
                    onClick={() => scroll("right")}
                    aria-label="Scroll right"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6" />
                    </svg>
                </button>
            </div>
        </section>
    );
}
