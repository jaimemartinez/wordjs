import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { measureViewport, placeDropdown, type DropdownPlacement, type PlacementBand } from "./dropdownPlacement";

/** The DOM surface dropdownContext walks (an Element; a plain object in the unit test). */
export interface BoundsNode {
    parentElement: BoundsNode | null;
    hasAttribute(name: string): boolean;
    getBoundingClientRect(): { top: number; bottom: number };
}

/** Where a list opened from a field inside a core dialog may go (lib/dropdownPlacement.ts `bounds`, `card`). */
export interface DropdownContext {
    /** The dialog's scrolling body — or its card when nothing scrolls. */
    bounds: PlacementBand;
    /** The dialog's card: the layer's child that holds the field. */
    card: PlacementBand | null;
    /** The element that scrolls (the body), when there is one: the placement may scroll it to fit the list. */
    scroller: BoundsNode | null;
}

const box = (node: BoundsNode | null): PlacementBand | null => {
    const r = node?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom } : null;
};

/**
 * The dialog a list opened from `trigger` belongs to, or null.
 *
 * Only inside a core dialog (components/DialogLayer.tsx, `data-wjs-dialog-layer`): the nearest ancestor
 * that scrolls vertically — the dialog's body, between its header and its footer — and the dialog's card
 * (the layer's child that holds the field). Outside a dialog there is nothing: a page keeps the whole
 * visible viewport, as before, and is never scrolled by a list.
 */
export function dropdownContext(
    trigger: BoundsNode | null,
    overflowYOf: (node: BoundsNode) => string = (node) => getComputedStyle(node as unknown as Element).overflowY,
): DropdownContext | null {
    let scroller: BoundsNode | null = null;
    let child: BoundsNode | null = trigger;
    for (let node = trigger?.parentElement ?? null; node; child = node, node = node.parentElement) {
        if (node.hasAttribute("data-wjs-dialog-layer")) {
            const card = child && child !== trigger ? box(child) : null;
            const bounds = box(scroller ?? child);
            return bounds ? { bounds, card, scroller } : null;
        }
        if (!scroller && /^(auto|scroll|overlay)$/.test(overflowYOf(node))) scroller = node;
    }
    return null;
}

/** The box a list opened from `trigger` should stay in (the dialog body), or null outside a dialog. */
export function dropdownBounds(
    trigger: BoundsNode | null,
    overflowYOf?: (node: BoundsNode) => string,
): PlacementBand | null {
    return dropdownContext(trigger, overflowYOf)?.bounds ?? null;
}

/**
 * Keeps a portalled dropdown list placed by lib/dropdownPlacement.ts while it is open (within its dialog
 * when it opens from one — dropdownContext above): on open, on any scroll (capture: a dialog body
 * counts), on resize, when the visual viewport moves (on-screen keyboard, pinch-zoom), and once more right
 * after the list renders — when its natural height becomes known — before the browser paints.
 *
 * That once-more is the only time the placement may SCROLL the dialog body (`scrollBy`): the few pixels
 * that let the whole list fit beside the field. Every other update (the user scrolling, a resize) only
 * follows the field. Shared by ModernSelect and ui/Select.
 *
 * `contentKey` changes when the list's content does (e.g. its option count), so it is measured again.
 */
export function useDropdownPlacement(
    isOpen: boolean,
    refs: { trigger: RefObject<HTMLElement | null>; list: RefObject<HTMLElement | null>; label?: RefObject<HTMLElement | null> },
    contentKey: unknown,
): { coords: DropdownPlacement | null; update: () => void } {
    const [coords, setCoords] = useState<DropdownPlacement | null>(null);
    // The latest refs, read when measuring: `place` stays one stable function for the listeners below.
    const refsRef = useRef(refs);
    useLayoutEffect(() => { refsRef.current = refs; });

    const place = useCallback((mayScroll: boolean) => {
        const { trigger, list, label } = refsRef.current;
        const el = trigger.current;
        if (!el || typeof window === "undefined") return;
        const listEl = list.current;
        // Inside a dialog: its scrolling body and its card, so the list neither rises over the dialog's title
        // nor gets cut when it can fit whole (iPhone SE / iPhone 13, «Nuevo usuario»).
        const ctx = dropdownContext(el as unknown as BoundsNode);
        const scroller = mayScroll && ctx?.scroller ? (ctx.scroller as unknown as HTMLElement) : null;
        const next = placeDropdown({
            trigger: el.getBoundingClientRect(),
            labelTop: label?.current ? label.current.getBoundingClientRect().top : null,
            bounds: ctx?.bounds ?? null,
            card: ctx?.card ?? null,
            scroll: scroller ? { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null,
            // The list's natural height (scrollHeight ignores its max-height) plus the menu's 1px borders.
            contentHeight: listEl ? listEl.scrollHeight + 2 : null,
            ...measureViewport(),
        });
        // Computed for the field's position after this scroll; the scroll event that follows re-places the
        // list from the real rects (no further scroll), to the same spot.
        if (scroller && next.scrollBy) scroller.scrollTop += next.scrollBy;
        setCoords((prev) => (prev && prev.side === next.side && prev.left === next.left && prev.width === next.width
            && prev.top === next.top && prev.bottom === next.bottom && prev.maxHeight === next.maxHeight ? prev : next));
    }, []);
    const update = useCallback(() => place(false), [place]);

    useEffect(() => {
        if (!isOpen) return;
        update();
        const onMove = () => update();
        const vv = window.visualViewport;
        window.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
        vv?.addEventListener("resize", onMove);
        vv?.addEventListener("scroll", onMove);
        return () => {
            window.removeEventListener("scroll", onMove, true);
            window.removeEventListener("resize", onMove);
            vv?.removeEventListener("resize", onMove);
            vv?.removeEventListener("scroll", onMove);
        };
    }, [isOpen, update]);

    const placed = coords !== null;
    useLayoutEffect(() => {
        if (isOpen && placed) place(true);
    }, [isOpen, placed, contentKey, place]);

    return { coords, update };
}
