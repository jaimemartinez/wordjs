import { describe, it, expect } from 'vitest';
import { buildFontFaceCss } from '../fontFaceCss';

/**
 * buildFontFaceCss output is written RAW into an SSR <style> element (app/layout.tsx), so a font
 * family or URL must not be able to close the CSS string or the <style> element.
 */
describe('buildFontFaceCss', () => {
    it('emits a normal @font-face rule unchanged', () => {
        expect(buildFontFaceCss([{ family: 'Inter', variant: 'Bold Italic', url: '/fonts/Inter-BoldItalic.woff2' }]))
            .toBe("@font-face{font-family:'Inter';src:url('/fonts/Inter-BoldItalic.woff2') format('woff2');font-weight:700;font-style:italic;font-display:swap;}");
    });

    it('strips characters that could break out of the string literal or the <style> element', () => {
        const css = buildFontFaceCss([
            { family: "</style><script>alert(1)</script>", url: '/fonts/a.woff2' },
            { family: 'Evil\\27 ;}body{x', url: "/fonts/b.woff2');}</style><img src=x onerror=alert(1)>" },
            { family: 'Line\nBreak', url: '/fonts/c.ttf\r\n' },
        ]);
        expect(css).not.toMatch(/[<>\\]/);
        expect(css).not.toContain('</style');
        expect(css.split('\n')).toHaveLength(3); // one rule per font, no injected line breaks
        // Each value stays inside its own '...' literal: exactly the quotes the template adds.
        for (const rule of css.split('\n')) {
            expect((rule.match(/'/g) || []).length).toBe(rule.includes("format('") ? 6 : 4);
        }
        expect(css).toContain("font-family:'/stylescriptalert(1)/script'");
    });
});
