"use client";

// The preview device the chrome editor canvas is showing (desktop / tablet / phone). The canvas
// iframe is resized to the device width, so the public blocks' own breakpoints (the nav's hamburger,
// a row that stacks) react for real; this context only tells the editor's block wrappers which of the
// per-breakpoint "hide on …" flags applies, so a block hidden on that device is drawn dimmed — still
// visible and selectable — instead of vanishing from under the author's cursor.
import { createContext, useContext } from "react";
import { DEVICE_WIDTHS } from "@/components/verso/canvas/viewport";

export type ChromeDevice = "desktop" | "tablet" | "phone";

/**
 * The canvas viewport per device — the SAME widths the page editor previews at
 * (components/verso/canvas/viewport.ts): 1280 / 768 / 375, so each one sits inside the site's real
 * breakpoint band (desktop ≥ 1024, tablet 768–1023, phone < 768). The canvas is rendered at that width
 * and scaled down to fit the card, never squeezed: "Desktop" always shows the desktop layout.
 */
export const DEVICE_WIDTH: Record<ChromeDevice, number> = {
    desktop: DEVICE_WIDTHS.desktop,
    tablet: DEVICE_WIDTHS.tablet,
    phone: DEVICE_WIDTHS.mobile,
};

export const ChromeDeviceContext = createContext<ChromeDevice>("desktop");

const FLAG: Record<ChromeDevice, "hideDesktop" | "hideTablet" | "hideMobile"> = {
    desktop: "hideDesktop",
    tablet: "hideTablet",
    phone: "hideMobile",
};

export function useHiddenOnDevice(props: Record<string, unknown>): boolean {
    const device = useContext(ChromeDeviceContext);
    return props[FLAG[device]] === true;
}

// Root props of the composition (sticky / transparent / width), read by the root wrapper so the canvas
// shows the header the way the public layout will lay it out.
export interface ChromeEditorRoot {
    transparent?: boolean;
    overlayText?: "light" | "dark";
    width?: "container" | "full";
}
export const ChromeRootContext = createContext<ChromeEditorRoot>({});
