// @ts-nocheck
"use client";

import { useEffect, useState } from "react";

// Embedded CSS to ensure it applies without build configuration issues
const STYLES = `
.promo-cards-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 0;
    overflow: hidden;
}

.promo-card {
    position: relative;
    width: 100%;
    height: 400px;
    display: flex;
    overflow: hidden;
    border-top-left-radius: 30px;
    border-top-right-radius: 30px;
    margin-bottom: -40px;
    box-shadow: none;
    transition: height 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}

.promo-card:hover {
    height: 550px;
}

@media (min-width: 768px) {
    .promo-card:hover {
        height: 700px;
    }
    .promo-card {
        height: 500px;
    }
}

.promo-card.align-left {
    flex-direction: row;
}

.promo-card.align-right {
    flex-direction: row-reverse;
}

.promo-card:last-child {
    border-bottom-left-radius: 30px;
    border-bottom-right-radius: 30px;
    margin-bottom: 0;
}

.promo-card-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 0;
    transition: transform 0.7s ease;
}

.promo-card:hover .promo-card-bg {
    transform: scale(1.05);
}

.promo-card-overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
}

.promo-card.align-right .promo-card-overlay {
    background: linear-gradient(to left, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.2) 40%, transparent 100%);
}

.promo-card.align-left .promo-card-overlay {
    background: linear-gradient(to right, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.2) 40%, transparent 100%);
}

.promo-card-content {
    position: relative;
    z-index: 2;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 2rem;
}

@media (min-width: 768px) {
    .promo-card-content {
        padding: 0 5rem;
    }
}

.promo-title {
    color: white;
    font-size: 2.5rem;
    font-weight: 900;
    text-transform: uppercase;
    line-height: 1;
    margin-bottom: 0.25rem;
    font-family: 'Oswald', sans-serif;
    letter-spacing: -0.025em;
    text-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
}

@media (min-width: 768px) {
    .promo-title {
        font-size: 4rem;
    }
}

.promo-subtitle {
    color: rgba(255, 255, 255, 0.9);
    font-size: 1.25rem;
    font-weight: 300;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    margin-bottom: 0.5rem;
    text-shadow: 0 2px 5px rgba(0, 0, 0, 0.5);
}

@media (min-width: 768px) {
    .promo-subtitle {
        font-size: 1.875rem;
    }
}

.promo-dates {
    color: #00A9CE;
    font-size: 2rem;
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 2rem;
    text-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
}

@media (min-width: 768px) {
    .promo-dates {
        font-size: 2.5rem;
    }
}

.promo-button {
    display: inline-block;
    background-color: white;
    color: #2F6D86;
    font-size: 1.125rem;
    font-weight: 800;
    text-transform: uppercase;
    padding: 0.75rem 2.5rem;
    border-radius: 9999px;
    text-decoration: none;
    transition: all 0.3s ease;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    width: fit-content;
}

.promo-button:hover {
    background-color: #f9fafb;
    transform: translateY(-2px);
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
}

.promo-content-wrapper {
    opacity: 0;
    transform: translateY(20px);
    animation: fadeInUp 0.7s forwards ease-out;
}

@keyframes fadeInUp {
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
`;

interface Card {
    title: string;
    subtitle?: string;
    dates?: string;
    image?: string;
    buttonText?: string;
    buttonLink?: string;
}

interface Gallery {
    id: string;
    name: string;
    cards: Card[];
}

interface CardGalleryPuckProps {
    galleryId?: string;
    elementId?: string;
}

// Custom field for selecting a gallery
const GalleryPicker = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    const [galleries, setGalleries] = useState<Gallery[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/v1/card-galleries")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setGalleries(data);
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Failed to load galleries:", err);
                setLoading(false);
            });
    }, []);

    return (
        <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 bg-white"
            disabled={loading}
        >
            <option value="">-- Select a Gallery --</option>
            {galleries.map((g) => (
                <option key={g.id} value={g.id}>
                    {g.name} ({g.cards?.length || 0} cards)
                </option>
            ))}
        </select>
    );
};

export const puckComponentDef = {
    category: "Card Gallery",
    fields: {
        galleryId: {
            type: "custom" as const,
            label: "Select Gallery",
            render: ({ value, onChange }) => <GalleryPicker value={value} onChange={onChange} />
        },
        elementId: {
            type: "text" as const,
            label: "ID / Ancla (opcional)"
        }
    },
    defaultProps: {
        galleryId: "",
        elementId: ""
    }
};

export default function CardGalleryPuck({ galleryId = "", elementId = "" }: CardGalleryPuckProps) {
    const [gallery, setGallery] = useState<Gallery | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!galleryId) {
            setLoading(false);
            return;
        }

        fetch(`/api/v1/card-galleries/${galleryId}`)
            .then(res => res.json())
            .then(data => {
                setGallery(data);
            })
            .catch(err => console.error("Failed to load gallery:", err))
            .finally(() => setLoading(false));
    }, [galleryId]);

    if (loading) {
        return (
            <div className="w-full p-8 bg-blue-50 border-2 border-dashed border-blue-200 rounded-xl text-center">
                <div className="text-3xl mb-2">📸</div>
                <p className="text-blue-600 font-medium">Loading Card Gallery...</p>
            </div>
        );
    }

    if (!galleryId) {
        return (
            <div className="w-full p-8 bg-yellow-50 border-2 border-dashed border-yellow-300 rounded-xl text-center">
                <div className="text-3xl mb-2">📸</div>
                <h3 className="text-lg font-bold text-yellow-800">Card Gallery</h3>
                <p className="text-sm text-yellow-600">Select a gallery from the properties panel.</p>
            </div>
        );
    }

    if (!gallery || !gallery.cards || gallery.cards.length === 0) {
        return (
            <div className="w-full p-8 bg-blue-50 border-2 border-dashed border-blue-200 rounded-xl text-center">
                <div className="text-3xl mb-2">📸</div>
                <h3 className="text-lg font-bold text-blue-800">Card Gallery: {gallery?.name || "Empty"}</h3>
                <p className="text-sm text-blue-600">No cards in this gallery. Add cards in the admin.</p>
            </div>
        );
    }

    return (
        <section id={elementId || undefined} className="promo-cards-container">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {gallery.cards.map((card, i) => {
                const buttonLeft = i % 2 === 0;
                return (
                    <div
                        key={i}
                        className={`promo-card ${buttonLeft ? "align-right" : "align-left"}`}
                        style={{ zIndex: i + 1 }}
                    >
                        {/* Background Image */}
                        <img
                            src={card.image || "https://via.placeholder.com/1200x400"}
                            alt={card.title}
                            className="promo-card-bg"
                        />

                        {/* Overlay */}
                        <div className="promo-card-overlay"></div>

                        {/* Content */}
                        <div className="promo-card-content">
                            <div className="promo-content-wrapper">
                                <h2 className="promo-title">{card.title}</h2>
                                {card.subtitle && <h3 className="promo-subtitle">{card.subtitle}</h3>}
                                {card.dates && <div className="promo-dates">{card.dates}</div>}
                                {card.buttonText && (
                                    <a href={card.buttonLink || "#"} className="promo-button">
                                        {card.buttonText}
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
