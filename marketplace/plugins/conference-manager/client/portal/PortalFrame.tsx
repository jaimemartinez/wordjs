// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

import React from "react";
import { PORTAL_COARSE_FIELDS_CSS, PORTAL_SHORT_SHEET_CSS } from "./portalCss";

/**
 * The frame of every page of the conference portal (it was the core's app/portal/conference/layout.tsx).
 * viewport-fit=cover (the manifest's portalPage.viewportFit): without it every env(safe-area-inset-*) is 0 on
 * iOS, and the coordinator portal's bottom sheets (their footers, «Enviar pago») and the «n seleccionadas» bar
 * could not keep clear of the home indicator. With it the page may reach under a landscape notch, so the content
 * is padded by the side insets here (0 on every other screen); fixed sheets and bars pad themselves.
 */
export default function PortalFrame({ children }: { children: React.ReactNode }) {
    return (
        <div style={{ paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }} data-portal-safe-area="">
            {/* 16 px fields on any touch screen (portalCss.ts): an iPhone held sideways is past the phone width. */}
            <style>{PORTAL_COARSE_FIELDS_CSS}</style>
            {/* Compact sheets on a short screen (portalCss.ts): an iPhone held sideways keeps room for the form. */}
            <style>{PORTAL_SHORT_SHEET_CSS}</style>
            {children}
        </div>
    );
}
