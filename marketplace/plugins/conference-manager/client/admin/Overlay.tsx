// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Overlay (2.15.1) — the backdrop every modal and sheet of the plugin renders in.
 *
 * Before, each modal was a `fixed inset-0 z-[100…130]` div rendered inside the page. On a phone the admin
 * header is a sticky z-5000 bar (and any ancestor with a transform or a z-index traps a fixed child in its
 * stacking context): the create-conference form opened UNDER the header, its title and close button out of
 * reach, its dates pushed out of the card, the keyboard popping over it. `Overlay`:
 *
 * - is portalled to <body>, in the 6000 band (`overlayZ(layer)`: above the admin chrome, below the toasts);
 * - scrolls ITSELF (100dvh, overscroll contained): a card taller than the screen scrolls instead of being
 *   cut, and the safe-centre layout anchors it to the bottom on a phone and centres it from 640px;
 * - pins the page behind it (`lockBodyScroll`: iOS ignores overflow:hidden on <body>);
 * - closes (`onBackdrop`) only on a press that STARTS and ends on the backdrop — releasing a text selection
 *   over it does not close the dialog;
 * - carries its structural styles inline and its phone rules in its own <style> (`OVERLAY_CSS`), so it
 *   works even where the plugin's Tailwind classes were never compiled.
 *
 * 2.18.0 (the person sheet and the payment sheets stack up to four deep):
 * - `onEscape`: Escape closes only the TOPMOST overlay (lib/overlay.ts escape stack). EVERY overlay takes a
 *   slot in that stack, with or without `onEscape`: one that cannot be closed by Escape (a barcode, a
 *   confirm, a sheet that is sending) swallows the key instead of letting it close the sheet underneath;
 * - focus: when it opens, the focus moves into it — onto its dialog (role="dialog" / "alertdialog", whose
 *   name a screen reader then announces), else the container; never an input (a phone would pop its
 *   keyboard) — unless something inside already took it; Tab stays inside; on close the focus goes back to
 *   the control that opened it, or to the first visible match of `returnFocus` (a selector) when that
 *   control is gone (a re-rendered list: the visible ⋮ of the same row).
 *
 * - a focused field comes whole into sight, clear of the pinned header and footer and above the keyboard
 *   (lib/overlay.ts revealFocusedField) — the browser alone only reveals the caret line.
 *
 * Usage: replace the old backdrop div — `<Overlay layer={1} onBackdrop={onClose}>{card}</Overlay>`.
 * `layer`: 1 = the old z-100, 2 = z-110, 3 = z-120, 4 = z-130 (LAYER.sheet / modal / lightbox / confirm).
 * `sheet={false}` for content that is not a white card (the receipt lightbox): centred on every screen.
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE, OVERLAY_CSS, SHORT_TOUCH_MEDIA, dialogFocusTarget, isShortTouch, isTypingField, lockBodyScroll, overlayZ, pushEscape, revealFocusedField, sheetScrollPadding, trapTarget } from "../lib/overlay";

/**
 * A phone held sideways (SHORT_TOUCH_MEDIA), followed live (a rotation). There a sheet pins its header and its
 * footer (OVERLAY_CSS) in ~390 px of height, so a sheet keeps in its pinned header only its title row: the lines
 * under the title (a payment's facts, who recorded and reviewed it; the person's chips) go to the top of the body
 * and scroll with it — pinned, the payment's header took 121 px and left the receipt and the split a 176 px slit
 * between it and the decision bar (2.18.0 review UX6-8). False outside a browser.
 */
export function useShortTouch(): boolean {
    const [short, setShort] = useState(() => (typeof window !== 'undefined' ? isShortTouch(window as any) : false));
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        let mq: any = null;
        try { mq = window.matchMedia(SHORT_TOUCH_MEDIA); } catch { return undefined; }
        const on = () => setShort(!!mq.matches);
        on();
        try { mq.addEventListener('change', on); } catch { try { mq.addListener(on); } catch { /* old browser */ } }
        return () => { try { mq.removeEventListener('change', on); } catch { try { mq.removeListener(on); } catch { /* ignore */ } } };
    }, []);
    return short;
}

export function Overlay({ layer = 1, backdrop = 'rgba(0,0,0,0.6)', sheet = true, onBackdrop, onEscape, returnFocus, className = 'backdrop-blur-sm animate-in fade-in duration-200', style, children, ...rest }: any) {
    const outerRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const downOnBackdrop = useRef(false);
    const escapeRef = useRef(onEscape);
    escapeRef.current = onEscape;
    const returnRef = useRef(returnFocus);
    returnRef.current = returnFocus;
    useEffect(() => lockBodyScroll(), []);
    // Escape → the topmost overlay's own handler only; an overlay without one still holds its slot (it
    // reports «not handled», so the key stays free for a listener of its own, and the sheet below stays).
    useEffect(() => pushEscape(() => (escapeRef.current ? (escapeRef.current(), true) : false)), []);
    // Focus in on open (unless an element inside already has it), back to the opener on close.
    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const opener = document.activeElement as HTMLElement | null;
        const outer = outerRef.current;
        if (outer && !outer.contains(document.activeElement)) {
            const target: any = dialogFocusTarget(outer);
            if (target !== outer && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
            try { target.focus({ preventScroll: true }); } catch { /* old browser */ }
        }
        return () => {
            let target: any = opener && opener !== document.body && opener.isConnected ? opener : null;
            if (!target && returnRef.current) {
                try { target = [...document.querySelectorAll(returnRef.current)].find((el: any) => el.offsetParent !== null) || null; } catch { target = null; }
            }
            if (target && typeof target.focus === 'function') {
                try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
            }
        };
    }, []);
    // The pinned header and footer's real heights → the scroll padding that keeps a focused field clear of
    // them (sheetScrollPadding; OVERLAY_CSS reads --cm-head-h / --cm-foot-h). Re-measured whenever the card
    // changes size: a footer that gains its issue line, a sheet whose content loads later.
    useEffect(() => {
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (!sheet || !outer || !inner || typeof window === 'undefined') return undefined;
        const measure = () => {
            const card = inner.firstElementChild as HTMLElement | null;
            const head = card ? (card.firstElementChild as HTMLElement | null) : null;
            const foot = outer.querySelector('[data-cm-sheet-foot]') as HTMLElement | null;
            const pad = sheetScrollPadding(head ? head.getBoundingClientRect().height : null, foot ? foot.getBoundingClientRect().height : null);
            outer.style.setProperty('--cm-head-h', pad.top);
            outer.style.setProperty('--cm-foot-h', pad.bottom);
        };
        measure();
        let ro: any = null;
        try {
            ro = new ResizeObserver(measure);
            for (const el of [...inner.children]) ro.observe(el);
            const foot = outer.querySelector('[data-cm-sheet-foot]');
            if (foot) ro.observe(foot);
        } catch { window.addEventListener('resize', measure); }
        return () => { if (ro) ro.disconnect(); else window.removeEventListener('resize', measure); };
    }, [sheet]);
    // A focused field comes WHOLE into sight (revealFocusedField): the browser only brings the caret line in, so a
    // field tapped just above the pinned footer kept its border (a two-row «Nota»: its second row) under it, and
    // on a phone held sideways below the screen's edge. After the browser's own scroll (next frame), once more
    // when the keyboard has opened, and whenever the keyboard changes the visible viewport.
    const revealTimer = useRef<any>(null);
    const reveal = (el: any) => {
        if (typeof document === 'undefined' || document.activeElement !== el) return;
        revealFocusedField(outerRef.current as any, el, typeof window !== 'undefined' ? (window as any) : null);
    };
    const onFocus = (e: any) => {
        const el = e.target;
        if (!sheet || !isTypingField(el)) return;
        try { requestAnimationFrame(() => reveal(el)); } catch { reveal(el); }
        clearTimeout(revealTimer.current);
        revealTimer.current = setTimeout(() => reveal(el), 350);
    };
    useEffect(() => {
        const vv: any = typeof window !== 'undefined' ? (window as any).visualViewport : null;
        if (!sheet || !vv || typeof vv.addEventListener !== 'function') return () => clearTimeout(revealTimer.current);
        const onResize = () => {
            const el = document.activeElement;
            if (el && outerRef.current && outerRef.current.contains(el) && isTypingField(el)) reveal(el);
        };
        vv.addEventListener('resize', onResize);
        return () => { vv.removeEventListener('resize', onResize); clearTimeout(revealTimer.current); };
    }, [sheet]);
    const onKeyDown = (e: any) => {
        if (e.key !== 'Tab' || e.defaultPrevented) return;
        const outer = outerRef.current;
        if (!outer || !outer.contains(document.activeElement)) return;
        const items = [...outer.querySelectorAll(FOCUSABLE)].filter((el: any) => el.offsetParent !== null || el === document.activeElement);
        const next = trapTarget(items, document.activeElement, e.shiftKey);
        if (next) { e.preventDefault(); (next as any).focus(); }
        else if (!items.length) e.preventDefault();
    };
    const isBackdrop = (t: EventTarget | null) => !!t && (t === outerRef.current || t === innerRef.current);
    const node = (
        <div
            ref={outerRef}
            data-cm-overlay=""
            data-cm-sheet={sheet ? '' : undefined}
            tabIndex={-1}
            className={className}
            style={{
                position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, height: '100dvh',
                zIndex: overlayZ(layer), background: backdrop,
                overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
                outline: 'none',
                ...style,
            }}
            onPointerDown={(e) => { downOnBackdrop.current = isBackdrop(e.target); }}
            onClick={(e) => {
                const close = downOnBackdrop.current && isBackdrop(e.target);
                downOnBackdrop.current = false;
                if (close && onBackdrop) onBackdrop();
            }}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            {...rest}
        >
            <style>{OVERLAY_CSS}</style>
            <div
                ref={innerRef}
                data-cm-overlay-inner=""
                style={{
                    minHeight: '100%', boxSizing: 'border-box', display: 'flex', justifyContent: 'center',
                    alignItems: sheet ? 'flex-end' : 'center', padding: sheet ? 0 : '1rem',
                }}
            >
                {children}
            </div>
        </div>
    );
    // Outside a browser (server render, tests) there is no <body> to portal to: render in place.
    return typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;
}

export default Overlay;
