import { describe, expect, it } from 'vitest';
import {
    CORE_CONTENT_TYPES,
    createContentClient,
    type ContentCreateInput,
    type ContentTransport,
    type ContentUpdateInput,
    type PagedResult,
} from '../content-client.generated';

function harness() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: ContentTransport = {
        async get<T>(path: string): Promise<T> {
            calls.push({ method: 'GET', path });
            return [] as T;
        },
        async getPaged<T>(path: string): Promise<PagedResult<T>> {
            calls.push({ method: 'GET_PAGED', path });
            return { data: [] as T, total: 0, totalPages: 1 };
        },
        async post<T>(path: string, body: unknown): Promise<T> {
            calls.push({ method: 'POST', path, body });
            return { id: 1 } as T;
        },
        async put<T>(path: string, body: unknown): Promise<T> {
            calls.push({ method: 'PUT', path, body });
            return { id: 1 } as T;
        },
        async delete<T>(path: string): Promise<T> {
            calls.push({ method: 'DELETE', path });
            return { deleted: true } as T;
        },
    };
    return { calls, client: createContentClient(transport) };
}

describe('generated F2 content client', () => {
    it('carries every core F1 discriminator in deterministic order', () => {
        expect(CORE_CONTENT_TYPES).toEqual(['attachment', 'nav_menu_item', 'page', 'post', 'revision']);
    });

    it('encodes list and slug requests without accepting path injection', async () => {
        const { calls, client } = harness();
        await client.listPaged({ type: 'page', status: 'future', page: 2, perPage: 50, search: 'a & b' });
        await client.getBySlug('../private page', 'page/custom');
        expect(calls[0]).toEqual({
            method: 'GET_PAGED',
            path: '/posts?type=page&status=future&page=2&per_page=50&search=a+%26+b',
        });
        expect(calls[1]).toEqual({
            method: 'GET',
            path: '/posts/slug/..%2Fprivate%20page?type=page%2Fcustom',
        });
    });

    it('sends create and update DTOs unchanged through the supplied transport', async () => {
        const { calls, client } = harness();
        const create: ContentCreateInput = { title: 'Typed', type: 'post', status: 'draft', meta: { plugin: { enabled: true } } };
        const update: ContentUpdateInput = { title: 'Updated', autosave: true };
        await client.create(create);
        await client.update(7, update);
        expect(calls).toEqual([
            { method: 'POST', path: '/posts', body: create },
            { method: 'PUT', path: '/posts/7', body: update },
        ]);
    });
});
