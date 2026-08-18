import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tagsApi, mediaApi, auditApi, exportApi, authApi, buildExportQuery } from '../api';

/**
 * The client half of four backend surfaces that had NO client at all (or a client that could only
 * ever see the first page). None of these bugs is loud — a missing method is a screen nobody wrote,
 * and a list call that drops its query is a library that silently shows its first 20 items and calls
 * that the whole thing — so what is pinned here is the WIRE: the exact path and query the backend
 * routers read, and the fact that the paged reads go through the header-preserving fetch.
 *
 * Node environment (see vitest.config.mts): `fetch` and `window` are substituted per test, which is
 * also the only way to observe a download that works by navigating.
 */

type Recorded = { url: string; method: string; body?: string };

let calls: Recorded[];
const realFetch = globalThis.fetch;

/** A fetch that records the request and answers with an empty list plus the pager headers. */
const stubFetch = (headers: Record<string, string> = {}) => {
    globalThis.fetch = (async (input: any, init: any = {}) => {
        calls.push({ url: String(input), method: init.method || 'GET', body: init.body });
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: (h: string) => headers[h] ?? null },
            json: async () => [],
            text: async () => '[]',
        };
    }) as unknown as typeof fetch;
};

/** Everything after the API base, i.e. what the backend router actually matches on. */
const pathOf = (url: string) => url.slice(url.indexOf('/api/v1') + '/api/v1'.length);

beforeEach(() => {
    calls = [];
    stubFetch();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as unknown as { window?: unknown }).window;
});

describe('tagsApi', () => {
    it('covers the whole post_tag CRUD router, which had no client at all', async () => {
        await tagsApi.list();
        await tagsApi.get(7);
        await tagsApi.create({ name: 'Reseñas' });
        await tagsApi.update(7, { name: 'Reseña' });
        await tagsApi.remove(7);

        expect(calls.map((c) => `${c.method} ${pathOf(c.url)}`)).toEqual([
            'GET /tags',
            'GET /tags/7',
            'POST /tags',
            'PUT /tags/7',
            'DELETE /tags/7',
        ]);
        // The body travels as JSON, with the field names the router destructures.
        expect(JSON.parse(calls[2].body as string)).toEqual({ name: 'Reseñas' });
    });

    it('sends the query with the snake_case names the router reads', async () => {
        await tagsApi.list({ page: 2, perPage: 50, search: 'a b', hideEmpty: true, order: 'desc' });
        const params = new URLSearchParams(pathOf(calls[0].url).split('?')[1]);
        expect(params.get('page')).toBe('2');
        expect(params.get('per_page')).toBe('50');      // NOT perPage — the router reads per_page
        expect(params.get('hide_empty')).toBe('true');  // NOT hideEmpty
        expect(params.get('search')).toBe('a b');       // encoded, and decoded back to the real string
        expect(params.get('order')).toBe('desc');
    });

    it('omits the query entirely when nothing was asked for, so the backend defaults apply', async () => {
        await tagsApi.list();
        expect(pathOf(calls[0].url)).toBe('/tags');
    });
});

describe('mediaApi', () => {
    it('pages and filters — the old client sent no query and could only ever see page 1', async () => {
        await mediaApi.list({ page: 3, perPage: 40, search: 'logo', mimeType: 'image/', orderby: 'title', order: 'asc' });
        const params = new URLSearchParams(pathOf(calls[0].url).split('?')[1]);
        expect(params.get('page')).toBe('3');
        expect(params.get('per_page')).toBe('40');
        expect(params.get('search')).toBe('logo');
        expect(params.get('mime_type')).toBe('image/'); // NOT mimeType
        expect(params.get('orderby')).toBe('title');
        expect(params.get('order')).toBe('asc');
    });

    it('stays callable with no arguments (existing screens) and then asks for page 1', async () => {
        await mediaApi.list();
        const params = new URLSearchParams(pathOf(calls[0].url).split('?')[1]);
        expect(params.get('page')).toBe('1');
        expect(params.get('per_page')).toBe('20');
    });

    it('listPaged surfaces X-WP-Total / X-WP-TotalPages, which apiGet throws away', async () => {
        stubFetch({ 'X-WP-Total': '137', 'X-WP-TotalPages': '7' });
        const res = await mediaApi.listPaged({ page: 2 });
        expect(res.total).toBe(137);
        expect(res.totalPages).toBe(7);
    });

    it('update PUTs exactly the four fields the backend accepts', async () => {
        await mediaApi.update(12, { title: 'Portada', alt: 'Un faro al amanecer' });
        expect(calls[0].method).toBe('PUT');
        expect(pathOf(calls[0].url)).toBe('/media/12');
        expect(JSON.parse(calls[0].body as string)).toEqual({ title: 'Portada', alt: 'Un faro al amanecer' });
    });
});

describe('auditApi', () => {
    it('asks for a clamped page and reads the totals from the headers', async () => {
        stubFetch({ 'X-WP-Total': '900', 'X-WP-TotalPages': '18' });
        const res = await auditApi.list({ page: 2, perPage: 50 });
        const params = new URLSearchParams(pathOf(calls[0].url).split('?')[1]);
        expect(pathOf(calls[0].url).split('?')[0]).toBe('/audit');
        expect(params.get('page')).toBe('2');
        expect(params.get('per_page')).toBe('50');
        expect(res.total).toBe(900);
        expect(res.totalPages).toBe(18);
    });
});

describe('authApi', () => {
    it('registers and verifies against the two public auth endpoints', async () => {
        await authApi.register({ username: 'ana', email: 'ana@example.com', password: 'contrasena-larga' });
        await authApi.verifyEmail({ uid: 4, token: 'abc' });

        expect(calls.map((c) => `${c.method} ${pathOf(c.url)}`)).toEqual([
            'POST /auth/register',
            'POST /auth/verify-email',
        ]);
        // verify-email's body is exactly { uid, token } — the route parseInts uid and refuses anything else.
        expect(JSON.parse(calls[1].body as string)).toEqual({ uid: 4, token: 'abc' });
    });
});

describe('export download', () => {
    /**
     * The backend INCLUDES everything except users unless the query says `false`, so the query must
     * only ever carry the DIFFERENCES. Getting this backwards is silent in the worst way: an export
     * that quietly ships user rows, or one that quietly omits the posts.
     */
    it('says nothing when the defaults are wanted', () => {
        expect(buildExportQuery()).toBe('');
        expect(buildExportQuery({ media: true, posts: true, pages: true, settings: true, menus: true })).toBe('');
    });

    it('names only the sections left OUT', () => {
        const params = new URLSearchParams(buildExportQuery({ media: false, menus: false }));
        expect(params.get('media')).toBe('false');
        expect(params.get('menus')).toBe('false');
        expect(params.get('posts')).toBeNull();
    });

    it('treats users as opt-IN — an export with user rows is a different kind of file', () => {
        expect(buildExportQuery({ users: false })).toBe('');
        expect(new URLSearchParams(buildExportQuery({ users: true })).get('users')).toBe('true');
    });

    it('navigates to the endpoint so the session cookie rides along (same as backups/themes)', () => {
        const location = { href: '' };
        (globalThis as unknown as { window: unknown }).window = { location };

        exportApi.downloadJson({ users: true });
        expect(location.href).toBe('/api/v1/export?users=true');

        exportApi.downloadWxr();
        expect(location.href).toBe('/api/v1/export/wxr');
    });
});

describe('no request leaks the session in the URL', () => {
    it('keeps every call on its own path — credentials ride the HttpOnly cookie, never a query param', async () => {
        await tagsApi.list({ search: 'x' });
        await mediaApi.list({ search: 'x' });
        await auditApi.list();
        for (const call of calls) {
            expect(call.url).not.toMatch(/token|password|authorization/i);
        }
    });
});
