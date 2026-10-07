// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../frontend/src/lib/api";
import type { MealService } from "./meals";

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
    /** Deadline for the coordinators' lodging arrangements ('YYYY-MM-DD' or a datetime); null = none. */
    lodging_deadline?: string | null;
    /** Computed by GET /locations: the deadline is over (a bare date covers its whole day). */
    lodging_deadline_passed?: boolean;
}

export interface Hotel {
    id: number;
    name: string;
    address: string;
    description: string;
    capacity: number;
    rooms?: Room[];
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
    room_id?: number | null;
    notes?: string;
    hotel_name?: string;
    room_number?: string;
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
    'id', 'conference_id', 'total_due', 'amount_paid', 'payment_status', 'pending_amount',
    'registration_date', 'room_id', 'room_number', 'hotel_name', 'custom_data', 'location',
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
        if (!f.name || INSCRIPTION_READONLY_KEYS.includes(f.name)) continue;
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

/** Money for display: 2 decimals, integer-cents rounding (matches the server's arithmetic). */
export const fmtMoney = (v: unknown): string =>
    (Math.round((Number(v) || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Which payment actions the state machine allows (mirrors the server's 409 rules). */
export const paymentActions = (status?: string | null) => {
    const s = status || 'pending';
    return {
        validate: s === 'pending' || s === 'rejected',
        reject: s === 'pending' || s === 'validated',
        remove: s === 'pending' || s === 'rejected',
    };
};

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
    /** The admin's exception to the lodging deadline for this location (2.8.0). */
    lodging_permission?: boolean;
    /** End of the permission ('YYYY-MM-DD' or a datetime); null = until revoked. */
    lodging_permission_until?: string | null;
    lodging_permission_active?: boolean;
    lodging_permission_expired?: boolean;
    /** Can the coordinator change the lodging right now (window open and still a draft)? */
    lodging_can_edit?: boolean;
    // --- Lodging per location (2.5.0) -------------------------------------------------------
    /** draft = the coordinator is arranging; submitted = waiting for the admin; validated = closed. */
    lodging_status: LodgingStatus;
    /** The admin's observations when returning the arrangement (cleared on validate). */
    lodging_note?: string | null;
    lodging_submitted_at?: string | null;
    lodging_reviewed_at?: string | null;
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

/** A location is frozen (the coordinator can't edit, the admin must reopen) while under review or validated. */
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
    role?: string;            // legacy; superseded by the flags below
    is_group?: number;        // this field groups attendees (one per conference)
    is_unique?: number;       // this field's value must be unique within the conference
}

export interface FeeRule {
    id: number;
    conference_id: number;
    label?: string;
    field_name?: string;
    operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'filled' | 'empty' | 'any';
    value?: string;
    action: 'set' | 'add';
    amount: number;
    priority: number;
    enabled: number;
}

export interface Payment {
    id: number;
    inscription_id: number;
    amount: number;
    date: string;
    method: string;
    reference?: string;
    proof?: string;
    status?: 'pending' | 'validated' | 'rejected';
}

export interface ReportSummary {
    totals: {
        total: number; due: number; paid: number;
        paid_count: number; partial_count: number; unpaid_count: number; assigned_count: number;
    };
    byLocation: { location: string; count: number; due: number; paid: number }[];
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
}
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
export type MealVerdictPerson = { id: number; name: string; location: string | null; location_id: number | null; family_group: string | null; reg_code: string | null };
export type MealVerdict = {
    result: 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference';
    service_id: number;
    person?: MealVerdictPerson;
    delivery_id?: number; delivered_at?: string; delivered_by?: string | null; method?: string | null; note?: string | null; source?: string;
};
export type MealDeliveryRow = {
    delivery_id: number; inscription_id: number; name: string; location: string | null; location_id: number | null;
    family_group: string | null; reg_code: string | null; delivered_at: string; delivered_by: string | null; method: string | null; note: string | null;
};

// Staff & permissions (2.15.0) — WordJS users the administrator adds to the team with a customizable
// role (a level per section). The server resolves and enforces every level; the admin UI only mirrors
// them to stop offering actions that would answer 403.
export type StaffLevel = 'none' | 'view' | 'manage';
export type StaffSection =
    | 'dashboard' | 'inscriptions' | 'payments' | 'locations' | 'lodging' | 'transport'
    | 'accounting' | 'meals' | 'meals_delivery' | 'reports' | 'settings';
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
    { key: 'reports', levels: ['none', 'view'] },
    { key: 'settings', levels: ['none', 'view', 'manage'] },
];
export interface StaffMe {
    isAdmin: boolean;
    isStaff: boolean;
    /** Every section present; an administrator gets the highest level of each. */
    permissions: StaffPermissions;
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
export interface StaffUser { id: number; login: string; email: string; name: string; role: string }
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
    getStaffMembers: () => apiGet<{ members: StaffMember[] }>('/plugin/conference-manager/staff/members'),
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
    updateLocation: (id: number, data: { name?: string, responsible_name?: string, responsible_phone?: string, rotate_code?: boolean, capacity?: number | string, payment_methods?: string[], lodging_permission?: boolean, lodging_permission_until?: string | null }) =>
        apiPut(`/plugin/conference-manager/locations/${id}`, data),
    deleteLocation: (id: number) => apiDelete(`/plugin/conference-manager/locations/${id}`),

    // Lodging per location: the admin allots rooms and only validates the coordinator's arrangement.
    /** Allot every room of the hotel (or only `room_ids`) to a location; `location_id: null` sends them back to the pool. */
    allotHotel: (hotelId: number, data: { location_id: number | null; room_ids?: number[] }) =>
        apiPost<{ success: boolean; rooms: number }>(`/plugin/conference-manager/hotels/${hotelId}/allot`, data),
    getLocationLodging: (id: number) => apiGet<LodgingReview>(`/plugin/conference-manager/locations/${id}/lodging`),
    validateLodging: (id: number) => apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/validate`, {}),
    returnLodging: (id: number, note: string) => apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/return`, { note }),
    reopenLodging: (id: number) => apiPost<{ success: boolean }>(`/plugin/conference-manager/locations/${id}/lodging/reopen`, {}),

    // Hotels (requires conference_id)
    getHotels: (conferenceId: number) => apiGet<Hotel[]>(`/plugin/conference-manager/hotels?conference_id=${conferenceId}`),
    createHotel: (conferenceId: number, data: Partial<Hotel>) =>
        apiPost('/plugin/conference-manager/hotels', { ...data, conference_id: conferenceId }),
    updateHotel: (id: number, data: Partial<Hotel>) => apiPut(`/plugin/conference-manager/hotels/${id}`, data),
    deleteHotel: (id: number) => apiDelete(`/plugin/conference-manager/hotels/${id}`),

    // Rooms
    createRoom: (data: Partial<Room>) => apiPost('/plugin/conference-manager/rooms', data),
    /** `location_id` (number | null) re-allots a single room; the server refuses it for a frozen location (409). */
    updateRoom: (id: number, data: Partial<Room> & { location_id?: number | null }) => apiPut(`/plugin/conference-manager/rooms/${id}`, data),
    deleteRoom: (id: number) => apiDelete(`/plugin/conference-manager/rooms/${id}`),

    // Inscriptions (requires conference_id)
    getInscriptions: (conferenceId: number, params: any = {}) => {
        const queryParams = { ...params, conference_id: conferenceId };
        const q = new URLSearchParams(queryParams).toString();
        return apiGet<Inscription[]>(`/plugin/conference-manager/inscriptions?${q}`);
    },
    createInscription: (conferenceId: number, data: Partial<Inscription>) =>
        apiPost('/plugin/conference-manager/inscriptions', { ...data, conference_id: conferenceId }),
    updateInscription: (id: number, data: Partial<Inscription>) =>
        apiPut(`/plugin/conference-manager/inscriptions/${id}`, data),
    deleteInscription: (id: number) => apiDelete(`/plugin/conference-manager/inscriptions/${id}`),

    // Assign
    /**
     * Move one attendee into a room (roomId) or out of any room (null). The server refuses, with the
     * message the UI shows verbatim: a cancelled attendee (400), a full room (400), a room allotted to
     * another location (400 «Esa habitación está asignada a la localidad …») and an attendee whose
     * location's lodging is frozen — submitted/validated (409). The accommodation board pre-checks
     * the same four cases client-side (see AccommodationBoard in admin/page.tsx).
     */
    assignRoom: (inscriptionId: number, roomId: number | null) =>
        apiPost<{ success: boolean }>(`/plugin/conference-manager/inscriptions/${inscriptionId}/assign`, { room_id: roomId }),

    // Payments
    addPayment: (inscriptionId: number, data: { amount: number, method: string, reference: string, proof?: string }) =>
        apiPost(`/plugin/conference-manager/inscriptions/${inscriptionId}/payments`, data),
    getPayments: (inscriptionId: number) => apiGet<Payment[]>(`/plugin/conference-manager/inscriptions/${inscriptionId}/payments`),
    voidPayment: (paymentId: number) => apiDelete(`/plugin/conference-manager/payments/${paymentId}`),
    validatePayment: (paymentId: number) => apiPost(`/plugin/conference-manager/payments/${paymentId}/validate`, {}),
    rejectPayment: (paymentId: number) => apiPost(`/plugin/conference-manager/payments/${paymentId}/reject`, {}),

    // Assignment
    getAssignmentRules: (conferenceId: number) => apiGet<AssignmentRule[]>(`/plugin/conference-manager/assignment/rules?conference_id=${conferenceId}`),
    saveAssignmentRule: (data: Partial<AssignmentRule>) => apiPost('/plugin/conference-manager/assignment/rules', data),
    deleteAssignmentRule: (id: number) => apiDelete(`/plugin/conference-manager/assignment/rules/${id}`),
    runAssignment: (conferenceId: number) => apiPost<AssignmentRunReport>('/plugin/conference-manager/assignment/run', { conference_id: conferenceId }),
    // Clears every scope except the frozen locations, which come back in `skipped_frozen`.
    resetAssignments: (conferenceId: number) => apiPost<{ success: boolean; skipped_frozen?: { location_id: number; name: string }[] }>('/plugin/conference-manager/assignment/reset', { conference_id: conferenceId }),

    // Fields
    getFields: (conferenceId: number) => apiGet<ConferenceField[]>(`/plugin/conference-manager/fields?conference_id=${conferenceId}`),
    saveField: (data: Partial<ConferenceField>) => apiPost('/plugin/conference-manager/fields', data),
    deleteField: (id: number) => apiDelete(`/plugin/conference-manager/fields/${id}`),
    publishForm: (conferenceId: number, published: boolean) => apiPost('/plugin/conference-manager/publish', { conference_id: conferenceId, published }),

    // Fee rules (dynamic pricing)
    getFeeRules: (conferenceId: number) => apiGet<FeeRule[]>(`/plugin/conference-manager/fee-rules?conference_id=${conferenceId}`),
    saveFeeRule: (data: Partial<FeeRule>) => apiPost('/plugin/conference-manager/fee-rules', data),
    deleteFeeRule: (id: number) => apiDelete(`/plugin/conference-manager/fee-rules/${id}`),
    repriceAll: (conferenceId: number) => apiPost<{ success: boolean; total: number; updated: number }>('/plugin/conference-manager/reprice', { conference_id: conferenceId }),

    // Transport (2.11.0)
    getBuses: (conferenceId: number) => apiGet<Bus[]>(`/plugin/conference-manager/buses?conference_id=${conferenceId}`),
    createBus: (conferenceId: number, data: BusInput) => apiPost<{ success: boolean; id: number }>('/plugin/conference-manager/buses', { ...data, conference_id: conferenceId }),
    updateBus: (id: number, data: Partial<BusInput> & { reprice_tickets?: boolean }) => apiPut(`/plugin/conference-manager/buses/${id}`, data),
    deleteBus: (id: number) => apiDelete(`/plugin/conference-manager/buses/${id}`),
    addPassengers: (busId: number, inscriptionIds: number[]) => apiPost<{ success: boolean; added: number; skipped: number }>(`/plugin/conference-manager/buses/${busId}/passengers`, { inscription_ids: inscriptionIds }),
    removePassenger: (busId: number, inscriptionId: number) => apiDelete(`/plugin/conference-manager/buses/${busId}/passengers/${inscriptionId}`),
    getTicketPayments: (ticketId: number) => apiGet<TransportPayment[]>(`/plugin/conference-manager/tickets/${ticketId}/payments`),
    addTicketPayment: (ticketId: number, data: { amount: number; method: string; reference?: string; date?: string }) => apiPost(`/plugin/conference-manager/tickets/${ticketId}/payments`, data),
    deleteTransportPayment: (id: number) => apiDelete(`/plugin/conference-manager/transport-payments/${id}`),

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
    undoMealDelivery: (deliveryId: number) => apiDelete<{ success: boolean }>(`/plugin/conference-manager/meals/deliveries/${deliveryId}`),
    getMealServiceStats: (serviceId: number) => apiGet<{ service_id: number; entitled: number; delivered: number; pending: number; overrides_delivered: number; by_location: any[] }>(`/plugin/conference-manager/meals/services/${serviceId}/stats`),
    getMealServiceDeliveries: (serviceId: number, limit = 20) => apiGet<{ service_id: number; deliveries: MealDeliveryRow[] }>(`/plugin/conference-manager/meals/services/${serviceId}/deliveries?limit=${limit}`),
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
