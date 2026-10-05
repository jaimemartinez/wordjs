/**
 * Excel exports of the conference-manager admin (pure — no React, no fetch; the page feeds the data).
 *
 * - Custom roster: the admin picks and orders the columns (form fields + operational ones), filters
 *   the attendees and may add a barcode image column built from each registration code.
 * - Hotel assignment report: a summary sheet plus one sheet per hotel, room by room.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';

export type ExportField = { name: string; label?: string | null };
export type ExportPerson = Record<string, any>;
export type ExportLocation = { id: number; name: string };

export type ExportColumn = { key: string; label: string; money?: boolean; width?: number };

const PAYMENT_LABEL: Record<string, string> = { paid: 'Pagado', partial: 'Parcial', unpaid: 'Pendiente' };
const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', active: 'Activo', cancelled: 'Cancelado' };

/** A form field's value: its own column first, then the legacy custom_data blob. */
export function fieldValue(p: ExportPerson, name: string): any {
    const v = p[name];
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = p.custom_data && typeof p.custom_data === 'object' ? p.custom_data : null;
    return cd ? cd[name] : undefined;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Every column the custom export can offer, form fields first (in form order), then operational ones. */
export function availableColumns(fields: ExportField[]): ExportColumn[] {
    const formCols = fields.map((f) => ({ key: `field:${f.name}`, label: String(f.label || f.name) }));
    return [
        ...formCols,
        { key: 'reg_code', label: 'Código de inscripción', width: 16 },
        { key: 'location', label: 'Localidad' },
        { key: 'status', label: 'Estado', width: 12 },
        { key: 'payment_status', label: 'Estado de pago', width: 14 },
        { key: 'total_due', label: 'Cuota', money: true, width: 12 },
        { key: 'amount_paid', label: 'Pagado', money: true, width: 12 },
        { key: 'balance', label: 'Saldo', money: true, width: 12 },
        { key: 'hotel_name', label: 'Hotel' },
        { key: 'room_number', label: 'Habitación', width: 12 },
        { key: 'registration_date', label: 'Fecha de inscripción', width: 20 },
        { key: 'notes', label: 'Notas (admin)', width: 30 },
    ];
}

/** The default selection: the first two form fields, the code, location, payment and lodging. */
export function defaultColumnKeys(fields: ExportField[]): string[] {
    return [
        ...fields.slice(0, 2).map((f) => `field:${f.name}`),
        'reg_code', 'location', 'payment_status', 'balance', 'hotel_name', 'room_number',
    ];
}

/** One cell of the custom roster. `extra` carries values the page resolves (e.g. transport labels). */
export function columnValue(p: ExportPerson, key: string, extra: { transport?: Map<number, string> } = {}): XlsxCell {
    if (key.startsWith('field:')) {
        const v = fieldValue(p, key.slice(6));
        return v === undefined || v === null ? '' : (typeof v === 'number' ? v : String(v));
    }
    switch (key) {
        case 'status': return STATUS_LABEL[String(p.status || 'pending')] || String(p.status || '');
        case 'payment_status': return PAYMENT_LABEL[String(p.payment_status || 'unpaid')] || String(p.payment_status || '');
        case 'total_due': return { money: round2(num(p.total_due)) };
        case 'transport_due': return { money: round2(num(p.transport_due)) };
        case 'amount_paid': return { money: round2(num(p.amount_paid)) };
        case 'balance': return { money: round2(num(p.total_due) + num(p.transport_due) - num(p.amount_paid)) };
        case 'transport': return extra.transport?.get(Number(p.id)) || '';
        case 'registration_date': return p.registration_date ? String(p.registration_date) : '';
        default: return p[key] === undefined || p[key] === null ? '' : String(p[key]);
    }
}

export type RosterFilter = { locationId?: number | null; paymentStatus?: string | null; excludeCancelled?: boolean };

export function filterRoster(people: ExportPerson[], f: RosterFilter): ExportPerson[] {
    return people.filter((p) =>
        (f.locationId == null || Number(p.location_id) === Number(f.locationId))
        && (!f.paymentStatus || String(p.payment_status || 'unpaid') === f.paymentStatus)
        && (!f.excludeCancelled || p.status !== 'cancelled'));
}

export type BarcodeImage = { png: Uint8Array; width: number; height: number };

/**
 * The custom roster sheet. `columns` are the chosen keys in order; `barcodes` (optional) maps an
 * attendee id to the PNG of its registration-code barcode, placed in a last "Código de barras" column.
 */
export function buildRosterSheet(opts: {
    people: ExportPerson[];
    fields: ExportField[];
    columnKeys: string[];
    barcodes?: Map<number, BarcodeImage> | null;
    transport?: Map<number, string>;
    name?: string;
}): XlsxSheet {
    const all = new Map(availableColumns(opts.fields).map((c) => [c.key, c]));
    const cols = opts.columnKeys.map((k) => all.get(k)).filter((c): c is ExportColumn => !!c);
    const withBarcodes = !!opts.barcodes;
    const columns = cols.map((c) => ({ header: c.label, width: c.width ?? 22 }));
    if (withBarcodes) columns.push({ header: 'Código de barras', width: 34 });
    const rows: XlsxCell[][] = [];
    const images: XlsxSheet['images'] = [];
    opts.people.forEach((p, i) => {
        const row = cols.map((c) => columnValue(p, c.key, { transport: opts.transport }));
        if (withBarcodes) {
            row.push(null);
            const img = opts.barcodes!.get(Number(p.id));
            if (img) images.push({ row: i, col: cols.length, png: img.png, width: img.width, height: img.height });
        }
        rows.push(row);
    });
    return { name: opts.name || 'Inscripciones', columns, rows, images };
}

/** Display name: the first two non-empty form-field values, falling back to first/last name. */
export function displayName(p: ExportPerson, fields: ExportField[]): string {
    const parts: string[] = [];
    for (const f of fields) {
        const v = fieldValue(p, f.name);
        if (v !== undefined && v !== null && String(v).trim() !== '') parts.push(String(v).trim());
        if (parts.length === 2) break;
    }
    if (parts.length) return parts.join(' ');
    return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || `#${p.id}`;
}

export type ReportRoom = { id: number; room_number: string; capacity: number; location_id?: number | null; location_name?: string | null; notes?: string | null };
export type ReportHotel = { id: number; name: string; address?: string | null; rooms?: ReportRoom[] };

/**
 * Hotel assignment report: "Resumen" (one row per hotel) + one sheet per hotel listing every room
 * (bold room line: number, capacity, occupancy, allotted location) followed by its occupants.
 */
export function buildHotelReport(opts: { hotels: ReportHotel[]; people: ExportPerson[]; fields: ExportField[]; locations: ExportLocation[]; onlyHotelId?: number | null }): XlsxSheet[] {
    const byRoom = new Map<number, ExportPerson[]>();
    for (const p of opts.people) {
        if (p.room_id == null) continue;
        const k = Number(p.room_id);
        if (!byRoom.has(k)) byRoom.set(k, []);
        byRoom.get(k)!.push(p);
    }
    const locName = new Map(opts.locations.map((l) => [Number(l.id), l.name]));
    const roomNo = (r: ReportRoom) => String(r.room_number ?? '');
    const sortRooms = (rooms: ReportRoom[]) => [...rooms].sort((a, b) => roomNo(a).localeCompare(roomNo(b), 'es', { numeric: true }));
    const hotels = opts.hotels.filter((h) => opts.onlyHotelId == null || Number(h.id) === Number(opts.onlyHotelId));

    const summary: XlsxSheet = {
        name: 'Resumen',
        columns: [{ header: 'Hotel', width: 28 }, { header: 'Habitaciones', width: 14 }, { header: 'Camas', width: 10 }, { header: 'Ocupadas', width: 11 }, { header: 'Libres', width: 10 }, { header: 'Ocupación', width: 12 }],
        rows: [],
        boldRows: [],
    };
    const sheets: XlsxSheet[] = [];
    let totRooms = 0, totBeds = 0, totUsed = 0;
    for (const h of hotels) {
        const rooms = sortRooms(h.rooms || []);
        const beds = rooms.reduce((a, r) => a + Math.max(0, num(r.capacity)), 0);
        const used = rooms.reduce((a, r) => a + (byRoom.get(Number(r.id))?.length || 0), 0);
        totRooms += rooms.length; totBeds += beds; totUsed += used;
        summary.rows.push([h.name, rooms.length, beds, used, Math.max(0, beds - used), beds ? `${Math.round((used / beds) * 100)}%` : '—']);

        const sheet: XlsxSheet = {
            name: h.name,
            columns: [
                { header: 'Habitación', width: 13 }, { header: 'Capacidad', width: 11 }, { header: 'Ocupación', width: 11 },
                { header: 'Asignada a', width: 20 }, { header: 'Participante', width: 30 }, { header: 'Género', width: 9 },
                { header: 'Grupo familiar', width: 18 }, { header: 'Localidad', width: 18 }, { header: 'Código', width: 14 },
            ],
            rows: [],
            boldRows: [],
        };
        for (const r of rooms) {
            const occ = (byRoom.get(Number(r.id)) || []).slice().sort((a, b) => displayName(a, opts.fields).localeCompare(displayName(b, opts.fields), 'es'));
            const allotted = r.location_id != null ? (r.location_name || locName.get(Number(r.location_id)) || `#${r.location_id}`) : 'General';
            sheet.boldRows!.push(sheet.rows.length);
            sheet.rows.push([roomNo(r), num(r.capacity), `${occ.length}/${num(r.capacity)}`, allotted, occ.length ? '' : '(vacía)', '', '', '', '']);
            for (const p of occ) {
                sheet.rows.push(['', '', '', '', displayName(p, opts.fields), String(p.gender || ''), String(fieldValue(p, 'family_group') ?? ''), String(p.location || locName.get(Number(p.location_id)) || ''), String(p.reg_code || '')]);
            }
        }
        if (!rooms.length) sheet.rows.push(['(sin habitaciones)']);
        sheets.push(sheet);
    }
    summary.boldRows!.push(summary.rows.length);
    summary.rows.push(['TOTAL', totRooms, totBeds, totUsed, Math.max(0, totBeds - totUsed), totBeds ? `${Math.round((totUsed / totBeds) * 100)}%` : '—']);
    return opts.onlyHotelId != null ? sheets : [summary, ...sheets];
}

/** `inscripciones-<slug>-2026-10-05.xlsx` */
export function exportFilename(prefix: string, slug?: string | null): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = String(slug || '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${prefix}${s ? '-' + s : ''}-${date}.xlsx`;
}
