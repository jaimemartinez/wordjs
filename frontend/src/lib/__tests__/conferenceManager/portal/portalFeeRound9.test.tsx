/**
 * «Pagos de cuotas» in the coordinator portal — the ninth round (the sixth review round, the live lab r5-1 and its
 * skeptic; node, no DOM: pure rules, server-rendered screens and the wiring of effects). Each pinned so that undoing
 * it fails here:
 *   - a sheet's notice is brought into sight when it changes (UX6-1): it sits at the top of the sheet's body, and a
 *     refusal after scrolling down to the receipt was out of sight;
 *   - «Manual» → «Iguales» → «Manual» gives the typed amounts back; «Repartir según lo que debe cada uno» still
 *     seeds them (UX6-6); the receipt picker keeps the keyboard focus (UX6-5);
 *   - «✓ Cuadra» only when the split can go (skeptic); a reused client_key with other data says the payment was
 *     recorded and reloads (R6-M2); a person's money line never leaves a «·» alone (UX6-3/UX6-4 twins).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    FeeApiError, balanceC, checkDraft, draftFromTransfer, feeErrorAction, followTotal, manualOnSwitch, manualSeed, newDraft, parseFeeView, parseTransfer, sendDraft, viewBalanceC,
    type DraftContext, type FeeDraft, type PortalFeeApi, type PortalFeeView,
} from "../feePayments";
import { SumLine, personLine, proofFocusTarget } from "../RegisterPaymentSheet";
import { balanceText } from "../FeeBalances";
import { peopleHint } from "../FeeSummary";
import { SheetNotice, revealInSheetBody } from "../ui";

const PORTAL = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8").replace(/\r\n/g, "\n");
const flat = (html: string) => html.replace(/<!-- -->/g, "");
const NB = " ";
const dotAtEnd = (s: string) => /·[\s ]*(?:<\/|$)/.test(s);

const person = (id: number, due: number, validated = 0, pending = 0) => {
    const dueC = Math.round(due * 100);
    const coverC = Math.max(0, dueC - Math.round(validated * 100) - Math.round(pending * 100));
    return { id, due, validated, pending, returned: 0, to_cover: coverC / 100, credit: 0, cancelled: false, payable: coverC > 0 };
};
const view = (): PortalFeeView => parseFeeView({
    features: { fee_payments: 1 }, location: { id: 7, name: "Norte" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200, summary: {},
    people: [person(1, 2500), person(2, 2500), person(3, 1000)], counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [],
})!;
const ctxOf = (v: PortalFeeView): DraftContext => ({ balances: new Map(v.people.map((b) => [b.id, viewBalanceC(b)])), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people });

// ── UX6-1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("UX6-1: a sheet's notice is brought into sight when it changes", () => {
    const box = (top: number, bottom: number, extra: Record<string, unknown> = {}) => ({ getBoundingClientRect: () => ({ top, bottom }), ...extra });
    it("revealInSheetBody scrolls the sheet's body up to a notice above what is shown, down to one below; nothing when in sight", () => {
        const body = { scrollTop: 400, ...box(100, 600) };
        const above = box(-220, -120, { closest: (sel: string) => (sel === "[data-portal-sheet-body]" ? body : null) });
        expect(revealInSheetBody(above)).toBe(-328);   // −220 − 8 − 100
        expect(body.scrollTop).toBe(72);
        const below = box(640, 700, { closest: () => body });
        expect(revealInSheetBody(below)).toBe(108);    // 700 + 8 − 600
        expect(revealInSheetBody(box(200, 300, { closest: () => body }))).toBe(0);
        const into = vi.fn();
        expect(revealInSheetBody(box(0, 1, { closest: () => null, scrollIntoView: into }))).toBe(0);
        expect(into).toHaveBeenCalledWith({ block: "nearest" });
    });
    it("SheetNotice runs it for each new notice (its `n`), on a wrapper around the announced notice", () => {
        const src = read("ui.tsx");
        expect(src).toMatch(/const key = notice \? `\$\{notice\.n\}:\$\{notice\.text\}` : "";\s*React\.useEffect\(\(\) => \{\s*if \(key\) revealInSheetBody\(ref\.current\);\s*\}, \[key\]\);/);
        const out = flat(renderToStaticMarkup(<SheetNotice notice={{ text: "No se pudo eliminar.", tone: "rose", n: 2 }} />));
        expect(out).toMatch(/^<div data-sheet-notice-box=""><div class="[^"]*" role="alert" data-sheet-notice="rose">/);
    });
});

// ── UX6-6 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("UX6-6: «Manual» → «Iguales» → «Manual» gives the typed amounts back", () => {
    const v = view();
    const ctx = ctxOf(v);
    const base = (over: Partial<FeeDraft>): FeeDraft => ({ ...followTotal(newDraft([1, 2, 3], v.methods, null), ctx.balances), ...over });
    it("manualOnSwitch keeps typed amounts (a person without one gets the seed); untyped, it is manualSeed", () => {
        const typed = base({ total: "6000", manual: { 1: "2500", 2: "2500", 3: "1000" }, manualTyped: true });
        expect(manualOnSwitch(typed, ctx)).toEqual({ 1: "2500", 2: "2500", 3: "1000" });
        expect(manualOnSwitch({ ...typed, manual: { 1: "2500", 2: "2500" } }, ctx)).toEqual({ 1: "2500", 2: "2500", 3: "1.000,00" });
        expect(manualOnSwitch({ ...typed, manualTyped: false }, ctx)).toEqual(manualSeed(typed, ctx));
    });
    it("typing marks the draft; the strip goes through manualOnSwitch; «Repartir según lo que debe cada uno» always seeds", () => {
        const src = read("RegisterPaymentSheet.tsx");
        expect(src).toContain('const switchMode = (mode: "equal" | "manual") => setDraft((d) => (d.mode === mode ? d : mode === "manual" ? { ...d, mode, manual: manualOnSwitch(d, ctx) } : { ...d, mode }));');
        expect(src).toContain('const splitByOwed = () => setDraft((d) => ({ ...d, mode: "manual", manual: manualSeed(d, ctx), manualTyped: false }));');
        expect(src).toMatch(/const partInput = \(id: number, v: string\) => setDraft\(\(d\) => \(\{ \.\.\.d, mode: "manual", manualTyped: true,/);
        expect(src).toContain('onClick={splitByOwed} data-action="split-by-owed"');
    });
    it("a payment opened for correction whose split is not «Iguales» counts as typed", () => {
        const t = parseTransfer({
            id: 4, foreign: false, recorded_via: "portal", amount: 600, allocated: 600, method: "Efectivo", reference: null, paid_on: "2026-10-08", note: null,
            status: "pending", review_note: null, alloc_gen: 1, created_at: "2026-10-08 10:00:00", submitted_at: null, updated_at: null, reviewed_at: null, has_proof: false, people: 2,
            allocations: [{ id: 1, inscription_id: 1, amount: 400, moved: false, cancelled: false }, { id: 2, inscription_id: 2, amount: 200, moved: false, cancelled: false }],
            can_edit: true, can_delete: true, duplicate_of: null, reused: false, reused_by: null,
        })!;
        expect(draftFromTransfer(t, "edit", ["Efectivo"]).manualTyped).toBe(true);
        expect(draftFromTransfer({ ...t, allocations: t.allocations.map((a) => ({ ...a, amount: 300 })) }, "edit", ["Efectivo"]).manualTyped).toBe(false);
    });
});

// ── UX6-5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe("UX6-5: the receipt picker keeps the keyboard focus", () => {
    it("proofFocusTarget: «Cambiar», else the empty picker's button", () => {
        const change = { id: "c" } as unknown as HTMLElement, empty = { id: "e" } as unknown as HTMLElement;
        const root = (has: string[]) => ({ querySelector: (sel: string) => (sel === "[data-proof-change]" && has.includes("c") ? change : sel === '[data-proof-state="empty"]' && has.includes("e") ? empty : null) }) as unknown as ParentNode;
        expect(proofFocusTarget(root(["c", "e"]))).toBe(change);
        expect(proofFocusTarget(root(["e"]))).toBe(empty);
        expect(proofFocusTarget(null)).toBeNull();
    });
    it("a pick and «Quitar» remember the focus was inside; it goes back once the picker settles", () => {
        const src = read("RegisterPaymentSheet.tsx");
        expect(src).toMatch(/if \(!file\) return;\s*refocus\.current = refocus\.current \|\| focusWasIn\(\);/);
        expect(src).toMatch(/React\.useEffect\(\(\) => \{\s*if \(working \|\| !refocus\.current\) return;\s*refocus\.current = false;\s*const el = proofFocusTarget\(rootRef\.current\);\s*try \{ el\?\.focus\(\{ preventScroll: true \}\); \}/);
        expect(src).toContain("onClick={removeNew} data-proof-remove=");
        expect(src).toContain("onClick={removeStored} data-proof-remove=");
        expect(src).toContain('<section ref={rootRef} className="space-y-3" data-register-section="proof">');
    });
});

// ── skeptic: the sum line ──────────────────────────────────────────────────────────────────────────────
describe("skeptic: «✓ Cuadra» only when the split can go", () => {
    it("a sum that adds up beside a part over what someone owes is amber: «Una parte supera lo que falta»", () => {
        const v = view();
        const ctx = ctxOf(v);
        const d: FeeDraft = { ...followTotal(newDraft([1, 3], v.methods, null), ctx.balances), total: "3500", mode: "manual", manual: { 1: "2000", 3: "1500" }, manualTyped: true };
        const check = checkDraft(d, ctx);
        expect(check.split.diff).toBe(0);
        expect(check.parts.some((p) => p.over)).toBe(true);
        const out = flat(renderToStaticMarkup(<SumLine check={check} />));
        expect(out).toContain('data-sum-state="over-cap"');
        expect(out).toContain("bg-amber-50");
        expect(out).toContain("Una parte supera lo que falta");
        expect(out).not.toContain("Cuadra");
        const okCheck = checkDraft({ ...d, manual: { 1: "2500", 3: "1000" } }, ctx);
        expect(flat(renderToStaticMarkup(<SumLine check={okCheck} />))).toContain('data-sum-state="ok"');
    });
});

// ── R6-M2 ──────────────────────────────────────────────────────────────────────────────────────────────
describe("R6-M2: a reused client_key with other data — the payment exists: say so and reload, never «sent»", () => {
    it("feeErrorAction → recorded (with its id); sendDraft → fix with a reload", async () => {
        const body = { code: "client_key_changed", id: 12, error: "Este pago ya se había registrado antes con otros datos (pago #12): revísalo en «Pagos» en lugar de enviarlo de nuevo." };
        expect(feeErrorAction(new FeeApiError(409, body, "x"))).toEqual({ kind: "recorded", message: body.error, id: 12 });
        const v = view();
        const ctx = ctxOf(v);
        const d = { ...followTotal(newDraft([1], v.methods, null), ctx.balances), method: "Efectivo" };
        const api: Pick<PortalFeeApi, "create" | "update"> = { create: async () => { throw new FeeApiError(409, body, "x"); }, update: async () => ({ id: 1, view: v }) };
        expect(await sendDraft(api, d, ctx)).toEqual({ kind: "fix", message: body.error, people: {}, reload: true });
    });
});

// ── «·» twins ──────────────────────────────────────────────────────────────────────────────────────────
describe("a person's money line never leaves a «·» at the end of a line", () => {
    it("balanceText, personLine and the «Resumen» hint glue each «·» to the fact after it", () => {
        const b = balanceC({ due: 500, validated: 0, pending: 250 });
        expect(personLine(b)).toBe(`$250,00 por validar ·${NB}falta $250,00`);
        expect(balanceText(b)).toBe(`$250,00 por validar ·${NB}falta $250,00`);
        expect(peopleHint(29, 1)).toBe(`29${NB}inscritos ·${NB}1${NB}cancelada`);
        for (const s of [personLine(b), balanceText(b), peopleHint(29, 1)]) expect(s).not.toMatch(/· /);
        expect(dotAtEnd(personLine(b))).toBe(false);
    });
});
