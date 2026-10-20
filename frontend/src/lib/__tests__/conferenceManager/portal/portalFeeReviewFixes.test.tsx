/**
 * «Pagos de cuotas» in the coordinator portal — the fixes of the third live lab and review round, pinned so
 * that undoing any of them fails here (node, no DOM: pure rules, server-rendered screens, the hub's wiring on
 * its source):
 *   - a kept, unsent draft reopened for OTHER people says that its receipt, reference, date and note came
 *     along, and «Empezar de cero» drops them; a confirmed repeated reference never survives a reopen;
 *   - any change to the draft ends the last send's errors (the footer goes back to the live reason);
 *   - «Registrar pago de esta persona» for someone the loaded view does not know (registered afterwards)
 *     loads once more first; for someone who cannot be paid it says why — never an empty sheet nor someone
 *     else's unsent draft;
 *   - family-group chips: only groups of 2+ people who can be paid, filtered by the search, at most 8 with
 *     «Ver más grupos (n)» — in «Saldos» and in the sheet's «+ Añadir»;
 *   - a receipt photo picked while another is shrinking: no second pick offered, the latest pick wins;
 *   - empty states and the loading label are AA-legible (gray-600).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
    balanceC, carriedItems, carriedNotice, checkDraft, followTotal, newDraft, parseFeeView, registerNeedsLoad, registerTargets, reopenDraft, startOver, todayLocal, viewBalanceC,
    type BalanceC, type DraftContext, type FeeDraft, type PortalFeeView,
} from "../../../../../../marketplace/plugins/conference-manager/client/portal/feePayments";
import { familyChips, type FamilyGroup } from "../../../../../../marketplace/plugins/conference-manager/client/portal/participants";
import { pickSequence } from "../../../../../../marketplace/plugins/conference-manager/client/portal/proofImage";
import RegisterPaymentSheet, { ProofPicker } from "../../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet";
import FeeBalances from "../../../../../../marketplace/plugins/conference-manager/client/portal/FeeBalances";
import { EmptyState, Spinner } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ui";

const PORTAL = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/client/portal");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");

const person = (id: number, due: number, validated = 0, pending = 0, extra: Record<string, unknown> = {}) => {
    const cancelled = !!extra.cancelled;
    const dueC = cancelled ? 0 : Math.round(due * 100);
    const coverC = Math.max(0, dueC - Math.round(validated * 100) - Math.round(pending * 100));
    return { id, due: dueC / 100, validated, pending, returned: 0, to_cover: coverC / 100, credit: 0, cancelled, payable: !cancelled && coverC > 0, ...extra };
};
const view = (people = [person(1, 250), person(2, 250), person(3, 100, 0, 100), person(4, 100, 0, 0, { cancelled: true })]): PortalFeeView => parseFeeView({
    features: { fee_payments: 1 }, location: { id: 7, name: "Bogotá" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200, summary: {}, people,
    counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [],
})!;
const balancesOf = (v: PortalFeeView) => new Map(v.people.map((b) => [b.id, viewBalanceC(b)]));
const ctxOf = (v: PortalFeeView): DraftContext => ({ balances: balancesOf(v), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people });
const names: Record<number, string> = { 1: "Ana Pérez", 2: "Luis Pérez", 3: "Sofía Pérez", 4: "Mateo Pérez", 5: "Helena Ortiz" };
const nameOf = (id: number) => names[id] ?? `#${id}`;
const sheet = (d: FeeDraft, v = view(), over: Record<string, unknown> = {}) => flat(renderToStaticMarkup(
    <RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={ctxOf(v)} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} {...over} />,
));

// ── UX-P1: a kept draft for other people says what came along ───────────────────────────────────────
describe("a kept, unsent draft reopened for other people says so, and can start over", () => {
    const v = view();
    const balances = balancesOf(v);
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return todayLocal(d); })();
    const kept: FeeDraft = {
        ...followTotal(newDraft([1, 2, 3], v.methods, null), balances),
        method: "Transferencia", reference: "KEEP-77", proof: "data:image/jpeg;base64,QQ==", paidOn: yesterday, note: "familia", allowDuplicateReference: true,
    };
    it("reopenDraft for Helena: the receipt and details come along MARKED as carried; a confirmed repeated reference does not", () => {
        const d = reopenDraft(kept, [5], v.methods, null, new Map([...balances, [5, balanceC({ due: 250, validated: 0, pending: 0 })]]));
        expect(d.ids).toEqual([5]);
        expect([d.proof, d.reference, d.paidOn, d.note]).toEqual([kept.proof, "KEEP-77", yesterday, "familia"]);
        expect(d.carried).toBe(true);
        expect(d.allowDuplicateReference).toBe(false);
        expect(carriedNotice(d)).toBe("Se conservaron el comprobante, la referencia, la fecha y la nota del pago que no enviaste. Revísalos: este pago es para otras personas.");
        // The same people: their own draft as it was — but never a «registrar de todas formas» decided for another send.
        const same = reopenDraft(kept, [3, 2, 1], v.methods, null, balances);
        expect([!!same.carried, same.allowDuplicateReference, same.proof]).toEqual([false, false, kept.proof]);
        expect(!!reopenDraft({ ...kept, allowDuplicateReference: false }, [1, 2, 3], v.methods, null, balances).carried).toBe(false);
    });
    it("nothing worth telling (an empty draft) is not flagged; the notice follows what the coordinator removes", () => {
        const empty = followTotal(newDraft([1], v.methods, null), balances);
        expect(reopenDraft(empty, [2], v.methods, null, balances).carried).toBe(false);
        const d = reopenDraft(kept, [1], v.methods, null, balances);
        expect(carriedItems({ ...d, proof: null, note: "" })).toEqual(["la referencia", "la fecha"]);
        expect(carriedNotice({ ...d, proof: null, reference: "", note: "", paidOn: todayLocal() })).toBeNull();
    });
    it("the sheet shows the notice with «Empezar de cero», which drops the receipt and the details and keeps the people", () => {
        const d = reopenDraft(kept, [1], v.methods, null, balances);
        const html = sheet(d, v);
        expect(html).toMatch(/data-carried-notice=""[\s\S]*Se conservaron el comprobante[\s\S]*data-action="start-over"[^>]*>[\s\S]*Empezar de cero/);
        expect(html.indexOf("data-carried-notice")).toBeLessThan(html.indexOf("data-register-section=\"proof\""));
        const fresh = startOver(d, ctxOf(v));
        expect([fresh.ids, fresh.proof, fresh.reference, fresh.note, fresh.paidOn, !!fresh.carried, fresh.kind]).toEqual([[1], null, "", "", todayLocal(), false, "new"]);
        expect(fresh.clientKey).not.toBe(d.clientKey);
        expect(sheet(fresh, v)).not.toContain("data-carried-notice");
        expect(read("RegisterPaymentSheet.tsx")).toContain("onClick={() => setDraft((d) => startOver(d, ctx))} data-action=\"start-over\"");
    });
});

// ── UX-P2: the footer shows the live reason after an edit ────────────────────────────────────────────
describe("any change to the draft ends the last send's errors", () => {
    it("the hub's setDraft clears the sheet errors with every change", () => {
        expect(read("FeePaymentsTab.tsx")).toMatch(/const setDraft = useCallback\(\(fn: \(d: FeeDraft\) => FeeDraft\) => \{\s*setDraftState\(\(d\) => \(d \? fn\(d\) : d\)\);\s*setSheetErrors\(NO_ERRORS\);\s*\}, \[\]\);/);
    });
    it("without a send error the footer names the live problem («Faltan $50,00 por repartir.»)", () => {
        const v = view();
        const d: FeeDraft = { ...followTotal(newDraft([1, 2], v.methods, null), balancesOf(v)), method: "Efectivo", mode: "manual", manual: { 1: "250", 2: "200" } };
        const live = sheet(d, v);
        expect(live).toMatch(/data-register-problems=""[\s\S]*Faltan \$50,00 por repartir\./);
        const stale = sheet(d, v, { error: "Alguien ya tiene pagos registrados que no veías: revisa los montos." });
        expect(stale).toMatch(/data-register-error=""[\s\S]*Alguien ya tiene pagos/);
        expect(checkDraft(d, ctxOf(v)).canSubmit).toBe(false);
    });
});

// ── UX-P3: «Registrar pago de esta persona» for someone the view does not know ──────────────────────
describe("«Registrar pago de esta persona»: a new participant loads the view first; nobody payable → a reason, no sheet", () => {
    it("registerNeedsLoad: no view, or an id the view does not hold", () => {
        const v = view();
        expect(registerNeedsLoad(null, [1])).toBe(true);
        expect(registerNeedsLoad(v, [1, 2])).toBe(false);
        expect(registerNeedsLoad(v, [1, 99])).toBe(true);
        expect(registerNeedsLoad(v, [])).toBe(false);
    });
    it("registerTargets: who can be paid, and why the others cannot", () => {
        const b = balancesOf(view());
        expect(registerTargets(b, [1, 2])).toEqual({ want: [1, 2], notice: null });
        expect(registerTargets(b, [99]).notice).toMatch(/aún no aparece en los pagos de tu localidad/);
        expect(registerTargets(b, [4])).toEqual({ want: [], notice: "Esa inscripción está cancelada: no debe nada." });
        expect(registerTargets(b, [3]).notice).toMatch(/no tiene nada por registrar/);
        expect(registerTargets(b, [1, 3, 4])).toEqual({ want: [1], notice: "2 de las personas elegidas no tienen nada por registrar." });
    });
    it("the hub: loads once more when an id is missing, says why, and opens no sheet when nobody asked for can be paid", () => {
        const tab = read("FeePaymentsTab.tsx");
        expect(tab).toMatch(/if \(registerNeedsLoad\(v, ids\)\) \{[\s\S]*const o = await loadOutcome\(\);\s*if \(o\.kind === "ok"\) v = o\.view;/);
        // Round 7: nobody payable → no sheet, the reason said where the coordinator looks (`say`).
        expect(tab).toMatch(/const \{ want, notice \} = balances \? registerTargets\(balances, ids\)/);
        expect(tab).toMatch(/if \(!v \|\| !balances \|\| \(ids\.length && !want\.length\)\) \{\s*const why = loadNotice \|\| notice;\s*if \(why\) say\(why, loadNotice \? "error" : "info"\);\s*return;\s*\}\s*const kept = keptNew\.current;/);
    });
});

// ── UX-P4: family-group chips ────────────────────────────────────────────────────────────────────────
describe("family-group chips: groups of 2+, filtered by the search, at most 8", () => {
    const groups: FamilyGroup[] = [
        { name: "Pérez", ids: [1, 2, 3] },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Familia Chávez ${i + 100}`, ids: [1000 + i] })),
        ...Array.from({ length: 12 }, (_, i) => ({ name: `Gómez ${i}`, ids: [2000 + i * 2, 2001 + i * 2] })),
    ];
    const payable = (id: number) => id !== 3;
    const nm = (id: number) => (id === 2003 ? "Ángela Núñez" : nameOf(id));
    it("one-person groups never show; a group counts only its payable people", () => {
        const all = familyChips(groups, payable, nm, [], { all: true });
        expect(all.shown.every((g) => g.ids.length >= 2)).toBe(true);
        expect(all.shown.find((g) => g.name === "Pérez")!.ids).toEqual([1, 2]);
        expect(all.shown.some((g) => g.name.startsWith("Familia Chávez"))).toBe(false);
        expect(familyChips([{ name: "Solo", ids: [1, 3] }], payable, nm, []).shown).toEqual([]);
    });
    it("capped at 8 with the rest counted; the search matches the group's name or a member's", () => {
        const capped = familyChips(groups, payable, nm, []);
        expect(capped.shown).toHaveLength(8);
        expect(capped.hidden).toBe(5);
        expect(familyChips(groups, payable, nm, ["angela"]).shown.map((g) => g.name)).toEqual(["Gómez 1"]);
        expect(familyChips(groups, payable, nm, ["perez"]).shown.map((g) => g.name)).toEqual(["Pérez"]);
    });
    it("«Saldos» renders at most 8 chips and «Ver más grupos (n)»", () => {
        const many: [number, BalanceC][] = [];
        for (const g of groups) for (const id of g.ids) many.push([id, balanceC({ due: 100, validated: 0, pending: 0 })]);
        const html = flat(renderToStaticMarkup(<FeeBalances balances={new Map(many)} nameOf={nm} groups={groups} selected={[]} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord />));
        expect(html.match(/data-group-chip=/g)).toHaveLength(8);
        expect(html).not.toMatch(/data-group-chip="Familia Chávez/);
        expect(html).toMatch(/data-more-groups=""[^>]*>Ver más grupos \(5\)</);
    });
    it("the sheet's «+ Añadir» follows the same rule", () => {
        const src = read("RegisterPaymentSheet.tsx");
        expect(src).toContain("const chips = familyChips(groups, (id) => payable.includes(id) && !chosen.includes(id), nameOf, words, { all: allGroups });");
        expect(src).toMatch(/data-more-groups=""[\s\S]{0,40}Ver más grupos \(\{chips\.hidden\}\)/);
    });
});

// ── UX-P5: a photo picked while another is shrinking ──────────────────────────────────────────────
describe("«Comprobante»: while a photo is shrinking no second one can be picked, and the latest pick wins", () => {
    it("pickSequence", () => {
        const s = pickSequence();
        const a = s.next();
        const b = s.next();
        expect([s.isLatest(a), s.isLatest(b)]).toEqual([false, true]);
    });
    it("working with no receipt yet: no way to pick (no «Tomar foto» button), the input disabled, «Preparando foto…»", () => {
        const html = flat(renderToStaticMarkup(<ProofPicker required proof={null} stored={false} storedLabel="" working onProof={() => {}} onRemoveStored={() => {}} />));
        expect(html).toContain('data-proof-state="working"');
        expect(html).not.toContain('data-proof-state="empty"');
        expect(html).not.toMatch(/<label[^>]*for=/);
        expect(html).not.toContain("Tomar foto o elegir archivo");
        expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
        const idle = flat(renderToStaticMarkup(<ProofPicker required proof={null} stored={false} storedLabel="" onProof={() => {}} onRemoveStored={() => {}} />));
        // (round 8, PUX-6: the picker is a focusable button that opens the input, no longer a <label>)
        expect(idle).toMatch(/<button type="button"[^>]*data-proof-state="empty"[^>]*>[\s\S]*Tomar foto o elegir archivo/);
        expect(idle).not.toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
    });
    it("a superseded result neither replaces the receipt nor ends «Preparando foto…»", () => {
        const src = read("RegisterPaymentSheet.tsx");
        expect(src).toMatch(/const mine = picks\.next\(\);[\s\S]*const r = await prepareProof\([^)]*\)[^;]*;\s*if \(!picks\.isLatest\(mine\)\) return;\s*onProof\(r\.dataUrl\);/);
        expect(src).toMatch(/\} catch \(err\) \{\s*if \(!picks\.isLatest\(mine\)\) return;/);
    });
});

// ── UX-P6: legible outdoors ──────────────────────────────────────────────────────────────────────────
describe("empty states and the loading label are AA-legible", () => {
    it("EmptyState title gray-600 (hint gray-500), Spinner label gray-600 — never gray-400 on near-white", () => {
        const e = renderToStaticMarkup(<EmptyState icon="fa-circle-check" title="Todos al día" hint="Nada pendiente" />);
        expect(e).toMatch(/<p class="text-gray-600 text-xs font-bold uppercase tracking-widest" data-empty-title="">Todos al día<\/p>/);
        expect(e).toMatch(/<p class="text-\[10px\] text-gray-500 mt-2/);
        const s = renderToStaticMarkup(<Spinner label="Cargando pagos…" />);
        expect(s).toContain('<p class="text-gray-600 text-xs font-bold uppercase tracking-widest">Cargando pagos…</p>');
        expect(e + s).not.toContain("text-gray-400 text-xs");
    });
});
