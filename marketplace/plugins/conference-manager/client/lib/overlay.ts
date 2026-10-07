/**
 * Overlays on a phone (2.15.1) — the helpers behind `client/admin/Overlay.tsx` and the meal scanner.
 *
 * - `overlayZ(layer)`: the plugin's modals live in the 6000 band, above the admin chrome (mobile header
 *   z-5000, sidebar z-5002, its toggle z-5003) and below the toasts (z-9999). They used to be z-100…130
 *   inside the page, so on a phone the create-conference form opened UNDER the sticky header. The old
 *   relative order is kept: layer 1 = z-100 (a modal), 2 = z-110 (a modal over a page modal, a
 *   lightbox), 3 = z-120 (a confirm over those), 4 = z-130.
 * - `lockBodyScroll()`: iOS ignores `overflow: hidden` on <body> — the page behind an overlay kept
 *   rubber-banding (the admin header "moved down when dragging"). The body is pinned with
 *   position: fixed at -scrollY and restored (scroll position included) when the LAST lock is released;
 *   overscroll chaining is switched off on <html>/<body> meanwhile. Reference counted: a confirm over a
 *   modal, or the scanner over a page, release in any order.
 * - `canAutoFocus()`: an input focused when a dialog opens pops the on-screen keyboard on a phone, which
 *   shrinks the visible viewport to the top of the form. Only a fine pointer (mouse) autofocuses.
 * - `OVERLAY_CSS`: the phone rules every overlay carries in its own <style> (plugin Tailwind classes are
 *   not guaranteed to exist on a live site; the host's own CSS only has the classes the host uses).
 *
 * No DOM access at module level; the functions take `document` / `window` from the global scope only
 * when called.
 */

export const OVERLAY_BASE_Z = 6000;

/** z-index of an overlay `layer` (1-9) in the 6000 band, preserving the old z-100…z-130 order. */
export function overlayZ(layer = 1): number {
    const n = Math.max(1, Math.min(9, Math.round(Number(layer) || 1)));
    return OVERLAY_BASE_Z + 10 * n;
}

type Saved = { y: number; body: Record<string, string>; html: Record<string, string> };
let locks = 0;
let saved: Saved | null = null;
const BODY_PROPS = ['position', 'top', 'left', 'right', 'width', 'overflow', 'overscrollBehavior'] as const;

/** Pin the page behind an overlay; returns the release function (idempotent). */
export function lockBodyScroll(): () => void {
    if (typeof document === 'undefined' || !document.body) return () => { };
    const body = document.body.style as unknown as Record<string, string>;
    const html = document.documentElement.style as unknown as Record<string, string>;
    if (locks === 0) {
        const y = (typeof window !== 'undefined' && (window.scrollY || window.pageYOffset)) || 0;
        saved = { y, body: {}, html: { overscrollBehavior: html.overscrollBehavior || '' } };
        for (const p of BODY_PROPS) saved.body[p] = body[p] || '';
        body.position = 'fixed';
        body.top = `-${y}px`;
        body.left = '0';
        body.right = '0';
        body.width = '100%';
        body.overflow = 'hidden';
        body.overscrollBehavior = 'none';
        html.overscrollBehavior = 'none';
    }
    locks++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        locks = Math.max(0, locks - 1);
        if (locks > 0 || !saved) return;
        const s = saved;
        saved = null;
        for (const p of BODY_PROPS) body[p] = s.body[p];
        html.overscrollBehavior = s.html.overscrollBehavior;
        try { if (typeof window !== 'undefined' && s.y) window.scrollTo(0, s.y); } catch { /* not scrollable */ }
    };
}

/** True with a fine pointer (mouse / trackpad); false on touch screens and outside a browser. */
export function canAutoFocus(): boolean {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    } catch {
        return false;
    }
}

/**
 * Phone rules shared by every overlay (`[data-cm-overlay]`). Unlayered on purpose: they win over the
 * Tailwind utilities (which sit in @layer utilities) without !important — except where an inline style
 * must be overridden from 640px up.
 *
 * Below 640px a sheet (`[data-cm-sheet]`) is anchored to the bottom edge, full width, square bottom
 * corners, extended under the home indicator; inputs are at least 16px (iOS zooms the page into any
 * smaller field on focus); date/time inputs may shrink (iOS gives them an intrinsic width that pushed
 * the create-conference dates out of the card); the big desktop paddings are compacted. From 640px the
 * card is centred with a margin.
 *
 * At every width, a card capped at `max-h-[92vh]` (the receipt at `max-h-[90vh]`) is capped by the
 * DYNAMIC viewport instead: on iOS Safari and Chrome Android `vh` is the LARGE viewport (toolbar hidden),
 * the admin document never scrolls so the toolbar never hides, and a 92vh card came out taller than the
 * 100dvh overlay — its footer, Guardar included, started below the screen. On a desktop dvh == vh; a
 * browser without dvh drops the declaration and keeps the class's vh.
 */
export const OVERLAY_CSS = `
[data-cm-overlay] .max-h-\\[92vh\\] { max-height: calc(92dvh - env(safe-area-inset-top, 0px)); }
[data-cm-overlay] .max-h-\\[90vh\\] { max-height: 90dvh; }
@media (min-width: 640px) {
  [data-cm-overlay-inner] { align-items: center !important; padding: 1rem !important; }
}
@media (max-width: 639.98px) {
  [data-cm-sheet] > [data-cm-overlay-inner] > * {
    width: 100%; margin: 0;
    border-bottom-left-radius: 0; border-bottom-right-radius: 0;
    border-bottom: env(safe-area-inset-bottom, 0px) solid #fff;
  }
  [data-cm-overlay] :is(input, select, textarea):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([class*="text-lg"]):not([class*="text-xl"]):not([class*="text-2xl"]):not([class*="text-3xl"]):not([class*="text-4xl"]) { font-size: 16px; }
  [data-cm-overlay] input:is([type="date"], [type="datetime-local"], [type="time"], [type="month"]) {
    min-width: 0; max-width: 100%; min-height: 3rem; -webkit-appearance: none; appearance: none;
  }
  [data-cm-overlay] :is(.p-10, .p-8) { padding: 1.25rem; }
  [data-cm-overlay] :is(.px-10, .px-8) { padding-left: 1.25rem; padding-right: 1.25rem; }
  [data-cm-overlay] .py-8 { padding-top: 1.25rem; padding-bottom: 1.25rem; }
}
`;
