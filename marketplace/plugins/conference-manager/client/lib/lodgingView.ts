/**
 * Lodging view helpers (2.13.0) — pure, framework-free functions shared by the admin page
 * (admin/page.tsx) and the lodging explorer (admin/LodgingExplorer.tsx): who sleeps where, room and
 * hotel occupancy, the drag & drop eligibility rules (the client-side mirror of the server's checks in
 * POST /inscriptions/:id/assign), the explorer's filters, its prev/next walk and its remembered place.
 *
 * NO imports on purpose: the unit checks bundle this file alone and run it under plain node.
 * The structural types below are the subset of lib/conference.ts the helpers read, so the real
 * Inscription / Hotel / Room / Location / ConferenceField rows satisfy them as they are.
 */

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface LvLocation {
    id: number;
    name: string;
    lodging_status?: string | null;
}

export interface LvRoom {
    id: number;
    hotel_id?: number;
    room_number: string | number;
    capacity: number | null;
    gender?: string | null;
    is_family?: number | boolean | null;
    family_name?: string | null;
    notes?: string | null;
    /** Server-computed bed count (GET /hotels); the explorer prefers the attendee list (optimistic moves). */
    occupied?: number | null;
    location_id?: number | null;
    location_name?: string | null;
    /** A shared room (2.18.0): each location's beds in it; the rest of the capacity are pool beds. */
    shares?: { location_id: number; location_name?: string | null; beds: number; occupied?: number | null }[] | null;
    pool_beds?: number | null;
    pool_occupied?: number | null;
    /** A shared room's class (2.21.0): see lockMismatch. */
    lock?: { field: string; value: string }[] | null;
}

export interface LvHotel {
    id: number;
    name: string;
    address?: string | null;
    rooms?: LvRoom[];
}

export interface LvPerson {
    id: number;
    room_id?: number | null;
    status?: string | null;
    location_id?: number | null;
    location?: string | null;
    gender?: string | null;
    family_group?: string | null;
    custom_data?: Record<string, unknown> | null;
    [column: string]: unknown;
}

export interface LvField {
    name: string;
    label?: string;
    role?: string | null;
    type?: string | null;
    is_unique?: number | boolean | null;
}

/**
 * i18n keys of the reasons a move is refused (the same keys the old accommodation board used). A submitted /
 * validated location is NOT one of them (2.17.0): the administration adjusts a reviewed arrangement directly
 * — see reviewedLocationOf for the notice the explorer shows instead.
 */
export type BlockKey = 'board.cancelled' | 'board.moving' | 'board.room.foreign' | 'board.room.full' | 'board.room.shared.full' | 'board.room.locked';

// ---------------------------------------------------------------------------------------------
// Small shared helpers (moved here from admin/page.tsx so the explorer never imports the page)
// ---------------------------------------------------------------------------------------------

/** Chips rendered in the «Sin asignar» panel before the "use the search box" note. */
export const BOARD_CHIP_CAP = 300;

/**
 * The drag payload's private MIME type: a drop only counts when a chip of the explorer started the
 * drag (text/plain alone would also accept "101" selected on the page or dragged from another window).
 */
export const BOARD_DRAG_TYPE = 'application/x-cm-inscription';

/** t() has no interpolation: fill literal {key} placeholders. */
export const fillVars = (text: string, vars: Record<string, string | number>): string =>
    Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), String(text || ''));

/** The few keys that name a location carry a literal {name} placeholder. */
export const withName = (text: string, name: string): string => String(text || '').split('{name}').join(name);

/**
 * Lodging status of a location (draft | submitted | validated): i18n key + badge classes, shared by the
 * locations cards, the review modal, the inscriptions assign modal and the explorer's room picker.
 */
export const LODGING_STATUS_META: Record<string, { key: string; fallback: string; cls: string; icon: string }> = {
    draft: { key: 'lodging.status.draft', fallback: 'Borrador', cls: 'bg-gray-100 text-gray-500', icon: 'fa-pen-ruler' },
    submitted: { key: 'lodging.status.submitted', fallback: 'Enviado a validación', cls: 'bg-amber-50 text-amber-700 border border-amber-200', icon: 'fa-paper-plane' },
    validated: { key: 'lodging.status.validated', fallback: 'Validado', cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', icon: 'fa-circle-check' },
};
export const lodgingStatusMeta = (status?: string | null) => LODGING_STATUS_META[status || 'draft'] || LODGING_STATUS_META.draft;

/**
 * Mirror of lib/conference.ts isLodgingFrozen: under review or validated. The COORDINATOR cannot change it then
 * (the portal answers 409 until the admin reopens it); the administration still can (2.17.0), and each such
 * change is recorded on the location as an administration adjustment.
 */
export const isFrozenStatus = (status?: string | null): boolean => status === 'submitted' || status === 'validated';

/**
 * The location row behind `locationId` when its arrangement is submitted / validated, else null: what the
 * explorer, the room pickers and the inscriptions' room modal name in their «adjustment» notice.
 */
export const reviewedLocationOf = <L extends LvLocation>(locationId: number | null | undefined, locations: L[] | null | undefined): L | null => {
    if (locationId == null) return null;
    const loc = (locations || []).find(l => Number(l.id) === Number(locationId)) || null;
    return loc && isFrozenStatus(loc.lodging_status) ? loc : null;
};

/** What a lodging write answers (2.17.0): the submitted / validated locations it adjusted. */
export interface LodgingAdjusted { location_id: number; name: string; status?: string | null }

/** The names of the locations a write adjusted — «Norte», «Sur» — or '' when it adjusted none (no notice then). */
export const adjustedNames = (result: { lodging_adjusted?: LodgingAdjusted[] | null } | null | undefined): string =>
    (result && Array.isArray(result.lodging_adjusted) ? result.lodging_adjusted : [])
        .filter(l => l && l.name != null && String(l.name) !== '')
        .map(l => `«${l.name}»`).join(', ');

/**
 * The submitted / validated locations among the owners of `rooms` (and `extraLocationIds`), sorted by name —
 * for a confirmation: deleting a hotel or a room, or re-allotting rooms, changes those arrangements.
 */
export function reviewedLocationsAmong<L extends LvLocation>(rooms: Pick<LvRoom, 'location_id'>[] | null | undefined, locations: L[] | null | undefined, extraLocationIds: (number | null | undefined)[] = []): L[] {
    const ids = new Set<number>();
    for (const r of rooms || []) if (r.location_id != null) ids.add(Number(r.location_id));
    for (const id of extraLocationIds) if (id != null) ids.add(Number(id));
    const out: L[] = [];
    for (const id of ids) { const l = reviewedLocationOf(id, locations); if (l) out.push(l); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The location ids of whoever sleeps in `rooms` (through the occupant index). Deleting a POOL room or a hotel
 * frees beds of THEIR locations' arrangements as well (`placed_elsewhere`), not only of the rooms' owners —
 * the server stamps both (2.17.0), so the confirmation names both (`extraLocationIds` above).
 */
export function occupantLocationIds(rooms: Pick<LvRoom, 'id'>[] | null | undefined, idx: OccupantIndex | null | undefined): number[] {
    const ids = new Set<number>();
    for (const r of rooms || []) {
        for (const p of (idx && idx.get(Number(r.id))) || []) {
            const l = rawLocationId(p);
            if (l != null) ids.add(l);
        }
    }
    return [...ids];
}

/**
 * The submitted / validated locations ONE room's adjustment notices name (2.17.0), once each: the room's own
 * location first, then its occupants' (a pool room may hold attendees of several), by name. The room level
 * shows one notice per location instead of repeating it on every occupant.
 */
export function reviewedInRoom<L extends LvLocation>(room: Pick<LvRoom, 'location_id'>, occupants: Pick<LvPerson, 'location_id'>[] | null | undefined, locations: L[] | null | undefined): L[] {
    const own = reviewedLocationOf(room.location_id, locations);
    const others = reviewedLocationsAmong([], locations, (occupants || []).map(p => rawLocationId(p)))
        .filter(l => !own || Number(l.id) !== Number(own.id));
    return own ? [own, ...others] : others;
}

/**
 * What changing an attendee's location in the inscription form does to submitted / validated arrangements —
 * the client mirror of PUT /inscriptions/:id (2.17.0), for the form's hint. The BED RULE: an arrangement is
 * who sleeps where, so only an attendee who holds a bed changes one, in either direction:
 *   - `out`: the reviewed location they leave HOLDING A BED (the move frees it, or they take a pool bed
 *     along: either way that arrangement changes; Hospedaje › gestionar's);
 *   - `into`: the reviewed location they enter WITH the bed they keep — a pool bed, or a room of that very
 *     location. A bed of another location's room is freed by the move, and a cancellation frees any bed.
 * Without a bed they leave and arrive like a new registration, and that is no adjustment either way (no hint).
 * `original.room_location_id` is the location the attendee's room is allotted to (GET /inscriptions; null =
 * a pool room); when it is unknown (undefined) no `into` is claimed.
 */
export function moveAdjustments<L extends LvLocation>(
    original: { location_id?: number | null; room_id?: number | null; room_location_id?: number | null; room_shared?: number | boolean | null; status?: string | null } | null | undefined,
    next: { location_id?: number | string | null; status?: string | null } | null | undefined,
    locations: L[] | null | undefined,
): { out: L | null; into: L | null; intoMaybe: L | null } {
    if (!original || !next) return { out: null, into: null, intoMaybe: null };
    const from = original.location_id == null ? null : Number(original.location_id);
    const to = next.location_id == null || next.location_id === '' ? null : Number(next.location_id);
    if (from === to) return { out: null, into: null, intoMaybe: null };
    const cancelled = (next.status !== undefined ? next.status : original.status) === 'cancelled';
    const roomLoc = original.room_location_id;
    const hasBed = original.room_id != null;
    const keepsBed = hasBed && !cancelled && roomLoc !== undefined && (roomLoc == null || Number(roomLoc) === to);
    // A SHARED room (2.18.0): the bed stays only if one is free there for the new location (its own beds,
    // or a pool bed) — the form cannot know, so it says «if it keeps the bed» instead of claiming it.
    const shared = roomLoc == null && !!Number(original.room_shared || 0);
    const target = keepsBed ? reviewedLocationOf(to, locations) : null;
    return { out: hasBed ? reviewedLocationOf(from, locations) : null, into: shared ? null : target, intoMaybe: shared ? target : null };
}

/**
 * The registration form is the source of truth: attendee data lives in real columns named after each
 * field (with a custom_data fallback for legacy rows). '' when the value is empty.
 */
export const fieldVal = (person: LvPerson | null | undefined, field: Pick<LvField, 'name'>): unknown => {
    const v = person ? person[field.name] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = person?.custom_data ? (person.custom_data as Record<string, unknown>)[field.name] : undefined;
    return (cd !== undefined && cd !== null && cd !== '') ? cd : '';
};

const filled = (v: unknown) => v !== '' && v !== null && v !== undefined;

/**
 * May this field stand in for a person's NAME when the form has no Nombre / Apellido? Never a unique
 * identifier (an ID document), a contact (email, phone) or free text (notes). Copy of lib/fields.ts
 * isNameFallbackField (this file imports nothing — see the header); a test keeps the two equal.
 */
export function isNameFallbackField(f: Partial<LvField> | null | undefined): boolean {
    if (!f || !f.name || f.name === 'first_name' || f.name === 'last_name') return false;
    if (Number(f.is_unique)) return false;
    const role = String(f.role || '');
    if (role === 'email' || role === 'phone' || f.name === 'email' || f.name === 'phone') return false;
    return !['textarea', 'notes', 'email', 'tel'].includes(String(f.type || ''));
}

/**
 * The form fields that make up an attendee's display name: the fields tagged with the name roles when
 * they hold a value, otherwise the first 1-2 filled form fields fit to stand in for a name (lib/fields.ts
 * isNameFallbackField: never an ID document, a contact or notes).
 */
export const nameFields = (person: LvPerson | null | undefined, fields: LvField[] | null | undefined): LvField[] => {
    const fl = fields || [];
    const named = ['first_name', 'last_name']
        .map(role => fl.find(f => f.role === role))
        .filter((f): f is LvField => !!f && filled(fieldVal(person, f)));
    return named.length ? named : fl.filter(f => isNameFallbackField(f) && filled(fieldVal(person, f))).slice(0, 2);
};

export const personDisplayName = (person: LvPerson | null | undefined, fields: LvField[] | null | undefined): string => {
    const name = nameFields(person, fields).map(f => String(fieldVal(person, f))).join(' ').trim();
    return name || `#${person?.id ?? ''}`;
};

/** Mirror of lib/conference.ts seedLocationId: the id column, or a legacy label resolved by name (display only). */
export const personLocationId = (person: Pick<LvPerson, 'location' | 'location_id'>, locations: Pick<LvLocation, 'id' | 'name'>[]): number | null => {
    if (person.location_id !== undefined && person.location_id !== null) return Number(person.location_id);
    if (!person.location) return null;
    const hit = (locations || []).find(l => l.name === person.location);
    return hit ? Number(hit.id) : null;
};

/**
 * The location id the SERVER checks: roomAllows and assertLocationNotFrozen read the location_id column
 * only (they never resolve a legacy `location` label by name) — personLocationId is for display.
 */
export const rawLocationId = (p: Pick<LvPerson, 'location_id'>): number | null => (p.location_id == null ? null : Number(p.location_id));

/** Lower-case, accent-free text for searching ("José" matches "jose"). */
export const normalizeText = (s: unknown): string =>
    String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------------------------

export type OccupantIndex = Map<number, LvPerson[]>;

/**
 * Attendees by room id. Every row with a room_id counts — the server's capacity check counts the same
 * way (a legacy cancelled row that still holds a room takes its bed until it is unassigned).
 */
export function indexOccupants(people: LvPerson[] | null | undefined): OccupantIndex {
    const m: OccupantIndex = new Map();
    for (const p of people || []) {
        if (p.room_id == null) continue;
        const k = Number(p.room_id);
        const list = m.get(k);
        if (list) list.push(p); else m.set(k, [p]);
    }
    return m;
}

/** Beds taken: from the attendee index when given (optimistic moves show at once), else the server count. */
export const occupiedOf = (room: Pick<LvRoom, 'id' | 'occupied'>, idx?: OccupantIndex | null): number =>
    idx ? (idx.get(Number(room.id)) || []).length : Number(room.occupied) || 0;

export const occupantsOf = (room: Pick<LvRoom, 'id'>, idx: OccupantIndex | null | undefined): LvPerson[] =>
    (idx && idx.get(Number(room.id))) || [];

/** full = no free bed (capacity 0 included); empty = nobody inside; partial = somebody and free beds. */
export type RoomState = 'full' | 'partial' | 'empty';

export interface RoomStats {
    capacity: number;
    occupied: number;
    /** Free beds, never negative (an overbooked legacy room has 0). */
    free: number;
    state: RoomState;
    /** Occupancy percentage for the capacity bar, 0..100. */
    pct: number;
    overbooked: boolean;
}

export function roomStats(room: LvRoom, idx?: OccupantIndex | null): RoomStats {
    const capacity = Math.max(0, Number(room.capacity) || 0);
    const occupied = occupiedOf(room, idx);
    const free = Math.max(0, capacity - occupied);
    const state: RoomState = free === 0 ? 'full' : occupied === 0 ? 'empty' : 'partial';
    const pct = capacity > 0 ? Math.min(100, Math.round((occupied / capacity) * 100)) : (occupied > 0 ? 100 : 0);
    return { capacity, occupied, free, state, pct, overbooked: occupied > capacity };
}

export interface HotelStats {
    rooms: number;
    beds: number;
    occupied: number;
    free: number;
    /** Rooms without a free bed. */
    full: number;
    /** Rooms with at least one free bed (empty ones included) — what the «Con camas libres» filter shows. */
    withFree: number;
    /** Rooms with beds and nobody in them yet (state 'empty': always a subset of withFree). */
    empty: number;
    pct: number;
    /** Distinct locations the hotel's rooms are allotted to, by name. */
    locations: { id: number; name: string }[];
    /** Rooms still in the conference-wide pool (not allotted to any location). */
    poolRooms: number;
}

export function hotelStats(hotel: LvHotel, idx?: OccupantIndex | null, locations?: LvLocation[] | null): HotelStats {
    const rooms = hotel.rooms || [];
    let beds = 0, occupied = 0, free = 0, full = 0, withFree = 0, empty = 0, poolRooms = 0;
    const locs = new Map<number, string>();
    for (const r of rooms) {
        const s = roomStats(r, idx);
        beds += s.capacity; occupied += s.occupied; free += s.free;
        if (s.free === 0) full++; else withFree++;
        if (s.state === 'empty') empty++;
        if (r.location_id == null && r.shares && r.shares.length) {
            // A shared room (2.18.0): every location with beds in it, and a pool room too while it keeps pool beds.
            for (const sh of r.shares) {
                const id = Number(sh.location_id);
                if (!locs.has(id)) locs.set(id, sh.location_name || (locations || []).find(l => Number(l.id) === id)?.name || `#${id}`);
            }
            if ((Number(r.pool_beds) || 0) > 0) poolRooms++;
            continue;
        }
        if (r.location_id == null) { poolRooms++; continue; }
        const id = Number(r.location_id);
        if (!locs.has(id)) {
            const name = r.location_name || (locations || []).find(l => Number(l.id) === id)?.name || `#${id}`;
            locs.set(id, name);
        }
    }
    const list = Array.from(locs.entries()).map(([id, name]) => ({ id, name }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    const pct = beds > 0 ? Math.min(100, Math.round((occupied / beds) * 100)) : (occupied > 0 ? 100 : 0);
    return { rooms: rooms.length, beds, occupied, free, full, withFree, empty, pct, locations: list, poolRooms };
}

/** Non-cancelled attendees without a room (what the run button and the «Sin asignar» counter count). */
export const unassignedCount = (people: LvPerson[] | null | undefined): number =>
    (people || []).filter(p => p.room_id == null && p.status !== 'cancelled').length;

/**
 * The explorer's chip after a conference-wide run (POST /assignment/run). `remaining` is EVERYONE the run left
 * without a bed: its own `remaining` (no room left in the scopes it covered) plus `skipped` — the attendees of
 * the submitted / validated locations it does not touch (`skipped_unassigned`, 2.17.0; summed from
 * `skipped_frozen[].unassigned` when absent). Once the run is done that is what «N sin asignar» counts, so the
 * chip no longer says «Pendientes: 0» next to «2 sin asignar»; it says how many of them were not touched.
 */
export function runSummaryOf(report: { assignedCount?: unknown; remaining?: unknown; skipped_unassigned?: unknown; skipped_frozen?: { unassigned?: unknown }[] | null } | null | undefined): { assigned: number; remaining: number; skipped: number } {
    const n = (v: unknown) => Math.max(0, Number(v) || 0);
    const skipped = report && report.skipped_unassigned != null ? n(report.skipped_unassigned)
        : (report && Array.isArray(report.skipped_frozen) ? report.skipped_frozen.reduce((s, l) => s + n(l && l.unassigned), 0) : 0);
    return { assigned: n(report && report.assignedCount), remaining: n(report && report.remaining) + skipped, skipped };
}

export interface OverallStats { hotels: number; rooms: number; beds: number; occupied: number; free: number; unassigned: number }

export function overallStats(hotels: LvHotel[] | null | undefined, people: LvPerson[] | null | undefined, idx?: OccupantIndex | null): OverallStats {
    const out: OverallStats = { hotels: 0, rooms: 0, beds: 0, occupied: 0, free: 0, unassigned: unassignedCount(people) };
    for (const h of hotels || []) {
        const s = hotelStats(h, idx);
        out.hotels++; out.rooms += s.rooms; out.beds += s.beds; out.occupied += s.occupied; out.free += s.free;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Eligibility — the client-side pre-checks (the server re-checks every one of them: 400/409)
// ---------------------------------------------------------------------------------------------

export interface EligibilityCtx {
    /** Attendees with a move in flight. */
    pending?: Set<number> | null;
}

/**
 * Why `p` can't be moved at all (dragged, re-roomed) — null when it can. An attendee of a submitted /
 * validated location CAN (2.17.0: an administration adjustment, recorded by the server).
 */
export function dragBlock(p: LvPerson, ctx: EligibilityCtx): BlockKey | null {
    if (p.status === 'cancelled') return 'board.cancelled';
    if (ctx.pending && ctx.pending.has(p.id)) return 'board.moving';
    return null;
}

/**
 * Why `p` can't be taken OUT of their room — null when it can. A cancelled attendee CAN be unassigned
 * (that frees the bed they still hold); only a move in flight stops it.
 */
export function unassignBlock(p: LvPerson, ctx: EligibilityCtx): BlockKey | null {
    if (ctx.pending && ctx.pending.has(p.id)) return 'board.moving';
    return null;
}

/**
 * A shared room (2.18.0): is there a bed for `p` — one of their location's beds there, or a pool bed? Mirror
 * of the server's bedFreeFor (each location's people fill its beds first; everyone else, and the overflow,
 * takes pool beds). `occupants` = who sleeps in the room now (`p` excluded here); null = trust the
 * server's counts on the room. Not a shared room → true (the capacity / location checks decide).
 */
export function sharedBedFree(room: LvRoom, p: Pick<LvPerson, 'id' | 'location_id'>, occupants?: Pick<LvPerson, 'id' | 'location_id'>[] | null): boolean {
    const shares = room.shares || [];
    if (room.location_id != null || !shares.length) return true;
    const cap = Math.max(1, Number(room.capacity) || 1);
    const given = shares.reduce((n, s) => n + (Number(s.beds) || 0), 0);
    const poolBeds = Math.max(0, cap - given);
    const lid = rawLocationId(p);
    const share = lid == null ? undefined : shares.find(s => Number(s.location_id) === lid);
    const mine = share ? Number(share.beds) || 0 : 0;
    if (!occupants) {
        if (mine && (Number(share!.occupied) || 0) < mine) return true;
        return (Number(room.pool_occupied) || 0) < poolBeds;
    }
    const byLoc = new Map<number | null, number>();
    for (const o of occupants) {
        if (Number(o.id) === Number(p.id)) continue;
        const l = rawLocationId(o);
        byLoc.set(l, (byLoc.get(l) || 0) + 1);
    }
    if (mine && (byLoc.get(lid) || 0) < mine) return true;
    let poolUsed = 0;
    for (const [l, n] of byLoc) {
        const s = l == null ? undefined : shares.find(x => Number(x.location_id) === l);
        poolUsed += Math.max(0, n - (s ? Number(s.beds) || 0 : 0));
    }
    return poolUsed < poolBeds;
}

/** Fixed in their room by the administration (2.21.0): `room_locked` names the room, and holds only while they are in it. */
export const pinnedHere = (p: { room_id?: number | null; room_locked?: unknown } | null | undefined): boolean =>
    !!(p && p.room_id != null && Number(p.room_locked) > 0 && Number(p.room_locked) === Number(p.room_id));

/**
 * A shared room's class (2.21.0; «la habitación compartida se queda con el género que le dio el reparto»): true when
 * `p` has another value for a field «Sugerir reparto» fixed for the room — the server answers 409. A blank value is no
 * value. Mirror of the server's lockAllows.
 */
export function lockMismatch(room: Pick<LvRoom, 'lock' | 'location_id'>, p: LvPerson | null | undefined): boolean {
    if (!p || room.location_id != null) return false;
    return (room.lock || []).some(x => {
        const v = String(fieldVal(p, { name: x.field }) ?? '').trim().toLowerCase();
        return v !== '' && v !== String(x.value ?? '').trim().toLowerCase();
    });
}

/** A class as words: the gender as `words` («Mujeres» / «Hombres»), any other value as it is. */
export function lockText(lock: { field: string; value: string }[] | null | undefined, words: { F: string; M: string }): string {
    return (lock || []).map(x => { const k = x.field === 'gender' ? genderKey(x.value) : ''; return k ? words[k] : String(x.value); }).join(' · ');
}

/**
 * Why `p` can't be dropped into `room` — null when the move is allowed (or `p` is already there). An
 * allotted room is "foreign" to anyone of another location (the server answers 400 «asignada a la
 * localidad …»).
 */
export function dropBlock(p: LvPerson | null | undefined, room: LvRoom, idx?: OccupantIndex | null): BlockKey | null {
    if (!p) return null;
    if (Number(p.room_id) === Number(room.id)) return null;
    if (room.location_id != null && Number(room.location_id) !== rawLocationId(p)) return 'board.room.foreign';
    if (occupiedOf(room, idx) >= (Number(room.capacity) || 0)) return 'board.room.full';
    if (!sharedBedFree(room, p, idx ? occupantsOf(room, idx) : null)) return 'board.room.shared.full';
    if (lockMismatch(room, p)) return 'board.room.locked';
    return null;
}

/** dragBlock, then dropBlock: the full answer to "can `p` go to `room` right now?". */
export const moveBlock = (p: LvPerson, room: LvRoom, ctx: EligibilityCtx, idx?: OccupantIndex | null): BlockKey | null =>
    dragBlock(p, ctx) || dropBlock(p, room, idx);

export interface CandidateOpts {
    q?: string;
    /** Also offer attendees who already sleep in ANOTHER room (picking one moves them). */
    includePlaced?: boolean;
    nameOf: (p: LvPerson) => string;
    /** Extra searchable text per attendee (e.g. the location name). */
    extraText?: (p: LvPerson) => string;
}

/**
 * A single-gender room (`M` / `F`) and a person of the other gender. Advisory only: the server accepts the
 * move (a family room may legitimately mix), so the picker lists them last with a warning instead of hiding them.
 */
export function genderMismatch(room: LvRoom, p: LvPerson): boolean {
    const rg = roomGender(room);
    if (rg === 'Mixed') return false;
    const pg = genderKey(p.gender);
    return pg !== '' && pg !== rg;
}

const FEMALE = new Set(['f', 'fem', 'femenino', 'femenina', 'female', 'mujer', 'woman', 'w', 'feminino', 'mulher']);
const MALE = new Set(['m', 'masc', 'masculino', 'male', 'hombre', 'man', 'h', 'varon', 'homem']);
/**
 * An attendee's gender as 'F' / 'M' / '' (unknown) — the «Género» field's options are editable (2.16.0), so
 * read the word, not its first letter: «Mujer» is F although it starts with an M. Mirror of the portal's
 * genderKey (frontend/src/app/portal/conference/lodgingView.ts).
 */
export function genderKey(v: unknown): 'M' | 'F' | '' {
    const s = normalizeText(v);
    if (!s) return '';
    if (FEMALE.has(s) || s.startsWith('fem') || s.startsWith('muj')) return 'F';
    if (MALE.has(s) || s.startsWith('masc') || s.startsWith('homb') || s.startsWith('var')) return 'M';
    return '';
}

/**
 * Attendees that can legally take a free bed of `room` (the «Asignar participante» picker): not
 * cancelled, not mid-move, not already inside, and of the room's location when it is
 * allotted. Room capacity is the caller's business (the picker is only offered while a bed is free).
 * Sorted by display name, people of a single-gender room's gender first.
 */
export function assignCandidates(people: LvPerson[] | null | undefined, room: LvRoom, ctx: EligibilityCtx, opts: CandidateOpts): LvPerson[] {
    const q = normalizeText(opts.q);
    const out: { p: LvPerson; name: string }[] = [];
    const inside = (people || []).filter(x => Number(x.room_id) === Number(room.id));
    for (const p of people || []) {
        if (Number(p.room_id) === Number(room.id)) continue;
        if (p.room_id != null && !opts.includePlaced) continue;
        if (dragBlock(p, ctx)) continue;
        if (room.location_id != null && Number(room.location_id) !== rawLocationId(p)) continue;
        if (!sharedBedFree(room, p, inside)) continue;   // a shared room with no bed left for p's location
        if (lockMismatch(room, p)) continue;             // a shared room fixed for another value (2.21.0)
        const name = opts.nameOf(p);
        if (q && !normalizeText(`${name} ${p.family_group || ''} ${opts.extraText ? opts.extraText(p) : ''}`).includes(q)) continue;
        out.push({ p, name });
    }
    // People of the room's gender first (single-gender rooms), then by name.
    out.sort((a, b) => (Number(genderMismatch(room, a.p)) - Number(genderMismatch(room, b.p)))
        || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.p.id - b.p.id);
    return out.map(x => x.p);
}

export interface CandidateExclusions { cancelled: number; foreign: number; moving: number; noBed: number; locked: number }

/**
 * Why attendees are missing from the picker (counted among the ones it would otherwise list: the
 * unassigned, plus the placed ones when `includePlaced`), so the picker never hides people silently.
 */
export function candidateExclusions(people: LvPerson[] | null | undefined, room: LvRoom, ctx: EligibilityCtx, includePlaced = false): CandidateExclusions {
    const out: CandidateExclusions = { cancelled: 0, foreign: 0, moving: 0, noBed: 0, locked: 0 };
    const inside = (people || []).filter(x => Number(x.room_id) === Number(room.id));
    for (const p of people || []) {
        if (Number(p.room_id) === Number(room.id)) continue;
        if (p.room_id != null && !includePlaced) continue;
        const why = dragBlock(p, ctx);
        if (why === 'board.cancelled') out.cancelled++;
        else if (why === 'board.moving') out.moving++;
        else if (room.location_id != null && Number(room.location_id) !== rawLocationId(p)) out.foreign++;
        else if (!sharedBedFree(room, p, inside)) out.noBed++;   // a shared room with no bed left for p's location
        else if (lockMismatch(room, p)) out.locked++;            // a shared room fixed for another value (2.21.0)
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Filters, sorting and the prev/next walk
// ---------------------------------------------------------------------------------------------

export type RoomStateFilter = 'all' | 'free' | 'full' | 'empty';
export type RoomGenderFilter = '' | 'M' | 'F' | 'Mixed';

/** Location filter value for "rooms / attendees without a location" (the pool). */
export const POOL_FILTER = '__pool';

export interface RoomFilters {
    /** Attendee name, family group or room number. */
    q: string;
    state: RoomStateFilter;
    /** '' = every location, POOL_FILTER = the pool, otherwise a location id as a string. */
    location: string;
    gender: RoomGenderFilter;
}

export const DEFAULT_ROOM_FILTERS: RoomFilters = { q: '', state: 'all', location: '', gender: '' };

const STATE_VALUES: RoomStateFilter[] = ['all', 'free', 'full', 'empty'];
const GENDER_VALUES: RoomGenderFilter[] = ['', 'M', 'F', 'Mixed'];

/** A room's gender policy: 'M' | 'F' | 'Mixed' (anything else, or nothing, is mixed). */
export const roomGender = (room: Pick<LvRoom, 'gender'>): 'M' | 'F' | 'Mixed' =>
    room.gender === 'M' || room.gender === 'F' ? room.gender : 'Mixed';

/** 'free' = at least one free bed (empty rooms included), 'full' = none, 'empty' = beds and nobody inside. */
export const matchesState = (s: RoomStats, state: RoomStateFilter): boolean =>
    state === 'all' ? true : state === 'free' ? s.free > 0 : state === 'full' ? s.free === 0 : s.state === 'empty';

export interface FilterDeps {
    idx: OccupantIndex | null | undefined;
    nameOf: (p: LvPerson) => string;
    /** Display location of an attendee (personLocationId bound to the conference's locations). */
    locationIdOf: (p: LvPerson) => number | null;
}

/**
 * The location filter on rooms. A location id = the rooms that location can use or already uses: the
 * ones allotted to it, EVERY pool room (the server's roomAllows takes anyone into a pool room, so they
 * are legal drop targets for its attendees — hiding them would leave a location's pending attendees,
 * and the legacy rows that carry only a location label, without visible targets), and any room that
 * holds one of its attendees. POOL_FILTER = the pool rooms only.
 */
export function roomMatchesLocation(room: LvRoom, location: string, deps: Pick<FilterDeps, 'idx' | 'locationIdOf'>): boolean {
    if (!location) return true;
    // A SHARED room (2.18.0) by its beds: the pool while it keeps pool beds; a location that has beds in it,
    // or any location while it keeps pool beds, or one of whose attendees sleeps there.
    if (room.location_id == null && (room.shares || []).length) {
        const poolBeds = (Number(room.pool_beds) || 0) > 0;
        if (location === POOL_FILTER) return poolBeds;
        if (poolBeds || (room.shares || []).some(s => String(s.location_id) === location)) return true;
        return occupantsOf(room, deps.idx).some(p => String(deps.locationIdOf(p) ?? '') === location);
    }
    if (room.location_id == null) return true;                 // pool rooms: in both the pool and every location
    if (location === POOL_FILTER) return false;
    if (String(room.location_id) === location) return true;
    return occupantsOf(room, deps.idx).some(p => String(deps.locationIdOf(p) ?? '') === location);
}

/** Does `room` match every filter except, optionally, the state one? */
export function roomMatches(room: LvRoom, f: RoomFilters, deps: FilterDeps, ignoreState = false): boolean {
    const occupants = occupantsOf(room, deps.idx);
    if (!ignoreState && f.state !== 'all' && !matchesState(roomStats(room, deps.idx), f.state)) return false;
    if (f.gender && roomGender(room) !== f.gender) return false;
    if (!roomMatchesLocation(room, f.location, deps)) return false;
    const q = normalizeText(f.q);
    if (q) {
        if (normalizeText(room.room_number).includes(q)) return true;
        return occupants.some(p => normalizeText(`${deps.nameOf(p)} ${p.family_group || ''}`).includes(q));
    }
    return true;
}

/** Natural room order: "2" before "10", "A-2" before "A-10"; ties by id. */
export const compareRooms = (a: LvRoom, b: LvRoom): number =>
    String(a.room_number ?? '').localeCompare(String(b.room_number ?? ''), undefined, { numeric: true, sensitivity: 'base' }) || (Number(a.id) - Number(b.id));

export const sortRooms = <T extends LvRoom>(rooms: T[] | null | undefined): T[] => [...(rooms || [])].sort(compareRooms);

/** The hotel's rooms that pass the filters, in natural order. */
export const filterRooms = <T extends LvRoom>(rooms: T[] | null | undefined, f: RoomFilters, deps: FilterDeps): T[] =>
    sortRooms(rooms).filter(r => roomMatches(r, f, deps));

/** Counts for the state pills, over the rooms that pass the OTHER filters (so a pill tells what it yields). */
export function stateCounts(rooms: LvRoom[] | null | undefined, f: RoomFilters, deps: FilterDeps): Record<RoomStateFilter, number> {
    const out: Record<RoomStateFilter, number> = { all: 0, free: 0, full: 0, empty: 0 };
    for (const r of rooms || []) {
        if (!roomMatches(r, f, deps, true)) continue;
        const s = roomStats(r, deps.idx);
        out.all++;
        if (s.free > 0) out.free++; else out.full++;
        if (s.state === 'empty') out.empty++;
    }
    return out;
}

export const filtersActive = (f: RoomFilters): boolean => !!(f.q.trim() || f.state !== 'all' || f.location || f.gender);

/**
 * Previous / next item around `id`. When `id` is not in the list (the open room no longer passes the
 * filters) prev/next are null and index is -1 — the caller then offers the unfiltered walk.
 */
export function neighbors<T extends { id: number }>(list: T[], id: number | null | undefined): { prev: T | null; next: T | null; index: number; total: number } {
    const index = id == null ? -1 : list.findIndex(x => Number(x.id) === Number(id));
    if (index < 0) return { prev: null, next: null, index: -1, total: list.length };
    return { prev: index > 0 ? list[index - 1] : null, next: index < list.length - 1 ? list[index + 1] : null, index, total: list.length };
}

// ---------------------------------------------------------------------------------------------
// «Sin asignar» panel
// ---------------------------------------------------------------------------------------------

/** `reviewed`: the location's arrangement is submitted / validated (`status`) — the group header says so. */
export interface UnassignedGroup { key: string; name: string; reviewed: boolean; status: string | null; people: LvPerson[] }

/**
 * Non-cancelled attendees without a room, filtered by the search box and the location filter, grouped
 * by (display) location; groups sorted by name with "no location" last, people by display name.
 */
export function groupUnassigned(
    people: LvPerson[] | null | undefined,
    locations: LvLocation[] | null | undefined,
    opts: { q?: string; location?: string; nameOf: (p: LvPerson) => string },
): { list: UnassignedGroup[]; total: number } {
    const q = normalizeText(opts.q);
    const locs = locations || [];
    const byId = new Map<number, LvLocation>();
    for (const l of locs) byId.set(Number(l.id), l);
    const groups = new Map<string, UnassignedGroup & { names: Map<number, string> }>();
    let total = 0;
    for (const p of people || []) {
        if (p.room_id != null || p.status === 'cancelled') continue;
        const locId = personLocationId(p, locs);
        if (opts.location) {
            if (opts.location === POOL_FILTER ? locId != null : String(locId ?? '') !== opts.location) continue;
        }
        const loc = locId == null ? null : byId.get(Number(locId)) || null;
        const locName = loc?.name || String(p.location || '');
        const name = opts.nameOf(p);
        if (q && !normalizeText(`${name} ${p.family_group || ''} ${locName}`).includes(q)) continue;
        const key = locId == null ? '' : String(locId);
        let g = groups.get(key);
        if (!g) {
            g = { key, name: locName, reviewed: !!loc && isFrozenStatus(loc.lodging_status), status: loc?.lodging_status || null, people: [], names: new Map() };
            groups.set(key, g);
        }
        g.people.push(p);
        g.names.set(p.id, name);
        total++;
    }
    const list = Array.from(groups.values()).map(({ names, ...g }) => ({
        ...g,
        people: [...g.people].sort((a, b) => (names.get(a.id) || '').localeCompare(names.get(b.id) || '', 'es', { sensitivity: 'base' }) || a.id - b.id),
    }));
    list.sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿'));
    return { list, total };
}

// ---------------------------------------------------------------------------------------------
// Where the explorer is (remembered per conference in sessionStorage by the component)
// ---------------------------------------------------------------------------------------------

export interface ExplorerNav {
    hotelId: number | null;
    roomId: number | null;
    filters: RoomFilters;
    /** The «Sin asignar» section on narrow screens (it is always open beside the grid at ≥xl). */
    unassignedOpen: boolean;
}

export const EMPTY_NAV: ExplorerNav = { hotelId: null, roomId: null, filters: DEFAULT_ROOM_FILTERS, unassignedOpen: false };

export const navStorageKey = (conferenceId: number | string): string => `cm:lodging-explorer:${conferenceId}`;

/** 1 = hotels, 2 = one hotel, 3 = one room. */
export const levelOf = (nav: Pick<ExplorerNav, 'hotelId' | 'roomId'>): 1 | 2 | 3 =>
    nav.hotelId == null ? 1 : nav.roomId == null ? 2 : 3;

const posInt = (v: unknown): number | null => {
    const n = Number(v);
    return v !== null && v !== '' && Number.isInteger(n) && n > 0 ? n : null;
};

/** Parse a stored place defensively: anything malformed falls back to the defaults, field by field. */
export function parseNav(raw: string | null | undefined): ExplorerNav {
    let v: any = null;
    try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
    if (!v || typeof v !== 'object') return { ...EMPTY_NAV, filters: { ...DEFAULT_ROOM_FILTERS } };
    const f = v.filters && typeof v.filters === 'object' ? v.filters : {};
    const filters: RoomFilters = {
        q: typeof f.q === 'string' ? f.q.slice(0, 200) : '',
        state: STATE_VALUES.includes(f.state) ? f.state : 'all',
        location: typeof f.location === 'string' && (f.location === POOL_FILTER || posInt(f.location) != null) ? f.location : '',
        gender: GENDER_VALUES.includes(f.gender) ? f.gender : '',
    };
    const hotelId = posInt(v.hotelId);
    return { hotelId, roomId: hotelId == null ? null : posInt(v.roomId), filters, unassignedOpen: v.unassignedOpen === true };
}

export const hotelOfRoom = <H extends LvHotel>(hotels: H[] | null | undefined, roomId: number | null | undefined): H | null =>
    roomId == null ? null : (hotels || []).find(h => (h.rooms || []).some(r => Number(r.id) === Number(roomId))) || null;

/**
 * Fit a remembered (or requested) place to the data that exists now: a deleted hotel goes back to the
 * hotels level, a deleted (or moved) room back to its hotel, a deleted location leaves the filter.
 * Returns the SAME object when nothing changes (so a state setter can bail out).
 */
export function reconcileNav(nav: ExplorerNav, hotels: LvHotel[] | null | undefined, locations?: LvLocation[] | null): ExplorerNav {
    let { hotelId, roomId, filters } = nav;
    const list = hotels || [];
    if (hotelId == null && roomId != null) hotelId = hotelOfRoom(list, roomId)?.id ?? null;
    const hotel = hotelId == null ? null : list.find(h => Number(h.id) === Number(hotelId)) || null;
    if (!hotel) { hotelId = null; roomId = null; }
    else if (roomId != null && !(hotel.rooms || []).some(r => Number(r.id) === Number(roomId))) roomId = null;
    if (locations && filters.location && filters.location !== POOL_FILTER
        && !locations.some(l => String(l.id) === filters.location)) {
        filters = { ...filters, location: '' };
    }
    if (hotelId === nav.hotelId && roomId === nav.roomId && filters === nav.filters) return nav;
    return { ...nav, hotelId, roomId, filters };
}
