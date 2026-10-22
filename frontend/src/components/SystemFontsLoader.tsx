"use client";

import { useEffect } from "react";
import { apiGet, isHostNotAllowed } from "@/lib/api";
import { buildFontFaceCss, type WjsFont } from "@/lib/fontFaceCss";

/**
 * Whether a failed /fonts read is worth reporting. Two refusals are expected and are not font failures,
 * so neither is surfaced (either would also raise the dev error overlay): during first-run setup the API
 * answers "not installed", and on an address the site does not serve it answers 421, which the root
 * layout's HostNotAllowedNotice already explains to the visitor.
 */
export function isFontLoadFailure(error: unknown): boolean {
    if (isHostNotAllowed(error)) return false;
    return !/not installed/i.test((error as { message?: string } | null)?.message || '');
}

/**
 * Whether this page needs the faces fetched in the browser. A public page already carries them from the
 * server (RootDocument's #wjs-server-fonts, cached and purged when a font is uploaded or deleted), so a
 * visitor's browser does not fetch them again (QA S2-08). The admin still refreshes them: a font uploaded
 * there is used without a reload.
 */
export function needsClientFonts(hasServerFonts: boolean, pathname: string): boolean {
    return !hasServerFonts || pathname === "/admin" || pathname.startsWith("/admin/");
}

// Client-side @font-face injector. The public <head> already carries these faces from SSR (see
// app/_root/RootDocument.tsx) so first paint is correct; this refreshes them on the client to pick up fonts
// uploaded after the SSR cache window and to cover the admin editor. Uses the SAME builder as SSR so
// the declarations are identical (no divergence in weight/format between server and client).
export function SystemFontsLoader() {
    useEffect(() => {
        if (!needsClientFonts(!!document.getElementById("wjs-server-fonts"), window.location.pathname)) return;
        const loadFonts = async () => {
            try {
                // Use apiGet wrapper which handles auth and base URL
                const fonts = await apiGet<WjsFont[]>('/fonts');

                const css = buildFontFaceCss(fonts);
                if (css) {
                    const styleId = 'system-fonts-loader';
                    let styleEl = document.getElementById(styleId);

                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = styleId;
                        document.head.appendChild(styleEl);
                    }

                    styleEl.textContent = css;
                }

            } catch (error: unknown) {
                if (isFontLoadFailure(error)) console.error("Failed to load system fonts:", error);
            }
        };

        loadFonts();
    }, []);

    return null;
}
