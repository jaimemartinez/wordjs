"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable descendants of `root` a keyboard user can actually reach (rendered, not disabled). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * The keyboard contract of a modal dialog, for a panel that already carries role="dialog" +
 * aria-modal: on open, focus moves INTO the panel (`initialFocus`, else its first focusable control)
 * and remembers who opened it; Tab and Shift+Tab cycle inside it; Escape calls `onClose`; on close,
 * focus goes back to the opener.
 *
 * Without it the «New user» dialog left focus on the button behind the backdrop and Tab walked the
 * sidebar under the veil, Escape did nothing, and closing the posts' delete dialog dropped focus on
 * <body> instead of the trash button that opened it.
 */
export function useDialogFocus(
    panelRef: RefObject<HTMLElement | null>,
    { open = true, onClose, initialFocus }: { open?: boolean; onClose: () => void; initialFocus?: RefObject<HTMLElement | null> },
): void {
    // The latest onClose without re-running the effect (callers pass inline arrows).
    const closeRef = useRef(onClose);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);

    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        // After paint: the panel portals to <body> and may still be mounting its children.
        const focusTimer = setTimeout(() => {
            const panel = panelRef.current;
            if (!panel || panel.contains(document.activeElement)) return;
            const target = initialFocus?.current ?? focusableIn(panel)[0] ?? panel;
            if (target === panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
            target.focus();
        }, 20);

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeRef.current();
                return;
            }
            const panel = panelRef.current;
            if (e.key !== "Tab" || !panel) return;
            const items = focusableIn(panel);
            if (!items.length) { e.preventDefault(); return; }
            const first = items[0], last = items[items.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const outside = !active || !panel.contains(active);
            if (e.shiftKey && (outside || active === first)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (outside || active === last)) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
            clearTimeout(focusTimer);
            document.removeEventListener("keydown", onKeyDown);
            if (opener && opener.isConnected) opener.focus();
        };
        // initialFocus is a ref: reading .current inside the timer is the point.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, panelRef]);
}
