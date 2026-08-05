/**
 * SERVER twin of withSharedBlockFields' wrapper (VisibilityField.tsx): the same hide classes,
 * appearance box and animation wrapper around every public block, computed with the SAME pure
 * helpers (blockShell.ts) the editor wrapper uses — one implementation, two render surfaces.
 *
 * Branching mirrors the editor Wrapped byte-for-byte:
 *  - nothing set                  → the block render, untouched (no wrapper element at all)
 *  - look only                    → the appearance box (server-rendered, zero hydration)
 *  - hide only                    → display:contents div with wjs-hide-* classes (pure CSS)
 *  - anim/scroll (± hide/look)    → AnimatedShell client island (the ONLY hydrated case)
 */
import { hideClasses, appearanceToStyle } from "@/components/puck/blockShell";
import type { AnimSpec, Appearance, Hide } from "@/components/puck/blockShell";
import AnimatedShell from "./AnimatedShell";

export default function SharedBlockShell({ hide, anim: animProp, look: lookProp, children }: {
    hide?: Hide;
    anim?: AnimSpec;
    look?: Appearance;
    children: React.ReactNode;
}) {
    const hideCls = hideClasses(hide);
    const anim = (animProp || {}) as AnimSpec;
    const animActive = !!anim.type;
    const scrollActive = !!anim.scroll;
    const wrapActive = animActive || scrollActive;
    const look = appearanceToStyle(lookProp);
    const inner = children;

    // Untouched block → no wrapper element at all, so its own render() is untouched.
    // NOTE: gate mirrors the editor wrapper EXACTLY, including its documented wart — a scroll-only
    // spec with entrance "Ninguna", no hide and no box takes this path and loses its scroll
    // classes there too. Fixing that belongs to both surfaces at once, in blockShell.
    if (!hideCls && !animActive && !look.hasBox) return inner;

    // TWO NESTED LAYERS, deliberately — they must never share an element (see the editor wrapper:
    // entrance animation and appearance box fight over `animation`/`transform` on one element).
    const box = look.hasBox ? (
        <div className={look.className || undefined} style={look.style}>
            {look.overlay && <div style={look.overlay} aria-hidden="true" />}
            {/* The overlay is absolutely positioned over the box, so the block's own content
                needs its own stacking context to stay above it. */}
            {look.overlay ? <div style={{ position: "relative" }}>{inner}</div> : inner}
        </div>
    ) : (
        inner
    );

    if (!hideCls && !wrapActive) return box;

    if (wrapActive) {
        // The one hydrated case: the entrance/scroll wrapper needs the client hook.
        return <AnimatedShell hideCls={hideCls} anim={anim}>{box}</AnimatedShell>;
    }

    // hide-only: static wrapper, no hydration — the wjs-hide-* media queries do the work.
    return (
        <div className={hideCls} style={{ display: "contents" }}>
            {box}
        </div>
    );
}
