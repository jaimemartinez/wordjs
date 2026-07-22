// @ts-nocheck
"use client";

import { useEffect, useState, useRef, useCallback } from "react";

// Local type definitions - plugin is self-contained
interface CarouselImage {
    url: string;
    title?: string;
    description?: string;
    text?: string;
    buttonText?: string;
    buttonLink?: string;
}

interface Carousel {
    id: string;
    name: string;
    images: CarouselImage[];
    autoplay?: boolean;
    interval?: number;
    location?: string;
}

interface HeroCarouselProps {
    carousel: Carousel;
}

export default function HeroCarousel({ carousel }: HeroCarouselProps) {
    const [currentSlide, setCurrentSlide] = useState(0);
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    // Keep a ref to the latest carousel to access inside interval without restarting it
    const latestCarousel = useRef(carousel);
    useEffect(() => {
        latestCarousel.current = carousel;
    }, [carousel]);

    const startTimer = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current);

        // Use values from props for setup, but ref for execution
        let interval = carousel.interval || 5000;

        // Heuristic: If interval is very small (e.g. < 100), assume it's seconds and convert to ms
        // This fixes legacy data where "5" meant 5 seconds.
        if (interval < 100) {
            interval = interval * 1000;
        }

        const autoplay = carousel.autoplay !== false;

        if (autoplay && carousel.images.length > 1) {
            timerRef.current = setInterval(() => {
                const currentImages = latestCarousel.current.images;
                if (currentImages && currentImages.length > 0) {
                    setCurrentSlide((prev) => (prev + 1) % currentImages.length);
                }
            }, interval);
        }
    }, [carousel.interval, carousel.autoplay, carousel.images.length]); // Only restart if settings change

    useEffect(() => {
        startTimer();
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [startTimer]);

    const handleManualChange = (newIndex: number) => {
        setCurrentSlide(newIndex);
        startTimer(); // Reset timer on manual change
    };

    const nextSlide = () => {
        handleManualChange((currentSlide + 1) % carousel.images.length);
    };

    const prevSlide = () => {
        handleManualChange((currentSlide - 1 + carousel.images.length) % carousel.images.length);
    };

    if (!carousel.images.length) return null;

    return (
        <section className="relative w-full h-[300px] md:h-[500px] rounded-[15px] md:rounded-[30px] overflow-hidden mb-8 md:mb-16 shadow-2xl">
            {carousel.images.map((image, i) => (
                <div
                    key={i}
                    className={`absolute inset-0 transition-opacity duration-1000 ease-in-out ${i === currentSlide ? "opacity-100 z-10" : "opacity-0 z-0"
                        }`}
                >
                    <img
                        src={image.url}
                        alt={image.title || `Slide ${i + 1}`}
                        className="w-full h-full object-cover"
                    />
                    {/* Overlay Gradient similar to theme */}
                    <div className="absolute inset-0 bg-gradient-to-r from-[#306E88]/90 to-[#00A9CE]/70"></div>
                </div>
            ))}

            {/* Content Overlay */}
            <div className="relative z-20 h-full flex flex-col justify-center px-6 md:px-20">
                <div key={currentSlide} className="animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <h1 className="text-white font-bold text-2xl sm:text-4xl md:text-6xl uppercase leading-none mb-0 font-oswald drop-shadow-lg">
                        {carousel.images[currentSlide].title || "Bienvenido"}
                    </h1>
                    <h2 className="text-white font-light text-2xl sm:text-4xl md:text-6xl uppercase leading-tight mb-4 md:mb-8 drop-shadow-md">
                        {carousel.images[currentSlide].description || "WordJS"}
                    </h2>

                    {/* Optional paragraph */}
                    {carousel.images[currentSlide].text && (
                        <p className="text-white text-sm sm:text-base md:text-xl font-light max-w-xl mb-6 md:mb-10 leading-relaxed opacity-90 drop-shadow-sm whitespace-pre-line">
                            {carousel.images[currentSlide].text}
                        </p>
                    )}

                    {carousel.images[currentSlide].buttonText && (
                        <div className="flex gap-4">
                            <a
                                href={carousel.images[currentSlide].buttonLink || "#"}
                                className="bg-white text-[#2F6D86] font-extrabold uppercase px-6 py-2 md:px-10 md:py-3 text-sm md:text-base rounded-full shadow-lg hover:shadow-xl hover:-translate-y-1 transition-all inline-block"
                            >
                                {carousel.images[currentSlide].buttonText}
                            </a>
                        </div>
                    )}
                </div>
            </div>

            {/* Navigation Dots */}
            <div className="absolute bottom-4 md:bottom-8 right-6 md:right-12 z-30 flex gap-2 md:gap-3">
                {carousel.images.map((_, i) => (
                    <button
                        key={i}
                        onClick={() => handleManualChange(i)}
                        className={`w-2 h-2 md:w-3 md:h-3 rounded-full transition-all ${i === currentSlide ? "bg-white scale-125" : "bg-white/40 hover:bg-white/70"
                            }`}
                    />
                ))}
            </div>

            {/* Arrows */}
            <button onClick={prevSlide} className="absolute left-8 top-1/2 -translate-y-1/2 z-30 text-white/50 hover:text-white text-4xl hidden md:block">
                <i className="fa-solid fa-chevron-left"></i>
            </button>
            <button onClick={nextSlide} className="absolute right-8 top-1/2 -translate-y-1/2 z-30 text-white/50 hover:text-white text-4xl hidden md:block">
                <i className="fa-solid fa-chevron-right"></i>
            </button>

        </section>
    );
}
