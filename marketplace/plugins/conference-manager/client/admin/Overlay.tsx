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
 * Usage: replace the old backdrop div — `<Overlay layer={1} onBackdrop={onClose}>{card}</Overlay>`.
 * `layer`: 1 = the old z-100, 2 = z-110, 3 = z-120, 4 = z-130. `sheet={false}` for content that is not a
 * white card (the receipt lightbox): it stays centred with a margin on every screen.
 */
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { OVERLAY_CSS, lockBodyScroll, overlayZ } from "../lib/overlay";

export function Overlay({ layer = 1, backdrop = 'rgba(0,0,0,0.6)', sheet = true, onBackdrop, className = 'backdrop-blur-sm animate-in fade-in duration-200', style, children, ...rest }: any) {
    const outerRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const downOnBackdrop = useRef(false);
    useEffect(() => lockBodyScroll(), []);
    const isBackdrop = (t: EventTarget | null) => !!t && (t === outerRef.current || t === innerRef.current);
    const node = (
        <div
            ref={outerRef}
            data-cm-overlay=""
            data-cm-sheet={sheet ? '' : undefined}
            className={className}
            style={{
                position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, height: '100dvh',
                zIndex: overlayZ(layer), background: backdrop,
                overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
                ...style,
            }}
            onPointerDown={(e) => { downOnBackdrop.current = isBackdrop(e.target); }}
            onClick={(e) => {
                const close = downOnBackdrop.current && isBackdrop(e.target);
                downOnBackdrop.current = false;
                if (close && onBackdrop) onBackdrop();
            }}
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
