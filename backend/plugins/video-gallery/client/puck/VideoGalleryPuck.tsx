// @ts-nocheck
"use client";

import { useEffect, useState, useRef } from "react";

// Embedded CSS to ensure it applies without build configuration issues
const STYLES = `
.video-gallery-section {
    background: #f8f9fa;
    padding: 3rem 1rem;
    width: 100%;
    overflow: hidden;
}

.video-gallery-title {
    font-family: 'Oswald', sans-serif;
    font-size: 2.5rem;
    font-weight: 700;
    color: #1a1a2e;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 2rem;
    text-align: center;
}

.video-carousel-container {
    display: flex;
    gap: 1.5rem;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    -ms-overflow-style: none;
    padding: 0.5rem;
    padding-bottom: 1rem;
}

.video-carousel-container::-webkit-scrollbar {
    display: none;
}

.video-card {
    flex: 0 0 320px;
    background: #1584A3;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    scroll-snap-align: start;
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    display: flex;
    flex-direction: column;
}

.video-card:hover {
    transform: translateY(-5px);
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
}

.video-thumbnail {
    width: 100%;
    height: 180px;
    object-fit: cover;
    display: block;
}

.video-thumbnail-placeholder {
    width: 100%;
    height: 180px;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    display: flex;
    align-items: center;
    justify-content: center;
}

.video-thumbnail-placeholder::after {
    content: "▶";
    font-size: 3rem;
    color: rgba(255, 255, 255, 0.7);
}

.video-content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    flex-grow: 1;
    justify-content: space-between;
}

.video-title {
    font-family: 'Oswald', 'Arial', sans-serif;
    font-size: 1.1rem;
    font-weight: 700;
    color: white;
    line-height: 1.3;
    margin: 0;
}

.video-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: white;
    color: #1584A3;
    border: none;
    border-radius: 20px;
    font-family: 'Oswald', sans-serif;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-decoration: none;
    transition: all 0.2s ease;
    width: fit-content;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.video-button:hover {
    background: #f0f0f0;
    color: #0e5a70;
    transform: translateY(-1px);
}

.video-button svg {
    width: 16px;
    height: 16px;
}

.video-carousel-wrapper {
    position: relative;
    max-width: 1200px;
    margin: 0 auto;
}

.video-scroll-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 48px;
    height: 48px;
    background: rgba(255, 255, 255, 0.9);
    border: none;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transition: all 0.2s ease;
    z-index: 10;
}

.video-scroll-arrow:hover {
    background: white;
    transform: translateY(-50%) scale(1.1);
}

.video-scroll-arrow.left {
    left: -20px;
}

.video-scroll-arrow.right {
    right: -20px;
}

.video-scroll-arrow svg {
    width: 20px;
    height: 20px;
    color: #0077B6;
}

@media (max-width: 768px) {
    .video-gallery-section {
        padding: 2rem 0;
    }

    .video-gallery-title {
        font-size: 1.75rem;
        padding: 0 1rem;
    }

    .video-carousel-container {
        padding: 0.5rem 1rem 1.5rem 1rem;
        gap: 1rem;
    }

    .video-card {
        flex: 0 0 85vw;
        max-width: 320px;
    }

    .video-scroll-arrow {
        display: flex;
        width: 32px;
        height: 32px;
        background: rgba(255, 255, 255, 0.95);
    }

    .video-scroll-arrow svg {
        width: 16px;
        height: 16px;
    }

    .video-scroll-arrow.left {
        left: 0;
    }

    .video-scroll-arrow.right {
        right: 0;
    }
}

@media (max-width: 480px) {
    .video-card {
        flex: 0 0 80vw;
    }
}

.video-gallery-empty {
    text-align: center;
    color: rgba(255, 255, 255, 0.8);
    padding: 3rem 1rem;
    font-size: 1.125rem;
}
`;

interface Video {
    id: number;
    title: string;
    youtube_url: string;
    thumbnail: string | null;
    button_text: string;
    description?: string;
}

interface VideoGalleryPuckProps {
    galleryId?: string;
    title?: string;
    limit?: number;
    showDescription?: boolean;
    elementId?: string;
}

export const puckComponentDef = {
    category: "Video Gallery",
    fields: {
        galleryId: {
            type: "text" as const,
            label: "Gallery ID (default: 'default')"
        },
        title: {
            type: "text" as const,
            label: "Section Title"
        },
        limit: {
            type: "number" as const,
            label: "Limit (0 = all)"
        },
        showDescription: {
            type: "radio" as const,
            label: "Show Description",
            options: [
                { label: "Yes", value: true },
                { label: "No", value: false }
            ]
        },
        elementId: {
            type: "text" as const,
            label: "ID / Ancla (opcional)"
        }
    },
    defaultProps: {
        galleryId: "default",
        title: "Videos",
        limit: 10,
        showDescription: false,
        elementId: ""
    }
};

export default function VideoGalleryPuck({ galleryId = "default", title = "Videos", limit = 10, showDescription = false, elementId = "" }: VideoGalleryPuckProps) {
    const [videos, setVideos] = useState<Video[]>([]);
    const [loading, setLoading] = useState(true);
    const carouselRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        loadVideos();
    }, [limit, galleryId]);

    const loadVideos = async () => {
        setLoading(true);
        try {
            // Support legacy ID or 'default'
            const targetId = galleryId || 'default';

            // Use relative URL - works with any protocol/port via gateway
            const res = await fetch(`/api/v1/videos/galleries/${targetId}`);

            if (res.ok) {
                const gallery = await res.json();
                let vids = gallery.videos || [];
                if (limit > 0) {
                    vids = vids.slice(0, limit);
                }
                setVideos(vids);
            } else {
                // Fallback attempt to legacy endpoint if gallery not found via ID?
                // Probably better to just show empty or error
                console.warn(`Gallery ${targetId} not found`);
                setVideos([]);
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
            <div className="p-8 text-center bg-gray-50 border border-gray-200 rounded">
                Cargando videos...
            </div>
        );
    }

    if (videos.length === 0) {
        return (
            <div className="p-8 text-center bg-gray-50 border border-dashed border-gray-300 rounded">
                <p className="mb-2 font-bold text-gray-500">Galeria: {galleryId}</p>
                <p>No se encontraron videos o la galería no existe.</p>
            </div>
        );
    }

    return (
        <section id={elementId || undefined} className="video-gallery-section">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {title && <h2 className="video-gallery-title">{title}</h2>}

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
                                {showDescription && video.description && (
                                    <p className="text-sm text-gray-200 line-clamp-2">{video.description}</p>
                                )}
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
