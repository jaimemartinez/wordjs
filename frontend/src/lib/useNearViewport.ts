"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * True once the element has come within `margin` of the viewport, and from then on. A section far down a
 * page (the comments) fetches its data then instead of on every visit (QA S2-08: each public visit made
 * the comments request whether or not anyone scrolled there). Without IntersectionObserver it is true at once.
 */
export function useNearViewport(ref: RefObject<Element | null>, margin = "300px"): boolean {
    const [near, setNear] = useState(false);
    useEffect(() => {
        if (near) return;
        const el = ref.current;
        if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
        }, { rootMargin: margin });
        io.observe(el);
        return () => io.disconnect();
    }, [ref, margin, near]);
    return near;
}
