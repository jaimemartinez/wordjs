// @ts-nocheck — plugin client source; bundled by the plugin loader, not type-checked by the frontend ("react" resolves only in the bundle).
import { useEffect, useState, type RefObject } from "react";
import { revealDelta, stripFade, stripOverflow } from "./phoneLayout";

/**
 * Which sides of a horizontally scrolling tab strip have tabs out of view, kept current as it scrolls and
 * resizes. The strip spreads `stripMoreAttrs(more)` and renders TAB_STRIP_CSS (lib/phoneLayout.ts), which
 * fades it out on those sides: a tab cut at the edge with nothing saying the strip scrolls read as the last
 * one. `deps`: re-measure when the strip's content changes (the active tab, the set of tabs).
 */
export function useStripOverflow(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): { left: boolean; right: boolean } {
    const [more, setMore] = useState({ left: false, right: false });
    useEffect(() => {
        const strip = ref.current;
        if (!strip) return;
        const measure = () => setMore((prev) => {
            const next = stripOverflow(strip);
            return prev.left === next.left && prev.right === next.right ? prev : next;
        });
        measure();
        strip.addEventListener("scroll", measure, { passive: true });
        window.addEventListener("resize", measure);
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        ro?.observe(strip);
        return () => { strip.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); ro?.disconnect(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return more;
}

/** The attributes TAB_STRIP_CSS keys on. */
export const stripMoreAttrs = (more: { left: boolean; right: boolean }) => ({
    "data-more-left": more.left ? "" : undefined,
    "data-more-right": more.right ? "" : undefined,
});

/**
 * Keeps a tab strip's ACTIVE tab (the element matching `selector`) in the clear part of the strip: in view
 * and out from under the edge fade TAB_STRIP_CSS draws on a side with more tabs (lib/phoneLayout.ts
 * revealDelta). Runs when `deps` change (the active tab). Scrolls the strip only — never the page.
 *
 * A phone shows three of the conference's twelve tabs: after a reload the saved «Campos» was off-screen,
 * and a tab TAPPED at the edge was "in view" but under the 48 px fade — its label and underline faded out
 * (iPhone SE). The «Alimentación» sub-tabs had the same fade and no reveal at all.
 */
export function useRevealActive(ref: RefObject<HTMLElement | null>, selector: string, deps: unknown[] = []): void {
    useEffect(() => {
        const strip = ref.current;
        const active = strip?.querySelector(selector) as HTMLElement | null;
        if (!strip || !active) return;
        const delta = revealDelta(strip.getBoundingClientRect(), active.getBoundingClientRect(), stripFade(stripOverflow(strip)));
        if (delta) strip.scrollLeft += delta;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
}
