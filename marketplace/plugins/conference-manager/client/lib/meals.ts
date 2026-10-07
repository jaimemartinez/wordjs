/**
 * Meals (2.14.0) — pure helpers shared by the «Alimentación» page and the phone scanner.
 *
 * A SERVICE is one meal on one day of a conference. Entitlement, its source and every counter come from
 * the server (single source of truth); this module only orders, groups, labels and picks — and mirrors the
 * server's code normalization so the scanner can ignore garbage before posting it.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';

export type Meal = 'desayuno' | 'almuerzo' | 'cena';
export const MEALS: Meal[] = ['desayuno', 'almuerzo', 'cena'];
const MEAL_RANK: Record<string, number> = { desayuno: 0, almuerzo: 1, cena: 2 };

/** Delivery windows used when a service has none: they only preselect the current service in «Entrega». */
export const DEFAULT_WINDOWS: Record<Meal, [string, string]> = {
    desayuno: ['06:00', '10:00'],
    almuerzo: ['11:30', '15:00'],
    cena: ['18:00', '21:30'],
};

export type ByLocation = { location_id: number | null; location?: string | null; entitled: number; delivered: number; pending?: number };

export type MealService = {
    id: number;
    conference_id?: number;
    service_date: string;          // YYYY-MM-DD
    meal: Meal | string;
    label?: string | null;
    start_time?: string | null;    // HH:MM
    end_time?: string | null;
    notes?: string | null;
    entitled?: number;
    delivered?: number;
    pending?: number;
    overrides_delivered?: number;
    by_location?: ByLocation[];
};

export type PlanRow = { location_id: number; service_id: number };

// ── Codes ────────────────────────────────────────────────────────────────────────────────────────────
/** The registration-code alphabet (no I, O, 0, 1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 10;

/** Exactly the server's normalization: scanners add prefixes, suffixes, CR, dashes, lowercase. */
export const normalizeCode = (raw: unknown): string =>
    String(raw ?? '').trim().toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '');

/** A full registration code (what a printed barcode carries). */
export const isRegCode = (s: unknown): boolean => {
    const v = String(s ?? '');
    return v.length === CODE_LENGTH && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(v);
};

// ── Dates and times ──────────────────────────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutes = (hhmm: string | null | undefined): number | null => {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The window a service is served in: its own times, else the meal's default. */
export function serviceWindow(s: Pick<MealService, 'meal' | 'start_time' | 'end_time'>): [string, string] {
    const def = DEFAULT_WINDOWS[(s.meal as Meal)] || ['00:00', '23:59'];
    let a = s.start_time || def[0];
    let b = s.end_time || def[1];
    // Only one time set, and it falls outside the meal's default (a dinner from 22:00, no end): the
    // default for the missing side would invert the window, so it opens to the end / start of the day.
    // The server stores zero-padded HH:MM, so the string comparison is the time comparison.
    if (a >= b) {
        if (!s.end_time) b = '23:59';
        else if (!s.start_time) a = '00:00';
    }
    return [a, b];
}

/** Server stamps are UTC 'YYYY-MM-DD HH:MM:SS'. */
export function parseStamp(v: unknown): Date | null {
    const s = String(v ?? '');
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
    if (!m) return null;
    const d = new Date(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}Z`);
    return isNaN(d.getTime()) ? null : d;
}

/** «12:31» in local time (or '' when the stamp is unreadable). */
export const stampTime = (v: unknown): string => {
    const d = parseStamp(v);
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
};

/** «12/11 12:31» in local time. */
export const stampDayTime = (v: unknown): string => {
    const d = parseStamp(v);
    return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
};

/** Every day from `from` to `to` inclusive (YYYY-MM-DD), capped at `max` days. */
export function dateRange(from: string, to: string, max = 366): string[] {
    const a = String(from || '').slice(0, 10), b = String(to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return [];
    const out: string[] = [];
    const d = new Date(`${a}T12:00:00Z`);
    const end = new Date(`${b}T12:00:00Z`);
    if (isNaN(d.getTime()) || isNaN(end.getTime())) return [];
    while (d.getTime() <= end.getTime() && out.length < max) {
        out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
}

/** The server accepts ≤ 60 dates per bulk request. */
export const chunk = <T>(list: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
};

// ── Ordering, grouping, picking ──────────────────────────────────────────────────────────────────────
export const compareServices = (a: MealService, b: MealService): number =>
    String(a.service_date).localeCompare(String(b.service_date))
    || (MEAL_RANK[a.meal] ?? 9) - (MEAL_RANK[b.meal] ?? 9)
    || a.id - b.id;

export const sortServices = (list: MealService[] | null | undefined): MealService[] => [...(list || [])].sort(compareServices);

export type ServiceDay = { date: string; services: MealService[] };
export function groupByDay(list: MealService[] | null | undefined): ServiceDay[] {
    const days: ServiceDay[] = [];
    for (const s of sortServices(list)) {
        const last = days[days.length - 1];
        if (last && last.date === s.service_date) last.services.push(s);
        else days.push({ date: s.service_date, services: [s] });
    }
    return days;
}

/**
 * The service the kitchen is most likely serving now: today's whose window contains `now`; else the next
 * one today; else the first future one; else the most recent past one (so the selector is never empty
 * while services exist).
 */
export function pickCurrentService(list: MealService[] | null | undefined, now: Date = new Date()): MealService | null {
    const sorted = sortServices(list);
    if (!sorted.length) return null;
    const today = localDay(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todays = sorted.filter((s) => s.service_date === today);
    for (const s of todays) {
        const [a, b] = serviceWindow(s).map(minutes) as [number, number];
        if (a != null && b != null && nowMin >= a && nowMin <= b) return s;
    }
    for (const s of todays) {
        const a = minutes(serviceWindow(s)[0]);
        if (a != null && a > nowMin) return s;
    }
    const future = sorted.find((s) => s.service_date > today);
    if (future) return future;
    return sorted[sorted.length - 1];
}

// ── Plan matrix ──────────────────────────────────────────────────────────────────────────────────────
export const planKey = (locationId: number, serviceId: number) => `${Number(locationId)}:${Number(serviceId)}`;
export const planSet = (plan: PlanRow[] | null | undefined): Set<string> =>
    new Set((plan || []).map((p) => planKey(p.location_id, p.service_id)));

export const rowState = (locationId: number, services: MealService[], set: Set<string>): 'all' | 'some' | 'none' => {
    const on = services.filter((s) => set.has(planKey(locationId, s.id))).length;
    return on === 0 ? 'none' : on === services.length ? 'all' : 'some';
};
export const columnState = (serviceId: number, locationIds: number[], set: Set<string>): 'all' | 'some' | 'none' => {
    const on = locationIds.filter((l) => set.has(planKey(l, serviceId))).length;
    return on === 0 ? 'none' : on === locationIds.length ? 'all' : 'some';
};
/** A location's service set after switching `serviceId` on/off (for PUT /meals/plan). */
export const servicesOfLocation = (locationId: number, set: Set<string>, services: MealService[]): number[] =>
    services.filter((s) => set.has(planKey(locationId, s.id))).map((s) => s.id);

// ── Scan gate ────────────────────────────────────────────────────────────────────────────────────────
/**
 * Continuous scanning reads the same barcode many times a second. `accept(code)` is true the first time a
 * code is seen and then only once it has been OUT OF VIEW for `ms` (default 3 s): every sighting refreshes
 * the code's timestamp, so a badge held under the camera is never posted twice and an undone delivery is
 * not posted again while the badge is still in view. Several codes are remembered at once (a parent
 * showing the family's badges), so two badges in view do not alternate forever.
 */
export function createScanGate(ms = 3000) {
    const seen = new Map<string, number>();
    return {
        accept(code: string, at: number = Date.now()): boolean {
            if (!code) return false;
            for (const [c, t] of seen) if (at - t >= ms) seen.delete(c);
            const known = seen.has(code);
            seen.set(code, at);
            return !known;
        },
        reset() { seen.clear(); },
    };
}

// ── Camera reads (2.15.1) ────────────────────────────────────────────────────────────────────────────
/**
 * What the camera read, before anything is posted. Only a registration code goes to the server, and it
 * must BE one once spaces and dashes are dropped: normalizeCode() (made for USB scanners that add
 * prefixes and CR) strips every 0 and 1, so a product barcode with exactly three of them would become a
 * 10-character "code" the server answers «no encontrado» for — the operator would never see what was
 * really read. Everything else is shown as read, with its symbology.
 */
export type ScanRead =
    | { kind: 'reg'; code: string; format: string }
    | { kind: 'other'; value: string; format: string };

export function classifyRead(raw: unknown, format = ''): ScanRead | null {
    // Control characters (a GS1 FNC1 separator, a trailing CR) are not shown and never part of a code.
    const value = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!value) return null;
    const compact = value.toUpperCase().replace(/[\s-]/g, '');
    if (isRegCode(compact)) return { kind: 'reg', code: compact, format };
    return { kind: 'other', value, format };
}

export type ReadRoute =
    | { action: 'submit'; code: string }
    | { action: 'show'; value: string; format: string; fresh: boolean };

/**
 * The scanner's `onCode`: a registration code is posted once per sighting (sliding gate, see
 * createScanGate; nothing while a request is in flight — and the badge seen meanwhile is NOT marked as
 * seen), anything else is SHOWN. `fresh` is true when that value just came into view (beep and replace
 * the card); while it stays in view the card is only kept alive.
 */
export function createReadRouter(ms = 3000) {
    const regGate = createScanGate(ms);
    const otherGate = createScanGate(ms);
    return {
        route(raw: unknown, format: string, busy: boolean, at: number = Date.now()): ReadRoute | null {
            const r = classifyRead(raw, format);
            if (!r) return null;
            if (r.kind === 'reg') {
                if (busy || !regGate.accept(r.code, at)) return null;
                return { action: 'submit', code: r.code };
            }
            return { action: 'show', value: r.value, format: r.format, fresh: otherGate.accept(`${r.format}\n${r.value}`, at) };
        },
        reset() { regGate.reset(); otherGate.reset(); },
    };
}

/**
 * The scanner's heartbeat, driven by the decode loop: `frame()` after every analysed frame, `pause()` on
 * every turn the loop skips on purpose (a sheet is open, a verdict awaits a decision, a request is in
 * flight), `start()` when the camera turns on. `health()` reports the frames analysed in the last second
 * and STALLED when the loop has neither analysed nor deliberately skipped a frame for `stallMs` — the
 * camera delivers no image (iOS Low Power Mode, a frozen track) or the loop died.
 *
 * `busy()` marks a decode IN FLIGHT on a playable frame (the native BarcodeDetector is asynchronous, and
 * its first detect() can take seconds on a low-end Android while the model loads): frames are arriving,
 * so it is not "no image" — for up to `busyMs`, after which a detect that never settles counts as a dead
 * loop. `idle()` ends a decode that produced nothing (it threw): the 2 s clock runs from the last real
 * frame again, so a detector that fails on every frame is still reported.
 */
export type ScanHealth = { state: 'scanning' | 'paused' | 'stalled'; fps: number };

/**
 * The pause before the scanner's next frame, given how long the last decode held the main thread (ms):
 * at least 80 ms, and never shorter than the decode itself — so the built-in reader (synchronous, ~100 ms
 * on printed packaging on a phone) keeps the main thread free at least half of the time for taps and the
 * sheets. A blank frame (~20 ms) keeps the full rate.
 */
export function scanLoopDelay(decodeMs: number): number {
    const ms = Number(decodeMs);
    return Number.isFinite(ms) && ms > 80 ? Math.min(Math.round(ms), 1000) : 80;
}

export function createScanMeter(stallMs = 2000, busyMs = 10_000) {
    let frames: number[] = [];
    let since = 0;
    let paused = false;
    let busySince: number | null = null;
    const trim = (at: number) => { while (frames.length && at - frames[0] >= 1000) frames.shift(); };
    return {
        start(at: number = Date.now()) { frames = []; since = at; paused = false; busySince = null; },
        busy(at: number = Date.now()) { busySince = at; paused = false; },
        idle() { busySince = null; },
        frame(at: number = Date.now()) { frames.push(at); trim(at); since = at; paused = false; busySince = null; },
        pause(at: number = Date.now()) { since = at; paused = true; busySince = null; },
        health(at: number = Date.now()): ScanHealth {
            trim(at);
            const decoding = busySince !== null && at - busySince <= busyMs;
            if (!decoding && at - since > stallMs) return { state: 'stalled', fps: 0 };
            if (paused) return { state: 'paused', fps: 0 };
            return { state: 'scanning', fps: frames.length };
        },
    };
}

// ── Verdicts ─────────────────────────────────────────────────────────────────────────────────────────
export type VerdictResult = 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference';
/** Client-side outcomes that are not server verdicts. */
export type ScanOutcome = VerdictResult | 'offline' | 'no_service' | 'error';
export type VerdictTone = 'ok' | 'warn' | 'bad' | 'muted';

export const verdictTone = (r: ScanOutcome): VerdictTone =>
    r === 'delivered' ? 'ok'
        : r === 'not_entitled' ? 'warn'
            : r === 'unknown' || r === 'other_conference' || r === 'offline' ? 'muted'
                : 'bad';

/** Only a 'delivered' verdict from the server counts as a delivery. */
export const isSuccess = (r: ScanOutcome) => r === 'delivered';

// ── Excel ────────────────────────────────────────────────────────────────────────────────────────────
export type ReportRow = {
    inscription_id: number; name: string; location: string | null; location_id: number | null; family_group?: string | null;
    reg_code?: string | null; status?: string; entitled: boolean | number; source: string; delivered: boolean | number;
    delivery_id?: number | null; delivered_at?: string | null; method?: string | null; delivered_by?: string | null; note?: string | null;
};
export type ServiceReport = {
    service: MealService;
    rows: ReportRow[];
    totals: { entitled: number; delivered: number; pending: number; overrides_delivered: number };
    by_location: ByLocation[];
};

export type MealLabels = {
    meal: (m: string) => string;
    source: (s: string) => string;
    method: (m: string) => string;
    noLocation: string;
    yes: string;
    no: string;
};

const SPANISH: MealLabels = {
    meal: (m) => ({ desayuno: 'Desayuno', almuerzo: 'Almuerzo', cena: 'Cena' } as Record<string, string>)[m] || m,
    source: (s) => ({ location: 'Por localidad', include: 'Añadido a la persona', exclude: 'Quitado a la persona', none: 'Sin derecho' } as Record<string, string>)[s] || s,
    method: (m) => ({ scan: 'Escaneo', manual: 'Manual', override: 'Sin derecho (autorizado)' } as Record<string, string>)[m] || (m || ''),
    noLocation: 'Sin localidad',
    yes: 'Sí',
    no: 'No',
};

/** «Mié 12/11 · Almuerzo» (+ « — label»). */
export function serviceTitle(s: MealService, L: Pick<MealLabels, 'meal'> = SPANISH, weekday?: (date: string) => string): string {
    const m = String(s.service_date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const day = m ? `${weekday ? weekday(s.service_date) + ' ' : ''}${m[3]}/${m[2]}` : String(s.service_date);
    return `${day} · ${L.meal(String(s.meal))}${s.label ? ` — ${s.label}` : ''}`;
}

/** "Resumen" (totals + per location) and "Detalle" (one row per person, in the server's order). */
/** `filter` and `q` are the ones on screen: the file holds exactly the rows the table shows. */
export function buildMealReportWorkbook(report: ServiceReport, opts: { filter?: 'all' | 'pending' | 'delivered' | 'override'; q?: string; labels?: Partial<MealLabels> } = {}): XlsxSheet[] {
    const L: MealLabels = { ...SPANISH, ...(opts.labels || {}) };
    const rows = filterReportRows(report.rows, opts.filter || 'all', opts.q || '');
    const t = report.totals;
    const summary: XlsxSheet = {
        name: 'Resumen',
        columns: [{ header: 'Concepto', width: 30 }, { header: 'Con derecho', width: 13 }, { header: 'Entregados', width: 13 }, { header: 'Pendientes', width: 13 }],
        rows: [
            [serviceTitle(report.service, L), '', '', ''],
            ['Total', t.entitled, t.delivered, t.pending],
            ['Entregados sin derecho (autorizados)', '', t.overrides_delivered, ''],
            ['', '', '', ''],
            ...report.by_location.map((b) => [b.location_id == null ? L.noLocation : (b.location || ''), b.entitled, b.delivered, b.pending ?? Math.max(0, b.entitled - b.delivered)] as XlsxCell[]),
        ],
        boldRows: [0, 1],
    };
    const detail: XlsxSheet = {
        name: 'Detalle',
        columns: [
            { header: 'Código', width: 14 }, { header: 'Nombre', width: 28 }, { header: 'Localidad', width: 20 }, { header: 'Grupo familiar', width: 18 },
            { header: 'Derecho / origen', width: 24 }, { header: 'Entregado a las', width: 16 }, { header: 'Método', width: 22 }, { header: 'Entregado por', width: 18 },
        ],
        rows: rows.map((r) => [
            r.reg_code || '', r.name, r.location_id == null ? L.noLocation : (r.location || ''), r.family_group || '',
            `${r.entitled ? L.yes : L.no} · ${L.source(r.source)}`, stampDayTime(r.delivered_at), r.method ? L.method(r.method) : '', r.delivered_by || '',
        ] as XlsxCell[]),
    };
    return [summary, detail];
}

/** Report filter: everyone / not yet served / served / served without entitlement — plus a text search. */
export function filterReportRows(rows: ReportRow[] | null | undefined, filter: 'all' | 'pending' | 'delivered' | 'override', q: string): ReportRow[] {
    const needle = foldText(q);
    return (rows || []).filter((r) => {
        if (filter === 'pending' && (!r.entitled || r.delivered)) return false;
        if (filter === 'delivered' && !r.delivered) return false;
        if (filter === 'override' && !(r.delivered && !r.entitled)) return false;
        if (needle && !foldText(`${r.name} ${r.reg_code || ''} ${r.location || ''} ${r.family_group || ''}`).includes(needle)) return false;
        return true;
    });
}

/** Case- and accent-insensitive comparison text (client-side filtering of already-loaded rows only). */
export const foldText = (v: unknown): string =>
    String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
