import { apiGet, apiPost, apiDelete } from "../../../../../frontend/src/lib/api";

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
    age: number;
    location?: string;
    document_type?: string;
    document_number?: string;
    blood_type?: string;
    eps?: string;
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
    type: 'family' | 'gender' | 'location';
    enabled: number;
    priority: number;
    config?: string;
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
}

export interface Payment {
    id: number;
    inscription_id: number;
    amount: number;
    date: string;
    method: string;
    reference?: string;
    proof?: string;
}

export const conferenceApi = {
    // Conferences
    getConferences: () => apiGet<Conference[]>('/conference/list'),
    createConference: (data: Partial<Conference>) => apiPost('/conference/create', data),
    deleteConference: (id: number) => apiDelete(`/conference/${id}`),

    // Locations
    getLocations: (conferenceId: number) => apiGet<{ locations: Location[], conference: Conference }>(`/conference/locations?conference_id=${conferenceId}`),
    createLocation: (conferenceId: number, data: { name: string, responsible_name: string, responsible_phone: string }) =>
        apiPost('/conference/locations', { ...data, conference_id: conferenceId }),
    deleteLocation: (id: number) => apiDelete(`/conference/locations/${id}`),

    // Hotels (requires conference_id)
    getHotels: (conferenceId: number) => apiGet<Hotel[]>(`/conference/hotels?conference_id=${conferenceId}`),
    createHotel: (conferenceId: number, data: Partial<Hotel>) =>
        apiPost('/conference/hotels', { ...data, conference_id: conferenceId }),

    // Rooms
    createRoom: (data: Partial<Room>) => apiPost('/conference/rooms', data),

    // Inscriptions (requires conference_id)
    getInscriptions: (conferenceId: number, params: any = {}) => {
        const queryParams = { ...params, conference_id: conferenceId };
        const q = new URLSearchParams(queryParams).toString();
        return apiGet<Inscription[]>(`/conference/inscriptions?${q}`);
    },
    createInscription: (conferenceId: number, data: Partial<Inscription>) =>
        apiPost('/conference/inscriptions', { ...data, conference_id: conferenceId }),

    // Assign
    assignRoom: (inscriptionId: number, roomId: number | null) =>
        apiPost(`/conference/inscriptions/${inscriptionId}/assign`, { room_id: roomId }),

    // Payments
    addPayment: (inscriptionId: number, data: { amount: number, method: string, reference: string, proof?: string }) =>
        apiPost(`/conference/inscriptions/${inscriptionId}/payments`, data),
    getPayments: (inscriptionId: number) => apiGet<Payment[]>(`/conference/inscriptions/${inscriptionId}/payments`),

    // Assignment
    getAssignmentRules: (conferenceId: number) => apiGet<AssignmentRule[]>(`/conference/assignment/rules?conference_id=${conferenceId}`),
    saveAssignmentRule: (data: Partial<AssignmentRule>) => apiPost('/conference/assignment/rules', data),
    runAssignment: (conferenceId: number) => apiPost('/conference/assignment/run', { conference_id: conferenceId }),
    resetAssignments: (conferenceId: number) => apiPost('/conference/assignment/reset', { conference_id: conferenceId }),

    // Fields
    getFields: (conferenceId: number) => apiGet<ConferenceField[]>(`/conference/fields?conference_id=${conferenceId}`),
    saveField: (data: Partial<ConferenceField>) => apiPost('/conference/fields', data),
    deleteField: (id: number) => apiDelete(`/conference/fields/${id}`),
    publishForm: (conferenceId: number, published: boolean) => apiPost('/conference/publish', { conference_id: conferenceId, published }),
};
