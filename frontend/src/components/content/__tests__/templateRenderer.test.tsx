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

    // ── the container wrapper ──────────────────────────────────────────────────────────────────────
    //
    // A prop that validates and does nothing is a defect in this contract, so these assert the DOM,
    // not the props: the chosen element must actually be the one that renders, and the theme's class
    // must actually appear next to the framework's.

    it('renders the element the template chose, for every tag and every container', () => {
        for (const tag of ['article', 'aside', 'div', 'footer', 'header', 'section']) {
            const html = render([{ type: 'Section', props: { tag, items: [slot] } }]);
            expect(html.startsWith(`<${tag} class="wp-block-section"`), `${tag}: ${html.slice(0, 80)}`).toBe(true);
            expect(html).toContain('wp-block-section__inner'); // the inner wrapper is untouched
        }
        // The other three containers default to <div> and must honour the prop just the same.
        expect(render([{ type: 'Grid', props: { tag: 'header', columns: 2, items: [slot] } }]))
            .toMatch(/^<header class="wp-block-grid"/);
        expect(render([{ type: 'FlexRow', props: { tag: 'footer', items: [slot] } }]))
            .toMatch(/^<footer class="wp-block-flex-row"/);
        expect(render([{ type: 'Columns', props: { tag: 'aside', columns: 2, items: [slot] } }]))
            .toMatch(/^<aside class="wp-block-columns"/);
    });

    it('keeps each container default when no tag is given', () => {
        expect(render([{ type: 'Section', props: { items: [slot] } }])).toMatch(/^<section /);
        expect(render([{ type: 'Grid', props: { items: [slot] } }])).toMatch(/^<div /);
        expect(render([{ type: 'FlexRow', props: { items: [slot] } }])).toMatch(/^<div /);
        expect(render([{ type: 'Columns', props: { items: [slot] } }])).toMatch(/^<div /);
    });

    it("APPENDS the theme's class — the framework's own hook always survives", () => {
        const html = render([{
            type: 'Section', props: {
                tag: 'header', className: 'site-hero brand',
                items: [{ type: 'Grid', props: { columns: 2, className: 'cards', items: [slot] } }],
            },
        }]);
        // Framework class FIRST, theme's appended. If it ever replaced instead, every .wp-block-*
        // selector, token and stylesheet rule would come off the element at once.
        expect(html).toContain('class="wp-block-section site-hero brand"');
        expect(html).toContain('class="wp-block-grid cards"');
        // …and the slot wrapper the grid layout lives on is untouched by the theme's class.
        expect(html).toContain('class="wp-block-grid__items"');
    });

    it('drops a malformed className rather than emitting it — these components also get _puck_data', () => {
        // ContentRenderer and puckConfig spread AUTHOR-controlled `_puck_data` into these same
        // components, and the write-side sanitizer does not touch a structural prop. So the block must
        // be fail-closed on its own, not merely downstream of parseTemplate. Hand-built for that
        // reason: parseTemplate would (and does, in its own suite) reject all of this first.
        const template = {
            content: [{
                type: 'Section',
                props: {
                    tag: 'script',                       // not in the closed set
                    className: 'hero" onclick="alert(1)', // tries to close the attribute
                    items: [slot],
                },
            }],
        } as any;
        const html = renderToStaticMarkup(
            React.createElement(TemplateRenderer, { template, children: content }),
        );
        expect(html).not.toContain('<script');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('alert(1)');
        // Falls back to the block's own element and its own class, alone.
        expect(html).toMatch(/^<section class="wp-block-section"/);
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
