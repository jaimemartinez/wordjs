// @ts-nocheck
"use client";

import { useEffect, useState, useMemo } from "react";
import { apiGet } from "@/lib/api";
import HeroCarousel from "../components/HeroCarousel";

interface PhotoCarouselPuckProps {
    carouselId?: string;
    autoSlide?: boolean;
    interval?: number;
    elementId?: string;
}

// Custom field for selecting a carousel
const CarouselPicker = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    const [items, setItems] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        apiGet<any[]>("/carousels")
            .then(data => {
                console.log("CarouselPicker loaded items:", data);
                if (Array.isArray(data)) {
                    setItems(data);
                } else {
                    console.error("CarouselPicker received non-array data:", data);
                    setItems([]);
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Failed to load carousels in Picker:", err);
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
            <option value="">-- Select a Carousel --</option>
            {items.map((c) => (
                <option key={c.id} value={c.id}>
                    {c.name || `Carousel #${c.id}`}
                </option>
            ))}
        </select>
    );
};

export const puckComponentDef = {
    category: "Photo Carousel",
    fields: {
        carouselId: {
            type: "custom" as const,
            label: "Select Carousel",
            render: (props: any) => <CarouselPicker value={props.value} onChange={props.onChange} />
        },
        autoSlide: {
            type: "radio" as const,
            label: "Auto Slide",
            options: [
                { label: "On", value: true },
                { label: "Off", value: false }
            ]
        },
        interval: {
            type: "number" as const,
            label: "Interval (ms)"
        },
        elementId: {
            type: "text" as const,
            label: "ID / Ancla (opcional)"
        }
    },
    defaultProps: {
        carouselId: "",
        autoSlide: true,
        interval: 5000,
        elementId: ""
    },
    render: undefined // Provide render later
};

export default function PhotoCarouselPuck({ carouselId, autoSlide = true, interval = 5000, elementId }: PhotoCarouselPuckProps) {
    const [carousel, setCarousel] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [carousels, setCarousels] = useState<any[]>([]);

    useEffect(() => {
        // Use apiGet which handles auth and protocol correctly
        apiGet<any[]>("/carousels")
            .then(data => {
                if (Array.isArray(data)) {
                    setCarousels(data);
                    if (carouselId) {
                        const found = data.find((c: any) => c.id === carouselId || c.id === String(carouselId));
                        if (found) setCarousel(found);
                    } else if (data.length > 0) {
                        setCarousel(data[0]); // Default to first
                    }
                } else {
                    console.error("Expected array of carousels but got:", data);
                    setCarousels([]);
                }
            })
            .catch(err => console.error("Failed to load carousels", err))
            .finally(() => setLoading(false));
    }, [carouselId]);

    // Override carousel settings with Puck props
    const activeCarousel = useMemo(() => {
        return carousel ? {
            ...carousel,
            autoplay: autoSlide,
            interval: interval || carousel.interval
        } : null;
    }, [carousel, autoSlide, interval]);

    if (loading) return <div className="p-4 text-center text-gray-500">Loading Carousel...</div>;

    if (!activeCarousel) {
        return (
            <div className="p-8 border-2 border-dashed border-gray-300 rounded text-center">
                <p>No carousel selected or found.</p>
                <div className="mt-2 text-sm text-gray-500">
                    Available IDs: {carousels.map(c => c.id).join(", ")}
                </div>
            </div>
        );
    }

    return <div id={elementId || undefined}><HeroCarousel carousel={activeCarousel} /></div>;
}
