/**
 * Shared @font-face CSS builder for WordJS-installed fonts.
 *
 * Pure (no "use client", no server-only imports) so BOTH the server component that injects font faces
 * into the SSR <head> (so custom fonts are present on first paint — see app/layout.tsx) AND the client
 * SystemFontsLoader use the exact same declarations. Before this, faces were injected only client-side
 * in a useEffect, so a public page's first paint had the inline `font-family` but no matching face —
 * the element fell back to the theme font until hydration (and permanently if client JS was blocked).
 */

export interface WjsFont {
    filename?: string;
    family: string;
    variant?: string;
    url: string;
}

// Map a variant label (parsed from the font filename by the /fonts route) to a numeric font-weight.
// Order matters: compound tokens are tested before the simple token they contain ("extra light" before
// "light", "semi bold"/"extra bold" before "bold").
function weightFromVariant(variant: string): string {
    const v = (variant || '').toLowerCase();
    if (v.includes('thin')) return '100';
    if (v.includes('extra light') || v.includes('extralight')) return '200';
    if (v.includes('light')) return '300';
    if (v.includes('medium')) return '500';
    if (v.includes('semi bold') || v.includes('semibold')) return '600';
    if (v.includes('extra bold') || v.includes('extrabold')) return '800';
    if (v.includes('black')) return '900';
    if (v.includes('bold')) return '700';
    return '400'; // Regular / unlabelled
}

// Derive the @font-face format() hint from the file extension. Emitting a hardcoded format('truetype')
// for a non-TTF file is at best a lie the browser ignores (it content-sniffs) and at worst rejected by
// strict engines — derive the correct hint, or omit it for unknown extensions (matching the editor,
// which injects faces with no hint at all).
function formatFromUrl(url: string): string {
    const ext = (url || '').split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || '';
    switch (ext) {
        case 'woff2': return 'woff2';
        case 'woff': return 'woff';
        case 'otf': case 'ttc': return 'opentype';
        case 'ttf': return 'truetype';
        case 'eot': return 'embedded-opentype';
        default: return '';
    }
}

// Characters removed from interpolated values: quotes, backslash, angle brackets and C0 controls.
const UNSAFE_IN_CSS_STRING = /['"\\<>\u0000-\u001f\u007f]/g;

/**
 * Build a block of @font-face rules for every installed font. Returns '' when there are none.
 * The `family`/`variant`/`url` come straight from GET /fonts (the same source the editor's font pickers
 * and SystemFontsLoader use), so the family names match the values stored in block css.fontFamily and
 * in the Tiptap inline `font-family` spans.
 */
export function buildFontFaceCss(fonts: WjsFont[] | null | undefined): string {
    if (!Array.isArray(fonts) || fonts.length === 0) return '';
    const rules: string[] = [];
    for (const font of fonts) {
        // Both values land inside '...' literals of a <style> that the SSR layout writes RAW
        // (dangerouslySetInnerHTML), so strip every character that could end the CSS string (quotes,
        // backslash escapes, newlines/control chars) or the <style> element itself ('<' / '>' — a
        // family named `</style><script>…` would otherwise close the element and inject markup into
        // every public page's <head>). None of these is meaningful in a font family name or a URL.
        const family = String(font?.family || '').replace(UNSAFE_IN_CSS_STRING, '').trim();
        const url = String(font?.url || '').replace(UNSAFE_IN_CSS_STRING, '').trim();
        if (!family || !url) continue;
        const weight = weightFromVariant(font.variant || '');
        const style = /italic/i.test(font.variant || '') ? 'italic' : 'normal';
        const fmt = formatFromUrl(url);
        rules.push(
            `@font-face{font-family:'${family}';src:url('${url}')${fmt ? ` format('${fmt}')` : ''};font-weight:${weight};font-style:${style};font-display:swap;}`
        );
    }
    return rules.join('\n');
}
