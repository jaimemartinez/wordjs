// @ts-nocheck
"use client";

import { useEffect, useState } from "react";
import "./PromoCards.css";

// Local type definitions - plugin is self-contained
interface Card {
    id: string;
    title: string;
    subtitle?: string;
    location?: string;
    dates?: string;
    image?: string;
    buttonText?: string;
    buttonLink?: string;
    order?: number;
}

// Direct API fetch - no external dependencies
const fetchCards = async (): Promise<Card[]> => {
    const res = await fetch('/api/v1/cards');
    if (!res.ok) throw new Error('Failed to fetch cards');
    return res.json();
};

export default function PromoCards() {
    const [cards, setCards] = useState<Card[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchCards()
            .then(data => {
                // Sort by order
                setCards(data.sort((a, b) => (a.order || 0) - (b.order || 0)));
            })
            .catch(err => {
                console.error("Failed to load promo cards:", err);
            })
            .finally(() => {
                setLoading(false);
            });
    }, []);

    if (loading) return null;
    if (cards.length === 0) return null;

    return (
        <section className="py-4 bg-transparent">
            <div className="promo-cards-container">
                {cards.map((card, i) => {
                    // Logic based on mockup:
                    // i=0 (Card 1): Button LEFT, Text RIGHT
                    // i=1 (Card 2): TEXT LEFT, Button RIGHT
                    // i=2 (Card 3): Button LEFT, Text RIGHT
                    const buttonLeft = i % 2 === 0;

                    return (
                        <div
                            key={card.id}
                            className={`promo-card ${buttonLeft ? "align-right" : "align-left"}`}
                            style={{ zIndex: i + 1 }}
                        >
                            {/* Background Image */}
                            <img
                                src={card.image}
                                alt={card.title}
                                className="promo-card-bg"
                            />

                            {/* Overlay Gradient */}
                            <div className="promo-card-overlay"></div>

                            {/* Content Container */}
                            <div className="promo-card-content">
                                <div className="promo-content-wrapper w-full flex flex-col md:flex-row items-center justify-between gap-8 md:gap-16">

                                    {/* Order-1 on MD for Button if buttonLeft is true */}
                                    {card.buttonText && (
                                        <a
                                            href={card.buttonLink || "#"}
                                            className={`promo-button ${buttonLeft ? "md:order-1" : "md:order-2"}`}
                                        >
                                            {card.buttonText}
                                        </a>
                                    )}

                                    {/* Text Content */}
                                    <div className={`flex-1 ${buttonLeft ? "md:order-2 text-right" : "md:order-1 text-left"}`}>
                                        <h2 className="promo-title">{card.title}</h2>
                                        {card.subtitle && <h3 className="promo-subtitle">{card.subtitle}</h3>}
                                        {card.dates && <div className="promo-dates">{card.dates}</div>}
                                    </div>

                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
