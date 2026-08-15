import { describe, it, expect } from 'vitest';
import {
    decorateForCanvas,
    pickCanvasPosts,
    canvasTemplateCandidates,
    SAMPLE_POSTS,
} from '@/lib/canvasTemplate';
import { parseTemplate, CONTENT_SLOT, type TemplateTree } from '@/lib/templateData';

// Every valid template has exactly one PageContent hole; include it so parseTemplate accepts the fixture.
const slot = { type: CONTENT_SLOT, props: {} };

/**
 * The editor-canvas side of the theme page-template preview (OLA 3).
 *
 * The load-bearing properties: a template's dynamic listings get filled with the SAME derivation the
 * public resolver uses (so the author preview and the published page can't drift); a site with no posts
 * still previews with a clearly-fake sample set; and the decoration NEVER mutates the parsed template it
 * was given (that tree is cached and re-decorated).
 */

const post = (id: number, title: string, categories: { slug: string }[] = []) =>
    ({ id, title, slug: `p${id}`, status: 'publish', categories } as any);

const tmpl = (content: unknown): TemplateTree =>
    parseTemplate(JSON.stringify({ content }))!;

const findFirst = (t: TemplateTree, type: string): any => {
    let found: any = null;
    const walk = (list: any[]) => list.forEach((b) => {
        if (b?.type === type) found ||= b;
        if (Array.isArray(b?.props?.items)) walk(b.props.items);
    });
    walk(t.content);
    return found;
};

describe('pickCanvasPosts', () => {
    it('maps real posts (count + category), same derivation as the public resolver', () => {
        const all = [post(1, 'One', [{ slug: 'news' }]), post(2, 'Two'), post(3, 'Three', [{ slug: 'news' }])];
        const chosen = pickCanvasPosts(all, 'news', 5);
        expect(chosen.map((p) => p.title)).toEqual(['One', 'Three']);
        // count clamps the list
        expect(pickCanvasPosts(all, undefined, 2).map((p) => p.title)).toEqual(['One', 'Two']);
    });

    it('falls back to the newest posts when a category matches nothing (never empty)', () => {
        const all = [post(1, 'One'), post(2, 'Two')];
        expect(pickCanvasPosts(all, 'no-such', 6).map((p) => p.title)).toEqual(['One', 'Two']);
    });

    it('shows the sample set only when the site has no published posts', () => {
        const chosen = pickCanvasPosts([], undefined, 2);
        expect(chosen).toHaveLength(2);
        expect(chosen).toEqual(SAMPLE_POSTS.slice(0, 2));
        // The samples are inert — their hrefs never navigate.
        expect(chosen.every((p) => p.href === '#')).toBe(true);
    });
});

describe('decorateForCanvas', () => {
    it('fills a PostsGrid, including one nested inside containers, with resolvedPosts', () => {
        const t = tmpl([
            { type: 'Section', props: { items: [slot, { type: 'Grid', props: { columns: 2, items: [
                { type: 'PostsGrid', props: { count: 6 } },
            ] } }] } },
        ]);
        const out = decorateForCanvas(t, [post(1, 'Real one'), post(2, 'Real two')]);
        const grid = findFirst(out, 'PostsGrid');
        expect(grid.props.resolvedPosts.map((p: any) => p.title)).toEqual(['Real one', 'Real two']);
    });

    it('narrows a CategoryPosts by its own categorySlug', () => {
        const t = tmpl([slot, { type: 'CategoryPosts', props: { count: 6, categorySlug: 'news' } }]);
        const out = decorateForCanvas(t, [post(1, 'A', [{ slug: 'news' }]), post(2, 'B')]);
        expect(findFirst(out, 'CategoryPosts').props.resolvedPosts.map((p: any) => p.title)).toEqual(['A']);
    });

    it('NEVER mutates the template it was given (the tree is cached and re-decorated)', () => {
        const t = tmpl([slot, { type: 'PostsGrid', props: { count: 6 } }]);
        const snapshot = JSON.stringify(t);
        decorateForCanvas(t, [post(1, 'X')]);
        expect(JSON.stringify(t)).toBe(snapshot);
        // and the original PostsGrid block never gained a resolvedPosts field
        expect((t.content[1] as any).props.resolvedPosts).toBeUndefined();
    });

    it('leaves a structure-only template without any post fields', () => {
        const t = tmpl([{ type: 'Section', props: { items: [{ type: 'PageContent', props: {} }] } }]);
        const out = decorateForCanvas(t, [post(1, 'X')]);
        expect(JSON.stringify(out)).not.toContain('resolvedPosts');
    });
});

describe('canvasTemplateCandidates', () => {
    it('asks for the public hierarchy: single-post-… before single before page', () => {
        expect(canvasTemplateCandidates('single', 'hello', 'post')).toEqual([
            'single-post-hello', 'single-post', 'single', 'page',
        ]);
    });
    it('a page prefers page-<slug> then page', () => {
        expect(canvasTemplateCandidates('page', 'about')).toEqual(['page-about', 'page']);
    });
    it('every chain ends at page, the theme index template', () => {
        expect(canvasTemplateCandidates('single').at(-1)).toBe('page');
        expect(canvasTemplateCandidates('page').at(-1)).toBe('page');
    });
});
