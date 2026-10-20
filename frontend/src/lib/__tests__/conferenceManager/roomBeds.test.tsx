/**
 * conference-manager 2.18.0 — beds per location («camas por localidad»): one room shared by several locations.
 *
 * The server side is pinned in backend conference-manager-room-beds.test.ts. Here, for the screens:
 *   - the explorer's drop / picker checks (lib/lodgingView.ts) mirror the server's bed rule: a person takes one
 *     of their location's beds first, then a pool bed, so a drop the server would refuse is refused on screen
 *     («Sin cama para su localidad…») and the «Asignar participante» picker does not offer that person;
 *   - the hotel card counts every location with beds in a shared room, and the room counts as a pool room
 *     only while it keeps pool beds;
 *   - the admin's tile and the explorer's room badges show each location's beds (taken / given) and the pool's;
 *   - the coordinator's portal marks a shared room «Compartida · tuyas N de M camas»;
 *   - every new text exists in es / en / pt.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignCandidates, candidateExclusions, dropBlock, hotelStats, indexOccupants, lockMismatch, lockText, moveAdjustments, POOL_FILTER, roomMatchesLocation, sharedBedFree } from '../../../../../marketplace/plugins/conference-manager/client/lib/lodgingView';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { buildHotelReport } from '../../../../../marketplace/plugins/conference-manager/client/lib/exports';
import fs from 'node:fs';
import path from 'node:path';

const NORTE = 1, SUR = 2, OESTE = 3;
// A3: 4 beds — Norte 2, Sur 1, pool 1.
const A3: any = {
    id: 30, room_number: 'A3', capacity: 4, location_id: null,
    shares: [{ location_id: NORTE, location_name: 'Norte', beds: 2, occupied: 0 }, { location_id: SUR, location_name: 'Sur', beds: 1, occupied: 0 }],
    pool_beds: 1, pool_occupied: 0,
};
const person = (id: number, location_id: number | null, room_id: number | null = null): any => ({ id, first_name: `P${id}`, location_id, room_id, status: 'confirmed' });
const ctx: any = { pending: new Set<number>() };

describe('the shared-room bed rule on screen mirrors the server', () => {
    it('a location fills its beds, then the pool bed; a location without beds there only gets the pool bed', () => {
        const inside = [person(1, NORTE, 30), person(2, NORTE, 30)];
        expect(sharedBedFree(A3, person(3, NORTE), inside)).toBe(true);        // the pool bed
        const withOverflow = [...inside, person(3, NORTE, 30)];
        expect(sharedBedFree(A3, person(4, NORTE), withOverflow)).toBe(false); // Norte's 2 + the pool bed taken
        expect(sharedBedFree(A3, person(5, OESTE), withOverflow)).toBe(false); // the pool bed is taken
        expect(sharedBedFree(A3, person(6, SUR), withOverflow)).toBe(true);    // Sur's own bed
        expect(sharedBedFree(A3, person(7, OESTE), inside)).toBe(true);        // the pool bed is free
        expect(sharedBedFree(A3, person(1, NORTE, 30), inside)).toBe(true); // a person already inside counts out
        // Not a shared room: the capacity / location checks decide, never this one.
        expect(sharedBedFree({ ...A3, shares: [] }, person(4, NORTE), withOverflow)).toBe(true);
        expect(sharedBedFree({ ...A3, location_id: NORTE }, person(4, NORTE), withOverflow)).toBe(true);
    });

    it('without the occupants it trusts the server counts on the room', () => {
        const full = { ...A3, shares: [{ ...A3.shares[0], occupied: 2 }, A3.shares[1]], pool_occupied: 1 };
        expect(sharedBedFree(full, person(4, NORTE), null)).toBe(false);
        expect(sharedBedFree(full, person(6, SUR), null)).toBe(true);
        expect(sharedBedFree(A3, person(4, OESTE), null)).toBe(true);
    });

    it('a drop the server would refuse is refused on screen, and the picker leaves that person out', () => {
        const people = [person(1, NORTE, 30), person(2, NORTE, 30), person(3, NORTE, 30), person(4, NORTE), person(5, OESTE), person(6, SUR)];
        const idx = indexOccupants(people);
        expect(dropBlock(people[3], A3, idx)).toBe('board.room.shared.full');
        expect(dropBlock(people[4], A3, idx)).toBe('board.room.shared.full');
        expect(dropBlock(people[5], A3, idx)).toBe(null);
        const nameOf = (p: any) => p.first_name;
        expect(assignCandidates(people, A3, ctx, { nameOf }).map(p => p.id)).toEqual([6]);
        // «sin cama libre de su localidad aquí», not «de otras localidades».
        expect(candidateExclusions(people, A3, ctx)).toMatchObject({ foreign: 0, noBed: 2 });
    });

    it('the explorer filters a shared room by its beds: the pool only while it keeps pool beds; a location that has beds there', () => {
        const deps: any = { idx: indexOccupants([person(9, OESTE, 30)]), locationIdOf: (p: any) => p.location_id };
        const full = { ...A3, pool_beds: 0, pool_occupied: 0 };
        expect(roomMatchesLocation(A3, POOL_FILTER, deps)).toBe(true);
        expect(roomMatchesLocation(full, POOL_FILTER, deps)).toBe(false);
        expect(roomMatchesLocation(full, String(NORTE), deps)).toBe(true);
        expect(roomMatchesLocation(full, String(OESTE), deps)).toBe(true);   // one of its people sleeps there
        expect(roomMatchesLocation(full, '99', deps)).toBe(false);
        expect(roomMatchesLocation(A3, '99', deps)).toBe(true);              // it keeps a pool bed anyone may take
    });

    it('the inscription form only says «if it keeps the bed» for a person in a shared room', () => {
        const locs: any = [{ id: NORTE, name: 'Norte', lodging_status: 'draft' }, { id: SUR, name: 'Sur', lodging_status: 'validated' }];
        const shared = moveAdjustments({ location_id: NORTE, room_id: 30, room_location_id: null, room_shared: 1 }, { location_id: SUR }, locs);
        expect(shared.into).toBe(null);
        expect(shared.intoMaybe?.name).toBe('Sur');
        const pool = moveAdjustments({ location_id: NORTE, room_id: 31, room_location_id: null, room_shared: 0 }, { location_id: SUR }, locs);
        expect([pool.into?.name, pool.intoMaybe]).toEqual(['Sur', null]);
    });

    it('the hotel card counts every location with beds in a shared room, and the pool only while pool beds remain', () => {
        const hotel: any = { id: 1, name: 'Dorado', rooms: [A3, { id: 31, room_number: 'A4', capacity: 2, location_id: OESTE, location_name: 'Oeste' }] };
        const s = hotelStats(hotel, null, []);
        expect(s.locations.map(l => l.name)).toEqual(['Norte', 'Oeste', 'Sur']);
        expect(s.poolRooms).toBe(1);
        expect(hotelStats({ ...hotel, rooms: [{ ...A3, pool_beds: 0 }] }, null, []).poolRooms).toBe(0);
    });
});

describe('the screens show the split', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it('the admin tile and the explorer badges show each location\'s beds and the pool\'s', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        // Only the name is cut on a narrow tile: the beds count is a span of its own that never shrinks.
        expect(page).toContain('<span className="truncate min-w-0">{name}</span>');
        expect(page).toContain('<span className="shrink-0 tabular-nums">{count}</span>');
        expect(page).toContain("t('beds.pool.chip') || 'Pool'");
        expect(page).toContain('conferenceApi.setRoomBeds(room.id, shares, release ? { release_lock: true } : undefined)');
        expect(page).toContain('conferenceApi.giveLocationBeds(locationId, { beds: n, hotel_id: hotel.id })');
        // «4 camas para Malambo: 1 habitación entera» — singular / plural, and no «0 …» part.
        expect(page).toContain("wholeRooms === 1 ? tx('beds.give.part.whole.one', '1 habitación entera')");
        expect(page).toContain('].filter(Boolean).join(');
        // The bed actions refresh in place (no spinner, the page keeps its scroll position) — and so does an
        // applied «Sugerir reparto» (2.20.0).
        expect((page.match(/fetchHotels\(true\)/g) || []).length).toBe(3);
        expect(page).toContain('onApplied={() => { fetchHotels(true); fetchPeople(); }}');
        const explorer = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingExplorer.tsx');
        expect(explorer).toContain('data-room-share={s.location_id}');
        expect(explorer).toContain("'board.room.shared.full'");
    });

    it('«Sugerir reparto» (2.20.0): the plan on screen is the one applied, Escape answers the question, a worse plan cannot be applied', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        // The options recalculate it; «Aplicar» sends the options the plan on screen was made with.
        expect(sheet).toContain('useEffect(() => { if (!applied) calculate(); }, [conferenceId, replan, share, hotelId, fresh, divide]);');
        expect(sheet).toContain('applyLodgingPlan(conferenceId, plan.token, { replan: plan.options.replan, share: plan.options.share, hotel_id: plan.options.hotel_id, fresh: !!plan.options.fresh, divide_families: !!plan.options.divide_families })');
        // While «¿Continuar?» is open the sheet does not close on Escape or the backdrop.
        expect(sheet).toContain('onEscape={busy || confirming ? undefined : onClose}');
        // Nobody to place: no «Aplicar»; a plan worse than today: disabled (the server refuses it too).
        expect(sheet).toContain('{plan && plan.people > 0 && <button');
        expect(sheet).toContain('disabled={!!busy || plan.worse ||');
        // The verdict is announced; today and the plan side by side.
        expect(sheet).toContain('role="status" aria-live="polite"');
        expect(sheet).toContain('data-plan-compare=""');
    });

    it('«Sugerir reparto» opens from Alojamiento, Asignación and Localidades (2.21.0: the owner looked for it there)', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page.match(/data-plan-open=/g) || []).toHaveLength(3);
        // Asignación: with the hotels it already has; an applied plan reloads the board.
        expect(page).toContain('{showPlan && <LodgingPlan conferenceId={conferenceId} hotels={hotels} onClose={() => setShowPlan(false)} onApplied={() => loadData(true)} />}');
        expect(page).toContain('{hotels.length > 0 && <button');
        // Localidades: Hospedaje › gestionar opens it (the route's own permission); the hotels are fetched then,
        // and without any it says where to add them.
        expect(page).toContain("const canPlan = locPerms.can('lodging', 'manage');");
        expect(page).toContain('{planHotels && <LodgingPlan conferenceId={conferenceId} hotels={planHotels} onClose={() => setPlanHotels(null)} onApplied={() => loadLocations()} />}');
        expect(page).toContain("if (!list.length) addToast(tx('plan.nohotels', 'Primero agrega hoteles y habitaciones en Alojamiento.'), 'info');");
        for (const lang of ['es', 'en', 'pt'] as const) expect(translations[lang]['plan.nohotels'], lang).toBeTruthy();
    });

    it('«Sugerir reparto» says what it can prove (the bounds no allotment beats) and how many preferred families it divided', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(sheet).toContain("data-plan-proof={plan.proof.beds_optimal ? 'optimal' : 'bound'}");
        expect(sheet).toContain('{plan.proof.rooms_optimal && (');
        expect(sheet).toContain("{!plan.options.fresh && <> {tx('plan.proof.fresh',");
        expect(sheet).toContain("cnt('plan.families.split', plan.families_split,");
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['plan.proof.beds', 'plan.proof.all', 'plan.proof.bound', 'plan.proof.rooms', 'plan.proof.fresh', 'plan.families.split', 'plan.families.split.one']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
        expect(translations.es['plan.proof.beds']).toContain('{min}');
    });

    it('«Sugerir reparto» with too few beds: the locations\' order, changed with the arrows and saved; a rule no room can keep is explained', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(sheet).toContain('{plan.short && plan.order && plan.order.length > 1 && (');
        // ↑ ↓ swap two neighbours, save the order, then calculate again (the plan shown is the one applied).
        expect(sheet).toContain('[ids[index], ids[to]] = [ids[to], ids[index]];');
        expect(sheet).toContain('try { await conferenceApi.setLodgingOrder(conferenceId, ids); }');
        expect(sheet).toContain('disabled={!!busy || applied || i === 0}');
        expect(sheet).toContain('disabled={!!busy || applied || i === plan.order.length - 1}');
        expect(sheet).toContain('{misused.length > 0 && (');
        const lib = read('../../../../../marketplace/plugins/conference-manager/client/lib/conference.ts');
        expect(lib).toContain("'/plugin/conference-manager/assignment/location-order', { conference_id: conferenceId, location_ids: locationIds }");
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['plan.order.hint', 'plan.order.up', 'plan.order.down', 'plan.oversized']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
        expect(translations.es['plan.oversized']).toContain('{rule}');
        expect(translations.es['plan.order.hint']).toContain('{beds}');
    });

    it('«Rehacer todo el reparto»: a second suggestion can think the arrangement again; applying it says who moves and sends the option', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(sheet).toContain('const opts = () => ({ replan, share, hotel_id: hotelId ? Number(hotelId) : null, fresh, divide_families: divide });');
        expect(sheet).toContain('[conferenceId, replan, share, hotelId, fresh, divide]');
        expect(sheet).toContain('hotel_id: plan.options.hotel_id, fresh: !!plan.options.fresh, divide_families: !!plan.options.divide_families });');
        // The confirmation counts the people who move, and is the dangerous kind.
        expect(sheet).toContain("cnt('plan.apply.confirm.fresh', plan.moved || 0,");
        expect(sheet).toContain("tx('plan.apply', 'Aplicar reparto'), !!plan.options.fresh && !plan.keeps_today);");
        expect(sheet).toContain('!plan.totals.changed && !plan.placements.length && !plan.moved');
        expect(sheet).toContain("{!fresh && <p className=\"text-[11px] font-medium text-gray-500\">{tx('plan.nothing.fresh',");
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['plan.fresh', 'plan.fresh.hint', 'plan.nothing.fresh', 'plan.moved', 'plan.moved.one', 'plan.apply.confirm.fresh', 'plan.apply.confirm.fresh.one']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
    });

    it('«Sugerir reparto» lists the locations with everyone in a bed, says which break a hard rule, and turns «Rehacer todo» on in one click', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(sheet).toContain("plan.locations.filter((l: any) => l.settled && l.violations.some((v: any) => v.hard))");
        expect(sheet).toContain('onClick={() => setFresh(true)}');
        expect(sheet).toContain("cnt('plan.settled', l.people,");
        expect(sheet).toContain("{o.state === 'settled' && <span");
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['plan.settled', 'plan.settled.one', 'plan.settled.hard', 'plan.settled.hard.one', 'plan.settled.broken', 'plan.order.settled', 'plan.order.frozen']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
    });

    it('Alojamiento lists the hotels with a summary; a hotel\'s rooms (and their tools) only once it is entered', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page).toContain('return (open ? [open] : hotels).map(hotel => (');
        // The rooms and the allotment tools live in the entered hotel only.
        expect(page).toContain('{open ? (\n                    <div className="p-4 sm:p-8 bg-gray-50/30">'.split('\n').join(page.includes('\r\n') ? '\r\n' : '\n'));
        // The list: the summary (hotelStats) and the way in; back to all hotels from inside.
        expect(page).toContain('const st = hotelStats(hotel as any, occupantsByRoom as any, locations as any);');
        expect(page).toContain('onClick={() => enterHotel(hotel.id)} data-hotel-enter={hotel.id}');
        expect(page).toContain('onClick={() => enterHotel(null)} data-hotels-back=""');
        // Entering or leaving a hotel ends a room selection.
        expect(page).toContain('const enterHotel = (id: number | null) => { setOpenHotelId(id); setSelectHotel(null);');
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['hotels.back', 'hotels.enter', 'hotels.rooms', 'hotels.rooms.one', 'hotels.beds', 'hotels.beds.one', 'hotels.occupied', 'hotels.free', 'hotels.locations.more']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
    });

    it('a group bigger than every room: a family is information («lo más junto posible»), only a rule misused on hundreds suggests «Separar por»', () => {
        const sheet = read('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(sheet).toContain('const misused = oversized.filter((o: any) => o.people > 3 * o.largest_room);');
        expect(sheet).toContain('const bigFamilies = oversized.filter((o: any) => o.people <= 3 * o.largest_room);');
        expect(sheet).toContain('{misused.length > 0 && (');
        expect(sheet).not.toContain('{plan.oversized && plan.oversized.length > 0 && (');
        expect(translations.es['plan.big.one']).not.toContain('Separar por');
        expect(translations.es['plan.big']).not.toContain('Separar por');
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['plan.big.one', 'plan.big', 'plan.big.more']) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
    });

    it('assignment rules: the priority explained (the higher number first, no two the same), the order shown, boxes that can be emptied', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        // Which number wins, said where it is typed; the «(1-100)» no longer printed twice.
        expect(page).not.toContain("{t('rule.priority')} (1-100)");
        expect(page).toContain("tx('rules.priority.help',");
        expect(translations.es['rules.priority.help']).toContain('MÁS ALTO');
        // A number another rule uses: said at once, and «Guardar» waits.
        expect(page).toContain('rules.find(r => r.id !== (ruleForm as any).id && Number(r.priority) === Number(ruleForm.priority))');
        expect(page).toContain('<button type="submit" disabled={!!priorityClash}');
        // The list says each rule's place; a new rule takes a free number.
        expect(page).toContain("tx('rules.rank', '{n}.ª · prioridad {p}', { n: ruleIndex + 1, p: rule.priority })");
        expect(page).toContain('priority: freePriority(), config:');
        // Emptied boxes stay empty while typing (they used to snap back to 1 or 0).
        expect(page).toContain("value={rParams.min_size ?? ''} onChange={e => setRParam({ min_size: numOrEmpty(e.target.value) })}");
        expect(page).toContain("value={rParams.min ?? ''} onChange={e => setRParam({ min: numOrEmpty(e.target.value) })}");
        expect(page).toContain("priority: e.target.value === '' ? '' : Number(e.target.value) })");
        expect(page).not.toMatch(/Number\(e\.target\.value\) \|\| 0/);
        expect(page).not.toContain('value={rParams.min_size || 1}');
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['rules.order', 'rules.rank', 'rules.priority.taken', 'rules.priority.help']) {
            expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        }
    });

    it('the portal marks a shared room with the location\'s own beds', async () => {
        const mod: any = await import('../../../../../marketplace/plugins/conference-manager/client/portal/LodgingExplorer');
        expect(mod).toBeTruthy();
        const src = read('../../../../../marketplace/plugins/conference-manager/client/portal/LodgingExplorer.tsx');
        expect(src).toContain('Compartida · tuyas ${beds} de ${total} camas');
        expect((src.match(/<SharedBadge room=\{room\} \/>/g) || []).length).toBe(2);
        expect(renderToStaticMarkup(React.createElement('span', null, 'ok'))).toBe('<span>ok</span>');
    });

    it('the hotel Excel names each location\'s beds of a shared room, then the pool\'s', () => {
        const sheets = buildHotelReport({
            hotels: [{ id: 1, name: 'Dorado', rooms: [A3, { id: 31, room_number: 'A4', capacity: 2, location_id: null }] } as any],
            people: [], fields: [], locations: [{ id: NORTE, name: 'Norte' }, { id: SUR, name: 'Sur' }] as any,
        });
        const rows = sheets.flatMap(s => s.rows).filter(r => r[0] === 'A3' || r[0] === 'A4');
        expect(rows.map(r => r[3])).toEqual(['Norte 2 · Sur 1 · General 1', 'General']);
    });

    it('«Aplicar» on a hotel asks before it undoes a split, and the deletions name the sharing locations', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page).toContain("const affected = (hotel.rooms || []).filter(r => (r.location_id != null || isShared(r)) && (!roomIds || roomIds.includes(r.id)));");
        expect(page).toContain("tx('allot.confirm.shared',");
        expect(page).toContain("tx('allot.confirm.pool.shared',");
        expect(page).toContain('...(hotel.rooms || []).flatMap(r => (r.shares || []).map(s => Number(s.location_id)))');
        expect(page).toContain('...(room.shares || []).map(s => Number(s.location_id))');
    });

    it('the inscription\'s room picker blocks a shared room with no bed for the attendee\'s location (raw location_id, like the server)', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page).toContain('const noBed = !current && !full && !foreign && !sharedBedFree(room, { id: assignTarget.id, location_id: assignTarget.location_id ?? null }, null);');
        expect(page).toContain('const blocked = full || foreign || noBed || locked;');
    });

    it('the run report says how many of a location\'s people went to pool beds, and «1 asignado» in the singular', () => {
        const page = read('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page).toContain("tx('assignment.pool.overflow', '{n} en camas del pool', { n: l.pool_beds })");
        expect(page).toContain("Number(l.assignedCount) === 1 ? (t('assignment.assigned.one') || 'asignado')");
        for (const lang of ['es', 'en', 'pt'] as const) {
            expect(translations[lang]['assignment.pool.overflow'], lang).toContain('{n}');
            expect(translations[lang]['assignment.assigned.one'], lang).toBeTruthy();
        }
    });

    it('every new text exists in es / en / pt', () => {
        const keys = Object.keys(translations.es).filter(k => k.startsWith('beds.') || k === 'board.room.shared.full');
        expect(keys.length).toBeGreaterThanOrEqual(21);
        for (const lang of ['en', 'pt'] as const) for (const k of keys) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe('lodging dates (2.21.0): a general opening and closing, and a location\'s own dates', () => {
    const page = () => fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx'), 'utf8');

    it('the Localidades card saves both general dates with the admin\'s zone; a location saves its own (general, a date, or none)', () => {
        const src = page();
        expect(src).toContain('data-testid="lodging-dates"');
        expect(src).toContain('await conferenceApi.updateConference(conferenceId, { lodging_opens: datesInput.opens || null, lodging_deadline: datesInput.closes || null, ...browserZone() } as any);');
        expect(src).toContain('await conferenceApi.updateLocation(loc.id, { lodging_opens: opens, lodging_closes: closes, ...browserZone() });');
        expect(src).toContain("const valueOf = (mode: string, day: string, none: string) => (mode === 'general' ? null : mode === 'none' ? none : day || null);");
        expect(src).toContain('valueOf(e!.opensMode, e!.opens, LODGING_NO_WAIT), valueOf(e!.closesMode, e!.closes, LODGING_NO_CLOSE)');
        expect(src).toContain('onClick={() => saveOwnDates(loc, null, null)}');
        // A window that could never open is not even sent.
        expect(src).toContain('disabled={savingDates || !dirty || invalid}');
        expect(src).toContain('disabled={savingOwn === loc.id || missing || invalid}');
        // The 2.8.0 permission screen is gone.
        expect(src).not.toMatch(/lodging_permission|savePermission|lodging\.permission|lodging\.deadline/);
    });

    it('every text it uses exists in es / en / pt, and the old ones are gone', () => {
        const used = [...page().matchAll(/t\('(lodging\.dates[a-z.]*)'\)/g)].map(m => m[1]);
        expect(new Set(used).size).toBeGreaterThanOrEqual(30);
        for (const lang of ['es', 'en', 'pt'] as const) {
            for (const k of used) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
            expect(Object.keys(translations[lang]).filter(k => /^lodging\.(deadline|permission)/.test(k)), lang).toEqual([]);
        }
    });
});

describe('a shared room keeps the gender «Sugerir reparto» gave it (2.21.0) — mirrors the server', () => {
    const LOCKED: any = { ...A3, lock: [{ field: 'gender', value: 'Masculino' }] };
    const man = { ...person(5, NORTE), gender: 'masculino' }, woman = { ...person(6, NORTE), gender: 'Femenino' }, blank = { ...person(7, NORTE), gender: '' };
    it('another value is refused everywhere: drops, the picker (counted, never hidden silently)', () => {
        expect([lockMismatch(LOCKED, man), lockMismatch(LOCKED, woman), lockMismatch(LOCKED, blank)]).toEqual([false, true, false]);
        expect(lockMismatch({ ...LOCKED, location_id: NORTE }, woman)).toBe(false);
        expect(dropBlock(woman, LOCKED)).toBe('board.room.locked');
        expect(dropBlock(man, LOCKED)).toBeNull();
        expect(assignCandidates([man, woman], LOCKED, ctx, { nameOf: (p: any) => p.first_name }).map((p: any) => p.id)).toEqual([5]);
        expect(candidateExclusions([man, woman], LOCKED, ctx).locked).toBe(1);
    });
    it('reads as words', () => {
        expect(lockText(LOCKED.lock, { F: 'Mujeres', M: 'Hombres' })).toBe('Hombres');
        expect(lockText([{ field: 'iglesia', value: 'Central' }], { F: 'Mujeres', M: 'Hombres' })).toBe('Central');
        expect(lockText(null, { F: 'Mujeres', M: 'Hombres' })).toBe('');
    });
    it('every lock text is translated', () => {
        const keys = ['room.lock.only', 'room.lock.women', 'room.lock.men', 'room.lock.title', 'board.room.locked', 'explorer.picker.excluded.locked', 'beds.lock.text', 'beds.lock.release', 'plan.room.lock', 'plan.lock.note'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe('«Sugerir reparto»: families together or divided, both answers shown (2.21.0)', () => {
    const sheet = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx'), 'utf8');
    it('asks for the chosen answer, shows both and applies the one on screen', () => {
        expect(sheet).toContain('divide_families: divide');
        expect(sheet).toContain('divide_families: !!plan.options.divide_families');
        expect(sheet).toContain('data-plan-variants={v.chosen}');
        expect(sheet).toContain('data-plan-variant-divided={x.families_divided}');
        expect(sheet).toContain('[conferenceId, replan, share, hotelId, fresh, divide]');
    });
    it('every text is translated', () => {
        const keys = ['plan.variants.title', 'plan.variants.keep', 'plan.variants.divide', 'plan.variants.keep.hint', 'plan.variants.divide.hint',
            'plan.variants.divided', 'plan.variants.divided.one', 'plan.variants.none', 'plan.variants.unplaced', 'plan.variants.unplaced.one',
            'plan.variants.saves', 'plan.variants.saves.one', 'plan.variants.same'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe('held by the administration (2.21.0): the admin blocks a room and fixes a person', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it('the explorer offers both toggles to whoever manages lodging, and the plan says what it leaves', () => {
        const explorer = src('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingExplorer.tsx');
        expect(explorer).toContain('env.onToggleBlock(room)');
        expect(explorer).toContain('env.onTogglePin(p)');
        const page = src('../../../../../marketplace/plugins/conference-manager/client/admin/page.tsx');
        expect(page).toContain('onToggleBlock={canManage ? toggleRoomBlock : undefined}');
        expect(page).toContain('conferenceApi.setRoomBlocked(room.id, on)');
        expect(page).toContain('conferenceApi.pinInscription(p.id, on)');
        expect(src('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx')).toContain('data-plan-held=');
    });
    it('every text is translated', () => {
        const keys = ['room.blocked.chip', 'room.block.on', 'room.block.off', 'room.block.on.done', 'room.block.off.done', 'room.blocked.note',
            'person.pinned.chip', 'person.pin.on', 'person.pin.off', 'person.pin.on.done', 'person.pin.off.done', 'person.pin.hint',
            'plan.held', 'plan.held.rooms', 'plan.held.rooms.one', 'plan.held.people', 'plan.held.people.one'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe('«Sugerir reparto» says the rooms left free (2.21.0): the beds over are the same both ways, what changes is where', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it('each answer shows its rooms used, its free rooms and the empty beds of the rooms used; the compare line its free rooms', () => {
        const plan = src('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(plan).toContain('data-plan-variant-free={x.free_rooms}');
        expect(plan).toContain("cnt('plan.variants.empty', emptyOf(x)");
        expect(plan).toContain('data-plan-variants-spare={spare}');
        expect(plan).toContain('v.keep.used_empty_beds !== v.divide.used_empty_beds');
        expect(plan).toContain("cnt('plan.variants.free', m.free_rooms");
        expect(plan).toContain("cnt('plan.totals.empty.in', plan.totals.empty_beds");
    });
    it('every text is translated', () => {
        const keys = ['plan.variants.used', 'plan.variants.used.one', 'plan.variants.free', 'plan.variants.free.one', 'plan.variants.free.none',
            'plan.variants.empty', 'plan.variants.empty.one', 'plan.variants.spare', 'plan.variants.spare.one', 'plan.totals.empty.in', 'plan.totals.empty.in.one'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe('«Sugerir reparto» counts today as an answer (2.21.0): when nothing beats it, the sheet says to leave it', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it('says it, marks the answer that is today, and offers nothing to apply', () => {
        const plan = src('../../../../../marketplace/plugins/conference-manager/client/admin/LodgingPlan.tsx');
        expect(plan).toContain('data-plan-keeps-today=');
        expect(plan).toContain('data-plan-variant-today=');
        expect(plan).toContain('!plan.keeps_today && <div');
        expect(plan).toContain('!plan.moved && !plan.outcome.run_placed');
        // People waiting: applying runs the automatic assignment for them — said so, and confirmed without the fresh dialog.
        expect(plan).toContain("cnt('plan.keeps.today.run', plan.outcome.run_placed");
        expect(plan).toContain("cnt('plan.apply.confirm.today', plan.outcome.run_placed || 0");
        expect(plan).toContain('!!plan.options.fresh && !plan.keeps_today');
    });
    it('every text is translated', () => {
        const keys = ['plan.keeps.today', 'plan.variants.today', 'plan.keeps.today.run', 'plan.keeps.today.run.one', 'plan.apply.confirm.today', 'plan.apply.confirm.today.one'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});
