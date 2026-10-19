/**
 * The admin «Inscripciones» tables (2.18.0) — pure helpers: search, filters, grouping by location, sort,
 * the person sheet's facts, the chosen columns and the per-conference navigation memory.
 *
 * The roster is downloaded ONCE (GET /inscriptions, no params) and everything here runs in the browser
 * (owner decisions D1, D10): search is instant and ignores accents and case («angela» finds «Ángela»), each
 * location keeps its own card and pager (D3), and the location options come from the conference's own
 * locations (so a location with nobody yet appears too) plus «Sin localidad».
 *
 * Layout switching uses ROSTER_CSS (unlayered, keyed on data attributes) instead of `md:` variants: a
 * plugin-only variant sits in the plugin's sub-layer and can lose to a host base class on the same element
 * (backend/scripts/plugin-stylesheet.js).
 */
import { COARSE_FIELDS_CSS } from './overlay';

export type RosterField = { id?: number; name: string; label?: string | null; type?: string | null; role?: string | null; is_unique?: number | boolean | null; options?: string | null };
export type RosterPerson = Record<string, any> & { id: number };
export type RosterLocation = { id: number; name: string };

/** Lower-case, accent-free text for searching (same folding as lodgingView.normalizeText). */
export const foldText = (s: unknown): string =>
    String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** A field's raw value: its own column first, then the legacy custom_data blob ('' when empty). */
export const rawFieldValue = (p: RosterPerson | null | undefined, name: string): unknown => {
    if (!p) return '';
    const v = p[name];
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = p.custom_data && typeof p.custom_data === 'object' ? (p.custom_data as Record<string, unknown>)[name] : undefined;
    return cd !== undefined && cd !== null && cd !== '' ? cd : '';
};

const TRUE_WORDS = new Set(['1', 'true', 'si', 'yes', 'sim', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'nao', 'off']);

/**
 * A field value as the person sheet shows it (port of the portal's lodgingView.fieldDisplayValue):
 * booleans as Sí / No, arrays (or a JSON array string) joined with commas, a date 'YYYY-MM-DD' as
 * DD/MM/YYYY, anything else trimmed. '' when empty (the sheet then shows «—»).
 */
export const fieldDisplayValue = (v: unknown, type?: unknown): string => {
    if (v == null) return '';
    const t = String(type ?? '').toLowerCase();
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (Array.isArray(v)) return v.map((x) => fieldDisplayValue(x)).filter(Boolean).join(', ');
    if (typeof v === 'object') return '';
    const s = String(v).trim();
    if (!s) return '';
    if (t === 'checkbox' || t === 'boolean') {
        const w = foldText(s);
        if (TRUE_WORDS.has(w)) return 'Sí';
        if (FALSE_WORDS.has(w)) return 'No';
    }
    if (s.startsWith('[') && s.endsWith(']')) {
        try {
            const parsed: unknown = JSON.parse(s);
            if (Array.isArray(parsed) && parsed.every((x) => x == null || typeof x !== 'object')) return fieldDisplayValue(parsed);
        } catch { /* not JSON — shown verbatim */ }
    }
    if (t === 'date') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    }
    return s;
};

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const TEL_RE = /^\+?[0-9 ()\-.]{6,}$/;

export type PersonFact = { name: string; label: string; value: string; kind: 'email' | 'tel' | 'text'; href?: string };

/**
 * EVERY form field of a person in form order, untruncated, with its label (owner decision D11: an empty
 * field is listed too, value '' — the sheet shows «—» so the admin sees what is missing). An e-mail becomes
 * a mailto: link and a phone a tel: link, only when the value really looks like one.
 */
export function personFacts(p: RosterPerson | null | undefined, fields: RosterField[] | null | undefined): PersonFact[] {
    const out: PersonFact[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!f || typeof f.name !== 'string' || !f.name.trim() || seen.has(f.name)) continue;
        seen.add(f.name);
        const value = fieldDisplayValue(rawFieldValue(p, f.name), f.type);
        const type = String(f.type ?? '').toLowerCase();
        const role = String(f.role ?? '');
        const isEmail = (type === 'email' || role === 'email' || f.name === 'email') && EMAIL_RE.test(value);
        const isTel = (type === 'tel' || role === 'phone' || f.name === 'phone') && TEL_RE.test(value);
        out.push({
            name: f.name, label: String(f.label || f.name), value,
            kind: isEmail ? 'email' : isTel ? 'tel' : 'text',
            href: isEmail ? `mailto:${value}` : isTel ? `tel:${value.replace(/[^0-9+]/g, '')}` : undefined,
        });
    }
    return out;
}

/** Location key of a row: its id as text, or 'none' (a legacy row that only carries the label is resolved by name). */
export function rosterLocationKey(p: RosterPerson, locations: RosterLocation[] | null | undefined): string {
    if (p.location_id !== undefined && p.location_id !== null && p.location_id !== '') return String(Number(p.location_id));
    if (p.location) {
        const hit = (locations || []).find((l) => l.name === p.location);
        if (hit) return String(hit.id);
    }
    return 'none';
}

/**
 * Everything a search may match in a row, folded once (memoise it per roster): every defined field's value,
 * the location label, the registration code (already null for a role without inscriptions:view, so it is no
 * oracle) and the display name.
 */
export function rowHaystack(p: RosterPerson, fields: RosterField[] | null | undefined, extra: unknown[] = []): string {
    const parts: unknown[] = [];
    for (const f of fields || []) parts.push(fieldDisplayValue(rawFieldValue(p, f.name), f.type), rawFieldValue(p, f.name));
    parts.push(p.first_name, p.last_name, p.location, p.reg_code, ...extra);
    return foldText(parts.filter((v) => v !== undefined && v !== null && v !== '').join(' \u0001 '));
}

/** Every word of the query must appear in the haystack (already folded). An empty query matches everything. */
export const matchesQuery = (haystack: string, q: string): boolean => {
    const words = foldText(q).split(/\s+/).filter(Boolean);
    return words.every((w) => haystack.includes(w));
};

export type RosterPaymentFilter = '' | 'paid' | 'partial' | 'unpaid';
export type RosterFilters = {
    q: string;
    /** Location keys (rosterLocationKey): ids as text and 'none'. Empty = every location. */
    locationIds: string[];
    payment: RosterPaymentFilter;
    /** Only people with money «por validar». */
    pending: boolean;
    /** Owner decision D8: «Ocultar canceladas», OFF by default (the counts do not change). */
    hideCancelled: boolean;
    room: '' | 'with' | 'without';
};
export const EMPTY_ROSTER_FILTERS: RosterFilters = { q: '', locationIds: [], payment: '', pending: false, hideCancelled: false, room: '' };

/** How many filters (besides the search) are on — the «Filtros (n)» badge. */
export const activeFilterCount = (f: RosterFilters): number =>
    (f.locationIds.length ? 1 : 0) + (f.payment ? 1 : 0) + (f.pending ? 1 : 0) + (f.hideCancelled ? 1 : 0) + (f.room ? 1 : 0);

export const isCancelled = (p: RosterPerson): boolean => p.status === 'cancelled';
export const hasPending = (p: RosterPerson): boolean => Math.round((Number(p.pending_amount) || 0) * 100) > 0;

/**
 * The rows that pass every filter. `haystackOf` returns the row's folded search text (memoised by the
 * caller); without it the search is computed on the fly.
 */
export function applyRosterFilters(
    rows: RosterPerson[] | null | undefined,
    f: RosterFilters,
    ctx: { fields?: RosterField[]; locations?: RosterLocation[]; haystackOf?: (p: RosterPerson) => string },
): RosterPerson[] {
    const locSet = new Set(f.locationIds || []);
    const q = String(f.q || '').trim();
    return (rows || []).filter((p) => {
        if (locSet.size && !locSet.has(rosterLocationKey(p, ctx.locations))) return false;
        if (f.payment && String(p.payment_status || 'unpaid') !== f.payment) return false;
        if (f.pending && !hasPending(p)) return false;
        if (f.hideCancelled && isCancelled(p)) return false;
        if (f.room === 'with' && p.room_id == null) return false;
        if (f.room === 'without' && p.room_id != null) return false;
        if (q) {
            const hay = ctx.haystackOf ? ctx.haystackOf(p) : rowHaystack(p, ctx.fields);
            if (!matchesQuery(hay, q)) return false;
        }
        return true;
    });
}

/** Rows with money awaiting validation — the «Por validar (N)» chip (over the whole roster, not the page). */
export const pendingCount = (rows: RosterPerson[] | null | undefined): number => (rows || []).filter(hasPending).length;

/**
 * Stable order: last name, first name (folded), then the display name for forms without name columns, then
 * the id — two people with equal names never swap places between renders.
 */
export function rosterSort<T extends RosterPerson>(rows: T[] | null | undefined, nameOf?: (p: T) => string): T[] {
    const key = (p: T) => [foldText(p.last_name), foldText(p.first_name), foldText(nameOf ? nameOf(p) : '')];
    return [...(rows || [])].sort((a, b) => {
        const ka = key(a), kb = key(b);
        for (let i = 0; i < ka.length; i++) {
            if (ka[i] !== kb[i]) {
                if (!ka[i]) return 1;     // an empty name sorts after a filled one
                if (!kb[i]) return -1;
                return ka[i] < kb[i] ? -1 : 1;
            }
        }
        return Number(a.id) - Number(b.id);
    });
}

export type RosterGroupData<T extends RosterPerson = RosterPerson> = {
    key: string;                 // rosterLocationKey
    locationId: number | null;
    name: string;
    rows: T[];
    counts: { total: number; paid: number; pending: number; cancelled: number };
};

/**
 * One group per location that has rows, ordered by the location's name, «Sin localidad» last. The counters
 * are over the rows given (the filtered ones). A row whose location is not in `locations` keeps its label.
 */
export function groupByLocation<T extends RosterPerson>(rows: T[] | null | undefined, locations: RosterLocation[] | null | undefined, noLocationLabel: string): RosterGroupData<T>[] {
    const byKey = new Map<string, RosterGroupData<T>>();
    for (const p of rows || []) {
        const key = rosterLocationKey(p, locations);
        if (!byKey.has(key)) {
            const loc = key === 'none' ? null : (locations || []).find((l) => String(l.id) === key) || null;
            byKey.set(key, {
                key, locationId: key === 'none' ? null : Number(key),
                name: key === 'none' ? noLocationLabel : (loc ? loc.name : String(p.location || `#${key}`)),
                rows: [], counts: { total: 0, paid: 0, pending: 0, cancelled: 0 },
            });
        }
        const g = byKey.get(key)!;
        g.rows.push(p);
        g.counts.total++;
        if (p.payment_status === 'paid' && !isCancelled(p)) g.counts.paid++;
        if (hasPending(p)) g.counts.pending++;
        if (isCancelled(p)) g.counts.cancelled++;
    }
    return [...byKey.values()].sort((a, b) => {
        if (a.key === 'none') return 1;
        if (b.key === 'none') return -1;
        return a.name.localeCompare(b.name) || Number(a.locationId) - Number(b.locationId);
    });
}

// ── chosen columns (desktop «Columnas») ─────────────────────────────────────────────────────────────
/** At most this many form columns next to the name on a desktop (owner decision D4). */
export const ROSTER_MAX_COLUMNS = 3;
export const rosterColumnsKey = (conferenceId: number | string): string => `cm:insc:cols:${conferenceId}`;
const isNameField = (f: RosterField) => f.role === 'first_name' || f.role === 'last_name' || f.name === 'first_name' || f.name === 'last_name';
/** Default: the first two form fields that are not the name. */
export const defaultRosterColumns = (fields: RosterField[] | null | undefined): string[] =>
    (fields || []).filter((f) => f && f.name && !isNameField(f)).slice(0, 2).map((f) => f.name);
/** A stored choice, kept only for fields that still exist, at most ROSTER_MAX_COLUMNS; null when unusable. */
export function parseRosterColumns(raw: string | null | undefined, fields: RosterField[] | null | undefined): string[] | null {
    if (!raw) return null;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(v)) return null;
    const names = new Set((fields || []).map((f) => f.name));
    return [...new Set(v.filter((x): x is string => typeof x === 'string' && names.has(x)))].slice(0, ROSTER_MAX_COLUMNS);
}
/** Toggle a column in the choice (never more than ROSTER_MAX_COLUMNS; the oldest is not dropped — the toggle is refused). */
export const toggleRosterColumn = (cols: string[], name: string): string[] =>
    cols.includes(name) ? cols.filter((c) => c !== name) : cols.length >= ROSTER_MAX_COLUMNS ? cols : [...cols, name];

// ── navigation memory (a tab switch unmounts the page) ──────────────────────────────────────────────
export type RosterNav = { filters: RosterFilters; pages: Record<string, number>; collapsed: string[] };
export const rosterNavKey = (conferenceId: number | string): string => `cm:insc:${conferenceId}`;
export const EMPTY_ROSTER_NAV: RosterNav = { filters: EMPTY_ROSTER_FILTERS, pages: {}, collapsed: [] };
/** sessionStorage text → a validated RosterNav (anything malformed falls back to the defaults, field by field). */
export function parseRosterNav(raw: string | null | undefined): RosterNav {
    let v: any;
    try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
    if (!v || typeof v !== 'object') return EMPTY_ROSTER_NAV;
    const f = v.filters && typeof v.filters === 'object' ? v.filters : {};
    const filters: RosterFilters = {
        q: typeof f.q === 'string' ? f.q.slice(0, 200) : '',
        locationIds: Array.isArray(f.locationIds) ? f.locationIds.filter((x: unknown) => typeof x === 'string' && /^(none|\d+)$/.test(x)).slice(0, 500) : [],
        payment: ['paid', 'partial', 'unpaid'].includes(f.payment) ? f.payment : '',
        pending: f.pending === true,
        hideCancelled: f.hideCancelled === true,
        room: f.room === 'with' || f.room === 'without' ? f.room : '',
    };
    const pages: Record<string, number> = {};
    if (v.pages && typeof v.pages === 'object') {
        for (const [k, n] of Object.entries(v.pages)) if (/^(none|\d+)$/.test(k) && Number.isInteger(n) && (n as number) >= 1) pages[k] = n as number;
    }
    const collapsed = Array.isArray(v.collapsed) ? v.collapsed.filter((x: unknown) => typeof x === 'string' && /^(none|\d+)$/.test(x)) : [];
    return { filters, pages, collapsed };
}

/**
 * Where a long word may break without cutting it mid-word: after «@» and «/», before «.» and «_» — an e-mail
 * («maria.fernanda@example.com» → «maria» «.fernanda@» «example» «.com») or a web address. Words up to
 * `minLen` characters, and text with spaces between short words, stay as they are. The pieces join back to
 * the text exactly; the table renders a <wbr> between them (RosterBits SoftWrap), so a form value WRAPS in a
 * narrow column instead of ending «maria.fernanda@exa…» with the rest in a hover-only title.
 */
export function softBreaks(text: unknown, minLen = 12): string[] {
    const s = String(text ?? '');
    const out: string[] = [''];
    for (const w of s.split(/(\s+)/)) {
        if (w.length <= minLen || /\s/.test(w)) { out[out.length - 1] += w; continue; }
        let seg = '';
        for (const ch of w) {
            if ((ch === '.' || ch === '_') && seg) { out[out.length - 1] += seg; out.push(''); seg = ''; }
            seg += ch;
            if (ch === '@' || ch === '/') { out[out.length - 1] += seg; out.push(''); seg = ''; }
        }
        out[out.length - 1] += seg;
    }
    return out.filter((x, i) => x !== '' || i === 0);
}

/**
 * Has the inscription form changed since it opened (`original`: the row it was seeded from; null for a new
 * one)? Empty values ('' / null / unticked / []) count as absent; numbers and their text compare equal (a
 * select hands back «3» for location 3). Escape then asks before throwing the changes away.
 */
export function formIsDirty(data: Record<string, unknown> | null | undefined, original: Record<string, unknown> | null | undefined): boolean {
    const a = data || {};
    const b = original || {};
    const blank = (v: unknown) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const x = a[k];
        const y = b[k];
        if (blank(x) && blank(y)) continue;
        if (blank(x) !== blank(y)) return true;
        if (typeof x === 'object' || typeof y === 'object') { if (JSON.stringify(x) !== JSON.stringify(y)) return true; continue; }
        if (String(x) !== String(y)) return true;
    }
    return false;
}

/**
 * The desktop table's fixed columns (rem; `table-layout: fixed`, set on the header cells): Participante at
 * least 12rem — «PARTICIPANTE» and two-word names on their own lines, never cut mid-word — then Código
 * (inscriptions:view), Pago, Alojamiento and ⋮. The chosen form columns share what is left, each at least
 * ROSTER_FIELD_MIN_REM. Nothing is cut with «…» behind a hover-only title (2.18.0 live round): a form value
 * WRAPS (softBreaks), the room wraps («Hab 101 · Hotel» / «Central»), and Alojamiento widens to
 * ROSTER_LODGING_WIDE_REM once every chosen column fits with room to spare. A chosen column the card has no
 * room for is not lost either: its value folds under the name («Iglesia: Betel»), so ticking it in
 * «Columnas» always shows it.
 *
 * The table used to keep Código / Pago / Alojamiento / ⋮ at 35.25rem whatever its width: at 1280 px beside
 * the admin sidebar (an 828 px table) Participante and two form columns shared 264 px, names broke mid-word
 * («Echeve|rri») and «PARTICIPANTE» ran into «EMAIL». So the location CARD is a size container and decides
 * (rosterTableCss): the table only when its fixed columns fit (else the compact list, as on a phone), and
 * each form column only when it fits at its minimum — the third goes first, then the second, then the first.
 * A browser without container queries keeps the 768 px switch.
 */
export const ROSTER_COLUMNS_REM = { name: 12, code: 8.5, pay: 11, lodging: 8, more: 3.5 } as const;
/**
 * A form column's minimum (rem). Its content (minus px-3 on each side) holds an unbreakable piece of 18 characters
 * at 12 px — an e-mail's domain label («iglesiaevangelica», softBreaks): at 7rem the 1366 px window gave two
 * 113 px columns and «coordinacion.juvenil.bogota@iglesiaevangelica.org.co» broke mid-word («iglesiaevangeli» /
 * «ca.org.co»). Now the second column folds under the name there, and the first keeps its room.
 */
export const ROSTER_FIELD_MIN_REM = 8.5;
/** What a form column must hold whole: this many characters of one piece, at ROSTER_FIELD_CHAR_PX each (text-xs). */
export const ROSTER_FIELD_MIN_CHARS = 18;
export const ROSTER_FIELD_CHAR_PX = 6.2;
/** Alojamiento once the card holds every chosen form column at its minimum AND this much more. */
export const ROSTER_LODGING_WIDE_REM = 13;
/** The card body's side padding around the table (px-4 on each side), rem. */
export const ROSTER_BODY_PAD_REM = 2;

/** The narrowest card (rem, its content box) whose table holds `fields` form columns at their minimum. */
export function rosterTableMinRem(withCodes: boolean, fields = 0): number {
    const c = ROSTER_COLUMNS_REM;
    return c.name + (withCodes ? c.code : 0) + c.pay + c.lodging + c.more + ROSTER_FIELD_MIN_REM * fields + ROSTER_BODY_PAD_REM;
}
/** The narrowest card (rem) where Alojamiento takes ROSTER_LODGING_WIDE_REM with `chosen` form columns (≥ 1). */
export const rosterLodgingWideRem = (withCodes: boolean, chosen: number): number =>
    rosterTableMinRem(withCodes, chosen) + (ROSTER_LODGING_WIDE_REM - ROSTER_COLUMNS_REM.lodging);
/**
 * What a card `cardPx` wide (16 px rem) shows: 'list', or the table with how many of the `chosen` form
 * columns, how many of them fold under the name, and Alojamiento's width (rem) — the same thresholds
 * rosterTableCss writes.
 */
export function rosterLayoutFor(cardPx: number, withCodes: boolean, chosen: number): { table: boolean; fields: number; folded: number; lodgingRem: number } {
    const rem = Number(cardPx) / 16;
    const want = Math.min(Math.max(0, chosen), ROSTER_MAX_COLUMNS);
    if (!(rem >= rosterTableMinRem(withCodes, 0))) return { table: false, fields: 0, folded: 0, lodgingRem: 0 };
    let n = 0;
    while (n < want && rem >= rosterTableMinRem(withCodes, n + 1)) n++;
    const wide = want >= 1 && n === want && rem >= rosterLodgingWideRem(withCodes, want);
    return { table: true, fields: n, folded: want - n, lodgingRem: wide ? ROSTER_LODGING_WIDE_REM : ROSTER_COLUMNS_REM.lodging };
}
/** The header cells' widths (the first row sets a fixed table's columns). */
export const rosterColWidth = (col: keyof typeof ROSTER_COLUMNS_REM): string => `${ROSTER_COLUMNS_REM[col]}rem`;

/** The container rules of the location cards (`data-codes` = whether the Código column is there). */
export function rosterTableCss(): string {
    const below = (rem: number) => `${(rem - 0.01).toFixed(2)}rem`;
    const out: string[] = [];
    for (const codes of [true, false]) {
        const card = `[data-cm-roster-card][data-codes="${codes ? 1 : 0}"]`;
        const min = rosterTableMinRem(codes, 0);
        out.push(`@container cm-roster (max-width: ${below(min)}) { ${card} [data-cm-roster-list] { display: block; } ${card} [data-cm-roster-table] { display: none; } }`);
        out.push(`@container cm-roster (min-width: ${min}rem) { ${card} [data-cm-roster-list] { display: none; } ${card} [data-cm-roster-table] { display: block; } }`);
        for (let k = 1; k <= ROSTER_MAX_COLUMNS; k++) {
            // The column goes; its value folds under the name.
            out.push(`@container cm-roster (max-width: ${below(rosterTableMinRem(codes, k))}) { ${card} [data-cm-fcol="${k}"] { display: none; } ${card} [data-cm-ffold="${k}"] { display: block; } }`);
            // Every chosen column fits with room to spare: Alojamiento widens (with no chosen column the
            // fixed columns share the spare room by themselves). !important: the header cell carries its
            // base width inline (the fixed table reads the first row).
            out.push(`@container cm-roster (min-width: ${rosterLodgingWideRem(codes, k)}rem) { ${card}[data-fcols="${k}"] [data-cm-col="lodging"] { width: ${ROSTER_LODGING_WIDE_REM}rem !important; } }`);
        }
    }
    return out.join('\n') + '\n';
}

/**
 * The phone / desktop switch of the inscription tables, unlayered (it must win over Tailwind utilities on
 * the same elements without depending on any plugin class having been compiled):
 *   - below 768 px the compact list (`data-cm-roster-list`) shows and the table (`data-cm-roster-table`)
 *     hides; from 768 px the other way round;
 *   - the ⋮ button (`data-cm-more`) is at least 44×44 at every width;
 *   - a location card (`data-cm-roster-card`) clips instead of hiding its overflow, so its header can be
 *     sticky (`data-cm-roster-head`): on a long page you always know which location you are in;
 *   - the toolbar's phone row (`data-cm-roster-phonebar`) shows below 768 px, the desktop filters
 *     (`data-cm-roster-deskbar`) and the desktop Excel / «Nueva» buttons (`data-cm-roster-deskactions`)
 *     from 768 px;
 *   - from 768 px wide and 600 px high the conference panel is the scroller (lib/phoneLayout.ts SHELL_CSS)
 *     with a 1.5rem padding: the sticky header sits at -1.5rem so no row shows through above it;
 *   - the table's column headers stick right under that header (`--cm-roster-head-h`, its measured height,
 *     set by RosterGroup), opaque: scrolled down a long card, «Email» and «Iglesia» still say which is which;
 *   - the table's columns (rosterTableCss): see ROSTER_COLUMNS_REM; a folded column (`data-cm-ffold`) shows
 *     only where its own column does not fit.
 */
export const ROSTER_CSS = `
[data-cm-roster-table] { display: none; }
[data-cm-roster-deskbar], [data-cm-roster-deskactions] { display: none; }
@media (min-width: 768px) {
  [data-cm-roster-list] { display: none; }
  [data-cm-roster-table] { display: block; }
  [data-cm-roster-phonebar] { display: none; }
  [data-cm-roster-deskbar], [data-cm-roster-deskactions] { display: flex; }
}
[data-cm-more] { min-width: 44px; min-height: 44px; }
[data-cm-roster-card] { overflow: clip; container: cm-roster / inline-size; }
[data-cm-roster-head] { position: sticky; top: 0; z-index: 5; }
@media (min-width: 768px) and (min-height: 600px) {
  [data-cm-roster-head] { top: -1.5rem; }
}
[data-cm-roster-row] { min-height: 64px; }
[data-cm-roster-table] table { table-layout: fixed; width: 100%; }
[data-cm-ffold] { display: none; }
[data-cm-roster-table] thead th { position: sticky; top: var(--cm-roster-head-h, 4.75rem); z-index: 4; background-color: #f9fafb; box-shadow: inset 0 -1px 0 #f3f4f6; }
@media (min-width: 768px) and (min-height: 600px) {
  [data-cm-roster-table] thead th { top: calc(var(--cm-roster-head-h, 4.75rem) - 1.5rem); }
}
${rosterTableCss()}
${COARSE_FIELDS_CSS('[data-cm-shell]')}`;

// ── focus after a person leaves the roster (2.18.0 review PUX-8) ──────────────────────────────────────────
type QueryEl = { getAttribute: (n: string) => string | null; closest?: (sel: string) => QueryEl | null; querySelectorAll?: (sel: string) => ArrayLike<QueryEl> };
type QueryDoc = { querySelector: (sel: string) => QueryEl | null };
/**
 * Where the keyboard focus goes when person `id` is deleted from the person sheet: their row (and its «⋮») is
 * removed with them, so the sheet's own «back to the opener» finds nothing and the focus fell to <body> — the
 * next Tab started at the admin sidebar. In order: the NEXT row of the same card, else the previous one (its «⋮»
 * on a desktop table, the row itself on a phone), else the card's own first control (its collapse button).
 * Read BEFORE the row goes. Empty when the row is not on screen.
 */
export function rosterNeighborSelectors(doc: QueryDoc | null | undefined, id: number | string): string[] {
    if (!doc || typeof doc.querySelector !== 'function') return [];
    const key = String(id);
    if (!/^\d+$/.test(key)) return [];
    const own = doc.querySelector(`[data-cm-roster-row="${key}"]`) || doc.querySelector(`[data-cm-more="${key}"]`);
    const card = own && typeof own.closest === 'function' ? own.closest('[data-cm-roster-card]') : null;
    if (!card || typeof card.querySelectorAll !== 'function') return [];
    const ids = Array.from(card.querySelectorAll('[data-cm-roster-row]')).map((el) => String(el.getAttribute('data-cm-roster-row') || ''));
    const i = ids.indexOf(key);
    const near = i < 0 ? [] : [ids[i + 1], ids[i - 1]].filter((x): x is string => !!x && /^\d+$/.test(x));
    const out = near.map((n) => `[data-cm-more="${n}"], [data-cm-roster-row="${n}"]`);
    const group = card.getAttribute('data-roster-group');
    if (group && /^[\w-]+$/.test(group)) out.push(`[data-roster-group="${group}"] [data-cm-roster-head] button`);
    return out;
}
type FocusEl = { focus?: (o?: unknown) => void; offsetParent?: unknown; getClientRects?: () => ArrayLike<unknown> };
/** Focus the first VISIBLE match of the first selector that has one (a phone row or a desktop «⋮»). */
export function focusFirstVisible(doc: { querySelectorAll: (sel: string) => ArrayLike<FocusEl> } | null | undefined, selectors: string[]): boolean {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    const visible = (el: FocusEl) => el.offsetParent != null || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0);
    for (const sel of selectors || []) {
        let list: FocusEl[] = [];
        try { list = Array.from(doc.querySelectorAll(sel)); } catch { list = []; }
        const el = list.find(visible);
        if (el && typeof el.focus === 'function') {
            try { el.focus({ preventScroll: false }); return true; } catch { /* ignore */ }
        }
    }
    return false;
}
