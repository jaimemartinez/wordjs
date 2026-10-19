/**
 * «Pagos de cuotas» and «Participantes» in the coordinator portal — the seventh round (the fourth review round;
 * node, no DOM: pure rules, server-rendered screens, the hub's wiring on its source). Each pinned so that undoing
 * it fails here:
 *   - on a phone held sideways a sheet keeps its room for the form (compact header and footer below 500 px of
 *     height: the body had ~130 px of a 390 px screen);
 *   - while a sheet is open, what the payments have to say is said IN it — who was left out when «Registrar pago»
 *     opened, a delete that failed, a payment sent from a participant's sheet — never as a toast over its buttons;
 *   - a split part's «máximo» is read with its field; money fields group thousands;
 *   - «Participantes» counts what the hero counts (active people, «· 1 cancelada» apart), its separators stay with
 *     their facts; the fees badge never wraps; the search fields are named starting with their visible words.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { noticeTarget, parseFeeView, parseTransfer, reopenDraft, viewBalanceC, type DraftContext, type FeeDraft, type PortalFeeView } from "../feePayments";
import { centsToInput, tidyMoneyInput } from "../feeSplit";
import RegisterPaymentSheet from "../RegisterPaymentSheet";
import TransferSheet from "../TransferSheet";
import ParticipantSheet from "../ParticipantSheet";
import FeeBalances from "../FeeBalances";
import { Modal, SPLIT_COLUMN_REM, SheetNotice, compactMoneyTextPx } from "../ui";
import { PORTAL_SHORT_SHEET_CSS } from "../portalCss";
import ConferencePortalLayout from "../layout";

const PORTAL = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");
const html = (node: React.ReactElement) => flat(renderToStaticMarkup(node));

const person = (id: number, due: number, validated = 0, pending = 0) => {
    const dueC = Math.round(due * 100);
    const coverC = Math.max(0, dueC - Math.round(validated * 100) - Math.round(pending * 100));
    return { id, due, validated, pending, returned: 0, to_cover: coverC / 100, credit: 0, cancelled: false, payable: coverC > 0 };
};
const view = (people = [person(1, 250), person(2, 250), person(3, 250, 0, 100)]): PortalFeeView => parseFeeView({
    features: { fee_payments: 1 }, location: { id: 7, name: "Bogotá" }, methods: ["Efectivo", "Transferencia"], can_record: true,
    proof: { required_for: ["Transferencia"], max_chars: 1400000 }, max_people: 200, summary: {}, people,
    counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [],
})!;
const ctxOf = (v: PortalFeeView): DraftContext => ({ balances: new Map(v.people.map((b) => [b.id, viewBalanceC(b)])), methods: v.methods, proofRequiredFor: v.proof.required_for, maxPeople: v.max_people });
const names: Record<number, string> = { 1: "Ana Pérez", 2: "Luis Pérez", 3: "Sofía Pérez" };
const nameOf = (id: number) => names[id] ?? `#${id}`;
const draftFor = (ids: number[], over: Partial<FeeDraft> = {}, v = view()): FeeDraft => ({ ...reopenDraft(null, ids, v.methods, null, ctxOf(v).balances), ...over });
const sheet = (d: FeeDraft, over: Record<string, unknown> = {}, v = view()) => html(
    <RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={ctxOf(v)} nameOf={nameOf} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} {...over} />,
);

// ── a phone held sideways ───────────────────────────────────────────────────────────────────────────────
describe("a sheet on a phone held sideways keeps room for its form (review PUX-1)", () => {
    it("below 500 px of height the header, body and footer are compact and the sheet may take the height", () => {
        expect(PORTAL_SHORT_SHEET_CSS).toMatch(/^@media \(max-height: 500px\) \{/);
        expect(PORTAL_SHORT_SHEET_CSS).toContain("[data-portal-sheet] { max-height: calc(100dvh - 0.5rem); }");
        expect(PORTAL_SHORT_SHEET_CSS).toContain("[data-portal-sheet-head] { padding: 0.5rem 0.75rem 0.5rem 1.25rem; }");
        expect(PORTAL_SHORT_SHEET_CSS).toContain("[data-portal-sheet-head] h3 { font-size: 1.125rem; line-height: 1.5rem; }");
        expect(PORTAL_SHORT_SHEET_CSS).toContain("[data-portal-sheet-body] { padding: 0.75rem 1.25rem; }");
        expect(PORTAL_SHORT_SHEET_CSS).toContain("[data-portal-sheet-foot] { padding-top: 0.5rem; padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px)); }");
        // The rules reach the sheets (portalled to <body>): the layout carries them, the header carries its key.
        expect(html(<ConferencePortalLayout><p>x</p></ConferencePortalLayout>)).toContain("@media (max-height: 500px)");
        expect(html(<Modal title="Registrar pago" onClose={() => {}} footer={<button>Enviar</button>}><p>x</p></Modal>)).toMatch(/<div class="bg-gray-50\/50[^"]*" data-portal-sheet-head="">/);
    });
});

// ── messages where the coordinator looks ────────────────────────────────────────────────────────────────
describe("while a sheet is open, the payments speak in it — never a toast over its buttons (review PUX-7, skeptic)", () => {
    it("noticeTarget: the open sheet, else a toast", () => {
        expect(noticeTarget({ sheetOpen: true })).toBe("sheet");
        expect(noticeTarget({ sheetOpen: false })).toBe("toast");
    });
    it("«Registrar pago» opened for people of whom some cannot be paid says so at the TOP of the sheet", () => {
        const out = sheet(draftFor([1]), { notice: "2 de las personas elegidas no tienen nada por registrar." });
        expect(out).toMatch(/<div class="[^"]*bg-amber-50[^"]*" role="status" data-sheet-notice="amber">[\s\S]*?2 de las personas elegidas no tienen nada por registrar\.<\/span>/);
        expect(out.indexOf("data-sheet-notice")).toBeLessThan(out.indexOf('data-register-section="people"'));
        expect(sheet(draftFor([1]))).not.toContain("data-sheet-notice");
    });
    it("the payment sheet and the participant's sheet show the hub's notice (an error at once: role=alert)", () => {
        const t = parseTransfer({ id: 4, foreign: false, recorded_via: "portal", amount: 30, allocated: 30, method: "Efectivo", reference: null, paid_on: "2026-10-07", note: null, status: "pending", review_note: null, alloc_gen: 1, created_at: null, submitted_at: null, updated_at: null, reviewed_at: null, has_proof: false, people: 1, allocations: [{ id: 1, inscription_id: 1, amount: 30, moved: false, cancelled: false }], can_edit: true, can_delete: true, duplicate_of: null, reused: false, reused_by: null })!;
        const ts = html(<TransferSheet transfer={t} nameOf={nameOf} busy={false} onClose={() => {}} onEdit={() => {}} onDuplicate={() => {}} onDelete={() => {}} loadProof={async () => ""} notice={{ text: "No se pudo eliminar: sin conexión.", tone: "rose", n: 1 }} />);
        expect(ts).toMatch(/<div class="[^"]*bg-rose-50[^"]*" role="alert" data-sheet-notice="rose">[\s\S]*?No se pudo eliminar: sin conexión\./);
        const p = { id: 1, first_name: "Ana", last_name: "Pérez", total_due: 250, amount_paid: 0, payment_status: "unpaid", pending_amount: 30, returned_amount: 0, status: "active", registration_date: "2026-10-01" } as any;
        const ps = html(<ParticipantSheet person={p} fields={[]} onClose={() => {}} feesOn canRecord onPay={() => {}} notice={{ text: "Pago enviado ($30,00): queda por validar.", tone: "emerald", n: 2 }} />);
        expect(ps).toMatch(/<div class="[^"]*bg-emerald-50[^"]*" role="status" data-sheet-notice="emerald">[\s\S]*?Pago enviado \(\$30,00\): queda por validar\./);
        expect(html(<SheetNotice notice={null} />)).toBe("");
    });
    it("the hub says through `say` (the open sheet first), the left-out people go into the register sheet, and the page tells it when a participant's sheet is open", () => {
        const tab = read("FeePaymentsTab.tsx");
        expect(tab).toMatch(/const where = noticeTarget\(\{ sheetOpen: sheetRef\.current != null \|\| !!optsRef\.current\.sheetOpen\?\.\(\) \}\);\s*if \(where === "sheet"\) setNotice/);
        expect(tab).toMatch(/setSheet\(\{ kind: "register" \}\);\s*\/\/[^\n]*\n[^\n]*\n\s*setRegisterNotice\(loadNotice \|\| notice\);/);
        // No direct toast left in the hub's flows: every message goes through `say`.
        expect((tab.match(/optsRef\.current\.notify\(/g) || []).length).toBe(1);
        expect(tab).toMatch(/\/\/ The payment's sheet is still open \(only the confirm closed\)[^\n]*\n\s*else say\(a\.message, "error"\);/);
        expect(tab).toMatch(/setSheet\(null\);\s*setRegisterNotice\(null\);\s*\/\/[^\n]*\n\s*say\(out\.toast, "success"\);/);
        expect(tab).toMatch(/notice=\{hub\.notice\}/);
        expect(tab).toMatch(/notice=\{hub\.registerNotice\}/);
        const page = read("page.tsx");
        expect(page).toMatch(/sheetOpen: \(\) => sheetId != null,/);
        expect(page).toMatch(/onClose=\{\(\) => \{ setSheetId\(null\); feeHub\.clearNotice\(\); \}\}\s*notice=\{feeHub\.sheet \? null : feeHub\.notice\}/);
    });
});

// ── the split ───────────────────────────────────────────────────────────────────────────────────────────
describe("«Reparto»: a part's «máximo» is read with its field; amounts group thousands (review PUX-8, PUX-9)", () => {
    it("the part over what the person may receive is described by its «Supera lo que falta: máximo» line", () => {
        const out = sheet(draftFor([1, 2], { mode: "manual", manual: { 1: "300", 2: "10" }, total: "310", totalTouched: true }));
        expect(out).toMatch(/aria-label="Parte de Ana Pérez" aria-invalid="true" aria-describedby="split-after-1"/);
        expect(out).toMatch(/<span id="split-after-1" class="[^"]*text-rose-700"[^>]*data-split-after="1">Supera lo que falta: máximo \$250,00<\/span>/);
        expect(out).toMatch(/aria-describedby="split-after-2"/);
    });
    it("money inputs read «1.250.000,00» once left, and the split field has room for it", () => {
        expect(centsToInput(125000000)).toBe("1.250.000,00");
        expect(tidyMoneyInput("1250000")).toBe("1.250.000,00");
        expect(tidyMoneyInput("250000")).toBe("250.000,00");
        expect(compactMoneyTextPx(SPLIT_COLUMN_REM)).toBeGreaterThanOrEqual("1.250.000,00".length * 8.7);
    });
});

// ── «Participantes» ─────────────────────────────────────────────────────────────────────────────────────
describe("«Participantes»: counts like the hero, separators with their facts, whole names for voice control (PUX-12, 13, 14)", () => {
    it("the caption counts active people and the cancelled apart; each «·» is inside the fact it introduces", () => {
        const page = read("page.tsx");
        expect(page).toMatch(/const cancelledCount = inscriptions\.filter\(\(i\) => isCancelled\(i\)\)\.length;\s*const activeCount = inscriptions\.length - cancelledCount;/);
        const caption = page.match(/data-testid="participants-caption">([\s\S]*?)<\/span>\s*\) : undefined\}/)![1];
        expect(caption).toContain("{activeCount} {activeCount === 1 ? 'participante' : 'participantes'}");
        expect(caption).toMatch(/<span className="whitespace-nowrap text-blue-500 font-black">· \{paidCount\}/);
        expect(caption).toMatch(/\{cancelledCount > 0 && <span className="whitespace-nowrap">· \{cancelledCount === 1 \? '1 cancelada'/);
        expect(caption).not.toMatch(/w-1 h-1 rounded-full/);
        expect(caption).not.toContain("inscriptions.length}");
    });
    it("the «Pagos de cuotas» badge stays on one line", () => {
        expect(read("page.tsx")).toMatch(/<Badge tone=\{badge\.tone\} size="xs" className="whitespace-nowrap" data-testid="fees-badge">/);
    });
    it("the search fields' accessible names start with their visible words (label in name)", () => {
        const v = view();
        const out = html(<FeeBalances balances={ctxOf(v).balances as any} nameOf={nameOf} groups={[]} selected={[]} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord />);
        expect(out).toMatch(/placeholder="Buscar persona" aria-label="Buscar persona en los saldos"/);
        expect(read("ParticipantList.tsx")).toMatch(/placeholder="Buscar participante"\s*aria-label="Buscar participante por nombre o cualquier dato"/);
    });
});
