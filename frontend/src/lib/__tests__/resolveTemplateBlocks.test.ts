import { describe, it, expect, vi } from 'vitest';

/**
 * The theme system's query loop.
 *
 * A template's listing must be filled on the SERVER, from the posts the ROUTE is about. The failure
 * these guard against is not a crash — it is a listing that renders confidently and answers the wrong
 * question: a search page showing the newest posts because the resolver only ever knew
 * getPosts("post","publish"). So the load-bearing assertions here are about WHICH posts arrive, and
 * about a structure-only template costing no fetch at all.
 */

const getPosts = vi.fn(async () => [
    { id: 1, title: 'Latest one', slug: 'latest-one', status: 'publish' },
    { id: 2, title: 'Latest two', slug: 'latest-two', status: 'publish' },
]);
// Named template parts: the manifest declares which chrome files are reachable, and the chrome loader
// serves them. Both are stubbed so the assertions are about the GATES, not about fetching.
const manifest = vi.fn(async () => JSON.stringify({ templateParts: [{ name: 'promo', area: 'general' }] }));
const chromeFiles: Record<string, string> = {
    promo: JSON.stringify({ root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 'Promo' } }] }),
    secret: JSON.stringify({ root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 'Not yours' } }] }),
    broken: JSON.stringify({ root: { props: {} }, content: [{ type: 'ChromeIframe', props: {} }] }),
};
const getThemeChrome = vi.fn(async (_slug: string, part: string) => chromeFiles[part] ?? null);
vi.mock('@/lib/server-api', () => ({
    getPosts: (...a: unknown[]) => getPosts(...(a as [])),
    getSettings: async () => ({ blogname: 'Site' }),
    getMenuByLocation: async () => ({ items: [] }),
    getThemeManifest: (...a: unknown[]) => manifest(...(a as [])),
    getThemeChrome: (...a: unknown[]) => getThemeChrome(...(a as [any, any])),
}));

const { resolveTemplateBlocks } = await import('../resolveTemplateBlocks');

const tree = (content: unknown) => ({ content }) as any;
const listing = (props: Record<string, unknown> = {}) => ({ type: 'PostsGrid', props: { count: 6, ...props } });
const firstListing = (t: any) => {
    let found: any = null;
    const walk = (list: any[]) => list.forEach((b) => {
        if (b?.type === 'PostsGrid' || b?.type === 'CategoryPosts') found ||= b;
        if (Array.isArray(b?.props?.items)) walk(b.props.items);
    });
    walk(t.content);
    return found;
};

describe('resolveTemplateBlocks', () => {
    it('fills a listing with the posts the ROUTE supplied, not the newest ones', async () => {
        const routePosts = [{ id: 9, title: 'A search hit', slug: 'hit', status: 'publish' }] as any;
        const out = await resolveTemplateBlocks(tree([listing()]), { posts: routePosts });
        const resolved = firstListing(out).props.resolvedPosts;
        expect(resolved).toHaveLength(1);
        expect(resolved[0].title).toBe('A search hit');
        // …and it must not have gone looking for posts of its own.
        expect(getPosts).not.toHaveBeenCalled();
    });

    it('falls back to latest published only when the route says nothing', async () => {
        getPosts.mockClear();
        const out = await resolveTemplateBlocks(tree([listing()]));
        expect(getPosts).toHaveBeenCalledTimes(1);
        expect(firstListing(out).props.resolvedPosts.map((p: any) => p.title)).toEqual(['Latest one', 'Latest two']);
    });

    it('costs no fetch when the template is pure structure', async () => {
        getPosts.mockClear();
        const structural = tree([{ type: 'Section', props: { items: [{ type: 'PageContent', props: {} }] } }]);
        const out = await resolveTemplateBlocks(structural);
        expect(getPosts).not.toHaveBeenCalled();
        expect(out).toBe(structural);   // untouched, not a rebuilt copy
    });

    it('reaches a listing nested inside containers', async () => {
        getPosts.mockClear();
        const out = await resolveTemplateBlocks(tree([
            { type: 'Section', props: { items: [{ type: 'Grid', props: { columns: 2, items: [listing()] } }] } },
        ]), { posts: [{ id: 3, title: 'Nested', slug: 'n', status: 'publish' }] as any });
        expect(firstListing(out).props.resolvedPosts[0].title).toBe('Nested');
    });

    it('honours count, and reports whether a category filter actually matched', async () => {
        const posts = Array.from({ length: 5 }, (_, i) => ({ id: i, title: `P${i}`, slug: `p${i}`, status: 'publish' })) as any;
        const out = await resolveTemplateBlocks(tree([listing({ count: 2 })]), { posts });
        expect(firstListing(out).props.resolvedPosts).toHaveLength(2);

        // An unmatched slug falls back to the newest posts rather than showing nothing, and says so —
        // a listing that silently shows the wrong set is the thing this flag exists to prevent.
        const cat = await resolveTemplateBlocks(
            tree([{ type: 'CategoryPosts', props: { count: 3, categorySlug: 'no-such-category' } }]), { posts });
        expect(firstListing(cat).props.resolvedFiltered).toBe(false);
        expect(firstListing(cat).props.resolvedPosts.length).toBeGreaterThan(0);
    });

    it('never mutates the tree it was given', async () => {
        const original = tree([listing()]);
        const snapshot = JSON.stringify(original);
        await resolveTemplateBlocks(original, { posts: [{ id: 1, title: 'X', slug: 'x', status: 'publish' }] as any });
        expect(JSON.stringify(original)).toBe(snapshot);
    });
});

/**
 * NAMED TEMPLATE PARTS. The load-bearing property is not "a part renders" — it is that a part renders
 * ONLY when theme.json declared it. Without that gate, `name` would be a theme-supplied string picking
 * which file the server fetches and hands to the chrome renderer.
 */
describe('resolveTemplateBlocks — named template parts', () => {
    const part = (name: string, area = 'general') => ({ type: 'TemplatePart', props: { name, area } });
    const firstPart = (t: any) => {
        let found: any = null;
        const walk = (list: any[]) => list.forEach((b) => {
            if (b?.type === 'TemplatePart') found ||= b;
            if (Array.isArray(b?.props?.items)) walk(b.props.items);
        });
        walk(t.content);
        return found;
    };

    it('resolves a DECLARED part into a validated composition, nested containers included', async () => {
        const out = await resolveTemplateBlocks(
            tree([{ type: 'Section', props: { items: [part('promo')] } }]), {}, 'my-theme');
        const resolved = firstPart(out).props;
        expect(resolved.resolvedPart.content[0].type).toBe('ChromeText');
        expect(resolved.resolvedBindings.settings.blogname).toBe('Site');
        expect(getThemeChrome).toHaveBeenCalledWith('my-theme', 'promo');
    });

    it('refuses an UNDECLARED name even though the file exists and is valid', async () => {
        getThemeChrome.mockClear();
        const out = await resolveTemplateBlocks(tree([part('secret')]), {}, 'my-theme');
        expect(firstPart(out).props.resolvedPart).toBeUndefined();
        // …and it was never even fetched: the declaration is checked before anything reaches a URL.
        expect(getThemeChrome).not.toHaveBeenCalled();
    });

    it('leaves a declared part unresolved when its file breaks the chrome contract', async () => {
        manifest.mockResolvedValueOnce(JSON.stringify({ templateParts: [{ name: 'broken', area: 'general' }] }));
        const out = await resolveTemplateBlocks(tree([part('broken')]), {}, 'my-theme');
        expect(firstPart(out).props.resolvedPart).toBeUndefined();
    });

    it('drops EVERY part when the declaration itself is invalid (fail-closed as a whole)', async () => {
        manifest.mockResolvedValueOnce(JSON.stringify({
            templateParts: [{ name: 'promo', area: 'general' }, { name: '../escape', area: 'general' }]
        }));
        const out = await resolveTemplateBlocks(tree([part('promo')]), {}, 'my-theme');
        expect(firstPart(out).props.resolvedPart).toBeUndefined();
    });

    it('costs nothing — not even the manifest — when no template references a part', async () => {
        manifest.mockClear();
        getThemeChrome.mockClear();
        const structural = tree([{ type: 'Section', props: { items: [{ type: 'PageContent', props: {} }] } }]);
        expect(await resolveTemplateBlocks(structural, {}, 'my-theme')).toBe(structural);
        expect(manifest).not.toHaveBeenCalled();
        expect(getThemeChrome).not.toHaveBeenCalled();
    });

    it('resolves listings and parts in the same pass', async () => {
        const out = await resolveTemplateBlocks(
            tree([listing(), part('promo')]),
            { posts: [{ id: 7, title: 'Both', slug: 'both', status: 'publish' }] as any },
            'my-theme',
        );
        expect((out.content[0] as any).props.resolvedPosts[0].title).toBe('Both');
        expect((out.content[1] as any).props.resolvedPart).toBeTruthy();
    });
});
