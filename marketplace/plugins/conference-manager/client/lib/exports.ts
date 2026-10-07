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
        // Transport is sold apart from the fee: its own columns, never mixed into `balance`.
        { key: 'transport', label: 'Transporte', width: 28 },
        { key: 'transport_due', label: 'Transporte $', money: true, width: 13 },
        { key: 'transport_paid', label: 'Transporte pagado', money: true, width: 16 },
        { key: 'transport_balance', label: 'Transporte saldo', money: true, width: 15 },
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
/** Per-attendee transport totals (built from GET /buses by transportByPerson). */
export type PersonTransport = { labels: string[]; due: number; paid: number };

/** Index the buses' tickets by attendee: bus names, ticket prices and payments summed. */
export function transportByPerson(buses: { name: string; passengers?: { inscription_id: number; price: number; amount_paid: number }[] }[]): Map<number, PersonTransport> {
    const out = new Map<number, PersonTransport>();
    for (const b of buses) {
        for (const t of b.passengers || []) {
            const k = Number(t.inscription_id);
            if (!out.has(k)) out.set(k, { labels: [], due: 0, paid: 0 });
            const e = out.get(k)!;
            e.labels.push(b.name);
            e.due = round2(e.due + num(t.price));
            e.paid = round2(e.paid + num(t.amount_paid));
        }
    }
    return out;
}

export function columnValue(p: ExportPerson, key: string, extra: { transport?: Map<number, PersonTransport> } = {}): XlsxCell {
    if (key.startsWith('field:')) {
        const v = fieldValue(p, key.slice(6));
        return v === undefined || v === null ? '' : (typeof v === 'number' ? v : String(v));
    }
    switch (key) {
        case 'status': return STATUS_LABEL[String(p.status || 'pending')] || String(p.status || '');
        case 'payment_status': return PAYMENT_LABEL[String(p.payment_status || 'unpaid')] || String(p.payment_status || '');
        case 'total_due': return { money: round2(num(p.total_due)) };
        case 'amount_paid': return { money: round2(num(p.amount_paid)) };
        // The participation fee only — transport has its own columns.
        case 'balance': return { money: round2(num(p.total_due) - num(p.amount_paid)) };
        case 'transport': return (extra.transport?.get(Number(p.id))?.labels || []).join(', ');
        case 'transport_due': return { money: extra.transport?.get(Number(p.id))?.due ?? 0 };
        case 'transport_paid': return { money: extra.transport?.get(Number(p.id))?.paid ?? 0 };
        case 'transport_balance': { const t = extra.transport?.get(Number(p.id)); return { money: t ? round2(t.due - t.paid) : 0 }; }
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
    transport?: Map<number, PersonTransport>;
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
 * The sheets without the column titled `header` (in every sheet that has it; rows keep their alignment).
 * Used to drop «Código» for a role that never receives registration codes — an always-empty column reads
 * as missing data.
 */
export function withoutColumn(sheets: XlsxSheet[], header: string): XlsxSheet[] {
    return sheets.map((s) => {
        const i = s.columns.findIndex((c) => c.header === header);
        if (i < 0) return s;
        return { ...s, columns: s.columns.filter((_, k) => k !== i), rows: s.rows.map((r) => (r.length > i ? r.filter((_, k) => k !== i) : r)) };
    });
}

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

export type ManifestBus = { id: number; name: string; origin?: string | null; destination?: string | null; departure?: string | null; capacity: number; price: number; sold?: number; revenue?: number; collected?: number; passengers?: { inscription_id: number; price: number; amount_paid: number; payment_status: string }[] };

const route = (b: ManifestBus) => [b.origin, b.destination].filter(Boolean).join(' → ');
const when = (v?: string | null) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : String(v || ''); };

/** Transport workbook: "Resumen" (one row per bus) + one passenger list per bus (or only `onlyBusId`). */
export function buildBusManifest(opts: { buses: ManifestBus[]; people: ExportPerson[]; fields: ExportField[]; onlyBusId?: number | null }): XlsxSheet[] {
    const byId = new Map(opts.people.map((p) => [Number(p.id), p]));
    const buses = opts.buses.filter((b) => opts.onlyBusId == null || Number(b.id) === Number(opts.onlyBusId));
    const summary: XlsxSheet = {
        name: 'Resumen',
        columns: [{ header: 'Bus', width: 24 }, { header: 'Trayecto', width: 30 }, { header: 'Salida', width: 18 }, { header: 'Capacidad', width: 11 }, { header: 'Vendidos', width: 10 }, { header: 'Libres', width: 9 }, { header: 'Precio', width: 11 }, { header: 'Vendido $', width: 13 }, { header: 'Recaudado $', width: 13 }, { header: 'Por cobrar $', width: 13 }],
        rows: [], boldRows: [],
    };
    const sheets: XlsxSheet[] = [];
    let tCap = 0, tSold = 0, tRev = 0, tCol = 0;
    for (const b of buses) {
        const tickets = b.passengers || [];
        const rev = round2(tickets.reduce((a, t) => a + num(t.price), 0));
        const col = round2(tickets.reduce((a, t) => a + num(t.amount_paid), 0));
        tCap += num(b.capacity); tSold += tickets.length; tRev += rev; tCol += col;
        summary.rows.push([b.name, route(b), when(b.departure), num(b.capacity), tickets.length, Math.max(0, num(b.capacity) - tickets.length), { money: num(b.price) }, { money: rev }, { money: col }, { money: round2(rev - col) }]);
        const rows: XlsxCell[][] = tickets
            .map((t) => ({ t, p: byId.get(Number(t.inscription_id)) || { id: t.inscription_id } }))
            .sort((x, y) => displayName(x.p, opts.fields).localeCompare(displayName(y.p, opts.fields), 'es'))
            .map(({ t, p }, i) => [i + 1, displayName(p, opts.fields), String(p.location || ''), String(p.reg_code || ''), String(fieldValue(p, 'phone') ?? ''), { money: num(t.price) }, { money: num(t.amount_paid) }, { money: round2(num(t.price) - num(t.amount_paid)) }, PAYMENT_LABEL[String(t.payment_status || 'unpaid')] || String(t.payment_status || '')]);
        sheets.push({
            name: b.name,
            columns: [{ header: '#', width: 5 }, { header: 'Pasajero', width: 30 }, { header: 'Localidad', width: 18 }, { header: 'Código', width: 14 }, { header: 'Teléfono', width: 15 }, { header: 'Precio', width: 11 }, { header: 'Pagado', width: 11 }, { header: 'Saldo', width: 11 }, { header: 'Estado', width: 11 }],
            rows: rows.length ? rows : [['', '(sin pasajeros)']],
        });
    }
    summary.boldRows!.push(summary.rows.length);
    summary.rows.push(['TOTAL', '', '', tCap, tSold, Math.max(0, tCap - tSold), '', { money: round2(tRev) }, { money: round2(tCol) }, { money: round2(tRev - tCol) }]);
    return opts.onlyBusId != null ? sheets : [summary, ...sheets];
}

/** `inscripciones-<slug>-2026-10-05.xlsx` */
export function exportFilename(prefix: string, slug?: string | null): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = String(slug || '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${prefix}${s ? '-' + s : ''}-${date}.xlsx`;
}
