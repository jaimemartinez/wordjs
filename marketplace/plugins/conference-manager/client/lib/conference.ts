// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
import { api, apiGet, apiPost, apiPut, apiDelete } from "../../../../../frontend/src/lib/api";
import type { MealService } from "./meals";
import type { FeeView, PersonPart, Transfer } from "./feePayments";
import type { LodgingAdjusted } from "./lodgingView";
import { isHealthField, type HealthAnswer } from "./health";

export interface Conference {
    id: number;
    name: string;
    slug: string;
    status: string;
    fee_default: number;
    date_start?: string;
    date_end?: string;
    description?: string;
    is_form_published?: number;
    /** The general opening of the coordinators' lodging (2.21.0; 'YYYY-MM-DD' or a datetime); null = right away. */
    lodging_opens?: string | null;
    /** The general closing ('YYYY-MM-DD' or a datetime); null = none. */
    lodging_deadline?: string | null;
    /** The zone the bare dates are judged in (the admin's, saved with the dates); null = UTC. */
    lodging_tz?: string | null;
    /** Computed by GET /locations: the general window (a bare date covers its whole day). */
    lodging_window?: LodgingWindow;
    /** Computed by GET /locations: the general closing is over. */
    lodging_deadline_passed?: boolean;
}

/** A lodging window as GET /locations computes it (2.21.0): the dates that apply and where «now» falls. */
export interface LodgingWindow {
    opens: string | null;
    closes: string | null;
    /** Before the opening. */
    not_yet: boolean;
    /** After the closing. */
    passed: boolean;
    open: boolean;
}

/** A location's own opening: the general one (null), no wait, or a date. */
export const LODGING_NO_WAIT = 'now';
/** A location's own closing: the general one (null), none, or a date. */
export const LODGING_NO_CLOSE = 'never';

/** POST /transport/check (2.25.0). */
export type BoardingCheck = {
    result: 'ok' | 'other_bus' | 'no_ticket' | 'cancelled' | 'unknown';
    bus: { id: number; name: string };
    person?: { id: number; name: string; location: string | null; reg_code: string | null };
    ticket?: { payment_status: string; price: number; amount_paid: number; balance: number };
    buses?: { id: number; name: string }[];
};

export interface Hotel {
    id: number;
    name: string;
    address: string;
    description: string;
    capacity: number;
    rooms?: Room[];
    /** Position for «Mi inscripción»'s map (2.23.0): 'lat,lng', or null. */
    geo?: string | null;
    /** Write only: the link or coordinates pasted in the hotel form ('' = no position). */
    location?: string;
}

export interface Room {
    id: number;
    hotel_id: number;
    room_number: string;
    capacity: number;
    gender: 'M' | 'F' | 'Mixed';
    is_family: number;
    family_name?: string;
    notes?: string;
    occupied?: number;
    /** null = pool room (the admin's conference-wide assignment); a location id = allotted to that location. */
    location_id: number | null;
    /** Resolved by GET /hotels (LEFT JOIN locations); null/undefined for a pool room. */
    location_name?: string | null;
    /**
     * A SHARED room (2.18.0, «camas por localidad»): location_id is null and each listed location has
     * `beds` of it (`occupied` by its own people); the rest of the capacity are pool beds. Empty for a
     * whole or a pool room.
     */
    shares?: RoomShare[];
    /** Shared room only: the beds no location has, and how many of them are taken. */
    pool_beds?: number;
    pool_occupied?: number;
    /** A shared room's class (2.21.0): the value «Sugerir reparto» fixed for a hard «Separar por» field (the gender). */
    lock?: ShareLock[];
    /** Blocked by the administration (2.21.0): the engine leaves it as it is; coordinators cannot change it. */
    blocked?: number | boolean | null;
}

/** A field's value fixed for every bed of a shared room (2.21.0); the admin frees it in «Repartir camas». */
export interface ShareLock { field: string; value: string }

export interface RoomShare {
    location_id: number;
    location_name?: string | null;
    beds: number;
    occupied?: number;
}

/** POST /locations/:id/beds — the rooms taken whole and the beds taken in shared rooms. */
export interface GiveBedsResult {
    success: boolean;
    beds: number;
    whole_rooms: { room_id: number; room_number: string; hotel_name: string; beds: number }[];
    shared_rooms: { room_id: number; room_number: string; hotel_name: string; beds: number; added: number }[];
    lodging_adjusted?: LodgingAdjusted[];
}

export interface Inscription {
    id: number;
    /** Unique random registration code (admin-only) — the barcode payload. */
    reg_code?: string | null;
    first_name: string;
    last_name: string;
    gender: 'M' | 'F';
    email: string;
    phone: string;
    location?: string;               // display label (kept in sync with the location's name by the server)
    location_id?: number | null;     // the isolation key — what the admin form sends
    document_number?: string;
    family_group?: string;
    registration_date: string;
    status: string;
    payment_status: 'unpaid' | 'partial' | 'paid';
    total_due: number;
    amount_paid: number;
    /** 2.18.0: fee money in payments awaiting validation («por validar») / returned for correction («devuelto»). */
    pending_amount?: number;
    returned_amount?: number;
    room_id?: number | null;
    notes?: string;
    hotel_name?: string;
    room_number?: string;
    /** The location the attendee's room is allotted to (GET /inscriptions; null = a pool room or no room; 2.17.0). */
    room_location_id?: number | null;
    /** 1 when the person's room is shared between locations (2.18.0). */
    room_shared?: number | null;
    custom_data?: any;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers shared by the admin page (kept here, outside React, so the contract check in the
// repo's E2E scratchpad can import and exercise them against the real index.js).
// ---------------------------------------------------------------------------------------------

/**
 * Keys of an inscription ROW that are derived or server-owned. They come back from GET
 * /inscriptions and get spread into the edit form's state, but they must never travel in a
 * POST/PUT body: `total_due` is derived from the fee rules (echoing it used to freeze the price),
 * the payment columns are recomputed from validated payments, and the rest are joins/ids.
 */
export const INSCRIPTION_READONLY_KEYS: readonly string[] = [
    'id', 'conference_id', 'total_due', 'amount_paid', 'payment_status', 'pending_amount', 'returned_amount',
    'registration_date', 'room_id', 'room_number', 'hotel_id', 'hotel_name', 'custom_data', 'location', 'reg_code',
];

/**
 * Body for POST /inscriptions (original = null) or PUT /inscriptions/:id (original = the row the
 * form was seeded from). Only DEFINED form fields plus the three operational keys the server
 * accepts (`location_id`, `notes`, `status` on edit) are taken from the form state; on edit only
 * the keys whose value actually changed are sent, so an untouched field is never echoed back.
 * Field values travel as the raw string the input holds ('' = empty; the server canonicalises
 * numbers, e.g. "0030" → "30") — never coerced with Number() here.
 */
export function buildInscriptionPayload(
    fields: Pick<ConferenceField, 'name'>[],
    formData: Record<string, any>,
    original: Record<string, any> | null,
): Record<string, any> {
    const changed = (key: string) => !original || !(key in original) || formData[key] !== original[key];
    const payload: Record<string, any> = {};
    for (const f of fields) {
        // «Condiciones de salud» (2.32.0) travels as its own object, added by the form (never as a string).
        if (!f.name || INSCRIPTION_READONLY_KEYS.includes(f.name) || isHealthField(f)) continue;
        if (!(f.name in formData) || !changed(f.name)) continue;
        const v = formData[f.name];
        payload[f.name] = v === undefined || v === null ? '' : String(v);
    }
    if ('location_id' in formData && changed('location_id')) {
        const v = formData.location_id;
        payload.location_id = v === '' || v === undefined || v === null ? null : Number(v);
    }
    if ('notes' in formData && changed('notes')) payload.notes = formData.notes ?? null;
    if (original && 'status' in formData && changed('status')) payload.status = formData.status;
    return payload;
}

/** The location select stores the id; when a legacy row only carries the label, resolve it by name. */
export function seedLocationId(person: Pick<Inscription, 'location' | 'location_id'>, locations: Pick<Location, 'id' | 'name'>[]): number | null {
    if (person.location_id !== undefined && person.location_id !== null) return Number(person.location_id);
    if (!person.location) return null;
    const hit = locations.find(l => l.name === person.location);
    return hit ? hit.id : null;
}

/** A proof is rendered with <img> only when it is an image data URL (coordinator input is untrusted). */
export const isImageProof = (p?: string | null): boolean =>
    typeof p === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.trim());

/**
 * Money for display in `locale` (undefined = the browser's): 2 decimals, integer-cents rounding (matches the
 * server's arithmetic), and thousands ALWAYS grouped — ICU's Spanish leaves a 4-digit number ungrouped by
 * default, so «$1550,00» sat next to «$13.550,00». (An engine without `useGrouping: 'always'` reads it as
 * `true`, its old default grouping.)
 */
export const formatMoneyIn = (v: unknown, locale: string | undefined): string =>
    (Math.round((Number(v) || 0) * 100) / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' as unknown as boolean });
export const fmtMoney = (v: unknown): string => formatMoneyIn(v, undefined);
/**
 * Fee money («Pagos de cuotas», the person sheet, the roster rows): the coordinator portal's format
 * (es-CO, «$1.550,00»), so the administration and the coordinators read the same amount the same way.
 */
export const fmtFeeMoney = (v: unknown): string => formatMoneyIn(v, 'es-CO');

// The payment state machine moved to lib/feePayments.ts (transferActions) with «Pagos de cuotas» (2.18.0).

export interface Location {
    id: number;
    conference_id: number;
    name: string;
    code: string;
    responsible_name: string;
    responsible_phone: string;
    /** Maximum registrants; null on a location created before 2.3.0 whose limit was never set (= no limit). */
    capacity: number | null;
    /** Seats taken right now (every non-cancelled inscription of the location). */
    inscribed: number;
    /** Forms of payment the location receives (subset of PAYMENT_METHODS, resolved by the server). */
    payment_methods: string[];
    /** Its own lodging opening (2.21.0): null = the general one, LODGING_NO_WAIT, or a date. */
    lodging_opens?: string | null;
    /** Its own lodging closing: null = the general one, LODGING_NO_CLOSE, or a date (the 2.8.0 permission became one). */
    lodging_closes?: string | null;
    /** The window its dates make with the general ones. */
    lodging_window?: LodgingWindow;
    /** Can the coordinator change the lodging right now (window open and still a draft)? */
    lodging_can_edit?: boolean;
    // --- Lodging per location (2.5.0) -------------------------------------------------------
    /** draft = the coordinator is arranging; submitted = waiting for the admin; validated = closed. */
    lodging_status: LodgingStatus;
    /** The admin's observations when returning the arrangement (cleared on validate). */
    lodging_note?: string | null;
    lodging_submitted_at?: string | null;
    lodging_reviewed_at?: string | null;
    /**
     * Administration adjustments (2.17.0): when the admin side last changed the arrangement while it was
     * submitted / validated, who (null without Localidades › ver) and how many changes since the
     * coordinator's last submission (0 = none).
     */
    lodging_admin_changed_at?: string | null;
    lodging_admin_changed_by?: string | null;
    lodging_admin_changes?: number;
    /** Rooms allotted to this location (COUNT). */
    rooms_allotted?: number;
    /** Beds allotted to this location (SUM of the allotted rooms' capacity). */
    beds_allotted?: number;
    /** Its attendees with a room (any room, pool included). */
    lodged?: number;
    /** Its non-cancelled attendees without a room. */
    unlodged?: number;
}

export type LodgingStatus = 'draft' | 'submitted' | 'validated';

/**
 * A location is frozen while under review or validated: the COORDINATOR cannot edit it until the admin reopens
 * it; the admin side still can (2.17.0 — each change is recorded on it as an administration adjustment).
 */
export const isLodgingFrozen = (status?: string | null): boolean =>
    status === 'submitted' || status === 'validated';

/** One broken rule as reported by the server's arrangement audit. */
export interface LodgingViolation {
    rule: string;
    detail: string;
    hard: boolean | number;
}

/** Attendee projection carried by GET /locations/:id/lodging (plus the conference's dynamic field columns). */
export interface LodgingOccupant {
    id: number;
    first_name: string;
    last_name: string;
    gender?: string;
    family_group?: string;
    status?: string | null;
    [field: string]: any;
}

export interface LodgingReviewRoom {
    id: number;
    hotel_name: string;
    room_number: string;
    capacity: number;
    gender?: string;
    is_family?: number;
    family_name?: string;
    notes?: string;
    occupied: number;
    occupants: LodgingOccupant[];
}

/** Response of GET /locations/:id/lodging — everything the admin needs to review one location's arrangement. */
export interface LodgingReview {
    location: {
        id: number;
        name: string;
        lodging_status: LodgingStatus;
        lodging_note?: string | null;
        lodging_submitted_at?: string | null;
        lodging_reviewed_at?: string | null;
        /** Administration adjustments since the last submission (2.17.0); see Location. */
        lodging_admin_changed_at?: string | null;
        lodging_admin_changed_by?: string | null;
        lodging_admin_changes?: number;
        capacity: number | null;
        inscribed: number;
    };
    rooms: LodgingReviewRoom[];
    unassigned: LodgingOccupant[];
    placed_elsewhere: { id: number; first_name: string; last_name: string; hotel_name: string; room_number: string }[];
    rules: { conference: AssignmentRule[]; location: AssignmentRule[] };
    violations: LodgingViolation[];
    counts: { placed: number; unassigned: number; hard_violations: number; soft_violations: number; placed_elsewhere: number };
}

/** «Sugerir reparto» (2.20.0): options and result of POST /assignment/plan. */
/** `fresh` (2.21.0): «Rehacer todo el reparto» — the draft locations' whole arrangement thought again (people move). */
export interface LodgingPlanOptions { replan?: boolean; share?: boolean; hotel_id?: number | null; fresh?: boolean; divide_families?: boolean }
/** The rooms the plan may fill, one set (2.21.0): used and their empty beds, free (nobody in them) and their beds. */
export interface LodgingPlanRoomsView { used_rooms?: number; used_empty_beds?: number; free_rooms?: number; free_beds?: number }
/** A plan's measure (2.21.0): `rooms` / `empty_beds` — the rooms holding the people it places — and the rooms view. */
export interface LodgingPlanMeasure extends LodgingPlanRoomsView { hard: number; unplaced: number; rooms: number; empty_beds: number }
/** One answer of «Sugerir reparto» (2.21.0): families kept together, or divided to use fewer rooms. */
export interface LodgingPlanVariant extends LodgingPlanMeasure { families_divided: number; /** today's arrangement, unchanged */ today?: boolean }
export type LodgingAllotment = { kind: 'pool' } | { kind: 'whole'; location_id: number; location_name?: string | null } | { kind: 'shared'; shares: { location_id: number; beds: number; location_name?: string | null }[]; lock?: ShareLock[] };
export interface LodgingPlanRoom {
    room_id: number; room_number: string; hotel_id: number; hotel_name: string; capacity: number;
    before: LodgingAllotment; after: LodgingAllotment; changed?: boolean;
    people?: { location_id: number | null; location_name: string | null; count: number }[]; labels?: string[]; empty_beds?: number;
}
export interface LodgingPlan {
    options: { replan: boolean; share: boolean; hotel_id: number | null; fresh?: boolean; divide_families?: boolean };
    /** What the administration holds and the plan leaves as it is (2.21.0): blocked rooms, people fixed in their room. */
    held?: { rooms: number; people: number };
    /** Both answers, families together and divided (2.21.0); null when no preferred family could be divided. */
    variants?: { chosen: 'keep' | 'divide'; keep: LodgingPlanVariant; divide: LodgingPlanVariant; same: boolean } | null;
    /** The order the locations get beds in when they do not reach everyone (2.21.0). */
    order?: { location_id: number; name: string; state?: 'waiting' | 'settled' | 'frozen' }[];
    /** «Rehacer todo»: how many people who have a bed end up in another one (or none) (2.21.0). */
    moved?: number;
    /** Beds short: more people waiting than free beds (2.21.0). */
    short?: { people: number; beds: number } | null;
    /** Hard «mantener juntos» groups bigger than every free room: no arrangement keeps them together (2.21.0). */
    oversized?: { rule: string; value: string; people: number; largest_room: number; hard?: boolean }[];
    /** Preferred mixed families the plan divides by the hard «separar por» so that more people get a bed (2.21.0). */
    families_split?: number;
    /** The bounds no arrangement beats (ignoring every rule) and whether this plan reaches them (2.21.0). */
    proof?: { people: number; beds: number; unplaced_min: number; rooms_min: number; beds_optimal: boolean; rooms_optimal: boolean } | null;
    people: number;
    rooms: LodgingPlanRoom[]; released: LodgingPlanRoom[];
    /** `settled` (2.21.0): everyone of it already has a bed — not touched unless «Rehacer todo»; violations = today's. */
    locations: { location_id: number; name: string; people: number; rooms: number; beds: number; shared_rooms: number; unplaced: number; settled?: boolean; violations: { rule: string; detail: string; hard: boolean }[] }[];
    pool: { people: number; rooms: number; unplaced: number } | null;
    totals: { rooms: number; beds: number; empty_beds: number; shared: number; changed: number };
    /** Today (the current allotment and the automatic assignment) and with the plan, for the same people (2.21.0). */
    current?: LodgingPlanMeasure; after?: LodgingPlanMeasure; worse?: boolean;
    /** Nothing the plan found beats today's arrangement: the suggestion is to leave it (2.21.0). */
    keeps_today?: boolean;
    simulation: { assigned: number; remaining: number; hard: number; violations: { rule: string; detail: string; hard: boolean }[] };
    skipped_frozen: { location_id: number; name: string; status: string }[];
    changes: { room_id: number; after: LodgingAllotment }[];
    token: string;
}
/** Result of POST /assignment/run — totals plus one entry per delegated location the run covered or skipped. */
export interface AssignmentRunReport {
    assignedCount: number;
    remaining: number;
    violations: LodgingViolation[];
    by_location?: { location_id: number; name: string; assignedCount: number; remaining: number; violations: LodgingViolation[] }[];
    skipped_frozen?: { location_id: number; name: string; status: LodgingStatus }[];
}

/** The closed vocabulary of forms of payment — cash or bank transfer (mirrors the plugin). */
export const PAYMENT_METHODS = ['Efectivo', 'Transferencia'] as const;

export interface AssignmentRule {
    id: number;
    conference_id: number;
    name: string;
    type: 'keep_together' | 'separate_by' | 'split_by' | 'require_companion' | 'group_together' | 'exclusive';
    enabled: number;
    priority: number;
    config?: string;
    params?: any;   // type-specific: min_size, when[], subject[], needs[], min
    hard?: number;  // 1 = must never be violated; 0 = soft preference
}

export interface ConferenceField {
    id: number;
    conference_id: number;
    name: string;
    label: string;
    type: 'text' | 'number' | 'select' | 'date';
    options?: string;
    is_required: number;
    sort_order: number;
    width?: number;
    role?: string;            // what a base field is for (first_name / last_name / email / phone / gender); set by the templates
    is_group?: number;        // this field groups attendees (one per conference)
    is_unique?: number;       // this field's value must be unique within the conference
}

export interface FeeRule {
    id: number;
    conference_id: number;
    label?: string;
    field_name?: string;
    // 2.36.4: in / not_in (a JSON list in `value`), between (a JSON [from, to]), before / after (a date).
    operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'filled' | 'empty' | 'any' | 'in' | 'not_in' | 'between' | 'before' | 'after';
    value?: string;
    action: 'set' | 'add';
    amount: number;
    priority: number;
    enabled: number;
}

/**
 * A fee payment PART (one person's share of a payment) as GET /inscriptions/:id/payments lists it. Since
 * 2.18.0 every part belongs to a payment (`transfer`); the receipt is no longer in the list (`has_proof`,
 * fetched on demand with feePaymentsApi.getProof). See lib/feePayments.ts PersonPart.
 */
export type Payment = PersonPart;

/**
 * /reports/summary. Since 2.18.0 the money follows «Pagos de cuotas» › Resumen's per-person model: `due` =
 * Cuotas (a cancelled inscription owes 0), `paid` = Validado (each person's validated money up to the fee),
 * `pending` = Por validar, `to_cover` = Por cobrar, `credit` = A favor; due − paid = pending + to_cover. The
 * pill counts are of ACTIVE people (`people`); `cancelled_count` apart; `owing_count` = active people with
 * something no payment covers yet (the Dashboard's «Con saldo»).
 */
export interface ReportFigures {
    count: number; people?: number; due: number; paid: number;
    pending?: number; returned?: number; to_cover?: number; credit?: number;
    paid_count?: number; partial_count?: number; unpaid_count?: number; owing_count?: number; cancelled_count?: number;
}
export interface ReportSummary {
    totals: ReportFigures & { total: number; assigned_count: number; paid_count: number; partial_count: number; unpaid_count: number };
    byLocation: (ReportFigures & { location: string })[];
    byGender: { gender: string; count: number }[];
}

// Transport (2.11.0) — sold apart from the participation fee.
export interface TransportTicket {
    id: number;
    bus_id: number;
    inscription_id: number;
    /** Price at sale time. */
    price: number;
    amount_paid: number;
    payment_status: 'paid' | 'partial' | 'unpaid' | string;
    created_at?: string;
    /** 2.26.0: the package sale this seat belongs to — price / paid / status above are the SALE's. */
    sale_id?: number | null;
    package_id?: number | null;
    package_name?: string | null;
}
/** A sale of a transport package to one person (2.26.0): the money of transport. */
export interface PackageSale { id: number; package_id: number; inscription_id: number; price: number; amount_paid: number; payment_status: string; created_at?: string | null }
/** A transport package (2.26.0): a fixed list of buses sold together at one price. */
export interface TransportPackage { id: number; conference_id: number; name: string; price: number; notes?: string | null; buses: { id: number; name: string }[]; sold: number; revenue: number; collected: number; sales: PackageSale[] }
export interface PackagePayment { id: number; sale_id: number; amount: number; method: string; reference?: string | null; date: string; recorded_by?: string | null }
export interface Bus {
    id: number;
    conference_id: number;
    name: string;
    origin?: string | null;
    destination?: string | null;
    /** 'YYYY-MM-DDTHH:mm' (as entered) or null. */
    departure?: string | null;
    capacity: number;
    price: number;
    notes?: string | null;
    sold: number;
    /** Sum of the prices of the tickets sold. */
    revenue: number;
    /** Sum of the transport payments received. */
    collected: number;
    passengers: TransportTicket[];
    /** 2.27.0: boarding state — 'scheduled' until the team starts boarding, then 'boarding', then 'departed'. */
    status?: 'scheduled' | 'boarding' | 'departed';
    boarding_at?: string | null;
    departed_at?: string | null;
    /** Passengers of this bus with the bus notices on (their «Mi inscripción» phones). */
    alerts?: number;
}
/** A bus notice (2.27.0): a step of the boarding or a message, and how many phones it reached. */
export interface BusNotice { id: number; kind: 'boarding' | 'departed' | 'message'; text: string | null; at: string | null; recipients: number; sent: number; failed: number }
export interface NoticeResult {
    success: boolean;
    bus: { status: 'scheduled' | 'boarding' | 'departed'; boarding_at: string | null; departed_at: string | null };
    /** Absent for a reset. network = false: the plugin lacks the «network» permission, nothing was pushed. */
    delivery?: { subscribers: number; sent: number; failed: number; network: boolean };
}
export interface TransportPayment {
    id: number;
    ticket_id: number;
    amount: number;
    method: string;
    reference?: string | null;
    date: string;
    recorded_by?: string | null;
}
export type BusInput = { name: string; origin?: string; destination?: string; departure?: string; capacity: number | string; price: number | string; notes?: string };

// Meals (2.14.0) — shapes of the /meals routes (see lib/meals.ts for the helpers).
export type MealServiceInput = { service_date: string; meal: string; label?: string | null; start_time?: string | null; end_time?: string | null; notes?: string | null };
export type MealsOverview = {
    services: MealService[];
    locations: { id: number; name: string }[];
    plan: { location_id: number; service_id: number }[];
    overrides_count: number;
};
export type MealPerson = {
    id: number; name: string; first_name?: string; last_name?: string; location: string | null; location_id: number | null;
    family_group: string | null; reg_code: string | null; document_number: string | null; status: string;
    entitled: number; delivered: number; includes: number; excludes: number;
};
export type MealPersonService = {
    id: number; service_date: string; meal: string; label: string | null; start_time: string | null; end_time: string | null;
    entitled: boolean | number; source: 'location' | 'include' | 'exclude' | 'none'; override: 'include' | 'exclude' | null; planned: boolean | number;
    delivered_at: string | null; delivery_id: number | null; method: string | null; delivered_by: string | null;
};
export type MealPersonDetail = {
    person: { id: number; name: string; location: string | null; location_id: number | null; family_group: string | null; reg_code: string | null; status: string; conference_id: number };
    services: MealPersonService[];
};
/** 2.16.0: `fields` = the conference's configured delivery-card entries (only those values travel). */
export type MealVerdictPerson = { id: number; name: string; location: string | null; location_id: number | null; family_group: string | null; reg_code: string | null; fields?: MealDisplayField[] };
export type MealDisplayField = { key: string; label: string; value: string | null; hidden?: boolean };
export type MealVerdictService = { id: number; service_date: string; meal: string; label: string | null; start_time: string | null; end_time: string | null };
export type MealVerdict = {
    result: 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference';
    service_id: number;
    service?: MealVerdictService;
    person?: MealVerdictPerson;
    delivery_id?: number; delivered_at?: string; delivered_by?: string | null; method?: string | null; note?: string | null; source?: string;
};
/** POST /meals/check (2.16.0, read-only): what /meals/deliver would do — 'ready' delivers, 'not_entitled' needs force. */
export type MealCheck = Omit<MealVerdict, 'result'> & { result: 'ready' | 'not_entitled' | 'already' | 'cancelled' | 'unknown' | 'other_conference' };
export type MealDisplaySettings = {
    conference_id: number; keys: string[]; configured: boolean; default_keys: string[];
    available: { key: string; label: string; builtin: boolean; type?: string }[];
};
/** A row of GET /meals/services/:id/deliveries; `service_id` = the service it delivered (the answer's `service`). */
export type MealDeliveryRow = {
    delivery_id: number; service_id: number; inscription_id: number; name: string; location: string | null; location_id: number | null;
    family_group: string | null; reg_code: string | null; delivered_at: string; delivered_by: string | null; method: string | null; note: string | null;
};

// Staff & permissions (2.15.0) — WordJS users the administrator adds to the team with a customizable
// role (a level per section). The server resolves and enforces every level; the admin UI only mirrors
// them to stop offering actions that would answer 403.
export type StaffLevel = 'none' | 'view' | 'manage';
export type StaffSection =
    | 'dashboard' | 'inscriptions' | 'payments' | 'locations' | 'lodging' | 'transport'
    | 'accounting' | 'meals' | 'meals_delivery' | 'badges' | 'health' | 'reports' | 'settings';
export type StaffPermissions = Record<StaffSection, StaffLevel>;
/** Every section with the levels it accepts, in display order (mirrors the server's list). */
export const STAFF_SECTIONS: { key: StaffSection; levels: StaffLevel[] }[] = [
    { key: 'dashboard', levels: ['none', 'view'] },
    { key: 'inscriptions', levels: ['none', 'view', 'manage'] },
    { key: 'payments', levels: ['none', 'view', 'manage'] },
    { key: 'locations', levels: ['none', 'view', 'manage'] },
    { key: 'lodging', levels: ['none', 'view', 'manage'] },
    { key: 'transport', levels: ['none', 'view', 'manage'] },
    { key: 'accounting', levels: ['none', 'view', 'manage'] },
    { key: 'meals', levels: ['none', 'view', 'manage'] },
    { key: 'meals_delivery', levels: ['none', 'manage'] },
    { key: 'badges', levels: ['none', 'view', 'manage'] },
    // «Datos de salud» (2.32.0): the answers to «Condiciones de salud» (special-category data).
    { key: 'health', levels: ['none', 'view', 'manage'] },
    { key: 'reports', levels: ['none', 'view'] },
    { key: 'settings', levels: ['none', 'view', 'manage'] },
];
export interface StaffMe {
    isAdmin: boolean;
    isStaff: boolean;
    /** Every section present; an administrator gets the highest level of each. */
    permissions: StaffPermissions;
    /** 2.16.0: the account has the WordJS role «Equipo de conferencia» (the only one that may be on the team). */
    teamRole?: boolean;
    /** 2.16.0: the account is on the team list (active or not). */
    member?: boolean;
    user: { id: number; name: string };
}
export interface StaffRole {
    id: number;
    name: string;
    permissions: Partial<StaffPermissions>;
    members: number;
    created_at?: string;
    updated_at?: string;
}
/** `role` = the WordJS role slug; `team_role` = it is «Equipo de conferencia», the only role that may join (2.16.0). */
export interface StaffUser { id: number; login: string; email: string; name: string; role: string; team_role?: boolean }
export interface StaffMember {
    id: number;
    user_id: number;
    role_id: number;
    role_name: string;
    active: boolean;
    added_by?: string | null;
    created_at?: string;
    /** null when the WordJS user no longer exists (or the users:read grant is missing). */
    user: StaffUser | null;
    /** 2.16.0: false = the account lost the WordJS team role (no section until it is given back); null = unknown. */
    team_role?: boolean | null;
}

export const conferenceApi = {
    // Staff & permissions (2.15.0)
    /** Any signed-in user: 200 with every section 'none' for someone who is not on the team. */
    getStaffMe: () => apiGet<StaffMe>('/plugin/conference-manager/staff/me'),
    getStaffRoles: () => apiGet<{ roles: StaffRole[]; sections: { key: StaffSection; levels: StaffLevel[] }[] }>('/plugin/conference-manager/staff/roles'),
    /** 409 = a role with that name exists; 400 = unknown section / level. */
    createStaffRole: (data: { name: string; permissions: Partial<StaffPermissions> }) =>
        apiPost<{ success: boolean; id: number }>('/plugin/conference-manager/staff/roles', data),
    updateStaffRole: (id: number, data: { name?: string; permissions?: Partial<StaffPermissions> }) =>
        apiPut<{ success: boolean }>(`/plugin/conference-manager/staff/roles/${id}`, data),
    /** 409 while the role still has members (the message says how many). */
    deleteStaffRole: (id: number) => apiDelete<{ success: boolean }>(`/plugin/conference-manager/staff/roles/${id}`),
    // roles_ready: the team role exists and opens the panel (false = roles:declare not granted); null = unknown.
    getStaffMembers: () => apiGet<{ members: StaffMember[]; users_read?: boolean; roles_ready?: boolean | null }>('/plugin/conference-manager/staff/members'),
    /** 409 already a member; 400 an administrator / unknown role; 404 unknown user; 503 users:read not granted. */
    addStaffMember: (data: { user_id: number; role_id: number }) =>
        apiPost<{ success: boolean; id: number }>('/plugin/conference-manager/staff/members', data),
    updateStaffMember: (id: number, data: { role_id?: number; active?: boolean }) =>
        apiPut<{ success: boolean }>(`/plugin/conference-manager/staff/members/${id}`, data),
    removeStaffMember: (id: number) => apiDelete<{ success: boolean }>(`/plugin/conference-manager/staff/members/${id}`),
    /** By name, e-mail or login; 503 when the plugin lacks the users:read grant. */
    searchStaffUsers: (q: string) =>
        apiGet<{ users: StaffUser[] }>(`/plugin/conference-manager/staff/user-search?q=${encodeURIComponent(q)}`),

    // Conferences
    getConferences: () => apiGet<Conference[]>('/plugin/conference-manager/list'),
    createConference: (data: Partial<Conference>) => apiPost('/plugin/conference-manager/create', data),
    updateConference: (id: number, data: Partial<Conference>) => apiPut(`/plugin/conference-manager/${id}`, data),
    deleteConference: (id: number) => apiDelete(`/plugin/conference-manager/${id}`),

    // Locations
    getLocations: (conferenceId: number) => apiGet<{ locations: Location[], conference: Conference }>(`/plugin/conference-manager/locations?conference_id=${conferenceId}`),
    createLocation: (conferenceId: number, data: { name: string, responsible_name: string, responsible_phone: string, capacity: number | string, payment_methods?: string[] }) =>
        apiPost('/plugin/conference-manager/locations', { ...data, conference_id: conferenceId }),
    updateLocation: (id: number, data: { name?: string, responsible_name?: string, responsible_phone?: string, rotate_code?: boolean, capacity?: number | string, payment_methods?: string[], lodging_opens?: string | null, lodging_closes?: string | null, lodging_tz?: string | null }) =>
        apiPut(`/plugin/conference-manager/locations/${id}`, data),
    deleteLocation: (id: number) => apiDelete(`/plugin/conference-manager/locations/${id}`),

    // Lodging per location: the admin allots rooms and validates the coordinator's arrangement — and may
    // change a submitted / validated one directly (2.17.0): every lodging write below answers
    // `lodging_adjusted`, the submitted / validated locations it changed (recorded on them).
    /** Allot every room of the hotel (or only `room_ids`) to a location; `location_id: null` sends them back to the pool. */
    allotHotel: (hotelId: number, data: { location_id: number | null; room_ids?: number[] }) =>
        apiPost<{ success: boolean; rooms: number; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/hotels/${hotelId}/allot`, data),
    getLocationLodging: (id: number) => apiGet<LodgingReview>(`/plugin/conference-manager/locations/${id}/lodging`),
    /**
     * `seen` (2.17.0): the review the admin is looking at (admin/LodgingAdjust.tsx reviewSeen). When the
     * arrangement changed since — an administration adjustment, a new submission — the server answers 409 with
     * `code: 'lodging_changed'` instead of validating / returning something nobody reviewed.
     */
    validateLodging: (id: number, seen?: { submitted_at: string | null; admin_changes: number }) =>
        apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/validate`, seen ? { seen } : {}),
    returnLodging: (id: number, note: string, seen?: { submitted_at: string | null; admin_changes: number }) =>
        apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/return`, seen ? { note, seen } : { note }),
    reopenLodging: (id: number) => apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/reopen`, {}),

    // Hotels (requires conference_id)
    getHotels: (conferenceId: number) => apiGet<Hotel[]>(`/plugin/conference-manager/hotels?conference_id=${conferenceId}`),
    /** What the badge QR puts before a code (2.23.0: the «Mi inscripción» link), or null = the bare code. */
    qrLink: (conferenceId: number) => apiGet<{ prefix: string | null }>(`/plugin/conference-manager/qr-link?conference_id=${conferenceId}`),
    createHotel: (conferenceId: number, data: Partial<Hotel>) =>
        apiPost('/plugin/conference-manager/hotels', { ...data, conference_id: conferenceId }),
    updateHotel: (id: number, data: Partial<Hotel>) => apiPut(`/plugin/conference-manager/hotels/${id}`, data),
    deleteHotel: (id: number) => apiDelete<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/hotels/${id}`),

    // Rooms
    createRoom: (data: Partial<Room>) => apiPost('/plugin/conference-manager/rooms', data),
    /** `location_id` (number | null) re-allots a single room (409 while it holds attendees of another location). */
    updateRoom: (id: number, data: Partial<Room> & { location_id?: number | null }) => apiPut<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/rooms/${id}`, data),
    deleteRoom: (id: number) => apiDelete<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/rooms/${id}`),
    /** Block / unblock a room (2.21.0): the engine (suggestions, runs, resets, «Dar camas») leaves a blocked room as it is. */
    setRoomBlocked: (id: number, blocked: boolean) => apiPut<{ success: boolean; blocked: boolean }>(`/plugin/conference-manager/rooms/${id}/block`, { blocked }),
    /** Fix / unfix a person in their room (2.21.0): the engine never moves a fixed person; taking them out by hand lifts it. */
    pinInscription: (id: number, pinned: boolean) => apiPut<{ success: boolean; pinned: boolean }>(`/plugin/conference-manager/inscriptions/${id}/pin`, { pinned }),
    /** Split a room's beds between locations (2.18.0): no share = pool room; one location with every bed = its whole room. */
    setRoomBeds: (id: number, shares: { location_id: number; beds: number }[], opts?: { release_lock?: boolean }) =>
        apiPut<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/rooms/${id}/beds`, { shares, ...(opts || {}) }),
    /** Give a location N free beds (2.18.0): whole empty rooms first, then shared beds. 409 `not_enough_beds` with `available`. */
    giveLocationBeds: (locationId: number, data: { beds: number; hotel_id?: number | null }) =>
        apiPost<GiveBedsResult>(`/plugin/conference-manager/locations/${locationId}/beds`, data),

    // Inscriptions (requires conference_id)
    getInscriptions: (conferenceId: number, params: any = {}) => {
        const queryParams = { ...params, conference_id: conferenceId };
        const q = new URLSearchParams(queryParams).toString();
        return apiGet<Inscription[]>(`/plugin/conference-manager/inscriptions?${q}`);
    },
    createInscription: (conferenceId: number, data: Partial<Inscription>) =>
        apiPost('/plugin/conference-manager/inscriptions', { ...data, conference_id: conferenceId }),
    /** Moving the attendee out of a submitted / validated location also takes Hospedaje › gestionar (409). */
    updateInscription: (id: number, data: Partial<Inscription>) =>
        apiPut<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/inscriptions/${id}`, data),
    deleteInscription: (id: number) => apiDelete<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/inscriptions/${id}`),

    // Assign
    /**
     * Move one attendee into a room (roomId) or out of any room (null). The server refuses, with the
     * message the UI shows verbatim: a cancelled attendee (400), a full room (400) and a room allotted to
     * another location (400 «Esa habitación está asignada a la localidad …»); the lodging explorer
     * pre-checks the same cases client-side (lib/lodgingView.ts). An attendee of a submitted / validated
     * location is moved all the same (2.17.0): `lodging_adjusted` names that location.
     */
    assignRoom: (inscriptionId: number, roomId: number | null) =>
        apiPost<{ success: boolean; lodging_adjusted?: LodgingAdjusted[] }>(`/plugin/conference-manager/inscriptions/${inscriptionId}/assign`, { room_id: roomId }),

    /** 2.18.0: one roster row (same shape and gate as GET /inscriptions) — a single-row patch after an action. */
    getInscription: (id: number) => apiGet<Inscription>(`/plugin/conference-manager/inscriptions/${id}`),

    // Fee payments: one person's parts (the person sheet's «Pago» section). «Pagos de cuotas» is feePaymentsApi.
    getPayments: (inscriptionId: number) => apiGet<Payment[]>(`/plugin/conference-manager/inscriptions/${inscriptionId}/payments`),

    // Assignment
    // all: also every location's own rules (each with location_name) — for the delete-field warning.
    getAssignmentRules: (conferenceId: number, opts: { all?: boolean } = {}) => apiGet<AssignmentRule[]>(`/plugin/conference-manager/assignment/rules?conference_id=${conferenceId}${opts.all ? '&all=1' : ''}`),
    saveAssignmentRule: (data: Partial<AssignmentRule>) => apiPost('/plugin/conference-manager/assignment/rules', data),
    deleteAssignmentRule: (id: number) => apiDelete(`/plugin/conference-manager/assignment/rules/${id}`),
    runAssignment: (conferenceId: number) => apiPost<AssignmentRunReport>('/plugin/conference-manager/assignment/run', { conference_id: conferenceId }),
    // «Sugerir reparto» (2.20.0): the allotment of free rooms that uses the fewest rooms and keeps every rule,
    // checked by running the automatic assignment on a copy; /apply writes it only while it is the same plan.
    planLodging: (conferenceId: number, opts: LodgingPlanOptions = {}) => apiPost<{ success: boolean; plan: LodgingPlan }>('/plugin/conference-manager/assignment/plan', { conference_id: conferenceId, ...opts }),
    // The locations' order when the beds do not reach everyone (2.21.0): that order first, the rest by name.
    setLodgingOrder: (conferenceId: number, locationIds: number[]) => apiPost<{ success: boolean; location_ids: number[] }>('/plugin/conference-manager/assignment/location-order', { conference_id: conferenceId, location_ids: locationIds }),
    applyLodgingPlan: (conferenceId: number, token: string, opts: LodgingPlanOptions = {}) => apiPost<{ success: boolean; changed: number; plan: LodgingPlan }>('/plugin/conference-manager/assignment/plan/apply', { conference_id: conferenceId, token, ...opts }),
    // What the automatic assignment would do now (nothing is written).
    simulateAssignment: (conferenceId: number) => apiPost<AssignmentRunReport & { placements: { inscription_id: number; room_id: number | null; from_room_id: number | null }[] }>('/plugin/conference-manager/assignment/simulate', { conference_id: conferenceId }),
    // Clears every scope except the frozen locations, which come back in `skipped_frozen`.
    resetAssignments: (conferenceId: number) => apiPost<{ success: boolean; skipped_frozen?: { location_id: number; name: string }[] }>('/plugin/conference-manager/assignment/reset', { conference_id: conferenceId }),

    // Fields
    // «Condiciones de salud» (2.32.0) is left out unless asked for (`health: true`): its answers are not a column, so
    // a list, a picker or a rule must never offer it. The form builder and the inscription form (with
    // Datos de salud › ver) ask for it.
    getFields: (conferenceId: number, opts: { health?: boolean } = {}) => apiGet<ConferenceField[]>(`/plugin/conference-manager/fields?conference_id=${conferenceId}`)
        .then((list) => (opts.health || !Array.isArray(list) ? list : list.filter((f) => !isHealthField(f)))),
    /** 2.32.0: one person's answer to «Condiciones de salud» (Datos de salud › ver). */
    getInscriptionHealth: (id: number) => apiGet<{ field: { name: string; label: string } | null; answer: HealthAnswer | null; verbal_required?: boolean }>(`/plugin/conference-manager/inscriptions/${id}/health`),
    /** 2.33.0: does the conference ask for «Autorización de datos»? (2.34.0: a new health answer then needs the verbal tick.) */
    getConsentEnabled: (conferenceId: number) => apiGet<{ enabled: boolean }>(`/plugin/conference-manager/consent/states?conference_id=${conferenceId}`).then((r) => !!(r && r.enabled)),
    /** 2.32.0: «Turnos de comida». */
    getMealPriority: (conferenceId: number) => apiGet<any>(`/plugin/conference-manager/meals/priority?conference_id=${conferenceId}`),
    saveMealPriorityConfig: (conferenceId: number, data: Record<string, unknown>) => apiPut<any>('/plugin/conference-manager/meals/priority/config', { conference_id: conferenceId, ...data }),
    freezeMealGroups: (conferenceId: number, unfreeze = false) => apiPost<any>('/plugin/conference-manager/meals/priority/freeze', { conference_id: conferenceId, ...(unfreeze ? { unfreeze: true } : {}) }),
    setMealGroup: (inscriptionId: number, group: string | null) => apiPut<any>(`/plugin/conference-manager/meals/priority/people/${inscriptionId}`, { group }),
    saveField: (data: Partial<ConferenceField>) => apiPost('/plugin/conference-manager/fields', data),
    /** 2.16.0: add a base field from its template (lib/fields.ts FIELD_TEMPLATES). 409 = the form already has it. */
    addFieldTemplate: (conferenceId: number, template: string, label?: string) =>
        apiPost<{ success: boolean; id: number; name: string; is_group: number }>('/plugin/conference-manager/fields', { conference_id: conferenceId, template, label }),
    deleteField: (id: number) => apiDelete(`/plugin/conference-manager/fields/${id}`),
    publishForm: (conferenceId: number, published: boolean) => apiPost('/plugin/conference-manager/publish', { conference_id: conferenceId, published }),

    // Fee rules (dynamic pricing)
    getFeeRules: (conferenceId: number) => apiGet<FeeRule[]>(`/plugin/conference-manager/fee-rules?conference_id=${conferenceId}`),
    saveFeeRule: (data: Partial<FeeRule>) => apiPost('/plugin/conference-manager/fee-rules', data),
    deleteFeeRule: (id: number) => apiDelete(`/plugin/conference-manager/fee-rules/${id}`),
    /** 2.36.4, the rule builder: the values a field has in this conference (with how many people have each), or the people. */
    feeRuleValues: (conferenceId: number, field: string) => apiGet<{ field: string; values?: { value: string; count: number }[]; people?: { id: number; name: string; location: string; document: string }[] }>(`/plugin/conference-manager/fee-rules?conference_id=${conferenceId}&values=${encodeURIComponent(field)}`),
    /** «Esta regla aplica a N personas»: the condition as typed, nothing saved. */
    previewFeeRule: (data: { conference_id: number; field_name: string; operator: string; value: any }) => apiPost<{ count: number; total: number; sample: string[] }>('/plugin/conference-manager/fee-rules', { ...data, preview: true }),
    repriceAll: (conferenceId: number) => apiPost<{ success: boolean; total: number; updated: number }>('/plugin/conference-manager/reprice', { conference_id: conferenceId }),

    // Transport (2.11.0)
    getBuses: (conferenceId: number) => apiGet<Bus[]>(`/plugin/conference-manager/buses?conference_id=${conferenceId}`),
    /** Boarding check (2.25.0): does the scanned badge (code or QR link) travel on this bus? Read only. */
    busNotice: (busId: number, kind: 'boarding' | 'departed' | 'message' | 'reset', text?: string) => apiPost<NoticeResult>(`/plugin/conference-manager/buses/${busId}/notice`, { kind, text }),
    getBusNotices: (busId: number) => apiGet<BusNotice[]>(`/plugin/conference-manager/buses/${busId}/notices`),
    checkBoarding: (busId: number, code: string) => apiPost<BoardingCheck>(`/plugin/conference-manager/transport/check`, { bus_id: busId, code }),
    createBus: (conferenceId: number, data: BusInput) => apiPost<{ success: boolean; id: number }>('/plugin/conference-manager/buses', { ...data, conference_id: conferenceId }),
    updateBus: (id: number, data: Partial<BusInput> & { reprice_tickets?: boolean }) => apiPut(`/plugin/conference-manager/buses/${id}`, data),
    deleteBus: (id: number) => apiDelete(`/plugin/conference-manager/buses/${id}`),
    addPassengers: (busId: number, inscriptionIds: number[]) => apiPost<{ success: boolean; added: number; skipped: number }>(`/plugin/conference-manager/buses/${busId}/passengers`, { inscription_ids: inscriptionIds }),
    removePassenger: (busId: number, inscriptionId: number) => apiDelete(`/plugin/conference-manager/buses/${busId}/passengers/${inscriptionId}`),
    getTicketPayments: (ticketId: number) => apiGet<TransportPayment[]>(`/plugin/conference-manager/tickets/${ticketId}/payments`),
    addTicketPayment: (ticketId: number, data: { amount: number; method: string; reference?: string; date?: string }) => apiPost(`/plugin/conference-manager/tickets/${ticketId}/payments`, data),
    deleteTransportPayment: (id: number) => apiDelete(`/plugin/conference-manager/transport-payments/${id}`),
    // Transport packages (2.26.0)
    getPackages: (conferenceId: number) => apiGet<TransportPackage[]>(`/plugin/conference-manager/transport/packages?conference_id=${conferenceId}`),
    createPackage: (conferenceId: number, data: { name: string; price: number | string; notes?: string; bus_ids: number[] }) => apiPost<{ success: boolean; id: number }>(`/plugin/conference-manager/transport/packages`, { conference_id: conferenceId, ...data }),
    updatePackage: (id: number, data: { name?: string; price?: number | string; notes?: string; bus_ids?: number[]; reprice_sales?: boolean }) => apiPut(`/plugin/conference-manager/transport/packages/${id}`, data),
    deletePackage: (id: number) => apiDelete(`/plugin/conference-manager/transport/packages/${id}`),
    sellPackage: (id: number, inscriptionIds: number[]) => apiPost<{ success: boolean; added: number; skipped: number }>(`/plugin/conference-manager/transport/packages/${id}/sales`, { inscription_ids: inscriptionIds }),
    removePackageSale: (saleId: number) => apiDelete(`/plugin/conference-manager/transport/package-sales/${saleId}`),
    getSalePayments: (saleId: number) => apiGet<PackagePayment[]>(`/plugin/conference-manager/transport/package-sales/${saleId}/payments`),
    addSalePayment: (saleId: number, data: { amount: number; method: string; reference?: string; date?: string }) => apiPost(`/plugin/conference-manager/transport/package-sales/${saleId}/payments`, data),
    deletePackagePayment: (id: number) => apiDelete(`/plugin/conference-manager/transport/package-payments/${id}`),

    // Accounting (2.12.0) — manual entries; fee and transport payments come back read-only in getLedger.
    getLedger: (conferenceId: number) => apiGet<{ entries: any[]; totals: { income: number; expense: number; balance: number }; categories: { income: string[]; expense: string[] } }>(`/plugin/conference-manager/accounting?conference_id=${conferenceId}`),
    createLedgerEntry: (conferenceId: number, data: { kind: 'income' | 'expense'; date: string; description: string; amount: number; category?: string; method?: string | null; reference?: string }) => apiPost<{ success: boolean; id: number }>('/plugin/conference-manager/accounting/entries', { ...data, conference_id: conferenceId }),
    updateLedgerEntry: (id: number, data: Record<string, unknown>) => apiPut(`/plugin/conference-manager/accounting/entries/${id}`, data),
    deleteLedgerEntry: (id: number) => apiDelete(`/plugin/conference-manager/accounting/entries/${id}`),

    // Meals (2.14.0) — services (one meal on one day), the location plan, per-person overrides and
    // deliveries. Entitlement and every counter are computed by the server.
    getMeals: (conferenceId: number) => apiGet<MealsOverview>(`/plugin/conference-manager/meals?conference_id=${conferenceId}`),
    createMealService: (conferenceId: number, data: MealServiceInput & { location_ids?: number[] | null }) =>
        apiPost<{ success: boolean; id: number; planned: number }>('/plugin/conference-manager/meals/services', { ...data, conference_id: conferenceId }),
    /** Creates the missing date × meal combinations (≤ 60 dates); existing ones are skipped, their plan untouched. */
    bulkCreateMealServices: (conferenceId: number, data: { dates: string[]; meals: string[]; location_ids?: number[] | null }) =>
        apiPost<{ success: boolean; created: number; skipped: number; ids: number[] }>('/plugin/conference-manager/meals/services/bulk', { ...data, conference_id: conferenceId }),
    updateMealService: (id: number, data: Partial<Pick<MealServiceInput, 'label' | 'start_time' | 'end_time' | 'notes'>>) =>
        apiPut<{ success: boolean }>(`/plugin/conference-manager/meals/services/${id}`, data),
    /** Without `force` a service with deliveries answers 409 (requiresConfirm). */
    deleteMealService: (id: number, force = false) =>
        apiDelete<{ success: boolean; deleted_deliveries: number }>(`/plugin/conference-manager/meals/services/${id}${force ? '?force=1' : ''}`),
    setLocationMealPlan: (conferenceId: number, locationId: number, serviceIds: number[]) =>
        apiPut<{ success: boolean; location_id: number; service_ids: number[] }>('/plugin/conference-manager/meals/plan', { conference_id: conferenceId, location_id: locationId, service_ids: serviceIds }),
    setServiceMealPlan: (serviceId: number, locationIds: number[]) =>
        apiPut<{ success: boolean; service_id: number; location_ids: number[] }>(`/plugin/conference-manager/meals/services/${serviceId}/plan`, { location_ids: locationIds }),
    toggleMealPlan: (locationId: number, serviceId: number, enabled: boolean) =>
        apiPost<{ success: boolean }>('/plugin/conference-manager/meals/plan/toggle', { location_id: locationId, service_id: serviceId, enabled }),
    /** `location_id`: a number, or 'none' for attendees without a location. The server ignores case and accents in `q`. */
    getMealPeople: (conferenceId: number, params: { q?: string; location_id?: number | 'none' | ''; limit?: number; offset?: number } = {}) => {
        const q = new URLSearchParams({ conference_id: String(conferenceId) });
        if (params.q) q.set('q', params.q);
        if (params.location_id !== undefined && params.location_id !== '') q.set('location_id', String(params.location_id));
        if (params.limit) q.set('limit', String(params.limit));
        if (params.offset) q.set('offset', String(params.offset));
        return apiGet<{ people: MealPerson[]; total: number; limit: number; offset: number; services_count: number }>(`/plugin/conference-manager/meals/people?${q.toString()}`);
    },
    getMealPerson: (inscriptionId: number) => apiGet<MealPersonDetail>(`/plugin/conference-manager/meals/inscriptions/${inscriptionId}`),
    setMealOverride: (inscriptionId: number, data: { service_id?: number; service_ids?: number[]; mode: 'include' | 'exclude' | 'inherit' }) =>
        apiPut<{ success: boolean }>(`/plugin/conference-manager/meals/inscriptions/${inscriptionId}/overrides`, data),
    /** Always 200 with a verdict for normal outcomes; 404 = the service no longer exists. Send the RAW scanned text as `code`. */
    deliverMeal: (data: { service_id: number; code?: string; inscription_id?: number; force?: boolean; note?: string }) =>
        apiPost<MealVerdict>('/plugin/conference-manager/meals/deliver', data),
    /** Read-only (2.16.0): the confirmation card's verdict, service and configured person fields. Records nothing. */
    checkMeal: (data: { service_id: number; code?: string; inscription_id?: number }) =>
        apiPost<MealCheck>('/plugin/conference-manager/meals/check', data),
    /** What the delivery card shows for a conference (2.16.0). */
    getMealDisplayFields: (conferenceId: number) => apiGet<MealDisplaySettings>(`/plugin/conference-manager/meals/display-fields?conference_id=${conferenceId}`),
    /** `keys` in display order; null = back to the default (name + location). Needs Alimentación › gestionar. */
    setMealDisplayFields: (conferenceId: number, keys: string[] | null) =>
        apiPut<{ success: boolean; conference_id: number; keys: string[]; configured: boolean }>('/plugin/conference-manager/meals/display-fields', { conference_id: conferenceId, keys }),
    undoMealDelivery: (deliveryId: number) => apiDelete<{ success: boolean }>(`/plugin/conference-manager/meals/deliveries/${deliveryId}`),
    getMealServiceStats: (serviceId: number) => apiGet<{ service_id: number; entitled: number; delivered: number; pending: number; overrides_delivered: number; by_location: any[] }>(`/plugin/conference-manager/meals/services/${serviceId}/stats`),
    /** Newest first; `service` names what every row delivered (day, meal, label). */
    getMealServiceDeliveries: (serviceId: number, limit = 20) => apiGet<{ service_id: number; service: MealVerdictService; deliveries: MealDeliveryRow[] }>(`/plugin/conference-manager/meals/services/${serviceId}/deliveries?limit=${limit}`),
    getMealServiceReport: (serviceId: number) => apiGet<any>(`/plugin/conference-manager/meals/services/${serviceId}/report`),

    // Reports
    getReportSummary: (conferenceId: number) => apiGet<ReportSummary>(`/plugin/conference-manager/reports/summary?conference_id=${conferenceId}`),
    // The sandbox returns JSON only, so the CSV comes back as a string field; the client turns it
    // into a downloadable file (see ReportsPage.downloadCsv).
    exportCsv: (conferenceId: number, params: Record<string, string> = {}) => {
        const q = new URLSearchParams({ ...params, conference_id: String(conferenceId) }).toString();
        return apiGet<{ csv: string; filename: string; count: number }>(`/plugin/conference-manager/inscriptions/export?${q}`);
    },
};

/**
 * «Pagos de cuotas» (2.18.0) — the admin side of split fee payments (server/fee-payments.js). Errors are
 * `{ error, code }`: api() throws an Error carrying `status` and `code` (lib/feePayments.ts feeErrorText
 * turns the code into text). Every action on an existing payment sends `expected` (its status and
 * allocation generation as the admin saw them): a 409 `stale` means someone else changed it.
 */
const FEES = '/plugin/conference-manager/fee-payments';
export type FeeExpected = { status: string; alloc_gen: number };
export const feePaymentsApi = {
    /** The whole section in one call: summary, per location, counts, every payment (no receipts) and each person's balance. */
    getView: (conferenceId: number) => apiGet<FeeView>(`${FEES}?conference_id=${conferenceId}`),
    /** One payment with each person's facts (name, location, due, money elsewhere, after-state) and its history. */
    getTransfer: (id: number) => apiGet<Transfer>(`${FEES}/${id}`),
    /** The receipt (a data URL), on demand. 404 `no_proof` when there is none. */
    getProof: (id: number) => apiGet<{ id: number; proof: string }>(`${FEES}/${id}/proof`),
    /** Born validated unless `leave_pending`. A repeated `client_key` answers the first result (`replayed`). */
    create: (body: Record<string, unknown>) => apiPost<{ success: boolean; id: number; replayed: boolean; transfer: Transfer }>(FEES, body),
    /** Pending or returned only; the result is pending again. The body carries `expected`. */
    update: (id: number, body: Record<string, unknown>) => apiPut<{ success: boolean; transfer: Transfer }>(`${FEES}/${id}`, body),
    // `allowDuplicateReference`: the admin confirmed that a voided transfer validated again is ANOTHER transfer than
    // the live payment that uses its reference (the server answers 409 duplicate_reference otherwise).
    validate: (id: number, expected: FeeExpected, allowDuplicateReference = false) => apiPost<{ success: boolean; status: string; transfer: Transfer }>(`${FEES}/${id}/validate`, allowDuplicateReference ? { expected, allow_duplicate_reference: true } : { expected }),
    /** «Devolver»: the recorder corrects it and resends. A note is required. */
    giveBack: (id: number, note: string, expected: FeeExpected) => apiPost<{ success: boolean; status: string; transfer: Transfer }>(`${FEES}/${id}/return`, { note, expected }),
    /** «Rechazar» (also «Anular validación» of a validated payment). A reason is required. */
    reject: (id: number, note: string, expected: FeeExpected) => apiPost<{ success: boolean; status: string; transfer: Transfer }>(`${FEES}/${id}/reject`, { note, expected }),
    /** A pending, returned or rejected payment (a validated one answers 409 `validated_delete`). */
    remove: (id: number, expected?: FeeExpected) => api<{ success: boolean }>(`${FEES}/${id}`, { method: 'DELETE', body: expected ? { expected } : undefined }),
};
