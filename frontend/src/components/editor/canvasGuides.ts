/**
 * Canvas guide helpers for the Puck editor iframe (`.puck-container iframe`).
 *
 * Both helpers operate on the CANVAS document (pass `iframe.contentDocument`), never on the
 * editor chrome's document. Every root element of a block inside the canvas carries the
 * `data-puck-component="<blockId>"` attribute (set by the fork's DraggableComponent), which is
 * what the outline mode targets and what the a11y audit uses to map an element back to a block.
 *
 * SSR-safe: no `window`/`document` access at module scope — everything hangs off the `doc` param.
 */

const GUIDES_STYLE_ID = "wjs-guides";
const OVERLAY_ID = "wjs-spacing-overlay";

/**
 * Toggle "guides" mode: a 1px dashed outline around every block in the canvas, turning solid on
 * hover. Injects (or removes) a single <style id="wjs-guides"> in the canvas document. Idempotent:
 * calling with the same `on` twice is a no-op.
 */
export function setOutlineMode(doc: Document, on: boolean, blockAttr = "data-puck-component"): void {
    if (!doc || !doc.documentElement) return;
    const existing = doc.getElementById(GUIDES_STYLE_ID);
    if (!on) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const style = doc.createElement("style");
    style.id = GUIDES_STYLE_ID;
    // !important so the outline survives the page's own theme CSS (the canvas renders the site's
    // real stylesheets). outline never affects layout, so blocks don't shift when toggling.
    // Colour is BRIGHT indigo on purpose: the canvas shows the site's real theme, which is as
    // likely to be near-black as near-white — the original dark-indigo-at-55% was invisible on
    // dark themes (user-reported). #818cf8 reads clearly on both.
    // `blockAttr` is the engine's block-root attribute: default is the legacy fork's
    // data-puck-component (unchanged callers); the Verso editor passes data-wjs-block-id.
    style.textContent = [
        `[${blockAttr}]{outline:1px dashed #818cf8 !important;outline-offset:-1px;}`,
        `[${blockAttr}]:hover{outline:1px solid #6366f1 !important;}`,
    ].join("\n");
    (doc.head || doc.documentElement).appendChild(style);
}

const PADDING_FILL = "rgba(96,99,238,.18)";
const PADDING_LABEL = "#3730a3";
const MARGIN_FILL = "rgba(217,119,6,.15)";
const MARGIN_LABEL = "#92400e";

/**
 * Paint (or clear, with `el === null`) a spacing overlay for the given canvas element: soft
 * indigo boxes over its padding, soft amber boxes over its margin, each with a tiny px label.
 *
 * Implementation: a `#wjs-spacing-overlay` absolutely-positioned container appended to the canvas
 * body, children placed via getBoundingClientRect + the document's scroll offsets. The whole
 * overlay is `pointer-events:none`, so it never interferes with selection or drag.
 *
 * Stateless and idempotent — each call clears the previous overlay and repaints. The integrator
 * calls it on selection change and on scroll/resize of the canvas.
 */
/**
 * The element whose spacing is actually worth measuring. The block ROOT ([data-puck-component])
 * is dnd scaffolding with zero padding/margin — the author's box (Appearance padding, the block's
 * own p-*) lives a level or two down. Descend through sole-child wrappers (incl. the shared
 * display:contents wrapper) until something has real spacing; a genuinely spacing-less block
 * (Divider…) stays as-is and simply paints no bands.
 */
function spacingTarget(win: Window, el: Element): Element {
    const SIDES = [
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
        "marginTop", "marginRight", "marginBottom", "marginLeft",
    ] as const;
    let cur: Element = el;
    for (let depth = 0; depth < 4; depth++) {
        const cs = win.getComputedStyle(cur);
        if (SIDES.some((p) => parseFloat(cs[p]) > 0)) return cur;
        if (cur.childElementCount !== 1 || !cur.firstElementChild) return cur;
        cur = cur.firstElementChild;
    }
    return cur;
}

export function showSpacingOverlay(doc: Document, el: Element | null): void {
    if (!doc) return;
    doc.getElementById(OVERLAY_ID)?.remove();
    if (!el || !doc.body || typeof el.getBoundingClientRect !== "function") return;
    const win = doc.defaultView;
    if (!win) return;
    el = spacingTarget(win, el);

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return; // detached / display:none
    const cs = win.getComputedStyle(el);
    const num = (v: string): number => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
    };
    const pad = { t: num(cs.paddingTop), r: num(cs.paddingRight), b: num(cs.paddingBottom), l: num(cs.paddingLeft) };
    const mar = { t: num(cs.marginTop), r: num(cs.marginRight), b: num(cs.marginBottom), l: num(cs.marginLeft) };
    const bor = {
        t: num(cs.borderTopWidth),
        r: num(cs.borderRightWidth),
        b: num(cs.borderBottomWidth),
        l: num(cs.borderLeftWidth),
    };

    // Absolute document coordinates (the container sits at the doc origin, so children scroll
    // with the page content for free until the next repaint).
    const sx = win.scrollX || doc.documentElement.scrollLeft || 0;
    const sy = win.scrollY || doc.documentElement.scrollTop || 0;
    const left = rect.left + sx;
    const top = rect.top + sy;

    const container = doc.createElement("div");
    container.id = OVERLAY_ID;
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
        "position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483000;";

    const box = (x: number, y: number, w: number, h: number, fill: string): void => {
        if (w <= 0 || h <= 0) return;
        const d = doc.createElement("div");
        d.style.cssText =
            `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
            `background:${fill};pointer-events:none;`;
        container.appendChild(d);
    };
    const label = (cx: number, cy: number, value: number, fg: string): void => {
        if (value < 1) return;
        const d = doc.createElement("div");
        d.textContent = `${Math.round(value)}px`;
        d.style.cssText =
            `position:absolute;left:${cx}px;top:${cy}px;transform:translate(-50%,-50%);` +
            `font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${fg};` +
            "background:rgba(255,255,255,.85);padding:0 3px;border-radius:3px;white-space:nowrap;" +
            "pointer-events:none;";
        container.appendChild(d);
    };

    // ── Margin bands (outside the border box; negative margins are skipped) ──
    if (mar.t > 0) {
        box(left - Math.max(mar.l, 0), top - mar.t, rect.width + Math.max(mar.l, 0) + Math.max(mar.r, 0), mar.t, MARGIN_FILL);
        label(left + rect.width / 2, top - mar.t / 2, mar.t, MARGIN_LABEL);
    }
    if (mar.b > 0) {
        box(left - Math.max(mar.l, 0), top + rect.height, rect.width + Math.max(mar.l, 0) + Math.max(mar.r, 0), mar.b, MARGIN_FILL);
        label(left + rect.width / 2, top + rect.height + mar.b / 2, mar.b, MARGIN_LABEL);
    }
    if (mar.l > 0) {
        box(left - mar.l, top, mar.l, rect.height, MARGIN_FILL);
        label(left - mar.l / 2, top + rect.height / 2, mar.l, MARGIN_LABEL);
    }
    if (mar.r > 0) {
        box(left + rect.width, top, mar.r, rect.height, MARGIN_FILL);
        label(left + rect.width + mar.r / 2, top + rect.height / 2, mar.r, MARGIN_LABEL);
    }

    // ── Padding bands (inside the border box; left/right bands sit between top/bottom ones so
    //    the corners aren't painted twice) ──
    const ix = left + bor.l;
    const iy = top + bor.t;
    const iw = rect.width - bor.l - bor.r;
    const ih = rect.height - bor.t - bor.b;
    if (pad.t > 0) {
        box(ix, iy, iw, pad.t, PADDING_FILL);
        label(ix + iw / 2, iy + pad.t / 2, pad.t, PADDING_LABEL);
    }
    if (pad.b > 0) {
        box(ix, iy + ih - pad.b, iw, pad.b, PADDING_FILL);
        label(ix + iw / 2, iy + ih - pad.b / 2, pad.b, PADDING_LABEL);
    }
    const midY = iy + pad.t;
    const midH = ih - pad.t - pad.b;
    if (pad.l > 0) {
        box(ix, midY, pad.l, midH, PADDING_FILL);
        label(ix + pad.l / 2, iy + ih / 2, pad.l, PADDING_LABEL);
    }
    if (pad.r > 0) {
        box(ix + iw - pad.r, midY, pad.r, midH, PADDING_FILL);
        label(ix + iw - pad.r / 2, iy + ih / 2, pad.r, PADDING_LABEL);
    }

    doc.body.appendChild(container);
}
