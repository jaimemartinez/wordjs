/**
 * conference-manager 2.18.0 — the fixes of the third live lab and review round (admin plugin), server-
 * rendered or pure (node, no DOM), each pinned so that undoing it fails here:
 *   - «Inscripciones»: a page change scrolls back to the location CARD once the new page rendered — never to
 *     its sticky header, which is already stuck at the top (the screen used to land in the next card);
 *   - «Contabilidad»: the origin line says «Pago de cuotas» like the Excel; the manual entries' actions are
 *     always visible and 44 px; the conference header's back arrow is a named 44 px button;
 *   - a pre-2.18 payment (or one of a deleted location) is never offered «Devolver…» — nobody could correct it;
 *   - «Registrar pago»: «Queda pagado» only when nothing else of the person awaits validation; each chosen
 *     person reads «debe $X» or «$Y por validar · falta $X» (never the same figure twice); the footer says how
 *     much is missing or left over; no «2.18» in what the admin reads;
 *   - «Saldos»: the filters wrap (none hidden off-screen on a phone) and carry their counts;
 *   - the cancel-inscription confirm: «No, mantenerla» | «Sí, cancelar inscripción»; every in-app confirm is a
 *     NAMED alert dialog that describes its question; the sheets' pinned footer clears the home indicator;
 *   - a receipt photo picked while another is still shrinking supersedes it (the latest pick wins);
 *   - Dashboard / Reportes: one per-person model («Con saldo», cancelled people apart).
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
import { pagedScroll } from '../../../../../marketplace/plugins/conference-manager/client/lib/paging';
import {
    balanceFilterCounts, canBeReturned, chosenPersonLine, partAfterKind, personBalance, sumMismatchText, transferActions,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { pickSequence } from '../../../../../marketplace/plugins/conference-manager/client/lib/proofImage';
import { OVERLAY_CSS } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { TransferPanel } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { RegisterPaymentSheet, buildPersonOptions } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { reportView } from '../../../../../marketplace/plugins/conference-manager/client/admin/page';
import FeePaymentsPage from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));
const PAGE = read('admin/page.tsx');
const INSC = PAGE.slice(PAGE.indexOf('function InscriptionsPage('), PAGE.indexOf('function LodgingRoomTile('));

// ── «Inscripciones»: the pager brings its location card back ──────────────────────────────────────────
describe('«Inscripciones»: «Siguiente» at the bottom of a location card brings THAT card back into view', () => {
    /**
     * The panel scrolls (overflow auto) inside the conference shell (overflow hidden). Card A's pager is at
     * the bottom of the screen: the card's own top is far above (its sticky header is stuck at the top and
     * says nothing of where the card begins). The panel — and only the panel — scrolls to the card's top.
     */
    const world = () => {
        const moved: [string, number][] = [];
        const body = { parentElement: null, overflowY: 'visible' };
        const shell = { name: 'shell', parentElement: body, overflowY: 'hidden', scrollTop: 0, scrollHeight: 2000, clientHeight: 700, clientTop: 0, getBoundingClientRect: () => ({ top: 100 }), scrollTo(o: any) { moved.push(['shell', o.top]); } };
        const panel = { name: 'panel', parentElement: shell, overflowY: 'auto', scrollTop: 1619, scrollHeight: 4000, clientHeight: 571, clientTop: 0, getBoundingClientRect: () => ({ top: 190 }), scrollTo(o: any) { moved.push(['panel', o.top]); this.scrollTop = o.top; } };
        const card = (top: number) => ({ parentElement: panel, overflowY: 'visible', getBoundingClientRect: () => ({ top }) });
        const win = { document: { body }, getComputedStyle: (el: any) => ({ overflowY: el.overflowY, scrollMarginTop: '0px' }), matchMedia: () => ({ matches: true }) };
        return { moved, panel, win, cards: new Map([['1', card(-1300)], ['2', card(700)]]) };
    };
    it('pagedScroll: after the page renders, the panel brings the requested CARD to its top — once, and nothing else moves', () => {
        const w = world();
        const s = pagedScroll();
        expect(s.flush((k) => w.cards.get(k) as any, w.win as any)).toBe(false);          // nothing requested yet
        s.request('1');
        expect(s.flush((k) => w.cards.get(k) as any, w.win as any)).toBe(true);
        expect(w.panel.scrollTop).toBe(1619 - 1300 - 190);
        expect(w.moved).toEqual([['panel', 129]]);
        expect(s.flush((k) => w.cards.get(k) as any, w.win as any)).toBe(false);          // once per page change
        expect(w.moved).toHaveLength(1);
    });
    it('the page asks for it on «Siguiente» and flushes it in an effect keyed on the pages; the card holds the ref', () => {
        expect(INSC).toContain('const pageScroll = useRef(pagedScroll()).current;');
        expect(INSC).toMatch(/const goPage = \(g, p: number\) => \{\s*pageScroll\.request\(g\.key\);\s*setNav\(/);
        expect(INSC).toContain('useEffect(() => { pageScroll.flush((key) => cardRefs.current.get(key)); }, [nav.pages]);');
        expect(INSC).toContain('cardRef={(el) => { cardRefs.current.set(g.key, el); }}');
        expect(INSC).not.toMatch(/headRefs|headRef=/);
        expect(INSC.slice(INSC.indexOf('const goPage'), INSC.indexOf('const changeSize'))).not.toContain('scrollIntoView');
        const group = read('admin/RosterGroup.tsx');
        expect(group).toMatch(/<section ref=\{cardRef\}[^>]*data-cm-roster-card=""/);
        // The head is only MEASURED (its height places the sticky column headers), never the scroll target.
        expect(group).toMatch(/<div ref=\{measureRef\} className="[^"]*" data-cm-roster-head="">/);
        expect(group).not.toContain('headRef');
    });
});

// ── «Contabilidad» and the header ─────────────────────────────────────────────────────────────────────
describe('«Contabilidad»: nothing hover-only, 44 px; the conference header\'s back arrow is a real button', () => {
    it('the manual entries\' edit / delete are always visible, 44 px and named', () => {
        const acc = read('admin/AccountingPage.tsx');
        expect(acc).not.toMatch(/opacity-0 group-hover\/row:opacity-100/);
        expect(acc).not.toMatch(/className="w-8 h-8/);
        expect(acc).toMatch(/<div className="flex justify-end gap-1\.5" data-ledger-actions="">\s*<button type="button" onClick=\{\(\) => openEdit\(e\)\}[^>]*aria-label=\{[^}]+\}[^>]*className="w-11 h-11/);
        expect(acc).toMatch(/onClick=\{\(\) => remove\(e\)\}[^>]*aria-label=\{[^}]+\}[^>]*className="w-11 h-11/);
    });
    it('«← Volver a los congresos»: 44 × 44, with a name (it was a bare 14 × 24 px icon)', () => {
        expect(PAGE).toMatch(/onClick=\{\(\) => setView\('list'\)\}\s*aria-label=\{tx\('staff\.back\.list', 'Volver a los congresos'\)\}[\s\S]{0,200}className="w-11 h-11[^"]*"\s*data-cm-back=""/);
    });
});

// ── F1: «Devolver» only to someone who can correct it ───────────────────────────────────────────────
describe('a payment nobody can correct is never offered «Devolver…»', () => {
    it('canBeReturned: the administration\'s own, or a portal payment of an existing location', () => {
        expect(canBeReturned({ recorded_via: 'admin', location_id: null })).toBe(true);
        expect(canBeReturned({ recorded_via: 'portal', location_id: 3 })).toBe(true);
        expect(canBeReturned({ recorded_via: 'portal', location_id: null })).toBe(false);
        expect(canBeReturned({ recorded_via: 'legacy', location_id: 3 })).toBe(false);
        expect(transferActions('pending', true, { recorded_via: 'legacy', location_id: 3 }).return).toBe(false);
        expect(transferActions('pending', true, { recorded_via: 'legacy', location_id: 3 }).validate).toBe(true);
        expect(transferActions('pending', true, { recorded_via: 'portal', location_id: 3 }).return).toBe(true);
    });
    it('the payment sheet: a pre-2.18 pending payment offers Validar / Rechazar / Editar / Eliminar, no «Devolver…»; named in words, not a version', () => {
        const t = {
            id: 40, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 30, allocated: 30, method: 'Efectivo', reference: null,
            paid_on: '2026-08-02', note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'legacy', recorded_by: null,
            created_at: '2026-08-02 09:00:00', submitted_at: '2026-08-02 09:00:00', updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
            has_proof: false, legacy: true, people: 1, flags: { cancelled_people: [], duplicate_reference: false },
            allocations: [{ id: 1, inscription_id: 1, amount: 30, location_id: 1, cancelled: false, name: 'Ana Pérez', due: 100, total_due: 100, validated_other: 0, after: { paid: 30, owed: 70, credit: 0 } }],
        };
        const html = flat(renderToStaticMarkup(<I18nProvider><ToastProvider><TransferPanel id={40} initial={t} canManage onEdit={() => {}} onDuplicate={() => {}} /></ToastProvider></I18nProvider>));
        const acts = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]).sort();
        expect(acts).toEqual(['edit', 'reject', 'remove', 'validate']);
        expect(html).toContain('data-flag="legacy"');
        expect(html).toContain('Registrado antes de «Pagos de cuotas»');
        expect(html).toContain('Registrado por el sistema anterior el ');
        expect(html).not.toMatch(/2\.18/);
    });
    it('no fee text the admin reads mentions a version number', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            for (const [k, v] of Object.entries(translations[lang])) if (k.startsWith('fees.')) expect(v, `${lang} ${k}`).not.toMatch(/2\.18/);
        }
        expect(read('admin/FeePaymentsPage.tsx')).not.toMatch(/'[^']*2\.18[^']*'\)/);
        expect(read('admin/TransferSheet.tsx')).not.toMatch(/'[^']*2\.18[^']*'\)/);
    });
});

// ── F5 + UX-A5: what «Registrar pago» says about each person ─────────────────────────────────────────
describe('«Registrar pago»: the words under each person and in the footer', () => {
    it('partAfterKind: «Queda pagado» only when nothing else of theirs awaits validation', () => {
        expect(partAfterKind(10000, 10000, { bornValidated: true, otherPendingC: 0 })).toBe('paid');
        expect(partAfterKind(6000, 6000, { bornValidated: true, otherPendingC: 4000 })).toBe('paid_after_pending');
        // Other money awaiting validation says so whether this payment is born validated or waits too (2.18.0 r4).
        expect(partAfterKind(6000, 6000, { bornValidated: false, otherPendingC: 4000 })).toBe('paid_after_pending');
        expect(partAfterKind(6000, 6000, { bornValidated: false, otherPendingC: 0 })).toBe('paid_when');
        expect(partAfterKind(6000, 5000, { bornValidated: true, otherPendingC: 0 })).toBe('left');
        expect(partAfterKind(6000, 7000, { bornValidated: true, otherPendingC: 0 })).toBe('none');
        expect(partAfterKind(null, 7000, { bornValidated: true, otherPendingC: 0 })).toBe('none');
    });
    it('chosenPersonLine / sumMismatchText', () => {
        expect(chosenPersonLine(25000, 0)).toEqual({ key: 'fees.register.owes.left', fallback: 'debe {left}', vars: { left: 25000 } });
        expect(chosenPersonLine(20000, 10000).fallback).toBe('{pending} por validar · falta {left}');
        expect(sumMismatchText(5000)).toEqual({ key: 'fees.issue.sum.missing', fallback: 'Faltan {amount} por repartir.', cents: 5000 });
        expect(sumMismatchText(-5000)).toEqual({ key: 'fees.issue.sum.extra', fallback: 'Sobran {amount} en el reparto.', cents: 5000 });
    });
    const ROWS = [
        { id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 500, amount_paid: 100, pending_amount: 0, payment_status: 'partial' },
        { id: 2, first_name: 'Luis', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 300, amount_paid: 0, pending_amount: 100, payment_status: 'unpaid' },
    ];
    const LOCS = [{ id: 1, name: 'Norte' }];
    const OPTIONS = buildPersonOptions(ROWS, (p: any) => `${p.first_name} ${p.last_name}`, LOCS);
    const sheet = (props: any) => flat(renderToStaticMarkup(<I18nProvider><ToastProvider>
        <RegisterPaymentSheet conferenceId={1} options={OPTIONS} locations={LOCS} methods={['Efectivo']} onClose={() => {}} {...props} />
    </ToastProvider></I18nProvider>));
    it('born validated: Ana is paid with this payment; Luis only once his other $100 is validated', () => {
        expect(sheet({ ids: [1] })).toMatch(/data-split-row="1"[\s\S]*?data-part-after="">Queda pagado</);
        expect(sheet({ ids: [2] })).toMatch(/data-split-row="2"[\s\S]*?data-part-after="">Queda pagado al validarse lo pendiente</);    });
    it('each chosen person: «debe $X», or «$Y por validar · falta $X» — never «debe $X · falta $X»', () => {
        const html = sheet({ ids: [1, 2] });
        expect(html).toMatch(/data-chosen="1"[\s\S]*?>debe \$400,00</);
        expect(html).toMatch(/data-chosen="2"[\s\S]*?>\$100,00 por validar · falta \$200,00</);
        expect(html).not.toMatch(/debe \$[\d.,]+ · falta/);
    });
    it('a split that does not add up: the footer says by how much', () => {
        const tr = {
            id: 9, status: 'pending', alloc_gen: 1, amount: 300, method: 'Efectivo', paid_on: '2026-10-01', reference: null, note: null, has_proof: false, recorded_via: 'admin', location_id: 1,
            allocations: [{ id: 1, inscription_id: 1, amount: 250, due: 500, validated_other: 100, pending_other: 0 }],
        };
        const html = sheet({ mode: 'edit', transfer: tr });
        expect(html).toMatch(/data-register-issue="sum_mismatch"[^>]*>[\s\S]*?Faltan \$50,00 por repartir\.</);
    });
});

// ── UX-A1: the «Saldos» filters on a phone ─────────────────────────────────────────────────────────
describe('«Saldos»: every filter in sight, each with its count', () => {
    it('balanceFilterCounts', () => {
        const list = [personBalance({ total_due: 100 }), personBalance({ total_due: 100, amount_paid: 100, payment_status: 'paid' }),
            personBalance({ total_due: 100, pending_amount: 40 }), personBalance({ status: 'cancelled', total_due: 100, amount_paid: 50 })];
        expect(balanceFilterCounts(list)).toEqual({ owing: 2, pending: 1, returned: 0, paid: 1, credit: 1, all: 4 });
    });
    it('the chips wrap (no sideways strip) and say «Con saldo (n)»', () => {
        const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 500, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0, cancelled: false, payable: true, ...extra });
        const view = {
            conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
            summary: { people: 2, cancelled: 0, due: 1000, validated: 500, pending: 0, returned: 0, to_cover: 500, credit: 0 }, by_location: [],
            counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 }, transfers: [],
            people: [W(1, {}), W(2, { validated: 500, to_cover: 0, payable: false })],
        };
        const roster = [{ id: 1, first_name: 'Ana', last_name: 'P', location_id: 1 }, { id: 2, first_name: 'Luis', last_name: 'P', location_id: 1 }];
        const fields = [{ id: 1, name: 'first_name', label: 'Nombre', role: 'first_name', type: 'text', sort_order: 1 }, { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name', type: 'text', sort_order: 2 }];
        const html = render(<FeePaymentsPage conferenceId={1} initial={{ view, roster, fields, locations: [{ id: 1, name: 'Norte' }], section: 'balances' }} onOpenAccounting={() => {}} />);
        expect(html).toMatch(/<div class="flex flex-wrap gap-2" data-balance-filters="">/);
        expect(html).not.toMatch(/overflow-x-auto[^"]*" data-balance-filters/);
        expect(html).toMatch(/data-balance-filter="owing">Con saldo \(1\)</);
        expect(html).toMatch(/data-balance-filter="paid">Pagados \(1\)</);
        expect(html).toMatch(/data-balance-filter="all">Todos \(2\)</);
    });
});

// ── UX-A2 / UX-A4 / UX-A3: the confirms and the sheets on a phone ────────────────────────────────────
describe('confirms and sheets', () => {
    it('cancelling an inscription: «No, mantenerla» | «Sí, cancelar inscripción» — never «Cancelar» | «Cancelar inscripción»', () => {
        expect(INSC).toMatch(/tx\('roster\.cancel\.yes', 'Sí, cancelar inscripción'\), true, tx\('roster\.cancel\.keep', 'No, mantenerla'\)\)\) return;/);
        expect(INSC).toMatch(/data-confirm-cancel=""\s*>\s*\{confirmState\.cancelLabel \|\| t\('cancel'\) \|\| 'Cancelar'\}/);
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of ['roster.cancel.yes', 'roster.cancel.keep', 'confirm.title']) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
    });
    it('every in-app confirm is an alert dialog with a name and the question as its description', () => {
        for (const f of ['admin/page.tsx', 'admin/FeePaymentsPage.tsx', 'admin/AccountingPage.tsx']) {
            const src = read(f);
            const dialogs = [...src.matchAll(/role="alertdialog" aria-modal="true"([^>]*)>/g)];
            expect(dialogs.length, f).toBeGreaterThan(0);
            for (const d of dialogs) {
                expect(d[1], f).toContain("aria-label={tx('confirm.title', 'Confirmar')}");
                const id = /aria-describedby="([^"]+)"/.exec(d[1]);
                expect(id, f).not.toBeNull();
                expect(src, f).toContain(`<p id="${id![1]}"`);
            }
        }
        // «Localidades»' confirm had no dialog role at all.
        const loc = PAGE.slice(PAGE.indexOf('function LocationsPage('));
        expect(loc).toContain('aria-describedby="cm-loc-confirm-msg"');
    });
    it('the pinned footer of a sheet keeps its buttons above the home indicator', () => {
        expect(OVERLAY_CSS).toContain('[data-cm-sheet] [data-cm-sheet-foot] { position: sticky; bottom: 0; z-index: 20; background-color: #fff; padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px)); }');
    });
});

// ── a receipt photo: the latest pick wins ────────────────────────────────────────────────────────────
describe('«Comprobante»: a photo picked while another is shrinking supersedes it', () => {
    it('pickSequence: only the latest token applies', () => {
        const s = pickSequence();
        const first = s.next();
        const second = s.next();
        expect(s.isLatest(first)).toBe(false);
        expect(s.isLatest(second)).toBe(true);
    });
    it('the admin picker: the input is disabled while busy and a superseded result neither applies nor ends «Preparando foto…»', () => {
        const src = read('admin/ProofViewer.tsx');
        expect(src).toContain('const picks = useRef(pickSequence()).current;');
        expect(src).toMatch(/const mine = picks\.next\(\);[\s\S]*finally \{ if \(picks\.isLatest\(mine\)\) setBusy\(false\); \}\s*if \(!picks\.isLatest\(mine\)\) return;/);
        expect(src).toMatch(/<input ref=\{inputRef\} type="file"[^>]*disabled=\{busy\}/);
    });
});

// ── Dashboard / Reportes: one model ─────────────────────────────────────────────────────────────────
describe('Dashboard and «Reportes» read like «Pagos de cuotas»', () => {
    it('reportView: «Saldo pendiente» = Cuotas − Validado, never negative; the bar over active people', () => {
        expect(reportView({ total: 5, people: 3, due: 300, paid: 30, paid_count: 1 })).toEqual({ pending: 270, active: 3, paidPct: 33 });
        expect(reportView({ total: 4, due: 100, paid: 150, paid_count: 2 })).toEqual({ pending: 0, active: 4, paidPct: 50 });
    });
    it('the Dashboard: «Con saldo» (what no payment covers yet) and «Pagados» without cancelled inscriptions', () => {
        expect(PAGE).toContain("<StatCard icon=\"fa-circle-xmark\" label={tx('fees.balances.owing', 'Con saldo')} value={stats.unpaid} color=\"red\" />");
        expect(PAGE).toContain("const paid = inscriptions ? inscriptions.filter(i => { const b = personBalance(i); return !b.cancelled && b.state === 'paid'; }).length : na;");
        expect(PAGE).toContain('{Number(totals.cancelled_count) > 0 && <span className="text-gray-600" data-report-count="cancelled">');
    });
});
