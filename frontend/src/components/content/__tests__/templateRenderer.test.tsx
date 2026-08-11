import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplateRenderer } from '../TemplateRenderer';
import { parseTemplate, CONTENT_SLOT } from '@/lib/templateData';

/**
 * A theme's page template, rendered.
 *
 * These go through parseTemplate first and render the SHIPPED component with the real server renderer,
 * so they cover the pair as it actually runs: a tree the validator accepts must render, and the markup
 * it produces must be the markup a PAGE produces — same classes, same `--wjs-*` custom properties —
 * because that identity is the only reason a theme's tokens reach a template at all.
 */

const slot = { type: CONTENT_SLOT, props: {} };
const content = React.createElement('article', { id: 'page-content' }, 'the page');

function render(tree: unknown): string {
    const t = parseTemplate(JSON.stringify({ content: tree }));
    expect(t, 'the fixture must be a VALID template, or this asserts nothing').not.toBeNull();
    return renderToStaticMarkup(React.createElement(TemplateRenderer, { template: t!, children: content }));
}

describe('TemplateRenderer', () => {
    it('renders the page content exactly once, inside the arrangement', () => {
        const html = render([{ type: 'Section', props: { maxWidth: '72rem', items: [slot] } }]);
        expect(html.match(/id="page-content"/g)).toHaveLength(1);
        // …and INSIDE the section, not merely somewhere on the page.
        expect(html).toMatch(/<section[^>]*wp-block-section[\s\S]*id="page-content"[\s\S]*<\/section>/);
    });

    it('emits the same markup a page emits, so theme tokens apply unchanged', () => {
        const html = render([{
            type: 'Section', props: {
                maxWidth: '72rem', padding: '3rem', background: '#fafafa',
                items: [{ type: 'Grid', props: { columns: 3, gap: '2rem', items: [slot] } }],
            },
        }]);
        expect(html).toContain('wp-block-section__inner');
        // Grid puts the layout on the SLOT's wrapper — if that regressed, every child would stack into
        // track 1 and the columns would be silently empty.
        expect(html).toContain('wp-block-grid__items');
        // The props must arrive as the contract's custom properties, not as ad-hoc inline CSS.
        expect(html).toMatch(/--wjs-section-max-width:\s*72rem/);
        expect(html).toMatch(/--wjs-grid-columns:\s*3/);
    });

    it('spreads Columns children round-robin instead of dropping them', () => {
        const html = render([{
            type: 'Columns', props: {
                columns: 2, gap: '1rem',
                items: [slot, { type: 'Spacer', props: { height: '1rem' } }, { type: 'Divider', props: { color: '#eee' } }],
            },
        }]);
        expect(html.match(/wp-block-columns__col/g)).toHaveLength(2);
        // All three children present: the content, the spacer and the divider.
        expect(html).toContain('id="page-content"');
        expect(html).toMatch(/--wjs-spacer-height/);
        expect(html.match(/wp-block-(divider|separator)|wjs-divider/)).not.toBeNull();
    });

    it('renders every leaf the contract allows', () => {
        const html = render([
            { type: 'Spacer', props: { height: '5rem' } },
            { type: 'Divider', props: { color: '#000', width: '2px' } },
            slot,
        ]);
        expect(html).toMatch(/--wjs-spacer-height:\s*5rem/);
        expect(html).toContain('id="page-content"');
    });

    it('survives a validator/renderer drift instead of taking the page down', () => {
        // Hand-built (parseTemplate would reject it): if the two contracts ever diverge, an unknown
        // block must render as nothing, not throw and 500 the whole public page.
        const template = { content: [{ type: 'FutureBlock', props: {} }, slot] } as any;
        const html = renderToStaticMarkup(
            React.createElement(TemplateRenderer, { template, children: content }),
        );
        expect(html).toContain('id="page-content"');
        expect(html).not.toContain('FutureBlock');
    });
});
