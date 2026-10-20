/**
 * Browser-side paging (2.18.0) — the pure arithmetic behind every `Pager` of the plugin: the inscription
 * tables (one pager per location card), «Pagos de cuotas › Pagos» and «Saldos».
 *
 * Owner decision D2: 20 rows per page, with a «Mostrar 10 / 20 / 50 / 100» choice remembered per device
 * (localStorage, every access guarded: a private window or blocked storage just falls back to 20).
 * The core portal keeps the same API in its own participants.ts (a parity test runs both on the same
 * vectors when both exist).
 */

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
/** Where the admin remembers its «Mostrar N» choice (per device). */
export const PAGE_SIZE_KEY = 'cm:insc:pageSize';

/** Any value → one of PAGE_SIZES (20 when it is not one of them). */
export const normalizePageSize = (v: unknown): number => {
    const n = Number(v);
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
};

/** Pages needed for `total` rows (at least 1, so «1 / 1» is shown for an empty list). */
export const pageCount = (total: number, size: number): number =>
    Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / normalizePageSize(size)));

/** A page number inside 1 … pageCount (after a delete the last page may have gone). */
export const clampPage = (page: number, total: number, size: number): number => {
    const p = Math.floor(Number(page) || 1);
    return Math.min(Math.max(1, p), pageCount(total, size));
};

/** The rows of `page` (clamped). */
export function pageSlice<T>(rows: readonly T[], page: number, size: number): T[] {
    const list = Array.isArray(rows) ? rows : [];
    const s = normalizePageSize(size);
    const p = clampPage(page, list.length, s);
    return list.slice((p - 1) * s, p * s);
}

/** «21–40 de 183»: the 1-based first and last row shown, and the total ({ from: 0, to: 0 } when empty). */
export const rangeOf = (page: number, size: number, total: number): { from: number; to: number; total: number } => {
    const t = Math.max(0, Math.floor(Number(total) || 0));
    if (!t) return { from: 0, to: 0, total: 0 };
    const s = normalizePageSize(size);
    const p = clampPage(page, t, s);
    return { from: (p - 1) * s + 1, to: Math.min(t, p * s), total: t };
};

/**
 * The numbered window of a desktop pager: the first and last page, the current one and its neighbours,
 * '…' for each gap. pageWindow(6, 20) → [1, '…', 5, 6, 7, '…', 20]. A gap of one page shows the page.
 */
export function pageWindow(current: number, count: number, radius = 1): (number | '…')[] {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const c = Math.min(Math.max(1, Math.floor(Number(current) || 1)), n);
    const keep = new Set<number>([1, n]);
    for (let i = c - radius; i <= c + radius; i++) if (i >= 1 && i <= n) keep.add(i);
    const pages = [...keep].sort((a, b) => a - b);
    const out: (number | '…')[] = [];
    for (let i = 0; i < pages.length; i++) {
        if (i > 0) {
            const gap = pages[i] - pages[i - 1];
            if (gap === 2) out.push(pages[i] - 1);
            else if (gap > 2) out.push('…');
        }
        out.push(pages[i]);
    }
    return out;
}

/** Changing the page size keeps the first visible row on screen: floor((page-1)·old/new) + 1. */
export const pageAfterResize = (page: number, oldSize: number, newSize: number): number => {
    const o = normalizePageSize(oldSize), n = normalizePageSize(newSize);
    const p = Math.max(1, Math.floor(Number(page) || 1));
    return Math.floor(((p - 1) * o) / n) + 1;
};

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const local = (): StorageLike | null => {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** The device's «Mostrar N» (20 when nothing usable is stored or storage is blocked). */
export function readPageSize(key = PAGE_SIZE_KEY, store: StorageLike | null = local()): number {
    try { return normalizePageSize(store ? store.getItem(key) : null); } catch { return DEFAULT_PAGE_SIZE; }
}
/** Remember the device's «Mostrar N»; a storage failure is ignored (the choice still applies now). */
export function writePageSize(size: number, key = PAGE_SIZE_KEY, store: StorageLike | null = local()): void {
    try { if (store) store.setItem(key, String(normalizePageSize(size))); } catch { /* private mode / blocked */ }
}

/** The pieces of a browser window the scrolling below reads (a fake one in the tests). */
type ScrollWin = {
    matchMedia?: (q: string) => { matches: boolean };
    getComputedStyle?: (el: any) => { overflowY?: string; scrollMarginTop?: string };
    scrollTo?: (o: { top: number; behavior?: string }) => void;
    scrollY?: number;
    document?: { scrollingElement?: any; documentElement?: any; body?: any };
};
type ScrollEl = { parentElement?: any; getBoundingClientRect?: () => { top: number }; scrollTop?: number; scrollHeight?: number; clientHeight?: number; clientTop?: number; scrollTo?: (o: { top: number; behavior?: string }) => void };
const browserWin = (): ScrollWin | null => (typeof window !== 'undefined' ? (window as unknown as ScrollWin) : null);

/**
 * The element's nearest ancestor that really scrolls vertically (overflow-y auto / scroll with more content
 * than room) — the conference panel on a desktop, the admin's content column on a phone — or null for the
 * page itself. An `overflow: hidden` ancestor never counts: it is not meant to scroll.
 */
export function scrollParentOf(el: ScrollEl | null | undefined, win: ScrollWin | null = browserWin()): ScrollEl | null {
    if (!el || !win || typeof win.getComputedStyle !== 'function') return null;
    const doc = win.document || {};
    for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
        let oy = '';
        try { oy = String(win.getComputedStyle(p).overflowY || ''); } catch { oy = ''; }
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && Number(p.scrollHeight) > Number(p.clientHeight) + 1) return p;
    }
    return null;
}

/**
 * After a page change, bring the list's top (`el`) to the top of ITS scroller — and move only that scroller.
 * Without it a phone stays at the pager and lands at the BOTTOM of the new page. Not scrollIntoView: that
 * also scrolls every `overflow: hidden` ancestor, and on a desktop it slid the whole conference screen up
 * under the admin header — its title and tabs gone, a blank band below, nothing able to scroll them back.
 * The element's `scroll-margin-top` is kept above it (a sticky bar there). Smooth, or instant under
 * prefers-reduced-motion or `instant`. A no-op outside a browser.
 */
export function scrollToListTop(el: ScrollEl | null | undefined, win: ScrollWin | null = browserWin(), opts: { instant?: boolean } = {}): boolean {
    if (!el || !win || typeof el.getBoundingClientRect !== 'function') return false;
    let reduce = !!opts.instant;
    try { reduce = reduce || !!(typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { /* old browser */ }
    const behavior = reduce ? 'auto' : 'smooth';
    let margin = 0;
    try { margin = parseFloat(String(win.getComputedStyle ? win.getComputedStyle(el).scrollMarginTop : 0)) || 0; } catch { margin = 0; }
    const top = el.getBoundingClientRect().top;
    const sc = scrollParentOf(el, win);
    if (sc && typeof sc.getBoundingClientRect === 'function') {
        const target = Math.max(0, Number(sc.scrollTop || 0) + top - (sc.getBoundingClientRect().top + Number(sc.clientTop || 0)) - margin);
        if (typeof sc.scrollTo === 'function') { try { sc.scrollTo({ top: target, behavior }); return true; } catch { /* old browser */ } }
        sc.scrollTop = target;
        return true;
    }
    const target = Math.max(0, Number(win.scrollY || 0) + top - margin);
    if (typeof win.scrollTo === 'function') { try { win.scrollTo({ top: target, behavior }); return true; } catch { /* old browser */ } }
    return false;
}

/**
 * How far to scroll down so a card that FITS its scroller's view is seen whole (px; 0 = nothing to do): its
 * bottom in view, its top never above `marginTop` (a sticky bar there). A card taller than the view is left
 * as it is. The desktop review queue: a short payment (cash, no receipt) opened at its top a little taller
 * than the panel, and the decision bar pinned to the bottom (sticky) sat over its «Historial» until the panel
 * was scrolled — scrolled whole, the bar is at its own place under the history.
 */
export function revealWholeDelta(card: { top: number; bottom: number }, view: { top: number; bottom: number }, marginTop = 0): number {
    const room = view.bottom - (view.top + marginTop);
    if (!(card.bottom > view.bottom + 0.5) || card.bottom - card.top > room) return 0;
    return Math.max(0, Math.min(card.bottom - view.bottom, card.top - (view.top + marginTop)));
}
/**
 * The nearest ancestor of `el` that is a vertical scroll box (overflow-y auto / scroll / overlay) — whether or
 * not it overflows right now (scrollParentOf needs it to) — or null for the page. The box the review queue's
 * columns must fit in.
 */
export function scrollBoxOf(el: ScrollEl | null | undefined, win: ScrollWin | null = browserWin()): ScrollEl | null {
    if (!el || !win || typeof win.getComputedStyle !== 'function') return null;
    const doc = win.document || {};
    for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
        let oy = '';
        try { oy = String(win.getComputedStyle(p).overflowY || ''); } catch { oy = ''; }
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
    }
    return null;
}
/** The review queue's sticky offset under the section tabs (FEES_CSS `top: 4.5rem`). */
export const QUEUE_STICKY_TOP_PX = 72;
/**
 * How tall the review queue's columns may be (px): the scroll box's content height under the sticky offset —
 * a sticky element stops at its scroller's padding edge, so both paddings come off — never below 240 px.
 */
export const queueRoomPx = (box: { clientHeight: number; padTop: number; padBottom: number }, stickyTopPx = QUEUE_STICKY_TOP_PX): number =>
    Math.max(240, Math.floor(Number(box.clientHeight) - Number(box.padTop || 0) - Number(box.padBottom || 0) - stickyTopPx));

/** Apply revealWholeDelta to `el` in its scroller (instant). True when it scrolled. */
export function revealWhole(el: ScrollEl | null | undefined, win: ScrollWin | null = browserWin()): boolean {
    if (!el || !win || typeof el.getBoundingClientRect !== 'function') return false;
    let margin = 0;
    try { margin = parseFloat(String(win.getComputedStyle ? win.getComputedStyle(el).scrollMarginTop : 0)) || 0; } catch { margin = 0; }
    const r = el.getBoundingClientRect() as { top: number; bottom?: number; height?: number };
    const card = { top: r.top, bottom: r.bottom != null ? r.bottom : r.top + Number(r.height || 0) };
    const sc = scrollParentOf(el, win);
    if (sc && typeof sc.getBoundingClientRect === 'function') {
        const top = sc.getBoundingClientRect().top + Number(sc.clientTop || 0);
        const d = revealWholeDelta(card, { top, bottom: top + Number(sc.clientHeight || 0) }, margin);
        if (d <= 0) return false;
        sc.scrollTop = Number(sc.scrollTop || 0) + d;
        return true;
    }
    const w = win as unknown as { innerHeight?: number; scrollY?: number; scrollTo?: (o: { top: number; behavior?: string }) => void };
    const d = revealWholeDelta(card, { top: 0, bottom: Number(w.innerHeight || 0) }, margin);
    if (d <= 0 || typeof w.scrollTo !== 'function') return false;
    try { w.scrollTo({ top: Number(w.scrollY || 0) + d, behavior: 'auto' }); return true; } catch { return false; }
}

/**
 * A page change of one of several lists that share a scroller (the location cards of «Inscripciones»):
 * `request(key)` when the page changes, `flush(lookup)` once the new page has RENDERED (an effect keyed on
 * the pages) scrolls that list's CARD — `lookup(key)`, the card's own element — back to the top of the
 * scroller, once. Never the card's header: it is `position: sticky` (ROSTER_CSS), so while the pager at the
 * bottom of the card is on screen the header is already stuck at the top (its own position says nothing of
 * where the card begins) — and the card then shrinks to the new page, leaving the screen inside the NEXT
 * location's card.
 */
export function pagedScroll() {
    let pending: string | null = null;
    return {
        request(key: string) { pending = key; },
        flush(lookup: (key: string) => ScrollEl | null | undefined, win?: ScrollWin | null): boolean {
            if (pending == null) return false;
            const key = pending;
            pending = null;
            return win === undefined ? scrollToListTop(lookup(key)) : scrollToListTop(lookup(key), win);
        },
    };
}
