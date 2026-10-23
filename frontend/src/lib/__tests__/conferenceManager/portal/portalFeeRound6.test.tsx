/**
 * «Pagos de cuotas» and «Participantes» in the coordinator portal — the sixth round (node, no DOM: pure rules,
 * server-rendered screens, the hub's wiring on its source). Each pinned so that undoing it fails here:
 *   - «Duplicar» is single-use: a rejected payment already registered again (and counting) says so and offers
 *     no second «Duplicar»; «Registrar de nuevo» names its source even without a receipt (`duplicate_of`); a
 *     409 source_used reloads what is shown;
 *   - KPI amounts never break mid-number; the Manual split field fits «250.000,00»;
 *   - «Participantes» from 768 px: form headers wrap between words (their own class, no whitespace-nowrap),
 *     the form columns only when the card has room — else folded under the name;
 *   - the search placeholder is whole on a phone; the pager's size select says «Mostrar … por página»;
 *   - 16 px fields on every touch screen (landscape iPhones);
 *   - an e-mail in the participant sheet wraps at «@» and «.»;
 *   - a correction closed unsent is kept and comes back; Escape in a filled field is the field's;
 *   - the picker says «debe $X», or «falta $X» with «$Y por validar», as the chosen line does;
 *   - the sheet body keeps room under a focused field («Supera lo que falta: máximo $X» was cut);
 *   - the payment sheet's section labels are flush with the others.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
    correctionKey, draftBody, draftChanged, draftFromTransfer, checkDraft, feeErrorAction, FeeApiError, keepCorrection, parseFeeView, parseTransfer, recoverCorrection, viewBalanceC,
    type DraftContext, type FeeDraft, type PortalFeeView, type PortalTransfer,
} from "../../../../../../marketplace/plugins/conference-manager/client/portal/feePayments";
import RegisterPaymentSheet, { owedLines } from "../../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet";
import TransferSheet, { transferActions } from "../../../../../../marketplace/plugins/conference-manager/client/portal/TransferSheet";
import ParticipantList, { PL_FORM_COL_REM, participantTableCss, participantTableMinRem } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ParticipantList";
import { fieldNode } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ParticipantSheet";
import FeeTransfers from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeTransfers";
import { KpiTile, Modal, SECOND_ESCAPE_MS, SHEET_BODY_SCROLL_PADDING, SPLIT_COLUMN_REM, compactMoneyTextPx, fieldKeepsEscape, isFilledField, kpiValueFit, pagerSizeLabel, sectionLabelCls, thCls, thWrapCls } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ui";
import { PORTAL_COARSE_FIELDS_CSS } from "../../../../../../marketplace/plugins/conference-manager/client/portal/portalCss";
import ConferencePortalLayout from "../../../../../../marketplace/plugins/conference-manager/client/portal/PortalFrame";
import type { PortalPerson } from "../../../../../../marketplace/plugins/conference-manager/client/portal/participants";
import type { PortalField } from "../../../../../../marketplace/plugins/conference-manager/client/portal/form";

const PORTAL = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/client/portal");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");
const html = (node: React.ReactElement) => flat(renderToStaticMarkup(node));

const person = (id: number, due: number, validated = 0, pending = 0) => {
    const dueC = Math.round(due * 100);
    const coverC = Math.max(0, dueC - Math.round(validated * 100) - Math.round(pending * 100));
    return { id, due, validated, pending, returned: 0, to_cover: coverC / 100, credit: 0, cancelled: false, payable: coverC > 0 };
};
const T = (id: number, over: Record<string, unknown> = {}) => ({
    id, foreign: false, recorded_via: "portal", amount: 30, allocated: 30, method: "Efectivo", reference: null, paid_on: "2026-10-07", note: null,
    status: "rejected", review_note: "No llegó", alloc_gen: 1, created_at: "2026-10-07 09:00:00", submitted_at: null, updated_at: null, reviewed_at: "2026-10-07 10:00:00",
    has_proof: true, people: 1, allocations: [{ id: 1, inscription_id: 1, amount: 30, moved: false, cancelled: false }], can_edit: false, can_delete: false,
    duplicate_of: null, reused: false, reused_by: null, ...over,
});
const view = (people = [person(1, 250), person(2, 250000), person(3, 250, 0, 100)], transfers: unknown[] = []): PortalFeeView => parseFeeView({
    features: { fee_payments: 1 }, location: { id: 7, name: "Bogotá" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200, summary: {}, people,
    counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers,
})!;
const ctxOf = (v: PortalFeeView): DraftContext => ({ balances: new Map(v.people.map((b) => [b.id, viewBalanceC(b)])), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people });
const names: Record<number, string> = { 1: "Ana Pérez", 2: "Luis Pérez", 3: "Sofía Pérez" };
const nameOf = (id: number) => names[id] ?? `#${id}`;
const sheet = (d: FeeDraft, v = view(), over: Record<string, unknown> = {}) => html(
    <RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={ctxOf(v)} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} {...over} />,
);
const tsheet = (t: PortalTransfer) => html(<TransferSheet transfer={t} nameOf={nameOf} busy={false} onClose={() => {}} onEdit={() => {}} onDuplicate={() => {}} onDelete={() => {}} loadProof={async () => ""} />);

// ── «Duplicar» ───────────────────────────────────────────────────────────────────────────────────────
describe("«Duplicar»: one receipt counts in ONE payment (review F1)", () => {
    it("parseTransfer keeps the duplicate facts of an own payment, never of another recorder's", () => {
        const own = parseTransfer(T(4, { reused: true, reused_by: 9, duplicate_of: 2 }))!;
        expect([own.reused, own.reused_by, own.duplicate_of]).toEqual([true, 9, 2]);
        const foreign = parseTransfer(T(5, { foreign: true, recorded_via: "admin", reused: true, reused_by: 9, duplicate_of: 2 }))!;
        expect([foreign.reused, foreign.reused_by, foreign.duplicate_of]).toEqual([false, null, null]);
    });
    it("a rejected payment registered again: no second «Duplicar», and it says by which payment", () => {
        const fresh = parseTransfer(T(4))!;
        expect(transferActions(fresh).duplicate).toBe(true);
        const used = parseTransfer(T(4, { reused: true, reused_by: 9 }))!;
        expect(transferActions(used).duplicate).toBe(false);
        const out = tsheet(used);
        expect(out).not.toContain('data-action="duplicate"');
        expect(out).toContain("Ya se registró de nuevo en el pago #9: no se puede duplicar otra vez.");
        expect(tsheet(parseTransfer(T(4, { reused: true, reused_by: null }))!)).toContain("La administración ya lo registró de nuevo: no se puede duplicar otra vez.");
        expect(tsheet(parseTransfer(T(9, { status: "pending", duplicate_of: 4 }))!)).toMatch(/data-duplicate-of="4"[^>]*>[\s\S]*?Registra de nuevo el pago rechazado #4\./);
    });
    it("«Registrar de nuevo» names its source even without a receipt to copy (cash without a photo)", () => {
        const v = view();
        const d = draftFromTransfer(parseTransfer(T(4, { has_proof: false }))!, "duplicate", v.methods);
        expect([d.duplicateOf, d.copyFrom]).toEqual([4, null]);
        const body = draftBody(d, checkDraft(d, ctxOf(v)));
        expect(body.duplicate_of).toBe(4);
        expect(body.copy_proof_from).toBeUndefined();
        const withProof = draftFromTransfer(parseTransfer(T(4))!, "duplicate", v.methods);
        expect(draftBody(withProof, checkDraft(withProof, ctxOf(v)))).toMatchObject({ copy_proof_from: 4, duplicate_of: 4 });
        expect(draftFromTransfer(parseTransfer(T(4, { status: "pending" }))!, "edit", v.methods).duplicateOf).toBeNull();
    });
    it("409 source_used / proof_source_live: what is on screen is out of date — close and reload", () => {
        for (const code of ["source_used", "proof_source_live"]) {
            expect(feeErrorAction(new FeeApiError(409, { error: "Este pago anulado ya se registró de nuevo…", code }, "x")).kind, code).toBe("stale");
        }
    });
});

// ── amounts and fields that fit ──────────────────────────────────────────────────────────────────────
describe("amounts never break mid-number, and the split field fits a peso part (UX-2, UX-4)", () => {
    it("KpiTile: a size container, the figure on one line, sized by the tile", () => {
        expect(kpiValueFit("$15.000.000,00")).toEqual({ className: "whitespace-nowrap text-sm", style: { fontSize: "min(1.125rem, calc(100cqi / 8.68))" } });
        const out = html(<KpiTile label="Cuotas" value="$7.500.000,00" />);
        expect(out).toContain('style="container-type:inline-size;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch"');
        expect(out).toMatch(/class="block font-black tabular-nums leading-tight whitespace-nowrap text-sm text-gray-700" style="font-size:min\(1\.125rem, calc\(100cqi \/ 8\.06\)\)" data-kpi-value="">\$7\.500\.000,00</);
        expect(out).not.toContain("break-words");
    });
    it("the Manual split: a 9.5rem column and a compact field leave room for «250.000,00» (~87 px)", () => {
        expect(SPLIT_COLUMN_REM).toBe(9.5);
        expect(compactMoneyTextPx(SPLIT_COLUMN_REM)).toBeGreaterThanOrEqual(87);
        // The old geometry: 8.5rem with pl-9 + px-4 + the borders → 80 px.
        expect(8.5 * 16 - 36 - 16 - 4).toBeLessThan(87);
        const v = view([person(1, 250000), person(2, 250000), person(3, 250000)]);
        const d: FeeDraft = { ...draftFromTransfer(parseTransfer(T(4, { status: "pending", can_edit: true, amount: 750000, allocations: [{ id: 1, inscription_id: 1, amount: 250000 }, { id: 2, inscription_id: 2, amount: 300000 }, { id: 3, inscription_id: 3, amount: 200000 }] }))!, "edit", v.methods) };
        const out = sheet(d, v);
        expect(out).toMatch(/<li class="grid items-center gap-3 rounded-2xl border px-4 py-2[^"]*" style="grid-template-columns:minmax\(0, 1fr\) 9\.5rem" data-split-row="1">/);
        expect(out).toMatch(/<input[^>]*class="w-full border-2 border-gray-100 rounded-xl pl-7 pr-2 text-right [^"]*"[^>]*data-testid="split-input-1"/);
    });
});

// ── «Participantes» from 768 px ──────────────────────────────────────────────────────────────────────
const fields: PortalField[] = [
    { name: "first_name", label: "Nombre", type: "text", role: "first_name" },
    { name: "last_name", label: "Apellido", type: "text", role: "last_name" },
    { name: "doc", label: "Documento de identidad", type: "text" },
    { name: "ciudad", label: "Ciudad", type: "text" },
];
const people: PortalPerson[] = [
    { id: 1, first_name: "Ana", last_name: "Pérez", total_due: 500, amount_paid: 0, payment_status: "unpaid", pending_amount: 0, returned_amount: 0, cancelled: false, doc: "1098765432", ciudad: "Bucaramanga" } as PortalPerson,
];
describe("«Participantes» from 768 px: headers wrap between words; form columns only where they fit (UX-3)", () => {
    const out = html(<ParticipantList people={people} fields={fields} onOpen={() => {}} />);
    it("a form header has its own class — no whitespace-nowrap that Tailwind v4 would let win — and a 9rem column", () => {
        expect(thCls).toContain("whitespace-nowrap");
        expect(thWrapCls).toContain("whitespace-normal");
        expect(thWrapCls).not.toContain("whitespace-nowrap");
        expect(thWrapCls).not.toContain("break-words");
        expect(out).toContain(`<th scope="col" class="${thWrapCls}" style="width:${PL_FORM_COL_REM}rem" data-pl-col="">Documento de identidad</th>`);
        expect(out).not.toMatch(/<th[^>]*whitespace-nowrap[^>]*whitespace-normal/);
    });
    it("the card is a size container: below the table's minimum the form columns fold under the name", () => {
        expect(participantTableMinRem(2)).toBe(45);
        expect(participantTableMinRem(2, true)).toBe(48.5);
        expect(participantTableCss(2)).toContain("@container cm-pl (max-width: 44.99rem) { [data-pl-card] [data-pl-col] { display: none; } [data-pl-card] [data-pl-fold] { display: block; } }");
        expect(out).toMatch(/style="container-type:inline-size;container-name:cm-pl" data-pl-card=""><style>/);
        expect(out).toMatch(/data-pl-fold="" data-field-fold="ciudad"><span class="font-bold text-gray-500">Ciudad:<\/span> Bucaramanga<\/span>/);
        expect(out).toMatch(/<td class="px-3 py-3 text-xs text-gray-600 break-words" data-field-cell="ciudad" data-pl-col="">Bucaramanga<\/td>/);
    });
    it("the search placeholder is whole on a phone; what it searches is its name (UX-6)", () => {
        const ph = out.match(/data-testid="participants-search"/) ? out.match(/placeholder="([^"]*)"[^>]*data-testid="participants-search"/)![1] : "";
        expect(ph).toBe("Buscar participante");
        expect(ph.length).toBeLessThanOrEqual(20);
        // Round 7 (label in name): the name starts with the visible words.
        expect(out).toMatch(/placeholder="Buscar participante" aria-label="Buscar participante por nombre o cualquier dato"/);
    });
});

// ── the pager names what it counts ───────────────────────────────────────────────────────────────────
describe("the pager's size select starts with its visible word and says what it counts (UX-12)", () => {
    it("«Mostrar pagos por página» in «Pagos»; «Mostrar participantes por página» in «Participantes»", () => {
        expect(pagerSizeLabel("pagos")).toBe("Mostrar pagos por página");
        const tr = Array.from({ length: 25 }, (_, i) => parseTransfer(T(i + 1, { status: "pending" }))!);
        const pagos = html(<FeeTransfers transfers={tr} nameOf={nameOf} onOpen={() => {}} personId={null} onClearPerson={() => {}} onRegister={() => {}} canRecord />);
        expect(pagos).toContain('aria-label="Mostrar pagos por página: 20"');
        expect(pagos).not.toContain("Personas por página");
        const many = Array.from({ length: 25 }, (_, i) => ({ ...people[0], id: i + 1 }));
        expect(html(<ParticipantList people={many} fields={fields} onOpen={() => {}} />)).toContain('aria-label="Mostrar participantes por página: ');
    });
});

// ── 16 px fields on every touch screen ──────────────────────────────────────────────────────────────
describe("16 px fields on every touch screen — an iPhone held sideways is past 640 px (UX-7)", () => {
    it("the portal layout carries one coarse-pointer rule for the page and its sheets", () => {
        expect(PORTAL_COARSE_FIELDS_CSS).toMatch(/^@media \(pointer: coarse\) \{\n  :is\(\[data-portal-safe-area\], \[data-portal-overlay\]\) :is\(input, select, textarea\)[^{]*\{ font-size: 16px; \}\n\}$/);
        const out = html(<ConferencePortalLayout><p>x</p></ConferencePortalLayout>);
        expect(out).toContain("@media (pointer: coarse)");
        expect(out).toMatch(/data-portal-safe-area=""><style>/);
        expect(read("portalCss.ts").trimStart().startsWith('"use client"')).toBe(false);
    });
});

// ── e-mails in the participant sheet ────────────────────────────────────────────────────────────────
describe("an e-mail in the participant sheet wraps at «@» and «.», never mid-word (UX-8)", () => {
    it("a long address: no break-all, a <wbr> after «@»", () => {
        const a = html(<>{fieldNode({ name: "correo", label: "Correo", type: "email" } as PortalField, "coordinacion.juvenil.bogota@iglesiaevangelica.org.co")}</>);
        expect(a).not.toContain("break-all");
        expect(a).toContain("break-words");
        expect(a).toContain("@<wbr/>iglesiaevangelica");
    });
});

// ── a correction closed unsent ──────────────────────────────────────────────────────────────────────
describe("a correction closed unsent is kept and comes back; Escape in a filled field is the field's (UX-9)", () => {
    const v = view();
    const returned = parseTransfer(T(4, { status: "returned", can_edit: true, alloc_gen: 2, allocations: [{ id: 1, inscription_id: 1, amount: 30 }] }))!;
    it("keepCorrection / recoverCorrection: one per payment, only with changes, never for a payment that changed since", () => {
        const kept = new Map<string, FeeDraft>();
        const start = draftFromTransfer(returned, "edit", v.methods);
        expect(correctionKey(start)).toBe("edit:4");
        keepCorrection(kept, start, start);
        expect(kept.size).toBe(0);
        const changed: FeeDraft = { ...start, ids: [1, 2], mode: "manual", manual: { 1: "20,00", 2: "10,00" }, proof: "data:image/png;base64,AAAA", allowDuplicateReference: true };
        expect(draftChanged(start, changed)).toBe(true);
        expect(draftChanged(start, { ...start, total: "30" })).toBe(false);
        keepCorrection(kept, start, changed);
        expect([...kept.keys()]).toEqual(["edit:4"]);
        const back = recoverCorrection(kept, draftFromTransfer(returned, "edit", v.methods));
        expect([back.recovered, back.ids, back.proof, back.allowDuplicateReference]).toEqual([true, [1, 2], "data:image/png;base64,AAAA", false]);
        expect(kept.size).toBe(0);
        // The payment changed on the server (another split generation): the fresh draft, not the kept one.
        keepCorrection(kept, start, changed);
        const moved = parseTransfer(T(4, { status: "returned", can_edit: true, alloc_gen: 3 }))!;
        expect(recoverCorrection(kept, draftFromTransfer(moved, "edit", v.methods)).recovered).toBeUndefined();
        // «Registrar de nuevo» of a payment without a receipt is kept by its source.
        expect(correctionKey(draftFromTransfer(parseTransfer(T(6, { has_proof: false }))!, "duplicate", v.methods))).toBe("duplicate:6");
    });
    it("the sheet says a correction came back and offers «Empezar de cero»; the hub keeps it on close", () => {
        const d = { ...draftFromTransfer(returned, "edit", v.methods), recovered: true };
        const out = sheet(d, v, { onRestart: () => {} });
        expect(out).toMatch(/data-recovered-notice=""[^>]*>[\s\S]*?Recuperamos lo que cambiaste y no enviaste en este pago\.[\s\S]*?data-action="restart-correction"/);
        const tab = read("FeePaymentsTab.tsx");
        expect(tab).toMatch(/if \(d && d\.kind === "new"\) keptNew\.current = d;\s*else keepCorrection\(keptCorrections\.current, openedWith\.current, d\);/);
        expect(tab).toContain("setDraftState(recoverCorrection(keptCorrections.current, fresh));");
        // «Empezar de cero»: the payment as it is on the server, with a fresh idempotency key (a new send).
        expect(tab).toContain("if (start) setDraftState({ ...start, clientKey: newClientKey() });");
    });
    it("fieldKeepsEscape: the first Escape in a filled field is the field's; a second one soon after, or an empty field, goes to the sheet", () => {
        const search = { tagName: "INPUT", type: "search", value: "ana" };
        expect(isFilledField(search)).toBe(true);
        expect(isFilledField({ tagName: "INPUT", type: "search", value: "" })).toBe(false);
        expect(isFilledField({ tagName: "INPUT", type: "checkbox", value: "on" })).toBe(false);
        expect(fieldKeepsEscape(search, 1000)).toBe(true);
        expect(fieldKeepsEscape(search, 1000 + SECOND_ESCAPE_MS)).toBe(false);
        expect(fieldKeepsEscape(search, 5000)).toBe(true);
        expect(fieldKeepsEscape({ tagName: "DIV" }, 5100)).toBe(false);
        const ui = read("ui.tsx");
        expect(ui).toMatch(/if \(e\.key === "Escape"\) \{\s*if \(fieldKeepsEscape\(e\.target, Date\.now\(\)\)\) return;/);
    });
});

// ── the picker's words; the sheet body's room; the labels ───────────────────────────────────────────
describe("the picker says what the chosen line says; a focused part keeps its message in view; labels align (UX-11, skeptic)", () => {
    it("owedLines: «debe $X», or «falta $X» with «$Y por validar»", () => {
        const b = ctxOf(view()).balances;
        expect(owedLines(b.get(1))).toEqual(["debe $250,00"]);
        expect(owedLines(b.get(3))).toEqual(["falta $150,00", "$100,00 por validar"]);
        expect(owedLines(undefined)).toEqual([]);
        const v = view();
        const d: FeeDraft = { ...draftFromTransfer(parseTransfer(T(4, { status: "pending", can_edit: true }))!, "edit", v.methods), ids: [] };
        const out = sheet(d, v);
        expect(out).toMatch(/data-picker-owed=""><span class="block whitespace-nowrap">falta \$150,00<\/span><span class="block whitespace-nowrap text-amber-800">\$100,00 por validar<\/span>/);
        expect(out).not.toMatch(/>debe \$150,00</);
    });
    it("the sheet body scrolls a focused field clear of its bottom edge with room for the line under it", () => {
        expect(SHEET_BODY_SCROLL_PADDING).toBe("3rem");
        const out = html(<Modal title="T" onClose={() => {}} footer={<button type="button">x</button>}><p>x</p></Modal>);
        expect(out).toMatch(/style="scroll-padding-bottom:3rem;scroll-padding-top:1rem" data-portal-sheet-body=""/);
        const src = read("RegisterPaymentSheet.tsx");
        expect(src).toMatch(/if \(!over \|\| !el \|\| typeof document === "undefined" \|\| !el\.contains\(document\.activeElement\)\) return;\s*try \{ el\.scrollIntoView\(\{ block: "nearest" \}\); \}/);
    });
    it("the payment sheet's «Reparto» and «Comprobante» are flush with its other labels (no ml-1)", () => {
        expect(sectionLabelCls).not.toContain("ml-1");
        const out = tsheet(parseTransfer(T(4, { foreign: true, recorded_via: "admin", status: "validated" }))!);
        expect(out).toContain(`<h4 class="${sectionLabelCls}">Reparto (1 persona)</h4>`);
        const own = tsheet(parseTransfer(T(4))!);
        expect(own).toContain(`<h4 class="${sectionLabelCls}">Comprobante</h4>`);
    });
});
