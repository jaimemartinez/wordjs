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

// Client-side @font-face injector. The public <head> already carries these faces from SSR (see
// app/layout.tsx) so first paint is correct; this refreshes them on the client to pick up fonts
// uploaded after the SSR cache window and to cover the admin editor. Uses the SAME builder as SSR so
// the declarations are identical (no divergence in weight/format between server and client).
export function SystemFontsLoader() {
    useEffect(() => {
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
