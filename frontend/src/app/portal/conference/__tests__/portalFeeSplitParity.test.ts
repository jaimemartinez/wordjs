/**
 * ONE split rule, three copies: the server (conference-manager `server/fee-split.js`), the plugin admin
 * (`client/lib/feeSplit.ts`) and this portal (`feeSplit.ts`) — core cannot import plugin code. All three run
 * the shared vectors (frontend/src/lib/__tests__/conferenceManager/feeSplitVectors.json), so a split the
 * coordinator's sheet shows as exact («Asignado $X de $X ✓», «Iguales» leftover cents to the first people,
 * «1.250,50» read as 1250.50) is exactly what the server accepts — and refuses the same ones.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as portal from "../feeSplit";
import * as plugin from "../../../../../../marketplace/plugins/conference-manager/client/lib/feeSplit";
import vectors from "../../../../lib/__tests__/conferenceManager/feeSplitVectors.json";

const require = createRequire(import.meta.url);
const SERVER = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/server/fee-split.js");
const server = require(SERVER) as typeof portal;

type Impl = Pick<typeof portal, "parseMoneyInput" | "splitEqual" | "splitState" | "validateAllocations" | "MAX_PARTS"> & { centsToInput?: (c: number) => string };
const IMPLS: [string, Impl][] = [["portal", portal], ["plugin", plugin as unknown as Impl], ["server", server as unknown as Impl]];

type V = {
    parseMoneyInput: { in: string | number; out: number | null }[];
    centsToInput: { in: number; out: string }[];
    splitEqual: { total: number; n: number; out: number[] }[];
    splitState: { total: number; parts: number[]; out: { assigned: number; diff: number; ok: boolean } }[];
    validateAllocations: { total: number; parts: { inscription_id: number | null; cents: number | null }[]; max?: number; out: Record<string, unknown> }[];
};
const v = vectors as unknown as V;

describe("the shared vectors exist and cover every rule", () => {
    it("has vectors for each function, including the documented examples", () => {
        expect(fs.existsSync(SERVER)).toBe(true);
        expect(v.parseMoneyInput.length).toBeGreaterThan(20);
        expect(v.parseMoneyInput).toContainEqual({ in: "1.250,50", out: 125050 });
        expect(v.splitEqual).toContainEqual({ total: 10000, n: 3, out: [3334, 3333, 3333] });
        expect(v.validateAllocations.map((x) => (x.out as { code?: string }).code ?? "ok")).toEqual(
            expect.arrayContaining(["empty", "too_many", "invalid_id", "duplicate", "non_positive", "sum_mismatch", "ok"]));
    });
});

describe.each(IMPLS)("%s implementation", (_name, impl) => {
    it("caps a payment at 200 people", () => {
        expect(impl.MAX_PARTS).toBe(200);
    });
    it.each(v.parseMoneyInput.map((x) => [JSON.stringify(x.in), x] as const))("parseMoneyInput(%s)", (_l, x) => {
        expect(impl.parseMoneyInput(x.in)).toBe(x.out);
    });
    it.each(v.splitEqual.map((x) => [`${x.total}/${x.n}`, x] as const))("splitEqual(%s)", (_l, x) => {
        expect(impl.splitEqual(x.total, x.n)).toEqual(x.out);
    });
    it.each(v.splitState.map((x) => [`${x.total} ← ${x.parts.join("+")}`, x] as const))("splitState(%s)", (_l, x) => {
        expect(impl.splitState(x.total, x.parts)).toEqual(x.out);
    });
    it.each(v.validateAllocations.map((x, i) => [i, x] as const))("validateAllocations vector %s", (_i, x) => {
        const out = x.max === undefined ? impl.validateAllocations(x.parts, x.total) : impl.validateAllocations(x.parts, x.total, x.max);
        expect(out).toEqual(x.out);
    });
    it("centsToInput (clients only) reads back to the same cents", () => {
        if (!impl.centsToInput) return;   // the server never formats an input
        for (const x of v.centsToInput) {
            expect(impl.centsToInput(x.in)).toBe(x.out);
            expect(impl.parseMoneyInput(x.out)).toBe(x.in);
        }
    });
});

// ── the «Resumen»: ONE definition on the three sides (2.18.0) ─────────────────────────────────────────
// The server's tiles and «Por localidad» (server/fee-split.js summaryOf), the admin client's figures
// (client/lib/feePayments.ts summarizeBalances + barSegments) and this portal's summarize: the same people
// give the same Cuotas / Validado / Por validar / Por cobrar / A favor, and the first four add up exactly.
describe("«Resumen» parity: server, admin and portal agree on the same balances", () => {
    // [due, validated, pending, returned, cancelled] in pesos.
    const PEOPLE: [number, number, number, number, boolean][][] = [
        [[250, 0, 0, 0, false], [250, 250, 0, 0, false], [100, 100, 0, 0, true]],             // Mateo paid, then cancelled
        [[250, 0, 250, 0, false], [100, 0, 60, 0, true], [250, 100, 200, 50, false]],          // pending past the fee, cancelled pending
        [[50, 100, 0, 0, false], [50, 0, 0, 0, false], [0, 0, 0, 0, false]],                   // credit after a re-price, no fee
        [[333.33, 0.01, 333.31, 12.5, false], [333.33, 333.34, 0, 0, false]],                    // cents
    ];
    const cents = (x: number) => Math.round(x * 100);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serverSplit = require(SERVER) as { summaryOf: (l: unknown[]) => Record<string, number> };
    it.each(PEOPLE.map((list, i) => [i, list] as const))("vector %s", async (_i, list) => {
        const { summarize, balanceC } = await import("../feePayments");
        const admin = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feePayments");
        const portalS = summarize(list.map(([due, validated, pending, returned, cancelled]) => balanceC({ due, validated, pending, returned, cancelled })));
        const adminB = list.map(([due, validated, pending, returned, cancelled]) => admin.personBalance({ total_due: due, amount_paid: validated, pending_amount: pending, returned_amount: returned, status: cancelled ? "cancelled" : "active" }));
        const adminS = admin.summarizeBalances(adminB);
        const bar = admin.barSegments(adminB);
        const server = serverSplit.summaryOf(list.map(([due, validated, pending, returned, cancelled]) => ({ due: cancelled ? 0 : cents(due), validated: cents(validated), pending: cents(pending), returned: cents(returned), cancelled })));
        const fig = (s: { due: number; validated: number; pending: number; toCover?: number; to_cover?: number; credit: number; returned: number }) =>
            ({ due: s.due, validated: s.validated, pending: s.pending, toCover: s.toCover ?? s.to_cover, credit: s.credit, returned: s.returned });
        expect(fig(adminS)).toEqual(fig(server as never));
        expect(fig(portalS)).toEqual(fig(server as never));
        expect({ validated: bar.validated, pending: bar.pending, toCover: bar.toCover, due: bar.due }).toEqual({ validated: server.validated, pending: server.pending, toCover: server.to_cover, due: server.due });
        expect(server.validated + server.pending + server.to_cover).toBe(server.due);
    });
});
