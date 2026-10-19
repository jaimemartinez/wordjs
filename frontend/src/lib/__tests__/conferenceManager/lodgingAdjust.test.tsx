/**
 * conference-manager 2.17.0 — the administration adjusts a lodging arrangement that a location submitted, or
 * that it validated, without reopening it.
 *
 * The site owner: «cuando una localidad manda una validación de hospedajes, el admin la valida pero no puede
 * cambiar nada de esa asignación». The server now lets every admin lodging write through on a submitted /
 * validated location and records it as an administration adjustment (backend
 * conference-manager-lodging-admin-edit.test.ts). Pinned here, for the screens:
 *   - the explorer's eligibility (lib/lodgingView.ts) no longer refuses an attendee or a room of such a
 *     location — cancelled attendees and moves in flight still are; the «Sin asignar» group says the location
 *     is under review (a visible pill) instead of locking it; the pickers list its attendees;
 *   - the explorer, its pickers and the inscriptions' room modal show the ADJUSTMENT notice instead of the
 *     lock — once per location (a room no longer repeats it on every occupant), with the location's ACTUAL
 *     state («ya está validado» / «está enviado a validación»), also above the hotels when the location filter
 *     points at a reviewed location (where «Ajustar en Asignación» lands); no surface keeps «reábrelo antes de …»;
 *   - every write that adjusted something says so in ONE toast (`lodging_adjusted`); the hotel / room deletions
 *     name the arrangements of the rooms' owners AND occupants; a re-allotment to the pool asks its question
 *     last; the inscription form explains a move out of a reviewed arrangement, or into one with the bed the
 *     attendee keeps — refused to a role without Hospedaje › gestionar;
 *   - the location card shows the stamp at the card's full width (not in the row's squeezed column) and the
 *     review shows it; the review offers «Ajustar en Asignación» to Hospedaje › gestionar; «Validar» /
 *     «Devolver» send what the admin saw, and a `lodging_changed` refusal reloads the review;
 *   - the bulk run / reset report names the state and the section on screen («Acomodación»), without a padlock;
 *     it, the form's denied hints and the server's 409s name the way back to a draft that the state HAS
 *     (reopened when validated, returned to the coordinator when submitted — a submitted one cannot be reopened);
 *   - the review's stamp wraps INSIDE its clipping box on a phone (the DotList geometry), its date whole;
 *   - dragging a placed attendee shows «Suelta aquí» over the search box, moving nothing (scroll anchoring);
 *   - the coordinator's portal shows «Ajustado por la administración el …», never who, and the submit
 *     confirmation says the administration may adjust it;
 *   - every new text exists in es / en / pt and the lock texts are gone.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});
// conferenceApi's POSTs, captured (lib/conference.ts imports this very module).
const apiPost = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ success: true }));
vi.mock('../../api', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, apiPost: (...args: any[]) => apiPost(...args) };
});

import {
    adjustedNames, assignCandidates, candidateExclusions, dragBlock, fillVars, groupUnassigned, indexOccupants, moveAdjustments, moveBlock,
    occupantLocationIds, reviewedInRoom, reviewedLocationOf, reviewedLocationsAmong, runSummaryOf, unassignBlock,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/lodgingView';
import {
    AdjustStamp, DotList, adjustConfirmText, adjustedToastText, adjustRelease, adjustState, adjustStampOf, adjustText, fmtStamp, fmtStampShort, reviewSeen, withAdjusted,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/LodgingAdjust';
import { SHELL_CSS, SHELL_PANEL_MIN_HEIGHT, SHELL_PANEL_MIN_WIDTH, SHELL_PANEL_STICKY_TOP } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';
import { AdjustNotice, RoomLevel } from '../../../../../marketplace/plugins/conference-manager/client/admin/LodgingExplorer';
import { conferenceApi } from '../../../../../marketplace/plugins/conference-manager/client/lib/conference';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { adminAdjustLine, submitConfirmText, unassignedHint } from '../../../../../marketplace/plugins/conference-manager/client/portal/lodging';
import { AdminAdjustedNotice } from '../../../../../marketplace/plugins/conference-manager/client/portal/LodgingTab';

const CLIENT = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CLIENT, f), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('admin/page.tsx');
const EXPLORER = read('admin/LodgingExplorer.tsx');
const count = (s: string, needle: string) => s.split(needle).length - 1;

/** The plugin's tx() over a catalogue: the key's text, else the fallback; {placeholders} filled. */
const txOf = (lang: 'es' | 'en' | 'pt') => (key: string, fallback: string, vars: Record<string, string | number> = {}) =>
    fillVars(translations[lang][key] ?? fallback, vars);
const tx = txOf('es');

const NORTE = { id: 1, name: 'Norte', lodging_status: 'validated' };
const SUR = { id: 2, name: 'Sur', lodging_status: 'submitted' };
const OESTE = { id: 3, name: 'Oeste', lodging_status: 'draft' };
const LOCS = [NORTE, SUR, OESTE];

describe('eligibility (lib/lodgingView.ts): a submitted / validated location is the admin\'s to change', () => {
    const ana = { id: 10, location_id: 1, room_id: 101, status: 'active' };      // Norte (validated), in 101
    const bea = { id: 11, location_id: 2, room_id: null, status: 'pending' };    // Sur (submitted), no room
    const cel = { id: 12, location_id: 1, room_id: null, status: 'cancelled' };
    const ctx = { pending: new Set<number>() };
    const room102 = { id: 102, room_number: '102', capacity: 2, location_id: 1 };

    it('moving, unassigning and dropping an attendee of a reviewed location are allowed', () => {
        expect(dragBlock(ana, ctx)).toBeNull();
        expect(unassignBlock(ana, ctx)).toBeNull();
        expect(moveBlock(ana, room102, ctx, new Map())).toBeNull();
        expect(dragBlock(bea, ctx)).toBeNull();
    });
    it('the other refusals stand: a cancelled attendee, a move in flight, a foreign or full room', () => {
        expect(dragBlock(cel, ctx)).toBe('board.cancelled');
        expect(dragBlock(ana, { pending: new Set([10]) })).toBe('board.moving');
        expect(unassignBlock(ana, { pending: new Set([10]) })).toBe('board.moving');
        expect(moveBlock(bea, room102, ctx, new Map())).toBe('board.room.foreign');
        const full = new Map([[102, [{ id: 1 }, { id: 2 }]]]) as any;
        expect(moveBlock(ana, room102, ctx, full)).toBe('board.room.full');
    });
    it('the «Asignar participante» picker lists them, and no exclusion is counted as «en validación»', () => {
        const dan = { id: 13, location_id: 1, room_id: null, status: 'pending' };
        expect(assignCandidates([dan, cel], room102, ctx, { nameOf: (p) => `#${p.id}` }).map(p => p.id)).toEqual([13]);
        const excluded = candidateExclusions([dan, cel, bea], room102, ctx);
        expect(excluded).toEqual({ cancelled: 1, foreign: 1, moving: 0, noBed: 0, locked: 0 });
        expect('frozen' in excluded).toBe(false);
    });
    it('«Sin asignar» marks the group of a reviewed location (with its status) instead of locking it', () => {
        const { list } = groupUnassigned([bea, { id: 14, location_id: 3, room_id: null, status: 'pending' }], LOCS, { nameOf: (p) => `#${p.id}` });
        expect(list.map(g => [g.name, g.reviewed, g.status])).toEqual([['Oeste', false, 'draft'], ['Sur', true, 'submitted']]);
        expect(list.some(g => 'frozen' in g)).toBe(false);
    });
    it('reviewedLocationOf / reviewedLocationsAmong name the submitted / validated owners, sorted', () => {
        expect(reviewedLocationOf(1, LOCS)).toBe(NORTE);
        expect(reviewedLocationOf(3, LOCS)).toBeNull();
        expect(reviewedLocationOf(null, LOCS)).toBeNull();
        expect(reviewedLocationsAmong([{ location_id: 2 }, { location_id: null }, { location_id: 3 }, { location_id: 1 }, { location_id: 1 }], LOCS).map(l => l.name)).toEqual(['Norte', 'Sur']);
        expect(reviewedLocationsAmong([], LOCS, [3, null, 2]).map(l => l.name)).toEqual(['Sur']);
    });
    it('occupantLocationIds: whoever sleeps in the rooms — a pool room\'s occupants belong to their own arrangements', () => {
        const idx = indexOccupants([ana, { id: 20, location_id: 2, room_id: 300, status: 'active' }, { id: 21, location_id: null, room_id: 300, status: 'active' }, bea]);
        expect(occupantLocationIds([{ id: 300 }], idx)).toEqual([2]);
        expect(occupantLocationIds([{ id: 101 }, { id: 300 }, { id: 999 }], idx).sort()).toEqual([1, 2]);
        expect(reviewedLocationsAmong([{ location_id: null }], LOCS, occupantLocationIds([{ id: 300 }], idx)).map(l => l.name)).toEqual(['Sur']);
    });
    it('reviewedInRoom: each reviewed arrangement of a room once — its own first, then its occupants\'', () => {
        const norteRoom = { id: 101, location_id: 1 };
        expect(reviewedInRoom(norteRoom, [ana, { ...ana, id: 15 }], LOCS).map(l => l.name)).toEqual(['Norte']);
        const pool = { id: 300, location_id: null };
        expect(reviewedInRoom(pool, [{ location_id: 2 }, { location_id: 1 }, { location_id: 3 }, { location_id: 2 }], LOCS).map(l => l.name)).toEqual(['Norte', 'Sur']);
        const draftRoom = { id: 5, location_id: 3 };
        expect(reviewedInRoom(draftRoom, [{ location_id: 3 }], LOCS)).toEqual([]);
    });
    it('moveAdjustments mirrors PUT /inscriptions — the bed rule: out of a reviewed arrangement, or into one, only with a bed', () => {
        // Leaving validated Norte with a bed: its own room (freed) or a pool bed (taken along).
        expect(moveAdjustments({ location_id: 1, room_id: 101, room_location_id: 1 }, { location_id: 3 }, LOCS)).toEqual({ out: NORTE, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 1, room_id: 300, room_location_id: null }, { location_id: 3 }, LOCS)).toEqual({ out: NORTE, into: null, intoMaybe: null });
        // …WITHOUT a bed: no adjustment, exactly like arriving without one (the same permission both ways).
        expect(moveAdjustments({ location_id: 1, room_id: null, room_location_id: null }, { location_id: 3 }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 1, room_id: null }, { location_id: 2, status: 'cancelled' }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        // Entering submitted Sur with a POOL bed (kept): an adjustment of Sur.
        expect(moveAdjustments({ location_id: 3, room_id: 300, room_location_id: null }, { location_id: '2' }, LOCS)).toEqual({ out: null, into: SUR, intoMaybe: null });
        // …with a room of another location (freed by the move), with no room, or cancelled meanwhile: none.
        expect(moveAdjustments({ location_id: 3, room_id: 103, room_location_id: 3 }, { location_id: 2 }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 3, room_id: null }, { location_id: 2 }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 3, room_id: 300, room_location_id: null }, { location_id: 2, status: 'cancelled' }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        // Unknown room owner (an older server): no claim. Same location: nothing. Both sides reviewed: both.
        expect(moveAdjustments({ location_id: 3, room_id: 300 }, { location_id: 2 }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 1, room_id: 101, room_location_id: 1 }, { location_id: 1 }, LOCS)).toEqual({ out: null, into: null, intoMaybe: null });
        expect(moveAdjustments({ location_id: 1, room_id: 300, room_location_id: null }, { location_id: 2 }, LOCS)).toEqual({ out: NORTE, into: SUR, intoMaybe: null });
    });
});

describe('the toast, the confirmations, the review and the stamp (admin/LodgingAdjust.tsx)', () => {
    it('a write that adjusted reviewed arrangements is toasted with their names; one that did not, not at all', () => {
        const result = { success: true, lodging_adjusted: [{ location_id: 1, name: 'Norte', status: 'validated' }, { location_id: 2, name: 'Sur', status: 'submitted' }] };
        expect(adjustedNames(result)).toBe('«Norte», «Sur»');
        expect(adjustedToastText(tx, result)).toBe('Registrado como ajuste de la administración en «Norte», «Sur».');
        expect(adjustedToastText(tx, { success: true, lodging_adjusted: [] })).toBeNull();
        expect(adjustedToastText(tx, { success: true })).toBeNull();     // an older plugin
        expect(adjustedToastText(tx, null)).toBeNull();
    });
    it('withAdjusted: ONE toast — the write\'s own text, plus the adjustment sentence only when there is one', () => {
        const result = { lodging_adjusted: [{ location_id: 1, name: 'Norte', status: 'validated' }] };
        expect(withAdjusted(tx, 'Movido a Hotel Central · 101', result)).toBe('Movido a Hotel Central · 101. Registrado como ajuste de la administración en «Norte».');
        expect(withAdjusted(tx, 'Hotel eliminado.', result)).toBe('Hotel eliminado. Registrado como ajuste de la administración en «Norte».');
        expect(withAdjusted(tx, 'Habitación asignada', { lodging_adjusted: [] })).toBe('Habitación asignada');
    });
    it('the texts name a reviewed location\'s ACTUAL state, never «en validación o validado»', () => {
        expect(adjustState(tx, 'validated')).toBe('ya está validado');
        expect(adjustState(tx, 'submitted')).toBe('está enviado a validación');
        expect(adjustText(tx, 'lodging.adjust.notice', '', NORTE)).toBe('El hospedaje de «Norte» ya está validado: puedes cambiarlo igualmente. Cada cambio queda registrado como ajuste de la administración y el encargado lo verá en su portal.');
        expect(adjustText(tx, 'lodging.adjust.notice', '', SUR)).toMatch(/^El hospedaje de «Sur» está enviado a validación: puedes cambiarlo/);
        expect(adjustText(txOf('en'), 'lodging.adjust.notice', '', NORTE)).toMatch(/^The lodging of «Norte» is already validated: you can still change it\./);
        expect(adjustText(txOf('pt'), 'lodging.adjust.notice', '', SUR)).toMatch(/^A hospedagem de «Sur» foi enviada para validação: você ainda pode alterá-la\./);
    });
    it('a confirmation says which reviewed arrangements the change touches, each with its state (nothing when none)', () => {
        expect(adjustConfirmText(tx, [NORTE])).toBe('Afecta al hospedaje de «Norte» (validado): el cambio quedará registrado como ajuste de la administración y sus encargados lo verán.');
        expect(adjustConfirmText(tx, [NORTE, SUR])).toMatch(/^Afecta al hospedaje de «Norte» \(validado\), «Sur» \(enviado a validación\): /);
        expect(adjustConfirmText(tx, [])).toBe('');
    });
    it('reviewSeen: what the review modal saw — sent back with «Validar» / «Devolver»', async () => {
        expect(reviewSeen({ location: { lodging_submitted_at: '2026-10-08 09:00:00', lodging_admin_changes: 3 } })).toEqual({ submitted_at: '2026-10-08 09:00:00', admin_changes: 3 });
        expect(reviewSeen({ location: {} })).toEqual({ submitted_at: null, admin_changes: 0 });
        apiPost.mockClear();
        await conferenceApi.validateLodging(7, { submitted_at: 'x', admin_changes: 2 });
        await conferenceApi.returnLodging(7, 'Revisa', { submitted_at: 'x', admin_changes: 2 });
        await conferenceApi.validateLodging(7);
        expect(apiPost.mock.calls).toEqual([
            ['/plugin/conference-manager/locations/7/lodging/validate', { seen: { submitted_at: 'x', admin_changes: 2 } }],
            ['/plugin/conference-manager/locations/7/lodging/return', { note: 'Revisa', seen: { submitted_at: 'x', admin_changes: 2 } }],
            ['/plugin/conference-manager/locations/7/lodging/validate', {}],
        ]);
    });
    it('the stamp: nothing without one; the date, the count (singular / plural) and who — when the server sent it', () => {
        expect(adjustStampOf({ lodging_admin_changed_at: null, lodging_admin_changes: 0 })).toBeNull();
        expect(renderToStaticMarkup(<AdjustStamp location={{ lodging_admin_changed_at: null }} tx={tx} />)).toBe('');
        const one = renderToStaticMarkup(<AdjustStamp location={{ lodging_admin_changed_at: '2026-10-08 09:30:00', lodging_admin_changes: 1, lodging_admin_changed_by: 'boss' }} tx={tx} />);
        expect(one).toContain('Ajustado por la administración el ');
        expect(one).toContain('1 cambio desde el envío');
        expect(one).toContain('Último cambio: boss');
        expect(one).toContain('data-adjust-stamp="1"');
        expect(one).toMatch(/^<div class="min-w-0 rounded-xl /);         // a plain block: the full width of what holds it
        expect(one).not.toMatch(/^<div class="([^"]*\s)?(w-full|w-\d+|inline)\b/);   // no fixed / 100% width: padding stays inside
        expect(one).not.toContain('Lo que ves ya incluye');
        const many = renderToStaticMarkup(<AdjustStamp location={{ lodging_admin_changed_at: '2026-10-08 09:30:00', lodging_admin_changes: 3, lodging_admin_changed_by: null }} tx={tx} detail />);
        expect(many).toContain('3 cambios desde el envío');
        expect(many).not.toContain('Último cambio');              // a team role without Localidades › ver
        expect(many).toContain('Lo que ves ya incluye esos cambios');
        expect(many).not.toContain('2026-10-08 09:30:00');         // parsed (as UTC), not printed raw
    });
});

/** A room level as the explorer renders it, with the smallest env it reads. */
function renderRoom(room: any, people: any[], locs: any[]) {
    const idx = indexOccupants(people);
    const env = {
        tx, txn: (k: string, many: string, one: string, n: number) => fillVars(n === 1 ? one : many, { n }),
        ctx: { pending: new Set<number>() }, idx, nameOf: (p: any) => p.first_name, locNameOf: (p: any) => (locs.find(l => l.id === p.location_id) || {}).name || '',
        roomLocName: (r: any) => (locs.find(l => l.id === r.location_id) || {}).name || '', fields: [],
        dnd: { over: null, draggedPerson: null, dragging: null, roomOver: () => undefined, leave: () => undefined, roomDrop: () => undefined, start: () => undefined, end: () => undefined },
        readOnly: false, locs, reviewedOf: (id: any) => reviewedLocationOf(id, locs),
    };
    return renderToStaticMarkup(<RoomLevel hotel={{ id: 9, name: 'Hotel Central' }} room={room} walk={null} walkingAll={false} onOpenRoom={() => {}} onMove={() => {}} onUnassign={() => {}} onAssign={() => {}} headingRef={{ current: null }} env={env} />);
}

describe('the explorer and the inscriptions\' room modal: the adjustment notice instead of the lock', () => {
    it('AdjustNotice names the location and its ACTUAL state, and says the change is recorded and seen by the coordinator', () => {
        const html = renderToStaticMarkup(<AdjustNotice location={NORTE} env={{ tx }} />);
        expect(html).toContain('data-adjust-notice="validated"');
        expect(html).toContain('Validado');
        expect(html).toContain('El hospedaje de «Norte» ya está validado: puedes cambiarlo igualmente.');
        expect(html).toContain('ajuste de la administración');
        expect(renderToStaticMarkup(<AdjustNotice location={SUR} env={{ tx }} />)).toContain('El hospedaje de «Sur» está enviado a validación: puedes cambiarlo igualmente.');
    });
    it('a room of a reviewed location with two occupants shows the notice ONCE (not on every occupant card)', () => {
        const room = { id: 101, room_number: '101', capacity: 3, location_id: 1 };
        const people = [{ id: 10, first_name: 'Ana', location_id: 1, room_id: 101, status: 'active' }, { id: 11, first_name: 'Bea', location_id: 1, room_id: 101, status: 'active' }];
        const html = renderRoom(room, people, LOCS);
        expect(count(html, 'data-adjust-notice=')).toBe(1);
        expect(html).toContain('Ana');
        expect(html).toContain('Bea');
        expect(html).not.toContain('data-occupant-reviewed');      // the room's own arrangement: no pill either
    });
    it('a pool room names each reviewed arrangement of its occupants once, and marks those occupants', () => {
        const pool = { id: 300, room_number: '301', capacity: 4, location_id: null };
        const people = [
            { id: 10, first_name: 'Ana', location_id: 1, room_id: 300, status: 'active' },
            { id: 12, first_name: 'Eva', location_id: 1, room_id: 300, status: 'active' },
            { id: 11, first_name: 'Bea', location_id: 2, room_id: 300, status: 'active' },
            { id: 13, first_name: 'Ola', location_id: 3, room_id: 300, status: 'active' },
        ];
        const html = renderRoom(pool, people, LOCS);
        expect(count(html, 'data-adjust-notice=')).toBe(2);
        expect(html.indexOf('data-adjust-notice="validated"')).toBeLessThan(html.indexOf('data-adjust-notice="submitted"'));
        expect(count(html, 'data-occupant-reviewed=')).toBe(3);    // Ana, Eva (Norte) and Bea (Sur); not Ola (draft)
        expect(html).toContain('Hospedaje · Validado');
        // A draft room: nothing.
        expect(renderRoom({ id: 5, room_number: '5', capacity: 2, location_id: 3 }, [{ id: 13, first_name: 'Ola', location_id: 3, room_id: 5, status: 'active' }], LOCS)).not.toContain('data-adjust-notice');
    });
    it('no surface keeps the «reábrelo antes de cambiar» branch; the pickers and the hotels filtered by a reviewed location say it once', () => {
        for (const [name, src] of [['page.tsx', PAGE], ['LodgingExplorer.tsx', EXPLORER]] as const) {
            expect(src, name).not.toMatch(/lodging\.frozen\.notice|explorer\.room\.locked|explorer\.occupant\.frozen|board\.frozen|roomLock|frozenLocationIds/);
        }
        const modal = PAGE.slice(PAGE.indexOf('{/* Manual room-assignment modal */}'), PAGE.indexOf('function LodgingRoomTile('));
        expect(modal).toContain('reviewedLocationOf(assignTarget.location_id, confLocations)');
        expect(modal).toContain("adjustText(tx, 'lodging.adjust.notice'");
        expect(modal).not.toMatch(/frozen \?/);
        // The two pickers, the room level (one per location) and the hotels filtered by a reviewed location.
        expect(count(EXPLORER, '<div className="mb-4"><AdjustNotice location={reviewed} env={env} /></div>')).toBe(2);
        expect(EXPLORER).toContain('{reviewedHere.map((l: any) => <AdjustNotice key={l.id} location={l} env={env} />)}');
        expect(EXPLORER).toMatch(/\{filterReviewed && level < 3 && contentReady && <div className="mb-4" data-filter-adjust=""><AdjustNotice location=\{filterReviewed\} env=\{env\} \/><\/div>\}/);
        expect(EXPLORER).toMatch(/const filterReviewed = readOnly \|\| !\/\^\[0-9\]\+\$\/\.test\(String\(viewFilters\.location \|\| ''\)\) \? null : reviewedOf\(Number\(viewFilters\.location\)\);/);
        expect(count(EXPLORER, '<AdjustNotice')).toBe(4);       // those four uses, and no other
        expect(EXPLORER).not.toMatch(/data-assign-bed=""\s+disabled/);
    });
    it('«Sin asignar» marks a reviewed group with a VISIBLE status pill (a title alone never shows on touch)', () => {
        const header = EXPLORER.slice(EXPLORER.indexOf('{g.reviewed && ('), EXPLORER.indexOf('{g.people.length}</span>'));
        expect(header).toMatch(/^\{g\.reviewed && \(\s*<span [^>]*data-group-reviewed=\{g\.status\}>/);
        expect(header).toMatch(/\{tx\(lodgingStatusMeta\(g\.status\)\.key, lodgingStatusMeta\(g\.status\)\.fallback\)\}\s*<\/span>/);
    });
    it('every write that may adjust a reviewed arrangement says so in the SAME toast (`lodging_adjusted`)', () => {
        for (const call of ['assignRoom(assignTarget.id', 'assignRoom(inscriptionId', 'updateInscription(editId', 'deleteInscription(person.id', 'allotHotel(hotel.id', 'deleteHotel(hotel.id', 'deleteRoom(room.id']) {
            const at = PAGE.indexOf(call);
            expect(at, call).toBeGreaterThan(0);
            const after = PAGE.slice(at - 40, at + 700);
            expect(after, call).toMatch(/const result = await conferenceApi\./);
            expect(after, call).toMatch(/addToast\(withAdjusted\(tx, [\s\S]*?, result\), 'success'\)/);
        }
        expect(PAGE).not.toContain('adjustedToastText');
        expect(PAGE).not.toContain("addToast(adjusted, 'info')");
    });
    it('deleting a hotel or a room names the arrangements of its rooms\' owners AND occupants; re-allotting, the sides that change', () => {
        const lodging = PAGE.slice(PAGE.indexOf('function LodgingPage('), PAGE.indexOf('function PricingPage('));
        // …and the locations sharing a room (2.18.0).
        expect(lodging).toContain('adjustConfirmText(tx, reviewedLocationsAmong(hotel.rooms, locations, [...occupantLocationIds(hotel.rooms, occupantsByRoom), ...(hotel.rooms || []).flatMap(r => (r.shares || []).map(s => Number(s.location_id)))]))');
        expect(lodging).toContain('adjustConfirmText(tx, reviewedLocationsAmong([room], locations, [...occupantLocationIds([room], occupantsByRoom), ...(room.shares || []).map(s => Number(s.location_id))]))');
        expect(lodging).toContain('adjustConfirmText(tx, reviewedLocationsAmong(changing, locations');
        // Back to the pool: the adjustment sentence comes BEFORE the closing question.
        expect(lodging).toContain("tx('allot.confirm.pool.adjust'");
        expect(lodging).not.toMatch(/allot\.confirm\.pool'\)[^\n]*adjustText/);
        expect(lodging).not.toContain('or a location is frozen');
        for (const lang of ['es', 'en', 'pt'] as const) {
            const text = translations[lang]['allot.confirm.pool.adjust'];
            expect(text, lang).toMatch(/\{adjust\} ¿?\S+\?$/);
            expect(text.replace(' {adjust}', ''), lang).toBe(translations[lang]['allot.confirm.pool']);
        }
    });
    it('the inscription form explains a move out of a reviewed arrangement, or into one with the bed kept — and that it takes Hospedaje › gestionar', () => {
        const form = PAGE.slice(PAGE.indexOf('{/* Location — the admin picks it explicitly'), PAGE.indexOf('{fields.length === 0 ? ('));
        expect(form).toContain('moveAdjustments(formOriginal, formData, confLocations)');
        expect(form).toMatch(/move\.out && \{ kind: 'out'[\s\S]*'lodging\.adjust\.move\.hint'[\s\S]*'lodging\.adjust\.move\.denied'/);
        expect(form).toMatch(/move\.into && \{ kind: 'into'[\s\S]*'lodging\.adjust\.movein\.hint'[\s\S]*'lodging\.adjust\.movein\.denied'/);
        expect(form).toMatch(/notes\.map\(n => canAssign\s*\?[^:]*data-move-adjust="hint"[\s\S]*:[\s\S]*data-move-adjust="denied"/);
        expect(form).toContain('adjustText(tx, n.hint[0], n.hint[1], n.loc)');
        expect(PAGE).toContain("const canAssign = perms.can('lodging', 'manage');");
    });
    it('the run / reset report names the state and the section on screen («Acomodación»), with no padlock', () => {
        const assignment = PAGE.slice(PAGE.indexOf('function AssignmentPage('), PAGE.indexOf('export default function ConferenceManagerAdmin('));
        expect(assignment).toContain("adjustText(tx, 'assignment.skipped.frozen'");
        expect(assignment).toContain('skipped.map(s => skippedFrozenLine(s))');
        const row = assignment.slice(assignment.indexOf('{runReport.skipped_frozen.map('), assignment.indexOf('{skippedFrozenLine(l)}'));
        expect(row).toContain('fa-circle-info');
        expect(row).not.toContain('fa-lock');
        for (const lang of ['es', 'en', 'pt'] as const) {
            const text = translations[lang]['assignment.skipped.frozen'];
            expect(text, lang).toContain(`«${translations[lang]['board.title']}»`);
            expect(text, lang).not.toMatch(/explorador|explorer/);
            expect(text, lang).toContain('{state}');
        }
        expect(adjustText(tx, 'assignment.skipped.frozen', '', { name: 'Norte', lodging_status: 'validated' }))
            .toBe('«Norte» no se tocó: su hospedaje ya está validado. Ajústalo a mano en «Acomodación» (más abajo); volverá a entrar en la asignación automática cuando se reabra desde Localidades.');
        expect(adjustText(tx, 'assignment.skipped.frozen', '', { name: 'Sur', lodging_status: 'submitted' }))
            .toBe('«Sur» no se tocó: su hospedaje está enviado a validación. Ajústalo a mano en «Acomodación» (más abajo); volverá a entrar en la asignación automática cuando se devuelva al encargado desde Localidades.');
    });
    it('the texts point to the way back to a draft that the location\'s state HAS: a validated one is reopened, a submitted one returned (it cannot be reopened)', () => {
        // POST …/lodging/reopen only takes a validated arrangement; the review of a submitted one offers «Validar» /
        // «Devolver». «(o reábrelo desde Localidades)» on a submitted location pointed to an action that does not exist.
        const KEYS = ['lodging.adjust.move.denied', 'lodging.adjust.movein.denied', 'assignment.skipped.frozen'];
        const REOPEN = { es: /re[áa]br/i, en: /reopen/i, pt: /reab[re]/i } as const;
        const RETURN = { es: /devuelva al encargado/, en: /returned to the coordinator/, pt: /devolvida ao responsável/ } as const;
        for (const lang of ['es', 'en', 'pt'] as const) {
            const t = txOf(lang);
            for (const k of KEYS) {
                expect(translations[lang][k], `${lang} ${k}`).toContain('{release}');
                const sub = adjustText(t, k, '', SUR), val = adjustText(t, k, '', NORTE);
                expect(sub, `${lang} ${k} submitted`).not.toMatch(REOPEN[lang]);
                expect(sub, `${lang} ${k} submitted`).toMatch(RETURN[lang]);
                expect(val, `${lang} ${k} validated`).toMatch(REOPEN[lang]);
                expect(val, `${lang} ${k} validated`).not.toMatch(RETURN[lang]);
                expect(sub + val, `${lang} ${k}`).not.toMatch(/\{\w+\}/);       // every placeholder filled
            }
            expect(adjustRelease(t, 'submitted')).toBe(translations[lang]['lodging.adjust.release.submitted']);
            expect(adjustRelease(t, 'validated')).toBe(translations[lang]['lodging.adjust.release.validated']);
        }
        expect(adjustText(tx, 'lodging.adjust.move.denied', '', SUR))
            .toBe('El hospedaje de «Sur» está enviado a validación: sacar de ahí a este participante lo hace quien gestiona el Hospedaje (o se podrá cuando se devuelva al encargado desde Localidades).');
        expect(adjustText(tx, 'lodging.adjust.movein.denied', '', NORTE))
            .toBe('El hospedaje de «Norte» ya está validado: que este participante entre en él con la cama que ya tiene lo hace quien gestiona el Hospedaje (sin habitación sí podría entrar; con ella, se podrá cuando se reabra desde Localidades).');
        // The page's Spanish fallbacks are the catalogue's (an older catalogue without a key shows the same text).
        for (const k of KEYS) expect(PAGE, k).toContain(`'${k}', '${translations.es[k]}'`);
        expect(PAGE).not.toMatch(/reábrelo desde Localidades/);
    });
});

describe('Localidades: the stamp on the card and in the review, «Ajustar en Asignación», and the review\'s decisions', () => {
    const locations = PAGE.slice(PAGE.indexOf('function LocationsPage('));
    it('the card shows the stamp BELOW its icon / text / button row, at the card\'s full width; the row wraps', () => {
        const rowAt = locations.indexOf('data-lodging-row=""');
        const stampAt = locations.indexOf('<AdjustStamp location={loc} tx={tx}');
        expect(rowAt).toBeGreaterThan(0);
        expect(stampAt).toBeGreaterThan(rowAt);
        // Every <div> opened from the row's own opening tag on is closed before the stamp: it is NOT inside the row.
        const from = locations.lastIndexOf('<div', rowAt);
        const between = locations.slice(from, stampAt);
        expect(count(between, '</div>')).toBeGreaterThanOrEqual(count(between, '<div'));
        expect(between).toContain("t('lodging.review') || 'Revisar hospedaje'");      // the review button is inside the row
        // The row wraps (a narrow card drops the button below instead of painting it over the text).
        expect(locations.slice(from, rowAt)).toContain('flex flex-wrap items-center');
        expect(between).toContain('flex-1 min-w-[10rem]');
        expect(between).toMatch(/className=\{`shrink-0 ml-auto /);
    });
    it('the review shows the stamp', () => {
        expect(locations).toContain('<AdjustStamp location={review.location} tx={tx} detail />');
    });
    it('«Ajustar en Asignación» is offered to Hospedaje › gestionar on a submitted / validated arrangement, and opens the explorer filtered by it', () => {
        expect(locations).toContain("const canAdjust = locPerms.can('lodging', 'manage') && !!onOpenExplorer;");
        expect(locations).toMatch(/\{canAdjust && isLodgingFrozen\(status\) && \([\s\S]*data-adjust-open=""[\s\S]*onOpenExplorer!\(\{ locationId: id \}\)/);
        // The shell hands the explorer a location focus, only when «Asignación» is open to the role.
        expect(PAGE).toContain("onOpenExplorer={viewAllowed('assignment', perms) ? openLodgingExplorer : undefined}");
        expect(PAGE).toMatch(/focus\.hotelId == null && focus\.locationId != null\s*\?\s*\{ locationId: Number\(focus\.locationId\) \}/);
        expect(EXPLORER).toMatch(/else if \(focus\.locationId != null\)[\s\S]{0,300}location: String\(focus\.locationId\)/);
        // «Reabrir» stays.
        expect(locations).toContain('onClick={handleReopen}');
    });
    it('«Validar» / «Devolver» send what the admin saw; a `lodging_changed` refusal reloads the review instead of a bare error', () => {
        expect(locations).toContain('await conferenceApi.validateLodging(reviewLoc.id, reviewSeen(review));');
        expect(locations).toContain('await conferenceApi.returnLodging(reviewLoc.id, note, reviewSeen(review));');
        const refused = locations.slice(locations.indexOf('const reviewRefused = async'), locations.indexOf('const handleValidate = async'));
        expect(refused).toMatch(/error\.code === 'lodging_changed'[\s\S]*tx\('lodging\.review\.changed'[\s\S]*await loadReview\(reviewLoc\.id\);[\s\S]*loadLocations\(\);/);
        expect(count(locations, 'await reviewRefused(error);')).toBe(2);
    });
});

describe('the coordinator\'s portal: «Ajustado por la administración el …», never who', () => {
    it('adminAdjustLine', () => {
        expect(adminAdjustLine({ admin_changed_at: null, admin_changes: 0 })).toBeNull();
        expect(adminAdjustLine({})).toBeNull();                       // an older plugin
        expect(adminAdjustLine(null)).toBeNull();
        const one = adminAdjustLine({ admin_changed_at: '2026-10-08 09:30:00', admin_changes: 1 })!;
        expect(one).toMatch(/^Ajustado por la administración el .+ \(1 cambio desde tu envío\)\.$/);
        expect(one).not.toContain('2026-10-08 09:30:00');
        expect(adminAdjustLine({ admin_changed_at: '2026-10-08 09:30:00', admin_changes: 4 })).toMatch(/\(4 cambios desde tu envío\)\.$/);
    });
    it('the tab renders it only with a stamp', () => {
        expect(renderToStaticMarkup(<AdminAdjustedNotice data={{ admin_changed_at: null }} />)).toBe('');
        const html = renderToStaticMarkup(<AdminAdjustedNotice data={{ admin_changed_at: '2026-10-08 09:30:00', admin_changes: 2 }} />);
        expect(html).toContain('data-testid="lodging-admin-adjusted"');
        expect(html).toContain('2 cambios desde tu envío');
        const tab = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/portal/LodgingTab.tsx'), 'utf8');
        expect(tab).toContain('<AdminAdjustedNotice data={d} />');
    });
    it('a validated arrangement tells the coordinator the administration can place them', () => {
        expect(unassignedHint('validated')).toMatch(/administrador puede acomodarlos/);
        expect(unassignedHint('validated')).toMatch(/reabrir/);
    });
    it('the submit confirmation says, BEFORE sending, that the administration may adjust it', () => {
        const ADJ = 'La administración puede ajustarla mientras la revisa o después de validarla; si lo hace, verás aquí un aviso.';
        for (const n of [0, 1, 3]) {
            const text = submitConfirmText(n);
            expect(text).toContain(ADJ);
            expect(text).toMatch(/¿Enviar\?$/);
            expect(text.indexOf(ADJ)).toBeLessThan(text.indexOf('¿Enviar?'));
        }
        expect(submitConfirmText(3)).toMatch(/^Hay 3 participantes sin habitación\. /);
        expect(submitConfirmText(0)).toMatch(/^El administrador revisará la acomodación y no podrás/);
        const tab = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/portal/LodgingTab.tsx'), 'utf8');
        expect(tab).toContain('text: submitConfirmText(summary.unplaced),');
    });
});

describe('round 3: the card stamp and counts read cleanly; the explorer\'s heading, breadcrumb and run summary', () => {
    const locations = PAGE.slice(PAGE.indexOf('function LocationsPage('));
    const assignment = PAGE.slice(PAGE.indexOf('function AssignmentPage('), PAGE.indexOf('export default function ConferenceManagerAdmin('));
    const textOf = (html: string) => html.replace(/<[^>]+>/g, '');
    const SEP = (cls: string) => `<span aria-hidden="true" class="-ml-3 inline-block w-3 text-center ${cls}">·</span>`;
    const ITEM = '<span class="ml-3 min-w-0 break-words">';

    it('DotList: each item carries its «·» IN FRONT, hung in the item\'s margin; the list is pulled left by exactly that width inside a clipping box — no «·» can end or start a line', () => {
        const html = renderToStaticMarkup(<DotList items={['4 hab.', null, '9 camas', '', <b key="x">0 sin habitación</b>]} />);
        expect(html).toMatch(/^<span class="block min-w-0 overflow-hidden [^"]*" data-dot-list=""><span class="-ml-3 flex flex-wrap">/);
        const items = html.split(ITEM).slice(1);
        expect(items).toHaveLength(3);                                   // empty items dropped
        for (const it of items) expect(it.startsWith(SEP('text-gray-300')), it).toBe(true);   // w-3 = the -ml-3 pull
        expect(html).not.toMatch(/·<\/span><\/span>/);                    // no item ENDS with a separator
        expect(textOf(html)).toBe('·4 hab.·9 camas·0 sin habitación');
    });

    /**
     * The DotList's geometry, from the classes it renders (Tailwind's spacing step: 0.25rem = 4 px), measured from
     * the clipping box's left edge (x = 0). The inner flex container starts at its margin-left; an item that starts
     * a line has its box at that plus its own margin-left; every line of the item — its first one and each one it
     * wraps to — starts at the box's content edge (no text-indent); the separator is the first thing inline, at its
     * own margin-left from there. In the review on a phone the stamp's first item («Ajustado por la administración
     * el 8/10/2026, 14:09:31») is wider than its line and wraps inside itself: with the item hung in the margin
     * (inner -12, item 0) its second line started at x = -12, outside the clip — «:09:31» for «14:09:31».
     */
    it('DotList geometry: an item wider than its line wraps INSIDE the clipping box; only the separator of an item that starts a line falls outside it, and between items it fills the gap exactly', () => {
        const LONG = 'Ajustado por la administración el 8/10/2026, 14:09:31';
        const html = renderToStaticMarkup(<DotList items={[LONG, '2 cambios desde el envío', 'Último cambio: boss']} />);
        const px = (cls: string, prop: 'ml' | 'pl' | 'w' | 'indent') => {
            const re = prop === 'ml' ? /(?:^|\s)(-?)m[lx]-(\d+)(?=\s|$)/ : prop === 'pl' ? /(?:^|\s)(-?)p[lx]-(\d+)(?=\s|$)/
                : prop === 'w' ? /(?:^|\s)(-?)w-(\d+)(?=\s|$)/ : /(?:^|\s)(-?)indent-(\d+)(?=\s|$)/;
            const m = re.exec(cls);
            return m ? (m[1] ? -1 : 1) * Number(m[2]) * 4 : 0;
        };
        const [, outer, inner] = /^<span class="([^"]*)" data-dot-list=""><span class="([^"]*)">/.exec(html)!;
        expect(outer.split(/\s+/)).toContain('overflow-hidden');
        const items = [...html.matchAll(/<span class="([^"]*)"><span aria-hidden="true" class="([^"]*)">·<\/span>/g)].map(m => ({ item: m[1], sep: m[2] }));
        expect(items).toHaveLength(3);
        const lineStart = px(inner, 'ml');
        for (const { item, sep } of items) {
            expect(px(item, 'indent'), item).toBe(0);
            const boxLeft = lineStart + px(item, 'ml');                 // the item starts a line (wrapped onto its own)
            const contentLeft = boxLeft + px(item, 'pl');
            expect(contentLeft, `a wrapped line of «${item}» starts inside the clip`).toBeGreaterThanOrEqual(0);
            const sepLeft = contentLeft + px(sep, 'ml'), sepRight = sepLeft + px(sep, 'w');
            expect(px(sep, 'w'), sep).toBeGreaterThan(0);
            expect(sepRight, 'the separator of an item that starts a line is clipped').toBeLessThanOrEqual(0);
            expect(sepRight, 'its first line\'s text starts where its wrapped lines do').toBe(contentLeft);
            // After another item: the separator sits in the gap the item's margin leaves, neither overlapping
            // the previous item's text nor its own.
            const gap = px(item, 'ml');
            expect(px(item, 'pl') + px(sep, 'ml'), 'the separator starts at the gap\'s left edge').toBe(-gap);
            expect(px(sep, 'w'), 'and is exactly as wide as the gap').toBe(gap);
        }
    });

    it('the card\'s counts are a DotList, and the card shows the stamp in its two-line form (the review keeps the whole sentence)', () => {
        const card = locations.slice(locations.indexOf('data-lodging-row=""'), locations.indexOf('<AdjustStamp location={loc}'));
        expect(card).toMatch(/<DotList className="text-\[11px\] font-bold text-gray-600 mt-1" data-lodging-counts="" items=\{\[/);
        expect(card).not.toMatch(/<span className="text-gray-300">·<\/span>/);     // no free-standing separators left
        expect(locations).toContain('<AdjustStamp location={loc} tx={tx} compact className="mt-2" />');
        expect(locations).toContain('<AdjustStamp location={review.location} tx={tx} detail />');
    });

    const ICON_COL = '<span class="flex h-[1.375em] items-center text-[11px]" aria-hidden="true"><i class="fa-solid fa-pen-to-square text-[10px]"></i></span>';
    it('the compact stamp: the pencil in its own column beside line 1; «Ajustado · N cambios» and «date · who» on ONE line each; the whole sentence for the tooltip and screen readers', () => {
        const loc = { lodging_admin_changed_at: '2026-10-08 09:30:00', lodging_admin_changes: 8, lodging_admin_changed_by: 'admin' };
        const html = renderToStaticMarkup(<AdjustStamp location={loc} tx={tx} compact />);
        // A two-column grid: the icon alone in the first column, the text in the second.
        const open = /^<div class="([^"]*)" data-adjust-stamp="8" data-adjust-stamp-compact="" title="([^"]*)">/.exec(html)!;
        expect(open).toBeTruthy();
        expect(open[1].split(/\s+/)).toEqual(expect.arrayContaining(['grid', 'grid-cols-[auto_minmax(0,1fr)]', 'items-start']));
        expect(html.slice(open[0].length).startsWith(ICON_COL + '<div class="min-w-0 leading-snug">')).toBe(true);
        const whole = open[2];
        expect(whole).toMatch(/^Ajustado por la administración el .+ · 8 cambios desde el envío · Último cambio: admin$/);
        expect(html).toContain(`<span class="sr-only">${whole}</span>`);
        // Line 1: a DotList of «Ajustado», «8 cambios».
        expect(html).toContain(`${ITEM}${SEP('text-blue-300')}Ajustado</span>${ITEM}${SEP('text-blue-300')}8 cambios</span>`);
        // Line 2: one non-wrapping line — the short time (no year, no seconds) and who, cut with «…» if long.
        const line2 = /<span aria-hidden="true" class="([^"]*)" data-adjust-stamp-when="">([\s\S]*)<\/span><\/div><\/div>$/.exec(html)!;
        expect(line2).toBeTruthy();
        expect(line2[1].split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'whitespace-nowrap', 'min-w-0']));
        expect(textOf(line2[2])).not.toMatch(/2026|:\d\d:\d\d/);
        expect(textOf(line2[2])).toMatch(/^\d{1,2}\/\d{1,2}, .*·admin$/);
        expect(line2[2]).toMatch(/<span class="min-w-0 truncate"><i [^>]*><\/i>admin<\/span>$/);
        // A team role without Localidades › ver: no who, no separator after the time.
        const anon = renderToStaticMarkup(<AdjustStamp location={{ ...loc, lodging_admin_changes: 1, lodging_admin_changed_by: null }} tx={tx} compact />);
        expect(anon).toContain(`${SEP('text-blue-300')}1 cambio</span>`);
        expect(anon).not.toContain('Último cambio');
        expect(textOf(anon.slice(anon.indexOf('data-adjust-stamp-when')))).not.toContain('·');
        // en / pt
        expect(renderToStaticMarkup(<AdjustStamp location={loc} tx={txOf('en')} compact />)).toContain('Adjusted</span>');
        expect(renderToStaticMarkup(<AdjustStamp location={loc} tx={txOf('pt')} compact />)).toContain('8 alterações</span>');
    });

    it('the full stamp (the review) also keeps the pencil with its first line and its «·» in front of each item', () => {
        const html = renderToStaticMarkup(<AdjustStamp location={{ lodging_admin_changed_at: '2026-10-08 09:30:00', lodging_admin_changes: 2, lodging_admin_changed_by: 'boss' }} tx={tx} detail />);
        const open = /^<div class="[^"]*" data-adjust-stamp="2">/.exec(html)!;
        expect(open).toBeTruthy();
        expect(html.slice(open[0].length).startsWith(ICON_COL)).toBe(true);
        const items = html.split(ITEM).slice(1).map(x => textOf(x.slice(0, x.indexOf('</span>', x.indexOf('</span>') + 1))));
        expect(items).toEqual([expect.stringMatching(/^·Ajustado por la administración el /), '·2 cambios desde el envío', '·Último cambio: boss']);
        // On a phone that first item wraps: BEFORE the date, which moves to the next line whole with its time (not
        // «8/10/2026,» / «14:09:31»): an inline block, which wraps inside only on a line narrower than itself
        // (max-w-full; whitespace-nowrap would run past such a line's end, into the clip).
        const date = fmtStamp('2026-10-08 09:30:00');
        const DATE = (d: string) => `<span class="inline-block max-w-full" data-adjust-stamp-date="">${d}</span>`;
        expect(html).toContain(`${ITEM}${SEP('text-blue-300')}Ajustado por la administración el ${DATE(date)}</span>`);
        for (const lang of ['en', 'pt'] as const) {
            const other = renderToStaticMarkup(<AdjustStamp location={{ lodging_admin_changed_at: '2026-10-08 09:30:00', lodging_admin_changes: 2 }} tx={txOf(lang)} />);
            expect(other, lang).toContain(`${fillVars(translations[lang]['lodging.adjusted.stamp'], { date: DATE(date) })}</span>`);
        }
    });

    it('fmtStampShort: day / month and hour:minute, parsed as UTC', () => {
        const s = fmtStampShort('2026-10-08 09:30:00', 'es-ES');
        expect(s).not.toContain('2026');
        expect(s).toMatch(/\d{1,2}\/\d{1,2}, \d{2}:\d{2}$/);
        expect(fmtStampShort(null)).toBe('');
        expect(fmtStampShort('mañana')).toBe('mañana');
    });

    it('the room and hotel headers lay out by their OWN width: the beds box goes beside the title only when both fit (no «Habitaci/ón 103»)', () => {
        const room = EXPLORER.slice(EXPLORER.indexOf('export function RoomLevel('));
        const hotel = EXPLORER.slice(EXPLORER.indexOf('{/* Hotel header'), EXPLORER.indexOf('export function RoomLevel('));
        for (const [name, src] of [['room', room], ['hotel', hotel]] as const) {
            expect(src, name).toMatch(/<div className="@container rounded-3xl [^"]*" data-(room|hotel)-header="">\s*<div className="flex flex-col @2xl:flex-row @2xl:items-start gap-4/);
            expect(src, name).toContain('<div className="@2xl:w-72 shrink-0 space-y-2">');
            expect(src.slice(0, src.indexOf('</h4>')), name).toMatch(/className="text-2xl @sm:text-3xl /);
        }
        expect(EXPLORER).not.toMatch(/md:flex-row md:items-start|md:w-72/);
        expect(room.slice(0, room.indexOf('</h4>'))).toContain('@lg:text-4xl');
        // Rendered: the container classes reach the markup.
        const html = renderRoom({ id: 101, room_number: '103', capacity: 2, location_id: 3 }, [], LOCS);
        expect(html).toMatch(/<div class="@container rounded-3xl [^"]*" data-room-header="">/);
    });

    it('the breadcrumb sits flush with the conference panel\'s top: its sticky top is minus the panel\'s padding, only where the panel scrolls', () => {
        expect(EXPLORER).toMatch(/<div className="sticky top-0 z-20 [^"]*" data-explorer-crumbs="">/);
        const panel = /className="([^"]*)" data-cm-shell-panel=""/.exec(PAGE)![1].split(/\s+/);
        expect(panel).toEqual(expect.arrayContaining(['p-6', 'overflow-auto']));
        expect(SHELL_PANEL_STICKY_TOP).toBe('-1.5rem');                     // = -p-6
        const css = SHELL_CSS.replace(/\s+/g, ' ');
        expect(css).toContain(`@media (min-width: ${SHELL_PANEL_MIN_WIDTH}px) and (min-height: ${SHELL_PANEL_MIN_HEIGHT}px) { [data-cm-shell-panel] [data-explorer-crumbs] { top: -1.5rem; } }`);
    });

    it('the run: «Pendientes» counts everyone it left without a bed — the skipped locations\' too — and says how many it did not touch', () => {
        expect(runSummaryOf({ assignedCount: 3, remaining: 0, skipped_unassigned: 2 })).toEqual({ assigned: 3, remaining: 2, skipped: 2 });
        expect(runSummaryOf({ assignedCount: 3, remaining: 1, skipped_frozen: [{ unassigned: 2 }, { unassigned: 1 }] })).toEqual({ assigned: 3, remaining: 4, skipped: 3 });
        expect(runSummaryOf({ assignedCount: 5, remaining: 1 })).toEqual({ assigned: 5, remaining: 1, skipped: 0 });   // an older plugin
        expect(assignment).toContain('() => (runReport ? runSummaryOf(runReport) : null)');
        const at = EXPLORER.indexOf('const runChip = runSummary');
        const chip = EXPLORER.slice(at, EXPLORER.indexOf('return (', at));
        expect(chip).toMatch(/runSummary\.skipped\s*\?\s*tx\('board\.run\.summary\.skipped'[\s\S]*k: runSummary\.skipped[\s\S]*:\s*tx\('board\.run\.summary'/);
        expect(fillVars(translations.es['board.run.summary.skipped'], { n: 3, m: 2, k: 2 })).toBe('Asignados: 3 · Pendientes: 2 (2 sin tocar)');
        // The report: the same «sin tocar», and each skipped location says how many it left without a room.
        expect(assignment).toMatch(/runSummary && runSummary\.skipped \? <> · <span [^>]*data-run-untouched=\{runSummary\.skipped\}>\{tx\('assignment\.report\.untouched'/);
        expect(assignment).toMatch(/Number\(l\.unassigned\) > 0 && \([\s\S]*?data-run-skipped-unassigned=\{l\.unassigned\}[\s\S]*?\{l\.unassigned\} \{t\('lodging\.unlodged\.short'\)/);
        // «Sur: 3 asignados» is ONE text run (as separate flex items, the gap put a space before the colon).
        expect(assignment).toContain("<span><b>{l.name}</b>: {l.assignedCount} {Number(l.assignedCount) === 1 ? (t('assignment.assigned.one') || 'asignado') : (t('assignment.assigned.short') || 'asignados')}");
        expect(assignment).not.toMatch(/<\/i>\s*<b>\{l\.name\}<\/b>:/);
    });
});

describe('dragging a placed attendee: the «Suelta aquí» hint appears without moving anything', () => {
    // It used to be inserted between the search box and the «Sin asignar» list at dragstart: the list moved down
    // 51 px, the panel's scroll anchoring scrolled by as much to keep it still, the room chip being dragged slid
    // out from under the pointer and Chrome cancelled the drag (no location filter, list near the panel's top).
    const PORTAL_EXPLORER = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/portal/LodgingExplorer.tsx'), 'utf8').replace(/\r\n/g, '\n');
    for (const [name, src, text] of [['admin', EXPLORER, "tx('board.drop.here'"], ['portal', PORTAL_EXPLORER, 'Suelta aquí para liberar la cama']] as const) {
        it(`${name}: the hint COVERS the search box — absolutely positioned inside its wrapper — instead of taking room above the list`, () => {
            const at = src.indexOf(text);
            expect(at).toBeGreaterThan(0);
            expect(src.indexOf(text, at + 1)).toBe(-1);
            const open = src.lastIndexOf('<div className="relative">', at);
            const input = src.indexOf('<input', open);
            expect(open).toBeGreaterThan(0);
            expect(input).toBeGreaterThan(open);
            expect(input).toBeLessThan(at);                                  // the search box's own wrapper…
            const between = src.slice(open, at);
            expect(count(between, '<div') - count(between, '</div>')).toBe(2);   // …still open around the hint's box
            const hint = src.slice(src.lastIndexOf('<div', at), at);
            expect(hint).toMatch(/^<div className="absolute inset-0 /);
            expect(hint).toContain('data-drop-unassign-hint=""');
        });
    }
});

describe('translations', () => {
    const NEW = ['lodging.adjust.notice', 'lodging.adjust.short', 'lodging.adjusted.toast', 'lodging.adjust.confirm', 'lodging.adjust.move.hint',
        'lodging.adjust.move.denied', 'lodging.adjust.movein.hint', 'lodging.adjust.movein.denied', 'lodging.adjust.state.submitted', 'lodging.adjust.state.validated',
        'lodging.adjusted.stamp', 'lodging.adjusted.changes', 'lodging.adjusted.changes.one', 'lodging.adjusted.by',
        'lodging.adjusted.review.hint', 'lodging.adjust.review.help', 'lodging.adjust.open', 'lodging.review.changed', 'allot.confirm.pool.adjust',
        'lodging.adjusted.card', 'lodging.adjusted.card.changes', 'lodging.adjusted.card.changes.one', 'board.run.summary.skipped',
        'assignment.report.assigned', 'assignment.report.untouched', 'lodging.adjust.release.submitted', 'lodging.adjust.release.validated'];
    const GONE = ['board.frozen', 'explorer.room.locked.badge', 'explorer.room.locked', 'explorer.occupant.frozen', 'explorer.picker.excluded.frozen', 'lodging.frozen.notice'];
    it('every new text exists in es / en / pt, with the same placeholders; the lock texts are gone', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            for (const k of NEW) {
                expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
                expect((translations[lang][k].match(/\{\w+\}/g) || []).sort(), `${lang} ${k}`).toEqual((translations.es[k].match(/\{\w+\}/g) || []).sort());
            }
            for (const k of GONE) expect(k in translations[lang], `${lang} ${k}`).toBe(false);
        }
    });
    it('no adjustment text hedges «en validación o validado» — the state is known, and said', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            for (const [k, v] of Object.entries(translations[lang])) {
                if (!/^lodging\.adjust|^assignment\.skipped\.frozen$/.test(k)) continue;
                expect(v, `${lang} ${k}`).not.toMatch(/validación o validad|validation or validated|validação ou validad|validación\/validado|validation\/validated|validação\/validada/);
            }
        }
    });
    it('every key LodgingAdjust.tsx names exists', () => {
        for (const m of read('admin/LodgingAdjust.tsx').matchAll(/\btx\(\s*'([^']+)'/g)) expect(translations.es[m[1]], m[1]).toBeTruthy();
    });
});
