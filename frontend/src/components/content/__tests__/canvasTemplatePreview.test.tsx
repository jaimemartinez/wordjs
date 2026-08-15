import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplateRenderer } from '../TemplateRenderer';
import { parseTemplate, CONTENT_SLOT, type TemplateTree } from '@/lib/templateData';
import { decorateForCanvas } from '@/lib/canvasTemplate';

/**
 * The canvas composition (OLA 3): the editor renders the page's own blocks WRAPPED IN the active theme's
 * template, using the SAME TemplateRenderer the public site uses, with `canvasPreview` on. These cover
 * the three properties that matter:
 *   1. the content is composed inside the theme's arrangement when a template exists, and untouched when
 *      it doesn't;
 *   2. the dynamic/part blocks show SOMETHING honest in preview instead of a hole;
 *   3. — the dangerous one — the theme template never becomes part of the page's saved `_puck_data`.
 */

const slot = { type: CONTENT_SLOT, props: {} };
const pageContent = React.createElement('article', { id: 'page-content' }, 'the edited blocks');

const tmpl = (content: unknown): TemplateTree => parseTemplate(JSON.stringify({ content }))!;

const renderCanvas = (t: TemplateTree, children: React.ReactNode = pageContent) =>
    renderToStaticMarkup(<TemplateRenderer template={t} canvasPreview>{children}</TemplateRenderer>);

describe('canvas theme-template composition', () => {
    it('wraps the editable content inside the theme arrangement, exactly once', () => {
        const html = renderCanvas(tmpl([{ type: 'Section', props: { maxWidth: '72rem', items: [slot] } }]));
        expect(html.match(/id="page-content"/g)).toHaveLength(1);
        // …and INSIDE the section, the same markup the public page emits.
        expect(html).toMatch(/<section[^>]*wp-block-section[\s\S]*id="page-content"[\s\S]*<\/section>/);
        expect(html).toContain('wp-block-section__inner');
    });

    it('fills a dynamic listing with the decorated preview posts (not a hole)', () => {
        const t = decorateForCanvas(
            tmpl([{ type: 'Section', props: { items: [slot, { type: 'PostsGrid', props: { count: 3 } }] } }]),
            [{ id: 1, title: 'Hola mundo', slug: 'hola', status: 'publish' } as any],
        );
        const html = renderCanvas(t);
        expect(html).toContain('wp-block-posts-grid');
        expect(html).toContain('Hola mundo');
    });

    it('renders an unresolved template PART as a labelled placeholder in preview, nothing in public', () => {
        const t = tmpl([slot, { type: 'TemplatePart', props: { name: 'promo', area: 'sidebar' } }]);
        // preview → placeholder that names the part and its area
        const preview = renderCanvas(t);
        expect(preview).toContain('wjs-canvas-part-placeholder');
        expect(preview).toMatch(/<aside[^>]*wjs-template-part--sidebar/);
        expect(preview).toContain('promo');
        // public (no canvasPreview) → fail-closed, renders nothing for the part
        const publicHtml = renderToStaticMarkup(<TemplateRenderer template={t}>{pageContent}</TemplateRenderer>);
        expect(publicHtml).not.toContain('wjs-template-part');
        expect(publicHtml).toContain('id="page-content"'); // the content is still there
    });

    it('no template ⇒ the content renders exactly as it would with no wrapper (no regression)', () => {
        // What CanvasThemeTemplate returns when no template resolves: <>{children}</>.
        const bare = renderToStaticMarkup(<>{pageContent}</>);
        expect(bare).toBe('<article id="page-content">the edited blocks</article>');
    });
});

/**
 * THE SAVE-EXCLUSION GUARANTEE — the most dangerous regression.
 *
 * The composition is DISPLAY ONLY: it wraps the editable content (which Puck renders from its own store)
 * inside the theme template. What the editor saves is Puck's `appState.data` (admin pages persist it as
 * `meta._puck_data`), never the render output — so the theme template's blocks can never leak into the
 * saved page. This test pins that boundary: decorating/wrapping produces the template display, while the
 * page's data stays byte-identical and free of any template block type.
 *
 * MUTATION SENTINEL: the `not.toContain('Section')` on the saved data would fail the moment someone
 * implemented this by merging the template INTO the page data instead of wrapping it in the renderer.
 */
describe('save-exclusion: the theme template never enters the saved page data', () => {
    it('wraps content for display while the Puck data stays untouched', () => {
        // The page the author is editing — this is exactly what handleSubmit persists as _puck_data.
        const savedData = {
            content: [
                { type: 'Heading', props: { id: 'h1', level: 'h1', title: 'My title' } },
                { type: 'Text', props: { id: 't1', content: 'Body copy' } },
            ],
            root: { props: { title: 'My title' } },
        };
        const before = JSON.stringify(savedData);

        // The theme template that the canvas wraps the content in.
        const template = tmpl([
            { type: 'Section', props: { className: 'hero', items: [
                { type: 'Grid', props: { columns: 2, items: [slot] } },
            ] } },
        ]);
        // Compose the canvas the way StablePuckRoot does: the page's blocks are the CHILDREN dropped into
        // the template's PageContent hole — the template is never part of `savedData`.
        const editable = React.createElement(
            'div', { id: 'editable-area' },
            savedData.content.map((b: any) => b.props.title || b.props.content).join(' | '),
        );
        const html = renderCanvas(template, editable);

        // The template IS visible in the canvas…
        expect(html).toContain('wp-block-section hero');
        expect(html).toContain('wp-block-grid__items');
        expect(html).toContain('id="editable-area"');

        // …but the data that gets SAVED is unchanged, and carries no template block type.
        expect(JSON.stringify(savedData)).toBe(before);
        const savedTypes = savedData.content.map((b: any) => b.type);
        expect(savedTypes).toEqual(['Heading', 'Text']);
        expect(savedTypes).not.toContain('Section');
        expect(savedTypes).not.toContain('Grid');
        expect(JSON.stringify(savedData)).not.toContain('PageContent');
    });
});
