import type { Viewport } from "next";
import { PORTAL_COARSE_FIELDS_CSS, PORTAL_SHORT_SHEET_CSS } from "./portalCss";

// viewport-fit=cover (as the admin's layout): without it every env(safe-area-inset-*) is 0 on iOS, and the
// coordinator portal's bottom sheets (their footers, «Enviar pago») and the «n seleccionadas» bar could not
// keep clear of the home indicator. Next merges this key into the default `width=device-width,
// initial-scale=1`. With it the page may reach under a landscape notch, so the content is padded by the side
// insets here (0 on every other screen); fixed sheets and bars pad themselves.
export const viewport: Viewport = {
    viewportFit: "cover",
};

export default function ConferencePortalLayout({ children }: { children: React.ReactNode }) {
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
