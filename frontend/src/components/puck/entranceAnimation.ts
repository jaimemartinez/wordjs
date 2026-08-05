"use client";
/**
 * Entrance-animation runtime (hook + replay event) — split out of AnimationField so the PUBLIC
 * AnimatedShell island can import it without dragging the editor's field UI into page bundles.
 * AnimationField re-exports everything, so existing imports keep working.
 */
import React from "react";
import type { AnimSpec } from "./blockShell";

/** Event that re-arms every animated block so the author can watch the sequence again. */
export const ANIM_REPLAY_EVENT = "wjs-anim-replay";

/**
 * Re-arm and replay every entrance animation in a document (the editor canvas iframe, normally).
 * Exposed as a plain DOM event so it crosses the iframe boundary without a React bridge: the
 * toolbar dispatches it into the canvas document and each armed block re-runs its own effect.
 */
export function replayAnimations(doc: Document) {
    doc.dispatchEvent(new CustomEvent(ANIM_REPLAY_EVENT));
}

export function useEntranceAnimation(ref: React.RefObject<HTMLDivElement | null>, anim: AnimSpec | null) {
    const type = anim?.type || "";
    React.useEffect(() => {
        const el = ref.current;
        if (!type || !el || typeof window === "undefined") return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        if (typeof IntersectionObserver === "undefined") return; // ancient browser → stay visible

        // Replay: strip the state, force a reflow so the browser cannot coalesce the attribute
        // removal and re-add into "no change" (which would skip the animation entirely), then
        // re-arm and let it run. Listening on the element's OWN document keeps this working inside
        // the canvas iframe, whose document is not the editor's.
        const onReplay = () => {
            el.removeAttribute("data-wjs-anim");
            void el.offsetWidth; // force reflow — do not remove
            el.setAttribute("data-wjs-anim", "in");
        };
        el.ownerDocument.addEventListener(ANIM_REPLAY_EVENT, onReplay);

        el.setAttribute("data-wjs-anim", "armed");
        // threshold MUST be 0 (first visible pixel) with no negative rootMargin: a ratio threshold
        // is geometrically unreachable for blocks taller than ~viewport/threshold (a tall Section,
        // or Columns stacked on mobile, maxes out at viewportH/blockH < 0.15) and a negative bottom
        // margin creates a dead strip where last-blocks on short pages never fire — both left the
        // block armed (opacity 0) FOREVER. Confirmed empirically in Chrome; do not "tune" these.
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        el.setAttribute("data-wjs-anim", "in");
                        io.disconnect();
                    }
                }
            },
            { threshold: 0 }
        );
        io.observe(el);
        return () => {
            io.disconnect();
            el.ownerDocument.removeEventListener(ANIM_REPLAY_EVENT, onReplay);
            // If the block unmounts/re-keys mid-flight, never leave it armed-invisible.
            if (el.getAttribute("data-wjs-anim") === "armed") el.removeAttribute("data-wjs-anim");
        };
    }, [ref, type]);
}
