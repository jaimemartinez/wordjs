/**
 * «Pagos de cuotas» in the coordinator portal (conference-manager ≥ 2.18.0). Node environment, no DOM: the
 * rules are pure functions (feePayments.ts, proofImage.ts), the screens are server-rendered, and the page's
 * wiring is pinned on its source.
 *
 * What the site owner decided, and what is pinned here:
 *   - one receipt, split among people; the split adds up to the cent; «Iguales» (leftover cents to the
 *     first people) by default, «Manual» otherwise (D-P1, D-P2);
 *   - NEVER more than what a person still owes, counting money already awaiting validation (D-P9 «Nunca»);
 *   - the receipt is required for a transfer, optional for cash; photos are shrunk on the phone (D-P11/12);
 *   - only the location's enabled forms of payment; a cancelled inscription owes nothing and cannot be paid
 *     (D-P19);
 *   - «Devolver» → the coordinator corrects and resends, with the administration's note; «Rechazar» → final,
 *     «Duplicar» re-registers it (D-P6/7/10); the administration's own payments show as a read-only line with
 *     the coordinator's part and no receipt (D-P22);
 *   - the «Resumen» is computed per person in cents: cancelled excluded, nobody's overpayment subtracts from
 *     what the others owe, nothing negative (the old StatCards did both wrong);
 *   - ONE request per view (the plugin's per-location throttle), receipts on demand, no polling;
 *   - an older plugin (no `features.fee_payments`) keeps the old bulk flow.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
    BALANCE_FILTERS, BALANCE_FILTER_LABEL, FeeApiError, LAST_METHOD_KEY, STATUS_META, balanceC, barPercents, capOf, checkDraft, createFeeSession, createPortalFeeApi, createProofCache, createViewLoader, draftBody,
    draftFromTransfer, feeBadge, feeErrorAction, followTotal, hasFeePayments, initialMethod, manualSeed, matchesBalanceFilter, mergeBalances, newClientKey, overCapInEqual, registerLoadNotice, reopenDraft,
    newDraft, orderTransfers, parseFeeView, peopleLabel, recorderLabel, rowBalanceC, sendDraft, shortName, summarize, todayLocal, viewBalanceC,
    type BalanceC, type DraftContext, type FeeBody, type FeeDraft, type FetchLike, type PortalFeeApi, type PortalFeeView, type PortalTransfer,
} from "../../../../../../marketplace/plugins/conference-manager/client/portal/feePayments";
import { PROOF_MAX_INPUT_BYTES, PROOF_STEPS, PROOF_TARGET_CHARS, ProofError, dataUrlBytes, fitSize, prepareProof, sizeLabel, type ProofEnv } from "../../../../../../marketplace/plugins/conference-manager/client/portal/proofImage";
import FeeSummary from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeSummary";
import FeeTransfers, { transferRowLabel } from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeTransfers";
import FeeBalances, { balanceRowLabel, balanceText } from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeBalances";
import RegisterPaymentSheet, { ProofPicker, SumLine, afterText, personLine, sheetCopy } from "../../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet";
import { Badge, captionCls, labelCls } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ui";
import { scrollToListTop } from "../../../../../../marketplace/plugins/conference-manager/client/portal/participants";
import TransferSheet, { transferActions } from "../../../../../../marketplace/plugins/conference-manager/client/portal/TransferSheet";
import FeePaymentsTab, { FeeSheets, type FeeHub } from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeePaymentsTab";
import type { PortalPerson } from "../../../../../../marketplace/plugins/conference-manager/client/portal/participants";

const PORTAL = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/client/portal");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const person = (id: number, due: number, validated = 0, pending = 0, extra: Record<string, unknown> = {}) => {
    const cancelled = !!extra.cancelled;
    const dueC = cancelled ? 0 : Math.round(due * 100);
    const coverC = Math.max(0, dueC - Math.round(validated * 100) - Math.round(pending * 100));
    return { id, due: dueC / 100, validated, pending, returned: 0, to_cover: coverC / 100, credit: Math.max(0, validated - dueC / 100), cancelled, payable: !cancelled && coverC > 0, ...extra };
};
const transfer = (id: number, over: Record<string, unknown> = {}) => ({
    id, foreign: false, recorded_via: "portal", amount: 750, allocated: 750, method: "Transferencia", reference: "REF-1", paid_on: "2026-10-07", note: null,
    status: "pending", review_note: null, alloc_gen: 1, created_at: "2026-10-07 10:00:00", submitted_at: "2026-10-07 10:00:00", updated_at: null, reviewed_at: null,
    has_proof: true, people: 2, allocations: [{ id: 501, inscription_id: 1, amount: 500, moved: false, cancelled: false }, { id: 502, inscription_id: 2, amount: 250, moved: false, cancelled: false }],
    can_edit: true, can_delete: true, ...over,
});
const rawView = (over: Record<string, unknown> = {}) => ({
    features: { fee_payments: 1 }, location: { id: 7, name: "Norte" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200,
    summary: {},
    people: [person(1, 500), person(2, 500, 0, 250), person(3, 300, 300), person(4, 400, 0, 0, { cancelled: true })],
    counts: { pending: 1, validated: 0, returned: 0, rejected: 0, total: 1 },
    transfers: [transfer(10)],
    ...over,
});
const view = (over: Record<string, unknown> = {}): PortalFeeView => parseFeeView(rawView(over))!;
const balancesOfView = (v: PortalFeeView) => new Map(v.people.map((b) => [b.id, viewBalanceC(b)]));
const ctxOf = (v: PortalFeeView, over: Partial<DraftContext> = {}): DraftContext => ({ balances: balancesOfView(v), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people, ...over });
const names: Record<number, string> = { 1: "Ana Pérez", 2: "Luis Pérez Gómez", 3: "Rosa Díaz", 4: "Juan Ruiz" };
const nameOf = (id: number) => names[id] ?? `#${id}`;
const draftFor = (ids: number[], over: Partial<FeeDraft> = {}, v = view()): FeeDraft => ({ ...followTotal(newDraft(ids, v.methods, null), balancesOfView(v)), ...over });

// ── parsing and the version-skew flag ──────────────────────────────────────────────────────────────
describe("the view is parsed defensively", () => {
    it("keeps well-formed payments and drops malformed ones; a foreign payment is never editable and has no receipt", () => {
        const v = parseFeeView(rawView({
            transfers: [
                transfer(10),
                { id: "x", status: "pending" },
                transfer(11, { status: "draft" }),
                transfer(12, { foreign: true, recorded_via: "admin", can_edit: true, can_delete: true, has_proof: true }),
            ],
        }))!;
        expect(v.transfers.map((t) => t.id)).toEqual([10, 12]);
        const foreign = v.transfers[1];
        expect([foreign.can_edit, foreign.can_delete, foreign.has_proof]).toEqual([false, false, false]);
    });
    it("is null for a payload without people or payments (never a crash)", () => {
        expect(parseFeeView({})).toBeNull();
        expect(parseFeeView(null)).toBeNull();
        expect(parseFeeView({ people: [], transfers: "nope" })).toBeNull();
    });
    it("«Pagos de cuotas» exists only when /portal/me says so (an older plugin keeps the bulk flow)", () => {
        expect(hasFeePayments({ features: { fee_payments: 1 } })).toBe(true);
        expect(hasFeePayments({})).toBe(false);
        expect(hasFeePayments(null)).toBe(false);
        expect(hasFeePayments({ features: { fee_payments: 0 } })).toBe(false);
    });
    it("the tab badge puts returned payments first, then those awaiting validation", () => {
        expect(feeBadge({ returned: 2, pending: 3 })).toEqual({ text: "2 devueltos", tone: "orange" });
        expect(feeBadge({ returned: 1 })).toEqual({ text: "1 devuelto", tone: "orange" });
        expect(feeBadge({ pending: 3 })).toEqual({ text: "3 por validar", tone: "amber" });
        expect(feeBadge({})).toBeNull();
        expect(feeBadge(undefined)).toBeNull();
    });
});

// ── money (cents) ──────────────────────────────────────────────────────────────────────────────────
describe("a person's money and the location's «Resumen» (cents; cancelled excluded; never negative)", () => {
    it("a cancelled inscription owes nothing and cannot be paid", () => {
        const b = balanceC({ due: 400, validated: 0, pending: 0, cancelled: true });
        expect([b.due, b.toCover, b.payable]).toEqual([0, 0, false]);
    });
    it("what is still to cover counts money awaiting validation and is never negative", () => {
        expect(balanceC({ due: 500, validated: 100, pending: 150 }).toCover).toBe(25000);
        const over = balanceC({ due: 100, validated: 130, pending: 0 });
        expect([over.toCover, over.credit, over.payable]).toEqual([0, 3000, false]);
    });
    it("reads a roster row of an older plugin (no pending_amount) as nothing pending", () => {
        expect(rowBalanceC({ id: 1, total_due: 100, amount_paid: 40 }).toCover).toBe(6000);
    });
    it("one person's overpayment does not subtract from what the others owe (the old «Saldo Pendiente» bug)", () => {
        const s = summarize([balanceC({ due: 100, validated: 150, pending: 0 }), balanceC({ due: 100, validated: 0, pending: 0 })]);
        expect(s.toCover).toBe(10000);           // the old card said 50 (= 200 − 150)
        expect(s.credit).toBe(5000);
        expect(s.validated).toBe(10000);          // validated toward fees; the rest is «A favor»
    });
    it("a cancelled person is out of «Cuotas» and «Por cobrar», and counted apart", () => {
        const s = summarize(view().people.map(viewBalanceC));
        expect(s.due).toBe(130000);              // 500 + 500 + 300; the cancelled 400 is not owed
        expect(s.toCover).toBe(75000);           // 500 + 250
        expect(s.pending).toBe(25000);
        expect(s.validated).toBe(30000);
        expect([s.people, s.cancelled]).toEqual([3, 1]);
    });
    it("the bar's three segments add up to «Cuotas» exactly, and its widths to 100%", () => {
        const s = summarize(view().people.map(viewBalanceC));
        expect(s.bar.validated + s.bar.pending + s.bar.toCover).toBe(s.due);
        const p = barPercents(s.bar);
        expect(Math.round((p.validated + p.pending + p.toCover) * 100) / 100).toBe(100);
        expect(barPercents({ validated: 0, pending: 0, toCover: 0 })).toEqual({ validated: 0, pending: 0, toCover: 0 });
    });
    it("a fresh view patches the roster rows without another request", () => {
        const rows = [{ id: 1, total_due: 500, amount_paid: 0, payment_status: "unpaid", first_name: "Ana" }, { id: 9, total_due: 50, amount_paid: 0, payment_status: "unpaid" }];
        const out = mergeBalances(rows, [{ ...person(1, 500, 500), pending: 0, returned: 20 }]);
        expect(out[0]).toMatchObject({ amount_paid: 500, pending_amount: 0, returned_amount: 20, payment_status: "paid", first_name: "Ana" });
        expect(out[1]).toBe(rows[1]);
        const rows2: PortalPerson[] = [{ id: 2, total_due: 500, amount_paid: 0 }];
        expect(mergeBalances(rows2, [person(2, 500, 120)])[0].payment_status).toBe("partial");
    });
    it("«Saldos» chips: «Con saldo» = still to cover (never cancelled), «Pagados» = a fee the validated money covers", () => {
        const b = view().people.map(viewBalanceC);
        expect(b.map((x) => matchesBalanceFilter(x, "owing"))).toEqual([true, true, false, false]);
        expect(b.map((x) => matchesBalanceFilter(x, "pending"))).toEqual([false, true, false, false]);
        expect(b.map((x) => matchesBalanceFilter(x, "settled"))).toEqual([false, false, true, false]);
        // Someone without a fee is neither owing nor paid (the admin's «Pagados» rule).
        expect(matchesBalanceFilter(viewBalanceC(parseFeeView(rawView({ people: [person(5, 0)] }))!.people[0]), "settled")).toBe(false);
    });
    it("«Saldos» chips say what the admin's say", () => {
        expect(BALANCE_FILTERS.map((f) => BALANCE_FILTER_LABEL[f])).toEqual(["Con saldo", "Por validar", "Devuelto", "Pagados", "Todos"]);
    });
});

describe("labels", () => {
    it("status meta: text + icon, never colour alone", () => {
        expect(STATUS_META.pending).toEqual({ label: "Por validar", tone: "amber", icon: "fa-clock" });
        expect(STATUS_META.returned.label).toBe("Devuelto");
        expect(STATUS_META.rejected.label).toBe("Rechazado");
        expect(STATUS_META.validated.label).toBe("Validado");
    });
    it("«Ana P., Luis P. +1»", () => {
        expect(shortName("Luis Pérez Gómez")).toBe("Luis P.");
        expect(peopleLabel([1, 2, 3], nameOf)).toBe("Ana P., Luis P. +1");
        expect(peopleLabel([1], nameOf)).toBe("Ana P.");
    });
    it("who recorded it: the coordinator, or «Registrado por la administración» (never an admin login)", () => {
        expect(recorderLabel(view().transfers[0])).toBe("Registrado por ti");
        expect(recorderLabel(parseFeeView(rawView({ transfers: [transfer(3, { foreign: true, recorded_via: "admin" })] }))!.transfers[0])).toBe("Registrado por la administración");
    });
    it("«Requiere tu atención»: the coordinator's returned payments first, then newest first", () => {
        const v = view({ transfers: [transfer(3), transfer(5, { status: "returned" }), transfer(8, { status: "validated" }), transfer(9, { foreign: true, recorded_via: "admin", status: "returned" })] });
        const o = orderTransfers(v.transfers);
        expect(o.attention.map((t) => t.id)).toEqual([5]);
        expect(o.rest.map((t) => t.id)).toEqual([9, 8, 3]);
    });
});

// ── the draft ──────────────────────────────────────────────────────────────────────────────────────
describe("«Registrar pago»: the draft and its rules", () => {
    it("starts with the last method used here when it is still enabled, else the first enabled one", () => {
        expect(initialMethod(["Efectivo", "Transferencia"], "Transferencia")).toBe("Transferencia");
        expect(initialMethod(["Efectivo"], "Transferencia")).toBe("Efectivo");
        expect(initialMethod([], null)).toBe("");
        expect(LAST_METHOD_KEY).toBe("wjs-portal:lastMethod");
    });
    it("prefills the total with what the people still owe together (counting money awaiting validation)", () => {
        expect(draftFor([1, 2]).total).toBe("750,00");
        expect(draftFor([1, 2], { totalTouched: true, total: "100" }).total).toBe("100");
    });
    it("a fresh idempotency key per draft, in the server's alphabet", () => {
        const a = newClientKey(), b = newClientKey();
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(newDraft([1], ["Efectivo"], null).clientKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(todayLocal(new Date(2026, 9, 7))).toBe("2026-10-07");
    });
    it("«Iguales» gives the leftover cents to the first people and adds up exactly", () => {
        const v = view({ people: [person(1, 500), person(2, 500), person(3, 500)] });
        const c = checkDraft(draftFor([1, 2, 3], { method: "Efectivo", total: "100", totalTouched: true }, v), ctxOf(v));
        expect(c.parts.map((p) => p.cents)).toEqual([3334, 3333, 3333]);
        expect(c.split).toEqual({ assigned: 10000, diff: 0, ok: true });
        expect(c.canSubmit).toBe(true);
    });
    it("NEVER more than a person still owes: a part over it blocks the send («Nunca»)", () => {
        const v = view();
        // Ana owes 500, Luis 250 (250 awaiting validation): 750 in equal parts gives Luis 375 > 250.
        const c = checkDraft(draftFor([1, 2], { method: "Efectivo" }, v), ctxOf(v));
        expect(c.parts.find((p) => p.id === 2)).toMatchObject({ cents: 37500, cap: 25000, over: true });
        expect(c.canSubmit).toBe(false);
        expect(c.problems).toContain("Una parte supera lo que falta por pagar: cambia a «Manual» para repartir según lo que debe cada uno.");
        // «Manual» seeded with what each one owes is exact and within the caps.
        const d = draftFor([1, 2], { method: "Efectivo" }, v);
        const m = { ...d, mode: "manual" as const, manual: manualSeed(d, ctxOf(v)) };
        expect(m.manual).toEqual({ 1: "500,00", 2: "250,00" });
        const ok = checkDraft(m, ctxOf(v));
        expect(ok.canSubmit).toBe(true);
        expect(ok.parts.map((p) => p.afterOwed)).toEqual([0, 0]);
    });
    it("correcting a PENDING payment may keep its own part (the server leaves it out of its cap); a returned one may not", () => {
        const v = view({ people: [person(1, 500, 0, 500)] });   // all of Ana's fee is in the payment being edited
        const t = view({ transfers: [transfer(10, { amount: 500, allocations: [{ id: 1, inscription_id: 1, amount: 500, moved: false, cancelled: false }] })] }).transfers[0];
        const d = draftFromTransfer(t, "edit", v.methods);
        expect(capOf(d, balancesOfView(v).get(1), 1)).toBe(50000);
        expect(checkDraft(d, ctxOf(v)).canSubmit).toBe(true);
        const returned = draftFromTransfer({ ...t, status: "returned" }, "edit", v.methods);
        expect(capOf(returned, balanceC({ due: 500, validated: 0, pending: 0 }), 1)).toBe(50000);
        expect(capOf(returned, balanceC({ due: 500, validated: 0, pending: 0 }), 1)).toBe(capOf({ ownParts: {}, ownPending: false }, balanceC({ due: 500, validated: 0, pending: 0 }), 1));
    });
    it("the split must add up to the cent: «Faltan» / «Sobran»", () => {
        const v = view();
        const short = checkDraft(draftFor([1, 2], { method: "Efectivo", mode: "manual", manual: { 1: "400", 2: "250" } }, v), ctxOf(v));
        expect(short.split.diff).toBe(10000);
        expect(short.problems).toContain("Faltan $100,00 por repartir.");
        const over = checkDraft(draftFor([1, 2], { method: "Efectivo", mode: "manual", manual: { 1: "500", 2: "260" } }, v), ctxOf(v));
        expect(over.problems.some((p) => p.startsWith("Sobran $10,00"))).toBe(true);
    });
    it("the receipt is required for a transfer and optional for cash", () => {
        const v = view();
        const d = { ...draftFor([1], {}, v), method: "Transferencia" };
        expect(checkDraft(d, ctxOf(v))).toMatchObject({ proofRequired: true, canSubmit: false });
        expect(checkDraft({ ...d, proof: "data:image/jpeg;base64,AAAA" }, ctxOf(v)).canSubmit).toBe(true);
        expect(checkDraft({ ...d, method: "Efectivo" }, ctxOf(v))).toMatchObject({ proofRequired: false, canSubmit: true });
    });
    it("a stored receipt counts until it is removed (an edit; «Duplicar» copies the rejected payment's)", () => {
        const v = view();
        const t = v.transfers[0];
        const edit = draftFromTransfer({ ...t, status: "returned" }, "edit", v.methods);
        const ctx = ctxOf(v, { balances: new Map<number, BalanceC>([[1, balanceC({ due: 500, validated: 0, pending: 0 })], [2, balanceC({ due: 500, validated: 0, pending: 250 })]]) });
        expect(checkDraft(edit, ctx).canSubmit).toBe(true);
        expect(checkDraft({ ...edit, removeStoredProof: true }, ctx).canSubmit).toBe(false);
        const dup = draftFromTransfer({ ...t, status: "rejected" }, "duplicate", v.methods);
        expect([dup.copyFrom, dup.hasStoredProof, dup.kind, dup.editId]).toEqual([10, true, "duplicate", null]);
        expect(draftFromTransfer({ ...t, status: "rejected", has_proof: false }, "duplicate", v.methods).copyFrom).toBeNull();
    });
    it("«Duplicar» is the same receipt: it keeps the payment date and the reference (like the admin's)", () => {
        const t = view().transfers[0];
        const dup = draftFromTransfer({ ...t, status: "rejected", paid_on: "2026-10-01", reference: "REF-7" }, "duplicate", view().methods);
        expect([dup.paidOn, dup.reference]).toEqual(["2026-10-01", "REF-7"]);
    });
    it("only the location's enabled forms of payment; none enabled → nothing can be sent", () => {
        const v = view();
        expect(checkDraft({ ...draftFor([1], {}, v), method: "Cheque" }, ctxOf(v)).canSubmit).toBe(false);
        const none = checkDraft({ ...draftFor([1], {}, v), method: "" }, ctxOf(v, { methods: [] }));
        expect(none.problems).toContain("La administración no ha habilitado formas de pago para esta localidad.");
    });
    it("a cancelled person, an empty list, a zero total or a bad date cannot be sent", () => {
        const v = view();
        expect(checkDraft(draftFor([4], { method: "Efectivo", total: "10", totalTouched: true }, v), ctxOf(v)).problems).toContain("Una inscripción cancelada no puede recibir pagos.");
        expect(checkDraft(draftFor([], { method: "Efectivo" }, v), ctxOf(v)).problems[0]).toBe("Elige al menos una persona.");
        expect(checkDraft(draftFor([1], { method: "Efectivo", total: "0", totalTouched: true }, v), ctxOf(v)).canSubmit).toBe(false);
        expect(checkDraft(draftFor([1], { method: "Efectivo", paidOn: "" }, v), ctxOf(v)).canSubmit).toBe(false);
    });
    it("a payment date after tomorrow cannot be sent (the server's and the admin's rule)", () => {
        const v = view();
        const ctx = ctxOf(v, { today: new Date(2026, 9, 8, 12) });
        expect(checkDraft(draftFor([1], { method: "Efectivo", paidOn: "2026-10-09" }, v), ctx).canSubmit).toBe(true);
        expect(checkDraft(draftFor([1], { method: "Efectivo", paidOn: "2026-10-10" }, v), ctx).problems).toContain("La fecha del pago no puede ser futura.");
    });
    it("the body: integer-cent amounts back as 2-decimal numbers that add up; the key on a create, `expected` on an edit", () => {
        const v = view({ people: [person(1, 500), person(2, 500), person(3, 500)] });
        const d = draftFor([1, 2, 3], { method: "Efectivo", total: "100", totalTouched: true, reference: "  R-9 ", note: " " }, v);
        const body = draftBody(d, checkDraft(d, ctxOf(v)));
        expect(body).toMatchObject({ amount: 100, method: "Efectivo", reference: "R-9", note: null, client_key: d.clientKey });
        expect(body.allocations).toEqual([{ inscription_id: 1, amount: 33.34 }, { inscription_id: 2, amount: 33.33 }, { inscription_id: 3, amount: 33.33 }]);
        expect(Math.round(body.allocations.reduce((s, a) => s + a.amount * 100, 0))).toBe(10000);
        expect("proof" in body).toBe(false);
        const t = view().transfers[0];
        const edit = draftFromTransfer(t, "edit", v.methods);
        const eb = draftBody(edit, checkDraft(edit, ctxOf(view(), { balances: new Map([[1, balanceC({ due: 500, validated: 0, pending: 500 })], [2, balanceC({ due: 500, validated: 0, pending: 250 })]]) })));
        expect(eb.expected).toEqual({ status: "pending", alloc_gen: 1 });
        expect(eb.client_key).toBeUndefined();
        expect("proof" in eb).toBe(false);                                  // kept as it is
        expect(draftBody({ ...edit, removeStoredProof: true, method: "Efectivo" }, checkDraft(edit, ctxOf(view()))).proof).toBeNull();
        const dup = draftFromTransfer({ ...t, status: "rejected" }, "duplicate", v.methods);
        expect(draftBody(dup, checkDraft(dup, ctxOf(view()))).copy_proof_from).toBe(10);
        expect(draftBody({ ...d, allowDuplicateReference: true }, checkDraft(d, ctxOf(v))).allow_duplicate_reference).toBe(true);
    });
    it("an edit opens in «Iguales» when the parts are the equal split, else in «Manual»", () => {
        const equal = transfer(1, { amount: 100, allocations: [{ id: 1, inscription_id: 1, amount: 50, moved: false, cancelled: false }, { id: 2, inscription_id: 2, amount: 50, moved: false, cancelled: false }] });
        expect(draftFromTransfer(parseFeeView(rawView({ transfers: [equal] }))!.transfers[0], "edit", ["Efectivo"]).mode).toBe("equal");
        expect(draftFromTransfer(view().transfers[0], "edit", ["Efectivo", "Transferencia"])).toMatchObject({ mode: "manual", manual: { 1: "500,00", 2: "250,00" }, reference: "REF-1", paidOn: "2026-10-07" });
    });
});

// ── the network ────────────────────────────────────────────────────────────────────────────────────
type Call = { url: string; init: RequestInit | undefined };
const fakeFetch = (answers: Array<{ status: number; body: unknown } | Error>) => {
    const calls: Call[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, init });
        const a = answers.shift() ?? { status: 200, body: rawView() };
        if (a instanceof Error) throw a;
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    };
    return { fn, calls };
};
const headers = (extra: Record<string, string> = {}) => ({ ...extra, "x-portal-token": "tok", "X-CSRF-Token": "c" });

describe("the API client", () => {
    it("GET /portal/fee-payments with the portal token and the cookie; no Content-Type on a read", async () => {
        const f = fakeFetch([{ status: 200, body: rawView() }]);
        const v = await createPortalFeeApi(headers, f.fn).load();
        expect(v.people).toHaveLength(4);
        expect(f.calls[0].url).toBe("/api/v1/plugin/conference-manager/portal/fee-payments");
        expect(f.calls[0].init).toMatchObject({ method: "GET", credentials: "include", headers: { "x-portal-token": "tok", "X-CSRF-Token": "c" } });
        expect((f.calls[0].init!.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });
    it("writes send JSON and read the whole view back; DELETE carries `expected`", async () => {
        const f = fakeFetch([{ status: 200, body: { success: true, id: 33, replayed: false, view: rawView() } }, { status: 200, body: { success: true, id: 33, view: rawView() } }, { status: 200, body: { success: true, view: rawView() } }]);
        const api = createPortalFeeApi(headers, f.fn);
        const body = { amount: 1, method: "Efectivo", paid_on: "2026-10-07", reference: null, note: null, allocations: [{ inscription_id: 1, amount: 1 }], client_key: "abcdefgh" };
        expect((await api.create(body)).id).toBe(33);
        await api.update(33, { ...body, expected: { status: "returned", alloc_gen: 2 } });
        await api.remove(33, { status: "pending", alloc_gen: 3 });
        expect(f.calls.map((c) => [c.init!.method, c.url.replace("/api/v1/plugin/conference-manager", "")])).toEqual([
            ["POST", "/portal/fee-payments"], ["PUT", "/portal/fee-payments/33"], ["DELETE", "/portal/fee-payments/33"],
        ]);
        expect((f.calls[0].init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        expect(JSON.parse(String(f.calls[2].init!.body))).toEqual({ expected: { status: "pending", alloc_gen: 3 } });
    });
    it("the receipt only on demand, from the payment's own route", async () => {
        const f = fakeFetch([{ status: 200, body: { id: 10, proof: "data:image/jpeg;base64,AA" } }, { status: 404, body: { error: "Pago no encontrado.", code: "not_found" } }]);
        const api = createPortalFeeApi(headers, f.fn);
        expect(await api.proof(10)).toBe("data:image/jpeg;base64,AA");
        expect(f.calls[0].url).toMatch(/\/portal\/fee-payments\/10\/proof$/);
        await expect(api.proof(11)).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
    it("a refusal becomes a FeeApiError with the server's Spanish message and code; no network → status 0", async () => {
        const f = fakeFetch([{ status: 409, body: { error: "El pago supera lo que falta.", code: "over_cap", people: [{ inscription_id: 2, amount: 375, max: 250 }] } }, new TypeError("offline")]);
        const api = createPortalFeeApi(headers, f.fn);
        const err = await api.create({} as FeeBody).catch((e) => e);
        expect(err).toBeInstanceOf(FeeApiError);
        expect([err.status, err.code, err.message]).toEqual([409, "over_cap", "El pago supera lo que falta."]);
        expect(feeErrorAction(err)).toEqual({ kind: "over_cap", message: "El pago supera lo que falta.", people: [{ id: 2, max: 25000 }] });
        expect((await api.load().catch((e) => e)).status).toBe(0);
    });
    it("ONE load per view: a second load while the first runs shares it (StrictMode, a double tap)", async () => {
        const f = fakeFetch([{ status: 200, body: rawView() }, { status: 200, body: rawView() }]);
        const loader = createViewLoader(createPortalFeeApi(headers, f.fn));
        const [a, b] = await Promise.all([loader.load(), loader.load()]);
        expect(a).toBe(b);
        expect(f.calls).toHaveLength(1);
        await loader.load();
        expect(f.calls).toHaveLength(2);
    });
    it("receipts are cached (the last 10) and fetched once each", async () => {
        const proof = vi.fn(async (id: number) => `data:image/jpeg;base64,${id}`);
        const cache = createProofCache({ proof }, 2);
        await Promise.all([cache.get(1), cache.get(1)]);
        await cache.get(2);
        await cache.get(1);
        expect(proof).toHaveBeenCalledTimes(2);
        await cache.get(3);                       // evicts 2 (1 was used more recently)
        await cache.get(2);
        expect(proof).toHaveBeenCalledTimes(4);
        cache.clear();
        expect(cache.peek(1)).toBeNull();
    });
});

describe("sending a draft (what the sheet does with each answer)", () => {
    const v = view();
    const ctx = ctxOf(v);
    const d = draftFor([1], { method: "Efectivo" }, v);
    const api = (impl: Partial<PortalFeeApi>): Pick<PortalFeeApi, "create" | "update"> => ({
        create: impl.create ?? (async () => ({ id: 1, replayed: false, view: v })), update: impl.update ?? (async () => ({ id: 1, view: v })),
    });
    const refuse = (status: number, body: Record<string, unknown>) => async () => { throw new FeeApiError(status, body, "x"); };

    it("a create answers with the new view and «queda por validar»", async () => {
        const out = await sendDraft(api({}), d, ctx);
        expect(out).toMatchObject({ kind: "sent", id: 1, toast: "Pago enviado ($500,00): queda por validar." });
    });
    it("after a network failure the retry sends the SAME idempotency key (it can never be recorded twice)", async () => {
        const keys: string[] = [];
        let first = true;
        const flaky = api({ create: async (b) => { keys.push(String(b.client_key)); if (first) { first = false; throw new FeeApiError(0, {}, "Sin conexión."); } return { id: 2, replayed: true, view: v }; } });
        expect((await sendDraft(flaky, d, ctx)).kind).toBe("retry");
        const again = await sendDraft(flaky, d, ctx);
        expect(again).toMatchObject({ kind: "sent", toast: "Ese pago ya estaba registrado." });
        expect(keys).toEqual([d.clientKey, d.clientKey]);
    });
    it("over the cap → each person's maximum inline, and the balances reload", async () => {
        const out = await sendDraft(api({ create: refuse(409, { code: "over_cap", people: [{ inscription_id: 1, amount: 500, max: 120.5 }] }) }), d, ctx);
        expect(out).toEqual({ kind: "fix", message: "Alguien ya tiene pagos registrados que no veías: revisa los montos.", people: { 1: "Supera lo que falta: máximo $120,50." }, reload: true });
    });
    it("a repeated transfer reference asks before registering it anyway", async () => {
        const out = await sendDraft(api({ create: refuse(409, { code: "duplicate_reference", error: "Esa referencia ya se usó en otro pago.", other: { id: 4 } }) }), d, ctx);
        expect(out).toEqual({ kind: "confirm_reference", message: "Esa referencia ya se usó en otro pago.", otherId: 4 });
        const hidden = await sendDraft(api({ create: refuse(409, { code: "duplicate_reference", error: "x", other: null }) }), d, ctx);
        expect(hidden).toMatchObject({ otherId: null });
    });
    it("someone changed the payment meanwhile (stale / gone) → close and reload; 401 → back to the login", async () => {
        const t = draftFromTransfer(v.transfers[0], "edit", v.methods);
        const editCtx = ctxOf(v, { balances: new Map([[1, balanceC({ due: 500, validated: 0, pending: 500 })], [2, balanceC({ due: 500, validated: 0, pending: 250 })]]) });
        const update = vi.fn(refuse(409, { code: "stale", error: "Otra persona cambió este pago; vuelve a cargarlo." }));
        expect(await sendDraft(api({ update }), t, editCtx)).toEqual({ kind: "stale", message: "Otra persona cambió este pago; vuelve a cargarlo. Se recargaron los pagos." });
        expect(update).toHaveBeenCalledWith(10, expect.objectContaining({ expected: { status: "pending", alloc_gen: 1 } }));
        expect((await sendDraft(api({ update: refuse(404, { code: "not_found" }) }), t, editCtx)).kind).toBe("stale");
        expect(await sendDraft(api({ create: refuse(401, { error: "No token" }) }), d, ctx)).toEqual({ kind: "unauthorized" });
    });
    it("a refusal naming people marks those rows", async () => {
        const out = await sendDraft(api({ create: refuse(400, { code: "cancelled_people", error: "Una inscripción cancelada no puede recibir pagos.", ids: [1] }) }), d, ctx);
        expect(out).toMatchObject({ kind: "fix", people: { 1: "Una inscripción cancelada no puede recibir pagos." } });
    });
    it("an invalid draft is never sent", async () => {
        const create = vi.fn();
        expect((await sendDraft(api({ create }), { ...d, total: "0" }, ctx)).kind).toBe("invalid");
        expect(create).not.toHaveBeenCalled();
    });
});

// ── the receipt photo ─────────────────────────────────────────────────────────────────────────────
type Img = { width: number; height: number };
const fileOf = (size: number, type = "image/jpeg") => ({ size, type }) as unknown as Blob & { size: number; type: string };
const env = (sizes: (w: number, h: number, q: number) => number, opts: { decodeFails?: boolean; raw?: string } = {}) => {
    const encoded: [number, number, number][] = [];
    const e: ProofEnv<Img> = {
        decode: vi.fn(async () => { if (opts.decodeFails) throw new Error("no"); return { width: 4032, height: 3024 }; }),
        encode: async (_i, w, h, q) => { encoded.push([w, h, q]); return "data:image/jpeg;base64," + "A".repeat(sizes(w, h, q)); },
        readRaw: async () => opts.raw ?? "data:image/jpeg;base64,AAAA",
    };
    return { e, encoded };
};

describe("the receipt is shrunk on the phone to ≤ 1 MB (proofImage)", () => {
    it("a 4–8 MB camera photo comes out as a JPEG data URL within the target at the first step that fits", async () => {
        const { e, encoded } = env((w, _h, q) => (w >= 1600 && q > 0.75 ? 1_200_000 : 700_000));
        const r = await prepareProof(fileOf(6 * 1024 * 1024), e);
        expect(r.dataUrl.length).toBeLessThanOrEqual(PROOF_TARGET_CHARS);
        expect(r.compressed).toBe(true);
        expect(encoded).toEqual([[1600, 1200, 0.82], [1600, 1200, 0.7]]);
    });
    it("goes down to 1280 px and 1024 px when 1600 px is still too big", async () => {
        const { e, encoded } = env((w) => (w > 1024 ? 2_000_000 : 900_000));
        await prepareProof(fileOf(8 * 1024 * 1024), e);
        expect(encoded.map(([w]) => w)).toEqual(PROOF_STEPS.map((s) => s.side));
        expect(encoded.at(-1)).toEqual([1024, 768, 0.6]);
    });
    it("refuses a file over 15 MB before decoding it, and anything that is not an image", async () => {
        const { e } = env(() => 10);
        await expect(prepareProof(fileOf(PROOF_MAX_INPUT_BYTES + 1), e)).rejects.toMatchObject({ code: "too_big" });
        expect(e.decode).not.toHaveBeenCalled();
        await expect(prepareProof(fileOf(1000, "application/pdf"), e)).rejects.toBeInstanceOf(ProofError);
    });
    it("a browser that cannot decode it still sends a small original; otherwise it says how to fix it", async () => {
        const small = env(() => 10, { decodeFails: true });
        expect(await prepareProof(fileOf(300_000, "image/png"), small.e)).toMatchObject({ compressed: false, dataUrl: "data:image/jpeg;base64,AAAA" });
        const big = env(() => 10, { decodeFails: true, raw: "data:image/png;base64," + "A".repeat(1_500_000) });
        await expect(prepareProof(fileOf(1_200_000, "image/png"), big.e)).rejects.toMatchObject({ code: "unreadable", message: "No pudimos reducir la imagen; prueba con una captura de pantalla." });
        const heic = env(() => 10, { decodeFails: true });
        await expect(prepareProof(fileOf(300_000, "image/heic"), heic.e)).rejects.toMatchObject({ code: "unreadable" });
    });
    it("never enlarges a small picture; sizes are shown in KB / MB", () => {
        expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
        expect(fitSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
        expect(dataUrlBytes("data:image/jpeg;base64,AAAA")).toBe(3);
        expect(sizeLabel(319_488)).toBe("312 KB");
        expect(sizeLabel(1.25 * 1024 * 1024)).toBe("1,3 MB");
    });
});

// ── the screens (server-rendered) ──────────────────────────────────────────────────────────────────
describe("«Resumen» tiles", () => {
    it("Cuotas / Validado / Por validar / Por cobrar; Devuelto and A favor only when there is any", () => {
        const html = flat(renderToStaticMarkup(<FeeSummary summary={summarize(view().people.map(viewBalanceC))} />));
        expect(html).toMatch(/data-testid="kpi-due"[\s\S]*?\$1\.300,00/);
        expect(html).toMatch(/data-testid="kpi-to-cover"[\s\S]*?\$750,00/);
        expect(html).toMatch(/data-testid="kpi-pending"[\s\S]*?\$250,00/);
        expect(html).toContain("3\u00a0inscritos ·\u00a01\u00a0cancelada");
        expect(html).not.toContain('data-testid="kpi-returned"');
        expect(html).not.toContain('data-testid="kpi-credit"');
        const more = flat(renderToStaticMarkup(<FeeSummary summary={summarize([balanceC({ due: 100, validated: 150, pending: 0, returned: 30 })])} />));
        expect(more).toContain('data-testid="kpi-returned"');
        expect(more).toMatch(/data-testid="kpi-credit"[\s\S]*?\$50,00/);
    });
});

describe("«Pagos»", () => {
    const list = view({
        transfers: [
            transfer(3),
            transfer(5, { status: "returned", review_note: "El monto no coincide con el comprobante" }),
            transfer(6, { status: "rejected", review_note: "No se recibió el dinero" }),
            transfer(9, { foreign: true, recorded_via: "admin", status: "validated", amount: 200, reference: null, has_proof: false, allocations: [{ id: 1, inscription_id: 3, amount: 200, moved: false, cancelled: false }] }),
        ],
    }).transfers;
    const html = flat(renderToStaticMarkup(<FeeTransfers transfers={list} nameOf={nameOf} onOpen={() => {}} canRecord />));
    it("puts the returned payment under «Requiere tu atención» with the administration's note", () => {
        const attention = html.slice(html.indexOf('data-testid="attention"'), html.indexOf('data-testid="transfer-list"'));
        expect(attention).toContain('data-transfer-row="5"');
        expect(attention).toContain("Nota de la administración: El monto no coincide con el comprobante");
        expect(attention).not.toContain('data-transfer-row="3"');
    });
    it("shows the administration's payment as a read-only line with the coordinator's part", () => {
        expect(html).toContain("Registrado por la administración · tu parte $200,00");
        expect(html).toContain("Nota de la administración: No se recibió el dinero");
        // Each fact whole, with its own «· » (round 8, PUX-10).
        expect(html).toContain('<span class="whitespace-nowrap font-black text-gray-900 tabular-nums">$750,00</span><span class="whitespace-nowrap font-bold text-gray-500">· Transferencia</span><span class="whitespace-nowrap font-bold text-gray-500">· 07/10/2026</span>');
        expect(html).toContain("Ana P., Luis P.");
    });
    it("«Ver sus pagos» narrows the list to one person; an empty list offers to register one", () => {
        const one = flat(renderToStaticMarkup(<FeeTransfers transfers={list} nameOf={nameOf} onOpen={() => {}} personId={3} onClearPerson={() => {}} canRecord />));
        expect(one).toContain("Pagos de Rosa Díaz");
        expect(one).toContain('data-transfer-row="9"');
        expect(one).not.toContain('data-transfer-row="3"');
        const empty = flat(renderToStaticMarkup(<FeeTransfers transfers={[]} nameOf={nameOf} onOpen={() => {}} onRegister={() => {}} canRecord />));
        expect(empty).toContain("Aún no has registrado pagos.");
        expect(empty).toContain("Registrar pago");
    });
});

describe("«Saldos» (multi-select)", () => {
    const balances = balancesOfView(view());
    const render = (selected: number[] = [], canRecord = true) => flat(renderToStaticMarkup(
        <FeeBalances balances={balances} nameOf={nameOf} groups={[{ name: "Pérez", ids: [1, 2] }]} selected={selected} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord={canRecord} />,
    ));
    it("«Con saldo» by default: who still owes something (never the cancelled or those up to date)", () => {
        const html = render();
        expect(html).toContain('data-balance-row="1"');
        expect(html).toContain('data-balance-row="2"');
        expect(html).not.toContain('data-balance-row="3"');
        expect(html).not.toContain('data-balance-row="4"');
        expect(html).toContain("$250,00 por validar ·\u00a0falta $250,00");
        expect(html).toContain("debe $500,00");
    });
    it("each row has a 44 px checkbox; the family chip offers the group's people who owe", () => {
        const html = render();
        expect(html).toMatch(/<label class="[^"]*min-w-11 min-h-11[^"]*"[^>]*data-touch-check=""><input type="checkbox"[^>]*aria-label="Seleccionar a Ana Pérez"/);
        expect(html).toContain('data-group-chip="Pérez"');
        expect(html).toContain("Pérez (2)");
    });
    it("the bar at the bottom says how many and how much, and opens the payment", () => {
        expect(render()).not.toContain('data-testid="selection-bar"');
        const html = render([1, 2]);
        expect(html).toMatch(/data-testid="selection-bar"[\s\S]*2 seleccionadas · <span class="tabular-nums">\$750,00<\/span> por cobrar[\s\S]*Registrar pago \(2\)/);
        expect(html).toMatch(/class="sticky bottom-0[^"]*pb-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\]/);
    });
    it("a cancelled person, or one with nothing left to cover, can never be ticked (seen under «Todos»)", () => {
        const html = flat(renderToStaticMarkup(
            <FeeBalances balances={balances} nameOf={nameOf} groups={[]} selected={[]} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord initialFilter="all" />,
        ));
        const box = (name: string) => new RegExp(`<input type="checkbox"[^>]*aria-label="Seleccionar a ${name}"[^>]*>`).exec(html)![0];
        expect(box("Ana Pérez")).not.toContain("disabled");
        expect(box("Rosa Díaz")).toContain('disabled=""');     // up to date
        expect(box("Juan Ruiz")).toContain('disabled=""');     // cancelled
        expect(html).toMatch(/data-balance-row="4"[\s\S]*?Cancelada/);
    });
    it("nothing can be ticked when the location has no enabled form of payment", () => {
        const html = render([], false);
        expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*aria-label="Seleccionar a Ana Pérez"|aria-label="Seleccionar a Ana Pérez"[^>]*disabled=""/);
    });
    it("words a row's money in one line", () => {
        // Each «·» glued to the fact after it (U+00A0): a narrow line never ends with it.
        expect(balanceText(balanceC({ due: 0, validated: 50, pending: 0, cancelled: true }))).toBe("Cancelada ·\u00a0$50,00 pagados");
        expect(balanceText(balanceC({ due: 100, validated: 100, pending: 0 }))).toBe("Al día");
        expect(balanceText(balanceC({ due: 100, validated: 120, pending: 0 }))).toBe("Al día ·\u00a0+$20,00 a favor");
    });
});

describe("the «Registrar pago» sheet", () => {
    const v = view();
    const ctx = ctxOf(v);
    const render = (d: FeeDraft, over: Partial<React.ComponentProps<typeof RegisterPaymentSheet>> = {}) => flat(renderToStaticMarkup(
        <RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={over.ctx ?? ctx} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} {...over} />,
    ));
    const sendButton = (html: string) => /<button[^>]*data-action="send"[^>]*>/.exec(html)![0];
    it("stays disabled until everything is right, and says why", () => {
        const html = render(draftFor([1, 2], { method: "Transferencia" }, v));
        expect(sendButton(html)).toContain('disabled=""');
        expect(html).toContain("data-register-problems");
        expect(html).toContain("Supera lo que falta: máximo $250,00");
    });
    it("is enabled for an exact, capped, documented split — the indicator says it adds up", () => {
        const d = draftFor([1, 2], { method: "Efectivo" }, v);
        const html = render({ ...d, mode: "manual", manual: manualSeed(d, ctx) });
        expect(sendButton(html)).not.toContain('disabled=""');
        expect(html).toContain("Enviar pago $750,00");
        expect(html).toMatch(/data-sum-state="ok"[\s\S]*Asignado[\s\S]*\$750,00[\s\S]*Cuadra/);
        expect(html).toContain("Queda pagado al validarse");
    });
    it("only the location's enabled methods; none → a notice instead of the choice", () => {
        const one = render(draftFor([1], { method: "Efectivo" }, v), { ctx: { ...ctx, methods: ["Efectivo"] } });
        expect(one).toMatch(/data-testid="register-method"[\s\S]*?Efectivo/);
        expect(one).not.toMatch(/role="radio"[^>]*>Transferencia/);
        const none = render(draftFor([1], { method: "" }, v), { ctx: { ...ctx, methods: [] } });
        expect(none).toContain("La administración no ha habilitado formas de pago para esta localidad.");
        expect(none).not.toContain('data-testid="register-method"');
    });
    it("the receipt: «obligatorio para una transferencia» (the admin's words) / «opcional en efectivo»; one file input for images", () => {
        expect(render(draftFor([1], { method: "Transferencia" }, v))).toContain("(obligatorio para una transferencia)");
        const cash = render(draftFor([1], { method: "Efectivo" }, v));
        expect(cash).toContain("(opcional en efectivo)");
        expect(cash).toMatch(/<input[^>]*type="file" accept="image\/\*"/);
    });
    it("16 px inputs on phones (iOS would zoom), a decimal keypad for money, a date that defaults to today", () => {
        const html = render(draftFor([1, 2], { method: "Efectivo", mode: "manual", manual: { 1: "500", 2: "250" } }, v));
        expect(html).toMatch(/<input[^>]*inputMode="decimal"[^>]*class="[^"]*text-xl/);
        expect(html).toMatch(/<input[^>]*inputMode="decimal"[^>]*class="[^"]*text-base sm:text-sm/);
        // 2.33.1: the host's calendar (a button, no keyboard, so no zoom) carries today's date.
        expect(html).not.toMatch(/<input[^>]*type="date"/);
        expect(html).toMatch(/<button[^>]*data-date-picker="date"[^>]*data-value="\d{4}-\d{2}-\d{2}"/);
    });
    it("server refusals show on the person's row and above the button", () => {
        const html = render(draftFor([1], { method: "Efectivo" }, v), { error: "Sin conexión. Tus datos siguen aquí.", personErrors: { 1: "Supera lo que falta: máximo $1,00." } });
        expect(html).toMatch(/data-register-person="1"[\s\S]*role="alert">Supera lo que falta: máximo \$1,00\./);
        expect(html).toContain("Sin conexión. Tus datos siguen aquí.");
    });
    it("words the sheet by what it does", () => {
        expect(sheetCopy({ kind: "edit", expected: { status: "returned", alloc_gen: 2 } }, 75000)).toEqual({ title: "Corregir y reenviar", send: "Reenviar pago $750,00" });
        expect(sheetCopy({ kind: "edit", expected: { status: "pending", alloc_gen: 1 } }, null).title).toBe("Editar pago");
        expect(sheetCopy({ kind: "new", expected: null }, 1000).send).toBe("Enviar pago $10,00");
        expect(afterText(0)).toBe("Queda pagado al validarse");
        expect(afterText(0, 2500)).toBe("Queda pagado al validarse lo pendiente");
        expect(afterText(12000)).toBe("Faltará $120,00");
        expect(personLine(balanceC({ due: 500, validated: 0, pending: 250 }))).toBe("$250,00 por validar ·\u00a0falta $250,00");
        expect(personLine(undefined)).toBe("Ya no está en tu localidad");
    });
    it("the sum line says «Faltan» / «Sobran» when it does not add up", () => {
        const short = checkDraft(draftFor([1, 2], { method: "Efectivo", mode: "manual", manual: { 1: "400", 2: "250" } }, v), ctx);
        expect(flat(renderToStaticMarkup(<SumLine check={short} />))).toContain("Faltan $100,00");
    });
});

describe("a payment's sheet", () => {
    const t = (over: Partial<PortalTransfer> & Record<string, unknown> = {}) => parseFeeView(rawView({ transfers: [transfer(10, over)] }))!.transfers[0];
    const render = (x: PortalTransfer) => flat(renderToStaticMarkup(
        <TransferSheet transfer={x} nameOf={nameOf} busy={false} onClose={() => {}} onEdit={() => {}} onDuplicate={() => {}} onDelete={() => {}} loadProof={async () => ""} />,
    ));
    it("the coordinator's actions follow the state machine", () => {
        expect(transferActions(t())).toEqual({ edit: true, resend: false, remove: true, duplicate: false });
        expect(transferActions(t({ status: "returned" }))).toEqual({ edit: false, resend: true, remove: true, duplicate: false });
        expect(transferActions(t({ status: "validated", can_edit: false, can_delete: false }))).toEqual({ edit: false, resend: false, remove: false, duplicate: false });
        expect(transferActions(t({ status: "rejected", can_edit: false, can_delete: false }))).toEqual({ edit: false, resend: false, remove: false, duplicate: true });
        expect(transferActions(t({ foreign: true, recorded_via: "admin", status: "rejected" }))).toEqual({ edit: false, resend: false, remove: false, duplicate: false });
    });
    it("a returned payment shows the administration's note and «Corregir y reenviar» / «Eliminar»", () => {
        const html = render(t({ status: "returned", review_note: "Falta una persona" }));
        expect(html).toContain("La administración devolvió este pago para que lo corrijas.");
        expect(html).toContain("«Falta una persona»");
        expect(html).toContain('data-action="resend"');
        expect(html).toContain('data-action="delete"');
        expect(html).not.toContain('data-action="edit"');
    });
    it("the receipt is fetched only when asked for", () => {
        const html = render(t());
        expect(html).toContain('data-action="show-proof"');
        expect(html).not.toContain("<img");
        expect(html).toContain("Total $750,00 = reparto $750,00 ✓");
    });
    it("the administration's payment: no reference, no receipt, no action", () => {
        const html = render(t({ foreign: true, recorded_via: "admin", status: "validated", reference: "SECRET-REF", has_proof: true }));
        expect(html).not.toContain("SECRET-REF");
        expect(html).not.toContain("data-transfer-proof");
        expect(html).not.toContain("data-action=");
        expect(html).toContain("Ves solo la parte de tus participantes, sin comprobante.");
    });
});

// ── the tab and its sheets, over a hub in a given state ───────────────────────────────────────────
const fakeHub = (over: Partial<FeeHub> = {}): FeeHub => ({
    view: view(), loading: false, error: null, load: async () => null, sheet: null, draft: null, setDraft: () => {}, busy: false, preparing: false,
    sheetErrors: { message: null, people: {} }, openRegister: async () => {}, openTransfer: () => {}, openEdit: () => {}, openDuplicate: () => {}, closeSheet: () => {},
    submit: async () => {}, dupRef: null, setDupRef: () => {}, confirmDelete: null, setConfirmDelete: () => {}, remove: async () => {}, selected: [], setSelected: () => {},
    segment: "summary", setSegment: () => {}, personFilter: null, setPersonFilter: () => {}, lastSent: null, setLastSent: () => {}, reset: () => {},
    proofs: createProofCache({ proof: async () => "" }), api: {} as PortalFeeApi, setSheet: () => {},
    ...over,
} as unknown as FeeHub);
const tabHtml = (hub: FeeHub) => flat(renderToStaticMarkup(<FeePaymentsTab hub={hub} nameOf={nameOf} groups={[]} onOpenPerson={() => {}} />));

describe("the «Pagos de cuotas» tab", () => {
    it("loading, then an error with «Reintentar» (never a fake empty state)", () => {
        expect(tabHtml(fakeHub({ view: null, loading: true }))).toContain("Cargando pagos…");
        const err = tabHtml(fakeHub({ view: null, error: "No hay conexión." }));
        expect(err).toContain("No hay conexión.");
        expect(err).toContain("Reintentar");
    });
    it("says how many payments came back, in the right number", () => {
        expect(tabHtml(fakeHub({ view: view({ transfers: [transfer(5, { status: "returned" })] }) }))).toContain("1 pago devuelto por la administración: corrígelo y reenvíalo.");
        expect(tabHtml(fakeHub({ view: view({ transfers: [transfer(5, { status: "returned" }), transfer(6, { status: "returned" })] }) }))).toContain("2 pagos devueltos por la administración: corrígelos y reenvíalos.");
        expect(tabHtml(fakeHub())).not.toContain('data-testid="returned-notice"');
    });
    it("«Resumen» = the figures and «Saldos»; «Pagos» = the list", () => {
        const sum = tabHtml(fakeHub());
        expect(sum).toContain('data-testid="fee-summary"');
        expect(sum).toContain('data-testid="fee-balances"');
        expect(sum).not.toContain('data-testid="fee-transfers"');
        const pays = tabHtml(fakeHub({ segment: "transfers" }));
        expect(pays).toContain('data-testid="fee-transfers"');
        expect(pays).not.toContain('data-testid="fee-balances"');
    });
    it("no enabled method: a notice and a disabled «Registrar pago»", () => {
        const html = tabHtml(fakeHub({ view: view({ methods: [], can_record: false }) }));
        expect(html).toContain("no se pueden registrar pagos por ahora");
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-action="register"/);
    });
    it("after sending: «Pago #N enviado: queda por validar» with «Ver»", () => {
        expect(tabHtml(fakeHub({ lastSent: 10 }))).toContain("Pago #10 enviado: queda por validar por la administración.");
    });
});

describe("the sheets the page renders once", () => {
    const sheets = (hub: FeeHub) => flat(renderToStaticMarkup(<FeeSheets hub={hub} nameOf={nameOf} groups={[]} />));
    it("nothing open → nothing rendered", () => {
        expect(sheets(fakeHub())).toBe("");
    });
    it("a payment, the payment sheet, and the two confirms", () => {
        expect(sheets(fakeHub({ sheet: { kind: "transfer", id: 10 } }))).toContain('data-testid="transfer-sheet"');
        expect(sheets(fakeHub({ sheet: { kind: "register" }, draft: draftFor([1], { method: "Efectivo" }) }))).toContain('data-testid="register-payment-sheet"');
        const dup = sheets(fakeHub({ dupRef: { message: "x", otherId: 4 } }));
        expect(dup).toContain("Esa referencia ya se usó en otro pago (el pago #4). ¿Registrar de todas formas?");
        expect(sheets(fakeHub({ dupRef: { message: "x", otherId: null } }))).toContain("Esa referencia ya se usó en otro pago. ¿Registrar de todas formas?");
        expect(sheets(fakeHub({ confirmDelete: view().transfers[0] }))).toContain("Se eliminará el pago #10 de $750,00.");
    });
});

// ── the page's wiring (source) ────────────────────────────────────────────────────────────────────
describe("page.tsx: the old payment UI is gone; «Pagos de cuotas» only with the plugin's flag", () => {
    const page = read("CoordinatorPortal.tsx");
    it("no StatCards above the tabs, no header «Registrar Pago (N)», no «Registrar Pago Grupal» modal or its handlers", () => {
        expect(page).not.toMatch(/import \{ StatCard \}|<StatCard/);
        expect(page).not.toMatch(/Registrar Pago Grupal|handleBulkPayment|handleFileChange|showPaymentModal|paymentForm|selectedIds/);
        expect(page).not.toContain("/portal/payments/bulk");
        expect(page).not.toMatch(/Saldo Pendiente|Total Recaudado/);
    });
    it("the fees tab and its sheets exist only when /portal/me reports features.fee_payments", () => {
        expect(page).toContain("const feesOn = hasFeePayments(myLocation);");
        expect(page).toMatch(/\.\.\.\(feesOn \? \[\{ key: 'fees' as const, label: 'Pagos de cuotas'/);
        expect(page).toContain("const activeTab = tab === 'fees' && !feesOn ? 'participants' : tab;");
        expect(page).toContain("{feesOn && <FeeSheets hub={feeHub} nameOf={nameOf} groups={familyGroups} />}");
    });
    it("the old bulk dialog survives only for an older plugin (version skew)", () => {
        expect(page).toMatch(/\{!feesOn && legacyPayIds && \(\s*<LegacyBulkPayment/);
        expect(page).toContain("legacy={feesOn ? null : {");
        expect(read("LegacyBulkPayment.tsx")).toContain("await fetch(`${API}/portal/payments/bulk`, {");
    });
    it("a fresh view patches the roster and the badge (no extra request); sign-out forgets the location's payments", () => {
        expect(page).toContain("setInscriptions((rows) => mergeBalances(rows, v.people));");
        expect(page).toContain("fees: { pending: v.counts.pending, returned: v.counts.returned }");
        expect(page).toMatch(/const resetDashboard = \(\) => \{[\s\S]*feeHub\.reset\(\);/);
    });
});

describe("one request per view, no polling (the plugin's per-location throttle)", () => {
    const tab = read("FeePaymentsTab.tsx");
    it("the tab loads once when it mounts, through the de-duplicating loader of its session", () => {
        expect(tab).toContain("useEffect(() => { void load(); }, [load]);");
        expect(tab).toContain("const session = useMemo(() => createFeeSession(api, () => proofs.clear()), [api, proofs]);");
        expect(tab).toMatch(/const o = await session\.load\(\);/);
        expect(read("feePayments.ts")).toContain("const loader = createViewLoader(api);");
    });
    it("nothing in «Pagos de cuotas» polls", () => {
        for (const f of ["FeePaymentsTab.tsx", "FeeSummary.tsx", "FeeBalances.tsx", "FeeTransfers.tsx", "RegisterPaymentSheet.tsx", "TransferSheet.tsx", "feePayments.ts", "ParticipantSheet.tsx", "ParticipantList.tsx"]) {
            expect(read(f), f).not.toMatch(/setInterval|setTimeout\([^)]*load/);
        }
    });
    it("only feePayments.ts talks to /portal/fee-payments", () => {
        expect(read("feePayments.ts")).toContain('call("GET", "/portal/fee-payments")');
        for (const f of fs.readdirSync(PORTAL).filter((x) => /\.(ts|tsx)$/.test(x) && x !== "feePayments.ts")) {
            expect(read(f), f).not.toMatch(/["']\/(api\/v1\/plugin\/conference-manager\/)?portal\/fee-payments|fetch\([^)]*fee-payments/);
        }
    });
});

// ── 2.18.0 live-review fixes ──────────────────────────────────────────────────────────────────────────

describe("the cap of a part is the server's own (due − validated − pending of OTHER payments)", () => {
    it("correcting a pending payment after a returned one was validated meanwhile: the sheet offers 0, like the server", () => {
        // Ana owes 250: validated 250 (the returned P3, validated meanwhile) + pending 250 (P1, being corrected).
        const b = balanceC({ due: 250, validated: 250, pending: 250 });
        expect(b.toCover).toBe(0);
        const editing = { ownPending: true, ownParts: { 1: 25000 } };
        expect(capOf(editing, b, 1)).toBe(0);               // was toCover + own part = 250: refused by the server (409)
        expect(capOf({ ownPending: false, ownParts: {} }, b, 1)).toBe(0);
        // The vectors every implementation answers alike (server assertCaps 'record', admin editCap, this capOf).
        const vectors: [number, number, number, number, boolean, number][] = [
            // due, validated, pending, own part, own pending?, cap
            [500, 100, 150, 0, false, 25000],
            [500, 100, 150, 150, true, 40000],
            [250, 250, 250, 250, true, 0],
            [250, 0, 250, 250, false, 0],
            [250, 300, 0, 0, false, 0],
            [100, 0, 30, 30, true, 10000],
        ];
        for (const [due, validated, pending, own, ownPending, cap] of vectors) {
            expect(capOf({ ownPending, ownParts: { 7: Math.round(own * 100) } }, balanceC({ due, validated, pending }), 7), JSON.stringify([due, validated, pending, own, ownPending])).toBe(cap);
        }
        expect(capOf(editing, undefined, 1)).toBe(0);
        const d = { ...draftFor([1], { method: "Efectivo", total: "250", totalTouched: true }), kind: "edit" as const, ownPending: true, ownParts: { 1: 25000 } };
        const ctx = { balances: new Map([[1, b]]), methods: ["Efectivo"], proofRequiredFor: ["Transferencia"] };
        expect(checkDraft(d, ctx).canSubmit).toBe(false);
    });
});

describe("«Resumen»: Por validar counts each person's pending money only up to what is left of the fee", () => {
    it("a cancelled person's pending money is in no figure; Validado + Por validar + Por cobrar = Cuotas", () => {
        const s = summarize([
            balanceC({ due: 250, validated: 0, pending: 250 }),
            balanceC({ due: 100, validated: 0, pending: 60, cancelled: true }),   // a cancelled person with money awaiting validation
            balanceC({ due: 100, validated: 100, pending: 0, cancelled: true }),  // «Mateo»: paid, then cancelled
            balanceC({ due: 250, validated: 100, pending: 200 }),
        ]);
        expect([s.due, s.validated, s.pending, s.toCover, s.credit]).toEqual([50000, 10000, 40000, 0, 10000]);
        expect(s.validated + s.pending + s.toCover).toBe(s.due);
    });
});

describe("a shared phone: nothing of the previous coordinator's session may land after sign-out", () => {
    const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
    it("a load still downloading when the session ends comes back «ended», and the next load is a request of its own", async () => {
        const calls: ReturnType<typeof deferred<PortalFeeView>>[] = [];
        const api = { load: () => { const d = deferred<PortalFeeView>(); calls.push(d); return d.p; } };
        let cleared = 0;
        const session = createFeeSession(api, () => { cleared++; });
        const first = session.load();                 // coordinator A opens «Pagos de cuotas»…
        session.reset();                              // …and taps «Cerrar sesión» before the view arrives
        expect(cleared).toBe(1);
        const second = session.load();                // coordinator B signs in on the same tab
        expect(calls.length).toBe(2);                 // B's load is not handed A's promise
        calls[0].resolve(view({ location: { id: 1, name: "A" } }));
        calls[1].resolve(view({ location: { id: 2, name: "B" } }));
        expect(await first).toEqual({ kind: "ended" });
        const b = await second;
        expect(b.kind).toBe("ok");
        expect(b.kind === "ok" && b.view.location?.name).toBe("B");
        // A failure of the old session is dropped too (no error banner for the next coordinator).
        const failing = deferred<PortalFeeView>();
        const s2 = createFeeSession({ load: () => failing.p });
        const f = s2.load();
        s2.reset();
        failing.reject(new FeeApiError(500, { error: "x" }, "x"));
        expect(await f).toEqual({ kind: "ended" });
        // guard(): a write's answer of an ended session is null.
        const w = deferred<number>();
        const s3 = createFeeSession({ load: () => deferred<PortalFeeView>().p });
        const g = s3.guard(w.p);
        s3.reset();
        w.resolve(1);
        expect(await g).toBeNull();
    });
    it("the loader forgets its request in flight on reset; the receipt cache forgets its downloads", async () => {
        const calls: ReturnType<typeof deferred<PortalFeeView>>[] = [];
        const loader = createViewLoader({ load: () => { const d = deferred<PortalFeeView>(); calls.push(d); return d.p; } });
        const a = loader.load();
        expect(loader.load()).toBe(a);
        loader.reset();
        loader.load();
        expect(calls.length).toBe(2);
        calls[0].resolve(view());
        await a;
        expect(loader.load()).not.toBe(a);            // the old request's end never clears the new one
        const proofs: ReturnType<typeof deferred<string>>[] = [];
        const cache = createProofCache({ proof: () => { const d = deferred<string>(); proofs.push(d); return d.p; } });
        const p1 = cache.get(5);
        cache.clear();
        cache.get(5);
        expect(proofs.length).toBe(2);                // not handed the previous session's download
        proofs[0].resolve("data:image/png;base64,QQ==");
        await p1;
        expect(cache.peek(5)).toBeNull();             // and that download is not cached for the next one
    });
    it("the hub runs on a session; sign-in ends the previous one as sign-out does", () => {
        const tab = read("FeePaymentsTab.tsx");
        expect(tab).toContain("const session = useMemo(() => createFeeSession(api, () => proofs.clear()), [api, proofs]);");
        expect(tab).toMatch(/const reset = useCallback\(\(\) => \{\s*session\.reset\(\);/);
        expect(tab).toMatch(/const out = await sendDraft\(api, d, contextOf\(v, balancesOf\(v\)\)\);\s*if \(!session\.isCurrent\(e\)\) return;/);
        expect(tab).toMatch(/const r = await api\.remove\([^)]*\);\s*if \(!session\.isCurrent\(e\)\) return;/);
        const page = read("CoordinatorPortal.tsx");
        expect(page).toMatch(/if \(res\.ok && data\.success\) \{\s*\/\/[^\n]*\n\s*feeHub\.reset\(\);/);
    });
});

describe("«Registrar pago de esta persona» says so when the payments cannot be loaded", () => {
    it("a failed load says why — in the sheet that opens, or where the coordinator looks; nothing to say when it worked or the session ended", () => {
        expect(registerLoadNotice({ kind: "error", message: "No hay conexión." })).toBe("No hay conexión. Inténtalo de nuevo.");
        expect(registerLoadNotice({ kind: "error", message: "" })).toBe("No se pudieron cargar los pagos. Inténtalo de nuevo.");
        expect(registerLoadNotice({ kind: "ok", view: view() })).toBeNull();
        expect(registerLoadNotice({ kind: "ended" })).toBeNull();
        expect(registerLoadNotice({ kind: "unauthorized" })).toBeNull();
        const tab = read("FeePaymentsTab.tsx");
        // Round 7: said where the coordinator looks (the sheet that opens, the participant's sheet, else a toast).
        expect(tab).toMatch(/loadNotice = registerLoadNotice\(o\);/);
        expect(tab).toMatch(/if \(why\) say\(why, loadNotice \? "error" : "info"\);/);
        expect(tab).toMatch(/setRegisterNotice\(loadNotice \|\| notice\);/);
    });
});

describe("a kept draft follows the people chosen next (its receipt, reference, method and date stay)", () => {
    const v = view();
    const balances = balancesOfView(v);
    const kept: FeeDraft = { ...draftFor([1, 2], { method: "Transferencia", reference: "BANK-1", proof: "data:image/jpeg;base64,QQ==", paidOn: "2026-10-01", note: "familia", mode: "manual", manual: { 1: "300", 2: "200" } }, v) };
    it("other people: same receipt and details, the new people's split, a new key", () => {
        const d = reopenDraft(kept, [1, 2, 3], v.methods, null, balances);
        expect(d.ids).toEqual([1, 2, 3]);
        expect([d.proof, d.reference, d.method, d.paidOn, d.note]).toEqual([kept.proof, "BANK-1", "Transferencia", "2026-10-01", "familia"]);
        expect(d.manual).toEqual({ 1: "300", 2: "200" });
        expect(d.clientKey).not.toBe(kept.clientKey);
        const fewer = reopenDraft(kept, [2], v.methods, null, balances);
        expect(fewer.manual).toEqual({ 2: "200" });
        expect(fewer.proof).toBe(kept.proof);
    });
    it("the same people, or none asked: the draft as it was; nothing kept: a fresh one", () => {
        expect(reopenDraft(kept, [2, 1], v.methods, null, balances)).toBe(kept);
        expect(reopenDraft(kept, [], v.methods, null, balances)).toBe(kept);
        const fresh = reopenDraft(null, [1], v.methods, null, balances);
        expect([fresh.ids, fresh.proof, fresh.reference]).toEqual([[1], null, ""]);
        expect(read("FeePaymentsTab.tsx")).toContain("setDraftState(reopenDraft(kept, want, v.methods, readLast(), balances));");
    });
});

describe("the «Registrar pago» sheet: the reason «Enviar» waits for sits next to it", () => {
    const v = view();
    const ctx = ctxOf(v);
    const render = (d: FeeDraft, over: Partial<React.ComponentProps<typeof RegisterPaymentSheet>> = {}) => flat(renderToStaticMarkup(
        <RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={over.ctx ?? ctx} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} {...over} />,
    ));
    const foot = (html: string) => html.slice(html.indexOf("data-portal-sheet-foot"));
    it("over the cap in «Iguales»: the footer says why and offers the one-tap split by what each one owes", () => {
        const html = render(draftFor([1, 2], { method: "Efectivo" }, v));     // 750 split 375 / 375; Luis may receive 250
        expect(foot(html)).toMatch(/data-portal-sheet-note=""[\s\S]*role="status"[\s\S]*Una parte supera lo que falta por pagar/);
        expect(foot(html)).toMatch(/data-action="split-by-owed"[^>]*>[\s\S]*Repartir según lo que debe cada uno/);
        expect(foot(html).indexOf("data-portal-sheet-note")).toBeLessThan(foot(html).indexOf('data-action="send"'));
    });
    it("a network failure's message comes first, in the footer; a ready draft has no note", () => {
        const failed = render(draftFor([1], { method: "Efectivo" }, v), { error: "No hay conexión. Tus datos siguen aquí: vuelve a tocar «Enviar»." });
        expect(foot(failed)).toMatch(/data-register-error=""[\s\S]*No hay conexión/);
        const d = draftFor([1, 2], { method: "Efectivo" }, v);
        const ready = render({ ...d, mode: "manual", manual: manualSeed(d, ctx) });
        expect(ready).not.toContain("data-portal-sheet-note");
        expect(overCapInEqual(d, checkDraft(d, ctx))).toBe(true);
        expect(overCapInEqual({ ...d, mode: "manual" }, checkDraft({ ...d, mode: "manual" }, ctx))).toBe(false);
    });
    it("correcting a RETURNED payment shows the administration's note at the top", () => {
        const t = parseFeeView(rawView({ transfers: [transfer(30, { status: "returned", review_note: "El monto no coincide: Ana pagó $200.", method: "Efectivo", has_proof: false, allocations: [{ id: 1, inscription_id: 1, amount: 750, moved: false, cancelled: false }] })] }))!.transfers[0];
        const d = draftFromTransfer(t, "edit", ["Efectivo", "Transferencia"]);
        expect(d.returnNote).toBe("El monto no coincide: Ana pagó $200.");
        expect(render(d)).toMatch(/data-return-note=""[\s\S]*Nota de la administración[\s\S]*El monto no coincide: Ana pagó \$200\./);
        expect(draftFromTransfer({ ...t, status: "pending" }, "edit", ["Efectivo"]).returnNote).toBeNull();
        expect(draftFromTransfer(t, "duplicate", ["Efectivo"]).returnNote).toBeNull();
    });
    it("a photo being shrunk: «Enviar» waits, and «Preparando foto…» shows over a receipt already there", () => {
        const d = draftFor([1], { method: "Efectivo", proof: "data:image/jpeg;base64,QQ==" }, v);
        expect(checkDraft(d, ctx).canSubmit).toBe(true);
        const busy = { ...d, proofWorking: true };
        const check = checkDraft(busy, ctx);
        expect(check.canSubmit).toBe(false);
        expect(check.problems).toContain("Espera: la foto del comprobante se está preparando.");
        const html = render(busy);
        expect(html).toContain('data-proof-state="working"');
        expect(html).toContain("Preparando foto…");
        expect(html).not.toContain('data-proof-state="new"');
        const stored = flat(renderToStaticMarkup(<ProofPicker required proof={null} stored storedLabel="Comprobante actual" working onProof={() => {}} onRemoveStored={() => {}} />));
        expect(stored).toContain('data-proof-state="working"');
        expect(read("RegisterPaymentSheet.tsx")).toMatch(/onWorking\?\.\(true\);[\s\S]*finally \{\s*if \(picks\.isLatest\(mine\)\) onWorking\?\.\(false\);/);
    });
});

describe("legible on a phone outdoors: AA labels, 10 px state pills", () => {
    it("labels and captions are gray-500 (not gray-400); Badge xs is 10 px; the gray tone is gray-600", () => {
        expect(labelCls).toContain("text-gray-500");
        expect(labelCls).not.toContain("text-gray-400");
        expect(captionCls).toContain("text-gray-500");
        const pill = flat(renderToStaticMarkup(<Badge tone="gray" size="xs">Cancelada</Badge>));
        expect(pill).toContain("text-[10px]");
        expect(pill).not.toContain("text-[8px]");
        expect(pill).toContain("text-gray-600");
        const sheet = flat(renderToStaticMarkup(<RegisterPaymentSheet draft={draftFor([1], { method: "Efectivo" })} setDraft={() => {}} ctx={ctxOf(view())} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} />));
        expect(sheet).toMatch(/<h4 class="[^"]*text-gray-500[^"]*">Pago<\/h4>/);
    });
});

describe("a screen reader hears what each row shows", () => {
    it("a payment row: amount, method, date, status, people and the administration's note", () => {
        const t = parseFeeView(rawView({ transfers: [transfer(14, { status: "returned", review_note: "Falta el comprobante" })] }))!.transfers[0];
        expect(transferRowLabel(t, nameOf)).toBe("Pago #14: $750,00, Transferencia, 07/10/2026, Devuelto, Ana P., Luis P., Nota de la administración: Falta el comprobante");
        const html = flat(renderToStaticMarkup(<FeeTransfers transfers={[t]} nameOf={nameOf} onOpen={() => {}} canRecord />));
        expect(html).toContain('aria-label="Pago #14: $750,00, Transferencia, 07/10/2026, Devuelto');
        expect(html).not.toContain("Ver el pago #14");
    });
    it("a «Saldos» row: the name and the money", () => {
        expect(balanceRowLabel("Ana Pérez", balanceC({ due: 500, validated: 0, pending: 0, returned: 100 }))).toBe("Ana Pérez: debe $500,00, Devuelto");
        const html = flat(renderToStaticMarkup(<FeeBalances balances={new Map([[1, balanceC({ due: 500, validated: 100, pending: 150 })]])} nameOf={nameOf} groups={[]} selected={[]} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord />));
        expect(html).toContain('aria-label="Ana Pérez: $150,00 por validar ·\u00a0falta $250,00"');
        expect(html).not.toContain("Ver ficha de Ana Pérez");
    });
});

describe("a page change brings the list's top into view (as «Participantes» does)", () => {
    it("scrollToListTop: start, smooth or instant under reduced motion; «Pagos» and «Saldos» jump through it", () => {
        const calls: unknown[] = [];
        const el = { scrollIntoView: (o?: ScrollIntoViewOptions) => { calls.push(o); } };
        expect(scrollToListTop(el, { matchMedia: () => ({ matches: false }) })).toBe(true);
        expect(scrollToListTop(el, { matchMedia: () => ({ matches: true }) })).toBe(true);
        expect(scrollToListTop(null, null)).toBe(false);
        expect(calls).toEqual([{ block: "start", behavior: "smooth" }, { block: "start", behavior: "auto" }]);
        for (const f of ["FeeTransfers.tsx", "FeeBalances.tsx"]) {
            const src = read(f);
            expect(src, f).toMatch(/useEffect\(\(\) => \{\s*if \(!jump\.current\) return;\s*jump\.current = false;\s*scrollToListTop\(topRef\.current\);\s*\}, \[current\]\);/);
            expect(src, f).toMatch(/const goPage = \(p: number\) => \{ jump\.current = true;/);
            expect(src, f).toContain("onPage={goPage}");
            expect(src, f).toMatch(/<section ref=\{topRef\}/);
        }
    });
});

describe("iPhone safe areas: the conference portal is laid out under viewport-fit=cover", () => {
    it("declares viewport-fit=cover (the plugin's portal page) and pads the content by the side insets", async () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(PORTAL, "../../manifest.json"), "utf8"));
        expect(manifest.frontend.portalPage.viewportFit).toBe("cover");
        const frame = await import("../../../../../../marketplace/plugins/conference-manager/client/portal/PortalFrame");
        const html = flat(renderToStaticMarkup(<frame.default><p>x</p></frame.default>));
        expect(html).toContain("padding-left:env(safe-area-inset-left, 0px)");
        expect(html).toContain("padding-right:env(safe-area-inset-right, 0px)");
    });
});
