"use client";

/**
 * Scroll-spy for the Table of Contents block — the ONLY interactive part, and pure progressive
 * enhancement: the ToC links are fully server-rendered by TableOfContentsBlock and work with no JS.
 * This island watches the page's heading ids and marks the link for the heading currently at the top
 * of the viewport as active (adds `.wjs-toc__link--active` + aria-current). When scroll-spy is off the
 * block renders no island at all.
 *
 * It observes the real heading elements by id (looked up in the document, not inside this wrapper —
 * the headings live elsewhere on the page), and toggles the matching `[data-toc-id]` link that DOES
 * live in `children`. No layout is measured on the main thread; IntersectionObserver does the work.
 */
import { useEffect, useRef } from "react";

export default function TocScrollSpy({ ids, children }: { ids: string[]; children: React.ReactNode }) {
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!Array.isArray(ids) || ids.length === 0) return;
        const root = rootRef.current;
        if (!root || typeof IntersectionObserver === "undefined") return;

        // The ToC links inside this wrapper, keyed by the heading id they point at.
        const links = new Map<string, HTMLElement>();
        root.querySelectorAll<HTMLElement>("[data-toc-id]").forEach((el) => {
            const id = el.getAttribute("data-toc-id");
            if (id) links.set(id, el);
        });

        const setActive = (activeId: string | null) => {
            links.forEach((el, id) => {
                const on = id === activeId;
                el.classList.toggle("wjs-toc__link--active", on);
                if (on) el.setAttribute("aria-current", "true");
                else el.removeAttribute("aria-current");
            });
        };

        // The actual heading elements on the page (may be fewer than `ids` if one was removed).
        const targets = ids
            .map((id) => document.getElementById(id))
            .filter((el): el is HTMLElement => !!el);
        if (targets.length === 0) return;

        const visible = new Set<string>();
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) visible.add(e.target.id);
                    else visible.delete(e.target.id);
                }
                // Highlight the first heading (in document order) that is currently on screen; when none
                // is (between sections) keep the last one above the fold active.
                const firstVisible = ids.find((id) => visible.has(id));
                if (firstVisible) setActive(firstVisible);
            },
            // Trigger when a heading crosses the upper part of the viewport (mirrors reading position).
            { rootMargin: "0px 0px -70% 0px", threshold: 0 },
        );
        targets.forEach((t) => io.observe(t));
        return () => io.disconnect();
    }, [ids]);

    return (
        <div ref={rootRef} className="wjs-toc-wrap">
            {children}
        </div>
    );
}
