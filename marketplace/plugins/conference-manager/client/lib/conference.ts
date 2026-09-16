// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../frontend/src/lib/api";

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
}

export interface Inscription {
    id: number;
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
}

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

export const conferenceApi = {
    // Conferences
    getConferences: () => apiGet<Conference[]>('/plugin/conference-manager/list'),
    createConference: (data: Partial<Conference>) => apiPost('/plugin/conference-manager/create', data),
    updateConference: (id: number, data: Partial<Conference>) => apiPut(`/plugin/conference-manager/${id}`, data),
    deleteConference: (id: number) => apiDelete(`/plugin/conference-manager/${id}`),

    // Locations
    getLocations: (conferenceId: number) => apiGet<{ locations: Location[], conference: Conference }>(`/plugin/conference-manager/locations?conference_id=${conferenceId}`),
    createLocation: (conferenceId: number, data: { name: string, responsible_name: string, responsible_phone: string }) =>
        apiPost('/plugin/conference-manager/locations', { ...data, conference_id: conferenceId }),
    updateLocation: (id: number, data: { name?: string, responsible_name?: string, responsible_phone?: string, rotate_code?: boolean }) =>
        apiPut(`/plugin/conference-manager/locations/${id}`, data),
    deleteLocation: (id: number) => apiDelete(`/plugin/conference-manager/locations/${id}`),

    // Hotels (requires conference_id)
    getHotels: (conferenceId: number) => apiGet<Hotel[]>(`/plugin/conference-manager/hotels?conference_id=${conferenceId}`),
    createHotel: (conferenceId: number, data: Partial<Hotel>) =>
        apiPost('/plugin/conference-manager/hotels', { ...data, conference_id: conferenceId }),
    updateHotel: (id: number, data: Partial<Hotel>) => apiPut(`/plugin/conference-manager/hotels/${id}`, data),
    deleteHotel: (id: number) => apiDelete(`/plugin/conference-manager/hotels/${id}`),

    // Rooms
    createRoom: (data: Partial<Room>) => apiPost('/plugin/conference-manager/rooms', data),
    updateRoom: (id: number, data: Partial<Room>) => apiPut(`/plugin/conference-manager/rooms/${id}`, data),
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
    assignRoom: (inscriptionId: number, roomId: number | null) =>
        apiPost(`/plugin/conference-manager/inscriptions/${inscriptionId}/assign`, { room_id: roomId }),

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
    runAssignment: (conferenceId: number) => apiPost('/plugin/conference-manager/assignment/run', { conference_id: conferenceId }),
    resetAssignments: (conferenceId: number) => apiPost('/plugin/conference-manager/assignment/reset', { conference_id: conferenceId }),

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

    // Reports
    getReportSummary: (conferenceId: number) => apiGet<ReportSummary>(`/plugin/conference-manager/reports/summary?conference_id=${conferenceId}`),
    // The sandbox returns JSON only, so the CSV comes back as a string field; the client turns it
    // into a downloadable file (see ReportsPage.downloadCsv).
    exportCsv: (conferenceId: number, params: Record<string, string> = {}) => {
        const q = new URLSearchParams({ ...params, conference_id: String(conferenceId) }).toString();
        return apiGet<{ csv: string; filename: string; count: number }>(`/plugin/conference-manager/inscriptions/export?${q}`);
    },
};
