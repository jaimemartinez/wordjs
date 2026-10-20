/**
 * conference-manager 2.18.0 — source guards for «Pagos de cuotas» and the inscription tables:
 *   - the old per-person payments modal (with its proof lightbox and its two full-roster reloads) is gone
 *     from «Inscripciones», and so are the hover-only row actions;
 *   - every action the old row had is reachable from the person sheet, and what the sheet opens sits ABOVE it
 *     (named layers: sheet 1 < dialog 2 < lightbox 3 < confirm 4);
 *   - «Inscripciones» no longer opens with Pagos alone; «Pagos de cuotas» opens with Pagos › ver and sits
 *     next to «Contabilidad» (D-P16, D-P20);
 *   - the layout switches use data attributes in unlayered CSS, never `md:` / `lg:` display classes;
 *   - every plugin string of the new screens exists in es / en / pt;
 *   - only the topmost overlay hears Escape; Tab stays inside.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { LAYER, dialogFocusTarget, escapeDepth, handleEscape, overlayZ, pushEscape, trapTarget } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { FEE_ERROR_TEXT, REVIEW_REASONS, STATUS_META, BALANCE_FILTERS, checkDraft, summarizeBalances } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { scrollParentOf, scrollToListTop } from '../../../../../marketplace/plugins/conference-manager/client/lib/paging';
import { sourceLabelOf } from '../../../../../marketplace/plugins/conference-manager/client/lib/accounting';
import { revealNoteForm } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { PROOF_ERROR_TEXT } from '../../../../../marketplace/plugins/conference-manager/client/lib/proofImage';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const PAGE = read('admin/page.tsx');
const INSC = PAGE.slice(PAGE.indexOf('function InscriptionsPage('), PAGE.indexOf('function LodgingRoomTile('));
const NEW_FILES = ['admin/FeePaymentsPage.tsx', 'admin/TransferSheet.tsx', 'admin/RegisterPaymentSheet.tsx', 'admin/PersonSheet.tsx', 'admin/PersonPicker.tsx',
    'admin/RosterGroup.tsx', 'admin/RosterFilters.tsx', 'admin/RosterBits.tsx', 'admin/FeeBits.tsx', 'admin/ProofViewer.tsx'];

describe('«Inscripciones» lost the old payments modal and the hover-only actions', () => {
    it('no per-person payments modal, no proof lightbox, no full-roster reload after a payment', () => {
        for (const gone of ['openPayments', 'refreshAfterPaymentAction', 'handleAddPayment', 'handleValidatePayment', 'handleRejectPayment', 'handleVoidPayment', 'proofViewer', 'Pagos de {persona}', 'paymentActions(']) {
            expect(PAGE, gone).not.toContain(gone);
        }
        expect(PAGE).not.toMatch(/Pagos de \{personDisplayName/);
        expect(INSC).not.toContain('fetchAllInscriptions');
        // One roster download, never per keystroke (the search runs in the browser).
        expect(INSC).not.toMatch(/getInscriptions\(conferenceId, \{ search/);
    });
    it('no hover-only row actions anywhere in the roster', () => {
        for (const src of [INSC, read('admin/RosterGroup.tsx')]) {
            expect(src).not.toMatch(/opacity-0 group-hover\/row/);
            expect(src).not.toContain('[@media(hover:none)]');
        }
    });
    it('every action of the old row is in the person sheet, wired from «Inscripciones»', () => {
        const sheet = read('admin/PersonSheet.tsx');
        for (const act of ['edit', 'assign', 'delete', 'barcode', 'register', 'cancel', 'reactivate']) expect(sheet).toContain(`data-act="${act}"`);
        for (const h of ['onEdit={canManage ? openEdit', 'onAssign={canAssign ? openAssign', 'onDelete={canManage ? handleDelete', 'onBarcode=', 'onToggleCancel={canManage ? toggleCancel', 'onRegister={canPayManage ?', 'onOpenTransfer={canPayView ?']) {
            expect(INSC).toContain(h);
        }
        // The Pago pill opens the sheet at «Pago»; the Código opens the barcode.
        expect(read('admin/RosterGroup.tsx')).toMatch(/<PayPill[^>]*onClick=\{\(\) => onOpen\(p, \{ pay: true \}\)\}/);
        expect(read('admin/RosterGroup.tsx')).toMatch(/onClick=\{\(\) => onBarcode\(p\)\}/);
    });
    it('after an action only the touched rows are re-read', () => {
        expect(INSC).toContain('conferenceApi.getInscription(id)');
        expect(INSC).toMatch(/await patchRows\(\[editId\]\)/);
        expect(INSC).toMatch(/await patchRows\(\[id\]\)/);
    });
});

describe('layers: what the person sheet opens sits above it', () => {
    it('sheet 1 < dialog 2 < lightbox 3 < confirm 4, in the 6000 band', () => {
        expect(LAYER).toEqual({ sheet: 1, modal: 2, lightbox: 3, confirm: 4 });
        expect(overlayZ(LAYER.sheet)).toBeLessThan(overlayZ(LAYER.modal));
        expect(overlayZ(LAYER.lightbox)).toBeLessThan(overlayZ(LAYER.confirm));
    });
    it('the sheet is LAYER.sheet; the forms, the room, the payments are LAYER.modal; the confirm LAYER.confirm; the receipt LAYER.lightbox', () => {
        expect(read('admin/PersonSheet.tsx')).toContain('<Overlay layer={LAYER.sheet}');
        expect(INSC).toContain('<Overlay layer={LAYER.modal} onEscape={escapeForm}>');
        expect(INSC).toContain('<Overlay layer={LAYER.modal} onEscape={() => setAssignTarget(null)}>');
        expect(INSC).toContain('<Overlay layer={LAYER.confirm}');
        expect(INSC).not.toMatch(/<Overlay layer=\{1\}/);
        expect(read('admin/TransferSheet.tsx')).toMatch(/layer = LAYER\.modal/);
        expect(read('admin/RegisterPaymentSheet.tsx')).toMatch(/layer = LAYER\.modal/);
        expect(read('admin/ProofViewer.tsx')).toContain('<Overlay layer={LAYER.lightbox}');
        expect(read('admin/FeePaymentsPage.tsx')).toContain('<Overlay layer={LAYER.confirm}');
    });
    it('Escape reaches only the topmost overlay; releases in any order', () => {
        const seen: string[] = [];
        const a = pushEscape(() => seen.push('sheet'));
        const b = pushEscape(() => seen.push('confirm'));
        expect(escapeDepth()).toBe(2);
        expect(handleEscape()).toBe(true);
        expect(seen).toEqual(['confirm']);
        a(); b(); b();
        expect(escapeDepth()).toBe(0);
        expect(handleEscape()).toBe(false);
    });
    it('Tab stays inside: last → first, Shift+Tab on the first → last', () => {
        expect(trapTarget(['a', 'b', 'c'], 'c', false)).toBe('a');
        expect(trapTarget(['a', 'b', 'c'], 'a', true)).toBe('c');
        expect(trapTarget(['a', 'b', 'c'], 'b', false)).toBeNull();
        expect(trapTarget(['a', 'b'], null, false)).toBe('a');
        expect(trapTarget([], 'x', false)).toBeNull();
    });
    it('Overlay wires Escape, the Tab trap and the focus return', () => {
        const o = read('admin/Overlay.tsx');
        expect(o).toMatch(/pushEscape\(/);
        expect(o).toMatch(/trapTarget\(items, document\.activeElement, e\.shiftKey\)/);
        expect(o).toMatch(/opener && opener !== document\.body && opener\.isConnected/);
        expect(read('admin/PersonSheet.tsx')).toMatch(/returnFocus=\{`\[data-cm-more="\$\{p\.id\}"\], \[data-cm-roster-row="\$\{p\.id\}"\]`\}/);
    });
});

describe('tabs and permissions (D-P16, D-P20)', () => {
    it('«Inscripciones» opens with Inscripciones only; «Pagos de cuotas» with Pagos; the money tabs together', () => {
        expect(PAGE).toMatch(/case 'inscriptions': return p\.can\('inscriptions'\);/);
        expect(PAGE).toMatch(/case 'fees': return p\.can\('payments'\);/);
        expect(PAGE).toMatch(/const TAB_VIEWS: View\[\] = \['dashboard', 'inscriptions', 'fees', 'accounting',/);
        expect(PAGE).toMatch(/\['list', 'dashboard', 'inscriptions', 'fees',/);   // a saved «fees» view is restored
        expect(PAGE).toContain("{shown === 'fees' && <FeePaymentsPage");
    });
    it('the dashboard: «sin pagar» leaves out money only awaiting validation; «Pagos por validar» opens the queue', () => {
        const dash = PAGE.slice(PAGE.indexOf('function ConferenceDashboard('), PAGE.indexOf('function BarcodeModal('));
        expect(dash).toContain('const unpaid = inscriptions ? inscriptions.filter(i => personBalance(i).toCover > 0).length : na;');
        expect(dash).toMatch(/viewAllowed\('fees', perms\) \? feePaymentsApi\.getView\(conferenceId\)/);
        expect(dash).toMatch(/onClick=\{onOpenFees \? \(\) => onOpenFees\(\{ section: 'queue' \}\) : undefined\}/);
    });
    it('the Excel export filter and «Reportes» use the pill\'s words: Pagado / Abono / Sin pagar (never «Parcial» / «Pendiente»)', () => {
        const start = PAGE.indexOf('function ExcelExportModal(');
        const excel = PAGE.slice(start, PAGE.indexOf('\nfunction ', start + 1) > 0 ? PAGE.indexOf('\nfunction ', start + 1) : undefined);
        expect(excel.length).toBeGreaterThan(1000);
        expect(excel).toContain(`<option value="partial">{tx('fees.pill.partial', 'Abono')}</option>`);
        expect(excel).toContain(`<option value="unpaid">{tx('fees.pill.unpaid', 'Sin pagar')}</option>`);
        const reports = PAGE.slice(PAGE.indexOf('function ReportsPage('), PAGE.indexOf('function FieldsPage('));
        expect(reports).toMatch(/data-report-count="partial">.*\{tx\('fees\.pill\.partial', 'Abono'\)\}/);
        expect(reports).toMatch(/data-report-count="unpaid">.*\{tx\('fees\.pill\.unpaid', 'Sin pagar'\)\}/);
        for (const src of [excel, reports]) {
            expect(src).not.toContain("t('partial')");
            expect(src).not.toContain("'Pendiente'}</option>");
        }
    });
    it('«Reportes» has a «Por validar» column per location; «Contabilidad» opens the payment and expands a shared one', () => {
        expect(PAGE).toMatch(/data-report-pending="">\{money\(Number\(row\.pending\) \|\| 0\)\}/);
        const acc = read('admin/AccountingPage.tsx');
        expect(acc).toMatch(/e\.readonly && e\.transfer_id != null && canSeePayment \?/);
        expect(acc).toMatch(/\{shared && open && \(\s*<ul className="[^"]*" data-ledger-parts=\{e\.id\}>/);
        expect(acc).toContain('filterLedger(data.entries || [], filter as any, names, locationOf)');
        expect(acc).toContain('buildLedgerWorkbook(rows as any, names, locationNameOf)');
    });
    it('the fee screens gate their controls on payments view / manage', () => {
        const fees = read('admin/FeePaymentsPage.tsx');
        expect(fees).toContain("const canManage = perms.can('payments', 'manage');");
        expect(fees).toMatch(/\{canManage && <button type=\"button\" onClick=\{\(\) => setRegister\(\{ ids: \[\] \}\)\}/);
        expect(read('admin/AccountingPage.tsx')).toContain("const canSeePayment = perms.can('payments');");
    });
    it('the review queue\'s location chips use the one location rule of «Pagos» and the server (transferInLocation)', () => {
        const fees = read('admin/FeePaymentsPage.tsx');
        expect(fees).toContain('queueAll.filter((t) => transferInLocation(t, qLoc) && (!qMethod || t.method === qMethod))');
    });
});

describe('phones first', () => {
    it('the layout switches are data attributes, never md:/lg: display classes', () => {
        for (const f of ['admin/RosterGroup.tsx', 'admin/RosterFilters.tsx', 'admin/FeePaymentsPage.tsx', 'admin/PersonSheet.tsx', 'admin/TransferSheet.tsx', 'admin/RegisterPaymentSheet.tsx']) {
            expect(read(f), f).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|table|grid|inline-flex)(?![-\w])/);
            expect(read(f), f).not.toMatch(/(^|\s)hidden\s+(sm|md|lg):/);
        }
    });
    it('no field autofocuses on a phone; inputs of the sheets are 16px', () => {
        for (const f of NEW_FILES) {
            for (const m of read(f).matchAll(/\bautoFocus\b(=\{[^}]*\})?/g)) expect(m[1], f).toBe('={canAutoFocus()}');
        }
        expect(read('admin/RegisterPaymentSheet.tsx')).toMatch(/const inputCls = '[^']*text-base/);
        expect(read('admin/RosterFilters.tsx')).toMatch(/data-roster-search=""/);
        expect(read('admin/RosterFilters.tsx')).toMatch(/text-base font-medium text-gray-900 placeholder:text-gray-400" data-roster-search=""/);
    });
    it('«Registrar pago»: switching to «Manual» seeds what each person owes (manualSeed, through manualOnSwitch), like the portal', () => {
        const sheet = read('admin/RegisterPaymentSheet.tsx');
        const setMode = sheet.slice(sheet.indexOf('const setMode = '), sheet.indexOf('const submit = '));
        expect(setMode).toContain("manual: manualOnSwitch(d, parseMoneyInput(d.amount) ?? 0, capOf)");
        expect(read('lib/feePayments.ts')).toMatch(/export function manualOnSwitch\([^)]*\)[^{]*\{\s*if \(!d\.manualTyped\) return manualSeed\(d\.people, totalC, capOf\);/);
    });
});

describe('translations: every string of the new screens in es / en / pt', () => {
    it('tx() keys of the new files, the status / reason / error / chip tables', () => {
        const keys = new Set<string>();
        for (const f of [...NEW_FILES, 'admin/page.tsx', 'admin/AccountingPage.tsx']) {
            for (const m of read(f).matchAll(/\btx\(\s*'([^']+)'/g)) keys.add(m[1]);
        }
        Object.values(STATUS_META).forEach((m) => keys.add(m.key));
        REVIEW_REASONS.forEach((r) => keys.add(r.key));
        BALANCE_FILTERS.forEach((b) => keys.add(b.label));
        Object.values(PROOF_ERROR_TEXT).forEach((p) => keys.add(p.key));
        Object.keys(FEE_ERROR_TEXT).forEach((c) => keys.add(`fees.error.${c}`));
        for (const m of read('admin/RegisterPaymentSheet.tsx').matchAll(/\['(fees\.[^']+)'/g)) keys.add(m[1]);
        for (const m of read('admin/TransferSheet.tsx').matchAll(/\['(fees\.event\.[^']+)'/g)) keys.add(m[1]);
        for (const m of read('admin/PersonSheet.tsx').matchAll(/\['(roster\.status\.[^']+)'/g)) keys.add(m[1]);
        expect(keys.size).toBeGreaterThan(250);
        for (const lang of ['es', 'en', 'pt'] as const) {
            const missing = [...keys].filter((k) => !translations[lang][k]);
            expect(missing, lang).toEqual([]);
        }
        // Placeholders survive translation.
        for (const k of keys) {
            const ph = (s: string) => (s.match(/\{[a-z]+\}/g) || []).sort().join();
            expect(ph(translations.en[k]), `en ${k}`).toBe(ph(translations.es[k]));
            expect(ph(translations.pt[k]), `pt ${k}`).toBe(ph(translations.es[k]));
        }
    });
    it('the Spanish translation of every fee / roster string is the screen\'s own Spanish fallback (one wording)', () => {
        let checked = 0;
        for (const f of [...NEW_FILES, 'admin/page.tsx', 'admin/AccountingPage.tsx']) {
            for (const m of read(f).matchAll(/\btx\(\s*'((?:fees|roster)\.[^']+)',\s*'((?:[^'\\]|\\.)*)'/g)) {
                checked++;
                expect(translations.es[m[1]], `${f} ${m[1]}`).toBe(m[2].replace(/\\'/g, "'"));
            }
        }
        expect(checked).toBeGreaterThan(250);
    });
    it('the owner\'s names: «Pagos de cuotas» / «Fee payments» / «Pagamentos de cotas»', () => {
        expect([translations.es['fees.title'], translations.en['fees.title'], translations.pt['fees.title']]).toEqual(['Pagos de cuotas', 'Fee payments', 'Pagamentos de cotas']);
    });
});

// ── 2.18.0 live-review fixes ──────────────────────────────────────────────────────────────────────────

describe('Escape: an overlay without its own Escape never lets the key close the sheet under it', () => {
    it('a placeholder slot on top swallows the key for the stack and leaves it free (not handled)', () => {
        const seen: string[] = [];
        const sheet = pushEscape(() => { seen.push('sheet'); });
        const barcode = pushEscape(() => false);           // an overlay with no onEscape (BarcodeModal, a confirm)
        expect(handleEscape()).toBe(false);               // not handled: no preventDefault, its own listener may act
        expect(seen).toEqual([]);                         // and the person sheet underneath did NOT close
        barcode();
        expect(handleEscape()).toBe(true);
        expect(seen).toEqual(['sheet']);
        sheet();
        expect(escapeDepth()).toBe(0);
    });
    it('every Overlay takes a slot; the sending sheet keeps its slot (a no-op while busy); the barcode and the ledger confirm close on Escape', () => {
        const o = read('admin/Overlay.tsx');
        expect(o).toContain('useEffect(() => pushEscape(() => (escapeRef.current ? (escapeRef.current(), true) : false)), []);');
        expect(o).not.toMatch(/listensEscape \? pushEscape/);
        const reg = read('admin/RegisterPaymentSheet.tsx');
        // A no-op while sending; with changes it asks before discarding (escapeClose).
        expect(reg).toContain('<Overlay layer={layer} onEscape={escapeClose}>');
        expect(reg).toMatch(/const escapeClose = async \(\) => \{\s*if \(busy\) return;/);
        expect(reg).not.toContain('onEscape={busy ? undefined : onClose}');
        expect(PAGE).toContain('<Overlay layer={2} onBackdrop={onClose} onEscape={onClose}>');
        expect(read('admin/AccountingPage.tsx')).toMatch(/<Overlay layer=\{4\}[^>]*onEscape=\{\(\) => \{ const c = confirmState\.onCancel;/);
    });
});

describe('an opening sheet is announced: the focus lands on its dialog, not on the bare backdrop', () => {
    it('dialogFocusTarget picks the role=dialog / alertdialog inside, else the overlay itself', () => {
        const dialog = { name: 'dialog' };
        const outer = { name: 'outer', querySelector: (sel: string) => (sel.includes('role="dialog"') && sel.includes('role="alertdialog"') ? dialog : null) };
        expect(dialogFocusTarget(outer as any)).toBe(dialog);
        const bare = { name: 'outer', querySelector: () => null };
        expect(dialogFocusTarget(bare as any)).toBe(bare);
        const o = read('admin/Overlay.tsx');
        expect(o).toMatch(/const target: any = dialogFocusTarget\(outer\);[\s\S]*target\.setAttribute\('tabindex', '-1'\);[\s\S]*target\.focus\(\{ preventScroll: true \}\);/);
        expect(o).not.toMatch(/try \{ outer\.focus\(\{ preventScroll: true \}\); \}/);
    });
});

describe('«Devolver…» / «Rechazar…»: the reason form comes into view', () => {
    it('revealNoteForm scrolls the form into view (nearest; instant under reduced motion), wired on noteFor', () => {
        const calls: any[] = [];
        revealNoteForm({ scrollIntoView: (o: any) => calls.push(o) }, false);
        revealNoteForm({ scrollIntoView: (o: any) => calls.push(o) }, true);
        revealNoteForm(null, false);
        expect(calls).toEqual([{ block: 'nearest', behavior: 'smooth' }, { block: 'nearest', behavior: 'auto' }]);
        const ts = read('admin/TransferSheet.tsx');
        expect(ts).toMatch(/useEffect\(\(\) => \{\s*if \(!noteFor\) return;[\s\S]*revealNoteForm\(noteRef\.current, reduced\);[\s\S]*\}, \[noteFor\]\);/);
        expect(ts).toContain('<section ref={noteRef}');
    });
});

/**
 * A fake page for lib/paging.ts: elements with a parent, a computed overflow, a rect and a scroll position.
 * `scrollTo` records which box moved. The conference shell is `overflow: hidden` (taller than its room, as
 * in the lab): it must never move; the panel (`overflow: auto`) is the scroller.
 */
function fakePage({ cardTop = -300, panelScroll = 1000, margin = '0px', reduce = false, scroller = true } = {}) {
    const moved: [string, any][] = [];
    const box = (name: string, o: any) => ({ name, clientTop: 0, ...o, scrollTo(arg: any) { moved.push([name, arg]); this.scrollTop = arg.top; } });
    const body = box('body', { parentElement: null, overflowY: 'visible' });
    const shell = box('shell', { parentElement: body, overflowY: 'hidden', scrollTop: 0, scrollHeight: 2000, clientHeight: 700, getBoundingClientRect: () => ({ top: 100 }) });
    const panel = box('panel', { parentElement: shell, overflowY: scroller ? 'auto' : 'visible', scrollTop: panelScroll, scrollHeight: 4000, clientHeight: 570, getBoundingClientRect: () => ({ top: 190 }) });
    const card = box('card', { parentElement: panel, overflowY: 'visible', scrollMarginTop: margin, getBoundingClientRect: () => ({ top: cardTop }) });
    const win = {
        document: { body, documentElement: { name: 'html' } }, scrollY: 50,
        getComputedStyle: (el: any) => ({ overflowY: el.overflowY, scrollMarginTop: el.scrollMarginTop || '0px' }),
        matchMedia: () => ({ matches: reduce }),
        scrollTo: (arg: any) => moved.push(['window', arg]),
    };
    return { moved, win, card, panel, shell };
}

describe('a page change brings its list\'s top into view (tables-design 1.3)', () => {
    it('scrollToListTop: the list\'s top at the top of ITS scroller — only that one moves; smooth, or instant under reduced motion', () => {
        const a = fakePage();
        expect(scrollParentOf(a.card, a.win as any)).toBe(a.panel);
        expect(scrollToListTop(a.card, a.win as any)).toBe(true);
        // 1000 + (-300) - 190: the card's top lands at the panel's top; the overflow-hidden shell never moves
        // (scrollIntoView moved it: the conference title and tabs slid away under the admin header).
        expect(a.moved).toEqual([['panel', { top: 510, behavior: 'smooth' }]]);
        const b = fakePage({ reduce: true, margin: '96px' });
        scrollToListTop(b.card, b.win as any);
        expect(b.moved).toEqual([['panel', { top: 414, behavior: 'auto' }]]);          // its scroll margin kept above it
        const c = fakePage({ scroller: false, cardTop: 400 });
        scrollToListTop(c.card, c.win as any, { instant: true });
        expect(c.moved).toEqual([['window', { top: 450, behavior: 'auto' }]]);          // no scrolling box: the page
        expect(scrollToListTop(null, null)).toBe(false);
        expect(read('lib/paging.ts')).not.toMatch(/\.scrollIntoView\(/);
        expect(read('admin/FeePaymentsPage.tsx')).not.toMatch(/\.scrollIntoView\(/);
    });
    it('«Pagos» and «Saldos» of the admin page jump through it', () => {
        const fees = read('admin/FeePaymentsPage.tsx');
        expect(fees).toContain('const goTPage = (p: number) => { setTPage(p); scrollToListTop(tTopRef.current); };');
        expect(fees).toContain('const goBPage = (p: number) => { setBPage(p); scrollToListTop(bTopRef.current); };');
        expect(fees).toContain('total={tFiltered.length} onPage={goTPage} />');
        expect(fees).toContain('total={balanceRows.length} onPage={goBPage} />');
        expect(fees).not.toMatch(/onPage=\{set[TB]Page\}/);
    });
});

describe('a photo being prepared blocks «Registrar» (admin)', () => {
    it('checkDraft: proof_working while the receipt is shrunk; ProofPicker reports it through onBusy', () => {
        const draft = { people: [1], amount: '10', method: 'Efectivo', paidOn: '2026-10-01', reference: '', note: '', mode: 'equal' as const, manual: {}, proof: null, leavePending: false, clientKey: 'k1234567' };
        const ctx = { capOf: () => 100000, methods: ['Efectivo'], today: new Date('2026-10-02T12:00:00') };
        expect(checkDraft(draft, ctx).ok).toBe(true);
        const busy = checkDraft({ ...draft, proofWorking: true }, ctx);
        expect(busy.ok).toBe(false);
        expect(busy.issues).toContain('proof_working');
        const viewer = read('admin/ProofViewer.tsx');
        expect(viewer).toContain('const setBusy = (b: boolean) => { setBusyState(b); if (onBusy) onBusy(b); };');
        expect(read('admin/RegisterPaymentSheet.tsx')).toContain('onBusy={(b) => set({ proofWorking: b })}');
    });
});

describe('the «Resumen» in cents: Validado + Por validar + Por cobrar = Cuotas, credit apart', () => {
    it('summarizeBalances caps each person\'s money at their fee (a cancelled person\'s is «A favor» only)', () => {
        const b = (due: number, validated: number, pending: number, cancelled = false) => ({ due: cancelled ? 0 : due, validated, pending, returned: 0, toCover: Math.max(0, (cancelled ? 0 : due) - validated - pending), credit: Math.max(0, validated - (cancelled ? 0 : due)), cancelled, payable: false, state: 'paid' as const });
        const s = summarizeBalances([b(25000, 25000, 0), b(10000, 10000, 0, true), b(10000, 0, 6000, true), b(25000, 3000, 30000)]);
        expect(s).toEqual({ people: 2, cancelled: 2, due: 50000, validated: 28000, pending: 22000, returned: 0, toCover: 0, credit: 10000 });
        expect(s.validated + s.pending + s.toCover).toBe(s.due);
    });
});

describe('«Contabilidad»: a fee payment\'s origin is «Pago de cuotas», its parts stacked in their cell', () => {
    it('sourceLabelOf; the expanded parts sit under the description, not in a full-width row', () => {
        expect(sourceLabelOf({ source: 'inscription', transfer_id: 4 })).toBe('Pago de cuotas');
        expect(sourceLabelOf({ source: 'inscription', transfer_id: null })).toBe('Pago de inscripción');
        expect(sourceLabelOf({ source: 'transport' })).toBe('Pago de transporte');
        const acc = read('admin/AccountingPage.tsx');
        expect(acc).toMatch(/\{shared && open && \(\s*<ul className="[^"]*" data-ledger-parts=\{e\.id\}>/);
        expect(acc).not.toContain('colSpan={5}');
        expect(acc).toMatch(/<span className="shrink-0 font-black text-gray-900 tabular-nums">\{money\(a\.amount\)\}<\/span>/);
        // The screen's origin line says what the Excel «Origen» says: «Pago de cuotas» (one payment), never the
        // section's name «Pagos de cuotas».
        expect(acc).toContain("const lineSource = (e: any) => (e.source === 'inscription' && e.transfer_id != null ? tx('accounting.source.fee', 'Pago de cuotas') : sourceLabel(e.source));");
        expect(acc).not.toContain("tx('fees.title', 'Pagos de cuotas') : sourceLabel");
        expect(translations.es['accounting.source.fee']).toBe(sourceLabelOf({ source: 'inscription', transfer_id: 4 }));
        expect(translations.en['accounting.source.fee']).toBe('Fee payment');
        expect(translations.pt['accounting.source.fee']).toBe('Pagamento de cotas');
        expect(acc).toContain('{factsOf([lineSource(e), shared ?');
    });
});

describe('phones: no small targets left in the payment screens', () => {
    it('no 32 / 36 px controls in the payment screens and sheets (phones) and «Contabilidad»', () => {
        // (RosterGroup's 36 px «Código» sits in the desktop-only table.)
        for (const f of [...NEW_FILES.filter((x) => x !== 'admin/RosterGroup.tsx'), 'admin/AccountingPage.tsx']) {
            expect(read(f), f).not.toMatch(/min-h-\[(32|36)px\]/);
        }
        expect(read('admin/AccountingPage.tsx')).toMatch(/className="text-left inline-flex items-center gap-2 min-h-\[44px\]" data-ledger-expand=""/);
    });
});
