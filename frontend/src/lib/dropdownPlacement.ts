/**
 * Where a portalled dropdown list goes (ModernSelect, ui/Select): ALWAYS inside the visible viewport, and
 * WHOLE whenever it can be shown whole.
 *
 * The old rule opened downwards whenever 180px were free below the field and then let the list be up to
 * 260px tall regardless, with a 120px floor: in the «Nuevo usuario» dialog, scrolled down, the role list
 * ran past the dialog and the bottom of the screen («ROLES DE PLUGINS» cut in half, the plugin role out of
 * reach), and on a phone the upward list covered the field's own label.
 *
 * Given the list's natural height (`contentHeight`, measured once it has rendered), the list is placed
 * whole, trying in turn each BAND it may occupy, the tightest first:
 *   1. the dialog's scrolling body (`bounds`), so it covers neither the dialog's title nor its buttons;
 *   2. the dialog's card (`card`): over its header or footer, but not sticking out of the dialog;
 *   3. the visible viewport.
 * In each band: below the field, else above the field's LABEL (the label stays readable) — or above the
 * field itself when it has no label. When neither fits as things are and the dialog body can scroll
 * (`scroll`), the smallest scroll of the body that makes one fit is taken (`scrollBy`, which the caller
 * applies): the field moves, the list is whole, the field stays inside the body.
 *
 * Only when no band fits the whole list beside the field: a labelled field's list goes over its label
 * («over-label»), ending DROPDOWN_COVER_GAP above the trigger so it covers the label entirely — a list
 * ending at the label's foot left a sliver of it showing under the list's rounded corner. And when not
 * even that fits, the list takes the roomier side (inside the dialog body if that leaves at least
 * DROPDOWN_MIN_BOUNDED, else on the screen), its height clamped to the room — it scrolls inside.
 *
 * Live findings this answers, «Nuevo usuario» scrolled to the bottom: on an iPhone SE (375x667) the role
 * list (332px) was clamped to 300px above the label and its last option, «Equipo de conferencia · plugin
 * conference-manager», was cut at the list's edge; on an iPhone 13 the list rose out of the dialog body and
 * its top edge cut the dialog's subtitle in half. The body now scrolls the few pixels that let the list fit
 * whole inside it (iPhone 13), or inside the card over the header when the body is too short for it (SE).
 *
 * "The screen" is the VISIBLE viewport (visualViewport: the on-screen keyboard and pinch-zoom shrink it)
 * minus a small margin. Pure: the components measure, this decides.
 */

export const DROPDOWN_GAP = 8;
/** Distance kept from the visible viewport's (and a band's) edges. */
export const DROPDOWN_EDGE = 8;
/** The tallest a list gets even with room to spare (it scrolls past this). */
export const DROPDOWN_MAX_HEIGHT = 360;
/** Below this much room inside `bounds`, a clamped list uses the whole visible viewport instead. */
export const DROPDOWN_MIN_BOUNDED = 160;
/** How far above the trigger a list drawn over the field's label ends: it covers the whole label. */
export const DROPDOWN_COVER_GAP = 2;

export interface PlacementRect { top: number; bottom: number; left: number; width: number }
export interface PlacementBand { top: number; bottom: number }

export interface DropdownPlacementInput {
    /** The trigger's client rect. */
    trigger: PlacementRect;
    /** Top of the field's label when it sits right above the trigger (an upward list prefers to clear it). */
    labelTop?: number | null;
    /** The visible viewport, in client coordinates (visualViewport.offsetTop / .height). */
    viewportTop: number;
    viewportHeight: number;
    viewportLeft?: number;
    viewportWidth?: number;
    /** Height of the layout viewport (documentElement.clientHeight): a fixed element's `bottom` counts from it. */
    layoutHeight: number;
    /** The list's natural height (content, padding and border), once measured. */
    contentHeight?: number | null;
    /** The visible box of the dialog body the field scrolls in (client coordinates), when it is in a dialog. */
    bounds?: PlacementBand | null;
    /** The dialog's card (client coordinates), when it is in a dialog. */
    card?: PlacementBand | null;
    /**
     * The dialog body's vertical scroll (`scrollTop` and its maximum, scrollHeight − clientHeight). Given,
     * the placement may ask the caller to scroll the body (`scrollBy`) so the whole list fits beside the
     * field. Only used once the list's height is known (`contentHeight`).
     */
    scroll?: { top: number; max: number } | null;
}

export type DropdownSide = "below" | "above-label" | "above" | "over-label";

export interface DropdownPlacement {
    side: DropdownSide;
    left: number;
    width: number;
    /** Set when the list opens downwards. */
    top?: number;
    /** Set when the list opens upwards (distance from the layout viewport's bottom edge). */
    bottom?: number;
    /** Never more than the room on the chosen side: the list cannot leave the visible viewport. */
    maxHeight: number;
    /**
     * Pixels to add to the dialog body's scrollTop BEFORE drawing the list (0: none). The other fields are
     * computed for the field's position after that scroll.
     */
    scrollBy: number;
}

type Candidate = { side: DropdownSide; space: number; anchor: number };
type Placed = Candidate & { shift: number };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const validBand = (b: PlacementBand | null | undefined): b is PlacementBand => !!b && finite(b.top) && finite(b.bottom) && b.bottom > b.top;

function labelOf(input: DropdownPlacementInput): number | null {
    const l = input.labelTop;
    return finite(l) && l < input.trigger.top ? l : null;
}

/** The two sides beside the field (below; above its label, or above it when it has none) within `band`, the field moved up by `shift`. */
function sides(input: DropdownPlacementInput, band: PlacementBand, shift: number): Candidate[] {
    const { trigger } = input;
    const label = labelOf(input);
    const below = trigger.bottom - shift + DROPDOWN_GAP;
    const up = label !== null
        ? { side: "above-label" as const, anchor: label - shift - DROPDOWN_GAP }
        : { side: "above" as const, anchor: trigger.top - shift - DROPDOWN_GAP };
    return [
        { side: "below", space: band.bottom - below, anchor: below },
        { ...up, space: up.anchor - band.top },
    ];
}

/**
 * The whole list beside the field within `band`: as things are, else after the smallest scroll of the
 * dialog body (`scroll`) that makes it fit while the field stays inside `keep` (the body's visible box).
 */
function wholeIn(input: DropdownPlacementInput, band: PlacementBand, want: number, keep: PlacementBand | null): Placed | null {
    const now = sides(input, band, 0).find((c) => c.space >= want);
    if (now) return { ...now, shift: 0 };
    const s = input.scroll;
    if (!keep || !s || !finite(s.top) || !finite(s.max)) return null;
    const lo = -Math.max(0, s.top);              // the body can scroll up this far (the field moves down)...
    const hi = Math.max(0, s.max - s.top);       // ...and down this far (the field moves up)
    const { trigger } = input;
    const fieldTop = labelOf(input) ?? trigger.top;
    const fieldStays = (shift: number) => fieldTop - shift >= keep.top && trigger.bottom - shift <= keep.bottom;
    const options: number[] = [];
    // Below: the field moves up until the list fits under it.
    const down = Math.ceil(trigger.bottom + DROPDOWN_GAP + want - band.bottom);
    if (down > 0 && down <= hi && fieldStays(down)) options.push(down);
    // Above (its label): the field moves down until the list fits over it.
    const up = Math.floor(fieldTop - DROPDOWN_GAP - want - band.top);
    if (up < 0 && up >= lo && fieldStays(up)) options.push(up);
    if (options.length === 0) return null;
    const shift = options.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    const fit = sides(input, band, shift).find((c) => c.space >= want);
    return fit ? { ...fit, shift } : null;
}

export function placeDropdown(input: DropdownPlacementInput): DropdownPlacement {
    const { trigger } = input;
    const viewTop = input.viewportTop + DROPDOWN_EDGE;
    const viewBottom = input.viewportTop + input.viewportHeight - DROPDOWN_EDGE;
    const screen: PlacementBand = { top: viewTop, bottom: viewBottom };
    const natural = Number(input.contentHeight);
    const measured = Number.isFinite(natural) && natural > 0;
    const want = Math.min(DROPDOWN_MAX_HEIGHT, measured ? natural : DROPDOWN_MAX_HEIGHT);

    // The bands, tightest first, each inset by the edge margin and kept on the screen.
    const inset = (b: PlacementBand): PlacementBand => ({ top: Math.max(viewTop, b.top + DROPDOWN_EDGE), bottom: Math.min(viewBottom, b.bottom - DROPDOWN_EDGE) });
    const body = validBand(input.bounds) ? inset(input.bounds) : null;
    const bands: PlacementBand[] = [];
    if (body) bands.push(body);
    if (validBand(input.card)) bands.push(inset(input.card));
    bands.push(screen);
    // The field must stay visible in the body (and on the screen) after a scroll; no scroll outside a dialog
    // body, nor before the list's height is known.
    const keep = validBand(input.bounds) && measured
        ? { top: Math.max(input.viewportTop, input.bounds.top), bottom: Math.min(input.viewportTop + input.viewportHeight, input.bounds.bottom) }
        : null;

    let pick: Placed | null = null;
    for (const band of bands) {
        if (band.bottom <= band.top) continue;
        pick = wholeIn(input, band, want, keep);
        if (pick) break;
    }

    // Over its label (whole, on the screen): only once nothing beside the field fits the whole list.
    const label = labelOf(input);
    if (!pick && label !== null) {
        const anchor = trigger.top - DROPDOWN_COVER_GAP;
        if (anchor - viewTop >= want) pick = { side: "over-label", anchor, space: anchor - viewTop, shift: 0 };
    }

    // Clamped: the roomier side, inside the dialog body when that leaves DROPDOWN_MIN_BOUNDED or more.
    if (!pick) {
        const roomiest = (band: PlacementBand) => sides(input, band, 0).reduce((best, c) => (c.space > best.space ? c : best));
        const inside = body && body.bottom > body.top ? roomiest(body) : null;
        pick = { ...(inside && inside.space >= DROPDOWN_MIN_BOUNDED ? inside : roomiest(screen)), shift: 0 };
    }
    const maxHeight = Math.max(0, Math.floor(Math.min(DROPDOWN_MAX_HEIGHT, pick.space)));

    // Horizontally: the trigger's width and left edge, kept inside the visible viewport.
    let width = trigger.width;
    let left = trigger.left;
    if (typeof input.viewportWidth === "number" && input.viewportWidth > 0) {
        const vLeft = (input.viewportLeft || 0) + DROPDOWN_EDGE;
        const vRight = (input.viewportLeft || 0) + input.viewportWidth - DROPDOWN_EDGE;
        width = Math.max(0, Math.min(width, vRight - vLeft));
        left = Math.min(Math.max(left, vLeft), vRight - width);
    }

    const scrollBy = pick.shift;
    return pick.side === "below"
        ? { side: "below", left: Math.round(left), width: Math.round(width), top: Math.round(pick.anchor), maxHeight, scrollBy }
        : { side: pick.side, left: Math.round(left), width: Math.round(width), bottom: Math.round(input.layoutHeight - pick.anchor), maxHeight, scrollBy };
}

/** The visible viewport and layout height of this window (browser only). */
export function measureViewport(): Pick<DropdownPlacementInput, "viewportTop" | "viewportHeight" | "viewportLeft" | "viewportWidth" | "layoutHeight"> {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const layoutHeight = (typeof document !== "undefined" && document.documentElement?.clientHeight) || window.innerHeight;
    return {
        viewportTop: vv ? vv.offsetTop : 0,
        viewportHeight: vv ? vv.height : window.innerHeight,
        viewportLeft: vv ? vv.offsetLeft : 0,
        viewportWidth: vv ? vv.width : window.innerWidth,
        layoutHeight,
    };
}
