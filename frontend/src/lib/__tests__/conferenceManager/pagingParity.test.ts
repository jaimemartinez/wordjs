/**
 * conference-manager 2.18.0 — the same paging rules in the plugin admin (client/lib/paging.ts) and the core
 * portal (frontend/src/app/portal/conference/participants.ts, when it is there): one behaviour on both sides.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as plugin from '../../../../../marketplace/plugins/conference-manager/client/lib/paging';

const PORTAL = path.resolve(__dirname, '../../../app/portal/conference/participants.ts');

const run = (impl: any) => ({
    sizes: [...impl.PAGE_SIZES],
    def: impl.DEFAULT_PAGE_SIZE,
    norm: [10, 20, 30, '50', null, 100, 1000].map((v) => impl.normalizePageSize(v)),
    count: [[0, 20], [1, 20], [20, 20], [21, 20], [183, 50]].map(([t, s]) => impl.pageCount(t, s)),
    clamp: [[0, 40, 20], [3, 40, 20], [9, 0, 10], [2, 41, 20]].map(([p, t, s]) => impl.clampPage(p, t, s)),
    slice: [[2, 20], [10, 20], [1, 100]].map(([p, s]) => impl.pageSlice(Array.from({ length: 183 }, (_, i) => i), p, s)),
    range: [[2, 20, 183], [10, 20, 183], [1, 20, 0]].map(([p, s, t]) => impl.rangeOf(p, s, t)),
    window: [[6, 20], [1, 1], [3, 5], [1, 9], [9, 9]].map(([c, n]) => impl.pageWindow(c, n)),
    resize: [[3, 20, 50], [3, 20, 10], [2, 50, 20]].map(([p, o, n]) => impl.pageAfterResize(p, o, n)),
});

describe('paging parity', () => {
    it('the plugin answers the vectors the design fixed', () => {
        const r = run(plugin);
        expect(r.window[0]).toEqual([1, '…', 5, 6, 7, '…', 20]);
        expect(r.resize).toEqual([1, 5, 3]);
    });
    it.skipIf(!fs.existsSync(PORTAL))('the core portal agrees on every vector', async () => {
        const portal = await import(/* @vite-ignore */ PORTAL);
        expect(run(portal)).toEqual(run(plugin));
    });
});
