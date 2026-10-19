/**
 * «Pagos de cuotas» and «Participantes» in the coordinator portal — the fifth round (node, no DOM):
 *   - the receipt cache knows the split generation: after «Corregir y reenviar» with a new photo, «Ver
 *     comprobante» shows the NEW one (it showed the photo cached before, and the coordinator sent it again);
 *   - a phone row of «Participantes» says the person's state to a screen reader, not just «Ver ficha de …»;
 *   - the desktop table's form values wrap (an e-mail at «@» and «.») instead of ending «…» with the rest in a
 *     hover-only title; its headers are AA gray-500;
 *   - the administration's note on a «Pagos» row: two lines broken between words, never one line cut mid-word;
 *   - the «Saldos» chips count with the search, as «Participantes» does.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { balanceC, createProofCache, parseFeeView, type BalanceC } from "../feePayments";
import ParticipantList, { participantRowLabel, softBreakParts } from "../ParticipantList";
import FeeTransfers from "../FeeTransfers";
import FeeBalances from "../FeeBalances";
import { thCls } from "../ui";
import type { PortalPerson } from "../participants";
import type { PortalField } from "../form";

const PORTAL = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(PORTAL, f), "utf8");
const flat = (html: string) => html.replace(/<!-- -->/g, "");
const PNG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC";

describe("a receipt replaced by «Corregir y reenviar» is never shown from the cache", () => {
    it("createProofCache: the same payment at a new generation is fetched again; forget() drops every generation", async () => {
        let next = PNG_A;
        const api = { proof: vi.fn(async () => next) };
        const cache = createProofCache(api);
        expect(await cache.get(7, 1)).toBe(PNG_A);
        expect(await cache.get(7, 1)).toBe(PNG_A);
        expect(api.proof).toHaveBeenCalledTimes(1);
        next = PNG_B;
        expect(await cache.get(7, 2)).toBe(PNG_B);
        expect(api.proof).toHaveBeenCalledTimes(2);
        expect(cache.peek(7, 1)).toBe(PNG_A);
        cache.forget(7);
        expect(cache.peek(7, 1)).toBeNull();
        expect(cache.peek(7, 2)).toBeNull();
    });
    it("the payment sheet asks for the generation it shows; a sent edit forgets the payment's receipts; the stored one loads at the draft's generation", () => {
        expect(read("TransferSheet.tsx")).toContain("url: await loadProof(t.id, t.alloc_gen)");
        const tab = read("FeePaymentsTab.tsx");
        expect(tab).toMatch(/case "sent":\s*\/\/[^\n]*\n\s*if \(d\.kind === "edit" && d\.editId != null\) proofs\.forget\(d\.editId\);/);
        expect(tab).toContain("loadProof={(id, gen) => hub.proofs.get(id, gen)}");
        expect(tab).toContain("loadStoredProof={editId != null ? () => hub.proofs.get(editId, editGen) : undefined}");
        expect(tab).toContain('const editGen = draft?.kind === "edit" ? draft.expected?.alloc_gen ?? null');
    });
});

const fields: PortalField[] = [
    { name: "first_name", label: "Nombre", type: "text", role: "first_name" },
    { name: "last_name", label: "Apellido", type: "text", role: "last_name" },
    { name: "email", label: "Correo electrónico de contacto", type: "email" },
    { name: "telefono", label: "Teléfono", type: "tel" },
];
const row = (id: number, first: string, last: string, extra: Partial<PortalPerson> = {}): PortalPerson => ({
    id, first_name: first, last_name: last, total_due: 500, amount_paid: 0, payment_status: "unpaid", pending_amount: 0, returned_amount: 0, cancelled: false,
    registration_date: "2026-09-15 10:20:00", ...extra,
});
const people: PortalPerson[] = [
    row(1, "Ana", "Pérez", { amount_paid: 200, payment_status: "partial", pending_amount: 150, email: "maria.fernanda.lopez@example.com", telefono: "300 123 4567" }),
    row(2, "Luis", "Pérez", { returned_amount: 250 }),
    row(3, "Juan", "Ruiz", { cancelled: true }),
];

describe("«Participantes»: a row says the person's state; values are never cut", () => {
    const html = flat(renderToStaticMarkup(<ParticipantList people={people} fields={fields} onOpen={() => {}} />));
    it("participantRowLabel: the name and what the row shows", () => {
        expect(participantRowLabel("Ana Pérez", people[0])).toBe("Ana Pérez: Abono, $200,00 de $500,00, $150,00 por validar");
        expect(participantRowLabel("Luis Pérez", people[1])).toBe("Luis Pérez: Sin pagar, $0,00 de $500,00, Devuelto");
        expect(participantRowLabel("Juan Ruiz", people[2])).toBe("Juan Ruiz: Cancelada, Sin cuota");
        expect(html).toContain('aria-label="Luis Pérez: Sin pagar, $0,00 de $500,00, Devuelto" aria-haspopup="dialog"');
        expect(html).not.toContain("Ver ficha de");
    });
    it("a desktop form value wraps at the e-mail's own points — no truncate, no hover-only title", () => {
        expect(softBreakParts("maria.fernanda.lopez@example.com")).toEqual(["maria", ".fernanda", ".lopez@", "example", ".com"]);
        expect(softBreakParts("300 123 4567")).toEqual(["300 123 4567"]);
        const table = html.slice(html.indexOf('data-testid="participants-table"'));
        expect(table).toContain('<td class="px-3 py-3 text-xs text-gray-600 break-words" data-field-cell="email" data-pl-col="">maria<wbr/>.fernanda<wbr/>.lopez@<wbr/>example<wbr/>.com</td>');
        expect(table).not.toMatch(/<td[^>]*truncate/);
        expect(table).not.toContain('title="maria');
        // A long header wraps instead of «CORREO ELECTRÓNI…».
        // Round 6: its OWN class string (thWrapCls): whitespace-normal without thCls's whitespace-nowrap, never mid-word.
        expect(table).toMatch(/<th scope="col" class="[^"]*whitespace-normal" style="width:9rem" data-pl-col="">Correo electrónico de contacto<\/th>/);
    });
    it("the table headers are gray-500 (AA), not gray-400", () => {
        expect(thCls).toContain("text-gray-500");
        expect(thCls).not.toContain("text-gray-400");
    });
});

describe("«Pagos»: the administration's note on a row", () => {
    it("two lines, broken between words — the sheet has the whole note", () => {
        const v = parseFeeView({
            features: { fee_payments: 1 }, location: { id: 7, name: "Norte" }, methods: ["Efectivo"], can_record: true, proof: { required_for: ["Transferencia"], max_chars: 1 }, max_people: 200, summary: {},
            people: [{ id: 1, due: 500, validated: 0, pending: 0, returned: 750, to_cover: 500, credit: 0, cancelled: false, payable: true }],
            counts: { pending: 0, validated: 0, returned: 1, rejected: 0, total: 1 },
            transfers: [{ id: 14, foreign: false, recorded_via: "portal", amount: 750, allocated: 750, method: "Transferencia", reference: "REF-1", paid_on: "2026-10-07", note: null, status: "returned",
                review_note: "El monto no coincide con la transferencia: el banco dice 550 y el reparto suma 750, revisa a Sofía", alloc_gen: 2, created_at: "2026-10-07 10:00:00", submitted_at: "2026-10-07 10:00:00",
                updated_at: null, reviewed_at: null, has_proof: true, people: 1, allocations: [{ id: 501, inscription_id: 1, amount: 750, moved: false, cancelled: false }], can_edit: true, can_delete: true }],
        })!;
        const html = flat(renderToStaticMarkup(<FeeTransfers transfers={v.transfers} nameOf={() => "Ana Pérez"} onOpen={() => {}} canRecord />));
        expect(html).toMatch(/<span class="mt-0\.5 block text-xs font-bold line-clamp-2 break-words text-orange-800" data-review-note="">Nota de la administración: El monto no coincide/);
        expect(html).not.toMatch(/data-review-note=""[^>]*truncate|truncate[^>]*data-review-note/);
    });
});

describe("«Saldos»: each chip counts with the search", () => {
    const balances = new Map<number, BalanceC>([
        [1, balanceC({ due: 500, validated: 0, pending: 0 })],
        [2, balanceC({ due: 500, validated: 0, pending: 250 })],
        [3, balanceC({ due: 300, validated: 300, pending: 0 })],
        [4, balanceC({ due: 400, validated: 0, pending: 0, cancelled: true })],
    ]);
    const names: Record<number, string> = { 1: "Ana Pérez", 2: "Luis Pérez Gómez", 3: "Rosa Díaz", 4: "Juan Ruiz" };
    const render = (q: string) => flat(renderToStaticMarkup(<FeeBalances balances={balances} nameOf={(id) => names[id]} groups={[]} selected={[]} onSelect={() => {}} onRegister={() => {}} onOpenPerson={() => {}} canRecord initialFilter="all" initialQuery={q} />));
    it("«perez» shows the two Pérez rows and «Todos (2)», «Con saldo (2)», «Pagados (0)»", () => {
        const html = render("perez");
        expect(html).toMatch(/data-balance-filter="all">Todos <span class="tabular-nums opacity-80">\(2\)<\/span>/);
        expect(html).toMatch(/data-balance-filter="owing">Con saldo <span class="tabular-nums opacity-80">\(2\)<\/span>/);
        expect(html).toMatch(/data-balance-filter="settled">Pagados <span class="tabular-nums opacity-80">\(0\)<\/span>/);
        const all = render("");
        expect(all).toMatch(/data-balance-filter="all">Todos <span class="tabular-nums opacity-80">\(4\)<\/span>/);
    });
});
