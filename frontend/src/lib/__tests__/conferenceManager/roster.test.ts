/**
 * conference-manager 2.18.0 — the admin «Inscripciones» tables (tables-design.md + the owner's decisions):
 * browser-side paging (D2: 20 per page, «Mostrar 10/20/50/100» remembered per device), instant search that
 * ignores accents and case (D10), the filters (Localidad / Pago / «Por validar» D9 / «Ocultar canceladas» D8 /
 * Hospedaje), one group per location with «Sin localidad» last (D3), a stable sort, the person sheet's facts
 * with empty fields listed (D11), the chosen columns (D4) and the navigation memory.
 */
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_PAGE_SIZE, PAGE_SIZES, clampPage, normalizePageSize, pageAfterResize, pageCount, pageSlice, pageWindow, rangeOf, readPageSize, writePageSize,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/paging';
import {
    EMPTY_ROSTER_FILTERS, ROSTER_CSS, ROSTER_MAX_COLUMNS, activeFilterCount, applyRosterFilters, defaultRosterColumns, fieldDisplayValue, foldText,
    groupByLocation, matchesQuery, parseRosterColumns, parseRosterNav, pendingCount, personFacts, rosterLocationKey, rosterSort, rowHaystack, toggleRosterColumn,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';

describe('paging', () => {
    it('20 by default; only 10/20/50/100', () => {
        expect(DEFAULT_PAGE_SIZE).toBe(20);
        expect([...PAGE_SIZES]).toEqual([10, 20, 50, 100]);
        expect(normalizePageSize('50')).toBe(50);
        expect(normalizePageSize(30)).toBe(20);
        expect(normalizePageSize(null)).toBe(20);
    });
    it('clamps: an empty list is page 1 of 1; after a delete the last page is kept in range', () => {
        expect(pageCount(0, 20)).toBe(1);
        expect(clampPage(5, 0, 20)).toBe(1);
        expect(pageCount(41, 20)).toBe(3);
        expect(clampPage(3, 40, 20)).toBe(2);
        expect(clampPage(0, 40, 20)).toBe(1);
        expect(pageSlice([1, 2, 3, 4, 5], 2, 10)).toEqual([1, 2, 3, 4, 5]);   // page 2 does not exist: clamped to page 1
    });
    it('slices and ranges («21–40 de 183»)', () => {
        const rows = Array.from({ length: 183 }, (_, i) => i + 1);
        expect(pageSlice(rows, 2, 20)).toEqual(rows.slice(20, 40));
        expect(rangeOf(2, 20, 183)).toEqual({ from: 21, to: 40, total: 183 });
        expect(rangeOf(10, 20, 183)).toEqual({ from: 181, to: 183, total: 183 });
        expect(rangeOf(1, 20, 0)).toEqual({ from: 0, to: 0, total: 0 });
    });
    it('the numbered window keeps first, last and neighbours, «…» for each gap', () => {
        expect(pageWindow(6, 20)).toEqual([1, '…', 5, 6, 7, '…', 20]);
        expect(pageWindow(1, 1)).toEqual([1]);
        expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(pageWindow(1, 9)).toEqual([1, 2, '…', 9]);
    });
    it('a new page size keeps the first visible row on screen', () => {
        expect(pageAfterResize(3, 20, 50)).toBe(1);   // row 41 → page 1 of 50
        expect(pageAfterResize(3, 20, 10)).toBe(5);   // row 41 → page 5 of 10
        expect(pageAfterResize(2, 50, 20)).toBe(3);   // row 51 → page 3 of 20
    });
    it('the device remembers «Mostrar N»; blocked storage falls back to 20 and never throws', () => {
        const mem: Record<string, string> = {};
        const store = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
        writePageSize(50, 'k', store);
        expect(readPageSize('k', store)).toBe(50);
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(readPageSize('k', broken)).toBe(20);
        expect(() => writePageSize(10, 'k', broken)).not.toThrow();
        expect(readPageSize('k', null)).toBe(20);
    });
});

const FIELDS = [
    { name: 'first_name', label: 'Nombre', role: 'first_name' },
    { name: 'last_name', label: 'Apellido', role: 'last_name' },
    { name: 'email', label: 'Correo', type: 'email', role: 'email' },
    { name: 'phone', label: 'Teléfono', type: 'tel', role: 'phone' },
    { name: 'birth', label: 'Nacimiento', type: 'date' },
    { name: 'church', label: 'Iglesia' },
];
const LOCS = [{ id: 1, name: 'Norte' }, { id: 2, name: 'Centro' }];
const P = (id: number, extra: Record<string, any> = {}) => ({ id, first_name: '', last_name: '', location_id: 1, status: 'active', payment_status: 'unpaid', ...extra });
const ROWS = [
    P(1, { first_name: 'Ángela', last_name: 'Núñez', church: 'Betel', payment_status: 'paid', room_id: 4 }),
    P(2, { first_name: 'Luis', last_name: 'Pérez', location_id: 2, pending_amount: 250 }),
    P(3, { first_name: 'Ana', last_name: 'Pérez', location_id: null, status: 'cancelled' }),
    P(4, { first_name: 'Jose', last_name: 'Gomez', custom_data: { church: 'Sion' }, reg_code: 'AB12CD' }),
    P(5, { location_id: null, location: 'Centro', first_name: 'Legacy', last_name: 'Row', payment_status: 'partial' }),
];
const name = (p: any) => `${p.first_name} ${p.last_name}`.trim();
const hay = (p: any) => rowHaystack(p, FIELDS, [name(p)]);

describe('search (D10): accents and case ignored, every word must match', () => {
    it('«angela» finds «Ángela», «nunez» finds «Núñez»', () => {
        expect(foldText('Ángela NÚÑEZ')).toBe('angela nunez');
        expect(matchesQuery(hay(ROWS[0]), 'angela')).toBe(true);
        expect(matchesQuery(hay(ROWS[0]), 'nunez angela')).toBe(true);
        expect(matchesQuery(hay(ROWS[0]), 'angela perez')).toBe(false);
        expect(matchesQuery(hay(ROWS[0]), '')).toBe(true);
    });
    it('custom_data values and the registration code (only when present) are searched', () => {
        expect(matchesQuery(hay(ROWS[3]), 'sion')).toBe(true);
        expect(matchesQuery(hay(ROWS[3]), 'ab12cd')).toBe(true);
        expect(matchesQuery(hay({ ...ROWS[3], reg_code: null }), 'ab12cd')).toBe(false);
    });
});

describe('filters', () => {
    const run = (f: Partial<typeof EMPTY_ROSTER_FILTERS>) => applyRosterFilters(ROWS, { ...EMPTY_ROSTER_FILTERS, ...f }, { fields: FIELDS, locations: LOCS, haystackOf: hay }).map((p) => p.id);
    it('nothing on = everyone', () => expect(run({})).toEqual([1, 2, 3, 4, 5]));
    it('locations (multi) including «Sin localidad»; a legacy row carrying only the label is resolved by name', () => {
        expect(run({ locationIds: ['2'] })).toEqual([2, 5]);
        expect(run({ locationIds: ['none'] })).toEqual([3]);
        expect(run({ locationIds: ['1', 'none'] })).toEqual([1, 3, 4]);
        expect(rosterLocationKey(ROWS[4], LOCS)).toBe('2');
    });
    it('payment, «por validar», «ocultar canceladas» (off by default), room', () => {
        expect(run({ payment: 'paid' })).toEqual([1]);
        expect(run({ payment: 'partial' })).toEqual([5]);
        expect(run({ pending: true })).toEqual([2]);
        expect(run({ hideCancelled: true })).toEqual([1, 2, 4, 5]);
        expect(run({ room: 'with' })).toEqual([1]);
        expect(run({ room: 'without' })).toEqual([2, 3, 4, 5]);
        expect(run({ q: 'perez', hideCancelled: true })).toEqual([2]);
        expect(EMPTY_ROSTER_FILTERS.hideCancelled).toBe(false);
    });
    it('«Por validar (N)» counts the whole roster; the filter badge counts the filters on', () => {
        expect(pendingCount(ROWS)).toBe(1);
        expect(pendingCount([{ id: 9, pending_amount: 0.004 }])).toBe(0);
        expect(activeFilterCount({ ...EMPTY_ROSTER_FILTERS, q: 'x' })).toBe(0);
        expect(activeFilterCount({ ...EMPTY_ROSTER_FILTERS, locationIds: ['1', '2'], pending: true, room: 'with' })).toBe(3);
    });
});

describe('groups (D3): one per location, by name, «Sin localidad» last, counters over the given rows', () => {
    it('orders and counts', () => {
        const g = groupByLocation(ROWS, LOCS, 'Sin localidad');
        expect(g.map((x) => x.name)).toEqual(['Centro', 'Norte', 'Sin localidad']);
        expect(g.map((x) => x.rows.map((r) => r.id))).toEqual([[2, 5], [1, 4], [3]]);
        expect(g[0].counts).toEqual({ total: 2, paid: 0, pending: 1, cancelled: 0 });
        expect(g[2].counts).toEqual({ total: 1, paid: 0, pending: 0, cancelled: 1 });
        expect(g[2].locationId).toBeNull();
    });
    it('a location missing from the conference list keeps its label', () => {
        expect(groupByLocation([P(7, { location_id: 9, location: 'Vieja' })], LOCS, '—')[0].name).toBe('Vieja');
    });
});

describe('sort', () => {
    it('last name, first name, then the display name, then the id — equal names never swap', () => {
        const rows = [P(3, { first_name: 'Ana', last_name: 'Pérez' }), P(1, { first_name: 'Ana', last_name: 'Pérez' }), P(2, { first_name: 'Luis', last_name: 'Álvarez' }), P(9, { church: 'Zeta' }), P(8, { church: 'Alfa' })];
        expect(rosterSort(rows, (p: any) => p.church || '').map((p) => p.id)).toEqual([2, 1, 3, 8, 9]);
        expect(rosterSort(rows, (p: any) => p.church || '').map((p) => p.id)).toEqual(rosterSort([...rows].reverse(), (p: any) => p.church || '').map((p) => p.id));
    });
});

describe('the person sheet\'s facts (D11): every field, in form order, untruncated, empty ones listed', () => {
    it('lists empty fields with an empty value, formats dates, links mail and phone', () => {
        const facts = personFacts({ id: 1, first_name: 'Ana', email: 'ana@example.test', phone: '+57 300 123 4567', birth: '1990-02-03', church: '' }, FIELDS);
        expect(facts.map((f) => f.name)).toEqual(FIELDS.map((f) => f.name));
        expect(facts.find((f) => f.name === 'last_name')!.value).toBe('');
        expect(facts.find((f) => f.name === 'church')!.value).toBe('');
        expect(facts.find((f) => f.name === 'birth')!.value).toBe('03/02/1990');
        expect(facts.find((f) => f.name === 'email')).toMatchObject({ kind: 'email', href: 'mailto:ana@example.test' });
        expect(facts.find((f) => f.name === 'phone')).toMatchObject({ kind: 'tel', href: 'tel:+573001234567' });
    });
    it('fieldDisplayValue: Sí / No, arrays, JSON arrays', () => {
        expect(fieldDisplayValue(true)).toBe('Sí');
        expect(fieldDisplayValue('yes', 'checkbox')).toBe('Sí');
        expect(fieldDisplayValue(['a', 'b'])).toBe('a, b');
        expect(fieldDisplayValue('["x","y"]')).toBe('x, y');
        expect(fieldDisplayValue({ a: 1 })).toBe('');
    });
});

describe('columns (D4) and navigation memory', () => {
    it('default: the first two fields that are not the name; at most three; stored choices are validated', () => {
        expect(defaultRosterColumns(FIELDS)).toEqual(['email', 'phone']);
        expect(ROSTER_MAX_COLUMNS).toBe(3);
        expect(toggleRosterColumn(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c']);
        expect(toggleRosterColumn(['a', 'b'], 'a')).toEqual(['b']);
        expect(parseRosterColumns('["church","gone","church","email","birth","phone"]', FIELDS)).toEqual(['church', 'email', 'birth']);
        expect(parseRosterColumns('not json', FIELDS)).toBeNull();
    });
    it('parseRosterNav keeps what is valid, drops the rest', () => {
        const nav = parseRosterNav(JSON.stringify({ filters: { q: 'ana', locationIds: ['1', 'x', 'none'], payment: 'bogus', pending: true, hideCancelled: 'yes', room: 'with' }, pages: { 1: 3, none: 0, x: 2 }, collapsed: ['2', 5] }));
        expect(nav.filters).toEqual({ q: 'ana', locationIds: ['1', 'none'], payment: '', pending: true, hideCancelled: false, room: 'with' });
        expect(nav.pages).toEqual({ 1: 3 });
        expect(nav.collapsed).toEqual(['2']);
        expect(parseRosterNav('{').filters).toEqual(EMPTY_ROSTER_FILTERS);
    });
});

describe('ROSTER_CSS: the phone / desktop switch without `md:` classes', () => {
    it('below 768px the list, from 768px the table; ⋮ is 44px; the card clips so its header can stick', () => {
        const at = ROSTER_CSS.indexOf('@media (min-width: 768px)');
        expect(ROSTER_CSS.slice(0, at)).toMatch(/\[data-cm-roster-table\] \{ display: none; \}/);
        expect(ROSTER_CSS.slice(at)).toMatch(/\[data-cm-roster-list\] \{ display: none; \}/);
        expect(ROSTER_CSS.slice(at)).toMatch(/\[data-cm-roster-table\] \{ display: block; \}/);
        expect(ROSTER_CSS).toMatch(/\[data-cm-more\] \{ min-width: 44px; min-height: 44px; \}/);
        expect(ROSTER_CSS).toMatch(/\[data-cm-roster-card\] \{ overflow: clip;/);
        expect(ROSTER_CSS).toMatch(/\[data-cm-roster-head\] \{ position: sticky; top: 0;/);
        expect(ROSTER_CSS).not.toMatch(/@layer/);
    });
});
