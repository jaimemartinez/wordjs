/**
 * conference-manager 2.18.0 — ONE split rule, three copies: the plugin admin (client/lib/feeSplit.ts), the
 * server (server/fee-split.js) and the coordinators' portal (client/portal/feeSplit.ts). Every
 * copy runs the ONE set of shared vectors (feeSplitVectors.json, also run by the portal's
 * portalFeeSplitParity.test.ts) and must give exactly the recorded output: a split the admin's sheet shows
 * as exact is exactly what the server accepts, and «Iguales» gives the same cents everywhere.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as client from '../../../../../marketplace/plugins/conference-manager/client/lib/feeSplit';
import vectors from './feeSplitVectors.json';

const require = createRequire(import.meta.url);
const server = require('../../../../../marketplace/plugins/conference-manager/server/fee-split.js');
const PORTAL = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/portal/feeSplit.ts');

type V = {
    parseMoneyInput: { in: string | number; out: number | null }[];
    centsToInput: { in: number; out: string }[];
    splitEqual: { total: number; n: number; out: number[] }[];
    splitState: { total: number; parts: number[]; out: { assigned: number; diff: number; ok: boolean } }[];
    validateAllocations: { total: number; parts: { inscription_id: number | null; cents: number | null }[]; max?: number; out: Record<string, unknown> }[];
};
const v = vectors as unknown as V;

/** Every vector through one implementation, as [input, output] pairs so a failure names the input. */
function runVectors(impl: any) {
    return {
        money: v.parseMoneyInput.map((x) => [x.in, impl.parseMoneyInput(x.in)]),
        equal: v.splitEqual.map((x) => [`${x.total}/${x.n}`, impl.splitEqual(x.total, x.n)]),
        states: v.splitState.map((x) => [x.total, x.parts, impl.splitState(x.total, x.parts)]),
        allocs: v.validateAllocations.map((x, i) => [i, x.max === undefined ? impl.validateAllocations(x.parts, x.total) : impl.validateAllocations(x.parts, x.total, x.max)]),
        // The default cap (no `max` argument): 201 people is one too many.
        cap: [impl.MAX_PARTS, impl.validateAllocations(Array.from({ length: 201 }, (_, i) => ({ inscription_id: i + 1, cents: 1 })), 201)],
    };
}
const expected = {
    money: v.parseMoneyInput.map((x) => [x.in, x.out]),
    equal: v.splitEqual.map((x) => [`${x.total}/${x.n}`, x.out]),
    states: v.splitState.map((x) => [x.total, x.parts, x.out]),
    allocs: v.validateAllocations.map((x, i) => [i, x.out]),
    cap: [200, { ok: false, code: 'too_many', max: 200 }],
};

describe('feeSplit parity (shared vectors)', () => {
    it('the shared vectors cover the cases the admin sheet relies on', () => {
        expect(v.parseMoneyInput).toContainEqual({ in: '0.001', out: 100 });   // a dot + 3 digits groups thousands
        expect(v.splitEqual).toContainEqual({ total: 10001, n: 3, out: [3334, 3334, 3333] });
        expect(v.splitEqual).toContainEqual({ total: 100, n: 0, out: [] });
    });
    it('the plugin admin gives every recorded output', () => {
        expect(runVectors(client)).toEqual(expected);
    });
    it('the server gives every recorded output', () => {
        expect(runVectors(server)).toEqual(expected);
    });
    it('the admin prefills a money input with text that reads back to the same cents', () => {
        for (const x of v.centsToInput) {
            expect(client.centsToInput(x.in)).toBe(x.out);
            expect(client.parseMoneyInput(x.out)).toBe(x.in);
        }
    });
    it('the portal gives every recorded output too', async () => {
        const portal = await import(/* @vite-ignore */ PORTAL);
        expect(runVectors(portal)).toEqual(expected);
    });
});
