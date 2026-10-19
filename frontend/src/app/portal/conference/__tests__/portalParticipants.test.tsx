/**
 * «Participantes» in the coordinator portal, as rendered (server-rendered, node environment, no DOM), and
 * the shared ui.tsx primitives it is built from. Phones first — «debe servir en todos los celulares»:
 *   - compact rows (name, payment pill with paid of the fee, money under review, «⋮»), 20 per page with a
 *     pager whose buttons are 44 px; a table with up to two form columns from 768 px (tables-design D4);
 *   - «⋮» and a tap on the row open the participant's full sheet: every form field in order, «—» when
 *     empty (D11), the payment state, «Registrar pago de esta persona» and «Ver sus pagos» (D5);
 *   - a cancelled inscription is struck through, labelled «Cancelada», owes nothing and offers no payment
 *     (D-P19);
 *   - the multi-select lives in «Pagos de cuotas › Saldos» (D-P17); only against an OLDER plugin does
 *     this list keep its checkboxes and the old bulk dialog;
 *   - a Modal is a bottom sheet on a phone, capped by the dynamic viewport, its footer above the home
 *     indicator; inputs are 16 px below 640 px; every target is at least 44 px.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ParticipantList from "../ParticipantList";
import ParticipantSheet from "../ParticipantSheet";
import type { PortalPerson } from "../participants";
import type { PortalField } from "../form";
import {
    Button, CheckboxLabel, IconButton, KpiTile, MODAL_PANEL_CLS, Modal, MoneyInput, MoreButton, Pager, SegmentedControl, inputBoldCls, inputCls, inputDenseCls, selectCls,
} from "../ui";

const PORTAL = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");

const fields: PortalField[] = [
    { name: "first_name", label: "Nombre", type: "text", role: "first_name" },
    { name: "last_name", label: "Apellido", type: "text", role: "last_name" },
    { name: "email", label: "Correo", type: "email" },
    { name: "telefono", label: "Teléfono", type: "tel" },
    { name: "familia", label: "Familia", type: "text", is_group: 1 },
    { name: "alergias", label: "Alergias", type: "textarea" },
    { name: "llegada", label: "Llegada", type: "date" },
];
const row = (id: number, first: string, last: string, extra: Partial<PortalPerson> = {}): PortalPerson => ({
    id, first_name: first, last_name: last, total_due: 500, amount_paid: 0, payment_status: "unpaid", pending_amount: 0, returned_amount: 0, cancelled: false,
    registration_date: "2026-09-15 10:20:00", ...extra,
});
const people: PortalPerson[] = [
    row(1, "Ana", "Pérez", { amount_paid: 200, payment_status: "partial", pending_amount: 150, email: "ana@example.com", telefono: "300 123 4567", familia: "Pérez", llegada: "2026-10-20" }),
    row(2, "Luis", "Pérez", { returned_amount: 250 }),
    row(3, "Juan", "Ruiz", { cancelled: true, amount_paid: 0 }),
    row(4, "Rosa", "Díaz", { amount_paid: 500, payment_status: "paid" }),
];
const many = Array.from({ length: 45 }, (_, i) => row(100 + i, `Persona${String(i).padStart(2, "0")}`, "Prueba"));

const list = (over: Partial<React.ComponentProps<typeof ParticipantList>> = {}) =>
    flat(renderToStaticMarkup(<ParticipantList people={people} fields={fields} onOpen={() => {}} {...over} />));

describe("compact rows (phone) and the table (≥ 768 px)", () => {
    const html = list();
    it("each phone row is the name, the payment pill with paid of the fee, the money under review and «⋮»", () => {
        const ana = html.slice(html.indexOf('data-person="1"'), html.indexOf('data-person="2"'));
        // The row's name says the person's state too (round 5): never just «Ver ficha de Ana Pérez».
        expect(ana).toContain('aria-label="Ana Pérez: Abono, $200,00 de $500,00, $150,00 por validar"');
        expect(ana).toContain('data-pay-state="partial"');
        // Each amount whole; a line may break only at « / » (round 6: a peso fee «$250.000,00 / $250.000,00»).
        expect(ana).toContain('$200,00</span> / <span class="whitespace-nowrap">$500,00</span>');
        expect(ana).toContain("$150,00 por validar");
        expect(ana).toMatch(/aria-label="Más información de Ana Pérez" aria-haspopup="dialog" aria-expanded="false" data-portal-more="1" class="w-11 h-11 shrink-0/);
    });
    it("a returned payment shows as «Devuelto» on the row", () => {
        expect(html.slice(html.indexOf('data-person="2"'))).toContain('data-chip="returned"');
    });
    it("a cancelled inscription is struck through and «Cancelada», with no fee owed", () => {
        const juan = html.slice(html.indexOf('data-person="3"'), html.indexOf('data-person="4"'));
        expect(juan).toContain("line-through");
        expect(juan).toContain('data-pay-state="cancelled"');
        expect(juan).toContain("Cancelada");
        expect(juan).toContain("Sin cuota");
    });
    it("the phone list and the table switch at 768 px (core Tailwind, so md: is safe here)", () => {
        expect(html).toMatch(/<ul class="md:hidden[^"]*" data-testid="participants-list"/);
        expect(html).toMatch(/<div class="hidden md:block" style="container-type:inline-size;container-name:cm-pl" data-pl-card="">(<style>[^<]*<\/style>)?<table[^>]*data-testid="participants-table"/);
    });
    it("the table has the name, up to two form columns (never the name or the grouping field), Pago and «⋮»", () => {
        const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
        expect(head).toContain("Participante");
        expect(head).toContain("Correo");
        expect(head).toContain("Teléfono");
        expect(head).not.toContain(">Alergias<");
        expect(head).not.toContain(">Familia<");
        expect(head).not.toContain(">Nombre<");
    });
    it("no checkboxes and no selection bar: paying several people lives in «Saldos» (D-P17)", () => {
        expect(html).not.toContain('aria-label="Seleccionar a');
        expect(html).not.toContain("data-touch-check");
        expect(html).not.toContain('data-testid="legacy-selection-bar"');
    });
    it("the search box is 16 px on phones and the chips count each payment state", () => {
        expect(html).toMatch(/<input type="search" class="[^"]*text-base sm:text-sm[^"]*"[^>]*data-testid="participants-search"/);
        expect(html).toMatch(/data-pay-filter="pending">Por validar <span[^>]*>\(1\)/);
        expect(html).toMatch(/data-pay-filter="unpaid">Sin pagar <span[^>]*>\(1\)/);
        expect(html).toContain("Ocultar canceladas (1)");
    });
});

describe("paging (20 per page) and the pager", () => {
    it("shows 20 rows and a pager with 44 px buttons and «1–20 de 45»", () => {
        const html = list({ people: many });
        expect((html.match(/data-person="/g) || []).length).toBe(40);   // 20 rows × (list + table)
        expect(html).toContain('data-portal-pager=""');
        expect(html).toMatch(/1–20 de 45/);
        expect(html).toMatch(/aria-label="Página siguiente"/);
        expect(html).toMatch(/class="inline-flex items-center justify-center gap-2 min-h-11 min-w-11/);
        expect(html).toMatch(/aria-current="page" aria-label="Página 1"/);
    });
    it("a later page shows its rows", () => {
        const html = list({ people: many, initialPage: 3 });
        expect(html).toContain('data-person="140"');
        expect(html).not.toContain('data-person="100"');
        expect(html).toMatch(/41–45 de 45/);
    });
    it("no pager when everything fits the smallest page", () => {
        expect(list()).not.toContain("data-portal-pager");
    });
    it("a filter with no match says so and offers to clear it", () => {
        const html = list({ initialFilter: { q: "zzz" } });
        expect(html).toContain("Nadie coincide con la búsqueda.");
        expect(html).toContain("Quitar filtros");
    });
});

describe("version skew: an older plugin keeps the checkboxes and the bulk dialog", () => {
    const html = list({ legacy: { selected: [1, 2], setSelected: () => {}, onPay: () => {}, canPay: true } });
    it("44 px checkboxes; a cancelled person cannot be ticked", () => {
        expect(html).toMatch(/<label class="inline-flex items-center justify-center min-w-11 min-h-11[^"]*" data-touch-check=""><input type="checkbox"[^>]*aria-label="Seleccionar a Ana Pérez"/);
        expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*aria-label="Seleccionar a Juan Ruiz"|aria-label="Seleccionar a Juan Ruiz"[^>]*disabled=""/);
    });
    it("the bar «Registrar pago (2)» sticks to the bottom above the home indicator", () => {
        expect(html).toMatch(/class="sticky bottom-0[^"]*pb-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\][^"]*" data-testid="legacy-selection-bar"/);
        expect(html).toContain("Registrar pago (2)");
    });
});

describe("the participant's sheet («⋮»)", () => {
    const sheet = (p: PortalPerson, over: Partial<React.ComponentProps<typeof ParticipantSheet>> = {}) =>
        flat(renderToStaticMarkup(<ParticipantSheet person={p} fields={fields} onClose={() => {}} feesOn canRecord onPay={() => {}} onSeePayments={() => {}} {...over} />));
    it("is a dialog named after the person, with the registration date", () => {
        const html = sheet(people[0]);
        expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"[\s\S]*<h3 id="\1"[^>]*>Ana Pérez<\/h3>/);
        expect(html).toContain("Inscripción: 15/09/2026");
    });
    it("lists EVERY form field in order, formatted, «—» for an empty one (D11)", () => {
        const html = sheet(people[0]);
        const labels = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]);
        expect(labels).toEqual(["Nombre", "Apellido", "Correo", "Teléfono", "Familia", "Alergias", "Llegada", "Fecha de inscripción"]);
        expect(html).toContain('href="mailto:ana@example.com"');
        expect(html).toContain('href="tel:3001234567"');
        expect(html).toContain("20/10/2026");
        expect(html).toMatch(/Alergias<\/dt><dd class="[^"]*text-gray-400[^"]*">—<\/dd>/);
    });
    it("shows the money: paid of the fee, under review, still to pay — and the two actions", () => {
        const html = sheet(people[0]);
        expect(html).toContain("Pagado <span class=\"text-gray-900 tabular-nums\">$200,00</span> de <span class=\"tabular-nums\">$500,00</span>");
        expect(html).toContain("$150,00 por validar");
        expect(html).toContain("Falta por pagar: <span class=\"tabular-nums\">$150,00</span>");
        expect(html).toContain('data-action="pay"');
        expect(html).toContain("Registrar pago de esta persona");
        expect(html).toContain('data-action="see-payments"');
    });
    it("a cancelled inscription says why it cannot be paid and offers no payment — but its payments can still be seen", () => {
        const html = sheet(people[2]);
        expect(html).toContain("Inscripción cancelada: no tiene cuota pendiente y no se le pueden registrar pagos.");
        expect(html).not.toContain('data-action="pay"');
        expect(html).toContain('data-action="see-payments"');
        expect(html).toContain("Cancelada");
    });
    it("someone up to date has nothing to pay; no enabled method disables the button and says why", () => {
        expect(sheet(people[3])).not.toContain('data-action="pay"');
        const html = sheet(people[1], { canRecord: false });
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-action="pay"/);
        expect(html).toContain("La administración no ha habilitado formas de pago para esta localidad.");
    });
    it("an older plugin: no «Ver sus pagos»", () => {
        expect(sheet(people[1], { feesOn: false, onSeePayments: undefined })).not.toContain('data-action="see-payments"');
    });
});

describe("ui.tsx: phones first", () => {
    it("Modal = a bottom sheet below 640 px, a centred card from 640 px, capped by the DYNAMIC viewport", () => {
        const html = flat(renderToStaticMarkup(<Modal title="T" onClose={() => {}} footer={<Button>OK</Button>}><p>x</p></Modal>));
        expect(html).toMatch(/class="fixed inset-0[^"]*flex items-end sm:items-center justify-center/);
        for (const c of ["rounded-t-[28px]", "sm:rounded-[40px]", "max-h-[92vh]", "supports-[height:100dvh]:max-h-[92dvh]", "sm:max-w-lg"]) expect(MODAL_PANEL_CLS + " sm:max-w-lg").toContain(c);
        expect(html).toContain('role="dialog" aria-modal="true"');
        expect(html).toMatch(/data-portal-sheet-body=""/);
        expect(html).toMatch(/class="[^"]*pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\][^"]*" data-portal-sheet-foot=""/);
        expect(html).toMatch(/aria-label="Cerrar"/);
        expect(html).toMatch(/class="w-11 h-11 shrink-0 flex items-center justify-center[^"]*" aria-label="Cerrar"/);
    });
    it("Modal without a footer pads its body above the home indicator", () => {
        const html = flat(renderToStaticMarkup(<Modal title="T" onClose={() => {}}><p>x</p></Modal>));
        expect(html).toMatch(/pb-\[max\(1\.25rem,env\(safe-area-inset-bottom\)\)\][^"]*" style="[^"]*" data-portal-sheet-body=""/);
    });
    it("Modal pins the page behind it, returns the focus, and only the topmost one handles Escape (source)", () => {
        const ui = read("ui.tsx");
        expect(ui).toContain("const release = lockBodyScroll();");
        expect(ui).toMatch(/if \(topDialog\(\) !== id\) return;/);
        // Back to the control that opened it; if that control is gone, to the dialog underneath.
        expect(ui).toMatch(/const target = opener instanceof HTMLElement && opener\.isConnected[^;]*: under != null \? dialogPanels\.get\(under\)/);
        expect(ui).toContain("target?.focus({ preventScroll: true })");
        expect(ui).toContain('return typeof document === "undefined" ? node : createPortal(node, document.body);');
    });
    it("every input is 16 px below 640 px (iOS zooms into anything smaller)", () => {
        for (const cls of [inputCls, selectCls, inputBoldCls]) expect(cls).toContain("text-base sm:text-sm");
        expect(inputDenseCls).toContain("text-base sm:text-xs");
        for (const cls of [inputCls, inputBoldCls]) expect(cls.split(" ")).not.toContain("text-sm");
    });
    it("44 px targets: Button, IconButton (on phones), MoreButton, CheckboxLabel, SegmentedControl", () => {
        expect(flat(renderToStaticMarkup(<Button size="sm">x</Button>))).toContain("min-h-11");
        expect(flat(renderToStaticMarkup(<IconButton icon="fa-x" aria-label="x" />))).toMatch(/w-11 h-11 sm:w-9 sm:h-9/);
        expect(flat(renderToStaticMarkup(<MoreButton name="Ana" onClick={() => {}} />))).toMatch(/aria-label="Más información de Ana"[^>]*class="w-11 h-11/);
        expect(flat(renderToStaticMarkup(<CheckboxLabel label="x" checked={false} onChange={() => {}} />))).toContain("min-w-11 min-h-11");
        const seg = flat(renderToStaticMarkup(<SegmentedControl label="Modo" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={() => {}} />));
        expect(seg).toMatch(/role="radiogroup" aria-label="Modo"/);
        expect(seg).toMatch(/role="radio" aria-checked="true"[^>]*class="[^"]*min-h-11/);
    });
    it("MoneyInput: decimal keypad, free text (so «1.250,50» works), 16 px", () => {
        const html = flat(renderToStaticMarkup(<MoneyInput value="1.250,50" onChange={() => {}} label="Monto" />));
        expect(html).toMatch(/<input type="text" inputMode="decimal"[^>]*aria-label="Monto"/);
        expect(html).toContain("text-base sm:text-sm");
        expect(html).toContain('value="1.250,50"');
    });
    it("KpiTile: a compact figure, a button only when it does something", () => {
        expect(flat(renderToStaticMarkup(<KpiTile label="Cuotas" value="$1,00" />))).toMatch(/^<div class="min-h-16/);
        expect(flat(renderToStaticMarkup(<KpiTile label="Por validar" value="$1,00" onClick={() => {}} />))).toMatch(/^<button type="button"/);
    });
    it("Pager: hidden when everything fits; phone «‹ Anterior | 2 / 3 | Siguiente ›»; the page is announced", () => {
        expect(renderToStaticMarkup(<Pager page={1} count={1} from={1} to={5} total={5} windowPages={[1]} size={20} sizes={[10, 20]} onPage={() => {}} />)).toBe("");
        const html = flat(renderToStaticMarkup(<Pager page={2} count={3} from={21} to={40} total={45} windowPages={[1, 2, 3]} size={20} sizes={[10, 20, 50, 100]} onPage={() => {}} onSize={() => {}} />));
        expect(html).toMatch(/data-pager-phone=""[\s\S]*Anterior[\s\S]*2 \/ 3[\s\S]*Siguiente/);
        expect(html).toContain('aria-live="polite">Página 2 de 3');
        expect(html).toMatch(/<select class="min-h-11[^"]*text-base sm:text-xs/);
    });
});

describe("page.tsx wiring of «Participantes»", () => {
    const page = read("page.tsx");
    it("the sheet reads the person BY ID from the live roster and opens over the list", () => {
        expect(page).toContain("const sheetPerson = sheetId != null ? byId.get(sheetId) ?? null : null;");
        expect(page).toMatch(/\{sheetPerson && \(\s*<ParticipantSheet/);
    });
    it("«Registrar pago de esta persona» opens the new payment sheet (or the old dialog for an older plugin); «Ver sus pagos» filters «Pagos»", () => {
        expect(page).toMatch(/if \(feesOn\) \{ void feeHub\.openRegister\(\[id\]\); return; \}/);
        expect(page).toMatch(/feeHub\.setPersonFilter\(id\);\s*feeHub\.setSegment\('transfers'\);\s*setTab\('fees'\);/);
    });
    it("on a phone the three tabs share the width (no strip scrolling sideways), each at least 56 px tall", () => {
        expect(page).toMatch(/className="grid grid-flow-col auto-cols-fr sm:flex border-b border-gray-200" role="tablist"/);
        expect(page).toContain("min-h-14 sm:min-h-12 min-w-0 border-b-2");
        expect(page).not.toMatch(/role="tablist"[^>]*overflow-x-auto|overflow-x-auto[^"]*" role="tablist"/);
    });
    it("Hospedajes is unchanged: still mounted with the same props", () => {
        expect(page).toContain("<Hospedajes authHeaders={portalAuthHeaders} onLocationRefresh={refreshMyLocation}");
    });
});
