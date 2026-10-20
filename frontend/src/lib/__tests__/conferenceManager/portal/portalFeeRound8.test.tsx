/**
 * «Pagos de cuotas» in the coordinator portal — the eighth round (the fifth review round, the live lab and the
 * skeptic; node, no DOM: pure rules and server-rendered screens). Each pinned so that undoing it fails here:
 *   - a server stamp (reviewed_at, registration_date) is shown as the LOCAL day — never the UTC calendar day
 *     (Colombia is UTC−5: anything done after 19:00 read as the next day); a payment date stays the day typed;
 *   - «29 inscritos · 1 cancelada» never splits a count from its noun; a payment row's facts never leave a «·»
 *     alone; the clickable «Por validar» tile lines up with its siblings;
 *   - the method / split strips are one Tab stop with the arrow keys (PUX-7); the receipt picker is a focusable
 *     button (PUX-6); the person picker's list is capped by the room and hands the scroll on (PUX-4);
 *   - the older payment form (degraded plugin) says «Los pagos no están disponibles…» to the coordinator (R5-L3).
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dayLabel, parseFeeView, parseTransfer, reopenDraft, stampDayLabel, viewBalanceC, type DraftContext, type FeeDraft, type PortalFeeView } from "../../../../../../marketplace/plugins/conference-manager/client/portal/feePayments";
import TransferSheet from "../../../../../../marketplace/plugins/conference-manager/client/portal/TransferSheet";
import ParticipantSheet from "../../../../../../marketplace/plugins/conference-manager/client/portal/ParticipantSheet";
import RegisterPaymentSheet, { ProofPicker } from "../../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet";
import { factsLine } from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeTransfers";
import { peopleHint } from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeSummary";
import { KPI_TILE_BOX, KpiTile, SegmentedControl, segmentKeyTarget } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ui";
import { PAYMENTS_UNAVAILABLE, bulkErrorText } from "../../../../../../marketplace/plugins/conference-manager/client/portal/LegacyBulkPayment";

const flat = (html: string) => html.replace(/<!-- -->/g, "");
const html = (node: React.ReactElement) => flat(renderToStaticMarkup(node));
const NB = " ";
/** Run `fn` with the process in time zone `tz` (Node re-reads TZ on change). */
const inZone = <T,>(tz: string, fn: () => T): T => {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};
const T = (extra: Record<string, unknown> = {}) => parseTransfer({
    id: 4, foreign: false, recorded_via: "portal", amount: 250, allocated: 250, method: "Transferencia", reference: "REF-1", paid_on: "2026-10-08", note: null,
    status: "returned", review_note: "Foto borrosa", alloc_gen: 1, created_at: "2026-10-09 00:04:00", submitted_at: "2026-10-09 00:04:00", updated_at: null,
    reviewed_at: "2026-10-09 00:05:08", has_proof: true, people: 1, allocations: [{ id: 1, inscription_id: 1, amount: 250, moved: false, cancelled: false }],
    can_edit: true, can_delete: true, duplicate_of: null, reused: false, reused_by: null, ...extra,
})!;
const nameOf = (id: number) => (id === 1 ? "Ana Pérez" : `#${id}`);

// ── local days ──────────────────────────────────────────────────────────────────────────────────────────
describe("server stamps read as the LOCAL day in the portal, as in the admin (live round 4)", () => {
    it("stampDayLabel: a UTC SQL stamp at 00:05 is the previous evening in Bogotá; a DATE stays the day typed", () => {
        inZone("America/Bogota", () => {
            expect(stampDayLabel("2026-10-09 00:05:08")).toBe("08/10/2026");
            expect(stampDayLabel("2026-10-09T00:05:08Z")).toBe("08/10/2026");
            expect(stampDayLabel("2026-10-08T19:05:08-05:00")).toBe("08/10/2026");
            expect(stampDayLabel("2026-10-08")).toBe("08/10/2026");
            expect(dayLabel("2026-10-08")).toBe("08/10/2026");
            expect([stampDayLabel(null), stampDayLabel(""), stampDayLabel("ayer")]).toEqual(["", "", ""]);
        });
        expect(inZone("UTC", () => stampDayLabel("2026-10-09 00:05:08"))).toBe("09/10/2026");
    });
    it("the payment sheet: «Revisado 08/10/2026» beside «Fecha del pago 08/10/2026» for a review at 19:05 in Bogotá", () => {
        const out = inZone("America/Bogota", () => html(<TransferSheet transfer={T()} nameOf={nameOf} busy={false} onClose={() => {}} onEdit={() => {}} onDuplicate={() => {}} onDelete={() => {}} loadProof={async () => ""} />));
        expect(out).toMatch(/Fecha del pago<\/dt><dd[^>]*>08\/10\/2026<\/dd>/);
        expect(out).toMatch(/Revisado<\/dt><dd[^>]*>08\/10\/2026<\/dd>/);
        expect(out).not.toContain("09/10/2026");
    });
    it("the participant's sheet: «Inscripción: 08/10/2026» for someone registered at 19:05 in Bogotá", () => {
        const p = { id: 1, first_name: "Ana", last_name: "Pérez", total_due: 250, amount_paid: 0, payment_status: "unpaid", pending_amount: 0, returned_amount: 0, status: "active", registration_date: "2026-10-09 00:05:03" } as any;
        const out = inZone("America/Bogota", () => html(<ParticipantSheet person={p} fields={[]} onClose={() => {}} feesOn canRecord onPay={() => {}} />));
        expect(out).toContain("Inscripción: 08/10/2026");
        expect(out).toMatch(/Fecha de inscripción<\/dt><dd[^>]*>08\/10\/2026<\/dd>/);
        expect(out).not.toContain("09/10/2026");
    });
});

// ── words that stay together ────────────────────────────────────────────────────────────────────────────
describe("a count stays with its noun, a «·» with its fact", () => {
    it("«29 inscritos · 1 cancelada» (no-break spaces)", () => {
        expect(peopleHint(29, 1)).toBe(`29${NB}inscritos ·${NB}1${NB}cancelada`);   // the «·» goes with «1 cancelada» (UX6-4)
        expect(peopleHint(1, 0)).toBe(`1${NB}inscrito`);
        expect(peopleHint(3, 2)).toBe(`3${NB}inscritos ·${NB}2${NB}canceladas`);
    });
    it("a payment row's facts: «$250.000,00», «· Transferencia», «· 08/10/2026», each whole (PUX-10)", () => {
        expect(factsLine(T({ amount: 250000 }))).toEqual(["$250.000,00", "Transferencia", "08/10/2026"]);
        expect(factsLine(T({ paid_on: null, method: "" }))).toEqual(["$250,00", "—"]);
    });
});

// ── KPI tiles ───────────────────────────────────────────────────────────────────────────────────────────
describe("the clickable «Por validar» tile lines up with the others", () => {
    it("button and div tiles share one box, a column stacked from the top", () => {
        expect(KPI_TILE_BOX).toMatchObject({ display: "flex", flexDirection: "column", justifyContent: "flex-start" });
        const style = 'style="container-type:inline-size;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch"';
        expect(html(<KpiTile label="Por validar" value="$250,00" onClick={() => {}} testId="kpi-pending" />)).toMatch(/^<button type="button" class="[^"]*" style="container-type:inline-size;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch" data-testid="kpi-pending">/);
        expect(html(<KpiTile label="Cuotas" value="$250,00" testId="kpi-due" />)).toContain(`${style} data-testid="kpi-due"`);
    });
});

// ── PUX-7: the arrow keys ───────────────────────────────────────────────────────────────────────────────
describe("PUX-7: the radio strips are one Tab stop with the arrow keys", () => {
    it("segmentKeyTarget wraps, skips a disabled option, Home / End go to the ends", () => {
        const v = ["Efectivo", "Transferencia", "Tarjeta"] as const;
        expect(segmentKeyTarget(v, "Efectivo", "ArrowRight")).toBe("Transferencia");
        expect(segmentKeyTarget(v, "Efectivo", "ArrowLeft")).toBe("Tarjeta");
        expect(segmentKeyTarget(v, "Efectivo", "ArrowDown", (x) => x === "Transferencia")).toBe("Tarjeta");
        expect([segmentKeyTarget(v, "Transferencia", "Home"), segmentKeyTarget(v, "Transferencia", "End"), segmentKeyTarget(v, "Transferencia", " ")]).toEqual(["Efectivo", "Tarjeta", null]);
    });
    it("only the chosen option is tabbable; ArrowRight chooses the next and moves the focus to it", () => {
        const props = { value: "equal" as const, label: "Reparto", onChange: vi.fn(), options: [{ value: "equal" as const, label: "Iguales" }, { value: "manual" as const, label: "Manual" }] };
        const out = html(<SegmentedControl {...props} />);
        expect(out).toMatch(/role="radio" aria-checked="true" tabindex="0" data-seg="equal"/);
        expect(out).toMatch(/role="radio" aria-checked="false" tabindex="-1" data-seg="manual"/);
        // The handler of the chosen option, called with a keyboard event.
        const tree = SegmentedControl(props) as React.ReactElement<{ children: React.ReactElement<{ onKeyDown: (e: unknown) => void }>[] }>;
        const buttons = tree.props.children;
        const manualBtn = { getAttribute: () => "manual", focus: vi.fn() };
        const equalBtn = { getAttribute: () => "equal", focus: vi.fn() };
        const e = { key: "ArrowRight", preventDefault: vi.fn(), currentTarget: { parentElement: { querySelectorAll: () => [equalBtn, manualBtn] } } };
        buttons[0].props.onKeyDown(e);
        expect([props.onChange.mock.calls, e.preventDefault.mock.calls.length, manualBtn.focus.mock.calls.length]).toEqual([[["manual"]], 1, 1]);
        const other = { key: "a", preventDefault: vi.fn(), currentTarget: e.currentTarget };
        buttons[0].props.onKeyDown(other);
        expect(other.preventDefault).not.toHaveBeenCalled();
    });
});

// ── PUX-6 / PUX-4: the register sheet ───────────────────────────────────────────────────────────────────
const person = (id: number, due: number) => ({ id, due, validated: 0, pending: 0, returned: 0, to_cover: due, credit: 0, cancelled: false, payable: true });
const view = (): PortalFeeView => parseFeeView({
    features: { fee_payments: 1 }, location: { id: 7, name: "Bogotá" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200, summary: {}, people: [person(1, 250), person(2, 250)],
    counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [],
})!;
const ctxOf = (v: PortalFeeView): DraftContext => ({ balances: new Map(v.people.map((b) => [b.id, viewBalanceC(b)])), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people });
describe("PUX-6: the receipt picker is reachable by keyboard; PUX-4: the person picker hands the scroll on", () => {
    it("«Tomar foto o elegir archivo» and «Cambiar» are buttons with a focus ring; the file input is out of the Tab order", () => {
        const empty = html(<ProofPicker required proof={null} stored={false} storedLabel="" onProof={() => {}} onRemoveStored={() => {}} />);
        expect(empty).toMatch(/<button type="button" class="[^"]*focus-visible:ring-2[^"]*" data-proof-state="empty">/);
        expect(empty).not.toMatch(/<label[^>]*for=/);
        expect(empty).toMatch(/<input[^>]*type="file"[^>]*tabindex="-1" aria-hidden="true"[^>]*data-testid="proof-input"\/>/);
        const stored = html(<ProofPicker required proof={null} stored storedLabel="Comprobante guardado" onProof={() => {}} onRemoveStored={() => {}} />);
        expect(stored).toMatch(/<button type="button" class="[^"]*focus-visible:ring-2[^"]*" data-proof-change="">Cambiar<\/button>/);
    });
    it("the picker's list: capped by the room (40dvh), no overscroll-contain", () => {
        const d: FeeDraft = { ...reopenDraft(null, [], view().methods, null, ctxOf(view()).balances) };
        const out = html(<RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={ctxOf(view())} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} />);
        const list = /<ul class="([^"]*)" data-picker-list="">/.exec(out);
        expect(list, "the picker opens by itself on a new payment").not.toBeNull();
        expect(list![1]).toContain("max-h-[min(16rem,40dvh)]");
        expect(list![1]).toContain("overflow-y-auto");
        expect(list![1]).not.toContain("overscroll-contain");
    });
});

// ── R5-L3 ───────────────────────────────────────────────────────────────────────────────────────────────
describe("R5-L3: the older payment form says, in the coordinator's words, that payments are unavailable", () => {
    it("a 503 `unavailable` → «Los pagos no están disponibles en este momento; inténtalo más tarde.»", () => {
        expect(PAYMENTS_UNAVAILABLE).toBe("Los pagos no están disponibles en este momento; inténtalo más tarde.");
        expect(bulkErrorText(503, { error: "«Pagos de cuotas» no está disponible: su migración no se completó (revisa el registro del servidor).", code: "unavailable" })).toBe(PAYMENTS_UNAVAILABLE);
        expect(bulkErrorText(503, null)).toBe(PAYMENTS_UNAVAILABLE);
        expect(bulkErrorText(400, { error: "Selecciona al menos una persona." })).toBe("Selecciona al menos una persona.");
        expect(bulkErrorText(500, {})).toBe("Error al procesar pagos");
    });
});
