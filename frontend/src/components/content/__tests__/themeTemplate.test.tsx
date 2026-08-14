import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * ThemeTemplate — where the hierarchy meets a route.
 *
 * templateData's unit tests prove which NAMES a kind produces; these prove the component actually ASKS
 * for them, in order, and stops at the first one the theme ships. That is the join the feature lives or
 * dies on: a hierarchy nothing queries is a pure function with no consumer, which is precisely the kind
 * of change this codebase treats as a defect.
 *
 * The 404 case is here for a second reason. `not-found.tsx` is the one route whose wiring cannot be
 * proven by `next build` alone (the build only shows /_not-found prerendering), so this renders the
 * REAL route component and asserts the theme's arrangement wrapped the not-found message.
 */

const templates: Record<string, string> = {};
const asked: string[] = [];
const getThemeTemplate = vi.fn(async (_slug: string, name: string) => {
    asked.push(name);
    return templates[name] ?? null;
});

vi.mock('@/lib/server-api', () => ({
    getSettings: async () => ({ template: 'my-theme' }),
    getThemeTemplate: (...a: unknown[]) => getThemeTemplate(...(a as [string, string])),
    getPosts: async () => [],
    getMenuByLocation: async () => ({ items: [] }),
    getThemeManifest: async () => null,
    getThemeChrome: async () => null,
}));

const { default: ThemeTemplate } = await import('../ThemeTemplate');
const { default: PublicNotFound } = await import('@/app/(public)/not-found');

const TEMPLATE = JSON.stringify({
    content: [{ type: 'Section', props: { className: 'themed', items: [{ type: 'PageContent', props: {} }] } }],
});

/**
 * Await async Server Components until what is left is a synchronous tree, then render it.
 * `renderToStaticMarkup` cannot suspend, and the 404 route is an async component that RETURNS another
 * one (ThemeTemplate), so one await is not enough.
 */
async function renderServer(element: React.ReactElement): Promise<string> {
    let el: React.ReactElement = element;
    while (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
        el = await (el.type as (p: unknown) => Promise<React.ReactElement>)(el.props);
    }
    return renderToStaticMarkup(el);
}

beforeEach(() => {
    asked.length = 0;
    for (const key of Object.keys(templates)) delete templates[key];
    getThemeTemplate.mockClear();
});

describe('ThemeTemplate', () => {
    it('asks for the single chain, most specific first, and stops at the first hit', async () => {
        templates['single-post'] = TEMPLATE;
        const html = await renderServer(
            <ThemeTemplate kind="single" postType="post" slug="hello-world"><p>body</p></ThemeTemplate>,
        );
        expect(asked).toEqual(['single-post-hello-world', 'single-post']);
        expect(html).toContain('themed');
        expect(html).toContain('<p>body</p>');
    });

    it('asks for page-<slug> before page', async () => {
        await renderServer(<ThemeTemplate kind="page" slug="about"><p>body</p></ThemeTemplate>);
        expect(asked).toEqual(['page-about', 'page']);
    });

    it('renders children untouched when the theme ships no template at all', async () => {
        const html = await renderServer(<ThemeTemplate kind="home"><p>body</p></ThemeTemplate>);
        expect(asked).toEqual(['home', 'archive', 'page']);
        expect(html).toBe('<p>body</p>');
    });

    it('the 404 route asks for 404.json, then page.json', async () => {
        await renderServer(<PublicNotFound />);
        expect(asked).toEqual(['404', 'page']);
    });

    it('the 404 route renders the not-found message INSIDE the theme arrangement', async () => {
        templates['404'] = TEMPLATE;
        const html = await renderServer(<PublicNotFound />);
        expect(html).toContain('Contenido no encontrado');
        expect(html).toMatch(/<section[^>]*themed[\s\S]*Contenido no encontrado/);
    });

    it('a theme shipping only page.json still reaches the 404 — every chain ends there', async () => {
        templates['page'] = TEMPLATE;
        const html = await renderServer(<PublicNotFound />);
        expect(asked).toEqual(['404', 'page']);
        expect(html).toContain('themed');
    });
});
