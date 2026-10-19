/**
 * conference-manager 2.16.0 in the coordinators' portal: a form may have no Nombre / Apellido and no Género.
 *
 * Before, the portal named every attendee of such a conference «#id» (cards, initials, search, pickers,
 * confirmations) — the admin screens already fell back to other form fields — and showed «Género sin
 * indicar» on every card plus an «Ocupantes» filter that could only match nothing. Pinned: the server's
 * `display_name` names people everywhere `attendeeName` does (and the search finds them by it); the gender
 * dots, words and filter are gone when the conference collects no gender, and stay when it does; the
 * portal's inscription list names people like the admin (never an ID document or a contact as a name).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LodgingExplorer, { type LodgingExplorerProps } from "../../../../../../marketplace/plugins/conference-manager/client/portal/LodgingExplorer";
import { attendeeName, formHasGender, lodgingSummary, type LodgingAttendee, type LodgingRoom } from "../../../../../../marketplace/plugins/conference-manager/client/portal/lodging";
import { filterAttendees } from "../../../../../../marketplace/plugins/conference-manager/client/portal/lodgingView";
import { isNameFallbackField, portalPersonName } from "../../../../../../marketplace/plugins/conference-manager/client/portal/form";

const noName = (id: number, display: string, extra: Partial<LodgingAttendee> = {}): LodgingAttendee =>
    ({ id, first_name: null, last_name: null, display_name: display, gender: null, family_group: null, ...extra });

describe("names (lodging.ts attendeeName)", () => {
    it("uses the server's display_name when the form has no Nombre / Apellido; the name columns still win", () => {
        expect(attendeeName(noName(1, "Ana Ruiz"))).toBe("Ana Ruiz");
        expect(attendeeName({ id: 2, first_name: "Juan", last_name: "Pérez", display_name: "otro" })).toBe("Juan Pérez");
        expect(attendeeName({ id: 3 })).toBe("#3");
        expect(attendeeName(noName(4, "  "))).toBe("#4");
    });

    it("the search finds such an attendee by that name", () => {
        const people = [noName(1, "Ana Ruiz"), noName(2, "Luis Gómez")];
        expect(filterAttendees(people, "ruiz").map((a) => a.id)).toEqual([1]);
    });
});

const rooms: LodgingRoom[] = [
    { id: 11, hotel_name: "Hotel Sol", room_number: "101", capacity: 2, occupied: 1, occupants: [noName(1, "Ana Ruiz", { f_doc: "123" })] },
];
const render = (fields: LodgingExplorerProps["fields"], people: LodgingAttendee[] = [noName(9, "Rosa Díaz")], over: Partial<LodgingExplorerProps> = {}) =>
    renderToStaticMarkup(
        <LodgingExplorer
            rooms={rooms}
            unassigned={people}
            fields={fields}
            summary={lodgingSummary({ rooms, unassigned: people })}
            editable
            readOnlyReason={null}
            busy={false}
            onAssign={async () => true}
            onConfirm={() => {}}
            notify={() => {}}
            {...over}
        />,
    );

describe("the explorer of a conference whose form has no Nombre / Apellido / Género", () => {
    const fields = [{ name: "f_doc", label: "Documento", type: "text" }];

    it("names every attendee by the server's display name — never «#id»", () => {
        const room = render(fields, undefined, { initialNav: { hotel: "Hotel Sol", room: 11 } });
        expect(room).toContain("Ana Ruiz");
        expect(render(fields, undefined, { initialNav: {} })).toContain("Rosa Díaz");
        expect(room).not.toContain(">#1<");
    });

    it("shows no gender: no «Género sin indicar», no «Ocupantes» filter", () => {
        const hotel = render(fields, undefined, { initialNav: { hotel: "Hotel Sol" } });
        expect(hotel).not.toContain('data-testid="lodging-gender-filter"');
        const room = render(fields, undefined, { initialNav: { hotel: "Hotel Sol", room: 11 } });
        expect(room).not.toContain("Género sin indicar");
        expect(room).not.toContain('data-testid="lodging-occupant-gender"');
    });

    it("control: with a «Género» field (or attendees carrying a gender, from an older server) the gender stays", () => {
        const withField = [...fields, { name: "gender", label: "Género", type: "select" }];
        expect(render(withField, undefined, { initialNav: { hotel: "Hotel Sol" } })).toContain('data-testid="lodging-gender-filter"');
        expect(render(withField, undefined, { initialNav: { hotel: "Hotel Sol", room: 11 } })).toContain('data-testid="lodging-occupant-gender"');
        expect(formHasGender(fields, [{ gender: "F" }])).toBe(true);
        expect(formHasGender(fields, [{ gender: null }, { gender: "" }])).toBe(false);
    });
});

describe("the portal's inscription list names people like the admin (form.ts portalPersonName)", () => {
    it("the fields tagged Nombre / Apellido first, wherever they sit in the form", () => {
        const fields = [{ name: "f_doc", label: "Documento", is_unique: 1 }, { name: "f_n", label: "Nombre", role: "first_name" }, { name: "f_a", label: "Apellido", role: "last_name" }];
        expect(portalPersonName({ id: 1, f_doc: "12.345", f_n: "Ana", f_a: "Ruiz" }, fields)).toBe("Ana Ruiz");
    });

    it("without them: the first fields fit to be a name — never an ID document, a contact or notes", () => {
        const fields = [
            { name: "f_doc", label: "Documento", is_unique: 1 }, { name: "email", label: "Email", role: "email" },
            { name: "f_tel", label: "Tel", type: "tel" }, { name: "f_notes", label: "Notas", type: "textarea" },
            { name: "f_full", label: "Nombre completo", type: "text" },
        ];
        expect(portalPersonName({ id: 7, f_doc: "12.345", email: "a@b.c", f_tel: "300", f_notes: "x", f_full: "Ana Ruiz" }, fields)).toBe("Ana Ruiz");
        expect(portalPersonName({ id: 7, f_doc: "12.345", email: "a@b.c" }, fields)).toBe("#7");
        expect(fields.map((f) => isNameFallbackField(f))).toEqual([false, false, false, false, true]);
    });
});
