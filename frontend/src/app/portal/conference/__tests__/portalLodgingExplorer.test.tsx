/**
 * THE EXPLORER AS RENDERED — each level server-rendered (renderToStaticMarkup, node environment, no DOM).
 *
 * What is pinned is what the coordinator asked for: «entrar al hotel, a la habitación y ver los
 * asignados — no algo pequeño sino toda la info — y poder regresarse». So: level 1 shows the hotels
 * as cards to enter; level 2 shows every occupant's FULL name and the free beds; level 3 shows a card
 * per occupant with every form field and the actions; a «Volver» and a clickable breadcrumb exist at
 * levels 2 and 3; a read-only arrangement says WHY and offers no write control; a remembered position
 * that no longer exists falls back instead of rendering an empty page.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LodgingExplorer, { type LodgingExplorerProps } from "../LodgingExplorer";
import { lodgingSummary, type LodgingAttendee, type LodgingRoom } from "../lodging";

const person = (id: number, first: string, last: string, extra: Partial<LodgingAttendee> = {}): LodgingAttendee => ({ id, first_name: first, last_name: last, gender: null, family_group: null, ...extra });

const rooms: LodgingRoom[] = [
    {
        id: 11, hotel_name: 'Hotel Sol', room_number: '101', capacity: 3, occupied: 2, is_family: 1, family_name: 'Pérez',
        occupants: [
            person(1, 'María José', 'Pérez Gutiérrez', { gender: 'F', family_group: 'Pérez', email: 'maria@example.com', telefono: '3001234567', alergias: 'Maní' }),
            person(2, 'Juan', 'Pérez', { gender: 'M', family_group: 'Pérez' }),
        ],
    },
    { id: 12, hotel_name: 'Hotel Sol', room_number: '102', capacity: 2, occupied: 2, occupants: [person(3, 'Ana', 'Ruiz', { gender: 'F' })] },
    { id: 21, hotel_name: 'Hostal Luna', room_number: '1', capacity: 2, occupied: 0, occupants: [] },
];
const unassigned = [person(9, 'Rosa', 'Díaz', { gender: 'F' })];
const fields = [
    { name: 'email', label: 'Correo', type: 'email' },
    { name: 'telefono', label: 'Teléfono' },
    { name: 'alergias', label: 'Alergias' },
];

const noop = () => {};
const render = (over: Partial<LodgingExplorerProps> = {}) => renderToStaticMarkup(
    <LodgingExplorer
        rooms={rooms}
        unassigned={unassigned}
        fields={fields}
        summary={lodgingSummary({ rooms, unassigned })}
        editable
        readOnlyReason={null}
        busy={false}
        onAssign={async () => true}
        onConfirm={noop}
        notify={noop}
        {...over}
    />,
);

describe("level 1 — Hoteles", () => {
    const html = render({ initialNav: {} });

    it("shows one card per hotel to enter, with its numbers", () => {
        expect(html).toContain('data-level="1"');
        expect(html).toContain('Hotel Sol');
        expect(html).toContain('Hostal Luna');
        expect(html).toContain('Entrar');
        expect(html).toContain('Entrar');
        expect(html).toContain('1 llena');
        expect(html).toContain('1 parcialmente ocupada');
        expect(html).toContain('0 vacías');
    });

    it("names each hotel card by its visible name first, and the name carries every number on the card", () => {
        expect(html).toContain('aria-label="Hotel Sol: 4 de 5 camas ocupadas; 2 habitaciones (1 llena, 1 parcialmente ocupada, 0 vacías); 3 participantes alojados. Entrar"');
        expect(html).toContain('data-nav-hotel="Hotel Sol"');
    });

    it("shows the summary strip with the shortcut to the unassigned list", () => {
        expect(html).toContain('data-testid="lodging-summary"');
        expect(html).toContain('Ver lista');
        expect(html).toContain('Sin habitación');
        expect(html).toContain('Rosa Díaz');
    });

    it("has no «Volver» on the first level and marks «Hoteles» as the current crumb", () => {
        expect(html).not.toContain('data-testid="lodging-back"');
        expect(html).toMatch(/aria-current="page"[^>]*>.*Hoteles/);
    });
});

describe("level 2 — one hotel", () => {
    const html = render({ initialNav: { hotel: 'Hotel Sol' } });

    it("lists the hotel's rooms with every occupant's FULL name and a slot per free bed", () => {
        expect(html).toContain('data-level="2"');
        expect(html).toContain('Hab. 101');
        expect(html).toContain('Hab. 102');
        expect(html).toContain('María José Pérez Gutiérrez');
        expect(html).toContain('Juan Pérez');
        expect(html).toContain('Ana Ruiz');
        expect(html).toContain('Cama libre');
        expect(html).not.toContain('Hostal Luna'); // another hotel's rooms are not here
    });

    it("shows a bed the list does not explain as taken, without claiming whose it is", () => {
        expect(html).toContain('1 cama ocupada por alguien que no aparece en tu lista');
        expect(html).not.toContain('otra localidad');
    });

    it("lets the room cards return the focus (each title button is findable by its room id)", () => {
        expect(html).toContain('data-nav-room="11"');
        expect(html).toContain('aria-label="Hab. 101, 2 de 3 camas ocupadas"');
    });

    it("offers a way back and a clickable breadcrumb to the hotels", () => {
        expect(html).toContain('data-testid="lodging-back"');
        expect(html).toContain('Volver');
        expect(html).toMatch(/<button[^>]*>.*Hoteles<\/button>/);
    });

    it("has the filters", () => {
        expect(html).toContain('data-testid="lodging-filters"');
        expect(html).toContain('Con camas libres');
        expect(html).toContain('Llenas');
        expect(html).toContain('Vacías');
    });

    it("applies the remembered filters", () => {
        const onlyFull = render({ initialNav: { hotel: 'Hotel Sol', occupancy: 'full' } });
        expect(onlyFull).toContain('Hab. 102');
        expect(onlyFull).not.toContain('Hab. 101');
        expect(onlyFull).toContain('Mostrando 1 de 2 habitaciones');
    });
});

describe("level 3 — one room", () => {
    const html = render({ initialNav: { hotel: 'Hotel Sol', room: 11 } });

    it("shows a full card per occupant with every form field, links and actions", () => {
        expect(html).toContain('data-level="3"');
        expect(html).toContain('Habitación 101');
        expect(html).toContain('María José Pérez Gutiérrez');
        expect(html).toContain('Grupo familiar: Pérez');
        expect(html).toContain('href="mailto:maria@example.com"');
        expect(html).toContain('href="tel:3001234567"');
        expect(html).toContain('Alergias');
        expect(html).toContain('Maní');
        expect(html).toContain('Mover a otra habitación');
        expect(html).toContain('Quitar de la habitación');
    });

    it("shows a «Cama libre» slot with «Asignar participante» per free bed", () => {
        expect(html.match(/data-testid="lodging-free-bed"/g)).toHaveLength(1);
        expect(html).toContain('Asignar participante');
    });

    it("walks the hotel's rooms and can go back to the hotel", () => {
        expect(html).toContain('Siguiente');
        expect(html).toContain('Anterior');
        expect(html).toContain('1 de 2');
        expect(html).toContain('Volver a Hotel Sol');
        expect(html).toMatch(/<button[^>]*>Hotel Sol<\/button>/);
    });

    it("names the occupant actions by their visible text first (voice control)", () => {
        expect(html).toContain('aria-label="Mover a otra habitación: María José Pérez Gutiérrez"');
        expect(html).toContain('aria-label="Quitar de la habitación: María José Pérez Gutiérrez"');
    });

    it("repeats «Anterior / Siguiente» at the bottom, and keeps an end button focusable (aria-disabled, never disabled)", () => {
        expect(html).toContain('data-testid="lodging-walk-bottom"');
        expect(html.match(/aria-label="Siguiente: habitación 102"/g)).toHaveLength(2);
        expect(html.match(/aria-disabled="true" aria-label="Anterior: no hay más habitaciones"/g)).toHaveLength(2);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Anterior/);
    });

    it("read-only: says why and offers no write control", () => {
        const ro = render({ initialNav: { hotel: 'Hotel Sol', room: 11 }, editable: false, readOnlyReason: 'Enviaste el hospedaje a validación.' });
        expect(ro).toContain('Enviaste el hospedaje a validación.');
        expect(ro).toContain('Solo lectura');
        expect(ro).not.toContain('Mover a otra habitación');
        expect(ro).not.toContain('Quitar de la habitación</button>');
        expect(ro).not.toContain('Asignar participante');
        expect(ro).not.toContain('Elegir habitación');
        expect(ro).not.toContain('draggable="true"');
    });

    it("an editable arrangement makes the names draggable; a busy one does not", () => {
        expect(html).toContain('draggable="true"');
        expect(render({ initialNav: { hotel: 'Hotel Sol', room: 11 }, busy: true })).not.toContain('draggable="true"');
    });
});

describe("room view edge cases", () => {
    it("a dormitory shows at most 8 free-bed slots and says how many more", () => {
        const dorm: LodgingRoom[] = [{ id: 31, hotel_name: 'Albergue', room_number: 'D1', capacity: 12, occupied: 0, occupants: [] }];
        const html = render({ rooms: dorm, summary: lodgingSummary({ rooms: dorm }), initialNav: { hotel: 'Albergue', room: 31 } });
        expect(html.match(/data-testid="lodging-free-bed"/g)).toHaveLength(8);
        expect(html).toContain('y 4 camas libres más');
        expect(html).toContain('Habitación vacía.');
        // Dragging is a fine-pointer thing: the touch copy never tells a phone user to drag.
        expect(html).toContain('<span class="hidden pointer-fine:inline"> o arrastra a alguien desde «Sin habitación»</span>');
    });

    it("explains a bed the list does not show (another location's attendee OR a cancelled inscription)", () => {
        const html = render({ initialNav: { hotel: 'Hotel Sol', room: 12 } });
        expect(html).toContain('Una cama la ocupa alguien que no aparece en tu lista (de otra localidad o con la inscripción cancelada); solo el administrador puede liberarla.');
        expect(html).toContain('Cama ocupada por alguien que no aparece en tu lista');
        expect(html).not.toContain('participante de otra localidad');
        expect(html).not.toContain('data-testid="lodging-free-bed"');
        expect(html).toContain('Habitación completa.');
    });

    it("a level-2 card says «+1 cama libre más», in the singular", () => {
        const big: LodgingRoom[] = [{ id: 41, hotel_name: 'Albergue', room_number: 'D2', capacity: 7, occupied: 0, occupants: [] }];
        const html = render({ rooms: big, summary: lodgingSummary({ rooms: big }), initialNav: { hotel: 'Albergue' } });
        expect(html).toContain('+1 cama libre más');
        expect(html).not.toContain('camas libres más');
    });
});

describe("layout and reach", () => {
    it("keeps «Volver» and the breadcrumb in a bar that sticks under the portal's header", () => {
        const html = render({ initialNav: { hotel: 'Hotel Sol', room: 11 } });
        expect(html).toMatch(/class="[^"]*sticky top-\[61px\][^"]*" data-testid="lodging-bar"/);
        expect(html).toMatch(/data-testid="lodging-bar"><button[^>]*data-testid="lodging-back"/);
    });

    it("sizes the inner grids by the content column (container queries), not by the window", () => {
        for (const nav of [{}, { hotel: 'Hotel Sol' }, { hotel: 'Hotel Sol', room: 11 }]) {
            const html = render({ initialNav: nav });
            const at = html.indexOf('class="@container min-w-0"');
            expect(at).toBeGreaterThan(0);
            // No viewport-wide column counts inside the explorer's content column (the page is capped at
            // 1024px and, at xl, the column shares the row with the panel — only that outer row may use xl).
            // (A viewport variant starts a class token; a container one is prefixed with «@».)
            expect(html.slice(at)).not.toMatch(/[\s"](?:sm|md|lg|xl|2xl):grid-cols-/);
        }
        expect(render({ initialNav: { hotel: 'Hotel Sol', room: 11 } })).toContain('@md:grid-cols-2 @3xl:grid-cols-3');
    });

    it("lets the «Ver lista» shortcut land below the sticky bars", () => {
        expect(render({ initialNav: {} })).toMatch(/<aside tabindex="-1" class="[^"]*scroll-mt-40[^"]*"/);
    });

    it("announces a gender once in the «Sin habitación» panel (the dot is decorative next to the written word)", () => {
        const html = render({ initialNav: {} });
        const row = html.slice(html.indexOf('data-testid="lodging-chip-9"'));
        expect(row.slice(0, row.indexOf('Rosa Díaz'))).toContain('aria-hidden="true"');
        expect(row.slice(0, row.indexOf('</li>'))).not.toContain('<span class="sr-only">Mujer</span>');
    });
});

describe("a remembered position that no longer exists", () => {
    it("falls back to the hotel when the room is gone, and to the hotels when the hotel is gone", () => {
        expect(render({ initialNav: { hotel: 'Hotel Sol', room: 999 } })).toContain('data-level="2"');
        expect(render({ initialNav: { hotel: 'Hotel Cerrado', room: 11 } })).toContain('data-level="1"');
    });
});
