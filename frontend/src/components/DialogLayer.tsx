"use client";

import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { ADMIN_Z, type DialogLayerName } from "@/lib/adminLayers";

/**
 * The writing direction a portalled dialog keeps. A portal leaves the admin's `<div dir="ltr">` wrapper
 * (app/admin/layout.tsx), so without this an admin dialog on a right-to-left site would flip while the
 * screen behind it does not. DashboardLayoutClient provides the admin's direction; outside it (the public
 * site) a dialog inherits <html dir> as before.
 */
export const DialogDirectionContext = createContext<"ltr" | "rtl" | undefined>(undefined);

/**
 * The full-screen layer every core dialog renders in (its backdrop and the card inside it).
 *
 * Before, each dialog was a `fixed inset-0 z-50` div rendered inside the page — under the admin shell
 * (lib/adminLayers.ts: phone header z-5000, sidebar z-5002, collapse toggle z-5003). On a phone the
 * «Nuevo usuario» dialog opened UNDER the header, its top edge and close button cut off; on a desktop
 * the sidebar was not dimmed and its collapse toggle sat on the dialog's corner. A fixed element inside
 * the page can also be trapped by any ancestor's stacking context or transform (an entrance animation
 * is enough).
 *
 * DialogLayer is portalled to <body>, and positioned (fixed, inset 0) and stacked INLINE, at:
 *   - `dialog` (6000): a dialog, drawer or full-screen blocker opened from a page;
 *   - `dialogOver` (6100): one that opens over another dialog or a plugin overlay — confirm/alert
 *     (useModal), a secret shown once, the media picker.
 * Toasts (9999) stay above both. Dropdowns opened inside (ModernSelect, ui/Select) portal at 6500.
 *
 * The caller keeps its own look: backdrop colour, blur, alignment and padding go in `className`, and
 * every other div attribute (onClick, onKeyDown, role…) passes through. Outside a browser (server
 * render, unit tests) there is no <body> to portal to, so it renders in place — never render a dialog
 * open in server HTML.
 */
export interface DialogLayerProps extends React.HTMLAttributes<HTMLDivElement> {
    layer?: DialogLayerName;
}

export default function DialogLayer({ layer = "dialog", style, children, dir, ...rest }: DialogLayerProps) {
    const inheritedDir = useContext(DialogDirectionContext);
    const node = (
        <div
            data-wjs-dialog-layer={layer}
            dir={dir ?? inheritedDir}
            {...rest}
            style={{ ...style, position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: ADMIN_Z[layer] }}
        >
            {children}
        </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(node, document.body) : node;
}
