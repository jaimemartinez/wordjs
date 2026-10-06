/**
 * Pure helpers behind the coordinator portal's lodging EXPLORER (Hoteles › Hotel › Habitación) — no
 * React, no fetch, no DOM. Everything the explorer decides (how rooms group into hotels, the numbers
 * on each card, which rooms a filter keeps, where «Anterior / Siguiente» lead, who may fill a free bed,
 * what the remembered navigation resolves to, which key does what) lives here so it is unit-tested.
 *
 * THE PORTAL PAYLOAD (GET /portal/lodging, conference-manager ≥ 2.5.0) carries no hotel id: every room
 * has `hotel_name`, so hotels are derived by grouping rooms by that name (trimmed). Rooms carry no
 * gender, notes or location (they are all the coordinator's own); occupants carry id, first/last name,
 * gender, family_group and the conference's field columns flat on the row. `occupied` is the server's
 * count and may exceed the listed occupants: the server counts EVERY inscription in the room, but the
 * portal lists only the location's own non-cancelled attendees, so a bed held by another location's
 * attendee or by a cancelled inscription is counted and never listed — the explorer shows such beds as
 * taken (never as free) without claiming which of the two it is.
 */
import {
    attendeeName,
    canEditLodging,
    deadlineState,
    dragDecision,
    freeBeds,
    normalizeLodgingStatus,
    type DragRefusal,
    type LodgingAttendee,
    type LodgingData,
    type LodgingField,
    type LodgingRoom,
} from "./lodging";

// ---------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------

/** A non-negative integer from whatever the server sent; garbage/missing → `fallback`. */
const count = (v: unknown, fallback = 0): number => {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** Lower-case, accent-free, trimmed — so «Pérez» is found by «perez» and «PEREZ». */
export const normalizeSearch = (v: unknown): string =>
    String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Natural order for room numbers: «2» before «10», «101A» after «101». */
export const compareRoomNumbers = (a: unknown, b: unknown): number =>
    String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric: true, sensitivity: 'base' });

/** The listed occupants of a room (defensive: a missing or malformed list is empty). */
export const roomOccupants = (room: LodgingRoom | null | undefined): LodgingAttendee[] =>
    (Array.isArray(room?.occupants) ? room.occupants : []).filter((a): a is LodgingAttendee => !!a && typeof a === 'object');

// ---------------------------------------------------------------------------------------------------
// Hotels (derived from the rooms)
// ---------------------------------------------------------------------------------------------------

export const UNNAMED_HOTEL = 'Hotel sin nombre';

export type HotelGroup = {
    /** The trimmed `hotel_name` ('' when the payload has none) — the navigation key. */
    key: string;
    /** What the UI prints. */
    name: string;
    /** The hotel's rooms in natural room-number order. */
    rooms: LodgingRoom[];
};

/** The hotel key of a room: its trimmed `hotel_name`. */
export const hotelKeyOf = (room: { hotel_name?: unknown } | null | undefined): string =>
    String(room?.hotel_name ?? '').trim();

/**
 * Rooms grouped into hotels by `hotel_name`, hotels in first-appearance order (the server sorts by
 * hotel name), rooms inside a hotel in natural room-number order (then id, so the order is stable).
 */
export const groupRoomsByHotel = (rooms: LodgingRoom[] | null | undefined): HotelGroup[] => {
    const groups = new Map<string, HotelGroup>();
    for (const room of Array.isArray(rooms) ? rooms : []) {
        if (!room || typeof room !== 'object') continue;
        const key = hotelKeyOf(room);
        let g = groups.get(key);
        if (!g) { g = { key, name: key || UNNAMED_HOTEL, rooms: [] }; groups.set(key, g); }
        g.rooms.push(room);
    }
    const list = [...groups.values()];
    for (const g of list) {
        g.rooms.sort((a, b) => compareRoomNumbers(a.room_number, b.room_number) || Number(a.id) - Number(b.id));
    }
    return list;
};

// ---------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------

/** 'full' = no free bed (a room without beds too), 'empty' = nobody in it, 'partial' = some beds taken, some free. */
export type Occupancy = 'empty' | 'partial' | 'full';

export type RoomStats = {
    capacity: number;
    /** Beds taken as the server counts them (falls back to the listed occupants). */
    occupied: number;
    free: number;
    /** Occupants listed in the payload (the coordinator's own attendees). */
    listed: number;
    /**
     * Beds taken by people the payload does not list: another location's attendee or a cancelled
     * inscription that still holds the bed (the payload cannot tell which) — only the admin frees them.
     */
    unlisted: number;
    /** 0–100, for the capacity bar. */
    percent: number;
    occupancy: Occupancy;
};

export const roomStats = (room: LodgingRoom | null | undefined): RoomStats => {
    const listed = roomOccupants(room).length;
    const capacity = count(room?.capacity);
    const occupied = count(room?.occupied, listed);
    const free = freeBeds(room);
    const occupancy: Occupancy = free === 0 ? 'full' : occupied === 0 ? 'empty' : 'partial';
    return {
        capacity,
        occupied,
        free,
        listed,
        unlisted: Math.max(0, occupied - listed),
        percent: capacity > 0 ? Math.min(100, Math.round((occupied / capacity) * 100)) : (occupied > 0 ? 100 : 0),
        occupancy,
    };
};

export type HotelStats = {
    rooms: number;
    beds: number;
    occupied: number;
    free: number;
    /** Listed occupants (the coordinator's own attendees) across the hotel. */
    people: number;
    /** `full` + `partial` + `empty` === `rooms`: the hotel card's breakdown is a partition. */
    full: number;
    /** Rooms with somebody in them AND a free bed. */
    partial: number;
    empty: number;
    /** Rooms with at least one free bed (`partial` + `empty` — what the «Con camas libres» filter keeps). */
    withFree: number;
    percent: number;
};

/** The numbers of a set of rooms (a hotel, or every room for the summary strip). */
export const hotelStats = (rooms: LodgingRoom[] | null | undefined): HotelStats => {
    const list = Array.isArray(rooms) ? rooms : [];
    const s: HotelStats = { rooms: list.length, beds: 0, occupied: 0, free: 0, people: 0, full: 0, partial: 0, empty: 0, withFree: 0, percent: 0 };
    for (const r of list) {
        const st = roomStats(r);
        s.beds += st.capacity;
        s.occupied += st.occupied;
        s.free += st.free;
        s.people += st.listed;
        if (st.occupancy === 'full') s.full++;
        else if (st.occupancy === 'partial') s.partial++;
        else s.empty++;
        if (st.free > 0) s.withFree++;
    }
    s.percent = s.beds > 0 ? Math.min(100, Math.round((s.occupied / s.beds) * 100)) : (s.occupied > 0 ? 100 : 0);
    return s;
};

/** `1 habitación` / `3 habitaciones` (and the same shape for other nouns). */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A room inside a Spanish sentence: «habitación 101 (Hotel Sol)» — `roomLabel`'s «Hotel Sol · 101» is a
 * label, and «dejará la habitación Hotel Sol · 101» does not read. Without a number, the label is used.
 */
export const roomPhrase = (room: { hotel_name?: unknown; room_number?: unknown } | null | undefined): string => {
    const num = String(room?.room_number ?? '').trim();
    const hotel = String(room?.hotel_name ?? '').trim();
    if (!num) return hotel ? `habitación de ${hotel}` : 'habitación';
    return hotel ? `habitación ${num} (${hotel})` : `habitación ${num}`;
};

// ---------------------------------------------------------------------------------------------------
// Gender (the attendee's own value, which the conference's form may spell in many ways)
// ---------------------------------------------------------------------------------------------------

export type GenderKey = 'M' | 'F' | '';

const FEMALE = new Set(['f', 'fem', 'femenino', 'femenina', 'female', 'mujer', 'woman', 'w', 'feminino', 'mulher']);
const MALE = new Set(['m', 'masc', 'masculino', 'male', 'hombre', 'man', 'h', 'varon', 'homem']);

/** 'F' / 'M' / '' (unknown). «Mujer» is F even though it starts with an M. */
export const genderKey = (v: unknown): GenderKey => {
    const s = normalizeSearch(v);
    if (!s) return '';
    if (FEMALE.has(s) || s.startsWith('fem') || s.startsWith('muj')) return 'F';
    if (MALE.has(s) || s.startsWith('masc') || s.startsWith('homb') || s.startsWith('var')) return 'M';
    return '';
};

/** What the occupant card prints: a single letter becomes a word; any other value is shown as the form spells it. */
export const genderLabel = (v: unknown): string => {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    if (raw.length > 1) return raw;
    const k = genderKey(raw);
    return k === 'F' ? 'Mujer' : k === 'M' ? 'Hombre' : raw;
};

/** The make-up of a room by its listed occupants' genders: 'none' when nobody (with a known gender) is in it. */
export type RoomGender = 'M' | 'F' | 'mixed' | 'none';

export const roomGender = (room: LodgingRoom | null | undefined): RoomGender => {
    let m = false, f = false;
    for (const a of roomOccupants(room)) {
        const k = genderKey(a.gender);
        if (k === 'M') m = true; else if (k === 'F') f = true;
    }
    return m && f ? 'mixed' : m ? 'M' : f ? 'F' : 'none';
};

// ---------------------------------------------------------------------------------------------------
// Filters (level 2) and «Anterior / Siguiente» (level 3)
// ---------------------------------------------------------------------------------------------------

export const OCCUPANCY_FILTERS = ['all', 'free', 'full', 'empty'] as const;
export type OccupancyFilter = typeof OCCUPANCY_FILTERS[number];
export const GENDER_FILTERS = ['all', 'M', 'F', 'mixed'] as const;
export type GenderFilter = typeof GENDER_FILTERS[number];

export const OCCUPANCY_LABELS: Record<OccupancyFilter, string> = {
    all: 'Todas',
    free: 'Con camas libres',
    full: 'Llenas',
    empty: 'Vacías',
};

export const GENDER_FILTER_LABELS: Record<GenderFilter, string> = {
    all: 'Todos los ocupantes',
    M: 'Solo hombres',
    F: 'Solo mujeres',
    // The select is labelled «Ocupantes», so the option names people, not rooms («Mixtas»).
    mixed: 'Hombres y mujeres',
};

export type RoomFilters = { query: string; occupancy: OccupancyFilter; gender: GenderFilter };

export const DEFAULT_FILTERS: RoomFilters = { query: '', occupancy: 'all', gender: 'all' };

export const filtersActive = (f: RoomFilters): boolean =>
    normalizeSearch(f.query) !== '' || f.occupancy !== 'all' || f.gender !== 'all';

/** Whether a search text finds a room: its number, the family name of a family room, or an occupant's name or family group. */
export const roomMatchesQuery = (room: LodgingRoom, query: unknown): boolean => {
    const q = normalizeSearch(query);
    if (!q) return true;
    if (normalizeSearch(room.room_number).includes(q)) return true;
    if (normalizeSearch(room.family_name).includes(q)) return true;
    return roomOccupants(room).some((a) => normalizeSearch(attendeeName(a)).includes(q) || normalizeSearch(a.family_group).includes(q));
};

export const roomMatchesOccupancy = (room: LodgingRoom, occupancy: OccupancyFilter): boolean => {
    if (occupancy === 'all') return true;
    const st = roomStats(room);
    if (occupancy === 'free') return st.free > 0;
    return st.occupancy === occupancy;
};

export const roomMatchesGender = (room: LodgingRoom, gender: GenderFilter): boolean =>
    gender === 'all' || roomGender(room) === gender;

export const roomMatchesFilters = (room: LodgingRoom, f: RoomFilters): boolean =>
    roomMatchesQuery(room, f.query) && roomMatchesOccupancy(room, f.occupancy) && roomMatchesGender(room, f.gender);

export const filterRooms = (rooms: LodgingRoom[] | null | undefined, f: RoomFilters): LodgingRoom[] =>
    (Array.isArray(rooms) ? rooms : []).filter((r) => roomMatchesFilters(r, f));

/** How many rooms each occupancy chip would show (the search and gender filters applied, the occupancy one not). */
export const occupancyCounts = (rooms: LodgingRoom[] | null | undefined, f: RoomFilters): Record<OccupancyFilter, number> => {
    const base = (Array.isArray(rooms) ? rooms : []).filter((r) => roomMatchesQuery(r, f.query) && roomMatchesGender(r, f.gender));
    return {
        all: base.length,
        free: base.filter((r) => roomMatchesOccupancy(r, 'free')).length,
        full: base.filter((r) => roomMatchesOccupancy(r, 'full')).length,
        empty: base.filter((r) => roomMatchesOccupancy(r, 'empty')).length,
    };
};

export type RoomNeighbours = { prev: LodgingRoom | null; next: LodgingRoom | null; index: number; total: number };

/**
 * Where «Anterior / Siguiente» lead from `currentId` inside a hotel's rooms, walking only the rooms the
 * current filters keep. The current room always belongs to the walk even when the filters would drop
 * it (filling its last bed under «Con camas libres» must not strand the user). No wrap-around.
 */
export const roomNeighbours = (hotelRooms: LodgingRoom[] | null | undefined, currentId: number | null, f: RoomFilters): RoomNeighbours => {
    const walk = (Array.isArray(hotelRooms) ? hotelRooms : []).filter((r) => Number(r.id) === currentId || roomMatchesFilters(r, f));
    const index = walk.findIndex((r) => Number(r.id) === currentId);
    if (index < 0) return { prev: null, next: null, index: -1, total: walk.length };
    return {
        prev: index > 0 ? walk[index - 1] : null,
        next: index < walk.length - 1 ? walk[index + 1] : null,
        index,
        total: walk.length,
    };
};

// ---------------------------------------------------------------------------------------------------
// Navigation state (remembered per tab in sessionStorage by the component)
// ---------------------------------------------------------------------------------------------------

export type ExplorerNav = RoomFilters & {
    /** The open hotel's key (`HotelGroup.key`); null = level 1. */
    hotel: string | null;
    /** The open room's id; null = level 2 (or 1). */
    room: number | null;
};

export const EMPTY_NAV: ExplorerNav = { hotel: null, room: null, ...DEFAULT_FILTERS };

export type ExplorerLevel = 1 | 2 | 3;

const MAX_HOTEL_KEY = 300;
const MAX_QUERY = 100;

/**
 * A navigation state from anything (a JSON string read back from sessionStorage, an object, garbage).
 * Every field is validated on its own: one bad field never discards the others; a room without a
 * hotel is dropped (it cannot be resolved).
 */
export const parseExplorerNav = (raw: unknown): ExplorerNav => {
    let src: unknown = raw;
    if (typeof raw === 'string') {
        try { src = JSON.parse(raw); } catch { return { ...EMPTY_NAV }; }
    }
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { ...EMPTY_NAV };
    const o = src as Record<string, unknown>;
    const hotel = typeof o.hotel === 'string' && o.hotel.length <= MAX_HOTEL_KEY ? o.hotel : null;
    const roomNum = Number(o.room);
    const room = hotel !== null && o.room != null && o.room !== '' && Number.isSafeInteger(roomNum) && roomNum > 0 ? roomNum : null;
    const query = typeof o.query === 'string' ? o.query.slice(0, MAX_QUERY) : '';
    const occupancy = (OCCUPANCY_FILTERS as readonly unknown[]).includes(o.occupancy) ? o.occupancy as OccupancyFilter : 'all';
    const gender = (GENDER_FILTERS as readonly unknown[]).includes(o.gender) ? o.gender as GenderFilter : 'all';
    return { hotel, room, query, occupancy, gender };
};

export type ResolvedNav = { level: ExplorerLevel; hotel: HotelGroup | null; room: LodgingRoom | null };

/**
 * What a navigation state points at in the CURRENT payload: a hotel that no longer exists falls back
 * to level 1, a room that is no longer in its hotel (the admin took it away) to level 2.
 */
export const resolveExplorerNav = (nav: Pick<ExplorerNav, 'hotel' | 'room'>, hotels: HotelGroup[]): ResolvedNav => {
    const hotel = nav.hotel === null ? null : hotels.find((h) => h.key === nav.hotel) || null;
    if (!hotel) return { level: 1, hotel: null, room: null };
    const room = nav.room === null ? null : hotel.rooms.find((r) => Number(r.id) === nav.room) || null;
    return room ? { level: 3, hotel, room } : { level: 2, hotel, room: null };
};

/**
 * The navigation state cut down to what `resolveExplorerNav` can still show: a room that is gone is
 * forgotten (and the hotel too when it is gone), so a stale id is never kept in memory or in the
 * session to pull the user back into that room the day the admin hands it back. The SAME object is
 * returned when nothing changes (the component compares by identity). The filters are kept.
 */
export const normalizeExplorerNav = (nav: ExplorerNav, hotels: HotelGroup[]): ExplorerNav => {
    const { level, hotel } = resolveExplorerNav(nav, hotels);
    if (nav.hotel !== null && !hotel) return { ...nav, hotel: null, room: null };
    if (nav.room !== null && level !== 3) return { ...nav, room: null };
    return nav;
};

// Whose position it is. The portal payload names no location, but every room is allotted to exactly
// ONE location, so the set of room ids identifies the coordinator's location. A remembered position
// carries that set; read back against another location's payload (a second coordinator logging in in
// the same browser tab — sessionStorage survives a logout) it is ignored instead of opening the
// previous coordinator's hotel with their search text.

const MAX_OWNER_ROOMS = 2000;

/** The rooms a remembered position belongs to: the payload's room ids, unique and sorted. */
export const navOwner = (rooms: LodgingRoom[] | null | undefined): number[] => {
    const ids = new Set<number>();
    for (const r of Array.isArray(rooms) ? rooms : []) {
        const id = Number(r?.id);
        if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b).slice(0, MAX_OWNER_ROOMS);
};

/**
 * Whether two room sets are the same location's: at least half of their union is shared. The admin
 * adding or taking away a few rooms keeps the position; another location's set (which can share a
 * room only if the admin re-allotted an empty one) does not. An empty set never matches.
 */
export const sameNavOwner = (a: readonly number[], b: readonly number[]): boolean => {
    const sa = new Set(a), sb = new Set(b);
    if (sa.size === 0 || sb.size === 0) return false;
    let shared = 0;
    for (const id of sb) if (sa.has(id)) shared++;
    return shared * 2 >= new Set([...sa, ...sb]).size;
};

/** What is written to sessionStorage: the position plus the rooms it belongs to. */
export type StoredExplorerNav = ExplorerNav & { owner: number[] };

export const navRecord = (nav: ExplorerNav, owner: readonly number[]): StoredExplorerNav => ({
    hotel: nav.hotel, room: nav.room, query: nav.query, occupancy: nav.occupancy, gender: nav.gender, owner: [...owner],
});

/**
 * A remembered position read back (a JSON string from sessionStorage, an object, garbage) for the
 * payload whose rooms are `owner`: a record written for other rooms, or without an owner, is ignored.
 */
export const restoreExplorerNav = (raw: unknown, owner: readonly number[]): ExplorerNav => {
    let src: unknown = raw;
    if (typeof raw === 'string') {
        try { src = JSON.parse(raw); } catch { return { ...EMPTY_NAV }; }
    }
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { ...EMPTY_NAV };
    const stored = (src as { owner?: unknown }).owner;
    const ids = Array.isArray(stored)
        ? stored.slice(0, MAX_OWNER_ROOMS).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
        : [];
    return sameNavOwner(ids, owner) ? parseExplorerNav(src) : { ...EMPTY_NAV };
};

/** The hotel a room id lives in (to open a room found outside the current hotel). */
export const hotelOfRoom = (hotels: HotelGroup[], roomId: number): HotelGroup | null =>
    hotels.find((h) => h.rooms.some((r) => Number(r.id) === roomId)) || null;

// ---------------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------------

export type ExplorerKeyAction = 'up' | 'prev' | 'next' | null;

/** A key target where the user is typing or choosing: keys there belong to the control, never to the explorer. */
export const isTypingTarget = (t: { tagName?: unknown; isContentEditable?: unknown } | null | undefined): boolean => {
    if (!t) return false;
    const tag = String(t.tagName ?? '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
};

/**
 * What a keydown does in the explorer: `Escape` goes one level up (levels 2 and 3), `←` / `→` walk the
 * rooms (level 3). Nothing while a modal is open (its own Escape closes it), while the focus is in a
 * text field / select, with a modifier held (browser shortcuts such as Alt+← stay the browser's), or
 * when someone else already handled the key.
 */
export const explorerKeyAction = (e: {
    key: string;
    level: ExplorerLevel;
    typing: boolean;
    modalOpen: boolean;
    modified?: boolean;
    defaultPrevented?: boolean;
    composing?: boolean;
}): ExplorerKeyAction => {
    if (e.modalOpen || e.typing || e.modified || e.defaultPrevented || e.composing) return null;
    if (e.key === 'Escape') return e.level > 1 ? 'up' : null;
    if (e.level !== 3) return null;
    if (e.key === 'ArrowLeft') return 'prev';
    if (e.key === 'ArrowRight') return 'next';
    return null;
};

// ---------------------------------------------------------------------------------------------------
// Who may go where (the same rules as the drag & drop: dragDecision; the server re-validates)
// ---------------------------------------------------------------------------------------------------

export type AssignCandidate = { attendee: LodgingAttendee; fromRoom: LodgingRoom | null };

export type AssignCandidates = {
    /** Why nobody may go into the room (null = the lists below apply). */
    blocked: 'full' | 'unknown' | null;
    /** Attendees without a room who may take a bed here. */
    unassigned: AssignCandidate[];
    /** Attendees in ANOTHER of the location's rooms who may be moved here. */
    elsewhere: AssignCandidate[];
};

const candidateMatches = (a: LodgingAttendee, q: string): boolean =>
    !q || normalizeSearch(attendeeName(a)).includes(q) || normalizeSearch(a.family_group).includes(q);

/**
 * The attendees a free bed of `roomId` may take, searchable by name or family group. The portal only
 * ever lists the location's own, non-cancelled attendees and every room is the location's own, so the
 * rules reduce to `dragDecision`: the room must exist and have a free bed; an attendee already in it
 * is not a candidate. Whether the arrangement may be edited at all is the caller's gate.
 */
export const assignCandidates = ({ roomId, rooms, unassigned, query = '' }: {
    roomId: number;
    rooms: LodgingRoom[] | null | undefined;
    unassigned: LodgingAttendee[] | null | undefined;
    query?: string;
}): AssignCandidates => {
    const list = Array.isArray(rooms) ? rooms : [];
    const target = list.find((r) => Number(r.id) === roomId);
    if (!target) return { blocked: 'unknown', unassigned: [], elsewhere: [] };
    if (freeBeds(target) <= 0) return { blocked: 'full', unassigned: [], elsewhere: [] };
    const q = normalizeSearch(query);
    const pool = Array.isArray(unassigned) ? unassigned : [];
    const ok = (attendeeId: number, fromRoomId: number | null) =>
        dragDecision({ attendeeId, fromRoomId, toRoomId: roomId, rooms: list, unassigned: pool }).ok;
    const fromPool = pool
        .filter((a) => a && candidateMatches(a, q) && ok(Number(a.id), null))
        .map((attendee) => ({ attendee, fromRoom: null }));
    const elsewhere: AssignCandidate[] = [];
    for (const r of list) {
        if (Number(r.id) === roomId) continue;
        for (const a of roomOccupants(r)) {
            if (candidateMatches(a, q) && ok(Number(a.id), Number(r.id))) elsewhere.push({ attendee: a, fromRoom: r });
        }
    }
    return { blocked: null, unassigned: fromPool, elsewhere };
};

export type MoveTarget = { room: LodgingRoom; verdict: 'ok' | DragRefusal };

/**
 * Every room of the location with the verdict for moving `attendeeId` (currently in `fromRoomId`, null =
 * without a room) into it — the room picker's buttons: 'ok', 'same' (it is already there), 'full'.
 */
export const moveTargets = ({ attendeeId, fromRoomId, rooms, unassigned }: {
    attendeeId: number;
    fromRoomId: number | null;
    rooms: LodgingRoom[] | null | undefined;
    unassigned: LodgingAttendee[] | null | undefined;
}): MoveTarget[] => {
    const list = Array.isArray(rooms) ? rooms : [];
    return list.map((room) => {
        const d = dragDecision({ attendeeId, fromRoomId, toRoomId: Number(room.id), rooms: list, unassigned });
        return { room, verdict: d.ok ? 'ok' : d.reason };
    });
};

export type RoomPickerHotel = { key: string; name: string; free: number; rooms: MoveTarget[] };

export type RoomPickerView = {
    /** The hotels with at least one room to show, in the explorer's order. */
    hotels: RoomPickerHotel[];
    /** Rooms that match the search but are hidden because they cannot take the attendee (full). */
    hidden: number;
};

/**
 * What the room picker lists: by default only the rooms that can take the attendee ('ok') and the
 * one they are in ('same', for orientation) — the full ones are counted in `hidden` behind a toggle,
 * so a location with 35 full rooms of 40 does not scroll through 35 disabled tiles. The search finds
 * a room by its number, its family name or its hotel's name; hotels left without rooms are dropped.
 */
export const roomPickerView = ({ hotels, targets, query = '', showFull = false }: {
    hotels: HotelGroup[];
    targets: MoveTarget[];
    query?: string;
    showFull?: boolean;
}): RoomPickerView => {
    const verdicts = new Map(targets.map((t) => [Number(t.room.id), t.verdict]));
    const q = normalizeSearch(query);
    let hidden = 0;
    const out: RoomPickerHotel[] = [];
    for (const h of Array.isArray(hotels) ? hotels : []) {
        const hotelHit = q !== '' && normalizeSearch(h.name).includes(q);
        const list: MoveTarget[] = [];
        for (const room of h.rooms) {
            if (q && !hotelHit && !normalizeSearch(room.room_number).includes(q) && !normalizeSearch(room.family_name).includes(q)) continue;
            const verdict = verdicts.get(Number(room.id)) ?? 'unknown';
            if (!showFull && verdict !== 'ok' && verdict !== 'same') { hidden++; continue; }
            list.push({ room, verdict });
        }
        if (list.length > 0) out.push({ key: h.key, name: h.name, free: hotelStats(h.rooms).free, rooms: list });
    }
    return { hotels: out, hidden };
};

/** Where an attendee is right now: the room that lists them, or null (without a room / unknown). */
export const roomOfAttendee = (rooms: LodgingRoom[] | null | undefined, attendeeId: number): LodgingRoom | null =>
    (Array.isArray(rooms) ? rooms : []).find((r) => roomOccupants(r).some((a) => Number(a.id) === attendeeId)) || null;

/** An attendee by id among the rooms' occupants and the unassigned list. */
export const findAttendee = (rooms: LodgingRoom[] | null | undefined, unassigned: LodgingAttendee[] | null | undefined, attendeeId: number): LodgingAttendee | null => {
    for (const r of Array.isArray(rooms) ? rooms : []) {
        const a = roomOccupants(r).find((x) => Number(x.id) === attendeeId);
        if (a) return a;
    }
    return (Array.isArray(unassigned) ? unassigned : []).find((a) => a && Number(a.id) === attendeeId) || null;
};

/** Unassigned attendees matching the side panel's search (name or family group). */
export const filterAttendees = (list: LodgingAttendee[] | null | undefined, query: unknown): LodgingAttendee[] => {
    const q = normalizeSearch(query);
    return (Array.isArray(list) ? list : []).filter((a) => a && candidateMatches(a, q));
};

// ---------------------------------------------------------------------------------------------------
// Read-only explanation (never a silent disabled button)
// ---------------------------------------------------------------------------------------------------

/**
 * Why the coordinator cannot change the arrangement right now, in plain Spanish — or null when they can.
 * Null exactly when the tab's own gate (`canEditLodging(status) && can_edit !== false`) lets them edit.
 *
 * It sits next to the explorer, and the tab's status hero above already spells out some of the states
 * in full (the deadline sentence with its date whenever the deadline has passed; «pide al administrador
 * reabrir» once validated). For those this is a SHORT pointer, never the same sentence twice; the
 * states the hero does not explain (submitted with the window open, an older plugin's bare
 * `can_edit: false`) get the full explanation here.
 */
export const readOnlyReason = (d: LodgingData | null | undefined): string | null => {
    const status = normalizeLodgingStatus(d?.status);
    const editable = canEditLodging(status) && d?.can_edit !== false;
    if (editable) return null;
    const passed = deadlineState(d) === 'passed';
    if (status === 'submitted') {
        return passed
            ? 'Solo lectura: el hospedaje está enviado a validación y el plazo ya venció.'
            : 'Enviaste el hospedaje a validación: solo puedes consultarlo. Usa «Retirar envío» para volver a acomodar.';
    }
    if (status === 'validated') return 'Solo lectura: el administrador validó el hospedaje.';
    if (passed) return 'Solo lectura: venció el plazo para acomodar los hospedajes.';
    return 'El hospedaje no se puede modificar en este momento. Solo el administrador puede cambiar la acomodación.';
};

// ---------------------------------------------------------------------------------------------------
// Occupant details (level 3: every conference field with its label)
// ---------------------------------------------------------------------------------------------------

/** Columns the occupant card shows on its own (name in the title; gender and family group as chips). */
const OWN_COLUMNS = new Set(['id', 'first_name', 'last_name', 'gender', 'family_group']);

const TRUE_WORDS = new Set(['1', 'true', 'on', 'si', 'yes', 'sim', 'y']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no', 'nao', 'n']);

/** A field value as text: '' for nothing to show; booleans and checkbox values as Sí/No; lists joined; bare dates as DD/MM/YYYY. */
export const fieldDisplayValue = (v: unknown, type?: unknown): string => {
    if (v == null) return '';
    const t = String(type ?? '').toLowerCase();
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (Array.isArray(v)) return v.map((x) => fieldDisplayValue(x)).filter(Boolean).join(', ');
    if (typeof v === 'object') return '';
    const s = String(v).trim();
    if (!s) return '';
    if (t === 'checkbox' || t === 'boolean') {
        const w = normalizeSearch(s);
        if (TRUE_WORDS.has(w)) return 'Sí';
        if (FALSE_WORDS.has(w)) return 'No';
    }
    if (s.startsWith('[') && s.endsWith(']')) {
        try {
            const parsed: unknown = JSON.parse(s);
            if (Array.isArray(parsed) && parsed.every((x) => x == null || typeof x !== 'object')) return fieldDisplayValue(parsed);
        } catch { /* not JSON — shown verbatim */ }
    }
    if (t === 'date') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    }
    return s;
};

export type FieldEntry = { name: string; label: string; value: string; kind: 'email' | 'tel' | 'text'; href?: string };

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/**
 * Every conference field of an occupant that has a value, with its label, in the form's order. An
 * e-mail becomes a mailto: link and a phone a tel: link (by field type or name, and only when the value
 * really looks like one). The name, gender and family group are left out (the card shows them itself).
 */
export const fieldEntries = (attendee: LodgingAttendee | null | undefined, fields: LodgingField[] | null | undefined): FieldEntry[] => {
    if (!attendee) return [];
    const out: FieldEntry[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!f || typeof f.name !== 'string' || !f.name.trim() || OWN_COLUMNS.has(f.name) || seen.has(f.name)) continue;
        seen.add(f.name);
        const value = fieldDisplayValue(attendee[f.name], f.type);
        if (!value) continue;
        const type = String(f.type ?? '').toLowerCase();
        const name = normalizeSearch(f.name);
        const label = String(f.label || f.name);
        if ((type === 'email' || /e-?mail|correo/.test(name)) && EMAIL_RE.test(value)) {
            out.push({ name: f.name, label, value, kind: 'email', href: `mailto:${value}` });
            continue;
        }
        const digits = value.replace(/[^\d+]/g, '');
        if ((type === 'tel' || type === 'phone' || /phone|telefono|celular|movil|whatsapp/.test(name)) && digits.replace(/\D/g, '').length >= 6) {
            out.push({ name: f.name, label, value, kind: 'tel', href: `tel:${digits}` });
            continue;
        }
        out.push({ name: f.name, label, value, kind: 'text' });
    }
    return out;
};
