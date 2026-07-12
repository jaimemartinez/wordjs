"use client";

import { useEffect } from "react";
import { apiGet } from "@/lib/api";
import { buildFontFaceCss, type WjsFont } from "@/lib/fontFaceCss";

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

            } catch (error: any) {
                // During first-run setup the API legitimately returns "not installed";
                // that's expected, so don't surface it as an error (it would trigger the
                // dev error overlay on the install wizard).
                if (!/not installed/i.test(error?.message || '')) {
                    console.error("Failed to load system fonts:", error);
                }
            }
        };

        loadFonts();
    }, []);

    return null;
}
