/**
 * The lodging EXPLORER's pure helpers (lodgingView.ts). What is pinned here is what the coordinator
 * sees and can do: hotels are DERIVED from `hotel_name` (the portal payload has no hotel id), a bed
 * taken by another location's attendee is never shown as free, the filters and «Anterior / Siguiente»
 * agree with each other, a remembered position that no longer exists falls back instead of showing a
 * blank page, keys never fire while typing or with a modal open, the free-bed picker offers exactly the
 * attendees `dragDecision` would accept, and the read-only explanation exists exactly when the tab's
 * edit gate is closed.
 */
import { describe, it, expect } from "vitest";
import { deadlineMessage, dragDecision, type LodgingAttendee, type LodgingData, type LodgingRoom } from "../lodging";
import {
    assignCandidates,
    compareRoomNumbers,
    DEFAULT_FILTERS,
    EMPTY_NAV,
    explorerKeyAction,
    fieldDisplayValue,
    fieldEntries,
    filterAttendees,
    filterRooms,
    filtersActive,
    findAttendee,
    GENDER_FILTER_LABELS,
    genderKey,
    genderLabel,
    groupRoomsByHotel,
    hotelOfRoom,
    hotelStats,
    isTypingTarget,
    moveTargets,
    navOwner,
    navRecord,
    normalizeExplorerNav,
    normalizeSearch,
    occupancyCounts,
    parseExplorerNav,
    plural,
    readOnlyReason,
    resolveExplorerNav,
    restoreExplorerNav,
    roomGender,
    roomMatchesFilters,
    roomNeighbours,
    roomOccupants,
    roomOfAttendee,
    roomPhrase,
    roomPickerView,
    roomStats,
    sameNavOwner,
    UNNAMED_HOTEL,
    type RoomFilters,
} from "../lodgingView";

const person = (id: number, first: string, last: string, extra: Partial<LodgingAttendee> = {}): LodgingAttendee => ({ id, first_name: first, last_name: last, gender: null, family_group: null, ...extra });

const room = (partial: Partial<LodgingRoom> & { id: number }): LodgingRoom => {
    const occupants = partial.occupants ?? [];
    return { hotel_name: 'Hotel Sol', room_number: String(partial.id), capacity: 2, occupied: occupants.length, ...partial, occupants };
};

const filters = (f: Partial<RoomFilters> = {}): RoomFilters => ({ ...DEFAULT_FILTERS, ...f });

describe("groupRoomsByHotel", () => {
    it("derives hotels from hotel_name in first-appearance order and sorts each hotel's rooms naturally", () => {
        const hotels = groupRoomsByHotel([
            room({ id: 1, hotel_name: 'Hotel Sol', room_number: '10' }),
            room({ id: 2, hotel_name: 'Hostal Luna', room_number: '1' }),
            room({ id: 3, hotel_name: 'Hotel Sol', room_number: '2' }),
            room({ id: 4, hotel_name: 'Hotel Sol', room_number: '101A' }),
            room({ id: 5, hotel_name: 'Hotel Sol', room_number: '101' }),
        ]);
        expect(hotels.map((h) => h.name)).toEqual(['Hotel Sol', 'Hostal Luna']);
        expect(hotels[0].rooms.map((r) => r.room_number)).toEqual(['2', '10', '101', '101A']);
        expect(hotels[1].rooms.map((r) => r.id)).toEqual([2]);
    });

    it("keys by the TRIMMED name (one hotel even if a row carries stray spaces) and names a blank hotel", () => {
        const hotels = groupRoomsByHotel([
            room({ id: 1, hotel_name: 'Hotel Sol' }),
            room({ id: 2, hotel_name: '  Hotel Sol ' }),
            room({ id: 3, hotel_name: null }),
            room({ id: 4, hotel_name: '   ' }),
        ]);
        expect(hotels).toHaveLength(2);
        expect(hotels[0]).toMatchObject({ key: 'Hotel Sol', name: 'Hotel Sol' });
        expect(hotels[0].rooms.map((r) => r.id)).toEqual([1, 2]);
        expect(hotels[1]).toMatchObject({ key: '', name: UNNAMED_HOTEL });
        expect(hotels[1].rooms.map((r) => r.id)).toEqual([3, 4]);
    });

    it("tolerates a missing or malformed payload", () => {
        expect(groupRoomsByHotel(null)).toEqual([]);
        expect(groupRoomsByHotel([null as unknown as LodgingRoom, room({ id: 1 })])).toHaveLength(1);
    });

    it("orders numbers naturally and breaks ties by id", () => {
        expect(compareRoomNumbers('2', '10')).toBeLessThan(0);
        expect(compareRoomNumbers('101', '101A')).toBeLessThan(0);
        const [h] = groupRoomsByHotel([room({ id: 9, room_number: '5' }), room({ id: 3, room_number: '5' })]);
        expect(h.rooms.map((r) => r.id)).toEqual([3, 9]);
    });

    it("finds the hotel of a room", () => {
        const hotels = groupRoomsByHotel([room({ id: 1, hotel_name: 'A' }), room({ id: 2, hotel_name: 'B' })]);
        expect(hotelOfRoom(hotels, 2)?.key).toBe('B');
        expect(hotelOfRoom(hotels, 99)).toBeNull();
    });
});

describe("roomStats / hotelStats", () => {
    it("counts the server's occupied, never shows a stray's bed as free, and names the occupancy", () => {
        const stray = roomStats(room({ id: 1, capacity: 3, occupied: 2, occupants: [person(1, 'Ana', 'Pérez')] }));
        expect(stray).toMatchObject({ capacity: 3, occupied: 2, free: 1, listed: 1, unlisted: 1, occupancy: 'partial', percent: 67 });
        expect(roomStats(room({ id: 2, capacity: 2, occupants: [] })).occupancy).toBe('empty');
        expect(roomStats(room({ id: 3, capacity: 2, occupants: [person(1, 'A', 'B'), person(2, 'C', 'D')] })).occupancy).toBe('full');
    });

    it("falls back to the listed occupants when `occupied` is missing", () => {
        const st = roomStats({ id: 1, capacity: 4, occupants: [person(1, 'A', 'B')] });
        expect(st).toMatchObject({ occupied: 1, free: 3, unlisted: 0 });
    });

    it("treats a room without beds as full (nobody can go in) and clamps an over-capacity bar to 100", () => {
        expect(roomStats(room({ id: 1, capacity: 0 }))).toMatchObject({ free: 0, occupancy: 'full', percent: 0 });
        expect(roomStats(room({ id: 2, capacity: 2, occupied: 3 }))).toMatchObject({ free: 0, percent: 100, unlisted: 3 });
    });

    it("sums a hotel; «con camas libres» includes the empty rooms", () => {
        const s = hotelStats([
            room({ id: 1, capacity: 2, occupants: [person(1, 'A', 'B'), person(2, 'C', 'D')] }),
            room({ id: 2, capacity: 3, occupants: [person(3, 'E', 'F')] }),
            room({ id: 3, capacity: 2, occupants: [] }),
        ]);
        expect(s).toEqual({ rooms: 3, beds: 7, occupied: 3, free: 4, people: 3, full: 1, partial: 1, empty: 1, withFree: 2, percent: 43 });
        expect(hotelStats([])).toMatchObject({ rooms: 0, beds: 0, percent: 0 });
    });

    it("breaks the rooms down into a PARTITION for the hotel card (llenas + parcialmente ocupadas + vacías = total)", () => {
        const list = [
            room({ id: 1, capacity: 2, occupants: [person(1, 'A', 'B'), person(2, 'C', 'D')] }), // full
            room({ id: 2, capacity: 0 }),                                                       // no beds: full
            room({ id: 3, capacity: 3, occupants: [person(3, 'E', 'F')] }),                     // partial
            room({ id: 4, capacity: 2, occupied: 1, occupants: [] }),                           // an unlisted bed: partial, never empty
            room({ id: 5, capacity: 2, occupants: [] }),                                        // empty
            room({ id: 6, capacity: 4, occupants: [] }),                                        // empty
        ];
        const s = hotelStats(list);
        expect([s.full, s.partial, s.empty]).toEqual([2, 2, 2]);
        expect(s.full + s.partial + s.empty).toBe(s.rooms);
        // The filter's «Con camas libres» still counts the empty rooms too.
        expect(s.withFree).toBe(s.partial + s.empty);
        expect(s.withFree).toBe(filterRooms(list, filters({ occupancy: 'free' })).length);
    });

    it("lists only object occupants", () => {
        expect(roomOccupants({ id: 1, occupants: [person(1, 'A', 'B'), null as unknown as LodgingAttendee] })).toHaveLength(1);
        expect(roomOccupants(null)).toEqual([]);
    });

    it("pluralises", () => {
        expect(plural(1, 'habitación', 'habitaciones')).toBe('1 habitación');
        expect(plural(0, 'habitación', 'habitaciones')).toBe('0 habitaciones');
        // The level-2 card's overflow line: «+1 cama libre más», never «+1 camas libres más».
        expect(plural(1, 'cama libre más', 'camas libres más')).toBe('1 cama libre más');
    });

    it("names a room inside a sentence («dejará la habitación 101 (Hotel Sol)»)", () => {
        expect(roomPhrase({ hotel_name: ' Hotel Sol ', room_number: '101' })).toBe('habitación 101 (Hotel Sol)');
        expect(roomPhrase({ room_number: 7 })).toBe('habitación 7');
        expect(roomPhrase({ hotel_name: 'Hostal Luna' })).toBe('habitación de Hostal Luna');
        expect(roomPhrase(null)).toBe('habitación');
    });
});

describe("gender", () => {
    it("reads the many spellings a form may use («Mujer» is F although it starts with M)", () => {
        expect(['F', 'f', 'Femenino', 'mujer', 'Female', 'W'].map(genderKey)).toEqual(['F', 'F', 'F', 'F', 'F', 'F']);
        expect(['M', 'Masculino', 'hombre', 'Male', 'H', 'Varón'].map(genderKey)).toEqual(['M', 'M', 'M', 'M', 'M', 'M']);
        expect([null, '', 'Otro', 'X'].map(genderKey)).toEqual(['', '', '', '']);
    });

    it("prints a word for a single letter and the form's own value otherwise", () => {
        expect(genderLabel('F')).toBe('Mujer');
        expect(genderLabel('m')).toBe('Hombre');
        expect(genderLabel('Femenino')).toBe('Femenino');
        expect(genderLabel(null)).toBe('');
    });

    it("tells a room's make-up from its listed occupants", () => {
        expect(roomGender(room({ id: 1 }))).toBe('none');
        expect(roomGender(room({ id: 1, occupants: [person(1, 'A', 'B', { gender: 'F' })] }))).toBe('F');
        expect(roomGender(room({ id: 1, occupants: [person(1, 'A', 'B', { gender: 'M' }), person(2, 'C', 'D', { gender: 'otro' })] }))).toBe('M');
        expect(roomGender(room({ id: 1, occupants: [person(1, 'A', 'B', { gender: 'M' }), person(2, 'C', 'D', { gender: 'Mujer' })] }))).toBe('mixed');
    });
});

describe("filters", () => {
    const rooms = [
        room({ id: 1, room_number: '101', capacity: 2, occupants: [person(1, 'José', 'Pérez', { gender: 'M', family_group: 'Pérez' }), person(2, 'Luis', 'Gómez', { gender: 'M' })] }),
        room({ id: 2, room_number: '102', capacity: 3, occupants: [person(3, 'Ana', 'Ruiz', { gender: 'F' })] }),
        room({ id: 3, room_number: '201', capacity: 2, occupants: [], is_family: 1, family_name: 'Martínez' }),
        room({ id: 4, room_number: '202', capacity: 2, occupants: [person(4, 'Eva', 'Sanz', { gender: 'F' }), person(5, 'Juan', 'Sanz', { gender: 'M' })] }),
    ];
    const ids = (list: LodgingRoom[]) => list.map((r) => r.id);

    it("searches accent- and case-insensitively by occupant name, family group, room number and family room name", () => {
        expect(normalizeSearch('  PÉREZ ')).toBe('perez');
        expect(ids(filterRooms(rooms, filters({ query: 'jose perez' })))).toEqual([1]);
        expect(ids(filterRooms(rooms, filters({ query: 'RUIZ' })))).toEqual([2]);
        expect(ids(filterRooms(rooms, filters({ query: '20' })))).toEqual([3, 4]);
        expect(ids(filterRooms(rooms, filters({ query: 'martinez' })))).toEqual([3]);
        expect(ids(filterRooms(rooms, filters({ query: '   ' })))).toEqual([1, 2, 3, 4]);
    });

    it("filters by occupancy: free includes empty rooms, full and empty are exact", () => {
        expect(ids(filterRooms(rooms, filters({ occupancy: 'free' })))).toEqual([2, 3]);
        expect(ids(filterRooms(rooms, filters({ occupancy: 'full' })))).toEqual([1, 4]);
        expect(ids(filterRooms(rooms, filters({ occupancy: 'empty' })))).toEqual([3]);
    });

    it("labels the gender options for PEOPLE (the select is «Ocupantes»): no feminine «Mixtas»", () => {
        expect(GENDER_FILTER_LABELS.mixed).toBe('Hombres y mujeres');
        expect(Object.values(GENDER_FILTER_LABELS)).not.toContain('Mixtas');
    });

    it("filters by the occupants' genders and combines every filter", () => {
        expect(ids(filterRooms(rooms, filters({ gender: 'M' })))).toEqual([1]);
        expect(ids(filterRooms(rooms, filters({ gender: 'F' })))).toEqual([2]);
        expect(ids(filterRooms(rooms, filters({ gender: 'mixed' })))).toEqual([4]);
        expect(ids(filterRooms(rooms, filters({ gender: 'M', occupancy: 'free' })))).toEqual([]);
        expect(roomMatchesFilters(rooms[3], filters({ query: 'sanz', occupancy: 'full', gender: 'mixed' }))).toBe(true);
    });

    it("counts each occupancy chip with the OTHER filters applied", () => {
        expect(occupancyCounts(rooms, filters())).toEqual({ all: 4, free: 2, full: 2, empty: 1 });
        expect(occupancyCounts(rooms, filters({ query: 'sanz', occupancy: 'empty' }))).toEqual({ all: 1, free: 0, full: 1, empty: 0 });
    });

    it("knows when a filter is on", () => {
        expect(filtersActive(filters())).toBe(false);
        expect(filtersActive(filters({ query: '  ' }))).toBe(false);
        expect(filtersActive(filters({ query: 'a' }))).toBe(true);
        expect(filtersActive(filters({ occupancy: 'full' }))).toBe(true);
        expect(filtersActive(filters({ gender: 'F' }))).toBe(true);
    });

    it("searches the unassigned list by name or family group", () => {
        const list = [person(1, 'Ana', 'Ruiz', { family_group: 'Ruiz' }), person(2, 'Ángel', 'Soto')];
        expect(filterAttendees(list, 'angel').map((a) => a.id)).toEqual([2]);
        expect(filterAttendees(list, 'ruiz').map((a) => a.id)).toEqual([1]);
        expect(filterAttendees(list, '').map((a) => a.id)).toEqual([1, 2]);
        expect(filterAttendees(null, 'x')).toEqual([]);
    });
});

describe("roomNeighbours («Anterior / Siguiente»)", () => {
    const hotelRooms = [
        room({ id: 1, capacity: 2, occupants: [] }),
        room({ id: 2, capacity: 1, occupants: [person(1, 'A', 'B')] }),
        room({ id: 3, capacity: 2, occupants: [] }),
        room({ id: 4, capacity: 1, occupants: [person(2, 'C', 'D')] }),
    ];

    it("walks the hotel's rooms in order with no wrap-around", () => {
        expect(roomNeighbours(hotelRooms, 1, filters())).toMatchObject({ prev: null, index: 0, total: 4 });
        expect(roomNeighbours(hotelRooms, 1, filters()).next?.id).toBe(2);
        expect(roomNeighbours(hotelRooms, 4, filters())).toMatchObject({ next: null, index: 3 });
    });

    it("skips the rooms the filters hide", () => {
        const n = roomNeighbours(hotelRooms, 1, filters({ occupancy: 'empty' }));
        expect(n.next?.id).toBe(3);
        expect(n.total).toBe(2);
    });

    it("keeps the current room in the walk even when the filters would drop it (its last bed was just filled)", () => {
        const n = roomNeighbours(hotelRooms, 2, filters({ occupancy: 'empty' }));
        expect(n).toMatchObject({ index: 1, total: 3 });
        expect(n.prev?.id).toBe(1);
        expect(n.next?.id).toBe(3);
    });

    it("returns nothing for a room that is not in the hotel", () => {
        expect(roomNeighbours(hotelRooms, 99, filters())).toEqual({ prev: null, next: null, index: -1, total: 4 });
    });
});

describe("navigation state", () => {
    it("reads back what was stored", () => {
        const nav = { hotel: 'Hotel Sol', room: 7, query: 'ana', occupancy: 'free', gender: 'F' };
        expect(parseExplorerNav(JSON.stringify(nav))).toEqual(nav);
        expect(parseExplorerNav(nav)).toEqual(nav);
    });

    it("never throws on garbage and validates each field on its own", () => {
        expect(parseExplorerNav(null)).toEqual(EMPTY_NAV);
        expect(parseExplorerNav('{not json')).toEqual(EMPTY_NAV);
        expect(parseExplorerNav('[1,2]')).toEqual(EMPTY_NAV);
        expect(parseExplorerNav({ hotel: 'A', room: -3, query: 5, occupancy: 'weird', gender: 'F' }))
            .toEqual({ hotel: 'A', room: null, query: '', occupancy: 'all', gender: 'F' });
        expect(parseExplorerNav({ hotel: 'A', room: '12' }).room).toBe(12);
        expect(parseExplorerNav({ hotel: 'A', room: 1.5 }).room).toBeNull();
        expect(parseExplorerNav({ hotel: 'x'.repeat(301) }).hotel).toBeNull();
        expect(parseExplorerNav({ query: 'q'.repeat(500) }).query).toHaveLength(100);
    });

    it("drops a room without a hotel (it could not be resolved)", () => {
        expect(parseExplorerNav({ hotel: null, room: 4 })).toMatchObject({ hotel: null, room: null });
    });

    it("resolves to the deepest level that still exists in the payload", () => {
        const hotels = groupRoomsByHotel([room({ id: 1, hotel_name: 'A' }), room({ id: 2, hotel_name: 'B' })]);
        expect(resolveExplorerNav({ hotel: null, room: null }, hotels)).toEqual({ level: 1, hotel: null, room: null });
        expect(resolveExplorerNav({ hotel: 'A', room: null }, hotels)).toMatchObject({ level: 2, room: null });
        expect(resolveExplorerNav({ hotel: 'A', room: 1 }, hotels)).toMatchObject({ level: 3 });
        expect(resolveExplorerNav({ hotel: 'A', room: 1 }, hotels).room?.id).toBe(1);
        // The admin took room 1 away / moved the hotel: fall back, never a blank page.
        expect(resolveExplorerNav({ hotel: 'A', room: 2 }, hotels)).toMatchObject({ level: 2 });
        expect(resolveExplorerNav({ hotel: 'Gone', room: 1 }, hotels)).toMatchObject({ level: 1, hotel: null });
    });

    it("forgets a room / hotel that is gone (so it never pulls the user back in later), keeping the filters", () => {
        const hotels = groupRoomsByHotel([room({ id: 1, hotel_name: 'A' }), room({ id: 2, hotel_name: 'B' })]);
        const ok = { ...EMPTY_NAV, hotel: 'A', room: 1, query: 'ana', occupancy: 'free' as const };
        expect(normalizeExplorerNav(ok, hotels)).toBe(ok); // nothing stale: the SAME object
        const level1 = { ...EMPTY_NAV };
        expect(normalizeExplorerNav(level1, hotels)).toBe(level1);
        expect(normalizeExplorerNav({ ...ok, room: 2 }, hotels)).toEqual({ ...ok, room: null });
        expect(normalizeExplorerNav({ ...ok, hotel: 'Gone' }, hotels)).toEqual({ ...ok, hotel: null, room: null });
        // The room comes back later: the forgotten position stays at level 2.
        const forgotten = normalizeExplorerNav({ ...ok, room: 99 }, hotels);
        const back = groupRoomsByHotel([room({ id: 1, hotel_name: 'A' }), room({ id: 99, hotel_name: 'A' })]);
        expect(resolveExplorerNav(forgotten, back).level).toBe(2);
    });
});

describe("whose remembered position it is (another coordinator in the same browser tab)", () => {
    const mine = [room({ id: 11, hotel_name: 'Hotel Sol' }), room({ id: 12, hotel_name: 'Hotel Sol' }), room({ id: 13, hotel_name: 'Hostal Luna' })];
    const theirs = [room({ id: 21, hotel_name: 'Hotel Sol' }), room({ id: 22, hotel_name: 'Hotel Sol' })];
    const saved = { hotel: 'Hotel Sol', room: 11, query: 'María Pérez', occupancy: 'free' as const, gender: 'F' as const };

    it("fingerprints the payload by its room ids (unique, sorted)", () => {
        expect(navOwner([room({ id: 12 }), room({ id: 11 }), room({ id: 12 }), { id: 'x' as unknown as number }])).toEqual([11, 12]);
        expect(navOwner(null)).toEqual([]);
    });

    it("gives the position back to the same location, even after the admin added or took away a room", () => {
        const record = JSON.stringify(navRecord(saved, navOwner(mine)));
        const position = { ...saved, query: '', gender: 'all' };
        expect(restoreExplorerNav(record, navOwner(mine))).toEqual(position);
        expect(restoreExplorerNav(record, navOwner([...mine, room({ id: 14 })]))).toEqual(position);
        expect(restoreExplorerNav(record, navOwner(mine.slice(0, 2)))).toEqual(position);
    });

    it("never writes the search text or the gender filter to storage (the search is usually an attendee's name)", () => {
        const record = JSON.stringify(navRecord(saved, navOwner(mine)));
        expect(record).not.toContain('María');
        expect(Object.keys(JSON.parse(record)).sort()).toEqual(['hotel', 'occupancy', 'owner', 'room']);
    });

    it("never hands it to ANOTHER location (same hotel names, other rooms): no hotel, no search text", () => {
        const record = JSON.stringify(navRecord(saved, navOwner(mine)));
        expect(restoreExplorerNav(record, navOwner(theirs))).toEqual(EMPTY_NAV);
        // An empty room the admin re-allotted from one location to the other is not enough to match.
        expect(restoreExplorerNav(record, navOwner([...theirs, room({ id: 13 })]))).toEqual(EMPTY_NAV);
    });

    it("ignores a record without an owner, garbage, and an empty payload", () => {
        expect(restoreExplorerNav(JSON.stringify(saved), navOwner(mine))).toEqual(EMPTY_NAV);
        expect(restoreExplorerNav('{oops', navOwner(mine))).toEqual(EMPTY_NAV);
        expect(restoreExplorerNav(null, navOwner(mine))).toEqual(EMPTY_NAV);
        expect(restoreExplorerNav({ ...saved, owner: 'nope' }, navOwner(mine))).toEqual(EMPTY_NAV);
        expect(restoreExplorerNav(navRecord(saved, []), [])).toEqual(EMPTY_NAV);
    });

    it("matches room sets when at least half of their union is shared", () => {
        expect(sameNavOwner([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true);
        expect(sameNavOwner([1, 2, 3, 4], [1, 2])).toBe(true);
        expect(sameNavOwner([1, 2, 3, 4], [4, 5, 6, 7])).toBe(false);
        expect(sameNavOwner([], [1])).toBe(false);
    });
});

describe("keyboard", () => {
    const base = { typing: false, modalOpen: false };

    it("Escape goes one level up from levels 2 and 3, never past level 1", () => {
        expect(explorerKeyAction({ ...base, key: 'Escape', level: 3 })).toBe('up');
        expect(explorerKeyAction({ ...base, key: 'Escape', level: 2 })).toBe('up');
        expect(explorerKeyAction({ ...base, key: 'Escape', level: 1 })).toBeNull();
    });

    it("the arrows walk the rooms on level 3 only", () => {
        expect(explorerKeyAction({ ...base, key: 'ArrowLeft', level: 3 })).toBe('prev');
        expect(explorerKeyAction({ ...base, key: 'ArrowRight', level: 3 })).toBe('next');
        expect(explorerKeyAction({ ...base, key: 'ArrowRight', level: 2 })).toBeNull();
        expect(explorerKeyAction({ ...base, key: 'Enter', level: 3 })).toBeNull();
    });

    it("does nothing while typing, with a modal open, with a modifier, or once someone else handled the key", () => {
        for (const extra of [{ typing: true }, { modalOpen: true }, { modified: true }, { defaultPrevented: true }, { composing: true }]) {
            expect(explorerKeyAction({ ...base, ...extra, key: 'Escape', level: 3 })).toBeNull();
            expect(explorerKeyAction({ ...base, ...extra, key: 'ArrowLeft', level: 3 })).toBeNull();
        }
    });

    it("recognises the targets where keys belong to the control", () => {
        expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
        expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
        expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
        expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
        expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe("who may go where", () => {
    const r1 = room({ id: 1, capacity: 2, occupants: [person(1, 'Ana', 'Ruiz')] });
    const r2 = room({ id: 2, capacity: 1, occupants: [person(2, 'Luis', 'Gómez', { family_group: 'Gómez' })] });
    const r3 = room({ id: 3, capacity: 2, occupied: 2, occupants: [person(3, 'Eva', 'Sanz')] }); // one stray bed
    const rooms = [r1, r2, r3];
    const unassigned = [person(10, 'Pedro', 'Gómez', { family_group: 'Gómez' }), person(11, 'Rosa', 'Díaz')];

    it("offers the unassigned and the people of OTHER rooms for a free bed — exactly what dragDecision accepts", () => {
        const c = assignCandidates({ roomId: 1, rooms, unassigned });
        expect(c.blocked).toBeNull();
        expect(c.unassigned.map((x) => x.attendee.id)).toEqual([10, 11]);
        expect(c.elsewhere.map((x) => [x.attendee.id, x.fromRoom?.id])).toEqual([[2, 2], [3, 3]]);
        for (const x of [...c.unassigned, ...c.elsewhere]) {
            expect(dragDecision({ attendeeId: Number(x.attendee.id), fromRoomId: x.fromRoom ? Number(x.fromRoom.id) : null, toRoomId: 1, rooms, unassigned }).ok).toBe(true);
        }
    });

    it("searches the candidates by name or family group", () => {
        const c = assignCandidates({ roomId: 1, rooms, unassigned, query: 'gomez' });
        expect(c.unassigned.map((x) => x.attendee.id)).toEqual([10]);
        expect(c.elsewhere.map((x) => x.attendee.id)).toEqual([2]);
    });

    it("blocks a full room (a stray's bed counts) and an unknown one", () => {
        expect(assignCandidates({ roomId: 2, rooms, unassigned })).toEqual({ blocked: 'full', unassigned: [], elsewhere: [] });
        expect(assignCandidates({ roomId: 3, rooms, unassigned }).blocked).toBe('full');
        expect(assignCandidates({ roomId: 99, rooms, unassigned }).blocked).toBe('unknown');
    });

    it("gives the room picker a verdict per room", () => {
        const t = moveTargets({ attendeeId: 2, fromRoomId: 2, rooms, unassigned });
        expect(t.map((x) => [x.room.id, x.verdict])).toEqual([[1, 'ok'], [2, 'same'], [3, 'full']]);
        const u = moveTargets({ attendeeId: 10, fromRoomId: null, rooms, unassigned });
        expect(u.map((x) => x.verdict)).toEqual(['ok', 'full', 'full']);
    });

    it("lists in the room picker only the rooms that can take the attendee (and theirs); the full ones on demand", () => {
        const hotels = groupRoomsByHotel([
            room({ id: 1, hotel_name: 'Hotel Sol', room_number: '101', capacity: 2, occupants: [person(1, 'Ana', 'Ruiz')] }),
            room({ id: 2, hotel_name: 'Hotel Sol', room_number: '102', capacity: 1, occupants: [person(2, 'Luis', 'Gómez')] }),
            room({ id: 3, hotel_name: 'Hostal Luna', room_number: '7', capacity: 1, occupants: [person(3, 'Eva', 'Sanz')] }),
            room({ id: 4, hotel_name: 'Hostal Luna', room_number: '8', capacity: 2, occupants: [], is_family: 1, family_name: 'Gómez' }),
        ]);
        const all = hotels.flatMap((h) => h.rooms);
        const targets = moveTargets({ attendeeId: 2, fromRoomId: 2, rooms: all, unassigned: [] });
        const ids = (v: ReturnType<typeof roomPickerView>) => v.hotels.map((h) => [h.name, h.rooms.map((t) => [t.room.id, t.verdict])]);

        const byDefault = roomPickerView({ hotels, targets });
        expect(ids(byDefault)).toEqual([['Hotel Sol', [[1, 'ok'], [2, 'same']]], ['Hostal Luna', [[4, 'ok']]]]);
        expect(byDefault.hidden).toBe(1); // room 7 is full
        expect(byDefault.hotels[0].free).toBe(1);

        const everything = roomPickerView({ hotels, targets, showFull: true });
        expect(everything.hidden).toBe(0);
        expect(everything.hotels.flatMap((h) => h.rooms.map((t) => t.verdict))).toEqual(['ok', 'same', 'full', 'ok']);

        // Search by room number, by the hotel's name, by a family room's name (accent-insensitive).
        expect(ids(roomPickerView({ hotels, targets, query: '10' }))).toEqual([['Hotel Sol', [[1, 'ok'], [2, 'same']]]]);
        expect(ids(roomPickerView({ hotels, targets, query: 'luna' }))).toEqual([['Hostal Luna', [[4, 'ok']]]]);
        expect(roomPickerView({ hotels, targets, query: 'luna' }).hidden).toBe(1);
        expect(ids(roomPickerView({ hotels, targets, query: 'GOMEZ' }))).toEqual([['Hostal Luna', [[4, 'ok']]]]);
        expect(roomPickerView({ hotels, targets, query: 'zzz' })).toEqual({ hotels: [], hidden: 0 });
    });

    it("finds an attendee and their room", () => {
        expect(roomOfAttendee(rooms, 2)?.id).toBe(2);
        expect(roomOfAttendee(rooms, 10)).toBeNull();
        expect(findAttendee(rooms, unassigned, 3)?.first_name).toBe('Eva');
        expect(findAttendee(rooms, unassigned, 11)?.first_name).toBe('Rosa');
        expect(findAttendee(rooms, unassigned, 404)).toBeNull();
    });
});

describe("readOnlyReason", () => {
    const editableGate = (d: LodgingData) => {
        const s = String(d.status ?? 'draft');
        return (s !== 'submitted' && s !== 'validated') && d.can_edit !== false;
    };
    const cases: LodgingData[] = [
        { status: 'draft', can_edit: true },
        { status: null },
        { status: 'submitted', can_edit: false },
        { status: 'submitted', can_edit: false, deadline: '2026-01-01', deadline_passed: true },
        { status: 'validated', can_edit: false },
        { status: 'draft', can_edit: false, deadline: '2026-01-01', deadline_passed: true },
        { status: 'draft', can_edit: false, deadline: '2026-01-01', deadline_passed: true, permission: { active: false, expired: true, until: '2026-01-05' } },
        { status: 'draft', can_edit: false },
    ];

    it("is null exactly when the tab's edit gate is open", () => {
        for (const d of cases) expect(readOnlyReason(d) === null).toBe(editableGate(d));
    });

    it("explains each closed state in plain Spanish", () => {
        expect(readOnlyReason({ status: 'submitted', can_edit: false })).toMatch(/Retirar envío/);
        expect(readOnlyReason({ status: 'submitted', can_edit: false, deadline: '2026-01-01', deadline_passed: true })).toMatch(/plazo ya venció/);
        expect(readOnlyReason({ status: 'validated' })).toMatch(/validó/);
        expect(readOnlyReason({ status: 'draft', can_edit: false, deadline: '2026-01-01', deadline_passed: true })).toBe('Solo lectura: venció el plazo para acomodar los hospedajes.');
        expect(readOnlyReason({ status: 'draft', can_edit: false })).toMatch(/no se puede modificar/);
    });

    it("never repeats the sentence the status hero above already shows", () => {
        // The hero prints deadlineMessage(d) whenever there is a deadline, and «pide al administrador
        // reabrir» once validated: the explorer's notice is a short pointer for those states.
        for (const d of cases) {
            const reason = readOnlyReason(d);
            const hero = deadlineMessage(d);
            if (reason && hero) expect(reason).not.toBe(hero);
        }
        expect(readOnlyReason({ status: 'validated' })).not.toMatch(/reabr/);
    });
});

describe("occupant fields", () => {
    const fields = [
        { name: 'first_name', label: 'Nombre' },
        { name: 'email', label: 'Correo', type: 'email' },
        { name: 'telefono', label: 'Teléfono', type: 'text' },
        { name: 'document_number', label: 'Documento' },
        { name: 'diet', label: 'Dieta' },
        { name: 'needs_parking', label: 'Parqueadero', type: 'checkbox' },
        { name: 'arrival', label: 'Llegada', type: 'date' },
        { name: 'langs', label: 'Idiomas' },
        { name: 'gender', label: 'Género' },
        { name: 'family_group', label: 'Grupo familiar' },
        { name: 'email', label: 'Correo (duplicado)' },
    ];
    const a = person(1, 'Ana', 'Ruiz', {
        gender: 'F', family_group: 'Ruiz',
        email: 'ana@example.com', telefono: '+57 300 123 4567', document_number: '1020', diet: '  ',
        needs_parking: '1', arrival: '2026-10-12', langs: '["es","en"]',
    });

    it("lists every non-empty field with its label, in the form's order, without the card's own columns", () => {
        const e = fieldEntries(a, fields);
        expect(e.map((x) => [x.label, x.value])).toEqual([
            ['Correo', 'ana@example.com'],
            ['Teléfono', '+57 300 123 4567'],
            ['Documento', '1020'],
            ['Parqueadero', 'Sí'],
            ['Llegada', '12/10/2026'],
            ['Idiomas', 'es, en'],
        ]);
    });

    it("links an e-mail and a phone only when the value really is one", () => {
        const e = fieldEntries(a, fields);
        expect(e[0]).toMatchObject({ kind: 'email', href: 'mailto:ana@example.com' });
        expect(e[1]).toMatchObject({ kind: 'tel', href: 'tel:+573001234567' });
        const bad = fieldEntries(person(2, 'B', 'C', { email: 'no es un correo', telefono: 'n/a' }), fields);
        expect(bad.map((x) => x.kind)).toEqual(['text', 'text']);
    });

    it("formats values: nothing, booleans, checkbox words, lists, objects, dates", () => {
        expect(fieldDisplayValue(null)).toBe('');
        expect(fieldDisplayValue('   ')).toBe('');
        expect(fieldDisplayValue(true)).toBe('Sí');
        expect(fieldDisplayValue('no', 'checkbox')).toBe('No');
        expect(fieldDisplayValue('Sí', 'checkbox')).toBe('Sí');
        expect(fieldDisplayValue(['a', null, 'b'])).toBe('a, b');
        expect(fieldDisplayValue({ x: 1 })).toBe('');
        expect(fieldDisplayValue('[not json')).toBe('[not json');
        expect(fieldDisplayValue('2026-10-12', 'date')).toBe('12/10/2026');
        expect(fieldDisplayValue('2026-10-12')).toBe('2026-10-12');
        expect(fieldDisplayValue(0)).toBe('0');
    });

    it("tolerates missing input", () => {
        expect(fieldEntries(null, fields)).toEqual([]);
        expect(fieldEntries(a, null)).toEqual([]);
    });
});
