/**
 * The coordinator portal's list rules (participants.ts): paging, the accent-free search, the payment
 * chips and the multi-select of «Saldos». Owner decisions pinned: 20 per page with «Mostrar 10/20/50/100»
 * remembered per device (D2), a search that ignores accents and case (D10), the header box ticks THIS page
 * and «Seleccionar los N» stops at 200 (D13 / the server's limit), a cancelled inscription is «Cancelada»
 * and can never be ticked (D-P19).
 */
import { describe, it, expect } from "vitest";
import {
    DEFAULT_PAGE_SIZE, PAGE_SIZE_KEY, PAGE_SIZES, SELECTION_MAX, clampPage, extraColumns, familyGroupsOf, filterPeople, idsKey, isCancelled,
    matchesQuery, pageAfterResize, pageCount, pageSelectionState, pageSlice, pageWindow, payFilterCounts, payStateOf, pruneSelection, rangeOf,
    readPageSize, rowHaystack, selectAllCapped, selectPage, toggleId, writePageSize, type PortalPerson,
} from "../participants";
import type { PortalField } from "../form";

const fields: PortalField[] = [
    { name: "first_name", label: "Nombre", type: "text", role: "first_name" },
    { name: "last_name", label: "Apellido", type: "text", role: "last_name" },
    { name: "cedula", label: "Cédula", type: "text" },
    { name: "familia", label: "Familia", type: "text", is_group: 1 },
    { name: "ciudad", label: "Ciudad", type: "text" },
    { name: "telefono", label: "Teléfono", type: "tel" },
];
const row = (id: number, first: string, last: string, extra: Partial<PortalPerson> = {}): PortalPerson => ({
    id, first_name: first, last_name: last, total_due: 100, amount_paid: 0, payment_status: "unpaid", pending_amount: 0, returned_amount: 0, cancelled: false, ...extra,
});

describe("paging (20 per page; «Mostrar 10/20/50/100»)", () => {
    it("defaults to 20 and only accepts the four sizes", () => {
        expect(DEFAULT_PAGE_SIZE).toBe(20);
        expect([...PAGE_SIZES]).toEqual([10, 20, 50, 100]);
    });
    it("counts pages (at least one) and clamps a page after the list shrank", () => {
        expect(pageCount(0, 20)).toBe(1);
        expect(pageCount(41, 20)).toBe(3);
        expect(clampPage(9, 41, 20)).toBe(3);
        expect(clampPage(0, 41, 20)).toBe(1);
        expect(clampPage(2, 0, 20)).toBe(1);
    });
    it("slices a page and words its range «21–40 de 183»", () => {
        const rows = Array.from({ length: 183 }, (_, i) => i + 1);
        expect(pageSlice(rows, 2, 20)).toEqual(rows.slice(20, 40));
        expect(rangeOf(2, 20, 183)).toEqual({ from: 21, to: 40, total: 183 });
        expect(rangeOf(10, 20, 183)).toEqual({ from: 181, to: 183, total: 183 });
        expect(rangeOf(1, 20, 0)).toEqual({ from: 0, to: 0, total: 0 });
    });
    it("draws the numbered window with ellipses (a one-page gap shows the page)", () => {
        expect(pageWindow(6, 20)).toEqual([1, "…", 5, 6, 7, "…", 20]);
        expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, "…", 20]);
        expect(pageWindow(1, 1)).toEqual([1]);
    });
    it("keeps the first visible row when the size changes", () => {
        expect(pageAfterResize(3, 20, 50)).toBe(1);   // row 41 → page 1 of 50
        expect(pageAfterResize(3, 20, 10)).toBe(5);   // row 41 → page 5 of 10
    });
    it("remembers the size per device and survives a storage that throws", () => {
        const mem = new Map<string, string>();
        const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
        writePageSize(50, PAGE_SIZE_KEY, store);
        expect(mem.get("wjs-portal:pageSize")).toBe("50");
        expect(readPageSize(PAGE_SIZE_KEY, store)).toBe(50);
        mem.set(PAGE_SIZE_KEY, "7");
        expect(readPageSize(PAGE_SIZE_KEY, store)).toBe(20);
        const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
        expect(readPageSize(PAGE_SIZE_KEY, broken)).toBe(20);
        expect(() => writePageSize(10, PAGE_SIZE_KEY, broken)).not.toThrow();
        expect(readPageSize(PAGE_SIZE_KEY, null)).toBe(20);
    });
});

describe("search (accents and case ignored, every word must match)", () => {
    const people = [
        row(1, "Ángela", "Núñez", { ciudad: "Medellín", cedula: "1037" }),
        row(2, "Luis", "Pérez", { custom_data: { ciudad: "Bogotá" } }),
        row(3, "Ana", "Gómez", { ciudad: "Cali" }),
    ];
    it("«angela nunez» finds «Ángela Núñez»; one missing word excludes", () => {
        const h = rowHaystack(people[0], fields);
        expect(matchesQuery(h, "angela nunez")).toBe(true);
        expect(matchesQuery(h, "ANGELA  medellin")).toBe(true);
        expect(matchesQuery(h, "angela bogota")).toBe(false);
        expect(matchesQuery(h, "")).toBe(true);
    });
    it("finds a value through the legacy custom_data copy and any form field", () => {
        const f = { q: "bogota", pay: "all" as const, hideCancelled: false };
        expect(filterPeople(people, fields, f).map((p) => p.id)).toEqual([2]);
        expect(filterPeople(people, fields, { ...f, q: "1037" }).map((p) => p.id)).toEqual([1]);
    });
});

describe("payment state and chips (validated money only; «Cancelada» first)", () => {
    const people = [
        row(1, "A", "A", { amount_paid: 100, payment_status: "paid" }),
        row(2, "B", "B", { amount_paid: 40, payment_status: "partial", pending_amount: 60 }),
        row(3, "C", "C"),
        row(4, "D", "D", { cancelled: true, payment_status: "unpaid" }),
        row(5, "E", "E", { total_due: 0 }),
    ];
    it("derives the pill from cents: paid / partial / unpaid, cancelled before anything", () => {
        expect(people.map(payStateOf)).toEqual(["paid", "partial", "unpaid", "cancelled", "paid"]);
        expect(payStateOf(row(6, "F", "F", { total_due: 33.33, amount_paid: 33.33 }))).toBe("paid");
        expect(isCancelled(row(7, "G", "G", { cancelled: 1 }))).toBe(true);
    });
    it("a cancelled inscription is never «Sin pagar»; «Por validar» = money under review", () => {
        const f = { q: "", pay: "unpaid" as const, hideCancelled: false };
        expect(filterPeople(people, fields, f).map((p) => p.id)).toEqual([3]);
        expect(filterPeople(people, fields, { ...f, pay: "pending" }).map((p) => p.id)).toEqual([2]);
        expect(payFilterCounts(people, fields, { ...f, pay: "all" })).toEqual({ all: 5, unpaid: 1, partial: 1, paid: 2, pending: 1 });
    });
    it("«Ocultar canceladas» hides them (off by default)", () => {
        expect(filterPeople(people, fields, { q: "", pay: "all", hideCancelled: true }).map((p) => p.id)).toEqual([1, 2, 3, 5]);
    });
    it("an older plugin (no pending_amount / cancelled) reads as nothing pending, not cancelled", () => {
        const old: PortalPerson = { id: 9, first_name: "X", last_name: "Y", total_due: 100, amount_paid: 50, payment_status: "partial" };
        expect(payStateOf(old)).toBe("partial");
        expect(filterPeople([old], fields, { q: "", pay: "pending", hideCancelled: false })).toEqual([]);
    });
});

describe("desktop extra columns (up to two, never the name or the grouping field)", () => {
    it("skips the tagged name fields and the family field", () => {
        expect(extraColumns(fields).map((f) => f.name)).toEqual(["cedula", "ciudad"]);
    });
    it("without name roles, skips the two fields that stand in for the name", () => {
        const untagged: PortalField[] = [{ name: "nombres", label: "Nombres", type: "text" }, { name: "apellidos", label: "Apellidos", type: "text" }, { name: "edad", label: "Edad", type: "number" }];
        expect(extraColumns(untagged).map((f) => f.name)).toEqual(["edad"]);
    });
});

describe("multi-select (this page; ≤ 200 per payment; pruned after a reload)", () => {
    it("toggles one id", () => {
        expect(toggleId([1, 2], 3)).toEqual([1, 2, 3]);
        expect(toggleId([1, 2], 2)).toEqual([1]);
    });
    it("the header box is tri-state over THIS page", () => {
        expect(pageSelectionState([1, 2, 3], [])).toBe("none");
        expect(pageSelectionState([1, 2, 3], [2, 9])).toBe("some");
        expect(pageSelectionState([1, 2, 3], [1, 2, 3, 9])).toBe("all");
        expect(pageSelectionState([], [1])).toBe("none");
    });
    it("ticking a page keeps the other pages' ticks; unticking removes only this page", () => {
        expect(selectPage([9], [1, 2], true)).toEqual([9, 1, 2]);
        expect(selectPage([9, 1, 2], [1, 2], false)).toEqual([9]);
    });
    it("never goes past 200", () => {
        const many = Array.from({ length: 250 }, (_, i) => i + 1);
        expect(SELECTION_MAX).toBe(200);
        expect(selectAllCapped(many)).toEqual({ ids: many.slice(0, 200), capped: true });
        expect(selectAllCapped([3, 3, 4])).toEqual({ ids: [3, 4], capped: false });
        expect(selectPage(many.slice(0, 199), [500, 501, 502], true)).toHaveLength(200);
    });
    it("drops ids that left after a reload", () => {
        expect(pruneSelection([1, 2, 3], [3, 1])).toEqual([1, 3]);
    });
    it("compares selections regardless of order", () => {
        expect(idsKey([3, 1, 3])).toBe(idsKey([1, 3]));
    });
});

describe("family groups (the «Pérez (3)» chips)", () => {
    it("groups by the field flagged is_group, sorted, ignoring blanks", () => {
        const people = [row(1, "A", "A", { familia: "Pérez" }), row(2, "B", "B", { familia: " Pérez " }), row(3, "C", "C", { familia: "" }), row(4, "D", "D", { custom_data: { familia: "Gómez" } })];
        expect(familyGroupsOf(people, fields)).toEqual([{ name: "Gómez", ids: [4] }, { name: "Pérez", ids: [1, 2] }]);
        expect(familyGroupsOf(people, fields.filter((f) => !f.is_group))).toEqual([]);
    });
});
