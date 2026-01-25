"use client";

import { useEffect } from "react";
import { apiGet } from "@/lib/api";

export function SystemFontsLoader() {
    useEffect(() => {
        const loadFonts = async () => {
            try {
                // Use apiGet wrapper which handles auth and base URL
                const fonts = await apiGet<any[]>('/fonts');

                // Group fonts by family
                const fontStyles: string[] = [];

                fonts.forEach((font: any) => {
                    let fontWeight = '400'; // Default Regular
                    let fontStyle = 'normal';
                    let fontFamily = font.family;

                    // Generic weight/style mapping
                    const variantLower = font.variant ? font.variant.toLowerCase() : '';

                    if (variantLower.includes('thin')) fontWeight = '100';
                    else if (variantLower.includes('extra light') || variantLower.includes('extralight')) fontWeight = '200';
                    else if (variantLower.includes('light')) fontWeight = '300';
                    else if (variantLower.includes('medium')) fontWeight = '500';
                    else if (variantLower.includes('semi bold') || variantLower.includes('semibold')) fontWeight = '600';
                    else if (variantLower.includes('extra bold') || variantLower.includes('extrabold')) fontWeight = '800';
                    else if (variantLower.includes('black')) fontWeight = '900';
                    else if (variantLower.includes('bold')) fontWeight = '700';

                    if (variantLower.includes('italic')) fontStyle = 'italic';

                    fontStyles.push(`
                        @font-face {
                            font-family: '${fontFamily}';
                            src: url('${font.url}') format('truetype');
                            font-weight: ${fontWeight};
                            font-style: ${fontStyle};
                            font-display: swap;
                        }
                    `);
                });

                if (fontStyles.length > 0) {
                    const styleId = 'system-fonts-loader';
                    let styleEl = document.getElementById(styleId);

                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = styleId;
                        document.head.appendChild(styleEl);
                    }

                    styleEl.textContent = fontStyles.join('\n');
                }

            } catch (error) {
                console.error("Failed to load system fonts:", error);
            }
        };

        loadFonts();
    }, []);

    return null;
}
