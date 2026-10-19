/**
 * conference-manager 2.18.0 — the fixes of the eighth round (the fifth review round: money / concurrency, the
 * phone UX / accessibility review, the live lab and the skeptic), admin plugin side. Server-rendered or pure
 * (node, no DOM; effects do not run): each pinned so that undoing it fails here.
 *   - «Validar» of a voided transfer whose reference another live payment uses asks before sending it again
 *     with the flag (R5-M1); the Excel shows server stamps in the browser's time zone and «Registrado por» in
 *     words;
 *   - a focused field comes into sight WITH the line that describes it, and again when that line turns into
 *     the reason a part is refused (PUX-1); sheets pin their header and footer on a phone held sideways too
 *     (PUX-3); the person sheet says what «Cancelar / Reactivar / Eliminar» did inside it (PUX-2) and gives the
 *     focus to the neighbouring row after a delete (PUX-8);
 *   - nothing splits a count from its noun or leaves a «·» alone (PUX-5, PUX-9, PUX-10); the receipt pickers
 *     are focusable buttons (PUX-6); the one-choice strips have the arrow keys their roles promise (PUX-7); the
 *     details list is valid (PUX-11); a clickable KPI tile lines up with its siblings.
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
import { TransferPanel, factsOf, validateWithConfirm } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { KPI_TILE_BOX, KpiTile, SegmentedControl, segmentKeyDown, segmentKeyTarget } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import { PersonSheet } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { RosterGroup } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterGroup';
import { InfoRow } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterBits';
import { ProofPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/ProofViewer';
import { OVERLAY_CSS, SHORT_TOUCH_MEDIA, describedBox, revealFocused, revealFocusedField } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { focusFirstVisible, groupByLocation, rosterNeighborSelectors } from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';
import { feeLineTitle, filterLedger } from '../../../../../marketplace/plugins/conference-manager/client/lib/accounting';
import { buildFeePaymentsWorkbook, columnValue, localStamp } from '../../../../../marketplace/plugins/conference-manager/client/lib/exports';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';

const ROOT = path.resolve(__dirname, '../../../../..');
const CM = path.join(ROOT, 'marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(<I18nProvider><ToastProvider>{node}</ToastProvider></I18nProvider>));
const fill = (_k: string, f: string, v?: Record<string, unknown>) => String(f).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? String(v[k]) : m));
const NB = ' ';
/** Run `fn` with the process in time zone `tz` (Node re-reads TZ on change). */
const inZone = <T,>(tz: string, fn: () => T): T => {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};

const TR = (extra: any = {}) => ({
    id: 12, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 250, allocated: 250, method: 'Transferencia', reference: 'KEEP-77',
    paid_on: '2026-10-07', note: null, status: 'rejected', review_note: 'No llegó', alloc_gen: 1, recorded_via: 'portal', recorded_by: 'portal:1',
    created_at: '2026-10-07 09:00:00', submitted_at: '2026-10-07 09:00:00', updated_at: null, updated_by: null, reviewed_at: '2026-10-07 10:00:00', reviewed_by: 'boss',
    has_proof: false, legacy: false, people: 1, duplicate_of: null, reused_by: [],
    allocations: [{ id: 1, inscription_id: 1, amount: 250, location_id: 1, cancelled: false, name: 'Ana Pérez', due: 500, total_due: 500, validated_other: 0, pending_other: 0, after: { paid: 250, owed: 250, credit: 0 } }],
    flags: { cancelled_people: [], duplicate_reference: true, duplicate_reference_of: 14 }, events: [], ...extra,
});

// ── R5-M1: «Validar» of a voided transfer whose reference another payment counts ─────────────────────────
describe('R5-M1: validating a voided transfer again asks when another live payment uses its reference', () => {
    const dup = Object.assign(new Error('Esa referencia ya se usó en otro pago.'), { code: 'duplicate_reference', details: { other: { id: 21 } } });
    it('a 409 duplicate_reference → «Esa referencia ya cuenta en el pago #N…» → sent again with the flag', async () => {
        const calls: boolean[] = [];
        const confirm = vi.fn(async () => true);
        const r = await validateWithConfirm(TR(), { validate: async (allow) => { calls.push(allow); if (!allow) throw dup; return { status: 'validated' }; }, confirm, tx: fill });
        expect(r).toEqual({ status: 'validated' });
        expect(calls).toEqual([false, true]);
        expect(confirm).toHaveBeenCalledWith('Esa referencia ya cuenta en el pago #21. ¿Validar de todas formas?', 'Validar de todas formas', false);
    });
    it('«No» sends nothing more; without the server naming it, the detail\'s flag names the payment; other errors pass through', async () => {
        const calls: boolean[] = [];
        const no = await validateWithConfirm(TR(), { validate: async (allow) => { calls.push(allow); throw Object.assign(new Error('x'), { code: 'duplicate_reference' }); }, confirm: async () => false, tx: fill });
        expect([no, calls]).toEqual([{ cancelled: true }, [false]]);
        const confirm = vi.fn(async (_message: string, _label: string, _danger?: boolean) => false);
        await validateWithConfirm(TR(), { validate: async () => { throw Object.assign(new Error('x'), { code: 'duplicate_reference' }); }, confirm, tx: fill });
        expect(confirm.mock.calls[0][0]).toContain('#14');
        const stale = Object.assign(new Error('stale'), { code: 'stale' });
        await expect(validateWithConfirm(TR(), { validate: async () => { throw stale; }, confirm, tx: fill })).rejects.toBe(stale);
    });
    it('the button goes through it, the api sends allow_duplicate_reference, and a «No» shows no success', () => {
        const ts = read('admin/TransferSheet.tsx');
        expect(ts).toMatch(/run\('validate', \(\) => validateWithConfirm\(t, \{ validate: \(allow\) => feePaymentsApi\.validate\(t\.id, expectedOf\(t\), allow\), confirm, tx \}\)/);
        expect(ts).toMatch(/const r = await fn\(\);\s*if \(r && r\.cancelled\) return;/);
        expect(read('lib/conference.ts')).toMatch(/validate: \(id: number, expected: FeeExpected, allowDuplicateReference = false\)[^\n]*allow_duplicate_reference: true/);
        for (const l of ['es', 'en', 'pt'] as const) {
            for (const k of ['fees.confirm.validate.reference', 'fees.confirm.validate.reference.any', 'fees.action.validate.anyway']) expect((translations[l] as any)[k], `${l} ${k}`).toBeTruthy();
            expect((translations[l] as any)['fees.confirm.validate.reference']).toContain('{id}');
        }
    });
});

// ── the Excel: local time, words ──────────────────────────────────────────────────────────────────────────
describe('the «Pagos de cuotas» Excel and the roster Excel show server stamps in the browser\'s time zone', () => {
    const book = () => buildFeePaymentsWorkbook({
        transfers: [{ id: 3, paid_on: '2026-10-08', location_id: 1, recorded_via: 'portal', recorded_by: 'portal:1', method: 'Transferencia', reference: 'R', amount: 50, people: 1,
            status: 'rejected', reviewed_by: 'boss', reviewed_at: '2026-10-09 00:05:08', note: null, review_note: 'x', allocations: [{ inscription_id: 1, amount: 50, location_id: 1 }] },
        { id: 4, paid_on: '2026-10-08', location_id: null, recorded_via: 'admin', recorded_by: 'boss', method: 'Efectivo', reference: null, amount: 10, people: 1,
            status: 'validated', reviewed_by: 'boss', reviewed_at: '2026-10-08T23:40:57.000Z', note: null, review_note: null, allocations: [{ inscription_id: 1, amount: 10, location_id: 1 }] }],
        people: [], nameOf: () => 'Ana', locationName: (id) => (id === 1 ? 'Bogotá' : ''),
    });
    it('«Revisado el» at 19:05 in Bogotá is the 8th, never the UTC day; «Registrado por» says «Portal de Bogotá»', () => {
        const rows = inZone('America/Bogota', () => book()[0].rows);
        expect(rows[0][11]).toBe('2026-10-08 19:05:08');
        expect(rows[1][11]).toBe('2026-10-08 18:40:57');
        expect([rows[0][4], rows[1][4]]).toEqual(['Portal de Bogotá', 'boss']);
        // A plain date stays as it is; the roster Excel's «Fecha de inscripción» too is local.
        expect(inZone('America/Bogota', () => [localStamp('2026-10-08'), columnValue({ registration_date: '2026-10-09 00:05:03' }, 'registration_date')])).toEqual(['2026-10-08', '2026-10-08 19:05:03']);
        expect(inZone('UTC', () => localStamp('2026-10-09 00:05:08'))).toBe('2026-10-09 00:05:08');
    });
});

// ── PUX-1: a field revealed with what describes it ───────────────────────────────────────────────────────
describe('PUX-1: a focused part comes into sight with its «máximo» line, and again when the line changes', () => {
    const box = (top: number, bottom: number, extra: any = {}) => ({ getBoundingClientRect: () => ({ top, bottom }), contains: () => false, ...extra });
    const sheet = (describer: any) => {
        const foot = box(560, 667, { pinned: true });
        const head = box(0, 70, { pinned: true });
        const inner = { firstElementChild: { firstElementChild: head } };
        return {
            scrollTop: 100, getBoundingClientRect: () => ({ top: 0, bottom: 667 }),
            querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? foot : sel === '[data-cm-overlay-inner]' ? inner : sel === '[id="fee-part-after-7"]' ? describer : null),
        } as any;
    };
    const win = { getComputedStyle: (el: any) => ({ position: el.pinned ? 'sticky' : 'static' }), visualViewport: null };
    it('the field alone fits above the footer, its red line under it does not: the overlay scrolls the line clear', () => {
        const field = box(500, 544, { getAttribute: (n: string) => (n === 'aria-describedby' ? 'fee-part-after-7' : null) });
        const outer = sheet(box(548, 568));
        expect(describedBox(outer, field)).toEqual({ top: 500, bottom: 568 });
        expect(revealFocusedField(outer, field, win)).toBe(16);   // 568 + 8 − 560
        expect(outer.scrollTop).toBe(116);
        // An empty describer (no text: no height) adds nothing.
        const quiet = sheet(box(548, 548));
        expect(revealFocusedField(quiet, field, win)).toBe(0);
    });
    it('revealFocused re-runs it for the focused part only; the register sheet calls it when a part turns over its máximo', () => {
        const outer = sheet(box(548, 568));
        const part = box(500, 544, { tagName: 'INPUT', type: '', id: 'fee-part-7', getAttribute: (n: string) => (n === 'aria-describedby' ? 'fee-part-after-7' : null), closest: () => outer });
        const isPart = (el: { id?: string }) => /^fee-part-\d+$/.test(String(el.id || ''));
        expect(revealFocused({ activeElement: part }, win, isPart)).toBe(16);
        expect(revealFocused({ activeElement: { ...part, id: 'fee-amount' } }, win, isPart)).toBe(0);
        expect(revealFocused({ activeElement: { tagName: 'BUTTON', closest: () => outer } }, win)).toBe(0);
        const src = read('admin/RegisterPaymentSheet.tsx');
        expect(src).toMatch(/const overKey = check\.overCap\.map\(\(x\) => x\.inscription_id\)\.join\(','\);\s*useEffect\(\(\) => \{[\s\S]*?revealFocused\(document, [^\n]*fee-part-\\d\+\$\/[\s\S]*?\}, \[overKey\]\);/);
        // «Usar lo que falta» describes «Monto total»: it is revealed with it.
        expect(src).toMatch(/id="fee-amount"[\s\S]{0,240}aria-describedby=\{useOwedShown \? 'fee-use-owed' : undefined\}/);
        expect(src).toContain('const useOwedShown = owedC > 0 && totalC !== owedC;');
        expect(src).toContain('id="fee-use-owed"');
    });
});

// ── PUX-3: a phone held sideways pins the sheet's header and footer ──────────────────────────────────────
describe('PUX-3: a sheet pins its header (✕) and footer (main button + reason) on a short touch screen too', () => {
    it('the sticky rules, the clipped card and the scroll padding are under the short-touch media query', () => {
        expect(SHORT_TOUCH_MEDIA).toBe('(max-height: 500px) and (pointer: coarse)');
        const block = OVERLAY_CSS.slice(OVERLAY_CSS.indexOf(`@media ${SHORT_TOUCH_MEDIA} {`));
        expect(block.startsWith('@media (max-height: 500px) and (pointer: coarse) {')).toBe(true);
        const body = block.slice(0, block.indexOf('\n}\n'));
        expect(body).toContain('[data-cm-sheet] [data-cm-sheet-foot] { position: sticky; bottom: 0;');
        expect(body).toContain('[data-cm-sheet] > [data-cm-overlay-inner] > * > :first-child { position: sticky;');
        expect(body).toContain('.overflow-hidden { overflow: clip; }');
        expect(body).toContain('scroll-padding-bottom: var(--cm-foot-h, 6rem)');
        // The phone (narrow) rules keep them.
        const phone = OVERLAY_CSS.slice(OVERLAY_CSS.indexOf('@media (max-width: 639.98px) {'));
        expect(phone.slice(0, phone.indexOf('\n}\n'))).toContain('[data-cm-sheet] [data-cm-sheet-foot] { position: sticky;');
    });
});

// ── PUX-2 / PUX-8 / PUX-11: the person sheet ─────────────────────────────────────────────────────────────
const LOCS = [{ id: 1, name: 'Norte' }];
const FIELDS = [{ id: 1, name: 'first_name', label: 'Nombre', role: 'first_name' }, { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name' }];
const PERSON = { id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 500, amount_paid: 0, pending_amount: 0, payment_status: 'unpaid', reg_code: 'AB12', registration_date: '2026-09-01 10:00:00', notes: 'Llega tarde' };
const nameOf = (p: any) => `${p.first_name} ${p.last_name}`;
const handlers = { onEdit: () => {}, onToggleCancel: () => {}, onDelete: () => {} };
describe('PUX-2: «Eliminar» / «Cancelar inscripción» / «Reactivar» say what happened inside the sheet', () => {
    it('an error is a role=alert notice in the dialog, right above the action row; a success a status', () => {
        const msg = 'La inscripción forma parte de un pago compartido de 3 personas: quítala del reparto del pago #12 («Editar reparto»), o cancela la inscripción en su lugar.';
        const html = render(<PersonSheet person={PERSON} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} canManage {...handlers} notice={{ type: 'error', text: msg }} />);
        const dialog = html.slice(html.indexOf('role="dialog"'));
        const at = dialog.indexOf('data-person-notice="error"');
        expect(at).toBeGreaterThan(0);
        expect(dialog.slice(at)).toMatch(/^data-person-notice="error"><p role="alert"[^>]*>[\s\S]*?quítala del reparto del pago #12/);
        expect(at).toBeLessThan(dialog.indexOf('data-person-actions'));
        const ok = render(<PersonSheet person={PERSON} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} canManage {...handlers} notice={{ type: 'success', text: 'Inscripción cancelada.' }} />);
        expect(ok).toMatch(/data-person-notice="success"><p role="status"/);
        expect(render(<PersonSheet person={PERSON} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} canManage {...handlers} />)).not.toContain('data-person-notice');
    });
    it('the page sets that notice — never a toast over the sheet\'s buttons — and clears it with the next action or another sheet', () => {
        const src = read('admin/page.tsx').replace(/\r\n/g, '\n');
        const cancel = src.slice(src.indexOf('const toggleCancel = async'), src.indexOf('const handleDelete = async'));
        const del = src.slice(src.indexOf('const handleDelete = async'), src.indexOf('// ── room'));
        expect(cancel).not.toContain('addToast(');
        expect(cancel).toMatch(/setSheetNotice\(\{ id: person\.id, type: 'success'/);
        expect(cancel).toMatch(/catch \(error: any\) \{[\s\S]*?setSheetNotice\(\{ id: person\.id, type: 'error', text: error\?\.message \|\| 'Error' \}\);/);
        expect(del).toMatch(/catch \(error: any\) \{[\s\S]*?setSheetNotice\(\{ id: person\.id, type: 'error', text: error\?\.message \|\| 'Error' \}\);[\s\S]*?\} finally/);
        expect(del.slice(del.indexOf('catch (error'))).not.toContain('addToast(');
        expect(src).toContain('useEffect(() => { setSheetNotice(null); }, [openId]);');
        expect(src).toMatch(/notice=\{sheetNotice && sheetNotice\.id === openPersonRow\.id \? sheetNotice : null\}/);
    });
});

describe('PUX-8: after «Eliminar» the focus goes to the neighbouring row, never to <body>', () => {
    // A fake card: rows 4, 7, 9 (phone rows; on a desktop the «⋮» of each).
    const el = (attrs: Record<string, string>, extra: any = {}) => ({ getAttribute: (n: string) => (n in attrs ? attrs[n] : null), ...extra });
    const card: any = el({ 'data-roster-group': '1' });
    const rows = ['4', '7', '9'].map((id) => el({ 'data-cm-roster-row': id }, { closest: () => card }));
    card.querySelectorAll = () => rows;
    const doc = { querySelector: (sel: string) => rows.find((r) => sel === `[data-cm-roster-row="${r.getAttribute('data-cm-roster-row')}"]`) || null };
    it('the next row of the same card, else the previous one, else the card\'s own first control', () => {
        expect(rosterNeighborSelectors(doc, 7)).toEqual(['[data-cm-more="9"], [data-cm-roster-row="9"]', '[data-cm-more="4"], [data-cm-roster-row="4"]', '[data-roster-group="1"] [data-cm-roster-head] button']);
        expect(rosterNeighborSelectors(doc, 9)[0]).toBe('[data-cm-more="7"], [data-cm-roster-row="7"]');
        expect(rosterNeighborSelectors(doc, 123)).toEqual([]);
        expect(rosterNeighborSelectors(null, 7)).toEqual([]);
    });
    it('focusFirstVisible focuses the first VISIBLE match of the first selector that has one', () => {
        const hidden = { offsetParent: null, focus: vi.fn() };
        const shown = { offsetParent: {}, focus: vi.fn() };
        const head = { offsetParent: {}, focus: vi.fn() };
        const d = { querySelectorAll: (sel: string) => (sel.startsWith('[data-cm-more="9"]') ? [hidden, shown] : sel.includes('roster-head') ? [head] : []) };
        expect(focusFirstVisible(d, ['[data-cm-more="9"], [data-cm-roster-row="9"]', '[data-roster-group="1"] [data-cm-roster-head] button'])).toBe(true);
        expect([hidden.focus.mock.calls.length, shown.focus.mock.calls.length, head.focus.mock.calls.length]).toEqual([0, 1, 0]);
        expect(focusFirstVisible(d, ['[data-cm-more="1"]', '[data-roster-group="1"] [data-cm-roster-head] button'])).toBe(true);
        expect(head.focus).toHaveBeenCalled();
    });
    it('the page reads the neighbours BEFORE the delete and focuses them once the sheet has closed', () => {
        const src = read('admin/page.tsx').replace(/\r\n/g, '\n');
        const del = src.slice(src.indexOf('const handleDelete = async'), src.indexOf('// ── room'));
        expect(del.indexOf('rosterNeighborSelectors(document, person.id)')).toBeGreaterThan(0);
        expect(del.indexOf('rosterNeighborSelectors(document, person.id)')).toBeLessThan(del.indexOf('await conferenceApi.deleteInscription(person.id)'));
        expect(del).toMatch(/refocus\.current = neighbours;\s*setOpenId\(null\);/);
        expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(openId != null \|\| !refocus\.current[^\n]*\n[\s\S]*?focusFirstVisible\(document, sels\);\s*\}, \[openId, inscriptions\]\);/);
    });
});

describe('PUX-11: the person sheet\'s details list is valid — dl > div > dt + dd, never a div in a div', () => {
    it('«Notas internas» carries its own sm:col-span-2', () => {
        const html = render(<PersonSheet person={PERSON} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} />);
        expect(html).toContain('<div class="min-w-0 sm:col-span-2"><dt class="text-[10px] font-black uppercase tracking-widest text-gray-500">Notas internas</dt><dd');
        for (const dl of html.match(/<dl[^>]*>[\s\S]*?<\/dl>/g) || []) expect(dl).not.toMatch(/<div[^>]*>\s*<div/);
        expect(flat(renderToStaticMarkup(<dl><InfoRow label="A">b</InfoRow></dl>))).toBe('<dl><div class="min-w-0"><dt class="text-[10px] font-black uppercase tracking-widest text-gray-500">A</dt><dd class="text-sm text-gray-900 font-medium break-words">b</dd></div></dl>');
    });
});

// ── PUX-5 / PUX-9 / PUX-10: words that stay together ─────────────────────────────────────────────────────
describe('a count never splits from its noun, and a «·» is never left alone at the end of a line', () => {
    it('PUX-5: «Contabilidad»\'s titles keep «1 persona» / «3 personas» / «1 de 3 personas» whole (es, en, pt); search still finds them', () => {
        const line = (extra: any) => ({ source: 'inscription' as const, transfer_id: 5, people: 3, description: 'x', allocations: [], ...extra });
        expect(feeLineTitle(line({ people: 1 }))).toBe(`Pago de cuotas ·${NB}1${NB}persona`);
        expect(feeLineTitle(line({}))).toBe(`Pago de cuotas ·${NB}3${NB}personas`);
        expect(feeLineTitle(line({ people: 1, share_total: 3 }))).toBe(`Pago de cuotas ·${NB}1${NB}de 3${NB}personas`);
        for (const l of ['es', 'en', 'pt'] as const) {
            const t = translations[l] as any;
            for (const k of ['accounting.fee.line', 'accounting.fee.line.one', 'accounting.fee.share']) expect(t[k], `${l} ${k}`).toMatch(new RegExp(`(\\{n\\}|1)${NB}`));
        }
        const e = { id: 'transfer-5', kind: 'income', date: '2026-10-01', category: 'Inscripciones', description: 'x', amount: 10, source: 'inscription', readonly: true, transfer_id: 5, people: 1, allocations: [{ inscription_id: 1, amount: 10 }] } as any;
        expect(filterLedger([e], { search: 'cuotas · 1 persona' } as any)).toHaveLength(1);
    });
    it('PUX-9: a location card says «1 pagado», «2 pagados» (es, en, pt)', () => {
        const ROWS = [{ id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 500, amount_paid: 500, payment_status: 'paid' }];
        const group = groupByLocation(ROWS as any, LOCS, 'Sin localidad').find((g: any) => g.key === '1')!;
        const card = (paid: number) => render(<RosterGroup group={{ ...group, counts: { total: 9, paid, pending: 6, cancelled: 0 } }} page={1} size={20} onPage={() => {}} collapsed={false} onToggle={() => {}} columns={[]} nameOf={nameOf} onOpen={() => {}} onBarcode={() => {}} />);
        expect(card(1)).toContain('>1 pagado<');
        expect(card(2)).toContain('>2 pagados<');
        expect([translations.es, translations.en, translations.pt].map((t: any) => t['roster.count.paid.one'])).toEqual(['{n} pagado', '{n} paid', '{n} pago']);
    });
    it('PUX-10: the payment header\'s facts are whole, each with its own «· »; the reference is one unit', () => {
        const head = render(<TransferPanel id={12} initial={TR({ status: 'pending', method: 'Efectivo', flags: { cancelled_people: [], duplicate_reference: false } })} canManage />);
        expect(head).toContain('data-transfer-facts=""><span style="white-space:nowrap" data-fact=""><span class="tabular-nums">$250,00</span></span><span style="white-space:nowrap" data-fact="">· Efectivo</span><span style="white-space:nowrap" data-fact="">· 07/10/2026</span><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">· Ref. KEEP-77</span></p>');
        expect(flat(renderToStaticMarkup(<p>{factsOf(['a', null, '', 'b'])}</p>))).toBe('<p><span style="white-space:nowrap" data-fact="">a</span><span style="white-space:nowrap" data-fact="">· b</span></p>');
    });
});

// ── PUX-6: the receipt picker is reachable by keyboard ───────────────────────────────────────────────────
describe('PUX-6: «Tomar foto o elegir archivo» / «Cambiar» are focusable buttons; the file input is out of the Tab order', () => {
    it('empty, and with a receipt kept', () => {
        const empty = render(<ProofPicker value={null} onChange={() => {}} required />);
        expect(empty).toMatch(/<button type="button" class="[^"]*focus-visible:outline-2[^"]*" data-proof-empty="">/);
        expect(empty).not.toMatch(/<label[^>]*for="fee-proof-input"/);
        expect(empty).toMatch(/<input type="file" accept="image\/\*" class="sr-only" id="fee-proof-input" data-proof-input="" tabindex="-1" aria-hidden="true"\/>/);
        const kept = render(<ProofPicker value={undefined} existingId={7} onChange={() => {}} required={false} />);
        expect(kept).toMatch(/<button type="button" class="[^"]*focus-visible:outline-2[^"]*" data-proof-change="">Cambiar<\/button>/);
        expect(read('admin/ProofViewer.tsx')).toMatch(/const choose = \(\) => \{ const el = inputRef\.current; if \(el && !busy\) \{ try \{ el\.click\(\);/);
    });
});

// ── PUX-7: the arrow keys of a one-choice strip ──────────────────────────────────────────────────────────
describe('PUX-7: SegmentedControl is one Tab stop with the arrow keys its radio / tab role promises', () => {
    it('segmentKeyTarget: arrows wrap, Home / End go to the ends, other keys do nothing', () => {
        const k = ['a', 'b', 'c'];
        expect(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Enter'].map((key) => segmentKeyTarget(k, 'a', key))).toEqual(['b', 'b', 'c', 'c', 'a', 'c', null]);
        expect(segmentKeyTarget(k, 'c', 'ArrowRight')).toBe('a');
        expect(segmentKeyTarget(k, 'a', 'ArrowRight', (x) => x === 'b')).toBe('c');
    });
    it('only the chosen option is in the Tab order; ArrowRight chooses the next and moves the focus there', () => {
        const html = render(<SegmentedControl variant="radio" label="Forma de pago" value="Efectivo" onChange={() => {}} options={[{ key: 'Efectivo', label: 'Efectivo' }, { key: 'Transferencia', label: 'Transferencia' }]} />);
        expect(html).toMatch(/role="radio" aria-checked="true" data-seg="Efectivo" tabindex="0"/);
        expect(html).toMatch(/role="radio" aria-checked="false" data-seg="Transferencia" tabindex="-1"/);
        const onChange = vi.fn();
        const next = { focus: vi.fn() };
        const strip = { querySelector: (sel: string) => (sel === '[data-seg="Transferencia"]' ? next : null) };
        const e = { key: 'ArrowRight', preventDefault: vi.fn(), currentTarget: { parentElement: strip } };
        segmentKeyDown(e, ['Efectivo', 'Transferencia'], 'Efectivo', onChange);
        expect([onChange.mock.calls, e.preventDefault.mock.calls.length, next.focus.mock.calls.length]).toEqual([[['Transferencia']], 1, 1]);
        const tab = { key: 'Tab', preventDefault: vi.fn(), currentTarget: { parentElement: strip } };
        segmentKeyDown(tab, ['Efectivo', 'Transferencia'], 'Efectivo', onChange);
        expect(tab.preventDefault).not.toHaveBeenCalled();
        expect(read('admin/FeeBits.tsx')).toMatch(/tabIndex=\{o\.key === stop \? 0 : -1\} onKeyDown=\{\(e\) => segmentKeyDown\(e, keys, o\.key, onChange\)\}/);
    });
});

// ── KPI tile alignment ────────────────────────────────────────────────────────────────────────────────────
describe('a clickable KPI tile («Por validar») lines up with its siblings', () => {
    it('button and div tiles share one box: a column stacked from the top', () => {
        expect(KPI_TILE_BOX).toMatchObject({ display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' });
        const style = 'style="container-type:inline-size;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch"';
        expect(render(<KpiTile label="Por validar" value="$250,00" icon="fa-clock" onClick={() => {}} kpi="pending" />)).toMatch(new RegExp(`^<button type="button" class="[^"]*" ${style.replace(/[()]/g, '\\$&')} data-kpi="pending">`));
        expect(render(<KpiTile label="Cuotas" value="$250,00" icon="fa-file" kpi="due" />)).toContain(`${style} data-kpi="due"`);
    });
});
