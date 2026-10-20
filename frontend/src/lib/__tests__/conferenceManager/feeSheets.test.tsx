/**
 * conference-manager 2.18.0 — the sheets of «Pagos de cuotas» and the inscription tables, server-rendered
 * (node, no DOM; effects do not run, so nothing is fetched):
 *   - TransferPanel: the permission × status matrix of its actions, «Anular validación» on a validated
 *     payment, «Validar» refused when a part goes past what is owed (D-P9), the sum line, the reviewer, the
 *     history, the mixed-location chips;
 *   - RegisterPaymentSheet: disabled until valid and saying why (receipt for a transfer, over the cap),
 *     «Iguales» leftover cents, the mixed-location notice, «Dejar por validar» only when recording;
 *   - PersonSheet: every action only with its permission and handler, every field (empty as «—»),
 *     «Cancelada» + «Reactivar», dialog semantics;
 *   - RosterGroup / Pager / MoreButton: compact phone rows with the money state and a visible ⋮, the slim
 *     desktop table, 44 px targets, the pager's ends.
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
import { TransferPanel, TransferSheet, actorLabel, afterText } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { PersonPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonPicker';
import { KpiTile, SEGMENTED_CSS, SegmentedControl, money } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import { FEES_CSS } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';
import { fmtFeeMoney, formatMoneyIn } from '../../../../../marketplace/plugins/conference-manager/client/lib/conference';
import { RegisterPaymentSheet, buildPersonOptions, initialDraft } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { PersonSheet } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { RosterGroup } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterGroup';
import { Pager, MoreButton } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterBits';
import { groupByLocation } from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';

const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(<I18nProvider><ToastProvider>{node}</ToastProvider></I18nProvider>));
const acts = (html: string) => [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]).sort();

const DETAIL = (extra: any = {}) => ({
    id: 12, conference_id: 1, location_id: 1, location: 'Norte', locations: [1, 2], mixed: true, amount: 300, allocated: 300, method: 'Transferencia', reference: '98765',
    paid_on: '2026-10-05', note: 'Familia Pérez', status: 'pending', review_note: null, alloc_gen: 2, recorded_via: 'portal', recorded_by: 'portal:1',
    created_at: '2026-10-05 14:20:00', submitted_at: '2026-10-05 14:20:00', updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
    has_proof: false, legacy: false, people: 2, flags: { cancelled_people: [], duplicate_reference: false },
    allocations: [
        { id: 1, inscription_id: 1, amount: 200, location_id: 1, cancelled: false, name: 'Ana Pérez', location: 'Norte', due: 500, after: { paid: 200, owed: 300, credit: 0 } },
        { id: 2, inscription_id: 2, amount: 100, location_id: 2, cancelled: true, name: 'Luis Pérez', location: 'Centro', due: 0, after: { paid: 100, owed: 0, credit: 0 } },
    ],
    events: [{ id: 1, at: '2026-10-05 14:20:00', actor: 'portal:1', action: 'created', note: null }, { id: 2, at: '2026-10-06 09:00:00', actor: 'admin', action: 'returned', note: 'Falta Pedro' }],
    ...extra,
});
const panel = (t: any, props: any = {}) => render(<TransferPanel id={t.id} initial={t} canManage onEdit={() => {}} onDuplicate={() => {}} {...props} />);

describe('TransferPanel: the actions follow the state machine and the permission', () => {
    it('pending: Validar, Devolver…, Rechazar…, Editar reparto, Eliminar', () => {
        expect(acts(panel(DETAIL()))).toEqual(['edit', 'reject', 'remove', 'return', 'validate']);
    });
    it('returned: Editar, Validar, Rechazar…, Eliminar (no second «Devolver»)', () => {
        expect(acts(panel(DETAIL({ status: 'returned', review_note: 'Falta Pedro' })))).toEqual(['edit', 'reject', 'remove', 'validate']);
    });
    it('validated: only «Anular validación…» — never edited, deleted or duplicated while it counts (D-P10)', () => {
        const html = panel(DETAIL({ status: 'validated' }));
        expect(acts(html)).toEqual(['void']);
        expect(html).toContain('Anular validación…');
    });
    it('rejected: Validar, Eliminar, Duplicar', () => {
        expect(acts(panel(DETAIL({ status: 'rejected', review_note: 'No llegó' })))).toEqual(['duplicate', 'remove', 'validate']);
    });
    it('without payments:manage nothing can be done; without the sheet handlers no Editar / Duplicar', () => {
        expect(acts(panel(DETAIL(), { canManage: false }))).toEqual([]);
        expect(acts(panel(DETAIL({ status: 'validated' }), { onEdit: undefined, onDuplicate: undefined }))).toEqual(['void']);
    });
    it('«Validar» is refused while a part would go past what the person owes (D-P9 «Nunca»)', () => {
        const over = DETAIL({ allocations: [{ ...DETAIL().allocations[0], after: { paid: 520, owed: 0, credit: 20 } }] });
        const html = panel(over);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-act="validate"/);
        expect(html).toContain('data-flag="over"');
        expect(html).toContain('data-after="over"');
        const active = DETAIL({ allocations: DETAIL().allocations.map((a: any) => ({ ...a, cancelled: false, due: 500 })) });
        expect(panel(active)).not.toMatch(/<button[^>]*disabled=""[^>]*data-act="validate"/);
    });
    it('«Validar» is refused while the payment holds a person cancelled since (they owe nothing): the flag says what to do', () => {
        const html = panel(DETAIL());   // Luis (2) is cancelled
        // Round 7: why, in words in the bar (no hover-only title), and the button described by it.
        expect(html).toMatch(/data-transfer-actions="">[\s\S]*?<p id="fee-blocked-12"[^>]*data-validate-blocked="">[\s\S]*?Persona cancelada: ya no debe nada\./);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-act="validate" aria-describedby="fee-blocked-12"/);
        expect(html).not.toMatch(/data-act="validate"[^>]*title=/);
        expect(html).toMatch(/data-flag="cancelled"[^>]*>[\s\S]*?Corrige el reparto, reactívala o rechaza el pago\./);
        expect(html).not.toContain('data-flag="over"');
        // A validated payment that holds one (cancelled after validation): only the plain flag.
        expect(panel(DETAIL({ status: 'validated' }))).toMatch(/data-flag="cancelled"[^>]*>[\s\S]*?Persona cancelada<\/span>/);
    });
    it('the queue says «Validar y siguiente»', () => {
        expect(panel(DETAIL(), { queue: true })).toContain('Validar y siguiente');
    });
    it('header, split, sum line, notes, history; cancelled and mixed-location people marked', () => {
        const html = panel(DETAIL({ reviewed_at: '2026-10-06 09:00:00', reviewed_by: 'admin' }));
        expect(html).toContain('Pago #12');
        expect(html).toContain('data-fee-status="pending"');
        expect(html).toContain('Varias localidades');
        // Round 6: a payment back in «Por validar» (resent after a return) awaits a NEW review — no «Revisado por».
        expect(html).not.toContain('data-reviewed=""');
        expect(panel(DETAIL({ status: 'validated', reviewed_at: '2026-10-06 09:00:00', reviewed_by: 'admin' }))).toContain('data-reviewed=""');
        expect(html).toMatch(/data-part="1"[\s\S]*Ana Pérez[\s\S]*Norte/);
        expect(html).toMatch(/data-part="2"[\s\S]*Cancelada/);
        expect(html).toContain('data-flag="cancelled"');
        expect(html).toMatch(/data-sum-line=""[\s\S]*?Asignado \$[^<]+ de \$[^<]+<\/span><span><i class="fa-solid fa-check mr-1" aria-hidden="true"><\/i>Cuadra/);
        expect(html).toContain('Familia Pérez');
        expect(html).toMatch(/data-history=""[\s\S]*Devuelto[\s\S]*«Falta Pedro»/);
    });
    it('the after-state of a part', () => {
        const tx = (_k: string, f: string, v?: any) => (v ? f.replace('{amount}', v.amount) : f);
        expect(afterText(tx, { after: { paid: 5, owed: 0, credit: 0 } }, 'pending')).toMatchObject({ tone: 'ok', text: 'Queda pagado al validarse' });
        expect(afterText(tx, { after: { paid: 5, owed: 0, credit: 0 } }, 'validated')).toMatchObject({ tone: 'ok', text: 'Queda pagado' });
        expect(afterText(tx, { after: { paid: 5, owed: 3, credit: 0 } }, 'pending').tone).toBe('owed');
        expect(afterText(tx, { after: { paid: 5, owed: 0, credit: 1 } }, 'pending').tone).toBe('over');
    });
    it('the sheet is a labelled dialog above the person sheet', () => {
        const html = render(<TransferSheet id={12} initial={DETAIL()} canManage onClose={() => {}} />);
        expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="fee-transfer-title-12"/);
        expect(html).toContain('id="fee-transfer-title-12"');
        expect(html).toContain('z-index:6020');
    });
});

const ROWS = [
    { id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 500, amount_paid: 100, pending_amount: 0, payment_status: 'partial', family_group: 'Pérez', room_id: 4, room_number: '12', hotel_name: 'Sol', reg_code: 'AB12CD' },
    { id: 2, first_name: 'Luis', last_name: 'Pérez', location_id: 2, status: 'active', total_due: 300, amount_paid: 0, pending_amount: 100, payment_status: 'unpaid', family_group: 'Pérez' },
    { id: 3, first_name: 'Eva', last_name: 'Ruiz', location_id: 1, status: 'cancelled', total_due: 300, amount_paid: 0, payment_status: 'unpaid' },
];
const LOCS = [{ id: 1, name: 'Norte' }, { id: 2, name: 'Centro' }];
const nameOf = (p: any) => `${p.first_name} ${p.last_name}`;
const OPTIONS = buildPersonOptions(ROWS, nameOf, LOCS);

describe('RegisterPaymentSheet', () => {
    const sheet = (props: any) => render(<RegisterPaymentSheet conferenceId={1} options={OPTIONS} locations={LOCS} onClose={() => {}} {...props} />);
    it('the people\'s options: what each still has to cover, cancelled people marked', () => {
        expect(OPTIONS.map((o) => [o.id, o.toCoverC, o.cancelled, o.locationName, o.family])).toEqual([[1, 40000, false, 'Norte', 'Pérez'], [2, 20000, false, 'Centro', 'Pérez'], [3, 0, true, 'Norte', '']]);
    });
    it('prefilled with what the chosen people still owe; a cancelled person is never preselected', () => {
        const d = initialDraft({ mode: 'create', ids: [1, 2, 3], options: OPTIONS, methods: ['Efectivo', 'Transferencia'] });
        expect(d.people).toEqual([1, 2]);
        expect(d.amount).toBe('600,00');
        expect(d.mode).toBe('equal');
        expect(d.leavePending).toBe(false);
    });
    it('a transfer without a receipt: the button is disabled and the sheet says why', () => {
        const html = sheet({ ids: [1], methods: ['Transferencia'] });
        expect(html).toMatch(/<button type="submit" disabled=""[^>]*data-register-submit=""/);
        expect(html).toContain('data-register-issue="proof_required"');
        expect(html).toContain('Tomar foto o elegir archivo');
    });
    it('cash needs no receipt (D-P12): ready to record, born validated unless «Dejar por validar»', () => {
        const html = sheet({ ids: [1], methods: ['Efectivo'] });
        expect(html).not.toMatch(/<button type="submit" disabled=""/);
        expect(html).toContain('Opcional en efectivo.');
        expect(html).toContain('data-leave-pending=""');
        expect(html).not.toContain('data-register-issue');
    });
    it('«Iguales» over people who owe different amounts goes past one of them: refused inline (D-P9)', () => {
        const html = sheet({ ids: [1, 2], methods: ['Efectivo'] });   // 600 split 300 / 300, Luis may receive 200
        expect(html).toMatch(/<button type="submit" disabled=""/);
        expect(html).toContain('data-register-issue="over_cap"');
        expect(html).toMatch(/data-split-row="2"[\s\S]*?Supera lo que falta: máximo \$200,00/);
        expect(html).toContain('Cambia a «Manual» para repartir según lo que debe cada uno.');
        // two locations: each coordinator sees only their part
        expect(html).toContain('data-mixed-notice=""');
    });
    it('the split line shows the leftover cent rule and the exact sum', () => {
        const opts = buildPersonOptions([
            { id: 1, location_id: 1, total_due: 100, amount_paid: 0 }, { id: 2, location_id: 1, total_due: 100, amount_paid: 0 }, { id: 3, location_id: 1, total_due: 100, amount_paid: 0 },
        ], (p: any) => `P${p.id}`, LOCS);
        const html = render(<RegisterPaymentSheet conferenceId={1} options={opts} locations={LOCS} ids={[1, 2, 3]} methods={['Efectivo']} transfer={null} onClose={() => {}} />);
        expect(html).toMatch(/id="fee-part-1"[^>]*value="100,00"/);
        const d = initialDraft({ mode: 'create', ids: [1, 2, 3], options: opts, methods: ['Efectivo'] });
        expect(d.amount).toBe('300,00');
        expect(html).toContain('data-split-state="ok"');
    });
    it('editing a payment: its people and amounts, no «Dejar por validar», the result is pending again', () => {
        const tr = DETAIL({ status: 'returned', method: 'Efectivo', allocations: [{ ...DETAIL().allocations[0], validated_other: 0, pending_other: 0, due: 500 }] , amount: 200 });
        const html = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={OPTIONS} locations={LOCS} transfer={tr} methods={['Efectivo', 'Transferencia']} onClose={() => {}} />);
        expect(html).toContain('Corregir pago #12');
        expect(html).not.toContain('data-leave-pending=""');
        expect(html).toContain('Al guardar, el pago vuelve a quedar por validar.');
        expect(html).toMatch(/data-chosen="1"/);
    });
    it('«Duplicar» re-uses the receipt of the voided payment', () => {
        const d = initialDraft({ mode: 'duplicate', transfer: DETAIL({ status: 'rejected', has_proof: true }), options: OPTIONS, methods: ['Efectivo', 'Transferencia'] });
        expect(d.copyProofFrom).toBe(12);
        expect(d.people).toEqual([1, 2]);
        expect(d.mode).toBe('manual');
        expect(d.manual).toEqual({ 1: '200,00', 2: '100,00' });
        // The same receipt: its date and reference stay (the portal's «Duplicar» does the same).
        expect([d.paidOn, d.reference]).toEqual(['2026-10-05', '98765']);
    });
});

const FIELDS = [
    { id: 1, name: 'first_name', label: 'Nombre', role: 'first_name' },
    { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name' },
    { id: 3, name: 'church', label: 'Iglesia' },
];
const PERSON = { ...ROWS[0], reg_code: 'AB12CD', registration_date: '2026-09-01 10:00:00', notes: '', room_id: 4, room_number: '12', hotel_name: 'Sol', church: '' };
const fullHandlers = { onEdit: () => {}, onAssign: () => {}, onBarcode: () => {}, onToggleCancel: () => {}, onDelete: () => {}, onRegister: () => {}, onOpenTransfer: () => {}, onSeePayments: () => {} };
const personSheet = (props: any) => render(<PersonSheet person={PERSON} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} {...fullHandlers} {...props} />);

describe('PersonSheet: every action only with its permission', () => {
    it('everything for an administrator', () => {
        const html = personSheet({ canManage: true, canSeeCodes: true, canPayView: true, canPayManage: true, canAssign: true, familyIds: [1, 2] });
        expect(acts(html)).toEqual(['assign', 'barcode', 'cancel', 'delete', 'edit', 'register', 'register-family', 'see-payments']);
    });
    it('Pagos › ver only: the money and «Ver sus pagos», no register, no edit, no code', () => {
        const html = personSheet({ canManage: false, canSeeCodes: false, canPayView: true, canPayManage: false, canAssign: false });
        expect(acts(html)).toEqual(['see-payments']);
        expect(html).not.toContain('data-person-section="code"');
        expect(html).toContain('data-person-section="pay"');
    });
    it('Hospedaje › gestionar only: the room button', () => {
        expect(acts(personSheet({ canAssign: true }))).toEqual(['assign']);
    });
    it('a person who owes nothing more cannot be paid (the button is not offered)', () => {
        const html = render(<PersonSheet person={{ ...PERSON, amount_paid: 500, payment_status: 'paid' }} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} canPayManage canPayView {...fullHandlers} />);
        expect(acts(html)).not.toContain('register');
    });
    it('every field in form order, an empty one as «—» (D11); registration date, status, notes', () => {
        const html = personSheet({});
        expect(html).toMatch(/Nombre[\s\S]*Apellido[\s\S]*Iglesia/);
        expect(html).toMatch(/Iglesia<\/dt><dd[^>]*><span class="text-gray-400" data-empty="">—<\/span>/);
        expect(html).toContain('Fecha de registro');
        expect(html).toContain('Activa');
        expect(html).toContain('Notas internas');
    });
    it('a cancelled person: struck through, «Cancelada», «Reactivar», nothing to pay', () => {
        const html = render(<PersonSheet person={{ ...PERSON, status: 'cancelled' }} fields={FIELDS} locations={LOCS} nameOf={nameOf} onClose={() => {}} canManage canPayManage canPayView {...fullHandlers} />);
        expect(html).toContain('line-through');
        expect(html).toContain('data-chip="cancelled"');
        expect(acts(html)).toEqual(expect.arrayContaining(['reactivate', 'delete', 'edit']));
        expect(acts(html)).not.toContain('register');
        expect(acts(html)).not.toContain('cancel');
    });
    it('a labelled dialog at the sheet layer; Escape and focus return wired', () => {
        const html = personSheet({});
        expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="cm-person-title-1"/);
        expect(html).toContain('<h2 id="cm-person-title-1"');
        expect(html).toContain('z-index:6010');
    });
});

describe('RosterGroup, Pager, MoreButton', () => {
    const group = groupByLocation(ROWS, LOCS, 'Sin localidad').find((g) => g.key === '1')!;
    const html = render(<RosterGroup group={group} page={1} size={20} onPage={() => {}} collapsed={false} onToggle={() => {}} columns={[FIELDS[2]]} nameOf={nameOf} canSeeCodes onOpen={() => {}} onBarcode={() => {}} />);
    it('phone rows: one button per person with the name, the money state, the room and a visible ⋮', () => {
        const list = html.slice(html.indexOf('data-cm-roster-list'), html.indexOf('data-cm-roster-table'));
        // The row's name is the person AND their state (never just «Ver ficha de …»).
        expect(list).toMatch(/data-cm-roster-row="1"[^>]*aria-label="Ana Pérez: Abono, \$[^"]*Hab 12/);
        expect(list).toContain('data-pay-pill="partial"');
        expect(list).toContain('Hab 12');
        expect(list).toContain('data-cm-more-glyph=""');
        expect(list).toMatch(/data-cm-roster-row="3"[\s\S]*line-through[\s\S]*Cancelada/);
        expect(html).not.toMatch(/opacity-0|group-hover\/row|hover:none/);
    });
    it('desktop table: Participante · chosen columns · Código · Pago · Hospedaje · ⋮', () => {
        const table = html.slice(html.indexOf('data-cm-roster-table'));
        const heads = [...table.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1]);
        expect(heads).toEqual(['Participante', 'Iglesia', 'Código', 'Pago', 'Alojamiento', '']);
        expect(table).toMatch(/data-cm-more="1"[^>]*aria-label="Más información de Ana Pérez" aria-haspopup="dialog"/);
        expect(table).toContain('data-pay-pill="partial"');
        expect(table).toMatch(/<button[^>]*title="Código de inscripción"[\s\S]*AB12CD/);
    });
    it('the sticky head and the clipped card carry their data attributes', () => {
        expect(html).toContain('data-cm-roster-card=""');
        expect(html).toContain('data-cm-roster-head=""');
    });
    it('Pager: hidden when everything fits; ends disabled; the current page marked', () => {
        expect(render(<Pager page={1} size={20} total={20} onPage={() => {}} />)).not.toContain('data-cm-pager');
        const p = render(<Pager page={1} size={20} total={183} onPage={() => {}} />);
        expect(p).toMatch(/<button[^>]*disabled=""[^>]*data-pager-prev=""/);
        expect(p).not.toMatch(/<button[^>]*disabled=""[^>]*data-pager-next=""/);
        expect(p).toContain('aria-current="page"');
        expect(p).toContain('1–20 de 183');
        expect(p).toContain('aria-live="polite"');
        const last = render(<Pager page={10} size={20} total={183} onPage={() => {}} />);
        expect(last).toMatch(/<button[^>]*disabled=""[^>]*data-pager-next=""/);
    });
    it('MoreButton: the name in its label, 44 px through ROSTER_CSS, dialog popup', () => {
        const b = render(<MoreButton id={7} name="Ana" onClick={() => {}} />);
        expect(b).toMatch(/data-cm-more="7"/);
        expect(b).toContain('aria-label="Más información de Ana"');
        expect(b).toContain('aria-haspopup="dialog"');
        expect(b).toContain('shrink-0');
    });
});

// ── 2.18.0 live-review fixes (server-rendered) ────────────────────────────────────────────────────────

describe('phones: every new control of the payment sheets is a 44 px target', () => {
    it('«Usar lo que falta», the quick reasons of Devolver / Rechazar and the family-group chips', () => {
        // «Usar lo que falta: $X» shows when the total differs from what the people may still receive.
        const tr = DETAIL({ status: 'pending', method: 'Efectivo', amount: 200, allocations: [{ ...DETAIL().allocations[0], amount: 200, validated_other: 0, pending_other: 0, due: 500 }] });
        const reg = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={OPTIONS} locations={LOCS} transfer={tr} methods={['Efectivo']} onClose={() => {}} />);
        expect(reg).toMatch(/<button type="button"[^>]*class="[^"]*min-h-\[44px\][^"]*"[^>]*data-use-owed="">Usar lo que falta/);
        // The note form's quick reasons (SSR cannot open it: pinned on the source) and the picker chips.
        const tsSrc = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet.tsx'), 'utf8');
        const reasons = tsSrc.slice(tsSrc.indexOf('REVIEW_REASONS.map('), tsSrc.indexOf('REVIEW_REASONS.map(') + 400);
        expect(reasons).toContain('min-h-[44px]');
        expect(reasons).not.toContain('min-h-[36px]');
        expect(tsSrc).toMatch(/<div className="flex flex-wrap gap-2" data-reasons="">/);
        const picker = render(<PersonPicker options={[...OPTIONS, { ...OPTIONS[1], id: 9, name: 'Mia Pérez', locationId: 1, locationName: 'Norte' }]} chosen={[]} locations={LOCS} onAdd={() => {}} onDone={() => {}} />);
        const chips = picker.slice(picker.indexOf('data-family-chips'));
        expect(chips).toMatch(/<button type="button" class="min-h-\[44px\] px-3 rounded-full/);
        expect(picker).toMatch(/class="flex flex-wrap gap-2" data-family-chips=""/);
    });
});

describe('«Registrar pago» while correcting', () => {
    const tr = (extra: any = {}) => DETAIL({ method: 'Efectivo', allocations: [{ ...DETAIL().allocations[0], validated_other: 0, pending_other: 0, due: 500 }], amount: 200, ...extra });
    it('a RETURNED payment shows the administration\'s note while it is corrected', () => {
        const html = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={OPTIONS} locations={LOCS} transfer={tr({ status: 'returned', review_note: 'El monto no coincide: fueron $200.' })} methods={['Efectivo']} onClose={() => {}} />);
        expect(html).toMatch(/data-return-note=""[\s\S]*Motivo de la devolución[\s\S]*El monto no coincide: fueron \$200\./);
        const pending = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={OPTIONS} locations={LOCS} transfer={tr({ status: 'pending' })} methods={['Efectivo']} onClose={() => {}} />);
        expect(pending).not.toContain('data-return-note');
    });
    it('a coordinator\'s payment: the picker offers only its location\'s people (D-P3)', () => {
        const opts = [...OPTIONS, { ...OPTIONS[0], id: 7, name: 'Rosa Díaz', locationId: 2, locationName: 'Centro' }, { ...OPTIONS[0], id: 8, name: 'Tito Paz', locationId: 1, locationName: 'Norte' }];
        const locked = render(<PersonPicker options={opts} chosen={[1]} locations={LOCS} onAdd={() => {}} onDone={() => {}} lockLocationId={1} />);
        expect(locked).toContain('data-pick="8"');
        expect(locked).not.toContain('data-pick="7"');
        expect(locked).not.toContain('data-pick="2"');
        expect(locked).toContain('data-picker-locked=""');
        const open = render(<PersonPicker options={opts} chosen={[1]} locations={LOCS} onAdd={() => {}} onDone={() => {}} />);
        expect(open).toContain('data-pick="7"');
        // The sheet locks it for a portal payment only.
        const src = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet.tsx'), 'utf8');
        expect(src).toContain("const lockLocationId = mode === 'edit' && transfer && transfer.recorded_via === 'portal' && transfer.location_id != null ? Number(transfer.location_id) : null;");
        expect(src).toContain('lockLocationId={lockLocationId}');
    });
    it('the method and the split are radio groups, not tabs (they are form values)', () => {
        const html = render(<RegisterPaymentSheet conferenceId={1} options={OPTIONS} locations={LOCS} ids={[1, 2]} methods={['Efectivo', 'Transferencia']} onClose={() => {}} />);
        expect(html).toMatch(/role="radiogroup" aria-label="Forma de pago"/);
        expect(html).toMatch(/role="radiogroup" aria-label="Reparto"/);
        expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-seg="equal"/);
        expect(html).not.toMatch(/role="tab"/);
    });
});

describe('the payment\'s «Historial» names the location, not «portal:1»', () => {
    it('a coordinator event reads «Portal de Norte»; an administrator keeps their login', () => {
        const t = DETAIL({ location_id: 1, location: 'Norte', mixed: false, events: [
            { id: 1, at: '2026-10-05 14:20:00', actor: 'portal:1', action: 'created', note: null },
            { id: 2, at: '2026-10-05 15:00:00', actor: 'portal:2', action: 'resent', note: null },
            { id: 3, at: '2026-10-06 09:00:00', actor: 'boss', action: 'returned', note: 'x' },
        ] });
        const html = panel(t, { locationName: (id: number) => (id === 2 ? 'Centro' : null) });
        const hist = html.slice(html.indexOf('data-history'));
        // One fact, «Portal de Norte» (UX6-3: «Portal · Norte» read as two beside the line's other «·»).
        expect(hist).toContain('Portal de Norte');
        expect(hist).toContain('Portal de Centro');
        expect(hist).toContain('·\u00a0boss');
        expect(hist).not.toContain('portal:1');
        expect(actorLabel((_k: string, f: string, v?: any) => (v ? f.replace('{location}', v.location) : f), 'portal:9', t)).toBe('Portal');
    });
});

describe('the review queue on a desktop keeps its list and its actions in view', () => {
    it('the receipt is capped inline, the list and the payment are sticky columns, the payment card clips', () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage.tsx'), 'utf8');
        expect(FEES_CSS).toMatch(/\[data-fees-master\] > \[data-fees-queue\] \{ position: sticky;[^}]*overflow-y: auto/);
        // Round 6: the bar is the card's last row (not sticky over it); the card is the sticky column, and clips.
        expect(FEES_CSS).toMatch(/\[data-fees-master\] > \[data-fees-detail\] \{ position: sticky;[^}]*overflow: clip/);
        expect(page).toContain('data-fees-queue=""');
        expect(page).toMatch(/<div ref=\{detailRef\} data-fees-detail="" className=\{card\}>/);
        const viewer = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/ProofViewer.tsx'), 'utf8');
        expect(viewer).toContain("large ? 'max-h-[45vh]' : 'max-h-56'");
        expect(viewer).not.toContain('max-h-[60vh]');
    });
});

describe('the section strip: every choice in sight on a phone', () => {
    it('no sideways scroll: the choices share the width and wrap (four become two rows of two)', () => {
        const html = render(<SegmentedControl label="Pagos de cuotas" value="balances" onChange={() => {}} options={[{ key: 'summary', label: 'Resumen' }, { key: 'queue', label: 'Por validar', badge: 3 }, { key: 'transfers', label: 'Pagos' }, { key: 'balances', label: 'Saldos' }]} />);
        expect(html).not.toContain('overflow-x-auto');
        expect(html).not.toContain('shrink-0');
        expect(html).toMatch(/role="tablist"[^>]*data-cm-segmented="" data-seg-count="4"/);
        expect(SEGMENTED_CSS).toMatch(/\[data-cm-segmented\] \{ display: flex; flex-wrap: wrap; \}/);
        expect(SEGMENTED_CSS).toMatch(/\[data-cm-segmented\]\[data-seg-count="4"\] > \[data-seg\] \{ flex-basis: calc\(50% - 0\.25rem\); \}/);
        expect(html).toContain('<style>');
    });
});

describe('fee money reads like the coordinator portal: «$1.550,00»', () => {
    it('four digits grouped in every fee figure (the browser\'s Spanish left them ungrouped)', () => {
        expect(money(155000)).toBe('$1.550,00');
        expect(money(1355000)).toBe('$13.550,00');
        expect(money(-5)).toBe('-$0,05');
        expect(formatMoneyIn(1550, 'es')).toBe('1.550,00');
        expect(fmtFeeMoney(1550)).toBe('1.550,00');
        const html = render(<KpiTile label="Validado" value={money(155000)} icon="fa-check" />);
        expect(html).toContain('$1.550,00');
        // whatever the browser's language (the portal formats es-CO the same way).
        const bits = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits.tsx'), 'utf8');
        expect(bits).toContain('export const money = (c: number) => moneyText(Math.round(Number(c) || 0), fmtFeeMoney);');
    });
});

describe('«1 cancelada», never «1 canceladas»', () => {
    it('the location card of the roster', () => {
        const one = groupByLocation(ROWS, LOCS, 'Sin localidad').find((g) => g.key === '1')!;   // Eva is cancelled
        const html = render(<RosterGroup group={one} page={1} size={20} onPage={() => {}} collapsed={false} onToggle={() => {}} columns={[]} nameOf={nameOf} canSeeCodes onOpen={() => {}} onBarcode={() => {}} />);
        expect(html).toContain('1 cancelada');
        expect(html).not.toContain('1 canceladas');
    });
});
