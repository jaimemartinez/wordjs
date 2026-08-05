"use client";
/**
 * Initialiser for [photo-carousel] widgets living inside sanitized legacy post HTML
 * (dangerouslySetInnerHTML content — no React components to hydrate, just DOM wiring).
 * Renders nothing; moved verbatim from the old client PostContent.
 */
import { useEffect } from "react";

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

export default function LegacyCarousels({ postId }: { postId: number | string }) {
    useEffect(() => {
        let dispose: (() => void) | undefined;
        const timeoutId = setTimeout(() => { dispose = initCarousels(); }, 100);
        return () => { clearTimeout(timeoutId); dispose?.(); };
    }, [postId]);
    return null;
}
