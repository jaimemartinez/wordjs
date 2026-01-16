import { apiGet, apiPost, apiDelete } from "@/lib/api";

export interface Conference {
    id: number;
    name: string;
    slug: string;
    status: string;
    fee_default: number;
    date_start?: string;
    date_end?: string;
    description?: string;
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
    room_id?: number;
    notes?: string;
    hotel_name?: string;
    room_number?: string;
}

export const conferenceApi = {
    // Conferences
    getConferences: () => apiGet<Conference[]>('/conference/list'),
    createConference: (data: Partial<Conference>) => apiPost('/conference/create', data),
    deleteConference: (id: number) => apiDelete(`/conference/${id}`),

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
    addPayment: (inscriptionId: number, data: { amount: number, method: string, reference: string }) =>
        apiPost(`/conference/inscriptions/${inscriptionId}/payments`, data),
};
