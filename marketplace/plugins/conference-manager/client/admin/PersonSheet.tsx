// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Ficha del participante» (2.18.0) — opened by a row's ⋮, a tap on a phone row, the desktop name or the
 * Pago pill (scrolled to «Pago»). A bottom sheet on a phone, a centred card from 640 px (layer 1: what it
 * opens sits above it). It shows EVERYTHING about the person and holds every action the old row had:
 *
 *   1. header — the name, «Cancelada», the location, the family group;
 *   2. Pago — Pagado / Abono / Sin pagar, «$paid de $due», «Saldo», money por validar / devuelto, the
 *      person's payments (each opens the payment, «compartido con N» when shared), «Registrar pago» for
 *      this person (and «… de su grupo familiar (n)»), «Ver sus pagos» in «Pagos de cuotas»;
 *   3. Hospedaje — hotel · room or «Sin habitación», «Asignar / Cambiar habitación»;
 *   4. Código — the registration code and its QR (inscriptions:view only);
 *   5. Datos del formulario — every field in form order, untruncated, an empty one as «—» (D11);
 *   6. Inscripción — registration date, status, internal notes;
 *   7. Editar · Cancelar inscripción / Reactivar (D8) · Eliminar.
 *
 * Every action is offered only with its permission; the parent passes the handlers. The person is read BY ID
 * from the live roster by the parent, so the sheet shows fresh data after each action.
 *
 * `notice` ({ text, type: 'error' | 'success' }): what «Cancelar inscripción / Reactivar» and «Eliminar» did,
 * said INSIDE the sheet just above its actions — an error as role="alert", kept until the next action or the
 * sheet closes. A 409 of «Eliminar» is a multi-step instruction («quítala del reparto del pago #12…, o cancela la
 * inscripción»): in a 3-second toast it covered the very row of buttons it pointed to on a phone and was never
 * announced (2.18.0 review PUX-2). Each new notice is brought into sight (lib/overlay.ts revealInOverlay), clear of
 * the pinned buttons: on a phone the sheet opens at its top and the notice renders at the end of its body, so a
 * refused «Eliminar» showed nothing at all until the admin scrolled to the end (2.18.0 review UX6-1).
 *
 * The person's payments: a role with Pagos › ver sees each one whole (its share of a shared payment, its
 * reference) and opens it; Inscripciones alone sees each part's amount, date, method and status only — payment
 * data belongs to Pagos (D-P20; the server sends no more, 2.18.0 review R6-L1).
 *
 * `brief` («Pagos de cuotas» without Inscripciones › ver, D-P20): the person comes from GET /fee-payments —
 * who they are and their money, nothing else — so only the header, «Pago» and the code are drawn; never a
 * room, form answers or notes shown empty as if the person had none.
 */
import React, { useEffect, useRef, useState } from "react";
import { conferenceApi } from "../lib/conference";
import { LAYER, revealInOverlay } from "../lib/overlay";
import { toCents } from "../lib/feeSplit";
import { fmtDay, fmtStamp, personBalance } from "../lib/feePayments";
import { personFacts, rawFieldValue, rosterLocationKey } from "../lib/roster";
import { Overlay, useShortTouch } from "./Overlay";
import { InfoRow, SoftWrap } from "./RosterBits";
import { BalanceChips, PayPill, StatusPill, factsOf, money } from "./FeeBits";
import { useTx } from "./MealScanner";

const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const sectionCls = 'px-5 sm:px-8 py-5 border-t border-gray-100 space-y-3';
const titleCls = 'text-[11px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2';

const STATUS_TEXT: Record<string, [string, string]> = {
    pending: ['roster.status.pending', 'Pendiente'],
    active: ['roster.status.active', 'Activa'],
    cancelled: ['roster.status.cancelled', 'Cancelada'],
};

/**
 * The person's payments («Pago» section): newest first, each opening its payment. Each line is a row of facts
 * with their own leading «·» (FeeBits factsOf): «$200,00 · de $550,00 · compartido con 2» / «11/10/2026 ·
 * Transferencia · TRF-1001» broke as «… de $550,00 ·» / «compartido con 2» on a phone (2.18.0 review UX6-3).
 * `full` (Pagos › ver): the payment's size and the reference too; without it, only the person's own part.
 */
export function PersonPayments({ parts, onOpen, tx, full = true }: any) {
    if (!parts) return <div className="h-12 rounded-xl bg-gray-100 animate-pulse" aria-label={tx('loading', 'Cargando...')}></div>;
    if (!parts.length) return <p className="text-sm font-bold text-gray-500" data-person-payments="none">{tx('fees.person.none', 'Aún no tiene pagos registrados.')}</p>;
    return (
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100" data-person-payments="">
            {parts.map((p) => {
                const shared = full && p.transfer && p.transfer.people > 1;
                const body = (
                    <>
                        <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap gap-x-1 text-sm font-black text-gray-900" data-pay-facts="amount">
                                {factsOf([money(toCents(p.amount)),
                                    shared ? <span className="font-bold text-gray-500">{tx('fees.person.of.total', 'de {total}', { total: money(toCents(p.transfer.amount)) })}</span> : null,
                                    shared ? <span className="font-bold text-gray-500">{tx('fees.person.shared.with', 'compartido con {n}', { n: p.transfer.people - 1 })}</span> : null])}
                            </span>
                            <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-500" data-pay-facts="when">{factsOf([fmtDay(p.date), p.method || null], full && p.reference ? p.reference : null)}</span>
                        </span>
                        {p.status && <StatusPill status={p.status} />}
                    </>
                );
                return (
                    <li key={p.id} data-person-part={p.id}>
                        {onOpen && p.transfer_id
                            ? <button type="button" onClick={() => onOpen(p.transfer_id)} className="w-full min-h-[52px] px-4 py-2 text-left flex items-center gap-3 hover:bg-blue-50/50">{body}<i className="fa-solid fa-chevron-right text-gray-300" aria-hidden="true"></i></button>
                            : <div className="px-4 py-2 flex items-center gap-3 min-h-[52px]">{body}</div>}
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * Props: `person` (the live row), `fields`, `locations`, `nameOf(row)`, permissions (`canManage`,
 * `canSeeCodes`, `canPayView`, `canPayManage`, `canAssign`), `focusPay`, `paymentsKey` (bump to reload the
 * payments), `familyIds` (the payable members of the person's family group, the person included), and the
 * handlers `onClose`, `onEdit`, `onAssign`, `onBarcode`, `onBadge` (2.19.0), `onToggleCancel`, `onDelete`, `onRegister(ids)`,
 * `onOpenTransfer(id)`, `onSeePayments` (each optional: no handler, no button).
 */
export function PersonSheet({
    person: p, brief = false, fields, locations, nameOf, canManage, canSeeCodes, canPayView, canPayManage, canAssign, focusPay = false, paymentsKey = 0, familyIds = [],
    onClose, onEdit, onAssign, onBarcode, onBadge, onToggleCancel, onDelete, onRegister, onOpenTransfer, onSeePayments, busy = '', notice = null,
}: any) {
    const tx = useTx();
    const payRef = useRef<HTMLElement | null>(null);
    const noticeRef = useRef<HTMLDivElement | null>(null);
    // A phone held sideways: the chips under the name scroll with the body (Overlay useShortTouch, UX6-8).
    const shortTouch = useShortTouch();
    const [parts, setParts] = useState<any[] | null>(null);
    const [partsErr, setPartsErr] = useState('');
    const canSeeParts = canPayView || canSeeCodes;
    useEffect(() => {
        if (!p || !canSeeParts) return undefined;
        let alive = true;
        setPartsErr('');
        conferenceApi.getPayments(p.id)
            .then((list) => { if (alive) setParts(Array.isArray(list) ? list : []); })
            .catch((e) => { if (alive) { setParts([]); setPartsErr(e?.message || 'Error'); } });
        return () => { alive = false; };
    }, [p && p.id, paymentsKey, canSeeParts]);
    useEffect(() => {
        if (focusPay && payRef.current && typeof payRef.current.scrollIntoView === 'function') {
            try { payRef.current.scrollIntoView({ block: 'start' }); } catch { /* old browser */ }
        }
    }, [focusPay]);
    // A new notice comes into sight above the pinned buttons (2.18.0 review UX6-1) — now, and once more after the
    // next frame (the buttons' busy state may change the footer's height in between).
    const noticeKey = notice && notice.text ? `${notice.type}:${notice.text}` : '';
    useEffect(() => {
        if (!noticeKey || typeof window === 'undefined') return undefined;
        const reveal = () => revealInOverlay(noticeRef.current as any, window as any);
        reveal();
        let raf = 0;
        try { raf = requestAnimationFrame(reveal); } catch { /* no frames */ }
        return () => { try { cancelAnimationFrame(raf); } catch { /* ignore */ } };
    }, [noticeKey]);
    if (!p) return null;

    const name = nameOf(p);
    const b = personBalance(p);
    const cancelled = p.status === 'cancelled';
    const locKey = rosterLocationKey(p, locations);
    const loc = locKey === 'none' ? null : (locations || []).find((l) => String(l.id) === locKey) || null;
    const family = String(rawFieldValue(p, 'family_group') || '');
    const facts = personFacts(p, fields);
    const titleId = `cm-person-title-${p.id}`;
    const st = STATUS_TEXT[p.status] || [`roster.status.${p.status}`, String(p.status || '—')];
    const balanceC = Math.max(0, b.due - b.validated);
    const chips = (
        <div className="flex flex-wrap gap-1.5" data-cm-head-extra="" data-person-chips="">
            {cancelled && <span className="px-2.5 py-1 rounded-full bg-gray-200 text-gray-800 text-[10px] font-black uppercase tracking-widest" data-chip="cancelled"><i className="fa-solid fa-ban mr-1" aria-hidden="true"></i>{tx('roster.cancelled', 'Cancelada')}</span>}
            <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-800 text-[10px] font-black"><i className="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>{loc ? loc.name : (p.location || tx('no.location', 'Sin localidad'))}</span>
            {family && <span className="px-2.5 py-1 rounded-full bg-violet-50 text-violet-800 text-[10px] font-black"><i className="fa-solid fa-people-roof mr-1" aria-hidden="true"></i>{family}</span>}
        </div>
    );

    return (
        <Overlay layer={LAYER.sheet} onBackdrop={onClose} onEscape={onClose} returnFocus={`[data-cm-more="${p.id}"], [data-cm-roster-row="${p.id}"]`}>
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-person-sheet={p.id}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                {/* 1. Header */}
                <div className="bg-gray-50/50 px-5 sm:px-8 py-5 border-b border-gray-100 flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                        <h2 id={titleId} className={`font-black text-xl sm:text-2xl text-gray-900 italic tracking-tighter break-words ${cancelled ? 'line-through decoration-2' : ''}`}>{name}</h2>
                        {!shortTouch && chips}
                    </div>
                    <button type="button" onClick={onClose} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>

                {/* 2. Payment */}
                <section ref={payRef} className={sectionCls} data-person-section="pay" style={{ borderTop: 'none' }}>
                    {shortTouch && chips}
                    <h3 className={titleCls}><i className="fa-solid fa-wallet" aria-hidden="true"></i>{tx('payment', 'Pago')}</h3>
                    <div className="flex flex-wrap items-center gap-2">
                        <PayPill state={b.state} />
                        <span className="text-sm font-black text-gray-900 tabular-nums">{tx('fees.person.paid.of', '{paid} de {due}', { paid: money(b.validated), due: money(b.due) })}</span>
                        {/* Its own item, no leading «·»: on a narrow phone it wraps to a line of its own («· Saldo» read odd). */}
                        {!cancelled && <span className="text-sm font-bold text-gray-600 whitespace-nowrap" data-person-saldo="">{tx('fees.person.balance', 'Saldo {amount}', { amount: money(balanceC) })}</span>}
                        <BalanceChips balance={b} />
                    </div>
                    {canSeeParts && <PersonPayments parts={parts} onOpen={canPayView ? onOpenTransfer : null} tx={tx} full={!!canPayView} />}
                    {partsErr && <p role="alert" className="text-xs font-bold text-rose-700">{partsErr}</p>}
                    <div className="flex flex-wrap gap-2">
                        {canPayManage && onRegister && b.payable && (
                            <button type="button" className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => onRegister([p.id])} data-act="register">
                                <i className="fa-solid fa-plus" aria-hidden="true"></i>{tx('fees.register', 'Registrar pago')}
                            </button>
                        )}
                        {canPayManage && onRegister && familyIds.length > 1 && (
                            <button type="button" className={ghost} onClick={() => onRegister(familyIds)} data-act="register-family">
                                <i className="fa-solid fa-people-roof" aria-hidden="true"></i>{tx('fees.person.family', 'Pago de su grupo familiar ({n})', { n: familyIds.length })}
                            </button>
                        )}
                        {canPayView && onSeePayments && (
                            <button type="button" className={ghost} onClick={() => onSeePayments(p)} data-act="see-payments">
                                <i className="fa-solid fa-file-invoice-dollar" aria-hidden="true"></i>{tx('fees.person.see', 'Ver sus pagos')}
                            </button>
                        )}
                    </div>
                    {cancelled && <p className="text-xs font-bold text-gray-600">{tx('fees.person.cancelled', 'Inscripción cancelada: no debe nada y no puede recibir pagos.')}</p>}
                </section>

                {/* 3. Lodging */}
                {!brief && <section className={sectionCls} data-person-section="lodging">
                    <h3 className={titleCls}><i className="fa-solid fa-bed" aria-hidden="true"></i>{tx('lodging', 'Alojamiento')}</h3>
                    <p className="text-sm font-bold text-gray-900">
                        {p.room_id ? tx('roster.room.full', '{hotel} · Habitación {room}', { hotel: p.hotel_name || '—', room: p.room_number || '—' }) : <span className="text-gray-600">{tx('roster.room.none', 'Sin habitación')}</span>}
                    </p>
                    {/* A submitted / validated arrangement is no lock (2.17.0): the room dialog this opens says the
                        change is recorded as an administration adjustment (lodging.adjust.notice). */}
                    {canAssign && onAssign && !cancelled && (
                        <button type="button" className={ghost} onClick={() => onAssign(p)} data-act="assign"><i className="fa-solid fa-bed" aria-hidden="true"></i>{p.room_id ? tx('roster.room.change', 'Cambiar habitación') : tx('assign.room', 'Asignar habitación')}</button>)}
                </section>}

                {/* 4. Code */}
                {canSeeCodes && p.reg_code && (
                    <section className={sectionCls} data-person-section="code">
                        <h3 className={titleCls}><i className="fa-solid fa-qrcode" aria-hidden="true"></i>{tx('reg.code', 'Código')}</h3>
                        <div className="flex flex-wrap items-center gap-3">
                            <span className="font-mono text-lg font-black tracking-[0.2em] text-gray-900">{p.reg_code}</span>
                            {onBarcode && <button type="button" className={ghost} onClick={() => onBarcode(p)} data-act="barcode"><i className="fa-solid fa-qrcode" aria-hidden="true"></i>{tx('roster.barcode', 'Ver código QR')}</button>}
                            {onBadge && <button type="button" className={ghost} onClick={() => onBadge(p)} data-act="badge"><i className="fa-solid fa-id-badge" aria-hidden="true"></i>{tx('badges.person.title', 'Escarapela')}</button>}
                        </div>
                    </section>
                )}

                {/* 5. Form data */}
                {!brief && <section className={sectionCls} data-person-section="fields">
                    <h3 className={titleCls}><i className="fa-solid fa-list-check" aria-hidden="true"></i>{tx('roster.fields', 'Datos del formulario')}</h3>
                    {facts.length === 0 ? <p className="text-sm font-bold text-gray-500">{tx('roster.fields.none', 'El formulario no tiene campos.')}</p> : (
                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                            {facts.map((f) => (
                                <InfoRow key={f.name} label={f.label}>
                                    {!f.value ? <span className="text-gray-400" data-empty="">—</span>
                                        : f.href ? <a href={f.href} className="text-blue-700 underline break-words" data-mail=""><SoftWrap text={f.value} /></a> : f.value}
                                </InfoRow>
                            ))}
                        </dl>
                    )}
                </section>}

                {/* 6. Inscription */}
                {!brief && <section className={sectionCls} data-person-section="inscription">
                    <h3 className={titleCls}><i className="fa-solid fa-id-card" aria-hidden="true"></i>{tx('roster.inscription', 'Inscripción')}</h3>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                        <InfoRow label={tx('roster.registered', 'Fecha de registro')}>{p.registration_date ? fmtStamp(p.registration_date, true) : <span className="text-gray-400">—</span>}</InfoRow>
                        <InfoRow label={tx('roster.status', 'Estado')}>{tx(st[0], st[1])}</InfoRow>
                        <InfoRow className="sm:col-span-2" label={tx('roster.notes', 'Notas internas')}>{p.notes ? <span className="whitespace-pre-wrap">{p.notes}</span> : <span className="text-gray-400">—</span>}</InfoRow>
                    </dl>
                </section>}

                {/* What the last action of the sheet did — right above its buttons (an error stays until the next one). */}
                {notice && notice.text && (
                    <div ref={noticeRef} className="px-5 sm:px-8 pt-4 border-t border-gray-100" data-person-notice={notice.type}>
                        <p role={notice.type === 'error' ? 'alert' : 'status'}
                            className={`rounded-xl px-3 py-2 text-sm font-bold break-words ${notice.type === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
                            <i className={`fa-solid ${notice.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'} mr-1.5`} aria-hidden="true"></i>{notice.text}
                        </p>
                    </div>
                )}

                {/* 7. Actions */}
                {canManage && (onEdit || onToggleCancel || onDelete) && (
                    <div className="px-5 sm:px-8 py-4 border-t border-gray-100 bg-white flex flex-wrap items-center gap-2" data-cm-sheet-foot="" data-person-actions="">
                        {onEdit && <button type="button" className={`${btn} bg-blue-600 text-white hover:bg-blue-700`} onClick={() => onEdit(p)} disabled={!!busy} data-act="edit"><i className="fa-solid fa-pen" aria-hidden="true"></i>{tx('edit', 'Editar')}</button>}
                        {onToggleCancel && (cancelled
                            ? <button type="button" className={ghost} onClick={() => onToggleCancel(p)} disabled={!!busy} data-act="reactivate"><i className="fa-solid fa-rotate-left" aria-hidden="true"></i>{tx('roster.reactivate', 'Reactivar')}</button>
                            : <button type="button" className={`${btn} bg-white border-2 border-amber-200 text-amber-900 hover:border-amber-400`} onClick={() => onToggleCancel(p)} disabled={!!busy} data-act="cancel"><i className="fa-solid fa-ban" aria-hidden="true"></i>{tx('roster.cancel', 'Cancelar inscripción')}</button>)}
                        {onDelete && <button type="button" className={`${btn} ml-auto bg-white border-2 border-rose-200 text-rose-700 hover:border-rose-400`} onClick={() => onDelete(p)} disabled={!!busy} data-act="delete"><i className="fa-solid fa-trash" aria-hidden="true"></i>{tx('delete', 'Eliminar')}</button>}
                    </div>
                )}
            </div>
        </Overlay>
    );
}

export default PersonSheet;
