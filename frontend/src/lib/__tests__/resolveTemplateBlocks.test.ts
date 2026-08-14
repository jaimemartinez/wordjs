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
vi.mock('@/lib/server-api', () => ({ getPosts: (...a: unknown[]) => getPosts(...(a as [])) }));

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
