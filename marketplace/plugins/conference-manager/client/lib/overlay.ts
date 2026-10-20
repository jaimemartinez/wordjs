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

/**
 * Named layers (2.18.0). The person sheet (⋮) is layer 1; what it opens sits above it: a dialog (edit, room,
 * «Registrar pago», a payment) at 2, the receipt lightbox at 3, a confirm at 4 — so a confirm is never
 * hidden under the sheet that asked for it.
 */
export const LAYER = Object.freeze({ sheet: 1, modal: 2, lightbox: 3, confirm: 4 });

// ── Escape: only the TOPMOST overlay closes ───────────────────────────────────────────────────────────
type EscapeEntry = { fn: () => unknown };
const escapeStack: EscapeEntry[] = [];
let escapeListening = false;

/**
 * Register an overlay's Escape handler; returns its release. The last one registered (the overlay opened
 * last, i.e. on top) is the only one Escape reaches. One keydown listener on the document, added the first
 * time it is needed (no DOM access at module level). A handler that returns `false` did not handle the key:
 * nothing else in the stack runs either (an overlay without Escape on top of a sheet must not close the
 * sheet), but the key is left alone (not prevented) for that overlay's own listener, if it has one.
 */
export function pushEscape(fn: () => unknown): () => void {
    const entry: EscapeEntry = { fn };
    escapeStack.push(entry);
    if (!escapeListening && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        escapeListening = true;
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            // Escape typed in a filled text field is the field's (a search box clears itself): never the sheet's.
            if (fieldKeepsEscape(e.target, Date.now())) return;
            if (handleEscape()) e.preventDefault();
        });
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const i = escapeStack.indexOf(entry);
        if (i >= 0) escapeStack.splice(i, 1);
    };
}
/** Text-like inputs: Escape in one of them while it holds text belongs to the field. */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number', 'password']);
/** Does `target` (an event target) hold text the user typed — a text input, a textarea, an editable region? */
export function isFilledField(target: unknown): boolean {
    const t = target as { tagName?: unknown; type?: unknown; value?: unknown; isContentEditable?: unknown; textContent?: unknown } | null;
    if (!t || typeof t !== 'object') return false;
    const tag = String(t.tagName || '').toLowerCase();
    if (tag === 'textarea') return String(t.value ?? '') !== '';
    if (tag === 'input') return TEXT_INPUTS.has(String(t.type ?? '').toLowerCase()) && String(t.value ?? '') !== '';
    if (t.isContentEditable === true) return String(t.textContent ?? '').trim() !== '';
    return false;
}
let fieldEscape: { el: unknown; at: number } | null = null;
/** How long a second Escape in the same filled field counts as «I meant it» (the sheet closes then). */
export const SECOND_ESCAPE_MS = 1500;
/**
 * 2.18.0 review: Escape typed INSIDE a field closed the sheet around it and threw its draft away — the
 * admin clearing the picker's search box lost the people, the split and the compressed receipt. Escape in
 * a field that holds text is the field's (a search box clears itself; a text box keeps its text): the
 * overlay stack is not run. A second Escape in the same field within SECOND_ESCAPE_MS — or one in an
 * empty field — goes to the sheet as before (whose own handler asks before discarding a draft).
 * Returns true when the key belongs to the field.
 */
export function fieldKeepsEscape(target: unknown, now: number): boolean {
    if (!isFilledField(target)) { fieldEscape = null; return false; }
    if (fieldEscape && fieldEscape.el === target && now - fieldEscape.at <= SECOND_ESCAPE_MS) { fieldEscape = null; return false; }
    fieldEscape = { el: target, at: now };
    return true;
}

/** Run the topmost overlay's Escape handler; false when no overlay is open or the top one did not handle it. */
export function handleEscape(): boolean {
    const top = escapeStack[escapeStack.length - 1];
    if (!top) return false;
    return top.fn() !== false;
}
/**
 * A popover's light dismiss: a press (pointerdown, capture) anywhere outside `root` closes it — the admin
 * sidebar included, which sits above any click-catcher the page can lay over itself. Returns the release.
 */
export function dismissOnOutside(
    doc: { addEventListener: (t: string, h: (e: any) => void, c?: boolean) => void; removeEventListener: (t: string, h: (e: any) => void, c?: boolean) => void } | null | undefined,
    root: { contains: (n: any) => boolean } | null | undefined,
    onClose: () => void,
): () => void {
    if (!doc || typeof doc.addEventListener !== 'function') return () => { };
    const h = (e: any) => {
        const t = e && e.target;
        if (root && t && typeof root.contains === 'function' && root.contains(t)) return;
        onClose();
    };
    doc.addEventListener('pointerdown', h, true);
    return () => doc.removeEventListener('pointerdown', h, true);
}

/** How many overlays listen for Escape right now (tests, debugging). */
export const escapeDepth = (): number => escapeStack.length;

/**
 * What an overlay focuses when it opens: its dialog (`role="dialog"` / `"alertdialog"`, which carries the
 * name — aria-labelledby — a screen reader announces: «Ficha de Ana Pérez, diálogo»), else the overlay
 * itself. The caller makes the dialog focusable (tabIndex -1) when it is not.
 */
export function dialogFocusTarget<T extends { querySelector(sel: string): unknown }>(outer: T): T {
    const d = outer.querySelector('[role="dialog"], [role="alertdialog"]');
    return (d as T) || outer;
}

/** The focusable elements inside an overlay, in DOM order (for the Tab trap). */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * The Tab trap: from the last focusable Tab goes to the first, from the first Shift+Tab goes to the last.
 * Returns the element to focus, or null when the browser's own move stays inside.
 */
export function trapTarget<T>(items: T[], active: T | null, shift: boolean): T | null {
    if (!items.length) return null;
    const i = active == null ? -1 : items.indexOf(active);
    if (shift) return i <= 0 ? items[items.length - 1] : null;
    return i === -1 || i === items.length - 1 ? items[0] : null;
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

/**
 * The overlay's scroll padding from its pinned rows' REAL heights (px; null = not measured): a focused field is
 * scrolled clear of the pinned header and footer, plus 8 px. A fixed 6rem lost against a footer that wraps
 * («Cancelar» / «✓ Registrar pago $250.000,00» on an iPhone SE: 133 px, 165 px with its issue line): the
 * focused «Monto total» sat under it. Overlay measures both rows (ResizeObserver) into --cm-head-h / --cm-foot-h.
 */
export function sheetScrollPadding(headPx: number | null | undefined, footPx: number | null | undefined): { top: string; bottom: string } {
    const px = (v: number | null | undefined, fallback: string) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${Math.ceil(v) + 8}px` : fallback);
    return { top: px(headPx, '6.5rem'), bottom: px(footPx, '6rem') };
}

// ── a focused field, whole in sight (2.18.0 live round 4) ─────────────────────────────────────────────
type VBox = { top: number; bottom: number };
/**
 * How far (px; positive = down) an overlay must scroll so a focused field is WHOLE inside `area` with `margin`
 * around it; 0 when it already is. A field taller than the area lines up with its top.
 *
 * The browser's own reveal (a tap, the keyboard opening, typing) only brings the CARET line inside the
 * scroll padding: in the admin «Registrar pago» on an iPhone SE a field tapped just above the pinned footer and
 * typed into kept its bottom border under the footer (4 px), the two-row «Nota» 28 px; on an iPhone held
 * sideways (no pinned footer) fields stayed 12–36 px below the screen's edge.
 */
export function revealFieldDelta(field: VBox, area: VBox, margin = 8): number {
    const room = area.bottom - area.top - 2 * margin;
    if (!(room > 0)) return 0;
    if (field.bottom - field.top > room) return Math.round(field.top - (area.top + margin));
    if (field.bottom + margin > area.bottom) return Math.round(field.bottom + margin - area.bottom);
    if (field.top - margin < area.top) return Math.round(field.top - margin - area.top);
    return 0;
}
/**
 * Where a focused field may sit in an overlay: its own box, under its pinned header and above its pinned
 * footer (each only while pinned), and inside the visual viewport (what the on-screen keyboard leaves).
 */
export function visibleFieldArea(outer: VBox, head: VBox | null, foot: VBox | null, viewport: VBox | null): VBox {
    let top = outer.top;
    let bottom = outer.bottom;
    if (head) top = Math.max(top, head.bottom);
    if (foot) bottom = Math.min(bottom, foot.top);
    if (viewport) { top = Math.max(top, viewport.top); bottom = Math.min(bottom, viewport.bottom); }
    return { top, bottom };
}
const TYPING_INPUTS = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'time', 'month']);
/** A field the keyboard types into (an input of a text-like type, a textarea, a select). */
export function isTypingField(el: unknown): boolean {
    const t = el as { tagName?: unknown; type?: unknown } | null;
    if (!t || typeof t !== 'object') return false;
    const tag = String(t.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    return tag === 'input' && TYPING_INPUTS.has(String(t.type ?? '').toLowerCase());
}
type RectEl = { getBoundingClientRect: () => VBox; contains?: (n: unknown) => boolean; firstElementChild?: RectEl | null; getAttribute?: (name: string) => string | null; id?: string };
type OverlayEl = RectEl & { scrollTop: number; querySelector: (sel: string) => RectEl | null };
type RevealWin = { getComputedStyle?: (el: unknown) => { position?: string }; visualViewport?: { offsetTop: number; height: number } | null };
/**
 * The box to reveal for a focused field: its own, joined with the boxes of what DESCRIBES it (aria-describedby)
 * inside the overlay — a split part's «Supera lo que falta: máximo $X» under the field, «Usar lo que falta: $X»
 * under «Monto total». Revealing the field alone (+ 8 px) left that line under the pinned footer while the admin
 * typed the amount it refuses (2.18.0 review PUX-1). An empty describer (no text, no height) adds nothing.
 */
export function describedBox(outer: OverlayEl, field: RectEl): VBox {
    const own = field.getBoundingClientRect();
    let top = own.top;
    let bottom = own.bottom;
    const ids = typeof field.getAttribute === 'function' ? String(field.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => /^[\w:.-]+$/.test(id)) : [];
    for (const id of ids) {
        let el: RectEl | null = null;
        try { el = outer.querySelector(`[id="${id}"]`); } catch { el = null; }
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        const r = el.getBoundingClientRect();
        if (!(r.bottom > r.top)) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
    }
    return { top, bottom };
}

/**
 * Scroll overlay `outer` so its focused `field` is whole in sight (revealFieldDelta / visibleFieldArea): clear
 * of the pinned header and footer (data-cm-sheet-foot) and above the keyboard — together with the lines that
 * describe it (describedBox). A field of the footer itself is left alone. Returns the scroll applied (px).
 * Overlay runs it on focus and when the keyboard resizes the view; a sheet runs it again when a field's
 * describing line changes (revealFocused).
 */
export function revealFocusedField(outer: OverlayEl | null | undefined, field: RectEl | null | undefined, win: RevealWin | null | undefined): number {
    if (!outer || !field || typeof field.getBoundingClientRect !== 'function' || typeof outer.getBoundingClientRect !== 'function') return 0;
    const pinned = (el: RectEl | null | undefined) => {
        if (!el || !win || typeof win.getComputedStyle !== 'function') return false;
        try { return win.getComputedStyle(el).position === 'sticky'; } catch { return false; }
    };
    const inside = (el: RectEl | null | undefined) => !!el && (el === field || (typeof el.contains === 'function' && el.contains(field)));
    const foot = outer.querySelector('[data-cm-sheet-foot]');
    if (inside(foot)) return 0;
    const inner = outer.querySelector('[data-cm-overlay-inner]');
    const card = inner ? inner.firstElementChild || null : null;
    const head = card ? card.firstElementChild || null : null;
    const vv = win && win.visualViewport ? { top: win.visualViewport.offsetTop, bottom: win.visualViewport.offsetTop + win.visualViewport.height } : null;
    const area = visibleFieldArea(
        outer.getBoundingClientRect(),
        head && !inside(head) && pinned(head) ? head.getBoundingClientRect() : null,
        foot && pinned(foot) ? foot.getBoundingClientRect() : null,
        vv,
    );
    const d = revealFieldDelta(describedBox(outer, field), area);
    if (!d) return 0;
    outer.scrollTop = Number(outer.scrollTop || 0) + d;
    return d;
}

/**
 * Reveal the focused field of the overlay it is in, again (revealFocusedField) — for a sheet whose field's
 * describing line just changed under the user's fingers (a split part turning over its «máximo»): the overlay
 * only reveals on focus and on a keyboard resize. `match` picks which focused fields qualify. Returns the scroll.
 */
export function revealFocused(doc: { activeElement?: unknown } | null | undefined, win: RevealWin | null | undefined, match: (el: { id?: string }) => boolean = () => true): number {
    const el = doc ? (doc.activeElement as (RectEl & { closest?: (sel: string) => unknown }) | null | undefined) : null;
    if (!el || !isTypingField(el) || !match(el) || typeof el.closest !== 'function') return 0;
    const outer = el.closest('[data-cm-overlay]') as OverlayEl | null;
    return outer ? revealFocusedField(outer, el, win) : 0;
}

/**
 * Bring `el` — a message a sheet just wrote (the person sheet's notice of what «Eliminar» / «Cancelar inscripción» /
 * «Reactivar» did) — whole into sight in the overlay it is in, clear of the pinned header and footer and above the
 * keyboard (revealFocusedField's area; a message taller than that area lines up with its top). On a phone the sheet
 * opens at its top and such a message renders at the end of its body, right above the pinned buttons: a refused
 * «Eliminar» showed NOTHING until the admin scrolled to the end (2.18.0 review UX6-1). Outside an overlay the
 * browser's own scrollIntoView. Returns the overlay's scroll applied (px).
 */
export function revealInOverlay(el: (RectEl & { closest?: (sel: string) => unknown; scrollIntoView?: (o?: unknown) => void }) | null | undefined, win: RevealWin | null | undefined): number {
    if (!el) return 0;
    const outer = typeof el.closest === 'function' ? (el.closest('[data-cm-overlay]') as OverlayEl | null) : null;
    if (outer) return revealFocusedField(outer, el, win);
    try { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' }); } catch { /* old browser */ }
    return 0;
}

/** True with a fine pointer (mouse / trackpad); false on touch screens and outside a browser. */
export function canAutoFocus(): boolean {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    } catch {
        return false;
    }
}

/** The fields a coarse-pointer rule sets to 16px (text-like controls; a big text-lg+ field keeps its size). */
const FIELD_SEL = ':is(input, select, textarea):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([class*="text-lg"]):not([class*="text-xl"]):not([class*="text-2xl"]):not([class*="text-3xl"]):not([class*="text-4xl"])';
/**
 * 16px fields under `scope` on every touch screen (pointer: coarse): iOS zooms the page into a focused field
 * under 16px, and an iPhone held sideways (667–932 px) is past every width-based phone rule. Unlayered: it wins
 * over `sm:text-sm` / `text-xs`. Shared by OVERLAY_CSS, ROSTER_CSS and FEES_CSS.
 */
export const COARSE_FIELDS_CSS = (scope: string): string => `@media (pointer: coarse) {
  ${scope} ${FIELD_SEL} { font-size: 16px; }
}`;

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
 * A sheet taller than the screen scrolls with the overlay (an iPhone SE: «Crear conferencia», «Nuevo campo»,
 * the inscription form…), and its title and close button went off the top while its buttons started below
 * the bottom. Below 640px — and on a short touch screen, a phone held sideways (PINNED_ROWS_CSS) — its header
 * (the card's first child) is pinned to the top of the overlay and its
 * footer (`data-cm-sheet-foot`, the row of Cancel / Save) to the bottom, both opaque — the footer padded by
 * at least the bottom safe-area inset, so mid-scroll its buttons never sit in the home-indicator zone of a
 * full-screen iPhone (viewport-fit=cover); a card with
 * `overflow-hidden` is clipped with `overflow: clip` instead, which keeps the rounded corners without making
 * the card the scroller the pinned rows would be held in. A browser without `overflow: clip` keeps the
 * card as it was. The overlay's scroll padding keeps a focused field from being scrolled under either
 * pinned row (the keyboard's "scroll into view" honours it) — the rows' measured heights (sheetScrollPadding),
 * so a footer that wraps never covers the focused field. A footer marked `data-cm-foot-grid` (Cancel + the
 * main button) keeps ONE row: Cancel at its width, the main button takes the rest and wraps its own label;
 * its issue line (`data-foot-issue`) spans the row above. Nothing changes from 640px up.
 *
 * Fields are 16px on any TOUCH screen (pointer: coarse), whatever its width: an iPhone held sideways is
 * 667–932 px wide, past the phone rules, and iOS zooms the page into any focused field under 16px.
 *
 * At every width, a card capped at `max-h-[92vh]` (the receipt at `max-h-[90vh]`) is capped by the
 * DYNAMIC viewport instead: on iOS Safari and Chrome Android `vh` is the LARGE viewport (toolbar hidden),
 * the admin document never scrolls so the toolbar never hides, and a 92vh card came out taller than the
 * 100dvh overlay — its footer, Guardar included, started below the screen. On a desktop dvh == vh; a
 * browser without dvh drops the declaration and keeps the class's vh.
 *
 * A SHORT screen (below 500 px of height: an iPhone held sideways, 390 px) compacts the big paddings too — they
 * are chosen by WIDTH, and sideways a phone is past 640 px: «Nuevo ingreso» of «Contabilidad» (p-8, px-8 py-6)
 * left its form a sliver between its header and its footer — and a capped card may take the whole height.
 */
/**
 * A sheet's pinned rows (see OVERLAY_CSS): the header (title, ✕) at the top and the footer (the main button and
 * the line that says why it is disabled) at the bottom, both opaque; the card clipped (not a scroller) so they
 * stick to the overlay; the measured scroll padding. Applied below 640 px of width AND on a short touch screen —
 * a phone held sideways (667–932 × ~390 px) is past every width rule: there the whole card scrolled, «Registrar
 * pago»'s footer and its reason sat a screen or two below the fields, and the ✕ scrolled away (2.18.0 PUX-3).
 */
const PINNED_ROWS_CSS = `  [data-cm-sheet] > [data-cm-overlay-inner] > .overflow-hidden { overflow: clip; }
  [data-cm-sheet] > [data-cm-overlay-inner] > * > :first-child { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20; }
  [data-cm-sheet] > [data-cm-overlay-inner] > * > :first-child:not([class*="bg-"]) { background-color: #fff; }
  [data-cm-sheet] > [data-cm-overlay-inner] > * > .bg-gray-50\\/50:first-child { background-color: #fcfdfd; }
  [data-cm-sheet] [data-cm-sheet-foot] { position: sticky; bottom: 0; z-index: 20; background-color: #fff; padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px)); }
  [data-cm-sheet] { scroll-padding-top: calc(var(--cm-head-h, 6.5rem) + env(safe-area-inset-top, 0px)); scroll-padding-bottom: var(--cm-foot-h, 6rem); }`;
/** A phone held sideways: short AND touch (a short desktop window keeps its layout). */
export const SHORT_TOUCH_MEDIA = '(max-height: 500px) and (pointer: coarse)';
/** Does `win` match SHORT_TOUCH_MEDIA now (false outside a browser)? */
export function isShortTouch(win: { matchMedia?: (q: string) => { matches: boolean } } | null | undefined): boolean {
    try { return !!(win && typeof win.matchMedia === 'function' && win.matchMedia(SHORT_TOUCH_MEDIA).matches); } catch { return false; }
}

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
${PINNED_ROWS_CSS}
  [data-cm-sheet] [data-cm-foot-grid] { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; }
  [data-cm-sheet] [data-cm-foot-grid] > [data-foot-issue] { grid-column: 1 / -1; }
  [data-cm-sheet] [data-cm-foot-grid] > [data-foot-main] { min-width: 0; white-space: normal; justify-content: center; text-align: center; }
  [data-cm-overlay] :is(.p-10, .p-8) { padding: 1.25rem; }
  [data-cm-overlay] :is(.px-10, .px-8) { padding-left: 1.25rem; padding-right: 1.25rem; }
  [data-cm-overlay] .py-8 { padding-top: 1.25rem; padding-bottom: 1.25rem; }
}
@media ${SHORT_TOUCH_MEDIA} {
${PINNED_ROWS_CSS}
}
@media (max-height: 500px) {
  [data-cm-overlay] .max-h-\\[92vh\\] { max-height: calc(100dvh - 1rem); }
  [data-cm-overlay] :is(.p-10, .p-8) { padding: 1rem 1.25rem; }
  [data-cm-overlay] :is(.px-10, .px-8) { padding-left: 1.25rem; padding-right: 1.25rem; }
  [data-cm-overlay] :is(.py-8, .py-6) { padding-top: 0.75rem; padding-bottom: 0.75rem; }
}
${COARSE_FIELDS_CSS('[data-cm-overlay]')}
`;
