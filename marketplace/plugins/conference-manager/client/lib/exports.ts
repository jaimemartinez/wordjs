/**
 * Excel exports of the conference-manager admin (pure — no React, no fetch; the page feeds the data).
 *
 * - Custom roster: the admin picks and orders the columns (form fields + operational ones), filters
 *   the attendees and may add a barcode image column built from each registration code.
 * - Hotel assignment report: a summary sheet plus one sheet per hotel, room by room.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';
import { isNameFallbackField } from './fields';

export type ExportField = { name: string; label?: string | null; role?: string | null; type?: string | null; is_unique?: number | boolean | null };
export type ExportPerson = Record<string, any>;
export type ExportLocation = { id: number; name: string };

export type ExportColumn = { key: string; label: string; money?: boolean; width?: number };

// The roster pill's words (2.18.0), the same in the admin and the portal: «Sin pagar» («Pendiente» read like
// money awaiting validation, «Por validar», not an unpaid fee) and «Abono» for a partly paid fee.
const PAYMENT_LABEL: Record<string, string> = { paid: 'Pagado', partial: 'Abono', unpaid: 'Sin pagar' };
const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', active: 'Activo', cancelled: 'Cancelado' };

/** A form field's value: its own column first, then the legacy custom_data blob. */
export function fieldValue(p: ExportPerson, name: string): any {
    const v = p[name];
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = p.custom_data && typeof p.custom_data === 'object' ? p.custom_data : null;
    return cd ? cd[name] : undefined;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * A server TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' in the browser's time zone — the one every screen shows. SQLite /
 * MySQL stamps ('YYYY-MM-DD HH:MM:SS', CURRENT_TIMESTAMP) are UTC: written raw, a review done at 18:40 in Bogotá
 * read «23:40», and one after 19:00 the NEXT day (2.18.0 skeptic round 4). An ISO string with a zone is read as
 * such; a plain date ('YYYY-MM-DD') or anything unreadable is kept as it is.
 */
export function localStamp(v: unknown): string {
    const s = String(v ?? '').trim();
    if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    if (Number.isNaN(d.getTime())) return s;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
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
        // 2.18.0: fee money registered but not validated yet, and money returned to its recorder for correction.
        { key: 'pending_amount', label: 'Por validar', money: true, width: 13 },
        { key: 'returned_amount', label: 'Devuelto', money: true, width: 12 },
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

/**
 * Index the buses' seats by attendee. 2.26.0: a seat belongs to a package sale (`sale_id`, `package_name`, and the
 * sale's price / paid) — the same sale sits on every bus of its package, so each sale is counted ONCE and labelled
 * by its package; a seat without a sale (none since the packages' migration) counts as before, by its bus.
 */
export function transportByPerson(buses: { name: string; passengers?: { inscription_id: number; price: number; amount_paid: number; sale_id?: number | null; package_name?: string | null }[] }[]): Map<number, PersonTransport> {
    const out = new Map<number, PersonTransport>();
    const counted = new Set<number>();
    for (const b of buses) {
        for (const t of b.passengers || []) {
            const k = Number(t.inscription_id);
            if (t.sale_id != null) {
                if (counted.has(Number(t.sale_id))) continue;
                counted.add(Number(t.sale_id));
            }
            if (!out.has(k)) out.set(k, { labels: [], due: 0, paid: 0 });
            const e = out.get(k)!;
            e.labels.push(t.sale_id != null && t.package_name ? t.package_name : b.name);
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
        case 'pending_amount': return { money: round2(num(p.pending_amount)) };
        case 'returned_amount': return { money: round2(num(p.returned_amount)) };
        case 'transport': return (extra.transport?.get(Number(p.id))?.labels || []).join(', ');
        case 'transport_due': return { money: extra.transport?.get(Number(p.id))?.due ?? 0 };
        case 'transport_paid': return { money: extra.transport?.get(Number(p.id))?.paid ?? 0 };
        case 'transport_balance': { const t = extra.transport?.get(Number(p.id)); return { money: t ? round2(t.due - t.paid) : 0 }; }
        case 'registration_date': return p.registration_date ? localStamp(p.registration_date) : '';
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
 * attendee id to the PNG of its registration-code QR, placed in a last "Código QR" column.
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
    if (withBarcodes) columns.push({ header: 'Código QR', width: 22 });
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

/**
 * Display name, the same on every screen (lib/lodgingView.ts nameFields, index.js personName): the fields
 * tagged Nombre / Apellido, else the first_name / last_name columns, else the first two filled form fields
 * fit to stand in for a name (lib/fields.ts isNameFallbackField: never an ID document, a contact or
 * notes), else the number.
 */
export function displayName(p: ExportPerson, fields: ExportField[]): string {
    const filledVal = (name: string) => {
        const v = fieldValue(p, name);
        return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : '';
    };
    const named = ['first_name', 'last_name']
        .map(role => (fields || []).find(f => f.role === role))
        .map(f => (f ? filledVal(f.name) : ''))
        .filter(Boolean);
    if (named.length) return named.join(' ');
    const legacy = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    if (legacy) return legacy;
    const parts: string[] = [];
    for (const f of fields || []) {
        if (!isNameFallbackField(f)) continue;
        const v = filledVal(f.name);
        if (v) parts.push(v);
        if (parts.length === 2) break;
    }
    return parts.join(' ') || `#${p.id}`;
}

export type ReportRoom = {
    id: number; room_number: string; capacity: number; location_id?: number | null; location_name?: string | null; notes?: string | null;
    /** A shared room (2.18.0): each location's beds; the rest are «General» (pool) beds. */
    shares?: { location_id: number; location_name?: string | null; beds: number }[] | null; pool_beds?: number | null;
};
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
            // A shared room reads «Norte 2 · Sur 1 · General 1» (each location's beds, then the pool's).
            const shared = r.location_id == null && r.shares && r.shares.length
                ? [...r.shares.map(s => `${s.location_name || locName.get(Number(s.location_id)) || `#${s.location_id}`} ${num(s.beds)}`), ...(Number(r.pool_beds) > 0 ? [`General ${num(r.pool_beds)}`] : [])].join(' · ')
                : null;
            const allotted = r.location_id != null ? (r.location_name || locName.get(Number(r.location_id)) || `#${r.location_id}`) : (shared || 'General');
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

export type ManifestBus = { id: number; name: string; origin?: string | null; destination?: string | null; departure?: string | null; capacity: number; price: number; sold?: number; revenue?: number; collected?: number; passengers?: { inscription_id: number; price: number; amount_paid: number; payment_status: string; package_name?: string | null }[] };
/** A package for the transport workbook's «Paquetes» sheet (GET /transport/packages). */
export type ManifestPackage = { id: number; name: string; price: number; buses: { id: number; name: string }[]; sold: number; revenue: number; collected: number };

const route = (b: ManifestBus) => [b.origin, b.destination].filter(Boolean).join(' → ');
const when = (v?: string | null) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : String(v || ''); };

/**
 * Transport workbook: "Resumen" (one row per bus: its seats), "Paquetes" (2.26.0: what was sold — one row per
 * package with its money, counted once), and one passenger list per bus (or only `onlyBusId`). A passenger's row
 * shows their package and that package's payment (the same package appears on each of its buses' lists).
 */
export function buildBusManifest(opts: { buses: ManifestBus[]; people: ExportPerson[]; fields: ExportField[]; onlyBusId?: number | null; packages?: ManifestPackage[] }): XlsxSheet[] {
    const byId = new Map(opts.people.map((p) => [Number(p.id), p]));
    const buses = opts.buses.filter((b) => opts.onlyBusId == null || Number(b.id) === Number(opts.onlyBusId));
    const summary: XlsxSheet = {
        name: 'Resumen',
        columns: [{ header: 'Bus', width: 24 }, { header: 'Trayecto', width: 30 }, { header: 'Salida', width: 18 }, { header: 'Capacidad', width: 11 }, { header: 'Vendidos', width: 10 }, { header: 'Libres', width: 9 }],
        rows: [], boldRows: [],
    };
    const sheets: XlsxSheet[] = [];
    let tCap = 0, tSold = 0;
    for (const b of buses) {
        const tickets = b.passengers || [];
        tCap += num(b.capacity); tSold += tickets.length;
        summary.rows.push([b.name, route(b), when(b.departure), num(b.capacity), tickets.length, Math.max(0, num(b.capacity) - tickets.length)]);
        const rows: XlsxCell[][] = tickets
            .map((t) => ({ t, p: byId.get(Number(t.inscription_id)) || { id: t.inscription_id } }))
            .sort((x, y) => displayName(x.p, opts.fields).localeCompare(displayName(y.p, opts.fields), 'es'))
            .map(({ t, p }, i) => [i + 1, displayName(p, opts.fields), String(p.location || ''), String(p.reg_code || ''), String(fieldValue(p, 'phone') ?? ''), String(t.package_name || ''), { money: num(t.price) }, { money: num(t.amount_paid) }, { money: round2(num(t.price) - num(t.amount_paid)) }, PAYMENT_LABEL[String(t.payment_status || 'unpaid')] || String(t.payment_status || '')]);
        sheets.push({
            name: b.name,
            columns: [{ header: '#', width: 5 }, { header: 'Pasajero', width: 30 }, { header: 'Localidad', width: 18 }, { header: 'Código', width: 14 }, { header: 'Teléfono', width: 15 }, { header: 'Paquete', width: 22 }, { header: 'Precio paquete', width: 14 }, { header: 'Pagado', width: 11 }, { header: 'Saldo', width: 11 }, { header: 'Estado', width: 11 }],
            rows: rows.length ? rows : [['', '(sin pasajeros)']],
        });
    }
    summary.boldRows!.push(summary.rows.length);
    summary.rows.push(['TOTAL', '', '', tCap, tSold, Math.max(0, tCap - tSold)]);
    if (opts.onlyBusId != null) return sheets;
    const out: XlsxSheet[] = [summary];
    if (opts.packages) {
        const pk: XlsxSheet = {
            name: 'Paquetes',
            columns: [{ header: 'Paquete', width: 26 }, { header: 'Buses', width: 34 }, { header: 'Precio', width: 12 }, { header: 'Vendidos', width: 10 }, { header: 'Vendido $', width: 13 }, { header: 'Recaudado $', width: 13 }, { header: 'Por cobrar $', width: 13 }],
            rows: [], boldRows: [],
        };
        let pRev = 0, pCol = 0, pSold = 0;
        for (const p of opts.packages) {
            pRev += num(p.revenue); pCol += num(p.collected); pSold += num(p.sold);
            pk.rows.push([p.name, p.buses.map((b) => b.name).join(', '), { money: num(p.price) }, num(p.sold), { money: num(p.revenue) }, { money: num(p.collected) }, { money: round2(num(p.revenue) - num(p.collected)) }]);
        }
        pk.boldRows!.push(pk.rows.length);
        pk.rows.push(['TOTAL', '', '', pSold, { money: round2(pRev) }, { money: round2(pCol) }, { money: round2(pRev - pCol) }]);
        out.push(pk);
    }
    return [...out, ...sheets];
}

/** `inscripciones-<slug>-2026-10-05.xlsx` */
export function exportFilename(prefix: string, slug?: string | null): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = String(slug || '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${prefix}${s ? '-' + s : ''}-${date}.xlsx`;
}

// ── «Pagos de cuotas» Excel (2.18.0, Reportes permission) ─────────────────────────────────────────────────
export type FeeExportTransfer = {
    id: number; paid_on: string | null; location_id: number | null; locations?: number[]; recorded_via: string | null; recorded_by: string | null;
    method: string; reference: string | null; amount: number; people: number; status: string; reviewed_by: string | null; reviewed_at: string | null;
    note: string | null; review_note: string | null; allocations: { inscription_id: number; amount: number; location_id?: number | null }[];
};
export type FeeExportBalance = { id: number; location_id: number | null; due: number; validated: number; pending: number; returned: number; to_cover: number; credit: number; cancelled: boolean };
const FEE_STATUS_LABEL: Record<string, string> = { pending: 'Por validar', validated: 'Validado', returned: 'Devuelto', rejected: 'Rechazado' };
const VIA_LABEL: Record<string, string> = { portal: 'Portal', admin: 'Administración', legacy: 'Anterior a 2.18' };

/**
 * Three sheets: «Pagos» (one row per payment, as on the bank statement), «Reparto» (one row per person of
 * each payment) and «Saldos» (one row per person: cuota, validado, por validar, devuelto, por cobrar, a
 * favor). `nameOf` / `locationName` resolve ids to names.
 */
export function buildFeePaymentsWorkbook(opts: {
    transfers: FeeExportTransfer[]; people: FeeExportBalance[];
    nameOf: (inscriptionId: number) => string; locationName: (locationId: number | null) => string;
}): XlsxSheet[] {
    const day = (v: unknown) => String(v || '').slice(0, 10);
    const locOf = (t: FeeExportTransfer) => {
        if (t.location_id != null) return opts.locationName(t.location_id);
        const locs = t.locations || [];
        return locs.length > 1 ? 'Varias' : locs.length === 1 ? opts.locationName(locs[0]) : '';
    };
    // «Registrado por»: what the screen says — a coordinator is «Portal de <location>», never the internal 'portal:1'.
    const recorderOf = (t: FeeExportTransfer) => {
        const m = /^portal:(\d+)$/.exec(String(t.recorded_by || ''));
        if (!m) return t.recorded_by || '';
        const name = opts.locationName(Number(m[1]));
        return name ? `Portal de ${name}` : 'Portal';
    };
    const pagos: XlsxCell[][] = opts.transfers.map((t) => [
        t.id, day(t.paid_on), locOf(t), VIA_LABEL[String(t.recorded_via)] || String(t.recorded_via || ''), recorderOf(t),
        t.method || '', t.reference || '', { money: round2(num(t.amount)) }, t.people, FEE_STATUS_LABEL[t.status] || t.status,
        t.reviewed_by || '', t.reviewed_at ? localStamp(t.reviewed_at) : '', [t.note, t.review_note].filter(Boolean).join(' · '),
    ]);
    const reparto: XlsxCell[][] = [];
    for (const t of opts.transfers) {
        for (const a of t.allocations || []) {
            reparto.push([t.id, day(t.paid_on), a.location_id != null ? opts.locationName(a.location_id) : '', opts.nameOf(a.inscription_id),
                { money: round2(num(a.amount)) }, t.method || '', t.reference || '', FEE_STATUS_LABEL[t.status] || t.status]);
        }
    }
    const saldos: XlsxCell[][] = opts.people.map((b) => [
        opts.nameOf(b.id), b.location_id != null ? opts.locationName(b.location_id) : '', b.cancelled ? 'Cancelada' : '',
        { money: round2(num(b.due)) }, { money: round2(num(b.validated)) }, { money: round2(num(b.pending)) }, { money: round2(num(b.returned)) },
        { money: round2(num(b.to_cover)) }, { money: round2(num(b.credit)) },
    ]);
    return [
        {
            name: 'Pagos',
            columns: [{ header: '#', width: 8 }, { header: 'Fecha', width: 12 }, { header: 'Localidad', width: 18 }, { header: 'Registrado vía', width: 16 }, { header: 'Registrado por', width: 18 },
                { header: 'Forma de pago', width: 14 }, { header: 'Referencia', width: 16 }, { header: 'Total', width: 14 }, { header: 'Personas', width: 10 }, { header: 'Estado', width: 13 },
                { header: 'Revisado por', width: 16 }, { header: 'Revisado el', width: 18 }, { header: 'Nota', width: 34 }],
            rows: pagos,
        },
        {
            name: 'Reparto',
            columns: [{ header: 'Pago #', width: 8 }, { header: 'Fecha', width: 12 }, { header: 'Localidad', width: 18 }, { header: 'Participante', width: 28 }, { header: 'Monto', width: 14 },
                { header: 'Forma de pago', width: 14 }, { header: 'Referencia', width: 16 }, { header: 'Estado', width: 13 }],
            rows: reparto,
        },
        {
            name: 'Saldos',
            columns: [{ header: 'Participante', width: 28 }, { header: 'Localidad', width: 18 }, { header: 'Estado', width: 12 }, { header: 'Cuota', width: 13 }, { header: 'Validado', width: 13 },
                { header: 'Por validar', width: 13 }, { header: 'Devuelto', width: 13 }, { header: 'Por cobrar', width: 13 }, { header: 'A favor', width: 12 }],
            rows: saldos,
        },
    ];
}
