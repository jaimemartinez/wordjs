"use client";

// Client island mounted INSIDE a composed <header> that is sticky or transparent. It only mirrors
// "has the page scrolled?" onto the header's data-scrolled attribute — the stable hook the default
// Header.tsx already exposes — so CSS can turn a transparent-over-hero header solid once the hero is
// left behind. No state of its own, no portal, no body styles: one passive scroll listener, and the
// attribute stays "false" (the server value) until the first scroll.
import { useEffect, useRef } from "react";

export default function ChromeHeaderScroll() {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const header = ref.current?.closest("header");
        if (!header) return;
        const update = () => header.setAttribute("data-scrolled", window.scrollY > 10 ? "true" : "false");
        update();
        window.addEventListener("scroll", update, { passive: true });
        return () => window.removeEventListener("scroll", update);
    }, []);
    return <span ref={ref} hidden />;
}
