/**
 * conference-manager 2.18.0 — the fixes of the fourth review round (admin plugin), server-rendered or pure
 * (node, no DOM), each pinned so that undoing it fails here:
 *   - «Inscripciones» on a desktop: Participante keeps 12rem (names never break mid-word, «PARTICIPANTE» never
 *     runs into the next header); the location CARD decides, as a size container, whether the table fits and
 *     how many chosen form columns fit — the list otherwise;
 *   - the phone rows: the room is never cut («Sin h…»): the facts line wraps between its parts;
 *   - «Contabilidad»: the page and «Movimientos» are size containers — no `xl:` 2/3 card squeezing the table,
 *     Categoría / Forma de pago fold into the description, a block per movement below 40rem, filters that wrap;
 *   - «Pagos de cuotas»: the review queue's list column shrinks so the pinned bar stays ONE row, and the bar
 *     sits flush with the panel's bottom; «Por localidad» attributes «A favor»;
 *   - D-P20: the section never reads the roster — people come with its own view (personRowOfWire) and the
 *     person sheet is `brief` without Inscripciones › ver; Pagos alone no longer counts as reading the roster;
 *   - the same words as the portal: «Forma de pago» (one method), «Queda pagado al validarse [lo pendiente]»,
 *     «Supera lo que falta: máximo $X»; amounts typed «250» read «250,00» once the input is left;
 *   - the person picker keeps its whole search placeholder.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { ModalProvider } from '@/contexts/ModalContext';
import { ConferenceProvider } from '../../../../../marketplace/plugins/conference-manager/client/contexts/ConferenceContext';
import {
    ROSTER_COLUMNS_REM, ROSTER_CSS, ROSTER_FIELD_MIN_REM, groupByLocation, rosterLayoutFor, rosterTableMinRem,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';
import { partAfterKind, personBalance, personRowOfWire } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { tidyMoneyInput } from '../../../../../marketplace/plugins/conference-manager/client/lib/feeSplit';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { canReadRoster } from '../../../../../marketplace/plugins/conference-manager/client/admin/perms';
import { RosterGroup } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterGroup';
import { PersonSheet } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { PersonPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonPicker';
import { RegisterPaymentSheet, buildPersonOptions } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { LEDGER_CSS } from '../../../../../marketplace/plugins/conference-manager/client/admin/AccountingPage';
import FeePaymentsPage, { FEES_CSS, MASTER_DETAIL_MIN_PX, QUEUE_LIST_COLUMN } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';
import { afterText as portalAfterText } from '../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));
const REM = 16;

// ── «Inscripciones»: the desktop table ──────────────────────────────────────────────────────────────
const FIELDS = [
    { id: 1, name: 'first_name', label: 'Nombre', role: 'first_name', type: 'text' },
    { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name', type: 'text' },
    { id: 3, name: 'email', label: 'Email', role: 'email', type: 'text' },
    { id: 4, name: 'phone', label: 'Teléfono', role: 'phone', type: 'text' },
    { id: 5, name: 'church', label: 'Iglesia', type: 'text' },
];
const LOCS = [{ id: 1, name: 'Cali', lodging_status: 'draft' }];
const ROWS = [
    { id: 1, first_name: 'Clara', last_name: 'Echeverri', email: 'clara@example.test', phone: '+57 300 1', church: 'Betel', location_id: 1, status: 'active', total_due: 250, amount_paid: 0, pending_amount: 0, returned_amount: 0, payment_status: 'unpaid', reg_code: '46UJF5DX73' },
    { id: 2, first_name: 'Bernardo', last_name: 'Gallo', location_id: 1, status: 'active', total_due: 250, amount_paid: 0, pending_amount: 125000, returned_amount: 0, payment_status: 'unpaid', reg_code: 'ZYVEAC8Z6Q', room_id: null },
];
const nameOf = (p: any) => `${p.first_name} ${p.last_name}`;
const group = groupByLocation(ROWS as any, LOCS as any, 'Sin localidad').find((g) => g.key === '1')!;
const rosterGroup = (codes: boolean) => render(<RosterGroup group={group} page={1} size={20} onPage={() => {}} collapsed={false} onToggle={() => {}}
    columns={[FIELDS[2], FIELDS[3], FIELDS[4]]} nameOf={nameOf} canSeeCodes={codes} onOpen={() => {}} onBarcode={() => {}} />);

describe('«Inscripciones» desktop table: Participante is never starved, the CARD decides what fits', () => {
    it('the lab\'s 1280 px window (an 862 px card beside the sidebar): the table with ONE form column and a 12rem name column', () => {
        // Was: Código/Pago/Alojamiento/⋮ fixed at 35.25rem of an 828 px table → Participante ~56 px of text.
        const at1280 = rosterLayoutFor(862, true, 3);
        expect(at1280).toEqual({ table: true, fields: 1, folded: 2, lodgingRem: 8 });
        const fixedPx = (ROSTER_COLUMNS_REM.code + ROSTER_COLUMNS_REM.pay + ROSTER_COLUMNS_REM.lodging + ROSTER_COLUMNS_REM.more) * REM;
        const tablePx = 862 - 2 * REM;
        // What Participante and the shown form column get: at least their minimums.
        expect(tablePx - fixedPx - ROSTER_COLUMNS_REM.name * REM).toBeGreaterThanOrEqual(ROSTER_FIELD_MIN_REM * REM);
        expect(ROSTER_COLUMNS_REM.name * REM - 2 * REM).toBeGreaterThanOrEqual(150);   // «Clara Echeverri» / «PARTICIPANTE» on one line
        expect(rosterLayoutFor(948, true, 3)).toMatchObject({ table: true, fields: 1 });      // 1366 px window (round 7: 8.5rem form columns)
        expect(rosterLayoutFor(1504, true, 3)).toMatchObject({ table: true, fields: 3 });     // 1920 px window
        expect(rosterLayoutFor(640, true, 3)).toMatchObject({ table: false, fields: 0 });     // a tablet in portrait: the list
        expect(rosterLayoutFor(640, false, 3).table).toBe(true);                         // no Código column: it fits
        for (const px of [700, 760, 862, 948, 1100, 1504]) {
            const l = rosterLayoutFor(px, true, 3);
            if (!l.table) continue;
            expect(rosterTableMinRem(true, l.fields) * REM, `${px}`).toBeLessThanOrEqual(px);
        }
    });
    it('ROSTER_CSS: the card is a size container; the list / table switch and each form column follow its width', () => {
        expect(ROSTER_CSS).toMatch(/\[data-cm-roster-card\] \{ overflow: clip; container: cm-roster \/ inline-size; \}/);
        expect(ROSTER_CSS).toContain(`@container cm-roster (max-width: ${(rosterTableMinRem(true) - 0.01).toFixed(2)}rem) { [data-cm-roster-card][data-codes="1"] [data-cm-roster-list] { display: block; } [data-cm-roster-card][data-codes="1"] [data-cm-roster-table] { display: none; } }`);
        expect(ROSTER_CSS).toContain(`@container cm-roster (min-width: ${rosterTableMinRem(true)}rem) { [data-cm-roster-card][data-codes="1"] [data-cm-roster-list] { display: none; }`);
        for (const codes of [1, 0]) for (const k of [1, 2, 3]) {
            expect(ROSTER_CSS).toContain(`@container cm-roster (max-width: ${(rosterTableMinRem(!!codes, k) - 0.01).toFixed(2)}rem) { [data-cm-roster-card][data-codes="${codes}"] [data-cm-fcol="${k}"] { display: none; }`);
        }
        // The 768 px media switch stays as the fallback of a browser without container queries.
        expect(ROSTER_CSS).toMatch(/@media \(min-width: 768px\) \{\s*\[data-cm-roster-list\] \{ display: none; \}/);
    });
    it('RosterGroup: the header cells carry the fixed widths (no 35rem colgroup), form columns are numbered, the card says whether Código is there', () => {
        const html = rosterGroup(true);
        const table = html.slice(html.indexOf('data-cm-roster-table'));
        expect(table).not.toContain('<colgroup');
        expect(table).toMatch(/<th scope="col" style="width:12rem"[^>]*>Participante</);
        expect(table).toMatch(/<th scope="col" style="width:8.5rem"[^>]*>Código</);
        expect(table).toMatch(/<th scope="col" style="width:11rem"[^>]*>Pago</);
        expect(table).toMatch(/<th scope="col" style="width:8rem"[^>]*>Alojamiento</);
        expect(table).toMatch(/<th scope="col" style="width:3.5rem"/);
        expect([...table.matchAll(/<th scope="col" data-cm-fcol="(\d)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(['1:Email', '2:Teléfono', '3:Iglesia']);
        expect(table.match(/<td data-cm-fcol="3"/g)).toHaveLength(2);
        expect(html).toMatch(/data-cm-roster-card="" data-codes="1"/);
        expect(rosterGroup(false)).toMatch(/data-cm-roster-card="" data-codes="0"/);
        // The money chips of the Pago cell may wrap between words instead of running into Alojamiento.
        expect(table).toMatch(/data-chip="pending" class="[^"]*whitespace-normal/);
    });
    it('the phone row: the room is its own wrapping part, never cut with «…»', () => {
        const html = rosterGroup(true);
        const list = html.slice(html.indexOf('data-cm-roster-list'), html.indexOf('data-cm-roster-table'));
        expect(list).toMatch(/<span class="flex flex-wrap items-center[^"]*" data-row-facts="">/);
        expect(list).toMatch(/<span class="min-w-0 break-words" data-row-room="">Sin habitación<\/span>/);
        expect(list).toMatch(/<span class="whitespace-nowrap tabular-nums">\$0,00 \/ \$250,00<\/span>/);
        expect(list).not.toMatch(/class="truncate"/);
    });
    it('the «Columnas» hint says that a narrow screen shows the columns that fit', () => {
        for (const lang of ['es', 'en', 'pt'] as const) expect(translations[lang]['roster.columns.hint'], lang).toMatch(/⋮/);
    });
});

// ── «Contabilidad» ──────────────────────────────────────────────────────────────────────────────────
describe('«Contabilidad»: the movements fit the room the panel has', () => {
    const acc = read('admin/AccountingPage.tsx');
    it('no window breakpoints for the layout: the page and «Movimientos» are size containers', () => {
        expect(acc).not.toMatch(/xl:grid-cols-3|xl:col-span-2|md:grid-cols-7|md:col-span-7/);
        expect(acc).toMatch(/<div className="space-y-8 animate-in fade-in duration-500" data-ledger-page="">\s*<style>\{LEDGER_CSS\}<\/style>/);
        expect(acc).toContain('<div data-ledger-grid="">');
        expect(acc).toMatch(/data-ledger-movements="">/);
        expect(LEDGER_CSS).toContain('[data-ledger-page] { container: cm-ledger / inline-size; }');
        expect(LEDGER_CSS).toContain('[data-ledger-movements] { container: cm-ledger-moves / inline-size; }');
        expect(LEDGER_CSS).toMatch(/@container cm-ledger \(min-width: 75rem\) \{\s*\[data-ledger-grid\] \{ grid-template-columns: minmax\(0, 1fr\) 22rem; \}/);
    });
    it('below 60rem Categoría and Forma de pago fold into the description; below 40rem each movement is a block', () => {
        // (a wrapping row of facts since UX6-4: each «·» starts the fact after it)
        expect(LEDGER_CSS).toMatch(/@container cm-ledger-moves \(max-width: 59\.99rem\) \{\s*\[data-ledger-table\] \[data-cell="category"\], \[data-ledger-table\] \[data-cell="method"\] \{ display: none; \}\s*\[data-ledger-inline-meta\] \{ display: flex; flex-wrap: wrap; column-gap: 0\.25rem; \}/);
        expect(LEDGER_CSS).toMatch(/@container cm-ledger-moves \(max-width: 39\.99rem\) \{[\s\S]*tr\[data-ledger-line\] \{ display: grid;[\s\S]*\[data-cell="amount"\] \{ grid-column: 2; grid-row: 1; \}[\s\S]*\[data-cell="desc"\] \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
        for (const cell of ['date', 'desc', 'category', 'method', 'amount', 'actions']) expect(acc, cell).toContain(`data-cell="${cell}"`);
        expect(acc).toContain('data-ledger-inline-meta=""');
        // The parts of a shared payment no longer force a 14rem minimum into the description.
        expect(acc).not.toContain('min-w-[14rem]');
    });
    it('the filters wrap at 9rem each (dates never squeezed to «dd/mm,»), 16 px on a phone, 44 px high', () => {
        expect(LEDGER_CSS).toContain('[data-ledger-filters] { display: grid; gap: 0.75rem; align-items: end; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); }');
        expect(acc).toMatch(/const inputCls = '[^']*min-h-\[44px\][^']*text-base sm:text-sm';/);
        expect(acc).toContain('data-ledger-filters=""');
    });
    it('one movement has ONE «Forma de pago» (column and form), as the portal says it', () => {
        expect(acc).toContain("['method', tx('payment.method', 'Forma de pago')]");
        expect(acc).not.toContain("t('payment.methods')");
    });
});

// ── «Pagos de cuotas»: the review queue's bar ───────────────────────────────────────────────────────
describe('the review queue on a 1280 px window: the decision bar is one row, flush with the panel', () => {
    it('the list column shrinks so the payment keeps ~560 px at the narrowest master-detail', () => {
        expect(QUEUE_LIST_COLUMN).toBe('clamp(17rem, 32%, 380px)');
        expect(FEES_CSS).toContain(`[data-fees-master] { display: grid; grid-template-columns: ${QUEUE_LIST_COLUMN} minmax(0, 1fr);`);
        const list = (w: number) => Math.min(380, Math.max(17 * REM, 0.32 * w));
        const detail = MASTER_DETAIL_MIN_PX - list(MASTER_DETAIL_MIN_PX) - 1.5 * REM;
        expect(detail).toBeGreaterThanOrEqual(555);
        // The lab's bar buttons measured 138 + 141 + 195 px at the old padding; with 0.875rem sides and a
        // 1.25rem bar padding they fit one row with room to spare.
        const buttons = (138 - 4) + (141 - 4) + (195 - 4) + 2 * 8;
        expect(buttons + 2 * 1.25 * REM).toBeLessThanOrEqual(detail - 2);
        expect(FEES_CSS).toContain('[data-fees-detail] [data-transfer-actions] button { padding-left: 0.875rem; padding-right: 0.875rem; }');
    });
    it('the bar is the payment card own last row under its scrolling body — nothing scrolls under it (round 6)', () => {
        // Round 4 pinned the bar (sticky, bottom -1.5rem) over the payment; round 6 makes it the card's last row:
        // the card is as tall as the panel's room and only its body scrolls, so no strip ever passes under it.
        expect(FEES_CSS).not.toMatch(/\[data-transfer-actions\] \{ position: sticky/);
        expect(FEES_CSS).toContain('[data-fees-detail] > [data-transfer-body] { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }');
    });
});

// ── «Pagos de cuotas»: who people are (D-P20) ───────────────────────────────────────────────────────
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 500, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0, cancelled: false, payable: true, name: `#${id}`, location: 'Norte', family_group: null, status: 'active', reg_code: null, ...extra });
const VIEW = (people: any[], extra: any = {}) => ({
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: people.length, cancelled: 0, due: 1000, validated: 0, pending: 0, returned: 0, to_cover: 1000, credit: 0 },
    by_location: [{ location_id: 1, location: 'Norte', people: people.length, cancelled: 0, due: 1000, validated: 0, pending: 0, returned: 0, to_cover: 1000, credit: 0 }],
    counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [], people, ...extra,
});
describe('D-P20: «Pagos de cuotas» never reads the roster', () => {
    it('personRowOfWire: who the person is and their money under the roster\'s names — nothing else', () => {
        const row = personRowOfWire(W(7, { name: 'Ana Pérez', family_group: 'Pérez', validated: 100, pending: 150, returned: 20, reg_code: 'AB12' }) as any);
        expect(row).toEqual({ id: 7, name: 'Ana Pérez', location_id: 1, location: 'Norte', family_group: 'Pérez', status: 'active', reg_code: 'AB12', total_due: 500, amount_paid: 100, pending_amount: 150, returned_amount: 20 });
        const b = personBalance(row);
        expect([b.due, b.validated, b.pending, b.returned, b.toCover]).toEqual([50000, 10000, 15000, 2000, 25000]);
        expect(personRowOfWire(W(8, { cancelled: true, status: null }) as any).status).toBe('cancelled');
    });
    it('the page loads the view, the fields and the locations — never GET /inscriptions; names come from the view', () => {
        const src = read('admin/FeePaymentsPage.tsx');
        expect(src).not.toMatch(/getInscriptions\(/);
        expect(src).toContain('const rowById = useMemo(() => new Map((view?.people || []).map((w) => [Number(w.id), personRowOfWire(w)])), [view]);');
        // The full person (form answers, room, notes) only with Inscripciones › ver, for that one person.
        expect(src).toContain("const canRoster = perms.can('inscriptions');");
        expect(src).toMatch(/if \(personId == null \|\| !canRoster\) \{ setFullPerson\(null\); return undefined; \}\s*let alive = true;\s*conferenceApi\.getInscription\(personId\)/);
        expect(src).toContain('<PersonSheet person={personRow} brief={!fullRow}');
        const html = render(<FeePaymentsPage conferenceId={1} initial={{ view: VIEW([W(1, { name: 'Ana Pérez', family_group: 'Pérez' }), W(2, { name: 'Luis Gómez' })]), fields: [], locations: [{ id: 1, name: 'Norte' }], section: 'balances' }} />);
        expect(html).toMatch(/data-balance-row="1"[\s\S]*?>Ana Pérez</);
        expect(html).toMatch(/data-balance-row="2"[\s\S]*?>Luis Gómez</);
    });
    it('the brief person sheet: header, «Pago» and the code — no room, form answers or notes drawn empty', () => {
        const row = personRowOfWire(W(1, { name: 'Ana Pérez', family_group: 'Pérez', reg_code: 'AB12CD' }) as any);
        const sheet = (brief: boolean) => render(<PersonSheet person={row} brief={brief} fields={FIELDS} locations={LOCS} nameOf={(r: any) => r.name}
            canSeeCodes canPayView canPayManage onClose={() => {}} onRegister={() => {}} onSeePayments={() => {}} onOpenTransfer={() => {}} />);
        const brief = sheet(true);
        expect(brief).toContain('data-person-section="pay"');
        expect(brief).toContain('data-person-section="code"');
        expect(brief).toContain('>Ana Pérez</h2>');
        expect(brief).toContain('Pérez');
        for (const s of ['lodging', 'fields', 'inscription']) expect(brief, s).not.toContain(`data-person-section="${s}"`);
        expect(brief).not.toContain('Sin habitación');
        const full = sheet(false);
        for (const s of ['lodging', 'fields', 'inscription']) expect(full, s).toContain(`data-person-section="${s}"`);
    });
    it('Pagos alone does not read the roster (the server refuses it): the conference cards count «Pagos de cuotas» people instead', () => {
        const perms = (sections: Record<string, string>) => ({ isAdmin: false, permissions: sections, can: (s: string) => !!sections[s] && sections[s] !== 'none' }) as any;
        expect(canReadRoster(perms({ payments: 'manage' }))).toBe(false);
        expect(canReadRoster(perms({ payments: 'view', inscriptions: 'view' }))).toBe(true);
        expect(canReadRoster(perms({ accounting: 'view' }))).toBe(true);
        const page = read('admin/page.tsx');
        expect(page).toContain("const countPeopleVia = canReadRoster(perms) ? 'roster' : perms.can('payments') ? 'fees' : null;");
        expect(page).toMatch(/countPeopleVia === 'fees' \? feePaymentsApi\.getView\(conf\.id\)\.then\(\(v: any\) => \(Array\.isArray\(v\?\.people\) \? v\.people : \[\]\), \(\) => \[\]\)/);
    });
});

// ── «Por localidad»: «A favor» ──────────────────────────────────────────────────────────────────────
describe('«Resumen › Por localidad» attributes the money «A favor» to its location', () => {
    const summary = (credit: number) => render(<FeePaymentsPage conferenceId={1} initial={{
        view: VIEW([W(1, {})], {
            summary: { people: 1, cancelled: 1, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit },
            by_location: [
                { location_id: 1, location: 'Bogotá', people: 1, cancelled: 0, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0 },
                { location_id: 2, location: 'Cali', people: 0, cancelled: 1, due: 0, validated: 0, pending: 0, returned: 0, to_cover: 0, credit },
            ],
        }), fields: [], locations: [{ id: 1, name: 'Bogotá' }, { id: 2, name: 'Cali' }], section: 'summary',
    }} />);
    it('with credit: a column on the desktop table and a phrase on the phone line, per location', () => {
        const html = summary(250);
        expect(html).toContain('data-kpi="credit"');
        expect(html).toMatch(/<th scope="col" class="[^"]*" data-col="credit">A favor<\/th>/);
        expect(html).toContain('data-credit="2">$250,00</td>');
        expect(html).toContain('data-credit="1">$0,00</td>');
        expect(html).toMatch(/data-loc-row="2"[\s\S]*?\$250,00 a favor/);
    });
    it('without credit: no empty column', () => {
        expect(summary(0)).not.toContain('data-col="credit"');
    });
});

// ── the same words as the portal ────────────────────────────────────────────────────────────────────
describe('admin and portal say the same', () => {
    it('ONE method is «Forma de pago» (es) — never «Formas de pago» — in «Registrar pago»', () => {
        expect(translations.es['payment.method']).toBe('Forma de pago');
        expect(translations.en['payment.method']).toBeTruthy();
        expect(translations.pt['payment.method']).toBeTruthy();
        const opts = buildPersonOptions([{ id: 1, first_name: 'Ana', last_name: 'P', location_id: 1, status: 'active', total_due: 100 }], (p: any) => `${p.first_name} ${p.last_name}`, [{ id: 1, name: 'Norte' }]);
        const html = flat(renderToStaticMarkup(<I18nProvider><ToastProvider><RegisterPaymentSheet conferenceId={1} options={opts} locations={[{ id: 1, name: 'Norte' }]} methods={['Efectivo', 'Transferencia']} ids={[1]} onClose={() => {}} /></ToastProvider></I18nProvider>));
        expect(html).toContain('role="radiogroup" aria-label="Forma de pago"');
        expect(html).not.toMatch(/Formas de pago/i);
        expect(read('admin/RegisterPaymentSheet.tsx')).not.toContain("tx('payment.methods'");
        expect(read('admin/FeePaymentsPage.tsx')).not.toContain("tx('payment.methods'");
    });
    it('the words under a part: the admin (partAfterKind) and the portal (afterText) agree case by case', () => {
        const es = translations.es as Record<string, string>;
        const admin = (cap: number, part: number, bornValidated: boolean, otherPendingC: number) => {
            const k = partAfterKind(cap, part, { bornValidated, otherPendingC });
            return k === 'left' ? es['fees.part.left'].replace('{amount}', '$X') : k === 'paid_after_pending' ? es['fees.after.paid.after.pending'] : k === 'paid_when' ? es['fees.after.paid.when'] : k;
        };
        // A portal payment always waits for validation: compare with the admin's «Dejar por validar».
        expect(portalAfterText(0, 0)).toBe(admin(10000, 10000, false, 0));
        expect(portalAfterText(0, 4000)).toBe(admin(10000, 10000, false, 4000));
        expect(portalAfterText(5000, 0).replace(/\$[\d.,]+/, '$X')).toBe(admin(10000, 5000, false, 0));
        expect(es['fees.part.over.max']).toBe('Supera lo que falta: máximo {amount}');
        expect(read('admin/RegisterPaymentSheet.tsx')).toContain("tx('fees.part.over.max', 'Supera lo que falta: máximo {amount}', { amount: money(over.max) })");
        for (const lang of ['es', 'en', 'pt'] as const) expect((translations[lang] as any)['fees.part.over'], lang).toBeUndefined();
    });
    it('an amount typed «250» reads «250,00» once the input is left (the total and every «Manual» part)', () => {
        expect(tidyMoneyInput('250')).toBe('250,00');
        expect(tidyMoneyInput('1.250,5')).toBe('1.250,50');
        expect(tidyMoneyInput('100.5')).toBe('100,50');
        expect(tidyMoneyInput('250,00')).toBe('250,00');
        expect(tidyMoneyInput('abc')).toBe('abc');
        expect(tidyMoneyInput('')).toBe('');
        const src = read('admin/RegisterPaymentSheet.tsx');
        expect(src).toContain("onBlur={() => { const tidy = tidyMoneyInput(draft.amount); if (tidy !== draft.amount) set({ amount: tidy }); }}");
        expect(src).toContain("onBlur={() => { if (draft.mode !== 'manual') return; const tidy = tidyMoneyInput(shownText); if (tidy !== shownText) typePart(p.inscription_id, tidy); }}");
    });
});

// ── the person picker ───────────────────────────────────────────────────────────────────────────────
describe('«+ Añadir»: the search and the location select', () => {
    it('the search holds 20rem and the location select wraps under it — no two-column grid', () => {
        const html = render(<PersonPicker options={[]} chosen={[]} onAdd={() => {}} onDone={() => {}} locations={[{ id: 1, name: 'Norte' }]} />);
        expect(html).toMatch(/<div class="flex flex-wrap gap-2" data-picker-filters="">/);
        // Round 5: a short placeholder (the long one was still cut mid-word on every phone); see feesRound5.
        expect(html).toMatch(/placeholder="Buscar persona"[^>]*data-picker-search=""[^>]*class="min-w-0 flex-\[2_1_20rem\]/);
        expect(html).not.toContain('sm:grid-cols-2 gap-2"><input');
    });
});
