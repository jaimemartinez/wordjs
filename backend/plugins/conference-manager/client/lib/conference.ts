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
    location?: string;
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
