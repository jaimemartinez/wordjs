"use client";

// Client island for the composable chrome: hamburger + slide-in panel that a horizontal ChromeNav
// needs on mobile. Mirrors Header.tsx's mobile pattern and reuses its .wjs-header-mobile-* hook
// classes so existing theme CSS keeps applying. Mounted by the SERVER ChromeNav next to the desktop
// nav (valid server → client island composition) with already-resolved items — HEADER navs only, a
// footer row keeps its links visible at every width instead of hiding them behind a drawer.
import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import type { ChromeMenuItem } from "@/lib/chromeData";

// Everything the drawer can hand focus to. Kept in one place: the open effect uses it both to place
// the initial focus and to find the cycle ends for the Tab trap.
const FOCUSABLE = 'a[href], button:not([disabled])';

export default function ChromeNavMobile({ items }: { items: ChromeMenuItem[] }) {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    // Unique panel id — a composition may hold several horizontal header navs (one per row).
    const panelId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    // The drawer is PORTALED to <body>. `position: fixed` resolves against the nearest ancestor with a
    // transform/filter/backdrop-filter, and the composed header wrapper uses backdrop-blur — inside it
    // the panel collapsed to the header's own height instead of covering the viewport. Portaling makes
    // the drawer independent of whatever wrapper (or theme CSS) the composition happens to sit in.
    // Mount-gated so the server and the first client render agree.
    useEffect(() => setMounted(true), []);

    // Close on resize to desktop, like Header.tsx (the desktop nav takes over at md).
    useEffect(() => {
        const handleResize = () => {
            if (window.innerWidth >= 768) setOpen(false);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    // Drawer semantics: Escape dismisses it and the page behind stays put (as in Header.tsx), plus the
    // two halves of a modal focus contract — while it is open Tab CYCLES inside the panel (it covers the
    // viewport, so tabbing to the page behind would strand the keyboard user), and closing hands focus
    // back to the hamburger that opened it (otherwise focus falls back to <body> and the reading
    // position is lost). The panel is portaled to <body>, so its DOM position cannot do either for us.
    useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        // Captured here, not read in the cleanup: the <button> node is stable across the icon swap, and
        // the cleanup must not depend on a ref that React may already have detached.
        const trigger = triggerRef.current;
        const focusable = (): HTMLElement[] =>
            panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                return;
            }
            if (e.key !== "Tab" || !panel) return;
            const stops = focusable();
            if (stops.length === 0) return;
            const first = stops[0];
            const last = stops[stops.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const inside = active !== null && panel.contains(active);
            // Wrap at whichever end the focus is leaving from — and pull it back in if it escaped.
            if (e.shiftKey ? (!inside || active === first) : (!inside || active === last)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
        };
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.addEventListener("keydown", onKey);
        focusable()[0]?.focus();
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = previousOverflow;
            trigger?.focus();
        };
    }, [open]);

    return (
        // .wjs-header-actions: the hook Header.tsx puts on the <div> holding this same hamburger, which
        // themes target as `.wjs-header-actions button`. Same classes as that div so the theme's flex
        // tweaks (order / margin-left:auto) land identically.
        <div className="wjs-chrome-nav-mobile wjs-header-actions flex items-center gap-4 md:hidden">
            <button
                ref={triggerRef}
                className="w-11 h-11 rounded-full bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)] flex items-center justify-center shadow-lg hover:bg-[var(--wjs-color-primary-dark,#266073)] transition-colors"
                onClick={() => setOpen(!open)}
                aria-label="Toggle menu"
                aria-expanded={open}
                aria-controls={panelId}
            >
                {open ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                    </svg>
                )}
            </button>

            {mounted && createPortal(<>
            {/* Overlay */}
            <div
                className={`wjs-header-mobile-overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300 md:hidden ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                onClick={() => setOpen(false)}
            />

            {/* Panel */}
            <div
                ref={panelRef}
                id={panelId}
                inert={!open}
                aria-hidden={!open}
                className={`wjs-header-mobile-panel fixed top-0 end-0 z-50 h-full w-72 bg-[var(--wjs-bg-surface,white)] shadow-2xl transform transition-transform duration-300 ease-out md:hidden ${open ? "translate-x-0" : "translate-x-full rtl:-translate-x-full"}`}
            >
                <div className="p-6">
                    <button
                        className="absolute top-4 end-4 w-10 h-10 rounded-full bg-[var(--wjs-bg-muted,#f3f4f6)] text-[var(--wjs-color-text-muted,#4b5563)] flex items-center justify-center hover:bg-[var(--wjs-border-subtle,#e5e7eb)] transition-colors"
                        onClick={() => setOpen(false)}
                        aria-label="Close menu"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    <nav aria-label="Mobile" className="flex flex-col gap-4 pt-10">
                        {items.length > 0 ? (
                            items.map((item) => (
                                <Link
                                    key={item.id}
                                    href={item.url || "#"}
                                    className="text-lg text-[var(--wjs-color-text-main,#374151)] hover:text-[var(--wjs-color-primary,#2F6D86)] font-medium py-2 border-b border-[var(--wjs-border-subtle,#f3f4f6)] transition-colors"
                                    onClick={() => setOpen(false)}
                                >
                                    {item.title}
                                </Link>
                            ))
                        ) : (
                            <p className="text-[var(--wjs-color-text-muted,#6b7280)] text-sm">No menu items</p>
                        )}
                    </nav>
                </div>
            </div>
            </>, document.body)}
        </div>
    );
}
