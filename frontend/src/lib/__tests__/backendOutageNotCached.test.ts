/**
 * BACKEND OUTAGES ARE NOT CACHED AS PAGES.
 *
 * Every SSR read degrades to null, so a public page rendered while the backend gave no answer used to
 * come out as a 200 with the defaults (title "WordJS"), or a 404 for a post that exists, and ISR cached
 * it: on the lab, the main site's home page kept that default title after the backend was back, and a
 * site created a moment earlier answered its own address with it. The render now records "no answer"
 * (a failed connection, the gateway's 502/504) and the public layout and pages throw instead of
 * rendering it. A status the backend CHOSE (404, the install guard's or a suspended site's 503) is an
 * answer, and a build never throws.
 *
 * React's cache() only memoizes inside a server render, so it is replaced here by a per-test store
 * (the same "one value per request" the render gives it).
 *
 * MUTATION PROOF: drop noteBackendUnavailable() from the catch and the first case fails; from the
 * 502/504 branch and the second does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let store = new Map<string, unknown>();
vi.mock('react', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        cache: (fn: (...a: any[]) => any) => {
            const id = Symbol('cached');
            return (...args: any[]) => {
                const key = String(id.toString()) + JSON.stringify(args) + String(fn);
                if (!store.has(key)) store.set(key, fn(...args));
                return store.get(key);
            };
        },
    };
});

import { serverFetch, backendUnavailableInThisRender, contentNotFound, BackendUnavailableError } from '../server-api';

const answer = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a public render that got no answer from the backend', () => {
    beforeEach(() => { store = new Map(); });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('a failed connection marks the render, and contentNotFound() throws instead of a 404', async () => {
        vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
        expect(await serverFetch('/posts/slug/x', { revalidate: 60 })).toBeNull();
        expect(backendUnavailableInThisRender()).toBe(true);
        expect(() => contentNotFound()).toThrow(BackendUnavailableError);
    });

    it("the gateway's 502 and 504 mark it too", async () => {
        for (const status of [502, 504]) {
            store = new Map();
            vi.stubGlobal('fetch', answer(status));
            expect(await serverFetch('/settings', { revalidate: 60 })).toBeNull();
            expect(backendUnavailableInThisRender()).toBe(true);
        }
    });

    it('a status the backend chose is an answer: 404 stays a real not-found, 503 is not an outage', async () => {
        vi.stubGlobal('fetch', answer(404, { code: 'rest_post_invalid_id' }));
        expect(await serverFetch('/posts/slug/missing', { revalidate: 60 })).toBeNull();
        expect(backendUnavailableInThisRender()).toBe(false);
        let thrown: any;
        try { contentNotFound(); } catch (e) { thrown = e; }
        expect(thrown).not.toBeInstanceOf(BackendUnavailableError);
        expect(String(thrown?.digest || thrown?.message)).toMatch(/NOT_FOUND|404/);

        store = new Map();
        vi.stubGlobal('fetch', answer(503, { error: 'setup_required' }));
        await serverFetch('/settings', { revalidate: 60 });
        expect(backendUnavailableInThisRender()).toBe(false);
    });

    it('never while building', async () => {
        vi.stubEnv('NEXT_PHASE', 'phase-production-build');
        vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
        await serverFetch('/settings', { revalidate: 60 });
        expect(backendUnavailableInThisRender()).toBe(false);
    });
});
